<template>
  <div v-if="active" class="level-check-bar" role="region" :aria-label="t('levelCheck.title')">
    <div class="level-check-bar__lead">
      <span class="material-symbols-rounded level-check-bar__icon" aria-hidden="true">graphic_eq</span>
      <span class="level-check-bar__title">{{ t('levelCheck.title') }}</span>
      <span v-if="items.length" class="level-check-bar__progress">
        {{ t('levelCheck.progress', { index: index + 1, total: items.length }) }}
      </span>
    </div>

    <div class="level-check-bar__cue" :class="{ 'level-check-bar__cue--live': playing }">
      <span class="level-check-bar__cue-name">{{ currentItem?.displayName ?? '—' }}</span>
      <span v-if="currentWindow" class="level-check-bar__peak mono">
        peak {{ formatTime(currentWindow.peakAt) }}
      </span>
    </div>

    <div class="level-check-bar__actions">
      <button
        type="button"
        class="lc-btn"
        :disabled="index <= 0"
        :title="t('levelCheck.prev')"
        :aria-label="t('levelCheck.prev')"
        @click="prev"
      >
        <span class="material-symbols-rounded" aria-hidden="true">skip_previous</span>
      </button>
      <button
        type="button"
        class="lc-btn lc-btn--primary"
        :disabled="!currentItem"
        :title="t('levelCheck.replay')"
        :aria-label="t('levelCheck.replay')"
        @click="playCurrent"
      >
        <span class="material-symbols-rounded" aria-hidden="true">{{ playing ? 'stop' : 'play_arrow' }}</span>
      </button>
      <button
        type="button"
        class="lc-btn"
        :disabled="index >= items.length - 1"
        :title="t('levelCheck.next')"
        :aria-label="t('levelCheck.next')"
        @click="next"
      >
        <span class="material-symbols-rounded" aria-hidden="true">skip_next</span>
      </button>
      <button
        type="button"
        class="lc-btn lc-btn--exit"
        :title="t('levelCheck.exit')"
        :aria-label="t('levelCheck.exit')"
        @click="exit"
      >
        <span class="material-symbols-rounded" aria-hidden="true">close</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
const { t } = useLocalization();
const {
  active, index, items, currentItem, currentWindow, playing,
  exit, next, prev, playCurrent,
} = useLevelCheck();

const formatTime = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};

// Capture phase so these keys win over the cart/playback hotkeys while the
// bar is up; Space replays, arrows walk cues, Esc exits. Never fires while
// the operator is typing in a field.
const isEditingTarget = (e: KeyboardEvent): boolean => {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};
const onKeydown = (e: KeyboardEvent) => {
  if (!active.value || isEditingTarget(e)) return;
  if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); void playCurrent(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); void next(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); void prev(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); void exit(); }
};

onMounted(() => window.addEventListener('keydown', onKeydown, { capture: true }));
onUnmounted(() => window.removeEventListener('keydown', onKeydown, { capture: true }));
</script>

<style scoped>
.level-check-bar {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-xs) var(--workspace-gutter);
  background-color: color-mix(in srgb, var(--color-accent) 10%, var(--color-surface));
  border-bottom: 1px solid var(--color-accent);
  flex: 0 0 auto;
}

.level-check-bar__lead {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  flex: 0 0 auto;
}

.level-check-bar__icon {
  color: var(--color-accent);
  font-size: 20px;
}

.level-check-bar__title {
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-primary);
}

.level-check-bar__progress {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-secondary);
}

.level-check-bar__cue {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-sm);
  min-width: 0;
  flex: 1 1 auto;
}

.level-check-bar__cue-name {
  font-weight: 600;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.level-check-bar__cue--live .level-check-bar__cue-name {
  color: var(--color-accent);
}

.level-check-bar__peak {
  font-size: 11px;
  color: var(--color-text-secondary);
  flex: 0 0 auto;
}

.mono {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.level-check-bar__actions {
  display: flex;
  gap: var(--spacing-xs);
  flex: 0 0 auto;
}

.lc-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 28px;
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background-color: var(--color-control);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: color var(--transition-base), border-color var(--transition-base);
}

.lc-btn:hover:not(:disabled) {
  color: var(--color-text-primary);
  border-color: var(--color-border-strong);
}

.lc-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.lc-btn--primary {
  color: var(--color-accent);
}

.lc-btn--exit:hover {
  color: var(--color-text-primary);
}
</style>
