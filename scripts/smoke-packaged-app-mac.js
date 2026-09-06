#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('node:net');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

if (typeof WebSocket === 'undefined') {
  const child = spawnSync(process.execPath, ['--experimental-websocket', __filename, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(child.status ?? 1);
}

const STARTUP_TIMEOUT_MS = 20_000;
const QUIT_TIMEOUT_MS = 10_000;
const POLL_MS = 250;
const REPO_ROOT = path.resolve(__dirname, '..');
const clientPackage = require(path.join(REPO_ROOT, 'client', 'package.json'));
const productName = clientPackage.build.productName;
const bundleId = clientPackage.build.appId;
const archEqualsArg = process.argv.find((arg) => arg.startsWith('--arch='));
const archFlagIndex = process.argv.indexOf('--arch');
const archArg = archEqualsArg?.split('=', 2)[1]
  || (archFlagIndex >= 0 ? process.argv[archFlagIndex + 1] : undefined);
const requestedArch = archArg || (process.arch === 'x64' ? 'x64' : 'arm64');
if (!['arm64', 'x64'].includes(requestedArch)) {
  throw new Error(`--arch must be arm64 or x64, received: ${requestedArch}`);
}
// electron-builder keeps the Intel unpacked app in `mac/` and suffixes the
// Apple Silicon app as `mac-arm64/`.
const appOutputDir = requestedArch === 'x64' ? 'mac' : 'mac-arm64';
const appPath = path.join(
  REPO_ROOT,
  'client',
  clientPackage.build.directories.output,
  appOutputDir,
  `${productName}.app`,
);
const executable = path.join(appPath, 'Contents', 'MacOS', productName);
const prefix = '[smoke-packaged-app-mac]';

function run(command, args, timeout = 5_000) {
  return spawnSync(command, args, { encoding: 'utf8', timeout });
}

function canUseUiScripting() {
  const result = run('/usr/bin/osascript', [
    '-e',
    'tell application "System Events" to UI elements enabled',
  ]);
  if (result.status === 0) return result.stdout.trim() === 'true';
  const message = (result.stderr || result.error?.message || '').trim();
  // ETIMEDOUT: osascript/UI scripting wedges under runner load (has blocked
  // releases on both mac legs); the window check is best-effort by design,
  // so a wedged probe degrades to "skipped" exactly like unauthorized does.
  if (/ETIMEDOUT|not authorized|not allowed assistive access|-1719|-1743/i.test(message)) {
    return false;
  }
  throw new Error(`Could not inspect macOS UI scripting: ${message || 'unknown error'}`);
}

function runningPid() {
  const result = run('/usr/bin/pgrep', ['-x', productName], 2_000);
  if (result.status === 1) return null;
  if (result.status !== 0) {
    throw new Error(`Could not inspect running apps: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  const pids = result.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  if (pids.length !== 1 || !Number.isInteger(pids[0])) {
    throw new Error(`Expected one ${productName} process, found ${pids.length}.`);
  }
  return pids[0];
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(POLL_MS);
  }
  return null;
}

function windowInfo(pid) {
  const result = run('/usr/bin/osascript', [
    '-e',
    `tell application "System Events" to get {visible, count windows} of (first process whose unix id is ${pid})`,
  ], 2_000);
  if (result.status !== 0) {
    const message = (result.stderr || result.error?.message || '').trim();
    // ETIMEDOUT: transient UI-scripting wedge — poll again instead of dying.
    if (/can't get|can’t get|not found|-1728|ETIMEDOUT/i.test(message)) return null;
    throw new Error(`Could not inspect startup window: ${message || 'unknown error'}`);
  }
  const match = /^(true|false), (\d+)$/.exec(result.stdout?.trim());
  if (!match) {
    throw new Error(`Unexpected startup-window response: ${result.stdout.trim() || '(empty)'}`);
  }
  return { visible: match[1] === 'true', count: Number(match[2]) };
}

async function verifyManagedWebSocket(debugPort) {
  const lockPath = path.join(
    process.env.DWCUE_USERDATA || path.join(os.homedir(), 'Library', 'Application Support', 'LivePlay'),
    'liveplay-server.lock',
  );
  const identity = await waitUntil(() => {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      return Number.isInteger(lock.port) && /^[0-9a-f]{64}$/.test(lock.accessToken || '') ? lock : null;
    } catch { return null; }
  }, STARTUP_TIMEOUT_MS);
  if (!identity) throw new Error('Managed server did not provide a connection credential.');
  const target = await waitUntil(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(2000) });
      const targets = await response.json();
      return targets.find(page => page.type === 'page' && page.url.startsWith('file://'));
    } catch { return null; }
  }, STARTUP_TIMEOUT_MS);
  if (!target) throw new Error('Packaged renderer did not expose its debugging target.');
  const expectedUrl = `ws://127.0.0.1:${identity.port}/ws?access_token=${identity.accessToken}`;
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    const requests = new Set();
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Actual renderer WebSocket did not connect.')), STARTUP_TIMEOUT_MS);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Network.enable' })));
    socket.addEventListener('error', () => finish(new Error('Renderer debugging connection failed.')));
    socket.addEventListener('close', () => finish(new Error('Renderer exited before its WebSocket connected.')));
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id === 1 && !message.error) {
        socket.send(JSON.stringify({ id: 2, method: 'Page.reload', params: { ignoreCache: true } }));
      } else if (message.error) finish(new Error('Renderer debugging command failed.'));
      const params = message.params;
      if (message.method === 'Network.webSocketCreated' && params.url === expectedUrl) requests.add(params.requestId);
      if (!params || !requests.has(params.requestId)) return;
      if (message.method === 'Network.webSocketHandshakeResponseReceived') {
        finish(params.response.status === 101 ? null : new Error(`Renderer WebSocket rejected with HTTP ${params.response.status}.`));
      } else if (message.method === 'Network.webSocketFrameError') {
        finish(new Error('Actual renderer WebSocket handshake failed.'));
      }
    });
  });
  console.log(`${prefix} connection: actual packaged renderer WebSocket accepted`);
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('This check only runs on macOS.');
  if (!fs.statSync(appPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Built app not found: ${path.relative(REPO_ROOT, appPath)}`);
  }
  fs.accessSync(executable, fs.constants.X_OK);
  console.log(`${prefix} app: ${path.relative(REPO_ROOT, appPath)}`);

  const lipo = run('/usr/bin/lipo', ['-archs', executable]);
  if (lipo.status !== 0) {
    throw new Error(`Could not inspect app architecture: ${(lipo.stderr || lipo.error?.message || '').trim()}`);
  }
  const architectures = lipo.stdout.trim();
  const expectedMachOArch = requestedArch === 'x64' ? 'x86_64' : 'arm64';
  if (architectures !== expectedMachOArch) {
    throw new Error(`Expected a ${requestedArch} app, found: ${architectures || 'no architecture'}`);
  }
  console.log(`${prefix} architecture: ${requestedArch}`);

  if (runningPid()) throw new Error(`${productName} is already running; quit it and retry.`);
  const debugPort = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });

  let appPid;
  try {
    // --smoke-quit: main.js skips the interactive quit-confirmation veto for
    // this launch, since the app's quit flow shows renderer dialogs that need
    // a human (local-server prompt appears whenever a local server runs).
    const launch = run('/usr/bin/open', ['-n', appPath, '--args', '--smoke-quit', `--remote-debugging-port=${debugPort}`]);
    if (launch.status !== 0) {
      throw new Error(`Launch Services failed: ${(launch.stderr || launch.error?.message || '').trim()}`);
    }

    appPid = await waitUntil(runningPid, STARTUP_TIMEOUT_MS);
    if (!appPid) throw new Error('App did not start; its single-instance lock may already be held.');

    // ponytail: System Events is enough for a one-window smoke; use a UI
    // test runner only if startup behavior grows beyond counting windows.
    if (canUseUiScripting()) {
      let windows = await waitUntil(() => windowInfo(appPid), STARTUP_TIMEOUT_MS);
      if (!windows) throw new Error('Expected one visible startup window, found none.');
      windows = await waitUntil(() => {
        if (!isRunning(appPid)) throw new Error('App exited during startup.');
        const current = windowInfo(appPid);
        if (current?.count > 1) throw new Error(`Expected one startup window, found ${current.count}.`);
        return current?.visible && current.count === 1 ? current : null;
      }, STARTUP_TIMEOUT_MS);
      if (!windows) throw new Error('Expected one visible startup window, found none.');
      console.log(`${prefix} windows: 1 visible`);
    } else {
      await delay(3_000);
      if (!isRunning(appPid)) throw new Error('App exited during startup.');
      console.log(`${prefix} windows: skipped (macOS UI scripting is unavailable)`);
    }

    await delay(1_000);
    if (!isRunning(appPid)) throw new Error('App exited during startup.');
    console.log(`${prefix} launch: running; startup lock did not force an early exit`);
    await verifyManagedWebSocket(debugPort);

    const quit = run('/usr/bin/osascript', ['-e', `tell application id "${bundleId}" to quit`]);
    if (quit.status !== 0) process.kill(appPid, 'SIGTERM');
    if (!await waitUntil(() => !isRunning(appPid), QUIT_TIMEOUT_MS)) {
      throw new Error('App did not quit within 10 seconds.');
    }
    console.log(`${prefix} quit: ${quit.status === 0 ? 'clean' : 'terminated and cleaned up'}`);
  } finally {
    if (appPid && isRunning(appPid)) {
      process.kill(appPid, 'SIGTERM');
      if (!await waitUntil(() => !isRunning(appPid), 2_000)) {
        process.kill(appPid, 'SIGKILL');
      }
    }
  }
}

main().catch((error) => {
  console.error(`${prefix} ${error.message}`);
  process.exitCode = 1;
});
