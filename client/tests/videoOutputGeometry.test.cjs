const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  MAX_CORRECTIONS,
  planGeometryCorrection,
  readViewportReport,
  spillsOntoOtherDisplay,
  viewportCoversScreen,
  viewportExceedsScreen,
} = require('../electron/video-output-geometry.js');

const { setOutputFullscreen, usesNativeFullscreen } = require('../electron/video-output-window.js');

const full = { innerWidth: 1920, innerHeight: 1080, screenWidth: 1920, screenHeight: 1080, pixelScale: 1 };
// A 1080p projector at 100% fed from a laptop at 150%: the window was sized
// with the laptop's scale and covers two thirds of the projector each way.
const short = { ...full, innerWidth: 1280, innerHeight: 720 };
const target = { x: 2560, y: 0, width: 1920, height: 1080 };
const plan = (overrides = {}) => planGeometryCorrection({
  platform: 'win32', report: short, corrections: 0, fullscreenWanted: true,
  onTargetDisplay: true, windowBounds: target, targetBounds: target, ...overrides,
});

test('only whole, plausible viewport measurements are accepted from the output page', () => {
  assert.deepEqual(readViewportReport({ ...full, extra: 'ignored' }), full);
  for (const bad of [null, [], 'x', { ...full, innerWidth: 0 }, { ...full, innerHeight: 1080.5 },
    { ...full, screenWidth: 40000 }, { ...full, screenHeight: '1080' }, { ...full, pixelScale: 0 },
    { ...full, pixelScale: Number.NaN }, { innerWidth: 1920 }]) {
    assert.equal(readViewportReport(bad), null);
  }
});

test('coverage allows rounding slack but not a visibly short window', () => {
  assert.equal(viewportCoversScreen(full), true);
  assert.equal(viewportCoversScreen({ ...full, innerWidth: 1918, innerHeight: 1079 }), true,
    'fractional scaling can lose a pixel or two');
  assert.equal(viewportCoversScreen({ ...full, innerWidth: 1917 }), false);
  assert.equal(viewportCoversScreen(short), false);
  assert.equal(viewportCoversScreen({ ...full, innerHeight: 1040 }), false, 'a taskbar-height gap is not covered');
});

test('a covered output on its own display is never touched', () => {
  assert.deepEqual(plan({ report: full }), { action: 'none', covered: true });
  assert.deepEqual(plan({ report: full, corrections: MAX_CORRECTIONS }), { action: 'none', covered: true },
    'a window that came good stays good even after the correction budget is spent');
});

test('a short Windows output is re-seated, then compensated, then left alone with a warning', () => {
  assert.deepEqual(plan(), { action: 'reseat', covered: false, bounds: target, fullscreen: true });
  assert.deepEqual(plan({ corrections: 1 }), { action: 'reseat', covered: false, bounds: target, fullscreen: true });
  assert.deepEqual(plan({ corrections: 2 }), {
    action: 'compensate', covered: false,
    bounds: { x: 2560, y: 0, width: 2880, height: 1620 },
  }, 'bounds grow by exactly the measured shortfall (1920/1280 = 1.5)');
  assert.deepEqual(plan({ corrections: MAX_CORRECTIONS }), { action: 'give-up', covered: false });
});

test('a full-size window on the wrong display is moved, not enlarged', () => {
  assert.deepEqual(plan({ report: full, onTargetDisplay: false }),
    { action: 'reseat', covered: false, bounds: target, fullscreen: true });
  assert.equal(plan({ report: full, onTargetDisplay: false, corrections: 2 }).action, 'reseat');
});

test('compensation is bounded and never shrinks a window', () => {
  const tiny = plan({ corrections: 2, report: { ...full, innerWidth: 100, innerHeight: 100 } });
  assert.deepEqual(tiny.bounds, { x: 2560, y: 0, width: 7680, height: 4320 }, 'capped at four times');
  const wide = plan({ corrections: 2, report: { ...full, innerWidth: 1920, innerHeight: 720 } });
  assert.deepEqual(wide.bounds, { x: 2560, y: 0, width: 1920, height: 1620 }, 'only the short side grows');
});

test('leaving fullscreen keeps the display covered without forcing fullscreen back', () => {
  // Esc is also Stop All: pressing it on the output must not shrink the picture.
  assert.deepEqual(plan({ fullscreenWanted: false }),
    { action: 'reseat', covered: false, bounds: target, fullscreen: false });
  assert.deepEqual(plan({ fullscreenWanted: false, report: full }), { action: 'none', covered: true });
});

test('platforms other than Windows are measured but left alone', () => {
  assert.deepEqual(plan({ platform: 'darwin' }), { action: 'none', covered: false },
    'a notched Mac display reports a short viewport legitimately');
  assert.deepEqual(plan({ platform: 'linux' }), { action: 'none', covered: false });
  assert.deepEqual(plan({ report: null }), { action: 'none', covered: false });
});

// ---- One display and no other ----------------------------------------------
// The output must sit exactly on its display: an output that is too big, or
// shifted, is showing on a second screen.
const over = { ...full, innerWidth: 2880, innerHeight: 1620 };
// A display to the left of the target, edge to edge with it.
const neighbour = { x: 640, y: 0, width: 1920, height: 1080 };
const shifted = { ...target, x: target.x - 300 };

test('a window bigger than its screen is measured as reaching past it', () => {
  assert.equal(viewportExceedsScreen(full), false);
  assert.equal(viewportExceedsScreen({ ...full, innerWidth: 1922, innerHeight: 1081 }), false,
    'fractional scaling can add a pixel or two');
  assert.equal(viewportExceedsScreen({ ...full, innerWidth: 1923 }), true);
  assert.equal(viewportExceedsScreen({ ...full, innerHeight: 1090 }), true);
  assert.equal(viewportExceedsScreen(short), false);
});

test('a window is on another display when more than a rounding sliver of it is there', () => {
  assert.equal(spillsOntoOtherDisplay(target, [neighbour]), false, 'edge to edge is not on it');
  assert.equal(spillsOntoOtherDisplay({ ...target, x: target.x - 6 }, [neighbour]), false, 'a rounding sliver');
  assert.equal(spillsOntoOtherDisplay(shifted, [neighbour]), true);
  assert.equal(spillsOntoOtherDisplay({ ...target, width: 2880 }, [{ x: 4480, y: 0, width: 1920, height: 1080 }]), true,
    'too wide reaches the display on the other side');
  assert.equal(spillsOntoOtherDisplay(shifted, []), false);
});

test('an output bigger than its display is put back on every platform', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.deepEqual(plan({ platform, report: over }),
      { action: 'reseat', covered: false, bounds: target, fullscreen: true }, platform);
  }
});

test('an output reaching onto a second display is put back even when its size is right', () => {
  for (const platform of ['win32', 'darwin']) {
    assert.deepEqual(plan({ platform, report: full, windowBounds: shifted, otherBounds: [neighbour] }),
      { action: 'reseat', covered: false, bounds: target, fullscreen: true }, platform);
    assert.deepEqual(plan({ platform, report: full, windowBounds: { ...target, x: target.x - 6 }, otherBounds: [neighbour] }),
      { action: 'none', covered: true }, 'a rounding sliver is left alone');
  }
});

test('an output on the wrong display is moved on a Mac as well as on Windows', () => {
  assert.deepEqual(plan({ platform: 'darwin', report: full, onTargetDisplay: false }),
    { action: 'reseat', covered: false, bounds: target, fullscreen: true });
});

test('Linux cannot always see where a window is, so only its size is acted on there', () => {
  // Under Wayland a window does not know its own position.
  assert.deepEqual(plan({ platform: 'linux', report: full, onTargetDisplay: false }), { action: 'none', covered: false });
  assert.deepEqual(plan({ platform: 'linux', report: full, windowBounds: shifted, otherBounds: [neighbour] }),
    { action: 'none', covered: true });
});

test('a misplaced output gets two tries in fullscreen, two by plain bounds, then the operator is told', () => {
  const tries = [0, 1, 2, 3].map(corrections => plan({ platform: 'darwin', report: over, corrections }));
  assert.deepEqual(tries.map(attempt => attempt.action), ['reseat', 'reseat', 'reseat', 'reseat']);
  assert.deepEqual(tries.map(attempt => attempt.fullscreen), [true, true, false, false],
    'in case fullscreen itself is what puts it there');
  assert.deepEqual(plan({ platform: 'darwin', report: over, corrections: 4 }),
    { action: 'give-up', covered: false, misplaced: true });
});

test('an enlargement that overshoots is undone, never left across two screens', () => {
  // The third correction for a short Windows output enlarges the window.
  assert.deepEqual(plan({ corrections: MAX_CORRECTIONS, report: over, windowBounds: { ...target, width: 2880, height: 1620 } }),
    { action: 'reseat', covered: false, bounds: target, fullscreen: false });
  assert.deepEqual(plan({ corrections: MAX_CORRECTIONS + 1, report: short }), { action: 'give-up', covered: false },
    'back to its own display, short, with the warning');
});

// ---- The wiring in main.js, run against a fake window and clock ------------
// Executes the real functions from main.js; only the OS-facing objects are faked.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
const mainAst = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const wiredFunctions = new Set(['resetVideoOutputGeometry', 'videoOutputTargetDisplay',
  'recordVideoOutputGeometry', 'evaluateVideoOutputGeometry', 'reportVideoOutputViewport']);
const wiring = mainAst.statements.filter(node =>
  (ts.isFunctionDeclaration(node) && wiredFunctions.has(node.name?.text)) ||
  (ts.isVariableStatement(node) && node.declarationList.declarations.every(declaration =>
    /^(videoOutputGeometry|newVideoOutputGeometry|VIDEO_OUTPUT_GEOMETRY_FILENAME)$/.test(declaration.name.getText(mainAst)))))
  .map(node => node.getText(mainAst)).join('\n')
  + '\n;globalThis.geometryState = () => videoOutputGeometry;';

function outputRig(platform = 'win32', { extraDisplays = [] } = {}) {
  let now = 0;
  let timers = [];
  const laptop = { id: 1, label: 'Laptop', bounds: { x: 0, y: 0, width: 1707, height: 1067 },
    size: { width: 1707, height: 1067 }, workArea: { x: 0, y: 0, width: 1707, height: 1019 }, scaleFactor: 1.5 };
  const projector = { id: 2, label: 'Projector', bounds: { ...target }, size: { width: 1920, height: 1080 },
    workArea: { ...target }, scaleFactor: 1 };
  const written = [];
  const calls = [];
  const state = { bounds: { ...target }, fullscreen: true, statusBroadcasts: 0 };
  const window = {
    videoOutputTargetDisplayId: projector.id,
    isDestroyed: () => false,
    getBounds: () => ({ ...state.bounds }),
    getContentSize: () => [state.bounds.width, state.bounds.height],
    isFullScreen: () => state.fullscreen,
    setBounds(bounds) { calls.push(['setBounds', bounds.width, bounds.height]); state.bounds = { ...bounds }; },
    setFullScreen(on) { calls.push(['setFullScreen', on]); state.fullscreen = on; },
  };
  const context = {
    planGeometryCorrection, readViewportReport, usesNativeFullscreen, path, JSON, Date,
    console: { warn() {}, error() {}, log() {} },
    process: { platform, versions: { electron: 'test' } },
    app: { getPath: () => '/profile', getVersion: () => '0.0.0-test' },
    fs: { writeFileSync: (file, body) => written.push({ file, record: JSON.parse(body) }) },
    screen: {
      getAllDisplays: () => [laptop, projector, ...extraDisplays],
      getPrimaryDisplay: () => laptop,
      getDisplayMatching: bounds => (bounds.x >= projector.bounds.x ? projector : laptop),
    },
    setTimeout(callback, delay) { const timer = { callback, at: now + delay }; timers.push(timer); return timer; },
    clearTimeout(timer) { timers = timers.filter(candidate => candidate !== timer); },
    requireVideoOutputIpc() {},
    broadcastVideoOutputStatus() { state.statusBroadcasts += 1; },
    videoOutputWindow: window,
  };
  vm.runInNewContext(wiring, context);
  context.resetVideoOutputGeometry(true);
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter(timer => timer !== due);
      now = due.at;
      due.callback();
    }
    now = end;
  };
  // One measurement from the page, then long enough for it to be judged and applied.
  const report = (viewport) => { context.reportVideoOutputViewport({}, viewport); advance(1000); };
  return { context, window, calls, written, state, report, advance, geometry: () => context.geometryState() };
}

test('a covered physical output is measured once, recorded, and never moved', () => {
  const rig = outputRig();
  rig.report(full);
  rig.report(full);
  assert.deepEqual(rig.calls, []);
  assert.equal(rig.written.length, 1, 'the healthy measurement is recorded once per window');
  assert.equal(rig.written[0].record.outcome, 'covered');
  assert.equal(rig.written[0].file, path.join('/profile', 'video-output-geometry.json'));
  assert.equal(rig.geometry().uncovered, false);
});

test('a short Windows output is re-seated on its display and fullscreen is restored', () => {
  const rig = outputRig();
  rig.report(short);
  assert.deepEqual(rig.calls, [
    ['setFullScreen', false], ['setBounds', 1920, 1080], ['setBounds', 1920, 1080], ['setFullScreen', true],
  ], 'leave fullscreen, place twice, re-enter');
  assert.equal(rig.geometry().busy, false, 'the next measurement is judged afresh');
  rig.report(full);
  assert.equal(rig.written.at(-1).record.outcome, 'covered-after-correction');
  assert.equal(rig.written.at(-1).record.corrections.length, 1, 'the record says what was done');
  assert.equal(rig.geometry().uncovered, false);
});

test('an output that stays short is compensated once, then left alone with a warning', () => {
  const rig = outputRig();
  rig.report(short);
  rig.report(short);
  rig.calls.length = 0;
  rig.report(short);
  assert.deepEqual(rig.calls, [['setFullScreen', false], ['setBounds', 2880, 1620], ['setBounds', 2880, 1620]],
    'third attempt covers the display with enlarged plain bounds and no fullscreen');
  rig.calls.length = 0;
  rig.report(short);
  rig.report(short);
  assert.deepEqual(rig.calls, [], 'no further changes to an audience window');
  assert.equal(rig.geometry().uncovered, true);
  assert.equal(rig.written.at(-1).record.outcome, 'not-covered');
  assert.ok(rig.state.statusBroadcasts >= 1, 'the operator is told');
  rig.report(full);
  assert.equal(rig.geometry().uncovered, false, 'the warning clears if it comes good');
});

test('measurements during a correction are not acted on twice', () => {
  const rig = outputRig();
  rig.context.reportVideoOutputViewport({}, short);
  rig.advance(450);                       // judged; correction in flight
  rig.context.reportVideoOutputViewport({}, short);
  rig.context.reportVideoOutputViewport({}, short);
  rig.advance(100);
  assert.equal(rig.geometry().corrections, 1);
  assert.equal(rig.calls.filter(call => call[0] === 'setFullScreen' && call[1] === false).length, 1);
});

test('other platforms and the preview window are measured but never moved', () => {
  const mac = outputRig('darwin');
  mac.report(short);
  assert.deepEqual(mac.calls, []);
  assert.equal(mac.geometry().uncovered, false, 'no warning for a legitimately short viewport');
  assert.equal(mac.written[0].record.outcome, 'short-not-corrected-on-this-platform');

  const preview = outputRig();
  delete preview.window.videoOutputTargetDisplayId;
  preview.report(short);
  assert.deepEqual(preview.calls, []);
  assert.equal(preview.written.length, 0);
});

test('a Mac output that is too big is put back by plain bounds, with no fullscreen Space', () => {
  const rig = outputRig('darwin');
  rig.state.fullscreen = false;                 // a Mac output is never in native fullscreen
  rig.report(over);
  assert.deepEqual(rig.calls, [['setBounds', 1920, 1080], ['setBounds', 1920, 1080]]);
  rig.report(full);
  assert.equal(rig.written.at(-1).record.outcome, 'covered-after-correction');
  assert.equal(rig.geometry().uncovered, false);
});

test('an output that cannot be kept to its display is reported, with what was measured', () => {
  const rig = outputRig('darwin');
  rig.state.fullscreen = false;
  for (let attempt = 0; attempt < 6; attempt += 1) rig.report(over);
  assert.equal(rig.geometry().corrections, 4, 'four tries, then no more changes to an audience window');
  assert.equal(rig.geometry().uncovered, true, 'the operator is warned');
  assert.equal(rig.written.at(-1).record.outcome, 'on-another-screen');
});

test('a Windows enlargement that overshoots is taken back to the display', () => {
  const rig = outputRig();
  rig.report(short);
  rig.report(short);
  rig.report(short);                            // enlarged to 2880x1620
  rig.calls.length = 0;
  rig.report(over);                             // and now it is bigger than the screen
  assert.deepEqual(rig.calls, [['setBounds', 1920, 1080], ['setBounds', 1920, 1080]],
    'back to the display itself, without fullscreen');
  rig.calls.length = 0;
  rig.report(short);
  assert.deepEqual(rig.calls, []);
  assert.equal(rig.geometry().uncovered, true);
  assert.equal(rig.written.at(-1).record.outcome, 'not-covered');
});

test('an enlargement that worked is not mistaken for an overlap', () => {
  // Enlarged logical bounds reach over the next display's logical area, but
  // the page reports the truth: the picture exactly fills its own screen.
  const rightOf = { id: 3, label: 'Stage', bounds: { x: 4480, y: 0, width: 1920, height: 1080 },
    size: { width: 1920, height: 1080 }, workArea: { x: 4480, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
  const rig = outputRig('win32', { extraDisplays: [rightOf] });
  rig.report(short);
  rig.report(short);
  rig.report(short);
  rig.calls.length = 0;
  rig.report(full);
  assert.deepEqual(rig.calls, [], 'left exactly as it is');
  assert.equal(rig.written.at(-1).record.outcome, 'covered-after-correction');
  assert.equal(rig.geometry().uncovered, false);
});

test('a malformed measurement is rejected before it can move a window', () => {
  const rig = outputRig();
  assert.throws(() => rig.context.reportVideoOutputViewport({}, { ...short, innerWidth: -5 }), /Invalid viewport/);
  rig.advance(1000);
  assert.deepEqual(rig.calls, []);
});

// ---- Escape on the audience display ----------------------------------------
function fullscreenHandler(platform = 'win32') {
  const statement = mainAst.statements.find(node => ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    node.expression.expression.getText(mainAst) === 'ipcMain.handle' &&
    node.expression.arguments[0]?.text === 'video-output:set-fullscreen');
  assert.ok(statement, 'missing video-output:set-fullscreen handler in Electron main process');
  let handler;
  const calls = [];
  const outputPage = { name: 'output page' };
  const controlPage = { name: 'control page' };
  const context = {
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    requireTrustedIpc() {},
    broadcastVideoOutputStatus: () => 'status',
    setOutputFullscreen, process: { platform },
    videoOutputWindow: {
      webContents: outputPage, isDestroyed: () => false,
      setFullScreen: on => calls.push(on),
      setSimpleFullScreen: on => calls.push(`simple:${on}`),
    },
  };
  vm.runInNewContext(statement.getText(mainAst), context);
  return { handler, calls, outputPage, controlPage, window: context.videoOutputWindow };
}

test('Escape on an audience display never takes the picture out of fullscreen', () => {
  const audience = fullscreenHandler();
  audience.window.videoOutputTargetDisplayId = 2;
  assert.equal(audience.handler({ sender: audience.outputPage }, false), 'status');
  assert.deepEqual(audience.calls, [], 'the output page asks only for its Escape key; Stop All must not shrink the show');
  audience.handler({ sender: audience.controlPage }, false);
  assert.deepEqual(audience.calls, [false], 'the operator can still leave fullscreen from the control window');
  audience.handler({ sender: audience.outputPage }, true);
  assert.deepEqual(audience.calls, [false, true], 'entering fullscreen is always allowed');

  const preview = fullscreenHandler();
  preview.handler({ sender: preview.outputPage }, false);
  assert.deepEqual(preview.calls, [false], 'the single-screen preview window keeps Escape-to-leave');
});

test('on a Mac no fullscreen request opens a fullscreen Space', () => {
  // A fullscreen Space blanks every other display when macOS is set to share
  // one Space across displays.
  const audience = fullscreenHandler('darwin');
  audience.window.videoOutputTargetDisplayId = 2;
  audience.handler({ sender: audience.outputPage }, true);
  audience.handler({ sender: audience.controlPage }, true);
  audience.handler({ sender: audience.controlPage }, false);
  assert.deepEqual(audience.calls, [], 'the audience output already covers its display and stays as it is');

  const preview = fullscreenHandler('darwin');
  preview.handler({ sender: preview.outputPage }, true);
  preview.handler({ sender: preview.outputPage }, false);
  assert.deepEqual(preview.calls, ['simple:true', 'simple:false'], 'the preview covers only the screen it is on');
});
