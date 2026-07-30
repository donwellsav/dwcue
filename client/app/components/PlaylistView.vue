<template>
  <div class="playlist-view">
    <div class="playlist-header">
      <h2>{{ t('playlist.title') }}</h2>
      <!-- Import / add-group are edit actions — hidden in Show Mode. -->
      <div v-if="!showMode" class="playlist-actions">
        <Btn icon="audio_file" :text="t('playlist.importAudio')" :disabled="!currentProject" @click="handleImport" />
        <Btn v-if="canOnlineImport" icon="youtube_activity" :text="t('youtube.importFromYouTube')" bg-style="youtube" @click="showYouTubeModal = true" />
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
    <YouTubeImportModal :isOpen="showYouTubeModal" @close="showYouTubeModal = false" />

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
                      @pick="onImportPick"
                      @close="showImportModal = false" />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import YouTubeImportModal from './YouTubeImportModal.vue';
import AudioImportModal from './AudioImportModal.vue';
import SpotifyImportModal from './SpotifyImportModal.vue';
import Btn from './Btn.vue';
import type { AudioItem, GroupItem } from '~/types/project';
import { DEFAULT_AUDIO_ITEM, DEFAULT_GROUP_ITEM, transitionDefaultsForImport } from '~/types/project';
import { useLiveplayServer } from '~/composables/useLiveplayServer';

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
const { activeCues, nextItemOverrideUuid } = useAudioEngine();
const { uiMode } = useUiMode();
const { revealSelection, commitReveal, clearReveals } = usePlaylistReveal();
const server = useLiveplayServer();
// Same useState key useProject/useShowControl bind to — watching the uuid (not
// the `selectedItem` computed) means we react to the selection MOVING, not to
// the item object being rebuilt by a server-pushed document.
const selectedItemUuid = useState<string | null>('selectedItemUuid', () => null);
const showMode = computed(() => uiMode.value === 'playback');
const scrollContainer = ref<HTMLElement | null>(null);
const canOnlineImport = computed(() => !!currentProject.value && server.isLocalServer);

const showYouTubeModal = ref(false);
const showSpotifyModal = ref(false);
const showImportModal  = ref(false);

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

// Queue waveform generation for every audio item that lacks peaks.
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
      if (ai.waveform) continue;
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
  showImportModal.value = true;
};

// Called once per file the user selected in the modal (server browse or upload).
// The path is always a server-side absolute path at this point.
const onImportPick = async (serverPaths: string | string[]) => {
  // The modal now batches selections; accept either a single path (legacy) or
  // an array. Import sequentially so each item gets a stable, ordered index.
  const paths = Array.isArray(serverPaths) ? serverPaths : [serverPaths];
  await importFromServerPaths(paths);
  showImportModal.value = false;
};

interface PreparedImport {
  audioItem: AudioItem;
  mediaServerPath: string;
}

interface ImportBatchResult {
  success: boolean;
  imported: number;
  error?: string;
  retainFiles?: boolean;
}

const prepareImportFromServerPath = async (
  serverPath: string,
  signal?: AbortSignal,
): Promise<PreparedImport | null> => {
  if (!currentProject.value) return null;
  try {
    if (signal?.aborted) return null;
    let destPath = serverPath;
    try {
      destPath = await server.copyToMedia(serverPath, signal);
      if (signal?.aborted) return null;
    } catch (e) {
      console.warn('[import] copyToMedia failed, using original path:', e);
      if (signal?.aborted) return null;
    }

    const fileName = destPath.split(/[\\/]/).pop() || 'audio';
    const uuid = crypto.randomUUID();

    let duration = 0;
    try {
      const md: any = await server.fetchMetadata(destPath, signal);
      if (signal?.aborted) return null;
      if (md && typeof md.duration_ms === 'number') duration = md.duration_ms / 1000;
    } catch (e) {
      console.warn('[import] fetchMetadata failed, falling back to 0 duration:', e);
      if (signal?.aborted) return null;
    }

    return {
      mediaServerPath: destPath,
      audioItem: {
        ...DEFAULT_AUDIO_ITEM,
        ...transitionDefaultsForImport((currentProject.value as any)?.settings?.defaultTransitionMode, duration),
        uuid,
        index: [currentProject.value.items.length],
        displayName: fileName.replace(/\.[^/.]+$/, ''),
        type: 'audio',
        mediaFileName: fileName,
        mediaPath: `media/${fileName}`,
        mediaServerPath: destPath,
        waveformPath: `waveforms/${uuid}.json`,
        waveform: undefined,
        outPoint: duration,
        duration,
      } as AudioItem,
    };
  } catch (e) {
    console.error('Error preparing import from server path:', e);
    return null;
  }
};

const importFromServerPaths = async (
  serverPaths: string[],
  signal?: AbortSignal,
): Promise<ImportBatchResult> => {
  const project = currentProject.value;
  const epoch = projectEpoch.value;
  if (!project || serverPaths.length === 0) {
    return { success: false, imported: 0, error: t('spotifyImport.cueImportFailed') };
  }

  const prepared: PreparedImport[] = [];
  for (const serverPath of serverPaths) {
    if (signal?.aborted ||
        currentProject.value !== project ||
        projectEpoch.value !== epoch) {
      return { success: false, imported: 0, error: t('spotifyImport.cancelled') };
    }
    const item = await prepareImportFromServerPath(serverPath, signal);
    if (item) prepared.push(item);
  }
  if (prepared.length !== serverPaths.length ||
      signal?.aborted ||
      currentProject.value !== project ||
      projectEpoch.value !== epoch) {
    return {
      success: false,
      imported: 0,
      error: signal?.aborted
        ? t('spotifyImport.cancelled')
        : t('spotifyImport.cueImportFailed'),
    };
  }

  for (const entry of prepared) {
    addItem(entry.audioItem);
  }

  if (signal?.aborted) {
    for (const entry of prepared) removeItem(entry.audioItem.uuid);
    return { success: false, imported: 0, error: t('spotifyImport.cancelled') };
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
    };
  }

  if (currentProject.value === project && projectEpoch.value === epoch) {
    for (const entry of prepared) {
      requestedWaveformUuids.add(entry.audioItem.uuid);
      server.requestWaveformGeneration(entry.mediaServerPath, entry.audioItem.uuid).catch((e) => {
        requestedWaveformUuids.delete(entry.audioItem.uuid);
        console.warn(`[waveform] generation request failed for ${entry.audioItem.displayName}:`, e);
      });
    }
  }
  return { success: true, imported: prepared.length };
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

.playlist-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-sm) var(--spacing-md);
  min-height: 48px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--color-border);
  background-color: var(--color-surface);
}

.playlist-header h2 {
  font-size: 14px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.playlist-actions {
  display: flex;
  gap: var(--spacing-sm);
}


.playlist-content {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-sm);
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
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.item-list-progress {
  padding: var(--spacing-sm) var(--spacing-md);
  font-size: 12px;
  color: var(--color-text-secondary);
  text-align: center;
  opacity: 0.7;
}
</style>
