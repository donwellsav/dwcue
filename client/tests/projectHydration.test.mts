import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectHydration, createProjectHydrationRetry } from '../app/utils/projectHydration';

test('writers wait for all item pages before observing a complete project', async () => {
  const hydration = createProjectHydration<{ items: string[] }>();
  const project = { items: [] as string[] };
  const load = hydration.begin(project);
  let saved: string[] | null = null;
  const write = hydration.wait(project).then(ready => {
    if (ready) saved = [...project.items];
  });
  await Promise.resolve();
  assert.equal(saved, null);
  project.items.push('first page');
  await Promise.resolve();
  assert.equal(saved, null);
  project.items.push('last page');
  load.finish(true);
  await write;
  assert.deepEqual(saved, ['first page', 'last page']);
});

test('failed or closed loads never authorize a full-document write', async () => {
  const hydration = createProjectHydration<object>();
  const project = {};
  const failed = hydration.begin(project);
  const waiting = hydration.wait(project);
  failed.finish(false);
  assert.equal(await waiting, false);
  const closing = hydration.begin(project);
  const pending = hydration.wait(project);
  hydration.invalidate();
  closing.finish(true);
  assert.equal(await pending, false);
  assert.equal(await hydration.wait(project), false);
});

test('a replaced project or restarted load invalidates older waiting writers', async () => {
  const hydration = createProjectHydration<object>();
  const first = {};
  const second = {};
  const oldLoad = hydration.begin(first);
  const oldWrite = hydration.wait(first);
  const newLoad = hydration.begin(second);
  oldLoad.finish(true);
  assert.equal(await oldWrite, false);
  assert.equal(await hydration.wait(first), false);
  newLoad.finish(true);
  assert.equal(await hydration.wait(second), true);
  const staleWrite = hydration.wait(second);
  const refreshed = hydration.begin(second);
  assert.equal(await staleWrite, false);
  refreshed.finish(true);
  assert.equal(await hydration.wait(second), true);
});

test('status follows only the current identity through failure and retry', async () => {
  const snapshots: Array<{ project: object; status: string; error: string | null } | null> = [];
  const hydration = createProjectHydration<object>(snapshot => snapshots.push(snapshot ? { ...snapshot } : null));
  const first = {};
  const second = {};
  const stale = hydration.begin(first);
  const current = hydration.begin(second);
  stale.finish(false, new Error('stale A failed'));
  assert.equal(hydration.snapshot()?.project, second);
  assert.equal(hydration.snapshot()?.status, 'loading');
  current.finish(false, new Error('B page failed'));
  assert.deepEqual(hydration.snapshot(), {
    project: second, status: 'failed', error: 'B page failed',
  });
  const retry = hydration.begin(second);
  assert.equal(hydration.snapshot()?.status, 'loading');
  retry.finish(true);
  assert.deepEqual(hydration.snapshot(), { project: second, status: 'ready', error: null });
  assert.equal(await hydration.wait(second), true);
  assert.equal(snapshots.some(snapshot => snapshot?.error === 'stale A failed'), false);
});

test('page-stream retry switches from the requested file to the current server document', async () => {
  const retry = createProjectHydrationRetry();
  const calls: string[] = [];
  retry.set(async () => {
    calls.push('reload requested file');
    return true;
  });

  // The load endpoint has accepted the file and made it the server's active
  // in-memory document. From this point, a failed page stream must rejoin it.
  retry.set(async () => {
    calls.push('rehydrate current server document');
    return true;
  });

  assert.equal(await retry.run(), true);
  assert.deepEqual(calls, ['rehydrate current server document']);
});
