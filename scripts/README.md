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

[`repair-generated-auto-gain.js`](repair-generated-auto-gain.js) repairs the generated auto-gain defaults in canonical `.dwcue` documents. Run it on a copy and inspect the resulting show before live use. A `.liveplay` document is an immutable legacy input, not an alternate save extension; import it into a fresh `.dwcue` destination before running maintenance. `.dwcuepack` and `.lpa` files are ZIP archives and are never direct document inputs.

## Operator manual PDF

The show-day guide lives in [`docs/operators-manual.md`](../docs/operators-manual.md), with the generated [`operators-manual.pdf`](../docs/operators-manual.pdf) beside it. The Markdown is the maintained source; update it and regenerate the PDF together after operator-visible changes.

Use Python 3.11 or newer in a virtual environment. Install the pinned rendering dependencies, then build from the repository root:

```sh
python3 -m pip install -r scripts/manual-requirements.txt
python3 scripts/generate-operators-manual.py
```

On Windows, use the virtual environment's Python or `py -3` in place of `python3`. The script resolves its default paths from its own location and also supports `--source PATH --output PATH`; it does not fetch network resources while rendering. It embeds ReportLab's bundled Vera fonts rather than depending on operating-system fonts. Unsupported presentation symbols use explicit readable equivalents (`→` becomes `->`); characters without a supported glyph or known safe equivalent fail the build rather than rendering empty boxes.

The source supports H1/H2/H3 headings, paragraphs, bold/italic/inline code, linked images with captions, lists/checklists, pipe tables, fenced code, blockquote safety notes, internal/external links, `<!-- pagebreak -->`, and the `signal-flow` / `recovery` diagram directives. Unknown directives, broken internal/local links, missing images, and malformed blocks fail the build without replacing the previous PDF.

Screenshots live in [`docs/manual-assets/`](../docs/manual-assets/); [`captures.json`](../docs/manual-assets/captures.json) records their source edition and isolated practice-data provenance. Refresh those screenshots against the actual app when their controls change. Do not include user projects, credentials, or private paths in published illustrations.

After regeneration, inspect the cover, contents, diagrams, screenshots, tables, and checklist pages visually. Also check searchable text, actual font glyph coverage, embedded fonts, outline destinations, and every link annotation. Extractable Unicode can still render as an empty box when a font lacks its glyph; successful compilation or text extraction alone does not prove a readable manual. Source revision and package version are separate: a current-source manual must not imply that unshipped fixes exist in downloaded installers.

---

## Localisation helpers

| Script | What it does |
|--------|--------------|
| [`sync-locale-keys.js`](sync-locale-keys.js) | Walks every JSON file in `client/locales/` and copies any keys missing relative to `en.json` (the source of truth). Run after adding new strings to `en.json`. Idempotent. |

### One-off localisation migrations (Python)

The four `add_*.py` scripts are migration tools, each written once to bulk-add a specific set of translation keys to every locale. They are kept in tree as documentation of past locale changes and to make follow-up fixes easier, but they are **not part of the regular workflow** — use `sync-locale-keys.js` and edit JSON files directly instead.

| Script | Purpose (historical) |
|--------|----------------------|
| [`add_all_missing_locales.py`](add_all_missing_locales.py) | Bulk-add of about/license + miscellaneous missing keys across every locale. |
| [`add_dual_dialog_locales.py`](add_dual_dialog_locales.py) | Added `exportProject`, `importProject`, `importAudio` sections + `exportProgress.downloading` + `common.cancel` for the dual-dialog import/export flow. |
| [`add_missing_locales.py`](add_missing_locales.py) | Added local-server / network-discovery strings (e.g. `startingLocalServer`, `serversOnThisNetwork`). |
| [`add_repair_locales.py`](add_repair_locales.py) | Added the project-repair flow strings. |

If you need to bulk-add new keys across all locales again, prefer writing a one-shot script in this same style rather than editing 21 files by hand. Keep it idempotent (re-runnable) and run `sync-locale-keys.js` afterwards to be sure.

---

## Conventions

- **Working directory**: every script resolves paths from `path.resolve(__dirname, '..')` and is safe to invoke from anywhere — never `cd` first.
- **Cross-platform**: avoid shell-specific syntax. Use `spawnSync({ shell: process.platform === 'win32' })` only when calling `npm`/`npx` on Windows.
- **Idempotent**: scripts should be safe to re-run. `ensure-server.js`, `build-server.js`, and `sync-locale-keys.js` all follow this.
- **Failure exits with non-zero**: any non-zero status from a child process should propagate up via `process.exit(res.status ?? 1)`.
- **Print, don't decorate**: stdio is forwarded to the user / CI log. Add a short `[script-name]` prefix on summary lines; don't add ANSI colour (CI logs choke on it).
