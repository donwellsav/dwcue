#pragma once

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

} // namespace liveplay::util
