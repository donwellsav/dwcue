<template>
  <div 
    class="active-cue-item" 
    :class="{
      'is-paused': cue.isPaused,
      'warning-yellow': warningState === 'yellow',
      'warning-orange': warningState === 'orange',
      'warning-red': warningState === 'red'
    }"
  >
    <div class="cue-content">
      <div class="cue-header">
        <span class="cue-name" :title="cue.displayName">
          <span class="cue-state-indicator" aria-hidden="true"></span>
          <span
            v-if="cue.color"
            class="cue-color-swatch"
            :style="{ backgroundColor: cue.color }"
            aria-hidden="true"
          ></span>
          <span class="cue-name-text">{{ cue.displayName }}</span>
        </span>
        <div class="cue-actions">
          <button 
            v-if="!cue.isPaused" 
            type="button"
            class="action-btn pause-btn" 
            @click="handlePause" 
            :title="t('actions.pause')"
            :aria-label="t('actions.pause')"
          >
            <span class="material-symbols-rounded" aria-hidden="true">pause</span>
          </button>
          <button
            v-if="cue.isPaused"
            type="button"
            class="action-btn resume-btn"
            @click="handleResume"
            :title="t('actions.resume')"
            :aria-label="t('actions.resume')"
          >
            <span class="material-symbols-rounded" aria-hidden="true">play_arrow</span>
          </button>
          <button
            v-if="isLooping"
            type="button"
            class="action-btn continue-btn"
            @click="handleContinue"
            :title="t('actions.cueToContinue')"
            :aria-label="t('actions.cueToContinue')"
          >
            <span class="material-symbols-rounded" aria-hidden="true">skip_next</span>
          </button>
          <button
            v-if="isLooping"
            type="button"
            class="action-btn jump-cue-btn"
            @click="handleJumpCue"
            :title="t('actions.jumpCue')"
            :aria-label="t('actions.jumpCue')"
          >
            <span class="material-symbols-rounded" aria-hidden="true">last_page</span>
          </button>
          <button
            type="button"
            class="action-btn stop-btn"
            @click="handleStop"
            :title="t('actions.stop')"
            :aria-label="t('actions.stop')"
          >
            <span class="material-symbols-rounded" aria-hidden="true">stop</span>
          </button>
        </div>
      </div>
      
      <div class="cue-progress">
        <div class="time-info">
          <span>{{ formatTime(cue.currentTime) }}</span>
          <!-- Segue countdown: time until the Start Next marker fires -->
          <span
            v-if="segueCountdown !== null"
            class="segue-countdown"
            :class="{ 'segue-countdown--imminent': segueCountdown <= 5 }"
            :title="t('playback.startNextCountdown')"
          >
            <span class="material-symbols-rounded" aria-hidden="true">skip_next</span>
            {{ segueCountdown.toFixed(1) }}s
          </span>
          <span>-{{ formatTime(cue.duration - cue.currentTime) }}</span>
        </div>

        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: `${progress}%` }"></div>
          <!-- Start Next marker tick on the progress bar -->
          <div
            v-if="seguePercent !== null"
            class="segue-tick"
            :style="{ left: `${seguePercent}%` }"
          ></div>
          <input
            type="range"
            class="progress-slider"
            min="0"
            :max="cue.duration"
            step="0.1"
            :value="seekPosition"
            :aria-label="cue.displayName"
            :aria-valuetext="`${formatTime(seekPosition)} / ${formatTime(cue.duration)}`"
            @input="handleSeek"
          />
        </div>
      </div>
    </div>
    
    <!-- VU Meter — drawn from the server's live meter stream so it tracks
         what the audio engine is actually outputting, not a waveform-based
         estimate. Stereo widget shows L/R per source channel. -->
    <div class="cue-meter">
      <StereoMeter
        :cue-id="serverCueId"
        :min-db="-60"
        :max-db="0"
      />
    </div>

    <!-- End-of-cue warning border. Inset overlay so the thick border stays
         inside the item box and is never clipped by the active-cue strip's
         overflow: hidden. -->
    <div
      v-if="warningState"
      class="warning-border"
      :class="`warning-border--${warningState}`"
      aria-hidden="true"
    ></div>
  </div>
</template>

<script setup lang="ts">
import type { AudioItem } from '~/types/project';

// Projection of the server's view of an active cue. Owned by useAudioEngine
// which rebuilds it from cue_state / playback_snapshot / meters broadcasts.
// No client-side playback state lives here.
interface ActiveCueState {
  uuid: string;
  displayName: string;
  duration: number;
  currentTime: number;
  isPaused: boolean;
  color?: string;
  inPoint?: number;
  outPoint?: number;
  serverCueId?: string | null;
}

const props = defineProps<{
  cue: ActiveCueState;
}>();

const { stopCue, pauseCue, resumeCue, seekCue, queueLoopContinuation, jumpCue } = useAudioEngine();
const { t } = useLocalization();
const { findItemByUuid } = useProject();

// The underlying project item — endBehavior lives here, not on the
// server-projected ActiveCueState.
const audioItem = computed<AudioItem | null>(() => {
  const item = findItemByUuid(props.cue.uuid);
  return item && item.type === 'audio' ? (item as AudioItem) : null;
});

const isLooping = computed(() => audioItem.value?.endBehavior.action === 'loop');

// Start Next marker (absolute file time) from the project item, if armed.
const startNextTime = computed<number | null>(() => {
  const item = findItemByUuid(props.cue.uuid) as any;
  if (!item || item.type !== 'audio') return null;
  if (!item.startNextEnabled || !(item.startNextTime > 0)) return null;
  return item.startNextTime as number;
});

// Seconds until the marker fires; null once passed (or when not armed).
// currentTime is relative to the in point, the marker is absolute file time.
const segueCountdown = computed<number | null>(() => {
  if (startNextTime.value === null) return null;
  const absolutePos = props.cue.currentTime + (props.cue.inPoint || 0);
  const remaining = startNextTime.value - absolutePos;
  return remaining > 0 ? remaining : null;
});

// Marker position on the (trimmed) progress bar, 0–100.
const seguePercent = computed<number | null>(() => {
  if (startNextTime.value === null || !props.cue.duration) return null;
  const rel = (startNextTime.value - (props.cue.inPoint || 0)) / props.cue.duration;
  if (rel <= 0 || rel >= 1) return null;
  return rel * 100;
});

// Server engine cue ID — populated in onload once the server registers the
// cue and returns its ID. Used by StereoMeter to subscribe to the right
// WS meter frame.
const serverCueId = computed<string | null>(() => props.cue.serverCueId ?? null);

const seekPosition = computed(() => Math.max(
  0,
  Math.min(props.cue.duration, props.cue.currentTime),
));

// Use the cue's currentTime directly (updated by the audio engine)
const progress = computed(() => {
  if (!props.cue.duration || props.cue.duration === 0) return 0;
  return (seekPosition.value / props.cue.duration) * 100;
});

// Warning state based on time remaining
// Note: This is per-cue visual feedback only
// The ProjectHeader handles the actual silence detection across all cues
const warningState = computed(() => {
  const timeRemaining = props.cue.duration - props.cue.currentTime;
  if (timeRemaining <= 5) return 'red';
  if (timeRemaining <= 10) return 'orange';
  if (timeRemaining <= 30) return 'yellow';
  return null;
});

const handleStop = () => {
  stopCue(props.cue.uuid);
};

const handlePause = () => {
  pauseCue(props.cue.uuid);
};

const handleResume = () => {
  resumeCue(props.cue.uuid);
};

const handleContinue = () => {
  if (!audioItem.value) return;
  queueLoopContinuation(audioItem.value, resolveLoopContinuationTarget(audioItem.value));
};

const handleJumpCue = () => {
  if (!audioItem.value) return;
  jumpCue(audioItem.value);
};

const handleSeek = (e: Event) => {
  const cueTime = Number((e.currentTarget as HTMLInputElement).value);
  if (!Number.isFinite(cueTime)) return;
  // Trimmed → absolute file time.
  const absoluteSeekTime = cueTime + (props.cue.inPoint || 0);
  seekCue(props.cue.uuid, absoluteSeekTime);
};

const formatTime = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};
</script>

<style scoped lang="scss">
.active-cue-item {
  background-color: var(--color-surface-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  padding: var(--spacing-sm) var(--spacing-md);
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast);
  min-width: 400px;
  max-width: 400px;
  display: flex;
  gap: var(--spacing-sm);
  position: relative;
  box-shadow: inset 3px 0 0 var(--state-playing);
}

.active-cue-item.is-paused {
  box-shadow: inset 3px 0 0 var(--color-text-tertiary);
}

/* Solid 4px end-of-cue warning border. Inset overlay pinned inside the item
   box so it cannot be clipped by the active-cue strip's overflow. */
.warning-border {
  position: absolute;
  inset: 0;
  z-index: 10;
  pointer-events: none;
  border: 4px solid transparent;
  border-radius: var(--border-radius-md);

  /* Blink rates mirror the ProjectHeader silence-warning banner so the border
     and banner pulse in sync (yellow ≤30s, orange ≤10s, red ≤5s). */
  &.warning-border--yellow {
    border-color: var(--state-up-next);
    animation: warning-border-flash 2s ease-in-out infinite;
  }

  &.warning-border--orange {
    border-color: rgb(255, 152, 0);
    animation: warning-border-flash 1s ease-in-out infinite;
  }

  &.warning-border--red {
    border-color: var(--color-danger);
    animation: warning-border-flash 0.5s ease-in-out infinite;
  }
}

@keyframes warning-border-flash {
  0%, 100% { opacity: 0; }
  50% { opacity: 1; }
}

.cue-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.cue-meter {
  display: flex;
  align-items: stretch;
  padding-left: var(--spacing-sm);
  border-left: 1px solid var(--color-border);
}

.cue-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--spacing-xs);
}

.cue-actions {
  display: flex;
  gap: 4px;
}

.cue-name {
  font-weight: 500;
  flex: 1;
  min-width: 0;
  color: var(--color-text-primary);
  display: flex;
  align-items: center;
  gap: 6px;
}

.cue-name-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cue-state-indicator {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: var(--state-playing);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--state-playing) 18%, transparent);
  flex: 0 0 auto;
}

.is-paused .cue-state-indicator {
  background-color: var(--color-text-tertiary);
  box-shadow: none;
}

.cue-color-swatch {
  width: 3px;
  height: 12px;
  border-radius: 1px;
  flex: 0 0 auto;
}

.action-btn {
  width: 24px;
  height: 24px;
  border-radius: var(--border-radius-sm);
  color: white;
  font-size: 20px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  
  &.pause-btn, &.resume-btn {
    background-color: var(--color-accent);
  }

  &.continue-btn {
    background-color: var(--state-playing); /* Green: let the loop finish, then advance */
  }

  &.jump-cue-btn {
    background-color: var(--color-accent); /* Blue: cut now, advance now */
  }

  &.stop-btn {
    background-color: var(--color-danger);
  }
  
  &:hover {
    opacity: 0.8;
  }
}

.cue-progress {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.time-info {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.segue-countdown {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: rgb(22, 163, 74);
  font-weight: 600;

  .material-symbols-rounded {
    font-size: 14px;
  }

  &.segue-countdown--imminent {
    animation: segue-pulse 1s ease-in-out infinite;
  }
}

@keyframes segue-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.segue-tick {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 2px;
  background: rgb(22, 163, 74);
  pointer-events: none;
}

.progress-bar {
  height: 12px;
  background-color: var(--color-surface);
  border-radius: var(--border-radius-sm);
  position: relative;
  /* Force LTR direction for progress bars in RTL languages */
  direction: ltr;
}

.progress-fill {
  height: 100%;
  background-color: var(--state-playing);
  border-radius: var(--border-radius-sm);
  transition: width 100ms linear;
  pointer-events: none;
}

.progress-slider {
  appearance: none;
  -webkit-appearance: none;
  position: absolute;
  inset: -6px 0;
  z-index: 2;
  width: 100%;
  height: 24px;
  margin: 0;
  background: transparent;
  border-radius: var(--border-radius-sm);
  cursor: pointer;
  direction: ltr;
}

.progress-slider::-webkit-slider-runnable-track {
  height: 12px;
  background: transparent;
}

.progress-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  margin-top: -2px;
  background-color: var(--color-surface-raised);
  border: 2px solid var(--state-playing);
  border-radius: 50%;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}

.progress-slider:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: -2px;
}

.progress-slider:focus-visible::-webkit-slider-thumb {
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--state-playing) 32%, transparent),
    0 1px 3px rgba(0, 0, 0, 0.4);
}

@media (prefers-reduced-motion: reduce) {
  .warning-border,
  .segue-countdown--imminent {
    animation: none;
  }

  .warning-border {
    opacity: 1;
  }
}
</style>
