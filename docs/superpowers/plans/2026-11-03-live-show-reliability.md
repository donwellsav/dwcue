# Live Show Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement the current batch task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the audited show risks through small, independently tested changes while preserving the established live-show workflow.

**Architecture:** Retain the Vue/Electron control client, native C++ audio engine, current cue model and server-owned transport. Fix shared setters, lifecycle/identity guards and routing predicates in place. Reuse current queues, generations, platform APIs and test harnesses; introduce no new dependency or media framework.

**Tech Stack:** Vue/Nuxt/TypeScript, Electron 42.8.0, C++20, standalone Asio/Crow, existing native decoders and Node/native assert checks.

**Spec:** [App-wide audit](../../live-show-code-audit.md), [playback research](../../live-event-playback-research.md), and the user's instruction: “keep changes small, preserve the current show workflow, and test each fix so we dont break anything.”

## Global Constraints

- Preserve existing intentional uncommitted fixes, imported source level/full timing, explicit normalization, attenuation-only peak safety and final-output limiting.
- Preserve manual GO/armed-target refusal semantics, automatic Nothing behavior, Preview isolation, One Shot arming, authored duck/fade behavior and detached-server ownership.
- No automatic replay/advance as a side effect of a UI recovery fix. Stop and disarm remain available where a connection permits them.
- No dependency upgrade, new framework, blanket transcoding, all-show RAM preload, navigation redesign or new background service.
- Write the smallest behavioral regression first, watch its relevant failure, then make the shared correction and run the affected suite.
- Keep native hardware-free fixtures hardware-free; serialize Nuxt preparation/build commands; use `JITI_FS_CACHE=false` for Nuxt commands.
- User authorization now permits local commits of this session’s work as each verified batch is completed. Preserve separate checkpoints for earlier audit work and the resync repair. Do not push, open a PR, package, install or publish without a separate request.

## Review Focus

- A legitimate changed trim/loop must still invalidate obsolete audio; equivalent unchanged values must preserve queued PCM (T1).
- Recovery MIDI gating must preserve Learn and explicit Stop/disarm instead of disabling all input (T2).
- Runtime patches and real document hydration must not swallow or echo unsent authored edits (T3/T4).
- Nothing must not become automatic advance; manual GO, explicit overrides and failure retention must agree with the visible target (T5).
- Replacement/fading-group fixes must preserve paused fades, crossfade exclusions and overlapping duck owners (T6/T7).

---

**Commit policy:** commit each tested fix. `2ea5984` contains the earlier audit repairs and `a9a86a3` contains T30. The user authorized the v2.6.18 and v2.6.19 release builds and website updates.

**v2.6.19 follow-up:** `60086ef` and `530661d` repair Spotify review startup, speed and track order. `48ebe0b` keeps the macOS operator app accessible during display identification. The software checks include the real 200-track metadata review and a fullscreen label check on the built-in Mac display.

- [x] Stop All stays available in the local media, Spotify, YouTube and archive progress dialogs. Software checks cover click and keyboard activation, visibility after scrolling, and dispatch of the normal Stop All command.
- [x] A failed last-folder history write leaves the native picker choice usable. The regression checks all five picker routes, their path authorization, and cancellation with a simulated read-only history file.
- [x] New, Open, and Open Recent keep the current show through cancellation or refusal. New saves an unused `.dwcue` file before switching. The headless client test covers both cancel paths, invalid native and legacy files, a missing recent file, a conflicting New Show name, and a successful open. The isolated server suite passes 55 software tests, including continuity of a playing cue through rejected requests.
- [x] Stop All and its configured shortcut work while the connected client is awaiting a recovery choice. The headless reconnect test drops the WebSocket, starts a cue on the replacement show, verifies GO stays guarded, and verifies both Stop All controls plus the warning and successful retry after a failed recovery.
- [x] Stop All remains available during file selection. The desktop open and save panels leave the operator window usable, and the app’s file picker and archive location choice expose the normal Stop All command. A native panel failure releases the chooser for retry. A late selection cannot retarget a different cue or show.
- [x] The first unsaved-changes prompt owns its action through the decision and any forced save. Close, import, open and quit share the guard. A later action is declined with a visible message, and cancellation or a failed save releases the guard for retry.
- [x] A failed cue list offers Choose Another Show alongside Retry and Stop All. The headless client check covers cancellation, an invalid replacement while a cue plays, Retry on the original show, and opening a valid replacement.
- [x] Spotify keeps the chosen destination, downloaded media and current retry state through an import-preference write failure. The operator sees a warning about the next app launch. Software checks inject a read-only preference file before selection and after media copy, then verify job finalization and stale recovery suppression.
- [x] Spotify short share links use the same URL validation for review, download and retry. The software checks cover both short-link hosts and an import through media copy and finalization.

**Current checkpoint:** application source `153a1a7` includes T1–T23 and T25–T42 software repairs/coverage. The ordered batch fixes storage/Stop All cancellation, prepared-follow contention, nested project admission and long-position LTC, and strengthens continuous-media tests. All 13 native suites, 61 isolated integration tests, client checks/typecheck and the ten-minute video soak pass. One fresh final review found two T38 edges; one correction pass and native regressions close both. The remaining visibility comparison now passes four 300-second cells with 36,029 presentation callbacks and zero measured drops/additional seeks. Developer documents, workplan and the 50-page operator manual match this unchanged application source. All software checkboxes are complete; T24 hardware acceptance and original physical intermittency remain deferred.

## Priority and delivery boundaries

This ordered plan preserves the original delivery sequence. T1–T23 and T25–T42 are complete; resume only the unchecked work and acceptance boundaries. A completed software task does not close a finding whose physical or extended validation remains open.

| Order | Task / finding | Reason and completion boundary |
| --- | --- | --- |
| 1 | T1 Audio setter continuity — APP-01 | Common live edits can drain healthy PCM. |
| 2 | T2 MIDI recovery gate — APP-03 | Prevent unexpected GO while resolving recovery; retain Stop. |
| 3 | T3 Runtime-patch baseline — APP-11 | Do not silently lose authored changes, especially with autosave off. |
| 4 | T4 Stale client diff dispatch — APP-02, client portion | Stop subsequent P mutations after a switch; server late-request closure is T10. |
| 5 | T5 Manual GO parity — APP-04 | Match intended visible next cue without changing automatic Nothing. |
| 6 | T6 Replacement cancellation/duck release — APP-05 | Stop stale sequencing/attenuation at the existing ownership boundary. |
| 7 | T7 Fading group activity — APP-10 | Do not end a parallel group while a descendant is still fading. |
| 8 | T8 Crashed control-window close — APP-13 | Do not wait forever for a dead renderer to authorize recovery/close. |
| 9 | T9 Backup retention — APP-14 | Preserve recovery copies when copying fails; order by chronology. |
| 10 | T10 Late server mutation identity — remaining APP-02 | Reject an old request already dispatched before the project switch. |
| 11 | T11 Pending crash-resume intent — APP-07 | A newer Stop/Panic/Play/project change supersedes recovery. |
| 12 | T12 Position-aware recovery — APP-08 | Resume at the intended position without replaying crossed automation. |
| 13 | T13 Group output preflight — APP-09 | Validate known required resources before any selected leaf starts. |
| 14 | T14 LTC route replacement/identity — APP-06 | A→B→None replaces synthetic sends only and survives reopen. |
| 15 | T15 Terminal custom actions — APP-12 | Preserve valid crossed actions at natural/prepared completion. |
| 16 | T16 Mono API route replacement — APP-15 | Reuse the existing equal-gain All-lanes representation. |
| 17 | T17 Topology reclamation — APP-16 | Reclaim retired snapshots on control side after readers release. |
| 18 | T18 Storage/control isolation — earlier research | Bounded non-audio work; full read/write lifetime, cancellation and shutdown checks. |
| 19 | T19 Completed local intake — earlier research | Publish completed copies atomically, detect changing/truncated deliveries and invalidate stale readiness. |
| 20 | T20 Audience cover/output recovery — earlier research | Retain native black coverage through renderer loss/restart; preserve display identity and controls. |
| 21 | T21 Truthful picture health — earlier research | Distinguish capture freshness, frame/PTS progress and renderer responsiveness. |
| 22 | T22 Actual-player readiness/local diagnostics — earlier research | Bounded local compatibility/transition evidence for the exact file revision; no silent conversion. |
| 23 | T23 Upcoming-media preparation experiment — earlier research | Evaluate free-slot reuse during audio before adding a standby decoder; measure correct visible-frame timing and contention. |
| 24 | T24 Show-machine acceptance | Representative files, long run, line-level audio and 1080p HDMI/adapter outputs, show-used LTC, disconnects and actual target deployments. |

The original import/limiter/peak-reduction fixes, LP-01–12 fixes and Spotify pagination/cap removal already exist. Keep their regressions in the gates; do not reimplement them or label them pending. Hardware-only acceptance is reported separately from software completion.

## Current batch: exact work and verification

### T1: Preserve unchanged audio boundaries

**Files:** modify `server/src/audio/playback_item.cpp`; extend `server/tests/audio_rt_stress_test.cpp`.

**Interfaces:** retain `PlaybackItem::set_out_point_seconds(double)` and `set_loop(bool,double)`. They normalize effective frame values before deciding whether a change needs revision/seek/reset.

- [x] Add a check beside active-mirror priming: prime/play/render, reapply equivalent out-point/loop, require unchanged queue/revision and nonzero next PCM. Include a real boundary change that must still invalidate and an out-of-range loop-in normalization case.
- [x] Build/run `liveplay-audio-rt-tests`; expect new unchanged-value assertions to fail before the fix.
- [x] Add normalized same-value early returns under the existing decoder synchronization, before render exclusion/revision/seek.
- [x] Build/run the same target; require all checks green. Preserve direct-call and full-item update behavior through the shared setters.

### T2: Gate MIDI during session recovery

**Files:** modify `client/app/composables/useMidiController.ts`; extend the existing playback-safety check in `client/tests/panicStop.test.mts`.

**Interfaces:** reuse `useConnectionGuard().sessionLost` and existing action IDs; preserve the handler/dispatch API.

- [x] Run the actual parser/dispatcher with synthetic Note On while connected, hydration ready and sessionLost=true. Require zero GO/other unsafe mutations, successful intended Stop/disarm, and unaffected Learn. Assert healthy GO still dispatches once.
- [x] Run `JITI_FS_CACHE=false npm run test:playback-safety --workspace=client`; expect the recovery-GO assertion to fail.
- [x] Apply the existing recovery state at shared MIDI dispatch boundaries, preserving emergency actions.
- [x] Run the playback-safety suite; require green.

### T3: Protect authored baselines from runtime patches

**Files:** modify `client/app/composables/useProject.ts`; extend `client/tests/propertiesTrimPersistence.test.mts`.

**Interfaces:** preserve `applyDocPatch`, hydration and own-mutation echo handling. Runtime-only patches must not recapture unrelated authored baselines.

- [x] Add the actual-source case: authored inPoint 0→1, unrelated `next_item_set`, then diff; require one update containing inPoint=1. Cover relevant runtime-only operations and retain real hydration/own-echo tests.
- [x] Run the playback-safety suite; expect the missing update assertion to fail.
- [x] Keep runtime-only operations outside full document hydration suppression/baseline reset, without changing their existing state handlers.
- [x] Run the playback-safety suite; require green.

### T4: Stop stale client diff continuation

**Files:** modify `client/app/composables/useProject.ts`; extend `client/tests/propertiesTrimPersistence.test.mts` or its existing source harness.

**Interfaces:** reuse `isCurrentSaveIdentity(project,path,epoch,...)`, plus endpoint/session identity where exposed. No protocol change in this task; T10 owns requests already sent.

- [x] Defer the first old-P mutation, switch to Q, release it, and require that no second old-P mutation is dispatched. Repeat for close/reopen, endpoint change and stale completion; keep ordinary ordered edits working.
- [x] Run the playback-safety suite; expect stale-continuation assertions to fail.
- [x] Capture identity once per diff and recheck before every subsequent awaited mutation; avoid committing stale baselines on exit.
- [x] Run the playback-safety suite. Mark only the client portion complete; retain T10 as open.

### T5: Resolve manual GO consistently

**Files:** modify `server/src/core/project_state.cpp`, its header and `client/app/composables/useAudioEngine.ts` only as needed; extend `server/tests/project_state_runtime_test.cpp` and the existing client source checks.

**Interfaces:** retain `ProjectState::go()`, `state_summary()`, explicit override APIs and automatic-follow semantics. Use one deterministic manual-target derivation; make the client fallback use the same ordering.

- [x] Add Nothing A/B: first GO starts A, second manual GO starts displayed B while A is active, with the option enabled; disabled stays unarmed. Include explicit override, refusal retention, loop display and overlapping cue ordering.
- [x] Build/run `liveplay-project-state-runtime-tests`; expect the new manual GO case to fail.
- [x] Repair manual resolution/ordering under the existing lifecycle fence. Do not make the automatic follow resolver advance Nothing.
- [x] Run native runtime and affected client checks; require green.

### T6: Retire replaced cue ownership

**Files:** modify `server/src/core/project_state.cpp`; extend `server/tests/project_state_runtime_test.cpp`.

**Interfaces:** reuse cancellation/generation/group/duck-release logic; preserve outgoing crossfade exclusion and authored action ordering.

- [x] Reproduce A Duck Others=.1 → C Stop All Others/zero fade; require C released to its authored level. Include overlapping owners, fade replacement and stale custom-action cancellation; separately cover the raw custom Stop All sibling path.
- [x] Run native runtime checks; expect stale ownership/action assertions to fail.
- [x] Route replacement stops through the existing complete cancellation semantics without arming an unintended next cue or resetting unrelated gain.
- [x] Run native runtime and audio checks; require green.

### T7: Keep fading group descendants active

**Files:** modify the shared activity predicate in `server/src/core/project_state.cpp`; extend `server/tests/project_state_runtime_test.cpp`.

**Interfaces:** retain `item_on_air` and group completion APIs; include FadingOut as active and review all callers.

- [x] Parallel children: A ends at .4 s; B out=.8 s/stopFade=.6 s. Require group end after B's fade completes, with paused/manual-stop/retrigger cancellation still correct.
- [x] Run native runtime checks; expect early group end to fail.
- [x] Correct the shared predicate once, retaining existing cancellation behavior.
- [x] Run native runtime checks; require green.

### T8: Recover from a dead control renderer

**Files:** modify `client/electron/main.js`; extend `client/tests/videoOutputShortcuts.test.cjs` using the existing production-function harness.

**Interfaces:** preserve `createWindow` and terminal-action cleanup. Known renderer loss must not require a renderer quit reply; healthy unsaved-change confirmation remains.

- [x] Model healthy/crashed/destroyed states: healthy retains its veto, known crashed does not await dead IPC, and lifecycle cleanup/detached-server policy remains intact.
- [x] Run `node --test client/tests/videoOutputShortcuts.test.cjs`; expect the crash-close assertion to fail.
- [x] Repair the main-side lifecycle guard without auto-replaying media or stopping the detached program server.
- [x] Run the Electron lifecycle/output checks; require green.

### T9: Preserve backup history on failure

**Files:** modify `server/src/core/backup_manager.cpp`; extend the native runtime fixture and CMake source list if needed; correct the backup interval wording in `server/README.md`.

**Interfaces:** retain the ten-minute interval, current cap/scope and background worker; reuse current file publication utilities.

- [x] Exercise newer A/older Z names and failed copy with 20 usable backups. Require oldest chronology pruned only after successful new publication; failure retains all usable copies.
- [x] Run the actual backup/native fixture; expect both current exposure cases to fail desired behavior.
- [x] Publish the new copy before pruning and sort by actual chronology; keep exception containment and original files safe.
- [x] Run the affected native suite; require green.

## Subsequent work: exact boundaries to refine before editing

Continuation authorized: work through T10–T23 in order, refining each implementation boundary from current code before editing. T24 requires the actual show system/media. Keep per-task RED/GREEN evidence and the existing ledger; verification checkpoints do not require routine permission. The first nine tasks stay complete.

### T10: Reject requests from a superseded show session

**Files:** `server/include/liveplay/core/project_state.hpp`, `server/src/core/project_state.cpp`, `server/src/net/control_server.cpp`, `client/app/composables/useLiveplayServer.ts`, `client/app/composables/useProject.ts`, the existing client identity/auth checks, and one isolated native HTTP integration check.

**Interfaces:** expose a transient `server.projectSessionId` in project metadata and a shared `ProjectState::lock_project_session(expected)` guard. Reuse the existing ID generator, project-operation mutex and response/header helpers. `X-DWCUE-Project-Session` is an open-session precondition, separate from decoder generation and authored file data. Explicit stale IDs return 409 before mutation. Headerless external current-project API calls retain compatibility; the current client sends its bound session ID and refuses unbound writes to an already-open local project.

- [x] Add delayed-body native HTTP cases: capture P's session, hold a mutation body, load Q or reopen P, finish the old body, and require 409 with the current document untouched. Cover CRUD/reorder/cart/theme/settings/document/save/close and valid current requests; test session stability through ordinary saves and rotation through replacement/load/reset/Save As.
- [x] Run the new native integration check against the current binary; expect stale requests to succeed incorrectly or mutate the new document.
- [x] Implement an opaque session ID and guard with a consistent project-operation → save/lifecycle → document lock order. Preserve fast independent Stop/Panic; keep file path and session publication consistent on load and save.
- [x] Add actual-client header/late-response/owned hydration tests. Keep session adoption tied to the owned header; new-project and recovery chains pass the returned session explicitly until local hydration commits.
- [x] Run native runtime/integration plus the existing client gates. Mark APP-02 closed only for the updated client/session-aware API boundary; document compatibility and physical limits.

### Remaining repair order and runnable gates

| Task | Repair | Smallest check before moving on |
| --- | --- | --- |
| T11 | New Stop/Panic/Play/project intent cancels pending crash resume. | Extend `server/tests/crash_resume_test.cpp`; native runtime suite. |
| T12 | Recovery starts at the saved position and consumes crossed automation. | Native position/automation counters; runtime and integration suites. |
| T13 | Preflight all selected group outputs before starting any child. | Existing headless group/output fixture; runtime suite. |
| T14 | Replace LTC routes and persist stable device identity. | A→B→None routing fixture plus settings persistence checks. |
| T15 | Deliver valid terminal actions at natural/prepared EOF. | Native action counters/order; runtime and audio-rt suites. |
| T16 | Replace mono API routes without doubling a lane. | Real rendered routing amplitudes in audio-output fixture. |
| T17 | Reclaim old topology on the control side after its readers finish. | Retained-reader/free-thread and bounded-retention checks; audio suites. |
| T18 | Isolate bounded media/storage work from control workers. | Existing delayed-read probe plus exhaustion/disconnect/shutdown integration. |
| T19 | Publish completed copies atomically and invalidate changed media readiness. | Temp-filesystem interrupted/change/copy tests plus decoder readiness cases. |
| T25 (after T19) | Refuse invalid/failed priming before stopping program or partially firing a group. | Shortened-file trim and group admission runtime checks; audio suites. |
| T20 | Keep audience black coverage through output crash/restart and expose deliberate hang recovery. | Current-function ownership checks plus one isolated real Electron failure check. |
| T21 | Measure presented-frame/clock progress separately from screenshots. | Pause/still/seek/loop/VFR-aware controller and confidence checks. |
| T22 | Report exact-file player readiness with bounded local diagnostics. | Actual-player decode/seek and file-revision invalidation checks. |
| T23 | Measure upcoming-media preparation before adding decoder slots. | Extend the isolated Chromium experiment; choose a production change only from evidence. |
| T24 | Validate on the show machine, media, PA/display/LTC and target OS. | Recorded physical/long-run acceptance; never substituted with software-only gates. |

Pre-flight: T10's lock order must leave T11's transport intent responsive; T11/T12 share recovery generation and playback-start semantics. T13/T14/T16 share routing resolution and must fail before disturbing program playback. T14/T16 publications must remain compatible with T17 snapshot lifetime. T18/T19 share worker/response/file publication lifetimes; their cancellation cannot free in-use resources. T20/T21 share output session ownership; T22/T23 readiness must be tied to the exact file revision and must not interfere with the current cue.

- **T10:** `useLiveplayServer.ts`, native REST CRUD routes, current project identity/generation and integration tests. Reuse the existing import identity pattern; reject a delayed already-sent old-project request without changing valid current-project CRUD. Test P→Q and same-file reopen races. This closes the remainder of APP-02.
- **T11/T12:** `server/src/main.cpp`, `ProjectState` lifecycle/generation APIs and crash/runtime tests. Cancel pending recovery on newer operator intent atomically; start at the saved position without post-play seeking; treat crossed actions as consumed for recovery while retaining normal fresh-trigger behavior. Preserve no-retry external action semantics and acknowledge crash-side-effect uncertainty.
- **T13:** selected-leaf readiness/output resolver and group tests. Preflight a loaded but unavailable B before A starts; preserve Play First selection, nested groups and child ducking. Do not promise atomicity through later hardware failure.
- **T14:** `apply_ltc_device_routing`, existing synthetic sends, Settings persistence and headless routing tests. A→B→None removes only prior synthetic feeds; a failed new selection preserves the old valid state; persist full catalog identity as Main/Preview do.
- **T15:** sequencer terminal paths and runtime action counters. Dispatch crossed in-region actions through natural EOF and prepared FollowStarted completion before retirement; preserve explicit stop/replay cancellation and action order.
- **T16/T17:** default route representation, topology publication/control reclamation and output/allocation tests. Verify quiet mono replacement amplitudes; track frees during old snapshot release, reclaim only after readers finish, avoid retain-until-shutdown growth.
- **T18:** native media/copy/metadata/waveform request paths and Crow response ownership. First pin a bounded executor/admission/lifetime design using installed Asio; preserve exact Range/HEAD/auth. Existing 2.5 s delay probe must no longer delay co-located controls. Test pool exhaustion, disconnect and shutdown; do not claim running OS reads are forcibly cancelable or reuse the audio producer worker.
- **T19:** existing copy/upload publication and decode/readiness. Complete into a sibling temporary file, detect source changes, reject format-declared truncation where provable and leave originals untouched. Reuse hidden-part upload behavior. A stable size/checksum alone cannot prove an external writer has finished.
- **T20:** existing Electron output window, native View, output session/error state and real isolated Electron checks. Keep black coverage/main controls through renderer loss; explicit operator restart does not imply new GO. Validate target display and preserve diagnostic cleanup/power ownership. Physical output and shared GPU faults need separate acceptance.
- **T21:** `useVideoOutput`, `VideoConfidenceChip`, main capture/status IPC and current-source tests. Independent frame-progress/renderer observations; no false freeze for pause/still/low/VFR/seek/loop; no pixel-change heuristic or universal short threshold.
- **T22:** existing media analysis, exact file revision and bounded local diagnostics. Actual shipped-player decode/seek evidence precedes a Ready claim. Distinguish recognition, copy completion and partial decode; preserve source audio and do not silently transcode. Keep diagnostics local and bounded.
- **T23:** extend the existing isolated Chromium experiment, not production first. Compare eligible single-element reuse during audio with one standby slot for video→video; measure exact in-point/wrong-target invalidation/current-cue contention and correct visible-frame timing. Select a change only when evidence supports it.
- **T24:** real show files/system, long-show operation, removable-storage intake, display/device reconnect and calibrated physical A/V/LTC. Record machine/OS/codec/output chain and observed distributions; software gates do not substitute for this.

## Batch completion and review

- [x] Each completed current-batch fix has a recorded RED and GREEN result and a focused change review.
- [x] `cmake --build server/build -j4` and `ctest --test-dir server/build --output-on-failure` pass.
- [x] `npm run test:server-integration` passes on isolated servers.
- [x] `JITI_FS_CACHE=false npm run check:client`, typecheck and client build pass sequentially.
- [x] Relevant real Chromium transition check passes if picture/transport behavior changed; no physical acceptance claim.
- [x] `git diff --check` and a fresh whole-batch review pass; update the progress record with actual evidence and remaining tasks.

Progress/evidence: [execution record](2026-11-03-live-show-reliability-progress.md). Keep original audit/research observations as historical evidence; annotate corrected IDs rather than rewriting failures as if they never existed.

## T24: show-system acceptance still to execute

Use a rehearsal copy of the show and local media. The user-defined acceptance endpoints are line-level audio output and 1920×1080 progressive video through the actual direct HDMI or adapter-to-HDMI connection used for the show. PA loudspeaker/room tuning is outside this app audit. Record the exact app/native build, OS, CPU/GPU, RAM, storage, audio interface and channel mapping, adapter/display chain, negotiated HDMI refresh rate, source codecs/frame rates and file revisions. Do not assume the HDMI refresh rate from its resolution. The following are acceptance checks, not completed results:

| Check | Procedure and pass evidence |
| --- | --- |
| Actual late deliveries | Finish local copies, verify no required path remains on removable/network delivery storage, exercise changed/same-name and incomplete deliveries. Incomplete/changed files are refused or lose readiness; existing valid media remains intact. |
| Cue/control matrix | Exercise every show video with audio before/after, video before/after, retrigger, pause/Resume, authored In/Out and non-keyframe seeks. Repeat the busiest sequence 100 times. No crash, lost controls, partial group firing, unexpected replay/advance or stale picture over the incoming cue. |
| Cold and warm GO | Record at least 30 cold/warm starts across the heaviest show files, with first correct visible frame at the authored position. Record median/p95/maximum and agree the acceptable show budget before sign-off. Include video→video, which still has one production decoder. |
| Continuous audience surface | With representative playback, use Restart Output, simulate output failure/hang in a controlled rehearsal and reconnect each physical display/switcher. Record the audience output; no exposed desktop, stray operator UI, unintended transport or unowned window. Confirm Stop and Blackout independently. |
| Storage fault and operator control | During intake and media preparation, introduce a slow/unavailable rehearsal source. Verify transport acknowledgment and actual sound-stop behavior independently. T38 software checks cover 20 held-read/seek preparation cases and cancelled replay, but do not establish arbitrary OS/driver or Preview/live-edit stall tolerance. An actual control stall still requires investigation. |
| Line-level audio | Run known reference audio and the actual cues unmuted; monitor/capture the selected hardware line output at a fixed, recorded capture gain with adequate input headroom. Check channel mapping, level preservation, clipping, clicks/dropouts and stop/fade behavior; correlate defects with device counters. No room/PA loudspeaker alignment is required for this gate. |
| 1080p HDMI/adapter and A/V | Verify 1920×1080 progressive output at the negotiated refresh rate through the actual show HDMI/adapter chain. Exercise moving picture, mixed cues, seeking, Blackout, Restart Output and cable/adapter reconnects. Require controlled picture/black and responsive controls; HDMI connection changes must not silently reroute the chosen line audio. Use the existing AV Sync card and record endpoint offset and measurement method; agree tolerances for this connection. |
| LTC when used | Check receiver lock at every show-used LTC rate, A→B→None routing and interface disconnect/recovery. |
| Long-show run | Run representative mixed media longer than the planned show duration, recording memory, dropped frames, errors, cue transitions and control response. Include the largest real files and simultaneous last-minute intake. No progressive growth or loss of picture/control. |
| Deployment | Repeat the relevant matrix on each actual target OS/machine using the candidate packaged build. Source tests on this Mac do not establish packaged Windows/Linux or another GPU's behavior. |

Do not mark this gate complete from the synthetic Chromium/PCM fixtures. The local diagnostics and source/test evidence support investigation; they cannot measure the actual line-level output, HDMI/adapter signal or downstream display.


## Real-media rehearsal follow-ups (2026-11-03)

- [x] T26: keep repeated canplay events from bypassing soft drift correction; preserve initial decode alignment and explicit native seeks. Regression RED/GREEN, full client checks and actual-media transition check pass.
- [x] T27: report audience DOM readiness after Vue nextTick so a minimized restart cannot wait forever on requestAnimationFrame. Mounted-callback regression RED/GREEN and actual minimized-restart ready/responsive diagnostics pass.
- [x] T28: preserve playing video position/rate correction on document refresh while retaining paused alignment. Selection refresh RED → GREEN; existing reload/warming checks pass.
- [x] T29: isolate displayed-video position and native-clock progress from older cue and unrelated preview events; retain immediate true handoff/fallback alignment. Four behavioral RED → GREEN checks; controller 31/31, full client/typecheck/build, hidden Chromium and fresh review pass.
- [ ] T24: complete actual-system acceptance. Current evidence covers copied real MP3/H.264/AAC media, 161-command mixed playback repeats and exact source-integrity checks. Unmuted line-level output, the actual 1080p HDMI/adapter connection, independent audience display and full-show soak remain open.
- [x] Compare long-run frame drops after T26 with controlled output visibility; do not equate ready with presented. Four matched 300-second controller/plain visible/covered cells pass on the copied 1080p sample, with 36,029 presentation callbacks and zero measured drops/additional seeks. DOM visibility stays visible under cover plus 1 Hz capture; fixed clip order, memory and physical/full-app limits remain explicit in [video verification](../../video-playback-reliability.md#visibility-controlled-sample-comparison).
- [x] T30: actual callback PCM discontinuities and jitter-driven secondary overruns reproduced; bounded phase-preserving rates and centered secondary-ring target corrected. Master pacing/priming, ring size, PI gains/limit and show workflow preserved. 13/13 native tests, static checks, six 30-minute clock simulations with zero faults, and fresh review pass. Software-only limits and extreme-drift stress results remain explicit; T24 physical recurrence/latency calibration is deferred.

Evidence and final restoration: `/Users/muzikfirst/Documents/donwellscue/audio-import-audit/evidence/real-media-preview-2026-11-03/REAL-MEDIA-REPORT.md`.

## Documentation completion

- [x] Reconcile active developer/reliability documents with the committed T1–T30 source and mark superseded plans as historical.
- [x] Refresh the operator guide, 22 current-source UI captures and generated 50-page PDF; text, links, embedded fonts and rendered pages checked.
- [x] Run manual parser4/4 and offline reader7/7 checks; commit the verified documentation batch.

## Deep bug hunt — 4 November 2026

Baseline: clean `6d99a46`; all13 native tests pass with audio-service access denied. Four read-only investigation roles traced current code and existing fixtures. The following are source-backed findings; promote to repaired only after behavioral RED/GREEN. Keep each fix small, preserve the show workflow, and commit each verified repair. No physical outputs, user app, saved shows, real downloads, new dependencies or publication.

| Priority | Task | Proof and repair boundary |
| --- | --- | --- |
| P1 | T31 Rejected client document preserves current show | Bad name/folder metadata through file load, direct load and document replacement; reuse shared preparation before lifecycle effects. Preserve missing-field compatibility and in-place session semantics. |
| P1 | T37 Rejected typed server document preserves current show | Stage the existing root/cue/mixer/routing parser in local values before teardown; preserve v1 conversion and valid routing defaults. |
| P1 | T32 Failed automatic follow holds enclosing groups | Invalid child and nested-group destinations report failure and cannot dispatch parent endings on later sequencer ticks. Reuse existing group cancellation. |
| P2 | T33 Direct project load resets project-owned runtime state | A→B and same-file reopen clear old arming/selection/trigger state; preserve in-place same-session replacement. |
| P1 | T34 Spotify settings stay bound to the requesting show | Delayed PATCH rejection/success cannot roll settings onto or save another show; accepted live settings survive disk-save failure. |
| P1 | T35 YouTube initialization always settles and honors cancel | Filesystem/tool failures reject IPC and release jobs/listeners; cancellation during initialization never launches a downloader afterward. Mock all processes/filesystem in actual-handler tests. |
| P2 | T36 Unsafe time inputs cannot disturb live PCM | Reject nonfinite/unrepresentable seek, out-point and loop inputs in shared setters; preserve negative/zero semantics and normal valid edits. |

- [x] T31 behavioral RED/GREEN and affected native tests; commit.
- [x] T32 child/nested follow failure RED/GREEN; commit.
- [x] T33 project-load state reset RED/GREEN; commit.
- [x] T34 settings identity and save-error RED/GREEN; commit.
- [x] T35 initialization failure/cancellation RED/GREEN; commit.
- [x] T36 shared numeric boundary RED/GREEN; commit.
- [x] T37 server-schema typed-load refusal RED/GREEN; commit.
- [x] Final affected gates, fresh review and current evidence/documents.

The deep-hunt leads were subsequently reproduced and repaired as T39 (prepared-follow contention) and T42 (long-position LTC) in the ordered batch below. T37 closes the separately reproduced server-schema typed-load refusal path. T24 physical acceptance remains deferred.


## Ordered follow-ups — 4 November 2026

User authorized these in order from clean `8e96e39`. Preserve controls, cue order, authored levels/trims/fades and single-GO behavior; cancelled preparation cannot play later. Software fixtures only: generated/disposable media, native audio-service-denial sandbox, no user app/show/storage or physical endpoints. Reuse existing preparation, intent revisions and worker paths; commit each proven repair with its ledger result.

- [x] **T38 / High — storage stalls and Stop All.** Gate decoder work and prove Stop All(0) completes before release; current sound stops, pending start is cancelled and cannot fire afterward. Trace cold GO/direct trigger/group/recovery and shared stop/prepare callers. Fix the shared blocking boundary without adding a general job system or altering show actions. Cover normal replay, exact EOF and authored fades.
  - [x] T38a: immediate stop no longer waits for decoder rewind; replay and native audio/runtime regressions pass.
  - [x] T38b: cold preparation releases lifecycle ownership safely; 20 read/seek cases cover GO/direct/recovery/group/loop/start-action cancellation, including preprimed loop/trim changes, with no late start. Cancelled seeks invalidate cache reuse and prepared admission; re-prime/direct replay retain continuous positioned PCM.
- [x] **T39 / High — prepared-follow contention.** Force the target render gate busy at the exact source endpoint; verify an unsuccessful admission cannot permanently strand the handoff or create a polling-sized gap. Preserve source endpoint, target revision, cancellation and RT no-allocation/no-wait rules.
- [x] **T40 / High — continuous media proof.** Extend existing fixtures to consume actual decoded PCM throughout their stated duration and exercise sustained mixed-media presentation/control. Record duration, decoded frames, memory, dropped/presented frames and limits; do not describe post-EOF silence or accelerated simulation as a real-time show soak.
  - [x] T40 audio: six ten-minute drift/jitter cases now decode looped PCM continuously and check every measured callback, with zero device faults.
  - [x] T40 video: isolated 600.932-second mixed SD/1080p Chromium soak passes 481 rounds, including 161 video-to-video handoffs and 17,349 presentation callbacks. Record measured frame drops and memory; physical/actual-show acceptance remains T24.
- [x] **T41 / Medium — malformed nested documents.** Test representative bad nested cue/group/settings values and post-load normalization. Refusals preserve the current show/playback and disk file. Repair only proven shared validation/commit boundaries; no broad schema framework.
- [x] **T42 / Lower — long-position LTC.** Test frame→nanosecond arithmetic and actual generator behavior around the signed multiplication limit (~53.4-hour cue position at48kHz), then correct the conversion without changing ordinary timing or introducing callback allocation.
- [x] Full affected software gates, one fresh final bounded review, current documentation/manual and clean committed checkout. T24 physical/deployment acceptance stays deferred.

Pre-flight: T38 changes preparation/stop lifetime semantics consumed by T39; preserve revision and queued-PCM ownership before touching the handoff. T40 measures those paths. T41 changes document admission only; keep session and cancellation fences from T38. T42 uses the existing LTC render path and must retain its real-time contract.

## Preview and live-edit storage waits — 4 November 2026

User authorized this follow-up from clean `492aca0`: small shared repairs, unchanged show controls/behavior, software-only generated media and local tested commits. Reuse existing ownership, preparation serialization and revisions; no new dependency or general job framework.

- [x] **T43a — decoder retirement releases engine ownership.** Hold a retiring cue's decoder read mutex and require unrelated Stop All/program silence before release. Detach/cancel the retiring cue before decoder teardown, retaining its lifetime safely. Audio/runtime 3/3 and final runtime regression pass; committed independently.
- [x] **T43b — Preview preparation/stop cancellation.** Gated load/read preparation and replacement/stop/settings teardown now preserve independent Program GO/Stop All and reject cancelled Preview publication. Dedicated routing, selected-device reuse, authored In point, project replacement and deliberate retry pass; full native 13/13 plus RT/live static checks pass.
- [x] **T44a — native active seek/trim/loop gates.** Actual seek gates across playing/paused/fading states preserve Stop/Pause, stop fades, coherent edited/retry PCM and cancellation. The shared worker skips a busy decoder lock and delivers sibling PCM. Native affected 3/3 pass.
- [x] **T44b — live document-edit callers.** Update snapshots/native properties/media replacement and Cue to Continue release document/lifecycle ownership before decoder waits. Four real-media cases preserve document access, Stop All silence, saved edits and deliberate replay; no late continuation. Runtime suite passes.
- [x] **T44c — sibling caller closure.** Direct replay seek/read gates and removal/non-audio/group retirement now release transport ownership before decoder waits. Replaced the obsolete synchronous full-mirror helper with a narrow retirement pass; affected native 3/3 and final seven-case document runtime matrix pass.
- [x] Full affected software gates and one fresh bounded review, with both Important findings corrected in one parent pass. Application source `e1d5031`: native 13/13, API 61/61, client 222/222, typecheck and RT/live safety pass. Current developer docs and the rendered/verified 50-page manual are refreshed; final documentation checkpoint closes the batch. T24 physical/deployment acceptance remains deferred.

Pre-flight: Preview and live edits share `PlaybackItem`, engine retirement and project lifecycle locks. Remove engine teardown ownership first; retain decoder lifetime and publication fences before releasing project/render gates. Document mutations must stay serialized against project replacement and other preparation, while Stop All never waits for those file operations. Test cancelled-seek cache coherence as well as acknowledgement; a fast Stop that later restores stale PCM is a failure.


T43/T44 closure: Preview replies/events retain their publication identity/revision through HTTP and both client observers, and two queued seeks preserve the latest requested position while honoring Stop. The review left a stuck shared-worker read, serialized Program edits/GO, general metadata/device-change/full-project paths and type-only conversion without media-path change as separate leads. T45 below addresses shared reads; the other leads remain outside these bounded decoder-wait fixes.


## Stuck shared decoder reads — 4 November 2026 (T45)

Continue from clean `1d5a3c5`. User authorized small fixes, unchanged show workflow, software-only generated media, tested local commits and current workplan/docs. Preserve current queues, cue/transport revisions, Stop/Pause/fade/follow semantics and Preview isolation. No dependency, UI, media conversion or per-cue thread.

- [x] **T45a — bounded shared read isolation.** Hold actual native backend reads for one and three sources. Require healthy PCM beyond resident read-ahead/ring capacity, independent Stop All, and no late transport revival. Reuse decoder try-lock serialization with four fixed shared workers; keep read order/PCM/fades intact. Run affected native gates and commit.
- [x] **T45b — worker lifetime and restart.** Stop/destruction no longer join blocked decoder calls. Four persistent workers use independent shared state and weak cue snapshots; each call owns only its in-flight decoder. Stop/start reuses capacity, and shutdown releases that decoder after its read returns. Held-read lifecycle/restart/exhaustion/retry checks and affected native 3/3 pass; the complete audio-output target also passes under AddressSanitizer.
- [x] **T45 closure.** Application source `42ab5af`: full native 13/13, API 61/61, client 222/222, typecheck, RT/live safety and final audio-output AddressSanitizer pass. One fresh review returned an Important restart/routing dependency; one parent RED/GREEN correction caches the existing channel map and checks actual restored sends plus failed/reloaded maps. Current docs and the rendered/verified 50-page manual are refreshed in the final local documentation checkpoint. Physical/show-system acceptance stays deferred.

Pre-flight: worker concurrency consumes the cue's existing decoder mutex and fixed read-ahead queue; that mutex already serializes loader/control producers, so multiple workers must continue using try-lock. Engine stop currently joins the read thread, and the worker currently retains `this`/a full topology during I/O. Lifetime changes must remove those dependencies before leaving a read in flight at engine shutdown. Explicit cue teardown may still await its own decoder operation; this batch must not reintroduce global ownership around that wait.

Ruling: four fixed workers preserve capacity for a healthy cue with three concurrently blocked sources (e.g. an overlapping pair plus Preview), with a bounded thread count. All four blocked reads can still exhaust refill capacity; document this boundary rather than spawning replacements. Retain the existing show controls and explicit retry behavior.

Research basis: the C++ thread stop mechanism is cooperative and a jthread destructor still joins ([C++ draft](https://www.eel.is/c%2B%2Bdraft/thread.jthread.cons)); Windows I/O cancellation also depends on operation/driver support ([Microsoft guidance](https://learn.microsoft.com/en-us/windows/win32/fileio/canceling-pending-i-o-operations)). A timeout cannot safely destroy the still-running decoder. Keep the decoder owned until its call returns and isolate healthy work around it. This is a local design inference from those primary sources and the traced native flow.


## Reopened decoder fault containment — 4 November 2026 (T46)

T45's four shared workers reduced the original coupling but did not close it: four held native calls still starve unrelated sources, and a source can return audibly after an indefinite silent wait. The user correctly rejected these as live-show hazards. T45 remains a historical checkpoint; this follow-up replaces its capacity and late-resumption ruling. Preserve show controls and authored audio, use software fixtures only and commit each tested fix.

- [x] **T46a — source-owned refill capacity.** Reuse shared dispatch state and per-cue serialization; run at most one read-ahead worker for each playing cue. The dispatcher must never perform decoder I/O. Stopped/paused workers retire, and an in-flight read retains its cue without creating a replacement on restart. Native gates with four and twelve held sources must leave healthy PCM/control available, including restart/destruction and late return. No thread per idle library entry, dependency or UI setting.
- [x] **T46b — sustained source starvation fails the cue.** Reuse the existing decode-error/hold path after 250 ms of consecutively missing source PCM, measured in rendered frames. Brief shortages may recover; natural EOF, deliberate edit/seek exclusion, Pause and explicit stop-fades retain their semantics. A failed cue cannot resume, follow or advance a group when storage returns; deliberate retry remains available. This threshold is an application safety policy, not an external timing standard.
- [x] **T46c — busy failed-cue retry.** Refuse a failed cue whose previous decoder operation still owns its lock before acquiring shared Program preparation or applying native properties. Other GO remains available; retry after return still works.
- [x] **T46d — active-worker retirement.** Remove the cue and revoke its decoder immediately when its source-owned worker is still active. That worker retains and closes the decoder off control/engine locks after its call returns. Actual held-read removal acknowledges before release. Explicit unload without an active worker retains its existing completion contract; other file/driver cleanup is separate.
- [x] Full software closure at application `87bcd46`: native 13/13, API 61/61, client 222/222, typecheck, RT/live safety and the final audio-output AddressSanitizer suite pass. Corrected concurrency stress passes three repeats. Current developer docs, workplan and rendered/verified 50-page manual are refreshed in the final local documentation checkpoint. Physical/deployment acceptance remains T24.

Pre-flight: a timeout does not cancel an OS read. Keep its decoder owned until completion, and bound each cue to its existing outstanding worker rather than creating replacements. System thread/memory exhaustion remains an operating-system resource failure; do not claim infinite fault tolerance. Thread startup failure must fail only its cue through the existing error path, preserving controls and unrelated playback.


## Loader and driver waits — 4 November 2026 (T47–T50)

Continue from clean dfcbf42. User authorized small repairs, unchanged show workflow, software fault tests only and a local commit per tested fix. Trace actual native calls and all callers before changing ownership. Existing T46 decode-worker guarantees remain mandatory. No new dependency, UI controls, physical outputs, user show/media, installer or publication.

- [x] **T47a — loader metadata publication.** Whole-project metadata/probe work now runs in the existing unlocked file task. Actual held extraction preserves document access and Stop All, then correct metadata and stopped playback publish after release; native runtime passes.
- [ ] **T47b — sibling loader publication waits.** Audit native property application, stale-result retirement and routing under project ownership; repair reproduced control stalls without letting obsolete results overwrite current intent.
  - [x] T47b1: equivalent trim, normalized loop and LTC frame-rate requests return before decoder serialization, retaining the under-lock checks for real/concurrent changes. A held LTC-enabled whole-document publication preserves document access and Stop All; three direct native cases retain revision and queued PCM. Affected native 3/3 and RT/live checks pass. Genuine changes and retirement are covered by T47b2/T47b3 below.
  - [x] T47b2: cue withdrawal acknowledges even when no read-ahead worker is registered and native teardown is held by preparation/editing. An owned worker retains the decoder; generated diagnostic files are deleted only after decoder close, including remove/reset/destruction. Native 3/3 passed (38.46 s), followed by the added diagnostic lifetime matrix (runtime 22.58 s).
  - [x] T47b3: genuine trim/LTC publication runs on cue-owned native work outside project/lifecycle locks. The coordinator obtains source ownership before copying current properties and cancels without joining native I/O. Same-cue GO/native edits refuse while busy, pure level edits and healthy backup GO remain available, and stale completions cannot start playback. Affected native 3/3, RT/live/gain safety pass. Filesystem resolution and routing callers remain separate.
- [ ] **T48 — loader progress, cancellation and lifetime.** Reproduce blocked queued/bulk load and reset/replacement/shutdown waits. Keep completed healthy files usable and prevent obsolete loads from publishing. Native tasks must own their data before a coordinator can stop waiting; a timeout does not cancel a decoder/TagLib call. Reuse existing cues, generations and pending-readiness semantics.
  - [x] T48a: queued/bulk decoder, metadata and new One Shot priming tasks own their data and native cleanup. Coordinators cancel/join independently, stale results never register, and readiness completion is bound to its reserved CueId. Six project-boundary and six destruction cases, affected native 3/3 and project-runtime ASan pass. A subsequent runtime regression removes completed-worker retention behind a blocked batch sibling, using native cleanup in the shared owner deleter. Healthy sibling publication, revision sweeps and other native publication/routing waits remain open.
- [ ] **T49 — driver calls and transport ownership.** Gate device start/stop/uninit/enumeration at the native boundary. Keep engine/project control ownership out of those waits, retain device/callback/ring lifetimes and make Stop All/healthy output independent. Preserve device sharing, exact selection, routing and limiter state.
  - [x] T49a: initial device start, failed-start cleanup and duplicate-device teardown no longer hold the engine mutex. Existing runtime-ID reuse bypasses unrelated native serialization. Actual null-backend gates preserve Stop All, settings/introspection, device references and changed ceilings; affected native 3/3 pass. Project routing callers and initial native open remain open; recovery/retirement are covered by T50b.
  - [x] T49b: hardware discovery owns one background refresh; enumeration overlays current opened-device state without waiting on backend serialization. The initial catalog has a 50 ms grace to preserve ordinary cold selections; warm status has no discovery wait. Held-uninit warm/cold cases, current native reroute identity and original Preview workflow pass with affected native 3/3. Native first-open/routing completion remains separate.
- [ ] **T50 — recovery, stop and driver lifetime.** Keep a hung driver operation from disabling independent status/control or engine stop. No callbacks may retain a dangling engine pointer, no resources may be freed under a native call, and late recovery must honor Close/Stop. Reuse the existing managed-process recovery boundary where possible; do not force-cancel native threads.
  - [x] T50a: retain the directly spawned server PID through missing-pidfile/readiness and identity-probe failures; refuse duplicate engines and bound Windows taskkill. Behavioral fake-OS tests and local-auth/live checks pass. Native device lifetime and concurrent lifecycle intent remain separate.
  - [x] T50b: recovery runs on one owned worker per device; callbacks retain shared wake/limiter/generation signals instead of a raw engine pointer. Close withdraws routes immediately and native retirement owns its buffers and process-wide init/uninit lock. Held Start/Stop preserve Stop/Close/destruction and reject obsolete recovery across restart; native 3/3 and ASan pass. Initial-open/project-routing remain open; discovery is covered by T49b.
  - [x] T50c: reattach, Start, Stop, Restart and configuration changes share one ordered lifecycle chain. A paused old restart cannot finish after Shutdown, later explicit Start remains ordered, failures release the chain, and late probes cannot revive a dead identity. Seven fake-OS manager checks plus local-auth/live checks pass.
  - [x] T50d: engine Stop can race the renderer's wait on a full output ring. Recheck the run state after capturing the wake counter. A held software-render test delivers Stop before the counter read and verifies that Stop joins without a second wake.
- [x] **Software/documentation checkpoint at application `2f372c2`.** Native 13/13 (37.65 s), API 61/61 (38.66 s), client 229/229, typecheck, RT/live/gain checks and both affected AddressSanitizer suites pass (177.75 s; leak detection disabled). The 51-page manual is regenerated and visually checked, with 73 outlines, 150 internal links and all 22 original capture hashes/dimensions verified. Each tested repair has its own local commit. This checkpoint does not close the parent items whose gaps are listed below; T24 physical acceptance remains deferred.

Primary driver reference: [miniaudio's low-level documentation](https://miniaud.io/docs/manual/) explicitly excludes device init/start/stop/uninit from callbacks because they can deadlock. That establishes an off-callback requirement; it does not guarantee cancellation or bounded OS-driver execution. Local lock/lifetime tests must establish this application's containment.


### Remaining work, in order

1. **T49c / T47b4 - project routing ownership around first open.** Trace Program/group/default/LTC/settings/diagnostic callers retaining lifecycle or device-routing ownership during native open. Reserve and validate routing identity without holding those controls across native init/start; preserve exact-device selection, shared references and no late route/start after Stop/reset. Acceptance: actual held native start/init with unrelated Stop All, prepared backup GO and status responding, plus late-cancel and limiter/refcount checks.
2. **T48b - filesystem resolution and revision sweeps.** Relative/absolute fallback probes can still execute under project ownership; a revision sweep still runs inline on the queued loader. Move only native probing onto owned work, keep one sweep in flight, and publish against current media/generation. Acceptance: held actual probe with Stop All/document access, queued healthy media and destruction before release; preserve fallback paths and source-replacement detection.
3. **T48c - independent healthy loader publication.** Single queued preparation remains sequential and bulk draining/publication can wait behind a blocked sibling. Reuse existing bounded load concurrency and adopt completed current results independently; do not retain completed native threads, report incomplete batches as ready or auto-advance. Acceptance: one held source plus a later healthy cue becomes usable and plays original PCM while the held source stays unready; reset/replacement rejects obsolete publication.
4. **T47b5 - unrelated Program preparation serialization.** Genuine cold Program preparation/live native edits still serialize globally. Any further separation must retain manual GO order, current document/intent checks, authored loop/fade timing and no late replay. Acceptance: Stop followed by a prepared backup GO while the original native preparation remains held; latest edit/GO wins and canceled follows/groups do not run.

Native in-flight calls continue to own resources until the OS returns. The tested managed-process boundary orders recovery and refuses an unsafe replacement; it does not establish guaranteed driver termination. These are open engineering repairs. No UI redesign, extra media framework, automatic media conversion or blanket level change is planned.
