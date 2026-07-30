<template>
  <transition name="fade">
    <div v-if="visible" class="audio-load-progress" :class="{ failed: progress.failedCount > 0 }" role="status">
      <div v-if="progress.loading" class="audio-load-spinner"></div>
      <span v-else class="material-symbols-rounded audio-load-error">error</span>
      <div class="audio-load-text">
        <div class="audio-load-title">
          {{ progress.loading ? t('common.loading') : 'Audio files unavailable' }}
        </div>
        <div class="audio-load-meta">
          {{ progress.loaded }} / {{ progress.total }}
          <span v-if="progress.failedCount"> · {{ progress.failedCount }} failed</span>
          <span class="audio-load-percent">({{ percent }}%)</span>
        </div>
        <div v-if="progress.failedCount" class="audio-load-failures">
          <div v-for="failure in progress.failures.slice(0, 3)" :key="failure.itemUuid || failure.path">
            {{ basename(failure.path) }} — {{ failure.code }}
          </div>
          <div v-if="progress.failures.length > 3">
            +{{ progress.failures.length - 3 }} more
          </div>
        </div>
      </div>
      <div class="audio-load-bar">
        <div class="audio-load-bar-fill" :style="{ width: percent + '%' }"></div>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
const { t } = useLocalization();
const { audioLoadingProgress } = useProject();

const visible = computed(() =>
  (audioLoadingProgress.value.loading && audioLoadingProgress.value.total > 0) ||
  audioLoadingProgress.value.failedCount > 0,
);
const progress = computed(() => audioLoadingProgress.value);
const percent  = computed(() => {
  const p = audioLoadingProgress.value;
  if (!p.total) return 0;
  return Math.round((p.loaded / p.total) * 100);
});
const basename = (path: string) => path.split(/[\\/]/).pop() || path;
</script>

<style scoped>
.audio-load-progress {
  position: fixed;
  bottom: 16px;
  right: 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: var(--color-surface);
  color: var(--color-text-primary);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.3);
  z-index: 1500;
  min-width: 220px;
}
.audio-load-progress.failed {
  border-color: var(--color-danger, #da1e28);
}

.audio-load-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: audio-load-spin 0.85s linear infinite;
  flex-shrink: 0;
}
@keyframes audio-load-spin {
  to { transform: rotate(360deg); }
}
.audio-load-error {
  color: var(--color-danger, #da1e28);
}

.audio-load-text {
  display: flex;
  flex-direction: column;
  flex: 1;
}

.audio-load-title {
  font-size: 12px;
  font-weight: 600;
}
.audio-load-meta {
  font-size: 11px;
  color: var(--color-text-secondary);
}
.audio-load-percent {
  margin-left: 4px;
}
.audio-load-failures {
  margin-top: 4px;
  color: var(--color-danger, #da1e28);
  font-family: var(--font-mono);
  font-size: 10px;
}

.audio-load-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: var(--color-border);
  border-radius: 0 0 8px 8px;
  overflow: hidden;
}
.audio-load-bar-fill {
  height: 100%;
  background: var(--color-accent);
  transition: width 0.2s ease;
}

.fade-enter-active, .fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}
</style>
