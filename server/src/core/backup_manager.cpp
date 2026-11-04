#include "liveplay/core/backup_manager.hpp"
#include "liveplay/core/project_file.hpp"
#include "liveplay/logger.hpp"
#include "liveplay/util/atomic_file.hpp"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <format>
#include <string>
#include <system_error>
#include <vector>

namespace liveplay::core {

namespace fs = std::filesystem;

namespace {
// path::string() converts to the active code page and THROWS std::system_error
// when a character (e.g. non-Latin project names) cannot be represented. Logging
// must never crash the backup thread, so convert through UTF-8, which can always
// represent any path and never throws.
std::string path_to_utf8(const fs::path& p) {
    const std::u8string s = p.u8string();
    return std::string(s.begin(), s.end());
}
} // namespace

BackupManager::BackupManager(ProjectState& project)
    : project_(project) {}

BackupManager::~BackupManager() {
    stop();
}

void BackupManager::start() {
    if (running_.exchange(true)) return;
    thread_ = std::thread(&BackupManager::loop, this);
}

void BackupManager::stop() {
    if (!running_.exchange(false)) return;
    if (thread_.joinable()) thread_.join();
}

void BackupManager::loop() {
    using namespace std::chrono_literals;
    constexpr auto interval = std::chrono::minutes(INTERVAL_MINUTES);
    constexpr auto tick     = 500ms;

    auto next_backup = std::chrono::steady_clock::now() + interval;

    while (running_.load()) {
        std::this_thread::sleep_for(tick);
        if (!running_.load()) break;
        if (std::chrono::steady_clock::now() >= next_backup) {
            // A backup failure must never take down the server: this runs on a
            // detached worker thread, so any escaping exception would terminate
            // the whole process.
            try {
                do_backup();
            } catch (const std::exception& e) {
                Logger::warn("Backup: skipped (exception: {})", e.what());
            } catch (...) {
                Logger::warn("Backup: skipped (unknown exception)");
            }
            next_backup = std::chrono::steady_clock::now() + interval;
        }
    }
}

void BackupManager::do_backup() {
    const fs::path src = project_.project_file_path();
    if (src.empty() || !project_file::is_native_project(src) ||
        !fs::exists(src)) return;

    const fs::path backup_dir = src.parent_path() / "backups";
    std::error_code ec;
    fs::create_directories(backup_dir, ec);
    if (ec) {
        Logger::warn("Backup: could not create backups directory '{}': {}",
                     path_to_utf8(backup_dir), ec.message());
        return;
    }

    // Timestamp: YYYY-MM-DD_HH-MM
    const auto now    = std::chrono::system_clock::now();
    const auto t      = std::chrono::system_clock::to_time_t(now);
    std::tm tm_buf{};
#if defined(_WIN32)
    localtime_s(&tm_buf, &t);
#else
    localtime_r(&t, &tm_buf);
#endif
    const std::string timestamp = std::format("{:04d}-{:02d}-{:02d}_{:02d}-{:02d}",
                                              tm_buf.tm_year + 1900,
                                              tm_buf.tm_mon  + 1,
                                              tm_buf.tm_mday,
                                              tm_buf.tm_hour,
                                              tm_buf.tm_min);
    // Build the destination via path concatenation so the (possibly non-ASCII)
    // project name keeps its native encoding. Going through a narrow std::string
    // here would throw std::system_error for names outside the active code page.
    fs::path dst = backup_dir / src.stem();
    dst += "_backup_" + timestamp + ".dwcue";

    fs::path temporary = dst;
    temporary += ".tmp";
    fs::copy_file(src, temporary, fs::copy_options::overwrite_existing, ec);
    if (!ec) fs::last_write_time(temporary, fs::file_time_type::clock::now(), ec);
    if (!ec) util::replace_file_atomically(temporary, dst, ec);
    if (ec) {
        Logger::warn("Backup: failed to write '{}': {}", path_to_utf8(dst), ec.message());
        std::error_code cleanup_error;
        fs::remove(temporary, cleanup_error);
        return;
    }
    Logger::info("Backup saved: {}", path_to_utf8(dst.filename()));

    // Only retire history after a complete replacement has been published.
    {
        std::vector<std::pair<fs::file_time_type, fs::path>> existing;
        for (const auto& entry : fs::directory_iterator(backup_dir, ec)) {
            if (!ec && entry.is_regular_file(ec)) {
                const auto& p = entry.path();
                if (project_file::is_native_project(p)) {
                    const auto modified = entry.last_write_time(ec);
                    if (ec) break;
                    existing.emplace_back(modified, p);
                }
            }
            if (ec) break;
        }
        if (ec) {
            Logger::warn("Backup: could not inspect history '{}': {}", path_to_utf8(backup_dir), ec.message());
            return;
        }
        std::sort(existing.begin(), existing.end());
        while (existing.size() > MAX_BACKUPS) {
            fs::remove(existing.front().second, ec);
            if (ec) {
                Logger::warn("Backup: could not remove old backup '{}': {}",
                             path_to_utf8(existing.front().second), ec.message());
                break;
            }
            existing.erase(existing.begin());
        }
    }
}

} // namespace liveplay::core
