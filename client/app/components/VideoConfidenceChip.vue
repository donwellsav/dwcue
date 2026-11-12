<template>
  <div
    v-if="open"
    class="confidence-chip"
    :class="{ 'confidence-chip--stale': stale }"
    :title="confidenceTitle"
  >
    <div class="confidence-chip__frame">
      <img v-if="frameUrl" :src="frameUrl" :alt="t('videoConfidence.title')" />
    </div>
    <span class="confidence-chip__health">{{ pictureLabel }}</span>
  </div>
</template>

<script setup lang="ts">
// Capture delivery and compositor frame progress are separate observations.
// Sparse/VFR frames have no universal freeze deadline; show their age literally.

const props = defineProps<{ open: boolean }>();

const { t } = useLocalization();

const frameUrl = ref('');
const lastFrameAt = ref(0);
const now = ref(Date.now());
const status = shallowRef<VideoOutputStatus | null>(null);
let stopFrames: (() => void) | null = null;
let stopStatus: (() => void) | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

const secondsAgo = computed(() => Math.max(0, Math.floor((now.value - lastFrameAt.value) / 1000)));
const health = computed(() => status.value?.pictureHealth ?? null);
const stale = computed(() => lastFrameAt.value === 0 || secondsAgo.value > 3
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
const confidenceTitle = computed(() => `${t('videoConfidence.title')} · ${pictureLabel.value} · `
  + t('videoConfidence.captureAge', { seconds: secondsAgo.value })
  + (health.value?.preparedSeconds != null ? ` · ${t('videoConfidence.prepared', { seconds: health.value.preparedSeconds })}` : '')
  + (health.value ? ` · PTS ${health.value.mediaTime ?? '?'} · ${t('videoConfidence.dropped', { count: health.value.droppedFrames ?? '?' })}` : ''));
watch(() => props.open, (open) => {
  if (!open) {
    frameUrl.value = '';
    lastFrameAt.value = 0;
  }
});

onMounted(() => {
  if (!import.meta.client) return;
  const api = window.electronAPI?.videoOutput;
  if (!api?.onFrame) return;
  stopFrames = api.onFrame((frame: { jpeg?: string; at?: number }) => {
    if (typeof frame?.jpeg !== 'string' || !frame.jpeg) return;
    frameUrl.value = `data:image/jpeg;base64,${frame.jpeg}`;
    lastFrameAt.value = typeof frame.at === 'number' ? frame.at : Date.now();
    now.value = Date.now();
  });
  stopStatus = api.onStatus((next) => {
    status.value = next;
    if (!next.rendererReady) { frameUrl.value = ''; lastFrameAt.value = 0; }
  });
  void api.status().then(next => { status.value = next; }).catch(() => {});
  ticker = setInterval(() => { now.value = Date.now(); }, 1000);
});

onUnmounted(() => {
  stopFrames?.();
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
  transition: border-color var(--transition-base);
}

.confidence-chip--stale {
  border-color: var(--color-danger, #e5484d);
  animation: confidence-pulse 1s ease-in-out infinite;
}

@keyframes confidence-pulse {
  50% { border-color: color-mix(in srgb, var(--color-danger, #e5484d) 35%, transparent); }
}

.confidence-chip__frame {
  width: 64px;
  height: 36px;
  border-radius: 3px;
  overflow: hidden;
  background: #000;
  flex: 0 0 auto;
}

.confidence-chip__frame img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.confidence-chip__health { max-width: 110px; font-size: 10px; }

</style>
