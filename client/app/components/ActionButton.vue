<template>
  <button
    class="action-btn"
    :class="[
      context === 'Cart' ? 'action-btn--cart' : 'action-btn--playlist',
      { 'action-btn--active': isActive }
    ]"
    :style="computedStyle"
    v-bind="$attrs"
    :aria-label="getAccessibleLabel()"
  >
    <CueSymbol v-if="symbol" :name="symbol" />
    <span v-else-if="icon" class="material-symbols-rounded" aria-hidden="true">{{ icon }}</span>
  </button>
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  icon?: string;
  symbol?: 'preview' | 'one-shots' | 'ltc' | 'video-output';
  highlightColor?: string;
  activeTextColor?: string;
  context?: 'Playlist' | 'Cart';
  isActive?: boolean;
}>(), {
  highlightColor: 'var(--color-accent)',
  activeTextColor: 'white',
  context: 'Playlist',
  isActive: false,
});

const attrs = useAttrs();
const getAccessibleLabel = () => {
  const explicit = attrs['aria-label'];
  if (typeof explicit === 'string' && explicit) return explicit;
  return typeof attrs.title === 'string' ? attrs.title : undefined;
};

const computedStyle = computed(() => {
  if (props.isActive) {
    return {
      backgroundColor: props.highlightColor,
      borderColor: props.highlightColor,
      color: props.activeTextColor,
    };
  }
  return { '--action-highlight': props.highlightColor };
});
</script>

<style scoped>
.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--control-radius);
  background-color: var(--color-control);
  border: 1px solid var(--color-border);
  color: var(--color-text-primary);
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.035);

  &:hover:not(:disabled) {
    background-color: var(--color-surface-hover);
    border-color: var(--action-highlight, var(--color-accent));
    color: var(--action-highlight, var(--color-accent));
  }
}

.action-btn--playlist {
  width: 32px;
  height: 32px;

  .material-symbols-rounded,
  :deep(.cue-symbol) {
    font-size: 18px;
  }
}

.action-btn--cart {
  width: 28px;
  height: 28px;

  .material-symbols-rounded,
  :deep(.cue-symbol) {
    font-size: 16px;
  }
}
</style>
