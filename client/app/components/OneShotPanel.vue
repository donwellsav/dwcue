<template>
  <section class="one-shot-panel" :class="{ 'show-mode': showMode }" :style="{ '--one-shot-font-scale': String(oneShotFontScale / 100) }" aria-labelledby="one-shot-title">
    <header class="one-shot-header workspace-panel-header">
      <div class="workspace-panel-header__leading">
        <slot name="header-leading" />
        <CueSymbol name="one-shots" class="one-shot-header__symbol" aria-hidden="true" />
        <div class="one-shot-header__copy">
          <h2 id="one-shot-title" class="workspace-panel-header__title">{{ t('oneShots.title') }}</h2>
          <span v-if="!showMode" class="one-shot-header__hint">{{ t('oneShots.hint') }}</span>
        </div>
      </div>
      <div class="one-shot-header__actions">
        <Btn
          v-if="!isDetachedWindow"
          icon="open_in_new"
          :text="t('oneShots.detach')"
          :disabled="!currentProject"
          @click="handleDetach"
        />
        <Btn
          v-else
          icon="picture_in_picture_alt"
          :text="t('oneShots.attach')"
          @click="handleAttach"
        />
      </div>
    </header>

    <div class="one-shot-grid" :style="oneShotGridStyle">
      <div
        v-for="(item, index) in oneShotSlots"
        :key="item?.uuid ?? `empty-${index}`"
        class="one-shot-slot"
        :class="{
          'is-empty': !item,
          'is-drag-over': dragOverSlot === index,
          'is-busy': busySlot === index,
        }"
        @dragover="handleDragOver($event, index)"
        @dragleave="handleDragLeave($event, index)"
        @drop="handleDrop($event, index)"
      >
        <OneShotTile
          v-if="item"
          :item="item"
          :position="index"
          @request-import="openImport(index)"
          @remove="removeOneShot(item, index)"
        />
        <button
          v-else-if="!showMode"
          type="button"
          class="one-shot-empty-cell"
          :disabled="!currentProject || busySlot !== null"
          :aria-label="t('oneShots.importInto', { number: index + 1 })"
          @click="openImport(index)"
        >
          <span class="one-shot-empty-cell__number">{{ index + 1 }}</span>
          <span class="material-symbols-rounded one-shot-empty-cell__icon" aria-hidden="true">add</span>
          <strong>{{ t('oneShots.import') }}</strong>
          <span>{{ t('oneShots.dropHint') }}</span>
        </button>
        <div v-else class="one-shot-empty-cell show-mode" aria-hidden="true">
          <span class="one-shot-empty-cell__number">{{ index + 1 }}</span>
          <span class="material-symbols-rounded one-shot-empty-cell__icon">bolt</span>
        </div>

        <div v-if="busySlot === index" class="one-shot-slot__busy" role="status">
          <span class="material-symbols-rounded is-spinning" aria-hidden="true">progress_activity</span>
          <span>{{ t('oneShots.importing') }}</span>
        </div>
        <div v-else-if="slotErrors[index]" class="one-shot-slot__error" role="alert">
          <span class="one-shot-slot__error-message">{{ slotErrors[index] }}</span>
          <button
            type="button"
            class="one-shot-slot__error-clear"
            :aria-label="t('oneShots.clearWarning')"
            :title="t('oneShots.clearWarning')"
            @click.stop="clearSlotError(index)"
          >
            <span class="material-symbols-rounded" aria-hidden="true">close</span>
          </button>
        </div>
      </div>
    </div>

    <AudioImportModal
      :open="importSlot !== null"
      :busy="busySlot !== null"
      @pick="handleImportPick"
      @close="closeImport"
    />
  </section>
</template>

<script setup lang="ts">
import type { CartGridProfile } from '~/composables/useUiMode';
import type { AudioItem } from '~/types/project';
import { DEFAULT_CART_AUDIO_ITEM, colorForNewAudioItem } from '~/types/project';
import { buildWaveformFromChannels } from '~/utils/audio';
import {
  buildOneShotSlots,
  cloneAsIndependentOneShot,
  MAX_ONE_SHOT_SLOTS,
  markAsOneShot,
  removeOneShotDesignation,
} from '~/utils/oneShots';
import AudioImportModal from './AudioImportModal.vue';
import Btn from './Btn.vue';

const props = defineProps<{ isDetachedWindow?: boolean }>();
const {
  currentProject,
  findItemByUuid,
  markPendingImportProcessing,
  propertiesPanelOpen,
  saveProject,
  selectedItem,
  selectedItems,
} = useProject();
const { cartOnlyItems, addCartOnlyItem, removeCartOnlyItem } = useCartItems();
const { uiMode, cartGridLayouts, oneShotFontScale } = useUiMode();
const { t } = useLocalization();
const { mount: mountHotkeys, unmount: unmountHotkeys } = useCartHotkeys();
const { mount: mountMidi, unmount: unmountMidi } = useMidiController();
const server = useLiveplayServer();

const showMode = computed(() => uiMode.value === 'playback');
const GRID_GAP_PX = 8;
const gridProfile = computed<CartGridProfile>(() => {
  if (props.isDetachedWindow) return showMode.value ? 'detachedShow' : 'detachedRegular';
  return showMode.value ? 'attachedShow' : 'attachedRegular';
});
const gridLayout = computed(() => cartGridLayouts.value[gridProfile.value]);
const standaloneItems = computed(() => Array.from(cartOnlyItems.value.values()));
const oneShotSlots = computed(() => {
  const layout = gridLayout.value;
  const slots = buildOneShotSlots(
    currentProject.value?.items ?? [],
    standaloneItems.value,
    layout.rows * layout.columns,
  );
  const roundedLength = Math.min(
    MAX_ONE_SHOT_SLOTS,
    Math.ceil(slots.length / layout.columns) * layout.columns,
  );
  while (slots.length < roundedLength) slots.push(null);
  return slots;
});
const oneShotGridStyle = computed(() => {
  const layout = gridLayout.value;
  const rowPercent = 100 / layout.rows;
  const rowGapOffset = GRID_GAP_PX * (layout.rows - 1) / layout.rows;
  // Reserve metadata, two scaled title lines, and the transport footer even
  // when the configured minimum is smaller than the controls can contain.
  const contentMinHeight = Math.ceil(104 + 35 * oneShotFontScale.value / 100);
  const minHeight = Math.max(layout.minHeight, contentMinHeight);
  return {
    '--one-shot-columns': String(layout.columns),
    '--one-shot-row-height': `max(${minHeight}px, calc(${rowPercent}% - ${rowGapOffset}px))`,
  };
});

type ImportOptions = {
  fileMode: 'copy' | 'link';
  duplicatePolicy: 'reuse' | 'skip' | 'keep';
};

const importSlot = ref<number | null>(null);
const busySlot = ref<number | null>(null);
const dragOverSlot = ref<number | null>(null);
const slotErrors = reactive<Record<number, string>>({});
const clearSlotError = (slot: number) => delete slotErrors[slot];

const openImport = (slot: number) => {
  if (showMode.value || !currentProject.value || busySlot.value !== null) return;
  clearSlotError(slot);
  importSlot.value = slot;
};

const closeImport = () => {
  if (busySlot.value === null) importSlot.value = null;
};

const errorMessage = (error: unknown): string => t('oneShots.importFailed', {
  reason: error instanceof Error && error.message ? error.message : t('oneShots.unknownImportError'),
});

const rollbackSelectionForRemovedItem = (uuid: string) => {
  selectedItems.value.delete(uuid);
  if (selectedItem.value?.uuid !== uuid) return;
  selectedItem.value = null;
  propertiesPanelOpen.value = false;
};

const replaceSlotItem = async (slot: number, replacement: AudioItem): Promise<void> => {
  if (!currentProject.value) throw new Error(t('oneShots.noProject'));
  const previous = oneShotSlots.value[slot];
  const previousWasStandalone = !!previous && cartOnlyItems.value.has(previous.uuid);
  const previousOneShot = previous?.oneShot ? structuredClone(previous.oneShot) : undefined;

  if (previousWasStandalone && previous) removeCartOnlyItem(previous.uuid);
  else if (previous) removeOneShotDesignation(previous);
  addCartOnlyItem(replacement);

  if (await saveProject()) {
    if (previousWasStandalone && previous) rollbackSelectionForRemovedItem(previous.uuid);
    return;
  }

  removeCartOnlyItem(replacement.uuid);
  if (previousWasStandalone && previous) addCartOnlyItem(previous);
  else if (previous && previousOneShot) previous.oneShot = previousOneShot;
  currentProject.value.cartOnlyItems = Array.from(cartOnlyItems.value.values());
  throw new Error(t('oneShots.saveFailed'));
};

const importFromServerPath = async (
  serverPath: string,
  slot: number,
  options: ImportOptions,
): Promise<boolean> => {
  if (!currentProject.value || busySlot.value !== null) return false;
  busySlot.value = slot;
  clearSlotError(slot);
  try {
    let mediaServerPath = serverPath;
    if (options.fileMode === 'copy') {
      const copy = await server.copyToMediaResult(serverPath, options.duplicatePolicy);
      if (copy.skipped) throw new Error(t('importAudio.duplicateSkipped'));
      mediaServerPath = copy.destPath;
    }

    const [metadata, serverWaveform] = await Promise.all([
      server.fetchMetadata(mediaServerPath),
      server.fetchWaveformByPath(mediaServerPath),
    ]);
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
      ...DEFAULT_CART_AUDIO_ITEM,
      uuid,
      index: [-1, slot],
      type: 'audio',
      color: colorForNewAudioItem(currentProject.value.settings, slot),
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
    markAsOneShot(item, slot);
    await replaceSlotItem(slot, item);
    markPendingImportProcessing(uuid);
    void server.requestWaveformGeneration(mediaServerPath, uuid).catch((error) => {
      console.warn(`[one-shot waveform] generation failed for ${item.displayName}:`, error);
    });
    return true;
  } catch (error) {
    console.error('[one-shot import] failed:', error);
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
  if (await importFromServerPath(first, slot, options)) importSlot.value = null;
};

const copyPlaylistItemIntoSlot = async (uuid: string, slot: number) => {
  const source = findItemByUuid(uuid);
  if (!source || source.type !== 'audio' || !currentProject.value) return;
  const clone = cloneAsIndependentOneShot(source, crypto.randomUUID(), slot);
  clearSlotError(slot);
  try {
    await replaceSlotItem(slot, clone);
  } catch (error) {
    slotErrors[slot] = errorMessage(error);
  }
};

const moveOneShotToSlot = async (uuid: string, sourceSlot: number, targetSlot: number) => {
  if (sourceSlot === targetSlot) return;
  const source = findItemByUuid(uuid);
  if (!source || source.type !== 'audio' || !source.oneShot) return;
  const target = oneShotSlots.value[targetSlot];
  const sourceOrder = source.oneShot.order;
  const targetOrder = target?.oneShot?.order;
  source.oneShot.order = targetSlot;
  if (target?.oneShot) target.oneShot.order = sourceSlot;
  if (await saveProject()) return;
  source.oneShot.order = sourceOrder;
  if (target?.oneShot && targetOrder !== undefined) target.oneShot.order = targetOrder;
  slotErrors[targetSlot] = t('oneShots.moveFailed');
};

const handleDragOver = (event: DragEvent, slot: number) => {
  if (showMode.value || !currentProject.value || busySlot.value !== null) return;
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes('one-shot-uuid') ? 'move' : 'copy';
  }
  dragOverSlot.value = slot;
};

const handleDragLeave = (event: DragEvent, slot: number) => {
  const related = event.relatedTarget as Node | null;
  if (related && (event.currentTarget as HTMLElement).contains(related)) return;
  if (dragOverSlot.value === slot) dragOverSlot.value = null;
};

const handleDrop = async (event: DragEvent, slot: number) => {
  if (showMode.value || !currentProject.value || busySlot.value !== null) return;
  event.preventDefault();
  event.stopPropagation();
  dragOverSlot.value = null;

  const oneShotUuid = event.dataTransfer?.getData('one-shot-uuid');
  const sourceSlot = Number(event.dataTransfer?.getData('one-shot-slot'));
  if (oneShotUuid && Number.isInteger(sourceSlot)) {
    await moveOneShotToSlot(oneShotUuid, sourceSlot, slot);
    return;
  }

  const file = event.dataTransfer?.files?.[0];
  if (file) {
    busySlot.value = slot;
    clearSlotError(slot);
    let path: string | null = null;
    try {
      path = await server.resolveDroppedFileToMedia(file);
    } catch (error) {
      console.error('[one-shot drop] failed:', error);
    } finally {
      busySlot.value = null;
    }
    if (path) await importFromServerPath(path, slot, { fileMode: 'copy', duplicatePolicy: 'reuse' });
    else slotErrors[slot] = t('oneShots.dropFailed');
    return;
  }

  const playlistUuid = event.dataTransfer?.getData('playlist-audio-uuid')
    || event.dataTransfer?.getData('item-uuid');
  if (playlistUuid) await copyPlaylistItemIntoSlot(playlistUuid, slot);
};

const removeOneShot = async (item: AudioItem, slot: number) => {
  const standalone = cartOnlyItems.value.has(item.uuid);
  const previousOneShot = item.oneShot ? structuredClone(item.oneShot) : undefined;
  if (standalone) removeCartOnlyItem(item.uuid);
  else removeOneShotDesignation(item);
  if (await saveProject()) {
    if (standalone) rollbackSelectionForRemovedItem(item.uuid);
    return;
  }
  if (standalone) addCartOnlyItem(item);
  else if (previousOneShot) item.oneShot = previousOneShot;
  slotErrors[slot] = t('oneShots.removeFailed');
};

const handleDetach = () => {
  if (!currentProject.value || !import.meta.client || !window.electronAPI) return;
  window.electronAPI.openCartPlayerWindow(currentProject.value.folderPath);
};

const handleAttach = () => {
  if (!import.meta.client || !window.electronAPI) return;
  window.electronAPI.attachCartPlayerWindow();
};

onMounted(() => {
  mountHotkeys();
  mountMidi();
});

onUnmounted(() => {
  unmountHotkeys();
  unmountMidi();
});
</script>

<style scoped>
.one-shot-panel {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-background);
}

.one-shot-header__symbol {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  color: var(--color-text-primary);
}

.one-shot-header__copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.one-shot-header__hint {
  overflow: hidden;
  color: var(--color-text-tertiary);
  font-size: var(--type-status-size);
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.one-shot-header__actions {
  margin-left: auto;
  flex: 0 0 auto;
}

.one-shot-grid {
  min-height: 0;
  flex: 1;
  display: grid;
  grid-template-columns: repeat(var(--one-shot-columns, 2), minmax(128px, 1fr));
  grid-auto-rows: var(--one-shot-row-height, 106px);
  align-content: start;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm);
  overflow-x: auto;
  overflow-y: auto;
  border-top: 1px solid var(--color-border);
  background: var(--color-background);
  scrollbar-gutter: stable;
}

.one-shot-slot {
  position: relative;
  min-width: 0;
  min-height: var(--one-shot-row-height, 106px);
  isolation: isolate;
  overflow: hidden;
  border-radius: var(--border-radius-sm);
  container-type: inline-size;
}

.one-shot-slot > :deep(.one-shot-tile) {
  width: 100%;
  max-width: 100%;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
}
.one-shot-slot.is-drag-over {
  outline: 2px solid var(--color-focus, var(--color-accent));
  outline-offset: 2px;
}

.one-shot-empty-cell {
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

button.one-shot-empty-cell {
  cursor: pointer;
}

button.one-shot-empty-cell:hover,
button.one-shot-empty-cell:focus-visible {
  border-color: color-mix(in srgb, var(--color-accent) 72%, var(--color-border-strong));
  background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface));
  color: var(--color-text-primary);
  outline: none;
}

.one-shot-empty-cell:disabled {
  cursor: default;
  opacity: .55;
}

.one-shot-empty-cell.show-mode {
  border-style: solid;
  border-color: color-mix(in srgb, var(--color-border) 72%, transparent);
  background: color-mix(in srgb, var(--color-surface) 42%, transparent);
  opacity: .48;
}

.one-shot-empty-cell__number {
  position: absolute;
  top: 8px;
  left: 10px;
  color: var(--color-text-tertiary);
  font: 600 11px/1 var(--font-mono, ui-monospace, monospace);
  font-variant-numeric: tabular-nums;
}

.one-shot-empty-cell__icon {
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

button.one-shot-empty-cell:hover .one-shot-empty-cell__icon,
button.one-shot-empty-cell:focus-visible .one-shot-empty-cell__icon {
  border-color: color-mix(in srgb, var(--color-accent) 56%, var(--color-border-strong));
  background: color-mix(in srgb, var(--color-accent) 12%, var(--color-surface-raised));
}

.one-shot-empty-cell strong {
  color: var(--color-text-primary);
  font-size: 13px;
}

.one-shot-empty-cell > span:last-child:not(.one-shot-empty-cell__icon) {
  color: var(--color-text-tertiary);
  font-size: 11px;
}

.one-shot-slot__busy,
.one-shot-slot__error {
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

.one-shot-slot__busy {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--color-text-secondary);
}

.one-shot-slot__error {
  min-height: 32px;
  max-height: 4.6em;
  padding-right: 30px;
  overflow: hidden;
  border-color: color-mix(in srgb, var(--color-danger) 48%, var(--color-border));
  color: var(--color-danger);
  user-select: text;
}

.one-shot-slot__error-message {
  display: -webkit-box;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.one-shot-slot__error-clear {
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

.one-shot-slot__error-clear:hover {
  background: color-mix(in srgb, var(--color-danger) 16%, transparent);
}

.one-shot-slot__error-clear:focus-visible {
  outline: 2px solid var(--color-focus, var(--color-accent));
  outline-offset: 1px;
}

.one-shot-slot__error-clear .material-symbols-rounded {
  font-size: 18px;
}

.is-spinning { animation: one-shot-spin .8s linear infinite; }

@keyframes one-shot-spin { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .is-spinning { animation: none; }
}
</style>
