// ============================================================================
// waveform.cpp — see waveform.hpp.
// ============================================================================
#include "liveplay/meta/waveform.hpp"
#include "liveplay/audio/decoder.hpp"
#include "liveplay/audio/meter.hpp"
#include "liveplay/logger.hpp"
#include "liveplay/util/unicode_path.hpp"

#include <miniaudio.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <memory>
#include <vector>

namespace liveplay::meta {
namespace {

// How many sub-buckets we keep per requested output bucket while decoding (see
// compute_waveform). Always a power of two so the grid size stays even and can
// be halved by merging adjacent pairs. Bigger = bucket boundaries land closer
// to their ideal frame positions; the cost is memory
// (bucket_count * factor * channels * 12 bytes).
std::size_t oversample_factor(std::uint32_t bucket_count) noexcept {
    if (bucket_count <= 4096) return 16;
    if (bucket_count <= 8192) return 8;
    return 4;
}

std::uint64_t frame_at(std::optional<std::chrono::milliseconds> time,
                       std::uint32_t sample_rate,
                       std::uint64_t fallback) noexcept {
    if (!time) return fallback;
    const auto ms = std::max<std::int64_t>(0, time->count());
    const long double frames =
        static_cast<long double>(ms) * static_cast<long double>(sample_rate) / 1000.0L;
    if (frames >= static_cast<long double>(std::numeric_limits<std::uint64_t>::max()))
        return std::numeric_limits<std::uint64_t>::max();
    return static_cast<std::uint64_t>(std::ceil(frames));
}

double channel_gain(ma_channel channel) noexcept {
    if (channel == MA_CHANNEL_LFE) return 0.0;
    switch (channel) {
        case MA_CHANNEL_BACK_LEFT:
        case MA_CHANNEL_BACK_RIGHT:
        case MA_CHANNEL_BACK_CENTER:
        case MA_CHANNEL_SIDE_LEFT:
        case MA_CHANNEL_SIDE_RIGHT:
            return 1.41;
        default:
            return 1.0;
    }
}

double lufs_from_power(double power) noexcept {
    return power <= 0.0 ? -std::numeric_limits<double>::infinity()
                        : -0.691 + 10.0 * std::log10(power);
}

std::optional<double> integrated_loudness(
    const std::vector<double>& block_powers) noexcept {
    constexpr double kAbsoluteGateLufs = -70.0;
    const double absolute_gate_power =
        std::pow(10.0, (kAbsoluteGateLufs + 0.691) / 10.0);

    double absolute_sum = 0.0;
    std::size_t absolute_count = 0;
    for (const double power : block_powers) {
        if (power <= absolute_gate_power) continue;
        absolute_sum += power;
        ++absolute_count;
    }
    if (absolute_count == 0) return std::nullopt;

    const double relative_gate_power = std::pow(
        10.0, (lufs_from_power(absolute_sum / absolute_count) - 10.0 + 0.691) / 10.0);
    const double gate_power = std::max(absolute_gate_power, relative_gate_power);

    double gated_sum = 0.0;
    std::size_t gated_count = 0;
    for (const double power : block_powers) {
        if (power <= gate_power) continue;
        gated_sum += power;
        ++gated_count;
    }
    if (gated_count == 0) return std::nullopt;
    return lufs_from_power(gated_sum / gated_count);
}

} // namespace

Waveform compute_waveform(const std::filesystem::path& path,
                          std::uint32_t bucket_count,
                          std::optional<std::chrono::milliseconds> analysis_start,
                          std::optional<std::chrono::milliseconds> analysis_end) noexcept {
    Waveform out;
    bucket_count = std::clamp<std::uint32_t>(bucket_count, 16, 16384);

    ma_decoder_config cfg = audio::decoder_config(ma_format_f32, 0, 0);
    ma_decoder decoder{};
    const std::string p = util::path_to_utf8(path);   // for log messages
    if (audio::decoder_init_file(path, cfg, decoder) != MA_SUCCESS) {
        Logger::warn("compute_waveform: cannot decode '{}'", p);
        return out;
    }

    ma_uint32 channels    = 0;
    ma_uint32 sample_rate = 0;
    ma_decoder_get_data_format(&decoder, nullptr, &channels, &sample_rate, nullptr, 0);
    if (channels == 0) channels = 2;
    if (sample_rate == 0) sample_rate = audio::kDefaultMixSampleRate;

    std::vector<ma_channel> channel_map(channels, MA_CHANNEL_NONE);
    ma_decoder_get_data_format(
        &decoder, nullptr, nullptr, nullptr, channel_map.data(), channel_map.size());
    if (ma_channel_map_is_blank(channel_map.data(), channels)) {
        ma_channel_map_init_standard(
            ma_standard_channel_map_default, channel_map.data(), channel_map.size(), channels);
    }

    const std::uint64_t analysis_start_frame = frame_at(analysis_start, sample_rate, 0);
    const std::uint64_t analysis_end_frame = frame_at(
        analysis_end, sample_rate, std::numeric_limits<std::uint64_t>::max());
    std::vector<std::unique_ptr<audio::Meter>> analysis_meters;
    analysis_meters.reserve(channels);
    for (ma_uint32 c = 0; c < channels; ++c) {
        auto meter = std::make_unique<audio::Meter>();
        meter->configure(sample_rate);
        meter->set_loudness_enabled(true);
        meter->set_true_peak_enabled(true);
        analysis_meters.push_back(std::move(meter));
    }
    std::vector<double> loudness_blocks;
    std::uint64_t analysis_frames = 0;
    std::uint64_t hop_index = 1;
    std::uint64_t next_hop_frame =
        (static_cast<std::uint64_t>(sample_rate) + 9) / 10;

    // ---- Single decode pass ------------------------------------------------
    // We deliberately do NOT ask miniaudio for the length up front: for MP3
    // (and any other format that doesn't carry a frame count in a header)
    // ma_decoder_get_length_in_pcm_frames() answers by decoding the whole file,
    // which made every MP3 waveform cost two full decodes.
    //
    // Instead the file is decoded exactly once into a fine grid of sub-buckets.
    // The grid starts at one frame per sub-bucket; whenever it fills up,
    // adjacent pairs are merged (peak = max, sum-of-squares = sum — both exact)
    // and the span per sub-bucket doubles. That bounds memory at
    // `max_subs` entries regardless of file length while keeping full
    // resolution for short files. Once the decode ends the true length is
    // known, and the grid is folded onto the requested bucket count.
    const std::size_t max_subs =
        static_cast<std::size_t>(bucket_count) * oversample_factor(bucket_count);

    std::vector<std::vector<float>>  sub_peak (channels, std::vector<float> (max_subs, 0.0f));
    std::vector<std::vector<double>> sub_sumsq(channels, std::vector<double>(max_subs, 0.0));

    std::uint64_t sub_span    = 1;   // frames covered by each *completed* sub-bucket
    std::size_t   sub_n       = 0;   // number of completed sub-buckets
    std::uint64_t part_frames = 0;   // frames accumulated into the open sub-bucket

    std::vector<float>  acc_peak (channels, 0.0f);
    std::vector<double> acc_sumsq(channels, 0.0);

    // Streamed read in 4096-frame chunks so we don't allocate a giant buffer
    // for long files.
    constexpr ma_uint64 kChunk = 4096;
    std::vector<float> buf(kChunk * channels);
    std::uint64_t total_frames = 0;

    for (;;) {
        ma_uint64 frames_read = 0;
        const ma_result rc =
            ma_decoder_read_pcm_frames(&decoder, buf.data(), kChunk, &frames_read);

        const std::uint64_t chunk_start = total_frames;
        const std::uint64_t chunk_end = chunk_start + frames_read;
        const std::uint64_t selected_start =
            std::max(chunk_start, analysis_start_frame);
        const std::uint64_t selected_end =
            std::min(chunk_end, analysis_end_frame);
        if (selected_start < selected_end) {
            std::uint64_t offset = selected_start - chunk_start;
            std::uint64_t remaining = selected_end - selected_start;
            while (remaining > 0) {
                const std::uint64_t count =
                    std::min(remaining, next_hop_frame - analysis_frames);
                const float* selected = buf.data() + offset * channels;
                for (ma_uint32 c = 0; c < channels; ++c) {
                    analysis_meters[c]->push_interleaved(
                        selected, static_cast<std::size_t>(count), channels, c);
                }
                offset += count;
                remaining -= count;
                analysis_frames += count;

                if (analysis_frames != next_hop_frame) continue;
                if (hop_index >= 4) {
                    double power = 0.0;
                    for (ma_uint32 c = 0; c < channels; ++c) {
                        power += channel_gain(channel_map[c]) *
                                 static_cast<double>(
                                     analysis_meters[c]->snapshot().kw_ms);
                    }
                    loudness_blocks.push_back(power);
                }
                ++hop_index;
                next_hop_frame =
                    (hop_index * static_cast<std::uint64_t>(sample_rate) + 9) / 10;
            }
        }

        for (ma_uint64 i = 0; i < frames_read; ++i) {
            for (ma_uint32 c = 0; c < channels; ++c) {
                const float s   = buf[i * channels + c];
                const float abs = std::fabs(s);
                if (abs > acc_peak[c]) acc_peak[c] = abs;
                acc_sumsq[c] += static_cast<double>(s) * static_cast<double>(s);
            }
            if (++part_frames < sub_span) continue;

            // Close the open sub-bucket.
            for (ma_uint32 c = 0; c < channels; ++c) {
                sub_peak [c][sub_n] = acc_peak [c];
                sub_sumsq[c][sub_n] = acc_sumsq[c];
                acc_peak [c] = 0.0f;
                acc_sumsq[c] = 0.0;
            }
            part_frames = 0;
            ++sub_n;

            if (sub_n == max_subs) {
                // Grid full — halve it by merging adjacent pairs.
                const std::size_t half = max_subs / 2;
                for (ma_uint32 c = 0; c < channels; ++c) {
                    auto& pk = sub_peak[c];
                    auto& sq = sub_sumsq[c];
                    for (std::size_t k = 0; k < half; ++k) {
                        pk[k] = std::max(pk[2 * k], pk[2 * k + 1]);
                        sq[k] = sq[2 * k] + sq[2 * k + 1];
                    }
                    std::fill(pk.begin() + half, pk.end(), 0.0f);
                    std::fill(sq.begin() + half, sq.end(), 0.0);
                }
                sub_n     = half;
                sub_span *= 2;
            }
        }

        total_frames += frames_read;
        // MA_AT_END can arrive together with a short final read, so the frames
        // above are consumed before we honour the stop condition.
        if (rc != MA_SUCCESS || frames_read == 0) break;
    }

    ma_decoder_uninit(&decoder);

    if (total_frames == 0) {
        Logger::warn("compute_waveform: zero-length file '{}'", p);
        return out;
    }

    if (analysis_frames > 0) {
        const std::array<float, 12> zeros{};
        double true_peak = -120.0;
        for (auto& meter : analysis_meters) {
            meter->push_block(zeros.data(), zeros.size());
            true_peak = std::max(
                true_peak, static_cast<double>(meter->snapshot().true_peak_max_db));
        }
        out.true_peak_dbtp = true_peak;
    }
    out.integrated_lufs = integrated_loudness(loudness_blocks);

    // Flush the trailing partial sub-bucket (it covers `part_frames`, not
    // `sub_span`, frames — the fold below accounts for that).
    if (part_frames > 0) {
        for (ma_uint32 c = 0; c < channels; ++c) {
            sub_peak [c][sub_n] = acc_peak [c];
            sub_sumsq[c][sub_n] = acc_sumsq[c];
        }
    }
    const std::size_t n_subs = sub_n + (part_frames > 0 ? 1u : 0u);

    // ---- Fold the sub-bucket grid onto the requested bucket count ----------
    // Every sub-bucket covers an exact, known frame range. Overlapping the two
    // grids distributes mean-square energy in proportion to the overlap and
    // takes the peak across it. When buckets are narrower than sub-buckets
    // (very short files) each bucket simply inherits the covering sub-bucket's
    // values, so the waveform has no gaps.
    out.channels.assign(channels, WaveformChannel{});
    for (auto& c : out.channels) {
        c.peak.assign(bucket_count, 0.0f);
        c.rms .assign(bucket_count, 0.0f);
    }

    std::vector<std::vector<double>> bucket_sumsq(
        channels, std::vector<double>(bucket_count, 0.0));
    std::vector<double> bucket_frames(bucket_count, 0.0);

    const double frames_per_bucket = static_cast<double>(total_frames) /
                                     static_cast<double>(bucket_count);
    std::uint64_t sub_start = 0;
    for (std::size_t s = 0; s < n_subs; ++s) {
        const std::uint64_t len =
            (part_frames > 0 && s + 1 == n_subs) ? part_frames : sub_span;
        const double sub_lo = static_cast<double>(sub_start);
        const double sub_hi = static_cast<double>(sub_start + len);

        std::size_t b = static_cast<std::size_t>(sub_lo / frames_per_bucket);
        if (b >= bucket_count) b = bucket_count - 1;
        for (; b < bucket_count; ++b) {
            const double b_lo = static_cast<double>(b) * frames_per_bucket;
            const double b_hi = b_lo + frames_per_bucket;
            if (b_lo >= sub_hi) break;
            const double overlap = std::min(sub_hi, b_hi) - std::max(sub_lo, b_lo);
            if (overlap <= 0.0) continue;

            bucket_frames[b] += overlap;
            const double share = overlap / static_cast<double>(len);
            for (ma_uint32 c = 0; c < channels; ++c) {
                if (sub_peak[c][s] > out.channels[c].peak[b])
                    out.channels[c].peak[b] = sub_peak[c][s];
                bucket_sumsq[c][b] += sub_sumsq[c][s] * share;
            }
        }
        sub_start += len;
    }

    for (std::uint32_t b = 0; b < bucket_count; ++b) {
        const double frames = bucket_frames[b];
        for (ma_uint32 c = 0; c < channels; ++c) {
            out.channels[c].peak[b] = std::clamp(out.channels[c].peak[b], 0.0f, 1.0f);
            if (frames <= 0.0) continue;
            out.channels[c].rms[b] = std::clamp(
                static_cast<float>(std::sqrt(bucket_sumsq[c][b] / frames)), 0.0f, 1.0f);
        }
    }

    out.bucket_count    = bucket_count;
    out.sample_rate     = sample_rate;
    out.source_channels = channels;
    out.duration = std::chrono::milliseconds{
        static_cast<long long>(total_frames) * 1000LL /
        static_cast<long long>(std::max<ma_uint32>(sample_rate, 1))};
    out.ok = true;

    return out;
}

} // namespace liveplay::meta
