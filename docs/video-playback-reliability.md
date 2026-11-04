# Video cue handoffs and control reliability

Initial investigation: 2026-11-03 against the working tree based on `82505580ccb6ae86ccb71e28264b6d4436641419`. The reported pattern was that a standalone video usually worked, while playing video before or after audio/another video caused freezing, loss of control, and apparent crashes. Existing audio/import/Spotify changes were retained.

Current source is checkpointed in `2ea5984` and `a9a86a3` (package metadata 2.6.17). Later T20/T21/T26–T29 repairs supersede the initial recovery and monitoring decisions below: failure retains the existing native audience window under a black cover, **Restart Output** is operator-controlled, picture health uses decoded presentation/native-clock progress, and unrelated metadata/cue/preview events cannot re-seek the current picture. No new package has been installed or published; physical HDMI and the earlier long-run frame-drop observation remain unclosed.

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
