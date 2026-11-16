// ============================================================================
// show_backups.cpp — see show_backups.hpp.
// ============================================================================
#include "liveplay/core/show_backups.hpp"

#include "liveplay/util/atomic_file.hpp"
#include "liveplay/util/unicode_path.hpp"

#include <algorithm>
#include <cstdio>
#include <exception>
#include <fstream>
#include <system_error>
#include <unordered_map>

namespace liveplay::core::show_backups {

namespace fs = std::filesystem;

namespace {

constexpr std::size_t kStampLength = 19;  // "YYYY-MM-DD HH.MM.SS"
// One fixed staging name: an interrupted copy is replaced by the next attempt
// instead of accumulating, and it can never look like a backup.
constexpr std::string_view kStagingName = ".dwcue-backup.part";
// Backups made within the same second take the next free second.
constexpr int kNameAttempts = 10;

bool is_digit(char c) { return c >= '0' && c <= '9'; }

bool all_digits(std::string_view text, std::size_t from, std::size_t count) {
    for (std::size_t i = from; i < from + count; ++i)
        if (!is_digit(text[i])) return false;
    return true;
}

int number(std::string_view text, std::size_t from, std::size_t count) {
    int value = 0;
    for (std::size_t i = from; i < from + count; ++i)
        value = value * 10 + (text[i] - '0');
    return value;
}

char ascii_lower(char c) {
    return (c >= 'A' && c <= 'Z') ? static_cast<char>(c - 'A' + 'a') : c;
}

bool ascii_iequals(std::string_view left, std::string_view right) {
    return left.size() == right.size() &&
           std::equal(left.begin(), left.end(), right.begin(),
                      [](char a, char b) { return ascii_lower(a) == ascii_lower(b); });
}

} // namespace

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------
std::string format_stamp(const BackupStamp& stamp) {
    char text[96];
    std::snprintf(text, sizeof(text), "%04d-%02d-%02d %02d.%02d.%02d",
                  stamp.year, stamp.month, stamp.day,
                  stamp.hour, stamp.minute, stamp.second);
    return text;
}

std::optional<BackupStamp> parse_stamp(std::string_view text) {
    if (text.size() != kStampLength) return std::nullopt;
    if (text[4] != '-' || text[7] != '-' || text[10] != ' ' ||
        text[13] != '.' || text[16] != '.') {
        return std::nullopt;
    }
    if (!all_digits(text, 0, 4) || !all_digits(text, 5, 2) ||
        !all_digits(text, 8, 2) || !all_digits(text, 11, 2) ||
        !all_digits(text, 14, 2) || !all_digits(text, 17, 2)) {
        return std::nullopt;
    }
    const BackupStamp stamp{
        number(text, 0, 4), number(text, 5, 2), number(text, 8, 2),
        number(text, 11, 2), number(text, 14, 2), number(text, 17, 2)};
    if (stamp.month < 1 || stamp.month > 12 || stamp.day < 1 || stamp.day > 31 ||
        stamp.hour > 23 || stamp.minute > 59 || stamp.second > 60) {
        return std::nullopt;
    }
    return stamp;
}

BackupStamp local_stamp(std::time_t time) {
    std::tm local{};
#if defined(_WIN32)
    localtime_s(&local, &time);
#else
    localtime_r(&time, &local);
#endif
    return BackupStamp{local.tm_year + 1900, local.tm_mon + 1, local.tm_mday,
                       local.tm_hour, local.tm_min, local.tm_sec};
}

std::optional<std::int64_t> stamp_to_epoch_seconds(const BackupStamp& stamp) {
    std::tm local{};
    local.tm_year = stamp.year - 1900;
    local.tm_mon = stamp.month - 1;
    local.tm_mday = stamp.day;
    local.tm_hour = stamp.hour;
    local.tm_min = stamp.minute;
    local.tm_sec = stamp.second;
    local.tm_isdst = -1;  // let the C library decide for that date
    const std::time_t time = std::mktime(&local);
    if (time == static_cast<std::time_t>(-1)) return std::nullopt;
    return static_cast<std::int64_t>(time);
}

std::string backup_file_name(std::string_view show_stem, const BackupStamp& stamp) {
    std::string name{show_stem};
    name += ' ';
    name += format_stamp(stamp);
    name += kBackupExtension;
    return name;
}

std::optional<BackupName> parse_backup_file_name(std::string_view file_name) {
    const std::size_t suffix = 1 + kStampLength + kBackupExtension.size();
    if (file_name.size() <= suffix) return std::nullopt;  // the stem is never empty
    for (const char raw : file_name) {
        const auto c = static_cast<unsigned char>(raw);
        if (c < 0x20 || c == 0x7f || c == '/' || c == '\\') return std::nullopt;
    }
    if (!file_name.ends_with(kBackupExtension)) return std::nullopt;
    const std::size_t stem_length = file_name.size() - suffix;
    if (file_name[stem_length] != ' ') return std::nullopt;
    const auto stamp = parse_stamp(file_name.substr(stem_length + 1, kStampLength));
    if (!stamp) return std::nullopt;
    return BackupName{std::string{file_name.substr(0, stem_length)}, *stamp};
}

bool is_backup_file_name_for(std::string_view file_name, std::string_view show_stem) {
    const auto parsed = parse_backup_file_name(file_name);
    return parsed && parsed->stem == show_stem;
}

bool is_backup_folder_name(std::string_view folder_name) {
    return ascii_iequals(folder_name, kBackupFolderName);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------
std::vector<BackupEntry> show_backups_newest_first(
    const std::vector<std::string>& file_names,
    std::string_view show_stem,
    const std::function<bool(std::string_view stem)>& same_show) {
    std::vector<BackupEntry> entries;
    for (const auto& name : file_names) {
        const auto parsed = parse_backup_file_name(name);
        if (!parsed) continue;
        if (parsed->stem != show_stem && !(same_show && same_show(parsed->stem)))
            continue;
        BackupEntry entry;
        entry.name = name;
        entry.stamp = parsed->stamp;
        if (const auto epoch = stamp_to_epoch_seconds(entry.stamp))
            entry.saved_at_ms = *epoch * 1000;
        entries.push_back(std::move(entry));
    }
    std::sort(entries.begin(), entries.end(),
              [](const BackupEntry& left, const BackupEntry& right) {
                  if (left.stamp != right.stamp) return left.stamp > right.stamp;
                  return left.name > right.name;
              });
    return entries;
}

std::vector<BackupEntry> backups_to_prune(const std::vector<BackupEntry>& newest_first,
                                          std::size_t keep) {
    if (newest_first.size() <= keep) return {};
    return {newest_first.begin() + static_cast<std::ptrdiff_t>(keep), newest_first.end()};
}

// ---------------------------------------------------------------------------
// The five-minute rule
// ---------------------------------------------------------------------------
bool backup_is_due(const BackupTiming& timing, std::int64_t min_interval_seconds) {
    if (timing.force || timing.first_save_since_open) return true;
    const auto recent = [&](const std::optional<std::int64_t>& age) {
        return age && *age >= 0 && *age < min_interval_seconds;
    };
    if (recent(timing.seconds_since_last_made)) return false;
    if (!timing.has_previous) return true;
    return !recent(timing.seconds_since_newest);
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------
bool is_backup_eligible(const fs::path& show_file) {
    if (show_file.empty() || !show_file.is_absolute() || !show_file.has_parent_path())
        return false;
    if (!ascii_iequals(util::path_to_utf8(show_file.extension()), kBackupExtension))
        return false;
    const std::string stem = util::path_to_utf8(show_file.stem());
    if (stem.empty()) return false;
    // Only make names this unit recognises again; otherwise the history could
    // never be listed or pruned.
    if (!is_backup_file_name_for(backup_file_name(stem, BackupStamp{2000, 1, 1, 0, 0, 0}), stem))
        return false;
    // A backup opened directly as a show does not grow Backups/Backups.
    if (is_backup_folder_name(util::path_to_utf8(show_file.parent_path().filename())) &&
        parse_backup_file_name(util::path_to_utf8(show_file.filename()))) {
        return false;
    }
    return true;
}

fs::path backup_folder_for(const fs::path& show_file) {
    return show_file.parent_path() / util::utf8_to_path(std::string{kBackupFolderName});
}

bool files_identical(const fs::path& left, const fs::path& right) noexcept {
    try {
        std::error_code ec;
        const auto left_size = fs::file_size(left, ec);
        if (ec) return false;
        const auto right_size = fs::file_size(right, ec);
        if (ec || left_size != right_size) return false;

        std::ifstream left_file{left, std::ios::binary};
        std::ifstream right_file{right, std::ios::binary};
        if (!left_file || !right_file) return false;
        constexpr std::size_t kChunk = 64 * 1024;
        std::vector<char> left_bytes(kChunk), right_bytes(kChunk);
        std::uintmax_t compared = 0;
        while (compared < left_size) {
            left_file.read(left_bytes.data(), static_cast<std::streamsize>(kChunk));
            right_file.read(right_bytes.data(), static_cast<std::streamsize>(kChunk));
            const auto count = left_file.gcount();
            if (count <= 0 || count != right_file.gcount()) return false;
            if (!std::equal(left_bytes.begin(), left_bytes.begin() + count,
                            right_bytes.begin())) {
                return false;
            }
            compared += static_cast<std::uintmax_t>(count);
        }
        return compared == left_size;
    } catch (...) {
        return false;
    }
}

std::vector<BackupEntry> list_backups(const fs::path& show_file) noexcept {
    try {
        if (!is_backup_eligible(show_file)) return {};
        std::error_code ec;
        std::vector<std::string> names;
        std::unordered_map<std::string, fs::path> paths;
        fs::directory_iterator it{backup_folder_for(show_file), ec};
        if (ec) return {};
        for (const fs::directory_iterator end; it != end; it.increment(ec)) {
            if (ec) break;
            std::error_code entry_error;
            // Links are never listed, restored or deleted.
            if (!fs::is_regular_file(it->symlink_status(entry_error)) || entry_error)
                continue;
            std::string name = util::path_to_utf8(it->path().filename());
            paths.emplace(name, it->path());
            names.push_back(std::move(name));
        }

        // The file system, not a byte comparison, has the last word on whether
        // a differently spelled stem (letter case on Windows/macOS, Unicode
        // normalisation on HFS+ or network shares) names this show file.
        std::unordered_map<std::string, bool> known;
        const auto same_show = [&](std::string_view stem) {
            const auto [found, inserted] = known.try_emplace(std::string{stem}, false);
            if (inserted) {
                fs::path sibling = show_file.parent_path() / util::utf8_to_path(found->first);
                sibling += show_file.extension();
                std::error_code equivalent_error;
                found->second = fs::equivalent(sibling, show_file, equivalent_error) &&
                                !equivalent_error;
            }
            return found->second;
        };

        auto entries = show_backups_newest_first(
            names, util::path_to_utf8(show_file.stem()), same_show);
        for (auto& entry : entries) {
            entry.path = paths[entry.name];
            std::error_code size_error;
            const auto size = fs::file_size(entry.path, size_error);
            // Pruned or replaced while the folder was being read: not listed.
            if (size_error) entry.path.clear();
            else entry.size = size;
        }
        std::erase_if(entries, [](const BackupEntry& entry) { return entry.path.empty(); });
        return entries;
    } catch (...) {
        return {};
    }
}

BackupResult backup_before_overwrite(const fs::path& show_file,
                                     BackupTiming timing,
                                     std::time_t now) noexcept {
    BackupResult result;
    fs::path staged;
    const auto failed = [&](std::string detail) {
        if (!staged.empty()) {
            std::error_code cleanup_error;
            fs::remove(staged, cleanup_error);
        }
        result.outcome = BackupOutcome::Failed;
        result.name.clear();
        result.detail = std::move(detail);
        return result;
    };
    try {
        if (!is_backup_eligible(show_file)) return result;
        std::error_code ec;
        const auto status = fs::status(show_file, ec);
        if (!fs::is_regular_file(status)) return result;  // nothing on disk to protect yet

        const auto existing = list_backups(show_file);
        timing.has_previous = !existing.empty();
        timing.seconds_since_newest.reset();
        if (!existing.empty()) {
            if (const auto newest = stamp_to_epoch_seconds(existing.front().stamp))
                timing.seconds_since_newest = static_cast<std::int64_t>(now) - *newest;
        }
        if (!backup_is_due(timing)) {
            result.outcome = BackupOutcome::SkippedRecent;
            return result;
        }
        if (!existing.empty() && files_identical(show_file, existing.front().path)) {
            result.outcome = BackupOutcome::SkippedIdentical;
            result.name = existing.front().name;
            return result;
        }

        const fs::path folder = backup_folder_for(show_file);
        ec.clear();
        fs::create_directories(folder, ec);
        if (ec) return failed("cannot create the Backups folder: " + ec.message());

        staged = folder / util::utf8_to_path(std::string{kStagingName});
        // Clear a leftover from an interrupted copy (or a planted link) so the
        // copy below always creates a fresh regular file.
        fs::remove(staged, ec);
        ec.clear();
        fs::copy_file(show_file, staged, fs::copy_options::none, ec);
        if (ec) return failed("cannot copy the show file: " + ec.message());
        const auto source_size = fs::file_size(show_file, ec);
        const auto staged_size = ec ? 0 : fs::file_size(staged, ec);
        if (ec || source_size != staged_size)
            return failed("the copy of the show file is incomplete");
        // The name carries the time; the file date is a courtesy for file
        // managers (a plain copy keeps the show's own date on Windows).
        std::error_code date_error;
        fs::last_write_time(staged, fs::file_time_type::clock::now(), date_error);

        bool published = false;
        for (int attempt = 0; attempt < kNameAttempts && !published; ++attempt) {
            const BackupStamp stamp = local_stamp(now + attempt);
            // Append to the native stem so a non-ASCII show name is never
            // re-encoded through a narrow code page.
            fs::path target = folder / show_file.stem();
            target += util::utf8_to_path(
                " " + format_stamp(stamp) + std::string{kBackupExtension});
            std::error_code probe_error;
            if (fs::exists(fs::symlink_status(target, probe_error)))
                continue;  // an existing backup is never replaced
            if (!util::replace_file_atomically(staged, target, ec))
                return failed("cannot publish the backup: " + ec.message());
            published = true;
            result.name = util::path_to_utf8(target.filename());
        }
        if (!published) return failed("no free backup name for this moment");
        staged.clear();
        result.outcome = BackupOutcome::Created;

        // Only retire history after the new copy is complete. The copy just
        // made is kept even if a clock change makes it sort as the oldest.
        for (const auto& stale : backups_to_prune(list_backups(show_file))) {
            if (stale.name == result.name) continue;
            std::error_code remove_error;
            fs::remove(stale.path, remove_error);
            if (remove_error) {
                result.detail = "cannot remove old backup '" + stale.name +
                                "': " + remove_error.message();
                break;
            }
            ++result.pruned;
        }
        return result;
    } catch (const std::exception& exception) {
        return failed(exception.what());
    } catch (...) {
        return failed("unknown error");
    }
}

} // namespace liveplay::core::show_backups
