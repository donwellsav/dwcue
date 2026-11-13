import type { CartSlotKeyBinding, PlaybackKeyAction, AudioItem, Project } from '~/types/project';
import { DEFAULT_PLAYBACK_KEYS } from '../types/project';
import { buildOneShotSlots } from '../utils/oneShots';

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

export const bindingsMatch = (a: CartSlotKeyBinding, b: CartSlotKeyBinding): boolean =>
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
  { id: 'capture-video-standby', labelKey: 'controls.captureVideoStandby' },
  { id: 'capture-display-standby', labelKey: 'controls.captureDisplayStandby' },
  { id: 'play-selected', labelKey: 'controls.playSelected' },
];

export const resolveKeyboardBindings = (
  slots: readonly (AudioItem | null)[],
  savedPlayback: Project['playbackKeys'] = {},
) => {
  const keyMappings: Record<number, CartSlotKeyBinding> = Object.fromEntries(
    slots.flatMap((item, index) => item?.oneShot?.hotkey ? [[index, item.oneShot.hotkey]] : []),
  );
  const playbackMappings: Partial<Record<PlaybackKeyAction, CartSlotKeyBinding | null>> = {
    ...DEFAULT_PLAYBACK_KEYS, ...savedPlayback,
  };
  // A new default must yield to a key the operator already assigned.
  const assigned = [...Object.values(keyMappings), ...Object.values(savedPlayback)];
  for (const action of ['set-up-next', 'play-selected', 'toggle-loop', 'jump-cue', 'cue-to-continue', 'toggle-video-output', 'capture-video-standby', 'capture-display-standby'] as const) {
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
    const oneShot = slots[index]?.oneShot;
    if (!oneShot || oneShot.hotkey !== undefined) continue;
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
  return async () => {
    const api = window.electronAPI?.videoOutput;
    if (!api || togglingVideoOutput) return false;
    togglingVideoOutput = true;
    try {
      const status = await api.status();
      if (status.enabled || status.open) await api.close();
      else await api.open();
      return true;
    } catch {
      showHeaderWarning(t('headerWarnings.videoToggleFailed'), 'urgent');
      return false;
    } finally {
      togglingVideoOutput = false;
    }
  };
};

export const useCartHotkeys = () => {
  const { currentProject, projectHydrationStatus, selectedItem, selectedItems, saveProject, getAllItemsFlat, toggleItemSelection, findItemByUuid } = useProject();
  const { cartOnlyItems } = useCartItems();
  const { oneShotPlaybackReady, playOneShot } = useOneShotPlayback();
  const toggleVideoOutput = useVideoOutputToggle();
  const { captureStandby } = useVideoStandbyCapture();
  const { playCue, playNext, setNextItem, pauseCue, resumeCue, stopAllCues, activeCues, queueLoopContinuation, jumpCue } = useAudioEngine();

  const oneShotSlots = computed(() => buildOneShotSlots(
    currentProject.value?.items ?? [],
    Array.from(cartOnlyItems.value.values()),
  ));
  const bindings = computed(() => resolveKeyboardBindings(
    oneShotSlots.value, currentProject.value?.playbackKeys ?? {},
  ));
  const keyMappings = computed(() => bindings.value.keyMappings);
  const playbackMappings = computed(() => bindings.value.playbackMappings);
  const playbackKeyLabel = (action: PlaybackKeyAction): string => {
    const primary = playbackMappings.value[action];
    const alternate = action === 'pause-resume' ? bindings.value.pauseAlternate : null;
    return [primary, alternate].filter(binding => binding != null).map(formatKeyLabel).join(' / ');
  };

  const isTextInputFocused = (): boolean => {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return true;
    if ((el as HTMLElement).isContentEditable) return true;
    return false;
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

  const triggerSlot = async (slotIndex: number) => {
    const item = oneShotSlots.value[slotIndex];
    if (item) return playOneShot(item);
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
      if (binding && oneShotSlots.value[index]?.oneShot?.hotkey === undefined &&
          bindingsMatch(binding, { ...pressed, key: digit })) return index;
    }
    return -1;
  };

  const findPlaybackActionForEvent = (e: KeyboardEvent): PlaybackKeyAction | null => {
    const mappings = playbackMappings.value;
    const pressed = eventToBinding(e);
    for (const [action, binding] of Object.entries(mappings) as [PlaybackKeyAction, CartSlotKeyBinding | null][]) {
      if (binding && bindingsMatch(binding, pressed)) return action;
    }
    const alternate = bindings.value.pauseAlternate;
    if (alternate && bindingsMatch(alternate, pressed)) return 'pause-resume';
    return null;
  };

  const dispatchPlaybackAction = async (action: PlaybackKeyAction) => {
    if (action !== 'stop-all' && projectHydrationStatus.value !== 'ready') return false;
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
      if (item.endBehavior?.action === 'loop') {
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
      return queueLoopContinuation(item);
    }

    if (action === 'jump-cue') {
      const item = getTargetItem();
      if (!item) return;
      return jumpCue(item);
    }

    if (action === 'stop-all') return stopAllCues();
    if (action === 'toggle-video-output') return toggleVideoOutput();
    if (action === 'capture-video-standby') return captureStandby('output');
    if (action === 'capture-display-standby') return captureStandby('display');

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
      if (!item || (item.type === 'audio' && (item as AudioItem).oneShot)) return false;
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
      if (playbackAction !== 'stop-all' &&
          (!currentProject.value || projectHydrationStatus.value !== 'ready')) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat && playbackAction !== 'select-up' && playbackAction !== 'select-down') return;
      void dispatchPlaybackAction(playbackAction);
      return;
    }

    // Cart slot hotkeys
    if (!currentProject.value || !oneShotPlaybackReady.value) return;
    const slotIndex = findSlotForEvent(e);
    if (slotIndex >= 0) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) void triggerSlot(slotIndex);
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
