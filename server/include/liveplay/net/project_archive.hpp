#pragma once

#include <filesystem>
#include <string>

namespace liveplay::net::project_archive {

struct OperationResult {
    bool ok{false};
    int status{500};
    std::string error;
};

struct ImportResult : OperationResult {
    std::filesystem::path project_file;
};

// Writes a raw ZIP containing the active canonical root project exactly once,
// plus the rest of the project folder. Other root .dwcue/.liveplay documents
// are excluded; nested content and media keep their relative paths.
OperationResult export_project(
    const std::filesystem::path& project_folder,
    const std::filesystem::path& active_project,
    const std::filesystem::path& output_zip,
    const std::filesystem::path& excluded_final_output = {});

// Imports a trusted filename-classified .dwcuepack/.lpa into an absent or empty
// destination. Extraction and root validation happen in a fresh sibling
// directory before the result is published. Successful results always expose
// exactly one canonical root .dwcue path.
ImportResult import_project(
    const std::filesystem::path& archive_path,
    const std::filesystem::path& trusted_archive_filename,
    const std::filesystem::path& destination);

} // namespace liveplay::net::project_archive
