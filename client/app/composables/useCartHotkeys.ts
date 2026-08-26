import type { CartSlotKeyBinding, PlaybackKeyAction, AudioItem } from '~/types/project';
import { DEFAULT_PLAYBACK_KEYS } from '~/types/project';
import { buildOneShotSlots } from '~/utils/oneShots';

const RESERVED_COMBOS: CartSlotKeyBinding[] = [
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

const bindingsMatch = (a: CartSlotKeyBinding, b: CartSlotKeyBinding): boolean =>
  a.key.toLowerCase() === b.key.toLowerCase()
  && a.ctrlKey  === b.ctrlKey
  && a.shiftKey === b.shiftKey
  && a.altKey   === b.altKey;

export const isReservedCombo = (binding: CartSlotKeyBinding): boolean =>
  RESERVED_COMBOS.some(r => bindingsMatch(r, binding));

export const formatKeyLabel = (binding: CartSlotKeyBinding): string => {
  const parts: string[] = [];
  if (binding.ctrlKey)  parts.push('Ctrl');
  if (binding.shiftKey) parts.push('Shift');
  if (binding.altKey)   parts.push('Alt');
  const keyLabel = binding.key === ' ' ? 'Space'
    : binding.key.length === 1 ? binding.key.toUpperCase()
    : binding.key;
  parts.push(keyLabel);
  return parts.join('+');
};

export const eventToBinding = (e: KeyboardEvent): CartSlotKeyBinding => ({
  key: e.key,
  ctrlKey: e.ctrlKey || e.metaKey,
  shiftKey: e.shiftKey,
  altKey: e.altKey,
});

// Playback action metadata (order mirrors MIDI_ACTIONS). Shared by the
// shortcuts editor and the read-only shortcuts summary on the Help tab.
export const PLAYBACK_ACTIONS: { id: PlaybackKeyAction; labelKey: string }[] = [
  { id: 'play-next',     labelKey: 'controls.playNext'     },
  { id: 'pause-resume',  labelKey: 'controls.pauseResume'  },
  { id: 'toggle-loop',   labelKey: 'controls.toggleLoop'   },
  { id: 'cue-to-continue', labelKey: 'controls.cueToContinue' },
  { id: 'jump-cue',      labelKey: 'controls.jumpCue'      },
  { id: 'stop-all',      labelKey: 'controls.stopAll'      },
  { id: 'select-up',     labelKey: 'controls.selectUp'     },
  { id: 'select-down',   labelKey: 'controls.selectDown'   },
  { id: 'play-selected', labelKey: 'controls.playSelected' },
];

export const useCartHotkeys = () => {
  const { currentProject, selectedItem, selectedItems, saveProject, getAllItemsFlat, toggleItemSelection, findItemByUuid } = useProject();
  const { cartOnlyItems } = useCartItems();
  const { showMode, fireBlocked, disarm } = useOneShotArm();
  const { playCue, pauseCue, resumeCue, stopAllCues, activeCues, nextItemOverrideUuid, autoNextItemUuid, setNextItem, triggerGroup, queueLoopContinuation, jumpCue } = useAudioEngine();

  const oneShotSlots = computed(() => buildOneShotSlots(
    currentProject.value?.items ?? [],
    Array.from(cartOnlyItems.value.values()),
  ));
  // Keep the ordinal-keyed shape used by the existing Controls screen and
  // saved MIDI action ids, but source every binding from the canonical cue.
  const keyMappings = computed<Record<number, CartSlotKeyBinding>>(() =>
    Object.fromEntries(oneShotSlots.value.flatMap((item, index) =>
      item?.oneShot?.hotkey ? [[index, item.oneShot.hotkey]] : []
    ))
  );

  const playbackMappings = computed<Partial<Record<PlaybackKeyAction, CartSlotKeyBinding | null>>>(() => {
    const saved = currentProject.value?.playbackKeys ?? {};
    const result: Partial<Record<PlaybackKeyAction, CartSlotKeyBinding | null>> = { ...DEFAULT_PLAYBACK_KEYS };
    for (const [action, binding] of Object.entries(saved)) {
      result[action as PlaybackKeyAction] = binding;
    }
    return result;
  });

  const isTextInputFocused = (): boolean => {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return true;
    if ((el as HTMLElement).isContentEditable) return true;
    return false;
  };

  const getTargetItem = (): AudioItem | null => {
    if (activeCues.value.size > 0) {
      const firstUuid = activeCues.value.keys().next().value;
      if (firstUuid) {
        const { findItemByUuid } = useProject();
        const item = findItemByUuid(firstUuid);
        if (item && item.type === 'audio') return item as AudioItem;
        const { getCartOnlyItem } = useCartItems();
        const cartItem = getCartOnlyItem(firstUuid);
        if (cartItem) return cartItem;
      }
    }
    if (selectedItem.value && selectedItem.value.type === 'audio') {
      return selectedItem.value as AudioItem;
    }
    return null;
  };

  const triggerSlot = (slotIndex: number) => {
    const item = oneShotSlots.value[slotIndex];
    if (!item) return;
    if (activeCues.value.has(item.uuid)) {
      if (item.oneShot?.retrigger === 'ignore') return;
    }
    // Show-mode arm gate: a hotkey only fires while armed, and firing
    // disarms again so the next press needs a fresh arm.
    if (fireBlocked.value) return;
    if (showMode.value) disarm();
    playCue(item);
  };

  const findSlotForEvent = (e: KeyboardEvent): number => {
    const mappings = keyMappings.value;
    for (const [slotStr, binding] of Object.entries(mappings)) {
      if (
        e.key.toLowerCase() === binding.key.toLowerCase()
        && (e.ctrlKey || e.metaKey) === binding.ctrlKey
        && e.shiftKey === binding.shiftKey
        && e.altKey   === binding.altKey
      ) {
        return parseInt(slotStr, 10);
      }
    }
    return -1;
  };

  const findPlaybackActionForEvent = (e: KeyboardEvent): PlaybackKeyAction | null => {
    const mappings = playbackMappings.value;
    for (const [action, binding] of Object.entries(mappings) as [PlaybackKeyAction, CartSlotKeyBinding | null][]) {
      if (!binding) continue;
      if (
        e.key.toLowerCase() === binding.key.toLowerCase()
        && (e.ctrlKey || e.metaKey) === binding.ctrlKey
        && e.shiftKey === binding.shiftKey
        && e.altKey   === binding.altKey
      ) {
        return action;
      }
    }
    return null;
  };

  const dispatchPlaybackAction = (action: PlaybackKeyAction) => {
    if (action === 'pause-resume') {
      const item = getTargetItem();
      if (!item) return;
      if (activeCues.value.has(item.uuid)) {
        const cue = activeCues.value.get(item.uuid);
        if (cue && cue.isPaused) resumeCue(item.uuid);
        else pauseCue(item.uuid);
      } else {
        playCue(item);
      }
      return;
    }

    if (action === 'toggle-loop') {
      const item = getTargetItem();
      if (!item) return;
      if (item.endBehavior.action === 'loop') {
        item.endBehavior = { action: 'nothing' };
      } else {
        item.endBehavior = { action: 'loop' };
      }
      saveProject();
      return;
    }

    if (action === 'cue-to-continue') {
      const item = getTargetItem();
      if (!item) return;
      queueLoopContinuation(item, resolveLoopContinuationTarget(item));
      return;
    }

    if (action === 'jump-cue') {
      const item = getTargetItem();
      if (!item) return;
      jumpCue(item);
      return;
    }

    if (action === 'stop-all') {
      stopAllCues();
      return;
    }

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

    if (action === 'play-selected') {
      const uuid = Array.from(selectedItems.value).pop();
      if (!uuid) return;
      const item = findItemByUuid(uuid);
      if (!item || item.type !== 'audio') return;
      playCue(item as AudioItem);
      return;
    }

    if (action === 'play-next') {
      const effectiveUuid = nextItemOverrideUuid.value ?? autoNextItemUuid.value;
      if (!effectiveUuid) return;
      const item = findItemByUuid(effectiveUuid);
      if (!item) return;
      if (nextItemOverrideUuid.value) setNextItem(null);
      if (item.type === 'audio') playCue(item as AudioItem);
      else if (item.type === 'group') triggerGroup(item);
      return;
    }
  };

  const handleKeydown = (e: KeyboardEvent) => {
    if (isTextInputFocused()) return;
    if (!currentProject.value) return;

    // Playback actions
    const playbackAction = findPlaybackActionForEvent(e);
    if (playbackAction) {
      e.preventDefault();
      e.stopPropagation();
      dispatchPlaybackAction(playbackAction);
      return;
    }

    // Cart slot hotkeys
    const slotIndex = findSlotForEvent(e);
    if (slotIndex >= 0) {
      e.preventDefault();
      e.stopPropagation();
      triggerSlot(slotIndex);
    }
  };

  const updateBinding = (slotIndex: number, binding: CartSlotKeyBinding): { conflict: number } => {
    if (!currentProject.value) return { conflict: -1 };
    const mappings = keyMappings.value;
    for (const [slotStr, existing] of Object.entries(mappings)) {
      const existingSlot = parseInt(slotStr, 10);
      if (existingSlot !== slotIndex && bindingsMatch(existing, binding)) {
        return { conflict: existingSlot };
      }
    }
    const item = oneShotSlots.value[slotIndex];
    if (!item?.oneShot) return { conflict: -1 };
    item.oneShot.hotkey = binding;
    return { conflict: -1 };
  };

  const updatePlaybackBinding = (
    action: PlaybackKeyAction,
    binding: CartSlotKeyBinding | null
  ): { conflictSlot: number; conflictAction: PlaybackKeyAction | null } => {
    if (!currentProject.value) return { conflictSlot: -1, conflictAction: null };

    if (binding !== null) {
      // Check conflict with One Shots
      const cartMappings = keyMappings.value;
      for (const [slotStr, existing] of Object.entries(cartMappings)) {
        if (bindingsMatch(existing, binding)) return { conflictSlot: parseInt(slotStr, 10), conflictAction: null };
      }
      // Check conflict with other playback actions
      const pbMappings = playbackMappings.value;
      for (const [existingAction, existingBinding] of Object.entries(pbMappings) as [PlaybackKeyAction, CartSlotKeyBinding | null][]) {
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
    for (const item of oneShotSlots.value) {
      if (item?.oneShot) delete item.oneShot.hotkey;
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
