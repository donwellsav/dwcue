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
      <div v-if="activeCues.size === 0" class="no-cues">
        {{ t('playback.noActiveCues') }}
      </div>

      <div v-else class="cue-list">
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

    <!-- Preview is deliberately isolated in MainWorkspace's lower panel. -->
    <Teleport v-if="previewingItem" defer to="#preview-lower-panel">
      <div class="preview-cue-card">
      <div class="preview-cue-content">
        <div class="preview-cue-header">
          <div class="preview-cue-name" :title="previewingItem.displayName">
            <span class="preview-status-pill">{{ t('status.previewing') }}</span>
            <button
              type="button"
              class="preview-action-btn preview-set-next-btn"
              :class="{ active: previewIsNext }"
              @click="handleSetPreviewNext"
              :title="t('actions.setAsNext')"
            >
              {{ t('actions.setAsNext') }}
            </button>
            <span class="preview-cue-title">{{ previewingItem.displayName }}</span>
            <span v-if="previewLoops" class="preview-loop-pill">{{ t('endBehavior.loop') }}</span>
          </div>
          <div class="preview-transport" role="group" :aria-label="t('status.previewing')">
            <button
              type="button"
              class="preview-action-btn"
              @click="jumpPreview(-1)"
              :title="t('actions.jumpPreviewBack')"
              :aria-label="t('actions.jumpPreviewBack')"
            >
              <span class="material-symbols-rounded" aria-hidden="true">fast_rewind</span>
            </button>
            <button
              type="button"
              class="preview-action-btn"
              @click="handlePreviewPause"
              :title="previewPauseLabel"
              :aria-label="previewPauseLabel"
            >
              <span class="material-symbols-rounded" aria-hidden="true">{{ previewPauseIcon }}</span>
            </button>
            <button
              type="button"
              class="preview-action-btn preview-stop-btn"
              @click="stopPreview"
              :title="t('actions.stopPreview')"
              :aria-label="t('actions.stopPreview')"
            >
              <span class="material-symbols-rounded" aria-hidden="true">stop</span>
            </button>
            <button
              type="button"
              class="preview-action-btn"
              @click="jumpPreview(1)"
              :title="t('actions.jumpPreviewForward')"
              :aria-label="t('actions.jumpPreviewForward')"
            >
              <span class="material-symbols-rounded" aria-hidden="true">fast_forward</span>
            </button>
            <div class="preview-jump-value" :aria-label="t('actions.previewJump')">
              <button type="button" :class="{ selected: previewJumpDigit === 'whole' }" @click="previewJumpDigit = 'whole'">{{ previewJumpWhole }}</button>
              <span>.</span>
              <button type="button" :class="{ selected: previewJumpDigit === 'tenths' }" @click="previewJumpDigit = 'tenths'">{{ previewJumpTenths }}</button>
              <span class="preview-jump-unit">s</span>
              <span class="preview-jump-steppers">
                <button type="button" @click="stepPreviewJump(1)" :aria-label="t('actions.increasePreviewJump')">▲</button>
                <button type="button" @click="stepPreviewJump(-1)" :aria-label="t('actions.decreasePreviewJump')">▼</button>
              </span>
            </div>
          </div>
        </div>

        <div class="preview-cue-progress">
          <span class="preview-time">{{ formatPreviewTime(previewFileTime) }}</span>
          <div class="preview-progress-bar">
            <div
              class="preview-range-span"
              :style="{ left: previewInPct + '%', width: Math.max(0, previewOutPct - previewInPct) + '%' }"
            ></div>
            <div class="preview-progress-fill" :style="{ width: previewProgressPct + '%' }"></div>
            <input
              type="range"
              class="preview-progress-slider"
              min="0"
              :max="previewTrackDuration"
              step="0.1"
              :value="previewSeekValue"
              :aria-label="`${t('status.previewing')}: ${previewingItem.displayName}`"
              :aria-valuetext="`${formatPreviewTime(previewSeekValue)} / ${formatPreviewTime(previewTrackDuration)}`"
              @input="handlePreviewSeek"
            />
            <div
              class="preview-range-marker preview-range-marker--in"
              :style="{ left: previewInPct + '%' }"
            >
              <button
                type="button"
                class="preview-range-marker-drag"
                :aria-label="t('actions.previewIn')"
                @pointerdown="startPreviewBracketDrag('in', $event)"
              >{{ t('actions.previewIn') }}</button>
              <input
                type="text"
                class="preview-range-marker-value"
                inputmode="decimal"
                :aria-label="t('actions.previewIn')"
                :value="formatPreviewPrecise(previewTempIn)"
                @change="commitPreviewTimeInput('in', $event)"
                @keydown.enter.prevent="blurPreviewTimeInput"
                @keydown.esc.prevent="resetPreviewTimeInput('in', $event)"
                @keydown.down.prevent="stepPreviewBracket('in', -0.1)"
                @keydown.up.prevent="stepPreviewBracket('in', 0.1)"
                @pointerdown.stop
                @click.stop
              />
            </div>
            <div
              class="preview-range-marker preview-range-marker--out"
              :style="{ left: previewOutPct + '%' }"
            >
              <button
                type="button"
                class="preview-range-marker-drag"
                :aria-label="t('actions.previewOut')"
                @pointerdown="startPreviewBracketDrag('out', $event)"
              >{{ t('actions.previewOut') }}</button>
              <input
                type="text"
                class="preview-range-marker-value"
                inputmode="decimal"
                :aria-label="t('actions.previewOut')"
                :value="formatPreviewPrecise(previewTempOut)"
                @change="commitPreviewTimeInput('out', $event)"
                @keydown.enter.prevent="blurPreviewTimeInput"
                @keydown.esc.prevent="resetPreviewTimeInput('out', $event)"
                @keydown.down.prevent="stepPreviewBracket('out', -0.1)"
                @keydown.up.prevent="stepPreviewBracket('out', 0.1)"
                @pointerdown.stop
                @click.stop
              />
            </div>
          </div>
          <span class="preview-time preview-time-remaining">-{{ formatPreviewTime(previewTimeToOut) }}</span>
        </div>

        <div class="preview-tools">
          <button
            type="button"
            class="preview-action-btn preview-save-btn"
            :disabled="!previewTrimDirty"
            @click="savePreviewTrim"
            :title="t('actions.savePreviewTrim')"
          >
            {{ t('actions.saveTrim') }}
          </button>
        </div>
      </div>
      <div class="preview-cue-meter">
        <StereoMeter :left-index="30" :right-index="31" :min-db="-60" :max-db="0" />
      </div>
      </div>
    </Teleport>
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
const { findItemByUuid, previewItemUuid, previewCueId, stopPreview, saveProject } = useProject();
const { playbackMappings } = useCartHotkeys();
const { t } = useLocalization();
const server = useLiveplayServer();
const { uiMode } = useUiMode();
// Show Mode enlarges the GO / Stop-All buttons for touch.
const showMode = computed(() => uiMode.value === 'playback');

// Preview is an isolated audition workspace. Its In/Out edits stay temporary
// until the operator explicitly chooses Save Trim.
const previewingItem = computed(() => {
  const uuid = previewItemUuid.value;
  if (!uuid) return null;
  return findItemByUuid(uuid);
});
const previewMeter = useCueMeters(() => previewCueId.value || null);
const previewTempIn = ref(0);
const previewTempOut = ref(0);
const previewJumpSeconds = useState<number>('PlaybackControls.previewJumpSeconds', () => 5);
const previewJumpDigit = ref<'whole' | 'tenths'>('whole');

const previewTrackDuration = computed(() => previewingItem.value?.type === 'audio'
  ? Math.max(0, previewingItem.value.duration || 0)
  : 0);
const previewPermanentIn = computed(() => previewingItem.value?.type === 'audio'
  ? Math.max(0, previewingItem.value.inPoint || 0)
  : 0);
const previewPermanentOut = computed(() => {
  if (previewingItem.value?.type !== 'audio') return 0;
  const out = previewingItem.value.outPoint || previewTrackDuration.value;
  return out > previewPermanentIn.value ? out : previewTrackDuration.value;
});
const previewLoops = computed(() => previewingItem.value?.type === 'audio'
  && previewingItem.value.endBehavior?.action === 'loop');
const previewDuration = computed(() => Math.max(0, previewTempOut.value - previewTempIn.value));
const previewFileTime = computed(() => Math.max(0, Math.min(
  previewTrackDuration.value,
  previewMeter.playhead.value,
)));
const previewSeekValue = computed(() => previewFileTime.value);
const previewProgressPct = computed(() => {
  if (!previewTrackDuration.value) return 0;
  return (previewSeekValue.value / previewTrackDuration.value) * 100;
});
const previewTimeToOut = computed(() => Math.max(0, previewTempOut.value - previewFileTime.value));
const previewInPct = computed(() => previewTrackDuration.value
  ? (previewTempIn.value / previewTrackDuration.value) * 100
  : 0);
const previewOutPct = computed(() => previewTrackDuration.value
  ? (previewTempOut.value / previewTrackDuration.value) * 100
  : 100);
const previewTrimDirty = computed(() => Math.abs(previewTempIn.value - previewPermanentIn.value) >= 0.05
  || Math.abs(previewTempOut.value - previewPermanentOut.value) >= 0.05);
const previewIsNext = computed(() => previewItemUuid.value === nextItemOverrideUuid.value);
const previewIsPaused = computed(() => previewMeter.transport.value === 4);
const previewPauseIcon = computed(() => previewIsPaused.value || previewMeter.transport.value === 0
  ? 'play_arrow'
  : 'pause');
const previewPauseLabel = computed(() => previewIsPaused.value || previewMeter.transport.value === 0
  ? t('actions.resume')
  : t('actions.pause'));
const previewJumpWhole = computed(() => Math.floor(previewJumpSeconds.value));
const previewJumpTenths = computed(() => Math.round(previewJumpSeconds.value * 10) % 10);

watch([previewItemUuid, previewingItem], ([uuid, item]) => {
  if (!uuid || item?.type !== 'audio') return;
  previewTempIn.value = Math.max(0, item.inPoint || 0);
  const out = item.outPoint || item.duration || 0;
  previewTempOut.value = Math.max(previewTempIn.value + 0.1, out);
}, { immediate: true });

watch(previewCueId, (cueId) => {
  if (cueId) syncPreviewRange();
}, { immediate: true });

function formatPreviewTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
}

function formatPreviewPrecise(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10));
  const minutes = Math.floor(tenths / 600);
  const remainder = tenths % 600;
  return `${minutes}:${Math.floor(remainder / 10).toString().padStart(2, '0')}.${remainder % 10}`;
}

function parsePreviewPrecise(value: string): number | null {
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const match = text.match(/^(\d+):([0-5]?\d(?:\.\d+)?)$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function syncPreviewRange() {
  if (!previewCueId.value || previewTempOut.value <= previewTempIn.value) return;
  void server.setPreviewRange(previewTempIn.value, previewTempOut.value, previewLoops.value);
}

function handlePreviewSeek(e: Event) {
  if (!previewCueId.value || !previewDuration.value) return;
  const seekTo = Number((e.currentTarget as HTMLInputElement).value);
  if (!Number.isFinite(seekTo)) return;
  server.seekCueId(previewCueId.value, Math.max(previewTempIn.value, Math.min(previewTempOut.value, seekTo)));
}

function setPreviewBracket(which: 'in' | 'out', value: number, commit: boolean) {
  if (!Number.isFinite(value)) return;
  const rounded = Math.round(value * 10) / 10;
  if (which === 'in') {
    previewTempIn.value = Math.min(Math.max(0, rounded), previewTempOut.value - 0.1);
  } else {
    previewTempOut.value = Math.max(
      previewTempIn.value + 0.1,
      Math.min(previewTrackDuration.value, rounded),
    );
  }
  if (!commit) return;
  syncPreviewRange();
  if (which === 'in' && previewMeter.playhead.value < previewTempIn.value && previewCueId.value) {
    server.seekCueId(previewCueId.value, previewTempIn.value);
  }
}

function stepPreviewBracket(which: 'in' | 'out', delta: number) {
  setPreviewBracket(which, (which === 'in' ? previewTempIn.value : previewTempOut.value) + delta, true);
}

function commitPreviewTimeInput(which: 'in' | 'out', event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const value = parsePreviewPrecise(input.value);
  if (value !== null) setPreviewBracket(which, value, true);
  input.value = formatPreviewPrecise(which === 'in' ? previewTempIn.value : previewTempOut.value);
}

function blurPreviewTimeInput(event: Event) {
  (event.currentTarget as HTMLInputElement).blur();
}

function resetPreviewTimeInput(which: 'in' | 'out', event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  input.value = formatPreviewPrecise(which === 'in' ? previewTempIn.value : previewTempOut.value);
  input.blur();
}

function startPreviewBracketDrag(which: 'in' | 'out', event: PointerEvent) {
  if (event.button !== 0 || !event.isPrimary || !previewTrackDuration.value) return;
  const handle = event.currentTarget as HTMLButtonElement;
  const timeline = handle.closest<HTMLElement>('.preview-progress-bar');
  if (!timeline) return;
  event.preventDefault();
  event.stopPropagation();
  handle.setPointerCapture(event.pointerId);

  const update = (clientX: number) => {
    const rect = timeline.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    setPreviewBracket(which, ratio * previewTrackDuration.value, false);
  };
  const move = (e: PointerEvent) => update(e.clientX);
  const finish = (e: PointerEvent) => {
    if (e.type !== 'pointercancel') update(e.clientX);
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', finish);
    handle.removeEventListener('pointercancel', finish);
    setPreviewBracket(which, which === 'in' ? previewTempIn.value : previewTempOut.value, true);
  };
  update(event.clientX);
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
}

async function handlePreviewPause() {
  const cueId = previewCueId.value;
  if (!cueId) return;
  if (previewIsPaused.value) {
    await server.resumeCueId(cueId);
  } else if (previewMeter.transport.value === 0) {
    syncPreviewRange();
    server.seekCueId(cueId, previewTempIn.value);
    await server.play(cueId);
  } else {
    await server.pauseCueId(cueId);
  }
}

function jumpPreview(direction: -1 | 1) {
  if (!previewCueId.value) return;
  const target = Math.max(previewTempIn.value, Math.min(
    previewTempOut.value,
    previewMeter.playhead.value + direction * previewJumpSeconds.value,
  ));
  server.seekCueId(previewCueId.value, target);
}

function stepPreviewJump(direction: -1 | 1) {
  const step = previewJumpDigit.value === 'whole' ? 1 : 0.1;
  previewJumpSeconds.value = Math.max(0.1, Math.min(99.9,
    Math.round((previewJumpSeconds.value + direction * step) * 10) / 10,
  ));
}

async function savePreviewTrim() {
  const item = previewingItem.value;
  if (item?.type !== 'audio' || !previewTrimDirty.value) return;
  item.inPoint = previewTempIn.value;
  item.outPoint = previewTempOut.value;
  await server.updateProjectItem(item.uuid, { inPoint: item.inPoint, outPoint: item.outPoint });
  await saveProject({ force: true });
}

function handleSetPreviewNext() {
  if (previewItemUuid.value) setNextItem(previewItemUuid.value);
}

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
  --transport-side-width: var(--output-strip-width);
  flex: 0 0 var(--playback-controls-height);
  height: var(--playback-controls-height);
  box-sizing: border-box;
  border-bottom: 1px solid var(--color-border);
  display: grid;
  grid-template-columns: var(--transport-side-width) minmax(0, 1fr) var(--transport-side-width);
  grid-template-areas: 'panic live next';
  align-items: center;
  gap: var(--workspace-gutter);
  padding: var(--workspace-gutter);
  background-color: var(--color-surface);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--color-border) 45%, transparent);
}

/* Show Mode — bigger GO / Stop-All buttons. */
.playback-controls.show-mode {
  min-height: calc(var(--playback-controls-height) + var(--spacing-lg));

  .control-btn {
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

  .preview-transport .preview-action-btn {
    width: 44px;
    height: 44px;
    font-size: 28px;
  }
}

.playback-controls.show-mode :deep(.active-cue-item .action-btn) {
  width: 32px;
  height: 32px;
  font-size: 24px;
}

.control-btn {
  display: flex;
  align-items: center;
  align-self: stretch;
  width: 100%;
  gap: var(--spacing-sm);
  min-width: 0;
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
  grid-area: next;
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
  grid-area: panic;
  background-color: var(--color-danger);
  border-color: var(--color-danger);
  color: white;
  font-weight: 600;

  &:hover:not(:disabled) {
    background-color: var(--color-danger);
    border-color: var(--color-danger);
    filter: brightness(0.9);
  }

  &:disabled {
    opacity: 1;
    background-color: var(--color-control);
    border-color: var(--color-border);
    color: var(--color-text-disabled);
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
  grid-area: live;
  flex: 1;
  align-self: stretch;
  display: flex;
  align-items: stretch;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0;
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

/* Preview stays physically separate from the program transport lane. */
.preview-cue-card {
  background-color: var(--color-surface-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  padding: var(--spacing-sm) var(--spacing-md);
  min-width: 0;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  display: flex;
  gap: var(--spacing-sm);
  box-shadow: inset 3px 0 0 var(--state-preview);
}

.preview-cue-content {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-rows: auto auto;
  gap: 5px;
  align-content: center;
}

.preview-cue-header {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm);
}

.preview-cue-name {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex: 1;
  min-width: 0;
  color: var(--color-text-primary);
}

.preview-cue-title {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: 22px;
  font-weight: 650;
  line-height: 1.2;
  white-space: nowrap;
  text-overflow: ellipsis;
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

.preview-loop-pill {
  padding: 1px 6px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--pill-radius);
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 650;
  text-transform: uppercase;
  flex-shrink: 0;
}

.preview-transport {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.preview-transport .preview-action-btn {
  width: 40px;
  height: 40px;
  font-size: 25px;
}

.preview-action-btn {
  width: 24px;
  height: 24px;
  border-radius: var(--control-radius);
  background-color: var(--color-control);
  border: 1px solid var(--color-border);
  color: var(--color-text-primary);
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  white-space: nowrap;

  &:hover:not(:disabled) {
    background-color: var(--color-surface-hover);
    border-color: var(--color-border-strong);
  }

  &:focus-visible {
    outline: 2px solid var(--color-focus-ring);
    outline-offset: 1px;
  }

  &:disabled {
    cursor: default;
    color: var(--color-text-disabled);
    opacity: 0.65;
  }
}

.preview-set-next-btn,
.preview-save-btn {
  width: auto;
  min-width: 62px;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 650;
}

.preview-set-next-btn:not(.active):hover:not(:disabled) {
  background-color: color-mix(in srgb, var(--state-up-next) 24%, var(--color-control));
  border-color: color-mix(in srgb, var(--state-up-next) 52%, var(--color-border));
}

.preview-set-next-btn.active {
  background-color: var(--state-up-next);
  border-color: var(--state-up-next);
  color: #171b25;
}

.preview-stop-btn {
  background-color: var(--color-danger);
  border-color: var(--color-danger);
  color: white;
}

.preview-cue-meter {
  display: flex;
  align-items: stretch;
  flex: 0 0 30px;
  min-height: 0;
}

.preview-cue-progress {
  grid-column: 1;
  grid-row: 2;
  display: grid;
  grid-template-columns: 86px minmax(0, 1fr) 98px;
  align-items: center;
  gap: 6px;
}

.preview-time {
  font-size: 18px;
  font-weight: 650;
  font-family: var(--font-mono);
  color: var(--color-text-primary);
}

.preview-time-remaining { text-align: right; }

.preview-progress-bar {
  height: 12px;
  background-color: var(--color-surface);
  border-radius: var(--border-radius-sm);
  position: relative;
  direction: ltr;
}

.preview-range-span {
  position: absolute;
  inset-block: 0;
  background: color-mix(in srgb, var(--state-preview) 16%, transparent);
  border-block: 1px solid color-mix(in srgb, var(--state-preview) 48%, transparent);
  pointer-events: none;
}

.preview-progress-fill {
  position: relative;
  z-index: 1;
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
  z-index: 2;
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

.preview-range-marker {
  position: absolute;
  top: 50%;
  z-index: 3;
  display: inline-flex;
  flex-direction: column;
  align-items: stretch;
  height: 42px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--state-preview) 72%, var(--color-border));
  border-radius: var(--control-radius);
  background: var(--color-surface-raised);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.42);
}

.preview-range-marker--in {
  transform: translate(0, -50%);
}

.preview-range-marker--out {
  transform: translate(-100%, -50%);
}

.preview-range-marker:focus-within {
  border-color: var(--state-preview);
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--state-preview) 28%, transparent),
    0 2px 6px rgba(0, 0, 0, 0.42);
}

.preview-range-marker-drag {
  width: 100%;
  height: 18px;
  padding: 0;
  border: 0;
  border-bottom: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--state-preview) 22%, var(--color-control));
  color: color-mix(in srgb, var(--state-preview) 72%, white);
  font-size: 9px;
  font-weight: 750;
  text-transform: uppercase;
  cursor: ew-resize;
  touch-action: none;
}

.preview-range-marker-drag:hover {
  background: color-mix(in srgb, var(--state-preview) 34%, var(--color-control));
}

.preview-range-marker-value {
  width: 72px;
  height: 24px;
  min-width: 0;
  padding: 0 5px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 650;
  text-align: center;
}

.preview-tools {
  grid-column: 2;
  grid-row: 2;
  display: flex;
  align-items: end;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}

.preview-jump-value {
  height: 40px;
  display: inline-flex;
  align-items: center;
  padding-left: 5px;
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background: var(--color-control);
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: 15px;
}

.preview-jump-value > button {
  min-width: 12px;
  height: 20px;
  padding: 0 2px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--color-text-primary);
  font: inherit;
}

.preview-jump-value > button.selected {
  background: color-mix(in srgb, var(--state-preview) 28%, transparent);
  color: white;
}

.preview-jump-unit { margin-left: 2px; }

.preview-jump-steppers {
  align-self: stretch;
  display: grid;
  margin-left: 4px;
  border-left: 1px solid var(--color-border);
}

.preview-jump-steppers button {
  width: 17px;
  min-height: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 7px;
  line-height: 1;
}

.preview-jump-steppers button:hover {
  background: var(--color-surface-hover);
  color: var(--color-text-primary);
}
</style>
