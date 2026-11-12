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

test('mounted audience view reports DOM readiness without waiting for an animation frame', async () => {
  const source = readFileSync(require.resolve('../app/components/VideoOutputView.vue'), 'utf8');
  const start = source.indexOf('onMounted(async () => {');
  const end = source.indexOf('\nonBeforeUnmount', start);
  assert.ok(start >= 0 && end > start);
  let mounted;
  let committed = false;
  let ready = 0;
  const api = {
    onStatus: () => () => {},
    rendererReady: async () => { assert.equal(committed, true); ready++; },
  };
  vm.runInNewContext(source.slice(start, end), {
    onMounted: callback => { mounted = callback; },
    window: { electronAPI: { videoOutput: api }, addEventListener() {} },
    offStatus: null, healthTimer: null,
    refreshStatus: async () => {}, syncConnection() {}, onKeydown() {}, onDblClick() {},
    nextTick: async () => { committed = true; },
    requestAnimationFrame() {}, // A minimized/covered renderer may never receive it.
    setInterval: () => 1,
  });
  await mounted();
  assert.equal(ready, 1, 'the native cover must not wait on hidden-window animation');
});

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
    if (depth === 0) return mainSource.slice(mainSource.slice(start - 6, start) === 'async ' ? start - 6 : start, index + 1);
  }
  throw new Error('unterminated '+name+' in Electron main process');
}

test('control-window close waits for healthy quit confirmation but never for a crashed renderer', () => {
  for (const state of ['healthy', 'crashed', 'destroyed', 'confirmed']) {
    const messages = [], serverStops = [];
    class ControlWindow extends EventEmitter {
      constructor() {
        super();
        this.webContents = new EventEmitter();
        this.webContents.openDevTools = () => {};
        this.webContents.isDestroyed = () => state === 'destroyed';
        this.webContents.isCrashed = () => state === 'crashed';
        this.webContents.send = channel => messages.push(channel);
      }
      loadURL() {}
    }
    const context = { mainWindow: null, BrowserWindow: ControlWindow,
      path: require('node:path'), __dirname: require('node:path').dirname(require.resolve('../electron/main.js')),
      isDevMode: true, quitConfirmed: state === 'confirmed', createMenu() {}, process: { argv: [] },
      stopServer: () => serverStops.push('stop'),
    };
    vm.runInNewContext(productionFunctionSource('createWindow') + '\ncreateWindow();', context);
    const window = context.mainWindow;
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    window.emit('close', event);
    assert.equal(event.prevented, state === 'healthy', state);
    assert.deepEqual(messages, state === 'healthy' ? ['app:request-quit'] : [], state);
    assert.deepEqual(serverStops, [], 'closing the client must not stop the detached show server');
    window.emit('closed');
    assert.equal(context.mainWindow, null, 'closed window reference is released');
  }
});

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
    URL, Date, videoOutputDiagnostics: [],
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
    'let videoOutputRecoveryRequired = false;',
    productionFunctionSource('requireIpcString'),
    productionFunctionSource('requireVideoOutputIpc'),
    productionFunctionSource('sanitizeVideoPlaybackErrorMessage'),
    productionFunctionSource('normalizeVideoPlaybackError'),
    mainSource.slice(handlerStart, handlerEnd),
    'globalThis.setCurrentOutputSender = (sender) => { videoOutputWindow = { isDestroyed: () => false, webContents: sender }; };',
    'globalThis.getPlaybackError = () => videoOutputPlaybackError;',
    'globalThis.latchRecovery = () => { videoOutputRecoveryRequired = true; };',
  ].join('\n'), context);
  return {
    broadcasts,
    getPlaybackError: context.getPlaybackError, latchRecovery: context.latchRecovery,
    report: handlers.get('video-output:report-playback-error'),
    setCurrentOutputSender: context.setCurrentOutputSender,
  };
}

function createVideoWindowHarness() {
  const captures = [], frames = [], statuses = [], cleanup = [], operator = [];
  const timers = new Map(), powerStops = [], errors = [];
  let timerId = 0, powerId = 0;
  class OutputWindow extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.delayClosed = false;
      this.webContents = new EventEmitter();
      this.webContents.isDestroyed = () => this.destroyed;
      this.webContents.capturePage = () => {
        const capture = deferred();
        captures.push(capture);
        return capture.promise;
      };
    }
    isDestroyed() { return this.destroyed; }
    contentView = { children: [], addChildView(view) { this.children.push(view); } };
    getContentSize() { return [960, 540]; }
    setAlwaysOnTop() {}
    loadURL() { return Promise.resolve(); }
    loadFile() { return Promise.resolve(); }
    show() {}
    isFullScreen() { return false; }
    destroy() {
      this.destroyed = true;
      if (!this.delayClosed) this.emit('closed');
    }
  }
  const context = {
    videoOutputWindow: null, videoOutputSessionEnabled: false,
    videoOutputPlaybackError: null, videoOutputTestCardConnection: null,
    videoOutputRendererReady: false, videoOutputRendererResponsive: true,
    videoOutputRecoveryRequired: false, videoOutputRestarting: false, videoOutputDiagnostics: [], URL,
    videoOutputPowerSaveId: null, videoOutputFrameTimer: null,
    videoOutputWindowsPreservingSession: new WeakSet(),
    readVideoOutputConfig: () => ({}), resolveVideoOutputDisplay: () => null,
    screen: { getAllDisplays: () => [{}] }, BrowserWindow: OutputWindow,
    View: class {
      setBackgroundColor(color) { this.color = color; }
      setBounds(bounds) { this.bounds = bounds; }
      setVisible(visible) { this.visible = visible; }
    },
    setTimeout, clearTimeout,
    path: require('node:path'), __dirname: require('node:path').dirname(require.resolve('../electron/main.js')),
    isDevMode: true, Date,
    mainWindow: {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (_channel, frame) => frames.push(frame) },
      show: () => operator.push('show'), focus: () => operator.push('focus'),
    },
    setInterval: callback => { timers.set(++timerId, callback); return timerId; },
    clearInterval: id => timers.delete(id),
    videoOutputStatus: () => ({ open: !!context.videoOutputWindow }),
    broadcastVideoOutputStatus: () => statuses.push({
      open: !!context.videoOutputWindow && !context.videoOutputWindow.isDestroyed(),
      enabled: context.videoOutputSessionEnabled, error: context.videoOutputPlaybackError,
    }),
    reconcileTestCardPlayback() {},
    testCardPlayback: { update: (_desired, connection) => { cleanup.push(connection); return Promise.resolve(); } },
    powerSaveBlocker: { isStarted: () => false, start: () => ++powerId, stop: id => powerStops.push(id) },
    shouldForwardVideoOutputShortcut, toRendererShortcut, showVideoOutputContextMenu() {},
    console: { error: (...args) => errors.push(args) },
  };
  const closeStart = mainSource.indexOf('function closeVideoOutputWindow(');
  const closeEnd = mainSource.indexOf('// Watchdog: when the display topology changes', closeStart);
  vm.runInNewContext([
    ...['sanitizeVideoPlaybackErrorMessage', 'loadVideoOutputWindow', 'failVideoOutputRenderer', 'markVideoOutputReady', 'restartVideoOutputWindow', 'requireVideoOutputIpc']
      .filter(name => mainSource.includes('function ' + name + '(')).map(productionFunctionSource),
    productionFunctionSource('startVideoOutputFrames'),
    productionFunctionSource('stopVideoOutputFrames'),
    productionFunctionSource('createVideoOutputWindow'),
    mainSource.slice(closeStart, closeEnd),
  ].join('\n'), context);
  return {
    context, captures, frames, statuses, cleanup, operator, powerStops, errors,
    open() {
      context.videoOutputSessionEnabled = true;
      context.createVideoOutputWindow();
      return context.videoOutputWindow;
    },
    tick() { return timers.get(context.videoOutputFrameTimer)(); },
    finishCapture(index, label) {
      captures[index].resolve({
        isEmpty: () => false, resize() { return this; },
        toJPEG: () => Buffer.from(label),
      });
    },
  };
}

test('video confidence capture waits for its current readback before starting another', async () => {
  const h = createVideoWindowHarness();
  h.open();
  const first = h.tick();
  void h.tick();
  void h.tick();
  assert.equal(h.captures.length, 1);
  h.finishCapture(0, 'first');
  await first;
  const next = h.tick();
  assert.equal(h.captures.length, 2);
  h.finishCapture(1, 'next');
  await next;
  assert.equal(h.frames.length, 2);
  const rejected = h.tick();
  h.captures[2].reject(new Error('readback cancelled'));
  await rejected;
  const retry = h.tick();
  assert.equal(h.captures.length, 4);
  h.finishCapture(3, 'retry');
  await retry;
  assert.equal(h.frames.length, 3);
});

test('stopped and replaced output capture completions cannot publish stale frames', async () => {
  const h = createVideoWindowHarness();
  h.open();
  const stopped = h.tick();
  h.context.stopVideoOutputFrames();
  h.finishCapture(0, 'stopped');
  await stopped;
  assert.equal(h.frames.length, 0);

  h.context.startVideoOutputFrames();
  const retired = h.tick();
  h.context.closeVideoOutputWindow({ preserveSession: true });
  h.open();
  const current = h.tick();
  h.finishCapture(1, 'retired');
  await retired;
  assert.equal(h.frames.length, 0);
  void h.tick();
  assert.equal(h.captures.length, 3, 'old completion must not clear the new capture gate');
  h.finishCapture(2, 'current');
  await current;
  assert.equal(h.frames.length, 1);
  assert.equal(Buffer.from(h.frames[0].jpeg, 'base64').toString(), 'current');
});

test('renderer loss retains native black coverage, session and power while restoring the operator', () => {
  const h = createVideoWindowHarness();
  const output = h.open();
  const connection = { serverUrl: 'http://127.0.0.1:4480', accessToken: 'owned' };
  h.context.videoOutputTestCardConnection = connection;
  const update = h.context.testCardPlayback.update;
  h.context.testCardPlayback.update = (...args) => {
    const result = update(...args);
    h.context.broadcastVideoOutputStatus();
    return result;
  };
  output.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 139 });
  assert.equal(output.isDestroyed(), false, 'native audience surface survives renderer loss');
  assert.equal(h.context.videoOutputWindow, output);
  assert.equal(h.context.videoOutputSessionEnabled, true);
  assert.equal(output.videoOutputCover.visible, true);
  assert.equal(output.videoOutputCover.color, '#000000');
  assert.equal(h.context.videoOutputRecoveryRequired, true);
  assert.equal(h.context.videoOutputFrameTimer, null);
  assert.match(h.context.videoOutputPlaybackError.message, /oom/);
  assert.match(h.context.videoOutputPlaybackError.message, /139/);
  assert.equal(h.statuses.at(-1).error, h.context.videoOutputPlaybackError);
  assert.equal(h.statuses.every(status => status.error === h.context.videoOutputPlaybackError), true);
  assert.deepEqual(h.cleanup, [connection]);
  assert.equal(h.context.videoOutputTestCardConnection, null);
  assert.deepEqual(h.powerStops, []);
  assert.deepEqual(h.operator, ['show', 'focus']);
  assert.equal(h.errors.length, 1);

  h.context.closeVideoOutputWindow({ preserveSession: true });
  const replacement = h.open();
  assert.notEqual(replacement, output);
  assert.equal(h.context.videoOutputPlaybackError, null);
  assert.equal(h.context.videoOutputSessionEnabled, true);
  output.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 7 });
  assert.equal(h.context.videoOutputWindow, replacement);
  assert.equal(h.context.videoOutputPlaybackError, null);
  assert.deepEqual(h.operator, ['show', 'focus']);
});

test('responsive events and old ready handshakes cannot uncover a failed output', () => {
  const h = createVideoWindowHarness();
  const output = h.open();
  assert.equal(output.videoOutputCover.visible, true, 'startup covered until audience view mounted');
  const frame = {};
  output.webContents.mainFrame = frame;
  const event = { sender: output.webContents, senderFrame: frame };
  h.context.markVideoOutputReady(event);
  assert.equal(output.videoOutputCover.visible, false);
  output.webContents.emit('unresponsive');
  assert.equal(output.videoOutputCover.visible, true);
  assert.equal(h.context.videoOutputRendererResponsive, false);
  output.webContents.emit('responsive');
  h.context.markVideoOutputReady(event);
  assert.equal(h.context.videoOutputRendererResponsive, true);
  assert.equal(output.videoOutputCover.visible, true, 'recovery requires deliberate restart');
  assert.throws(() => h.context.markVideoOutputReady({ ...event, senderFrame: {} }), /frame/i);
});

test('operator restart kills a hung renderer behind the same cover before loading', async () => {
  const h = createVideoWindowHarness();
  const output = h.open();
  let loads = 0;
  output.loadURL = () => { loads++; return Promise.resolve(); };
  output.webContents.isCrashed = () => false;
  output.webContents.forcefullyCrashRenderer = () => {
    assert.equal(output.videoOutputCover.visible, true);
    assert.equal(h.context.videoOutputRecoveryRequired, true);
    output.webContents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 1 });
  };
  await h.context.restartVideoOutputWindow();
  assert.equal(h.context.videoOutputWindow, output);
  assert.equal(output.isDestroyed(), false);
  assert.equal(loads, 1);
  assert.equal(output.videoOutputCover.visible, true, 'load alone cannot uncover operator UI during hydration');
  assert.equal(h.context.videoOutputRecoveryRequired, false);
  output.webContents.mainFrame = {};
  h.context.markVideoOutputReady({ sender: output.webContents, senderFrame: output.webContents.mainFrame });
  assert.equal(output.videoOutputCover.visible, false);
  assert.deepEqual(h.powerStops, []);
});

test('retired output close and load events cannot release a replacement diagnostic', () => {
  const h = createVideoWindowHarness();
  const old = h.open();
  old.delayClosed = true;
  const oldConnection = { accessToken: 'old' };
  h.context.videoOutputTestCardConnection = oldConnection;
  h.context.closeVideoOutputWindow({ preserveSession: true });
  assert.deepEqual(h.cleanup, [oldConnection]);
  const replacement = h.open();
  const newConnection = { accessToken: 'new' };
  h.context.videoOutputTestCardConnection = newConnection;
  const timer = h.context.videoOutputFrameTimer;
  const power = h.context.videoOutputPowerSaveId;
  old.emit('closed');
  old.webContents.emit('did-fail-load', {}, -2, 'old failure', '', true);
  old.webContents.emit('did-finish-load');
  assert.equal(h.context.videoOutputWindow, replacement);
  assert.equal(h.context.videoOutputTestCardConnection, newConnection);
  assert.equal(h.context.videoOutputFrameTimer, timer);
  assert.equal(h.context.videoOutputPowerSaveId, power);
  assert.deepEqual(h.cleanup, [oldConnection]);
  assert.deepEqual(h.operator, [], 'normal recreation must not focus the operator');
});

test('native operator close releases its own output without stealing focus', () => {
  const h = createVideoWindowHarness();
  const output = h.open();
  const connection = { accessToken: 'operator-close' };
  h.context.videoOutputTestCardConnection = connection;
  h.context.videoOutputPlaybackError = { itemUuid: 'old', message: 'old error' };
  output.destroy();
  assert.equal(h.context.videoOutputWindow, null);
  assert.equal(h.context.videoOutputSessionEnabled, false);
  assert.equal(h.context.videoOutputPlaybackError, null);
  assert.equal(h.context.videoOutputFrameTimer, null);
  assert.deepEqual(h.cleanup, [connection]);
  assert.deepEqual(h.powerStops, [1]);
  assert.deepEqual(h.operator, []);
});

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
  await harness.report({ sender: replacementOutput }, { itemUuid: null, message: 'Restart Output' });
  harness.latchRecovery();
  await harness.report({ sender: replacementOutput }, null);
  assert.equal(harness.getPlaybackError().message, 'Restart Output', 'late media report cannot clear latched renderer failure');
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


test('picture health is current-output/main-frame owned, finite and stripped of arbitrary diagnostics', () => {
  const sender = { mainFrame: {} };
  const context = { videoOutputWindow: { isDestroyed: () => false, webContents: sender },
    videoOutputRecoveryRequired: false, videoOutputPictureHealth: null, videoOutputDiagnostics: [], Date,
    broadcastVideoOutputStatus() {},
  };
  vm.runInNewContext(productionFunctionSource('requireVideoOutputIpc') + '\n' + productionFunctionSource('reportVideoPictureHealth'), context);
  const event = { sender, senderFrame: sender.mainFrame };
  const health = { itemUuid: 'cue', sourceItemUuid: 'cue', fileRevision: 'revision', preparedSeconds: null, state: 'playing', readyState: 4, mediaTime: 1,
    presentedFrames: 3, presentedAgeMs: 1000, droppedFrames: 1, totalFrames: 4,
    unsafeUrl: 'http://test/?access_token=secret' };
  context.reportVideoPictureHealth(event, health);
  assert.equal(context.videoOutputPictureHealth.mediaTime, 1);
  assert.equal(context.videoOutputPictureHealth.unsafeUrl, undefined);
  assert.ok(context.videoOutputPictureHealth.receivedAt > 0);
  assert.throws(() => context.reportVideoPictureHealth({ ...event, senderFrame: {} }, health), /main frame/);
  assert.throws(() => context.reportVideoPictureHealth({ ...event, sender: {} }, health), /sender/);
  assert.throws(() => context.reportVideoPictureHealth(event, { ...health, mediaTime: Infinity }), /Invalid/);
  for (let i = 0; i < 50; i++) context.reportVideoPictureHealth(event, health);
  assert.equal(context.videoOutputDiagnostics.length, 32, 'local history stays bounded');
  const last = context.videoOutputPictureHealth;
  context.videoOutputRecoveryRequired = true;
  context.reportVideoPictureHealth(event, { ...health, mediaTime: 2 });
  assert.equal(context.videoOutputPictureHealth, last);
});
