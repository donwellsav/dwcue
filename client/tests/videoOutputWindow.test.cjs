'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
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
    const window = { name, destroyed: false, isDestroyed: () => window.destroyed, destroy() { window.destroyed = true; made.push(`destroyed ${name}`); } };
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
    /setOutputFullscreen\(videoOutputWindow, process\.platform,\s*!isOutputFullscreen\(videoOutputWindow, process\.platform\)\)/);
});

// ---- Remembering the look-alikes: same size and name, a different screen -----
const vm = require('node:vm');

function displayResolver({ saved = [] } = {}) {
  const state = { displays: [], controlOn: laptop };
  const saves = [];
  const declarations = mainAst.statements.filter(node => ts.isVariableStatement(node) &&
    node.declarationList.declarations.every(d => d.name.getText(mainAst) === 'videoOutputLookalikes'))
    .map(node => node.getText(mainAst)).join('\n');
  assert.ok(declarations, 'missing videoOutputLookalikes in Electron main process');
  const context = {
    resolveAssignedDisplay,
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

test('look-alikes saved with the assignment hold from the first moment of a new session', () => {
  // The app starts with the audienceProjector unplugged and only its twin connected.
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
