#include "liveplay/audio/callback_liveness.hpp"
#include "liveplay/audio/device_clock_controller.hpp"
#include "liveplay/audio/limiter.hpp"
#include "liveplay/audio/meter.hpp"
#include "liveplay/audio/mixer_channel.hpp"
#include <miniaudio.h>
#include <atomic>
#include <condition_variable>
#include <filesystem>
#include <memory>
#include <mutex>
#include <optional>
#include <thread>
#include <unordered_map>
#include <vector>
// Headless engine setup and deterministic render-side decoder-failure publication.
#include "liveplay/audio/playback_item.hpp"
#include "liveplay/audio/engine.hpp"
#include "liveplay/core/project_state.hpp"
#include "liveplay/util/atomic_file.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <future>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace liveplay::core { std::size_t completed_load_workers_for_test(); }

using json = nlohmann::json;
using namespace std::chrono_literals;

namespace {
int failures = 0;
void check(bool ok, const char* label) {
    std::printf("%-68s %s\n", label, ok ? "PASS" : "FAIL");
    if (!ok) ++failures;
}
void set_loader_gate(const std::filesystem::path& gate, const char* name = "DWCUE_TEST_LOADER_GATE") {
    const auto value = gate.string();
#ifdef _WIN32
    _putenv_s(name, value.c_str());
#else
    setenv(name, value.c_str(), 1);
#endif
}
void clear_loader_gate(const char* name = "DWCUE_TEST_LOADER_GATE") {
#ifdef _WIN32
    _putenv_s(name, "");
#else
    unsetenv(name);
#endif
}

void u16(std::ofstream& out, std::uint16_t v) {
    const char b[]{static_cast<char>(v), static_cast<char>(v >> 8)};
    out.write(b, 2);
}
void u32(std::ofstream& out, std::uint32_t v) {
    const char b[]{static_cast<char>(v), static_cast<char>(v >> 8),
                   static_cast<char>(v >> 16), static_cast<char>(v >> 24)};
    out.write(b, 4);
}
const std::filesystem::path& fixture_dir() {
    static const auto path = std::filesystem::temp_directory_path() /
        ("dwcue-project-state-runtime-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    return path;
}

std::filesystem::path make_wav(std::int16_t sample = 0, std::uint32_t frames = 48'000) {
    static std::size_t file_number = 0;
    const auto path = fixture_dir() / (std::to_string(++file_number) + ".wav");
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    out.write("RIFF", 4); u32(out, 36 + frames * 2); out.write("WAVEfmt ", 8);
    u32(out, 16); u16(out, 1); u16(out, 1); u32(out, 48'000); u32(out, 96'000);
    u16(out, 2); u16(out, 16); out.write("data", 4); u32(out, frames * 2);
    std::array<char, 4096> zero{};
    for (std::size_t i = 0; i < zero.size(); i += 2) {
        zero[i] = static_cast<char>(sample);
        zero[i + 1] = static_cast<char>(sample >> 8);
    }
    for (std::uint32_t left = frames * 2; left > 0;) {
        const auto n = std::min<std::uint32_t>(left, zero.size());
        out.write(zero.data(), n); left -= n;
    }
    return path;
}
json audio(const std::string& id, const std::filesystem::path& path,
           json extra = json::object()) {
    json item{{"uuid", id}, {"type", "audio"}, {"displayName", id},
              {"mediaServerPath", path.string()}, {"fadeInDuration", 0.0},
              {"fadeOutDuration", 0.0}};
    item.update(extra);
    return item;
}
bool wait_ready(liveplay::core::ProjectState& state) {
    for (int i = 0; i < 400; ++i) {
        const auto ready = state.audio_readiness();
        if (!ready.value("loading", true)) return ready.value("ready", false);
        std::this_thread::sleep_for(5ms);
    }
    return false;
}
void close_devices(liveplay::audio::AudioEngine& engine) {
    for (const auto& device : engine.enumerate_devices())
        if (device.is_open) engine.close_device(device.id);
}
bool on_air(liveplay::core::ProjectState& state,
            liveplay::audio::AudioEngine& engine, const std::string& uuid) {
    const auto cue = state.item_to_cue_id(uuid);
    if (!cue) return false;
    const auto item = engine.find_cue(*cue);
    if (!item) return false;
    const auto t = item->stats().transport;
    return t == liveplay::audio::TransportState::Playing ||
           t == liveplay::audio::TransportState::FadingIn ||
           t == liveplay::audio::TransportState::Paused;
}
bool wait_for_on_air(liveplay::core::ProjectState& state,
                     liveplay::audio::AudioEngine& engine,
                     const std::string& uuid) {
    const auto deadline = std::chrono::steady_clock::now() + 2s;
    do {
        if (on_air(state, engine, uuid)) return true;
        std::this_thread::sleep_for(5ms);
    } while (std::chrono::steady_clock::now() < deadline);
    return on_air(state, engine, uuid);
}
void render_to_end(liveplay::core::ProjectState& state,
                   liveplay::audio::AudioEngine& engine,
                   const std::string& uuid, int limit = 400) {
    const auto cue = state.item_to_cue_id(uuid);
    if (!cue) return;
    const auto item = engine.find_cue(*cue);
    if (!item) return;
    if (!wait_for_on_air(state, engine, uuid)) return;
    std::array<float, 256> left{}, right{};
    float* channels[]{left.data(), right.data()};
    for (int i = 0; i < limit && item->stats().transport != liveplay::audio::TransportState::Stopped; ++i) {
        item->service_read_ahead(1);
        item->render_block(channels, 2, 256);
    }
    std::this_thread::sleep_for(120ms);
}
json document(json items) {
    return json{{"name", "runtime-contract"}, {"folderPath", ""},
                {"items", std::move(items)}, {"quickPlayItems", json::array()},
                {"quickPlaySlots", json::array()}, {"settings", json::object()}};
}
bool wait_gate_entered(const std::filesystem::path& gate) {
    const auto entered = std::filesystem::path{gate.string() + ".entered"};
    const auto deadline = std::chrono::steady_clock::now() + 2s;
    std::error_code error;
    while (std::chrono::steady_clock::now() < deadline) {
        if (std::filesystem::exists(entered, error)) return true;
        std::this_thread::yield();
    }
    return false;
}

void test_stop_all_during_project_boundaries(const std::filesystem::path& wav) {
    int gate_number = 0;
    const auto run_case = [&](const char* label, auto operation) {
      for (const bool queued : {false, true}) {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        const auto gate = fixture_dir() / ("boundary-" + std::to_string(++gate_number) + ".gate");
        std::ofstream{gate} << wav;
        std::filesystem::remove(gate.string() + ".entered");
        set_loader_gate(gate);
        if (queued) {
            state.replace_full_document(document(json::array()));
            check(wait_ready(state), "project boundary: empty project ready before queued load");
            state.add_item(audio("latched", wav));
        } else state.replace_full_document(document(json::array({audio("latched", wav)})));
        check(wait_gate_entered(gate), "project boundary: decoder reached deterministic gate");
        auto boundary = std::async(std::launch::async, [&] { operation(state); });
        check(boundary.wait_for(250ms) == std::future_status::ready,
              "project boundary: reset/replace/load completes before native loader return");
        auto stop = std::async(std::launch::async, [&] { state.stop_all_cues(0); });
        check(stop.wait_for(250ms) == std::future_status::ready, label);
        const bool ready = boundary.wait_for(0ms) == std::future_status::ready;
        if (ready) check(wait_ready(state), "project boundary: cancelled load does not keep a replacement show pending");
        std::filesystem::remove(gate);
        boundary.get();
        stop.get();
        clear_loader_gate();
        std::filesystem::remove(gate.string() + ".entered");
      }
    };
    run_case("project boundary: Stop All is not blocked by reset",
             [](auto& state) { state.reset(); });
    run_case("project boundary: Stop All is not blocked by replace",
             [](auto& state) { state.replace_full_document(document(json::array())); });
    run_case("project boundary: Stop All is not blocked by load",
             [](auto& state) { state.load_from_json(document(json::array())); });
}

void test_stop_all_during_decoder_read(const std::filesystem::path& wav) {
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    state.replace_full_document(document(json::array({audio("stalled-stop", wav)})));
    check(wait_ready(state), "stalled stop: fixture ready"); close_devices(engine);
    check(state.trigger_item("stalled-stop"), "stalled stop: cue starts");
    const auto item = engine.find_cue(*state.item_to_cue_id("stalled-stop"));
    std::array<float, 256> left{}, right{};
    float* channels[]{left.data(), right.data()};
    item->render_block(channels, 2, 256);
    // A decoder read owns this exact mutex for its entire filesystem call.
    std::unique_lock read_stall{item->decoder_mutex_};
    auto stop = std::async(std::launch::async, [&] { state.stop_all_cues(0); });
    check(stop.wait_for(250ms) == std::future_status::ready,
          "stalled stop: immediate Stop All completes before decoder read releases");
    check(item->stats().transport == liveplay::audio::TransportState::Stopped &&
              item->render_block(channels, 2, 256) == 0,
          "stalled stop: current cue is silent while decoder remains blocked");
    read_stall.unlock();
    stop.get();
    check(state.trigger_item("stalled-stop"), "stalled stop: deliberate replay still works");
    item->render_block(channels, 2, 256);
    check(item->stats().playhead_frame == 256,
          "stalled stop: replay begins at source start rather than stale queued position");
    state.stop_all_cues(0);
}

void test_stop_all_during_cue_retirement(const std::filesystem::path& wav) {
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    state.replace_full_document(document(json::array({audio("retirement-bed", wav)})));
    check(wait_ready(state), "retirement stall: fixture ready"); close_devices(engine);
    check(state.trigger_item("retirement-bed"), "retirement stall: program starts");
    const auto bed = engine.find_cue(*state.item_to_cue_id("retirement-bed"));
    const auto retiring_id = engine.load_cue_no_route(wav);
    const auto retiring = engine.find_cue(retiring_id);
    check(retiring && retiring->prime(2.0), "retirement stall: separate cue primes");
    retiring->play();
    std::unique_lock read_stall{retiring->decoder_mutex_};
    auto unload = std::async(std::launch::async, [&] { engine.unload_cue(retiring_id); });
    for (int i = 0; i < 200 && retiring->stats().transport != liveplay::audio::TransportState::Stopped; ++i)
        std::this_thread::sleep_for(1ms);
    check(retiring->stats().transport == liveplay::audio::TransportState::Stopped,
          "retirement stall: retiring cue is silent before decoder close");
    check(unload.wait_for(250ms) == std::future_status::ready,
          "retirement stall: unload acknowledges without a registered read-ahead worker");
    auto stop = std::async(std::launch::async, [&] { state.stop_all_cues(0); });
    check(stop.wait_for(250ms) == std::future_status::ready &&
              bed->stats().transport == liveplay::audio::TransportState::Stopped,
          "retirement stall: unrelated Stop All completes before storage release");
    read_stall.unlock(); unload.get(); stop.get();
    check(!engine.find_cue(retiring_id) && !retiring->decoder_ready_.load(),
          "retirement stall: removed cue finishes teardown without remaining registered");
}

ma_context* null_preview_context() {
    // ponytail: one process-lifetime fixture for catalog and retirement workers that outlive an engine.
    static ma_context context{};
    static const auto result = [] {
        const auto backend = ma_backend_null;
        return ma_context_init(&backend, 1, nullptr, &context);
    }();
    if (result != MA_SUCCESS) std::abort();
    return &context;
}

void test_stop_all_during_program_device_start() {
    auto* context = null_preview_context();
    static const auto start = context->callbacks.onDeviceStart;
    static std::atomic<bool> hold{false}, entered{false}, fail{false};
    context->callbacks.onDeviceStart = [](ma_device* device) {
        if (hold.load()) {
            entered.store(true);
            while (hold.load()) std::this_thread::sleep_for(1ms);
        }
        return fail.load() ? MA_ERROR : start(device);
    };
    const auto wav = make_wav(8'192, 480'000);
    for (const bool group : {false, true}) {
        liveplay::audio::AudioEngine engine;
        engine.device_test_context_ = context;
        liveplay::core::ProjectState state(engine);
        const auto routed = audio("cold-output", wav, {
            {"deviceOverride", "NULL Playback Device"}, {"duckingBehavior", {{"mode", "no-ducking"}}},
        });
        const auto target = group ? "cold-group" : "cold-output";
        const auto cue = group
            ? json{{"uuid", target}, {"type", "group"}, {"startBehavior", {{"action", "play-all"}}},
                   {"children", json::array({routed, audio("group-sibling", wav,
                        {{"duckingBehavior", {{"mode", "no-ducking"}}}})})}}
            : routed;
        check(state.replace_full_document(document(json::array({
            audio("running-bed", wav), cue, audio("backup-cue", wav),
        }))) && wait_ready(state), "first open: Program, group and backup media are ready");
        check(state.trigger_item("running-bed") && state.set_next_item_override(target),
              "first open: bed playing and cold output armed");
        const auto backup = engine.find_cue(*state.item_to_cue_id("backup-cue"));
        check(backup && backup->prime(2.0), "first open: backup cue prepared");

        const auto hold_open = [&] {
            entered.store(false);
            hold.store(true);
            auto opening = std::async(std::launch::async, [&] { return state.go(); });
            for (int i = 0; i < 1000 && !entered.load(); ++i) std::this_thread::sleep_for(2ms);
            check(entered.load(), "first open: GO entered native null-backend start");
            return opening;
        };
        auto opening = hold_open();
        auto controls = std::async(std::launch::async, [&] {
            state.stop_all_cues(0);
            return !on_air(state, engine, "running-bed") &&
                state.set_next_item_override("backup-cue") && state.go() == "backup-cue" &&
                state.state_summary().is_object() && on_air(state, engine, "backup-cue");
        });
        check(controls.wait_for(250ms) == std::future_status::ready,
              "first open: Stop All, prepared backup GO and status finish before device returns");
        hold.store(false);
        check(opening.get().empty() && controls.get(), "first open: Stop All cancels the held GO");
        check(!on_air(state, engine, "cold-output") && !on_air(state, engine, "group-sibling") &&
                  on_air(state, engine, "backup-cue") && state.device_routings_.empty() && engine.devices_.empty(),
              "first open: no late playback or route; backup stays on air");
        std::array<float, 256> left{}, right{};
        float* channels[]{left.data(), right.data()};
        backup->render_block(channels, 2, 256);
        check(left[0] > 0.2f, "first open: backup GO renders original PCM");

        std::atomic<bool> warned{false};
        state.set_ui_state_broadcaster([&](const json& event) {
            if (event.value("code", "") == "output_device_unavailable" &&
                event.value("device", "") == "NULL Playback Device") warned.store(true);
        });
        fail.store(true);
        const auto failed = state.set_next_item_override(target) && state.go().empty();
        fail.store(false);
        check(failed && warned.load() && state.next_item_override() == target &&
                  on_air(state, engine, "backup-cue") && state.device_routings_.empty(),
              "first open: native failure names the output and keeps the backup playing");
        check(state.set_next_item_override(target) && state.go() == target &&
                  on_air(state, engine, "cold-output") && state.device_routings_.size() == 1 &&
                  engine.devices_.size() == 1 && engine.devices_.front()->open_references.value() == 1,
              "first open: deliberate retry opens one shared route and reference");
        state.stop_all_cues(0);
        state.set_ui_state_broadcaster({});
        state.release_device_routings();
        check(state.set_next_item_override(target), "first open: cue armed for reset test");
        auto discarded = hold_open();
        auto reset = std::async(std::launch::async, [&] { state.reset(); });
        check(reset.wait_for(250ms) == std::future_status::ready,
              "first open: reset finishes while device start is held");
        hold.store(false);
        reset.get();
        check(discarded.get().empty() && state.device_routings_.empty() && engine.devices_.empty(),
              "first open: reset discards late route and releases its reference");
    }
}

void test_stop_all_during_system_default_open() {
    auto* context = null_preview_context();
    static const auto init = context->callbacks.onDeviceInit;
    static std::atomic<bool> hold{false}, entered{false}, fail{false};
    context->callbacks.onDeviceInit = [](ma_device* device, const ma_device_config* config,
                                       ma_device_descriptor* playback, ma_device_descriptor* capture) {
        if (!config->playback.pDeviceID) {
            if (hold.load()) {
                entered.store(true);
                while (hold.load()) std::this_thread::sleep_for(1ms);
            }
            if (fail.load()) return MA_ERROR;
        }
        return init(device, config, playback, capture);
    };
    const auto wav = make_wav(8'192, 480'000);
    for (const bool group : {false, true}) {
        liveplay::audio::AudioEngine engine;
        engine.device_test_context_ = context;
        liveplay::core::ProjectState state(engine);
        state.test_program_main_routing_ = true;
        const json named{{"deviceOverride", "NULL Playback Device"}, {"duckingBehavior", {{"mode", "no-ducking"}}}};
        const auto main = audio("cold-main", wav, {{"duckingBehavior", {{"mode", "no-ducking"}}}});
        const auto target = group ? "main-group" : "cold-main";
        const auto item = group
            ? json{{"uuid", target}, {"type", "group"}, {"startBehavior", {{"action", "play-all"}}},
                   {"children", json::array({audio("named-first", wav, named), main})}}
            : main;
        check(state.replace_full_document(document(json::array({
            audio("main-test-bed", wav, named), item, audio("main-test-backup", wav, named),
        }))) && wait_ready(state) && state.trigger_item("main-test-bed"), "Main open: named route and media ready");
        check(engine.devices_.size() == 1 && engine.main_mixer_.empty(), "Main open: only the named route is open");
        const auto backup = engine.find_cue(*state.item_to_cue_id("main-test-backup"));
        check(backup && backup->prime(2.0) && state.set_next_item_override(target), "Main open: backup primed");

        entered.store(false);
        hold.store(true);
        auto opening = std::async(std::launch::async, [&] { return state.go(); });
        for (int i = 0; i < 1000 && !entered.load(); ++i) std::this_thread::sleep_for(2ms);
        check(entered.load() && !on_air(state, engine, "named-first"), "Main open: native init waits before any group child plays");
        auto controls = std::async(std::launch::async, [&] {
            state.stop_all_cues(0);
            return !on_air(state, engine, "main-test-bed") && state.set_next_item_override("main-test-backup") &&
                state.go() == "main-test-backup" && state.state_summary().is_object();
        });
        check(controls.wait_for(250ms) == std::future_status::ready, "Main open: Stop All and named backup GO before init returns");
        hold.store(false);
        check(opening.get().empty() && controls.get() && on_air(state, engine, "main-test-backup") &&
                  !on_air(state, engine, "cold-main") && !on_air(state, engine, "named-first") &&
                  engine.main_mixer_.empty() && engine.devices_.front()->open_references.value() == 1,
              "Main open: canceled result releases its reference and leaves the backup playing");

        std::atomic<bool> warned{false};
        state.set_ui_state_broadcaster([&](const json& event) {
            if (event.value("code", "") == "output_device_unavailable" && event.value("device", "") == "System Default")
                warned.store(true);
        });
        fail.store(true);
        const auto failed = state.set_next_item_override(target) && state.go().empty();
        fail.store(false);
        check(failed && warned.load() && state.next_item_override() == target &&
                  on_air(state, engine, "main-test-backup") && !on_air(state, engine, "named-first"),
              "Main open: failed default warns and preserves backup and armed target");
        // System Default is a stream of its own beside the chosen output on
        // the same hardware, so the computer's default can move it alone.
        const auto main_follows_default = [&] {
            const auto& dest = engine.pending_.master_destinations[0];
            return dest && std::any_of(engine.devices_.begin(), engine.devices_.end(), [&](const auto& device) {
                return device->id == dest->device && device->follows_default;
            });
        };
        check(state.set_next_item_override(target) && state.go() == target && on_air(state, engine, "cold-main") &&
                  !engine.main_mixer_.empty() && engine.devices_.size() == 2 && main_follows_default() &&
                  std::all_of(engine.devices_.begin(), engine.devices_.end(),
                              [](const auto& device) { return device->open_references.value() == 1; }),
              "Main open: retry opens System Default as its own stream, one reference each");
        state.set_ui_state_broadcaster({});
        state.stop_all_cues(0);
    }
    context->callbacks.onDeviceInit = init;
}

void test_cold_outputs_keep_transport_available() {
    using namespace liveplay::audio;
    static ma_context context{};
    static const auto initialized = [] {
        const auto backend = ma_backend_null;
        return ma_context_init(&backend, 1, nullptr, &context) == MA_SUCCESS;
    }();
    if (!initialized) std::abort();
    static const auto original = context.callbacks;
    static std::atomic<bool> hold_start{false}, hold_init{false}, entered{false};
    static std::atomic<int> held_starts{0};
    context.callbacks.onContextEnumerateDevices = [](ma_context* ctx, ma_enum_devices_callback_proc cb, void* data) {
        ma_device_info info{};
        std::snprintf(info.name, sizeof(info.name), "Held Output");
        info.isDefault = MA_TRUE;
        if (cb(ctx, ma_device_type_playback, &info, data)) {
            info.id.nullbackend = 1;
            info.isDefault = MA_FALSE;
            std::snprintf(info.name, sizeof(info.name), "Backup Output");
            cb(ctx, ma_device_type_playback, &info, data);
        }
        return MA_SUCCESS;
    };
    context.callbacks.onContextGetDeviceInfo = [](ma_context* ctx, ma_device_type type,
                                                  const ma_device_id* id, ma_device_info* info) {
        const auto result = original.onContextGetDeviceInfo(ctx, type, nullptr, info);
        if (id) info->id = *id;
        std::snprintf(info->name, sizeof(info->name), "%s", id && id->nullbackend ? "Backup Output" : "Held Output");
        return result;
    };
    context.callbacks.onDeviceInit = [](ma_device* dev, const ma_device_config* config,
                                       ma_device_descriptor* playback, ma_device_descriptor* capture) {
        if (config->playback.pDeviceID && config->playback.pDeviceID->nullbackend == 0 && hold_init.load()) {
            entered.store(true);
            while (hold_init.load()) std::this_thread::sleep_for(1ms);
        }
        return original.onDeviceInit(dev, config, playback, capture);
    };
    context.callbacks.onDeviceStart = [](ma_device* dev) {
        if (dev->playback.id.nullbackend == 0) {
            ++held_starts;
            if (hold_start.load()) {
                entered.store(true);
                while (hold_start.load()) std::this_thread::sleep_for(1ms);
            }
        }
        return original.onDeviceStart(dev);
    };

    const auto wav = make_wav(8'192, 480'000);
    for (const bool init : {false, true}) {
        AudioEngine engine;
        engine.device_test_context_ = &context;
        liveplay::core::ProjectState state(engine);
        check(engine.start(false), "cold outputs: headless engine started");
        (void)engine.enumerate_devices();
        auto& catalog = *engine.device_catalog_;
        // A cold enumeration can return before the background scan publishes its first snapshot.
        std::unique_lock catalog_lock{catalog.mutex};
        const bool catalog_ready = catalog.ready.wait_for(catalog_lock, 2s, [&] { return catalog.has_snapshot; });
        catalog_lock.unlock();
        check(catalog_ready && engine.enumerate_devices().size() == 2, "cold outputs: distinct software outputs available");
        check(state.replace_full_document(document(json::array({audio("bed", wav),
            audio("held", wav, {{"deviceOverride", "Held Output"}}),
            audio("backup", wav, {{"deviceOverride", "Backup Output"}}),
        }))) && wait_ready(state) && state.trigger_item("bed"), "cold outputs: cues ready with a bed playing");

        auto& hold = init ? hold_init : hold_start;
        entered.store(false);
        held_starts.store(0);
        hold.store(true);
        state.set_next_item_override("held");
        auto held_go = std::async(std::launch::async, [&] { return state.go(); });
        for (int i = 0; i < 1000 && !entered.load(); ++i) std::this_thread::sleep_for(2ms);
        check(entered.load(), "cold outputs: GO reached the selected native call");
        std::future<DeviceId> same_output;
        if (!init) same_output = std::async(std::launch::async, [&] { return engine.open_default_device(); });

        auto stop = std::async(std::launch::async, [&] { state.stop_all_cues(0); });
        check(stop.wait_for(250ms) == std::future_status::ready && !on_air(state, engine, "bed"),
              "cold outputs: Stop All is independent of the held output");
        auto backup_go = std::async(std::launch::async, [&] {
            state.set_next_item_override("backup");
            return state.go();
        });
        const bool completed = backup_go.wait_for(1s) == std::future_status::ready;
        check(completed, "cold outputs: backup GO responds before the other driver returns");
        if (completed) {
            const auto result = backup_go.get();
            if (init) {
                check(result.empty() && state.next_item_override() == "backup",
                      "cold outputs: busy native init refuses the start and preserves Up Next");
            } else {
                check(result == "backup" && on_air(state, engine, "backup"), "cold outputs: a distinct cold output takes GO");
                for (int i = 0; i < 40 && engine.read_master_meter(2).peak_max_db < -15.0f; ++i)
                    std::this_thread::sleep_for(5ms);
                check(engine.read_master_meter(2).peak_max_db > -15.0f, "cold outputs: backup output receives PCM while startup is held");
            }
        }
        if (same_output.valid() && same_output.wait_for(1s) == std::future_status::ready) {
            const auto id = same_output.get();
            check(id.empty() && held_starts.load() == 1,
                  "cold outputs: a default alias cannot start a second stream on the held device");
            if (!id.empty()) engine.close_device(id);
        } else if (!init) {
            check(false, "cold outputs: a request for the same hardware settles while startup is held");
        }
        hold.store(false);
        if (same_output.valid()) {
            const auto id = same_output.get();
            if (!id.empty()) engine.close_device(id);
        }
        stop.get();
        if (backup_go.valid()) (void)backup_go.get();
        check(held_go.get().empty() && !on_air(state, engine, "held"), "cold outputs: canceled GO cannot start late");
        if (init && completed) check(state.go() == "backup", "cold outputs: deliberate retry opens the backup");
        state.stop_all_cues(0);
        state.release_device_routings();
    }
}

void test_stop_all_during_ltc_device_start() {
    auto* context = null_preview_context();
    static const auto start = context->callbacks.onDeviceStart;
    static std::atomic<bool> hold{false}, entered{false}, fail{false};
    context->callbacks.onDeviceStart = [](ma_device* device) {
        if (hold.load()) {
            entered.store(true);
            while (hold.load()) std::this_thread::sleep_for(1ms);
        }
        return fail.load() ? MA_ERROR : start(device);
    };
    const auto wav = make_wav(8'192, 480'000);
    liveplay::audio::AudioEngine engine;
    engine.device_test_context_ = context;
    liveplay::core::ProjectState state(engine);
    check(state.replace_full_document(document(json::array({
        audio("ltc-bed", wav), audio("ltc-backup", wav),
        audio("ltc-cold", wav, {{"ltcEnabled", true}, {"duckingBehavior", {{"mode", "no-ducking"}}}}),
    }))) && wait_ready(state) && state.trigger_item("ltc-bed"), "LTC open: Program and timecode media ready");
    {
        std::lock_guard lock{state.mutex_};
        state.document_["settings"]["ltcDevice"] = "NULL Playback Device";
    }
    const auto backup = engine.find_cue(*state.item_to_cue_id("ltc-backup"));
    check(backup && backup->prime(2.0), "LTC open: independent backup primed");
    hold.store(true);
    auto opening = std::async(std::launch::async, [&] { return state.trigger_item("ltc-cold"); });
    for (int i = 0; i < 1000 && !entered.load(); ++i) std::this_thread::sleep_for(2ms);
    check(entered.load(), "LTC open: GO reached native timecode output start");
    auto controls = std::async(std::launch::async, [&] {
        state.stop_all_cues(0);
        return !on_air(state, engine, "ltc-bed") && state.set_next_item_override("ltc-backup") &&
            state.go() == "ltc-backup" && state.state_summary().is_object();
    });
    check(controls.wait_for(250ms) == std::future_status::ready, "LTC open: Stop All and non-LTC backup GO before device returns");
    hold.store(false);
    check(!opening.get() && controls.get() && on_air(state, engine, "ltc-backup") &&
              !on_air(state, engine, "ltc-cold") && state.device_routings_.empty() && engine.devices_.empty(),
          "LTC open: canceled result cannot route or play");

    std::atomic<bool> warned{false};
    state.set_ui_state_broadcaster([&](const json& event) {
        if (event.value("code", "") == "output_device_unavailable" && event.value("device", "") == "NULL Playback Device")
            warned.store(true);
    });
    fail.store(true);
    const auto accepted = state.trigger_item("ltc-cold");
    fail.store(false);
    check(accepted && warned.load() && on_air(state, engine, "ltc-cold") && on_air(state, engine, "ltc-backup"),
          "LTC open: failure warns and preserves Program audio");
    state.set_ui_state_broadcaster({});
    state.stop_all_cues(0);
    check(state.trigger_item("ltc-cold") && state.device_routings_.size() == 1,
          "LTC open: deliberate retry restores timecode");
    state.stop_all_cues(0);
    context->callbacks.onDeviceStart = start;
}

void test_stop_all_during_ltc_edit() {
    auto* context = null_preview_context();
    static const auto start = context->callbacks.onDeviceStart;
    static std::atomic<bool> hold{false}, entered{false};
    context->callbacks.onDeviceStart = [](ma_device* device) {
        if (hold.load()) {
            entered.store(true);
            while (hold.load()) std::this_thread::sleep_for(1ms);
        }
        return start(device);
    };
    const auto wav = make_wav(8'192, 480'000);
    liveplay::audio::AudioEngine engine;
    engine.device_test_context_ = context;
    liveplay::core::ProjectState state(engine);
    check(state.replace_full_document(document(json::array({
        audio("ltc-edit", wav), audio("ltc-edit-backup", wav), audio("ltc-edit-warm", wav),
    }))) && wait_ready(state) && state.trigger_item("ltc-edit"), "LTC edit: Program and backup media ready");
    {
        std::lock_guard lock{state.mutex_};
        state.document_["settings"]["ltcDevice"] = "NULL Playback Device";
    }
    const auto backup = engine.find_cue(*state.item_to_cue_id("ltc-edit-backup"));
    check(backup && backup->prime(2.0), "LTC edit: independent backup primed");
    hold.store(true);
    auto edit = std::async(std::launch::async, [&] {
        auto lock = state.lock_project_session(state.project_session_id());
        return state.update_item("ltc-edit", {{"ltcEnabled", true}}, &lock);
    });
    for (int i = 0; i < 1000 && !entered.load(); ++i) std::this_thread::sleep_for(2ms);
    check(entered.load(), "LTC edit: native output startup is held");
    check(edit.wait_for(250ms) == std::future_status::ready,
          "LTC edit: edit acknowledges before the driver returns");
    auto controls = std::async(std::launch::async, [&] {
        state.stop_all_cues(0);
        auto lock = state.lock_project_session(state.project_session_id());
        if (!lock.owns_lock() || on_air(state, engine, "ltc-edit") ||
            !state.set_next_item_override("ltc-edit-backup") || state.go() != "ltc-edit-backup") return false;
        std::array<float, 256> left{}, right{};
        float* channels[]{left.data(), right.data()};
        return backup && backup->render_block(channels, 2, 256) == 256 && left[0] > 0.2f;
    });
    check(controls.wait_for(250ms) == std::future_status::ready,
          "LTC edit: Stop All and backup GO render PCM before startup returns");
    hold.store(false);
    const auto accepted = edit.get();
    const auto independent = controls.get();
    check(accepted && independent && state.full_document()["items"][0]["ltcEnabled"] == true,
          "LTC edit: accepted timecode setting remains in the show");
    const auto retired = [&] {
        std::lock_guard lock{engine.mutex_};
        return !engine.retired_devices_.empty() && engine.devices_.empty();
    };
    for (int i = 0; i < 400 && !retired(); ++i) std::this_thread::sleep_for(5ms);
    bool no_routes;
    {
        std::lock_guard lock{state.mutex_};
        no_routes = state.device_routings_.empty();
    }
    check(retired() && no_routes && on_air(state, engine, "ltc-edit-backup") && !on_air(state, engine, "ltc-edit"),
          "LTC edit: canceled startup leaves no device or route and cannot replay the cue");

    check(state.set_next_item_override("ltc-edit") && state.go() == "ltc-edit" &&
              state.device_routings_.size() == 1,
          "LTC edit: deliberate GO opens the retained timecode destination");
    check(state.update_item("ltc-edit-warm", {{"ltcEnabled", true}}), "LTC edit: warm destination accepts another cue edit");
    const auto warm = state.item_to_cue_id("ltc-edit-warm");
    {
        std::lock_guard lock{engine.mutex_};
        const auto routes = engine.pending_.item_sources.find(warm->value);
        check(routes != engine.pending_.item_sources.end() && routes->second.by_source_channel.size() == 2 &&
                  routes->second.by_source_channel.back().size() == 1 &&
                  routes->second.by_source_channel.back().front().mixer == state.device_routings_.begin()->second.mixer,
              "LTC edit: warm destination routes timecode immediately");
    }
    state.stop_all_cues(0);
    context->callbacks.onDeviceStart = start;
}

void test_loader_output_wait() {
    auto* context = null_preview_context();
    static const auto start = context->callbacks.onDeviceStart;
    static std::atomic<bool> hold{false}, entered{false};
    context->callbacks.onDeviceStart = [](ma_device* device) {
        if (hold.load()) {
            entered.store(true);
            while (hold.load()) std::this_thread::sleep_for(1ms);
        }
        return start(device);
    };
    const auto wav = make_wav(8'192);
    for (const char* key : {"ltcDevice", "defaultOutputDevice", "queued LTC", "System Default"}) {
        const bool queued = std::string_view{key} == "queued LTC";
        const bool main = std::string_view{key} == "System Default";
        const bool ltc = queued || std::string_view{key} == "ltcDevice";
        liveplay::audio::AudioEngine engine;
        engine.device_test_context_ = context;
        if (!main) {
            // Named routes need the fixture catalog before the test holds device startup.
            (void)engine.enumerate_devices();
            auto& catalog = *engine.device_catalog_;
            std::unique_lock catalog_lock{catalog.mutex};
            check(catalog.ready.wait_for(catalog_lock, 2s, [&] { return catalog.has_snapshot; }),
                  "Loader output: software device catalog is ready");
        }
        auto owned_state = std::make_unique<liveplay::core::ProjectState>(engine);
        auto& state = *owned_state;
        state.test_loader_main_routing_ = main;
        auto source = document(json::array());
        const auto cold = audio("loader-cold", wav, {{"ltcEnabled", ltc}});
        if (queued) {
            check(state.replace_full_document(source) && wait_ready(state), "Loader output: empty show ready");
            std::lock_guard lock{state.mutex_};
            state.document_["settings"]["ltcDevice"] = "NULL Playback Device";
        } else {
            if (!main) source["settings"][key] = "NULL Playback Device";
            source["items"].push_back(cold);
        }
        entered.store(false);
        hold.store(true);
        auto opening = std::async(std::launch::async, [&] {
            return queued ? !state.add_item(cold).empty()
                          : state.load_from_json(source, fixture_dir() / "loader-output.dwcue");
        });
        for (int i = 0; i < 1000 && !entered.load(); ++i) std::this_thread::sleep_for(2ms);
        check(entered.load(), "Loader output: reached native device start");
        auto controls = std::async(std::launch::async, [&] {
            state.stop_all_cues(0);
            return !state.add_item(audio("loader-sibling", wav)).empty() && wait_ready(state);
        });
        const bool ready = controls.wait_for(350ms) == std::future_status::ready;
        const bool independent = ready && controls.get();
        check(independent, "Loader output: Stop All and healthy media stay ready during device start");
        auto replace = std::async(std::launch::async, [&] {
            if (queued) state.reset();
            const auto replacement = main ? json::array() : json::array({audio("loader-replacement", wav)});
            return state.load_from_json(document(replacement), fixture_dir() / "replacement-output.dwcue") && wait_ready(state);
        });
        check(replace.wait_for(350ms) == std::future_status::ready,
              "Loader output: a replacement show loads before the old device returns");
        hold.store(false);
        check(opening.get() && replace.get(), "Loader output: both project requests settled");
        if (controls.valid()) (void)controls.get();
        check(!state.item_to_cue_id("loader-cold") && (main || state.trigger_item("loader-replacement")),
              "Loader output: replacement can play without old routing");
        state.stop_all_cues(0);
        owned_state.reset();
        check(engine.devices_.empty(), "Loader output: late open reference is released");
    }
    context->callbacks.onDeviceStart = start;
}

void test_program_reroute_preserves_ltc() {
    const auto wav = make_wav(8'192);
    liveplay::audio::AudioEngine engine;
    engine.device_test_context_ = null_preview_context();
    liveplay::core::ProjectState state(engine);
    auto source = document(json::array({audio("routing-ltc", wav, {{"ltcEnabled", true}})}));
    source["settings"]["ltcDevice"] = "NULL Playback Device";
    check(state.load_from_json(source, fixture_dir() / "routing-ltc.dwcue") && wait_ready(state),
          "Settings reroute: LTC media is ready");
    const auto cue = *state.item_to_cue_id("routing-ltc");
    liveplay::audio::MixerChannelId warmed;
    for (int i = 0; i < 400 && warmed.empty(); ++i) {
        {
            std::lock_guard lock{engine.mutex_};
            const auto routes = engine.pending_.item_sources.find(cue.value);
            if (routes != engine.pending_.item_sources.end()) {
                const auto& channels = routes->second.by_source_channel;
                if (channels.size() > 1 && !channels.back().empty()) warmed = channels.back().front().mixer;
            }
        }
        if (warmed.empty()) std::this_thread::sleep_for(5ms);
    }
    check(!warmed.empty() && state.trigger_item("routing-ltc"), "Settings reroute: background LTC setup succeeded");
    {
        std::lock_guard lock{state.mutex_};
        state.document_["settings"]["ltcDevice"] = "Unavailable LTC selection";
    }
    std::atomic<bool> warned{false};
    state.set_ui_state_broadcaster([&](const json& event) {
        if (event.value("code", "") == "output_device_unavailable") warned.store(true);
    });
    check(state.patch_settings({{"defaultOutputDevice", "NULL Playback Device"}}),
          "Settings reroute: Program accepts its prepared output");
    {
        std::lock_guard lock{engine.mutex_};
        const auto& channels = engine.pending_.item_sources.at(cue.value).by_source_channel;
        // Program plays through Main on the same device; LTC keeps its own route.
        check(!warned.load() && !channels.front().empty() && channels.front().front().mixer == engine.main_mixer_ &&
                  channels.size() > 1 && channels.back().size() == 1 && channels.back().front().mixer == warmed &&
                  engine.devices_.size() == 1,
              "Settings reroute: Program changes without clearing or reopening LTC");
    }
    state.set_ui_state_broadcaster({});
    state.stop_all_cues(0);
}

// Program has one audio path: Main (master channels 0/1), opened on the output
// chosen in Settings or, with none chosen, on the system default. A chosen
// output used to get a second route of its own while Main kept the system
// default open, so the console metered and faded the wrong device.
void test_program_plays_through_main() {
    const auto wav = make_wav(8'192, 480'000);
    liveplay::audio::AudioEngine engine;
    engine.device_test_context_ = null_preview_context();
    liveplay::core::ProjectState state(engine);
    state.test_program_main_routing_ = true;
    check(state.replace_full_document(document(json::array({
              audio("main-path", wav),
              audio("main-path-override", wav, {{"deviceOverride", "NULL Playback Device"}}),
          }))) && wait_ready(state) && state.trigger_item("main-path"),
          "Program path: plays on the system default");
    const auto cue = *state.item_to_cue_id("main-path");
    const auto program_mixer = [&] {
        std::lock_guard lock{engine.mutex_};
        const auto& channels = engine.pending_.item_sources.at(cue.value).by_source_channel;
        return channels.empty() || channels.front().empty() ? liveplay::audio::MixerChannelId{}
                                                           : channels.front().front().mixer;
    };
    const auto main_device = [&] {
        std::lock_guard lock{engine.mutex_};
        const auto& dest = engine.pending_.master_destinations[0];
        return dest ? dest->device : liveplay::audio::DeviceId{};
    };
    const auto program_routes = [&] {
        std::lock_guard lock{state.mutex_};
        return state.device_routings_.size();
    };
    check(!engine.main_mixer_.empty() && program_mixer() == engine.main_mixer_ && program_routes() == 0,
          "Program path: the system default is Main");

    check(state.patch_settings({{"defaultOutputDevice", "NULL Playback Device"}}),
          "Program path: the chosen output is accepted");
    check(on_air(state, engine, "main-path") && program_mixer() == engine.main_mixer_ && program_routes() == 0,
          "Program path: a chosen output plays through Main, with no route of its own");
    check(!main_device().empty() && engine.devices_.size() == 1 &&
              engine.devices_.front()->id == main_device() &&
              engine.devices_.front()->open_references.value() == 1,
          "Program path: Main holds the chosen output, once, and nothing else is open");

    state.stop_all_cues(0);
    check(state.trigger_item("main-path") && program_mixer() == engine.main_mixer_ && program_routes() == 0,
          "Program path: GO keeps the chosen output on Main");

    check(state.patch_settings({{"defaultOutputDevice", nullptr}}) && program_mixer() == engine.main_mixer_ &&
              program_routes() == 0 && engine.devices_.size() == 1 &&
              engine.devices_.front()->open_references.value() == 1,
          "Program path: back to the system default, still on Main and one reference");

    check(state.trigger_item("main-path-override") && program_routes() == 1,
          "Program path: a cue with its own output still gets its own route");
    state.stop_all_cues(0);
}

// Autosave sends the whole show. When it matches what the engine already has
// (edits reach the engine as they happen), the file is written and the show
// is not rebuilt: a rebuild touches every cue, playing ones included, and can
// refuse a GO while it runs. A real difference still rebuilds.
void test_autosave_keeps_unchanged_show() {
    const auto wav = make_wav(8'192, 480'000);
    liveplay::audio::AudioEngine engine;
    engine.device_test_context_ = null_preview_context();
    liveplay::core::ProjectState state(engine);
    const auto path = fixture_dir() / "autosave-unchanged.dwcue";
    check(state.load_from_json(document(json::array({audio("bed", wav), audio("next", wav)})), path) &&
              wait_ready(state) && state.trigger_item("bed"),
          "autosave: show open with a cue playing");
    const auto generation = [&] { std::lock_guard lock{state.mutex_}; return state.document_generation_; };
    auto snapshot = state.full_document();
    const auto before = generation();
    snapshot["lastModified"] = "2026-11-19T12:00:00.000Z";
    check(state.save(path, &snapshot) && generation() == before && on_air(state, engine, "bed"),
          "autosave: the same show is written without rebuilding it");
    snapshot["items"][1]["volume"] = -6.0;
    check(state.save(path, &snapshot) && generation() != before,
          "autosave: a show that differs is still applied");
    state.stop_all_cues(0);
}

// Two software outputs: "Main Output" (the system default) and "Second Output".
ma_context* two_output_context() {
    static ma_context context{};
    static const auto initialized = [] {
        const auto backend = ma_backend_null;
        return ma_context_init(&backend, 1, nullptr, &context) == MA_SUCCESS;
    }();
    if (!initialized) std::abort();
    static const auto original = context.callbacks;
    context.callbacks.onContextEnumerateDevices = [](ma_context* ctx, ma_enum_devices_callback_proc cb, void* data) {
        ma_device_info info{};
        std::snprintf(info.name, sizeof(info.name), "Main Output");
        info.isDefault = MA_TRUE;
        if (cb(ctx, ma_device_type_playback, &info, data)) {
            info.id.nullbackend = 1;
            info.isDefault = MA_FALSE;
            std::snprintf(info.name, sizeof(info.name), "Second Output");
            cb(ctx, ma_device_type_playback, &info, data);
        }
        return MA_SUCCESS;
    };
    context.callbacks.onContextGetDeviceInfo = [](ma_context* ctx, ma_device_type type,
                                                  const ma_device_id* id, ma_device_info* info) {
        const auto result = original.onContextGetDeviceInfo(ctx, type, nullptr, info);
        if (id) info->id = *id;
        std::snprintf(info->name, sizeof(info->name), "%s", id && id->nullbackend ? "Second Output" : "Main Output");
        return result;
    };
    return &context;
}

// Main really moves between two outputs: a playing cue goes with it, the old
// output is released, and a settings save that leaves the output alone opens
// nothing (the client sends every setting on any change, e.g. Auto-save).
void test_program_switches_outputs() {
    using namespace std::chrono_literals;
    const auto wav = make_wav(8'192, 480'000);
    liveplay::audio::AudioEngine engine;
    engine.device_test_context_ = two_output_context();
    liveplay::core::ProjectState state(engine);
    state.test_program_main_routing_ = true;
    check(engine.start(false), "Program switch: headless engine started");
    (void)engine.enumerate_devices();
    {
        auto& catalog = *engine.device_catalog_;
        std::unique_lock catalog_lock{catalog.mutex};
        catalog.ready.wait_for(catalog_lock, 2s, [&] { return catalog.has_snapshot; });
    }
    check(engine.enumerate_devices().size() == 2, "Program switch: two outputs available");
    check(state.replace_full_document(document(json::array({audio("switch", wav)}))) && wait_ready(state) &&
              state.trigger_item("switch"),
          "Program switch: plays on the system default");
    const auto cue = *state.item_to_cue_id("switch");
    const auto on_main = [&] {
        std::lock_guard lock{engine.mutex_};
        const auto& channels = engine.pending_.item_sources.at(cue.value).by_source_channel;
        return !channels.empty() && !channels.front().empty() && channels.front().front().mixer == engine.main_mixer_;
    };
    // The one open output, by name, and Main's hold on it.
    const auto only_output = [&]() -> std::string {
        std::lock_guard lock{engine.mutex_};
        const auto& dest = engine.pending_.master_destinations[0];
        if (engine.devices_.size() != 1 || !dest || engine.devices_.front()->id != dest->device ||
            engine.devices_.front()->open_references.value() != 1) return {};
        return engine.devices_.front()->display_name;
    };
    check(on_main() && only_output() == "Main Output", "Program switch: Main holds the system default alone");

    check(state.patch_settings({{"defaultOutputDevice", "Second Output"}}), "Program switch: Second Output accepted");
    check(on_air(state, engine, "switch") && on_main() && only_output() == "Second Output",
          "Program switch: the playing cue moves with Main and the old output is released");

    check(state.patch_settings({{"defaultOutputDevice", "Second Output"}, {"autoSave", false}}) &&
              on_air(state, engine, "switch") && on_main() && only_output() == "Second Output",
          "Program switch: a save that repeats the chosen output keeps Main as it is");

    check(state.patch_settings({{"defaultOutputDevice", nullptr}}), "Program switch: System Default accepted");
    check(on_air(state, engine, "switch") && on_main() && only_output() == "Main Output",
          "Program switch: back on the system default, Second Output released");

    // A busy device layer must not fail a save that does not change the output.
    {
        std::lock_guard busy{*engine.device_lifecycle_mutex_};
        check(state.patch_settings({{"defaultOutputDevice", nullptr}, {"autoSave", true}}),
              "Program switch: an unrelated save succeeds while outputs are busy");
    }
    check(on_air(state, engine, "switch") && on_main() && only_output() == "Main Output",
          "Program switch: the unrelated save left Main as it was");
    {
        std::lock_guard lock{state.mutex_};
        const auto& settings = state.document_["settings"];
        check(settings.value("autoSave", false), "Program switch: the unrelated setting was saved");
    }
    state.stop_all_cues(0);
}

// A chosen output is its own stream, even when it is the computer's current
// default. The System Default stream moves when the computer's default
// changes (a projector plugged in at the venue); a chosen output must not.
void test_chosen_output_has_its_own_stream() {
    using namespace std::chrono_literals;
    const auto wav = make_wav(8'192, 480'000);
    liveplay::audio::AudioEngine engine;
    engine.device_test_context_ = two_output_context();
    liveplay::core::ProjectState state(engine);
    state.test_program_main_routing_ = true;
    check(engine.start(false), "Own stream: headless engine started");
    (void)engine.enumerate_devices();
    {
        auto& catalog = *engine.device_catalog_;
        std::unique_lock catalog_lock{catalog.mutex};
        catalog.ready.wait_for(catalog_lock, 2s, [&] { return catalog.has_snapshot; });
    }
    check(state.replace_full_document(document(json::array({
              audio("own", wav),
              audio("own-override", wav, {{"deviceOverride", "Main Output"}}),
          }))) && wait_ready(state) && state.trigger_item("own"),
          "Own stream: plays on the system default");
    const auto main_device = [&] {
        std::lock_guard lock{engine.mutex_};
        const auto& dest = engine.pending_.master_destinations[0];
        return dest ? dest->device : liveplay::audio::DeviceId{};
    };
    const auto open_count = [&] {
        std::lock_guard lock{engine.mutex_};
        return engine.devices_.size();
    };
    const auto follows_default = [&](const liveplay::audio::DeviceId& id) {
        std::lock_guard lock{engine.mutex_};
        for (const auto& device : engine.devices_)
            if (device->id == id) return device->follows_default;
        return false;
    };
    const auto system_default = main_device();
    check(!system_default.empty() && follows_default(system_default) && open_count() == 1,
          "Own stream: Main starts on the stream that follows the system default");

    check(state.patch_settings({{"defaultOutputDevice", "Main Output"}}), "Own stream: Main Output chosen");
    const auto chosen = main_device();
    check(on_air(state, engine, "own") && !chosen.empty() && chosen != system_default &&
              !follows_default(chosen) && open_count() == 1,
          "Own stream: the chosen output gets its own stream though it is the default, and the old one goes");

    check(state.patch_settings({{"defaultOutputDevice", nullptr}}), "Own stream: System Default chosen again");
    const auto back = main_device();
    check(on_air(state, engine, "own") && !back.empty() && back != chosen && follows_default(back) &&
              open_count() == 1,
          "Own stream: System Default gets a stream that follows the computer again");

    check(state.trigger_item("own-override") && open_count() == 2,
          "Own stream: a cue's own output does not share the System Default stream");
    state.stop_all_cues(0);
    state.release_device_routings();
}

void test_stop_all_during_diagnostic_output_start() {
    auto* context = null_preview_context();
    static const auto start = context->callbacks.onDeviceStart;
    static std::atomic<bool> hold{false}, entered{false};
    context->callbacks.onDeviceStart = [](ma_device* device) {
        if (hold.load()) {
            entered.store(true);
            while (hold.load()) std::this_thread::sleep_for(1ms);
        }
        return start(device);
    };
    const auto wav = make_wav(8'192, 480'000);
    for (const char* selection : {"default", "NULL Playback Device"}) {
        liveplay::audio::AudioEngine engine;
        engine.device_test_context_ = context;
        liveplay::core::ProjectState state(engine);
        check(state.replace_full_document(document(json::array({
            audio("diagnostic-bed", wav), audio("diagnostic-backup", wav),
        }))) && wait_ready(state) && state.trigger_item("diagnostic-bed"), "Diagnostic open: Program media ready");
        const auto backup = engine.find_cue(*state.item_to_cue_id("diagnostic-backup"));
        check(backup && backup->prime(2.0), "Diagnostic open: backup primed");
        const auto owned = std::string_view{selection} == "default" ? make_wav(8'192, 480'000) : std::filesystem::path{};
        const auto& file = owned.empty() ? wav : owned;
        entered.store(false);
        hold.store(true);
        auto opening = std::async(std::launch::async, [&] { return state.add_av_sync_diagnostic_cue(file, selection, owned); });
        for (int i = 0; i < 1000 && !entered.load(); ++i) std::this_thread::sleep_for(2ms);
        check(entered.load(), "Diagnostic open: actual software device startup is held");
        auto controls = std::async(std::launch::async, [&] {
            state.stop_all_cues(0);
            return !on_air(state, engine, "diagnostic-bed") &&
                state.set_next_item_override("diagnostic-backup") && state.go() == "diagnostic-backup" &&
                state.state_summary().is_object();
        });
        check(controls.wait_for(250ms) == std::future_status::ready,
              "Diagnostic open: Stop All and backup GO finish before startup returns");
        hold.store(false);
        const auto discarded = opening.get();
        check(controls.get() && discarded.cue_id.empty() && state.diagnostic_cues_.empty() &&
                  engine.items_.size() == 2 && engine.devices_.empty() && on_air(state, engine, "diagnostic-backup"),
              "Diagnostic open: late startup leaves no diagnostic cue, route or reference");
        for (int i = 0; i < 200 && !owned.empty() && std::filesystem::exists(owned); ++i)
            std::this_thread::sleep_for(5ms);
        check(owned.empty() ? std::filesystem::exists(file) : !std::filesystem::exists(owned),
              "Diagnostic open: cancellation deletes only the uploaded file after decoder close");
        const auto retried = state.add_av_sync_diagnostic_cue(wav, selection);
        const auto diagnostic = engine.find_cue(retried.cue_id);
        check(diagnostic && diagnostic->stats().transport == liveplay::audio::TransportState::Stopped &&
                  on_air(state, engine, "diagnostic-backup"),
              "Diagnostic open: deliberate retry prepares the stopped diagnostic alongside Program");
        state.remove_cue(retried.cue_id);
        state.stop_all_cues(0);
    }
    context->callbacks.onDeviceStart = start;
}

void test_stop_all_during_output_settings_open() {
    auto* context = null_preview_context();
    static const auto start = context->callbacks.onDeviceStart;
    static std::atomic<bool> hold{false}, entered{false};
    context->callbacks.onDeviceStart = [](ma_device* device) {
        if (hold.load()) {
            entered.store(true);
            while (hold.load()) std::this_thread::sleep_for(1ms);
        }
        return start(device);
    };
    const auto wav = make_wav(8'192, 480'000);
    for (const char* key : {"defaultOutputDevice", "ltcDevice", "deviceOverride"}) {
        const bool cue_edit = std::string_view{key} == "deviceOverride";
        liveplay::audio::AudioEngine engine;
        engine.device_test_context_ = context;
        liveplay::core::ProjectState state(engine);
        check(state.replace_full_document(document(json::array({
            audio("settings-bed", wav), audio("settings-backup", wav),
        }))) && wait_ready(state) && state.trigger_item("settings-bed"), "Output settings: Program media ready");
        const auto backup = engine.find_cue(*state.item_to_cue_id("settings-backup"));
        check(backup && backup->prime(2.0), "Output settings: backup primed");
        entered.store(false);
        hold.store(true);
        auto opening = std::async(std::launch::async, [&] {
            auto project_lock = state.lock_project_session(state.project_session_id());
            if (cue_edit) return state.update_item("settings-bed", {{key, "NULL Playback Device"}}, &project_lock);
            return state.patch_settings({{key, "NULL Playback Device"}}, &project_lock);
        });
        for (int i = 0; i < 1000 && !entered.load(); ++i) std::this_thread::sleep_for(2ms);
        check(entered.load(), "Output settings: native output start is held");
        auto controls = std::async(std::launch::async, [&] {
            state.stop_all_cues(0);
            auto project_lock = state.lock_project_session(state.project_session_id());
            return project_lock.owns_lock() && !on_air(state, engine, "settings-bed") &&
                state.set_next_item_override("settings-backup") && state.go() == "settings-backup";
        });
        check(controls.wait_for(250ms) == std::future_status::ready,
              "Output settings: Stop All, project access and backup GO before startup returns");
        hold.store(false);
        const auto selected = [&] {
            auto doc = state.full_document();
            return cue_edit ? doc["items"][0][key] : doc["settings"][key];
        };
        check(!opening.get() && controls.get() && on_air(state, engine, "settings-backup") &&
                  selected().is_null() && engine.devices_.empty(),
              "Output settings: canceled edit keeps the selected output and releases the late reference");
        const bool retried = cue_edit ? state.update_item("settings-bed", {{key, "NULL Playback Device"}})
                                      : state.patch_settings({{key, "NULL Playback Device"}});
        check(retried && selected() == "NULL Playback Device",
              "Output settings: deliberate retry commits the selected device");
        state.stop_all_cues(0);
    }
    context->callbacks.onDeviceStart = start;
}

void test_stop_all_during_preview_retirement() {
    const auto wav = make_wav(8'192);
    for (const int mode : {0, 1, 2, 3}) {
        liveplay::audio::AudioEngine engine;
        engine.device_test_context_ = null_preview_context();
        liveplay::core::ProjectState state(engine);
        state.replace_full_document(document(json::array({audio("preview-bed", wav), audio("preview-item", wav)})));
        check(wait_ready(state), "preview stall: media ready"); close_devices(engine);
        json start_result, stop_result;
        check(state.patch_settings({{"previewDevice", "NULL Playback Device"}}) &&
                  state.start_preview("preview-item", &start_result), "preview stall: software-only Preview starts");
        check(state.trigger_item("preview-bed"), "preview stall: Program starts independently");
        const auto bed = engine.find_cue(*state.item_to_cue_id("preview-bed"));
        const auto preview = engine.find_cue(state.current_preview_cue_id());
        if (!preview) { check(false, "preview stall: Preview has a native cue"); continue; }
        std::array<float, 256> left{}, right{}; float* channels[]{left.data(), right.data()};
        bed->render_block(channels, 2, 256);
        check(left[0] > 0.2f, "preview stall: actual Program PCM is audible in the manual buffer");
        std::unique_lock read_stall{preview->decoder_mutex_};
        const auto replacement_gate = wav.string() + ".preview-replacement-gate";
        if (mode == 1) {
            // Old decoder cleanup no longer blocks a replacement, so hold its own load.
            std::filesystem::remove(replacement_gate + ".entered");
            std::ofstream{replacement_gate} << wav;
            set_loader_gate(replacement_gate);
        }
        auto operation = std::async(std::launch::async, [&] {
            if (mode == 0) return state.stop_preview();
            if (mode == 1) return state.start_preview("preview-item");
            if (mode == 3) return state.stop_preview(&stop_result);
            return state.patch_settings({{"previewDevice", "NULL Playback Device"}});
        });
        for (int i = 0; i < 300 && preview->stats().transport != liveplay::audio::TransportState::Stopped; ++i)
            std::this_thread::sleep_for(1ms);
        if (mode == 1) check(wait_gate_entered(replacement_gate), "Preview retirement: replacement decoder is held before publication");
        if (mode == 3) {
            json replacement;
            check(state.start_preview("preview-item", &replacement),
                  "Preview ordering: replacement starts before old decoder close releases");
            read_stall.unlock(); check(operation.get(), "Preview ordering: old stop completes");
            const auto current = state.preview_state();
            check(stop_result["revision"] < replacement["revision"] && stop_result["cueId"] == "" &&
                      replacement["cueId"] != start_result["cueId"] &&
                      start_result["cueId"] == preview->id().value && current == replacement &&
                      engine.find_cue(state.current_preview_cue_id())->stats().transport == liveplay::audio::TransportState::Playing,
                  "Preview ordering: old completion retains its own coherent identity and cannot describe the replacement");
            state.stop_preview(); state.stop_all_cues(0); continue;
        }
        auto stop = std::async(std::launch::async, [&] { state.stop_all_cues(0); });
        const bool stopped = stop.wait_for(250ms) == std::future_status::ready;
        check(stopped && bed->stats().transport == liveplay::audio::TransportState::Stopped &&
                  bed->render_block(channels, 2, 256) == 0,
              "preview stall: Stop All acknowledges and silences Program before Preview storage release");
        if (mode == 1) std::filesystem::remove(replacement_gate);
        read_stall.unlock(); const bool result = operation.get(); stop.get();
        if (mode == 1) {
            clear_loader_gate();
            std::filesystem::remove(replacement_gate + ".entered");
        }
        check(mode == 1 ? !result : result, "preview stall: cancelled replacement refuses while stop/settings settle");
        check(state.current_preview_item_uuid().empty(), "preview stall: cancelled Preview cannot reappear after storage release");
        check(state.start_preview("preview-item"), "preview stall: deliberate Preview retry succeeds");
        state.stop_preview(); state.stop_all_cues(0);
    }
}

void test_cancelled_preview_preparation() {
    const auto wav = make_wav(8'193);
    const auto preview_wav = make_wav(8'194);
    for (const bool prime : {false, true}) {
      for (const int mode : {0, 1, 2, 3}) {
        liveplay::audio::AudioEngine engine;
        engine.device_test_context_ = null_preview_context();
        liveplay::core::ProjectState state(engine);
        auto doc = document(json::array({audio("prepare-bed", wav),
            audio("prepare-next", wav, {{"duckingBehavior", {{"mode", "no-ducking"}}}}),
            audio("prepare-preview", preview_wav, {{"inPoint", 0.25}})}));
        doc["settings"]["previewDevice"] = "NULL Playback Device";
        state.replace_full_document(doc);
        check(wait_ready(state), "Preview preparation: fixtures ready"); close_devices(engine);
        check(state.trigger_item("prepare-bed"), "Preview preparation: Program starts");
        const auto bed = engine.find_cue(*state.item_to_cue_id("prepare-bed"));
        const auto gate = wav.string() + (prime ? ".preview-read-gate" : ".preview-load-gate");
        std::ofstream{gate} << preview_wav;
        const char* name = prime ? "DWCUE_TEST_DECODER_READ_GATE" : "DWCUE_TEST_LOADER_GATE";
        set_loader_gate(gate, name);
        auto preview = std::async(std::launch::async, [&] { return state.start_preview("prepare-preview"); });
        check(wait_gate_entered(gate), "Preview preparation: decoder load/read reaches deterministic gate");
        auto go = std::async(std::launch::async, [&] { return state.trigger_item("prepare-next"); });
        check(go.wait_for(250ms) == std::future_status::ready,
              "Preview preparation: unrelated Program GO completes before audition storage releases");
        std::future<bool> replacement;
        if (mode == 3) {
            doc["name"] = "replacement-show";
            replacement = std::async(std::launch::async, [&] { return state.replace_full_document(doc); });
        }
        auto cancel = std::async(std::launch::async, [&] {
            if (mode == 0 || mode == 3) state.stop_all_cues(0);
            else if (mode == 1) state.stop_preview();
            else state.patch_settings({{"previewDevice", nullptr}});
        });
        check(cancel.wait_for(250ms) == std::future_status::ready,
              "Preview preparation: Stop/setting cancellation completes before storage release");
        const auto transport = bed->stats().transport;
        check(mode == 0 || mode == 3 ? transport == liveplay::audio::TransportState::Stopped
                                     : transport == liveplay::audio::TransportState::Playing,
              "Preview preparation: Preview-only cancellation preserves Program; Stop All silences it");
        std::filesystem::remove(gate);
        const bool started = preview.get(); cancel.get();
        check(go.get(), "Preview preparation: independent Program GO is accepted");
        clear_loader_gate(name);
        check(!started && state.current_preview_item_uuid().empty(),
              "Preview preparation: cancelled work cannot publish or sound later");
        if (replacement.valid()) check(replacement.get() && wait_ready(state), "Preview preparation: queued project replacement settles");
        state.patch_settings({{"previewDevice", "NULL Playback Device"}});
        check(state.start_preview("prepare-preview"), "Preview preparation: deliberate retry still starts");
        const auto active_id = state.current_preview_cue_id();
        const auto active = engine.find_cue(active_id);
        check(active && active->stats().playhead_frame == 12'000,
              "Preview preparation: authored In point is retained");
        if (active) {
            const auto routes = engine.pending_.item_sources.at(active_id.value).by_source_channel;
            bool isolated = false;
            for (const auto& channel : routes) for (const auto& send : channel) {
                isolated = true;
                check(send.mixer != engine.main_mixer_, "Preview preparation: no Preview send reaches Main");
            }
            check(isolated, "Preview preparation: dedicated mixer has actual source routes");
        }
        state.stop_preview(); state.stop_all_cues(0);
        std::filesystem::remove(gate + ".entered");
      }
    }
}

void test_busy_decoder_preserves_sibling_progress() {
    const auto wav = make_wav(8'195);
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    state.replace_full_document(document(json::array({audio("decode-a", wav), audio("decode-b", wav)})));
    check(wait_ready(state), "busy decoder: real sources ready"); close_devices(engine);
    engine.create_mixer_channel("Decoder-progress fixture");
    const auto topology = engine.snapshot_topology();
    check(topology->items.size() == 2, "busy decoder: both sources are in the worker snapshot");
    if (topology->items.size() != 2) return;
    for (const auto& entry : topology->items) {
        entry.item->prime(0.0); entry.item->play();
    }
    const auto blocked = topology->items.front().item;
    const auto sibling = topology->items.back().item;
    std::unique_lock io_stall{blocked->decoder_mutex_};
    const auto decoding = engine.decode_state_;
    decoding->active.store(true);
    std::thread worker([&] { liveplay::audio::AudioEngine::decode_loop(decoding); });
    for (int i = 0; i < 250 && sibling->stats().read_ahead_blocks == 0; ++i)
        std::this_thread::sleep_for(2ms);
    std::array<float, 256> left{}, right{}; float* channels[]{left.data(), right.data()};
    check(sibling->render_block(channels, 2, 256) == 256 && left[0] > 0.2f,
          "busy decoder: shared worker delivers sibling PCM before another decoder lock releases");
    { std::lock_guard lock{decoding->wait_mutex}; decoding->shutdown.store(true); }
    decoding->wake.notify_all();
    io_stall.unlock(); worker.join();
    state.stop_all_cues(0);
}

void test_stop_all_during_live_edits() {
    const auto wav = make_wav(8'196);
    const auto replacement = make_wav(8'197);
    for (const int mode : {0, 1, 2, 3, 4, 5, 6}) {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        auto source_item = audio("edit-source", wav, {{"outPoint", 0.9},
            {"endBehavior", {{"action", mode == 3 ? "loop" : "stop"}}}});
        if (mode == 6) source_item = {{"uuid", "edit-group"}, {"type", "group"},
            {"children", json::array({source_item})}};
        state.replace_full_document(document(json::array({
            source_item, audio("edit-target", wav), audio("edit-bed", wav,
                {{"duckingBehavior", {{"mode", "no-ducking"}}}})})));
        check(wait_ready(state), "live document edit: real media ready"); close_devices(engine);
        check(state.trigger_item("edit-source"), "live document edit: Program starts");
        check(state.trigger_item("edit-bed"), "live document edit: unrelated Program bed starts");
        const auto source = engine.find_cue(*state.item_to_cue_id("edit-source"));
        const auto bed = engine.find_cue(*state.item_to_cue_id("edit-bed"));
        const auto target = engine.find_cue(*state.item_to_cue_id("edit-target"));
        check(target->prime(2.0), "live document edit: backup cue is prepared");
        std::array<float, 256> left{}, right{}; float* channels[]{left.data(), right.data()};
        source->render_block(channels, 2, 256);
        check(bed->render_block(channels, 2, 256) == 256 && left[0] > 0.2f,
              "live document edit: independent bed has actual PCM before the edit");
        std::promise<void> entered, release;
        auto allowed = release.get_future().share();
        std::atomic<bool> signalled{false};
        auto* backend = static_cast<ma_data_source_base*>(source->decoder_->pBackend);
        const auto* original = backend->vtable;
        auto stalled = *original;
        static std::function<ma_result(ma_data_source*, ma_uint64)> seek;
        seek = [&](ma_data_source* data, ma_uint64 frame) {
            if (!signalled.exchange(true)) entered.set_value();
            allowed.wait(); return original->onSeek(data, frame);
        };
        stalled.onSeek = [](ma_data_source* data, ma_uint64 frame) { return seek(data, frame); };
        std::unique_lock decoder_hold{source->decoder_mutex_, std::defer_lock};
        if (mode == 2 || mode >= 4) decoder_hold.lock(); else backend->vtable = &stalled;
        auto edit = std::async(std::launch::async, [&] {
            if (mode == 0) return state.update_item("edit-source", {{"outPoint", 0.75}});
            if (mode == 1) return state.update_item("edit-source", {{"endBehavior", {{"action", "loop"}}}});
            if (mode == 2) return state.update_item("edit-source", {{"mediaServerPath", replacement.string()}});
            if (mode == 4) return state.remove_item("edit-source");
            if (mode == 5) return state.update_item("edit-source", {{"type", "video"}, {"mediaServerPath", ""}});
            if (mode == 6) return state.remove_item("edit-group");
            return state.cue_to_continue("edit-source");
        });
        if (mode == 2 || mode >= 4) {
            for (int i = 0; i < 500 && source->stats().transport != liveplay::audio::TransportState::Stopped; ++i)
                std::this_thread::sleep_for(1ms);
            check(source->stats().transport == liveplay::audio::TransportState::Stopped,
                  "live document edit: old media stops before decoder teardown");
        } else if (mode == 0 || mode == 1 || mode == 3) {
            // A loop change, Continue or an out-point trim on a playing cue
            // keeps its queued audio: unless that audio already reaches a
            // boundary, no storage I/O.
            check(edit.wait_for(1s) == std::future_status::ready && !signalled.load(),
                  "live document edit: a loop change or trim on a playing cue needs no storage");
        } else {
            check(entered.get_future().wait_for(2s) == std::future_status::ready,
                  "live document edit: actual seek reaches storage gate");
        }
        auto snapshot = std::async(std::launch::async, [&] { return state.full_document(); });
        check(snapshot.wait_for(250ms) == std::future_status::ready,
              "live document edit: document reads remain available during storage wait");
        const auto previous_stop_revision = state.stop_revision();
        auto stop = std::async(std::launch::async, [&] { state.stop_all_cues(0); });
        check(stop.wait_for(250ms) == std::future_status::ready &&
                  source->stats().transport == liveplay::audio::TransportState::Stopped &&
                  source->render_block(channels, 2, 256) == 0 &&
                  bed->stats().transport == liveplay::audio::TransportState::Stopped &&
                  bed->render_block(channels, 2, 256) == 0,
              "live document edit: Stop All acknowledges and silences Program before storage release");
        auto backup_go = std::async(std::launch::async, [&] {
            return state.set_next_item_override("edit-target") &&
                state.go(state.stop_revision()) == "edit-target";
        });
        const bool backup_ready = backup_go.wait_for(250ms) == std::future_status::ready;
        check(backup_ready && on_air(state, engine, "edit-target"),
              "live document edit: backup GO starts before the stalled edit returns");
        if (backup_ready)
            check(target->render_block(channels, 2, 256) == 256 && left[0] > 0.2f,
                  "live document edit: backup delivers PCM while the old decoder is held");
        if (decoder_hold.owns_lock()) decoder_hold.unlock();
        release.set_value(); check(edit.get(), "live document edit: accepted command completes");
        check(backup_go.get(), "live document edit: backup GO is accepted");
        stop.get(); const auto saved = snapshot.get();
        if (mode != 2 && mode < 4) backend->vtable = original;
        seek = {};
        std::this_thread::sleep_for(120ms);
        check(!on_air(state, engine, "edit-source") && on_air(state, engine, "edit-target"),
              "live document edit: late edit cannot restart the old cue or interrupt the backup");
        check(mode == 4 || mode == 6 ? saved["items"].size() == 2 :
                  mode == 5 ? saved["items"][0]["type"] == "video" :
                  mode == 3 ? saved["items"][0]["endBehavior"]["action"] == "loop" :
                  mode == 0 ? saved["items"][0]["outPoint"] == 0.75 :
                  mode == 1 ? saved["items"][0]["endBehavior"]["action"] == "loop" :
                              saved["items"][0]["mediaServerPath"] == replacement.string(),
              "live document edit: accepted authored change persists; Continue is runtime-only");
        check(wait_ready(state) && state.trigger_item(mode >= 4 ? "edit-target" : "edit-source"),
              "live document edit: deliberate replay still starts");
        if (mode == 3) {
            check(!state.cue_to_continue("edit-source", previous_stop_revision),
                  "live document edit: stale Continue cannot change a replayed loop");
            check(state.cue_to_continue("edit-source", state.stop_revision()),
                  "live document edit: current Continue still arms the replayed loop");
        }
        state.stop_all_cues(0);
    }
}

void test_stop_all_during_cold_go(const std::filesystem::path& wav) {
  for (const int mode : {0, 1, 2, 3, 4, 5, 6, 7, 8, 9}) {
   for (const bool stall_seek : {false, true}) {
    std::printf("cold GO stall: mode=%d stage=%s\n", mode, stall_seek ? "seek" : "read");
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    auto next_item = audio("stall-next", wav, {{"inPoint", 0.25},
        {"duckingBehavior", {{"mode", "no-ducking"}}}});
    if (mode == 6 || mode == 8) next_item["endBehavior"] = {{"action", "loop"}};
    if (mode == 9) next_item["outPoint"] = 0.75;
    json group{{"uuid", "stall-group"}, {"type", "group"},
        {"startBehavior", {{"action", "play-all"}}},
        {"children", json::array({next_item, audio("stall-sibling", wav,
            {{"duckingBehavior", {{"mode", "no-ducking"}}}})})}};
    if (mode == 5) group["children"][0] = json{{"uuid", "stall-inner"}, {"type", "group"},
        {"startBehavior", {{"action", "play-first"}}}, {"children", json::array({next_item})}};
    if (mode == 7) group["children"][0] = audio("stall-first", wav,
        {{"startBehavior", {{"action", "play-item"}, {"targetUuid", "stall-next"}}},
         {"duckingBehavior", {{"mode", "no-ducking"}}}});
    const bool grouped = mode == 4 || mode == 5 || mode == 7;
    const std::string target = grouped ? "stall-group" : "stall-next";
    auto items = json::array({audio("stall-bed", wav), grouped ? group : next_item, audio("stall-backup", wav)});
    if (mode == 7) items.push_back(next_item);
    state.replace_full_document(document(items));
    check(wait_ready(state), "cold GO stall: media ready"); close_devices(engine);
    check(state.trigger_item("stall-bed") && state.set_next_item_override(target),
          "cold GO stall: program plays and next cue is armed");
    const auto bed = engine.find_cue(*state.item_to_cue_id("stall-bed"));
    const auto next = engine.find_cue(*state.item_to_cue_id("stall-next"));
    const auto backup = engine.find_cue(*state.item_to_cue_id("stall-backup"));
    check(backup->prime(2.0), "cold GO stall: backup cue is prepared");
    if (mode == 9) next->set_out_point_seconds(0.0);
    if (mode >= 8) check(next->prime(2.0, 0.0), "cold GO stall: startup PCM already primed");
    std::promise<void> entered, release;
    const auto entered_future = entered.get_future();
    const auto read_release = release.get_future().share();
    std::atomic<bool> signalled{false};
    auto* backend = static_cast<ma_data_source_base*>(next->decoder_->pBackend);
    const auto* original_vtable = backend->vtable;
    auto stalled_vtable = *original_vtable;
    const auto gate = [&] {
        if (!signalled.exchange(true)) entered.set_value();
        read_release.wait();
    };
    static std::function<ma_result(ma_data_source*, void*, ma_uint64, ma_uint64*)> stalled_read;
    static std::function<ma_result(ma_data_source*, ma_uint64)> stalled_seek;
    stalled_read = [&](ma_data_source* source, void* buffer, ma_uint64 count, ma_uint64* read) {
        gate(); return original_vtable->onRead(source, buffer, count, read);
    };
    stalled_seek = [&](ma_data_source* source, ma_uint64 frame) {
        gate(); return original_vtable->onSeek(source, frame);
    };
    if (stall_seek) stalled_vtable.onSeek = [](ma_data_source* source, ma_uint64 frame) {
        return stalled_seek(source, frame);
    };
    else stalled_vtable.onRead = [](ma_data_source* source, void* buffer, ma_uint64 count, ma_uint64* read) {
        return stalled_read(source, buffer, count, read);
    };
    backend->vtable = &stalled_vtable;
    const auto intent = state.playback_intent_revision();
    auto go = std::async(std::launch::async, [&] {
        if (mode == 0 || mode >= 4) return state.go() == target;
        if (mode == 1) return state.trigger_item(target);
        if (mode == 2) return state.play_item(target);
        return state.resume_item(target, 0.25, intent);
    });
    check(entered_future.wait_for(2s) == std::future_status::ready,
          "cold GO stall: actual decoder reached deterministic gate");
    auto stop = std::async(std::launch::async, [&] { state.stop_all_cues(0); });
    check(stop.wait_for(250ms) == std::future_status::ready &&
              bed->stats().transport == liveplay::audio::TransportState::Stopped,
          "cold GO stall: Stop All completes and silences program before storage release");
    auto backup_go = std::async(std::launch::async, [&] {
        return (mode != 0 || !state.trigger_item("stall-next")) && state.set_next_item_override("stall-backup") &&
            state.go(state.stop_revision()) == "stall-backup";
    });
    check(backup_go.wait_for(250ms) == std::future_status::ready && on_air(state, engine, "stall-backup"),
          "cold GO stall: backup GO starts before the stalled decoder returns");
    release.set_value();
    const auto result = go.get();
    stop.get();
    check(backup_go.get() && on_air(state, engine, "stall-backup"),
          "cold GO stall: the backup stays on air after the old request finishes");
    backend->vtable = original_vtable;
    stalled_read = {}; stalled_seek = {};
    check(!result && !on_air(state, engine, "stall-next") && !on_air(state, engine, "stall-sibling"),
          "cold GO stall: cancelled start/group cannot play after storage recovers");
    check(state.set_next_item_override(target) && state.go() == target &&
              next->stats().playhead_frame == 12'000,
          "cold GO stall: a deliberate retry still starts at the authored in point");
    state.stop_all_cues(0);
   }
  }
}

void test_cancelled_follow_keeps_backup(const std::filesystem::path& wav) {
    const auto target_path = make_wav(16'384);
    constexpr auto hook = "DWCUE_TEST_DECODER_READ_GATE";
    for (const bool group : {false, true}) {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        const json follow{{"action", "goto-item"}, {"targetUuid", "cold-follow"}};
        auto source = audio("ending-source", wav, {{"outPoint", 0.02},
            {"endBehavior", group ? json{{"action", "nothing"}} : follow}});
        if (group) source = {{"uuid", "ending-group"}, {"type", "group"},
            {"children", json::array({source})}, {"endBehavior", follow}};
        state.replace_full_document(document(json::array({source,
            audio("cold-follow", target_path, {{"inPoint", 0.25}}), audio("follow-backup", wav)})));
        check(wait_ready(state) && state.trigger_item(group ? "ending-group" : "ending-source"),
              "Canceled follow: source starts");
        const auto backup = engine.find_cue(*state.item_to_cue_id("follow-backup"));
        check(backup->prime(2.0), "Canceled follow: backup is prepared");
        const auto gate = fixture_dir() / (group ? "group-follow.gate" : "cue-follow.gate");
        std::ofstream{gate} << target_path;
        set_loader_gate(gate, hook);
        std::atomic<bool> warned{false};
        state.set_ui_state_broadcaster([&](const json& event) {
            if (event.value("code", "") == "sequence_target_invalid") warned.store(true);
        });
        render_to_end(state, engine, "ending-source");
        check(wait_gate_entered(gate), "Canceled follow: EOF target reached the held decoder");
        auto recovery = std::async(std::launch::async, [&] {
            state.stop_all_cues(0);
            return state.set_next_item_override("follow-backup") && state.go(state.stop_revision()) == "follow-backup";
        });
        check(recovery.wait_for(250ms) == std::future_status::ready,
              "Canceled follow: Stop All and backup GO finish before the follow returns");
        std::filesystem::remove(gate);
        clear_loader_gate(hook);
        check(recovery.get(), "Canceled follow: backup GO was accepted");
        std::this_thread::sleep_for(160ms);
        check(on_air(state, engine, "follow-backup") && !on_air(state, engine, "cold-follow") &&
                  state.next_item_override().empty() && !warned.load(),
              "Canceled follow: late EOF work cannot play, rearm, or report a stale failure");
        state.set_ui_state_broadcaster({});
        state.stop_all_cues(0);
        std::filesystem::remove(gate.string() + ".entered");
    }
}

void test_rejected_document_preserves_show(const std::filesystem::path& wav) {
    const auto folder = std::filesystem::temp_directory_path() /
        ("dwcue-rejected-load-" + std::to_string(
            std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directory(folder);
    for (const char* field : {"name", "folderPath"}) {
      for (int method = 0; method < 5; ++method) {
        if (method == 0 && std::string{field} == "folderPath") continue;
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        check(state.load_from_json(document(json::array({audio("preserved", wav)})),
                                   folder / "current.dwcue") && wait_ready(state),
              "rejected document: current show is ready");
        check(state.trigger_item("preserved"), "rejected document: current cue plays");
        const auto before = state.full_document();
        const auto intent = state.playback_intent_revision();
        const auto cue = state.item_to_cue_id("preserved");
        const auto item = cue ? engine.find_cue(*cue) : nullptr;
        auto invalid = document(json::array());
        invalid[field] = 123;
        bool accepted = false, threw = false;
        try {
            if (method == 0) {
                const auto path = folder / "invalid.dwcue";
                std::ofstream{path} << invalid.dump();
                accepted = state.load(path);
            } else if (method == 1) {
                accepted = state.load_from_json(invalid, folder / "invalid.dwcue");
            } else if (method < 4) {
                accepted = state.replace_full_document(invalid, method == 2);
            } else {
                accepted = state.save(folder / "saved.dwcue", &invalid);
            }
        } catch (const std::exception&) { threw = true; }
        std::printf("rejected document: field=%s method=%d\n", field, method);
        check(!accepted && !threw, "invalid root metadata returns a refusal");
        check(state.full_document() == before &&
                  state.playback_intent_revision() == intent &&
                  state.item_to_cue_id("preserved") == cue &&
                  item && engine.find_cue(*cue) == item &&
                  on_air(state, engine, "preserved"),
              "invalid document preserves show, session, cue and current playback");
        state.stop_all_cues(0);
      }
    }
    std::filesystem::remove_all(folder);
}

void test_rejected_nested_document_preserves_show(const std::filesystem::path& wav) {
    const auto path = wav.parent_path() / "dwcue-nested-validation.dwcue";
    const std::vector<std::pair<std::string, json>> mutations{
        {"/items/0/uuid", 17}, {"/items/0/children", 17},
        {"/items/0/children/0/type", 17},
        {"/items/0/children/0/ltcEnabled", "bad"},
        {"/items/0/children/0/ltcFrameRate", "bad"},
        {"/items/0/children/0/ltcFrameRate", 1e100},
        {"/items/0/children/0", nullptr},
        {"/items/0/children/0/ltcStartTimecode", 17},
        {"/items/0/children/0/startBehavior/action", 17},
        {"/items/0/children/0/endBehavior/action", 17},
        {"/settings/outputTarget", 17}, {"/settings/disableLimiter", "bad"},
        {"/settings/meterBallistics", 17},
        {"/settings/meterBallisticsCustom/attackMs", "bad"}, {"/items", 17},
    };
    for (const auto& [pointer, bad_value] : mutations) {
      for (int method = 0; method < 5; ++method) {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        state.load_from_json(document(json::array({audio("nested-preserved", wav)})));
        check(wait_ready(state) && state.trigger_item("nested-preserved"), "nested refusal: current cue plays");
        const auto before = state.full_document();
        const auto intent = state.playback_intent_revision();
        json group{{"uuid", "invalid-group"}, {"type", "group"},
                   {"children", json::array({audio("invalid-child", wav)})}};
        auto invalid = document(json::array({group}));
        invalid["settings"]["meterBallistics"] = "custom";
        invalid[json::json_pointer{pointer}] = bad_value;
        const auto disk_before = method == 0 ? invalid.dump() : before.dump();
        std::ofstream{path} << disk_before;
        bool accepted = false, threw = false;
        try {
            if (method == 0) accepted = state.load(path);
            else if (method == 1) accepted = state.load_from_json(invalid);
            else if (method < 4) accepted = state.replace_full_document(invalid, method == 2);
            else accepted = state.save(path, &invalid);
        } catch (const std::exception&) { threw = true; }
        std::printf("nested refusal: field=%s method=%d\n", pointer.c_str(), method);
        check(!accepted && !threw, "nested refusal: invalid tree/settings returns false without throwing");
        bool unchanged = false;
        try { unchanged = state.full_document() == before; } catch (...) {}
        std::ifstream file{path};
        const std::string disk_after{std::istreambuf_iterator<char>{file}, std::istreambuf_iterator<char>{}};
        check(unchanged && state.playback_intent_revision() == intent &&
                  on_air(state, engine, "nested-preserved") && disk_before == disk_after,
              "nested refusal: show/session/playback/intent and existing disk bytes survive");
        state.stop_all_cues(0);
      }
    }
    std::filesystem::remove(path);
}

void test_open_expires_while_waiting_to_switch(const std::filesystem::path& wav) {
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    const auto path = wav.parent_path() / "active.dwcue";
    check(state.load_from_json(document(json::array({audio("active", wav)})), path) && wait_ready(state),
          "expiring Open: current show is ready");
    close_devices(engine);
    check(state.trigger_item("active") && state.set_next_item_override("active"),
          "expiring Open: current show is playing and armed");
    const auto session = state.project_session_id();
    const auto intent = state.playback_intent_revision();
    std::unique_lock held{state.playback_preparation_mutex_};
    const auto deadline = std::chrono::steady_clock::now() + 250ms;
    const auto replacement = document(json::array({audio("replacement", wav)}));
    auto pending = std::async(std::launch::async, [&] {
        return state.load_from_json(replacement, wav.parent_path() / "replacement.dwcue", deadline);
    });
    while (!state.mirror_cancel_.load() && std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(1ms);
    const bool reached_switch = state.mirror_cancel_.load();
    std::this_thread::sleep_until(deadline + 5ms);
    held.unlock();
    const bool opened = pending.get();
    check(reached_switch && !opened && state.project_session_id() == session &&
              state.project_file_path() == path && on_air(state, engine, "active") &&
              state.next_item_override() == "active" && state.playback_intent_revision() == intent,
          "expiring Open: a wait at the switch preserves playback, identity, arming and intent");
}

void test_load_resets_project_runtime(const std::filesystem::path& wav) {
    for (const bool same_file : {false, true}) {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        const auto original = document(json::array({audio("old-first", wav), audio("old-armed", wav)}));
        const auto incoming = same_file ? original : document(json::array({audio("new-first", wav)}));
        const auto path = wav.parent_path() / "runtime-show.dwcue";
        check(state.load_from_json(original, path) && wait_ready(state), "load runtime: first show ready");
        close_devices(engine);
        check(state.trigger_item("old-armed") && state.set_next_item_override("old-armed") &&
                  state.set_selected_item("old-armed") && state.item_trigger_seq("old-armed"),
              "load runtime: first show has an armed/selected/triggered cue");
        state.stop_all_cues(0);
        const auto session = state.project_session_id();
        check(state.replace_full_document(original, false) && wait_ready(state) &&
                  state.project_session_id() == session &&
                  state.selected_item_uuid() == "old-armed" && state.item_trigger_seq("old-armed"),
              "load runtime: in-place replacement retains selection and trigger stamps");
        state.set_next_item_override("old-armed");
        check(state.load_from_json(incoming, same_file ? path : path.parent_path() / "replacement.dwcue") &&
                  wait_ready(state), "load runtime: incoming show ready");
        close_devices(engine);
        const std::string first = same_file ? "old-first" : "new-first";
        check(state.project_session_id() != session && state.selected_item_uuid().empty() &&
                  !state.item_trigger_seq("old-armed") && state.next_item_override() == first,
              same_file ? "same-file reopen clears stale runtime and arms the first cue"
                        : "different-show load clears stale runtime and arms the first cue");
        check(state.go() == first && on_air(state, engine, first),
              "load runtime: first GO starts the incoming first cue");
        state.stop_all_cues(0);
    }
}

void test_rejected_server_document_preserves_show(const std::filesystem::path& wav) {
    const std::vector<json> invalid_documents{
        {{"schema_version", 2}, {"project_name", 123}},
        {{"schema_version", 2}, {"cues", json::array({{{"gain_db", "bad"}}})}},
        {{"schema_version", 2}, {"mixer_channels", json::array({{{"muted", "bad"}}})}},
        {{"schema_version", 2}, {"item_routes", json::array({{{"destination_mixer", 123}}})}},
        {{"schema_version", 2}, {"mixer_routes", json::array({{{"gain_db", "bad"}}})}},
        {{"schema_version", 2}, {"master_assignments", json::array({{{"device", 123}}})}},
    };
    const auto path = wav.parent_path() / "dwcue-invalid-server-schema.dwcue";
    for (const auto& invalid : invalid_documents) {
      for (const bool from_file : {false, true}) {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        state.load_from_json(document(json::array({audio("preserved-server", wav)})));
        check(wait_ready(state) && state.trigger_item("preserved-server"),
              "server load refusal: current show plays");
        const auto before = state.full_document();
        const auto intent = state.playback_intent_revision();
        const auto cue = state.item_to_cue_id("preserved-server");
        bool accepted = false, threw = false;
        try {
            if (from_file) {
                std::ofstream{path} << invalid.dump();
                accepted = state.load(path);
            } else accepted = state.load_from_json(invalid);
        } catch (const std::exception&) { threw = true; }
        check(!accepted && !threw && state.full_document() == before &&
                  state.playback_intent_revision() == intent &&
                  state.item_to_cue_id("preserved-server") == cue &&
                  on_air(state, engine, "preserved-server"),
              "server typed-load failure refuses without changing show or playback");
        state.stop_all_cues(0);
        const json valid{{"schema_version", 2}, {"project_name", "routing-show"}};
        check(state.load_from_json(valid) && state.list_cues().empty(),
              "server load refusal: normal empty server document remains loadable");
      }
    }
    std::filesystem::remove(path);
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    const json valid{{"schema_version", 2}, {"project_name", "typed-routing"},
        {"cues", json::array({{{"id", "typed"}, {"file_path", wav.string()}, {"gain_db", -6.0}, {"fade_in_ms", 17}}})},
        {"mixer_channels", json::array({{{"id", "bus"}, {"muted", true}, {"gain_db", -3.0}}})},
        {"item_routes", json::array({{{"source_channel", 1}, {"destination_mixer", "bus"}, {"gain_db", -2.0}, {"lane", 0}}})},
        {"mixer_routes", json::array({{{"mixer", "bus"}, {"master_channel", 1}, {"gain_db", -1.0}, {"lane", 0}}})},
        {"master_assignments", json::array({{{"master_channel", 1}, {"device", ""}, {"hw_channel", 1}}})}};
    check(state.load_from_json(valid), "server typed-load: complete routing document loads");
    const auto loaded = state.to_json();
    check(loaded["project_name"] == "typed-routing" && loaded["cues"][0]["gain_db"] == -6.0 &&
              loaded["cues"][0]["fade_in_ms"] == 17 && loaded["mixer_channels"][0]["muted"] == true &&
              loaded["item_routes"] == valid["item_routes"] &&
              loaded["mixer_routes"] == valid["mixer_routes"] &&
              loaded["master_assignments"] == valid["master_assignments"],
          "server typed-load: staged cue, mixer and routing values retain their semantics");
    check(state.load_from_json({{"name", "upgraded"}, {"playlist", json::array({
              {{"id", "legacy"}, {"path", wav.string()}, {"volume_db", -4.0}}})}}) &&
              state.to_json()["cues"][0]["gain_db"] == -4.0,
          "server typed-load: existing v1 upgrade still preserves its cue gain");
}

void test_nested_group_end(const std::filesystem::path& wav) {
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    auto a = audio("nested-a", wav, {{"outPoint", 0.02}});
    json inner{{"uuid", "inner"}, {"type", "group"},
               {"startBehavior", {{"action", "play-first"}}},
               {"endBehavior", {{"action", "nothing"}}},
               {"children", json::array({a})}};
    json outer{{"uuid", "outer"}, {"type", "group"},
               {"startBehavior", {{"action", "play-first"}}},
               {"endBehavior", {{"action", "goto-item"}, {"targetUuid", "target"}}},
               {"children", json::array({inner})}};
    state.replace_full_document(document(json::array({outer, audio("target", wav)})));
    check(wait_ready(state), "group nested: all audio becomes ready");
    close_devices(engine);
    check(state.trigger_item("outer"), "group nested: outer accepts first-child dispatch");
    render_to_end(state, engine, "nested-a");
    check(wait_for_on_air(state, engine, "target"),
          "group nested: child then inner completion fires outer end exactly once");
    state.stop_all_cues(0);
}

void test_group_cancellation(const std::filesystem::path& wav) {
    const auto group_doc = [&](const std::string& child, json child_extra) {
        json group{{"uuid", "cancel-group"}, {"type", "group"},
                   {"startBehavior", {{"action", "play-first"}}},
                   {"endBehavior", {{"action", "goto-item"}, {"targetUuid", "target"}}},
                   {"children", json::array({audio(child, wav, std::move(child_extra))})}};
        return document(json::array({group, audio("target", wav)}));
    };
    {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        state.replace_full_document(group_doc("manual-child", {{"outPoint", 0.5}}));
        check(wait_ready(state), "group manual stop: audio ready"); close_devices(engine);
        check(state.trigger_item("cancel-group"), "group manual stop: run starts");
        check(state.stop_item("manual-child"), "group manual stop: child stops explicitly");
        std::this_thread::sleep_for(120ms);
        check(!on_air(state, engine, "target"), "group manual stop: end action is cancelled");
    }
    {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        state.replace_full_document(group_doc("loop-child", {
            {"outPoint", 0.02}, {"endBehavior", {{"action", "loop"}}}}));
        check(wait_ready(state), "group loop: audio ready"); close_devices(engine);
        check(state.trigger_item("cancel-group"), "group loop: run starts");
        render_to_end(state, engine, "loop-child", 80);
        check(wait_for_on_air(state, engine, "loop-child") && !on_air(state, engine, "target"),
              "group loop: looping descendant keeps group incomplete");
        state.stop_all_cues(0);
    }
    {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        state.replace_full_document(group_doc("retrigger-child", {{"outPoint", 0.02}}));
        check(wait_ready(state), "group retrigger: audio ready"); close_devices(engine);
        check(state.trigger_item("cancel-group"), "group retrigger: run starts");
        check(state.trigger_item("retrigger-child"), "group retrigger: external child replay starts");
        render_to_end(state, engine, "retrigger-child");
        check(!on_air(state, engine, "target"),
              "group retrigger: stale group generation cannot fire end action");
    }
}

void test_group_internal_continuations(const std::filesystem::path& wav) {
    const auto run_case = [&](const char* label, json a_extra) {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        a_extra["outPoint"] = 0.04;
        json a = audio("chain-a", wav, std::move(a_extra));
        json b = audio("chain-b", wav, {{"outPoint", 0.02}});
        json group{{"uuid", "chain-group"}, {"type", "group"},
                   {"startBehavior", {{"action", "play-first"}}},
                   {"endBehavior", {{"action", "goto-item"}, {"targetUuid", "chain-end"}}},
                   {"children", json::array({a, b})}};
        state.replace_full_document(document(json::array({group, audio("chain-end", wav)})));
        check(wait_ready(state), "group continuation: audio ready"); close_devices(engine);
        check(state.trigger_item("chain-group"), "group continuation: run starts");
        render_to_end(state, engine, "chain-a");
        check(wait_for_on_air(state, engine, "chain-b"), label);
        render_to_end(state, engine, "chain-b");
        check(wait_for_on_air(state, engine, "chain-end"),
              "group continuation: authored group end survives child transition");
        state.stop_all_cues(0);
    };
    run_case("group continuation: seamless next preserves run",
             {{"endBehavior", {{"action", "next"}}}});
    run_case("group continuation: crossfade next preserves run",
             {{"endBehavior", {{"action", "next"}}}, {"crossFade", 0.01}});
    run_case("group continuation: Start Next preserves run",
             {{"endBehavior", {{"action", "next"}}}, {"startNextEnabled", true},
              {"startNextTime", 0.005}});
    run_case("group continuation: goto preserves run",
             {{"endBehavior", {{"action", "goto-item"}, {"targetUuid", "chain-b"}}}});
}

// Deleting the cue armed as Up Next (or the group holding it) leaves nothing
// armed, announced to clients, instead of a pointer to a missing cue that
// made GO answer "nothing armed" and every follow fail.
void test_deleting_up_next_clears_it(const std::filesystem::path& wav) {
    for (const bool in_group : {false, true}) {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        std::vector<std::string> announced;
        std::mutex announced_mutex;
        state.set_next_item_broadcaster([&](const std::string& uuid) {
            std::lock_guard lock{announced_mutex};
            announced.push_back(uuid);
        });
        json armed = audio("armed", wav);
        json holder{{"uuid", "holder"}, {"type", "group"},
                    {"startBehavior", {{"action", "play-first"}}},
                    {"children", json::array({armed})}};
        json items = in_group
            ? json::array({audio("first", wav), holder, audio("after", wav)})
            : json::array({audio("first", wav), armed, audio("after", wav)});
        check(state.replace_full_document(document(items)) && wait_ready(state), "deleted Up Next: show ready");
        close_devices(engine);
        check(state.set_next_item_override("armed", true), "deleted Up Next: cue armed by hand");
        { std::lock_guard lock{announced_mutex}; announced.clear(); }
        check(state.remove_item(in_group ? "holder" : "armed"), "deleted Up Next: cue deleted");
        bool told = false;
        { std::lock_guard lock{announced_mutex}; told = !announced.empty() && announced.back().empty(); }
        check(state.next_item_override().empty() && told,
              in_group ? "deleted Up Next: deleting its group leaves nothing armed, announced"
                       : "deleted Up Next: deleting it leaves nothing armed, announced");
    }
}

// With two cues on air, GO continues after the one fired last: a stinger
// fired under a bed moves the operator's place to after the stinger.
void test_up_next_follows_last_fired(const std::filesystem::path& wav) {
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    const json layered{{"duckingBehavior", {{"mode", "no-ducking"}}}};
    check(state.replace_full_document(document(json::array({audio("bed", wav, layered), audio("second", wav),
              audio("stinger", wav, layered), audio("after", wav)}))) && wait_ready(state), "overlap: show ready");
    close_devices(engine);
    check(state.trigger_item("bed") && state.trigger_item("stinger") &&
          on_air(state, engine, "bed") && on_air(state, engine, "stinger"), "overlap: bed and stinger on air");
    const auto next = state.state_summary()["next"];
    check(next.is_object() && next.value("itemUuid", std::string{}) == "after",
          "overlap: Up Next follows the stinger, fired last, not the bed above it");
    check(state.trigger_item("bed") && on_air(state, engine, "stinger"), "overlap: bed fired again");
    check(state.state_summary()["next"].value("itemUuid", std::string{}) == "second",
          "overlap: firing the bed again moves Up Next back after the bed");
    state.stop_all_cues(0);
}

// A start aimed at a cue already on air carries on the pass in progress: the
// custom actions it has passed and its start actions do not run again,
// whether it was playing, paused, or brought back up during its stop fade.
void test_refire_keeps_automation(const std::filesystem::path& wav) {
    std::mutex received_mutex;
    std::vector<std::string> received;
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    state.set_external_action_handler([&](const json& action) {
        std::lock_guard lock{received_mutex};
        received.push_back(action.value("marker", ""));
    });
    const auto heard = [&] { std::lock_guard lock{received_mutex}; return received.size(); };
    const json layered{{"duckingBehavior", {{"mode", "no-ducking"}}}};
    auto lead = audio("refire", wav, {{"duckingBehavior", {{"mode", "no-ducking"}}}, {"fadeOutDuration", 1.0},
        {"startBehavior", {{"action", "play-item"}, {"targetUuid", "side"}}},
        {"customActions", json::array({{{"timePoint", 0.05}, {"action", {{"type", "http-request"}, {"marker", "once"}}}}})}});
    check(state.replace_full_document(document(json::array({lead, audio("side", wav, layered)}))) && wait_ready(state),
          "re-fire: show ready");
    close_devices(engine);
    check(state.trigger_item("refire") && on_air(state, engine, "refire") && on_air(state, engine, "side"),
          "re-fire: cue and its start action on air");
    const auto item = engine.find_cue(*state.item_to_cue_id("refire"));
    std::array<float, 256> left{}, right{};
    float* channels[]{left.data(), right.data()};
    for (int i = 0; i < 20; ++i) {
        item->service_read_ahead(1);
        item->render_block(channels, 2, 256);
    }
    const auto deadline = std::chrono::steady_clock::now() + 2s;
    while (heard() == 0 && std::chrono::steady_clock::now() < deadline) std::this_thread::sleep_for(5ms);
    check(heard() == 1, "re-fire: the custom action runs once as the cue passes it");
    const auto side_seq = state.item_trigger_seq("side");
    const double played = item->stats().playhead_seconds;

    check(state.trigger_item("refire") && on_air(state, engine, "refire"), "re-fire: playing cue fired again");
    std::this_thread::sleep_for(200ms);
    check(std::abs(item->stats().playhead_seconds - played) < 0.01, "re-fire: playing cue plays on where it was");
    check(heard() == 1, "re-fire: a playing cue fired again does not repeat the action it passed");
    check(state.item_trigger_seq("side") == side_seq, "re-fire: a playing cue fired again does not re-run its start action");

    check(state.set_item_paused("refire", true), "re-fire: paused");
    check(state.trigger_item("refire") &&
          item->stats().transport != liveplay::audio::TransportState::Paused, "re-fire: firing a paused cue resumes it");
    std::this_thread::sleep_for(200ms);
    check(heard() == 1 && state.item_trigger_seq("side") == side_seq,
          "re-fire: a paused cue fired again repeats neither its action nor its start action");

    check(state.stop_item("refire") && item->stats().transport == liveplay::audio::TransportState::FadingOut,
          "re-fire: stop starts its fade");
    check(state.trigger_item("refire") && on_air(state, engine, "refire"), "re-fire: fired again during its stop fade");
    std::this_thread::sleep_for(200ms);
    check(heard() == 1 && state.item_trigger_seq("side") == side_seq,
          "re-fire: a cue brought back during its fade repeats neither its action nor its start action");
    state.stop_all_cues(0);
}

// Stopping a cue by hand takes it out of the sequencer, so its ending never
// runs; GO must still have somewhere to go.
void test_manual_stop_arms_up_next(const std::filesystem::path& wav) {
    const std::vector<std::pair<json, std::string>> cases{
        {{{"action", "next"}}, "y"},
        {{{"action", "loop"}}, "y"},
        {{{"action", "goto-item"}, {"targetUuid", "z"}}, "z"},
    };
    for (const auto& [ending, expected] : cases) {
        const auto label = "manual stop: a cue ending in " + ending.value("action", std::string{}) +
                           " leaves Up Next on " + expected;
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        check(state.replace_full_document(document(json::array({audio("x", wav, {{"endBehavior", ending}}),
                  audio("y", wav), audio("z", wav)}))) && wait_ready(state), "manual stop: show ready");
        close_devices(engine);
        check(state.trigger_item("x") && on_air(state, engine, "x"), "manual stop: cue on air");
        check(state.stop_item("x"), "manual stop: stopped by hand");
        check(state.next_item_override() == expected, label.c_str());
        state.stop_all_cues(0);
    }
}

// A cue crossfading into the next still plays the end of its file, and the
// custom actions timed there run as it passes them — unless Stop All ends it.
void test_crossfade_tail_actions(const std::filesystem::path& wav) {
    for (const bool stop_all : {false, true}) {
        std::mutex received_mutex;
        std::vector<std::string> received;
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        state.set_external_action_handler([&](const json& action) {
            std::lock_guard lock{received_mutex};
            received.push_back(action.value("marker", ""));
        });
        auto source = audio("xfade-out", wav, {{"outPoint", 0.1}, {"crossFade", 0.05},
            {"endBehavior", {{"action", "next"}}}, {"duckingBehavior", {{"mode", "no-ducking"}}},
            {"customActions", json::array({
                {{"timePoint", 0.02}, {"action", {{"type", "http-request"}, {"marker", "before"}}}},
                {{"timePoint", 0.095}, {"action", {{"type", "http-request"}, {"marker", "tail"}}}},
                {{"timePoint", 0.2}, {"action", {{"type", "http-request"}, {"marker", "outside"}}}},
            })}});
        check(state.replace_full_document(document(json::array({source, audio("xfade-in", wav)}))) &&
              wait_ready(state), "crossfade tail: show ready");
        close_devices(engine);
        check(state.trigger_item("xfade-out"), "crossfade tail: source starts");
        const auto item = engine.find_cue(*state.item_to_cue_id("xfade-out"));
        std::array<float, 256> left{}, right{};
        float* channels[]{left.data(), right.data()};
        bool crossfaded = false;
        for (int i = 0; i < 100 && item->stats().transport != liveplay::audio::TransportState::Stopped; ++i) {
            item->service_read_ahead(1);
            item->render_block(channels, 2, 256);
            std::this_thread::sleep_for(15ms);
            if (!crossfaded && on_air(state, engine, "xfade-in")) {
                crossfaded = true;
                if (stop_all) state.stop_all_cues(0);
            }
        }
        check(crossfaded, "crossfade tail: the next cue came in on the crossfade");
        std::this_thread::sleep_for(200ms);
        std::lock_guard lock{received_mutex};
        if (stop_all)
            check(received == std::vector<std::string>{"before"},
                  "crossfade tail: Stop All during the crossfade cancels the actions still ahead");
        else
            check(received == std::vector<std::string>{"before", "tail"},
                  "crossfade tail: an action inside the crossfade runs once, after the one before it");
        state.stop_all_cues(0);
    }
}

json group_of(const std::string& uuid, const std::string& start, const std::string& end, json children) {
    return json{{"uuid", uuid}, {"type", "group"}, {"startBehavior", {{"action", start}}},
                {"endBehavior", {{"action", end}}}, {"children", std::move(children)}};
}

// The cue that ends a group goes on to what follows the group: Up Next is
// the item after it, not the show's opening cue, and a group playing its
// children in turn runs its own end action only after its last child.
void test_group_end_goes_after_the_group(const std::filesystem::path& wav) {
    const json brief{{"outPoint", 0.02}};
    {
        // The last Nothing cue of a group ends on its own.
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        check(state.replace_full_document(document(json::array({
            audio("opener", wav),
            group_of("scene-1", "play-first", "nothing", json::array({audio("sfx-1", wav, brief), audio("sfx-3", wav, brief)})),
            audio("scene-2", wav),
        }))) && wait_ready(state), "group end: show ready");
        close_devices(engine);
        check(state.trigger_item("sfx-3"), "group end: the group's last cue plays");
        render_to_end(state, engine, "sfx-3");
        check(state.next_item_override() == "scene-2",
              "group end: the last cue of a group arms what follows the group, not the opener");
    }
    {
        // A group set to Play Next whose first child ends on Nothing.
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        check(state.replace_full_document(document(json::array({
            group_of("chapter", "play-first", "next", json::array({audio("child-1", wav, brief), audio("child-2", wav)})),
            audio("after", wav),
        }))) && wait_ready(state), "group end: chapter ready");
        close_devices(engine);
        check(state.trigger_item("chapter"), "group end: the chapter starts its first child");
        render_to_end(state, engine, "child-1");
        check(!on_air(state, engine, "child-2") && !on_air(state, engine, "after"),
              "group end: a child ending on Nothing waits for GO; the group's Play Next does not run yet");
        check(state.next_item_override() == "child-2", "group end: the next child is armed for GO");
    }
    {
        // The last child of a Play All group to finish.
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        check(state.replace_full_document(document(json::array({
            audio("before", wav),
            group_of("together", "play-all", "nothing", json::array({audio("long", wav, {{"outPoint", 0.03}}), audio("short", wav, brief)})),
            audio("following", wav),
        }))) && wait_ready(state), "group end: Play All group ready");
        close_devices(engine);
        check(state.trigger_item("together"), "group end: the Play All group starts");
        render_to_end(state, engine, "short");
        render_to_end(state, engine, "long");
        check(state.next_item_override() == "following",
              "group end: the last child of a Play All group to finish arms what follows the group");
    }
}

void test_external_group_exit(const std::filesystem::path& wav) {
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    json a = audio("exit-a", wav, {{"outPoint", 0.02},
        {"endBehavior", {{"action", "next"}}}});
    json group{{"uuid", "exit-group"}, {"type", "group"},
               {"startBehavior", {{"action", "play-first"}}},
               {"endBehavior", {{"action", "goto-item"}, {"targetUuid", "group-end"}}},
               {"children", json::array({a, audio("exit-b", wav)})}};
    state.replace_full_document(document(json::array({group, audio("external", wav),
                                                       audio("group-end", wav)})));
    check(wait_ready(state), "group external exit: audio ready"); close_devices(engine);
    check(state.trigger_item("exit-group"), "group external exit: run starts");
    check(state.set_next_item_override("external"), "group external exit: override armed");
    render_to_end(state, engine, "exit-a");
    check(wait_for_on_air(state, engine, "external"),
          "group external exit: override target starts");
    render_to_end(state, engine, "external");
    check(!on_air(state, engine, "group-end"), "group external exit: authored group end cancelled");
}

void test_nested_play_first_readiness(const std::filesystem::path& wav) {
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    json nested{{"uuid", "ready-nested"}, {"type", "group"},
                {"startBehavior", {{"action", "play-first"}}},
                {"children", json::array({audio("ready-selected", wav),
                    audio("ready-unselected", wav.string() + ".missing")})}};
    json outer{{"uuid", "ready-outer"}, {"type", "group"},
               {"startBehavior", {{"action", "play-all"}}},
               {"children", json::array({nested})}};
    state.replace_full_document(document(json::array({outer})));
    for (int i = 0; i < 400 && state.audio_readiness().value("loading", true); ++i)
        std::this_thread::sleep_for(5ms);
    close_devices(engine);
    check(state.trigger_item("ready-outer"),
          "group readiness: unselected nested play-first leaf does not reject");
    check(wait_for_on_air(state, engine, "ready-selected") &&
              !on_air(state, engine, "ready-unselected"),
          "group readiness: only selected nested leaf starts");
    state.stop_all_cues(0);
}

void test_start_actions(const std::filesystem::path& wav) {
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    std::mutex messages_mutex;
    std::vector<json> messages;
    state.set_ui_state_broadcaster([&](const json& message) {
        std::lock_guard lock{messages_mutex}; messages.push_back(message);
    });
    auto a = audio("start-a", wav, {{"startBehavior",
        {{"action", "play-item"}, {"targetUuid", "start-b"}}}});
    auto b = audio("start-b", wav, {{"startBehavior",
        {{"action", "play-item"}, {"targetUuid", "start-a"}}}});
    state.replace_full_document(document(json::array({a, b})));
    check(wait_ready(state), "start action: audio ready"); close_devices(engine);
    check(state.trigger_item("start-a"), "start action: primary remains successful");
    check(wait_for_on_air(state, engine, "start-a"),
          "start action: primary remains on Program after cycle rejection");
    check(wait_for_on_air(state, engine, "start-b"),
          "start action: configured secondary starts on Program");
    bool cycle_warning = false;
    {
        std::lock_guard lock{messages_mutex};
        for (const auto& message : messages)
            cycle_warning = cycle_warning ||
                message.value("code", std::string{}) == "sequence_target_invalid";
    }
    check(cycle_warning, "start action: cycle is bounded and operator-visible");
    state.stop_all_cues(0);
}

void test_paused_sequencer(const std::filesystem::path& wav) {
    const auto run_case = [&](const char* label, json extra, bool follows) {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        extra["outPoint"] = 1.0;
        state.replace_full_document(document(json::array({
            audio("pause-a", wav, std::move(extra)), audio("pause-b", wav)})));
        check(wait_ready(state), "paused sequence: audio ready"); close_devices(engine);
        check(state.trigger_item("pause-a"), "paused sequence: source starts");
        const auto source = engine.find_cue(*state.item_to_cue_id("pause-a"));
        source->pause();
        source->seek_seconds(0.8);
        std::this_thread::sleep_for(160ms);
        check(source->stats().transport == liveplay::audio::TransportState::Paused &&
              !on_air(state, engine, "pause-b"), label);
        source->resume();
        if (follows) {
            check(wait_for_on_air(state, engine, "pause-b"), "paused sequence: target starts after Resume");
        } else {
            std::this_thread::sleep_for(160ms);
            check(source->stats().transport == liveplay::audio::TransportState::FadingOut,
                  "paused sequence: stop fade starts after Resume");
        }
        state.stop_all_cues(0);
    };
    run_case("paused sequence: crossfade cannot sound or launch a target",
             {{"crossFade", 0.25}, {"endBehavior", {{"action", "next"}}}}, true);
    run_case("paused sequence: Start Next cannot launch a target",
             {{"startNextEnabled", true}, {"startNextTime", 0.75},
              {"endBehavior", {{"action", "next"}}}}, true);
    run_case("paused sequence: stop fade cannot resume the source",
             {{"stopFade", 0.25}}, false);
    run_case("paused sequence: custom action cannot launch a target",
             {{"customActions", json::array({{{"timePoint", 0.75},
                 {"action", {{"type", "play-item"}, {"uuid", "pause-b"}}}}})}}, true);
}

void test_pause_after_action_copy(const std::filesystem::path& wav) {
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    state.replace_full_document(document(json::array({audio("copied-a", wav, {
        {"outPoint", 1.0}, {"crossFade", 0.25},
        {"endBehavior", {{"action", "next"}}},
        {"customActions", json::array({{{"timePoint", 0.75},
            {"action", {{"type", "http-request"}}}}})}}), audio("copied-b", wav)})));
    check(wait_ready(state), "copied pause: audio ready"); close_devices(engine);
    const auto source = engine.find_cue(*state.item_to_cue_id("copied-a"));
    state.set_external_action_handler([&](const json&) { source->pause(); });
    check(state.trigger_item("copied-a"), "copied pause: source starts");
    source->seek_seconds(0.8);
    std::this_thread::sleep_for(160ms);
    check(source->stats().transport == liveplay::audio::TransportState::Paused &&
          !on_air(state, engine, "copied-b"),
          "copied pause: dispatch rechecks Pause before a copied crossfade");
    source->resume();
    check(wait_for_on_air(state, engine, "copied-b"),
          "copied pause: deferred crossfade fires once after Resume");
    state.stop_all_cues(0);
}

void test_index_transitions(const std::filesystem::path& wav) {
    const auto run_case = [&](const char* label, json extra) {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        extra["outPoint"] = 1.0;
        extra["endBehavior"] = {{"action", "goto-index"}, {"targetIndex", {1, 0}}};
        json target{{"uuid", "index-group"}, {"type", "group"},
                    {"children", json::array({audio("index-b", wav)})}};
        state.replace_full_document(document(json::array({
            audio("index-a", wav, std::move(extra)), target})));
        check(wait_ready(state), "index transition: audio ready"); close_devices(engine);
        check(state.trigger_item("index-a"), "index transition: source starts");
        engine.find_cue(*state.item_to_cue_id("index-a"))->seek_seconds(0.8);
        check(wait_for_on_air(state, engine, "index-b"), label);
        state.stop_all_cues(0);
    };
    run_case("index transition: crossfade resolves nested index target", {{"crossFade", 0.25}});
    run_case("index transition: Start Next resolves nested index target",
             {{"startNextEnabled", true}, {"startNextTime", 0.75}});

    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    state.replace_full_document(document(json::array({audio("retry-a", wav, {
        {"outPoint", 1.0}, {"crossFade", 0.25},
        {"endBehavior", {{"action", "goto-index"}, {"targetIndex", {99}}}}}),
        audio("retry-b", wav)})));
    check(wait_ready(state), "index recovery: audio ready"); close_devices(engine);
    check(state.trigger_item("retry-a"), "index recovery: source starts");
    const auto source = engine.find_cue(*state.item_to_cue_id("retry-a"));
    source->seek_seconds(0.8);
    std::this_thread::sleep_for(160ms);
    check(source->stats().transport == liveplay::audio::TransportState::Playing,
          "index recovery: invalid target does not fade the source to silence");
    check(state.set_next_item_override("retry-b"), "index recovery: target corrected");
    check(wait_for_on_air(state, engine, "retry-b"),
          "index recovery: corrected target can still fire the transition");
    state.stop_all_cues(0);
}

void test_zero_crossfade_boundary(const std::filesystem::path& wav) {
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    state.replace_full_document(document(json::array({audio("butt-a", wav, {
        {"outPoint", 1.0}, {"endBehavior", {{"action", "next"}}}}),
        audio("butt-b", wav)})));
    check(wait_ready(state), "butt transition: audio ready"); close_devices(engine);
    check(state.trigger_item("butt-a"), "butt transition: source starts");
    const auto source = engine.find_cue(*state.item_to_cue_id("butt-a"));
    source->seek_seconds(0.94);
    std::this_thread::sleep_for(160ms);
    check(!on_air(state, engine, "butt-b"),
          "butt transition: zero crossfade never starts the target early");
    render_to_end(state, engine, "butt-a");
    check(wait_for_on_air(state, engine, "butt-b"),
          "butt transition: natural-end fallback still follows");
    state.stop_all_cues(0);
}

std::shared_ptr<liveplay::audio::PreparedFollow> wait_prepared_follow(
    liveplay::audio::AudioEngine& engine, const liveplay::audio::CueId& target) {
    const auto deadline = std::chrono::steady_clock::now() + 2s;
    do {
        const auto topology = engine.snapshot_topology();
        for (const auto& follow : topology->follows) {
            if (follow->target->id() == target && follow->status.load() ==
                liveplay::audio::PreparedFollow::State::Armed) return follow;
        }
        std::this_thread::sleep_for(5ms);
    } while (std::chrono::steady_clock::now() < deadline);
    return {};
}

void render_engine(liveplay::audio::AudioEngine& engine, int blocks) {
    for (int i = 0; i < blocks; ++i) {
        const auto topology = engine.snapshot_topology();
        for (const auto& entry : topology->items) entry.item->service_read_ahead(1);
        engine.render_one_block(*topology);
    }
}

void test_terminal_custom_actions(const std::filesystem::path& wav) {
    for (const bool prepared : {false, true}) {
        std::mutex received_mutex;
        std::vector<std::string> received;
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        state.set_external_action_handler([&](const json& action) {
            std::lock_guard lock{received_mutex};
            received.push_back(action.value("marker", ""));
        });
        auto source = audio("terminal-source", wav, {
            {"outPoint", 0.011}, {"endBehavior", {{"action", prepared ? "next" : "nothing"}}},
            {"duckingBehavior", {{"mode", "no-ducking"}}},
            {"customActions", json::array({
                {{"timePoint", 0.010}, {"action", {{"type", "http-request"}, {"marker", "near"}}}},
                {{"timePoint", 0.011}, {"action", {{"type", "http-request"}, {"marker", "edge"}}}},
                {{"timePoint", 0.012}, {"action", {{"type", "http-request"}, {"marker", "outside"}}}},
            })}});
        state.replace_full_document(document(json::array({source, audio("terminal-target", wav)})));
        check(wait_ready(state), "terminal actions: audio ready");
        engine.create_mixer_channel("Terminal test");
        if (prepared) engine.running_.store(true);
        check(state.trigger_item("terminal-source"), "terminal actions: source starts");
        const auto follow = prepared
            ? wait_prepared_follow(engine, *state.item_to_cue_id("terminal-target"))
            : nullptr;
        render_engine(engine, 4);
        if (prepared) check(follow && follow->status.load() == liveplay::audio::PreparedFollow::State::Fired,
                            "terminal actions: exact follow fires during rendering");
        const auto finished = [&] {
            return prepared ? state.item_trigger_seq("terminal-target").has_value()
                            : state.next_item_override() == "terminal-target";
        };
        const auto deadline = std::chrono::steady_clock::now() + 2s;
        while (!finished() && std::chrono::steady_clock::now() < deadline)
            std::this_thread::sleep_for(5ms);
        check(finished(), "terminal actions: sequencer completes the end action");
        {
            std::lock_guard lock{received_mutex};
            check(received == std::vector<std::string>{"near", "edge"}, prepared
                ? "terminal actions: prepared boundary delivers crossed actions once in order"
                : "terminal actions: natural end delivers crossed actions once in order");
        }
        state.stop_all_cues(0);
        engine.running_.store(false);
    }
}

void test_untrimmed_follow_keeps_final_frame() {
    const auto source = make_wav(8192, 48001), target = make_wav(16384);
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    state.replace_full_document(document(json::array({
        audio("full-source", source, {{"endBehavior", {{"action", "next"}}},
            {"duckingBehavior", {{"mode", "no-ducking"}}}}),
        audio("full-target", target, {{"duckingBehavior", {{"mode", "no-ducking"}}}})})));
    check(wait_ready(state), "full-file boundary: fixtures ready");
    engine.running_.store(true);
    check(state.trigger_item("full-source"), "full-file boundary: source starts");
    const auto a = *state.item_to_cue_id("full-source"), b = *state.item_to_cue_id("full-target");
    const auto follow = wait_prepared_follow(engine, b);
    check(static_cast<bool>(follow), "full-file boundary: audio handoff prepared");
    const auto mixer = engine.create_mixer_channel("Full-file boundary");
    engine.route_item_source_to_mixer(a, 0, mixer);
    engine.route_item_source_to_mixer(b, 0, mixer);
    engine.route_mixer_to_master(mixer, 0, 0.0f, 0);
    render_engine(engine, 187);
    render_engine(engine, 1);
    const auto topology = engine.snapshot_topology();
    check(std::abs(topology->master_accumulators[0][128] - 0.25f) < 1e-6f &&
              std::abs(topology->master_accumulators[0][129] - 0.5f) < 1e-6f,
          "full-file boundary: final fractional-millisecond sample survives before the target");
    state.stop_all_cues(0);
    engine.running_.store(false);
}

void test_live_out_point_refreshes_prepared_endpoint() {
    const auto source = make_wav(8192), target = make_wav(16384);
    for (const bool initially_looping : {false, true}) {
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    state.replace_full_document(document(json::array({
        audio("extend-source", source, {{"outPoint", 0.4}, {"endBehavior", {{"action", initially_looping ? "loop" : "next"}}},
            {"duckingBehavior", {{"mode", "no-ducking"}}}}),
        audio("extend-target", target, {{"duckingBehavior", {{"mode", "no-ducking"}}}})})));
    check(wait_ready(state), "live endpoint: fixtures ready");
    engine.running_.store(true);
    check(state.trigger_item("extend-source"), "live endpoint: source starts");
    const auto a = *state.item_to_cue_id("extend-source"), b = *state.item_to_cue_id("extend-target");
    if (!initially_looping) check(static_cast<bool>(wait_prepared_follow(engine, b)), "live endpoint: initial handoff armed");
    state.update_item("extend-source", {{"outPoint", 0.8}, {"endBehavior", {{"action", "next"}}}});
    check(static_cast<bool>(wait_prepared_follow(engine, b)), initially_looping ? "live endpoint: loop-to-Next arms the updated frame boundary" : "live endpoint: handoff re-prepared after trim edit");
    const auto mixer = engine.create_mixer_channel("Live endpoint");
    engine.route_item_source_to_mixer(a, 0, mixer);
    engine.route_item_source_to_mixer(b, 0, mixer);
    engine.route_mixer_to_master(mixer, 0, 0.0f, 0);
    render_engine(engine, 76);
    check(std::abs(engine.snapshot_topology()->master_accumulators[0][0] - 0.25f) < 1e-6f,
          "live endpoint: extended source remains audible beyond its previous out point");
    render_engine(engine, 74);
    render_engine(engine, 1);
    check(std::abs(engine.snapshot_topology()->master_accumulators[0][0] - 0.5f) < 1e-6f,
          "live endpoint: successor begins at the new authored boundary");
    state.stop_all_cues(0);
    engine.running_.store(false);
    }
}

void test_prepared_follow_runtime(const std::filesystem::path& wav) {
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    state.replace_full_document(document(json::array({audio("prepared-bed", wav), audio("prepared-a", wav, {
        {"outPoint", 0.011}, {"endBehavior", {{"action", "next"}}},
        {"duckingBehavior", {{"mode", "no-ducking"}}}}), audio("prepared-b", wav, {
        {"startBehavior", {{"action", "play-item"}, {"targetUuid", "prepared-c"}}}}),
        audio("prepared-c", wav, {{"duckingBehavior", {{"mode", "no-ducking"}}}}),
        audio("prepared-extra", wav)})));
    check(wait_ready(state), "prepared follow: audio ready"); close_devices(engine);
    // No render thread/device is started. The test drives the real renderer's
    // timeline explicitly while exercising production preparation/bookkeeping.
    engine.running_.store(true);
    check(state.trigger_item("prepared-bed") && state.trigger_item("prepared-a"),
          "prepared follow: source and independent bed start");
    const auto target_id = *state.item_to_cue_id("prepared-b");
    const auto target = engine.find_cue(target_id);
    const auto source = engine.find_cue(*state.item_to_cue_id("prepared-a"));
    const auto follow = wait_prepared_follow(engine, target_id);
    check(static_cast<bool>(follow), "prepared follow: target is primed before source end");
    const auto shuffled = state.shuffle_items(
        {"prepared-bed", "prepared-a", "prepared-b", "prepared-c", "prepared-extra"}, "");
    check(shuffled.value("status", "") == std::string{"ok"} &&
              shuffled.at("uuids") == json::array({"prepared-bed", "prepared-a", "prepared-b",
                                                   "prepared-extra", "prepared-c"}) &&
              follow && follow->status.load() == liveplay::audio::PreparedFollow::State::Armed,
          "shuffle: active playlist keeps an armed handoff and shuffles following entries");
    check(target->stats().transport == liveplay::audio::TransportState::Stopped &&
          on_air(state, engine, "prepared-bed") && !on_air(state, engine, "prepared-c") &&
          !state.item_trigger_seq("prepared-b"),
          "prepared follow: preparation has no play/duck/start-action effects");
    check(state.set_item_paused("prepared-a", true), "prepared follow: source pauses");
    render_engine(engine, 1);
    check(source->stats().playhead_frame == 0 && target->stats().playhead_frame == 0 &&
          target->stats().transport == liveplay::audio::TransportState::Stopped,
          "prepared follow: Pause freezes the audio-thread handoff");
    check(state.set_item_paused("prepared-a", false), "prepared follow: source resumes");
    render_engine(engine, 3);
    check(source->stats().transport == liveplay::audio::TransportState::Stopped &&
          target->stats().playhead_frame == 240,
          "prepared follow: target begins at source frame 528 inside render block");
    const auto deadline = std::chrono::steady_clock::now() + 2s;
    while ((!state.item_trigger_seq("prepared-b") || !on_air(state, engine, "prepared-c")) &&
           std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(5ms);
    check(state.item_trigger_seq("prepared-b").has_value() &&
          target->stats().playhead_frame == 240 && on_air(state, engine, "prepared-c"),
          "prepared follow: bookkeeping runs start actions without restarting PCM");
    state.stop_all_cues(0);
    engine.stop();
}

void test_prepared_follow_cancellation(const std::filesystem::path& wav) {
    const auto run_case = [&](const char* label, auto change, bool follows_c,
                              bool replay_b = false) {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        state.replace_full_document(document(json::array({audio("cancel-a", wav, {
            {"outPoint", 0.011}, {"endBehavior", {{"action", "next"}}}}),
            audio("cancel-b", wav), audio("cancel-c", wav)})));
        check(wait_ready(state), "prepared cancellation: audio ready"); close_devices(engine);
        engine.running_.store(true);
        check(state.trigger_item("cancel-a"), "prepared cancellation: source starts");
        const auto old_follow = wait_prepared_follow(engine, *state.item_to_cue_id("cancel-b"));
        check(static_cast<bool>(old_follow), "prepared cancellation: original target prepared");
        change(state, engine);
        if (follows_c)
            check(static_cast<bool>(wait_prepared_follow(engine, *state.item_to_cue_id("cancel-c"))),
                  "prepared cancellation: replacement target prepared");
        render_engine(engine, 3);
        const auto target = engine.find_cue(*state.item_to_cue_id("cancel-b"));
        check((replay_b ? on_air(state, engine, "cancel-b") &&
                           target->stats().playhead_frame >= 24'000
                       : !on_air(state, engine, "cancel-b")) &&
              (!follows_c || on_air(state, engine, "cancel-c")), label);
        state.stop_all_cues(0);
        engine.stop();
    };
    run_case("prepared cancellation: new Up Next cannot launch stale target",
             [](auto& state, auto&) { (void)state.set_next_item_override("cancel-c"); }, true);
    run_case("prepared cancellation: document edit cannot launch stale target",
             [](auto& state, auto&) { state.update_item("cancel-a", {
                 {"endBehavior", {{"action", "goto-index"}, {"targetIndex", {2}}}}}); }, true);
    run_case("prepared cancellation: Stop cannot launch prepared target",
             [](auto& state, auto&) { state.stop_item("cancel-a"); }, false);
    run_case("prepared cancellation: target replay cannot be reset by stale handoff",
             [](auto& state, auto& engine) {
                 state.trigger_item("cancel-b");
                 engine.find_cue(*state.item_to_cue_id("cancel-b"))->seek_seconds(0.5);
             }, false, true);
}

void test_selected_output_channels() {
    const auto wav = fixture_dir() / "selected-5.1.wav";
    {
        std::ofstream out(wav, std::ios::binary | std::ios::trunc);
        constexpr unsigned frames = 256, channels = 6;
        out.write("RIFF", 4); u32(out, 36 + frames * channels * 2); out.write("WAVEfmt ", 8);
        u32(out, 16); u16(out, 1); u16(out, channels); u32(out, 48'000);
        u32(out, 48'000 * channels * 2); u16(out, channels * 2); u16(out, 16);
        out.write("data", 4); u32(out, frames * channels * 2);
        for (unsigned i = 0; i < frames; ++i)
            for (unsigned c = 0; c < channels; ++c) u16(out, c == 2 ? 8192 : 0);
    }
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    state.replace_full_document(document(json::array({audio("routing", wav)})));
    check(wait_ready(state), "selected output: fixture is owned by project");
    const auto cue = *state.item_to_cue_id("routing");
    const auto item = engine.find_cue(cue);
    const auto mixer = engine.create_mixer_channel("Selected output");
    check(static_cast<bool>(item), "selected output: six-channel PCM decodes");
    if (item) {
        state.route_cue_to_mixer(cue, mixer);
        const auto topology = engine.snapshot_topology();
        const auto& routes = engine.pending_.item_sources[cue.value].by_source_channel;
        constexpr float surround = 0.70710678f;
        const std::array<std::array<float, 2>, 6> expected{{
            {1, 0}, {0, 1}, {surround, surround}, {0.5f, 0.5f},
            {surround, 0}, {0, surround}}};
        bool complete = routes.size() >= expected.size();
        for (std::size_t c = 0; c < expected.size() && c < routes.size(); ++c) {
            std::array<float, 2> got{};
            for (const auto& send : routes[c]) {
                if (send.mixer != mixer) continue;
                if (send.lane == liveplay::audio::kAllMixerLanes) got.fill(send.gain_lin);
                else if (send.lane < 2) got[send.lane] += send.gain_lin;
            }
            for (unsigned lane = 0; lane < 2; ++lane)
                complete = complete && std::fabs(got[lane] - expected[c][lane]) < 0.00001f;
        }
        check(complete, "selected output: center/surround/LFE retain defined stereo gain");
        check(item->prime(1, 0), "selected output: PCM primes");
        item->play();
        engine.render_one_block(*topology);
        bool center_audible = false;
        for (std::size_t i = 0; i < topology->mixers.size(); ++i) {
            if (topology->mixers[i]->id() != mixer) continue;
            center_audible = std::fabs(topology->mixer_accumulators[i * 2][0] -
                                      0.25f * surround) < 0.00001f &&
                std::fabs(topology->mixer_accumulators[i * 2 + 1][0] -
                          0.25f * surround) < 0.00001f;
        }
        check(center_audible, "selected output: actual center-only PCM reaches L and R");
        item->set_ltc_enabled(true);
        state.route_cue_to_mixer(cue, mixer);
        const auto& with_ltc = engine.pending_.item_sources[cue.value].by_source_channel;
        check(with_ltc.size() <= 6 || with_ltc[6].empty(),
              "selected output: synthetic LTC never enters audible downmix");
        const auto ltc_a = engine.create_mixer_channel("LTC A");
        const auto ltc_b = engine.create_mixer_channel("LTC B");
        engine.route_item_source_to_mixer(cue, 6, ltc_a);
        engine.route_item_source_to_mixer(cue, 6, ltc_b);
        engine.set_item_source_mixer(cue, 6, ltc_b);
        engine.set_item_source_mixer(cue, 6, ltc_b);
        auto sends = engine.pending_.item_sources[cue.value].by_source_channel[6];
        check(sends.size() == 1 && sends[0].mixer == ltc_b,
              "LTC routing: destination replacement leaves one synthetic feed");
        engine.set_item_source_mixer(cue, 6, liveplay::audio::MixerChannelId{"missing"});
        sends = engine.pending_.item_sources[cue.value].by_source_channel[6];
        check(sends.size() == 1 && sends[0].mixer == ltc_b,
              "LTC routing: unavailable new mixer preserves the previous feed");
        const auto program_before = engine.pending_.item_sources[cue.value].by_source_channel[2];
        state.apply_ltc_device_routing();
        const auto& cleared = engine.pending_.item_sources[cue.value].by_source_channel;
        check(cleared[6].empty() && cleared[2].size() == program_before.size() &&
                  cleared[2][0].mixer == program_before[0].mixer,
              "LTC routing: None removes synthetic sends and preserves program");
    }
}

void test_unknown_output_rejection(const std::filesystem::path& wav) {
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    state.replace_full_document(document(json::array({audio("output-a", wav)})));
    check(wait_ready(state), "output identity: audio ready"); close_devices(engine);
    const auto before = state.full_document();
    check(!state.patch_settings({{"defaultOutputDevice", "missing-output-session-uuid"}}) &&
          state.full_document()["settings"] == before["settings"],
          "output identity: unknown default is rejected before changing document");
    check(!state.patch_settings({{"previewDevice", "missing-output-session-uuid"}}),
          "output identity: unknown preview selection is rejected");
    check(!state.patch_settings({{"ltcDevice", "missing-output-session-uuid"}}) &&
              state.full_document()["settings"] == before["settings"],
          "LTC routing: invalid selection preserves authored settings");
    check(!state.update_item("output-a", {{"deviceOverride", "missing-output-session-uuid"}}),
          "output identity: unknown per-cue selection is rejected before mutation");
    auto invalid = document(json::array({audio("output-a", wav, {
        {"deviceOverride", "missing-output-session-uuid"}}), audio("output-bed", wav)}));
    state.replace_full_document(invalid);
    check(wait_ready(state), "output identity: legacy project audio ready"); close_devices(engine);
    bool visible_error = false;
    state.set_ui_state_broadcaster([&](const json& event) {
        visible_error = visible_error || event.value("code", std::string{}) == "output_device_unavailable";
    });
    check(state.trigger_item("output-bed"), "output identity: current audience bed starts");
    check(!state.trigger_item("output-a") && visible_error && on_air(state, engine, "output-bed"),
          "output identity: stale persisted UUID cannot fall back to audience speakers");
    state.stop_all_cues(0);

    for (const bool nested : {false, true}) {
        auto bad = audio("output-b", wav, {{"deviceOverride", "missing-output-session-uuid"}});
        json children = json::array({audio("output-a", wav), bad});
        if (nested) children = json::array({json{{"uuid", "inner"}, {"type", "group"},
            {"startBehavior", {{"action", "play-all"}}}, {"children", children}}});
        json group{{"uuid", "output-group"}, {"type", "group"},
            {"startBehavior", {{"action", "play-all"}}}, {"children", children}};
        state.replace_full_document(document(json::array({audio("output-bed", wav), group})));
        check(wait_ready(state), "group outputs: decoded fixtures ready");
        check(state.trigger_item("output-bed"), "group outputs: existing program starts");
        state.set_next_item_override("output-group");
        visible_error = false;
        check(!state.trigger_item("output-group") && visible_error &&
                  !on_air(state, engine, "output-a") && !on_air(state, engine, "output-b") &&
                  on_air(state, engine, "output-bed") && state.next_item_override() == "output-group",
              nested ? "group outputs: nested Play All rejects before disturbing program"
                     : "group outputs: Play All rejects before disturbing program");
        state.stop_all_cues(0);
    }
}

void test_priming_admission(const std::filesystem::path& wav) {
    for (const bool grouped : {false, true}) {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        std::atomic<bool> visible_refusal{false};
        state.set_ui_state_broadcaster([&](const json& event) {
            if (event.value("code", "") == "cue_prepare_failed") visible_refusal.store(true);
        });
        auto invalid = audio("invalid-region", wav, {{"inPoint", 2.0}, {"outPoint", 3.0}});
        json target = invalid;
        if (grouped) target = json{{"uuid", "prime-group"}, {"type", "group"},
            {"startBehavior", {{"action", "play-all"}}},
            {"children", json::array({audio("valid-sibling", wav), invalid})}};
        state.replace_full_document(document(json::array({audio("program", wav), target})));
        check(wait_ready(state), "priming admission: decoded fixtures ready");
        const auto program = engine.find_cue(*state.item_to_cue_id("program"));
        check(program->prime(2.0, 0.0), "priming admission: stopped program prepares");
        const auto revision = program->playback_revision();
        check(program->prime(2.0, 0.0) && program->playback_revision() == revision,
              "priming admission: repeated preparation reuses the same ready PCM");
        check(state.trigger_item("program"), "priming admission: program starts");
        const auto id = *state.item_to_cue_id("invalid-region");
        const auto cue = engine.find_cue(id);
        check(!cue->prime(2.0, 2.0), "priming admission: a start beyond decoded EOF is refused");
        check(!state.trigger_item(grouped ? "prime-group" : "invalid-region") &&
                  on_air(state, engine, "program") && !on_air(state, engine, "invalid-region") &&
                  (!grouped || !on_air(state, engine, "valid-sibling")), grouped
            ? "priming admission: invalid group child cannot partially fire or stop program"
            : "priming admission: failed preparation cannot stop program");
        check(visible_refusal.load(), "priming admission: refused GO reports an actionable preparation error");
        state.stop_all_cues(0);
        state.set_ui_state_broadcaster({});
    }

    for (const bool paused : {false, true}) {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        json group{{"uuid", "active-prime-group"}, {"type", "group"},
            {"startBehavior", {{"action", "play-all"}}},
            {"children", json::array({audio("active-a", wav),
                audio("active-b", wav, {{"duckingBehavior", {{"mode", "no-ducking"}}}})})}};
        state.replace_full_document(document(json::array({audio("active-bed", wav), group})));
        check(wait_ready(state), "active admission: fixtures ready");
        check(state.trigger_item("active-bed") && state.trigger_item("active-b"), "active admission: current program starts");
        const auto b = engine.find_cue(*state.item_to_cue_id("active-b"));
        if (paused) b->pause();
        const auto before = b->stats().transport;
        state.update_item("active-b", {{"inPoint", 2.0}, {"outPoint", 3.0}});
        state.set_next_item_override("active-prime-group");
        check(!state.trigger_item("active-prime-group") && !on_air(state, engine, "active-a") &&
                  on_air(state, engine, "active-bed") && b->stats().transport == before &&
                  state.next_item_override() == "active-prime-group",
              paused ? "active admission: invalid paused child rejects before sibling/program effects"
                     : "active admission: invalid playing child rejects before sibling/program effects");
        state.stop_all_cues(0);
    }

    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    json group{{"uuid", "prime-existing"}, {"type", "group"},
        {"startBehavior", {{"action", "play-all"}}},
        {"endBehavior", {{"action", "goto-item"}, {"targetUuid", "after-group"}}},
        {"children", json::array({
            audio("long-child", wav, {{"duckingBehavior", {{"mode", "no-ducking"}}}}),
            audio("short-child", wav, {{"outPoint", 0.01}, {"duckingBehavior", {{"mode", "no-ducking"}}}})})}};
    state.replace_full_document(document(json::array({group, audio("after-group", wav)})));
    check(wait_ready(state) && state.trigger_item("prime-existing"), "priming admission: existing group starts");
    render_to_end(state, engine, "short-child");
    state.update_item("short-child", {{"inPoint", 2.0}, {"outPoint", 3.0}});
    check(!state.trigger_item("prime-existing") && on_air(state, engine, "long-child"),
          "priming admission: failed group retrigger preserves its active child");
    render_to_end(state, engine, "long-child");
    check(wait_for_on_air(state, engine, "after-group"),
          "priming admission: failed retrigger preserves the original group continuation");
    state.stop_all_cues(0);

    state.replace_full_document(document(json::array({
        audio("armed-source", wav, {{"endBehavior", {{"action", "goto-item"}, {"targetUuid", "armed-target"}}}}),
        json{{"uuid", "other-group"}, {"type", "group"}, {"startBehavior", {{"action", "play-all"}}},
            {"children", json::array({audio("armed-target", wav),
                audio("invalid-child", wav, {{"inPoint", 2.0}, {"outPoint", 3.0}})})}}})));
    check(wait_ready(state), "priming admission: pending follow fixtures ready");
    engine.running_.store(true);
    state.trigger_item("armed-source");
    const auto target = engine.find_cue(*state.item_to_cue_id("armed-target"));
    const auto follow = wait_prepared_follow(engine, target->id());
    check(static_cast<bool>(follow), "priming admission: original exact follow is armed");
    const auto revision = target->playback_revision();
    check(!state.trigger_item("other-group") && on_air(state, engine, "armed-source") &&
              target->playback_revision() == revision && follow &&
              follow->status.load() == liveplay::audio::PreparedFollow::State::Armed,
          "priming admission: refused group leaves an existing exact follow intact");
    state.stop_all_cues(0);
    engine.running_.store(false);
}

void test_output_identity_catalog() {
    using liveplay::audio::DeviceInfo;
    DeviceInfo stage;
    stage.id = liveplay::audio::DeviceId{"session-a"};
    stage.display_name = "Stage Output";
    stage.is_open = true;
    std::vector<DeviceInfo> devices{stage};
    const auto resolve = [&](const char* selection) {
        return liveplay::core::detail::resolve_output_device(selection, devices);
    };
    check(resolve("session-a") == &devices[0] && resolve("Stage Output") == &devices[0],
          "output catalog: current runtime UUID and full catalog name resolve together");
    check(!resolve("Stage") && !resolve("prior-session-uuid"),
          "output catalog: partial names and stale UUIDs never guess another output");
    devices[0].is_open = false;
    devices[0].id = liveplay::audio::DeviceId{"Stage Output"};
    check(resolve("Stage Output") == &devices[0] && !resolve("session-a"),
          "output catalog: saved full name survives a new device session");
    devices[0].is_open = true;
    devices[0].id = liveplay::audio::DeviceId{"session-a"};
    auto duplicate = stage;
    duplicate.id = liveplay::audio::DeviceId{"session-b"};
    devices.push_back(duplicate);
    check(!resolve("Stage Output") && resolve("session-b") == &devices[1],
          "output catalog: duplicate names fail while an exact opened id stays precise");
    devices[1].is_available = false;
    check(!resolve("session-b") && resolve("Stage Output") == &devices[0],
          "output catalog: disconnected devices cannot receive a selected route");
}

void test_failed_follow_requires_go(const std::filesystem::path& wav) {
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    state.replace_full_document(document(json::array({audio("failed-follow-a", wav, {
        {"outPoint", 0.02}, {"endBehavior", {{"action", "goto-index"}, {"targetIndex", {99}}}}}),
        audio("failed-follow-b", wav)})));
    check(wait_ready(state), "failed follow: audio ready"); close_devices(engine);
    std::atomic<bool> visible_error{false};
    state.set_ui_state_broadcaster([&](const json& event) {
        if (event.value("code", std::string{}) == "sequence_target_invalid") visible_error.store(true);
    });
    check(state.trigger_item("failed-follow-a"), "failed follow: source starts");
    render_to_end(state, engine, "failed-follow-a");
    for (int i = 0; i < 400 && !visible_error.load(); ++i) std::this_thread::sleep_for(5ms);
    check(visible_error.load(), "failed follow: unavailable EOF destination is operator-visible");
    check(state.set_next_item_override("failed-follow-b"), "failed follow: operator corrects Up Next");
    std::this_thread::sleep_for(160ms);
    check(!on_air(state, engine, "failed-follow-b"),
          "failed follow: a late correction never auto-plays after EOF");
    check(state.go() == "failed-follow-b" && on_air(state, engine, "failed-follow-b"),
          "failed follow: explicit GO can retry the corrected target");
    state.stop_all_cues(0);
}

void test_failed_group_follow_requires_go(const std::filesystem::path& wav) {
    for (const bool nested_failure : {false, true}) {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        const json invalid_end{{"action", "goto-index"}, {"targetIndex", {99}}};
        auto child = audio("held-child", wav, {{"outPoint", 0.02},
            {"endBehavior", nested_failure ? json{{"action", "nothing"}} : invalid_end}});
        json inner{{"uuid", "held-inner"}, {"type", "group"},
                   {"startBehavior", {{"action", "play-first"}}},
                   {"endBehavior", invalid_end}, {"children", json::array({child})}};
        json outer{{"uuid", "held-outer"}, {"type", "group"},
                   {"startBehavior", {{"action", "play-first"}}},
                   {"endBehavior", {{"action", "goto-item"}, {"targetUuid", "held-target"}}},
                   {"children", json::array({nested_failure ? inner : child})}};
        state.replace_full_document(document(json::array({outer, audio("held-target", wav)})));
        check(wait_ready(state), "failed group follow: media ready"); close_devices(engine);
        std::atomic<bool> visible_error{false};
        state.set_ui_state_broadcaster([&](const json& event) {
            if (event.value("code", std::string{}) == "sequence_target_invalid")
                visible_error.store(true);
        });
        check(state.trigger_item("held-outer"), "failed group follow: source starts");
        render_to_end(state, engine, "held-child");
        std::this_thread::sleep_for(160ms);
        check(visible_error.load(), "failed group follow: unavailable destination is visible");
        check(!on_air(state, engine, "held-target"), nested_failure
            ? "failed nested group follow cannot fire outer group ending on later ticks"
            : "failed child follow cannot fire group ending on later ticks");
        check(state.set_next_item_override("held-target") && state.go() == "held-target" &&
                  on_air(state, engine, "held-target"),
              "failed group follow: explicit GO still starts corrected target");
        state.stop_all_cues(0);
        state.set_ui_state_broadcaster({});
    }
}

void test_shuffle_items(const std::filesystem::path& wav) {
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    auto group = json{{"uuid", "music"}, {"type", "group"}, {"children", json::array({
        audio("one", wav), audio("two", wav), audio("three", wav), audio("four", wav),
    })}};
    auto show = document(json::array({group, audio("opener", wav, {
        {"endBehavior", {{"action", "goto-index"}, {"targetIndex", {0, 0}}}},
    }), audio("closer", wav)}));
    check(state.load_from_json(show), "shuffle: show opens");
    check(wait_ready(state), "shuffle: media ready"); close_devices(engine);
    const auto cue_before = state.item_to_cue_id("one");
    check(state.set_next_item_override("three"), "shuffle: explicit Up Next armed");
    const std::vector<std::string> original{"one", "two", "three", "four"};
    const auto inside = state.shuffle_items(original, "music");
    check(inside.value("status", "") == std::string{"ok"} &&
          inside.at("uuids") != original &&
          state.item_uuid_by_index({0, 0}) == "one" && state.next_item_override() == "three",
          "shuffle: numbered target stays fixed, order changes, explicit Up Next survives");
    const auto order = inside.at("uuids").get<std::vector<std::string>>();
    const auto root = state.shuffle_items({"music", "opener", "closer"}, "");
    check(root.value("status", "") == std::string{"ok"} &&
          root.at("uuids") == json::array({"music", "closer", "opener"}) &&
          state.item_uuid_by_index({0, 1}) == order.at(1) &&
          cue_before.has_value() && state.item_to_cue_id("one") == cue_before,
          "shuffle: nested group moves only as a unit and keeps loaded cue IDs");
    check(state.shuffle_items({"music", "opener", "closer"}, "").value("status", "") == std::string{"changed"},
          "shuffle: stale order cannot overwrite a newer edit");
    check(state.set_next_item_override(order[1]) && state.go() == order[1] &&
          state.set_next_item_override(order[2]), "shuffle: starts a group child and arms a later cue");
    const auto live_intent = state.playback_intent_revision();
    const auto live_pass = state.item_trigger_seq(order[1]);
    const auto live = state.shuffle_items(order, "music");
    const std::vector<std::string> updated{order[0], order[1], order[3], order[2]};
    check(live.value("status", "") == std::string{"ok"} && live.at("uuids") == updated &&
          on_air(state, engine, order[1]) && state.item_trigger_seq(order[1]) == live_pass &&
          state.playback_intent_revision() == live_intent && state.next_item_override() == order[2],
          "shuffle: changes the upcoming group order while preserving the active pass and manual Up Next");
    const auto live_root = state.shuffle_items({"music", "closer", "opener"}, "");
    check(live_root.value("status", "") == std::string{"ok"} &&
              live_root.at("uuids") == json::array({"music", "opener", "closer"}) &&
              state.item_uuid_by_index({0, 0}) == "one" &&
              on_air(state, engine, order[1]) && state.item_trigger_seq(order[1]) == live_pass &&
              state.playback_intent_revision() == live_intent && state.next_item_override() == order[2],
          "shuffle: live playlist preserves the active branch, numbered target, and manual Up Next");
    check(state.go() == order[2] &&
          state.shuffle_items(updated, "music").value("status", "") == std::string{"upcoming"},
          "shuffle: manual GO survives the new order and a group ending stays in place");
    state.stop_all_cues(0);
}

void test_quick_play_continuation(const std::filesystem::path& wav) {
    for (const auto ending : {"nothing", "loop", "goto-item"}) {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        auto show = document(json::array({audio("first", wav), audio("late", wav)}));
        show["quickPlayItems"] = json::array({audio("quick-play", wav, {
            {"quickPlay", {{"order", 0}}}, {"endBehavior", {{"action", ending}, {"targetUuid", "first"}}},
            {"outPoint", 0.08}, {"stopFade", 0.01},
        })});
        check(state.load_from_json(show) && wait_ready(state), "QuickPlay follow: project and media load");
        close_devices(engine);
        check(state.set_next_item_override("") && state.trigger_item("quick-play") &&
              !state.cue_to_continue("quick-play"), "QuickPlay follow: needs a playlist target");
        check(state.set_next_item_override("first") && state.cue_to_continue("quick-play") &&
              state.set_next_item_override("late") && on_air(state, engine, "quick-play") &&
              !on_air(state, engine, "first") && !on_air(state, engine, "late"),
              "QuickPlay follow: arming and changing Up Next do not interrupt playback");
        render_to_end(state, engine, "quick-play");
        for (int i = 0; i < 500 && !on_air(state, engine, "late"); ++i)
            std::this_thread::sleep_for(2ms);
        check(on_air(state, engine, "late") && !on_air(state, engine, "first") &&
              state.full_document()["quickPlayItems"][0]["endBehavior"]["action"] == ending,
              "QuickPlay follow: natural ending starts the latest Up Next without altering the authored ending");
        state.stop_all_cues(0);
    }
}

// A QuickPlay pressed again while it plays starts over from its In point when
// its Retrigger is Restart, and keeps its place when it is Ignore. (For Ignore
// the client does not send the second press; the engine honours it as well.)
void test_quick_play_restart(const std::filesystem::path& wav) {
    for (const std::string retrigger : {"restart", "ignore"}) {
        const bool restarts = retrigger == "restart";
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        auto show = document(json::array());
        show["quickPlayItems"] = json::array({audio("quick-play", wav, {
            {"quickPlay", {{"order", 0}, {"retrigger", retrigger}}}, {"inPoint", 0.1},
        })});
        check(state.load_from_json(show) && wait_ready(state), "QuickPlay restart: project and media load");
        close_devices(engine);
        check(state.trigger_item("quick-play"), "QuickPlay restart: first press starts it");
        const auto item = engine.find_cue(*state.item_to_cue_id("quick-play"));
        std::array<float, 256> left{}, right{};
        float* channels[]{left.data(), right.data()};
        for (int i = 0; i < 40; ++i) {
            item->service_read_ahead(1);
            item->render_block(channels, 2, 256);
        }
        const double played = item->stats().playhead_seconds;
        check(played > 0.15, "QuickPlay restart: playback has moved past its In point");
        check(state.trigger_item("quick-play") && on_air(state, engine, "quick-play"),
              "QuickPlay restart: second press is accepted and it stays on air");
        if (restarts)
            check(std::abs(item->stats().playhead_seconds - 0.1) < 0.01,
                  "QuickPlay restart: Restart starts it again from its In point");
        else
            check(std::abs(item->stats().playhead_seconds - played) < 0.01,
                  "QuickPlay restart: Ignore keeps it playing where it was");
        state.stop_all_cues(0);
    }
}

// A QuickPlay's saved ending, and the Cue to Continue toggle that overrides it
// for one pass, both resolve against the playlist's Up Next rather than the
// QuickPlay's own (meaningless) position.
void test_quick_play_authored_follow(const std::filesystem::path& wav) {
    const auto show = [&](json quick_play) {
        auto doc = document(json::array({audio("first", wav), audio("late", wav)}));
        json item{{"quickPlay", {{"order", 0}}}, {"outPoint", 0.08}, {"stopFade", 0.01}};
        item.update(quick_play);
        doc["quickPlayItems"] = json::array({audio("quick-play", wav, item)});
        return doc;
    };
    const auto starts = [](liveplay::core::ProjectState& state, liveplay::audio::AudioEngine& engine,
                           const std::string& uuid) {
        for (int i = 0; i < 500 && !on_air(state, engine, uuid); ++i)
            std::this_thread::sleep_for(2ms);
        return on_air(state, engine, uuid);
    };
    {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        std::vector<std::string> follow_events;
        state.set_ui_state_broadcaster([&](const json& event) {
            if (event.value("op", std::string{}) == "cue_follow_set" &&
                event.value("itemUuid", std::string{}) == "quick-play")
                follow_events.push_back(event.value("follow", std::string{"?"}));
        });
        check(state.load_from_json(show({{"endBehavior", {{"action", "next"}}}})) && wait_ready(state),
              "QuickPlay Play Next: project and media load");
        close_devices(engine);
        check(state.set_next_item_override("late") && state.trigger_item("quick-play") &&
              state.cue_follow_state("quick-play").empty() &&
              !on_air(state, engine, "first") && !on_air(state, engine, "late"),
              "QuickPlay Play Next: plays without touching the playlist");
        render_to_end(state, engine, "quick-play");
        check(starts(state, engine, "late") && !on_air(state, engine, "first") &&
              state.full_document()["quickPlayItems"][0]["endBehavior"]["action"] == "next",
              "QuickPlay Play Next: natural ending starts Up Next");
        state.stop_all_cues(0);

        check(state.set_next_item_override("late") && state.trigger_item("quick-play") &&
              state.set_cue_follow("quick-play", false) &&
              state.cue_follow_state("quick-play") == "suppressed",
              "QuickPlay Play Next: the toggle cancels this pass");
        render_to_end(state, engine, "quick-play");
        std::this_thread::sleep_for(150ms);
        check(!on_air(state, engine, "late") && !on_air(state, engine, "first") &&
              state.next_item_override() == "late" &&
              state.full_document()["quickPlayItems"][0]["endBehavior"]["action"] == "next",
              "QuickPlay Play Next: a cancelled pass leaves Up Next and the saved ending alone");

        check(state.trigger_item("quick-play") && state.cue_follow_state("quick-play").empty() &&
              state.set_cue_follow("quick-play", false) && state.set_cue_follow("quick-play", true) &&
              state.cue_follow_state("quick-play").empty(),
              "QuickPlay Play Next: a new pass starts on, and toggling back restores it");
        render_to_end(state, engine, "quick-play");
        check(starts(state, engine, "late"), "QuickPlay Play Next: restored pass starts Up Next");
        state.stop_all_cues(0);
        state.set_ui_state_broadcaster({});
        check(follow_events == std::vector<std::string>{"suppressed", "suppressed", ""},
              "QuickPlay Play Next: every toggle change is published to clients");
    }
    {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        check(state.load_from_json(show({{"endBehavior", {{"action", "nothing"}}}})) && wait_ready(state),
              "QuickPlay toggle: project and media load");
        close_devices(engine);
        check(state.set_next_item_override("first") && state.trigger_item("quick-play") &&
              state.set_cue_follow("quick-play", true) && state.cue_follow_state("quick-play") == "armed" &&
              state.set_cue_follow("quick-play", false) && state.cue_follow_state("quick-play").empty(),
              "QuickPlay toggle: arming can be switched off again");
        render_to_end(state, engine, "quick-play");
        std::this_thread::sleep_for(150ms);
        check(!on_air(state, engine, "first") && !on_air(state, engine, "late") &&
              state.next_item_override() == "first",
              "QuickPlay toggle: an un-armed pass just stops");
        state.stop_all_cues(0);
    }
    {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        check(state.load_from_json(show({{"endBehavior", {{"action", "loop"}}}, {"outPoint", 0.02}})) &&
              wait_ready(state), "QuickPlay loop toggle: project and media load");
        close_devices(engine);
        check(state.set_next_item_override("first") && state.trigger_item("quick-play") &&
              state.set_cue_follow("quick-play", true) && state.set_cue_follow("quick-play", false),
              "QuickPlay loop toggle: arm then un-arm is accepted");
        render_to_end(state, engine, "quick-play", 80);
        check(wait_for_on_air(state, engine, "quick-play") && !on_air(state, engine, "first"),
              "QuickPlay loop toggle: un-arming resumes the saved loop");
        check(state.set_cue_follow("quick-play", true), "QuickPlay loop toggle: re-arms");
        render_to_end(state, engine, "quick-play");
        check(starts(state, engine, "first") &&
              state.full_document()["quickPlayItems"][0]["endBehavior"]["action"] == "loop",
              "QuickPlay loop toggle: armed pass finishes into Up Next and stays a saved loop");
        state.stop_all_cues(0);
    }
    {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        check(state.load_from_json(show({{"endBehavior", {{"action", "goto-item"}, {"targetUuid", "late"}}}})) &&
              wait_ready(state), "QuickPlay Go to Item: project and media load");
        close_devices(engine);
        check(state.set_next_item_override("first") && state.trigger_item("quick-play"),
              "QuickPlay Go to Item: starts");
        render_to_end(state, engine, "quick-play");
        check(starts(state, engine, "late") && !on_air(state, engine, "first"),
              "QuickPlay Go to Item: follows its own target, not Up Next");
        state.stop_all_cues(0);
    }
    {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        check(state.load_from_json(show({{"endBehavior", {{"action", "next"}}}})) && wait_ready(state),
              "QuickPlay Play Next without Up Next: project and media load");
        close_devices(engine);
        check(state.set_next_item_override("") && state.trigger_item("quick-play"),
              "QuickPlay Play Next without Up Next: starts");
        render_to_end(state, engine, "quick-play");
        std::this_thread::sleep_for(150ms);
        check(!on_air(state, engine, "first") && !on_air(state, engine, "late"),
              "QuickPlay Play Next without Up Next: just stops");
        state.stop_all_cues(0);
    }
    {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        check(state.load_from_json(show({{"endBehavior", {{"action", "next"}}}, {"crossFade", 0.03}})) &&
              wait_ready(state), "QuickPlay crossfade: project and media load");
        close_devices(engine);
        check(state.set_next_item_override("late") && state.trigger_item("quick-play"),
              "QuickPlay crossfade: starts");
        render_to_end(state, engine, "quick-play");
        check(starts(state, engine, "late") && !on_air(state, engine, "first"),
              "QuickPlay crossfade: crossfades into Up Next");
        state.stop_all_cues(0);
    }
    {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        check(state.load_from_json(show({{"endBehavior", {{"action", "next"}}}, {"outPoint", 0.3},
                  {"startNextEnabled", true}, {"startNextTime", 0.05}})) &&
              wait_ready(state), "QuickPlay Start Next: project and media load");
        close_devices(engine);
        check(state.set_next_item_override("late") && state.trigger_item("quick-play"),
              "QuickPlay Start Next: starts");
        const auto quick_play = engine.find_cue(*state.item_to_cue_id("quick-play"));
        std::array<float, 256> left{}, right{};
        float* channels[]{left.data(), right.data()};
        for (int block = 0; quick_play && block < 30; ++block) {
            quick_play->service_read_ahead(1);
            quick_play->render_block(channels, 2, 256);
        }
        check(starts(state, engine, "late") && on_air(state, engine, "quick-play"),
              "QuickPlay Start Next: marker starts Up Next while the QuickPlay plays on");
        state.stop_all_cues(0);
    }
    {
        // The usual live case: a QuickPlay is fired over the tail of the
        // playlist cue on air. That cue ending must still queue the next
        // playlist cue, so the QuickPlay has somewhere to hand over to.
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        auto doc = document(json::array({audio("first", wav, {{"outPoint", 0.05}}), audio("late", wav)}));
        doc["quickPlayItems"] = json::array({audio("quick-play", wav, {
            {"quickPlay", {{"order", 0}}}, {"endBehavior", {{"action", "next"}}},
            {"duckingBehavior", {{"mode", "no-ducking"}}}, {"outPoint", 0.3}, {"stopFade", 0.01},
        })});
        check(state.load_from_json(doc) && wait_ready(state), "QuickPlay over a playlist cue: project and media load");
        close_devices(engine);
        check(state.set_next_item_override("first") && state.go() == "first" &&
              state.trigger_item("quick-play") && on_air(state, engine, "first") &&
              on_air(state, engine, "quick-play"),
              "QuickPlay over a playlist cue: both play");
        render_to_end(state, engine, "first");
        for (int i = 0; i < 250 && state.next_item_override() != "late"; ++i)
            std::this_thread::sleep_for(2ms);
        check(on_air(state, engine, "quick-play") && !on_air(state, engine, "late") &&
              state.next_item_override() == "late",
              "QuickPlay over a playlist cue: the ending cue still queues Up Next");
        render_to_end(state, engine, "quick-play");
        check(starts(state, engine, "late"),
              "QuickPlay over a playlist cue: Play Next hands over to the queued cue");
        state.stop_all_cues(0);
    }
}

// True when any object key, at any depth, still says "cart" or "oneShot".
bool has_old_quick_play_name(const json& value) {
    if (value.is_object()) {
        for (const auto& [key, child] : value.items()) {
            std::string lower = key;
            std::transform(lower.begin(), lower.end(), lower.begin(),
                           [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
            if (lower.find("cart") != std::string::npos ||
                lower.find("oneshot") != std::string::npos) {
                return true;
            }
            if (has_old_quick_play_name(child)) return true;
        }
    } else if (value.is_array()) {
        for (const auto& child : value)
            if (has_old_quick_play_name(child)) return true;
    }
    return false;
}

// A show saved before the QuickPlay rename (and a backup of it, and the same
// document pushed by a client) opens, is served and is saved again under the
// current names only, with nothing lost.
void test_legacy_quick_play_names(const std::filesystem::path& wav) {
    struct Names {
        const char* quick_play_items;
        const char* slots;
        const char* slot_keys;
        const char* slot_count;
        const char* item_settings;
    };
    const Names old_names{"cartOnlyItems", "cartItems", "cartSlotKeys", "cartSlotCount", "oneShot"};
    const Names new_names{"quickPlayItems", "quickPlaySlots", "quickPlaySlotKeys",
                          "quickPlaySlotCount", "quickPlay"};
    const json hotkey{{"key", "F2"}, {"ctrlKey", false}, {"shiftKey", false}, {"altKey", false}};
    // Every renamed field: a QuickPlay item, a slot assignment with its key,
    // the settings slot count, and a playlist cue inside a group that carries
    // QuickPlay settings.
    const auto show = [&](const Names& names) {
        json pad_settings = json::object(), linked_settings = json::object();
        pad_settings[names.item_settings] = json{{"order", 0}, {"retrigger", "restart"}};
        linked_settings[names.item_settings] = json{{"order", 2}, {"retrigger", "ignore"}};
        json doc{{"name", "legacy-names"}, {"folderPath", ""}};
        doc["items"] = json::array({json{
            {"uuid", "set"}, {"type", "group"}, {"displayName", "set"},
            {"startBehavior", {{"action", "play-first"}}}, {"endBehavior", {{"action", "nothing"}}},
            {"children", json::array({audio("plain", wav), audio("linked", wav, linked_settings)})},
        }});
        doc[names.quick_play_items] = json::array({audio("pad", wav, pad_settings)});
        doc[names.slots] = json::array({json{{"slot", 1}, {"itemUuid", "plain"}, {"index", json::array({-1, 1})}}});
        doc[names.slot_keys] = json::object();
        doc[names.slot_keys]["1"] = hotkey;
        doc["settings"] = json::object();
        doc["settings"][names.slot_count] = 24;
        return doc;
    };
    const auto quick_play_settings = [](const json& doc, const char* uuid) {
        for (const auto& item : doc.value("quickPlayItems", json::array()))
            if (item.value("uuid", std::string{}) == uuid) return item.value("quickPlay", json{});
        return json{};
    };
    // What the old show holds once it is open: the same QuickPlays, slot
    // assignment, key, slot count and playlist, under the current names.
    const auto check_current = [&](const json& doc, const char* label) {
        const auto children = doc.contains("items") && doc["items"].is_array() && !doc["items"].empty()
            ? doc["items"][0].value("children", json::array()) : json::array();
        check(!has_old_quick_play_name(doc) &&
                  doc.value("quickPlayItems", json::array()).size() == 3 &&
                  quick_play_settings(doc, "pad") == json{{"order", 0}, {"retrigger", "restart"}} &&
                  quick_play_settings(doc, "plain-one-shot") ==
                      json{{"order", 1}, {"retrigger", "restart"}, {"hotkey", hotkey}, {"sourceUuid", "plain"}} &&
                  quick_play_settings(doc, "linked-one-shot") ==
                      json{{"order", 2}, {"retrigger", "ignore"}, {"sourceUuid", "linked"}} &&
                  doc.value("quickPlaySlots", json{}) == json::array() &&
                  doc.value("quickPlaySlotKeys", json{}) == json::object() &&
                  doc.value("settings", json::object()).value("quickPlaySlotCount", 0) == 24 &&
                  children.size() == 2 && children[0].value("uuid", "") == "plain" &&
                  children[1].value("uuid", "") == "linked" &&
                  !children[0].contains("quickPlay") && !children[1].contains("quickPlay"),
              label);
    };
    const auto read_show = [](const std::filesystem::path& file) {
        std::ifstream input{file};
        return json::parse(input, nullptr, /*allow_exceptions=*/false);
    };

    const auto folder = std::filesystem::temp_directory_path() /
        ("dwcue-legacy-names-" + std::to_string(
            std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directory(folder);
    const auto path = folder / "Old.dwcue";
    const auto twin_path = folder / "Current.dwcue";
    std::ofstream{path} << show(old_names).dump(2);
    std::ofstream{twin_path} << show(new_names).dump(2);
    check(has_old_quick_play_name(read_show(path)) && !has_old_quick_play_name(read_show(twin_path)),
          "legacy names: fixture shows use the old and the current names");

    // The same show written with the current names, opened and saved.
    json twin_saved;
    {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        check(state.load(twin_path) && wait_ready(state) && state.save(twin_path),
              "legacy names: the show under the current names opens and saves");
        close_devices(engine);
        twin_saved = read_show(twin_path);
    }

    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    check(state.load(path) && wait_ready(state), "legacy names: a show saved with the old names opens");
    close_devices(engine);
    check_current(state.full_document(), "legacy names: the served show has the current names and all its content");
    const auto header = state.header_document();
    check(!has_old_quick_play_name(header) && header["quickPlayItems"].size() == 3 &&
              header["quickPlaySlots"].empty() && header["quickPlaySlotKeys"].empty() &&
              header["settings"]["quickPlaySlotCount"] == 24,
          "legacy names: the served header has the current names");

    check(state.save(path), "legacy names: the opened show saves");
    auto saved = read_show(path);
    check_current(saved, "legacy names: the saved show has only the current names and all its content");
    saved.erase("lastModified");
    twin_saved.erase("lastModified");
    check(saved == twin_saved, "legacy names: old and current names save the same show");

    // The first save kept the old file as a backup. It restores like any other.
    const auto backups = state.list_show_backups();
    check(backups.size() == 1 && has_old_quick_play_name(read_show(backups.front().path)),
          "legacy names: the backup of the old file still has the old names");
    if (!backups.empty()) {
        const auto restored = state.restore_show_backup(backups.front().name);
        check(restored.status == liveplay::core::ProjectState::RestoreBackupStatus::Restored &&
                  wait_ready(state) && !has_old_quick_play_name(restored.header),
              "legacy names: a backup written with the old names restores");
        close_devices(engine);
        check_current(state.full_document(), "legacy names: the restored show has the current names and all its content");
        check(state.save(path), "legacy names: the restored show saves");
        check_current(read_show(path), "legacy names: the restored show saves only the current names");
    }

    // A whole document pushed by a client that still uses the old names.
    check(state.replace_full_document(show(old_names), false) && wait_ready(state),
          "legacy names: a pushed document with the old names is accepted");
    close_devices(engine);
    check_current(state.full_document(), "legacy names: the pushed document has the current names and all its content");

    check(state.trigger_item("pad") && on_air(state, engine, "pad") &&
              state.trigger_item("linked-one-shot") && on_air(state, engine, "linked-one-shot"),
          "legacy names: converted QuickPlays play");
    state.stop_all_cues(0);

    // Slot assignments, the state summary and the slot count use the current names.
    check(state.set_quick_play_slot(3, "pad") && state.quick_play_slot_item_uuid(3) == "pad" &&
              state.full_document()["quickPlaySlots"] ==
                  json::array({json{{"slot", 3}, {"itemUuid", "pad"}, {"index", json::array({-1, 3})}}}),
          "legacy names: a slot assignment is stored in quickPlaySlots");
    const auto summary = state.state_summary();
    check(!has_old_quick_play_name(summary) && summary.value("quickPlays", json{}).size() == 1 &&
              summary["quickPlays"][0].value("slot", -1) == 3 &&
              summary["quickPlays"][0].value("itemUuid", "") == "pad" &&
              summary["quickPlays"][0].value("name", "") == "pad",
          "legacy names: the state summary lists slot assignments as quickPlays");
    check(state.clear_quick_play_slot(3) && state.full_document()["quickPlaySlots"].empty() &&
              state.state_summary()["quickPlays"].empty(),
          "legacy names: clearing a slot empties quickPlaySlots");
    check(!state.patch_settings({{"quickPlaySlotCount", 65}}) &&
              state.patch_settings({{"quickPlaySlotCount", 32}}) &&
              state.full_document()["settings"]["quickPlaySlotCount"] == 32,
          "legacy names: the slot count is checked and stored as quickPlaySlotCount");
    const auto added = state.add_item(audio("added", wav, {{"quickPlay", {{"order", 7}}}}), "",
                                      /*quick_play_only=*/true);
    check(!added.value.empty() && wait_ready(state) &&
              quick_play_settings(state.full_document(), "added") == json{{"order", 7}} &&
              state.full_document()["items"].size() == 1,
          "legacy names: a QuickPlay-only item is added to quickPlayItems");
    close_devices(engine);
    check(state.save(path) && !has_old_quick_play_name(read_show(path)),
          "legacy names: later saves still contain only the current names");

    std::error_code error;
    std::filesystem::remove_all(folder, error);
}

void test_group_levels() {
    const auto wav = make_wav(8192);
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    const auto cue = [&](const std::string& uuid, double volume = 1.0) {
        return audio(uuid, wav, {{"volume", volume}, {"duckingBehavior", {{"mode", "no-ducking"}}}});
    };
    const json nested{{"uuid", "nested"}, {"type", "group"}, {"groupGainDb", -6.0},
                      {"children", json::array({cue("bed", 0.5)})}};
    const json group{{"uuid", "music"}, {"type", "group"}, {"groupGainDb", -6.0},
                     {"children", json::array({nested})}};
    check(state.load_from_json(document(json::array({group, cue("walk-on")}))) &&
          wait_ready(state), "group level: show opens");
    close_devices(engine);
    const auto level = [&](const char* uuid) {
        const auto item = engine.find_cue(*state.item_to_cue_id(uuid));
        std::array<float, 256> left{}, right{};
        float* outputs[]{left.data(), right.data()};
        item->service_read_ahead(1);
        item->render_block(outputs, 2, left.size());
        return left[127];
    };
    check(state.trigger_item("bed") && state.trigger_item("walk-on"), "group level: both cues start");
    check(std::abs(level("bed") - 0.125 * std::pow(10.0, -12.0 / 20.0)) < 0.001 &&
          std::abs(level("walk-on") - 0.25) < 0.001,
          "group level: nested attenuation combines with cue gain and leaves unrelated playback alone");
    const auto pass = state.item_trigger_seq("bed");
    check(state.update_item("music", {{"groupGainDb", -12.0}}) &&
          !state.update_item("music", {{"groupGainDb", 3.0}}), "group level: valid attenuation only");
    (void)level("bed");
    check(std::abs(level("bed") - 0.125 * std::pow(10.0, -18.0 / 20.0)) < 0.001 &&
          state.item_trigger_seq("bed") == pass && std::abs(level("walk-on") - 0.25) < 0.001,
          "group level: a live fader edit ramps the same pass without touching another cue");
    check(!state.add_item(cue("new-bed"), "nested").empty() && wait_ready(state) && state.trigger_item("new-bed") &&
          std::abs(level("new-bed") - 0.25 * std::pow(10.0, -18.0 / 20.0)) < 0.001,
          "group level: new group children inherit the current attenuation");
    state.stop_all_cues(0);
}

void test_music_backup(const std::filesystem::path& wav) {
    for (const auto mode : {"off", "intentional-stop", "root", "folder", "group-ending", "busy-target",
                           "stalled-read", "ready-target", "normal-next", "stop-all", "already-air",
                           "paused-air", "quick-play-air"}) {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        const std::string_view scenario{mode};
        const bool group_ending = scenario == "group-ending";
        const bool group_scope = scenario == "folder" || group_ending;
        const bool stale_read = scenario == "stalled-read";
        const bool busy_target = scenario == "busy-target" || stale_read;
        const bool ready_target = scenario == "ready-target";
        const bool normal_next = scenario == "normal-next";
        // Another cue that does not keep Program sounding: paused, or a QuickPlay.
        const bool silent_air = scenario == "paused-air" || scenario == "quick-play-air";
        const bool layered = scenario == "already-air" || silent_air;
        const auto source = audio("music-out", wav, {{"outPoint", 0.06},
            {"crossFade", stale_read ? 0.025 : 0.0},
            {"duckingBehavior", {{"mode", layered ? "no-ducking" : "stop-all"}}},
            {"endBehavior", {{"action", scenario == "intentional-stop" || group_ending ? "nothing" : "next"}}}});
        const json backup{{"uuid", "backup-group"}, {"type", "group"},
            {"displayName", "Backup Music"}, {"startBehavior", {{"action", "play-first"}}},
            {"children", json::array({audio("music-backup", wav, {{"endBehavior", {{"action", "next"}}}})})}};
        json items = json::array({backup});
        if (busy_target || ready_target || scenario == "already-air" || scenario == "paused-air")
            items.push_back(audio("operator-next", wav));
        items.push_back(group_scope ? json{{"uuid", "walk-in"}, {"type", "group"},
            {"keepMusicGoing", true}, {"backupMusicGroup", "backup-group"},
            {"endBehavior", {{"action", group_ending ? "next" : "nothing"}}},
            {"children", json::array({source})}} : source);
        if (normal_next) items.push_back(audio("operator-next", wav, {{"inPoint", 0.08}}));
        auto show = document(items);
        show["settings"]["keepMusicGoing"] = scenario != "off" && !group_scope;
        show["settings"]["backupMusicGroup"] = "backup-group";
        if (scenario == "quick-play-air")
            show["quickPlayItems"] = json::array({audio("pad", wav, {{"quickPlay", {{"order", 0}}}})});
        state.replace_full_document(show);
        check(wait_ready(state), "music backup: media ready"); close_devices(engine);
        std::mutex notice_mutex;
        std::condition_variable notice_ready;
        std::atomic<bool> notice{false};
        std::atomic<bool> unavailable{false};
        state.set_ui_state_broadcaster([&](const json& event) {
            if (event.value("code", "") == std::string{"music_backup"}) {
                std::lock_guard lock{notice_mutex};
                notice.store(true);
                notice_ready.notify_one();
            }
            if (event.value("code", "") == std::string{"sequence_ended"}) unavailable.store(true);
        });
        const auto wait_for_backup = [&] {
            std::unique_lock lock{notice_mutex};
            return notice_ready.wait_for(lock, 2s, [&] { return notice.load(); }) &&
                on_air(state, engine, "music-backup");
        };
        if (scenario == "already-air") check(state.trigger_item("operator-next"), "music backup: other bed is playing");
        if (scenario == "paused-air")
            check(state.trigger_item("operator-next") && state.set_item_paused("operator-next", true),
                  "music backup: other bed is paused");
        if (scenario == "quick-play-air") check(state.trigger_item("pad"), "music backup: a QuickPlay is playing");
        const auto target_id = state.item_to_cue_id("operator-next");
        const auto target = target_id ? engine.find_cue(*target_id) : nullptr;
        std::unique_lock<std::mutex> held;
        if (busy_target) held = std::unique_lock{stale_read ? target->decoder_mutex_ : target->preparation_mutex()};
        check(state.trigger_item(group_scope ? "walk-in" : "music-out"), "music backup: outgoing cue starts");
        if (busy_target || ready_target)
            check(state.set_next_item_override("operator-next"), "music backup: last-minute Up Next is armed");
        if (ready_target || normal_next) {
            const auto in_point = normal_next ? 0.08 : 0.0;
            for (int i = 0; i < 400 && !target->has_buffered_start(in_point); ++i)
                std::this_thread::sleep_for(5ms);
            check(target->has_buffered_start(in_point), "music backup: chosen target primes silently at its authored In");
        }
        if (stale_read) {
            // Enter the crossfade window with the target decoder held, while
            // the first cue still has some time left.
            const auto id = state.item_to_cue_id("music-out");
            const auto from = id ? engine.find_cue(*id) : nullptr;
            std::array<float, 256> left{}, right{};
            float* channels[]{left.data(), right.data()};
            for (int i = 0; i < 7; ++i) from->render_block(channels, 2, 256);
            std::this_thread::sleep_for(150ms);
            check(on_air(state, engine, "music-out") && !on_air(state, engine, "music-backup"),
                  "music backup: failed crossfade leaves outgoing audio on air until its end");
        }
        if (scenario == "stop-all") state.stop_all_cues(0);
        else render_to_end(state, engine, "music-out");
        const bool expect_backup = scenario == "root" || group_scope || busy_target || silent_air;
        const bool followed = !(ready_target || normal_next) || wait_for_on_air(state, engine, "operator-next");
        const bool backup_ok = expect_backup ? wait_for_backup()
            : !on_air(state, engine, "music-backup") && !notice.load();
        check(followed && backup_ok && !unavailable.load(), mode);
        if (busy_target) {
            held.unlock();
            check(state.next_item_override() == "operator-next", "music backup: pending choice stays Up Next");
            render_to_end(state, engine, "music-backup");
            check(!on_air(state, engine, "operator-next") && state.go() == "operator-next",
                  "music backup: recovered target starts only on explicit GO");
        }
        if (group_scope && on_air(state, engine, "music-backup")) {
            const auto bed = engine.find_cue(*state.item_to_cue_id("music-backup"));
            std::array<float, 256> left{}, right{};
            float* channels[]{left.data(), right.data()};
            check(bed->render_block(channels, 2, 256) > 0, "music backup: bed advances past its prepared start");
            state.stop_all_cues(0);
            check(!on_air(state, engine, "music-backup"), "music backup: Stop All stops the active bed");
            check(state.trigger_item("walk-in"), "music backup: walk-in can be played again");
            notice.store(false);
            for (int i = 0; i < 200 && !bed->has_buffered_start(0.0); ++i)
                std::this_thread::sleep_for(5ms);
            render_to_end(state, engine, "music-out");
            check(wait_for_backup(), "music backup: a second handoff starts the bed after Stop All");
        }
        state.stop_all_cues(0);
        state.set_ui_state_broadcaster({});
    }
}

void test_manual_go_parity(const std::filesystem::path& wav) {
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    const auto cue = [&](const char* id, const char* action) {
        return audio(id, wav, {{"endBehavior", {{"action", action}}},
                              {"duckingBehavior", {{"mode", "no-ducking"}}}});
    };
    const auto next = [&] {
        const auto summary = state.state_summary();
        return summary["next"].is_object()
            ? summary["next"].value("itemUuid", std::string{}) : std::string{};
    };
    auto doc = document(json::array({cue("go-a", "nothing"), cue("go-b", "nothing"),
                                    cue("go-c", "nothing")}));
    state.replace_full_document(doc);
    check(wait_ready(state), "manual GO: media ready"); close_devices(engine);
    check(state.set_next_item_override("go-a") && state.go() == "go-a", "manual GO: first armed cue starts");
    check(next() == "go-b", "manual GO: Nothing displays next sibling while source is active");
    check(state.go() == "go-b" && on_air(state, engine, "go-a") && on_air(state, engine, "go-b"),
          "manual GO: active Nothing advances only on explicit GO");
    state.stop_all_cues(0);

    check(state.patch_settings({{"autoCueNextWithoutEndBehavior", false}}),
          "manual GO: Nothing option can be disabled");
    check(state.trigger_item("go-a"), "manual GO: disabled source starts");
    check(next().empty() && state.go().empty(), "manual GO: disabled Nothing leaves no derived target");
    check(state.set_next_item_override("go-c") && next() == "go-c" && state.go() == "go-c" &&
          state.next_item_override().empty(), "manual GO: explicit override wins and consumes after acceptance");
    state.stop_all_cues(0);

    doc["items"][0]["outPoint"] = 0.02;
    state.replace_full_document(doc);
    check(wait_ready(state), "manual GO: EOF media ready"); close_devices(engine);
    check(state.trigger_item("go-a"), "manual GO: EOF source starts");
    render_to_end(state, engine, "go-a");
    check(!on_air(state, engine, "go-b"), "manual GO: Nothing never becomes automatic follow");
    state.stop_all_cues(0);

    doc["items"][0]["endBehavior"] = {{"action", "loop"}};
    state.replace_full_document(doc);
    check(wait_ready(state), "manual GO: loop media ready"); close_devices(engine);
    check(state.trigger_item("go-a") && next() == "go-a" && state.go() == "go-a",
          "manual GO: a loop advertises and accepts the same replay target");
    state.stop_all_cues(0);

    doc = document(json::array({cue("go-a", "next"), cue("go-b", "nothing"),
                               cue("go-c", "next"), cue("go-d", "nothing"),
                               audio("go-unavailable", wav, {{"deviceOverride", "missing-output"}})}));
    state.replace_full_document(doc);
    check(wait_ready(state), "manual GO: overlapping media ready"); close_devices(engine);
    check(state.trigger_item("go-c") && state.trigger_item("go-a"), "manual GO: reverse trigger order starts");
    check(next() == "go-b" && state.go() == "go-b", "manual GO: overlapping cues use advertised document order");
    check(state.set_next_item_override("go-unavailable") && next() == "go-unavailable" && state.go().empty() &&
          state.next_item_override() == "go-unavailable" && on_air(state, engine, "go-a"),
          "manual GO: refused output preserves override and current playback");
    state.stop_all_cues(0);
}

void test_replacement_cancels_ownership() {
    const auto wav = make_wav(8192);
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    std::atomic<int> stale_actions{0};
    state.set_external_action_handler([&](const json&) { stale_actions.fetch_add(1); });
    const auto duck = [](double level) { return json{{"mode", "duck-others"}, {"duckLevel", level},
        {"duckFadeIn", 0.0}, {"duckFadeOut", 0.0}}; };
    const auto peak = [&](const char* uuid) {
        const auto item = engine.find_cue(*state.item_to_cue_id(uuid));
        item->service_read_ahead(1);
        std::array<float, 256> left{}, right{};
        float* channels[]{left.data(), right.data()};
        check(item->render_block(channels, 2, 256) == 256, "ownership: rendered real decoded PCM");
        float level = 0.0f;
        for (const auto sample : left) level = std::max(level, std::fabs(sample));
        return level;
    };
    for (const auto [fade, paused] : {std::pair{0.0, false}, std::pair{0.05, false}, std::pair{0.05, true}}) {
        state.replace_full_document(document(json::array({
            audio("owner", wav, {{"duckingBehavior", duck(0.1)}, {"customActions", json::array({
                {{"timePoint", 0.005}, {"action", {{"type", "http-request"}, {"url", "http://unused.invalid"}}}},
            })}}),
            audio("replacement", wav, {{"duckingBehavior", {{"mode", "stop-all"}}}, {"fadeOutDuration", fade}}),
        })));
        check(wait_ready(state), "ownership: replacement media ready"); close_devices(engine);
        check(state.trigger_item("owner"), "ownership: duck owner starts");
        if (paused) check(state.set_item_paused("owner", true), "ownership: paused owner can be replaced");
        check(state.trigger_item("replacement"), "ownership: replacement starts");
        check(std::fabs(peak("replacement") - 0.25f) < 1e-6f,
              "ownership: stopped owner cannot attenuate replacement PCM");
        if (fade > 0 && !paused) {
            peak("owner");
            std::this_thread::sleep_for(100ms);
            check(stale_actions.load() == 0, "ownership: replacement cancels old actions during audible fade");
        }
        state.stop_all_cues(0);
    }

    state.replace_full_document(document(json::array({
        audio("owner-a", wav, {{"duckingBehavior", duck(0.1)}}),
        audio("owner-b", wav, {{"duckingBehavior", duck(0.3)}}),
        audio("bed", wav, {{"duckingBehavior", {{"mode", "no-ducking"}}}}),
    })));
    check(wait_ready(state), "ownership: overlapping media ready"); close_devices(engine);
    check(state.trigger_item("owner-a") && state.trigger_item("owner-b") && state.trigger_item("bed"),
          "ownership: overlapping owners and bed start");
    check(std::fabs(peak("bed") - 0.025f) < 1e-6f, "ownership: strongest duck ceiling applies");
    check(state.stop_item("owner-a") && std::fabs(peak("bed") - 0.075f) < 1e-6f,
          "ownership: stopping one owner preserves the other ceiling");
    check(state.stop_item("owner-b") && std::fabs(peak("bed") - 0.25f) < 1e-6f,
          "ownership: stopping the last owner restores authored PCM level");
    state.stop_all_cues(0);

    stale_actions.store(0);
    state.replace_full_document(document(json::array({
        audio("custom-stop", wav, {{"duckingBehavior", duck(0.1)}, {"customActions", json::array({
            {{"timePoint", 0.005}, {"action", {{"type", "stop-all"}}}},
            {{"timePoint", 0.005}, {"action", {{"type", "http-request"}, {"url", "http://unused.invalid"}}}},
        })}}), audio("bed", wav, {{"duckingBehavior", {{"mode", "no-ducking"}}}}),
    })));
    check(wait_ready(state), "ownership: custom-stop media ready"); close_devices(engine);
    check(state.trigger_item("custom-stop"), "ownership: custom stop source starts");
    peak("custom-stop");
    for (int i = 0; i < 100 && on_air(state, engine, "custom-stop"); ++i) std::this_thread::sleep_for(5ms);
    check(!on_air(state, engine, "custom-stop"), "ownership: custom Stop All stops source");
    std::this_thread::sleep_for(80ms);
    check(stale_actions.load() == 0, "ownership: custom Stop All cancels subsequent copied actions");
    check(state.trigger_item("bed") && std::fabs(peak("bed") - 0.25f) < 1e-6f,
          "ownership: custom Stop All releases duck ownership before replay");
    state.stop_all_cues(0);
}

void test_group_waits_for_fading_child(const std::filesystem::path& wav) {
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    json group{{"uuid", "fade-group"}, {"type", "group"},
        {"startBehavior", {{"action", "play-all"}}},
        {"endBehavior", {{"action", "goto-item"}, {"targetUuid", "fade-target"}}},
        {"children", json::array({
            audio("fade-a", wav, {{"outPoint", 0.4}, {"duckingBehavior", {{"mode", "no-ducking"}}}}),
            audio("fade-b", wav, {{"outPoint", 0.8}, {"stopFade", 0.6}, {"duckingBehavior", {{"mode", "no-ducking"}}}}),
        })}};
    state.replace_full_document(document(json::array({group, audio("fade-target", wav)})));
    check(wait_ready(state), "group fade: media ready"); close_devices(engine);
    check(state.trigger_item("fade-group"), "group fade: parallel group starts");
    const auto b = engine.find_cue(*state.item_to_cue_id("fade-b"));
    std::array<float, 256> left{}, right{};
    float* channels[]{left.data(), right.data()};
    for (int i = 0; i < 60; ++i) {
        b->service_read_ahead(1);
        b->render_block(channels, 2, 256);
    }
    for (int i = 0; i < 100 && b->stats().transport != liveplay::audio::TransportState::FadingOut; ++i)
        std::this_thread::sleep_for(5ms);
    check(b->stats().transport == liveplay::audio::TransportState::FadingOut,
          "group fade: longer child enters authored stop fade");
    render_to_end(state, engine, "fade-a");
    check(b->stats().transport == liveplay::audio::TransportState::FadingOut && !on_air(state, engine, "fade-target"),
          "group fade: short child EOF cannot end group during longer audible fade");
    for (int i = 0; i < 200 && b->stats().transport != liveplay::audio::TransportState::Stopped; ++i) {
        b->service_read_ahead(1);
        b->render_block(channels, 2, 256);
    }
    check(wait_for_on_air(state, engine, "fade-target"),
          "group fade: group advances after the last child actually stops");
    state.stop_all_cues(0);
}

void test_group_waits_for_retired_tail(const std::filesystem::path& wav) {
    for (const bool crossfade : {true, false}) {
      for (const bool fail_tail : {false, true}) {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        auto a = audio("tail-a", wav, {{"outPoint", 0.9},
            {"duckingBehavior", {{"mode", "no-ducking"}}}});
        if (crossfade) a.update({{"crossFade", 0.6}, {"endBehavior", {{"action", "next"}}}});
        auto b = audio("tail-b", wav, {{"outPoint", 0.1}, {"fadeOutDuration", crossfade ? 0.0 : 0.6},
            {"stopFade", crossfade ? 0.0 : 0.05},
            {"duckingBehavior", {{"mode", crossfade ? "no-ducking" : "stop-all"}}}});
        json group{{"uuid", "tail-group"}, {"type", "group"},
            {"startBehavior", {{"action", crossfade ? "play-first" : "play-all"}}},
            {"endBehavior", {{"action", "goto-item"}, {"targetUuid", "tail-target"}}},
            {"children", json::array({a, b})}};
        state.replace_full_document(document(json::array({group, audio("tail-target", wav)})));
        check(wait_ready(state), "group retired tail: media ready"); close_devices(engine);
        check(state.trigger_item("tail-group"), "group retired tail: group starts");
        const auto outgoing = engine.find_cue(*state.item_to_cue_id("tail-a"));
        std::array<float, 256> left{}, right{};
        float* channels[]{left.data(), right.data()};
        if (crossfade) {
            for (int i = 0; i < 60; ++i) {
                outgoing->service_read_ahead(1);
                outgoing->render_block(channels, 2, 256);
            }
            check(wait_for_on_air(state, engine, "tail-b"), "group retired tail: crossfade starts incoming child");
        }
        check(outgoing->stats().transport == liveplay::audio::TransportState::FadingOut,
              "group retired tail: outgoing child is still fading after retirement");
        const auto incoming = engine.find_cue(*state.item_to_cue_id("tail-b"));
        if (!crossfade) {
            for (int i = 0; i < 12; ++i) {
                incoming->service_read_ahead(1);
                incoming->render_block(channels, 2, 256);
            }
            for (int i = 0; i < 100 && incoming->stats().transport != liveplay::audio::TransportState::FadingOut; ++i)
                std::this_thread::sleep_for(5ms);
            check(incoming->stats().transport == liveplay::audio::TransportState::FadingOut,
                  "group retired tail: replacement child uses its shorter authored stop fade");
        }
        for (int i = 0; i < 200 && incoming->stats().transport != liveplay::audio::TransportState::Stopped; ++i) {
            incoming->service_read_ahead(1);
            incoming->render_block(channels, 2, 256);
        }
        check(incoming->stats().transport == liveplay::audio::TransportState::Stopped,
              "group retired tail: incoming child actually stops before outgoing tail");
        std::this_thread::sleep_for(120ms);
        check(!on_air(state, engine, "tail-target"), "group retired tail: short incoming child cannot end audible group");
        if (fail_tail) outgoing->stop_for_decode_error(MA_IO_ERROR);
        else {
            for (int i = 0; i < 200 && outgoing->stats().transport != liveplay::audio::TransportState::Stopped; ++i) {
                outgoing->service_read_ahead(1);
                outgoing->render_block(channels, 2, 256);
            }
        }
        if (fail_tail) {
            check(outgoing->had_decode_error(), "group retired tail: render-side read failure is published");
            std::this_thread::sleep_for(120ms);
            check(!on_air(state, engine, "tail-target"), "group retired tail: decoder failure never advances the group");
        } else {
            check(wait_for_on_air(state, engine, "tail-target"),
                  "group retired tail: external group ending runs after untracked fade completes");
        }
        state.stop_all_cues(0);
      }
    }
}

void test_starvation_holds_show(const std::filesystem::path& wav) {
    liveplay::audio::AudioEngine engine;
    std::atomic<int> errors{0};
    liveplay::core::ProjectState state(engine);
    json group{{"uuid", "starve-group"}, {"type", "group"},
        {"startBehavior", {{"action", "play-first"}}},
        {"endBehavior", {{"action", "goto-item"}, {"targetUuid", "starve-target"}}},
        {"children", json::array({audio("starve", wav, {
            {"endBehavior", {{"action", "next"}}}, {"duckingBehavior", {{"mode", "no-ducking"}}}})})}};
    state.replace_full_document(document(json::array({group, audio("starve-target", wav)})));
    check(wait_ready(state), "starvation hold: real project media ready"); close_devices(engine);
    state.set_ui_state_broadcaster([&](const json& event) {
        if (event.value("type", std::string{}) == "playback_error" &&
            event.value("item_uuid", std::string{}) == "starve" &&
            event.value("decoder_result", 0) == MA_TIMEOUT) ++errors;
    });
    check(state.trigger_item("starve-group"), "starvation hold: group starts normally");
    const auto cue = engine.find_cue(*state.item_to_cue_id("starve"));
    std::array<float, 256> left{}, right{}; float* channels[]{left.data(), right.data()};
    for (int i = 0; i < 80; ++i) cue->render_block(channels, 2, 256);
    for (int i = 0; i < 100 && errors.load() == 0; ++i) std::this_thread::sleep_for(5ms);
    check(errors.load() == 1 && cue->had_decode_error(),
          "starvation hold: actual render starvation reports one operator playback error");
    check(!on_air(state, engine, "starve-target"),
          "starvation hold: failed child cannot run follow or enclosing group ending");
    std::unique_lock held_read{cue->decoder_mutex_};
    auto retry = std::async(std::launch::async, [&] { return state.trigger_item("starve"); });
    const bool retry_ready = retry.wait_for(250ms) == std::future_status::ready;
    check(retry_ready, "starvation hold: retry refuses before the failed decoder read returns");
    auto backup = std::async(std::launch::async, [&] { return state.trigger_item("starve-target"); });
    const bool backup_ready = backup.wait_for(250ms) == std::future_status::ready;
    check(backup_ready, "starvation hold: a busy failed retry cannot block another Program GO");
    held_read.unlock();
    check(!retry.get() && backup.get(), "starvation hold: failed retry is refused and healthy backup starts");
    state.stop_all_cues(0);
    check(state.trigger_item("starve"), "starvation hold: explicit operator retry remains available");
    check(cue->render_block(channels, 2, 256) == 256 && left[0] == 0.0f,
          "starvation hold: explicit retry produces original project PCM");
    state.stop_all_cues(0);
    state.set_ui_state_broadcaster({});
}

void test_diagnostic_retirement(const std::filesystem::path& wav) {
    for (const int action : {0, 1, 2}) {
        const auto file = wav.string() + ".diagnostic-" + std::to_string(action) + ".wav";
        std::filesystem::copy_file(wav, file, std::filesystem::copy_options::overwrite_existing);
        auto engine = std::make_unique<liveplay::audio::AudioEngine>();
        auto state = std::make_unique<liveplay::core::ProjectState>(*engine);
        const auto diagnostic = state->add_av_sync_diagnostic_cue(file, "default", file);
        check(diagnostic.error.empty(), "diagnostic retirement: owned cue is prepared");
        const auto item = engine->find_cue(diagnostic.cue_id);
        if (!item) { std::filesystem::remove(file); continue; }
        std::unique_lock held{item->decoder_mutex_};
        auto remove = std::async(std::launch::async, [&] {
            if (action == 0) state->remove_cue(diagnostic.cue_id);
            else if (action == 1) state->reset();
            else state.reset();
        });
        const bool ready = remove.wait_for(250ms) == std::future_status::ready;
        check(ready, "diagnostic retirement: remove/reset/destruction acknowledges before native close");
        check(std::filesystem::exists(file), "diagnostic retirement: owned file retained until decoder closes");
        if (ready) engine.reset();
        held.unlock(); remove.get();
        for (int i = 0; i < 2000 && std::filesystem::exists(file); ++i) std::this_thread::sleep_for(1ms);
        check(!std::filesystem::exists(file), "diagnostic retirement: owned file removed after native return");
    }
}

void test_changed_mirror_keeps_controls(const std::filesystem::path& wav) {
  for (const bool source_guard : {false, true}) {
    auto engine = std::make_unique<liveplay::audio::AudioEngine>();
    auto state = std::make_unique<liveplay::core::ProjectState>(*engine);
    auto doc = document(json::array({audio("changing-bed", wav, {{"outPoint", 0.0}}), audio("changing-backup", wav)}));
    state->replace_full_document(doc);
    check(wait_ready(*state) && state->trigger_item("changing-bed"), "changed mirror: current show is ready and playing");
    auto bed = engine->find_cue(*state->item_to_cue_id("changing-bed"));
    std::unique_lock held{source_guard ? bed->preparation_mutex() : bed->decoder_mutex_};
    const auto marker = wav.string() + ".changed-mirror";
    std::filesystem::remove(marker + ".entered");
    std::filesystem::remove(marker + ".native.entered");
    set_loader_gate(marker, "DWCUE_TEST_MIRROR_PROPERTIES_MARKER");
    doc["items"][0]["outPoint"] = 0.5;
    auto mirror = std::async(std::launch::async, [&] { return state->replace_full_document(doc); });
    check(wait_gate_entered(marker), "changed mirror: genuine native property publication begins");
    if (!source_guard) check(wait_gate_entered(marker + ".native"), "changed mirror: owned worker enters the real native property call");
    auto snapshot = std::async(std::launch::async, [&] { return state->full_document(); });
    auto stop = std::async(std::launch::async, [&] { state->stop_all_cues(0); });
    const bool snapshot_ready = snapshot.wait_for(250ms) == std::future_status::ready;
    const bool stop_ready = stop.wait_for(250ms) == std::future_status::ready;
    check(snapshot_ready && stop_ready, "changed mirror: document access and Stop All precede native completion");
    if (source_guard && snapshot_ready) check(bed->out_point_frames_.load() == 0,
        "changed mirror: queued configuration cannot bypass source preparation ownership");
    std::future<bool> backup;
    if (snapshot_ready && stop_ready) {
        check(!state->trigger_item("changing-bed"), "changed mirror: busy cue refuses GO without blocking controls");
        check(!state->update_item("changing-bed", json{{"outPoint", 0.75}}), "changed mirror: busy native edit leaves saved range unchanged");
        check(state->update_item("changing-bed", json{{"volume", 0.4}}), "changed mirror: pure level edit remains available");
        backup = std::async(std::launch::async, [&] { return state->trigger_item("changing-backup"); });
        check(backup.wait_for(250ms) == std::future_status::ready, "changed mirror: healthy backup GO precedes native completion");
    }
    const bool mirror_ready = mirror.wait_for(250ms) == std::future_status::ready;
    const bool controls_ready = mirror_ready && snapshot_ready && stop_ready && (!backup.valid() || backup.wait_for(0ms) == std::future_status::ready);
    if (controls_ready) { mirror.get(); snapshot.get(); stop.get(); if (backup.valid()) check(backup.get(), "changed mirror: backup GO is accepted"); }
    auto close = std::async(std::launch::async, [&] { if (controls_ready) state.reset(); else state->reset(); });
    const bool closed = close.wait_for(250ms) == std::future_status::ready;
    check(closed, "changed mirror: cancellation/destruction does not join a native property wait");
    if (closed && controls_ready) engine.reset();
    held.unlock(); if (mirror.valid()) mirror.get(); close.get();
    check(bed->stats().transport == liveplay::audio::TransportState::Stopped, "changed mirror: late native completion cannot restart a stopped cue");
    if (!controls_ready) { snapshot.get(); stop.get(); if (backup.valid()) backup.get(); }
    clear_loader_gate("DWCUE_TEST_MIRROR_PROPERTIES_MARKER");
    std::filesystem::remove(marker + ".entered");
    std::filesystem::remove(marker + ".native.entered");
    state.reset(); engine.reset();
  }
}

void test_unchanged_mirror_keeps_controls(const std::filesystem::path& wav) {
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    auto doc = document(json::array({audio("mirror-busy", wav, {{"outPoint", 0.0}, {"ltcEnabled", true}, {"ltcFrameRate", 1}})}));
    state.replace_full_document(doc);
    check(wait_ready(state) && state.trigger_item("mirror-busy"), "unchanged mirror: prepared cue starts");
    const auto item = engine.find_cue(*state.item_to_cue_id("mirror-busy"));
    std::unique_lock held{item->decoder_mutex_};
    doc["name"] = "Republished Show";
    const auto marker = wav.string() + ".mirror-properties";
    std::filesystem::remove(marker + ".entered");
    set_loader_gate(marker, "DWCUE_TEST_MIRROR_PROPERTIES_MARKER");
    auto mirror = std::async(std::launch::async, [&] { return state.replace_full_document(doc); });
    check(wait_gate_entered(marker), "unchanged mirror: native property publication begins under the real project lock");
    check(mirror.wait_for(250ms) == std::future_status::ready,
          "unchanged mirror: document replacement returns before the busy decoder");
    auto snapshot = std::async(std::launch::async, [&] { return state.full_document(); });
    auto stop = std::async(std::launch::async, [&] { state.stop_all_cues(0); });
    check(snapshot.wait_for(250ms) == std::future_status::ready && stop.wait_for(250ms) == std::future_status::ready,
          "unchanged mirror: document access and Stop All survive repeated native properties");
    held.unlock(); mirror.get(); snapshot.get(); stop.get();
    clear_loader_gate("DWCUE_TEST_MIRROR_PROPERTIES_MARKER");
    std::filesystem::remove(marker + ".entered");
    check(wait_ready(state) && item->stats().transport == liveplay::audio::TransportState::Stopped,
          "unchanged mirror: stopped cue stays stopped after native return");
}

void test_completed_loader_worker_retires() {
    const auto held = make_wav(8'230), healthy = make_wav(8'231);
    const auto gate = held.string() + ".worker-lifetime-gate";
    std::ofstream{gate} << held; set_loader_gate(gate, "DWCUE_TEST_METADATA_GATE");
    const auto completed = liveplay::core::completed_load_workers_for_test();
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    state.replace_full_document(document(json::array({audio("load-held", held), audio("load-healthy", healthy)})));
    check(wait_gate_entered(gate), "loader worker budget: one native metadata extraction is held");
    const auto deadline = std::chrono::steady_clock::now() + 250ms;
    while (liveplay::core::completed_load_workers_for_test() == completed && std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(1ms);
    check(liveplay::core::completed_load_workers_for_test() > completed,
          "loader worker budget: completed sibling frees its thread before blocked batch returns");
    std::filesystem::remove(gate); clear_loader_gate("DWCUE_TEST_METADATA_GATE");
    check(wait_ready(state), "loader worker budget: complete batch still publishes after native return");
    std::filesystem::remove(gate + ".entered");
}

void test_owned_loader_destruction() {
  for (const bool queued : {false, true}) for (const int stage : {0, 1, 2}) {
    const auto wav = make_wav(static_cast<std::int16_t>(8'220 + (queued ? 3 : 0) + stage));
    auto engine = std::make_unique<liveplay::audio::AudioEngine>();
    auto state = std::make_unique<liveplay::core::ProjectState>(*engine);
    if (queued) {
        state->replace_full_document(document(json::array()));
        check(wait_ready(*state), "loader lifetime: empty project ready");
    }
    const auto gate = wav.string() + ".load-lifetime-" + std::to_string(queued) + "-" + std::to_string(stage);
    const char* hook = stage == 2 ? "DWCUE_TEST_DECODER_READ_GATE" :
        stage == 1 ? "DWCUE_TEST_METADATA_GATE" : "DWCUE_TEST_LOADER_GATE";
    std::ofstream{gate} << wav; set_loader_gate(gate, hook);
    auto item = audio("owned-load", wav);
    if (stage == 2) item["quickPlay"] = json::object();
    if (queued) state->add_item(item);
    else state->replace_full_document(document(json::array({item})));
    check(wait_gate_entered(gate), "loader lifetime: actual queued/bulk decoder/metadata call is held");
    auto close = std::async(std::launch::async, [&] { state.reset(); });
    const bool responsive = close.wait_for(250ms) == std::future_status::ready;
    check(responsive, "loader lifetime: project destruction does not wait for native file work");
    if (responsive) engine.reset(); // A late file task must not retain either object.
    std::filesystem::remove(gate); close.get(); clear_loader_gate(hook);
    if (engine) engine.reset();
    std::filesystem::remove(gate + ".entered");
  }
}

void test_loading_metadata_preserves_controls(const std::filesystem::path& wav) {
    const auto pending_wav = make_wav(8'199);
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    auto doc = document(json::array({audio("metadata-bed", wav)}));
    state.replace_full_document(doc);
    check(wait_ready(state), "metadata wait: existing show ready"); close_devices(engine);
    check(state.trigger_item("metadata-bed"), "metadata wait: existing cue starts");
    const auto bed = engine.find_cue(*state.item_to_cue_id("metadata-bed"));
    const auto gate = pending_wav.string() + ".metadata-gate";
    std::ofstream{gate} << pending_wav;
    set_loader_gate(gate, "DWCUE_TEST_METADATA_GATE");
    doc["items"].push_back(audio("metadata-new", pending_wav));
    state.replace_full_document(doc);
    check(wait_gate_entered(gate), "metadata wait: actual whole-project metadata extraction is held");
    auto snapshot = std::async(std::launch::async, [&] { return state.full_document(); });
    check(snapshot.wait_for(250ms) == std::future_status::ready,
          "metadata wait: document access completes before metadata I/O returns");
    auto stop = std::async(std::launch::async, [&] { state.stop_all_cues(0); });
    check(stop.wait_for(250ms) == std::future_status::ready &&
              bed->stats().transport == liveplay::audio::TransportState::Stopped,
          "metadata wait: Stop All completes before metadata I/O returns");
    std::filesystem::remove(gate); snapshot.get(); stop.get();
    clear_loader_gate("DWCUE_TEST_METADATA_GATE");
    check(wait_ready(state), "metadata wait: current media publishes after the read returns");
    const auto cue = engine.find_cue(*state.item_to_cue_id("metadata-new"));
    check(cue && cue->duration_frames() == 48'000 &&
              cue->stats().transport == liveplay::audio::TransportState::Stopped,
          "metadata wait: loaded PCM duration is retained without a late start");
    std::filesystem::remove(gate + ".entered");
}

} // namespace

int test_crash_resume_lifecycle();

void test_position_aware_recovery(const std::filesystem::path& wav) {
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    std::atomic<int> past{0}, future{0};
    state.set_external_action_handler([&](const json& action) {
        if (action.value("marker", "") == "past") ++past;
        else ++future;
    });
    auto cue = audio("resume", wav, {
        {"inPoint", 0.1}, {"duckingBehavior", {{"mode", "no-ducking"}}},
        {"startBehavior", {{"action", "play-item"}, {"targetUuid", "secondary"}}},
        {"customActions", json::array({
            {{"timePoint", 0.2}, {"action", {{"type", "http-request"}, {"marker", "past"}}}},
            {{"timePoint", 0.6}, {"action", {{"type", "http-request"}, {"marker", "past"}}}},
            {{"timePoint", 0.8}, {"action", {{"type", "http-request"}, {"marker", "future"}}}},
        })}});
    state.replace_full_document(document(json::array({cue, audio("secondary", wav)})));
    check(wait_ready(state), "recovery position: fixtures ready");
    const auto revision = state.playback_intent_revision();
    check(state.resume_item("resume", 0.6, revision), "recovery position: matching intent resumes");
    const auto item = engine.find_cue(*state.item_to_cue_id("resume"));
    check(item && std::abs(item->stats().playhead_seconds - 0.6) < 1.0 / 48000.0,
          "recovery position: sub-second seek is applied before playback");
    check(!on_air(state, engine, "secondary"), "recovery position: fresh-start action is not repeated");
    std::array<float, 256> left{}, right{};
    float* channels[]{left.data(), right.data()};
    const auto render_through = [&](std::uint64_t frame) {
        const auto deadline = std::chrono::steady_clock::now() + 2s;
        while (item->stats().playhead_frame < frame && std::chrono::steady_clock::now() < deadline) {
            item->service_read_ahead(1);
            if (item->render_block(channels, 2, 256) == 0) std::this_thread::sleep_for(1ms);
        }
        return item->stats().playhead_frame >= frame;
    };
    check(render_through(40'320), "recovery position: actual PCM crosses the future action marker");
    for (int i = 0; i < 400 && future == 0; ++i) std::this_thread::sleep_for(5ms);
    check(past == 0 && future == 1, "recovery position: crossed actions consumed; future action fires once");
    check(!state.resume_item("resume", 0.6, revision), "recovery position: consumed recovery cannot replay");
    state.stop_all_cues(0);
    check(state.play_item("resume") && on_air(state, engine, "secondary"),
          "recovery position: ordinary replay retains fresh-start action");
    check(render_through(30'400), "recovery position: replay PCM crosses both earlier markers");
    for (int i = 0; i < 400 && past < 2; ++i) std::this_thread::sleep_for(5ms);
    check(past == 2 && future == 1, "recovery position: ordinary replay retains crossed custom actions");
    state.stop_all_cues(0);
}

void test_healthy_loader_siblings() {
    const auto held_file = make_wav(16'384), healthy_file = make_wav(8'192);
    for (int mode = 0; mode < 3; ++mode) {
        const bool queued = mode == 0, fallback = mode == 2;
        const auto gate = fixture_dir() / ("loader-sibling-" + std::to_string(mode) + ".gate");
        const auto missing = fixture_dir() / "unavailable-relative-source.wav";
        const auto hook = fallback ? "DWCUE_TEST_PATH_PROBE_GATE" : "DWCUE_TEST_LOADER_GATE";
        std::ofstream{gate} << (fallback ? missing : held_file);
        set_loader_gate(gate, hook);

        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        auto first = audio("sibling-held", held_file);
        if (fallback) first["mediaPath"] = missing.filename().string();
        auto duplicate = first;
        duplicate["uuid"] = "sibling-held-again";
        auto show = document(json::array({first, duplicate}));
        show["folderPath"] = fixture_dir().string();
        for (int i = 0; i < 20; ++i)
            show["items"].push_back(audio("sibling-" + std::to_string(i), healthy_file));
        if (queued) state.add_item(first);
        else check(state.load_from_json(show), "Sibling loader: whole show accepted");
        check(wait_gate_entered(gate), "Sibling loader: source reached held decoder or fallback lookup");
        if (queued) for (std::size_t i = 1; i < show["items"].size(); ++i) state.add_item(show["items"][i]);

        const auto deadline = std::chrono::steady_clock::now() + 750ms;
        json progress;
        do {
            progress = state.audio_readiness();
            if (progress["fileRevisions"].size() == 20 && (!queued || progress.value("pendingCount", 0) == 2)) break;
            std::this_thread::sleep_for(5ms);
        } while (std::chrono::steady_clock::now() < deadline);
        check(progress["fileRevisions"].size() == 20 && progress.value("loading", false) &&
                  !progress.value("ready", true) && !progress["fileRevisions"].contains("sibling-held"),
              "Sibling loader: all healthy cues publish while the show and stalled file remain pending");
        check(!state.trigger_item("sibling-held"), "Sibling loader: pending cue refuses playback");
        check(state.set_next_item_override("sibling-19") && state.go() == "sibling-19",
              "Sibling loader: explicit GO starts healthy audio before the stall releases");
        const auto id = state.item_to_cue_id("sibling-19");
        const auto cue = id ? engine.find_cue(*id) : nullptr;
        std::array<float, 256> samples{};
        float* channels[]{samples.data()};
        if (cue) { cue->service_read_ahead(1); cue->render_block(channels, 1, 256); }
        check(std::abs(samples[0] - 0.25f) < 1e-6f, "Sibling loader: healthy GO renders the original PCM");
        state.stop_all_cues(0);

        if (fallback) {
            state.reset();
            state.add_item(audio("sibling-held", healthy_file));
            check(wait_ready(state), "Sibling loader: replacement with the same UUID is ready before release");
        } else if (!queued) {
            const json relink{{"mediaServerPath", healthy_file.string()}};
            check(state.update_item("sibling-held", relink) && state.update_item("sibling-held-again", relink) && wait_ready(state),
                  "Sibling loader: relink clears obsolete batch work before the old decoder returns");
        }
        const auto completed = liveplay::core::completed_load_workers_for_test();
        std::filesystem::remove(gate);
        clear_loader_gate(hook);
        for (int i = 0; i < 400 && liveplay::core::completed_load_workers_for_test() == completed; ++i)
            std::this_thread::sleep_for(5ms);
        check(liveplay::core::completed_load_workers_for_test() > completed,
              "Sibling loader: the released native worker exits");
        check(wait_ready(state) && !on_air(state, engine, "sibling-held") && !on_air(state, engine, "sibling-19"),
              "Sibling loader: release settles readiness without replay or automatic advancement");
        const auto resolved = state.item_to_cue_id("sibling-held");
        const auto current = resolved ? engine.find_cue(*resolved) : nullptr;
        check(current && current->desc().file_path == (queued ? held_file : healthy_file),
              "Sibling loader: late work cannot replace the current cue");
        std::filesystem::remove(gate.string() + ".entered");
    }
}

void test_held_path_resolution(const std::filesystem::path& wav) {
    constexpr auto hook = "DWCUE_TEST_PATH_PROBE_GATE";
    const auto sibling = make_wav(8194);
    for (const bool queued : {false, true}) {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        const auto gate = fixture_dir() / (queued ? "queued-path.gate" : "bulk-path.gate");
        auto source = document(json::array());
        source["folderPath"] = fixture_dir().string();
        const auto media = audio("held-path", wav, {{"mediaPath", "path-that-does-not-exist.wav"}});
        if (queued) check(state.load_from_json(source) && wait_ready(state), "Held path: empty show ready");
        else source["items"].push_back(media);
        std::ofstream{gate} << (fixture_dir() / "path-that-does-not-exist.wav");
        set_loader_gate(gate, hook);
        auto open = std::async(std::launch::async, [&] {
            return queued ? !state.add_item(media).empty() : state.load_from_json(source);
        });
        check(wait_gate_entered(gate), "Held path: relative fallback lookup reached the gate");
        auto controls = std::async(std::launch::async, [&] {
            state.stop_all_cues(0);
            if (!state.full_document().is_object()) return false;
            if (queued) return true;
            const auto id = state.add_item(audio("healthy-path", sibling));
            for (int i = 0; i < 60 && !engine.find_cue(id); ++i) std::this_thread::sleep_for(5ms);
            return static_cast<bool>(engine.find_cue(id));
        });
        const bool responsive = controls.wait_for(400ms) == std::future_status::ready && controls.get();
        check(responsive,
              "Held path: Stop All, document access, and independent queued media stay available");
        auto replace = std::async(std::launch::async, [&] {
            return state.load_from_json(document(json::array({audio("held-path", sibling)}))) && wait_ready(state);
        });
        check(replace.wait_for(400ms) == std::future_status::ready,
              "Held path: a replacement show can use the same UUID before lookup returns");
        std::filesystem::remove(gate);
        if (controls.valid()) (void)controls.get();
        check(open.get() && replace.get(), "Held path: requests complete after release");
        clear_loader_gate(hook);
        std::filesystem::remove(gate.string() + ".entered");
        const auto id = state.item_to_cue_id("held-path");
        const auto cue = id ? engine.find_cue(*id) : nullptr;
        check(cue && cue->desc().file_path == sibling, "Held path: the old fallback never replaces the current file");
    }

    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    auto source = document(json::array({audio("relative-first", wav, {{"mediaPath", sibling.filename().string()}})}));
    source["folderPath"] = fixture_dir().string();
    check(state.load_from_json(source) && wait_ready(state), "Media paths: whole-show relative source is ready");
    const auto relative = state.item_to_cue_id("relative-first");
    const auto relative_cue = relative ? engine.find_cue(*relative) : nullptr;
    check(relative_cue && relative_cue->desc().file_path == sibling && state.resolve_item_path("relative-first") == sibling,
          "Media paths: the relative file wins when both files exist");
    const auto fallback = state.add_item(audio("absolute-fallback", wav, {{"mediaPath", "path-that-does-not-exist.wav"}}));
    check(wait_ready(state), "Media paths: queued absolute fallback is ready");
    const auto fallback_cue = engine.find_cue(fallback);
    check(fallback_cue && fallback_cue->desc().file_path == wav && state.resolve_item_path("absolute-fallback") == wav,
          "Media paths: the absolute file is used when the relative file is missing");
    check(state.trigger_item("absolute-fallback"), "Media paths: fallback cue plays");
    check(state.replace_full_document(state.full_document(), false) && wait_ready(state) &&
              state.item_to_cue_id("absolute-fallback") == fallback && on_air(state, engine, "absolute-fallback"),
          "Media paths: verifying the same fallback keeps its running decoder");
    state.stop_all_cues(0);
}

void test_held_media_revision(const std::filesystem::path& wav) {
    const auto gate = fixture_dir() / "media-revision.gate";
    constexpr auto hook = "DWCUE_TEST_REVISION_GATE";
    auto engine = std::make_unique<liveplay::audio::AudioEngine>();
    auto state = std::make_unique<liveplay::core::ProjectState>(*engine);
    state->replace_full_document(document(json::array({audio("revision-held", wav)})));
    check(wait_ready(*state) && state->trigger_item("revision-held"), "Held revision: original cue ready and on air");
    std::ofstream{gate} << wav;
    set_loader_gate(gate, hook);
    check(wait_gate_entered(gate), "Held revision: filesystem revision probe reached the gate");
    const auto sibling = make_wav(8193);
    auto controls = std::async(std::launch::async, [&] {
        state->stop_all_cues(0);
        return !on_air(*state, *engine, "revision-held") && state->full_document().is_object() &&
            !state->add_item(audio("revision-sibling", sibling)).empty() && wait_ready(*state) &&
            state->trigger_item("revision-sibling");
    });
    const bool responsive = controls.wait_for(350ms) == std::future_status::ready;
    check(responsive && controls.get(), "Held revision: Stop All, document access, and healthy import and playback finish");
    if (!responsive) {
        std::filesystem::remove(gate);
        (void)controls.get();
    }
    auto close = std::async(std::launch::async, [&] { state.reset(); engine.reset(); });
    check(close.wait_for(350ms) == std::future_status::ready && responsive,
          "Held revision: project and engine can be destroyed before the probe returns");
    std::filesystem::remove(gate);
    close.get();
    clear_loader_gate(hook);
    std::filesystem::remove(gate.string() + ".entered");
}

void test_changed_media_readiness() {
    const auto folder = fixture_dir() / "revision";
    std::filesystem::create_directories(folder);
    const auto path = folder / "cue.wav", replacement = folder / "replacement.wav";
    const auto first = make_wav(8192), second = make_wav(16384);
    std::filesystem::copy_file(first, path);
    std::filesystem::copy_file(second, replacement);
    std::filesystem::last_write_time(replacement, std::filesystem::last_write_time(path));
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    state.replace_full_document(document(json::array({audio("revision", path, {
        {"endBehavior", {{"action", "loop"}}}, {"duckingBehavior", {{"mode", "no-ducking"}}}})})));
    check(wait_ready(state), "file revision: original decoded");
    check(state.trigger_item("revision"), "file revision: original starts");
    const auto old_id = *state.item_to_cue_id("revision");
    const auto old = engine.find_cue(old_id);
    std::error_code error;
    const bool replaced = liveplay::util::replace_file_atomically(replacement, path, error);
    bool held_by_decoder = false;
#ifdef _WIN32
    held_by_decoder = !replaced && (error.value() == ERROR_SHARING_VIOLATION || error.value() == ERROR_ACCESS_DENIED);
#endif
    check(replaced || held_by_decoder, "file revision: same-size/date replacement publishes or Windows holds the active file");
    if (!replaced && !held_by_decoder) return;
    if (held_by_decoder) {
        check(state.audio_readiness().value("ready", false) && on_air(state, engine, "revision"),
              "file revision: refused Windows replacement leaves the original cue ready and on air");
    } else {
        for (int i = 0; i < 200 && state.audio_readiness().value("ready", true); ++i)
            std::this_thread::sleep_for(10ms);
        check(!state.audio_readiness().value("ready", true) && on_air(state, engine, "revision"),
              "file revision: changed source invalidates readiness without cutting active playback");
        check(!state.trigger_item("revision") && on_air(state, engine, "revision"),
              "file revision: stale decoder cannot be accepted as a new play");
    }
    std::array<float, 256> left{}, right{};
    float* channels[]{left.data(), right.data()};
    old->service_read_ahead(1); old->render_block(channels, 2, 256);
    check(std::abs(left[0] - 0.25f) < 1e-6f, "file revision: active pinned file retains its original PCM");
    state.stop_item("revision");
    if (held_by_decoder) {
        old->unload();
        check(liveplay::util::replace_file_atomically(replacement, path, error),
              "file revision: Windows replacement publishes after decoder close");
    }
    bool reloaded = false;
    for (int i = 0; i < 400; ++i) {
        const auto id = state.item_to_cue_id("revision");
        if (id && *id != old_id && state.audio_readiness().value("ready", false)) { reloaded = true; break; }
        std::this_thread::sleep_for(10ms);
    }
    check(reloaded && state.trigger_item("revision"), "file revision: stopped cue reloads the new revision before reuse");
    if (reloaded) {
        const auto current = engine.find_cue(*state.item_to_cue_id("revision"));
        current->service_read_ahead(1); current->render_block(channels, 2, 256);
        check(std::abs(left[0] - 0.5f) < 1e-6f, "file revision: the accepted new play renders replacement PCM");
    }
    state.stop_all_cues(0);
}

int main() try {
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    if (!std::filesystem::create_directory(fixture_dir()))
        throw std::runtime_error("Runtime test fixture directory already exists");
    test_completed_loader_worker_retires();
    failures += test_crash_resume_lifecycle();
    const auto wav = make_wav();
    test_diagnostic_retirement(wav);
    test_changed_mirror_keeps_controls(wav);
    test_unchanged_mirror_keeps_controls(wav);
    test_position_aware_recovery(wav);
    test_changed_media_readiness();
    test_held_media_revision(wav);
    test_held_path_resolution(wav);
    test_healthy_loader_siblings();
    test_stop_all_during_project_boundaries(wav);
    test_stop_all_during_decoder_read(wav);
    test_starvation_holds_show(wav);
    test_owned_loader_destruction();
    test_loading_metadata_preserves_controls(wav);
    test_stop_all_during_cue_retirement(wav);
    test_stop_all_during_program_device_start();
    test_stop_all_during_system_default_open();
    test_cold_outputs_keep_transport_available();
    test_stop_all_during_ltc_device_start();
    test_stop_all_during_ltc_edit();
    test_loader_output_wait();
    test_program_reroute_preserves_ltc();
    test_program_plays_through_main();
    test_program_switches_outputs();
    test_chosen_output_has_its_own_stream();
    test_autosave_keeps_unchanged_show();
    test_stop_all_during_diagnostic_output_start();
    test_stop_all_during_output_settings_open();
    test_stop_all_during_preview_retirement();
    test_cancelled_preview_preparation();
    test_busy_decoder_preserves_sibling_progress();
    test_stop_all_during_live_edits();
    test_stop_all_during_cold_go(wav);
    test_cancelled_follow_keeps_backup(wav);
    test_rejected_document_preserves_show(wav);
    test_rejected_nested_document_preserves_show(wav);
    test_open_expires_while_waiting_to_switch(wav);
    test_load_resets_project_runtime(wav);
    test_rejected_server_document_preserves_show(wav);
    test_nested_group_end(wav);
    test_group_cancellation(wav);
    test_group_internal_continuations(wav);
    test_external_group_exit(wav);
    test_deleting_up_next_clears_it(wav);
    test_up_next_follows_last_fired(wav);
    test_refire_keeps_automation(wav);
    test_manual_stop_arms_up_next(wav);
    test_crossfade_tail_actions(wav);
    test_group_end_goes_after_the_group(wav);
    test_nested_play_first_readiness(wav);
    test_start_actions(wav);
    test_paused_sequencer(wav);
    test_pause_after_action_copy(wav);
    test_index_transitions(wav);
    test_zero_crossfade_boundary(wav);
    test_terminal_custom_actions(wav);
    test_untrimmed_follow_keeps_final_frame();
    test_live_out_point_refreshes_prepared_endpoint();
    test_prepared_follow_runtime(wav);
    test_prepared_follow_cancellation(wav);
    test_selected_output_channels();
    test_unknown_output_rejection(wav);
    test_priming_admission(wav);
    test_output_identity_catalog();
    test_failed_follow_requires_go(wav);
    test_failed_group_follow_requires_go(wav);
    test_shuffle_items(wav);
    test_quick_play_continuation(wav);
    test_quick_play_authored_follow(wav);
    test_quick_play_restart(wav);
    test_legacy_quick_play_names(wav);
    test_group_levels();
    test_music_backup(wav);
    test_manual_go_parity(wav);
    test_replacement_cancels_ownership();
    test_group_waits_for_fading_child(wav);
    test_group_waits_for_retired_tail(wav);
    std::error_code error;
    // Detached decoder cleanup can outlive a fixture. Windows waits for the handle to close.
    for (int i = 0; i < 200; ++i) {
        std::filesystem::remove_all(fixture_dir(), error);
        if (!error) break;
        std::this_thread::sleep_for(5ms);
    }
    check(!error, "runtime test: temporary media removed after decoder retirement");
    std::printf("\n%s (%d failure%s)\n", failures ? "FAILURES" : "ALL PASS",
                failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "Runtime test exception: %s\n", error.what());
    return 1;
}
