import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runExclusivePendingAction,
  runPendingAction,
} from '../app/utils/acknowledgedAction.ts';

test('coalesces a cue start in flight and allows a deliberate retry', async () => {
  let commands = 0;
  let resolveAck: (accepted: boolean) => void = () => {};
  const ack = new Promise<boolean>(resolve => { resolveAck = resolve; });
  const key = 'transport:play:cue-1';
  const first = runPendingAction(key, async () => { commands++; return ack; });
  const duplicate = runPendingAction(key, async () => { commands++; return true; });
  await Promise.resolve();
  assert.equal(commands, 1);
  resolveAck(false);
  assert.deepEqual(await Promise.all([first, duplicate]), [false, false]);
  assert.equal(await runPendingAction(key, async () => { commands++; return true; }), true);
  assert.equal(commands, 2);
});

test('releases a thrown action and does not block separate targets', async () => {
  await assert.rejects(runPendingAction('transport:go', async () => { throw new Error('failed'); }));
  const [retried, separate] = await Promise.all([
    runPendingAction('transport:go', async () => true),
    runPendingAction('transport:play:other', async () => true),
  ]);
  assert.deepEqual([retried, separate], [true, true]);
});

test('exclusive actions coalesce identical intents and reject overlapping distinct intents', async () => {
  let commands = 0;
  let release: (accepted: boolean) => void = () => {};
  const acknowledgement = new Promise<boolean>((resolve) => { release = resolve; });

  const first = runExclusivePendingAction('set-next', 'cue-1', async () => {
    commands++;
    return acknowledgement;
  });
  const duplicate = runExclusivePendingAction('set-next', 'cue-1', async () => {
    commands++;
    return false;
  });
  const conflicting = runExclusivePendingAction('set-next', 'cue-2', async () => {
    commands++;
    return true;
  });

  await Promise.resolve();
  assert.equal(first, duplicate);
  assert.equal(await conflicting, false);
  assert.equal(commands, 1);

  release(true);
  assert.deepEqual(await Promise.all([first, duplicate]), [true, true]);
  assert.equal(await runExclusivePendingAction('set-next', 'cue-2', async () => {
    commands++;
    return true;
  }), true);
  assert.equal(commands, 2);
});
