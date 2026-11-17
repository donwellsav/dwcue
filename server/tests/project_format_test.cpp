#include "liveplay/core/project_file.hpp"
#include "liveplay/net/control_security.hpp"
#include "liveplay/net/project_archive.hpp"
#include "liveplay/util/atomic_file.hpp"
#include "liveplay/util/unicode_path.hpp"

#include <miniz.h>
#include <nlohmann/json.hpp>

#ifdef NDEBUG
#undef NDEBUG
#endif
#include <algorithm>
#include <cassert>
#include <cctype>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <initializer_list>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

namespace {

namespace fs = std::filesystem;
namespace project_file = liveplay::core::project_file;
namespace project_archive = liveplay::net::project_archive;
using json = nlohmann::json;

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

json client_document(std::string name, const fs::path& folder) {
    return json{
        {"name", std::move(name)},
        {"version", "2.0.0"},
        {"folderPath", liveplay::util::path_to_utf8(folder)},
        {"items", json::array()},
        {"quickPlaySlots", json::array()},
        {"quickPlaySlotKeys", json::object()},
        {"playbackKeys", json::object()},
        {"quickPlayItems", json::array()},
        {"theme", json{{"mode", "dark"}, {"accentColor", "#315FCF"}}},
        {"settings", json::object()},
        {"createdAt", "2026-01-01T00:00:00.000Z"},
        {"lastModified", "2026-01-01T00:00:00.000Z"},
    };
}

void create_zip(
    const fs::path& path,
    std::initializer_list<std::pair<std::string_view, std::string_view>> entries) {
    mz_zip_archive archive{};
    const std::string path_utf8 = liveplay::util::path_to_utf8(path);
    assert(mz_zip_writer_init_file(&archive, path_utf8.c_str(), 0));
    for (const auto& [name, contents] : entries) {
        const std::string entry_name{name};
        assert(mz_zip_writer_add_mem(
            &archive, entry_name.c_str(), contents.data(), contents.size(),
            MZ_DEFAULT_LEVEL));
    }
    assert(mz_zip_writer_finalize_archive(&archive));
    assert(mz_zip_writer_end(&archive));
}

void test_atomic_no_replace_contract(const fs::path& base) {
    const fs::path root = base / "atomic-no-replace";
    fs::create_directories(root);

    const fs::path source_file = root / "source-file";
    const fs::path target_file = root / "target-file";
    write_text(source_file, "source");
    write_text(target_file, "target");
    std::error_code error;
    assert(!liveplay::util::rename_no_replace(
        source_file, target_file, error));
    assert(error == std::errc::file_exists);
    assert(read_text(source_file) == "source");
    assert(read_text(target_file) == "target");

    const fs::path source_directory = root / "source-directory";
    const fs::path target_directory = root / "target-directory";
    write_text(source_directory / "source-marker", "source-directory");
    fs::create_directory(target_directory);
    error.clear();
    assert(!liveplay::util::rename_no_replace(
        source_directory, target_directory, error));
    assert(error == std::errc::file_exists);
    assert(read_text(source_directory / "source-marker") ==
           "source-directory");
    assert(fs::is_empty(target_directory));

    const fs::path published_file = root / "published-file";
    error.clear();
    assert(liveplay::util::rename_no_replace(
        source_file, published_file, error));
    assert(!error);
    assert(!fs::exists(source_file));
    assert(read_text(published_file) == "source");

    const fs::path published_directory = root / "published-directory";
    error.clear();
    assert(liveplay::util::rename_no_replace(
        source_directory, published_directory, error));
    assert(!error);
    assert(!fs::exists(source_directory));
    assert(read_text(published_directory / "source-marker") ==
           "source-directory");
}

void test_native_project_creation(const fs::path& base) {
    assert(project_file::is_native_project("show.dwcue"));
    assert(project_file::is_native_project("show.DWCUE"));
    assert(!project_file::is_native_project("show.liveplay"));
    assert(project_file::is_native_archive("show.DWCUEPACK"));
    assert(!project_file::is_native_archive("show.LPA"));
    assert(!project_file::is_native_archive("show.zip"));

    const fs::path project_folder = base / "direct";
    fs::create_directories(project_folder);
    json document = client_document("Native", base / "stale-folder");
    document["items"] = json::array({
        json{{"uuid", "duplicate"}, {"type", "audio"},
             {"displayName", "First"}, {"mediaPath", "media/a.wav"}},
        json{{"uuid", "duplicate"}, {"type", "audio"},
             {"displayName", "Second"}, {"mediaPath", "media/b.wav"}},
    });
    project_file::PreparedDocument prepared;
    std::string error;
    assert(project_file::prepare_client_document(document, project_folder, prepared, error));
    assert(prepared.repair.repaired);
    assert(prepared.document["items"].size() == 1);
    assert(prepared.document["folderPath"] ==
           liveplay::util::path_to_utf8(project_folder));

    const auto path = project_folder / "Show.dwcue";
    std::error_code write_error;
    assert(project_file::write_new_canonical_project(path, prepared.document, write_error));
    const std::string canonical_bytes = read_text(path);
    assert(!project_file::write_new_canonical_project(
        path, json{{"name", "replacement"}}, write_error));
    assert(write_error == std::errc::file_exists);
    assert(read_text(path) == canonical_bytes);

    const std::string bounded =
        liveplay::net::security::canonical_archive_download_filename(
            std::string(255, 'x'));
    assert(bounded.size() <= 200);
    assert(bounded.ends_with(".dwcuepack"));
}

void test_native_archive_round_trip(const fs::path& base) {
    const fs::path project_folder = base / "native-source";
    const fs::path active = project_folder / "Current.dwcue";
    const std::string active_bytes =
        client_document("Current", project_folder).dump(2);
    write_text(active, active_bytes);
    write_text(project_folder / "Other.dwcue", "other-native");
    write_text(project_folder / "Old.liveplay", "other-legacy");
    write_text(project_folder / "media" / "song.wav", "media-bytes");
    write_text(project_folder / "notes.txt", "notes");
    write_text(project_folder / "old-versions" / "Old.liveplay", "nested-legacy");
    // The show's local backup history stays out of the archive, whatever the
    // folder's letter case; only the folder beside the show is special.
    write_text(project_folder / "Backups" / "Current 2026-01-02 03.04.05.dwcue",
               "automatic-backup");
    write_text(project_folder / "Backups" / "Current_backup_2026-01-02_03-04.dwcue",
               "periodic-backup");
    write_text(project_folder / "Backups" / "nested" / "notes.txt", "backup-notes");
    write_text(project_folder / "media" / "Backups" / "stem.wav", "media-named-backups");

    const fs::path archive = base / "Current.dwcuepack";
    const auto exported =
        project_archive::export_project(project_folder, active, archive);
    assert(exported.ok);
    const std::string archive_bytes = read_text(archive);

    const fs::path destination = base / "native-import";
    fs::create_directory(destination);
    const auto imported =
        project_archive::import_project(archive, "Current.DWCUEPACK", destination);
    assert(imported.ok);
    assert(imported.project_file == destination / "Current.dwcue");
    assert(read_text(imported.project_file) == active_bytes);
    assert(!fs::exists(destination / "Other.dwcue"));
    assert(!fs::exists(destination / "Old.liveplay"));
    assert(read_text(destination / "media" / "song.wav") == "media-bytes");
    assert(read_text(destination / "notes.txt") == "notes");
    assert(read_text(destination / "old-versions" / "Old.liveplay") ==
           "nested-legacy");
    assert(!fs::exists(destination / "Backups"));
    assert(!fs::exists(destination / "backups"));
    assert(read_text(destination / "media" / "Backups" / "stem.wav") ==
           "media-named-backups");
    assert(read_text(archive) == archive_bytes);

    const fs::path collision = base / "non-empty-target";
    write_text(collision / "keep.txt", "keep");
    const auto collided =
        project_archive::import_project(archive, archive.filename(), collision);
    assert(!collided.ok && collided.status == 409);
    assert(read_text(collision / "keep.txt") == "keep");
    assert(read_text(archive) == archive_bytes);
}

void test_archive_format_boundaries(const fs::path& base) {
    const fs::path legacy_archive = base / "Legacy.LPA";
    const std::string legacy_json =
        client_document("Legacy archive", base / "old-location").dump(2);
    create_zip(legacy_archive, {
        {"Legacy.LIVEPLAY", legacy_json},
        {"media/song.wav", "legacy-media"},
    });
    const std::string legacy_archive_bytes = read_text(legacy_archive);
    const fs::path legacy_destination = base / "legacy-import";
    const auto legacy_imported = project_archive::import_project(
        legacy_archive, legacy_archive.filename(), legacy_destination);
    assert(!legacy_imported.ok && legacy_imported.status == 400);
    assert(!fs::exists(legacy_destination));
    const auto renamed = project_archive::import_project(
        legacy_archive, "Legacy.dwcuepack", legacy_destination);
    assert(!renamed.ok && renamed.status == 400);
    assert(!fs::exists(legacy_destination));
    assert(read_text(legacy_archive) == legacy_archive_bytes);

    const fs::path uppercase_archive = base / "Upper.dwcuepack";
    create_zip(uppercase_archive, {
        {"Upper.DWCUE", client_document("Upper", base).dump()},
    });
    const fs::path uppercase_destination = base / "uppercase-import";
    const auto uppercase_imported = project_archive::import_project(
        uppercase_archive, "Upper.DWCUEPACK", uppercase_destination);
    assert(uppercase_imported.ok);
    assert(uppercase_imported.project_file ==
           uppercase_destination / "Upper.dwcue");

    const fs::path ambiguous = base / "ambiguous.dwcuepack";
    create_zip(ambiguous, {
        {"One.dwcue", client_document("One", base).dump()},
        {"Two.DWCUE", client_document("Two", base).dump()},
    });
    const fs::path ambiguous_destination = base / "ambiguous-target";
    const auto ambiguous_result = project_archive::import_project(
        ambiguous, ambiguous.filename(), ambiguous_destination);
    assert(!ambiguous_result.ok && ambiguous_result.status == 400);
    assert(!fs::exists(ambiguous_destination));

    const fs::path mixed = base / "mixed.dwcuepack";
    create_zip(mixed, {
        {"One.dwcue", client_document("One", base).dump()},
        {"Old.liveplay", client_document("Old", base).dump()},
    });
    const auto mixed_result = project_archive::import_project(
        mixed, mixed.filename(), base / "mixed-target");
    assert(!mixed_result.ok && mixed_result.status == 400);
    assert(!fs::exists(base / "mixed-target"));

    const fs::path no_root = base / "no-root.dwcuepack";
    create_zip(no_root, {{"media/song.wav", "only-media"}});
    const auto no_root_result = project_archive::import_project(
        no_root, no_root.filename(), base / "no-root-target");
    assert(!no_root_result.ok && no_root_result.status == 400);
    assert(!fs::exists(base / "no-root-target"));

}

void test_archive_traversal_rejected(const fs::path& base) {
    const fs::path archive = base / "traversal.dwcuepack";
    create_zip(archive, {
        {"Show.dwcue", client_document("Show", base).dump()},
        {"../escaped.txt", "escape"},
    });
    const std::string source_bytes = read_text(archive);
    const fs::path destination = base / "traversal-target";
    const auto result = project_archive::import_project(
        archive, archive.filename(), destination);
    assert(!result.ok && result.status == 400);
    assert(!fs::exists(destination));
    assert(!fs::exists(base / "escaped.txt"));
    assert(read_text(archive) == source_bytes);
}

// The field names a show uses. Shows saved before the QuickPlay rename use
// kOldNames; everything prepared, served and saved uses kNewNames.
struct QuickPlayNames {
    const char* quick_play_items;
    const char* slots;
    const char* slot_keys;
    const char* slot_count;
    const char* item_settings;
};
constexpr QuickPlayNames kOldNames{"cartOnlyItems", "cartItems", "cartSlotKeys",
                                   "cartSlotCount", "oneShot"};
constexpr QuickPlayNames kNewNames{"quickPlayItems", "quickPlaySlots", "quickPlaySlotKeys",
                                   "quickPlaySlotCount", "quickPlay"};

// True when any object key, at any depth, still says "cart" or "oneShot".
bool has_old_name(const json& value) {
    if (value.is_object()) {
        for (const auto& [key, child] : value.items()) {
            std::string lower = key;
            std::transform(lower.begin(), lower.end(), lower.begin(),
                           [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
            if (lower.find("cart") != std::string::npos ||
                lower.find("oneshot") != std::string::npos) {
                return true;
            }
            if (has_old_name(child)) return true;
        }
    } else if (value.is_array()) {
        for (const auto& child : value)
            if (has_old_name(child)) return true;
    }
    return false;
}

json audio_item(std::string uuid) {
    return json{{"uuid", std::move(uuid)}, {"type", "audio"},
                {"displayName", "Cue"}, {"mediaPath", "media/cue.wav"}};
}

// One show using every renamed field: a QuickPlay item, a slot assignment
// with its key, the settings slot count, and a playlist cue inside a group
// that carries QuickPlay settings.
json show_with_quick_plays(const QuickPlayNames& names, const fs::path& folder) {
    auto pad = audio_item("pad");
    pad[names.item_settings] = json{{"order", 0}, {"retrigger", "restart"}};
    auto linked = audio_item("linked");
    linked[names.item_settings] = json{{"order", 2}, {"retrigger", "ignore"}};

    json document = client_document("Quick plays", folder);
    for (const char* current : {"quickPlaySlots", "quickPlaySlotKeys", "quickPlayItems"})
        document.erase(current);
    document["items"] = json::array({
        json{{"uuid", "set"}, {"type", "group"}, {"displayName", "Set"},
             {"children", json::array({audio_item("plain"), std::move(linked)})}},
    });
    document[names.quick_play_items] = json::array({std::move(pad)});
    document[names.slots] = json::array({
        json{{"slot", 1}, {"itemUuid", "plain"}, {"index", json::array({-1, 1})}},
    });
    document[names.slot_keys] = json{
        {"1", json{{"key", "F2"}, {"ctrlKey", false}, {"shiftKey", false}, {"altKey", false}}},
    };
    document["settings"] = json{{names.slot_count, 24}};
    return document;
}

const json* quick_play_item(const json& document, std::string_view uuid) {
    for (const auto& item : document["quickPlayItems"])
        if (item.value("uuid", std::string{}) == uuid) return &item;
    return nullptr;
}

void test_legacy_quick_play_names(const fs::path& base) {
    // A document is still recognised as a show when an old name is the only
    // thing that identifies it, and equally under the current names.
    for (const char* name : {"cartItems", "cartOnlyItems", "quickPlaySlots", "quickPlayItems"})
        assert(project_file::is_client_document(json{{name, json::array()}}));
    for (const char* name : {"cartSlotKeys", "quickPlaySlotKeys"})
        assert(project_file::is_client_document(json{{name, json::object()}}));
    assert(!project_file::is_client_document(json{{"schema_version", 2}}));

    const fs::path folder = base / "legacy-names";
    fs::create_directories(folder);
    const json old_show = show_with_quick_plays(kOldNames, folder);
    assert(has_old_name(old_show));
    assert(!has_old_name(show_with_quick_plays(kNewNames, folder)));

    project_file::PreparedDocument prepared;
    std::string error;
    assert(project_file::prepare_client_document(old_show, folder, prepared, error));
    assert(!has_old_name(prepared.document));
    assert(prepared.quick_play_migrated);

    // Nothing is lost: the QuickPlay item, the slot assignment with its key,
    // the slot count and the group cue's settings are all still there.
    const json& document = prepared.document;
    assert(document["settings"]["quickPlaySlotCount"] == 24);
    assert(document["quickPlayItems"].size() == 3);
    const auto* pad = quick_play_item(document, "pad");
    assert(pad && (*pad)["quickPlay"] == (json{{"order", 0}, {"retrigger", "restart"}}));
    const auto* slot = quick_play_item(document, "plain-one-shot");
    assert(slot && (*slot)["quickPlay"]["order"] == 1);
    assert((*slot)["quickPlay"]["sourceUuid"] == "plain");
    assert((*slot)["quickPlay"]["hotkey"]["key"] == "F2");
    const auto* linked = quick_play_item(document, "linked-one-shot");
    assert(linked && (*linked)["quickPlay"]["order"] == 2);
    assert((*linked)["quickPlay"]["retrigger"] == "ignore");
    assert((*linked)["quickPlay"]["sourceUuid"] == "linked");
    assert(document["quickPlaySlots"].empty());
    assert(document["quickPlaySlotKeys"].empty());
    assert(document["items"][0]["children"].size() == 2);
    assert(!document["items"][0]["children"][1].contains("quickPlay"));

    // The same show written with the current names prepares to the same document.
    project_file::PreparedDocument current;
    assert(project_file::prepare_client_document(
        show_with_quick_plays(kNewNames, folder), folder, current, error));
    assert(current.document == prepared.document);

    // What is written to disk has only the current names.
    const fs::path path = folder / "Converted.dwcue";
    std::error_code write_error;
    assert(project_file::write_new_canonical_project(path, prepared.document, write_error));
    const json saved = json::parse(read_text(path));
    assert(saved == prepared.document);
    assert(!has_old_name(saved));

    // An archive made by an older version still imports.
    const fs::path archive = base / "LegacyNames.dwcuepack";
    create_zip(archive, {{"LegacyNames.dwcue", json{{"cartOnlyItems", json::array()}}.dump()}});
    const auto imported = project_archive::import_project(
        archive, archive.filename(), base / "legacy-names-import");
    assert(imported.ok);
}

} // namespace

int main() {
    const auto nonce =
        std::chrono::steady_clock::now().time_since_epoch().count();
    TemporaryTree temporary{
        fs::temp_directory_path() /
        ("dwcue-project-format-" + std::to_string(nonce))};
    fs::create_directories(temporary.path);

    test_atomic_no_replace_contract(temporary.path);
    test_native_project_creation(temporary.path);
    test_native_archive_round_trip(temporary.path);
    test_archive_format_boundaries(temporary.path);
    test_archive_traversal_rejected(temporary.path);
    test_legacy_quick_play_names(temporary.path);
}
