// Callback-entry liveness accounting shared by AudioEngine and deterministic tests.
#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>

namespace liveplay::audio {

class CallbackEntryCounter {
public:
    void record_entry() noexcept {
        entries_.fetch_add(1, std::memory_order_relaxed);
    }

    [[nodiscard]] std::uint64_t value() const noexcept {
        return entries_.load(std::memory_order_relaxed);
    }

private:
    std::atomic<std::uint64_t> entries_{0};
};

enum class CallbackLivenessState : std::uint8_t {
    Starting,
    Running,
    Stalled,
};

[[nodiscard]] constexpr bool is_healthy_clock_source(
    CallbackLivenessState state) noexcept {
    return state == CallbackLivenessState::Running;
}

class CallbackLivenessMonitor {
public:
    using Clock = std::chrono::steady_clock;
    using TimePoint = Clock::time_point;
    using Duration = Clock::duration;

    explicit CallbackLivenessMonitor(
        Duration timeout = std::chrono::seconds{1}) noexcept
        : timeout_(timeout) {}

    void arm(std::uint64_t callback_entries, TimePoint now) noexcept {
        observed_entries_ = callback_entries;
        last_progress_ = now;
        state_ = CallbackLivenessState::Starting;
    }

    [[nodiscard]] CallbackLivenessState tick(
        std::uint64_t callback_entries, TimePoint now) noexcept {
        if (callback_entries != observed_entries_) {
            observed_entries_ = callback_entries;
            last_progress_ = now;
            state_ = CallbackLivenessState::Running;
        } else if (state_ != CallbackLivenessState::Stalled &&
                   now - last_progress_ >= timeout_) {
            state_ = CallbackLivenessState::Stalled;
        }
        return state_;
    }

    [[nodiscard]] CallbackLivenessState state() const noexcept {
        return state_;
    }

private:
    Duration timeout_;
    TimePoint last_progress_{};
    std::uint64_t observed_entries_ = 0;
    CallbackLivenessState state_ = CallbackLivenessState::Starting;
};

} // namespace liveplay::audio
