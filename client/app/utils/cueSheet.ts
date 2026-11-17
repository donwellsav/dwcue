import type { AudioItem, GroupItem } from '../types/project';
import type { CueSheetEndBehavior, CueSheetItem, CueSheetQuickPlay } from '../types/cueSheet';
import { buildQuickPlayCells } from './quickPlays';

type PlaylistEntry = AudioItem | GroupItem;

// Played length as the playlist row shows it: trimmed by the in/out points.
const playedSeconds = (item: AudioItem): number =>
  (item.outPoint || item.duration) - (item.inPoint || 0);

/**
 * Copy what the cue sheet prints out of the open show: plain values only (no
 * reactive proxies, waveforms or file paths), ready to cross IPC.
 */
export function cueSheetContents(
  items: readonly PlaylistEntry[],
  standaloneItems: readonly AudioItem[] = [],
): { items: CueSheetItem[]; quickPlays: CueSheetQuickPlay[] } {
  // Where each cue sits in the playlist, so Go to Item can name its target.
  const paths = new Map<string, number[]>();
  const index = (source: readonly PlaylistEntry[], parent: number[]): void => {
    source.forEach((item, position) => {
      const path = [...parent, position];
      paths.set(item.uuid, path);
      if (item.type === 'group') index(item.children, path);
    });
  };
  index(items, []);

  const endBehavior = (item: PlaylistEntry): CueSheetEndBehavior => {
    const end = item.endBehavior;
    const action = end?.action ?? '';
    const target = action === 'goto-item' ? paths.get(end?.targetUuid ?? '')
      : action === 'goto-index' ? end?.targetIndex
        : undefined;
    return target?.length ? { action, targetIndex: [...target] } : { action };
  };

  const row = (item: PlaylistEntry): CueSheetItem => item.type === 'group'
    ? {
        type: 'group',
        displayName: item.displayName,
        note: item.note ?? '',
        groupGainDb: item.groupGainDb ?? 0,
        endBehavior: endBehavior(item),
        children: item.children.map(row),
      }
    : {
        // A summary row, not a new audio item (it carries no media or defaults).
        type: item.type,
        displayName: item.displayName,
        note: item.note ?? '',
        duration: playedSeconds(item),
        volume: item.volume,
        endBehavior: endBehavior(item),
      };

  const quickPlays: CueSheetQuickPlay[] = [];
  buildQuickPlayCells(items, standaloneItems).forEach((item, slot) => {
    if (!item) return;
    quickPlays.push({
      slot: slot + 1,
      displayName: item.displayName,
      duration: playedSeconds(item),
      volume: item.volume,
      endBehavior: endBehavior(item),
    });
  });

  return { items: items.map(row), quickPlays };
}
