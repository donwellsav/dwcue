<template>
  <article
    ref="root"
    class="one-shot-tile"
    :class="{ 'is-playing': isPlaying, 'show-mode': showMode, 'is-menu-open': menuOpen || removeOpen }"
    :style="tileStyle"
    :draggable="!showMode"
    @dragstart="handleDragStart"
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
      <span class="one-shot-mode"><b>{{ position + 1 }}</b>{{ modeLabel }}</span>
      <kbd v-if="hotkeyLabel" class="one-shot-hotkey">{{ hotkeyLabel }}</kbd>
    </div>

    <div class="one-shot-title" :title="item.displayName">{{ item.displayName }}</div>

    <div class="one-shot-bottomline">
      <span class="one-shot-duration">{{ currentTimeLabel }}</span>
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
          :aria-label="t('oneShots.replaceAudioFor', { name: item.displayName })"
          :title="t('oneShots.replaceAudio')"
          @click.stop="emit('request-import')"
        >
          <span class="material-symbols-rounded" aria-hidden="true">audio_file</span>
        </button>
        <button
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
          <button type="button" class="popover-close" :aria-label="t('common.close')" @click="menuOpen = false">
            <span class="material-symbols-rounded" aria-hidden="true">close</span>
          </button>
        </div>

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
let resizeObserver: ResizeObserver | null = null;

const { uiMode } = useUiMode();
const { t } = useLocalization();
const { saveProject, openItemProperties } = useProject();
const { activeCues, playCue, stopCue } = useAudioEngine();
const { updateBinding } = useCartHotkeys();
const server = useLiveplayServer();

const showMode = computed(() => uiMode.value === 'playback');
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
const modeLabel = computed(() => playbackMode.value === 'duck'
  ? t('oneShots.duck')
  : playbackMode.value === 'replace' ? t('oneShots.replace') : t('oneShots.overlay'));
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
  return `${formatDuration(activeCue.value.currentTime)} / ${formatDuration(activeCue.value.duration)}`;
});

function formatDuration(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

const persist = () => { void saveProject(); };

const handleTrigger = () => {
  if (isPlaying.value && props.item.oneShot?.retrigger === 'ignore') return;
  void playCue(props.item);
};

const handleTransport = () => {
  if (isPlaying.value) void stopCue(props.item.uuid);
  else void playCue(props.item);
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
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('one-shot-uuid', props.item.uuid);
  event.dataTransfer.setData('one-shot-slot', String(props.position));
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
    hotkeyError.value = t('cart.reserved');
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
  min-height: 106px;
  isolation: isolate;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  overflow: visible;
  border: 1px solid color-mix(in srgb, var(--one-shot-color) 36%, var(--color-border));
  border-radius: var(--radius-md, 8px);
  background: color-mix(in srgb, var(--one-shot-color) 10%, var(--color-surface));
  color: var(--color-text-primary);
  box-shadow: 0 1px 0 rgb(255 255 255 / 3%) inset;
  cursor: grab;
}

.one-shot-tile:active { cursor: grabbing; }

.one-shot-tile.show-mode {
  min-height: 140px;
  padding: 14px;
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.one-shot-mode {
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: 11px;
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
  padding: 2px 6px;
  border: 1px solid var(--color-border-strong);
  border-radius: 5px;
  background: color-mix(in srgb, var(--color-surface-raised) 88%, transparent);
  color: var(--color-text-primary);
  font: 600 11px/1.25 var(--font-mono, ui-monospace, monospace);
}

.one-shot-title {
  min-height: 2.4em;
  flex: 1;
  display: -webkit-box;
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: 15px;
  font-weight: 700;
  line-height: 1.2;
  text-shadow: 0 1px 2px var(--color-background), 0 0 5px var(--color-background);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.show-mode .one-shot-title { font-size: 17px; }

.one-shot-duration {
  color: var(--color-text-secondary);
  font: 600 12px/1.2 var(--font-mono, ui-monospace, monospace);
  font-variant-numeric: tabular-nums;
}

.one-shot-actions { position: relative; z-index: 2; display: flex; gap: 6px; }

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

.show-mode .one-shot-control { width: 36px; height: 36px; }
.one-shot-control:hover,
.one-shot-control:focus-visible,
.one-shot-control.is-active { background: var(--color-surface-hover); border-color: var(--color-text-tertiary); }
.one-shot-transport { border-color: color-mix(in srgb, var(--state-playing) 45%, var(--color-border)); }
.one-shot-transport.is-stop { background: var(--color-danger); border-color: var(--color-danger); color: white; }
.one-shot-remove:hover { color: var(--color-danger); border-color: var(--color-danger); }

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
