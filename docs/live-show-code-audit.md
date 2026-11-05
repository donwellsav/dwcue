# Live-show code audit

**Current update — 4 November:** source `87bcd46` corrects T45's remaining shared-worker exhaustion and late-resumption hazards with T46 source-owned workers, sustained-starvation failure, busy-retry refusal and active-worker retirement. Earlier T43/T44 Preview/live-edit cancellation and ordering remain. The [execution ledger](superpowers/plans/2026-11-03-live-show-reliability-progress.md) records RED/GREEN, full software/sanitizer results and remaining loader/new-preparation/metadata/device/physical limits. The six simulated ten-minute decoded-clock cases run in native tests; the 481-round muted video soak and visibility comparison remain historical measurements. The original audit below remains historical.

Audit date: 3 November 2026. Checkout: `/Users/muzikfirst/Documents/donwellscue/dwcue`, HEAD `82505580ccb6ae86ccb71e28264b6d4436641419` plus the existing intentional working-tree changes. This audits the current source, not an installed release. No application source, settings, saved project, dependency or output device was changed during this audit.

Workplan finish, 4 November: the last software checkbox now has a completed four-cell, 20-minute visible/covered controller/plain comparison on the copied 1080p sample: 36,029 presentation callbacks, zero measured dropped frames/additional seeks, preserved media hashes and complete owned-resource cleanup. This adds evidence without changing application source. DOM visibility, clip-order, memory and physical/native-A/V limits are retained in [video verification](video-playback-reliability.md#visibility-controlled-sample-comparison). Only T24 actual-show/system acceptance remains unchecked; the original live-app frame-drop cause and physical audio intermittency are not declared resolved.

Implementation update: the [prioritized workplan](superpowers/plans/2026-11-03-live-show-reliability.md) has committed repairs through T23 plus T25–T30, including the remaining APP-02 server fence, recovery intent/position/actions, group admission, routing, terminal actions and snapshot reclamation. Storage isolation, completed intake/file revisions, native audience cover, truthful picture health, exact-file preparation diagnostics and single-element warming during audio are implemented. Final continuation review found four Important edge cases; all were corrected with behavioral regressions. Integrated verification passes (native CTest13/13, combined integration66/66, client/typecheck/static generation and actual Electron/Chromium checks). T26–T29 remove avoidable video seeks and a minimized-readiness deadlock. T30 preserves fractional clock phase and balances secondary-ring headroom; native 13/13 plus bounded clock simulations and review pass. Commits `2ea5984` and `a9a86a3` preserve this checkpoint. T24 real-system acceptance remains partial: real MP3/H.264/AAC checks were performed, while unmuted line-level output, 1080p HDMI/adapter, long-show and physical recurrence checks remain deferred. The findings below are the original audit; use the [execution ledger](superpowers/plans/2026-11-03-live-show-reliability-progress.md) for current evidence and explicit limits.

**Recommendation: retain the current application architecture and show workflow.** The material findings concern existing synchronization, cancellation, routing and recovery boundaries. They support focused corrections and regression checks, not a new media framework, automatic transcoding, changed import levels or a UI redesign.

The audit used the [current playback research](live-event-playback-research.md), traced current callers and existing safeguards, and exercised selected behavior with isolated source/hardware-free checks. The scope includes native audio/decoding/DSP, program/Preview/routing/LTC, cue sequencing and actions, client/MIDI/reconnect controls, project mutation/persistence, Electron lifecycle, imports and backup behavior. This is a targeted runtime audit, not a claim of formal verification of every repository file.

## Evidence and priority

- **Headless native:** actual current native regression objects, built with `LIVEPLAY_TEST_NO_DEVICE_ROUTING`, with the engine not started. Manual buffers and transport/control state are examined; no PA, physical interface or network equipment is used.
- **In memory:** current TypeScript/JavaScript functions execute with Vue and modeled dependencies. This establishes dispatch/control behavior, not actual hardware or live-server consequences.
- **Filesystem:** the actual backup implementation runs with an inert project-path provider/logger and disposable files.
- **Source confirmed:** the caller and callee establish the defect; its proposed runtime regression has not yet been run.

P1 means fix before relying on the affected feature in a show. P2 means a bounded reliability/recovery correction or a less commonly reached path. These are conditional priorities, not a claim that every show experiences every issue.

| ID | Priority | Finding | Evidence |
| --- | --- | --- | --- |
| APP-01 | P1 | Ordinary live edits can empty healthy audio queues. | Headless native setters; full edit path traced. |
| APP-02 | P1 | An old project's queued diff continues dispatching into a new project. | In-memory current functions; server target behavior traced. |
| APP-03 | P1 | MIDI can fire GO while the recovery dialog blocks other operator input. | Actual parser/handler with synthetic MIDI. |
| APP-04 | P1 | GO can disagree with Up Next, or do nothing while B is displayed. | Headless native common case; client/summary ordering traced. |
| APP-05 | P1 | Replacement can leave the incoming cue stuck under an old duck ceiling. | Headless native ownership state. |
| APP-06 | P1 when using LTC | Clearing/changing LTC output leaves old synthetic sends in place. | Source confirmed; electrical output not measured. |
| APP-07 | P1 | Pending crash recovery can override a newer Stop/Panic/Play. | Source confirmed. |
| APP-08 | P1 when using automation | Recovery can replay past actions and starts before applying the saved position. | Source confirmed; external effects not triggered. |
| APP-09 | P1 when using Play All | An unavailable child output can produce partial playback with group success. | Headless native. |
| APP-10 | P1 when using parallel groups/fades | A group ending can run before a fading sibling finishes. | Source confirmed. |
| APP-11 | P2 | An unrelated runtime patch can swallow a pending authored edit. | Current handlers/Vue watchers in memory. |
| APP-12 | P2 | Valid timed actions near EOF can be dropped entirely. | Source confirmed. |
| APP-13 | P2 | A crashed control renderer can remain trapped behind the quit veto. | Current window function with modeled lifecycle states. |
| APP-14 | P2 | Backup retention can delete a newer backup, and prune before a failed copy. | Actual backup implementation/filesystem. |
| APP-15 | P2, API path | Replacing a mono route can double its right feed. | Source confirmed; routing UI is not mounted. |
| APP-16 | P2 | Retired topology storage can be deallocated on the render thread. | Source confirmed; deadline miss not reproduced. |

## Findings and smallest compatible corrections

### APP-01 — Keep unchanged live properties from resetting audio

A Properties volume change reaches [the full-item diff](../client/app/composables/useProject.ts). [Native update_item](../server/src/core/project_state.cpp) reapplies the out-point, then [loop state](../server/src/core/project_state.cpp), even when those values have not changed. Both [shared setters](../server/src/audio/playback_item.cpp) seek and reset read-ahead.

The native probe started with **15 queued blocks**. Reapplying either unchanged out-point or loop settings reduced that to **zero**; the next manual render before refill produced **zero frames**. This is a real, deliberately exercised scheduling order. A physical audible dropout or its incidence was not measured.

**Small correction:** compare normalized effective boundary/loop values under the existing synchronization and return before invalidation/seek/reset when unchanged. Preserve invalidation for real trim/loop edits and media changes. The existing active-mirror `prime()` no-op is a useful local precedent but does not protect these setters. Regression: identical properties and a volume-only edit preserve queue/revision/next PCM; changed trim/loop still takes effect correctly.

### APP-02 — Fence the entire old-project diff, including its server boundary

[syncItemsDiff](../client/app/composables/useProject.ts) captures a project, then performs awaited remove/add/update/reorder operations without checking project/session identity again before later requests. The APIs mutate the server's current document.

The in-memory check deferred the first old-P add, changed the current project to Q, and released it. Observed dispatch was **old-add-1 while P was current, then old-add-2 while Q was current**. The live server was not used in this probe; the source trace establishes why the latter request can mutate Q.

**Small correction:** capture project identity/epoch/endpoint and stop the remaining loop when stale. Preserve mutation ordering and the existing save queue. Client checks cannot retract an already dispatched request: reuse existing expected-project/generation concepts at the relevant server mutation boundary to reject late old-project requests too. Full-document save/hydration guards already exist and should remain; they do not protect this loop.

### APP-03 — Apply recovery safety consistently to MIDI

[The MIDI handler](../client/app/composables/useMidiController.ts) checks connection loss and its dispatcher checks hydration, but neither checks `sessionLost`. [Recovery](../client/app/composables/useConnectionGuard.ts) can deliberately retain the old ready mirror while asking the operator how to reconcile it with the reconnected server.

With connected=true, connectionLost=false, sessionLost=true and hydration ready, synthetic Note On through the **actual parser and dispatcher called playNext (modeled GO)**. No command was transmitted to a server. Keyboard/pointer recovery protection is already present; the MIDI path omits it.

**Small correction:** use the existing recovery state to gate MIDI actions that can start/alter the show. Preserve MIDI Learn and explicitly keep the intended emergency Stop/disarm behavior reachable. A blanket return before every MIDI action would risk removing that escape hatch. No hardware is needed for this regression.

### APP-04 — Make displayed and accepted manual GO agree

[The client derives B](../client/app/composables/useAudioEngine.ts) while A with End Behavior Nothing is still playing and `autoCueNextWithoutEndBehavior` is enabled, which is the default. [playNext](../client/app/composables/useAudioEngine.ts) delegates to [native GO](../server/src/core/project_state.cpp), whose resolver returns no target for Nothing.

The native probe armed/played A successfully, then issued GO with A still Playing. It returned **an empty target**, leaving B Stopped. At A's stop/end, the existing server auto-arm can mask this problem. Separately, state-summary next selection uses document order while GO iterates an unordered cue map; overlays can therefore disagree with the advertised target.

**Small correction:** share deterministic **manual GO** resolution with the displayed/advertised target and retain accepted-start/override-consumption fences. Crucially, do not make the general automatic-follow resolver advance Nothing cues: Nothing must continue waiting for operator input. Test the default Nothing case, explicit overrides, failed/unready targets, loops and overlapping cues. Existing trigger-order metadata tests do not establish GO/display parity.

### APP-05 — Retire the ownership of cues stopped by replacement

[Stop All Others during play](../server/src/core/project_state.cpp) directly calls PlaybackItem stop instead of the ProjectState cancellation/release path. The sequencer later [ignores the raw-stopped entry](../server/src/core/project_state.cpp). The [custom Stop All action](../server/src/core/project_state.cpp) has a related bypass.

The native probe fired A with Duck Others at 0.1, then C with Stop All Others/zero fade. After replacement and a sequencer interval, C still had **active duck ownership targeting 0.1** despite its unity base gain. Explicitly stopping A through ProjectState released that ownership correctly. This proves the stale control state; no acoustic level was measured.

**Small correction:** reuse existing generation retirement, group cancellation and duck-owner release for replacement/custom-stop paths. Preserve crossfade's excluded outgoing cue and authored action ordering; merely adding a gain reset would hide the stale owner and damage overlapping duck semantics. Extend existing ownership tests with replacement and authored Stop All, including fade/paused cases.

### APP-06 — Replace synthetic LTC routes rather than accumulating them

[Settings offers None](../client/app/components/ProjectSettingsModal.vue), but [apply_ltc_device_routing](../server/src/core/project_state.cpp) returns for an empty selection without removing existing sends. Selecting B adds B without removing A. The old device route remains owned until a later lifecycle release. The graph therefore keeps the old LTC feed after None, or both feeds after A→B.

There is also an identity inconsistency: the dropdown persists `d.id`, and [opened device enumeration](../server/src/audio/engine.cpp) can replace a catalog-name ID with a runtime UUID. Main/Preview already canonicalize persistent selection; LTC does not. Restart behavior was not exercised here.

**Small correction:** validate the replacement, then replace/clear only each cue's synthetic LTC sends; preserve every real audio send. Persist the catalog identity using the existing device-selection pattern. Test A→B→None, failed replacement, real-audio isolation and reopen. Existing LTC downmix exclusion tests cover a different boundary. Electrical output and downstream timecode consumers remain untested.

### APP-07 — Let newer operator intent cancel pending crash resume

[PendingResume](../server/src/main.cpp) is local to main. It waits until audio loading finishes and the initial three-second deadline passes, then starts the saved item without comparing project or transport intent. A successful newer Stop/Panic or another Play does not clear that optional.

**Consequence:** the operator can stop during recovery and have the saved cue start afterward. This is a source-confirmed ordering defect; no process crash was induced for this audit.

**Small correction:** fence pending resume against project identity and newer operator transport intent, using the established generation/lifecycle pattern. Preserve automatic project reload/recovery as a feature. The snapshot implementation correctly excludes Paused/FadingOut; existing snapshot tests cover publication, clearing and close fencing. Test Stop, Panic, new Play and project replacement during the recovery delay.

### APP-08 — Recovery needs position-aware action semantics

[Recovery starts ordinary play, then seeks](../server/src/main.cpp). Ordinary play recreates [custom actions as untriggered](../server/src/core/project_state.cpp), executes start behavior, and only then does main move the decoder to the saved position. An action previously fired at 5 seconds can become due again after recovery at 20 seconds. A past Stop All can stop restored playback; a past HTTP command can be sent again. Positions at or below one second are not sought in this path at all.

**Small correction:** reuse the existing atomic start-position capability for the audio position, and explicitly distinguish recovery from a fresh authored trigger for crossed actions/start behavior. Passing the position alone does not mark actions consumed. Preserve normal manual GO/replay behavior. Test with an internal action counter, without sending commands to equipment.

This does not promise exactly-once external effects across a crash: an earlier side effect may have reached its receiver before failure. The current no-automatic-retry worker remains appropriate; recovery should not inadvertently create a new attempt.

### APP-09 — Preflight Play All's required output resources

[Group readiness](../server/src/core/project_state.cpp) checks decoded/mapped items, but output validity is tested later by each child's play. The dispatch loop considers the group successful if any child starts.

In the native check, both A and B loaded; B had a missing explicit device selector. Play All returned **accepted=true**, with **A Playing and B Stopped**. Individual output refusal correctly protected B; the missing boundary is validating all selected leaves before any group child starts.

**Small correction:** extend the existing selected-descendant preflight to known required output/start resources. Preserve nested Play First/Play All selection, child ducking policy and failed-GO override retention. This can reject a known unavailable output before starting A; it cannot make a subsequent physical hardware failure atomically impossible.

### APP-10 — A fading descendant is still active for group completion

[item_on_air](../server/src/core/project_state.cpp) excludes FadingOut. [Group completion](../server/src/core/project_state.cpp) uses that predicate to decide whether descendants remain active.

**Trigger:** parallel No Ducking children; A ends at 0.4 seconds, while B with out-point 0.8/stop-fade 0.6 is still audibly fading. A's completion can treat B as finished and run the group's ending, potentially cutting its tail.

**Small correction:** include FadingOut in the shared active predicate, checking every caller and preserving manual-stop cancellation. Existing sequential/nested/canceled-group tests do not cover this simultaneous sibling case. This remains source-confirmed, not a rendered-group reproduction.

### APP-11 — Runtime patches must not acknowledge unrelated authored edits

[Runtime-only patches also start hydration suppression](../client/app/composables/useProject.ts). [Clearing suppression recaptures all baselines](../client/app/composables/useProject.ts), even when `next_item_set` did not change the authored document. Own `item_updated` echoes already return before suppression.

The in-memory check changed inPoint 0→1, received an unrelated next-item patch and ran the actual diff. The baseline became **1 with zero update requests**. With autosave off, [saveProject returns before the full write](../client/app/composables/useProject.ts), so that masked granular edit need not reach the engine. Successful full autosaves can hide the gap.

**Small correction:** keep runtime-only patches out of full authored-baseline resets; retain real hydration and the existing own-item-echo guard. Test autosave off/on and genuine incoming document changes. A new state-management framework is unnecessary.

### APP-12 — Preserve crossed timed actions at natural EOF

[Natural-end handling](../server/src/core/project_state.cpp) continues before [collecting due actions](../server/src/core/project_state.cpp), then terminal dispatch retires that generation.

**Trigger:** an action inside the authored region falls after the last sequencer poll but before EOF, or a short cue finishes before the next 50 ms poll. The action can disappear rather than merely execute late.

**Small correction:** collect/order actions crossed through the terminal position before retiring normal-end work. Preserve explicit Stop/replay cancellation, do not run actions beyond the authored region, and do not add HTTP retries. Test an internal action counter with a sub-poll-length cue and both natural-end and prepared `FollowStarted` completion. This remains a source finding; external actions were not exercised.

### APP-13 — Do not wait for a quit reply from a dead control renderer

[The main-window close handler](../client/electron/main.js) bypasses the veto only when WebContents is destroyed. A renderer crash is a different state; the handler can prevent close and send `app:request-quit` to a renderer that cannot answer.

The modeled lifecycle test executed the actual function: healthy and crashed states both **prevented close and requested the renderer's reply**; destroyed allowed close. No real control renderer was crashed in this audit. Electron documents [renderer loss, destruction and isCrashed separately](https://www.electronjs.org/docs/latest/api/web-contents).

**Small correction:** provide the existing main-process lifecycle/recovery path for known renderer loss, retaining healthy unsaved-change confirmation and diagnostic cleanup. Do not treat every transient unresponsive notification as a crash or stop the detached program server merely because its client failed.

### APP-14 — Preserve a usable backup when replacement fails

[Backup retention](../server/src/core/backup_manager.cpp) sorts the entire shared backups folder lexically, including project-name prefixes. A newer A backup sorts before older Z backups. It also removes entries before attempting the replacement copy.

The actual implementation deleted a **newer A backup while retaining an older Z backup**. A second fixture made the source unreadable to force copy failure: usable backups fell **20→19**, with a warning and no replacement. Only disposable files were affected.

**Small correction:** create/verify/publish the new backup successfully before pruning, and use actual chronology while preserving the existing retention scope/cap. Reuse existing atomic-publication utilities where appropriate. The worker's exception containment already correctly protects the server. Documentation currently describes on-save backups, while implementation runs every ten minutes; correct that operational promise too.

### APP-15 — Normalize equal-gain routes before replacement

[Default routing](../server/src/audio/engine.cpp) creates separate L/R sends for equal-gain mono/center content. [Route replacement](../server/src/audio/engine.cpp) replaces only the first matching mixer entry. Reposting unity mono→Main with the API's All-lanes default leaves All plus R: L=x, R=2x before limiting.

**Reachability:** advanced API; the Routing Matrix component is not mounted in the current operator UI. Selected-output/Preview [already uses one All-lanes send](../server/src/core/project_state.cpp) for equal gains.

**Small correction:** reuse that representation in default routing; verify replacement does not duplicate a lane or change a quiet mono signal's balance/level. No routing-screen feature is needed. This was traced, not measured at a device callback in this audit.

### APP-16 — Keep final topology reclamation off the render deadline

[Topology publication](../server/src/audio/engine.cpp) has no control-side retired ownership. The [render-local shared snapshot](../server/src/audio/engine.cpp) can become its last owner after a topology change, freeing scratch vectors on release. Snapshot ownership prevents dangling references; it does not determine which thread performs final deallocation.

**Small correction:** use the existing retirement ownership pattern for control-side reclamation after readers release retired snapshots; do not retain every topology until shutdown. Extend the headless allocation instrumentation to observe frees too, under topology churn. This is a source-confirmed deadline hazard; no audible underrun was reproduced. The [PortAudio real-time guidance](https://portaudio.com/docs/v19-doxydocs/writing_a_callback.html) is relevant scheduling guidance, not a claim that this app uses PortAudio.

## What the research adds to this audit

The research narrows solutions rather than prescribing more infrastructure:

- **Ownership/invalidation:** [mpv's pinned prefetch checks](https://github.com/mpv-player/mpv/blob/46787be2502556586b6a5fea9ebd595f5cd9b713/player/loadfile.c#L1325-L1428) reinforce validating retained work against its actual target. APP-02/07 concern the same class of stale completion; the app already has generations to reuse.
- **Real-time work:** [PortAudio's guidance](https://portaudio.com/docs/v19-doxydocs/writing_a_callback.html) excludes unbounded allocation/deallocation and I/O from deadline paths. APP-01/16 make this concrete in the current code. Larger buffers or a new decoder are not substitutes for avoiding needless invalidation/reclamation.
- **One-attempt automation:** [RFC 9110 idempotency](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2) and the existing HTTP-action research support retaining bounded server-owned execution. APP-05/08/12 concern lifecycle/order around it; automatic retry would create another risk.
- **Recovery domains:** [Electron's lifecycle contract](https://www.electronjs.org/docs/latest/api/web-contents) distinguishes renderer failure from page destruction. It supports repairing APP-13 within the current Electron design.
- **Evidence boundaries:** the [2026 physical latency methodology](https://arxiv.org/html/2602.17381v1) supports separating software/control measurements from emitted light/sound. These headless checks establish code defects, not measured PA/projector performance. Storage/resource papers are assessed with their workload limits in the preceding research report.

No paper establishes that this app needs a different media framework. A production example or API contract is used only where it matches the observed boundary.

## Existing safeguards to retain

The current code already preserves imported source level/full timing, separates explicit normalization from attenuation-only peak safety, protects final physical sums, and has meaningful preview/downmix/limiter tests. Preserve those decisions.

There are also real safeguards for rejected GO/override retention, loaded-descendant checks, generation-fenced sequencer work, protected Main/Preview identities, immutable render snapshots, paused fades, keyboard repeats, One Shot arming, project hydration, serialized/full atomic saves, import project identity and detached-server ownership. The findings above identify incomplete sibling paths or missing conditions around those mechanisms. They do not justify replacing them.

Updater installation is explicit and cleanup is guarded; no automatic-update show-stop finding was established. Existing HTTP action workers already avoid client-count duplication and automatic retry. Existing tests remain valuable even though they miss these specific cases. The audit did not establish that every device switch, import or project save is broken.

## Previously researched risks still open

These are carried forward from [the research report](live-event-playback-research.md), not counted as new APP findings: synchronous filesystem work can stall a control worker; an unfinished delivery can pass copy/readiness checks; FFmpeg video recognition does not establish browser decode; capture freshness does not establish picture progress; renderer failure destroys audience coverage; and upcoming-video preparation needs measurement before choosing additional decoders. The shared audio decoder's finite read-ahead remains a storage-failure boundary.

The app's existing local-copy/upload/readiness checks should be retained. No blanket conversion, automatic gain change, full-show RAM cache, always-on second decoder or broad refactor is recommended by this audit.

## Runnable evidence and next checks

[Evidence directory](/Users/muzikfirst/Documents/donwellscue/audio-import-audit/evidence/app-wide-audit/observations.json) contains logs, exact source/native-object hashes, and standalone checks. Thirteen isolated cases cover nine APP findings: five native cases, six in-memory client/lifecycle cases, and two backup cases. Seven other APP findings remain source-confirmed. These are exposure checks: **they pass when the described current defect is observed**, not when it is fixed.

- [Client/MIDI/project/close check](/Users/muzikfirst/Documents/donwellscue/audio-import-audit/evidence/app-wide-audit/client-control-check.cjs): `node /Users/muzikfirst/Documents/donwellscue/audio-import-audit/evidence/app-wide-audit/client-control-check.cjs`.
- [Native check runner](/Users/muzikfirst/Documents/donwellscue/audio-import-audit/evidence/app-wide-audit/run-native-playback-check.py) and [entrypoint](/Users/muzikfirst/Documents/donwellscue/audio-import-audit/evidence/app-wide-audit/native-playback-check.cpp): run the Python file against the already-built current headless test objects. The runner compiles only a disposable entrypoint; it does not rebuild or change the app.
- [Backup check](/Users/muzikfirst/Documents/donwellscue/audio-import-audit/evidence/app-wide-audit/backup-retention-check.py): run the Python file. It compiles the real backup implementation with inert project/logger interfaces and requires a non-root process for its unreadable-source fixture.
- [Client log](/Users/muzikfirst/Documents/donwellscue/audio-import-audit/evidence/app-wide-audit/client-results.log), [native log](/Users/muzikfirst/Documents/donwellscue/audio-import-audit/evidence/app-wide-audit/native-results.log), [backup log](/Users/muzikfirst/Documents/donwellscue/audio-import-audit/evidence/app-wide-audit/backup-results.log), [provenance](/Users/muzikfirst/Documents/donwellscue/audio-import-audit/evidence/app-wide-audit/provenance.json).

For fixes, keep one narrow desired-behavior regression at each shared boundary and run the existing affected client/native checks. Start with the common, directly exercised paths: APP-01/02/03/04/05, then the used show features and recovery paths. Test the normal workflow as well as each refusal/cancellation case. Revalidate before calling a corrected source tree ready to package.

The full release/build/hardware gates were not rerun for documentation-only output. No changes were packaged, installed or published.

Not checked: actual customer media/hardware, acoustic or physical LTC output, Windows/Linux execution, long-show soak, real storage failure frequency, GPU failures or physical A/V synchronization. This is a code audit with bounded proofs, not hardware show acceptance.
