# Handoff: where DonWells Cue stands

Last updated 2026-11-21, right after the 2.8.0 release. Read
[../AGENTS.md](../AGENTS.md) for the owner's rules and the build commands.

## Snapshot

| What | Where |
|---|---|
| Released | **2.8.0**, published 2026-11-21 by release run 44836789461: GitHub release (18 installers) and dwcue.com (version 2.8.0, manual `manual/operators-manual-2.8.0.pdf`) |
| Tag | `v2.8.0` at `dfb3cc7` |
| `main` | `568fbca`, the 2.8.0 merge (`[skip ci]`) |
| `release/2.8.0` | `dfb3cc7`, finished; do not add to it |
| Work branch | `next`, from `main`: start new work here (local only until the owner asks for a push) |
| Website repo | `../dwcue-site`, `main` at `1e70166` |
| Release notes | [release-notes/v2.8.0.md](release-notes/v2.8.0.md): every operator-facing change in 2.8.0 |

Everything below was checked by tests only. **The packaged app has not been
run since the reviews of this release**, so nothing listed here has been seen
in the real app.

## Owner decisions in 2.8.0 (keep them)

- Opening another show while one plays asks first.
- Outputs that reset play on and catch up rather than restarting.
- GO while a loop plays moves on, to where Cue to Continue would go: a target
  kept on the loop's ending, otherwise the next cue. Stopping a loop by hand
  arms the same cue.
- Up Next (and so GO) follows the cue fired last, not the topmost one playing.
- A sound-only cue started over a playing video leaves the video on screen;
  only a cue with a picture (video or cue image) takes the output.
- Export Project copies media linked from outside the show folder into the
  bundle, and the bundled show points at the copies.

Behaviour added in 2.8.0 that tests now pin (change only with good reason):
a start aimed at a cue already on air keeps its pass and automation (a paused
cue resumes; QuickPlay Restart still restarts); a second press while the same
cue is still starting is absorbed; a manual stop of a cue ending in Play Next,
Loop or Go To arms what GO would play; Keep Music Going counts only playlist
cues that are playing or fading in; custom actions inside a crossfade run
until the cue stops; REST transport routes carry the Stop All fence; a crashed
or hung Video Output restarts itself; the engine reports unsaved edits in the
show header; restoring a backup keeps unsaved edits in its undo copy.

## Open work, most useful first

1. **See 2.8.0 in the real app.** Run the packaged or dev app on a second or
   virtual display with a practice show (audio, a video, a still) and walk
   through: GO while a loop plays; a stinger fired over a bed; stopping a Play
   Next cue by hand; GO pressed twice on a slow cue; a sound effect over a
   playing video; a looping video with Cue to Continue; force-closing the Video
   Output page (it should come back by itself); an Out point edited while
   playing (countdowns, end warning); group bars; meters when the engine
   connection drops; reloading the window with unsaved edits, then quitting
   (it should offer to save); Export Project with a linked file.
2. **An unexplained partial cut.** `test_restart_on_slow_output_declicks`
   (`server/tests/audio_output_test.cpp`) renders a restart at a 20 ms output's
   pace. On a development Mac it passes (largest step 0.091). On GitHub's macOS
   runners it measured 0.260 twice, once with render gaps of only 156 ms, well
   inside the jump's 250 ms ramp-out wait, so the wait is not the cause. It now
   runs only with `DWCUE_TIMING_TESTS=1`. Find what produces 0.260 (a
   read-ahead miss during the ramp in after the flush is the first suspect).
3. **A second-opinion review of the 2.8.0 code**: `git diff v2.7.1 v2.8.0 --
   server/src client/app client/electron`. Several review rounds found and
   fixed faults in it; a fresh reader may find more. Report findings with a
   concrete failing sequence before changing code.
4. **Findings left as they are**, each judged rare or by design; any of them
   can be revisited:
   - GO with nothing to start still bumps the playback intent, which cancels
     another cue's start that is still reading its media (deliberate: it also
     supersedes a pending crash recovery, and a test pins that).
   - Moving Main to another output reports success if the device vanishes in
     the milliseconds between opening it and binding it (an error is shown).
   - A settings change sent while another one is still opening a cold output
     can cancel that output change (the operator sees "could not be applied").
   - Level Check's stop timer can stop the same cue if the operator fires it
     for the show within the check's few seconds.
   - A detached QuickPlay import copies its media before the owner window
     accepts the change; a refused change leaves the copy in the media folder.
   - `POST /api/project/items` with an unknown parent group adds the item at
     the top level.
   - Live LTC start time or frame-rate edits apply at the cue's next start,
     not mid-cue.
   - A converted video copy is reused when it is newer than its source, by
     modification time only.
   - A new cue not yet in the output window's document blanks the picture
     until its details arrive.
   - Older: a looping cue's reopen can lose its place; a lock in macOS
     `AtomicSharedPtr`.
5. **A question for the owner, not yet asked:** Normalize writes its gain into
   the cue's Volume, the same field the operator sets by hand, so Replace audio
   keeps the old file's level correction. A replacement that ends up too loud
   shows the row's true-peak warning.
6. **Windows-only code** that the release build compiles and tests but no one
   has run on Windows hardware: the disk flush before a save (with its retry
   when a scanner holds the file), the lowered waveform thread priority, and
   the video conversion's unfinished-file cleanup.
7. **Release workflow housekeeping** (needs the owner's go-ahead, as any
   workflow change does): the actions it uses still target Node 20, which
   GitHub warns is deprecated.

## Things that will catch you out

- The release workflow runs only the engine suites (`ctest`) and client type
  checking on its runners. Network tests and `npm run check:client` run only
  locally, so run them before asking for a release.
- The release runners are slow and uneven. Four 2.8.0 builds failed on timing
  checks that passed locally; run `scripts/check-engine-under-load.sh` first.
- `scripts/check-live-safety.js` and `scripts/check-audio-rt-safety.js` are
  regex checks over the source. When a fix changes code they match, update the
  regex to the new code and keep what it was protecting.
- Network tests need `DWCUE_TEST_SERVER_BINARY` pointing at
  `build/qp-native/dwcue-server` (built with test hooks). Re-run `cmake` after a
  version bump.
- Several engine tests use environment gates to hold an operation on purpose
  (`DWCUE_TEST_LOADER_GATE`, `DWCUE_TEST_CUE_START_GATE`,
  `DWCUE_TEST_MEDIA_READ_GATE`, ...); grep for them in `server/src` before
  changing the code around them.
