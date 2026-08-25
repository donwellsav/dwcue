# DonWells Cue

**DonWells Cue is a free, open-source app for playing back audio in live shows.** If you run sound for theatre, conferences, houses of worship, AV installs, or any live event, DonWells Cue lets you line up your music, sound effects and stings ahead of time and fire them off reliably on the night — from a laptop, a touchscreen, or even a separate stage-side machine you control over the network.

You build a **show** as a list of cues plus a grid of one-touch buttons, then trigger them with a click, a tap, a keyboard shortcut, or a MIDI controller. DonWells Cue handles the fades, the transitions between tracks, and keeps a close eye on your levels so nothing clips or distorts.

This is the active DonWells Cue repository. Build targets are configured for **Windows x64, macOS Intel (x64), macOS Apple Silicon (arm64), and Linux x64**. The current source version is **v2.6.6**. macOS packages are Developer ID signed, notarized, and package-validated.

> **Current source version:** v2.6.6. Check the [release page](https://github.com/donwellsav/dwcue/releases) for the latest published installers. Local builds are still useful when you need to validate a change before distributing it.

![DonWells Cue 2.6.6 showing the playlist, permanent One Shots grid, and output metering](client/public/screenshots/donwells_cue_main.jpg)

The screenshots in this README come from the current app UI. Refresh these canonical images when the top-level playback UI changes. The standalone website keeps its own copied screenshot set.

---

## What you can do with it

- **🎵 Build a cue list** — arrange audio into a playlist with nested groups. Set volume, In/Out points, fades, ducking, and what happens when a cue finishes: stop, play next, loop, or jump to another cue.
- **⚡ Fire One Shots** — a permanent, configurable grid of one-touch cells for stings, SFX, announcements, walk-on music and beds. Drag a local file or a playlist cue into a cell to copy it without changing the source list; the panel can detach into its own window.
- **🔎 Prepare cues precisely** — Properties provides a detailed peak/RMS waveform, separate program and Preview playheads, click-to-seek, editable In/Out and Start Next markers, transport controls, Trim Silence, and loudness or true-peak normalization.
- **🎧 Preview safely** — assign a monitor output and audition a cue away from the program bus. The lower Preview panel supports transport, seeking, quick Set In/Out, saving trim, Start Next markers, and Set As Next.
- **📺 Show Mode** — switch to a simplified, touch-friendly playback view for the actual performance. Preview remains available as the lighter-weight way to inspect and prepare a cue during a show.
- **⏭ Smooth transitions** — automatic advance, crossfades, and radio-style "Start Next" segue markers with an on-screen countdown for seamless back-to-back playback.
- **🔊 Sounds great, stays safe** — pick an **Output Target** for your show (Broadcast / EBU R128, Streaming, Radio, Netflix / OTT, or Live console), normalize cues to a chosen loudness or true-peak value, and use the adjustable true-peak limiter to control intersample peaks.
- **📊 See your levels** — real-time metering at every stage (per-cue, per-channel and master), shown in LUFS, dBFS, true-peak or RMS.
- **🎚 Route anywhere** — send audio to multiple outputs at once (front-of-house, monitors, comms, a record bus…) across one or more sound cards.
- **🎬 Timecode** — send SMPTE LTC timecode from a cue to keep lighting, video or other systems in sync.
- **🎞 Play video cues** — H.264/HEVC media shows a picture on a dedicated fullscreen output (projector, LED wall, confidence monitor) while the audio plays through the normal engine path and mixer.
- **📥 Bring in audio easily** — drag and drop local files, import several at once, download from YouTube, or review and import selected Spotify tracks into a project folder.
- **🎹 Trigger it your way** — click, tap, keyboard hotkeys, MIDI controllers, or automation over the network (HTTP / WebSocket).
- **🌍 Speak your language** — available in **21 languages**, including full right-to-left support.
- **🖥 Run it remotely** — operate a stage-side machine wired to your sound gear from a separate show laptop over the local network, with automatic discovery so you don't have to type in IP addresses. (v1 keeps the app same-machine only by default: the remote-server options are hidden until you enable **Show network/server options** in Server Settings or on the welcome screen.)

---

## Video output

Video cues are ordinary audio cues whose media file also carries a picture (H.264 or HEVC — ProRes and other production codecs are not supported yet). The audio track plays through the normal engine, mixer, fades and metering; the picture renders in a separate **Video Output** window designed to sit fullscreen on the machine's video output (HDMI → switcher → projector). Cues with video show a 🎬 badge in the playlist.

- **Enable it** from the View menu → **Video Output**. The window opens on the configured display and paints black until content plays. Display assignment is a machine-level setting (stored outside the project file), so the same show file adapts to whatever screen each venue machine has.
- **Idle layers** — when no video cue is playing the output shows, in priority order: the cue's own **image** (set in Properties for audio-only cues), otherwise the project's **standby image** (Project Settings), otherwise black.
- **In sync with audio** — the picture chases the engine's playhead: cuts are frame-accurate to the audio, pauses freeze the frame, and drift is corrected inaudibly (tiny playback-rate nudges, re-anchoring only if drift ever exceeds ~80 ms).
- **Silent videos** — a video file with no audio track still plays: the engine runs a silent transport of the container's duration so the cue advances, auto-follows and reports progress exactly like an audible cue.

---

## Download and install

Download the latest installer from the [release page](https://github.com/donwellsav/dwcue/releases). The release workflow produces:

| Platform | What to download |
|----------|------------------|
| **Windows** | `DonWells-Cue-Setup-x.y.z.exe` (installer, 64-bit) |
| **macOS — Apple Silicon** (M1/M2/M3 and newer) | `DonWells-Cue-x.y.z-arm64.dmg` or `.zip` |
| **macOS — Intel** (x86_64 Macs supported by macOS 13.3+) | `DonWells-Cue-x.y.z-x64.dmg` or `.zip` |
| **Linux** | `DonWells-Cue-x.y.z.AppImage`, `.deb`, or `.rpm` |

The macOS release is native per architecture: the `arm64` package is for Apple Silicon and the `x64` package is for Intel. Both bundle a matching native `dwcue-server`; neither package relies on Rosetta or a machine-local server.

Each desktop package bundles the Electron client and `dwcue-server`, so a normal single-machine build launches its own local server without manual network setup.

### Install with one command (macOS)

```sh
curl -fsSL https://dwcue.com/install.sh | bash
```

The script detects Apple Silicon vs Intel, downloads the latest release, installs into `/Applications` (or `~/Applications` without admin rights), and opens the app. It is the same mechanism rustup, Deno, and Homebrew's own installer use. Re-run it to update to the latest release.

### Install with Homebrew (macOS)

Apple Silicon and Intel Macs can also install from the project's Homebrew tap:

```sh
brew install donwellsav/tap/donwells-cue
```

This installs the same DMG published on the release page (matching your Mac's architecture), and `brew upgrade` picks up new versions (the tap's cask is regenerated by the release workflow).

### First launch on macOS

macOS artifacts are signed with a Developer ID certificate and notarized by Apple (see [SIGNING.md](SIGNING.md)), so Gatekeeper approves the app on first launch — download the DMG, drag **DonWells Cue** to Applications, and open it. No warning, no extra steps.

### First launch on Windows ("Windows protected your PC")

No public Windows artifact is currently claimed as Authenticode signed. If you distribute an unsigned local build, Windows may show a blue **"Windows protected your PC"** dialog the first time it runs. See [SIGNING.md](SIGNING.md) for the repository's signing configuration.

To run it:

1. Click **More info** on the warning dialog.
2. Click the **Run anyway** button that appears, then continue the installation normally.

If your browser blocked the download instead, choose **Keep** to save the installer first.

---

## Getting started

1. Install the [latest release](https://github.com/donwellsav/dwcue/releases/latest), or build DonWells Cue from source, and launch it.
2. Choose **New Project** and pick a folder — DonWells Cue creates the project file and a `media/` sub-folder there.
3. In **Project Settings**, choose the program output, Output Target, and—if you need private auditioning—the Preview output.
4. Drop audio files onto the playlist, use **Import Audio**, or open the YouTube or Spotify importer.
5. Open a cue's **Properties** to set markers, fades, normalization, volume, ducking, routing, and start/end behaviour.
6. Drag frequently used playlist cues into One Shot cells for one-touch playback. The copy leaves the playlist cue unchanged.
7. Audition on the Preview output, set the intended next cue, and verify the program and monitor meters.
8. Switch on **Show Mode** for the live performance.

**Running on a separate machine?** Start the stage-side server with `dwcue-server --bind 0.0.0.0`. It prints a one-time access token unless `LIVEPLAY_ACCESS_TOKEN` already supplies one. On the control laptop, open **Server Settings**, choose the discovered server or enter `http://<server-host>:4480`, and enter that token. See [Network ports](#network-ports) below for firewall details.

---

## For developers

Everything below is for people who want to build DonWells Cue from source, contribute, or understand how it works under the hood. Public installers are attached to [GitHub Releases](https://github.com/donwellsav/dwcue/releases).

### How it's built

DonWells Cue uses a **decoupled client/server architecture**: a headless C++ audio engine (`dwcue-server`) handles all sound, while a cross-platform Electron desktop app drives it as a remote control. No audio ever plays in the desktop UI — it sends commands to the server and receives meters and state back.

Made with some help from Claude Sonnet 4.5, Claude Sonnet 4.6 and Claude Opus 4.8.

### Architecture in one diagram

```
+--------------------------------+   WebSocket (ws://host:4480/ws)   +-----------------------------------+
|  client/                       | <----- meters @ ~60 Hz ---------> |  server/  (dwcue-server)          |
|  Electron + Nuxt 4 + Vue 3     | <----- transport / route cmds --- |  C++20, miniaudio, Crow, TagLib   |
|                                |        REST  (http://host:4480)   |                                   |
|  - Playlist / One Shots / routing UI| <----- list / load / waveform --> |  - AudioEngine (mixer + limiter)  |
|  - WaveformCanvas              |                                   |  - ProjectState (.liveplay I/O)   |
|  - LiveMeterBar                |                                   |  - ControlServer (REST + WS)      |
|                                |                                   |  - Metadata + waveform services   |
|  No audio plays in the         |                                   |                                   |
|  renderer process.             |                                   |  Win → WASAPI · Mac → CoreAudio   |
|                                |                                   |  Linux → ALSA / PulseAudio        |
+--------------------------------+                                   +-----------------------------------+
```

Client and server can run on **the same machine** (the desktop installer bundles both, and the client spawns the server as a child process on `127.0.0.1:4480`) or on **different machines** on a LAN — e.g. the show laptop driving a stage-side mini-PC that's wired to the actual sound interfaces.

For the deep architectural docs (mixer tiers, routing matrix, LTC, limiter, metering, network event lifecycle, project-file backwards compatibility), see [`server/README.md`](server/README.md).

### Network ports

A single-machine install talks to itself over `127.0.0.1` and needs nothing opened. When the client and server run on **different machines** on a LAN, make sure these ports are reachable through any firewalls in between:

| Port | Protocol | Used for |
|------|----------|----------|
| `4480` | TCP | Control surface — REST API + WebSocket (transport, project data, routing, live meters). |
| `4481` | UDP | LAN auto-discovery beacon (broadcast + multicast group `239.255.69.80`). Lets clients find servers without typing an IP. |

DonWells Cue does not open firewall ports automatically. If you deliberately run a remote server, allow `dwcue-server` on your trusted LAN for the ports above. The default local server remains bound to `127.0.0.1` and does not need a firewall exception.

## Repository layout

```
dwcue/
├── client/         Electron + Nuxt 4 + Vue 3 desktop UI — see client/README.md
├── server/         C++20 audio engine + REST/WS control server — see server/README.md
├── scripts/        Cross-platform build orchestrator scripts — see scripts/README.md
├── build/          Collected installer artefacts after `npm run build`
├── .github/workflows/
│   ├── build-release.yml   Cuts releases on version bumps to package.json
│   └── build-server.yml    Standalone server matrix build (Win / macOS / Linux)
├── package.json    Monorepo root — orchestrator scripts only
├── LICENCE.txt     AGPL-3.0-only
└── README.md       This file
```

Each sub-package has its own README with developer documentation tailored to that area.

---

## Building from source

### Prerequisites

All platforms need:

| Tool | Minimum | Notes |
|------|---------|-------|
| Git  | any     | |
| Node.js | 20 LTS | for the client + orchestrator scripts |
| CMake | 3.21   | for the server |
| C++20 toolchain | — | MSVC 2022 / Clang 15+ / GCC 12+ |
| [vcpkg](https://github.com/microsoft/vcpkg) | recent | `VCPKG_ROOT` env var must point at your checkout |
| Ninja | latest | strongly recommended (`brew install ninja`, `choco install ninja`, `apt install ninja-build`) |

Set the `VCPKG_ROOT` environment variable:

```pwsh
# Windows (PowerShell, persistent)
[Environment]::SetEnvironmentVariable("VCPKG_ROOT", "C:\dev\vcpkg", "User")
```

```sh
# macOS / Linux
export VCPKG_ROOT="$HOME/dev/vcpkg"
echo 'export VCPKG_ROOT="$HOME/dev/vcpkg"' >> ~/.zshrc
```

Then from a clean checkout:

```sh
git clone https://github.com/donwellsav/dwcue.git
cd dwcue
npm install                # installs client deps via npm workspaces
npm run build              # builds server + client and collects installers into /build
```

`npm run build` runs the unified pipeline in [scripts/build-all.js](scripts/build-all.js):

1. Configures and builds the C++ server through CMake/vcpkg.
2. Runs `nuxt generate` and `electron-builder` in `client/`; the server binary is bundled inside the packaged desktop app.
3. Copies the installer artefacts (`.exe`, `.dmg`, `.AppImage`, `.deb`, `.rpm`) into `build/`.

Use `npm run build:clean` to wipe previous build outputs first (it preserves `vcpkg_installed/` so C++ deps don't get re-downloaded).

#### Platform-specific notes

##### Windows

- Install **Visual Studio 2022** with the *Desktop development with C++* workload (includes MSVC + Windows SDK).
- Install Node.js 20 LTS, CMake (≥ 3.21) and Ninja (e.g. `choco install nodejs cmake ninja`).
- Clone and bootstrap vcpkg:
  ```pwsh
  git clone https://github.com/microsoft/vcpkg C:\dev\vcpkg
  C:\dev\vcpkg\bootstrap-vcpkg.bat
  ```
- Set `VCPKG_ROOT` (see above), open a fresh PowerShell, `npm install`, then `npm run build`.
- Output: `client/dist-electron/DonWells-Cue-Setup-<version>.exe` (NSIS installer, x64), copied to `build/` by the root build.

##### macOS

- Install Xcode Command Line Tools (`xcode-select --install`).
- Install Homebrew deps: `brew install node cmake ninja nasm pkg-config`.
- Bootstrap vcpkg:
  ```sh
  git clone https://github.com/microsoft/vcpkg "$HOME/dev/vcpkg"
  "$HOME/dev/vcpkg"/bootstrap-vcpkg.sh
  ```
- Set `VCPKG_ROOT`, then `npm install && npm run build`.
- On an Apple Silicon host, set `DWCUE_MAC_ARCH=x64` to cross-build the Intel package; otherwise the root build selects the host architecture.
- Output on Apple Silicon: `build/DonWells-Cue-<version>-arm64.dmg` (and matching `.zip`). On Intel, the same command produces `...-x64.dmg` and `.zip`; the native server and Electron app are built for the same architecture.
- Developer ID signing and notarization require the credentials described in [SIGNING.md](SIGNING.md). Local packages remain intentionally ad-hoc signed and are not notarized.

##### Linux

- Install build tools and audio dev headers:
  ```sh
  sudo apt update
  sudo apt install -y build-essential cmake ninja-build pkg-config \
                      libasound2-dev libpulse-dev libjack-jackd2-dev libx11-dev
  ```
  (use the equivalent `dnf` / `pacman` packages on Fedora / Arch).
- Install Node.js 20 LTS via your distro or [nvm](https://github.com/nvm-sh/nvm).
- Bootstrap vcpkg as on macOS, set `VCPKG_ROOT`, then `npm install && npm run build`.
- Output: `build/DonWells-Cue-<version>-x86_64.AppImage`, `DonWells-Cue-<version>-amd64.deb`, `DonWells-Cue-<version>-x86_64.rpm`.

---

## Development workflow

From the monorepo root:

```sh
# One-time
npm install                      # installs client deps via npm workspaces
npm run server:configure         # CMake configure for the server (idempotent)

# Iterating on the server only
npm run server:build             # rebuild the C++ server
npm run server:run               # launch the compiled binary (forwards CLI args)

# Iterating on the client only — ensures the server is built first, then runs
# Nuxt + Electron in dev mode against it
npm run dev

# Running both in side-by-side terminals (the server in one pane, client dev in the other)
npm run dev:all
```

The default `npm run dev` calls [scripts/ensure-server.js](scripts/ensure-server.js), which is a no-op if the server binary already exists and otherwise configures + builds it. After that it launches `nuxt dev` + Electron in the `client/` workspace.

Bumping versions across the monorepo:

```sh
npm run bump -- patch        # 2.0.0 → 2.0.1
npm run bump -- minor        # 2.0.0 → 2.1.0
npm run bump -- major        # 2.0.0 → 3.0.0
npm run version -- 2.1.4     # set an explicit version
```

For deeper development notes:

- **Server internals** (mixer tiers, routing, LTC, project-file format, REST/WS surface): [`server/README.md`](server/README.md)
- **Client internals** (composables, IPC, Electron main process, localisation, MIDI/hotkeys): [`client/README.md`](client/README.md)
- **Build/utility scripts**: [`scripts/README.md`](scripts/README.md)
- **Public website**: maintained separately from this app repository.

---

## Releases & GitHub Actions

A release pipeline is configured in [`.github/workflows/build-release.yml`](.github/workflows/build-release.yml). The current source version is **v2.6.6**; the workflow remains the source of truth for future versioned artefacts.

### Triggering a release

1. Bump the version in the root `package.json` (use `npm run bump -- patch|minor|major`, which propagates to `client/package.json`).
2. Commit and push to `main`.
3. The `build-release` workflow detects the version change and runs the platform matrix:
   - **Windows x64** (MSVC, WASAPI)
   - **macOS Apple Silicon arm64** (Clang, CoreAudio, deployment target 13.3)
   - **macOS Intel x64** (Clang, CoreAudio, deployment target 13.3)
   - **Linux x64** (GCC, ALSA + PulseAudio + JACK)
4. Each job builds the C++ server through CMake/vcpkg, then runs the client `electron-builder` step with `extraResources` picking up the freshly compiled server binary.
5. All artefacts are uploaded, then a final `release` job downloads them, auto-generates a changelog from git commits since the last tag, and creates a GitHub Release tagged `v<version>` with every installer attached.

The vcpkg binary cache (`x-gha,readwrite` backend) is reused across runs so compiled C++ dependencies don't have to be re-built from scratch every time.

Manual runs are validation-only by default. They build the full matrix and smoke-test the unpacked Windows app and bundled native server without publishing anything. Enable the `publish_release` input only when the same validated installers should become a GitHub Release.

### Other workflows

- **[`build-server.yml`](.github/workflows/build-server.yml)** — builds the server alone on PRs and pushes that touch `server/**`. Cross-platform matrix; uploads `dwcue-server-<platform>` artefacts for download from the Actions UI. Useful for vetting server-only PRs without running the full release pipeline.

---

## Contributing

Contributions of all sizes are welcome — bug fixes, new features, translations, documentation, screenshots, you name it.

1. **Fork** the repo and `git checkout -b feat/something` off `main`.
2. **Build it locally** following the steps above. For server changes, run `npm run server:build && npm run server:run --verbose`. For client changes, `npm run dev`.
3. **Test your change**. At minimum, run the client typecheck and live-safety assertions. Server changes should also build the server and run the decoder self-test. Opt-in C++ assertion binaries cover control security, metering, limiting, mixing, waveform generation, and audio read-ahead. Still verify the path you touched end-to-end in the running or packaged app.
4. **Open a PR** to `main`. CI must pass (server matrix build on the relevant platforms).

```sh
npm run typecheck --workspace=client
node scripts/check-live-safety.js
npm run server:build
server/build/decoder-check --self-test   # use the platform-appropriate binary path
```

### Style

- **Server** (C++20): atomics for hot params on the audio thread, no exceptions inside the audio callback, RAII everywhere, header-per-class.
- **Client** (TypeScript): Vue 3 Composition API with `<script setup>`. All audio + project state goes through `useLiveplayServer()` — components don't talk to the server directly.
- **Commits**: short, prefer present-tense imperatives ("fix routing-matrix off-by-one"). Changelogs are generated from commit messages, so make them readable.

### Translations

DonWells Cue ships with 21 locale files at [`client/locales/`](client/locales/). To add a new language or fix existing translations:

1. Copy `en.json` to `<lang-code>.json` (e.g. `nl.json`).
2. Update the `_metadata` block (`code`, `name`, `nativeName`, `direction`).
3. Translate the values. Don't change keys; missing keys auto-fall-back to English at runtime.
4. Run `node scripts/sync-locale-keys.js` to ensure your new file has every key `en.json` has.
5. The locale is picked up automatically — no code changes needed.

For right-to-left languages, set `"direction": "rtl"` in `_metadata` and verify the layout in-app.

### Reporting bugs

File issues at [github.com/donwellsav/dwcue/issues](https://github.com/donwellsav/dwcue/issues). Include OS, DonWells Cue version (visible in the About dialog), and a minimal repro.

---

## License

[**AGPL-3.0-only**](LICENCE.txt). Third-party dependencies retain their own licences (miniaudio: public domain / MIT-0; Crow: BSD-3; TagLib: LGPL-2.1+; nlohmann/json: MIT).
