// Framework-free checks for live limiter control changes.
#include "liveplay/audio/limiter.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <vector>

using liveplay::audio::Limiter;
using liveplay::audio::Sample;

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
    hot.configure(1'000, -6.0f, 4.5f, 50.0f); // exactly five samples
    Sample over[] = {0.25f, 0.25f, 2.0f, 0.25f, 0.25f};
    hot.process(over, 5, false);
    check(hot.gain_reduction_db() == 0.0f,
          "gain-reduction readout is zero while bypassed");
    Sample release[] = {0.25f};
    hot.process(release, 1, true);
    check(std::fabs(release[0]) < 0.1f,
          "detector keeps tracking while bypassed");
}
} // namespace

int main() {
    test_live_ceiling_preserves_delay();
    test_bypass_preserves_latency_and_detector();
    std::printf("%s (%d failure%s)\n",
                failures == 0 ? "ALL TESTS PASSED" : "TESTS FAILED",
                failures, failures == 1 ? "" : "s");
    return failures == 0 ? 0 : 1;
}
