#pragma once

#include <algorithm>
#include <cctype>
#include <charconv>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <limits>
#include <optional>
#include <random>
#include <string>
#include <string_view>
#include <vector>

namespace liveplay::net::security {

inline constexpr std::size_t   kMaxArchiveEntries          = 10'000;
inline constexpr std::size_t   kMaxArchivePathBytes        = 1'024;
inline constexpr std::uint64_t kMaxArchiveCompressedBytes  = 64ull * 1024 * 1024 * 1024;
inline constexpr std::uint64_t kMaxArchiveFileBytes        = 8ull * 1024 * 1024 * 1024;
inline constexpr std::uint64_t kMaxArchiveExpandedBytes    = 64ull * 1024 * 1024 * 1024;
inline constexpr std::uint64_t kMaxArchiveCompressionRatio = 1'000;
inline constexpr std::size_t   kChunkedUploadChunkBytes    = 4ull * 1024 * 1024;

struct ArchiveBudget {
    std::size_t   entries{0};
    std::uint64_t expanded_bytes{0};
};

inline bool upload_exceeds_limit(std::size_t received_bytes,
                                 std::string_view content_length,
                                 std::size_t limit) {
    if (received_bytes > limit) return true;
    if (content_length.empty()) return false;
    std::uint64_t declared = 0;
    const auto [end, error] = std::from_chars(
        content_length.data(), content_length.data() + content_length.size(),
        declared);
    return error == std::errc{} &&
           end == content_length.data() + content_length.size() &&
           declared > limit;
}

inline bool persist_access_token_for_restart(std::string_view token) {
    const std::string value{token};
#if defined(_WIN32)
    return ::_putenv_s("LIVEPLAY_ACCESS_TOKEN", value.c_str()) == 0;
#else
    return ::setenv("LIVEPLAY_ACCESS_TOKEN", value.c_str(), 1) == 0;
#endif
}

inline std::string random_hex_token(std::size_t byte_count) {
    static constexpr char hex[] = "0123456789abcdef";
    std::random_device source;
    std::uniform_int_distribution<unsigned int> byte_distribution{0, 255};
    std::string token;
    token.reserve(byte_count * 2);
    for (std::size_t i = 0; i < byte_count; ++i) {
        const auto byte = byte_distribution(source);
        token.push_back(hex[byte >> 4]);
        token.push_back(hex[byte & 0x0fu]);
    }
    return token;
}

inline bool parse_decimal_u64(std::string_view raw, std::uint64_t& value) {
    if (raw.empty()) return false;
    value = 0;
    const auto [end, error] = std::from_chars(
        raw.data(), raw.data() + raw.size(), value);
    return error == std::errc{} && end == raw.data() + raw.size();
}

inline std::string sanitize_upload_filename(
    std::string_view raw, std::string_view fallback = "upload.bin") {
    std::string name{raw.empty() ? fallback : raw};
    std::replace(name.begin(), name.end(), '\\', '/');
    if (const auto slash = name.find_last_of('/'); slash != std::string::npos)
        name.erase(0, slash + 1);
    name.erase(std::remove_if(name.begin(), name.end(), [](unsigned char c) {
        return c < 0x20 || c == 0x7f;
    }), name.end());
    for (char& c : name) {
        if (std::string_view{"<>:\"/\\|?*"}.find(c) != std::string_view::npos)
            c = '_';
    }
    while (!name.empty() && (name.back() == '.' || name.back() == ' '))
        name.pop_back();
    if (name.empty() || name == "." || name == "..")
        name.assign(fallback);

    std::string stem = name.substr(0, name.find('.'));
    while (!stem.empty() && (stem.back() == '.' || stem.back() == ' '))
        stem.pop_back();
    std::transform(stem.begin(), stem.end(), stem.begin(), [](unsigned char c) {
        return static_cast<char>(std::toupper(c));
    });
    const bool reserved =
        stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" ||
        (stem.size() == 4 &&
         (stem.starts_with("COM") || stem.starts_with("LPT")) &&
         stem[3] >= '1' && stem[3] <= '9');
    if (reserved) name.insert(name.begin(), '_');

    constexpr std::size_t max_bytes = 200;
    if (name.size() > max_bytes) {
        const auto dot = name.find_last_of('.');
        const bool keep_extension =
            dot != std::string::npos && dot > 0 && name.size() - dot <= 32;
        const std::string extension =
            keep_extension ? name.substr(dot) : std::string{};
        std::string base =
            keep_extension ? name.substr(0, dot) : std::move(name);
        std::size_t cut = max_bytes - extension.size();
        while (cut > 0 && cut < base.size() &&
               (static_cast<unsigned char>(base[cut]) & 0xc0u) == 0x80u) {
            --cut;
        }
        base.resize(std::min(cut, base.size()));
        name = std::move(base) + extension;
    }
    return name;
}

inline bool is_token_staging_name(std::string_view name,
                                  std::string_view prefix) {
    constexpr std::string_view suffix = ".part";
    if (!name.starts_with(prefix) || !name.ends_with(suffix) ||
        name.size() != prefix.size() + 64 + suffix.size()) {
        return false;
    }
    const auto token = name.substr(prefix.size(), 64);
    return std::all_of(token.begin(), token.end(), [](unsigned char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    });
}

inline bool is_chunked_upload_staging_name(std::string_view name) {
    return is_token_staging_name(name, ".dwcue-upload-");
}

inline bool is_export_staging_name(std::string_view name) {
    return is_token_staging_name(name, ".dwcue-export-");
}

inline bool is_export_archive_name(std::string_view name) {
    constexpr std::string_view suffix = ".lpa";
    if (!name.ends_with(suffix) || name.size() != 64 + suffix.size())
        return false;
    const auto token = name.substr(0, 64);
    return std::all_of(token.begin(), token.end(), [](unsigned char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    });
}

inline bool valid_chunked_upload_purpose(std::string_view purpose) {
    return purpose.empty() || purpose == "media" ||
        purpose == "project_import";
}

inline bool chunked_upload_should_purge(bool all,
                                        bool expired,
                                        bool finalizing) {
    return all || (expired && !finalizing);
}

// Returns a portable, slash-separated relative path, or nullopt when a ZIP
// name has traversal/absolute/drive/UNC/ADS semantics on any supported OS.
inline std::optional<std::string> normalize_archive_entry_path(
    std::string_view raw) {
    if (raw.empty() || raw.size() > kMaxArchivePathBytes ||
        raw.find('\0') != std::string_view::npos) {
        return std::nullopt;
    }

    std::string path{raw};
    std::replace(path.begin(), path.end(), '\\', '/');
    if (path.starts_with('/') ||
        (path.size() >= 2 && std::isalpha(static_cast<unsigned char>(path[0])) &&
         path[1] == ':')) {
        return std::nullopt;
    }

    std::string normalized;
    for (std::size_t start = 0; start <= path.size();) {
        const auto slash = path.find('/', start);
        const auto segment = std::string_view{path}.substr(
            start, slash == std::string::npos ? path.size() - start : slash - start);
        if (!segment.empty()) {
            if (segment == "." || segment == ".." ||
                segment.find(':') != std::string_view::npos) {
                return std::nullopt;
            }
            if (!normalized.empty()) normalized.push_back('/');
            normalized.append(segment);
        }
        if (slash == std::string::npos) break;
        start = slash + 1;
    }
    if (normalized.empty()) return std::nullopt;
    return normalized;
}

inline bool canonical_path_is_within(const std::filesystem::path& root,
                                     const std::filesystem::path& candidate) {
    auto root_it = root.begin();
    auto candidate_it = candidate.begin();
    for (; root_it != root.end(); ++root_it, ++candidate_it) {
        if (candidate_it == candidate.end() || *candidate_it != *root_it)
            return false;
    }
    return true;
}

inline bool archive_entry_type_is_safe(std::uint16_t version_made_by,
                                       std::uint32_t external_attributes,
                                       bool directory) {
    constexpr std::uint32_t windows_reparse_point = 0x00000400u;
    constexpr std::uint32_t unix_type_mask        = 0170000u;
    constexpr std::uint32_t unix_regular          = 0100000u;
    constexpr std::uint32_t unix_directory        = 0040000u;
    if ((external_attributes & windows_reparse_point) != 0) return false;
    const auto host_system = static_cast<unsigned int>(version_made_by >> 8);
    // Only Unix/macOS hosts encode a POSIX file type in these bits.
    if (host_system != 3 && host_system != 19) return true;
    const auto unix_type = (external_attributes >> 16) & unix_type_mask;
    if (unix_type == 0) return true;
    return directory ? unix_type == unix_directory : unix_type == unix_regular;
}

// Returns a stable rejection reason, or nullopt after charging this entry
// against the archive-wide expansion budget.
inline std::optional<std::string_view> charge_archive_entry(
    ArchiveBudget& budget,
    std::uint64_t compressed_bytes,
    std::uint64_t expanded_bytes,
    bool directory) {
    if (++budget.entries > kMaxArchiveEntries)
        return "archive contains too many entries";
    if (directory) return std::nullopt;
    if (expanded_bytes > kMaxArchiveFileBytes)
        return "archive entry exceeds expanded-size limit";
    if (expanded_bytes > kMaxArchiveExpandedBytes - budget.expanded_bytes)
        return "archive exceeds total expanded-size limit";
    if (expanded_bytes != 0) {
        if (compressed_bytes == 0)
            return "archive entry has an invalid compression ratio";
        if (compressed_bytes <=
                std::numeric_limits<std::uint64_t>::max() /
                    kMaxArchiveCompressionRatio &&
            expanded_bytes >
                compressed_bytes * kMaxArchiveCompressionRatio) {
            return "archive entry exceeds compression-ratio limit";
        }
    }
    budget.expanded_bytes += expanded_bytes;
    return std::nullopt;
}

inline bool is_loopback_address(std::string_view address) {
    if (address == "localhost" || address == "::1" ||
        address == "0:0:0:0:0:0:0:1") {
        return true;
    }
    if (!address.starts_with("127.") || address.back() == '.') return false;

    // Require a syntactically valid 127/8 IPv4 address, not merely a prefix.
    int octets = 0;
    std::size_t start = 0;
    while (start < address.size()) {
        const auto end = address.find('.', start);
        const auto part = address.substr(
            start, end == std::string_view::npos ? address.size() - start : end - start);
        if (part.empty() || part.size() > 3 ||
            !std::all_of(part.begin(), part.end(), [](unsigned char c) {
                return std::isdigit(c) != 0;
            })) {
            return false;
        }
        int value = 0;
        for (char c : part) value = value * 10 + (c - '0');
        if (value > 255) return false;
        ++octets;
        if (end == std::string_view::npos) break;
        start = end + 1;
    }
    return octets == 4;
}

inline bool constant_time_equal(std::string_view provided, std::string_view expected) {
    // Compare the full longer input so token length does not create an early-exit oracle.
    const std::size_t n = std::max(provided.size(), expected.size());
    std::size_t difference = provided.size() ^ expected.size();
    for (std::size_t i = 0; i < n; ++i) {
        const unsigned char lhs =
            i < provided.size() ? static_cast<unsigned char>(provided[i]) : 0;
        const unsigned char rhs =
            i < expected.size() ? static_cast<unsigned char>(expected[i]) : 0;
        difference |= static_cast<std::size_t>(lhs ^ rhs);
    }
    return difference == 0;
}

inline bool is_loopback_origin(std::string_view origin) {
    const auto scheme_end = origin.find("://");
    if (scheme_end == std::string_view::npos) return false;
    const auto scheme = origin.substr(0, scheme_end);
    if (scheme != "http" && scheme != "https") return false;

    auto authority = origin.substr(scheme_end + 3);
    if (authority.empty() || authority.find('/') != std::string_view::npos ||
        authority.find('@') != std::string_view::npos) {
        return false;
    }

    std::string_view host = authority;
    std::string_view port;
    bool has_port = false;
    if (authority.starts_with('[')) {
        const auto close = authority.find(']');
        if (close == std::string_view::npos) return false;
        host = authority.substr(1, close - 1);
        if (close + 1 < authority.size()) {
            if (authority[close + 1] != ':') return false;
            has_port = true;
            port = authority.substr(close + 2);
        }
    } else if (const auto colon = authority.rfind(':');
               colon != std::string_view::npos) {
        has_port = true;
        host = authority.substr(0, colon);
        port = authority.substr(colon + 1);
    }

    if (has_port && (port.empty() ||
        !std::all_of(port.begin(), port.end(), [](unsigned char c) {
            return std::isdigit(c) != 0;
        }))) {
        return false;
    }
    return is_loopback_address(host);
}

inline bool origin_allowed(std::string_view origin,
                           const std::vector<std::string>& allowed_origins) {
    if (origin.empty() || origin == "null" || origin == "file://") return true;
    if (is_loopback_origin(origin)) return true;
    return std::find(allowed_origins.begin(), allowed_origins.end(), origin) !=
           allowed_origins.end();
}

} // namespace liveplay::net::security
