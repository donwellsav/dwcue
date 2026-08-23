<template>
  <div class="modal-overlay" @click.self="close">
    <div class="modal-content about-modal">
      <button class="modal-close" @click="close" :title="t('actions.close')">
        <span class="material-symbols-rounded">close</span>
      </button>
      <AboutContent />
    </div>
  </div>
</template>

<script setup lang="ts">
import AboutContent from './AboutContent.vue';

const emit = defineEmits<{
  close: []
}>();

const { t } = useLocalization();

const close = () => {
  emit('close');
};

// Close on Escape key
onMounted(() => {
  const handleEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      close();
    }
  };
  window.addEventListener('keydown', handleEscape);
  onUnmounted(() => {
    window.removeEventListener('keydown', handleEscape);
  });
});
</script>

<style scoped lang="scss">
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: var(--dialog-backdrop);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.modal-content {
  background-color: var(--dialog-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--dialog-radius);
  padding: var(--dialog-padding);
  max-width: 500px;
  width: 90%;
  position: relative;
  box-shadow: var(--dialog-shadow);
}

.modal-close {
  position: absolute;
  top: var(--spacing-md);
  right: var(--spacing-md);
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background-color: var(--color-background);
  border: 1px solid var(--color-border);
  color: var(--color-text-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all var(--transition-fast);

  &:hover {
    background-color: var(--color-danger);
    border-color: var(--color-danger);
    color: white;
  }
}
</style>
