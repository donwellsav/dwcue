// ============================================================================
// useVideoOutput.ts — playback brain of the ?videoOutput=1 render surface.
//
// The output is a passive renderer. Audio remains the clock authority: video
// follows cue_state edges and meter positions, and it stops advancing whenever
// there is no healthy engine clock.
// ============================================================================

import type { Ref } from 'vue';
import type { MetersBroadcast } from '~/types/server';

const TRANSPORT_STOPPED = 0;
const TRANSPORT_PAUSED = 4;
const CHASE_DEADBAND_S = 0.015;
const CHASE_HARD_SEEK_S = 0.08;
const NATIVE_CLOCK_STALE_MS = 250;
const PINNED_METER_LIMIT = 2;
const NATIVE_PROGRESS_EPSILON_S = 0.001;

interface OutputItem {
  uuid: string;
  hasVideo: boolean;
  imagePath: string | null;
  mediaPath: string | null;
  mediaServerPath: string | null;
  inPoint: number;
  outPoint: number | null;
  fileRevision: string | null;
}

interface DocMirror {
  folderPath: string | null;
  standbyImage: string | null;
  items: ReadonlyMap<string, OutputItem>;
  sessionId: string | null;
}

interface ActiveCue {
  itemUuid: string;
  cueId: string | null;
  transport: number;
  playheadSeconds: number;
  triggerSeq: number;
}

interface PlaybackErrorPayload {
  itemUuid: string | null;
  message: string;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readTriggerSeq(value: unknown): number | null {
  const sequence = readNumber(value);
  return sequence !== null && Number.isSafeInteger(sequence) && sequence >= 0
    ? sequence
    : null;
}

function readDoc(value: unknown): DocMirror | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const serverInfo = record.server as Record<string, any> | undefined;
  const fileRevisions = serverInfo?.audioReadiness?.fileRevisions ?? {};
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
          outPoint: readNumber(item.outPoint),
          fileRevision: readString(fileRevisions[uuid]),
        });
      }
      walk(item.children);
    }
  };
  walk(record.items);
  walk(record.cartOnlyItems);
  const settings = record.settings;
  return {
    folderPath: readString(record.folderPath),
    standbyImage: readString(
      settings && typeof settings === 'object'
        ? (settings as Record<string, unknown>).videoStandbyImage
        : null,
    ),
    items,
    sessionId: readString(serverInfo?.projectSessionId),
  };
}

function readActiveCue(value: unknown): ActiveCue | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Record<string, unknown>;
  const transport = readNumber(state.transport);
  const itemUuid = readString(state.item_uuid);
  const triggerSeq = readTriggerSeq(state.trigger_seq);
  if (transport === null || !itemUuid || triggerSeq === null) return null;
  return {
    itemUuid,
    cueId: readString(state.cue_id),
    transport,
    playheadSeconds: readNumber(state.playhead_seconds) ?? 0,
    triggerSeq,
  };
}

export function useVideoOutput(diagnosticSource?: Readonly<Ref<VideoTestCardPlayback | null>>) {
  const server = useLiveplayServer();

  const videoEl = ref<HTMLVideoElement | null>(null);
  const videoSrc = ref<string | null>(null);
  const videoReady = ref(false);
  const videoFailed = ref(false);
  const showVideo = ref(false);
  const cueImageSrc = ref<string | null>(null);

  const doc = shallowRef<DocMirror | null>(null);
  let refetchTimer: number | undefined;
  let fetchGeneration = 0;

  const activeItemUuid = ref<string | null>(null);
  const activeCueId = ref<string | null>(null);
  const activeTransport = ref(TRANSPORT_STOPPED);
  const previewItemUuid = ref<string | null>(null);
  let previewStateRevision = -1;
  let previewStateSession = '';
  const nextItemUuid = ref<string | null>(null);
  const activeCues = new Map<string, ActiveCue>();
  let diagnosticCue: ActiveCue | null = null;
  let diagnosticItem: OutputItem | null = null;
  let activeTriggerSeq = -1;
  let highestTriggerSeqSeen = -1;
  let acceptNextSnapshot = true;
  let pendingSeekSeconds = 0;

  let sourceItemUuid: string | null = null;
  let sourceSignature: string | null = null;
  let sourceFileRevision: string | null = null;
  let sourceVersion = 0;
  let playAttemptFailed = false;
  let playAttemptGeneration = 0;
  let reportedPlaybackError: PlaybackErrorPayload | null = null;
  let noDecodableVideoTrack = false;

  const hasHealthyClock = computed(() => server.connected && server.devices.some((device) =>
    device.is_clock_master === true && device.runtime_state === 'running'));
  let waitingForHealthyClockSample = !hasHealthyClock.value;
  let waitingForNativeProgress = false;
  let lastNativeCueId: string | null = null;
  let lastNativePlayhead: number | null = null;
  let pinnedMeterCount = 0;
  let nativeProgressGeneration = 0;
  let observedProgressGeneration = -1;
  let progressFrameTimestamp: number | null = null;
  let videoFrameCallbackId: number | null = null;
  let videoFrameCallbackElement: HTMLVideoElement | null = null;
  let presentedAt: number | null = null;
  let presentedMediaTime: number | null = null;
  let presentedFrames: number | null = null;

  watch(videoSrc, () => {
    cancelFrameClockCheck();
    presentedAt = presentedMediaTime = presentedFrames = null;
  }, { flush: 'sync' });

  function getPictureHealth(): VideoPictureHealth {
    const element = videoEl.value;
    const quality = element?.getVideoPlaybackQuality?.();
    const state = videoFailed.value ? 'error'
      : !showVideo.value ? (cueImageSrc.value || standbySrc.value ? 'still' : 'idle')
      : activeTransport.value === TRANSPORT_PAUSED ? 'paused'
      : !hasHealthyClock.value || waitingForHealthyClockSample || waitingForNativeProgress ? 'clock-wait'
      : element?.seeking ? 'seeking' : !videoReady.value ? 'loading' : 'playing';
    return {
      itemUuid: activeItemUuid.value, state,
      sourceItemUuid,
      fileRevision: sourceFileRevision,
      preparedSeconds: sourceFileRevision && sourceItemUuid
        && sourceFileRevision === doc.value?.items.get(sourceItemUuid)?.fileRevision
        && (showVideo.value || nextItemUuid.value === sourceItemUuid)
        && videoReady.value && !videoFailed.value
        && currentVideoEventElement() && (element?.readyState ?? 0) >= 2 && !element?.seeking
        && Math.abs(element!.currentTime - pendingSeekSeconds) <= CHASE_DEADBAND_S
        ? pendingSeekSeconds : null,
      mediaTime: presentedMediaTime, presentedFrames,
      presentedAgeMs: presentedAt === null ? null : Math.max(0, performance.now() - presentedAt),
      droppedFrames: quality?.droppedVideoFrames ?? null,
      totalFrames: quality?.totalVideoFrames ?? null,
      readyState: element?.readyState ?? 0,
    };
  }

  function reportPlaybackError(payload: PlaybackErrorPayload | null) {
    if (payload === null && reportedPlaybackError === null) return;
    if (payload && reportedPlaybackError?.itemUuid === payload.itemUuid
      && reportedPlaybackError.message === payload.message) return;
    reportedPlaybackError = payload;
    const api = window.electronAPI?.videoOutput;
    if (!api) return;
    const report = Reflect.get(api, 'reportPlaybackError');
    if (typeof report === 'function') {
      void Promise.resolve(Reflect.apply(report, api, [payload])).catch(() => {});
    }
  }

  function pathMediaUrl(path: string | null): string | null {
    if (!path) return null;
    let absolutePath = path;
    if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(path)) {
      const folder = doc.value?.folderPath;
      if (!folder) return null;
      absolutePath = `${folder.replace(/[\\/]+$/, '')}/${path}`;
    }
    const base = String(server.serverUrl || '').replace(/\/+$/, '');
    const params = new URLSearchParams({ path: absolutePath });
    const token = String(server.effectiveAccessToken || '');
    if (token) params.set('access_token', token);
    return `${base}/api/media?${params}`;
  }

  function itemMediaUrl(item: OutputItem): string {
    const signature = `${doc.value?.sessionId ?? ''}\u0000${item.fileRevision ?? ''}\u0000${item.mediaServerPath ?? ''}\u0000${item.mediaPath ?? ''}`;
    if (sourceItemUuid !== item.uuid || sourceSignature !== signature) {
      sourceVersion += 1;
    }
    sourceItemUuid = item.uuid;
    sourceSignature = signature;
    sourceFileRevision = item.fileRevision;
    const base = String(server.serverUrl || '').replace(/\/+$/, '');
    const params = new URLSearchParams(diagnosticItem === item
      ? { path: item.mediaServerPath ?? '' }
      : { item_uuid: item.uuid });
    params.set('source_revision', String(sourceVersion));
    if (item.fileRevision) params.set('file_revision', item.fileRevision);
    if (doc.value?.sessionId) params.set('project_session_id', doc.value.sessionId);
    const token = String(server.effectiveAccessToken || '');
    if (token) params.set('access_token', token);
    return `${base}/api/media?${params}`;
  }

  const standbySrc = computed(() => pathMediaUrl(doc.value?.standbyImage ?? null));

  function cancelFrameClockCheck() {
    if (videoFrameCallbackId !== null && videoFrameCallbackElement
      && typeof videoFrameCallbackElement.cancelVideoFrameCallback === 'function') {
      videoFrameCallbackElement.cancelVideoFrameCallback(videoFrameCallbackId);
    }
    videoFrameCallbackId = null;
    videoFrameCallbackElement = null;
  }

  function scheduleFrameClockCheck() {
    const element = currentVideoEventElement();
    if (!element || videoFrameCallbackId !== null
      || typeof element.requestVideoFrameCallback !== 'function') return;
    videoFrameCallbackElement = element;
    const source = videoSrc.value;
    videoFrameCallbackId = element.requestVideoFrameCallback((timestamp, metadata) => {
      if (videoSrc.value !== source || videoEl.value !== element) return;
      onVideoFrame(timestamp, metadata);
    });
  }

  function onVideoFrame(timestamp: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) {
    videoFrameCallbackId = null;
    videoFrameCallbackElement = null;
    if (metadata && Number.isFinite(metadata.mediaTime)) {
      presentedAt = timestamp;
      presentedMediaTime = metadata.mediaTime;
      presentedFrames = metadata.presentedFrames;
    }
    if (activeTransport.value === TRANSPORT_STOPPED
      || activeTransport.value === TRANSPORT_PAUSED || !showVideo.value
      || !hasHealthyClock.value || waitingForHealthyClockSample
      || waitingForNativeProgress) return;

    if (observedProgressGeneration !== nativeProgressGeneration) {
      observedProgressGeneration = nativeProgressGeneration;
      progressFrameTimestamp = timestamp;
    } else if (progressFrameTimestamp !== null
      && timestamp - progressFrameTimestamp >= NATIVE_CLOCK_STALE_MS) {
      waitingForNativeProgress = true;
      pauseVideo();
      return;
    }
    scheduleFrameClockCheck();
  }

  function beginNativeClockGrace(cueId: string | null, playheadSeconds: number) {
    lastNativeCueId = cueId;
    lastNativePlayhead = playheadSeconds;
    pinnedMeterCount = 0;
    waitingForNativeProgress = false;
    nativeProgressGeneration += 1;
    observedProgressGeneration = -1;
    progressFrameTimestamp = null;
    cancelFrameClockCheck();
  }

  function recordNativePosition(cueId: string, playheadSeconds: number, countPinned = true): boolean {
    const advanced = lastNativeCueId !== cueId || lastNativePlayhead === null
      || Math.abs(playheadSeconds - lastNativePlayhead) > NATIVE_PROGRESS_EPSILON_S;
    if (advanced) {
      lastNativeCueId = cueId;
      lastNativePlayhead = playheadSeconds;
      pinnedMeterCount = 0;
      nativeProgressGeneration += 1;
    } else if (countPinned) {
      pinnedMeterCount += 1;
    }
    return advanced;
  }
  function pauseVideo() {
    playAttemptGeneration += 1;
    cancelFrameClockCheck();
    const element = videoEl.value;
    if (!element) return;
    if (!element.paused) element.pause();
    if (element.playbackRate !== 1) element.playbackRate = 1;
  }

  function markPlaybackFailure(itemUuid: string | null, message: string) {
    playAttemptFailed = true;
    videoFailed.value = true;
    videoReady.value = false;
    showVideo.value = false;
    pauseVideo();
    reportPlaybackError({ itemUuid, message });
  }

  function playVideo() {
    const element = videoEl.value;
    const source = videoSrc.value;
    const itemUuid = sourceItemUuid;
    if (!element || !source || !videoReady.value || playAttemptFailed || !hasHealthyClock.value
      || waitingForHealthyClockSample || waitingForNativeProgress) return;
    if (element.paused === false) {
      scheduleFrameClockCheck();
      return;
    }
    const generation = ++playAttemptGeneration;
    const playResult = element.play();
    scheduleFrameClockCheck();
    void playResult.catch(() => {
      if (generation !== playAttemptGeneration
        || videoSrc.value !== source || sourceItemUuid !== itemUuid) return;
      markPlaybackFailure(itemUuid, 'Video playback could not start.');
    });
  }

  function isAtOutPoint(item: OutputItem, playheadSeconds: number): boolean {
    return item.outPoint !== null && item.outPoint > item.inPoint
      && playheadSeconds >= item.outPoint;
  }

  function applyItem(item: OutputItem, playheadSeconds: number, seekImmediately = true) {
    cueImageSrc.value = pathMediaUrl(item.imagePath);

    if (!item.hasVideo) {
      showVideo.value = false;
      pauseVideo();
      preloadNextItem();
      return;
    }

    pendingSeekSeconds = playheadSeconds;
    const url = itemMediaUrl(item);
    if (url !== videoSrc.value) {
      pauseVideo();
      videoSrc.value = url;
      videoReady.value = false;
      videoFailed.value = false;
      playAttemptFailed = false;
      noDecodableVideoTrack = false;
      reportPlaybackError(null);
      beginNativeClockGrace(activeCueId.value, playheadSeconds);
    }

    const atOutPoint = isAtOutPoint(item, playheadSeconds);
    showVideo.value = !atOutPoint && !videoFailed.value;
    const element = videoEl.value;
    if (element && videoReady.value && seekImmediately
      && Math.abs(element.currentTime - playheadSeconds) > CHASE_DEADBAND_S) {
      element.currentTime = playheadSeconds;
    }
    if (atOutPoint) pauseVideo();
  }

  function applyTransport(transport: number) {
    activeTransport.value = transport;
    if (transport === TRANSPORT_STOPPED || transport === TRANSPORT_PAUSED
      || !showVideo.value || !hasHealthyClock.value || waitingForHealthyClockSample
      || waitingForNativeProgress) {
      pauseVideo();
      return;
    }
    playVideo();
  }

  function activeCueKey(active: ActiveCue): string {
    return active.cueId ? `cue:${active.cueId}` : `item:${active.itemUuid}`;
  }

  function newestActiveCue(): ActiveCue | null {
    if (diagnosticCue) return diagnosticCue;
    let newest: ActiveCue | null = null;
    for (const active of activeCues.values()) {
      if (!newest || active.triggerSeq > newest.triggerSeq) newest = active;
    }
    return newest;
  }

  function clearActive() {
    activeItemUuid.value = null;
    activeCueId.value = null;
    activeTransport.value = TRANSPORT_STOPPED;
    activeTriggerSeq = -1;
    showVideo.value = false;
    cueImageSrc.value = null;
    pauseVideo();
    reportPlaybackError(null);
    preloadNextItem();
  }

  function renderNewestActive(seekImmediately = true) {
    const active = newestActiveCue();
    if (!active) {
      if (activeItemUuid.value) clearActive();
      return;
    }
    const item = active === diagnosticCue ? diagnosticItem : doc.value?.items.get(active.itemUuid);
    if (!item) {
      clearActive();
      return;
    }

    const sourceChanged = active.itemUuid !== activeItemUuid.value
      || active.triggerSeq !== activeTriggerSeq;
    if (sourceChanged) {
      pauseVideo();
      reportPlaybackError(null);
      activeItemUuid.value = active.itemUuid;
      activeCueId.value = active.cueId;
      activeTriggerSeq = active.triggerSeq;
      beginNativeClockGrace(active.cueId, active.playheadSeconds);
    } else if (active.cueId !== activeCueId.value) {
      activeCueId.value = active.cueId;
    }
    applyItem(item, active.playheadSeconds, seekImmediately || sourceChanged);
    applyTransport(active.transport);
  }

  function removeMatchingActive(active: ActiveCue) {
    for (const [key, existing] of activeCues) {
      if ((active.cueId && existing.cueId === active.cueId)
        || existing.itemUuid === active.itemUuid) {
        activeCues.delete(key);
      }
    }
  }

  async function refetchDoc() {
    const generation = ++fetchGeneration;
    try {
      const nextDoc = readDoc(await server.fetchProject());
      if (generation !== fetchGeneration) return;
      doc.value = nextDoc;
      // Document refreshes are not transport seeks; preserve on-air rate correction.
      renderNewestActive(activeTransport.value === TRANSPORT_PAUSED);
      preloadNextItem();
    } catch {
      // A reconnect or later document patch will retry.
    }
  }

  function scheduleRefetch() {
    clearTimeout(refetchTimer);
    refetchTimer = window.setTimeout(() => { void refetchDoc(); }, 300);
  }

  function acceptDiagnosticState(raw: unknown): boolean {
    if (!diagnosticCue?.cueId || !raw || typeof raw !== 'object') return false;
    const state = raw as Record<string, unknown>;
    if (state.cue_id !== diagnosticCue.cueId) return false;
    const transport = readNumber(state.transport);
    if (transport === null) return false;
    diagnosticCue.transport = transport;
    diagnosticCue.playheadSeconds = readNumber(state.playhead_seconds) ?? 0;
    recordNativePosition(diagnosticCue.cueId, diagnosticCue.playheadSeconds, false);
    renderNewestActive();
    return true;
  }

  const offCueState = server.onCueState((raw: unknown) => {
    if (acceptDiagnosticState(raw)) return;
    const state = readActiveCue(raw);
    if (!state) return;
    acceptNextSnapshot = false;
    highestTriggerSeqSeen = Math.max(highestTriggerSeqSeen, state.triggerSeq);

    if (state.itemUuid === previewItemUuid.value) return;
    if (state.transport === TRANSPORT_STOPPED) {
      removeMatchingActive(state);
      renderNewestActive(false);
      return;
    }

    removeMatchingActive(state);
    activeCues.set(activeCueKey(state), state);
    const ownsPicture = newestActiveCue()?.itemUuid === state.itemUuid;
    if (ownsPicture) recordNativePosition(state.cueId ?? state.itemUuid, state.playheadSeconds, false);
    renderNewestActive(ownsPicture);
    if (!doc.value?.items.has(state.itemUuid)) void refetchDoc();
  });

  const offMeters = server.onMeters((meters: MetersBroadcast) => {
    // Background cues keep advancing before they become the picture again.
    const displayed = newestActiveCue();
    let removedDisplayed = false;
    for (const meter of meters.items) {
      const key = `cue:${meter.cue_id}`;
      const cue = activeCues.get(key);
      if (meter.transport === TRANSPORT_STOPPED) {
        activeCues.delete(key);
        if (cue && cue === displayed) removedDisplayed = true;
        continue;
      }
      if (cue && (hasHealthyClock.value || meter.transport === TRANSPORT_PAUSED)) {
        cue.playheadSeconds = meter.playhead_seconds;
        cue.transport = meter.transport;
      }
    }
    if (removedDisplayed) renderNewestActive();
    const active = newestActiveCue();
    if (!active?.cueId) return;
    const meter = meters.items.find((item) => item.cue_id === active.cueId);
    if (!meter) return;
    if (meter.transport === TRANSPORT_STOPPED) {
      if (active === diagnosticCue) {
        active.transport = TRANSPORT_STOPPED;
        renderNewestActive(false);
      }
      return;
    }

    if (meter.transport !== TRANSPORT_PAUSED && !hasHealthyClock.value) return;

    const nativeAdvanced = recordNativePosition(active.cueId, meter.playhead_seconds);
    if (!nativeAdvanced && meter.transport !== TRANSPORT_PAUSED
      && pinnedMeterCount >= PINNED_METER_LIMIT) {
      waitingForNativeProgress = true;
    }
    const canRecoverClock = nativeAdvanced && meter.transport !== TRANSPORT_PAUSED;
    active.playheadSeconds = meter.playhead_seconds;
    active.transport = meter.transport;
    renderNewestActive(meter.transport === TRANSPORT_PAUSED);

    if (meter.transport === TRANSPORT_PAUSED) {
      pauseVideo();
      return;
    }
    if ((waitingForHealthyClockSample || waitingForNativeProgress) && !canRecoverClock) return;

    const element = videoEl.value;
    if (canRecoverClock) {
      waitingForHealthyClockSample = false;
      waitingForNativeProgress = false;
    }
    if (!element || !showVideo.value || !videoReady.value) return;

    const drift = element.currentTime - meter.playhead_seconds;
    const absoluteDrift = Math.abs(drift);
    if (absoluteDrift > CHASE_HARD_SEEK_S) {
      element.currentTime = meter.playhead_seconds;
      element.playbackRate = 1;
    } else if (absoluteDrift <= CHASE_DEADBAND_S) {
      if (element.playbackRate !== 1) element.playbackRate = 1;
    } else {
      element.playbackRate = Math.min(1.03, Math.max(0.97, 1 - drift));
    }
    applyTransport(meter.transport);
  });

  // shortcut: one decoder; measure show-media contention before adding a standby slot.
  function preloadNextItem() {
    const uuid = nextItemUuid.value;
    if (!uuid || (activeItemUuid.value && doc.value?.items.get(activeItemUuid.value)?.hasVideo !== false)) return;
    for (const active of activeCues.values()) {
      // A retained video still owns this element for immediate fallback.
      if (doc.value?.items.get(active.itemUuid)?.hasVideo !== false) return;
    }
    const item = doc.value?.items.get(uuid);
    if (!item?.hasVideo) return;
    const url = itemMediaUrl(item);
    const sourceChanged = url !== videoSrc.value;
    if (!sourceChanged && pendingSeekSeconds === item.inPoint) return;
    pauseVideo();
    pendingSeekSeconds = item.inPoint;
    if (!sourceChanged) {
      const element = currentVideoEventElement();
      if (element && videoReady.value) element.currentTime = item.inPoint;
      return;
    }
    videoSrc.value = url;
    videoReady.value = false;
    videoFailed.value = false;
    playAttemptFailed = false;
    noDecodableVideoTrack = false;
    reportPlaybackError(null);
  }

  const stopNextItemWatch = watch(nextItemUuid, preloadNextItem);

  function applyPreviewState(state: Record<string, unknown> | null, fromSnapshot = false) {
    const session = readString(state?.project_session_id) ?? '';
    const revision = readNumber(state?.revision) ?? 0;
    if (!fromSnapshot && session && previewStateSession && session !== previewStateSession) return false;
    if ((!session || session === previewStateSession) && revision < previewStateRevision) return false;
    previewStateSession = session;
    previewStateRevision = revision;
    previewItemUuid.value = readString(state?.itemUuid);
    return true;
  }

  const offSnapshot = server.onPlaybackSnapshot((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const snapshot = raw as Record<string, unknown>;
    nextItemUuid.value = readString(snapshot.next_item_uuid);
    const preview = snapshot.preview && typeof snapshot.preview === 'object'
      ? snapshot.preview as Record<string, unknown>
      : null;
    applyPreviewState(preview ? { ...preview, itemUuid: preview.item_uuid } : null, true);

    const candidates: ActiveCue[] = [];
    for (const entry of Array.isArray(snapshot.cues) ? snapshot.cues : []) {
      if (acceptDiagnosticState(entry)) continue;
      const active = readActiveCue(entry);
      if (!active || active.transport === TRANSPORT_STOPPED
        || active.itemUuid === previewItemUuid.value) continue;
      candidates.push(active);
    }
    const newestSequence = candidates.reduce(
      (sequence, active) => Math.max(sequence, active.triggerSeq),
      -1,
    );

    // A delayed reconnect snapshot must not restore an older picture over a
    // cue_state edge already observed on this connection.
    if (acceptNextSnapshot || newestSequence >= highestTriggerSeqSeen) {
      activeCues.clear();
      for (const active of candidates) activeCues.set(activeCueKey(active), active);
      highestTriggerSeqSeen = Math.max(highestTriggerSeqSeen, newestSequence);
      renderNewestActive();
    }
    acceptNextSnapshot = false;
    void refetchDoc();
  });

  const offDocPatch = server.onDocPatch((raw: unknown) => {
    if (raw && typeof raw === 'object') {
      const patch = raw as Record<string, unknown>;
      switch (patch.op) {
        case 'media_changed':
          if (patch.project_session_id !== doc.value?.sessionId) return;
          if (patch.reloaded === true) void refetchDoc();
          return;
        case 'project_changed':
          fetchGeneration += 1;
          doc.value = null;
          activeCues.clear();
          nextItemUuid.value = null;
          previewItemUuid.value = null;
          previewStateRevision = -1;
          previewStateSession = '';
          highestTriggerSeqSeen = -1;
          acceptNextSnapshot = true;
          if (!diagnosticCue) {
            clearActive();
            videoSrc.value = null;
            videoReady.value = false;
            videoFailed.value = false;
            sourceItemUuid = null;
            sourceSignature = null;
            sourceFileRevision = null;
            playAttemptFailed = false;
            noDecodableVideoTrack = false;
          }
          break;
        case 'next_item_set':
          nextItemUuid.value = readString(patch.itemUuid);
          break;
        case 'preview_started': {
          if (!applyPreviewState(patch)) return;
          if (previewItemUuid.value) {
            for (const [key, active] of activeCues) {
              if (active.itemUuid === previewItemUuid.value) activeCues.delete(key);
            }
            renderNewestActive(false);
          }
          break;
        }
        case 'preview_stopped':
          applyPreviewState({ ...patch, itemUuid: '' });
          break;
        default:
          break;
      }
    }
    scheduleRefetch();
  });

  function currentVideoEventElement(): HTMLVideoElement | null {
    const element = videoEl.value;
    const source = videoSrc.value;
    if (!element || !source) return null;
    if (element.currentSrc && element.currentSrc !== source) return null;
    return element;
  }

  function rejectMissingDecodedVideo(element: HTMLVideoElement): boolean {
    if (noDecodableVideoTrack) return true;
    if (element.videoWidth > 0 && element.videoHeight > 0) return false;
    noDecodableVideoTrack = true;
    markPlaybackFailure(sourceItemUuid, 'Video playback could not be decoded.');
    return true;
  }

  function onVideoLoadedMetadata() {
    const element = currentVideoEventElement();
    if (!element || rejectMissingDecodedVideo(element)) return;
    if (Math.abs(element.currentTime - pendingSeekSeconds) > CHASE_DEADBAND_S) {
      element.currentTime = pendingSeekSeconds;
    }
  }

  function onVideoCanPlay() {
    const element = currentVideoEventElement();
    if (!element || rejectMissingDecodedVideo(element)) return;
    const firstReady = !videoReady.value;
    videoReady.value = true;
    videoFailed.value = false;
    playAttemptFailed = false;
    reportPlaybackError(null);
    // Rebuffer/seek can fire canplay again; keep later drift on the meter chase.
    renderNewestActive(firstReady);
    scheduleFrameClockCheck();
  }

  function onVideoError() {
    if (!currentVideoEventElement()) return;
    markPlaybackFailure(sourceItemUuid, 'Video playback could not be decoded.');
  }

  const stopDiagnosticWatch = watch(() => diagnosticSource?.value ?? null, (source) => {
    if (source?.cueId === diagnosticCue?.cueId && source?.path === diagnosticItem?.mediaServerPath
      && source?.duration === diagnosticItem?.outPoint) return;
    diagnosticCue = source ? {
      itemUuid: source.cueId,
      cueId: source.cueId,
      transport: TRANSPORT_STOPPED,
      playheadSeconds: 0,
      triggerSeq: 0,
    } : null;
    diagnosticItem = source ? {
      uuid: source.cueId,
      hasVideo: true,
      imagePath: null,
      mediaPath: source.path,
      mediaServerPath: source.path,
      inPoint: 0,
      outPoint: source.duration,
      fileRevision: null,
    } : null;
    renderNewestActive();
  }, { immediate: true });

  const stopClockWatch = watch(hasHealthyClock, (healthy, wasHealthy) => {
    if (!healthy) {
      waitingForHealthyClockSample = true;
      pauseVideo();
    } else if (wasHealthy === false) {
      // Do not free-run from the frozen frame. The first fresh engine meter
      // seeks us to the recovered clock before play resumes.
      waitingForHealthyClockSample = true;
    }
  });

  const stopConnectedWatch = watch(() => server.connected, (connected) => {
    if (!connected) {
      acceptNextSnapshot = true;
    } else {
      void refetchDoc();
    }
  }, { immediate: true });

  onScopeDispose(() => {
    clearTimeout(refetchTimer);
    pauseVideo();
    fetchGeneration += 1;
    offCueState();
    offMeters();
    offSnapshot();
    offDocPatch();
    stopNextItemWatch();
    stopClockWatch();
    stopConnectedWatch();
    stopDiagnosticWatch();
  });

  return {
    videoEl,
    getPictureHealth,
    videoSrc,
    onVideoLoadedMetadata,
    onVideoCanPlay,
    onVideoError,
    showVideo,
    cueImageSrc,
    standbySrc,
  };
}
