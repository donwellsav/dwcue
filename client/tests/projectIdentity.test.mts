import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { createProjectHydrationRetry } from '../app/utils/projectHydration';

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
      lastItems: [baseline], lastQuickPlayItems: [],
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

test('audio readiness drops a late response from the previous show', async () => {
  const source = readFileSync(new URL('../app/composables/useProject.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  async function pollLoadingProgress(');
  const end = source.indexOf('\n  }', start);
  assert.ok(start >= 0 && end > start);
  const code = ts.transpileModule(source.slice(start, end + 4), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const progress = { value: null };
  const poll = Function('audioLoadingProgress', `${code}\nreturn pollLoadingProgress;`)(progress);
  let release!: (report: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  let current = true;
  const old = poll({ fetchProjectProgress: () => pending }, () => current);
  current = false;
  release({ loading: false, failedCount: 1 });
  await old;
  assert.equal(progress.value, null);
  const report = { loading: false, failedCount: 1 };
  await poll({ fetchProjectProgress: async () => report }, () => true);
  assert.equal(progress.value, report);
});

test('an owned project header commits its server session together with the local identity', () => {
  const session = { value: 'old-session' };
  const currentProject = { value: null as any };
  const path = { value: '' };
  const repairNotice = { value: null as any };
  const saveFailed = { value: true };
  const emptyReadiness = { loading: false, failedCount: 0 };
  const audioLoadingProgress = { value: { loading: true, failedCount: 1 } };
  const apply = projectFunction('applyServerHeader', {
    currentProject, projectFilePathRef: path, serverProjectSessionId: session,
    projectEpoch: { value: 0 }, hasUnsavedChanges: { value: false }, saveFailed,
    repairNotice, audioLoadingProgress, EMPTY_AUDIO_READINESS: emptyReadiness,
    useLiveplayServer: () => ({ serverUrl: 'http://engine' }),
    projectPathFromHeader: (h: any) => h.server.projectFilePath,
    isNativeProjectPath: (p: string) => p.endsWith('.dwcue'),
    reportOpenProjectPath() {}, updateIndices() {}, _uninstallItemsWatcherFn() {},
    DEFAULT_QUICK_PLAY_SLOT_KEYS: {}, DEFAULT_THEME: {},
    _projectHydration: { begin: () => ({ finish() {} }) },
    clearLocalProjectMirror: () => { currentProject.value = null; path.value = ''; session.value = ''; },
  });
  apply({ hasOpenProject: true, name: 'New', needsRepair: true, repairIssues: ['duplicate cue'],
    server: { projectFilePath: '/new.dwcue', projectSessionId: 'new-session' } });
  assert.equal(currentProject.value.name, 'New');
  assert.equal(path.value, '/new.dwcue');
  assert.equal(session.value, 'new-session');
  assert.equal(saveFailed.value, false);
  assert.equal(audioLoadingProgress.value, emptyReadiness);
  assert.equal(repairNotice.value.session, 'new-session');
  assert.deepEqual(repairNotice.value.issues, ['duplicate cue']);
  apply({ hasOpenProject: false, server: { projectFilePath: '', projectSessionId: 'closed-session' } });
  assert.equal(currentProject.value, null);
  assert.equal(session.value, 'closed-session');
});

test('New Show opens the header from the server operation that saves before switching', async () => {
  const calls: unknown[][] = [];
  const header = { hasOpenProject: true, server: { projectFilePath: '/show/New.dwcue', projectSessionId: 'created-session' } };
  const isHydrating = { value: false };
  const projectLoad = { value: null };
  let acknowledge!: (value: typeof header) => void;
  const accepted = new Promise<typeof header>(resolve => { acknowledge = resolve; });
  const server = { connected: true,
    loadProjectDocument: async (document: { name: string }, createPath?: string) => {
      calls.push([document.name, createPath]);
      return accepted;
    },
    saveProjectTo: async () => { calls.push(['separate save']); return { ok: true }; },
    fetchProjectHeader: async () => header,
  };
  const create = projectFunction('createNewProject', {
    projectLoad, isHydrating,
    useLiveplayServer: () => server, DEFAULT_QUICK_PLAY_SLOT_KEYS: {}, DEFAULT_THEME: {}, DEFAULT_PROJECT_SETTINGS: {},
    projectPathInFolder: (folder: string, name: string) => `${folder}/${name}.dwcue`,
    applyServerHeader: (accepted: unknown) => { calls.push(['accepted', accepted]); return { finish() {} }; }, nextTick: async () => {},
    refreshItemsBaselineAfterHydrate() {}, installItemsWatcherFn() {}, recordRecentProject() {},
    projectFilePathRef: { value: '/show/New.dwcue' },
  });
  const creating = create('New', '/show');
  assert.deepEqual(calls, [['New', '/show/New.dwcue']]);
  assert.equal(projectLoad.value, 'create');
  assert.equal(isHydrating.value, false, 'the current show must still sync its edits while create waits for storage');
  acknowledge(header);
  assert.equal(await creating, true);
  assert.equal(projectLoad.value, null);
  assert.deepEqual(calls, [['New', '/show/New.dwcue'], ['accepted', header]]);
});

test('explicit session recovery uses fresh server and load identities for its chained writes', async () => {
  const calls: any[][] = [];
  const project = { name: 'Local', items: [], quickPlayItems: [] };
  const saveFailed = { value: true };
  const server = {
    fetchProjectHeader: async () => ({ server: { projectSessionId: 'fresh-server-session' } }),
    loadProjectFromPath: async (...args: any[]) => { calls.push(['load', ...args]); return { server: { projectSessionId: 'loaded-session' } }; },
    replaceProjectDocument: async (...args: any[]) => { calls.push(['replace', ...args]); return { server: { projectSessionId: 'overlay-session' } }; },
  };
  const resume = projectFunction('resumeProjectOnServer', {
    currentProject: { value: project }, _projectHydration: { wait: async () => true },
    useLiveplayServer: () => server, projectFilePathRef: { value: '/show/Local.dwcue' },
    isNativeProjectPath: () => true, useQuickPlayItems: () => ({ quickPlayItems: { value: new Map() } }),
    hasUnsavedChanges: { value: true }, saveFailed, buildDocumentSnapshot: () => ({ ...project }),
    uninstallItemsWatcherFn() {}, tryRejoinExistingProject: async () => { saveFailed.value = false; return true; },
  });
  assert.equal(await resume(), true);
  assert.equal(calls[0][2], 'fresh-server-session');
  assert.equal(calls[1][2], 'loaded-session');
  assert.equal(saveFailed.value, true);
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

test('cold Open owns the loading panel while the welcome screen probes for an existing show', async () => {
  const source = readFileSync(new URL('../app/composables/useProject.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  const tryRejoinExistingProject =');
  const end = source.indexOf('  const openProject =', start);
  assert.ok(start >= 0 && end > start);
  const code = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const projectLoad = { value: null };
  const header = { hasOpenProject: true, itemCount: 1 };
  const currentProject = { value: { quickPlayItems: [] } };
  let headerProbes = 0;
  let pages = 0;
  const deps = {
    _hydrationRequestRevision: 0, _openLoadRevision: 0, _hydrationRetry: createProjectHydrationRetry(),
    isQuickPlayWindowMode: false, isVideoOutputWindowMode: false, recoveringProject: { value: false },
    projectHydrationStatus: { value: 'ready' }, isHydrating: { value: false },
    projectLoad, currentProject, projectFilePathRef: { value: '' },
    useLiveplayServer: () => ({
      connected: true,
      fetchProjectHeader: async () => { headerProbes++; return header; },
    }),
    applyServerHeader: () => ({}), nextTick: async () => {},
    useQuickPlayItems: () => ({ clearQuickPlayItems() {}, addQuickPlayItem() {} }),
    streamItemPages: async () => { pages++; return true; },
    pollLoadingProgress() {}, recordRecentProject() {},
    _projectHydration: { current: () => null },
  };
  const { hydrateProjectFrom, tryRejoinExistingProject } = Function(...Object.keys(deps),
    `${code}; return { hydrateProjectFrom, tryRejoinExistingProject };`)(...Object.values(deps));
  let loaded!: (header: object) => void;
  const open = hydrateProjectFrom(() => new Promise(resolve => { loaded = resolve; }));
  assert.equal(projectLoad.value, 'open');
  const rejoined = await tryRejoinExistingProject();
  loaded(header);
  const opened = await open;
  assert.equal(projectLoad.value, null, 'a welcome rejoin left the loading panel visible');
  assert.equal(rejoined, false);
  assert.equal(opened, true);
  assert.equal(headerProbes, 0);
  assert.equal(pages, 1);
  assert.equal(await tryRejoinExistingProject(), true, 'a standalone welcome rejoin still works');

  const interrupted = hydrateProjectFrom(() => new Promise(resolve => { loaded = resolve; }));
  assert.equal(await tryRejoinExistingProject(header), true, 'reconnect still verifies during an Open');
  assert.equal(projectLoad.value, 'open', 'reconnect must not dismiss the in-flight Open');
  const newer = hydrateProjectFrom(async () => header);
  loaded(header);
  assert.equal(await interrupted, false);
  assert.equal(projectLoad.value, 'open', 'an older Open must not dismiss the newer panel');
  assert.equal(await newer, true);
  assert.equal(projectLoad.value, null);

  const superseded = hydrateProjectFrom(() => new Promise(resolve => { loaded = resolve; }));
  assert.equal(await tryRejoinExistingProject(header), true);
  loaded(header);
  assert.equal(await superseded, false);
  assert.equal(projectLoad.value, null, 'an Open must release its panel after reconnect verification');
});

test('reconnect retains the verified playlist through a failed page and replaces it only on success', async () => {
  const previous = { items: ['verified cue'], quickPlayItems: [] };
  const currentProject = { value: previous };
  const header = { hasOpenProject: true, itemCount: 2, server: { projectSessionId: 'new-show' } };
  let finishPages!: (loaded: boolean) => void;
  const rejoin = projectFunction('tryRejoinExistingProject', {
    currentProject, _hydrationRequestRevision: 0, projectLoad: { value: null }, _hydrationRetry: createProjectHydrationRetry(),
    isQuickPlayWindowMode: false, isVideoOutputWindowMode: false, recoveringProject: { value: false },
    projectHydrationStatus: { value: 'ready' }, isHydrating: { value: false },
    useLiveplayServer: () => ({ connected: true, showVerification: 'checking' }),
    async readProjectItemPages(_: unknown, count: number, isCurrent: () => boolean,
      receive: (items: string[]) => void, _signal: unknown, session: string) {
      assert.equal(count, 2);
      assert.equal(session, 'new-show');
      receive(['first incoming cue']);
      const accepted = await new Promise<boolean>(resolve => { finishPages = resolve; });
      if (accepted) receive(['last incoming cue']);
      return accepted && isCurrent();
    },
    applyServerHeader(_header: unknown, items: string[]) {
      currentProject.value = { items, quickPlayItems: [] };
      return {};
    },
    nextTick: async () => {},
    useQuickPlayItems: () => ({ clearQuickPlayItems() {}, addQuickPlayItem() {} }),
    async streamItemPages(_: unknown, _count: number, _load: unknown, _signal: unknown, pagesLoaded: boolean) {
      assert.equal(pagesLoaded, true, 'verification pages must be applied only once');
      return true;
    },
    pollLoadingProgress() {},
  });
  const refused = rejoin(header);
  assert.equal(currentProject.value, previous);
  finishPages(false);
  assert.equal(await refused, false);
  assert.equal(currentProject.value, previous);
  const accepted = rejoin(header);
  assert.equal(currentProject.value, previous);
  finishPages(true);
  assert.equal(await accepted, true);
  assert.deepEqual(currentProject.value.items, ['first incoming cue', 'last incoming cue']);
});

test('save failure persists through edits and pending retries until the current show is saved', async () => {
  const currentProject = { value: { name: 'Show' } };
  const saveFailed = { value: false };
  const hasUnsavedChanges = { value: false };
  const autoSaveEnabled = { value: false };
  let complete!: (result: { ok: boolean }) => void;
  const server = {
    serverUrl: 'local', projectSessionId: 'session', connected: true,
    saveProjectTo: () => new Promise(resolve => { complete = resolve; }),
  };
  const save = projectFunction('saveProject', {
    currentProject, saveFailed, hasUnsavedChanges, autoSaveEnabled, saveRevision: { value: 0 },
    useQuickPlayItems: () => ({ quickPlayItems: { value: new Map() } }),
    useLiveplayServer: () => server, projectFilePathRef: { value: '/show.dwcue' },
    projectEpoch: { value: 0 }, serverProjectSessionId: { value: 'session' },
    sessionLost: { value: false }, recoveringProject: { value: false }, repairNotice: { value: null },
    isNativeProjectPath: () => true, isCurrentSaveIdentity,
    _projectHydration: { wait: async () => true }, _syncItemsDiffFn: async () => {},
    _projectSaveQueue: createLatestWriteQueue(), buildDocumentSnapshot: () => ({ ...currentProject.value }),
  });
  const started = () => new Promise(resolve => setImmediate(resolve));

  assert.equal(await save(), true);
  assert.equal(hasUnsavedChanges.value, true);
  assert.equal(saveFailed.value, false);
  const forcedSave = save({ force: true });
  await started();
  assert.equal(await save(), true);
  complete({ ok: false });
  assert.equal(await forcedSave, false);
  assert.equal(saveFailed.value, true);

  const retry = save({ force: true });
  await started();
  assert.equal(saveFailed.value, true);
  complete({ ok: true });
  assert.equal(await retry, true);
  assert.equal(hasUnsavedChanges.value, false);
  assert.equal(saveFailed.value, false);

  const cancellation = new AbortController();
  const canceled = save({ force: true, signal: cancellation.signal });
  await started();
  cancellation.abort();
  complete({ ok: false });
  assert.equal(await canceled, false);
  assert.equal(saveFailed.value, false);

  const stale = save({ force: true });
  await started();
  currentProject.value = { name: 'Replacement' };
  complete({ ok: false });
  assert.equal(await stale, false);
  assert.equal(saveFailed.value, false);
});

test('Retry still recovers the current cue list after a replacement show is refused', async () => {
  const retry = createProjectHydrationRetry();
  const attempts: string[] = [];
  retry.set(async () => { attempts.push('current show'); return true; });
  const open = projectFunction('hydrateProjectFrom', {
    _hydrationRequestRevision: 0, _openLoadRevision: 0, _hydrationRetry: retry,
    projectHydrationStatus: { value: 'failed' },
    projectLoad: { value: null },
    useLiveplayServer: () => ({ connected: true }),
    _projectHydration: { current: () => null }, console: { error() {} },
  });
  assert.equal(await open(async () => { attempts.push('replacement'); throw new Error('Invalid show'); }), false);
  assert.equal(await retry.run(), true);
  assert.deepEqual(attempts, ['replacement', 'current show']);
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
