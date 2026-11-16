const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  MAX_CORRECTIONS,
  planGeometryCorrection,
  readViewportReport,
  viewportCoversScreen,
} = require('../electron/video-output-geometry.js');

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

function outputRig(platform = 'win32') {
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
    planGeometryCorrection, readViewportReport, path, JSON, Date,
    console: { warn() {}, error() {}, log() {} },
    process: { platform, versions: { electron: 'test' } },
    app: { getPath: () => '/profile', getVersion: () => '0.0.0-test' },
    fs: { writeFileSync: (file, body) => written.push({ file, record: JSON.parse(body) }) },
    screen: {
      getAllDisplays: () => [laptop, projector],
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

test('a malformed measurement is rejected before it can move a window', () => {
  const rig = outputRig();
  assert.throws(() => rig.context.reportVideoOutputViewport({}, { ...short, innerWidth: -5 }), /Invalid viewport/);
  rig.advance(1000);
  assert.deepEqual(rig.calls, []);
});

// ---- Escape on the audience display ----------------------------------------
function fullscreenHandler() {
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
    videoOutputWindow: {
      webContents: outputPage, isDestroyed: () => false,
      setFullScreen: on => calls.push(on),
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
