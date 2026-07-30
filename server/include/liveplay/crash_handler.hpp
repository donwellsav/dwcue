// ============================================================================
// liveplay/crash_handler.hpp
// ----------------------------------------------------------------------------
// Installs top-level crash handlers so an unhandled fault (segfault, access
// violation, uncaught exception, std::terminate) prints a stack trace + reason
// to stderr AND to a crash log file before the process exits. Without this the
// server window vanishes on a fault and the operator has nothing to go on.
// ============================================================================
#pragma once

#include <cstddef>
#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

namespace liveplay {

namespace crash_restart {

// Keep argv boundaries intact. Shell-joined arguments cannot represent spaces,
// quotes, or metacharacters safely and are never needed for exec/CreateProcess.
inline std::vector<std::string> filtered_arguments(int argc,
                                                   char* const argv[]) {
    std::vector<std::string> result;
    for (int i = 1; i < argc; ++i) {
        const std::string_view argument{argv[i]};
        if (argument == "--start-delay-ms") {
            if (i + 1 < argc) ++i;
            continue;
        }
        result.emplace_back(argument);
    }
    return result;
}

namespace detail {
template <typename Char>
inline std::basic_string<Char> quote_windows_argument_impl(
    std::basic_string_view<Char> argument) {
    const Char slash = static_cast<Char>('\\');
    const Char quote = static_cast<Char>('"');
    std::basic_string<Char> quoted(1, quote);
    std::size_t backslashes = 0;
    for (const Char c : argument) {
        if (c == slash) {
            ++backslashes;
            continue;
        }
        if (c == quote) {
            quoted.append(backslashes * 2 + 1, slash);
            quoted.push_back(quote);
        } else {
            quoted.append(backslashes, slash);
            quoted.push_back(c);
        }
        backslashes = 0;
    }
    quoted.append(backslashes * 2, slash);
    quoted.push_back(quote);
    return quoted;
}
} // namespace detail

// Microsoft CRT command-line quoting rules. Always quoting keeps construction
// predictable; backslashes only need doubling before a quote or the final quote.
inline std::string quote_windows_argument(std::string_view argument) {
    return detail::quote_windows_argument_impl(argument);
}

inline std::wstring quote_windows_argument(std::wstring_view argument) {
    return detail::quote_windows_argument_impl(argument);
}

} // namespace crash_restart

// Call once early in main(). Idempotent. `log_dir` is the writable directory
// for crash logs; if empty, cwd is used.
void install_crash_handlers(
    const std::filesystem::path& log_dir = {});

// Configure crash-loop protection. `counter_file` is a path where the
// consecutive-crash count is persisted across restarts; `consecutive_so_far`
// is the count read from that file at startup; `max_consecutive` is the number
// of back-to-back crashes after which the handler stops auto-restarting (so a
// deterministic crash can't relaunch forever). Call once at startup, after
// set_crash_exe_info().
void set_crash_restart_guard(const std::filesystem::path& counter_file,
                             int consecutive_so_far,
                             int max_consecutive);

// Reset the consecutive-crash count to zero (in memory and on disk). Call once
// the process has been running healthily for a while, and on clean shutdown, so
// isolated crashes over a long session don't accumulate toward the give-up
// threshold.
void reset_crash_restart_guard();

// Disable automatic relaunch before an intentional shutdown tears down server
// and audio objects. A fault during teardown should exit, not resurrect.
void disable_crash_restart() noexcept;

// Delete all but the newest `keep` crash-log files in `dir`. Best-effort;
// safe to call at startup (never from a signal handler).
void prune_crash_logs(const std::filesystem::path& dir, std::size_t keep);

// Tell the crash handler where the server executable lives and the exact
// arguments it was started with (so it can relaunch after a crash). Argument
// boundaries are preserved; no shell is involved on POSIX.
void set_crash_exe_info(const std::filesystem::path& exe_path,
                        const std::vector<std::string>& restart_args,
                        const std::filesystem::path& resume_file);

// Update the playback state that the crash handler will persist so the new
// instance can resume from where playback stopped. Safe to call frequently
// (e.g. from the heartbeat loop). Pass empty strings / 0.0 to clear.
void update_crash_resume_state(const std::string& project_file,
                                const std::string& playing_item_uuid,
                                double             position_sec);

} // namespace liveplay
