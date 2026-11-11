import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function projectFunction(name: string, dependencies: Record<string, unknown>) {
  const source = readFileSync(new URL('../app/composables/useProject.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('useProject.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let declaration: ts.VariableDeclaration | undefined;
  const find = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) declaration = node;
    ts.forEachChild(node, find);
  };
  find(ast);
  assert.ok(declaration, `${name} must exist`);
  const compiled = ts.transpileModule(`const ${declaration.getText(ast)};`, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return Function(...Object.keys(dependencies), `${compiled}; return ${name};`)(...Object.values(dependencies));
}

test('media reload invalidates only its waveform and ignores an old show session', async () => {
  const item: any = { uuid: 'media', type: 'audio', waveform: { peaks: [0.1] } };
  const project = { items: [item] }, currentProject = { value: project as any };
  const session = { value: 'current' }, progress = { value: null as any };
  const cache = new Map([['media', item.waveform], ['other', { peaks: [0.3] }]]);
  const generated: unknown[][] = [], invalidated: unknown[][] = [];
  const server = {
    fetchProjectProgress: async () => ({ ready: true }),
    invalidateWaveformCache: (...args: unknown[]) => invalidated.push(args),
    requestWaveformGeneration: async (...args: unknown[]) => { generated.push(args); },
  };
  const apply = projectFunction('applyDocPatch', {
    currentProject, serverProjectSessionId: session, audioLoadingProgress: progress,
    server: () => server, _waveformCache: cache, findItemByUuid: () => item,
    triggerWaveformUpdate() {}, acknowledgeDocPatchBaseline() {}, console,
    itemPatchIdentity: { owns: () => false },
  });
  const patch = { op: 'media_changed', project_session_id: 'current', item_uuid: 'media',
    path: '/media.wav', file_revision: 'new-file', reloaded: true };
  apply({ ...patch, project_session_id: 'old' });
  assert.equal(cache.has('media'), true);
  assert.equal(generated.length, 0);
  apply({ ...patch, reloaded: false });
  assert.ok(item.waveform, 'the current pinned playback keeps its analysis');
  assert.equal(generated.length, 0);
  apply(patch);
  await Promise.resolve();
  assert.equal(item.waveform, undefined);
  assert.equal(cache.has('media'), false);
  assert.equal(cache.has('other'), true);
  assert.deepEqual(generated, [['/media.wav', 'media', true, 'new-file']]);
  assert.equal(invalidated.length, 1);
  assert.deepEqual(progress.value, { ready: true });
});

test('waveform delivery preserves the full-file timing sentinel and explicit trims', () => {
  for (const outPoint of [0, 0.8]) {
    const item: any = { uuid: 'media', type: 'audio', volume: 0.3, inPoint: 0, outPoint, duration: 0 };
    const baseline = { ...item }, cache = new Map();
    const apply = projectFunction('applyDocPatch', {
      currentProject: { value: { items: [item] } }, itemPatchIdentity: { owns: () => false },
      serverProjectSessionId: { value: 'current' }, findItemByUuid: () => item,
      findItemAndParent: () => ({ item: baseline }), _waveformCache: cache, markRaw: (x: any) => x,
      lastItems: [baseline], lastCartOnly: [],
      cacheWaveform: (uuid: string, waveform: any) => cache.set(uuid, waveform), triggerWaveformUpdate() {},
      buildWaveformFromChannels: () => ({ peaks: [0.1], duration: 1.001 }),
      acknowledgeDocPatchBaseline() {},
    });
    apply({ op: 'waveform_ready', item_uuid: 'media', duration_ms: 1001, channels: [] });
    assert.equal(item.outPoint, outPoint, 'analysis must not turn rounded duration into an authored trim');
    assert.equal(baseline.outPoint, outPoint);
    assert.equal(item.volume, 0.3);
    assert.equal(item.inPoint, 0);
  }
});

test('an owned project header commits its server session together with the local identity', () => {
  const session = { value: 'old-session' };
  const currentProject = { value: null as any };
  const path = { value: '' };
  const apply = projectFunction('applyServerHeader', {
    currentProject, projectFilePathRef: path, serverProjectSessionId: session,
    projectEpoch: { value: 0 }, hasUnsavedChanges: { value: false },
    projectPathFromHeader: (h: any) => h.server.projectFilePath,
    isNativeProjectPath: (p: string) => p.endsWith('.dwcue'),
    reportOpenProjectPath() {}, updateIndices() {}, _uninstallItemsWatcherFn() {},
    DEFAULT_CART_SLOT_KEYS: {}, DEFAULT_THEME: {},
    _projectHydration: { begin: () => ({ finish() {} }) },
    clearLocalProjectMirror: () => { currentProject.value = null; path.value = ''; session.value = ''; },
  });
  apply({ hasOpenProject: true, name: 'New', server: { projectFilePath: '/new.dwcue', projectSessionId: 'new-session' } });
  assert.equal(currentProject.value.name, 'New');
  assert.equal(path.value, '/new.dwcue');
  assert.equal(session.value, 'new-session');
  apply({ hasOpenProject: false, server: { projectFilePath: '', projectSessionId: 'closed-session' } });
  assert.equal(currentProject.value, null);
  assert.equal(session.value, 'closed-session');
});

test('New Show opens the header from the server operation that saves before switching', async () => {
  const calls: unknown[][] = [];
  const header = { hasOpenProject: true, server: { projectFilePath: '/show/New.dwcue', projectSessionId: 'created-session' } };
  const server = { connected: true,
    loadProjectDocument: async (document: { name: string }, createPath?: string) => {
      calls.push([document.name, createPath]);
      return header;
    },
    saveProjectTo: async () => { calls.push(['separate save']); return { ok: true }; },
    fetchProjectHeader: async () => header,
  };
  const create = projectFunction('createNewProject', {
    isLoading: { value: false }, loadingMessage: { value: '' }, isHydrating: { value: false },
    useLiveplayServer: () => server, DEFAULT_CART_SLOT_KEYS: {}, DEFAULT_THEME: {}, DEFAULT_PROJECT_SETTINGS: {},
    projectPathInFolder: (folder: string, name: string) => `${folder}/${name}.dwcue`,
    applyServerHeader: (accepted: unknown) => { calls.push(['accepted', accepted]); return { finish() {} }; }, nextTick: async () => {},
    refreshItemsBaselineAfterHydrate() {}, installItemsWatcherFn() {}, recordRecentProject() {},
    projectFilePathRef: { value: '/show/New.dwcue' },
  });
  assert.equal(await create('New', '/show'), true);
  assert.deepEqual(calls, [['New', '/show/New.dwcue'], ['accepted', header]]);
});

test('explicit session recovery uses fresh server and load identities for its chained writes', async () => {
  const calls: any[][] = [];
  const project = { name: 'Local', items: [], cartOnlyItems: [] };
  const server = {
    fetchProjectHeader: async () => ({ server: { projectSessionId: 'fresh-server-session' } }),
    loadProjectFromPath: async (...args: any[]) => { calls.push(['load', ...args]); return { server: { projectSessionId: 'loaded-session' } }; },
    replaceProjectDocument: async (...args: any[]) => { calls.push(['replace', ...args]); return { server: { projectSessionId: 'overlay-session' } }; },
  };
  const resume = projectFunction('resumeProjectOnServer', {
    currentProject: { value: project }, _projectHydration: { wait: async () => true },
    useLiveplayServer: () => server, projectFilePathRef: { value: '/show/Local.dwcue' },
    isNativeProjectPath: () => true, useCartItems: () => ({ cartOnlyItems: { value: new Map() } }),
    hasUnsavedChanges: { value: true }, buildDocumentSnapshot: () => ({ ...project }),
    uninstallItemsWatcherFn() {}, tryRejoinExistingProject: async () => true,
  });
  assert.equal(await resume(), true);
  assert.equal(calls[0][2], 'fresh-server-session');
  assert.equal(calls[1][2], 'loaded-session');
});

import {
  isCurrentSaveIdentity,
  isSameProjectIdentity,
  projectPathFromHeader,
} from '../app/utils/projectIdentity.ts';
import { createLatestWriteQueue } from '../app/utils/latestWriteQueue.ts';

test('closed and pathless headers clear any previous project path', () => {
  assert.equal(projectPathFromHeader({
    hasOpenProject: false,
    server: { projectFilePath: '/shows/old.dwcue' },
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
    server: { projectFilePath: '/shows/show.dwcue' },
  }, current, '/shows/show.dwcue'), true);
  assert.equal(isSameProjectIdentity({
    hasOpenProject: true,
    ...current,
    server: { projectFilePath: '/shows/new.dwcue' },
  }, current, '/shows/show.dwcue'), false);
  assert.equal(isSameProjectIdentity({
    hasOpenProject: true,
    name: 'Show',
    folderPath: '/shows',
    createdAt: 'created',
    server: { projectFilePath: '' },
  }, current, '/shows/show.dwcue'), false);
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
  assert.equal(isCurrentSaveIdentity(captured, '/a.dwcue', 4, captured, '/a.dwcue', 4), true);
  assert.equal(isCurrentSaveIdentity(captured, '/a.dwcue', 4, { name: 'A' }, '/a.dwcue', 4), false);
  assert.equal(isCurrentSaveIdentity(captured, '/a.dwcue', 4, captured, '/b.dwcue', 4), false);
  assert.equal(isCurrentSaveIdentity(captured, '/a.dwcue', 4, captured, '/a.dwcue', 5), false);
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

test('closing keeps the old server session after clearing the local mirror and cannot clear a replacement', async () => {
  const currentProject = { value: { name: 'old' } as any };
  const session = { value: 'old-session' };
  let finish!: () => void;
  const response = new Promise<void>(resolve => { finish = resolve; });
  const requests: unknown[] = [];
  const close = projectFunction('closeProject', {
    serverProjectSessionId: session,
    clearLocalProjectMirror: () => { currentProject.value = null; session.value = ''; },
    useLiveplayServer: () => ({ connected: true, closeProjectOnServer: (expected: string) => { requests.push(expected); return response; } }),
    console,
  });
  const pending = close();
  assert.equal(currentProject.value, null);
  assert.deepEqual(requests, ['old-session'], 'close request must carry the session that the operator closed');
  currentProject.value = { name: 'new' }; session.value = 'new-session';
  finish(); await pending;
  assert.equal(currentProject.value.name, 'new');
  assert.equal(session.value, 'new-session');
});

test('only the first unsaved decision can authorize an action, including while Save is pending', async () => {
  const source = readFileSync(new URL('../app/composables/useProject.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  const confirmUnsavedChanges =');
  const end = source.indexOf('  // Drag-batch helpers', start);
  assert.ok(start >= 0 && end > start);
  const compiled = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const currentProject = { value: { name: 'Running show' } };
  const hasUnsavedChanges = { value: true };
  const unsavedDialogVisible = { value: false };
  const unsavedDialogReason = { value: 'project' };
  const unsavedDialogBlocked = { value: false };
  let finishSave!: (saved: boolean) => void;
  const saved = new Promise<boolean>(resolve => { finishSave = resolve; });
  let saveProject = async (opts: { force: boolean }) => {
    assert.equal(opts.force, true);
    return saved;
  };
  const state = { currentProject, hasUnsavedChanges, unsavedDialogVisible, unsavedDialogReason,
    unsavedDialogBlocked, _unsavedPromiseResolve: null, saveProject: (opts: { force: boolean }) => saveProject(opts),
    console: { warn() {}, error() {} } };
  const prompt = Function(...Object.keys(state), `${compiled}
    return { confirmUnsavedChanges, unsavedSave, unsavedDiscard, unsavedCancel };`)(...Object.values(state));
  const resultNow = (promise: Promise<boolean>) => Promise.race([
    promise, new Promise(resolve => setImmediate(() => resolve('pending'))),
  ]);

  const first = prompt.confirmUnsavedChanges('project');
  assert.equal(await resultNow(prompt.confirmUnsavedChanges('quit')), false);
  assert.equal(unsavedDialogReason.value, 'project');
  assert.equal(unsavedDialogVisible.value, true);
  assert.equal(unsavedDialogBlocked.value, true);
  const writing = prompt.unsavedSave();
  hasUnsavedChanges.value = false;
  assert.equal(await resultNow(prompt.confirmUnsavedChanges()), false);
  prompt.unsavedCancel();
  assert.equal(await resultNow(first), 'pending');
  finishSave(true);
  await writing;
  assert.equal(await first, true);
  assert.equal(unsavedDialogBlocked.value, false);

  hasUnsavedChanges.value = true;
  saveProject = async () => { throw new Error('Save failed'); };
  const failed = prompt.confirmUnsavedChanges('quit');
  await prompt.unsavedSave();
  assert.equal(await failed, false);

  const stale = prompt.confirmUnsavedChanges('project');
  currentProject.value = { name: 'Different show' };
  prompt.unsavedDiscard();
  assert.equal(await stale, false);
  const retried = prompt.confirmUnsavedChanges('quit');
  assert.equal(unsavedDialogReason.value, 'quit');
  prompt.unsavedCancel();
  assert.equal(await retried, false);
});
