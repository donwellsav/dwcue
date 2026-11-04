#pragma once
#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <sys/stat.h>
#endif

namespace liveplay::util {
struct FileRevision {
    std::uintmax_t size = 0;
    std::string token;
    bool operator==(const FileRevision&) const = default;
};

// shortcut: native stamps track revisions; require immutable staged files to exclude external writers.
inline std::optional<FileRevision> file_revision(const std::filesystem::path& path) {
#if defined(_WIN32)
    const HANDLE file = ::CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr);
    if (file == INVALID_HANDLE_VALUE) return std::nullopt;
    BY_HANDLE_FILE_INFORMATION info{};
    FILE_BASIC_INFO basic{};
    const bool ok = ::GetFileInformationByHandle(file, &info) &&
        ::GetFileInformationByHandleEx(file, FileBasicInfo, &basic, sizeof(basic));
    ::CloseHandle(file);
    if (!ok || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) return std::nullopt;
    const auto size = (std::uint64_t{info.nFileSizeHigh} << 32) | info.nFileSizeLow;
    return FileRevision{size, std::to_string(size) + ":" + std::to_string(info.dwVolumeSerialNumber) +
        ":" + std::to_string(info.nFileIndexHigh) + ":" + std::to_string(info.nFileIndexLow) +
        ":" + std::to_string(basic.LastWriteTime.QuadPart) + ":" + std::to_string(basic.ChangeTime.QuadPart)};
#else
    struct stat info{};
    if (::stat(path.c_str(), &info) != 0 || !S_ISREG(info.st_mode) || info.st_size < 0)
        return std::nullopt;
#if defined(__APPLE__)
    const auto modified = info.st_mtimespec, changed = info.st_ctimespec;
#else
    const auto modified = info.st_mtim, changed = info.st_ctim;
#endif
    const auto size = static_cast<std::uintmax_t>(info.st_size);
    return FileRevision{size, std::to_string(size) + ":" + std::to_string(info.st_dev) +
        ":" + std::to_string(info.st_ino) + ":" + std::to_string(modified.tv_sec) +
        ":" + std::to_string(modified.tv_nsec) + ":" + std::to_string(changed.tv_sec) +
        ":" + std::to_string(changed.tv_nsec)};
#endif
}
} // namespace liveplay::util
