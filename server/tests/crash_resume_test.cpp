// Inspect the actual crash-handler record without installing fatal handlers.
#include "../src/crash_handler.cpp"
#include "liveplay/audio/engine.hpp"
#include <deque>
#include <future>
#include <nlohmann/json.hpp>
#include <unordered_set>
// Exercise the same lifecycle fence used by reset, without production hooks.
#define private public
#include "liveplay/core/project_state.hpp"
#undef private

int test_crash_resume_lifecycle() {
    int failures = 0;
    const auto check = [&](bool ok, const char* label) {
        std::printf("%-68s %s\n", label, ok ? "PASS" : "FAIL");
        if (!ok) ++failures;
    };
    const auto cleared = [] {
        const int active = liveplay::g_resume_active.load(std::memory_order_acquire);
        return active >= 0 && liveplay::g_resume[active].project_file[0] == '\0' &&
            liveplay::g_resume[active].item_uuid[0] == '\0' &&
            liveplay::g_resume[active].position_sec == 0.0;
    };
    liveplay::audio::AudioEngine engine;
    liveplay::core::ProjectState state{engine};
    state.set_project_file_path("closed-show.dwcue");
    liveplay::update_crash_resume_state("closed-show.dwcue", "cue-a", 42.0);
    state.reset();
    check(cleared(), "crash resume: close immediately clears the previous project and cue");

    liveplay::update_crash_resume_state("closed-show.dwcue", "cue-a", 42.0);
    state.publish_crash_resume_state();
    check(cleared(), "crash resume: empty heartbeat publishes an explicit clear");

    state.set_project_file_path("open-show.dwcue");
    state.publish_crash_resume_state();
    const int active = liveplay::g_resume_active.load(std::memory_order_acquire);
    check(active >= 0 &&
              std::strcmp(liveplay::g_resume[active].project_file, "open-show.dwcue") == 0,
          "crash resume: heartbeat preserves an open project's path");

    std::unique_lock lifecycle_lock{state.playback_lifecycle_mutex_};
    std::promise<void> entered;
    auto entered_future = entered.get_future();
    auto heartbeat = std::async(std::launch::async, [&] {
        entered.set_value();
        state.publish_crash_resume_state();
    });
    entered_future.wait();
    check(heartbeat.wait_for(std::chrono::milliseconds{50}) == std::future_status::timeout,
          "crash resume: heartbeat shares the close lifecycle fence");
    state.reset();
    lifecycle_lock.unlock();
    heartbeat.get();
    check(cleared(), "crash resume: queued heartbeat cannot republish a closed project");

    const auto supersedes = [&](auto intent, const char* label) {
        const auto revision = state.playback_intent_revision();
        intent();
        check(state.playback_intent_revision() != revision &&
                  !state.resume_item("cue-a", 0.6, revision), label);
    };
    supersedes([&] { state.stop_item("cue-a"); }, "crash resume: Stop cancels pending recovery even before decode");
    supersedes([&] { state.stop_all_cues(0); }, "crash resume: Panic cancels pending recovery");
    supersedes([&] { state.play_item("cue-b"); }, "crash resume: newer Play cancels pending recovery");
    supersedes([&] { state.trigger_item("group"); }, "crash resume: newer group trigger cancels pending recovery");
    supersedes([&] { state.go(); }, "crash resume: GO supersedes pending recovery even without a target");
    supersedes([&] { state.set_item_paused("cue-a", true); }, "crash resume: Pause supersedes pending recovery");
    supersedes([&] { state.reset(); }, "crash resume: close cancels pending recovery");
    supersedes([&] { state.load_from_json({{"name", "reopened"}, {"items", nlohmann::json::array()}}); },
               "crash resume: project load cancels pending recovery");
    return failures;
}
