// =====================================================================
// usePlaylistReveal.ts
// ---------------------------------------------------------------------
// Makes the selected playlist row reachable when the selection is driven by
// something other than a mouse — the keyboard bindings (select-up /
// select-down), MIDI, or a Companion surface via the server. Those all walk
// the FLATTENED item tree, so the selection can legally land on a row that is
// scrolled out of view, or inside a collapsed group where no row exists to
// scroll to at all.
//
// This composable owns the second half of that problem: which groups are held
// open to expose the selection. (The scrolling itself lives in PlaylistView,
// which owns the scroll container.)
//
// A reveal is deliberately kept OUT of `group.isExpanded`: that field is
// persisted with the project, so peeking into a group while arrowing past it
// would dirty the document and outlive the session. Instead the group uuid
// goes in a transient set, and the group snaps shut again as soon as the
// selection moves somewhere else.
//
// It is promoted to a real `isExpanded = true` only once the operator commits
// to something in there — playing a cue, or arming one as Up Next. From then
// on the group is normally expanded and stays open until they collapse it by
// hand.
// =====================================================================
import type { AudioItem, GroupItem } from '~/types/project';

export const usePlaylistReveal = () => {
  const { currentProject } = useProject();

  // Groups forced open only to expose the current selection. Never persisted.
  const revealedGroups = useState<Set<string>>('playlistRevealedGroups', () => new Set());

  // Every group between the playlist root and `itemUuid`, outermost first.
  // Walks the live tree rather than trusting `item.index`, which is only
  // rewritten on structural edits and can lag a server-pushed document.
  const ancestorGroupsOf = (itemUuid: string): GroupItem[] => {
    const items = currentProject.value?.items;
    if (!items || !itemUuid) return [];

    const trail: GroupItem[] = [];
    const walk = (level: (AudioItem | GroupItem)[], chain: GroupItem[]): boolean => {
      for (const item of level) {
        if (item.uuid === itemUuid) {
          trail.push(...chain);
          return true;
        }
        if (item.type === 'group') {
          chain.push(item as GroupItem);
          if (walk((item as GroupItem).children ?? [], chain)) return true;
          chain.pop();
        }
      }
      return false;
    };
    walk(items, []);
    return trail;
  };

  // Read by PlaylistItem, alongside the group's own persisted isExpanded.
  const isRevealed = (groupUuid: string): boolean => revealedGroups.value.has(groupUuid);

  /**
   * Hold open whatever groups the selection now sits inside, and let go of the
   * ones it has moved out of — arrowing past a group opens it on the way in
   * and closes it again on the way out. Groups the operator had already
   * expanded are left untouched: they were never ours to close.
   */
  const revealSelection = (itemUuid: string | null) => {
    const ancestors = itemUuid ? ancestorGroupsOf(itemUuid) : [];
    const keep = new Set(ancestors.map(g => g.uuid));

    for (const uuid of [...revealedGroups.value]) {
      if (!keep.has(uuid)) revealedGroups.value.delete(uuid);
    }
    for (const group of ancestors) {
      if (!group.isExpanded) revealedGroups.value.add(group.uuid);
    }
  };

  /**
   * The operator committed to this item (it started playing, or it was armed
   * as Up Next), so its groups graduate from a temporary peek to normally
   * expanded — they stay open now until manually collapsed.
   */
  const commitReveal = (itemUuid: string) => {
    for (const group of ancestorGroupsOf(itemUuid)) {
      if (!group.isExpanded) group.isExpanded = true;
      revealedGroups.value.delete(group.uuid);
    }
  };

  /**
   * Called when the operator collapses a group by hand. Without dropping the
   * reveal, a group holding the selection would spring straight back open.
   */
  const forgetReveal = (groupUuid: string) => {
    revealedGroups.value.delete(groupUuid);
  };

  const clearReveals = () => {
    revealedGroups.value.clear();
  };

  return { revealedGroups, isRevealed, revealSelection, commitReveal, forgetReveal, clearReveals };
};
