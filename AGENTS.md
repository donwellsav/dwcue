# Working on DonWells Cue

DonWells Cue is a live-show audio and video cue player: an Electron + Nuxt/Vue
client (`client/`) and a C++ engine (`server/`: miniaudio, Crow, FFmpeg). The
website lives in a separate repository, `../dwcue-site`.

**Read [docs/HANDOFF.md](docs/HANDOFF.md) first.** It says where the work
stands, what was decided, and what is open.

## Rules from the project owner

These are standing instructions. Follow them as written; do not add rules of
your own. Where something is unclear, ask in one line rather than guess.

- **GitHub Actions are rationed.** Work and test locally. Do not open a pull
  request, push to `main`, run `gh workflow run`, or start any CI without the
  owner's explicit, current go-ahead. Release builds happen once or twice a
  week at most; never spend one on a fix or a check. Pushing a feature branch
  starts nothing and is fine. (A pull request starts the client checks and,
  when `server/` changes, four platform builds; a push to `main` that changes
  `package.json` starts a full release build.)
- **Commit as you work:** one local commit per verified fix, with a message
  that says what was wrong and why the change fixes it.
- **Every fix gets a test that fails on the old code**, where the fault can be
  tested at all. Say so when it cannot.
- **Proportionate verification:** the smallest check that proves the change.
  No long soaks for small fixes.
- **Inherited code rules are assumptions.** Much of the code and many tests
  came from an earlier AI (the "Codex era", before 2026-11-16). A guard or a
  test is not a requirement just because it exists; check where it came from
  and what it protects before keeping or changing it. Rewrite such a test to
  the new behaviour with its intent kept, and say so in the commit.
- **The app recovers by itself.** No "try this" steps or OS-settings advice
  for operators; make the app handle it.
- **UI language:** red means live, green means next, the Stop All button is
  yellow/black striped, and words stay white. Occasional tools (Level Check,
  Pre-show check) belong in Settings, not the toolbar. Show Mode is regular
  mode minus its controls, pixel for pixel. The cue type is "QuickPlay"
  everywhere (never "cart" or "one-shot").
- **Screen tests stay off the main display:** put test windows on a second or
  virtual display.

## Build and test

Engine (from the repo root; needs `VCPKG_ROOT` set, see README.md):

```bash
cmake -S server -B build/qp-native -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
  -DVCPKG_OVERLAY_TRIPLETS="$PWD/server/triplets" -DVCPKG_TARGET_TRIPLET=arm64-osx-dwcue \
  -DLIVEPLAY_BUILD_TESTS=ON
cmake --build build/qp-native
ctest --test-dir build/qp-native          # 14 suites
```

`build/qp-native` is already configured on the owner's Mac; just build it.
`server/build-asan` is an AddressSanitizer build of the same suites.

Network tests need the engine built with test hooks, which `build/qp-native`
is (with the release binary, 18 of them fail):

```bash
DWCUE_TEST_SERVER_BINARY="$PWD/build/qp-native/dwcue-server" npm run test:server-integration
```

Client:

```bash
npm run check:client                      # includes the live-safety and RT-safety source checks
(cd client && npx nuxi typecheck)
```

Operator manual (edit `docs/operators-manual.md`, then rebuild the PDF):

```bash
python3 scripts/generate-operators-manual.py
python3 -m unittest scripts/test_generate_operators_manual.py
node --test client/tests/operatorManual.test.cjs
```

Before any release build, run the engine suites with every core busy. The
release runners (macOS Intel above all) are far slower than a development Mac:

```bash
scripts/check-engine-under-load.sh
```

New tests must wait for a condition, not a fixed time: checks that sleep a
fixed number of milliseconds and then expect something to have happened pass
locally and fail on the runners. In tests that hold an operation and check
that another is not blocked behind it, use `kUnblocked` (2 s).

## Releasing (only with the owner's go-ahead)

1. Version in `package.json` and `client/package.json` (`npm run version`),
   release notes in `docs/release-notes/v<version>.md` (the release body is
   built from that file), manual edition note and PDF updated.
2. Copy `docs/operators-manual.pdf` to
   `../dwcue-site/public/manual/operators-manual-<version>.pdf`, update the size
   and SHA-256 in that repo's README, commit with `[skip ci]`, push its `main`.
3. Push the release branch, then tag it: `git tag v<version> <branch head>` and
   `git push origin refs/tags/v<version>`. The release job checks that the tag
   is at the built commit.
4. `gh workflow run build-release.yml --ref <branch> -f publish_release=true -f website_commit=<dwcue-site commit>`.
   It builds four platforms, publishes the GitHub release and then dwcue.com.
5. After a good release, merge the branch into `main` with `--no-ff` and
   `[skip ci]` in the merge message (a fast-forward would start a build), and
   push that only with its own go-ahead.

The website's credentials exist only as GitHub secrets; dwcue.com is published
by step 4. If `git push` cannot resolve github.com on the owner's Mac, retry;
it comes and goes.
