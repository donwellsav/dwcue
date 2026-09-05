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

    <!-- Drawn from the server's live meter stream. Compact cue meters stay
         vertical but omit the nested console-strip box and padding. -->
    <div class="cue-meter">
      <StereoMeter
        :cue-id="serverCueId"
        :min-db="-60"
        :max-db="0"
      />
    </div>

    <!-- End-of-cue warning border stays inset so it is never clipped by the
         active-cue strip's overflow. -->
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

const handleStop = () => stopCue(props.cue.uuid);

const handlePause = () => pauseCue(props.cue.uuid);

const handleResume = () => resumeCue(props.cue.uuid);

const handleContinue = async () => {
  if (!audioItem.value) return false;
  return queueLoopContinuation(audioItem.value);
};

const handleJumpCue = async () => {
  if (!audioItem.value) return false;
  return jumpCue(audioItem.value);
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
  padding: var(--spacing-sm) 10px;
  min-width: 400px;
  max-width: 400px;
  display: flex;
  gap: var(--spacing-sm);
  position: relative;
}

.active-cue-item::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background-color: var(--state-playing);
  pointer-events: none;
}

.active-cue-item.is-paused::before {
  background-color: var(--color-text-tertiary);
}

/* Warning timing is unchanged; the signal stays present as a static inset line. */
.warning-border {
  position: absolute;
  inset: 0;
  z-index: 10;
  pointer-events: none;
  border: 2px solid transparent;
  border-radius: inherit;
}

.warning-border--yellow {
  border-color: var(--state-up-next);
}

.warning-border--orange {
  border-color: rgb(255, 152, 0);
}

.warning-border--red {
  border-color: var(--color-danger);
}

.cue-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.cue-meter {
  display: flex;
  align-items: stretch;
  flex: 0 0 30px;
  padding-left: var(--spacing-xs);
  border-left: 1px solid var(--color-border);
}

.cue-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  margin-bottom: 6px;
}

.cue-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 4px;
  margin-left: var(--spacing-sm);
}

.cue-name {
  font-weight: 650;
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
  flex: 0 0 auto;
}

.is-paused .cue-state-indicator {
  background-color: var(--color-text-tertiary);
}

.cue-color-swatch {
  width: 3px;
  height: 13px;
  border-radius: 1px;
  flex: 0 0 auto;
}

.action-btn {
  width: 26px;
  height: 26px;
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-sm);
  background-color: var(--color-control);
  color: var(--color-text-primary);
  font-size: 19px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.action-btn.continue-btn {
  border-color: color-mix(in srgb, var(--state-playing) 70%, var(--color-border));
  background-color: color-mix(in srgb, var(--state-playing) 14%, var(--color-control));
  color: var(--state-playing);
}

.action-btn.stop-btn {
  background-color: var(--color-danger);
  border-color: var(--color-danger);
  color: white;
}

.action-btn:hover {
  border-color: var(--color-border-strong);
  filter: brightness(1.08);
}

.action-btn:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 1px;
}

.cue-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.time-info {
  display: grid;
  grid-template-columns: minmax(4.5em, 1fr) auto minmax(4.5em, 1fr);
  align-items: center;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-secondary);
}

.time-info > :first-child {
  grid-column: 1;
}

.time-info > :last-child {
  grid-column: 3;
  text-align: right;
}

.time-info > .segue-countdown {
  grid-column: 2;
}

.segue-countdown {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 4px;
  border: 1px solid color-mix(in srgb, var(--state-playing) 58%, transparent);
  border-radius: var(--border-radius-sm);
  color: var(--state-playing);
  font-weight: 600;
}

.segue-countdown .material-symbols-rounded {
  font-size: 13px;
}

.segue-countdown--imminent {
  border-color: var(--state-playing);
  color: var(--color-text-primary);
}

.segue-tick {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 2px;
  background: var(--state-playing);
  pointer-events: none;
}

.progress-bar {
  height: 6px;
  background-color: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-sm);
  position: relative;
  direction: ltr;
}

.progress-fill {
  height: 100%;
  background-color: var(--state-playing);
  border-radius: 1px;
  transition: width 100ms linear;
  pointer-events: none;
}

.progress-slider {
  appearance: none;
  -webkit-appearance: none;
  position: absolute;
  inset: -9px 0;
  z-index: 2;
  width: 100%;
  height: 24px;
  margin: 0;
  background: transparent;
  cursor: pointer;
  direction: ltr;
}

.progress-slider::-webkit-slider-runnable-track {
  height: 6px;
  background: transparent;
}

.progress-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 14px;
  margin-top: -4px;
  background-color: var(--color-text-primary);
  border: 2px solid var(--state-playing);
  border-radius: 2px;
}

.progress-slider:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 3px;
}

.progress-slider:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--state-playing) 32%, transparent);
}
</style>
