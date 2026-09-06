import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectOpenGuard } from '../app/utils/projectOpenGuard';

test('cancel and failed saves retain the current project without opening the target', async () => {
  const opened: string[] = [];
  let allow = false;
  const guard = createProjectOpenGuard({
    async confirmUnsavedChanges() { return allow; },
    async openProject(path) { opened.push(path); return true; },
    onOpenFailed() { assert.fail('open failure callback must not run on cancel'); },
  });
  assert.equal(await guard('/shows/b.dwcue'), false);
  assert.deepEqual(opened, []);
  allow = true;
  assert.equal(await guard('/shows/b.dwcue'), true);
  assert.deepEqual(opened, ['/shows/b.dwcue']);
});

test('duplicate and raced selections cannot switch to an uncaptured target', async () => {
  let release!: (value: boolean) => void;
  const confirmation = new Promise<boolean>(resolve => { release = resolve; });
  const opened: string[] = [];
  const guard = createProjectOpenGuard({
    confirmUnsavedChanges: () => confirmation,
    async openProject(path) { opened.push(path); return true; },
    onOpenFailed() {},
  });
  const first = guard('/shows/b.dwcue');
  const duplicate = guard('/shows/b.dwcue');
  const raced = guard('/shows/c.dwcue');
  assert.equal(first, duplicate);
  assert.equal(await raced, false);
  release(true);
  assert.equal(await first, true);
  assert.deepEqual(opened, ['/shows/b.dwcue']);
});

test('false open result is surfaced exactly once', async () => {
  const failures: string[] = [];
  const guard = createProjectOpenGuard({
    async confirmUnsavedChanges() { return true; },
    async openProject() { return false; },
    onOpenFailed(path) { failures.push(path); },
  });
  assert.equal(await guard('/shows/b.dwcue'), false);
  assert.deepEqual(failures, ['/shows/b.dwcue']);
});
