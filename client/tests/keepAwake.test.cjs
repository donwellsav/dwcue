const assert = require('node:assert/strict');
const { test } = require('node:test');
const { KEEP_AWAKE_TYPES, applyKeepAwake, keepAwakePlan } = require('../electron/keep-awake.js');

// A stand-in for Electron's powerSaveBlocker.
function fakeBlocker() {
  let next = 1;
  const started = new Map();
  return {
    started,
    start(type) { const id = next++; started.set(id, type); return id; },
    stop(id) { started.delete(id); },
    isStarted(id) { return started.has(id); },
    types() { return [...started.values()].sort(); },
  };
}

test('an open show keeps the computer awake; Show Mode and playback keep the screen on too', () => {
  assert.deepEqual(keepAwakePlan({ showOpen: false, showMode: false, playing: false }), { system: false, display: false });
  assert.deepEqual(keepAwakePlan({ showOpen: true, showMode: false, playing: false }), { system: true, display: false });
  assert.deepEqual(keepAwakePlan({ showOpen: true, showMode: true, playing: false }), { system: true, display: true });
  assert.deepEqual(keepAwakePlan({ showOpen: true, showMode: false, playing: true }), { system: true, display: true });
  // Audio still playing with no show open (a QuickPlay tail) is still a show.
  assert.deepEqual(keepAwakePlan({ showOpen: false, showMode: false, playing: true }), { system: true, display: true });
  // Show Mode alone, with nothing open, holds nothing.
  assert.deepEqual(keepAwakePlan({ showOpen: false, showMode: true, playing: false }), { system: false, display: false });
});

test('anything but a plain true is treated as false', () => {
  for (const state of [null, undefined, 'yes', 42, {}, { showOpen: 'true', playing: 1, showMode: {} }]) {
    assert.deepEqual(keepAwakePlan(state), { system: false, display: false });
  }
});

test('holds are started once, kept, and released when no longer wanted', () => {
  const blocker = fakeBlocker();
  const held = { system: null, display: null };
  applyKeepAwake(blocker, held, { system: true, display: false });
  assert.deepEqual(blocker.types(), [KEEP_AWAKE_TYPES.system]);
  applyKeepAwake(blocker, held, { system: true, display: false });
  assert.equal(blocker.started.size, 1, 'asking again does not stack a second hold');
  applyKeepAwake(blocker, held, { system: true, display: true });
  assert.deepEqual(blocker.types(), [KEEP_AWAKE_TYPES.system, KEEP_AWAKE_TYPES.display].sort());
  applyKeepAwake(blocker, held, { system: false, display: false });
  assert.equal(blocker.started.size, 0, 'the computer may sleep again');
  assert.deepEqual(held, { system: null, display: null });
});

test('a hold the system dropped by itself is taken again', () => {
  const blocker = fakeBlocker();
  const held = { system: null, display: null };
  applyKeepAwake(blocker, held, { system: true, display: false });
  blocker.started.clear();                       // released behind our back
  applyKeepAwake(blocker, held, { system: true, display: false });
  assert.deepEqual(blocker.types(), [KEEP_AWAKE_TYPES.system]);
  blocker.started.clear();
  applyKeepAwake(blocker, held, { system: false, display: false });   // nothing left to stop, and no error
  assert.deepEqual(held, { system: null, display: null });
});
