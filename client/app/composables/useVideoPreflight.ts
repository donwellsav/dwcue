import type { Ref } from 'vue';
import type { AudioItem } from '~/types/project';
import { buildOneShotSlots } from '~/utils/oneShots';

type Phase = 'running' | 'done' | 'stopped' | 'stale' | 'interrupted' | 'unavailable';
type VideoCheckIssue = Exclude<VideoFrameCheckResult, 'ok'>;

export function useVideoPreflightIssues() {
  return useState<Map<string, VideoCheckIssue>>('videoPreflight.issues', () => new Map());
}

export function useVideoPreflight(visible: Readonly<Ref<boolean>>) {
  const server = useLiveplayServer();
  const { currentProject, getAllItemsFlat, formatItemIndex, projectEpoch, projectHydrationStatus, previewItemUuid } = useProject();
  const { cartOnlyItems } = useCartItems();
  const { activeCues } = useAudioEngine();
  const { t } = useLocalization();
  const issues = useVideoPreflightIssues();
  const phase = ref<Phase | null>(null);
  const checked = ref(0);
  const total = ref(0);
  const busy = ref(false);
  let run: AbortController | null = null;

  const candidates = computed(() => {
    const videos = new Map<string, { item: AudioItem; inPoint: number; source: string }>();
    for (const item of [...getAllItemsFlat(), ...cartOnlyItems.value.values()]) {
      if (item.type !== 'audio' || !(item as AudioItem).hasVideo || videos.has(item.uuid)) continue;
      const audio = item as AudioItem;
      const inPoint = Number.isFinite(audio.inPoint) ? Math.max(0, audio.inPoint) : 0;
      videos.set(item.uuid, {
        item: audio, inPoint,
        source: JSON.stringify([audio.mediaPath, audio.mediaServerPath, inPoint]),
      });
    }
    return videos;
  });

  const transportActive = computed(() => activeCues.value.size > 0 || !!previewItemUuid.value ||
    server.stopAllStatus === 'pending' || server.cues.some(cue => (cue.transport ?? 0) !== 0));
  const ready = computed(() => visible.value && !!currentProject.value && projectHydrationStatus.value === 'ready' &&
    server.connected && !!server.projectSessionId && !server.cueStartsBlocked);

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
      return [{ uuid, label, name: item.displayName || item.mediaFileName, reason }];
    });
  });

  const message = computed(() => {
    if (phase.value === 'done') {
      if (!total.value) return t('videoCheck.empty');
      return t(issues.value.size ? 'videoCheck.issues' : 'videoCheck.passed', {
        checked: checked.value, count: issues.value.size,
      });
    }
    if (phase.value) return t(`videoCheck.${phase.value}`, { checked: checked.value, total: total.value });
    return t(transportActive.value ? 'videoCheck.waitForIdle' : 'videoCheck.help');
  });

  function cancel(next: Phase = 'stopped') {
    run?.abort();
    if (phase.value === 'running' || next === 'stale' && phase.value !== null) phase.value = next;
  }

  watch([currentProject, projectEpoch, () => server.projectSessionId, () => server.serverUrl,
    () => server.effectiveAccessToken], () => {
    cancel();
    issues.value.clear();
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

  const offCue = server.onCueState(({ transport }) => { if (transport !== 0) cancel(); });
  const offPatch = server.onDocPatch(patch => {
    if (patch?.op === 'media_changed' && patch.project_session_id === server.projectSessionId &&
        phase.value && candidates.value.has(patch.item_uuid)) {
      issues.value.delete(patch.item_uuid);
      cancel('stale');
    }
  });
  onScopeDispose(() => {
    cancel();
    offCue();
    offPatch();
    issues.value.clear();
  });

  async function start() {
    if (!import.meta.client || !ready.value || transportActive.value || busy.value) return;
    const api = window.electronAPI?.videoOutput;
    if (!api?.checkFrame) return;
    const { serverUrl, effectiveAccessToken: accessToken, projectSessionId: sessionId } = server;
    const queue = [...candidates.value.values()];
    total.value = queue.length;
    checked.value = 0;
    if (!queue.length) {
      phase.value = 'done';
      return;
    }

    const id = crypto.randomUUID();
    const controller = new AbortController();
    run = controller;
    const { signal } = controller;
    const stopProbe = () => api.cancelFrameCheck(id);
    signal.addEventListener('abort', stopProbe, { once: true });
    busy.value = true;
    phase.value = 'running';
    try {
      const progress = await server.fetchProjectProgress(AbortSignal.any([signal, AbortSignal.timeout(5000)]));
      // ponytail: sample the In point only. Rehearse the full cue for errors later in the file.
      for (const { item, inPoint } of queue) {
        if (signal.aborted) return;
        const result = await api.checkFrame({
          id, serverUrl, accessToken, sessionId, uuid: item.uuid, inPoint,
          fileRevision: progress.fileRevisions?.[item.uuid] ?? null,
        });
        if (signal.aborted) return;
        if (result === 'canceled') {
          phase.value = 'stopped';
          return;
        }
        if (result === 'ok') issues.value.delete(item.uuid);
        else issues.value.set(item.uuid, result);
        checked.value++;
        // A timed-out disk read can outlive the probe. Avoid queuing more reads.
        if (result === 'timeout' || result === 'probe-error') {
          phase.value = 'interrupted';
          return;
        }
      }
      phase.value = 'done';
    } catch {
      if (!signal.aborted) phase.value = 'unavailable';
    } finally {
      signal.removeEventListener('abort', stopProbe);
      run = null;
      busy.value = false;
    }
  }

  return { busy, phase, transportActive, ready, findings, message, start, cancel };
}
