# Video cue handoffs and control reliability

**4 November software audit:** current source `87bcd46` adds source-owned native decoder workers, sustained-starvation hold, busy-retry refusal and active-worker retirement; the Preview/live-edit cancellation and revision-fenced Preview exclusion from audience video remain. Native 13/13, isolated API 61/61, client 222/222, typecheck, RT/live safety and the address-sanitized audio-output suite pass. This batch changes no Vue/Electron source. The earlier ten-minute muted mixed-video soak at `153a1a7` passed 481 SD/1080p rounds; that historical measurement was not repeated. See the [current workplan](superpowers/plans/2026-11-03-live-show-reliability.md). No installed release or physical acceptance is claimed.

Initial investigation: 2026-11-03 against the working tree based on `82505580ccb6ae86ccb71e28264b6d4436641419`. The reported pattern was that a standalone video usually worked, while playing video before or after audio/another video caused freezing, loss of control, and apparent crashes. Existing audio/import/Spotify changes were retained.

The 3 November source was checkpointed in `2ea5984` and `a9a86a3` (package metadata 2.6.17). Later T20/T21/T26–T29 repairs supersede the initial recovery and monitoring decisions below: failure retains the existing native audience window under a black cover, **Restart Output** is operator-controlled, picture health uses decoded presentation/native-clock progress, and unrelated metadata/cue/preview events cannot re-seek the current picture. No new package has been installed or published. The bounded visibility comparison is now recorded below; physical HDMI and causal resolution of the earlier full-app frame-drop observation remain unclosed.

## Confirmed failure paths

| Failure | Evidence | Repair |
| --- | --- | --- |
| An intentional cue change was reported as video failure. | The real Chromium check captured `Video playback could not start` during an ordinary handoff. Deferred controller checks also reproduced a permanently latched failure when returning to the same video. | Invalidate old play attempts on pause/cleanup, fence promise callbacks by attempt generation, and wait for the current media's readiness before playing. |
| A background video restarted at an old timestamp. | Video A at 2 s, newer audio B, then A's native meter at 9 s: stopping B previously sought A back to 2 s. | Update every retained on-air cue's native position, including while another program cue owns the picture. |
| A newly cued item drove the preceding video's picture while its document was loading. | A at 6 s, unknown B pending a refetch, then B's meter at 0.5 s: A remained visible and was chased to B's position. | Pause and clear the old projection until the newest cue's metadata resolves. |
| Confidence readbacks overlapped and outlived their output window. | Three timer ticks produced three unresolved `capturePage()` requests; closing/recreating output still allowed old frames to publish. | Permit one capture in flight per window/timer generation and discard retired completions. A rejected capture releases the slot for the next tick. |
| A failed output renderer remained armed and appeared open without an error. | Simulated `render-process-gone(crashed,139)` previously produced no status update and left the window/session active. | Preserve reason/exit code, retain the audience window under a native black cover, and restore control-window access. An explicit **Restart Output** replaces the failed renderer; the cover remains until the replacement view is ready. |
| Retired output lifecycle events could clean up a replacement's resources. | Delayed close/load/crash callbacks could release the new capture timer, power ownership or diagnostic connection. | Detach an output's owned resources before destruction; identity-fence subsequent callbacks. Normal cue changes do not move focus. |
| Slow video downloads blocked control networking. | A paused whole-file reader delayed an already-connected WebSocket's command acknowledgment for more than 2 s. The installed Crow transport uses synchronous writes for both general and static-file responses. | Repair and verification are recorded with the native transport patch described below. |

Independent review also reproduced a meter/stop-edge ordering bug: a Stopped background video could become the fallback before its `cue_state` edge arrived. Stopped normal cues are now removed before selection, including during device-health loss; removing the displayed cue immediately selects the remaining picture or clears to idle. Diagnostic transport retains its separate behavior.

## Native response transport

`server/cmake/CrowAsyncHttp.cmake` applies `server/patches/crow-async-http.patch` to build-local copies of Crow 1.3.2's connection, parser and response headers. The original dependency tree is untouched. Original and patched SHA-256 values are checked; an unsupported version, skipped patch or unexpected output fails configuration. The copied umbrella header ensures the compiler uses one consistent set of types. The upstream BSD license is retained in `server/patches/crow.LICENSE`.

General response bodies remain connection-owned until asynchronous completion. Static media uses one connection-owned 16 KiB chunk buffer. Reading another request waits for the prior write, including a second request already present in the same TCP read buffer. The existing HTTP parser stops at each complete request and exposes its consumed-byte count; no new framing parser, per-request thread or networking library was added. Early route responses, HEAD lengths and `100 Continue` retain valid framing. Existing authentication, MIME types and bounded byte-range behavior remain in the same endpoint.

The slow-reader regression holds an actual native-server media socket without consuming its body and checks an existing WebSocket's transport acknowledgment. A separate health request could be accepted by another worker and miss the stall. Whole-file starvation was reproduced on this host; its 16 MiB ranged response fit the local socket buffers, so range-specific starvation was established by the shared write path rather than a failing timing assertion. Both paths pass after the asynchronous repair.

## Why these changes fit the failure

Chromium's `play()` returns a promise that can reject when a later pause or source load interrupts it. This is expected during cue handoffs and must not become a terminal error for the next playback attempt. The application's fix uses attempt ownership rather than a retry timer. [Chrome's explanation and reproduction](https://developer.chrome.com/blog/play-request-was-interrupted/).

Electron exposes asynchronous capture promises and renderer-loss details. Captures need bounded ownership, and renderer loss needs visible recovery. These changes reuse the existing status shape and window controls; no new IPC surface or automatic show restart was added. [Electron capture API](https://www.electronjs.org/docs/latest/api/web-contents#contentscapturepagerect-opts), [renderer-loss event](https://www.electronjs.org/docs/latest/api/web-contents#event-render-process-gone).

The installed Crow response writer blocks while writing to a client socket. Reducing a response's range window limits allocation but does not change that blocking behavior. Asynchronous socket writes require response buffers to remain owned until completion and queued requests to wait before reusing those buffers. The native fix is restricted to that shared transport boundary. [Crow response implementation](https://github.com/CrowCpp/Crow/blob/master/include/crow/http_connection.h), [Asio asynchronous write contract](https://think-async.com/Asio/asio-1.30.2/doc/asio/reference/async_write/overload1.html).

## Verification

The focused controller and Electron lifecycle tests are part of the existing client gate:

```sh
npm run check:client
npm run typecheck --workspace=client
npm run build:client
```

A separate desktop-host check exercises the production `useVideoOutput` controller inside a real Electron/Chromium renderer with generated H.264 media:

```sh
node --test scripts/video-transition-playback.test.js
```

It uses a temporary local HTTP fixture and its own user-data directory/window. It holds the first media response to exercise cancellation, then checks video→audio→same-video, video replacement, paused seek, Resume, ten rapid audio/video alternations, continuing `requestVideoFrameCallback` presentation, renderer clock responsiveness, and absence of terminal playback errors. Cue/clock messages are synthetic; this is not a packaged-app or physical-interface acceptance test. The test closes its window and removes its temporary media.

For native changes, rebuild before running integration:

```sh
cmake --build server/build -j4
ctest --test-dir server/build --output-on-failure
npm run test:server-integration
```

Red/green logs and final suite results are retained in the parent workspace's audit evidence folder. Byte-range, whole-file, HEAD, interrupted-reader and pipelined-request checks cover media framing and control responsiveness.

Final results: all 20 controller tests and 36 Electron/diagnostic/ownership checks passed through the complete client gate; TypeScript and production generation passed. The real Chromium transition check passed with new decoded-frame presentations after rapid handoffs. Native CTest passed all 12 suites; the complete server integration run passed all 13 tests (including nested protocol checks). The separately AddressSanitizer-instrumented server passed all 10 control-server integration checks with no sanitizer diagnostic reports.

The native reconnect-snapshot assertion now opens its snapshot connection after both accepted plays. Snapshots are emitted on connection, so the former test could receive an empty snapshot before playback and then wait forever for a second snapshot that the protocol does not send. Sanitizer verification enables the existing decoder test hooks used by the standard integration build; reused third-party libraries were not rebuilt with sanitizers.

## Evidence boundary

The controller failures and network-control stall were reproduced. An OS/GPU/codec process crash from the user's actual show was not reproduced: no matching current Electron crash report was found, and older server EPIPE/connection-reset messages alone do not establish a crash. The later T20 check also exercises an actual disposable Electron renderer crash and busy loop, verifying the retained cover and explicit restart; this is software evidence rather than a physical audience-display test. No speculative GPU switch, hardware acceleration disable, codec substitution, or unresponsive timeout was introduced.

Physical HDMI/display hotplug, HEVC/hardware decoding, sustained large-show playback, Windows/Linux execution and a newly packaged installer still require deployment testing. Filesystem reads remain synchronous, so a stalled disk or network-mounted file can still delay its I/O worker; the transport fix addresses socket backpressure. These changes remain local and have not been installed or published.

## Mixed-media software soak (T40)

The existing isolated Chromium fixture now supports an optional sustained run:

```sh
DWCUE_VIDEO_SOAK_SECONDS=600 node --test scripts/video-transition-playback.test.js
```

The 4 November run passed 600.932 wall-time seconds: 481 audio-to-video rounds alternating generated 320×180 and 1920×1080 H.264 clips, plus 161 video-to-video handoffs. It observed 17,349 presentation callbacks, a continuing renderer/control clock, recent picture presentation and no unexpected terminal playback error. The deliberate corrupt-file refusal also passed afterward. Videos have no audio track, the element is muted, and cue/native-clock messages are synthetic; this uses its own sandboxed Electron window and temporary files, not a saved show or native audio server.

Primary per-load counters recorded 381 dropped / 18,713 total frames; additional handoff clips recorded 16 / 1,176. Ready picture plus five observed frames took median 110ms, p95 136ms, maximum 164ms; this is not first-frame GO latency. Renderer working set ranged 130,176–141,200KB and GPU working set 75,552–81,872KB. Per-resolution first/last 30-sample renderer medians rose by about 1.2MB (SD) and 1.0MB (HD). These measured drops and memory samples remain explicit limits: ten minutes of generated clips does not prove long-show stability, arbitrary codec support, native A/V synchronization or physical display behavior. No production video code changed for this coverage extension.

## Visibility-controlled sample comparison

The remaining software workplan check completed on 4 November against unchanged application source `153a1a7`: four serial five-minute cells compare the current controller with a plain Chromium video element, both visible and behind an owned opaque test window. This reuses the existing rehearsal copy of the downloaded 1080p H.264 sample, remuxed without re-encoding into a disposable video-only file. Cue/native-clock messages are synthetic and monotonic. The element is muted; no native audio server, live user app/show, original download or physical endpoint is operated. Electron 42.8.0 / Chromium 148.0.7778.280 and a 1 Hz screenshot cadence are used throughout.

| Playback | Window | Frame callbacks | Dropped / total frames | Additional seeks | Renderer working set (KB) |
| --- | --- | ---: | ---: | ---: | ---: |
| Controller | Visible | 9,004 | 0 / 9,005 | 0 | 129,280 |
| Controller | Covered | 9,010 | 0 / 9,009 | 0 | 136,816 |
| Plain element | Visible | 9,010 | 0 / 9,010 | 0 | 138,960 |
| Plain element | Covered | 9,005 | 0 / 9,005 | 0 | 138,080 |

All four cells last at least 300 s, advance the media/control clocks and record 300 screenshot samples each. Total fixture wall time is 1,205.71 s, with 36,029 presentation callbacks. Callback delivery and playback-quality counters are separate samples; neither is a physical scanout measurement. Source/controller/fixture hashes and all four complete result records are verified. The rehearsal copy remains byte-identical; owned processes and temporary remux files are removed.

Cover plus capture keeps DOM visibility **visible**, so this does not test hidden/minimized throttling. Fixed ordering uses different clip segments for visible and covered cells; memory endpoints are cumulative within one renderer. These results establish bounded covered-window cadence evidence, not causal visibility/T26 attribution, leak freedom, native soundtrack synchronization, physical HDMI behavior or a full-show pass. The earlier actual-app frame-drop cause remains unresolved. No production playback change is justified by this comparison.

The local evidence folder `audio-import-audit/evidence/workplan-finish-2026-11-04/` contains the report, runnable reused fixture/wrapper, full logs/results and integrity manifests. One fresh read-only review found no Important/Critical fixture issue; the parent verified the complete final result after review. All software workplan checkboxes are complete; T24 actual-system acceptance stays deferred.
