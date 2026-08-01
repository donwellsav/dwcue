<template>
  <div class="playback-controls" :class="{ 'show-mode': showMode }">
    <button
      type="button"
      class="control-btn panic-btn"
      @click="handlePanic"
      :disabled="activeCues.size === 0"
      :title="stopAllTooltip"
    >
      <span class="icon" aria-hidden="true">⚠</span>
      <span>{{ t('playback.panic') }}</span>
    </button>
    
    <div class="active-cues">
      <div v-if="activeCues.size === 0 && !previewingItem" class="no-cues">
        {{ t('playback.noActiveCues') }}
      </div>

      <div v-else class="cue-list">
        <!-- Preview card: styled identically to ActiveCueItem, with a blue
             "Preview" pill at the start of the name. Meter reads master
             channels 30/31 (the preview output bus). Seek + time come from
             the per-cue meter stream (playhead_seconds). -->
        <div v-if="previewingItem" class="preview-cue-card">
          <div class="preview-cue-content">
            <div class="preview-cue-header">
              <span class="preview-cue-name" :title="previewingItem.displayName">
                <span class="preview-status-pill">{{ t('status.previewing') }}</span>
                {{ previewingItem.displayName }}
              </span>
              <div class="preview-cue-actions">
                <button
                  type="button"
                  class="preview-stop-btn"
                  @click="stopPreview"
                  :title="t('actions.stopPreview')"
                  :aria-label="t('actions.stopPreview')"
                >
                  <span class="material-symbols-rounded" aria-hidden="true">stop</span>
                </button>
              </div>
            </div>

            <div class="preview-cue-progress">
              <div class="preview-time-info">
                <span>{{ formatPreviewTime(previewCurrentTime) }}</span>
                <span>-{{ formatPreviewTime(previewDuration - previewCurrentTime) }}</span>
              </div>
              <div class="preview-progress-bar">
                <div class="preview-progress-fill" :style="{ width: previewProgressPct + '%' }"></div>
                <input
                  type="range"
                  class="preview-progress-slider"
                  min="0"
                  :max="previewDuration"
                  step="0.1"
                  :value="previewSeekValue"
                  :aria-label="`${t('status.previewing')}: ${previewingItem.displayName}`"
                  :aria-valuetext="`${formatPreviewTime(previewSeekValue)} / ${formatPreviewTime(previewDuration)}`"
                  @input="handlePreviewSeek"
                />
              </div>
            </div>
          </div>
          <div class="preview-cue-meter">
            <StereoMeter :left-index="30" :right-index="31" :min-db="-60" :max-db="0" />
          </div>
        </div>

        <ActiveCueItem
          v-for="[uuid, cue] in Array.from(activeCues.entries())"
          :key="uuid"
          :cue="cue"
        />
      </div>
    </div>

    <button
      type="button"
      class="control-btn play-next-btn"
      :class="{ 'has-next': !!effectiveNextUuid }"
      @click="handlePlayNext"
      :disabled="!effectiveNextUuid"
      :title="playNextTooltip"
    >
      <span class="material-symbols-rounded" aria-hidden="true">fast_forward</span>
      <span>{{ t('controls.playNext') }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
// PlaybackControls migration (Milestone 5):
//   * Panic / stop-all now fans out to BOTH the legacy useAudioEngine
//     (until every component is migrated away from it) AND the new C++
//     server via useLiveplayServer().stopAll(). Removing the legacy call
//     is safe once all play paths route through the server.
import { formatKeyLabel } from '~/composables/useCartHotkeys';
import type { AudioItem } from '~/types/project';
import { useLiveplayServer } from '~/composables/useLiveplayServer';
import { useCueMeters } from '~/composables/useLiveMeters';

const { activeCues, panicStop, nextItemOverrideUuid, autoNextItemUuid, setNextItem, playCue, triggerGroup } = useAudioEngine();
const { findItemByUuid, previewItemUuid, previewCueId, stopPreview } = useProject();
const { playbackMappings } = useCartHotkeys();
const { t } = useLocalization();
const server = useLiveplayServer();
const { uiMode } = useUiMode();
// Show Mode enlarges the GO / Stop-All buttons for touch.
const showMode = computed(() => uiMode.value === 'playback');

// ---- Preview seek / time --------------------------------------------------
// Subscribe to the preview cue's per-item meter stream so we can display an
// accurate playhead, elapsed time, and remaining time in the preview card.
const previewMeter = useCueMeters(() => previewCueId.value || null);
const previewCurrentTime = computed(() => previewMeter.playhead.value);
const previewDuration = computed(() => {
  if (!previewingItem.value) return 0;
  const item = previewingItem.value as any;
  const inPoint  = item.inPoint  ?? 0;
  const outPoint = item.outPoint ?? item.duration ?? 0;
  return Math.max(0, outPoint - inPoint);
});
const previewSeekValue = computed(() => Math.max(
  0,
  Math.min(previewDuration.value, previewCurrentTime.value),
));
const previewProgressPct = computed(() => {
  if (!previewDuration.value) return 0;
  return (previewSeekValue.value / previewDuration.value) * 100;
});

function formatPreviewTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
}

function handlePreviewSeek(e: Event) {
  if (!previewCueId.value || !previewDuration.value) return;
  const seekTo = Number((e.currentTarget as HTMLInputElement).value);
  if (!Number.isFinite(seekTo)) return;
  const item = previewingItem.value as any;
  const inPoint = item?.inPoint ?? 0;
  server.seekCueId(previewCueId.value, Math.max(0, seekTo + inPoint));
}

// Preview pill data: when an item is being pre-listened on the headphone bus,
// this resolves to the item record so we can render its display name.
const previewingItem = computed(() => {
  const uuid = previewItemUuid.value;
  if (!uuid) return null;
  return findItemByUuid(uuid);
});

const effectiveNextUuid = computed(() => nextItemOverrideUuid.value ?? autoNextItemUuid.value);

const playNextTooltip = computed(() => {
  const binding = playbackMappings.value['play-next'];
  const shortcut = binding ? formatKeyLabel(binding) : '';
  return shortcut ? `${t('controls.playNext')} (${shortcut})` : t('controls.playNext');
});

const stopAllTooltip = computed(() => {
  const binding = playbackMappings.value['stop-all'];
  const shortcut = binding ? formatKeyLabel(binding) : '';
  return shortcut ? `${t('playback.panic')} (${shortcut})` : t('playback.panic');
});

const handlePanic = () => {
  // Stop everything, fading over the project-wide Stop All time
  // (settings.stopAllFadeMs, default 1 s; set to 0 for an instant panic).
  // panicStop() forwards to the server with no explicit fade so the server
  // applies that project setting.
  panicStop();
};

const handlePlayNext = () => {
  const uuid = effectiveNextUuid.value;
  if (!uuid) return;
  const item = findItemByUuid(uuid);
  if (!item) return;
  if (nextItemOverrideUuid.value) setNextItem(null);
  if (item.type === 'audio') playCue(item as AudioItem);
  else if (item.type === 'group') triggerGroup(item);
};
</script>

<style scoped>
.playback-controls {
  flex: 0 0 var(--playback-controls-height);
  height: var(--playback-controls-height);
  border-bottom: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-sm) var(--spacing-md);
  background-color: var(--color-surface);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--color-border) 45%, transparent);
}

/* Show Mode — bigger GO / Stop-All buttons. */
.playback-controls.show-mode {
  min-height: calc(var(--playback-controls-height) + 20px);

  .control-btn {
    flex-basis: 148px;
    padding: var(--spacing-lg) var(--spacing-xl);
    font-size: 17px;

    .material-symbols-rounded,
    .icon {
      font-size: 26px;
    }
  }

  .preview-cue-header {
    font-size: 16px;
  }

  .preview-stop-btn {
    width: 32px;
    height: 32px;
    font-size: 24px;
  }
}

.control-btn {
  display: flex;
  align-items: center;
  align-self: stretch;
  flex: 0 0 124px;
  gap: var(--spacing-sm);
  min-width: 124px;
  justify-content: center;
  padding: var(--spacing-md) var(--spacing-lg);
  background-color: var(--color-control);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--color-text-primary) 7%, transparent),
    0 1px 2px rgba(0, 0, 0, 0.12);
  font-size: 13px;
  font-weight: 650;
  
  &:hover:not(:disabled) {
    background-color: var(--color-surface-hover);
    border-color: var(--color-border-strong);
  }
  
}

.play-next-btn {
  color: var(--color-text-secondary);

  &.has-next {
    background-color: var(--state-up-next);
    border-color: var(--state-up-next);
    color: #171b25;

    &:hover:not(:disabled) {
      background-color: var(--state-up-next);
      border-color: var(--state-up-next);
      filter: brightness(1.06);
    }
  }
}

.panic-btn {
  background-color: var(--color-danger);
  border-color: var(--color-danger);
  color: white;
  font-weight: 600;

  &:hover:not(:disabled) {
    background-color: var(--color-danger);
    border-color: var(--color-danger);
    filter: brightness(0.9);
  }
}

.icon {
  font-size: 20px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.active-cues {
  flex: 1;
  align-self: stretch;
  display: flex;
  align-items: stretch;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  padding: var(--spacing-xs);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background-color: var(--color-control);
  box-shadow:
    inset 0 1px 4px rgba(0, 0, 0, 0.18),
    0 1px 0 color-mix(in srgb, var(--color-text-primary) 5%, transparent);
}

.no-cues {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: var(--spacing-md);
  border: 1px dashed var(--color-border);
  border-radius: var(--border-radius-sm);
}

.no-cues::before {
  content: '';
  width: 7px;
  height: 7px;
  border: 1px solid currentColor;
  border-radius: 50%;
  opacity: 0.65;
}

.cue-list {
  display: flex;
  flex-direction: row;
  align-items: stretch;
  gap: var(--spacing-sm);
  min-width: 0;
  width: 100%;
  height: 100%;
}

.cue-list > :deep(.active-cue-item) {
  flex: 1 1 0;
  min-width: min(280px, 100%);
  max-width: none;
}

/* Preview card — same card dimensions and visual structure as ActiveCueItem,
   with a blue "Preview" pill prefixing the name. */
.preview-cue-card {
  background-color: var(--color-surface-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  padding: var(--spacing-sm) var(--spacing-md);
  flex: 1 1 0;
  min-width: min(280px, 100%);
  max-width: none;
  display: flex;
  gap: var(--spacing-sm);
  box-shadow: inset 3px 0 0 var(--state-preview);
}

.preview-cue-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.preview-cue-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm);
}

.preview-cue-name {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-weight: 500;
  flex: 1;
  min-width: 0;
  color: var(--color-text-primary);
  overflow: hidden;
  white-space: nowrap;
  mask-image: linear-gradient(to right, black 80%, transparent 100%);
  -webkit-mask-image: linear-gradient(to right, black 80%, transparent 100%);
}

.preview-status-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: var(--pill-radius);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background-color: var(--state-preview);
  color: var(--color-text-on-accent);
  white-space: nowrap;
  flex-shrink: 0;
}

.preview-cue-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.preview-stop-btn {
  width: 24px;
  height: 24px;
  border-radius: var(--control-radius);
  background-color: var(--color-danger);
  color: white;
  font-size: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border: none;

  &:hover {
    opacity: 0.8;
  }
}

.preview-cue-meter {
  display: flex;
  align-items: stretch;
  flex: 0 0 26px;
}

.preview-cue-progress {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.preview-time-info {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.preview-progress-bar {
  height: 12px;
  background-color: var(--color-surface);
  border-radius: var(--border-radius-sm);
  position: relative;
  direction: ltr;
}

.preview-progress-fill {
  height: 100%;
  background-color: var(--state-preview);
  border-radius: var(--border-radius-sm);
  transition: width 100ms linear;
  pointer-events: none;
}

.preview-progress-slider {
  appearance: none;
  -webkit-appearance: none;
  position: absolute;
  inset: -6px 0;
  width: 100%;
  height: 24px;
  margin: 0;
  background: transparent;
  border-radius: var(--border-radius-sm);
  cursor: pointer;
  direction: ltr;
}

.preview-progress-slider::-webkit-slider-runnable-track {
  height: 12px;
  background: transparent;
}

.preview-progress-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  margin-top: -2px;
  background-color: var(--color-surface-raised);
  border: 2px solid var(--state-preview);
  border-radius: 50%;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}

.preview-progress-slider:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: -2px;
}

.preview-progress-slider:focus-visible::-webkit-slider-thumb {
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--state-preview) 32%, transparent),
    0 1px 3px rgba(0, 0, 0, 0.4);
}
</style>
