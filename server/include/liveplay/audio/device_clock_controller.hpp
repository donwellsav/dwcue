// Continuous ring-occupancy controller for independent hardware clocks.
#pragma once

#include <algorithm>
#include <cstdint>

namespace liveplay::audio {

class DeviceClockController {
public:
    void configure(std::uint32_t capacity_frames,
                   std::uint32_t target_frames) noexcept {
        capacity_frames_ = std::max<std::uint32_t>(1, capacity_frames);
        target_frames_ = std::min(target_frames, capacity_frames_);
        reset();
    }

    void reset() noexcept {
        integrator_ = 0.0;
        ratio_ = 1.0;
        limited_ = false;
    }

    // Ratio is input frames / output frames. A fast hardware clock drains the
    // ring, producing a negative error and a ratio below 1; a slow clock gets
    // a ratio above 1. The ±0.5% bound is well beyond normal oscillator error
    // but prevents a bad device/state transition from creating an audible
    // runaway pitch shift.
    double update(std::uint32_t occupancy_frames) noexcept {
        const double error =
            (static_cast<double>(occupancy_frames) - target_frames_) /
            static_cast<double>(capacity_frames_);
        integrator_ = std::clamp(
            integrator_ + kIntegralGain * error,
            -kMaxCorrection, kMaxCorrection);
        const double raw = 1.0 + kProportionalGain * error + integrator_;
        const double desired = std::clamp(
            raw, 1.0 - kMaxCorrection, 1.0 + kMaxCorrection);
        limited_ = desired != raw;
        ratio_ += kSmoothing * (desired - ratio_);
        return ratio_;
    }

    double ratio() const noexcept { return ratio_; }
    double correction_ppm() const noexcept { return (ratio_ - 1.0) * 1'000'000.0; }
    bool limited() const noexcept { return limited_; }
    std::uint32_t target_frames() const noexcept { return target_frames_; }

    static constexpr double max_correction_ppm() noexcept {
        return kMaxCorrection * 1'000'000.0;
    }

private:
    static constexpr double kProportionalGain = 0.010;
    static constexpr double kIntegralGain     = 0.0001;
    static constexpr double kSmoothing        = 0.20;
    // ponytail: ±0.5% covers real hardware-clock drift. A source outside that
    // ceiling needs the engine's explicit hard re-lock path, not a wider and
    // increasingly audible pitch correction.
    static constexpr double kMaxCorrection    = 0.005;

    std::uint32_t capacity_frames_ = 1;
    std::uint32_t target_frames_ = 1;
    double integrator_ = 0.0;
    double ratio_ = 1.0;
    bool limited_ = false;
};

} // namespace liveplay::audio
