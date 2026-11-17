// One feature, one name: QuickPlay. Operators, the code, saved shows and the
// engine all say it (quickPlay, QuickPlayPanel, .quickplay-tile, quickPlayItems,
// quickPlaySlots, quickplay_slot_set). Shows saved before the rename used other
// names; utils/legacyQuickPlayNames.ts converts them as a show enters the app
// and is the only code that still reads them.
import type { AudioItem, GroupItem } from '../types/project';

export type QuickPlayPlaybackMode = 'overlay' | 'duck' | 'replace';
// 'goto' reports a Go to Item / Go to Index ending authored in Properties. The
// compact picker shows it but cannot create one, because it needs a target.
export type QuickPlayEndMode = 'stop' | 'loop' | 'next' | 'goto';

// Server-owned Cue to Continue state for the pass that is playing right now.
// 'armed' forces Play Up Next for this pass; 'suppressed' cancels an authored
// Play Next for this pass. Neither is ever written to the show file.
export type CueFollowOverride = 'armed' | 'suppressed';

// The layout editor supports up to 16 × 16 cells. Capping bad saved order
// values here prevents a corrupt project from allocating an unbounded grid.
export const MAX_QUICK_PLAY_SLOTS = 256;

export const isQuickPlay = (item: AudioItem): boolean =>
  !!item.quickPlay && typeof item.quickPlay === 'object';

export const flattenQuickPlays = (
  items: readonly (AudioItem | GroupItem)[],
  standaloneItems: readonly AudioItem[] = [],
): AudioItem[] => {
  const found: Array<{ item: AudioItem; traversal: number }> = [];
  const seen = new Set<string>();
  let traversal = 0;
  const include = (item: AudioItem) => {
    if (seen.has(item.uuid)) return;
    seen.add(item.uuid);
    if (isQuickPlay(item)) found.push({ item, traversal });
    traversal++;
  };
  const walk = (source: readonly (AudioItem | GroupItem)[]) => {
    for (const item of source) {
      if (item.type === 'audio') {
        include(item);
      } else {
        walk(item.children);
      }
    }
  };
  walk(items);
  standaloneItems.forEach(include);
  found.sort((a, b) => {
    const aOrder = Number.isFinite(a.item.quickPlay?.order)
      ? a.item.quickPlay!.order : Number.POSITIVE_INFINITY;
    const bOrder = Number.isFinite(b.item.quickPlay?.order)
      ? b.item.quickPlay!.order : Number.POSITIVE_INFINITY;
    return aOrder - bOrder || a.traversal - b.traversal;
  });
  return found.map(({ item }) => item);
};

export const buildQuickPlayCells = (
  items: readonly (AudioItem | GroupItem)[],
  standaloneItems: readonly AudioItem[] = [],
  minimumSlots = 0,
): Array<AudioItem | null> => {
  const quickPlays = flattenQuickPlays(items, standaloneItems);
  const safeMinimum = Math.min(
    MAX_QUICK_PLAY_SLOTS,
    Math.max(0, Math.floor(Number.isFinite(minimumSlots) ? minimumSlots : 0)),
  );
  const highestOrder = quickPlays.reduce((highest, item) => {
    const order = item.quickPlay?.order;
    return typeof order === 'number' && Number.isInteger(order)
      && order >= 0 && order < MAX_QUICK_PLAY_SLOTS
      ? Math.max(highest, order)
      : highest;
  }, -1);
  const slotCount = Math.min(
    MAX_QUICK_PLAY_SLOTS,
    Math.max(safeMinimum, highestOrder + 1, quickPlays.length),
  );
  const slots: Array<AudioItem | null> = Array.from({ length: slotCount }, () => null);
  const unplaced: AudioItem[] = [];

  for (const item of quickPlays) {
    const order = item.quickPlay?.order;
    if (typeof order === 'number' && Number.isInteger(order)
      && order >= 0 && order < slotCount && !slots[order]) {
      slots[order] = item;
    } else {
      unplaced.push(item);
    }
  }

  for (const item of unplaced) {
    const freeSlot = slots.indexOf(null);
    if (freeSlot === -1) break;
    slots[freeSlot] = item;
  }
  return slots;
};

export const nextAvailableQuickPlayOrder = (
  items: readonly (AudioItem | GroupItem)[],
  standaloneItems: readonly AudioItem[] = [],
): number => {
  const slots = buildQuickPlayCells(items, standaloneItems);
  const gap = slots.indexOf(null);
  if (gap >= 0) return gap;
  return slots.length < MAX_QUICK_PLAY_SLOTS ? slots.length : -1;
};

export const nextQuickPlayOrder = (
  items: readonly (AudioItem | GroupItem)[],
  standaloneItems: readonly AudioItem[] = [],
): number => flattenQuickPlays(items, standaloneItems).reduce(
  (next, item) => Number.isFinite(item.quickPlay?.order)
    ? Math.max(next, item.quickPlay!.order + 1)
    : next,
  0,
);

export const markAsQuickPlay = (item: AudioItem, order: number): void => {
  item.quickPlay = { order, retrigger: 'restart' };
  setQuickPlayPlaybackMode(item, 'replace');
  item.playFade = 0.1;
  item.stopFade = 0.5;
  item.fadeOutDuration = item.stopFade;
  item.crossFade = 0;
  item.startNextEnabled = false;
  item.startBehavior = { action: 'nothing' };
  item.endBehavior = { action: 'nothing' };
};

export const cloneAsIndependentQuickPlay = (
  source: AudioItem,
  uuid: string,
  order: number,
  preserveQuickPlayPlayback = false,
): AudioItem => {
  const clone = JSON.parse(JSON.stringify(source)) as AudioItem;
  const savedSettings = clone.quickPlay;
  clone.uuid = uuid;
  clone.index = [-1, order];
  if (preserveQuickPlayPlayback && savedSettings) {
    clone.quickPlay = { ...savedSettings, order, sourceUuid: savedSettings.sourceUuid ?? source.uuid };
  } else {
    markAsQuickPlay(clone, order);
    clone.quickPlay!.sourceUuid = source.uuid;
  }
  return clone;
};

/**
 * Copy a QuickPlay into the playlist without consuming the source cell.
 *
 * The copy is a normal playlist cue: its quick-fire designation is removed,
 * while the audio file, trim points, gain, and other cue settings stay intact.
 */
export const cloneAsPlaylistItem = (
  source: AudioItem,
  uuid: string,
): AudioItem => {
  const clone = JSON.parse(JSON.stringify(source)) as AudioItem;
  clone.uuid = uuid;
  clone.index = [0];
  delete clone.quickPlay;
  return clone;
};

export const removeQuickPlayDesignation = (item: AudioItem): void => {
  delete item.quickPlay;
};

export const getQuickPlayPlaybackMode = (item: AudioItem): QuickPlayPlaybackMode => {
  const mode = item.duckingBehavior?.mode ?? 'stop-all';
  if (mode === 'duck-others') return 'duck';
  if (mode === 'stop-all') return 'replace';
  return 'overlay';
};

export const setQuickPlayPlaybackMode = (
  item: AudioItem,
  mode: QuickPlayPlaybackMode,
): void => {
  item.duckingBehavior = {
    ...item.duckingBehavior,
    mode: mode === 'duck' ? 'duck-others'
      : mode === 'replace' ? 'stop-all'
        : 'no-ducking',
  };
  if (mode === 'duck' && item.duckingBehavior.duckLevel == null)
    item.duckingBehavior.duckLevel = 0.1;
};

export const getQuickPlayEndMode = (item: AudioItem): QuickPlayEndMode => {
  const action = item.endBehavior?.action;
  if (action === 'loop') return 'loop';
  if (action === 'next') return 'next';
  if (action === 'goto-item' || action === 'goto-index') return 'goto';
  return 'stop';
};

export const setQuickPlayEndMode = (item: AudioItem, mode: QuickPlayEndMode): void => {
  // Re-selecting the reported Go to ending must not discard its target.
  if (mode === 'goto') return;
  item.endBehavior = {
    action: mode === 'loop' ? 'loop' : mode === 'next' ? 'next' : 'nothing',
  };
};

/**
 * Whether this QuickPlay will start the playlist's Up Next cue when it
 * finishes. While it plays, the server-owned override for the current pass
 * wins over the authored Ending; when idle only the authored Ending applies.
 */
export const quickPlayFollowsUpNext = (
  item: AudioItem,
  override?: CueFollowOverride | null,
): boolean => override === 'armed'
  || (override !== 'suppressed' && item.endBehavior?.action === 'next');
