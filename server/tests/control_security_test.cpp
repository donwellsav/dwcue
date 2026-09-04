#include "liveplay/net/control_security.hpp"
#include "liveplay/crash_handler.hpp"

#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <iterator>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <process.h>
#else
#include <sys/wait.h>
#include <unistd.h>
#endif

int main(int argc, char** argv) {
    using namespace liveplay::net::security;

    if (argc == 2 &&
        std::string_view{argv[1]} == "--check-restart-token-env") {
        const char* token = std::getenv("LIVEPLAY_ACCESS_TOKEN");
        return token && std::string_view{token} == "restart-token-0123456789"
                   ? 0 : 1;
    }

    char executable[] = "/Applications/DonWells Cue.app/Contents/MacOS/server";
    char bind_flag[] = "--bind";
    char bind_value[] = "0.0.0.0";
    char pid_flag[] = "--pidfile";
    char pid_value[] = "/tmp/DW Cue.pid";
    char instance_flag[] = "--instance-token";
    char instance_value[] = "0123456789abcdef0123456789abcdef";
    char origin_flag[] = "--origin";
    char origin_value[] = "literal ; $(not-a-command)";
    char delay_flag[] = "--start-delay-ms";
    char delay_value[] = "5000";
    char* restart_argv[] = {
        executable, bind_flag, bind_value, pid_flag, pid_value,
        instance_flag, instance_value,
        origin_flag, origin_value, delay_flag, delay_value};
    const auto restart_args = liveplay::crash_restart::filtered_arguments(
        static_cast<int>(std::size(restart_argv)), restart_argv);
    assert((restart_args == std::vector<std::string>{
        "--bind", "0.0.0.0", "--pidfile", "/tmp/DW Cue.pid",
        "--instance-token", "0123456789abcdef0123456789abcdef",
        "--origin", "literal ; $(not-a-command)"}));
    assert(liveplay::crash_restart::quote_windows_argument(
               R"(C:\Program Files\DW Cue\)") ==
           R"("C:\Program Files\DW Cue\\")");
    assert(liveplay::crash_restart::quote_windows_argument(
               R"(value "quoted")") ==
           R"("value \"quoted\"")");
    assert(liveplay::crash_restart::quote_windows_argument(
               LR"(C:\Program Files\DönWells Cue\)") ==
           LR"("C:\Program Files\DönWells Cue\\")");

    assert(is_loopback_address("127.0.0.1"));
    assert(is_loopback_address("127.255.255.255"));
    assert(is_loopback_address("::1"));
    assert(!is_loopback_address("127.example.com"));
    assert(!is_loopback_address("127.0.0.1."));
    assert(!is_loopback_address("0.0.0.0"));
    assert(!is_loopback_address("192.168.1.20"));
    assert(constant_time_equal("0123456789abcdef", "0123456789abcdef"));
    assert(!constant_time_equal("0123456789abcdeg", "0123456789abcdef"));
    assert(!constant_time_equal("short", "0123456789abcdef"));
    assert(!constant_time_equal(std::string(272, '\0'),
                                std::string(16, '\0')));

    const std::string expected_token = "0123456789abcdef0123456789abcdef";
    assert(access_token_authorized(
        expected_token, "Bearer 0123456789abcdef0123456789abcdef"));
    assert(access_token_authorized(
        expected_token, "", "0123456789abcdef0123456789abcdef"));
    assert(!access_token_authorized(expected_token, "Bearer wrong"));
    assert(!access_token_authorized(expected_token, "", "wrong"));
    assert(!access_token_authorized("", "Bearer ", ""));
    assert(!access_token_authorized("short", "Bearer short"));

    const std::vector<std::string> extra{
        "http://localhost:3000", "https://controller.example"};
    assert(origin_allowed("", extra));
    assert(origin_allowed("null", extra));
    assert(origin_allowed("http://localhost:3000", extra));
    assert(origin_allowed("https://controller.example", extra));
    assert(!origin_allowed("file://", extra));
    assert(!origin_allowed("http://localhost:3001", extra));
    assert(!origin_allowed("https://127.0.0.1:8443", extra));
    assert(!origin_allowed("https://localhost.example", extra));
    assert(!origin_allowed("https://evil.example", extra));

    assert(!upload_exceeds_limit(256, "256", 256));
    assert(upload_exceeds_limit(257, "", 256));
    assert(upload_exceeds_limit(0, "257", 256));
    assert(!upload_exceeds_limit(0, "not-a-number", 256));

    const std::string random_token = random_hex_token(32);
    assert(random_token.size() == 64);
    assert(random_token.find_first_not_of("0123456789abcdef") ==
           std::string::npos);

    std::uint64_t parsed_u64 = 0;
    assert(parse_decimal_u64("0", parsed_u64) && parsed_u64 == 0);
    assert(parse_decimal_u64("4194304", parsed_u64) &&
           parsed_u64 == 4'194'304);
    assert(!parse_decimal_u64("", parsed_u64));
    assert(!parse_decimal_u64("12x", parsed_u64));

    assert(sanitize_upload_filename(
               R"(..\folder/mixdown.wav)") == "mixdown.wav");
    assert(sanitize_upload_filename(
               std::string{"bad\0name", 8}) == "badname");
    assert(sanitize_upload_filename("..") == "upload.bin");
    assert(sanitize_upload_filename("CON.wav") == "_CON.wav");
    assert(sanitize_upload_filename("mix:take?.wav") == "mix_take_.wav");
    assert(sanitize_upload_filename("trailing. ") == "trailing");
    const std::string long_upload_name =
        sanitize_upload_filename(std::string(255, 'a') + ".wav");
    assert(long_upload_name.size() == 200);
    assert(long_upload_name.ends_with(".wav"));
    const std::string unicode_upload_name =
        sanitize_upload_filename(std::string(199, 'a') + "\xc3\xa9.lpa");
    assert(unicode_upload_name.size() <= 200);
    assert(unicode_upload_name.ends_with(".lpa"));
    assert(unicode_upload_name.find("\xc3\xa9") == std::string::npos);
    assert(is_chunked_upload_staging_name(
        ".dwcue-upload-0123456789abcdef0123456789abcdef"
        "0123456789abcdef0123456789abcdef.part"));
    assert(!is_chunked_upload_staging_name(
        ".dwcue-upload-0123456789ABCDEF0123456789abcdef"
        "0123456789abcdef0123456789abcdef.part"));
    assert(!is_chunked_upload_staging_name(".dwcue-upload-short.part"));
    assert(is_export_staging_name(
        ".dwcue-export-0123456789abcdef0123456789abcdef"
        "0123456789abcdef0123456789abcdef.part"));
    assert(!is_export_staging_name(".dwcue-export-short.part"));
    assert(is_export_archive_name(
        "0123456789abcdef0123456789abcdef"
        "0123456789abcdef0123456789abcdef.lpa"));
    assert(!is_export_archive_name(
        "0123456789ABCDEF0123456789abcdef"
        "0123456789abcdef0123456789abcdef.lpa"));
    assert(!is_export_archive_name("short.lpa"));
    assert(valid_chunked_upload_purpose(""));
    assert(valid_chunked_upload_purpose("media"));
    assert(valid_chunked_upload_purpose("project_import"));
    assert(!valid_chunked_upload_purpose("video"));
    assert(chunked_upload_should_purge(true, false, true));
    assert(chunked_upload_should_purge(false, true, false));
    assert(!chunked_upload_should_purge(false, true, true));
    assert(!chunked_upload_should_purge(false, false, false));

    const char* prior_token_env = std::getenv("LIVEPLAY_ACCESS_TOKEN");
    const bool had_prior_token = prior_token_env != nullptr;
    const std::string prior_token = prior_token_env ? prior_token_env : "";
    assert(persist_access_token_for_restart("restart-token-0123456789"));
    const char* persisted_token = std::getenv("LIVEPLAY_ACCESS_TOKEN");
    assert(persisted_token);
    assert(std::string_view{persisted_token} == "restart-token-0123456789");
#if defined(_WIN32)
    assert(::_spawnl(_P_WAIT, argv[0], argv[0],
                     "--check-restart-token-env", nullptr) == 0);
    assert(::_putenv_s("LIVEPLAY_ACCESS_TOKEN", prior_token.c_str()) == 0);
#else
    const pid_t child = ::fork();
    assert(child >= 0);
    if (child == 0) {
        ::execl(argv[0], argv[0], "--check-restart-token-env",
                static_cast<char*>(nullptr));
        ::_exit(127);
    }
    int child_status = 0;
    assert(::waitpid(child, &child_status, 0) == child);
    assert(WIFEXITED(child_status) && WEXITSTATUS(child_status) == 0);
    if (had_prior_token)
        assert(::setenv("LIVEPLAY_ACCESS_TOKEN", prior_token.c_str(), 1) == 0);
    else
        assert(::unsetenv("LIVEPLAY_ACCESS_TOKEN") == 0);
#endif

    assert(normalize_archive_entry_path("media/song.wav") ==
           std::optional<std::string>{"media/song.wav"});
    assert(normalize_archive_entry_path("media\\song.wav") ==
           std::optional<std::string>{"media/song.wav"});
    assert(!normalize_archive_entry_path("../outside"));
    assert(!normalize_archive_entry_path("folder/../../outside"));
    assert(!normalize_archive_entry_path("folder\\..\\outside"));
    assert(!normalize_archive_entry_path("/absolute/path"));
    assert(!normalize_archive_entry_path("\\\\server\\share\\file"));
    assert(!normalize_archive_entry_path("\\\\?\\C:\\file"));
    assert(!normalize_archive_entry_path("C:\\file"));
    assert(!normalize_archive_entry_path("C:file"));
    assert(!normalize_archive_entry_path("file:alternate-stream"));
    assert(!normalize_archive_entry_path("folder/./file"));
    assert(!normalize_archive_entry_path(""));
    assert(!normalize_archive_entry_path(std::string{"a\0b", 3}));
    assert(!normalize_archive_entry_path(
        std::string(kMaxArchivePathBytes + 1, 'a')));

    constexpr std::uint16_t unix_host = 3u << 8;
    assert(archive_entry_type_is_safe(
        unix_host, static_cast<std::uint32_t>(0100644u) << 16, false));
    assert(archive_entry_type_is_safe(
        unix_host, static_cast<std::uint32_t>(0040755u) << 16, true));
    assert(!archive_entry_type_is_safe(
        unix_host, static_cast<std::uint32_t>(0120777u) << 16, false));
    assert(!archive_entry_type_is_safe(0, 0x00000400u, false));

    ArchiveBudget normal_budget;
    assert(!charge_archive_entry(normal_budget, 1, 1'000, false));
    assert(normal_budget.entries == 1);
    assert(normal_budget.expanded_bytes == 1'000);

    ArchiveBudget count_budget;
    count_budget.entries = kMaxArchiveEntries;
    assert(charge_archive_entry(count_budget, 1, 1, false));

    ArchiveBudget file_budget;
    assert(charge_archive_entry(
        file_budget, kMaxArchiveFileBytes,
        kMaxArchiveFileBytes + 1, false));

    ArchiveBudget total_budget;
    total_budget.expanded_bytes = kMaxArchiveExpandedBytes - 1;
    assert(charge_archive_entry(total_budget, 1, 2, false));

    ArchiveBudget zero_compressed_budget;
    assert(charge_archive_entry(zero_compressed_budget, 0, 1, false));

    ArchiveBudget ratio_budget;
    assert(charge_archive_entry(
        ratio_budget, 1, kMaxArchiveCompressionRatio + 1, false));

    namespace fs = std::filesystem;
    const fs::path test_base =
        fs::temp_directory_path() /
        ("dwcue-control-security-" + std::to_string(
            std::chrono::steady_clock::now().time_since_epoch().count()));
    const fs::path root = test_base / "root";
    const fs::path outside = test_base / "outside";
    fs::create_directories(root);
    fs::create_directories(outside);
    const fs::path canonical_root = fs::canonical(root);
    assert(canonical_path_is_within(
        canonical_root, fs::weakly_canonical(root / "media" / "song.wav")));
    assert(!canonical_path_is_within(
        canonical_root, fs::weakly_canonical(outside / "song.wav")));

    std::error_code ec;
    fs::create_directory_symlink(outside, root / "linked", ec);
    if (!ec) {
        assert(!canonical_path_is_within(
            canonical_root,
            fs::weakly_canonical(root / "linked" / "escaped.wav")));
    }
    fs::remove_all(test_base, ec);
}
