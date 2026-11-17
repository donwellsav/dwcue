import type { AudioItem } from '~/types/project';

export const useQuickPlayItems = () => {
  // Store QuickPlay-only items separately (not in the playlist). Held via
  // useState so the shared map is SSR-safe and — critically — its
  // initializer doesn't run at module-top-level, which combined with
  // the bidirectional auto-import between useQuickPlayItems and useProject
  // could trip Vite's ESM-cycle TDZ ("Cannot access '_$__useProject'
  // before initialization").
  const quickPlayItems = useState<Map<string, AudioItem>>(
    'useQuickPlayItems.quickPlayItems',
    () => new Map(),
  );
  const { currentProject } = useProject();

  // Add an item that exists ONLY in the QuickPlays (not in playlist)
  const addQuickPlayItem = (item: AudioItem) => {
    quickPlayItems.value.set(item.uuid, item);
  };

  // Get QuickPlay item - checks both QuickPlay-only items and project items
  const getQuickPlayItemAtSlot = (slot: number): AudioItem | null => {
    if (!currentProject.value) return null;

    const quickPlaySlot = currentProject.value.quickPlaySlots.find(ci => ci.slot === slot);
    if (!quickPlaySlot) return null;

    // First check QuickPlay-only items
    const quickPlayItem = quickPlayItems.value.get(quickPlaySlot.itemUuid);
    if (quickPlayItem) {
      return quickPlayItem;
    }

    // Fallback to project items (for items dragged from playlist)
    const { findItemByUuid } = useProject();
    const item = findItemByUuid(quickPlaySlot.itemUuid);
    return item && item.type === 'audio' ? item as AudioItem : null;
  };

  // Update a QuickPlay-only item
  const updateQuickPlayItem = (uuid: string, item: AudioItem) => {
    if (quickPlayItems.value.has(uuid)) {
      quickPlayItems.value.set(uuid, item);
    }
  };

  // Get a QuickPlay-only item by UUID
  const getQuickPlayItem = (uuid: string): AudioItem | null => {
    return quickPlayItems.value.get(uuid) || null;
  };

  // Remove a QuickPlay-only item
  const removeQuickPlayItem = (uuid: string) => {
    quickPlayItems.value.delete(uuid);
  };

  // Clear all QuickPlay-only items
  const clearQuickPlayItems = () => {
    quickPlayItems.value.clear();
  };

  return {
    quickPlayItems,
    addQuickPlayItem,
    getQuickPlayItemAtSlot,
    updateQuickPlayItem,
    getQuickPlayItem,
    removeQuickPlayItem,
    clearQuickPlayItems
  };
};
