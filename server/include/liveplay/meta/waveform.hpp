// ============================================================================
// liveplay/meta/waveform.hpp
// ----------------------------------------------------------------------------
// Headless waveform downsampler. Decodes a file (via miniaudio) exactly ONCE,
// takes abs-peak + RMS per "bucket", and emits exactly N (default 1000) sample
// pairs covering the file's full duration. The client renders these as a
// canvas/SVG waveform with no audio decoder of its own.
//
// Every channel of the source is measured independently, so a stereo file
// yields separate L/R peak+RMS arrays (the renderer decides whether to draw
// them as lanes or combine them).
//
// The decode never probes the file length first: for formats without a frame
// count in a header (notably MP3) miniaudio answers that by decoding the whole
// file, which used to double the cost of every waveform. See the comment in
// compute_waveform() for how bucket boundaries are resolved instead.
//
// Output format is intentionally tiny: two float arrays per channel, plus
// channel layout + duration metadata. The control server JSON-encodes this
// directly.
// ============================================================================
#pragma once

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <vector>

namespace liveplay::meta {

struct WaveformChannel {
    std::vector<float> peak;        // |max(|sample|)| per bucket, in [0, 1]
    std::vector<float> rms;         // sqrt(mean(sample^2))     per bucket, in [0, 1]
};

struct Waveform {
    std::vector<WaveformChannel> channels;   // size = audio channel count
    std::uint32_t                bucket_count = 0;
    std::chrono::milliseconds    duration{0};
    std::uint32_t                sample_rate  = 0;
    std::uint32_t                source_channels = 0;
    bool                         ok = false;
};

// Decode `path` and produce `bucket_count` waveform buckets. `bucket_count`
// is clamped to [16, 16384]. Real-time-irrelevant — runs on a worker thread.
Waveform compute_waveform(const std::filesystem::path& path,
                          std::uint32_t bucket_count = 1000) noexcept;

} // namespace liveplay::meta
