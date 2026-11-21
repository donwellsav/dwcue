import { isTextEntry } from '../utils/textEntry';
import type { QuickPlaySlotKeyBinding, PlaybackKeyAction, AudioItem, Project } from '~/types/project';
import { DEFAULT_PLAYBACK_KEYS } from '../types/project';
import { buildQuickPlayCells } from '../utils/quickPlays';

const RESERVED_COMBOS: QuickPlaySlotKeyBinding[] = [
  { key: 's', ctrlKey: true,  shiftKey: false, altKey: false },
  { key: 'q', ctrlKey: true,  shiftKey: false, altKey: false },
  { key: 'w', ctrlKey: true,  shiftKey: false, altKey: false },
  { key: 'z', ctrlKey: true,  shiftKey: false, altKey: false },
  { key: 'n', ctrlKey: true,  shiftKey: false, altKey: false },
  { key: 'o', ctrlKey: true,  shiftKey: false, altKey: false },
  { key: 'a', ctrlKey: true,  shiftKey: false, altKey: false },
  { key: 'c', ctrlKey: true,  shiftKey: false, altKey: false },
  { key: 'v', ctrlKey: true,  shiftKey: false, altKey: false },
  { key: 'x', ctrlKey: true,  shiftKey: false, altKey: false },
  { key: 'y', ctrlKey: true,  shiftKey: false, altKey: false },
  { key: 'r', ctrlKey: true,  shiftKey: false, altKey: false },
  { key: 'F1', ctrlKey: false, shiftKey: false, altKey: false },
];

export const bindingsMatch = (a: QuickPlaySlotKeyBinding, b: QuickPlaySlotKeyBinding): boolean =>
  a.key.toLowerCase() === b.key.toLowerCase()
  && a.ctrlKey  === b.ctrlKey
  // Some layouts produce '?' with Shift and others have a dedicated key.
  && (a.key === '?' || a.shiftKey === b.shiftKey)
  && a.altKey   === b.altKey;

export const isReservedCombo = (binding: QuickPlaySlotKeyBinding): boolean =>
  RESERVED_COMBOS.some(r => bindingsMatch(r, binding));

export const formatKeyLabel = (binding: QuickPlaySlotKeyBinding): string => {
  const parts: string[] = [];
  if (binding.ctrlKey)  parts.push('Ctrl');
  if (binding.shiftKey && binding.key !== '?') parts.push('Shift');
  if (binding.altKey)   parts.push('Alt');
  const keyLabel = binding.key === ' ' ? 'Space'
    : binding.key.length === 1 ? binding.key.toUpperCase()
    : binding.key;
  parts.push(keyLabel);
  return parts.join('+');
};

export const eventToBinding = (e: KeyboardEvent): QuickPlaySlotKeyBinding => ({
  key: e.key,
  ctrlKey: e.ctrlKey || e.metaKey,
  shiftKey: e.shiftKey,
  altKey: e.altKey,
});

const QUICK_PLAY_DIGITS = '1234567890';
const SHIFTED_DIGITS = '!@#$%^&*()';
export const QUICK_PLAY_DEFAULT_SLOTS = QUICK_PLAY_DIGITS.length * 2;

// Shared by the shortcut editor and Settings summary.
export const PLAYBACK_ACTIONS: { id: PlaybackKeyAction; labelKey: string }[] = [
  { id: 'play-next',     labelKey: 'controls.playNext'     },
  { id: 'pause-resume',  labelKey: 'controls.pauseResume'  },
  { id: 'toggle-loop',   labelKey: 'controls.toggleLoop'   },
  { id: 'cue-to-continue', labelKey: 'controls.cueToContinue' },
  { id: 'jump-cue',      labelKey: 'controls.jumpCue'      },
  { id: 'stop-all',      labelKey: 'controls.stopAll'      },
  { id: 'select-up',     labelKey: 'controls.selectUp'     },
  { id: 'select-down',   labelKey: 'controls.selectDown'   },
  { id: 'set-up-next',   labelKey: 'controls.setUpNext'    },
  { id: 'toggle-video-output', labelKey: 'controls.toggleVideoOutput' },
  { id: 'fullscreen-video-output', labelKey: 'controls.videoOutputFullscreen' },
  { id: 'locate-live', labelKey: 'actions.locateLive' },
  { id: 'locate-up-next', labelKey: 'actions.locateUpNext' },
  { id: 'capture-video-standby', labelKey: 'controls.captureVideoStandby' },
  { id: 'capture-display-standby', labelKey: 'controls.captureDisplayStandby' },
  { id: 'play-selected', labelKey: 'controls.playSelected' },
  { id: 'toggle-settings', labelKey: 'settings.title' },
  { id: 'toggle-properties', labelKey: 'properties.title' },
  { id: 'toggle-quickplays', labelKey: 'quickPlays.title' },
  { id: 'toggle-detached-quickplays', labelKey: 'controls.toggleDetachedQuickPlays' },
];

const WORKSPACE_ACTIONS = ['toggle-settings', 'toggle-properties', 'toggle-quickplays', 'locate-live', 'locate-up-next'] as const;
type WorkspaceAction = typeof WORKSPACE_ACTIONS[number];
const isWorkspaceAction = (action: PlaybackKeyAction): action is WorkspaceAction =>
  WORKSPACE_ACTIONS.some(candidate => action === candidate);

export const resolveKeyboardBindings = (
  slots: readonly (AudioItem | null)[],
  savedPlayback: Project['playbackKeys'] = {},
) => {
  const keyMappings: Record<number, QuickPlaySlotKeyBinding> = Object.fromEntries(
    slots.flatMap((item, index) => item?.quickPlay?.hotkey ? [[index, item.quickPlay.hotkey]] : []),
  );
  const playbackMappings: Partial<Record<PlaybackKeyAction, QuickPlaySlotKeyBinding | null>> = {
    ...DEFAULT_PLAYBACK_KEYS, ...savedPlayback,
  };
  // A new default must yield to a key the operator already assigned.
  const assigned = [...Object.values(keyMappings), ...Object.values(savedPlayback)];
  for (const action of [
    'set-up-next', 'play-selected', 'toggle-loop', 'jump-cue', 'cue-to-continue',
    'toggle-video-output', 'fullscreen-video-output', 'locate-live', 'locate-up-next', 'capture-video-standby', 'capture-display-standby',
    'toggle-settings', 'toggle-properties', 'toggle-quickplays', 'toggle-detached-quickplays',
  ] as const) {
    const defaultKey = DEFAULT_PLAYBACK_KEYS[action];
    if (savedPlayback[action] === undefined && defaultKey
        && assigned.some(binding => binding && bindingsMatch(binding, defaultKey))) {
      delete playbackMappings[action];
    }
  }

  const occupied = [...Object.values(keyMappings), ...Object.values(playbackMappings)];
  const shiftSpace = { key: ' ', ctrlKey: false, shiftKey: true, altKey: false };
  const pauseAlternate = playbackMappings['pause-resume'] &&
    !occupied.some(binding => binding && bindingsMatch(binding, shiftSpace)) ? shiftSpace : null;
  for (let index = 0; index < QUICK_PLAY_DEFAULT_SLOTS; ++index) {
    const quickPlay = slots[index]?.quickPlay;
    if (!quickPlay || quickPlay.hotkey !== undefined) continue;
    const digit = index % QUICK_PLAY_DIGITS.length;
    const binding = { key: QUICK_PLAY_DIGITS[digit], ctrlKey: false,
      shiftKey: index >= QUICK_PLAY_DIGITS.length, altKey: false };
    const legacy = binding.shiftKey ? { ...binding, key: SHIFTED_DIGITS[digit] } : null;
    if (!occupied.some(other => other && (bindingsMatch(other, binding) || (legacy && bindingsMatch(other, legacy))))) {
      keyMappings[index] = binding;
    }
  }
  return { keyMappings, playbackMappings, pauseAlternate };
};

let togglingVideoOutput = false;

export const useVideoOutputToggle = () => {
  const { showHeaderWarning } = useHeaderWarnings();
  const { t } = useLocalization();
  return async (fullscreen = false) => {
    const api = window.electronAPI?.videoOutput;
    if (!api || togglingVideoOutput) return false;
    togglingVideoOutput = true;
    try {
      if (fullscreen) await api.toggleFullscreen(true);
      else {
        const status = await api.status();
        if (status.enabled || status.open) await api.close();
        else await api.open();
      }
      return true;
    } catch {
      showHeaderWarning(t('headerWarnings.videoToggleFailed'), 'urgent');
      return false;
    } finally {
      togglingVideoOutput = false;
    }
  };
};

export const useQuickPlayHotkeys = (workspace?: Record<WorkspaceAction, () => void>) => {
  const { currentProject, projectHydrationStatus, selectedItem, selectedItems, toggleCueLoop, getAllItemsFlat, toggleItemSelection, findItemByUuid } = useProject();
  const { quickPlayItems } = useQuickPlayItems();
  const { quickPlayPlaybackReady, playQuickPlay } = useQuickPlayPlayback();
  const toggleVideoOutput = useVideoOutputToggle();
  const { isDetached } = useDetachedQuickPlayMutation();
  const { showHeaderWarning } = useHeaderWarnings();
  const { t } = useLocalization();
  const { captureStill } = useVideoStandbyCapture();
  const { playCue, playNext, setNextItem, pauseCue, resumeCue, stopAllCues, activeCues, queueLoopContinuation, jumpCue } = useAudioEngine();

  const quickPlayCells = computed(() => buildQuickPlayCells(
    currentProject.value?.items ?? [],
    Array.from(quickPlayItems.value.values()),
  ));
  const bindings = computed(() => resolveKeyboardBindings(
    quickPlayCells.value, currentProject.value?.playbackKeys ?? {},
  ));
  const keyMappings = computed(() => bindings.value.keyMappings);
  const playbackMappings = computed(() => bindings.value.playbackMappings);
  const playbackKeyLabel = (action: PlaybackKeyAction): string => {
    const primary = playbackMappings.value[action];
    const alternate = action === 'pause-resume' ? bindings.value.pauseAlternate : null;
    return [primary, alternate].filter(binding => binding != null).map(formatKeyLabel).join(' / ');
  };

  const isTextInputFocused = (): boolean => isTextEntry(document.activeElement);

  // The detached window has no full show: the operator window runs its
  // transport keys (GO, Up Next, pause...), as it does the Video Output's.
  const forwardToOperator = (e: KeyboardEvent) => {
    window.electronAPI?.forwardShortcutToOperator?.({
      key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey,
      altKey: e.altKey, metaKey: e.metaKey, repeat: e.repeat,
    });
  };

  const isForwardedFromVideoOutput = (e: KeyboardEvent): boolean =>
    (e as KeyboardEvent & { dwcueForwardedFromVideoOutput?: boolean })
      .dwcueForwardedFromVideoOutput === true;

  const getTargetItem = (): AudioItem | null => {
    if (activeCues.value.size > 0) {
      const firstUuid = activeCues.value.keys().next().value;
      if (firstUuid) {
        const { findItemByUuid } = useProject();
        const item = findItemByUuid(firstUuid);
        if (item && item.type === 'audio') return item as AudioItem;
        const { getQuickPlayItem } = useQuickPlayItems();
        const quickPlayItem = getQuickPlayItem(firstUuid);
        if (quickPlayItem) return quickPlayItem;
      }
    }
    if (selectedItem.value && selectedItem.value.type === 'audio') {
      return selectedItem.value as AudioItem;
    }
    return null;
  };

  const triggerSlot = async (slotIndex: number) => {
    const item = quickPlayCells.value[slotIndex];
    if (item) return playQuickPlay(item);
  };

  const findSlotForEvent = (e: KeyboardEvent): number => {
    const mappings = keyMappings.value;
    const pressed = eventToBinding(e);
    for (const [slotStr, binding] of Object.entries(mappings)) {
      if (bindingsMatch(binding, pressed)) return Number(slotStr);
    }
    // Shift changes the produced character on many layouts. Saved bindings use it first.
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && /^Digit[0-9]$/.test(e.code)) {
      const digit = e.code[5];
      const index = QUICK_PLAY_DIGITS.indexOf(digit) + QUICK_PLAY_DIGITS.length;
      const binding = mappings[index];
      if (binding && quickPlayCells.value[index]?.quickPlay?.hotkey === undefined &&
          bindingsMatch(binding, { ...pressed, key: digit })) return index;
    }
    return -1;
  };

  const findPlaybackActionForEvent = (e: KeyboardEvent): PlaybackKeyAction | null => {
    const mappings = playbackMappings.value;
    const pressed = eventToBinding(e);
    for (const [action, binding] of Object.entries(mappings) as [PlaybackKeyAction, QuickPlaySlotKeyBinding | null][]) {
      if (!workspace && isWorkspaceAction(action)) continue;
      if (binding && bindingsMatch(binding, pressed)) return action;
    }
    const alternate = bindings.value.pauseAlternate;
    if (alternate && bindingsMatch(alternate, pressed)) return 'pause-resume';
    return null;
  };

  const dispatchPlaybackAction = async (action: PlaybackKeyAction) => {
    if (isWorkspaceAction(action)) return workspace?.[action]();
    if (action === 'toggle-detached-quickplays') {
      try {
        await window.electronAPI?.toggleDetachedQuickPlayWindow();
      } catch {
        showHeaderWarning(t('quickPlays.windowToggleFailed'));
      }
      return;
    }
    if (action === 'pause-resume') {
      const item = getTargetItem();
      if (!item) return;
      if (activeCues.value.has(item.uuid)) {
        const cue = activeCues.value.get(item.uuid);
        return cue?.isPaused ? resumeCue(item.uuid) : pauseCue(item.uuid);
      }
      return playCue(item);
    }

    if (action === 'toggle-loop') {
      const item = getTargetItem();
      if (!item) return;
      toggleCueLoop(item);
      return;
    }

    if (action === 'cue-to-continue') {
      const item = getTargetItem();
      if (!item) return;
      return queueLoopContinuation(item);
    }

    if (action === 'jump-cue') {
      const item = getTargetItem();
      if (!item) return;
      return jumpCue(item);
    }

    if (action === 'stop-all') return stopAllCues();
    if (action === 'toggle-video-output') return toggleVideoOutput();
    if (action === 'fullscreen-video-output') return toggleVideoOutput(true);
    // Both capture the Video Output. The second action keeps the name it was
    // saved under in show files; it used to capture another screen.
    if (action === 'capture-video-standby') return captureStill('standby');
    if (action === 'capture-display-standby') return captureStill('cue');

    if (action === 'select-up' || action === 'select-down') {
      const project = currentProject.value;
      if (!project) return;
      const all = getAllItemsFlat(project.items);
      if (all.length === 0) return;
      if (!selectedItem.value) {
        toggleItemSelection(all[0].uuid, false, false);
        return;
      }
      const idx = all.findIndex(i => i.uuid === selectedItem.value!.uuid);
      if (action === 'select-up' && idx > 0) {
        toggleItemSelection(all[idx - 1].uuid, false, false);
      } else if (action === 'select-down' && idx < all.length - 1) {
        toggleItemSelection(all[idx + 1].uuid, false, false);
      } else if (idx === -1 && all.length > 0) {
        toggleItemSelection(all[0].uuid, false, false);
      }
      return;
    }

    if (action === 'set-up-next') {
      const item = selectedItem.value;
      if (!item || (item.type === 'audio' && (item as AudioItem).quickPlay)) return false;
      return setNextItem(item.uuid);
    }

    if (action === 'play-selected') {
      const uuid = Array.from(selectedItems.value).pop();
      if (!uuid) return;
      const item = findItemByUuid(uuid);
      if (!item || item.type !== 'audio') return;
      return playCue(item as AudioItem);
    }

    if (action === 'play-next') {
      return playNext();
    }
  };

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || (!isForwardedFromVideoOutput(e) && isTextInputFocused())) return;

    // Stop All is a server-global panic action: native diagnostics and orphaned
    // cues can remain active without a project document or local activeCue.
    const playbackAction = findPlaybackActionForEvent(e);
    if (playbackAction) {
      // The detached window gets a project snapshot without a hydration status.
      const closingDetached = playbackAction === 'toggle-detached-quickplays' && isDetached;
      // It has no full show, so the operator window runs its transport keys.
      // Stop All works from here as everywhere.
      if (isDetached && playbackAction !== 'stop-all' && !closingDetached) {
        e.preventDefault();
        e.stopPropagation();
        forwardToOperator(e);
        return;
      }
      if (playbackAction !== 'stop-all' && playbackAction !== 'fullscreen-video-output' && !closingDetached &&
          (!currentProject.value || projectHydrationStatus.value !== 'ready')) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat && playbackAction !== 'select-up' && playbackAction !== 'select-down') return;
      void dispatchPlaybackAction(playbackAction);
      return;
    }

    // QuickPlay slot hotkeys
    if (!currentProject.value || !quickPlayPlaybackReady.value) return;
    const slotIndex = findSlotForEvent(e);
    if (slotIndex >= 0) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) void triggerSlot(slotIndex);
    }
  };

  const updateBinding = (slotIndex: number, binding: QuickPlaySlotKeyBinding): { conflict: number } => {
    if (!currentProject.value) return { conflict: -1 };
    const mappings = keyMappings.value;
    for (const [slotStr, existing] of Object.entries(mappings)) {
      const existingSlot = parseInt(slotStr, 10);
      if (existingSlot !== slotIndex && bindingsMatch(existing, binding)) {
        return { conflict: existingSlot };
      }
    }
    const item = quickPlayCells.value[slotIndex];
    if (!item?.quickPlay) return { conflict: -1 };
    item.quickPlay.hotkey = binding;
    return { conflict: -1 };
  };

  const updatePlaybackBinding = (
    action: PlaybackKeyAction,
    binding: QuickPlaySlotKeyBinding | null
  ): { conflictSlot: number; conflictAction: PlaybackKeyAction | null } => {
    if (!currentProject.value) return { conflictSlot: -1, conflictAction: null };

    if (binding !== null) {
      // Check conflict with QuickPlays
      const quickPlayMappings = keyMappings.value;
      for (const [slotStr, existing] of Object.entries(quickPlayMappings)) {
        if (bindingsMatch(existing, binding)) return { conflictSlot: parseInt(slotStr, 10), conflictAction: null };
      }
      // Check conflict with other playback actions
      const pbMappings = playbackMappings.value;
      for (const [existingAction, existingBinding] of Object.entries(pbMappings) as [PlaybackKeyAction, QuickPlaySlotKeyBinding | null][]) {
        if (existingAction !== action && existingBinding && bindingsMatch(existingBinding, binding)) {
          return { conflictSlot: -1, conflictAction: existingAction };
        }
      }
    }

    if (!currentProject.value.playbackKeys) currentProject.value.playbackKeys = {};
    currentProject.value.playbackKeys[action] = binding;
    return { conflictSlot: -1, conflictAction: null };
  };

  const resetToDefaults = () => {
    if (!currentProject.value) return;
    for (const item of quickPlayCells.value) {
      if (item?.quickPlay) delete item.quickPlay.hotkey;
    }
  };

  const resetPlaybackToDefaults = () => {
    if (!currentProject.value) return;
    currentProject.value.playbackKeys = {};
  };

  let isMounted = false;

  const mount = () => {
    if (isMounted) return;
    window.addEventListener('keydown', handleKeydown);
    isMounted = true;
  };

  const unmount = () => {
    if (!isMounted) return;
    window.removeEventListener('keydown', handleKeydown);
    isMounted = false;
  };

  return {
    keyMappings,
    playbackMappings,
    playbackKeyLabel,
    triggerSlot,
    mount,
    unmount,
    updateBinding,
    updatePlaybackBinding,
    resetToDefaults,
    resetPlaybackToDefaults,
    findSlotForEvent,
  };
};
