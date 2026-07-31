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
//   6. BS.1770 analysis         — integrated gating, silence, range selection,
//                                 bucket independence, and intersample true peak
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
constexpr double kPi = 3.14159265358979323846;

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

std::vector<float> sine(double frequency, double amplitude, std::size_t frames,
                        double phase = 0.0) {
    std::vector<float> v(frames);
    for (std::size_t i = 0; i < frames; ++i) {
        v[i] = static_cast<float>(
            amplitude * std::sin(2.0 * kPi * frequency * i / kFs + phase));
    }
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

// ---------------------------------------------------------------------------
// 6. Standards analysis is independent of the display bucket grid.
// ---------------------------------------------------------------------------
void test_integrated_loudness_and_bucket_independence() {
    const double amplitude = std::pow(10.0, -23.0 / 20.0);
    const auto channel = sine(997.0, amplitude, kFs * 4);
    TempWav wav("liveplay_wf_loudness.wav");
    if (!write_wav_f32(wav.path, interleave(channel, channel), 2, kFs)) {
        check_true("loudness: fixture written", false);
        return;
    }

    const auto coarse = compute_waveform(wav.path, 16);
    const auto fine = compute_waveform(wav.path, 1000);
    check_true("loudness: both bucket grids decode",
               coarse.ok && fine.ok);
    check_true("loudness: integrated values present",
               coarse.integrated_lufs && fine.integrated_lufs);
    check_true("loudness: true-peak values present",
               coarse.true_peak_dbtp && fine.true_peak_dbtp);
    if (!coarse.integrated_lufs || !fine.integrated_lufs ||
        !coarse.true_peak_dbtp || !fine.true_peak_dbtp) return;

    check_near("loudness: 997 Hz stereo @ -23 dBFS",
               *coarse.integrated_lufs, -23.0, 0.15);
    check_near("loudness: integrated result ignores bucket count",
               *coarse.integrated_lufs, *fine.integrated_lufs, 1e-6);
    check_near("loudness: true peak ignores bucket count",
               *coarse.true_peak_dbtp, *fine.true_peak_dbtp, 1e-6);
}

void test_gating_silence_and_range() {
    const double amplitude = std::pow(10.0, -23.0 / 20.0);
    auto channel = sine(997.0, amplitude, kFs * 8);
    std::fill(channel.begin() + kFs * 4, channel.end(), 0.0f);
    TempWav wav("liveplay_wf_gating.wav");
    if (!write_wav_f32(wav.path, interleave(channel, channel), 2, kFs)) {
        check_true("gating: fixture written", false);
        return;
    }

    const auto full = compute_waveform(wav.path, 64);
    check_true("gating: integrated result present", full.integrated_lufs.has_value());
    if (full.integrated_lufs) {
        check_near("gating: trailing silence excluded",
                   *full.integrated_lufs, -23.0, 0.35);
    }

    const auto tone = compute_waveform(
        wav.path, 64, std::chrono::milliseconds{0}, std::chrono::milliseconds{4000});
    const auto silence = compute_waveform(
        wav.path, 64, std::chrono::milliseconds{4000}, std::chrono::milliseconds{8000});
    check_true("range: tone loudness present", tone.integrated_lufs.has_value());
    if (tone.integrated_lufs)
        check_near("range: tone uses requested in/out",
                   *tone.integrated_lufs, -23.0, 0.15);
    check_true("range: silence is below absolute gate",
               !silence.integrated_lufs.has_value());
    check_true("range: silence true peak still valid",
               silence.true_peak_dbtp.has_value());
    if (silence.true_peak_dbtp)
        check_near("range: silence true peak floor",
                   *silence.true_peak_dbtp, -120.0, 0.001);
}

void test_relative_gate() {
    const double loud_amplitude = std::pow(10.0, -23.0 / 20.0);
    const double quiet_scale = std::pow(10.0, (-45.0 + 23.0) / 20.0);
    auto channel = sine(997.0, loud_amplitude, kFs * 8);
    for (auto it = channel.begin() + kFs * 4; it != channel.end(); ++it)
        *it = static_cast<float>(*it * quiet_scale);

    TempWav wav("liveplay_wf_relative_gate.wav");
    if (!write_wav_f32(wav.path, interleave(channel, channel), 2, kFs)) {
        check_true("relative gate: fixture written", false);
        return;
    }

    const auto wf = compute_waveform(wav.path, 64);
    check_true("relative gate: integrated result present",
               wf.integrated_lufs.has_value());
    if (wf.integrated_lufs) {
        check_near("relative gate: -45 LUFS section excluded",
                   *wf.integrated_lufs, -23.0, 0.35);
    }
}

void test_true_peak() {
    const auto channel = sine(kFs / 4.0, 1.0, kFs * 2, kPi / 4.0);
    TempWav wav("liveplay_wf_true_peak.wav");
    if (!write_wav_f32(wav.path, interleave(channel, channel), 2, kFs)) {
        check_true("true peak: fixture written", false);
        return;
    }

    const auto wf = compute_waveform(wav.path, 100);
    check_true("true peak: analysis present", wf.true_peak_dbtp.has_value());
    if (!wf.true_peak_dbtp || wf.channels.empty()) return;
    check_near("true peak: sample buckets see -3.01 dBFS",
               20.0 * std::log10(wf.channels[0].peak[50]), -3.01, 0.1);
    check_near("true peak: BS.1770 FIR reference",
               *wf.true_peak_dbtp, 0.083, 0.01);
}

} // namespace

int main() {
    std::printf("== waveform ==\n");
    test_stereo_channels_are_independent();
    test_envelope_placement(1000);
    test_envelope_placement(16);      // forces repeated sub-bucket merging
    test_short_file_has_no_gaps();
    test_integrated_loudness_and_bucket_independence();
    test_gating_silence_and_range();
    test_relative_gate();
    test_true_peak();

    std::printf("\n%s (%d failure%s)\n", g_failures == 0 ? "ALL PASS" : "FAILURES",
                g_failures, g_failures == 1 ? "" : "s");
    return g_failures == 0 ? 0 : 1;
}
