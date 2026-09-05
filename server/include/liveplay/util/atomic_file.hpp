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
#  include <stdio.h>
#elif defined(__linux__)
#  include <fcntl.h>
#  include <sys/syscall.h>
#  include <unistd.h>
#endif

namespace liveplay::util {

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
