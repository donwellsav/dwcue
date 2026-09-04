import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isCurrentSaveIdentity,
  isSameProjectIdentity,
  projectPathFromHeader,
} from '../app/utils/projectIdentity.ts';
import { createLatestWriteQueue } from '../app/utils/latestWriteQueue.ts';

test('closed and pathless headers clear any previous project path', () => {
  assert.equal(projectPathFromHeader({
    hasOpenProject: false,
    server: { projectFilePath: '/shows/old.liveplay' },
  }), '');
  assert.equal(projectPathFromHeader({
    hasOpenProject: true,
    server: { projectFilePath: '' },
  }), '');
});

test('project identity uses the authoritative path when either side has one', () => {
  const current = { name: 'Show', folderPath: '/shows', createdAt: 'created' };
  assert.equal(isSameProjectIdentity({
    hasOpenProject: true,
    name: 'Renamed remotely',
    folderPath: '/other-metadata',
    createdAt: 'other-created',
    server: { projectFilePath: '/shows/show.liveplay' },
  }, current, '/shows/show.liveplay'), true);
  assert.equal(isSameProjectIdentity({
    hasOpenProject: true,
    ...current,
    server: { projectFilePath: '/shows/new.liveplay' },
  }, current, '/shows/show.liveplay'), false);
  assert.equal(isSameProjectIdentity({
    hasOpenProject: true,
    name: 'Show',
    folderPath: '/shows',
    createdAt: 'created',
    server: { projectFilePath: '' },
  }, current, '/shows/show.liveplay'), false);
  assert.equal(isSameProjectIdentity({
    hasOpenProject: false,
    name: 'Show',
    folderPath: '/shows',
    createdAt: 'created',
  }, current, ''), false);
});

test('pathless open projects fall back to stable document identity', () => {
  const current = { name: 'Remote', folderPath: '/srv/shows', createdAt: 'created' };
  assert.equal(isSameProjectIdentity({
    hasOpenProject: true,
    ...current,
    server: { projectFilePath: '' },
  }, current, ''), true);
});

test('late save completion cannot update a replacement project', () => {
  const captured = { name: 'A' };
  assert.equal(isCurrentSaveIdentity(captured, '/a.liveplay', 4, captured, '/a.liveplay', 4), true);
  assert.equal(isCurrentSaveIdentity(captured, '/a.liveplay', 4, { name: 'A' }, '/a.liveplay', 4), false);
  assert.equal(isCurrentSaveIdentity(captured, '/a.liveplay', 4, captured, '/b.liveplay', 4), false);
  assert.equal(isCurrentSaveIdentity(captured, '/a.liveplay', 4, captured, '/a.liveplay', 5), false);
});


test('serializes active saves and coalesces pending work to the latest snapshot', async () => {
  const queue = createLatestWriteQueue<{ revision: number; document: string }>();
  const writes: string[] = [];
  let releaseFirst: (ok: boolean) => void = () => {};
  let releaseLatest: (ok: boolean) => void = () => {};
  let notifyLatestStarted: () => void = () => {};
  const firstAck = new Promise<boolean>((resolve) => { releaseFirst = resolve; });
  const latestAck = new Promise<boolean>((resolve) => { releaseLatest = resolve; });
  const latestStarted = new Promise<void>((resolve) => { notifyLatestStarted = resolve; });

  const first = queue.enqueue({ revision: 1, document: 'A' }, async (request) => {
    writes.push(request.document);
    return firstAck;
  });
  const superseded = queue.enqueue(
    { revision: 2, document: 'B' },
    async (request) => { writes.push(request.document); return true; },
  );
  const latest = queue.enqueue({ revision: 3, document: 'C' }, async (request) => {
    writes.push(request.document);
    notifyLatestStarted();
    return latestAck;
  });

  let firstSettled = false;
  void first.then(() => { firstSettled = true; });
  assert.deepEqual(writes, ['A']);
  releaseFirst(true);
  await latestStarted;
  assert.deepEqual(writes, ['A', 'C']);
  assert.equal(firstSettled, false);

  releaseLatest(true);
  const results = await Promise.all([first, superseded, latest]);
  assert.deepEqual(results.map(result => result.request.revision), [3, 3, 3]);
  assert.deepEqual(results.map(result => result.ok), [true, true, true]);
});

test('an edit revision created while a save is pending stays dirty', async () => {
  const queue = createLatestWriteQueue<{ revision: number }>();
  let revision = 1;
  let dirty = true;
  let releaseSave: (ok: boolean) => void = () => {};
  const acknowledgement = new Promise<boolean>((resolve) => { releaseSave = resolve; });
  const pending = queue.enqueue({ revision }, async () => acknowledgement);

  revision++; // A new edit with autosave disabled: no second network write.
  dirty = true;
  releaseSave(true);
  const result = await pending;
  if (result.request.revision === revision) dirty = !result.ok;
  assert.equal(dirty, true);
});