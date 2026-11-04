// Bounded read-ahead and render-thread stress checks. No test framework.
#include "liveplay/audio/callback_liveness.hpp"
#include "liveplay/audio/device_clock_controller.hpp"
#include "liveplay/audio/ltc_generator.hpp"
#include "liveplay/audio/meter.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <cstdlib>
#include <new>

// Coordinate the real control/render gates without a production test hook.
#define private public
#include "liveplay/audio/playback_item.hpp"
#undef private
#include "liveplay/audio/engine.hpp"
#include "liveplay/core/project_state.hpp"

using namespace liveplay::audio;
std::atomic<std::uint64_t> g_allocation_count{0};

void* operator new(std::size_t size) {
    g_allocation_count.fetch_add(1, std::memory_order_relaxed);
    if (void* p = std::malloc(size)) return p;
    throw std::bad_alloc{};
}
void* operator new[](std::size_t size) {
    g_allocation_count.fetch_add(1, std::memory_order_relaxed);
    if (void* p = std::malloc(size)) return p;
    throw std::bad_alloc{};
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete[](void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
void operator delete[](void* p, std::size_t) noexcept { std::free(p); }

namespace {

constexpr SampleRate kRate = 48'000;
constexpr FrameCount kBlock = 256;
int failures = 0;

void check(bool ok, const char* name) {
    std::printf("%-58s %s\n", name, ok ? "PASS" : "FAIL");
    if (!ok) ++failures;
}

void test_device_reference_churn() {
    detail::DeviceReferenceCount references;
    bool preview_release_closed_native = false;
    bool stable_owner_count = true;
    constexpr int preview_switches = 10'000;

    // Main owns the initial reference. Each preview selection acquires the
    // same deduplicated native device, then switching away releases only the
    // preview owner. The native device must remain owned exactly once.
    for (int i = 0; i < preview_switches; ++i) {
        references.acquire();
        preview_release_closed_native |= references.release_is_final();
        stable_owner_count &= references.value() == 1;
    }
    check(!preview_release_closed_native,
          "device refs: preview churn never physically closes Main");
    check(stable_owner_count,
          "device refs: preview churn returns to one Main owner");
    check(references.release_is_final(),
          "device refs: final Main release permits physical close");
}

void test_project_runtime_fences() {
    liveplay::core::detail::PlaybackGenerationFence fence;
    const auto old_play = fence.begin("cue-a");
    check(fence.is_current("cue-a", old_play),
          "generation: initial play is current");

    const auto replay = fence.begin("cue-a");
    check(!fence.is_current("cue-a", old_play),
          "generation: replay invalidates copied old action");
    check(!fence.claim_terminal("cue-a", old_play),
          "generation: old terminal action cannot claim replay");
    check(fence.claim_terminal("cue-a", replay),
          "generation: current terminal action claims exactly once");
    check(!fence.claim_terminal("cue-a", replay),
          "generation: terminal claim is one-shot");

    const auto cancelled = fence.begin("cue-a");
    fence.cancel("cue-a");
    check(!fence.is_current("cue-a", cancelled),
          "generation: explicit cancellation rejects copied action");

    using liveplay::core::detail::should_consume_group_override;
    check(!should_consume_group_override("group-a", "group-a", false),
          "group GO: failed children preserve armed override");
    check(should_consume_group_override("group-a", "group-a", true),
          "group GO: successful child consumes armed override");
    check(!should_consume_group_override("group-b", "group-a", true),
          "group GO: successful unrelated group preserves override");

    using liveplay::core::detail::same_media_identity;
    check(same_media_identity("show/audio/../new.wav", "show/new.wav"),
          "media identity: normalized equivalent path reuses decoder");
    check(!same_media_identity("show/old.wav", "show/new.wav"),
          "media identity: same UUID with new path reloads decoder");
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

std::filesystem::path make_wav(std::uint16_t channels = 2,
                               std::uint32_t frames = kRate * 3) {
    const auto path =
        std::filesystem::temp_directory_path() /
        ("dwcue-audio-rt-stress-" + std::to_string(channels) + "-" +
         std::to_string(frames) + ".wav");
    constexpr std::uint16_t bits = 16;
    const std::uint32_t data_bytes = frames * channels * (bits / 8);

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
        for (std::uint16_t channel = 0; channel < channels; ++channel)
            write_u16(out, static_cast<std::uint16_t>(sample));
    }
    return path;
}

struct Output {
    std::vector<Sample> left = std::vector<Sample>(kBlock);
    std::vector<Sample> right = std::vector<Sample>(kBlock);
    Sample* channels[2] = {left.data(), right.data()};
};

void test_item_gain_path(PlaybackItem& item) {
    const auto render_peak = [&](float gain_db) {
        item.stop_now();
        item.set_gain_db(gain_db);
        if (!item.prime(2.0, 0.0)) return 0.0;
        item.play();
        Output output;
        if (item.render_block(output.channels, 2, kBlock) != kBlock) return 0.0;
        return static_cast<double>(*std::max_element(
            output.left.begin(), output.left.end(),
            [](float a, float b) { return std::fabs(a) < std::fabs(b); }));
    };

    double expected_peak = 0.0;
    for (std::uint32_t frame = 0; frame < kBlock; ++frame) {
        const auto sample = static_cast<std::int16_t>(
            std::sin(2.0 * 3.14159265358979323846 * 997.0 * frame / kRate) *
            20'000.0);
        expected_peak = std::max(
            expected_peak, std::fabs(static_cast<double>(sample) / 32768.0));
    }

    const double unity = std::fabs(render_peak(0.0f));
    const double minus_six = std::fabs(render_peak(-6.0f));
    const double plus_six = std::fabs(render_peak(6.0f));
    check(std::fabs(unity - expected_peak) < 1e-6,
          "gain: 0 dB preserves decoded source amplitude");
    check(unity > 0.0 &&
              std::fabs(minus_six / unity - 0.501187) < 1e-5,
          "gain: -6 dB is exactly the cue-stage 0.501187 ratio");
    check(unity > 0.0 &&
              std::fabs(plus_six / unity - std::pow(10.0, 6.0 / 20.0)) < 1e-5,
          "gain: +6 dB preserves the saved cue-stage boost");

    item.set_duck_gain_linear(1.0f, std::chrono::milliseconds{0});
    check(std::fabs(std::fabs(render_peak(6.0f)) / unity - 1.0) < 1e-6,
          "duck boost: active 0 dB Duck Level still caps boosted gain");
    item.set_duck_gain_linear(0.2f, std::chrono::milliseconds{0});
    const double ducked = std::fabs(render_peak(6.0f));
    check(std::fabs(ducked / unity - 0.2) < 1e-6,
          "duck boost: active Duck Level remains an absolute ceiling");
    item.stop_now();
    check(item.prime(2.0, 0.0), "duck boost: release fixture primes");
    item.play();
    item.set_duck_gain_linear(1.0f, std::chrono::milliseconds{20}, false);
    Output output;
    bool release_matches = true;
    const double boost = std::pow(10.0, 6.0 / 20.0);
    for (std::uint32_t block = 0; block < 5; ++block) {
        item.service_read_ahead(1);
        release_matches &= item.render_block(output.channels, 2, kBlock) == kBlock;
        const double from = 0.2 + (boost - 0.2) *
            std::min(1.0, static_cast<double>(block * kBlock) / 960.0);
        const double to = 0.2 + (boost - 0.2) *
            std::min(1.0, static_cast<double>((block + 1) * kBlock) / 960.0);
        for (std::uint32_t frame = 0; frame < kBlock; ++frame) {
            const auto source = static_cast<std::int16_t>(std::sin(
                2.0 * 3.14159265358979323846 * 997.0 *
                (block * kBlock + frame) / kRate) * 20'000.0);
            const double gain = from + (to - from) * frame / kBlock;
            release_matches &= std::fabs(output.left[frame] -
                static_cast<double>(source) / 32768.0 * gain) < 1e-5;
        }
    }
    check(release_matches,
          "duck boost: timed release smoothly restores the full saved gain");
    item.set_duck_gain_linear(0.2f, std::chrono::milliseconds{0});
    render_peak(6.0f);
    item.set_duck_gain_linear(1.0f, std::chrono::milliseconds{0}, false);
    check(std::fabs(std::fabs(render_peak(6.0f)) / unity - boost) < 1e-5,
          "duck boost: immediate release restores gain above unity");
    item.stop_now();
    item.set_gain_db(0.0f);
}
void test_duck_automation(PlaybackItem& item) {
    item.stop_now();
    item.set_loop(false);
    item.set_out_point_seconds(0.0);
    item.set_fade_in(std::chrono::milliseconds{0});
    item.set_fade_out(std::chrono::milliseconds{0});
    item.set_gain_db(0.0f);
    item.set_duck_gain_linear(1.0f, std::chrono::milliseconds{0}, false);
    check(item.prime(2.0, 0.0), "duck: fixture primes");
    item.play();

    Output output;
    auto render_mean = [&] {
        item.service_read_ahead(1);
        const auto before = g_allocation_count.load(std::memory_order_relaxed);
        const auto frames = item.render_block(output.channels, 2, kBlock);
        const auto after = g_allocation_count.load(std::memory_order_relaxed);
        check(after == before, "duck: render block performs zero allocations");
        if (frames == 0) return 0.0;
        double sum = 0.0;
        for (std::size_t i = 0; i < frames; ++i) sum += std::fabs(output.left[i]);
        return sum / static_cast<double>(frames);
    };

    item.set_duck_gain_linear(0.2f, std::chrono::milliseconds{20});
    const double attack_first = render_mean();
    double attack_last = attack_first;
    for (int i = 0; i < 4; ++i) attack_last = render_mean();
    check(attack_last < attack_first * 0.55,
          "duck: attack envelope ramps toward absolute linear target");

    bool absolute_ceiling_held = true;
    item.set_gain_db(6.0f);
    for (int block = 0; block < 6; ++block) {
        render_mean();
        for (float sample : output.left)
            absolute_ceiling_held = absolute_ceiling_held &&
                std::isfinite(sample) && std::fabs(sample) <= 0.123f;
    }
    check(absolute_ceiling_held,
          "duck: upward fader slew never exceeds absolute Duck Level");

    item.set_gain_db(-120.0f);
    double muted_mean = 1.0;
    for (int block = 0; block < 100; ++block) muted_mean = render_mean();
    std::printf("MEASURE duck_muted_mean=%.9f\n", muted_mean);
    check(std::isfinite(muted_mean) && muted_mean < 0.0001,
          "duck: muted base remains finite and silent");

    item.set_gain_db(0.0f);
    absolute_ceiling_held = true;
    for (int block = 0; block < 6; ++block) {
        render_mean();
        for (float sample : output.left)
            absolute_ceiling_held = absolute_ceiling_held &&
                std::isfinite(sample) && std::fabs(sample) <= 0.123f;
    }
    check(absolute_ceiling_held,
          "duck: recovery from mute remains below absolute Duck Level");

    item.set_duck_gain_linear(1.0f, std::chrono::milliseconds{20}, false);
    const double release_first = render_mean();
    double release_last = release_first;
    for (int i = 0; i < 4; ++i) release_last = render_mean();
    check(release_last > release_first * 1.8,
          "duck: release envelope restores the independent base fader");

    item.stop_now();
    item.set_loop(true);
    item.set_gain_db(0.0f);
    item.set_duck_gain_linear(1.0f, std::chrono::milliseconds{0}, false);
    check(item.prime(2.0, 0.0), "duck race: fixture primes");
    item.play();
    std::atomic<bool> writer_done{false};
    std::thread writer([&] {
        for (int i = 0; i < 20000; ++i) {
            item.set_duck_gain_linear((i & 1) ? 0.125f : 0.875f,
                                      std::chrono::milliseconds{(i & 1) ? 7 : 43});
        }
        writer_done.store(true, std::memory_order_release);
    });
    bool samples_bounded = true;
    int blocks = 0;
    while (!writer_done.load(std::memory_order_acquire) || blocks < 256) {
        item.service_read_ahead(1);
        const auto before = g_allocation_count.load(std::memory_order_relaxed);
        item.render_block(output.channels, 2, kBlock);
        const auto after = g_allocation_count.load(std::memory_order_relaxed);
        if (after != before) {
            check(false, "duck race: render block performs zero allocations");
            break;
        }
        for (float sample : output.left) {
            samples_bounded = samples_bounded && std::isfinite(sample) &&
                              std::fabs(sample) <= 1.0001f;
        }
        ++blocks;
    }
    writer.join();
    check(samples_bounded,
          "duck race: rapid target-duration commands remain coherent and bounded");

    item.stop_now();
    item.set_loop(false);
    item.set_gain_db(0.0f);
    item.set_duck_gain_linear(1.0f, std::chrono::milliseconds{0}, false);
}

void test_active_mirror_prime_is_noop(PlaybackItem& item) {
    const auto runtime_unchanged = [](const PlaybackItemStats& before,
                                      const PlaybackItemStats& after) {
        return after.transport == before.transport &&
               after.playhead_frame == before.playhead_frame &&
               after.read_ahead_blocks == before.read_ahead_blocks;
    };
    const auto advance_one_block = [&item] {
        Output output;
        item.service_read_ahead(1);
        return item.render_block(output.channels, 2, kBlock) == kBlock;
    };

    item.stop_now();
    item.set_loop(false);
    item.set_out_point_seconds(0.0);
    item.set_fade_in(std::chrono::milliseconds{250});
    item.set_fade_out(std::chrono::milliseconds{250});

    check(item.prime(2.0, 0.5),
          "mirror prime: stopped one-shot still primes");
    const auto stopped = item.stats();
    check(stopped.transport == TransportState::Stopped &&
              stopped.playhead_frame == kRate / 2 &&
              stopped.read_ahead_blocks > 0,
          "mirror prime: stopped cue is positioned and prefetched");

    item.play();
    check(advance_one_block(), "mirror prime: active fixture renders");
    const auto fading_in = item.stats();
    check(fading_in.transport == TransportState::FadingIn,
          "mirror prime: active fixture starts in fade-in");
    check(item.prime(2.0, 0.0),
          "mirror prime: fading-in cue accepts no-op prime");
    check(runtime_unchanged(fading_in, item.stats()),
          "mirror prime: fading-in runtime is preserved");

    check(advance_one_block(), "mirror prime: pre-pause block renders");
    item.pause();
    const auto paused = item.stats();
    check(item.prime(2.0, 0.0),
          "mirror prime: paused cue accepts no-op prime");
    check(runtime_unchanged(paused, item.stats()),
          "mirror prime: paused runtime is preserved");

    item.resume();
    check(advance_one_block(), "mirror prime: resumed block renders");
    check(item.stats().transport == TransportState::FadingIn,
          "mirror prime: resume preserves the active fade-in");
    for (int i = 0; i < 48 &&
         item.stats().transport == TransportState::FadingIn; ++i)
        advance_one_block();
    const auto playing = item.stats();
    check(playing.transport == TransportState::Playing,
          "mirror prime: resume enters playing");
    check(item.prime(2.0, 0.0),
          "mirror prime: playing cue accepts no-op prime");
    check(runtime_unchanged(playing, item.stats()),
          "mirror prime: playing runtime is preserved");

    check(advance_one_block(), "mirror prime: pre-stop block renders");
    item.stop();
    const auto fading_out = item.stats();
    check(fading_out.transport == TransportState::FadingOut,
          "mirror prime: stop enters fade-out");
    check(item.prime(2.0, 0.0),
          "mirror prime: fading-out cue accepts no-op prime");
    check(runtime_unchanged(fading_out, item.stats()),
          "mirror prime: fading-out runtime is preserved");

    item.stop_now();
    item.set_fade_in(std::chrono::milliseconds{0});
    item.set_fade_out(std::chrono::milliseconds{0});
}

void test_unchanged_boundaries_preserve_audio(PlaybackItem& item) {
    item.stop_now();
    item.set_fade_in(std::chrono::milliseconds{0});
    item.set_fade_out(std::chrono::milliseconds{0});
    item.set_gain_db(0.0f);
    item.set_duck_gain_linear(1.0f, std::chrono::milliseconds{0}, false);
    item.set_out_point_seconds(0.0);
    item.set_loop(false, 0.0);
    item.prime(2.0, 0.0);
    item.play();
    Output output;
    item.render_block(output.channels, 2, kBlock);
    const auto before = item.stats();
    const auto revision = item.playback_revision();
    item.set_out_point_seconds(-1.0);
    item.set_loop(false, 0.0);
    check(item.playback_revision() == revision &&
              item.stats().read_ahead_blocks == before.read_ahead_blocks &&
              item.stats().playhead_frame == before.playhead_frame,
          "unchanged boundaries: live mirror preserves revision, queue and playhead");
    check(item.render_block(output.channels, 2, kBlock) == kBlock &&
              item.stats().playhead_frame == 2 * kBlock &&
              std::any_of(output.left.begin(), output.left.end(),
                          [](float sample) { return std::fabs(sample) > 0.1f; }),
          "unchanged boundaries: next PCM remains audible without a refill");

    item.set_out_point_seconds(0.02);
    check(item.playback_revision() != revision && item.stats().read_ahead_blocks == 0,
          "changed boundary: real trim still invalidates buffered audio");
    for (int i = 0; i < 8 && item.stats().transport != TransportState::Stopped; ++i) {
        item.service_read_ahead(16);
        item.render_block(output.channels, 2, kBlock);
    }
    check(item.stats().playhead_frame == 960 && item.take_natural_end(),
          "changed boundary: real trim finishes at its new endpoint");

    item.stop_now();
    item.set_out_point_seconds(0.1);
    item.set_loop(true, 0.2);
    item.prime(2.0, 0.0);
    item.play();
    item.render_block(output.channels, 2, kBlock);
    const auto loop_revision = item.playback_revision();
    const auto queued = item.stats().read_ahead_blocks;
    item.set_loop(true, 0.3);
    check(item.playback_revision() == loop_revision &&
              item.stats().read_ahead_blocks == queued &&
              item.render_block(output.channels, 2, kBlock) == kBlock,
          "unchanged boundaries: equivalent clamped loop-in preserves PCM");
    item.set_loop(false, 0.0);
    check(item.playback_revision() != loop_revision && item.stats().read_ahead_blocks == 0,
          "changed boundary: loop disable still invalidates old metadata");
    item.stop_now();
    item.set_out_point_seconds(0.0);
}

void test_pause_preserves_envelope(PlaybackItem& item) {
    for (const auto state : {TransportState::Playing, TransportState::FadingIn,
                             TransportState::FadingOut}) {
        const auto prepare = [&] {
            item.stop_now();
            item.set_loop(false);
            item.set_out_point_seconds(0.0);
            item.set_fade_in(std::chrono::milliseconds{
                state == TransportState::FadingIn ? 100 : 0});
            item.set_fade_out(std::chrono::milliseconds{100});
            item.prime(2.0, 0.0);
            item.play();
            if (state == TransportState::FadingOut) item.stop();
        };
        Output output, expected;
        prepare();
        item.render_block(output.channels, 2, kBlock);
        item.render_block(expected.channels, 2, kBlock);

        prepare();
        item.render_block(output.channels, 2, kBlock);
        item.pause();
        item.pause();
        const auto paused = item.stats();
        bool frozen = paused.transport == TransportState::Paused;
        for (int i = 0; i < 4; ++i) {
            frozen &= item.render_block(output.channels, 2, kBlock) == 0;
            frozen &= item.stats().playhead_frame == paused.playhead_frame;
            frozen &= std::all_of(output.left.begin(), output.left.end(),
                                  [](float sample) { return sample == 0.0f; });
            frozen &= !item.take_natural_end();
        }
        check(frozen, state == TransportState::FadingOut
            ? "pause: fade-out is silent and its playhead stays frozen"
            : state == TransportState::FadingIn
                ? "pause: fade-in is silent and its playhead stays frozen"
                : "pause: playing cue is silent and its playhead stays frozen");
        const auto paused_revision = item.playback_revision();
        item.stop_with_fade(std::chrono::milliseconds{50});
        check(item.stats().transport == TransportState::Paused &&
                  item.playback_revision() == paused_revision,
              "pause: copied fade command cannot restart a paused cue");
        if (state == TransportState::FadingIn) item.play();
        else item.resume();
        check(item.stats().transport == state,
              "pause: resume restores the preceding transport state");
        item.render_block(output.channels, 2, kBlock);
        check(output.left == expected.left && output.right == expected.right,
              "pause: resumed waveform matches uninterrupted envelope exactly");
    }

    item.stop_now();
    item.set_loop(true);
    item.set_fade_in(std::chrono::milliseconds{0});
    item.set_fade_out(std::chrono::milliseconds{60'000});
    item.prime(2.0, 0.0);
    item.play();
    item.stop();
    std::atomic<bool> done{false};
    std::atomic<unsigned> callbacks{0};
    std::thread renderer([&] {
        Output output;
        while (!done.load(std::memory_order_acquire)) {
            item.service_read_ahead(1);
            item.render_block(output.channels, 2, kBlock);
            callbacks.fetch_add(1, std::memory_order_release);
        }
    });
    bool coherent = true;
    for (int i = 0; i < 32; ++i) {
        item.pause();
        const auto paused = item.stats();
        const auto until = callbacks.load(std::memory_order_acquire) + 4;
        while (callbacks.load(std::memory_order_acquire) < until)
            std::this_thread::yield();
        coherent &= paused.transport == TransportState::Paused &&
            item.stats().transport == TransportState::Paused &&
            item.stats().playhead_frame == paused.playhead_frame;
        item.resume();
    }
    done.store(true, std::memory_order_release);
    renderer.join();
    check(coherent, "pause: callback cannot advance or overwrite paused state");
    Output output;
    item.pause();
    item.stop();
    check(item.stats().transport == TransportState::Stopped &&
              item.render_block(output.channels, 2, kBlock) == 0,
          "pause: explicit stop stays silent instead of reopening the fade");
    item.stop_now();
    item.set_loop(false);
    item.set_fade_in(std::chrono::milliseconds{0});
    item.set_fade_out(std::chrono::milliseconds{0});
}

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

void test_segmented_read_ahead(PlaybackItem& item) {
    item.stop_now();
    item.set_loop(false);
    item.set_out_point_seconds(0.0);
    item.set_fade_in(std::chrono::milliseconds{0});
    item.set_fade_out(std::chrono::milliseconds{0});
    item.prime(2.0, 0.0);
    item.play();
    Output output;
    std::uint32_t position = 0;
    bool continuous = true;
    for (const std::uint32_t frames : {37, 91, 256, 129, 255}) {
        continuous &= item.render_block(output.channels, 2, frames) == frames;
        for (std::uint32_t frame = 0; frame < frames; ++frame) {
            const auto source = static_cast<std::int16_t>(std::sin(
                2.0 * 3.14159265358979323846 * 997.0 *
                (position + frame) / kRate) * 20'000.0);
            continuous &= output.left[frame] == static_cast<float>(source) / 32768.0f;
        }
        position += frames;
        continuous &= item.stats().playhead_frame == position;
    }
    check(continuous, "segments: short renders preserve every queued source frame");

    item.stop_now();
    item.set_out_point_seconds(73.25 / kRate);
    item.prime(2.0, 0.0);
    item.play();
    check(item.render_block(output.channels, 2, 37) == 37 &&
              item.stats().playhead_frame == 37 &&
              item.stats().transport == TransportState::Playing &&
              !item.take_natural_end(),
          "segments: partial terminal slot does not finish early");
    check(item.render_block(output.channels, 2, 36) == 36 &&
              item.stats().playhead_frame == 73 && item.take_natural_end() &&
              !item.take_natural_end(),
          "segments: final source frame raises exactly one natural end");

    item.stop_now();
    item.set_loop(true, 11.25 / kRate);
    item.prime(2.0, 0.0);
    item.play();
    position = 0;
    continuous = true;
    for (const std::uint32_t frames : {37, 91, 256, 129, 255}) {
        continuous &= item.render_block(output.channels, 2, frames) == frames;
        for (std::uint32_t frame = 0; frame < frames; ++frame) {
            const auto source = static_cast<std::int16_t>(std::sin(
                2.0 * 3.14159265358979323846 * 997.0 * position / kRate) * 20'000.0);
            continuous &= output.left[frame] == static_cast<float>(source) / 32768.0f;
            if (++position == 73) position = 11;
        }
        continuous &= item.stats().playhead_frame == position;
    }
    check(continuous, "segments: split looping slots keep PCM and playhead aligned");
    item.stop_now();
    item.set_loop(false);
    item.set_out_point_seconds(0.0);
}

void test_prepared_follow(PlaybackItem& item) {
    item.stop_now();
    item.set_fade_in(std::chrono::milliseconds{20});
    check(item.prepare_start() == 0, "prepared: empty queue cannot be armed");
    item.prime(2.0, 0.0);
    const auto revision = item.prepare_start();
    check(revision != 0 && item.prepared_start_ready(revision) &&
              item.stats().transport == TransportState::Stopped,
          "prepared: ready token keeps target stopped until boundary");
    const auto allocations = g_allocation_count.load(std::memory_order_relaxed);
    const bool started = item.start_prepared_rt(revision);
    const bool no_allocations = allocations ==
        g_allocation_count.load(std::memory_order_relaxed);
    check(started && no_allocations && item.playback_revision() == revision &&
              item.stats().transport == TransportState::FadingIn &&
              !item.start_prepared_rt(revision),
          "prepared: RT start is allocation-free and consumes its token once");
    Output output;
    item.render_block(output.channels, 2, 37);
    item.pause();
    check(item.playback_revision() == revision && !item.finish_follow_rt(revision),
          "prepared: pause defers a boundary without cancelling its revision");
    item.resume();
    const auto finish_allocations = g_allocation_count.load(std::memory_order_relaxed);
    const bool finished = item.finish_follow_rt(revision);
    check(finished && finish_allocations ==
              g_allocation_count.load(std::memory_order_relaxed) &&
              item.stats().transport == TransportState::Stopped &&
              item.stats().playhead_frame == 37 && item.take_natural_end() &&
              !item.take_natural_end(),
          "prepared: RT finish preserves endpoint and emits one natural edge");

    const auto prepare = [&] {
        item.stop_now();
        item.set_fade_in(std::chrono::milliseconds{0});
        item.prime(2.0, 0.0);
        return item.prepare_start();
    };
    auto stale = prepare();
    item.seek_seconds(0.25);
    check(!item.prepared_start_ready(stale) && !item.start_prepared_rt(stale),
          "prepared: seek invalidates a copied start token");
    stale = prepare();
    item.stop();
    check(!item.start_prepared_rt(stale),
          "prepared: stop cancels a target that has not started");
    stale = prepare();
    item.set_loop(true);
    check(!item.start_prepared_rt(stale), "prepared: loop edit invalidates start");
    item.set_loop(false);
    stale = prepare();
    item.set_out_point_seconds(0.5);
    check(!item.start_prepared_rt(stale), "prepared: trim edit invalidates start");
    stale = prepare();
    item.prime(2.0, 0.0);
    check(!item.start_prepared_rt(stale), "prepared: re-prime invalidates start");
    stale = prepare();
    item.play();
    check(item.playback_revision() != stale && !item.finish_follow_rt(stale),
          "prepared: retrigger fences the preceding source completion");

    item.stop_now();
    item.set_out_point_seconds(73.25 / kRate);
    item.prime(2.0, 0.0);
    const auto natural = item.prepare_start();
    item.start_prepared_rt(natural);
    item.render_block(output.channels, 2, 73);
    check(item.stats().transport == TransportState::Stopped &&
              item.finish_follow_rt(natural) && item.take_natural_end() &&
              !item.take_natural_end(),
          "prepared: already natural-stopped source permits boundary handoff");
    item.stop_now();
    item.set_out_point_seconds(0.0);
}

void test_stereo_mix_gains(PlaybackItem& item) {
    check(item.stereo_mix_gains(0) == std::array<float, 2>{1.0f, 0.0f} &&
              item.stereo_mix_gains(1) == std::array<float, 2>{0.0f, 1.0f} &&
              item.stereo_mix_gains(2) == std::array<float, 2>{0.0f, 0.0f},
          "stereo map: native L/R stay unity and absent channels stay silent");
    for (const std::uint16_t channels : {1, 6}) {
        const auto wav = make_wav(channels);
        PlaybackItemDesc desc;
        desc.id = CueId{"stereo-map"};
        desc.file_path = wav;
        PlaybackItem source{std::move(desc)};
        check(source.load(), "stereo map: channel-layout fixture loads");
        constexpr float surround = 0.70710678f;
        if (channels == 1) {
            check(source.stereo_mix_gains(0) == std::array<float, 2>{1.0f, 1.0f},
                  "stereo map: mono keeps unity on both output channels");
        } else {
            check(source.stereo_mix_gains(2) == std::array<float, 2>{surround, surround} &&
                      source.stereo_mix_gains(3) == std::array<float, 2>{0.5f, 0.5f} &&
                      source.stereo_mix_gains(4) == std::array<float, 2>{surround, 0.0f} &&
                      source.stereo_mix_gains(5) == std::array<float, 2>{0.0f, surround},
                  "stereo map: center, LFE and surrounds retain native identities");
        }
        source.unload();
        std::error_code ec;
        std::filesystem::remove(wav, ec);
    }
}

void test_prime_against_rt_start(PlaybackItem& item) {
    item.stop_now();
    item.set_loop(false);
    item.set_out_point_seconds(0.0);
    item.set_fade_in(std::chrono::milliseconds{0});
    bool coherent = true;
    unsigned starts = 0;
    for (unsigned attempt = 0; attempt < 64 && starts < 8; ++attempt) {
        item.stop_now();
        item.prime(2.0, 0.0);
        const auto revision = item.prepare_start();
        const auto queued = item.stats().read_ahead_blocks;
        item.begin_render_exclusion();
        std::atomic<bool> done{false};
        std::thread primer([&] {
            item.prime(0.0, 0.5);
            done.store(true, std::memory_order_release);
        });
        bool owns_decoder = false;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds{1};
        while (!done.load(std::memory_order_acquire) &&
               std::chrono::steady_clock::now() < deadline) {
            if (!item.decoder_mutex_.try_lock()) {
                owns_decoder = true;
                break;
            }
            item.decoder_mutex_.unlock();
            std::this_thread::yield();
        }
        // Let prime reach the held render gate, then race the actual RT start.
        for (int i = 0; i < 32; ++i) std::this_thread::yield();
        item.end_render_exclusion();
        const bool started = item.start_prepared_rt(revision);
        primer.join();
        coherent &= owns_decoder;
        if (started) {
            ++starts;
            const auto after = item.stats();
            coherent &= after.transport == TransportState::Playing &&
                after.playhead_frame == 0 && after.read_ahead_blocks == queued &&
                item.playback_revision() == revision;
        }
    }
    check(starts > 0, "prime race: real prepared RT activation wins the gate");
    check(coherent, "prime race: queued prime cannot rewind an activated cue");
    item.stop_now();
}

void test_exact_eof_direct_replay() {
    const auto wav = make_wav(2, 1'024);
    PlaybackItemDesc desc;
    desc.id = CueId{"exact-eof-replay"};
    desc.file_path = wav;
    desc.render_block = kBlock;
    PlaybackItem item{std::move(desc)};
    check(item.load() && item.prime(2.0, 0.0), "EOF replay: exact-block fixture primes");
    Output output;
    item.play();
    check(item.render_block(output.channels, 2, kBlock) == kBlock &&
              item.stats().playhead_frame == kBlock,
          "EOF replay: fresh short-file prefill survives ordinary Play");
    item.stop_now();
    item.prime(2.0, 0.0);
    const auto revision = item.prepare_start();
    check(item.start_prepared_rt(revision), "EOF replay: fixture starts at prepared boundary");
    bool full_blocks = true;
    for (int i = 0; i < 4; ++i)
        full_blocks &= item.render_block(output.channels, 2, kBlock) == kBlock;
    check(full_blocks && item.stats().playhead_frame == 1'024,
          "EOF replay: all exact-block source frames render before handoff");
    check(item.finish_follow_rt(revision), "EOF replay: exact endpoint accepts handoff stop");
    item.take_natural_end();
    item.play();
    check(item.render_block(output.channels, 2, kBlock) == kBlock &&
              item.stats().playhead_frame == kBlock &&
              std::any_of(output.left.begin(), output.left.end(),
                          [](float sample) { return sample != 0.0f; }),
          "EOF replay: direct Play restarts after a queued zero-frame EOF marker");
    item.unload();
    std::error_code error;
    std::filesystem::remove(wav, error);
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

void test_loop_continue_stop_and_replay(PlaybackItem& item) {
    item.stop_now();
    (void)item.take_natural_end();
    item.set_fade_out(std::chrono::milliseconds{0});
    item.set_out_point_seconds(768.0 / kRate);
    item.set_loop(true, 256.0 / kRate);
    check(item.prime(2.0, 0.0), "continue: looping pass primes");
    item.play();

    Output output;
    for (int i = 0; i < 12; ++i) {
        item.service_read_ahead(1);
        item.render_block(output.channels, 2, kBlock);
    }
    check(item.stats().transport == TransportState::Playing,
          "continue: saved loop remains active before arming");
    check(!item.take_natural_end(),
          "continue: looping crossings do not raise a follow edge");

    // This is the PlaybackItem operation used by the server's runtime-only Cue
    // to Continue command: disable looping without touching saved cue data.
    item.set_loop(false);
    for (int i = 0;
         i < 32 && item.stats().transport != TransportState::Stopped;
         ++i) {
        item.service_read_ahead(1);
        item.render_block(output.channels, 2, kBlock);
    }
    check(item.stats().transport == TransportState::Stopped,
          "continue: current pass reaches a natural stop after arming");
    check(item.take_natural_end(),
          "continue: completion raises exactly one follow edge");
    check(!item.take_natural_end(),
          "continue: follow edge remains one-shot");

    // Explicit stop cancels the pending completion edge.
    item.set_loop(true, 256.0 / kRate);
    check(item.prime(2.0, 0.0), "continue stop: pass primes");
    item.play();
    item.set_loop(false);
    item.stop_now();
    check(!item.take_natural_end(),
          "continue stop: explicit stop raises no follow edge");

    // Replay reapplies the saved loop state rather than inheriting the runtime
    // one-shot override from the previous play.
    item.set_loop(true, 256.0 / kRate);
    check(item.prime(2.0, 0.0), "continue replay: pass primes");
    item.play();
    for (int i = 0; i < 24; ++i) {
        item.service_read_ahead(1);
        item.render_block(output.channels, 2, kBlock);
    }
    check(item.stats().transport == TransportState::Playing,
          "continue replay: saved loop behavior is restored");
    check(!item.take_natural_end(),
          "continue replay: restored loop does not auto-advance");
}

void test_callback_liveness() {
    using namespace std::chrono_literals;
    using Monitor = CallbackLivenessMonitor;

    CallbackEntryCounter counter;
    static_assert(noexcept(counter.record_entry()));
    Monitor monitor{100ms};
    const Monitor::TimePoint origin{};
    monitor.arm(counter.value(), origin);

    check(monitor.state() == CallbackLivenessState::Starting,
          "liveness: armed stream starts as Starting");
    check(!is_healthy_clock_source(monitor.state()),
          "liveness: Starting stream is excluded from clock election");
    check(monitor.tick(counter.value(), origin + 99ms) ==
              CallbackLivenessState::Starting,
          "liveness: unchanged counter remains Starting before timeout");

    counter.record_entry();
    check(monitor.tick(counter.value(), origin + 100ms) ==
              CallbackLivenessState::Running,
          "liveness: first post-start callback establishes Running");
    check(is_healthy_clock_source(monitor.state()),
          "liveness: only Running is eligible for clock election");
    check(monitor.tick(counter.value(), origin + 199ms) ==
              CallbackLivenessState::Running,
          "liveness: callback remains live before stall timeout");
    check(monitor.tick(counter.value(), origin + 200ms) ==
              CallbackLivenessState::Stalled,
          "liveness: unchanged Running counter becomes Stalled");
    check(!is_healthy_clock_source(monitor.state()),
          "liveness: Stalled stream is excluded from clock election");

    counter.record_entry();
    check(monitor.tick(counter.value(), origin + 201ms) ==
              CallbackLivenessState::Running,
          "liveness: resumed callback recovers a stalled stream");

    // A restart must capture the current counter as its baseline. Entries from
    // the old stream cannot make the replacement appear alive.
    monitor.arm(counter.value(), origin + 300ms);
    check(monitor.tick(counter.value(), origin + 300ms) ==
              CallbackLivenessState::Starting,
          "liveness: stale pre-recovery count does not restore Running");
    check(monitor.tick(counter.value(), origin + 400ms) ==
              CallbackLivenessState::Stalled,
          "liveness: recovered stream without callbacks becomes Stalled");
    counter.record_entry();
    check(monitor.tick(counter.value(), origin + 401ms) ==
              CallbackLivenessState::Running,
          "liveness: first post-recovery callback restores Running");
}

void test_recovery_request_correlation() {
    DeviceRecoveryRequest recovery;
    check(recovery.request_id() == 0 &&
              recovery.status() == DeviceRecoveryStatus::Idle,
          "recovery request: starts idle without an id");

    check(recovery.begin(1),
          "recovery request: first attempt is accepted");
    check(!recovery.begin(2),
          "recovery request: pending attempt excludes another request");
    check(recovery.fail(1) &&
              recovery.status() == DeviceRecoveryStatus::Failed,
          "recovery request: matching startup failure is terminal");

    check(recovery.begin(2) && recovery.request_id() == 2 &&
              recovery.status() == DeviceRecoveryStatus::Pending,
          "recovery request: failed attempt releases inflight for retry");
    check(!recovery.succeed(1) && recovery.request_id() == 2 &&
              recovery.status() == DeviceRecoveryStatus::Pending,
          "recovery request: stale completion cannot succeed the retry");
    check(recovery.succeed(2) &&
              recovery.status() == DeviceRecoveryStatus::Succeeded,
          "recovery request: only matching completion succeeds");
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
        test_item_gain_path(item);
        test_duck_automation(item);
        test_active_mirror_prime_is_noop(item);
        test_unchanged_boundaries_preserve_audio(item);
        test_pause_preserves_envelope(item);
        test_device_reference_churn();
        test_project_runtime_fences();
        test_bounded_prefill_and_recovery(item);
        test_segmented_read_ahead(item);
        test_prepared_follow(item);
        test_stereo_mix_gains(item);
        test_prime_against_rt_start(item);
        test_exact_eof_direct_replay();
        test_soft_out_point_fade(item);
        test_loop_and_concurrent_stress(item);
        test_loop_continue_stop_and_replay(item);
        test_callback_liveness();
        test_recovery_request_correlation();
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
