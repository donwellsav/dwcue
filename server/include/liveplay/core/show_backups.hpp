// ============================================================================
// liveplay/core/show_backups.hpp
// ----------------------------------------------------------------------------
// Automatic show-file backups made at save time.
//
// Just before the engine overwrites an existing show file it copies the file
// that is on disk into a "Backups" folder beside it:
//
//     <show folder>/Backups/<show file stem> <YYYY-MM-DD HH.MM.SS>.dwcue
//
// The timestamp is local time and the name is valid on Windows, macOS and
// Linux. At most one automatic backup is made per kMinBackupIntervalSeconds,
// except for the first save after a show is opened; a copy identical to the
// newest backup is never made; only the newest kMaxBackupsPerShow backups of a
// show are kept. Only files that match this show's backup naming pattern are
// ever listed, restored or deleted.
//
// Nothing here logs or throws: callers decide what a failed backup means (a
// save carries on; a restore refuses). All I/O is synchronous and must run on
// a storage/control thread, never on the audio thread. ProjectState calls
// backup_before_overwrite() under its save mutex, which is what serialises
// writers of a Backups folder.
// ============================================================================
#pragma once

#include <compare>
#include <cstddef>
#include <cstdint>
#include <ctime>
#include <filesystem>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace liveplay::core::show_backups {

inline constexpr std::string_view kBackupFolderName = "Backups";
inline constexpr std::string_view kBackupExtension = ".dwcue";
inline constexpr std::size_t kMaxBackupsPerShow = 10;
inline constexpr std::int64_t kMinBackupIntervalSeconds = 5 * 60;

// ---- Naming (pure) ---------------------------------------------------------

// The local wall-clock time carried in a backup's file name. Ordering is
// chronological.
struct BackupStamp {
    int year = 0;
    int month = 0;
    int day = 0;
    int hour = 0;
    int minute = 0;
    int second = 0;
    auto operator<=>(const BackupStamp&) const = default;
};

// "YYYY-MM-DD HH.MM.SS"
std::string format_stamp(const BackupStamp& stamp);
// Strict inverse of format_stamp; nullopt for anything else.
std::optional<BackupStamp> parse_stamp(std::string_view text);
// Local time for `time` (localtime_s / localtime_r).
BackupStamp local_stamp(std::time_t time);
// Seconds since the Unix epoch for a local-time stamp; nullopt when the
// platform cannot represent it.
std::optional<std::int64_t> stamp_to_epoch_seconds(const BackupStamp& stamp);

// "<show stem> <stamp>.dwcue"
std::string backup_file_name(std::string_view show_stem, const BackupStamp& stamp);

struct BackupName {
    std::string stem;   // the show file stem the backup belongs to
    BackupStamp stamp;
};
// Parses a bare backup file name of any show. Rejects path separators, NUL and
// control characters, so "..", absolute paths and nested paths never parse.
std::optional<BackupName> parse_backup_file_name(std::string_view file_name);
// True only for a bare file name that is a backup of the show with this stem.
bool is_backup_file_name_for(std::string_view file_name, std::string_view show_stem);
// True for the Backups folder name in any letter case ("backups" is the same
// folder on Windows and macOS).
bool is_backup_folder_name(std::string_view folder_name);

// ---- Selection (pure) ------------------------------------------------------

struct BackupEntry {
    std::string name;                 // bare file name, UTF-8
    BackupStamp stamp;
    std::filesystem::path path;       // empty until read from a folder
    std::uintmax_t size = 0;          // bytes
    std::int64_t saved_at_ms = 0;     // epoch milliseconds from the stamp
};

// Of the file names found in one Backups folder, the backups of the show with
// stem `show_stem`, newest first. A stem that is not byte-identical is offered
// to `same_show` (when given), so the caller can let the filesystem decide
// names that differ only by letter case or Unicode normalisation.
std::vector<BackupEntry> show_backups_newest_first(
    const std::vector<std::string>& file_names,
    std::string_view show_stem,
    const std::function<bool(std::string_view stem)>& same_show = {});

// The entries to delete so that only the newest `keep` remain.
std::vector<BackupEntry> backups_to_prune(
    const std::vector<BackupEntry>& newest_first,
    std::size_t keep = kMaxBackupsPerShow);

// ---- The five-minute rule (pure) -------------------------------------------

struct BackupTiming {
    // Restore's undo copy: always wanted, whatever was backed up recently.
    bool force = false;
    // No backup has been considered yet for this open of the show.
    bool first_save_since_open = false;
    // The show already has at least one backup.
    bool has_previous = false;
    // Age of the newest backup according to its name. Negative when the wall
    // clock moved backwards; that never blocks a backup.
    std::optional<std::int64_t> seconds_since_newest;
    // Monotonic time since this engine last made a backup for this show, so a
    // wall-clock change cannot make autosaves flush the history.
    std::optional<std::int64_t> seconds_since_last_made;
};
bool backup_is_due(const BackupTiming& timing,
                   std::int64_t min_interval_seconds = kMinBackupIntervalSeconds);

// ---- Filesystem ------------------------------------------------------------

// A show file the engine keeps backups for: an absolute .dwcue path that is
// not itself a backup inside a Backups folder.
bool is_backup_eligible(const std::filesystem::path& show_file);
// <show folder>/Backups
std::filesystem::path backup_folder_for(const std::filesystem::path& show_file);
// Byte-for-byte comparison. False when either file cannot be read.
bool files_identical(const std::filesystem::path& left,
                     const std::filesystem::path& right) noexcept;
// This show's backups, newest first. Empty when there are none or the folder
// cannot be read.
std::vector<BackupEntry> list_backups(const std::filesystem::path& show_file) noexcept;

enum class BackupOutcome {
    Created,
    SkippedRecent,      // the five-minute rule
    SkippedIdentical,   // the newest backup already holds these bytes
    NothingToBackUp,    // no file on disk yet, or not a path we back up
    Failed,
};

struct BackupResult {
    BackupOutcome outcome = BackupOutcome::NothingToBackUp;
    // Created: the new backup. SkippedIdentical: the backup that already holds
    // the same bytes. Empty otherwise.
    std::string name;
    // Failed: what went wrong. Created: a pruning problem, if any.
    std::string detail;
    std::size_t pruned = 0;
};

// Copies the show file that is on disk into its Backups folder when `timing`
// and the identical-content rule call for it, then prunes old backups. Fills
// `has_previous` and `seconds_since_newest` itself from the folder; the caller
// supplies the rest. Never throws; a failure leaves existing backups alone.
BackupResult backup_before_overwrite(const std::filesystem::path& show_file,
                                     BackupTiming timing,
                                     std::time_t now = std::time(nullptr)) noexcept;

} // namespace liveplay::core::show_backups
