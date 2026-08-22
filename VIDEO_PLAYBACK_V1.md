# DonWells Cue — Video Playback v1 Spec

> **Audience:** fresh agent / developer with zero prior context. Read
> `IMPROVEMENTS_PLAN.md` §1 first for the general architecture.
> **Branch:** `feature/video-playback` (worktree `../dwvideo`).
> **Status:** design locked with product owner; foundations verified (see §2); implementation not started.

---

## 1. Goal

Let a single operator run **small live events** (corporate workshops, conferences) from one laptop:

- **Audio** plays through the existing engine → audio interface / headphone out → DI → PA.
- **Video** plays through a dedicated, always-on **Video Output window**, fullscreen on the
  laptop's HDMI output → video switcher → projector. The switcher (not the app) handles
  transitions between the app and other sources.
- When an audio-only cue plays, the output shows a **per-cue image**, falling back to a
  **global standby image**, falling back to **black**.

Target platforms: Windows and macOS laptops. Same-machine only (client and bundled server on
the show laptop). v1 is **one video at a time, cuts only**.

## 2. Verified foundations (why this design is safe)

| Assumption | Evidence |
|---|---|
| The engine can play a video file's audio track as a normal cue | `server/src/audio/decoder.cpp` registers an FFmpeg decoding backend (`open_ffmpeg`, `av_find_best_stream(..., AVMEDIA_TYPE_AUDIO, ...)`). Empirically verified with the built `decoder-check` binary: H.264+AAC MP4 ✓, HEVC+AAC MP4 ✓ (open, non-silent render @48 kHz, seek). |
| A video with **no audio stream** cannot be decoded by the engine | Same test: video-only MP4 → `open failed` (`av_find_best_stream` finds no audio). Drives the silent-transport requirement (§5.3). |
| Playhead position already streams to clients | `control_server.cpp` `meters` broadcast (~60 Hz, absolute-deadline schedule) carries per-item `playhead_seconds` + transport enum; `cue_state` edge events fire on transport transitions; `playback_snapshot` is sent on (re)connect. No server protocol additions needed for sync. |
| Multiple clients per server | By design (doc-patch fan-out); the Video Output window is just another WS client. |
| Detached-window pattern exists | `client/electron/main.js` `cartPlayerWindow` loads the same Nuxt app with `?cartWindow=1`. The output window mirrors this with `?videoOutput=1`. |
| No display management exists yet | No Electron `screen` / `powerSaveBlocker` usage anywhere in `main.js` — greenfield, no conflicts. |
| Item model is extensible | `client/app/types/project.ts` `BaseItem.type: 'audio' \| 'group' \| 'action'` ("Extensible for future item types"); `ProjectSettings` exists for global settings. |

## 3. Architecture

```
┌──────────────────────────── show laptop (same machine) ───────────────────────────┐
│                                                                                   │
│  Control window (existing)     dwcue-server (C++ engine)      Video Output window │
│  cue list, Show Mode,          audio track of video file ──▶  fullscreen on HDMI  │
│  properties                    via existing FFmpeg backend    muted <video>       │
│        │                       fades · limiter · meters       image / standby /   │
│        │  fire cue (REST/WS)   routing → interface → PA       black / test card   │
│        └──────────────────────▶        │                             ▲          │
│                                        │ meters WS (~60 Hz):          │          │
│                                        │ playhead_seconds, transport  │          │
│                                        └──────────────────────────────┘          │
│                                        cue_state edges, playback_snapshot        │
└──────────────────────────────────────────────────────────────────────────────────┘
        │ line out / USB interface                          │ HDMI
        ▼                                                   ▼
      PA / DI                                          switcher → projector
```

The engine remains the **single clock master**. The output window never makes transport
decisions; it chases the engine's playhead (§6). No HDMI audio — the `<video>` element is
always muted; the switcher receives picture only.

## 4. Locked scope decisions (from owner)

1. **Same-machine only.** Network/remote-server UI is *hidden* (not deleted) behind a
   settings toggle, defaulting to hidden. The capability stays for a future v2 remote
   video renderer.
2. **Cuts only.** No fade-to-black, no crossfades (the downstream switcher owns transitions).
   **Audio fades still apply** — they are engine-side and free.
3. **Codecs:** H.264 / HEVC in MP4/MOV, decoded by Chromium in the output window. No ProRes,
   no alpha. Docs guidance: "MP4/H.264 recommended; HEVC best-effort" (Windows HEVC support
   is hardware/OS-dependent; macOS fine).
4. **Video audio always through the engine** — same program output as audio cues. Never HDMI.
5. **Images:** per-cue image on audio cues AND one global standby image. Layer priority:
   `black < global standby < per-cue image < video`.

## 5. Data & server changes (kept minimal)

### 5.1 No new item type

A video cue is an `AudioItem` whose media file is a video container. All cue behaviour
(in/out points, fades, ducking, normalization, end behaviours, Start Next, One Shots)
applies unchanged. Video-ness is **derived**, not declared:

- **Client-side:** file extension (`.mp4`, `.mov`, `.m4v`, `.mkv`) for instant UI badge.
- **Server-side:** authoritative probe at item-add time — open with libavformat, report
  `has_video` / `has_audio` stream flags. Where: `server/src/meta/metadata.cpp`
  (`duration_via_miniaudio` path) extended to fill stream flags; surfaced in the item REST
  payload (`control_server.cpp` item responses) so the client knows whether to expect
  picture and whether the engine can produce sound.

### 5.2 New fields (all optional — additive, no schema break)

`client/app/types/project.ts` + server mirror in `server/src/core/project_state.cpp`:

- `AudioItem.imagePath?: string` — per-cue still (project-relative, like `mediaPath`).
- `ProjectSettings.videoStandbyImage?: string` — global standby image.
- `ProjectSettings.videoOutputEnabled?: boolean` — master arm for the output window.
- `ProjectSettings.videoOutputDisplayId?: string` — remembered display assignment
  (Electron display id is unstable across reconnects; persist screen resolution +
  connector label as a fallback fingerprint).
- App-level (not project) setting: `hideNetworkUi` (default **true** for v1), gating
  `ServerSettingsModal.vue` entry points.

### 5.3 Silent-video transport (the only engine work)

A video file without an audio stream cannot be decoded (verified §2), but the cue must
still play, advance, and report progress. Add a **duration-only playback mode**:

- When `decoder_init_file` fails with "no audio stream" *and* the container probe shows a
  video stream, register the cue with a synthetic silent PCM source of the probed duration
  (zeros at the mix sample rate). Implementation: small `ma_data_source` that generates
  silence with a declared length, reusing the `FfmpegDataSource` cursor/seek semantics.
- All lifecycle stays in the engine (progress, auto-advance, meters, `cue_state` edges);
  the client chases it identically for silent and audible videos. This same primitive later
  serves timed image cues.

### 5.4 Import paths

- `select-audio-files` dialog has no extension filters — already accepts video files;
  rename/labels only.
- Drag-and-drop import and the `media/` copy step must whitelist video extensions wherever
  audio extensions are currently enumerated (client import composables + any server
  `/api/upload` validation).

## 6. Sync design (client-side chase)

The Video Output window opens its **own WebSocket** to the local server (multi-client is
native) and consumes, via `useLiveplayServer.ts`'s existing subscriber pattern:

- `cue_state` edges → start/stop/pause/fade events for the active video cue.
- `meters` (~60 Hz) → `playhead_seconds` for chase correction.
- `playback_snapshot` → rebuild state on (re)connect / window reopen mid-show.
- Project document via REST + `doc_patch` → item fields (`mediaPath`, in/out points,
  `imagePath`) and settings.

Chase algorithm (in a new `useVideoOutput.ts` composable):

1. **Start:** on `cue_state → Playing/FadingIn` for a video item, load the file muted,
   `currentTime = inPoint + playhead_seconds`, `play()`.
2. **Steady state:** each meter tick, `err = enginePlayhead - videoTime` (both relative to
   in-point). `|err| > 80 ms` → hard seek. Otherwise `playbackRate = clamp(1 + err·k, 0.97, 1.03)`.
3. **Pause/resume:** mirror transport enum directly.
4. **End:** on out-point (`playhead_seconds ≥ outPoint`) or `Stopped`, cut to the layer
   below (§4.5). No tail — cuts only.
5. **Startup skew** (tens of ms while Chromium spins up decode) is absorbed by the same
   hard-seek threshold; audio fades land exactly because they live in the engine.

Tolerance target: ±2 frames at 30 fps. Corporate switcher downstream makes this
invisible. If the video file's frame rate/resolution is unsupported or decode fails,
fall back to the per-cue image / standby layer and surface a non-blocking warning in the
control window (never on the output).

## 7. Video Output window (Electron)

Mirrors the `cartPlayerWindow` pattern in `client/electron/main.js`:

- New `BrowserWindow`: `fullscreen: true`, `frame: false`, `alwaysOnTop` (level
  `screen-saver`), hidden cursor (CSS `cursor: none` on the page), black background,
  loads the Nuxt app with `?videoOutput=1` (dev: `loadURL('http://localhost:3000/?videoOutput=1')`,
  prod: `loadFile(indexPath, { query: { videoOutput: '1' } })`).
- **Display pinning** via Electron `screen` API: place on the persisted display
  (§5.2); if absent, stay hidden and warn in the control window.
- **Watchdog:** `screen.on('display-added'/'display-removed'/'display-metrics-changed')` →
  re-acquire the assigned display and re-fullscreen. Detect OS **display mirroring** and
  warn prominently (operator-facing, control window).
- **Show hygiene:** `powerSaveBlocker.start('prevent-display-sleep')` while the output is
  armed; block the window from showing on the primary display unless explicitly assigned.
- **Test card:** output name + native resolution + safe-frame guides + 1 kHz-free (silent),
  toggled from the control window's video settings (and output-window context menu in dev).
- Lifecycle: opened/armed from the control window; closing the main window closes it;
  `Esc` never exits fullscreen in Show Mode.

New IPC (follow existing conventions: `ipcMain.handle` + `requireTrustedIpc` + bounded
validators; cross-window fan-out via `BrowserWindow.getAllWindows()` skip-sender):

- `video-output:open` / `video-output:close` / `video-output:status`
- `video-output:list-displays` / `video-output:set-display`
- `video-output:test-card` (show/hide)

## 8. Client UI changes

| Area | File(s) | Change |
|---|---|---|
| Output page | `client/app/pages/` (new) + `useVideoOutput.ts` composable | Layer stack render, `<video>` muted, chase sync, images, black, test card |
| Item model | `client/app/types/project.ts` | `imagePath?` on `AudioItem`; settings fields (§5.2) |
| Properties | `PropertiesPanel.vue` | Per-cue image picker (file dialog → copy into `media/`), clear-image; video badge readout from server probe |
| Playlist row | `PlaylistItem.vue` | Video badge/icon on video items |
| Settings | Project Settings component | Standby image picker, output enable + display picker, test-card button |
| Network UI gate | `ServerSettingsModal.vue` + its entry points | Hidden by default (`hideNetworkUi`), re-enable via app settings |
| Import | import composables, drop handlers | Accept video extensions; label "Import Media" |
| i18n | `client/locales/*` + `scripts/sync-locale-keys.js` | New keys for all of the above (21 locales, English fallback pattern) |

## 9. Explicit non-goals (v1)

Video crossfades / fade-to-black · multiple simultaneous video streams · ProRes / alpha ·
NDI output · remote (networked) video rendering · video effects/overlays · HDMI audio ·
slide-advance animations. The `hideNetworkUi` gate is a UI simplification, not a removal.

## 10. Risks

| Risk | Mitigation |
|---|---|
| OS reshuffles displays when the switcher re-negotiates EDID | Watchdog re-acquires by persisted fingerprint; window never settles on the laptop screen silently |
| Operator arrives with mirrored displays | Detect + prominent warning at arm time |
| Windows HEVC decode gaps (GPU/OS codec pack) | Docs steer to H.264; runtime decode failure falls back to image layer + control-window warning |
| Decode CPU spikes starve audio | Chromium decodes in its own process/GPU; engine RT thread untouched (existing `check-audio-rt-safety` discipline); 1080p targets |
| Project JSON drift | All new fields optional/additive; old builds ignore them |
| vcpkg ffmpeg demuxer coverage differs on Windows/Linux CI builds | Add `.mp4` (H.264+AAC) and video-only cases to `tests/decoder_check.cpp` self-tests so CI proves the capability per-platform |

## 11. Acceptance criteria

1. Fire a video cue → picture on HDMI output, audio on program output through the
   limiter/meters; lipsync within ±2 frames over a 10-minute clip (chase holds).
2. Fire an audio cue with an image → image on output; without an image → global standby;
   with neither → black. No desktop flash at any transition.
3. Video in/out points and audio fades behave identically to audio cues; out-point cuts
   picture and sound together.
4. Video without an audio track plays full-length, auto-advances, and shows progress.
5. Unplug/replug HDMI (or switch inputs on the switcher) → output window returns to the
   assigned display without operator action; mirrored displays produce a clear warning.
6. Test card shows output name + resolution on demand.
7. Display sleep/screensaver never engages while the output is armed; cursor never
   appears on the output.
8. Network/remote-server UI is hidden by default and re-enableable.
9. A project saved with video cues loads on a build without the feature (fields ignored).

## 12. Suggested implementation slices

1. **Output window skeleton** — `?videoOutput=1` page, Electron window + display pinning +
   persistence, black layer, test card, watchdog, powerSaveBlocker. (Pure client/Electron.)
2. **Cue model + probe** — server stream-flag probe, `imagePath`/settings fields end-to-end,
   import accepts video.
3. **Playback + sync** — video cue render, chase algorithm, layer stack with per-cue/standby
   images; silent-video transport in the engine.
4. **Hygiene & gating** — network-UI gate, playlist badges, properties pickers, locales,
   docs, decoder self-tests in CI.
