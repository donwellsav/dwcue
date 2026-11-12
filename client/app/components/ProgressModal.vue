<template>
  <div v-if="visible" class="modal-overlay" :class="{ 'progress-background': background }">
    <div class="modal-content" @click.stop>
      <h3>{{ title }}</h3>
      <div class="progress-info">
        <p>{{ message }}</p>
        <div class="progress-percentage">{{ percentage }}%</div>
      </div>
      <div class="progress-bar-container">
        <div class="progress-bar" :style="{ width: percentage + '%' }"></div>
      </div>
      <Btn class="progress-stop-all" type="button" icon="stop_circle" :text="t('controls.stopAll')" @click="server.stopAll()" />
      <Btn v-if="!background" type="button" :text="t('importProgress.returnToShow')" @click="emit('background')" />
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
const { t } = useLocalization();
const server = useLiveplayServer();

defineProps<{
  visible: boolean;
  title: string;
  message: string;
  percentage: number;
  background?: boolean;
}>();

const emit = defineEmits<{
  background: [];
}>();
</script>

<style scoped lang="scss">
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--dialog-backdrop);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.modal-content {
  background: var(--dialog-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--dialog-radius);
  padding: var(--dialog-padding);
  min-width: 400px;
  max-width: 500px;
  box-shadow: var(--dialog-shadow);

  h3 {
    margin: 0 0 16px 0;
    color: var(--color-text-primary);
    font-size: 18px;
    font-weight: 600;
  }
}

.progress-background {
  inset: auto 16px 16px auto;
  max-width: calc(100vw - 32px);
  background: transparent;
  z-index: 1400;

  .modal-content {
    min-width: 0;
    width: min(360px, calc(100vw - 32px));
    overflow-wrap: anywhere;
  }
}

.progress-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;

  p {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: 14px;
    flex: 1;
  }

  .progress-percentage {
    color: var(--color-text-primary);
    font-size: 16px;
    font-weight: 600;
    margin-left: 16px;
  }
}

.progress-bar-container {
  width: 100%;
  height: 8px;
  background: var(--color-background);
  border-radius: 4px;
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  background: var(--color-accent);
  border-radius: 4px;
  transition: width 0.3s ease;
}

.progress-stop-all {
  margin-top: var(--spacing-md);
}
</style>
