'use strict';

// Which kinds of sleep to hold off, from what the operator window reports.
//
// A show that is open must not lose its engine to system sleep, and anything
// that is playing must keep both the computer and its screen awake. In Show
// Mode the screen stays on even between cues: the operator is waiting on it.
// With no show open and nothing playing, the computer may sleep as usual.
function keepAwakePlan(state) {
  const showOpen = state?.showOpen === true;
  const showMode = state?.showMode === true;
  const playing = state?.playing === true;
  return {
    system: showOpen || playing,
    display: (showOpen && showMode) || playing,
  };
}

// Electron's names for the two holds.
const KEEP_AWAKE_TYPES = Object.freeze({
  system: 'prevent-app-suspension',
  display: 'prevent-display-sleep',
});

/**
 * Start or stop the holds so they match `plan`. `blocker` is Electron's
 * powerSaveBlocker; `held` remembers the ids between calls.
 */
function applyKeepAwake(blocker, held, plan) {
  for (const kind of Object.keys(KEEP_AWAKE_TYPES)) {
    const id = held[kind];
    const active = id !== null && id !== undefined && blocker.isStarted(id);
    if (plan[kind] && !active) {
      held[kind] = blocker.start(KEEP_AWAKE_TYPES[kind]);
    } else if (!plan[kind] && id !== null && id !== undefined) {
      try { if (active) blocker.stop(id); } catch { /* already released */ }
      held[kind] = null;
    }
  }
  return held;
}

module.exports = { KEEP_AWAKE_TYPES, applyKeepAwake, keepAwakePlan };
