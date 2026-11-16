import type { AudioItem } from '~/types/project';
import { buildWaveformFromChannels } from '~/utils/audio';
import { buildOneShotSlots } from '~/utils/oneShots';
import { nextVideoWork, type VideoWorkCue } from '~/utils/videoPreflightPlan';

type Phase = 'running' | 'done' | 'stopped' | 'stale' | 'interrupted' | 'unavailable';
type VideoCheckIssue = Exclude<VideoFrameCheckResult, 'ok'>;
export interface VideoConversionState {
  state: 'converting' | 'failed';
  percent: number;
  reason: VideoConvertFailure | 'replace' | 'still-no-picture' | null;
}

export function useVideoPreflightIssues() {
  return useState<Map<string, VideoCheckIssue>>('videoPreflight.issues', () => new Map());
}

// Where the last video check got to, for readers outside the Video tab (the
// Pre-show check reports it). Written only by useVideoPreflight below.
export function useVideoPreflightSummary() {
  return useState<{ phase: Phase | null; checked: number; total: number }>(
    'videoPreflight.summary', () => ({ phase: null, checked: 0, total: 0 }));
}

// Cues whose picture is being converted, or could not be.
export function useVideoConversions() {
  return useState<Map<string, VideoConversionState>>('videoPreflight.conversions', () => new Map());
}

type VideoPreflight = ReturnType<typeof createVideoPreflight>;
let shared: VideoPreflight | undefined;

/**
 * The operator window's one video check. It works by itself while nothing is
 * playing: every video cue is checked once (again when its file or trim
 * changes), and a cue whose picture this computer cannot decode is converted
 * to an H.264 copy beside the original and pointed at that copy. Anything
 * that plays, previews or changes the show stops it at once; it picks up
 * again when the show is idle.
 */
export function useVideoPreflight(): VideoPreflight {
  return shared ??= effectScope(true).run(createVideoPreflight)!;
}

function createVideoPreflight() {
  const server = useLiveplayServer();
  const {
    currentProject, getAllItemsFlat, formatItemIndex, projectEpoch, projectHydrationStatus, previewItemUuid, saveProject,
  } = useProject();
  const { cartOnlyItems } = useCartItems();
  const { activeCues } = useAudioEngine();
  const { t } = useLocalization();
  const { showHeaderWarning } = useHeaderWarnings();
  const issues = useVideoPreflightIssues();
  const conversions = useVideoConversions();
  const phase = ref<Phase | null>(null);
  const checked = ref(0);
  const total = ref(0);
  const busy = ref(false);
  // After a check that could not run at all, wait before trying again.
  const resting = ref(false);
  const summary = useVideoPreflightSummary();
  watch([phase, checked, total], () => {
    summary.value = { phase: phase.value, checked: checked.value, total: total.value };
  }, { flush: 'sync', immediate: true });
  let run: AbortController | null = null;
  // What has been checked, and what has been sent for conversion, as the cue's
  // file and trim were at the time. A cue that changes is looked at again.
  const checkedSources = reactive(new Map<string, string>());
  const convertedSources = reactive(new Map<string, string>());

  const candidates = computed(() => {
    const videos = new Map<string, { item: AudioItem; inPoint: number; outPoint: number | null; source: string }>();
    for (const item of [...getAllItemsFlat(), ...cartOnlyItems.value.values()]) {
      if (item.type !== 'audio' || !(item as AudioItem).hasVideo || videos.has(item.uuid)) continue;
      const audio = item as AudioItem;
      const inPoint = Number.isFinite(audio.inPoint) ? Math.max(0, audio.inPoint) : 0;
      const outPoint = typeof audio.outPoint === 'number' && Number.isFinite(audio.outPoint)
        && audio.outPoint > inPoint ? audio.outPoint : null;
      videos.set(item.uuid, {
        item: audio, inPoint, outPoint,
        source: JSON.stringify([audio.mediaPath, audio.mediaServerPath, inPoint, outPoint]),
      });
    }
    return videos;
  });

  const transportActive = computed(() => activeCues.value.size > 0 || !!previewItemUuid.value ||
    server.stopAllStatus === 'pending' || server.cues.some(cue => (cue.transport ?? 0) !== 0));
  const ready = computed(() => !!currentProject.value && projectHydrationStatus.value === 'ready' &&
    server.connected && !!server.projectSessionId && !server.cueStartsBlocked);
  const canConvert = import.meta.client && !!window.electronAPI?.videoOutput?.convertCue;

  const work = computed(() => nextVideoWork(
    [...candidates.value.values()].map<VideoWorkCue>(({ item, source }) => ({
      uuid: item.uuid, source, issue: issues.value.get(item.uuid) ?? null,
    })),
    checkedSources, convertedSources, canConvert,
  ));

  const conversionText = (state: VideoConversionState) => {
    if (state.state === 'converting') return t('videoCheck.converting', { percent: state.percent });
    if (state.reason === 'remote') return t('videoCheck.convertFailedRemote');
    if (state.reason === 'missing') return t('videoCheck.convertFailedMissing');
    if (state.reason === 'no-converter') return t('videoCheck.convertFailedConverter');
    return t('videoCheck.convertFailed');
  };

  const findings = computed(() => {
    if (!issues.value.size) return [];
    const slots = buildOneShotSlots(currentProject.value?.items ?? [], [...cartOnlyItems.value.values()]);
    return [...issues.value].flatMap(([uuid, reason]) => {
      const item = candidates.value.get(uuid)?.item;
      if (!item) return [];
      const slot = slots.findIndex(entry => entry?.uuid === uuid);
      const cue = formatItemIndex(item.index);
      const label = item.index?.[0] >= 0 ? t('videoCheck.cueNumber', { number: cue })
        : slot >= 0 ? t('videoCheck.quickPlayNumber', { number: slot + 1 }) : '';
      const conversion = conversions.value.get(uuid);
      return [{
        uuid, label, name: item.displayName || item.mediaFileName, reason,
        detail: conversion ? conversionText(conversion) : t(`videoCheck.${reason}`),
      }];
    });
  });

  const message = computed(() => {
    const converting = [...conversions.value].find(([, state]) => state.state === 'converting');
    if (converting) {
      const item = candidates.value.get(converting[0])?.item;
      return t('videoCheck.convertingStatus', {
        name: item?.displayName || item?.mediaFileName || '', percent: converting[1].percent,
      });
    }
    if (phase.value === 'done') {
      if (!total.value) return t('videoCheck.empty');
      return t(issues.value.size ? 'videoCheck.issues' : 'videoCheck.passed', {
        checked: checked.value, count: issues.value.size,
      });
    }
    if (phase.value) return t(`videoCheck.${phase.value}`, { checked: checked.value, total: total.value });
    return t(transportActive.value ? 'videoCheck.waitForIdle' : 'videoCheck.help');
  });

  const countChecked = () => {
    let count = 0;
    for (const [uuid, entry] of candidates.value) if (checkedSources.get(uuid) === entry.source) count++;
    checked.value = count;
  };

  function cancel(next: Phase = 'stopped') {
    run?.abort();
    if (phase.value === 'running' || next === 'stale' && phase.value !== null) phase.value = next;
  }

  watch([currentProject, projectEpoch, () => server.projectSessionId, () => server.serverUrl,
    () => server.effectiveAccessToken], () => {
    cancel();
    issues.value.clear();
    conversions.value.clear();
    checkedSources.clear();
    convertedSources.clear();
    phase.value = null;
  }, { flush: 'sync' });
  watch([ready, transportActive], ([isReady, active]) => {
    if (!isReady || active) cancel();
  }, { flush: 'sync' });
  watch(() => server.connected, connected => { if (!connected) cancel('stale'); });
  watch(() => server.transportActivity, () => cancel(), { flush: 'sync' });
  watch(() => phase.value ? candidates.value : null, (next, previous) => {
    if (!next || !previous) return;
    let changed = next.size !== previous.size;
    for (const [uuid, entry] of previous) {
      if (next.get(uuid)?.source === entry.source) continue;
      issues.value.delete(uuid);
      changed = true;
    }
    if (changed) cancel('stale');
  });

  server.onCueState(({ transport }) => { if (transport !== 0) cancel(); });
  server.onDocPatch(patch => {
    if (patch?.op === 'media_changed' && patch.project_session_id === server.projectSessionId &&
        candidates.value.has(patch.item_uuid)) {
      // The engine has a different file for this cue: what was learned about
      // the old one no longer holds.
      checkedSources.delete(patch.item_uuid);
      if (!phase.value) return;
      issues.value.delete(patch.item_uuid);
      cancel('stale');
    }
  });

  type Candidate = { item: AudioItem; inPoint: number; outPoint: number | null; source: string };

  // Check `queue`, one cue at a time. Returns false when the run was stopped.
  async function checkCues(queue: Candidate[], signal: AbortSignal): Promise<boolean> {
    const api = window.electronAPI!.videoOutput!;
    const { serverUrl, effectiveAccessToken: accessToken, projectSessionId: sessionId } = server;
    const id = crypto.randomUUID();
    const stopProbe = () => api.cancelFrameCheck(id);
    signal.addEventListener('abort', stopProbe, { once: true });
    total.value = candidates.value.size;
    countChecked();
    phase.value = 'running';
    try {
      const progress = await server.fetchProjectProgress(AbortSignal.any([signal, AbortSignal.timeout(5000)]));
      let stalls = 0;
      for (const { item, inPoint, outPoint, source } of queue) {
        if (signal.aborted) return false;
        const result = await api.checkFrame({
          id, serverUrl, accessToken, sessionId, uuid: item.uuid, inPoint, outPoint,
          fileRevision: progress.fileRevisions?.[item.uuid] ?? null,
        });
        if (signal.aborted) return false;
        if (result === 'canceled') {
          phase.value = 'stopped';
          return false;
        }
        if (result === 'ok') issues.value.delete(item.uuid);
        else issues.value.set(item.uuid, result);
        checkedSources.set(item.uuid, source);
        countChecked();
        // One slow or odd file must not leave the rest unchecked. Two in a row
        // look like storage that has stopped answering: a timed-out disk read
        // can outlive its probe, so no more are queued behind it.
        stalls = result === 'timeout' || result === 'probe-error' ? stalls + 1 : 0;
        if (stalls >= 2) {
          phase.value = 'interrupted';
          return false;
        }
      }
      phase.value = 'done';
      return true;
    } catch {
      if (!signal.aborted) {
        phase.value = 'unavailable';
        resting.value = true;
        setTimeout(() => { resting.value = false; }, 30_000);
      }
      return false;
    } finally {
      signal.removeEventListener('abort', stopProbe);
    }
  }

  // The engine reports `media_changed` once it has the cue's new file.
  function engineHasNewMedia(uuid: string, signal: AbortSignal) {
    return new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        off();
        signal.removeEventListener('abort', done);
        resolve();
      };
      const off = server.onDocPatch(patch => {
        if (patch?.op === 'media_changed' && patch.item_uuid === uuid) done();
      });
      const timer = setTimeout(done, 15_000);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  // Point the cue at its converted copy, as replacing its media by hand does:
  // the engine reads the copy first, and the trim is kept.
  async function useConvertedCopy(item: AudioItem, path: string, signal: AbortSignal) {
    const [metadata, serverWaveform] = await Promise.all([
      server.fetchMetadata(path, signal),
      server.fetchWaveformByPath(path, 1000, undefined, signal),
    ]);
    const metadataDuration = Number(metadata?.duration_ms);
    const durationMs = Number.isFinite(metadataDuration) && metadataDuration > 0
      ? metadataDuration : Number(serverWaveform.duration_ms);
    const duration = durationMs / 1000;
    const waveform = buildWaveformFromChannels(serverWaveform.channels, duration, serverWaveform);
    if (metadata?.valid !== true || metadata.has_video !== true || !Number.isFinite(duration) || duration <= 0 || !waveform) {
      throw new Error('The converted copy could not be read.');
    }
    if (signal.aborted || server.cueStartsBlocked) throw new Error('The show changed.');
    const fileName = path.split(/[\\/]/).pop() || item.mediaFileName;
    const usedWholeFile = item.inPoint <= 0 && Math.abs(item.outPoint - item.duration) < 0.05;
    const inPoint = usedWholeFile ? 0 : Math.min(item.inPoint, Math.max(0, duration - 0.01));
    const outPoint = usedWholeFile ? duration
      : Math.min(duration, Math.max(inPoint + Math.min(0.01, duration), Math.min(item.outPoint, duration)));
    const settled = engineHasNewMedia(item.uuid, signal);
    item.mediaFileName = fileName;
    item.mediaServerPath = path;
    // A cue copied into the show stays in the show's media folder; a linked
    // cue stays linked, to the copy beside its original.
    if (item.mediaPath) item.mediaPath = `media/${fileName}`;
    item.waveform = waveform;
    item.duration = duration;
    item.inPoint = inPoint;
    item.outPoint = outPoint;
    if (typeof item.startNextTime === 'number') {
      item.startNextTime = Math.max(inPoint, Math.min(item.startNextTime, outPoint));
    }
    // A QuickPlay's own cue is saved with the show, like any change to a tile.
    if (!(item.index?.[0] >= 0)) void saveProject();
    await settled;
    void server.requestWaveformGeneration(path, item.uuid, true).catch(() => {});
  }

  async function convertCue({ item, source }: Candidate, signal: AbortSignal) {
    const api = window.electronAPI!.videoOutput!;
    const uuid = item.uuid;
    const name = item.displayName || item.mediaFileName;
    const id = crypto.randomUUID();
    convertedSources.set(uuid, source);
    conversions.value.set(uuid, { state: 'converting', percent: 0, reason: null });
    const offProgress = api.onConvertProgress(progress => {
      if (progress.id === id && conversions.value.get(uuid)?.state === 'converting') {
        conversions.value.set(uuid, { state: 'converting', percent: progress.percent, reason: null });
      }
    });
    const stop = () => api.cancelConvert(id);
    signal.addEventListener('abort', stop, { once: true });
    try {
      const result = await api.convertCue({ id, sessionId: server.projectSessionId, uuid });
      if (signal.aborted || result.status === 'canceled') {
        // Stopped because the show needed the machine: tried again when idle.
        convertedSources.delete(uuid);
        conversions.value.delete(uuid);
        return;
      }
      if (!('path' in result)) {
        conversions.value.set(uuid, { state: 'failed', percent: 0, reason: result.reason });
        return;
      }
      await useConvertedCopy(item, result.path, signal);
      // The copy is checked next; it is not sent for conversion again.
      const copy = candidates.value.get(uuid);
      if (copy) convertedSources.set(uuid, copy.source);
      conversions.value.delete(uuid);
      showHeaderWarning(t('videoCheck.converted', { name }));
    } catch {
      if (signal.aborted) {
        convertedSources.delete(uuid);
        conversions.value.delete(uuid);
      } else {
        conversions.value.set(uuid, { state: 'failed', percent: 0, reason: 'replace' });
      }
    } finally {
      offProgress();
      signal.removeEventListener('abort', stop);
    }
  }

  // Do what is waiting: check the cues not yet checked, then convert, one at a
  // time, the ones with no picture, checking each copy as it arrives.
  async function pump() {
    if (!import.meta.client || !window.electronAPI?.videoOutput?.checkFrame) return;
    if (busy.value || !ready.value || transportActive.value) return;
    const controller = new AbortController();
    run = controller;
    const { signal } = controller;
    busy.value = true;
    try {
      while (!signal.aborted) {
        const next = work.value;
        if (next.check.length) {
          const queue = next.check.flatMap(uuid => candidates.value.get(uuid) ?? []);
          if (!await checkCues(queue, signal)) return;
          continue;
        }
        const convert = next.convert[0] && candidates.value.get(next.convert[0]);
        if (!convert) {
          // A copy that still has no picture is said to have failed.
          for (const uuid of next.stillFailing) {
            if (!conversions.value.has(uuid)) {
              conversions.value.set(uuid, { state: 'failed', percent: 0, reason: 'still-no-picture' });
            }
          }
          return;
        }
        await convertCue(convert, signal);
      }
    } finally {
      if (run === controller) run = null;
      busy.value = false;
    }
  }

  // The button: check every video again, and try again what could not be converted.
  async function start() {
    if (!ready.value || transportActive.value || busy.value) return;
    checkedSources.clear();
    convertedSources.clear();
    conversions.value.clear();
    total.value = candidates.value.size;
    checked.value = 0;
    if (!candidates.value.size) {
      phase.value = 'done';
      return;
    }
    await pump();
  }

  // By itself: whenever there is something to do and the show is idle.
  let waiting: ReturnType<typeof setTimeout> | null = null;
  const wanted = computed(() => ready.value && !transportActive.value && !busy.value && !resting.value &&
    (work.value.check.length > 0 || work.value.convert.length > 0));
  watch(wanted, (isWanted) => {
    if (waiting) clearTimeout(waiting);
    waiting = isWanted ? setTimeout(() => { waiting = null; void pump(); }, 1500) : null;
  }, { immediate: true });

  return { busy, phase, transportActive, ready, findings, message, start, cancel };
}
