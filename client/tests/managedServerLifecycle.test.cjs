const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Execute the real manager with a fake OS; no app, server, signals or profile writes.
const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set(['validManagedAccessToken', 'isPidAlive', 'healthMatchesIdentity',
  'commandLineHasArgPair', 'sameExecutablePath', 'processInfoHasArgPair', 'processRunsOwnedServer',
  'adoptLiveplayIdentity', 'sameLiveplayIdentity', 'clearLiveplayIdentity', 'verifyLiveplayLock',
  'waitForCrashReplacement', 'reconcileLiveplayServerIdentity', 'startLiveplayServer',
  'startLiveplayServerOnce', 'pollPidfileForServerPid', 'terminateLiveplayPid',
  'stopVerifiedLiveplayServer', 'stopLiveplayServer', 'liveplayServerStatus', 'notifyServerStateChange']);
const managerSource = ast.statements.filter(node =>
  (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) ||
  (ts.isVariableStatement(node) && node.declarationList.declarations.every(
    declaration => declaration.name.getText(ast).startsWith('liveplayServer'))))
  .map(node => node.getText(ast)).join('\n');

function fixture(platform = 'darwin') {
  let now = 1000;
  let nextPid = 100;
  let inspectionFails = false;
  const children = new Map();
  const killCallbacks = [];
  const executable = '/fixture/server-bin/dwcue-server';
  const context = {
    LIVEPLAY_DEFAULT_PORT: 4480, path, crypto: require('node:crypto'),
    app: { isPackaged: true }, mainWindow: null, cartPlayerWindow: null, videoOutputWindow: null,
    console: { log() {}, warn() {}, error() {} }, Date: { now: () => now },
    setTimeout(callback, ms) { now += ms; queueMicrotask(callback); },
    process: { platform, env: {}, kill(pid, signal) {
      if (!children.has(pid)) throw Object.assign(new Error('missing process'), { code: 'ESRCH' });
      if (signal === 'SIGINT' || signal === 'SIGKILL') children.delete(pid);
    } },
    fs: { existsSync: () => true, realpathSync: value => value },
    readLiveplayConfig: () => ({ mode: 'local', localPort: 4480 }),
    liveplayLockPath: () => '/fixture/profile/liveplay-server.lock',
    readLiveplayLock: () => null, resolveServerBinaryPath: () => executable,
    probeServerHealth: async () => null,
    inspectServerProcess: async (pid) => {
      if (inspectionFails) throw new Error('process probe unavailable');
      return { executable, args: children.get(pid).args };
    },
    processRunsLegacyServer: async () => false, isLegacyServerHealth: () => false,
    spawn(binary, args) {
      const child = { pid: nextPid++, args, once() {}, unref() {} };
      children.set(child.pid, child); return child;
    },
    execFile(file, args, options, callback) {
      if (typeof options === 'function') { callback = options; options = {}; }
      if (options.timeout > 0) queueMicrotask(() => callback(new Error('timed out')));
      else killCallbacks.push(callback);
    },
  };
  vm.runInNewContext(managerSource, context);
  return { context, children, setInspectionFailure(value) { inspectionFails = value; },
    releaseKill() { for (const callback of killCallbacks.splice(0)) callback(null); } };
}

test('a live startup without a pidfile remains owned after the readiness timeout', async () => {
  const { context, children } = fixture();
  assert.equal(await context.startLiveplayServer(), null, 'unhealthy child is not ready');
  const pid = children.keys().next().value;
  assert.equal(context.liveplayServerStatus().pid, pid, 'launched child remains controllable');
  await context.startLiveplayServer();
  assert.equal(children.size, 1, 'retry cannot launch a second engine beside the live child');
  assert.equal(await context.stopLiveplayServer(), true);
  assert.equal(children.size, 0, 'explicit Stop terminates the owned startup');
  assert.equal(context.liveplayServerStatus().pid, null);
});

test('an unavailable ownership probe cannot lose a live startup or allow a second engine', async () => {
  const f = fixture();
  await f.context.startLiveplayServer();
  f.setInspectionFailure(true);
  await f.context.startLiveplayServer();
  assert.equal(f.children.size, 1, 'verification failure must hold instead of spawning');
  assert.equal(await f.context.stopLiveplayServer(), false, 'unverified process is not signaled');
  assert.equal(f.children.size, 1);
  f.setInspectionFailure(false);
  assert.equal(await f.context.stopLiveplayServer(), true, 'ownership can be verified and stopped later');
  assert.equal(f.children.size, 0);
});

test('Windows termination settles if taskkill hangs and retains a surviving owned PID', async () => {
  const f = fixture('win32');
  await f.context.startLiveplayServer();
  // Identity is seeded explicitly so this check isolates the OS-command deadline.
  const pid = f.children.keys().next().value;
  const child = f.children.get(pid);
  f.context.adoptLiveplayIdentity({ pid, port: 4480,
    instanceToken: child.args[child.args.indexOf('--instance-token') + 1], accessToken: 'a'.repeat(64) });
  let settled = false;
  const stop = f.context.stopLiveplayServer().then(value => { settled = true; return value; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, true, 'native command timeout must settle the control request');
    assert.equal(await stop, false, 'a surviving server cannot be reported stopped');
    assert.equal(f.children.size, 1);
    assert.equal(f.context.liveplayServerStatus().pid, pid);
  } finally { f.releaseKill(); await stop; }
});
