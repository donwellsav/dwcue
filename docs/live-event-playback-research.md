# Live event playback: research and measured findings

**Current implementation status:** the research below preserves the original 3 November decision record and probe results. Its five proposed follow-ups and intake repairs were implemented through T18–T25; T26–T30 add video-continuity and secondary-clock corrections. Local commits `2ea5984` and `a9a86a3` checkpoint the result. Use the [workplan](superpowers/plans/2026-11-03-live-show-reliability.md) for current completion and evidence boundaries. Physical acceptance is line-level audio and 1080p through HDMI or an HDMI adapter; those tests remain deferred. No installed/published-release claim follows from this research.


Research completed 3 November 2026 against `/Users/muzikfirst/Documents/donwellscue/dwcue`, baseline commit `82505580ccb6ae86ccb71e28264b6d4436641419` with the existing uncommitted reliability fixes retained. This report concerns corporate shows receiving unfamiliar media at short notice, usually delivered on removable storage and copied locally. The show computer, operating system, delivery codecs and physical output chain are not specified.

This is an evidence and decision record. The application was not changed during this research pass. Isolated probes use synthetic media, temporary data and separate processes; they do not touch a saved show. Earlier fixes and their verification remain documented in [video reliability](video-playback-reliability.md) and [audio reliability](audio-playback-reliability.md).

## Original decisions on the proposed follow-ups

**Yes: all five address real gaps, but background preparation needs a narrower decision than “add another player.” Two intake problems also deserve immediate attention.** “Do now” below identifies a justified requirement; it is not a claim that the change has been implemented.

| Question | Decision | Evidence and concrete direction |
| --- | --- | --- |
| Prepare the next video during playback? | **Measure first; reuse the existing element where eligible.** | The active-cue guard suppresses preparation during audio as well as video. During some audio cues the video element could be available, but shared seek state and retained video fallbacks prevent a safe one-line guard removal. Video→video preparation needs separately retained state/resources. Quantify the benefit and contention before choosing two decoders. |
| Move media reads off control workers? | **Do now.** | A controlled 2.5-second read stall delayed a co-located `stop_all` acknowledgement by approximately 2.5 seconds. Both Range and whole-file serving reproduced it. Copy, metadata and waveform work also use control workers; the requirement must cover that shared boundary. |
| Replace screenshot freshness as picture health? | **Do now.** | The current controller can keep reporting visible/unpaused after frame callbacks cease. The chip stays healthy with fresh timestamps carrying an unchanged frame payload. Use presentation/PTS progress and separate renderer responsiveness, gated by expected playback state. |
| Recover a renderer that hangs without exiting? | **Do now, with deliberate operator recovery.** | A process-exit handler cannot handle a live, stuck renderer. Electron exposes separate responsiveness events. Recovery must work through the main process and keep a controlled audience surface; restarting must not silently replay the cue. |
| Improve crash evidence and extended validation? | **Do now.** | Present tests establish selected races and short synthetic playback, not arbitrary deliveries or output-chain behavior. Bounded local diagnostics should identify cue/file revision, codec, frame progress and process/GPU events so the next incident is diagnosable. |
| Retain black/standby output through renderer failure? | **Do now.** | The current crash handler destroys the audience window. Electron already provides a plain native `View` that can display black without a web renderer. An isolated renderer-kill probe retained such a view and responsive controls. Physical blackout timing and GPU-failure behavior remain unverified. |
| Validate incoming copy completion and actual-player compatibility? | **Do now; this is especially relevant to this workflow.** | An unfinished WAV passed the current copy/metadata/waveform checks and left a shortened project copy. Separately, the installed development runtime decoded the H.264/HEVC fixtures but rejected ProRes. Finding a stream with FFmpeg does not establish browser video readiness. |

## What the new probes actually established

### 1. A disk read can delay Stop even after asynchronous socket writes

The native investigator intercepted `fread` **only for one uniquely named temporary fixture** in an isolated server child and delayed it by 2,500 ms. Two WebSocket clients covered the server's assigned accept workers. A media request then exercised the real `/api/media` route.

For the co-located client, the `stop_all` acknowledgement took approximately **2,509 ms for a Range response** and **2,497 ms for a whole-file response**. The other client remained around **0.18–0.22 ms**; after the stall both were below 1 ms. Exact response bodies still arrived: 206/16 MiB and 200/20 MiB. Disconnecting the media client still left a control acknowledgement waiting approximately **2,505 ms**; graceful shutdown during the injected read took approximately **3,034 ms**. The final harness's five checks passed, including the unfinished-copy case below. [Preserved storage probe log](/Users/muzikfirst/Documents/donwellscue/audio-import-audit/evidence/live-event-research/storage/probe.log).

This establishes worker coupling under an injected storage delay. It does **not** establish that the user's external drive actually stalled, or how often a real drive would do so. Stop was exercised in isolated empty projects, so this does not measure when playing sound physically stopped: a WebSocket acknowledgement and the audio-device response are different measurements. The prior asynchronous-write patch remains useful; it removed a separately reproduced socket-backpressure problem.

The affected boundaries include [Range reads](../server/src/net/control_server.cpp:3321), [static-file streaming reads](../server/patches/crow-async-http.patch:103), and [project-media copying](../server/src/net/control_server.cpp:3062). The [storage report](/Users/muzikfirst/Documents/donwellscue/audio-import-audit/research-storage-isolation.md) traces metadata, waveform, locks and audio read-ahead as well.

### 2. Successful copy and readiness checks can accept an unfinished delivery

A temporary PCM WAV declared one second of audio but initially contained only a quarter second of payload. `/api/copy_to_media` returned 200, metadata returned `valid=true`, and waveform analysis returned 200 with 250 ms of audio. Those results satisfy the current client's readiness conditions.

After the external writer completed the source, it contained **96,044 bytes**, while the project copy remained **24,044 bytes**. The copy operation preserved the bytes available to it. The failure is accepting an unfinished source as a finished delivery.

Comparing source/destination bytes proves copy fidelity at that moment, not that the source writer is finished. A brief stable file size is also insufficient: a stalled transfer can resume. A useful intake contract needs completed publication where available, an owned local revision, and format-appropriate truncation checks. Unsupported or unverified content must have an accurate status. Silently normalizing or transcoding the supplied audio would not solve this problem.

### 3. Screenshot delivery and picture progress can disagree

The renderer investigator exercised the current controller with eight advancing native meter updates while withholding all further video-frame callbacks. The result still had `showVideo=true`, `paused=false`, one outstanding callback and no reported playback error. A watchdog that runs only inside the callback cannot detect the callback stopping.

A separate current-component probe supplied eight fresh timestamps with the same synthetic nonempty `jpeg` field. The confidence chip's `stale` value stayed false. The probe did not decode or render a JPEG; it establishes that the component's health decision uses timestamp freshness rather than frame progress. Actual screenshot delivery is also insufficient evidence of progressing video.

The correction needs distinct observations: screenshot delivery; video presentation/PTS progress; renderer/event-loop responsiveness; and physical output. For paused cues, held end frames, still imagery and low/VFR content, lack of changing pixels or callbacks can be expected. These observations should not be collapsed into one unconditional green indicator. Details and runnable checks are in the [renderer health report](/Users/muzikfirst/Documents/donwellscue/audio-import-audit/research-renderer-health.md).

### 4. The actual browser rejects some files the import probe can recognize

The coordinating probe used the installed development runtime, **Electron 42.8.0 / Chromium 148.0.7778.280 on macOS arm64**. Synthetic **1080p30 H.264** and **2160p30 HEVC** produced progressing frame callbacks. A synthetic **1080p25 ProRes MOV** returned `NotSupportedError`.

These fixtures were video-only, and the test did not run the production import UI or native audio engine. The narrower conclusion is that this runtime's decode behavior differs by codec. The source trace establishes the import boundary: [FFmpeg stream inspection](../server/src/audio/decoder.cpp:1808) sets [metadata's video flag](../server/src/meta/metadata.cpp:42) without opening a video decoder. The browser checks the source later, when it reaches the [single output element](../client/app/composables/useVideoOutput.ts:657).

The current [W3C Media Capabilities working draft, 18 October 2026](https://www.w3.org/TR/2026/WD-media-capabilities-20261018/) distinguishes configuration support and predicted smooth/power-efficient decoding. Those are useful hints; they do not inspect a supplied file for corruption or prove sustained playback. Actual decode/seek evidence in the shipped player is stronger, and still only validates the portion exercised. Full-file validation has a separate time and I/O cost.

QLab's ProRes/Hap recommendations concern its own playback frameworks. They cannot serve as this app's codec policy. Converting every import or replacing the player is not justified by this one fixture result; first establish which actual client deliveries fail and preserve original files and audio levels.

### 5. A naive first-frame benchmark can give the wrong answer

The same probe alternated eight unprepared starts and eight paused-standby starts for each supported fixture, while a synthetic 1080p30 video played. Fixtures were served from memory over localhost with `no-store`; this isolates browser behavior from real storage latency. It is **not** a cold-disk test.

| Fixture | Unprepared first post-GO callback, median / max | Prepared first post-GO callback, median / max |
| --- | --- | --- |
| H.264 1080p30 | 16.5 / 18.3 ms | 45.0 / 48.7 ms |
| HEVC 2160p30 | 17.4 / 25.1 ms | 46.4 / 48.8 ms |

**Those columns measure different frames.** The unprepared callback carried media time 0. The standby element had already submitted frame zero while paused; its first callback after GO carried media time 0.033333. The larger prepared number does not establish a slower first visible frame. It demonstrates why a callback, `canplay`, or resolved `play()` promise cannot by itself establish GO-to-visible-output latency.

The standby elements reached `readyState=4` before GO. The raw `prepMs` field is an estimate computed by subtracting a nominal timer wait from elapsed time; it includes scheduling overshoot and must not be treated as pure load/decode latency. The largest observed on-air callback gap during the short preparation windows was **50 ms**, versus up to 50 ms in the baseline windows too. This small, warm, synthetic sample neither proves a useful latency improvement nor sustained contention safety. No physical-pixel sensor, native audio, nonzero in-point, sustained decoder pressure or actual customer file was used.

Reproduction: [probe source](/Users/muzikfirst/Documents/donwellscue/audio-import-audit/evidence/live-event-research/playback-probe.cjs), [raw results](/Users/muzikfirst/Documents/donwellscue/audio-import-audit/evidence/live-event-research/playback-probe-results.jsonl), [summary](/Users/muzikfirst/Documents/donwellscue/audio-import-audit/evidence/live-event-research/playback-probe-summary.json). Run `node --test /Users/muzikfirst/Documents/donwellscue/audio-import-audit/evidence/live-event-research/playback-probe.cjs` from this checkout's environment. The single isolated test passed, including its controlled renderer kill and resource cleanup.

## Which preparation mechanisms transfer from production players?

The [preparation report](/Users/muzikfirst/Documents/donwellscue/audio-import-audit/research-video-preparation.md) contains pinned source links, current local callers, detailed tradeoffs and screened arXiv results. These are materially different mechanisms:

| Current production source inspected | Mechanism | Transfer to this application |
| --- | --- | --- |
| [mpv `46787be2`, 3 Nov 2026](https://github.com/mpv-player/mpv/blob/46787be2502556586b6a5fea9ebd595f5cd9b713/player/loadfile.c#L1277-L1322) | One next-file opener stages a demuxer and compressed data; promotion checks identity/options. Playlist prefetch is off by default in the reviewed manual. | Useful bounded ownership/cancellation precedent. It does not prepare a decoded first frame or make arbitrary manual GO instant. |
| [CasparCG `f4d6970c`, 27 Oct 2026](https://github.com/CasparCG/server/blob/f4d6970c1d0e4f98c9d98f639d3db4d35b13d744/src/core/producer/layer.cpp#L38-L97) | Separate foreground/background producers with bounded decoded-frame buffering and explicit readiness. | Closest precedent for one retained standby slot. Its transition policy assumes ownership of presentation; retaining old video over independently started new audio would be wrong here. |
| [GStreamer `bc2abfa7`, 3 Nov 2026](https://github.com/GStreamer/gstreamer/blob/bc2abfa7ca3ccb78621f2251ac55713aa8e49970/subprojects/gst-docs/markdown/additional/design/playback-gapless.md#L64-L101) | Stages parsed sources around a shared decoder chain; compatible decoders can be reused. | Shows that duplicate decoders are not inevitable. That benefit comes from a coordinated native pipeline, not a second HTML tag. |
| [QLab 5 loading guidance](https://reference.qlab.app/docs/v5/other-cues/transport-cues/) | Moves startup work before the trigger, including loading to a time; recommends use for an observed performance issue. | Supports targeted preparation and measurement, not all-show caching. |

For **audio→video**, assess reuse of the existing element when no live video/fallback owns it. [Non-video application](../client/app/composables/useVideoOutput.ts:317) currently hides/pauses it but also updates shared `pendingSeekSeconds` using the audio cue's playhead. Merely allowing background loading can therefore seek the pending video to the wrong time when its metadata arrives. Some older active video cues can remain valid fallbacks, so “currently hidden” does not mean free.

For **video→video**, preparing B requires separately retained resources if A must continue. Two browser elements are one candidate, not a selected architecture. A 4K frame alone is roughly 11.9 MiB in 8-bit 4:2:0 or 31.6 MiB in RGBA; decoder reference frames, copies and buffering multiply that. Bound slot count, account for total memory/decoder pressure, invalidate by exact project/file/trim identity, and measure the on-air cue's frame/audio behavior while preparing the replacement.

The current `source_revision` is derived from cue UUID/path changes, not media bytes or modification time. Any future readiness result must be invalidated by actual file replacement and trim changes; a prepared URL alone is insufficient evidence. This is a source-level identity gap, not a reproduced wrong-file incident.

## Storage isolation: what an asynchronous API actually buys

The [storage report](/Users/muzikfirst/Documents/donwellscue/audio-import-audit/research-storage-isolation.md) compares current Nginx, libuv, Asio and FreeShow code. The practical conclusion is to keep blocking copy/probe/read work away from the workers that must accept/control playback, with bounded admission and owned response lifetimes.

On macOS, changing `ifstream` to Asio's POSIX descriptor `async_read` is not sufficient: regular-file operations can execute immediately on the calling thread. Asio's regular async-file backend support differs by platform. A bounded blocking-work executor is a plausible existing-library solution, but it still needs queue limits, stale-request handling and shutdown behavior. Timeouts can discard late results; they do not necessarily interrupt an operating-system read already in progress.

The existing audio read-ahead worker is not an appropriate general pool for web media/copy jobs: it already serves native audio. Moving all work onto it would connect additional stalls to the audio deadline. Likewise, unbounded per-request threads merely move resource exhaustion elsewhere. Separate work submission does not create additional disk bandwidth or guarantee that a stuck filesystem call can be canceled.

There is a further source-level audio boundary: [one shared decoder worker](../server/src/audio/engine.cpp:1902) fills the active cues' 16-slot PCM queues. At 256 frames per block and 48 kHz, a full queue represents approximately **85.3 ms**, even though priming requests two seconds before clamping to available slots. A blocked decoder could therefore prevent other active cues from refilling. Some seek/prime operations also execute under control/lifecycle locks. These paths were traced but not subjected to live-audio fault injection here; moving HTTP work alone would not establish complete audio/control isolation.

FreeShow's [recent MP4-probe change, merged 30 Oct 2026](https://github.com/ChurchApps/FreeShow/pull/3939) is a directly adjacent example: it reads requested MP4 portions asynchronously instead of blocking the Electron main process. It supports isolating intake work as well as stream delivery; its fix does not establish the cause of our reported video crash.

## Audience protection and recovery failure domains

[The current handler](../client/electron/main.js:2642) calls [the close path](../client/electron/main.js:2693), which destroys the audience window. A real fullscreen output can therefore lose its covering surface. Desktop exposure on the audience hardware has not been directly observed in this research.

QLab documents keeping a black stage background between cues, explicitly to obscure the desktop; its NDI/Syphon output lifetime is managed separately. That is useful evidence for treating output continuity as distinct from media playback. It is not a guarantee of protection through every kind of crash. [QLab 5 video output](https://qlab.app/docs/v5/video/video-output/).

Electron 42.8 already has a [plain native `View`](https://github.com/electron/electron/blob/v42.8.0/docs/api/view.md) controlled by the main process. [Its implementation](https://github.com/electron/electron/blob/v42.8.0/shell/browser/api/electron_api_view.cc#L481-L485) sets a native solid background. A black surface can therefore be independent of JavaScript/decoding in the program renderer, without another HTML renderer or a new dependency. A native cover inside the existing window is worth evaluating before introducing a replacement windowing architecture.

The coordinating prototype used a `BaseWindow`, two `WebContentsView`s in separate partitions, and a plain black `View`. It verified distinct control/program process IDs, forcibly killed only the program renderer, and asserted that the parent window and native cover remained, that the cover was still topmost after retiring the failed view, and that the control renderer answered correctly. **These are lifecycle/ownership checks; they do not measure black pixels on a display.** The prototype is not a shipped output-window implementation or a reason by itself to migrate the app to `BaseWindow`.

| Failure | Useful containment | Boundary of that containment |
| --- | --- | --- |
| Decoder/presentation stops, renderer still responds | Observe frame/PTS progress separately from JPEG delivery; expose a deliberate black/recovery action. | Static/paused/low-frame-rate content must not be mistaken for failure. Automatic restart or Stop from an ambiguous observation is unjustified. |
| Program renderer hangs or exits | Main-controlled native cover and operator controls outside the failed renderer; preserve audience window/display ownership while replacing failed content. | Renderer-process isolation must be checked. Electron warns that forcibly crashing one renderer can affect other WebContents sharing it. |
| Chromium GPU process fails | Preserve local crash/process evidence and exercise the fault separately. | Multiple renderers share GPU facilities; a second HTML window is not an independent GPU. The native cover's physical behavior under this fault remains untested. |
| Main application, OS or machine fails | Physical downstream blackout/standby or independent backup, if that guarantee is required. | An application-owned surface disappears with its owning application. Software window recovery cannot guarantee the audience signal through all failures. |
| Display disconnects or its identity changes | Preserve operator access and require valid audience routing before presenting again. | A missing physical display cannot be covered. A fallback surface must not silently take over the operator's screen. |

Blackout and Stop have different meanings: obscuring picture must remain possible without changing unrelated audio or advancing a cue. Recovery must preserve an explicit failure state and avoid an implicit new GO. Native-audio behavior and automatic-follow behavior when picture fails need a stated policy; reloading a renderer is not an adequate policy by itself.

## What arXiv contributes, and its limits

The useful research here concerns observation, resource contention and measurement. Streaming recommender algorithms and generated replacement frames do not solve faithful, operator-ordered show playback. The detailed reports identify abstract-only screens; the full-text observations below concern the relevant methods, results and limitations rather than an independent replication.

| Primary paper | Method/result actually reviewed | Transfer and limitation |
| --- | --- | --- |
| [Xue, Erkin & Wang, arXiv:1411.1705v1](https://arxiv.org/html/1411.1705v1), 5 Nov 2014, full text | Models perceptual jerkiness using freeze counts/durations, spacing and frame differences. Reports 54 training and 14 separate test videos, with correlations above .9/.8. Explicitly discusses false alarms and low-motion ambiguity in pixel-difference freeze detection. | Supports rejecting screenshot-change as sole health evidence. Its quality predictor does not identify a stuck Electron renderer, prove projector output, or justify adding a neural model. This is older methodological evidence, not a current implementation prescription. |
| [Provost et al., arXiv:2602.17381v1](https://arxiv.org/html/2602.17381v1), 19 Feb 2026, full text | Uses synchronized physical sensing and LED/phototransistor measurements; calibrates sensor/scheduling baseline error before field trials. Reports roughly .5 ms baseline precision for its optical path and 4 ms for its combined end-to-end setup. | Transfer the separation of control, software presentation and physical-output timing, plus calibration. A flash/beep/physical capture can reveal PA/projector delay hidden from callbacks. Vehicle/network timings and human driving thresholds do not set a corporate-show GO or A/V limit. |
| [QWin, arXiv:2106.09206](https://arxiv.org/abs/2106.09206), June 2021, assessed in storage research | Tail-latency-aware CPU-core allocation at shared storage; dedicated queues/threads still contend for cores. | Supports checking contention after moving work to a pool. Its data-center resource allocator is not a desktop playback component or a quantitative prediction for this app. |
| [Collignon et al., arXiv:2511.16177v1](https://arxiv.org/html/2511.16177v1), 20 Nov 2025 | Regulates client I/O rates with a PI controller in a multi-node, write-intensive HPC workload; reports up to 20% lower runtime and improved tail behavior. | Supports measuring/admitting background copy, scan and preload load. It does not justify importing its controller or performance percentages into this read-dominated desktop player. No local reproduction of its gains was performed. |

## Evidence needed before claiming show readiness

These are falsifiable research questions and evidence boundaries, not a rollout schedule:

- **Correct GO:** measure GO receipt, native audio onset/playhead, requested in-point, source/seek completion, first correct submitted frame and first physically visible frame. Test zero and nonzero in-points, repeated same-file GO, different GOPs/codecs/resolutions and a last-second change of target. Keep median, tail and worst observations; eight warm starts do not establish a p95 or maximum guarantee.
- **Control under load/failure:** repeat the injected stall while measuring receipt, dispatch, state application and physical audio response to Stop separately. Recovery/Blackout must remain reachable when output JavaScript is deliberately hung. A media timeout must not be reported as cancellation of a running OS read.
- **No collateral damage:** track current-cue frame intervals, native audio underruns, memory pressure and queued background work while copying, probing and preparing other files. Prep that improves B while damaging on-air A fails this requirement.
- **Truthful health:** withhold callbacks while native time advances; freeze the renderer event loop; continue fresh JPEG captures; pause legitimately; hold a still; exercise low/VFR material. These must produce distinct, explainable states and no unexpected replay/advance.
- **Delivery integrity:** test a growing file, stalled/resumed copy, truncation, unsupported codec, same-path replacement, missing external drive, relink and project change. A stale probe result must not mark a new file or trim position ready.
- **Real signal chain:** measure the actual PA and projector/LED path, refresh rate, display reconnect and extended show-length operation using representative deliveries. A camera/optical/audio measurement must state its own timing precision. Neither `capturePage` nor a frame callback certifies the HDMI path.

No universal millisecond deadline is asserted here: no researched source establishes one for this exact independent-native-audio/browser-video architecture, and the target show system is unspecified. A numeric acceptance budget must describe what is timed and be exercised on that system. Zero failures in a short synthetic test is evidence of those tested cases, not proof of readiness for arbitrary last-minute media.

## Research artifacts

- [Video preparation / GO, pinned production implementations and current callers](/Users/muzikfirst/Documents/donwellscue/audio-import-audit/research-video-preparation.md).
- [Storage isolation, incomplete-copy reproduction and platform-specific async-file limits](/Users/muzikfirst/Documents/donwellscue/audio-import-audit/research-storage-isolation.md).
- [Renderer health, recovery, process/GPU evidence and false-health probes](/Users/muzikfirst/Documents/donwellscue/audio-import-audit/research-renderer-health.md).
- [Coordinating probe and raw measurements](/Users/muzikfirst/Documents/donwellscue/audio-import-audit/evidence/live-event-research/playback-probe.cjs).

Only research documentation and isolated probe artifacts were added in this pass. No new playback behavior, dependency, installer, commit, push or PR was created.

Not checked: the actual show machine/media, sustained dual-decoder performance, physical blackout timing, real failing USB storage, GPU crash recovery, target Windows hardware, or calibrated PA/display synchronization. Those remain material evidence gaps.

## Implementation measurements, 3 November 2026

The historical research above preceded implementation. The [workplan](superpowers/plans/2026-11-03-live-show-reliability.md) and [execution ledger](superpowers/plans/2026-11-03-live-show-reliability-progress.md) now track the tested local repairs.

`node --test scripts/video-transition-playback.test.js` exercises the production controller in installed Electron 42.8.0, generated 320×180 H.264 at 30 fps, authored 1.25 s preparation, and a single experimental 1920×1080 H.264 standby element. It records compositor frames after GO for the correct source/position, not metadata/currentTime alone. HTTP fixture media opening is deliberately delayed 250 ms; this isolates how much of that work preparation can move before GO. It is not a physical-output or representative-codec benchmark.

| Three-sample observation | Correct incoming compositor frame after GO |
| --- | --- |
| Original active-cue preload guard | 262.6 / 264.3 / 263.2 ms |
| Temporary single-element audio-bed prototype | 33.2 / 32.9 / 31.8 ms |
| Final single-element repair | 32.6 / 30.6 / 34.1 ms |

The audio-bed runs retained existing picture visibility and prepared the correct revision at the authored In point. Same-file trim edits re-seek preparation; an on-air/paused video keeps its source. The isolated two-element experiment preserved the current source, advanced 11 current frames during preparation, and reported zero current dropped frames in the final sample (one in the baseline sample). These samples do not establish sustained dual-decoder cost on arbitrary late deliveries. The production change therefore reuses the existing element during audio/still cues; no second production decoder was added.

T20's real Electron fixture also retains the same native black View/window through actual renderer termination and busy-loop restart, with a separate operator renderer responding. T21 records compositor frame time/counters separately from capture/renderer messages. T22's exact revision and settled decode/seek evidence is bounded to the loaded source/position; the unplayable-file fixture loses readiness and reports failure. None observes physical scanout or proves complete-file compatibility, shared GPU survival or cold-prime hard deadlines. T24 retains those actual-system checks.

Final review exposed an eligibility flaw: an older active video remains the fallback owner while newer audio holds the picture. The production guard now preserves every such active/paused owner. The first benchmark retained older active video entries and therefore did not establish safe eligibility. The corrected benchmark retires them before each audio-bed comparison: cold 266.1/268.1/266.7 ms, safe warm 34.0/29.9/32.3 ms; all warm sources decoded/settled at 1.25 s before GO. A regression verifies immediate fallback at the latest native clock with an upcoming video armed. The final two-element experiment observed ten current frames during 312 ms preparation, zero current drops and 25.7 ms standby GO. No second production element was adopted. Corrected raw logs supersede the first eligible-warming interpretation and are retained as `dwcue-review-preparation-{baseline,final}.log` in the continuation evidence folder.
