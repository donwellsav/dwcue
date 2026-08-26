<template>
  <div
    v-if="open"
    class="shortcuts-bar"
    role="complementary"
    :aria-label="t('settings.helpShortcutsTitle')"
  >
    <span class="shortcuts-bar__title">{{ t('settings.helpShortcutsTitle') }}</span>
    <div class="shortcuts-bar__items">
      <span v-for="action in PLAYBACK_ACTIONS" :key="action.id" class="shortcuts-bar__item">
        <span class="shortcuts-bar__action">{{ t(action.labelKey) }}</span>
        <kbd class="shortcuts-bar__key">{{ playbackKeyLabel(action.id) || '—' }}</kbd>
      </span>
    </div>
    <button type="button" class="shortcuts-bar__edit" @click="openEditor">
      {{ t('settings.helpShortcuts') }}
    </button>
    <button
      type="button"
      class="shortcuts-bar__close"
      :aria-label="t('settings.close')"
      @click="open = false"
    >
      <span class="material-symbols-rounded" aria-hidden="true">close</span>
    </button>
  </div>
</template>

<script setup lang="ts">
// Compact shortcut reference pinned to the bottom of the workspace, in both
// edit and show mode — operators should never have to guess the keys. The
// full editor stays one click away via the Settings Help tab or the
// Customize button here.
import { PLAYBACK_ACTIONS, formatKeyLabel, useCartHotkeys } from '~/composables/useCartHotkeys';
import type { PlaybackKeyAction } from '~/types/project';

const { t } = useLocalization();
const { playbackMappings } = useCartHotkeys();

const open = useState('showShortcutsBar', () => true);
const showControlConfig = useState('showControlConfig', () => false);

const playbackKeyLabel = (action: PlaybackKeyAction): string => {
  const binding = playbackMappings.value[action];
  return binding ? formatKeyLabel(binding) : '';
};

const openEditor = () => {
  showControlConfig.value = true;
};
</script>

<style scoped>
.shortcuts-bar {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: 4px var(--spacing-md);
  border-top: 1px solid var(--color-border);
  background: var(--color-surface);
  flex: 0 0 auto;
}

.shortcuts-bar__title {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.shortcuts-bar__items {
  display: flex;
  align-items: center;
  gap: 2px var(--spacing-sm);
  flex: 1 1 auto;
  min-width: 0;
  flex-wrap: wrap;
}

.shortcuts-bar__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.shortcuts-bar__action {
  font-size: 11px;
  color: var(--color-text-secondary);
}

.shortcuts-bar__key {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border: 1px solid var(--color-border);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--color-control);
  color: var(--color-text-primary);
}

.shortcuts-bar__edit {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-accent);
  background: none;
  border: none;
  padding: 2px 4px;
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    text-decoration: underline;
  }
}

.shortcuts-bar__close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--color-text-secondary);
  cursor: pointer;

  .material-symbols-rounded {
    font-size: 16px;
  }

  &:hover {
    background: var(--color-surface-hover);
    color: var(--color-text-primary);
  }
}
</style>
