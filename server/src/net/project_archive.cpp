#include "liveplay/net/project_archive.hpp"

#include "liveplay/core/project_file.hpp"
#include "liveplay/core/show_backups.hpp"
#include "liveplay/logger.hpp"
#include "liveplay/net/control_security.hpp"
#include "liveplay/util/atomic_file.hpp"
#include "liveplay/util/unicode_path.hpp"

#include <miniz.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iterator>
#include <optional>
#include <string>
#include <string_view>
#include <system_error>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#if defined(_WIN32)
#  include <windows.h>
#endif

namespace liveplay::net::project_archive {
namespace {

namespace fs = std::filesystem;
namespace project_file = liveplay::core::project_file;
using json = nlohmann::json;

struct ScopedTreeRemoval {
    fs::path path;
    ~ScopedTreeRemoval() {
        if (path.empty()) return;
        std::error_code error;
        fs::remove_all(path, error);
    }
};

struct ZipEntryPlan {
    mz_uint index{0};
    std::string relative_utf8;
    fs::path destination;
    bool directory{false};
    std::uint64_t expanded_bytes{0};
};

struct ZipReaderGuard {
    mz_zip_archive* archive{};
    bool active{true};

    void close() noexcept {
        if (active && archive) mz_zip_reader_end(archive);
        active = false;
    }
    ~ZipReaderGuard() { close(); }
};

struct BoundedZipWriter {
    std::ofstream output;
    std::uint64_t expected_bytes{0};
    std::uint64_t written_bytes{0};
    bool failed{false};
};

std::size_t write_bounded_zip_entry(void* opaque, mz_uint64 file_offset,
                                    const void* data, std::size_t size) {
    auto& writer = *static_cast<BoundedZipWriter*>(opaque);
    if (writer.failed || file_offset != writer.written_bytes ||
        writer.written_bytes > writer.expected_bytes ||
        size > writer.expected_bytes - writer.written_bytes) {
        writer.failed = true;
        return 0;
    }
    writer.output.write(static_cast<const char*>(data),
                        static_cast<std::streamsize>(size));
    if (!writer.output) {
        writer.failed = true;
        return 0;
    }
    writer.written_bytes += size;
    return size;
}

std::string archive_path_key(std::string path) {
#if defined(_WIN32)
    std::transform(path.begin(), path.end(), path.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
#endif
    return path;
}

bool archive_destination_is_safe(const fs::path& canonical_root,
                                 const std::string& relative_utf8,
                                 bool directory,
                                 fs::path& destination,
                                 std::string& error) {
    const fs::path relative = util::utf8_to_path(relative_utf8);
    destination = canonical_root / relative;

    fs::path current = canonical_root;
    std::error_code path_error;
    for (const auto& component : relative) {
        current /= component;
        const auto status = fs::symlink_status(current, path_error);
        if (path_error) {
            if (path_error == std::errc::no_such_file_or_directory) {
                path_error.clear();
                break;
            }
            error = "cannot inspect archive destination";
            return false;
        }
        if (fs::is_symlink(status)) {
            error = "archive destination contains a link or reparse point";
            return false;
        }
#if defined(_WIN32)
        const DWORD attributes = ::GetFileAttributesW(current.c_str());
        if (attributes != INVALID_FILE_ATTRIBUTES &&
            (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
            error = "archive destination contains a link or reparse point";
            return false;
        }
#endif
    }

    const fs::path resolved = fs::weakly_canonical(destination, path_error);
    if (path_error ||
        !security::canonical_path_is_within(canonical_root, resolved)) {
        error = "archive entry escapes extraction directory";
        return false;
    }

    const auto status = fs::symlink_status(destination, path_error);
    if (path_error && path_error != std::errc::no_such_file_or_directory) {
        error = "cannot inspect archive destination";
        return false;
    }
    if (!path_error && status.type() != fs::file_type::not_found) {
        if (fs::is_symlink(status)) {
            error = "archive destination is a link or reparse point";
            return false;
        }
        if (!directory || !fs::is_directory(status)) {
            error = "archive would overwrite an existing path";
            return false;
        }
    }
    return true;
}

OperationResult extract_zip_to(const fs::path& source_zip,
                               const fs::path& output_directory) {
    std::error_code path_error;
    const auto archive_size = fs::file_size(source_zip, path_error);
    if (path_error) return {false, 400, "cannot read archive"};
    if (archive_size > security::kMaxArchiveCompressedBytes)
        return {false, 413, "archive exceeds compressed-size limit"};

    fs::create_directories(output_directory, path_error);
    if (path_error)
        return {false, 500, "cannot create extraction directory"};
    const fs::path canonical_root =
        fs::canonical(output_directory, path_error);
    if (path_error)
        return {false, 500, "cannot resolve extraction directory"};

    mz_zip_archive zip{};
    const std::string input_utf8 = util::path_to_utf8(source_zip);
    if (!mz_zip_reader_init_file(&zip, input_utf8.c_str(), 0)) {
        Logger::warn("project archive: invalid ZIP '{}'", input_utf8);
        return {false, 400, "invalid archive"};
    }
    ZipReaderGuard zip_guard{&zip};
    const auto finish = [&](OperationResult result) {
        zip_guard.close();
        return result;
    };

    const mz_uint count = mz_zip_reader_get_num_files(&zip);
    if (count > security::kMaxArchiveEntries)
        return finish({false, 413, "archive contains too many entries"});

    security::ArchiveBudget budget;
    std::vector<ZipEntryPlan> plans;
    plans.reserve(count);
    std::unordered_set<std::string> all_paths;
    std::unordered_set<std::string> file_paths;

    for (mz_uint index = 0; index < count; ++index) {
        mz_zip_archive_file_stat stat{};
        if (!mz_zip_reader_file_stat(&zip, index, &stat))
            return finish({false, 400, "invalid archive directory"});
        if (stat.m_is_encrypted || !stat.m_is_supported) {
            return finish(
                {false, 400, "encrypted or unsupported archive entry"});
        }

        const mz_uint filename_bytes =
            mz_zip_reader_get_filename(&zip, index, nullptr, 0);
        if (filename_bytes <= 1 ||
            filename_bytes > security::kMaxArchivePathBytes + 1) {
            return finish(
                {false, 400, "invalid or overlong archive entry path"});
        }
        std::vector<char> filename(filename_bytes);
        if (mz_zip_reader_get_filename(
                &zip, index, filename.data(), filename_bytes) !=
            filename_bytes) {
            return finish({false, 400, "invalid archive entry path"});
        }
        std::string raw_name{filename.data(), filename_bytes - 1};
        if (raw_name.find('\0') != std::string::npos)
            return finish({false, 400, "archive entry path contains NUL"});

        const bool directory = stat.m_is_directory != 0;
        const auto normalized =
            security::normalize_archive_entry_path(raw_name);
        if (!normalized)
            return finish({false, 400, "unsafe archive entry path"});
        if (!security::archive_entry_type_is_safe(
                stat.m_version_made_by, stat.m_external_attr, directory)) {
            return finish(
                {false, 400, "archive contains a link or special entry"});
        }
        if (const auto limit_error = security::charge_archive_entry(
                budget, stat.m_comp_size, stat.m_uncomp_size, directory)) {
            return finish({false, 413, std::string{*limit_error}});
        }

        const std::string key = archive_path_key(*normalized);
        if (!all_paths.insert(key).second)
            return finish({false, 400, "archive contains duplicate paths"});

        fs::path destination;
        std::string destination_error;
        if (!archive_destination_is_safe(
                canonical_root, *normalized, directory,
                destination, destination_error)) {
            return finish({false, 400, std::move(destination_error)});
        }
        plans.push_back(ZipEntryPlan{
            index,
            *normalized,
            std::move(destination),
            directory,
            static_cast<std::uint64_t>(stat.m_uncomp_size),
        });
        if (!directory) file_paths.insert(key);
    }

    for (const auto& plan : plans) {
        const std::string key = archive_path_key(plan.relative_utf8);
        for (auto slash = key.find('/'); slash != std::string::npos;
             slash = key.find('/', slash + 1)) {
            if (file_paths.contains(key.substr(0, slash))) {
                return finish(
                    {false, 400, "archive path has a file as its parent"});
            }
        }
    }

    const auto space = fs::space(canonical_root, path_error);
    if (!path_error && budget.expanded_bytes > space.available)
        return finish(
            {false, 507, "insufficient space for expanded archive"});

    std::vector<fs::path> created_files;
    created_files.reserve(plans.size());
    const auto fail_extract = [&](int status, std::string message) {
        for (auto it = created_files.rbegin(); it != created_files.rend(); ++it) {
            std::error_code remove_error;
            fs::remove(*it, remove_error);
        }
        return finish({false, status, std::move(message)});
    };

    for (const auto& plan : plans) {
        if (plan.directory) {
            fs::create_directories(plan.destination, path_error);
            if (path_error)
                return fail_extract(500, "cannot create archive directory");
            continue;
        }

        fs::create_directories(plan.destination.parent_path(), path_error);
        if (path_error)
            return fail_extract(500, "cannot create archive parent directory");

        fs::path checked_destination;
        std::string destination_error;
        if (!archive_destination_is_safe(
                canonical_root, plan.relative_utf8, false,
                checked_destination, destination_error)) {
            return fail_extract(400, std::move(destination_error));
        }

        BoundedZipWriter writer{
            std::ofstream{checked_destination,
                          std::ios::binary | std::ios::trunc},
            plan.expanded_bytes,
        };
        if (!writer.output)
            return fail_extract(500, "cannot create extracted file");
        created_files.push_back(checked_destination);

        const bool extracted = mz_zip_reader_extract_to_callback(
            &zip, plan.index, write_bounded_zip_entry, &writer, 0);
        writer.output.close();
        if (!extracted || writer.failed ||
            writer.written_bytes != writer.expected_bytes) {
            return fail_extract(400, "archive entry data is invalid");
        }

        const auto status = fs::symlink_status(checked_destination, path_error);
        if (path_error || !fs::is_regular_file(status) ||
            fs::file_size(checked_destination, path_error) !=
                plan.expanded_bytes ||
            path_error) {
            return fail_extract(400, "extracted file failed validation");
        }
    }

    return finish({true, 200, {}});
}

bool add_zip_file(mz_zip_archive& zip, const fs::path& source,
                  std::string entry) {
    std::replace(entry.begin(), entry.end(), '\\', '/');
    const std::string source_utf8 = util::path_to_utf8(source);
    if (mz_zip_writer_add_file(&zip, entry.c_str(), source_utf8.c_str(),
                               nullptr, 0, MZ_DEFAULT_LEVEL)) {
        return true;
    }
    Logger::error("project archive: failed to add '{}'", entry);
    return false;
}

bool paths_equivalent(const fs::path& left, const fs::path& right) {
    std::error_code error;
    return fs::equivalent(left, right, error) && !error;
}

bool output_is_excluded(const fs::path& candidate,
                        const fs::path& output_zip,
                        const fs::path& excluded_final_output) {
    if (paths_equivalent(candidate, output_zip)) return true;
    return !excluded_final_output.empty() &&
           paths_equivalent(candidate, excluded_final_output);
}

struct DestinationState {
    bool exists{false};
    bool empty{false};
};

OperationResult inspect_import_destination(const fs::path& destination,
                                           DestinationState& state) {
    std::error_code error;
    const auto status = fs::symlink_status(destination, error);
    if (error == std::errc::no_such_file_or_directory) {
        state = {};
        return {true, 200, {}};
    }
    if (error)
        return {false, 500, "cannot inspect extraction destination"};
    if (fs::is_symlink(status))
        return {false, 400, "extractPath must not be a link or reparse point"};
    if (!fs::is_directory(status))
        return {false, 409, "extractPath already exists and is not a directory"};
    const bool empty = fs::is_empty(destination, error);
    if (error)
        return {false, 500, "cannot inspect extraction destination"};
    if (!empty)
        return {false, 409, "extractPath must be empty"};
    state = {true, true};
    return {true, 200, {}};
}

fs::path make_sibling_staging_path(const fs::path& destination,
                                   std::string_view role) {
    const fs::path parent = destination.has_parent_path()
        ? destination.parent_path()
        : fs::current_path();
    std::string base = util::path_to_utf8(destination.filename());
    if (base.empty()) base = "project";
    return parent / util::utf8_to_path(
        "." + base + "." + std::string{role} + "-" +
        security::random_hex_token(16) + ".part");
}

OperationResult validate_json_project(const fs::path& project) {
    try {
        std::ifstream input{project, std::ios::binary};
        if (!input) return {false, 400, "cannot open archived project"};
        json document;
        input >> document;
        if (!document.is_object() ||
            !project_file::is_client_document(document)) {
            return {false, 400, "archived project has an unsupported schema"};
        }
        return {true, 200, {}};
    } catch (const json::exception&) {
        return {false, 400, "archived project is not valid JSON"};
    }
}

OperationResult reserve_and_publish(const fs::path& staging,
                                    const fs::path& destination) {
    DestinationState state;
    auto inspection = inspect_import_destination(destination, state);
    if (!inspection.ok) return inspection;

    std::error_code error;
    if (!state.exists) {
        if (util::rename_no_replace(staging, destination, error))
            return {true, 200, {}};
        if (error == std::errc::file_exists)
            return {false, 409, "extractPath became unavailable"};
        return {false, 500, "failed to publish imported project"};
    }

    const fs::path empty_placeholder =
        make_sibling_staging_path(destination, "empty");
    if (!util::rename_no_replace(destination, empty_placeholder, error))
        return {false, 409, "extractPath became unavailable"};

    const auto placeholder_status =
        fs::symlink_status(empty_placeholder, error);
    const bool still_empty = !error && fs::is_directory(placeholder_status) &&
        !fs::is_symlink(placeholder_status) &&
        fs::is_empty(empty_placeholder, error) && !error;
    if (!still_empty) {
        std::error_code restore_error;
        util::rename_no_replace(empty_placeholder, destination, restore_error);
        return {false, 409, "extractPath changed during import"};
    }

    if (!util::rename_no_replace(staging, destination, error)) {
        std::error_code restore_error;
        util::rename_no_replace(empty_placeholder, destination, restore_error);
        // If restoration loses a race, leave the placeholder intact rather
        // than deleting a path that may now contain caller-owned content.
        if (error == std::errc::file_exists)
            return {false, 409, "extractPath became unavailable"};
        return {false, 500, "failed to publish imported project"};
    }

    // The displaced destination was observed empty. A concurrent writer may
    // nevertheless have populated it after that check, so remove only when it
    // is still empty; otherwise preserve the placeholder and its contents.
    error.clear();
    const auto final_status = fs::symlink_status(empty_placeholder, error);
    if (!error && fs::is_directory(final_status) &&
        !fs::is_symlink(final_status) &&
        fs::is_empty(empty_placeholder, error) && !error) {
        fs::remove(empty_placeholder, error);
    }
    return {true, 200, {}};
}

// Media linked from outside the show folder (imported with Link, or played
// from a music drive) travels in the bundle: each file is packed once under
// media/, and the packed show file points at it there, so the show plays
// wherever the bundle is unpacked.
struct LinkedMedia {
    fs::path    source;
    std::string entry;
};

struct PackedShow {
    std::string             document;   // the show file to pack, rewritten
    std::vector<LinkedMedia> linked;
};

bool lies_inside(const fs::path& path, const fs::path& canonical_folder) {
    std::error_code error;
    const auto canonical = fs::weakly_canonical(path, error);
    const auto relative = fs::relative(error ? path : canonical, canonical_folder, error);
    return !error && !relative.empty() && *relative.begin() != fs::path{".."};
}

std::optional<PackedShow> pack_linked_media(const fs::path& project_folder,
                                            const fs::path& canonical_folder,
                                            const fs::path& active_project) {
    std::ifstream input{active_project, std::ios::binary};
    if (!input) return std::nullopt;
    const std::string bytes{std::istreambuf_iterator<char>{input}, std::istreambuf_iterator<char>{}};
    nlohmann::json show = nlohmann::json::parse(bytes, nullptr, false);
    if (show.is_discarded() || !show.is_object()) return std::nullopt;

    PackedShow packed;
    std::unordered_map<std::string, std::string> entry_by_source;
    std::unordered_set<std::string> taken;   // lower case: the bundle may be unpacked on Windows
    const auto key = [](std::string text) {
        std::transform(text.begin(), text.end(), text.begin(),
                       [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
        return text;
    };
    const auto entry_for = [&](const fs::path& source) -> std::optional<std::string> {
        std::error_code error;
        if (!fs::is_regular_file(source, error)) {
            Logger::warn("project archive: linked media '{}' is missing; it is not in the archive",
                         util::path_to_utf8(source));
            return std::nullopt;
        }
        const auto canonical = fs::weakly_canonical(source, error);
        const auto source_key = util::path_to_utf8(error ? source : canonical);
        if (const auto found = entry_by_source.find(source_key); found != entry_by_source.end())
            return found->second;
        const auto stem = util::path_to_utf8(source.stem());
        const auto extension = util::path_to_utf8(source.extension());
        for (int n = 1; n < 1000; ++n) {
            const auto name = n == 1 ? stem + extension : stem + " (" + std::to_string(n) + ")" + extension;
            const auto entry = "media/" + name;
            std::error_code probe;
            if (taken.contains(key(entry)) ||
                fs::exists(project_folder / "media" / util::utf8_to_path(name), probe)) continue;
            taken.insert(key(entry));
            entry_by_source.emplace(source_key, entry);
            packed.linked.push_back({source, entry});
            return entry;
        }
        return std::nullopt;
    };
    const auto outside = [&](const nlohmann::json& value) -> std::optional<fs::path> {
        if (!value.is_string() || value.get_ref<const std::string&>().empty()) return std::nullopt;
        const auto path = util::utf8_to_path(value.get<std::string>());
        if (!path.is_absolute() || lies_inside(path, canonical_folder)) return std::nullopt;
        return path;
    };
    const std::function<void(nlohmann::json&)> visit = [&](nlohmann::json& item) {
        if (!item.is_object()) return;
        if (item.value("type", std::string{}) == "audio") {
            // A cue whose media is in the show folder keeps it there.
            const auto media_path = item.value("mediaPath", std::string{});
            std::error_code error;
            const bool in_folder = !media_path.empty() &&
                fs::is_regular_file(project_folder / util::utf8_to_path(media_path), error);
            const auto server = item.find("mediaServerPath");
            if (!in_folder && server != item.end()) {
                if (const auto source = outside(*server)) {
                    if (const auto entry = entry_for(*source)) {
                        item["mediaPath"] = *entry;
                        item.erase("mediaServerPath");
                    }
                }
            }
            const auto image = item.find("imagePath");
            if (image != item.end()) {
                if (const auto source = outside(*image)) {
                    if (const auto entry = entry_for(*source)) *image = *entry;
                }
            }
        }
        const auto children = item.find("children");
        if (children != item.end() && children->is_array())
            for (auto& child : *children) visit(child);
    };
    for (const char* list : {"items", "quickPlayItems"}) {
        const auto found = show.find(list);
        if (found != show.end() && found->is_array())
            for (auto& item : *found) visit(item);
    }
    const auto settings = show.find("settings");
    if (settings != show.end() && settings->is_object()) {
        const auto standby = settings->find("videoStandbyImage");
        if (standby != settings->end()) {
            if (const auto source = outside(*standby)) {
                if (const auto entry = entry_for(*source)) *standby = *entry;
            }
        }
    }
    packed.document = packed.linked.empty() ? bytes : show.dump(2);
    return packed;
}

} // namespace

OperationResult export_project(const fs::path& project_folder,
                               const fs::path& active_project,
                               const fs::path& output_zip,
                               const fs::path& excluded_final_output) {
    std::error_code error;
    const auto folder_status = fs::symlink_status(project_folder, error);
    if (error || !fs::is_directory(folder_status) ||
        fs::is_symlink(folder_status)) {
        return {false, 400, "folderPath does not exist or is not a directory"};
    }
    const auto project_status = fs::symlink_status(active_project, error);
    if (error || !fs::is_regular_file(project_status) ||
        fs::is_symlink(project_status) ||
        !project_file::is_native_project(active_project)) {
        return {false, 400, "active project is not a canonical .dwcue file"};
    }

    const fs::path canonical_folder = fs::canonical(project_folder, error);
    if (error) return {false, 400, "cannot resolve folderPath"};
    const fs::path canonical_project_parent =
        fs::canonical(active_project.parent_path(), error);
    if (error || canonical_project_parent != canonical_folder) {
        return {false, 400, "active project is not in folderPath"};
    }

    mz_zip_archive zip{};
    std::memset(&zip, 0, sizeof(zip));
    const std::string output_utf8 = util::path_to_utf8(output_zip);
    if (!mz_zip_writer_init_file(&zip, output_utf8.c_str(), 0)) {
        return {false, 500, "failed to initialize archive"};
    }

    const auto show_entry = util::path_to_utf8(active_project.filename());
    const auto packed = pack_linked_media(project_folder, canonical_folder, active_project);
    bool ok = packed && !packed->linked.empty()
        ? mz_zip_writer_add_mem(&zip, show_entry.c_str(), packed->document.data(),
                                packed->document.size(), MZ_DEFAULT_LEVEL) != MZ_FALSE
        : add_zip_file(zip, active_project, show_entry);
    if (packed) {
        for (const auto& media : packed->linked) {
            if (!ok) break;
            ok = add_zip_file(zip, media.source, media.entry);
        }
    }
    try {
        for (fs::recursive_directory_iterator it{project_folder}, end;
             ok && it != end; ++it) {
            const auto status = it->symlink_status(error);
            if (error) throw fs::filesystem_error{
                "cannot inspect project entry", it->path(), error};
            if (fs::is_symlink(status)) {
                if (it->is_directory(error) && !error)
                    it.disable_recursion_pending();
                continue;
            }
            // Backups are this machine's local history of the show file, not
            // part of the show: the folder beside the show is never packed.
            if (fs::is_directory(status) && it.depth() == 0 &&
                core::show_backups::is_backup_folder_name(
                    util::path_to_utf8(it->path().filename()))) {
                it.disable_recursion_pending();
                continue;
            }
            if (!fs::is_regular_file(status)) continue;

            const std::string filename =
                util::path_to_utf8(it->path().filename());
            if (security::is_chunked_upload_staging_name(filename) ||
                security::is_export_staging_name(filename) ||
                output_is_excluded(
                    it->path(), output_zip, excluded_final_output) ||
                paths_equivalent(it->path(), active_project)) {
                continue;
            }

            const fs::path relative = fs::relative(it->path(), project_folder);
            if (!relative.has_parent_path() &&
                (project_file::is_native_project(relative) ||
                 project_file::is_legacy_project(relative))) {
                continue;
            }
            ok = add_zip_file(
                zip, it->path(), util::path_to_utf8(relative));
        }
    } catch (const std::exception& exception) {
        Logger::error("project archive walk failed: {}", exception.what());
        ok = false;
    }

    if (ok && !mz_zip_writer_finalize_archive(&zip)) ok = false;
    mz_zip_writer_end(&zip);
    if (!ok) {
        std::error_code remove_error;
        fs::remove(output_zip, remove_error);
        return {false, 500, "failed to package archive"};
    }
    return {true, 200, {}};
}

ImportResult import_project(const fs::path& archive_path,
                            const fs::path& trusted_archive_filename,
                            const fs::path& destination) {
    if (!project_file::is_native_archive(trusted_archive_filename)) {
        return {{false, 400,
                 "archive filename must use .dwcuepack"}, {}};
    }

    std::error_code error;
    const auto archive_status = fs::symlink_status(archive_path, error);
    if (error || !fs::is_regular_file(archive_status) ||
        fs::is_symlink(archive_status)) {
        return {{false, 400, "archive does not exist"}, {}};
    }
    if (destination.empty())
        return {{false, 400, "extractPath must not be empty"}, {}};

    DestinationState destination_state;
    auto destination_check =
        inspect_import_destination(destination, destination_state);
    if (!destination_check.ok)
        return {std::move(destination_check), {}};

    const fs::path parent = destination.has_parent_path()
        ? destination.parent_path()
        : fs::current_path();
    fs::create_directories(parent, error);
    if (error)
        return {{false, 500, "cannot create extraction parent"}, {}};

    fs::path staging;
    for (unsigned attempt = 0; attempt < 100; ++attempt) {
        staging = make_sibling_staging_path(destination, "import");
        error.clear();
        if (fs::create_directory(staging, error)) break;
        if (error && error != std::errc::file_exists) {
            return {{false, 500, "cannot create import staging directory"}, {}};
        }
        staging.clear();
    }
    if (staging.empty())
        return {{false, 500, "cannot reserve import staging directory"}, {}};
    ScopedTreeRemoval staging_cleanup{staging};

    auto extraction = extract_zip_to(archive_path, staging);
    if (!extraction.ok) return {std::move(extraction), {}};

    std::vector<fs::path> native_roots;
    bool has_foreign_root = false;
    for (fs::directory_iterator it{staging, error}, end;
         !error && it != end; it.increment(error)) {
        const auto status = it->symlink_status(error);
        if (error) break;
        if (!fs::is_regular_file(status) || fs::is_symlink(status))
            continue;
        if (project_file::is_native_project(it->path()))
            native_roots.push_back(it->path());
        else if (project_file::is_legacy_project(it->path()))
            has_foreign_root = true;
    }
    if (error)
        return {{false, 500, "cannot inspect imported archive"}, {}};

    if (native_roots.size() != 1 || has_foreign_root) {
        return {{false, 400,
                 "native archive must contain exactly one root .dwcue project"},
                {}};
    }
    auto validation = validate_json_project(native_roots.front());
    if (!validation.ok) return {std::move(validation), {}};

    fs::path canonical_root = native_roots.front();
    fs::path canonical_name = canonical_root.stem();
    canonical_name += util::utf8_to_path(
        std::string{project_file::kNativeProjectExtension});
    const fs::path normalized = staging / canonical_name;
    if (canonical_root.filename() != canonical_name) {
        const fs::path intermediate = staging / util::utf8_to_path(
            ".canonicalize-" + security::random_hex_token(16) + ".part");
        fs::rename(canonical_root, intermediate, error);
        if (!error) fs::rename(intermediate, normalized, error);
        if (error) {
            std::error_code restore_error;
            if (fs::exists(intermediate, restore_error) && !restore_error)
                fs::rename(intermediate, canonical_root, restore_error);
            return {{false, 500, "cannot canonicalize archived project name"},
                    {}};
        }
        canonical_root = normalized;
    }

    const fs::path project_filename = canonical_root.filename();
    auto publication = reserve_and_publish(staging, destination);
    if (!publication.ok) return {std::move(publication), {}};
    staging_cleanup.path.clear();
    return {{true, 200, {}}, destination / project_filename};
}

} // namespace liveplay::net::project_archive
