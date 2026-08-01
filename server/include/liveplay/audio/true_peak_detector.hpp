// ITU-R BS.1770 4× true-peak detector shared by meters and limiters.
#pragma once

#include "liveplay/audio/types.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>

namespace liveplay::audio {

class TruePeakDetector {
public:
    // FIR group delay, rounded up to input samples. A lookahead limiter needs
    // at least this much delay to act before the detected waveform is output.
    static constexpr std::size_t kLatencySamples = 6;

    // Push one sample and return the largest magnitude across four
    // interpolated samples.
    float process(Sample sample) noexcept {
        history_[history_pos_] = sample;
        float max_abs = 0.0f;
        for (std::size_t phase = 0; phase < kPhases; ++phase) {
            float interpolated = 0.0f;
            std::size_t index = history_pos_;
            for (std::size_t tap = 0; tap < kTapsPerPhase; ++tap) {
                interpolated += kFilterTaps[tap * kPhases + phase] * history_[index];
                index = index == 0 ? kTapsPerPhase - 1 : index - 1;
            }
            max_abs = std::max(max_abs, std::fabs(interpolated));
        }
        history_pos_ = (history_pos_ + 1) % kTapsPerPhase;
        return max_abs;
    }

    void reset() noexcept {
        history_.fill(0.0f);
        history_pos_ = 0;
    }

private:
    static constexpr std::size_t kTapsPerPhase = 12;
    static constexpr std::size_t kPhases = 4;

    // ITU-R BS.1770-5 Annex 2, order-48 4-phase FIR interpolator. Stored
    // row-major (12 taps × 4 phases) to match process().
    static constexpr std::array<float, 48> kFilterTaps{
         0.0017089843750f, -0.0291748046875f, -0.0189208984375f, -0.0083007812500f,
         0.0109863281250f,  0.0292968750000f,  0.0330810546875f,  0.0148925781250f,
        -0.0196533203125f, -0.0517578125000f, -0.0582275390625f, -0.0266113281250f,
         0.0332031250000f,  0.0891113281250f,  0.1015625000000f,  0.0476074218750f,
        -0.0594482421875f, -0.1665039062500f, -0.2003173828125f, -0.1022949218750f,
         0.1373291015625f,  0.4650878906250f,  0.7797851562500f,  0.9721679687500f,
         0.9721679687500f,  0.7797851562500f,  0.4650878906250f,  0.1373291015625f,
        -0.1022949218750f, -0.2003173828125f, -0.1665039062500f, -0.0594482421875f,
         0.0476074218750f,  0.1015625000000f,  0.0891113281250f,  0.0332031250000f,
        -0.0266113281250f, -0.0582275390625f, -0.0517578125000f, -0.0196533203125f,
         0.0148925781250f,  0.0330810546875f,  0.0292968750000f,  0.0109863281250f,
        -0.0083007812500f, -0.0189208984375f, -0.0291748046875f,  0.0017089843750f,
    };

    std::array<float, kTapsPerPhase> history_{};
    std::size_t history_pos_ = 0;
};

} // namespace liveplay::audio
