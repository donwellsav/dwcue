<template>
  <article
    class="one-shot-tile"
    :class="{
      'is-playing': isPlaying,
      'is-paused': isPaused,
      'show-mode': showMode,
      'is-menu-open': menuOpen || removeOpen,
      'is-dragging': isDragging,
    }"
    :style="tileStyle"
    :draggable="!showMode"
    @dragstart="handleDragStart"
    @dragend="handleDragEnd"
  >
    <canvas ref="waveformCanvas" class="one-shot-waveform" aria-hidden="true"></canvas>
    <span class="one-shot-color-rail" aria-hidden="true"></span>
    <span v-if="isPlaying" class="one-shot-progress" :style="progressStyle" aria-hidden="true"></span>
    <div class="one-shot-topline">
      <b class="one-shot-index">{{ position + 1 }}</b>
      <kbd v-if="hotkeyLabel" class="one-shot-hotkey" :title="hotkeyLabel" dir="ltr">{{ hotkeyLabel.replace(/^Shift\+([0-9])$/, '⇧$1') }}</kbd>
      <span class="one-shot-duration" dir="ltr">{{ currentTimeLabel }}</span>
    </div>

    <div class="one-shot-body">
      <div class="one-shot-title" :title="item.displayName">{{ item.displayName }}</div>
      <span v-if="item.hasVideo && videoCheckIssue" class="one-shot-video-issue" role="img"
        :title="t(`videoCheck.${videoCheckIssue}`)" :aria-label="t(`videoCheck.${videoCheckIssue}`)">VIDEO !</span>
      <span v-if="isPlaying" class="one-shot-runtime-state" :class="{ 'is-paused': isPaused }">
        {{ t(isPaused ? 'status.paused' : 'status.playing') }}
      </span>
    </div>

    <div class="one-shot-bottomline">
      <div class="one-shot-actions">
        <button
          type="button"
          class="one-shot-control one-shot-transport"
          :class="{ 'is-stop': isPlaying }"
          :aria-label="transportLabel"
          :title="transportLabel"
          @click.stop="handleTransport"
          @keydown.enter.space.stop
        >
          <span class="material-symbols-rounded" aria-hidden="true">{{ isPlaying ? 'stop' : 'play_arrow' }}</span>
        </button>
        <button
          type="button"
          class="one-shot-control one-shot-follow"
          :class="{ 'is-on': followsUpNext }"
          :aria-pressed="followsUpNext"
          :aria-label="followLabel"
          :title="followLabel"
          :disabled="!followToggleReady"
          @click.stop="toggleFollow"
          @keydown.enter.space.stop
        >
          <span class="material-symbols-rounded" aria-hidden="true">subdirectory_arrow_right</span>
        </button>
        <button
          v-if="!showMode"
          type="button"
          class="one-shot-control one-shot-settings"
          :class="{ 'is-active': settingsOpen }"
          :aria-label="t('oneShots.settingsFor', { name: item.displayName })"
          :title="t('oneShots.settings')"
          :aria-expanded="settingsOpen"
          @click.stop="toggleMenu"
        >
          <span class="material-symbols-rounded" aria-hidden="true">settings</span>
        </button>
        <button
          v-if="!showMode"
          type="button"
          class="one-shot-control one-shot-remove"
          :class="{ 'is-active': removeOpen }"
          :aria-label="t('oneShots.removeFor', { name: item.displayName })"
          :title="t('oneShots.remove')"
          :aria-expanded="removeOpen"
          @click.stop="toggleRemove"
        >
          <span class="material-symbols-rounded" aria-hidden="true">close</span>
        </button>
      </div>
    </div>

    <Teleport defer :to="isDetached ? '#detached-quickplay-dock' : '#workspace-import-host'">
      <section
        v-if="menuOpen"
        class="quickplay-settings"
        :aria-label="t('oneShots.settingsFor', { name: item.displayName })"
      >
        <h3 class="quickplay-settings-title">{{ item.displayName }}</h3>
        <small
          v-if="isDetached && detachedMutationError"
          class="popover-error detached-mutation-error"
        >{{ detachedMutationError }}</small>

        <div class="popover-field">
          <span>{{ t('oneShots.playback') }}</span>
          <InlineChoicePicker id="quickplay-playback" :label="t('oneShots.playback')"
            :value="playbackMode" :options="playbackOptions" @change="onPlaybackModeChange" />
        </div>

        <div class="popover-field">
          <span>{{ t('oneShots.retrigger') }}</span>
          <InlineChoicePicker id="quickplay-retrigger" :label="t('oneShots.retrigger')"
            :value="item.oneShot?.retrigger ?? 'restart'" :options="retriggerOptions" @change="onRetriggerChange" />
        </div>

        <div class="popover-field">
          <span>{{ t('oneShots.ending') }}</span>
          <InlineChoicePicker id="quickplay-ending" :label="t('oneShots.ending')"
            :value="endMode" :options="endingOptions" @change="onEndModeChange" />
        </div>

        <label class="popover-field popover-field--range">
          <span>{{ t('oneShots.gain') }} <output>{{ volumeDb.toFixed(1) }} dB</output></span>
          <input class="app-range" type="range" min="-60" max="12" step="0.5" :value="volumeDb" @input="onVolumeInput" @change="persist({ volume: item.volume })" />
        </label>

        <div class="popover-pair">
          <label class="popover-field">
            <span>{{ t('oneShots.fadeIn') }}</span>
            <span class="number-with-unit"><input type="number" min="0" max="30" step="0.1" :value="item.playFade" @change="onFadeChange('playFade', $event)" /><span>s</span></span>
          </label>
          <label class="popover-field">
            <span>{{ t('oneShots.fadeOut') }}</span>
            <span class="number-with-unit"><input type="number" min="0" max="30" step="0.1" :value="item.stopFade" @change="onFadeChange('stopFade', $event)" /><span>s</span></span>
          </label>
        </div>

        <template v-if="playbackMode === 'duck'">
          <label class="popover-field popover-field--range">
            <span>{{ t('oneShots.duckLevel') }} <output>{{ duckDb.toFixed(1) }} dB</output></span>
            <input class="app-range" type="range" min="-60" max="0" step="0.5" :value="duckDb" @input="onDuckInput" @change="persist({ duckLevel: item.duckingBehavior.duckLevel ?? 0.1 })" />
          </label>
          <div class="popover-pair">
            <label class="popover-field">
              <span>{{ t('oneShots.duckAttack') }}</span>
              <span class="number-with-unit"><input type="number" min="0" max="10" step="0.1" :value="item.duckingBehavior.duckFadeIn ?? 0.25" @change="onDuckFadeChange('duckFadeIn', $event)" /><span>s</span></span>
            </label>
            <label class="popover-field">
              <span>{{ t('oneShots.duckRelease') }}</span>
              <span class="number-with-unit"><input type="number" min="0" max="10" step="0.1" :value="item.duckingBehavior.duckFadeOut ?? 1" @change="onDuckFadeChange('duckFadeOut', $event)" /><span>s</span></span>
            </label>
          </div>
        </template>

        <div class="popover-field">
          <span>{{ t('oneShots.output') }}</span>
          <InlineChoicePicker id="quickplay-output" :label="t('oneShots.output')"
            :value="item.deviceOverride ?? ''" :options="outputOptions" @change="onOutputChange" />
        </div>

        <div class="popover-field">
          <span>{{ t('oneShots.shortcut') }}</span>
          <div class="shortcut-row">
            <button type="button" class="shortcut-capture" :class="{ 'is-capturing': capturingHotkey }" @click="startHotkeyCapture">
              {{ capturingHotkey ? t('oneShots.pressShortcut') : (hotkeyLabel || t('oneShots.assignShortcut')) }}
            </button>
            <button v-if="hotkeyLabel" type="button" class="shortcut-clear" :aria-label="t('oneShots.clearShortcut')" @click="clearHotkey">
              <span class="material-symbols-rounded" aria-hidden="true">backspace</span>
            </button>
          </div>
          <small v-if="hotkeyError" class="popover-error">{{ hotkeyError }}</small>
        </div>

        <div v-if="!showMode" class="quickplay-settings-actions">
          <Btn icon="upload_file" :text="t('oneShots.replaceAudio')" @click="requestImport" />
        </div>
      </section>

      <section
        v-if="removeOpen"
        class="quickplay-remove"
        :aria-label="t('oneShots.removeConfirmTitle')"
      >
        <strong>{{ item.displayName }}</strong>
        <p>{{ t('oneShots.removeConfirmBody') }}</p>
        <div class="confirm-actions">
          <button type="button" @click="closeEditor">{{ t('common.cancel') }}</button>
          <button type="button" class="confirm-remove" @click="confirmRemove">{{ t('oneShots.remove') }}</button>
        </div>
      </section>
    </Teleport>
  </article>
</template>

<script setup lang="ts">
import { useDetachedOneShotMutation } from '~/composables/useDetachedOneShotMutation';
import type { AudioItem, CartSlotKeyBinding } from '~/types/project';
import type { OneShotMutableFields } from '~/types/oneShotMutation';
import {
  getOneShotEndMode,
  getOneShotPlaybackMode,
  oneShotFollowsUpNext,
  setOneShotEndMode,
  setOneShotPlaybackMode,
  type OneShotEndMode,
  type OneShotPlaybackMode,
} from '~/utils/oneShots';
import { bindingsMatch, eventToBinding, formatKeyLabel, isReservedCombo } from '~/composables/useCartHotkeys';

const props = defineProps<{ item: AudioItem; position: number; hotkey?: CartSlotKeyBinding }>();
const emit = defineEmits<{
  (event: 'request-import'): void;
  (event: 'remove'): void;
}>();
const waveformCanvas = ref<HTMLCanvasElement | null>(null);
const capturingHotkey = ref(false);
const hotkeyError = ref('');
const isDragging = ref(false);
let resizeObserver: ResizeObserver | null = null;

const { uiMode } = useUiMode();
const { t } = useLocalization();
const videoCheckIssues = useVideoPreflightIssues();
const videoCheckIssue = computed(() => videoCheckIssues.value.get(props.item.uuid));
const {
  saveProject, openItemProperties, workspaceImportPanel, quickPlayEditor,
  selectedItem, propertiesPanelOpen,
} = useProject();
const showProjectSettings = useState('showProjectSettings', () => false);
const {
  activeCues, stopCue, cueFollowOverrides, queueLoopContinuation,
  nextItemOverrideUuid, autoNextItemUuid, setNextItemPending,
} = useAudioEngine();
const { playOneShot } = useOneShotPlayback();
const { updateBinding, playbackMappings } = useCartHotkeys();
const server = useLiveplayServer();
const { isDetached, error: detachedMutationError, mutate } = useDetachedOneShotMutation();
const editorOpen = computed(() => quickPlayEditor.value?.uuid === props.item.uuid &&
  (isDetached || (workspaceImportPanel.value === 'quickplay' && !showProjectSettings.value)));
const menuOpen = computed(() => editorOpen.value && !quickPlayEditor.value?.remove);
const removeOpen = computed(() => editorOpen.value && !!quickPlayEditor.value?.remove && !showMode.value);

const showMode = computed(() => uiMode.value === 'playback');
const activeCue = computed(() => activeCues.value.get(props.item.uuid));
// Map membership remains the active/stop contract; pause is a visual sub-state.
const isPlaying = computed(() => !!activeCue.value);
const isPaused = computed(() => activeCue.value?.isPaused === true);
const playbackOptions = computed(() => [
  { value: 'overlay', label: t('oneShots.overlay') },
  { value: 'duck', label: t('oneShots.duck') },
  { value: 'replace', label: t('oneShots.replace') },
] as const);
const retriggerOptions = computed(() => [
  { value: 'restart', label: t('oneShots.restart') },
  { value: 'ignore', label: t('oneShots.ignore') },
] as const);
// A Go to Item / Go to Index ending is authored in Properties (it needs a
// target). It is shown here so this picker never misreports it as Stop.
const endingOptions = computed(() => [
  { value: 'stop' as OneShotEndMode, label: t('oneShots.stop') },
  { value: 'loop' as OneShotEndMode, label: t('oneShots.loop') },
  { value: 'next' as OneShotEndMode, label: t('endBehavior.next') },
  ...(endMode.value === 'goto' ? [{
    value: 'goto' as OneShotEndMode,
    label: t(props.item.endBehavior?.action === 'goto-index' ? 'endBehavior.gotoIndex' : 'endBehavior.gotoItem'),
  }] : []),
]);
const outputOptions = computed(() => [
  { value: '', label: t('settings.useProjectDefault') },
  ...(server.devices ?? []).map(device => ({ value: device.id, label: device.display_name })),
]);
const playbackMode = computed(() => getOneShotPlaybackMode(props.item));
const endMode = computed(() => getOneShotEndMode(props.item));
const volumeDb = computed(() => props.item.volume > 0 ? 20 * Math.log10(props.item.volume) : -60);
const duckDb = computed(() => {
  const level = props.item.duckingBehavior.duckLevel ?? 0.1;
  return level > 0 ? Math.max(-60, 20 * Math.log10(level)) : -60;
});
const hotkeyLabel = computed(() => props.hotkey ? formatKeyLabel(props.hotkey) : '');
// The main window edits a QuickPlay in the same Properties panel as any other
// cue. The detached window has no Properties panel and keeps the compact one.
const settingsOpen = computed(() => isDetached
  ? menuOpen.value
  : propertiesPanelOpen.value && selectedItem.value?.uuid === props.item.uuid);

// Cue to Continue for this QuickPlay: when it finishes, play the playlist's
// Up Next. While it plays the server-owned state of this pass is shown and
// toggled; when idle the tile shows what the saved Ending will do.
const followsUpNext = computed(() => oneShotFollowsUpNext(
  props.item,
  isPlaying.value ? cueFollowOverrides.value.get(props.item.uuid) : null,
));
const upNextReady = computed(() => {
  const uuid = nextItemOverrideUuid.value ?? autoNextItemUuid.value;
  return !!uuid && uuid !== props.item.uuid && !setNextItemPending.value;
});
// Switching it off always works; switching it on needs a cue to go to.
const followToggleReady = computed(() => isPlaying.value && (followsUpNext.value || upNextReady.value));
const followLabel = computed(() => t(
  followsUpNext.value ? (isPlaying.value ? 'oneShots.followPlayNextOn' : 'oneShots.followPlayNextSaved')
    : !isPlaying.value ? 'oneShots.followPlayNextIdle'
      : upNextReady.value ? 'oneShots.followPlayNext' : 'oneShots.followPlayNextNeedsCue',
));
const toggleFollow = () => queueLoopContinuation(props.item);
const transportLabel = computed(() => isPlaying.value
  ? t('oneShots.stopNamed', { name: props.item.displayName })
  : t('oneShots.playNamed', { name: props.item.displayName }));
const tileStyle = computed(() => ({ '--one-shot-color': props.item.color || '#315FCF' }));
const progressStyle = computed(() => {
  const cue = activeCue.value;
  return { width: `${cue?.duration ? Math.min(100, Math.max(0, cue.currentTime / cue.duration * 100)) : 0}%` };
});
const currentTimeLabel = computed(() => {
  if (!activeCue.value) return formatDuration(Math.max(0, props.item.outPoint - props.item.inPoint || props.item.duration));
  return `−${formatDuration(Math.max(0, activeCue.value.duration - activeCue.value.currentTime))}`;
});

function formatDuration(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

const persist = (fields: OneShotMutableFields) => {
  if (isDetached) void mutate({ kind: 'set-fields', itemUuid: props.item.uuid, payload: { fields } });
  else void saveProject();
};

const requestImport = () => {
  closeEditor();
  emit('request-import');
};

const handleTransport = () => {
  return isPlaying.value ? stopCue(props.item.uuid) : playOneShot(props.item);
};

const handleDragStart = (event: DragEvent) => {
  if (showMode.value || !event.dataTransfer) {
    event.preventDefault();
    return;
  }
  if ((event.target as HTMLElement).closest('button')) {
    event.preventDefault();
    return;
  }
  // One Shot → Playlist is a copy; One Shot → another cell remains a move.
  // copyMove advertises both destinations without consuming the source cue.
  event.dataTransfer.effectAllowed = 'copyMove';
  event.dataTransfer.setData('one-shot-uuid', props.item.uuid);
  event.dataTransfer.setData('one-shot-slot', String(props.position));
  event.dataTransfer.setData('one-shot-to-playlist', 'copy');
  isDragging.value = true;
};

const handleDragEnd = () => {
  isDragging.value = false;
};

const closeEditor = () => {
  quickPlayEditor.value = null;
  if (!isDetached && workspaceImportPanel.value === 'quickplay') workspaceImportPanel.value = null;
};

const showEditor = (remove: boolean) => {
  quickPlayEditor.value = { uuid: props.item.uuid, remove };
  if (!isDetached) {
    showProjectSettings.value = false;
    workspaceImportPanel.value = 'quickplay';
  }
};

const toggleMenu = () => {
  if (!isDetached) {
    if (settingsOpen.value) propertiesPanelOpen.value = false;
    else openProperties();
    return;
  }
  if (menuOpen.value) closeEditor();
  else showEditor(false);
};

const toggleRemove = () => {
  if (removeOpen.value) closeEditor();
  else showEditor(true);
};

watch(menuOpen, () => {
  capturingHotkey.value = false;
  hotkeyError.value = '';
});

// Show Mode has no settings control, so nothing it opened may stay on screen.
watch(showMode, (show) => {
  if (show && menuOpen.value) closeEditor();
});

const onPlaybackModeChange = (mode: OneShotPlaybackMode) => {
  setOneShotPlaybackMode(props.item, mode);
  persist({ playbackMode: mode });
};

const onEndModeChange = (mode: OneShotEndMode) => {
  if (mode === 'goto') return;
  setOneShotEndMode(props.item, mode);
  persist({ endMode: mode });
};

const onRetriggerChange = (retrigger: NonNullable<OneShotMutableFields['retrigger']>) => {
  if (!props.item.oneShot) return;
  props.item.oneShot.retrigger = retrigger;
  persist({ retrigger });
};

const onVolumeInput = (event: Event) => {
  const db = Number((event.target as HTMLInputElement).value);
  props.item.volume = db <= -60 ? 0 : Math.pow(10, db / 20);
};

const onDuckInput = (event: Event) => {
  const db = Number((event.target as HTMLInputElement).value);
  props.item.duckingBehavior.duckLevel = db <= -60 ? 0 : Math.pow(10, db / 20);
};

const clampNumber = (event: Event, min: number, max: number): number => {
  const input = event.target as HTMLInputElement;
  const value = Math.min(max, Math.max(min, Number(input.value) || 0));
  input.value = value.toFixed(1);
  return value;
};

const onFadeChange = (field: 'playFade' | 'stopFade', event: Event) => {
  const value = clampNumber(event, 0, 30);
  props.item[field] = value;
  persist({ [field]: value });
};

const onDuckFadeChange = (field: 'duckFadeIn' | 'duckFadeOut', event: Event) => {
  const value = clampNumber(event, 0, 10);
  props.item.duckingBehavior[field] = value;
  persist({ [field]: value });
};

const onOutputChange = (value: string) => {
  props.item.deviceOverride = value || null;
  persist({ deviceOverride: props.item.deviceOverride });
};

const startHotkeyCapture = () => {
  capturingHotkey.value = true;
  hotkeyError.value = '';
};

const clearHotkey = () => {
  if (props.item.oneShot) props.item.oneShot.hotkey = null;
  capturingHotkey.value = false;
  persist({ hotkey: null });
};

const handleDocumentKeydown = (event: KeyboardEvent) => {
  if (!menuOpen.value || !capturingHotkey.value) return;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
  const binding = eventToBinding(event);
  const stopAll = playbackMappings.value['stop-all'];
  if (stopAll && bindingsMatch(stopAll, binding)) {
    capturingHotkey.value = false;
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.key === 'Escape') {
    capturingHotkey.value = false;
    return;
  }
  if (isReservedCombo(binding)) {
    hotkeyError.value = t('controls.reserved');
    return;
  }
  const result = updateBinding(props.position, binding);
  if (result.conflict >= 0) {
    hotkeyError.value = t('oneShots.shortcutConflict', { name: result.conflict + 1 });
    return;
  }
  capturingHotkey.value = false;
  hotkeyError.value = '';
  persist({ hotkey: binding });
};

const openProperties = () => {
  closeEditor();
  openItemProperties(props.item.uuid);
};

const confirmRemove = () => {
  closeEditor();
  emit('remove');
};

const drawWaveform = () => {
  const canvas = waveformCanvas.value;
  const peaks = props.item.waveform?.peaks;
  if (!canvas || !peaks?.length) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  context.strokeStyle = props.item.color || '#315FCF';
  context.globalAlpha = 0.58;
  context.lineWidth = 1;
  const middle = rect.height / 2;
  context.beginPath();
  for (let x = 0; x < rect.width; x++) {
    const peak = Math.max(0, Math.min(1, peaks[Math.min(peaks.length - 1, Math.floor(x / rect.width * peaks.length))] || 0));
    const height = Math.max(1, peak * rect.height * 0.46);
    context.moveTo(x + 0.5, middle - height);
    context.lineTo(x + 0.5, middle + height);
  }
  context.stroke();
};

watch(() => [props.item.waveform?.peaks, props.item.color], () => nextTick(drawWaveform), { deep: false });

onMounted(() => {
  document.addEventListener('keydown', handleDocumentKeydown, true);
  resizeObserver = new ResizeObserver(drawWaveform);
  if (waveformCanvas.value) resizeObserver.observe(waveformCanvas.value);
  nextTick(drawWaveform);
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleDocumentKeydown, true);
  if (quickPlayEditor.value?.uuid === props.item.uuid) closeEditor();
  resizeObserver?.disconnect();
});
</script>

<style scoped>
.one-shot-tile {
  --one-shot-color: var(--color-accent);
  position: relative;
  min-width: 0;
  isolation: isolate;
  display: grid;
  grid-template-rows: 22px minmax(0, 1fr) 31px;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) var(--spacing-sm);
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-sm);
  background: var(--color-surface);
  color: var(--color-text-primary);
  cursor: grab;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast);
}

.one-shot-tile:active { cursor: grabbing; }
.one-shot-tile.is-dragging {
  opacity: 0.58;
  transform: scale(0.985);
}

.one-shot-tile.show-mode {
  grid-template-rows: 22px minmax(0, 1fr) 36px;
  cursor: default;
}

.one-shot-tile.is-playing {
  border-color: var(--state-playing);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--state-playing) 48%, transparent);
}

.one-shot-tile.is-playing.is-paused {
  border-color: var(--color-text-tertiary);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-text-tertiary) 45%, transparent);
}

.one-shot-waveform,
.one-shot-progress {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  pointer-events: none;
}

.one-shot-waveform { z-index: -1; opacity: 0.42; }
.one-shot-progress {
  right: auto;
  z-index: -1;
  background: color-mix(in srgb, var(--state-playing) 17%, transparent);
}

.one-shot-tile.is-paused .one-shot-progress {
  background: color-mix(in srgb, var(--color-text-tertiary) 17%, transparent);
}

.one-shot-color-rail {
  position: absolute;
  inset-block: 0;
  inset-inline-start: 0;
  inline-size: 3px;
  background: var(--one-shot-color);
}

.one-shot-topline {
  min-width: 0;
  min-height: 22px;
  display: grid;
  grid-template-columns: 3ch minmax(0, 1fr) 7ch;
  grid-template-areas: 'index hotkey time';
  align-items: center;
  gap: var(--spacing-xs);
  color: var(--color-text-secondary);
  font-size: clamp(9px, calc(11px * var(--one-shot-font-scale, 1)), 12px);
  font-weight: 700;
  letter-spacing: .04em;
  line-height: 1;
  text-transform: uppercase;
}

.one-shot-index {
  grid-area: index;
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-primary);
  font: inherit;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.one-shot-bottomline {
  min-width: 0;
  min-height: 31px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.one-shot-runtime-state {
  min-width: 0;
  overflow: hidden;
  align-self: start;
  font: 600 calc(11px * var(--one-shot-font-scale, 1)) / 1.2 var(--font-mono);
  color: var(--state-playing);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.one-shot-runtime-state.is-paused {
  color: var(--color-text-secondary);
}

.one-shot-video-issue {
  color: var(--color-danger);
  font: 700 calc(11px * var(--one-shot-font-scale, 1)) / 1.2 var(--font-mono);
}

.one-shot-hotkey {
  grid-area: hotkey;
  justify-self: end;
  min-width: 0;
  max-width: 100%;
  padding: 2px 4px;
  overflow: hidden;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--control-radius);
  background: color-mix(in srgb, var(--color-surface-raised) 88%, transparent);
  color: var(--color-text-primary);
  font: 600 calc(10px * var(--one-shot-font-scale, 1)) / 1.2 var(--font-mono, ui-monospace, monospace);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.one-shot-body {
  display: grid;
  align-content: start;
  gap: var(--spacing-xs);
  min-height: 0;
  overflow: hidden;
}

.one-shot-title {
  min-width: 0;
  min-height: 0;
  align-self: start;
  display: -webkit-box;
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: calc(15px * var(--one-shot-font-scale, 1));
  font-weight: 700;
  line-height: 1.15;
  text-shadow: 0 1px 2px var(--color-background);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.one-shot-duration {
  grid-area: time;
  justify-self: end;
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-secondary);
  font: 600 clamp(10px, calc(13px * var(--one-shot-font-scale, 1)), 12px) / 1.2 var(--font-mono, ui-monospace, monospace);
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}


.one-shot-actions {
  position: relative;
  z-index: 2;
  width: 100%;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--control-radius);
  background: color-mix(in srgb, var(--color-surface-raised) 92%, transparent);
  box-shadow: inset 0 1px rgb(255 255 255 / 4%);
}

.one-shot-control,
.popover-close,
.shortcut-clear {
  width: 30px;
  height: 30px;
  display: inline-grid;
  place-items: center;
  padding: 0;
  border: 1px solid var(--color-border-strong);
  border-radius: 7px;
  background: var(--color-surface-raised);
  color: var(--color-text-primary);
}

.one-shot-actions .one-shot-control {
  width: 100%;
  height: 29px;
  border: 0;
  border-radius: 0;
  background: transparent;
  cursor: pointer;
}

.one-shot-actions .one-shot-control + .one-shot-control {
  border-inline-start: 1px solid var(--color-border);
}

.one-shot-actions .one-shot-transport {
  background-color: color-mix(in srgb, var(--state-playing) 9%, var(--color-control));
  color: var(--state-playing);
}

.one-shot-actions .one-shot-transport:hover {
  background-color: color-mix(in srgb, var(--state-playing) 17%, var(--color-control));
}

.one-shot-actions .one-shot-transport.is-stop {
  background-color: var(--color-danger);
  color: var(--color-text-on-accent);
}

/* Lit in the Up Next colour: this QuickPlay hands over to Up Next when it ends. */
.one-shot-actions .one-shot-follow.is-on {
  background-color: color-mix(in srgb, var(--state-up-next) 24%, var(--color-control));
  color: var(--state-up-next);
}

.one-shot-actions .one-shot-follow:disabled {
  cursor: default;
  opacity: 0.45;
}

.one-shot-actions .material-symbols-rounded {
  font-size: 19px;
  font-variation-settings: 'FILL' 0, 'wght' 520, 'GRAD' 0, 'opsz' 20;
}
.show-mode .one-shot-actions { width: 100%; grid-auto-columns: minmax(0, 1fr); }
.show-mode .one-shot-control { width: 34px; height: 34px; }
.show-mode .one-shot-actions .one-shot-control { width: 100%; height: 34px; }
.one-shot-control:hover,
.one-shot-control.is-active { background: var(--color-surface-hover); border-color: var(--color-text-tertiary); }
.one-shot-control:focus-visible {
  outline: 2px solid var(--color-focus, var(--color-accent));
  outline-offset: -3px;
}
.one-shot-remove:hover { background: color-mix(in srgb, var(--color-danger) 14%, transparent); color: var(--color-danger); }

.quickplay-settings,
.quickplay-remove {
  width: min(100%, var(--settings-width));
  padding: var(--spacing-sm) var(--workspace-gutter);
}

.quickplay-settings {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr));
  align-items: start;
  gap: var(--spacing-sm);
}

.quickplay-settings-title,
.detached-mutation-error,
.quickplay-settings-actions { grid-column: 1 / -1; }
.quickplay-settings-title { margin: 0; font-size: var(--type-metadata-size); }
.quickplay-settings-actions { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); }

.popover-field { display: grid; gap: 4px; min-width: 0; color: var(--color-text-secondary); font-size: 12px; }
.popover-field > span:first-child { display: flex; justify-content: space-between; gap: 8px; }
.popover-field input[type='number'] {
  width: 100%;
  min-height: var(--settings-control-height);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background: var(--color-surface);
  color: var(--color-text-primary);
}
.popover-field--range input { width: 100%; }
.popover-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.number-with-unit { position: relative; display: flex; align-items: center; }
.number-with-unit input { padding-right: 22px; }
.number-with-unit > span { position: absolute; right: 8px; color: var(--color-text-tertiary); pointer-events: none; }
.shortcut-row { display: flex; gap: 6px; }
.shortcut-capture {
  min-height: 32px;
  flex: 1;
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background: var(--color-surface);
  color: var(--color-text-primary);
}
.shortcut-capture.is-capturing { border-color: var(--color-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 25%, transparent); }
.popover-error { color: var(--color-danger); }
.detached-mutation-error { display: block; margin-bottom: 8px; }
.quickplay-remove p { margin: 5px 0; color: var(--color-text-secondary); font-size: 12px; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 7px; }
.confirm-actions button { min-height: 32px; padding: 0 11px; border: 1px solid var(--color-border); border-radius: var(--control-radius); background: var(--color-surface); color: var(--color-text-primary); }
.confirm-actions .confirm-remove { border-color: var(--color-danger); color: var(--color-danger); }
.confirm-actions .confirm-remove:hover { background: var(--color-danger); color: white; }

@media (prefers-reduced-motion: no-preference) {
  .one-shot-tile,
  .one-shot-control { transition: border-color 120ms ease, background-color 120ms ease, box-shadow 120ms ease; }
}
</style>
