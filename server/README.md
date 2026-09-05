# DonWells Cue Server — developer guide

`dwcue-server` is the headless C++20 audio engine and control surface that backs the DonWells Cue client. It owns the audio graph, the routing matrix, the loaded project file, and exposes a REST + WebSocket API. It runs as either a child process spawned by the desktop client (single-machine installs) or as a standalone daemon on a stage-side machine that the client connects to over the LAN.

This document tracks the current v2.6.13 source and is the developer's guide to the server; use the release page to determine which behaviour is present in a downloaded installer. For show preparation and operation, see the [operator manual (PDF)](../docs/operators-manual.pdf) or [Markdown source](../docs/operators-manual.md). For client internals, see [`client/README.md`](../client/README.md); for overall project and release context, see the [root README](../README.md).

---

## Contents

- [Tech stack](#tech-stack)
- [Source layout](#source-layout)
- [Building](#building)
- [Running](#running)
- [Architecture](#architecture)
  - [Three-tier mixer](#three-tier-mixer)
  - [Multi-device routing matrix](#multi-device-routing-matrix)
  - [True-peak master limiter](#true-peak-master-limiter)
  - [Per-cue LTC generator](#per-cue-ltc-generator)
  - [Real-time metering](#real-time-metering)
  - [Manual-stop fade-out contract](#manual-stop-fade-out-contract)
- [Control surface](#control-surface)
  - [REST endpoints](#rest-endpoints)
  - [WebSocket](#websocket)
- [Project state & file format](#project-state--file-format)
- [Threading model](#threading-model)
- [Adding features](#adding-features)
- [Debugging](#debugging)

---

## Tech stack

| Layer        | Library                                                                        |
|--------------|--------------------------------------------------------------------------------|
| Audio I/O    | [miniaudio](https://miniaud.io/) (header-only, vendored as `miniaudio_impl.c`) |
| HTTP / WS    | [Crow](https://crowcpp.org/)                                                   |
| Metadata     | [TagLib](https://taglib.org/)                                                  |
| JSON         | [nlohmann/json](https://github.com/nlohmann/json)                              |
| Build        | CMake (≥ 3.21) + vcpkg manifest mode (`vcpkg.json`)                            |

Native backends per platform:

| OS      | Backends (compiled in; runtime-selected)              |
|---------|-------------------------------------------------------|
| Windows | WASAPI (default), DirectSound, WinMM                  |
| macOS   | CoreAudio (frameworks: CoreAudio, AudioToolbox, AudioUnit, CoreFoundation) |
| Linux   | ALSA + PulseAudio (JACK optional, all compiled in)    |

ASIO is intentionally *not* enabled — the Steinberg SDK has redistribution terms incompatible with AGPL bundling. Build miniaudio with `MA_ENABLE_ASIO` locally if you need it.

---

## Source layout

```
server/
├── CMakeLists.txt
├── CMakePresets.json          presets: vs2022, default (Ninja), debug, macos, linux
├── vcpkg.json                 manifest — Crow, TagLib, nlohmann/json
├── include/liveplay/
│   ├── audio/
│   │   ├── types.hpp          shared audio types (DeviceId, ChannelIndex, …)
│   │   ├── meter.hpp          VU + RMS ballistics + atomic publishers
│   │   ├── limiter.hpp        lookahead true-peak limiter
│   │   ├── true_peak_detector.hpp  BS.1770 4× detector
│   │   ├── ltc_generator.hpp  procedural SMPTE LTC (24/25/29.97/30, DF + NDF)
│   │   ├── mixer_channel.hpp  Tier 2: virtual mixer strip
│   │   ├── playback_item.hpp  Tier 1: per-cue decoder + fade state
│   │   └── engine.hpp         Tier 3: master bus + device fan-out
│   ├── core/
│   │   ├── project_state.hpp  v2 project model + legacy 1.x upgrade
│   │   └── backup_manager.hpp on-save rotating backups
│   ├── meta/
│   │   ├── metadata.hpp       TagLib wrapper
│   │   └── waveform.hpp       offline downsample → peak JSON
│   ├── net/
│   │   ├── control_server.hpp Crow REST + WS surface
│   │   └── discovery.hpp      LAN announce / discovery (UDP)
│   ├── util/unicode_path.hpp  Windows-safe wide path helpers
│   ├── logger.hpp             ANSI-colour level logger
│   └── crash_handler.hpp      cross-platform signal/SEH crash dumps
└── src/                       implementations — same layout as headers
    ├── main.cpp               CLI parsing, banner, signal handling
    └── audio/miniaudio_impl.c the single TU that compiles miniaudio
```

---

## Building

### Prerequisites

- CMake ≥ 3.21
- A C++20 toolchain (MSVC 2022, Clang 15+, GCC 12+)
- vcpkg checkout with `VCPKG_ROOT` exported
- Ninja (recommended)
- **Linux extras**: `libasound2-dev libpulse-dev libjack-jackd2-dev libx11-dev pkg-config ninja-build`

### From the server directory

```sh
cd server
cmake --preset default                # Ninja Release; fetches vcpkg deps (~5 min first time)
cmake --build build --config Release -j
```

The binary lands at `build/dwcue-server` (or `build/Release/dwcue-server.exe` on Windows with the `vs2022` preset).

Useful presets:

| Preset   | Notes                                                                |
|----------|----------------------------------------------------------------------|
| `default`| Ninja Release. Cross-platform.                                       |
| `debug`  | Ninja Debug with assertions + symbols. Build dir: `build-debug`.     |
| `vs2022` | Multi-config Visual Studio generator. Build dir: `build`. Windows.   |
| `macos`  | Sets `CMAKE_OSX_DEPLOYMENT_TARGET` for the host arch.                |
| `linux`  | Forces Ninja + pkg-config.                                           |

### From the monorepo root

```sh
npm run server:build             # host-aware configure + build
npm run server:run -- --verbose  # launch with debug logs
npm run server:configure         # Windows-only explicit vs2022 configure
```

`npm run server:build` shells out to [`scripts/build-server.js`](../scripts/build-server.js), which always configures idempotently with the host preset before building. The separate `server:configure` script is fixed to the Windows `vs2022` preset and is normally unnecessary.

---

## Running

```
dwcue-server [options]
  -p, --port <port>         Port to listen on (default 4480)
  -b, --bind <addr>         Interface to bind (default 127.0.0.1)
      --pidfile <path>      Write private JSON process identity after binding
      --instance-token <32 hex chars>  Launcher process identity
      --start-delay-ms <n>  Wait <n> ms before binding (used by crash-restart)
  -v, --verbose             Enable debug-level logging
  -h, --help                Show this help and exit

Environment:
  LIVEPLAY_PORT             Same as --port
  LIVEPLAY_ACCESS_TOKEN     Control bearer token (unset/empty generates; otherwise minimum 16 characters)
  LIVEPLAY_ALLOWED_ORIGINS  Exact browser origins, comma-separated
  NO_COLOR=1                Disable ANSI colour in logs
  FORCE_COLOR=1             Force colour even when stdout isn't a tty
```

When `--pidfile` is supplied, its owner-private JSON contains `pid`, `port`, `startedAt`, `instanceToken`, and `accessToken`. Treat it as a credential file: do not log, copy, or relax its permissions.

The default control surface binds to `127.0.0.1:4480`, but loopback is not a trust boundary: every local and remote control route requires the bearer token. `GET /api/health` is the sole public application route. Passing a non-loopback `--bind` also starts the [discovery beacon](include/liveplay/net/discovery.hpp) on **UDP 4481**.

A standalone process uses `LIVEPLAY_ACCESS_TOKEN` when it contains at least 16 characters. If the value is unset or empty, it generates a 128-bit token (32 lowercase hex characters) and prints it once before file logging starts; a non-empty value shorter than 16 characters refuses startup. Crash-restart preserves the same token. Electron-managed launches instead supply a fresh 64-character lowercase-hex token for each backend generation.

REST clients send `Authorization: Bearer <token>`. Browser WebSockets may connect to `/ws?access_token=<token>`, and HTML media requests may use the same query parameter on `/api/media`; no other route accepts the control bearer in the query string. Discovery advertises connection details only, never the token, open project, or show state.

Open TCP 4480 and UDP 4481 through a firewall only when intentionally operating a
remote server. DonWells Cue never creates firewall rules automatically.

If the server crashes, its crash handler spawns a fresh copy of itself with the same
flags plus `--start-delay-ms` (so the old listening socket drains before the new
instance binds) and leaves a `.crash-resume.json` behind. The restarted instance reads
that file, reloads the open project and resumes playback from where it left off — so a
crash doesn't take the show down. The desktop client tracks the live server via the
`--pidfile` it passes on launch.

In LAN mode, the boot banner shows the reachable URL:

```
  Listening
    REST       http://0.0.0.0:4480
    WebSocket  ws://0.0.0.0:4480/ws
    LAN reach  http://192.168.1.42:4480
```

`Ctrl+C` (SIGINT / Ctrl-Break / WM_CLOSE on Windows) triggers a clean shutdown — devices closed, threads joined, project flushed if dirty.

---

## Architecture

### Three-tier mixer

Every cue's audio goes through three explicit tiers, in order, on the engine's render thread:

```
   Tier 1                Tier 2                  Tier 3
   ──────                ──────                  ──────
 PlaybackItem  ─send─►  MixerChannel  ─send─►  Master Output Bus  ─hw─►  Device:HwCh
   (one per                (group bus,            (per-channel
   live cue,               gain/mute/             true-peak
   own decoder)            solo/fade)             limiter)
```

- **Tier 1 — [`PlaybackItem`](include/liveplay/audio/playback_item.hpp)**: one instance per active cue, with its own `ma_decoder`, gain/fade state machine, optional LTC generator, and a per-source-channel meter. Loading the same `.wav` into two One Shot cells yields **two independent instances**; attenuating one never affects the other.
- **Tier 2 — [`MixerChannel`](include/liveplay/audio/mixer_channel.hpp)**: a virtual strip with gain, mute, solo, and a smooth-fade ramp. Many items can route into one channel; one item's source channels can fan out to multiple channels.
- **Tier 3 — Master output bus** ([`engine.hpp`](include/liveplay/audio/engine.hpp)): the current executable exposes 32 logical master channels. Each carries a limiter + meter and is assigned to exactly one `(Device, HardwareChannelIndex)` tuple.

All three tiers run at a 256-frame block (~5.3 ms at 48 kHz). Meters and limiter envelopes update once per block.

Control-plane registries and immutable topology snapshots share ownership of playback items, mixer channels, and output devices, so removing an object cannot destroy storage still visible to the render thread. Native devices are deduplicated and reference-counted: Main and Preview can share one physical device, and releasing Preview cannot close Main's device. Device initialisation and shutdown are serialized; retired device storage stays off the real-time destruction path until engine shutdown.

### Multi-device routing matrix

DonWells Cue drives **multiple sound cards simultaneously** with full source-channel splitting. The matrix is sparse, JSON-serialisable, and round-trips through `/api/project`. The three stages:

| Stage              | Mapping                                       | Persisted as         |
|--------------------|-----------------------------------------------|----------------------|
| Item → Mixer       | per-source-channel sends with linear gain     | `item_routes`        |
| Mixer → Master     | per-master-channel sends with linear gain     | `mixer_routes`       |
| Master → Device    | exactly one `(device_id, hw_channel)` per master | `master_assignments` |

Example: a stereo MP3 (`L`, `R`) playing on a 4-channel cue can simultaneously feed FOH (Device A: ch 0+1) and a stage monitor mix (Device B: ch 2+3) **with different gains** by wiring `L → MixerA → Master0 → DevA:0` plus `L → MixerB → Master2 → DevB:2` and similarly for `R`.

Mutators: `POST /api/routing/item_to_mixer`, `/mixer_to_master`, `/master_to_device`.

### True-peak master limiter

[`limiter.hpp`](include/liveplay/audio/limiter.hpp). Defaults: −0.1 dBTP ceiling for the Live output target, 5 ms lookahead (~240 samples at 48 kHz), 50 ms release. `settings.limiterCeilingDb` optionally overrides the selected target in the range −60..0 dBTP. The limiter reuses the meter's ITU-R BS.1770 4× intersample detector; its sliding maximum drives the lookahead gain envelope with a 0.25 dB internal guard against envelope-created peaks. Bypass keeps both detector and delay moving so live toggles do not shift timing.

### Per-cue LTC generator

[`ltc_generator.hpp`](include/liveplay/audio/ltc_generator.hpp). When enabled on a cue, the engine appends a synthetic **extra source channel** after the file's real channels. That synthetic channel can be routed anywhere through the matrix — to a FOH output, a dedicated 3.5 mm jack, or an entirely different device.

Supported frame rates: 24, 25, 29.97 NDF, 29.97 DF, 30. Drop-frame handling is in `LTCGenerator::timecode_for_frame`. Offset is any non-negative `chrono::nanoseconds`, so a cue can emit `01:00:00:00` at its first sample and stay sync-locked thereafter.

### Real-time metering

Every tier has its own [`Meter`](include/liveplay/audio/meter.hpp) — VU-style attack/release peak envelope plus a leaky-integrator RMS over ~300 ms. The audio thread pushes blocks via `push_block()`; the meter publishes lock-free atomics. A dedicated broadcast thread snapshots all meters at the configured cadence (30 Hz by default) and fans them out to every WebSocket client. See [WebSocket](#websocket) below.

### Manual-stop fade-out contract

All three stop paths funnel through the same fade-out envelope:

- `PlaybackItem::stop()` — user pressed Stop, or master Stop-All; honours `fade_out_duration`.
- `PlaybackItem::stop_now()` — emergency panic, no fade.
- Natural end-of-file inside `render_block()` — honours `fade_out_duration`.

`stop()` calls `start_fade()` which feeds the same state machine the natural-end branch uses. The contract is documented inline in [`src/audio/playback_item.cpp`](src/audio/playback_item.cpp) (search for `// Manual-stop fade contract:`).

### Sequencer trigger invariants

- **Cue to Continue** arms a one-pass, runtime-only continuation for the cue's current playback instance. It temporarily supersedes saved Loop, Start Next, crossfade/stop-fade, and end-behaviour advance; at natural end it starts the resolved target. Stop, remove, replay, Stop All, media replacement, or project switch cancels the arm, so replay falls back to the saved behaviour. `cue_to_continue` is never serialized.
- A manual **Play Next** override is consumed only when GO successfully starts its target. Failed or not-yet-loaded targets remain armed for retry. For a group, play-first succeeds only when its selected child starts; play-all succeeds when at least one child starts. One Shot arming follows the same accepted-play rule.
- Repeated identical arming is coalesced without another state broadcast. Successful GO clears its override; failed GO leaves it intact.
- Each play receives a server-side generation fence. Replay, stop, removal, media replacement, and project changes invalidate older generations so a copied terminal action from an earlier playback instance cannot advance or otherwise affect the new one.
- Group Start Behavior is implemented for **Play First** and **Play All**, but the server does not currently consume a group's End Behavior. `Play Next` resolves only the next sibling in the current immediate container; the final child needs an explicit **Go to Item** or **Go to Index** target to leave the group.
- The audio-cue Start Behavior values rendered by the current Properties UI (`play-next`, `play-item`, `play-index`) are not interpreted by `ProjectState::play_item`, which only recognizes the legacy `stop` and `play` actions. Do not build show logic on those controls. Natural-end **End Behavior** and timed **Start Next at Marker** / **Start Next At** / **Fade Out at Marker** remain the working sequencing paths.

---

## Control surface

`ControlServer` (in [`net/control_server.cpp`](src/net/control_server.cpp)) hosts a token-authenticated Crow app on the configured port. Browser CORS is an exact allowlist, not a LAN- or loopback-wide exception.

The authoritative endpoint list is the table of `CROW_ROUTE` registrations in [`src/net/control_server.cpp`](src/net/control_server.cpp). What follows is the same surface with request/response schemas.

### Conventions

- Every JSON response carries `Content-Type: application/json`. `GET /api/health` is public; every other local or remote application route requires the control bearer.
- REST authentication uses `Authorization: Bearer <token>`. Access-token query parameters are accepted only by `/ws` and `/api/media`; the unrelated one-shot export `downloadToken` does not replace control authentication.
- Browser `Origin` values must exactly match `LIVEPLAY_ALLOWED_ORIGINS`; source development uses `http://localhost:3000`, not arbitrary loopback spellings. Native clients without an Origin are allowed, as is packaged Electron's opaque `Origin: null`, but both still authenticate.
- Every error follows `{ "error": "<message>" }` with an appropriate 4xx/5xx status code. `400` covers malformed bodies; `401` covers missing/invalid authentication; `404` covers unknown ids/paths; `413` covers oversize uploads; `500` covers internal failures.
- Allowed-origin `OPTIONS` requests return `204` with matching CORS preflight headers. All IDs are opaque strings unless typed otherwise; `<int>` path parameters are 32-bit signed.
- `cue_id` (engine-level) ≠ `item_uuid` (project-document level). The server maintains the mapping in `ProjectState`; most transport endpoints accept either.

### REST endpoints

#### Diagnostics

| Method · Path      | Body | Response | Notes |
|--------------------|------|----------|-------|
| `GET /api/health`  | —    | `{ "ok": true, "name": "dwcue-server", "pid": number, "instanceToken": string }` | Sole unauthenticated route; liveness and launcher-generation identity probe. `instanceToken` is not the control bearer. |
| `GET /api/whoami`  | —    | `{ "clientIp": "192.168.1.10", "isLocal": false }` | Bearer required; `isLocal` reports whether the caller is loopback, not whether authentication is required. |

#### Devices

| Method · Path | Body | Response |
|---------------|------|----------|
| `GET /api/devices` | — | `[ { "id": "…", "display_name": "…", "channel_count": 8, "sample_rate": 48000, "is_default": true } ]` |
| `POST /api/devices/open` | `{ "name": "…" (optional), "channels": 2 }` — empty `name` opens the default device | `{ "device_id": "…" }` · `400` if open fails |
| `POST /api/devices/close` | `{ "id": "…" }` | `{ "ok": true }` |

#### Cues (engine-direct)

This is the low-level cue surface — for normal use, prefer the project-item surface (`/api/project/items/...`), which honours `duckingBehavior`, `inPoint`, `endBehavior`, etc.

| Method · Path | Body | Response |
|---------------|------|----------|
| `GET /api/cues` | — | array of cue objects (see below) |
| `POST /api/cues` | `{ "file_path": "/abs/path.wav", "display_name": "…" (optional) }` | cue object · `400` on load failure |
| `GET /api/cues/<id>` | — | cue object · `404` if unknown |
| `DELETE /api/cues/<id>` | — | `{ "ok": true }` |
| `POST /api/cues/<id>/play` | — | `{ "ok": true }` |
| `POST /api/cues/<id>/stop` | — | `{ "ok": true }` |
| `POST /api/cues/<id>/gain` | `{ "db": 0.0 }` | `{ "ok": true }` |
| `POST /api/cues/<id>/fade` | `{ "in_ms": 0, "out_ms": 0 }` | `{ "ok": true }` |
| `POST /api/cues/<id>/ltc`  | `{ "enabled": bool, "fps": 0..4, "start_timecode": "HH:MM:SS:FF" (preferred) or "offset_ns": int64 }` | `{ "ok": true }` |

`fps` indices: `0=24`, `1=25`, `2=29.97 NDF`, `3=29.97 DF`, `4=30`. `start_timecode` accepts `;` between SS and FF for drop-frame.

**Cue object shape** (returned by `GET /api/cues`, `GET /api/cues/<id>`):

```json
{
  "id": "…",
  "display_name": "…",
  "file_path": "/abs/path.wav",
  "artist": "…",
  "title": "…",
  "duration_sec": 123.4,
  "gain_db": 0.0,
  "fade_in_ms": 0,
  "fade_out_ms": 500,
  "ltc": { "enabled": false, "fps": 0, "offset_ns": 0, "start_timecode": "00:00:00:00" },
  "transport": 0,            // present iff engine has a PlaybackItem: 0=Stopped, 1=Playing, 2=FadingOut, 3=Paused
  "playhead_seconds": 0.0,
  "source_channels": 2,
  "file_loaded": true
}
```

#### Transport & master

| Method · Path | Body | Response |
|---------------|------|----------|
| `POST /api/transport/stop_all` | `{ "fade_ms": 0 }` (optional; empty body permitted) | `{ "ok": true }` |
| `POST /api/master/ceiling` | `{ "db": -0.1 }` (dBTP) | `{ "ok": true, "db": -0.1 }` · updates and broadcasts the open project's override |
| `GET /api/master/gain` | — | `{ "db": float }` |
| `POST /api/master/gain` | `{ "db": float }` | `{ "ok": true, "db": float }` · also broadcasts `master_gain_changed` |
| `GET /api/master/channels/<int>/gain` | — | `{ "channel": int, "db": float }` |
| `POST /api/master/channels/<int>/gain` | `{ "db": float }` | `{ "ok": true, "channel": int, "db": float }` · also broadcasts `output_channel_gain_changed` |

#### Mixers

| Method · Path | Body | Response |
|---------------|------|----------|
| `GET /api/mixers` | — | `[ { "id": "…", "display_name": "…", "gain_db": 0.0, "muted": false, "soloed": false } ]` |
| `POST /api/mixers` | `{ "name": "Channel" }` | `{ "id": "…" }` |
| `DELETE /api/mixers/<id>` | — | `{ "ok": true }` |

#### Routing matrix

| Method · Path | Body |
|---------------|------|
| `POST /api/routing/item_to_mixer`    | `{ "cue": "<cue_id>", "source_channel": int, "mixer": "<mixer_id>", "gain_db": float }` |
| `POST /api/routing/mixer_to_master`  | `{ "mixer": "<mixer_id>", "master_channel": int, "gain_db": float }` |
| `POST /api/routing/master_to_device` | `{ "master_channel": int, "device": "<device_id>", "hw_channel": int }` |

All three respond `{ "ok": true }`. The master→device mapping is **one-to-one**: assigning a master channel implicitly unassigns its previous device/hw_channel.

#### Filesystem (server-side browser)

| Method · Path | Body / Query | Response |
|---------------|--------------|----------|
| `GET /api/fs/list?path=<utf8>&filter=audio\|all\|.ext,.ext` | empty `path` = "computer root" (drives on Windows, `/` on POSIX); `filter` defaults to `audio` | see below |
| `POST /api/fs/mkdir` | `{ "path": "/abs/path" }` | `{ "path": "/abs/path" }` |

`/api/fs/list` response:

```json
{
  "path":    "/abs/path",
  "parent":  "/abs",
  "is_root": false,
  "entries": [
    { "name": "song.wav",  "full_path": "/abs/path/song.wav", "kind": "file", "size": 1234567 },
    { "name": "subfolder", "full_path": "/abs/path/subfolder", "kind": "dir" },
    { "name": "C:",        "full_path": "C:\\",               "kind": "drive" }
  ]
}
```

Entries are sorted by the OS directory iterator. Hidden entries (leading `.`) are skipped. Symlink loops trip `weakly_canonical` and return `400`. File entries that fail the extension filter are omitted.

#### Uploads & media copy

| Method · Path | Body | Response |
|---------------|------|----------|
| `POST /api/upload` | `multipart/form-data` (one or more file parts); request size capped at `cfg.max_upload_bytes` (default 256 MiB) | `{ "saved": [ "/abs/path/in/media/file1", … ] }` · `413` if too large |
| `POST /api/copy_to_media` | `{ "source_path": "/abs/src.wav" }` | `{ "dest_path": "/abs/<project>/media/src.wav" }` |
| `GET /api/file/download?token=<downloadToken>` | (one-shot download token from `/api/project/export`, plus the normal bearer header) | `application/octet-stream` stream of the file; download token consumed on success; `404` if expired/invalid |

Uploads land in `state.media_root()` (the loaded project's `media/` sub-folder). Filenames are sanitised — directory components in the multipart `filename` are stripped.

#### Metadata & waveform

| Method · Path | Body / Query | Response |
|---------------|--------------|----------|
| `GET /api/metadata?path=<utf8>` | — | `{ valid, artist, title, album, genre, year, track_number, duration_ms, sample_rate, channels, bitrate_kbps }` |
| `GET /api/waveform/<cue_id>?buckets=1000` | — | waveform object (see below); `404` if cue not registered |
| `GET /api/waveform_path?path=<utf8>&buckets=1000` | — | waveform object (no `cue_id` field) |
| `POST /api/waveform_generate` | `{ "path": "/abs/file.wav", "item_uuid": "<uuid>" }` | `{ "ok": true }` immediately; result arrives as a `waveform_ready` (or `waveform_failed`) `doc_patch` over WebSocket |

**Waveform object**:

```json
{
  "cue_id": "…",          // only on /api/waveform/<id>; absent on /api/waveform_path
  "bucket_count": 1000,
  "duration_ms": 184500,
  "sample_rate": 48000,
  "source_channels": 2,
  "channels": [
    { "peak": [0.12, 0.14, …], "rms": [0.07, 0.08, …] },
    { "peak": [...],            "rms": [...] }
  ]
}
```

Each channel's `peak` and `rms` arrays have exactly `bucket_count` floats in `[0.0, 1.0]`.

#### Preview (DJ-style pre-listening)

Plays an item on `settings.previewDevice` without routing through the live mixer. Used by the WaveformTrimmer / cue editor.

| Method · Path | Body | Response | Side effect |
|---------------|------|----------|-------------|
| `GET /api/preview` | — | `{ "active": bool, "itemUuid": "…", "cueId": "…" }` | — |
| `POST /api/preview` | `{ "itemUuid": "<uuid>" }` | `{ "ok": true, "itemUuid": "…", "cueId": "…" }` · `400` if no preview device or item missing | broadcasts `preview_started` |
| `DELETE /api/preview` | — | `{ "ok": true }` | broadcasts `preview_stopped` |

#### Project document

| Method · Path | Body | Response | Notes |
|---------------|------|----------|-------|
| `GET /api/project`              | — | full project JSON document | The single GET a remote client needs to render the whole project. |
| `GET /api/project/header`       | — | lightweight header `{ name, itemCount, theme, settings, cart, hasOpenProject, … }` | Hit this first so the workspace shell can paint before the items array arrives. |
| `GET /api/project/items?offset=0&limit=100` | — | `{ "offset": int, "limit": int, "total": int, "items": [...] }` | `limit` clamps to [1,1000]. Top-level items only (groups carry their children inline). |
| `GET /api/project/progress`     | — | `{ "ready": bool, "loading": bool, "loaded": int, "total": int, "failedCount": int, "failures": [...] }` | Cheap poll for playback readiness and missing/unreadable media. |
| `POST /api/project/load`        | `{ "path": "/abs/file.dwcue" }` *or* `{ "document": { … } }` | header object, augmented with `needsRepair`/`repairIssues` if the document was auto-repaired on load | broadcasts `project_changed`. `400` if neither field is present or load fails. |
| `POST /api/project/close`       | — | `{ "closed": true }` | broadcasts `project_changed`; clients clear both their project document and remembered path |
| `PUT /api/project/document`     | full project JSON document | header object | Replaces the entire in-memory document. Broadcasts `project_changed`. |
| `POST /api/project/save`        | `{ "path": "/abs/file.dwcue" (optional) }` | `{ "ok": true, "path": "…" }` | Saves to the supplied canonical path or the currently-loaded one. `400` if neither is set. |
| `POST /api/project/repair`      | — | `{ "repaired": bool, "issues": [string], "saved": bool }` | Forces a re-save of the (already auto-repaired on load) in-memory document. |

#### Project items

Mutating routes return `{ ok: true, ... }` only — the full document is **not** echoed, to keep bandwidth low on large projects. Use the `doc_patch` WebSocket fan-out to keep the local mirror in sync.

| Method · Path | Body | Response | Broadcast op |
|---------------|------|----------|--------------|
| `POST /api/project/items`              | `{ "item": { uuid, displayName, type, … }, "parentUuid": "" (root) or "<group-uuid>" }` | `{ "ok": true, "uuid": "…", "cueId": "…" }` | `item_added` |
| `PATCH /api/project/items/<uuid>`      | partial item JSON (sparse update) | `{ "ok": true, "uuid": "…" }` · `404` if missing | `item_updated` |
| `DELETE /api/project/items/<uuid>`     | — | `{ "ok": true, "uuid": "…" }` · `404` if missing | `item_removed` |
| `POST /api/project/items/reorder`      | `{ "parentUuid": "" or "<group>", "uuids": [string, …] }` | `{ "ok": true }` | `items_reordered` |
| `POST /api/project/items/<uuid>/play` | — | `{ "ok": true }` · `404` if not loaded | — (transport edge fires `cue_state` instead) |
| `POST /api/project/items/by-index/<path>` | — | `{ "ok": true, "uuid": "…", "index": [int, …] }` · `400` invalid path · `404` no item / not loaded | — (transport edge fires `cue_state` instead) |
| `POST /api/project/items/<uuid>/stop`  | — | `{ "ok": true }` · `404` if not loaded | — |
| `POST /api/project/items/<uuid>/seek`  | `{ "seconds": float }` | `{ "ok": true }` · `404` if not loaded | — |

**Triggering by index** — `…/by-index/<path>` triggers an item by its position instead of its uuid. The `<path>` is an **index path**: a zero-based list of child indices that descends into groups at each level, mirroring the client's `findItemByIndex` / `endBehavior.targetIndex`. A single number (`5`) targets the 6th top-level item; multiple components descend into groups — `1,11` means top-level item `1` (the 2nd item, a group) then its child `11` (the 12th item inside it). Both **comma- and slash-separated** forms are accepted and equivalent, so the same target can be written `…/by-index/1,11` or `…/by-index/1/11` (mixed forms like `1,2/0` work too). Send a `POST`; the route uses `trigger_item`, so audio items play and group items dispatch per their `startBehavior`. It returns `400` for a malformed path and `404` when no item exists at that index or the resolved item isn't loaded into the engine.

Project UI settings such as `settings.indexDisplayStart` only change the numbers shown and entered in the client. REST by-index paths stay zero-based for backwards compatibility.

#### One Shot cells (legacy cart API)

The current UI calls these quick-play cells **One Shots**. The HTTP paths and broadcast
event names retain `cart` for compatibility with saved projects and external clients.

| Method · Path | Body | Response | Broadcast op |
|---------------|------|----------|--------------|
| `POST /api/project/cart`         | `{ "slot": int, "itemUuid": "<uuid>" }` | `{ "ok": true, "slot": int, "itemUuid": "…" }` | `cart_slot_set` |
| `DELETE /api/project/cart/<int>` | — | `{ "ok": true, "slot": int }` | `cart_slot_cleared` |

#### Theme & settings

| Method · Path | Body | Response | Broadcast op |
|---------------|------|----------|--------------|
| `PATCH /api/project/theme`    | partial `theme` object | the resulting `theme` object | `theme_patched` |
| `PATCH /api/project/settings` | partial `settings` object | the resulting `settings` object | `settings_patched` |

#### Project export / import (`.dwcuepack` archives)

A `.dwcuepack` is a raw ZIP of the active `.dwcue` project's folder; it does not add a second manifest or wrapper schema.

| Method · Path | Body | Response |
|---------------|------|----------|
| `POST /api/project/export` | `{ "folderPath": "/abs/project", "outputPath": "/abs/out.dwcuepack" (optional), "projectName": "MyShow" (optional) }` | `{ "archivePath": "/abs/out.dwcuepack", "size": uint64, "downloadToken": "…" (only when outputPath omitted), "downloadFilename": "MyShow.dwcuepack" (only when outputPath omitted) }` |
| `POST /api/project/import` | **multipart** with a `file` part (the `.dwcuepack` or `.lpa`) and an `extractPath` text field, *or* **JSON** `{ "archivePath": "/abs/src.dwcuepack", "extractPath": "/abs/dest" }` | `{ "extractPath": "…", "projectFiles": ["one.dwcue"] }` |
| `POST /api/project/import-legacy` | `{ "path": "/abs/old.liveplay", "destinationPath": "/abs/new.dwcue" (optional) }` | project header, as returned by `POST /api/project/load` |

If `outputPath` is omitted on export, the archive is staged privately in the server's temporary export area and surfaced through a one-shot 10-minute `downloadToken` that's redeemed via `GET /api/file/download`. The temp file is deleted after the download completes.

Archive import infers native versus legacy handling from the supplied filename: `.dwcuepack` imports its canonical `.dwcue`, while `.lpa` converts its legacy `.liveplay` document and returns a `projectFiles` array containing the one canonical `.dwcue` result. Extraction uses a fresh destination directory and rejects absolute paths, `..` traversal, links and special entries, unsafe expansion, and collisions. Legacy conversion never changes the original archive and does not publish the staged `.liveplay` file.

---

### WebSocket

Single endpoint at `ws://<host>:<port>/ws`. Frames are UTF-8 JSON objects with a `type` discriminator. Binary frames are silently dropped.

On connect, the server adds the connection to the broadcast set and queues a one-shot `playback_snapshot` frame for it (delivered on the next default ~33 ms broadcast tick — sending it inline races the broadcast thread on the same connection and was a historical crash source).

#### Server → client frames

| `type`                | Cadence            | Payload |
|-----------------------|--------------------|---------|
| `meters`              | ~30 Hz (default)   | per-cue / per-mixer / per-master meters (see below) |
| `cue_state`           | On transport edge  | `{ "type": "cue_state", "cue_id": "…", "transport": 0\|1\|2\|3, "playhead_seconds": float, "item_uuid": "…" (when known) }` |
| `playback_snapshot`   | On WS connect      | `{ "type": "playback_snapshot", "cues": [{cue_id,transport,playhead_seconds,item_uuid?}], "next_item_uuid": "…", "master_gain_db": float, "output_channel_gains": [{channel,db}], "preview": {item_uuid, cue_id} }` — lets a freshly-reconnected client mirror state without waiting for the next transport edge. |
| `doc_patch`           | On every server-side document mutation | `{ "type": "doc_patch", "op": "<op-name>", …op-specific fields }` — see the `op` table below |
| `pong`                | On `ping`          | `{ "type": "pong" }` |
| `error`               | On malformed frame | `{ "type": "error", "message": "…" }` |

**`meters` frame**:

```json
{
  "type": "meters",
  "items": [
    {
      "cue_id":           "…",
      "transport":        1,
      "playhead_seconds": 12.43,
      "sources": [
        { "peak_db": -3.1, "rms_db": -9.2 },
        { "peak_db": -4.2, "rms_db": -9.5 }
      ]
    }
  ],
  "mixer_channels": [
    { "mixer_id": "…", "peak_db": -6.0, "rms_db": -12.0 }
  ],
  "master_channels": [
    { "index": 0, "peak_db": -0.3, "rms_db": -8.1, "gain_reduction_db": -1.4 }
  ]
}
```

Stopped cues are omitted from `items`. Silent master channels (`peak_db <= -119 dB` and gain reduction `> -0.05 dB`) are omitted from `master_channels` to keep the frame small.

**Transport state values**: `0=Stopped`, `1=Playing`, `2=FadingOut`, `3=Paused`.

**`doc_patch` op vocabulary** — `op` plus the additional fields it carries:

| `op`                            | Additional fields                                          | Emitted by |
|---------------------------------|------------------------------------------------------------|------------|
| `project_changed`               | (none — clients refetch)                                   | `POST /api/project/{load,close}`, `PUT /api/project/document` |
| `item_added`                    | `uuid`, `parentUuid`, `item`, `cueId`                      | `POST /api/project/items` |
| `item_updated`                  | `uuid`, `patch`                                            | `PATCH /api/project/items/<uuid>` |
| `item_removed`                  | `uuid`                                                     | `DELETE /api/project/items/<uuid>` |
| `items_reordered`               | `parentUuid`, `uuids` (array)                              | `POST /api/project/items/reorder` |
| `cart_slot_set`                 | `slot`, `itemUuid`                                         | `POST /api/project/cart` |
| `cart_slot_cleared`             | `slot`                                                     | `DELETE /api/project/cart/<slot>` |
| `theme_patched`                 | `theme` (full resulting theme object)                      | `PATCH /api/project/theme` |
| `settings_patched`              | `settings` (full resulting settings object)                | `PATCH /api/project/settings` |
| `master_gain_changed`           | `db`                                                       | `POST /api/master/gain` |
| `output_channel_gain_changed`   | `channel`, `db`                                            | `POST /api/master/channels/<n>/gain` |
| `preview_started`               | `itemUuid`, `cueId`                                        | `POST /api/preview` |
| `preview_stopped`               | (none)                                                     | `DELETE /api/preview` |
| `next_item_set`                 | `itemUuid` (empty string clears)                           | WS `set_next_item` |
| `waveform_ready`                | `item_uuid`, `bucket_count`, `duration_ms`, `sample_rate`, `source_channels`, `channels` | waveform worker, after `/api/waveform_generate` finishes |
| `waveform_failed`               | `item_uuid`                                                | waveform worker on decode failure |
| `custom_action_http`            | `action` (project-defined HTTP action descriptor)          | `ProjectState` external-action handler — server has no HTTP client, so clients perform the fetch |

Clients apply doc_patch ops as idempotent state updates; the originating client also receives the echo (its local state already matches, so the apply is a no-op).

#### Client → server frames

Mostly mirror the REST surface so transport commands can skip the HTTP request/response overhead. The handler is in `handle_ws_message` ([`src/net/control_server.cpp`](src/net/control_server.cpp)). Most transport frames accept **either** `item_uuid` (preferred — honours `duckingBehavior` / `inPoint` / fades / sequencer auto-advance) **or** `cue_id` (raw engine target).

| `type`           | Payload | Effect |
|------------------|---------|--------|
| `play`           | `{ "item_uuid": "…" }` or `{ "cue_id": "…" }` | Starts playback. For groups (when `item_uuid` is a group), walks `startBehavior`. |
| `stop`           | same shape as `play` | Stops with the cue's `fade_out_duration`. |
| `pause`          | same shape as `play` | Holds the playhead; cue stays loaded. No-op on Stopped cues. |
| `resume`         | same shape as `play` | Resumes from the paused playhead. |
| `seek`           | `{ "item_uuid"\|"cue_id": "…", "seconds": float }` | Sets the playhead. |
| `gain`           | `{ "item_uuid"\|"cue_id": "…", "db": float }` | Sets the per-cue gain. |
| `fade`           | `{ "item_uuid"\|"cue_id": "…", "in_ms": int, "out_ms": int }` | Sets fade durations. |
| `stop_all`       | `{ "fade_ms": 0 }` | Stops every active cue. |
| `set_next_item`  | `{ "item_uuid": "…" }` (empty/missing clears) | Sets the user-overridden **Play Next** target. Echoed to all clients as `next_item_set`. |
| `ping`           | `{}` | Server replies with `{ "type": "pong" }`. |

Unknown `type` values get a `{ "type": "error", "message": "unknown type" }` reply.

### Network event lifecycle (cue trigger)

```
1. User triggers One Shot #3.
2. OneShotTile.vue → useLiveplayServer().play(cueId)
3. WebSocket frame { "type": "play", "cue_id": "…" } sent to server.
4. ControlServer::handle_ws_message → engine_.play(cueId) — O(1) atomic state flip.
5. AudioEngine render thread, next block:
     PlaybackItem.render_block() decodes + applies fade-in envelope.
     Mixer summing through the matrix.
     Master limiter + meter on per-device output buffers.
     Buffers pushed into each device's miniaudio ring buffer.
6. Per-device miniaudio callback drains the ring → hardware DAC.
7. Render thread also pushes amplitude into the 3-tier meters.
8. Broadcast thread, ~33 ms later at the default cadence: snapshot all meters → JSON → fan out to every WS client.
9. Client's LiveMeterBar.vue reflects the new levels in the next frame paint.
```

End-to-end transport latency depends on the configured render-block size and the target device's buffering; validate those settings on the deployment hardware.

---

## Project state & file format

`ProjectState` ([`core/project_state.hpp`](include/liveplay/core/project_state.hpp)) owns the canonical, in-memory project document. It's stored as a single nlohmann/json tree; mutations are dispatched through narrow helpers that also emit `doc_patch` broadcasts so clients stay in sync.

### File format

A native `.dwcue` project is a JSON document beside its `media/` sub-folder. All new project creation and normal saves use `.dwcue`. A legacy `.liveplay` document is import-only: `POST /api/project/import-legacy` preserves its bytes and loads a new canonical `.dwcue`. With no `destinationPath`, the server chooses an available `.dwcue` sibling; an explicit destination must be an absent `.dwcue` filename in the same parent directory.

The document schema is **v2**. Legacy 1.x content is auto-upgraded when loaded, including during one-way legacy import, by `ProjectState::upgrade_legacy_document` ([`src/core/project_state.cpp`](src/core/project_state.cpp)):

- Walks legacy `carts` / `playlist` arrays and reconstructs the v2 `cues` list with the same names, file paths, gains, and fade durations.
- Synthesises stereo master assignments: master channel 0 → default device hw ch 0, master channel 1 → default device hw ch 1.
- Auto-creates one per-cue mixer channel so each cue still has independent gain/fade.

The upgrade reconstructs legacy cues and baseline routes so old projects remain importable without making their source files writable aliases. Verify a converted show before live use. The server exposes the full routing API, but the current client does not mount `RoutingMatrixPanel.vue` as an operator screen; the available UI is Settings → **Audio Routing** for devices and Properties → **Output device** / **LTC** for a cue.

### Backups

`BackupManager` ([`core/backup_manager.hpp`](include/liveplay/core/backup_manager.hpp)) keeps rotating timestamped copies of the project file on every save, so a corrupt write or bad mutation can be recovered.

### Repair

`POST /api/project/repair` walks the document and attempts to fix structural issues (orphaned references, missing routes, dangling cue → file links). It's surfaced in the UI through `ProjectRepairModal.vue`.

---

## Threading model

The server uses several long-lived service threads plus backend-owned audio callbacks and temporary parallel workers during bulk project loads; the count is not fixed.

| Thread / worker           | Owns |
|---------------------------|------|
| Crow I/O + workers        | REST/WS handlers and connection lifecycle. |
| Engine render             | `AudioEngine::render_loop()`; refills per-device rings from immutable topology snapshots. No locks, allocations, exceptions, or syscalls in the render path. |
| Native device callbacks   | One real-time callback per open native device; drains its ring and wakes the render thread after consumption. |
| Engine decode             | Bounded read-ahead for loaded playback items, outside the render thread. |
| Sequencer                 | End behaviours, timed actions, ducking transitions, and playback-generation terminal actions. |
| Project loaders           | One persistent single-item/media-swap loader; bulk project loads may temporarily fan out to parallel workers. |
| Meter/event broadcast     | Snapshots meters and transport edges at the default ~30 Hz cadence and fans JSON out to WebSocket clients. |
| Waveform worker           | Drains the async `/api/waveform_generate` queue. |
| Backup worker             | Rotating project backups. |
| Discovery                 | UDP announcements when LAN mode is active. |

Inter-thread communication is lock-free atomics or immutable shared snapshots on the audio path; elsewhere, a `std::mutex` guarding the relevant section is fine. **Do not call any potentially blocking API from the engine render thread or native device callbacks.**

---

## Adding features

### A new REST endpoint

1. Register the route in `install_routes()` inside [`src/net/control_server.cpp`](src/net/control_server.cpp).
2. Validate inputs via nlohmann/json — return `crow::status::BAD_REQUEST` on malformed bodies.
3. If the handler mutates `ProjectState`, build a JSON Patch and call `broadcast_doc_patch()` so connected clients stay in sync.
4. Add the matching call on the client in `client/app/composables/useLiveplayServer.ts`.

### A new audio feature

1. Decide which tier owns it: per-cue (`PlaybackItem`), per-mixer-channel (`MixerChannel`), or master (`AudioEngine`).
2. Hot params (anything the audio thread reads) must be `std::atomic<…>`. Don't add new locks to the render path.
3. If it has visible state (peak, gain reduction, frame index), publish it through a `Meter`-style atomic so the broadcast thread can read it without sync.
4. Unit-testing audio code is awkward — write a small driver that calls `engine.render_block()` directly with synthetic inputs and asserts on the output buffer.

### A new persisted field

1. Add it to the relevant struct in `core/project_state.hpp` (or one of the audio tier classes for non-persistent state).
2. Update the `to_json`/`from_json` adaptors so it round-trips.
3. If old projects need a sensible default, add a fallback in `upgrade_legacy_document`.

---

## Debugging

- `--verbose` enables `DBUG`-level logs. The logger ([`logger.hpp`](include/liveplay/logger.hpp)) is ANSI-coloured by default; set `NO_COLOR=1` for log aggregators.
- The `debug` CMake preset enables assertions + symbols and builds into `build-debug/`.
- `crash_handler.cpp` installs a cross-platform signal/SEH handler that dumps a backtrace on fatal errors. Useful when bug reports come in from operators in the field.
- Smoke-test the binary in CI by running `dwcue-server --help` (`build-server.yml` does exactly this).
- For audio-thread bugs, prefer adding atomic counters / ring-buffer logs rather than `printf` from inside `render_block()`.

For deeper context on the client side of the protocol, see [`client/README.md`](../client/README.md).
