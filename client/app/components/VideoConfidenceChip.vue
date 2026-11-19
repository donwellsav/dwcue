<template>
  <button
    v-if="open"
    type="button"
    class="confidence-chip"
    :class="{ 'confidence-chip--stale': stale }"
    :title="confidenceTitle"
    :aria-label="t('standbyCapture.openPanel')"
    :disabled="standbyCapturePending"
    @click="openCapturePanel"
    @keydown.enter.space.stop
  >
    <span class="confidence-chip__health">{{ pictureLabel }}</span>
  </button>
</template>

<script setup lang="ts">
// The output window reports its own picture health; nothing is copied from
// it (a once-a-second copy of the output cost the audience dropped frames).
// Sparse/VFR frames have no universal freeze deadline; show their age literally.

defineProps<{ open: boolean }>();

const { t } = useLocalization();
// A click opens the capture panel. It used to capture at once, for whichever
// cue happened to be selected, and overwrite that cue's picture.
const { openCapturePanel, standbyCapturePending } = useVideoStandbyCapture();

const now = ref(Date.now());
const status = shallowRef<VideoOutputStatus | null>(null);
let stopStatus: (() => void) | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

const health = computed(() => status.value?.pictureHealth ?? null);
const stale = computed(() => health.value === null
  || status.value?.recoveryRequired === true || status.value?.rendererResponsive === false
  || (health.value !== null && now.value - health.value.receivedAt > 3000)
  || health.value?.state === 'error' || health.value?.state === 'clock-wait');
const frameAge = computed(() => health.value?.presentedAgeMs == null ? null
  : Math.floor((health.value.presentedAgeMs + Math.max(0, now.value - health.value.receivedAt)) / 1000));
const pictureLabel = computed(() => {
  if (status.value?.recoveryRequired) return t('videoConfidence.heldBlack');
  const state = health.value?.state;
  if (!state) return t('videoConfidence.unconfirmed');
  if (state === 'playing') return frameAge.value === null ? t('videoConfidence.frameUnconfirmed')
    : t('videoConfidence.frameAge', { seconds: frameAge.value });
  return t(`videoConfidence.states.${state}`);
});
const confidenceTitle = computed(() => `${t('videoConfidence.title')} · ${pictureLabel.value}`
  + (health.value?.preparedSeconds != null ? ` · ${t('videoConfidence.prepared', { seconds: health.value.preparedSeconds })}` : '')
  + (health.value ? ` · PTS ${health.value.mediaTime ?? '?'} · ${t('videoConfidence.dropped', { count: health.value.droppedFrames ?? '?' })}` : '')
  + ` · ${t('standbyCapture.openPanel')}`);
onMounted(() => {
  if (!import.meta.client) return;
  const api = window.electronAPI?.videoOutput;
  if (!api?.onStatus) return;
  stopStatus = api.onStatus((next) => { status.value = next; });
  void api.status().then(next => { status.value = next; }).catch(() => {});
  ticker = setInterval(() => { now.value = Date.now(); }, 1000);
});

onUnmounted(() => {
  stopStatus?.();
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
});
</script>

<style scoped>
.confidence-chip {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: 4px var(--spacing-xs);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background-color: var(--color-control);
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: border-color var(--transition-base);
}

.confidence-chip--stale {
  border-color: var(--color-danger, #e5484d);
  animation: confidence-pulse 1s ease-in-out infinite;
}

@keyframes confidence-pulse {
  50% { border-color: color-mix(in srgb, var(--color-danger, #e5484d) 35%, transparent); }
}

.confidence-chip__health { max-width: 110px; font-size: 11px; }

</style>
