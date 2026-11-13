// Exercise the real engine -> PCM ring -> device callback without hardware.
#include "liveplay/audio/callback_liveness.hpp"
#include "liveplay/audio/device_clock_controller.hpp"
#include "liveplay/audio/limiter.hpp"
#include "liveplay/audio/meter.hpp"
#include "liveplay/audio/mixer_channel.hpp"
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
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <new>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

// Expose only playback/engine state for deterministic headless render gates.
#include "liveplay/audio/playback_item.hpp"
#include "liveplay/audio/engine.hpp"

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

// Intercept the real null backend, so native device waits need no hardware.
struct NativeDeviceGate {
    ma_context context{};
    ma_backend_callbacks original{};
    std::atomic<bool> hold_start{false}, hold_stop{false}, hold_uninit{false}, fail_start{false}, entered{false};
    NativeDeviceGate() {
        const ma_backend backend = ma_backend_null;
        auto config = ma_context_config_init();
        config.pUserData = this;
        if (ma_context_init(&backend, 1, &config, &context) != MA_SUCCESS) std::abort();
        original = context.callbacks;
        context.callbacks.onDeviceStart = [](ma_device* device) {
            auto& gate = *static_cast<NativeDeviceGate*>(device->pContext->pUserData);
            if (gate.hold_start.load()) {
                gate.entered.store(true);
                while (gate.hold_start.load()) std::this_thread::sleep_for(std::chrono::milliseconds{1});
            }
            return gate.fail_start.load() ? MA_ERROR : gate.original.onDeviceStart(device);
        };
        context.callbacks.onDeviceStop = [](ma_device* device) {
            auto& gate = *static_cast<NativeDeviceGate*>(device->pContext->pUserData);
            if (gate.hold_stop.load()) {
                gate.entered.store(true);
                while (gate.hold_stop.load()) std::this_thread::sleep_for(std::chrono::milliseconds{1});
            }
            return gate.original.onDeviceStop(device);
        };
        context.callbacks.onDeviceUninit = [](ma_device* device) {
            auto& gate = *static_cast<NativeDeviceGate*>(device->pContext->pUserData);
            if (gate.hold_uninit.load()) {
                gate.entered.store(true);
                while (gate.hold_uninit.load()) std::this_thread::sleep_for(std::chrono::milliseconds{1});
            }
            return gate.original.onDeviceUninit(device);
        };
    }
    ~NativeDeviceGate() { ma_context_uninit(&context); }
    bool wait_entered() {
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds{2};
        while (!entered.load() && std::chrono::steady_clock::now() < deadline)
            std::this_thread::sleep_for(std::chrono::milliseconds{1});
        return entered.load();
    }
};

void test_initial_device_start_keeps_controls() {
  for (const int mode : {0, 1, 2}) { // Start, duplicate cleanup, failed-start cleanup.
    NativeDeviceGate gate;
    AudioEngine engine;
    engine.device_test_context_ = &gate.context;
    const auto original = mode == 1 ? engine.open_default_device() : DeviceId{};
    gate.hold_start.store(mode == 0);
    gate.hold_uninit.store(mode != 0);
    gate.fail_start.store(mode == 2);
    auto open = std::async(std::launch::async, [&] { return engine.open_default_device(); });
    check(gate.wait_entered(), "actual null-backend start/duplicate/failure cleanup reaches held native call");
    auto controls = std::async(std::launch::async, [&] {
        engine.stop_all(); engine.set_master_ceiling_db(-6.0f);
        return !engine.find_cue(CueId{"missing"});
    });
    check(controls.wait_for(std::chrono::milliseconds{250}) == std::future_status::ready,
          "Stop All, settings and cue introspection survive held device start/cleanup");
    std::future<DeviceId> reuse;
    if (!original.empty()) {
        reuse = std::async(std::launch::async, [&] { return engine.open_device_by_name(original.value); });
        check(reuse.wait_for(std::chrono::milliseconds{250}) == std::future_status::ready,
              "already opened runtime device can be acquired during duplicate cleanup");
    }
    if (mode != 0)
        check(open.wait_for(std::chrono::milliseconds{250}) == std::future_status::ready,
              "duplicate or failed start returns while its owned cleanup is held");
    gate.hold_start.store(false); gate.hold_uninit.store(false);
    const auto id = open.get();
    check(controls.get() && (mode == 2 ? id.empty() : !id.empty()),
          "native return preserves successful opens and failed-start refusal");
    if (!id.empty()) {
        const auto device = engine.devices_.front();
        check(mode != 1 || (id == original && reuse.get() == original &&
              device->open_references.value() == 3), "duplicate and runtime acquisitions share one native output");
        engine.close_device(id);
        if (mode == 1) { engine.close_device(id); engine.close_device(id); }
        while (!device->cleanup_done.load(std::memory_order_acquire)) std::this_thread::sleep_for(std::chrono::milliseconds{1});
        std::vector<float> samples(4096, 0.9f);
        device->outputs.front().limiter->process(samples.data(), samples.size());
        check(*std::max_element(samples.begin(), samples.end()) < 0.51f,
              "ceiling changed during native wait is applied to the opened output");
    }
  }
}

void test_held_device_recovery_lifetime() {
  for (const bool during_start : {false, true}) for (const int mode : {0, 1, 2}) { // Stop/restart, Close, destruction.
    NativeDeviceGate gate;
    auto engine = std::make_unique<AudioEngine>();
    engine->device_test_context_ = &gate.context;
    check(engine->start(), "recovery lifetime: real null-backend engine starts");
    auto device = engine->devices_.front();
    const auto id = device->id;
    gate.hold_stop.store(!during_start); gate.hold_start.store(during_start); gate.entered.store(false);
    check(engine->request_device_recovery(id).has_value(), "recovery lifetime: explicit recovery accepted");
    check(gate.wait_entered(), "recovery lifetime: actual native stop is held");
    auto finish = std::async(std::launch::async, [&] {
        if (mode == 0) engine->stop();
        else if (mode == 1) engine->close_device(id);
        else engine.reset();
    });
    const bool responsive = finish.wait_for(std::chrono::milliseconds{250}) == std::future_status::ready;
    check(responsive, "recovery lifetime: Stop, Close and destruction do not wait for native recovery");
    if (responsive && mode == 0) check(engine->start(), "recovery lifetime: engine can restart before old native work returns");
    gate.hold_stop.store(false); gate.hold_start.store(false); finish.get();
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds{2};
    while (device->recovery_in_progress.load() && std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(std::chrono::milliseconds{1});
    check(!device->started.load() && (mode != 0 || ma_device_get_state(device->ma_dev.get()) == ma_device_state_stopped),
          "recovery lifetime: obsolete native return cannot restart a closed/stopped generation");
    if (mode != 0) {
        ma_device_notification late{};
        ma_device retained{}; retained.pUserData = device.get(); retained.playback.channels = device->channels;
        late.pDevice = &retained;
        late.type = ma_device_notification_type_interruption_began;
        AudioEngine::ma_notification_callback(&late);
        std::array<float, 16> samples{}; samples.fill(1.0f);
        AudioEngine::ma_data_callback(&retained, samples.data(), nullptr, 8);
        check(device->runtime_state.load() == DeviceRuntimeState::Closing &&
              std::all_of(samples.begin(), samples.end(), [](float value) { return value == 0.0f; }),
              "recovery lifetime: late callbacks keep Closing/silence without accessing a destroyed engine");
    }
    if (engine) engine.reset();
    std::weak_ptr<AudioEngine::Device> weak = device;
    device.reset();
    while (!weak.expired() && std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(std::chrono::milliseconds{1});
    check(weak.expired(), "recovery lifetime: retained native state retires after return without a leaked device");
  }
}

void test_device_catalog_survives_native_stall() {
  for (const bool cold : {false, true}) {
    NativeDeviceGate gate;
    auto engine = std::make_unique<AudioEngine>();
    engine->device_test_context_ = &gate.context;
    const auto id = engine->open_default_device();
    auto device = engine->devices_.front();
    const auto catalog = engine->device_catalog_;
    if (!cold) (void)engine->enumerate_devices();
    const auto wait_catalog = [&] {
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds{2};
        for (;;) {
            { std::lock_guard lock{catalog->mutex}; if (!catalog->refreshing) return true; }
            if (std::chrono::steady_clock::now() >= deadline) return false;
            std::this_thread::sleep_for(std::chrono::milliseconds{1});
        }
    };
    check(wait_catalog(), "device catalog: initial native enumeration settles");
    gate.entered.store(false); gate.hold_uninit.store(true);
    engine->close_device(id);
    check(gate.wait_entered(), "device catalog: actual native uninit holds backend serialization");
    auto status = std::async(std::launch::async, [&] { return engine->enumerate_devices(); });
    const bool responsive = status.wait_for(std::chrono::milliseconds{250}) == std::future_status::ready;
    check(responsive, "device catalog: enumeration/status never waits behind a hung native operation");
    std::vector<DeviceInfo> devices;
    if (responsive) { devices = status.get(); engine.reset(); }
    // The old engine still owns a blocked uninit. A new open must return a bounded failure.
    AudioEngine replacement;
    replacement.device_test_context_ = &gate.context;
    auto reopen = std::async(std::launch::async, [&] { return replacement.open_default_device(); });
    const bool open_refused = reopen.wait_for(std::chrono::seconds{1}) == std::future_status::ready;
    check(open_refused, "device catalog: cold open returns while uninit is held");
    gate.hold_uninit.store(false);
    const auto reopened = reopen.get();
    check(!open_refused || reopened.empty(), "device catalog: no init overlaps the held uninit");
    if (!reopened.empty()) {
        const auto replacement_device = replacement.snapshot_devices()->front();
        replacement.close_device(reopened);
        while (!replacement_device->cleanup_done.load()) std::this_thread::sleep_for(std::chrono::milliseconds{1});
    }
    if (!responsive) { devices = status.get(); engine.reset(); }
    check(std::none_of(devices.begin(), devices.end(), [](const auto& info) { return info.is_open; }),
          "device catalog: current withdrawal overrides cached native availability");
    check(wait_catalog(), "device catalog: owned refresh returns safely after engine destruction");
    while (!device->cleanup_done.load(std::memory_order_acquire)) std::this_thread::sleep_for(std::chrono::milliseconds{1});
    device.reset();
  }
}

void test_catalog_follows_native_reroute() {
    NativeDeviceGate gate;
    AudioEngine engine;
    engine.device_test_context_ = &gate.context;
    const auto id = engine.open_default_device();
    auto device = engine.devices_.front();
    (void)engine.enumerate_devices();
    AudioEngine::NativeDeviceInfo original, rerouted;
    original.native_id = device->ma_dev->playback.id;
    original.info.id = DeviceId{"Original"}; original.info.display_name = "Original";
    rerouted = original;
    reinterpret_cast<unsigned char*>(&rerouted.native_id)[0] ^= 1;
    rerouted.info.id = DeviceId{"Rerouted"}; rerouted.info.display_name = "Rerouted";
    {
        std::unique_lock lock{engine.device_catalog_->mutex};
        engine.device_catalog_->ready.wait_for(lock, std::chrono::seconds{2}, [&] { return !engine.device_catalog_->refreshing; });
        engine.device_catalog_->devices = {original, rerouted};
        engine.device_catalog_->has_snapshot = true;
        engine.device_catalog_->next_refresh = std::chrono::steady_clock::now() + std::chrono::hours{1};
    }
    { std::lock_guard native_lock{device->native_mutex}; device->ma_dev->playback.id = rerouted.native_id; }
    ma_device_notification moved{};
    moved.pDevice = device->ma_dev.get(); moved.type = ma_device_notification_type_rerouted;
    AudioEngine::ma_notification_callback(&moved);
    const auto devices = engine.enumerate_devices();
    check(std::any_of(devices.begin(), devices.end(), [&](const auto& info) {
        return info.id == id && info.display_name == "Rerouted" && info.is_open;
    }), "device catalog: opened runtime identity follows the current native reroute target");
    engine.close_device(id);
    while (!device->cleanup_done.load(std::memory_order_acquire)) std::this_thread::sleep_for(std::chrono::milliseconds{1});
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
        device->callback_state = engine.callback_state_;
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

void test_stop_before_render_wait_snapshot(const std::filesystem::path& source) {
    Fixture f(source);
    std::promise<void> entered, release;
    auto reached = entered.get_future();
    auto proceed = release.get_future();
    f.engine.before_render_wait_snapshot_for_test_ = [&] {
        entered.set_value();
        proceed.wait();
    };
    check(f.engine.start(), "render shutdown: software output starts");
    check(reached.wait_for(std::chrono::seconds{2}) == std::future_status::ready,
          "render shutdown: full ring holds the renderer before it snapshots the wait counter");
    auto& counter = f.engine.callback_state_->consumption_counter;
    const auto before = counter.load(std::memory_order_acquire);
    auto stop = std::async(std::launch::async, [&] { f.engine.stop(); });
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds{2};
    while (counter.load(std::memory_order_acquire) == before && std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(std::chrono::milliseconds{1});
    check(counter.load(std::memory_order_acquire) != before && !f.engine.is_running(),
          "render shutdown: stop sends its wake before the renderer snapshots the counter");
    release.set_value();
    const auto stopped = stop.wait_for(std::chrono::milliseconds{250}) == std::future_status::ready;
    check(stopped, "render shutdown: a full ring cannot strand Stop after its wake");
    // Let a broken build report its failure and exit.
    for (int i = 0; i < 400 && stop.wait_for(std::chrono::milliseconds{5}) != std::future_status::ready; ++i) {
        counter.fetch_add(1, std::memory_order_release);
        counter.notify_all();
    }
    stop.get();
}

void test_blocked_decoder_reads(const std::filesystem::path& source) {
    for (const int scenario : {0, 1, 2, 3, 4, 5, 6, 7, 8}) {
        const int blocked_count = scenario == 1 ? 3 : scenario == 4 ? 4 : scenario == 6 ? 12 : 1;
        auto fixture = std::make_unique<Fixture>(source);
        auto& f = *fixture;
        std::vector<std::shared_ptr<PlaybackItem>> blocked;
        const auto silent = f.engine.create_mixer_channel("Held decoder fixture");
        for (int i = 0; i < blocked_count; ++i) {
            const auto id = f.engine.load_cue_no_route(source);
            auto item = f.engine.find_cue(id);
            check(item && item->prime(2.0), "blocked read: real source prepares resident PCM before the fault");
            item->play(); blocked.push_back(item);
            f.engine.route_item_source_to_mixer(id, 0, silent, 0, 0.0f);
        }
        std::promise<void> release;
        const auto allowed = release.get_future().share();
        std::atomic<int> entered{0};
        auto* first_backend = static_cast<ma_data_source_base*>(blocked.front()->decoder_->pBackend);
        const auto* original = first_backend->vtable;
        auto stalled = *original;
        static std::function<ma_result(ma_data_source*, void*, ma_uint64, ma_uint64*)> read;
        read = [&](ma_data_source* decoder, void* data, ma_uint64 frames, ma_uint64* got) {
            entered.fetch_add(1, std::memory_order_release);
            allowed.wait(); return original->onRead(decoder, data, frames, got);
        };
        stalled.onRead = [](ma_data_source* decoder, void* data, ma_uint64 frames, ma_uint64* got) {
            return read(decoder, data, frames, got);
        };
        for (const auto& item : blocked)
            static_cast<ma_data_source_base*>(item->decoder_->pBackend)->vtable = &stalled;
        check(f.engine.start(), "blocked read: production engine workers start with software output");
        for (int i = 0; i < 250 && entered.load(std::memory_order_acquire) < blocked_count; ++i)
            std::this_thread::sleep_for(std::chrono::milliseconds{2});
        check(entered.load() == blocked_count, "blocked read: each requested backend is held inside actual read");
        if (scenario == 8) {
            const auto& item = blocked.front();
            auto retire = std::async(std::launch::async, [&] { f.engine.unload_cue(item->id()); });
            check(retire.wait_for(std::chrono::milliseconds{250}) == std::future_status::ready &&
                      !f.engine.find_cue(item->id()) && !item->decoder_ready_.load(),
                  "blocked read: cue removal retires its worker without waiting for the native read");
            release.set_value(); retire.get();
            f.engine.stop_all(std::chrono::milliseconds{0}, true); f.engine.stop();
            { std::lock_guard io_complete{item->decoder_mutex_};
              if (item->decoder_) static_cast<ma_data_source_base*>(item->decoder_->pBackend)->vtable = original; }
            read = {}; continue;
        }
        if (scenario == 5) {
            f.engine.remove_mixer_channel(silent);
            f.engine.stop();
            auto restart = std::async(std::launch::async, [&] { return f.engine.start(); });
            const bool restarted = restart.wait_for(std::chrono::milliseconds{250}) == std::future_status::ready;
            check(restarted,
                  "blocked read: rebuilding an unrouted cue during restart does not wait for its read");
            bool routed = false;
            if (restarted) {
                std::lock_guard lock{f.engine.mutex_};
                const auto found = f.engine.pending_.item_sources.find(blocked.front()->id().value);
                if (found != f.engine.pending_.item_sources.end() && !found->second.by_source_channel.empty())
                    routed = std::any_of(found->second.by_source_channel[0].begin(),
                        found->second.by_source_channel[0].end(), [&](const auto& send) {
                            return send.mixer == f.engine.main_mixer_ && send.lane == kAllMixerLanes && send.gain_lin == 1.0f;
                        });
            }
            check(routed, "blocked read: restart retains the actual mono unity routes while storage is held");
            auto stop = std::async(std::launch::async, [&] { f.engine.stop_all(std::chrono::milliseconds{0}, true); });
            check(stop.wait_for(std::chrono::milliseconds{250}) == std::future_status::ready &&
                      f.item->stats().transport == TransportState::Stopped,
                  "blocked read: route reconstruction does not block Stop All engine ownership");
            release.set_value(); check(restart.get(), "blocked read: routing restart is accepted");
            stop.get(); f.engine.stop();
            { std::lock_guard io_complete{blocked.front()->decoder_mutex_};
              first_backend->vtable = original; }
            read = {}; continue;
        }
        if (scenario == 3) {
            f.engine.stop_all(std::chrono::milliseconds{0}, true);
            std::weak_ptr<PlaybackItem> retained = blocked.front();
            std::weak_ptr<PlaybackItem> unrelated = f.item;
            std::weak_ptr workers = f.engine.decode_state_;
            blocked.clear();
            auto destroy = std::async(std::launch::async, [owner = std::move(fixture)]() mutable { owner.reset(); });
            const bool retired = destroy.wait_for(std::chrono::milliseconds{250}) == std::future_status::ready;
            check(retired, "blocked read: engine destruction does not wait for storage");
            if (retired) {
                for (int i = 0; i < 250 && !unrelated.expired(); ++i)
                    std::this_thread::sleep_for(std::chrono::milliseconds{1});
                check(unrelated.expired() && !retained.expired(),
                    "blocked read: only the in-flight decoder stays owned after engine destruction");
            }
            release.set_value(); destroy.get();
            for (int i = 0; i < 1000 && (!retained.expired() || !workers.expired()); ++i)
                std::this_thread::sleep_for(std::chrono::milliseconds{2});
            check(retained.expired() && workers.expired(),
                  "blocked read: delayed return releases retained decoder and worker ownership");
            read = {}; continue;
        }
        bool stopped_before_release = true;
        if (scenario >= 2) {
            auto pause = std::async(std::launch::async, [&] { f.engine.stop(); });
            stopped_before_release = pause.wait_for(std::chrono::milliseconds{250}) == std::future_status::ready;
            check(stopped_before_release, "blocked read: engine stop completes before storage release");
            if (stopped_before_release) {
                pause.get();
                for (int i = 0; i < 5; ++i) {
                    check(f.engine.start(), "blocked read: deliberate engine restart remains available");
                    if (i < 4) f.engine.stop();
                }
            } else {
                release.set_value(); pause.get();
            }
        }
        constexpr int expected_blocks = 64;
        constexpr auto block_period = std::chrono::microseconds{block * 1'000'000 / 48'000};
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds{3};
        int drained_blocks = 0, audible_blocks = 0;
        // Consume at device cadence and count only blocks the render worker produced.
        while (drained_blocks < expected_blocks && std::chrono::steady_clock::now() < deadline) {
            if (ma_pcm_rb_available_read(f.device->ring.get()) >= block) {
                const auto out = f.drain();
                ++drained_blocks;
                if (std::any_of(out.begin(), out.end(), [](float sample) { return sample > 0.05f; }))
                    ++audible_blocks;
            }
            std::this_thread::sleep_for(block_period);
        }
        std::printf("MEASURE blocked_read_sources=%d drained_blocks=%d/%d healthy_pcm_blocks=%d\n",
                    blocked_count, drained_blocks, expected_blocks, audible_blocks);
        if (stopped_before_release) {
            check(drained_blocks == expected_blocks && audible_blocks >= 48 && f.item->stats().playhead_frame > 8'192,
                  "blocked read: healthy PCM continues beyond all resident queue/ring capacity");
            check(entered.load() == blocked_count,
                  "blocked read: restart retains the existing blocked calls without retrying them");
        }
        if (scenario == 7) {
            const auto& item = blocked.front();
            check(item->had_decode_error() && item->stats().transport == TransportState::Stopped &&
                      item->stats().decoder_result == MA_TIMEOUT && !item->take_natural_end(),
                  "blocked read: sustained missing PCM fails only its cue without a natural end");
            const auto frame = item->stats().playhead_frame;
            release.set_value();
            { std::lock_guard io_complete{item->decoder_mutex_}; first_backend->vtable = original; }
            std::array<float, block> left{}, right{}; float* channels[]{left.data(), right.data()};
            check(item->render_block(channels, 2, block) == 0 &&
                      item->stats().transport == TransportState::Stopped && item->stats().playhead_frame == frame,
                  "blocked read: a late real backend return cannot re-enter the show");
            f.engine.stop();
            check(item->prime(2.0, 0.25), "blocked read: deliberate retry after failure prepares fresh PCM");
            item->play();
            check(item->render_block(channels, 2, block) == block && std::abs(left[0] - 0.1f) < 1e-6f,
                  "blocked read: deliberate retry after failure is audible at its authored level");
            f.engine.stop_all(std::chrono::milliseconds{0}, true); f.engine.stop();
            read = {}; continue;
        }
        auto stop = std::async(std::launch::async, [&] {
            f.engine.stop_all(std::chrono::milliseconds{0}, true);
        });
        check(stop.wait_for(std::chrono::milliseconds{250}) == std::future_status::ready &&
                  f.item->stats().transport == TransportState::Stopped,
              "blocked read: Stop All remains independent of held reads");
        std::vector<std::uint64_t> stopped_frames;
        for (const auto& item : blocked) stopped_frames.push_back(item->stats().playhead_frame);
        if (stopped_before_release) release.set_value();
        stop.get(); f.engine.stop();
        for (std::size_t i = 0; i < blocked.size(); ++i) {
            const auto& item = blocked[i];
            std::lock_guard io_complete{item->decoder_mutex_};
            static_cast<ma_data_source_base*>(item->decoder_->pBackend)->vtable = original;
            check(item->stats().transport == TransportState::Stopped && item->stats().playhead_frame == stopped_frames[i],
                  "blocked read: delayed decoder return cannot revive stopped transport");
        }
        if (scenario >= 2) {
            const auto& retry = blocked.front();
            check(retry->prime(2.0, 0.25), "blocked read: deliberate retry primes the requested In point");
            retry->play();
            std::array<float, block> left{}, right{}; float* channels[]{left.data(), right.data()};
            check(retry->stats().playhead_frame == 12'000 &&
                      retry->render_block(channels, 2, block) == block && std::abs(left[0] - 0.1f) < 1e-6f,
                  "blocked read: deliberate retry renders fresh PCM at the requested position");
            retry->stop_now();
        }
        read = {};
    }
}

void test_source_starvation(const std::filesystem::path& source, const std::filesystem::path& silence) {
    for (const SampleRate rate : {44'100u, 48'000u, 96'000u}) {
        PlaybackItemDesc desc; desc.id = CueId{"starvation"}; desc.file_path = source;
        desc.mix_sample_rate = rate; desc.render_block = block;
        PlaybackItem item{desc};
        check(item.load() && item.prime(2.0), "starvation: actual source prepares at the requested mix rate");
        item.play();
        std::array<float, block> left{}, right{}; float* channels[]{left.data(), right.data()};
        item.render_block(channels, 2, block);
        std::printf("MEASURE source_mix_rate=%u initial_first=%.8f initial_settled=%.8f\n", rate, left[0], left.back());
        for (int i = 1; i < 16; ++i) item.render_block(channels, 2, block);
        const auto missing = [&](std::size_t frames) {
            while (frames > 0) {
                const auto n = std::min(frames, block);
                measure_allocations = true; item.render_block(channels, 2, n); measure_allocations = false;
                frames -= n;
            }
        };
        missing(rate / 4 - 1);
        check(item.stats().transport == TransportState::Playing && !item.had_decode_error(),
              "starvation: a gap shorter than 250 ms is recoverable");
        item.service_read_ahead(1);
        check(item.render_block(channels, 2, block) == block && std::abs(left[0] - 0.1f) < 1e-6f,
              "starvation: brief missing PCM recovers with original decoded audio");
        missing(rate / 4 - 1);
        check(!item.had_decode_error(), "starvation: successful PCM resets the continuous-gap budget");
        missing(1);
        check(item.stats().transport == TransportState::Stopped && item.had_decode_error() &&
                  item.stats().decoder_result == MA_TIMEOUT && !item.take_natural_end(),
              "starvation: 250 ms missing PCM is an error and cannot advance a cue");
        check(item.take_decode_error() == MA_TIMEOUT && item.take_decode_error() == 0 && item.had_decode_error(),
              "starvation: one error edge retains the stopped failure for reconnects");
        item.service_read_ahead(1);
        check(item.render_block(channels, 2, block) == 0 && left[0] == 0.0f,
              "starvation: data returning after failure cannot resume playback");
        check(item.prime(2.0, 0.25), "starvation: explicit recovery primes after the decoder is available");
        item.play();
        const auto rendered = item.render_block(channels, 2, block);
        std::printf("MEASURE source_mix_rate=%u retry_first=%.8f retry_settled=%.8f\n", rate, left[0], left.back());
        check(rendered == block && std::abs(left.back() - 0.1f) < 1e-6f &&
                  !item.had_decode_error(), "starvation: explicit retry returns original PCM without a stale error");
    }
    PlaybackItemDesc desc; desc.id = CueId{"silence"}; desc.file_path = silence;
    PlaybackItem item{desc}; check(item.load() && item.prime(2.0), "starvation: intentional silence loads");
    item.play();
    std::array<float, block> left{}, right{}; float* channels[]{left.data(), right.data()};
    for (int i = 0; i < 100; ++i) { item.service_read_ahead(1); item.render_block(channels, 2, block); }
    check(item.stats().transport == TransportState::Playing && !item.had_decode_error(),
          "starvation: decoded digital silence is not missing PCM");
    item.stop_now(); item.set_fade_out(std::chrono::milliseconds{500}); item.prime(0.0); item.play(); item.stop();
    for (int i = 0; i < 100; ++i) item.render_block(channels, 2, block);
    check(item.stats().transport == TransportState::Stopped && !item.had_decode_error(),
          "starvation: an explicit stop fade settles without PCM or a false failure");
}

void test_channel_map_reload(const std::filesystem::path& mono, const std::filesystem::path& stereo) {
    const auto path = mono.parent_path() / "channel-map-reload.wav";
    std::filesystem::copy_file(mono, path, std::filesystem::copy_options::overwrite_existing);
    PlaybackItemDesc desc; desc.id = CueId{"channel-map-reload"}; desc.file_path = path;
    PlaybackItem item{std::move(desc)};
    check(item.load() && item.stereo_mix_gains(0) == std::array<float, 2>{1.0f, 1.0f},
          "routing map: mono load supplies unity to both lanes");
    item.unload();
    check(item.stereo_mix_gains(0) == std::array<float, 2>{0.0f, 0.0f},
          "routing map: unloaded decoder has no stale sends");
    std::filesystem::copy_file(stereo, path, std::filesystem::copy_options::overwrite_existing);
    check(item.load() && item.stereo_mix_gains(0) == std::array<float, 2>{1.0f, 0.0f} &&
              item.stereo_mix_gains(1) == std::array<float, 2>{0.0f, 1.0f} &&
              item.stereo_mix_gains(2) == std::array<float, 2>{0.0f, 0.0f},
          "routing map: reloading changed channel layout replaces every send");
    item.desc_.file_path = path.parent_path() / "missing-reload.wav";
    check(!item.load() && item.stereo_mix_gains(0) == std::array<float, 2>{0.0f, 0.0f},
          "routing map: failed reload cannot expose a previous format");
    std::filesystem::remove(path);
}

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

void test_clock_zero_crossing(const std::filesystem::path& ramp) {
    for (const int direction : {-1, 1}) {
        Fixture f(ramp, false, true);
        f.render(8);
        f.device->clock_controller.configure(block * 16,
            block * (8 + direction * 4));
        auto out = f.drain();
        f.device->clock_controller.configure(block * 16,
            ma_pcm_rb_available_read(f.device->ring.get()));
        const auto next = f.drain();
        out.insert(out.end(), next.begin(), next.end());
        float min_step = 2.0f, max_step = 0.0f;
        int audible = 0;
        for (std::size_t i = 2; i < out.size(); i += 2) {
            if (out[i] == 0.0f || out[i - 2] == 0.0f) continue;
            if (++audible < 3) continue; // Ignore initial resampler cache priming.
            const float step = (out[i] - out[i - 2]) * 131'072.0f;
            min_step = std::min(min_step, step);
            max_step = std::max(max_step, step);
        }
        std::printf("clock returns to unity from %d: step %.6f..%.6f\n",
                    direction, min_step, max_step);
        check(audible > static_cast<int>(block / 2) &&
                  min_step >= 0.98f && max_step <= 1.02f,
              "clock returning to nominal speed preserves fractional PCM position");
    }
}

void test_clock_resync(const std::filesystem::path& ramp) {
    constexpr double seconds = 600.0;
    constexpr float slope = 1.0f / 131'072.0f;
    for (const double drift_ppm : {-3'000.0, 0.0, 3'000.0}) {
      for (const double phase : {0.1, 0.9}) {
        Fixture f(ramp, false, true);
        f.item->set_loop(true, 0.0);
        // Keep equal headroom around a callback's one-block consumption.
        ma_pcm_rb_uninit(f.device->ring.get());
        if (ma_pcm_rb_init(ma_format_f32, 2, block * 4, nullptr, nullptr,
                          f.device->ring.get()) != MA_SUCCESS) std::abort();
        f.device->clock_controller.configure(block * 4, block * 5 / 2);
        f.render(3);
        const double period = 1.0 / (1.0 + drift_ppm / 1'000'000.0);
        double render_at = 1.0, callback_at = phase;
        std::uint64_t callbacks = 0;
        std::uint64_t decoded_frames = 0;
        bool continuous_pcm = true;
        std::size_t measured = 0;
        double correction_sum = 0.0;
        std::size_t corrections = 0;
        float max_correction = 0.0f;
        float previous = 0.0f, min_step = 2.0f, max_step = 0.0f;
        std::uint32_t minimum = block * 4, maximum = 0;
        while (callback_at < seconds * 48'000 / block) {
            if (render_at <= callback_at) {
                f.render();
                render_at += 1.0;
                continue;
            }
            const auto out = f.drain();
            if (callback_at > 48'000.0 / block) {
                decoded_frames += block;
                for (std::size_t i = 0; i < block; ++i)
                    continuous_pcm &= std::isfinite(out[i * 2]) &&
                        out[i * 2] > 0.12f && out[i * 2] < 0.50f;
            }
            const float correction = f.device->clock_correction_ppm.load();
            max_correction = std::max(max_correction, std::fabs(correction));
            if (callback_at > seconds * 48'000 / block / 2) {
                correction_sum += correction;
                ++corrections;
            }
            const auto occupancy = ma_pcm_rb_available_read(f.device->ring.get());
            minimum = std::min(minimum, occupancy);
            maximum = std::max(maximum, occupancy);
            // The exact binary ramp stays below the ceiling; ignore initial
            // lookahead silence and measure slope before the first intentional loop wrap.
            if (callback_at < 0.7 * 48'000 / block) {
                for (std::size_t i = 0; i < block; ++i) {
                    const float sample = out[i * 2];
                    if (previous > 0.0f && sample > 0.0f) {
                        ++measured;
                        const float step = (sample - previous) / slope;
                        min_step = std::min(min_step, step);
                        max_step = std::max(max_step, step);
                    }
                    previous = sample;
                }
            }
            // Alternate callback delivery by about 1 ms across master ticks.
            ++callbacks;
            callback_at = phase + callbacks * period + (callbacks % 2 ? 0.2 : -0.2);
        }
        std::printf("clock drift %.0f ppm phase %.1f: step %.6f..%.6f, "
                    "mean correction %.2f ppm, ring %u..%u, "
                    "underruns %llu, overruns %llu, resyncs %llu, decoded PCM frames %llu\n",
                    drift_ppm, phase, min_step, max_step,
                    correction_sum / corrections, minimum, maximum,
                    static_cast<unsigned long long>(f.device->underrun_count.load()),
                    static_cast<unsigned long long>(f.device->overrun_count.load()),
                    static_cast<unsigned long long>(f.device->hard_resync_count.load()),
                    static_cast<unsigned long long>(decoded_frames));
        check(measured > block && min_step >= 0.98f && max_step <= 1.02f,
              "clock rate changes preserve callback PCM continuity");
        check(continuous_pcm && decoded_frames > (seconds - 2.0) * 48'000 *
                  (1.0 + drift_ppm / 1'000'000.0),
              "clock endurance: every measured callback contains decoded source PCM after the first second");
        check(max_correction <= DeviceClockController::max_correction_ppm(),
              "realized clock correction stays within its safety bound");
        check(f.device->underrun_count.load() == 0 &&
                  f.device->overrun_count.load() == 0 &&
                  f.device->hard_resync_count.load() == 0,
              "real resampler avoids resync at production ring size for ten simulated minutes of decoded PCM");
      }
    }
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

void test_busy_follow(const std::filesystem::path& quiet,
                      const std::filesystem::path& next) {
  for (const bool source_busy : {false, true}) {
   for (const bool target_first : {false, true}) {
    for (const bool cancel : {false, true}) {
    Fixture f(quiet);
    const auto target_id = f.engine.load_cue_no_route(next);
    const auto mixer = f.engine.snapshot_topology()->mixers.front()->id();
    f.engine.route_item_source_to_mixer(target_id, 0, mixer, 0, 0.0f);
    const auto target = f.engine.find_cue(target_id);
    check(target->prime(2.0), "busy follow: target primes");
    constexpr std::uint64_t endpoint = 1'013;
    f.item->set_out_point_seconds(1'013.25 / 48'000.0);
    f.item->service_read_ahead(16);
    const auto follow = f.engine.schedule_follow(f.item->id(), target_id, endpoint);
    check(static_cast<bool>(follow), "busy follow: source/target schedule");
    if (!follow) continue;
    std::vector<float> source_left(endpoint), source_right(endpoint);
    float* channels[]{source_left.data(), source_right.data()};
    f.item->render_block(channels, 2, endpoint);
    auto topology = std::const_pointer_cast<Topology>(f.engine.snapshot_topology());
    std::sort(topology->items.begin(), topology->items.end(), [&](auto& a, auto& b) {
        return target_first ? a.item == target && b.item != target
                            : a.item != target && b.item == target;
    });
    const auto held = source_busy ? f.item : target;
    held->begin_render_exclusion();
    f.render(); f.drain();
    check(follow->status.load() == PreparedFollow::State::Armed &&
              target->stats().transport == TransportState::Stopped &&
              f.item->stats().playhead_frame == endpoint,
          "busy follow: transient source/target gate retains valid handoff at authored endpoint");
    if (cancel) (source_busy ? target : f.item)->stop_now();
    held->end_render_exclusion();
    f.render();
    const auto output = f.drain();
    if (cancel) check(follow->status.load() == PreparedFollow::State::Cancelled &&
              target->stats().transport == TransportState::Stopped,
          "busy follow: explicit stop during contention cancels without a late start");
    else check(follow->status.load() == PreparedFollow::State::Fired &&
              target->stats().playhead_frame == block &&
              std::any_of(output.begin(), output.end(), [](float sample) { return sample > 0.19f; }),
          "busy follow: first available callback starts target PCM without sequencer polling");
    }
   }
  }
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
    engine.callback_state_->watchdog_cv.notify_all();
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
    const auto silence = wav(dir, "silence.wav", 0.0f, true);
    const auto next = wav(dir, "next.wav", 0.2f, true, 0.00001f);
    const auto center = wav(dir, "center.wav", 0.7f, true, 0.0f, 6, 2);
    const auto left = wav(dir, "left.wav", 0.3f, true, 0.0f, 2, 0);
    const auto ramp = wav(dir, "ramp.wav", 0.125f, true, 1.0f / 131'072.0f);
    test_initial_device_start_keeps_controls();
    test_held_device_recovery_lifetime();
    test_device_catalog_survives_native_stall();
    test_catalog_follows_native_reroute();
    test_stop_before_render_wait_snapshot(quiet);
    test_blocked_decoder_reads(quiet);
    test_source_starvation(quiet, silence);
    test_channel_map_reload(quiet, left);
    test_shared_output(tone, false);
    test_shared_output(tone, true);
    test_delay_and_bypass(quiet);
    test_live_ceiling(tone);
    test_clock_zero_crossing(ramp);
    test_clock_resync(ramp);
    test_exact_follow(quiet, next, false);
    test_exact_follow(quiet, next, true);
    test_busy_follow(quiet, next);
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
