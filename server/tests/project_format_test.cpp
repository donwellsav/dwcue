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
#include <cassert>
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
        {"cartItems", json::array()},
        {"cartSlotKeys", json::object()},
        {"playbackKeys", json::object()},
        {"cartOnlyItems", json::array()},
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

void test_extensions_and_direct_legacy_conversion(const fs::path& base) {
    assert(project_file::is_native_project("show.dwcue"));
    assert(project_file::is_native_project("show.DWCUE"));
    assert(!project_file::is_native_project("show.liveplay"));
    assert(project_file::is_legacy_project("show.LIVEPLAY"));
    assert(project_file::is_native_archive("show.DWCUEPACK"));
    assert(project_file::is_legacy_archive("show.LPA"));
    assert(!project_file::archive_kind("show.zip"));

    const fs::path project_folder = base / "direct";
    fs::create_directories(project_folder);
    json legacy = client_document("Legacy", base / "stale-folder");
    legacy["lastModified"] = 1'700'000'000;
    legacy["items"] = json::array({
        json{{"uuid", "duplicate"}, {"type", "audio"},
             {"displayName", "First"}, {"mediaPath", "media/a.wav"}},
        json{{"uuid", "duplicate"}, {"type", "audio"},
             {"displayName", "Second"}, {"mediaPath", "media/b.wav"}},
    });
    const fs::path source = project_folder / "Show.LIVEPLAY";
    const std::string source_bytes = legacy.dump(2);
    write_text(source, source_bytes);

    project_file::PreparedDocument prepared;
    std::string error;
    assert(project_file::read_legacy_project(source, prepared, error));
    assert(error.empty());
    assert(prepared.repair.repaired);
    assert(prepared.document["items"].size() == 1);
    assert(prepared.document["folderPath"] ==
           liveplay::util::path_to_utf8(project_folder));
    assert(read_text(source) == source_bytes);

    const fs::path occupied = project_folder / "Show.dwcue";
    write_text(occupied, "do-not-overwrite");
    assert(!project_file::valid_legacy_destination(
        source, occupied, error));
    assert(error == "destinationPath already exists");
    assert(!project_file::valid_legacy_destination(
        source, base / "elsewhere" / "Show.dwcue", error));

    const auto unique = project_file::unique_legacy_destination(source, error);
    assert(unique && unique->filename() == "Show (2).dwcue");
    std::error_code write_error;
    assert(project_file::write_new_canonical_project(
        *unique, prepared.document, write_error));
    const std::string canonical_bytes = read_text(*unique);
    assert(!project_file::write_new_canonical_project(
        *unique, json{{"name", "replacement"}}, write_error));
    assert(write_error == std::errc::file_exists);
    assert(read_text(*unique) == canonical_bytes);
    assert(read_text(source) == source_bytes);

    const fs::path malformed = project_folder / "Broken.liveplay";
    write_text(malformed, "{not-json");
    assert(!project_file::read_legacy_project(malformed, prepared, error));
    assert(!fs::exists(project_folder / "Broken.dwcue"));

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
    write_text(project_folder / "backups" / "Old.liveplay", "nested-backup");

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
    assert(read_text(destination / "backups" / "Old.liveplay") ==
           "nested-backup");
    assert(read_text(archive) == archive_bytes);

    const fs::path collision = base / "non-empty-target";
    write_text(collision / "keep.txt", "keep");
    const auto collided =
        project_archive::import_project(archive, archive.filename(), collision);
    assert(!collided.ok && collided.status == 409);
    assert(read_text(collision / "keep.txt") == "keep");
    assert(read_text(archive) == archive_bytes);
}

void test_legacy_and_rejected_archives(const fs::path& base) {
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
    assert(legacy_imported.ok);
    assert(legacy_imported.project_file ==
           legacy_destination / "Legacy.dwcue");
    assert(!fs::exists(legacy_destination / "Legacy.LIVEPLAY"));
    assert(read_text(legacy_destination / "media" / "song.wav") ==
           "legacy-media");
    const json migrated = json::parse(read_text(legacy_imported.project_file));
    assert(migrated["folderPath"] ==
           liveplay::util::path_to_utf8(legacy_destination));
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

    const fs::path ambiguous_legacy = base / "ambiguous.lpa";
    create_zip(ambiguous_legacy, {
        {"One.liveplay", client_document("One", base).dump()},
        {"Two.liveplay", client_document("Two", base).dump()},
    });
    const auto ambiguous_legacy_result = project_archive::import_project(
        ambiguous_legacy, ambiguous_legacy.filename(),
        base / "ambiguous-legacy-target");
    assert(!ambiguous_legacy_result.ok &&
           ambiguous_legacy_result.status == 400);
    assert(!fs::exists(base / "ambiguous-legacy-target"));
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

} // namespace

int main() {
    const auto nonce =
        std::chrono::steady_clock::now().time_since_epoch().count();
    TemporaryTree temporary{
        fs::temp_directory_path() /
        ("dwcue-project-format-" + std::to_string(nonce))};
    fs::create_directories(temporary.path);

    test_atomic_no_replace_contract(temporary.path);
    test_extensions_and_direct_legacy_conversion(temporary.path);
    test_native_archive_round_trip(temporary.path);
    test_legacy_and_rejected_archives(temporary.path);
    test_archive_traversal_rejected(temporary.path);
}
