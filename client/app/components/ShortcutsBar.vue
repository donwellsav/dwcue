<template>
  <div
    v-if="open"
    class="shortcuts-bar"
    role="complementary"
    :aria-label="t('settings.helpShortcutsTitle')"
  >
    <!-- Two lines of shortcuts, the most used first. They wrap like words: as
         many as the window is wide enough for, and none is ever cut in half. -->
    <div class="shortcuts-bar__items">
      <span v-for="action in runningActions" :key="action.id" class="shortcuts-bar__item" :title="t(action.labelKey)">
        <span class="shortcuts-bar__action">{{ t(action.labelKey) }}</span>
        <kbd class="shortcuts-bar__key">{{ playbackKeyLabel(action.id) || '—' }}</kbd>
      </span>
      <span class="shortcuts-bar__item">
        <span class="shortcuts-bar__action">{{ t('oneShots.defaultShortcuts') }}</span>
        <kbd class="shortcuts-bar__key">1–9, 0</kbd>
        <kbd class="shortcuts-bar__key">Shift+1–9, Shift+0</kbd>
      </span>
      <span v-for="action in otherActions" :key="action.id" class="shortcuts-bar__item" :title="t(action.labelKey)">
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
// Shortcut reference pinned to the bottom of the workspace, the same in Edit
// Mode and Show Mode: operators should never have to guess the keys. It is
// two lines high and lists every keyboard action, the ones used while a show
// runs first. The full editor is under Settings → Shortcuts and Customize.
import { PLAYBACK_ACTIONS, useCartHotkeys } from '~/composables/useCartHotkeys';
import type { PlaybackKeyAction } from '~/types/project';

// Running a show, in the order an operator reaches for them.
const RUNNING: PlaybackKeyAction[] = [
  'play-next', 'pause-resume', 'stop-all', 'set-up-next', 'play-selected', 'select-up', 'select-down',
  'cue-to-continue', 'jump-cue', 'toggle-loop',
];
// The windows and panels next; set-up keys last, since they are the first to
// go when the window is too narrow for everything.
const LATER: PlaybackKeyAction[] = [
  'toggle-video-output', 'toggle-quickplays', 'toggle-detached-quickplays',
  'capture-video-standby', 'capture-display-standby', 'toggle-settings', 'toggle-properties',
];
const byId = (id: PlaybackKeyAction) => PLAYBACK_ACTIONS.find(action => action.id === id)!;
const runningActions = RUNNING.map(byId);
// Any action added later still shows, after the ones placed by hand.
const otherActions = [
  ...LATER.map(byId),
  ...PLAYBACK_ACTIONS.filter(({ id }) => !RUNNING.includes(id) && !LATER.includes(id)),
];

const { t } = useLocalization();
const { playbackKeyLabel } = useCartHotkeys();

const open = useState('showShortcutsBar', () => true);
const showProjectSettings = useState('showProjectSettings', () => false);
const settingsTab = useState('projectSettingsTab', () => 'audio');

const openEditor = () => {
  settingsTab.value = 'shortcuts';
  showProjectSettings.value = true;
};
</script>

<style scoped>
.shortcuts-bar {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 2px var(--workspace-gutter);
  border-top: 1px solid var(--color-border);
  background: var(--color-surface);
  flex: 0 0 auto;
}

/* Exactly two lines, whatever the window width: the shortcuts wrap, and the
   ones that would start a third line are left out. */
.shortcuts-bar__items {
  --shortcut-line: 20px;
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  align-items: center;
  gap: 3px var(--spacing-md);
  flex: 1 1 auto;
  min-width: 0;
  height: calc(2 * var(--shortcut-line) + 3px);
  overflow: hidden;
}

.shortcuts-bar__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: var(--shortcut-line);
  white-space: nowrap;
}

.shortcuts-bar__action {
  font-size: 11px;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
}

.shortcuts-bar__key {
  flex: none;
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
  flex: none;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-accent-text);
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
  flex: none;
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
