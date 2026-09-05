# DonWells Cue Client — developer guide

The DonWells Cue client is a Vue 3 + Nuxt 4 application wrapped in Electron. It is a **remote control** for the DonWells Cue audio server: it owns no audio decoding, no playback, no Web Audio nodes. Every user action turns into a REST call or WebSocket frame sent to `dwcue-server`, and every meter / waveform / state update comes back the same way.

This document tracks the current v2.6.13 source and is the developer's guide to the client; use the release page to determine which behaviour is present in a downloaded installer. For show-day use, see the [operator manual (PDF)](../docs/operators-manual.pdf) or [Markdown source](../docs/operators-manual.md). For the audio engine, see [`server/README.md`](../server/README.md); for overall project and release context, see the [root README](../README.md).

---

## Contents

- [Tech stack](#tech-stack)
- [Source layout](#source-layout)
- [Running](#running)
- [Architecture](#architecture)
  - [The renderer ↔ Electron-main split](#the-renderer--electron-main-split)
  - [The renderer ↔ DonWells Cue server link](#the-renderer--donwells-cue-server-link)
  - [Local server lifecycle](#local-server-lifecycle)
- [Composables](#composables)
- [Components](#components)
- [Localisation (21 languages, RTL)](#localisation-21-languages-rtl)
- [Theming](#theming)
- [Auto-updates](#auto-updates)
- [Packaging](#packaging)
- [Adding features](#adding-features)

---

## Tech stack

| Layer            | Library                                                         |
|------------------|-----------------------------------------------------------------|
| Shell            | Electron 42                                                     |
| Renderer         | Nuxt 4 (Vue 3 Composition API, TypeScript, SCSS)                |
| UI primitives    | Material Symbols icons; in-house components — no UI framework   |
| Local server     | C++ `dwcue-server` binary spawned as a child process         |
| Media tooling    | `@ffmpeg-installer/ffmpeg`, `@ffprobe-installer/ffprobe`        |
| YouTube import   | `yt-dlp-wrap` + `youtube-search-api`                            |
| Updates          | `electron-updater` (GitHub Releases feed: `donwellsav/dwcue`)      |
| File transport   | Server-backed REST upload/download for `.dwcuepack` project archives; one-way `.lpa` legacy import |

Audio playback, waveform extraction, metering and routing all live in the C++ server. The renderer never decodes audio.

---

## Source layout

```
client/
├── app/
│   ├── app.vue                  Nuxt root and application shell
│   ├── components/              Vue SFCs (all in one flat folder)
│   ├── composables/             Reactive state + server bindings
│   │   ├── useLiveplayServer.ts singleton REST + WebSocket client — every component goes through this
│   │   ├── useLiveMeters.ts     meter subscription helpers
│   │   ├── useProject.ts        project CRUD as exposed by the server
│   │   ├── useAudioEngine.ts    transport facade (play / stop / fade / seek / ducking)
│   │   ├── useCartItems.ts      one-shot grid state (legacy cart storage facade)
│   │   ├── useCartHotkeys.ts    keyboard hotkey bindings → One Shot triggers
│   │   ├── useMidiController.ts Web MIDI → One Shot triggers
│   │   ├── useStateViewer.ts    feeds the diagnostics popup window
│   │   └── useLocalization.ts   21-language i18n + RTL handling
│   ├── plugins/                 Nuxt plugins (liveplay-server.client.ts connects on boot)
│   ├── types/                   TypeScript DTOs (server.ts, project.ts, global.d.ts)
│   └── utils/                   Pure helpers (audio.ts, indexDisplay.ts)
├── electron/
│   ├── main.js                  Electron main process: windows, menus, IPC, server lifecycle, video output
│   ├── preload.js               contextBridge → `window.electronAPI`
│   ├── video-output-shortcuts.js pure keyboard-forwarding policy for the passive output window
│   ├── video-output-context-menu.js pure context-menu template for output recovery controls
│   └── preload-state-viewer.js  separate preload for the state-viewer popup window
├── locales/                      JSON locale files (21 files — en + 20 translations)
├── public/                       Current app screenshots used by the top-level README
├── assets/                       Bundled styles (main.scss, variables.scss)
├── scripts/                      Workspace-local utilities (locale sync, etc.)
├── nuxt.config.ts                Nuxt configuration
├── tsconfig.json
└── package.json                  Electron + electron-builder configuration
```

---

## Running

From the monorepo root, `npm run dev` does the full loop:

1. [`scripts/ensure-server.js`](../scripts/ensure-server.js) checks whether either expected C++ server binary exists and builds one only when both are missing.
2. `nuxt dev` starts on `http://localhost:3000` with HMR.
3. `wait-on` waits for Nuxt, then `electron .` launches with DevTools open.

`npm run dev:client` (equivalent to `npm run dev --workspace=client`) skips `ensure-server.js` and starts only the Nuxt + Electron workspace loop. It is not equivalent to `npm run dev`: use it only when the server binary is already built. Neither command detects changed C++ sources once a binary exists, so run `npm run server:build` after server changes.

To work on just the renderer (no Electron shell), run `npm run dev:nuxt --workspace=client` from the monorepo root (or `npm run dev:nuxt` inside `client/`) and visit `http://localhost:3000`. The renderer still needs a separately running `dwcue-server`; build it with `npm run server:build`, then start it from the root with `npm run server:run`.

Production build (Nuxt static generate + electron-builder):

```sh
npm run build:electron -- --mac --arm64   # Apple Silicon
npm run build:electron -- --mac --x64     # Intel
```

Outputs land in `client/dist-electron/`. The root `npm run build` script copies the installers from there into `build/` at the repo root.

---

## Architecture

### The renderer ↔ Electron-main split

The renderer is a sandboxed Nuxt SPA with `nodeIntegration: false` and `contextIsolation: true`. The Electron main process exposes a controlled surface via [`electron/preload.js`](electron/preload.js) → `window.electronAPI`. Anything that needs Node.js (file dialogs, child processes, OS integration, auto-update, native menu) goes through an IPC handler in [`electron/main.js`](electron/main.js).

Key IPC channels (non-exhaustive):

| Channel                               | Purpose |
|---------------------------------------|---------|
| `liveplay-server:get-config` / `set-config` | Read/write the persisted server mode, URL, and remote-user connection settings; managed credentials are excluded. |
| `liveplay-server:get-status` / `ensure-running` / `restart` / `shutdown` / `state` | Manage the bundled server child process. Trusted status/state replies deliver the current managed credential to the renderer. |
| `liveplay-discovery:start` / `list`   | Browse for `dwcue-server` instances on the LAN. |
| `select-project-folder` / `select-project-file` / `select-audio-files` | Native file pickers. |
| `read-file` / `write-file` / `copy-file` | Authorized project filesystem helpers. |
| `get-binary-file-info` / `read-binary-file-chunk` | Bounded local archive reads for remote imports. |
| `download-archive-to-file` | Streams a server archive directly to an authorized local destination. |
| `menu-export-project` / `menu-import-project` (main → renderer) | Menu-triggered `.dwcuepack` export/import plus explicit `.lpa` legacy import; the renderer owns the dialogs. |
| `check-for-updates` / `download-update` / `install-update` / `get-update-install-supported` / `get-app-version` | `electron-updater` controls. |
| `update-available` / `update-up-to-date` / `update-download-progress` / `update-downloaded` / `update-error` / `menu-check-for-updates` (main → renderer) | Update flow events; `menu-check-for-updates` is the Help-menu trigger. |
| `update-menu-language` / `get-system-locale` / `get-available-locales` / `get-locale-data` | Dynamic menu localisation. |
| `open-folder` / `open-external` / `app:relaunch` / `app:exit` | OS integration. |
| `open-cart-player-window` / `cart-player-window-attach` / `sync-project-data` | Second-window One Shots surface; the cart-player channel names remain for compatibility. |
| `video-output:open` / `close` / `status` | Session-only Video Output lifecycle and status. |
| `video-output:list-displays` / `identify-displays` / `set-display` | Enumerate, identify and persist the machine's assigned physical output. |
| `video-output:set-fullscreen` / `toggle-fullscreen` / `test-card` | Operator controls for the passive output surface. |
| `video-output:shortcut` (main → renderer) | Forward application shortcuts when the Video Output window owns keyboard focus. |

The audio data path is **not** via IPC — it's directly between the renderer and `dwcue-server` over HTTP + WebSocket. IPC is used only for things Electron needs to do as a desktop application.

New shows and normal saves use the native `.dwcue` JSON document. New portable exports are ZIP archives named `.dwcuepack`; no additional manifest is required. The import UI also reads legacy `.liveplay` documents and `.lpa` archives as a one-way conversion. A direct `.liveplay` import writes an available `.dwcue` sibling; an `.lpa` import writes one canonical `.dwcue` in a fresh extraction directory. Both preserve the original legacy bytes and continue saving the canonical result rather than the legacy source.

### The renderer ↔ DonWells Cue server link

`app/composables/useLiveplayServer.ts` is the single source of truth. It is a Vue singleton — every component that calls `useLiveplayServer()` receives the **same** WebSocket connection and the **same** reactive state. The contract:

- The server URL and a remote user's token are stored in `localStorage` under `liveplay.serverUrl` and `liveplay.accessToken`; change them via **Server Settings**. A managed local token is session-only in the renderer and is never written there.
- Every local and remote control call is authenticated except `GET /api/health`. REST uses `Authorization: Bearer <token>`; bearer-in-query is restricted to browser WebSocket `/ws` and media-element `/api/media` requests.
- Browser origins must exactly match `LIVEPLAY_ALLOWED_ORIGINS`. Source development uses `http://localhost:3000`, not an arbitrary loopback origin. Packaged Electron's opaque `Origin: null` is accepted, but it still requires the token.
- On boot, the [`app/plugins/liveplay-server.client.ts`](app/plugins/liveplay-server.client.ts) plugin connects. The connection is lazy-retried if it drops (showing `ConnectionLostModal` in the meantime). If a changed server project meets dirty local edits, the modal requires **Use server project** (discard local/adopt server) or **Restore local project** (replace server/keep local dirty) instead of overwriting either side silently.
- A close-side `project_changed` clears both the renderer's project document and its remembered path. Saves are serialized and revision-fenced: completion only marks the exact saved revision clean, so an older response cannot erase a newer dirty edit.
- REST calls return promises; WebSocket frames update reactive refs. Outbound frames are mostly transport commands (`play`, `stop`, `seek`) that take a fast WS path; project mutations use `PATCH /api/project/...` so the server can echo a `doc_patch` to all connected clients.

For the full REST and WebSocket surface, see [`server/README.md`](../server/README.md#control-surface).

### Local server lifecycle

When DonWells Cue is installed as a desktop app, [`electron/main.js`](electron/main.js) is also responsible for spawning the bundled server. The recipe:

1. `electron-builder` copies `dwcue-server[.exe]` into `resources/server-bin/` via `extraResources` (see the `build` block in `package.json`).
2. Each newly spawned backend generation receives a fresh random 64-character lowercase-hex token through `LIVEPLAY_ACCESS_TOKEN` while remaining bound to `127.0.0.1:<port>`.
3. The lock records PID, port, generation identity, and token so a later launch can reattach. It is owner-only (`0600` on POSIX), read without following symlinks, and the token is never logged.
4. Trusted `liveplay-server:*` IPC replies deliver that managed token to the renderer for the current session; config and browser storage never persist it.
5. Closing the UI leaves the detached server running so a renderer restart cannot interrupt show state; the next launch reattaches through the lock.
6. The app can explicitly stop or restart that process. Switching **Server Settings** to a remote server cleanly stops the local child first.

For upgrade compatibility, Electron's managed backend intentionally keeps the existing platform `userData` profile named `LivePlay` (for example, `~/Library/Application Support/LivePlay` on macOS). Managed server configuration, PID/lock state, and logs remain there; startup does not copy, move, or rename the profile. This is a storage-compatibility boundary, not the product's visible name. Standalone server state uses the branded DonWells Cue location documented in the operator manual.

`liveplay-discovery:*` IPC channels run a UDP listener that picks up announce broadcasts from `dwcue-server` instances on the LAN, so the connection UI can present a one-click list.

### Video Output lifecycle and keyboard ownership

The Video Output window is deliberately **session-only** even though its display assignment is machine-specific:

- `<userData>/video-output.json` persists only `displayId` and `displayFingerprint`. Legacy `enabled` values are ignored.
- Every app launch starts with the output closed. `video-output:open` arms it for the current process; an operator close disarms it, while an internal display-watchdog recreation preserves the current session.
- The display selector works while the output is closed. `video-output:identify-displays` creates click-through, always-on-top number cards on every connected screen for five seconds.
- A valid independently addressable display gets a frameless fullscreen window. An unassigned or single-display setup gets a normal 960×540 preview window instead of a fullscreen takeover.
- The output's native context menu exposes fullscreen, test-card and **Exit Video Output** actions. On Windows the real output remains `closable` so Alt+F4 is always an escape hatch. Black is the idle base layer, not a dedicated operator blackout; no blackout/fade-to-black IPC command exists.

The passive output can own keyboard focus, especially on Windows. Its Electron
`before-input-event` handler therefore forwards application-level keys to the control
renderer through `video-output:shortcut`, where they are re-dispatched into the existing
shortcut system. OS and native application accelerators are intentionally excluded from
forwarding: Windows Alt+F4, Windows-key combinations, F11, the standard Ctrl/Cmd
N/O/S/W/Q commands, and development shortcuts. Keep this policy in
[`electron/video-output-shortcuts.js`](electron/video-output-shortcuts.js); do not create a
second shortcut implementation in the output renderer.

---

## Composables

All composables are Vue `setup()`-time helpers, typed in TypeScript.

| Composable             | Responsibility |
|------------------------|----------------|
| `useLiveplayServer`    | REST + WS singleton. Holds connection state, project document, server config. Every other composable builds on this. |
| `useLiveMeters`        | Subscribes to the `meters` WS frame and exposes per-cue / per-mixer / per-master reactive refs at the server's default 30 Hz cadence. Drives `LiveMeterBar` and `StereoMeter`. |
| `useProject`           | Project CRUD and sync as exposed by the server. It clears document/path on remote close and serializes revision-fenced saves so only the latest persisted revision becomes clean. |
| `useAudioEngine`       | Transport facade. **Cue to Continue** is runtime-only for one playback instance: it never rewrites `endBehavior`, and Stop, remove, replay, Stop All, media replacement, or project switch cancels it. |
| `useCartItems`         | The One Shots grid model (slot → cue mapping, per-cell arm state). An arm is consumed only after accepted play; repeated identical arming is coalesced. Storage keeps the legacy cart shape for compatibility. |
| `useCartHotkeys`       | Configurable keyboard shortcuts → One Shot triggers. See `ControlConfigModal.vue` for the current UI. |
| `useMidiController`    | Web MIDI bindings → One Shot triggers. See `ControlConfigModal.vue`. |
| `useStateViewer`       | Feeds the live diagnostics popup window (project doc + connection + server status). |
| `useLocalization`      | i18n (21 languages, RTL). See [Localisation](#localisation-21-languages-rtl). |
| `useUiMode`            | UI preferences singleton: theme, waveform opacity, playlist track heights, UI font scale (80–110 %, CSS `zoom` on `#app`, excluded in the video output window) and One Shot text scale (70–130 %). |

**Rule of thumb**: components don't import `useLiveplayServer` directly unless they're presenting a low-level diagnostic. They use one of the facades above so the surface stays small and testable.

---

## Components

The component tree is intentionally flat — every SFC lives directly in [`app/components/`](app/components/). The big ones to know:

- `WelcomeScreen.vue` — project picker and **New Show** entry; creation combines a name field with a read-only Location chosen through **Choose…**.
- `MainWorkspace.vue` — top-level layout once a project is loaded.
- `PlaybackControls.vue`, `ActiveCueItem.vue` — top-of-screen GO transport and named **Play Next** target. GO clears the target only after accepted play; a failed or not-yet-loaded target remains ready for retry, and duplicate inputs are coalesced.
- `PlaylistView.vue`, `PlaylistItem.vue` — recursive playlist tree.
- `OneShotPanel.vue`, `OneShotTile.vue` — 1–64 cell quick-play grid with per-cell ARMED/UNARMED gating. An unused panel starts collapsed unless the user explicitly makes it visible; the detached window retains legacy cart-player IPC names. **Duck Level** is consumed by the server, but the visible **Duck Time** and **Release Time** values are not; playback gain uses fixed smoothing.
- `PropertiesPanel.vue` — properties for the selected item (gain, fades, behaviours, ducking, output device and LTC). It currently exposes the unsupported audio Start Behavior and group End Behavior controls described below.
- `WaveformCanvas.vue` — canvas-rendered waveform fetched from `GET /api/waveform/<cueId>`.
- `WaveformTrimmer.vue` — interactive in/out trimming + normalise.
- `RoutingMatrixPanel.vue` — an unmounted 3-tier routing-matrix component; there is no import/callsite that exposes it in the current app. The operator-facing controls are Settings → **Audio Routing** for devices and Properties → **Output device** / **LTC** per cue; the full matrix remains available through the server API.
- `LiveMeterBar.vue`, `StereoMeter.vue` — meter widgets driven by `useLiveMeters`.
- `ServerSettingsModal.vue`, `LocalServerStatus.vue`, `ConnectionLostModal.vue` — authenticated server connection management and explicit dirty-reconnect **Use server project** (discard local/adopt server) / **Restore local project** (replace server/keep local dirty) choice.
- `ServerFileBrowser.vue`, `ServerFilePickerModal.vue` — the advanced `GET /api/fs/list` browser for media already on another server; it stays collapsed in the normal local-import flow and disables unsupported non-media entries.
- `AudioImportModal.vue`, `YouTubeImportModal.vue` — media import surfaces; local **Choose files** is the primary action.
- `ProjectSelectionModal.vue`, `ProjectSettingsModal.vue`, `ProjectRepairModal.vue` — project management, including the combined name-and-location **New Show** flow.
- `UpdateModal.vue` — auto-update UI.
- `AboutModal.vue`, `ProgressModal.vue`, `LoadingOverlay.vue`, `LocationChoiceModal.vue` — misc.
- `ShortcutsBar.vue` — on-screen hotkey reference strip, visible by default.
- `VideoOutputView.vue`, `VideoConfidenceChip.vue` — the `?videoOutput=1` render surface and its 1 fps confidence thumbnail in the header. Black is only the idle base layer; there is no dedicated blackout or fade-to-black command.

**Current sequencing contract:** **Play First** triggers a group's first immediate child and **Play All** triggers all immediate children. Although Properties currently renders End Behavior controls for a group, the server does not consume a group-level End Behavior. An audio cue's **Play Next** resolves only its next sibling in the same group; the final child must use **Go to Item** or **Go to Index** to leave the group.

The audio cue Start Behavior dropdown values `play-next`, `play-item`, and `play-index` are also not interpreted by the current server. Use natural-end **End Behavior**, or **Start Next at Marker** / **Start Next At** / **Fade Out at Marker** for timed overlaps.

Style: Composition API + `<script setup lang="ts">`, scoped SCSS, CSS variables for theming (see [Theming](#theming)).

---

## Localisation (21 languages, RTL)

DonWells Cue ships with [`locales/*.json`](locales/) — one file per language. The 21 locale codes are **ar, bn, de, el, en, es, fa, fr, hi, it, ja, ko, no, pt, ro, ru, sq, sv, tr, ur, zh**: Arabic, Bengali, German, Greek, English, Spanish, Persian, French, Hindi, Italian, Japanese, Korean, Norwegian, Portuguese, Romanian, Russian, Albanian, Swedish, Turkish, Urdu and Chinese.

Arabic, Persian and Urdu use RTL layout. A missing translated value falls back to English, so every source key remains renderable while translations catch up.

### Using translations in a component

```vue
<script setup lang="ts">
const { t, currentLocale, getDirection } = useLocalization();
</script>

<template>
  <button>{{ t('menu.newProject') }}</button>
  <p>{{ t('welcome.subtitle') }}</p>
</template>
```

Keys are dot-notation paths into the locale JSON tree. Missing keys silently fall back to English.

### Locale-file structure

Each locale starts with a `_metadata` block:

```json
{
  "_metadata": { "code": "en", "name": "English", "nativeName": "English", "direction": "ltr" },
  "app": { … },
  "menu": { … },
  "welcome": { … },
  …
}
```

`direction: "rtl"` triggers `dir="rtl"` on the root element and the RTL CSS rules in `assets/styles/main.scss`.

### Adding a language

1. Copy `locales/en.json` to `locales/<code>.json`.
2. Update `_metadata` (`code`, `name`, `nativeName`, `direction`).
3. Translate the values; don't change the keys.
4. From the monorepo root: `node scripts/sync-locale-keys.js` to backfill any keys you missed from `en.json`.
5. The language appears automatically in both Settings → **User Interface** and the **View → Language** menu — `useLocalization` discovers locales at runtime, and the Electron menu is generated from the same source via the `get-available-locales` / `get-locale-data` IPC channels.

### Persistence

The chosen locale is a per-device application preference stored in `localStorage` under `liveplay-locale`; it is not saved in the project. Settings → **User Interface** and the Electron menu stay synchronized.

---

## Theming

All colours and spacing flow through CSS custom properties in [`assets/styles/main.scss`](assets/styles/main.scss):

```scss
[data-theme='dark'] {
  --color-background: #16161d;
  --color-surface:    #24242d;
  --color-text-primary: #f4f4f4;
  --color-accent: var(--color-accent-custom, #da1e28);
}
```

Custom accent colours are set at runtime:

```ts
document.documentElement.style.setProperty('--color-accent-custom', '#0066FF');
```

Theme mode + accent colour are persisted on the project, not per-user — every operator opening the same project sees the same look. The UI lives in `ProjectSettingsModal.vue`.

---

## Auto-updates

Updates are **enabled** and pinned to this repository's GitHub Releases via `autoUpdater.setFeedURL` in [`electron/main.js`](electron/main.js) (`donwellsav/dwcue`) — the app never checks any other feed.
The v2.6.12 release introduced updater support. v2.6.13 continues the same GitHub Releases feed; existing v2.6.11 installs must first install v2.6.12 or later manually.

Behaviour:

- **Startup check** — a silent check runs a few seconds after the window appears (packaged builds only). If an update exists, the renderer defers showing `UpdateModal.vue` while Show Mode is active, so a running show is never interrupted.
- **Manual check** — Help → **Check for Updates…** (hidden in dev builds). "Update available" opens the modal; "up to date" shows a transient toast.
- **Install** — ask-first (`autoDownload = false`, `autoInstallOnAppQuit = false`): the user downloads, then chooses **Install Now** (relaunch after install) or **Install on Exit** (install during quit without relaunching). Both paths pass the unsaved-changes guard and stop the managed audio server before replacing app files.
- **Linux** — only the AppImage build self-updates. deb/rpm installs surface the update but the modal's primary action routes to dwcue.com/downloads instead of an in-place install (dpkg/rpm can't replace a running package).

The updater fetches `latest.yml` (Windows) / `latest-mac.yml` (macOS) / `latest-linux.yml` (Linux) from the latest GitHub release. The release job recomputes every manifest checksum from the published bytes and **merges the two per-arch macOS manifests into one `latest-mac.yml`** (electron-updater always requests that name; `MacUpdater` picks the arm64/x64 file itself at download time). See the [release workflow](../.github/workflows/build-release.yml).

---

## Packaging

The `build` block in [`package.json`](package.json) drives `electron-builder`:

- `appId`: `com.donwells.cue`
- `productName`: `DonWells Cue`
- `files`: includes `.output/`, `electron/`, `assets/`, `locales/`. Locales must be listed explicitly or they don't ship.
- `extraResources`: copies the C++ server binary into `resources/server-bin/`.
- `asarUnpack`: the ffmpeg/ffprobe installers can't run from inside an asar, so they're unpacked.
- `fileAssociations`: registers the native `.dwcue` document and `.dwcuepack` archive extensions. Legacy `.liveplay` and `.lpa` inputs remain available through **Import Project**, not as canonical OS associations.

Run the unified package build from the monorepo root so the matching native server is configured and rebuilt before Electron packaging:

```sh
npm run build:electron -- --mac --arm64  # Apple Silicon
npm run build:electron -- --mac --x64    # Intel
npm run build:electron -- --win --x64    # Windows
```

The macOS architecture flag must match the native `dwcue-server` built in `server/build`; the root command handles that pairing. The release workflow builds and validates arm64 and x64 in separate jobs.

For multi-platform builds, use the [GitHub Actions release workflow](../.github/workflows/build-release.yml) — cross-compiling Electron locally is unreliable.

---

## Adding features

### A new component

1. Create `app/components/MyThing.vue` with `<script setup lang="ts">`.
2. If it needs server state, use a composable (not `useLiveplayServer` directly) — add the new method to the composable rather than calling REST inline.
3. Add translation keys to `locales/en.json`; run `node ../scripts/sync-locale-keys.js` to backfill the other languages.
4. Use CSS variables for colours and spacing; scoped SCSS for styling.

### A new server-backed action

1. Add the REST/WS handler on the server side (see [`server/README.md`](../server/README.md#adding-features)).
2. Add the matching method to `app/composables/useLiveplayServer.ts`.
3. Expose it through one of the facade composables (`useProject`, `useAudioEngine`, …) if it's user-facing.
4. Wire it into a component.

### A new IPC handler

Use IPC **only** for capabilities that genuinely need the Electron main process (file dialogs, OS integration, the local server child process, updater). Anything that touches audio or the project document goes through `dwcue-server`.

1. `ipcMain.handle('my-channel', async (event, …args) => { … })` in [`electron/main.js`](electron/main.js).
2. Expose it via `contextBridge.exposeInMainWorld('electronAPI', { … })` in [`electron/preload.js`](electron/preload.js).
3. Add the type to `app/types/global.d.ts`.
4. Call `window.electronAPI.myChannel(...)` from the renderer.

### Debugging

- **Renderer**: open DevTools in the running Electron app (Ctrl/Cmd+Shift+I); or hit `http://localhost:3000` in a browser during `npm run dev`.
- **Main process**: `console.log` lands in the terminal that started Electron.
- **IPC tracing**: add a log inside the handler and inside the call site — handy when wiring up a new channel.
- **Server traffic**: open the WebSocket frame inspector in DevTools (Network → WS).
- **Live state**: open the diagnostics popup via the View menu — driven by `useStateViewer` and its separate preload.
- **Video Output safety policy**: run `npm run test:video-output` from `client/` (or `npm run test:video-output --workspace=client` from the monorepo root) after changing shortcut forwarding or the native recovery menu.

For the audio/transport side of any bug (timing, fades, routing, meters), the issue is almost always server-side — see [`server/README.md`](../server/README.md).
