<template>
  <div
    class="playlist-item"
    :data-item-uuid="item.uuid"
    :class="{
      'is-selected': isSelected,
      'is-group': item.type === 'group',
      'is-sticky-group': item.type === 'group' && isExpanded && depth === 0,
      'is-audio': item.type === 'audio',
      'is-playing': isPlaying,
      'show-mode': showMode,
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
      :draggable="!showMode"
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
            v-if="showMode"
            class="play-action"
            :icon="isPlaying ? 'stop' : 'play_arrow'"
            :highlight-color="isPlaying ? 'var(--color-danger)' : (item.type === 'group' ? 'var(--folder-play-action)' : 'var(--state-playing)')"
            :is-active="isPlaying"
            context="Playlist"
            @click.stop="isPlaying ? handleStop() : handlePlay()"
            :title="isPlaying ? t('actions.stop') : t('actions.play')"
          />
          <ActionButton
            v-else
            class="set-next-action"
            icon="fast_forward"
            :highlight-color="item.type === 'group' ? 'var(--folder-next-action)' : 'var(--state-up-next)'"
            active-text-color="black"
            :is-active="isManuallyQueued"
            context="Playlist"
            @click.stop="handleSetAsNext"
            :title="t('actions.setAsNext')"
            :aria-label="t('actions.setAsNext')"
            :aria-pressed="isManuallyQueued"
          />
        </div>

        <div class="item-identity">
          <span class="item-index">{{ indexDisplay }}</span>

          <span v-if="item.type === 'group'" class="item-icon">
            <span class="material-symbols-rounded" aria-hidden="true">folder</span>
          </span>

          <span class="item-name" :title="item.displayName">{{ item.displayName }}</span>
          <span
            v-if="isPeaking"
            class="material-symbols-rounded peak-warning-icon"
            :title="t('properties.peakWarning')"
            role="img"
            :aria-label="t('properties.peakWarning')"
            draggable="false"
            @click.stop
          >bomb</span>
          <span
            v-if="item.type === 'audio' && item.hasVideo"
            class="material-symbols-rounded video-badge-icon"
            :title="t('playlist.videoCue')"
            role="img"
            :aria-label="t('playlist.videoCue')"
            draggable="false"
            @click.stop
          >movie</span>
        </div>

        <div class="item-state">
          <span v-if="isPlaying" class="status-pill playing">{{ t('status.playing') }}</span>
          <span v-else-if="isQueuedNext" class="status-pill up-next">{{ t('status.upNext') }}</span>
          <ActionButton
            v-if="isPlaying && item.type === 'audio'"
            class="restart-action"
            icon="restart_alt"
            highlight-color="var(--state-playing)"
            context="Playlist"
            type="button"
            @click.stop="handlePlay"
            :title="t('actions.restartCue', { name: item.displayName })"
            :aria-label="t('actions.restartCue', { name: item.displayName })"
          />
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
              v-if="item.endBehavior?.action === 'next'"
              class="material-symbols-rounded behavior-icon"
              :title="t('behaviors.endPlayNext')"
            >skip_next</span>
            <span
              v-else-if="item.endBehavior?.action === 'goto-item'"
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
        </div>

        <span v-if="item.type === 'audio'" class="item-duration">{{ durationDisplay }}</span>

        <!-- In Show Mode the live-playback actions (play/stop, set-as-next)
             and preview remain — preview is useful pre-show too; edit and
             delete are edit affordances and stay hidden so the row is a big,
             safe touch target. -->
        <div class="item-actions">
          <ActionButton
            v-if="item.type === 'audio'"
            class="preview-action"
            :icon="'headphones'"
            highlight-color="var(--state-preview)"
            :is-active="isPreviewing"
            :class="{ 'no-device': !hasPreviewDevice }"
            context="Playlist"
            @click.stop="isPreviewing ? handleStopPreview() : handleStartPreview()"
            :title="isPreviewing ? t('actions.stopPreview') : (hasPreviewDevice ? t('actions.preview') : t('actions.previewNoDevice'))"
          />
          <ActionButton
            v-if="showMode"
            class="set-next-action"
            icon="fast_forward"
            :highlight-color="item.type === 'group' ? 'var(--folder-next-action)' : 'var(--state-up-next)'"
            active-text-color="black"
            :is-active="isManuallyQueued"
            context="Playlist"
            @click.stop="handleSetAsNext"
            :title="t('actions.setAsNext')"
            :aria-label="t('actions.setAsNext')"
            :aria-pressed="isManuallyQueued"
          />
          <ActionButton
            v-else
            class="play-action"
            :icon="isPlaying ? 'stop' : 'play_arrow'"
            :highlight-color="isPlaying ? 'var(--color-danger)' : (item.type === 'group' ? 'var(--folder-play-action)' : 'var(--state-playing)')"
            :is-active="isPlaying"
            context="Playlist"
            @click.stop="isPlaying ? handleStop() : handlePlay()"
            :title="isPlaying ? t('actions.stop') : t('actions.play')"
          />
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
import type { AudioItem, GroupItem, BaseItem } from '~/types/project';
import ActionButton from './ActionButton.vue';
import { useOutputTarget, METER_COLORS } from '~/composables/useOutputTarget';
import { exceedsTruePeakCeiling } from '~/utils/audio';
import { cloneAsPlaylistItem } from '~/utils/oneShots';

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
  saveProject,
  updateIndices,
  waveformUpdateKey,
  triggerWaveformUpdate,
  formatItemIndex,
} = useProject();

// mm:ss position of the Start Next marker, for the badge tooltip.
const formatMarkerTime = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};
const { levels: outputTargetLevels } = useOutputTarget();
const { playCue, stopCue, activeCues, activeGroups, triggerGroup, nextItemOverrideUuid, autoNextItemUuid, setNextItem } = useAudioEngine();
const { t } = useLocalization();
const { uiMode } = useUiMode();

// Show Mode strips edit affordances (preview/edit/delete + drag) and scales the
// row up for touch, while keeping waveform, colour, duration, behaviour flags
// and warnings identical to edit mode.
const showMode = computed(() => uiMode.value === 'playback');

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

const isSelected = computed(() => selectedItems.value.has(props.item.uuid));
const isPlaying = computed(() => activeCues.value.has(props.item.uuid));
// Manual override — drives the button highlight and toggle behaviour
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

  // Keep the cue hue while narrowing the luminance range between very bright
  // and very dark user colours. CSS resolves the mix for Canvas, so no second
  // colour parser can drift from the row styling.
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

// Helper to convert hex to rgba
const hexToRgba = (hex: string, alpha: number) => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const itemStyle = computed(() => {
  const depthOffset = props.depth > 0 ? 24 : 0;
  // Playing audio keeps the same cue tint as idle audio. Playback state is
  // already conveyed by the title, status, controls, waveform, and progress.
  const backgroundColor = isGroupPlaying.value
    ? hexToRgba(props.item.color, 0.5)
    : hexToRgba(props.item.color, 0.14);
  const styles: any = {
    marginLeft: showMode.value ? '0px' : `${depthOffset}px`,
    '--item-depth-offset': `${depthOffset}px`,
    '--item-background': backgroundColor,
    '--waveform-color': `color-mix(in srgb, ${props.item.color} 40%, #687386)`,
    '--folder-background': props.item.type === 'group'
      ? `color-mix(in srgb, ${props.item.color} 50%, var(--color-background))`
      : backgroundColor,
    backgroundColor,
  };
  return styles;
});

const progressStyle = computed(() => {
  return {
    width: `${playbackProgress.value}%`,
    backgroundColor: 'var(--color-danger)',
  };
});

const handleSelect = (event: MouseEvent) => {
  // Rows are not selectable in Show Mode — it's a playback surface, not an
  // editing list, and selection drives edit-only affordances (properties
  // panel, delete) that are already hidden here.
  if (showMode.value) return;
  toggleItemSelection(props.item.uuid, event.ctrlKey || event.metaKey, event.shiftKey);
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

const handleSetAsNext = () => {
  if (isManuallyQueued.value) {
    setNextItem(null);
  } else {
    setNextItem(props.item.uuid);
  }
};

const handleDelete = () => {
  // When this item is part of a multi-selection, defer to the confirm dialog
  // (Delete N Selected / Delete Only this / Cancel). Otherwise fall back to
  // the simple single-item confirmation.
  if (requestDeleteFromButton(props.item.uuid)) return;
  if (confirm(t('actions.confirmDelete', { name: props.item.displayName }))) {
    removeItem(props.item.uuid);
  }
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
      // One Shot targets use this explicit type to treat a playlist drag as
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
  
  const isOneShotCopy = e.dataTransfer.types.includes('one-shot-uuid');
  e.dataTransfer.dropEffect = isOneShotCopy ? 'copy' : 'move';
  
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

  // A One Shot dragged back into the playlist creates a normal playlist cue
  // and leaves the source cell armed. This is intentionally a copy: the live
  // quick-fire surface must not disappear because a tech reorganized a show.
  const oneShotUuid = e.dataTransfer.getData('one-shot-uuid');
  if (oneShotUuid) {
    if (oneShotUuid === props.item.uuid) return;
    const source = findItemByUuid(oneShotUuid);
    if (!source || source.type !== 'audio') return;
    insertPlaylistCloneAtTarget(
      cloneAsPlaylistItem(source as AudioItem, crypto.randomUUID()),
      e,
    );
    return;
  }

  // A cart slot dragged onto the playlist → promote it to an independent
  // playlist item (fresh uuid) and free the cart slot. A cart cue is a
  // self-contained copy, so this mirrors the playlist→cart clone in reverse
  // (rather than sharing one identity across both lists). Detected via the
  // 'cart-slot' payload that only CartSlot sets.
  if (e.dataTransfer.getData('cart-slot')) {
    const cartUuid = e.dataTransfer.getData('item-uuid');
    const cartSrc = findItemByUuid(cartUuid);
    if (!cartSrc || cartSrc.type !== 'audio') return;

    const clone: AudioItem = { ...(cartSrc as AudioItem), uuid: crypto.randomUUID() } as AudioItem;

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - rect.top;
    const height = rect.height;
    const { updateIndices, deleteCartItems } = useProject();

    if (props.item.type === 'group' && y > height * 0.3 && y < height * 0.7) {
      const groupItem = props.item as GroupItem;
      groupItem.children.push(clone);
      updateIndices(groupItem.children, groupItem.index);
    } else {
      const insertAfter = y >= height / 2;
      let parentArray = currentProject.value.items;
      let parentIndex: number[] = [];
      if (props.item.index.length > 1) {
        const parentGroup = findItemByIndex(props.item.index.slice(0, -1));
        if (parentGroup && parentGroup.type === 'group') {
          parentArray = (parentGroup as GroupItem).children;
          parentIndex = (parentGroup as GroupItem).index;
        }
      }
      const pos = parentArray.findIndex(i => i.uuid === props.item.uuid);
      parentArray.splice(insertAfter ? pos + 1 : pos, 0, clone);
      updateIndices(parentArray, parentIndex);
    }

    // Unassign the originating cart slot (also persists via saveProject).
    deleteCartItems([cartUuid]);
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
  --folder-play-action: color-mix(in srgb, var(--state-playing) 82%, var(--color-accent));
  --folder-next-action: color-mix(in srgb, var(--state-up-next) 84%, var(--color-accent));
  border-radius: var(--border-radius-sm);
  margin-bottom: 0;
  transition:
    background-color var(--transition-fast),
    box-shadow var(--transition-fast);
  position: relative;
  overflow: hidden;
  scroll-margin-top: var(--current-playlist-row-height);

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
    box-shadow: inset 3px 0 0 var(--color-accent);
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

  /* Blink rates mirror the ProjectHeader silence-warning banner so the border
     and banner pulse in sync (yellow ≤30s, orange ≤10s, red ≤5s). */
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
  opacity: max(var(--playlist-waveform-opacity, 0.1), 0.65);
}

.item-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 3px;
  transition: width 100ms linear;
  pointer-events: none;
  z-index: 2;
}

.item-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px var(--spacing-md);
  min-height: var(--current-playlist-row-height);
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
  grid-template-columns: 34px minmax(112px, 1fr) minmax(0, max-content) 64px max-content 32px;
  grid-template-areas: 'expand identity state duration actions arm';
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
  border: 1px solid transparent;
  border-radius: var(--control-radius);
  background: transparent;
  color: var(--color-text-secondary);
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
  grid-template-columns: 40px minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.playlist-item.is-audio .item-identity {
  grid-template-columns: 40px minmax(0, 1fr) auto;
}

.item-index {
  grid-column: 1;
  justify-self: start;
  font-size: 12px;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--color-text-secondary);
}

.item-icon {
  grid-column: 1;
  justify-self: end;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  
  .material-symbols-rounded {
    font-size: 20px;
  }
}

.item-name {
  grid-column: 2;
  font-weight: 700;
  font-size: var(--type-track-size);
  line-height: 1.2;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-primary);
}

.playlist-item.is-audio .item-name,
.playlist-item.is-audio .item-index,
.playlist-item.is-audio .item-duration,
.playlist-item.is-audio .behavior-icon,
.playlist-item.is-audio .peak-warning-icon,
.playlist-item.is-audio .video-badge-icon {
  text-shadow:
    0 2px 3px rgba(0, 0, 0, 0.95),
    0 0 7px rgba(0, 0, 0, 0.72);
}

.playlist-item.is-audio .item-index,
.playlist-item.is-audio .item-duration,
.playlist-item.is-audio .behavior-icon {
  color: var(--color-text-primary);
  opacity: 0.9;
}

.playlist-item.is-group .item-name {
  font-size: calc(var(--type-track-size) + 1px);
  font-weight: 800;
}

.playlist-item.is-audio .item-name {
  grid-column: 2;
}

.playlist-item.is-audio > .item-content :deep(.action-btn--playlist) {
  background-color: var(--color-control);
  box-shadow:
    inset 0 1px rgba(255, 255, 255, 0.035),
    0 2px 3px rgba(0, 0, 0, 0.85),
    0 0 7px rgba(0, 0, 0, 0.55);
}

.playlist-item.is-audio > .item-content :deep(.action-btn--playlist .material-symbols-rounded) {
  text-shadow:
    0 2px 3px rgba(0, 0, 0, 0.95),
    0 0 7px rgba(0, 0, 0, 0.72);
}

.playlist-item.is-audio .peak-warning-icon {
  grid-column: 3;
}

.playlist-item.is-playing > .item-content .item-name {
  justify-self: start;
  max-width: 100%;
  box-sizing: border-box;
  padding: 2px 6px;
  border-radius: var(--control-radius);
  color: var(--color-danger);
  background: color-mix(in srgb, var(--color-background) 88%, transparent);
}

.peak-warning-icon {
  grid-column: 3;
  font-size: 18px;
  color: var(--color-danger);
  flex-shrink: 0;
  cursor: default;
  line-height: 1;
}

/* Video cue badge: column 4 in the identity grid. When the peak warning is
   absent its auto column collapses to zero width, so the badge still sits
   flush after the cue name. */
.video-badge-icon {
  grid-column: 4;
  font-size: 18px;
  color: var(--color-accent);
  flex-shrink: 0;
  cursor: default;
  line-height: 1;
}

.item-state {
  grid-area: state;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-xs);
  min-width: 0;
}

.item-duration {
  grid-area: duration;
  justify-self: end;
  font-family: var(--font-mono);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-secondary);
  margin: 0;
  white-space: nowrap;
  /* Fixed-width, right-aligned column so the leading "-" shown during the
     playing countdown widens the text without shoving the flags around, and
     so the duration lines up vertically from row to row. */
  min-width: 3.5em;
  text-align: right;
  flex-shrink: 0;
}

.behavior-indicators {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  align-items: center;
  flex-shrink: 0;

  .behavior-icon {
    font-size: 14px;
    color: var(--color-text-secondary);
    opacity: 0.7;
  }

  .behavior-icon-segue {
    color: var(--state-up-next);
    opacity: 0.9;
  }
}

.status-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: var(--pill-radius);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
  height: 22px;

  &.playing {
    background-color: var(--state-playing);
    color: black;
  }

  &.up-next {
    background-color: var(--state-up-next);
    color: black;
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
  grid-template-columns: repeat(4, 32px);
  gap: var(--spacing-xs);
  z-index: 5;
  flex-shrink: 0;
}

.preview-action { grid-column: 1; }
.play-action { grid-column: 2; }
.edit-action { grid-column: 3; }
.delete-action { grid-column: 4; }

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

.playlist-item:not(.show-mode) > .group-children {
  padding-left: var(--spacing-md);
}

.playlist-item:not(.show-mode).is-group > .item-content .expand-btn {
  transform: translateX(10px);
}

/* Keep every control available when the resizable playlist is narrow. The
   lanes remain fixed, but state and transport move to a second console row. */
@container (max-width: 560px) {
  .item-left {
    grid-template-columns: 34px minmax(0, 1fr) max-content 32px;
    grid-template-areas:
      'expand identity duration arm'
      'state state actions actions';
    row-gap: var(--spacing-xs);
  }

  .item-state {
    min-height: 32px;
  }
}

/* ------------------------------------------------------------------ */
/* Show Mode — larger, touch-friendly rows. Same content, bigger hit  */
/* areas: taller rows, bigger name/duration text, and chunky play/    */
/* stop / set-next buttons. Waveform, colour tint, flags and warnings  */
/* are untouched so the row still reads exactly like the editor.       */
/* ------------------------------------------------------------------ */
.playlist-item.show-mode {
  --current-playlist-row-height: var(--show-playlist-row-height, 68px);

  .item-content {
    padding: 6px var(--spacing-md);
  }

  .item-color-rail {
    left: var(--item-depth-offset, 0px);
  }

  &.is-group {
    --current-playlist-row-height: var(--folder-playlist-row-height, 60px);
  }

  .item-left {
    grid-template-columns: 44px 88px minmax(0, 1fr) max-content 64px max-content;
    grid-template-areas: 'expand arm identity state duration actions';
    gap: var(--spacing-sm);
  }

  .expand-btn {
    width: 44px;
    height: 44px;

    .material-symbols-rounded {
      font-size: 24px;
    }
  }

  &.is-group .expand-btn {
    transform: translateX(-8px);
  }

  .item-identity {
    grid-template-columns: 44px minmax(0, 1fr) auto;
    gap: var(--spacing-sm);
  }

  &.is-audio .item-identity {
    grid-template-columns: 44px minmax(0, 1fr) auto;
  }

  .item-index {
    font-size: 14px;
  }

  .item-icon .material-symbols-rounded {
    font-size: 22px;
  }

  .item-name {
    font-size: var(--type-track-show-size);
  }

  &.is-group .item-name {
    font-size: calc(var(--type-track-show-size) + 1px);
  }

  &.is-audio .item-name {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-height: 1.12;
    white-space: normal;
  }

  .item-duration {
    font-size: 18px;
  }

  .status-pill {
    font-size: 13px;
    height: 28px;
    padding: 2px 10px;
  }

  .behavior-icon {
    font-size: 18px;
  }

  /* Enlarge the remaining action buttons (preview, play/stop, set-next) for
     touch — double width vs. height so they're easier to hit without
     misjudging horizontal position. :deep() reaches into the ActionButton
     child component's root. */
  :deep(.action-btn--playlist) {
    width: 88px;
    height: 48px;
    flex-shrink: 0;

    .material-symbols-rounded {
      font-size: 24px;
    }
  }

  :deep(.restart-action.action-btn--playlist) {
    width: 40px;
    height: 40px;

    .material-symbols-rounded {
      font-size: 20px;
    }
  }

  .item-actions {
    grid-template-columns: repeat(2, 88px);
    gap: var(--spacing-sm);

    .set-next-action {
      grid-column: 2;
    }
  }

  /* Not selectable — row is a playback surface, not a list to click into. */
  .item-content {
    cursor: default;
  }
}

@container (max-width: 620px) {
  .playlist-item.show-mode .item-left {
    grid-template-columns: 44px 88px minmax(0, 1fr) max-content;
    grid-template-areas:
      'expand arm identity duration'
      'state state state actions';
    row-gap: var(--spacing-sm);
  }
}
</style>
