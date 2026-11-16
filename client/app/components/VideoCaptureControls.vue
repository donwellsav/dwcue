<template>
  <!-- Capturing a picture of the Video Output (or of another screen) and
       saying, at that moment, what it is for. Used in the capture panel and
       in Settings; both show the same state. -->
  <div class="capture-controls">
    <div class="capture-controls__row">
      <span class="capture-controls__label">{{ t('standbyCapture.from') }}</span>
      <InlineChoicePicker id="capture-source" :label="t('standbyCapture.from')" :value="sourceValue"
        :options="sourceOptions" :disabled="standbyCapturePending || settingSource" @change="chooseSource" />
    </div>

    <div class="capture-controls__actions">
      <Btn type="button" icon="photo_camera" :text="t('standbyCapture.asStandby')"
        :disabled="!canCapture" @click="captureStill('standby', source)" />
      <Btn type="button" icon="photo_camera"
        :text="captureCue ? t('standbyCapture.forCue', { cue: cueLabel(captureCue) }) : t('standbyCapture.forCueNone')"
        :disabled="!canCapture || !captureCue" @click="captureStill('cue', source)" />
    </div>
    <p v-if="hint" class="capture-controls__hint">{{ hint }}</p>

    <div v-if="lastCapture" class="capture-controls__result" role="status">
      <img class="capture-controls__thumb" :src="lastCapture.image" alt="" />
      <span class="capture-controls__text">{{ lastCapture.target === 'cue'
        ? t('standbyCapture.cueCaptured', { cue: lastCapture.cueLabel }) : t('standbyCapture.sessionCaptured') }}</span>
      <Btn v-if="canUndo" type="button" icon="undo" :text="t('standbyCapture.undo')" @click="undoCapture" />
    </div>

    <ul class="capture-controls__pictures">
      <li>
        <span class="capture-controls__label">{{ t('standbyCapture.standbyPicture') }}</span>
        <img v-if="standbyUrl" class="capture-controls__thumb" :src="standbyUrl" alt="" />
        <span v-else class="capture-controls__none">{{ t('settings.videoOutputStandbyNone') }}</span>
        <Btn v-if="standbyPath && !hideStandbyClear" type="button" :text="t('standbyCapture.clearButton')"
          @click="clearPicture('standby')" />
      </li>
      <li v-if="captureCue">
        <span class="capture-controls__label">{{ t('standbyCapture.cuePicture', { cue: cueLabel(captureCue) }) }}</span>
        <img v-if="cueUrl" class="capture-controls__thumb" :src="cueUrl" alt="" />
        <span v-else class="capture-controls__none">{{ t('standbyCapture.none') }}</span>
        <Btn v-if="captureCue.imagePath" type="button" :text="t('standbyCapture.clearButton')"
          @click="clearPicture('cue')" />
      </li>
    </ul>
    <p class="capture-controls__hint">{{ t('standbyCapture.help') }}</p>
  </div>
</template>

<script setup lang="ts">
import Btn from './Btn.vue';
import InlineChoicePicker from './InlineChoicePicker.vue';

// Settings has its own Clear beside the standby picture's file name.
defineProps<{ hideStandbyClear?: boolean }>();

const { t } = useLocalization();
const {
  captureStill, undoCapture, clearPicture, canUndo, standbyCapturePending, lastCapture,
  captureCue, cueLabel, standbyPath, pictureUrl,
} = useVideoStandbyCapture();

const api = import.meta.client ? window.electronAPI?.videoOutput : undefined;
const status = ref<VideoOutputStatus | null>(null);
const displays = computed(() => status.value?.displays ?? []);
const settingSource = ref(false);
// What the next capture is taken from. It starts at the Video Output every
// time these controls appear: a capture never comes from another screen
// because of a choice made some other day.
const source = ref<'output' | 'display'>('output');

const sourceValue = computed(() => source.value === 'output' ? 'output' : status.value?.captureDisplayId ?? 'output');
const sourceOptions = computed(() => [
  { value: 'output', label: t('standbyCapture.fromOutput') },
  ...displays.value.map(display => ({
    value: display.id,
    label: `${display.index} · ${display.label} (${display.width} × ${display.height})`,
  })),
]);

async function chooseSource(value: string) {
  if (value === 'output') {
    source.value = 'output';
    return;
  }
  if (!api?.setCaptureSettings) return;
  settingSource.value = true;
  try {
    status.value = await api.setCaptureSettings(value);
    source.value = 'display';
  } catch {
    source.value = 'output';
  } finally {
    settingSource.value = false;
  }
}

const sourceReady = computed(() => source.value === 'output'
  ? status.value?.open === true
  : displays.value.some(display => display.id === status.value?.captureDisplayId));
const canCapture = computed(() => !standbyCapturePending.value && sourceReady.value);
const hint = computed(() => {
  if (source.value === 'output' && status.value && !status.value.open) return t('standbyCapture.needOutput');
  if (!captureCue.value) return t('standbyCapture.selectCue');
  return '';
});

const standbyUrl = computed(() => pictureUrl(standbyPath.value));
const cueUrl = computed(() => pictureUrl(captureCue.value?.imagePath));

let offStatus: (() => void) | undefined;
onMounted(async () => {
  if (!api) return;
  offStatus = api.onStatus(next => { status.value = next; });
  try {
    status.value = await api.status();
  } catch { /* the buttons stay off until the output answers */ }
});
onBeforeUnmount(() => offStatus?.());
</script>

<style scoped>
.capture-controls {
  display: grid;
  gap: var(--spacing-sm);
  min-width: 0;
}

.capture-controls__row,
.capture-controls__actions,
.capture-controls__result,
.capture-controls__pictures li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-sm);
  min-width: 0;
}

.capture-controls__label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A long cue name is cut short rather than pushing a button off the panel. */
.capture-controls__actions :deep(.btn) {
  min-width: 0;
  max-width: min(100%, 46ch);
}

.capture-controls__actions :deep(.btn__text) {
  overflow: hidden;
  text-overflow: ellipsis;
}

.capture-controls__row :deep(.inline-choice-picker) {
  flex: 1 1 220px;
  max-width: 420px;
}

.capture-controls__pictures {
  display: grid;
  gap: var(--spacing-xs);
  margin: 0;
  padding: 0;
  list-style: none;
}

/* The picture as the audience would see it: 16:9, on black. */
.capture-controls__thumb {
  flex: none;
  width: 96px;
  height: 54px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--control-radius);
  background: #000;
  object-fit: contain;
}

.capture-controls__result {
  padding: var(--spacing-xs) var(--spacing-sm);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background: var(--color-control);
}

.capture-controls__text {
  flex: 1 1 16ch;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.capture-controls__none,
.capture-controls__hint {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 12px;
}
</style>
