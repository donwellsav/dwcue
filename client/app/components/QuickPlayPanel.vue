<template>
  <section class="quickplay-panel" :class="{ 'show-mode': showMode }" :style="{ '--quickplay-font-scale': String(quickPlayFontScale / 100) }" aria-labelledby="quickplay-title">
    <header class="quickplay-header workspace-panel-header" :title="showMode ? undefined : t('quickPlays.hint')">
      <div class="workspace-panel-header__leading">
        <slot name="header-leading" />
        <CueSymbol name="quickplays" class="quickplay-header__symbol" aria-hidden="true" />
        <h2 id="quickplay-title" class="workspace-panel-header__title">{{ t('quickPlays.title') }}</h2>
      </div>
      <div class="quickplay-header__actions">
        <Btn
          v-if="!isDetachedWindow"
          class="quickplay-header__window-control"
          icon="open_in_new"
          :text="t('quickPlays.detach')"
          :title="t('quickPlays.detach')"
          :aria-label="t('quickPlays.detach')"
          :disabled="!currentProject"
          @click="handleDetach"
        />
        <Btn
          v-else
          class="quickplay-header__window-control"
          icon="picture_in_picture_alt"
          :text="t('quickPlays.attach')"
          :title="t('quickPlays.attach')"
          :aria-label="t('quickPlays.attach')"
          @click="handleAttach"
        />
      </div>
    </header>

    <div class="quickplay-grid" :style="quickPlayGridStyle">
      <div
        v-for="(item, index) in quickPlayCells"
        :key="item?.uuid ?? `empty-${index}`"
        class="quickplay-slot"
        :class="{
          'is-empty': !item,
          'is-drag-over': dragOverSlot === index,
          'is-busy': busySlot === index,
        }"
        @dragover="handleDragOver($event, index)"
        @dragleave="handleDragLeave($event, index)"
        @drop="handleDrop($event, index)"
      >
        <QuickPlayTile
          v-if="item"
          :item="item"
          :position="index"
          :hotkey="keyMappings[index]"
          @request-import="openImport(index)"
          @remove="removeQuickPlay(item, index)"
        />
        <button
          v-else-if="!showMode"
          type="button"
          class="quickplay-empty-cell"
          :disabled="!currentProject || busySlot !== null"
          :aria-label="t('quickPlays.importInto', { number: index + 1 })"
          @click="openImport(index)"
        >
          <span class="quickplay-empty-cell__number">{{ index + 1 }}</span>
          <span class="material-symbols-rounded quickplay-empty-cell__icon" aria-hidden="true">add</span>
        </button>
        <div v-else class="quickplay-empty-cell show-mode" aria-hidden="true">
          <span class="quickplay-empty-cell__number">{{ index + 1 }}</span>
        </div>

        <div v-if="busySlot === index" class="quickplay-slot__busy" role="status">
          <span class="material-symbols-rounded is-spinning" aria-hidden="true">progress_activity</span>
          <span>{{ t('quickPlays.importing') }}</span>
        </div>
        <div v-else-if="slotErrors[index]" class="quickplay-slot__error" role="alert">
          <span class="quickplay-slot__error-message">{{ slotErrors[index] }}</span>
          <button
            type="button"
            class="quickplay-slot__error-clear"
            :aria-label="t('quickPlays.clearWarning')"
            :title="t('quickPlays.clearWarning')"
            @click.stop="clearSlotError(index)"
          >
            <span class="material-symbols-rounded" aria-hidden="true">close</span>
          </button>
        </div>
      </div>
    </div>

    <section v-if="isDetachedWindow" v-show="quickPlayEditor || importSlot !== null" class="detached-quickplay-panel">
      <header class="workspace-panel-header">
        <h3 class="workspace-panel-header__title">{{ t(quickPlayEditor?.remove
          ? 'quickPlays.removeConfirmTitle' : quickPlayEditor ? 'quickPlays.settings' : 'quickPlays.importInto', { number: (importSlot ?? 0) + 1 }) }}</h3>
        <div class="detached-quickplay-actions">
          <Btn v-if="quickPlayEditor && !quickPlayEditor.remove" class="detached-quickplay-stop stop-all-btn"
            type="button" icon="stop_circle" :text="t('controls.stopAll')" @click="server.stopAll()" />
          <Btn type="button" icon="close" :text="t('actions.close')" @click="quickPlayEditor = null; closeImport()" />
        </div>
      </header>
      <div id="detached-quickplay-dock"></div>
    </section>
    <Teleport v-if="importSlot !== null && !quickPlayEditor && (isDetachedWindow || workspaceImportPanel === 'quickplay')"
      defer :to="isDetachedWindow ? '#detached-quickplay-dock' : '#workspace-import-host'">
      <p v-if="busySlot === importSlot" class="quickplay-import-feedback" role="status">{{ t('quickPlays.importing') }}</p>
      <p v-else-if="slotErrors[importSlot]" class="quickplay-import-feedback" role="alert">{{ slotErrors[importSlot] }}</p>
      <AudioImportModal :key="importSlot" docked single-file
        :open="true" :visible="busySlot === null"
        :busy="busySlot !== null"
        @pick="handleImportPick"
        @close="closeImport"
      />
    </Teleport>
  </section>
</template>

<script setup lang="ts">
import { useDetachedQuickPlayMutation } from '~/composables/useDetachedQuickPlayMutation';
import type { QuickPlayGridProfile } from '~/composables/useUiMode';
import type { AudioItem } from '~/types/project';
import { sameQuickPlayMutationIdentity } from '~/types/quickPlayMutation';
import { DEFAULT_QUICK_PLAY_AUDIO_ITEM, colorForNewAudioItem } from '~/types/project';
import { buildWaveformFromChannels } from '~/utils/audio';
import {
  buildQuickPlayCells,
  cloneAsIndependentQuickPlay,
  MAX_QUICK_PLAY_SLOTS,
  markAsQuickPlay,
  removeQuickPlayDesignation,
} from '~/utils/quickPlays';
import { QUICK_PLAY_DEFAULT_SLOTS } from '~/composables/useQuickPlayHotkeys';
import AudioImportModal from './AudioImportModal.vue';
import Btn from './Btn.vue';

const props = defineProps<{ isDetachedWindow?: boolean }>();
const {
  currentProject,
  findItemByUuid,
  projectEpoch,
  projectHydrationStatus,
  propertiesPanelOpen,
  quickPlayEditor,
  workspaceImportPanel,
  saveProject,
  selectedItem,
  selectedItems,
  triggerWaveformUpdate,
} = useProject();
const { quickPlayItems, addQuickPlayItem, removeQuickPlayItem } = useQuickPlayItems();
const { uiMode, quickPlayGridLayouts, quickPlayFontScale } = useUiMode();
const { t } = useLocalization();
const { keyMappings, mount: mountHotkeys, unmount: unmountHotkeys } = useQuickPlayHotkeys();
const { mount: mountMidi, unmount: unmountMidi } = useMidiController();
const server = useLiveplayServer();
const { isDetached, identity: detachedIdentity, mutate } = useDetachedQuickPlayMutation();
const canMutate = computed(() => isDetached ? !!detachedIdentity.value : projectHydrationStatus.value === 'ready');

const showMode = computed(() => uiMode.value === 'playback');
const GRID_GAP_PX = 8;
// One layout for the attached panel and one for the detached window. Show
// Mode uses the same one as Edit Mode: it strips the editing, not the size.
// The saved names keep their old spelling so nobody's layout is lost.
const gridProfile = computed<QuickPlayGridProfile>(() => props.isDetachedWindow ? 'detachedRegular' : 'attachedRegular');
const gridLayout = computed(() => quickPlayGridLayouts.value[gridProfile.value]);
const standaloneItems = computed(() => Array.from(quickPlayItems.value.values()));
const quickPlayCells = computed(() => {
  const layout = gridLayout.value;
  const slots = buildQuickPlayCells(
    currentProject.value?.items ?? [],
    standaloneItems.value,
    Math.max(QUICK_PLAY_DEFAULT_SLOTS, layout.rows * layout.columns),
  );
  const roundedLength = Math.min(
    MAX_QUICK_PLAY_SLOTS,
    Math.ceil(slots.length / layout.columns) * layout.columns,
  );
  while (slots.length < roundedLength) slots.push(null);
  // In Show Mode the rows after the last QuickPlay are only empty outlines,
  // so they are left out. Every QuickPlay keeps its place, number and size;
  // only trailing empty rows go.
  if (showMode.value) {
    let lastUsed = slots.length - 1;
    while (lastUsed >= 0 && !slots[lastUsed]) lastUsed -= 1;
    slots.length = Math.ceil((lastUsed + 1) / layout.columns) * layout.columns;
  }
  return slots;
});
const quickPlayGridStyle = computed(() => {
  const layout = gridLayout.value;
  // The layout's rows share the height in both modes, so a tile is the same
  // size whether or not Show Mode has left the empty rows out.
  const rows = layout.rows;
  const rowPercent = 100 / rows;
  const rowGapOffset = GRID_GAP_PX * (rows - 1) / rows;
  // The least a tile needs: the number-and-time line, one title line and
  // the control row. A taller tile shows a second title line and the
  // Playing badge (see QuickPlayTile).
  const contentMinHeight = Math.ceil(68 + 17.25 * quickPlayFontScale.value / 100);
  const minHeight = Math.max(layout.minHeight, contentMinHeight);
  return {
    '--quickplay-columns': String(layout.columns),
    '--quickplay-row-height': `max(${minHeight}px, calc(${rowPercent}% - ${rowGapOffset}px))`,
  };
});

type ImportOptions = {
  fileMode: 'copy' | 'link';
  duplicatePolicy: 'reuse' | 'skip' | 'keep';
};

const importSlot = useState<number | null>('quickPlayImportSlot', () => null);
const busySlot = ref<number | null>(null);
const dragOverSlot = ref<number | null>(null);
const slotErrors = reactive<Record<number, string>>({});
const clearSlotError = (slot: number) => delete slotErrors[slot];
const showProjectSettings = useState('showProjectSettings', () => false);

const openImport = (slot: number) => {
  if (!canMutate.value || showMode.value || !currentProject.value || busySlot.value !== null) return;
  clearSlotError(slot);
  quickPlayEditor.value = null;
  importSlot.value = slot;
  if (!isDetached) {
    showProjectSettings.value = false;
    workspaceImportPanel.value = 'quickplay';
  }
};

const closeImport = () => {
  if (importSlot.value === null) return;
  importSlot.value = null;
  if (!isDetached && !quickPlayEditor.value && workspaceImportPanel.value === 'quickplay')
    workspaceImportPanel.value = null;
};

watch(workspaceImportPanel, panel => {
  if (!isDetached && panel !== 'quickplay') {
    quickPlayEditor.value = null;
    closeImport();
  }
});
watch(showMode, active => {
  if (!active) return;
  if (quickPlayEditor.value?.remove) {
    quickPlayEditor.value = null;
    if (!isDetached && importSlot.value === null) workspaceImportPanel.value = null;
  }
  closeImport();
});
watch(projectEpoch, closeImport);
watch(detachedIdentity, (identity, previous) => {
  if (isDetached && !sameQuickPlayMutationIdentity(identity, previous)) closeImport();
});

const errorMessage = (error: unknown): string => t('quickPlays.importFailed', {
  reason: error instanceof Error && error.message ? error.message : t('quickPlays.unknownImportError'),
});

const captureProjectMutation = () => {
  const project = currentProject.value;
  const epoch = projectEpoch.value;
  const hydration = projectHydrationStatus.value;
  const identity = detachedIdentity.value ? { ...detachedIdentity.value } : null;
  const ownsProject = () => !!currentProject.value && (isDetached
    ? sameQuickPlayMutationIdentity(identity, detachedIdentity.value)
    : currentProject.value === project && projectEpoch.value === epoch);
  return {
    project,
    ownsProject,
    isCurrent: () => ownsProject() && canMutate.value && !showMode.value
      && projectHydrationStatus.value === hydration,
  };
};

const rollbackSelectionForRemovedItem = (uuid: string) => {
  selectedItems.value.delete(uuid);
  if (selectedItem.value?.uuid !== uuid) return;
  selectedItem.value = null;
  propertiesPanelOpen.value = false;
};

const replaceSlotItem = async (
  slot: number,
  replacement: AudioItem,
  isCurrent = captureProjectMutation().isCurrent,
): Promise<boolean> => {
  const { project, ownsProject } = captureProjectMutation();
  if (!project || !isCurrent()) return false;
  const previous = quickPlayCells.value[slot];
  const previousWasStandalone = !!previous && quickPlayItems.value.has(previous.uuid);
  const previousQuickPlay = previous?.quickPlay;

  if (isDetached) {
    const result = await mutate({ kind: 'replace-slot', payload: { slot, item: replacement } });
    if (!ownsProject()) return false;
    if (!result?.accepted) throw new Error(result?.error ?? t('quickPlays.saveFailed'));
    if (previousWasStandalone && previous) removeQuickPlayItem(previous.uuid);
    else if (previous) removeQuickPlayDesignation(previous);
    addQuickPlayItem(replacement);
    if (previousWasStandalone && previous) rollbackSelectionForRemovedItem(previous.uuid);
    return true;
  }

  if (previousWasStandalone && previous) removeQuickPlayItem(previous.uuid);
  else if (previous) removeQuickPlayDesignation(previous);
  addQuickPlayItem(replacement);
  const saved = await saveProject();
  if (!ownsProject()) return false;
  if (saved) {
    if (previousWasStandalone && previous) rollbackSelectionForRemovedItem(previous.uuid);
    return true;
  }

  removeQuickPlayItem(replacement.uuid);
  if (previousWasStandalone && previous) addQuickPlayItem(previous);
  else if (previous && previousQuickPlay) previous.quickPlay = previousQuickPlay;
  project.quickPlayItems = Array.from(quickPlayItems.value.values());
  throw new Error(t('quickPlays.saveFailed'));
};

const importFromServerPath = async (
  serverPath: string,
  slot: number,
  options: ImportOptions,
): Promise<boolean> => {
  const { project, isCurrent, ownsProject } = captureProjectMutation();
  if (!project || !isCurrent() || busySlot.value !== null) return false;
  busySlot.value = slot;
  clearSlotError(slot);
  try {
    let mediaServerPath = serverPath;
    if (options.fileMode === 'copy') {
      const copy = await server.copyToMediaResult(serverPath, options.duplicatePolicy);
      if (!isCurrent()) return false;
      if (copy.skipped) throw new Error(t('importAudio.duplicateSkipped'));
      mediaServerPath = copy.destPath;
    }

    const [metadata, serverWaveform] = await Promise.all([
      server.fetchMetadata(mediaServerPath),
      server.fetchWaveformByPath(mediaServerPath),
    ]);
    if (!isCurrent()) return false;
    const metadataDuration = Number((metadata as any)?.duration_ms);
    const durationMs = Number.isFinite(metadataDuration) && metadataDuration > 0
      ? metadataDuration
      : Number(serverWaveform.duration_ms);
    const duration = durationMs / 1000;
    const waveform = buildWaveformFromChannels(serverWaveform.channels, duration, serverWaveform);
    if ((metadata as any)?.valid !== true || !Number.isFinite(duration) || duration <= 0 || !waveform) {
      throw new Error(t('importAudio.decodeFailed'));
    }

    const fileName = mediaServerPath.split(/[\\/]/).pop() || 'audio';
    const artist = typeof (metadata as any)?.artist === 'string' ? (metadata as any).artist.trim() : '';
    const title = typeof (metadata as any)?.title === 'string' ? (metadata as any).title.trim() : '';
    const uuid = crypto.randomUUID();
    const item = {
      ...DEFAULT_QUICK_PLAY_AUDIO_ITEM,
      uuid,
      index: [-1, slot],
      type: 'audio',
      color: colorForNewAudioItem(project.settings, slot),
      displayName: artist && title
        ? `${artist} — ${title}`
        : title || fileName.replace(/\.[^/.]+$/, ''),
      mediaFileName: fileName,
      mediaPath: options.fileMode === 'link' ? '' : `media/${fileName}`,
      mediaServerPath,
      waveformPath: `waveforms/${uuid}.json`,
      waveform,
      duration,
      outPoint: duration,
      ...(metadata as any)?.has_video === true ? { hasVideo: true as const } : {},
    } as AudioItem;
    markAsQuickPlay(item, slot);
    if (!await replaceSlotItem(slot, item, isCurrent) || !isCurrent()) return false;
    triggerWaveformUpdate();
    return true;
  } catch (error) {
    if (!ownsProject()) return false;
    console.error('[quickplay import] failed:', error);
    slotErrors[slot] = errorMessage(error);
    return false;
  } finally {
    busySlot.value = null;
  }
};

const handleImportPick = async (paths: string[], options: ImportOptions) => {
  const slot = importSlot.value;
  const first = paths[0];
  if (slot === null || !first) return;
  if (await importFromServerPath(first, slot, options)) closeImport();
};

const copyPlaylistItemIntoSlot = async (uuid: string, slot: number) => {
  const { isCurrent, ownsProject } = captureProjectMutation();
  if (!isCurrent()) return;
  const source = findItemByUuid(uuid);
  if (!source || source.type !== 'audio' || !currentProject.value) return;
  const clone = cloneAsIndependentQuickPlay(source, crypto.randomUUID(), slot);
  clearSlotError(slot);
  try {
    await replaceSlotItem(slot, clone, isCurrent);
  } catch (error) {
    if (ownsProject()) slotErrors[slot] = errorMessage(error);
  }
};

const moveQuickPlayToSlot = async (uuid: string, sourceSlot: number, targetSlot: number) => {
  if (sourceSlot === targetSlot) return;
  const source = findItemByUuid(uuid);
  if (!source || source.type !== 'audio' || !source.quickPlay) return;
  const target = quickPlayCells.value[targetSlot];
  if (isDetached) {
    const result = await mutate({ kind: 'move-slot', itemUuid: uuid, payload: { sourceSlot, targetSlot } });
    if (!result?.accepted) {
      slotErrors[targetSlot] = result?.error ?? t('quickPlays.moveFailed');
      return;
    }
    source.quickPlay.order = targetSlot;
    if (target?.quickPlay) target.quickPlay.order = sourceSlot;
    return;
  }
  const sourceOrder = source.quickPlay.order;
  const targetOrder = target?.quickPlay?.order;
  source.quickPlay.order = targetSlot;
  if (target?.quickPlay) target.quickPlay.order = sourceSlot;
  if (await saveProject()) return;
  source.quickPlay.order = sourceOrder;
  if (target?.quickPlay && targetOrder !== undefined) target.quickPlay.order = targetOrder;
  slotErrors[targetSlot] = t('quickPlays.moveFailed');
};

const handleDragOver = (event: DragEvent, slot: number) => {
  if (!canMutate.value || showMode.value || !currentProject.value || busySlot.value !== null) return;
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes('quickplay-uuid') ? 'move' : 'copy';
  }
  dragOverSlot.value = slot;
};

const handleDragLeave = (event: DragEvent, slot: number) => {
  const related = event.relatedTarget as Node | null;
  if (related && (event.currentTarget as HTMLElement).contains(related)) return;
  if (dragOverSlot.value === slot) dragOverSlot.value = null;
};

const handleDrop = async (event: DragEvent, slot: number) => {
  if (!canMutate.value || showMode.value || !currentProject.value || busySlot.value !== null) return;
  event.preventDefault();
  event.stopPropagation();
  dragOverSlot.value = null;

  const quickPlayUuid = event.dataTransfer?.getData('quickplay-uuid');
  const sourceSlot = Number(event.dataTransfer?.getData('quickplay-slot'));
  if (quickPlayUuid && Number.isInteger(sourceSlot)) {
    await moveQuickPlayToSlot(quickPlayUuid, sourceSlot, slot);
    return;
  }

  const file = event.dataTransfer?.files?.[0];
  if (file) {
    const { isCurrent } = captureProjectMutation();
    busySlot.value = slot;
    clearSlotError(slot);
    let path: string | null = null;
    try {
      path = await server.resolveDroppedFileToMedia(file);
    } catch (error) {
      console.error('[quickplay drop] failed:', error);
    } finally {
      busySlot.value = null;
    }
    if (!isCurrent()) return;
    if (path) await importFromServerPath(path, slot, { fileMode: 'copy', duplicatePolicy: 'reuse' });
    else slotErrors[slot] = t('quickPlays.dropFailed');
    return;
  }

  const playlistUuid = event.dataTransfer?.getData('playlist-audio-uuid')
    || event.dataTransfer?.getData('item-uuid');
  if (playlistUuid) await copyPlaylistItemIntoSlot(playlistUuid, slot);
};

const removeQuickPlay = async (item: AudioItem, slot: number) => {
  const standalone = quickPlayItems.value.has(item.uuid);
  const previousQuickPlay = item.quickPlay ? structuredClone(item.quickPlay) : undefined;
  if (isDetached) {
    const result = await mutate({ kind: 'remove-slot', itemUuid: item.uuid, payload: {} });
    if (!result?.accepted) {
      slotErrors[slot] = result?.error ?? t('quickPlays.removeFailed');
      return;
    }
    if (standalone) {
      removeQuickPlayItem(item.uuid);
      rollbackSelectionForRemovedItem(item.uuid);
    } else removeQuickPlayDesignation(item);
    return;
  }
  if (standalone) removeQuickPlayItem(item.uuid);
  else removeQuickPlayDesignation(item);
  if (await saveProject()) {
    if (standalone) rollbackSelectionForRemovedItem(item.uuid);
    return;
  }
  if (standalone) addQuickPlayItem(item);
  else if (previousQuickPlay) item.quickPlay = previousQuickPlay;
  slotErrors[slot] = t('quickPlays.removeFailed');
};

const handleDetach = () => {
  if (!currentProject.value || !import.meta.client || !window.electronAPI) return;
  window.electronAPI.openDetachedQuickPlayWindow(currentProject.value.folderPath);
};

const handleAttach = () => {
  if (!import.meta.client || !window.electronAPI) return;
  window.electronAPI.attachDetachedQuickPlayWindow();
};

onMounted(() => {
  if (props.isDetachedWindow) mountHotkeys();
  mountMidi();
});

onUnmounted(() => {
  importSlot.value = null;
  if (!isDetached && workspaceImportPanel.value === 'quickplay') workspaceImportPanel.value = null;
  unmountHotkeys();
  unmountMidi();
});
</script>

<style scoped>
.quickplay-panel {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  container-type: inline-size;
  background: var(--color-background);
}

.quickplay-header__symbol {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  color: var(--color-text-primary);
}

.detached-quickplay-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: 60%;
  border-top: 1px solid var(--color-border);
}

.detached-quickplay-actions {
  display: flex;
  gap: var(--spacing-xs);
}

#detached-quickplay-dock {
  overflow: auto;
}

.quickplay-import-feedback {
  margin: 0;
  padding: var(--spacing-sm) var(--workspace-gutter);
  overflow-wrap: anywhere;
}
.quickplay-import-feedback[role='alert'] { color: var(--color-danger); }

.quickplay-header__actions {
  margin-inline-start: auto;
  flex: 0 0 auto;
}

.quickplay-grid {
  min-height: 0;
  flex: 1;
  display: grid;
  grid-template-columns: repeat(var(--quickplay-columns, 2), minmax(128px, 1fr));
  grid-auto-rows: var(--quickplay-row-height, 106px);
  align-content: start;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm);
  overflow-x: auto;
  overflow-y: auto;
  border-top: 1px solid var(--color-border);
  background: var(--color-background);
  scrollbar-gutter: stable;
}

@container (max-width: 280px) {
  .quickplay-header__symbol { display: none; }
}

@container (max-width: 270px) {
  .quickplay-grid { grid-template-columns: minmax(0, 1fr); }
}

@container (max-width: 200px) {
  .quickplay-header__window-control {
    justify-content: center;
    width: var(--panel-control-height);
    padding: 0;
  }

  .quickplay-header__window-control :deep(.btn__text) { display: none; }
}

.quickplay-slot {
  position: relative;
  min-width: 0;
  min-height: var(--quickplay-row-height, 106px);
  isolation: isolate;
  overflow: hidden;
  border-radius: var(--border-radius-sm);
}

.quickplay-slot > :deep(.quickplay-tile) {
  width: 100%;
  max-width: 100%;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
}
.quickplay-slot.is-drag-over {
  outline: 2px solid var(--color-focus, var(--color-accent));
  outline-offset: 2px;
}

.quickplay-empty-cell {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: inherit;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 5px;
  padding: var(--spacing-md);
  border: 1px dashed var(--color-border-strong);
  border-radius: inherit;
  background: color-mix(in srgb, var(--color-surface) 72%, transparent);
  color: var(--color-text-secondary);
  text-align: center;
}

button.quickplay-empty-cell {
  cursor: pointer;
}

button.quickplay-empty-cell .quickplay-empty-cell__icon { color: var(--color-accent-text); }

button.quickplay-empty-cell:hover,
button.quickplay-empty-cell:focus-visible {
  border-color: color-mix(in srgb, var(--color-accent) 72%, var(--color-border-strong));
  background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface));
  color: var(--color-text-primary);
  outline: none;
}

.quickplay-empty-cell:disabled {
  cursor: default;
  opacity: .55;
}

.quickplay-empty-cell.show-mode {
  border-style: solid;
  border-color: color-mix(in srgb, var(--color-border) 72%, transparent);
  background: color-mix(in srgb, var(--color-surface) 42%, transparent);
  opacity: .48;
}

.quickplay-empty-cell__number {
  position: absolute;
  top: 8px;
  left: 10px;
  color: var(--color-text-tertiary);
  font: 600 11px/1 var(--font-mono, ui-monospace, monospace);
  font-variant-numeric: tabular-nums;
}

.quickplay-empty-cell__icon {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--control-radius);
  background: var(--color-surface-raised);
  color: var(--color-text-primary);
  font-size: 19px;
  font-variation-settings: 'FILL' 0, 'wght' 520, 'GRAD' 0, 'opsz' 20;
}

button.quickplay-empty-cell:hover .quickplay-empty-cell__icon,
button.quickplay-empty-cell:focus-visible .quickplay-empty-cell__icon {
  border-color: color-mix(in srgb, var(--color-accent) 56%, var(--color-border-strong));
  background: color-mix(in srgb, var(--color-accent) 12%, var(--color-surface-raised));
}

.quickplay-slot__busy,
.quickplay-slot__error {
  position: absolute;
  z-index: 5;
  right: 7px;
  bottom: 7px;
  left: 7px;
  margin: 0;
  padding: 6px 8px;
  border: 1px solid var(--color-border-strong);
  border-radius: 6px;
  background: color-mix(in srgb, var(--color-background) 92%, transparent);
  box-shadow: 0 4px 12px rgb(0 0 0 / 28%);
  font-size: 11px;
  line-height: 1.3;
}

.quickplay-slot__busy {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--color-text-secondary);
}

.quickplay-slot__error {
  min-height: 32px;
  max-height: 4.6em;
  padding-right: 30px;
  overflow: hidden;
  border-color: color-mix(in srgb, var(--color-danger) 48%, var(--color-border));
  color: var(--color-danger);
  user-select: text;
}

.quickplay-slot__error-message {
  display: -webkit-box;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.quickplay-slot__error-clear {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm, 5px);
  background: transparent;
  color: currentColor;
  cursor: pointer;
}

.quickplay-slot__error-clear:hover {
  background: color-mix(in srgb, var(--color-danger) 16%, transparent);
}

.quickplay-slot__error-clear:focus-visible {
  outline: 2px solid var(--color-focus, var(--color-accent));
  outline-offset: 1px;
}

.quickplay-slot__error-clear .material-symbols-rounded {
  font-size: 18px;
}

.is-spinning { animation: quickplay-spin .8s linear infinite; }

@keyframes quickplay-spin { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .is-spinning { animation: none; }
}
</style>
