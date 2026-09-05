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

enum class DeviceRecoveryStatus : std::uint8_t {
    Idle,
    Pending,
    Succeeded,
    Failed,
};

constexpr const char* device_recovery_status_name(
    DeviceRecoveryStatus status) noexcept {
    switch (status) {
        case DeviceRecoveryStatus::Idle:      return "idle";
        case DeviceRecoveryStatus::Pending:   return "pending";
        case DeviceRecoveryStatus::Succeeded: return "succeeded";
        case DeviceRecoveryStatus::Failed:    return "failed";
    }
    return "failed";
}

// Control-thread state for one explicitly requested stream restart. Callers
// provide monotonically increasing non-zero ids. Terminal updates are matched
// to the attempt that actually restarted, so a late callback from an older
// attempt cannot complete a newer request.
class DeviceRecoveryRequest {
public:
    [[nodiscard]] bool begin(std::uint64_t request_id) noexcept {
        if (request_id == 0 || status_ == DeviceRecoveryStatus::Pending) {
            return false;
        }
        // Publish Pending before replacing the id. A snapshot can therefore
        // never pair a new id with the preceding attempt's terminal status.
        status_ = DeviceRecoveryStatus::Pending;
        request_id_ = request_id;
        return true;
    }

    [[nodiscard]] bool succeed(std::uint64_t request_id) noexcept {
        return complete(request_id, DeviceRecoveryStatus::Succeeded);
    }

    [[nodiscard]] bool fail(std::uint64_t request_id) noexcept {
        return complete(request_id, DeviceRecoveryStatus::Failed);
    }

    [[nodiscard]] std::uint64_t request_id() const noexcept {
        return request_id_;
    }

    [[nodiscard]] DeviceRecoveryStatus status() const noexcept {
        return status_;
    }

private:
    [[nodiscard]] bool complete(
        std::uint64_t request_id, DeviceRecoveryStatus terminal) noexcept {
        if (request_id == 0 || request_id != request_id_ ||
            status_ != DeviceRecoveryStatus::Pending) {
            return false;
        }
        status_ = terminal;
        return true;
    }

    std::uint64_t request_id_ = 0;
    DeviceRecoveryStatus status_ = DeviceRecoveryStatus::Idle;
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
