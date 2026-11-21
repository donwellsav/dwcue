'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createMacVideoSignal, isSignalFormat } = require('../electron/mac-video-signal');
const {
  canToggleOutputFullscreen,
  claimSoleOutput,
  isOutputFullscreen,
  keepOutOfFullscreenSpaces,
  physicalOutputWindowOptions,
  previewWindowOptions,
  releaseOutputFullscreen,
  resolveAssignedDisplay,
  seatPhysicalOutput,
  setOutputFullscreen,
} = require('../electron/video-output-window.js');

const projector = { x: 1728, y: 0, width: 1920, height: 1080 };

// A window that records what was asked of it. `native` and `simple` are the
// two kinds of fullscreen Electron has on macOS.
function fakeWindow({ physical = false, native = false, simple = false } = {}) {
  const calls = [];
  const state = { native, simple };
  const window = {
    calls,
    state,
    isFullScreen: () => state.native,
    isSimpleFullScreen: () => state.simple,
    setFullScreen(on) { calls.push(['setFullScreen', on]); state.native = on; },
    setSimpleFullScreen(on) { calls.push(['setSimpleFullScreen', on]); state.simple = on; },
    hide() { calls.push(['hide']); },
    setBounds(bounds) { calls.push(['setBounds', { ...bounds }]); },
    setAlwaysOnTop(on, level) { calls.push(['setAlwaysOnTop', on, level]); },
    setVisibleOnAllWorkspaces(on, options) { calls.push(['setVisibleOnAllWorkspaces', on, { ...options }]); },
  };
  if (physical) window.videoOutputTargetDisplayId = 4;
  return window;
}

test('a Mac audience output is laid over its display and never enters a fullscreen Space', () => {
  // macOS fullscreen is a Space. With "Displays have separate Spaces" off, one
  // fullscreen window blanks every other display, the operator's included.
  const options = physicalOutputWindowOptions('darwin', projector);
  assert.equal('fullscreen' in options, false, 'no native fullscreen on macOS');
  assert.equal(options.fullscreenable, false, 'and nothing can send it there later');
  assert.deepEqual({ x: options.x, y: options.y, width: options.width, height: options.height }, projector,
    'exactly the assigned display');
  assert.equal(options.frame, false);
  assert.equal(options.enableLargerThanScreen, true, 'may sit over the menu bar instead of being pushed below it');
  assert.equal(options.roundedCorners, false, 'square to the corners of the display');
  assert.equal(options.hasShadow, false, 'no shadow thrown onto the neighbouring display');
  assert.equal(options.alwaysOnTop, true);
  assert.equal(options.movable, false);
  assert.equal(options.resizable, false);
  assert.equal(options.closable, true);
});

test('Windows and Linux audience outputs keep per-display fullscreen', () => {
  for (const platform of ['win32', 'linux']) {
    const options = physicalOutputWindowOptions(platform, projector);
    assert.equal(options.fullscreen, true, platform);
    assert.deepEqual({ x: options.x, y: options.y, width: options.width, height: options.height }, projector);
    for (const macOnly of ['fullscreenable', 'enableLargerThanScreen', 'roundedCorners', 'hasShadow']) {
      assert.equal(macOnly in options, false, `${platform} is unchanged: no ${macOnly}`);
    }
    assert.equal(options.frame, false);
    assert.equal(options.alwaysOnTop, true);
    assert.equal(options.closable, true, 'Alt+F4 stays available');
  }
});

test('seating a Mac audience output covers the display in every Space, above the menu bar', () => {
  const mac = fakeWindow({ physical: true });
  seatPhysicalOutput(mac, 'darwin', projector);
  assert.deepEqual(mac.calls, [
    ['setAlwaysOnTop', true, 'screen-saver'],
    ['setBounds', projector],
    // Stays on the audience display when the operator changes Space or puts
    // the control window into fullscreen; the app stays in the Dock.
    ['setVisibleOnAllWorkspaces', true, { visibleOnFullScreen: true, skipTransformProcessType: true }],
  ]);

  const windows = fakeWindow({ physical: true });
  seatPhysicalOutput(windows, 'win32', projector);
  assert.deepEqual(windows.calls, [['setAlwaysOnTop', true, 'screen-saver']], 'Windows is seated by fullscreen itself');
});

test('a Mac audience output reports fullscreen and ignores every request to change it', () => {
  const mac = fakeWindow({ physical: true });
  assert.equal(isOutputFullscreen(mac, 'darwin'), true, 'it covers its display by construction');
  assert.equal(canToggleOutputFullscreen(mac, 'darwin'), false);
  setOutputFullscreen(mac, 'darwin', true);
  setOutputFullscreen(mac, 'darwin', false);
  releaseOutputFullscreen(mac, 'darwin');
  assert.deepEqual(mac.calls, [], 'a double-click or menu choice cannot open a fullscreen Space');
});

test('the Mac preview window covers only its own screen when asked for fullscreen', () => {
  assert.equal(previewWindowOptions('darwin').fullscreenable, false,
    'the green button must not open a fullscreen Space either');
  const preview = fakeWindow();
  assert.equal(canToggleOutputFullscreen(preview, 'darwin'), true);
  assert.equal(isOutputFullscreen(preview, 'darwin'), false);
  setOutputFullscreen(preview, 'darwin', true);
  assert.deepEqual(preview.calls, [['setSimpleFullScreen', true]], 'simple fullscreen makes no Space');
  assert.equal(isOutputFullscreen(preview, 'darwin'), true);
  setOutputFullscreen(preview, 'darwin', false);
  assert.deepEqual(preview.calls.at(-1), ['setSimpleFullScreen', false]);
  assert.equal(isOutputFullscreen(preview, 'darwin'), false);
});

test('closing a Mac preview that covers its screen hands the menu bar and Dock back first', () => {
  // macOS does not restore them when a window in simple fullscreen is destroyed.
  const covering = fakeWindow({ simple: true });
  releaseOutputFullscreen(covering, 'darwin');
  assert.deepEqual(covering.calls, [['hide'], ['setSimpleFullScreen', false]],
    'hidden first: it goes at once instead of shrinking to a window on the way out');

  const windowed = fakeWindow();
  releaseOutputFullscreen(windowed, 'darwin');
  assert.deepEqual(windowed.calls, []);

  const windows = fakeWindow({ native: true });
  releaseOutputFullscreen(windows, 'win32');
  assert.deepEqual(windows.calls, [], 'nothing to hand back elsewhere');
});

test('Windows and Linux fullscreen requests are passed straight through', () => {
  for (const platform of ['win32', 'linux']) {
    for (const physical of [true, false]) {
      const window = fakeWindow({ physical });
      assert.equal(canToggleOutputFullscreen(window, platform), true);
      assert.equal(isOutputFullscreen(window, platform), false);
      setOutputFullscreen(window, platform, true);
      assert.equal(isOutputFullscreen(window, platform), true);
      setOutputFullscreen(window, platform, false);
      assert.deepEqual(window.calls, [['setFullScreen', true], ['setFullScreen', false]]);
    }
  }
  const preview = previewWindowOptions('win32');
  assert.equal('fullscreenable' in preview, false);
  assert.deepEqual(preview, { useContentSize: true, width: 960, height: 540, minWidth: 320, minHeight: 180 });
});

test('no other window of the app can open a fullscreen Space on a Mac either', async () => {
  // The control window (or Help, or QuickPlays) going into macOS fullscreen
  // blanks the audience display just as the output did to the control screen.
  const calls = [];
  const window = { isDestroyed: () => false, setFullScreenable: on => calls.push(on) };
  keepOutOfFullscreenSpaces(window, 'darwin');
  assert.deepEqual(calls, [], 'not while the window is still being made: Electron applies its options afterwards');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [false]);

  keepOutOfFullscreenSpaces({ isDestroyed: () => true, setFullScreenable: on => calls.push(on) }, 'darwin');
  keepOutOfFullscreenSpaces(window, 'win32');
  keepOutOfFullscreenSpaces(window, 'linux');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [false], 'a window already gone, and platforms where fullscreen belongs to one display, are left alone');
});

test('there is never more than one output window', () => {
  // A picture on two screens is the one thing the output must never do.
  const made = [];
  const output = (name) => {
    const window = {
      name, destroyed: false, simple: false, isDestroyed: () => window.destroyed,
      isSimpleFullScreen: () => window.simple,
      hide() { made.push(`hid ${name}`); },
      setSimpleFullScreen(on) { window.simple = on; made.push(`${name} left simple fullscreen`); },
      destroy() { window.destroyed = true; made.push(`destroyed ${name}`); },
    };
    return window;
  };
  const first = output('first');
  claimSoleOutput(first);
  assert.deepEqual(made, []);
  const second = output('second');
  claimSoleOutput(second);
  assert.deepEqual(made, ['destroyed first'], 'an output left behind is closed when another opens');
  assert.equal(second.destroyed, false);
  second.destroyed = true;                      // closed in the ordinary way
  const third = output('third');
  claimSoleOutput(third);
  assert.deepEqual(made, ['destroyed first'], 'a window already gone is not touched again');
  claimSoleOutput(third);
  assert.equal(third.destroyed, false, 'claiming twice is harmless');

  // A Mac preview left covering its screen holds the menu bar and Dock for the
  // whole app, and destroying it does not give them back: they are released first.
  made.length = 0;
  third.simple = true;
  claimSoleOutput(output('fourth'), 'darwin');
  assert.deepEqual(made, ['hid third', 'third left simple fullscreen', 'destroyed third']);
  assert.equal(third.simple, false);
});

// ---- Which display is the assigned one --------------------------------------
// A wrong screen at a live event is worse than no picture: never a guess.
const fingerprintOf = display => `${display.size.width}x${display.size.height}:${display.label || ''}`;
const display = (id, label, width = 1920, height = 1080) => ({ id, label, size: { width, height } });
const laptop = display(1, 'Built-in Retina Display', 1728, 1117);
const audienceProjector = display(2, 'EPSON PJ');
const stageMonitor = display(3, 'EPSON PJ');            // the same model, a different screen
const assigned = { displayId: '2', fingerprint: fingerprintOf(audienceProjector) };
const resolve = (displays, overrides = {}) => resolveAssignedDisplay({
  displays, ...assigned, fingerprintOf, lookalikeIds: [], controlDisplayId: laptop.id, ...overrides,
});

test('the assigned display is the one with the saved id while it is connected', () => {
  assert.equal(resolve([laptop, stageMonitor, audienceProjector]), audienceProjector, 'an identical twin never wins over the id');
  assert.equal(resolve([laptop, audienceProjector], { fingerprint: null }), audienceProjector);
});

test('a display that came back under a new id is recognised by size and name', () => {
  const returned = display(7, 'EPSON PJ');
  assert.equal(resolve([laptop, returned]), returned);
  assert.equal(resolve([laptop, returned], { fingerprint: null }), null, 'nothing to recognise it by');
  assert.equal(resolve([laptop, display(7, 'EPSON PJ', 1280, 720)]), null, 'a different size is a different screen');
});

test('an identical screen that was connected next to the assigned one is never taken for it', () => {
  // The audience audienceProjector drops out mid-show; the stage monitor of the same
  // model is still there. It must not receive the audience picture.
  assert.equal(resolve([laptop, stageMonitor], { lookalikeIds: ['3'] }), null);
  const returned = display(7, 'EPSON PJ');
  assert.equal(resolve([laptop, stageMonitor, returned], { lookalikeIds: ['3'] }), returned,
    'the audienceProjector itself is still recognised when it returns');
});

test('two screens that could both be the assigned one are a question for the operator', () => {
  assert.equal(resolve([laptop, display(7, 'EPSON PJ'), display(8, 'EPSON PJ')]), null);
});

test('the screen with the control window is never taken for the assigned display', () => {
  const twin = display(1, 'EPSON PJ');                  // control window on a screen of the same model
  assert.equal(resolve([twin], { controlDisplayId: 1 }), null);
  assert.equal(resolve([twin, display(7, 'EPSON PJ')], { controlDisplayId: 1 }).id, 7);
});

// ---- The wiring in main.js --------------------------------------------------
// Every fullscreen decision for the output window goes through the module
// above; a direct call would bring the fullscreen Space back on macOS.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
const mainAst = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functionSource = (name) => {
  const node = mainAst.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(node, `missing ${name} in Electron main process`);
  return node.getText(mainAst);
};
const handlerSource = (channel) => {
  const node = mainAst.statements.find(statement => ts.isExpressionStatement(statement) &&
    ts.isCallExpression(statement.expression) &&
    statement.expression.expression.getText(mainAst) === 'ipcMain.handle' &&
    statement.expression.arguments[0]?.text === channel);
  assert.ok(node, `missing ${channel} handler in Electron main process`);
  return node.getText(mainAst);
};

test('main builds and seats the output window through the per-platform rules', () => {
  const create = functionSource('createVideoOutputWindow');
  assert.match(create, /physicalOutputWindowOptions\(process\.platform, target\.bounds\)/);
  assert.match(create, /previewWindowOptions\(process\.platform\)/);
  assert.match(create, /seatPhysicalOutput\(outputWindow, process\.platform, target\.bounds\)/);
  assert.match(create, /const outputWindow = new BrowserWindow\(options\);\s*claimSoleOutput\(outputWindow\);/,
    'a new output window closes any other before it shows anything');
  assert.doesNotMatch(create, /fullscreen: true/, 'the fullscreen choice belongs to the platform rules');
  assert.doesNotMatch(create, /\.setFullScreen\(|\.isFullScreen\(/);
});

test('no output fullscreen request in main reaches the window directly', () => {
  for (const source of [
    functionSource('videoOutputStatus'),
    functionSource('showVideoOutputContextMenu'),
    functionSource('closeVideoOutputWindow'),
    handlerSource('video-output:set-fullscreen'),
    handlerSource('video-output:toggle-fullscreen'),
  ]) {
    assert.doesNotMatch(source, /\.setFullScreen\(|\.isFullScreen\(|\.setSimpleFullScreen\(/);
  }
  assert.match(functionSource('videoOutputStatus'), /isOutputFullscreen\(videoOutputWindow, process\.platform\)/);
  assert.match(functionSource('showVideoOutputContextMenu'), /canToggleOutputFullscreen\(outputWindow, process\.platform\)/);
  assert.match(functionSource('closeVideoOutputWindow'),
    /releaseOutputFullscreen\(outputWindow, process\.platform\);\s*outputWindow\.destroy\(\)/,
    'the menu bar and Dock are handed back before the window goes');
  assert.match(handlerSource('video-output:set-fullscreen'), /setOutputFullscreen\(videoOutputWindow, process\.platform, on === true\)/);
  assert.match(handlerSource('video-output:toggle-fullscreen'),
    /setOutputFullscreen\(videoOutputWindow, process\.platform,\s*!wasOpen \|\| !isOutputFullscreen\(videoOutputWindow, process\.platform\)\)/);
});

// ---- Remembering the look-alikes: same size and name, a different screen -----
const vm = require('node:vm');

test('Video Output fullscreen opens when requested and toggles an existing window', () => {
  let handler;
  let opened = 0;
  let fullscreen = false;
  const context = {
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    requireTrustedIpc: () => {},
    process: { platform: 'darwin' },
    videoOutputWindow: null,
    openVideoOutputWindow: () => {
      opened += 1;
      context.videoOutputWindow = { isDestroyed: () => false };
    },
    isOutputFullscreen: () => fullscreen,
    setOutputFullscreen: (_window, _platform, on) => { fullscreen = on; },
    broadcastVideoOutputStatus: () => fullscreen,
  };
  vm.runInNewContext(handlerSource('video-output:toggle-fullscreen'), context);
  assert.equal(handler({}, false), false);
  assert.equal(opened, 0);
  assert.equal(handler({}, true), true);
  assert.equal(opened, 1);
  assert.equal(handler({}, true), false);
  assert.equal(handler({}, true), true);
  assert.equal(opened, 1);
});

function displayResolver({ saved = [] } = {}) {
  const state = { displays: [], controlOn: laptop };
  const saves = [];
  const declarations = mainAst.statements.filter(node => ts.isVariableStatement(node) &&
    node.declarationList.declarations.every(d => d.name.getText(mainAst) === 'videoOutputLookalikes'))
    .map(node => node.getText(mainAst)).join('\n');
  assert.ok(declarations, 'missing videoOutputLookalikes in Electron main process');
  const context = {
    resolveAssignedDisplay,
    macVideoSignal: null,
    screen: {
      getAllDisplays: () => state.displays,
      getDisplayMatching: () => state.controlOn,
    },
    mainWindow: { isDestroyed: () => false, getBounds: () => ({}) },
    writeVideoOutputConfig: cfg => { saves.push(JSON.parse(JSON.stringify(cfg))); return true; },
  };
  vm.runInNewContext([declarations, functionSource('videoOutputFingerprint'),
    functionSource('videoOutputLookalikeIds'), functionSource('resolveVideoOutputDisplay')].join('\n'), context);
  const config = { displayId: '2', displayFingerprint: fingerprintOf(audienceProjector), displayLookalikes: saved };
  return { state, saves, config,
    resolve: (displays) => { state.displays = displays; return context.resolveVideoOutputDisplay(config); } };
}

test('main remembers a look-alike it saw next to the assigned display', () => {
  const rig = displayResolver();
  assert.equal(rig.resolve([laptop, audienceProjector, stageMonitor]), audienceProjector);
  assert.equal(rig.resolve([laptop, stageMonitor]), null,
    'the projector dropped out: its twin is known to be another screen, so the output closes instead of moving there');
  const returned = display(7, 'EPSON PJ');
  assert.equal(rig.resolve([laptop, stageMonitor, returned]), returned, 'and comes back on the projector');
});

test('a display recognised under a new id becomes the assigned display from then on', () => {
  // Otherwise an identical screen plugged in later would make two candidates,
  // and the output would close in the middle of a show.
  const rig = displayResolver();
  const returned = display(7, 'EPSON PJ');
  assert.equal(rig.resolve([laptop, returned]), returned);
  assert.equal(rig.saves.length, 1, 'the new id is saved once');
  assert.equal(rig.saves[0].displayId, '7');
  assert.equal(rig.config.displayId, '7', 'and the caller sees it straight away');
  assert.equal(rig.resolve([laptop, returned]), returned);
  assert.equal(rig.saves.length, 1, 'nothing more to save while it stays');
  const latecomer = display(8, 'EPSON PJ');
  assert.equal(rig.resolve([laptop, returned, latecomer]), returned, 'a twin arriving later is not a rival');
  assert.equal(rig.resolve([laptop, latecomer]), null, 'nor a stand-in when the projector drops out');
});

test('a screen of another model is not a look-alike and does not block its id later', () => {
  // The projector is re-plugged into the port the operator's second monitor
  // used, and takes over that id. It is still recognised.
  const rig = displayResolver();
  const secondMonitor = display(5, 'DELL U2720Q', 2560, 1440);
  assert.equal(rig.resolve([laptop, audienceProjector, secondMonitor]), audienceProjector);
  const replugged = display(5, 'EPSON PJ');
  assert.equal(rig.resolve([laptop, replugged]), replugged);
});

test('look-alikes recorded when the display was assigned hold before the resolver has seen them', () => {
  // The audienceProjector is unplugged after it was assigned; only its twin is connected.
  assert.equal(displayResolver({ saved: ['3'] }).resolve([laptop, stageMonitor]), null);
  assert.equal(displayResolver().resolve([laptop, stageMonitor]), stageMonitor,
    'with nothing recorded, one fitting screen is taken to be the display coming back');
});

test('assigning a display records its connected look-alikes', () => {
  const handler = handlerSource('video-output:set-display');
  assert.match(handler, /cfg\.displayLookalikes = target \? videoOutputLookalikeIds\(screen\.getAllDisplays\(\), target\) : \[\]/);
  assert.match(handler, /videoOutputLookalikes\.clear\(\)/, 'a new assignment starts a clean record');
  assert.match(functionSource('readVideoOutputConfig'), /displayLookalikes:/);
});

test('every window is kept out of fullscreen Spaces, and the control window fills its screen instead', () => {
  assert.match(mainSource,
    /app\.on\('browser-window-created', \(_event, window\) => keepOutOfFullscreenSpaces\(window, process\.platform\)\)/);
  assert.match(mainSource, /process\.platform === 'darwin'\s*\? \{ role: 'zoom' \}/,
    'the Mac View menu offers Zoom where other platforms offer Fullscreen');
});

// ---- Going fullscreen on one screen -------------------------------------------
// Fullscreen changes the display's metrics (on a Mac the menu bar and Dock go),
// which wakes the display watchdog. Only a physical output whose own display
// has gone may be closed by it; the preview window has no display to lose.
function displayWatchdog({ outputWindow, displays = [laptop], target = null, platform = 'darwin', signalPhase, enabled = true }) {
  const listeners = {};
  const timers = [];
  const closes = [];
  const actions = [];
  const context = {
    videoOutputWatchdogInstalled: false,
    macVideoSignal: signalPhase ? { state: { phase: signalPhase }, recheck: () => actions.push('recheck') } : null,
    videoOutputWatchdogTimer: null,
    videoOutputSessionEnabled: enabled,
    videoOutputWindow: outputWindow,
    syncMacVideoSignal() {},
    reconcileMacVideoSignal() {},
    isMacAudienceDisplay: (display) => display !== laptop,
    powerMonitor: { on() {} },
    // A screen chosen earlier; connected only when `target` is given.
    readVideoOutputConfig: () => ({ displayId: '99' }),
    resolveVideoOutputDisplay: () => target,
    closeVideoOutputWindow: (options) => { closes.push(options); actions.push('close'); },
    createVideoOutputWindow: () => actions.push('create'),
    broadcastVideoOutputStatus() {},
    screen: { getAllDisplays: () => displays, on: (name, listener) => { listeners[name] = listener; } },
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
    clearTimeout() {},
    process: { platform },
  };
  vm.runInNewContext(['parkVideoOutputWindow', 'restoreVideoOutputWindow', 'installVideoOutputWatchdog']
    .map(functionSource).join('\n'), context);
  context.installVideoOutputWatchdog();
  const fire = (name) => { listeners[name](); timers.splice(0).forEach(run => run()); };
  return { closes, actions, metricsChange: () => fire('display-metrics-changed'), displayAdded: () => fire('display-added') };
}

test('the preview window stays open when going fullscreen changes the display metrics', () => {
  const preview = { isDestroyed: () => false };   // no videoOutputTargetDisplayId: not a physical output
  const rig = displayWatchdog({ outputWindow: preview });
  rig.metricsChange();
  assert.deepEqual(rig.closes, [], 'the preview window is not closed by a display it never had');
});

test('on a Mac a physical output whose display has gone is hidden and kept, not closed', () => {
  let hidden = false;
  const output = { isDestroyed: () => false, videoOutputTargetDisplayId: 99, hide: () => { hidden = true; } };
  const rig = displayWatchdog({ outputWindow: output });
  rig.metricsChange();
  assert.equal(hidden, true, 'it cannot sit on the control screen');
  assert.deepEqual(rig.closes, [], 'kept, so it comes back live when the display returns');
});

test('a returning external display is rechecked when the native HDMI helper still reports it missing', () => {
  const returned = displayWatchdog({ displays: [laptop, audienceProjector], signalPhase: 'missing' });
  returned.displayAdded();
  assert.deepEqual(returned.actions, ['recheck']);

  const onlyLaptop = displayWatchdog({ signalPhase: 'missing' });
  onlyLaptop.metricsChange();
  assert.deepEqual(onlyLaptop.actions, []);

  const closed = displayWatchdog({ displays: [laptop, audienceProjector], signalPhase: 'missing', enabled: false });
  closed.displayAdded();
  assert.deepEqual(closed.actions, []);
});

test('elsewhere a physical output still closes when its own display has gone', () => {
  const output = { isDestroyed: () => false, videoOutputTargetDisplayId: 99 };
  const rig = displayWatchdog({ outputWindow: output, platform: 'win32' });
  rig.metricsChange();
  assert.deepEqual(JSON.parse(JSON.stringify(rig.closes)), [{ preserveSession: true }]);
});

// The projector drops out, the operator reopens the output (a preview on the
// control screen), and the projector comes back: the preview becomes the
// output on it, as when a display is assigned in Settings. It is not moved
// there as an ordinary window with a title bar.
const returnedProjector = { ...audienceProjector, bounds: { x: 1728, y: 0, width: 1920, height: 1080 } };
const controlScreen = { ...laptop, bounds: { x: 0, y: 0, width: 1728, height: 1117 } };

test('a preview opened while its display was missing becomes the output when the display returns', () => {
  const preview = { isDestroyed: () => false, videoOutputWaitingForDisplay: true };
  const rig = displayWatchdog({ outputWindow: preview, displays: [controlScreen, returnedProjector], target: returnedProjector });
  rig.displayAdded();
  assert.deepEqual([...rig.actions], ['close', 'create']);
  assert.deepEqual(JSON.parse(JSON.stringify(rig.closes)), [{ preserveSession: true }], 'the session stays open');
});

test('a preview that was not waiting for a display is not turned into an output by a new screen', () => {
  // The operator assigned the only screen, then plugged in a second one: the
  // control screen must not be taken over by a borderless output.
  const preview = {
    isDestroyed: () => false, isFullScreen: () => false,
    getBounds: () => ({ x: 100, y: 100, width: 960, height: 540 }), setBounds() {},
  };
  const rig = displayWatchdog({ outputWindow: preview, displays: [controlScreen, returnedProjector], target: controlScreen });
  rig.displayAdded();
  assert.deepEqual([...rig.actions], []);
});

// ---- Screens are chosen fresh every time the app starts -------------------------
// Which display is the output, and which one a capture is taken from, hold for
// this run only. Nothing about screens is read from or written to disk.
function videoOutputSettings(fileText) {
  const disk = { text: fileText };
  const declarations = mainAst.statements.filter(node => ts.isVariableStatement(node) &&
    node.declarationList.declarations.every(d => ['VIDEO_OUTPUT_CONFIG_FILENAME', 'videoOutputScreens'].includes(d.name.getText(mainAst))))
    .map(node => node.getText(mainAst)).join('\n');
  const context = {
    app: { getPath: () => '/user-data' },
    path,
    fs: {
      readFileSync: () => { if (disk.text == null) throw new Error('ENOENT'); return disk.text; },
      writeFileSync: (_file, text) => { disk.text = text; },
    },
    readVideoFraming: value => value ?? null,
    isSignalFormat,
    DEFAULT_VIDEO_FRAMING: { width: 1920, height: 1080, scale: 100, scaling: 'fit' },
    createTestCardConfig: value => value ?? { cardType: 'bars' },
    console,
  };
  vm.runInNewContext([declarations, 'const PICTURE_OFFSET_MAX_MS = 500;', functionSource('readPictureOffset'),
    functionSource('videoOutputConfigPath'),
    functionSource('readVideoOutputConfig'), functionSource('writeVideoOutputConfig')].join('\n'), context);
  return { disk, read: () => context.readVideoOutputConfig(), write: cfg => context.writeVideoOutputConfig(cfg) };
}

test('screens remembered by an earlier version are not used', () => {
  const framing = { width: 1280, height: 720, scale: 90, scaling: 'fit' };
  const settings = videoOutputSettings(JSON.stringify({
    displayId: '5', displayFingerprint: '1920x1080:EPSON PJ', displayLookalikes: ['6'], captureDisplayId: '7', framing,
  }));
  const cfg = settings.read();
  assert.equal(cfg.displayId, null);
  assert.equal(cfg.displayFingerprint, null);
  assert.deepEqual([...cfg.displayLookalikes], []);
  assert.equal(cfg.captureDisplayId, null);
  assert.deepEqual({ ...cfg.framing }, framing, 'picture framing is not a screen and is still kept');
});

test('a screen chosen now holds for this run and is never written to disk', () => {
  const settings = videoOutputSettings(null);
  const cfg = settings.read();
  Object.assign(cfg, { displayId: '5', displayFingerprint: '1920x1080:EPSON PJ', displayLookalikes: ['6'], captureDisplayId: '7' });
  assert.equal(settings.write(cfg), true);
  const saved = JSON.parse(settings.disk.text);
  for (const key of ['displayId', 'displayFingerprint', 'displayLookalikes', 'captureDisplayId']) {
    assert.equal(key in saved, false, `${key} is not saved`);
  }
  assert.ok(saved.framing && saved.testCardConfig, 'framing and test card settings are still saved');
  assert.equal(saved.pictureOffsetMs, 0, 'picture sync is saved with them');
  const again = settings.read();
  assert.equal(again.displayId, '5');
  assert.equal(again.displayFingerprint, '1920x1080:EPSON PJ');
  assert.deepEqual([...again.displayLookalikes], ['6']);
  assert.equal(again.captureDisplayId, '7');
});

test('picture sync takes whole milliseconds from 0 to 500 and nothing else', () => {
  const context = {};
  vm.runInNewContext(`const PICTURE_OFFSET_MAX_MS = 500;\n${functionSource('readPictureOffset')}\nthis.read = readPictureOffset;`, context);
  for (const value of [0, 33, 500]) assert.equal(context.read(value), value);
  for (const value of [-1, 501, 12.5, '80', null, undefined, Number.NaN]) assert.equal(context.read(value), null);
});

test('existing shows default to exact 1080p59.94 and signal preferences survive a restart', () => {
  for (const previous of [null, '{}', '{"signalFormat":"1080p60ish"}']) {
    assert.equal(videoOutputSettings(previous).read().signalFormat, '1080p59.94');
  }
  const raw = 'native:00112233-4455-6677-8899-aabbccddeeff:2f:1920x1080i:29970000';
  const settings = videoOutputSettings(null);
  for (const mode of ['auto', '1080i59.94', '720p59.94', '1080p60.00', 'current', raw]) {
    assert.ok(isSignalFormat(mode));
    settings.write({ ...settings.read(), signalFormat: mode });
    assert.equal(videoOutputSettings(settings.disk.text).read().signalFormat, mode);
  }
  for (const value of ['1080i29.97', '1080p59.9', 'native:2f', raw + '\ninvalid', null]) {
    assert.equal(isSignalFormat(value), false);
  }
});

function macSignalHarness() {
  const owners = [];
  const signal = createMacVideoSignal(() => '/test/dwcue-display-modes', () => {}, () => {
    const worker = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), commands: [] });
    worker.stdin.on('data', line => worker.commands.push(JSON.parse(line)));
    owners.push(worker);
    return worker;
  });
  function reply(worker, command, id, canPresent, phase = canPresent ? 'matched' : 'idle', restoreFailed = false) {
    worker.stdout.write(JSON.stringify({ revision: command.revision, uuid: 'assigned-display', id, phase, canPresent, restoreFailed }) + '\n');
  }
  return { signal, owners, reply };
}

test('only the latest native readback can arm the output after Apply or a replug', () => {
  const { signal, owners, reply } = macSignalHarness();
  const initial = { id: '2', control: '1', enabled: true, format: 'auto' };
  signal.configure(initial);
  const [worker] = owners;
  const { commands } = worker;
  signal.configure(initial);
  assert.equal(commands.length, 1, 'ordinary status updates do not set a mode again');
  reply(worker, commands[0], '2', true);
  signal.configure({ ...initial, format: '1080i59.94' });
  const apply = commands.at(-1);
  assert.equal(apply.assign, false);
  assert.equal(apply.apply, true);
  assert.equal(apply.uuid, 'assigned-display');
  signal.displayRemoved(3);
  assert.equal(commands.at(-1), apply, 'another screen has no effect');
  signal.displayRemoved(2);
  const recheck = commands.at(-1);
  assert.equal(recheck.assign, false);
  assert.equal(recheck.apply, false);
  reply(worker, apply, '2', true);
  assert.equal(signal.state.canPresent, false, 'stale confirmation from before disconnect');
  reply(worker, recheck, '7', true);
  assert.equal(signal.state.id, '7', 'the native owner found the same UUID under a new ID');
  signal.recheck(true);
  const wake = commands.at(-1);
  assert.ok(wake.apply && !wake.assign, 'wake reacquires the requested mode on the original physical output');
  assert.equal(signal.state.canPresent, false);
  reply(worker, wake, '7', true);
  worker.stdout.end();
  worker.stdin.end();
});

test('Close releases Quartz ownership after a replug before an output can reopen', async () => {
  const { signal, owners, reply } = macSignalHarness();
  const initial = { id: '2', control: '1', enabled: true, format: '1080i59.94' };
  signal.configure(initial);
  const [worker] = owners;
  const { commands } = worker;
  reply(worker, commands.at(-1), '2', true);
  signal.displayRemoved(2);
  reply(worker, commands.at(-1), '7', true);
  const interrupted = assert.rejects(signal.applyFormat('1080p60.00', () => assert.fail('saved during Close')),
    /changed before confirming/);
  const live = commands.at(-1);
  signal.configure({ ...initial, enabled: false, format: '1080i59.94' });
  const close = commands.at(-1);
  assert.equal(close.enabled, false, 'the helper gets a chance to restore its original mode');
  assert.equal(close.format, initial.format, 'Close restores the last confirmed preference');
  assert.equal(worker.stdin.writableEnded, true, 'EOF releases the app-scoped mode even if its old reference was lost');
  reply(worker, live, '7', true);
  reply(worker, close, '7', false);
  assert.equal(signal.state.canPresent, false, 'a late reply cannot re-open a closed feed');
  signal.configure(initial);
  assert.equal(owners.length, 1, 'rapid reopen waits for the old Quartz owner to exit');
  assert.equal(commands.at(-1), close, 'no new configuration is sent to the retiring process');
  worker.emit('close', 0);
  const replacement = owners[1];
  const reopen = replacement.commands[0];
  assert.equal(reopen.uuid, 'assigned-display');
  assert.equal(reopen.enabled, true);
  reply(replacement, reopen, '7', true);
  assert.equal(signal.state.id, '7');
  await interrupted;

  signal.configure({ ...initial, enabled: false });
  reply(replacement, replacement.commands.at(-1), '7', false, 'restoreFailed', true);
  replacement.emit('close', 0);
  const inventory = owners[2];
  const inspection = inventory.commands[0];
  assert.equal(inspection.enabled, false);
  assert.equal(inspection.apply, false, 'the replacement only inspects the closed display');
  reply(inventory, inspection, '7', false);
  assert.equal(signal.state.restoreFailed, true, 'an unconfirmed explicit restore stays visible');
  signal.configure(initial);
  reply(inventory, inventory.commands.at(-1), '7', true);
  signal.configure({ ...initial, enabled: false });
  inventory.emit('close', 1);
  const afterCrash = owners[3];
  reply(afterCrash, afterCrash.commands[0], '7', false);
  assert.equal(signal.state.restoreFailed, true, 'restarting the helper cannot confirm a lost restoration result');
  afterCrash.stdout.end();
  afterCrash.stdin.end();
});

test('the live format handler saves only a verified choice and resumes the saved choice after failure', async () => {
  const { signal, owners, reply } = macSignalHarness();
  const selected = { id: '2', control: '1', enabled: true, format: '1080p59.94' };
  const saves = [];
  const cfg = { displayId: '2', signalFormat: selected.format };
  const ctx = {
    ipcMain: { handle: (_name, handler) => { ctx.handle = handler; } },
    macVideoSignal: signal, isSignalFormat, videoOutputSessionEnabled: true, requireVideoCheckOwner() {},
    readVideoOutputConfig: () => ({ ...cfg }),
    writeVideoOutputConfig: (next) => { saves.push(next.signalFormat); Object.assign(cfg, next); return true; },
    syncMacVideoSignal: current => signal.configure({ ...selected, format: current.signalFormat }),
    broadcastVideoOutputStatus: () => signal.state,
  };
  vm.runInNewContext(handlerSource('video-output:set-signal-format'), ctx);
  signal.configure(selected);
  const [worker] = owners;
  const { commands } = worker;
  reply(worker, commands[0], '2', true);

  const failed = assert.rejects(ctx.handle({}, '1080p60.00'), /keeping the previous format setting/);
  assert.equal(commands.at(-1).format, '1080p60.00');
  assert.deepEqual(saves, []);
  reply(worker, commands.at(-1), '2', true, 'failed');
  await failed;
  assert.equal(cfg.signalFormat, '1080p59.94');
  assert.equal(commands.at(-1).format, '1080p59.94');
  assert.equal(commands.at(-1).apply, false, 'a confirmed rollback does not request another HDMI switch');
  reply(worker, commands.at(-1), '2', true);

  const succeeds = ctx.handle({}, '1080i59.94');
  reply(worker, commands.at(-1), '2', true);
  await succeeds;
  assert.deepEqual(saves, ['1080i59.94']);
  signal.displayRemoved(2);
  assert.equal(commands.at(-1).format, '1080i59.94', 'reconnect uses the verified preference');
  reply(worker, commands.at(-1), '7', true);

  const interrupted = assert.rejects(ctx.handle({}, '1080p60.00'), /display changed/);
  signal.displayRemoved(7);
  await interrupted;
  assert.equal(commands.at(-1).format, '1080i59.94');
  assert.deepEqual(saves, ['1080i59.94']);
  reply(worker, commands.at(-1), '7', true);
  worker.stdout.end();
  worker.stdin.end();
});

test('the Mac output picker excludes the built-in and control screens while capture can still see them', () => {
  const internal = { ...laptop, internal: true };
  const ctx = {
    mainWindow: { getBounds: () => ({}), isDestroyed: () => false },
    screen: { getDisplayMatching: () => stageMonitor, getPrimaryDisplay: () => internal },
    macVideoSignal: {},
    orderedVideoOutputDisplays: () => [internal, audienceProjector, stageMonitor],
  };
  vm.runInNewContext(['isMacAudienceDisplay', 'videoOutputDisplays'].map(functionSource).join('\n'), ctx);
  assert.deepEqual(Array.from(ctx.videoOutputDisplays(true), d => d.id), ['2']);
  assert.deepEqual(Array.from(ctx.videoOutputDisplays(), d => d.id), ['1', '2', '3']);
  assert.equal(ctx.videoOutputDisplays(true)[0].index, 2, 'the picker still matches the Identify Displays numbers');
});

test('Mac audience pictures follow confirmed native identity and keep a previously verified feed on a failed Apply', () => {
  const cfg = { displayId: '2' };
  const returned = { ...display(7, 'EPSON PJ', 1280, 720), bounds: { x: 1728, y: 0, width: 1280, height: 720 } };
  let displays = [laptop, audienceProjector, stageMonitor];
  let control = laptop;
  const actions = [];
  const ctx = {
    videoOutputSessionEnabled: true, videoOutputScreens: cfg, videoOutputWindow: null,
    macVideoSignal: { state: {} }, process: { platform: 'darwin' },
    mainWindow: { isDestroyed: () => false, getBounds: () => ({}) },
    screen: { getAllDisplays: () => displays, getDisplayMatching: () => control },
    readVideoOutputConfig: () => cfg, broadcastVideoOutputStatus() {}, resetVideoOutputGeometry() {},
    seatPhysicalOutput: (_win, _platform, bounds) => actions.push(['seat', bounds]),
    createVideoOutputWindow: () => actions.push('create'),
  };
  vm.runInNewContext(['resolveVideoOutputDisplay', 'parkVideoOutputWindow', 'restoreVideoOutputWindow',
    'reconcileMacVideoSignal'].map(functionSource).join('\n'), ctx);
  const report = (id, phase, canPresent) => {
    ctx.macVideoSignal.state = { id, phase, canPresent };
    ctx.reconcileMacVideoSignal();
    return actions.splice(0);
  };
  assert.deepEqual(report('2', 'unavailable', false), []);
  assert.deepEqual(report('2', 'matched', true), ['create']);
  ctx.videoOutputWindow = { videoOutputTargetDisplayId: 2, isDestroyed: () => false,
    getBounds: () => undefined, hide: () => actions.push('hide'), show: () => actions.push('show') };
  assert.deepEqual(report('2', 'unavailable', true), [], 'a verified previous timing can keep playing');
  assert.deepEqual(report('2', 'mismatch', false), ['hide']);
  displays = [laptop, stageMonitor, returned];
  assert.deepEqual(report(null, 'missing', false), [], 'an identical monitor must not be substituted');
  assert.deepEqual(report('7', 'matched', true), [['seat', returned.bounds], 'show']);
  control = returned;
  assert.deepEqual(report('7', 'matched', true), ['hide'], 'even a valid report cannot take the operator screen');
  ctx.videoOutputSessionEnabled = false;
  ctx.videoOutputWindow = null;
  control = laptop;
  assert.deepEqual(report('7', 'matched', true), []);
});
