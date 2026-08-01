// ============================================================================
// liveplay/audio/limiter.hpp
// ----------------------------------------------------------------------------
// True-peak lookahead limiter living on every Master output channel. Uses the
// same ITU-R BS.1770 4× detector as the output meter to keep the reconstructed
// waveform below a configurable ceiling (typically -0.1 dBTP) — replacing the
// legacy "reduce every cue's
// level just-in-case" hack that DonWells Cue 1.x used.
//
// Design:
//   * Lookahead buffer of L samples (default ~5 ms). The detector sees future
//     peaks before the delayed signal is output.
//   * Attack snaps to the required gain; lookahead ensures the corresponding
//     reconstructed peak has not reached the output yet.
//   * Release: configurable one-pole release on gain reduction.
//   * A small detector guard absorbs intersample growth introduced by the
//     gain envelope itself; pathological NaN/Inf inputs become silence.
//
// Per-channel: one independent instance per master output channel.
// ============================================================================
#pragma once

#include "liveplay/audio/true_peak_detector.hpp"
#include "liveplay/audio/types.hpp"

#include <atomic>
#include <cstddef>
#include <memory>
#include <vector>

namespace liveplay::audio {

class Limiter {
public:
    Limiter();
    ~Limiter();

    // Configure / reconfigure. Call from control thread while paused, or
    // before start. Reallocates the lookahead ring.
    //   ceiling_db    : true-peak ceiling (must be ≤ 0). Default -0.1 dBTP.
    //   lookahead_ms  : detector lookahead (samples buffered). Default 5 ms.
    //   release_ms    : time constant for gain-reduction release.
    void configure(SampleRate sample_rate,
                   float ceiling_db   = -0.1f,
                   float lookahead_ms = 5.0f,
                   float release_ms   = 50.0f);

    // Change only the ceiling. Safe from the control thread while audio is
    // running; the lookahead/detector state and latency are preserved.
    void set_ceiling_db(float ceiling_db) noexcept;

    // Process one mono buffer in-place. Real-time safe (no allocations).
    // Bypass keeps the detector and delay line moving, preserving latency.
    void process(Sample* samples, std::size_t frame_count,
                 bool enabled = true) noexcept;

    // Current gain reduction in dB, suitable for a UI meter (control thread).
    float gain_reduction_db() const noexcept {
        return gain_reduction_db_.load(std::memory_order_relaxed);
    }

    // Drain the lookahead buffer to silence (e.g. after a stop-all). Audio
    // thread; constant time.
    void reset() noexcept;

private:
    SampleRate sample_rate_   = kDefaultMixSampleRate;
    std::atomic<float> ceiling_lin_{1.0f};
    float      release_coef_  = 0.0f;
    std::size_t lookahead_    = 0;

    // Sliding maximum of the true-peak detector output.
    TruePeakDetector  true_peak_detector_{};
    std::vector<float> peak_window_;       // size = lookahead_
    std::size_t        peak_window_pos_ = 0;
    std::size_t        peak_window_max_idx_ = 0;
    float              peak_window_max_val_ = 0.0f;

    // Delay line (matches lookahead so detected peaks line up with samples).
    std::vector<Sample> delay_;
    std::size_t         delay_pos_ = 0;

    // Current gain (linear). Audio-thread state.
    float current_gain_ = 1.0f;

    // Published UI value.
    std::atomic<float> gain_reduction_db_{0.0f};

    // Recompute window max after the leaving sample turned out to be the max.
    void recompute_window_max() noexcept;
};

} // namespace liveplay::audio
