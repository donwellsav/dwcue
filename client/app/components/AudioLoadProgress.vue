<template>
  <div v-if="visible" class="audio-load-progress" :class="{ failed: progress.failedCount > 0 }" role="status">
    <strong>{{ progress.loading ? t('properties.loadingAudioData') : 'Audio files unavailable' }}</strong>
    <span class="audio-load-count">
      {{ progress.loaded }} / {{ progress.total }}
      <template v-if="progress.failedCount"> · {{ progress.failedCount }} failed</template>
    </span>
    <progress v-if="progress.loading && progress.total > 0" :max="progress.total" :value="progress.loaded" aria-hidden="true" />
    <span v-for="failure in progress.failures.slice(0, 3)" :key="failure.itemUuid || failure.path"
      class="audio-load-failure" :title="`${basename(failure.path)} — ${failure.code}`">
      {{ basename(failure.path) }} — {{ failure.code }}
    </span>
    <span v-if="progress.failures.length > 3">+{{ progress.failures.length - 3 }} more</span>
  </div>
</template>

<script setup lang="ts">
const { t } = useLocalization();
const { audioLoadingProgress: progress } = useProject();
const visible = computed(() => (progress.value.loading && progress.value.total > 0) || progress.value.failedCount > 0);
const basename = (path: string) => path.split(/[\\/]/).pop() || path;
</script>

<style scoped>
.audio-load-progress {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  min-width: 0;
  gap: var(--spacing-xs);
  color: var(--color-text-secondary);
  font-size: var(--type-metadata-size);
}

.audio-load-progress strong { color: var(--color-text-primary); }
.audio-load-progress.failed strong { color: var(--color-danger); }
.audio-load-count { white-space: nowrap; font-variant-numeric: tabular-nums; }
.audio-load-progress progress { width: 64px; accent-color: var(--color-accent); }
.audio-load-failure {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
