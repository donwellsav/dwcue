// ============================================================================
// waveform_test.cpp — standalone assertions for the waveform downsampler.
// ----------------------------------------------------------------------------
// No test framework: each check prints PASS/FAIL and the binary exits non-zero
// if anything failed. Build via the LIVEPLAY_BUILD_TESTS CMake option:
//     cmake -DLIVEPLAY_BUILD_TESTS=ON .. && cmake --build . --target liveplay-waveform-tests
//     ./liveplay-waveform-tests
//
// Covers:
//   1. Per-channel measurement  — a stereo file whose L and R differ produces
//                                 two independent traces (#47: the generator
//                                 must not collapse to the left channel)
//   2. Bucket placement         — a silence→tone envelope lands on the right
//                                 buckets, i.e. the single-pass sub-bucket fold
//                                 reproduces the old length-first behaviour (#44)
//   3. Merge path               — the same envelope at a low bucket count, which
//                                 forces repeated sub-bucket halving
//   4. Short files              — a file shorter than the bucket count leaves no
//                                 empty buckets
//   5. Metadata                 — duration / sample rate / channel count
// ============================================================================
#include "liveplay/meta/waveform.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

using namespace liveplay::meta;

namespace {

int g_failures = 0;

void check(bool ok, const char* name, double got, double expect, double tol) {
    std::printf("%-56s %s  (got %+9.4f, expect %+9.4f ±%.4f)\n",
                name, ok ? "PASS" : "FAIL", got, expect, tol);
    if (!ok) ++g_failures;
}
void check_near(const char* name, double got, double expect, double tol) {
    check(std::fabs(got - expect) <= tol, name, got, expect, tol);
}
void check_true(const char* name, bool ok) {
    std::printf("%-56s %s\n", name, ok ? "PASS" : "FAIL");
    if (!ok) ++g_failures;
}

constexpr std::uint32_t kFs = 48'000;

// ---------------------------------------------------------------------------
// Minimal 32-bit-float WAV writer so the tests need no fixture files.
// ---------------------------------------------------------------------------
void put_u32(std::ofstream& f, std::uint32_t v) {
    const unsigned char b[4]{ static_cast<unsigned char>(v),
                              static_cast<unsigned char>(v >> 8),
                              static_cast<unsigned char>(v >> 16),
                              static_cast<unsigned char>(v >> 24) };
    f.write(reinterpret_cast<const char*>(b), 4);
}
void put_u16(std::ofstream& f, std::uint16_t v) {
    const unsigned char b[2]{ static_cast<unsigned char>(v),
                              static_cast<unsigned char>(v >> 8) };
    f.write(reinterpret_cast<const char*>(b), 2);
}

bool write_wav_f32(const std::filesystem::path& path,
                   const std::vector<float>& interleaved,
                   std::uint32_t channels,
                   std::uint32_t sample_rate) {
    std::ofstream f(path, std::ios::binary);
    if (!f) return false;
    const std::uint32_t data_bytes =
        static_cast<std::uint32_t>(interleaved.size() * sizeof(float));

    f.write("RIFF", 4);
    put_u32(f, 36 + data_bytes);
    f.write("WAVE", 4);
    f.write("fmt ", 4);
    put_u32(f, 16);
    put_u16(f, 3);                                  // IEEE float
    put_u16(f, static_cast<std::uint16_t>(channels));
    put_u32(f, sample_rate);
    put_u32(f, sample_rate * channels * 4);         // byte rate
    put_u16(f, static_cast<std::uint16_t>(channels * 4));   // block align
    put_u16(f, 32);                                 // bits per sample
    f.write("data", 4);
    put_u32(f, data_bytes);
    f.write(reinterpret_cast<const char*>(interleaved.data()), data_bytes);
    return f.good();
}

// A square wave of the given amplitude: peak == RMS == amplitude, so the
// expected bucket values are exact.
std::vector<float> square(double amplitude, std::size_t frames) {
    std::vector<float> v(frames);
    for (std::size_t i = 0; i < frames; ++i)
        v[i] = static_cast<float>((i % 2 == 0) ? amplitude : -amplitude);
    return v;
}

std::vector<float> interleave(const std::vector<float>& l, const std::vector<float>& r) {
    std::vector<float> out(l.size() * 2);
    for (std::size_t i = 0; i < l.size(); ++i) { out[2 * i] = l[i]; out[2 * i + 1] = r[i]; }
    return out;
}

struct TempWav {
    std::filesystem::path path;
    explicit TempWav(const char* name)
        : path(std::filesystem::temp_directory_path() / name) {}
    ~TempWav() { std::error_code ec; std::filesystem::remove(path, ec); }
};

// ---------------------------------------------------------------------------
// 1 + 5. Both channels measured independently; metadata reported correctly.
// ---------------------------------------------------------------------------
void test_stereo_channels_are_independent() {
    const std::size_t frames = kFs * 2;                 // 2 seconds
    TempWav wav("liveplay_wf_stereo.wav");
    if (!write_wav_f32(wav.path, interleave(square(0.8, frames), square(0.2, frames)),
                       2, kFs)) {
        check_true("stereo: fixture written", false);
        return;
    }

    const auto wf = compute_waveform(wav.path, 1000);
    check_true("stereo: decode ok",                  wf.ok);
    if (!wf.ok) return;
    check_near("stereo: source channels",            wf.source_channels, 2, 0);
    check_true("stereo: two traces emitted",         wf.channels.size() == 2);
    check_near("stereo: sample rate",                wf.sample_rate, kFs, 0);
    check_near("stereo: duration (ms)",              static_cast<double>(wf.duration.count()),
                                                     2000.0, 2.0);
    check_near("stereo: bucket count",               wf.bucket_count, 1000, 0);
    if (wf.channels.size() < 2) return;

    // The right channel must NOT read as a copy of the left — that was the bug.
    check_near("stereo: L peak  (mid-file bucket)",  wf.channels[0].peak[500], 0.8, 0.01);
    check_near("stereo: R peak  (mid-file bucket)",  wf.channels[1].peak[500], 0.2, 0.01);
    check_near("stereo: L rms   (mid-file bucket)",  wf.channels[0].rms [500], 0.8, 0.01);
    check_near("stereo: R rms   (mid-file bucket)",  wf.channels[1].rms [500], 0.2, 0.01);

    double l_max = 0.0, r_max = 0.0;
    for (std::uint32_t b = 0; b < wf.bucket_count; ++b) {
        l_max = std::max<double>(l_max, wf.channels[0].peak[b]);
        r_max = std::max<double>(r_max, wf.channels[1].peak[b]);
    }
    check_near("stereo: L peak never exceeds source", l_max, 0.8, 0.01);
    check_near("stereo: R peak never exceeds source", r_max, 0.2, 0.01);
}

// ---------------------------------------------------------------------------
// 2 + 3. Envelope placement, at a high and a low bucket count.
// ---------------------------------------------------------------------------
void test_envelope_placement(std::uint32_t buckets) {
    const std::size_t frames = kFs * 4;                 // 4 seconds
    std::vector<float> mono = square(0.6, frames);
    for (std::size_t i = 0; i < frames / 2; ++i) mono[i] = 0.0f;   // first half silent

    char name[64];
    std::snprintf(name, sizeof(name), "liveplay_wf_env_%u.wav", buckets);
    TempWav wav(name);
    if (!write_wav_f32(wav.path, mono, 1, kFs)) {
        check_true("envelope: fixture written", false);
        return;
    }

    const auto wf = compute_waveform(wav.path, buckets);
    char label[96];
    std::snprintf(label, sizeof(label), "envelope@%u: decode ok", buckets);
    check_true(label, wf.ok && wf.channels.size() == 1);
    if (!wf.ok || wf.channels.empty()) return;

    const auto& ch = wf.channels[0];
    // Stay a couple of buckets clear of the midpoint: the bucket straddling the
    // transition legitimately holds a partial value.
    const std::uint32_t before = buckets / 2 - 2;
    const std::uint32_t after  = buckets / 2 + 2;
    std::snprintf(label, sizeof(label), "envelope@%u: silent half is silent", buckets);
    check_near(label, ch.peak[before], 0.0, 1e-6);
    std::snprintf(label, sizeof(label), "envelope@%u: tone half reads 0.6", buckets);
    check_near(label, ch.peak[after], 0.6, 0.01);
    std::snprintf(label, sizeof(label), "envelope@%u: last bucket reads 0.6", buckets);
    check_near(label, ch.peak[buckets - 1], 0.6, 0.01);
    std::snprintf(label, sizeof(label), "envelope@%u: rms tracks peak", buckets);
    check_near(label, ch.rms[after], 0.6, 0.01);
}

// ---------------------------------------------------------------------------
// 4. A file with fewer frames than buckets must still fill every bucket.
// ---------------------------------------------------------------------------
void test_short_file_has_no_gaps() {
    const std::size_t frames = 600;                     // 12.5 ms
    TempWav wav("liveplay_wf_short.wav");
    if (!write_wav_f32(wav.path, square(0.5, frames), 1, kFs)) {
        check_true("short: fixture written", false);
        return;
    }

    const auto wf = compute_waveform(wav.path, 1000);   // more buckets than frames
    check_true("short: decode ok", wf.ok && wf.channels.size() == 1);
    if (!wf.ok || wf.channels.empty()) return;

    std::uint32_t empty = 0;
    for (std::uint32_t b = 0; b < wf.bucket_count; ++b)
        if (wf.channels[0].peak[b] <= 0.0f) ++empty;
    check_near("short: no empty buckets", empty, 0.0, 0.0);
    check_near("short: peak amplitude",   wf.channels[0].peak[500], 0.5, 0.01);
}

} // namespace

int main() {
    std::printf("== waveform ==\n");
    test_stereo_channels_are_independent();
    test_envelope_placement(1000);
    test_envelope_placement(16);      // forces repeated sub-bucket merging
    test_short_file_has_no_gaps();

    std::printf("\n%s (%d failure%s)\n", g_failures == 0 ? "ALL PASS" : "FAILURES",
                g_failures, g_failures == 1 ? "" : "s");
    return g_failures == 0 ? 0 : 1;
}
