import type { AudioItem, GroupItem } from '../types/project';

export type OneShotPlaybackMode = 'overlay' | 'duck' | 'replace';
export type OneShotEndMode = 'stop' | 'loop';

export const isOneShot = (item: AudioItem): boolean =>
  !!item.oneShot && typeof item.oneShot === 'object';

export const flattenOneShots = (
  items: readonly (AudioItem | GroupItem)[],
): AudioItem[] => {
  const found: Array<{ item: AudioItem; traversal: number }> = [];
  let traversal = 0;
  const walk = (source: readonly (AudioItem | GroupItem)[]) => {
    for (const item of source) {
      if (item.type === 'audio') {
        if (isOneShot(item)) found.push({ item, traversal });
        traversal++;
      } else {
        walk(item.children);
      }
    }
  };
  walk(items);
  found.sort((a, b) => {
    const aOrder = Number.isFinite(a.item.oneShot?.order)
      ? a.item.oneShot!.order : Number.POSITIVE_INFINITY;
    const bOrder = Number.isFinite(b.item.oneShot?.order)
      ? b.item.oneShot!.order : Number.POSITIVE_INFINITY;
    return aOrder - bOrder || a.traversal - b.traversal;
  });
  return found.map(({ item }) => item);
};

export const nextOneShotOrder = (
  items: readonly (AudioItem | GroupItem)[],
): number => flattenOneShots(items).reduce(
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
