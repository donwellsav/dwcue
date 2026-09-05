// ============================================================================
// project_state.cpp — see project_state.hpp.
// ============================================================================
#include "liveplay/core/project_state.hpp"
#include "liveplay/core/one_shot_migration.hpp"
#include "liveplay/core/project_file.hpp"
#include "liveplay/logger.hpp"
#include "liveplay/meta/metadata.hpp"
#include "liveplay/util/atomic_file.hpp"
#include "liveplay/util/unicode_path.hpp"

#include <algorithm>
#include <cmath>
#include <ctime>
#include <fstream>
#include <functional>
#include <future>
#include <system_error>
#include <thread>
#include <unordered_map>
#include <unordered_set>

namespace liveplay::core {

namespace {
inline std::string id_to_string(const audio::CueId& id)          { return id.value; }
inline std::string id_to_string(const audio::MixerChannelId& id) { return id.value; }
inline std::string id_to_string(const audio::DeviceId& id)       { return id.value; }

// Type-safe JSON field read. Unlike nlohmann's .value<T>()/.at().get<T>(),
// this never throws on a wrong-typed (or null) field — it returns `def`
// instead. Malformed project fields (e.g. a number where a string is
// expected) would otherwise throw nlohmann::type_error uncaught through the
// network layer. (#5)
template <class T>
T json_get_or(const nlohmann::json& j, const char* key, const T& def) noexcept {
    try {
        if (auto it = j.find(key); it != j.end() && !it->is_null())
            return it->get<T>();
    } catch (...) {}
    return def;
}

// Convert a Unix timestamp (seconds since epoch) to an ISO 8601 UTC string.
inline std::string unix_ts_to_iso(std::int64_t unix_sec) {
    const std::time_t t = static_cast<std::time_t>(unix_sec);
    std::tm tm_buf{};
#ifdef _WIN32
    gmtime_s(&tm_buf, &t);
#else
    gmtime_r(&t, &tm_buf);
#endif
    char buf[32];
    std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S.000Z", &tm_buf);
    return std::string{buf};
}

// Return the current time as an ISO 8601 UTC string.
inline std::string now_iso() {
    const auto now = std::chrono::system_clock::now();
    return unix_ts_to_iso(
        static_cast<std::int64_t>(
            std::chrono::duration_cast<std::chrono::seconds>(
                now.time_since_epoch()).count()));
}

// Read lastModified from a document, tolerating both ISO string and legacy
// Unix-timestamp integer formats. Returns "" if the field is absent or
// has an unexpected type.
inline std::string read_last_modified(const json& doc) {
    if (!doc.contains("lastModified")) return "";
    const auto& lm = doc["lastModified"];
    if (lm.is_string())          return lm.get<std::string>();
    if (lm.is_number_integer())  return unix_ts_to_iso(lm.get<std::int64_t>());
    if (lm.is_number_unsigned()) return unix_ts_to_iso(
                                     static_cast<std::int64_t>(lm.get<std::uint64_t>()));
    return "";
}

// ---------------------------------------------------------------------------
// Media path resolution
// ---------------------------------------------------------------------------
// An audio item can carry two file references:
//   • mediaPath       — RELATIVE to the project folder, e.g. "media/foo.mp3".
//                       Portable: it stays valid even after the whole project
//                       (the .dwcue file plus its media/ folder) is moved,
//                       because folderPath is rewritten to the file's real
//                       location on load.
//   • mediaServerPath — an ABSOLUTE path captured at import time. Handy while
//                       the project hasn't moved, but goes stale the instant
//                       the project is relocated.
//
// We therefore prefer the relative form whenever it actually points at a file
// on disk, and only fall back to the absolute mediaServerPath when the relative
// form is absent or missing. That makes moved projects — and legacy v1 projects
// (relative mediaPath, but a folderPath baked to the old location) — resolve
// correctly, while still honouring genuine out-of-folder references.
inline std::filesystem::path resolve_media_path(const json& item,
                                                const std::string& folder) {
    std::string relative;
    if (item.contains("mediaPath") && item["mediaPath"].is_string()) {
        const std::string media_path = item["mediaPath"].get<std::string>();
        if (!media_path.empty()) {
            if (!folder.empty()) {
                relative = folder;
                if (relative.back() != '/' && relative.back() != '\\')
                    relative += '/';
            }
            relative += media_path;
        }
    }
    std::string server;
    if (item.contains("mediaServerPath") && item["mediaServerPath"].is_string())
        server = item["mediaServerPath"].get<std::string>();

    std::error_code ec;
    if (!relative.empty()) {
        const auto rel_path = util::utf8_to_path(relative);
        if (std::filesystem::exists(rel_path, ec)) return rel_path;
    }
    if (!server.empty()) {
        const auto srv_path = util::utf8_to_path(server);
        if (std::filesystem::exists(srv_path, ec)) return srv_path;
    }
    // Neither file exists. Return the portable relative form when we have one
    // (so the item still carries a sensible path to relocate later); otherwise
    // the absolute one.
    if (!relative.empty()) return util::utf8_to_path(relative);
    return server.empty() ? std::filesystem::path{} : util::utf8_to_path(server);
}

// Rewrite every audio item to reference its media RELATIVE to the project
// folder whenever the file actually lives inside that folder. The portable
// "media/<file>" mediaPath becomes the canonical reference and the absolute,
// import-time mediaServerPath is dropped, so a saved project never strands its
// media when moved. Genuine out-of-folder references (media that doesn't live
// under the project folder) are left untouched, absolute path and all.
inline void relativize_media_paths(json& doc) {
    const std::string folder = doc.value("folderPath", std::string{});
    if (folder.empty()) return;
    std::error_code ec;
    const auto folder_base =
        std::filesystem::weakly_canonical(util::utf8_to_path(folder), ec);
    const std::filesystem::path base = ec ? util::utf8_to_path(folder) : folder_base;

    // Rewrite a single absolute path that lives inside the project folder to
    // its portable "subdir/file" relative form. Returns nullopt when the path
    // is empty or genuinely outside the folder (left untouched by the caller).
    const auto relativize_inside = [&](const std::string& p)
            -> std::optional<std::string> {
        if (p.empty()) return std::nullopt;
        std::error_code ecc;
        const auto abs = std::filesystem::weakly_canonical(util::utf8_to_path(p), ecc);
        const auto target = ecc ? util::utf8_to_path(p) : abs;
        std::error_code ecr;
        const auto rel = std::filesystem::relative(target, base, ecr);
        if (ecr || rel.empty() || *rel.begin() == std::filesystem::path(".."))
            return std::nullopt;
        std::string rel_utf8 = util::path_to_utf8(rel);
        std::replace(rel_utf8.begin(), rel_utf8.end(), '\\', '/');
        return rel_utf8;
    };

    const std::function<void(json&)> visit = [&](json& item) {
        if (!item.is_object()) return;
        if (item.value("type", std::string{}) == "audio") {
            const auto resolved = resolve_media_path(item, folder);
            if (!resolved.empty()) {
                std::error_code ec2;
                const auto resolved_canon = std::filesystem::weakly_canonical(resolved, ec2);
                const auto abs = ec2 ? resolved : resolved_canon;
                std::error_code ec3;
                const auto rel = std::filesystem::relative(abs, base, ec3);
                // Inside the project folder iff the relative path exists and its
                // first component isn't ".." (i.e. it doesn't climb back out).
                if (!ec3 && !rel.empty() && *rel.begin() != std::filesystem::path("..")) {
                    std::string rel_utf8 = util::path_to_utf8(rel);
                    std::replace(rel_utf8.begin(), rel_utf8.end(), '\\', '/');
                    item["mediaPath"] = rel_utf8;
                    item.erase("mediaServerPath");
                }
            }
            // Normalise the waveform sidecar path to the portable relative form
            // too, so a project moved to a new folder keeps resolving its
            // waveforms. Absolute paths that point outside the folder are left
            // as-is (genuine external reference).
            if (item.contains("waveformPath") && item["waveformPath"].is_string()) {
                if (auto relwf = relativize_inside(item["waveformPath"].get<std::string>()))
                    item["waveformPath"] = *relwf;
            }
        }
        if (item.value("type", std::string{}) == "group" &&
            item.contains("children") && item["children"].is_array()) {
            for (auto& ch : item["children"]) visit(ch);
        }
    };
    if (doc.contains("items") && doc["items"].is_array())
        for (auto& it : doc["items"]) visit(it);
    if (doc.contains("cartOnlyItems") && doc["cartOnlyItems"].is_array())
        for (auto& it : doc["cartOnlyItems"]) visit(it);
}


// ---------------------------------------------------------------------------
// Output Target loudness standards.
// The server is the single authority on these numbers. The client reads them
// back through settings["outputTargetLevels"] embedded in every full_document()
// / header_document() response and in the settings_patched broadcast.
// ---------------------------------------------------------------------------
struct OutputTargetLevels {
    float blue_below;            // meter reads blue below this value
    float green_min;             // green zone start
    float green_max;             // green zone end
    float yellow_min;            // yellow zone start (== green_max)
    float yellow_max;            // yellow zone end (== red threshold)
    float limiter_ceiling_db;    // true-peak limiter ceiling in dBTP
    float loudness_target_lufs;  // target for loudness normalisation
    const char* meter_unit;      // preferred unit: "LUFS" | "dBFS" | "dBTP" | "RMS"
    const char* waveform_color;  // CSS hex color for the properties-panel waveform
};

// All zone boundaries are in the same unit as meter_unit for that platform.
static const std::unordered_map<std::string, OutputTargetLevels> kOutputTargets {
    // EBU R128 — integrated loudness target -23 LUFS, max TP -1 dBTP
    {"ebu-r128",  {-28.0f, -28.0f, -20.0f, -20.0f, -1.0f,  -1.0f,  -23.0f, "LUFS", "#00e676"}},
    // Streaming (Spotify, Apple Music, YouTube) — target ~ -14 LUFS
    {"streaming", {-19.0f, -19.0f, -11.0f, -11.0f, -1.0f,  -1.0f,  -14.0f, "LUFS", "#00e676"}},
    // Radio broadcast (EBU R128 S1 / ITU BS.1770-4 radio) — target -16 LUFS
    {"radio",     {-21.0f, -21.0f, -13.0f, -13.0f, -1.0f,  -1.0f,  -16.0f, "LUFS", "#00e676"}},
    // Netflix (OAPP — Operational Audio Practice for Post) — -27 LUFS, TP -2 dBTP
    {"netflix",   {-32.0f, -32.0f, -24.0f, -24.0f, -2.0f,  -2.0f,  -27.0f, "LUFS", "#00e676"}},
    // Live / Digital Console — dBFS peaks, green comfort at -9 dBFS peak (-18 RMS)
    {"live",      {-24.0f, -24.0f, -9.0f,  -9.0f,  -0.1f,  -0.1f,  -18.0f, "dBFS", "#00e676"}},
};

static json compute_output_target_levels(const json& settings) {
    const std::string target = settings.value("outputTarget", std::string{"ebu-r128"});
    auto it = kOutputTargets.find(target);
    if (it == kOutputTargets.end()) it = kOutputTargets.find("ebu-r128");
    const auto& lv = it->second;
    float limiter_ceiling_db = lv.limiter_ceiling_db;
    if (auto override = settings.find("limiterCeilingDb");
        override != settings.end() && override->is_number()) {
        const double requested = override->get<double>();
        if (std::isfinite(requested) && requested >= -60.0 && requested <= 0.0)
            limiter_ceiling_db = static_cast<float>(requested);
    }
    return json{
        {"blueBelow",          lv.blue_below},
        {"greenMin",           lv.green_min},
        {"greenMax",           lv.green_max},
        {"yellowMin",          lv.yellow_min},
        {"yellowMax",          lv.yellow_max},
        {"redAbove",           lv.yellow_max},
        {"limiterCeilingDb",   limiter_ceiling_db},
        {"loudnessTargetLufs", lv.loudness_target_lufs},
        {"meterUnit",          lv.meter_unit},
        {"waveformColor",      lv.waveform_color},
    };
}

// Resolve the project's meter ballistics from settings.meterBallistics
// (preset id) / settings.meterBallisticsCustom ({attackMs, releaseMs,
// rmsWindowMs}, used when the preset id is "custom"). Unknown or absent
// values fall back to the engine default (digital-ppm feel).
static audio::MeterBallistics meter_ballistics_from_settings(const json& settings) {
    const std::string preset =
        settings.value("meterBallistics", std::string{"digital-ppm"});
    if (preset == "custom" &&
        settings.contains("meterBallisticsCustom") &&
        settings["meterBallisticsCustom"].is_object()) {
        const auto& c = settings["meterBallisticsCustom"];
        audio::MeterBallistics b;
        b.attack_ms     = std::clamp(c.value("attackMs",    1.0f),   0.0f, 5000.0f);
        b.release_ms    = std::clamp(c.value("releaseMs",   300.0f), 0.0f, 10000.0f);
        b.rms_window_ms = std::clamp(c.value("rmsWindowMs", 300.0f), 1.0f, 10000.0f);
        return b;
    }
    return audio::meter_ballistics_from_preset(preset)
        .value_or(audio::MeterBallistics{});
}

// Effective meter display mode: explicit settings.meterMode wins, otherwise
// the output target's recommended unit (mirrors the client's useOutputTarget
// logic). Drives the CPU gating of true-peak / loudness metering.
static std::string effective_meter_mode(const json& settings) {
    if (settings.contains("meterMode") && settings["meterMode"].is_string()) {
        return settings["meterMode"].get<std::string>();
    }
    return compute_output_target_levels(settings)
        .value("meterUnit", std::string{"LUFS"});
}

static void apply_audio_settings(audio::AudioEngine& engine, const json& settings) {
    const auto levels = compute_output_target_levels(settings);
    engine.set_master_ceiling_db(levels.value("limiterCeilingDb", -0.1f));
    engine.set_limiter_enabled(!settings.value("disableLimiter", false));
    engine.set_meter_ballistics(meter_ballistics_from_settings(settings));
    const auto mode = effective_meter_mode(settings);
    engine.set_true_peak_metering(mode == "dBTP");
    engine.set_loudness_metering(mode == "LUFS");
}

} // namespace

// ADL-visible to_json overloads — must be in liveplay::core (not anonymous namespace)
// so nlohmann's adl_serializer can find them for push_back / operator= conversions.
void to_json(json& j, const CueMeta& m) {
    j = json{
        {"id",                 m.id.value},
        {"display_name",       m.display_name},
        {"file_path",          util::path_to_utf8(m.file_path)},
        {"artist",             m.artist},
        {"title",              m.title},
        {"duration_sec",       m.duration_seconds},
        {"gain_db",            m.gain_db},
        {"fade_in_ms",         m.fade_in_ms.count()},
        {"fade_out_ms",        m.fade_out_ms.count()},
        {"ltc_enabled",        m.ltc_enabled},
        {"ltc_fps",            m.ltc_frame_rate_index},
        {"ltc_offset_ns",      static_cast<long long>(m.ltc_offset_ns.count())},
        {"ltc_start_timecode", m.ltc_start_timecode},
    };
}

void to_json(json& j, const MixerChannelMeta& m) {
    j = json{
        {"id",           m.id.value},
        {"display_name", m.display_name},
        {"gain_db",      m.gain_db},
        {"muted",        m.muted},
        {"soloed",       m.soloed},
    };
}

void to_json(json& j, const RouteSendV2& r) {
    j = json{
        {"source_channel",    r.source_channel},
        {"destination_mixer", r.destination_mixer.value},
        {"gain_db",           r.gain_db},
        {"lane",              r.lane},
    };
}

void to_json(json& j, const MixerToMasterV2& r) {
    j = json{
        {"mixer",           r.mixer.value},
        {"master_channel",  r.master_channel},
        {"gain_db",         r.gain_db},
        {"lane",            r.lane},
    };
}

void to_json(json& j, const MasterAssignment& a) {
    j = json{
        {"master_channel", a.master_channel},
        {"device",         a.device.value},
        {"hw_channel",     a.hw_channel},
    };
}

namespace {
audio::LTCFrameRate fps_index_to_rate(int idx) noexcept {
    switch (idx) {
        case 0: return audio::LTCFrameRate::Fps24;
        case 1: return audio::LTCFrameRate::Fps25;
        case 2: return audio::LTCFrameRate::Fps2997_NDF;
        case 3: return audio::LTCFrameRate::Fps2997_DF;
        default: return audio::LTCFrameRate::Fps30;
    }
}

// Convert a "HH:MM:SS:FF" (or "HH:MM:SS;FF" drop-frame) SMPTE string and a
// frame-rate index into a nanosecond offset suitable for LTCGenerator::configure().
// The offset is the timecode value at playhead position zero.
std::chrono::nanoseconds parse_smpte_timecode_to_ns(const std::string& tc,
                                                     int fps_index) noexcept {
    // Integer fps used for frame counting; real fps used for time conversion.
    static constexpr int    kFpsInt[]  = {24, 25, 30, 30, 30};
    static constexpr double kFpsReal[] = {24.0, 25.0,
                                          30000.0 / 1001.0,   // 29.97 NDF
                                          30000.0 / 1001.0,   // 29.97 DF
                                          30.0};
    const int   idx     = std::clamp(fps_index, 0, 4);
    const int   fps_int = kFpsInt[idx];
    const double fps    = kFpsReal[idx];

    int hh = 0, mm = 0, ss = 0, ff = 0;
    // Try both ':' separator (NDF) and ';' separator (DF convention).
    if (std::sscanf(tc.c_str(), "%d:%d:%d:%d", &hh, &mm, &ss, &ff) < 4)
        std::sscanf(tc.c_str(), "%d:%d:%d;%d", &hh, &mm, &ss, &ff);

    hh = std::clamp(hh, 0, 23);
    mm = std::clamp(mm, 0, 59);
    ss = std::clamp(ss, 0, 59);
    ff = std::clamp(ff, 0, fps_int - 1);

    const long long total_frames =
        static_cast<long long>(hh) * 3600LL * fps_int +
        static_cast<long long>(mm) *   60LL * fps_int +
        static_cast<long long>(ss)           * fps_int +
        static_cast<long long>(ff);

    const double seconds = static_cast<double>(total_frames) / fps;
    return std::chrono::nanoseconds{static_cast<long long>(seconds * 1e9)};
}

} // namespace

// ---------------------------------------------------------------------------

ProjectState::ProjectState(audio::AudioEngine& engine) : engine_(engine) {
    document_ = default_empty_document();
    start_sequencer();
    // Background decoder for single-item adds/media swaps (#43).
    loader_thread_ = std::thread([this] { loader_loop(); });
}

ProjectState::~ProjectState() {
    stop_sequencer();
    stop_loaders();
    // Make sure any in-flight async mirror finishes before the engine is
    // torn down — otherwise the worker would dereference dangling state.
    {
        std::lock_guard lock{mirror_mutex_};
        if (load_thread_.joinable()) load_thread_.join();
    }
    clear_diagnostic_cues();

    // Tear down preview infrastructure on shutdown so the audio device gets
    // released cleanly.
    if (!preview_cue_.empty()) {
        engine_.stop(preview_cue_);
        engine_.unload_cue(preview_cue_);
    }
    if (!preview_mixer_.empty()) {
        engine_.remove_mixer_channel(preview_mixer_);
    }
    if (!preview_device_.empty()) {
        engine_.close_device(preview_device_);
    }
}

// ---------------------------------------------------------------------------
// Single-item async audio load (#43)
// ---------------------------------------------------------------------------
// add_item() and update_item() must return promptly and must not hold mutex_
// across an audio decode: one large or network-mounted file used to stall every
// other request (play_item, stop, state, WS/HTTP handlers) for the whole decode.
//
// The split: under mutex_ we reserve the CueId and register a placeholder
// CueMeta (so the cue is immediately visible to find_cue / list_cues /
// item_to_cue_id and callers get a usable id synchronously), then queue the
// decode. The loader thread decodes with no ProjectState lock held and takes
// mutex_ again only for the cheap publish step.
// ---------------------------------------------------------------------------
audio::CueId ProjectState::begin_item_load_locked(const std::string& uuid,
                                                  const std::filesystem::path& path,
                                                  const json& item) {
    if (uuid.empty()) return {};
    if (path.empty()) {
        audio_load_failures_[uuid] = {"missing_media_path", std::string{}};
        return {};
    }
    audio_load_failures_.erase(uuid);

    const audio::CueId cue_id{engine_.new_cue_id()};

    // Placeholder metadata: the real artist/title/duration arrive with the
    // decode. Seed the duration from the document so the sequencer has
    // something sane if the item is fired before the load lands.
    CueMeta meta;
    meta.id        = cue_id;
    meta.file_path = path;
    meta.display_name = item.value("displayName", std::string{});
    if (meta.display_name.empty())
        meta.display_name = util::path_to_utf8(path.filename());
    meta.duration_seconds = json_get_or(item, "duration", 0.0);
    cues_.emplace(cue_id.value, std::move(meta));
    item_uuid_to_cue_[uuid] = cue_id;

    {
        std::lock_guard qlock{loader_mutex_};
        load_queue_.push_back(LoadRequest{uuid, cue_id, path});
        pending_load_uuids_.insert(uuid);
    }
    loader_cv_.notify_one();
    return cue_id;
}

void ProjectState::loader_loop() {
    for (;;) {
        LoadRequest req;
        {
            std::unique_lock qlock{loader_mutex_};
            loader_cv_.wait(qlock, [this] {
                return loaders_stop_ || !load_queue_.empty();
            });
            // On shutdown, drop whatever is still queued: those cues are about
            // to be torn down anyway, and the process shouldn't wait on them.
            if (loaders_stop_) return;
            req = std::move(load_queue_.front());
            load_queue_.pop_front();
        }

        // Guard the whole task — an exception escaping here would terminate the
        // process, and a decode touches the filesystem (network shares, removable
        // media) where anything can go wrong.
        try {
            // The expensive part: decoder init + metadata read, NO lock held.
            const auto loaded_id = engine_.load_cue_no_route(req.path, req.cue_id);
            const auto md        = meta::read_metadata(req.path);

            bool  publish   = false;
            bool  is_cart   = false;
            json  item_snap;
            {
                std::lock_guard lock{mutex_};
                // The item may have been removed, or its media swapped again,
                // while we were decoding. Either way this cue is now an orphan.
                auto it = item_uuid_to_cue_.find(req.uuid);
                const bool still_wanted =
                    it != item_uuid_to_cue_.end() && it->second == req.cue_id;

                if (!still_wanted || loaded_id.empty()) {
                    if (!loaded_id.empty()) engine_.unload_cue(loaded_id);
                    cues_.erase(req.cue_id.value);
                    if (!still_wanted) {
                        Logger::info("ProjectState: dropped stale load for uuid='{}'",
                                     req.uuid);
                    } else {
                        // Decode failed: drop the placeholder mapping too, so the
                        // item reads as "not loaded" rather than silently dead.
                        item_uuid_to_cue_.erase(req.uuid);
                        audio_load_failures_[req.uuid] = {
                            "decoder_init_failed", util::path_to_utf8(req.path)};
                        Logger::warn("ProjectState: failed to load item uuid='{}' ('{}')",
                                     req.uuid, util::path_to_utf8(req.path));
                    }
                } else {
                    audio_load_failures_.erase(req.uuid);
                    auto cm_it = cues_.find(req.cue_id.value);
                    if (cm_it != cues_.end()) {
                        auto& meta = cm_it->second;
                        if (!md.title.empty()) meta.display_name = md.title;
                        meta.artist = md.artist;
                        meta.title  = md.title;
                        if (md.duration.count() > 0) {
                            meta.duration_seconds =
                                static_cast<double>(md.duration.count()) / 1000.0;
                        }
                    }
                    // Re-read the document node: the operator may have changed
                    // volume/fades/out point while the decode was running.
                    for_each_item(document_, [&](json& it2, const std::string&) {
                        if (it2.value("uuid", std::string{}) == req.uuid)
                            item_snap = it2;
                    });
                    if (item_snap.is_object())
                        apply_item_properties_locked(item_snap, req.cue_id);
                    // One Shots (and legacy Cart-bound cues) can be fired at
                    // any moment by a hotkey/MIDI and must be hot.
                    is_cart = item_snap.contains("oneShot") &&
                              item_snap["oneShot"].is_object();
                    if (!is_cart && document_.contains("cartItems") &&
                        document_["cartItems"].is_array()) {
                        for (const auto& c : document_["cartItems"]) {
                            if (c.is_object() &&
                                c.value("itemUuid", std::string{}) == req.uuid) {
                                is_cart = true;
                                break;
                            }
                        }
                    }
                    publish = true;
                }
            }

            if (publish) {
                // Routing needs no ProjectState lock; apply_ltc_device_routing()
                // takes mutex_ itself, so it must run unlocked.
                engine_.ensure_default_routing();
                apply_ltc_device_routing();
                if (is_cart) {
                    if (auto pi = engine_.find_cue(req.cue_id)) pi->prime(2.0);
                }
                Logger::info("ProjectState: loaded item uuid='{}' cue='{}'",
                             req.uuid, req.cue_id.value);
            }
        } catch (const std::exception& e) {
            {
                std::lock_guard lock{mutex_};
                auto it = item_uuid_to_cue_.find(req.uuid);
                if (it != item_uuid_to_cue_.end() && it->second == req.cue_id) {
                    cues_.erase(req.cue_id.value);
                    item_uuid_to_cue_.erase(it);
                    audio_load_failures_[req.uuid] = {
                        "load_exception", util::path_to_utf8(req.path)};
                }
            }
            Logger::error("ProjectState loader: uuid='{}' threw: {}", req.uuid, e.what());
        } catch (...) {
            {
                std::lock_guard lock{mutex_};
                auto it = item_uuid_to_cue_.find(req.uuid);
                if (it != item_uuid_to_cue_.end() && it->second == req.cue_id) {
                    cues_.erase(req.cue_id.value);
                    item_uuid_to_cue_.erase(it);
                    audio_load_failures_[req.uuid] = {
                        "load_exception", util::path_to_utf8(req.path)};
                }
            }
            Logger::error("ProjectState loader: uuid='{}' threw (unknown).", req.uuid);
        }

        // Release anyone waiting on this specific item (see wait_for_item_load).
        {
            std::lock_guard qlock{loader_mutex_};
            pending_load_uuids_.erase(req.uuid);
        }
        loader_done_cv_.notify_all();
    }
}

void ProjectState::stop_loaders() {
    {
        std::lock_guard qlock{loader_mutex_};
        loaders_stop_ = true;
    }
    loader_cv_.notify_all();
    if (loader_thread_.joinable()) loader_thread_.join();
    // Nothing will ever complete now — release any wait_for_item_load() caller.
    {
        std::lock_guard qlock{loader_mutex_};
        load_queue_.clear();
        pending_load_uuids_.clear();
    }
    loader_done_cv_.notify_all();
}

bool ProjectState::wait_for_item_load(const std::string& uuid,
                                      std::chrono::milliseconds timeout) {
    std::unique_lock qlock{loader_mutex_};
    if (pending_load_uuids_.find(uuid) == pending_load_uuids_.end()) return true;
    Logger::info("ProjectState: waiting for '{}' to finish loading", uuid);
    return loader_done_cv_.wait_for(qlock, timeout, [this, &uuid] {
        return pending_load_uuids_.find(uuid) == pending_load_uuids_.end();
    });
}

void ProjectState::start_async_mirror() {
    // Wait for any prior background mirror to finish before launching a new
    // one — overlapping mirrors against the same engine state would race.
    std::lock_guard mirror_lock{mirror_mutex_};
    if (load_thread_.joinable()) load_thread_.join();

    // Apply the new project's output contract before any decoded cue can
    // become playable; a large project must not inherit the prior ceiling.
    json settings_snap;
    std::uint64_t mirror_generation{};
    {
        std::lock_guard lock{mutex_};
        settings_snap = document_.value("settings", json::object());
        mirror_generation = document_generation_;
    }
    apply_audio_settings(engine_, settings_snap);

    loading_audio_.store(true, std::memory_order_release);
    load_progress_loaded_.store(0, std::memory_order_release);
    load_progress_total_.store(0, std::memory_order_release);

    load_thread_ = std::thread([this, mirror_generation] {
        try {
            // Phase 1: snapshot what we need to load under a brief lock.
            std::unordered_map<std::string, std::filesystem::path> wanted;
            std::unordered_set<std::string> cart_uuids;
            // LTC: per-item settings snapshotted here, device opened between Phase 2/3.
            struct LtcItemSnap { bool enabled; std::string timecode; int fps_index; };
            std::unordered_map<std::string, LtcItemSnap> ltc_snaps;
            std::string ltc_device_name;
            std::unordered_map<std::string, std::filesystem::path> actually_wanted;
            std::size_t unresolved_media = 0;
            {
                std::lock_guard lock{mutex_};
                json& doc = document_;
                audio_load_failures_.clear();
                for_each_item(doc, [&](json& item, const std::string&) {
                    if (item.value("type", std::string{}) != "audio") return;
                    const std::string uuid = item.value("uuid", std::string{});
                    if (uuid.empty()) return;
                    if (item.contains("oneShot") && item["oneShot"].is_object())
                        cart_uuids.insert(uuid);
                    auto path = resolve_media_path(
                        item, doc.value("folderPath", std::string{}));
                    if (!path.empty()) {
                        wanted.emplace(uuid, std::move(path));
                    } else {
                        audio_load_failures_[uuid] = {
                            "missing_media_path", std::string{}};
                        ++unresolved_media;
                    }
                    // Snapshot LTC settings for this item.
                    ltc_snaps[uuid] = LtcItemSnap{
                        item.value("ltcEnabled",        false),
                        item.value("ltcStartTimecode",  std::string{"00:00:00:00"}),
                        item.value("ltcFrameRate",       4),
                    };
                });
                if (doc.contains("cartItems") && doc["cartItems"].is_array()) {
                    for (const auto& c : doc["cartItems"]) {
                        if (c.is_object()) {
                            const std::string u = c.value("itemUuid", std::string{});
                            if (!u.empty()) cart_uuids.insert(u);
                        }
                    }
                }
                // Snapshot the project-level LTC output device name.
                if (doc.contains("settings") && doc["settings"].is_object()) {
                    const auto& s = doc["settings"];
                    if (s.contains("ltcDevice") && s["ltcDevice"].is_string())
                        ltc_device_name = s["ltcDevice"].get<std::string>();
                }

                // Unload missing cues
                for (auto it = item_uuid_to_cue_.begin(); it != item_uuid_to_cue_.end();) {
                    if (wanted.find(it->first) == wanted.end()) {
                        engine_.unload_cue(it->second);
                        cues_.erase(it->second.value);
                        it = item_uuid_to_cue_.erase(it);
                    } else {
                        ++it;
                    }
                }

                // UUID alone is not media identity: a dirty reconnect overlay
                // can retain the UUID while changing mediaPath. Reuse only a
                // decoder whose resolved path still matches the document.
                for (const auto& [uuid, path] : wanted) {
                    auto item_it = item_uuid_to_cue_.find(uuid);
                    bool needs_load = item_it == item_uuid_to_cue_.end();
                    if (!needs_load) {
                        const auto cue_it = cues_.find(item_it->second.value);
                        needs_load = cue_it == cues_.end() ||
                            !detail::same_media_identity(cue_it->second.file_path,
                                                         path);
                        if (needs_load) {
                            engine_.unload_cue(item_it->second);
                            cues_.erase(item_it->second.value);
                            item_uuid_to_cue_.erase(item_it);
                        }
                    }
                    if (needs_load) actually_wanted.emplace(uuid, path);
                }
            }

            // Phase 2: parallel decoder init. NO project mutex — load_cue_no_route
            // only takes the engine's own internal lock. /api/project,
            // /api/cues, /api/project/progress all stay responsive while
            // we're here. The OS file I/O is what dominates anyway.
            load_progress_total_.store(
                actually_wanted.size() + unresolved_media, std::memory_order_release);
            load_progress_loaded_.store(0, std::memory_order_release);

            const unsigned hw = std::thread::hardware_concurrency();
            const std::size_t concurrency = (hw <= 1) ? 1u : static_cast<std::size_t>(hw - 1);
            Logger::info("ProjectState: async-mirroring {} items ({} workers).",
                         actually_wanted.size(), concurrency);

            struct Loaded {
                std::string uuid;
                std::filesystem::path path;
                audio::CueId cue_id;
            };
            std::vector<std::future<Loaded>> in_flight;
            std::vector<Loaded> done;
            done.reserve(actually_wanted.size());
            auto drain_one = [&]() {
                if (in_flight.empty()) return;
                auto loaded = in_flight.front().get();
                in_flight.erase(in_flight.begin());
                if (!loaded.cue_id.empty())
                    load_progress_loaded_.fetch_add(1, std::memory_order_release);
                done.push_back(std::move(loaded));
            };
            for (auto& [uuid, path] : actually_wanted) {
                if (in_flight.size() >= concurrency) drain_one();
                in_flight.push_back(std::async(std::launch::async,
                    [this, u = uuid, p = path]() -> Loaded {
                        return { u, p, engine_.load_cue_no_route(p) };
                    }));
            }
            while (!in_flight.empty()) drain_one();

            // Phase 2.5: ensure the LTC output device is open and has a mixer
            // allocated BEFORE we take the mutex again in Phase 3. Doing it here
            // (no lock held) avoids a deadlock because ensure_device_routing()
            // acquires mutex_ internally.
            {
                bool any_ltc_enabled = false;
                for (auto& [_, ls] : ltc_snaps)
                    if (ls.enabled) { any_ltc_enabled = true; break; }
                if (any_ltc_enabled && !ltc_device_name.empty())
                    ensure_device_routing(ltc_device_name);
            }

            // Phase 3: register results + metadata under lock. Cheap because
            // the heavy I/O is already done — this is just hashtable inserts
            // and a single routing rebuild.
            {
                std::lock_guard lock{mutex_};
                std::unordered_map<std::string, std::filesystem::path>
                    current_wanted;
                if (document_generation_ == mirror_generation) {
                    for_each_item(document_, [&](json& item, const std::string&) {
                        if (item.value("type", std::string{}) != "audio") return;
                        const auto uuid = item.value("uuid", std::string{});
                        if (uuid.empty()) return;
                        const auto path = resolve_media_path(
                            item, document_.value("folderPath", std::string{}));
                        if (!path.empty()) current_wanted.emplace(uuid, path);
                    });
                }

                for (auto& loaded : done) {
                    const auto expected = current_wanted.find(loaded.uuid);
                    const bool identity_matches =
                        expected != current_wanted.end() &&
                        detail::same_media_identity(expected->second, loaded.path);
                    if (!identity_matches) {
                        if (!loaded.cue_id.empty()) engine_.unload_cue(loaded.cue_id);
                        continue;
                    }
                    if (loaded.cue_id.empty()) {
                        audio_load_failures_[loaded.uuid] = {
                            "decoder_init_failed", util::path_to_utf8(loaded.path)};
                        Logger::warn("ProjectState: load failed uuid='{}'",
                                     loaded.uuid);
                        continue;
                    }
                    // A single-item load may have won while this decoder was in
                    // flight. Never overwrite it or leak the losing engine cue.
                    if (item_uuid_to_cue_.find(loaded.uuid) !=
                        item_uuid_to_cue_.end()) {
                        engine_.unload_cue(loaded.cue_id);
                        continue;
                    }
                    audio_load_failures_.erase(loaded.uuid);
                    item_uuid_to_cue_.emplace(loaded.uuid, loaded.cue_id);

                    CueMeta meta;
                    meta.id           = loaded.cue_id;
                    meta.file_path    = loaded.path;
                    const auto md     = meta::read_metadata(loaded.path);
                    meta.display_name = md.title.empty()
                                          ? util::path_to_utf8(loaded.path.filename())
                                          : md.title;
                    meta.artist       = md.artist;
                    meta.title        = md.title;
                    meta.duration_seconds =
                        static_cast<double>(md.duration.count()) / 1000.0;
                    cues_.emplace(loaded.cue_id.value, std::move(meta));
                }

                // Apply per-item audio properties to the engine cues we just
                // registered (including LTC settings).
                for_each_item(document_,
                    [&](json& it, const std::string&) {
                        if (it.value("type", std::string{}) != "audio") return;
                        const std::string uuid = it.value("uuid", std::string{});
                        auto cit = item_uuid_to_cue_.find(uuid);
                        if (cit == item_uuid_to_cue_.end()) return;
                        auto cue = engine_.find_cue(cit->second);
                        if (!cue) return;
                        if (it.contains("volume") && it["volume"].is_number()) {
                            const float lin = it["volume"].get<float>();
                            const float db  = (lin <= 0.0001f) ? -120.0f :
                                                20.0f * std::log10(lin);
                            cue->set_gain_db(db);
                        }
                        if (it.contains("playFade") && it["playFade"].is_number()) {
                            cue->set_fade_in(std::chrono::milliseconds{
                                static_cast<long long>(it["playFade"].get<double>() * 1000.0)});
                        }
                        if (it.contains("fadeOutDuration") && it["fadeOutDuration"].is_number()) {
                            cue->set_fade_out(std::chrono::milliseconds{
                                static_cast<long long>(it["fadeOutDuration"].get<double>() * 1000.0)});
                        }
                        if (it.contains("outPoint") && it["outPoint"].is_number()) {
                            cue->set_out_point_seconds(it["outPoint"].get<double>());
                        }

                        // LTC: configure on the PlaybackItem and route its
                        // synthetic channel to the LTC device mixer (which was
                        // opened in Phase 2.5 and is now in device_routings_).
                        auto ls_it = ltc_snaps.find(uuid);
                        if (ls_it != ltc_snaps.end() && ls_it->second.enabled) {
                            const auto& ls = ls_it->second;
                            const auto offset = parse_smpte_timecode_to_ns(ls.timecode, ls.fps_index);
                            cue->set_ltc_enabled(true);
                            cue->set_ltc_frame_rate(fps_index_to_rate(ls.fps_index));
                            cue->set_ltc_offset(offset);
                            // Persist into CueMeta so /api/cues reflects the setting.
                            auto cm_it = cues_.find(cit->second.value);
                            if (cm_it != cues_.end()) {
                                cm_it->second.ltc_enabled           = true;
                                cm_it->second.ltc_frame_rate_index  = ls.fps_index;
                                cm_it->second.ltc_offset_ns         = offset;
                                cm_it->second.ltc_start_timecode    = ls.timecode;
                            }
                            // Route the LTC synthetic channel to the LTC device mixer.
                            if (!ltc_device_name.empty()) {
                                auto dr_it = device_routings_.find(ltc_device_name);
                                if (dr_it != device_routings_.end()) {
                                    const auto ltc_ch = static_cast<audio::ChannelIndex>(
                                        cue->source_channel_count() - 1);
                                    engine_.route_item_source_to_mixer(
                                        cit->second, ltc_ch, dr_it->second.mixer, 0.0f);
                                }
                            }
                        }
                    });

                // Now that properties like ltc_enabled are applied, establish
                // default routing. This ensures LTC channels aren't mistakenly
                // routed to the Main mixer.
                engine_.ensure_default_routing();
            }

            // Phase 4: prime One Shots / legacy cart cues (also unlocked —
            // engine handles its own).
            std::vector<std::future<void>> prime_futures;
            for (const auto& uuid : cart_uuids) {
                audio::CueId cue;
                {
                    std::lock_guard lock{mutex_};
                    auto it = item_uuid_to_cue_.find(uuid);
                    if (it == item_uuid_to_cue_.end()) continue;
                    cue = it->second;
                }
                prime_futures.push_back(std::async(std::launch::async,
                    [this, cue]() {
                        if (auto pi = engine_.find_cue(cue)) pi->prime(2.0);
                    }));
            }
            for (auto& f : prime_futures) f.get();
            if (!cart_uuids.empty()) {
                Logger::info("ProjectState: primed {} one-shot cue(s).", cart_uuids.size());
            }
        } catch (const std::exception& e) {
            Logger::error("async mirror threw: {}", e.what());
        }
        // Honour the project's default output device: re-pin every non-override
        // cue from Main (the OS default device, where ensure_default_routing()
        // above parked them) to the selected device. Previously this ran only
        // when the user changed the setting, so on load the project's chosen
        // device was ignored until re-selected. (#30)
        apply_default_device_routing();
        loading_audio_.store(false, std::memory_order_release);
    });
}

void ProjectState::reset() {
    std::lock_guard lifecycle_lock{playback_lifecycle_mutex_};
    // Drop queued single-item loads and let any in-flight decode finish before
    // we clear the tables (#43). A load that published after the reset would
    // resurrect a cue belonging to the project we just closed.
    {
        std::unique_lock qlock{loader_mutex_};
        for (const auto& req : load_queue_) pending_load_uuids_.erase(req.uuid);
        load_queue_.clear();
        loader_done_cv_.wait_for(qlock, std::chrono::seconds{20}, [this] {
            return pending_load_uuids_.empty();
        });
    }
    // Release anyone waiting on a load we just cancelled.
    loader_done_cv_.notify_all();

    // Quiesce any in-flight async mirror BEFORE taking mutex_. The mirror
    // worker acquires mutex_ in its phases, so joining it while we held the
    // lock would deadlock. mirror_mutex_ also serialises us against a
    // concurrent start_async_mirror(). Without this, a half-finished mirror
    // would repopulate cues_/item_uuid_to_cue_ right after we clear them and
    // leave dangling engine cues — the source of the crash when the next
    // project is opened.
    {
        std::lock_guard mirror_lock{mirror_mutex_};
        if (load_thread_.joinable()) load_thread_.join();
    }
    loading_audio_.store(false, std::memory_order_release);
    load_progress_loaded_.store(0, std::memory_order_release);
    load_progress_total_.store(0, std::memory_order_release);

    // Drop the sequencer's tracking list so its 50 ms loop stops dereferencing
    // cues we're about to unload (auto-advance / crossfade against a project
    // we've just closed).
    {
        std::lock_guard slock{sequencer_mutex_};
        sequenced_items_.clear();
        playback_generations_.cancel_all();
    }
    next_item_override_.clear(); next_item_override_manual_ = false;
    clear_diagnostic_cues();

    // Project reset is the lifetime boundary for override routing. Preview and
    // Main keep their independent references when they share the device.
    release_device_routings();

    std::lock_guard lock{mutex_};

    // Stop and unload every engine cue. Clearing the bookkeeping maps alone is
    // not enough — the PlaybackItems live in the engine and keep playing until
    // explicitly unloaded, which is why a closed project kept making sound.
    engine_.stop_all();
    for (auto& [_, id] : item_uuid_to_cue_) engine_.unload_cue(id);

    // Tear down any active preview cue too (its decoder outlives the maps).
    if (!preview_cue_.empty()) {
        engine_.stop(preview_cue_);
        engine_.unload_cue(preview_cue_);
        preview_cue_ = {};
    }
    preview_item_uuid_.clear();

    cues_.clear();
    mixers_.clear();
    item_routes_.clear();
    mixer_routes_.clear();
    master_assignments_.clear();
    item_uuid_to_cue_.clear();
    audio_load_failures_.clear();
    // The selection and the trigger-order stamps belong to the project that is
    // going away; carrying them into the next one would leave control surfaces
    // pointing at uuids that no longer exist. Show Mode and the locale are
    // operator preferences, not project data, so they survive the reset.
    selected_item_uuid_.clear();
    item_trigger_seq_.clear();
    project_name_ = "Untitled";
    project_file_path_.clear();
    document_ = default_empty_document();
    ++document_generation_;
    apply_audio_settings(engine_, document_["settings"]);
    apply_to_engine_locked();
}

json ProjectState::default_empty_document() {
    // Mirror the client-side `Project` interface defaults so a fresh server
    // session looks identical to what `createNewProject` would have produced
    // on the client side. Field names are camelCase to match the client.
    return json{
        {"name",          "Untitled"},
        {"version",       "2.0.0"},
        {"folderPath",    ""},
        {"items",         json::array()},
        {"cartItems",     json::array()},
        {"cartSlotKeys",  json::object()},
        {"playbackKeys",  json::object()},
        {"cartOnlyItems", json::array()},
        {"theme",         json{{"mode", "dark"}, {"accentColor", "#315FCF"}}},
        {"settings",      json{
            {"defaultOutputDevice", nullptr},
            {"previewDevice",       nullptr},
            {"ltcDevice",           nullptr},
            {"outputTarget",        "live"},
            {"meterMode",           "dBFS"},
            {"cartSlotCount",       16},
            {"autoTrimSilenceOnImport",    false},
            {"autoMatchLoudnessOnImport",  false},
            {"autoReduceTruePeaksOnImport", true},
            {"cycleTrackColors",            true},
        }},
        {"createdAt",     ""},
        {"lastModified",  ""},
    };
}


// ---------------------------------------------------------------------------
// Document walker — visits every item (audio + group) in the document, depth
// first. Visits the item itself then recurses into group children.
// ---------------------------------------------------------------------------
void ProjectState::for_each_item(json& doc,
                                 const std::function<void(json&, const std::string&)>& visit) {
    std::function<void(json&, const std::string&)> walk;
    walk = [&](json& arr, const std::string& parent_uuid) {
        if (!arr.is_array()) return;
        for (auto& it : arr) {
            if (!it.is_object()) continue;
            visit(it, parent_uuid);
            if (it.value("type", std::string{}) == "group" &&
                it.contains("children") && it["children"].is_array()) {
                walk(it["children"], it.value("uuid", std::string{}));
            }
        }
    };
    if (doc.contains("items") && doc["items"].is_array()) {
        walk(doc["items"], "");
    }
    // cartOnlyItems are flat (no groups inside) but use the same walker for
    // consistency.
    if (doc.contains("cartOnlyItems") && doc["cartOnlyItems"].is_array()) {
        for (auto& it : doc["cartOnlyItems"]) {
            if (it.is_object()) visit(it, "");
        }
    }
}

// ---------------------------------------------------------------------------
// Mirror every audio item in document_ onto the engine + cue tables. Called
// after load and after a full-document replace. Existing engine cues that
// no longer have a matching item are unloaded.
// ---------------------------------------------------------------------------
void ProjectState::mirror_items_to_engine_locked() {
    // Collect uuid → file_path for current document.
    std::unordered_map<std::string, std::filesystem::path> wanted;
    std::unordered_set<std::string> audio_uuids;
    std::unordered_set<std::string> cart_uuids;
    std::size_t unresolved_media = 0;
    for_each_item(document_,
        [&](json& item, const std::string& /*parent*/) {
            if (item.value("type", std::string{}) != "audio") return;
            const std::string uuid = item.value("uuid", std::string{});
            if (uuid.empty()) return;
            audio_uuids.insert(uuid);
            if (item.contains("oneShot") && item["oneShot"].is_object())
                cart_uuids.insert(uuid);

            // Resolve file path: prefer relative folderPath/mediaPath (portable),
            // fall back to the absolute mediaServerPath. See resolve_media_path().
            auto path = resolve_media_path(
                item, document_.value("folderPath", std::string{}));
            if (path.empty()) {
                audio_load_failures_[uuid] = {
                    "missing_media_path", std::string{}};
                ++unresolved_media;
                return;
            }
            wanted.emplace(uuid, std::move(path));
        });

    for (auto it = audio_load_failures_.begin();
         it != audio_load_failures_.end();) {
        if (audio_uuids.find(it->first) == audio_uuids.end())
            it = audio_load_failures_.erase(it);
        else
            ++it;
    }

    // Unload any engine cues whose item is gone.
    for (auto it = item_uuid_to_cue_.begin(); it != item_uuid_to_cue_.end();) {
        if (wanted.find(it->first) == wanted.end()) {
            engine_.unload_cue(it->second);
            cues_.erase(it->second.value);
            it = item_uuid_to_cue_.erase(it);
        } else {
            ++it;
        }
    }

    // Gather the set of cart slot bindings so we can prioritise priming
    // those items (cart cues need to be hot — they can be triggered at any
    // moment by a hotkey or MIDI).
    if (document_.contains("cartItems") && document_["cartItems"].is_array()) {
        for (const auto& c : document_["cartItems"]) {
            if (c.is_object()) {
                const std::string u = c.value("itemUuid", std::string{});
                if (!u.empty()) cart_uuids.insert(u);
            }
        }
    }

    // Build the list of new items to load (skip already-loaded). We do
    // metadata + decoder init in parallel because both are I/O bound.
    struct LoadJob {
        std::string uuid;
        std::filesystem::path path;
    };
    std::vector<LoadJob> jobs;
    for (auto& [uuid, path] : wanted) {
        if (item_uuid_to_cue_.find(uuid) == item_uuid_to_cue_.end()) {
            jobs.push_back({uuid, path});
        } else {
            audio_load_failures_.erase(uuid);
        }
    }

    load_progress_total_.store(jobs.size() + unresolved_media,
                               std::memory_order_release);
    load_progress_loaded_.store(0, std::memory_order_release);
    if (!jobs.empty()) {
        // Use every CPU thread except one (leave one core for the OS/UI). On
        // single-core machines stay at 1; on hardware_concurrency() returning
        // 0 (rare) fall back to 1 as well.
        const unsigned hw = std::thread::hardware_concurrency();
        const std::size_t concurrency = (hw <= 1) ? 1u : static_cast<std::size_t>(hw - 1);
        Logger::info("ProjectState: bulk-loading {} audio items ({} parallel workers).",
                     jobs.size(), concurrency);
        std::vector<std::future<std::pair<std::string, audio::CueId>>> futures;
        futures.reserve(jobs.size());

        // Issue all jobs but cap in-flight concurrency by waiting once we
        // hit the limit. This keeps memory pressure / fd usage bounded for
        // very large projects.
        std::vector<std::pair<std::string, audio::CueId>> done;
        done.reserve(jobs.size());

        auto drain_one = [&]() {
            if (futures.empty()) return;
            auto loaded = futures.front().get();
            futures.erase(futures.begin());
            if (!loaded.second.empty())
                load_progress_loaded_.fetch_add(1, std::memory_order_release);
            done.push_back(std::move(loaded));
        };

        for (const auto& job : jobs) {
            if (futures.size() >= concurrency) drain_one();
            futures.push_back(std::async(std::launch::async,
                [this, job]() -> std::pair<std::string, audio::CueId> {
                    const auto cue_id = engine_.load_cue_no_route(job.path);
                    return {job.uuid, cue_id};
                }));
        }
        while (!futures.empty()) drain_one();

        // Register results sequentially (cues_ access is single-threaded under
        // the lock the caller holds).
        for (auto& [uuid, cue_id] : done) {
            if (cue_id.empty()) {
                audio_load_failures_[uuid] = {
                    "decoder_init_failed", util::path_to_utf8(wanted[uuid])};
                Logger::warn("ProjectState: failed to load item uuid='{}'", uuid);
                continue;
            }
            audio_load_failures_.erase(uuid);
            item_uuid_to_cue_.emplace(uuid, cue_id);

            const auto file_path = wanted[uuid];
            CueMeta meta;
            meta.id           = cue_id;
            meta.file_path    = file_path;
            const auto md     = meta::read_metadata(file_path);
            meta.display_name = md.title.empty()
                                  ? util::path_to_utf8(file_path.filename())
                                  : md.title;
            meta.artist       = md.artist;
            meta.title        = md.title;
            meta.duration_seconds =
                static_cast<double>(md.duration.count()) / 1000.0;
            cues_.emplace(cue_id.value, std::move(meta));
        }

        // Prime cart cues in parallel so their first hit is glitch-free.
        // Non-cart items are primed on-demand at play time.
        std::vector<std::future<void>> prime_futures;
        for (const auto& uuid : cart_uuids) {
            auto it = item_uuid_to_cue_.find(uuid);
            if (it == item_uuid_to_cue_.end()) continue;
            auto pi = engine_.find_cue(it->second);
            if (!pi) continue;
            prime_futures.push_back(std::async(std::launch::async,
                [pi]() { pi->prime(2.0); }));
        }
        for (auto& f : prime_futures) f.get();
        if (!cart_uuids.empty()) {
            Logger::info("ProjectState: primed {} one-shot cue(s).",
                         cart_uuids.size());
        }
    }

    // Apply per-item audio properties (gain/fade/in-out/LTC/etc.) to the engine.
    // NOTE: LTC *device routing* is handled separately in apply_ltc_device_routing()
    // which is called by callers after they release mutex_ (because
    // ensure_device_routing() also needs to acquire mutex_).
    for_each_item(document_,
        [&](json& item, const std::string& /*parent*/) {
            if (item.value("type", std::string{}) != "audio") return;
            const std::string uuid = item.value("uuid", std::string{});
            auto it = item_uuid_to_cue_.find(uuid);
            if (it == item_uuid_to_cue_.end()) return;
            apply_item_properties_locked(item, it->second);
        });

    // Now that every cue is in items_ and properties like ltc_enabled are
    // configured, establish default routing ONCE.
    engine_.ensure_default_routing();
}

// ---------------------------------------------------------------------------
// Push one document item's engine-visible properties onto its PlaybackItem.
// Caller holds mutex_. No-op when the cue isn't in the engine (yet) — that is
// the normal state for an item whose background decode is still in flight; the
// loader calls this again once the cue exists.
// ---------------------------------------------------------------------------
void ProjectState::apply_item_properties_locked(const json& item,
                                                const audio::CueId& cue_id) {
    auto cue = engine_.find_cue(cue_id);
    if (!cue) return;

    // volume: 0..2 linear (matches the client). Engine takes dB.
    if (item.contains("volume") && item["volume"].is_number()) {
        const float lin = item["volume"].get<float>();
        const float db  = (lin <= 0.0001f) ? -120.0f :
                            20.0f * std::log10(lin);
        cue->set_gain_db(db);
    }
    if (item.contains("playFade") && item["playFade"].is_number()) {
        cue->set_fade_in(std::chrono::milliseconds{
            static_cast<long long>(item["playFade"].get<double>() * 1000.0)});
    }
    // Manual-stop fade-out: the UI's "STOP FADE OUT" slider writes to
    // `stopFade`, which is also used by the sequencer to begin fading
    // before natural end. We expose the larger of the two as the
    // PlaybackItem's fade_out_duration so the stop button (and global
    // stop) honour whichever value the user actually configured —
    // without breaking legacy projects that only set fadeOutDuration.
    {
        double stop_fade_sec = 0.0;
        double fade_out_dur  = 0.0;
        if (item.contains("stopFade") && item["stopFade"].is_number())
            stop_fade_sec = item["stopFade"].get<double>();
        if (item.contains("fadeOutDuration") && item["fadeOutDuration"].is_number())
            fade_out_dur = item["fadeOutDuration"].get<double>();
        const double effective = std::max(stop_fade_sec, fade_out_dur);
        cue->set_fade_out(std::chrono::milliseconds{
            static_cast<long long>(effective * 1000.0)});
    }
    // outPoint: when set (> 0), engine fades out as the playhead reaches
    // that time instead of running to the file end.
    if (item.contains("outPoint") && item["outPoint"].is_number()) {
        cue->set_out_point_seconds(item["outPoint"].get<double>());
    } else {
        cue->set_out_point_seconds(0.0);  // disabled
    }

    // LTC: configure enabled/rate/offset on the PlaybackItem.
    // Routing of the synthetic LTC channel to the ltcDevice is done by the
    // caller after it releases mutex_ (via apply_ltc_device_routing()).
    const bool ltc_on = item.value("ltcEnabled", false);
    const std::string tc_str = item.value("ltcStartTimecode",
                                           std::string{"00:00:00:00"});
    const int fps_idx = item.value("ltcFrameRate", 4);
    cue->set_ltc_enabled(ltc_on);
    if (ltc_on) {
        const auto offset = parse_smpte_timecode_to_ns(tc_str, fps_idx);
        cue->set_ltc_frame_rate(fps_index_to_rate(fps_idx));
        cue->set_ltc_offset(offset);
        auto cm_it = cues_.find(cue_id.value);
        if (cm_it != cues_.end()) {
            cm_it->second.ltc_enabled          = true;
            cm_it->second.ltc_frame_rate_index = fps_idx;
            cm_it->second.ltc_offset_ns        = offset;
            cm_it->second.ltc_start_timecode   = tc_str;
        }
    }
}

// ---------------------------------------------------------------------------
// Cue mutations (control thread)
// ---------------------------------------------------------------------------
audio::CueId ProjectState::add_cue_from_file(const std::filesystem::path& file,
                                             std::string display_name) {
    // De-dupe: if a cue is already loaded for this file path (typical case
    // is the project mirror loading every item up front), reuse it instead
    // of creating a parallel engine cue. Without this, the legacy
    // ServerHowl path creates a *second* cue for every project item, and
    // play(cue_id) on that orphan bypasses ProjectState::play_item — which
    // is what carries duckingBehavior / inPoint / fades / endBehavior into
    // the engine. The user-visible symptom is in/out points and Up Next
    // not firing.
    {
        std::error_code ec;
        const auto canonical = std::filesystem::weakly_canonical(file, ec);
        const auto& want = ec ? file : canonical;
        std::lock_guard lock{mutex_};
        for (auto& [id, c] : cues_) {
            std::error_code ec2;
            const auto have = std::filesystem::weakly_canonical(c.file_path, ec2);
            const auto& cmp = ec2 ? c.file_path : have;
            if (cmp == want) return audio::CueId{id};
        }
    }
    const auto cue_id = engine_.load_cue(file);
    if (cue_id.empty()) return {};

    // Populate artist/title/duration via TagLib (best-effort; never fatal).
    const auto md = meta::read_metadata(file);

    std::lock_guard lock{mutex_};
    CueMeta meta;
    meta.id           = cue_id;
    meta.display_name = display_name.empty()
                          ? (md.title.empty() ? util::path_to_utf8(file.filename()) : md.title)
                          : std::move(display_name);
    meta.file_path    = file;
    meta.artist       = md.artist;
    meta.title        = md.title;
    meta.duration_seconds = static_cast<double>(md.duration.count()) / 1000.0;
    cues_.emplace(cue_id.value, std::move(meta));
    return cue_id;
}

DiagnosticCueResult ProjectState::add_av_sync_diagnostic_cue(
    const std::filesystem::path& file,
    const std::string& output_device_id,
    std::filesystem::path owned_file) {
    std::lock_guard lifecycle_lock{playback_lifecycle_mutex_};

    const std::string requested_device =
        output_device_id.empty() ? "default" : output_device_id;
    std::string route_device_name;
    std::string route_key;
    std::optional<audio::DeviceId> required_open_device;
    bool use_os_default = false;

    if (requested_device == "default") {
        {
            std::lock_guard lock{mutex_};
            if (document_.contains("settings")) {
                const auto& settings = document_["settings"];
                if (settings.contains("defaultOutputDevice") &&
                    settings["defaultOutputDevice"].is_string()) {
                    route_device_name = settings["defaultOutputDevice"].get<std::string>();
                }
            }
        }
        use_os_default = route_device_name.empty();
        if (!use_os_default) {
            for (const auto& device : engine_.enumerate_devices()) {
                if (device.is_open && device.id.value == route_device_name) {
                    required_open_device = device.id;
                    route_device_name = device.display_name;
                    route_key = "opened:" + device.id.value;
                    break;
                }
            }
            if (route_key.empty()) route_key = route_device_name;
        }
    } else {
        const auto devices = engine_.enumerate_devices();
        for (const auto& device : devices) {
            if (device.is_open && device.id.value == requested_device) {
                required_open_device = device.id;
                route_device_name = device.display_name;
                route_key = "opened:" + device.id.value;
                break;
            }
        }
        if (!required_open_device) {
            for (const auto& device : devices) {
                if (device.display_name != requested_device) continue;
                route_device_name = device.display_name;
                route_key = device.display_name;
                if (device.is_open) {
                    required_open_device = device.id;
                    route_key = "opened:" + device.id.value;
                    break;
                }
            }
        }
        if (route_device_name.empty()) {
            return {{},
                    "output_device_id must exactly match a known device name or opened device id"};
        }
    }

    audio::CueId cue_id;
    try {
        cue_id = engine_.load_cue_no_route(file);
        if (cue_id.empty()) return {{}, "file could not be decoded"};

        const auto cue = engine_.find_cue(cue_id);
        if (!cue) {
            engine_.unload_cue(cue_id);
            return {{}, "file could not be decoded"};
        }
        cue->set_out_point_seconds(0.0);
        cue->set_loop(true, 0.0);
        if (!cue->prime(2.0, 0.0)) {
            engine_.unload_cue(cue_id);
            return {{}, "file could not be primed"};
        }

        if (use_os_default) {
            engine_.ensure_default_routing_for_cue(cue_id);
        } else {
            const auto mixer = ensure_device_routing_impl(
                route_key, route_device_name, required_open_device);
            if (mixer.empty()) {
                engine_.unload_cue(cue_id);
                return {{}, "output device could not be routed"};
            }
            route_cue_to_mixer(cue_id, mixer);
        }

        const auto md = meta::read_metadata(file);
        CueMeta cue_meta;
        cue_meta.id = cue_id;
        cue_meta.display_name = "AV Sync Diagnostic";
        cue_meta.file_path = file;
        cue_meta.artist = md.artist;
        cue_meta.title = md.title;
        cue_meta.duration_seconds = static_cast<double>(md.duration.count()) / 1000.0;

        {
            std::lock_guard lock{mutex_};
            cues_.emplace(cue_id.value, std::move(cue_meta));
            diagnostic_cues_.emplace(cue_id.value, std::move(owned_file));
        }
        return {cue_id, {}};
    } catch (const std::exception& e) {
        if (!cue_id.empty()) engine_.unload_cue(cue_id);
        return {{}, e.what()};
    } catch (...) {
        if (!cue_id.empty()) engine_.unload_cue(cue_id);
        return {{}, "diagnostic cue setup failed"};
    }
}

void ProjectState::remove_cue(const audio::CueId& id) {
    std::filesystem::path owned_file;
    {
        std::lock_guard lock{mutex_};
        // Project item cues remain shared and cannot be removed through the
        // legacy cue endpoint.
        for (const auto& [_, cue_id] : item_uuid_to_cue_) {
            if (cue_id.value == id.value) return;
        }
        const auto diagnostic = diagnostic_cues_.find(id.value);
        if (diagnostic != diagnostic_cues_.end()) {
            owned_file = std::move(diagnostic->second);
            diagnostic_cues_.erase(diagnostic);
        }
    }

    engine_.unload_cue(id);
    {
        std::lock_guard lock{mutex_};
        cues_.erase(id.value);
    }
    if (!owned_file.empty()) {
        std::error_code ec;
        std::filesystem::remove(owned_file, ec);
    }
}

void ProjectState::clear_diagnostic_cues() noexcept {
    decltype(diagnostic_cues_) diagnostics;
    {
        std::lock_guard lock{mutex_};
        diagnostic_cues_.swap(diagnostics);
        for (const auto& [id, _] : diagnostics) cues_.erase(id);
    }

    for (const auto& [id, owned_file] : diagnostics) {
        try {
            const audio::CueId cue_id{id};
            engine_.stop(cue_id);
            engine_.unload_cue(cue_id);
        } catch (...) {
            Logger::warn("Failed to unload diagnostic cue '{}' during cleanup", id);
        }
        if (!owned_file.empty()) {
            std::error_code ec;
            std::filesystem::remove(owned_file, ec);
        }
    }
}
void ProjectState::rename_cue(const audio::CueId& id, std::string new_name) {
    std::lock_guard lock{mutex_};
    auto it = cues_.find(id.value);
    if (it == cues_.end()) return;
    it->second.display_name = std::move(new_name);
}

void ProjectState::set_cue_gain_db(const audio::CueId& id, float db) {
    if (auto item = engine_.find_cue(id)) item->set_gain_db(db);
    std::lock_guard lock{mutex_};
    auto it = cues_.find(id.value);
    if (it != cues_.end()) it->second.gain_db = db;
}

void ProjectState::set_cue_fade_in(const audio::CueId& id, std::chrono::milliseconds d) {
    if (auto item = engine_.find_cue(id)) item->set_fade_in(d);
    std::lock_guard lock{mutex_};
    auto it = cues_.find(id.value);
    if (it != cues_.end()) it->second.fade_in_ms = d;
}

void ProjectState::set_cue_fade_out(const audio::CueId& id, std::chrono::milliseconds d) {
    if (auto item = engine_.find_cue(id)) item->set_fade_out(d);
    std::lock_guard lock{mutex_};
    auto it = cues_.find(id.value);
    if (it != cues_.end()) it->second.fade_out_ms = d;
}

void ProjectState::set_cue_ltc(const audio::CueId& id, bool enabled, int fps_index,
                                std::chrono::nanoseconds offset) {
    if (auto item = engine_.find_cue(id)) {
        item->set_ltc_enabled(enabled);
        item->set_ltc_frame_rate(fps_index_to_rate(fps_index));
        item->set_ltc_offset(offset);
    }
    std::lock_guard lock{mutex_};
    auto it = cues_.find(id.value);
    if (it == cues_.end()) return;
    it->second.ltc_enabled = enabled;
    it->second.ltc_frame_rate_index = fps_index;
    it->second.ltc_offset_ns = offset;
}

// ---------------------------------------------------------------------------
// LTC device routing — called from outside the mutex so ensure_device_routing
// (which acquires the mutex itself) can safely do its work.
// ---------------------------------------------------------------------------
void ProjectState::apply_ltc_device_routing() {
    // 1. Under a brief lock, gather: the configured LTC device name and the
    //    list of LTC-enabled cues with their LTC channel index.
    std::string ltc_device;
    std::vector<std::pair<audio::CueId, audio::ChannelIndex>> ltc_routes;
    {
        std::lock_guard lock{mutex_};
        if (document_.contains("settings") && document_["settings"].is_object()) {
            const auto& s = document_["settings"];
            if (s.contains("ltcDevice") && s["ltcDevice"].is_string())
                ltc_device = s["ltcDevice"].get<std::string>();
        }
        if (!ltc_device.empty()) {
            for (auto& [uuid, cue_id] : item_uuid_to_cue_) {
                auto pi = engine_.find_cue(cue_id);
                if (!pi || !pi->desc().ltc_enabled) continue;
                // The LTC synthetic channel is always the last source channel.
                const auto ltc_ch = static_cast<audio::ChannelIndex>(
                    pi->source_channel_count() - 1);
                ltc_routes.push_back({cue_id, ltc_ch});
            }
        }
    }

    if (ltc_device.empty() || ltc_routes.empty()) return;

    // 2. Ensure the LTC device is open and has a mixer (acquires/releases mutex
    //    internally — safe because we're not holding mutex_ here).
    const auto ltc_mixer = ensure_device_routing(ltc_device);
    if (ltc_mixer.empty()) return;

    // 3. Route each LTC channel to the LTC device mixer (engine ops; no mutex
    //    needed — the engine has its own independent synchronisation).
    for (auto& [cue_id, ltc_ch] : ltc_routes)
        engine_.route_item_source_to_mixer(cue_id, ltc_ch, ltc_mixer, 0.0f);
}

// ---------------------------------------------------------------------------
// Default output device routing — re-route all cues that have no per-item
// deviceOverride to the newly selected defaultOutputDevice. Called from
// patch_settings() whenever that key changes. Pattern mirrors
// apply_ltc_device_routing(): gather data under lock, then do engine ops
// outside the lock so ensure_device_routing() can safely acquire mutex_.
// ---------------------------------------------------------------------------
void ProjectState::apply_default_device_routing() {
    std::string device_name;
    std::vector<audio::CueId> non_override_cues;
    {
        std::lock_guard lock{mutex_};
        if (document_.contains("settings") && document_["settings"].is_object()) {
            const auto& s = document_["settings"];
            if (s.contains("defaultOutputDevice") && s["defaultOutputDevice"].is_string())
                device_name = s["defaultOutputDevice"].get<std::string>();
        }
        if (!device_name.empty()) {
            for_each_item(document_,
                [&](json& item, const std::string&) {
                    const std::string uuid = item.value("uuid", std::string{});
                    if (uuid.empty()) return;
                    // Skip items with a per-item device override.
                    if (item.contains("deviceOverride") &&
                        item["deviceOverride"].is_string() &&
                        !item["deviceOverride"].get<std::string>().empty()) return;
                    auto it = item_uuid_to_cue_.find(uuid);
                    if (it != item_uuid_to_cue_.end())
                        non_override_cues.push_back(it->second);
                });
        }
    }
    if (device_name.empty() || non_override_cues.empty()) return;

    const auto mixer = ensure_device_routing(device_name);
    if (mixer.empty()) return;

    for (const auto& cue_id : non_override_cues)
        route_cue_to_mixer(cue_id, mixer);

    // route_cue_to_mixer() clears every source route (incl. the LTC synthetic
    // channel), so re-establish LTC device routing for any LTC-enabled cues we
    // just re-pinned to the default device.
    apply_ltc_device_routing();

    Logger::info("apply_default_device_routing: routed {} cue(s) to '{}'",
                 non_override_cues.size(), device_name);
}

// ---------------------------------------------------------------------------
// Preview device change — tear down any active preview so the next call to
// start_preview() opens a fresh connection to the newly selected device.
// ---------------------------------------------------------------------------
void ProjectState::apply_preview_device_change() {
    audio::CueId prev_cue;
    {
        std::lock_guard lock{mutex_};
        prev_cue = preview_cue_;
        preview_cue_ = audio::CueId{};
        preview_item_uuid_.clear();
        preview_device_name_.clear();
    }
    if (!prev_cue.empty()) {
        engine_.stop(prev_cue);
        engine_.unload_cue(prev_cue);
    }
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------
std::vector<CueMeta> ProjectState::list_cues() const {
    std::lock_guard lock{mutex_};
    std::vector<CueMeta> out;
    out.reserve(cues_.size());
    for (auto& [_, c] : cues_) out.push_back(c);
    return out;
}

std::optional<CueMeta> ProjectState::find_cue(const audio::CueId& id) const {
    std::lock_guard lock{mutex_};
    auto it = cues_.find(id.value);
    if (it == cues_.end()) return std::nullopt;
    return it->second;
}

std::vector<MixerChannelMeta> ProjectState::list_mixer_channels() const {
    std::lock_guard lock{mutex_};
    std::vector<MixerChannelMeta> out;
    out.reserve(mixers_.size());
    for (auto& [_, m] : mixers_) out.push_back(m);
    return out;
}

std::filesystem::path ProjectState::media_root() const {
    std::lock_guard lock{mutex_};
    return media_root_;
}

void ProjectState::set_media_root(std::filesystem::path p) {
    std::lock_guard lock{mutex_};
    media_root_ = std::move(p);
}

void ProjectState::update_media_root_from_folder_locked() {
    // The project folder is the single source of truth for where media lives.
    // Anchoring media_root_ to "<folderPath>/media" is what makes uploads and
    // server-side copies land inside the project folder (portable) instead of
    // the server's working directory — the old default that left imports
    // stranded where playback couldn't find them (PLAY: ?).
    const std::string folder = document_.value("folderPath", std::string{});
    if (folder.empty()) return;
    media_root_ = util::utf8_to_path(folder) / "media";
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
json ProjectState::to_json() const {
    std::lock_guard lock{mutex_};
    json j;
    j["schema_version"] = 2;
    j["project_name"]   = project_name_;
    j["media_root"]     = util::path_to_utf8(media_root_);

    json cues_arr = json::array();
    for (auto& [_, c] : cues_) cues_arr.push_back(c);
    j["cues"] = std::move(cues_arr);

    json mixers_arr = json::array();
    for (auto& [_, m] : mixers_) mixers_arr.push_back(m);
    j["mixer_channels"] = std::move(mixers_arr);

    j["item_routes"]    = item_routes_;
    j["mixer_routes"]   = mixer_routes_;
    j["master_assignments"] = master_assignments_;
    return j;
}

bool ProjectState::save(const std::filesystem::path& path) const {
    if (!project_file::is_native_project(path)) {
        Logger::error("ProjectState::save: project path must use .dwcue: '{}'",
                      util::path_to_utf8(path));
        return false;
    }
    // Persist the full client-shaped document — this is what the Electron
    // client expects to read back. Server-only tables (mixer routing,
    // engine state) live on the side and don't get written to disk here;
    // they're rebuilt from the document on next load.
    try {
        json doc;
        {
            std::lock_guard lock{mutex_};
            doc = document_;
            doc["lastModified"] = now_iso();
        }
        // Persist media as relative paths whenever it lives in the project
        // folder, so the saved file stays portable across moves. Covers items
        // imported this session (which carry an absolute mediaServerPath).
        relativize_media_paths(doc);

        // Atomic write: serialise to a sibling temp file, verify the stream is
        // healthy, then rename it over the target. A write error, disk-full, or
        // crash therefore never truncates or corrupts the previous good file —
        // the documented "preserve previous state on failure" contract. (#5)
        std::filesystem::path tmp = path;
        tmp += ".tmp";
        {
            std::ofstream f{tmp, std::ios::binary | std::ios::trunc};
            if (!f) {
                Logger::error("ProjectState::save: cannot open '{}' for writing",
                              util::path_to_utf8(tmp));
                return false;
            }
            f << doc.dump(2);
            f.flush();
            f.close();
            if (!f.good()) {
                Logger::error("ProjectState::save: failed writing '{}' — "
                              "previous file left untouched",
                              util::path_to_utf8(tmp));
                std::error_code rm_ec;
                std::filesystem::remove(tmp, rm_ec);
                return false;
            }
        }

        std::error_code ec;
        if (!util::replace_file_atomically(tmp, path, ec)) {
            Logger::error("ProjectState::save: rename '{}' -> '{}' failed: {} — "
                          "previous file left untouched",
                          util::path_to_utf8(tmp), util::path_to_utf8(path),
                          ec.message());
            std::error_code rm_ec;
            std::filesystem::remove(tmp, rm_ec);
            return false;
        }
        return true;
    } catch (const std::exception& ex) {
        Logger::error("ProjectState::save failed: {}", ex.what());
        return false;
    }
}

// ---------------------------------------------------------------------------
// Full-document accessors
// ---------------------------------------------------------------------------
namespace {
// Walk an items array (or a group's children) and decorate each audio
// item with its engine cueId. Recurses into groups. Caller holds the
// project mutex.
void annotate_items_with_cue_ids(
    json& arr,
    const std::unordered_map<std::string, audio::CueId>& item_uuid_to_cue) {
    if (!arr.is_array()) return;
    for (auto& it : arr) {
        if (!it.is_object()) continue;
        const std::string uuid = it.value("uuid", std::string{});
        if (it.value("type", std::string{}) == "audio") {
            auto found = item_uuid_to_cue.find(uuid);
            if (found != item_uuid_to_cue.end()) {
                it["cueId"] = found->second.value;
            }
        } else if (it.value("type", std::string{}) == "group" &&
                   it.contains("children")) {
            annotate_items_with_cue_ids(it["children"], item_uuid_to_cue);
        }
    }
}
} // namespace

json ProjectState::full_document() const {
    std::lock_guard lock{mutex_};
    json out = document_;
    if (out.contains("items"))         annotate_items_with_cue_ids(out["items"],         item_uuid_to_cue_);
    if (out.contains("cartOnlyItems")) annotate_items_with_cue_ids(out["cartOnlyItems"], item_uuid_to_cue_);
    // Inject computed output-target levels so the client never needs to
    // hardcode platform loudness values.
    if (!out.contains("settings") || !out["settings"].is_object())
        out["settings"] = json::object();
    out["settings"]["outputTargetLevels"] = compute_output_target_levels(out["settings"]);

    // Attach a minimal "server" block so the client can read project file
    // path, available engine cues, etc. without a separate fetch.
    out["server"] = json{
        {"projectFilePath", util::path_to_utf8(project_file_path_)},
        {"mediaRoot",       util::path_to_utf8(media_root_)},
        {"audioLoading",    loading_audio_.load(std::memory_order_acquire)},
        {"audioLoaded",     load_progress_loaded_.load(std::memory_order_acquire)},
        {"audioTotal",      load_progress_total_.load(std::memory_order_acquire)},
        {"audioReadiness",  audio_readiness_locked()},
    };
    return out;
}

json ProjectState::audio_readiness_locked() const {
    std::vector<std::string> uuids;
    uuids.reserve(audio_load_failures_.size());
    for (const auto& [uuid, _] : audio_load_failures_) uuids.push_back(uuid);
    std::sort(uuids.begin(), uuids.end());

    json failures = json::array();
    for (const auto& uuid : uuids) {
        const auto& failure = audio_load_failures_.at(uuid);
        failures.push_back(json{
            {"itemUuid", uuid},
            {"code",     failure.code},
            {"path",     failure.path},
        });
    }

    std::size_t pending_count = 0;
    {
        std::lock_guard qlock{loader_mutex_};
        pending_count = pending_load_uuids_.size();
    }
    const bool loading =
        loading_audio_.load(std::memory_order_acquire) || pending_count > 0;
    return json{
        {"ready",       !loading && failures.empty()},
        {"loading",     loading},
        {"loaded",      load_progress_loaded_.load(std::memory_order_acquire)},
        {"total",       load_progress_total_.load(std::memory_order_acquire)},
        {"pendingCount", pending_count},
        {"failedCount", failures.size()},
        {"failures",    std::move(failures)},
    };
}

json ProjectState::audio_readiness() const {
    std::lock_guard lock{mutex_};
    return audio_readiness_locked();
}

json ProjectState::header_document() const {
    std::lock_guard lock{mutex_};
    // Cart-only items carry waveform data is already lazy, but the array
    // itself is small relative to the full playlist. We DO include it
    // because the cart slots reference these items and the workspace
    // can't paint cart buttons without them.
    json cart_only = document_.value("cartOnlyItems", json::array());
    annotate_items_with_cue_ids(cart_only, item_uuid_to_cue_);

    const auto& items = document_.value("items", json::array());
    const std::size_t item_count = items.is_array() ? items.size() : 0;

    // Inject computed output-target levels into the settings copy we send to the
    // client so it never has to hardcode platform loudness standards.
    json settings_out = document_.value("settings", json::object());
    settings_out["outputTargetLevels"] = compute_output_target_levels(settings_out);

    return json{
        {"name",         document_.value("name", "")},
        {"version",      document_.value("version", "")},
        {"folderPath",   document_.value("folderPath", "")},
        {"createdAt",    document_.value("createdAt", "")},
        {"lastModified", read_last_modified(document_)},
        {"theme",        document_.value("theme",         json::object())},
        {"settings",     std::move(settings_out)},
        {"cartItems",    document_.value("cartItems",     json::array())},
        {"cartSlotKeys", document_.value("cartSlotKeys",  json::object())},
        {"playbackKeys", document_.value("playbackKeys",  json::object())},
        {"cartOnlyItems", std::move(cart_only)},
        {"itemCount",    item_count},
        // "Open" means a real project landed — either it has items or it
        // was loaded/saved from disk. A fresh server has a default name
        // "Untitled" but no file path and no items, so the welcome screen
        // should still show New/Open.
        {"hasOpenProject", item_count > 0 ||
                           !project_file_path_.empty()},
        {"server", json{
            {"projectFilePath", util::path_to_utf8(project_file_path_)},
            {"mediaRoot",       util::path_to_utf8(media_root_)},
            {"audioLoading",    loading_audio_.load(std::memory_order_acquire)},
            {"audioLoaded",     load_progress_loaded_.load(std::memory_order_acquire)},
            {"audioTotal",      load_progress_total_.load(std::memory_order_acquire)},
            {"audioReadiness",  audio_readiness_locked()},
        }},
    };
}

json ProjectState::items_page(std::size_t offset, std::size_t limit) const {
    std::lock_guard lock{mutex_};
    const auto& items = document_.value("items", json::array());
    const std::size_t total = items.is_array() ? items.size() : 0;
    if (offset > total) offset = total;
    const std::size_t end = (limit > total - offset) ? total : offset + limit;

    json page = json::array();
    if (items.is_array()) {
        for (std::size_t i = offset; i < end; ++i) {
            page.push_back(items[i]);
        }
    }
    annotate_items_with_cue_ids(page, item_uuid_to_cue_);

    return json{
        {"offset", offset},
        {"limit",  limit},
        {"total",  total},
        {"items",  std::move(page)},
    };
}

bool ProjectState::replace_full_document(const json& doc) {
    if (!doc.is_object()) return false;
    json migrated = doc;
    const bool cart_migrated = core::migrate_legacy_cart_to_one_shots(migrated);
    if (cart_migrated)
        Logger::info("ProjectState: migrated legacy Cart data to One Shots.");
    std::lock_guard lifecycle_lock{playback_lifecycle_mutex_};
    std::unordered_set<std::string> invalidated_playbacks;
    std::vector<DuckedEntry> invalidated_ducks;
    {
        std::lock_guard lock{mutex_};
        const auto collect_media = [](json& candidate) {
            std::unordered_map<std::string, std::filesystem::path> paths;
            const auto folder = candidate.value("folderPath", std::string{});
            for_each_item(candidate, [&](json& item, const std::string&) {
                if (item.value("type", std::string{}) != "audio") return;
                const auto uuid = item.value("uuid", std::string{});
                if (!uuid.empty())
                    paths.emplace(uuid, resolve_media_path(item, folder));
            });
            return paths;
        };
        const auto old_media = collect_media(document_);
        const auto new_media = collect_media(migrated);
        for (const auto& [uuid, old_path] : old_media) {
            const auto replacement = new_media.find(uuid);
            if (replacement == new_media.end() ||
                !detail::same_media_identity(old_path, replacement->second)) {
                invalidated_playbacks.insert(uuid);
            }
        }
        document_ = std::move(migrated);
        ++document_generation_;
        if (!document_.contains("settings")) {
            document_["settings"] = json{
                {"defaultOutputDevice", nullptr},
                {"previewDevice",       nullptr},
                {"ltcDevice",           nullptr},
            };
        }
        if (!document_.contains("theme")) {
            document_["theme"] = json{{"mode", "dark"}, {"accentColor", "#315FCF"}};
        }
        project_name_ = document_.value("name", std::string{"Untitled"});
        update_media_root_from_folder_locked();
    }
    if (!invalidated_playbacks.empty()) {
        std::lock_guard slock{sequencer_mutex_};
        for (const auto& uuid : invalidated_playbacks)
            playback_generations_.cancel(uuid);
        for (auto it = sequenced_items_.begin();
             it != sequenced_items_.end();) {
            if (!invalidated_playbacks.contains(it->uuid)) {
                ++it;
                continue;
            }
            invalidated_ducks.insert(invalidated_ducks.end(),
                                     it->ducked.begin(), it->ducked.end());
            it = sequenced_items_.erase(it);
        }
    }
    for (const auto& entry : invalidated_ducks) {
        if (auto cue = engine_.find_cue(entry.cue_id))
            cue->set_gain_db(entry.original_gain_db);
    }
    // Kick off the engine mirror asynchronously — matches load_from_json's
    // path so the PUT /api/project/document handler doesn't block on cue
    // decode for large projects. start_async_mirror() takes mutex_ itself,
    // so it must run after the lock above is released.
    start_async_mirror();
    // Route LTC channels to the LTC device (also acquires mutex_ internally).
    apply_ltc_device_routing();
    return true;
}

std::filesystem::path ProjectState::project_file_path() const {
    std::lock_guard lock{mutex_};
    return project_file_path_;
}
void ProjectState::set_project_file_path(std::filesystem::path p) {
    std::lock_guard lock{mutex_};
    project_file_path_ = std::move(p);
}

ProjectState::PlaybackSnapshot ProjectState::current_playback_snapshot() const {
    PlaybackSnapshot snap;
    std::lock_guard lock{mutex_};
    snap.project_file = util::path_to_utf8(project_file_path_);
    for (auto& [uuid, cue_id] : item_uuid_to_cue_) {
        auto pi = engine_.find_cue(cue_id);
        if (!pi) continue;
        const auto st = pi->stats();
        if (st.transport == audio::TransportState::Playing ||
            st.transport == audio::TransportState::FadingIn) {
            snap.item_uuid    = uuid;
            snap.position_sec = st.playhead_seconds;
            break;
        }
    }
    return snap;
}

// ---------------------------------------------------------------------------
// Item CRUD — operates on the document_ tree and mirrors audio items to
// the engine.
// ---------------------------------------------------------------------------
audio::CueId ProjectState::add_item(const json& item, const std::string& parent_uuid,
                                    bool cart_only) {
    if (!item.is_object()) return {};
    const std::string uuid = item.value("uuid", std::string{});
    if (uuid.empty()) return {};

    audio::CueId result;
    {
        std::lock_guard lock{mutex_};

        // Reject duplicates — the same UUID must not appear twice in the document.
        bool already_exists = false;
        for_each_item(document_, [&](json& it, const std::string&) {
            if (it.value("uuid", std::string{}) == uuid) already_exists = true;
        });
        if (already_exists) {
            Logger::warn("add_item: uuid '{}' already exists, ignoring duplicate", uuid);
            auto it = item_uuid_to_cue_.find(uuid);
            return it != item_uuid_to_cue_.end() ? it->second : audio::CueId{};
        }

        if (cart_only) {
            // Cart-bound cue: lives in the separate cartOnlyItems array so it
            // is mirrored to the engine (cart hotkeys can trigger it) without
            // ever appearing in the playlist tree.
            if (!document_.contains("cartOnlyItems") ||
                !document_["cartOnlyItems"].is_array()) {
                document_["cartOnlyItems"] = json::array();
            }
            document_["cartOnlyItems"].push_back(item);
        } else if (parent_uuid.empty()) {
            if (!document_.contains("items") || !document_["items"].is_array()) {
                document_["items"] = json::array();
            }
            document_["items"].push_back(item);
        } else {
            // Find the parent group and append.
            bool found = false;
            for_each_item(document_,
                [&](json& it, const std::string& /*parent*/) {
                    if (found) return;
                    if (it.value("uuid", std::string{}) == parent_uuid &&
                        it.value("type", std::string{}) == "group") {
                        if (!it.contains("children") || !it["children"].is_array()) {
                            it["children"] = json::array();
                        }
                        it["children"].push_back(item);
                        found = true;
                    }
                });
            if (!found) {
                Logger::warn("add_item: parent_uuid '{}' not found, appending to root",
                             parent_uuid);
                document_["items"].push_back(item);
            }
        }
        // Queue the audio load(s) for what we just inserted instead of decoding
        // inline: mirror_items_to_engine_locked() decodes while holding mutex_,
        // so adding one big or network-mounted file stalled every other request
        // for the whole decode (#43). Walking the document (rather than just the
        // new node) covers a group's children too, and picks up any earlier item
        // that still has no cue — the same set the mirror would have loaded.
        for_each_item(document_, [&](json& it, const std::string&) {
            if (it.value("type", std::string{}) != "audio") return;
            const std::string u = it.value("uuid", std::string{});
            if (u.empty()) return;
            if (item_uuid_to_cue_.find(u) != item_uuid_to_cue_.end()) return;
            auto path = resolve_media_path(
                it, document_.value("folderPath", std::string{}));
            begin_item_load_locked(u, path, it);
        });
        auto it = item_uuid_to_cue_.find(uuid);
        if (it != item_uuid_to_cue_.end()) result = it->second;
    }
    // Route any LTC-enabled items to the LTC device (after releasing mutex_).
    // The loader repeats this once the decode lands — this call covers items
    // that were already loaded.
    apply_ltc_device_routing();
    return result;
}

bool ProjectState::update_item(const std::string& uuid, const json& patch) {
    if (!patch.is_object()) return false;
    std::lock_guard lifecycle_lock{playback_lifecycle_mutex_};
    std::vector<DuckedEntry> media_swap_ducks;
    bool touched            = false;
    bool media_path_changed = false;
    bool ltc_changed        = false;
    json* updated_item = nullptr;

    // Captured under mutex_, applied to the engine loop state and the sequencer
    // snapshot AFTER the lock is released — so out point / crossfade / stop-fade /
    // end-behaviour edits take effect on an already-playing cue without a replay,
    // mirroring how the engine's raw out-point already updates live.
    bool         have_seq_cue     = false;
    audio::CueId seq_cue;
    double       seq_in_point     = 0.0;
    double       seq_out_point    = 0.0;
    double       seq_crossfade    = 0.0;
    double       seq_stop_fade    = 0.0;
    double       seq_file_duration = 0.0;
    bool         seq_sn_enabled   = false;
    double       seq_sn_time      = 0.0;
    bool         seq_sn_fade_out  = false;
    double       seq_fade_out_dur = 1.0;
    std::string  seq_end_action;
    bool media_identity_will_change = false;
    {
        std::lock_guard lock{mutex_};
        for_each_item(document_, [&](json& item, const std::string&) {
            if (item.value("uuid", std::string{}) != uuid) return;
            for (const auto& [key, value] : patch.items()) {
                if (key != "mediaPath" && key != "mediaServerPath" &&
                    key != "mediaFileName") continue;
                if (!item.contains(key) || item[key] != value)
                    media_identity_will_change = true;
            }
        });
    }
    if (media_identity_will_change) {
        // Canonical lifecycle -> sequencer ordering. The document/engine
        // mutation below cannot expose the replacement to an old action.
        std::lock_guard slock{sequencer_mutex_};
        playback_generations_.cancel(uuid);
        for (auto it = sequenced_items_.begin();
             it != sequenced_items_.end();) {
            if (it->uuid != uuid) {
                ++it;
                continue;
            }
            media_swap_ducks.insert(media_swap_ducks.end(),
                                    it->ducked.begin(), it->ducked.end());
            it = sequenced_items_.erase(it);
        }
    }
    {
        std::lock_guard lock{mutex_};
        for_each_item(document_,
            [&](json& it, const std::string& /*parent*/) {
                if (it.value("uuid", std::string{}) != uuid) return;
                for (auto& [k, v] : patch.items()) {
                    if (k == "uuid") continue;
                    if (k == "mediaPath" || k == "mediaServerPath" ||
                        k == "mediaFileName") {
                        if (!it.contains(k) || it[k] != v)
                            media_path_changed = true;
                    }
                    if (k == "ltcEnabled" || k == "ltcStartTimecode" ||
                        k == "ltcFrameRate") {
                        if (!it.contains(k) || it[k] != v)
                            ltc_changed = true;
                    }
                    it[k] = v;
                }
                touched = true;
                updated_item = &it;
            });

        if (touched && media_path_changed && updated_item &&
            updated_item->value("type", std::string{}) == "audio") {
            // The media file behind this item changed: retire the old cue and
            // queue a fresh decode on the loader thread. Doing it inline (via
            // mirror_items_to_engine_locked) meant the decode ran under mutex_
            // and blocked every other request for its duration (#43).
            auto old = item_uuid_to_cue_.find(uuid);
            if (old != item_uuid_to_cue_.end()) {
                engine_.unload_cue(old->second);
                cues_.erase(old->second.value);
                item_uuid_to_cue_.erase(old);
            }
            auto path = resolve_media_path(
                *updated_item, document_.value("folderPath", std::string{}));
            begin_item_load_locked(uuid, path, *updated_item);
        } else if (touched && media_path_changed) {
            // Media change on something that isn't a loadable audio item —
            // fall back to the full mirror (cheap: nothing to decode).
            mirror_items_to_engine_locked();
        } else if (touched && updated_item) {
            // Cheap path: apply audio-engine-visible properties to the
            // existing PlaybackItem without a full mirror walk.
            auto cit = item_uuid_to_cue_.find(uuid);
            if (cit != item_uuid_to_cue_.end()) {
                if (auto cue = engine_.find_cue(cit->second)) {
                    const json& it = *updated_item;
                    if (it.contains("volume") && it["volume"].is_number()) {
                        const float lin = it["volume"].get<float>();
                        const float db  = (lin <= 0.0001f) ? -120.0f :
                                            20.0f * std::log10(lin);
                        cue->set_gain_db(db);
                    }
                    if (it.contains("playFade") && it["playFade"].is_number()) {
                        cue->set_fade_in(std::chrono::milliseconds{
                            static_cast<long long>(it["playFade"].get<double>() * 1000.0)});
                    }
                    // Same max(stopFade, fadeOutDuration) rule as
                    // mirror_items_to_engine_locked() — keep them in sync.
                    {
                        double stop_fade_sec = 0.0;
                        double fade_out_dur  = 0.0;
                        if (it.contains("stopFade") && it["stopFade"].is_number())
                            stop_fade_sec = it["stopFade"].get<double>();
                        if (it.contains("fadeOutDuration") && it["fadeOutDuration"].is_number())
                            fade_out_dur = it["fadeOutDuration"].get<double>();
                        const double effective = std::max(stop_fade_sec, fade_out_dur);
                        cue->set_fade_out(std::chrono::milliseconds{
                            static_cast<long long>(effective * 1000.0)});
                    }
                    if (it.contains("outPoint") && it["outPoint"].is_number()) {
                        cue->set_out_point_seconds(it["outPoint"].get<double>());
                    }
                    // LTC property update: configure the PlaybackItem in-place.
                    if (ltc_changed) {
                        const bool ltc_on = it.value("ltcEnabled", false);
                        const std::string tc_str = it.value("ltcStartTimecode",
                                                            std::string{"00:00:00:00"});
                        const int fps_idx = it.value("ltcFrameRate", 4);
                        cue->set_ltc_enabled(ltc_on);
                        if (ltc_on) {
                            const auto offset = parse_smpte_timecode_to_ns(tc_str, fps_idx);
                            cue->set_ltc_frame_rate(fps_index_to_rate(fps_idx));
                            cue->set_ltc_offset(offset);
                            auto cm_it = cues_.find(cit->second.value);
                            if (cm_it != cues_.end()) {
                                cm_it->second.ltc_enabled          = true;
                                cm_it->second.ltc_frame_rate_index = fps_idx;
                                cm_it->second.ltc_offset_ns        = offset;
                                cm_it->second.ltc_start_timecode   = tc_str;
                            }
                        } else {
                            auto cm_it = cues_.find(cit->second.value);
                            if (cm_it != cues_.end())
                                cm_it->second.ltc_enabled = false;
                        }
                    }
                }
            }
        }

        // Snapshot the sequencing-relevant fields so the playing cue's
        // auto-advance/crossfade/stop-fade/loop timing can be refreshed live
        // (done below, after releasing mutex_, to keep the existing lock order).
        if (touched && updated_item) {
            auto cit = item_uuid_to_cue_.find(uuid);
            if (cit != item_uuid_to_cue_.end()) {
                have_seq_cue  = true;
                seq_cue       = cit->second;
                const json& it = *updated_item;
                seq_in_point  = json_get_or(it, "inPoint",  0.0);
                seq_out_point = json_get_or(it, "outPoint", 0.0);
                seq_crossfade = json_get_or(it, "crossFade", 0.0);
                seq_stop_fade = json_get_or(it, "stopFade",  0.0);
                seq_sn_enabled   = json_get_or(it, "startNextEnabled", false);
                seq_sn_time      = json_get_or(it, "startNextTime",    0.0);
                seq_sn_fade_out  = json_get_or(it, "startNextFadeOut", false);
                seq_fade_out_dur = json_get_or(it, "fadeOutDuration",  1.0);
                if (it.contains("endBehavior") && it["endBehavior"].is_object())
                    seq_end_action = json_get_or(it["endBehavior"], "action", std::string{});
                auto cm_it = cues_.find(cit->second.value);
                if (cm_it != cues_.end())
                    seq_file_duration = cm_it->second.duration_seconds;
            }
        }
    }

    for (const auto& entry : media_swap_ducks) {
        if (auto cue = engine_.find_cue(entry.cue_id))
            cue->set_gain_db(entry.original_gain_db);
    }

    // Live-apply loop + sequencer timing for an already-playing cue. The engine
    // out-point / fades were updated under the lock above; here we keep the
    // audio-thread loop state and the sequencer snapshot in sync so changes to
    // out point / crossfade / stop-fade / end-behaviour take effect immediately
    // (the sequencer loop only updates a matching entry, so this is a no-op when
    // the item isn't currently sequenced).
    if (have_seq_cue) {
        const bool saved_looping = (seq_end_action == "loop");
        const bool sn_on = !saved_looping && seq_sn_enabled && seq_sn_time > 0.0;
        bool continuation_armed = false;
        {
            std::lock_guard slock{sequencer_mutex_};
            for (auto& si : sequenced_items_) {
                if (si.uuid != uuid) continue;
                continuation_armed = si.continue_armed;
                if (continuation_armed) {
                    // Runtime Cue to Continue owns this pass until it ends.
                    // Saved-property edits must not silently turn looping back on.
                    si.crossfade_sec = 0.0;
                    si.stop_fade_sec = 0.0;
                    si.start_next_time = 0.0;
                    si.start_next_fade_sec = 0.0;
                    si.effective_end = 0.0;
                } else {
                    si.crossfade_sec = saved_looping || sn_on ? 0.0 : seq_crossfade;
                    si.stop_fade_sec = saved_looping ? 0.0 : seq_stop_fade;
                    si.start_next_time = sn_on ? seq_sn_time : 0.0;
                    si.start_next_fade_sec = (sn_on && seq_sn_fade_out)
                                                 ? seq_fade_out_dur : 0.0;
                    si.effective_end = saved_looping
                        ? 0.0
                        : ((seq_out_point > 0.0) ? seq_out_point : seq_file_duration);
                }
                break;
            }
        }
        if (!continuation_armed) {
            if (auto pi = engine_.find_cue(seq_cue))
                pi->set_loop(saved_looping, seq_in_point);
        }
    }

    // Route (or re-route) the LTC channel after releasing mutex_ so
    // ensure_device_routing() can safely acquire it.
    if (touched && ltc_changed)
        apply_ltc_device_routing();
    return touched;
}

bool ProjectState::remove_item(const std::string& uuid) {
    std::lock_guard lifecycle_lock{playback_lifecycle_mutex_};
    bool removed = false;
    std::function<bool(json&)> erase_from;
    erase_from = [&](json& arr) -> bool {
        if (!arr.is_array()) return false;
        for (auto it = arr.begin(); it != arr.end(); ++it) {
            if (!it->is_object()) continue;
            if (it->value("uuid", std::string{}) == uuid) {
                arr.erase(it);
                return true;
            }
            if (it->value("type", std::string{}) == "group" &&
                it->contains("children")) {
                if (erase_from((*it)["children"])) return true;
            }
        }
        return false;
    };
    {
        std::lock_guard lock{mutex_};
        if (document_.contains("items")) {
            removed = erase_from(document_["items"]);
        }
        if (!removed && document_.contains("cartOnlyItems")) {
            removed = erase_from(document_["cartOnlyItems"]);
        }
        // Clean up cart bindings that reference this uuid.
        if (document_.contains("cartItems") && document_["cartItems"].is_array()) {
            auto& arr = document_["cartItems"];
            arr.erase(std::remove_if(arr.begin(), arr.end(),
                                     [&](const json& c){
                                         return c.value("itemUuid", std::string{}) == uuid;
                                     }),
                      arr.end());
        }
        if (removed) mirror_items_to_engine_locked();
    }
    if (removed) {
        std::vector<DuckedEntry> ducked;
        {
            std::lock_guard slock{sequencer_mutex_};
            playback_generations_.cancel(uuid);
            auto it = std::find_if(
                sequenced_items_.begin(), sequenced_items_.end(),
                [&](const SequencedItem& item) { return item.uuid == uuid; });
            if (it != sequenced_items_.end()) {
                ducked = std::move(it->ducked);
                sequenced_items_.erase(it);
            }
        }
        for (const auto& entry : ducked) {
            if (auto cue = engine_.find_cue(entry.cue_id))
                cue->set_gain_db(entry.original_gain_db);
        }
    }
    return removed;
}

bool ProjectState::reorder_items(const std::vector<std::string>& uuids,
                                 const std::string& parent_uuid) {
    std::lock_guard lock{mutex_};
    json* target = nullptr;
    if (parent_uuid.empty()) {
        if (document_.contains("items") && document_["items"].is_array()) {
            target = &document_["items"];
        }
    } else {
        for_each_item(document_,
            [&](json& it, const std::string& /*parent*/) {
                if (target) return;
                if (it.value("uuid", std::string{}) == parent_uuid &&
                    it.value("type", std::string{}) == "group" &&
                    it.contains("children") && it["children"].is_array()) {
                    target = &it["children"];
                }
            });
    }
    if (!target) return false;

    // Pull items out into a uuid → json map, then rebuild in the requested
    // order. Items whose uuid isn't in `uuids` are appended at the end so we
    // never lose data on a partial reorder.
    std::unordered_map<std::string, json> by_uuid;
    for (auto& it : *target) {
        if (it.is_object()) {
            by_uuid.emplace(it.value("uuid", std::string{}), std::move(it));
        }
    }
    json rebuilt = json::array();
    for (const auto& u : uuids) {
        auto found = by_uuid.find(u);
        if (found != by_uuid.end()) {
            rebuilt.push_back(std::move(found->second));
            by_uuid.erase(found);
        }
    }
    for (auto& [_, v] : by_uuid) rebuilt.push_back(std::move(v));
    *target = std::move(rebuilt);
    return true;
}

std::optional<std::filesystem::path>
ProjectState::resolve_item_path(const std::string& uuid) const {
    std::lock_guard lock{mutex_};
    std::optional<std::filesystem::path> out;
    // Walk a copy-free view: we're const, so for_each_item takes a non-const
    // json — work around with a const_cast since we only read inside the
    // lambda. The lambda mutates nothing.
    json& doc_ref = const_cast<json&>(document_);
    for_each_item(doc_ref,
        [&](json& item, const std::string& /*parent*/) {
            if (out) return;
            if (item.value("uuid", std::string{}) != uuid) return;
            auto path = resolve_media_path(
                item, doc_ref.value("folderPath", std::string{}));
            if (!path.empty()) out = std::move(path);
        });
    return out;
}
std::optional<long long>
ProjectState::item_trigger_seq(const std::string& uuid) const {
    std::lock_guard lock{mutex_};
    const auto it = item_trigger_seq_.find(uuid);
    if (it == item_trigger_seq_.end()) return std::nullopt;
    return it->second;
}

std::optional<audio::CueId>
ProjectState::item_to_cue_id(const std::string& uuid) const {
    std::lock_guard lock{mutex_};
    auto it = item_uuid_to_cue_.find(uuid);
    if (it == item_uuid_to_cue_.end()) return std::nullopt;
    return it->second;
}

std::optional<std::string>
ProjectState::cue_to_item_uuid(const audio::CueId& id) const {
    std::lock_guard lock{mutex_};
    for (const auto& [uuid, cue_id] : item_uuid_to_cue_) {
        if (cue_id.value == id.value) return uuid;
    }
    return std::nullopt;
}

std::string ProjectState::resolve_next_item_locked(const std::string& current_uuid) const {
    // The lookup is read-only; we need a mutable json& to satisfy for_each_item
    // (which itself only reads). const_cast is safe here for the same reason
    // as in resolve_item_path().
    json& doc = const_cast<json&>(document_);

    // 1) Find the current item + its endBehavior.
    std::string end_action;
    std::string end_target_uuid;
    std::string parent_uuid;
    bool found = false;
    for_each_item(doc,
        [&](json& it, const std::string& parent) {
            if (found) return;
            if (it.value("uuid", std::string{}) != current_uuid) return;
            found = true;
            parent_uuid = parent;
            if (it.contains("endBehavior") && it["endBehavior"].is_object()) {
                const auto& eb = it["endBehavior"];
                end_action      = eb.value("action", std::string{"nothing"});
                end_target_uuid = eb.value("targetUuid", std::string{});
            }
        });
    if (!found) return {};

    if (end_action == "goto-item" && !end_target_uuid.empty()) {
        return end_target_uuid;
    }
    if (end_action == "loop" || end_action == "nothing" || end_action.empty()) {
        return {};   // either replay self or stop; nothing new to prime
    }
    if (end_action != "next") return {};

    // 2) "next" — return the sibling immediately following `current_uuid` in
    // the same level (top or inside a group). Look at the parent's children
    // array; if `current_uuid` is the last, fall back to nothing.
    auto find_next_in_array = [&](json& arr) -> std::string {
        if (!arr.is_array()) return {};
        for (std::size_t i = 0; i + 1 < arr.size(); ++i) {
            if (arr[i].is_object() &&
                arr[i].value("uuid", std::string{}) == current_uuid) {
                const auto& next = arr[i + 1];
                if (next.is_object()) return next.value("uuid", std::string{});
            }
        }
        return {};
    };

    if (parent_uuid.empty()) {
        // Top-level.
        if (doc.contains("items")) {
            const auto next = find_next_in_array(doc["items"]);
            if (!next.empty()) return next;
        }
        return {};
    }

    // Inside a group — find the group, then look in its children.
    std::string result;
    for_each_item(doc,
        [&](json& it, const std::string& /*p*/) {
            if (!result.empty()) return;
            if (it.value("uuid", std::string{}) != parent_uuid) return;
            if (it.value("type", std::string{}) != "group") return;
            if (!it.contains("children")) return;
            result = find_next_in_array(it["children"]);
        });
    return result;
}

std::string ProjectState::resolve_loop_continuation_target_locked(
    const std::string& current_uuid) {
    json& doc = document_;
    const json* current = nullptr;
    std::string parent_uuid;
    for_each_item(doc, [&](json& item, const std::string& parent) {
        if (current || item.value("uuid", std::string{}) != current_uuid) return;
        current = &item;
        parent_uuid = parent;
    });
    if (!current) return {};

    if (current->contains("endBehavior") &&
        (*current)["endBehavior"].is_object()) {
        const auto& end = (*current)["endBehavior"];
        const auto target_uuid = end.value("targetUuid", std::string{});
        if (!target_uuid.empty()) return target_uuid;
        if (end.contains("targetIndex") && end["targetIndex"].is_array()) {
            std::vector<int> target_index;
            for (const auto& value : end["targetIndex"]) {
                if (value.is_number_integer()) target_index.push_back(value.get<int>());
            }
            return resolve_index_path_locked(target_index);
        }
    }

    const auto next_in = [&](const json& items) -> std::string {
        if (!items.is_array()) return {};
        for (std::size_t i = 0; i + 1 < items.size(); ++i) {
            if (!items[i].is_object() ||
                items[i].value("uuid", std::string{}) != current_uuid) continue;
            return items[i + 1].is_object()
                ? items[i + 1].value("uuid", std::string{})
                : std::string{};
        }
        return {};
    };
    if (parent_uuid.empty()) {
        return doc.contains("items") ? next_in(doc["items"]) : std::string{};
    }
    std::string next_uuid;
    for_each_item(doc, [&](json& item, const std::string&) {
        if (!next_uuid.empty() || item.value("uuid", std::string{}) != parent_uuid ||
            item.value("type", std::string{}) != "group" ||
            !item.contains("children")) return;
        next_uuid = next_in(item["children"]);
    });
    return next_uuid;
}

// Resolve an index path (array of child indices) to a uuid. Mirrors the
// client's findItemByIndex: start at the top-level `items`, and at each level
// descend into the selected item's `children` when it is a group.
std::string ProjectState::resolve_index_path_locked(const std::vector<int>& path) const {
    if (path.empty()) return {};
    if (!document_.contains("items") || !document_["items"].is_array()) return {};

    const json* arr     = &document_["items"];
    const json* current = nullptr;
    for (int idx : path) {
        if (!arr || !arr->is_array()) return {};
        if (idx < 0 || idx >= static_cast<int>(arr->size())) return {};
        current = &(*arr)[static_cast<std::size_t>(idx)];
        if (!current->is_object()) return {};
        if (current->value("type", std::string{}) == "group" &&
            current->contains("children") && (*current)["children"].is_array()) {
            arr = &(*current)["children"];
        } else {
            arr = nullptr;   // leaf — any remaining path components are invalid
        }
    }
    return current ? current->value("uuid", std::string{}) : std::string{};
}

std::string ProjectState::first_playable_item_uuid_locked() const {
    if (!document_.contains("items") || !document_["items"].is_array()) return {};
    std::string result;
    std::function<void(const json&)> walk = [&](const json& arr) {
        if (!result.empty() || !arr.is_array()) return;
        for (const auto& it : arr) {
            if (!result.empty()) return;
            if (!it.is_object()) continue;
            if (it.value("type", std::string{}) == "audio") {
                result = it.value("uuid", std::string{});
                return;
            }
            if (it.value("type", std::string{}) == "group" && it.contains("children"))
                walk(it["children"]);
        }
    };
    walk(document_["items"]);
    return result;
}

std::vector<std::string> ProjectState::flat_item_uuids_locked() const {
    std::vector<std::string> out;
    if (!document_.contains("items") || !document_["items"].is_array()) return out;
    std::function<void(const json&)> walk = [&](const json& arr) {
        if (!arr.is_array()) return;
        for (const auto& it : arr) {
            if (!it.is_object()) continue;
            const auto uuid = it.value("uuid", std::string{});
            if (!uuid.empty()) out.push_back(uuid);
            if (it.value("type", std::string{}) == "group" && it.contains("children"))
                walk(it["children"]);
        }
    };
    walk(document_["items"]);
    return out;
}

// Public thread-safe wrapper: resolve an index path to an item uuid.
std::string ProjectState::item_uuid_by_index(const std::vector<int>& path) const {
    std::lock_guard lock{mutex_};
    return resolve_index_path_locked(path);
}

// ---------------------------------------------------------------------------
// Item-level transport with ducking + in/out point semantics.
// ---------------------------------------------------------------------------
bool ProjectState::play_item(const std::string& uuid,
                             double fade_in_override_sec,
                             const audio::CueId& exclude_from_ducking,
                             double start_position_override_sec) {
    std::lock_guard lifecycle_lock{playback_lifecycle_mutex_};
  // Guard the whole body: a malformed item field must never throw uncaught
  // into the network layer. (#5)
  try {
    // If this item was added moments ago its decode may still be running on the
    // loader thread (#43). Wait for THAT item only — every other request stays
    // responsive — and bound the wait so a wedged network share can't hang the
    // caller. Returns immediately when nothing is pending, which is the norm.
    wait_for_item_load(uuid, std::chrono::seconds{20});

    // Snapshot everything we need under the lock, then release before
    // touching the engine (engine calls take their own locks).
    std::string  ducking_mode  = "stop-all";
    float        duck_level    = 0.2f;
    double       in_point      = 0.0;
    double       out_point     = 0.0;
    double       fade_out_dur  = 1.0;
    double       crossfade_sec = 0.0;
    double       stop_fade_sec = 0.0;
    bool         start_next_enabled  = false;
    double       start_next_time     = 0.0;
    bool         start_next_fade_out = false;
    std::string  device_override;
    std::string  start_behavior_action;
    std::string  start_behavior_target_uuid;
    std::string  end_behavior_action;
    std::string  end_behavior_target_uuid;
    bool         one_shot = false;
    std::vector<int> end_behavior_target_index;
    audio::CueId target_cue;
    std::vector<audio::CueId> other_cues;

    std::vector<ScheduledCustomAction> custom_actions_snapshot;
    {
        std::lock_guard lock{mutex_};
        auto cue_it = item_uuid_to_cue_.find(uuid);
        if (cue_it == item_uuid_to_cue_.end()) return false;
        target_cue = cue_it->second;

        // Locate the item JSON to read its behavior fields.
        json* found = nullptr;
        json& doc = document_;
        std::function<void(json&)> walk;
        walk = [&](json& arr) {
            if (found || !arr.is_array()) return;
            for (auto& it : arr) {
                if (found) return;
                if (!it.is_object()) continue;
                if (it.value("uuid", std::string{}) == uuid) { found = &it; return; }
                if (it.value("type", std::string{}) == "group" &&
                    it.contains("children")) walk(it["children"]);
            }
        };
        if (doc.contains("items"))              walk(doc["items"]);
        if (!found && doc.contains("cartOnlyItems")) walk(doc["cartOnlyItems"]);

        if (found) {
            one_shot      = is_one_shot_cue(*found);
            in_point      = json_get_or(*found, "inPoint",         0.0);
            out_point     = json_get_or(*found, "outPoint",         0.0);
            fade_out_dur  = json_get_or(*found, "fadeOutDuration",  1.0);
            crossfade_sec = json_get_or(*found, "crossFade",        0.0);
            stop_fade_sec = json_get_or(*found, "stopFade",         0.0);
            start_next_enabled  = json_get_or(*found, "startNextEnabled",  false);
            start_next_time     = json_get_or(*found, "startNextTime",     0.0);
            start_next_fade_out = json_get_or(*found, "startNextFadeOut",  false);
            if (found->contains("duckingBehavior") &&
                (*found)["duckingBehavior"].is_object()) {
                const auto& dk = (*found)["duckingBehavior"];
                ducking_mode = dk.value("mode",      std::string{"stop-all"});
                duck_level   = dk.value("duckLevel", 0.2f);
            }
            if (found->contains("deviceOverride") &&
                (*found)["deviceOverride"].is_string()) {
                device_override = (*found)["deviceOverride"].get<std::string>();
            }
            if (found->contains("startBehavior") &&
                (*found)["startBehavior"].is_object()) {
                const auto& sb = (*found)["startBehavior"];
                start_behavior_action      = sb.value("action",     std::string{});
                start_behavior_target_uuid = sb.value("targetUuid", std::string{});
            }
            if (found->contains("endBehavior") &&
                (*found)["endBehavior"].is_object()) {
                const auto& eb = (*found)["endBehavior"];
                end_behavior_action      = eb.value("action",     std::string{});
                end_behavior_target_uuid = eb.value("targetUuid", std::string{});
                if (eb.contains("targetIndex") && eb["targetIndex"].is_array()) {
                    for (const auto& v : eb["targetIndex"]) {
                        if (v.is_number_integer())
                            end_behavior_target_index.push_back(v.get<int>());
                    }
                }
            }
            // Snapshot custom actions for the sequencer to dispatch.
            if (found->contains("customActions") &&
                (*found)["customActions"].is_array()) {
                for (const auto& ca : (*found)["customActions"]) {
                    if (!ca.is_object() || !ca.contains("action")) continue;
                    ScheduledCustomAction sca;
                    sca.time_point = ca.value("timePoint", 0.0);
                    sca.action     = ca["action"];
                    custom_actions_snapshot.push_back(std::move(sca));
                }
            }
        }

        // Collect every cue id except this one.
        for (auto& [_, c] : cues_) {
            if (c.id == target_cue) continue;
            other_cues.push_back(c.id);
        }
    }

    // Replay is a fresh runtime instance of the saved cue behavior. Cancel any
    // pending one-shot continuation (and all other stale sequencing state)
    // before touching the PlaybackItem so a concurrent natural end cannot
    // advance the old play after the operator has replayed it.
    std::vector<DuckedEntry> replay_ducks;
    detail::PlaybackGenerationFence::Generation playback_generation{};
    {
        std::lock_guard slock{sequencer_mutex_};
        playback_generation = playback_generations_.begin(uuid);
        auto it = std::find_if(
            sequenced_items_.begin(), sequenced_items_.end(),
            [&](const SequencedItem& item) { return item.uuid == uuid; });
        if (it != sequenced_items_.end()) {
            replay_ducks = std::move(it->ducked);
            sequenced_items_.erase(it);
        }
    }
    for (const auto& entry : replay_ducks) {
        if (auto cue = engine_.find_cue(entry.cue_id))
            cue->set_gain_db(entry.original_gain_db);
    }

    // Snapshot original gains for duck-others before applying ducking.
    std::vector<DuckedEntry> ducks_made;

    // Apply ducking to other cues before triggering the new one.
    if (ducking_mode == "stop-all") {
        const auto fade_ms = std::chrono::milliseconds{
            static_cast<long long>(std::max(fade_out_dur, 0.0) * 1000.0)};
        for (auto& cid : other_cues) {
            // Crossfade: don't touch the outgoing cue — the sequencer already
            // started its engine-owned fade-out. Stopping it here would (since
            // it's FadingOut) route through stop_now() and hard-cut it.
            if (!exclude_from_ducking.empty() && cid == exclude_from_ducking) continue;
            if (auto pi = engine_.find_cue(cid)) {
                const auto prev_fade = pi->desc().fade_out_duration;
                pi->set_fade_out(fade_ms);
                pi->stop();
                pi->set_fade_out(prev_fade);
            }
        }
    } else if (ducking_mode == "duck-others") {
        const float lin = std::clamp(duck_level, 0.0f, 1.0f);
        const float db  = (lin <= 0.0001f) ? -120.0f : 20.0f * std::log10(lin);
        for (auto& cid : other_cues) {
            if (!exclude_from_ducking.empty() && cid == exclude_from_ducking) continue;
            if (auto pi = engine_.find_cue(cid)) {
                ducks_made.push_back({cid, pi->gain_db()});
                pi->set_gain_db(db);
            }
        }
    }
    // "no-ducking" → do nothing.

    // Apply per-cue device routing right before play.
    if (!device_override.empty()) {
        const auto mixer = ensure_device_routing(device_override);
        if (!mixer.empty()) {
            route_cue_to_mixer(target_cue, mixer);
        } else {
            engine_.ensure_default_routing();
        }
    } else {
        // No per-item override: honour the project's default output device if
        // one is set, otherwise fall back to the engine's Main → platform-
        // default routing. Without this, a project that selected a non-default
        // output device was ignored at play time, because ensure_default_-
        // routing() re-pinned the cue to Main (the OS default device). (#30)
        std::string default_device;
        {
            std::lock_guard lock{mutex_};
            if (document_.contains("settings") && document_["settings"].is_object()) {
                const auto& s = document_["settings"];
                if (s.contains("defaultOutputDevice") && s["defaultOutputDevice"].is_string())
                    default_device = s["defaultOutputDevice"].get<std::string>();
            }
        }
        audio::MixerChannelId default_mixer;
        if (!default_device.empty()) default_mixer = ensure_device_routing(default_device);
        if (!default_mixer.empty()) {
            // route_cue_to_mixer() clears every prior route (incl. Main) first,
            // so the cue plays ONLY on the selected device.
            route_cue_to_mixer(target_cue, default_mixer);
        } else {
            // Drop any stale per-device override routes, then Main-route.
            engine_.unroute_item_from_all_mixers(target_cue);
            engine_.ensure_default_routing();
        }
    }

    // Re-establish LTC device routing after any audio routing changes above
    // may have disrupted it (unrouting all channels clears LTC device routes).
    apply_ltc_device_routing();

    // Look up file duration for sequencer scheduling (from CueMeta).
    double file_duration = 0.0;
    {
        std::lock_guard lock{mutex_};
        auto cm_it = cues_.find(target_cue.value);
        if (cm_it != cues_.end()) file_duration = cm_it->second.duration_seconds;
    }

    const double effective_end = out_point > in_point ? out_point : file_duration;
    const double play_start = std::isfinite(start_position_override_sec) &&
                              start_position_override_sec >= 0.0
        ? std::clamp(start_position_override_sec, in_point,
                     std::max(in_point, effective_end))
        : in_point;

    // Prime the target around the configured In point or Properties playhead.
    if (auto pi = engine_.find_cue(target_cue)) {
        pi->set_out_point_seconds(out_point > 0.0 ? out_point : 0.0);
        // Configure engine-level seamless looping based on endBehavior. Doing
        // the loop inside the audio thread (decoder seek + playhead reset on
        // EOF/out-point) avoids the Stopped→Playing flap that the broadcast
        // thread used to observe between the natural-end and the sequencer's
        // re-trigger — that flap caused the client UI to drop the cue from
        // "currently playing" and grey out its stop button mid-loop.
        pi->set_loop(end_behavior_action == "loop", in_point);
        pi->prime(2.0, play_start);

        // Crossfade-in: fade the incoming cue up over the crossfade window
        // instead of using its own play-fade. play() captures the fade
        // duration synchronously inside start_fade(), so restoring the stored
        // value immediately after doesn't disturb the in-flight fade.
        const bool override_fade = fade_in_override_sec >= 0.0;
        const auto saved_fade_in = pi->desc().fade_in_duration;
        if (override_fade) {
            pi->set_fade_in(std::chrono::milliseconds{
                static_cast<long long>(fade_in_override_sec * 1000.0)});
        }
        pi->play();
        if (override_fade) pi->set_fade_in(saved_fade_in);
    } else {
        engine_.play(target_cue);  // logs the "no cue" warning path
    }

    // Stamp the item with a monotonic trigger sequence. Control surfaces read
    // this back from the state summary to answer "what did the operator fire
    // LAST?" — with several cues on air (a bed under a stinger, say), document
    // order is the wrong answer for a "currently playing" display.
    {
        std::lock_guard lock{mutex_};
        item_trigger_seq_[uuid] = ++trigger_seq_counter_;
    }

    // Register with the sequencer so it can handle end-behaviour, crossfade,
    // and stop-fade autonomously — even when the client is disconnected.
    {
        const bool looping = (end_behavior_action == "loop");
        // A looping cue plays forever (the audio thread seeks back to the
        // in-point on EOF/out-point). It must NOT arm the timing-based
        // auto-advance: otherwise, as the playhead nears effective_end, the
        // sequencer's crossfade/stop-fade triggers would fire and start the
        // *next* item — which is exactly the "loop behaves like play-next" bug.
        // effective_end = 0 disables all timing triggers while still letting
        // custom actions fire (they're checked before the effective_end gate).
        const double effective_end = looping
            ? 0.0
            : ((out_point > 0.0) ? out_point : file_duration);
        // Start Next supersedes crossfade — both would start the next item,
        // so arming them together would double-trigger it.
        const bool start_next_on =
            !looping && start_next_enabled && start_next_time > 0.0;
        SequencedItem si;
        si.uuid          = uuid;
        si.cue_id        = target_cue;
        si.playback_generation = playback_generation;
        si.crossfade_sec = (looping || start_next_on) ? 0.0 : crossfade_sec;
        si.stop_fade_sec = looping ? 0.0 : stop_fade_sec;
        si.start_next_time     = start_next_on ? start_next_time : 0.0;
        si.start_next_fade_sec = (start_next_on && start_next_fade_out)
                                     ? fade_out_dur : 0.0;
        si.effective_end = effective_end;
        si.end_action        = end_behavior_action;
        si.goto_target_uuid  = end_behavior_target_uuid;
        si.goto_target_index = end_behavior_target_index;
        si.ducked        = std::move(ducks_made);
        si.custom_actions = std::move(custom_actions_snapshot);

        std::lock_guard slock{sequencer_mutex_};
        // Remove any prior sequencer entry for this item (re-play case).
        sequenced_items_.erase(
            std::remove_if(sequenced_items_.begin(), sequenced_items_.end(),
                           [&](const SequencedItem& x){ return x.uuid == uuid; }),
            sequenced_items_.end());
        sequenced_items_.push_back(std::move(si));
    }

    // Playback just moved somewhere the server's own guess didn't predict, so
    // drop a stale auto-arming — the clients then fall back to the "Up Next"
    // derived from what is actually on air (e.g. the group child that follows
    // the one we just started) instead of showing the item armed before the
    // operator jumped. An arming the OPERATOR made is left alone: they chose it
    // deliberately and GO must still honour it.
    // Cart-only items are excluded: firing an SFX pad is not "moving the
    // playlist", and blanking the arming there would leave GO with nothing to
    // fire until the next cue ended.
    {
        bool stale = false;
        {
            std::lock_guard lock{mutex_};
            if (!one_shot && !next_item_override_.empty() &&
                !next_item_override_manual_ &&
                next_item_override_ != uuid) {
                std::function<bool(const json&)> in_playlist = [&](const json& arr) -> bool {
                    if (!arr.is_array()) return false;
                    for (const auto& it : arr) {
                        if (!it.is_object()) continue;
                        if (it.value("uuid", std::string{}) == uuid) return true;
                        if (it.value("type", std::string{}) == "group" &&
                            it.contains("children") && in_playlist(it["children"])) return true;
                    }
                    return false;
                };
                stale = document_.contains("items") && in_playlist(document_["items"]);
            }
        }
        if (stale) set_next_item_override("", /*manual=*/false);
    }

    // Handle start-behaviour immediately.
    if (start_behavior_action == "stop" && !start_behavior_target_uuid.empty()) {
        stop_item(start_behavior_target_uuid);
    } else if (start_behavior_action == "play" && !start_behavior_target_uuid.empty()) {
        play_item(start_behavior_target_uuid);
    }

    return true;
  } catch (const std::exception& e) {
    Logger::error("ProjectState::play_item('{}') failed: {}", uuid, e.what());
    return false;
  }
}

bool ProjectState::stop_item(const std::string& uuid) {
    std::lock_guard lifecycle_lock{playback_lifecycle_mutex_};
    audio::CueId cue;
    {
        std::lock_guard lock{mutex_};
        auto it = item_uuid_to_cue_.find(uuid);
        if (it == item_uuid_to_cue_.end()) return false;
        cue = it->second;
    }

    // Remove from sequencer and restore any ducked gains.
    {
        std::lock_guard slock{sequencer_mutex_};
        playback_generations_.cancel(uuid);
        auto it = std::find_if(sequenced_items_.begin(), sequenced_items_.end(),
                               [&](const SequencedItem& si){ return si.uuid == uuid; });
        if (it != sequenced_items_.end()) {
            for (auto& dk : it->ducked) {
                if (auto pi = engine_.find_cue(dk.cue_id))
                    pi->set_gain_db(dk.original_gain_db);
            }
            sequenced_items_.erase(it);
        }
    }

    engine_.stop(cue);

    // Server-authoritative "Up Next" arming: a manual stop of a cue with no end
    // behaviour advances the arming to the next sibling (but never wraps at the
    // end of the list — the operator is holding the show). (#28)
    arm_next_after_stop(uuid, /*was_manual=*/true);
    return true;
}

bool ProjectState::cue_to_continue(const std::string& uuid) {
    std::lock_guard lifecycle_lock{playback_lifecycle_mutex_};
    if (uuid.empty()) return false;

    std::string target_uuid;
    {
        std::lock_guard lock{mutex_};
        target_uuid = resolve_loop_continuation_target_locked(uuid);
    }

    audio::CueId cue_id;
    {
        std::lock_guard slock{sequencer_mutex_};
        const auto it = std::find_if(
            sequenced_items_.begin(), sequenced_items_.end(),
            [&](const SequencedItem& item) { return item.uuid == uuid; });
        if (it == sequenced_items_.end() || it->end_action != "loop" ||
            it->continue_armed) return false;
        cue_id = it->cue_id;
    }

    const auto cue = engine_.find_cue(cue_id);
    if (!cue) return false;
    const auto transport = cue->stats().transport;
    if (transport != audio::TransportState::Playing &&
        transport != audio::TransportState::FadingIn &&
        transport != audio::TransportState::Paused) return false;

    {
        std::lock_guard slock{sequencer_mutex_};
        const auto it = std::find_if(
            sequenced_items_.begin(), sequenced_items_.end(),
            [&](const SequencedItem& item) {
                return item.uuid == uuid && item.cue_id == cue_id;
            });
        if (it == sequenced_items_.end() || it->end_action != "loop" ||
            it->continue_armed) return false;
        // Publish the runtime decision before disabling the decoder loop. Once
        // looping is off, the decode worker may produce NaturalEnd immediately.
        it->continue_target_uuid = target_uuid;
        it->continue_armed = true;
        it->crossfade_sec = 0.0;
        it->stop_fade_sec = 0.0;
        it->start_next_time = 0.0;
        it->start_next_fade_sec = 0.0;
        it->effective_end = 0.0;
    }

    // set_loop flushes stale read-ahead and seeks the decoder back to the
    // audible playhead. It runs on this control thread, never the audio callback.
    cue->set_loop(false);
    Logger::playback("CUE TO CONTINUE: item '{}' target='{}'", uuid,
                     target_uuid);
    return true;
}

void ProjectState::stop_all_cues(std::optional<long long> fade_ms) {
    std::lock_guard lifecycle_lock{playback_lifecycle_mutex_};
    long long resolved_ms;
    if (fade_ms.has_value()) {
        resolved_ms = std::max<long long>(0, *fade_ms);
    } else {
        // Project-wide default fade for the Stop All button (default 1000 ms).
        long long setting_ms = 1000;
        {
            std::lock_guard lock{mutex_};
            if (document_.contains("settings") && document_["settings"].is_object()) {
                const auto& s = document_["settings"];
                if (s.contains("stopAllFadeMs") && s["stopAllFadeMs"].is_number())
                    setting_ms = static_cast<long long>(s["stopAllFadeMs"].get<double>());
            }
        }
        resolved_ms = std::max<long long>(0, setting_ms);
    }
    // Stop All cancels every pending follow action, including runtime Cue to
    // Continue. Restore ducked gains before discarding the sequencer entries.
    std::vector<DuckedEntry> ducked;
    {
        std::lock_guard slock{sequencer_mutex_};
        playback_generations_.cancel_all();
        for (auto& item : sequenced_items_) {
            ducked.insert(ducked.end(), item.ducked.begin(), item.ducked.end());
        }
        sequenced_items_.clear();
    }
    for (const auto& entry : ducked) {
        if (auto cue = engine_.find_cue(entry.cue_id))
            cue->set_gain_db(entry.original_gain_db);
    }
    // Global fade always wins over any per-track fade-out (force_fade = true).
    engine_.stop_all(std::chrono::milliseconds{resolved_ms}, /*force_fade=*/true);
}

void ProjectState::set_next_item_override(const std::string& uuid, bool manual) {
    std::function<void(const std::string&)> cb;
    {
        std::lock_guard lock{mutex_};
        // Re-arming the same uuid still needs to record the (possibly stronger)
        // provenance — an operator confirming the server's guess makes it
        // sticky — but must not re-broadcast.
        const bool same = (next_item_override_ == uuid);
        next_item_override_        = uuid;
        next_item_override_manual_ = uuid.empty() ? false : manual;
        if (same) return;
        cb = next_item_broadcaster_;
    }
    // Fan the change out to every connected client (server- or client-
    // initiated), outside the lock so the broadcast can't deadlock on mutex_.
    if (cb) cb(uuid);
}

void ProjectState::set_next_item_broadcaster(std::function<void(const std::string&)> cb) {
    std::lock_guard lock{mutex_};
    next_item_broadcaster_ = std::move(cb);
}

std::string ProjectState::next_item_override() const {
    std::lock_guard lock{mutex_};
    return next_item_override_;
}

// ---------------------------------------------------------------------------
// Show-control surface: selection, Show Mode and locale. Server-owned so every
// client and control surface renders the same operator state. Each setter
// broadcasts outside the lock (the broadcaster re-enters the network layer,
// which must never happen while holding mutex_) and only when the value
// actually changed, so a client echoing a patch back can't loop.
// ---------------------------------------------------------------------------
void ProjectState::set_ui_state_broadcaster(std::function<void(const json&)> cb) {
    std::lock_guard lock{mutex_};
    ui_state_broadcaster_ = std::move(cb);
}

std::string ProjectState::selected_item_uuid() const {
    std::lock_guard lock{mutex_};
    return selected_item_uuid_;
}

bool ProjectState::set_selected_item(const std::string& uuid) {
    std::function<void(const json&)> cb;
    {
        std::lock_guard lock{mutex_};
        if (selected_item_uuid_ == uuid) return false;
        selected_item_uuid_ = uuid;
        cb = ui_state_broadcaster_;
    }
    if (cb) cb(json{{"type", "doc_patch"}, {"op", "selection_changed"}, {"itemUuid", uuid}});
    return true;
}

std::string ProjectState::step_selection(int delta,
                                         const std::vector<std::string>& anchor_candidates) {
    std::string target;
    {
        std::lock_guard lock{mutex_};
        const auto flat = flat_item_uuids_locked();
        if (flat.empty()) return {};

        auto it = std::find(flat.begin(), flat.end(), selected_item_uuid_);
        bool have_position = !selected_item_uuid_.empty() && it != flat.end();

        // Nothing selected (or a selection that no longer exists — the item was
        // deleted by another client). If the caller handed us anchors — the
        // items currently playing — step from the furthest one down the
        // playlist: an operator who has been firing cues without touching the
        // selection means "carry on from what I'm hearing", not "jump back to
        // the top of the show".
        if (!have_position && !anchor_candidates.empty()) {
            for (const auto& uuid : anchor_candidates) {
                auto anchor = std::find(flat.begin(), flat.end(), uuid);
                if (anchor == flat.end()) continue;
                if (!have_position || anchor > it) { it = anchor; have_position = true; }
            }
        }

        if (!have_position) {
            // No selection and nothing playing: start at the top.
            target = flat.front();
        } else {
            const auto idx = static_cast<long long>(std::distance(flat.begin(), it));
            const auto last = static_cast<long long>(flat.size()) - 1;
            // Clamp at both ends — the same "stop at the edge" behaviour as the
            // client's arrow keys. Wrapping would risk a blind operator holding
            // a button and silently landing back at the top of the show.
            target = flat[static_cast<std::size_t>(std::clamp(idx + delta, 0LL, last))];
        }
    }
    set_selected_item(target);
    return target;
}

bool ProjectState::show_mode() const {
    std::lock_guard lock{mutex_};
    return show_mode_;
}

void ProjectState::set_show_mode(bool enabled) {
    std::function<void(const json&)> cb;
    {
        std::lock_guard lock{mutex_};
        if (show_mode_ == enabled) return;
        show_mode_ = enabled;
        cb = ui_state_broadcaster_;
    }
    if (cb) cb(json{{"type", "doc_patch"}, {"op", "show_mode_changed"}, {"enabled", enabled}});
}

bool ProjectState::toggle_show_mode() {
    bool result;
    std::function<void(const json&)> cb;
    {
        std::lock_guard lock{mutex_};
        show_mode_ = !show_mode_;
        result = show_mode_;
        cb = ui_state_broadcaster_;
    }
    if (cb) cb(json{{"type", "doc_patch"}, {"op", "show_mode_changed"}, {"enabled", result}});
    return result;
}

std::string ProjectState::ui_locale() const {
    std::lock_guard lock{mutex_};
    return ui_locale_;
}

void ProjectState::set_ui_locale(const std::string& code) {
    std::function<void(const json&)> cb;
    {
        std::lock_guard lock{mutex_};
        if (code.empty() || ui_locale_ == code) return;
        ui_locale_ = code;
        cb = ui_state_broadcaster_;
    }
    if (cb) cb(json{{"type", "doc_patch"}, {"op", "locale_changed"}, {"locale", code}});
}

// ---------------------------------------------------------------------------
// External-control surface (Bitfocus Companion, custom remotes).
// ---------------------------------------------------------------------------
static const char* transport_state_name(audio::TransportState t) {
    switch (t) {
        case audio::TransportState::Playing:   return "playing";
        case audio::TransportState::FadingIn:  return "fading_in";
        case audio::TransportState::FadingOut: return "fading_out";
        case audio::TransportState::Paused:    return "paused";
        default:                               return "stopped";
    }
}

json ProjectState::state_summary() const {
    // Doc-derived facts are snapshotted under mutex_ first; engine transport
    // is read afterwards (engine calls take their own locks) and the auto
    // "Up Next" derivation re-acquires mutex_ at the end. Never call into the
    // engine while holding mutex_ from here — play_item does the same dance.
    struct ItemFacts {
        std::string      name;
        std::string      color;            // "#RRGGBB" as authored in the client
        std::string      type;             // "audio" | "group" | "action"
        double           duration  = 0.0;  // full-file seconds (0 = unknown)
        double           in_point  = 0.0;
        double           out_point = 0.0;  // 0 = play to end
        std::vector<int> index;            // playlist index path; empty for cart-only items
    };
    std::unordered_map<std::string, ItemFacts> facts;
    // uuid → (cue, duration from decode metadata)
    std::vector<std::tuple<std::string, audio::CueId, double>> cue_pairs;
    std::string override_uuid;
    std::string selected_uuid;
    bool        show_mode_now = false;
    std::string locale_now;
    std::unordered_map<std::string, long long> trigger_seq;
    json project_block;
    json cart_bindings = json::array();

    {
        std::lock_guard lock{mutex_};

        const std::size_t item_count =
            (document_.contains("items") && document_["items"].is_array())
                ? document_["items"].size() : 0;
        project_block = json{
            {"name",           document_.value("name", "")},
            {"itemCount",      item_count},
            {"hasOpenProject", item_count > 0 || !project_file_path_.empty()},
            {"audioLoading",   loading_audio_.load(std::memory_order_acquire)},
        };

        // Walk the playlist tree recording every item's display facts and its
        // index path — the same path /api/transport/play_index accepts.
        std::function<void(const json&, std::vector<int>&)> walk;
        walk = [&](const json& arr, std::vector<int>& path) {
            if (!arr.is_array()) return;
            for (int i = 0; i < static_cast<int>(arr.size()); ++i) {
                const auto& it = arr[i];
                if (!it.is_object()) continue;
                path.push_back(i);
                const std::string uuid = it.value("uuid", std::string{});
                if (!uuid.empty()) {
                    ItemFacts f;
                    f.name      = it.value("displayName", std::string{});
                    f.color     = it.value("color", std::string{});
                    f.type      = it.value("type",  std::string{});
                    f.duration  = it.value("duration", 0.0);
                    f.in_point  = it.value("inPoint",  0.0);
                    f.out_point = it.value("outPoint", 0.0);
                    f.index     = path;
                    facts.emplace(uuid, std::move(f));
                }
                if (it.value("type", std::string{}) == "group" &&
                    it.contains("children")) {
                    walk(it["children"], path);
                }
                path.pop_back();
            }
        };
        std::vector<int> path;
        if (document_.contains("items")) walk(document_["items"], path);

        // Cart-only items live outside the playlist tree — record their names
        // so cart bindings resolve, but with no index path.
        if (document_.contains("cartOnlyItems") && document_["cartOnlyItems"].is_array()) {
            for (const auto& it : document_["cartOnlyItems"]) {
                if (!it.is_object()) continue;
                const std::string uuid = it.value("uuid", std::string{});
                if (uuid.empty() || facts.count(uuid)) continue;
                ItemFacts f;
                f.name      = it.value("displayName", std::string{});
                f.color     = it.value("color", std::string{});
                f.type      = it.value("type",  std::string{});
                f.duration  = it.value("duration", 0.0);
                f.in_point  = it.value("inPoint",  0.0);
                f.out_point = it.value("outPoint", 0.0);
                facts.emplace(uuid, std::move(f));
            }
        }

        cue_pairs.reserve(item_uuid_to_cue_.size());
        for (const auto& [uuid, cue] : item_uuid_to_cue_) {
            double duration = 0.0;
            if (auto it = cues_.find(cue.value); it != cues_.end())
                duration = it->second.duration_seconds;
            cue_pairs.emplace_back(uuid, cue, duration);
        }

        override_uuid = next_item_override_;
        selected_uuid = selected_item_uuid_;
        show_mode_now = show_mode_;
        locale_now    = ui_locale_;
        trigger_seq   = item_trigger_seq_;

        if (document_.contains("cartItems") && document_["cartItems"].is_array()) {
            for (const auto& c : document_["cartItems"]) {
                if (c.is_object()) cart_bindings.push_back(c);
            }
        }
    }

    // Engine pass: which cues are on air, and where are their playheads.
    struct OnAir {
        std::string           uuid;
        std::string           cue_id;
        audio::TransportState transport;
        double                playhead = 0.0;
        double                duration = 0.0;
    };
    std::vector<OnAir> on_air;
    for (const auto& [uuid, cue, duration] : cue_pairs) {
        auto pi = engine_.find_cue(cue);
        if (!pi) continue;
        const auto s = pi->stats();
        if (s.transport == audio::TransportState::Stopped) continue;
        on_air.push_back(OnAir{uuid, cue.value, s.transport, s.playhead_seconds, duration});
    }
    // Document order (index path, lexicographic); cart-only items last.
    std::sort(on_air.begin(), on_air.end(), [&](const OnAir& a, const OnAir& b) {
        const auto& ia = facts[a.uuid].index;
        const auto& ib = facts[b.uuid].index;
        if (ia.empty() != ib.empty()) return ib.empty();
        return ia < ib;
    });

    json playing = json::array();
    for (const auto& e : on_air) {
        const auto& f = facts[e.uuid];
        // Effective bounds honour inPoint / outPoint trims the same way the
        // client's transport display does.
        const double duration  = (f.duration > 0.0) ? f.duration : e.duration;
        const double end       = (f.out_point > f.in_point) ? f.out_point
                                : (duration > 0.0 ? duration : e.playhead);
        const double elapsed   = std::max(0.0, e.playhead - f.in_point);
        const double eff_dur   = std::max(0.0, end - f.in_point);
        json entry{
            {"itemUuid",     e.uuid},
            {"cueId",        e.cue_id},
            {"name",         f.name},
            {"color",        f.color},
            {"transport",    transport_state_name(e.transport)},
            {"paused",       e.transport == audio::TransportState::Paused},
            {"playheadSec",  e.playhead},
            {"elapsedSec",   elapsed},
            {"durationSec",  eff_dur},
            {"remainingSec", std::max(0.0, eff_dur - elapsed)},
        };
        if (!f.index.empty()) entry["index"] = f.index;
        // Firing order, so a control surface can show the cue the operator
        // triggered last rather than the topmost one in the playlist.
        if (auto ts = trigger_seq.find(e.uuid); ts != trigger_seq.end())
            entry["triggerSeq"] = ts->second;
        playing.push_back(std::move(entry));
    }

    // Effective "Up Next": user override first, else derived from the
    // currently-playing item's endBehavior (client GO-button parity).
    std::string next_uuid   = override_uuid;
    std::string next_source = next_uuid.empty() ? "" : "override";
    if (next_uuid.empty() && !on_air.empty()) {
        std::lock_guard lock{mutex_};
        for (const auto& e : on_air) {
            const auto n = resolve_next_item_locked(e.uuid);
            if (!n.empty()) { next_uuid = n; next_source = "auto"; break; }
        }
    }
    json next = nullptr;
    if (!next_uuid.empty()) {
        next = json{{"itemUuid", next_uuid}, {"source", next_source}};
        if (auto it = facts.find(next_uuid); it != facts.end()) {
            next["name"]  = it->second.name;
            next["color"] = it->second.color;
            next["type"]  = it->second.type;
            if (!it->second.index.empty()) next["index"] = it->second.index;
        }
    }

    // Selected playlist item. Reported even when the uuid has gone stale (the
    // item was deleted by another client) so a surface can tell "selection
    // points nowhere" apart from "nothing is selected".
    json selection = nullptr;
    if (!selected_uuid.empty()) {
        selection = json{{"itemUuid", selected_uuid}};
        if (auto it = facts.find(selected_uuid); it != facts.end()) {
            selection["name"]  = it->second.name;
            selection["color"] = it->second.color;
            selection["type"]  = it->second.type;
            if (!it->second.index.empty()) selection["index"] = it->second.index;
        }
        selection["onAir"] = std::any_of(on_air.begin(), on_air.end(),
                                         [&](const OnAir& e){ return e.uuid == selected_uuid; });
    }

    // Cart bindings, decorated with the bound item's name, colour + live state.
    json cart = json::array();
    for (const auto& c : cart_bindings) {
        const int slot = c.value("slot", -1);
        const std::string uuid = c.value("itemUuid", std::string{});
        if (slot < 0 || uuid.empty()) continue;
        json entry{{"slot", slot}, {"itemUuid", uuid}};
        if (auto it = facts.find(uuid); it != facts.end()) {
            entry["name"]  = it->second.name;
            entry["color"] = it->second.color;
        }
        entry["playing"] = std::any_of(on_air.begin(), on_air.end(),
                                       [&](const OnAir& e){ return e.uuid == uuid; });
        cart.push_back(std::move(entry));
    }

    return json{
        {"project", std::move(project_block)},
        {"playing", std::move(playing)},
        {"next",    std::move(next)},
        {"selection", std::move(selection)},
        {"ui", json{
            {"showMode", show_mode_now},
            {"locale",   locale_now},
        }},
        {"master", json{
            {"gainDb",         engine_.master_gain_db()},
            {"limiterEnabled", engine_.limiter_enabled()},
        }},
        {"cart",    std::move(cart)},
        {"preview", json{
            {"active",   !current_preview_item_uuid().empty()},
            {"itemUuid", current_preview_item_uuid()},
        }},
    };
}

std::string ProjectState::go() {
    std::string target;
    {
        std::lock_guard lock{mutex_};
        target = next_item_override_;
    }
    const bool from_override = !target.empty();

    if (target.empty()) {
        // No override armed — derive from the currently-playing item's
        // endBehavior, the same fallback the client's GO button uses.
        std::vector<std::pair<std::string, audio::CueId>> pairs;
        {
            std::lock_guard lock{mutex_};
            pairs.reserve(item_uuid_to_cue_.size());
            for (const auto& [u, c] : item_uuid_to_cue_) pairs.emplace_back(u, c);
        }
        std::vector<std::string> on_air;
        for (const auto& [u, c] : pairs) {
            if (auto pi = engine_.find_cue(c)) {
                if (pi->stats().transport != audio::TransportState::Stopped)
                    on_air.push_back(u);
            }
        }
        {
            std::lock_guard lock{mutex_};
            for (const auto& u : on_air) {
                const auto n = resolve_next_item_locked(u);
                if (!n.empty()) { target = n; break; }
            }
        }
    }

    if (target.empty()) return {};
    if (!trigger_item(target)) return {};
    // Consume the override only after a successful trigger so a GO against a
    // not-yet-loaded item doesn't silently disarm the operator's choice.
    if (from_override) set_next_item_override("");
    return target;
}

std::string ProjectState::cart_slot_item_uuid(int slot) const {
    std::lock_guard lock{mutex_};
    if (!document_.contains("cartItems") || !document_["cartItems"].is_array())
        return {};
    for (const auto& c : document_["cartItems"]) {
        if (c.is_object() && c.value("slot", -1) == slot)
            return c.value("itemUuid", std::string{});
    }
    return {};
}

// Dispatch by item type: audio → play_item; group → walk startBehavior
// (play-first plays the first child recursively; play-all triggers every
// child). Mirrors the client's triggerGroup() so auto-next / Up Next
// override / goto-item behave consistently when the target is a group.
bool ProjectState::trigger_item(const std::string& uuid,
                                double fade_in_override_sec,
                                const audio::CueId& exclude_from_ducking) {
    std::lock_guard lifecycle_lock{playback_lifecycle_mutex_};
  // Guard the whole body: a malformed item field must never throw uncaught
  // into the network layer. (#5)
  try {
    // Look up the item's type and (for groups) startBehavior + children.
    std::string type;
    std::string start_action;
    std::vector<std::string> child_uuids;
    {
        std::lock_guard lock{mutex_};
        json* found = nullptr;
        json& doc = document_;
        std::function<void(json&)> walk;
        walk = [&](json& arr) {
            if (found || !arr.is_array()) return;
            for (auto& it : arr) {
                if (found) return;
                if (!it.is_object()) continue;
                if (it.value("uuid", std::string{}) == uuid) { found = &it; return; }
                if (it.value("type", std::string{}) == "group" &&
                    it.contains("children")) walk(it["children"]);
            }
        };
        if (doc.contains("items"))              walk(doc["items"]);
        if (!found && doc.contains("cartOnlyItems")) walk(doc["cartOnlyItems"]);
        if (!found) return false;

        type = found->value("type", std::string{});
        if (type == "group") {
            if (found->contains("startBehavior") &&
                (*found)["startBehavior"].is_object()) {
                start_action = (*found)["startBehavior"]
                                   .value("action", std::string{"play-first"});
            } else {
                start_action = "play-first";
            }
            if (found->contains("children") && (*found)["children"].is_array()) {
                for (auto& c : (*found)["children"]) {
                    if (c.is_object()) {
                        auto u = c.value("uuid", std::string{});
                        if (!u.empty()) child_uuids.push_back(std::move(u));
                    }
                }
            }
        }
    }

    if (type == "audio") {
        return play_item(uuid, fade_in_override_sec, exclude_from_ducking);
    }
    if (type == "group") {
        if (child_uuids.empty()) return false;

        bool triggered = false;
        if (start_action == "play-all") {
            for (const auto& child_uuid : child_uuids) {
                if (trigger_item(child_uuid, fade_in_override_sec,
                                 exclude_from_ducking)) triggered = true;
            }
        } else {
            // Default / "play-first": trigger only the first child.
            triggered = trigger_item(child_uuids.front(), fade_in_override_sec,
                                     exclude_from_ducking);
        }

        // A group-level Up Next choice is spent only after at least one child
        bool armed_here = false;
        {
            std::lock_guard lock{mutex_};
            armed_here = detail::should_consume_group_override(
                next_item_override_, uuid, triggered);
        }
        if (armed_here) set_next_item_override("", /*manual=*/false);
        return triggered;
    }
    return false;
  } catch (const std::exception& e) {
    Logger::error("ProjectState::trigger_item('{}') failed: {}", uuid, e.what());
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-device routing — each cue with a `deviceOverride` is wired through a
// dedicated mixer + pair of master channels into that specific output
// device. Items without an override fall through to the engine's default
// Main mixer (master channels 0/1, default device).
// ---------------------------------------------------------------------------
void ProjectState::release_device_routings() {
    std::lock_guard routing_lock{device_routing_mutex_};
    std::vector<DeviceRouting> stale;
    {
        std::lock_guard lock{mutex_};
        stale.reserve(device_routings_.size());
        for (const auto& [_, routing] : device_routings_)
            stale.push_back(routing);
        device_routings_.clear();
        next_override_master_ = 2;
    }
    for (const auto& routing : stale) {
        engine_.remove_mixer_channel(routing.mixer);
        engine_.clear_master_assignment(routing.master_l);
        engine_.clear_master_assignment(routing.master_r);
        engine_.close_device(routing.device);
    }
}

audio::MixerChannelId
ProjectState::ensure_device_routing(const std::string& device_name) {
    return ensure_device_routing_impl(device_name, device_name, std::nullopt);
}

audio::MixerChannelId ProjectState::ensure_device_routing_impl(
    const std::string& routing_key,
    const std::string& device_name,
    std::optional<audio::DeviceId> required_open_device) {
    std::lock_guard routing_lock{device_routing_mutex_};
    if (routing_key.empty() || device_name.empty()) return {};
    {
        std::lock_guard lock{mutex_};
        if (required_open_device) {
            for (const auto& [_, routing] : device_routings_) {
                if (routing.device.value == required_open_device->value) {
                    return routing.mixer;
                }
            }
        } else {
            const auto it = device_routings_.find(routing_key);
            if (it != device_routings_.end()) return it->second.mixer;
        }
    }

    // Device-name matching is intentionally delegated to the engine only
    // after callers that require exact matching have resolved a catalog entry.
    const auto dev = engine_.open_device_by_name(device_name, 2);
    if (dev.empty()) {
        Logger::warn("ensure_device_routing: could not open '{}'", device_name);
        return {};
    }
    if (required_open_device && dev.value != required_open_device->value) {
        engine_.close_device(dev);
        Logger::warn("ensure_device_routing: '{}' did not resolve to required id '{}'",
                     device_name, required_open_device->value);
        return {};
    }

    // Re-use an existing strip for the same native device even when one caller
    // selected it by stable catalog name and another by its ephemeral open id.
    audio::MixerChannelId existing_mixer;
    {
        std::lock_guard lock{mutex_};
        for (const auto& [_, routing] : device_routings_) {
            if (routing.device.value == dev.value) {
                existing_mixer = routing.mixer;
                break;
            }
        }
    }
    if (!existing_mixer.empty()) {
        engine_.close_device(dev);  // release the reference just acquired
        return existing_mixer;
    }

    audio::MasterChannelIndex master_l{};
    audio::MasterChannelIndex master_r{};
    bool masters_available = false;
    {
        std::lock_guard lock{mutex_};
        // Bound-check master allocation. Each distinct device override consumes
        // a pair of master channels growing upward from next_override_master_,
        // while the top two channels of the bus are reserved for preview.
        const audio::MasterChannelIndex bus_width = engine_.config().master_channels;
        const audio::MasterChannelIndex reserved_base =
            (bus_width >= 2) ? static_cast<audio::MasterChannelIndex>(bus_width - 2) : 0;
        masters_available = next_override_master_ + 1 < reserved_base;
        if (masters_available) {
            master_l = next_override_master_;
            master_r = next_override_master_ + 1;
            next_override_master_ += 2;
        } else {
            Logger::error(
                "ensure_device_routing: out of master channels for '{}' "
                "(next={}, reserved_base={}, bus_width={}); item will use "
                "default routing instead of a dedicated device master",
                device_name, next_override_master_, reserved_base, bus_width);
        }
    }
    if (!masters_available) {
        engine_.close_device(dev);
        return {};
    }

    const auto mixer = engine_.create_mixer_channel("Output: " + device_name);
    engine_.assign_master_to_device(master_l, dev, 0);
    engine_.assign_master_to_device(master_r, dev, 1);
    engine_.route_mixer_to_master(mixer, master_l, 0.0f, 0);
    engine_.route_mixer_to_master(mixer, master_r, 0.0f, 1);

    {
        std::lock_guard lock{mutex_};
        device_routings_[routing_key] = DeviceRouting{dev, mixer, master_l, master_r};
    }
    Logger::info("ensure_device_routing: '{}' → mixer '{}' (masters {}/{})",
                 device_name, mixer.value, master_l, master_r);
    return mixer;
}
void ProjectState::route_cue_to_mixer(const audio::CueId& cue,
                                      const audio::MixerChannelId& mixer) {
    auto pi = engine_.find_cue(cue);
    if (!pi) return;
    const auto src_count = pi->source_channel_count();
    // The LTC synthetic channel is always the LAST source channel — it must
    // never feed the audible mixer (it gets its own device routing from
    // apply_ltc_device_routing()). Only the real audio channels route here.
    const audio::ChannelCount audio_count =
        (pi->desc().ltc_enabled && src_count > 0) ? src_count - 1 : src_count;

    // Drop ALL prior item-to-mixer routes for this cue — including the engine's
    // auto-created "Main" mixer, which ProjectState does NOT track by id. The
    // previous implementation only unrouted from mixers we knew about (mixers_
    // + device_routings_), so a cue pinned to a specific output device stayed
    // routed to Main → the platform-default device as well and played out of
    // both. (The LTC synthetic channel is re-established by the
    // apply_ltc_device_routing() call that follows routing in play_item.)
    engine_.unroute_item_from_all_mixers(cue);

    if (audio_count == 1) {
        // Mono cue: fan the single channel across both strip lanes (centre).
        engine_.route_item_source_to_mixer(cue, 0, mixer, 0.0f,
                                           audio::kAllMixerLanes);
    } else {
        // Stereo (or wider): L → lane 0, R → lane 1, preserving the image.
        for (audio::ChannelIndex c = 0;
             c < std::min<audio::ChannelCount>(audio::kMixerLanes, audio_count); ++c) {
            engine_.route_item_source_to_mixer(cue, c, mixer, 0.0f, c);
        }
    }
}

// ---------------------------------------------------------------------------
// Preview routing — independent playback of a cue through the configured
// preview device, used for DJ-style pre-listening. The infrastructure
// (device + mixer + master assignments) is set up lazily on first preview
// and reused for subsequent ones.
// ---------------------------------------------------------------------------
namespace {
// Master channels reserved for preview output. Picked from the tail of the
// 32-channel master bus so they don't collide with project routing.
constexpr audio::MasterChannelIndex kPreviewMasterL = 30;
constexpr audio::MasterChannelIndex kPreviewMasterR = 31;
}  // namespace

bool ProjectState::start_preview(const std::string& item_uuid) {
    if (item_uuid.empty()) return false;

    // 1. Resolve the source file path under the lock.
    std::filesystem::path file_path;
    double in_point = 0.0;
    double out_point = 0.0;
    bool loop = false;
    std::string preview_device_name;
    {
        std::lock_guard lock{mutex_};
        // path
        for_each_item(document_,
            [&](json& it, const std::string&) {
                if (it.value("uuid", std::string{}) != item_uuid) return;
                auto p = resolve_media_path(
                    it, document_.value("folderPath", std::string{}));
                if (!p.empty()) file_path = std::move(p);
                in_point = it.value("inPoint", 0.0);
                out_point = it.value("outPoint", 0.0);
                loop = it.contains("endBehavior") && it["endBehavior"].is_object()
                    && it["endBehavior"].value("action", std::string{}) == "loop";
            });
        // settings.previewDevice
        if (document_.contains("settings") && document_["settings"].is_object()) {
            const auto& s = document_["settings"];
            if (s.contains("previewDevice") && s["previewDevice"].is_string()) {
                preview_device_name = s["previewDevice"].get<std::string>();
            }
        }
    }
    if (file_path.empty()) {
        Logger::warn("preview: item '{}' has no resolvable file path", item_uuid);
        return false;
    }

    // 2. Tear down any in-flight preview cleanly. Keep the mixer + device
    // open if we have them — they're reused below.
    {
        audio::CueId prev_cue;
        {
            std::lock_guard lock{mutex_};
            prev_cue = preview_cue_;
            preview_cue_ = audio::CueId{};
            preview_item_uuid_.clear();
        }
        if (!prev_cue.empty()) {
            engine_.stop(prev_cue);
            engine_.unload_cue(prev_cue);
        }
    }

    // 3. Ensure preview infrastructure (device open + mixer + master wiring).
    audio::MixerChannelId preview_mixer;
    {
        // If the user changed the preview device since our last setup,
        // close the old one and start fresh.
        std::string current_name;
        audio::DeviceId current_device;
        audio::MixerChannelId current_mixer;
        {
            std::lock_guard lock{mutex_};
            current_name   = preview_device_name_;
            current_device = preview_device_;
            current_mixer  = preview_mixer_;
        }

        if (preview_device_name.empty()) {
            Logger::warn("preview: no preview device configured in settings");
            return false;
        }

        if (current_name != preview_device_name && !current_device.empty()) {
            // Close old preview device + mixer.
            engine_.close_device(current_device);
            if (!current_mixer.empty()) engine_.remove_mixer_channel(current_mixer);
            std::lock_guard lock{mutex_};
            preview_device_ = audio::DeviceId{};
            preview_mixer_  = audio::MixerChannelId{};
            preview_device_name_.clear();
        }

        if (preview_device_.empty()) {
            // Open the device, create a dedicated "Preview" mixer, wire it.
            const auto dev = engine_.open_device_by_name(preview_device_name, 2);
            if (dev.empty()) {
                Logger::warn("preview: could not open device '{}'", preview_device_name);
                return false;
            }
            const auto mixer = engine_.create_mixer_channel("Preview");
            engine_.assign_master_to_device(kPreviewMasterL, dev, 0);
            engine_.assign_master_to_device(kPreviewMasterR, dev, 1);
            engine_.route_mixer_to_master(mixer, kPreviewMasterL, 0.0f, 0);
            engine_.route_mixer_to_master(mixer, kPreviewMasterR, 0.0f, 1);
            {
                std::lock_guard lock{mutex_};
                preview_device_      = dev;
                preview_mixer_       = mixer;
                preview_device_name_ = preview_device_name;
                preview_mixer = mixer;
            }
        } else {
            preview_mixer = preview_mixer_;
        }
    }

    // 4. Load the file as a fresh engine cue, route it to the preview mixer
    // ONLY (no auto-routing to Main). prime + play.
    const auto cue_id = engine_.load_cue_no_route(file_path);
    if (cue_id.empty()) return false;

    auto pi = engine_.find_cue(cue_id);
    if (pi) {
        if (pi->source_channel_count() >= 2) {
            // Stereo: L → lane 0, R → lane 1.
            engine_.route_item_source_to_mixer(cue_id, 0, preview_mixer, 0.0f, 0);
            engine_.route_item_source_to_mixer(cue_id, 1, preview_mixer, 0.0f, 1);
        } else {
            // Mono: fan across both lanes.
            engine_.route_item_source_to_mixer(cue_id, 0, preview_mixer, 0.0f,
                                               audio::kAllMixerLanes);
        }
        pi->set_out_point_seconds(out_point > in_point ? out_point : 0.0);
        pi->set_loop(loop, in_point);
        pi->prime(2.0, in_point);
    }
    engine_.play(cue_id);

    {
        std::lock_guard lock{mutex_};
        preview_cue_       = cue_id;
        preview_item_uuid_ = item_uuid;
    }
    Logger::info("preview: started for item '{}' on '{}'", item_uuid, preview_device_name);
    return true;
}

bool ProjectState::stop_preview() {
    audio::CueId cue;
    {
        std::lock_guard lock{mutex_};
        cue = preview_cue_;
        preview_cue_ = audio::CueId{};
        preview_item_uuid_.clear();
    }
    if (cue.empty()) return false;
    engine_.stop(cue);
    engine_.unload_cue(cue);
    Logger::info("preview: stopped");
    return true;
}

std::string ProjectState::current_preview_item_uuid() const {
    std::lock_guard lock{mutex_};
    return preview_item_uuid_;
}

audio::CueId ProjectState::current_preview_cue_id() const {
    std::lock_guard lock{mutex_};
    return preview_cue_;
}

// ---------------------------------------------------------------------------
// Cart slot bindings
// ---------------------------------------------------------------------------
bool ProjectState::set_cart_slot(int slot, const std::string& item_uuid) {
    if (slot < 0 || slot >= 64) return false;
    std::lock_guard lock{mutex_};
    if (!document_.contains("cartItems") || !document_["cartItems"].is_array()) {
        document_["cartItems"] = json::array();
    }
    auto& arr = document_["cartItems"];
    // Remove any existing binding for this slot.
    arr.erase(std::remove_if(arr.begin(), arr.end(),
                             [&](const json& c){
                                 return c.value("slot", -1) == slot;
                             }),
              arr.end());
    arr.push_back(json{
        {"slot",     slot},
        {"itemUuid", item_uuid},
        {"index",    json::array({-1, slot})},
    });
    return true;
}

bool ProjectState::clear_cart_slot(int slot) {
    std::lock_guard lock{mutex_};
    if (!document_.contains("cartItems") || !document_["cartItems"].is_array()) {
        return false;
    }
    auto& arr = document_["cartItems"];
    const auto before = arr.size();
    arr.erase(std::remove_if(arr.begin(), arr.end(),
                             [&](const json& c){
                                 return c.value("slot", -1) == slot;
                             }),
              arr.end());
    return arr.size() != before;
}

// ---------------------------------------------------------------------------
// Theme + settings patches
// ---------------------------------------------------------------------------
bool ProjectState::patch_theme(const json& patch) {
    if (!patch.is_object()) return false;
    std::lock_guard lock{mutex_};
    if (!document_.contains("theme") || !document_["theme"].is_object()) {
        document_["theme"] = json::object();
    }
    for (auto& [k, v] : patch.items()) document_["theme"][k] = v;
    return true;
}

bool ProjectState::patch_settings(const json& patch) {
    if (!patch.is_object()) return false;
    if (auto ceiling = patch.find("limiterCeilingDb");
        ceiling != patch.end() && !ceiling->is_null()) {
        if (!ceiling->is_number()) return false;
        const double db = ceiling->get<double>();
        if (!std::isfinite(db) || db < -60.0 || db > 0.0) return false;
    }
    if (auto count = patch.find("cartSlotCount");
        count != patch.end() && !count->is_null()) {
        if (!count->is_number_integer()) return false;
        const auto slots = count->get<std::int64_t>();
        if (slots < 1 || slots > 64) return false;
    }
    bool ltc_device_changed      = false;
    bool default_device_changed  = false;
    bool preview_device_changed  = false;
    bool output_target_changed   = false;
    bool limiter_ceiling_changed = false;
    bool limiter_toggle_changed  = false;
    bool limiter_disabled        = false;
    bool ballistics_changed      = false;
    bool meter_mode_changed      = false;
    bool meter_true_peak         = false;
    bool meter_loudness          = false;
    float new_ceiling_db         = -0.1f;
    audio::MeterBallistics new_ballistics{};
    {
        std::lock_guard lock{mutex_};
        if (!document_.contains("settings") || !document_["settings"].is_object()) {
            document_["settings"] = json::object();
        }
        for (auto& [k, v] : patch.items()) {
            if (k == "ltcDevice")           ltc_device_changed     = true;
            if (k == "defaultOutputDevice") default_device_changed = true;
            if (k == "previewDevice")       preview_device_changed = true;
            if (k == "outputTarget")        output_target_changed  = true;
            if (k == "limiterCeilingDb") {
                limiter_ceiling_changed = true;
                if (v.is_null()) {
                    document_["settings"].erase(k);
                    continue;
                }
            }
            if (k == "disableLimiter") {
                limiter_toggle_changed = true;
                limiter_disabled       = v.is_boolean() ? v.get<bool>() : false;
            }
            if (k == "meterBallistics" || k == "meterBallisticsCustom") {
                ballistics_changed = true;
            }
            // meterMode selects the display unit; outputTarget changes the
            // default unit, so both can flip the effective mode.
            if (k == "meterMode" || k == "outputTarget") {
                meter_mode_changed = true;
            }
            document_["settings"][k] = v;
        }
        if (output_target_changed || limiter_ceiling_changed) {
            const auto levels = compute_output_target_levels(document_["settings"]);
            new_ceiling_db = levels.value("limiterCeilingDb", -0.1f);
            // Keep the embedded outputTargetLevels in sync so every broadcast
            // (settings_patched, full_document) carries the fresh zone colours
            // and ceiling rather than the stale values from before the change.
            document_["settings"]["outputTargetLevels"] = levels;
        }
        if (ballistics_changed) {
            new_ballistics = meter_ballistics_from_settings(document_["settings"]);
        }
        if (meter_mode_changed) {
            const auto mode = effective_meter_mode(document_["settings"]);
            meter_true_peak = mode == "dBTP";
            meter_loudness  = mode == "LUFS";
        }
    }
    // Re-apply device routing when device selections change mid-playback.
    if (ltc_device_changed)     apply_ltc_device_routing();
    if (default_device_changed) apply_default_device_routing();
    if (preview_device_changed) apply_preview_device_change();
    // Apply true-peak limiter ceiling for the chosen output platform.
    if (output_target_changed || limiter_ceiling_changed)
        engine_.set_master_ceiling_db(new_ceiling_db);
    // Enable/disable the limiter live so the change is heard immediately.
    if (limiter_toggle_changed) engine_.set_limiter_enabled(!limiter_disabled);
    // Retune every meter live so the operator sees the new feel immediately.
    if (ballistics_changed)     engine_.set_meter_ballistics(new_ballistics);
    // Gate the true-peak / loudness DSP on the effective display mode.
    if (meter_mode_changed) {
        engine_.set_true_peak_metering(meter_true_peak);
        engine_.set_loudness_metering(meter_loudness);
    }
    return true;
}

bool ProjectState::is_legacy_document(const json& doc) const {
    // Heuristic: v2 always has schema_version >= 2.
    if (doc.contains("schema_version") &&
        doc["schema_version"].is_number() &&
        doc["schema_version"].get<int>() >= 2) {
        return false;
    }
    // Anything else with a `carts` or `playlist` array we treat as 1.x.
    return doc.contains("carts") || doc.contains("playlist") || doc.contains("cues_legacy");
}

json ProjectState::upgrade_legacy_document(const json& legacy) const {
    // Conservative translator: build a v2 doc that mirrors 1.x semantics —
    // each cue routes its source channels straight to the default device's
    // hardware channels 0 and 1 (stereo). Mixer channels are auto-created
    // per-cue so individual fades/gains still apply.
    json out;
    out["schema_version"] = 2;
    out["project_name"]   = legacy.value("name", "Untitled (upgraded)");
    out["media_root"]     = legacy.value("media_root", media_root_.string());
    out["cues"]              = json::array();
    out["mixer_channels"]    = json::array();
    out["item_routes"]       = json::array();
    out["mixer_routes"]      = json::array();
    out["master_assignments"]= json::array();

    auto add_cue = [&](const json& src) {
        json c;
        c["id"]            = src.value("id", "");
        c["display_name"]  = src.value("name", src.value("title", "Cue"));
        c["file_path"]     = src.value("path", src.value("file", ""));
        c["artist"]        = src.value("artist", "");
        c["title"]         = src.value("title", "");
        c["duration_sec"]  = src.value("duration", 0.0);
        c["gain_db"]       = src.value("gain_db", src.value("volume_db", 0.0));
        c["fade_in_ms"]    = src.value("fade_in_ms",  static_cast<long long>(0));
        c["fade_out_ms"]   = src.value("fade_out_ms", static_cast<long long>(0));
        c["ltc_enabled"]        = false;
        c["ltc_fps"]            = 4;
        c["ltc_offset_ns"]      = 0;
        c["ltc_start_timecode"] = "00:00:00:00";
        out["cues"].push_back(std::move(c));
    };
    if (legacy.contains("carts") && legacy["carts"].is_array()) {
        for (auto& cart : legacy["carts"]) add_cue(cart);
    }
    if (legacy.contains("playlist") && legacy["playlist"].is_array()) {
        for (auto& it : legacy["playlist"]) add_cue(it);
    }
    if (legacy.contains("cues_legacy") && legacy["cues_legacy"].is_array()) {
        for (auto& it : legacy["cues_legacy"]) add_cue(it);
    }

    // Default device → stereo master channels 0 and 1. The engine fills in the
    // actual DeviceId on apply_to_engine_locked() because we don't know it
    // until a device is opened.
    json a0{{"master_channel", 0}, {"device", ""}, {"hw_channel", 0}};
    json a1{{"master_channel", 1}, {"device", ""}, {"hw_channel", 1}};
    out["master_assignments"].push_back(a0);
    out["master_assignments"].push_back(a1);
    return out;
}

bool ProjectState::load_from_json(const json& doc_in) {
    std::optional<project_file::PreparedDocument> client_document;
    if (project_file::is_client_document(doc_in)) {
        project_file::PreparedDocument prepared;
        std::string preparation_error;
        if (!project_file::prepare_client_document(
                doc_in, std::nullopt, prepared, preparation_error)) {
            Logger::error("ProjectState::load_from_json: {}", preparation_error);
            return false;
        }
        client_document = std::move(prepared);
    }

    std::lock_guard lifecycle_lock{playback_lifecycle_mutex_};
    {
        std::lock_guard slock{sequencer_mutex_};
        sequenced_items_.clear();
        playback_generations_.cancel_all();
    }
    // A project switch is a hard routing/decoder lifetime boundary. Quiesce
    // the old mirror before releasing its per-project device ownership.
    {
        std::lock_guard mirror_lock{mirror_mutex_};
        if (load_thread_.joinable()) load_thread_.join();
    }
    release_device_routings();
    // Canonical .dwcue documents use the camelCase desktop schema. Keep the
    // full document for clients while mirroring its engine-facing state.
    if (client_document) {
        if (client_document->cart_migrated)
            Logger::info("ProjectState: migrated legacy Cart data to One Shots.");
        RepairInfo repair{
            client_document->repair.repaired,
            client_document->repair.issues,
        };
        if (repair.repaired) {
            Logger::warn("ProjectState::load_from_json: project repaired ({} issue(s)).",
                         repair.issues.size());
            for (const auto& issue : repair.issues)
                Logger::warn("  - {}", issue);
        }

        {
            std::lock_guard lock{mutex_};
            // Unload any previously-loaded engine cues so we start clean.
            for (auto& [_, id] : item_uuid_to_cue_) engine_.unload_cue(id);
            item_uuid_to_cue_.clear();
            cues_.clear();
            mixers_.clear();
            item_routes_.clear();
            mixer_routes_.clear();
            master_assignments_.clear();

            ++document_generation_;
            document_ = std::move(client_document->document);
            project_name_ = document_.value("name", std::string{"Untitled"});
            update_media_root_from_folder_locked();
            pending_repair_info_ = std::move(repair);
        }

        // Audio mirroring happens off-thread so the client can render the
        // project immediately. Items not yet loaded into the engine will
        // simply fail play() until ready (rare in practice — by the time the
        // user clicks anything, the first batch is usually done).
        start_async_mirror();
        // Arm the first playable item as "Up Next" so the operator's very first
        // GO fires without a click (#28). Reads the document (available now) and
        // is a no-op if something is already armed / playing. Runs after the
        // async mirror kickoff — cues_ is empty at this instant, so the "nothing
        // on air" guard passes on a fresh open.
        arm_first_item_on_open();
        return true;
    }

    // Otherwise: assume server's snake_case schema (current behaviour).
    json doc = doc_in;
    if (is_legacy_document(doc)) {
        Logger::info("ProjectState: detected legacy 1.x document, upgrading.");
        doc = upgrade_legacy_document(doc);
    }

    std::lock_guard lock{mutex_};
    for (auto& [_, id] : item_uuid_to_cue_) engine_.unload_cue(id);
    item_uuid_to_cue_.clear();
    cues_.clear();
    mixers_.clear();
    item_routes_.clear();
    mixer_routes_.clear();
    master_assignments_.clear();
    ++document_generation_;
    document_ = default_empty_document();
    apply_audio_settings(engine_, document_["settings"]);

    project_name_ = doc.value("project_name", std::string{"Untitled"});
    if (doc.contains("media_root") && doc["media_root"].is_string()) {
        media_root_ = util::utf8_to_path(doc["media_root"].get<std::string>());
    }
    // The project folder always wins: media must live inside it so the project
    // stays portable and we never read media from outside the folder. load()
    // injects the authoritative folderPath (the directory the .dwcue sits
    // in) before calling us, so this overrides any stale stored media_root.
    if (doc.contains("folderPath") && doc["folderPath"].is_string()) {
        const std::string folder = doc["folderPath"].get<std::string>();
        if (!folder.empty()) media_root_ = util::utf8_to_path(folder) / "media";
    }

    if (doc.contains("cues") && doc["cues"].is_array()) {
        for (auto& c : doc["cues"]) {
            CueMeta m;
            m.id = audio::CueId{c.value("id", std::string{})};
            m.display_name     = c.value("display_name", "");
            m.file_path        = util::utf8_to_path(c.value("file_path", std::string{}));
            m.artist           = c.value("artist", "");
            m.title            = c.value("title", "");
            m.duration_seconds = c.value("duration_sec", 0.0);
            m.gain_db          = c.value("gain_db", 0.0f);
            m.fade_in_ms  = std::chrono::milliseconds{c.value("fade_in_ms",  (long long)0)};
            m.fade_out_ms = std::chrono::milliseconds{c.value("fade_out_ms", (long long)0)};
            m.ltc_enabled          = c.value("ltc_enabled",        false);
            m.ltc_frame_rate_index = c.value("ltc_fps",            4);
            m.ltc_offset_ns        = std::chrono::nanoseconds{c.value("ltc_offset_ns", (long long)0)};
            m.ltc_start_timecode   = c.value("ltc_start_timecode", std::string{"00:00:00:00"});
            cues_.emplace(m.id.value, std::move(m));
        }
    }
    if (doc.contains("mixer_channels") && doc["mixer_channels"].is_array()) {
        for (auto& m : doc["mixer_channels"]) {
            MixerChannelMeta mm;
            mm.id           = audio::MixerChannelId{m.value("id", std::string{})};
            mm.display_name = m.value("display_name", "");
            mm.gain_db      = m.value("gain_db", 0.0f);
            mm.muted        = m.value("muted",   false);
            mm.soloed       = m.value("soloed",  false);
            mixers_.emplace(mm.id.value, std::move(mm));
        }
    }
    if (doc.contains("item_routes") && doc["item_routes"].is_array()) {
        for (auto& r : doc["item_routes"]) {
            item_routes_.push_back(RouteSendV2{
                r.value("source_channel", (audio::ChannelIndex)0),
                audio::MixerChannelId{r.value("destination_mixer", std::string{})},
                r.value("gain_db", 0.0f),
                r.value("lane", audio::kAllMixerLanes),
            });
        }
    }
    if (doc.contains("mixer_routes") && doc["mixer_routes"].is_array()) {
        for (auto& r : doc["mixer_routes"]) {
            mixer_routes_.push_back(MixerToMasterV2{
                audio::MixerChannelId{r.value("mixer", std::string{})},
                r.value("master_channel", (audio::MasterChannelIndex)0),
                r.value("gain_db", 0.0f),
                r.value("lane", audio::kAllMixerLanes),
            });
        }
    }
    if (doc.contains("master_assignments") && doc["master_assignments"].is_array()) {
        for (auto& a : doc["master_assignments"]) {
            master_assignments_.push_back(MasterAssignment{
                a.value("master_channel", (audio::MasterChannelIndex)0),
                audio::DeviceId{a.value("device", std::string{})},
                a.value("hw_channel", (audio::ChannelIndex)0),
            });
        }
    }
    apply_to_engine_locked();
    return true;
}

bool ProjectState::load(const std::filesystem::path& path) {
    if (!project_file::is_native_project(path)) {
        Logger::error("ProjectState::load: native project path must use .dwcue: '{}'",
                      util::path_to_utf8(path));
        return false;
    }
    try {
        std::ifstream f{path};
        if (!f) {
            Logger::error("ProjectState::load: cannot open '{}'", util::path_to_utf8(path));
            return false;
        }
        json doc;
        f >> doc;
        // The media/ folder always lives next to the .dwcue file, so the
        // project folder is authoritatively the directory the file sits in —
        // regardless of any (possibly stale) folderPath baked into the document
        // the last time it was saved somewhere else. We rewrite it BEFORE
        // load_from_json() because that call kicks off the async engine mirror,
        // which resolves each item's media against folderPath; injecting the
        // real location first is what lets a moved project — or a legacy v1
        // project whose folderPath still points at its original home — resolve
        // its relative "media/..." paths and actually load/play.
        if (path.has_parent_path() && doc.is_object()) {
            doc["folderPath"] = util::path_to_utf8(path.parent_path());
        }
        const bool ok = load_from_json(doc);
        if (ok) {
            set_project_file_path(path);
            // Normalise media references to the portable relative form now that
            // folderPath points at the file's real location: drops stale
            // absolute mediaServerPaths so the document served to clients (and
            // written on the next save) stays portable across moves.
            std::lock_guard lock{mutex_};
            if (path.has_parent_path()) {
                document_["folderPath"] = util::path_to_utf8(path.parent_path());
            }
            relativize_media_paths(document_);
        }
        return ok;
    } catch (const std::exception& ex) {
        Logger::error("ProjectState::load failed: {}", ex.what());
        return false;
    }
}

RepairInfo ProjectState::consume_repair_info() {
    std::lock_guard lock{mutex_};
    RepairInfo result;
    std::swap(result, pending_repair_info_);
    return result;
}

RepairInfo ProjectState::repair_project() {
    json doc;
    {
        std::lock_guard lock{mutex_};
        doc = document_;
    }
    auto repaired = project_file::repair_client_document(doc);
    RepairInfo info{repaired.repaired, std::move(repaired.issues)};
    if (info.repaired) {
        std::lock_guard lock{mutex_};
        document_ = std::move(doc);
        Logger::info("ProjectState::repair_project: {} issue(s) repaired.", info.issues.size());
    }
    return info;
}

void ProjectState::apply_to_engine_locked() {
    // 1) Load every cue's file into the engine. We accept that this can fail
    //    for missing files; the entry stays in the project for the user to
    //    relocate later.
    for (auto& [_, c] : cues_) {
        const auto id = engine_.load_cue(c.file_path, c.id);
        if (!id.empty()) {
            // Cache the lookup once and null-check it — find_cue can return
            // null (e.g. the load raced with an unload) and the previous code
            // dereferenced it up to six times unchecked. (#5)
            auto cue = engine_.find_cue(id);
            if (!cue) continue;
            cue->set_gain_db(c.gain_db);
            cue->set_fade_in (c.fade_in_ms);
            cue->set_fade_out(c.fade_out_ms);
            if (c.ltc_enabled) {
                cue->set_ltc_enabled(true);
                cue->set_ltc_frame_rate(fps_index_to_rate(c.ltc_frame_rate_index));
                cue->set_ltc_offset(c.ltc_offset_ns);
            }
        }
    }
    // 2) Create mixer channels and apply their gain.
    for (auto& [_, mm] : mixers_) {
        auto created = engine_.create_mixer_channel(mm.display_name);
        // (Engine assigns a fresh id; we keep ours as the canonical one. For
        //  full round-trip we'd thread the requested id through engine — left
        //  as a follow-up so the document/engine ids stay in sync.)
        mm.id = created;
        if (auto m = engine_.find_mixer_channel(created)) {
            m->set_gain_db(mm.gain_db);
            m->set_mute (mm.muted);
            m->set_solo (mm.soloed);
        }
    }
    // 3) Re-apply routes.
    for (auto& r : item_routes_) {
        engine_.route_item_source_to_mixer(audio::CueId{}, r.source_channel,
                                           r.destination_mixer, r.gain_db,
                                           r.lane);
    }
    for (auto& r : mixer_routes_) {
        engine_.route_mixer_to_master(r.mixer, r.master_channel, r.gain_db,
                                      r.lane);
    }
    for (auto& a : master_assignments_) {
        // If the document didn't specify a device (e.g. upgraded legacy
        // project), the assignment is deferred — the control server can
        // bind it to the default device on first open.
        if (!a.device.empty()) {
            engine_.assign_master_to_device(a.master_channel, a.device, a.hw_channel);
        }
    }
}

// ---------------------------------------------------------------------------
// Sequencer — server-side auto-advance, crossfade, ducking restore
// ---------------------------------------------------------------------------
void ProjectState::start_sequencer() {
    sequencer_running_.store(true, std::memory_order_release);
    sequencer_thread_ = std::thread([this]{ sequencer_loop(); });
}

void ProjectState::stop_sequencer() {
    sequencer_running_.store(false, std::memory_order_release);
    if (sequencer_thread_.joinable()) sequencer_thread_.join();
}

void ProjectState::sequencer_loop() {
    using namespace std::chrono_literals;

    // How far before an item's out-point to start the next cue for a seamless
    // (gapless) auto-advance. Must exceed the sequencer poll interval (50 ms)
    // plus a little device/ring slack so the incoming cue is already sounding
    // by the time the outgoing reaches its out-point. The resulting overlap of
    // program tails (~0.1 s) is inaudible and replaces the previous silent gap.
    constexpr double kSeamlessLeadSec = 0.10;

    while (sequencer_running_.load(std::memory_order_acquire)) {
        std::this_thread::sleep_for(50ms);
        if (!sequencer_running_.load(std::memory_order_acquire)) break;

        struct PendingAction {
            SequencedItem item;
            enum class Kind {
                PlaybackError, // unexpected decoder read failure; never follow
                NaturalEnd,    // take_natural_end() returned true
                Crossfade,     // start next + fade out current
                BeginStopFade, // begin fading out (item stays until Stopped)
                StopFadeEnded, // stop-fade complete → fire end behavior
                StartNext,     // Start Next marker crossed: start next item,
                               // current keeps playing (or begins marker fade)
                SeamlessAdvance, // auto-advance end behaviour with no crossfade:
                                 // start next item a hair before out-point so
                                 // there's no audible gap; current plays its tail
                Cleanup,       // cue gone; restore ducking, no end behavior
                CustomAction,  // fire one of the item's customActions
            } kind;
            json custom_action{}; // populated only for Kind::CustomAction
            int decoder_result = 0; // populated only for Kind::PlaybackError
        };
        std::vector<PendingAction> pending;

        {
            std::lock_guard slock{sequencer_mutex_};
            for (auto& si : sequenced_items_) {
                auto pi = engine_.find_cue(si.cue_id);
                if (!pi) {
                    pending.push_back({si, PendingAction::Kind::Cleanup});
                    continue;
                }

                // A decoder failure is terminal but is NOT a natural end. Consume
                // it before every follow/timing check so a failed USB/network read
                // cannot run endBehavior, crossfade, Start Next, or custom actions.
                if (const int decoder_result = pi->take_decode_error();
                    decoder_result != 0) {
                    pending.push_back(
                        {si, PendingAction::Kind::PlaybackError, {}, decoder_result});
                    continue;
                }

                // Natural end takes priority over all timing checks.
                if (pi->take_natural_end()) {
                    pending.push_back({si, PendingAction::Kind::NaturalEnd});
                    continue;
                }

                // Stop-fade completed (transport settled to Stopped).
                const auto ts = pi->stats().transport;
                if (ts == audio::TransportState::Stopped && si.stop_fade_triggered) {
                    pending.push_back({si, PendingAction::Kind::StopFadeEnded});
                    continue;
                }

                const double pos = pi->stats().playhead_seconds;

                // Custom-action dispatch: any action whose time_point we've
                // crossed fires now. Snapshot the action JSON into pending so
                // we can execute it outside the lock.
                for (auto& sca : si.custom_actions) {
                    if (sca.triggered) continue;
                    if (pos < sca.time_point) continue;
                    sca.triggered = true;
                    pending.push_back({si, PendingAction::Kind::CustomAction,
                                       sca.action});
                }

                // Start Next marker: fires once when the playhead crosses it,
                // independent of effective_end (it needs no known duration).
                if (!si.start_next_triggered && si.start_next_time > 0.0 &&
                    pos >= si.start_next_time) {
                    si.start_next_triggered = true;
                    pending.push_back({si, PendingAction::Kind::StartNext});
                    // The pending copy owns the duck-restore now; clear so a
                    // later Cleanup/end can't restore stale gains a second time.
                    si.ducked.clear();
                    // A marker fade behaves like a begun stop-fade: when the
                    // transport settles to Stopped, the StopFadeEnded path
                    // removes the item (its advance is suppressed below).
                    if (si.start_next_fade_sec > 0.0)
                        si.stop_fade_triggered = true;
                }

                // Timing-based triggers only apply when we know the duration.
                if (si.effective_end <= 0.0) continue;
                const double remaining = si.effective_end - pos;

                if (!si.crossfade_triggered && si.crossfade_sec > 0.0 &&
                    remaining <= si.crossfade_sec && remaining > 0.0) {
                    si.crossfade_triggered = true;
                    pending.push_back({si, PendingAction::Kind::Crossfade});
                } else if (!si.stop_fade_triggered && si.stop_fade_sec > 0.0 &&
                           si.crossfade_sec <= 0.0 &&
                           remaining <= si.stop_fade_sec && remaining > 0.0) {
                    si.stop_fade_triggered = true;
                    pending.push_back({si, PendingAction::Kind::BeginStopFade});
                } else if (!si.advance_triggered && !si.start_next_triggered &&
                           si.crossfade_sec <= 0.0 && si.stop_fade_sec <= 0.0 &&
                           si.start_next_time <= 0.0 &&
                           (si.end_action == "next" ||
                            si.end_action == "goto-item" ||
                            si.end_action == "goto-index") &&
                           remaining <= kSeamlessLeadSec && remaining > 0.0) {
                    // Seamless auto-advance: start the next cue a hair before this
                    // one's out-point so there's no audible gap. Mark the item so
                    // its natural end doesn't advance a second time (reuse the
                    // start_next suppression path in handle_item_ended), and take
                    // ownership of the duck-restore here so Cleanup/NaturalEnd
                    // can't double-restore stale gains.
                    si.advance_triggered   = true;
                    si.start_next_triggered = true;
                    pending.push_back({si, PendingAction::Kind::SeamlessAdvance});
                    si.ducked.clear();
                }
            }

            // Remove terminal items while the lock is held.
            for (const auto& p : pending) {
                const bool terminal =
                    p.kind == PendingAction::Kind::PlaybackError ||
                    p.kind == PendingAction::Kind::NaturalEnd  ||
                    p.kind == PendingAction::Kind::Crossfade   ||
                    p.kind == PendingAction::Kind::StopFadeEnded ||
                    p.kind == PendingAction::Kind::Cleanup;
                if (terminal) {
                    sequenced_items_.erase(
                        std::remove_if(sequenced_items_.begin(), sequenced_items_.end(),
                            [&](const SequencedItem& x){ return x.uuid == p.item.uuid; }),
                        sequenced_items_.end());
                }
                // BeginStopFade items stay until they reach the Stopped state.
            }
        }

        // Execute pending actions with the sequencer lock released. Playback
        // lifecycle serialization below fences each copied action from replay
        // and cancellation; exceptions remain isolated per action.
        for (const auto& p : pending) {
            // A replay/stop/remove may have replaced or cancelled this source
            // after the action was copied above. Serialize validation and the
            // complete side effect against those lifecycle changes so stale
            // work can neither stop the new play nor advance from the old one.
            std::lock_guard lifecycle_lock{playback_lifecycle_mutex_};
            const bool terminal =
                p.kind == PendingAction::Kind::PlaybackError ||
                p.kind == PendingAction::Kind::NaturalEnd ||
                p.kind == PendingAction::Kind::Crossfade ||
                p.kind == PendingAction::Kind::StopFadeEnded ||
                p.kind == PendingAction::Kind::Cleanup;
            {
                std::lock_guard slock{sequencer_mutex_};
                const bool valid = terminal
                    ? playback_generations_.claim_terminal(
                          p.item.uuid, p.item.playback_generation)
                    : playback_generations_.is_current(
                          p.item.uuid, p.item.playback_generation);
                if (!valid) continue;
            }
          try {
            switch (p.kind) {
            case PendingAction::Kind::PlaybackError: {
                // Restore any gains this cue ducked, but deliberately do not call
                // handle_item_ended(): decoder failure must never execute a follow
                // action or arm the next cue.
                for (const auto& dk : p.item.ducked) {
                    if (auto pi = engine_.find_cue(dk.cue_id))
                        pi->set_gain_db(dk.original_gain_db);
                }

                double playhead_seconds = 0.0;
                if (auto pi = engine_.find_cue(p.item.cue_id))
                    playhead_seconds = pi->stats().playhead_seconds;

                std::function<void(const json&)> cb;
                {
                    std::lock_guard lock{mutex_};
                    cb = ui_state_broadcaster_;
                }
                Logger::error(
                    "PLAYBACK ERROR: item='{}' cue='{}' decoder_result={} at {:.3f}s; "
                    "follow action suppressed",
                    p.item.uuid, p.item.cue_id.value, p.decoder_result,
                    playhead_seconds);
                if (cb) {
                    cb(json{
                        {"type",             "playback_error"},
                        {"code",             "decoder_read_failed"},
                        {"item_uuid",        p.item.uuid},
                        {"cue_id",           p.item.cue_id.value},
                        {"playhead_seconds", playhead_seconds},
                        {"decoder_result",   p.decoder_result},
                    });
                }
                break;
            }

            case PendingAction::Kind::NaturalEnd:
            case PendingAction::Kind::StopFadeEnded:
                handle_item_ended(p.item);
                break;

            case PendingAction::Kind::Crossfade: {
                // Restore ducked gains so the new cue's ducking applies fresh.
                for (const auto& dk : p.item.ducked) {
                    if (auto pi = engine_.find_cue(dk.cue_id))
                        pi->set_gain_db(dk.original_gain_db);
                }
                // Fade out the old cue over the crossfade window.
                if (auto pi = engine_.find_cue(p.item.cue_id)) {
                    pi->stop_with_fade(std::chrono::milliseconds{
                        static_cast<long long>(p.item.crossfade_sec * 1000.0)});
                }
                // Start the next cue (it will register itself with the sequencer).
                // Honour user-set Up Next override, same as handle_item_ended.
                std::string next_uuid;
                {
                    std::lock_guard lock{mutex_};
                    if (!next_item_override_.empty()) {
                        next_uuid = std::move(next_item_override_);
                        next_item_override_.clear(); next_item_override_manual_ = false;
                    } else {
                        next_uuid = resolve_next_item_locked(p.item.uuid);
                    }
                }
                // Fade the incoming cue IN over the crossfade window, and
                // exclude the outgoing cue from the incoming item's ducking so
                // its engine-owned fade-out (started just above) isn't hard-cut.
                // Skip if the operator already started the next item manually —
                // restarting it mid-play is never what a crossfade means.
                if (!next_uuid.empty()) {
                    if (item_on_air(next_uuid)) {
                        Logger::playback("CROSSFADE: next item '{}' already "
                                         "on air — not restarting", next_uuid);
                    } else {
                        trigger_item(next_uuid, p.item.crossfade_sec, p.item.cue_id);
                    }
                }
                break;
            }

            case PendingAction::Kind::StartNext: {
                // Restore gains this cue ducked so the incoming cue's own
                // ducking applies fresh (mirrors the Crossfade path).
                for (const auto& dk : p.item.ducked) {
                    if (auto pi = engine_.find_cue(dk.cue_id))
                        pi->set_gain_db(dk.original_gain_db);
                }
                // Optional radio-style tail: begin fading this cue out at
                // the marker (over its fadeOutDuration). Without it the cue
                // simply plays on to its natural end underneath the next one.
                if (p.item.start_next_fade_sec > 0.0) {
                    if (auto pi = engine_.find_cue(p.item.cue_id)) {
                        pi->stop_with_fade(std::chrono::milliseconds{
                            static_cast<long long>(
                                p.item.start_next_fade_sec * 1000.0)});
                    }
                }
                // Start the next cue at its own volume and fades. Honour a
                // user-set Up Next override, same as handle_item_ended.
                std::string next_uuid;
                {
                    std::lock_guard lock{mutex_};
                    if (!next_item_override_.empty()) {
                        next_uuid = std::move(next_item_override_);
                        next_item_override_.clear(); next_item_override_manual_ = false;
                    } else {
                        next_uuid = resolve_next_item_locked(p.item.uuid);
                    }
                }
                // Exclude the outgoing cue from the incoming item's ducking
                // so it keeps playing (or finishes its marker fade) underneath
                // instead of being hard-cut by a stop-all ducking mode.
                // Skip if the operator already started the next item manually.
                if (!next_uuid.empty()) {
                    if (item_on_air(next_uuid)) {
                        Logger::playback("START NEXT: next item '{}' already "
                                         "on air — not restarting", next_uuid);
                    } else {
                        trigger_item(next_uuid, -1.0, p.item.cue_id);
                    }
                }
                break;
            }

            case PendingAction::Kind::SeamlessAdvance: {
                // Restore gains this cue ducked so the incoming cue's own
                // ducking applies fresh (mirrors Crossfade / StartNext).
                for (const auto& dk : p.item.ducked) {
                    if (auto pi = engine_.find_cue(dk.cue_id))
                        pi->set_gain_db(dk.original_gain_db);
                }
                // Resolve the advance target (consumes an Up-Next override for
                // the "next" case) and start it now. The outgoing cue keeps
                // playing its short tail to its natural end, where it stops
                // itself; excluding it from the incoming cue's ducking prevents
                // a hard cut, so the boundary has no gap.
                const std::string next_uuid = resolve_advance_target(p.item);
                if (!next_uuid.empty()) {
                    if (item_on_air(next_uuid)) {
                        Logger::playback("SEAMLESS ADVANCE: next item '{}' already "
                                         "on air — not restarting", next_uuid);
                    } else {
                        trigger_item(next_uuid, -1.0, p.item.cue_id);
                    }
                }
                break;
            }

            case PendingAction::Kind::BeginStopFade:
                if (auto pi = engine_.find_cue(p.item.cue_id)) {
                    pi->stop_with_fade(std::chrono::milliseconds{
                        static_cast<long long>(p.item.stop_fade_sec * 1000.0)});
                }
                break;

            case PendingAction::Kind::Cleanup:
                for (const auto& dk : p.item.ducked) {
                    if (auto pi = engine_.find_cue(dk.cue_id))
                        pi->set_gain_db(dk.original_gain_db);
                }
                break;

            case PendingAction::Kind::CustomAction:
                execute_custom_action(p.custom_action);
                break;
            }
          } catch (const std::exception& e) {
            Logger::warn("sequencer action (item '{}') threw: {}", p.item.uuid, e.what());
          }
        }
    }
}

// ---------------------------------------------------------------------------
// Custom-action dispatcher — fired by the sequencer when an item's playhead
// crosses a customAction.timePoint. Server-side action types are executed
// directly; http-request is fanned out via the broadcast hook (which the
// control server wires up so a connected client performs the actual fetch).
// ---------------------------------------------------------------------------
void ProjectState::execute_custom_action(const json& action) {
    if (!action.is_object()) return;
    const std::string type = action.value("type", "");

    if (type == "play-item") {
        const auto u = action.value("uuid", std::string{});
        if (!u.empty()) trigger_item(u);
    }
    else if (type == "play-index") {
        // index is an array path through the items tree. Resolve under lock.
        std::vector<int> idx;
        if (action.contains("index") && action["index"].is_array()) {
            for (const auto& v : action["index"]) {
                if (v.is_number_integer()) idx.push_back(v.get<int>());
            }
        }
        std::string target_uuid;
        {
            std::lock_guard lock{mutex_};
            const json* arr = document_.contains("items") ? &document_["items"] : nullptr;
            const json* current = nullptr;
            for (std::size_t depth = 0; depth < idx.size() && arr && arr->is_array(); ++depth) {
                const int i = idx[depth];
                if (i < 0 || i >= static_cast<int>(arr->size())) { current = nullptr; break; }
                current = &(*arr)[i];
                if (depth + 1 < idx.size()) {
                    if (current->value("type", std::string{}) == "group" &&
                        current->contains("children")) {
                        arr = &(*current)["children"];
                    } else { current = nullptr; break; }
                }
            }
            if (current && current->is_object())
                target_uuid = current->value("uuid", std::string{});
        }
        if (!target_uuid.empty()) trigger_item(target_uuid);
    }
    else if (type == "stop-all") {
        engine_.stop_all(std::chrono::milliseconds{0});
    }
    else if (type == "http-request") {
        // Hand off to whoever subscribed via set_external_action_handler.
        // The control server wires this to a doc_patch broadcast so a
        // connected client executes the fetch — keeping server free of an
        // HTTP client dependency.
        std::function<void(const json&)> handler;
        {
            std::lock_guard lock{mutex_};
            handler = external_action_handler_;
        }
        if (handler) {
            try { handler(action); } catch (...) {}
        } else {
            Logger::warn("custom action http-request: no handler installed");
        }
    }
    else {
        Logger::warn("custom action: unknown type '{}'", type);
    }
}

void ProjectState::set_external_action_handler(std::function<void(const json&)> h) {
    std::lock_guard lock{mutex_};
    external_action_handler_ = std::move(h);
}

bool ProjectState::item_on_air(const std::string& uuid) {
    audio::CueId cue;
    {
        std::lock_guard lock{mutex_};
        auto it = item_uuid_to_cue_.find(uuid);
        if (it == item_uuid_to_cue_.end()) return false;
        cue = it->second;
    }
    if (auto pi = engine_.find_cue(cue)) {
        const auto ts = pi->stats().transport;
        return ts == audio::TransportState::Playing  ||
               ts == audio::TransportState::FadingIn ||
               ts == audio::TransportState::Paused;
    }
    return false;
}

std::string ProjectState::resolve_advance_target(const SequencedItem& item) {
    if (item.end_action == "next") {
        std::lock_guard lock{mutex_};
        if (!next_item_override_.empty()) {
            std::string u = std::move(next_item_override_);
            next_item_override_.clear(); next_item_override_manual_ = false;
            return u;
        }
        return resolve_next_item_locked(item.uuid);
    }
    if (item.end_action == "goto-item") {
        return item.goto_target_uuid;
    }
    if (item.end_action == "goto-index" && !item.goto_target_index.empty()) {
        std::lock_guard lock{mutex_};
        return resolve_index_path_locked(item.goto_target_index);
    }
    return {};
}

// ---------------------------------------------------------------------------
// Server-authoritative "Up Next" arming for cues with no end behaviour (#28).
// Mirrors the logic that used to live in the client's useAudioEngine so that,
// with multiple clients connected, the next-item arming is decided once by the
// authoritative server and fanned out to every client via next_item_set.
// ---------------------------------------------------------------------------
void ProjectState::arm_next_after_stop(const std::string& stopped_uuid,
                                       bool was_manual) {
    if (stopped_uuid.empty()) return;

    std::string next_to_arm;
    {
        std::lock_guard lock{mutex_};

        // Setting gate (default ON — undefined/true both enable).
        if (document_.contains("settings") && document_["settings"].is_object()) {
            const auto& s = document_["settings"];
            if (s.contains("autoCueNextWithoutEndBehavior") &&
                s["autoCueNextWithoutEndBehavior"].is_boolean() &&
                !s["autoCueNextWithoutEndBehavior"].get<bool>()) return;
        }

        // An arming the OPERATOR made wins — never clobber it. An arming the
        // server derived itself is fair game: it goes stale as soon as playback
        // moves somewhere it didn't predict (most visibly when the operator
        // jumps into a group, where the old blanket "any arming wins" check
        // meant the group's 2nd child was never armed once its 1st finished).
        if (!next_item_override_.empty() && next_item_override_manual_) return;

        // Only arm once nothing else is on air (e.g. don't fire mid-crossfade).
        // The just-stopped cue is ignored: on a manual stop it may still be
        // fading out, and arming is only a pointer (no playback), so its tail
        // must not block the advance.
        audio::CueId stopped_cue;
        {
            auto it = item_uuid_to_cue_.find(stopped_uuid);
            if (it != item_uuid_to_cue_.end()) stopped_cue = it->second;
        }
        for (auto& [_, c] : cues_) {
            if (c.id == stopped_cue) continue;
            if (auto pi = engine_.find_cue(c.id)) {
                const auto ts = pi->stats().transport;
                if (ts == audio::TransportState::Playing  ||
                    ts == audio::TransportState::FadingIn ||
                    ts == audio::TransportState::FadingOut||
                    ts == audio::TransportState::Paused) return;
            }
        }

        // Locate the stopped item and confirm it has no end behaviour.
        json* found = nullptr;
        std::vector<int> stopped_path;
        std::function<void(json&, std::vector<int>&)> walk;
        walk = [&](json& arr, std::vector<int>& path) {
            if (found || !arr.is_array()) return;
            for (std::size_t i = 0; i < arr.size(); ++i) {
                if (found) return;
                json& it = arr[i];
                if (!it.is_object()) continue;
                path.push_back(static_cast<int>(i));
                if (it.value("uuid", std::string{}) == stopped_uuid) {
                    found = &it; stopped_path = path; path.pop_back(); return;
                }
                if (it.value("type", std::string{}) == "group" &&
                    it.contains("children")) walk(it["children"], path);
                path.pop_back();
            }
        };
        if (document_.contains("items")) {
            std::vector<int> p;
            walk(document_["items"], p);
        }
        if (!found) return;
        // A One Shot is an anytime trigger. Stopping or finishing it must not
        // advance, replace, or otherwise disturb the Program Up Next pointer.
        if (is_one_shot_cue(*found)) return;
        // Only the "nothing" end behaviour is armed here — every other action
        // is auto-advanced by the sequencer itself.
        std::string action = "nothing";
        if (found->contains("endBehavior") && (*found)["endBehavior"].is_object())
            action = json_get_or((*found)["endBehavior"], "action",
                                 std::string{"nothing"});
        if (action != "nothing") return;

        // Advance to the next sibling in document order.
        std::vector<int> next_path = stopped_path;
        if (!next_path.empty()) {
            next_path.back()++;
            const std::string nxt = resolve_index_path_locked(next_path);
            if (!nxt.empty()) {
                next_to_arm = nxt;
            } else if (!was_manual) {
                // Fell off the end on a natural end → wrap to the first playable
                // item so a single GO restarts the show. A manual stop leaves
                // the arming empty (operator is holding the show).
                next_to_arm = first_playable_item_uuid_locked();
            }
        }
    }

    if (!next_to_arm.empty()) set_next_item_override(next_to_arm, /*manual=*/false);
}

void ProjectState::arm_first_item_on_open() {
    std::string first;
    {
        std::lock_guard lock{mutex_};
        if (document_.contains("settings") && document_["settings"].is_object()) {
            const auto& s = document_["settings"];
            if (s.contains("autoCueNextWithoutEndBehavior") &&
                s["autoCueNextWithoutEndBehavior"].is_boolean() &&
                !s["autoCueNextWithoutEndBehavior"].get<bool>()) return;
        }
        if (!next_item_override_.empty()) return;  // already armed
        // Don't clobber a rejoined running session.
        for (auto& [_, c] : cues_) {
            if (auto pi = engine_.find_cue(c.id)) {
                const auto ts = pi->stats().transport;
                if (ts != audio::TransportState::Stopped) return;
            }
        }
        first = first_playable_item_uuid_locked();
    }
    if (!first.empty()) set_next_item_override(first, /*manual=*/false);
}

void ProjectState::handle_item_ended(const SequencedItem& item) {
    // Ensure the engine explicitly transitions the transport state and 
    // triggers a cue_state broadcast so the client UI updates.
    engine_.stop(item.cue_id);

    // Restore ducked gains first so the next item starts with clean levels.
    for (const auto& dk : item.ducked) {
        if (auto pi = engine_.find_cue(dk.cue_id))
            pi->set_gain_db(dk.original_gain_db);
    }

    // The Start Next marker already advanced the playlist while this cue was
    // still playing — firing the end behaviour now would trigger the next
    // item a second time.
    if (item.start_next_triggered) {
        Logger::playback("END BEHAVIOUR suppressed for '{}' "
                         "(Start Next marker already fired)", item.uuid);
        return;
    }

    if (item.continue_armed) {
        Logger::playback("CUE TO CONTINUE END: item '{}' target='{}'",
                         item.uuid, item.continue_target_uuid);
        if (!item.continue_target_uuid.empty()) {
            if (item_on_air(item.continue_target_uuid)) {
                Logger::playback("CUE TO CONTINUE: target '{}' already on air — "
                                 "not restarting", item.continue_target_uuid);
            } else {
                trigger_item(item.continue_target_uuid);
            }
        }
        return;
    }

    // Read end-behaviour from the document.
    std::string      end_action;
    std::string      target_uuid;
    std::vector<int> target_index;   // index *path* through the item tree
    {
        std::lock_guard lock{mutex_};
        json* found = nullptr;
        const std::string& uuid = item.uuid;
        std::function<void(json&)> walk;
        walk = [&](json& arr) {
            if (found || !arr.is_array()) return;
            for (auto& it : arr) {
                if (found) return;
                if (!it.is_object()) continue;
                if (it.value("uuid", std::string{}) == uuid) { found = &it; return; }
                if (it.value("type", std::string{}) == "group" &&
                    it.contains("children")) walk(it["children"]);
            }
        };
        json& doc = document_;
        if (doc.contains("items"))              walk(doc["items"]);
        if (!found && doc.contains("cartOnlyItems")) walk(doc["cartOnlyItems"]);

        if (found && found->contains("endBehavior") &&
            (*found)["endBehavior"].is_object()) {
            const auto& eb = (*found)["endBehavior"];
            end_action   = eb.value("action",      std::string{});
            target_uuid  = eb.value("targetUuid",  std::string{});
            // targetIndex is an index *path* (array of ints) — see the client's
            // findItemByIndex. Read it element-by-element: eb.value<int>(...)
            // would throw type_error.302 because the stored value is an array,
            // which previously propagated out of the sequencer thread and
            // crashed the server whenever an item carrying a targetIndex ended.
            if (eb.contains("targetIndex") && eb["targetIndex"].is_array()) {
                for (const auto& v : eb["targetIndex"]) {
                    if (v.is_number_integer()) target_index.push_back(v.get<int>());
                }
            }
        }
    }

    Logger::playback("END BEHAVIOUR: item '{}' action='{}' targetUuid='{}' targetIndexLen={}",
                     item.uuid, end_action, target_uuid, target_index.size());

    if (end_action == "loop") {
        // Normally a looping cue never reaches here (the audio thread seeks
        // back to the in-point on EOF). This is the fallback path for when the
        // engine couldn't loop (e.g. a decoder that can't seek) — re-trigger
        // the same item so "loop" still loops, just with a gap.
        play_item(item.uuid);
    } else if (end_action == "next") {
        std::string next_uuid;
        {
            std::lock_guard lock{mutex_};
            // User-set override wins; consume it.
            if (!next_item_override_.empty()) {
                next_uuid = std::move(next_item_override_);
                next_item_override_.clear(); next_item_override_manual_ = false;
            } else {
                next_uuid = resolve_next_item_locked(item.uuid);
            }
        }
        // Don't restart a next item that's already on air (the operator
        // started it manually, or a Start Next / crossfade beat us to it).
        if (!next_uuid.empty()) {
            if (item_on_air(next_uuid)) {
                Logger::playback("END BEHAVIOUR next: item '{}' already "
                                 "on air — not restarting", next_uuid);
            } else {
                trigger_item(next_uuid);
            }
        }
    } else if (end_action == "goto-item" && !target_uuid.empty()) {
        trigger_item(target_uuid);
    } else if (end_action == "goto-index" && !target_index.empty()) {
        std::string idx_uuid;
        {
            std::lock_guard lock{mutex_};
            idx_uuid = resolve_index_path_locked(target_index);
        }
        if (idx_uuid.empty()) {
            Logger::warn("END BEHAVIOUR goto-index: index path did not resolve "
                         "to any item (item '{}')", item.uuid);
        } else {
            trigger_item(idx_uuid);
        }
    } else {
        // "nothing" (or unrecognized) end behaviour: no auto-advance, but the
        // server may still arm the next item as "Up Next" so the operator can
        // step through the list with a single GO (#28). A natural end wraps to
        // the top of the playlist at the end of the list.
        arm_next_after_stop(item.uuid, /*was_manual=*/false);
    }
}

} // namespace liveplay::core
