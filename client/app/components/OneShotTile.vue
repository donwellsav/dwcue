<template>
  <article
    ref="root"
    class="one-shot-tile"
    :class="{ 'is-playing': isPlaying, 'show-mode': showMode, 'is-armed': armed, 'is-menu-open': menuOpen || removeOpen, 'is-dragging': isDragging }"
    :style="tileStyle"
    :draggable="!showMode"
    @dragstart="handleDragStart"
    @dragend="handleDragEnd"
  >
    <canvas ref="waveformCanvas" class="one-shot-waveform" aria-hidden="true"></canvas>
    <span class="one-shot-color-rail" aria-hidden="true"></span>
    <span v-if="isPlaying" class="one-shot-progress" :style="progressStyle" aria-hidden="true"></span>
    <button
      v-if="showMode"
      type="button"
      class="one-shot-trigger-surface"
      :aria-label="triggerLabel"
      @click="handleTrigger"
    ></button>

    <div class="one-shot-topline">
      <span class="one-shot-mode"><b>{{ position + 1 }}</b></span>
      <span class="one-shot-topline__meta">
        <kbd v-if="hotkeyLabel" class="one-shot-hotkey">{{ hotkeyLabel }}</kbd>
        <span class="one-shot-duration">{{ currentTimeLabel }}</span>
        <button
          type="button"
          class="one-shot-arm-toggle"
          :class="{ 'is-armed': armed }"
          :aria-pressed="armed"
          :aria-label="armed ? t('oneShots.disarmCell', { name: item.displayName }) : t('oneShots.armCell', { name: item.displayName })"
          :title="armed ? t('oneShots.disarmCell', { name: item.displayName }) : t('oneShots.armCell', { name: item.displayName })"
          @click.stop="toggleArmed"
        >{{ armed ? 'ARMED' : 'UNARMED' }}</button>
      </span>
    </div>

    <div class="one-shot-title" :title="item.displayName">{{ item.displayName }}</div>

    <div class="one-shot-bottomline">
      <div class="one-shot-actions">
        <button
          v-if="!showMode || isPlaying"
          type="button"
          class="one-shot-control one-shot-transport"
          :class="{ 'is-stop': isPlaying }"
          :aria-label="transportLabel"
          :title="transportLabel"
          @click.stop="handleTransport"
        >
          <span class="material-symbols-rounded" aria-hidden="true">{{ isPlaying ? 'stop' : 'play_arrow' }}</span>
        </button>
        <button
          v-if="!showMode"
          type="button"
          class="one-shot-control"
          :class="{ 'is-active': menuOpen }"
          :aria-label="t('oneShots.settingsFor', { name: item.displayName })"
          :title="t('oneShots.settings')"
          :aria-expanded="menuOpen"
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

    <Teleport to="body">
      <div
        v-if="menuOpen"
        ref="menuPopover"
        class="one-shot-popover"
        role="dialog"
        :style="overlayStyle"
        :aria-label="t('oneShots.settingsFor', { name: item.displayName })"
        @click.stop
      >
        <div class="popover-heading">
          <strong>{{ t('oneShots.settings') }}</strong>
          <button type="button" class="popover-close" :aria-label="t('actions.close')" @click="menuOpen = false">
            <span class="material-symbols-rounded" aria-hidden="true">close</span>
          </button>
        </div>

        <button v-if="!showMode" type="button" class="popover-command" @click="requestImport">
          <span class="material-symbols-rounded" aria-hidden="true">upload_file</span>
          {{ t('oneShots.replaceAudio') }}
        </button>

        <label class="popover-field">
          <span>{{ t('oneShots.playback') }}</span>
          <select :value="playbackMode" @change="onPlaybackModeChange">
            <option value="overlay">{{ t('oneShots.overlay') }}</option>
            <option value="duck">{{ t('oneShots.duck') }}</option>
            <option value="replace">{{ t('oneShots.replace') }}</option>
          </select>
        </label>

        <label class="popover-field">
          <span>{{ t('oneShots.retrigger') }}</span>
          <select :value="item.oneShot?.retrigger ?? 'restart'" @change="onRetriggerChange">
            <option value="restart">{{ t('oneShots.restart') }}</option>
            <option value="ignore">{{ t('oneShots.ignore') }}</option>
          </select>
        </label>
        <label class="popover-field popover-field--checkbox">
          <input
            type="checkbox"
            :checked="item.oneShot?.autoDisarm !== false"
            @change="onAutoDisarmChange"
          />
          <span>{{ t('oneShots.autoDisarm') }}</span>
        </label>

        <label class="popover-field">
          <span>{{ t('oneShots.ending') }}</span>
          <select :value="endMode" @change="onEndModeChange">
            <option value="stop">{{ t('oneShots.stop') }}</option>
            <option value="loop">{{ t('oneShots.loop') }}</option>
          </select>
        </label>

        <label class="popover-field popover-field--range">
          <span>{{ t('oneShots.gain') }} <output>{{ volumeDb.toFixed(1) }} dB</output></span>
          <input class="app-range" type="range" min="-60" max="12" step="0.5" :value="volumeDb" @input="onVolumeInput" @change="persist" />
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
            <input class="app-range" type="range" min="-60" max="0" step="0.5" :value="duckDb" @input="onDuckInput" @change="persist" />
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

        <label class="popover-field">
          <span>{{ t('oneShots.output') }}</span>
          <select :value="(item as any).deviceOverride ?? ''" @change="onOutputChange">
            <option value="">{{ t('settings.useProjectDefault') }}</option>
            <option v-for="device in devices" :key="device.id" :value="device.id">{{ device.display_name }}</option>
          </select>
        </label>

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

        <button type="button" class="open-properties" @click="openProperties">
          <span class="material-symbols-rounded" aria-hidden="true">tune</span>
          {{ t('oneShots.openProperties') }}
        </button>
      </div>

      <div
        v-if="removeOpen"
        ref="removePopover"
        class="one-shot-confirm"
        role="alertdialog"
        :style="overlayStyle"
        :aria-label="t('oneShots.removeConfirmTitle')"
        @click.stop
      >
        <strong>{{ t('oneShots.removeConfirmTitle') }}</strong>
        <p>{{ t('oneShots.removeConfirmBody') }}</p>
        <div class="confirm-actions">
          <button type="button" @click="removeOpen = false">{{ t('common.cancel') }}</button>
          <button type="button" class="confirm-remove" @click="confirmRemove">{{ t('oneShots.remove') }}</button>
        </div>
      </div>
    </Teleport>
  </article>
</template>

<script setup lang="ts">
import type { AudioItem } from '~/types/project';
import {
  getOneShotEndMode,
  getOneShotPlaybackMode,
  setOneShotEndMode,
  setOneShotPlaybackMode,
  type OneShotEndMode,
  type OneShotPlaybackMode,
} from '~/utils/oneShots';
import { eventToBinding, formatKeyLabel, isReservedCombo } from '~/composables/useCartHotkeys';
import { oneShotFireActionKey, runAcknowledgedAction } from '~/utils/acknowledgedAction';

const props = defineProps<{ item: AudioItem; position: number }>();
const emit = defineEmits<{
  (event: 'request-import'): void;
  (event: 'remove'): void;
}>();
const root = ref<HTMLElement | null>(null);
const waveformCanvas = ref<HTMLCanvasElement | null>(null);
const menuPopover = ref<HTMLElement | null>(null);
const removePopover = ref<HTMLElement | null>(null);
const menuOpen = ref(false);
const removeOpen = ref(false);
const overlayStyle = ref({ left: '8px', top: '8px' });
const capturingHotkey = ref(false);
const hotkeyError = ref('');
const isDragging = ref(false);
let resizeObserver: ResizeObserver | null = null;

const { uiMode } = useUiMode();
const { t } = useLocalization();
const { saveProject, openItemProperties } = useProject();
const { activeCues, playCue, stopCue } = useAudioEngine();
const { updateBinding } = useCartHotkeys();
const server = useLiveplayServer();

const showMode = computed(() => uiMode.value === 'playback');
const { isArmed, setArmed, fireBlocked, afterFire } = useOneShotArm();
const armed = computed(() => isArmed(props.item));
const toggleArmed = () => { setArmed(props.item, !armed.value); persist(); };
const activeCue = computed(() => activeCues.value.get(props.item.uuid));
const isPlaying = computed(() => !!activeCue.value);
const devices = computed(() => server.devices ?? []);
const playbackMode = computed(() => getOneShotPlaybackMode(props.item));
const endMode = computed(() => getOneShotEndMode(props.item));
const volumeDb = computed(() => props.item.volume > 0 ? 20 * Math.log10(props.item.volume) : -60);
const duckDb = computed(() => {
  const level = props.item.duckingBehavior.duckLevel ?? 0.1;
  return level > 0 ? Math.max(-60, 20 * Math.log10(level)) : -60;
});
const hotkeyLabel = computed(() => props.item.oneShot?.hotkey
  ? formatKeyLabel(props.item.oneShot.hotkey) : '');
const transportLabel = computed(() => isPlaying.value
  ? t('oneShots.stopNamed', { name: props.item.displayName })
  : t('oneShots.playNamed', { name: props.item.displayName }));
const triggerLabel = computed(() => isPlaying.value && props.item.oneShot?.retrigger === 'ignore'
  ? t('oneShots.playingIgnored', { name: props.item.displayName })
  : t('oneShots.triggerNamed', { name: props.item.displayName }));
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

const persist = () => { void saveProject(); };
const onAutoDisarmChange = (event: Event) => {
  if (!props.item.oneShot) return;
  if ((event.target as HTMLInputElement).checked) delete props.item.oneShot.autoDisarm;
  else props.item.oneShot.autoDisarm = false;
  persist();
};

const requestImport = () => {
  menuOpen.value = false;
  emit('request-import');
};

const handleTrigger = async () => {
  if (isPlaying.value && props.item.oneShot?.retrigger === 'ignore') return;
  // Show-mode arm gate: only re-safe after confirmed playback.
  if (fireBlocked(props.item)) return false;
  return runAcknowledgedAction(
    oneShotFireActionKey(props.item.uuid),
    () => playCue(props.item),
    () => afterFire(props.item),
  );
};

const handleTransport = () => {
  // Stop is never gated. The play branch only exists in edit mode (in show
  // mode this button is stop-only), so the per-cell arm gate does not apply.
  return isPlaying.value ? stopCue(props.item.uuid) : playCue(props.item);
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

const positionOverlay = (anchor: HTMLElement, kind: 'menu' | 'remove') => {
  const anchorRect = anchor.getBoundingClientRect();
  const width = kind === 'menu' ? 310 : 286;
  const rightSide = anchorRect.right + 8;
  const left = rightSide + width <= window.innerWidth - 8
    ? rightSide
    : Math.max(8, anchorRect.left - width - 8);
  overlayStyle.value = { left: `${left}px`, top: `${Math.max(8, anchorRect.top)}px` };
  nextTick(() => {
    const popover = kind === 'menu' ? menuPopover.value : removePopover.value;
    if (!popover) return;
    const height = popover.getBoundingClientRect().height;
    const top = Math.max(8, Math.min(anchorRect.top, window.innerHeight - height - 8));
    overlayStyle.value = { left: `${left}px`, top: `${top}px` };
  });
};

const toggleMenu = (event: MouseEvent) => {
  menuOpen.value = !menuOpen.value;
  removeOpen.value = false;
  capturingHotkey.value = false;
  hotkeyError.value = '';
  if (menuOpen.value) positionOverlay(event.currentTarget as HTMLElement, 'menu');
};

const toggleRemove = (event: MouseEvent) => {
  removeOpen.value = !removeOpen.value;
  menuOpen.value = false;
  if (removeOpen.value) positionOverlay(event.currentTarget as HTMLElement, 'remove');
};

const onPlaybackModeChange = (event: Event) => {
  setOneShotPlaybackMode(props.item, (event.target as HTMLSelectElement).value as OneShotPlaybackMode);
  persist();
};

const onEndModeChange = (event: Event) => {
  setOneShotEndMode(props.item, (event.target as HTMLSelectElement).value as OneShotEndMode);
  persist();
};

const onRetriggerChange = (event: Event) => {
  if (!props.item.oneShot) return;
  props.item.oneShot.retrigger = (event.target as HTMLSelectElement).value as 'restart' | 'ignore';
  persist();
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
  props.item[field] = clampNumber(event, 0, 30);
  persist();
};

const onDuckFadeChange = (field: 'duckFadeIn' | 'duckFadeOut', event: Event) => {
  props.item.duckingBehavior[field] = clampNumber(event, 0, 10);
  persist();
};

const onOutputChange = (event: Event) => {
  const value = (event.target as HTMLSelectElement).value;
  if (value) (props.item as any).deviceOverride = value;
  else delete (props.item as any).deviceOverride;
  persist();
};

const startHotkeyCapture = () => {
  capturingHotkey.value = true;
  hotkeyError.value = '';
};

const clearHotkey = () => {
  if (props.item.oneShot) delete props.item.oneShot.hotkey;
  capturingHotkey.value = false;
  persist();
};

const handleDocumentKeydown = (event: KeyboardEvent) => {
  if (!capturingHotkey.value) {
    if (event.key === 'Escape') {
      menuOpen.value = false;
      removeOpen.value = false;
    }
    return;
  }
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.key === 'Escape') {
    capturingHotkey.value = false;
    return;
  }
  const binding = eventToBinding(event);
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
  persist();
};

const handleDocumentPointerdown = (event: PointerEvent) => {
  const target = event.target as Node;
  if (root.value?.contains(target) || menuPopover.value?.contains(target) || removePopover.value?.contains(target)) return;
  menuOpen.value = false;
  removeOpen.value = false;
  capturingHotkey.value = false;
};

const openProperties = () => {
  menuOpen.value = false;
  openItemProperties(props.item.uuid);
};

const confirmRemove = () => {
  removeOpen.value = false;
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
  document.addEventListener('pointerdown', handleDocumentPointerdown);
  resizeObserver = new ResizeObserver(drawWaveform);
  if (waveformCanvas.value) resizeObserver.observe(waveformCanvas.value);
  nextTick(drawWaveform);
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleDocumentKeydown, true);
  document.removeEventListener('pointerdown', handleDocumentPointerdown);
  resizeObserver?.disconnect();
});
</script>

<style scoped>
.one-shot-tile {
  --one-shot-color: var(--color-accent);
  position: relative;
  min-width: 0;
  isolation: isolate;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px 9px 9px 12px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--one-shot-color) 36%, var(--color-border));
  border-radius: var(--radius-md, 8px);
  background: color-mix(in srgb, var(--one-shot-color) 10%, var(--color-surface));
  color: var(--color-text-primary);
  box-shadow: 0 1px 0 rgb(255 255 255 / 3%) inset;
  cursor: grab;
}

.one-shot-tile:active { cursor: grabbing; }
.one-shot-tile.is-dragging {
  opacity: 0.58;
  transform: scale(0.985);
}

.one-shot-tile.show-mode {
  padding: 10px;
  cursor: pointer;
}

.one-shot-tile.show-mode:hover,
.one-shot-tile.show-mode:has(.one-shot-trigger-surface:focus-visible) {
  border-color: color-mix(in srgb, var(--one-shot-color) 72%, white 10%);
  background: color-mix(in srgb, var(--one-shot-color) 16%, var(--color-surface));
  outline: none;
}

.one-shot-trigger-surface {
  position: absolute;
  z-index: 1;
  inset: 0;
  padding: 0;
  border: 0;
  border-radius: inherit;
  background: transparent;
  cursor: pointer;
}

.one-shot-trigger-surface:focus-visible {
  outline: 2px solid var(--color-focus, var(--color-accent));
  outline-offset: -3px;
}

.one-shot-tile.is-playing {
  border-color: var(--state-playing);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--state-playing) 55%, transparent),
              0 0 18px color-mix(in srgb, var(--state-playing) 16%, transparent);
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
  border-radius: inherit 0 0 inherit;
  background: color-mix(in srgb, var(--state-playing) 17%, transparent);
}

.one-shot-color-rail {
  position: absolute;
  inset: 8px auto 8px 5px;
  width: 3px;
  border-radius: 999px;
  background: var(--one-shot-color);
}

.one-shot-topline,
.one-shot-bottomline {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.one-shot-topline__meta {
  min-width: 0;
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}

.one-shot-mode {
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: calc(11px * var(--one-shot-font-scale, 1));
  font-weight: 700;
  letter-spacing: .06em;
  text-transform: uppercase;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.one-shot-mode b {
  margin-right: 6px;
  color: var(--color-text-primary);
  font: inherit;
}

.one-shot-hotkey {
  flex: 0 0 auto;
  padding: 2px 4px;
  border: 1px solid var(--color-border-strong);
  border-radius: 5px;
  background: color-mix(in srgb, var(--color-surface-raised) 88%, transparent);
  color: var(--color-text-primary);
  font: 600 calc(10px * var(--one-shot-font-scale, 1)) / 1.2 var(--font-mono, ui-monospace, monospace);
}

.one-shot-title {
  min-height: 2.3em;
  flex: 1;
  display: -webkit-box;
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: calc(15px * var(--one-shot-font-scale, 1));
  font-weight: 700;
  line-height: 1.15;
  text-shadow: 0 1px 2px var(--color-background), 0 0 5px var(--color-background);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.show-mode .one-shot-title {
  min-height: 2.15em;
  font-size: calc(15px * var(--one-shot-font-scale, 1));
}

.one-shot-duration {
  flex: 0 0 auto;
  color: var(--color-text-secondary);
  font: 600 calc(13px * var(--one-shot-font-scale, 1)) / 1.2 var(--font-mono, ui-monospace, monospace);
  font-variant-numeric: tabular-nums;
}

.one-shot-bottomline {
  margin-top: auto;
}

.one-shot-actions {
  position: relative;
  z-index: 2;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--control-radius);
  background: color-mix(in srgb, var(--color-surface-raised) 92%, transparent);
  box-shadow: inset 0 1px rgb(255 255 255 / 4%);
}

.one-shot-tile:not(.show-mode) .one-shot-actions {
  width: 100%;
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

.one-shot-actions .material-symbols-rounded {
  font-size: 19px;
  font-variation-settings: 'FILL' 0, 'wght' 520, 'GRAD' 0, 'opsz' 20;
}
/* Per-cell arm: the toggle sits first in the actions row. Armed = hot
   danger tint on the toggle and a ring around the whole tile so the cell's
   state reads from across the desk. In show mode, disarmed idle tiles dim
   (playing tiles keep full contrast — their stop control must stay obvious). */
.popover-field--checkbox {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.popover-field--checkbox input {
  margin: 0;
}

.one-shot-arm-toggle {
  position: relative;
  z-index: 2;
  flex: 0 0 auto;
  padding: 3px 7px;
  border: 1px solid var(--color-text-tertiary);
  border-radius: 5px;
  background: color-mix(in srgb, var(--color-surface-raised) 88%, transparent);
  color: var(--color-text-primary);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .08em;
  line-height: 1.4;
  cursor: pointer;
}

.one-shot-arm-toggle:hover { background: var(--color-surface-hover); color: var(--color-text-primary); }

.one-shot-arm-toggle.is-armed {
  border-color: color-mix(in srgb, var(--color-danger, #e5484d) 55%, transparent);
  background: color-mix(in srgb, var(--color-danger, #e5484d) 16%, transparent);
  color: var(--color-danger, #e5484d);
}

.one-shot-tile.is-armed {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-danger, #e5484d) 80%, transparent),
    0 0 14px color-mix(in srgb, var(--color-danger, #e5484d) 35%, transparent);
}

.one-shot-tile.show-mode:not(.is-armed):not(.is-playing) {
  opacity: 0.55;
}

.show-mode .one-shot-bottomline { justify-content: flex-end; }
.show-mode .one-shot-actions { grid-auto-columns: 34px; }
.show-mode .one-shot-control { width: 34px; height: 34px; }
.one-shot-control:hover,
.one-shot-control.is-active { background: var(--color-surface-hover); border-color: var(--color-text-tertiary); }
.one-shot-control:focus-visible {
  outline: 2px solid var(--color-focus, var(--color-accent));
  outline-offset: -3px;
}
.one-shot-transport {
  background: color-mix(in srgb, var(--one-shot-color) 18%, transparent);
  color: color-mix(in srgb, var(--one-shot-color) 62%, white);
}
.one-shot-transport:hover { background: color-mix(in srgb, var(--one-shot-color) 26%, transparent); }
.one-shot-transport.is-stop { background: var(--color-danger); border-color: var(--color-danger); color: white; }
.one-shot-remove:hover { background: color-mix(in srgb, var(--color-danger) 14%, transparent); color: var(--color-danger); }

.one-shot-popover,
.one-shot-confirm {
  position: fixed;
  z-index: 1000;
  width: min(310px, calc(100vw - 32px));
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  padding: 12px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md, 8px);
  background: var(--color-surface-raised);
  box-shadow: 0 14px 34px rgb(0 0 0 / 42%);
  color: var(--color-text-primary);
  cursor: default;
}

.popover-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.popover-close { width: 26px; height: 26px; border-color: transparent; background: transparent; }
.popover-command {
  width: 100%;
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background: var(--color-surface);
  color: var(--color-text-primary);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.popover-command:hover { background: var(--color-surface-hover); border-color: var(--color-border-strong); }
.popover-command:focus-visible { outline: 2px solid var(--color-focus, var(--color-accent)); outline-offset: 2px; }
.popover-command .material-symbols-rounded { font-size: 18px; }
.popover-field { display: grid; gap: 5px; margin-top: 9px; color: var(--color-text-secondary); font-size: 12px; }
.popover-field > span:first-child { display: flex; justify-content: space-between; gap: 8px; }
.popover-field select,
.popover-field input[type='number'] {
  width: 100%;
  min-height: 32px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
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
  border-radius: 6px;
  background: var(--color-surface);
  color: var(--color-text-primary);
}
.shortcut-capture.is-capturing { border-color: var(--color-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 25%, transparent); }
.popover-error { color: var(--color-danger); }
.open-properties {
  width: 100%;
  min-height: 34px;
  margin-top: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 1px solid var(--color-border-strong);
  border-radius: 7px;
  background: var(--color-surface-hover);
  color: var(--color-text-primary);
}

.one-shot-confirm { width: min(286px, calc(100vw - 32px)); }
.one-shot-confirm p { margin: 7px 0 12px; color: var(--color-text-secondary); font-size: 12px; line-height: 1.4; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 7px; }
.confirm-actions button { min-height: 32px; padding: 0 11px; border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-surface); color: var(--color-text-primary); }
.confirm-actions .confirm-remove { border-color: var(--color-danger); color: var(--color-danger); }
.confirm-actions .confirm-remove:hover { background: var(--color-danger); color: white; }

@media (prefers-reduced-motion: no-preference) {
  .one-shot-tile,
  .one-shot-control { transition: border-color 120ms ease, background-color 120ms ease, box-shadow 120ms ease; }
}
</style>
