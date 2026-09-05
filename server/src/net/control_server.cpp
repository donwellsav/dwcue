// ============================================================================
// control_server.cpp — see control_server.hpp.
// ============================================================================

// Must come before crow.h on Windows to avoid redefinition of NOMINMAX etc.
// These must only fire on Windows — defining _WIN32_WINNT on macOS/Linux
// makes ASIO's config.hpp think it's a Windows target and try to pull in
// <winapifamily.h>, which obviously doesn't exist there.
#if defined(_WIN32)
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  ifndef _WIN32_WINNT
#    define _WIN32_WINNT 0x0A00
#  endif
#endif

#include "liveplay/net/control_server.hpp"
#include "liveplay/core/project_file.hpp"
#include "liveplay/net/control_security.hpp"
#include "liveplay/net/project_archive.hpp"
#include "liveplay/logger.hpp"
#include "liveplay/meta/metadata.hpp"
#include "liveplay/meta/waveform.hpp"
#include "liveplay/util/atomic_file.hpp"
#include "liveplay/util/unicode_path.hpp"

#if defined(_WIN32)
#  include <windows.h>      // GetLogicalDrives(), GetVolumeInformationW(), ...
#  include <winnetwk.h>     // WNetGetConnectionW() — mapped-network-drive UNC
#else
#  include <unistd.h>
#endif

#include <crow.h>
#include <crow/middlewares/cors.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <charconv>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <tuple>
#include <unordered_map>
#include <unordered_set>


namespace fs    = std::filesystem;
using json      = nlohmann::json;
namespace audio = liveplay::audio;
namespace core  = liveplay::core;
namespace meta  = liveplay::meta;

namespace liveplay::net {

namespace {

long long current_process_id() noexcept {
#if defined(_WIN32)
    return static_cast<long long>(::GetCurrentProcessId());
#else
    return static_cast<long long>(::getpid());
#endif
}

struct ControlSecurityMiddleware {
    struct context {};

    std::string access_token;
    std::vector<std::string> allowed_origins;
    std::size_t max_upload_bytes{256ull * 1024 * 1024};

    bool authorized(const crow::request& req) const {
        std::string_view query_access_token;
        // Browser WebSockets and HTML media elements cannot attach an
        // Authorization header. Restrict bearer-in-query to those two routes.
        if (req.url == "/ws" || req.url == "/api/media") {
            if (const char* token = req.url_params.get("access_token")) {
                query_access_token = token;
            }
        }
        const std::string authorization =
            req.get_header_value("Authorization");
        return security::access_token_authorized(
            access_token, authorization, query_access_token);
    }

    void add_cors_headers(const crow::request& req, crow::response& res) const {
        const std::string origin = req.get_header_value("Origin");
        if (origin.empty() || !security::origin_allowed(origin, allowed_origins)) return;
        res.set_header("Access-Control-Allow-Origin", origin);
        res.set_header("Vary", "Origin");
    }

    void reject(const crow::request& req, crow::response& res,
                int status, std::string_view message) const {
        res = crow::response{
            status, json({{"error", message}}).dump()};
        res.set_header("Content-Type", "application/json");
        if (status == 401) res.set_header("WWW-Authenticate", "Bearer");
        add_cors_headers(req, res);
        res.end();
    }

    void before_handle(crow::request& req, crow::response& res, context&) {
        const std::string origin = req.get_header_value("Origin");
        if (!security::origin_allowed(origin, allowed_origins)) {
            reject(req, res, 403, "origin not allowed");
            return;
        }

        if (req.method == crow::HTTPMethod::Options) {
            add_cors_headers(req, res);
            res.code = 204;
            res.set_header("Access-Control-Allow-Methods",
                           "GET, POST, PUT, PATCH, DELETE, OPTIONS");
            res.set_header("Access-Control-Allow-Headers",
                           "Authorization, Content-Type, X-DWCUE-Mutation-ID");
            res.set_header("Access-Control-Max-Age", "600");
            res.end();
            return;
        }

        // Health is intentionally public so launchers and discovery probes can
        // distinguish this service before presenting a token prompt.
        if (req.url != "/api/health" && !authorized(req)) {
            reject(req, res, 401, "authentication required");
            return;
        }

        if (req.url == "/api/upload" || req.url == "/api/project/import") {
            // Crow invokes middleware after buffering the HTTP body. This
            // prevents multipart parsing/staging above the limit, but Crow
            // itself needs an upstream parser cap to bound receive memory.
            const std::string content_length =
                req.get_header_value("Content-Length");
            if (security::upload_exceeds_limit(
                    req.body.size(), content_length, max_upload_bytes)) {
                reject(req, res, 413, "payload too large");
                return;
            }
        }
        if (req.method == crow::HTTPMethod::Put &&
            req.url.starts_with("/api/upload/")) {
            const std::string content_length =
                req.get_header_value("Content-Length");
            if (security::upload_exceeds_limit(
                    req.body.size(), content_length,
                    security::kChunkedUploadChunkBytes)) {
                reject(req, res, 413, "chunk too large");
                return;
            }
        }

    }

    void after_handle(crow::request& req, crow::response& res, context&) {
        add_cors_headers(req, res);
        // Crow's router answers OPTIONS itself with a fresh response object
        // (res = response(NO_CONTENT) + Allow header), wiping the preflight
        // headers set in before_handle. Re-add them here, after routing, so
        // browser clients see a usable preflight either way.
        if (req.method == crow::HTTPMethod::Options &&
            security::origin_allowed(req.get_header_value("Origin"), allowed_origins)) {
            res.set_header("Access-Control-Allow-Methods",
                           "GET, POST, PUT, PATCH, DELETE, OPTIONS");
            res.set_header("Access-Control-Allow-Headers",
                           "Authorization, Content-Type, X-DWCUE-Mutation-ID");
            res.set_header("Access-Control-Max-Age", "600");
        }
    }
};

} // namespace

// Forward declarations (definitions further down).
static nlohmann::json build_playback_snapshot(audio::AudioEngine& engine,
                                              core::ProjectState& state);

// Pimpl: all Crow + WebSocket state lives here so crow.h stays out of the
// public header.
struct ControlServer::Impl {
    crow::App<ControlSecurityMiddleware> app;
    std::thread     app_thread;
    std::thread     broadcast_thread;
    std::mutex      ws_mutex;
    std::string     server_addr;
    std::unordered_set<crow::websocket::connection*> ws_clients;
    // Clients that need an initial playback_snapshot push. Populated by
    // onopen, drained by broadcast_loop under ws_mutex — keeps all send_text
    // calls on a single connection serialised through one mutex (Crow's
    // websocket::connection is not safe under concurrent writes; calling
    // send_text directly from onopen while broadcast_loop was concurrently
    // sending meters to the same conn caused the crash on connect).
    std::unordered_set<crow::websocket::connection*> ws_clients_pending_snapshot;
    // Command acknowledgements are cached so a controller may safely retry
    // after losing an ack without executing GO/PLAY twice.
    std::mutex                                  ws_command_mutex;
    std::unordered_map<std::string, std::string> ws_command_results;
    std::deque<std::string>                     ws_command_order;

    // Async waveform-generation queue. REST handler enqueues a task and
    // returns immediately; waveform_worker() processes them one at a time and
    // broadcasts a waveform_ready doc_patch when each finishes.
    struct WaveformTask {
        std::filesystem::path path;
        std::string           item_uuid;
        std::filesystem::path waveforms_dir; // empty = no disk cache
        bool                  force{false};  // delete cache and recompute
    };
    std::mutex              waveform_q_mutex;
    std::condition_variable waveform_q_cv;
    std::deque<WaveformTask> waveform_q;
    std::thread             waveform_thread;
    bool                    waveform_stop{false};
};

namespace {

// Bridges Crow's internal logger into our Logger so all server output
// shares the same format and color scheme. Crow INFO logs (verbose
// request/response lines) are routed to debug and hidden by default;
// warnings and errors surface normally.
class CrowLogBridge final : public crow::ILogHandler {
public:
    void log(const std::string& message, crow::LogLevel level) override {
        switch (level) {
            case crow::LogLevel::Warning:  Logger::warn("[Crow] {}", message);  break;
            case crow::LogLevel::Error:    Logger::error("[Crow] {}", message); break;
            case crow::LogLevel::Critical: Logger::error("[Crow] {}", message); break;
            default:                       Logger::debug("[Crow] {}", message); break;
        }
    }
};

crow::response json_ok(const json& body) {
    crow::response r{200, body.dump()};
    r.add_header("Content-Type", "application/json");
    return r;
}

crow::response json_err(int status, std::string_view message) {
    crow::response r{status, json({{"error", message}}).dump()};
    r.add_header("Content-Type", "application/json");
    return r;
}

json waveform_data_json(const meta::Waveform& wf) {
    json channels = json::array();
    for (const auto& ch : wf.channels) {
        channels.push_back(json{{"peak", ch.peak}, {"rms", ch.rms}});
    }
    return json{
        {"analysis_version", wf.analysis_version},
        {"integrated_lufs",  wf.integrated_lufs
                                 ? json(*wf.integrated_lufs) : json(nullptr)},
        {"true_peak_dbtp",   wf.true_peak_dbtp
                                 ? json(*wf.true_peak_dbtp) : json(nullptr)},
        {"bucket_count",     wf.bucket_count},
        {"duration_ms",      wf.duration.count()},
        {"sample_rate",      wf.sample_rate},
        {"source_channels",  wf.source_channels},
        {"channels",         std::move(channels)},
    };
}

bool current_waveform_cache(const json& cached) {
    const auto analysis_value = [&](std::string_view key) {
        const auto it = cached.find(key);
        return it != cached.end() && (it->is_number() || it->is_null());
    };
    return cached.value("analysis_version", 0u) ==
               meta::Waveform::kAnalysisVersion &&
           analysis_value("integrated_lufs") &&
           analysis_value("true_peak_dbtp");
}

std::optional<std::chrono::milliseconds> query_milliseconds(
    const crow::request& req, const char* name) {
    const char* raw = req.url_params.get(name);
    if (!raw) return std::nullopt;
    const std::string text{raw};
    long long value = 0;
    const auto [end, ec] =
        std::from_chars(text.data(), text.data() + text.size(), value);
    if (ec != std::errc{} || end != text.data() + text.size() || value < 0)
        throw std::invalid_argument(std::string{name} + " must be a non-negative integer");
    return std::chrono::milliseconds{value};
}

// Returns "Display Name (cue_id) (media/path)" for playback log lines.
// Falls back gracefully when the item or cue metadata is not yet loaded.
static std::string item_playback_info(const std::string& item_uuid, core::ProjectState& state) {
    const auto cue_id = state.item_to_cue_id(item_uuid);
    if (!cue_id) return std::format("? (uuid={})", item_uuid);
    const auto meta = state.find_cue(*cue_id);
    if (!meta) return std::format("? ({})", cue_id->value);
    return std::format("{} ({}) ({})",
                       meta->display_name,
                       cue_id->value,
                       liveplay::util::path_to_utf8(meta->file_path));
}


// One-shot download tokens. GET claims a token and DELETE acknowledges a
// completed transfer. Claimed files remain until acknowledged or expired so
// Crow can stream them without a delete-before-send race.
struct DownloadToken {
    fs::path path;
    std::chrono::steady_clock::time_point expires_at;
    bool claimed{false};
};

struct ScopedFileRemoval {
    fs::path path;
    ~ScopedFileRemoval() {
        if (path.empty()) return;
        std::error_code ec;
        fs::remove(path, ec);
    }
};

static std::mutex g_download_tokens_mutex;
static std::unordered_map<std::string, DownloadToken> g_download_tokens;

static fs::path export_temp_root() {
    return fs::temp_directory_path() / "liveplay-exports";
}

static std::string make_download_token() {
    // This token authorizes a one-shot file download, so use the same direct
    // platform random source as LAN access tokens rather than a PRNG stream.
    return security::random_hex_token(32);
}

static void register_download_token(const std::string& token, fs::path path) {
    std::lock_guard lock{g_download_tokens_mutex};
    g_download_tokens[token] = DownloadToken{
        std::move(path),
        std::chrono::steady_clock::now() + std::chrono::minutes(10),
        false,
    };
}

static void purge_download_tokens(bool all = false) {
    std::vector<fs::path> expired;
    std::lock_guard lock{g_download_tokens_mutex};
    const auto now = std::chrono::steady_clock::now();
    for (auto it = g_download_tokens.begin(); it != g_download_tokens.end();) {
        if (all || it->second.expires_at <= now) {
            expired.push_back(std::move(it->second.path));
            it = g_download_tokens.erase(it);
        } else {
            ++it;
        }
    }
    for (const auto& path : expired) {
        std::error_code ec;
        fs::remove(path, ec);
    }
}

static std::optional<fs::path> claim_download_token(
    const std::string& token) {
    purge_download_tokens();
    std::lock_guard lock{g_download_tokens_mutex};
    auto it = g_download_tokens.find(token);
    if (it == g_download_tokens.end() || it->second.claimed)
        return std::nullopt;
    it->second.claimed = true;
    it->second.expires_at =
        std::chrono::steady_clock::now() + std::chrono::hours(24);
    return it->second.path;
}

static bool complete_download_token(const std::string& token) {
    fs::path path;
    {
        std::lock_guard lock{g_download_tokens_mutex};
        auto it = g_download_tokens.find(token);
        if (it == g_download_tokens.end() || !it->second.claimed)
            return false;
        path = std::move(it->second.path);
        g_download_tokens.erase(it);
    }
    std::error_code ec;
    fs::remove(path, ec);
    return true;
}

static bool valid_download_token(std::string_view token) {
    return token.size() == 64 &&
        std::all_of(token.begin(), token.end(), [](unsigned char c) {
            return std::isxdigit(c) != 0;
        });
}

static std::string safe_download_filename(std::string name) {
    return security::canonical_archive_download_filename(name);
}

static void purge_orphan_export_files() {
    std::unordered_set<std::string> active_names;
    {
        std::lock_guard lock{g_download_tokens_mutex};
        for (const auto& [_, token] : g_download_tokens) {
            const auto filename =
                liveplay::util::path_to_utf8(token.path.filename());
            if (security::is_export_archive_name(filename))
                active_names.insert(filename);
        }
    }
    const fs::path root = export_temp_root();
    std::error_code ec;
    const auto cutoff = fs::file_time_type::clock::now() - std::chrono::hours(24);
    for (fs::directory_iterator it{root, ec}, end; !ec && it != end;
         it.increment(ec)) {
        const std::string name =
            liveplay::util::path_to_utf8(it->path().filename());
        if (!security::is_export_archive_name(name) ||
            active_names.contains(name)) {
            continue;
        }
        const auto modified = it->last_write_time(ec);
        if (ec) break;
        if (modified <= cutoff) fs::remove(it->path(), ec);
        if (ec) break;
    }
}

struct ChunkedUploadSession {
    enum class Purpose {
        Media,
        ProjectImport,
    };

    fs::path temp_path;
    fs::path staging_root;
    fs::path filename;
    fs::path extract_path;
    std::uint64_t expected_bytes{0};
    std::uint64_t received_bytes{0};
    std::chrono::steady_clock::time_point expires_at;
    bool finalizing{false};
    Purpose purpose{Purpose::Media};
};

// ponytail: operator uploads are sparse; one process-wide lock keeps offset
// checks and append order coherent. Split per upload id only if contention
// ever shows up in real use.
static std::mutex g_chunked_uploads_mutex;
static std::unordered_map<std::string, ChunkedUploadSession> g_chunked_uploads;

static std::string make_chunked_upload_id() {
    return security::random_hex_token(32);
}

static bool chunked_upload_has_space(const fs::path& path,
                                     std::uint64_t bytes_needed) {
    if (bytes_needed == 0) return true;
    std::error_code ec;
    const auto space = fs::space(path, ec);
    return !ec && space.available >= bytes_needed;
}

static std::optional<std::uint64_t> chunked_upload_offset(
    const crow::request& req) {
    const char* raw = req.url_params.get("offset");
    if (!raw) return std::nullopt;
    std::uint64_t value = 0;
    if (!security::parse_decimal_u64(raw, value)) return std::nullopt;
    return value;
}

static void purge_chunked_uploads(bool all = false) {
    std::vector<fs::path> expired;
    {
        std::lock_guard lock{g_chunked_uploads_mutex};
        const auto now = std::chrono::steady_clock::now();
        for (auto it = g_chunked_uploads.begin(); it != g_chunked_uploads.end();) {
            const bool expired_session = it->second.expires_at <= now;
            if (security::chunked_upload_should_purge(
                    all, expired_session, it->second.finalizing)) {
                expired.push_back(std::move(it->second.temp_path));
                it = g_chunked_uploads.erase(it);
            } else {
                ++it;
            }
        }
    }
    for (const auto& path : expired) {
        std::error_code ec;
        fs::remove(path, ec);
    }
}

static void purge_orphan_chunked_upload_files(const fs::path& media_root) {
    std::unordered_set<std::string> active;
    {
        std::lock_guard lock{g_chunked_uploads_mutex};
        for (const auto& [id, _] : g_chunked_uploads) active.insert(id);
    }
    const auto cutoff = fs::file_time_type::clock::now() - std::chrono::hours(1);
    std::error_code ec;
    for (fs::directory_iterator it{media_root, ec}, end; !ec && it != end;
         it.increment(ec)) {
        const std::string name =
            liveplay::util::path_to_utf8(it->path().filename());
        if (!security::is_chunked_upload_staging_name(name)) continue;
        const std::string id = name.substr(
            std::string_view{".dwcue-upload-"}.size(), 64);
        if (active.contains(id)) continue;
        const auto modified = it->last_write_time(ec);
        if (ec) break;
        if (modified <= cutoff) fs::remove(it->path(), ec);
        if (ec) break;
    }
}

// ponytail: media imports are operator-driven; one process-wide lock keeps
// collision naming and creation atomic. Shard by media root if bulk ingest
// throughput ever matters.
static std::mutex g_media_import_mutex;


static fs::path unused_media_path(const fs::path& media,
                                  const fs::path& filename) {
    fs::path candidate = media / filename;
    std::error_code ec;
    if (!fs::exists(candidate, ec) && !ec) return candidate;
    const auto stem = filename.stem();
    const auto extension = filename.extension();
    for (unsigned n = 2; n < 100'000; ++n) {
        candidate = media /
            fs::path{stem.native() +
                     liveplay::util::utf8_to_path(
                         " (" + std::to_string(n) + ")").native() +
                     extension.native()};
        ec.clear();
        if (!fs::exists(candidate, ec) && !ec) return candidate;
    }
    throw std::runtime_error{"could not choose an unused media filename"};
}

static bool same_file_contents(const fs::path& left, const fs::path& right) {
    std::error_code ec;
    if (fs::equivalent(left, right, ec) && !ec) return true;
    ec.clear();
    const auto left_size = fs::file_size(left, ec);
    if (ec) return false;
    const auto right_size = fs::file_size(right, ec);
    if (ec || left_size != right_size) return false;

    std::ifstream a{left, std::ios::binary};
    std::ifstream b{right, std::ios::binary};
    std::array<char, 64 * 1024> a_buf{};
    std::array<char, 64 * 1024> b_buf{};
    while (a && b) {
        a.read(a_buf.data(), static_cast<std::streamsize>(a_buf.size()));
        b.read(b_buf.data(), static_cast<std::streamsize>(b_buf.size()));
        if (a.gcount() != b.gcount() ||
            !std::equal(a_buf.begin(), a_buf.begin() + a.gcount(), b_buf.begin())) {
            return false;
        }
    }
    return a.eof() && b.eof();
}

static fs::path matching_media_file(const fs::path& media,
                                    const fs::path& source) {
    // ponytail: operator imports are small; scan the media directory on a
    // filename collision. Add a content-hash index only if large libraries
    // make this measurable.
    const auto source_name = source.filename();
    const auto source_stem = source_name.stem().native();
    const auto numbered_prefix = source_stem +
        liveplay::util::utf8_to_path(" (").native();
    const auto source_ext = source_name.extension();
    for (const auto& entry : fs::directory_iterator(media)) {
        if (!entry.is_regular_file()) continue;
        const auto candidate = entry.path().filename();
        if (candidate.extension() != source_ext) continue;
        const auto stem = candidate.stem().native();
        if (candidate != source_name &&
            (stem.size() <= numbered_prefix.size() ||
             stem.compare(0, numbered_prefix.size(), numbered_prefix) != 0 ||
             stem.back() != liveplay::util::utf8_to_path(")").native().front())) {
            continue;
        }
        if (same_file_contents(source, entry.path())) return entry.path();
    }
    return {};
}

json device_info_to_json(const audio::DeviceInfo& d) {
    return json{
        {"id",            d.id.value},
        {"display_name",  d.display_name},
        {"channel_count", d.channel_count},
        {"sample_rate",   d.sample_rate},
        {"is_default",    d.is_default},
        {"is_open",       d.is_open},
        {"is_available",  d.is_available},
        {"is_clock_master", d.is_clock_master},
        {"runtime_state", d.runtime_state},
        {"recovery_request_id", d.recovery_request_id},
        {"recovery_status", d.recovery_status},
        {"underrun_count", d.underrun_count},
        {"underrun_frames", d.underrun_frames},
        {"overrun_count", d.overrun_count},
        {"hard_resync_count", d.hard_resync_count},
        {"device_loss_count", d.device_loss_count},
        {"device_recovery_count", d.device_recovery_count},
        {"callback_entry_count", d.callback_entry_count},
        {"stream_recovery_count", d.stream_recovery_count},
        {"reroute_count", d.reroute_count},
        {"interruption_count", d.interruption_count},
        {"correction_limit_count", d.correction_limit_count},
        {"ring_occupancy_frames", d.ring_occupancy_frames},
        {"clock_correction_ppm", d.clock_correction_ppm},
    };
}

json cue_to_json(const core::CueMeta& c, audio::AudioEngine& engine) {
    json j;
    j["id"]            = c.id.value;
    j["display_name"]  = c.display_name;
    j["file_path"]     = liveplay::util::path_to_utf8(c.file_path);
    j["artist"]        = c.artist;
    j["title"]         = c.title;
    j["duration_sec"]  = c.duration_seconds;
    j["gain_db"]       = c.gain_db;
    j["fade_in_ms"]    = c.fade_in_ms.count();
    j["fade_out_ms"]   = c.fade_out_ms.count();
    j["ltc"] = json{
        {"enabled",        c.ltc_enabled},
        {"fps",            c.ltc_frame_rate_index},
        {"offset_ns",      static_cast<long long>(c.ltc_offset_ns.count())},
        {"start_timecode", c.ltc_start_timecode},
    };
    if (auto item = engine.find_cue(c.id)) {
        const auto s = item->stats();
        j["transport"] = static_cast<int>(s.transport);
        j["playhead_seconds"] = s.playhead_seconds;
        j["source_channels"]  = s.source_channels;
        j["file_loaded"]      = s.file_loaded;
        j["decode_error"]     = s.decode_error;
        j["decoder_result"]   = s.decoder_result;
        j["read_ahead_underruns"] = s.read_ahead_underruns;
        j["read_ahead_blocks"]    = s.read_ahead_blocks;
    }
    return j;
}

} // namespace

// ---------------------------------------------------------------------------

ControlServer::ControlServer(audio::AudioEngine& engine,
                             core::ProjectState& state,
                             ControlServerConfig cfg)
    : engine_(engine), state_(state), cfg_(std::move(cfg)),
      impl_(std::make_unique<Impl>()) {}

ControlServer::~ControlServer() { stop(); }

bool ControlServer::start() {
    if (running_.exchange(true)) return true;
    if (cfg_.access_token.size() < 16) {
        running_.store(false);
        Logger::error(
            "ControlServer: every bind requires an access token of at least "
            "16 characters.");
        return false;
    }
    purge_orphan_export_files();
    install_routes();

    // Hand custom http-request actions off to clients. The server has no
    // HTTP client of its own; broadcasting as a doc_patch lets any
    // connected client execute the fetch. This is a best-effort fan-out;
    // if no client is connected the action is silently dropped.
    state_.set_external_action_handler([this](const json& action) {
        broadcast_doc_patch(json{
            {"type", "doc_patch"},
            {"op",   "custom_action_http"},
            {"action", action},
        });
    });

    // Fan out every "Up Next" change — whether requested by a client or armed
    // by the server itself (#28 auto-cue / first-item / end-of-list wrap) — so
    // all clients mirror the authoritative override instead of each deciding.
    state_.set_next_item_broadcaster([this](const std::string& uuid) {
        broadcast_doc_patch(json{
            {"type", "doc_patch"},
            {"op",   "next_item_set"},
            {"itemUuid", uuid},
        });
    });

    // Shared operator UI state (selection / Show Mode / locale). ProjectState
    // hands us a ready-made doc_patch payload; we only have to fan it out, so
    // a Companion button, a touch tablet and the operator's laptop all end up
    // showing the same selected cue and the same view mode.
    state_.set_ui_state_broadcaster([this](const json& patch) {
        broadcast_doc_patch(patch);
    });

    // Crow's SimpleApp::run() blocks; we shove it on a worker thread.
    // Main owns process shutdown. Crow otherwise replaces our SIGINT/SIGTERM
    // handlers when run() starts, leaving the main heartbeat loop alive.
    impl_->app.signal_clear();
    impl_->app_thread = std::thread([this] {
        try {
            impl_->app.bindaddr(cfg_.bind_address).port(cfg_.port).multithreaded().run();
        } catch (const std::exception& ex) {
            Logger::error("ControlServer: crow run() threw: {}", ex.what());
        }
    });

    impl_->app.wait_for_server_start(std::chrono::milliseconds{3000});
    if (!impl_->app.is_bound()) {
        running_.store(false);
        impl_->app.stop();
        if (impl_->app_thread.joinable()) impl_->app_thread.join();
        state_.set_external_action_handler({});
        state_.set_next_item_broadcaster({});
        state_.set_ui_state_broadcaster({});
        Logger::error(
            "ControlServer: failed to bind {}:{}.",
            cfg_.bind_address, cfg_.port);
        return false;
    }

    impl_->broadcast_thread = std::thread([this] { broadcast_loop(); });
    {
        std::lock_guard lock{impl_->waveform_q_mutex};
        impl_->waveform_stop = false;
    }
    impl_->waveform_thread  = std::thread([this] { waveform_worker(); });
    Logger::success("Control server listening on {}:{}", cfg_.bind_address, cfg_.port);
    return true;
}

void ControlServer::stop() {
    if (!running_.exchange(false)) return;
    state_.set_external_action_handler({});
    state_.set_next_item_broadcaster({});
    state_.set_ui_state_broadcaster({});
    impl_->app.stop();
    {
        std::lock_guard lock{impl_->waveform_q_mutex};
        impl_->waveform_stop = true;
        impl_->waveform_q.clear();
    }
    impl_->waveform_q_cv.notify_one();
    if (impl_->broadcast_thread.joinable()) impl_->broadcast_thread.join();
    if (impl_->waveform_thread.joinable())  impl_->waveform_thread.join();
    if (impl_->app_thread.joinable())       impl_->app_thread.join();
    purge_chunked_uploads(true);
    purge_download_tokens(true);
    Logger::info("Control server stopped.");
}

// ---------------------------------------------------------------------------
// Meter broadcaster (cfg_.meter_broadcast_hz) + cue_state edge events.
// Uses CONSUMING meter reads (snapshot_consume_max) — this loop must remain
// the only consumer or readers would steal each other's peaks.
// ---------------------------------------------------------------------------
void ControlServer::broadcast_loop() {
    using clock = std::chrono::steady_clock;
    const auto period = std::chrono::nanoseconds{
        1'000'000'000LL / static_cast<long long>(std::max<std::size_t>(1, cfg_.meter_broadcast_hz))};

    // Track previous transport state per cue so we can emit cue_state events
    // exactly once on each transition (rather than every tick).
    std::unordered_map<std::string, audio::TransportState> prev_transports;

    // Absolute-deadline schedule. sleep_for(period - work) systematically
    // undershoots the target rate on Windows (~15.6 ms sleep granularity
    // rounds every sleep up); sleep_until against an advancing deadline
    // self-corrects, so the average rate converges on meter_broadcast_hz.
    auto next_tick = clock::now() + period;
    // Edge-triggered runtime, clock-role, and recovery state. Including the
    // request id guarantees a fast terminal result still emits an event even
    // when the runtime state is Running before and after the restart.
    using DeviceStateSignature =
        std::tuple<std::string, bool, std::uint64_t, std::string>;
    std::unordered_map<std::string, DeviceStateSignature> prev_device_states;
    auto next_download_cleanup = clock::now() + std::chrono::minutes(1);
    auto next_upload_cleanup = clock::now() + std::chrono::minutes(1);

    while (running_.load(std::memory_order_acquire)) {
        // Guard the entire tick: an exception escaping this thread would call
        // std::terminate() and take the whole audio process down mid-show.
        // Log-and-continue instead so a transient fault (e.g. a flaky media
        // share throwing out of a filesystem call) just drops one meter frame.
        try {
        if (clock::now() >= next_download_cleanup) {
            purge_download_tokens();
            purge_orphan_export_files();
            next_download_cleanup = clock::now() + std::chrono::minutes(1);
        }
        if (clock::now() >= next_upload_cleanup) {
            purge_chunked_uploads();
            next_upload_cleanup = clock::now() + std::chrono::minutes(1);
        }

        // Build the meters payload.
        json payload;
        payload["type"] = "meters";

        json item_meters = json::array();
        // Helper: append a meter frame for an arbitrary engine cue. Used for
        // both project cues and the preview cue (which is engine-only, not in
        // state_.list_cues()).
        auto append_meter_for = [&](const audio::CueId& cue_id) {
            auto item = engine_.find_cue(cue_id);
            if (!item) return;
            const auto stats = item->stats();
            if (stats.transport == audio::TransportState::Stopped) return;
            json m;
            m["cue_id"]            = cue_id.value;
            m["transport"]         = static_cast<int>(stats.transport);
            m["playhead_seconds"]  = stats.playhead_seconds;
            json srcs = json::array();
            for (audio::ChannelIndex c = 0; c < item->source_channel_count(); ++c) {
                auto snap = item->source_meter_consume(c);
                srcs.push_back(json{{"peak_db", snap.peak_db},
                                    {"rms_db", snap.rms_db},
                                    {"peak_max_db", snap.peak_max_db},
                                    {"true_peak_db", snap.true_peak_db},
                                    {"true_peak_max_db", snap.true_peak_max_db},
                                    {"kw_ms", snap.kw_ms},
                                    {"kw_ms_s", snap.kw_ms_s}});
            }
            m["sources"] = std::move(srcs);
            item_meters.push_back(std::move(m));
        };
        for (auto& cue : state_.list_cues()) append_meter_for(cue.id);
        // Preview cue lives outside list_cues() because it's loaded with
        // load_cue_no_route — emit its frame explicitly so the client's
        // preview card can drive playhead time and the seek bar.
        const auto preview_cue = state_.current_preview_cue_id();
        if (!preview_cue.empty()) append_meter_for(preview_cue);
        payload["items"] = std::move(item_meters);

        json mixer_meters = json::array();
        for (auto& mch : state_.list_mixer_channels()) {
            if (auto m = engine_.find_mixer_channel(mch.id)) {
                auto s = m->meter_snapshot_consume();
                mixer_meters.push_back(json{
                    {"mixer_id",         mch.id.value},
                    {"peak_db",          s.peak_db},
                    {"rms_db",           s.rms_db},
                    {"peak_max_db",      s.peak_max_db},
                    {"true_peak_db",     s.true_peak_db},
                    {"true_peak_max_db", s.true_peak_max_db},
                    {"kw_ms",            s.kw_ms},
                    {"kw_ms_s",          s.kw_ms_s},
                });
            }
        }
        payload["mixer_channels"] = std::move(mixer_meters);

        json master_meters = json::array();
        for (audio::MasterChannelIndex i = 0; i < engine_.config().master_channels; ++i) {
            auto s = engine_.read_master_meter_consume(i);
            const float gr = engine_.read_master_gain_reduction_db(i);
            // Only include non-silent channels to keep the payload light.
            // (peak_max_db is checked too so an isolated transient inside an
            // otherwise-silent frame still gets reported.)
            if (s.peak_db > -119.0f || s.peak_max_db > -119.0f || gr < -0.05f) {
                master_meters.push_back(json{
                    {"index",            i},
                    {"peak_db",          s.peak_db},
                    {"rms_db",           s.rms_db},
                    {"peak_max_db",      s.peak_max_db},
                    {"true_peak_db",     s.true_peak_db},
                    {"true_peak_max_db", s.true_peak_max_db},
                    {"kw_ms",            s.kw_ms},
                    {"kw_ms_s",          s.kw_ms_s},
                    {"gain_reduction_db", gr},
                });
            }
        }
        payload["master_channels"] = std::move(master_meters);

        std::string serialized;
        try { serialized = payload.dump(); }
        catch (const std::exception& e) {
            Logger::error("broadcast_loop: failed to serialize meters: {}", e.what());
            std::this_thread::sleep_until(next_tick);
            next_tick += period;
            if (next_tick < clock::now()) next_tick = clock::now() + period;
            continue;
        }

        // Detect transport changes and build cue_state edge events.
        std::vector<std::string> cue_state_events;
        try {
            for (auto& cue : state_.list_cues()) {
                auto item = engine_.find_cue(cue.id);
                const auto current = item
                    ? item->stats().transport
                    : audio::TransportState::Stopped;
                auto& prev = prev_transports[cue.id.value];
                if (current != prev) {
                    prev = current;
                    json evt{
                        {"type", "cue_state"},
                        {"cue_id", cue.id.value},
                        {"transport", static_cast<int>(current)},
                        {"playhead_seconds", item ? item->stats().playhead_seconds : 0.0},
                    };
                    if (auto uuid = state_.cue_to_item_uuid(cue.id)) {
                        evt["item_uuid"] = *uuid;
                        if (auto seq = state_.item_trigger_seq(*uuid)) evt["trigger_seq"] = *seq;
                    }
                    cue_state_events.push_back(evt.dump());
                }
            }
        } catch (const std::exception& e) {
            Logger::error("broadcast_loop: failed to build cue_state events: {}", e.what());
        }

        std::vector<std::string> device_state_events;
        try {
            for (const auto& device : engine_.enumerate_devices()) {
                const auto signature = DeviceStateSignature{
                    device.runtime_state,
                    device.is_clock_master,
                    device.recovery_request_id,
                    device.recovery_status,
                };
                const auto previous = prev_device_states.find(device.id.value);
                if (previous == prev_device_states.end() || previous->second != signature) {
                    device_state_events.push_back(json{
                        {"type", "device_state"},
                        {"device", device_info_to_json(device)},
                    }.dump());
                }
                prev_device_states[device.id.value] = signature;
            }
        } catch (const std::exception& e) {
            Logger::error("broadcast_loop: failed to build device_state events: {}", e.what());
        }

        // Build any pending playback_snapshot payload WITHOUT holding ws_mutex.
        // build_playback_snapshot acquires state/engine mutexes internally, and
        // HTTP handlers hold those same mutexes while calling broadcast_doc_patch
        // (which also needs ws_mutex). Acquiring ws_mutex → state mutex from the
        // broadcast thread while HTTP handlers do state mutex → ws_mutex is the
        // classic ABBA deadlock that crashes the server on client connect.
        bool has_pending = false;
        {
            std::lock_guard lock{impl_->ws_mutex};
            has_pending = !impl_->ws_clients_pending_snapshot.empty();
        }
        std::string snapshot_serialized;
        if (has_pending) {
            try {
                snapshot_serialized = build_playback_snapshot(engine_, state_).dump();
            } catch (const std::exception& e) {
                Logger::warn("build_playback_snapshot failed: {}", e.what());
            }
        }

        // Fan out meters + cue_state events to all subscribed clients,
        // plus snapshots for any client still flagged as pending.
        std::lock_guard lock{impl_->ws_mutex};
        for (auto* c : impl_->ws_clients) {
            try {
                if (!snapshot_serialized.empty() &&
                    impl_->ws_clients_pending_snapshot.erase(c)) {
                    c->send_text(snapshot_serialized);
                }
                c->send_text(serialized);
                for (const auto& e : cue_state_events) c->send_text(e);
                for (const auto& e : device_state_events) c->send_text(e);
            } catch (...) { /* connection will be cleaned up by onclose */ }
        }

        // Sleep to maintain the broadcast cadence (absolute deadline; see
        // next_tick comment above). After a long stall, re-anchor instead of
        // burst-firing to catch up.
        std::this_thread::sleep_until(next_tick);
        next_tick += period;
        if (next_tick < clock::now()) next_tick = clock::now() + period;

        } catch (const std::exception& e) {
            Logger::error("broadcast_loop: unhandled exception (continuing): {}", e.what());
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
            next_tick = clock::now() + period;
        } catch (...) {
            Logger::error("broadcast_loop: unknown exception (continuing).");
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
            next_tick = clock::now() + period;
        }
    }
}

// ---------------------------------------------------------------------------
// Multi-client mutation fan-out. Mutating REST routes call this with a
// doc_patch event so every connected client mirrors the change in real
// time. The originating client also receives the echo — applying it is
// idempotent on its side (uuid lookup) and keeps the local diff-watcher
// quiet because the client wraps the apply in its `isHydrating` flag.
void ControlServer::broadcast_doc_patch(const json& payload) {
    std::string serialized;
    try { serialized = payload.dump(); }
    catch (const std::exception& e) {
        Logger::error("broadcast_doc_patch: serialization failed: {}", e.what());
        return;
    }
    std::lock_guard lock{impl_->ws_mutex};
    for (auto* c : impl_->ws_clients) {
        try { c->send_text(serialized); }
        catch (...) { /* onclose will clean up dead connections */ }
    }
}

// Drains the waveform generation queue. Each task runs compute_waveform()
// (which can take a few seconds for long files) then broadcasts a
// waveform_ready doc_patch so every connected client can update its UI.
void ControlServer::waveform_worker() {
    for (;;) {
        Impl::WaveformTask task;
        {
            std::unique_lock lock{impl_->waveform_q_mutex};
            impl_->waveform_q_cv.wait(lock, [this] {
                return impl_->waveform_stop || !impl_->waveform_q.empty();
            });
            if (impl_->waveform_stop && impl_->waveform_q.empty()) return;
            task = std::move(impl_->waveform_q.front());
            impl_->waveform_q.pop_front();
        }

        // Guard the whole task: an exception here (e.g. the throwing fs::exists
        // overload faulting on a disconnected network share, or compute_waveform
        // throwing) would escape this thread and std::terminate() the process.
        try {

        std::error_code fs_ec;
        const fs::path json_file = task.waveforms_dir.empty()
            ? fs::path{}
            : task.waveforms_dir / (task.item_uuid + ".json");

        // Remove stale cache entry when a forced regeneration is requested.
        if (task.force && !json_file.empty() && fs::exists(json_file, fs_ec)) {
            fs::remove(json_file, fs_ec);
        }

        // Serve from disk cache when available (skips full audio decode).
        if (!json_file.empty() && fs::exists(json_file, fs_ec)) {
            try {
                std::ifstream cache_f(json_file);
                const auto cached = json::parse(cache_f);
                if (!current_waveform_cache(cached))
                    throw std::runtime_error("stale analysis schema");
                broadcast_doc_patch(json{
                    {"type",            "doc_patch"},
                    {"op",              "waveform_ready"},
                    {"item_uuid",       task.item_uuid},
                    {"analysis_version", cached.at("analysis_version")},
                    {"integrated_lufs",  cached.at("integrated_lufs")},
                    {"true_peak_dbtp",   cached.at("true_peak_dbtp")},
                    {"bucket_count",    cached.at("bucket_count")},
                    {"duration_ms",     cached.at("duration_ms")},
                    {"sample_rate",     cached.at("sample_rate")},
                    {"source_channels", cached.at("source_channels")},
                    {"channels",        cached.at("channels")},
                });
                Logger::info("waveform_worker: served cached waveform for '{}'", task.item_uuid);
                continue;
            } catch (const std::exception& e) {
                Logger::warn("waveform_worker: cache read failed for '{}', recomputing: {}", task.item_uuid, e.what());
            }
        }

        Logger::info("waveform_worker: computing waveform for '{}'", liveplay::util::path_to_utf8(task.path));
        const auto wf = liveplay::meta::compute_waveform(task.path);
        if (!wf.ok) {
            Logger::warn("waveform_worker: compute_waveform failed for '{}'", liveplay::util::path_to_utf8(task.path));
            broadcast_doc_patch(json{
                {"type",      "doc_patch"},
                {"op",        "waveform_failed"},
                {"item_uuid", task.item_uuid},
            });
            continue;
        }

        const json waveform_data = waveform_data_json(wf);
        json patch = waveform_data;
        patch["type"]      = "doc_patch";
        patch["op"]        = "waveform_ready";
        patch["item_uuid"] = task.item_uuid;

        // Persist waveform so future project opens skip recomputation.
        if (!json_file.empty()) {
            try {
                fs::create_directories(task.waveforms_dir);
                std::ofstream out(json_file);
                // Write only the waveform data fields (not WS envelope fields).
                out << waveform_data.dump();
            } catch (const std::exception& e) {
                Logger::warn("waveform_worker: failed to save waveform cache for '{}': {}", task.item_uuid, e.what());
            }
        }

        broadcast_doc_patch(std::move(patch));
        Logger::info("waveform_worker: done for item_uuid '{}'", task.item_uuid);

        } catch (const std::exception& e) {
            Logger::error("waveform_worker: unhandled exception (skipping task): {}", e.what());
        } catch (...) {
            Logger::error("waveform_worker: unknown exception (skipping task).");
        }
    }
}

// Build a snapshot of all currently-known playback state. Sent to each new
// WS client on connect so a freshly-reconnected client immediately mirrors
// what every other client already sees: which cues are playing, where the
// playhead is, the user-set "Up Next" override, and the active preview.
// Without this, after a reconnect (or a second client joining mid-show)
// the UI would think nothing is playing until the next transport edge fires.
static json build_playback_snapshot(audio::AudioEngine& engine,
                                    core::ProjectState& state) {
    json cues_arr = json::array();
    for (auto& cue : state.list_cues()) {
        auto item = engine.find_cue(cue.id);
        if (!item) continue;
        const auto s = item->stats();
        if (s.transport == audio::TransportState::Stopped) continue;
        json entry{
            {"cue_id",           cue.id.value},
            {"transport",        static_cast<int>(s.transport)},
            {"playhead_seconds", s.playhead_seconds},
        };
        if (auto uuid = state.cue_to_item_uuid(cue.id)) {
            entry["item_uuid"] = *uuid;
            if (auto seq = state.item_trigger_seq(*uuid)) {
                entry["trigger_seq"] = *seq;
            }
        }
        cues_arr.push_back(std::move(entry));
    }
    json out_gains = json::array();
    for (audio::MasterChannelIndex i = 0; i < engine.config().master_channels; ++i) {
        const float db = engine.output_channel_gain_db(i);
        if (db != 0.0f) out_gains.push_back(json{{"channel", i}, {"db", db}});
    }
    return json{
        {"type",                "playback_snapshot"},
        {"cues",                std::move(cues_arr)},
        {"next_item_uuid",      state.next_item_override()},
        {"master_gain_db",      engine.master_gain_db()},
        {"output_channel_gains", std::move(out_gains)},
        // Shared operator UI state, so a client (or control surface) that joins
        // mid-show adopts the running selection / view mode instead of
        // imposing its own stale local one.
        {"selected_item_uuid",  state.selected_item_uuid()},
        {"show_mode",           state.show_mode()},
        {"locale",              state.ui_locale()},
        {"preview", json{
            {"item_uuid", state.current_preview_item_uuid()},
            {"cue_id",    state.current_preview_cue_id().value},
        }},
    };
}

// uuids of every item that is currently sounding, in cue-registration order.
// Used as the fallback anchor for selection stepping: with nothing selected,
// "select down" should continue from what the operator is hearing rather than
// snapping back to the top of the playlist. Returns empty when something IS
// already selected — an explicit selection always wins, and skipping the walk
// keeps the common case free.
static std::vector<std::string> selection_anchors(audio::AudioEngine& engine,
                                                  core::ProjectState& state) {
    std::vector<std::string> playing;
    if (!state.selected_item_uuid().empty()) return playing;
    for (auto& cue : state.list_cues()) {
        auto item = engine.find_cue(cue.id);
        if (!item) continue;
        if (item->stats().transport == audio::TransportState::Stopped) continue;
        if (auto uuid = state.cue_to_item_uuid(cue.id)) playing.push_back(*uuid);
    }
    return playing;
}

// ---------------------------------------------------------------------------
// Returns a non-empty string if a direct reply to this specific client is
// needed (pong, error). The caller sends it under ws_mutex so it doesn't
// race with broadcast_loop's concurrent send_text calls on the same conn.
static std::string handle_ws_message(crow::websocket::connection& conn,
                                     const std::string& msg,
                                     audio::AudioEngine& engine,
                                     core::ProjectState& state,
                                     const std::string& server_addr,
                                     std::mutex& command_mutex,
                                     std::unordered_map<std::string, std::string>& command_results,
                                     std::deque<std::string>& command_order) {
    Logger::api_request("Client ({}) -> Server ({}) : {}", conn.get_remote_ip(), server_addr, msg);

    json j;
    try { j = json::parse(msg); }
    catch (const std::exception& e) {
        Logger::warn("WS message parse failed: {}", e.what());
        return json({{"type", "error"}, {"message", e.what()}}).dump();
    }
    if (!j.is_object()) {
        Logger::warn("WS message rejected: top-level JSON must be an object");
        return json{
            {"type", "error"},
            {"message", "message must be a JSON object"},
        }.dump();
    }
    const std::string type = j.value("type", "");
    const std::string command_id =
        j.contains("command_id") && j["command_id"].is_string()
            ? j["command_id"].get<std::string>()
            : std::string{};
    if (command_id.size() > 128) {
        return json{
            {"type", "error"},
            {"message", "command_id exceeds 128 characters"},
        }.dump();
    }
    std::unique_lock<std::mutex> command_lock;
    if (!command_id.empty()) {
        command_lock = std::unique_lock{command_mutex};
        if (const auto it = command_results.find(command_id);
            it != command_results.end()) {
            return it->second;
        }
    }
    const auto remember_result = [&](std::string result) {
        if (command_id.empty()) return result;
        constexpr std::size_t max_results = 256;
        if (command_results.size() >= max_results) {
            command_results.erase(command_order.front());
            command_order.pop_front();
        }
        command_order.push_back(command_id);
        command_results.emplace(command_id, result);
        return result;
    };
    const auto command_error = [&](std::string_view message) {
        if (!command_id.empty()) {
            return remember_result(json{
                {"type", "command_ack"},
                {"command_id", command_id},
                {"ok", false},
                {"error", message},
            }.dump());
        }
        return json{{"type", "error"}, {"message", message}}.dump();
    };
    const auto command_ok = [&] {
        if (command_id.empty()) return std::string{};
        return remember_result(json{
            {"type", "command_ack"},
            {"command_id", command_id},
            {"ok", true},
        }.dump());
    };
    // Resolve a transport target: prefer "item_uuid" (preserves duckingBehavior
    // / inPoint semantics defined in the project document); fall back to
    // "cue_id" (raw engine id) for low-level callers.
    auto resolve_cue = [&](const json& jj) -> std::optional<audio::CueId> {
        if (jj.contains("item_uuid") && jj["item_uuid"].is_string()) {
            return state.item_to_cue_id(jj["item_uuid"].get<std::string>());
        }
        if (jj.contains("cue_id") && jj["cue_id"].is_string()) {
            return audio::CueId{jj["cue_id"].get<std::string>()};
        }
        return std::nullopt;
    };

    try {
        if (type == "play") {
            if (j.contains("item_uuid") && j["item_uuid"].is_string()) {
                const auto uuid = j["item_uuid"].get<std::string>();
                Logger::playback("PLAY: {}", item_playback_info(uuid, state));
                std::optional<double> start_seconds;
                if (j.contains("start_seconds")) {
                    if (!j["start_seconds"].is_number())
                        return command_error("play: start_seconds must be a number");
                    start_seconds = j["start_seconds"].get<double>();
                    if (!std::isfinite(*start_seconds) || *start_seconds < 0.0)
                        return command_error("play: invalid start_seconds");
                    if (!state.item_to_cue_id(uuid))
                        return command_error("play: start_seconds requires an audio item");
                }
                // Ordinary plays retain group dispatch; Properties can give an
                // audio item an explicit audition start without a seek/play race.
                const bool played = start_seconds
                    ? state.play_item(uuid, -1.0, audio::CueId{}, *start_seconds)
                    : state.trigger_item(uuid);
                if (!played)
                    return command_error("play: item not loaded into engine");
            } else {
                auto cue = resolve_cue(j);
                if (cue) {
                    // If this cue corresponds to a project item, route
                    // through play_item so duckingBehavior / inPoint /
                    // fades / endBehavior / sequencer auto-advance fire.
                    // Only fall back to raw engine.play() for orphan cues
                    // (e.g. ad-hoc /api/cues registrations with no item).
                    if (auto uuid = state.cue_to_item_uuid(*cue)) {
                        Logger::playback("PLAY: {}", item_playback_info(*uuid, state));
                        if (!state.play_item(*uuid))
                            return command_error("play: item not loaded into engine");
                    } else {
                        Logger::playback("PLAY: cue_id={} (orphan)", cue->value);
                        if (!engine.find_cue(*cue))
                            return command_error("play: cue not loaded into engine");
                        engine.play(*cue);
                    }
                } else {
                    Logger::warn("WS play: no valid cue target in message");
                    return command_error("play: no valid cue target");
                }
            }
        }
        else if (type == "stop") {
            if (j.contains("item_uuid") && j["item_uuid"].is_string()) {
                const auto uuid = j["item_uuid"].get<std::string>();
                Logger::playback("STOP: {}", item_playback_info(uuid, state));
                if (!state.stop_item(uuid))
                    return command_error("stop: item not loaded into engine");
            } else {
                auto cue = resolve_cue(j);
                if (cue) {
                    if (auto uuid = state.cue_to_item_uuid(*cue)) {
                        Logger::playback("STOP: {}", item_playback_info(*uuid, state));
                        if (!state.stop_item(*uuid))
                            return command_error("stop: item not loaded into engine");
                    } else {
                        Logger::playback("STOP: cue_id={} (orphan)", cue->value);
                        if (!engine.find_cue(*cue))
                            return command_error("stop: cue not loaded into engine");
                        engine.stop(*cue);
                    }
                } else {
                    Logger::warn("WS stop: no valid cue target in message");
                    return command_error("stop: no valid cue target");
                }
            }
        }
        else if (type == "pause" || type == "resume") {
            // Pause/resume hold the playhead without unloading. Routed via
            // item_uuid (preferred) or cue_id. No effect on Stopped cues.
            std::optional<audio::CueId> cue;
            if (j.contains("item_uuid") && j["item_uuid"].is_string()) {
                cue = state.item_to_cue_id(j["item_uuid"].get<std::string>());
            } else {
                cue = resolve_cue(j);
            }
            if (cue) {
                if (auto pi = engine.find_cue(*cue)) {
                    Logger::playback("{} cue_id={}",
                                     type == "pause" ? "PAUSE" : "RESUME",
                                     cue->value);
                    if (type == "pause") pi->pause();
                    else                 pi->resume();
                } else {
                    Logger::warn("WS {}: cue_id={} not live in engine", type, cue->value);
                    return command_error(type + ": cue not loaded into engine");
                }
            } else {
                Logger::warn("WS {}: no valid cue target", type);
                return command_error(type + ": no valid cue target");
            }
        }
        else if (type == "stop_all") {
            // Omitted fade_ms → server applies the project-wide default
            // (settings.stopAllFadeMs, default 1000 ms). An explicit fade_ms
            // (incl. 0 for an instant panic) is used verbatim. Global fade wins.
            std::optional<long long> fade;
            if (j.contains("fade_ms") && j["fade_ms"].is_number())
                fade = j["fade_ms"].get<long long>();
            Logger::playback("STOP ALL (fade {})",
                             fade ? std::to_string(*fade) + "ms" : "project default");
            state.stop_all_cues(fade);
        }
        else if (type == "go") {
            // Play whatever is armed as "Up Next" (override first, else the
            // playing item's endBehavior target). Same semantics as
            // POST /api/transport/go.
            const auto uuid = state.go();
            if (uuid.empty()) {
                Logger::warn("WS go: nothing armed or derivable to play");
                return command_error("nothing armed to GO to");
            }
            Logger::playback("GO: {}", item_playback_info(uuid, state));
        }
        else if (type == "cue_to_continue") {
            const std::string uuid = j.value("item_uuid", std::string{});
            if (uuid.empty())
                return command_error("cue_to_continue: missing item_uuid");
            if (!state.cue_to_continue(uuid))
                return command_error("cue_to_continue: item cannot be cued");
            Logger::playback("CUE TO CONTINUE: {}", item_playback_info(uuid, state));
        }
        else if (type == "gain") {
            auto cue = resolve_cue(j);
            if (cue) {
                if (!engine.find_cue(*cue))
                    return command_error("gain: cue not loaded into engine");
                const float db = j.value("db", 0.0f);
                Logger::api_request("Client ({}) -> Server ({}) : WS gain cue_id={} db={:.1f}",
                                    conn.get_remote_ip(), server_addr, cue->value, db);
                state.set_cue_gain_db(*cue, db);
            } else return command_error("gain: no valid cue target");
        }
        else if (type == "fade") {
            auto cue = resolve_cue(j);
            if (cue) {
                if (!engine.find_cue(*cue))
                    return command_error("fade: cue not loaded into engine");
                const auto in_ms  = j.value("in_ms",  (long long)0);
                const auto out_ms = j.value("out_ms", (long long)0);
                Logger::api_request("Client ({}) -> Server ({}) : WS fade cue_id={} in={}ms out={}ms",
                                    conn.get_remote_ip(), server_addr, cue->value, in_ms, out_ms);
                state.set_cue_fade_in (*cue, std::chrono::milliseconds{in_ms});
                state.set_cue_fade_out(*cue, std::chrono::milliseconds{out_ms});
            } else return command_error("fade: no valid cue target");
        }
        else if (type == "seek") {
            auto cue = resolve_cue(j);
            if (cue) {
                const double secs = j.value("seconds", 0.0);
                Logger::playback("SEEK {:.2f}s → cue_id={}", secs, cue->value);
                if (auto pi = engine.find_cue(*cue)) {
                    pi->seek_seconds(secs);
                } else {
                    Logger::warn("WS seek: cue_id={} not live in engine", cue->value);
                    return command_error("seek: cue not loaded into engine");
                }
            } else {
                Logger::warn("WS seek: no valid cue target");
                return command_error("seek: no valid cue target");
            }
        }
        else if (type == "preview_range") {
            const auto cue = state.current_preview_cue_id();
            const double in_seconds = j.value("in_seconds", -1.0);
            const double out_seconds = j.value("out_seconds", -1.0);
            if (cue.empty()) return command_error("preview_range: no preview cue");
            if (!std::isfinite(in_seconds) || !std::isfinite(out_seconds)
                || in_seconds < 0.0 || out_seconds <= in_seconds) {
                return command_error("preview_range: invalid In/Out range");
            }
            if (auto pi = engine.find_cue(cue)) {
                pi->set_out_point_seconds(out_seconds);
                pi->set_loop(j.value("loop", false), in_seconds);
            } else {
                return command_error("preview_range: preview cue not loaded into engine");
            }
        }
        else if (type == "set_next_item") {
            // User-set "Up Next" override. Empty/null item_uuid clears it.
            std::string uuid;
            if (j.contains("item_uuid") && j["item_uuid"].is_string()) {
                uuid = j["item_uuid"].get<std::string>();
            }
            if (uuid.empty())
                Logger::playback("SET NEXT: <clear>");
            else
                Logger::playback("SET NEXT: {}", item_playback_info(uuid, state));
            state.set_next_item_override(uuid);
            // Fan-out to every client happens in the .onmessage wrapper
            // (which has access to the ControlServer for broadcast).
        }
        else if (type == "set_selection") {
            // Shared playlist selection. Empty/absent item_uuid clears it.
            // ProjectState broadcasts the change (including back to the sender,
            // which is what keeps two clients from diverging).
            std::string uuid;
            if (j.contains("item_uuid") && j["item_uuid"].is_string())
                uuid = j["item_uuid"].get<std::string>();
            state.set_selected_item(uuid);
        }
        else if (type == "select_step") {
            // Move the shared selection through the flattened playlist.
            //
            // With nothing selected we hand ProjectState the items that are
            // currently sounding, so the step continues from what the operator
            // is hearing instead of snapping back to the top of the show. This
            // only applies when there is no selection — an explicit selection
            // always wins.
            const int delta = j.value("delta", 0);
            if (delta == 0) return command_error("select_step: delta must be non-zero");
            state.step_selection(delta, selection_anchors(engine, state));
        }
        else if (type == "set_show_mode") {
            // Omit "enabled" to toggle.
            if (j.contains("enabled") && j["enabled"].is_boolean())
                state.set_show_mode(j["enabled"].get<bool>());
            else
                state.toggle_show_mode();
        }
        else if (type == "set_locale") {
            if (!j.contains("locale") || !j["locale"].is_string() ||
                j["locale"].get_ref<const std::string&>().empty()) {
                return command_error("set_locale: locale must be a non-empty string");
            }
            state.set_ui_locale(j["locale"].get<std::string>());
        }
        else if (type == "ping") {
            return json({{"type", "pong"}}).dump();
        }
        else {
            Logger::warn("WS unknown message type: {}", type);
            return command_error("unknown type");
        }
    } catch (const std::exception& e) {
        Logger::error("WS handler threw: {}", e.what());
        return command_error(e.what());
    } catch (...) {
        Logger::error("WS handler caught unknown exception.");
        return command_error("internal error");
    }
    return command_ok();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
void ControlServer::install_routes() {
    auto& app = impl_->app;
    impl_->server_addr = std::format("{}:{}", cfg_.bind_address, cfg_.port);
    app.websocket_max_payload(64 * 1024);
    auto& security_middleware = app.get_middleware<ControlSecurityMiddleware>();
    security_middleware.access_token = cfg_.access_token;
    security_middleware.allowed_origins = cfg_.allowed_origins;
    security_middleware.max_upload_bytes = cfg_.max_upload_bytes;

    // Route Crow's internal logs through our Logger and silence the noisy
    // per-request INFO lines (we log those ourselves via api_request/api_response).
    static CrowLogBridge crow_log_bridge;
    crow::logger::setHandler(&crow_log_bridge);
    crow::logger::setLogLevel(crow::LogLevel::Warning);

    // Central exception handler: any route that throws past its own try/catch
    // (or has none) lands here instead of Crow's bare 500. Crow invokes this
    // from inside a catch(...) block, so a `throw;` re-raises the active
    // exception, letting us recover its message. We reply with the same JSON +
    // CORS shape as json_err() so browser clients never see an opaque,
    // CORS-less 500.
    app.exception_handler([](crow::response& res){
        std::string message = "internal server error";
        try {
            throw;
        } catch (const std::exception& e) {
            message = e.what();
            Logger::error("Uncaught exception in route handler: {}", e.what());
        } catch (...) {
            Logger::error("Uncaught non-std exception in route handler.");
        }
        res = json_err(500, message);
    });

    // ---- Health ----
    CROW_ROUTE(app, "/api/health").methods(crow::HTTPMethod::Get)
        ([this] {
            try {
                return json_ok(json({
                    {"ok", true},
                    {"name", "dwcue-server"},
                    {"pid", current_process_id()},
                    {"instanceToken", cfg_.instance_token},
                }));
            }
            catch (...) { return json_err(500, "internal error"); }
        });

    // Returns the requesting client's IP as seen by the server, plus a
    // boolean `isLocal` that's true when the client lives on the same
    // machine (loopback addresses). Used by the import/export flows to
    // decide whether to offer the dual-dialog choice — picking files from
    // "this computer" only makes sense when client and server are different
    // machines.
    CROW_ROUTE(app, "/api/whoami").methods(crow::HTTPMethod::Get)
        ([](const crow::request& req){
            const std::string ip = req.remote_ip_address;
            // Loopback test covers IPv4 127.0.0.0/8 plus the usual IPv6 forms.
            const bool is_local =
                ip == "127.0.0.1" ||
                ip == "::1" ||
                ip == "0:0:0:0:0:0:0:1" ||
                ip == "::ffff:127.0.0.1" ||
                ip.rfind("127.", 0) == 0;
            return json_ok(json{{"clientIp", ip}, {"isLocal", is_local}});
        });

    // ---- Devices ----
    CROW_ROUTE(app, "/api/devices").methods(crow::HTTPMethod::Get)
        ([this] {
            try {
                json arr = json::array();
                for (auto& d : engine_.enumerate_devices()) arr.push_back(device_info_to_json(d));
                return json_ok(arr);
            } catch (const std::exception& e) { return json_err(500, e.what()); }
            catch (...) { return json_err(500, "unknown error enumerating devices"); }
        });

    CROW_ROUTE(app, "/api/devices/open").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                auto j = json::parse(req.body);
                const std::string name = j.value("name", "");
                const audio::ChannelCount ch = j.value("channels", (audio::ChannelCount)2);
                const auto id = name.empty()
                                  ? engine_.open_default_device(ch)
                                  : engine_.open_device_by_name(name, ch);
                if (id.empty()) return json_err(400, "device open failed");
                return json_ok(json({{"device_id", id.value}}));
            } catch (const std::exception& e) { return json_err(400, e.what()); }
        });

    CROW_ROUTE(app, "/api/devices/close").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                auto j = json::parse(req.body);
                engine_.close_device(audio::DeviceId{j.at("id").get<std::string>()});
                return json_ok(json({{"ok", true}}));
            } catch (const std::exception& e) { return json_err(400, e.what()); }
        });

    CROW_ROUTE(app, "/api/devices/<string>/recover").methods(crow::HTTPMethod::Post)
        ([this](std::string id) {
            const auto request_id = engine_.request_device_recovery(
                audio::DeviceId{std::move(id)});
            if (!request_id) {
                return json_err(404, "device not found or recovery unavailable");
            }
            crow::response response{202, json({
                {"accepted", true},
                {"request_id", *request_id},
            }).dump()};
            response.set_header("Content-Type", "application/json");
            return response;
        });

    // ---- Cues ----
    CROW_ROUTE(app, "/api/cues").methods(crow::HTTPMethod::Get)
        ([this] {
            json arr = json::array();
            for (auto& c : state_.list_cues()) arr.push_back(cue_to_json(c, engine_));
            return json_ok(arr);
        });

    CROW_ROUTE(app, "/api/cues").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                auto j = json::parse(req.body);
                const fs::path file = liveplay::util::utf8_to_path(j.at("file_path").get<std::string>());
                std::string name = j.value("display_name", "");
                const auto id = state_.add_cue_from_file(file, std::move(name));
                if (id.empty()) return json_err(400, "failed to load file");
                auto meta = state_.find_cue(id);
                return json_ok(meta ? cue_to_json(*meta, engine_) : json{{"id", id.value}});
            } catch (const std::exception& e) { return json_err(400, e.what()); }
        });

    CROW_ROUTE(app, "/api/cues/<string>").methods(crow::HTTPMethod::Get)
        ([this](std::string id) {
            auto m = state_.find_cue(audio::CueId{id});
            if (!m) return json_err(404, "not found");
            return json_ok(cue_to_json(*m, engine_));
        });

    CROW_ROUTE(app, "/api/cues/<string>").methods(crow::HTTPMethod::Delete)
        ([this](std::string id) {
            // remove_cue() returns void, so probe existence first and 404 if
            // the target cue is unknown (mirrors the item play/stop routes).
            if (!state_.find_cue(audio::CueId{id})) return json_err(404, "not found");
            state_.remove_cue(audio::CueId{id});
            return json_ok(json({{"ok", true}}));
        });

    CROW_ROUTE(app, "/api/cues/<string>/play").methods(crow::HTTPMethod::Post)
        ([this](std::string id) {
            if (!engine_.find_cue(audio::CueId{id})) return json_err(404, "not found");
            engine_.play(audio::CueId{id});
            return json_ok(json({{"ok", true}}));
        });
    CROW_ROUTE(app, "/api/cues/<string>/stop").methods(crow::HTTPMethod::Post)
        ([this](std::string id) {
            if (!engine_.find_cue(audio::CueId{id})) return json_err(404, "not found");
            engine_.stop(audio::CueId{id});
            return json_ok(json({{"ok", true}}));
        });

    CROW_ROUTE(app, "/api/cues/<string>/gain").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req, std::string id){
            try {
                auto j = json::parse(req.body);
                state_.set_cue_gain_db(audio::CueId{id}, j.value("db", 0.0f));
                return json_ok(json({{"ok", true}}));
            } catch (const std::exception& e) { return json_err(400, e.what()); }
        });

    CROW_ROUTE(app, "/api/cues/<string>/fade").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req, std::string id){
            try {
                auto j = json::parse(req.body);
                state_.set_cue_fade_in (audio::CueId{id},
                    std::chrono::milliseconds{j.value("in_ms",  (long long)0)});
                state_.set_cue_fade_out(audio::CueId{id},
                    std::chrono::milliseconds{j.value("out_ms", (long long)0)});
                return json_ok(json({{"ok", true}}));
            } catch (const std::exception& e) { return json_err(400, e.what()); }
        });

    CROW_ROUTE(app, "/api/cues/<string>/ltc").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req, std::string id){
            try {
                auto j        = json::parse(req.body);
                const bool enabled = j.value("enabled", false);
                const int  fps     = j.value("fps", 4);
                // Accept either a human-readable "HH:MM:SS:FF" start_timecode
                // or a raw offset_ns (legacy callers). The timecode string takes
                // priority when present.
                std::chrono::nanoseconds offset{j.value("offset_ns", (long long)0)};
                std::string tc_str = j.value("start_timecode", std::string{"00:00:00:00"});
                if (j.contains("start_timecode") && j["start_timecode"].is_string()) {
                    // Convert "HH:MM:SS:FF" to nanoseconds using the fps index.
                    int hh = 0, mm = 0, ss = 0, ff = 0;
                    static const int kFpsInt[]  = {24, 25, 30, 30, 30};
                    static const double kFps[]  = {24.0, 25.0, 30000.0/1001.0,
                                                   30000.0/1001.0, 30.0};
                    if (std::sscanf(tc_str.c_str(), "%d:%d:%d:%d", &hh, &mm, &ss, &ff) < 4)
                        std::sscanf(tc_str.c_str(), "%d:%d:%d;%d", &hh, &mm, &ss, &ff);
                    const int idx = std::clamp(fps, 0, 4);
                    ff = std::clamp(ff, 0, kFpsInt[idx] - 1);
                    const long long frames = static_cast<long long>(hh) * 3600LL * kFpsInt[idx]
                                           + static_cast<long long>(mm) *   60LL * kFpsInt[idx]
                                           + static_cast<long long>(ss)           * kFpsInt[idx]
                                           + ff;
                    const double secs = static_cast<double>(frames) / kFps[idx];
                    offset = std::chrono::nanoseconds{static_cast<long long>(secs * 1e9)};
                }
                state_.set_cue_ltc(audio::CueId{id}, enabled, fps, offset);
                return json_ok(json({{"ok", true}}));
            } catch (const std::exception& e) { return json_err(400, e.what()); }
        });

    // ---- Transport / master ----
    CROW_ROUTE(app, "/api/transport/stop_all").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                auto j = json::parse(req.body.empty() ? std::string{"{}"} : req.body);
                // Omitted fade_ms → project-wide default; explicit value used
                // verbatim (0 = instant). Global fade wins over per-track fades.
                std::optional<long long> fade;
                if (j.contains("fade_ms") && j["fade_ms"].is_number())
                    fade = j["fade_ms"].get<long long>();
                state_.stop_all_cues(fade);
                return json_ok(json({{"ok", true}}));
            } catch (const std::exception& e) { return json_err(400, e.what()); }
        });

    // ---- External-control surface (Bitfocus Companion, custom remotes) ----
    // Compact machine-readable transport summary. Control surfaces fetch this
    // once on connect (and after a project_changed doc_patch), then keep it
    // fresh from the /ws push stream — no polling.
    CROW_ROUTE(app, "/api/state/summary").methods(crow::HTTPMethod::Get)
        ([this] {
            try {
                json s = state_.state_summary();
                s["server"] = json{
                    {"version", std::string{
#ifdef LIVEPLAY_SERVER_VERSION
                        LIVEPLAY_SERVER_VERSION
#else
                        "0.0.0"
#endif
                    }},
                    {"meterBroadcastHz", cfg_.meter_broadcast_hz},
                };
                return json_ok(s);
            } catch (const std::exception& e) { return json_err(500, e.what()); }
            catch (...) { return json_err(500, "internal error"); }
        });

    // GO — play whatever is armed as "Up Next" (user override first, else the
    // playing item's endBehavior target).
    CROW_ROUTE(app, "/api/transport/go")
        .methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            Logger::api_request("Client ({}) -> Server ({}) : {} /api/transport/go",
                                req.remote_ip_address, impl_->server_addr,
                                crow::method_name(req.method));
            const std::string uuid = state_.go();
            if (uuid.empty()) {
                Logger::warn("GO — nothing armed or derivable to play");
                return json_err(404, "nothing armed or playing to GO to");
            }
            Logger::playback("GO: {}", item_playback_info(uuid, state_));
            return json_ok(json({{"ok", true}, {"uuid", uuid}}));
        });

    // ---- Shared operator UI state (selection / Show Mode / locale) --------
    // These back the control-surface equivalents of the client's arrow keys,
    // Show Mode switch and language picker. Every mutation is broadcast as a
    // doc_patch, so the on-screen playlist and a Companion button can never
    // disagree about what is selected.

    CROW_ROUTE(app, "/api/selection").methods(crow::HTTPMethod::Get)
        ([this]{
            const auto uuid = state_.selected_item_uuid();
            return json_ok(json({{"itemUuid", uuid}}));
        });

    // Body: { "itemUuid": "..." } to select (empty string clears), or
    //       { "delta": -1 | 1 }  to step through the flattened playlist.
    CROW_ROUTE(app, "/api/selection").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                auto j = json::parse(req.body.empty() ? std::string{"{}"} : req.body);
                std::string uuid;
                if (j.contains("delta") && j["delta"].is_number_integer()) {
                    const int delta = j["delta"].get<int>();
                    if (delta == 0) return json_err(400, "delta must be non-zero");
                    uuid = state_.step_selection(delta, selection_anchors(engine_, state_));
                    if (uuid.empty()) return json_err(404, "playlist is empty");
                } else if (j.contains("itemUuid") && j["itemUuid"].is_string()) {
                    uuid = j["itemUuid"].get<std::string>();
                    state_.set_selected_item(uuid);
                } else {
                    return json_err(400, "expected \"itemUuid\" or \"delta\"");
                }
                return json_ok(json({{"ok", true}, {"itemUuid", uuid}}));
            } catch (const std::exception& e) { return json_err(400, e.what()); }
        });

    // Arm the selected item as "Up Next" — the control-surface equivalent of
    // the client's "Set As Next" context action.
    CROW_ROUTE(app, "/api/transport/arm_selected")
        .methods(crow::HTTPMethod::Post)
        ([this]{
            const auto uuid = state_.selected_item_uuid();
            if (uuid.empty()) return json_err(404, "nothing is selected");
            state_.set_next_item_override(uuid);
            Logger::playback("ARM SELECTED: {}", item_playback_info(uuid, state_));
            return json_ok(json({{"ok", true}, {"itemUuid", uuid}}));
        });

    // Trigger the selected item (the client's Enter / "Play Selected" key).
    CROW_ROUTE(app, "/api/transport/play_selected")
        .methods(crow::HTTPMethod::Post)
        ([this]{
            const auto uuid = state_.selected_item_uuid();
            if (uuid.empty()) return json_err(404, "nothing is selected");
            Logger::playback("PLAY SELECTED: {}", item_playback_info(uuid, state_));
            if (!state_.trigger_item(uuid))
                return json_err(404, "item not loaded into engine");
            return json_ok(json({{"ok", true}, {"itemUuid", uuid}}));
        });

    // Pause / resume everything on air in one press — the control-surface
    // equivalent of the client's Pause/Resume key. Resumes if anything is
    // paused, otherwise pauses everything sounding; that way a single button
    // is never ambiguous about which way it will go.
    CROW_ROUTE(app, "/api/transport/pause_toggle")
        .methods(crow::HTTPMethod::Post)
        ([this]{
            const json summary = state_.state_summary();
            std::vector<std::string> paused, sounding;
            for (const auto& p : summary.value("playing", json::array())) {
                const auto uuid = p.value("itemUuid", std::string{});
                if (uuid.empty()) continue;
                if (p.value("paused", false)) paused.push_back(uuid);
                else                          sounding.push_back(uuid);
            }
            if (paused.empty() && sounding.empty())
                return json_err(404, "nothing is on air");
            const bool resuming = !paused.empty();
            for (const auto& uuid : resuming ? paused : sounding) {
                if (auto cue = state_.item_to_cue_id(uuid)) {
                    if (auto pi = engine_.find_cue(*cue)) {
                        if (resuming) pi->resume(); else pi->pause();
                    }
                }
            }
            Logger::playback("PAUSE TOGGLE: {} {} item(s)",
                             resuming ? "resumed" : "paused",
                             resuming ? paused.size() : sounding.size());
            return json_ok(json({{"ok", true}, {"resumed", resuming}}));
        });

    CROW_ROUTE(app, "/api/ui/showmode").methods(crow::HTTPMethod::Get)
        ([this]{ return json_ok(json({{"enabled", state_.show_mode()}})); });

    // Body: { "enabled": bool }; omit the field (or send an empty body) to toggle.
    CROW_ROUTE(app, "/api/ui/showmode").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                auto j = json::parse(req.body.empty() ? std::string{"{}"} : req.body);
                bool enabled;
                if (j.contains("enabled") && j["enabled"].is_boolean()) {
                    enabled = j["enabled"].get<bool>();
                    state_.set_show_mode(enabled);
                } else {
                    enabled = state_.toggle_show_mode();
                }
                return json_ok(json({{"ok", true}, {"enabled", enabled}}));
            } catch (const std::exception& e) { return json_err(400, e.what()); }
        });

    CROW_ROUTE(app, "/api/ui/locale").methods(crow::HTTPMethod::Get)
        ([this]{ return json_ok(json({{"locale", state_.ui_locale()}})); });

    CROW_ROUTE(app, "/api/ui/locale").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                auto j = json::parse(req.body.empty() ? std::string{"{}"} : req.body);
                if (!j.contains("locale") || !j["locale"].is_string())
                    return json_err(400, "expected \"locale\"");
                state_.set_ui_locale(j["locale"].get<std::string>());
                return json_ok(json({{"ok", true}, {"locale", state_.ui_locale()}}));
            } catch (const std::exception& e) { return json_err(400, e.what()); }
        });

    // First-class body-addressed variant of /api/project/items/by-index/…
    // Body: { "index": [1, 11] } — an index path descending into groups.
    CROW_ROUTE(app, "/api/transport/play_index").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                auto j = json::parse(req.body);
                std::vector<int> path;
                if (j.contains("index") && j["index"].is_array()) {
                    for (const auto& v : j["index"]) {
                        if (!v.is_number_integer() || v.get<int>() < 0)
                            return json_err(400, "index must contain non-negative integers");
                        path.push_back(v.get<int>());
                    }
                }
                if (path.empty())
                    return json_err(400, "index must be a non-empty array of child indices");
                const std::string uuid = state_.item_uuid_by_index(path);
                if (uuid.empty()) return json_err(404, "no item at that index");
                Logger::playback("TRIGGER: {}", item_playback_info(uuid, state_));
                if (!state_.trigger_item(uuid))
                    return json_err(404, "item not loaded into engine");
                return json_ok(json({{"ok", true}, {"uuid", uuid}, {"index", path}}));
            } catch (const std::exception& e) { return json_err(400, e.what()); }
        });

    // Trigger the item bound to a cart slot.
    CROW_ROUTE(app, "/api/transport/cart/<int>/play")
        .methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req, int slot){
            Logger::api_request("Client ({}) -> Server ({}) : {} /api/transport/cart/{}/play",
                                req.remote_ip_address, impl_->server_addr,
                                crow::method_name(req.method), slot);
            const std::string uuid = state_.cart_slot_item_uuid(slot);
            if (uuid.empty()) return json_err(404, "cart slot is empty");
            Logger::playback("CART {}: {}", slot, item_playback_info(uuid, state_));
            if (!state_.trigger_item(uuid))
                return json_err(404, "item not loaded into engine");
            return json_ok(json({{"ok", true}, {"slot", slot}, {"uuid", uuid}}));
        });

    CROW_ROUTE(app, "/api/master/ceiling").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                auto j = json::parse(req.body);
                if (!j.contains("db") || !j["db"].is_number())
                    return json_err(400, "db must be a number between -60 and 0");
                const double db = j["db"].get<double>();
                if (!std::isfinite(db) || db < -60.0 || db > 0.0)
                    return json_err(400, "db must be a finite number between -60 and 0");
                if (!state_.patch_settings(json{{"limiterCeilingDb", db}}))
                    return json_err(400, "invalid limiter ceiling");
                auto settings = state_.full_document()["settings"];
                broadcast_doc_patch(json{
                    {"type", "doc_patch"}, {"op", "settings_patched"},
                    {"settings", settings},
                });
                return json_ok(json({
                    {"ok", true},
                    {"db", settings["outputTargetLevels"].value("limiterCeilingDb", -0.1f)},
                }));
            } catch (const std::exception& e) { return json_err(400, e.what()); }
        });

    CROW_ROUTE(app, "/api/master/gain").methods(crow::HTTPMethod::Get)
        ([this]{ return json_ok(json({{"db", engine_.master_gain_db()}})); });
    CROW_ROUTE(app, "/api/master/gain").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                auto j = json::parse(req.body);
                // "db" sets an absolute gain; "delta" nudges the current gain
                // (control-surface increment/decrement without a read-modify-
                // write race on the caller's side). "db" wins if both present.
                float db;
                if (!j.contains("db") && j.contains("delta") && j["delta"].is_number())
                    db = engine_.master_gain_db() + j["delta"].get<float>();
                else
                    db = j.value("db", 0.0f);
                engine_.set_master_gain_db(db);
                broadcast_doc_patch(json{
                    {"type", "doc_patch"}, {"op", "master_gain_changed"},
                    {"db", engine_.master_gain_db()},
                });
                return json_ok(json({{"ok", true}, {"db", engine_.master_gain_db()}}));
            } catch (const std::exception& e) { return json_err(400, e.what()); }
        });

    // Master true-peak limiter enable/bypass. POST body { "enabled": bool };
    // omitting "enabled" toggles the current state (single-button surfaces).
    CROW_ROUTE(app, "/api/master/limiter").methods(crow::HTTPMethod::Get)
        ([this]{ return json_ok(json({{"enabled", engine_.limiter_enabled()}})); });
    CROW_ROUTE(app, "/api/master/limiter").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                auto j = json::parse(req.body.empty() ? std::string{"{}"} : req.body);
                const bool enabled =
                    (j.contains("enabled") && j["enabled"].is_boolean())
                        ? j["enabled"].get<bool>()
                        : !engine_.limiter_enabled();
                engine_.set_limiter_enabled(enabled);
                broadcast_doc_patch(json{
                    {"type", "doc_patch"}, {"op", "limiter_changed"},
                    {"enabled", enabled},
                });
                return json_ok(json({{"ok", true}, {"enabled", enabled}}));
            } catch (const std::exception& e) { return json_err(400, e.what()); }
        });

    // Per-output-channel gain. GET returns all channels; POST body { "db": float }
    // sets the gain for a specific master channel index.
    CROW_ROUTE(app, "/api/master/channels/<int>/gain").methods(crow::HTTPMethod::Get)
        ([this](int idx){
            if (idx < 0) return json_err(400, "invalid channel index");
            return json_ok(json({
                {"channel", idx},
                {"db", engine_.output_channel_gain_db(static_cast<audio::MasterChannelIndex>(idx))},
            }));
        });
    CROW_ROUTE(app, "/api/master/channels/<int>/gain").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req, int idx){
            try {
                if (idx < 0) return json_err(400, "invalid channel index");
                auto j = json::parse(req.body);
                const float db = j.value("db", 0.0f);
                const auto ch = static_cast<audio::MasterChannelIndex>(idx);
                engine_.set_output_channel_gain_db(ch, db);
                broadcast_doc_patch(json{
                    {"type", "doc_patch"}, {"op", "output_channel_gain_changed"},
                    {"channel", idx}, {"db", engine_.output_channel_gain_db(ch)},
                });
                return json_ok(json({
                    {"ok", true}, {"channel", idx},
                    {"db", engine_.output_channel_gain_db(ch)},
                }));
            } catch (const std::exception& e) { return json_err(400, e.what()); }
        });

    // ---- Mixer channels ----
    CROW_ROUTE(app, "/api/mixers").methods(crow::HTTPMethod::Get)
        ([this] {
            json arr = json::array();
            for (auto& m : state_.list_mixer_channels()) {
                arr.push_back(json{
                    {"id",           m.id.value},
                    {"display_name", m.display_name},
                    {"gain_db",      m.gain_db},
                    {"muted",        m.muted},
                    {"soloed",       m.soloed},
                });
            }
            return json_ok(arr);
        });

    CROW_ROUTE(app, "/api/mixers").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                auto j = json::parse(req.body);
                const auto id = engine_.create_mixer_channel(j.value("name", "Channel"));
                return json_ok(json({{"id", id.value}}));
            } catch (const std::exception& e) { return json_err(400, e.what()); }
        });

    CROW_ROUTE(app, "/api/mixers/<string>").methods(crow::HTTPMethod::Delete)
        ([this](std::string id){
            // remove_mixer_channel() returns void; probe first and 404 if absent.
            if (!engine_.find_mixer_channel(audio::MixerChannelId{id}))
                return json_err(404, "not found");
            engine_.remove_mixer_channel(audio::MixerChannelId{id});
            return json_ok(json({{"ok", true}}));
        });

    // ---- Routing ----
    CROW_ROUTE(app, "/api/routing/item_to_mixer").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                auto j = json::parse(req.body);
                // "lane": destination strip lane (0 = L, 1 = R). Omitted →
                // every lane (legacy mono-bus behaviour / mono sources).
                engine_.route_item_source_to_mixer(
                    audio::CueId{j.at("cue").get<std::string>()},
                    j.value("source_channel", (audio::ChannelIndex)0),
                    audio::MixerChannelId{j.at("mixer").get<std::string>()},
                    j.value("gain_db", 0.0f),
                    j.value("lane", audio::kAllMixerLanes));
                return json_ok(json({{"ok", true}}));
            } catch (const std::exception& e) { return json_err(400, e.what()); }
        });

    CROW_ROUTE(app, "/api/routing/mixer_to_master").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                auto j = json::parse(req.body);
                // "lane": source strip lane feeding this master (0 = L,
                // 1 = R). Omitted → sum of every lane (mono downmix; legacy).
                engine_.route_mixer_to_master(
                    audio::MixerChannelId{j.at("mixer").get<std::string>()},
                    j.value("master_channel", (audio::MasterChannelIndex)0),
                    j.value("gain_db", 0.0f),
                    j.value("lane", audio::kAllMixerLanes));
                return json_ok(json({{"ok", true}}));
            } catch (const std::exception& e) { return json_err(400, e.what()); }
        });

    CROW_ROUTE(app, "/api/routing/master_to_device").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                auto j = json::parse(req.body);
                engine_.assign_master_to_device(
                    j.value("master_channel", (audio::MasterChannelIndex)0),
                    audio::DeviceId{j.at("device").get<std::string>()},
                    j.value("hw_channel", (audio::ChannelIndex)0));
                return json_ok(json({{"ok", true}}));
            } catch (const std::exception& e) { return json_err(400, e.what()); }
        });

    // ---- Filesystem browsing ----
    // GET /api/fs/list?path=<utf8>&filter=<comma-separated-exts|all|audio>
    //   path  ""  → "computer" root: enumerate logical drives on Windows,
    //                 "/" on POSIX. Each drive is reported with kind=="drive".
    //   filter:
    //     "audio" (default) — show files and let the decoder inspect them
    //     "all"             — list every regular file
    //     ".liveplay,.lpa"  — comma-separated extension allow-list
    CROW_ROUTE(app, "/api/fs/list").methods(crow::HTTPMethod::Get)
        ([](const crow::request& req){
            try {
                const char* path_param   = req.url_params.get("path");
                const char* filter_param = req.url_params.get("filter");
                std::string path        = path_param ? path_param : "";
                std::string filter      = filter_param ? filter_param : "audio";

                // Empty path == "computer" root. On Windows we enumerate
                // logical drives (and mapped network drives). On POSIX we
                // start at '/'. This lets the picker behave like a native
                // file dialog.
                if (path.empty()) {
                    json out;
                    out["path"]    = "";        // sentinel: computer root
                    out["parent"]  = "";
                    out["is_root"] = true;
                    out["entries"] = json::array();

                    auto add_entry = [&](const std::string& name,
                                         const std::string& full,
                                         const char* kind) {
                        if (full.empty()) return;
                        json e;
                        e["name"]      = name;
                        e["full_path"] = full;
                        e["kind"]      = kind;
                        out["entries"].push_back(std::move(e));
                    };

                    // Home shortcut on every platform. The dialog used to open
                    // at "/" with no way to reach $HOME or a mounted USB stick,
                    // which made opening a project off removable media painful
                    // on Linux especially. (#31)
#if defined(_WIN32)
                    if (const char* up = std::getenv("USERPROFILE"))
                        add_entry("Home", up, "home");
#else
                    if (const char* hp = std::getenv("HOME"))
                        add_entry("Home", hp, "home");
#endif

#if defined(_WIN32)
                    // Enumerate logical drives WITH volume label + drive type,
                    // e.g. "Local Disk (C:)" / "MoviesAndTV (P:)" rather than a
                    // bare "C:". Mapped network drives also resolve their UNC
                    // target for display. (#31)
                    auto wide_to_utf8 = [](const std::wstring& w) -> std::string {
                        if (w.empty()) return {};
                        const int len = WideCharToMultiByte(CP_UTF8, 0, w.data(),
                            static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
                        if (len <= 0) return {};
                        std::string s(static_cast<std::size_t>(len), '\0');
                        WideCharToMultiByte(CP_UTF8, 0, w.data(),
                            static_cast<int>(w.size()), s.data(), len, nullptr, nullptr);
                        return s;
                    };
                    DWORD mask = GetLogicalDrives();
                    for (char letter = 'A'; letter <= 'Z'; ++letter, mask >>= 1) {
                        if (!(mask & 1)) continue;
                        const std::wstring wroot =
                            std::wstring{} + static_cast<wchar_t>(letter) + L":\\";
                        const std::string  root = std::string{letter} + ":\\";
                        const UINT dtype = GetDriveTypeW(wroot.c_str());
                        wchar_t vol[MAX_PATH + 1] = {0};
                        std::string label;
                        if (GetVolumeInformationW(wroot.c_str(), vol, MAX_PATH,
                                nullptr, nullptr, nullptr, nullptr, 0)) {
                            label = wide_to_utf8(vol);
                        }
                        if (dtype == DRIVE_REMOTE) {
                            wchar_t remote[512];
                            DWORD rlen = 512;
                            const std::wstring dev =
                                std::wstring{} + static_cast<wchar_t>(letter) + L":";
                            if (WNetGetConnectionW(dev.c_str(), remote, &rlen) == NO_ERROR) {
                                const std::string unc = wide_to_utf8(remote);
                                if (!unc.empty())
                                    label = label.empty()
                                        ? unc : label + " (" + unc + ")";
                            }
                        }
                        if (label.empty()) {
                            switch (dtype) {
                                case DRIVE_REMOVABLE: label = "Removable Disk"; break;
                                case DRIVE_REMOTE:    label = "Network Drive";  break;
                                case DRIVE_CDROM:     label = "CD Drive";       break;
                                case DRIVE_RAMDISK:   label = "RAM Disk";       break;
                                default:              label = "Local Disk";     break;
                            }
                        }
                        add_entry(label + " (" + std::string{letter} + ":)",
                                  root, "drive");
                    }
#elif defined(__APPLE__)
                    // On macOS every mounted volume — the startup disk, external
                    // and USB drives, and network shares — lives under /Volumes.
                    add_entry("Computer", "/", "drive");
                    std::error_code vol_ec;
                    if (fs::is_directory("/Volumes", vol_ec)) {
                        for (auto& ent : fs::directory_iterator("/Volumes",
                                 fs::directory_options::skip_permission_denied, vol_ec)) {
                            std::error_code d_ec;
                            if (!ent.is_directory(d_ec)) continue;
                            add_entry(liveplay::util::path_to_utf8(ent.path().filename()),
                                      liveplay::util::path_to_utf8(ent.path()), "drive");
                        }
                    }
#else
                    // Linux/other POSIX: filesystem root plus auto-mounted media
                    // (USB sticks, network shares). udisks2/desktop environments
                    // mount removable media under /media/<user> or
                    // /run/media/<user>; fall back to a bare /media on
                    // single-user setups, and always include /mnt. (#31)
                    add_entry("File System", "/", "drive");
                    std::vector<std::string> mount_parents;
                    const char* user = std::getenv("USER");
                    bool have_user_media = false;
                    if (user) {
                        std::error_code u_ec;
                        const std::string um  = std::string("/media/") + user;
                        const std::string urm = std::string("/run/media/") + user;
                        if (fs::is_directory(um, u_ec))  { mount_parents.push_back(um);  have_user_media = true; }
                        if (fs::is_directory(urm, u_ec)) { mount_parents.push_back(urm); have_user_media = true; }
                    }
                    if (!have_user_media) mount_parents.push_back("/media");
                    mount_parents.push_back("/mnt");
                    std::set<std::string> seen;
                    for (const auto& parent : mount_parents) {
                        std::error_code m_ec;
                        if (!fs::is_directory(parent, m_ec)) continue;
                        for (auto& ent : fs::directory_iterator(parent,
                                 fs::directory_options::skip_permission_denied, m_ec)) {
                            std::error_code d_ec;
                            if (!ent.is_directory(d_ec)) continue;
                            const std::string full = liveplay::util::path_to_utf8(ent.path());
                            if (!seen.insert(full).second) continue;
                            add_entry(liveplay::util::path_to_utf8(ent.path().filename()),
                                      full, "drive");
                        }
                    }
#endif
                    return json_ok(out);
                }

                fs::path p = liveplay::util::utf8_to_path(path);
                std::error_code canon_ec;
                fs::path canon = fs::weakly_canonical(p, canon_ec);
                if (!canon_ec) p = canon;
                if (!fs::exists(p)) return json_err(404, "no such path");

                json out;
                out["path"]    = liveplay::util::path_to_utf8(p);
                out["parent"]  = p.has_parent_path() && p.parent_path() != p
                                   ? liveplay::util::path_to_utf8(p.parent_path()) : "";
                out["is_root"] = false;
                out["entries"] = json::array();

                // Build the extension allow-list.
                std::set<std::string> allow;
                bool allow_all = false;
                if (filter == "all" || filter == "audio") {
                    allow_all = true;
                } else {
                    // Custom comma-separated list, e.g. ".liveplay,.lpa".
                    std::string token;
                    for (char c : filter) {
                        if (c == ',') {
                            if (!token.empty()) {
                                if (token[0] != '.') token.insert(token.begin(), '.');
                                std::transform(token.begin(), token.end(), token.begin(),
                                    [](unsigned char ch){ return (char)std::tolower(ch); });
                                allow.insert(token);
                                token.clear();
                            }
                        } else {
                            token.push_back(c);
                        }
                    }
                    if (!token.empty()) {
                        if (token[0] != '.') token.insert(token.begin(), '.');
                        std::transform(token.begin(), token.end(), token.begin(),
                            [](unsigned char ch){ return (char)std::tolower(ch); });
                        allow.insert(token);
                    }
                }

                auto ext_passes = [&](const fs::path& pp) -> bool {
                    if (allow_all) return true;
                    auto e = pp.extension().string();
                    std::transform(e.begin(), e.end(), e.begin(),
                                   [](unsigned char c){ return (char)std::tolower(c); });
                    return allow.count(e) > 0;
                };

                if (fs::is_directory(p)) {
                    for (auto& entry : fs::directory_iterator(p, fs::directory_options::skip_permission_denied)) {
                        const auto& ep = entry.path();
                        // Hide hidden entries on POSIX (leading dot). Windows
                        // hidden flag is honoured by fs::directory_iterator
                        // implicitly only for system files.
                        const std::string name = liveplay::util::path_to_utf8(ep.filename());
                        if (!name.empty() && name[0] == '.') continue;

                        json e;
                        e["name"]      = name;
                        e["full_path"] = liveplay::util::path_to_utf8(ep);
                        std::error_code dir_ec;
                        if (entry.is_directory(dir_ec)) {
                            e["kind"] = "dir";
                            out["entries"].push_back(std::move(e));
                        } else if (entry.is_regular_file(dir_ec) && ext_passes(ep)) {
                            e["kind"] = "file";
                            std::error_code size_ec;
                            e["size"] = static_cast<long long>(fs::file_size(ep, size_ec));
                            out["entries"].push_back(std::move(e));
                        }
                    }
                }
                return json_ok(out);
            } catch (const std::exception& e) { return json_err(400, e.what()); }
        });

    // POST /api/fs/mkdir  body: { "path": "<utf8-absolute-path>" }
    // Creates a new directory (and all parent directories). Returns { "path": "<created>" }.
    CROW_ROUTE(app, "/api/fs/mkdir").methods(crow::HTTPMethod::Post)
        ([](const crow::request& req){
            try {
                auto j = json::parse(req.body);
                if (!j.contains("path") || !j["path"].is_string())
                    return json_err(400, "missing 'path'");
                const fs::path dir = liveplay::util::utf8_to_path(j["path"].get<std::string>());
                if (dir.empty()) return json_err(400, "empty path");
                std::error_code ec;
                fs::create_directories(dir, ec);
                if (ec) return json_err(400, ec.message());
                return json_ok(json({{"path", liveplay::util::path_to_utf8(dir)}}));
            } catch (const std::exception& e) { return json_err(400, e.what()); }
        });

    // ---- Multipart upload ----
    CROW_ROUTE(app, "/api/upload").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                if (req.body.size() > cfg_.max_upload_bytes) {
                    return json_err(413, "payload too large");
                }
                crow::multipart::message_view multipart{req};
                const auto& parts = multipart.parts;
                if (parts.empty()) return json_err(400, "no multipart parts");

                fs::path media = state_.media_root();
                fs::create_directories(media);

                json saved = json::array();
                for (const auto& part : parts) {
                    // Pick filename from Content-Disposition header.
                    std::string filename = "upload.bin";
                    auto it = part.headers.find("Content-Disposition");
                    if (it != part.headers.end()) {
                        const auto& params = it->second.params;
                        auto fn = params.find("filename");
                        if (fn != params.end() && !fn->second.empty()) {
                            filename = fn->second;
                        }
                    }
                    const fs::path safe_name = liveplay::util::utf8_to_path(
                        security::sanitize_upload_filename(filename));
                    std::lock_guard import_lock{g_media_import_mutex};
                    const fs::path dest = unused_media_path(media, safe_name);
                    ScopedFileRemoval incomplete{dest};
                    std::ofstream f{
                        dest, std::ios::binary | std::ios::trunc};
                    if (!f) return json_err(500, "failed to write file");
                    f.write(part.body.data(), static_cast<std::streamsize>(part.body.size()));
                    f.close();
                    if (!f) return json_err(500, "failed to write file");
                    incomplete.path.clear();
                    saved.push_back(liveplay::util::path_to_utf8(dest));
                }
                return json_ok(json({{"saved", saved}}));
            } catch (const std::exception& e) { return json_err(400, e.what()); }
        });

    CROW_ROUTE(app, "/api/upload/start").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req) {
            try {
                purge_chunked_uploads();
                const auto body = json::parse(req.body);
                if (!body.contains("filename") || !body["filename"].is_string())
                    return json_err(400, "missing filename");
                const auto size_value = body.find("size");
                if (size_value == body.end() || !size_value->is_number_unsigned())
                    return json_err(400, "missing size");
                const std::string purpose =
                    body.value("purpose", std::string{"media"});
                if (!security::valid_chunked_upload_purpose(purpose))
                    return json_err(400, "invalid purpose");
                const fs::path filename = liveplay::util::utf8_to_path(
                    security::sanitize_upload_filename(
                        body["filename"].get<std::string>()));

                const std::uint64_t expected_bytes =
                    size_value->get<std::uint64_t>();
                ChunkedUploadSession::Purpose session_purpose =
                    ChunkedUploadSession::Purpose::Media;
                fs::path staging_root;
                fs::path extract_path;
                if (purpose == "project_import") {
                    if (!core::project_file::archive_kind(filename))
                        return json_err(400, "project import filename must use .dwcuepack or .lpa");
                    const auto extract_value = body.find("extract_path");
                    if (extract_value == body.end() ||
                        !extract_value->is_string()) {
                        return json_err(400, "missing extract_path");
                    }
                    extract_path = liveplay::util::utf8_to_path(
                        extract_value->get<std::string>());
                    if (extract_path.empty())
                        return json_err(400, "extract_path must not be empty");
                    staging_root = fs::temp_directory_path() / "liveplay-imports";
                    session_purpose = ChunkedUploadSession::Purpose::ProjectImport;
                    if (expected_bytes > security::kMaxArchiveCompressedBytes)
                        return json_err(
                            413, "archive exceeds compressed-size limit");
                } else {
                    staging_root = state_.media_root();
                    if (staging_root.empty())
                        return json_err(500, "media root not configured");
                }
                std::error_code ec;
                fs::create_directories(staging_root, ec);
                if (ec) return json_err(500, "failed to create upload staging");
                purge_orphan_chunked_upload_files(staging_root);
                if (!chunked_upload_has_space(staging_root, expected_bytes))
                    return json_err(507, "insufficient space for upload");

                const std::string upload_id = make_chunked_upload_id();
                const fs::path temp_path =
                    staging_root / liveplay::util::utf8_to_path(
                        ".dwcue-upload-" + upload_id + ".part");
                ScopedFileRemoval incomplete{temp_path};
                std::ofstream temp{
                    temp_path, std::ios::binary | std::ios::trunc};
                if (!temp) return json_err(500, "failed to stage upload");
                temp.close();
                if (!temp) return json_err(500, "failed to stage upload");
                incomplete.path.clear();

                {
                    std::lock_guard lock{g_chunked_uploads_mutex};
                    g_chunked_uploads[upload_id] = ChunkedUploadSession{
                        .temp_path = temp_path,
                        .staging_root = std::move(staging_root),
                        .filename = filename,
                        .extract_path = std::move(extract_path),
                        .expected_bytes = expected_bytes,
                        .received_bytes = 0,
                        .expires_at =
                            std::chrono::steady_clock::now() + std::chrono::hours(1),
                        .purpose = session_purpose,
                    };
                }

                return json_ok(json{
                    {"upload_id", upload_id},
                    {"chunk_size", security::kChunkedUploadChunkBytes},
                });
            } catch (const std::exception& e) {
                return json_err(400, e.what());
            }
        });

    CROW_ROUTE(app, "/api/upload/<string>").methods(crow::HTTPMethod::Put)
        ([](const crow::request& req, const std::string& upload_id) {
            try {
                if (!valid_download_token(upload_id))
                    return json_err(404, "upload not found");
                if (req.body.size() > security::kChunkedUploadChunkBytes)
                    return json_err(413, "chunk too large");
                const auto offset = chunked_upload_offset(req);
                if (!offset) return json_err(400, "missing or invalid offset");

                std::lock_guard lock{g_chunked_uploads_mutex};
                auto it = g_chunked_uploads.find(upload_id);
                if (it == g_chunked_uploads.end())
                    return json_err(404, "upload not found");
                auto& session = it->second;
                if (session.expires_at <= std::chrono::steady_clock::now()) {
                    const fs::path expired_path = std::move(session.temp_path);
                    g_chunked_uploads.erase(it);
                    std::error_code ec;
                    fs::remove(expired_path, ec);
                    return json_err(404, "upload expired");
                }
                if (*offset != session.received_bytes) {
                    auto response = crow::response{
                        409,
                        json({{"error", "offset mismatch"},
                              {"expected_offset", session.received_bytes}})
                            .dump()};
                    response.set_header("Content-Type", "application/json");
                    return response;
                }
                if (session.finalizing)
                    return json_err(409, "upload is being finalized");
                const auto chunk_bytes =
                    static_cast<std::uint64_t>(req.body.size());
                if (chunk_bytes >
                    session.expected_bytes - session.received_bytes) {
                    return json_err(409, "chunk exceeds declared upload size");
                }
                if (!chunked_upload_has_space(
                        session.staging_root,
                        session.expected_bytes - session.received_bytes)) {
                    return json_err(507, "insufficient space for upload");
                }

                std::ofstream temp{
                    session.temp_path, std::ios::binary | std::ios::app};
                if (!temp) return json_err(500, "failed to open staged upload");
                temp.write(req.body.data(),
                           static_cast<std::streamsize>(req.body.size()));
                temp.close();
                if (!temp) return json_err(500, "failed to write upload chunk");

                session.received_bytes += chunk_bytes;
                session.expires_at =
                    std::chrono::steady_clock::now() + std::chrono::hours(1);
                return json_ok(json{
                    {"received", session.received_bytes},
                    {"complete", session.received_bytes == session.expected_bytes},
                });
            } catch (const std::exception& e) {
                return json_err(400, e.what());
            }
        });

    CROW_ROUTE(app, "/api/upload/<string>/finish").methods(crow::HTTPMethod::Post)
        ([this](const crow::request&, const std::string& upload_id) {
            try {
                purge_chunked_uploads();
                if (!valid_download_token(upload_id))
                    return json_err(404, "upload not found");

                fs::path temp_path;
                fs::path staging_root;
                fs::path filename;
                fs::path extract_path;
                ChunkedUploadSession::Purpose purpose{
                    ChunkedUploadSession::Purpose::Media};
                {
                    std::lock_guard lock{g_chunked_uploads_mutex};
                    auto it = g_chunked_uploads.find(upload_id);
                    if (it == g_chunked_uploads.end())
                        return json_err(404, "upload not found");
                    if (it->second.expires_at <= std::chrono::steady_clock::now()) {
                        const fs::path expired_path = std::move(it->second.temp_path);
                        g_chunked_uploads.erase(it);
                        std::error_code ec;
                        fs::remove(expired_path, ec);
                        return json_err(404, "upload expired");
                    }
                    if (it->second.received_bytes != it->second.expected_bytes)
                        return json_err(409, "upload is incomplete");
                    if (it->second.finalizing)
                        return json_err(409, "upload is being finalized");
                    it->second.finalizing = true;
                    it->second.expires_at =
                        std::chrono::steady_clock::now() + std::chrono::hours(1);
                    temp_path = it->second.temp_path;
                    staging_root = it->second.staging_root;
                    filename = it->second.filename;
                    extract_path = it->second.extract_path;
                    purpose = it->second.purpose;
                }

                const auto reset_finalizing = [&] {
                    std::lock_guard lock{g_chunked_uploads_mutex};
                    if (auto it = g_chunked_uploads.find(upload_id);
                        it != g_chunked_uploads.end()) {
                        it->second.finalizing = false;
                    }
                };
                try {
                    if (purpose == ChunkedUploadSession::Purpose::ProjectImport) {
                        project_archive::ImportResult imported;
                        {
                            std::lock_guard import_lock{g_media_import_mutex};
                            imported = project_archive::import_project(
                                temp_path, filename, extract_path);
                        }
                        if (!imported.ok) {
                            reset_finalizing();
                            return json_err(imported.status, imported.error);
                        }
                        {
                            std::lock_guard lock{g_chunked_uploads_mutex};
                            g_chunked_uploads.erase(upload_id);
                        }
                        std::error_code cleanup_ec;
                        fs::remove(temp_path, cleanup_ec);
                        return json_ok(json{
                            {"extractPath", liveplay::util::path_to_utf8(extract_path)},
                            {"projectFiles", json::array({
                                liveplay::util::path_to_utf8(
                                    imported.project_file.filename())})},
                        });
                    }

                    fs::path dest;
                    std::error_code ec;
                    std::lock_guard import_lock{g_media_import_mutex};
                    dest = unused_media_path(staging_root, filename);
                    fs::rename(temp_path, dest, ec);
                    if (ec) {
                        reset_finalizing();
                        return json_err(500, "failed to finalize upload");
                    }
                    {
                        std::lock_guard lock{g_chunked_uploads_mutex};
                        g_chunked_uploads.erase(upload_id);
                    }
                    return json_ok(json{{
                        "saved", json::array({liveplay::util::path_to_utf8(dest)})}});
                } catch (...) {
                    reset_finalizing();
                    throw;
                }
            } catch (const std::exception& e) {
                return json_err(400, e.what());
            }
        });

    CROW_ROUTE(app, "/api/upload/<string>").methods(crow::HTTPMethod::Delete)
        ([](const crow::request&, const std::string& upload_id) {
            try {
                purge_chunked_uploads();
                if (!valid_download_token(upload_id))
                    return json_err(404, "upload not found");
                fs::path temp_path;
                {
                    std::lock_guard lock{g_chunked_uploads_mutex};
                    auto it = g_chunked_uploads.find(upload_id);
                    if (it == g_chunked_uploads.end())
                        return json_err(404, "upload not found");
                    if (it->second.finalizing)
                        return json_err(409, "upload is being finalized");
                    temp_path = std::move(it->second.temp_path);
                    g_chunked_uploads.erase(it);
                }
                std::error_code ec;
                fs::remove(temp_path, ec);
                return json_ok(json{{"ok", true}});
            } catch (const std::exception& e) {
                return json_err(400, e.what());
            }
        });

    // Copy an existing server-side file into the project's media root.
    // Used by the client when the user picks a file from the server file
    // browser — the file lives somewhere on disk but needs to land in the
    // project media folder before the engine can own it.
    // Body: { "source_path": "/absolute/path/to/file.ext" }
    // Response: { "dest_path": "/absolute/path/to/media/file.ext" }
    CROW_ROUTE(app, "/api/copy_to_media").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req) {
            try {
                const auto body = json::parse(req.body);
                const std::string src_str = body.value("source_path", std::string{});
                const std::string duplicate_policy =
                    body.value("duplicate_policy", std::string{"keep"});
                if (src_str.empty()) return json_err(400, "missing source_path");
                if (duplicate_policy != "reuse" && duplicate_policy != "skip" &&
                    duplicate_policy != "keep") {
                    return json_err(400, "invalid duplicate_policy");
                }

                const fs::path src  = liveplay::util::utf8_to_path(src_str);
                if (!fs::exists(src)) return json_err(404, "source file not found");

                const fs::path media = state_.media_root();
                if (media.empty()) return json_err(500, "media root not configured");

                fs::create_directories(media);
                std::lock_guard import_lock{g_media_import_mutex};
                fs::path dest = media / src.filename();

                std::error_code ec;
                if (fs::exists(dest, ec) && !ec &&
                    fs::equivalent(src, dest, ec) && !ec) {
                    return json_ok(json{{
                        "dest_path", liveplay::util::path_to_utf8(dest)},
                        {"duplicate", true},
                        {"reused", duplicate_policy != "skip"},
                        {"skipped", duplicate_policy == "skip"}});
                }
                if (duplicate_policy != "keep") {
                    const fs::path existing = matching_media_file(media, src);
                    if (!existing.empty()) {
                        return json_ok(json{
                            {"dest_path", liveplay::util::path_to_utf8(existing)},
                            {"duplicate", true},
                            {"reused", duplicate_policy == "reuse"},
                            {"skipped", duplicate_policy == "skip"},
                        });
                    }
                }
                dest = unused_media_path(media, src.filename());
                fs::copy_file(src, dest, fs::copy_options::none);

                return json_ok(json{
                    {"dest_path", liveplay::util::path_to_utf8(dest)},
                    {"duplicate", false},
                    {"reused", false},
                    {"skipped", false},
                });
            } catch (const std::exception& e) { return json_err(500, e.what()); }
        });

    // Queue an async waveform computation for the given file. Returns
    // immediately; the result arrives as a waveform_ready doc_patch over
    // WebSocket once the worker thread finishes.
    // Body: { "path": "/abs/path/to/file.ext", "item_uuid": "<uuid>" }
    CROW_ROUTE(app, "/api/waveform_generate").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req) {
            try {
                const auto body = json::parse(req.body);
                const std::string path_str  = body.value("path", std::string{});
                const std::string item_uuid = body.value("item_uuid", std::string{});
                const bool        force     = body.value("force", false);
                if (path_str.empty() || item_uuid.empty())
                    return json_err(400, "missing path or item_uuid");

                const auto proj_path = state_.project_file_path();
                const auto wdir = proj_path.empty()
                    ? fs::path{}
                    : proj_path.parent_path() / "waveforms";
                const auto waveform_path =
                    liveplay::util::utf8_to_path(path_str);

                {
                    std::lock_guard lock{impl_->waveform_q_mutex};
                    if (impl_->waveform_stop)
                        return json_err(503, "server is stopping");
                    const auto queued = std::find_if(
                        impl_->waveform_q.begin(), impl_->waveform_q.end(),
                        [&](const Impl::WaveformTask& task) {
                            return task.item_uuid == item_uuid &&
                                   task.path == waveform_path;
                        });
                    if (queued != impl_->waveform_q.end()) {
                        queued->force = queued->force || force;
                    } else {
                        impl_->waveform_q.push_back({
                            waveform_path, item_uuid, wdir, force
                        });
                    }
                }
                impl_->waveform_q_cv.notify_one();
                return json_ok(json{{"ok", true}});
            } catch (const std::exception& e) { return json_err(500, e.what()); }
        });

    // ---- Metadata + Waveform ----
    CROW_ROUTE(app, "/api/metadata").methods(crow::HTTPMethod::Get)
        ([](const crow::request& req) {
            const char* path = req.url_params.get("path");
            if (!path) return json_err(400, "missing ?path=");
            const auto md = liveplay::meta::read_metadata(liveplay::util::utf8_to_path(path));
            return json_ok(json{
                {"valid",        md.valid},
                {"artist",       md.artist},
                {"title",        md.title},
                {"album",        md.album},
                {"genre",        md.genre},
                {"year",         md.year},
                {"track_number", md.track_number},
                {"duration_ms",  md.duration.count()},
                {"sample_rate",  md.sample_rate},
                {"channels",     md.channels},
                {"bitrate_kbps", md.bitrate_kbps},
                {"has_video",    md.has_video},
            });
        });

    CROW_ROUTE(app, "/api/waveform/<string>").methods(crow::HTTPMethod::Get)
        ([this](const crow::request& req, std::string cue_id) {
            try {
                const auto meta = state_.find_cue(audio::CueId{cue_id});
                if (!meta) return json_err(404, "no such cue");

                std::uint32_t buckets = 1000;
                if (req.url_params.get("buckets")) {
                    try { buckets = static_cast<std::uint32_t>(std::stoi(req.url_params.get("buckets"))); }
                    catch (...) {}
                }

                const auto analysis_start =
                    query_milliseconds(req, "analysis_start_ms");
                const auto analysis_end =
                    query_milliseconds(req, "analysis_end_ms");
                const auto wf = liveplay::meta::compute_waveform(
                    meta->file_path, buckets, analysis_start, analysis_end);
                if (!wf.ok) return json_err(500, "waveform decode failed");

                auto data = waveform_data_json(wf);
                data["cue_id"] = cue_id;
                return json_ok(data);
            } catch (const std::invalid_argument& e) {
                return json_err(400, e.what());
            } catch (const std::exception& e) { return json_err(500, e.what()); }
            catch (...) { return json_err(500, "unknown error computing waveform"); }
        });

    // Compute waveform for an arbitrary file path (no cue registration needed).
    // Used by the client immediately after import, before the cue is registered
    // with the engine. Query params: path=<absolute-path>&buckets=<count>.
    CROW_ROUTE(app, "/api/waveform_path").methods(crow::HTTPMethod::Get)
        ([](const crow::request& req) {
            try {
                const auto* path_param = req.url_params.get("path");
                if (!path_param) return json_err(400, "missing path parameter");

                std::uint32_t buckets = 1000;
                if (req.url_params.get("buckets")) {
                    try { buckets = static_cast<std::uint32_t>(std::stoi(req.url_params.get("buckets"))); }
                    catch (...) {}
                }

                const std::filesystem::path file_path =
                    liveplay::util::utf8_to_path(std::string{path_param});

                const auto analysis_start =
                    query_milliseconds(req, "analysis_start_ms");
                const auto analysis_end =
                    query_milliseconds(req, "analysis_end_ms");
                const auto wf = liveplay::meta::compute_waveform(
                    file_path, buckets, analysis_start, analysis_end);
                if (!wf.ok) return json_err(500, "waveform decode failed");

                return json_ok(waveform_data_json(wf));
            } catch (const std::invalid_argument& e) {
                return json_err(400, e.what());
            } catch (const std::exception& e) { return json_err(500, e.what()); }
            catch (...) { return json_err(500, "unknown error computing waveform"); }
        });

    // ---- Media streaming (Video Output window) ----
    // Serves a local media file with HTTP Range support: Chromium's media
    // stack probes MP4s with byte-range GETs and cannot seek without 206
    // responses, so Crow's set_static_file_info (no ranges) is not enough.
    // Same trust model as /api/waveform_path — the server is a same-machine
    // tool and the caller may read any local path.
    CROW_ROUTE(app, "/api/media").methods(crow::HTTPMethod::Get, crow::HTTPMethod::Head)
        ([this](const crow::request& req) {
            static const std::unordered_map<std::string, std::string> kMime = {
                {".mp4",  "video/mp4"},        {".m4v",  "video/mp4"},
                {".mov",  "video/quicktime"},  {".mkv",  "video/x-matroska"},
                {".webm", "video/webm"},       {".mp3",  "audio/mpeg"},
                {".wav",  "audio/wav"},        {".flac", "audio/flac"},
                {".png",  "image/png"},        {".jpg",  "image/jpeg"},
                {".jpeg", "image/jpeg"},       {".gif",  "image/gif"},
                {".webp", "image/webp"},       {".svg",  "image/svg+xml"},
            };
            try {
                const char* item_uuid = req.url_params.get("item_uuid");
                const char* path_param = req.url_params.get("path");
                fs::path file_path;
                if (item_uuid && *item_uuid) {
                    const auto resolved = state_.resolve_item_path(item_uuid);
                    if (!resolved) return json_err(404, "media item not found");
                    file_path = *resolved;
                } else if (path_param && *path_param) {
                    file_path = liveplay::util::utf8_to_path(std::string{path_param});
                } else {
                    return json_err(400, "missing ?item_uuid= or ?path=");
                }

                std::error_code ec;
                const std::uint64_t size =
                    static_cast<std::uint64_t>(fs::file_size(file_path, ec));
                if (ec || fs::is_directory(file_path, ec)) return json_err(404, "not found");

                std::string ext = file_path.extension().string();
                std::transform(ext.begin(), ext.end(), ext.begin(),
                               [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
                const auto mime_it = kMime.find(ext);
                const std::string mime =
                    mime_it != kMime.end() ? mime_it->second : "application/octet-stream";

                // Range: bytes=start-end | bytes=start- | bytes=-suffix
                std::uint64_t begin = 0;
                std::uint64_t end = size > 0 ? size - 1 : 0;
                bool partial = false;
                const std::string range = req.get_header_value("Range");
                if (range.rfind("bytes=", 0) == 0 && size > 0) {
                    const std::string spec = range.substr(6);
                    const auto dash = spec.find('-');
                    if (dash == std::string::npos) return crow::response(416);
                    const std::string first = spec.substr(0, dash);
                    const std::string last = spec.substr(dash + 1);
                    try {
                        if (first.empty()) {
                            const auto suffix = std::stoull(last);
                            if (suffix == 0) return crow::response(416);
                            begin = suffix >= size ? 0 : size - suffix;
                        } else {
                            begin = std::stoull(first);
                            if (!last.empty())
                                end = std::min<std::uint64_t>(std::stoull(last), size - 1);
                        }
                    } catch (...) { return crow::response(416); }
                    if (begin >= size || begin > end) {
                        crow::response unsatisfiable(416);
                        unsatisfiable.add_header("Content-Range",
                                                 "bytes */" + std::to_string(size));
                        return unsatisfiable;
                    }
                    partial = begin != 0 || end != size - 1;
                }

                crow::response r;
                r.code = partial ? 206 : 200;
                r.add_header("Content-Type", mime);
                r.add_header("Accept-Ranges", "bytes");
                r.add_header("Cache-Control", "no-store");
                if (partial) {
                    r.add_header("Content-Range",
                                 "bytes " + std::to_string(begin) + "-" +
                                     std::to_string(end) + "/" + std::to_string(size));
                }

                // Content-Length is derived from r.body by Crow — never set
                // it manually (a duplicate header would corrupt framing).
                const std::uint64_t length = size == 0 ? 0 : end - begin + 1;
                if (req.method == crow::HTTPMethod::Head || length == 0) return r;

                std::ifstream in(file_path, std::ios::binary);
                if (!in) return json_err(404, "not found");
                in.seekg(static_cast<std::streamoff>(begin), std::ios::beg);
                std::string body(static_cast<std::size_t>(length), '\0');
                in.read(body.data(), static_cast<std::streamsize>(length));
                body.resize(static_cast<std::size_t>(
                    std::max<std::streamsize>(0, in.gcount())));
                r.body = std::move(body);
                return r;
            } catch (const std::exception& e) { return json_err(500, e.what()); }
        });

    // ---- Project I/O ----
    // Returns the *full* client-shaped project document (items, groups, cart,
    // theme, settings) plus a server-side decoration of engine cue ids. This
    // is the single GET a remote client needs to render the whole project.
    CROW_ROUTE(app, "/api/project").methods(crow::HTTPMethod::Get)
        ([this] { return json_ok(state_.full_document()); });

    // Lightweight header — theme, settings, cart, project name, item count.
    // Clients hit this first so they can paint the workspace shell before
    // the (potentially large) items array has even started downloading.
    // Pair with /api/project/items?offset=&limit= to stream the playlist.
    CROW_ROUTE(app, "/api/project/header").methods(crow::HTTPMethod::Get)
        ([this](const crow::request& req) {
            Logger::api_request("Client ({}) -> Server ({}) : GET /api/project/header",
                                req.remote_ip_address, impl_->server_addr);
            auto hdr = state_.header_document();
            Logger::api_response("Client ({}) <- Server ({}) : GET /api/project/header OK — '{}' ({} items)",
                                 req.remote_ip_address, impl_->server_addr,
                                 hdr.value("name", "?"),
                                 hdr.value("itemCount", (std::size_t)0));
            return json_ok(hdr);
        });

    // Paged top-level items. `offset` defaults to 0, `limit` to 100
    // (sane upper bound: even on slow LANs a 100-item page comes back
    // in well under a frame). Returns { offset, limit, total, items: [...] }.
    CROW_ROUTE(app, "/api/project/items").methods(crow::HTTPMethod::Get)
        ([this](const crow::request& req){
            std::size_t offset = 0, limit = 100;
            if (const char* p = req.url_params.get("offset")) {
                try { offset = static_cast<std::size_t>(std::max(0, std::stoi(p))); }
                catch (...) {}
            }
            if (const char* p = req.url_params.get("limit")) {
                try { limit = static_cast<std::size_t>(std::clamp(std::stoi(p), 1, 1000)); }
                catch (...) {}
            }
            Logger::api_request("Client ({}) -> Server ({}) : GET /api/project/items offset={} limit={}",
                                req.remote_ip_address, impl_->server_addr, offset, limit);
            auto page = state_.items_page(offset, limit);
            Logger::api_response("Client ({}) <- Server ({}) : GET /api/project/items offset={} → {}/{} items",
                                 req.remote_ip_address, impl_->server_addr, offset,
                                 page.value("items", json::array()).size(),
                                 page.value("total", (std::size_t)0));
            return json_ok(page);
        });

    // Cheap progress poll endpoint — the client hits this during project
    // open so it can show "loaded X / Y audio cues" without re-fetching the
    // whole document on a timer.
    CROW_ROUTE(app, "/api/project/progress").methods(crow::HTTPMethod::Get)
        ([this] { return json_ok(state_.audio_readiness()); });

    CROW_ROUTE(app, "/api/project/load").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                auto j = json::parse(req.body);
                if (j.contains("path")) {
                    const std::string path_str = j["path"].get<std::string>();
                    Logger::api_request("Client ({}) -> Server ({}) : POST /api/project/load path='{}'",
                                        req.remote_ip_address, impl_->server_addr, path_str);
                    const fs::path p = liveplay::util::utf8_to_path(path_str);
                    if (core::project_file::is_legacy_project(p)) {
                        return json_err(400,
                            "legacy .liveplay projects must be imported via /api/project/import-legacy");
                    }
                    if (!core::project_file::is_native_project(p))
                        return json_err(400, "project path must use .dwcue");
                    if (!state_.load(p)) {
                        Logger::error("POST /api/project/load FAILED — load returned false for '{}'", path_str);
                        return json_err(400, "load failed");
                    }
                } else if (j.contains("document")) {
                    Logger::api_request("Client ({}) -> Server ({}) : POST /api/project/load (from document)",
                                        req.remote_ip_address, impl_->server_addr);
                    if (!state_.load_from_json(j["document"])) {
                        Logger::error("POST /api/project/load FAILED — document rejected");
                        return json_err(400, "load failed");
                    }
                } else {
                    Logger::warn("POST /api/project/load — missing 'path' or 'document' in body");
                    return json_err(400, "expected 'path' or 'document'");
                }
                auto repair = state_.consume_repair_info();
                auto header = state_.header_document();
                const std::size_t item_count = header.value("itemCount", (std::size_t)0);
                Logger::api_response("Client ({}) <- Server ({}) : POST /api/project/load OK — '{}' ({} items){}",
                                     req.remote_ip_address, impl_->server_addr,
                                     header.value("name", "?"), item_count,
                                     repair.repaired ? " [repaired]" : "");
                // Attach repair metadata so the client can prompt the user.
                header["needsRepair"] = repair.repaired;
                if (repair.repaired) {
                    auto issues = json::array();
                    for (const auto& iss : repair.issues) issues.push_back(iss);
                    header["repairIssues"] = std::move(issues);
                }
                broadcast_doc_patch(json{
                    {"type", "doc_patch"}, {"op", "project_changed"},
                });
                return json_ok(header);
            } catch (const std::exception& e) {
                Logger::error("POST /api/project/load threw: {}", e.what());
                return json_err(400, e.what());
            }
        });

    CROW_ROUTE(app, "/api/project/import-legacy").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req) {
            try {
                const auto body = json::parse(req.body);
                const auto source_value = body.find("path");
                if (source_value == body.end() || !source_value->is_string())
                    return json_err(400, "expected 'path'");
                const fs::path source = liveplay::util::utf8_to_path(
                    source_value->get<std::string>());

                core::project_file::PreparedDocument prepared;
                std::string preparation_error;
                if (!core::project_file::read_legacy_project(
                        source, prepared, preparation_error)) {
                    return json_err(400, preparation_error);
                }

                const auto destination_value = body.find("destinationPath");
                const bool explicit_destination =
                    destination_value != body.end();
                fs::path destination;
                if (explicit_destination) {
                    if (!destination_value->is_string() ||
                        destination_value->get<std::string>().empty()) {
                        return json_err(400, "destinationPath must be a non-empty string");
                    }
                    destination = liveplay::util::utf8_to_path(
                        destination_value->get<std::string>());
                    std::string destination_error;
                    if (!core::project_file::valid_legacy_destination(
                            source, destination, destination_error)) {
                        const int status = destination_error ==
                                "destinationPath already exists"
                            ? 409 : 400;
                        return json_err(status, destination_error);
                    }
                }

                std::error_code write_error;
                {
                    std::lock_guard import_lock{g_media_import_mutex};
                    if (explicit_destination) {
                        if (!core::project_file::write_new_canonical_project(
                                destination, prepared.document, write_error)) {
                            return json_err(
                                write_error == std::errc::file_exists ? 409 : 500,
                                write_error == std::errc::file_exists
                                    ? "destinationPath already exists"
                                    : "failed to create canonical project");
                        }
                    } else {
                        bool created = false;
                        for (unsigned attempt = 0; attempt < 100; ++attempt) {
                            std::string destination_error;
                            const auto candidate =
                                core::project_file::unique_legacy_destination(
                                    source, destination_error);
                            if (!candidate)
                                return json_err(500, destination_error);
                            destination = *candidate;
                            if (core::project_file::write_new_canonical_project(
                                    destination, prepared.document, write_error)) {
                                created = true;
                                break;
                            }
                            if (write_error != std::errc::file_exists)
                                return json_err(500, "failed to create canonical project");
                        }
                        if (!created)
                            return json_err(409, "could not reserve a unique .dwcue sibling");
                    }

                    if (!state_.load(destination)) {
                        return json_err(400,
                            "legacy project was converted to '" +
                            liveplay::util::path_to_utf8(destination) +
                            "' but could not be opened");
                    }
                }

                auto load_repair = state_.consume_repair_info();
                core::RepairInfo repair{
                    prepared.repair.repaired || load_repair.repaired,
                    prepared.repair.issues,
                };
                repair.issues.insert(repair.issues.end(),
                                     load_repair.issues.begin(),
                                     load_repair.issues.end());
                auto header = state_.header_document();
                header["needsRepair"] = repair.repaired;
                if (repair.repaired)
                    header["repairIssues"] = repair.issues;
                broadcast_doc_patch(json{
                    {"type", "doc_patch"}, {"op", "project_changed"},
                });
                Logger::api_response(
                    "Client ({}) <- Server ({}) : POST /api/project/import-legacy OK — '{}'",
                    req.remote_ip_address, impl_->server_addr,
                    liveplay::util::path_to_utf8(destination));
                return json_ok(header);
            } catch (const std::exception& exception) {
                Logger::error("POST /api/project/import-legacy threw: {}",
                              exception.what());
                return json_err(400, exception.what());
            }
        });

    // Close the currently-loaded project on the server. After this the
    // server has no open project — the next /api/project/header will report
    // hasOpenProject=false and clients land back on the welcome screen. We
    // broadcast a project_changed doc_patch so any other connected clients
    // also drop their local mirror.
    CROW_ROUTE(app, "/api/project/close").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                Logger::api_request("Client ({}) -> Server ({}) : POST /api/project/close",
                                    req.remote_ip_address, impl_->server_addr);
                state_.reset();
                broadcast_doc_patch(json{
                    {"type", "doc_patch"}, {"op", "project_changed"},
                });
                Logger::api_response("Client ({}) <- Server ({}) : POST /api/project/close OK",
                                     req.remote_ip_address, impl_->server_addr);
                return json_ok(json{{"closed", true}});
            } catch (const std::exception& e) {
                Logger::error("POST /api/project/close threw: {}", e.what());
                return json_err(400, e.what());
            }
        });

    // ---- Project export / import (.dwcuepack and legacy .lpa archives) ----
    // Package the active canonical show and its project folder into a raw ZIP
    // with the .dwcuepack extension.
    // Request body:
    //   {
    //     "folderPath": "/abs/path/to/project/folder",   // required
    //     "outputPath": "/abs/path/to/save/here.dwcuepack", // optional
    //                                                    // present, the file
    //                                                    // is written to this
    //                                                    // server location.
    //     "projectName": "MyShow"                        // optional, used to
    //                                                    // build a default
    //                                                    // filename when
    //                                                    // outputPath is
    //                                                    // omitted.
    //   }
    // If `outputPath` is omitted the archive is written to a temp directory
    // on the server and a one-shot download token is returned so the client
    // can fetch it back via GET /api/file/download?token=…
    // Response: { "archivePath": "...", "downloadToken": "..." (optional),
    //             "size": <bytes> }
    CROW_ROUTE(app, "/api/project/export").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                Logger::api_request("Client ({}) -> Server ({}) : POST /api/project/export",
                                    req.remote_ip_address, impl_->server_addr);
                auto j = json::parse(req.body);
                if (!j.contains("folderPath") || !j["folderPath"].is_string()) {
                    return json_err(400, "expected 'folderPath'");
                }
                const fs::path src = liveplay::util::utf8_to_path(
                    j["folderPath"].get<std::string>());
                if (!fs::exists(src) || !fs::is_directory(src)) {
                    return json_err(400, "folderPath does not exist or is not a directory");
                }
                const fs::path active_project = state_.project_file_path();
                if (active_project.empty() ||
                    !core::project_file::is_native_project(active_project)) {
                    return json_err(400, "no canonical .dwcue project is open");
                }
                const std::string default_name = safe_download_filename(
                    j.value("projectName",
                            liveplay::util::path_to_utf8(src.filename())));

                fs::path out;
                bool to_temp = false;
                std::string download_token;
                if (j.contains("outputPath") && j["outputPath"].is_string() &&
                    !j["outputPath"].get<std::string>().empty()) {
                    out = liveplay::util::utf8_to_path(j["outputPath"].get<std::string>());
                } else {
                    // Stage in a temp directory; surface via download token.
                    fs::path tmp = export_temp_root();
                    fs::create_directories(tmp);
                    download_token = make_download_token();
                    out = tmp / (download_token + ".dwcuepack");
                    to_temp = true;
                }
                if (!out.is_absolute())
                    return json_err(400, "outputPath must be absolute");
                if (!core::project_file::is_native_archive(out))
                    return json_err(400, "outputPath must use .dwcuepack");
                std::error_code output_ec;
                fs::create_directories(out.parent_path(), output_ec);
                if (output_ec)
                    return json_err(500, "failed to create export directory");
                const fs::path staged_out =
                    out.parent_path() /
                    liveplay::util::utf8_to_path(
                        ".dwcue-export-" + make_download_token() + ".part");
                ScopedFileRemoval incomplete_export{staged_out};

                {
                    std::lock_guard media_snapshot_lock{g_media_import_mutex};
                    const auto packaged = project_archive::export_project(
                        src, active_project, staged_out, out);
                    if (!packaged.ok)
                        return json_err(packaged.status, packaged.error);
                }
                if (!liveplay::util::replace_file_atomically(
                        staged_out, out, output_ec)) {
                    return json_err(500, "failed to finalize archive");
                }
                incomplete_export.path.clear();
                std::uintmax_t size = 0;
                try { size = fs::file_size(out); } catch (...) {}

                json resp = {
                    {"archivePath", liveplay::util::path_to_utf8(out)},
                    {"size",        static_cast<std::uint64_t>(size)},
                };
                if (to_temp) {
                    register_download_token(download_token, out);
                    resp["downloadToken"] = download_token;
                    resp["downloadFilename"] = default_name;
                }
                Logger::api_response("Client ({}) <- Server ({}) : POST /api/project/export OK — '{}' ({} bytes)",
                                     req.remote_ip_address, impl_->server_addr,
                                     liveplay::util::path_to_utf8(out), size);
                return json_ok(resp);
            } catch (const std::exception& e) {
                Logger::error("POST /api/project/export threw: {}", e.what());
                return json_err(400, e.what());
            }
        });

    // Stream a server-side file by one-shot token. GET claims it; DELETE
    // acknowledges a fully received transfer and removes the temp file.
    CROW_ROUTE(app, "/api/file/download")
        .methods(crow::HTTPMethod::Get, crow::HTTPMethod::Delete)
        ([](const crow::request& req){
            try {
                const char* token = req.url_params.get("token");
                if (!token) return json_err(400, "missing ?token=");
                if (!valid_download_token(token))
                    return json_err(400, "invalid token");
                if (req.method == crow::HTTPMethod::Delete) {
                    return complete_download_token(token)
                        ? json_ok(json{{"deleted", true}})
                        : json_err(404, "token expired or invalid");
                }
                auto path_opt = claim_download_token(token);
                if (!path_opt) return json_err(404, "token expired or invalid");
                const fs::path& p = *path_opt;
                crow::response r;
                r.set_static_file_info_unsafe(
                    liveplay::util::path_to_utf8(p),
                    "application/octet-stream");
                if (r.code != 200) {
                    complete_download_token(token);
                    return json_err(500, "failed to open archive");
                }
                r.add_header("Content-Disposition", "attachment");
                r.add_header("Cache-Control", "no-store");
                return r;
            } catch (const std::exception& e) {
                Logger::error("GET /api/file/download threw: {}", e.what());
                return json_err(400, e.what());
            }
        });

    // Import a canonical .dwcuepack or legacy .lpa archive uploaded through
    // multipart, chunked upload, or already present on the server filesystem.
    // The existing request/response shape is preserved. Successful responses
    // contain exactly one canonical root filename in projectFiles.
    // Request body:
    //   * multipart/form-data with one part named "file" and an
    //     "extractPath" form field.
    //   * application/json: { "archivePath": "/abs/path.dwcuepack",
    //                         "extractPath": "/abs/dest" }
    //     Same response shape; no upload step.
    //   * chunked upload via /api/upload/start with
    //     { "filename": "...", "size": N, "purpose": "project_import",
    //       "extract_path": "/abs/dest" }, then PUT chunks, then
    //     POST /api/upload/{id}/finish. Same response shape.
    CROW_ROUTE(app, "/api/project/import").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                if (req.body.size() > cfg_.max_upload_bytes)
                    return json_err(413, "payload too large");
                Logger::api_request("Client ({}) -> Server ({}) : POST /api/project/import",
                                    req.remote_ip_address, impl_->server_addr);
                fs::path archive_path;
                fs::path trusted_archive_filename;
                fs::path extract_path;
                ScopedFileRemoval staged_upload;

                const auto ct_it = req.headers.find("Content-Type");
                const std::string ct = ct_it != req.headers.end() ? ct_it->second : "";

                if (ct.find("multipart/") != std::string::npos) {
                    crow::multipart::message_view mp{req};
                    const crow::multipart::part_view* file_part = nullptr;
                    bool file_filename_missing = false;
                    for (const auto& part : mp.parts) {
                        auto cd = part.headers.find("Content-Disposition");
                        if (cd == part.headers.end()) continue;
                        auto name_it = cd->second.params.find("name");
                        if (name_it == cd->second.params.end()) continue;
                        if (name_it->second == "file") {
                            if (file_part)
                                return json_err(400, "duplicate 'file' parts");
                            file_part = &part;
                            const auto filename_it =
                                cd->second.params.find("filename");
                            if (filename_it == cd->second.params.end() ||
                                filename_it->second.empty()) {
                                file_filename_missing = true;
                            } else {
                                trusted_archive_filename =
                                    liveplay::util::utf8_to_path(
                                        security::sanitize_upload_filename(
                                            filename_it->second));
                            }
                        } else if (name_it->second == "extractPath") {
                            extract_path = liveplay::util::utf8_to_path(
                                std::string{part.body});
                        }
                    }
                    if (!file_part) return json_err(400, "missing 'file' part");
                    if (file_filename_missing)
                        return json_err(400,
                            "file part must include a non-empty filename");
                    if (!core::project_file::archive_kind(trusted_archive_filename))
                        return json_err(400, "archive filename must use .dwcuepack or .lpa");
                    if (file_part->body.size() > cfg_.max_upload_bytes)
                        return json_err(413, "uploaded archive too large");
                    if (extract_path.empty())
                        return json_err(400, "missing 'extractPath' form field");
                    fs::path tmp = fs::temp_directory_path() / "liveplay-imports";
                    fs::create_directories(tmp);
                    archive_path = tmp / (make_download_token() + ".part");
                    staged_upload.path = archive_path;
                    std::ofstream of{archive_path, std::ios::binary};
                    if (!of) return json_err(500, "failed to stage uploaded archive");
                    of.write(file_part->body.data(),
                             static_cast<std::streamsize>(file_part->body.size()));
                    of.close();
                    if (!of) return json_err(500, "failed to stage uploaded archive");
                } else {
                    auto j = json::parse(req.body);
                    if (!j.contains("archivePath") || !j["archivePath"].is_string())
                        return json_err(400, "expected 'archivePath'");
                    if (!j.contains("extractPath") || !j["extractPath"].is_string())
                        return json_err(400, "expected 'extractPath'");
                    archive_path = liveplay::util::utf8_to_path(j["archivePath"].get<std::string>());
                    extract_path = liveplay::util::utf8_to_path(j["extractPath"].get<std::string>());
                    trusted_archive_filename = archive_path.filename();
                    if (!core::project_file::archive_kind(trusted_archive_filename))
                        return json_err(400, "archivePath must use .dwcuepack or .lpa");
                }

                if (extract_path.empty())
                    return json_err(400, "extractPath must not be empty");
                if (!fs::exists(archive_path) || !fs::is_regular_file(archive_path))
                    return json_err(400, "archive does not exist");

                project_archive::ImportResult imported;
                {
                    std::lock_guard import_lock{g_media_import_mutex};
                    imported = project_archive::import_project(
                        archive_path, trusted_archive_filename, extract_path);
                }
                if (!imported.ok)
                    return json_err(imported.status, imported.error);

                json resp = {
                    {"extractPath", liveplay::util::path_to_utf8(extract_path)},
                    {"projectFiles", json::array({
                        liveplay::util::path_to_utf8(
                            imported.project_file.filename())})},
                };
                Logger::api_response("Client ({}) <- Server ({}) : POST /api/project/import OK — extracted to '{}'",
                                     req.remote_ip_address, impl_->server_addr,
                                     liveplay::util::path_to_utf8(extract_path));
                return json_ok(resp);
            } catch (const std::exception& e) {
                Logger::error("POST /api/project/import threw: {}", e.what());
                return json_err(400, e.what());
            }
        });

    // Repair the currently-loaded project and save it to disk. Called by the
    // client after the user confirms the repair prompt.
    CROW_ROUTE(app, "/api/project/repair").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                Logger::api_request("Client ({}) -> Server ({}) : POST /api/project/repair",
                                    req.remote_ip_address, impl_->server_addr);
                // The document was already repaired on load (load_from_json
                // ran detect_and_repair before storing it). Calling
                // repair_project() here just re-validates — it is a no-op if
                // the in-memory doc is already clean. We must still save
                // unconditionally, because the file on disk is the
                // unrepaired original and the user just confirmed they want
                // the repair persisted.
                const auto repair = state_.repair_project();
                const auto path = state_.project_file_path();
                bool saved = false;
                if (!path.empty()) {
                    if (!state_.save(path)) {
                        Logger::error("POST /api/project/repair — save failed for '{}'",
                                      liveplay::util::path_to_utf8(path));
                        return json_err(500, "repair succeeded but save failed");
                    }
                    saved = true;
                }
                auto issues = json::array();
                for (const auto& iss : repair.issues) issues.push_back(iss);
                Logger::api_response("Client ({}) <- Server ({}) : POST /api/project/repair OK — repaired={} saved={}",
                                     req.remote_ip_address, impl_->server_addr,
                                     repair.repaired, saved);
                return json_ok(json{{"repaired", repair.repaired}, {"issues", std::move(issues)}, {"saved", saved}});
            } catch (const std::exception& e) {
                Logger::error("POST /api/project/repair threw: {}", e.what());
                return json_err(400, e.what());
            }
        });

    CROW_ROUTE(app, "/api/project/save").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                auto j = json::parse(req.body);
                fs::path p;
                const bool path_provided =
                    j.contains("path") && j["path"].is_string();
                if (path_provided) {
                    p = liveplay::util::utf8_to_path(j["path"].get<std::string>());
                } else {
                    p = state_.project_file_path();
                    if (p.empty()) {
                        Logger::warn("POST /api/project/save — no path set");
                        return json_err(400, "no project file path set");
                    }
                }
                if (!core::project_file::is_native_project(p))
                    return json_err(400, "project path must use .dwcue");
                if (path_provided) state_.set_project_file_path(p);
                // Authoritative-save path: if the client included the latest
                // document in the body, replace the in-memory document AND
                // re-mirror it to the audio engine before writing to disk.
                // This guarantees per-cue property edits (fade-in / stop-fade
                // / cross-fade / volume / ducking) take effect immediately even
                // when the granular item-diff watcher on the client missed a
                // change. Without this fallback the user can edit a slider and
                // see the save call land while the engine still uses stale
                // values from the previous play.
                if (j.contains("document") && j["document"].is_object()) {
                    if (!state_.replace_full_document(j["document"])) {
                        Logger::warn("POST /api/project/save — embedded document "
                                     "rejected, continuing with existing state");
                    }
                }
                Logger::api_request("Client ({}) -> Server ({}) : POST /api/project/save path='{}'",
                                    req.remote_ip_address, impl_->server_addr,
                                    liveplay::util::path_to_utf8(p));
                if (!state_.save(p)) {
                    Logger::error("POST /api/project/save FAILED for '{}'",
                                  liveplay::util::path_to_utf8(p));
                    return json_err(500, "save failed");
                }
                const auto path_str = liveplay::util::path_to_utf8(p);
                Logger::api_response("Client ({}) <- Server ({}) : POST /api/project/save OK → '{}'",
                                     req.remote_ip_address, impl_->server_addr, path_str);
                return json_ok(json({{"ok", true}, {"path", path_str}}));
            } catch (const std::exception& e) {
                Logger::error("POST /api/project/save threw: {}", e.what());
                return json_err(400, e.what());
            }
        });

    // Replace the entire project document. Client uses this on app startup if
    // it has an existing in-memory project it wants to push to the server.
    // Like /api/project/load, this returns the header rather than the full
    // document so the round-trip stays cheap for large projects.
    CROW_ROUTE(app, "/api/project/document").methods(crow::HTTPMethod::Put)
        ([this](const crow::request& req){
            try {
                auto doc = json::parse(req.body);
                const std::string proj_name = doc.value("name", "?");
                Logger::api_request("Client ({}) -> Server ({}) : PUT /api/project/document name='{}'",
                                    req.remote_ip_address, impl_->server_addr, proj_name);
                if (!state_.replace_full_document(doc)) {
                    Logger::error("PUT /api/project/document — document not accepted");
                    return json_err(400, "document not accepted");
                }
                auto header = state_.header_document();
                const std::size_t item_count = header.value("itemCount", (std::size_t)0);
                Logger::api_response("Client ({}) <- Server ({}) : PUT /api/project/document OK — '{}' ({} items)",
                                     req.remote_ip_address, impl_->server_addr,
                                     proj_name, item_count);
                broadcast_doc_patch(json{
                    {"type", "doc_patch"}, {"op", "project_changed"},
                });
                return json_ok(header);
            } catch (const std::exception& e) {
                Logger::error("PUT /api/project/document threw: {}", e.what());
                return json_err(400, e.what());
            }
        });

    // ---- Items (mirror of client's hierarchical playlist) ----
    // Mutating endpoints return only {ok:true} (plus the affected uuid on
    // add) instead of the full project document. Sending the full doc on
    // every property tweak was saturating the network for large projects
    // and causing WebSocket buffer write errors on slow clients.
    CROW_ROUTE(app, "/api/project/items").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                auto j = json::parse(req.body);
                if (!j.contains("item") || !j["item"].is_object()) {
                    Logger::warn("POST /api/project/items — missing 'item' object");
                    return json_err(400, "missing 'item' object");
                }
                const std::string item_uuid  = j["item"].value("uuid", std::string{});
                const std::string item_name  = j["item"].value("displayName", std::string{});
                const std::string parent_uuid = j.value("parentUuid", std::string{});
                const bool cart_only = j.value("cartOnly", false);
                Logger::api_request("Client ({}) -> Server ({}) : POST /api/project/items uuid='{}' name='{}'{}{}",
                                    req.remote_ip_address, impl_->server_addr, item_uuid,
                                    item_name, parent_uuid.empty() ? "" : " parent='" + parent_uuid + "'",
                                    cart_only ? " [cartOnly]" : "");
                const auto cue_id = state_.add_item(j["item"], parent_uuid, cart_only);
                Logger::api_response("Client ({}) <- Server ({}) : POST /api/project/items OK — uuid='{}' cueId='{}'",
                                     req.remote_ip_address, impl_->server_addr,
                                     item_uuid, cue_id.value);
                broadcast_doc_patch(json{
                    {"type", "doc_patch"}, {"op", "item_added"},
                    {"uuid", item_uuid},
                    {"parentUuid", parent_uuid},
                    {"cartOnly", cart_only},
                    {"item", j["item"]},
                    {"cueId", cue_id.value},
                });
                return json_ok(json({
                    {"ok",    true},
                    {"uuid",  item_uuid},
                    {"cueId", cue_id.value},
                }));
            } catch (const std::exception& e) {
                Logger::error("POST /api/project/items threw: {}", e.what());
                return json_err(400, e.what());
            }
        });

    CROW_ROUTE(app, "/api/project/items/<string>").methods(crow::HTTPMethod::Patch)
        ([this](const crow::request& req, std::string uuid){
            try {
                auto patch = json::parse(req.body);
                const std::string client_mutation_id =
                    req.get_header_value("X-DWCUE-Mutation-ID");
                Logger::api_request("Client ({}) -> Server ({}) : PATCH /api/project/items/{}",
                                    req.remote_ip_address, impl_->server_addr, uuid);
                if (!state_.update_item(uuid, patch)) {
                    Logger::warn("PATCH /api/project/items/{} — item not found", uuid);
                    return json_err(404, "item not found");
                }
                Logger::api_response("Client ({}) <- Server ({}) : PATCH /api/project/items/{} OK",
                                     req.remote_ip_address, impl_->server_addr, uuid);
                json event{
                    {"type", "doc_patch"}, {"op", "item_updated"},
                    {"uuid", uuid}, {"patch", patch},
                };
                if (!client_mutation_id.empty() && client_mutation_id.size() <= 128) {
                    event["clientMutationId"] = client_mutation_id;
                }
                broadcast_doc_patch(event);
                return json_ok(json({{"ok", true}, {"uuid", uuid}}));
            } catch (const std::exception& e) {
                Logger::error("PATCH /api/project/items/{} threw: {}", uuid, e.what());
                return json_err(400, e.what());
            }
        });

    CROW_ROUTE(app, "/api/project/items/<string>").methods(crow::HTTPMethod::Delete)
        ([this](const crow::request& req, std::string uuid){
            Logger::api_request("Client ({}) -> Server ({}) : DELETE /api/project/items/{}",
                                req.remote_ip_address, impl_->server_addr, uuid);
            if (!state_.remove_item(uuid)) {
                Logger::warn("DELETE /api/project/items/{} — not found", uuid);
                return json_err(404, "item not found");
            }
            Logger::api_response("Client ({}) <- Server ({}) : DELETE /api/project/items/{} OK",
                                 req.remote_ip_address, impl_->server_addr, uuid);
            broadcast_doc_patch(json{
                {"type", "doc_patch"}, {"op", "item_removed"}, {"uuid", uuid},
            });
            return json_ok(json({{"ok", true}, {"uuid", uuid}}));
        });

    CROW_ROUTE(app, "/api/project/items/reorder").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                auto j = json::parse(req.body);
                const std::string parent_uuid = j.value("parentUuid", std::string{});
                std::vector<std::string> uuids;
                if (j.contains("uuids") && j["uuids"].is_array()) {
                    for (const auto& u : j["uuids"]) {
                        if (u.is_string()) uuids.push_back(u.get<std::string>());
                    }
                }
                Logger::api_request("Client ({}) -> Server ({}) : POST /api/project/items/reorder ({} items){}",
                                    req.remote_ip_address, impl_->server_addr, uuids.size(),
                                    parent_uuid.empty() ? "" : " parent='" + parent_uuid + "'");
                state_.reorder_items(uuids, parent_uuid);
                Logger::api_response("Client ({}) <- Server ({}) : POST /api/project/items/reorder OK",
                                     req.remote_ip_address, impl_->server_addr);
                broadcast_doc_patch(json{
                    {"type", "doc_patch"}, {"op", "items_reordered"},
                    {"parentUuid", parent_uuid}, {"uuids", uuids},
                });
                return json_ok(json({{"ok", true}}));
            } catch (const std::exception& e) {
                Logger::error("POST /api/project/items/reorder threw: {}", e.what());
                return json_err(400, e.what());
            }
        });

    // Item-by-uuid transport. Routed through ProjectState so duckingBehavior,
    // inPoint, and fade settings from the project document are honoured.
    CROW_ROUTE(app, "/api/project/items/<string>/play")
        .methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req, std::string uuid){
            const std::string m = crow::method_name(req.method);
            Logger::api_request("Client ({}) -> Server ({}) : {} /api/project/items/{}/play",
                                req.remote_ip_address, impl_->server_addr, m, uuid);
            Logger::playback("PLAY: {}", item_playback_info(uuid, state_));
            if (!state_.play_item(uuid)) {
                Logger::warn("PLAY item_uuid={} — item not loaded into engine", uuid);
                return json_err(404, "item not loaded into engine");
            }
            Logger::api_response("Client ({}) <- Server ({}) : {} /api/project/items/{}/play OK",
                                 req.remote_ip_address, impl_->server_addr, m, uuid);
            return json_ok(json({{"ok", true}}));
        });

    // Item-by-index transport. The index is an index *path* — a list of child
    // indices that descends into groups at each level, mirroring the client's
    // findItemByIndex / endBehavior.targetIndex semantics. For example "1,11"
    // means top-level item 1 (the 2nd item, a group) then its child 11 (the
    // 12th item inside it). Both comma- and slash-separated forms are accepted
    // ("1,11" and "1/11" are equivalent), so the URL can be written either way
    // — even mixed ("1,2/0"). Routed through trigger_item so audio items play
    // and group items dispatch per their startBehavior.
    CROW_ROUTE(app, "/api/project/items/by-index/<path>")
        .methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req, std::string index_path){
            const std::string m = crow::method_name(req.method);
            Logger::api_request("Client ({}) -> Server ({}) : {} /api/project/items/by-index/{}",
                                req.remote_ip_address, impl_->server_addr, m, index_path);
            // Split on both ',' and '/' so "1,11", "1/11" and "1,2/0" all work.
            std::vector<int> path;
            std::string token;
            bool parse_error = false;
            auto flush = [&]{
                if (token.empty()) return;
                try {
                    std::size_t consumed = 0;
                    const int v = std::stoi(token, &consumed);
                    if (consumed != token.size() || v < 0) parse_error = true;
                    else path.push_back(v);
                } catch (...) { parse_error = true; }
                token.clear();
            };
            for (char c : index_path) {
                if (c == ',' || c == '/') flush();
                else                      token.push_back(c);
            }
            flush();
            if (parse_error || path.empty()) {
                Logger::warn("TRIGGER by-index '{}' — invalid index path", index_path);
                return json_err(400, "invalid index path");
            }
            const std::string uuid = state_.item_uuid_by_index(path);
            if (uuid.empty()) {
                Logger::warn("TRIGGER by-index '{}' — no item at that index", index_path);
                return json_err(404, "no item at that index");
            }
            Logger::playback("TRIGGER: {}", item_playback_info(uuid, state_));
            if (!state_.trigger_item(uuid)) {
                Logger::warn("TRIGGER by-index '{}' uuid={} — item not loaded into engine",
                             index_path, uuid);
                return json_err(404, "item not loaded into engine");
            }
            Logger::api_response("Client ({}) <- Server ({}) : {} /api/project/items/by-index/{} OK -> uuid={}",
                                 req.remote_ip_address, impl_->server_addr, m, index_path, uuid);
            return json_ok(json({{"ok", true}, {"uuid", uuid}, {"index", path}}));
        });

    CROW_ROUTE(app, "/api/project/items/<string>/stop").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req, std::string uuid){
            Logger::api_request("Client ({}) -> Server ({}) : POST /api/project/items/{}/stop",
                                req.remote_ip_address, impl_->server_addr, uuid);
            Logger::playback("STOP: {}", item_playback_info(uuid, state_));
            if (!state_.stop_item(uuid)) {
                Logger::warn("STOP item_uuid={} — item not loaded into engine", uuid);
                return json_err(404, "item not loaded into engine");
            }
            Logger::api_response("Client ({}) <- Server ({}) : POST /api/project/items/{}/stop OK",
                                 req.remote_ip_address, impl_->server_addr, uuid);
            return json_ok(json({{"ok", true}}));
        });
    // Pause / resume hold the playhead without unloading. REST mirror of the
    // WS "pause"/"resume" messages so stateless control surfaces can use them.
    CROW_ROUTE(app, "/api/project/items/<string>/pause").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req, std::string uuid){
            Logger::api_request("Client ({}) -> Server ({}) : POST /api/project/items/{}/pause",
                                req.remote_ip_address, impl_->server_addr, uuid);
            const auto cue = state_.item_to_cue_id(uuid);
            if (!cue) return json_err(404, "item not loaded into engine");
            if (auto pi = engine_.find_cue(*cue)) {
                Logger::playback("PAUSE: {}", item_playback_info(uuid, state_));
                pi->pause();
                return json_ok(json({{"ok", true}}));
            }
            return json_err(404, "item not loaded into engine");
        });
    CROW_ROUTE(app, "/api/project/items/<string>/resume").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req, std::string uuid){
            Logger::api_request("Client ({}) -> Server ({}) : POST /api/project/items/{}/resume",
                                req.remote_ip_address, impl_->server_addr, uuid);
            const auto cue = state_.item_to_cue_id(uuid);
            if (!cue) return json_err(404, "item not loaded into engine");
            if (auto pi = engine_.find_cue(*cue)) {
                Logger::playback("RESUME: {}", item_playback_info(uuid, state_));
                pi->resume();
                return json_ok(json({{"ok", true}}));
            }
            return json_err(404, "item not loaded into engine");
        });
    CROW_ROUTE(app, "/api/project/items/<string>/seek").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req, std::string uuid){
            try {
                auto j = json::parse(req.body);
                const double secs = j.value("seconds", 0.0);
                Logger::api_request("Client ({}) -> Server ({}) : POST /api/project/items/{}/seek seconds={:.2f}",
                                    req.remote_ip_address, impl_->server_addr, uuid, secs);
                Logger::playback("SEEK: {} → {:.2f}s", item_playback_info(uuid, state_), secs);
                const auto cue = state_.item_to_cue_id(uuid);
                if (!cue) {
                    Logger::warn("SEEK item_uuid={} — not loaded into engine", uuid);
                    return json_err(404, "item not loaded into engine");
                }
                if (auto pi = engine_.find_cue(*cue)) {
                    pi->seek_seconds(secs);
                }
                return json_ok(json({{"ok", true}}));
            } catch (const std::exception& e) {
                Logger::error("POST /api/project/items/{}/seek threw: {}", uuid, e.what());
                return json_err(400, e.what());
            }
        });

    // ---- Cart slot bindings ----
    CROW_ROUTE(app, "/api/project/cart").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                auto j = json::parse(req.body);
                const int slot = j.value("slot", -1);
                const std::string uuid = j.value("itemUuid", std::string{});
                if (slot < 0 || uuid.empty()) {
                    Logger::warn("POST /api/project/cart — slot and itemUuid required");
                    return json_err(400, "slot and itemUuid required");
                }
                Logger::api_request("Client ({}) -> Server ({}) : POST /api/project/cart slot={} itemUuid='{}'",
                                    req.remote_ip_address, impl_->server_addr, slot, uuid);
                if (!state_.set_cart_slot(slot, uuid)) {
                    Logger::warn("POST /api/project/cart — slot {} is outside 0..63", slot);
                    return json_err(400, "slot must be between 0 and 63");
                }
                Logger::api_response("Client ({}) <- Server ({}) : POST /api/project/cart OK — slot={} uuid='{}'",
                                     req.remote_ip_address, impl_->server_addr, slot, uuid);
                broadcast_doc_patch(json{
                    {"type", "doc_patch"}, {"op", "cart_slot_set"},
                    {"slot", slot}, {"itemUuid", uuid},
                });
                return json_ok(json({{"ok", true}, {"slot", slot}, {"itemUuid", uuid}}));
            } catch (const std::exception& e) {
                Logger::error("POST /api/project/cart threw: {}", e.what());
                return json_err(400, e.what());
            }
        });
    CROW_ROUTE(app, "/api/project/cart/<int>").methods(crow::HTTPMethod::Delete)
        ([this](const crow::request& req, int slot){
            Logger::api_request("Client ({}) -> Server ({}) : DELETE /api/project/cart/{}",
                                req.remote_ip_address, impl_->server_addr, slot);
            // clear_cart_slot() returns false when the slot held no binding.
            if (!state_.clear_cart_slot(slot)) {
                Logger::warn("DELETE /api/project/cart/{} — no binding at slot", slot);
                return json_err(404, "no binding at slot");
            }
            Logger::api_response("Client ({}) <- Server ({}) : DELETE /api/project/cart/{} OK",
                                 req.remote_ip_address, impl_->server_addr, slot);
            broadcast_doc_patch(json{
                {"type", "doc_patch"}, {"op", "cart_slot_cleared"}, {"slot", slot},
            });
            return json_ok(json({{"ok", true}, {"slot", slot}}));
        });

    // ---- Preview (DJ-style pre-listening on settings.previewDevice) ----
    CROW_ROUTE(app, "/api/preview").methods(crow::HTTPMethod::Get)
        ([this] {
            const auto item_uuid = state_.current_preview_item_uuid();
            const auto cue_id    = state_.current_preview_cue_id();
            return json_ok(json({
                {"active",   !item_uuid.empty()},
                {"itemUuid", item_uuid},
                {"cueId",    cue_id.value},
            }));
        });
    CROW_ROUTE(app, "/api/preview").methods(crow::HTTPMethod::Post)
        ([this](const crow::request& req){
            try {
                auto j = json::parse(req.body);
                const std::string uuid = j.value("itemUuid", std::string{});
                if (uuid.empty()) {
                    Logger::warn("POST /api/preview — itemUuid required");
                    return json_err(400, "itemUuid required");
                }
                Logger::api_request("Client ({}) -> Server ({}) : POST /api/preview itemUuid='{}'",
                                    req.remote_ip_address, impl_->server_addr, uuid);
                Logger::playback("PREVIEW START: {}", item_playback_info(uuid, state_));
                const bool ok = state_.start_preview(uuid);
                if (!ok) {
                    Logger::warn("PREVIEW START failed for item_uuid='{}' — no device or item not found", uuid);
                    return json_err(400, "preview could not start (no device, or item not found)");
                }
                const auto cue_id = state_.current_preview_cue_id().value;
                Logger::api_response("Client ({}) <- Server ({}) : POST /api/preview OK — cueId='{}'",
                                     req.remote_ip_address, impl_->server_addr, cue_id);
                // Mirror preview state to every other connected client so
                // they can show the preview card / cue id in real time.
                broadcast_doc_patch(json{
                    {"type", "doc_patch"},
                    {"op",   "preview_started"},
                    {"itemUuid", uuid},
                    {"cueId", cue_id},
                });
                return json_ok(json({
                    {"ok",      true},
                    {"itemUuid", uuid},
                    {"cueId",   cue_id},
                }));
            } catch (const std::exception& e) {
                Logger::error("POST /api/preview threw: {}", e.what());
                return json_err(400, e.what());
            }
        });
    CROW_ROUTE(app, "/api/preview").methods(crow::HTTPMethod::Delete)
        ([this](const crow::request& req) {
            Logger::api_request("Client ({}) -> Server ({}) : DELETE /api/preview",
                                req.remote_ip_address, impl_->server_addr);
            Logger::playback("PREVIEW STOP");
            state_.stop_preview();
            Logger::api_response("Client ({}) <- Server ({}) : DELETE /api/preview OK",
                                 req.remote_ip_address, impl_->server_addr);
            broadcast_doc_patch(json{
                {"type", "doc_patch"},
                {"op",   "preview_stopped"},
            });
            return json_ok(json({{"ok", true}}));
        });

    // ---- Theme + settings patches ----
    CROW_ROUTE(app, "/api/project/theme").methods(crow::HTTPMethod::Patch)
        ([this](const crow::request& req){
            try {
                auto patch = json::parse(req.body);
                Logger::api_request("Client ({}) -> Server ({}) : PATCH /api/project/theme",
                                    req.remote_ip_address, impl_->server_addr);
                state_.patch_theme(patch);
                auto theme = state_.full_document()["theme"];
                Logger::api_response("Client ({}) <- Server ({}) : PATCH /api/project/theme OK",
                                     req.remote_ip_address, impl_->server_addr);
                broadcast_doc_patch(json{
                    {"type", "doc_patch"}, {"op", "theme_patched"}, {"theme", theme},
                });
                return json_ok(theme);
            } catch (const std::exception& e) {
                Logger::error("PATCH /api/project/theme threw: {}", e.what());
                return json_err(400, e.what());
            }
        });
    CROW_ROUTE(app, "/api/project/settings").methods(crow::HTTPMethod::Patch)
        ([this](const crow::request& req){
            try {
                auto patch = json::parse(req.body);
                Logger::api_request("Client ({}) -> Server ({}) : PATCH /api/project/settings",
                                    req.remote_ip_address, impl_->server_addr);
                if (!state_.patch_settings(patch))
                    return json_err(400, "invalid project settings");
                auto settings = state_.full_document()["settings"];
                Logger::api_response("Client ({}) <- Server ({}) : PATCH /api/project/settings OK",
                                     req.remote_ip_address, impl_->server_addr);
                broadcast_doc_patch(json{
                    {"type", "doc_patch"}, {"op", "settings_patched"}, {"settings", settings},
                });
                return json_ok(settings);
            } catch (const std::exception& e) {
                Logger::error("PATCH /api/project/settings threw: {}", e.what());
                return json_err(400, e.what());
            }
        });

    // ------------------------------------------------------------------
    // WebSocket
    // ------------------------------------------------------------------
    CROW_WEBSOCKET_ROUTE(app, "/ws")
      .max_payload(64 * 1024)
      .onaccept([this](const crow::request& req,
                       std::optional<crow::response>& rejection,
                       void**) {
          const std::string origin = req.get_header_value("Origin");
          const auto& middleware =
              impl_->app.get_middleware<ControlSecurityMiddleware>();
          if (!security::origin_allowed(origin, cfg_.allowed_origins)) {
              rejection = crow::response{
                  403, json({{"error", "origin not allowed"}}).dump()};
              rejection->set_header("Content-Type", "application/json");
              return;
          }
          if (!middleware.authorized(req)) {
              rejection = crow::response{
                  401, json({{"error", "authentication required"}}).dump()};
              rejection->set_header("Content-Type", "application/json");
              rejection->set_header("WWW-Authenticate", "Bearer");
          }
      })
      .onopen([this](crow::websocket::connection& conn) {
          std::lock_guard lock{impl_->ws_mutex};
          impl_->ws_clients.insert(&conn);
          // Mark this client for a playback_snapshot push on the next
          // broadcast tick. The snapshot can't be sent inline here because
          // build_playback_snapshot takes both engine and project locks
          // (potentially seconds, e.g. mid project mirror) and Crow's
          // connection is not safe to write from two threads at once —
          // direct send_text here races the broadcast thread.
          impl_->ws_clients_pending_snapshot.insert(&conn);
          Logger::info("WS client connected ({} total)", impl_->ws_clients.size());
      })
      .onclose([this](crow::websocket::connection& conn, const std::string& reason, std::uint16_t /*code*/) {
          std::lock_guard lock{impl_->ws_mutex};
          impl_->ws_clients.erase(&conn);
          impl_->ws_clients_pending_snapshot.erase(&conn);
          Logger::info("WS client disconnected ({}); {} remaining",
                       reason, impl_->ws_clients.size());
      })
      .onmessage([this](crow::websocket::connection& conn,
                        const std::string& data,
                        bool is_binary) {
          if (is_binary) return;
          std::string direct_reply;
          try {
              direct_reply = handle_ws_message(
                  conn, data, engine_, state_, impl_->server_addr,
                  impl_->ws_command_mutex, impl_->ws_command_results,
                  impl_->ws_command_order);
          } catch (const std::exception& e) {
              Logger::error("WS onmessage threw past handler: {}", e.what());
          } catch (...) {
              Logger::error("WS onmessage caught unknown exception.");
          }
          // Send any direct reply (pong, error) under ws_mutex so it is
          // serialised with broadcast_loop's concurrent send_text calls.
          // Calling send_text from the ASIO thread without the mutex while
          // broadcast_loop is also writing to the same conn causes the
          // "not safe for concurrent writes" crash described in the Impl comment.
          if (!direct_reply.empty()) {
              std::lock_guard lock{impl_->ws_mutex};
              try { conn.send_text(direct_reply); } catch (...) {}
          }
          // After applying any state-mutating WS message, fan out the
          // relevant change to every other client so multi-client mirroring
          // stays consistent (the originating client gets the echo too —
          // its local state already matches so the apply is a no-op).
          // Note: set_next_item fan-out is handled centrally by the
          // next_item_broadcaster installed on ProjectState (it fires for both
          // client-requested and server-armed changes), so we don't broadcast
          // it again here.
      });
}

} // namespace liveplay::net
