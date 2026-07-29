// ============================================================================
// waveform.cpp — see waveform.hpp.
// ============================================================================
#include "liveplay/meta/waveform.hpp"
#include "liveplay/audio/decoder.hpp"
#include "liveplay/logger.hpp"
#include "liveplay/util/unicode_path.hpp"

#include <miniaudio.h>

#include <algorithm>
#include <cmath>
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

} // namespace

Waveform compute_waveform(const std::filesystem::path& path,
                          std::uint32_t bucket_count) noexcept {
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
