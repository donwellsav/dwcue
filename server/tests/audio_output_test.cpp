// Exercise the real engine -> PCM ring -> device callback without hardware.
#include "liveplay/audio/callback_liveness.hpp"
#include "liveplay/audio/device_clock_controller.hpp"
#include "liveplay/audio/limiter.hpp"
#include "liveplay/audio/meter.hpp"
#include "liveplay/audio/mixer_channel.hpp"
#include "liveplay/audio/playback_item.hpp"
#include <miniaudio.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <new>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

// Preinclude dependencies so the access override is confined to AudioEngine.
#define private public
#include "liveplay/audio/engine.hpp"
#undef private

namespace {
using namespace liveplay::audio;
int failures = 0;
thread_local bool measure_allocations = false;
std::size_t rt_allocations = 0;
std::size_t rt_deallocations = 0;
constexpr std::size_t block = 256;
constexpr float ceiling = 0.891250938f; // -1 dB

void check(bool ok, const char* label) {
    std::printf("%-72s %s\n", label, ok ? "PASS" : "FAIL");
    if (!ok) ++failures;
}

void u16(std::ofstream& out, std::uint16_t v) {
    const char bytes[]{static_cast<char>(v), static_cast<char>(v >> 8)};
    out.write(bytes, 2);
}
void u32(std::ofstream& out, std::uint32_t v) {
    const char bytes[]{static_cast<char>(v), static_cast<char>(v >> 8),
                       static_cast<char>(v >> 16), static_cast<char>(v >> 24)};
    out.write(bytes, 4);
}
std::filesystem::path wav(const std::filesystem::path& dir,
                          const char* name, float amplitude, bool constant = false,
                          float slope = 0.0f, ChannelCount channels = 1,
                          ChannelIndex active = 0) {
    const auto path = dir / name;
    std::ofstream out(path, std::ios::binary);
    constexpr std::uint32_t frames = 48'000;
    const auto bytes = frames * channels * 4;
    out.write("RIFF", 4); u32(out, 36 + bytes); out.write("WAVEfmt ", 8);
    u32(out, 16); u16(out, 3); u16(out, channels); u32(out, 48'000);
    u32(out, 192'000 * channels); u16(out, channels * 4); u16(out, 32);
    out.write("data", 4); u32(out, bytes);
    for (std::uint32_t i = 0; i < frames; ++i) {
        const float x = constant ? amplitude + slope * i
            : amplitude * std::sin(2.0 * 3.14159265358979323846 * i / 48.0);
        for (ChannelIndex ch = 0; ch < channels; ++ch) {
            const float sample = ch == active ? x : 0.0f;
            out.write(reinterpret_cast<const char*>(&sample), sizeof(sample));
        }
    }
    return path;
}

struct Fixture {
    AudioEngine engine{EngineConfig{48'000, block, 32, -1.0f}};
    std::shared_ptr<AudioEngine::Device> device =
        std::make_shared<AudioEngine::Device>();
    std::shared_ptr<PlaybackItem> item;
    ma_device native{};

    Fixture(const std::filesystem::path& path, bool collide = false,
            bool resample = false) {
        device->id = DeviceId{"headless-output"};
        device->channels = 2;
        device->sample_rate = 48'000;
        device->engine = &engine;
        device->scratch.resize(block * 2);
        device->output_mono.resize(block);
        device->outputs.resize(2);
        for (auto& state : device->outputs) {
            state.limiter = std::make_unique<Limiter>();
            state.limiter->configure(48'000, -1.0f);
            state.meter = std::make_unique<Meter>();
            state.meter->configure(48'000);
        }
        device->ring = std::make_unique<ma_pcm_rb>();
        if (ma_pcm_rb_init(ma_format_f32, 2, block * 16, nullptr, nullptr,
                           device->ring.get()) != MA_SUCCESS) std::abort();
        device->started.store(true);
        device->runtime_state.store(DeviceRuntimeState::Running);
        device->reset_requested.store(false);
        device->clock_master.store(!resample);
        if (resample) {
            device->clock_resampler = std::make_unique<ma_resampler>();
            auto config = ma_resampler_config_init(ma_format_f32, 2, 48'000,
                48'000, ma_resample_algorithm_linear);
            config.linear.lpfOrder = 0;
            if (ma_resampler_init(&config, nullptr,
                    device->clock_resampler.get()) != MA_SUCCESS) std::abort();
            device->clock_resampler_initialized = true;
            device->clock_controller.configure(block * 16, block * 8);
        }
        engine.devices_.push_back(device);
        engine.publish_device_snapshot_locked();
        native.pUserData = device.get();
        native.playback.channels = 2;

        const auto cue = engine.load_cue_no_route(path);
        const auto mixer = engine.create_mixer_channel("Output regression");
        engine.route_item_source_to_mixer(cue, 0, mixer, 0, 0.0f);
        for (MasterChannelIndex master : {0u, 1u, 2u})
            engine.route_mixer_to_master(mixer, master, 0.0f, 0);
        engine.assign_master_to_device(0, device->id, 0);
        engine.assign_master_to_device(1, device->id, 1);
        if (collide) {
            engine.route_mixer_to_master(mixer, 30, 0.0f, 0);
            engine.assign_master_to_device(30, device->id, 0);
        }
        item = engine.find_cue(cue);
        if (!item || !item->prime(2, 0)) std::abort();
        item->play();
    }

    void render(std::size_t count = 1) {
        for (std::size_t i = 0; i < count; ++i) {
            item->service_read_ahead(1);
            const auto topology = engine.snapshot_topology();
            measure_allocations = true;
            engine.render_one_block(*topology);
            measure_allocations = false;
        }
    }
    std::vector<float> drain(std::size_t frames = block) {
        std::vector<float> out(frames * 2);
        measure_allocations = true;
        AudioEngine::ma_data_callback(&native, out.data(), nullptr, frames);
        measure_allocations = false;
        return out;
    }
};

void test_shared_output(const std::filesystem::path& tone, bool resample) {
    Fixture f(tone, true, resample);
    float peak = 0.0f, other_peak = 0.0f, true_peak = 0.0f;
    TruePeakDetector detector;
    // Keep headroom in a secondary device's ring while its clock adjusts.
    if (resample) f.render(8);
    for (int i = 0; i < 32; ++i) {
        f.render();
        const auto out = f.drain();
        for (std::size_t s = 0; s < block; ++s) {
            peak = std::max(peak, std::fabs(out[s * 2]));
            other_peak = std::max(other_peak, std::fabs(out[s * 2 + 1]));
            true_peak = std::max(true_peak, detector.process(out[s * 2]));
        }
    }
    std::printf("physical output: sample %.9f, reconstructed %.9f, ceiling %.9f\n",
                peak, true_peak, ceiling);
    check(peak <= ceiling + 1e-6f && peak > 0.8f,
          resample ? "clock-adapted physical sum respects ceiling"
                   : "colliding logical masters respect final physical ceiling");
    check(true_peak <= ceiling + 1e-5f,
          "independent detector verifies final callback true peak");
    check(std::fabs(other_peak - 0.7f) < (resample ? 1e-4f : 1e-5f),
          "single hardware channel remains unity below ceiling");
    const auto a = f.engine.read_master_meter(0);
    const auto b = f.engine.read_master_meter(30);
    check(std::fabs(a.peak_max_db - linear_to_db_precise(peak)) < 1e-4f &&
          std::fabs(a.peak_max_db - b.peak_max_db) < 1e-5f,
          "mapped master meters report the same final physical sum");
    check(f.engine.read_master_gain_reduction_db(0) < -1.0f &&
          std::fabs(f.engine.read_master_gain_reduction_db(0) -
                    f.engine.read_master_gain_reduction_db(30)) < 1e-5f,
          "mapped masters report the physical limiter gain reduction");
    check(f.engine.read_master_gain_reduction_db(2) == 0.0f &&
          std::fabs(f.engine.read_master_meter(2).peak_max_db -
                    linear_to_db_precise(0.7f)) < 1e-4f,
          "unassigned logical bus keeps its meter and reports no hardware GR");
    const auto consumed_a = f.engine.read_master_meter_consume(0);
    const auto held_b = f.engine.read_master_meter(30);
    const auto consumed_b = f.engine.read_master_meter_consume(30);
    check(std::fabs(consumed_a.peak_max_db - consumed_b.peak_max_db) < 1e-5f &&
          std::fabs(held_b.peak_max_db - consumed_b.peak_max_db) < 1e-5f &&
          f.engine.read_master_meter_consume(0).peak_max_db == -120.0f,
          "consuming one output strip does not steal an alias's peak");
}

void test_delay_and_bypass(const std::filesystem::path& quiet) {
    Fixture f(quiet);
    Limiter reference;
    reference.configure(48'000, -1.0f);
    std::vector<float> reference_block(block * 2, 0.1f);
    reference.process(reference_block.data(), reference_block.size());
    const auto delay = static_cast<std::size_t>(std::find_if(
        reference_block.begin(), reference_block.end(),
        [](float x) { return x != 0.0f; }) - reference_block.begin());
    bool exact = true;
    std::size_t time = 0;
    for (int i = 0; i < 8; ++i) {
        if (i == 2) f.engine.set_limiter_enabled(false);
        if (i == 4) f.engine.set_master_ceiling_db(-6.0f);
        if (i == 6) f.engine.set_limiter_enabled(true);
        f.render(2);
        const auto out = f.drain(block * 2); // larger than the mono work buffer
        for (std::size_t s = 0; s < block * 2; ++s, ++time) {
            const float expected = time < delay ? 0.0f : 0.1f;
            exact = exact && std::fabs(out[s * 2] - expected) < 1e-6f;
        }
    }
    check(exact, "one 5 ms delay, unity gain, and continuous bypass/ceiling changes");
    check(f.engine.read_master_gain_reduction_db(0) == 0.0f,
          "below-ceiling output is attenuation-only with zero GR");
}

void test_live_ceiling(const std::filesystem::path& tone) {
    Fixture f(tone, true);
    for (int i = 0; i < 8; ++i) { f.render(); (void)f.drain(); }
    f.render(2);
    f.engine.set_master_ceiling_db(-12.0f);
    const auto limited = f.drain();
    float peak = 0;
    for (float x : limited) peak = std::max(peak, std::fabs(x));
    check(peak <= db_to_linear_precise(-12.0f) + 1e-6f,
          "live ceiling change protects already-queued device audio");
    f.engine.set_limiter_enabled(false);
    f.render();
    const auto bypassed = f.drain();
    peak = 0;
    for (float x : bypassed) peak = std::max(peak, std::fabs(x));
    check(peak > 1.3f && f.engine.read_master_gain_reduction_db(0) == 0.0f,
          "explicit bypass passes the physical sum and reports zero GR");
}

void test_exact_follow(const std::filesystem::path& quiet,
                       const std::filesystem::path& next, bool target_first) {
    Fixture f(quiet);
    const auto target = f.engine.load_cue_no_route(next);
    const auto mixer = f.engine.snapshot_topology()->mixers.front()->id();
    f.engine.route_item_source_to_mixer(target, 0, mixer, 0, 0.0f);
    const auto item = f.engine.find_cue(target);
    check(item->prime(2.0, 0.0), "follow target read-ahead prepared without playback");
    constexpr std::uint64_t endpoint = 1'013;
    const auto follow = f.engine.schedule_follow(f.item->id(), target, endpoint);
    check(follow && item->stats().transport == TransportState::Stopped,
          "scheduled follow leaves its prepared target stopped");
    if (!follow) return;
    // This fixture has no render thread. Reorder in place: channel_ptrs point
    // into the entries' existing buffers, so copying a snapshot would break them.
    auto topology = std::const_pointer_cast<Topology>(f.engine.snapshot_topology());
    std::sort(topology->items.begin(), topology->items.end(), [&](auto& a, auto& b) {
        return target_first ? a.item == item && b.item != item
                            : a.item != item && b.item == item;
    });
    Limiter reference;
    reference.configure(48'000, -1.0f);
    std::vector<float> delayed(block * 2, 0.1f);
    reference.process(delayed.data(), delayed.size());
    const auto delay = static_cast<std::size_t>(std::find_if(
        delayed.begin(), delayed.end(), [](float x) { return x != 0; }) - delayed.begin());
    bool exact = true;
    std::size_t time = 0;
    for (int i = 0; i < 8; ++i) {
        f.render();
        const auto out = f.drain();
        for (std::size_t s = 0; s < block; ++s, ++time) {
            const float expected = time < delay ? 0.0f
                : time - delay < endpoint ? 0.1f
                : 0.2f + (time - delay - endpoint) * 0.00001f;
            if (exact && std::fabs(out[s * 2] - expected) >= 1e-6f)
                std::printf("follow mismatch at %zu: got %.9f expected %.9f\n",
                            time, out[s * 2], expected);
            exact = exact && std::fabs(out[s * 2] - expected) < 1e-6f;
        }
    }
    check(exact, target_first
        ? "exact butt transition and partial-slot reads with target first"
        : "exact butt transition and partial-slot reads with source first");
    check(follow->status.load() == PreparedFollow::State::Fired &&
          f.item->stats().transport == TransportState::Stopped &&
          item->stats().playhead_frame == block * 8 - endpoint,
          "follow fires once at its exact source frame and preserves target cursor");
}

void test_main_channel_map(const std::filesystem::path& quiet,
                           const std::filesystem::path& path,
                           float expected_left, float expected_right) {
    Fixture f(quiet);
    f.item->stop_now();
    f.engine.route_mixer_to_master(
        f.engine.snapshot_topology()->mixers.front()->id(), 1, 0.0f, 1);
    const auto cue = f.engine.load_cue_no_route(path);
    f.engine.ensure_default_routing_for_cue(cue);
    f.item = f.engine.find_cue(cue);
    f.item->prime(2.0, 0.0);
    f.item->play();
    float left = 0, right = 0;
    for (int i = 0; i < 8; ++i) {
        f.render();
        const auto out = f.drain();
        for (std::size_t s = 0; s < block; ++s) {
            left = std::max(left, std::fabs(out[s * 2]));
            right = std::max(right, std::fabs(out[s * 2 + 1]));
        }
    }
    check(std::fabs(left - expected_left) < 1e-5f &&
          std::fabs(right - expected_right) < 1e-5f,
          f.item->source_channel_count() == 2
              ? "Main stereo source retains unity L/R separation"
              : "Main includes the 5.1 center at shared stereo downmix weights");
}

void test_mono_route_replacement(const std::filesystem::path& quiet) {
    Fixture f(quiet);
    f.item->stop_now();
    const auto cue = f.engine.load_cue_no_route(quiet);
    f.engine.ensure_default_routing_for_cue(cue);
    f.item = f.engine.find_cue(cue);
    const auto main = f.engine.main_mixer_;
    auto& sends = f.engine.pending_.item_sources[cue.value].by_source_channel[0];
    check(sends.size() == 1 && sends[0].lane == kAllMixerLanes,
          "mono Main uses one equal-gain send to both lanes");
    // Exercise replacement of the legacy two-lane representation as well.
    sends = {{main, 0, 1.0f}, {main, 1, 1.0f}};
    f.engine.route_item_source_to_mixer(cue, 0, main, -6.0206f);
    check(f.item->prime(2.0, 0.0), "mono route replacement primes");
    f.item->play();
    const auto rendered = [&](float expected_left, float expected_right) {
        f.render();
        const auto topology = f.engine.snapshot_topology();
        for (std::size_t i = 0; i < topology->mixers.size(); ++i) {
            if (topology->mixers[i]->id() != main) continue;
            return std::abs(topology->mixer_accumulators[i * 2][0] - expected_left) < 1e-6f &&
                   std::abs(topology->mixer_accumulators[i * 2 + 1][0] - expected_right) < 1e-6f;
        }
        return false;
    };
    check(rendered(0.05f, 0.05f), "mono route replacement has equal quiet L/R without a doubled lane");
    f.engine.route_item_source_to_mixer(cue, 0, main, -6.0206f, 0);
    f.engine.route_item_source_to_mixer(cue, 0, main, -6.0206f, 0);
    check(rendered(0.05f, 0.0f), "mono route lane replacement removes every old send to that mixer");
}

void test_follow_retirement(const std::filesystem::path& quiet) {
    Fixture f(quiet);
    const auto target = f.engine.load_cue_no_route(quiet);
    const auto mixer = f.engine.snapshot_topology()->mixers.front()->id();
    f.engine.route_item_source_to_mixer(target, 0, mixer, 0, 0.0f);
    f.engine.find_cue(target)->prime(2.0, 0.0);
    auto follow = f.engine.schedule_follow(f.item->id(), target, 528);
    check(follow != nullptr, "retirement fixture arms its prepared follow");
    if (!follow) return;
    std::weak_ptr<PreparedFollow> retired = follow;
    auto old_snapshot = f.engine.snapshot_topology();
    f.render(3);
    (void)f.drain(block * 3);
    follow.reset();
    f.engine.unload_cue(target);
    check(!retired.expired(), "old render snapshot retains completed follow safely");
    old_snapshot.reset();
    check(!retired.expired(), "RT snapshot retirement leaves record ownership on control");
    f.engine.create_mixer_channel("Collect retired follow");
    check(retired.expired(), "next control rebuild reclaims completed unreferenced follow");

    f.item->stop_now();
    f.item->prime(2.0, 0.0);
    f.item->play();
    const auto removed = f.engine.load_cue_no_route(quiet);
    f.engine.find_cue(removed)->prime(2.0, 0.0);
    const auto cancelled = f.engine.schedule_follow(f.item->id(), removed, 528);
    f.engine.unload_cue(removed);
    check(cancelled && cancelled->status.load() == PreparedFollow::State::Cancelled,
          "unloading a prepared target cancels old-snapshot follow activation");
}

void test_opened_device_identity(const std::filesystem::path& quiet) {
    Fixture f(quiet);
    f.device->display_name = "Same hardware name";
    auto sibling = std::make_shared<AudioEngine::Device>();
    sibling->id = DeviceId{"headless-sibling"};
    sibling->display_name = f.device->display_name;
    f.engine.devices_.push_back(sibling);
    f.engine.publish_device_snapshot_locked();
    const auto id = f.engine.open_device_by_name(f.device->id.value);
    check(id == f.device->id && f.device->open_references.value() == 2 &&
          sibling->open_references.value() == 1 && f.engine.devices_.size() == 2,
          "opened runtime UUID acquires exactly its device despite duplicate names");
    if (id.empty()) return;
    f.engine.close_device(id);
    check(f.device->open_references.value() == 1 &&
          !f.device->closing.load() && f.engine.devices_.size() == 2,
          "releasing an acquired UUID leaves the original device owner open");
}

void test_main_preview_isolation(const std::filesystem::path& quiet,
                                 const std::filesystem::path& next) {
    Fixture f(quiet);
    // The fixture's first strip is the audience program. Preview has its own
    // unassigned masters, so none of its PCM is allowed onto that device.
    const auto program = f.engine.snapshot_topology()->mixers.front()->id();
    const auto preview = f.engine.create_mixer_channel("Preview");
    f.engine.route_mixer_to_master(preview, 30, 0.0f, 0);
    f.engine.route_mixer_to_master(preview, 31, 0.0f, 1);
    const auto cue = f.engine.load_cue_no_route(next);
    f.engine.route_item_source_to_mixer(cue, 0, preview, 0.0f, kAllMixerLanes);
    const auto item = f.engine.find_cue(cue);
    item->prime(2.0, 0.0);
    item->play();
    f.engine.ensure_default_routing();
    bool preview_leaked = false;
    for (const auto& send : f.engine.pending_.mixer_to_master[preview.value])
        preview_leaked = preview_leaked || send.master < 2;
    check(!preview_leaked, "default routing never wires Preview's strip to audience masters");
    float peak = 0;
    for (int i = 0; i < 8; ++i) {
        item->service_read_ahead(1);
        f.render();
        for (float x : f.drain()) peak = std::max(peak, std::fabs(x));
    }
    std::printf("isolated program peak %.9f (expected 0.1)\n", peak);
    check(std::fabs(peak - 0.1f) < 1e-6f,
          "actual audience callback PCM excludes sounding Preview");
    check(f.engine.find_mixer_channel(program) != nullptr,
          "default routing preserves an explicitly routed program strip");

    const auto main = f.engine.main_mixer_;
    f.engine.find_mixer_channel(main)->set_display_name("Renamed audience bus");
    const auto other_main = f.engine.create_mixer_channel("Main");
    const auto duplicate_main = f.engine.create_mixer_channel("Main");
    const auto automatic = f.engine.load_cue_no_route(quiet);
    f.engine.ensure_default_routing_for_cue(automatic);
    check(f.engine.main_mixer_ == main && main != program && main != preview &&
          main != other_main && main != duplicate_main,
          "renaming Main or adding duplicate labels preserves its dedicated identity");
    f.engine.remove_mixer_channel(main);
    check(f.engine.main_mixer_.empty(), "removing Main clears its cached identity");
    f.engine.ensure_default_routing_for_cue(automatic);
    const auto replacement = f.engine.main_mixer_;
    const auto& sends = f.engine.pending_.item_sources[automatic.value].by_source_channel[0];
    check(!replacement.empty() && replacement != main && replacement != preview &&
          replacement != other_main && replacement != duplicate_main &&
          !sends.empty() && std::all_of(sends.begin(), sends.end(),
              [&](const auto& send) { return send.mixer == replacement; }),
          "removed Main is replaced and unrouted cues attach only to the replacement");
}

void test_snapshot_reclamation() {
    AudioEngine engine;
    engine.create_mixer_channel("Snapshot ownership");
    auto reader = engine.snapshot_topology();
    std::weak_ptr<const Topology> old = reader;
    auto devices_reader = engine.snapshot_devices();
    engine.publish_device_snapshot_locked();
    devices_reader = engine.snapshot_devices();
    std::weak_ptr<const AudioEngine::DeviceList> old_devices = devices_reader;
    engine.publish_device_snapshot_locked();
    engine.create_mixer_channel("Replacement");
    const auto before = rt_deallocations;
    measure_allocations = true;
    reader.reset();
    devices_reader.reset();
    measure_allocations = false;
    check(rt_deallocations == before && !old.expired() && !old_devices.expired(),
          "retired topology/device snapshots cannot free storage on their last RT reader");

    std::vector<std::weak_ptr<const Topology>> churn;
    auto held = engine.snapshot_topology();
    for (int i = 0; i < 64; ++i) {
        churn.emplace_back(engine.snapshot_topology());
        engine.create_mixer_channel("Temporary");
    }
    engine.running_.store(true);
    std::thread maintenance([&] { engine.device_watchdog_loop(); });
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds{1};
    while ((!old.expired() || !old_devices.expired()) && std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(std::chrono::milliseconds{5});
    check(old.expired() && old_devices.expired(),
          "idle maintenance reclaims released snapshots without another edit");
    check(!churn.front().expired() && std::count_if(churn.begin(), churn.end(),
              [](const auto& snapshot) { return !snapshot.expired(); }) == 1,
          "snapshot churn retains only the outstanding reader after maintenance");
    held.reset();
    engine.running_.store(false);
    engine.device_watchdog_cv_.notify_all();
    maintenance.join();
}
} // namespace

void* operator new(std::size_t size) {
    if (measure_allocations) ++rt_allocations;
    if (void* p = std::malloc(std::max<std::size_t>(size, 1))) return p;
    throw std::bad_alloc{};
}
void* operator new[](std::size_t size) { return ::operator new(size); }
void operator delete(void* p) noexcept { if (measure_allocations) ++rt_deallocations; std::free(p); }
void operator delete[](void* p) noexcept { ::operator delete(p); }

int main() {
    const auto dir = std::filesystem::temp_directory_path() /
        ("dwcue-audio-output-" + std::to_string(
            std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directory(dir);
    const auto tone = wav(dir, "tone.wav", 0.7f);
    const auto quiet = wav(dir, "quiet.wav", 0.1f, true);
    const auto next = wav(dir, "next.wav", 0.2f, true, 0.00001f);
    const auto center = wav(dir, "center.wav", 0.7f, true, 0.0f, 6, 2);
    const auto left = wav(dir, "left.wav", 0.3f, true, 0.0f, 2, 0);
    test_shared_output(tone, false);
    test_shared_output(tone, true);
    test_delay_and_bypass(quiet);
    test_live_ceiling(tone);
    test_exact_follow(quiet, next, false);
    test_exact_follow(quiet, next, true);
    test_main_channel_map(quiet, center, 0.7f * 0.70710678f, 0.7f * 0.70710678f);
    test_main_channel_map(quiet, left, 0.3f, 0.0f);
    test_mono_route_replacement(quiet);
    test_follow_retirement(quiet);
    test_opened_device_identity(quiet);
    test_main_preview_isolation(quiet, next);
    test_snapshot_reclamation();
    check(rt_allocations == 0, "engine render and device callbacks allocate no C++ storage");
    std::filesystem::remove_all(dir);
    return failures == 0 ? 0 : 1;
}
