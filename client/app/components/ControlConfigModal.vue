<template>
  <section class="control-config-panel" :aria-label="t('controls.title')" @keydown.capture="handleKeydown">
      <div class="tab-bar">
        <button
          class="tab-btn"
          :class="{ active: activeTab === 'keyboard' }"
          :aria-pressed="activeTab === 'keyboard'"
          @click="activeTab = 'keyboard'"
        >
          <span class="tab-icon material-symbols-rounded" aria-hidden="true">keyboard</span> {{ t('controls.tabKeyboard') }}
        </button>
        <button
          class="tab-btn"
          :class="{ active: activeTab === 'midi' }"
          :aria-pressed="activeTab === 'midi'"
          @click="activeTab = 'midi'"
        >
          <span class="tab-icon material-symbols-rounded" aria-hidden="true">piano</span> {{ t('controls.tabMidi') }}
        </button>
        <button v-for="group in bindingGroups" :key="group.id" type="button" class="group-btn"
          :aria-pressed="activeGroup === group.id" @click="bindingGroup = group.id">
          {{ t(group.labelKey) }}
        </button>
        <label class="shortcut-bar-toggle">
          <input v-model="showShortcutsBar" type="checkbox" />
          {{ t('settings.showShortcutsBar') }}
        </label>
        <button class="reset-btn" @click="handleReset">
          {{ activeTab === 'keyboard' ? t('controls.resetKeyboard') : t('controls.resetMidi') }}
        </button>
      </div>

      <!-- Keyboard tab -->
      <div v-if="activeTab === 'keyboard'" :key="activeGroup" class="config-body">
        <!-- Playback section -->
        <div
          v-for="action in keyboardActions"
          :key="action.id"
          class="action-row keyboard-action-row"
          :class="{
            capturing: capturingKeyAction === action.id,
            conflict: keyConflictAction === action.id || keyConflictSlotForAction === action.id
          }"
        >
          <span class="action-label">{{ t(action.labelKey) }}</span>
          <button type="button" class="action-binding binding-button"
            :aria-label="t(action.labelKey)"
            @click="startCaptureAction(action.id, $event)"
            @blur="cancelKeyCapture">
            <template v-if="capturingKeyAction === action.id">
              {{ t('controls.pressAnyKey') }}
            </template>
            <template v-else-if="playbackKeyLabel(action.id)">
              {{ playbackKeyLabel(action.id) }}
            </template>
            <template v-else>—</template>
          </button>
          <button
            v-if="getPlaybackBinding(action.id)"
            class="clear-key-btn"
            :aria-label="`${t('controls.clear')} · ${t(action.labelKey)}`"
            @click.stop="clearPlaybackBinding(action.id)"
          >{{ t('controls.clear') }}</button>
          <span v-if="keyErrorActionId === action.id && keyErrorMessage" class="error-msg">{{ keyErrorMessage }}</span>
        </div>

        <!-- One Shots section -->
        <div
          v-for="entry in activeGroup === 'One Shots' ? configuredOneShots : []"
          :key="entry.item.uuid"
          class="action-row keyboard-action-row"
          :class="{
            capturing: capturingSlot === entry.slotIndex,
            conflict: conflictSlot === entry.slotIndex
          }"
        >
          <span class="action-label">{{ t('controls.oneShot', { n: entry.slotIndex + 1 }) }}</span>
          <button type="button" class="action-binding binding-button"
            :aria-label="t('controls.oneShot', { n: entry.slotIndex + 1 })"
            @click="startCaptureSlot(entry.slotIndex, $event)"
            @blur="cancelKeyCapture">
            <template v-if="capturingSlot === entry.slotIndex">
              {{ t('controls.pressAnyKey') }}
            </template>
            <template v-else-if="getSlotKeyLabel(entry.slotIndex)">
              {{ getSlotKeyLabel(entry.slotIndex) }}
            </template>
            <template v-else>—</template>
          </button>
          <button
            v-if="keyMappings[entry.slotIndex]"
            class="clear-key-btn"
            :aria-label="`${t('controls.clear')} · ${t('controls.oneShot', { n: entry.slotIndex + 1 })}`"
            @click.stop="clearSlotBinding(entry.slotIndex)"
          >{{ t('controls.clear') }}</button>
          <span v-if="keyErrorMessage && keyErrorSlot === entry.slotIndex" class="error-msg">{{ keyErrorMessage }}</span>
        </div>
      </div>

      <!-- MIDI tab -->
      <div v-else :key="'midi-' + activeGroup" class="config-body config-body--midi">
        <div class="device-row">
          <label for="shortcut-midi-device" class="device-label">{{ t('controls.midiDevice') }}</label>
          <select
            id="shortcut-midi-device"
            class="device-select"
            :value="preferredDevice ?? ''"
            @change="handleDeviceChange"
          >
            <option value="">{{ t('controls.allDevices') }}</option>
            <option v-for="dev in connectedDevices" :key="dev" :value="dev">{{ dev }}</option>
          </select>
          <span v-if="connectedDevices.length === 0" class="no-device-hint">{{ t('controls.noDevices') }}</span>
        </div>
        <div v-for="action in midiActions" :key="action.id" class="action-row midi-action-row"
          :class="{ learning: learning === action.id }">
          <span class="action-label">{{ t(action.labelKey, { n: action.n }) }}</span>
          <span v-if="learning === action.id || getMidiBinding(action.id)" class="midi-binding"
            :title="formatMidiBindingLabel(action.id)" aria-live="polite">
            {{ learning === action.id ? t('controls.waitingForInput') : formatMidiBindingLabel(action.id) }}
          </span>
          <div class="action-buttons">
            <button type="button" class="learn-btn" :class="{ active: learning === action.id }"
              :aria-label="`${learning === action.id ? t('controls.cancel') : t('controls.learn')} · ${t(action.labelKey, { n: action.n })}`"
              @click="toggleLearn(action.id)">
              {{ learning === action.id ? t('controls.cancel') : t('controls.learn') }}
            </button>
            <button v-if="getMidiBinding(action.id)" type="button" class="clear-btn"
              :aria-label="`${t('controls.clear')} · ${t(action.labelKey, { n: action.n })}`"
              @click="handleMidiClear(action.id)">
              {{ t('controls.clear') }}
            </button>
          </div>
        </div>

        <template v-if="activeGroup === 'Volume'">
          <label class="action-row midi-action-row">
            <span class="action-label">{{ t('controls.volumeMultiplier') }}</span>
            <input class="multiplier-input" type="number" min="0.1" max="60" step="0.1"
              :value="masterVolumeMultiplier" @change="onMultiplierChange" />
          </label>
          <p class="multiplier-hint">{{ t('controls.volumeMultiplierHint') }}</p>
        </template>
      </div>

      <!-- MIDI Conflict dialog -->
      <div v-if="midiConflictInfo" class="conflict-overlay" @click.self="midiConflictInfo = null">
        <div class="conflict-dialog">
          <p>{{ midiConflictMessage }}</p>
          <div class="conflict-buttons">
            <button class="cancel-btn" @click="midiConflictInfo = null">{{ t('controls.cancel') }}</button>
            <button class="confirm-btn" @click="resolveMidiConflict">{{ t('controls.reassign') }}</button>
          </div>
        </div>
      </div>
  </section>
</template>

<script setup lang="ts">
import { formatKeyLabel, eventToBinding, bindingsMatch, isReservedCombo, PLAYBACK_ACTIONS } from '~/composables/useCartHotkeys';
import {
  MIDI_ACTIONS,
  formatMidiBinding,
  DEFAULT_MASTER_VOLUME_MULTIPLIER,
  type MidiBinding,
  type MidiActionId,
} from '~/composables/useMidiController';
import type { PlaybackKeyAction, CartSlotKeyBinding } from '~/types/project';
import { buildOneShotSlots } from '~/utils/oneShots';

const { t } = useLocalization();
const showShortcutsBar = useState('showShortcutsBar', () => true);

// Keyboard state
const {
  keyMappings,
  playbackMappings,
  playbackKeyLabel,
  updateBinding: updateKeyBinding,
  updatePlaybackBinding,
  resetToDefaults,
  resetPlaybackToDefaults,
} = useCartHotkeys();
const { saveProject, currentProject } = useProject();
const { cartOnlyItems } = useCartItems();
const oneShotSlots = computed(() => buildOneShotSlots(
  currentProject.value?.items ?? [],
  Array.from(cartOnlyItems.value.values()),
));
const configuredOneShots = computed(() => oneShotSlots.value.flatMap(
  (item, slotIndex) => item ? [{ item, slotIndex }] : [],
));

const capturingSlot = ref<number | null>(null);
const capturingKeyAction = ref<PlaybackKeyAction | null>(null);
const keyErrorMessage = ref<string | null>(null);
const keyErrorSlot = ref<number | null>(null);
const keyErrorActionId = ref<PlaybackKeyAction | null>(null);
const conflictSlot = ref<number | null>(null);
const keyConflictAction = ref<PlaybackKeyAction | null>(null);
const keyConflictSlotForAction = ref<PlaybackKeyAction | null>(null);

// MIDI state
const {
  config: midiConfig,
  connectedDevices,
  preferredDevice,
  learning,
  startLearn,
  stopLearn,
  updateBinding: updateMidiBinding,
  clearBinding: clearMidiBinding,
  clearAllBindings,
  setPreferredDevice,
  setMasterVolumeMultiplier,
} = useMidiController();

const masterVolumeMultiplier = computed(
  () => midiConfig.value.masterVolumeMultiplier ?? DEFAULT_MASTER_VOLUME_MULTIPLIER,
);

const onMultiplierChange = (e: Event) => {
  const raw = parseFloat((e.target as HTMLInputElement).value);
  if (Number.isNaN(raw)) return;
  setMasterVolumeMultiplier(raw);
};

const midiConflictInfo = ref<{ actionId: MidiActionId; binding: MidiBinding; conflictAction: string } | null>(null);
const activeTab = ref<'keyboard' | 'midi'>('keyboard');

// --- Keyboard helpers ---

const getSlotKeyLabel = (slotIndex: number): string => {
  const binding = keyMappings.value[slotIndex];
  return binding ? formatKeyLabel(binding) : '';
};

const getPlaybackBinding = (action: PlaybackKeyAction): CartSlotKeyBinding | null => {
  return playbackMappings.value[action] ?? null;
};

const clearSlotBinding = (slotIndex: number) => {
  const item = oneShotSlots.value[slotIndex];
  if (!item?.oneShot) return;
  item.oneShot.hotkey = null;
  saveProject();
};

const clearPlaybackBinding = (action: PlaybackKeyAction) => {
  updatePlaybackBinding(action, null);
  saveProject();
};

const startCaptureSlot = (slotIndex: number, event: MouseEvent) => {
  (event.currentTarget as HTMLElement).focus();
  capturingSlot.value = slotIndex;
  capturingKeyAction.value = null;
  keyErrorMessage.value = null;
  keyErrorSlot.value = null;
  keyErrorActionId.value = null;
  conflictSlot.value = null;
  keyConflictAction.value = null;
  keyConflictSlotForAction.value = null;
};

const startCaptureAction = (action: PlaybackKeyAction, event: MouseEvent) => {
  (event.currentTarget as HTMLElement).focus();
  capturingKeyAction.value = action;
  capturingSlot.value = null;
  keyErrorMessage.value = null;
  keyErrorSlot.value = null;
  keyErrorActionId.value = null;
  conflictSlot.value = null;
  keyConflictAction.value = null;
  keyConflictSlotForAction.value = null;
};

const cancelKeyCapture = () => {
  capturingSlot.value = null;
  capturingKeyAction.value = null;
  keyErrorMessage.value = null;
  keyErrorSlot.value = null;
  keyErrorActionId.value = null;
};

const handleKeydown = (e: KeyboardEvent) => {
  if (e.defaultPrevented) return;
  const binding = eventToBinding(e);
  const stop = playbackMappings.value['stop-all'];
  if (stop && bindingsMatch(stop, binding)) {
    // Keep panic available even while the editor has a key assignment armed.
    cancelKeyCapture();
    return;
  }
  if (activeTab.value !== 'keyboard' || (capturingSlot.value === null && capturingKeyAction.value === null)) return;
  if (e.key === 'Escape') {
    cancelKeyCapture();
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (['Control', 'Shift', 'Alt', 'Meta', 'Tab'].includes(e.key)) return;

  e.preventDefault();
  e.stopPropagation();

  if (isReservedCombo(binding)) {
    keyErrorMessage.value = t('controls.reserved');
    if (capturingSlot.value !== null) keyErrorSlot.value = capturingSlot.value;
    if (capturingKeyAction.value !== null) keyErrorActionId.value = capturingKeyAction.value;
    return;
  }

  if (capturingSlot.value !== null) {
    // Check conflict with other playback actions
    for (const [action, pb] of Object.entries(playbackMappings.value) as [PlaybackKeyAction, CartSlotKeyBinding | null][]) {
      if (pb && pb.key.toLowerCase() === binding.key.toLowerCase()
        && pb.ctrlKey === binding.ctrlKey && pb.shiftKey === binding.shiftKey && pb.altKey === binding.altKey) {
        keyErrorMessage.value = t('controls.conflictAction', { action: t(PLAYBACK_ACTIONS.find(a => a.id === action)?.labelKey ?? '') });
        keyErrorSlot.value = capturingSlot.value;
        return;
      }
    }
    const result = updateKeyBinding(capturingSlot.value, binding);
    if (result.conflict >= 0) {
      keyErrorMessage.value = t('controls.conflictOneShot', { n: result.conflict + 1 });
      keyErrorSlot.value = capturingSlot.value;
      conflictSlot.value = result.conflict;
      return;
    }
    keyErrorMessage.value = null;
    keyErrorSlot.value = null;
    conflictSlot.value = null;
    capturingSlot.value = null;
    saveProject();
  } else if (capturingKeyAction.value !== null) {
    const action = capturingKeyAction.value;
    // Check conflict with cart slots
    for (const [slotStr, slotBinding] of Object.entries(keyMappings.value)) {
      if (slotBinding.key.toLowerCase() === binding.key.toLowerCase()
        && slotBinding.ctrlKey === binding.ctrlKey && slotBinding.shiftKey === binding.shiftKey && slotBinding.altKey === binding.altKey) {
        keyErrorMessage.value = t('controls.conflictOneShot', { n: parseInt(slotStr, 10) + 1 });
        keyErrorActionId.value = action;
        keyConflictSlotForAction.value = action;
        return;
      }
    }
    const result = updatePlaybackBinding(action, binding);
    if (result.conflictAction) {
      keyErrorMessage.value = t('controls.conflictAction', { action: t(PLAYBACK_ACTIONS.find(a => a.id === result.conflictAction)?.labelKey ?? '') });
      keyErrorActionId.value = action;
      keyConflictAction.value = result.conflictAction;
      return;
    }
    if (result.conflictSlot >= 0) {
      keyErrorMessage.value = t('controls.conflictOneShot', { n: result.conflictSlot + 1 });
      keyErrorActionId.value = action;
      return;
    }
    keyErrorMessage.value = null;
    keyErrorActionId.value = null;
    keyConflictAction.value = null;
    keyConflictSlotForAction.value = null;
    capturingKeyAction.value = null;
    saveProject();
  }
};

// --- MIDI helpers ---

const bindingGroup = ref('Playback');
const bindingGroups = computed(() => [
  { id: 'Playback', labelKey: 'controls.sectionPlayback' },
  ...(configuredOneShots.value.length ? [{ id: 'One Shots', labelKey: 'controls.sectionOneShots' }] : []),
  ...(activeTab.value === 'midi'
    ? [{ id: 'Volume', labelKey: 'controls.sectionVolume' }]
    : [{ id: 'Video', labelKey: 'settings.tabVideoOutput' }]),
]);
const activeGroup = computed(() => bindingGroups.value.some(group => group.id === bindingGroup.value)
  ? bindingGroup.value : 'Playback');
const keyboardActions = computed(() => {
  if (activeGroup.value === 'One Shots') return [];
  return PLAYBACK_ACTIONS.filter(action => {
    const video = action.id === 'toggle-video-output' || action.id.startsWith('capture-');
    return video === (activeGroup.value === 'Video');
  });
});
const midiActions = computed(() => {
  const actions = MIDI_ACTIONS.filter(action => action.category === activeGroup.value
    && (action.n === undefined || !!oneShotSlots.value[action.n - 1]));
  const priority = (id: MidiActionId) => id === 'play-next' ? 0 : id === 'stop-all' ? 1 : 2;
  return actions.sort((a, b) => priority(a.id) - priority(b.id));
});

const getMidiBinding = (actionId: string): MidiBinding | undefined =>
  midiConfig.value.bindings[actionId];

const formatMidiBindingLabel = (actionId: string): string => {
  const binding = midiConfig.value.bindings[actionId];
  return binding ? formatMidiBinding(binding) : '';
};

const midiConflictMessage = computed(() => {
  if (!midiConflictInfo.value) return '';
  const conflictAction = MIDI_ACTIONS.find(a => a.id === midiConflictInfo.value!.conflictAction);
  const label = conflictAction
    ? (conflictAction.n !== undefined ? t(conflictAction.labelKey, { n: conflictAction.n }) : t(conflictAction.labelKey))
    : midiConflictInfo.value.conflictAction;
  return t('controls.conflictMessage', { action: label });
});

const toggleLearn = (actionId: MidiActionId) => {
  if (learning.value === actionId) {
    stopLearn();
    return;
  }
  startLearn(actionId, (binding: MidiBinding) => {
    stopLearn();
    const result = updateMidiBinding(actionId, binding);
    if (result.conflict) {
      midiConflictInfo.value = { actionId, binding, conflictAction: result.conflict };
    }
  });
};

const resolveMidiConflict = () => {
  if (!midiConflictInfo.value) return;
  const { actionId, binding, conflictAction } = midiConflictInfo.value;
  clearMidiBinding(conflictAction as MidiActionId);
  updateMidiBinding(actionId, binding);
  midiConflictInfo.value = null;
};

const handleMidiClear = (actionId: MidiActionId) => clearMidiBinding(actionId);

const handleDeviceChange = (e: Event) => {
  const val = (e.target as HTMLSelectElement).value;
  setPreferredDevice(val || null);
};

// --- Shared ---

const handleReset = () => {
  if (activeTab.value === 'keyboard') {
    resetToDefaults();
    resetPlaybackToDefaults();
    saveProject();
  } else {
    clearAllBindings();
  }
};

watch([activeTab, activeGroup], () => {
  cancelKeyCapture();
  if (learning.value) stopLearn();
  midiConflictInfo.value = null;
});
onUnmounted(() => {
  if (learning.value) stopLearn();
});
</script>

<style scoped>
.control-config-panel {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  position: relative;
}

/* Tabs */
.tab-bar {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 2px;
  padding: 0 var(--spacing-md);
  border-bottom: 1px solid var(--color-border);
  background-color: var(--color-surface);
  overflow-x: auto;
}

.tab-btn {
  flex-shrink: 0;
  min-height: var(--panel-control-height);
  padding: var(--spacing-xs) var(--spacing-sm);
  font-size: 13px;
  font-weight: 600;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.tab-btn:hover { background: var(--color-surface-hover); }
.tab-btn.active {
  color: var(--color-accent);
  background: var(--color-accent-soft);
  border-bottom-color: var(--color-accent);
}

.tab-icon {
  font-size: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

/* Body */
.config-body {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 252px), 1fr));
  grid-auto-rows: max-content;
  align-content: start;
  gap: var(--spacing-xs) var(--spacing-sm);
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  width: min(100%, 1140px);
  padding: var(--spacing-xs) var(--workspace-gutter);
}

.config-body--midi {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 250px), 1fr));
  width: min(100%, 900px);
}

.group-btn {
  min-height: 26px;
  flex-shrink: 0;
  padding: 2px var(--spacing-sm);
  border: 1px solid transparent;
  border-radius: var(--control-radius);
  color: var(--color-text-secondary);
  background: transparent;
  font-size: 12px;
  cursor: pointer;
}

.tab-btn + .group-btn {
  margin-inline-start: var(--spacing-sm);
}

.group-btn[aria-pressed="true"] {
  border-color: var(--color-border);
  color: var(--color-text-primary);
  background: var(--color-accent-soft);
}

.group-btn:hover { background: var(--color-surface-hover); }

.action-row {
  display: grid;
  align-items: center;
  gap: var(--spacing-xs);
  min-width: 0;
  min-height: 30px;
  padding: 2px var(--spacing-sm);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background: var(--color-surface);
  transition: background-color 0.1s;
}

.action-row:hover { background: var(--color-surface-hover); }
.action-row.capturing,
.action-row.learning {
  background: var(--color-accent-soft);
  border-color: var(--color-accent);
}
.action-row.conflict { border-color: var(--color-danger); }

.keyboard-action-row {
  grid-template-columns: minmax(0, 1fr) minmax(94px, 0.95fr) auto;
}

.midi-action-row {
  grid-template-columns: minmax(0, 1fr) auto;
}

.midi-action-row .action-buttons {
  grid-column: 2;
  grid-row: 1;
}

.midi-binding {
  grid-column: 1 / -1;
  min-width: 0;
  font: 11px var(--font-mono);
  color: var(--color-text-secondary);
  overflow-wrap: anywhere;
}

.action-label {
  grid-column: 1;
  font-size: 13px;
  color: var(--color-text-primary);
}

.action-binding {
  grid-column: 2;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-primary);
  background: var(--color-background);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  padding: 2px 8px;
  min-width: 0;
  overflow-wrap: anywhere;
  text-align: center;
}

.error-msg {
  grid-column: 2 / -1;
  font-size: 11px;
  color: var(--color-danger);
  flex-shrink: 0;
  max-width: none;
}

/* MIDI / keyboard action buttons */
.action-buttons {
  grid-column: 3;
  display: flex;
  justify-content: flex-end;
  gap: 4px;
  flex-shrink: 0;
}

.learn-btn,
.clear-btn,
.clear-key-btn {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: var(--control-radius);
  border: 1px solid var(--color-border);
  background: var(--color-background);
  color: var(--color-text-primary);
  cursor: pointer;
  transition: background-color 0.15s;
  flex-shrink: 0;
}

.clear-key-btn {
  grid-column: 3;
  justify-self: end;
}

.learn-btn:hover,
.clear-btn:hover,
.clear-key-btn:hover { background: var(--color-surface-hover); }

.learn-btn.active {
  background: var(--color-accent, #3b82f6);
  color: white;
  border-color: transparent;
}

/* Master-volume multiplier input */
.multiplier-input {
  grid-column: 2;
  width: 80px;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: var(--control-radius);
  border: 1px solid var(--color-border);
  background: var(--color-background);
  color: var(--color-text-primary);
}

.multiplier-hint {
  grid-column: 1 / -1;
  font-size: 11px;
  color: var(--color-text-secondary);
  margin: 0;
}

/* Device selector row */
.device-row {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  flex-wrap: wrap;
}

.device-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.device-select {
  width: min(100%, 176px);
  font-size: 12px;
  padding: 4px 8px;
  border-radius: var(--control-radius);
  border: 1px solid var(--color-border);
  background: var(--color-background);
  color: var(--color-text-primary);
  cursor: pointer;
}

.no-device-hint {
  font-size: 11px;
  color: var(--color-text-secondary);
}

.shortcut-bar-toggle {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  margin-inline: var(--spacing-md) var(--spacing-xs);
  padding-inline-start: var(--spacing-md);
  font-size: 12px;
  white-space: nowrap;
}

.reset-btn {
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: var(--control-radius);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
  border: 1px solid var(--color-border);
  background: var(--color-background);
  color: var(--color-text-primary);
  transition: background-color 0.15s;
}

.reset-btn:hover { background: var(--color-surface-hover); }

.binding-button {
  background: var(--color-control);
  padding: 2px 4px;
  overflow-wrap: normal;
  cursor: pointer;
}

.binding-button:hover {
  border-color: var(--color-accent);
}

.binding-button:focus-visible,
.learn-btn:focus-visible,
.clear-btn:focus-visible,
.clear-key-btn:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 1px;
}

/* Conflict dialog */
.conflict-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
}

.conflict-dialog {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 20px;
  max-width: 300px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
}

.conflict-dialog p {
  font-size: 13px;
  color: var(--color-text-primary);
  margin-bottom: 16px;
}

.conflict-buttons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.cancel-btn,
.confirm-btn {
  padding: 6px 14px;
  border-radius: var(--control-radius);
  font-size: 13px;
  cursor: pointer;
  border: 1px solid var(--color-border);
  background: var(--color-background);
  color: var(--color-text-primary);
}

.confirm-btn {
  background: var(--color-accent, #3b82f6);
  color: white;
  border-color: transparent;
}
</style>
