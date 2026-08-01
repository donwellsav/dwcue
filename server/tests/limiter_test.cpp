// Framework-free checks for live limiter control changes.
#include "liveplay/audio/limiter.hpp"
#include "liveplay/audio/true_peak_detector.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <vector>

using liveplay::audio::Limiter;
using liveplay::audio::Sample;
using liveplay::audio::TruePeakDetector;

namespace {
int failures = 0;

void check(bool ok, const char* name) {
    std::printf("%-58s %s\n", name, ok ? "PASS" : "FAIL");
    if (!ok) ++failures;
}

void test_live_ceiling_preserves_delay() {
    Limiter limiter;
    limiter.configure(1'000, 0.0f, 5.0f, 50.0f);

    Sample first[] = {0.25f, 0.5f, 0.75f};
    limiter.process(first, 3);
    limiter.set_ceiling_db(-6.0f);
    std::vector<Sample> tail(16, 0.0f);
    limiter.process(tail.data(), tail.size());

    float peak = 0.0f;
    for (const auto sample : tail) peak = std::max(peak, std::fabs(sample));
    check(peak > 0.01f,
          "live ceiling change keeps queued lookahead audio");
    check(peak <= std::pow(10.0f, -6.0f / 20.0f) + 1e-5f,
          "live ceiling change applies without reconfiguration");
}

void test_bypass_preserves_latency_and_detector() {
    Limiter limiter;
    Limiter reference;
    limiter.configure(1'000, 0.0f, 5.0f, 50.0f);
    reference.configure(1'000, 0.0f, 5.0f, 50.0f);

    Sample first[] = {0.1f, 0.2f, 0.3f};
    Sample first_ref[] = {0.1f, 0.2f, 0.3f};
    limiter.process(first, 3, false);
    reference.process(first_ref, 3, true);
    Sample enabled[] = {0.0f, 0.0f, 0.0f};
    Sample enabled_ref[] = {0.0f, 0.0f, 0.0f};
    limiter.process(enabled, 3, true);
    reference.process(enabled_ref, 3, true);
    Sample bypassed[] = {0.0f, 0.0f, 0.0f};
    Sample bypassed_ref[] = {0.0f, 0.0f, 0.0f};
    limiter.process(bypassed, 3, false);
    reference.process(bypassed_ref, 3, true);

    bool same = true;
    for (std::size_t i = 0; i < 3; ++i) {
        same = same && std::fabs(first[i] - first_ref[i]) < 1e-6f;
        same = same && std::fabs(enabled[i] - enabled_ref[i]) < 1e-6f;
        same = same && std::fabs(bypassed[i] - bypassed_ref[i]) < 1e-6f;
    }
    check(same, "bypass transitions preserve the configured latency");

    Limiter hot;
    hot.configure(1'000, -6.0f, 6.0f, 50.0f);
    Sample over[] = {0.25f, 0.25f, 2.0f, 0.25f, 0.25f, 0.25f};
    hot.process(over, 6, false);
    check(hot.gain_reduction_db() == 0.0f,
          "gain-reduction readout is zero while bypassed");
    Sample release[] = {0.0f, 0.0f, 0.0f};
    hot.process(release, 3, true);
    check(std::fabs(release[2]) <= std::pow(10.0f, -6.0f / 20.0f) + 1e-5f,
          "detector keeps tracking while bypassed");
}

void test_limits_intersample_true_peak() {
    constexpr float pi = 3.14159265358979323846f;
    constexpr float ceiling_db = -1.0f;
    constexpr float ceiling = 0.89125094f;
    constexpr std::size_t frames = 4'800;

    std::vector<Sample> audio(frames + 512, 0.0f);
    for (std::size_t i = 0; i < frames; ++i) {
        // 12 kHz at 48 kHz, 45° phase: sample peaks are -3.01 dBFS while
        // the reconstructed waveform reaches approximately 0 dBTP.
        audio[i] = std::sin(0.5f * pi * static_cast<float>(i) + 0.25f * pi);
    }

    Limiter limiter;
    limiter.configure(48'000, ceiling_db, 5.0f, 50.0f);
    limiter.process(audio.data(), audio.size());

    TruePeakDetector detector;
    float output_true_peak = 0.0f;
    for (const auto sample : audio) {
        output_true_peak = std::max(output_true_peak, detector.process(sample));
    }
    check(output_true_peak <= ceiling + 1e-4f,
          "intersample true peak stays below the dBTP ceiling");
}

void test_gain_envelope_cannot_create_true_peak_overs() {
    constexpr float ceiling = 0.89125094f; // -1 dBTP
    std::vector<Sample> audio(1'024, 0.0f);
    std::uint32_t random = 742'347;
    for (std::size_t i = 0; i < 512; ++i) {
        random ^= random << 13;
        random ^= random >> 17;
        random ^= random << 5;
        audio[i] = static_cast<float>(random >> 8) *
                   (4.0f / 16'777'216.0f) - 2.0f;
    }

    Limiter limiter;
    limiter.configure(48'000, -1.0f, 5.0f, 50.0f);
    limiter.process(audio.data(), audio.size());

    TruePeakDetector detector;
    float output_true_peak = 0.0f;
    for (const auto value : audio) {
        output_true_peak = std::max(output_true_peak, detector.process(value));
    }
    check(output_true_peak <= ceiling + 1e-4f,
          "gain envelope cannot create a true-peak overshoot");
}
} // namespace

int main() {
    test_live_ceiling_preserves_delay();
    test_bypass_preserves_latency_and_detector();
    test_limits_intersample_true_peak();
    test_gain_envelope_cannot_create_true_peak_overs();
    std::printf("%s (%d failure%s)\n",
                failures == 0 ? "ALL TESTS PASSED" : "TESTS FAILED",
                failures, failures == 1 ? "" : "s");
    return failures == 0 ? 0 : 1;
}
