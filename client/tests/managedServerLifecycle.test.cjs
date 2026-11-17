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
  'stopVerifiedLiveplayServer', 'stopLiveplayServer', 'stopLiveplayServerOnce', 'runLiveplayServerOperation', 'liveplayServerStatus', 'notifyServerStateChange',
  // Self-recovery: stale locks, a busy port, and a server that stopped answering.
  'discardStaleLiveplayIdentity', 'launchLiveplayServerWithFallback', 'launchLiveplayServerProcess',
  'awaitLiveplayServerHealthy', 'ensureLiveplayServerRunning',
  // An engine left running by the previous version, and the release build's self-test flag.
  'replaceOutdatedIdleEngine', 'ensureCurrentEngineRunning', 'engineSelfTestResultPath']);
const managerSource = ast.statements.filter(node =>
  (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) ||
  (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
    node.expression.expression.getText(ast) === 'ipcMain.handle' &&
    ['liveplay-server:restart', 'liveplay-server:shutdown', 'liveplay-server:set-config']
      .includes(node.expression.arguments[0]?.text)) ||
  (ts.isVariableStatement(node) && node.declarationList.declarations.every(
    declaration => /^(liveplayServer|engineUpdate|LIVEPLAY_SERVER_IMAGE_NAMES$|LIVEPLAY_REPLACEMENT_APPEAR_MS$)/
      .test(declaration.name.getText(ast)))))
  .map(node => node.getText(ast)).join('\n');

// `script` says what each launched server does, in launch order: 'healthy'
// publishes its lock and answers, 'mute' publishes its lock but never answers,
// 'decline' ends itself with status 1 as it does for a busy port. With no
// script a server stays alive without a lock (the original fixture behaviour).
// `versions` gives the version each launched server reports, in launch order
// (the app's own version when it runs out).
const APP_VERSION = '2.7.0';
function fixture(platform = 'darwin', { script = [], taskkillWorks = false, versions = [] } = {}) {
  let now = 1000;
  let nextPid = 100;
  let inspectionFails = false;
  let lock = null;
  let predatesBoot = false;
  let logError = '';
  let config = { mode: 'local', remoteUrl: 'http://127.0.0.1:4480', localPort: 4480, configuredLocalPort: 4480 };
  const children = new Map();
  const handlers = new Map();
  const killCallbacks = [];
  const foreign = new Map();      // live processes that are not ours: pid -> program name
  const signalled = [];           // anything other than an existence check sent to them
  const removedLocks = [];
  const configWrites = [];
  const answering = new Set();
  const busyPorts = new Set();     // ports another program is already serving
  const engineVersions = new Map();
  const engineUse = { hasOpenProject: false, audioLoading: false, playing: [] };
  const lockPath = '/fixture/profile/liveplay-server.lock';
  const executable = '/fixture/server-bin/dwcue-server';
  const context = {
    ipcMain: { handle(name, handler) { handlers.set(name, handler); } }, requireTrustedIpc() {},
    LIVEPLAY_DEFAULT_PORT: 4480, path, crypto: require('node:crypto'),
    app: { isPackaged: true, getVersion: () => APP_VERSION },
    mainWindow: null, detachedQuickPlayWindow: null, videoOutputWindow: null,
    fetchEngineSummary: async (port) => {
      if (!lock || lock.port !== port || !answering.has(lock.pid)) return null;
      return { server: { version: engineVersions.get(lock.pid) },
        project: { hasOpenProject: engineUse.hasOpenProject, audioLoading: engineUse.audioLoading },
        playing: [...engineUse.playing] };
    },
    console: { log() {}, warn() {}, error() {} }, Date: { now: () => now },
    setTimeout(callback, ms) { now += ms; queueMicrotask(callback); },
    process: { platform, env: {}, kill(pid, signal) {
      if (foreign.has(pid)) { if (signal !== 0) signalled.push([pid, signal]); return; }
      if (!children.has(pid)) throw Object.assign(new Error('missing process'), { code: 'ESRCH' });
      if (signal === 'SIGINT' || signal === 'SIGKILL') { children.delete(pid); answering.delete(pid); }
    } },
    fs: { existsSync: () => true, realpathSync: value => value,
      rmSync(file) { removedLocks.push(file); if (file === lockPath) lock = null; } },
    URL,
    readLiveplayConfig: () => ({ ...config }),
    writeLiveplayConfig(next) {
      config = { mode: next.mode, remoteUrl: next.remoteUrl, localPort: next.localPort,
        configuredLocalPort: next.configuredLocalPort ?? next.localPort };
      configWrites.push({ ...config });
    },
    liveplayLockPath: () => lockPath,
    readLiveplayLock: () => (lock ? { ...lock } : null), resolveServerBinaryPath: () => executable,
    probeServerHealth: async (port) => {
      const pid = lock && lock.port === port && answering.has(lock.pid) ? lock.pid : null;
      return pid ? { ok: true, name: 'dwcue-server', pid, instanceToken: lock.instanceToken } : null;
    },
    processImageName: async (pid) => foreign.get(pid) ?? (children.has(pid) ? 'dwcue-server' : null),
    liveplayLockPredatesBoot: () => predatesBoot,
    findFreeLoopbackPort: async () => 51234,
    isLoopbackPortFree: async (port) => !busyPorts.has(port),
    lastLiveplayServerLogError: () => logError,
    inspectServerProcess: async (pid) => {
      if (inspectionFails) throw new Error('process probe unavailable');
      return { executable, args: children.get(pid).args };
    },
    processRunsLegacyServer: async () => false, isLegacyServerHealth: () => false,
    spawn(binary, args, options) {
      const listeners = {};
      const child = { pid: nextPid++, args, once(event, listener) { listeners[event] = listener; }, unref() {} };
      children.set(child.pid, child);
      engineVersions.set(child.pid, versions.shift() ?? APP_VERSION);
      const behaviour = script.shift();
      const option = flag => args[args.indexOf(flag) + 1];
      if (behaviour === 'healthy' || behaviour === 'mute') {
        lock = { pid: child.pid, port: Number(option('--port')), startedAt: 1,
          instanceToken: option('--instance-token'), accessToken: options.env.LIVEPLAY_ACCESS_TOKEN };
        if (behaviour === 'healthy') answering.add(child.pid);
      } else if (behaviour === 'decline') {
        queueMicrotask(() => { children.delete(child.pid); listeners.exit?.(1); });
      }
      return child;
    },
    execFile(file, args, options, callback) {
      if (typeof options === 'function') { callback = options; options = {}; }
      if (file === 'taskkill.exe' && taskkillWorks) {
        const pid = Number(args[args.indexOf('/pid') + 1]);
        children.delete(pid); answering.delete(pid);
        queueMicrotask(() => callback(null));
      } else if (options.timeout > 0) queueMicrotask(() => callback(new Error('timed out')));
      else killCallbacks.push(callback);
    },
  };
  vm.runInNewContext(managerSource, context);
  return { context, children, handlers, foreign, signalled, removedLocks, configWrites, lockPath, busyPorts, engineUse,
    now: () => now, config: () => ({ ...config }), lock: () => lock,
    setConfig(next) { config = { ...config, ...next }; },
    setLock(next) { lock = next; }, setPredatesBoot(value) { predatesBoot = value; },
    setLogError(value) { logError = value; },
    portOf(pid) { const args = children.get(pid).args; return Number(args[args.indexOf('--port') + 1]); },
    setInspectionFailure(value) { inspectionFails = value; },
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


test('shutdown cannot acknowledge before an older paused restart and leave its engine running', async () => {
  const f = fixture();
  await f.context.startLiveplayServer();
  const stopVerified = f.context.stopVerifiedLiveplayServer;
  let calls = 0;
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  f.context.stopVerifiedLiveplayServer = async (...args) => {
    const stopped = await stopVerified(...args);
    if (++calls === 1) { entered(); await gate; }
    return stopped;
  };
  const restart = f.handlers.get('liveplay-server:restart')({});
  await waiting;
  let shutdownSettled = false;
  const shutdown = f.handlers.get('liveplay-server:shutdown')({}).then(value => {
    shutdownSettled = true; return value;
  });
  await new Promise(resolve => setImmediate(resolve));
  const acknowledgedEarly = shutdownSettled;
  release();
  await restart;
  assert.equal(await shutdown, true);
  assert.equal(acknowledgedEarly, false, 'shutdown must drain prior lifecycle actions before acknowledging');
  assert.equal(f.children.size, 0, 'an older restart cannot spawn after the final shutdown');
  assert.equal(f.context.liveplayServerStatus().pid, null);
});


test('a later explicit Start runs after a pending Shutdown', async () => {
  const f = fixture();
  await f.context.startLiveplayServer();
  const old = f.context.liveplayServerStatus().pid;
  const shutdown = f.context.stopLiveplayServer();
  const start = f.context.startLiveplayServer();
  assert.equal(await shutdown, true);
  await start;
  assert.equal(f.children.size, 1);
  assert.notEqual(f.context.liveplayServerStatus().pid, old);
  assert.equal(await f.context.stopLiveplayServer(), true);
});

test('a failed lifecycle action releases the queue for an explicit retry', async () => {
  const f = fixture();
  const reconcile = f.context.reconcileLiveplayServerIdentity;
  f.context.reconcileLiveplayServerIdentity = async () => { throw new Error('fixture failure'); };
  await assert.rejects(f.context.startLiveplayServer(), /fixture failure/);
  f.context.reconcileLiveplayServerIdentity = reconcile;
  await f.context.startLiveplayServer();
  assert.equal(f.children.size, 1);
  assert.equal(await f.context.stopLiveplayServer(), true);
});


test('a late status probe cannot return the identity of an engine already shut down', async () => {
  const f = fixture();
  await f.context.startLiveplayServer();
  const identity = f.context.liveplayServerStatus();
  const child = f.children.get(identity.pid);
  const token = child.args[child.args.indexOf('--instance-token') + 1];
  let release;
  let entered;
  let first = true;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  f.context.probeServerHealth = async () => {
    if (!first) return null;
    first = false; entered(); await gate;
    return { pid: identity.pid, instanceToken: token };
  };
  const status = f.context.reconcileLiveplayServerIdentity();
  await waiting;
  assert.equal(await f.context.stopLiveplayServer(), true);
  release();
  assert.equal(await status, null);
  assert.equal(f.context.liveplayServerStatus().pid, null);
});

// ---- Recovering without a person ------------------------------------------
const leftover = (pid) => ({ pid, port: 4480, startedAt: 1,
  instanceToken: 'ab'.repeat(16), accessToken: 'cd'.repeat(32) });

test('a leftover lock whose process id now belongs to another program no longer blocks the launch', async () => {
  const f = fixture('win32', { script: ['healthy'] });
  f.setLock(leftover(4242));
  f.foreign.set(4242, 'svchost.exe');
  const identity = await f.context.startLiveplayServer();
  assert.equal(f.children.size, 1, 'the server is launched');
  assert.equal(identity.pid, [...f.children.keys()][0]);
  assert.deepEqual(f.removedLocks, [f.lockPath], 'the stale lock is removed, not left to block the next launch');
  assert.deepEqual(f.signalled, [], 'the other program is never signalled');
});

test('a leftover lock that may still be our own server keeps blocking a second engine', async () => {
  for (const program of ['dwcue-server.exe', 'liveplay-server.exe', null]) {
    const f = fixture('win32', { script: ['healthy'] });
    f.setLock(leftover(4242));
    f.foreign.set(4242, program);
    assert.equal(await f.context.startLiveplayServer(), null);
    assert.equal(f.children.size, 0, `no launch beside ${program ?? 'an unreadable process'}`);
    assert.deepEqual(f.removedLocks, []);
    assert.deepEqual(f.signalled, []);
  }
});

test('a lock from before the last system start is discarded whatever now holds its process id', async () => {
  const f = fixture('win32', { script: ['healthy'] });
  f.setLock(leftover(4242));
  f.foreign.set(4242, null);          // its name cannot even be read
  f.setPredatesBoot(true);
  assert.ok(await f.context.startLiveplayServer());
  assert.equal(f.children.size, 1);
  assert.deepEqual(f.removedLocks, [f.lockPath]);
});

test('a server that will not start on the configured port is moved to a free one', async () => {
  const f = fixture('win32', { script: ['decline', 'healthy'] });
  const before = f.now();
  const identity = await f.context.startLiveplayServer();
  assert.equal(identity.port, 51234, 'the server runs on the free port');
  assert.equal(f.children.size, 1, 'the one that declined is gone; exactly one engine runs');
  assert.equal(f.portOf(identity.pid), 51234);
  assert.deepEqual(f.config(), { mode: 'local', remoteUrl: 'http://127.0.0.1:4480',
    localPort: 51234, configuredLocalPort: 4480 }, 'the operator\'s own port is remembered for next time');
  assert.equal(f.context.liveplayServerStatus().pid, identity.pid);
  assert.ok(f.now() - before < 4000, 'no waiting out the clock on a server that already ended');
});

test('the next fresh launch returns to the configured port', async () => {
  const f = fixture('darwin', { script: ['healthy'] });
  f.setConfig({ localPort: 51234, configuredLocalPort: 4480 });
  const identity = await f.context.startLiveplayServer();
  assert.equal(identity.port, 4480);
  assert.equal(f.config().localPort, 4480);
});

test('a server that will not start anywhere leaves the configuration as it was', async () => {
  const f = fixture('win32', { script: ['decline', 'decline'] });
  assert.equal(await f.context.startLiveplayServer(), null);
  assert.equal(f.children.size, 0);
  assert.equal(f.config().localPort, 4480);
  assert.equal(f.config().configuredLocalPort, 4480);
  assert.equal(f.context.liveplayServerStatus().pid, null, 'an ended server is not tracked as running');
});

test('saving settings while on a fallback port does not make it the configured port', async () => {
  const f = fixture('darwin', { script: ['healthy', 'healthy'] });
  f.setConfig({ localPort: 51234, configuredLocalPort: 4480 });
  await f.handlers.get('liveplay-server:set-config')({}, { mode: 'local', localPort: 51234 });
  assert.equal(f.configWrites[0].configuredLocalPort, 4480, 'the port the operator chose survives the save');
  await f.handlers.get('liveplay-server:set-config')({}, { localPort: 5000 });
  assert.equal(f.config().configuredLocalPort, 5000, 'a different port is a new choice');
  assert.equal(f.config().localPort, 5000);
});

test('a running server that stops answering is restarted once, without a restart of the computer', async () => {
  const f = fixture('darwin', { script: ['mute', 'healthy'] });
  const ready = await f.context.ensureLiveplayServerRunning();
  assert.equal(ready.ok, true);
  assert.match(ready.accessToken, /^[0-9a-f]{64}$/);
  assert.equal(f.children.size, 1, 'the unresponsive server was stopped before its replacement started');
  assert.equal(f.context.liveplayServerStatus().pid, [...f.children.keys()][0]);
});

test('an unresponsive server is restarted only once, then the failure is reported', async () => {
  const f = fixture('darwin', { script: ['mute', 'mute'] });
  const ready = await f.context.ensureLiveplayServerRunning();
  assert.equal(ready.ok, false);
  assert.equal(ready.error, 'it did not respond in time');
  assert.equal(f.children.size, 1, 'no pile of servers is left behind');
});

test('a failed start reports what the server itself said, without waiting out the clock', async () => {
  const f = fixture('win32', { script: ['decline', 'decline'] });
  f.setLogError('Audio engine failed to start.');
  const before = f.now();
  const ready = await f.context.ensureLiveplayServerRunning();
  // The result comes from another realm; compare its plain contents.
  assert.equal(JSON.stringify(ready), JSON.stringify(
    { ok: false, port: 4480, error: 'it reported: Audio engine failed to start.' }));
  assert.ok(f.now() - before < 8000, 'nothing is waited for once every launch has ended');
});

test('a readiness result carries the port the server is really on', async () => {
  const f = fixture('win32', { script: ['decline', 'healthy'] });
  const ready = await f.context.ensureLiveplayServerRunning();
  assert.equal(ready.ok, true);
  assert.equal(ready.port, 51234, 'the window connects where the server moved to');
});

test('stopping the server removes its lock even when it had to be ended by force', async () => {
  const f = fixture('win32', { script: ['healthy'], taskkillWorks: true });
  await f.context.startLiveplayServer();
  assert.ok(f.lock(), 'the running server holds its lock');
  assert.equal(await f.context.stopLiveplayServer(), true);
  assert.equal(f.children.size, 0);
  assert.equal(f.lock(), null, 'no lock is left to name whatever program inherits the process id');
});

test('a port another program is already serving is never launched on', async () => {
  const f = fixture('win32', { script: ['healthy'] });
  f.busyPorts.add(4480);
  const identity = await f.context.startLiveplayServer();
  assert.equal(f.children.size, 1, 'one launch, straight onto the free port');
  assert.equal(f.portOf(identity.pid), 51234);
  assert.equal(identity.port, 51234);
  assert.equal(f.config().configuredLocalPort, 4480);
});

test('several windows asking at once replace an unresponsive server only once', async () => {
  const f = fixture('darwin', { script: ['mute', 'healthy', 'healthy', 'healthy'] });
  const results = await Promise.all([
    f.context.ensureLiveplayServerRunning(),
    f.context.ensureLiveplayServerRunning(),
    f.context.ensureLiveplayServerRunning(),
  ]);
  assert.deepEqual(results.map(result => result.ok), [true, true, true]);
  assert.equal(new Set(results.map(result => result.accessToken)).size, 1, 'every window gets the same server');
  assert.equal(f.children.size, 1);
  assert.equal([...f.children.keys()][0], 101, 'exactly one replacement was launched');
});

test('an idle engine left running by the previous version is replaced with this version', async () => {
  const f = fixture('darwin', { script: ['healthy', 'healthy'], versions: ['2.6.24'] });
  await f.context.startLiveplayServer();                      // the old engine, already running
  const ready = await f.context.ensureCurrentEngineRunning();
  assert.equal(ready.ok, true);
  assert.deepEqual([...f.children.keys()], [101], 'the old engine was stopped and one new engine started');
  assert.equal(f.context.liveplayServerStatus().pid, 101);
});

for (const [what, use] of [
  ['has a show open', { hasOpenProject: true }],
  ['is loading audio', { audioLoading: true }],
  ['is playing', { playing: [{ itemUuid: 'cue' }] }],
]) {
  test(`an older engine that ${what} is never interrupted`, async () => {
    const f = fixture('darwin', { script: ['healthy', 'healthy'], versions: ['2.6.24'] });
    Object.assign(f.engineUse, use);
    await f.context.startLiveplayServer();
    const ready = await f.context.ensureCurrentEngineRunning();
    assert.equal(ready.ok, true);
    assert.deepEqual([...f.children.keys()], [100], 'the engine in use keeps running');
    // Once it is idle again, the next request replaces it.
    Object.assign(f.engineUse, { hasOpenProject: false, audioLoading: false, playing: [] });
    assert.equal((await f.context.ensureCurrentEngineRunning()).ok, true);
    assert.deepEqual([...f.children.keys()], [101]);
  });
}

test('an engine of this version is left alone', async () => {
  const f = fixture('darwin', { script: ['healthy', 'healthy'] });
  await f.context.startLiveplayServer();
  assert.equal((await f.context.ensureCurrentEngineRunning()).ok, true);
  assert.equal((await f.context.ensureCurrentEngineRunning()).ok, true);
  assert.deepEqual([...f.children.keys()], [100]);
});

test('an installation whose own engine reports another version is restarted once, not in a loop', async () => {
  const f = fixture('darwin', { script: ['healthy', 'healthy', 'healthy'], versions: ['2.6.24', '2.6.24', '2.6.24'] });
  await f.context.startLiveplayServer();
  assert.equal((await f.context.ensureCurrentEngineRunning()).ok, true);
  assert.equal((await f.context.ensureCurrentEngineRunning()).ok, true);
  assert.deepEqual([...f.children.keys()], [101], 'one replacement, then it is accepted as it is');
});

test('several windows asking at once replace an outdated engine only once', async () => {
  const f = fixture('darwin', { script: ['healthy', 'healthy', 'healthy', 'healthy'], versions: ['2.6.24'] });
  await f.context.startLiveplayServer();
  const results = await Promise.all([
    f.context.ensureCurrentEngineRunning(),
    f.context.ensureCurrentEngineRunning(),
    f.context.ensureCurrentEngineRunning(),
  ]);
  assert.deepEqual(results.map(result => result.ok), [true, true, true]);
  assert.equal(new Set(results.map(result => result.accessToken)).size, 1, 'every window gets the same engine');
  assert.deepEqual([...f.children.keys()], [101]);
});

test('the engine self-test only accepts an absolute result file', () => {
  const { engineSelfTestResultPath } = fixture().context;
  assert.equal(engineSelfTestResultPath(['app', '--engine-self-test=/tmp/result.json']), '/tmp/result.json');
  assert.equal(engineSelfTestResultPath(['app', '--engine-self-test=result.json']), null);
  assert.equal(engineSelfTestResultPath(['app', '--engine-self-test=']), null);
  assert.equal(engineSelfTestResultPath(['app', '--smoke-quit']), null);
});
