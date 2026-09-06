'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const {
  normalizeShortcutKey,
  shouldForwardVideoOutputShortcut,
  toRendererShortcut,
} = require('../electron/video-output-shortcuts');
const { buildVideoOutputContextTemplate } = require('../electron/video-output-context-menu');
const { createOneShotMutationBroker } = require('../electron/one-shot-mutation-broker');
const { createAppLifecycleActions, createWillQuitHandler } = require('../electron/terminal-action');
const mainSource = readFileSync(require.resolve('../electron/main.js'), 'utf8');
const preloadSource = readFileSync(require.resolve('../electron/preload.js'), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function productionFunctionSource(name) {
  const start = mainSource.indexOf('function '+name+'(');
  assert.notEqual(start, -1, 'missing '+name+' in Electron main process');
  const bodyStart = mainSource.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < mainSource.length; index++) {
    if (mainSource[index] === '{') depth++;
    if (mainSource[index] !== '}') continue;
    depth--;
    if (depth === 0) return mainSource.slice(start, index + 1);
  }
  throw new Error('unterminated '+name+' in Electron main process');
}

function createVideoPlaybackErrorHarness(testCardPlayback = { session: null }) {
  const handlerStart = mainSource.indexOf(
    "ipcMain.handle('video-output:report-playback-error'");
  const handlerEnd = mainSource.indexOf(
    "ipcMain.handle('video-output:list-displays'", handlerStart);
  assert.notEqual(handlerStart, -1);
  assert.notEqual(handlerEnd, -1);

  const handlers = new Map();
  const broadcasts = [];
  const context = {
    URL,
    testCardPlayback,
    videoOutputTestCardConnection: null,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    broadcastVideoOutputStatus: () => {
      const status = { playbackError: context.getPlaybackError() };
      broadcasts.push(status);
      return status;
    },
  };
  vm.runInNewContext([
    'let videoOutputWindow = null;',
    'let videoOutputPlaybackError = null;',
    productionFunctionSource('requireIpcString'),
    productionFunctionSource('requireVideoOutputIpc'),
    productionFunctionSource('sanitizeVideoPlaybackErrorMessage'),
    productionFunctionSource('normalizeVideoPlaybackError'),
    mainSource.slice(handlerStart, handlerEnd),
    'globalThis.setCurrentOutputSender = (sender) => { videoOutputWindow = { isDestroyed: () => false, webContents: sender }; };',
    'globalThis.getPlaybackError = () => videoOutputPlaybackError;',
  ].join('\n'), context);
  return {
    broadcasts,
    getPlaybackError: context.getPlaybackError,
    report: handlers.get('video-output:report-playback-error'),
    setCurrentOutputSender: context.setCurrentOutputSender,
  };
}

const keyDown = (key, overrides = {}) => ({
  type: 'keyDown',
  key,
  code: '',
  control: false,
  shift: false,
  alt: false,
  meta: false,
  isAutoRepeat: false,
  ...overrides,
});

test('forwards configurable app shortcuts from the Windows video output', () => {
  assert.equal(shouldForwardVideoOutputShortcut(keyDown('p'), 'win32'), true);
  assert.equal(shouldForwardVideoOutputShortcut(keyDown('Space'), 'win32'), true);
  assert.equal(shouldForwardVideoOutputShortcut(keyDown('c', { control: true }), 'win32'), true);
  assert.equal(shouldForwardVideoOutputShortcut(keyDown('Escape'), 'win32'), true);
});

test('preserves Windows and Electron-native escape hatches', () => {
  assert.equal(shouldForwardVideoOutputShortcut(keyDown('F4', { alt: true }), 'win32'), false);
  assert.equal(shouldForwardVideoOutputShortcut(keyDown('d', { meta: true }), 'win32'), false);
  assert.equal(shouldForwardVideoOutputShortcut(keyDown('s', { control: true }), 'win32'), false);
  assert.equal(shouldForwardVideoOutputShortcut(keyDown('F11'), 'win32'), false);
  assert.equal(shouldForwardVideoOutputShortcut({ type: 'keyUp', key: 'p' }, 'win32'), false);
});

test('normalizes Electron key aliases and serializes renderer modifiers', () => {
  assert.equal(normalizeShortcutKey(keyDown('Spacebar')), ' ');
  assert.equal(normalizeShortcutKey(keyDown('Esc')), 'Escape');
  assert.equal(normalizeShortcutKey(keyDown('Up')), 'ArrowUp');
  assert.deepEqual(toRendererShortcut(keyDown('P', {
    code: 'KeyP',
    control: true,
    shift: true,
    isAutoRepeat: true,
  })), {
    key: 'P',
    code: 'KeyP',
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    repeat: true,
  });
});

test('video output context menu exposes recovery and exit actions', () => {
  const calls = [];
  const template = buildVideoOutputContextTemplate({
    fullscreen: true,
    testCard: false,
    labels: {
      enterFullscreen: 'Enter Full Screen',
      exitFullscreen: 'Exit Full Screen',
      showTestCard: 'Show Test Card',
      exitOutput: 'Exit Video Output',
    },
    onToggleFullscreen: () => calls.push('fullscreen'),
    onToggleTestCard: (visible) => calls.push(`test-card:${visible}`),
    onExit: () => calls.push('exit'),
  });

  assert.equal(template[0].label, 'Exit Full Screen');
  assert.deepEqual(template[1], {
    label: 'Show Test Card',
    type: 'checkbox',
    checked: false,
    click: template[1].click,
  });
  assert.equal(template[3].label, 'Exit Video Output');

  template[0].click();
  template[1].click({ checked: true });
  template[3].click();
  assert.deepEqual(calls, ['fullscreen', 'test-card:true', 'exit']);
});
test('accepts playback errors only from the current output and propagates safe status', async () => {
  const harness = createVideoPlaybackErrorHarness();
  const firstOutput = {};
  const replacementOutput = {};
  harness.setCurrentOutputSender(firstOutput);

  const status = await harness.report({ sender: firstOutput }, {
    itemUuid: 'video-1',
    message: 'Decoder rejected http://127.0.0.1:4480/api/media?item_uuid=video-1&access_token=secret',
  });
  assert.equal(status.playbackError.itemUuid, 'video-1');
  assert.equal(status.playbackError.message,
    'Decoder rejected http://127.0.0.1:4480/api/media');
  assert.equal(status.playbackError.message.includes('secret'), false);
  assert.equal(harness.broadcasts.length, 1);
  assert.equal(harness.broadcasts[0].playbackError.message, status.playbackError.message);

  await assert.rejects(
    () => harness.report({ sender: {} }, null),
    /sender is not the video output window/,
  );
  assert.equal(harness.getPlaybackError().itemUuid, 'video-1');

  harness.setCurrentOutputSender(replacementOutput);
  await assert.rejects(
    () => harness.report({ sender: firstOutput }, null),
    /sender is not the video output window/,
  );
  assert.equal(harness.getPlaybackError().itemUuid, 'video-1');

  const cleared = await harness.report({ sender: replacementOutput }, null);
  assert.equal(cleared.playbackError, null);
  assert.equal(harness.getPlaybackError(), null);
});


test('an AV Sync decode error awaits its native tone cleanup before returning status', async () => {
  const cleanup = deferred();
  const entered = deferred();
  const failures = [];
  const harness = createVideoPlaybackErrorHarness({
    session: { cue: { id: 'diagnostic' } },
    async fail(message) { entered.resolve(); await cleanup.promise; failures.push(message); },
  });
  const sender = {};
  harness.setCurrentOutputSender(sender);
  const reported = harness.report({ sender }, { itemUuid: 'diagnostic', message: 'Video could not decode' });
  await entered.promise;
  assert.equal(harness.broadcasts.length, 0);
  cleanup.resolve();
  await reported;
  assert.deepEqual(failures, ['Video could not decode']);
  assert.equal(harness.broadcasts.length, 1);
});


test('ordinary exit and relaunch preserve the detached server while confirmed stop remains explicit', async () => {
  const calls = [];
  let cleanupFails = false;
  let serverStops = true;
  const actions = createAppLifecycleActions({
    prepare: async () => {
      calls.push('prepare');
      if (cleanupFails) throw new Error('owned cue remains');
    },
    relaunch: () => calls.push('relaunch'),
    exit: code => calls.push(`exit:${code}`),
    quit: () => calls.push('quit'),
    stopServer: async () => { calls.push('server:stop'); return serverStops; },
    installUpdate: async options => { calls.push(`install:${options.runAfterInstall}`); return true; },
    confirmQuit: () => calls.push('confirmed'),
  });

  await actions.exit();
  assert.deepEqual(calls, ['prepare', 'exit:0']);
  assert.equal(calls.includes('server:stop'), false);

  calls.length = 0;
  await actions.relaunch();
  assert.deepEqual(calls, ['prepare', 'relaunch', 'exit:0']);
  assert.equal(calls.includes('server:stop'), false);

  calls.length = 0;
  await actions.confirm({ stopServer: true });
  assert.deepEqual(calls, ['prepare', 'server:stop', 'confirmed', 'quit']);

  calls.length = 0;
  assert.equal(await actions.confirm({ installUpdate: true, runAfterInstall: false }), true);
  assert.deepEqual(calls, ['install:false']);

  calls.length = 0;
  cleanupFails = true;
  await assert.rejects(() => actions.exit(), /owned cue remains/);
  assert.deepEqual(calls, ['prepare']);

  calls.length = 0;
  cleanupFails = false;
  serverStops = false;
  await assert.rejects(() => actions.confirm({ stopServer: true }), /could not be stopped/);
  assert.deepEqual(calls, ['prepare', 'server:stop']);
});

test('will-quit restores a usable window on cleanup failure and permits retry', async () => {
  let shouldFail = true;
  const calls = [];
  const handler = createWillQuitHandler({
    prepare: async () => {
      calls.push('prepare');
      if (shouldFail) throw new Error('network down');
    },
    exit: () => calls.push('exit'),
    recover: () => calls.push('recover'),
    onFailure: error => calls.push(`failure:${error.message}`),
  });
  const event = { preventDefault: () => calls.push('veto') };
  handler(event);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ['veto', 'prepare', 'failure:network down', 'recover']);

  shouldFail = false;
  handler(event);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls.slice(-3), ['veto', 'prepare', 'exit']);
});

function mutationContents() {
  const contents = new EventEmitter();
  contents.destroyed = false;
  contents.sent = [];
  contents.isDestroyed = () => contents.destroyed;
  contents.send = (channel, payload) => contents.sent.push({ channel, payload });
  return contents;
}

const mutationIdentity = {
  projectPath: '/shows/evening.dwcue',
  projectEpoch: 4,
  ownerSessionId: 'owner-session',
};
const mutationRequest = {
  requestId: 'request-1',
  identity: mutationIdentity,
  kind: 'set-armed',
  itemUuid: 'item-1',
  payload: { armed: true },
};

test('preload exposes only the typed mutation broker and separate project identity', async () => {
  const sends = [];
  const invokes = [];
  const listeners = new Map();
  let api;
  const ipcRenderer = {
    send: (...args) => sends.push(args),
    invoke: (...args) => { invokes.push(args); return Promise.resolve({ ok: true }); },
    on: (channel, listener) => listeners.set(channel, listener),
    removeListener: (channel, listener) => {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
    removeAllListeners: channel => listeners.delete(channel),
  };
  vm.runInNewContext(preloadSource, {
    console,
    require: name => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed; } },
        ipcRenderer,
        webUtils: null,
      };
    },
  });
  assert.equal(api.ipcRenderer, undefined);
  api.syncProjectData({ name: 'Show' }, mutationIdentity);
  assert.deepEqual(sends[0], ['sync-project-data', { name: 'Show' }, mutationIdentity]);

  const requested = api.requestOneShotMutation(mutationRequest);
  assert.deepEqual(invokes[0], ['one-shot-mutation:request', mutationRequest]);
  assert.deepEqual(await requested, { ok: true });

  let delivered;
  const unsubscribe = api.onOneShotMutationRequest(request => { delivered = request; });
  listeners.get('one-shot-mutation-request')({}, mutationRequest);
  assert.equal(delivered, mutationRequest);
  unsubscribe();
  assert.equal(listeners.has('one-shot-mutation-request'), false);

  const result = { requestId: 'request-1', identity: mutationIdentity, accepted: true, persisted: true };
  api.completeOneShotMutation(result);
  assert.deepEqual(sends.at(-1), ['one-shot-mutation:complete', result]);
});

test('detached One Shots mutations correlate a primary persisted result', async () => {
  const cart = mutationContents();
  const primary = mutationContents();
  const broker = createOneShotMutationBroker({
    getCartWebContents: () => cart,
    getPrimaryWebContents: () => primary,
    getCurrentIdentity: () => mutationIdentity,
  });
  const pending = broker.request(cart, mutationRequest);
  assert.deepEqual(primary.sent, [{ channel: 'one-shot-mutation-request', payload: mutationRequest }]);
  const result = { requestId: 'request-1', identity: mutationIdentity, accepted: true, persisted: true };
  assert.equal(broker.complete(primary, result), true);
  assert.deepEqual(await pending, result);
});

test('mutation broker rejects invalid senders, kinds, stale results, and duplicate correlations', async () => {
  const cart = mutationContents();
  const primary = mutationContents();
  let fireTimeout;
  const broker = createOneShotMutationBroker({
    getCartWebContents: () => cart,
    getPrimaryWebContents: () => primary,
    getCurrentIdentity: () => mutationIdentity,
    setTimer: callback => { fireTimeout = callback; return 1; },
    clearTimer() {},
  });
  assert.throws(() => broker.request({}, mutationRequest), /not the detached One Shots window/);
  assert.throws(() => broker.request(cart, { ...mutationRequest, kind: 'arbitrary-patch' }), /kind is invalid/);
  assert.throws(() => broker.request(cart, {
    ...mutationRequest,
    requestId: 'oversized',
    payload: { fields: { displayName: 'x'.repeat(300 * 1024) } },
  }), /too large/);
  const pending = broker.request(cart, mutationRequest);
  assert.throws(() => broker.request(cart, mutationRequest), /Duplicate/);
  assert.throws(() => broker.complete({}, {
    requestId: 'request-1', identity: mutationIdentity, accepted: true, persisted: true,
  }), /not the primary project owner/);
  assert.throws(() => broker.complete(primary, {
    requestId: 'request-1',
    identity: { ...mutationIdentity, projectEpoch: 5 },
    accepted: true,
    persisted: true,
  }), /project ownership changed/);
  fireTimeout();
  assert.equal((await pending).persisted, false);
});

test('mutation broker fails closed when the owner is absent, reloads, or times out', async () => {
  const cart = mutationContents();
  const primary = mutationContents();
  let owner = null;
  let fireTimeout;
  const broker = createOneShotMutationBroker({
    getCartWebContents: () => cart,
    getPrimaryWebContents: () => owner,
    getCurrentIdentity: () => mutationIdentity,
    setTimer: callback => { fireTimeout = callback; return 1; },
    clearTimer() {},
  });
  assert.match((await broker.request(cart, mutationRequest)).error, /unavailable/);

  owner = primary;
  const reloading = broker.request(cart, { ...mutationRequest, requestId: 'request-2' });
  primary.emit('did-start-navigation');
  assert.match((await reloading).error, /became unavailable/);

  const timedOut = broker.request(cart, { ...mutationRequest, requestId: 'request-3' });
  fireTimeout();
  assert.match((await timedOut).error, /did not respond/);
});

