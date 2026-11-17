#include "liveplay/core/show_backups.hpp"

#ifdef NDEBUG
#undef NDEBUG
#endif
#include <algorithm>
#include <cassert>
#include <chrono>
#include <cstdint>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <set>
#include <string>
#include <string_view>
#include <system_error>
#include <vector>

namespace {

namespace fs = std::filesystem;
namespace backups = liveplay::core::show_backups;
using backups::BackupOutcome;
using backups::BackupStamp;
using backups::BackupTiming;

struct TemporaryTree {
    fs::path path;
    ~TemporaryTree() {
        std::error_code error;
        fs::remove_all(path, error);
    }
};

void write_text(const fs::path& path, std::string_view contents) {
    fs::create_directories(path.parent_path());
    std::ofstream output{path, std::ios::binary | std::ios::trunc};
    assert(output);
    output.write(contents.data(), static_cast<std::streamsize>(contents.size()));
    output.close();
    assert(output.good());
}

std::string read_text(const fs::path& path) {
    std::ifstream input{path, std::ios::binary};
    assert(input);
    return std::string{std::istreambuf_iterator<char>{input},
                       std::istreambuf_iterator<char>{}};
}

std::set<std::string> file_names(const fs::path& folder) {
    std::set<std::string> names;
    std::error_code error;
    for (fs::directory_iterator it{folder, error}, end; !error && it != end; it.increment(error))
        names.insert(it->path().filename().string());
    return names;
}

std::vector<std::string> names_of(const std::vector<backups::BackupEntry>& entries) {
    std::vector<std::string> names;
    for (const auto& entry : entries) names.push_back(entry.name);
    return names;
}

// Midday in mid-July: far from any daylight-saving change in every zone.
std::time_t fixed_now() {
    const auto epoch = backups::stamp_to_epoch_seconds(BackupStamp{2026, 7, 15, 12, 0, 0});
    assert(epoch);
    return static_cast<std::time_t>(*epoch);
}

std::string name_at(std::string_view stem, std::time_t time) {
    return backups::backup_file_name(stem, backups::local_stamp(time));
}

void test_naming() {
    const BackupStamp stamp{2026, 11, 16, 9, 5, 7};
    assert(backups::format_stamp(stamp) == "2026-11-16 09.05.07");
    assert(backups::parse_stamp("2026-11-16 09.05.07") == stamp);
    assert(backups::backup_file_name("My Show", stamp) ==
           "My Show 2026-11-16 09.05.07.dwcue");

    // Everything the engine appends to the stem is legal on Windows, macOS
    // and Linux: no reserved character, no trailing dot or space.
    const std::string appended = backups::backup_file_name("", stamp);
    assert(appended.find_first_of("<>:\"/\\|?*") == std::string::npos);
    assert(appended.back() != '.' && appended.back() != ' ');

    // Local time round-trips through the name.
    const std::time_t now = fixed_now();
    assert(backups::local_stamp(now) == (BackupStamp{2026, 7, 15, 12, 0, 0}));
    assert(backups::stamp_to_epoch_seconds(backups::local_stamp(now + 61)) ==
           static_cast<std::int64_t>(now) + 61);

    // Names sort the way time runs.
    assert((BackupStamp{2026, 11, 16, 9, 5, 7}) < (BackupStamp{2026, 11, 16, 9, 5, 8}));
    assert((BackupStamp{2026, 11, 16, 23, 59, 59}) < (BackupStamp{2026, 11, 17, 0, 0, 0}));
    assert((BackupStamp{2025, 12, 31, 23, 59, 59}) < (BackupStamp{2026, 1, 1, 0, 0, 0}));

    for (const std::string_view bad : {
             "", "2026-11-16 09.05", "2026-11-16T09.05.07", "2026-11-16 09:05:07",
             "2026/11/16 09.05.07", "2026-13-16 09.05.07", "2026-00-16 09.05.07",
             "2026-11-32 09.05.07", "2026-11-00 09.05.07", "2026-11-16 24.05.07",
             "2026-11-16 09.60.07", "2026-11-16 09.05.61", "2O26-11-16 09.05.07",
             "2026-11-16 09.05.07 ", " 2026-11-16 09.05.07", "-026-11-16 09.05.07"}) {
        assert(!backups::parse_stamp(bad));
    }

    assert(backups::is_backup_folder_name("Backups"));
    assert(backups::is_backup_folder_name("backups"));
    assert(backups::is_backup_folder_name("BACKUPS"));
    assert(!backups::is_backup_folder_name("Backup"));
    assert(!backups::is_backup_folder_name("Backups "));
    assert(!backups::is_backup_folder_name("My Backups"));
}

void test_pattern_matches_only_this_show() {
    const auto parsed = backups::parse_backup_file_name("My Show 2026-11-16 09.05.07.dwcue");
    assert(parsed && parsed->stem == "My Show");
    assert(parsed->stamp == (BackupStamp{2026, 11, 16, 9, 5, 7}));

    assert(backups::is_backup_file_name_for("Show 2026-11-16 09.05.07.dwcue", "Show"));
    assert(backups::is_backup_file_name_for("Sh\xC3\xB6w 2026-11-16 09.05.07.dwcue", "Sh\xC3\xB6w"));
    assert(backups::is_backup_file_name_for("Show.v2 2026-11-16 09.05.07.dwcue", "Show.v2"));

    for (const std::string_view other : {
             "Show 2 2026-11-16 09.05.07.dwcue",          // a different show
             "Other 2026-11-16 09.05.07.dwcue",
             "show 2026-11-16 09.05.07.dwcue",            // byte comparison is exact
             "Show  2026-11-16 09.05.07.dwcue",           // stem "Show " is not "Show"
             "Show 2026-11-16 09.05.07 2026-11-17 10.00.00.dwcue",  // backup of a backup
             "Show_backup_2026-11-16_09-05.dwcue",        // the retired 10-minute backup's name
             "Show 2026-11-16 09.05.dwcue",
             "Show 2026-11-16 09.05.07.DWCUE",
             "Show 2026-11-16 09.05.07.dwcue.tmp",
             "Show 2026-11-16 09.05.07.liveplay",
             "Show 2026-11-16 09.05.07",
             "Show2026-11-16 09.05.07.dwcue",
             "Show.dwcue",
             " 2026-11-16 09.05.07.dwcue",                // no stem at all
             ".dwcue-backup.part",                        // the staging file
             "notes.txt"}) {
        assert(!backups::is_backup_file_name_for(other, "Show"));
    }
    assert(!backups::parse_backup_file_name(" 2026-11-16 09.05.07.dwcue"));
    assert(!backups::parse_backup_file_name("2026-11-16 09.05.07.dwcue"));
}

void test_hostile_restore_names() {
    using namespace std::string_literals;
    const std::string good = "Show 2026-11-16 09.05.07.dwcue";
    assert(backups::is_backup_file_name_for(good, "Show"));

    const std::vector<std::string> hostile = {
        "",
        ".",
        "..",
        "../" + good,
        "..\\" + good,
        "../../etc/passwd",
        "/" + good,
        "/etc/" + good,
        "\\" + good,
        "\\\\server\\share\\" + good,
        "C:\\shows\\" + good,
        "C:/shows/" + good,
        "Backups/" + good,
        "Backups\\" + good,
        "./" + good,
        good + "/..",
        good + "/",
        good + "\\",
        "Show/../" + good,
        "Show 2026-11-16 09.05.07.dwcue\0.txt"s,
        "Show\0 2026-11-16 09.05.07.dwcue"s,
        "Show\n 2026-11-16 09.05.07.dwcue",
        "Show\t2026-11-16 09.05.07.dwcue",
        "Show 2026-11-16 09:05:07.dwcue",
        "Show 2026-13-40 99.99.99.dwcue",
        "Show 2026-11-16 09.05.07.dwcue ",
        "Show 2026-11-16 09.05.07.dwcue.",
        "Show 2026-11-16 09.05.07.exe",
    };
    for (const auto& name : hostile) {
        assert(!backups::parse_backup_file_name(name));
        assert(!backups::is_backup_file_name_for(name, "Show"));
    }
    // A drive-relative spelling parses only as a backup of some other show.
    assert(!backups::is_backup_file_name_for("C:" + good, "Show"));
}

void test_selection_and_pruning() {
    std::vector<std::string> names;
    for (int minute = 0; minute < 14; ++minute)
        names.push_back(backups::backup_file_name("Show", BackupStamp{2026, 11, 16, 10, minute, 0}));
    const std::vector<std::string> foreign = {
        backups::backup_file_name("Other", BackupStamp{2020, 1, 1, 0, 0, 0}),
        backups::backup_file_name("Show 2", BackupStamp{2020, 1, 1, 0, 0, 0}),
        backups::backup_file_name("show", BackupStamp{2020, 1, 1, 0, 0, 0}),
        "Show_backup_2020-01-01_00-00.dwcue",
        "Show.dwcue",
        "notes.txt",
        ".dwcue-backup.part",
    };
    names.insert(names.end(), foreign.begin(), foreign.end());
    std::rotate(names.begin(), names.begin() + 5, names.end());  // folder order is arbitrary

    const auto mine = backups::show_backups_newest_first(names, "Show");
    assert(mine.size() == 14);
    for (std::size_t i = 0; i < mine.size(); ++i) {
        assert(mine[i].stamp == (BackupStamp{2026, 11, 16, 10, 13 - static_cast<int>(i), 0}));
        assert(mine[i].saved_at_ms > 0);
    }

    const auto stale = backups::backups_to_prune(mine);
    assert(backups::kMaxBackupsPerShow == 10);
    assert(stale.size() == 4);
    for (const auto& entry : stale) {
        assert(backups::is_backup_file_name_for(entry.name, "Show"));
        assert(entry.stamp < (BackupStamp{2026, 11, 16, 10, 4, 0}));
        assert(std::find(foreign.begin(), foreign.end(), entry.name) == foreign.end());
    }
    assert(backups::backups_to_prune(backups::show_backups_newest_first(names, "Other")).empty());
    assert(backups::backups_to_prune(mine, 14).empty());
    assert(backups::backups_to_prune(mine, 0).size() == 14);

    // The caller may accept a differently spelled stem for the same file.
    const auto either_case = backups::show_backups_newest_first(
        names, "Show", [](std::string_view stem) { return stem == "show"; });
    assert(either_case.size() == 15);
    assert(either_case.back().name == foreign[2]);
}

void test_five_minute_rule() {
    BackupTiming timing;
    assert(backups::kMinBackupIntervalSeconds == 300);
    assert(backups::backup_is_due(timing));  // no backup yet

    timing.has_previous = true;
    timing.seconds_since_newest = 0;
    assert(!backups::backup_is_due(timing));
    timing.seconds_since_newest = 299;
    assert(!backups::backup_is_due(timing));
    timing.seconds_since_newest = 300;
    assert(backups::backup_is_due(timing));
    timing.seconds_since_newest = 86'400;
    assert(backups::backup_is_due(timing));

    // The first save after an open, and a restore's undo copy, ignore the interval.
    timing.seconds_since_newest = 5;
    timing.first_save_since_open = true;
    assert(backups::backup_is_due(timing));
    timing.first_save_since_open = false;
    timing.force = true;
    assert(backups::backup_is_due(timing));
    timing.force = false;
    assert(!backups::backup_is_due(timing));

    // A wall clock that jumped back does not block backups, and the engine's
    // own monotonic record keeps autosaves from flushing the history.
    timing.seconds_since_newest = -3'600;
    assert(backups::backup_is_due(timing));
    timing.seconds_since_last_made = 10;
    assert(!backups::backup_is_due(timing));
    timing.seconds_since_last_made = 300;
    assert(backups::backup_is_due(timing));
    timing.seconds_since_newest.reset();  // unreadable stamp
    timing.seconds_since_last_made.reset();
    assert(backups::backup_is_due(timing));

    // An unlistable folder still gets at most one copy per interval.
    BackupTiming unlistable;
    unlistable.seconds_since_last_made = 60;
    assert(!backups::backup_is_due(unlistable));
}

void test_backup_on_disk(const fs::path& base) {
    const fs::path folder = base / "show-folder";
    const fs::path show = folder / "Show.dwcue";
    const fs::path history = folder / "Backups";
    const std::time_t now = fixed_now();
    BackupTiming first;
    first.first_save_since_open = true;
    const BackupTiming later;

    // Nothing on disk yet, a relative path, or a foreign file: quietly nothing.
    fs::create_directories(folder);
    assert(backups::backup_before_overwrite(show, first, now).outcome == BackupOutcome::NothingToBackUp);
    assert(backups::backup_before_overwrite("Show.dwcue", first, now).outcome == BackupOutcome::NothingToBackUp);
    assert(backups::backup_before_overwrite({}, first, now).outcome == BackupOutcome::NothingToBackUp);
    write_text(folder / "Show.liveplay", "legacy");
    assert(backups::backup_before_overwrite(folder / "Show.liveplay", first, now).outcome ==
           BackupOutcome::NothingToBackUp);
    assert(!fs::exists(history));
    assert(backups::list_backups(show).empty());
    assert(backups::backup_folder_for(show) == history);

    // The first save after an open keeps the show as it was opened.
    write_text(show, "version-1");
    const auto opened = backups::backup_before_overwrite(show, first, now);
    assert(opened.outcome == BackupOutcome::Created);
    assert(opened.name == name_at("Show", now));
    assert(opened.name == "Show 2026-07-15 12.00.00.dwcue");
    assert(read_text(history / opened.name) == "version-1");
    assert(read_text(show) == "version-1");
    assert(file_names(history) == (std::set<std::string>{opened.name}));

    // Autosaves inside five minutes add nothing, changed content or not.
    write_text(show, "version-2");
    assert(backups::backup_before_overwrite(show, later, now + 1).outcome == BackupOutcome::SkippedRecent);
    assert(backups::backup_before_overwrite(show, later, now + 299).outcome == BackupOutcome::SkippedRecent);
    assert(file_names(history).size() == 1);

    // Five minutes on, the changed file is copied.
    const auto second = backups::backup_before_overwrite(show, later, now + 300);
    assert(second.outcome == BackupOutcome::Created);
    assert(second.name == name_at("Show", now + 300));
    assert(read_text(history / second.name) == "version-2");

    // Identical to the newest backup: never copied again, not even on the
    // first save after an open or for a restore's undo copy.
    assert(backups::backup_before_overwrite(show, later, now + 4'000).outcome == BackupOutcome::SkippedIdentical);
    const auto reopened = backups::backup_before_overwrite(show, first, now + 4'000);
    assert(reopened.outcome == BackupOutcome::SkippedIdentical && reopened.name == second.name);
    BackupTiming forced;
    forced.force = true;
    const auto undo_same = backups::backup_before_overwrite(show, forced, now + 4'000);
    assert(undo_same.outcome == BackupOutcome::SkippedIdentical && undo_same.name == second.name);
    assert(file_names(history).size() == 2);

    // A restore's undo copy ignores the interval, and a copy made in the same
    // second as another takes the next free name instead of replacing it.
    write_text(show, "version-3");
    const auto undo = backups::backup_before_overwrite(show, forced, now + 300);
    assert(undo.outcome == BackupOutcome::Created);
    assert(undo.name == name_at("Show", now + 301));
    assert(read_text(history / second.name) == "version-2");
    assert(read_text(history / undo.name) == "version-3");

    const auto listed = backups::list_backups(show);
    assert(names_of(listed) == (std::vector<std::string>{undo.name, second.name, opened.name}));
    assert(listed[0].size == 9 && listed[0].path == history / undo.name);
    assert(listed[0].saved_at_ms == (static_cast<std::int64_t>(now) + 301) * 1000);
    assert(listed[2].saved_at_ms == static_cast<std::int64_t>(now) * 1000);

    assert(backups::files_identical(show, history / undo.name));
    assert(!backups::files_identical(show, history / second.name));
    assert(!backups::files_identical(show, folder / "missing.dwcue"));

    // No staging file is left behind, and the show file is untouched.
    for (const auto& name : file_names(history))
        assert(backups::is_backup_file_name_for(name, "Show"));
    assert(read_text(show) == "version-3");

    // A stem spelled differently belongs to this show only when the file
    // system itself says it names the same show file (letter case on Windows
    // and macOS, Unicode normalisation on HFS+ and some network shares).
    const std::string other_spelling = name_at("show", now + 20'000);
    write_text(history / other_spelling, "other-spelling");
    std::error_code same_error;
    const bool same_file = fs::equivalent(folder / "show.dwcue", show, same_error) && !same_error;
    const auto spelled = names_of(backups::list_backups(show));
    assert((std::find(spelled.begin(), spelled.end(), other_spelling) != spelled.end()) == same_file);
    assert(spelled.size() == (same_file ? 4u : 3u));
    fs::remove(history / other_spelling);

    // A link that looks like a backup is not a backup.
    std::error_code link_error;
    const std::string link_name = name_at("Show", now + 9'000);
    fs::create_symlink(folder / "Show.liveplay", history / link_name, link_error);
    if (!link_error) {
        assert(names_of(backups::list_backups(show)) ==
               (std::vector<std::string>{undo.name, second.name, opened.name}));
        fs::remove(history / link_name);
    }

    // A backup opened directly as a show does not start Backups/Backups.
    assert(!backups::is_backup_eligible(history / undo.name));
    assert(backups::backup_before_overwrite(history / undo.name, first, now).outcome ==
           BackupOutcome::NothingToBackUp);
    assert(!fs::exists(history / "Backups"));
    assert(backups::is_backup_eligible(show));
    assert(backups::is_backup_eligible(history / "Show.dwcue"));
    assert(!backups::is_backup_eligible("relative/Show.dwcue"));
    assert(!backups::is_backup_eligible(folder / "Show.liveplay"));
}

void test_pruning_on_disk(const fs::path& base) {
    const fs::path folder = base / "prune-folder";
    const fs::path show = folder / "Show.dwcue";
    const fs::path history = folder / "Backups";
    const std::time_t now = fixed_now();

    // Twelve old backups of this show, plus things that are not ours to touch.
    std::vector<std::string> old_names;
    for (int day = 1; day <= 12; ++day) {
        old_names.push_back(backups::backup_file_name("Show", BackupStamp{2026, 1, day, 8, 0, 0}));
        write_text(history / old_names.back(), "old-" + std::to_string(day));
    }
    const std::vector<std::string> untouchable = {
        backups::backup_file_name("Other", BackupStamp{2019, 1, 1, 8, 0, 0}),
        backups::backup_file_name("Show 2", BackupStamp{2019, 1, 1, 8, 0, 0}),
        "Show_backup_2019-01-01_08-00.dwcue",
        "Show 2019-01-01 08.00.dwcue",
        "Show.dwcue",
        "notes.txt",
    };
    for (const auto& name : untouchable) write_text(history / name, "keep:" + name);
    write_text(history / "nested" / old_names.front(), "nested-keep");

    write_text(show, "current");
    const auto made = backups::backup_before_overwrite(show, BackupTiming{}, now);
    assert(made.outcome == BackupOutcome::Created);
    assert(made.pruned == 3 && made.detail.empty());

    const auto kept = backups::list_backups(show);
    assert(kept.size() == backups::kMaxBackupsPerShow);
    assert(kept.front().name == made.name);
    // The three oldest are gone, the nine newest old ones remain.
    for (int day = 1; day <= 12; ++day) {
        const bool exists = fs::exists(history / old_names[static_cast<std::size_t>(day - 1)]);
        assert(exists == (day > 3));
    }
    for (const auto& name : untouchable) assert(read_text(history / name) == "keep:" + name);
    assert(read_text(history / "nested" / old_names.front()) == "nested-keep");

    // Already at ten: a skipped backup deletes nothing.
    assert(backups::backup_before_overwrite(show, BackupTiming{}, now + 5).outcome ==
           BackupOutcome::SkippedRecent);
    assert(backups::list_backups(show).size() == backups::kMaxBackupsPerShow);

    // A clock set back in time: the copy just made is still kept.
    write_text(show, "after-clock-change");
    BackupTiming forced;
    forced.force = true;
    const std::time_t long_ago = static_cast<std::time_t>(
        *backups::stamp_to_epoch_seconds(BackupStamp{2025, 7, 15, 12, 0, 0}));
    const auto backdated = backups::backup_before_overwrite(show, forced, long_ago);
    assert(backdated.outcome == BackupOutcome::Created);
    assert(read_text(history / backdated.name) == "after-clock-change");
}

void test_failure_is_contained(const fs::path& base) {
    const fs::path folder = base / "blocked-folder";
    const fs::path show = folder / "Show.dwcue";
    write_text(show, "precious");
    // "Backups" exists but is a file: the folder cannot be created.
    write_text(folder / "Backups", "not a folder");
    BackupTiming first;
    first.first_save_since_open = true;
    const auto blocked = backups::backup_before_overwrite(show, first, fixed_now());
    assert(blocked.outcome == BackupOutcome::Failed);
    assert(!blocked.detail.empty() && blocked.name.empty());
    assert(read_text(show) == "precious");
    assert(read_text(folder / "Backups") == "not a folder");
    assert(backups::list_backups(show).empty());

    // The show is a directory: there is no file to copy, and nothing happens.
    const fs::path odd = base / "odd-folder" / "Folder.dwcue";
    fs::create_directories(odd);
    assert(backups::backup_before_overwrite(odd, first, fixed_now()).outcome ==
           BackupOutcome::NothingToBackUp);
    assert(!fs::exists(odd.parent_path() / "Backups"));
}

} // namespace

int main() {
    const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
    TemporaryTree temporary{
        fs::temp_directory_path() / ("dwcue-show-backups-" + std::to_string(nonce))};
    fs::create_directories(temporary.path);
    // The engine only ever passes absolute paths.
    const fs::path base = fs::canonical(temporary.path);

    test_naming();
    test_pattern_matches_only_this_show();
    test_hostile_restore_names();
    test_selection_and_pruning();
    test_five_minute_rule();
    test_backup_on_disk(base);
    test_pruning_on_disk(base);
    test_failure_is_contained(base);
}
