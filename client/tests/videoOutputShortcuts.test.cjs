'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const {
  normalizeShortcutKey,
  shouldForwardVideoOutputShortcut,
  toRendererShortcut,
} = require('../electron/video-output-shortcuts');
const { buildVideoOutputContextTemplate } = require('../electron/video-output-context-menu');
const mainSource = readFileSync(require.resolve('../electron/main.js'), 'utf8');

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


test('quit waits for native diagnostic cleanup before terminating', async () => {
  const cleanup = deferred();
  let handler;
  let vetoed = false;
  const exits = [];
  const app = {
    on(_name, callback) { handler = callback; },
    exit(code) { exits.push(code); },
  };
  vm.runInNewContext(mainSource.slice(mainSource.indexOf("app.on('will-quit', (event) => {")), {
    app,
    stopTestCardForQuit: () => cleanup.promise,
    console,
  });
  handler({ preventDefault() { vetoed = true; } });
  assert.equal(vetoed, true);
  assert.deepEqual(exits, []);
  cleanup.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(exits, [0]);
});
