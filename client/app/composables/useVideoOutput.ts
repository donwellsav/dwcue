// ============================================================================
// useVideoOutput.ts — playback brain of the ?videoOutput=1 render surface.
//
// The output is a passive renderer. Audio remains the clock authority: video
// follows cue_state edges and meter positions, and it stops advancing whenever
// there is no healthy engine clock.
// ============================================================================

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
}

interface DocMirror {
  folderPath: string | null;
  standbyImage: string | null;
  items: ReadonlyMap<string, OutputItem>;
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

export function useVideoOutput() {
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
  const nextItemUuid = ref<string | null>(null);
  const activeCues = new Map<string, ActiveCue>();
  let activeTriggerSeq = -1;
  let highestTriggerSeqSeen = -1;
  let acceptNextSnapshot = true;
  let pendingSeekSeconds = 0;

  let sourceItemUuid: string | null = null;
  let sourceSignature: string | null = null;
  let sourceVersion = 0;
  let playAttemptFailed = false;
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
    const signature = `${item.mediaServerPath ?? ''}\u0000${item.mediaPath ?? ''}`;
    if (sourceItemUuid !== item.uuid || sourceSignature !== signature) {
      sourceVersion += 1;
    }
    sourceItemUuid = item.uuid;
    sourceSignature = signature;
    const base = String(server.serverUrl || '').replace(/\/+$/, '');
    const params = new URLSearchParams({
      item_uuid: item.uuid,
      source_revision: String(sourceVersion),
    });
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
    const element = videoEl.value;
    if (!element || videoFrameCallbackId !== null
      || typeof element.requestVideoFrameCallback !== 'function') return;
    videoFrameCallbackElement = element;
    videoFrameCallbackId = element.requestVideoFrameCallback(onVideoFrame);
  }

  function onVideoFrame(timestamp: DOMHighResTimeStamp) {
    videoFrameCallbackId = null;
    videoFrameCallbackElement = null;
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
    if (!element || !source || playAttemptFailed || !hasHealthyClock.value
      || waitingForHealthyClockSample || waitingForNativeProgress) return;
    if (element.paused === false) {
      scheduleFrameClockCheck();
      return;
    }
    const playResult = element.play();
    scheduleFrameClockCheck();
    void playResult.catch(() => {
      if (videoSrc.value !== source || sourceItemUuid !== itemUuid) return;
      markPlaybackFailure(itemUuid, 'Video playback could not start.');
    });
  }

  function isAtOutPoint(item: OutputItem, playheadSeconds: number): boolean {
    return item.outPoint !== null && item.outPoint > item.inPoint
      && playheadSeconds >= item.outPoint;
  }

  function applyItem(item: OutputItem, playheadSeconds: number, seekImmediately = true) {
    cueImageSrc.value = pathMediaUrl(item.imagePath);
    pendingSeekSeconds = playheadSeconds;

    if (!item.hasVideo) {
      showVideo.value = false;
      pauseVideo();
      return;
    }

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
    const item = doc.value?.items.get(active.itemUuid);
    if (!item) return;

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
    applyItem(item, active.playheadSeconds, seekImmediately);
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
      renderNewestActive();
      preloadNextItem();
    } catch {
      // A reconnect or later document patch will retry.
    }
  }

  function scheduleRefetch() {
    clearTimeout(refetchTimer);
    refetchTimer = window.setTimeout(() => { void refetchDoc(); }, 300);
  }

  const offCueState = server.onCueState((raw: unknown) => {
    const state = readActiveCue(raw);
    if (!state) return;
    acceptNextSnapshot = false;
    highestTriggerSeqSeen = Math.max(highestTriggerSeqSeen, state.triggerSeq);

    if (state.itemUuid === previewItemUuid.value) return;
    if (state.transport === TRANSPORT_STOPPED) {
      removeMatchingActive(state);
      renderNewestActive();
      return;
    }

    recordNativePosition(state.cueId ?? state.itemUuid, state.playheadSeconds, false);
    removeMatchingActive(state);
    activeCues.set(activeCueKey(state), state);
    renderNewestActive();
    if (!doc.value?.items.has(state.itemUuid)) void refetchDoc();
  });

  const offMeters = server.onMeters((meters: MetersBroadcast) => {
    const active = newestActiveCue();
    if (!active?.cueId) return;
    const meter = meters.items.find((item) => item.cue_id === active.cueId);
    if (!meter || meter.transport === TRANSPORT_STOPPED) return;

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

  function preloadNextItem() {
    const uuid = nextItemUuid.value;
    if (!uuid || activeItemUuid.value) return;
    const item = doc.value?.items.get(uuid);
    if (!item?.hasVideo) return;
    const url = itemMediaUrl(item);
    if (url === videoSrc.value) return;
    pauseVideo();
    videoSrc.value = url;
    videoReady.value = false;
    videoFailed.value = false;
    playAttemptFailed = false;
    noDecodableVideoTrack = false;
    pendingSeekSeconds = item.inPoint;
    reportPlaybackError(null);
  }

  const stopNextItemWatch = watch(nextItemUuid, preloadNextItem);

  const offSnapshot = server.onPlaybackSnapshot((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const snapshot = raw as Record<string, unknown>;
    nextItemUuid.value = readString(snapshot.next_item_uuid);
    const preview = snapshot.preview && typeof snapshot.preview === 'object'
      ? snapshot.preview as Record<string, unknown>
      : null;
    previewItemUuid.value = preview ? readString(preview.item_uuid) : null;

    const candidates: ActiveCue[] = [];
    for (const entry of Array.isArray(snapshot.cues) ? snapshot.cues : []) {
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
        case 'next_item_set':
          nextItemUuid.value = readString(patch.itemUuid);
          break;
        case 'preview_started': {
          previewItemUuid.value = readString(patch.itemUuid);
          if (previewItemUuid.value) {
            for (const [key, active] of activeCues) {
              if (active.itemUuid === previewItemUuid.value) activeCues.delete(key);
            }
            renderNewestActive();
          }
          break;
        }
        case 'preview_stopped':
          previewItemUuid.value = null;
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
    videoReady.value = true;
    videoFailed.value = false;
    playAttemptFailed = false;
    reportPlaybackError(null);
    renderNewestActive();
  }

  function onVideoError() {
    if (!currentVideoEventElement()) return;
    markPlaybackFailure(sourceItemUuid, 'Video playback could not be decoded.');
  }

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
    cancelFrameClockCheck();
    fetchGeneration += 1;
    offCueState();
    offMeters();
    offSnapshot();
    offDocPatch();
    stopNextItemWatch();
    stopClockWatch();
    stopConnectedWatch();
  });

  return {
    videoEl,
    videoSrc,
    onVideoLoadedMetadata,
    onVideoCanPlay,
    onVideoError,
    showVideo,
    cueImageSrc,
    standbySrc,
  };
}
