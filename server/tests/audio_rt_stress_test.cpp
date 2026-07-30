// Bounded read-ahead and render-thread stress checks. No test framework.
#include "liveplay/audio/device_clock_controller.hpp"
#include "liveplay/audio/playback_item.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <thread>
#include <vector>

using namespace liveplay::audio;

namespace {

constexpr SampleRate kRate = 48'000;
constexpr FrameCount kBlock = 256;
int failures = 0;

void check(bool ok, const char* name) {
    std::printf("%-58s %s\n", name, ok ? "PASS" : "FAIL");
    if (!ok) ++failures;
}

void write_u16(std::ofstream& out, std::uint16_t value) {
    const char bytes[] = {
        static_cast<char>(value & 0xff),
        static_cast<char>((value >> 8) & 0xff),
    };
    out.write(bytes, sizeof(bytes));
}

void write_u32(std::ofstream& out, std::uint32_t value) {
    const char bytes[] = {
        static_cast<char>(value & 0xff),
        static_cast<char>((value >> 8) & 0xff),
        static_cast<char>((value >> 16) & 0xff),
        static_cast<char>((value >> 24) & 0xff),
    };
    out.write(bytes, sizeof(bytes));
}

std::filesystem::path make_wav() {
    const auto path =
        std::filesystem::temp_directory_path() / "dwcue-audio-rt-stress.wav";
    constexpr std::uint16_t channels = 2;
    constexpr std::uint16_t bits = 16;
    constexpr std::uint32_t frames = kRate * 3;
    constexpr std::uint32_t data_bytes = frames * channels * (bits / 8);

    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    out.write("RIFF", 4);
    write_u32(out, 36 + data_bytes);
    out.write("WAVEfmt ", 8);
    write_u32(out, 16);
    write_u16(out, 1);
    write_u16(out, channels);
    write_u32(out, kRate);
    write_u32(out, kRate * channels * (bits / 8));
    write_u16(out, channels * (bits / 8));
    write_u16(out, bits);
    out.write("data", 4);
    write_u32(out, data_bytes);
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        const auto sample = static_cast<std::int16_t>(
            std::sin(2.0 * 3.14159265358979323846 * 997.0 * frame / kRate) *
            20'000.0);
        write_u16(out, static_cast<std::uint16_t>(sample));
        write_u16(out, static_cast<std::uint16_t>(sample));
    }
    return path;
}

struct Output {
    std::vector<Sample> left = std::vector<Sample>(kBlock);
    std::vector<Sample> right = std::vector<Sample>(kBlock);
    Sample* channels[2] = {left.data(), right.data()};
};

void test_bounded_prefill_and_recovery(PlaybackItem& item) {
    check(item.prime(2.0, 0.0), "prefill: prime succeeds");
    const auto prefetched = item.stats().read_ahead_blocks;
    check(prefetched == 16, "prefill: queue is bounded at 16 blocks");

    item.play();
    Output output;
    bool all_audio = true;
    for (std::uint32_t i = 0; i < prefetched; ++i) {
        all_audio &= item.render_block(output.channels, 2, kBlock) == kBlock;
    }
    check(all_audio, "prefill: every queued block renders");

    const auto before = item.stats().read_ahead_underruns;
    check(item.render_block(output.channels, 2, kBlock) == 0,
          "underrun: empty queue emits silence");
    const auto starved = item.stats().read_ahead_underruns;
    check(starved == before + 1, "underrun: starvation increments once");

    check(item.service_read_ahead(1), "recovery: shared-worker call refills");
    check(item.render_block(output.channels, 2, kBlock) == kBlock,
          "recovery: next block returns audio");
    check(item.stats().read_ahead_underruns == starved,
          "recovery: counter stays stable after refill");

    std::printf("MEASURE prefilled=%u forced_underruns=%llu recovered_frames=%llu\n",
                prefetched,
                static_cast<unsigned long long>(starved - before),
                static_cast<unsigned long long>(kBlock));
}

void test_soft_out_point_fade(PlaybackItem& item) {
    item.stop_now();
    item.set_loop(false);
    item.set_out_point_seconds(1'024.0 / kRate);
    item.set_fade_out(std::chrono::milliseconds{20});
    check(item.prime(2.0, 0.0), "natural fade: bounded prefill succeeds");
    item.play();

    Output output;
    for (int i = 0;
         i < 32 && item.stats().transport != TransportState::Stopped;
         ++i) {
        item.service_read_ahead(1);
        item.render_block(output.channels, 2, kBlock);
    }
    const auto after = item.stats();
    check(after.transport == TransportState::Stopped,
          "natural fade: soft out-point settles to Stopped");
    check(after.playhead_frame > 1'024,
          "natural fade: decoded tail carries the fade");
    check(item.take_natural_end(),
          "natural fade: completion raises one follow edge");
    check(!item.take_natural_end(),
          "natural fade: follow edge is one-shot");
}

void test_loop_and_concurrent_stress(PlaybackItem& item) {
    item.stop_now();
    item.set_fade_out(std::chrono::milliseconds{0});
    item.set_out_point_seconds(768.0 / kRate);
    item.set_loop(true, 256.0 / kRate);
    check(item.prime(2.0, 0.0), "loop: bounded prefill succeeds");
    item.play();

    Output output;
    bool seamless = true;
    for (int i = 0; i < 200; ++i) {
        item.service_read_ahead(1);
        seamless &= item.render_block(output.channels, 2, kBlock) == kBlock;
    }
    const auto loop_stats = item.stats();
    check(seamless, "loop: 200 boundary-crossing blocks stay full");
    check(loop_stats.transport == TransportState::Playing,
          "loop: transport never reports Stopped");
    check(!item.take_natural_end(), "loop: no false natural-end edge");

    const auto underruns_before = loop_stats.read_ahead_underruns;
    std::atomic<bool> run_worker{true};
    std::atomic<std::uint64_t> rendered{0};
    std::atomic<std::uint64_t> invalid{0};
    std::atomic<std::uint64_t> meter_reads{0};

    std::thread producer([&] {
        while (run_worker.load(std::memory_order_acquire)) {
            if (!item.service_read_ahead(1)) std::this_thread::yield();
        }
    });
    std::thread consumer([&] {
        Output threaded_output;
        while (run_worker.load(std::memory_order_acquire)) {
            const auto got =
                item.render_block(threaded_output.channels, 2, kBlock);
            if (got != 0 && got != kBlock) invalid.fetch_add(1);
            if (got == kBlock) rendered.fetch_add(1);
            if (got == 0) {
                std::this_thread::sleep_for(std::chrono::microseconds{10});
            }
        }
    });
    std::thread meter_reader([&] {
        while (run_worker.load(std::memory_order_acquire)) {
            const auto channels = item.source_channel_count();
            for (ChannelIndex channel = 0; channel < channels; ++channel) {
                item.source_meter_consume(channel);
                meter_reads.fetch_add(1, std::memory_order_relaxed);
            }
        }
    });

    constexpr std::uint64_t seeks = 1'000;
    for (std::uint64_t i = 0; i < seeks; ++i) {
        item.seek_seconds((256.0 + (i % 2) * 256.0) / kRate);
        item.set_ltc_enabled((i & 1u) != 0);
        std::this_thread::yield();
    }
    run_worker.store(false, std::memory_order_release);
    meter_reader.join();
    consumer.join();
    producer.join();

    const auto after = item.stats();
    check(invalid.load() == 0, "stress: render returns only full blocks or silence");
    check(after.transport == TransportState::Playing,
          "stress: concurrent refill/seek leaves transport playing");
    check(!item.had_decode_error(), "stress: no decoder failure");
    check(!item.take_natural_end(), "stress: no false follow edge");
    check(meter_reads.load() > 0,
          "stress: meter reads survive concurrent LTC resize");

    std::printf(
        "MEASURE stress_rendered=%llu stress_underruns=%llu concurrent_seeks=%llu\n",
        static_cast<unsigned long long>(rendered.load()),
        static_cast<unsigned long long>(
            after.read_ahead_underruns - underruns_before),
        static_cast<unsigned long long>(seeks));
}

struct ClockSimulation {
    double correction_ppm = 0.0;
    double min_occupancy = 0.0;
    double max_occupancy = 0.0;
};

ClockSimulation simulate_clock_drift(double hardware_drift_ppm) {
    constexpr std::uint32_t capacity = kBlock * 4;
    constexpr std::uint32_t target = kBlock * 3;
    constexpr double seconds = 30.0 * 60.0;
    const double hardware_rate =
        1.0 + hardware_drift_ppm / 1'000'000.0;
    const auto callback_count = static_cast<std::uint64_t>(
        seconds * kRate * hardware_rate / kBlock);

    DeviceClockController controller;
    controller.configure(capacity, target);
    double occupancy = target;
    double minimum = occupancy;
    double maximum = occupancy;
    for (std::uint64_t i = 0; i < callback_count; ++i) {
        const auto observed = static_cast<std::uint32_t>(std::lround(
            std::clamp(occupancy, 0.0, static_cast<double>(capacity))));
        const double input_per_output = controller.update(observed);

        // The primary clock contributes this many timeline frames during one
        // callback period of the independently drifting secondary device.
        occupancy +=
            static_cast<double>(kBlock) / hardware_rate -
            static_cast<double>(kBlock) * input_per_output;
        minimum = std::min(minimum, occupancy);
        maximum = std::max(maximum, occupancy);
    }
    return {controller.correction_ppm(), minimum, maximum};
}

void test_continuous_clock_correction() {
    const auto fast = simulate_clock_drift(3'000.0);
    const auto slow = simulate_clock_drift(-3'000.0);
    const double fast_expected =
        (1.0 / 1.003 - 1.0) * 1'000'000.0;
    const double slow_expected =
        (1.0 / 0.997 - 1.0) * 1'000'000.0;

    check(std::abs(fast.correction_ppm - fast_expected) < 25.0,
          "clock: +3000 ppm device converges continuously");
    check(std::abs(slow.correction_ppm - slow_expected) < 25.0,
          "clock: -3000 ppm device converges continuously");
    check(fast.min_occupancy > kBlock * 2 &&
              fast.max_occupancy < kBlock * 4,
          "clock: fast-device ring avoids empty/full for 30 minutes");
    check(slow.min_occupancy > kBlock * 2 &&
              slow.max_occupancy < kBlock * 4,
          "clock: slow-device ring avoids empty/full for 30 minutes");
    check(std::abs(fast.correction_ppm) <=
              DeviceClockController::max_correction_ppm() &&
              std::abs(slow.correction_ppm) <=
              DeviceClockController::max_correction_ppm(),
          "clock: correction remains inside the audible safety bound");

    std::printf(
        "MEASURE clock_fast_correction_ppm=%.2f occupancy=%.1f..%.1f "
        "clock_slow_correction_ppm=%.2f occupancy=%.1f..%.1f\n",
        fast.correction_ppm, fast.min_occupancy, fast.max_occupancy,
        slow.correction_ppm, slow.min_occupancy, slow.max_occupancy);
}

} // namespace

int main() {
    const auto wav = make_wav();
    PlaybackItemDesc desc;
    desc.id = CueId{"audio-rt-stress"};
    desc.file_path = wav;
    desc.mix_sample_rate = kRate;
    desc.render_block = kBlock;
    PlaybackItem item{std::move(desc)};

    check(item.load(), "fixture: WAV loads");
    if (failures == 0) {
        test_bounded_prefill_and_recovery(item);
        test_soft_out_point_fade(item);
        test_loop_and_concurrent_stress(item);
        test_continuous_clock_correction();
    }

    item.unload();
    std::error_code ec;
    std::filesystem::remove(wav, ec);
    std::printf("\n%s (%d failure%s)\n",
                failures == 0 ? "ALL PASS" : "FAILURES",
                failures, failures == 1 ? "" : "s");
    return failures == 0 ? 0 : 1;
}
