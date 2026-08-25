import { computed, watch } from 'vue';

/**
 * Show-mode One Shot safety: while armed is false, tile clicks and slot
 * hotkeys will not fire. Arming is a deliberate first press; firing any cell
 * disarms again (arm → fire → arm). Leaving show mode always disarms.
 * Stopping a playing One Shot is never gated.
 */
export const useOneShotArm = () => {
  const { uiMode } = useUiMode();
  const armed = useState('oneShotArmed', () => false);
  const showMode = computed(() => uiMode.value === 'playback');

  watch(showMode, (on) => { if (!on) armed.value = false; });

  const arm = () => { armed.value = true; };
  const disarm = () => { armed.value = false; };
  const toggle = () => { armed.value = !armed.value; };

  /** True when a fire attempt should be swallowed (show mode, not armed). */
  const fireBlocked = computed(() => showMode.value && !armed.value);

  return { armed, showMode, fireBlocked, arm, disarm, toggle };
};
