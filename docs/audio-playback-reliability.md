# Audio import and live playback reliability

**4 November software audit:** repairs through `153a1a7` preserve the show workflow and add responsive storage/Stop All cancellation, coherent replay after interrupted seeks, valid prepared-follow retry, nested project admission and long-position LTC safety. Earlier project/import/level safeguards remain covered. Native 13/13, isolated integration 61/61, client checks/typecheck and continuous decoded-media checks pass; see the [current workplan](superpowers/plans/2026-11-03-live-show-reliability.md). No installed release or new physical acceptance is claimed.

Research and implementation began 2026-11-03 at `8250558`. The initial repairs were committed locally as `2ea5984` and `a9a86a3`; package metadata is 2.6.17. No new installer, installation or publication was performed. The current workplan distinguishes software verification from deferred physical acceptance.

## Level and timing contract

Every new import starts at unity gain with the full source region. Legacy automatic normalization, peak matching, and trimming flags cannot alter the import later when analysis finishes. Original local audio files are unchanged. Existing cue gains and trim points are preserved because they may be intentional edits; importing again is necessary to undo earlier automatic cue adjustments.

Only explicit **LUFS normalization** matches a measurement target. **Reduce peaks** and the playback **limiter** are attenuation-only safety devices. A safe or muted cue stays as it is; raising a peak ceiling never boosts a previously reduced cue. Explicit **Trim Silence** removes digital silence with padding rather than classifying quiet tails as silence.

The limiter engages at its ceiling. Its 0.25 dB internal guard applies only while reducing overs, and its existing 5 ms lookahead remains continuous through bypass or ceiling changes. Final protection occurs once per physical device channel, after all logical buses have been summed and the engine has adapted the device clock. This also makes shared Main/Preview hardware meters show the actual protected sum.

## Research decisions

Primary documentation and production code informed these choices; the regressions test this application's implementation. No DSP implementation was copied from another project.

| Question | Evidence | Decision in this application |
| --- | --- | --- |
| What does a limiter control, and where should it run? | [OBS limiter documentation](https://obsproject.com/kb/limiter-filter) defines a maximum and places limiting last; [ITU-R BS.1770](https://www.itu.int/rec/R-REC-BS.1770/en) covers loudness and true-peak measurement. | Preserve source level; separate normalization from safety reduction. Our signal-path audit additionally found summation and clock adaptation after the old limiter, so move protection after both. |
| How should a follow start inside a render block? | [Ardour's trigger rendering](https://github.com/Ardour/ardour/blob/master/libs/ardour/triggerbox.cc) accounts for frames covered and destination offsets; [JUCE's sample-buffer tutorial](https://juce.com/tutorials/tutorial_looping_audio_sample_buffer/) handles exact boundaries within a block. | Prepare the successor on the control thread, split every cue at the same boundary, and start the prepared target there. Remove the fixed 100 ms early-start workaround. |
| What belongs outside the audio deadline? | [PortAudio callback rules](https://portaudio.com/docs/v19-doxydocs/writing_a_callback.html) exclude allocation, blocking I/O and mutex operations; [Ross Bencina's real-time streaming example](https://github.com/RossBencina/RealTimeFileStreaming) demonstrates background streaming and buffering. | Reuse read-ahead, immutable topology storage and nonblocking revision checks. Prepare routing/decoding off the render thread; execute network actions on a worker. |
| How should a positive cue gain behave? | [JUCE AudioTransportSource](https://docs.juce.com/master/classjuce_1_1AudioTransportSource.html) documents linear gain, including amplification above unity. | Separate inactive ducking from an active absolute ceiling, allowing authored boosts while preserving strongest-owner ducking and release. |
| How can multichannel content reach the stereo selected output? | [miniaudio documentation](https://miniaud.io/docs/manual/index.html) and [source channel maps](https://github.com/mackron/miniaudio/blob/master/miniaudio.h); [FFmpeg rematrix implementation](https://github.com/FFmpeg/FFmpeg/blob/master/libswresample/rematrix.c) provides conventional center/surround mix coefficients. | Reuse actual decoder speaker labels: mono to both outputs, L/R unity, center and side-specific surround/height at −3 dB, LFE/unlabelled at −6 dB. Preserve native PCM and exclude synthetic LTC. These are application playback choices, not a claim of a universal downmix standard. |
| How should a held key behave? | [W3C KeyboardEvent.repeat](https://www.w3.org/TR/uievents/#dom-keyboardevent-repeat) identifies repeat dispatches. | Ignore repeats for transport/One Shot actions; retain arrow-selection repeats. |
| Who should execute an HTTP cue action? | [RFC 9110 idempotency](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2) limits safe automatic retries; [libcurl easy API](https://curl.se/libcurl/c/libcurl-easy.html), [timeouts](https://curl.se/libcurl/c/CURLOPT_TIMEOUT_MS.html), and [TLS verification](https://curl.se/libcurl/c/CURLOPT_SSL_VERIFYPEER.html) supply the transport primitives. | One server worker per process, bounded FIFO, deadlines, cancellation and verified HTTPS. Client messages carry results only. No automatic retry or redirect. Use the macOS SDK's libcurl; declare libcurl with TLS through vcpkg elsewhere. |

Web, GitHub and arXiv searches were considered. The arXiv results were mostly synthesis models and general scheduling research rather than applicable fixes for this transport; no paper was used to justify an unrelated rewrite. Existing engine primitives plus production playback examples fit these bugs more directly.

## Audit findings implemented

The original twelve-finding audit and its baseline probes are retained in the parent workspace's `audio-import-audit` folder. Its original line references describe the pre-fix tree.

| ID | Implemented behavior | Runnable regression |
| --- | --- | --- |
| LP-01 | Limit the final hardware-channel sum after clock adaptation; alias meters report final peaks/GR without consuming each other's peak windows. | `audio-output`: real callback PCM, independent true-peak measurement, bypass, ceiling changes and alias meters. |
| LP-02 | Pause freezes sequencing, pending actions and fades; Resume continues once. Lifecycle generations discard stale work. | `project-state-runtime`: pause/seek, deferred actions and replay/stop fences. |
| LP-03 | Crossfade and Start Next share the next/UUID/index resolver, validate before fading the source, and report unavailable EOF targets. | `project-state-runtime`: nested indices, overrides, failed targets and explicit GO retry. |
| LP-04 | Inactive ducking permits cue gain above unity; active owners still impose their authored ceiling. Last-owner release restores the current base gain. | `audio-rt`: decoded positive gain, active unity ceiling, overlapping owners and release. |
| LP-05 | Main, selected outputs and Preview route every real source channel using shared speaker-label weights. LTC remains separate. | `audio-output` and `project-state-runtime`: real center-only 5.1 PCM, source weights, mono/stereo and LTC exclusion. |
| LP-06 | UI persists full catalog names. Native routing resolves exact available names/current open IDs, rejects ambiguous/unavailable selectors, and never guesses a fallback for an explicit selection. | `project-state-runtime`, `audio-output`, client settings persistence and diagnostic API integration. |
| LP-07 | One physical key press dispatches transport once, including One Shots. | `client/tests/panicStop.test.mts`: actual shared keyboard handler and repeat events. |
| LP-08 | Close immediately clears crash-resume storage; heartbeat snapshot/publish shares the project lifecycle fence. | `server/tests/crash_resume_test.cpp`: real crash-state storage, immediate clear and queued publisher races. |
| LP-09 | Pause holds a running fade-out and exact playhead; Stop while paused remains silent. | `audio-rt`: PCM, fade progression, resume and paused-stop checks. |
| LP-10 | Authored HTTP actions execute on the server with zero, one or several clients. | `scripts/live-playback-reliability.test.js`: real child server, localhost receiver, two clients, POST body/order and HTTP 500 without retry; client test rejects legacy execution messages. |
| LP-11 | Project change clears audience media immediately, rejects stale fetch completion, and fences cached server playback batches. | `client/tests/videoOutputController.test.mts` plus deterministic native broadcaster publication check in `scripts/live-playback-reliability.test.js`. |
| LP-12 | No hidden early overlap at zero crossfade. Prepared distinct audio follows start at the exact sample boundary; unsupported/unready follows wait for EOF. | `audio-output`: exact 1013-frame handoff in either topology order; `project-state-runtime`: preparation, cancellation and no early group/action follow. |

Review additionally found and fixed a Preview-to-Main leak caused by choosing the first unordered mixer as Main. Main now has a dedicated identity that survives renames and duplicate labels; removal recreates the proper default route. Callback PCM tests keep sounding Preview out of a separate audience output. Exact EOF replay and a priming/render race also have native regressions. Short render segments now retain unused read-ahead samples instead of discarding the remainder.

The subsequent [video playback reliability investigation](video-playback-reliability.md) covers cue-transition freezes, renderer recovery, confidence capture and media networking.

## Spotify playlists

Playlist review uses the existing checksum-pinned spotDL metadata reader rather than treating Spotify's first 100 embedded preview tracks as the complete collection. [spotDL 4.5.2's playlist reader](https://github.com/spotDL/spotify-downloader/blob/v4.5.2/spotdl/types/playlist.py) follows subsequent pages. Validated share links resolve to the canonical playlist URL before that query. Fixed track-count limits were also removed from review, download selection and recovery; existing IPC byte limits, ID checks, ownership checks and cancellation remain.

Matching uses batches of at most 100 tracks with up to four concurrent processes, reusing the existing worker pool. The batch size keeps command lines bounded without limiting the total playlist. The regression in `scripts/spotify-import-reliability.test.js` exercises the real Electron handler with 100, 235 and 10,001 tracks, both share-link hosts, metadata failure, single-track review, large selection/recovery, and complete bounded-batch scheduling. Run it with `node --test scripts/spotify-import-reliability.test.js`. Network responses and helper processes are simulated; this check does not download a live Spotify collection.

## Verification

Run from the repository root with the native build configured:

```sh
cmake --build server/build -j4
ctest --test-dir server/build --output-on-failure
npm run test:server-integration
npm run check:client
npm run typecheck --workspace=client
npm run build:client
git diff --check
```

The native output harness exercises the actual render/device callbacks with headless device rings and an independent true-peak detector. It checks C++ allocation counts during the audio paths. Project runtime tests exercise real sequencer and decoder instances; the broadcast race self-check compiles the real publication code with deterministic fake connections. Network integration uses isolated child servers and localhost endpoints, never stage equipment.

Fresh results and red/green evidence are recorded alongside the original audit in `audio-import-audit/IMPLEMENTED-LIVE-PLAYBACK.md` and its evidence folder. CTest covers thirteen suites, including import decoding, limiter, RT playback, device-callback PCM, project runtime, crash-state and format/security checks. The client gate includes import preservation, One Shot identity/rollback, YouTube cancellation, hotkeys, video output, authentication and operator-manual contracts.

## Operator-visible changes and limits

- Unresolvable old session UUIDs and duplicate hardware names require reselecting the output. A failed explicit selection stops that cue from starting and reports an error before interrupting another cue; it does not silently choose speakers. Physical hotplug behavior still requires rehearsal on the deployment interfaces.
- The engine prepares one distinct audio successor ahead of time. Group/action/self/unready follows, and very short chains that cannot be prepared before the next boundary, use the 50 ms control loop at EOF. They may have a gap; they never regain the removed 100 ms early overlap. Start actions, duck ownership and UI trigger bookkeeping also follow that control cadence.
- HTTP action URLs originate at the engine host. `localhost` means that machine, not an operator's browser. One FIFO has capacity 64; each queued job has a five-second total lifetime and at most a two-second connection phase. Requests support HTTP/HTTPS and GET/POST/PUT/DELETE, with a 1 MiB body limit. Failures are reported; nothing retries automatically. A timeout or cancellation cannot undo a side effect already accepted by external equipment.
- The measured ceiling is at this engine's final floating-point device callback. OS conversion, downstream processing, DAC reconstruction and physical gain remain outside this test boundary. Explicit limiter bypass intentionally removes ceiling protection.
- Verified on this macOS arm64 checkout with existing dependencies. No packaged Electron acceptance, physical interface switching/hotplug, listening/PA test, real external HTTP automation, Windows/Linux execution, or new installer was performed. The operator manual is maintained as a current-source guide; check its source revision and capture provenance rather than treating it as installer acceptance.

## Secondary audio resync repair (T30)

The installed miniaudio rate-change path retimes fractional position with a 32-bit product. Our former one-million denominator overflowed it: an actual-library ramp probe lost 0.253404 source samples at one rate update. A smaller denominator alone still dropped phase at exact unity. The callback now uses denominator 65,536 with odd numerators, preserving its fractional denominator and avoiding the unity bypass. Rate spacing is 30.5176 ppm (maximum quantization error 15.2588 ppm); diagnostics report the realized correction. Existing gains, routing, PI gains and ±5,000 ppm limit are unchanged.

The former secondary target also left unequal scheduling headroom. With the final phase-safe callback and the old three-block target, each slow-clock case produced 50 overruns/resyncs in 90 simulated seconds. Centering pre-callback occupancy at 2.5 blocks eliminated them without enlarging the four-block ring. Master pacing and recovery priming retain three blocks. The secondary nominal queue level changes by half a block; physical inter-device delay still needs later calibration.

The original T30 evidence covered both nominal-speed crossings and six clock/phase cases at zero/±3,000 ppm with ±0.2-block callback delivery variation. Extended copies ran 30 simulated minutes each with zero underruns, overruns or resyncs, but checked PCM continuity only on a sub-second ramp before post-EOF silence. That was three hours of queue evolution, not decoded/audible playback. T40 below supersedes this coverage limit with continuous decoded-source checks; the T30 controller and timing bounds are unchanged.

Exploratory ±4,000 ppm cases with the same delivery variation can still exhaust headroom. The original real-media secondary-output burst is not uniquely attributed or physically confirmed resolved. Hardware acceptance remains deferred. No controller redesign or widened safety limit is implied by this bounded repair.


## Ordered storage repair (T38)

Immediate Stop All no longer waits for a decoder rewind behind a blocked storage read. Stopped transport and zero playhead publish immediately; the existing deliberate replay/prime path rewinds before reusing audio. Cold GO releases its single lifecycle owner during decoder preparation, and prime seeks without render exclusion. Intent/document/cue checks reject cancelled work before it can start or duck anything. Twenty held-read/seek cases cover ordinary GO, direct trigger/play, recovery, groups, looping, secondary start actions and preprimed loop/trim changes: Stop All completes before release and no cancelled child starts afterward. Stopped property changes defer their seek to preparation; interrupted seeks invalidate cache reuse and prepared activation. Re-prime/direct replay checks retain continuous positioned PCM beyond the old queue. Full native 13/13 and RT/live static checks pass with physical audio-service access denied. This is not a claim that arbitrary OS/driver stalls, separate Preview/live-edit paths or physical intermittency are closed.


## Prepared-follow contention (T39)

A transient source/target render-gate collision no longer cancels otherwise valid prepared handoff work. The source still ends at its authored endpoint; the next callback retries only the same valid playback revisions and prepared target. Stop/replay/media invalidation or decoder failure cancels it. Eight native contention/order/cancel cases verify next-callback target PCM and no late start after Stop, alongside existing exact-boundary and RT allocation checks. A held target gate can still cause silence while held; no longer-gapless or hardware performance guarantee is implied.


## Continuous decoded-source coverage (T40)

The current callback fixture replaces its earlier post-EOF silence with a deliberately looped generated binary ramp. Six cases now run ten simulated minutes each at zero/±3,000ppm, two phases and existing callback jitter, validating finite nonzero source PCM in every measured block as well as short-ramp slope continuity. Each delivers about28.7–28.8 million measured frames with zero underruns, overruns or resyncs. This is accelerated software decoding/resampling evidence; intentional ramp loop boundaries are not a click-free content test, and physical clocks/output remain outside it. The older T30 evidence above retains its original post-EOF limits.


## Nested project admission (T41)

Focused nested cue/group/settings type validation now runs in the existing shared document preparation before a load, replacement or save can change the current show. Seventy-five negative API cases preserve current playback/session/intent and existing disk bytes, while supported legacy/default/duplicate repairs remain covered by the format and migration suites. This does not claim complete validation of every possible authored field or malformed number.


## Long-position LTC arithmetic (T42)

Frame→nanosecond conversion no longer multiplies a large frame counter before division, avoiding signed overflow around53.4-hour cue positions at48kHz. Quotient/remainder arithmetic preserves ordinary integer timing, and unrepresentable durations/offset sums saturate safely.35 real-render timestamp/rate vectors and two signed-offset limits pass with no callback allocation, including0/1h and positions on both sides of the old boundary. This does not establish physical receiver lock or change authored timecode settings.

## Preview storage cancellation (T43)

Cue retirement removes/stops the source under engine ownership, then closes its decoder after releasing the engine mutex. Preview preparation has its own short-lived ownership separate from Program preparation; its file load/read/teardown waits do not retain the project lifecycle lock. Intent, document and item/settings checks prevent a cancelled audition from starting later. Stop All, Preview stop and Preview-device changes cancel pending work; ordinary Program GO remains independent. Same-device retry retains the existing runtime device identity. Native gated load/read/teardown cases preserve Program PCM/transport, authored Preview In points and dedicated routing; full native 13/13 and RT/live static checks pass. These are software NULL-device tests, not physical output or arbitrary driver-stall acceptance. Active live-edit waits are the next repair boundary.
