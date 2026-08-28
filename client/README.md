# DonWells Cue Client — developer guide

The DonWells Cue client is a Vue 3 + Nuxt 4 application wrapped in Electron. It is a **remote control** for the DonWells Cue audio server: it owns no audio decoding, no playback, no Web Audio nodes. Every user action turns into a REST call or WebSocket frame sent to `dwcue-server`, and every meter / waveform / state update comes back the same way.

This document is the developer's guide to the client. For the audio engine, see [`server/README.md`](../server/README.md). For the overall project, see the [root README](../README.md).

---

## Contents

- [Tech stack](#tech-stack)
- [Source layout](#source-layout)
- [Running](#running)
- [Architecture](#architecture)
  - [The renderer ↔ Electron-main split](#the-renderer--electron-main-split)
  - [The renderer ↔ DW Cue server link](#the-renderer--dw-cue-server-link)
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
| Updates          | `electron-updater` wiring (disabled until the branded feed exists) |
| File transport   | Server-backed REST upload/download for `.lpa` project archives  |

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

From the monorepo root, `npm run dev` (or `npm run dev --workspace=client`) does the full loop:

1. [`scripts/ensure-server.js`](../scripts/ensure-server.js) checks whether the C++ server is built; if not, builds it.
2. `nuxt dev` starts on `http://localhost:3000` with HMR.
3. `wait-on` waits for Nuxt, then `electron .` launches with DevTools open.

To work on just the renderer (no Electron shell): `npm run dev:nuxt` and visit `http://localhost:3000` in a browser. The renderer still tries to talk to a running `dwcue-server`; start one separately with `npm run server:run` from the monorepo root.

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
| `liveplay-server:get-config` / `set-config` | Read/write the persisted server connection settings. |
| `liveplay-server:get-status` / `ensure-running` / `restart` / `shutdown` | Manage the bundled server child process. |
| `liveplay-discovery:start` / `list`   | Browse for `dwcue-server` instances on the LAN. |
| `select-project-folder` / `select-project-file` / `select-audio-files` | Native file pickers. |
| `read-file` / `write-file` / `copy-file` | Authorized project filesystem helpers. |
| `get-binary-file-info` / `read-binary-file-chunk` | Bounded local archive reads for remote imports. |
| `download-archive-to-file` | Streams a server archive directly to an authorized local destination. |
| `menu-export-project` / `menu-import-project` (main → renderer) | Menu-triggered `.lpa` archive round-trip; the renderer owns the export/import dialogs. |
| `check-for-updates` / `download-update` / `install-update` / `get-app-version` | `electron-updater` controls. |
| `update-menu-language` / `get-system-locale` / `get-available-locales` / `get-locale-data` | Dynamic menu localisation. |
| `open-folder` / `open-external` / `app:relaunch` / `app:exit` | OS integration. |
| `open-cart-player-window` / `cart-player-window-attach` / `sync-project-data` | Second-window One Shots surface; the cart-player channel names remain for compatibility. |
| `video-output:open` / `close` / `status` | Session-only Video Output lifecycle and status. |
| `video-output:list-displays` / `identify-displays` / `set-display` | Enumerate, identify and persist the machine's assigned physical output. |
| `video-output:set-fullscreen` / `toggle-fullscreen` / `test-card` | Operator controls for the passive output surface. |
| `video-output:shortcut` (main → renderer) | Forward application shortcuts when the Video Output window owns keyboard focus. |

The audio data path is **not** via IPC — it's directly between the renderer and `dwcue-server` over HTTP + WebSocket. IPC is used only for things Electron needs to do as a desktop application.

### The renderer ↔ DW Cue server link

`app/composables/useLiveplayServer.ts` is the single source of truth. It is a Vue singleton — every component that calls `useLiveplayServer()` receives the **same** WebSocket connection and the **same** reactive state. The contract:

- The server URL and optional LAN access token are read from `localStorage` (`liveplay.serverUrl` and `liveplay.accessToken`; local default `http://127.0.0.1:4480`). Change them via the **Server Settings** modal.
- On boot, the [`app/plugins/liveplay-server.client.ts`](app/plugins/liveplay-server.client.ts) plugin connects. The connection is lazy-retried if it drops (showing `ConnectionLostModal` in the meantime).
- REST calls return promises; WebSocket frames update reactive refs.
- Outbound frames are mostly transport commands (`play`, `stop`, `seek`) that take a fast WS path to avoid the HTTP round-trip; everything mutating goes through `PATCH /api/project/...` so the server can echo a `doc_patch` to all connected clients.

For the full REST and WebSocket surface, see [`server/README.md`](../server/README.md#control-surface).

### Local server lifecycle

When DonWells Cue is installed as a desktop app, [`electron/main.js`](electron/main.js) is also responsible for spawning the bundled server. The recipe:

1. `electron-builder` copies `dwcue-server[.exe]` into `resources/server-bin/` via `extraResources` (see the `build` block in `package.json`).
2. On first launch, main resolves the binary path and spawns it as a detached child process bound to `127.0.0.1:<port>`.
3. A lockfile records the PID so subsequent launches reattach to the running instance rather than spawning a duplicate.
4. Closing the UI leaves the detached server running so a renderer restart cannot interrupt show audio; the next launch reattaches through the PID file.
5. The app can explicitly stop or restart that process. Switching **Server Settings** to a remote server cleanly stops the local child first.

`liveplay-discovery:*` IPC channels run a UDP listener that picks up announce broadcasts from `dwcue-server` instances on the LAN, so the connection UI can present a one-click list.

### Video Output lifecycle and keyboard ownership

The Video Output window is deliberately **session-only** even though its display assignment is machine-specific:

- `<userData>/video-output.json` persists only `displayId` and `displayFingerprint`. Legacy `enabled` values are ignored.
- Every app launch starts with the output closed. `video-output:open` arms it for the current process; an operator close disarms it, while an internal display-watchdog recreation preserves the current session.
- The display selector works while the output is closed. `video-output:identify-displays` creates click-through, always-on-top number cards on every connected screen for five seconds.
- A valid independently addressable display gets a frameless fullscreen window. An unassigned or single-display setup gets a normal 960×540 preview window instead of a fullscreen takeover.
- The output's native context menu exposes fullscreen, test-card and **Exit Video Output** actions. On Windows the real output remains `closable` so Alt+F4 is always an escape hatch.

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
| `useLiveMeters`        | Subscribes to the `meters` WS frame and exposes per-cue / per-mixer / per-master reactive refs at 60 Hz. Drives `LiveMeterBar` and `StereoMeter`. |
| `useProject`           | Project CRUD as exposed by the server (new, open, save, close, item add/remove/move/patch). Wraps `useLiveplayServer` calls into ergonomic methods. |
| `useAudioEngine`       | Transport facade: `playCue`, `stopCue`, `stopAllCues`, `seek`, `setVolume`, ducking mode helpers. All implemented by forwarding to the server — no audio runs in the renderer. |
| `useCartItems`         | The One Shots grid model (slot → cue mapping, per-cell arm state); storage keeps the legacy cart shape for compatibility. |
| `useCartHotkeys`       | Configurable keyboard shortcuts → One Shot triggers. See `ControlConfigModal.vue` for the current UI. |
| `useMidiController`    | Web MIDI bindings → One Shot triggers. See `ControlConfigModal.vue`. |
| `useStateViewer`       | Feeds the live diagnostics popup window (project doc + connection + server status). |
| `useLocalization`      | i18n (21 languages, RTL). See [Localisation](#localisation-21-languages-rtl). |
| `useUiMode`            | UI preferences singleton: theme, waveform opacity, playlist track heights, UI font scale (80–110 %, CSS `zoom` on `#app`, excluded in the video output window) and One Shot text scale (70–130 %). |

**Rule of thumb**: components don't import `useLiveplayServer` directly unless they're presenting a low-level diagnostic. They use one of the facades above so the surface stays small and testable.

---

## Components

The component tree is intentionally flat — every SFC lives directly in [`app/components/`](app/components/). The big ones to know:

- `WelcomeScreen.vue` — project picker before a project is loaded.
- `MainWorkspace.vue` — top-level layout once a project is loaded.
- `PlaybackControls.vue`, `ActiveCueItem.vue` — top-of-screen transport.
- `PlaylistView.vue`, `PlaylistItem.vue` — recursive playlist tree.
- `OneShotPanel.vue`, `OneShotTile.vue` — permanent 1–64 cell quick-play grid with per-cell ARMED/UNARMED gating (the detached window retains legacy cart-player IPC names).
- `PropertiesPanel.vue` — properties for the selected item (gain, fades, behaviours, ducking).
- `WaveformCanvas.vue` — canvas-rendered waveform fetched from `GET /api/waveform/<cueId>`.
- `WaveformTrimmer.vue` — interactive in/out trimming + normalise.
- `RoutingMatrixPanel.vue` — the 3-tier routing matrix UI.
- `LiveMeterBar.vue`, `StereoMeter.vue` — meter widgets driven by `useLiveMeters`.
- `ServerSettingsModal.vue`, `LocalServerStatus.vue`, `ConnectionLostModal.vue` — server connection management.
- `ServerFileBrowser.vue`, `ServerFilePickerModal.vue` — `GET /api/fs/list` browser, used when the client and server live on different machines.
- `AudioImportModal.vue`, `YouTubeImportModal.vue` — media import surfaces.
- `ProjectSelectionModal.vue`, `ProjectSettingsModal.vue`, `ProjectRepairModal.vue` — project management.
- `UpdateModal.vue` — auto-update UI.
- `AboutModal.vue`, `ProgressModal.vue`, `LoadingOverlay.vue`, `LocationChoiceModal.vue` — misc.
- `ShortcutsBar.vue` — on-screen hotkey reference strip, visible by default.
- `VideoOutputView.vue`, `VideoConfidenceChip.vue` — the `?videoOutput=1` render surface and its 1 fps confidence thumbnail in the header.

Style: Composition API + `<script setup lang="ts">`, scoped SCSS, CSS variables for theming (see [Theming](#theming)).

---

## Localisation (21 languages, RTL)

DonWells Cue ships with [`locales/*.json`](locales/) — one file per language. Currently shipped: **en, ar, bn, de, el, es, fa, fr, hi, it, ja, ko, no, pt, ro, ru, sq, sv, tr, ur, zh**. Arabic, Farsi and Urdu use RTL layout.

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

The chosen locale is stored in `localStorage` under `liveplay-locale` and stays synchronized between Settings → **User Interface** and the Electron menu.

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

The updater wiring remains in place, but production checks are currently disabled by `DWCUE_UPDATES_CONFIGURED` in `electron/main.js` because no DonWells Cue release feed exists yet. This prevents the app from installing incompatible upstream builds.

When the branded repository is ready, configure its electron-builder publish provider and enable that flag. `UpdateModal.vue` and the check/download/install IPC handlers then provide the existing update flow. The `latest.yml` / `latest-mac.yml` / `latest-linux.yml` metadata files must be attached to each release; the [release workflow](../.github/workflows/build-release.yml) already uploads them.

Update IPC: `check-for-updates`, `download-update`, `install-update`, `get-app-version` (see [The renderer ↔ Electron-main split](#the-renderer--electron-main-split)).

---

## Packaging

The `build` block in [`package.json`](package.json) drives `electron-builder`:

- `appId`: `com.donwells.cue`
- `productName`: `DonWells Cue`
- `files`: includes `.output/`, `electron/`, `assets/`, `locales/`. Locales must be listed explicitly or they don't ship.
- `extraResources`: copies the C++ server binary into `resources/server-bin/`.
- `asarUnpack`: the ffmpeg/ffprobe installers can't run from inside an asar, so they're unpacked.
- `fileAssociations`: registers the `.liveplay` extension.

To build locally:

```sh
npm run build:electron -- --mac --arm64  # Apple Silicon
npm run build:electron -- --mac --x64    # Intel
npm run electron:build -- --win --x64    # explicit platform/arch flags
```

The macOS architecture flag must match the native `dwcue-server` built in
`server/build`; the root `npm run build` command selects the host architecture
automatically. The release workflow builds and validates arm64 and x64 in
separate jobs.

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
