<template>
  <div
    v-if="open"
    class="confidence-chip"
    :class="{ 'confidence-chip--stale': stale }"
    :title="t('videoConfidence.title')"
  >
    <div class="confidence-chip__frame">
      <img v-if="frameUrl" :src="frameUrl" :alt="t('videoConfidence.title')" />
    </div>
  </div>
</template>

<script setup lang="ts">
// Confidence monitor: 1 fps thumbnails of the video output window, captured
// in the main process, so the operator sees what the audience sees without
// turning around. A stalled frame IS the alarm — the counter goes red after
// 3 s without an update (cable yank, projector sleep, wedged renderer).

const props = defineProps<{ open: boolean }>();

const { t } = useLocalization();

const frameUrl = ref('');
const lastFrameAt = ref(0);
const now = ref(Date.now());
let stopFrames: (() => void) | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

const secondsAgo = computed(() => Math.max(0, Math.floor((now.value - lastFrameAt.value) / 1000)));
const stale = computed(() => lastFrameAt.value === 0 || secondsAgo.value > 3);
watch(() => props.open, (open) => {
  if (!open) {
    frameUrl.value = '';
    lastFrameAt.value = 0;
  }
});

onMounted(() => {
  if (!import.meta.client) return;
  const api = (window as any).electronAPI?.videoOutput;
  if (!api?.onFrame) return;
  stopFrames = api.onFrame((frame: { jpeg?: string; at?: number }) => {
    if (typeof frame?.jpeg !== 'string' || !frame.jpeg) return;
    frameUrl.value = `data:image/jpeg;base64,${frame.jpeg}`;
    lastFrameAt.value = typeof frame.at === 'number' ? frame.at : Date.now();
    now.value = Date.now();
  });
  ticker = setInterval(() => { now.value = Date.now(); }, 1000);
});

onUnmounted(() => {
  stopFrames?.();
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

</style>
