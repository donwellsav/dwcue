import type { AudioItem, GroupItem } from '../types/project';

export type OneShotPlaybackMode = 'overlay' | 'duck' | 'replace';
export type OneShotEndMode = 'stop' | 'loop';

// The layout editor supports up to 16 × 16 cells. Capping bad saved order
// values here prevents a corrupt project from allocating an unbounded grid.
export const MAX_ONE_SHOT_SLOTS = 256;

export const isOneShot = (item: AudioItem): boolean =>
  !!item.oneShot && typeof item.oneShot === 'object';

export const flattenOneShots = (
  items: readonly (AudioItem | GroupItem)[],
  standaloneItems: readonly AudioItem[] = [],
): AudioItem[] => {
  const found: Array<{ item: AudioItem; traversal: number }> = [];
  const seen = new Set<string>();
  let traversal = 0;
  const include = (item: AudioItem) => {
    if (seen.has(item.uuid)) return;
    seen.add(item.uuid);
    if (isOneShot(item)) found.push({ item, traversal });
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
    const aOrder = Number.isFinite(a.item.oneShot?.order)
      ? a.item.oneShot!.order : Number.POSITIVE_INFINITY;
    const bOrder = Number.isFinite(b.item.oneShot?.order)
      ? b.item.oneShot!.order : Number.POSITIVE_INFINITY;
    return aOrder - bOrder || a.traversal - b.traversal;
  });
  return found.map(({ item }) => item);
};

export const buildOneShotSlots = (
  items: readonly (AudioItem | GroupItem)[],
  standaloneItems: readonly AudioItem[] = [],
  minimumSlots = 0,
): Array<AudioItem | null> => {
  const oneShots = flattenOneShots(items, standaloneItems);
  const safeMinimum = Math.min(
    MAX_ONE_SHOT_SLOTS,
    Math.max(0, Math.floor(Number.isFinite(minimumSlots) ? minimumSlots : 0)),
  );
  const highestOrder = oneShots.reduce((highest, item) => {
    const order = item.oneShot?.order;
    return typeof order === 'number' && Number.isInteger(order)
      && order >= 0 && order < MAX_ONE_SHOT_SLOTS
      ? Math.max(highest, order)
      : highest;
  }, -1);
  const slotCount = Math.min(
    MAX_ONE_SHOT_SLOTS,
    Math.max(safeMinimum, highestOrder + 1, oneShots.length),
  );
  const slots: Array<AudioItem | null> = Array.from({ length: slotCount }, () => null);
  const unplaced: AudioItem[] = [];

  for (const item of oneShots) {
    const order = item.oneShot?.order;
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

export const nextAvailableOneShotOrder = (
  items: readonly (AudioItem | GroupItem)[],
  standaloneItems: readonly AudioItem[] = [],
): number => {
  const slots = buildOneShotSlots(items, standaloneItems);
  const gap = slots.indexOf(null);
  if (gap >= 0) return gap;
  return slots.length < MAX_ONE_SHOT_SLOTS ? slots.length : -1;
};

export const nextOneShotOrder = (
  items: readonly (AudioItem | GroupItem)[],
  standaloneItems: readonly AudioItem[] = [],
): number => flattenOneShots(items, standaloneItems).reduce(
  (next, item) => Number.isFinite(item.oneShot?.order)
    ? Math.max(next, item.oneShot!.order + 1)
    : next,
  0,
);

export const markAsOneShot = (item: AudioItem, order: number): void => {
  item.oneShot = { order, retrigger: 'restart' };
  // Safe quick-fire defaults: do not stop Program and do not advance Up Next.
  item.duckingBehavior = { ...item.duckingBehavior, mode: 'no-ducking' };
  item.startBehavior = { action: 'nothing' };
  item.endBehavior = { action: 'nothing' };
};

export const cloneAsIndependentOneShot = (
  source: AudioItem,
  uuid: string,
  order: number,
  preserveOneShotPlayback = false,
): AudioItem => {
  const clone = JSON.parse(JSON.stringify(source)) as AudioItem;
  const savedSettings = clone.oneShot;
  clone.uuid = uuid;
  clone.index = [-1, order];
  if (preserveOneShotPlayback && savedSettings) {
    clone.oneShot = { ...savedSettings, order, sourceUuid: savedSettings.sourceUuid ?? source.uuid };
  } else {
    markAsOneShot(clone, order);
    clone.oneShot!.sourceUuid = source.uuid;
  }
  return clone;
};

/**
 * Copy a One Shot into the playlist without consuming the source cell.
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
  delete clone.oneShot;
  return clone;
};

export const removeOneShotDesignation = (item: AudioItem): void => {
  delete item.oneShot;
};

export const getOneShotPlaybackMode = (item: AudioItem): OneShotPlaybackMode => {
  if (item.duckingBehavior.mode === 'duck-others') return 'duck';
  if (item.duckingBehavior.mode === 'stop-all') return 'replace';
  return 'overlay';
};

export const setOneShotPlaybackMode = (
  item: AudioItem,
  mode: OneShotPlaybackMode,
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

export const getOneShotEndMode = (item: AudioItem): OneShotEndMode =>
  item.endBehavior.action === 'loop' ? 'loop' : 'stop';

export const setOneShotEndMode = (item: AudioItem, mode: OneShotEndMode): void => {
  item.endBehavior = { action: mode === 'loop' ? 'loop' : 'nothing' };
};
