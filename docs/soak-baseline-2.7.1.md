# Soak baseline: DonWells Cue 2.7.1 on macOS

The released 2.7.1 app, as downloaded, measured on 18–19 November 2026. Every
later change is compared against these numbers. The test is
`scripts/soak/run-soak.cjs` (see the README). The raw results stay in
`soak-results/` and are not committed.

## How it ran

- The packaged app on an Apple Silicon MacBook Pro. Its windows were kept off
  screen and all sound went to the silent output "Pro Tools Audio Bridge 2-A"
  (chosen in Settings). All test media is 20–35 Hz tones.
- **Soak:** 4 hours (23:40 to 03:41), seed 1, 844 actions:

  | Action | Count |
  |---|---|
  | GO | 493 |
  | QuickPlay | 165 |
  | Stop All | 66 |
  | Properties | 46 |
  | Up Next | 33 |
  | Show Mode | 21 |
  | Video Output closed and reopened | 20 |

  The show mixes WAV, FLAC, MP3, M4A, 24-bit and 96 kHz audio, chains, loops,
  and 720p, 1080p and HEVC video.
- **Bench:** 5 cold starts, and 3 opens of a 300-cue show.

## Result

**No failures in four hours.**

- Every action did what it should.
- The screen agreed with the engine at all 962 checks.
- No process died, no system dialog appeared, and neither output dropped
  out once.

## Speed

| Measure | Result |
|---|---|
| Window shown after launch | 177–180 ms |
| Engine ready after launch | 470–550 ms |
| 300-cue show: rows on screen | 102 ms (first open: 296 ms) |
| 300-cue show: fully loaded | 200 ms (first open: 300 ms) |
| 300-cue show: engine settled | 2.3 s (**first open: 67.5 s**) |
| GO to sound starting (349 timed) | median 1.3 ms, 95% within 4.5 ms, worst 49 ms |

The 67.5 s on first open is engine background work: the show is usable within
0.3 s, but the engine stays busy for over a minute. Later opens of the same show
settle in 2.3 s. This needs a look: it is time when the computer works harder
than it needs to, right when a show starts.

## Audio

| Output | Underruns | Dropouts | Clock corrections at limit |
|---|---|---|---|
| Pro Tools Audio Bridge 2-A (chosen) | 0 | 0 | 0 |
| MacBook Pro Speakers (system default) | 0 | 0 | 0 |

- **An extra output stream.** The system default stayed open and running all
  four hours although nothing was chosen to play there. That is the extra
  stream the one-audio-path change removes (branch
  `refactor/program-through-main`).
- **One read-ahead miss.** A cue's decoder briefly fell behind once, at about
  3 h 52 min. It came during a quick run of a looping QuickPlay bed, two GOs
  on a loop cue 8 s apart, then Stop All. The output itself never starved. To
  be looked into.

## Video

- 34 pictures, 26,618 frames.
- 553 frames dropped, a steady 2–4% on every picture. The drops are not tied
  to any action, and Video Output reopening had no effect.
- The output window was off screen for this test, so these drops may not
  happen on a real display. Check again with the output on a second or
  virtual display before treating this as a fault.

## Memory over four hours

| Process | Start | End | Peak |
|---|---|---|---|
| Engine | 104 MB | 96 MB | 126 MB |
| App main process | 297 MB | 266 MB | 329 MB |
| Main window | 280 MB | 302 MB | 345 MB |
| Video Output window | 139 MB | 162 MB | 170 MB |
| GPU | 133 MB | 149 MB | 150 MB |

The main window's page did not grow:

| Page measure | Start | End |
|---|---|---|
| Memory after cleanup | 11.5 MB | 12.2 MB |
| Screen elements | 2,889 | 2,446 |
| Event listeners | 772 | 563 |

There is no leak in the app's own data. The main window's slow rise (about
11 MB an hour) is outside the page's data, which stayed flat; what Chromium
keeps there is not measured yet.

## Processor (share of one core)

| Process | Average | 95% of the time under | Worst |
|---|---|---|---|
| Engine | 5.1% | 6.2% | 6.6% |
| Main window | 25.8% | 42.1% | 48.1% |
| GPU | 10.4% | 18.5% | 24.1% |
| Video Output window | 0.8% | 2.4% | 5.0% |
| App main process | 0.8% | 1.3% | 9.0% |

The main window uses about a quarter of a core even while off screen. This is
the clearest place to make the app lighter.

The level meters arrive 30 times a second. In 31 of 962 fifteen-second
windows, one gap was longer than 80 ms; the worst was 110 ms.

## Errors seen

1. **MIDI refused.** At launch the page logged "Permission to use Web MIDI
   API was not granted". MIDI controllers do not work in 2.7.1. The fix is on
   branch `fix/midi-permission`, still to be confirmed in a packaged app.
2. **Hourly update check fails.** Exactly one hour in, the page failed to
   fetch Nuxt's build manifest (`_nuxt/builds/meta/….json`) and threw an
   unhandled error. This is Nuxt's built-in "new version deployed" check,
   which has no use in a packaged app. It is harmless, but it is an error on
   the screen's side during a show, and it can be switched off.
3. **Engine startup warning.** The engine logged "No audio output devices
   reported at startup" once, before its device list was ready. This is
   misleading, not a fault.

## To follow up

- The 67 s of engine background work on a show's first open.
- The main window's processor use.
- Switch off Nuxt's hourly build check in the packaged app.
- The read-ahead miss on fast loop restarts.
- Video drops, measured on a real display.
