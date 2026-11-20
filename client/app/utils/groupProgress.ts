import type { AudioItem, GroupItem } from '../types/project';

export interface GroupProgress {
  uuid: string;
  displayName: string;
  totalDuration: number;
  currentTime: number;
}

// Progress of every group with something playing in it. `playing` maps each
// playing audio item to how far into it the cue is. A Play All group lasts as
// long as its longest child; a group that plays its children in turn adds
// them up, counting those before the playing one as played. A group playing
// inside another counts toward its parent.
export function computeActiveGroups(
  items: (AudioItem | GroupItem)[],
  playing: ReadonlyMap<string, number>,
  lengthOf: (item: AudioItem) => number,
): Map<string, GroupProgress> {
  const groups = new Map<string, GroupProgress>();
  const progress = (item: AudioItem | GroupItem): { total: number; elapsed: number; active: boolean } => {
    if (item.type === 'audio') {
      const total = lengthOf(item as AudioItem);
      const at = playing.get(item.uuid);
      return { total, elapsed: at === undefined ? 0 : Math.min(Math.max(0, at), total), active: at !== undefined };
    }
    const group = item as GroupItem;
    const parts = group.children.map(progress);
    const active = parts.some(part => part.active);
    let total = 0;
    let elapsed = 0;
    if (group.startBehavior?.action === 'play-all') {
      for (const part of parts) {
        total = Math.max(total, part.total);
        if (part.active) elapsed = Math.max(elapsed, part.elapsed);
      }
    } else {
      let reached = false;
      for (const part of parts) {
        total += part.total;
        if (part.active) { elapsed += part.elapsed; reached = true; }
        else if (!reached) elapsed += part.total;
      }
    }
    elapsed = Math.min(elapsed, total);
    if (active) groups.set(group.uuid, { uuid: group.uuid, displayName: group.displayName, totalDuration: total, currentTime: elapsed });
    return { total, elapsed, active };
  };
  for (const item of items) if (item.type === 'group') progress(item);
  return groups;
}
