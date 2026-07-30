// ============================================================================
// main.cpp — DonWells Cue server entrypoint
// ----------------------------------------------------------------------------
// Milestone 1 deliverable: bring the binary up, print the startup banner, run
// the colour-coded logger through its paces, and idle on a clean shutdown
// signal. The audio engine (Milestone 2) and networking layer (Milestone 3)
// plug in at the marked extension points.
// ============================================================================
#include "liveplay/audio/engine.hpp"
#include "liveplay/core/backup_manager.hpp"
#include "liveplay/core/project_state.hpp"
#include "liveplay/crash_handler.hpp"
#include "liveplay/logger.hpp"
#include "liveplay/util/unicode_path.hpp"
#include "liveplay/net/control_server.hpp"
#include "liveplay/net/control_security.hpp"
#include "liveplay/net/discovery.hpp"

#include <nlohmann/json.hpp>

#include <atomic>
#include <algorithm>
#include <charconv>
#include <chrono>
#include <cctype>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#if defined(_WIN32)
    #include <winsock2.h>
    #include <ws2tcpip.h>
    #include <iphlpapi.h>
    #include <windows.h>
    #pragma comment(lib, "iphlpapi.lib")
    #pragma comment(lib, "ws2_32.lib")
#else
    #include <arpa/inet.h>
    #include <ifaddrs.h>
    #include <net/if.h>        // IFF_UP, IFF_LOOPBACK (macOS/BSD don't expose
                               // these via <sys/socket.h> the way Linux does)
    #include <netdb.h>
    #include <netinet/in.h>
    #include <sys/socket.h>
    #include <sys/stat.h>
    #include <sys/types.h>
    #include <unistd.h>
#  if defined(__APPLE__)
#    include <mach-o/dyld.h>   // _NSGetExecutablePath
#  endif
#endif

#ifndef LIVEPLAY_SERVER_VERSION
#define LIVEPLAY_SERVER_VERSION "0.0.0"
#endif
#ifndef LIVEPLAY_SERVER_NAME
#define LIVEPLAY_SERVER_NAME "dwcue-server"
#endif

namespace {

// Default control-surface port. Overridable via --port or LIVEPLAY_PORT.
constexpr int kDefaultPort = 4480;
constexpr int kMaxStartDelayMs = 60'000;

bool replace_file_atomically(const std::filesystem::path& source,
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

// Windows invokes its console handler on a separate thread. POSIX signal
// handlers require the narrower signal-safe sig_atomic_t instead.
#if defined(_WIN32)
std::atomic_bool g_running{true};
void request_stop() noexcept { g_running.store(false, std::memory_order_relaxed); }
bool should_keep_running() noexcept {
    return g_running.load(std::memory_order_relaxed);
}
#else
volatile std::sig_atomic_t g_running = 1;
void request_stop() noexcept { g_running = 0; }
bool should_keep_running() noexcept { return g_running != 0; }
#endif

extern "C" void handle_signal(int sig) {
    // Stay async-signal-safe on POSIX; defer the actual logging.
    (void)sig;
    request_stop();
}

#if defined(_WIN32)
// Handle CTRL_CLOSE_EVENT (user closes the console window) and CTRL_BREAK_EVENT
// gracefully. Without this handler Windows hard-kills the process after 5 s with
// no crash log and no auto-restart — the same symptom the user sees as "server
// crashed with no logs". Must use WINAPI (__stdcall) calling convention.
static BOOL WINAPI console_ctrl_handler(DWORD type) {
    if (type == CTRL_CLOSE_EVENT || type == CTRL_BREAK_EVENT) {
        request_stop();
        // Sleep just under Windows' 5-second kill window so the main loop has
        // time to complete the clean-shutdown sequence before we return.
        std::this_thread::sleep_for(std::chrono::milliseconds(4500));
        return TRUE;
    }
    return FALSE; // pass CTRL_C through to the default SIGINT handler
}
#endif

void install_signal_handlers() {
    std::signal(SIGINT,  handle_signal);
    std::signal(SIGTERM, handle_signal);
#if defined(SIGHUP)
    std::signal(SIGHUP,  handle_signal);
#endif
#if defined(SIGPIPE)
    // Ignore SIGPIPE so that writing to a closed socket returns EPIPE instead
    // of killing the process.  Without this, the broadcast thread can be
    // terminated silently (no crash handler, no restart) the moment a client
    // disconnects while a write is in-flight — particularly likely on loopback
    // where the TCP teardown and new-connection handshake arrive almost
    // simultaneously.
    std::signal(SIGPIPE, SIG_IGN);
#endif
#if defined(_WIN32)
    SetConsoleCtrlHandler(&console_ctrl_handler, TRUE);
#endif
}

// Best-effort discovery of a routable IPv4 address. Falls back to 127.0.0.1
// when nothing better is available (e.g. machines with only loopback).
std::string discover_local_ipv4() {
#if defined(_WIN32)
    WSADATA wsa{};
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return "127.0.0.1";

    ULONG buf_len = 15000;
    std::string buffer;
    buffer.resize(buf_len);
    auto* addrs = reinterpret_cast<PIP_ADAPTER_ADDRESSES>(buffer.data());
    DWORD rv = GetAdaptersAddresses(AF_INET,
                                    GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST |
                                        GAA_FLAG_SKIP_DNS_SERVER,
                                    nullptr, addrs, &buf_len);
    std::string result = "127.0.0.1";
    if (rv == NO_ERROR) {
        for (auto* a = addrs; a; a = a->Next) {
            if (a->OperStatus != IfOperStatusUp) continue;
            if (a->IfType == IF_TYPE_SOFTWARE_LOOPBACK) continue;
            for (auto* u = a->FirstUnicastAddress; u; u = u->Next) {
                auto* sa = reinterpret_cast<sockaddr_in*>(u->Address.lpSockaddr);
                char buf[INET_ADDRSTRLEN] = {0};
                if (inet_ntop(AF_INET, &sa->sin_addr, buf, sizeof(buf))) {
                    result = buf;
                    break;
                }
            }
            if (result != "127.0.0.1") break;
        }
    }
    WSACleanup();
    return result;
#else
    struct ifaddrs* ifap = nullptr;
    if (getifaddrs(&ifap) != 0 || !ifap) return "127.0.0.1";
    std::string result = "127.0.0.1";
    for (auto* ifa = ifap; ifa; ifa = ifa->ifa_next) {
        if (!ifa->ifa_addr || ifa->ifa_addr->sa_family != AF_INET) continue;
        if (!(ifa->ifa_flags & IFF_UP) || (ifa->ifa_flags & IFF_LOOPBACK)) continue;
        char buf[INET_ADDRSTRLEN] = {0};
        auto* sa = reinterpret_cast<sockaddr_in*>(ifa->ifa_addr);
        if (inet_ntop(AF_INET, &sa->sin_addr, buf, sizeof(buf))) {
            result = buf;
            break;
        }
    }
    freeifaddrs(ifap);
    return result;
#endif
}

const char* platform_tag() {
#if defined(_WIN32)
    return "Windows";
#elif defined(__APPLE__)
    return "macOS";
#elif defined(__linux__)
    return "Linux";
#else
    return "Unknown";
#endif
}

// Compose-and-print the startup banner. The logger lets us push raw ANSI lines
// straight through; we just build the strings here.
void print_banner(const std::string& bind_iface, int port) {
    using namespace liveplay;

    constexpr std::string_view C_RESET = "\033[0m";
    constexpr std::string_view C_BOLD  = "\033[1m";
    constexpr std::string_view C_DIM   = "\033[2m";
    constexpr std::string_view C_BLUE  = "\033[38;5;69m";
    constexpr std::string_view C_GREEN = "\033[32m";
    // ASCII-art play-button-in-circle — same design language as the SVG icon.
    Logger::raw("");
    Logger::raw(std::string{C_RESET} + "  ▶" + std::string{C_BLUE} + "⬤" + std::string{C_RESET});
    Logger::raw("");

    Logger::raw(std::string{C_BOLD} + "  DW Cue Server " + std::string{C_RESET} +
                std::string{C_DIM} + "v" + LIVEPLAY_SERVER_VERSION + std::string{C_RESET} +
                std::string{C_DIM} + "  (" + platform_tag() + ")" + std::string{C_RESET});
    Logger::raw(std::string{C_DIM} +
                "  Open-source audio playback engine for live sound operators" +
                std::string{C_RESET});
    Logger::raw("");
    Logger::raw(std::string{C_DIM} + "  Repository  " + std::string{C_RESET} +
                "https://github.com/tdoukinitsas/liveplay");
    Logger::raw(std::string{C_DIM} + "  License     " + std::string{C_RESET} +
                "AGPL-3.0-only");
    Logger::raw(std::string{C_DIM} + "  Authors     " + std::string{C_RESET} +
                "Thomas Doukinitsas & contributors");
    Logger::raw("");
    Logger::rule();
    Logger::raw("");

    // Connection instructions block.
    const std::string lan_ip = discover_local_ipv4();
    Logger::raw(std::string{C_GREEN} + std::string{C_BOLD} +
                "  Listening" + std::string{C_RESET});
    Logger::raw("    REST       " + std::string{C_BOLD} + "http://" +
                bind_iface + ":" + std::to_string(port) + std::string{C_RESET});
    Logger::raw("    WebSocket  " + std::string{C_BOLD} + "ws://" +
                bind_iface + ":" + std::to_string(port) + "/ws" + std::string{C_RESET});
    if (liveplay::net::security::is_loopback_address(bind_iface)) {
        Logger::raw("    Scope      " + std::string{C_DIM} +
                    "local computer only" + std::string{C_RESET});
    } else {
        Logger::raw("    LAN reach  " + std::string{C_BOLD} + "http://" + lan_ip +
                    ":" + std::to_string(port) + std::string{C_RESET});
        Logger::raw("");
        Logger::raw(std::string{C_BLUE} + std::string{C_BOLD} +
                    "  Connect a DonWells Cue client" + std::string{C_RESET});
        Logger::raw(std::string{C_RESET} +
                    "    1) Launch the DonWells Cue desktop client on this network." +
                    std::string{C_RESET});
        Logger::raw(std::string{C_RESET} +
                    "    2) On the welcome screen, select Remote and either use auto discovery or enter the Server Address:" +
                    std::string{C_BLUE});
        Logger::raw("       " + std::string{C_BOLD} + lan_ip + ":" +
                    std::to_string(port) + std::string{C_RESET});
    }
    Logger::raw(std::string{C_RESET} +
                "    Close this window to stop the server." +
                std::string{C_RESET});
    Logger::raw("");
    Logger::rule();
    Logger::raw("");
}

struct CliOptions {
    int         port      = kDefaultPort;
    std::string bind_addr = "127.0.0.1";
    std::string access_token;
    std::string instance_token;
    std::vector<std::string> allowed_origins;
    std::string pidfile;                   // optional; if set, write JSON {pid,port,startedAt}
    bool        verbose   = false;
    int         start_delay_ms = 0;        // wait before binding (crash-restart uses this)
    std::string error;
};

// Crash-resume state read from .crash-resume.json on startup.
struct CrashResume {
    std::string project_file;
    std::string item_uuid;
    double      position_sec = 0.0;
};

CliOptions parse_cli(int argc, char** argv) {
    CliOptions opts;
    const char* env_port_value = std::getenv("LIVEPLAY_PORT");
    const std::string env_port = env_port_value ? env_port_value : "";
    bool port_set_by_cli = false;
    if (const char* env_token = std::getenv("LIVEPLAY_ACCESS_TOKEN"))
        opts.access_token = env_token;
    if (const char* env_origins = std::getenv("LIVEPLAY_ALLOWED_ORIGINS")) {
        std::string list = env_origins;
        for (std::size_t start = 0; start <= list.size();) {
            const auto comma = list.find(',', start);
            auto value = list.substr(start, comma == std::string::npos
                                               ? std::string::npos
                                               : comma - start);
            const auto first = value.find_first_not_of(" \t");
            const auto last  = value.find_last_not_of(" \t");
            if (first != std::string::npos)
                opts.allowed_origins.push_back(value.substr(first, last - first + 1));
            if (comma == std::string::npos) break;
            start = comma + 1;
        }
    }
    for (int i = 1; i < argc; ++i) {
        std::string_view a{argv[i]};
        const auto next = [&](int& dst, std::string_view option) {
            if (i + 1 >= argc) {
                if (opts.error.empty())
                    opts.error = std::string{option} + " requires an integer value";
                return;
            }
            const std::string_view value{argv[++i]};
            int parsed = 0;
            const auto [end, error] = std::from_chars(
                value.data(), value.data() + value.size(), parsed);
            if (error != std::errc{} || end != value.data() + value.size()) {
                if (opts.error.empty())
                    opts.error = std::string{option} + " must be an integer";
                return;
            }
            dst = parsed;
        };
        if (a == "--port" || a == "-p") {
            port_set_by_cli = true;
            next(opts.port, a);
        } else if (a == "--bind" || a == "-b") {
            if (i + 1 < argc) opts.bind_addr = argv[++i];
        } else if (a == "--pidfile") {
            if (i + 1 < argc) opts.pidfile = argv[++i];
        } else if (a == "--instance-token") {
            if (i + 1 < argc) {
                opts.instance_token = argv[++i];
            } else if (opts.error.empty()) {
                opts.error = "--instance-token requires a value";
            }
        } else if (a == "--start-delay-ms") {
            next(opts.start_delay_ms, a);
        } else if (a == "--verbose" || a == "-v") {
            opts.verbose = true;
        } else if (a == "--help" || a == "-h") {
            std::printf(
                "Usage: %s [options]\n"
                "  -p, --port <port>     Port to listen on (default %d)\n"
                "  -b, --bind <addr>     Interface to bind (default 127.0.0.1)\n"
                "                         Non-loopback generates a session token;\n"
                "                         set LIVEPLAY_ACCESS_TOKEN (16+ chars) to supply one\n"
                "      LIVEPLAY_ALLOWED_ORIGINS  Comma-separated browser origins\n"
                "      --pidfile <path>  Write JSON process identity after binding\n"
                "      --instance-token <32 hex chars>  Launcher process identity\n"
                "      --start-delay-ms <n>  Wait <n> ms before binding (used by crash-restart)\n"
                "  -v, --verbose         Enable debug-level logging\n"
                "  -h, --help            Show this help and exit\n",
                LIVEPLAY_SERVER_NAME, kDefaultPort);
            std::exit(0);
        }
    }
    if (!port_set_by_cli && !env_port.empty()) {
        int parsed = 0;
        const auto [end, error] = std::from_chars(
            env_port.data(), env_port.data() + env_port.size(), parsed);
        if (error != std::errc{} || end != env_port.data() + env_port.size()) {
            if (opts.error.empty())
                opts.error = "LIVEPLAY_PORT must be an integer";
        } else {
            opts.port = parsed;
        }
    }
    return opts;
}

// ---------------------------------------------------------------------------
// Port conflict helpers
// ---------------------------------------------------------------------------

// Returns true if the given address:port is already bound by another process.
static bool is_port_in_use(const std::string& addr, uint16_t port) {
#if defined(_WIN32)
    SOCKET s = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return false;
    BOOL opt = TRUE;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&opt), sizeof(opt));
    sockaddr_in sa{};
    sa.sin_family = AF_INET;
    sa.sin_port   = htons(port);
    inet_pton(AF_INET, addr.c_str(), &sa.sin_addr);
    bool in_use = (::bind(s, reinterpret_cast<sockaddr*>(&sa), sizeof(sa)) == SOCKET_ERROR);
    ::closesocket(s);
    return in_use;
#else
    int s = ::socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) return false;
    int opt = 1;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    sockaddr_in sa{};
    sa.sin_family = AF_INET;
    sa.sin_port   = htons(port);
    inet_pton(AF_INET, addr.c_str(), &sa.sin_addr);
    bool in_use = (::bind(s, reinterpret_cast<sockaddr*>(&sa), sizeof(sa)) != 0);
    ::close(s);
    return in_use;
#endif
}

static std::optional<std::filesystem::path> writable_state_directory(
    const CliOptions& opts) {
    namespace fs = std::filesystem;

    const auto ensure = [](fs::path dir)
        -> std::optional<fs::path> {
        if (dir.empty()) return std::nullopt;
        std::error_code ec;
        fs::create_directories(dir, ec);
        if (ec || !fs::is_directory(dir, ec)) return std::nullopt;
        const fs::path resolved = fs::weakly_canonical(dir, ec);
        return ec ? std::optional<fs::path>{std::move(dir)}
                  : std::optional<fs::path>{resolved};
    };

    // Electron places its pidfile in userData. Sharing that parent keeps the
    // lock, crash state, and logs together and writable across upgrades.
    if (!opts.pidfile.empty()) {
        std::error_code ec;
        fs::path pidfile =
            fs::absolute(liveplay::util::utf8_to_path(opts.pidfile), ec);
        if (!ec) {
            if (auto dir = ensure(pidfile.parent_path())) return dir;
        }
    }

#if defined(_WIN32)
    if (const wchar_t* configured = ::_wgetenv(L"LIVEPLAY_STATE_DIR")) {
        if (auto dir = ensure(fs::path{configured})) return dir;
    }
    if (const wchar_t* local = ::_wgetenv(L"LOCALAPPDATA")) {
        if (auto dir = ensure(
                fs::path{local} / L"DonWells Cue" / L"server")) {
            return dir;
        }
    }
#elif defined(__APPLE__)
    if (const char* configured = std::getenv("LIVEPLAY_STATE_DIR")) {
        if (auto dir = ensure(fs::path{configured})) return dir;
    }
    if (const char* home = std::getenv("HOME")) {
        if (auto dir = ensure(
                fs::path{home} / "Library" / "Application Support" /
                "DonWells Cue" / "server")) {
            return dir;
        }
    }
#else
    if (const char* configured = std::getenv("LIVEPLAY_STATE_DIR")) {
        if (auto dir = ensure(fs::path{configured})) return dir;
    }
    if (const char* xdg = std::getenv("XDG_STATE_HOME")) {
        if (auto dir = ensure(fs::path{xdg} / "dwcue")) return dir;
    }
    if (const char* home = std::getenv("HOME")) {
        if (auto dir = ensure(
                fs::path{home} / ".local" / "state" / "dwcue")) {
            return dir;
        }
    }
#endif

    std::error_code ec;
    fs::path temp = fs::temp_directory_path(ec);
    if (ec) return std::nullopt;
#if defined(_WIN32)
    temp /= L"dwcue-server-state";
#else
    temp /= "dwcue-server-state-" + std::to_string(
        static_cast<unsigned long long>(::getuid()));
#endif
    const fs::path temp_candidate = temp;
    auto dir = ensure(std::move(temp));
#if !defined(_WIN32)
    // ponytail: the fixed per-user fallback is simpler than inventing another
    // persistence mechanism, but only trust it when it is a real directory
    // owned by this user rather than a pre-planted /tmp symlink.
    if (dir) {
        struct stat st {};
        if (::lstat(temp_candidate.c_str(), &st) != 0 ||
            !S_ISDIR(st.st_mode) ||
            st.st_uid != ::getuid() ||
            ::chmod(temp_candidate.c_str(), S_IRWXU) != 0) {
            return std::nullopt;
        }
    }
#endif
    return dir;
}

} // namespace

int main(int argc, char** argv) {
    using namespace liveplay;
    namespace audio = liveplay::audio;
    namespace core  = liveplay::core;
    namespace net   = liveplay::net;

#if defined(_WIN32)
    SetConsoleTitle(L"DW Cue Server");
    // Set the taskbar icon to the embedded IDI_APPICON resource. Console
    // windows use conhost.exe's icon by default; we must push ours explicitly.
    {
        // Resource ordinal 1 matches IDI_APPICON from winresrc.h / server.rc
        HICON hIcon = static_cast<HICON>(
            LoadImage(GetModuleHandle(nullptr), MAKEINTRESOURCE(1),
                      IMAGE_ICON, 0, 0, LR_DEFAULTSIZE | LR_SHARED));
        if (hIcon) {
            HWND hwnd = GetConsoleWindow();
            if (hwnd) {
                SendMessage(hwnd, WM_SETICON, ICON_BIG,   reinterpret_cast<LPARAM>(hIcon));
                SendMessage(hwnd, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(hIcon));
            }
        }
    }
#endif

    Logger::init();
    CliOptions opts = parse_cli(argc, argv);
    if (!opts.error.empty()) {
        Logger::error("{}", opts.error);
        return 2;
    }
    if (opts.port < 1 || opts.port > 65'535) {
        Logger::error("Port must be in the range 1..65535.");
        return 2;
    }
    if (opts.start_delay_ms < 0 ||
        opts.start_delay_ms > kMaxStartDelayMs) {
        Logger::error("--start-delay-ms must be in the range 0..{}.",
                      kMaxStartDelayMs);
        return 2;
    }
    if (!opts.instance_token.empty() &&
        (opts.instance_token.size() != 32 ||
         !std::all_of(opts.instance_token.begin(), opts.instance_token.end(),
                      [](unsigned char c) {
                          return std::isdigit(c) != 0 ||
                                 (c >= 'a' && c <= 'f');
                      }))) {
        Logger::error("--instance-token must be exactly 32 lowercase hex characters.");
        return 2;
    }
    if (opts.verbose) Logger::set_min_level(LogLevel::Debug);
    const bool lan_mode = !net::security::is_loopback_address(opts.bind_addr);
    if (lan_mode && !opts.access_token.empty() && opts.access_token.size() < 16) {
        Logger::error(
            "Refusing non-loopback bind '{}': LIVEPLAY_ACCESS_TOKEN "
            "must be at least 16 characters.", opts.bind_addr);
        return 2;
    }
    if (lan_mode && opts.access_token.empty()) {
        try {
            opts.access_token = net::security::random_hex_token(16);
        } catch (const std::exception& e) {
            Logger::error("Could not generate a LAN access token: {}", e.what());
            return 2;
        }
        // Logger file output is configured later, deliberately: this
        // session-only credential is shown once in the visible console.
        Logger::raw("");
        Logger::raw("  LAN access token (shown once): " + opts.access_token);
        Logger::raw("");
        if (!net::security::persist_access_token_for_restart(opts.access_token)) {
            Logger::error(
                "Could not preserve the generated LAN access token for crash restart.");
            return 2;
        }
    }

    // ------------------------------------------------------------------
    // Locate our own executable; used by crash handler for auto-restart.
    // ------------------------------------------------------------------
    std::filesystem::path exe_path;
    {
        std::error_code ec;
#if defined(_WIN32)
        std::wstring exe_path_w(32'768, L'\0');
        const DWORD length = GetModuleFileNameW(
            nullptr, exe_path_w.data(),
            static_cast<DWORD>(exe_path_w.size()));
        if (length > 0 && length < exe_path_w.size()) {
            exe_path_w.resize(length);
            exe_path = std::filesystem::path{exe_path_w};
        }
#elif defined(__linux__)
        char buf[4096] = {};
        const ssize_t n = ::readlink("/proc/self/exe", buf, sizeof(buf) - 1);
        if (n > 0) {
            exe_path = std::filesystem::path{
                std::string{buf, static_cast<std::size_t>(n)}};
        }
#elif defined(__APPLE__)
        {
            uint32_t sz = 4096;
            std::string p(sz, '\0');
            if (_NSGetExecutablePath(p.data(), &sz) != 0) {
                p.assign(sz, '\0');
            }
            if (_NSGetExecutablePath(p.data(), &sz) == 0) {
                p.resize(std::strlen(p.c_str()));
                exe_path = std::filesystem::path{p};
            }
        }
#endif
        if (exe_path.empty() && argv && argv[0]) {
            exe_path = std::filesystem::absolute(
                liveplay::util::utf8_to_path(argv[0]), ec);
            if (ec) exe_path = liveplay::util::utf8_to_path(argv[0]);
        }
    }

    // Preserve the original argv boundaries for a shell-free crash restart.
    // Keep --pidfile so the replacement publishes its new PID; only the
    // one-shot restart delay is replaced.
    const auto restart_args =
        crash_restart::filtered_arguments(argc, argv);
    const std::filesystem::path pidfile_path =
        opts.pidfile.empty()
            ? std::filesystem::path{}
            : liveplay::util::utf8_to_path(opts.pidfile);

    const auto state_dir_opt = writable_state_directory(opts);
    if (!state_dir_opt) {
        Logger::error("Could not create a writable server state directory.");
        return 2;
    }
    const std::filesystem::path state_dir = *state_dir_opt;
    const std::filesystem::path crash_logs_dir = state_dir / "crash-logs";
    const std::filesystem::path crash_count_path = state_dir / ".crash-count";
    const std::filesystem::path crash_resume_path =
        state_dir / ".crash-resume.json";

    set_crash_exe_info(exe_path, restart_args, crash_resume_path);
    install_crash_handlers(crash_logs_dir);

    // Mirror the session to a persistent, size-rotated log file so operators
    // have history even when stdout isn't captured (server launched by the
    // Electron client). Best-effort; console logging is unaffected on failure.
    Logger::set_log_file(state_dir / "logs" / "dwcue-server.log");

    // Crash-loop protection. Read the persisted consecutive-crash count left by
    // any crashing predecessor; after kMaxConsecutiveCrashes back-to-back
    // crashes the handler stops auto-restarting so a deterministic fault (e.g. a
    // bad crash-resume project) can't relaunch forever. The count is reset once
    // this instance has run healthily (see the heartbeat loop) or shuts cleanly.
    constexpr int kMaxConsecutiveCrashes = 5;
    constexpr int kCrashGuardHealthySec  = 30;
    int prior_crash_count = 0;
    {
        std::ifstream cf{crash_count_path};
        int v = 0;
        if (cf && (cf >> v) && v > 0) prior_crash_count = v;
    }
    set_crash_restart_guard(crash_count_path,
                            prior_crash_count, kMaxConsecutiveCrashes);
    if (prior_crash_count > 0) {
        Logger::warn("Recovered from a crash ({} consecutive). Auto-restart disables after {}.",
                     prior_crash_count, kMaxConsecutiveCrashes);
    }
    // Keep only the most recent crash logs in the writable state directory.
    prune_crash_logs(crash_logs_dir, 20);

    // ------------------------------------------------------------------
    // Check for a crash-resume file left by a previous crashed instance.
    // ------------------------------------------------------------------
    std::optional<CrashResume> crash_resume;
    {
        std::error_code ec;
        if (std::filesystem::exists(crash_resume_path, ec)) {
            try {
                std::ifstream f{crash_resume_path};
                if (f) {
                    nlohmann::json j = nlohmann::json::parse(f, nullptr, false);
                    if (!j.is_discarded()) {
                        CrashResume cr;
                        cr.project_file  = j.value("projectFile",  std::string{});
                        cr.item_uuid     = j.value("itemUuid",      std::string{});
                        cr.position_sec  = j.value("positionSec",   0.0);
                        if (!cr.project_file.empty()) {
                            crash_resume = std::move(cr);
                            Logger::warn("Crash-resume: reloading '{}' and resuming playback.",
                                         crash_resume->project_file);
                        }
                    }
                }
            } catch (...) {}
            std::filesystem::remove(crash_resume_path, ec);  // consume it
        }
    }

    install_signal_handlers();

    const long long process_id =
#if defined(_WIN32)
        static_cast<long long>(GetCurrentProcessId());
#else
        static_cast<long long>(::getpid());
#endif
    const auto pidfile_started_at =
        std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();

    const auto write_pidfile = [&] {
        if (opts.pidfile.empty()) return;
        try {
            nlohmann::json j{
                {"pid", process_id},
                {"port", opts.port},
                {"startedAt", static_cast<long long>(pidfile_started_at)},
                {"instanceToken", opts.instance_token},
            };
            std::filesystem::path temporary = pidfile_path;
            temporary += ".tmp." + std::to_string(process_id);
            {
                std::ofstream f{
                    temporary, std::ios::binary | std::ios::trunc};
                if (!f || !(f << j.dump(2))) {
                    throw std::runtime_error{"could not write temporary pidfile"};
                }
            }
            std::error_code replace_ec;
            if (!replace_file_atomically(temporary, pidfile_path, replace_ec)) {
                std::filesystem::remove(temporary, replace_ec);
                throw std::runtime_error{"could not replace pidfile"};
            }
        } catch (const std::exception& ex) {
            Logger::warn("Failed to write pidfile '{}': {}", opts.pidfile, ex.what());
        }
    };

    // Publish process identity before the crash-restart delay. Electron can
    // then adopt the replacement generation instead of mistaking the dead
    // predecessor's lock for stale state and launching a duplicate.
    write_pidfile();

    const auto remove_owned_pidfile = [&] {
        if (opts.pidfile.empty()) return;
        try {
            std::ifstream f{pidfile_path, std::ios::binary};
            const auto j = nlohmann::json::parse(f, nullptr, false);
            if (!j.is_discarded() &&
                j.value("pid", 0LL) == process_id &&
                j.value("instanceToken", std::string{}) == opts.instance_token) {
                std::error_code ec;
                std::filesystem::remove(pidfile_path, ec);
            }
        } catch (...) {}
    };

    // ------------------------------------------------------------------
    // Crash-restart hand-off delay. A crashing instance spawns us immediately
    // and then exits to release the listening port; we wait here so the port
    // is free by the time we try to bind it (avoids a restart-vs-dying-parent
    // race that would otherwise make us exit on "port in use").
    // ------------------------------------------------------------------
    if (opts.start_delay_ms > 0) {
        Logger::info("Start delay: waiting {} ms before binding (crash-restart).",
                     opts.start_delay_ms);
        std::this_thread::sleep_for(std::chrono::milliseconds(opts.start_delay_ms));
    }

    // ------------------------------------------------------------------
    // Port conflict check — give a clear diagnostic before Crow tries to
    // bind and emits a misleading "0.0.0.0:0" error.
    // ------------------------------------------------------------------
    if (is_port_in_use(opts.bind_addr, static_cast<uint16_t>(opts.port))) {
        Logger::error("Port {} is already in use.", opts.port);
        Logger::error(
            "No process was stopped. Reattach to the existing DW Cue server "
            "or choose another port with --port.");
        remove_owned_pidfile();
        return 1;
    }

    print_banner(opts.bind_addr, opts.port);

    Logger::info("Booting DonWells Cue server (build {} on {})",
                 LIVEPLAY_SERVER_VERSION, platform_tag());
    Logger::debug("CLI -> port={} bind={} verbose={}",
                  opts.port, opts.bind_addr, opts.verbose);

    // ------------------------------------------------------------------
    // Audio engine (Milestone 2)
    // ------------------------------------------------------------------
    auto engine = std::make_unique<audio::AudioEngine>();
    if (!engine->start()) {
        Logger::error("Audio engine failed to start.");
        remove_owned_pidfile();
        return 1;
    }
    Logger::success("Audio engine running ({} Hz mix, {} frame blocks, {} master ch).",
                    engine->config().mix_sample_rate,
                    engine->config().render_block,
                    engine->config().master_channels);

    // Enumerate devices for the operator's visibility (M3 will expose this
    // over REST so the client can pick).
    auto devices = engine->enumerate_devices();
    if (devices.empty()) {
        Logger::warn("No audio output devices detected.");
    } else {
        Logger::info("Detected {} playback device(s):", devices.size());
        for (auto& d : devices) {
            Logger::raw(std::string{"    "} +
                        (d.is_default ? "[default] " : "          ") +
                        d.display_name +
                        "  (" + std::to_string(d.channel_count) + " ch)");
        }
    }
    // ------------------------------------------------------------------
    // Project state + control plane (Milestone 3)
    // ------------------------------------------------------------------
    auto project = std::make_unique<core::ProjectState>(*engine);
    auto backup  = std::make_unique<core::BackupManager>(*project);
    backup->start();

    net::ControlServerConfig server_cfg;
    server_cfg.bind_address = opts.bind_addr;
    server_cfg.port         = static_cast<std::uint16_t>(opts.port);
    server_cfg.access_token = opts.access_token;
    server_cfg.instance_token = opts.instance_token;
    server_cfg.allowed_origins = opts.allowed_origins;
    auto server = std::make_unique<net::ControlServer>(*engine, *project, server_cfg);
    if (!server->start()) {
        Logger::error("Control server failed to start.");
        disable_crash_restart();
        engine->stop();
        remove_owned_pidfile();
        return 1;
    }
    // A contender may have replaced the early hand-off pidfile before losing
    // the bind race. Once bound, republish the only generation that can serve.
    write_pidfile();

    // ------------------------------------------------------------------
    // LAN auto-discovery beacon — best-effort, non-fatal if it can't bind.
    // ------------------------------------------------------------------
    std::unique_ptr<net::DiscoveryBeacon> beacon;
    if (lan_mode) {
        net::DiscoveryConfig disc_cfg;
        disc_cfg.advertised_port = static_cast<std::uint16_t>(opts.port);
        beacon = std::make_unique<net::DiscoveryBeacon>(disc_cfg);
        if (!beacon->start()) {
            Logger::warn("LAN discovery beacon disabled (clients must connect by IP).");
        }
    }

    // ------------------------------------------------------------------
    // Crash-resume: if a previous instance crashed with an open project,
    // reload it now. We wait for audio loading to finish before playing.
    // ------------------------------------------------------------------
    struct PendingResume {
        std::string item_uuid;
        double      position_sec = 0.0;
        std::chrono::steady_clock::time_point retry_after;
        int         attempts = 0;
    };
    std::optional<PendingResume> pending_resume;

    if (crash_resume) {
        namespace fs = std::filesystem;
        std::error_code ec;
        const auto resume_fspath = util::utf8_to_path(crash_resume->project_file);
        if (fs::exists(resume_fspath, ec)) {
            Logger::info("Crash-resume: loading project '{}'", crash_resume->project_file);
            if (project->load(resume_fspath)) {
                if (!crash_resume->item_uuid.empty()) {
                    pending_resume = PendingResume{
                        crash_resume->item_uuid,
                        crash_resume->position_sec,
                        std::chrono::steady_clock::now() + std::chrono::seconds{3},
                        0
                    };
                    Logger::info("Crash-resume: will play item '{}' at {:.1f}s once audio loads.",
                                 crash_resume->item_uuid, crash_resume->position_sec);
                }
            } else {
                Logger::warn("Crash-resume: failed to load '{}'", crash_resume->project_file);
            }
        } else {
            Logger::warn("Crash-resume: project file no longer exists: '{}'",
                         crash_resume->project_file);
        }
    }

    // Heartbeat loop. Every 30 s we tick a debug line so operators can confirm
    // the process is alive over long sessions. SIGINT/SIGTERM flips g_running.
    using clock = std::chrono::steady_clock;
    const auto program_start = clock::now();
    bool crash_guard_reset   = false;
    auto last_heartbeat   = clock::now();
    auto last_resume_snap = clock::now();
    while (should_keep_running()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
        const auto now = clock::now();

        // Once we've been up long enough to be considered "healthy", clear the
        // consecutive-crash counter so isolated crashes over a long session
        // don't accumulate toward the auto-restart give-up threshold.
        if (!crash_guard_reset &&
            std::chrono::duration_cast<std::chrono::seconds>(now - program_start).count()
                >= kCrashGuardHealthySec) {
            reset_crash_restart_guard();
            crash_guard_reset = true;
        }

        // ---- crash-resume: play item once audio has fully loaded ------------
        if (pending_resume) {
            const bool audio_ready = !project->audio_loading();
            if (audio_ready && now >= pending_resume->retry_after) {
                Logger::info("Crash-resume: playing item '{}'", pending_resume->item_uuid);
                if (project->play_item(pending_resume->item_uuid)) {
                    // Seek to the saved position (best-effort — item may be
                    // shorter than the saved position if the file changed).
                    if (auto cue_id = project->item_to_cue_id(pending_resume->item_uuid)) {
                        if (auto pi = engine->find_cue(*cue_id)) {
                            if (pending_resume->position_sec > 1.0)
                                pi->seek_seconds(pending_resume->position_sec);
                        }
                    }
                }
                pending_resume.reset();
            } else if (!audio_ready) {
                ++pending_resume->attempts;
                if (pending_resume->attempts == 1)
                    Logger::debug("Crash-resume: waiting for audio load...");
                // Give up after 2 minutes (600 × 200 ms ticks) to avoid
                // hanging forever if audio loading stalls.
                if (pending_resume->attempts > 600) {
                    Logger::warn("Crash-resume: audio load timed out, giving up.");
                    pending_resume.reset();
                }
            }
        }

        // ---- update crash-handler resume state every ~2 s ------------------
        if (std::chrono::duration_cast<std::chrono::milliseconds>(
                now - last_resume_snap).count() >= 2000) {
            const auto snap = project->current_playback_snapshot();
            if (!snap.project_file.empty()) {
                update_crash_resume_state(snap.project_file,
                                          snap.item_uuid,
                                          snap.position_sec);
            }
            last_resume_snap = now;
        }

        if (std::chrono::duration_cast<std::chrono::seconds>(
                now - last_heartbeat).count() >= 30) {
            Logger::debug("heartbeat — server running");
            last_heartbeat = now;
        }
    }

    disable_crash_restart();
    Logger::raw("");
    Logger::info("Shutdown signal received — stopping cleanly.");
    // A clean exit is not a crash — clear the consecutive-crash counter so the
    // next launch starts fresh.
    reset_crash_restart_guard();
    if (beacon) beacon->stop();
    beacon.reset();
    server->stop();
    server.reset();
    backup->stop();
    backup.reset();
    project.reset();
    engine->stop();
    engine.reset();
    remove_owned_pidfile();
    Logger::success("Bye.");
    return 0;
}
