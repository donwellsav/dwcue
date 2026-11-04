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

**Commit policy:** the user authorized local commits and ongoing checkpoints. `2ea5984` contains the earlier audit repairs; `a9a86a3` contains T30. Package metadata remains 2.6.17, with no new installer or publication.

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
- [ ] **T43b — Preview preparation/stop cancellation.** Gate Preview load/prime/replacement teardown; keep Program Stop All responsive and prevent a cancelled Preview from starting later. Preserve dedicated Preview routing, selected device and deliberate retry. Cover project/settings changes and existing resource ownership. Commit after native checks.
- [ ] **T44 — active seek/trim/loop edits.** Gate actual decoder seeks and decoder-lock contention. Keep short render/project gates out of storage waits, preserve explicit seek/paused/fade/loop semantics and coherent PCM, and reject stale publication after Stop. Trace native APIs and document-update callers; keep unrelated decoder work progressing where current serialization permits. Commit each independently tested root fix.
- [ ] Full affected software gates, one fresh bounded review, current workplan/developer documents/manual and a clean committed checkout. T24 physical/deployment acceptance remains deferred.

Pre-flight: Preview and live edits share `PlaybackItem`, engine retirement and project lifecycle locks. Remove engine teardown ownership first; retain decoder lifetime and publication fences before releasing project/render gates. Document mutations must stay serialized against project replacement and other preparation, while Stop All never waits for those file operations. Test cancelled-seek cache coherence as well as acknowledgement; a fast Stop that later restores stale PCM is a failure.
