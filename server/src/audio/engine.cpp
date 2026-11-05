// ============================================================================
// engine.cpp — see engine.hpp.
// ============================================================================
#include "liveplay/audio/engine.hpp"
#include "liveplay/logger.hpp"

#include <miniaudio.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <random>
#include <string>

#if defined(_WIN32)
#  include <windows.h>   // SetThreadPriority
#endif

#if defined(_M_X64) || defined(_M_IX86) || defined(__x86_64__) || defined(__i386__)
#  include <xmmintrin.h>   // _MM_SET_FLUSH_ZERO_MODE
#  include <pmmintrin.h>   // _MM_SET_DENORMALS_ZERO_MODE
#  define LIVEPLAY_HAVE_SSE_DENORMAL 1
#endif

namespace liveplay::audio {

namespace {

std::shared_ptr<std::mutex> native_device_mutex() {
    static const auto mutex = std::make_shared<std::mutex>();
    return mutex;
}

inline float db_to_lin(float db) noexcept {
    if (db <= -120.0f) return 0.0f;
    return std::pow(10.0f, db * 0.05f);
}

std::string gen_uuid_like() {
    static std::atomic<std::uint64_t> counter{0};
    thread_local std::mt19937_64 rng{
        std::random_device{}() ^ static_cast<std::uint64_t>(
            std::chrono::steady_clock::now().time_since_epoch().count())};
    const auto a = rng();
    const auto b = counter.fetch_add(1, std::memory_order_relaxed);
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%016llx-%016llx",
                  static_cast<unsigned long long>(a),
                  static_cast<unsigned long long>(b));
    return std::string{buf};
}

class AtomicActiveGuard {
public:
    explicit AtomicActiveGuard(std::atomic<bool>& active) noexcept : active_(active) {}
    ~AtomicActiveGuard() { active_.store(false, std::memory_order_seq_cst); }

    AtomicActiveGuard(const AtomicActiveGuard&) = delete;
    AtomicActiveGuard& operator=(const AtomicActiveGuard&) = delete;

private:
    std::atomic<bool>& active_;
};

const char* device_runtime_state_name(DeviceRuntimeState state) noexcept {
    switch (state) {
        case DeviceRuntimeState::Available:    return "available";
        case DeviceRuntimeState::Starting:     return "starting";
        case DeviceRuntimeState::Running:      return "running";
        case DeviceRuntimeState::Stalled:      return "stalled";
        case DeviceRuntimeState::Interrupted:  return "interrupted";
        case DeviceRuntimeState::Disconnected: return "disconnected";
        case DeviceRuntimeState::Closing:      return "closing";
    }
    return "disconnected";
}

} // namespace

// ---------------------------------------------------------------------------
// Construction / lifecycle
// ---------------------------------------------------------------------------
AudioEngine::Device::~Device() {
    if (clock_resampler_initialized && clock_resampler) {
        ma_resampler_uninit(clock_resampler.get(), nullptr);
    }
}

AudioEngine::AudioEngine(EngineConfig cfg) : cfg_(cfg), device_lifecycle_mutex_(native_device_mutex()) {
    if (cfg_.master_channels == 0) cfg_.master_channels = kDefaultMasterChannels;
    if (cfg_.render_block    == 0) cfg_.render_block    = kDefaultRenderBlock;
    if (cfg_.mix_sample_rate == 0) cfg_.mix_sample_rate = kDefaultMixSampleRate;

    master_state_.resize(cfg_.master_channels);
    for (auto& state : master_state_) {
        state.meter = std::make_unique<Meter>();
        state.meter->configure(cfg_.mix_sample_rate);
    }
    pending_.master_destinations.resize(cfg_.master_channels);
    output_channel_gains_ =
        std::make_unique<std::atomic<float>[]>(cfg_.master_channels);
    for (MasterChannelIndex i = 0; i < cfg_.master_channels; ++i) {
        output_channel_gains_[i].store(1.0f, std::memory_order_relaxed);
    }

    // Publish an empty topology so the render thread has something to read.
    auto initial = std::make_shared<Topology>();
    initial->masters.resize(cfg_.master_channels);
    initial->master_accumulators.assign(
        cfg_.master_channels,
        std::vector<Sample>(static_cast<std::size_t>(cfg_.render_block), 0.0f));
    for (MasterChannelIndex i = 0; i < cfg_.master_channels; ++i) initial->masters[i].index = i;
    topology_.store(std::move(initial));
    device_snapshot_.store(std::make_shared<const DeviceList>());
}

AudioEngine::~AudioEngine() {
    stop();
    {
        std::lock_guard lock{decode_state_->wait_mutex};
        decode_state_->shutdown.store(true, std::memory_order_release);
    }
    decode_state_->cues.store({});
    decode_state_->wake.notify_all();
    // Only the dispatcher is joined; in-flight cue workers own their state.
    if (decode_thread_.joinable()) decode_thread_.join();
    // Withdrawal is synchronous; native retirement owns each device independently.
    while (!devices_.empty()) {
        devices_.back()->open_references = detail::DeviceReferenceCount{};
        close_device(devices_.back()->id);
    }
}

bool AudioEngine::start() {
    if (running_.exchange(true)) return true;
    callback_state_->run_generation.fetch_add(1, std::memory_order_acq_rel);
    callback_state_->active.store(true, std::memory_order_release);
    try {
        Logger::info("AudioEngine: starting (mix {} Hz, block {} frames, {} master ch, ceiling {:.1f} dB)",
                     cfg_.mix_sample_rate, cfg_.render_block, cfg_.master_channels,
                     cfg_.master_ceiling_db);

        if (!decode_thread_.joinable())
            decode_thread_ = std::thread([state = decode_state_] { decode_loop(state); });
        render_thread_ = std::thread([this] { render_loop(); });
        device_watchdog_thread_ = std::thread([this] { device_watchdog_loop(); });

#if defined(_WIN32)
        // Lift the render thread above generic worker threads so callback_state_->consumption_counter
        // notifications wake us promptly even when the system is under load. The
        // device callback already runs at MMCSS / RT priority — staying near it
        // limits scheduling jitter that would otherwise underrun the ring.
        SetThreadPriority(render_thread_.native_handle(), THREAD_PRIORITY_HIGHEST);
#endif

        // Bring up the default routing so a freshly-loaded cue can be heard
        // without any explicit routing API calls from the client.
        ensure_default_routing();
        {
            std::lock_guard lock{decode_state_->wait_mutex};
            decode_state_->active.store(true, std::memory_order_release);
        }
        decode_state_->wake.notify_all();
        return true;
    } catch (...) {
        stop();
        throw;
    }
}

void AudioEngine::stop() {
    if (!running_.exchange(false)) return;
    callback_state_->active.store(false, std::memory_order_release);
    callback_state_->run_generation.fetch_add(1, std::memory_order_acq_rel);
    if (const auto devices = snapshot_devices()) for (const auto& device : *devices) {
        std::lock_guard state_lock{device->state_mutex};
        if (device->recovery_in_progress.load(std::memory_order_acquire) ||
            device->recovery_requested.exchange(false, std::memory_order_acq_rel)) {
            device->started.store(false, std::memory_order_release);
            (void)device->recovery_request.fail(device->recovery_request.request_id());
        }
    }
    {
        std::lock_guard lock{decode_state_->wait_mutex};
        decode_state_->active.store(false, std::memory_order_release);
    }
    decode_state_->wake.notify_all();
    callback_state_->watchdog_cv.notify_all();
    // Kick the render thread out of any callback_state_->consumption_counter.wait().
    callback_state_->consumption_counter.fetch_add(1, std::memory_order_release);
    callback_state_->consumption_counter.notify_all();
    if (render_thread_.joinable()) render_thread_.join();
    if (device_watchdog_thread_.joinable()) device_watchdog_thread_.join();
    Logger::info("AudioEngine: stopped.");
}

// ---------------------------------------------------------------------------
// Topology snapshot management
// ---------------------------------------------------------------------------
std::shared_ptr<const Topology> AudioEngine::snapshot_topology() const noexcept {
    return topology_.load();
}

std::shared_ptr<const AudioEngine::DeviceList>
AudioEngine::snapshot_devices() const noexcept {
    return device_snapshot_.load();
}

void AudioEngine::publish_device_snapshot_locked() {
    if (auto old = device_snapshot_.load()) retired_device_snapshots_.push_back(std::move(old));
    device_snapshot_.store(std::make_shared<const DeviceList>(devices_));
    reclaim_snapshots_locked();
}

void AudioEngine::publish_topology(std::shared_ptr<const Topology> snap) {
    auto decode_cues = std::make_shared<DecodeState::Cues>();
    decode_cues->reserve(snap->items.size());
    for (const auto& entry : snap->items) decode_cues->emplace_back(entry.item);
    if (auto old = topology_.load()) retired_topologies_.push_back(std::move(old));
    topology_.store(std::move(snap));
    reclaim_snapshots_locked();
    decode_state_->cues.store(std::move(decode_cues));
    decode_state_->wake.notify_all();
}

void AudioEngine::reclaim_snapshots_locked() {
    const auto unreferenced = [](const auto& value) { return value.use_count() == 1; };
    std::erase_if(retired_topologies_, unreferenced);
    std::erase_if(retired_device_snapshots_, unreferenced);
    std::erase_if(retired_devices_, unreferenced);
    std::erase_if(prepared_follows_, [](const auto& follow) {
        const auto status = follow->status.load(std::memory_order_acquire);
        return (status == PreparedFollow::State::Fired ||
                status == PreparedFollow::State::Cancelled) && follow.use_count() == 1;
    });
}

void AudioEngine::rebuild_topology_locked() {
    auto snap = std::make_shared<Topology>();
    const auto block = static_cast<std::size_t>(cfg_.render_block);
    for (const auto& follow : prepared_follows_) {
        if (follow->status.load(std::memory_order_acquire) ==
            PreparedFollow::State::Armed) snap->follows.push_back(follow);
    }

    // Mixer ownership and mixer-id lookup are frozen into the snapshot. The
    // hash table exists only here on the control thread; render sends carry a
    // direct accumulator index.
    std::unordered_map<std::string, std::size_t> mixer_indices;
    snap->mixers.reserve(mixers_.size());
    mixer_indices.reserve(mixers_.size());
    for (auto& [id, mixer] : mixers_) {
        const auto index = snap->mixers.size();
        mixer_indices.emplace(id, index);
        snap->mixers.emplace_back(mixer);
    }
    snap->mixer_accumulators.assign(
        snap->mixers.size() * kMixerLanes,
        std::vector<Sample>(block, 0.0f));

    // ---- Items ----
    snap->items.reserve(items_.size());
    for (auto& [id_str, item] : items_) {
        ItemRouteEntry entry;
        entry.item = item;

        const ChannelCount n_src = item->source_channel_count();
        entry.per_source_channel.resize(n_src);
        // Keep one spare channel so toggling LTC on does not force allocation
        // on the render thread before the routing snapshot is rebuilt.
        const ChannelCount scratch_channels =
            n_src + (item->desc().ltc_enabled ? 0u : 1u);
        entry.channel_buffers.assign(
            scratch_channels, std::vector<Sample>(block, 0.0f));
        entry.channel_ptrs.reserve(scratch_channels);
        for (auto& channel : entry.channel_buffers) {
            entry.channel_ptrs.push_back(channel.data());
        }

        // Find sends for this item, expanding kAllMixerLanes into one send
        // per concrete lane so the render loop never branches on it.
        auto it = pending_.item_sources.find(id_str);
        if (it != pending_.item_sources.end()) {
            const auto& isr = it->second.by_source_channel;
            for (ChannelIndex c = 0; c < n_src; ++c) {
                if (c >= isr.size()) continue;
                for (const auto& send : isr[c]) {
                    auto mit = mixer_indices.find(send.mixer.value);
                    if (mit == mixer_indices.end()) continue;
                    if (send.lane == kAllMixerLanes) {
                        for (ChannelIndex l = 0; l < kMixerLanes; ++l) {
                            entry.per_source_channel[c].sends.push_back(
                                {mit->second, l, send.gain_lin});
                        }
                    } else if (send.lane < kMixerLanes) {
                        entry.per_source_channel[c].sends.push_back(
                            {mit->second, send.lane, send.gain_lin});
                    }
                }
            }
        }
        snap->items.emplace_back(std::move(entry));
    }

    // ---- Masters ----
    snap->masters.resize(cfg_.master_channels);
    snap->master_accumulators.assign(
        cfg_.master_channels, std::vector<Sample>(block, 0.0f));
    for (MasterChannelIndex m = 0; m < cfg_.master_channels; ++m) {
        snap->masters[m].index       = m;
        snap->masters[m].destination = pending_.master_destinations[m];
    }
    for (auto& [mixer_id_str, master_sends] : pending_.mixer_to_master) {
        auto mit = mixer_indices.find(mixer_id_str);
        if (mit == mixer_indices.end()) continue;
        for (auto& send : master_sends) {
            if (send.master >= cfg_.master_channels) continue;
            if (send.lane == kAllMixerLanes) {
                for (ChannelIndex l = 0; l < kMixerLanes; ++l) {
                    snap->masters[send.master].sends.push_back(
                        {mit->second, l, send.gain_lin});
                }
            } else if (send.lane < kMixerLanes) {
                snap->masters[send.master].sends.push_back(
                    {mit->second, send.lane, send.gain_lin});
            }
        }
    }

    publish_topology(std::move(snap));
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------
void AudioEngine::refresh_device_catalog(const std::shared_ptr<DeviceCatalog>& catalog,
    const std::shared_ptr<std::mutex>& lifecycle, ma_context* test_context) {
    std::vector<NativeDeviceInfo> devices;
    bool complete = false;
    try {
        std::lock_guard lifecycle_lock{*lifecycle};
        ma_context local{};
        ma_context* context = test_context;
        std::unique_ptr<ma_context, decltype(&ma_context_uninit)> cleanup{nullptr, &ma_context_uninit};
        if (!context && ma_context_init(nullptr, 0, nullptr, &local) == MA_SUCCESS) {
            context = &local; cleanup.reset(context);
        }
        ma_device_info* playback = nullptr;
        ma_uint32 count = 0;
        if (context && ma_context_get_devices(context, &playback, &count, nullptr, nullptr) == MA_SUCCESS) {
            for (ma_uint32 i = 0; i < count; ++i) {
                NativeDeviceInfo entry;
                entry.native_id = playback[i].id;
                auto& info = entry.info;
                info.id = DeviceId{playback[i].name};
                info.display_name = playback[i].name;
                info.is_default = playback[i].isDefault != 0;
                ma_device_info full{};
                if (ma_context_get_device_info(context, ma_device_type_playback, &playback[i].id, &full) == MA_SUCCESS) {
                    info.channel_count = full.nativeDataFormatCount > 0 ? full.nativeDataFormats[0].channels : 2;
                    info.sample_rate = full.nativeDataFormatCount > 0 ? full.nativeDataFormats[0].sampleRate : 48'000;
                }
                devices.push_back(std::move(entry));
            }
            complete = true;
        }
    } catch (const std::exception& error) { Logger::warn("Device catalog refresh failed: {}", error.what()); }
    std::lock_guard lock{catalog->mutex};
    if (complete) { catalog->devices = std::move(devices); catalog->has_snapshot = true; }
    catalog->next_refresh = std::chrono::steady_clock::now() + std::chrono::seconds{1};
    catalog->refreshing = false;
    catalog->ready.notify_all();
}

std::vector<DeviceInfo> AudioEngine::enumerate_devices() const {
    std::vector<NativeDeviceInfo> hardware;
    bool refresh = false;
    bool has_snapshot;
    {
        std::lock_guard lock{device_catalog_->mutex};
        hardware = device_catalog_->devices;
        has_snapshot = device_catalog_->has_snapshot;
        if (!device_catalog_->refreshing && std::chrono::steady_clock::now() >= device_catalog_->next_refresh) {
            device_catalog_->refreshing = refresh = true;
            device_catalog_->next_refresh = std::chrono::steady_clock::now() + std::chrono::seconds{1};
        }
    }
    if (refresh) {
        ma_context* test_context = nullptr;
#ifdef LIVEPLAY_TEST_HOOKS
        test_context = device_test_context_;
#endif
        try {
            std::thread([catalog = device_catalog_, lifecycle = device_lifecycle_mutex_, test_context] {
                refresh_device_catalog(catalog, lifecycle, test_context);
            }).detach();
        } catch (const std::system_error& error) {
            std::lock_guard lock{device_catalog_->mutex};
            device_catalog_->refreshing = false;
            Logger::warn("Device catalog worker failed: {}", error.what());
        }
    }
    if (!has_snapshot) {
        // Preserve ordinary cold selections without inheriting an unbounded OS wait.
        std::unique_lock lock{device_catalog_->mutex};
        device_catalog_->ready.wait_for(lock, std::chrono::milliseconds{50}, [&] { return !device_catalog_->refreshing; });
        hardware = device_catalog_->devices;
        has_snapshot = device_catalog_->has_snapshot;
    }
    std::vector<DeviceInfo> out;
    const auto opened = snapshot_devices();
    std::vector<bool> opened_matched(opened ? opened->size() : 0, false);

    const auto overlay_runtime = [](DeviceInfo& info, const Device& dev) {
        std::lock_guard state_lock{dev.state_mutex};
        // API mutations use the engine's opened-instance id, not the
        // enumeration-only hardware-name id.
        info.id = dev.id;
        info.is_open = true;
        info.recovery_request_id = dev.recovery_request.request_id();
        info.recovery_status = device_recovery_status_name(
            dev.recovery_request.status());
        const auto runtime_state =
            dev.runtime_state.load(std::memory_order_acquire);
        info.is_clock_master =
            runtime_state == DeviceRuntimeState::Running &&
            dev.clock_master.load(std::memory_order_acquire);
        info.runtime_state = device_runtime_state_name(runtime_state);
        if (runtime_state == DeviceRuntimeState::Disconnected || runtime_state == DeviceRuntimeState::Closing ||
            runtime_state == DeviceRuntimeState::Interrupted) info.is_available = false;
        info.underrun_count +=
            dev.underrun_count.load(std::memory_order_acquire);
        info.underrun_frames +=
            dev.underrun_frames.load(std::memory_order_acquire);
        info.overrun_count +=
            dev.overrun_count.load(std::memory_order_acquire);
        info.hard_resync_count +=
            dev.hard_resync_count.load(std::memory_order_acquire);
        info.device_loss_count +=
            dev.device_loss_count.load(std::memory_order_acquire);
        info.device_recovery_count +=
            dev.device_recovery_count.load(std::memory_order_acquire);
        info.callback_entry_count = dev.callback_entries.value();
        info.stream_recovery_count +=
            dev.stream_recovery_count.load(std::memory_order_acquire);
        info.reroute_count +=
            dev.reroute_count.load(std::memory_order_acquire);
        info.interruption_count +=
            dev.interruption_count.load(std::memory_order_acquire);
        info.correction_limit_count +=
            dev.correction_limit_count.load(std::memory_order_acquire);
        info.ring_occupancy_frames =
            dev.ring_occupancy_frames.load(std::memory_order_acquire);
        info.clock_correction_ppm =
            dev.clock_correction_ppm.load(std::memory_order_acquire);
    };

    for (const auto& entry : hardware) {
        auto info = entry.info;
        if (opened) for (std::size_t i = 0; i < opened->size(); ++i) {
            const auto& dev = (*opened)[i];
            if (dev->closing.load(std::memory_order_acquire) || !dev->ma_dev) continue;
            std::unique_lock native_lock{dev->native_mutex, std::try_to_lock};
            if (!native_lock.owns_lock() ||
                !ma_device_id_equal(&dev->ma_dev->playback.id, &entry.native_id)) continue;
            opened_matched[i] = true;
            overlay_runtime(info, *dev);
        }
        out.emplace_back(std::move(info));
    }
    if (opened) for (std::size_t i = 0; i < opened->size(); ++i) {
        if (opened_matched[i]) continue;
        const auto& dev = (*opened)[i];
        DeviceInfo info;
        info.display_name = dev->display_name;
        info.channel_count = dev->channels;
        info.sample_rate = dev->sample_rate;
        info.is_available = !has_snapshot;
        overlay_runtime(info, *dev);
        out.emplace_back(std::move(info));
    }
    return out;
}

// miniaudio data callback shared by all opened devices. Runs on the device's
// real-time audio thread. Drains the per-device ring buffer into miniaudio's
// output and — after consuming any samples — notifies the engine's render
// thread to refill the ring. This is the consumer side of our device-callback-
// driven synchronisation: the device clock dictates production cadence.
void AudioEngine::ma_notification_callback(
    const ma_device_notification* notification) {
    if (!notification || !notification->pDevice) return;
    auto* device = reinterpret_cast<Device*>(
        notification->pDevice->pUserData);
    if (!device || device->closing.load(std::memory_order_acquire)) return;

    const auto wake_engine = [&] {
        if (!device->callback_state) return;
        device->callback_state->consumption_counter.fetch_add(
            1, std::memory_order_release);
        device->callback_state->consumption_counter.notify_all();
        device->callback_state->watchdog_cv.notify_one();
    };
    const auto await_verified_callback = [&](DeviceRuntimeState previous) {
        if (device->runtime_state.load(std::memory_order_acquire) != previous) {
            return;
        }

        // Publish a new baseline generation before Starting.  The watchdog
        // samples state first and the generation second, so it cannot accept
        // a callback counted before this recovery edge.
        device->liveness_epoch.fetch_add(1, std::memory_order_release);
        auto expected = previous;
        if (device->runtime_state.compare_exchange_strong(
                expected, DeviceRuntimeState::Starting,
                std::memory_order_release, std::memory_order_acquire)) {
            device->native_recovery_pending.store(
                true, std::memory_order_release);
            device->reset_requested.store(true, std::memory_order_release);
        }
    };

    switch (notification->type) {
        case ma_device_notification_type_started:
            if (!device->recovery_in_progress.load(std::memory_order_acquire)) {
                await_verified_callback(DeviceRuntimeState::Disconnected);
            }
            break;
        case ma_device_notification_type_stopped: {
            if (device->closing.load(std::memory_order_acquire)) {
                device->runtime_state.store(
                    DeviceRuntimeState::Closing, std::memory_order_release);
                break;
            }
            if (device->recovery_in_progress.load(std::memory_order_acquire)) {
                break;
            }
            const auto previous = device->runtime_state.exchange(
                DeviceRuntimeState::Disconnected, std::memory_order_acq_rel);
            if (previous != DeviceRuntimeState::Disconnected) {
                device->device_loss_count.fetch_add(
                    1, std::memory_order_relaxed);
            }
            device->reset_requested.store(true, std::memory_order_release);
            break;
        }
        case ma_device_notification_type_rerouted:
            device->reroute_count.fetch_add(1, std::memory_order_relaxed);
            await_verified_callback(DeviceRuntimeState::Disconnected);
            device->reset_requested.store(true, std::memory_order_release);
            break;
        case ma_device_notification_type_interruption_began:
            device->interruption_count.fetch_add(1, std::memory_order_relaxed);
            device->runtime_state.store(
                DeviceRuntimeState::Interrupted, std::memory_order_release);
            device->reset_requested.store(true, std::memory_order_release);
            break;
        case ma_device_notification_type_interruption_ended:
            await_verified_callback(DeviceRuntimeState::Interrupted);
            break;
        case ma_device_notification_type_unlocked:
            break;
    }
    wake_engine();
}

void AudioEngine::ma_data_callback(ma_device* dev,
                                   void* out,
                                   const void* /*in*/,
                                   std::uint32_t frames) {
    auto* device = reinterpret_cast<Device*>(dev->pUserData);
    if (!device) {
        // No device context — emit silence based on what miniaudio asked for.
        // We don't know channel count without `device`, so use the ma_device's
        // configured channel count to fill the right number of bytes.
        std::memset(out, 0, frames * dev->playback.channels * sizeof(Sample));
        return;
    }
    // Liveness accounting on the RT thread is deliberately one relaxed atomic.
    device->callback_entries.record_entry();
    // The callback never waits. The render thread briefly claims this flag
    // only while resetting ring/resampler state; a collision emits silence
    // for this callback and lets the render thread finish the hard re-lock.
    if (device->callback_active.exchange(true, std::memory_order_acq_rel)) {
        std::memset(out, 0, frames * device->channels * sizeof(Sample));
        if (device->callback_state) {
            device->callback_state->consumption_counter.fetch_add(
                1, std::memory_order_release);
            device->callback_state->consumption_counter.notify_one();
        }
        return;
    }
    AtomicActiveGuard callback_guard{device->callback_active};

    const auto wake_render = [&] {
        if (!device->callback_state) return;
        device->callback_state->consumption_counter.fetch_add(
            1, std::memory_order_release);
        device->callback_state->consumption_counter.notify_one();
    };

    if (!device->ring ||
        !device->started.load(std::memory_order_acquire) ||
        device->closing.load(std::memory_order_acquire) ||
        device->runtime_state.load(std::memory_order_acquire) !=
            DeviceRuntimeState::Running ||
        device->reset_requested.load(std::memory_order_acquire)) {
        std::memset(out, 0, frames * device->channels * sizeof(Sample));
        wake_render();
        return;
    }

    Sample* dst = static_cast<Sample*>(out);
    std::uint32_t remaining = frames;
    const bool correct_clock =
        !device->clock_master.load(std::memory_order_acquire) &&
        device->clock_resampler_initialized &&
        device->clock_resampler;

    if (correct_clock) {
        const auto occupancy = ma_pcm_rb_available_read(device->ring.get());
        device->ring_occupancy_frames.store(
            occupancy, std::memory_order_relaxed);
        const double ratio = device->clock_controller.update(occupancy);
        // Bound miniaudio's 32-bit phase product; odd numerators retain the
        // fractional clock across GCD reduction and unity (31 ppm steps).
        constexpr ma_uint32 kRatioScale = 65'536;
        const auto input_rate = static_cast<ma_uint32>(
            2 * std::lround(ratio * (kRatioScale / 2) - 0.5) + 1);
        const auto correction_ppm = static_cast<std::int32_t>(
            std::lround((static_cast<double>(input_rate) / kRatioScale - 1.0) *
                        1'000'000.0));
        device->clock_correction_ppm.store(
            static_cast<float>(correction_ppm), std::memory_order_relaxed);
        const bool limited = device->clock_controller.limited();
        if (limited && !device->correction_was_limited) {
            device->correction_limit_count.fetch_add(
                1, std::memory_order_relaxed);
        }
        device->correction_was_limited = limited;

        const auto applied = device->applied_rate_ppm.load(
            std::memory_order_relaxed);
        if (std::abs(correction_ppm - applied) >= 10) {
            if (ma_resampler_set_rate(
                    device->clock_resampler.get(), input_rate,
                    kRatioScale) == MA_SUCCESS) {
                device->applied_rate_ppm.store(
                    correction_ppm, std::memory_order_relaxed);
            }
        }

        while (remaining > 0) {
            void* buf = nullptr;
            ma_uint32 available =
                ma_pcm_rb_available_read(device->ring.get());
            if (available == 0 ||
                ma_pcm_rb_acquire_read(
                    device->ring.get(), &available, &buf) != MA_SUCCESS) {
                break;
            }

            ma_uint64 input_frames = available;
            ma_uint64 output_frames = remaining;
            const ma_result result = ma_resampler_process_pcm_frames(
                device->clock_resampler.get(), buf, &input_frames,
                dst, &output_frames);
            if (input_frames > 0) {
                ma_pcm_rb_commit_read(
                    device->ring.get(), static_cast<ma_uint32>(input_frames));
            }
            dst += output_frames * device->channels;
            remaining -= static_cast<std::uint32_t>(output_frames);
            if (result != MA_SUCCESS ||
                (input_frames == 0 && output_frames == 0)) {
                break;
            }
        }
    } else {
        device->clock_correction_ppm.store(0.0f, std::memory_order_relaxed);
        while (remaining > 0) {
            void* buf = nullptr;
            ma_uint32 available = remaining;
            if (ma_pcm_rb_acquire_read(
                    device->ring.get(), &available, &buf) != MA_SUCCESS ||
                available == 0) {
                break;
            }
            std::memcpy(
                dst, buf, available * device->channels * sizeof(Sample));
            ma_pcm_rb_commit_read(device->ring.get(), available);
            dst += available * device->channels;
            remaining -= available;
        }
    }

    device->ring_occupancy_frames.store(
        ma_pcm_rb_available_read(device->ring.get()),
        std::memory_order_relaxed);
    if (remaining > 0) {
        std::memset(dst, 0, remaining * device->channels * sizeof(Sample));
        device->underrun_count.fetch_add(1, std::memory_order_relaxed);
        device->underrun_frames.fetch_add(
            remaining, std::memory_order_relaxed);
        if (!device->reset_requested.exchange(
                true, std::memory_order_acq_rel)) {
            device->hard_resync_count.fetch_add(
                1, std::memory_order_relaxed);
        }
    }

    // Protect the physical sum after clock resampling. Moving the existing
    // lookahead stage here keeps one delay, including when explicitly bypassed.
    const bool limiter_enabled = !device->callback_state ||
        device->callback_state->limiter_enabled.load(std::memory_order_acquire);
    auto* output = static_cast<Sample*>(out);
    for (std::size_t offset = 0; offset < frames;) {
        const auto count = std::min<std::size_t>(
            frames - offset, device->output_mono.size());
        for (ChannelIndex ch = 0; ch < device->channels; ++ch) {
            for (std::size_t s = 0; s < count; ++s)
                device->output_mono[s] =
                    output[(offset + s) * device->channels + ch];
            auto& state = device->outputs[ch];
            state.limiter->process(device->output_mono.data(), count,
                                   limiter_enabled);
            state.meter->push_block(device->output_mono.data(), count);
            for (std::size_t s = 0; s < count; ++s)
                output[(offset + s) * device->channels + ch] =
                    device->output_mono[s];
        }
        offset += count;
    }
    wake_render();
}

DeviceId AudioEngine::open_default_device(ChannelCount output_channels) {
    return open_device_by_name("", output_channels);
}

DeviceId AudioEngine::open_device_by_name(const std::string& name_substring,
                                          ChannelCount output_channels) {
    {
        std::lock_guard lock{mutex_};
        if (auto* existing = find_device_locked(DeviceId{name_substring});
            existing && !existing->closing.load(std::memory_order_acquire)) {
            existing->open_references.acquire();
            return existing->id;
        }
    }
    std::lock_guard lifecycle_lock{*device_lifecycle_mutex_};
    auto dev = std::make_shared<Device>();
    dev->id           = DeviceId{gen_uuid_like()};
    dev->channels     = output_channels;
    dev->sample_rate  = cfg_.mix_sample_rate;
    dev->display_name = name_substring.empty() ? "Default Output" : name_substring;
    dev->ma_dev       = std::make_unique<ma_device>();
    dev->ring         = std::make_unique<ma_pcm_rb>();
    dev->callback_state = callback_state_;

    // Keep enough headroom for the render thread without queueing stopped-cue
    // silence hundreds of milliseconds ahead of a transport command.
    const ma_uint32 ring_frames = static_cast<ma_uint32>(cfg_.render_block * 4);
    if (ma_pcm_rb_init(ma_format_f32, output_channels, ring_frames,
                       nullptr, nullptr, dev->ring.get()) != MA_SUCCESS) {
        Logger::error("Failed to allocate ring buffer for device '{}'", dev->display_name);
        return {};
    }
    dev->clock_resampler = std::make_unique<ma_resampler>();
    auto resampler_cfg = ma_resampler_config_init(
        ma_format_f32, output_channels, cfg_.mix_sample_rate,
        cfg_.mix_sample_rate, ma_resample_algorithm_linear);
    // Clock matching moves by only a few parts per million. Disabling the
    // anti-alias LPF removes needless callback work and resampler latency at
    // ratios that never approach an aliasing boundary.
    resampler_cfg.linear.lpfOrder = 0;
    if (ma_resampler_init(
            &resampler_cfg, nullptr, dev->clock_resampler.get()) !=
        MA_SUCCESS) {
        Logger::error(
            "Failed to initialize clock adapter for device '{}'",
            dev->display_name);
        ma_pcm_rb_uninit(dev->ring.get());
        return {};
    }
    dev->clock_resampler_initialized = true;
    // Center pre-callback occupancy above the half-ring by half a block,
    // leaving equal room for independently scheduled writes and drains.
    dev->clock_controller.configure(
        ring_frames,
        (ring_frames + static_cast<ma_uint32>(cfg_.render_block)) / 2);

    ma_device_config cfg = ma_device_config_init(ma_device_type_playback);
    cfg.playback.format    = ma_format_f32;
    cfg.playback.channels  = output_channels;
    cfg.sampleRate         = cfg_.mix_sample_rate;
    cfg.dataCallback       = &AudioEngine::ma_data_callback;
    cfg.notificationCallback = &AudioEngine::ma_notification_callback;
    cfg.pUserData          = dev.get();
    cfg.periodSizeInFrames = static_cast<ma_uint32>(cfg_.render_block);

    // A saved display name wins over a prefix sibling (USB 1 vs USB 10).
    // Legacy callers retain the case-insensitive substring fallback. Empty
    // string leaves pDeviceID null for the system default.
    ma_context ctx;
    ma_device_id matched_id;
    bool         have_match = false;
    if (!name_substring.empty()) {
        if (ma_context_init(nullptr, 0, nullptr, &ctx) == MA_SUCCESS) {
            ma_device_info* infos = nullptr;
            ma_uint32       count = 0;
            if (ma_context_get_devices(&ctx, &infos, &count, nullptr, nullptr) == MA_SUCCESS) {
                ma_uint32 selected = 0;
                for (; selected < count; ++selected)
                    if (name_substring == infos[selected].name) break;
                if (selected == count) {
                    std::string needle = name_substring;
                    std::transform(needle.begin(), needle.end(), needle.begin(),
                                   [](unsigned char c){ return static_cast<char>(std::tolower(c)); });
                    for (selected = 0; selected < count; ++selected) {
                        std::string haystack = infos[selected].name;
                        std::transform(haystack.begin(), haystack.end(), haystack.begin(),
                                       [](unsigned char c){ return static_cast<char>(std::tolower(c)); });
                        if (haystack.find(needle) != std::string::npos) break;
                    }
                }
                if (selected < count) {
                    matched_id = infos[selected].id;
                    cfg.playback.pDeviceID = &matched_id;
                    dev->display_name = infos[selected].name;
                    have_match = true;
                }
            }
            ma_context_uninit(&ctx);
        }
        if (!have_match) {
            Logger::warn("Device matching '{}' not found.", name_substring);
            ma_pcm_rb_uninit(dev->ring.get());
            return {};
        }
    }

    ma_context* device_context = nullptr;
#ifdef LIVEPLAY_TEST_HOOKS
    device_context = device_test_context_;
#endif
    if (ma_device_init(device_context, &cfg, dev->ma_dev.get()) != MA_SUCCESS) {
        Logger::error("ma_device_init failed for '{}'", dev->display_name);
        ma_pcm_rb_uninit(dev->ring.get());
        return {};
    }
    if (dev->ma_dev->playback.name[0] != '\0') {
        dev->display_name = dev->ma_dev->playback.name;
    }

    // Resolve the native device first: "default" and an explicit device name
    // can address the same hardware, which a request-string comparison misses.
    // Opening it twice produces doubled/echoing audio.
    DeviceId duplicate;
    bool identity_pending = false;
    {
        std::lock_guard lock{mutex_};
        const auto existing = std::find_if(
            devices_.begin(), devices_.end(),
            [&](const std::shared_ptr<Device>& candidate) {
                if (candidate->closing.load(std::memory_order_acquire) || !candidate->ma_dev) return false;
                std::unique_lock native_lock{candidate->native_mutex, std::try_to_lock};
                if (!native_lock.owns_lock()) { identity_pending = true; return false; }
                return ma_device_id_equal(&candidate->ma_dev->playback.id, &dev->ma_dev->playback.id) != MA_FALSE;
            });
        if (existing != devices_.end()) {
            (*existing)->open_references.acquire();
            duplicate = (*existing)->id;
        }
    }
    if (!duplicate.empty() || identity_pending) {
        ma_device_uninit(dev->ma_dev.get());
        ma_pcm_rb_uninit(dev->ring.get());
        return duplicate;
    }

    dev->scratch.assign(cfg_.render_block * output_channels, 0.0f);
    dev->output_mono.assign(cfg_.render_block, 0.0f);
    dev->outputs.resize(output_channels);
    DeviceId id = dev->id;
    const std::string display_name = dev->display_name;
    {
        std::lock_guard lock{mutex_};
        for (auto& state : dev->outputs) {
            state.limiter = std::make_unique<Limiter>();
            state.limiter->configure(cfg_.mix_sample_rate, cfg_.master_ceiling_db);
            state.meter = std::make_unique<Meter>();
            state.meter->configure(cfg_.mix_sample_rate, meter_ballistics_);
            state.meter->set_true_peak_enabled(meter_true_peak_);
            state.meter->set_loudness_enabled(meter_loudness_);
        }
        dev->callback_liveness.arm(
            dev->callback_entries.value(), CallbackLivenessMonitor::Clock::now());
    }
    if (ma_device_start(dev->ma_dev.get()) != MA_SUCCESS) {
        Logger::error("ma_device_start failed for '{}'", dev->display_name);
        ma_device_uninit(dev->ma_dev.get());
        ma_pcm_rb_uninit(dev->ring.get());
        return {};
    }
    dev->started.store(true, std::memory_order_release);
    {
        std::lock_guard lock{mutex_};
        for (auto& state : dev->outputs) {
            state.limiter->set_ceiling_db(cfg_.master_ceiling_db);
            state.meter->configure(cfg_.mix_sample_rate, meter_ballistics_);
            state.meter->set_true_peak_enabled(meter_true_peak_);
            state.meter->set_loudness_enabled(meter_loudness_);
        }
        devices_.emplace_back(dev);
        publish_device_snapshot_locked();
    }
    // Wake render thread: when we boot with no devices it idles on a coarse
    // timer; opening the first device should kick it into the live path
    // immediately so the first audio block lands before the device starves.
    callback_state_->consumption_counter.fetch_add(1, std::memory_order_release);
    callback_state_->consumption_counter.notify_all();
    callback_state_->watchdog_cv.notify_one();

    Logger::success("Opened audio device '{}' ({} ch @ {} Hz) → DeviceId {}",
                    display_name, output_channels,
                    cfg_.mix_sample_rate, id.value);
    return id;
}

void AudioEngine::close_device(const DeviceId& id) {
    std::shared_ptr<Device> closing;
    {
        std::lock_guard lock{mutex_};
        auto it = std::find_if(devices_.begin(), devices_.end(),
                               [&](const std::shared_ptr<Device>& d){ return d->id == id; });
        if (it == devices_.end() || !(*it)->open_references.release_is_final()) return;
        closing = *it;
        closing->closing.store(true, std::memory_order_seq_cst);
        closing->started.store(false, std::memory_order_release);
        {
            std::lock_guard state_lock{closing->state_mutex};
            closing->runtime_state.store(DeviceRuntimeState::Closing, std::memory_order_release);
            (void)closing->recovery_request.fail(closing->recovery_request.request_id());
        }
        devices_.erase(it);
        retired_devices_.emplace_back(closing);
        publish_device_snapshot_locked();
        for (auto& dest : pending_.master_destinations)
            if (dest && dest->device == id) dest.reset();
        rebuild_topology_locked();
    }
    // Native work holds no engine/project ownership and cannot outlive its buffers.
    const auto retire = [closing, lifecycle = device_lifecycle_mutex_] {
        std::lock_guard native_lock{closing->native_mutex};
        while (closing->render_active.load(std::memory_order_seq_cst))
            std::this_thread::yield();
        {
            std::lock_guard lifecycle_lock{*lifecycle};
            if (closing->ma_dev) ma_device_uninit(closing->ma_dev.get());
        }
        if (closing->ring) ma_pcm_rb_uninit(closing->ring.get());
        if (closing->clock_resampler_initialized && closing->clock_resampler) {
            ma_resampler_uninit(closing->clock_resampler.get(), nullptr);
            closing->clock_resampler_initialized = false;
            closing->clock_resampler.reset();
        }
        closing->cleanup_done.store(true, std::memory_order_release);
    };
    // shortcut: OS thread exhaustion falls back to synchronous native cleanup.
    try { std::thread(retire).detach(); }
    catch (const std::system_error& error) {
        Logger::error("Device retirement worker failed: {}", error.what());
        retire();
    }
    callback_state_->consumption_counter.fetch_add(1, std::memory_order_release);
    callback_state_->consumption_counter.notify_all();
    Logger::info("Retired audio device '{}'", closing->display_name);
}

std::optional<std::uint64_t> AudioEngine::request_device_recovery(
    const DeviceId& id) {
    if (!running_.load(std::memory_order_acquire)) return std::nullopt;

    std::uint64_t request_id = 0;
    {
        std::lock_guard lock{mutex_};
        auto* device = find_device_locked(id);
        if (!device || !device->ma_dev) return std::nullopt;
        std::lock_guard state_lock{device->state_mutex};
        if (device->closing.load(std::memory_order_acquire) ||
            device->recovery_in_progress.load(std::memory_order_acquire) ||
            device->recovery_requested.load(std::memory_order_acquire) ||
            device->recovery_request.status() == DeviceRecoveryStatus::Pending) {
            return std::nullopt;
        }
        request_id = next_recovery_request_id_++;
        if (!device->recovery_request.begin(request_id)) return std::nullopt;
        device->recovery_requested.store(true, std::memory_order_release);
    }
    callback_state_->watchdog_cv.notify_one();
    return request_id;
}

AudioEngine::Device* AudioEngine::find_device_locked(const DeviceId& id) const {
    for (const auto& d : devices_) if (d->id == id) return d.get();
    return nullptr;
}

const AudioEngine::OutputChannelState* AudioEngine::output_state_locked(
    MasterChannelIndex master) const {
    if (master >= pending_.master_destinations.size()) return nullptr;
    const auto& dest = pending_.master_destinations[master];
    if (!dest) return nullptr;
    const auto* device = find_device_locked(dest->device);
    if (!device || dest->hw_channel >= device->outputs.size()) return nullptr;
    return &device->outputs[dest->hw_channel];
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------
CueId AudioEngine::load_cue(const std::filesystem::path& file_path,
                            std::optional<CueId> requested_id) {
    PlaybackItemDesc desc;
    desc.id              = requested_id.value_or(CueId{gen_uuid_like()});
    desc.file_path       = file_path;
    desc.mix_sample_rate = cfg_.mix_sample_rate;
    desc.render_block    = cfg_.render_block;

    auto item = std::make_shared<PlaybackItem>(std::move(desc));
    if (!item->load()) return {};

    {
        std::lock_guard lock{mutex_};
        item->set_meter_ballistics(meter_ballistics_);
        item->set_true_peak_metering(meter_true_peak_);
        item->set_loudness_metering(meter_loudness_);
        items_[item->id().value] = item;
        pending_.item_sources[item->id().value]
            .by_source_channel
            .resize(item->source_channel_count());
        rebuild_topology_locked();
    }
    // Bring the new cue into the default routing (no-op if already wired).
    ensure_default_routing();
    return item->id();
}

CueId AudioEngine::load_cue_no_route(const std::filesystem::path& file_path,
                                     std::optional<CueId> requested_id) {
    PlaybackItemDesc desc;
    desc.id              = requested_id.value_or(CueId{gen_uuid_like()});
    desc.file_path       = file_path;
    desc.mix_sample_rate = cfg_.mix_sample_rate;
    desc.render_block    = cfg_.render_block;

    auto item = std::make_shared<PlaybackItem>(std::move(desc));
    if (!item->load()) return {};

    return adopt_cue(item);
}

CueId AudioEngine::adopt_cue(const std::shared_ptr<PlaybackItem>& item) {
    if (!item) return {};
    // Register the cue, but do NOT call rebuild_topology_locked() or
    // ensure_default_routing() — both walk every loaded cue and turn a bulk
    // load into O(N²) work. The caller is responsible for invoking
    // ensure_default_routing() once after the batch finishes.
    std::lock_guard lock{mutex_};
    item->set_meter_ballistics(meter_ballistics_);
    item->set_true_peak_metering(meter_true_peak_);
    item->set_loudness_metering(meter_loudness_);
    items_[item->id().value] = item;
    pending_.item_sources[item->id().value]
        .by_source_channel
        .resize(item->source_channel_count());
    return item->id();
}

CueId AudioEngine::new_cue_id() const {
    return CueId{gen_uuid_like()};
}

void AudioEngine::unload_cue(const CueId& id) {
    std::shared_ptr<PlaybackItem> retiring;
    std::unique_lock lock{mutex_};
    auto it = items_.find(id.value);
    if (it == items_.end()) return;
    retiring = it->second;
    for (const auto& follow : prepared_follows_) {
        if (follow->source != it->second && follow->target != it->second) continue;
        auto expected = PreparedFollow::State::Armed;
        follow->status.compare_exchange_strong(
            expected, PreparedFollow::State::Cancelled, std::memory_order_acq_rel);
    }
    retiring->stop_now();
    retiring->decoder_ready_.store(false, std::memory_order_release);
    items_.erase(it);
    pending_.item_sources.erase(id.value);
    rebuild_topology_locked();
    lock.unlock();
    {
        std::lock_guard decode_lock{decode_state_->wait_mutex};
        if (decode_state_->workers.contains(retiring.get())) {
            // Its worker retains the decoder and closes it after the read returns.
            return;
        }
    }
    // Preparation/edit calls may also own the decoder; withdrawal must not join them.
    const auto retire = [retiring] { retiring->unload(); };
    try { std::thread(retire).detach(); }
    catch (const std::system_error& error) {
        Logger::error("Cue retirement worker failed: {}", error.what());
        retire(); // shortcut: synchronous cleanup only if OS thread creation fails.
    }
}

std::shared_ptr<PlaybackItem> AudioEngine::find_cue(const CueId& id) const {
    std::lock_guard lock{mutex_};
    auto it = items_.find(id.value);
    return it != items_.end() ? it->second : nullptr;
}

void AudioEngine::play(const CueId& id) {
    if (auto item = find_cue(id)) {
        Logger::info("play() cue='{}'", id.value);
        item->play();
    } else {
        Logger::warn("play() ignored — no cue with id '{}'", id.value);
    }
}

void AudioEngine::stop(const CueId& id) {
    if (auto item = find_cue(id)) {
        Logger::info("stop() cue='{}'", id.value);
        item->stop();
    }
}

void AudioEngine::stop_all(std::chrono::milliseconds fade, bool force_fade) {
    std::lock_guard lock{mutex_};
    for (const auto& follow : prepared_follows_) {
        auto expected = PreparedFollow::State::Armed;
        follow->status.compare_exchange_strong(
            expected, PreparedFollow::State::Cancelled, std::memory_order_acq_rel);
    }
    for (auto& [_, item] : items_) {
        if (force_fade) {
            // Global fade wins: apply `fade` to EVERY item, ignoring its own
            // fade-out. fade == 0 → hard stop for all. Restore the item's
            // configured fade-out afterwards so a later single stop still uses
            // the per-cue value.
            const auto item_fade = item->desc().fade_out_duration;
            if (fade.count() > 0) item->set_fade_out(fade);
            else                  item->set_fade_out(std::chrono::milliseconds{0});
            item->stop();
            item->set_fade_out(item_fade);
            continue;
        }
        // Default rule: each item's own fade_out_duration wins when non-zero;
        // only when an item is configured for a hard stop (fade-out == 0) do we
        // fall back to the caller-provided `fade`.
        const auto item_fade = item->desc().fade_out_duration;
        if (item_fade.count() > 0) {
            item->stop();
        } else if (fade.count() > 0) {
            item->set_fade_out(fade);
            item->stop();
            item->set_fade_out(std::chrono::milliseconds{0});
        } else {
            item->stop();
        }
    }
}

std::shared_ptr<PreparedFollow> AudioEngine::schedule_follow(
    const CueId& source, const CueId& target, std::uint64_t end_frame) {
    std::lock_guard lock{mutex_};
    const auto a = items_.find(source.value);
    const auto b = items_.find(target.value);
    if (a == items_.end() || b == items_.end() || a == b) return nullptr;
    if (b->second->stats().transport != TransportState::Stopped) return nullptr;
    const auto stats = a->second->stats();
    if ((stats.transport != TransportState::Playing &&
         stats.transport != TransportState::FadingIn) ||
        end_frame <= stats.playhead_frame) return nullptr;
    const auto source_revision = a->second->playback_revision();
    const auto target_revision = b->second->prepare_start();
    if (target_revision == 0 ||
        a->second->playback_revision() != source_revision) return nullptr;
    for (const auto& previous : prepared_follows_) {
        if (previous->source != a->second) continue;
        auto expected = PreparedFollow::State::Armed;
        previous->status.compare_exchange_strong(
            expected, PreparedFollow::State::Cancelled, std::memory_order_acq_rel);
    }
    auto follow = std::make_shared<PreparedFollow>();
    follow->source = a->second;
    follow->target = b->second;
    follow->source_revision = source_revision;
    follow->target_revision = target_revision;
    follow->end_frame = end_frame;
    prepared_follows_.push_back(follow);
    rebuild_topology_locked();
    return follow;
}

// ---------------------------------------------------------------------------
// Sensible-default routing — bootstrap the engine into a usable state
// without requiring the caller to call open_default_device + create mixer
// + route + assign master explicitly. Idempotent.
// ---------------------------------------------------------------------------
void AudioEngine::ensure_default_routing() {
    ensure_default_routing_impl(std::nullopt);
}

void AudioEngine::ensure_default_routing_for_cue(const CueId& cue) {
    ensure_default_routing_impl(cue);
}

void AudioEngine::ensure_default_routing_impl(
    const std::optional<CueId>& cue_filter) {
    // Step 1: open a device if none open. open_device_by_name takes its own
    // lock; we must therefore call it OUTSIDE the engine mutex.
    DeviceId chosen_device{};
    {
        std::lock_guard lock{mutex_};
        // An existing Main master assignment already owns its device. Merely
        // finding some other open device is not ownership: preview may have
        // opened it first and is allowed to release its own reference later.
        for (std::size_t i = 0;
             i < 2 && i < pending_.master_destinations.size(); ++i) {
            if (pending_.master_destinations[i]) {
                chosen_device = pending_.master_destinations[i]->device;
                break;
            }
        }
    }
    if (chosen_device.empty()) {
        // Acquire a dedicated Main reference even when this resolves to native
        // hardware already opened by preview or another routing owner.
        chosen_device = open_default_device(2);
        if (chosen_device.empty()) {
            Logger::warn("ensure_default_routing: could not open default device — playback will be silent.");
            return;
        }
    }

    // Keep the automatic Main identity independent of other strips and names.
    MixerChannelId main_mixer{};

    // Step 3: wire master 0/1 → device 0/1 if not already.
    {
        std::lock_guard lock{mutex_};
        if (main_mixer_.empty() || !mixers_.contains(main_mixer_.value))
            main_mixer_ = create_mixer_channel_locked("Main");
        main_mixer = main_mixer_;
        if (pending_.master_destinations.size() < 2) {
            pending_.master_destinations.resize(2);
        }
        for (std::size_t i = 0; i < 2; ++i) {
            if (!pending_.master_destinations[i].has_value()) {
                MasterDestination dest;
                dest.device     = chosen_device;
                dest.hw_channel = static_cast<ChannelIndex>(i);
                pending_.master_destinations[i] = dest;
            }
        }
        // Step 4: route Main mixer lanes → masters (lane 0 → master 0 = L,
        // lane 1 → master 1 = R) so the strip's stereo image survives.
        auto& m2m = pending_.mixer_to_master[main_mixer.value];
        bool has_m0 = false, has_m1 = false;
        for (auto& s : m2m) {
            if (s.master == 0) has_m0 = true;
            if (s.master == 1) has_m1 = true;
        }
        if (!has_m0) m2m.push_back({0, 0, 1.0f});
        if (!has_m1) m2m.push_back({1, 1, 1.0f});

        // Step 5: auto-route every loaded cue's source channels → Main, but
        // ONLY for cues that have no routes yet. Cues that were explicitly
        // routed elsewhere (preview bus, per-device override, etc.) must not
        // be silently dragged back onto Main — that was the source of two
        // separate bugs:
        //   1. The preview cue (loaded with load_cue_no_route, routed only to
        //      the Preview mixer) bled onto Main on any subsequent play_item,
        //      because each play_item re-runs ensure_default_routing().
        //   2. Cues with `deviceOverride` were being double-routed (override
        //      mixer AND Main), so audio appeared in both outputs.
        // The LTC synthetic channel (always the last source channel on
        // LTC-enabled cues) is deliberately excluded — it has its own
        // dedicated device routing managed by apply_ltc_device_routing().
        for (auto& [cue_id, item] : items_) {
            if (cue_filter && cue_id != cue_filter->value) continue;
            auto& srcs = pending_.item_sources[cue_id].by_source_channel;
            const auto src_count = item->source_channel_count();
            if (srcs.size() < src_count) srcs.resize(src_count);
            const auto audio_count = item->desc().ltc_enabled
                                     ? src_count - 1 : src_count;
            // Determine whether ANY audio source channel of this cue already
            // has a route to any mixer. If so, leave the cue alone.
            bool has_any_existing_route = false;
            for (ChannelIndex ch = 0; ch < audio_count; ++ch) {
                if (!srcs[ch].empty()) { has_any_existing_route = true; break; }
            }
            if (has_any_existing_route) continue;
            for (ChannelIndex ch = 0; ch < audio_count; ++ch) {
                const auto gains = item->stereo_mix_gains(ch);
                if (gains[0] > 0.0f && gains[0] == gains[1])
                    srcs[ch].push_back({main_mixer, kAllMixerLanes, gains[0]});
                else
                    for (ChannelIndex lane = 0; lane < kMixerLanes; ++lane)
                        if (gains[lane] > 0.0f)
                            srcs[ch].push_back({main_mixer, lane, gains[lane]});
            }
        }

        rebuild_topology_locked();
    }
    Logger::info("ensure_default_routing: ready (device='{}', main_mixer='{}')",
                 chosen_device.value, main_mixer.value);
}

// ---------------------------------------------------------------------------
// Mixer channels
// ---------------------------------------------------------------------------
MixerChannelId AudioEngine::create_mixer_channel(std::string display_name) {
    std::lock_guard lock{mutex_};
    const auto id = create_mixer_channel_locked(std::move(display_name));
    rebuild_topology_locked();
    return id;
}

MixerChannelId AudioEngine::create_mixer_channel_locked(std::string display_name) {
    auto id = MixerChannelId{gen_uuid_like()};
    auto ch = std::make_shared<MixerChannel>(id, std::move(display_name));
    ch->configure(cfg_.mix_sample_rate, cfg_.render_block);
    ch->configure_meters(meter_ballistics_);        // inherit project settings
    ch->set_true_peak_enabled(meter_true_peak_);
    ch->set_loudness_enabled(meter_loudness_);
    mixers_[id.value] = ch;
    return id;
}

void AudioEngine::remove_mixer_channel(const MixerChannelId& id) {
    std::lock_guard lock{mutex_};
    if (id == main_mixer_) main_mixer_ = {};
    mixers_.erase(id.value);
    pending_.mixer_to_master.erase(id.value);
    for (auto& [_, item_routes] : pending_.item_sources) {
        for (auto& sends : item_routes.by_source_channel) {
            sends.erase(std::remove_if(sends.begin(), sends.end(),
                                       [&](auto& s){ return s.mixer == id; }),
                        sends.end());
        }
    }
    rebuild_topology_locked();
}

std::shared_ptr<MixerChannel> AudioEngine::find_mixer_channel(
    const MixerChannelId& id) const {
    std::lock_guard lock{mutex_};
    auto it = mixers_.find(id.value);
    return it != mixers_.end() ? it->second : nullptr;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
void AudioEngine::route_item_source_to_mixer(const CueId& cue,
                                             ChannelIndex source_channel,
                                             const MixerChannelId& mixer,
                                             float gain_db,
                                             ChannelIndex lane) {
    std::lock_guard lock{mutex_};
    auto it = items_.find(cue.value);
    if (it == items_.end()) return;
    if (mixers_.find(mixer.value) == mixers_.end()) return;

    auto& routes = pending_.item_sources[cue.value].by_source_channel;
    if (source_channel >= routes.size()) routes.resize(source_channel + 1);

    // One send per (source_channel, mixer) pair — re-routing replaces the
    // existing send's gain and lane rather than stacking a second feed.
    auto& sends = routes[source_channel];
    const float gl = db_to_lin(gain_db);
    std::erase_if(sends, [&](const auto& send) { return send.mixer == mixer; });
    sends.push_back({mixer, lane, gl});

    rebuild_topology_locked();
}

void AudioEngine::set_item_source_mixer(const CueId& cue, ChannelIndex source_channel,
                                       const MixerChannelId& mixer) {
    std::lock_guard lock{mutex_};
    if (!items_.contains(cue.value) || (!mixer.empty() && !mixers_.contains(mixer.value))) return;
    auto& routes = pending_.item_sources[cue.value].by_source_channel;
    if (source_channel >= routes.size()) {
        if (mixer.empty()) return;
        routes.resize(source_channel + 1);
    }
    auto& sends = routes[source_channel];
    if (mixer.empty()) sends.clear();
    else sends = {{mixer, kAllMixerLanes, 1.0f}};
    rebuild_topology_locked();
}

void AudioEngine::unroute_item_source_from_mixer(const CueId& cue,
                                                  ChannelIndex source_channel,
                                                  const MixerChannelId& mixer) {
    std::lock_guard lock{mutex_};
    auto it = pending_.item_sources.find(cue.value);
    if (it == pending_.item_sources.end()) return;
    auto& routes = it->second.by_source_channel;
    if (source_channel >= routes.size()) return;
    auto& sends = routes[source_channel];
    sends.erase(std::remove_if(sends.begin(), sends.end(),
                               [&](auto& s){ return s.mixer == mixer; }),
                sends.end());
    rebuild_topology_locked();
}

void AudioEngine::unroute_item_from_all_mixers(const CueId& cue) {
    std::lock_guard lock{mutex_};
    auto it = pending_.item_sources.find(cue.value);
    if (it == pending_.item_sources.end()) return;
    bool changed = false;
    for (auto& sends : it->second.by_source_channel) {
        if (!sends.empty()) { sends.clear(); changed = true; }
    }
    if (changed) rebuild_topology_locked();
}

void AudioEngine::route_mixer_to_master(const MixerChannelId& mixer,
                                        MasterChannelIndex master,
                                        float gain_db,
                                        ChannelIndex lane) {
    if (master >= cfg_.master_channels) return;
    std::lock_guard lock{mutex_};
    if (mixers_.find(mixer.value) == mixers_.end()) return;
    // One send per (mixer, master) pair — re-routing replaces the existing
    // send's gain and lane rather than stacking a second feed.
    auto& v = pending_.mixer_to_master[mixer.value];
    auto vit = std::find_if(v.begin(), v.end(),
                            [&](auto& s){ return s.master == master; });
    const float gl = db_to_lin(gain_db);
    if (vit != v.end()) { vit->gain_lin = gl; vit->lane = lane; }
    else v.push_back({master, lane, gl});
    rebuild_topology_locked();
}

void AudioEngine::unroute_mixer_from_master(const MixerChannelId& mixer,
                                            MasterChannelIndex master) {
    std::lock_guard lock{mutex_};
    auto it = pending_.mixer_to_master.find(mixer.value);
    if (it == pending_.mixer_to_master.end()) return;
    auto& v = it->second;
    v.erase(std::remove_if(v.begin(), v.end(),
                           [&](auto& s){ return s.master == master; }), v.end());
    rebuild_topology_locked();
}

void AudioEngine::assign_master_to_device(MasterChannelIndex master,
                                          const DeviceId& device,
                                          ChannelIndex hw_channel) {
    if (master >= cfg_.master_channels) return;
    std::lock_guard lock{mutex_};
    if (!find_device_locked(device)) return;
    pending_.master_destinations[master] = MasterDestination{device, hw_channel};
    rebuild_topology_locked();
}

void AudioEngine::clear_master_assignment(MasterChannelIndex master) {
    if (master >= cfg_.master_channels) return;
    std::lock_guard lock{mutex_};
    pending_.master_destinations[master].reset();
    rebuild_topology_locked();
}

// ---------------------------------------------------------------------------
// Master
// ---------------------------------------------------------------------------
void AudioEngine::set_master_ceiling_db(float db) {
    if (!std::isfinite(db)) return;
    db = std::clamp(db, -60.0f, 0.0f);
    std::lock_guard lock{mutex_};
    cfg_.master_ceiling_db = db;
    for (auto& device : devices_)
        for (auto& state : device->outputs) state.limiter->set_ceiling_db(db);
}

void AudioEngine::set_limiter_enabled(bool enabled) noexcept {
    callback_state_->limiter_enabled.store(enabled, std::memory_order_release);
}

void AudioEngine::set_master_gain_db(float db) {
    const float clamped = std::clamp(db, -120.0f, 12.0f);
    const float lin = (clamped <= -120.0f) ? 0.0f
                                            : std::pow(10.0f, clamped / 20.0f);
    master_gain_linear_.store(lin, std::memory_order_release);
}

float AudioEngine::master_gain_db() const noexcept {
    const float lin = master_gain_linear_.load(std::memory_order_acquire);
    if (lin <= 0.0f) return -120.0f;
    return 20.0f * std::log10(lin);
}

void AudioEngine::set_output_channel_gain_db(MasterChannelIndex ch, float db) {
    // Pre-limiter output trim. Allows substantial boost (up to +40 dB) so the
    // operator can drive quiet material hard; the master limiter (when enabled)
    // still catches the resulting peaks.
    const float clamped = std::clamp(db, -120.0f, 40.0f);
    const float lin = (clamped <= -120.0f) ? 0.0f
                                           : std::pow(10.0f, clamped / 20.0f);
    if (ch < cfg_.master_channels) {
        output_channel_gains_[ch].store(lin, std::memory_order_release);
    }
}

float AudioEngine::output_channel_gain_db(MasterChannelIndex ch) const noexcept {
    if (ch >= cfg_.master_channels) return 0.0f;
    const float lin = output_channel_gains_[ch].load(std::memory_order_acquire);
    if (lin <= 0.0f) return -120.0f;
    return 20.0f * std::log10(lin);
}

void AudioEngine::set_meter_ballistics(const MeterBallistics& b) {
    std::lock_guard lock{mutex_};
    meter_ballistics_ = b;
    for (auto& state : master_state_) state.meter->configure(cfg_.mix_sample_rate, b);
    for (auto& device : devices_)
        for (auto& state : device->outputs)
            state.meter->configure(cfg_.mix_sample_rate, b);
    for (auto& [_, m] : mixers_) m->configure_meters(b);
    for (auto& [_, item] : items_) item->set_meter_ballistics(b);
}

void AudioEngine::set_true_peak_metering(bool enabled) {
    std::lock_guard lock{mutex_};
    meter_true_peak_ = enabled;
    for (auto& state : master_state_) state.meter->set_true_peak_enabled(enabled);
    for (auto& device : devices_)
        for (auto& state : device->outputs)
            state.meter->set_true_peak_enabled(enabled);
    for (auto& [_, m] : mixers_) m->set_true_peak_enabled(enabled);
    for (auto& [_, item] : items_) item->set_true_peak_metering(enabled);
}

void AudioEngine::set_loudness_metering(bool enabled) {
    std::lock_guard lock{mutex_};
    meter_loudness_ = enabled;
    for (auto& state : master_state_) state.meter->set_loudness_enabled(enabled);
    for (auto& device : devices_)
        for (auto& state : device->outputs)
            state.meter->set_loudness_enabled(enabled);
    for (auto& [_, m] : mixers_) m->set_loudness_enabled(enabled);
    for (auto& [_, item] : items_) item->set_loudness_metering(enabled);
}

MeterSnapshot AudioEngine::read_master_meter(MasterChannelIndex master) const {
    std::lock_guard lock{mutex_};
    if (master >= master_state_.size()) return {};
    const auto& state = master_state_[master];
    if (const auto* output = output_state_locked(master)) {
        auto snapshot = output->meter->snapshot();
        if (state.output_max_source == output) {
            snapshot.peak_max_db = std::max(snapshot.peak_max_db,
                                            state.output_peak_max_db);
            snapshot.true_peak_max_db = std::max(snapshot.true_peak_max_db,
                                                 state.output_true_peak_max_db);
        }
        return snapshot;
    }
    return state.meter->snapshot();
}

MeterSnapshot AudioEngine::read_master_meter_consume(MasterChannelIndex master) {
    std::lock_guard lock{mutex_};
    if (master >= master_state_.size()) return {};
    if (const auto* output = output_state_locked(master)) {
        auto snapshot = output->meter->snapshot_consume_max();
        // One physical meter can feed several logical output strips. Preserve
        // its consumed maxima for every alias until that strip reads them.
        for (MasterChannelIndex i = 0; i < master_state_.size(); ++i) {
            if (output_state_locked(i) != output) continue;
            auto& state = master_state_[i];
            if (state.output_max_source != output) {
                state.output_max_source = output;
                state.output_peak_max_db = -120.0f;
                state.output_true_peak_max_db = -120.0f;
            }
            state.output_peak_max_db = std::max(state.output_peak_max_db,
                                                snapshot.peak_max_db);
            state.output_true_peak_max_db = std::max(state.output_true_peak_max_db,
                                                     snapshot.true_peak_max_db);
        }
        auto& state = master_state_[master];
        snapshot.peak_max_db = state.output_peak_max_db;
        snapshot.true_peak_max_db = state.output_true_peak_max_db;
        state.output_peak_max_db = -120.0f;
        state.output_true_peak_max_db = -120.0f;
        return snapshot;
    }
    return master_state_[master].meter->snapshot_consume_max();
}

float AudioEngine::read_master_gain_reduction_db(MasterChannelIndex master) const {
    std::lock_guard lock{mutex_};
    // No gain reduction is happening while the limiter is bypassed.
    if (!callback_state_->limiter_enabled.load(std::memory_order_acquire)) return 0.0f;
    if (const auto* output = output_state_locked(master))
        return output->limiter->gain_reduction_db();
    return 0.0f;
}

void AudioEngine::recover_device(const std::shared_ptr<Device>& owned, std::uint64_t generation) noexcept {
    auto& device = *owned;
    const auto state = device.callback_state;
    const auto current = [&] {
        return state->active.load(std::memory_order_acquire) &&
            !device.closing.load(std::memory_order_acquire) &&
            state->run_generation.load(std::memory_order_acquire) == generation;
    };
    std::lock_guard native_lock{device.native_mutex};
    std::uint64_t request_id;
    {
        std::lock_guard state_lock{device.state_mutex};
        request_id = device.recovery_request.request_id();
        device.runtime_state.store(device.closing.load() ? DeviceRuntimeState::Closing :
            DeviceRuntimeState::Starting, std::memory_order_release);
        device.started.store(false, std::memory_order_release);
        device.clock_master.store(false, std::memory_order_release);
        device.reset_requested.store(true, std::memory_order_release);
    }
    state->consumption_counter.fetch_add(1, std::memory_order_release);
    state->consumption_counter.notify_all();
    bool started = false;
    if (current() && device.ma_dev && device.ring) {
        while (device.render_active.load(std::memory_order_seq_cst)) std::this_thread::yield();
        ma_device_stop(device.ma_dev.get());
        while (device.callback_active.load(std::memory_order_seq_cst)) std::this_thread::yield();
        if (current()) {
            ma_pcm_rb_reset(device.ring.get());
            for (auto& state : device.outputs) state.limiter->reset();
            bool reset_ok = true;
            if (device.clock_resampler_initialized && device.clock_resampler) {
                reset_ok =
                    ma_resampler_reset(device.clock_resampler.get()) == MA_SUCCESS &&
                    ma_resampler_set_rate(
                        device.clock_resampler.get(), 1'000'000, 1'000'000) ==
                        MA_SUCCESS;
            }
            device.clock_controller.reset();
            device.correction_was_limited = false;
            device.applied_rate_ppm.store(0, std::memory_order_relaxed);
            device.clock_correction_ppm.store(0.0f, std::memory_order_relaxed);
            device.ring_occupancy_frames.store(0, std::memory_order_relaxed);
            device.reset_applied = true;
            device.native_recovery_pending.store(false, std::memory_order_release);
            if (reset_ok && current()) started = ma_device_start(device.ma_dev.get()) == MA_SUCCESS;
            if (started && !current()) {
                ma_device_stop(device.ma_dev.get());
                started = false;
            }
        }
    }
    const bool native_started = started;
    {
        std::lock_guard state_lock{device.state_mutex};
        started = started && current();
        device.started_recovery_request_id = started ? request_id : 0;
        if (started) {
            device.callback_liveness.arm(device.callback_entries.value(), CallbackLivenessMonitor::Clock::now());
            device.observed_liveness_epoch = device.liveness_epoch.load(std::memory_order_acquire);
            device.started.store(true, std::memory_order_release);
        } else {
            device.runtime_state.store(device.closing.load() ? DeviceRuntimeState::Closing :
                DeviceRuntimeState::Disconnected, std::memory_order_release);
            (void)device.recovery_request.fail(request_id);
        }
    }
    if (native_started && !current()) ma_device_stop(device.ma_dev.get());
    device.recovery_in_progress.store(false, std::memory_order_seq_cst);
    state->consumption_counter.fetch_add(1, std::memory_order_release);
    state->consumption_counter.notify_all();
}

void AudioEngine::device_watchdog_loop() {
    constexpr auto kWatchdogPeriod = std::chrono::milliseconds{10};

    while (running_.load(std::memory_order_acquire)) {
        {
            std::unique_lock wait_lock{device_watchdog_wait_mutex_};
            callback_state_->watchdog_cv.wait_for(wait_lock, kWatchdogPeriod);
        }
        if (!running_.load(std::memory_order_acquire)) break;

        {
            std::lock_guard lock{mutex_};
            reclaim_snapshots_locked();
        }
        bool wake_render = false;
        const auto devices = snapshot_devices();
        if (!devices) continue;

        for (const auto& device : *devices) {
            std::lock_guard state_lock{device->state_mutex};
            if (!device->closing.load(std::memory_order_acquire) &&
                !device->recovery_in_progress.load(std::memory_order_acquire) &&
                device->recovery_requested.exchange(false, std::memory_order_acq_rel)) {
                device->recovery_in_progress.store(true, std::memory_order_seq_cst);
                const auto generation = callback_state_->run_generation.load(std::memory_order_acquire);
                try { std::thread([device, generation] { recover_device(device, generation); }).detach(); }
                catch (const std::system_error& error) {
                    device->recovery_in_progress.store(false, std::memory_order_seq_cst);
                    (void)device->recovery_request.fail(device->recovery_request.request_id());
                    Logger::error("Device recovery worker failed: {}", error.what());
                }
            }
        }

        const auto now = CallbackLivenessMonitor::Clock::now();
        for (const auto& device : *devices) {
            std::lock_guard state_lock{device->state_mutex};
            if (device->closing.load(std::memory_order_acquire) ||
                device->recovery_in_progress.load(std::memory_order_acquire)) {
                continue;
            }

            auto runtime_state =
                device->runtime_state.load(std::memory_order_acquire);
            const auto epoch =
                device->liveness_epoch.load(std::memory_order_acquire);
            if (epoch != device->observed_liveness_epoch) {
                device->callback_liveness.arm(
                    device->callback_entries.value(), now);
                device->observed_liveness_epoch = epoch;
                continue;
            }

            if (runtime_state != DeviceRuntimeState::Starting &&
                runtime_state != DeviceRuntimeState::Running &&
                runtime_state != DeviceRuntimeState::Stalled) {
                const auto recovery_request_id =
                    device->started_recovery_request_id;
                if (recovery_request_id != 0) {
                    device->started_recovery_request_id = 0;
                    (void)device->recovery_request.fail(
                        recovery_request_id);
                }
                continue;
            }

            const auto liveness = device->callback_liveness.tick(
                device->callback_entries.value(), now);
            if (liveness == CallbackLivenessState::Running &&
                runtime_state != DeviceRuntimeState::Running) {
                const auto previous = runtime_state;
                if (device->runtime_state.compare_exchange_strong(
                        runtime_state, DeviceRuntimeState::Running,
                        std::memory_order_acq_rel, std::memory_order_acquire)) {
                    const auto recovery_request_id =
                        device->started_recovery_request_id;
                    if (recovery_request_id != 0) {
                        device->stream_recovery_count.fetch_add(
                            1, std::memory_order_relaxed);
                        device->started_recovery_request_id = 0;
                        (void)device->recovery_request.succeed(
                            recovery_request_id);
                    }
                    const bool native_recovery =
                        device->native_recovery_pending.exchange(
                            false, std::memory_order_acq_rel);
                    if (previous == DeviceRuntimeState::Stalled ||
                        native_recovery) {
                        device->device_recovery_count.fetch_add(
                            1, std::memory_order_relaxed);
                    }
                    device->reset_requested.store(
                        true, std::memory_order_release);
                    wake_render = true;
                }
            } else if (liveness == CallbackLivenessState::Stalled &&
                       runtime_state != DeviceRuntimeState::Stalled) {
                if (device->runtime_state.compare_exchange_strong(
                        runtime_state, DeviceRuntimeState::Stalled,
                        std::memory_order_acq_rel, std::memory_order_acquire)) {
                    device->device_loss_count.fetch_add(
                        1, std::memory_order_relaxed);
                    device->reset_requested.store(
                        true, std::memory_order_release);
                    const auto recovery_request_id =
                        device->started_recovery_request_id;
                    if (recovery_request_id != 0) {
                        device->started_recovery_request_id = 0;
                        (void)device->recovery_request.fail(
                            recovery_request_id);
                    }
                    wake_render = true;
                }
            }
        }

        if (wake_render) {
            callback_state_->consumption_counter.fetch_add(1, std::memory_order_release);
            callback_state_->consumption_counter.notify_all();
        }
    }
}

bool AudioEngine::reset_device_if_requested(Device& device) noexcept {
    if (!device.reset_requested.load(std::memory_order_acquire) ||
        device.reset_applied) {
        return true;
    }

    // The callback never waits for a reset. Symmetrically, the render thread
    // does not touch ring/resampler state until it can claim this flag.
    if (device.callback_active.exchange(
            true, std::memory_order_acq_rel)) {
        return false;
    }
    AtomicActiveGuard reset_guard{device.callback_active};
    if (device.closing.load(std::memory_order_seq_cst) ||
        device.runtime_state.load(std::memory_order_acquire) !=
            DeviceRuntimeState::Running) {
        return false;
    }

    ma_pcm_rb_reset(device.ring.get());
    for (auto& state : device.outputs) state.limiter->reset();
    if (device.clock_resampler_initialized &&
        device.clock_resampler) {
        if (ma_resampler_reset(device.clock_resampler.get()) !=
                MA_SUCCESS ||
            ma_resampler_set_rate(
                device.clock_resampler.get(), 1'000'000,
                1'000'000) != MA_SUCCESS) {
            render_error_count_.fetch_add(
                1, std::memory_order_relaxed);
            return false;
        }
    }
    device.clock_controller.reset();
    device.correction_was_limited = false;
    device.applied_rate_ppm.store(0, std::memory_order_relaxed);
    device.clock_correction_ppm.store(0.0f, std::memory_order_relaxed);
    device.ring_occupancy_frames.store(0, std::memory_order_relaxed);
    device.reset_applied = true;
    return true;
}

// ---------------------------------------------------------------------------
// Render loop — device-callback-driven
// ---------------------------------------------------------------------------
// The render thread does NOT poll healthy devices. Instead it blocks on
// callback_state_->consumption_counter via std::atomic::wait() and is woken by device
// callbacks after they consume samples. One healthy clock-master device
// defines the show timeline. Secondary outputs continuously resample by a
// bounded amount to hold their own ring occupancy against that timeline.
//
// Invariants:
//   * The existing healthy master remains master until it closes/fails.
//   * A failed master cannot stall another healthy device; election happens
//     here without waiting for control-thread intervention.
//   * Production stops at the master's target occupancy, preserving one block
//     of ring headroom instead of filling the ring and adding latency.
//   * When no healthy device exists we use a coarse timer so stopped-device
//     state and later native recovery are still observed.
void AudioEngine::render_loop() {
#if defined(LIVEPLAY_HAVE_SSE_DENORMAL)
    // Flush-to-zero + denormals-are-zero for this thread. The limiter and meter
    // states decay exponentially toward zero during silence and can enter
    // denormal range, which incurs large per-sample CPU penalties on x86;
    // FTZ/DAZ makes those flush to zero with no audible consequence.
    _MM_SET_FLUSH_ZERO_MODE(_MM_FLUSH_ZERO_ON);
    _MM_SET_DENORMALS_ZERO_MODE(_MM_DENORMALS_ZERO_ON);
#endif
    const auto block_duration =
        std::chrono::nanoseconds{static_cast<long long>(cfg_.render_block) * 1'000'000'000LL /
                                 static_cast<long long>(cfg_.mix_sample_rate)};

    while (running_.load(std::memory_order_acquire)) {
        try {
            auto snap = snapshot_topology();
            if (!snap) {
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
                continue;
            }

            const auto device_snap = snapshot_devices();
            std::shared_ptr<Device> clock_master;

            if (device_snap) {
                // Notifications are the fast path. This state poll covers
                // backends that only expose an unexpected stop through the
                // native device state.
                for (const auto& dev : *device_snap) {
                    if (!dev->ma_dev ||
                        dev->recovery_in_progress.load(std::memory_order_seq_cst)) {
                        continue;
                    }
                    dev->render_active.store(
                        true, std::memory_order_seq_cst);
                    AtomicActiveGuard device_guard{dev->render_active};
                    if (dev->closing.load(std::memory_order_seq_cst) ||
                        dev->recovery_in_progress.load(std::memory_order_seq_cst)) {
                        continue;
                    }

                    const auto native_state =
                        ma_device_get_state(dev->ma_dev.get());
                    auto runtime_state =
                        dev->runtime_state.load(std::memory_order_acquire);
                    if (native_state == ma_device_state_started) {
                        if (runtime_state == DeviceRuntimeState::Disconnected) {
                            // Publish the new baseline generation before
                            // exposing Starting to the watchdog.
                            dev->liveness_epoch.fetch_add(
                                1, std::memory_order_release);
                            if (dev->runtime_state.compare_exchange_strong(
                                    runtime_state, DeviceRuntimeState::Starting,
                                    std::memory_order_release,
                                    std::memory_order_acquire)) {
                                dev->native_recovery_pending.store(
                                    true, std::memory_order_release);
                            }
                        }
                    } else if (
                        (runtime_state == DeviceRuntimeState::Starting ||
                         runtime_state == DeviceRuntimeState::Running ||
                         runtime_state == DeviceRuntimeState::Stalled) &&
                        dev->runtime_state.compare_exchange_strong(
                            runtime_state, DeviceRuntimeState::Disconnected,
                            std::memory_order_acq_rel,
                            std::memory_order_acquire)) {
                        if (runtime_state != DeviceRuntimeState::Stalled) {
                            dev->device_loss_count.fetch_add(
                                1, std::memory_order_relaxed);
                        }
                        dev->reset_requested.store(
                            true, std::memory_order_release);
                    }
                }

                // Preserve the current healthy master. A reconnected former
                // master stays secondary until the active master goes away.
                for (const auto& dev : *device_snap) {
                    const bool healthy =
                        dev->ring &&
                        !dev->closing.load(std::memory_order_acquire) &&
                        dev->runtime_state.load(
                            std::memory_order_acquire) ==
                            DeviceRuntimeState::Running;
                    if (healthy &&
                        dev->clock_master.load(std::memory_order_acquire)) {
                        clock_master = dev;
                        break;
                    }
                }
                if (!clock_master) {
                    for (const auto& dev : *device_snap) {
                        if (dev->ring &&
                            !dev->closing.load(std::memory_order_acquire) &&
                            dev->runtime_state.load(
                                std::memory_order_acquire) ==
                                DeviceRuntimeState::Running) {
                            clock_master = dev;
                            break;
                        }
                    }
                }

                for (const auto& dev : *device_snap) {
                    const bool should_be_master =
                        clock_master && dev.get() == clock_master.get();
                    const bool was_master = dev->clock_master.exchange(
                        should_be_master, std::memory_order_acq_rel);
                    if (was_master && !should_be_master) {
                        // Demotion activates the clock adapter, so reset its
                        // phase before the device resumes as a secondary.
                        if (!dev->reset_requested.exchange(
                                true, std::memory_order_acq_rel) &&
                            dev->runtime_state.load(
                                std::memory_order_acquire) ==
                                DeviceRuntimeState::Running) {
                            dev->hard_resync_count.fetch_add(
                                1, std::memory_order_relaxed);
                        }
                    }
                }
            }

            if (!clock_master) {
                std::this_thread::sleep_for(block_duration);
                continue;
            }

            bool can_render = false;
            bool master_ready = true;
            std::uint32_t before = 0;
            clock_master->render_active.store(
                true, std::memory_order_seq_cst);
            {
                AtomicActiveGuard device_guard{
                    clock_master->render_active};
                if (clock_master->closing.load(
                        std::memory_order_seq_cst) ||
                    clock_master->runtime_state.load(
                        std::memory_order_acquire) !=
                        DeviceRuntimeState::Running) {
                    continue;
                }

                master_ready =
                    reset_device_if_requested(*clock_master);
                if (master_ready) {
                    // Master latency is independent of secondary clock headroom.
                    const auto target = cfg_.render_block * 3;
                    can_render =
                        ma_pcm_rb_available_read(
                            clock_master->ring.get()) +
                            cfg_.render_block <=
                        target;
                    if (!can_render) {
                        // Capture the sequence before re-checking occupancy.
                        // If a callback consumes between the re-check and
                        // wait(), its sequence change returns immediately.
                        before = callback_state_->consumption_counter.load(
                            std::memory_order_acquire);
                        can_render =
                            ma_pcm_rb_available_read(
                                clock_master->ring.get()) +
                                cfg_.render_block <=
                            target;
                    }
                }
            }
            if (!master_ready) {
                std::this_thread::yield();
                continue;
            }
            if (!can_render) {
                callback_state_->consumption_counter.wait(before, std::memory_order_acquire);
                continue;
            }

            render_one_block(*snap);
        } catch (const std::bad_alloc&) {
            // Memory pressure: skip this block and give the system a moment.
            // Audio will glitch but the server survives.
            render_error_count_.fetch_add(1, std::memory_order_relaxed);
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        } catch (const std::exception&) {
            render_error_count_.fetch_add(1, std::memory_order_relaxed);
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        } catch (...) {
            render_error_count_.fetch_add(1, std::memory_order_relaxed);
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }
}

void AudioEngine::decode_loop(const std::shared_ptr<DecodeState>& state) {
    while (!state->shutdown.load(std::memory_order_acquire)) {
        if (!state->active.load(std::memory_order_acquire)) {
            std::unique_lock wait_lock{state->wait_mutex};
            state->wake.wait(wait_lock, [&] {
                return state->active.load(std::memory_order_acquire) ||
                    state->shutdown.load(std::memory_order_acquire);
            });
            continue;
        }
        const auto cues = state->cues.load();
        if (cues) {
            for (const auto& weak : *cues) {
                if (!state->active.load(std::memory_order_acquire) ||
                    state->shutdown.load(std::memory_order_acquire)) break;
                const auto item = weak.lock();
                if (!item) continue;
                const auto transport = item->stats().transport;
                if (transport == TransportState::Stopped ||
                    transport == TransportState::Paused) {
                    continue;
                }
                try {
                    std::lock_guard lock{state->wait_mutex};
                    if (!state->active.load(std::memory_order_acquire) ||
                        state->shutdown.load(std::memory_order_acquire)) break;
                    if (!state->workers.insert(item.get()).second) continue;
                    std::thread([state, item] {
                        while (state->active.load(std::memory_order_acquire) &&
                               !state->shutdown.load(std::memory_order_acquire)) {
                            const auto transport = item->stats().transport;
                            if (transport == TransportState::Stopped || transport == TransportState::Paused) break;
                            if (!item->service_read_ahead(1, /*wait_for_decoder=*/false)) {
                                std::unique_lock wait_lock{state->wait_mutex};
                                state->wake.wait_for(wait_lock, std::chrono::milliseconds{2}, [&] {
                                    return !state->active.load(std::memory_order_acquire) ||
                                        state->shutdown.load(std::memory_order_acquire);
                                });
                            }
                        }
                        {
                            std::unique_lock lock{state->wait_mutex};
                            if (!item->decoder_ready_.load(std::memory_order_acquire)) {
                                lock.unlock(); item->unload(); lock.lock();
                            }
                            state->workers.erase(item.get());
                        }
                        state->wake.notify_all();
                    }).detach();
                } catch (...) {
                    { std::lock_guard lock{state->wait_mutex}; state->workers.erase(item.get()); }
                    item->begin_render_exclusion();
                    item->stop_for_decode_error(MA_UNAVAILABLE);
                    item->end_render_exclusion();
                }
            }
        }

        std::unique_lock wait_lock{state->wait_mutex};
        state->wake.wait_for(wait_lock, std::chrono::milliseconds{2}, [&] {
            return !state->active.load(std::memory_order_acquire) ||
                state->shutdown.load(std::memory_order_acquire);
        });
    }
}

void AudioEngine::render_one_block(const Topology& topo) {
    const std::size_t block = static_cast<std::size_t>(cfg_.render_block);

    // Every container below was sized with the immutable topology on the
    // control thread. The render deadline only clears and reuses storage.
    for (auto& buffer : topo.mixer_accumulators) {
        std::fill_n(buffer.data(), block, 0.0f);
    }
    for (auto& buffer : topo.master_accumulators) {
        std::fill_n(buffer.data(), block, 0.0f);
    }

    // Split every item at the same follow boundary. Rendering just a target
    // early/late in this list must not change its first audible sample.
    for (std::size_t offset = 0;;) {
        std::size_t count = block - offset;
        for (const auto& follow : topo.follows) {
            if (follow->status.load(std::memory_order_acquire) !=
                PreparedFollow::State::Armed) continue;
            if (follow->source->playback_revision() != follow->source_revision ||
                !follow->target->prepared_start_ready(follow->target_revision)) {
                follow->status.store(PreparedFollow::State::Cancelled,
                                      std::memory_order_release);
                continue;
            }
            const auto stats = follow->source->stats();
            if (stats.transport == TransportState::Paused) continue;
            if (stats.playhead_frame >= follow->end_frame) {
                auto expected = PreparedFollow::State::Armed;
                if (!follow->status.compare_exchange_strong(
                        expected, PreparedFollow::State::Firing,
                        std::memory_order_acq_rel)) continue;
                const bool fired =
                    follow->source->finish_follow_rt(follow->source_revision) &&
                    follow->target->start_prepared_rt(follow->target_revision);
                // A busy render gate must not force a valid handoff through EOF polling.
                const bool retry = !fired && !follow->source->had_decode_error() &&
                    follow->source->playback_revision() == follow->source_revision &&
                    follow->target->prepared_start_ready(follow->target_revision);
                follow->status.store(fired ? PreparedFollow::State::Fired
                    : retry ? PreparedFollow::State::Armed : PreparedFollow::State::Cancelled,
                                      std::memory_order_release);
            } else if (stats.transport == TransportState::Stopped) {
                follow->status.store(PreparedFollow::State::Cancelled,
                                      std::memory_order_release);
            } else {
                count = std::min<std::size_t>(
                    count, follow->end_frame - stats.playhead_frame);
            }
        }
        if (offset == block) break;
        for (const auto& entry : topo.items) {
            const ChannelCount n_src = std::min<ChannelCount>(
                entry.item->source_channel_count(),
                static_cast<ChannelCount>(entry.channel_ptrs.size()));
            entry.item->render_block(entry.channel_ptrs.data(), n_src, count);

            for (ChannelCount c = 0; c < n_src && c < entry.per_source_channel.size(); ++c) {
                for (const auto& send : entry.per_source_channel[c].sends) {
                    Sample* acc =
                        topo.mixer_accumulators[
                            send.mixer_index * kMixerLanes + send.lane].data();
                    const Sample* src = entry.channel_buffers[c].data();
                    for (std::size_t s = 0; s < count; ++s)
                        acc[offset + s] += src[s] * send.gain;
                }
            }
        }
        offset += count;
    }

    // ---- Tier-2 strip processing (gain/mute/solo/fade) + meter ----
    bool any_soloed = false;
    for (const auto& m : topo.mixers) {
        if (m->is_soloed()) { any_soloed = true; break; }
    }

    for (std::size_t i = 0; i < topo.mixers.size(); ++i) {
        const auto& m = topo.mixers[i];
        // Advance the strip's fade envelope by exactly one render block, then
        // read the resulting gain. peek_gain_linear() is side-effect-free, so
        // the read may be repeated (metering, gain application) without the
        // fade running at a multiple of its configured speed.
        m->advance_block();
        const float gain_lin = m->peek_gain_linear();
        const bool  audible  = !m->is_muted() && (!any_soloed || m->is_soloed());
        const float effective = audible ? gain_lin : 0.0f;
        for (ChannelIndex lane = 0; lane < kMixerLanes; ++lane) {
            Sample* buf =
                topo.mixer_accumulators[i * kMixerLanes + lane].data();
            for (std::size_t s = 0; s < block; ++s) buf[s] *= effective;
            m->update_meter(lane, buf, block);
        }
    }

    // ---- Tier-2 → Tier-3 mix into master accumulators ----
    for (MasterChannelIndex mc = 0; mc < cfg_.master_channels; ++mc) {
        Sample* acc = topo.master_accumulators[mc].data();
        for (const auto& send : topo.masters[mc].sends) {
            const Sample* src =
                topo.mixer_accumulators[
                    send.mixer_index * kMixerLanes + send.lane].data();
            for (std::size_t s = 0; s < block; ++s) acc[s] += src[s] * send.gain;
        }
    }

    // ---- Tier-3: master gain → per-channel output gain → logical meter ----
    const float mg = master_gain_linear_.load(std::memory_order_acquire);
    for (MasterChannelIndex mc = 0; mc < cfg_.master_channels; ++mc) {
        Sample* buf = topo.master_accumulators[mc].data();
        // Global master gain
        if (mg != 1.0f) {
            for (std::size_t s = 0; s < block; ++s) buf[s] *= mg;
        }
        // Per-output-channel gain (independent fader per device output pair)
        const float og =
            output_channel_gains_[mc].load(std::memory_order_acquire);
        if (og != 1.0f) {
            for (std::size_t s = 0; s < block; ++s) buf[s] *= og;
        }
        master_state_[mc].meter->push_block(buf, block);
    }

    // ---- Dispatch to devices ----
    // For each device, build an interleaved block of its hardware channels by
    // picking the right master accumulator for each.
    const auto devices = snapshot_devices();
    if (!devices) return;
    for (const auto& dev : *devices) {
        if (!dev->ring ||
            dev->closing.load(std::memory_order_acquire) ||
            dev->runtime_state.load(std::memory_order_acquire) !=
                DeviceRuntimeState::Running) {
            continue;
        }
        dev->render_active.store(true, std::memory_order_seq_cst);
        AtomicActiveGuard active_guard{dev->render_active};
        if (dev->closing.load(std::memory_order_seq_cst) ||
            dev->runtime_state.load(std::memory_order_acquire) !=
                DeviceRuntimeState::Running) {
            continue;
        }

        if (!reset_device_if_requested(*dev)) continue;

        if (dev->scratch.size() < block * dev->channels) {
            render_error_count_.fetch_add(1, std::memory_order_relaxed);
            continue;
        }
        std::fill_n(dev->scratch.data(), block * dev->channels, 0.0f);

        // Walk master assignments and copy contributions into the right hw ch.
        for (MasterChannelIndex mc = 0; mc < cfg_.master_channels; ++mc) {
            const auto& dest = topo.masters[mc].destination;
            if (!dest || dest->device != dev->id) continue;
            if (dest->hw_channel >= dev->channels) continue;
            const Sample* src = topo.master_accumulators[mc].data();
            Sample*       dst = dev->scratch.data();
            for (std::size_t s = 0; s < block; ++s) {
                dst[s * dev->channels + dest->hw_channel] += src[s];
            }
        }

        // Push into the device's ring buffer.
        ma_uint32 remaining = static_cast<ma_uint32>(block);
        const Sample* src   = dev->scratch.data();
        while (remaining > 0) {
            ma_uint32 frames_to_write = remaining;
            void*     buf = nullptr;
            if (ma_pcm_rb_acquire_write(
                    dev->ring.get(), &frames_to_write, &buf) != MA_SUCCESS) {
                break;
            }
            if (frames_to_write == 0) {
                break;
            }
            std::memcpy(buf, src,
                        frames_to_write * dev->channels * sizeof(Sample));
            ma_pcm_rb_commit_write(dev->ring.get(), frames_to_write);
            src       += frames_to_write * dev->channels;
            remaining -= frames_to_write;
        }

        const auto occupancy =
            ma_pcm_rb_available_read(dev->ring.get());
        dev->ring_occupancy_frames.store(
            occupancy, std::memory_order_relaxed);
        if (remaining > 0) {
            dev->overrun_count.fetch_add(
                1, std::memory_order_relaxed);
            dev->reset_applied = false;
            if (!dev->reset_requested.exchange(
                    true, std::memory_order_acq_rel)) {
                dev->hard_resync_count.fetch_add(
                    1, std::memory_order_relaxed);
            }
            continue;
        }

        if (dev->reset_applied &&
            occupancy >= cfg_.render_block * 3) {
            dev->reset_applied = false;
            dev->reset_requested.store(
                false, std::memory_order_release);
        }
    }
}

} // namespace liveplay::audio
