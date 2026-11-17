<template>
  <div
    class="playlist-item"
    :data-item-uuid="item.uuid"
    :inert="!projectControlsReady"
    :aria-busy="!projectControlsReady"
    :class="{
      'is-selected': isSelected,
      'is-group': item.type === 'group',
      'is-sticky-group': item.type === 'group' && isExpanded && depth === 0,
      'is-audio': item.type === 'audio',
      'is-playing': isPlaying,
      'no-preview-lane': item.type === 'audio' && !hasPreviewDevice,
      'is-paused': isPaused,
      'is-up-next': isQueuedNext,
      'show-mode': showMode,
      'is-search-hit': isSearchHit,
      'drag-over-top': dragPosition === 'top',
      'drag-over-bottom': dragPosition === 'bottom',
      'drag-over-group': dragPosition === 'group',
      'is-dragging': isDragging,
      'warning-yellow': warningState === 'yellow',
      'warning-orange': warningState === 'orange',
      'warning-red': warningState === 'red'
    }"
    :style="itemStyle"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <!-- Waveform background for audio items. We render the canvas as soon as
         the row is audio (not gated on item.waveform) so the IntersectionObserver
         can attach at mount; drawWaveform() bails when there are no peaks yet
         and the watcher on item.waveform.peaks redraws once data arrives. The
         old `&& item.waveform` gate left the canvas missing at mount, so the
         observer was never set up and waveforms that loaded asynchronously
         never rendered. -->
    <canvas
      v-if="item.type === 'audio'"
      ref="waveformCanvas"
      class="waveform-canvas"
    ></canvas>

    <!-- End-of-cue warning border. Rendered as an inset overlay so the thick
         border is drawn entirely within the item's own box and is never
         clipped by the scroll container's overflow: hidden. -->
    <div
      v-if="warningState"
      class="warning-border"
      :class="`warning-border--${warningState}`"
    ></div>

    <div
      class="item-content"
      @click="handleSelect"
      :draggable="!showMode && !editingNote"
      @dragstart="handleDragStart"
      @dragend="handleDragEnd"
    >
      <span class="item-color-rail" :style="{ backgroundColor: item.color }" aria-hidden="true"></span>
      <!-- Progress bar for playing items (audio and groups) - only in header -->
      <div v-if="(isPlaying && item.type === 'audio') || (isGroupPlaying && item.type === 'group')" class="item-progress" :style="progressStyle"></div>
      
      <div class="item-left">
        <button 
          v-if="item.type === 'group'" 
          class="expand-btn"
          type="button"
          :aria-label="groupToggleLabel"
          :aria-expanded="isExpanded"
          :title="groupToggleLabel"
          @click.stop="toggleExpand"
        >
          <span class="material-symbols-rounded" aria-hidden="true">{{ isExpanded ? 'expand_more' : 'chevron_right' }}</span>
        </button>

        <div class="item-arm">
          <ActionButton
            class="set-next-action"
            :icon="isQueuedNext ? undefined : 'fast_forward'"
            :highlight-color="item.type === 'group' ? 'var(--folder-next-action)' : 'var(--state-up-next)'"
            active-text-color="var(--state-up-next-text)"
            :is-active="isManuallyQueued"
            :disabled="setNextItemPending"
            context="Playlist"
            @click.stop="handleSetAsNext"
            :label="t('status.upNext')"
            :hover-label="isQueuedNext ? undefined : t('controls.playNext')"
            :title="isManuallyQueued ? t('status.upNext') : t('actions.setAsNext')"
            :aria-label="isQueuedNext ? t('status.upNext') : t('actions.setAsNext')"
            :aria-current="isQueuedNext ? 'true' : undefined"
            :aria-pressed="isManuallyQueued"
          />
        </div>
        <!-- Without a preview device the headphones button has nothing to do;
             it is left out and the title takes its lane. -->
        <ActionButton
          v-if="item.type === 'audio' && hasPreviewDevice"
          class="preview-action"
          symbol="preview"
          highlight-color="var(--state-preview)"
          :is-active="isPreviewing"
          :class="{ 'no-device': !hasPreviewDevice }"
          context="Playlist"
          @click.stop="isPreviewing ? handleStopPreview() : handleStartPreview()"
          :title="isPreviewing ? t('actions.stopPreview') : (hasPreviewDevice ? t('actions.preview') : t('actions.previewNoDevice'))"
        />

        <div class="item-identity">
          <span class="item-index">{{ indexDisplay }}</span>

          <span v-if="item.type === 'group'" class="item-icon">
            <span class="material-symbols-rounded" aria-hidden="true">folder</span>
          </span>

          <!-- A note rides with the title on the playlist only: it is not the
               cue's name, is not shown on the transport, QuickPlays or the
               video output, and never touches the media file. Double-click
               the title (or F2) to write one in Edit Mode. -->
          <input
            v-if="editingNote"
            ref="noteInput"
            v-model="noteDraft"
            class="item-name item-name--editing"
            type="text"
            maxlength="120"
            :placeholder="t('playlist.notePlaceholder', { name: item.displayName })"
            :aria-label="t('playlist.notePlaceholder', { name: item.displayName })"
            @click.stop @dblclick.stop @pointerdown.stop @mousedown.stop
            @keydown.stop="onNoteKeydown" @keyup.stop
            @blur="commitNote"
          />
          <button
            v-else-if="mediaFileName && mediaFileName !== item.displayName"
            type="button"
            class="item-name"
            :aria-pressed="showFileName"
            :title="[visibleTitle, item.note, t(showFileName ? 'actions.showCueTitle' : 'actions.showMediaFilename'), showMode ? '' : t('playlist.noteHint')].filter(Boolean).join('\n')"
            @click="toggleFileName"
            @dblclick.stop="startNote"
          >{{ visibleTitle }}<span v-if="item.note" class="item-note">{{ item.note }}</span></button>
          <span v-else class="item-name" :title="[item.displayName, item.note, showMode ? '' : t('playlist.noteHint')].filter(Boolean).join('\n')" @dblclick.stop="startNote">{{ item.displayName }}<span v-if="item.note" class="item-note">{{ item.note }}</span></span>
          <span
            v-if="isPeaking"
            class="material-symbols-rounded peak-warning-icon"
            :title="t('properties.peakCeilingWarning')"
            role="img"
            :aria-label="t('properties.peakCeilingWarning')"
            draggable="false"
            @click.stop
          >bomb</span>
        </div>

        <div class="item-state">
          <span v-if="isPaused" class="status-pill paused">{{ t('status.paused') }}</span>
          <span v-else-if="isPlaying" class="status-pill playing">{{ t('status.playing') }}</span>
          <span v-if="isPreviewing" class="status-pill preview">{{ t('status.previewing') }}</span>

          <!-- Behavior indicators (for audio items) -->
          <div v-if="item.type === 'audio'" class="behavior-indicators">
            <!-- Start behavior -->
            <span
              v-if="item.startBehavior?.action === 'play-next'"
              class="material-symbols-rounded behavior-icon"
              :title="t('behaviors.startPlayNext')"
            >skip_next</span>
            <span
              v-else-if="item.startBehavior?.action === 'play-item'"
              class="material-symbols-rounded behavior-icon"
              :title="t('behaviors.startPlayItem')"
            >arrow_forward</span>
            <span
              v-else-if="item.startBehavior?.action === 'play-index'"
              class="material-symbols-rounded behavior-icon"
              :title="t('behaviors.startPlayIndex')"
            >arrow_forward</span>

            <!-- Ducking behavior -->
            <span
              v-if="item.duckingBehavior?.mode === 'duck-others'"
              class="material-symbols-rounded behavior-icon"
              :title="t('behaviors.duckingOthers')"
            >volume_down</span>

            <!-- Start Next segue marker -->
            <span
              v-if="item.startNextEnabled && (item.startNextTime ?? 0) > 0"
              class="material-symbols-rounded behavior-icon behavior-icon-segue"
              :title="t('behaviors.startNextMarker', { time: formatMarkerTime(item.startNextTime ?? 0) })"
            >flag</span>

            <!-- End behavior -->
            <span
              v-if="item.endBehavior?.action === 'goto-item'"
              class="material-symbols-rounded behavior-icon"
              :title="t('behaviors.endGotoItem')"
            >arrow_forward</span>
            <span
              v-else-if="item.endBehavior?.action === 'goto-index'"
              class="material-symbols-rounded behavior-icon"
              :title="t('behaviors.endGotoIndex')"
            >arrow_forward</span>
            <span
              v-else-if="item.endBehavior?.action === 'loop'"
              class="material-symbols-rounded behavior-icon"
              :title="t('behaviors.endLoop')"
            >replay</span>
          </div>
          <!-- Level, on every row: a cue's Volume or a group's Group level,
               the same values Properties edits (see ItemLevel). -->
          <ItemLevel :item="item" :read-only="showMode" :disabled="!projectControlsReady" />
        </div>

        <span v-if="item.type === 'audio'" class="item-duration" :style="{ color: durationColor ?? undefined }">{{ durationDisplay }}</span>
        <span
          v-if="item.type === 'audio' && item.hasVideo"
          class="video-badge-icon"
          :class="{ 'video-badge-icon--failed': videoCheckIssue }"
          :title="videoCheckIssue ? t(`videoCheck.${videoCheckIssue}`) : t('playlist.videoCue')"
          role="img"
          :aria-label="videoCheckIssue ? t(`videoCheck.${videoCheckIssue}`) : t('playlist.videoCue')"
          draggable="false"
          @click.stop
        >{{ videoCheckIssue ? 'VIDEO !' : 'VIDEO' }}</span>
        <ActionButton
          v-if="item.type === 'group' && !showMode"
          class="group-shuffle-action"
          icon="shuffle"
          type="button"
          :title="t('shuffle.group')"
          :aria-label="t('shuffle.groupFor', { name: item.displayName })"
          :disabled="item.children.length < 2 || shufflePending || !projectControlsReady || server.cueStartsBlocked"
          @click.stop="shuffleItems(item, status => showHeaderWarning(t(`shuffle.${status}`)))"
        />
        <!-- Show Mode: the shuffle button's place, kept empty. -->
        <span v-else-if="item.type === 'group'" class="group-shuffle-action group-shuffle-action--place" aria-hidden="true"></span>

        <div class="item-transport">
          <ActionButton
            v-if="item.type === 'group' && ((groupBackup?.type === 'group' && groupBackup.uuid !== item.uuid) || item.keepMusicGoing)"
            class="group-music-toggle"
            icon="music_note"
            highlight-color="var(--state-ready)"
            active-text-color="var(--color-background)"
            type="button"
            :is-active="item.keepMusicGoing === true"
            :aria-pressed="item.keepMusicGoing === true"
            :aria-label="t('musicContinuity.groupToggle', { name: item.displayName })"
            :title="groupBackup?.type === 'group'
              ? t('musicContinuity.target', { name: groupBackup.displayName }) : t('musicContinuity.chooseBackup')"
            :disabled="!projectControlsReady || server.cueStartsBlocked || musicContinuityPending.has(item.uuid)"
            @click.stop="toggleGroupMusic"
          />
          <ActionButton
            v-if="isPlaying && item.type === 'audio'"
            class="restart-action"
            icon="restart_alt"
            highlight-color="var(--color-text-secondary)"
            context="Playlist"
            type="button"
            @click.stop="handleRestart"
            :title="t('actions.restartCue', { name: item.displayName })"
            :aria-label="t('actions.restartCue', { name: item.displayName })"
          />
          <ActionButton
            class="play-action"
            :class="{ 'is-stop': isPlaying }"
            :icon="isPlaying ? 'stop' : 'play_arrow'"
            :highlight-color="isPlaying ? 'var(--stop-edge)' : (item.type === 'group' ? 'var(--folder-play-action)' : 'var(--state-ready)')"
            context="Playlist"
            @click.stop="isPlaying ? handleStop() : handlePlay()"
            :title="isPlaying ? t('actions.stop') : t('actions.play')"
          />
        </div>

        <!-- Keep transport beside the clock, with Play Next in the far-right
             arm lane; preview remains beside the cue number and edit/delete
             stay hidden in Show Mode. -->
        <!-- The lane is always there, so nothing beside it moves when Show
             Mode takes the two buttons out. -->
        <div class="item-actions" :class="{ 'item-actions--single': !isSelected }">
          <ActionButton
            v-if="!showMode"
            class="edit-action"
            icon="settings"
            highlight-color="var(--color-accent)"
            context="Playlist"
            @click.stop="handleEdit"
            :title="t('actions.edit')"
          />
          <ActionButton
            v-if="!showMode"
            class="delete-action"
            :class="{ 'delete-action--parked': !isSelected }"
            icon="delete"
            highlight-color="var(--color-danger)"
            context="Playlist"
            @click.stop="handleDelete"
            :title="t('actions.delete')"
          />
        </div>
    </div>
    
      </div>
    <div v-if="item.type === 'group' && isExpanded && item.children.length > 0" class="group-children">
      <PlaylistItem
        v-for="child in item.children"
        :key="child.uuid"
        :item="child"
        :depth="depth + 1"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { countdownColorForSeconds, countdownInk, type AudioItem, type GroupItem, type BaseItem } from '~/types/project';
import ActionButton from './ActionButton.vue';
import ItemLevel from './ItemLevel.vue';
import { useOutputTarget, METER_COLORS } from '~/composables/useOutputTarget';
import { exceedsTruePeakCeiling } from '~/utils/audio';
import { cloneAsPlaylistItem } from '~/utils/quickPlays';

const props = defineProps<{
  item: AudioItem | GroupItem;
  depth: number;
}>();

const {
  selectedItem,
  selectedItems,
  toggleItemSelection,
  openItemProperties,
  removeItem,
  requestDeleteFromButton,
  findItemByUuid,
  currentProject,
  projectHydrationStatus,
  saveProject,
  updateIndices,
  waveformUpdateKey,
  triggerWaveformUpdate,
  formatItemIndex,
  shuffleItems,
  shufflePending,
  setMusicContinuity,
  musicContinuityPending,
} = useProject();

// mm:ss position of the Start Next marker, for the badge tooltip.
const formatMarkerTime = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};
const { levels: outputTargetLevels } = useOutputTarget();
const { playCue, stopCue, seekCue, activeCues, activeGroups, triggerGroup, nextItemOverrideUuid, autoNextItemUuid, setNextItemPending, setNextItem } = useAudioEngine();
const { t } = useLocalization();
const server = useLiveplayServer();
const { showHeaderWarning } = useHeaderWarnings();
const groupBackup = computed(() => props.item.type === 'group'
  ? findItemByUuid(props.item.backupMusicGroup ?? currentProject.value?.settings?.backupMusicGroup ?? '')
  : null);
const toggleGroupMusic = () => {
  const group = props.item;
  if (group.type !== 'group') return;
  if (!group.keepMusicGoing && (groupBackup.value?.type !== 'group' || groupBackup.value.uuid === group.uuid)) {
    showHeaderWarning(t('musicContinuity.chooseBackup'));
    return;
  }
  return setMusicContinuity(group, { keepMusicGoing: !group.keepMusicGoing },
    status => showHeaderWarning(t(`musicContinuity.${status}`)));
};
const videoCheckIssues = useVideoPreflightIssues();
const videoCheckIssue = computed(() => videoCheckIssues.value.get(props.item.uuid));
const { uiMode } = useUiMode();

// Show Mode strips edit affordances (preview/edit/delete + drag) and scales the
// row up for touch, while keeping waveform, colour, duration, behaviour flags
// and warnings identical to edit mode.
const showMode = computed(() => uiMode.value === 'playback');
const projectControlsReady = computed(() => projectHydrationStatus.value === 'ready');

// The row the playlist search jumped to (see PlaylistSearch).
const searchHit = useState<string | null>('playlistSearchHit', () => null);
const isSearchHit = computed(() => searchHit.value === props.item.uuid);

// Playlist note: an optional line beside the title. It is its own field, so
// the cue's title and the media file's name stay exactly as they are.
const editingNote = ref(false);
const noteDraft = ref('');
const noteInput = ref<HTMLInputElement | null>(null);
const noteEditRequest = useState<string | null>('playlistNoteEditRequest', () => null);
function startNote() {
  if (showMode.value || !projectControlsReady.value || editingNote.value) return;
  noteDraft.value = props.item.note ?? '';
  editingNote.value = true;
  void nextTick(() => { noteInput.value?.focus(); noteInput.value?.select(); });
}
function commitNote() {
  if (!editingNote.value) return;
  editingNote.value = false;
  const note = noteDraft.value.trim();
  if (note === (props.item.note ?? '')) return;
  if (note) props.item.note = note;
  else delete props.item.note;          // clearing the field removes the note
  void saveProject();
}
function onNoteKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') { event.preventDefault(); commitNote(); }
  // Escape only abandons the edit here; it is not Stop All while a note is open.
  else if (event.key === 'Escape') { event.preventDefault(); editingNote.value = false; }
}
// F2 on the selected row (see MainWorkspace).
watch(noteEditRequest, (uuid) => {
  if (uuid !== props.item.uuid) return;
  noteEditRequest.value = null;
  startNote();
});


const { isRevealed, forgetReveal } = usePlaylistReveal();

// A group is open either because the operator left it open (persisted on the
// item) or because the playlist is temporarily holding it open to expose an
// off-screen selection. Derived rather than a local ref: the reveal is driven
// from outside this component, and a ref seeded from the prop at mount would
// never see it.
const isExpanded = computed(() =>
  props.item.type === 'group' && (props.item.isExpanded || isRevealed(props.item.uuid)),
);
const groupToggleLabel = computed(() =>
  `${t(isExpanded.value ? 'actions.close' : 'serverSettings.open')} ${props.item.displayName}`,
);
const waveformCanvas = ref<HTMLCanvasElement | null>(null);
const dragPosition = ref<'top' | 'bottom' | 'group' | null>(null);
const isDragging = ref(false);
const showFileName = ref(false);
const mediaFileName = computed(() => {
  const item = props.item;
  if (item.type !== 'audio') return '';
  return item.mediaFileName || (item.mediaServerPath || item.mediaPath || '').split(/[\\/]/).pop() || '';
});
const visibleTitle = computed(() => showFileName.value && mediaFileName.value ? mediaFileName.value : props.item.displayName);

function toggleFileName(event: MouseEvent) {
  if (!event.ctrlKey && !event.metaKey && !event.shiftKey) showFileName.value = !showFileName.value;
}

const isSelected = computed(() => selectedItems.value.has(props.item.uuid));
const isPlaying = computed(() => activeCues.value.has(props.item.uuid));
const isPaused = computed(() =>
  props.item.type === 'audio' && activeCues.value.get(props.item.uuid)?.isPaused === true,
);
// The stored override drives the filled button and toggle behaviour.
const isManuallyQueued = computed(() => nextItemOverrideUuid.value === props.item.uuid);
// Effective "up next" — manual override wins; falls back to auto-derived from end behavior
const isQueuedNext = computed(() => {
  if (nextItemOverrideUuid.value) return nextItemOverrideUuid.value === props.item.uuid;
  return autoNextItemUuid.value === props.item.uuid;
});
const isGroupPlaying = computed(() => props.item.type === 'group' && activeGroups.value.has(props.item.uuid));

const indexDisplay = computed(() => {
  return formatItemIndex(props.item.index);
});

// True when measured true peak plus item gain exceeds the active ceiling.
const isPeaking = computed(() => {
  if (props.item.type !== 'audio') return false;
  return exceedsTruePeakCeiling(
    props.item as AudioItem,
    outputTargetLevels.value.limiterCeilingDb,
  );
});

const durationDisplay = computed(() => {
  if (props.item.type !== 'audio') return '';
  
  const audioItem = props.item as AudioItem;
  
  // If playing, show countdown
  if (isPlaying.value) {
    const timeRemaining = playbackDuration.value - currentPlaybackTime.value;
    const totalSeconds = Math.floor(timeRemaining);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    if (hours > 0) {
      return `-${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    } else {
      return `-${minutes}:${seconds.toString().padStart(2, '0')}`;
    }
  }
  
  // Otherwise show trimmed duration
  const totalDuration = audioItem.duration;
  const inPoint = audioItem.inPoint || 0;
  const outPoint = audioItem.outPoint || totalDuration;
  const trimmedDuration = outPoint - inPoint;
  
  const totalSeconds = Math.floor(trimmedDuration);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  } else {
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }
});

// Draw waveform
const drawWaveform = () => {
  if (!waveformCanvas.value || props.item.type !== 'audio') return;
  
  const audioItem = props.item as AudioItem;
  if (!audioItem.waveform || !audioItem.waveform.peaks || audioItem.waveform.peaks.length === 0) return;
  
  const canvas = waveformCanvas.value;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  
  // Set canvas size to match element size (use actual pixels for clarity)
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  
  // Clear canvas
  ctx.clearRect(0, 0, rect.width, rect.height);

  // Draw the real decoded peaks in the cue's authored colour. The canvas-level
  // opacity keeps the controls and labels readable without desaturating the hue.
  ctx.fillStyle = getComputedStyle(canvas).color;

  const peaks = audioItem.waveform.peaks;
  
  // Calculate trimmed region if in/out points are set
  const totalDuration = audioItem.duration;
  const inPoint = audioItem.inPoint || 0;
  const outPoint = audioItem.outPoint || totalDuration;
  const trimmedDuration = outPoint - inPoint;
  
  // Calculate which peaks to show (slice based on in/out ratios)
  const startIndex = Math.floor((inPoint / totalDuration) * peaks.length);
  const endIndex = Math.ceil((outPoint / totalDuration) * peaks.length);
  const trimmedPeaks = peaks.slice(startIndex, endIndex);
  
  const barWidth = rect.width / trimmedPeaks.length;
  const centerY = rect.height / 2;

  trimmedPeaks.forEach((value, i) => {
    // Gamma 2 expansion: shows dynamics without blowing up loud tracks.
    const clamped = Math.min(1, Math.max(0, value));
    const shaped = clamped * clamped;
    const barHeight = shaped * rect.height * 0.8;
    const x = i * barWidth;
    const y = centerY - barHeight / 2;

    ctx.fillRect(x, y, Math.max(barWidth, 1), barHeight);
  });
};

// Redraw waveform when component mounts or updates.
// Performance: with 80+ items on screen we MUST avoid creating expensive
// observers and timers for every single item up-front. We use a single
// IntersectionObserver per component that only draws when the item is in
// the viewport, and skip the redundant ResizeObserver + 2-second polling
// loop that the old client used.
let resizeObserver: ResizeObserver | null = null;
let intersectionObserver: IntersectionObserver | null = null;
let isVisible = false;
let hasDrawnOnce = false;

function ensureDraw() {
  if (!isVisible) return;
  if (props.item.type !== 'audio') return;
  hasDrawnOnce = true;
  drawWaveform();
}

onMounted(() => {
  if (props.item.type !== 'audio' || !waveformCanvas.value) return;

  // Defer the first canvas draw until the item scrolls into view. The
  // IntersectionObserver also makes sure off-screen items don't redraw
  // when their props change.
  intersectionObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const wasVisible = isVisible;
      isVisible = e.isIntersecting;
      if (isVisible && !hasDrawnOnce) {
        nextTick(ensureDraw);
      } else if (isVisible && !wasVisible) {
        // Re-entering viewport — redraw in case the canvas was resized
        // while hidden.
        nextTick(ensureDraw);
      }
    }
  }, { rootMargin: '200px' });   // pre-render a bit before they enter view
  intersectionObserver.observe(waveformCanvas.value);

  // Single ResizeObserver per visible item only.
  resizeObserver = new ResizeObserver(() => {
    if (isVisible) drawWaveform();
  });
  resizeObserver.observe(waveformCanvas.value);
});

onUnmounted(() => {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (intersectionObserver) {
    intersectionObserver.disconnect();
    intersectionObserver = null;
  }
});

// NOTE: The old per-item 2-second waveform polling (with saveProject() on
// every fire) has been removed. With 80+ items in a project that was 80
// concurrent setIntervals + 80 saveProject calls — the main reason the
// UI froze on load. Server-owned waveforms now come down with the
// project document, or via /api/waveform/<cueId> on demand.
//
// Likewise the deep-watch on props.item used to redraw the canvas on
// every reactive change anywhere in the item tree — including volume,
// inPoint, outPoint, AND any unrelated reactivity bumps. We replace it
// with shallow watches on the specific fields that change waveform
// rendering, and skip drawing when the item is not visible.
watch([
  () => (props.item as AudioItem | GroupItem).color,
  () => (props.item as AudioItem).inPoint,
  () => (props.item as AudioItem).outPoint,
  () => (props.item as AudioItem).waveform?.peaks,
], () => {
  if (isVisible && props.item.type === 'audio') nextTick(drawWaveform);
});

// Global "redraw all waveforms" trigger — still respected, but no-ops for
// off-screen items thanks to the visibility check.
watch(() => waveformUpdateKey.value, () => {
  if (isVisible && props.item.type === 'audio') nextTick(drawWaveform);
});

// Playback progress is derived directly from the reactive activeCues /
// activeGroups maps so meter updates from the server propagate without an
// interval. The previous design captured `cue` in a setInterval closure and
// went stale the moment upsertActiveCue() replaced the entry (e.g. a second
// cue_state edge during FadingIn→Playing, a playback_snapshot rebroadcast,
// or any duck event), which is what caused the item-row progress to freeze
// while the Active Cue panel — which always re-reads the map — kept ticking.
const currentPlaybackTime = computed(() => {
  if (props.item.type === 'audio') {
    const cue = activeCues.value.get(props.item.uuid);
    return cue ? cue.currentTime : 0;
  }
  if (props.item.type === 'group') {
    const g = activeGroups.value.get(props.item.uuid);
    return g ? g.currentTime : 0;
  }
  return 0;
});
const playbackDuration = computed(() => {
  if (props.item.type === 'audio') {
    const cue = activeCues.value.get(props.item.uuid);
    return cue ? cue.duration : 0;
  }
  if (props.item.type === 'group') {
    const g = activeGroups.value.get(props.item.uuid);
    return g ? g.totalDuration : 0;
  }
  return 0;
});
const theme = useState('theme', () => 'dark');
const durationColor = computed(() => {
  if (!isPlaying.value || props.item.type !== 'audio') return null;
  const duration = playbackDuration.value;
  const current = currentPlaybackTime.value;
  if (!Number.isFinite(duration) || !Number.isFinite(current) || duration <= 0) return null;
  return countdownInk(countdownColorForSeconds(
    Math.max(0, Math.ceil(duration - current)),
    (currentProject.value as any)?.settings?.countdownColorBands,
  ), theme.value);
});
const playbackProgress = computed(() => {
  const d = playbackDuration.value;
  if (d <= 0) return 0;
  return Math.min((currentPlaybackTime.value / d) * 100, 100);
});

// Warning state based on time remaining
const warningState = computed(() => {
  if (!isPlaying.value || props.item.type !== 'audio') return null;
  const d = playbackDuration.value;
  if (d <= 0) return null;
  const timeRemaining = d - currentPlaybackTime.value;
  if (timeRemaining <= 5) return 'red';
  if (timeRemaining <= 10) return 'orange';
  if (timeRemaining <= 30) return 'yellow';
  return null;
});

const itemStyle = computed(() => {
  const depthOffset = props.depth > 0 ? 24 : 0;
  return {
    marginLeft: `${depthOffset}px`,
    '--folder-background': 'var(--color-surface-raised)',
    '--waveform-color': props.item.color || 'var(--color-text-tertiary)',
  };
});

const progressStyle = computed(() => ({
  width: `${playbackProgress.value}%`,
}));

const handleSelect = (event: MouseEvent) => {
  // Rows are not selectable in Show Mode — it's a playback surface, not an
  // editing list, and selection drives edit-only affordances (properties
  // panel, delete) that are already hidden here.
  if (showMode.value) return;
  toggleItemSelection(props.item.uuid, event.ctrlKey || event.metaKey, event.shiftKey);
};

const handleRestart = () => {
  if (props.item.type !== 'audio') return;
  seekCue(props.item.uuid, props.item.inPoint ?? 0);
};

const handlePlay = () => {
  if (props.item.type === 'audio') {
    return playCue(props.item as AudioItem);
  }
  if (props.item.type === 'group') return triggerGroup(props.item);
  return false;
};

const handleStop = () => {
  return stopCue(props.item.uuid);
};

const handleEdit = () => {
  openItemProperties(props.item.uuid);
};

// ---- Preview (pre-listen) handlers -------------------------------------
// Preview routes the cue through the configured preview device (typically
// headphones) without disturbing main project playback. The previewing
// state is owned by the server (only one preview at a time); the client
// reads it from useProject().previewItemUuid.
const { previewItemUuid, startPreview, stopPreview } = useProject();
const isPreviewing = computed(() =>
  previewItemUuid.value === props.item.uuid,
);
const hasPreviewDevice = computed(() => !!(currentProject.value as any)?.settings?.previewDevice);
const showProjectSettings = useState('showProjectSettings', () => false);
const handleStartPreview = () => {
  if (props.item.type !== 'audio') return;
  if (!hasPreviewDevice.value) {
    showProjectSettings.value = true;
    return;
  }
  startPreview(props.item.uuid);
};
const handleStopPreview = () => {
  stopPreview();
};

const handleSetAsNext = (): Promise<boolean> =>
  setNextItem(isManuallyQueued.value ? null : props.item.uuid);

const handleDelete = () => {
  requestDeleteFromButton(props.item.uuid);
};

const toggleExpand = () => {
  if (props.item.type !== 'group') return;
  const open = isExpanded.value;
  // Collapsing by hand also drops any temporary reveal — otherwise a group
  // still holding the selection would spring straight back open.
  if (open) forgetReveal(props.item.uuid);
  props.item.isExpanded = !open;
};

const handleDragStart = (e: DragEvent) => {
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = props.item.type === 'audio' ? 'copyMove' : 'move';
    e.dataTransfer.setData('item-uuid', props.item.uuid);
    e.dataTransfer.setData('playlist-reorder', 'true');
    if (props.item.type === 'audio') {
      // QuickPlay targets use this explicit type to treat a playlist drag as
      // a copy while playlist rows continue to use item-uuid for reordering.
      e.dataTransfer.setData('playlist-audio-uuid', props.item.uuid);
    }
    e.dataTransfer.setData('item-depth', props.depth.toString());
    
    // If this item is part of a multi-selection, store all selected UUIDs
    if (selectedItems.value.has(props.item.uuid) && selectedItems.value.size > 1) {
      const selectedUuids = Array.from(selectedItems.value);
      e.dataTransfer.setData('selected-items', JSON.stringify(selectedUuids));
    }
    isDragging.value = true;
  }
};

const handleDragEnd = () => {
  isDragging.value = false;
  dragPosition.value = null;
};

const handleDragOver = (e: DragEvent) => {
  e.preventDefault();
  e.stopPropagation();
  if (showMode.value) {
    dragPosition.value = null;
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    return;
  }
  if (!e.dataTransfer) return;
  
  const isQuickPlayCopy = e.dataTransfer.types.includes('quickplay-uuid');
  e.dataTransfer.dropEffect = isQuickPlayCopy ? 'copy' : 'move';
  
  // Determine drop position based on mouse position
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const y = e.clientY - rect.top;
  const height = rect.height;
  
  if (props.item.type === 'group' && y > height * 0.3 && y < height * 0.7) {
    // Middle third of group = drop inside
    dragPosition.value = 'group';
  } else if (y < height / 2) {
    // Top half = insert before
    dragPosition.value = 'top';
  } else {
    // Bottom half = insert after
    dragPosition.value = 'bottom';
  }
};

const handleDragLeave = () => {
  dragPosition.value = null;
};

const handleDrop = (e: DragEvent) => {
  e.preventDefault();
  e.stopPropagation();

  dragPosition.value = null;

  // Rows are read-only in Show Mode — no reordering or import drops.
  if (showMode.value) return;
  if (!e.dataTransfer || !currentProject.value) return;

  // A QuickPlay dragged back into the playlist creates a normal playlist cue
  // and leaves the source cell armed. This is intentionally a copy: the live
  // quick-fire surface must not disappear because a tech reorganized a show.
  const quickPlayUuid = e.dataTransfer.getData('quickplay-uuid');
  if (quickPlayUuid) {
    if (quickPlayUuid === props.item.uuid) return;
    const source = findItemByUuid(quickPlayUuid);
    if (!source || source.type !== 'audio') return;
    insertPlaylistCloneAtTarget(
      cloneAsPlaylistItem(source as AudioItem, crypto.randomUUID()),
      e,
    );
    return;
  }

  const draggedUuid = e.dataTransfer.getData('item-uuid');
  if (!draggedUuid || draggedUuid === props.item.uuid) return;
  
  // Check if we're dragging multiple items. Guard the parse: a foreign or
  // corrupt drag payload would otherwise throw and abort the whole drop.
  const selectedItemsData = e.dataTransfer.getData('selected-items');
  let itemsToMove: string[] = [draggedUuid];
  if (selectedItemsData) {
    try {
      const parsed = JSON.parse(selectedItemsData);
      if (Array.isArray(parsed) && parsed.length > 0) itemsToMove = parsed;
    } catch {
      // Keep the single-item fallback.
    }
  }
  
  // Don't drop onto one of the items being moved
  if (itemsToMove.includes(props.item.uuid)) return;
  
  // Collect all items to move (in their current order)
  const allProjectItems = getAllItemsFlattened(currentProject.value.items);
  const itemObjects = itemsToMove
    .map(uuid => findItemByUuid(uuid))
    .filter(item => item !== null);
  
  if (itemObjects.length === 0) return;
  
  // Remove all items from their current locations (in reverse order to maintain indices)
  for (let i = itemObjects.length - 1; i >= 0; i--) {
    const item = itemObjects[i];
    if (item) {
      removeItem(item.uuid);
    }
  }
  
  // Determine insertion point
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const y = e.clientY - rect.top;
  const height = rect.height;
  
  if (props.item.type === 'group' && y > height * 0.3 && y < height * 0.7) {
    // Drop inside group
    const groupItem = props.item as GroupItem;
    itemObjects.forEach(item => {
      if (item) {
        groupItem.children.push(item);
      }
    });
    const { updateIndices } = useProject();
    updateIndices(groupItem.children, groupItem.index);
  } else {
    // Find parent array and insert before/after
    const insertAfter = y >= height / 2;
    const targetIndex = props.item.index;
    
    // Find parent array (either root items or group children)
    let parentArray = currentProject.value.items;
    let parentIndex: number[] = [];
    
    if (targetIndex.length > 1) {
      // Item is in a group, find the parent group
      const parentGroupIndex = targetIndex.slice(0, -1);
      const parentGroup = findItemByIndex(parentGroupIndex);
      if (parentGroup && parentGroup.type === 'group') {
        const groupParent = parentGroup as GroupItem;
        parentArray = groupParent.children;
        parentIndex = groupParent.index;
      }
    }
    
    // Find position in parent array
    const itemPosInArray = parentArray.findIndex(i => i.uuid === props.item.uuid);
    let insertPos = insertAfter ? itemPosInArray + 1 : itemPosInArray;
    
    // Insert all items at the position
    itemObjects.forEach((item, idx) => {
      if (item) {
        parentArray.splice(insertPos + idx, 0, item);
      }
    });
    
    // Update all indices
    const { updateIndices } = useProject();
    updateIndices(parentArray, parentIndex);
  }
  
  // Save project
  void saveProject();
};

const insertPlaylistCloneAtTarget = (clone: AudioItem, e: DragEvent) => {
  if (!currentProject.value) return;

  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const y = e.clientY - rect.top;
  const height = rect.height;

  if (props.item.type === 'group' && y > height * 0.3 && y < height * 0.7) {
    const groupItem = props.item as GroupItem;
    groupItem.children.push(clone);
    updateIndices(groupItem.children, groupItem.index);
    void saveProject();
    return;
  }

  const insertAfter = y >= height / 2;
  const targetIndex = props.item.index;
  let parentArray = currentProject.value.items;
  let parentIndex: number[] = [];

  if (targetIndex.length > 1) {
    const parentGroup = findItemByIndex(targetIndex.slice(0, -1));
    if (parentGroup?.type === 'group') {
      parentArray = (parentGroup as GroupItem).children;
      parentIndex = parentGroup.index;
    }
  }

  const itemPosInArray = parentArray.findIndex(item => item.uuid === props.item.uuid);
  if (itemPosInArray < 0) return;
  parentArray.splice(insertAfter ? itemPosInArray + 1 : itemPosInArray, 0, clone);
  updateIndices(parentArray, parentIndex);
  void saveProject();
};

// Helper to get all items flattened
const getAllItemsFlattened = (items: (AudioItem | GroupItem)[]): (AudioItem | GroupItem)[] => {
  const result: (AudioItem | GroupItem)[] = [];
  for (const item of items) {
    result.push(item);
    if (item.type === 'group') {
      const groupItem = item as GroupItem;
      result.push(...getAllItemsFlattened(groupItem.children));
    }
  }
  return result;
};

// Helper to find item by index
const findItemByIndex = (index: number[]): AudioItem | GroupItem | null => {
  if (!currentProject.value) return null;
  
  let current: any = { children: currentProject.value.items };
  for (const i of index) {
    if (!current.children || !current.children[i]) return null;
    current = current.children[i];
  }
  return current;
};
</script>

<style scoped>
.playlist-item {
  --current-playlist-row-height: var(--playlist-row-height, 44px);
  --folder-play-action: color-mix(in srgb, var(--state-ready) 82%, var(--color-accent));
  --folder-next-action: color-mix(in srgb, var(--state-up-next) 84%, var(--color-accent));
  --cue-cell-height: 28px;
  --cue-text-size: 16px;
  position: relative;
  overflow: hidden;
  margin-bottom: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-sm);
  background: var(--color-surface);
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    box-shadow var(--transition-fast);

  /* Native sticky positioning keeps every open folder's collapse control in
     reach. Expanded group wrappers must not become overflow ancestors or the
     header would stick to the group itself instead of the playlist scroller. */
  &.is-sticky-group {
    overflow: clip;
  }

  /* ponytail: sticky navigation is intentionally top-level; nested sticky
     stacks need measured row heights once nested-folder shows become common. */
  &.is-sticky-group > .item-content {
    position: sticky;
    top: 0;
    z-index: 20;
    background: var(--folder-background);
    box-shadow:
      inset 0 -1px var(--color-border-strong),
      0 2px 4px rgba(0, 0, 0, 0.16);
  }
  
  &.is-selected {
    outline: 1px solid var(--color-focus-ring);
    outline-offset: -1px;
  }

  &.is-group {
    --current-playlist-row-height: var(--folder-playlist-row-height, 60px);
  }

  &.is-group > .item-content {
    background: var(--folder-background);
  }

  &.is-group > .item-content :deep(.play-action.action-btn--playlist:not(.action-btn--active)) {
    background-color: color-mix(in srgb, var(--folder-play-action) 14%, var(--color-control));
    border-color: color-mix(in srgb, var(--folder-play-action) 34%, var(--color-border));
  }

  &.is-group > .item-content :deep(.set-next-action.action-btn--playlist:not(.action-btn--active)) {
    background-color: color-mix(in srgb, var(--folder-next-action) 14%, var(--color-control));
    border-color: color-mix(in srgb, var(--folder-next-action) 34%, var(--color-border));
  }
  
  &.drag-over-top::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 3px;
    background-color: var(--color-accent);
    z-index: 10;
  }
  
  &.drag-over-bottom::after {
    content: '';
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 3px;
    background-color: var(--color-accent);
    z-index: 10;
  }
  
  &.drag-over-group {
    box-shadow: inset 0 0 0 3px var(--color-accent);
  }
}

.playlist-item.is-up-next:not(.is-playing) {
  /* Next: var(--state-up-next) as a green edge and a green number chip. The
     title stays white: words are easier to read in white than in colour. */
  border-color: var(--state-up-next);
  box-shadow: inset 0 0 0 2px var(--state-up-next);
}

.playlist-item.is-playing {
  /* On air: var(--state-playing) as a red edge, a red number chip and the
     Playing badge. The row stays dark and its words stay white, which is the
     easiest thing to read; solid colour is what the eye finds. */
  border-color: var(--state-playing-edge);
  box-shadow:
    inset 0 0 0 3px var(--state-playing-edge),
    0 0 12px color-mix(in srgb, var(--state-playing-edge) 45%, transparent);
  z-index: 1;
}

/* Stop on the live row: the striped edge of Stop All, never the live red. */
.playlist-item .item-transport .play-action.is-stop.is-stop {
  border: var(--stop-button-border);
  background: var(--stop-button-background);
  color: var(--stop-edge);
}

/* The cue number becomes a solid chip: red on air, green for what is next. */
.playlist-item.is-playing:not(.is-paused) > .item-content .item-index {
  border-color: var(--state-playing);
  background: var(--state-playing);
  color: var(--state-playing-on);
}

.playlist-item.is-up-next:not(.is-playing) > .item-content .item-index {
  border-color: var(--state-up-next);
  background: var(--state-up-next);
  color: var(--state-up-next-text);
}

/* A shape as well as a colour, for anyone who cannot tell red from green: a
   play arrow on the live chip, and on the chip of what is next the same
   double arrow as the Play Next button. */
.playlist-item.is-playing:not(.is-paused) > .item-content .item-index::before,
.playlist-item.is-up-next:not(.is-playing) > .item-content .item-index::before {
  content: 'play_arrow' / '';
  flex: none;
  margin-inline: -3px 1px;
  font-family: 'Material Symbols Rounded';
  font-size: 16px;
  font-weight: normal;
  font-style: normal;
  line-height: 1;
  letter-spacing: normal;
  font-variation-settings: 'FILL' 1;
  font-feature-settings: 'liga';
}

.playlist-item.is-up-next:not(.is-playing) > .item-content .item-index::before {
  content: 'fast_forward' / '';
}

.playlist-item.is-playing.is-paused {
  border-color: var(--color-text-tertiary);
  background: var(--color-surface);
  box-shadow: inset 0 0 0 3px var(--color-text-tertiary);
}

.playlist-item.is-group + .playlist-item.is-group {
  margin-top: var(--spacing-xs);
}

/* Solid 4px end-of-cue warning border. Inset overlay sitting above the
   waveform/progress layers (z-index 10) and pinned inside the item box so it
   cannot be clipped by the scroll container. */
.warning-border {
  position: absolute;
  inset: 0;
  z-index: 10;
  pointer-events: none;
  border: 4px solid transparent;
  border-radius: var(--border-radius-sm);

  /* Increase the pulse rate as this cue approaches its end. */
  &.warning-border--yellow {
    border-color: rgb(255, 193, 7);
    animation: warning-border-flash 2s ease-in-out infinite;
  }

  &.warning-border--orange {
    border-color: rgb(255, 152, 0);
    animation: warning-border-flash 1s ease-in-out infinite;
  }

  &.warning-border--red {
    border-color: rgb(244, 67, 54);
    animation: warning-border-flash 0.5s ease-in-out infinite;
  }
}

@keyframes warning-border-flash {
  0%, 100% { opacity: 0; }
  50% { opacity: 1; }
}

.waveform-canvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 1;
  color: var(--waveform-color, var(--color-text-primary));
  opacity: var(--playlist-waveform-opacity, 0.1);
}

.playlist-item.is-playing > .waveform-canvas {
  opacity: var(--playlist-waveform-opacity, 0.1);
}

.item-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 3px;
  transition: width 100ms linear;
  pointer-events: none;
  z-index: 2;
  background: var(--state-playing);
}

.playlist-item.is-paused .item-progress {
  background: var(--color-text-tertiary);
}

.item-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px var(--spacing-md);
  min-height: var(--current-playlist-row-height);
  scroll-margin-top: var(--current-playlist-row-height);
  position: relative;
  z-index: 5;
  cursor: pointer;
}

.playlist-item:not(.show-mode) > .item-content {
  cursor: grab;
}

.playlist-item:not(.show-mode) > .item-content:active,
.playlist-item:not(.show-mode).is-dragging > .item-content {
  cursor: grabbing;
}

.playlist-item:not(.show-mode).is-dragging {
  opacity: 0.62;
}

.item-color-rail {
  position: absolute;
  inset: 0 auto 0 0;
  width: 4px;
  z-index: 6;
  pointer-events: none;
}

.item-left {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) max-content max-content max-content max-content var(--cue-time-width, 96px) var(--playlist-set-next-width, 92px);
  grid-template-areas: 'expand identity state video actions transport duration arm';
  align-items: center;
  gap: var(--spacing-sm);
  flex: 1;
  z-index: 5;
  min-width: 0;
}

.expand-btn {
  grid-area: expand;
  width: 32px;
  height: 32px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background: var(--color-control);
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.035);
  color: var(--color-text-primary);
  cursor: pointer;

  .material-symbols-rounded {
    font-size: 20px;
  }
  
  &:hover {
    border-color: var(--color-border);
    background: var(--color-control);
    color: var(--color-text-primary);
  }

  &:focus-visible {
    outline: 2px solid var(--color-focus-ring);
    outline-offset: 2px;
  }
}

.item-arm {
  grid-area: arm;
  display: flex;
  align-items: center;
}

.item-identity {
  grid-area: identity;
  display: grid;
  grid-template-columns: var(--cue-number-width, 36px) minmax(0, 1fr) max-content;
  align-items: center;
  gap: 6px;
  min-width: 0;
  width: 100%;
  justify-self: start;
  max-width: 100%;
}

.playlist-item.is-group > .item-content .item-identity {
  grid-template-columns: var(--cue-number-width, 36px) max-content minmax(0, 1fr);
}


.item-index {
  grid-column: 1;
  justify-content: center;
  font-size: var(--cue-text-size);
  font-family: var(--font-sans);
  font-variant-numeric: tabular-nums;
  color: var(--color-text-primary);
}

.item-icon {
  grid-column: 2;
  justify-self: start;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-primary);
  
  .material-symbols-rounded {
    font-size: 20px;
  }
}

.item-name {
  grid-column: 2;
  font-weight: 700;
  font-size: var(--cue-text-size);
  line-height: 1.2;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-primary);
}

/* Opaque cells keep cue text legible at any waveform opacity. */
.item-index,
.item-icon,
.item-name,
.item-duration,
.peak-warning-icon,
.video-badge-icon,
.behavior-icon {
  box-sizing: border-box;
  background-color: color-mix(in srgb, var(--color-control) 92%, var(--color-background));
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
}

.item-index {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  min-height: 26px;
  height: var(--cue-cell-height);
  padding: 2px 4px;
}

.item-icon {
  min-width: 32px;
  min-height: 26px;
  height: var(--cue-cell-height);
  padding: 2px;
}

.item-name {
  display: block;
  align-content: center;
  min-height: 26px;
  height: var(--cue-cell-height);
  width: fit-content;
  max-width: 100%;
  justify-self: start;
  padding: 2px 6px;
}

button.item-name {
  font-family: inherit;
  text-align: start;
  cursor: pointer;
  &:hover { border-color: var(--color-border-strong); }
}

.item-duration {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-height: 26px;
  height: var(--cue-cell-height);
  padding: 2px 6px;
}

.peak-warning-icon,
.video-badge-icon,
.behavior-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  min-height: 26px;
  height: var(--cue-cell-height);
  padding: 3px;
}

.playlist-item.is-audio .item-index,
.playlist-item.is-audio .item-duration,
.playlist-item.is-audio .behavior-icon {
  color: var(--color-text-primary);
  opacity: 0.9;
}

.playlist-item.is-group .item-name {
  grid-column: 3;
  display: block;
  align-content: center;
  font-size: var(--cue-text-size);
  font-weight: 800;
}

.playlist-item.is-audio .item-name {
  grid-column: 2;
}

.playlist-item.is-audio > .item-content :deep(.action-btn--playlist) {
  background-color: var(--color-control);
}

.playlist-item.is-audio .peak-warning-icon {
  grid-column: 3;
}

.playlist-item.is-playing > .item-content .item-name {
  justify-self: start;
  max-width: 100%;
  box-sizing: border-box;
  color: var(--color-text-primary);
}

.playlist-item.is-paused > .item-content .item-name {
  color: var(--color-text-primary);
}

.peak-warning-icon {
  grid-column: 3;
  font-size: 18px;
  color: var(--color-danger);
  flex-shrink: 0;
  cursor: default;
  line-height: 1;
}

/* Video cue badge: a compact text cell that stays legible at a glance. */
.video-badge-icon {
  grid-area: video;
  justify-self: start;
  justify-content: center;
  min-width: 38px;
  min-height: 26px;
  height: var(--cue-cell-height);
  padding: 2px 4px;
  font-family: var(--font-sans);
  font-size: var(--cue-text-size);
  font-weight: 700;
  letter-spacing: 0.04em;
  /* Neutral: red on a row means it is live. Only a failed check turns red. */
  color: var(--color-text-secondary);
  border-color: var(--color-border-strong);
  flex-shrink: 0;
  cursor: default;
  line-height: 1;
}
.video-badge-icon--failed {
  background: color-mix(in srgb, var(--color-danger) 20%, var(--color-control));
  border-color: var(--color-danger);
  color: var(--color-danger);
}

.item-state {
  grid-area: state;
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--spacing-xs);
  min-width: 0;
}

.item-duration {
  grid-area: duration;
  justify-self: end;
  font-family: var(--font-sans);
  font-size: calc(var(--cue-cell-height) - 4px);
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-primary);
  margin: 0;
  white-space: nowrap;
  /* Fixed-width, right-aligned column so the leading "-" shown during the
     playing countdown widens the text without shoving the flags around, and
     so the duration lines up vertically from row to row. */
  min-width: min(3.5em, var(--cue-time-width, 96px));
  text-align: right;
  flex-shrink: 0;
}

.behavior-indicators {
  display: flex;
  flex-wrap: nowrap;
  gap: 2px;
  align-items: center;
  flex-shrink: 0;

  .behavior-icon {
    font-size: 14px;
    color: var(--color-text-primary);
    opacity: 1;
  }

  .behavior-icon-segue {
    color: var(--state-up-next);
    opacity: 1;
  }
}

.status-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: var(--pill-radius);
  font-size: var(--cue-text-size);
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
  height: 22px;

  &.playing {
    background-color: var(--state-playing);
    color: var(--state-playing-on);
  }


  &.paused {
    border: 1px solid var(--color-text-tertiary);
    background-color: var(--color-control);
    color: var(--color-text-primary);
  }

  &.preview {
    background-color: var(--state-preview);
    color: var(--color-text-on-accent);
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
}

.item-actions {
  grid-area: actions;
  display: grid;
  grid-template-columns: repeat(2, 32px);
  gap: var(--spacing-xs);
  justify-self: end;
  z-index: 5;
  flex-shrink: 0;
}

.item-left :deep(.action-btn--playlist) {
  height: var(--cue-cell-height);
  min-height: 32px;
}

.item-left :deep(.set-next-action.action-btn--playlist) {
  width: var(--playlist-set-next-width, 92px);
  min-width: var(--playlist-set-next-width, 92px);
  gap: 5px;
  font-family: var(--font-sans);
  font-size: var(--cue-text-size);
}


.item-left :deep(.set-next-action[aria-current='true']:not(.action-btn--active)) {
  border-color: var(--state-up-next);
  color: var(--color-text-primary);

  .action-label-default { display: inline; }
}

.preview-action { grid-area: expand; }

/* The leading lane stays in the grid (groups keep their arrow there); a cue
   with no headphones button lets its number and title slide into it. */
.playlist-item.no-preview-lane > .item-content .item-identity {
  --freed-lane: calc(var(--cue-leading-width, 34px) + var(--row-lane-gap, var(--spacing-sm)));
  margin-left: calc(-1 * var(--freed-lane));
  width: calc(100% + var(--freed-lane));
  max-width: none;
}

.group-shuffle-action {
  grid-area: video;
  justify-self: end;
}

/* Show Mode: the button's place without the button. */
.group-shuffle-action--place {
  width: 32px;
  height: 32px;
}

.group-shuffle-action:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.item-transport {
  grid-area: transport;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--spacing-xs);
  min-width: 0;
}

.play-action,
.group-music-toggle { flex-shrink: 0; }
/* Delete sits away from Play, with Edit between them, and is offered only on
   a selected row: the row a stray click lands on is rarely the selected one. */
.delete-action { grid-column: 1; grid-row: 1; }
.edit-action { grid-column: 2; grid-row: 1; }
/* An unselected row gives Delete's place back to the title. */
.delete-action--parked { display: none; }
.item-actions--single { grid-template-columns: 32px; }
.item-actions--single .edit-action { grid-column: 1; }

/* The note reads as an aside to the title, not as part of the name. */
.item-note {
  margin-inline-start: 0.6em;
  color: var(--color-text-secondary);
  font-weight: 400;
  font-size: 0.86em;
}

.item-note::before {
  content: '— ';
  color: var(--color-text-tertiary);
}

.item-name--editing {
  width: 100%;
  min-width: 12ch;
  padding: 2px 6px;
  border: 1px solid var(--color-accent);
  border-radius: var(--control-radius);
  background: var(--color-control);
  color: var(--color-text-primary);
  font: inherit;
  cursor: text;
}

.item-name--editing:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

/* Search hit: a ring just inside the row's own edge, so the red of a live row
   and the green of Up Next still show around it. The focus-ring colour, not the
   accent: an operator may pick a red, green or yellow accent, and those colours
   mean live, Up Next and warning here. */
.playlist-item.is-search-hit > .item-content {
  outline: 3px solid var(--color-focus-ring);
  outline-offset: -6px;
}

.playlist-item:not(.show-mode) .item-actions,
.playlist-item:not(.show-mode) .item-arm {
  opacity: 1;
  transition: opacity var(--transition-fast);
}

.playlist-item:not(.show-mode):hover .item-actions,
.playlist-item:not(.show-mode):hover .item-arm,
.playlist-item:not(.show-mode) .item-actions:focus-within,
.playlist-item:not(.show-mode) .item-arm:focus-within {
  opacity: 1;
}

.no-device {
  opacity: 1;
  color: var(--color-text-disabled);
}

.group-children {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 2px;
}

.playlist-item > .group-children {
  padding-left: var(--spacing-md);
}

.playlist-item.is-group > .item-content .expand-btn {
  /* Keep the arrow aligned to the child rail without covering the number. */
  transform: translateX(min(10px, calc(2px + var(--folder-column-gap, var(--spacing-sm)))));
}

/* Show Mode is Edit Mode with the editing taken out: the same rows, at the
   same size, in the same places. The one difference in how a row is drawn is
   the pointer, because a row there is a playback surface and not something
   to select or drag. */
.playlist-item.show-mode .item-content {
  cursor: default;
}

/* A row is one line at every width: when the side panels leave less room,
   the title is cut short (its full text is the tooltip, and the Play Next
   and live boxes show it whole). Nothing moves to a second line. */

@container playlist-scroll (max-height: 220px) {
  /* A pinned group would cover most of a short playlist. */
  .playlist-item.is-sticky-group > .item-content {
    position: relative;
  }
}
</style>
