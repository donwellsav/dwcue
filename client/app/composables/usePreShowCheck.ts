// =====================================================================
// usePreShowCheck.ts
// ---------------------------------------------------------------------
// Gathers what the Pre-show check needs and hands it to the pure decision
// module (utils/preShowCheck.ts); PreShowCheckPanel shows the outcome.
//
// The check only reads. It asks the engine three questions the engine
// already answers for the rest of the app — its summary (for the version),
// its outputs, and its readiness report — and reads the show as this window
// holds it. It never starts, stops, seeks or reloads a cue, and it asks the
// engine nothing that opens a media file, so an absent or slow drive cannot
// queue work in front of Stop All or GO.
// =====================================================================
import type { AudioItem } from '~/types/project';
import type { ServerAudioReadiness, ServerDeviceInfo } from '~/types/server';
import { buildOneShotSlots } from '~/utils/oneShots';
import { isNativeProjectPath } from '~/utils/projectFileFormats';
import {
  checkFile, checkMedia, checkOutput, checkVideo, runPreShowCheck,
  type CueFact, type FileFacts, type MediaReport, type OutputDeviceFact, type OutputFacts,
  type PreShowCheckResult, type VideoFacts,
} from '~/utils/preShowCheck';

const REQUEST_TIMEOUT_MS = 5000;
const SAVE_SETTLE_MS = 1500;
// With more named cues and outputs than this the panel is given room to resize.
const LONG_LIST_ENTRIES = 6;

interface CheckSnapshot {
  result: PreShowCheckResult;
  identity: string;     // which show, on which engine, this result is about
  fingerprint: string;  // what the app's own state said the lines were, then
  at: number;
}

// Read by MainWorkspace to size the panel: a short result fits its contents.
export const usePreShowCheckLongList = () => useState<boolean>('preShowCheck.longList', () => false);

const answered = <T>(request: Promise<T>): Promise<T | null> => request.catch(() => null);

// For engine calls that take no abort signal: stop waiting, leave the call be.
const within = <T>(request: Promise<T>): Promise<T> => Promise.race([
  request,
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), REQUEST_TIMEOUT_MS)),
]);

const toDeviceFact = (device: ServerDeviceInfo): OutputDeviceFact => ({
  id: device.id,
  name: device.display_name,
  isDefault: !!device.is_default,
  isOpen: !!device.is_open,
  isAvailable: device.is_available !== false,
  state: device.runtime_state ?? 'available',
});

const toMediaReport = (readiness: ServerAudioReadiness): MediaReport => ({
  loading: !!readiness.loading,
  failures: (readiness.failures ?? []).map(failure => ({
    itemUuid: failure.itemUuid, code: failure.code, path: failure.path ?? '',
  })),
  loaded: readiness.fileRevisions ? Object.keys(readiness.fileRevisions) : null,
});

export function usePreShowCheck() {
  // Every shared ref is taken here, in setup: run() continues after awaits,
  // where the Nuxt context these lookups need is no longer there.
  const server = useLiveplayServer();
  const {
    currentProject, getAllItemsFlat, formatItemIndex, findItemByUuid, selectedItem, toggleItemSelection,
    projectEpoch, projectHydrationStatus, projectFilePath, audioLoadingProgress,
    hasUnsavedChanges, saveFailed, autoSaveEnabled, projectRepair,
    workspaceImportPanel, cancelDelete,
  } = useProject();
  const { cartOnlyItems } = useCartItems();
  const videoIssues = useVideoPreflightIssues();
  const videoSummary = useVideoPreflightSummary();
  const showProjectSettings = useState('showProjectSettings', () => false);
  const settingsTab = useState('projectSettingsTab', () => 'audio');
  const snapshot = useState<CheckSnapshot | null>('preShowCheck.snapshot', () => null);
  const busy = useState<boolean>('preShowCheck.busy', () => false);
  const appVersion = useState<string | null>('preShowCheck.appVersion', () => null);
  const longList = usePreShowCheckLongList();

  // Every audio cue the show can fire: the playlist, cues inside groups, and
  // QuickPlays that live outside the playlist.
  const audioCues = computed(() => {
    const standalone = [...cartOnlyItems.value.values()];
    const slotOf = new Map<string, number>();
    buildOneShotSlots(currentProject.value?.items ?? [], standalone)
      .forEach((item, slot) => { if (item) slotOf.set(item.uuid, slot); });
    const cues: CueFact[] = [];
    const seen = new Set<string>();
    const add = (item: { uuid: string; type: string }, inPlaylist: boolean) => {
      if (item.type !== 'audio' || seen.has(item.uuid)) return;
      seen.add(item.uuid);
      const audio = item as AudioItem;
      const slot = slotOf.get(audio.uuid);
      cues.push({
        uuid: audio.uuid,
        name: audio.displayName || audio.mediaFileName || '',
        inPlaylist,
        cueNumber: inPlaylist ? formatItemIndex(audio.index) || null : null,
        quickPlayNumber: slot === undefined ? null : slot + 1,
        output: audio.deviceOverride || null,
        hasVideo: !!audio.hasVideo,
      });
    };
    for (const item of getAllItemsFlat()) add(item, true);
    for (const item of standalone) add(item, false);
    return cues;
  });

  // The facts this window holds without asking the engine anything.
  const outputFacts = (): OutputFacts => {
    const settings = currentProject.value?.settings;
    return {
      devices: server.devices.map(toDeviceFact),
      main: settings?.defaultOutputDevice || null,
      preview: settings?.previewDevice || null,
      ltc: settings?.ltcDevice || null,
    };
  };
  const fileFacts = (): FileFacts => ({
    hasFile: isNativeProjectPath(projectFilePath.value),
    unsaved: hasUnsavedChanges.value,
    saveFailed: saveFailed.value,
    autoSave: autoSaveEnabled.value,
    repairPending: !!projectRepair.value,
  });
  const videoFacts = (): VideoFacts => ({
    available: !!window.electronAPI?.videoOutput?.checkFrame,
    ...videoSummary.value,
    issueUuids: [...videoIssues.value.keys()],
  });
  const listReady = () => projectHydrationStatus.value === 'ready';

  const identity = computed(() => `${projectEpoch.value}|${server.projectSessionId}|${server.serverUrl}`);

  // What the lines come to from state the app keeps current on its own (its
  // device list, its last readiness report, its save and video-check state).
  // A result is shown as out of date once this differs from how it stood when
  // the check ran, so a "Ready" from before a cable was pulled, a file went
  // missing or a cue was added cannot linger. It tracks what the check
  // reports, not incidental churn such as an output opening when a cue plays.
  const fingerprint = computed(() => JSON.stringify([
    server.connected, server.cueStartsBlocked,
    checkOutput(outputFacts(), audioCues.value),
    checkMedia(audioCues.value, { listReady: listReady(), report: toMediaReport(audioLoadingProgress.value) }),
    checkFile(fileFacts()),
    checkVideo(audioCues.value, videoFacts()),
  ]));

  const current = computed(() => snapshot.value?.identity === identity.value ? snapshot.value : null);
  const result = computed(() => current.value?.result ?? null);
  const checkedAt = computed(() => current.value?.at ?? null);
  const outdated = computed(() => !!current.value && current.value.fingerprint !== fingerprint.value);
  const isOpen = computed(() => workspaceImportPanel.value === 'show-check' && !showProjectSettings.value);

  async function engineGet<T>(path: string): Promise<T> {
    const headers = new Headers();
    if (server.effectiveAccessToken) headers.set('Authorization', `Bearer ${server.effectiveAccessToken}`);
    const response = await fetch(server.serverUrl.replace(/\/+$/, '') + path, {
      headers, cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(String(response.status));
    return await response.json() as T;
  }

  async function loadAppVersion() {
    if (appVersion.value) return;
    try {
      appVersion.value = await window.electronAPI?.getAppVersion?.() || null;
    } catch { /* stays unknown, and the engine line says so */ }
  }

  // An autosave already on its way gets a moment to land, so the show file
  // line reports where the save ended up rather than catching it in flight.
  async function saveSettled() {
    const deadline = Date.now() + SAVE_SETTLE_MS;
    while (autoSaveEnabled.value && hasUnsavedChanges.value && !saveFailed.value && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async function run() {
    if (!import.meta.client || busy.value || !currentProject.value) return;
    const checking = identity.value;
    busy.value = true;
    try {
      const [summary, devicesListed, readiness] = await Promise.all([
        answered(engineGet<{ server?: { version?: unknown } }>('/api/state/summary')),
        answered(within(server.fetchDevices().then(() => true))),
        answered(server.fetchProjectProgress(AbortSignal.timeout(REQUEST_TIMEOUT_MS))),
        loadAppVersion(),
        saveSettled(),
      ]);
      // A result for a show or engine that is no longer the one on screen is dropped.
      if (identity.value !== checking || !currentProject.value) return;

      const engineVersion = summary?.server?.version;
      const next = runPreShowCheck({
        engine: {
          connected: server.connected,
          answered: !!summary,
          startsHeld: server.cueStartsBlocked,
          engineVersion: typeof engineVersion === 'string' ? engineVersion : null,
          appVersion: appVersion.value,
        },
        output: devicesListed ? outputFacts() : { ...outputFacts(), devices: null },
        cues: audioCues.value,
        media: { listReady: listReady(), report: readiness ? toMediaReport(readiness) : null },
        file: fileFacts(),
        video: videoFacts(),
      });
      snapshot.value = { result: next, identity: checking, fingerprint: fingerprint.value, at: Date.now() };
      longList.value = next.lines.reduce((count, line) => count + line.entries.length, 0) > LONG_LIST_ENTRIES;
    } finally {
      busy.value = false;
    }
  }

  // The panel runs the check when it appears, so opening it is all a button
  // needs to do.
  function open() {
    if (!currentProject.value) return;
    if (workspaceImportPanel.value === 'delete-selection') cancelDelete();
    showProjectSettings.value = false;
    workspaceImportPanel.value = 'show-check';
  }

  function close() {
    if (workspaceImportPanel.value === 'show-check') workspaceImportPanel.value = null;
  }

  function toggle() {
    if (isOpen.value) close();
    else open();
  }

  // Selecting a cue is what reveals it: the playlist opens the groups around
  // the selection and scrolls its row into view. Selecting starts nothing.
  function reveal(uuid: string) {
    if (!findItemByUuid(uuid)) return;
    const alreadySelected = selectedItem.value?.uuid === uuid;
    toggleItemSelection(uuid, false, false);
    // An unchanged selection gives the playlist nothing to react to.
    if (alreadySelected) {
      void nextTick(() => document.querySelector(`[data-item-uuid="${CSS.escape(uuid)}"] > .item-content`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    }
  }

  // The video check lives in Settings › Video Output. This panel stays set
  // underneath and checks again when Settings closes.
  function openVideoCheck() {
    settingsTab.value = 'video';
    showProjectSettings.value = true;
  }

  return { result, busy, outdated, checkedAt, isOpen, run, open, close, toggle, reveal, openVideoCheck };
}
