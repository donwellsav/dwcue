import { computed, watch } from 'vue';
import type { AudioItem } from '~/types/project';

/** Minimal structural shape this composable needs from a one-shot item. */
type OneShotArmable = Pick<AudioItem, 'oneShot'> | null | undefined;

/**
 * Show-mode One Shot safety, per cell: each tile carries its own persisted
 * armed flag (item.oneShot.armed) and only fires while armed. Auto-disarm
 * (item.oneShot.autoDisarm, default on) re-safes a cell after it fires; the
 * cell's settings popover can disable that per cell. Leaving show mode
 * disarms every cell. Stopping a playing One Shot is never gated.
 */
export const useOneShotArm = () => {
  const { uiMode } = useUiMode();
  const { getAllItemsFlat, saveProject } = useProject();
  const { cartOnlyItems } = useCartItems();
  const showMode = computed(() => uiMode.value === 'playback');

  const isArmed = (item: OneShotArmable) => !!item?.oneShot?.armed;
  const autoDisarms = (item: OneShotArmable) => item?.oneShot?.autoDisarm !== false;

  const setArmed = (item: OneShotArmable, on: boolean) => {
    if (!item?.oneShot) return;
    if (on) item.oneShot.armed = true;
    else delete item.oneShot.armed;
  };

  /** Per-cell fire gate: true when a fire attempt should be swallowed. */
  const fireBlocked = (item: OneShotArmable) => showMode.value && !isArmed(item);

  /** Call after a cell actually fires: re-safe it unless auto-disarm is off. */
  const afterFire = (item: OneShotArmable) => {
    if (!showMode.value || !autoDisarms(item) || !isArmed(item)) return;
    setArmed(item, false);
    void saveProject();
  };

  const disarmAll = () => {
    let changed = false;
    for (const item of [...getAllItemsFlat(), ...cartOnlyItems.value.values()]) {
      const oneShot = (item as AudioItem | undefined)?.oneShot;
      if (oneShot?.armed) {
        delete oneShot.armed;
        changed = true;
      }
    }
    if (changed) void saveProject();
  };

  watch(showMode, (on) => { if (!on) disarmAll(); });

  return { showMode, isArmed, setArmed, fireBlocked, afterFire, disarmAll };
};
