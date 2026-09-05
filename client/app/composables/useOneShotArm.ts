import { computed, watch } from 'vue';
import type { AudioItem } from '~/types/project';

/** Minimal structural shape this composable needs from a one-shot item. */
type OneShotArmable = Pick<AudioItem, 'oneShot'> | null | undefined;

/**
 * Mode-aware arm policy shared by tile, keyboard, and MIDI trigger paths.
 * Edit mode is deliberately arm-free: it never reports, sets, gates, or
 * auto-clears an arm. The persisted flag is exclusively Show Mode state.
 */
export const createOneShotArmPolicy = (isShowMode: () => boolean) => {
  const isArmed = (item: OneShotArmable) => isShowMode() && !!item?.oneShot?.armed;
  const autoDisarms = (item: OneShotArmable) => item?.oneShot?.autoDisarm !== false;

  const setArmed = (item: OneShotArmable, on: boolean): boolean => {
    if (!isShowMode() || !item?.oneShot || !!item.oneShot.armed === on) return false;
    if (on) item.oneShot.armed = true;
    else delete item.oneShot.armed;
    return true;
  };

  const fireBlocked = (item: OneShotArmable) => isShowMode() && !isArmed(item);

  const afterFire = (item: OneShotArmable): boolean => {
    if (!isShowMode() || !autoDisarms(item) || !isArmed(item)) return false;
    return setArmed(item, false);
  };

  return { isArmed, setArmed, fireBlocked, afterFire };
};

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

  const armPolicy = createOneShotArmPolicy(() => showMode.value);

  /** Call after a cell actually fires: re-safe it unless auto-disarm is off. */
  const afterFire = (item: OneShotArmable) => {
    if (armPolicy.afterFire(item)) void saveProject();
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

  return { showMode, ...armPolicy, afterFire, disarmAll };
};
