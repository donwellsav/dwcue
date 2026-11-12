'use strict';

// Isolated Electron lifecycle check: no show server, installed app or saved settings.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');

async function runElectronFixture() {
  const { app, BrowserWindow, View, ipcMain, powerSaveBlocker, screen } = require('electron');
  const root = process.env.DWCUE_RECOVERY_FIXTURE;
  app.setPath('userData', path.join(root, 'profile'));
  await app.whenReady();
  const vm = require('node:vm');
  const ts = require('typescript');
  const source = fs.readFileSync(process.env.DWCUE_ELECTRON_SOURCE || path.join(__dirname, '../client/electron/main.js'), 'utf8');
  const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = ast.statements.filter(ts.isFunctionDeclaration);
  const names = ['sanitizeVideoPlaybackErrorMessage', 'loadVideoOutputWindow', 'failVideoOutputRenderer', 'markVideoOutputReady',
    'restartVideoOutputWindow', 'requireVideoOutputIpc', 'startVideoOutputFrames',
    'stopVideoOutputFrames', 'createVideoOutputWindow', 'closeVideoOutputWindow',
    'orderedVideoOutputDisplays', 'videoOutputDisplays', 'closeDisplayIdentifierWindows',
    'escapeDisplayIdentifierText', 'identifyVideoOutputDisplays'];
  const fixturePath = path.join(root, 'output.html');
  fs.writeFileSync(fixturePath, '<!doctype html><title>Isolated output recovery test</title><body style="background:#900"></body>');
  let operator;
  const context = {
    BrowserWindow: function (options) {
      const win = new BrowserWindow(options);
      win.loadFile = () => BrowserWindow.prototype.loadFile.call(win, fixturePath, { query: { videoOutput: '1' } });
      return win;
    }, View, path, __dirname: path.join(__dirname, '../client/electron'), isDevMode: false,
    readVideoOutputConfig: () => ({}), resolveVideoOutputDisplay: () => null,
    screen, powerSaveBlocker, displayIdentifierWindows: [], displayIdentifierTimer: null,
    videoOutputWindow: null, videoOutputSessionEnabled: true, videoOutputPowerSaveId: null,
    videoOutputPlaybackError: null, videoOutputTestCardConnection: null, videoOutputFrameTimer: null,
    videoOutputRendererReady: false, videoOutputRendererResponsive: true,
    videoOutputRecoveryRequired: false, videoOutputRestarting: false, videoOutputDiagnostics: [], URL,
    videoOutputWindowsPreservingSession: new WeakSet(),
    testCardPlayback: { update: async () => {} }, reconcileTestCardPlayback() {},
    shouldForwardVideoOutputShortcut: () => false, showVideoOutputContextMenu() {},
    videoOutputStatus: () => ({ open: !!context.videoOutputWindow, recoveryRequired: context.videoOutputRecoveryRequired }),
    broadcastVideoOutputStatus: () => context.videoOutputStatus(),
    console, Date, setInterval, clearInterval, setTimeout, clearTimeout,
  };
  vm.runInNewContext(functions.filter(node => names.includes(node.name?.text))
    .map(node => node.getText(ast)).join('\n'), context);
  ipcMain.handle('video-output:identify-displays', context.identifyVideoOutputDisplays);
  if (context.markVideoOutputReady) ipcMain.handle('video-output:renderer-ready', context.markVideoOutputReady);
  try {
    operator = new BrowserWindow({ show: false, webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: path.join(__dirname, '../client/electron/preload.js'),
    } });
    await operator.loadFile(fixturePath);
    context.mainWindow = operator;
    context.createVideoOutputWindow();
    const output = context.videoOutputWindow;
    if (output.webContents.isLoading()) await once(output.webContents, 'did-finish-load');
    assert.notEqual(output.webContents.getOSProcessId(), operator.webContents.getOSProcessId(), 'output renderer isolated from operator');
    if (context.markVideoOutputReady) await output.webContents.executeJavaScript('window.electronAPI.videoOutput.rendererReady()');

    const dockVisible = app.dock?.isVisible();
    const identify = () => operator.webContents.executeJavaScript('window.electronAPI.videoOutput.identifyDisplays()');
    const displays = await identify();
    assert.equal(app.dock?.isVisible(), dockVisible, 'identifying displays must preserve Dock visibility');
    const firstIdentifiers = [...context.displayIdentifierWindows];
    await identify();
    assert.ok(firstIdentifiers.every(win => win.isDestroyed()), 'repeated identification replaces earlier overlays');
    const identifiers = context.displayIdentifierWindows;
    assert.equal(identifiers.length, displays.length);
    await Promise.all(identifiers.map(win => win.isVisible() ? undefined : once(win, 'show')));
    assert.ok(identifiers.every(win => !win.isFocused()), 'labels must not take keyboard focus');
    await Promise.all(identifiers.map(win => once(win, 'closed')));
    assert.equal(app.dock?.isVisible(), dockVisible);
    assert.equal(context.videoOutputWindow, output, 'identification leaves the audience window open');

    const gone = once(output.webContents, 'render-process-gone');
    output.webContents.forcefullyCrashRenderer();
    await gone;
    assert.equal(output.isDestroyed(), false, 'crashing picture must retain the native audience window');
    assert.equal(context.videoOutputWindow, output);
    assert.equal(output.videoOutputCover.getVisible(), true);
    assert.ok(output.contentView.children.includes(output.videoOutputCover));
    const [width, height] = output.getContentSize();
    assert.deepEqual(output.videoOutputCover.getBounds(), { x: 0, y: 0, width, height });
    assert.equal(context.videoOutputSessionEnabled, true);
    assert.equal(powerSaveBlocker.isStarted(context.videoOutputPowerSaveId), true);
    assert.equal(await operator.webContents.executeJavaScript('1 + 1'), 2);
    await context.restartVideoOutputWindow();
    assert.equal(context.videoOutputWindow, output, 'restart reuses native display surface');
    assert.equal(output.videoOutputCover.getVisible(), true, 'covered during hydration');
    await output.webContents.executeJavaScript('window.electronAPI.videoOutput.rendererReady()');
    assert.equal(output.videoOutputCover.getVisible(), false);

    // Restart must also work before Electron has detected an unresponsive loop.
    void output.webContents.executeJavaScript('while (true) {}').catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 150));
    await context.restartVideoOutputWindow();
    assert.equal(context.videoOutputWindow, output);
    assert.equal(output.videoOutputCover.getVisible(), true);
    assert.equal(await operator.webContents.executeJavaScript('2 + 2'), 4);
    await output.webContents.executeJavaScript('window.electronAPI.videoOutput.rendererReady()');
    assert.equal(output.videoOutputCover.getVisible(), false);
    process.stdout.write('Native cover retained across actual renderer crash and busy-loop restart; operator responsive.\n');
  } finally {
    context.closeDisplayIdentifierWindows();
    context.closeVideoOutputWindow();
    operator?.destroy();
    app.quit();
  }
}

if (process.versions.electron) {
  runElectronFixture().catch(error => { console.error(error); require('electron').app.exit(1); });
} else {
  const { test } = require('node:test');
  const { spawn } = require('node:child_process');
  const os = require('node:os');
  test('display labels preserve app access and the audience window survives renderer failures', { timeout: 45000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dwcue-output-recovery-'));
    const env = { ...process.env, DWCUE_RECOVERY_FIXTURE: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [__filename], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 40000);
    try {
      const [code] = await once(child, 'exit');
      assert.equal(code, 0, output);
      assert.match(output, /operator responsive/);
      console.log(output.split('\n').filter(line => line.startsWith('Native cover')).join('\n'));
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill('SIGKILL');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
