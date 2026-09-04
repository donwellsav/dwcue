// ============================================================================
// useVideoOutput.ts — playback brain of the ?videoOutput=1 render surface.
//
// The Video Output window is a PASSIVE renderer (spec VIDEO_PLAYBACK_V1.md
// §3/§6): the C++ engine is the single clock master, this composable never
// makes transport decisions — it chases the engine's playhead. It consumes:
//
//   • cue_state edges (start/pause/stop, carry item_uuid) — start/stop/cut
//   • meters broadcast (~60 Hz per-cue playhead_seconds) — the chase feed
//   • playback_snapshot / doc_patch — reconnect catch-up + project mirror
//   • GET /api/project — the document mirror (items + settings + folderPath)
//
// Layer resolution (bottom → top): black < standby image < per-cue image <
// video. The view binds this composable's refs; only top layers toggle, so
// lower layers show through automatically (an audio-only cue with no image
// reveals the standby image, and so on).
//
// Hard rules carried over from the spec (Inkue/FreeShow war stories):
//   - NEVER disturb the audio path; chase the video side only.
//   - A decode failure degrades to the image layers, never to a stuck window.
//   - Nothing here animates continuously; per-frame work is number math and
//     at most a playbackRate assignment.
// ============================================================================

import type { MetersBroadcast } from '~/types/server';

// Server's TransportState enum (mirrors C++, same values as useAudioEngine).
// Playing/FadingIn/FadingOut need no constants here: every transport that is
// not Stopped or Paused means "picture rolling".
const TRANSPORT_STOPPED = 0;
const TRANSPORT_PAUSED  = 4;

// Chase tuning (spec §6): deadband below which playbackRate stays exactly 1,
// a soft zone corrected with a 0.97–1.03 playbackRate nudge, hard seek beyond.
const CHASE_DEADBAND_S = 0.015;
const CHASE_HARD_SEEK_S = 0.08;

// The only item fields the output surface consumes, normalised once from the
// server document (which is untyped JSON) so everything downstream is typed.
interface OutputItem {
  uuid: string;
  hasVideo: boolean;
  imagePath: string | null;
  mediaPath: string | null;
  mediaServerPath: string | null;
  inPoint: number;
}

interface DocMirror {
  folderPath: string | null;
  standbyImage: string | null;
  items: ReadonlyMap<string, OutputItem>;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Validate-once extraction of the three document fields this window needs.
// Anything malformed degrades to "no document" — the surface stays black
// rather than throwing mid-show.
function readDoc(value: unknown): DocMirror | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const items = new Map<string, OutputItem>();
  const walk = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const uuid = readString(item.uuid);
      if (uuid) {
        items.set(uuid, {
          uuid,
          hasVideo: item.hasVideo === true,
          imagePath: readString(item.imagePath),
          mediaPath: readString(item.mediaPath),
          mediaServerPath: readString(item.mediaServerPath),
          inPoint: readNumber(item.inPoint) ?? 0,
        });
      }
      walk(item.items);   // group children
    }
  };
  walk(record.items);
  const settings = record.settings;
  return {
    folderPath: readString(record.folderPath),
    standbyImage: readString(
      settings && typeof settings === 'object'
        ? (settings as Record<string, unknown>).videoStandbyImage
        : null),
    items,
  };
}

// cue_state carries item_uuid (the payload type in useLiveplayServer predates
// that field); the meters frames are typed in ~/types/server.
interface CueStateEvent {
  cueId: string | null;
  itemUuid: string | null;
  transport: number;
  playheadSeconds: number;
}

function readCueState(value: unknown): CueStateEvent | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;
  const transport = readNumber(s.transport);
  if (transport === null) return null;
  return {
    cueId: readString(s.cue_id),
    itemUuid: readString(s.item_uuid),
    transport,
    playheadSeconds: readNumber(s.playhead_seconds) ?? 0,
  };
}

// One sounding cue as reported by playback_snapshot.cues[]. The snapshot is
// the only way a (re)connecting output window learns about a cue that is
// already playing — cue_state edges only fire on transitions, so without
// restoring from it the screen would sit black until the next cue started.
interface SnapshotActive {
  itemUuid: string;
  cueId: string | null;
  transport: number;
  playheadSeconds: number;
}

export function useVideoOutput() {
  const server = useLiveplayServer();

  // ---- Element + layer state (bound by VideoOutputView) --------------------
  const videoEl = ref<HTMLVideoElement | null>(null);
  const videoSrc = ref<string | null>(null);
  const videoReady = ref(false);    // canplay fired for the current src
  const videoFailed = ref(false);   // decode error on the current src
  const showVideo = ref(false);
  const cueImageSrc = ref<string | null>(null);

  // ---- Document mirror ------------------------------------------------------
  // The output window's useProject never hydrates (its sync block is gated
  // off), so we keep our own read-only mirror: one full fetch on (re)connect,
  // debounced refetches on any doc_patch. Show-time patches are rare (edits
  // happen in rehearsal), and a local GET of a small document is cheap.
  const doc = shallowRef<DocMirror | null>(null);

  // A snapshot-restore that arrived before the document finished fetching;
  // applied by refetchDoc once the item map is available.
  let pendingActive: SnapshotActive | null = null;

  let refetchTimer: number | undefined;
  async function refetchDoc() {
    try {
      doc.value = readDoc(await server.fetchProject());
      if (pendingActive) applySnapshotActive(pendingActive);
    } catch { /* server mid-load; the next patch retries */ }
  }
  function scheduleRefetch() {
    clearTimeout(refetchTimer);
    refetchTimer = window.setTimeout(() => { void refetchDoc(); }, 300);
  }

  // ---- Media URL resolution --------------------------------------------------
  // Mirrors the server's resolve_media_path: relative paths join the project
  // folder; absolute paths pass through. The /api/media endpoint streams any
  // local file with Range support (same trust model as /api/waveform_path).
  // HTML media elements cannot attach Authorization, so this one route accepts
  // the same access token in a query parameter as the browser WebSocket.
  function mediaUrl(pathStr: string | null): string | null {
    if (!pathStr) return null;
    let abs = pathStr;
    if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(pathStr)) {
      const folder = doc.value?.folderPath;
      if (!folder) return null;
      abs = folder.replace(/[\\/]+$/, '') + '/' + pathStr;
    }
    const base = String(server.serverUrl || '').replace(/\/+$/, '');
    const params = new URLSearchParams({ path: abs });
    const token = String(server.effectiveAccessToken || '');
    if (token) params.set('access_token', token);
    return `${base}/api/media?${params}`;
  }

  // Standby image: project-level setting, same resolution rules as item media.
  const standbySrc = computed(() => mediaUrl(doc.value?.standbyImage ?? null));

  // ---- Transport state machine ------------------------------------------------
  const activeItemUuid = ref<string | null>(null);
  const activeCueId = ref<string | null>(null);
  const activeTransport = ref(TRANSPORT_STOPPED);
  // Preview (DJ pre-listen) cues play in the engine too; they must never
  // reach the output surface.
  const previewItemUuid = ref<string | null>(null);

  // Latest position we should be at — written by cue edges and the chase
  // loop, consumed by loadedmetadata when a fresh element finishes loading.
  let pendingSeekSeconds = 0;

  function clearActive() {
    activeItemUuid.value = null;
    activeCueId.value = null;
    activeTransport.value = TRANSPORT_STOPPED;
    showVideo.value = false;
    cueImageSrc.value = null;
    const el = videoEl.value;
    if (el) {
      el.pause();
      el.playbackRate = 1;
    }
  }

  function applyItem(item: OutputItem, playheadSeconds: number) {
    cueImageSrc.value = mediaUrl(item.imagePath);

    if (item.hasVideo) {
      const url = mediaUrl(item.mediaPath) ?? mediaUrl(item.mediaServerPath);
      if (url && url !== videoSrc.value) {
        videoSrc.value = url;
        videoReady.value = false;
        videoFailed.value = false;
      }
      // The engine position is authoritative (the in-point at this edge). If
      // the element is still loading, loadedmetadata applies it instead.
      pendingSeekSeconds = playheadSeconds;
      const el = videoEl.value;
      if (el && videoReady.value &&
          Math.abs(el.currentTime - playheadSeconds) > CHASE_DEADBAND_S) {
        el.currentTime = playheadSeconds;
      }
      showVideo.value = !videoFailed.value && url !== null;
    } else {
      // Audio-only cue: no video layer; the per-cue image (if any) shows.
      showVideo.value = false;
    }
  }

  function applyTransport(transport: number) {
    activeTransport.value = transport;
    const el = videoEl.value;
    if (!el || !showVideo.value) return;
    if (transport === TRANSPORT_PAUSED) {
      if (!el.paused) el.pause();
    } else if (transport !== TRANSPORT_STOPPED && el.paused) {
      void el.play().catch(() => { /* degraded; the chase loop retries */ });
    }
  }

  // Adopt an already-sounding cue reported by a playback snapshot, following
  // the same cut rules as a live edge. When the document fetch is still in
  // flight the restore is deferred via pendingActive.
  function applySnapshotActive(active: SnapshotActive) {
    const item = doc.value?.items.get(active.itemUuid);
    if (!item) { pendingActive = active; return; }
    pendingActive = null;
    if (active.itemUuid !== activeItemUuid.value) {
      const el = videoEl.value;
      if (el) { el.pause(); el.playbackRate = 1; }
      activeItemUuid.value = active.itemUuid;
      activeCueId.value = active.cueId;
      applyItem(item, active.playheadSeconds);
    } else if (active.cueId && active.cueId !== activeCueId.value) {
      activeCueId.value = active.cueId;
    }
    applyTransport(active.transport);
  }

  const offCueState = server.onCueState((raw: unknown) => {
    const state = readCueState(raw);
    if (!state) return;
    // A live edge is fresher than any deferred snapshot restore.
    pendingActive = null;
    if (state.itemUuid && state.itemUuid === previewItemUuid.value) return;

    if (state.transport === TRANSPORT_STOPPED) {
      // Only the active cue's stop clears the surface — one-shots and other
      // cues stop around us all the time.
      if ((state.itemUuid && state.itemUuid === activeItemUuid.value) ||
          (state.cueId && state.cueId === activeCueId.value)) {
        clearActive();
      }
      return;
    }

    const item = state.itemUuid ? doc.value?.items.get(state.itemUuid) : undefined;
    if (!state.itemUuid || !item) return;   // engine-only cue, not in the document

    if (state.itemUuid !== activeItemUuid.value) {
      // Cut: a different item took over (v1 is one video at a time; the
      // newest cue wins the screen).
      const el = videoEl.value;
      if (el) { el.pause(); el.playbackRate = 1; }
      activeItemUuid.value = state.itemUuid;
      activeCueId.value = state.cueId;
      applyItem(item, state.playheadSeconds);
    } else if (state.cueId && state.cueId !== activeCueId.value) {
      activeCueId.value = state.cueId;
    }
    applyTransport(state.transport);
  });

  // ---- Chase (the only per-frame work) -----------------------------------------
  const offMeters = server.onMeters((m: MetersBroadcast) => {
    const el = videoEl.value;
    const cueId = activeCueId.value;
    if (!el || !cueId || !showVideo.value || !videoReady.value) return;
    const meter = m.items.find((i) => i.cue_id === cueId);
    if (!meter) return;

    if (meter.transport === TRANSPORT_PAUSED) {
      if (!el.paused) el.pause();
      return;
    }
    if (meter.transport === TRANSPORT_STOPPED) return;   // the edge handles it
    if (el.paused) {
      void el.play().catch(() => {});
      return;
    }

    pendingSeekSeconds = meter.playhead_seconds;
    const drift = el.currentTime - meter.playhead_seconds;
    const abs = Math.abs(drift);
    if (abs > CHASE_HARD_SEEK_S) {
      el.currentTime = meter.playhead_seconds;
      el.playbackRate = 1;
    } else if (abs <= CHASE_DEADBAND_S) {
      if (el.playbackRate !== 1) el.playbackRate = 1;
    } else {
      // Video ahead (drift > 0) → slow down; behind → catch up.
      el.playbackRate = Math.min(1.03, Math.max(0.97, 1 - drift));
    }
  });

  // ---- Preload the armed ("Up Next") item ---------------------------------------
  // Paused-load preload: the element buffers and seeks to the in-point ahead
  // of the cut, so the play edge is a same-frame play() (spec §6 step 1).
  // Never preload over a playing video — that would cut the current cue.
  const nextItemUuid = ref<string | null>(null);
  watch(nextItemUuid, (uuid) => {
    if (!uuid || activeItemUuid.value) return;
    const item = doc.value?.items.get(uuid);
    if (!item?.hasVideo) return;
    const url = mediaUrl(item.mediaPath) ?? mediaUrl(item.mediaServerPath);
    if (!url || url === videoSrc.value) return;
    videoSrc.value = url;
    videoReady.value = false;
    videoFailed.value = false;
    pendingSeekSeconds = item.inPoint;
  });

  const offSnapshot = server.onPlaybackSnapshot((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const snap = raw as Record<string, unknown>;
    nextItemUuid.value = readString(snap.next_item_uuid);

    // The snapshot carries the server's authoritative list of sounding cues —
    // the only way this surface learns about playback that started before it
    // connected. Prefer a video-bearing item; otherwise the first sounding
    // cue wins (an audio-only activation just reveals the image layers).
    const preview = snap.preview && typeof snap.preview === 'object'
      ? snap.preview as Record<string, unknown>
      : null;
    if (preview) previewItemUuid.value = readString(preview.item_uuid);

    const candidates: SnapshotActive[] = [];
    for (const entry of Array.isArray(snap.cues) ? snap.cues : []) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const itemUuid = readString(e.item_uuid);
      if (!itemUuid || itemUuid === previewItemUuid.value) continue;
      candidates.push({
        itemUuid,
        cueId: readString(e.cue_id),
        transport: readNumber(e.transport) ?? TRANSPORT_STOPPED,
        playheadSeconds: readNumber(e.playhead_seconds) ?? 0,
      });
    }
    const active = candidates.find((c) => doc.value?.items.get(c.itemUuid)?.hasVideo)
      ?? candidates[0]
      ?? null;
    if (active) applySnapshotActive(active);
    else if (activeItemUuid.value) clearActive();   // server: nothing playing
    else pendingActive = null;

    void refetchDoc();   // reconnect catch-up: the doc may have changed offline
  });

  const offDocPatch = server.onDocPatch((raw: unknown) => {
    if (raw && typeof raw === 'object') {
      const patch = raw as Record<string, unknown>;
      switch (patch.op) {
        case 'next_item_set':
          nextItemUuid.value = readString(patch.itemUuid);
          break;
        case 'preview_started':
          previewItemUuid.value = readString(patch.itemUuid);
          break;
        case 'preview_stopped':
          previewItemUuid.value = null;
          break;
        default:
          break;
      }
    }
    scheduleRefetch();
  });

  // ---- Element event handlers (bound by the view) --------------------------------
  function onVideoLoadedMetadata() {
    const el = videoEl.value;
    if (el && Math.abs(el.currentTime - pendingSeekSeconds) > CHASE_DEADBAND_S) {
      el.currentTime = pendingSeekSeconds;
    }
  }

  function onVideoCanPlay() {
    videoReady.value = true;
    // A play edge that arrived while the element was still loading.
    if (showVideo.value && activeTransport.value !== TRANSPORT_PAUSED &&
        activeTransport.value !== TRANSPORT_STOPPED) {
      void videoEl.value?.play().catch(() => {});
    }
  }

  function onVideoError() {
    // Degrade, don't fail: drop to the per-cue image / standby layer. The
    // control surface never shows a blocking error mid-show (spec §6).
    videoFailed.value = true;
    videoReady.value = false;
    showVideo.value = false;
    console.warn('[video-output] decode failed for', videoSrc.value);
  }

  // ---- Lifecycle -------------------------------------------------------------------
  const stopConnectedWatch = watch(() => server.connected, (isConnected) => {
    if (isConnected) void refetchDoc();
  }, { immediate: true });

  onScopeDispose(() => {
    clearTimeout(refetchTimer);
    offCueState();
    offMeters();
    offSnapshot();
    offDocPatch();
    stopConnectedWatch();
  });

  return {
    // element binding
    videoEl,
    videoSrc,
    onVideoLoadedMetadata,
    onVideoCanPlay,
    onVideoError,
    // layer state
    showVideo,
    cueImageSrc,
    standbySrc,
  };
}
