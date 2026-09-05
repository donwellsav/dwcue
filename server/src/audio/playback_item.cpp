// ============================================================================
// playback_item.cpp — see playback_item.hpp.
// ============================================================================
#include "liveplay/audio/playback_item.hpp"
#include "liveplay/audio/decoder.hpp"
#include "liveplay/logger.hpp"
#include "liveplay/util/unicode_path.hpp"

#include <miniaudio.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <thread>
#include <vector>

namespace liveplay::audio {

namespace {

inline float db_to_lin(float db) noexcept {
    if (db <= -120.0f) return 0.0f;
    return std::pow(10.0f, db * 0.05f);
}

// Deinterleave `src` (frame_count × ch frames) into per-channel buffers `dst`.
// Out-of-range source channels copy from the closest in-range channel; LTC
// virtual channel is handled separately by the caller.
inline void deinterleave_to(const Sample* src,
                            std::size_t   frame_count,
                            ChannelCount  file_ch,
                            Sample* const* dst,
                            ChannelCount  dst_ch) noexcept {
    for (ChannelCount c = 0; c < dst_ch; ++c) {
        Sample* d = dst[c];
        if (c < file_ch) {
            for (std::size_t i = 0; i < frame_count; ++i) {
                d[i] = src[i * file_ch + c];
            }
        } else {
            // The caller may pass extra dst channels (e.g. LTC slot). Silence.
            std::memset(d, 0, frame_count * sizeof(Sample));
        }
    }
}

class RenderActiveGuard {
public:
    explicit RenderActiveGuard(std::atomic_flag& gate) noexcept : gate_(gate) {}
    ~RenderActiveGuard() { gate_.clear(std::memory_order_release); }

    RenderActiveGuard(const RenderActiveGuard&) = delete;
    RenderActiveGuard& operator=(const RenderActiveGuard&) = delete;

private:
    std::atomic_flag& gate_;
};

} // namespace

// ---------------------------------------------------------------------------

PlaybackItem::PlaybackItem(PlaybackItemDesc desc)
    : desc_(std::move(desc)) {
    gain_target_linear_.store(1.0f);
    gain_current_linear_.store(1.0f);
    fade_in_ms_.store(desc_.fade_in_duration.count());
    fade_out_ms_.store(desc_.fade_out_duration.count());
    ltc_enabled_atomic_.store(desc_.ltc_enabled);
    ltc_offset_ns_.store(desc_.ltc_offset.count());
    if (desc_.ltc_enabled) {
        ltc_ = std::make_unique<LTCGenerator>();
        ltc_->configure(desc_.mix_sample_rate, desc_.ltc_frame_rate, desc_.ltc_offset);
    }
}

PlaybackItem::~PlaybackItem() {
    unload();
}

bool PlaybackItem::load() {
    // Never swap the decoder out from under active playback — reset transport,
    // playhead and fade state first (mirrors unload()'s stop_now()).
    stop_now();
    std::lock_guard lock{decoder_mutex_};

    decoder_ready_ = false;
    clear_decode_error();
    if (decoder_) {
        ma_decoder_uninit(decoder_.get());
        decoder_.reset();
    }

    decoder_ = std::make_unique<ma_decoder>();
    ma_decoder_config cfg = decoder_config(
        ma_format_f32,
        /*channels (0 = native)*/ 0,
        desc_.mix_sample_rate);

    // UTF-8 path for logs and JSON; native open uses the platform's preferred
    // encoding (UTF-16 on Windows so non-ASCII filenames work).
    const std::string path_utf8 = util::path_to_utf8(desc_.file_path);

    // Diagnose path-encoding issues up front: if the path doesn't make it to
    // the filesystem layer intact, miniaudio's "Resource does not exist"
    // becomes ambiguous. fs::exists uses native wide-char syscalls on Windows.
    std::error_code ec;
    const bool path_exists = std::filesystem::exists(desc_.file_path, ec);
    if (!path_exists) {
        Logger::error("PlaybackItem[{}] file not found at '{}' (fs::exists=false, ec={})",
                      desc_.id.value, path_utf8, ec.message());
        decoder_.reset();
        return false;
    }

    const ma_result rv = decoder_init_file(desc_.file_path, cfg, *decoder_);
    if (rv != MA_SUCCESS) {
        Logger::error("PlaybackItem[{}] decoder init failed for '{}': {}",
                      desc_.id.value, path_utf8, ma_result_description(rv));
        decoder_.reset();
        return false;
    }

    ma_uint32 ch = 0;
    ma_decoder_get_data_format(decoder_.get(), nullptr, &ch, nullptr, nullptr, 0);
    if (ch == 0) ch = desc_.fallback_channels;
    const ChannelCount new_file_channels = static_cast<ChannelCount>(ch);

    std::vector<ReadAheadBlock> new_read_ahead(kReadAheadBlockCount);
    for (auto& block : new_read_ahead) {
        block.samples.assign(
            static_cast<std::size_t>(desc_.render_block) *
                std::max<ChannelCount>(1u, new_file_channels),
            0.0f);
    }

    begin_render_exclusion();
    try {
        file_channels_.store(new_file_channels, std::memory_order_release);
        const ChannelCount total =
            new_file_channels + (desc_.ltc_enabled ? 1u : 0u);
        resize_meters(total);
        read_ahead_ = std::move(new_read_ahead);
        reset_read_ahead_locked(0);
    } catch (...) {
        end_render_exclusion();
        throw;
    }
    end_render_exclusion();

    decoder_ready_ = true;
    Logger::info("PlaybackItem[{}] loaded '{}' ({} ch, {} Hz mix-rate, LTC={})",
                 desc_.id.value, path_utf8, new_file_channels,
                 desc_.mix_sample_rate, desc_.ltc_enabled ? "on" : "off");
    return true;
}

void PlaybackItem::unload() {
    stop_now();
    std::lock_guard lock{decoder_mutex_};
    begin_render_exclusion();
    if (decoder_) {
        ma_decoder_uninit(decoder_.get());
        decoder_.reset();
    }
    decoder_ready_ = false;
    read_ahead_.clear();
    read_ahead_read_.store(0, std::memory_order_relaxed);
    read_ahead_write_.store(0, std::memory_order_relaxed);
    decode_terminal_.store(false, std::memory_order_relaxed);
    end_render_exclusion();
}

ChannelCount PlaybackItem::source_channel_count() const noexcept {
    return file_channels_.load(std::memory_order_acquire) +
           (ltc_enabled_atomic_.load(std::memory_order_acquire) ? 1u : 0u);
}

PlaybackItemStats PlaybackItem::stats() const noexcept {
    PlaybackItemStats s;
    s.transport       = transport_.load(std::memory_order_relaxed);
    s.playhead_frame  = playhead_frames_.load(std::memory_order_relaxed);
    s.playhead_seconds =
        static_cast<double>(s.playhead_frame) / static_cast<double>(desc_.mix_sample_rate);
    s.source_channels = source_channel_count();
    s.file_loaded     = decoder_ready_;
    s.decode_error    = decode_error_.load(std::memory_order_acquire);
    s.decoder_result  = decode_error_code_.load(std::memory_order_acquire);
    s.read_ahead_underruns =
        read_ahead_underruns_.load(std::memory_order_acquire);
    const auto write = read_ahead_write_.load(std::memory_order_acquire);
    const auto read  = read_ahead_read_.load(std::memory_order_acquire);
    s.at_end = decode_terminal_.load(std::memory_order_acquire) &&
               write == read;
    s.read_ahead_blocks = static_cast<std::uint32_t>(
        write >= read
            ? std::min<std::uint64_t>(write - read, kReadAheadBlockCount)
            : 0);
    return s;
}

MeterSnapshot PlaybackItem::source_meter(ChannelIndex ch) const noexcept {
    std::lock_guard lock{source_meters_mutex_};
    if (ch >= source_meters_.size() || !source_meters_[ch]) return {};
    return source_meters_[ch]->snapshot();
}

MeterSnapshot PlaybackItem::source_meter_consume(ChannelIndex ch) noexcept {
    std::lock_guard lock{source_meters_mutex_};
    if (ch >= source_meters_.size() || !source_meters_[ch]) return {};
    return source_meters_[ch]->snapshot_consume_max();
}

void PlaybackItem::play() {
    if (!decoder_ready_) {
        Logger::warn("PlaybackItem[{}] play() ignored — decoder not ready", desc_.id.value);
        return;
    }
    const TransportState st = transport_.load(std::memory_order_acquire);
    if (st == TransportState::Playing || st == TransportState::FadingIn) return;
    // A paused cue resumes in place — don't restart the fade envelope (which
    // would snap the gain and re-run the fade-in).
    if (st == TransportState::Paused) { resume(); return; }

    // A decoder failure leaves the queue terminal; natural EOF/out-point
    // leaves it exhausted. A direct Play should recover the former from the
    // last audible frame and replay the latter from the beginning.
    if (st == TransportState::Stopped) {
        std::lock_guard lock{decoder_mutex_};
        const bool retry_error =
            decode_error_.load(std::memory_order_acquire);
        if (retry_error ||
            decode_terminal_.load(std::memory_order_acquire) ||
            decode_out_point_passed_) {
            begin_render_exclusion();
            const auto frame = retry_error
                ? playhead_frames_.load(std::memory_order_acquire)
                : std::uint64_t{0};
            const ma_result seek_result = decoder_
                ? ma_decoder_seek_to_pcm_frame(decoder_.get(), frame)
                : MA_INVALID_OPERATION;
            if (seek_result != MA_SUCCESS) {
                end_render_exclusion();
                Logger::warn(
                    "PlaybackItem[{}] retry ignored — decoder seek failed: {}",
                    desc_.id.value, ma_result_description(seek_result));
                return;
            }
            playhead_frames_.store(frame, std::memory_order_release);
            reset_read_ahead_locked(frame);
            end_render_exclusion();
        }
    }

    // A deliberate replay is a fresh attempt. Drop any error notification from
    // the prior attempt so the sequencer cannot attach it to this new play.
    clear_decode_error();

    // Reset natural-end flags so take_natural_end() doesn't fire for a
    // stale previous play on this same item.
    stopped_naturally_.store(false, std::memory_order_release);
    fading_out_naturally_.store(false, std::memory_order_release);

    // Fade in from the CURRENT gain, not a hardcoded 0. Re-triggering a cue that
    // is mid stop-fade (FadingOut) would otherwise dip to silence before fading
    // back up — an audible click/dip. From Stopped the current gain is whatever
    // stop_now() left (the target), so start from 0 to actually fade in.
    const float from = (st == TransportState::FadingOut)
                           ? gain_current_linear_.load(std::memory_order_acquire)
                           : 0.0f;

    // Begin a fade-in if configured; otherwise jump straight to full gain.
    const auto fade = desc_.fade_in_duration;
    if (fade.count() > 0) {
        start_fade(/*from*/ from,
                   /*to*/   gain_target_linear_.load(),
                   fade,
                   TransportState::FadingIn,
                   TransportState::Playing);
    } else {
        gain_current_linear_.store(gain_target_linear_.load(), std::memory_order_release);
        transport_.store(TransportState::Playing, std::memory_order_release);
    }
}

void PlaybackItem::stop() {
    const TransportState st = transport_.load(std::memory_order_acquire);
    if (st == TransportState::Stopped) return;
    if (st == TransportState::FadingOut) {
        // Honour an explicit stop even when the item is already fading naturally
        // (e.g. reached its out-point). Cutting it immediately prevents audible
        // overlap with the next item that is about to start.
        stop_now();
        return;
    }

    // User-initiated stop: cancel natural-end tracking so the sequencer
    // doesn't auto-advance after this explicit stop.
    fading_out_naturally_.store(false, std::memory_order_release);

    const auto fade = desc_.fade_out_duration;
    if (fade.count() > 0) {
        start_fade(/*from*/ gain_current_linear_.load(),
                   /*to*/   0.0f,
                   fade,
                   TransportState::FadingOut,
                   TransportState::Stopped);
    } else {
        stop_now();
    }
}

void PlaybackItem::stop_now() {
    stopped_naturally_.store(false, std::memory_order_release);
    fading_out_naturally_.store(false, std::memory_order_release);
    transport_.store(TransportState::Stopped, std::memory_order_release);
    gain_current_linear_.store(gain_target_linear_.load(), std::memory_order_release);
    fade_duration_samples_.store(0, std::memory_order_relaxed);
    fade_elapsed_samples_.store(0, std::memory_order_relaxed);
    playhead_frames_.store(0, std::memory_order_relaxed);

    std::lock_guard lock{decoder_mutex_};
    begin_render_exclusion();
    if (decoder_) ma_decoder_seek_to_pcm_frame(decoder_.get(), 0);
    reset_read_ahead_locked(0);
    if (ltc_) ltc_->reset(std::chrono::nanoseconds{ltc_offset_ns_.load()});
    end_render_exclusion();
}

void PlaybackItem::pause() {
    const TransportState st = transport_.load(std::memory_order_acquire);
    if (st == TransportState::Playing || st == TransportState::FadingIn) {
        transport_.store(TransportState::Paused, std::memory_order_release);
    }
}

void PlaybackItem::resume() {
    if (transport_.load(std::memory_order_acquire) == TransportState::Paused) {
        transport_.store(TransportState::Playing, std::memory_order_release);
    }
}

void PlaybackItem::seek_seconds(double seconds) {
    if (seconds < 0) seconds = 0;
    ma_uint64 frame = static_cast<ma_uint64>(seconds * desc_.mix_sample_rate);
    {
        std::lock_guard lock{decoder_mutex_};
        begin_render_exclusion();
        if (decoder_) {
            const ma_result r = ma_decoder_seek_to_pcm_frame(decoder_.get(), frame);
            if (r != MA_SUCCESS) {
                // Seek failed (e.g. seeking past the true end of a VBR file whose
                // reported duration overshoots the decodable length). Resync the
                // playhead to the decoder's actual cursor so out-point / loop
                // checks and UI reporting don't drift for the rest of the cue.
                ma_uint64 cursor = 0;
                if (ma_decoder_get_cursor_in_pcm_frames(decoder_.get(), &cursor) == MA_SUCCESS)
                    frame = cursor;
            }
        }
        // Store inside the lock so the audio thread can't decode from the new
        // decoder position while still reading the pre-seek playhead value.
        playhead_frames_.store(frame, std::memory_order_release);
        reset_read_ahead_locked(frame);
        if (ltc_) {
        // LTC resyncs lazily inside render_block(), but a hint here keeps the
        // generator's internal frame counter from doing a full rebuild on the
        // first render after a big seek.
            ltc_->reset(std::chrono::nanoseconds{ltc_offset_ns_.load()});
        }
        end_render_exclusion();
    }
}

void PlaybackItem::set_gain_db(float db) noexcept {
    const float lin = db_to_lin(db);
    gain_target_linear_.store(lin, std::memory_order_release);
    // Don't disturb an in-flight fade; the fade end-point reflects this value
    // by virtue of being captured on play()/stop(). If we're stopped, snap
    // so the next play() picks up the new value cleanly. While Playing/Paused
    // we leave gain_current_linear_ alone — render_block() smoothly slews it
    // toward the new target (see the no-fade branch there), which removes
    // the audible step on duck-others and on UI fader moves.
    const TransportState st = transport_.load(std::memory_order_acquire);
    if (st == TransportState::Stopped) {
        gain_current_linear_.store(lin, std::memory_order_release);
    }
}

void PlaybackItem::set_ltc_enabled(bool enabled) {
    if (enabled == ltc_enabled_atomic_.load()) return;
    {
        std::lock_guard lock{decoder_mutex_};
        begin_render_exclusion();
        try {
            if (enabled) {
                if (!ltc_) ltc_ = std::make_unique<LTCGenerator>();
                ltc_->configure(desc_.mix_sample_rate, desc_.ltc_frame_rate,
                                std::chrono::nanoseconds{ltc_offset_ns_.load()});
            }
            desc_.ltc_enabled = enabled;
            ltc_enabled_atomic_.store(enabled, std::memory_order_release);
            resize_meters(
                file_channels_.load(std::memory_order_acquire) +
                (enabled ? 1u : 0u));
        } catch (...) {
            end_render_exclusion();
            throw;
        }
        end_render_exclusion();
    }
}

void PlaybackItem::set_ltc_frame_rate(LTCFrameRate fr) {
    std::lock_guard lock{decoder_mutex_};
    begin_render_exclusion();
    desc_.ltc_frame_rate = fr;
    if (ltc_) {
        ltc_->configure(desc_.mix_sample_rate, fr,
                        std::chrono::nanoseconds{ltc_offset_ns_.load()});
    }
    end_render_exclusion();
}

void PlaybackItem::set_ltc_offset(std::chrono::nanoseconds offset) noexcept {
    ltc_offset_ns_.store(offset.count(), std::memory_order_release);
}

void PlaybackItem::set_out_point_seconds(double seconds) noexcept {
    if (seconds <= 0.0) {
        out_point_frames_.store(0, std::memory_order_release);
    } else {
        const auto f = static_cast<std::uint64_t>(
            seconds * static_cast<double>(desc_.mix_sample_rate));
        out_point_frames_.store(f, std::memory_order_release);
    }

    // Already-decoded blocks reflect the old boundary. Refill from the audible
    // playhead so the new out-point takes effect on the next rendered block.
    std::lock_guard lock{decoder_mutex_};
    begin_render_exclusion();
    auto frame = playhead_frames_.load(std::memory_order_acquire);
    if (decoder_) {
        ma_decoder_seek_to_pcm_frame(decoder_.get(), static_cast<ma_uint64>(frame));
        ma_uint64 cursor = frame;
        if (ma_decoder_get_cursor_in_pcm_frames(decoder_.get(), &cursor) == MA_SUCCESS)
            frame = cursor;
    }
    playhead_frames_.store(frame, std::memory_order_release);
    reset_read_ahead_locked(frame);
    end_render_exclusion();
}

void PlaybackItem::set_loop(bool enabled, double in_seconds) noexcept {
    const auto rate = static_cast<double>(desc_.mix_sample_rate);
    auto in_frames = (in_seconds <= 0.0)
        ? std::uint64_t{0}
        : static_cast<std::uint64_t>(in_seconds * rate);
    // A loop-in point at or past the out-point would make render_block() re-hit
    // the out-point on every block — a rapid Stopped/loop retrigger with silence
    // and high seek churn. Fall back to looping from the start in that case.
    const auto out_pt = out_point_frames_.load(std::memory_order_acquire);
    if (out_pt > 0 && in_frames >= out_pt) in_frames = 0;
    loop_in_frames_.store(in_frames, std::memory_order_release);
    loop_enabled_.store(enabled, std::memory_order_release);

    // Drop blocks carrying the previous loop/end metadata and refill them from
    // the currently audible position.
    std::lock_guard lock{decoder_mutex_};
    begin_render_exclusion();
    auto frame = playhead_frames_.load(std::memory_order_acquire);
    if (decoder_) {
        ma_decoder_seek_to_pcm_frame(decoder_.get(), static_cast<ma_uint64>(frame));
        ma_uint64 cursor = frame;
        if (ma_decoder_get_cursor_in_pcm_frames(decoder_.get(), &cursor) == MA_SUCCESS)
            frame = cursor;
    }
    playhead_frames_.store(frame, std::memory_order_release);
    reset_read_ahead_locked(frame);
    end_render_exclusion();
}

bool PlaybackItem::prime(double seconds, double start_seconds) noexcept {
    // Priming is a stopped-cue preparation step. Project mirroring may revisit
    // one-shot cues while they are live; seeking an active decoder here would
    // reset its playhead and discard its queued audio. Check again under the
    // decoder lock so a state change observed while waiting also wins.
    if (transport_.load(std::memory_order_acquire) != TransportState::Stopped)
        return true;
    ma_uint64 start_frame = (start_seconds <= 0.0)
        ? ma_uint64{0}
        : static_cast<ma_uint64>(start_seconds *
                                 static_cast<double>(desc_.mix_sample_rate));
    {
        std::lock_guard lock{decoder_mutex_};
        if (transport_.load(std::memory_order_acquire) != TransportState::Stopped)
            return true;
        if (!decoder_ || !decoder_ready_) return false;
        begin_render_exclusion();
        ma_decoder_seek_to_pcm_frame(decoder_.get(), start_frame);
        ma_uint64 cursor = start_frame;
        if (ma_decoder_get_cursor_in_pcm_frames(decoder_.get(), &cursor) == MA_SUCCESS)
            start_frame = cursor;
        playhead_frames_.store(start_frame, std::memory_order_release);
        stopped_naturally_.store(false, std::memory_order_release);
        fading_out_naturally_.store(false, std::memory_order_release);
        reset_read_ahead_locked(start_frame);
        end_render_exclusion();
    }

    if (seconds <= 0.0) return true;
    const auto requested_frames = static_cast<std::uint64_t>(
        seconds * static_cast<double>(desc_.mix_sample_rate));
    const auto requested_blocks = std::max<std::size_t>(
        1, static_cast<std::size_t>(
               (requested_frames + desc_.render_block - 1) / desc_.render_block));
    service_read_ahead(std::min(requested_blocks, kReadAheadBlockCount));
    return true;
}

// ---------------------------------------------------------------------------

void PlaybackItem::begin_render_exclusion() noexcept {
    while (render_exclusion_.test_and_set(std::memory_order_acquire)) {
        std::this_thread::yield();
    }
}

void PlaybackItem::end_render_exclusion() noexcept {
    render_exclusion_.clear(std::memory_order_release);
}

void PlaybackItem::reset_read_ahead_locked(std::uint64_t frame) noexcept {
    read_ahead_read_.store(0, std::memory_order_relaxed);
    read_ahead_write_.store(0, std::memory_order_release);
    decode_cursor_frame_ = frame;
    decode_out_point_passed_ = false;
    decode_terminal_.store(false, std::memory_order_release);
}

bool PlaybackItem::fill_read_ahead_block_locked() noexcept {
    if (!decoder_ || !decoder_ready_.load(std::memory_order_acquire) ||
        read_ahead_.empty() ||
        decode_terminal_.load(std::memory_order_acquire)) {
        return false;
    }

    const auto write = read_ahead_write_.load(std::memory_order_relaxed);
    const auto read  = read_ahead_read_.load(std::memory_order_acquire);
    if (write - read >= read_ahead_.size()) return false;

    auto& slot = read_ahead_[write % read_ahead_.size()];
    slot.frames = 0;
    slot.playhead_after = decode_cursor_frame_;
    slot.natural_end = false;
    slot.decoder_result = 0;

    const std::size_t block_frames = static_cast<std::size_t>(desc_.render_block);
    const std::size_t channels = std::max<std::size_t>(
        1, file_channels_.load(std::memory_order_acquire));
    unsigned zero_progress_loops = 0;

    while (slot.frames < block_frames) {
        const auto out_point = decode_out_point_passed_
            ? std::uint64_t{0}
            : out_point_frames_.load(std::memory_order_acquire);
        std::size_t frames_to_read = block_frames - slot.frames;
        if (out_point > 0) {
            if (decode_cursor_frame_ >= out_point) {
                frames_to_read = 0;
            } else {
                frames_to_read = std::min<std::size_t>(
                    frames_to_read,
                    static_cast<std::size_t>(out_point - decode_cursor_frame_));
            }
        }

        ma_result rv = MA_SUCCESS;
        ma_uint64 got = 0;
        if (frames_to_read > 0) {
            rv = ma_decoder_read_pcm_frames(
                decoder_.get(),
                slot.samples.data() + static_cast<std::size_t>(slot.frames) * channels,
                static_cast<ma_uint64>(frames_to_read),
                &got);
            if (rv != MA_SUCCESS && rv != MA_AT_END) {
                slot.decoder_result = static_cast<int>(rv);
                decode_terminal_.store(true, std::memory_order_release);
                break;
            }

            slot.frames += static_cast<std::uint32_t>(got);
            decode_cursor_frame_ += got;
            if (got > 0) zero_progress_loops = 0;
        }

        const bool hit_out_point =
            out_point > 0 && decode_cursor_frame_ >= out_point;
        const bool hit_file_end =
            rv == MA_AT_END ||
            (frames_to_read > 0 &&
             got < static_cast<ma_uint64>(frames_to_read));
        if (!hit_out_point && !hit_file_end) continue;

        if (!loop_enabled_.load(std::memory_order_acquire)) {
            slot.natural_end = true;
            if (hit_file_end) {
                decode_terminal_.store(true, std::memory_order_release);
            } else {
                // Keep bounded tail audio available while render_block applies
                // the configured natural fade after the soft out-point.
                decode_out_point_passed_ = true;
            }
            break;
        }

        auto in_frame = loop_in_frames_.load(std::memory_order_acquire);
        if (out_point > 0 && in_frame >= out_point) in_frame = 0;
        const ma_result seek_r = ma_decoder_seek_to_pcm_frame(
            decoder_.get(), static_cast<ma_uint64>(in_frame));
        if (seek_r != MA_SUCCESS) {
            slot.decoder_result = static_cast<int>(seek_r);
            decode_terminal_.store(true, std::memory_order_release);
            break;
        }
        decode_cursor_frame_ = in_frame;

        // A malformed/empty source whose loop point also yields no audio must
        // not spin forever on the single shared decode worker.
        if (got == 0 && ++zero_progress_loops > 1) {
            slot.natural_end = true;
            decode_terminal_.store(true, std::memory_order_release);
            break;
        }
    }

    slot.playhead_after = decode_cursor_frame_;
    read_ahead_write_.store(write + 1, std::memory_order_release);
    return true;
}

bool PlaybackItem::service_read_ahead(std::size_t max_blocks) noexcept {
    if (max_blocks == 0 || !decoder_ready_.load(std::memory_order_acquire))
        return false;

    std::lock_guard lock{decoder_mutex_};
    bool produced = false;
    for (std::size_t i = 0; i < max_blocks; ++i) {
        if (!fill_read_ahead_block_locked()) break;
        produced = true;
    }
    return produced;
}

void PlaybackItem::stop_for_decode_error(int decoder_result) noexcept {
    decode_error_code_.store(decoder_result, std::memory_order_release);
    decode_error_.store(true, std::memory_order_release);
    decode_error_pending_.store(true, std::memory_order_release);
    fading_out_naturally_.store(false, std::memory_order_release);
    stopped_naturally_.store(false, std::memory_order_release);
    fade_duration_samples_.store(0, std::memory_order_relaxed);
    fade_elapsed_samples_.store(0, std::memory_order_relaxed);
    transport_.store(TransportState::Stopped, std::memory_order_release);
}

void PlaybackItem::handle_natural_end() noexcept {
    const auto cur = transport_.load(std::memory_order_acquire);
    if (cur != TransportState::Playing && cur != TransportState::FadingIn) return;

    fading_out_naturally_.store(true, std::memory_order_release);
    const auto fade = std::chrono::milliseconds{
        fade_out_ms_.load(std::memory_order_acquire)};
    if (fade.count() > 0) {
        start_fade(gain_current_linear_.load(), 0.0f, fade,
                   TransportState::FadingOut, TransportState::Stopped);
    } else {
        fading_out_naturally_.store(false, std::memory_order_release);
        stopped_naturally_.store(true, std::memory_order_release);
        transport_.store(TransportState::Stopped, std::memory_order_release);
    }
}

// ---------------------------------------------------------------------------

void PlaybackItem::start_fade(float from_lin, float to_lin,
                              std::chrono::milliseconds dur,
                              TransportState during,
                              TransportState after_complete) noexcept {
    const long long duration_samples = std::max<long long>(
        0, static_cast<long long>(dur.count()) *
               static_cast<long long>(desc_.mix_sample_rate) / 1000);

    fade_start_linear_.store(from_lin, std::memory_order_relaxed);
    fade_end_linear_  .store(to_lin,   std::memory_order_relaxed);
    fade_duration_samples_.store(duration_samples, std::memory_order_relaxed);
    fade_elapsed_samples_.store(0, std::memory_order_relaxed);
    gain_current_linear_.store(from_lin, std::memory_order_release);
    transport_.store(during, std::memory_order_release);

    // `after_complete` is intentionally not stored: render_block() derives the
    // post-fade transport purely from `during` (FadingIn → Playing, FadingOut →
    // Stopped). The parameter is kept for call-site readability only. All
    // current callers pass the matching pair, so the two never disagree.
    (void)after_complete;
}

void PlaybackItem::resize_meters(ChannelCount n) {
    std::lock_guard lock{source_meters_mutex_};
    source_meters_.resize(n);
    for (ChannelCount i = 0; i < n; ++i) {
        if (!source_meters_[i]) source_meters_[i] = std::make_unique<Meter>();
        source_meters_[i]->configure(desc_.mix_sample_rate, meter_ballistics_);
        source_meters_[i]->set_true_peak_enabled(meter_true_peak_);
        source_meters_[i]->set_loudness_enabled(meter_loudness_);
    }
}

// Meter configuration is independent of decoder I/O. The render gate protects
// its lock-free meter pointers; the short meter lock protects broadcaster
// snapshots from vector replacement.
void PlaybackItem::set_meter_ballistics(const MeterBallistics& b) noexcept {
    begin_render_exclusion();
    std::lock_guard lock{source_meters_mutex_};
    meter_ballistics_ = b;
    for (auto& m : source_meters_) {
        if (m) m->configure(desc_.mix_sample_rate, b);
    }
    end_render_exclusion();
}

void PlaybackItem::set_true_peak_metering(bool enabled) noexcept {
    begin_render_exclusion();
    std::lock_guard lock{source_meters_mutex_};
    meter_true_peak_ = enabled;
    for (auto& m : source_meters_) {
        if (m) m->set_true_peak_enabled(enabled);
    }
    end_render_exclusion();
}

void PlaybackItem::set_loudness_metering(bool enabled) noexcept {
    begin_render_exclusion();
    std::lock_guard lock{source_meters_mutex_};
    meter_loudness_ = enabled;
    for (auto& m : source_meters_) {
        if (m) m->set_loudness_enabled(enabled);
    }
    end_render_exclusion();
}

// ---------------------------------------------------------------------------

std::size_t PlaybackItem::render_block(Sample* const* out_channel_buffers,
                                       ChannelCount   out_channel_count,
                                       std::size_t    frame_count) noexcept {
    // Silence first so early-outs leave well-defined buffers behind.
    for (ChannelCount c = 0; c < out_channel_count; ++c) {
        std::memset(out_channel_buffers[c], 0, frame_count * sizeof(Sample));
    }

    const TransportState st = transport_.load(std::memory_order_acquire);
    if (st == TransportState::Stopped || st == TransportState::Paused) return 0;
    if (!decoder_ready_) return 0;

    // A control operation may be replacing queue/meter/LTC storage. The
    // real-time side only tries the gate once and emits silence rather than
    // waiting; the control side owns the only spin loop.
    if (render_exclusion_.test_and_set(std::memory_order_acquire)) return 0;
    RenderActiveGuard render_guard{render_exclusion_};
    const auto file_channels =
        file_channels_.load(std::memory_order_acquire);

    const auto read  = read_ahead_read_.load(std::memory_order_relaxed);
    const auto write = read_ahead_write_.load(std::memory_order_acquire);
    std::size_t frames_read = 0;
    bool natural_end = false;
    std::uint64_t playhead_after =
        playhead_frames_.load(std::memory_order_relaxed);
    if (read == write || read_ahead_.empty()) {
        if (!decode_terminal_.load(std::memory_order_acquire)) {
            read_ahead_underruns_.fetch_add(1, std::memory_order_relaxed);
        }
        // A fade-out must continue across silence so EOF/out-point fades settle
        // to Stopped instead of remaining FadingOut forever.
        if (st != TransportState::FadingOut) return 0;
    } else {
        const auto& slot = read_ahead_[read % read_ahead_.size()];
        const int decoder_result = slot.decoder_result;
        natural_end = slot.natural_end;
        playhead_after = slot.playhead_after;
        frames_read = std::min<std::size_t>(slot.frames, frame_count);

        // A decoder failure is not EOF. Stop this cue immediately and return
        // before natural-end/follow logic; the sequencer broadcasts the pending
        // edge off the audio thread.
        if (decoder_result != 0) {
            read_ahead_read_.store(read + 1, std::memory_order_release);
            stop_for_decode_error(decoder_result);
            return 0;
        }

        deinterleave_to(slot.samples.data(),
                        frames_read,
                        file_channels,
                        out_channel_buffers,
                        std::min<ChannelCount>(out_channel_count, file_channels));
        // The slot is no longer referenced after deinterleaving; release it so
        // the shared worker can refill while gain/meter processing continues.
        read_ahead_read_.store(read + 1, std::memory_order_release);
    }

    // ---- LTC virtual channel ----
    const bool ltc_on = ltc_enabled_atomic_.load(std::memory_order_acquire);
    if (ltc_on && ltc_ && out_channel_count > file_channels) {
        const long long playhead_frames =
            static_cast<long long>(playhead_frames_.load(std::memory_order_relaxed));
        const auto playhead_ns = std::chrono::nanoseconds{
            playhead_frames * 1'000'000'000LL / static_cast<long long>(desc_.mix_sample_rate)};
        // Refresh offset in case the control thread changed it. Use set_offset()
        // — NOT configure() — so we don't reset the encoder state every block
        // (that would force polarity back to +1 each block and corrupt the
        // biphase-mark signal). Sample-rate / frame-rate / enable changes go
        // through configure() from their dedicated setters instead.
        ltc_->set_offset(
            std::chrono::nanoseconds{ltc_offset_ns_.load(std::memory_order_acquire)});
        ltc_->render_block(out_channel_buffers[file_channels], frame_count, playhead_ns);
    }

    // ---- Per-item gain + fade envelope ----
    // Compute the gain sample-by-sample. We keep the math simple: linear ramp.
    float gain_now = gain_current_linear_.load(std::memory_order_acquire);
    float gain_end = gain_now;
    bool  fade_active = (st == TransportState::FadingIn) || (st == TransportState::FadingOut);
    long long fade_total   = fade_duration_samples_.load(std::memory_order_relaxed);
    long long fade_elapsed = fade_elapsed_samples_.load(std::memory_order_relaxed);
    const float fade_from  = fade_start_linear_.load(std::memory_order_relaxed);
    const float fade_to    = fade_end_linear_.load(std::memory_order_relaxed);

    if (fade_active && fade_total > 0) {
        const long long advance = static_cast<long long>(frame_count);
        const long long new_elapsed = std::min<long long>(fade_elapsed + advance, fade_total);
        const float t_start = static_cast<float>(fade_elapsed) / static_cast<float>(fade_total);
        const float t_end   = static_cast<float>(new_elapsed)  / static_cast<float>(fade_total);
        gain_now = fade_from + (fade_to - fade_from) * t_start;
        gain_end = fade_from + (fade_to - fade_from) * t_end;

        fade_elapsed_samples_.store(new_elapsed, std::memory_order_relaxed);
        if (new_elapsed >= fade_total) {
            gain_current_linear_.store(fade_to, std::memory_order_release);
            // Transition state machine.
            if (st == TransportState::FadingIn) {
                transport_.store(TransportState::Playing, std::memory_order_release);
            } else {  // FadingOut
                transport_.store(TransportState::Stopped, std::memory_order_release);
                // If this fade was triggered by natural EOF/out-point,
                // signal the sequencer so it can auto-advance.
                if (fading_out_naturally_.exchange(false, std::memory_order_acq_rel)) {
                    stopped_naturally_.store(true, std::memory_order_release);
                }
            }
        } else {
            gain_current_linear_.store(gain_end, std::memory_order_release);
        }
    } else {
        // No fade active — but if set_gain_db() changed the *target* while we
        // were playing (e.g. auto-duck "duck-others", or a UI fader move), the
        // current and target diverge. Smoothly slew current toward target over
        // a short, fixed window. Without this, ducking is an audible step
        // (-20 dB in one sample is a click on every transition) and per-item
        // volume slider moves on the UI also click.
        const float target = gain_target_linear_.load(std::memory_order_acquire);
        if (target != gain_now) {
            // ~50 ms slew at the configured mix rate. Long enough to remove
            // any click, short enough that "ducking now" still feels immediate.
            constexpr long long kRampMs = 50;
            const long long ramp_samples = std::max<long long>(1,
                static_cast<long long>(desc_.mix_sample_rate) * kRampMs / 1000);
            const long long advance = static_cast<long long>(frame_count);
            if (advance >= ramp_samples) {
                gain_end = target;
            } else {
                const float alpha =
                    static_cast<float>(advance) / static_cast<float>(ramp_samples);
                gain_end = gain_now + (target - gain_now) * alpha;
            }
            gain_current_linear_.store(gain_end, std::memory_order_release);
        }
    }

    // Apply linear gain ramp across the block. Per-sample cosine would be
    // smoother but per-block linear is inaudible at the fade durations we use
    // and saves CPU.
    if (frames_read > 0) {
        for (ChannelCount c = 0;
             c < std::min<ChannelCount>(out_channel_count, file_channels);
             ++c) {
            Sample* buf = out_channel_buffers[c];
            const std::size_t n = static_cast<std::size_t>(frames_read);
            if (n == 0) continue;
            const float dg = (gain_end - gain_now) / static_cast<float>(std::max<std::size_t>(n, 1));
            float g = gain_now;
            for (std::size_t i = 0; i < n; ++i) {
                buf[i] *= g;
                g += dg;
            }
        }
    }
    // Apply gain to LTC channel too (so item fade affects LTC level uniformly).
    if (ltc_on && out_channel_count > file_channels) {
        Sample* buf = out_channel_buffers[file_channels];
        const std::size_t n = frame_count;
        const float dg = (gain_end - gain_now) / static_cast<float>(std::max<std::size_t>(n, 1));
        float g = gain_now;
        for (std::size_t i = 0; i < n; ++i) {
            buf[i] *= g;
            g += dg;
        }
    }

    // ---- Update per-source-channel meters ----
    const ChannelCount meter_n = std::min<ChannelCount>(
        out_channel_count, file_channels + (ltc_on ? 1u : 0u));
    for (ChannelCount c = 0; c < meter_n; ++c) {
        if (c < source_meters_.size() && source_meters_[c]) {
            source_meters_[c]->push_block(out_channel_buffers[c], frame_count);
        }
    }

    // Decoder position and loop transitions are prepared by the decode worker.
    playhead_frames_.store(playhead_after, std::memory_order_release);
    if (natural_end) handle_natural_end();

    return frames_read;
}

bool PlaybackItem::take_natural_end() noexcept {
    return stopped_naturally_.exchange(false, std::memory_order_acq_rel);
}

float PlaybackItem::gain_db() const noexcept {
    const float lin = gain_target_linear_.load(std::memory_order_acquire);
    if (lin <= 0.0f) return -120.0f;
    return 20.0f * std::log10(lin);
}

void PlaybackItem::stop_with_fade(std::chrono::milliseconds dur) {
    const TransportState st = transport_.load(std::memory_order_acquire);
    if (st == TransportState::Stopped || st == TransportState::FadingOut) return;
    // Not a natural end — don't set fading_out_naturally_ so the sequencer
    // won't auto-advance on this particular fade completion.
    if (dur.count() > 0) {
        start_fade(gain_current_linear_.load(), 0.0f, dur,
                   TransportState::FadingOut, TransportState::Stopped);
    } else {
        stop_now();
    }
}

} // namespace liveplay::audio
