#include "liveplay/core/project_file.hpp"

#include "liveplay/core/one_shot_migration.hpp"
#include "liveplay/util/unicode_path.hpp"

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <ctime>
#include <functional>
#include <limits>
#include <stdexcept>
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
    for (const char* field : {"name", "folderPath"}) {
        if (prepared.document.contains(field) &&
            !prepared.document[field].is_string()) {
            error = std::string{field} + " must be a string";
            return false;
        }
    }
    try {
        std::function<void(const json&)> validate_items = [&](const json& items) {
            for (const auto& item : items.get_ref<const json::array_t&>()) {
                (void)item.value("uuid", std::string{});
                const auto type = item.value("type", std::string{});
                if (type == "audio") {
                    (void)item.value("ltcEnabled", false);
                    (void)item.value("ltcStartTimecode", std::string{});
                    const auto fps = item.value("ltcFrameRate", 4.0);
                    if (!std::isfinite(fps) || fps < std::numeric_limits<int>::lowest() ||
                        fps > std::numeric_limits<int>::max())
                        throw std::invalid_argument("ltcFrameRate exceeds its integer range");
                }
                for (const char* behavior : {"startBehavior", "endBehavior"}) {
                    if (item.contains(behavior) && item[behavior].is_object())
                        (void)item[behavior].value("action", std::string{});
                }
                if (type == "group" && item.contains("children")) validate_items(item["children"]);
            }
        };
        if (prepared.document.contains("items")) validate_items(prepared.document["items"]);
        if (prepared.document.contains("cartOnlyItems") && prepared.document["cartOnlyItems"].is_array())
            validate_items(prepared.document["cartOnlyItems"]);
        if (prepared.document.contains("settings") && prepared.document["settings"].is_object()) {
            const auto& settings = prepared.document["settings"];
            (void)settings.value("outputTarget", std::string{"ebu-r128"});
            (void)settings.value("disableLimiter", false);
            const auto preset = settings.value("meterBallistics", std::string{"digital-ppm"});
            if (preset == "custom" && settings.contains("meterBallisticsCustom") &&
                settings["meterBallisticsCustom"].is_object()) {
                for (const char* key : {"attackMs", "releaseMs", "rmsWindowMs"})
                    (void)settings["meterBallisticsCustom"].value(key, 1.0);
            }
        }
        prepared.cart_migrated = migrate_legacy_cart_to_one_shots(prepared.document);
        prepared.repair = repair_client_document(prepared.document);
    } catch (const std::exception& ex) {
        error = ex.what();
        return false;
    }

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
