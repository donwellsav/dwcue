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
// The picture follows the engine's playhead, which moves in render bursts:
// one reading jitters by tens of milliseconds while the picture is in step.
// Steer by the median of recent readings and change speed only when a
// correction starts or ends, because each speed change costs dropped frames.
const CHASE_START_S = 0.04;
const CHASE_SETTLE_S = 0.01;
const CHASE_HARD_SEEK_S = 0.08;
// A gap this large is a real jump (loop, seek, a seek that landed off), not
// drift or a late reading (the soak saw 110 ms at worst): follow it at once.
const CHASE_JUMP_S = 0.2;
const CHASE_RATE_STEP = 0.02;
// A start lands late by however long the output takes to hear of the cue,
// seek, play and show a first frame. Starting ahead by that much lands the
// picture in step instead of catching up, which costs frames. The lead is
// learned from each start.
const START_LEAD_KEY = 'dwcue.videoStartLead';
const START_LEAD_DEFAULT_S = 0.06;
const START_LEAD_MAX_S = 0.25;
const CHASE_WINDOW = 8;
// Readings needed before a correction starts: the first after a start or seek
// are the noisiest.
const CHASE_MIN_SAMPLES = 4;
// Close enough for a seek to count as landed.
const CHASE_DEADBAND_S = 0.015;
const NATIVE_CLOCK_STALE_MS = 250;
const PINNED_METER_LIMIT = 2;
const NATIVE_PROGRESS_EPSILON_S = 0.001;
const FOLLOW_END_TOLERANCE_S = 0.1;
const FOLLOW_CUE_GRACE_MS = 750;
const FIRST_FRAME_WARNING_MS = 3000;
const DOC_REFETCH_DELAY_MS = 300;
const MAX_METADATA_RETRY_MS = 2400;
const METADATA_WARNING = 'Waiting for cue details. Video Output is retrying.';

interface OutputItem {
  uuid: string;
  hasVideo: boolean;
  imagePath: string | null;
  mediaPath: string | null;
  mediaServerPath: string | null;
  inPoint: number;
  outPoint: number | null;
  duration: number;
  followsAtEnd: boolean;
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
        const endAction = (item.endBehavior as { action?: string } | null)?.action;
        items.set(uuid, {
          uuid,
          hasVideo: item.hasVideo === true,
          imagePath: readString(item.imagePath),
          mediaPath: readString(item.mediaPath),
          mediaServerPath: readString(item.mediaServerPath),
          inPoint: readNumber(item.inPoint) ?? 0,
          outPoint: readNumber(item.outPoint),
          duration: readNumber(item.duration) ?? 0,
          followsAtEnd: endAction === 'next' || endAction === 'goto-item' || endAction === 'goto-index',
          fileRevision: readString(fileRevisions[uuid]),
        });
      }
      walk(item.children);
    }
  };
  walk(record.items);
  walk(record.quickPlayItems);
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
  // Two <video> elements: the live one and a spare. While a video cue plays,
  // the next video cue loads into the spare and settles on its first frame;
  // at the cut they swap roles, so the incoming picture starts without a
  // reload or a cold seek. videoEl/videoSrc always mean the live element.
  const liveSlot = ref(0);
  const slotSources = ref<Array<string | null>>([null, null]);
  const slotElements: Array<HTMLVideoElement | null> = [null, null];
  const videoSrc = computed<string | null>({
    get: () => slotSources.value[liveSlot.value] ?? null,
    set: (value) => { slotSources.value[liveSlot.value] = value; },
  });
  let spare: { itemUuid: string; signature: string; version: number; fileRevision: string | null;
    inPoint: number; ready: boolean } | null = null;
  let mediaVersionCounter = 0;
  const videoReady = ref(false);
  const videoFailed = ref(false);
  const showVideo = ref(false);
  const heldFrameEl = shallowRef<HTMLCanvasElement | null>(null);
  const showHeldFrame = ref(false);
  let pictureTimer: number | undefined;
  const assignedCueImageSrc = ref<string | null>(null);
  // A captured picture is saved into the show and set as the cue's picture or
  // the standby picture, so the two below are all there is to show.
  const cueImageSrc = computed(() => assignedCueImageSrc.value);

  const doc = shallowRef<DocMirror | null>(null);
  let refetchTimer: number | undefined;
  let metadataRetryTimer: number | undefined;
  let metadataRetryDelay = DOC_REFETCH_DELAY_MS;
  let metadataCueKey: string | null = null;
  let docRequest: { controller: AbortController; cueKey: string | null } | undefined;

  const activeItemUuid = ref<string | null>(null);
  const activeCueId = ref<string | null>(null);
  const activeTransport = ref(TRANSPORT_STOPPED);
  let previewCueId: string | null = null;
  let previewStateRevision = -1;
  let previewStateSession = '';
  const nextItemUuid = ref<string | null>(null);
  const activeCues = new Map<string, ActiveCue>();
  let diagnosticCue: ActiveCue | null = null;
  let diagnosticItem: OutputItem | null = null;
  let activeTriggerSeq = -1;
  let highestTriggerSeqSeen = -1;
  let stopRevision: number | null = null;
  let stoppedThroughTriggerSeq = -1;
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
  let awaitingFirstFrame = false;

  watch(videoSrc, () => {
    cancelFrameClockCheck();
    presentedAt = presentedMediaTime = presentedFrames = null;
    awaitingFirstFrame = false;
  }, { flush: 'sync' });

  function getPictureHealth(): VideoPictureHealth {
    const element = videoEl.value;
    const quality = element?.getVideoPlaybackQuality?.();
    const state = videoFailed.value ? 'error'
      : !showVideo.value ? (cueImageSrc.value || standbySrc.value ? 'still' : 'idle')
      : activeTransport.value === TRANSPORT_PAUSED ? 'paused'
      : !hasHealthyClock.value || waitingForHealthyClockSample || waitingForNativeProgress ? 'clock-wait'
      : element?.seeking ? 'seeking' : !videoReady.value || awaitingFirstFrame ? 'loading' : 'playing';
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

  function clearHeldFrame() {
    clearTimeout(pictureTimer);
    showHeldFrame.value = false;
    awaitingFirstFrame = false;
  }

  function holdCurrentFrame() {
    if (showHeldFrame.value || !showVideo.value || presentedAt === null
      || !doc.value?.items.get(activeItemUuid.value ?? '')?.hasVideo
      || activeTriggerSeq <= stoppedThroughTriggerSeq) return;
    const element = currentVideoEventElement();
    const canvas = heldFrameEl.value;
    if (!element || !canvas || element.readyState < 2 || !element.videoWidth || !element.videoHeight) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    // Copy only at the handoff so the old frame survives replacing the one decoder's source.
    if (canvas.width !== element.videoWidth) canvas.width = element.videoWidth;
    if (canvas.height !== element.videoHeight) canvas.height = element.videoHeight;
    try {
      context.drawImage(element, 0, 0);
      showHeldFrame.value = true;
    } catch { /* Leave the normal standby visible if the last frame is unavailable. */ }
  }

  function observeStopRevision(raw: unknown) {
    const revision = readTriggerSeq(raw);
    if (revision === null) return;
    if (stopRevision !== null && revision > stopRevision) {
      stoppedThroughTriggerSeq = highestTriggerSeqSeen;
      clearHeldFrame();
      syncMetadataRecovery(null);
    }
    stopRevision = revision;
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

  function sourceSignatureOf(item: OutputItem): string {
    return `${doc.value?.sessionId ?? ''}\u0000${item.fileRevision ?? ''}\u0000${item.mediaServerPath ?? ''}\u0000${item.mediaPath ?? ''}`;
  }

  function itemMediaUrl(item: OutputItem): string {
    const signature = sourceSignatureOf(item);
    if (sourceItemUuid !== item.uuid || sourceSignature !== signature) {
      sourceVersion = ++mediaVersionCounter;
    }
    sourceItemUuid = item.uuid;
    sourceSignature = signature;
    sourceFileRevision = item.fileRevision;
    return mediaUrlFor(item, sourceVersion);
  }

  function mediaUrlFor(item: OutputItem, version: number): string {
    const base = String(server.serverUrl || '').replace(/\/+$/, '');
    const params = new URLSearchParams(diagnosticItem === item
      ? { path: item.mediaServerPath ?? '' }
      : { item_uuid: item.uuid });
    params.set('source_revision', String(version));
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
      videoFrameCallbackId = null;
      videoFrameCallbackElement = null;
      if (videoSrc.value !== source || videoEl.value !== element) return;
      if (currentVideoEventElement() !== element) {
        scheduleFrameClockCheck();
        return;
      }
      onVideoFrame(timestamp, metadata);
    });
  }

  function onVideoFrame(timestamp: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) {
    const frameReady = Number.isFinite(metadata?.mediaTime)
      && (!awaitingFirstFrame || (videoReady.value && !videoEl.value?.seeking));
    if (frameReady) {
      presentedAt = timestamp;
      presentedMediaTime = metadata.mediaTime;
      presentedFrames = metadata.presentedFrames;
      if (awaitingFirstFrame && showVideo.value) {
        clearHeldFrame();
        reportPlaybackError(null);
      }
    }
    if (activeTransport.value === TRANSPORT_PAUSED && awaitingFirstFrame && showVideo.value) {
      scheduleFrameClockCheck();
      return;
    }
    if (activeTransport.value === TRANSPORT_STOPPED || activeTransport.value === TRANSPORT_PAUSED || !showVideo.value
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
  let chaseSamples: number[] = [];
  let chaseCorrecting = false;
  let chaseCueId: string | null = null;
  let startLead = START_LEAD_DEFAULT_S;
  try {
    const raw = window.localStorage?.getItem(START_LEAD_KEY);
    const saved = raw == null ? NaN : Number(raw);
    if (Number.isFinite(saved) && saved >= 0) startLead = Math.min(START_LEAD_MAX_S, saved);
  } catch { /* storage unavailable: use the default */ }
  let startPending = false;
  function learnStartLead(steady: number) {
    startPending = false;
    startLead = Math.min(START_LEAD_MAX_S, Math.max(0, startLead - 0.7 * steady));
    try { window.localStorage?.setItem(START_LEAD_KEY, startLead.toFixed(4)); } catch { /* keep it for this session */ }
  }
  function resetChase(cueId: string | null = null) {
    chaseSamples = [];
    chaseCorrecting = false;
    chaseCueId = cueId;
  }
  function steadyDrift() {
    const sorted = [...chaseSamples].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  }

  function pauseVideo() {
    resetChase();
    playAttemptGeneration += 1;
    cancelFrameClockCheck();
    const element = videoEl.value;
    if (!element) return;
    if (!element.paused) element.pause();
    if (element.playbackRate !== 1) element.playbackRate = 1;
  }

  // A playback error mid-cue (a GPU reset, a refused or interrupted media
  // request) is retried with a fresh request for the same file while the cue
  // is on air, instead of leaving the audience black for the rest of the cue.
  const RETRY_DELAYS_MS = [500, 1500, 3000];
  let retryTimer: number | undefined;
  let retryTrigger = -1;
  let retryAttempts = 0;
  function scheduleRetry() {
    if (diagnosticCue || noDecodableVideoTrack || !activeItemUuid.value) return;
    if (retryTrigger !== activeTriggerSeq) {
      retryTrigger = activeTriggerSeq;
      retryAttempts = 0;
    }
    if (retryAttempts >= RETRY_DELAYS_MS.length) return;
    const delay = RETRY_DELAYS_MS[retryAttempts++]!;
    const trigger = activeTriggerSeq;
    const uuid = activeItemUuid.value;
    clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => {
      const active = newestActiveCue();
      const item = doc.value?.items.get(uuid);
      if (activeTriggerSeq !== trigger || activeItemUuid.value !== uuid || !active || !item?.hasVideo) return;
      sourceSignature = null;
      startPending = active.transport !== TRANSPORT_PAUSED;
      applyItem(item, active.playheadSeconds);
      applyTransport(active.transport);
    }, delay);
  }

  function markPlaybackFailure(itemUuid: string | null, message: string) {
    clearHeldFrame();
    playAttemptFailed = true;
    videoFailed.value = true;
    videoReady.value = false;
    showVideo.value = false;
    pauseVideo();
    reportPlaybackError({ itemUuid, message });
    scheduleRetry();
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
    // Played to its end while the engine still plays (audio longer than the
    // picture, or the picture slightly ahead): hold the last frame. play()
    // would restart it at frame 0, a flash of the first frame.
    if (element.ended) return;
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

  function holdAtFollowEnd(playheadSeconds: number): boolean {
    const item = doc.value?.items.get(activeItemUuid.value ?? '');
    if (diagnosticCue || !item?.hasVideo || !item.followsAtEnd
      || activeTriggerSeq <= stoppedThroughTriggerSeq) return false;
    const end = item.outPoint !== null && item.outPoint > item.inPoint ? item.outPoint : item.duration;
    if (end <= 0 || playheadSeconds < end - FOLLOW_END_TOLERANCE_S) return false;
    holdCurrentFrame();
    return showHeldFrame.value;
  }

  function applyItem(item: OutputItem, playheadSeconds: number, seekImmediately = true) {
    assignedCueImageSrc.value = pathMediaUrl(item.imagePath);

    if (!item.hasVideo) {
      clearHeldFrame();
      showVideo.value = false;
      pauseVideo();
      preloadNextItem();
      return;
    }

    pendingSeekSeconds = playheadSeconds + (startPending ? startLead : 0);
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
      && Math.abs(element.currentTime - pendingSeekSeconds) > CHASE_DEADBAND_S) {
      element.currentTime = pendingSeekSeconds;
    }
    if (atOutPoint) pauseVideo();
  }

  function applyTransport(transport: number) {
    activeTransport.value = transport;
    if (transport === TRANSPORT_STOPPED || transport === TRANSPORT_PAUSED) startPending = false;
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

  function clearActive(keepHeldFrame = false) {
    if (keepHeldFrame) {
      clearTimeout(pictureTimer);
      awaitingFirstFrame = false;
      // Some endings never produce a follow. An idle output returns to its standby.
      pictureTimer = window.setTimeout(clearHeldFrame, FOLLOW_CUE_GRACE_MS);
    } else {
      clearHeldFrame();
    }
    activeItemUuid.value = null;
    activeCueId.value = null;
    activeTransport.value = TRANSPORT_STOPPED;
    activeTriggerSeq = -1;
    startPending = false;
    showVideo.value = false;
    assignedCueImageSrc.value = null;
    pauseVideo();
    reportPlaybackError(null);
    preloadNextItem();
  }

  function renderNewestActive(seekImmediately = true, stoppedAt?: number) {
    const active = newestActiveCue();
    const item = active === diagnosticCue ? diagnosticItem : doc.value?.items.get(active?.itemUuid ?? '');
    syncMetadataRecovery(item ? null : active);
    if (!active) {
      if (activeItemUuid.value) clearActive(stoppedAt !== undefined && holdAtFollowEnd(stoppedAt));
      return;
    }
    if (!item || (active !== diagnosticCue && active.triggerSeq <= stoppedThroughTriggerSeq
      && active.triggerSeq !== activeTriggerSeq)) {
      if (activeItemUuid.value) clearActive();
      return;
    }

    const sourceChanged = active.itemUuid !== activeItemUuid.value
      || active.triggerSeq !== activeTriggerSeq;
    if (sourceChanged) {
      if (item.hasVideo && active !== diagnosticCue && active.itemUuid !== activeItemUuid.value) {
        holdCurrentFrame();
      }
      if (active === diagnosticCue) clearHeldFrame();
      if (videoFailed.value && active.itemUuid === sourceItemUuid) sourceSignature = null;
      const previousSource = videoSrc.value;
      pauseVideo();
      reportPlaybackError(null);
      activeItemUuid.value = active.itemUuid;
      activeCueId.value = active.cueId;
      activeTriggerSeq = active.triggerSeq;
      beginNativeClockGrace(active.cueId, active.playheadSeconds);
      startPending = active.transport !== TRANSPORT_PAUSED;
      if (item.hasVideo && active !== diagnosticCue) adoptSpare(item);
      applyItem(item, active.playheadSeconds);
      if (active !== diagnosticCue && item.hasVideo && !isAtOutPoint(item, active.playheadSeconds)
        && (videoSrc.value !== previousSource || showHeldFrame.value || !videoReady.value)) {
        awaitingFirstFrame = true;
        presentedAt = presentedMediaTime = presentedFrames = null;
        clearTimeout(pictureTimer);
        pictureTimer = window.setTimeout(() => {
          // A slow decoder can still replace the held picture after the warning.
          reportPlaybackError({ itemUuid: active.itemUuid, message: 'Waiting for the first video frame.' });
        }, FIRST_FRAME_WARNING_MS);
      }
    } else if (active.cueId !== activeCueId.value) {
      activeCueId.value = active.cueId;
    }
    if (active.transport !== TRANSPORT_PAUSED && isAtOutPoint(item, active.playheadSeconds)) {
      holdAtFollowEnd(active.playheadSeconds);
    }
    if (!sourceChanged) applyItem(item, active.playheadSeconds, seekImmediately);
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

  function syncMetadataRecovery(active: ActiveCue | null) {
    const key = server.connected && active && active !== diagnosticCue
      && active.triggerSeq > stoppedThroughTriggerSeq
      ? `${activeCueKey(active)}:${active.triggerSeq}` : null;
    if (key === metadataCueKey) return;
    clearTimeout(metadataRetryTimer);
    metadataRetryTimer = undefined;
    metadataRetryDelay = DOC_REFETCH_DELAY_MS;
    if (docRequest?.cueKey) docRequest.controller.abort();
    metadataCueKey = key;
    if (reportedPlaybackError?.message === METADATA_WARNING) reportPlaybackError(null);
    if (key) metadataRetryTimer = window.setTimeout(retryMetadata, DOC_REFETCH_DELAY_MS);
  }

  function retryMetadata() {
    metadataRetryTimer = undefined;
    void refetchDoc();
  }

  async function refetchDoc() {
    if (metadataRetryTimer !== undefined && metadataRetryDelay > DOC_REFETCH_DELAY_MS) return;
    if (!server.connected || (docRequest?.cueKey != null && !docRequest.controller.signal.aborted
      && docRequest.cueKey === metadataCueKey)) return;
    docRequest?.controller.abort();
    const request = { controller: new AbortController(), cueKey: metadataCueKey };
    docRequest = request;
    clearTimeout(metadataRetryTimer);
    metadataRetryTimer = undefined;
    try {
      const nextDoc = readDoc(await server.fetchProject(request.controller.signal));
      if (request.controller.signal.aborted) return;
      docRequest = undefined;
      doc.value = nextDoc;
      // Document refreshes are not transport seeks; preserve on-air rate correction.
      renderNewestActive(activeTransport.value === TRANSPORT_PAUSED);
      preloadNextItem();
    } catch {
      if (request.controller.signal.aborted) return;
      docRequest = undefined;
    }
    const active = newestActiveCue();
    if (!metadataCueKey || !active) return;
    reportPlaybackError({ itemUuid: active.itemUuid, message: METADATA_WARNING });
    clearTimeout(metadataRetryTimer);
    metadataRetryTimer = window.setTimeout(retryMetadata, metadataRetryDelay);
    metadataRetryDelay = Math.min(metadataRetryDelay * 2, MAX_METADATA_RETRY_MS);
  }

  function scheduleRefetch() {
    clearTimeout(refetchTimer);
    refetchTimer = window.setTimeout(() => { void refetchDoc(); }, DOC_REFETCH_DELAY_MS);
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
    if (!state || (previewCueId !== null && state.cueId === previewCueId)) return;
    acceptNextSnapshot = false;
    highestTriggerSeqSeen = Math.max(highestTriggerSeqSeen, state.triggerSeq);

    if (state.transport === TRANSPORT_STOPPED) {
      const stoppedAt = state.itemUuid === activeItemUuid.value && state.triggerSeq === activeTriggerSeq
        ? state.playheadSeconds : undefined;
      removeMatchingActive(state);
      renderNewestActive(false, stoppedAt);
      return;
    }

    removeMatchingActive(state);
    activeCues.set(activeCueKey(state), state);
    const ownsPicture = newestActiveCue()?.itemUuid === state.itemUuid;
    if (ownsPicture) recordNativePosition(state.cueId ?? state.itemUuid, state.playheadSeconds, false);
    // A fade starting or ending, or a resume, keeps the picture playing: the
    // chase handles any drift. Seeking here froze and jumped the picture to
    // a render position ahead of the sound. Paused, show the exact frame.
    renderNewestActive(ownsPicture && state.transport === TRANSPORT_PAUSED);
    if (metadataCueKey) void refetchDoc();
  });

  const offMeters = server.onMeters((meters: MetersBroadcast) => {
    observeStopRevision(meters.stop_revision);
    // Background cues keep advancing before they become the picture again.
    const displayed = newestActiveCue();
    let stoppedAt: number | undefined;
    for (const meter of meters.items) {
      const key = `cue:${meter.cue_id}`;
      const cue = activeCues.get(key);
      if (meter.transport === TRANSPORT_STOPPED) {
        activeCues.delete(key);
        if (cue && cue === displayed) stoppedAt = meter.playhead_seconds;
        continue;
      }
      if (cue && (hasHealthyClock.value || meter.transport === TRANSPORT_PAUSED)) {
        cue.playheadSeconds = meter.playhead_seconds;
        cue.transport = meter.transport;
      }
    }
    if (stoppedAt !== undefined) renderNewestActive(false, stoppedAt);
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

    // Let a seek land and submit the first frame before chasing the moving clock.
    if (element.seeking || (showHeldFrame.value && awaitingFirstFrame)) {
      resetChase(active.cueId);
      applyTransport(meter.transport);
      return;
    }
    if (chaseCueId !== active.cueId) resetChase(active.cueId);
    // Follow the cue as heard: the render position runs ahead of the sound by
    // the output's queue, and following it would put the picture early.
    const heard = meter.audible_seconds ?? meter.playhead_seconds;
    const drift = element.currentTime - heard;
    chaseSamples.push(drift);
    if (chaseSamples.length > CHASE_WINDOW) chaseSamples.shift();
    const steady = steadyDrift();
    // Seek only for a real jump or a gap two readings agree on: one stray
    // reading must not make the picture jump.
    if (Math.abs(drift) > CHASE_JUMP_S || (Math.abs(drift) > CHASE_HARD_SEEK_S
      && chaseSamples.length >= 2 && Math.abs(steady) > CHASE_HARD_SEEK_S)) {
      // Aim ahead by the learned lead: a seek takes time, and landing late
      // by that much would set off another seek. Its landing teaches the lead.
      element.currentTime = heard + startLead;
      element.playbackRate = 1;
      resetChase(active.cueId);
      startPending = true;
    } else {
      // How far this start landed from the sound sets the next start's lead.
      if (startPending && chaseSamples.length === CHASE_WINDOW) learnStartLead(steady);
      if (!chaseCorrecting && chaseSamples.length >= CHASE_MIN_SAMPLES && Math.abs(steady) > CHASE_START_S) chaseCorrecting = true;
      else if (chaseCorrecting && Math.abs(steady) < CHASE_SETTLE_S) chaseCorrecting = false;
      const rate = chaseCorrecting ? (steady < 0 ? 1 + CHASE_RATE_STEP : 1 - CHASE_RATE_STEP) : 1;
      if (element.playbackRate !== rate) element.playbackRate = rate;
    }
    applyTransport(meter.transport);
  });

  function registerVideoElement(slot: number, element: HTMLVideoElement | null) {
    slotElements[slot] = element;
    if (slot === liveSlot.value) videoEl.value = element;
  }

  function spareElement(): HTMLVideoElement | null {
    return slotElements[1 - liveSlot.value] ?? null;
  }

  function dropSpare() {
    spare = null;
    slotSources.value[1 - liveSlot.value] = null;
  }

  // Load the next video cue into the spare while the live element plays.
  function preloadSpare(item: OutputItem) {
    if (!spareElement() || diagnosticCue) return;
    const signature = sourceSignatureOf(item);
    if (spare && spare.itemUuid === item.uuid && spare.signature === signature) return;
    const version = ++mediaVersionCounter;
    spare = { itemUuid: item.uuid, signature, version, fileRevision: item.fileRevision, inPoint: item.inPoint, ready: false };
    slotSources.value[1 - liveSlot.value] = mediaUrlFor(item, version);
  }

  // The spare is ready once it has its first frame at the cue's In point.
  function onSpareEvent() {
    const element = spareElement();
    if (!spare || !element || element.readyState < 1) return;
    if (!element.seeking && Math.abs(element.currentTime - spare.inPoint) > CHASE_DEADBAND_S) {
      element.currentTime = spare.inPoint;
      return;
    }
    if (element.readyState >= 2 && !element.seeking && element.videoWidth > 0) spare.ready = true;
  }

  function onSpareError() {
    dropSpare();
  }

  // At the cut, take the spare if it holds this cue ready: the elements swap
  // roles and the spare's source becomes the live one, unchanged.
  function adoptSpare(item: OutputItem): boolean {
    const incoming = spareElement();
    if (!spare || spare.itemUuid !== item.uuid) return false;
    if (!spare.ready || !incoming || spare.signature !== sourceSignatureOf(item)) {
      dropSpare();
      return false;
    }
    const outgoing = videoEl.value;
    liveSlot.value = 1 - liveSlot.value;
    videoEl.value = incoming;
    sourceItemUuid = item.uuid;
    sourceSignature = spare.signature;
    sourceFileRevision = spare.fileRevision;
    sourceVersion = spare.version;
    spare = null;
    videoReady.value = true;
    videoFailed.value = false;
    playAttemptFailed = false;
    noDecodableVideoTrack = false;
    if (outgoing && !outgoing.paused) outgoing.pause();
    return true;
  }

  function preloadNextItem() {
    const uuid = nextItemUuid.value;
    const nextItem = uuid ? doc.value?.items.get(uuid) : undefined;
    let liveBusy = !!activeItemUuid.value && doc.value?.items.get(activeItemUuid.value)?.hasVideo !== false;
    for (const active of activeCues.values()) {
      // A retained video still owns the live element for immediate fallback.
      if (doc.value?.items.get(active.itemUuid)?.hasVideo !== false) liveBusy = true;
    }
    if (liveBusy) {
      // The live element is showing a picture: the next video cue goes to the spare.
      if (nextItem?.hasVideo && uuid !== activeItemUuid.value) preloadSpare(nextItem);
      return;
    }
    if (!uuid) return;
    const item = nextItem;
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

  function resetProjectProjection() {
    docRequest?.controller.abort();
    syncMetadataRecovery(null);
    doc.value = null;
    activeCues.clear();
    nextItemUuid.value = null;
    previewCueId = null;
    previewStateRevision = -1;
    previewStateSession = '';
    highestTriggerSeqSeen = -1;
    stoppedThroughTriggerSeq = -1;
    stopRevision = null;
    clearHeldFrame();
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
  }

  function applyPreviewState(state: Record<string, unknown> | null, fromSnapshot = false) {
    const session = readString(state?.project_session_id) ?? '';
    const revision = readNumber(state?.revision) ?? 0;
    if (!fromSnapshot && session && previewStateSession && session !== previewStateSession) return false;
    if ((!session || session === previewStateSession) && revision < previewStateRevision) return false;
    previewStateSession = session;
    previewStateRevision = revision;
    // Preview loads a separate engine cue, even when Program plays the same playlist item.
    previewCueId = readString(state?.cueId);
    return true;
  }

  const offSnapshot = server.onPlaybackSnapshot((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const snapshot = raw as Record<string, unknown>;
    const preview = snapshot.preview && typeof snapshot.preview === 'object'
      ? snapshot.preview as Record<string, unknown>
      : null;
    const session = readString(preview?.project_session_id);
    const previousSession = previewStateSession || doc.value?.sessionId;
    // The snapshot includes the current show identity even when Preview is idle.
    if (session && previousSession && session !== previousSession) resetProjectProjection();
    observeStopRevision(snapshot.stop_revision);
    nextItemUuid.value = readString(snapshot.next_item_uuid);
    applyPreviewState(preview ? { ...preview, cueId: preview.cue_id ?? preview.cueId } : null, true);

    const candidates: ActiveCue[] = [];
    for (const entry of Array.isArray(snapshot.cues) ? snapshot.cues : []) {
      if (acceptDiagnosticState(entry)) continue;
      const active = readActiveCue(entry);
      if (!active || active.transport === TRANSPORT_STOPPED
        || (previewCueId !== null && active.cueId === previewCueId)) continue;
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
          resetProjectProjection();
          break;
        case 'next_item_set':
          nextItemUuid.value = readString(patch.itemUuid);
          break;
        case 'preview_started': {
          if (!applyPreviewState(patch)) return;
          if (previewCueId && activeCues.delete(`cue:${previewCueId}`)) {
            renderNewestActive(false);
          }
          break;
        }
        case 'preview_stopped':
          applyPreviewState({ ...patch, cueId: '' });
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
    if (!awaitingFirstFrame) reportPlaybackError(null);
    // Rebuffer/seek can fire canplay again; keep later drift on the meter chase.
    renderNewestActive(firstReady && !element.seeking);
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
      duration: source.duration,
      followsAtEnd: false,
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
      docRequest?.controller.abort();
      syncMetadataRecovery(null);
      acceptNextSnapshot = true;
      stopRevision = null;
      clearHeldFrame();
    } else {
      void refetchDoc();
    }
  }, { immediate: true });

  onScopeDispose(() => {
    clearTimeout(retryTimer);
    clearTimeout(refetchTimer);
    clearTimeout(metadataRetryTimer);
    docRequest?.controller.abort();
    clearHeldFrame();
    pauseVideo();
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
    liveSlot,
    slotSources,
    registerVideoElement,
    onSpareEvent,
    onSpareError,
    heldFrameEl,
    showHeldFrame,
    getPictureHealth,
    videoSrc,
    videoReady,
    onVideoLoadedMetadata,
    onVideoCanPlay,
    onVideoError,
    showVideo,
    cueImageSrc,
    standbySrc,
  };
}
