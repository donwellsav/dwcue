# DonWells Cue scripts

Cross-platform helper scripts used by the monorepo `package.json` and by CI. Every script here is invoked from the **repository root**, not from this directory — paths inside the scripts are resolved relative to the repo root.

Node scripts use CommonJS (`require`) and target Node 20 LTS. Python scripts target Python 3 and reconfigure stdout to UTF-8 so they work on Windows.

---

## Build pipeline (Node)

These are the scripts wired into `npm run …` commands at the root. They are the supported entry points; CI calls them directly.

| Script | Invoked by | What it does |
|--------|-----------|--------------|
| [`build-all.js`](build-all.js)               | `npm run build`              | Unified release build: builds the C++ server, runs `nuxt generate` + `electron-builder`, and copies the installer artefacts (`.exe`, `.dmg`, `.zip`, `.AppImage`, `.deb`, `.rpm`) into `/build/` at the repo root. |
| [`build-clean.js`](build-clean.js)           | `npm run build:clean`        | Wipes build outputs, then delegates to `build-all.js`. Deliberately **preserves** `server/build/vcpkg_installed/` so the (slow) compiled C++ dependencies are not re-downloaded. |
| [`build-server.js`](build-server.js)         | `npm run server:build` / CI  | Configures (idempotently) and builds the C++ server using the appropriate CMake preset (`vs2022` on Windows, `default` elsewhere). On macOS, `DWCUE_MAC_ARCH=arm64|x64` selects the matching native server and vcpkg triplet. |
| [`build-server-app-mac.js`](build-server-app-mac.js) | Manual (macOS only) | Wraps `dwcue-server` as the standalone **DonWells Cue Server** development helper app. Release DMGs use the server embedded in DonWells Cue so every executable is covered by the main packaging and ad-hoc signing flow. |
| [`ensure-server.js`](ensure-server.js)       | `npm run dev` | Pre-flight check before launching the desktop client. If the server binary is already built, this is a no-op; otherwise it triggers configure + build. Electron then owns its managed backend lifecycle. `npm run dev:client` skips this pre-flight check. |
| [`run-server.js`](run-server.js)             | `npm run server:run`          | Explicit server-only launcher. Locates the compiled `dwcue-server[.exe]` in single- or multi-config CMake output, then execs it with forwarded stdio and CLI arguments. |
| [`smoke-packaged-app-mac.js`](smoke-packaged-app-mac.js) | `npm run check:packaged:mac [-- --arch arm64|x64]` | Verifies the matching packaged macOS app starts, checks its one main window when macOS UI scripting is available, then quits and cleans up. |

Use `npm run dev` for the normal desktop loop with server-build pre-flight, or `npm run dev:client` when the backend is already built. Start `npm run server:run` separately only for server-only work or a renderer-only `npm run dev:nuxt --workspace=client` session; do not put a foreground server beside Electron's managed backend.

### Versioning

| Script | Invoked by | What it does |
|--------|-----------|--------------|
| [`version.js`](version.js) | `npm run version -- 2.1.4` (set) or `npm run bump -- patch|minor|major` (bump) | Updates the version across the app: `package.json`, `client/package.json`, and `server/vcpkg.json` (`version-string`). The standalone website keeps its own public version snapshot. |

Bumping the version on `main` is what triggers the [release workflow](../.github/workflows/build-release.yml).

### Show-document maintenance

The [`repair-generated-auto-gain.js`](repair-generated-auto-gain.js) helper repairs the generated auto-gain defaults in canonical `.dwcue` documents. Run it on a copy and inspect the resulting show before live use. A `.liveplay` document is an immutable legacy input, not an alternate save extension; import it into a fresh `.dwcue` destination before running maintenance. `.dwcuepack` and `.lpa` files are ZIP archives and are never direct document inputs; current native import requires exactly one root `.dwcue`, and legacy import exactly one root `.liveplay`.

## Operator manual PDF

The show-day guide lives in [`docs/operators-manual.md`](../docs/operators-manual.md), with the generated [`operators-manual.pdf`](../docs/operators-manual.pdf) beside it. The Markdown is the maintained source; update it and regenerate the PDF together after operator-visible changes.

Use Python 3.11 or newer in a virtual environment. Install the pinned rendering dependencies, then build from the repository root:

```sh
python3 -m pip install -r scripts/manual-requirements.txt
python3 scripts/generate-operators-manual.py
```

Run the focused link-parser regressions with `python3 scripts/test_generate_operators_manual.py` in the same environment. These cover balanced and escaped URL parentheses, angle-bracket destinations, malformed targets, and preserved inline formatting; they do not replace the PDF checks below.

On Windows, use the virtual environment's Python or `py -3` in place of `python3`. The script resolves its default paths from its own location and also supports `--source PATH --output PATH`; it does not fetch network resources while rendering. It embeds ReportLab's bundled Vera fonts rather than depending on operating-system fonts. Unsupported presentation symbols use explicit readable equivalents (`→` becomes `->`); characters without a supported glyph or known safe equivalent fail the build rather than rendering empty boxes.

The source supports H1/H2/H3 headings, paragraphs, bold/italic/inline code, linked images with captions, lists/checklists, pipe tables, fenced code, blockquote safety notes, internal/external links, `<!-- pagebreak -->`, and six diagram directives: `signal-flow`, `recovery`, `gain-stages`, `duck-envelope`, `cue-lifecycle`, and `save-recovery`. Unknown directives, broken internal/local links, missing images, and malformed blocks fail the build without replacing the previous PDF. Landscape images fit within 105 mm height; portrait control panels may use up to 165 mm so their labels remain readable.

Screenshots and attributed equipment photographs live in [`docs/manual-assets/`](../docs/manual-assets/). [`captures.json`](../docs/manual-assets/captures.json) records the current source revision, capture conditions, dimensions and SHA-256 of every interface image, plus photo authors, licences and source links. Refresh screenshots whenever the pictured controls, layout or state presentation change. For a behavior-only repair, existing captures may remain when template/style/assets compatibility is verified and recorded; retain their actual source revisions, dates and hashes. Prefer a useful overview plus readable detail views, identify any added callouts or rearranged close-ups, and distinguish schematic charts from measured results. Photographs illustrate physical setup; they do not certify pictured hardware. Do not include user projects, credentials, or private paths in published illustrations.

After regeneration, inspect the cover, contents, diagrams, screenshots, tables, and checklist pages visually. Also check searchable text, actual font glyph coverage, embedded fonts, outline destinations, and every link annotation. Extractable Unicode can still render as an empty box when a font lacks its glyph; successful compilation or text extraction alone does not prove a readable manual. Source revision and package version are separate: a current-source manual must not imply that unshipped fixes exist in downloaded installers.

---

## Localisation helpers

| Script | What it does |
|--------|--------------|
| [`sync-locale-keys.js`](sync-locale-keys.js) | Walks every JSON file in `client/locales/` and copies any keys missing relative to `en.json` (the source of truth). Run after adding new strings to `en.json`. Idempotent. |

### Checking that Show Mode only removes controls

`npm run test:mode-layout` opens the packaged app (build it first with `npm run build`) on a throwaway show, measures every visible element in Edit Mode and in Show Mode at three window sizes, and fails if anything moves or changes size. It also checks that a cue stays on one line and that ten QuickPlays fit beside the playlist. It plays nothing and takes a few seconds. Run it before a release; it needs a desktop session, so it is not part of `check:client`.

### The icon font

`python3 scripts/subset-icon-font.py` rebuilds the small icon font from the full Material Symbols font in `node_modules` (needs `fonttools` and `brotli`). Run it after using an icon the app has not used before; `check:client` fails until the font holds every icon the source names.

### Adding strings to every language

Add the string to `client/locales/en.json`, run `sync-locale-keys.js` to copy it into the other languages as an English placeholder, then translate. The one-off Python scripts that once bulk-added keys were removed; they are in the git history if one is needed as a model.

---

## Soak test and benchmarks (macOS)

[`soak/run-soak.cjs`](soak/run-soak.cjs) runs the packaged app for hours as an operator would, with nothing shown on screen and nothing audible, and records what the engine, the app and macOS report. Use it to get a baseline before a change to playback, routing or the interface, and again after it.

Build the packaged app first (`npm run server:build`, then in `client/`: `npx cross-env NODE_ENV=production nuxt generate && npx electron-builder --dir`). The run needs `ffmpeg` on the PATH and one output device that makes no sound in the room, such as a virtual audio device. Name it with `--output`; the run refuses the system default output and stops at once if sound ever reaches it.

```sh
node scripts/soak/run-soak.cjs soak  --output "<silent output>" --minutes 240
node scripts/soak/run-soak.cjs bench --output "<silent output>"
node scripts/soak/run-soak.cjs summarize --results soak-results/<run>
```

- **`soak`** opens a generated show (24 cues in WAV, FLAC, MP3, M4A and four videos, plus six QuickPlays) and presses GO, QuickPlays, Stop All, Up Next, Properties, Show Mode and Video Output in a seeded random order, by button and by key. After each press it checks that the engine did it and that the screen shows it. `--seed` repeats the same order.
- **`bench`** times app start (first launch apart, then warm launches) and opening a large show (`--cues`, 300 by default): until the playlist appears, until the engine has every cue loaded, and until the engine goes idle.
- Results land in `soak-results/<run>/` (not in git): `summary.json`, and the raw `samples.jsonl` (every 15 seconds), `steps.jsonl`, `events.jsonl` and `engine.log`.

What the summary reports, and what it cannot:

- **Failures**: a press the engine did not carry out, a state the screen did not show, the screen disagreeing with the engine, an error on the page, a native dialog, a process that died.
- **GO start**: the time from the press to the engine reporting the cue as playing. The sound then waits in the engine's output buffer (`ringFrames`, at 48 kHz) and in the device's own buffer; that part is reported, not measured at a speaker.
- **Audio**: dropouts (`underruns`), device losses and recoveries per open output, decoder starvation (`readAheadUnderruns`), and how regularly the engine's meter broadcast arrives.
- **Memory and CPU** per process, with a per-hour trend after the first tenth of the run. The page's heap is read after a forced collection every five minutes.
- Because no window is drawn to a display, the drawing cost of the windows and the video frame counts understate a real show. All sound in the generated show is a tone between 20 and 35 Hz at about -24 dBFS, which a laptop's speakers cannot reproduce.

The app is hidden by starting it paused under the Node inspector and replacing the window `show` calls before its first line runs; that is macOS-only as written.

## Conventions

- **Working directory**: every script resolves paths from `path.resolve(__dirname, '..')` and is safe to invoke from anywhere — never `cd` first.
- **Cross-platform**: avoid shell-specific syntax. Use `spawnSync({ shell: process.platform === 'win32' })` only when calling `npm`/`npx` on Windows.
- **Idempotent**: scripts should be safe to re-run. `ensure-server.js`, `build-server.js`, and `sync-locale-keys.js` all follow this.
- **Failure exits with non-zero**: any non-zero status from a child process should propagate up via `process.exit(res.status ?? 1)`.
- **Print, don't decorate**: stdio is forwarded to the user / CI log. Add a short `[script-name]` prefix on summary lines; don't add ANSI colour (CI logs choke on it).
