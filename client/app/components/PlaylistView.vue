<template>
  <div class="playlist-view" :style="playlistRowStyle">
    <div class="playlist-header workspace-panel-header">
      <div class="workspace-panel-header__leading">
        <slot name="header-leading" />
        <h2 class="workspace-panel-header__title">{{ t('playlist.title') }}</h2>
      </div>
      <!-- Import / add-group are edit actions — hidden in Show Mode. -->
      <div v-if="!showMode" class="playlist-actions">
        <Btn icon="audio_file" :text="t('playlist.importAudio')" :disabled="!currentProject" @click="handleImport" />
        <Btn v-if="canOnlineImport" icon="youtube_activity" :text="t('youtube.importFromYouTube')" @click="showYouTubeModal = true" />
        <Btn v-if="canOnlineImport" icon="library_music" :text="t('spotifyImport.button')" @click="showSpotifyModal = true" />
        <Btn icon="folder" :text="t('playlist.addGroup')" :disabled="!currentProject" @click="handleAddGroup" />
      </div>
    </div>
    
    <div ref="scrollContainer" class="playlist-content" @drop="handleDrop" @dragover.prevent>
      <div v-if="currentProject?.items.length === 0" class="empty-state">
        <p>{{ t('playlist.noItems') }}</p>
        <p class="hint">{{ t('playlist.importHint') }}</p>
      </div>
      
      <div v-else class="item-list">
        <PlaylistItem
          v-for="item in visibleItems"
          :key="item.uuid"
          :item="item"
          :depth="0"
        />
        <!-- Placeholder row so the user sees mounting is in progress while
             the remaining items hydrate across the next few frames. -->
        <div v-if="visibleItems.length < currentProject.items.length"
             class="item-list-progress">
          {{ t('common.loading') }} ({{ visibleItems.length }} / {{ currentProject.items.length }})
        </div>
      </div>
    </div>

    <!-- YouTube Import Modal -->
    <YouTubeImportModal
      :is-open="showYouTubeModal"
      :project-folder-path="currentProject?.folderPath ?? ''"
      :project-epoch="projectEpoch"
      :import-files="importFromServerPaths"
      @close="showYouTubeModal = false"
    />

    <!-- Spotify Import Modal -->
    <SpotifyImportModal
      :open="showSpotifyModal"
      :project-folder-path="currentProject?.folderPath ?? ''"
      :project-epoch="projectEpoch"
      :import-files="importFromServerPaths"
      @close="showSpotifyModal = false"
    />

    <!-- Audio Import Modal — server browse + native upload -->
    <AudioImportModal :open="showImportModal"
                      :busy="audioImportBusy"
                      :result="audioImportResult"
                      :progress="audioImportProgress"
                      @pick="onImportPick"
                      @cancel="cancelAudioImport"
                      @close="closeAudioImport" />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import YouTubeImportModal from './YouTubeImportModal.vue';
import AudioImportModal from './AudioImportModal.vue';
import SpotifyImportModal from './SpotifyImportModal.vue';
import Btn from './Btn.vue';
import type { AudioItem, GroupItem, Project, ProjectSettings } from '~/types/project';
import {
  DEFAULT_AUDIO_ITEM,
  DEFAULT_CART_SLOT_KEYS,
  DEFAULT_GROUP_ITEM,
  DEFAULT_PROJECT_SETTINGS,
  DEFAULT_THEME,
  anchorStartNextMarker,
  colorForNewAudioItem,
  transitionDefaultsForImport,
} from '~/types/project';
import { useLiveplayServer } from '~/composables/useLiveplayServer';
import { useOutputTarget } from '~/composables/useOutputTarget';
import {
  applyLoudnessMatch,
  applyTruePeakCeiling,
  buildWaveformFromChannels,
  trimSilence,
} from '~/utils/audio';

const {
  currentProject,
  addItem,
  removeItem,
  saveProject,
  getAllItemsFlat,
  findItemByUuid,
  projectEpoch,
} = useProject();
const { t } = useLocalization();
const { levels: outputTargetLevels } = useOutputTarget();
const { activeCues, nextItemOverrideUuid } = useAudioEngine();
const {
  uiMode,
  regularPlaylistRowHeight,
  showPlaylistRowHeight,
  folderPlaylistRowHeight,
  waveformOpacity,
} = useUiMode();
const { revealSelection, commitReveal, clearReveals } = usePlaylistReveal();
const server = useLiveplayServer();
// Same useState key useProject/useShowControl bind to — watching the uuid (not
// the `selectedItem` computed) means we react to the selection MOVING, not to
// the item object being rebuilt by a server-pushed document.
const selectedItemUuid = useState<string | null>('selectedItemUuid', () => null);
const showMode = computed(() => uiMode.value === 'playback');
const playlistRowStyle = computed(() => ({
  '--playlist-row-height': `${regularPlaylistRowHeight.value}px`,
  '--show-playlist-row-height': `${showPlaylistRowHeight.value}px`,
  '--folder-playlist-row-height': `${folderPlaylistRowHeight.value}px`,
  '--playlist-waveform-opacity': String(waveformOpacity.value / 100),
}));
const scrollContainer = ref<HTMLElement | null>(null);
const canOnlineImport = computed(() => !!currentProject.value && server.isLocalServer);

const showYouTubeModal = ref(false);
const showSpotifyModal = ref(false);
const showImportModal  = ref(false);
const audioImportBusy = ref(false);
const audioImportResult = ref<ImportBatchResult | null>(null);
const audioImportProgress = ref<{ current: number; total: number; name: string } | null>(null);
let audioImportAbortController: AbortController | null = null;

// ---------------------------------------------------------------------------
// Progressive mount.
// ---------------------------------------------------------------------------
// <PlaylistItem> is a heavy component (~1000 LOC, observers, refs). Mounting
// hundreds of them in a single tick freezes the renderer for hundreds of ms
// after the project header arrives. We mount in chunks across animation
// frames so the workspace stays interactive while the rest hydrate.
//
// First batch is sized to fill a typical viewport (~25 rows). Subsequent
// batches are larger (50/RAF) since by then the user is already looking at
// rendered content — they tolerate background work better than initial blank.
const INITIAL_RENDER  = 25;
const RENDER_INCREMENT = 50;
const renderLimit = ref(INITIAL_RENDER);

const visibleItems = computed(() => {
  const all = currentProject.value?.items ?? [];
  return renderLimit.value >= all.length ? all : all.slice(0, renderLimit.value);
});

// Whenever the project changes (open/new/close), reset the mount window and
// kick off the progressive expansion.
let raf: number | null = null;
function scheduleMoreItems() {
  if (raf !== null) return;
  raf = requestAnimationFrame(() => {
    raf = null;
    const total = currentProject.value?.items.length ?? 0;
    if (renderLimit.value >= total) return;
    renderLimit.value = Math.min(total, renderLimit.value + RENDER_INCREMENT);
    if (renderLimit.value < total) scheduleMoreItems();
  });
}

// React to (a) new project loaded, (b) streamed pages appended, (c) user adds.
watch(
  () => currentProject.value?.items.length ?? 0,
  (total) => {
    if (total === 0) { renderLimit.value = INITIAL_RENDER; return; }
    if (renderLimit.value < total) scheduleMoreItems();
  },
  { immediate: true },
);

// ---------------------------------------------------------------------------
// "UI scrolls to currently playing" (project setting, default off).
// Keep the currently-playing row centred so long lists follow playback. The
// server owns playback; this only mirrors it — we watch which item is playing
// and, when enabled, scroll its row into the middle of the list container.
// ---------------------------------------------------------------------------
const scrollToPlayingEnabled = computed(
  () => !!(currentProject.value as any)?.settings?.uiScrollToPlaying,
);
// Follow the most-recently-started active cue (during a seamless advance the
// incoming cue is the newer entry, which is the one worth centring on).
const primaryPlayingUuid = computed<string | null>(() => {
  const keys = [...activeCues.value.keys()];
  return keys.length ? keys[keys.length - 1]! : null;
});

function scrollItemIntoView(uuid: string, block: ScrollLogicalPosition = 'center') {
  const container = scrollContainer.value;
  if (!container) return;
  const el = container.querySelector<HTMLElement>(`[data-item-uuid="${uuid}"]`);
  if (el) {
    el.scrollIntoView({ block, behavior: 'smooth' });
    return;
  }
  // Row not mounted yet (progressive mount window / nested group): bump the
  // render window to include the item's top-level ancestor, then retry.
  const item = findItemByUuid(uuid);
  const topIndex = item?.index?.[0];
  if (typeof topIndex === 'number' && topIndex >= renderLimit.value) {
    renderLimit.value = topIndex + 1;
    nextTick(() => scrollItemIntoView(uuid, block));
  }
}

watch(
  [primaryPlayingUuid, scrollToPlayingEnabled],
  ([uuid, enabled]) => {
    if (!enabled || !uuid) return;
    nextTick(() => scrollItemIntoView(uuid));
  },
);

// ---------------------------------------------------------------------------
// Keep the selection reachable.
// ---------------------------------------------------------------------------
// The selection can be moved from off-screen — the select-up/select-down key
// bindings, MIDI, or a Companion surface via the server — and those walk the
// flattened tree, so the target may be scrolled away or buried in a collapsed
// group. Hold the group open (see usePlaylistReveal), then scroll.
//
// `block: 'nearest'` rather than 'center': it is a no-op when the row is
// already fully visible, so ordinary mouse clicks never jerk the list around,
// and an off-screen selection is brought in with the smallest move that works.
watch(selectedItemUuid, (uuid) => {
  revealSelection(uuid);
  if (!uuid) return;
  // A revealed group renders its children on the next flush, so the row we
  // want to scroll to does not exist yet at this point.
  nextTick(() => scrollItemIntoView(uuid, 'nearest'));
});

// Playing a cue or arming one as Up Next is a commitment: the group it lives
// in stops being a temporary peek and becomes normally expanded, staying open
// until the operator collapses it by hand. nextItemOverrideUuid covers both an
// operator arming and the server's own arming after a cue ends.
// Keyed on the joined uuids, not the array: activeCues is rewritten on every
// playhead tick, and an array getter would re-fire the tree walk ~20x/sec.
watch(
  () => [...activeCues.value.keys()].join('|'),
  (keys) => { for (const uuid of keys.split('|')) if (uuid) commitReveal(uuid); },
);
watch(nextItemOverrideUuid, (uuid) => {
  if (uuid) commitReveal(uuid);
});

onUnmounted(() => {
  if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
});

// Queue waveform generation for every audio item that lacks current decoded
// analysis. Legacy peak-only waveforms are redrawn immediately, then replaced
// once with the server's versioned LUFS/true-peak result.
// We can't gate on isLoading flipping false — it flips before
// streamItemPages() has pushed any pages, so the items array is still
// empty at that moment. Instead we react to items actually appearing
// (length change), debounced so each streamed page doesn't fire its
// own request storm, and track which uuids we've already requested
// so we don't re-queue on every change.
const requestedWaveformUuids = new Set<string>();
let waveformScanTimer: ReturnType<typeof setTimeout> | null = null;
const scanForMissingWaveforms = async () => {
  if (!currentProject.value) return;
  try {
    const server = (await import('~/composables/useLiveplayServer')).useLiveplayServer();
    const folder = currentProject.value.folderPath || '';
    // Include cart-only items too — they live in a separate array and the
    // playlist flatten wouldn't otherwise reach them, so cart slots backed
    // by cart-only audio would never get their waveforms generated.
    const cartOnly = (currentProject.value.cartOnlyItems ?? []) as AudioItem[];
    const all = [...getAllItemsFlat(), ...cartOnly];
    for (const item of all) {
      if (item.type !== 'audio') continue;
      const ai = item as AudioItem;
      if (ai.waveform?.analysis_version === 1) continue;
      if (requestedWaveformUuids.has(ai.uuid)) continue;

      // Prefer the explicit server-absolute path written by the new import
      // flow. Fall back to project-folder + relative mediaPath for items
      // saved before mediaServerPath was introduced, so legacy projects
      // still get waveforms after a reopen.
      let path = ai.mediaServerPath || '';
      if (!path && ai.mediaPath && folder) {
        const rel = ai.mediaPath.replace(/^[\\/]+/, '');
        path = `${folder.replace(/[\\/]+$/, '')}/${rel}`;
      }
      if (!path) continue;

      requestedWaveformUuids.add(ai.uuid);
      server.requestWaveformGeneration(path, ai.uuid).catch(() => {
        requestedWaveformUuids.delete(ai.uuid);
      });
    }
  } catch (e) {
    console.warn('[waveform] project-load waveform generation failed:', e);
  }
};
watch(
  () => [
    currentProject.value?.folderPath ?? '',
    currentProject.value?.name ?? '',
    currentProject.value?.items?.length ?? 0,
    projectEpoch.value,
  ] as const,
  ([folder, name, , epoch], [prevFolder, prevName, , prevEpoch]) => {
    // Reset the "already requested" tracker when the project changes. Temporary
    // group reveals go with it — they point at uuids from the old document.
    //
    // The epoch check covers reloads of the SAME project, where folderPath and
    // name are both unchanged: session recovery re-hydrates from the server
    // with fresh items that carry no peaks, and without a reset every uuid
    // would still be marked "already requested" from before the disconnect, so
    // nothing would ever ask the server for them again.
    if (folder !== prevFolder || name !== prevName || epoch !== prevEpoch) {
      requestedWaveformUuids.clear();
      clearReveals();
    }
    if (waveformScanTimer) clearTimeout(waveformScanTimer);
    waveformScanTimer = setTimeout(scanForMissingWaveforms, 150);
  },
);
// Also watch cartOnlyItems separately — the scanner needs to re-run when
// new cart items appear (cart hydration happens after the playlist).
watch(
  () => currentProject.value?.cartOnlyItems?.length ?? 0,
  () => {
    if (waveformScanTimer) clearTimeout(waveformScanTimer);
    waveformScanTimer = setTimeout(scanForMissingWaveforms, 150);
  },
  { immediate: true },
);

const handleImport = () => {
  if (!currentProject.value) return;
  audioImportResult.value = null;
  showImportModal.value = true;
};

// Called once per file the user selected in the modal (server browse or upload).
// The path is always a server-side absolute path at this point.
const onImportPick = async (
  serverPaths: string | string[],
  options?: ImportBatchOptions,
) => {
  // The modal now batches selections; accept either a single path (legacy) or
  // an array. Import sequentially so each item gets a stable, ordered index.
  const paths = Array.isArray(serverPaths) ? serverPaths : [serverPaths];
  audioImportAbortController?.abort();
  audioImportAbortController = new AbortController();
  audioImportProgress.value = null;
  audioImportBusy.value = true;
  try {
    audioImportResult.value = await importFromServerPaths(paths, audioImportAbortController.signal, {
      ...options,
      onProgress: (current, total, name) => {
        audioImportProgress.value = { current, total, name };
      },
    });
  } finally {
    audioImportBusy.value = false;
    audioImportProgress.value = null;
    audioImportAbortController = null;
  }
};

const cancelAudioImport = () => audioImportAbortController?.abort();

const closeAudioImport = () => {
  if (audioImportBusy.value) return;
  showImportModal.value = false;
  audioImportResult.value = null;
};

interface PreparedImport {
  audioItem: AudioItem;
  mediaServerPath: string;
  resultIndex: number;
}

type ImportFileStatus = 'ready' | 'warning' | 'failed' | 'skipped';

interface ImportFileResult {
  sourcePath: string;
  displayName: string;
  status: ImportFileStatus;
  reason?: string;
  itemUuid?: string;
  details?: {
    fileType: string;
    duration: number;
    sampleRate: number;
    channels: number;
    bitrateKbps: number;
    truePeakDbtp: number | null;
  };
}

interface ImportBatchResult {
  success: boolean;
  imported: number;
  error?: string;
  retainFiles?: boolean;
  groupUuid?: string;
  results: ImportFileResult[];
}

interface ImportBatchOptions {
  groupName?: string;
  templateFolderPath?: string;
  displayNames?: string[];
  fileMode?: 'copy' | 'link';
  duplicatePolicy?: 'reuse' | 'skip' | 'keep';
  existingGroupUuid?: string;
  onProgress?: (current: number, total: number, name: string) => void;
}

const buildVerifiedAudioCue = async (
  serverPath: string,
  settings: ProjectSettings | undefined,
  colorIndex: number,
  displayName = '',
  signal?: AbortSignal,
): Promise<{ cue: AudioItem; details: NonNullable<ImportFileResult['details']>; warning?: string }> => {
  const [metadata, serverWaveform] = await Promise.all([
    server.fetchMetadata(serverPath, signal),
    server.fetchWaveformByPath(serverPath),
  ]);
  if (signal?.aborted) throw new Error(t('spotifyImport.cancelled'));

  const fileName = serverPath.split(/[\\/]/).pop() || 'audio';
  const metadataDuration = Number((metadata as any)?.duration_ms);
  const durationMs = Number.isFinite(metadataDuration) && metadataDuration > 0
    ? metadataDuration
    : Number(serverWaveform.duration_ms);
  const duration = durationMs / 1000;
  const waveform = buildWaveformFromChannels(
    serverWaveform.channels,
    duration,
    serverWaveform,
  );
  if ((metadata as any)?.valid !== true || !Number.isFinite(duration) || duration <= 0 || !waveform) {
    throw new Error(t('importAudio.decodeFailed'));
  }

  const artist = typeof (metadata as any)?.artist === 'string'
    ? (metadata as any).artist.trim()
    : '';
  const title = typeof (metadata as any)?.title === 'string'
    ? (metadata as any).title.trim()
    : '';
  const uuid = crypto.randomUUID();
  const cue = {
    ...DEFAULT_AUDIO_ITEM,
    ...transitionDefaultsForImport(settings?.defaultTransitionMode, duration),
    color: colorForNewAudioItem(settings, colorIndex),
    uuid,
    index: [0, colorIndex],
    displayName: displayName.trim() || (artist && title
      ? `${artist} — ${title}`
      : title || fileName.replace(/\.[^/.]+$/, '')),
    type: 'audio',
    mediaFileName: fileName,
    mediaPath: `media/${fileName}`,
    mediaServerPath: serverPath,
    waveformPath: `waveforms/${uuid}.json`,
    waveform,
    outPoint: duration,
    duration,
  } as AudioItem;

  const trimmed = settings?.autoTrimSilenceOnImport === true ? trimSilence(cue) : false;
  const matchLoudness = settings?.autoMatchLoudnessOnImport === true;
  const reduceTruePeaks = settings?.autoReduceTruePeaksOnImport !== false;
  const analysis = trimmed && (matchLoudness || reduceTruePeaks)
    ? await server.fetchWaveformByPath(serverPath, 1000, {
        startMs: cue.inPoint * 1000,
        endMs: cue.outPoint * 1000,
      })
    : serverWaveform;
  if (matchLoudness) {
    applyLoudnessMatch(
      cue,
      analysis,
      outputTargetLevels.value.loudnessTargetLufs,
      outputTargetLevels.value.limiterCeilingDb,
    );
  }
  if (reduceTruePeaks) applyTruePeakCeiling(cue, analysis, -0.1);
  anchorStartNextMarker(cue);

  const sourceTruePeak = Number(serverWaveform.true_peak_dbtp);
  return {
    cue,
    details: {
      fileType: fileName.includes('.') ? fileName.split('.').pop()!.toUpperCase() : t('importAudio.audioFile'),
      duration,
      sampleRate: Number((metadata as any)?.sample_rate) || serverWaveform.sample_rate || 0,
      channels: Number((metadata as any)?.channels) || serverWaveform.source_channels || 0,
      bitrateKbps: Number((metadata as any)?.bitrate_kbps) || 0,
      truePeakDbtp: Number.isFinite(sourceTruePeak) ? sourceTruePeak : null,
    },
    warning: !reduceTruePeaks && Number.isFinite(sourceTruePeak) && sourceTruePeak > -0.1
      ? t('importAudio.truePeakWarning', { peak: sourceTruePeak.toFixed(1) })
      : undefined,
  };
};

const buildSpotifyCueSpecs = async (
  serverPaths: string[],
  settings: ProjectSettings | undefined,
  signal?: AbortSignal,
  baseColorIndex = 0,
): Promise<Array<{ sourcePath: string; cue?: AudioItem; result: ImportFileResult }>> => {
  const entries: Array<{ sourcePath: string; cue?: AudioItem; result: ImportFileResult }> = [];
  for (const [position, serverPath] of serverPaths.entries()) {
    if (signal?.aborted) throw new Error(t('spotifyImport.cancelled'));
    try {
      const verified = await buildVerifiedAudioCue(
        serverPath,
        settings,
        baseColorIndex + position,
        '',
        signal,
      );
      verified.cue.index = [0, entries.filter(entry => entry.cue).length];
      entries.push({
        sourcePath: serverPath,
        cue: verified.cue,
        result: {
          sourcePath: serverPath,
          displayName: verified.cue.displayName,
          status: verified.warning ? 'warning' : 'ready',
          reason: verified.warning,
          details: verified.details,
        },
      });
    } catch (error: any) {
      if (signal?.aborted) throw error;
      entries.push({
        sourcePath: serverPath,
        result: {
          sourcePath: serverPath,
          displayName: serverPath.split(/[\\/]/).pop() || serverPath,
          status: 'failed',
          reason: error?.message || t('spotifyImport.cueImportFailed'),
        },
      });
    }
  }
  return entries;
};

const importSpotifyTemplate = async (
  serverPaths: string[],
  signal: AbortSignal | undefined,
  options: { groupName: string; templateFolderPath: string; existingGroupUuid?: string },
): Promise<ImportBatchResult> => {
  const project = currentProject.value;
  const epoch = projectEpoch.value;
  if (!project || serverPaths.length === 0) {
    return { success: false, imported: 0, error: t('spotifyImport.cueImportFailed'), results: [] };
  }

  const templateName = options.templateFolderPath.split(/[\\/]/).filter(Boolean).pop()
    || options.groupName;
  const templatePath =
    `${options.templateFolderPath.replace(/[\\/]+$/, '')}/${templateName}.liveplay`;
  const settings: ProjectSettings = {
    ...DEFAULT_PROJECT_SETTINGS,
    ...(project.settings?.outputTarget
      ? { outputTarget: project.settings.outputTarget }
      : {}),
    ...(project.settings?.outputTargetLevels
      ? { outputTargetLevels: project.settings.outputTargetLevels }
      : {}),
    ...(project.settings?.meterMode
      ? { meterMode: project.settings.meterMode }
      : {}),
    defaultTransitionMode: project.settings?.defaultTransitionMode,
    autoTrimSilenceOnImport:
      project.settings?.autoTrimSilenceOnImport === true,
    autoMatchLoudnessOnImport:
      project.settings?.autoMatchLoudnessOnImport === true,
    autoReduceTruePeaksOnImport:
      project.settings?.autoReduceTruePeaksOnImport !== false,
    cycleTrackColors:
      project.settings?.cycleTrackColors !== false,
  };
  const existingGroup = options.existingGroupUuid
    ? findItemByUuid(options.existingGroupUuid)
    : null;
  if (options.existingGroupUuid && existingGroup?.type !== 'group') {
    return { success: false, imported: 0, error: t('spotifyImport.cueImportFailed'), results: [] };
  }
  const targetGroup = existingGroup?.type === 'group' ? existingGroup : null;
  let templateCommitted = false;
  let activeGroupUuid = '';
  let createdGroup = false;
  let previousTemplateData = '';
  const activeCueUuids: string[] = [];
  let verificationResults: ImportFileResult[] = [];

  try {
    const verifiedEntries = await buildSpotifyCueSpecs(
      serverPaths,
      settings,
      signal,
      getAllItemsFlat(project.items).filter(item => item.type === 'audio').length,
    );
    verificationResults = verifiedEntries.map(entry => entry.result);
    const cueEntries = verifiedEntries.filter(
      (entry): entry is typeof entry & { cue: AudioItem } => !!entry.cue,
    );
    if (cueEntries.length === 0) throw new Error(t('spotifyImport.cueImportFailed'));
    const cueSpecs = cueEntries.map(entry => entry.cue);
    const templateRead = targetGroup
      ? await window.electronAPI.readFile(templatePath)
      : null;
    previousTemplateData = templateRead?.success ? templateRead.data || '' : '';
    const existingTemplate = templateRead?.success && templateRead.data
      ? JSON.parse(templateRead.data) as Project
      : null;
    const templateGroup = existingTemplate?.items?.[0];
    if (targetGroup && templateGroup?.type !== 'group') {
      throw new Error(templateRead?.error || `Could not update template at ${templatePath}`);
    }
    const templateChildOffset = templateGroup?.type === 'group' ? templateGroup.children.length : 0;
    const persistedCues = cueSpecs.map((cue, position) => {
      const persisted = { ...cue };
      delete persisted.mediaServerPath;
      delete persisted.waveform;
      persisted.index = [0, templateChildOffset + position];
      return persisted;
    });
    const now = new Date().toISOString();
    const templateProject: Project = existingTemplate || {
      name: templateName,
      version: '2.0.0',
      folderPath: options.templateFolderPath,
      items: [{
        ...DEFAULT_GROUP_ITEM,
        uuid: crypto.randomUUID(),
        index: [0],
        displayName: options.groupName,
        type: 'group',
        children: persistedCues,
      } as GroupItem],
      cartItems: [],
      cartSlotKeys: { ...DEFAULT_CART_SLOT_KEYS },
      cartOnlyItems: [],
      theme: { ...DEFAULT_THEME },
      settings,
      createdAt: now,
      lastModified: now,
    };
    if (templateGroup?.type === 'group') {
      templateGroup.children.push(...persistedCues);
      templateProject.lastModified = now;
    }
    const writeResult = await window.electronAPI.writeFile(
      templatePath,
      JSON.stringify(templateProject, null, 2),
    );
    if (!writeResult.success) {
      throw new Error(writeResult.error || `Could not save template to ${templatePath}`);
    }
    templateCommitted = true;

    if (signal?.aborted ||
        currentProject.value !== project ||
        projectEpoch.value !== epoch) {
      throw new Error(t('spotifyImport.cancelled'));
    }

    const rootIndex = targetGroup?.index[0] ?? project.items.length;
    const childOffset = targetGroup?.children.length ?? 0;
    const activeCues: AudioItem[] = [];
    for (const [position, entry] of cueEntries.entries()) {
      const cue = entry.cue;
      const sourcePath = entry.sourcePath;
      const destPath = await server.copyToMedia(sourcePath, signal);
      if (signal?.aborted ||
          currentProject.value !== project ||
          projectEpoch.value !== epoch) {
        throw new Error(t('spotifyImport.cancelled'));
      }
      const fileName = destPath.split(/[\\/]/).pop() || cue.mediaFileName;
      const uuid = crypto.randomUUID();
      activeCueUuids.push(uuid);
      entry.result.itemUuid = uuid;
      activeCues.push({
        ...cue,
        uuid,
        index: [rootIndex, childOffset + position],
        mediaFileName: fileName,
        mediaPath: `media/${fileName}`,
        mediaServerPath: destPath,
        waveformPath: `waveforms/${uuid}.json`,
      });
    }

    if (targetGroup) {
      targetGroup.children.push(...activeCues);
      activeGroupUuid = targetGroup.uuid;
    } else {
      const activeGroup = {
        ...DEFAULT_GROUP_ITEM,
        uuid: crypto.randomUUID(),
        index: [rootIndex],
        displayName: options.groupName,
        type: 'group',
        children: activeCues,
      } as GroupItem;
      activeGroupUuid = activeGroup.uuid;
      createdGroup = true;
      addItem(activeGroup);
    }
    if (signal?.aborted) throw new Error(t('spotifyImport.cancelled'));
    if (!await saveProject({ signal })) throw new Error(t('spotifyImport.cueImportFailed'));
    if (currentProject.value !== project || projectEpoch.value !== epoch) {
      throw new Error(t('spotifyImport.cancelled'));
    }
    return {
      success: !verificationResults.some(result => result.status === 'failed'),
      imported: activeCues.length,
      retainFiles: true,
      groupUuid: activeGroupUuid,
      error: verificationResults.some(result => result.status === 'failed')
        ? t('importAudio.partialFailure')
        : undefined,
      results: verificationResults,
    };
  } catch (error: any) {
    if (activeGroupUuid &&
        currentProject.value === project &&
        projectEpoch.value === epoch) {
      if (createdGroup) removeItem(activeGroupUuid);
      else for (const uuid of activeCueUuids) removeItem(uuid);
    }
    if (targetGroup && templateCommitted && previousTemplateData) {
      const restored = await window.electronAPI.writeFile(templatePath, previousTemplateData);
      if (restored.success) templateCommitted = false;
    }
    const message = error?.message || t('spotifyImport.cueImportFailed');
    return {
      success: false,
      imported: 0,
      error: templateCommitted
        ? `Template saved to ${templatePath}. ${message}`
        : message,
      retainFiles: templateCommitted,
      results: verificationResults.length
        ? verificationResults.map(result => result.status === 'failed'
            ? result
            : { ...result, status: 'failed' as const, reason: message })
        : serverPaths.map(sourcePath => ({
            sourcePath,
            displayName: sourcePath.split(/[\\/]/).pop() || sourcePath,
            status: 'failed' as const,
            reason: message,
          })),
    };
  }
};

const prepareImportFromServerPath = async (
  serverPath: string,
  signal?: AbortSignal,
  colorIndex = 0,
  displayName = '',
  fileMode: 'copy' | 'link' = 'copy',
  duplicatePolicy: 'reuse' | 'skip' | 'keep' = 'reuse',
  resultIndex = 0,
): Promise<{ prepared?: PreparedImport; result: ImportFileResult }> => {
  const fallbackName = displayName.trim() ||
    (serverPath.split(/[\\/]/).pop() || serverPath).replace(/\.[^/.]+$/, '');
  if (!currentProject.value) {
    return {
      result: {
        sourcePath: serverPath,
        displayName: fallbackName,
        status: 'failed',
        reason: t('spotifyImport.cueImportFailed'),
      },
    };
  }
  try {
    if (signal?.aborted) throw new Error(t('spotifyImport.cancelled'));
    const verified = await buildVerifiedAudioCue(
      serverPath,
      currentProject.value.settings,
      colorIndex,
      displayName,
      signal,
    );
    let destPath = serverPath;
    let duplicateReused = false;
    if (fileMode === 'copy') {
      const copied = await server.copyToMediaResult(serverPath, duplicatePolicy, signal);
      if (copied.skipped) {
        return {
          result: {
            sourcePath: serverPath,
            displayName: fallbackName,
            status: 'skipped',
            reason: t('importAudio.duplicateSkipped'),
          },
        };
      }
      destPath = copied.destPath;
      duplicateReused = copied.duplicate && copied.reused;
    }
    const fileName = destPath.split(/[\\/]/).pop() || verified.cue.mediaFileName;
    verified.cue.mediaFileName = fileName;
    verified.cue.mediaServerPath = destPath;
    verified.cue.mediaPath = fileMode === 'link' ? '' : `media/${fileName}`;
    const warnings = [
      fileMode === 'link' ? t('importAudio.linkWarning') : '',
      duplicateReused ? t('importAudio.duplicateReused') : '',
      verified.warning || '',
    ].filter(Boolean);
    const result: ImportFileResult = {
      sourcePath: serverPath,
      displayName: verified.cue.displayName,
      status: warnings.length ? 'warning' : 'ready',
      reason: warnings.join(' '),
      details: verified.details,
    };
    return {
      prepared: {
        mediaServerPath: destPath,
        audioItem: verified.cue,
        resultIndex,
      },
      result,
    };
  } catch (e: any) {
    console.error('Error preparing import from server path:', e);
    return {
      result: {
        sourcePath: serverPath,
        displayName: fallbackName,
        status: 'failed',
        reason: e?.message || t('spotifyImport.cueImportFailed'),
      },
    };
  }
};

const importFromServerPaths = async (
  serverPaths: string[],
  signal?: AbortSignal,
  options?: ImportBatchOptions,
): Promise<ImportBatchResult> => {
  if (options?.groupName && options.templateFolderPath) {
    return importSpotifyTemplate(serverPaths, signal, {
      groupName: options.groupName,
      templateFolderPath: options.templateFolderPath,
      existingGroupUuid: options.existingGroupUuid,
    });
  }

  const project = currentProject.value;
  const epoch = projectEpoch.value;
  if (!project || serverPaths.length === 0) {
    return { success: false, imported: 0, error: t('spotifyImport.cueImportFailed'), results: [] };
  }

  const baseColorIndex = getAllItemsFlat(project.items)
    .filter(item => item.type === 'audio').length;
  const prepared: PreparedImport[] = [];
  const results: ImportFileResult[] = [];
  for (const [offset, serverPath] of serverPaths.entries()) {
    options?.onProgress?.(
      offset + 1,
      serverPaths.length,
      serverPath.split(/[\\/]/).pop() || serverPath,
    );
    if (signal?.aborted ||
        currentProject.value !== project ||
        projectEpoch.value !== epoch) {
      return {
        success: false,
        imported: 0,
        error: t('spotifyImport.cancelled'),
        results,
      };
    }
    const outcome = await prepareImportFromServerPath(
      serverPath,
      signal,
      baseColorIndex + offset,
      options?.displayNames?.[offset],
      options?.fileMode,
      options?.duplicatePolicy,
      results.length,
    );
    results.push(outcome.result);
    if (outcome.prepared) prepared.push(outcome.prepared);
  }
  if (signal?.aborted ||
      currentProject.value !== project ||
      projectEpoch.value !== epoch) {
    return {
      success: false,
      imported: 0,
      error: signal?.aborted
        ? t('spotifyImport.cancelled')
        : t('spotifyImport.cueImportFailed'),
      results,
    };
  }

  if (prepared.length === 0) {
    const failed = results.some(result => result.status === 'failed');
    return {
      success: !failed,
      imported: 0,
      error: failed ? t('spotifyImport.cueImportFailed') : undefined,
      results,
    };
  }

  for (const [offset, entry] of prepared.entries()) {
    entry.audioItem.index = [project.items.length + offset];
    addItem(entry.audioItem);
  }

  if (signal?.aborted) {
    for (const entry of prepared) removeItem(entry.audioItem.uuid);
    return { success: false, imported: 0, error: t('spotifyImport.cancelled'), results };
  }

  const saved = await saveProject({ signal });
  if (!saved) {
    if (currentProject.value === project && projectEpoch.value === epoch) {
      for (const entry of prepared) removeItem(entry.audioItem.uuid);
    }
    return {
      success: false,
      imported: 0,
      error: signal?.aborted
        ? t('spotifyImport.cancelled')
        : t('spotifyImport.cueImportFailed'),
      // The server may have persisted the cues before its acknowledgement was
      // lost. An orphan is recoverable; a saved cue pointing at a deleted file is not.
      retainFiles: true,
      results: results.map(result =>
        result.status === 'ready' || result.status === 'warning'
          ? { ...result, status: 'failed', reason: t('importAudio.saveFailed') }
          : result),
    };
  }

  if (currentProject.value === project && projectEpoch.value === epoch) {
    for (const entry of prepared) {
      results[entry.resultIndex]!.itemUuid = entry.audioItem.uuid;
      requestedWaveformUuids.add(entry.audioItem.uuid);
      server.requestWaveformGeneration(entry.mediaServerPath, entry.audioItem.uuid).catch((e) => {
        requestedWaveformUuids.delete(entry.audioItem.uuid);
        console.warn(`[waveform] generation request failed for ${entry.audioItem.displayName}:`, e);
      });
    }
  }
  const failed = results.some(result => result.status === 'failed');
  return {
    success: !failed,
    imported: prepared.length,
    error: failed ? t('importAudio.partialFailure') : undefined,
    results,
  };
};

const handleAddGroup = () => {
  if (!currentProject.value) return;

  const groupItem: GroupItem = {
    ...DEFAULT_GROUP_ITEM,
    uuid: crypto.randomUUID(),
    index: [currentProject.value.items.length],
    displayName: 'New Group',
    type: 'group',
    children: [] // Create a new array for each group to avoid shared references
  } as GroupItem;

  addItem(groupItem);
};

const handleDrop = async (e: DragEvent) => {
  e.preventDefault();

  // Playlist is read-only in Show Mode — ignore drops (incl. OS file drops).
  if (showMode.value) return;
  if (!e.dataTransfer) return;

  // Cart slot dropped onto empty playlist space → promote it to a standalone
  // playlist item (fresh uuid) appended at the end, and free the cart slot.
  // (Drops landing on an existing row are handled by PlaylistItem.)
  if (e.dataTransfer.getData('cart-slot') && currentProject.value) {
    const cartUuid = e.dataTransfer.getData('item-uuid');
    const { findItemByUuid, deleteCartItems } = useProject();
    const cartSrc = findItemByUuid(cartUuid);
    if (!cartSrc || cartSrc.type !== 'audio') return;
    const clone: AudioItem = {
      ...(cartSrc as AudioItem),
      uuid: crypto.randomUUID(),
      index: [currentProject.value.items.length],
    } as AudioItem;
    addItem(clone);
    deleteCartItems([cartUuid]);
    return;
  }

  const files = Array.from(e.dataTransfer.files);
  if (files.length === 0) return;

  // Files dropped from the OS must be uploaded to (or copied into) the
  // server's media root and registered with the project — the server owns
  // playback and addresses media by its own paths. The old local-copy path
  // (importAudioFile) left the item with no server-resolvable media, so the
  // engine could never create a cue for it ("PLAY: ?" in the server log).
  const serverPaths: string[] = [];
  for (const file of files) {
    const serverPath = await server.resolveDroppedFileToMedia(file);
    if (serverPath) serverPaths.push(serverPath);
  }
  await importFromServerPaths(serverPaths);
};
</script>

<style scoped>
.playlist-view {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: var(--color-background);
}

.playlist-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  min-width: 0;
  margin-left: auto;
  gap: var(--spacing-sm);
  overflow-x: auto;
}

.playlist-header .workspace-panel-header__leading {
  flex: 0 0 auto;
}

.playlist-header,
.playlist-content {
  scrollbar-gutter: stable;
}

.playlist-header {
  overflow-y: auto;
}

.playlist-content {
  flex: 1;
  overflow-y: auto;
  padding: 0 var(--workspace-gutter) var(--workspace-gutter);
}

.empty-state {
  text-align: center;
  padding: 64px var(--spacing-xl);
  color: var(--color-text-secondary);
  
  p {
    margin-bottom: var(--spacing-sm);
  }
  
  .hint {
    font-size: 12px;
    color: var(--color-text-tertiary);
  }
}

.item-list {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: var(--workspace-gutter);
}

.item-list-progress {
  padding: var(--spacing-sm) var(--spacing-md);
  font-size: 12px;
  color: var(--color-text-secondary);
  text-align: center;
  opacity: 0.7;
}
</style>
