// ============================================================================
// liveplay/audio/engine.hpp
// ----------------------------------------------------------------------------
// The top-level AudioEngine. Owns:
//   * One or more hardware Devices (each wrapping a miniaudio playback device).
//   * The catalogue of PlaybackItems (cues, keyed by CueId).
//   * The catalogue of MixerChannels (Tier 2 strips, keyed by MixerChannelId).
//   * The "topology": which items send to which channels, which channels send
//     to which master-bus indices, which master-bus indices map to which
//     (device, hw-channel) pairs. The topology is held as an immutable
//     snapshot in an std::atomic<std::shared_ptr<const Topology>> so the
//     render thread reads it lock-free.
//   * The render thread, which drives all PlaybackItems through the matrix
//     into per-device PCM ring buffers. Each device's audio callback drains
//     its own ring buffer.
//   * Per-device-channel Limiter and Meter after routing and clock adaptation,
//     so masters sharing a physical output share its protection and meter.
//
// Thread model:
//   * Control thread (REST/WS handlers in M3, or test driver here in M2) —
//     calls every public method except those marked "audio thread".
//   * Render thread — internal to the engine; runs render_loop_.
//   * Per-device callback threads — drain ring buffers and process only their
//     own output limiters and meters.
//
// All public methods are control-thread safe. Internal mutations to the
// topology rebuild a new snapshot and atomic-store it.
// ============================================================================
#pragma once

#include "liveplay/audio/callback_liveness.hpp"
#include "liveplay/audio/limiter.hpp"
#include "liveplay/audio/meter.hpp"
#include "liveplay/audio/mixer_channel.hpp"
#include "liveplay/audio/playback_item.hpp"
#include "liveplay/audio/device_clock_controller.hpp"
#include "liveplay/audio/types.hpp"

#include <array>
#include <atomic>
#include <chrono>
#include <functional>
#include <condition_variable>
#include <filesystem>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

// miniaudio types (header-only; implementation compiled once in miniaudio_impl.c).
#include <miniaudio.h>

// ---------------------------------------------------------------------------
// AtomicSharedPtr<T>
// ---------------------------------------------------------------------------
// std::atomic<std::shared_ptr<T>> (C++20) isn't implemented in Apple Clang's
// libc++ 16 (shipped with macOS Command Line Tools). Where the standard
// specialization is available we use it directly; otherwise we wrap the
// pre-C++20 std::atomic_load / std::atomic_store free-function overloads,
// which remain functional on every common standard library (libc++, libstdc++,
// MSVC STL) even though they were marked deprecated in C++20.
//
// The interface is intentionally minimal — load / store with sequential
// consistency, which is all engine.cpp needs.
// ---------------------------------------------------------------------------
namespace liveplay::audio::detail {

#if defined(__cpp_lib_atomic_shared_ptr) && __cpp_lib_atomic_shared_ptr >= 201711L
template <class T>
using AtomicSharedPtr = std::atomic<std::shared_ptr<T>>;
#else

#if defined(__clang__)
#  pragma clang diagnostic push
#  pragma clang diagnostic ignored "-Wdeprecated-declarations"
#elif defined(__GNUC__)
#  pragma GCC diagnostic push
#  pragma GCC diagnostic ignored "-Wdeprecated-declarations"
#endif

template <class T>
class AtomicSharedPtr {
public:
    AtomicSharedPtr() noexcept = default;
    explicit AtomicSharedPtr(std::shared_ptr<T> p) noexcept : value_(std::move(p)) {}

    std::shared_ptr<T> load() const noexcept {
        return std::atomic_load(&value_);
    }
    void store(std::shared_ptr<T> p) noexcept {
        std::atomic_store(&value_, std::move(p));
    }

private:
    std::shared_ptr<T> value_{};
};

#if defined(__clang__)
#  pragma clang diagnostic pop
#elif defined(__GNUC__)
#  pragma GCC diagnostic pop
#endif

#endif // __cpp_lib_atomic_shared_ptr

// Control-plane ownership for one deduplicated native audio device. The
// initial opener owns one reference. release_is_final() deliberately leaves
// the count at one because the caller destroys the Device on that path.
class DeviceReferenceCount {
public:
    void acquire() noexcept { ++value_; }

    [[nodiscard]] bool release_is_final() noexcept {
        if (value_ == 1) return true;
        --value_;
        return false;
    }

    [[nodiscard]] std::size_t value() const noexcept { return value_; }

private:
    std::size_t value_ = 1;
};

} // namespace liveplay::audio::detail

namespace liveplay::audio {

// ---------------------------------------------------------------------------
// Public DTOs returned to the control thread / future REST layer
// ---------------------------------------------------------------------------
enum class DeviceRuntimeState : std::uint8_t {
    Available,
    Starting,
    Running,
    Stalled,
    Interrupted,
    Disconnected,
    Closing,
};

struct DeviceInfo {
    DeviceId     id;
    std::string  display_name;
    ChannelCount channel_count = 0;
    SampleRate   sample_rate = 0;
    bool         is_default = false;
    bool         is_open = false;
    bool         is_available = true;
    bool         is_clock_master = false;
    std::string  runtime_state = "available";
    std::uint64_t recovery_request_id = 0;
    std::string  recovery_status = "idle";
    std::uint64_t underrun_count = 0;
    std::uint64_t underrun_frames = 0;
    std::uint64_t overrun_count = 0;
    std::uint64_t hard_resync_count = 0;
    std::uint64_t device_loss_count = 0;
    std::uint64_t device_recovery_count = 0;
    std::uint64_t callback_entry_count = 0;
    std::uint64_t stream_recovery_count = 0;
    std::uint64_t reroute_count = 0;
    std::uint64_t interruption_count = 0;
    std::uint64_t correction_limit_count = 0;
    std::uint32_t ring_occupancy_frames = 0;
    float         clock_correction_ppm = 0.0f;
};

struct EngineConfig {
    SampleRate         mix_sample_rate    = kDefaultMixSampleRate;
    FrameCount         render_block       = kDefaultRenderBlock;
    MasterChannelIndex master_channels    = 32;     // logical bus width
    float              master_ceiling_db  = -0.1f;
};

// ---------------------------------------------------------------------------
// Immutable topology snapshot (built on the control thread, read on the
// render thread). Copies of std::shared_ptr<...> point at PlaybackItems and
// MixerChannels so they stay alive even if removed from the live registries.
// ---------------------------------------------------------------------------
struct ItemRouteEntry {
    std::shared_ptr<PlaybackItem>   item;
    // For each source channel of the item, a list of sends into mixer lanes.
    // Lanes are concrete here (0..kMixerLanes-1) — kAllMixerLanes routes are
    // expanded into one send per lane when the snapshot is built.
    struct Send {
        std::size_t  mixer_index = 0;
        ChannelIndex lane = 0;
        float        gain = 1.0f;
    };
    struct SendList {
        std::vector<Send> sends;
    };
    std::vector<SendList> per_source_channel;
    // Allocated with the snapshot on the control thread and only mutated by
    // the single render thread.
    mutable std::vector<std::vector<Sample>> channel_buffers;
    mutable std::vector<Sample*>             channel_ptrs;
};

struct MasterRouteEntry {
    MasterChannelIndex index = kInvalidMasterChannel;
    // Per master-channel: list of mixer lanes feeding it, with gain. Lanes are
    // concrete here (kAllMixerLanes expanded at snapshot-build time).
    struct Send {
        std::size_t  mixer_index = 0;
        ChannelIndex lane = 0;
        float        gain = 1.0f;
    };
    std::vector<Send> sends;
    // Where this master channel lands on hardware. Empty optional = bus is
    // logically defined but not yet assigned to a hardware output (silent).
    std::optional<MasterDestination> destination;
};

struct PreparedFollow {
    enum class State : std::uint8_t { Armed, Firing, Fired, Cancelled };
    std::shared_ptr<PlaybackItem> source;
    std::shared_ptr<PlaybackItem> target;
    std::uint64_t source_revision = 0;
    std::uint64_t target_revision = 0;
    std::uint64_t end_frame = 0;
    std::atomic<State> status{State::Armed};
};

struct Topology {
    std::vector<ItemRouteEntry>   items;     // all known items (active list filtered at render time)
    std::vector<MasterRouteEntry> masters;   // size == master_channels
    std::vector<std::shared_ptr<MixerChannel>> mixers;
    std::vector<std::shared_ptr<PreparedFollow>> follows;
    mutable std::vector<std::vector<Sample>> mixer_accumulators;
    mutable std::vector<std::vector<Sample>> master_accumulators;
};

// ---------------------------------------------------------------------------
class AudioEngine {
public:
    explicit AudioEngine(EngineConfig cfg = {});
    ~AudioEngine();

    AudioEngine(const AudioEngine&)            = delete;
    AudioEngine& operator=(const AudioEngine&) = delete;

    // ---- Lifecycle -------------------------------------------------------
    bool start();
    void stop();
    bool is_running() const noexcept {
        return running_.load(std::memory_order_acquire);
    }

    // ---- Device management ----------------------------------------------
    // Cached hardware plus current runtime; only the first catalog has a bounded 50 ms grace.
    std::vector<DeviceInfo> enumerate_devices() const;

    // Open the platform's default playback device with `output_channels`
    // channels at the engine's mix rate.
    DeviceId open_default_device(ChannelCount output_channels = 2);

    // Acquire an already-open runtime id, or open an exact display name with
    // a legacy substring fallback. Returns an empty DeviceId on failure.
    DeviceId open_device_by_name(const std::string& name_substring,
                                 ChannelCount output_channels = 2);

    void close_device(const DeviceId& id);

    // Queue an in-place stop/start of an opened local stream. A returned id
    // confirms queue acceptance only; success still requires a new callback.
    std::optional<std::uint64_t> request_device_recovery(const DeviceId& id);

    // ---- Items / cues ----------------------------------------------------
    // Create a fresh, independent PlaybackItem for `file_path`. Two carts
    // loading the same file get two PlaybackItems with their own state —
    // this is the fix for the 1.x cross-cart attenuation bug.
    CueId load_cue(const std::filesystem::path& file_path,
                   std::optional<CueId> requested_id = std::nullopt);

    // Bulk-load variant: skips ensure_default_routing() and rebuild_topology()
    // per call. Used by ProjectState to register many cues without the
    // O(N²) blow-up that comes from re-walking every loaded cue on each
    // insert. Caller MUST invoke ensure_default_routing() once after the
    // batch is complete.
    CueId load_cue_no_route(const std::filesystem::path& file_path,
                            std::optional<CueId> requested_id = std::nullopt);

    // Publish a fully prepared cue; performs no decoder or filesystem work.
    CueId adopt_cue(const std::shared_ptr<PlaybackItem>& item);

    // Mint a fresh, unused CueId without loading anything. Lets a caller hand
    // out the id of a cue synchronously and pass it back as `requested_id` when
    // the (slow) decode finishes on a worker thread. See
    // ProjectState::begin_item_load_locked.
    CueId new_cue_id() const;

    void unload_cue(const CueId& id);
    std::shared_ptr<PlaybackItem> find_cue(const CueId& id) const;

    void play(const CueId& id);
    void stop(const CueId& id);
    // Stop every loaded cue. By default each item's own fade_out_duration
    // wins when non-zero (falling back to `fade` only for hard-stop items).
    // When `force_fade` is true, `fade` is applied to EVERY item regardless
    // of its per-item fade-out — used by the project-wide "Stop All" button so
    // the operator's global fade always wins (fade == 0 → hard stop for all).
    void stop_all(std::chrono::milliseconds fade = std::chrono::milliseconds{0},
                  bool force_fade = false);

    // Prepare a direct audio follow for the source's exact mix-frame endpoint.
    // Null means the caller must follow normally at EOF; never start early.
    std::shared_ptr<PreparedFollow> schedule_follow(
        const CueId& source, const CueId& target, std::uint64_t end_frame);

    // ---- Sensible-default routing ---------------------------------------
    // Brings the engine into a usable state without explicit routing
    // calls: opens the default device if no device is open, creates a
    // dedicated "Main" mixer, wires Main lane 0/1 → master 0/1 →
    // default device hardware channels 0/1, and routes every loaded cue's
    // source channels through Main (stereo → lanes L/R, mono → both lanes).
    // Idempotent — safe to call any number of times.
    void ensure_default_routing();
    // Establish the same Main -> OS-default path, but attach only one cue.
    // Existing cue routes are left untouched.
    void ensure_default_routing_for_cue(const CueId& cue);

    // ---- Mixer channels --------------------------------------------------
    MixerChannelId create_mixer_channel(std::string display_name);
    void remove_mixer_channel(const MixerChannelId& id);
    std::shared_ptr<MixerChannel> find_mixer_channel(
        const MixerChannelId& id) const;

    // ---- Routing matrix --------------------------------------------------
    // `lane` selects which mixer strip lane the source channel feeds
    // (0 = L, 1 = R). kAllMixerLanes fans the channel across every lane —
    // right for mono sources; also the legacy pre-lane behaviour.
    // Routing the same (source_channel, mixer) pair again replaces the
    // existing send's gain and lane.
    void route_item_source_to_mixer(const CueId& cue,
                                    ChannelIndex source_channel,
                                    const MixerChannelId& mixer,
                                    float gain_db = 0.0f,
                                    ChannelIndex lane = kAllMixerLanes);

    void unroute_item_source_from_mixer(const CueId& cue,
                                        ChannelIndex source_channel,
                                        const MixerChannelId& mixer);

    // Atomically replace one source's sends; an empty mixer clears that source.
    void set_item_source_mixer(const CueId& cue, ChannelIndex source_channel,
                               const MixerChannelId& mixer);

    // Remove every source-channel route this cue has to any mixer, including
    // the engine's auto-created "Main" mixer (which the ProjectState routing
    // layer doesn't track by id). Used when re-pinning a cue exclusively to a
    // specific output device so it can't keep bleeding onto Main → the default
    // device. No-op if the cue has no routes.
    void unroute_item_from_all_mixers(const CueId& cue);

    // `lane` selects which mixer strip lane feeds this master channel
    // (0 = L, 1 = R). kAllMixerLanes sums every lane into the master —
    // a mono downmix of the strip; also the legacy pre-lane behaviour.
    // Routing the same (mixer, master) pair again replaces the existing
    // send's gain and lane.
    void route_mixer_to_master(const MixerChannelId& mixer,
                               MasterChannelIndex master,
                               float gain_db = 0.0f,
                               ChannelIndex lane = kAllMixerLanes);

    void unroute_mixer_from_master(const MixerChannelId& mixer,
                                   MasterChannelIndex master);

    void assign_master_to_device(MasterChannelIndex master,
                                 const DeviceId& device,
                                 ChannelIndex hw_channel);

    void clear_master_assignment(MasterChannelIndex master);

    // ---- Master ----------------------------------------------------------
    void set_master_ceiling_db(float db);
    // Enable/disable the physical-output true-peak limiter. Bypass preserves the
    // lookahead delay and detector state, so live transitions do not shift
    // audio in time. Audio-thread safe via an atomic flag.
    void set_limiter_enabled(bool enabled) noexcept;
    bool limiter_enabled() const noexcept {
        return callback_state_->limiter_enabled.load(std::memory_order_acquire);
    }
    // Master gain in dB. Applied to every master accumulator before the
    // limiter, so a value of 0 dB is unity. Range is clamped at -120..+12.
    void set_master_gain_db(float db);
    float master_gain_db() const noexcept;

    // Per-output-channel gain (applied per master channel, after the global
    // master gain). 0 dB = unity; range clamped to -120..+12.
    void  set_output_channel_gain_db(MasterChannelIndex ch, float db);
    float output_channel_gain_db(MasterChannelIndex ch) const noexcept;

    // ---- Metering config ---------------------------------------------------
    // Retune the ballistics of EVERY meter in the engine (per-item source
    // meters, mixer strip lanes, masters) and remember them so meters created
    // later inherit the setting. Safe mid-playback.
    void set_meter_ballistics(const MeterBallistics& b);

    // Toggle 4× oversampled true-peak detection on every meter (same
    // fan-out + remember semantics). Gated by the project's meter mode —
    // the extra DSP only runs when the operator is looking at dBTP.
    void set_true_peak_metering(bool enabled);

    // Toggle K-weighted loudness (BS.1770 momentary) on every meter (same
    // fan-out + remember semantics). Gated on meter mode == LUFS.
    void set_loudness_metering(bool enabled);

    // ---- Metering reads --------------------------------------------------
    MeterSnapshot read_master_meter(MasterChannelIndex master) const;
    // Consuming read (resets the master's max-since-read). Broadcaster only.
    MeterSnapshot read_master_meter_consume(MasterChannelIndex master);
    float         read_master_gain_reduction_db(MasterChannelIndex master) const;

    // ---- Introspection ---------------------------------------------------
    const EngineConfig& config() const noexcept { return cfg_; }

#ifndef LIVEPLAY_TEST_ACCESS
private:
#endif
    struct OutputChannelState {
        std::unique_ptr<Limiter> limiter;
        std::unique_ptr<Meter>   meter;
    };

    struct NativeDeviceInfo { DeviceInfo info; ma_device_id native_id; };
    struct DeviceCatalog {
        std::mutex mutex;
        std::condition_variable ready;
        std::vector<NativeDeviceInfo> devices;
        bool refreshing = false;
        bool has_snapshot = false;
        std::chrono::steady_clock::time_point next_refresh{};
    };
    std::shared_ptr<DeviceCatalog> device_catalog_ = std::make_shared<DeviceCatalog>();

    // Callbacks and native jobs retain only these signals, never the engine.
    struct DeviceCallbackState {
        std::atomic<std::uint32_t> consumption_counter{0};
        std::condition_variable watchdog_cv;
        std::atomic<bool> limiter_enabled{true};
        std::atomic<std::uint64_t> run_generation{0};
        std::atomic<bool> active{false};
    };
    std::shared_ptr<DeviceCallbackState> callback_state_ = std::make_shared<DeviceCallbackState>();

    // ---- Internal device wrapper ----------------------------------------
    struct Device {
        DeviceId                    id;
        std::string                 display_name;
        ChannelCount                channels = 2;
        SampleRate                  sample_rate = kDefaultMixSampleRate;
        std::unique_ptr<ma_device>  ma_dev;
        std::mutex                  native_mutex; // One stop/start/uninit per device.
        mutable std::mutex          state_mutex;  // Short recovery/watchdog publication only.
        std::atomic<bool>           cleanup_done{false};
        std::unique_ptr<ma_pcm_rb>  ring;             // SPSC PCM ring
        std::unique_ptr<ma_resampler> clock_resampler;
        bool                        clock_resampler_initialized = false;
        std::vector<Sample>         scratch;          // interleaved staging buffer
        std::vector<Sample>         output_mono;      // callback-only, preallocated
        std::vector<OutputChannelState> outputs;      // one final stage per hw channel
        // Number of control-plane owners that acquired this native device.
        // Guarded by AudioEngine::mutex_; never read by a real-time thread.
        detail::DeviceReferenceCount open_references;
        std::atomic<bool>           started{false};
        std::atomic<bool>           closing{false};
        std::atomic<bool>           recovery_in_progress{false};
        std::atomic<bool>           recovery_requested{false};
        std::atomic<bool>           render_active{false};
        std::atomic<bool>           callback_active{false};
        std::atomic<bool>           reset_requested{true};
        bool                        reset_applied = false; // render thread only
        std::atomic<bool>           clock_master{false};
        std::atomic<DeviceRuntimeState> runtime_state{
            DeviceRuntimeState::Starting};
        CallbackEntryCounter        callback_entries;
        CallbackLivenessMonitor     callback_liveness; // watchdog thread only
        std::atomic<std::uint64_t>  liveness_epoch{0};
        std::uint64_t               observed_liveness_epoch = 0; // watchdog only
        std::atomic<bool>           native_recovery_pending{false};
        // Guarded by state_mutex. The started id binds liveness
        // completion to the request whose replacement stream was armed.
        DeviceRecoveryRequest       recovery_request;
        std::uint64_t               started_recovery_request_id = 0;
        DeviceClockController       clock_controller; // callback, or paused reset
        bool                        correction_was_limited = false;
        std::atomic<std::int32_t>   applied_rate_ppm{0};
        std::atomic<float>          clock_correction_ppm{0.0f};
        std::atomic<std::uint32_t>  ring_occupancy_frames{0};
        std::atomic<std::uint64_t>  underrun_count{0};
        std::atomic<std::uint64_t>  underrun_frames{0};
        std::atomic<std::uint64_t>  overrun_count{0};
        std::atomic<std::uint64_t>  hard_resync_count{0};
        std::atomic<std::uint64_t>  device_loss_count{0};
        std::atomic<std::uint64_t>  device_recovery_count{0};
        std::atomic<std::uint64_t>  stream_recovery_count{0};
        std::atomic<std::uint64_t>  reroute_count{0};
        std::atomic<std::uint64_t>  interruption_count{0};
        std::atomic<std::uint64_t>  correction_limit_count{0};
        std::shared_ptr<DeviceCallbackState> callback_state;

        ~Device();
    };
    using DeviceList = std::vector<std::shared_ptr<Device>>;

    EngineConfig                                 cfg_;
    // Master gain in linear amplitude. Audio thread reads via load-acquire;
    // set_master_gain_db is the only writer. 1.0 = unity (0 dB).
    std::atomic<float>                           master_gain_linear_{1.0f};
    // Per-output-channel gains (index matches master channel index). Fixed-size
    // atomics let the render thread read without copying or taking mutex_.
    std::unique_ptr<std::atomic<float>[]>         output_channel_gains_;
    // miniaudio device init/uninit mutates backend-global state on some
    // platforms. Retained across engine lifetimes by unfinished native jobs.
    std::shared_ptr<std::mutex>                   device_lifecycle_mutex_;
#ifdef LIVEPLAY_TEST_HOOKS
    ma_context*                                  device_test_context_ = nullptr;
#endif
#ifdef LIVEPLAY_TEST_ACCESS
    std::function<void()>                        before_render_wait_snapshot_for_test_;
#endif
    std::uint64_t                                next_recovery_request_id_ = 1;
    mutable std::mutex                           mutex_;          // guards registries + topology rebuild
    std::unordered_map<std::string, std::shared_ptr<PlaybackItem>>  items_;
    std::unordered_map<std::string, std::shared_ptr<MixerChannel>>  mixers_;
    MixerChannelId                               main_mixer_;
    // Control ownership prevents snapshot retirement from destroying a follow
    // on RT; rebuilds reclaim completed records after all readers let go.
    std::vector<std::shared_ptr<PreparedFollow>> prepared_follows_;
    DeviceList                                   devices_;
    // Closed devices remain owned until all snapshot readers have drained.
    DeviceList                                   retired_devices_;
    detail::AtomicSharedPtr<const DeviceList>     device_snapshot_{};

    // Pending route description — the source-of-truth that topology rebuilds from.
    // Lanes here may be kAllMixerLanes (expanded when the snapshot is built).
    struct PendingRoute {
        // item-to-mixer: cue → (source_channel → [sends])
        struct ItemMixerSend {
            MixerChannelId mixer;
            ChannelIndex   lane = kAllMixerLanes;
            float          gain_lin = 1.0f;
        };
        struct ItemSourceRoutes {
            std::vector<std::vector<ItemMixerSend>> by_source_channel;
        };
        std::unordered_map<std::string, ItemSourceRoutes> item_sources;

        // mixer-to-master: mixerId → [sends]
        struct MasterSend {
            MasterChannelIndex master = kInvalidMasterChannel;
            ChannelIndex       lane = kAllMixerLanes;
            float              gain_lin = 1.0f;
        };
        std::unordered_map<std::string, std::vector<MasterSend>> mixer_to_master;

        // master-to-device: masterIdx → MasterDestination
        std::vector<std::optional<MasterDestination>> master_destinations;
    };
    PendingRoute pending_;

    // Atomic topology snapshot for the render thread.
    detail::AtomicSharedPtr<const Topology> topology_{};
    std::vector<std::shared_ptr<const Topology>> retired_topologies_;
    std::vector<std::shared_ptr<const DeviceList>> retired_device_snapshots_;

    // Logical bus meters remain available for unassigned masters. Assigned
    // masters read the persistent physical output's post-limiter meter.
    struct MasterChannelState {
        std::unique_ptr<Meter> meter;
        // Control-thread caches keep aliases from consuming each other's peaks.
        const OutputChannelState* output_max_source = nullptr;
        float output_peak_max_db = -120.0f;
        float output_true_peak_max_db = -120.0f;
    };
    std::vector<MasterChannelState> master_state_;

    // Current meter ballistics + feature flags (project settings). Guarded by
    // mutex_; applied to meters created after the corresponding setter ran.
    MeterBallistics meter_ballistics_{};
    bool            meter_true_peak_ = false;
    bool            meter_loudness_  = false;

    // Decoder calls may outlive engine shutdown; retain only their own cue.
    struct DecodeState {
        using Cues = std::vector<std::weak_ptr<PlaybackItem>>;
        detail::AtomicSharedPtr<const Cues> cues;
        std::atomic<bool> active{false};
        std::atomic<bool> shutdown{false};
        std::condition_variable wake;
        std::mutex wait_mutex;
        std::unordered_set<const PlaybackItem*> workers; // Guarded by wait_mutex.
    };
    std::shared_ptr<DecodeState>      decode_state_ = std::make_shared<DecodeState>();

    // The dispatcher never reads media; each live cue owns its unfinished work.
    std::atomic<bool>                running_{false};
    std::thread                      render_thread_;
    // shortcut: a stuck read retains one worker per cue; process isolation is needed to reclaim it.
    std::thread                      decode_thread_;
    std::thread                      device_watchdog_thread_;
    std::mutex                       device_watchdog_wait_mutex_;
    std::atomic<std::uint64_t>       render_error_count_{0};

    // -- Helpers ---------------------------------------------------------
    void rebuild_topology_locked();
    void reclaim_snapshots_locked();
    void ensure_default_routing_impl(const std::optional<CueId>& cue_filter);
    MixerChannelId create_mixer_channel_locked(std::string display_name);
    void publish_topology(std::shared_ptr<const Topology> snap);
    std::shared_ptr<const Topology> snapshot_topology() const noexcept;
    void publish_device_snapshot_locked();
    std::shared_ptr<const DeviceList> snapshot_devices() const noexcept;

    void render_loop();
    void render_one_block(const Topology& topo);
    static void decode_loop(const std::shared_ptr<DecodeState>& state);
    static void refresh_device_catalog(const std::shared_ptr<DeviceCatalog>& catalog,
        const std::shared_ptr<std::mutex>& lifecycle, ma_context* test_context);
    void device_watchdog_loop();
    static void recover_device(const std::shared_ptr<Device>& device, std::uint64_t generation) noexcept;
    bool reset_device_if_requested(Device& device) noexcept;

    Device* find_device_locked(const DeviceId& id) const;
    const OutputChannelState* output_state_locked(MasterChannelIndex master) const;
    DeviceId next_device_id();

    static void ma_data_callback(ma_device* dev, void* out, const void* in, std::uint32_t frames);
    static void ma_notification_callback(const ma_device_notification* notification);
};

} // namespace liveplay::audio
