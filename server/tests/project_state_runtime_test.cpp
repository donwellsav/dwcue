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
#define private public
#include "liveplay/audio/playback_item.hpp"
#include "liveplay/audio/engine.hpp"
#undef private
#include "liveplay/core/project_state.hpp"
#include "liveplay/util/atomic_file.hpp"
#define private public
#include "liveplay/core/backup_manager.hpp"
#undef private

#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <future>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

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
std::filesystem::path make_wav(std::int16_t sample = 0, std::uint32_t frames = 48'000) {
    const auto path = std::filesystem::temp_directory_path() /
                      ("dwcue-project-state-runtime-" + std::to_string(sample) + ".wav");
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
    for (int i = 0; i < limit && on_air(state, engine, uuid); ++i) {
        item->service_read_ahead(1);
        item->render_block(channels, 2, 256);
    }
    std::this_thread::sleep_for(120ms);
}
json document(json items) {
    return json{{"name", "runtime-contract"}, {"folderPath", ""},
                {"items", std::move(items)}, {"cartOnlyItems", json::array()},
                {"cartItems", json::array()}, {"settings", json::object()}};
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
    const auto run_case = [&](const char* label, auto operation) {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        const auto gate = std::filesystem::temp_directory_path() /
                          (std::string{"dwcue-loader-gate-"} + label);
        std::ofstream{gate};
        std::filesystem::remove(gate.string() + ".entered");
        set_loader_gate(gate);
        state.replace_full_document(document(json::array({audio("latched", wav)})));
        check(wait_gate_entered(gate), "project boundary: decoder reached deterministic gate");
        auto boundary = std::async(std::launch::async, [&] { operation(state); });
        auto stop = std::async(std::launch::async, [&] { state.stop_all_cues(0); });
        check(stop.wait_for(250ms) == std::future_status::ready, label);
        std::filesystem::remove(gate);
        boundary.get();
        stop.get();
        clear_loader_gate();
        std::filesystem::remove(gate.string() + ".entered");
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
    auto stop = std::async(std::launch::async, [&] { state.stop_all_cues(0); });
    check(stop.wait_for(250ms) == std::future_status::ready &&
              bed->stats().transport == liveplay::audio::TransportState::Stopped,
          "retirement stall: unrelated Stop All completes before storage release");
    read_stall.unlock(); unload.get(); stop.get();
    check(!engine.find_cue(retiring_id) && !retiring->decoder_ready_.load(),
          "retirement stall: removed cue finishes teardown without remaining registered");
}

void test_stop_all_during_preview_retirement() {
    const auto wav = make_wav(8'192);
    for (const int mode : {0, 1, 2}) {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        state.replace_full_document(document(json::array({audio("preview-bed", wav), audio("preview-item", wav)})));
        check(wait_ready(state), "preview stall: media ready"); close_devices(engine);
        check(state.patch_settings({{"previewDevice", "NULL Playback Device"}}) &&
                  state.start_preview("preview-item"), "preview stall: software-only Preview starts");
        check(state.trigger_item("preview-bed"), "preview stall: Program starts independently");
        const auto bed = engine.find_cue(*state.item_to_cue_id("preview-bed"));
        const auto preview = engine.find_cue(state.current_preview_cue_id());
        if (!preview) { check(false, "preview stall: Preview has a native cue"); continue; }
        std::array<float, 256> left{}, right{}; float* channels[]{left.data(), right.data()};
        bed->render_block(channels, 2, 256);
        check(left[0] > 0.2f, "preview stall: actual Program PCM is audible in the manual buffer");
        std::unique_lock read_stall{preview->decoder_mutex_};
        auto operation = std::async(std::launch::async, [&] {
            if (mode == 0) return state.stop_preview();
            if (mode == 1) return state.start_preview("preview-item");
            return state.patch_settings({{"previewDevice", "NULL Playback Device"}});
        });
        for (int i = 0; i < 300 && preview->stats().transport != liveplay::audio::TransportState::Stopped; ++i)
            std::this_thread::sleep_for(1ms);
        auto stop = std::async(std::launch::async, [&] { state.stop_all_cues(0); });
        const bool stopped = stop.wait_for(250ms) == std::future_status::ready;
        check(stopped && bed->stats().transport == liveplay::audio::TransportState::Stopped &&
                  bed->render_block(channels, 2, 256) == 0,
              "preview stall: Stop All acknowledges and silences Program before Preview storage release");
        read_stall.unlock(); const bool result = operation.get(); stop.get();
        check(mode == 1 ? !result : result, "preview stall: cancelled replacement refuses while stop/settings settle");
        check(state.current_preview_item_uuid().empty(), "preview stall: cancelled Preview cannot reappear after storage release");
        check(state.start_preview("preview-item"), "preview stall: deliberate Preview retry succeeds");
        state.stop_preview(); state.stop_all_cues(0);
    }
    std::filesystem::remove(wav);
}

void test_cancelled_preview_preparation() {
    const auto wav = make_wav(8'193);
    const auto preview_wav = make_wav(8'194);
    for (const bool prime : {false, true}) {
      for (const int mode : {0, 1, 2, 3}) {
        liveplay::audio::AudioEngine engine;
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
    std::filesystem::remove(wav);
    std::filesystem::remove(preview_wav);
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
    engine.running_.store(true);
    std::thread worker([&] { engine.decode_loop(); });
    for (int i = 0; i < 250 && sibling->stats().read_ahead_blocks == 0; ++i)
        std::this_thread::sleep_for(2ms);
    std::array<float, 256> left{}, right{}; float* channels[]{left.data(), right.data()};
    check(sibling->render_block(channels, 2, 256) == 256 && left[0] > 0.2f,
          "busy decoder: shared worker delivers sibling PCM before another decoder lock releases");
    engine.running_.store(false); engine.decode_cv_.notify_all();
    io_stall.unlock(); worker.join();
    state.stop_all_cues(0);
    std::filesystem::remove(wav);
}

void test_stop_all_during_live_edits() {
    const auto wav = make_wav(8'196);
    const auto replacement = make_wav(8'197);
    for (const int mode : {0, 1, 2, 3}) {
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        state.replace_full_document(document(json::array({
            audio("edit-source", wav, {{"outPoint", 0.9},
                {"endBehavior", {{"action", mode == 3 ? "loop" : "stop"}}}}),
            audio("edit-target", wav)})));
        check(wait_ready(state), "live document edit: real media ready"); close_devices(engine);
        check(state.trigger_item("edit-source"), "live document edit: Program starts");
        const auto source = engine.find_cue(*state.item_to_cue_id("edit-source"));
        std::array<float, 256> left{}, right{}; float* channels[]{left.data(), right.data()};
        source->render_block(channels, 2, 256);
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
        if (mode == 2) decoder_hold.lock(); else backend->vtable = &stalled;
        auto edit = std::async(std::launch::async, [&] {
            if (mode == 0) return state.update_item("edit-source", {{"outPoint", 0.75}});
            if (mode == 1) return state.update_item("edit-source", {{"endBehavior", {{"action", "loop"}}}});
            if (mode == 2) return state.update_item("edit-source", {{"mediaServerPath", replacement.string()}});
            return state.cue_to_continue("edit-source");
        });
        if (mode == 2) {
            for (int i = 0; i < 500 && source->stats().transport != liveplay::audio::TransportState::Stopped; ++i)
                std::this_thread::sleep_for(1ms);
            check(source->stats().transport == liveplay::audio::TransportState::Stopped,
                  "live document edit: old media stops before decoder teardown");
        } else {
            check(entered.get_future().wait_for(2s) == std::future_status::ready,
                  "live document edit: actual seek reaches storage gate");
        }
        auto snapshot = std::async(std::launch::async, [&] { return state.full_document(); });
        check(snapshot.wait_for(250ms) == std::future_status::ready,
              "live document edit: document reads remain available during storage wait");
        auto stop = std::async(std::launch::async, [&] { state.stop_all_cues(0); });
        check(stop.wait_for(250ms) == std::future_status::ready &&
                  source->stats().transport == liveplay::audio::TransportState::Stopped &&
                  source->render_block(channels, 2, 256) == 0,
              "live document edit: Stop All acknowledges and silences Program before storage release");
        if (decoder_hold.owns_lock()) decoder_hold.unlock();
        release.set_value(); check(edit.get(), "live document edit: accepted command completes");
        stop.get(); const auto saved = snapshot.get();
        if (mode != 2) backend->vtable = original;
        seek = {};
        std::this_thread::sleep_for(120ms);
        check(!on_air(state, engine, "edit-source") && !on_air(state, engine, "edit-target"),
              "live document edit: cancelled playback/continuation cannot return or advance");
        check(mode == 3 ? saved["items"][0]["endBehavior"]["action"] == "loop" :
                  mode == 0 ? saved["items"][0]["outPoint"] == 0.75 :
                  mode == 1 ? saved["items"][0]["endBehavior"]["action"] == "loop" :
                              saved["items"][0]["mediaServerPath"] == replacement.string(),
              "live document edit: accepted authored change persists; Continue is runtime-only");
        check(wait_ready(state) && state.trigger_item("edit-source"),
              "live document edit: deliberate replay still starts");
        state.stop_all_cues(0);
    }
    std::filesystem::remove(wav); std::filesystem::remove(replacement);
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
    auto items = json::array({audio("stall-bed", wav), grouped ? group : next_item});
    if (mode == 7) items.push_back(next_item);
    state.replace_full_document(document(items));
    check(wait_ready(state), "cold GO stall: media ready"); close_devices(engine);
    check(state.trigger_item("stall-bed") && state.set_next_item_override(target),
          "cold GO stall: program plays and next cue is armed");
    const auto bed = engine.find_cue(*state.item_to_cue_id("stall-bed"));
    const auto next = engine.find_cue(*state.item_to_cue_id("stall-next"));
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
    release.set_value();
    const auto result = go.get();
    stop.get();
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
        std::this_thread::sleep_for(160ms);
        check(follows ? on_air(state, engine, "pause-b")
                      : source->stats().transport == liveplay::audio::TransportState::FadingOut,
              "paused sequence: timing action remains available after Resume");
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
        liveplay::audio::AudioEngine engine;
        liveplay::core::ProjectState state(engine);
        std::mutex received_mutex;
        std::vector<std::string> received;
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
        if (prepared) check(static_cast<bool>(wait_prepared_follow(engine, *state.item_to_cue_id("terminal-target"))),
                            "terminal actions: exact follow prepared");
        render_engine(engine, 4);
        std::this_thread::sleep_for(150ms);
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
    std::filesystem::remove(source); std::filesystem::remove(target);
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
    std::filesystem::remove(source); std::filesystem::remove(target);
}

void test_prepared_follow_runtime(const std::filesystem::path& wav) {
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    state.replace_full_document(document(json::array({audio("prepared-a", wav, {
        {"outPoint", 0.011}, {"endBehavior", {{"action", "next"}}},
        {"duckingBehavior", {{"mode", "no-ducking"}}}}), audio("prepared-b", wav, {
        {"startBehavior", {{"action", "play-item"}, {"targetUuid", "prepared-c"}}}}),
        audio("prepared-c", wav, {{"duckingBehavior", {{"mode", "no-ducking"}}}}),
        audio("prepared-bed", wav)})));
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
    while (!state.item_trigger_seq("prepared-b") && std::chrono::steady_clock::now() < deadline)
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
    const auto wav = std::filesystem::temp_directory_path() / "dwcue-selected-5.1.wav";
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
    std::error_code error;
    std::filesystem::remove(wav, error);
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
    std::filesystem::remove(wav);
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

void test_backup_retention() {
    namespace fs = std::filesystem;
    const auto root = fs::temp_directory_path() /
        ("dwcue-backup-runtime-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    const auto now = fs::file_time_type::clock::now();
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state(engine);
    liveplay::core::BackupManager backup(state);
    for (const bool fail_copy : {false, true}) {
        const auto folder = root / (fail_copy ? "failed-copy" : "chronology");
        const auto history = folder / "backups";
        fs::create_directories(history);
        std::vector<fs::path> existing;
        for (int i = 0; i < 19; ++i) {
            const auto file = history / ("Z_backup_" + std::to_string(i) + ".dwcue");
            std::ofstream(file) << "old-" << i;
            fs::last_write_time(file, now - 48h + std::chrono::minutes(i));
            existing.push_back(file);
        }
        const auto newest = history / "A_backup_newer.dwcue";
        std::ofstream(newest) << "newer-history";
        fs::last_write_time(newest, now - 1h);
        existing.push_back(newest);
        const auto source = folder / "Show.dwcue";
        if (fail_copy) fs::create_directory(source); // Deterministic failure, including elevated test runs.
        else {
            std::ofstream(source) << "complete-source";
            fs::last_write_time(source, now - 200h);
        }
        state.set_project_file_path(source);
        backup.do_backup();
        std::size_t files = 0;
        bool complete_copy = false;
        bool partial_left = false;
        for (const auto& entry : fs::directory_iterator(history)) {
            if (!entry.is_regular_file()) continue;
            partial_left |= entry.path().extension() != ".dwcue";
            if (entry.path().extension() != ".dwcue") continue;
            ++files;
            if (entry.path().filename().string().starts_with("Show_backup_")) {
                std::ifstream in(entry.path());
                std::string contents{std::istreambuf_iterator<char>{in}, {}};
                complete_copy = contents == "complete-source";
                check(fs::last_write_time(entry.path()) >= now - 1min,
                      "backup: age reflects publication rather than source modification");
            }
        }
        if (fail_copy) {
            check(files == 20 && std::all_of(existing.begin(), existing.end(), [](const auto& p) { return fs::exists(p); }),
                  "backup: failed copy retains all twenty usable history files");
        } else {
            check(files == 20 && fs::exists(newest) && !fs::exists(existing.front()),
                  "backup: chronology prunes oldest Z and retains newer A across names");
            check(complete_copy, "backup: publishes a complete copy before retaining the cap");
        }
        check(!partial_left, "backup: no partial publication file remains");
    }
    fs::remove_all(root);
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
    for (int i = 0; i < 45; ++i) {
        item->service_read_ahead(1);
        item->render_block(channels, 2, 256);
    }
    std::this_thread::sleep_for(120ms);
    check(past == 0 && future == 1, "recovery position: crossed actions consumed; future action fires once");
    check(!state.resume_item("resume", 0.6, revision), "recovery position: consumed recovery cannot replay");
    state.stop_all_cues(0);
    check(state.play_item("resume") && on_air(state, engine, "secondary"),
          "recovery position: ordinary replay retains fresh-start action");
    for (int i = 0; i < 100; ++i) {
        item->service_read_ahead(1);
        item->render_block(channels, 2, 256);
    }
    std::this_thread::sleep_for(120ms);
    check(past == 2 && future == 1, "recovery position: ordinary replay retains crossed custom actions");
    state.stop_all_cues(0);
}

void test_changed_media_readiness() {
    const auto folder = std::filesystem::temp_directory_path() /
        ("dwcue-media-revision-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
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
    check(liveplay::util::replace_file_atomically(replacement, path, error),
          "file revision: same-size/date replacement publishes");
    for (int i = 0; i < 200 && state.audio_readiness().value("ready", true); ++i)
        std::this_thread::sleep_for(10ms);
    check(!state.audio_readiness().value("ready", true) && on_air(state, engine, "revision"),
          "file revision: changed source invalidates readiness without cutting active playback");
    check(!state.trigger_item("revision") && on_air(state, engine, "revision"),
          "file revision: stale decoder cannot be accepted as a new play");
    std::array<float, 256> left{}, right{};
    float* channels[]{left.data(), right.data()};
    old->service_read_ahead(1); old->render_block(channels, 2, 256);
    check(std::abs(left[0] - 0.25f) < 1e-6f, "file revision: active pinned file retains its original PCM");
    state.stop_item("revision");
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
    std::filesystem::remove_all(folder);
    std::filesystem::remove(first);
    std::filesystem::remove(second);
}

int main() {
    failures += test_crash_resume_lifecycle();
    const auto wav = make_wav();
    test_position_aware_recovery(wav);
    test_changed_media_readiness();
    test_stop_all_during_project_boundaries(wav);
    test_stop_all_during_decoder_read(wav);
    test_stop_all_during_cue_retirement(wav);
    test_stop_all_during_preview_retirement();
    test_cancelled_preview_preparation();
    test_busy_decoder_preserves_sibling_progress();
    test_stop_all_during_live_edits();
    test_stop_all_during_cold_go(wav);
    test_rejected_document_preserves_show(wav);
    test_rejected_nested_document_preserves_show(wav);
    test_load_resets_project_runtime(wav);
    test_rejected_server_document_preserves_show(wav);
    test_nested_group_end(wav);
    test_group_cancellation(wav);
    test_group_internal_continuations(wav);
    test_external_group_exit(wav);
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
    test_manual_go_parity(wav);
    test_replacement_cancels_ownership();
    test_group_waits_for_fading_child(wav);
    test_group_waits_for_retired_tail(wav);
    test_backup_retention();
    std::error_code error;
    std::filesystem::remove(wav, error);
    std::printf("\n%s (%d failure%s)\n", failures ? "FAILURES" : "ALL PASS",
                failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
