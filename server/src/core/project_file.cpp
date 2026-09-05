#include "liveplay/core/project_file.hpp"

#include "liveplay/core/one_shot_migration.hpp"
#include "liveplay/util/unicode_path.hpp"

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <ctime>
#include <fstream>
#include <limits>
#include <cctype>
#include <unordered_map>
#include <unordered_set>

#if defined(_WIN32)
#  include <windows.h>
#else
#  include <fcntl.h>
#  include <unistd.h>
#endif

namespace liveplay::core::project_file {
namespace {

namespace fs = std::filesystem;
using json = nlohmann::json;

std::string lower_extension(const fs::path& path) {
    std::string extension = util::path_to_utf8(path.extension());
    std::transform(extension.begin(), extension.end(), extension.begin(),
                   [](unsigned char ch) {
                       return static_cast<char>(std::tolower(ch));
                   });
    return extension;
}

std::string unix_timestamp_to_iso(std::int64_t unix_seconds) {
    const std::time_t time = static_cast<std::time_t>(unix_seconds);
    std::tm utc{};
#if defined(_WIN32)
    gmtime_s(&utc, &time);
#else
    gmtime_r(&time, &utc);
#endif
    char text[32];
    std::strftime(text, sizeof(text), "%Y-%m-%dT%H:%M:%S.000Z", &utc);
    return text;
}

std::string normalized_last_modified(const json& document) {
    const auto field = document.find("lastModified");
    if (field == document.end()) return {};
    if (field->is_string()) return field->get<std::string>();
    if (field->is_number_integer())
        return unix_timestamp_to_iso(field->get<std::int64_t>());
    if (field->is_number_unsigned()) {
        return unix_timestamp_to_iso(
            static_cast<std::int64_t>(field->get<std::uint64_t>()));
    }
    return {};
}

void count_item_uuids(const json& items,
                      std::unordered_map<std::string, int>& counts) {
    if (!items.is_array()) return;
    for (const auto& item : items) {
        if (!item.is_object()) continue;
        const std::string uuid = item.value("uuid", std::string{});
        if (!uuid.empty()) ++counts[uuid];
        if (item.value("type", std::string{}) == "group" &&
            item.contains("children")) {
            count_item_uuids(item["children"], counts);
        }
    }
}

int remove_duplicate_items(json& items,
                           std::unordered_set<std::string>& seen) {
    if (!items.is_array()) return 0;
    int removed = 0;
    for (int index = static_cast<int>(items.size()) - 1; index >= 0; --index) {
        auto& item = items[static_cast<std::size_t>(index)];
        if (!item.is_object()) continue;
        const std::string uuid = item.value("uuid", std::string{});
        if (!uuid.empty()) {
            if (seen.contains(uuid)) {
                items.erase(items.begin() + index);
                ++removed;
                continue;
            }
            seen.insert(uuid);
        }
        if (item.value("type", std::string{}) == "group" &&
            item.contains("children")) {
            removed += remove_duplicate_items(item["children"], seen);
        }
    }
    return removed;
}

fs::path effective_parent(const fs::path& path) {
    return path.has_parent_path() ? path.parent_path() : fs::current_path();
}

bool path_is_occupied(const fs::path& path, std::error_code& error) {
    error.clear();
    const auto status = fs::symlink_status(path, error);
    if (error == std::errc::no_such_file_or_directory) {
        error.clear();
        return false;
    }
    if (error) return false;
    return status.type() != fs::file_type::not_found;
}

} // namespace

bool is_native_project(const fs::path& path) {
    return lower_extension(path) == kNativeProjectExtension;
}

bool is_legacy_project(const fs::path& path) {
    return lower_extension(path) == kLegacyProjectExtension;
}

bool is_native_archive(const fs::path& path) {
    return lower_extension(path) == kNativeArchiveExtension;
}

bool is_legacy_archive(const fs::path& path) {
    return lower_extension(path) == kLegacyArchiveExtension;
}

std::optional<ArchiveKind> archive_kind(const fs::path& trusted_filename) {
    if (is_native_archive(trusted_filename)) return ArchiveKind::Native;
    if (is_legacy_archive(trusted_filename)) return ArchiveKind::Legacy;
    return std::nullopt;
}

bool is_client_document(const json& document) {
    if (!document.is_object()) return false;
    const auto items = document.find("items");
    if (items != document.end() && items->is_array()) {
        for (const auto& item : *items) {
            if (item.is_object() && item.contains("uuid") &&
                item.contains("type")) {
                return true;
            }
        }
        // Empty shows are still client documents. These fields are unique to
        // the camelCase desktop schema; the server routing schema uses
        // schema_version/project_name instead.
        if (document.contains("name") || document.contains("version") ||
            document.contains("folderPath") || document.contains("settings")) {
            return true;
        }
    }
    return document.contains("cartItems") ||
           document.contains("cartSlotKeys") ||
           document.contains("cartOnlyItems");
}

DocumentRepair repair_client_document(json& document) {
    DocumentRepair repair;

    if (document.contains("lastModified") &&
        !document["lastModified"].is_string()) {
        document["lastModified"] = normalized_last_modified(document);
        repair.repaired = true;
        repair.issues.emplace_back(
            "lastModified was stored as a number; converted to ISO 8601 string");
    }

    if (document.contains("items") && document["items"].is_array()) {
        std::unordered_set<std::string> seen;
        const int removed = remove_duplicate_items(document["items"], seen);
        if (removed > 0) {
            repair.repaired = true;
            repair.issues.push_back(
                "Removed " + std::to_string(removed) +
                " duplicate item(s) from the playlist");
        }
    }

    if (document.contains("cartOnlyItems") &&
        document["cartOnlyItems"].is_array()) {
        std::unordered_set<std::string> seen;
        if (document.contains("items")) {
            std::unordered_map<std::string, int> counts;
            count_item_uuids(document["items"], counts);
            for (const auto& [uuid, _] : counts) seen.insert(uuid);
        }
        const int removed =
            remove_duplicate_items(document["cartOnlyItems"], seen);
        if (removed > 0) {
            repair.repaired = true;
            repair.issues.push_back(
                "Removed " + std::to_string(removed) +
                " duplicate item(s) from the cart");
        }
    }

    return repair;
}

bool prepare_client_document(
    const json& source,
    const std::optional<fs::path>& folder_override,
    PreparedDocument& prepared,
    std::string& error) {
    if (!is_client_document(source)) {
        error = "unsupported legacy project document schema";
        return false;
    }

    prepared = PreparedDocument{};
    prepared.document = source;
    if (folder_override) {
        prepared.document["folderPath"] =
            util::path_to_utf8(*folder_override);
    }
    prepared.cart_migrated =
        migrate_legacy_cart_to_one_shots(prepared.document);
    prepared.repair = repair_client_document(prepared.document);

    if (!prepared.document.contains("settings") ||
        !prepared.document["settings"].is_object()) {
        prepared.document["settings"] = json{
            {"defaultOutputDevice", nullptr},
            {"previewDevice", nullptr},
            {"ltcDevice", nullptr},
        };
    }
    if (!prepared.document.contains("cartOnlyItems") ||
        !prepared.document["cartOnlyItems"].is_array()) {
        prepared.document["cartOnlyItems"] = json::array();
    }
    if (!prepared.document.contains("theme") ||
        !prepared.document["theme"].is_object()) {
        prepared.document["theme"] =
            json{{"mode", "dark"}, {"accentColor", "#315FCF"}};
    }
    error.clear();
    return true;
}

bool read_legacy_project(const fs::path& source,
                         PreparedDocument& prepared,
                         std::string& error) {
    if (!is_legacy_project(source)) {
        error = "legacy import requires a .liveplay project";
        return false;
    }

    std::error_code status_error;
    const auto status = fs::symlink_status(source, status_error);
    if (status_error || !fs::is_regular_file(status)) {
        error = "legacy project does not exist or is not a regular file";
        return false;
    }

    try {
        std::ifstream input{source, std::ios::binary};
        if (!input) {
            error = "cannot open legacy project";
            return false;
        }
        json document;
        input >> document;
        if (!input.good() && !input.eof()) {
            error = "cannot read legacy project";
            return false;
        }
        return prepare_client_document(
            document, effective_parent(source), prepared, error);
    } catch (const json::exception& exception) {
        error = std::string{"invalid legacy project JSON: "} + exception.what();
        return false;
    } catch (const std::exception& exception) {
        error = exception.what();
        return false;
    }
}

bool valid_legacy_destination(const fs::path& source,
                              const fs::path& destination,
                              std::string& error) {
    if (!is_legacy_project(source)) {
        error = "legacy import requires a .liveplay project";
        return false;
    }
    if (!is_native_project(destination)) {
        error = "destinationPath must use the .dwcue extension";
        return false;
    }

    std::error_code path_error;
    const fs::path source_parent =
        fs::canonical(effective_parent(source), path_error);
    if (path_error) {
        error = "cannot resolve legacy project parent";
        return false;
    }
    const fs::path destination_parent =
        fs::weakly_canonical(effective_parent(destination), path_error);
    if (path_error || destination_parent != source_parent) {
        error = "destinationPath must be in the same folder as the legacy project";
        return false;
    }

    if (path_is_occupied(destination, path_error)) {
        error = "destinationPath already exists";
        return false;
    }
    if (path_error) {
        error = "cannot inspect destinationPath";
        return false;
    }
    error.clear();
    return true;
}

std::optional<fs::path> unique_legacy_destination(
    const fs::path& source, std::string& error) {
    if (!is_legacy_project(source)) {
        error = "legacy import requires a .liveplay project";
        return std::nullopt;
    }

    const fs::path parent = effective_parent(source);
    const auto make_candidate = [&](unsigned number) {
        fs::path name = source.stem();
        if (number > 1) {
            name += util::utf8_to_path(
                " (" + std::to_string(number) + ")");
        }
        name += util::utf8_to_path(std::string{kNativeProjectExtension});
        return parent / name;
    };

    std::error_code path_error;
    for (unsigned number = 1; number < 100'000; ++number) {
        fs::path candidate = make_candidate(number);
        if (!path_is_occupied(candidate, path_error)) {
            if (path_error) {
                error = "cannot inspect legacy import destination";
                return std::nullopt;
            }
            error.clear();
            return candidate;
        }
    }
    error = "could not choose an unused .dwcue sibling";
    return std::nullopt;
}

bool write_new_canonical_project(const fs::path& destination,
                                 const json& document,
                                 std::error_code& error) {
    error.clear();
    if (!is_native_project(destination)) {
        error = std::make_error_code(std::errc::invalid_argument);
        return false;
    }

    const std::string serialized = document.dump(2);
#if defined(_WIN32)
    HANDLE file = ::CreateFileW(
        destination.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        error = std::error_code(
            static_cast<int>(::GetLastError()), std::system_category());
        return false;
    }

    bool ok = true;
    std::size_t offset = 0;
    while (offset < serialized.size()) {
        const auto remaining = serialized.size() - offset;
        const DWORD chunk = static_cast<DWORD>(std::min<std::size_t>(
            remaining, std::numeric_limits<DWORD>::max()));
        DWORD written = 0;
        if (!::WriteFile(file, serialized.data() + offset, chunk, &written,
                         nullptr) || written != chunk) {
            error = std::error_code(
                static_cast<int>(::GetLastError()), std::system_category());
            ok = false;
            break;
        }
        offset += written;
    }
    if (ok && !::FlushFileBuffers(file)) {
        error = std::error_code(
            static_cast<int>(::GetLastError()), std::system_category());
        ok = false;
    }
    if (!::CloseHandle(file) && ok) {
        error = std::error_code(
            static_cast<int>(::GetLastError()), std::system_category());
        ok = false;
    }
#else
    const int file = ::open(destination.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC,
                            0666);
    if (file < 0) {
        error = std::error_code(errno, std::generic_category());
        return false;
    }

    bool ok = true;
    std::size_t offset = 0;
    while (offset < serialized.size()) {
        const ssize_t written =
            ::write(file, serialized.data() + offset, serialized.size() - offset);
        if (written < 0) {
            if (errno == EINTR) continue;
            error = std::error_code(errno, std::generic_category());
            ok = false;
            break;
        }
        if (written == 0) {
            error = std::make_error_code(std::errc::io_error);
            ok = false;
            break;
        }
        offset += static_cast<std::size_t>(written);
    }
    if (ok && ::fsync(file) != 0) {
        error = std::error_code(errno, std::generic_category());
        ok = false;
    }
    if (::close(file) != 0 && ok) {
        error = std::error_code(errno, std::generic_category());
        ok = false;
    }
#endif

    return ok;
}

} // namespace liveplay::core::project_file
