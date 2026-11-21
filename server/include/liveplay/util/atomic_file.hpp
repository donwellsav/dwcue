#pragma once

#include <cerrno>
#include <filesystem>
#include <system_error>

#if defined(_WIN32)
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  include <windows.h>
#elif defined(__APPLE__)
#  include <fcntl.h>
#  include <stdio.h>
#  include <unistd.h>
#elif defined(__linux__)
#  include <fcntl.h>
#  include <sys/syscall.h>
#  include <unistd.h>
#endif

namespace liveplay::util {

// Push a finished file's data to the disk before it replaces a good one, so a
// power cut or system crash just after the swap cannot leave the new name on a
// short or empty file.
inline bool flush_file_to_disk(const std::filesystem::path& path, std::error_code& ec) {
#if defined(_WIN32)
    // Flushing needs write access. A virus scanner or sync client that has the
    // new file open for a moment, or a read-only copy, can refuse it: wait a
    // little, then go on without the flush rather than lose the save
    // (MoveFileExW's WRITE_THROUGH still applies to the swap).
    HANDLE file = INVALID_HANDLE_VALUE;
    for (int attempt = 0; attempt < 5; ++attempt) {
        file = ::CreateFileW(path.c_str(), GENERIC_WRITE,
                             FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                             nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (file != INVALID_HANDLE_VALUE) break;
        const DWORD error = ::GetLastError();
        if (error != ERROR_SHARING_VIOLATION && error != ERROR_LOCK_VIOLATION &&
            error != ERROR_ACCESS_DENIED) {
            ec = std::error_code{static_cast<int>(error), std::system_category()};
            return false;
        }
        ::Sleep(50);
    }
    if (file == INVALID_HANDLE_VALUE) {
        ec.clear();
        return true;
    }
    const bool flushed = ::FlushFileBuffers(file) != 0;
    if (!flushed) ec = std::error_code{static_cast<int>(::GetLastError()), std::system_category()};
    ::CloseHandle(file);
    if (flushed) ec.clear();
    return flushed;
#elif defined(__APPLE__) || defined(__linux__)
    const int file = ::open(path.c_str(), O_RDONLY);
    if (file < 0) {
        ec = std::error_code{errno, std::generic_category()};
        return false;
    }
    const bool flushed = ::fsync(file) == 0;
    if (!flushed) ec = std::error_code{errno, std::generic_category()};
    ::close(file);
    if (flushed) ec.clear();
    return flushed;
#else
    (void)path;
    ec.clear();
    return true;
#endif
}

// After a rename, record the directory entry too (best effort; POSIX only —
// MoveFileExW's WRITE_THROUGH covers it on Windows).
inline void flush_directory_entry(const std::filesystem::path& file) {
#if defined(__APPLE__) || defined(__linux__)
    const auto parent = file.parent_path().empty() ? std::filesystem::path{"."} : file.parent_path();
    const int directory = ::open(parent.c_str(), O_RDONLY);
    if (directory < 0) return;
    (void)::fsync(directory);
    ::close(directory);
#else
    (void)file;
#endif
}

inline bool replace_file_atomically(const std::filesystem::path& source,
                                    const std::filesystem::path& target,
                                    std::error_code& ec) {
#if defined(_WIN32)
    if (::MoveFileExW(source.c_str(), target.c_str(),
                      MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        ec.clear();
        return true;
    }
    ec = std::error_code{
        static_cast<int>(::GetLastError()), std::system_category()};
    return false;
#else
    std::filesystem::rename(source, target, ec);
    return !ec;
#endif
}

// Atomically move source to an unused target name. Unlike
// std::filesystem::rename, this never replaces an existing file or directory.
// Platforms without a native no-replace primitive fail closed.
inline bool rename_no_replace(const std::filesystem::path& source,
                              const std::filesystem::path& target,
                              std::error_code& ec) {
#if defined(_WIN32)
    if (::MoveFileExW(source.c_str(), target.c_str(), MOVEFILE_WRITE_THROUGH)) {
        ec.clear();
        return true;
    }
    const DWORD error = ::GetLastError();
    if (error == ERROR_ALREADY_EXISTS || error == ERROR_FILE_EXISTS) {
        ec = std::make_error_code(std::errc::file_exists);
    } else {
        ec = std::error_code{static_cast<int>(error), std::system_category()};
    }
    return false;
#elif defined(__APPLE__)
    if (::renamex_np(source.c_str(), target.c_str(), RENAME_EXCL) == 0) {
        ec.clear();
        return true;
    }
    ec = std::error_code{errno, std::generic_category()};
    return false;
#elif defined(__linux__) && defined(SYS_renameat2)
    constexpr unsigned int kRenameNoReplace = 1U;
    if (::syscall(SYS_renameat2, AT_FDCWD, source.c_str(), AT_FDCWD,
                  target.c_str(), kRenameNoReplace) == 0) {
        ec.clear();
        return true;
    }
    ec = std::error_code{errno, std::generic_category()};
    return false;
#else
    (void)source;
    (void)target;
    ec = std::make_error_code(std::errc::operation_not_supported);
    return false;
#endif
}

} // namespace liveplay::util
