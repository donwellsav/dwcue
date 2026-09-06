#include "liveplay/audio/engine.hpp"
#include "liveplay/core/project_state.hpp"

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
void set_loader_gate(const std::filesystem::path& gate) {
    const auto value = gate.string();
#ifdef _WIN32
    _putenv_s("DWCUE_TEST_LOADER_GATE", value.c_str());
#else
    setenv("DWCUE_TEST_LOADER_GATE", value.c_str(), 1);
#endif
}
void clear_loader_gate() {
#ifdef _WIN32
    _putenv_s("DWCUE_TEST_LOADER_GATE", "");
#else
    unsetenv("DWCUE_TEST_LOADER_GATE");
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
std::filesystem::path make_silent_wav() {
    const auto path = std::filesystem::temp_directory_path() /
                      "dwcue-project-state-runtime.wav";
    constexpr std::uint32_t frames = 48'000;
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    out.write("RIFF", 4); u32(out, 36 + frames * 2); out.write("WAVEfmt ", 8);
    u32(out, 16); u16(out, 1); u16(out, 1); u32(out, 48'000); u32(out, 96'000);
    u16(out, 2); u16(out, 16); out.write("data", 4); u32(out, frames * 2);
    std::array<char, 4096> zero{};
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
void render_to_end(liveplay::core::ProjectState& state,
                   liveplay::audio::AudioEngine& engine,
                   const std::string& uuid, int limit = 400) {
    const auto cue = state.item_to_cue_id(uuid);
    if (!cue) return;
    const auto item = engine.find_cue(*cue);
    if (!item) return;
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
    check(on_air(state, engine, "target"),
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
        check(on_air(state, engine, "loop-child") && !on_air(state, engine, "target"),
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
        check(on_air(state, engine, "chain-b"), label);
        render_to_end(state, engine, "chain-b");
        check(on_air(state, engine, "chain-end"),
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
    check(on_air(state, engine, "external"), "group external exit: override target starts");
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
    check(on_air(state, engine, "ready-selected") && !on_air(state, engine, "ready-unselected"),
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
    check(on_air(state, engine, "start-a"),
          "start action: primary remains on Program after cycle rejection");
    check(on_air(state, engine, "start-b"),
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
} // namespace

int main() {
    const auto wav = make_silent_wav();
    test_stop_all_during_project_boundaries(wav);
    test_nested_group_end(wav);
    test_group_cancellation(wav);
    test_group_internal_continuations(wav);
    test_external_group_exit(wav);
    test_nested_play_first_readiness(wav);
    test_start_actions(wav);
    std::error_code error;
    std::filesystem::remove(wav, error);
    std::printf("\n%s (%d failure%s)\n", failures ? "FAILURES" : "ALL PASS",
                failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
