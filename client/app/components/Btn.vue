<template>
  <button
    class="btn"
    :disabled="disabled"
    v-bind="$attrs"
  >
    <span class="material-symbols-rounded" aria-hidden="true">{{ icon }}</span>
    <span>{{ text }}</span>
  </button>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  icon: string;
  text: string;
  disabled?: boolean;
}>(), {
  disabled: false,
});
</script>

<style scoped>
.btn {
  min-height: var(--panel-control-height);
  padding: 6px var(--spacing-md);
  background-color: var(--color-surface-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  font-size: 12px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--color-text-primary);
  white-space: nowrap;
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.035);

  .material-symbols-rounded {
    font-size: 18px;
  }

  &:hover:not(:disabled) {
    background-color: var(--color-surface-hover);
    border-color: var(--color-border-strong);
  }
}

</style>
