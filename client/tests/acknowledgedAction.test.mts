import assert from 'node:assert/strict';
import test from 'node:test';

import {
  oneShotFireActionKey,
  runAcknowledgedAction,
  runPendingAction,
} from '../app/utils/acknowledgedAction.ts';

test('runs the follow-up exactly once after a successful acknowledgement', async () => {
  let followUps = 0;
  const accepted = await runAcknowledgedAction(
    'success',
    async () => true,
    () => { followUps++; },
  );
  assert.equal(accepted, true);
  assert.equal(followUps, 1);
});

test('coalesces a pending action synchronously across duplicate input surfaces', async () => {
  let commands = 0;
  let followUps = 0;
  let resolveAck: (accepted: boolean) => void = () => {};
  const ack = new Promise<boolean>((resolve) => { resolveAck = resolve; });
  const key = oneShotFireActionKey('cue-1');

  const first = runAcknowledgedAction(key, async () => { commands++; return ack; }, () => { followUps++; });
  const duplicate = runAcknowledgedAction(key, async () => { commands++; return true; }, () => { followUps++; });
  await Promise.resolve();
  assert.equal(commands, 1);
  assert.equal(followUps, 0);

  resolveAck(true);
  assert.deepEqual(await Promise.all([first, duplicate]), [true, true]);
  assert.equal(followUps, 1);
});

test('releases a rejected action and preserves the follow-up for a retry', async () => {
  let followUps = 0;
  const key = oneShotFireActionKey('cue-2');
  assert.equal(await runAcknowledgedAction(key, async () => false, () => { followUps++; }), false);
  assert.equal(followUps, 0);
  assert.equal(await runAcknowledgedAction(key, async () => true, () => { followUps++; }), true);
  assert.equal(followUps, 1);
});

test('releases a thrown action and does not block separate targets', async () => {
  await assert.rejects(runPendingAction('transport:go', async () => { throw new Error('failed'); }));
  const [retried, separate] = await Promise.all([
    runPendingAction('transport:go', async () => true),
    runPendingAction('transport:play:other', async () => true),
  ]);
  assert.deepEqual([retried, separate], [true, true]);
});
