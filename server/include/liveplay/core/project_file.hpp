#pragma once

#include <filesystem>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <string_view>
#include <system_error>
#include <vector>

namespace liveplay::core::project_file {

inline constexpr std::string_view kNativeProjectExtension = ".dwcue";
inline constexpr std::string_view kLegacyProjectExtension = ".liveplay";
inline constexpr std::string_view kNativeArchiveExtension = ".dwcuepack";
inline constexpr std::string_view kLegacyArchiveExtension = ".lpa";

enum class ArchiveKind {
    Native,
    Legacy,
};

bool is_native_project(const std::filesystem::path& path);
bool is_legacy_project(const std::filesystem::path& path);
bool is_native_archive(const std::filesystem::path& path);
bool is_legacy_archive(const std::filesystem::path& path);
std::optional<ArchiveKind> archive_kind(const std::filesystem::path& trusted_filename);

struct DocumentRepair {
    bool repaired{false};
    std::vector<std::string> issues;
};

struct PreparedDocument {
    nlohmann::json document;
    bool cart_migrated{false};
    DocumentRepair repair;
};

bool is_client_document(const nlohmann::json& document);
DocumentRepair repair_client_document(nlohmann::json& document);

// Validates and normalizes a client-shaped document without touching live
// ProjectState. `folder_override` is used for file-based opens/imports so media
// remains anchored to the folder containing the show file.
bool prepare_client_document(
    const nlohmann::json& source,
    const std::optional<std::filesystem::path>& folder_override,
    PreparedDocument& prepared,
    std::string& error);

// Reads a legacy .liveplay document and fully prepares it before any canonical
// destination is created.
bool read_legacy_project(
    const std::filesystem::path& source,
    PreparedDocument& prepared,
    std::string& error);

// A caller-provided legacy destination must be a .dwcue sibling in the same
// canonical parent as the source. The target may not already exist.
bool valid_legacy_destination(
    const std::filesystem::path& source,
    const std::filesystem::path& destination,
    std::string& error);

// Chooses source-stem.dwcue, then source-stem (2).dwcue, and so on. This is a
// candidate only; write_new_canonical_project provides the exclusive-create
// race boundary.
std::optional<std::filesystem::path> unique_legacy_destination(
    const std::filesystem::path& source,
    std::string& error);

// Serializes with CREATE_NEW/O_EXCL semantics. Existing files, including
// symlinks, are never opened or replaced.
bool write_new_canonical_project(
    const std::filesystem::path& destination,
    const nlohmann::json& document,
    std::error_code& error);

} // namespace liveplay::core::project_file
