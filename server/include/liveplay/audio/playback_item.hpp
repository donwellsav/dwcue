// ============================================================================
// liveplay/audio/playback_item.hpp
// ----------------------------------------------------------------------------
// A single live cue instance — Tier 1 of the mixer tree.
//
// Each PlaybackItem owns:
//   * Its own ma_decoder (independent state per cue, even when two cues load
//     the same file — solves the DonWells Cue 1.x state-sharing bug)
//   * Per-item linear gain + fade envelope (in/out)
//   * Transport state (Stopped / Playing / FadingOut / Paused)
//   * An optional LTCGenerator that occupies a synthetic source channel
//     appended after the file's real channels
//   * A per-source-channel Meter
//
// Public mutators are control-thread safe (atomics + mutex for the decoder).
// render_block() is audio-thread-only.
//
// Manual-stop fade contract:
//   stop()        → if the configured fade-out duration is non-zero, transition
//                   into FadingOut for that duration, then Stopped.
//   stop_now()    → immediate stop, ignoring fade duration (panic button).
//   master_stop() → goes through stop() (so fades are honoured).
//   natural end-of-file → also funnels through stop() with the fade.
//   ⇒ all three paths converge on the same envelope code → guaranteed
//     consistent behaviour, fixing the 1.x "fade only on natural end" gap.
// ============================================================================
#pragma once

#include "liveplay/audio/ltc_generator.hpp"
#include "liveplay/audio/meter.hpp"
#include "liveplay/audio/types.hpp"

#include <atomic>
#include <chrono>
#include <filesystem>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

// Forward-declare to keep miniaudio.h out of this public header.
struct ma_decoder;

namespace liveplay::audio {

enum class TransportState : std::uint8_t {
    Stopped     = 0,
    Playing     = 1,
    FadingIn    = 2,
    FadingOut   = 3,
    Paused      = 4,
};

struct PlaybackItemDesc {
    CueId                    id;
    std::filesystem::path    file_path;
    SampleRate               mix_sample_rate = kDefaultMixSampleRate;
    FrameCount               render_block    = kDefaultRenderBlock;

    // Default channel count emitted by the decoder when the file doesn't
    // declare one we recognise. 2 (stereo) covers ~all real-world cues.
    ChannelCount             fallback_channels = 2;

    // Per-cue fade durations (0 ms = instant).
    std::chrono::milliseconds fade_in_duration  {0};
    std::chrono::milliseconds fade_out_duration {0};

    // LTC: nullopt = no LTC on this cue. When set, the LTCGenerator's mono
    // output is appended as an extra source channel after the file's
    // channels — index = file_channels (0-based).
    bool                      ltc_enabled = false;
    LTCFrameRate              ltc_frame_rate = LTCFrameRate::Fps30;
    std::chrono::nanoseconds  ltc_offset    {0};
};

// Statistics that the control thread can read for UI / debugging.
struct PlaybackItemStats {
    TransportState  transport      = TransportState::Stopped;
    FrameCount      playhead_frame = 0;
    double          playhead_seconds = 0.0;
    ChannelCount    source_channels = 0;     // including LTC if enabled
    bool            file_loaded     = false;
    bool            at_end          = false;
    bool            decode_error    = false;
    int             decoder_result  = 0;     // native decoder result; 0 = none
    std::uint64_t   read_ahead_underruns = 0;
    std::uint32_t   read_ahead_blocks    = 0;
};

class PlaybackItem {
public:
    explicit PlaybackItem(PlaybackItemDesc desc);
    ~PlaybackItem();

    PlaybackItem(const PlaybackItem&) = delete;
    PlaybackItem& operator=(const PlaybackItem&) = delete;

    // Open the decoder. Returns false on failure (file missing, format
    // unsupported, etc.). Idempotent — calling twice is allowed but rebuilds
    // the decoder.
    bool load();

    // Close the decoder and free its memory. Stops playback first.
    void unload();

    // ---- Transport (control thread) --------------------------------------
    void play();
    void stop();                                  // honours fade_out_duration
    void stop_now();                              // hard stop, ignores fade
    void pause();
    void resume();
    void seek_seconds(double seconds);

    // ---- Mutators --------------------------------------------------------
    void set_gain_db(float db) noexcept;
    // Fade durations are mirrored into atomics so the audio thread can read the
    // fade-out length without racing these control-thread writes (desc_ keeps a
    // copy for serialization and control-thread reads).
    void set_fade_in (std::chrono::milliseconds d) noexcept {
        desc_.fade_in_duration  = d;
        fade_in_ms_.store(d.count(), std::memory_order_release);
    }
    void set_fade_out(std::chrono::milliseconds d) noexcept {
        desc_.fade_out_duration = d;
        fade_out_ms_.store(d.count(), std::memory_order_release);
    }
    void set_ltc_enabled(bool enabled);
    void set_ltc_frame_rate(LTCFrameRate fr);
    void set_ltc_offset(std::chrono::nanoseconds offset) noexcept;

    // Retune source-meter ballistics (applies to existing meters immediately
    // and to any meters created later, e.g. after an LTC channel-count
    // change). Safe mid-playback.
    void set_meter_ballistics(const MeterBallistics& b) noexcept;

    // Toggle 4× oversampled true-peak detection on the source meters (same
    // apply-now-and-to-future-meters semantics as set_meter_ballistics).
    void set_true_peak_metering(bool enabled) noexcept;

    // Toggle K-weighted loudness on the source meters (same semantics).
    void set_loudness_metering(bool enabled) noexcept;

    // Configure a soft end-of-playback point in seconds (the item's "out
    // point"). When the playhead reaches this frame, the same code path as
    // natural EOF runs — stop() honours fade_out_duration. Pass <= 0 to
    // disable (play to natural EOF). Safe to set while playing.
    void set_out_point_seconds(double seconds) noexcept;

    // Enable/disable seamless looping. When enabled, reaching EOF / out-point
    // seeks the decoder back to `in_seconds` and continues playing without
    // transitioning to FadingOut/Stopped — so the broadcast loop never emits a
    // transient "Stopped" cue_state edge mid-loop and the client UI keeps the
    // cue visible the whole time. Safe to call while playing.
    void set_loop(bool enabled, double in_seconds = 0.0) noexcept;

    // Returns true (and clears the flag) if this item finished playing
    // naturally (reached EOF or out-point, including any configured
    // fade-out). Returns false if the item was explicitly stopped or
    // hasn't stopped yet. Called by the ProjectState sequencer thread.
    bool take_natural_end() noexcept;

    // Current target gain in dB. Used by the sequencer to snapshot a
    // cue's gain before ducking so it can be restored afterward.
    float gain_db() const noexcept;

    // Fade out over `dur` and stop, without modifying the stored
    // fade_out_duration. Used by the crossfade and stop-fade sequencer
    // so these fades don't disturb the "explicit-stop" fade setting.
    void stop_with_fade(std::chrono::milliseconds dur);

    // For a stopped cue, position the decoder at `start_seconds` and
    // synchronously fill the bounded read-ahead queue. Active cues are left
    // unchanged. `seconds` caps how much is filled; the queue itself is
    // deliberately much smaller than two seconds. Returns false when the
    // decoder isn't ready.
    bool prime(double seconds = 2.0, double start_seconds = 0.0) noexcept;

    // Decode-worker entry point. Fills at most `max_blocks` free read-ahead
    // slots and returns true when it produced anything. AudioEngine calls this
    // from one shared worker; there is never a thread per cue.
    bool service_read_ahead(std::size_t max_blocks = 1) noexcept;

    // ---- Introspection ---------------------------------------------------
    const CueId&     id() const noexcept                  { return desc_.id; }
    const PlaybackItemDesc& desc() const noexcept         { return desc_; }
    ChannelCount     source_channel_count() const noexcept;  // includes LTC if enabled
    PlaybackItemStats stats() const noexcept;

    // True if the decoder returned an unexpected error mid-playback (i.e. not a
    // clean end-of-file) since the flag was last cleared — e.g. a file dropping
    // off a flaky network/USB drive. The error is sticky for reconnect snapshots;
    // take_decode_error() separately consumes the one-shot notification used by
    // the sequencer/control layer.
    bool had_decode_error() const noexcept {
        return decode_error_.load(std::memory_order_acquire);
    }
    int decoder_error_code() const noexcept {
        return decode_error_code_.load(std::memory_order_acquire);
    }
    int take_decode_error() noexcept {
        if (!decode_error_pending_.exchange(false, std::memory_order_acq_rel)) return 0;
        return decode_error_code_.load(std::memory_order_acquire);
    }
    void clear_decode_error() noexcept {
        decode_error_pending_.store(false, std::memory_order_release);
        decode_error_code_.store(0, std::memory_order_release);
        decode_error_.store(false, std::memory_order_release);
    }

    MeterSnapshot source_meter(ChannelIndex ch) const noexcept;
    // Consuming read (resets the channel's max-since-read). Broadcaster only.
    MeterSnapshot source_meter_consume(ChannelIndex ch) noexcept;

    // ---- Audio thread ----------------------------------------------------
    // Render `frame_count` frames into `out` (deinterleaved per source channel).
    // `out` must point at an array of `source_channel_count()` channel pointers,
    // each at least `frame_count` Samples long. The engine pre-allocates these
    // buffers and reuses them.
    //
    // Returns the number of frames actually written. May be less than
    // frame_count when end-of-file is reached this block; the rest is silenced
    // and the transport transitions to Stopped (via the fade pathway).
    std::size_t render_block(Sample* const* out_channel_buffers,
                             ChannelCount   out_channel_count,
                             std::size_t    frame_count) noexcept;

private:
    PlaybackItemDesc desc_;

    // Owned decoder. Pointer because miniaudio types stay out of this header.
    // Only control operations and AudioEngine's shared decode worker touch it;
    // render_block() consumes predecoded blocks and never locks or reads files.
    std::unique_ptr<ma_decoder> decoder_;
    mutable std::mutex          decoder_mutex_;
    std::atomic<bool>           decoder_ready_{false};
    std::atomic<ChannelCount>   file_channels_{0};

    // Fixed-capacity SPSC read-ahead. Slots and their sample storage are
    // allocated in load(); the producer is the shared decode worker and the
    // sole consumer is render_block().
    static constexpr std::size_t kReadAheadBlockCount = 16;
    struct ReadAheadBlock {
        std::vector<Sample> samples;
        std::uint32_t       frames = 0;
        std::uint64_t       playhead_after = 0;
        bool                natural_end = false;
        int                 decoder_result = 0;
    };
    std::vector<ReadAheadBlock> read_ahead_;
    std::atomic<std::uint64_t>  read_ahead_read_{0};
    std::atomic<std::uint64_t>  read_ahead_write_{0};
    std::uint64_t               decode_cursor_frame_ = 0; // decoder_mutex_
    bool                        decode_out_point_passed_ = false; // decoder_mutex_
    std::atomic<bool>           decode_terminal_{false};
    std::atomic<std::uint64_t>  read_ahead_underruns_{0};

    // Control operations occasionally replace queue/meter/LTC storage. One
    // lock-free gate gives those operations exclusive access; render_block()
    // only tries once and emits silence rather than ever waiting.
    std::atomic_flag render_exclusion_ = ATOMIC_FLAG_INIT;

    // Transport + gain state (hot atomics).
    std::atomic<TransportState> transport_{TransportState::Stopped};
    std::atomic<float>          gain_target_linear_{1.0f};
    std::atomic<float>          gain_current_linear_{1.0f};     // smoothed

    // Per-block fade state (active when transport_ == FadingIn or FadingOut).
    std::atomic<float>          fade_start_linear_{0.0f};
    std::atomic<float>          fade_end_linear_{1.0f};
    std::atomic<long long>      fade_duration_samples_{0};
    std::atomic<long long>      fade_elapsed_samples_{0};

    // Atomic mirrors of desc_.fade_in/out_duration (in ms) for lock-free reads
    // from the audio thread. Written by set_fade_in()/set_fade_out().
    std::atomic<long long>      fade_in_ms_{0};
    std::atomic<long long>      fade_out_ms_{0};

    // Set by render_block() on an unexpected decoder error (see had_decode_error).
    // The sticky state survives event consumption so reconnecting control clients
    // can still report the stopped cue's failure.
    std::atomic<bool>           decode_error_{false};
    std::atomic<int>            decode_error_code_{0};
    std::atomic<bool>           decode_error_pending_{false};

    // Playhead in mix-rate frames. Audio thread is the only writer.
    std::atomic<std::uint64_t>  playhead_frames_{0};

    // Out-point: when playhead_frames_ reaches this value, render_block
    // triggers the natural-EOF code path (fade-out then Stopped). 0 disables
    // (play to file end).
    std::atomic<std::uint64_t>  out_point_frames_{0};

    // Seamless-loop state: when loop_enabled_ is true, hitting EOF / out-point
    // inside render_block() seeks the decoder back to loop_in_frames_ and
    // continues playing instead of fading out. Owned by the control thread for
    // writes, read by the audio thread per block.
    std::atomic<bool>           loop_enabled_{false};
    std::atomic<std::uint64_t>  loop_in_frames_{0};

    // Set to true inside render_block() when the natural-end fade-out
    // starts (EOF or out-point triggered). Cleared on explicit stop().
    // When the FadingOut→Stopped transition completes, stopped_naturally_
    // is set and this flag is cleared.
    std::atomic<bool> fading_out_naturally_{false};
    // Set to true when a naturally-initiated fade-out finishes (transport
    // becomes Stopped). Cleared by take_natural_end() or play().
    std::atomic<bool> stopped_naturally_{false};

    // LTC generator (optional). Built fresh whenever LTC config changes.
    std::unique_ptr<LTCGenerator> ltc_;
    std::atomic<bool>             ltc_enabled_atomic_{false};
    // Atomic offset so set_ltc_offset() can be called while playing without
    // touching the LTCGenerator from the control thread.
    std::atomic<long long>        ltc_offset_ns_{0};

    // Per-source-channel meters (including LTC if enabled). Sized at load().
    // Telemetry uses its own lifetime lock so a stalled network-file decode
    // cannot block the server's meter broadcaster.
    mutable std::mutex source_meters_mutex_;
    std::vector<std::unique_ptr<Meter>> source_meters_;
    // Current ballistics + feature flags — applied by resize_meters() so
    // meters created after a channel-count change inherit the project
    // settings.
    MeterBallistics meter_ballistics_{};
    bool            meter_true_peak_ = false;
    bool            meter_loudness_  = false;

    // Helpers ----------------------------------------------------------
    void start_fade(float from_lin, float to_lin, std::chrono::milliseconds dur,
                    TransportState during, TransportState after_complete) noexcept;
    void resize_meters(ChannelCount n);
    void begin_render_exclusion() noexcept;
    void end_render_exclusion() noexcept;
    void reset_read_ahead_locked(std::uint64_t frame) noexcept;
    bool fill_read_ahead_block_locked() noexcept;
    void stop_for_decode_error(int decoder_result) noexcept;
    void handle_natural_end() noexcept;
};

} // namespace liveplay::audio
