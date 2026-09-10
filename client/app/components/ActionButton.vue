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
    <span v-if="label" class="action-label" :class="{ 'has-hover-label': hoverLabel }">
      <span class="action-label-default">{{ label }}</span>
      <span v-if="hoverLabel" class="action-label-hover">{{ hoverLabel }}</span>
    </span>
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
  label?: string;
  hoverLabel?: string;
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
.action-btn--playlist:not(.action-btn--active):not(.set-next-action) {
  background-color: var(--color-surface-hover);
  border-color: var(--action-highlight, var(--color-accent));
  color: var(--action-highlight, var(--color-accent));
}

.action-label {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
}

.action-btn--playlist.set-next-action:not(.action-btn--active) {
  border-color: rgba(255, 255, 255, 0.9);
  color: rgba(255, 255, 255, 0.9);
}

.action-btn--playlist.set-next-action:not(.action-btn--active) .action-label-default {
  display: none;
}

.action-btn--playlist.set-next-action:not(.action-btn--active) .action-label-hover {
  display: none;
}

.action-btn--playlist.set-next-action:not(.action-btn--active):hover .action-label-hover {
  display: inline;
}

.action-btn--playlist.set-next-action:not(.action-btn--active):hover {
  border-color: var(--action-highlight, var(--color-accent));
  color: var(--action-highlight, var(--color-accent));
}

.action-btn--playlist.set-next-action:not(.action-btn--active):hover .material-symbols-rounded {
  display: none;
}

.action-label-hover {
  display: none;
}

.action-btn:hover:not(:disabled) .action-label.has-hover-label .action-label-default {
  display: none;
}

.action-btn:hover:not(:disabled) .action-label.has-hover-label .action-label-hover {
  display: inline;
}

.action-btn--playlist {
  width: 32px;
  height: 32px;

  .material-symbols-rounded,
  :deep(.cue-symbol) {
    font-size: clamp(18px, calc(var(--current-playlist-row-height, 44px) * 0.42), 36px);
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
