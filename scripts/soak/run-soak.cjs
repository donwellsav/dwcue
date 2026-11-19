#!/usr/bin/env node
'use strict';

// Soak test and benchmarks for the packaged macOS app, with nothing shown and
// nothing audible.
//
//   node scripts/soak/run-soak.cjs soak  --output "<silent output>" [--minutes 240] [--seed 1]
//   node scripts/soak/run-soak.cjs bench --output "<silent output>" [--launches 5] [--cues 300]
//   node scripts/soak/run-soak.cjs probe --output "<silent output>"
//
// The app is started paused under the Node inspector, its windows are made
// unable to show and the app unable to take the Dock or menu bar, and it is
// then driven as an operator would drive it (GO, QuickPlays, Stop All, Show
// Mode, Video Output) while this script records what the engine, the app and
// the operating system report. Results go to soak-results/<run>/.
//
// `--output` names an output device that makes no sound in the room (a virtual
// device). The run refuses the system default output, and stops at once if
// sound ever reaches it. See scripts/README.md.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { writeSoakShow, writeLargeShow } = require('./soak-show.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const clientPackage = require(path.join(REPO, 'client', 'package.json'));
const PRODUCT = clientPackage.build.productName;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const [mode, ...rest] = process.argv.slice(2);
const option = (name, fallback) => {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 && rest[at + 1] !== undefined ? rest[at + 1] : fallback;
};
const flag = name => rest.includes(`--${name}`);
if (!['soak', 'bench', 'probe', 'summarize'].includes(mode)) {
  console.error('usage: run-soak.cjs soak|bench|probe --output "<silent output device>" [options]\n'
    + '       run-soak.cjs summarize --results <folder>');
  process.exit(2);
}
if (process.platform !== 'darwin') {
  console.error('This harness hides the app the macOS way; it is not written for this platform yet.');
  process.exit(2);
}
const OUTPUT = option('output', '');
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const RESULTS = path.resolve(option('results', path.join(REPO, 'soak-results', `${mode}-${stamp}`)));
const APP = path.resolve(option('app', path.join(REPO, 'client', clientPackage.build.directories.output,
  process.arch === 'x64' ? 'mac' : 'mac-arm64', `${PRODUCT}.app`)));
const EXECUTABLE = path.join(APP, 'Contents', 'MacOS', PRODUCT);

// ---------------------------------------------------------------------------
// Small tools
// ---------------------------------------------------------------------------
const now = () => performance.now();
const round = (value, places = 1) => (Number.isFinite(value) ? Number(value.toFixed(places)) : null);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

function connect(url) {
  const socket = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  const listeners = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
    else listeners.forEach(listener => listener(message));
  };
  const opened = new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error(`cannot connect to ${url}`)); });
  socket.onclose = () => { for (const resolve of waiting.values()) resolve({ error: { message: 'connection closed' } }); waiting.clear(); };
  const send = (method, params = {}) => new Promise((resolve) => {
    if (socket.readyState !== WebSocket.OPEN) { resolve({ error: { message: 'connection closed' } }); return; }
    waiting.set(++id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { socket, opened, send, on: listener => listeners.push(listener), close: () => { try { socket.close(); } catch { /* gone */ } } };
}

async function debugTarget(port, wanted, timeoutMs = 60000, everyMs = 25) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const found = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(wanted);
      if (found) return found;
    } catch { /* not listening yet */ }
    await delay(everyMs);
  }
  throw new Error(`no debugging target on port ${port}`);
}

const jsonl = file => (record) => fs.appendFileSync(file, `${JSON.stringify(record)}\n`);

// ---------------------------------------------------------------------------
// The hidden app
// ---------------------------------------------------------------------------
// Runs in the main process before its first line. Windows can never show, the
// app never takes the Dock or menu bar, and a native dialog is answered with
// its cancel button and recorded instead of appearing on screen.
const HIDE = `(() => {
  const electron = require('electron');
  const { app, BrowserWindow, BaseWindow, dialog } = electron;
  for (const proto of [BrowserWindow.prototype, BaseWindow.prototype]) {
    for (const name of ['show', 'showInactive', 'focus', 'moveTop', 'maximize', 'setFullScreen', 'setSimpleFullScreen']) proto[name] = function () {};
  }
  app.focus = function () {};
  app.setActivationPolicy?.('accessory');
  app.on('ready', () => { app.setActivationPolicy?.('accessory'); app.dock?.hide(); });
  app.on('browser-window-created', (_event, window) => window.webContents.setBackgroundThrottling(false));
  const soak = globalThis.__soak = { electron, dialogs: [], gone: [] };
  const note = (name, options) => soak.dialogs.push({ at: Date.now(), name,
    message: String((options && (options.message || options.title)) || options || '').slice(0, 300) });
  const pick = options => ({ response: Number.isInteger(options?.cancelId) ? options.cancelId : 0, checkboxChecked: false });
  dialog.showMessageBox = async (...args) => { const options = args[args.length - 1]; note('showMessageBox', options); return pick(options); };
  dialog.showMessageBoxSync = (...args) => { const options = args[args.length - 1]; note('showMessageBoxSync', options); return pick(options).response; };
  dialog.showErrorBox = (title, content) => note('showErrorBox', { message: title + ': ' + content });
  dialog.showOpenDialog = async () => { note('showOpenDialog'); return { canceled: true, filePaths: [] }; };
  dialog.showSaveDialog = async () => { note('showSaveDialog'); return { canceled: true }; };
  app.on('render-process-gone', (_event, contents, details) => soak.gone.push({ at: Date.now(), kind: 'renderer', url: contents.getURL().slice(-60), reason: details.reason }));
  app.on('child-process-gone', (_event, details) => soak.gone.push({ at: Date.now(), kind: details.type, reason: details.reason, name: details.name || '' }));
  return 'hidden';
})()`;

async function launchHidden({ profile, recents = [], log }) {
  fs.mkdirSync(profile, { recursive: true });
  const [inspectPort, debugPort, enginePort] = [await freePort(), await freePort(), await freePort()];
  const serverConfig = path.join(profile, 'liveplay-server.json');
  if (!fs.existsSync(serverConfig)) {
    fs.writeFileSync(serverConfig, JSON.stringify({ mode: 'local', remoteUrl: `http://127.0.0.1:${enginePort}`, localPort: enginePort }));
  }
  fs.writeFileSync(path.join(profile, 'liveplay-recent-projects.json'), JSON.stringify(recents));
  const out = fs.openSync(log, 'a');
  const spawnedAt = now();
  const child = spawn(EXECUTABLE, [`--inspect-brk=${inspectPort}`, `--remote-debugging-port=${debugPort}`, '--smoke-quit'],
    { env: { ...process.env, DWCUE_USERDATA: profile }, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal, at: Date.now() }; });

  const readLock = () => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'liveplay-server.lock'), 'utf8')); } catch { return null; } };
  const quit = async () => {
    const lock = readLock();
    if (!exited) child.kill();
    for (let i = 0; i < 60 && !exited; i += 1) await delay(250);
    if (!exited) { child.kill('SIGKILL'); await delay(500); }
    // The engine outlives a killed app; it belongs to this run alone.
    if (lock?.pid) { try { process.kill(lock.pid); } catch { /* already gone */ } }
    await delay(500);
  };

  try {
    const main = connect((await debugTarget(inspectPort, t => t.type === 'node')).webSocketDebuggerUrl);
    await main.opened;
    const paused = new Promise(resolve => main.on((m) => { if (m.method === 'Debugger.paused') resolve(m.params); }));
    await main.send('Runtime.enable');
    await main.send('Debugger.enable');
    await main.send('Runtime.runIfWaitingForDebugger');
    const frame = (await paused).callFrames[0];
    const hidden = await main.send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: HIDE });
    if (hidden.result?.result?.value !== 'hidden') throw new Error(`could not hide the app: ${JSON.stringify(hidden.result ?? hidden.error)}`);
    const resumedAt = now();
    await main.send('Debugger.resume');
    await main.send('Debugger.disable');

    const mainEval = async (expression) => {
      const reply = await main.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (reply.error || reply.result?.exceptionDetails) throw new Error(reply.error?.message || reply.result.exceptionDetails.exception?.description || 'main evaluation failed');
      return reply.result.result.value;
    };
    const openPage = async (wanted, timeoutMs = 60000) => {
      const page = connect((await debugTarget(debugPort, wanted, timeoutMs)).webSocketDebuggerUrl);
      await page.opened;
      const evaluate = async (expression) => {
        const reply = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (reply.error) throw new Error(reply.error.message);
        if (reply.result.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description ?? JSON.stringify(reply.result.exceptionDetails));
        return reply.result.result.value;
      };
      const until = async (expression, what, timeoutMs2 = 50000, everyMs = 100) => {
        const deadline = now() + timeoutMs2;
        while (now() < deadline) {
          if (await evaluate(`(() => { try { return ${expression}; } catch { return false; } })()`).catch(() => false)) return now();
          await delay(everyMs);
        }
        const seen = await evaluate(`(document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 400)`).catch(error => String(error));
        throw new Error(`timed out waiting for ${what}; the page shows: ${seen}`);
      };
      return { ...page, evaluate, until };
    };
    const isMain = t => t.type === 'page' && /index\.html/.test(t.url) && !/quickPlayWindow|videoOutput|manual/i.test(t.url);
    return {
      child, profile, spawnedAt, resumedAt, mainEval, openPage, isMain, readLock, quit,
      exited: () => exited, main,
    };
  } catch (error) {
    await quit();
    throw error;
  }
}

async function engineClient(app, timeoutMs = 60000) {
  const deadline = now() + timeoutMs;
  let lock = null;
  while (now() < deadline && !(lock = app.readLock())?.accessToken) await delay(100);
  if (!lock?.accessToken) throw new Error('the local engine did not start');
  const base = `http://127.0.0.1:${lock.port}`;
  const get = async (route) => {
    const reply = await fetch(base + route, { headers: { Authorization: `Bearer ${lock.accessToken}` }, signal: AbortSignal.timeout(5000) });
    if (!reply.ok) throw new Error(`${route}: HTTP ${reply.status}`);
    return reply.json();
  };
  return { pid: lock.pid, port: lock.port, get, wsUrl: `ws://127.0.0.1:${lock.port}/ws?access_token=${lock.accessToken}` };
}

// Follows the engine's own broadcast: the latest level on every master
// channel, and how regularly the broadcast arrives.
function followMeters(engine) {
  const state = { frames: 0, lastAt: 0, maxGapMs: 0, masters: new Map(), open: false, closed: 0, programSince: 0 };
  let socket;
  let stopped = false;
  const open = () => {
    socket = new WebSocket(engine.wsUrl);
    socket.onopen = () => { state.open = true; state.lastAt = 0; };
    socket.onclose = () => { state.open = false; state.closed += 1; if (!stopped) setTimeout(open, 1000); };
    socket.onerror = () => {};
    socket.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type !== 'meters') return;
      const at = now();
      if (state.lastAt) state.maxGapMs = Math.max(state.maxGapMs, at - state.lastAt);
      state.lastAt = at;
      state.frames += 1;
      state.masters = new Map((message.master_channels ?? []).map(channel => [channel.index, channel.peak_db]));
    };
  };
  open();
  return {
    state,
    takeWindow() { const window = { frames: state.frames, maxGapMs: round(state.maxGapMs) }; state.frames = 0; state.maxGapMs = 0; return window; },
    level: index => state.masters.get(index) ?? -120,
    stop() { stopped = true; try { socket.close(); } catch { /* gone */ } },
  };
}

// ---------------------------------------------------------------------------
// What the operating system says about the app's processes
// ---------------------------------------------------------------------------
function processTable(app, enginePid) {
  const rows = execFileSync('ps', ['-axo', 'pid=,rss=,time=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n');
  const found = [];
  for (const row of rows) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d:.]+)\s+(.*)$/.exec(row);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[4];
    let role = null;
    if (pid === enginePid) role = 'engine';
    else if (pid === app.child.pid) role = 'main';
    else if (command.includes(`--user-data-dir=${app.profile}`)) {
      role = /--type=renderer/.test(command) ? 'renderer' : /--type=gpu-process/.test(command) ? 'gpu'
        : /--type=utility/.test(command) ? 'utility' : 'helper';
    }
    if (!role) continue;
    // ps prints cumulative CPU time as [hours:]minutes:seconds.hundredths.
    const cpuSeconds = match[3].split(':').map(Number).reduce((total, part) => total * 60 + part, 0);
    found.push({ pid, role, rssMb: round(Number(match[2]) / 1024), cpuSeconds });
  }
  return found;
}

// ---------------------------------------------------------------------------
// The operator: what a person would press, and whether it did what it should
// ---------------------------------------------------------------------------
const UI_STATE = `(() => {
  const text = el => (el?.innerText || '').replace(/\\s+/g, ' ').trim();
  return JSON.stringify({
    showMode: !!document.querySelector('.main-workspace.show-mode'),
    playing: [...document.querySelectorAll('.playlist-item.is-playing > .item-content .item-name')].map(text),
    upNext: text(document.querySelector('.play-next-btn')).slice(0, 90),
    quickPlaying: [...document.querySelectorAll('.quickplay-tile')].filter(t => t.querySelector('.quickplay-transport.is-stop')).map(t => text(t.querySelector('.quickplay-title'))),
    properties: !!document.querySelector('.properties-panel'),
    videoOpen: !!document.querySelector('.video-toggle--active'),
    warning: text(document.querySelector('.header-warning-line')).slice(0, 200),
    rows: document.querySelectorAll('.playlist-item').length,
  });
})()`;
const QUIET = `(() => { document.activeElement?.blur?.(); return true; })()`;
const ROW = `(name) => [...document.querySelectorAll('.playlist-item')].find(r => (r.querySelector(':scope > .item-content .item-name')?.innerText || '').trim() === name)`;
const TILE = `(name) => [...document.querySelectorAll('.quickplay-tile')].find(t => (t.querySelector('.quickplay-title')?.innerText || '').trim() === name)`;
const key = (name, code) => `(() => { document.activeElement?.blur?.(); document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, code: ${JSON.stringify(code)}, bubbles: true, cancelable: true })); document.dispatchEvent(new KeyboardEvent('keyup', { key: ${JSON.stringify(name)}, code: ${JSON.stringify(code)}, bubbles: true })); return true; })()`;

// ---------------------------------------------------------------------------
// Soak
// ---------------------------------------------------------------------------
async function runSoak({ minutes, seed, probe = false }) {
  if (!OUTPUT) throw new Error('--output "<silent output device>" is required');
  fs.mkdirSync(RESULTS, { recursive: true });
  const showFolder = path.join(REPO, 'soak-results', '_show');
  const show = writeSoakShow(showFolder, OUTPUT);
  const profile = path.join(RESULTS, 'profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const record = { sample: jsonl(path.join(RESULTS, 'samples.jsonl')), step: jsonl(path.join(RESULTS, 'steps.jsonl')),
    event: jsonl(path.join(RESULTS, 'events.jsonl')) };
  const startedAt = Date.now();
  const say = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);

  const app = await launchHidden({ profile, log: path.join(RESULTS, 'app-output.log'),
    recents: [{ path: show.file, name: show.name, folderPath: showFolder, lastOpened: Date.now(), localTrusted: true }] });
  let meters = null;
  let fatal = null;
  // Stopping the run stops the app it started.
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { fatal = fatal || `interrupted (${signal})`; });
  const failures = [];
  const fail = (kind, detail) => {
    const failure = { at: Date.now(), kind, ...detail };
    failures.push(failure);
    record.event({ type: 'failure', ...failure });
    say('FAILURE', kind, JSON.stringify(detail).slice(0, 300));
  };
  try {
    const page = await app.openPage(app.isMain);
    const windowAt = now();
    await page.send('Runtime.enable');
    await page.send('Performance.enable');
    const consoleErrors = [];
    page.on((message) => {
      if (message.method === 'Runtime.exceptionThrown') {
        const text = message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text;
        consoleErrors.push(text);
        record.event({ type: 'page-exception', at: Date.now(), text: String(text).slice(0, 600) });
      } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        const text = message.params.args.map(a => a.value ?? a.description ?? '').join(' ');
        consoleErrors.push(text);
        record.event({ type: 'page-console-error', at: Date.now(), text: text.slice(0, 600) });
      }
    });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 868, deviceScaleFactor: 1, mobile: false });
    const welcomeAt = await page.until(`/Using the audio engine on this computer/.test(document.body.innerText)`, 'the local engine on the welcome screen');
    const engine = await engineClient(app);
    record.event({ type: 'started', at: Date.now(), startMs: { window: round(windowAt - app.resumedAt), engineReady: round(welcomeAt - app.resumedAt) } });

    // The output must be a real device that is not the system default.
    const devices = await engine.get('/api/devices');
    const chosen = devices.find(device => device.display_name === OUTPUT);
    if (!chosen) throw new Error(`no output device named "${OUTPUT}". Found: ${devices.map(d => d.display_name).join(', ')}`);
    if (chosen.is_default && !flag('allow-default-output')) throw new Error(`"${OUTPUT}" is the system default output; the run would be audible`);

    const openClickAt = now();
    await page.evaluate(`[...document.querySelectorAll('button')].find(b => b.innerText.includes(${JSON.stringify(show.name)})).click()`);
    const rowsAt = await page.until(`document.querySelectorAll('.playlist-item').length >= ${show.cues.length}`, 'the show to open');
    let readyAt = null;
    for (const deadline = now() + 120000; now() < deadline;) {
      const progress = await engine.get('/api/project/progress').catch(() => null);
      const summary = await engine.get('/api/state/summary').catch(() => null);
      if (probe && !readyAt) { say('progress', JSON.stringify(progress).slice(0, 600)); }
      const cues = summary?.project?.audioLoading === false ? await engine.get('/api/cues').catch(() => []) : [];
      if (cues.length >= show.cues.length + show.quickPlays.length && cues.every(cue => cue.file_loaded)) { readyAt = now(); break; }
      await delay(100);
    }
    if (!readyAt) throw new Error('the show did not finish loading in two minutes');
    record.event({ type: 'opened', at: Date.now(), openMs: { rows: round(rowsAt - openClickAt), loaded: round(readyAt - openClickAt) } });
    say(`show open: rows ${round(rowsAt - openClickAt)} ms, loaded ${round(readyAt - openClickAt)} ms`);

    // The engine names a cue after its file; the show names it for the operator.
    const fileOf = cue => path.basename(cue.file_path || '');
    const cuesByFile = new Map((await engine.get('/api/cues')).map(cue => [fileOf(cue), cue]));
    const engineVersion = (await engine.get('/api/state/summary')).server?.version ?? null;
    meters = followMeters(engine);
    if (probe) {
      await delay(1500);
      say('devices', JSON.stringify(await engine.get('/api/devices')).slice(0, 1500));
      say('summary', JSON.stringify(await engine.get('/api/state/summary')).slice(0, 2500));
      say('cue', JSON.stringify((await engine.get('/api/cues'))[0]));
      say('windows', JSON.stringify(await app.mainEval(`__soak.electron.BrowserWindow.getAllWindows().map(w => ({ title: w.getTitle(), pid: w.webContents.getOSProcessId(), url: w.webContents.getURL().slice(-50) }))`)));
      say('processes', JSON.stringify(processTable(app, engine.pid)));
      say('meters open', meters.state.open, 'frames', meters.state.frames);
      say('ui', await page.evaluate(UI_STATE));
      say('metrics', JSON.stringify((await page.send('Performance.getMetrics')).result.metrics.filter(m => /JSHeapUsedSize|Nodes|JSEventListeners|Documents/.test(m.name))));
    }

    // ---- what is read, every fifteen seconds --------------------------------
    const logFile = path.join(profile, 'logs', 'dwcue-server.log');
    let logOffset = 0;
    const engineLogNews = () => {
      try {
        const size = fs.statSync(logFile).size;
        if (size <= logOffset) return [];
        const fd = fs.openSync(logFile, 'r');
        const chunk = Buffer.alloc(size - logOffset);
        fs.readSync(fd, chunk, 0, chunk.length, logOffset);
        fs.closeSync(fd);
        logOffset = size;
        return chunk.toString('utf8').split('\n').filter(line => /\[(WARNING|ERROR)\]/.test(line));
      } catch { return []; }
    };
    let videoPage = null;
    let lastCpu = new Map();
    let lastSampleAt = now();
    let sampleCount = 0;
    const heapOf = async (target) => {
      const metrics = Object.fromEntries((await target.send('Performance.getMetrics')).result.metrics.map(m => [m.name, m.value]));
      return { heapMb: round(metrics.JSHeapUsedSize / 1048576, 2), nodes: metrics.Nodes, listeners: metrics.JSEventListeners, documents: metrics.Documents };
    };
    const sample = async () => {
      sampleCount += 1;
      const at = now();
      const seconds = (at - lastSampleAt) / 1000;
      lastSampleAt = at;
      const windows = await app.mainEval(`__soak.electron.BrowserWindow.getAllWindows().map(w => [w.webContents.getOSProcessId(), /Video Output/.test(w.getTitle()) ? 'video' : /QuickPlay/i.test(w.getTitle()) ? 'quickplays' : 'main'])`).catch(() => []);
      const windowOf = new Map(windows);
      const processes = processTable(app, engine.pid).map((p) => {
        const before = lastCpu.get(p.pid);
        const role = p.role === 'renderer' ? `renderer-${windowOf.get(p.pid) ?? 'other'}` : p.role;
        return { ...p, role, cpuPercent: before === undefined ? null : round(100 * (p.cpuSeconds - before) / seconds) };
      });
      lastCpu = new Map(processes.map(p => [p.pid, p.cpuSeconds]));
      const collect = sampleCount % 20 === 0;   // every five minutes, after a collection
      if (collect) await page.send('HeapProfiler.collectGarbage');
      const entry = {
        t: round((Date.now() - startedAt) / 1000, 0), processes,
        page: await heapOf(page).catch(() => null), collected: collect,
        mainProcess: await app.mainEval(`(() => { const m = process.memoryUsage(); return { rssMb: m.rss / 1048576, heapMb: m.heapUsed / 1048576, externalMb: m.external / 1048576 }; })()`).catch(() => null),
        devices: (await engine.get('/api/devices').catch(() => [])).filter(d => d.is_open),
        meterWindow: meters.takeWindow(),
      };
      if (sampleCount % 4 === 0) {
        const cues = await engine.get('/api/cues').catch(() => []);
        entry.cues = { count: cues.length, readAheadUnderruns: cues.reduce((sum, cue) => sum + (cue.read_ahead_underruns || 0), 0),
          decodeErrors: cues.filter(cue => cue.decode_error).length };
        entry.native = await app.mainEval(`({ dialogs: __soak.dialogs.length, gone: __soak.gone.length, windows: __soak.electron.BrowserWindow.getAllWindows().length })`).catch(() => null);
      }
      if (videoPage) {
        entry.video = await videoPage.evaluate(`(() => { const v = document.querySelector('video'); if (!v) return null; const q = v.getVideoPlaybackQuality?.();
          return { source: (v.currentSrc || '').slice(-12), time: v.currentTime, paused: v.paused, total: q?.totalVideoFrames ?? null, dropped: q?.droppedVideoFrames ?? null, state: v.readyState }; })()`).catch(() => null);
        entry.videoPage = await heapOf(videoPage).catch(() => null);
      }
      // The app's own verdict on the picture.
      entry.output = await page.evaluate(`window.electronAPI.videoOutput.status().then(s => ({ open: s.open, error: s.playbackError, recovery: s.recoveryRequired,
        responsive: s.rendererResponsive, picture: s.pictureHealth?.state ?? null }))`).catch(() => null);
      if (entry.output && (entry.output.error || entry.output.recovery || entry.output.responsive === false)) fail('video-output-fault', entry.output);
      for (const line of engineLogNews()) record.event({ type: 'engine-log', at: Date.now(), line: line.slice(0, 400) });
      // What the screen says is playing must be what the engine is playing.
      // A change in progress is given a moment before it counts.
      const disagreement = async () => {
        const state = JSON.parse(await page.evaluate(UI_STATE));
        const files = new Set((await engine.get('/api/cues')).filter(cue => cue.transport !== 0).map(cue => path.basename(cue.file_path || '')));
        const shown = new Set([...state.playing.map(name => show.cues.find(cue => cue.name === name)?.file),
          ...state.quickPlaying.map(name => show.quickPlays.find(cue => cue.name === name)?.file)]);
        const onlyEngine = [...files].filter(file => !shown.has(file));
        const onlyScreen = [...shown].filter(file => !files.has(file));
        return onlyEngine.length || onlyScreen.length ? { onlyEngine, onlyScreen } : null;
      };
      let differs = await disagreement().catch(() => null);
      for (let attempt = 0; differs && attempt < 3; attempt += 1) { await delay(1500); differs = await disagreement().catch(() => null); }
      if (differs) fail('screen-disagrees-with-engine', differs);
      entry.agrees = !differs;
      record.sample(entry);
    };

    // ---- the operator ---------------------------------------------------
    const rng = mulberry32(seed);
    const between = (low, high) => low + rng() * (high - low);
    const pick = list => list[Math.floor(rng() * list.length)];
    const ui = async () => JSON.parse(await page.evaluate(UI_STATE));
    const summary = () => engine.get('/api/state/summary');
    const playingCues = async () => (await engine.get('/api/cues')).filter(cue => cue.transport !== 0);
    const counts = {};
    const latencies = [];
    const count = name => { counts[name] = (counts[name] || 0) + 1; };

    // Sound reaches the room only through the system default output. Main
    // (masters 0/1) plays there while it is open: 2.7.1 keeps it open as Main
    // all the time; later builds put Main on the chosen output and close it.
    // Until the engine says otherwise, assume it is open.
    let defaultOpen = true;
    let defaultCheckedAt = -Infinity;
    const guard = async () => {
      if (now() - defaultCheckedAt >= 1000) {
        const devices = await engine.get('/api/devices').catch(() => null);
        if (devices) { defaultOpen = devices.some(device => device.is_default && device.is_open); defaultCheckedAt = now(); }
      }
      if (defaultOpen && (meters.level(0) > -100 || meters.level(1) > -100)) {
        fatal = `sound reached the system default output (master 0/1 at ${round(Math.max(meters.level(0), meters.level(1)))} dB)`;
      }
    };

    // When did the engine start the cue? Ask it continuously from before the
    // press: the start lies between the last answer that said "stopped" and
    // the first that said "playing". (The playhead is no clock for this: the
    // engine renders ahead in bursts.)
    const watchStart = (cueId) => {
      const answers = [];
      const done = (async () => {
        let sincePlaying = 0;
        for (const deadline = now() + 4000; now() < deadline && sincePlaying < 3;) {
          const asked = now();
          const cue = await engine.get(`/api/cues/${cueId}`).catch(() => null);
          if (cue) answers.push({ asked, answered: now(), playing: cue.transport !== 0 });
          if (cue && cue.transport !== 0) sincePlaying += 1;
        }
      })();
      return async (pressedAt) => {
        await done;
        if (answers.some(a => a.playing && a.answered < pressedAt)) return null;   // it was already playing
        const first = answers.find(a => a.playing);
        if (!first) return null;
        const before = answers.filter(a => !a.playing && a.asked < first.asked).at(-1);
        const earliest = Math.max(pressedAt, before ? before.asked : pressedAt);
        return { ms: (earliest + first.answered) / 2 - pressedAt, within: (first.answered - earliest) / 2 };
      };
    };

    const waitFor = async (check, timeoutMs, everyMs = 100) => {
      for (const deadline = now() + timeoutMs; now() < deadline;) {
        if (await check().catch(() => false)) return true;
        await delay(everyMs);
      }
      return false;
    };

    const actions = {
      async go() {
        let state = await ui();
        if (/No cue queued/i.test(state.upNext) || !state.upNext) {
          await page.evaluate(`(${ROW})(${JSON.stringify(show.cues[0].name)})?.querySelector(':scope > .item-content .set-next-action')?.click()`);
          await waitFor(async () => (await ui()).upNext.includes(show.cues[0].name), 3000);
          state = await ui();
        }
        const target = show.cues.find(cue => state.upNext.includes(cue.name));
        if (!target) { fail('up-next-unknown', { upNext: state.upNext }); return; }
        const cueId = cuesByFile.get(target.file)?.id;
        const byKey = rng() < 0.5;
        const started = cueId ? watchStart(cueId) : null;
        await delay(15);
        const pressedAt = now();
        await page.evaluate(byKey ? key(' ', 'Space') : `(() => { document.querySelector('.play-next-btn').click(); return true; })()`);
        const start = started ? await started(pressedAt) : null;
        const playing = await waitFor(async () => (await playingCues()).some(cue => fileOf(cue) === target.file), 4000, 50);
        if (!playing) { fail('go-did-not-start', { cue: target.name, byKey, ui: await ui() }); return; }
        const startMs = start ? start.ms : null;
        if (start) latencies.push({ t: Date.now() - startedAt, ms: round(start.ms), within: round(start.within), byKey, cue: target.name });
        const shown = await waitFor(async () => (await ui()).playing.includes(target.name), 3000);
        if (!shown) fail('playing-not-shown', { cue: target.name, ui: await ui() });
        if (!target.silent) {
          const heard = await waitFor(async () => [...meters.state.masters].some(([index, db]) => index < 30 && db > -80), 3000, 50);
          if (!heard) fail('no-level-on-output', { cue: target.name });
        }
        return { cue: target.name, startMs: round(startMs), byKey };
      },
      async quickPlay() {
        const target = pick(show.quickPlays);
        const byKey = rng() < 0.5;
        const wasPlaying = (await ui()).quickPlaying.includes(target.name);
        if (byKey) await page.evaluate(key(String((target.slot + 1) % 10), `Digit${(target.slot + 1) % 10}`));
        else await page.evaluate(`(() => { (${TILE})(${JSON.stringify(target.name)})?.querySelector('.quickplay-transport')?.click(); return true; })()`);
        // The key always plays (Restart when it is playing); the tile button stops a playing tile.
        const expectPlaying = byKey || !wasPlaying;
        const ok = await waitFor(async () => (await playingCues()).some(cue => fileOf(cue) === target.file) === expectPlaying, 4000, 50);
        if (!ok) fail(expectPlaying ? 'quickplay-did-not-start' : 'quickplay-did-not-stop', { cue: target.name, byKey, wasPlaying });
        return { cue: target.name, byKey, expectPlaying };
      },
      async stopAll() {
        const byKey = rng() < 0.5;
        await page.evaluate(byKey ? key('Escape', 'Escape') : `(() => { document.querySelector('.panic-btn').click(); return true; })()`);
        const quiet = await waitFor(async () => (await playingCues()).length === 0, 5000, 50);
        if (!quiet) fail('stop-all-left-cues', { playing: (await playingCues()).map(fileOf), byKey });
        const cleared = await waitFor(async () => { const state = await ui(); return state.playing.length === 0 && state.quickPlaying.length === 0; }, 3000);
        if (!cleared) fail('stop-all-not-shown', { ui: await ui() });
        return { byKey };
      },
      async showMode() {
        const before = (await ui()).showMode;
        await page.evaluate(`(() => { document.querySelector('.showmode-toggle').click(); return true; })()`);
        const changed = await waitFor(async () => (await ui()).showMode !== before, 3000);
        if (!changed) fail('show-mode-did-not-change', { before });
        return { now: !before };
      },
      // Closes Video Output if it is open, then opens it: the picture is up
      // nearly all the time, and opening and closing are exercised.
      async videoOutput() {
        const toggle = async (wanted) => {
          await page.evaluate(`(() => { [...document.querySelectorAll('button')].find(b => /Video Output/.test(b.innerText))?.click(); return true; })()`);
          return waitFor(async () => (await ui()).videoOpen === wanted, 8000);
        };
        const wasOpen = (await ui()).videoOpen;
        if (wasOpen) {
          if (videoPage) { videoPage.close(); videoPage = null; }
          if (!await toggle(false)) { fail('video-output-did-not-close', {}); return; }
          await delay(between(1500, 4000));
        }
        if (!await toggle(true)) { fail('video-output-did-not-open', {}); return; }
        videoPage = await app.openPage(t => t.type === 'page' && /videoOutput/i.test(t.url), 8000).catch(() => null);
        if (videoPage) await videoPage.send('Performance.enable');
        else fail('video-output-page-missing', {});
        return { reopened: wasOpen };
      },
      async properties() {
        const state = await ui();
        if (state.showMode) return { skipped: 'show mode' };
        const target = pick(show.cues);
        await page.evaluate(`(() => { (${ROW})(${JSON.stringify(target.name)})?.querySelector(':scope > .item-content .edit-action')?.click(); return true; })()`);
        const opened = await waitFor(async () => (await ui()).properties, 4000);
        if (!opened) { fail('properties-did-not-open', { cue: target.name }); return; }
        await delay(between(800, 2500));
        await page.evaluate(`(() => { document.querySelector('.properties-header .close-btn')?.click(); return true; })()`);
        const closed = await waitFor(async () => !(await ui()).properties, 4000);
        if (!closed) fail('properties-did-not-close', { cue: target.name });
        return { cue: target.name };
      },
      async upNext() {
        const target = pick(show.cues);
        await page.evaluate(`(() => { (${ROW})(${JSON.stringify(target.name)})?.querySelector(':scope > .item-content .set-next-action')?.click(); return true; })()`);
        const set = await waitFor(async () => (await ui()).upNext.includes(target.name), 3000);
        if (!set) fail('up-next-did-not-change', { cue: target.name, ui: await ui() });
        return { cue: target.name };
      },
    };
    const weighted = [['go', 56], ['quickPlay', 20], ['stopAll', 8], ['upNext', 5], ['properties', 5], ['showMode', 3], ['videoOutput', 3]];
    const totalWeight = weighted.reduce((sum, [, weight]) => sum + weight, 0);
    const choose = () => { let roll = rng() * totalWeight; for (const [name, weight] of weighted) { roll -= weight; if (roll < 0) return name; } return 'go'; };

    if (probe && option('video-cue')) {
      // One video cue played through, uninterrupted, with the output open:
      // dropped frames each second, and every seek and speed change the
      // output makes to stay with the audio clock.
      const name = option('video-cue');
      const seconds = Number(option('seconds', 50));
      await actions.videoOutput();
      if (!videoPage) throw new Error('the video output page did not open');
      await videoPage.send('Runtime.evaluate', { expression: `(() => {
        window.__check = { seeks: 0, rates: [] };
        document.addEventListener('seeking', () => { window.__check.seeks += 1; }, true);
        document.addEventListener('ratechange', e => { window.__check.rates.push(+e.target.playbackRate.toFixed(3)); }, true);
        return true; })()`, returnByValue: true });
      await page.evaluate(`(${ROW})(${JSON.stringify(name)})?.querySelector(':scope > .item-content .set-next-action')?.click()`);
      if (!await waitFor(async () => (await ui()).upNext.includes(name), 3000)) throw new Error(`could not queue "${name}"`);
      await page.evaluate(`(() => { document.querySelector('.play-next-btn').click(); return true; })()`);
      const read = async () => (await videoPage.send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
        const v = [...document.querySelectorAll('video')].find(e => !e.paused) || document.querySelector('video');
        const q = v?.getVideoPlaybackQuality?.();
        return { total: q?.totalVideoFrames ?? 0, dropped: q?.droppedVideoFrames ?? 0, time: v?.currentTime ?? 0,
          seeks: window.__check.seeks, rates: window.__check.rates.length }; })()` })).result.result.value;
      const timeline = [];
      let previous = await read();
      for (let i = 0; i < seconds && !fatal; i++) {
        await delay(1000);
        await guard();
        const next = await read();
        timeline.push({ s: i + 1, frames: next.total - previous.total, dropped: next.dropped - previous.dropped,
          seeks: next.seeks - previous.seeks, rates: next.rates - previous.rates });
        previous = next;
      }
      const final = (await videoPage.send('Runtime.evaluate', { returnByValue: true, expression: 'window.__check' })).result.result.value;
      await actions.stopAll();
      const sum = key => timeline.reduce((total, row) => total + row[key], 0);
      say('video check', JSON.stringify({ cue: name, seconds: timeline.length, frames: sum('frames'), dropped: sum('dropped'),
        seeks: sum('seeks'), speedChanges: sum('rates'), speeds: [...new Set(final.rates)].sort() }));
      say('seconds with drops', JSON.stringify(timeline.filter(row => row.dropped || row.seeks)));
      fs.writeFileSync(path.join(RESULTS, 'video-check.json'), JSON.stringify({ timeline, final }, null, 1));
      say('probe finished');
      return;
    }
    if (probe) {
      // MIDI allowed; Main on the chosen output with its meter and fader live.
      say('midi', await page.evaluate(`navigator.requestMIDIAccess().then(() => 'granted', error => error.name)`));
      const open = (await engine.get('/api/devices')).filter(device => device.is_open);
      say('open outputs', JSON.stringify(open.map(device => ({ name: device.display_name, systemDefault: device.is_default }))));
      await guard();
      if (defaultOpen) { say('the system default output is open, so the probe plays nothing'); say('probe finished'); return; }
      const strip = `[...document.querySelectorAll('.output-console .output-pair')].find(s => s.getAttribute('aria-label') === ${JSON.stringify(OUTPUT)})`;
      const mainLevel = () => round(Math.max(meters.level(0), meters.level(1)));
      // Type a level into the strip's fader, as an operator does.
      const setMain = db => page.evaluate(`(async () => {
        const s = ${strip}; if (!s) return 'no strip';
        s.querySelector('.volume-slider__value')?.click();
        await new Promise(r => setTimeout(r, 150));
        const input = s.querySelector('.volume-slider__input'); if (!input) return 'no fader input';
        input.value = '${db}'; input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        return 'set';
      })()`);
      const went = await actions.go();
      await delay(1500);
      await guard();
      say('go', JSON.stringify(went), 'masters', JSON.stringify([...meters.state.masters].map(([i, db]) => [i, round(db)])));
      say('Main strip', await page.evaluate(`(() => { const s = ${strip}; return s ? s.innerText.replace(/\\s+/g, ' ') : 'missing'; })()`));
      const before = mainLevel();
      say('Main fader to -20 dB:', await setMain(-20));
      await delay(1500);
      const after = mainLevel();
      say('Main level', before, 'dB, then', after, 'dB with the fader at -20');
      say('Main fader back to 0 dB:', await setMain(0));
      await delay(1500);
      say('Main level', mainLevel(), 'dB with the fader at 0');
      await actions.stopAll();
      say('probe finished');
      return;
    }

    // The picture needs its window; open it first, as an operator would.
    await actions.videoOutput();
    await sample();
    const deadline = now() + minutes * 60000;
    let nextSampleAt = now() + 15000;
    let stepNumber = 0;
    let threwInARow = 0;
    say(`running for ${minutes} minutes, seed ${seed}, output "${OUTPUT}"`);
    while (now() < deadline && !fatal) {
      if (app.exited()) { fatal = `the app exited (${JSON.stringify(app.exited())})`; break; }
      const name = choose();
      stepNumber += 1;
      count(name);
      const began = now();
      let outcome = null;
      try {
        await page.evaluate(QUIET);
        outcome = await actions[name]();
        threwInARow = 0;
      } catch (error) {
        fail('step-threw', { action: name, error: String(error.message).slice(0, 300) });
        threwInARow += 1;
        if (threwInARow >= 8) fatal = 'the app could no longer be driven (eight presses in a row threw)';
      }
      record.step({ n: stepNumber, t: round((Date.now() - startedAt) / 1000, 0), action: name, ms: round(now() - began), outcome });
      // Sometimes let what is playing run out by itself, so endings and
      // automatic follows happen; otherwise move on as a busy operator would.
      const hold = rng() < 0.2 ? between(20000, 70000) : between(2000, 16000);
      for (const until = now() + hold; now() < until && !fatal;) {
        await guard();
        if (now() >= nextSampleAt) { await sample().catch(error => record.event({ type: 'sample-error', at: Date.now(), error: String(error.message) })); nextSampleAt += 15000; }
        await delay(250);
      }
      if (stepNumber % 50 === 0) say(`step ${stepNumber}, ${failures.length} failure(s), ${latencies.length} timed starts`);
    }

    await page.evaluate(`(() => { document.querySelector('.panic-btn')?.click(); return true; })()`).catch(() => {});
    await delay(1500);
    await sample().catch(() => {});
    const native = await app.mainEval(`({ dialogs: __soak.dialogs, gone: __soak.gone })`).catch(() => ({ dialogs: [], gone: [] }));
    fs.writeFileSync(path.join(RESULTS, 'run.json'), JSON.stringify({
      output: OUTPUT, minutesPlanned: minutes, seed, startedAt, endedAt: Date.now(), fatal, steps: stepNumber, counts,
      failures, latencies, consoleErrors: consoleErrors.slice(0, 200), native,
      app: { version: clientPackage.version, engineVersion, path: APP },
    }, null, 2));
    if (fatal) say('STOPPED:', fatal);
  } finally {
    meters?.stop();
    await app.quit();
    // Keep the engine's log; the rest of the throwaway profile is cache.
    try { fs.copyFileSync(path.join(profile, 'logs', 'dwcue-server.log'), path.join(RESULTS, 'engine.log')); } catch { /* no log */ }
    fs.rmSync(profile, { recursive: true, force: true });
  }
  summarize(RESULTS);
}

// ---------------------------------------------------------------------------
// Benchmarks: time to start, and time to open a large show
// ---------------------------------------------------------------------------
async function runBench({ launches, cueCount }) {
  if (!OUTPUT) throw new Error('--output "<silent output device>" is required');
  fs.mkdirSync(RESULTS, { recursive: true });
  const folder = path.join(REPO, 'soak-results', `_large-${cueCount}`);
  const large = writeLargeShow(folder, cueCount, OUTPUT);
  const profile = path.join(RESULTS, 'profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const starts = [];
  const opens = [];
  // The first launch makes the profile; it is reported apart from the rest.
  for (let run = 0; run <= launches; run += 1) {
    const app = await launchHidden({ profile, log: path.join(RESULTS, 'app-output.log'),
      recents: [{ path: large.file, name: large.name, folderPath: folder, lastOpened: Date.now(), localTrusted: true }] });
    try {
      const page = await app.openPage(app.isMain);
      const windowAt = now();
      const paintedAt = await page.until(`!!document.querySelector('.welcome-container')`, 'the welcome screen', 60000, 20);
      const readyAt = await page.until(`/Using the audio engine on this computer/.test(document.body.innerText)`, 'the local engine', 60000, 20);
      starts.push({ run, firstRun: run === 0, windowMs: round(windowAt - app.resumedAt), welcomeMs: round(paintedAt - app.resumedAt), engineReadyMs: round(readyAt - app.resumedAt) });
      console.log('start', JSON.stringify(starts.at(-1)));
      if (run >= 1 && run <= 3) {
        const engine = await engineClient(app);
        await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 868, deviceScaleFactor: 1, mobile: false });
        const clickAt = now();
        await page.evaluate(`[...document.querySelectorAll('button')].find(b => b.innerText.includes(${JSON.stringify(large.name)})).click()`);
        const rowsAt = await page.until(`document.querySelectorAll('.playlist-item').length >= 10`, 'the playlist', 120000, 20);
        let loadedAt = null;
        for (const deadline = now() + 600000; now() < deadline;) {
          const summary = await engine.get('/api/state/summary').catch(() => null);
          const cues = summary?.project?.audioLoading === false ? await engine.get('/api/cues').catch(() => []) : [];
          if (cues.length >= cueCount && cues.every(cue => cue.file_loaded)) { loadedAt = now(); break; }
          await delay(50);
        }
        // Loaded is not finished: wait until the engine stops working on it.
        let idleAt = null;
        let last = processTable(app, engine.pid).find(p => p.role === 'engine')?.cpuSeconds ?? 0;
        for (const deadline = now() + 600000; now() < deadline;) {
          await delay(2000);
          const cpu = processTable(app, engine.pid).find(p => p.role === 'engine')?.cpuSeconds ?? last;
          if ((cpu - last) / 2 < 0.15) { idleAt = now() - 2000; break; }
          last = cpu;
        }
        const rows = await page.evaluate(`document.querySelectorAll('.playlist-item').length`);
        const processes = processTable(app, engine.pid);
        opens.push({ run, rowsMs: round(rowsAt - clickAt), loadedMs: loadedAt ? round(loadedAt - clickAt) : null,
          idleMs: idleAt ? round(idleAt - clickAt) : null, rowsShown: rows,
          engineRssMb: processes.find(p => p.role === 'engine')?.rssMb, rendererRssMb: Math.max(...processes.filter(p => p.role === 'renderer').map(p => p.rssMb)) });
        console.log('open', JSON.stringify(opens.at(-1)));
      }
    } finally {
      await app.quit();
    }
  }
  const median = list => { const sorted = [...list].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };
  const warm = starts.filter(start => !start.firstRun);
  const result = {
    app: { version: clientPackage.version, path: APP }, cueCount, launches,
    start: { first: starts.find(start => start.firstRun), warm, medianWelcomeMs: median(warm.map(s => s.welcomeMs)), medianEngineReadyMs: median(warm.map(s => s.engineReadyMs)) },
    open: { runs: opens, medianRowsMs: median(opens.map(o => o.rowsMs)), medianLoadedMs: median(opens.map(o => o.loadedMs)), medianIdleMs: median(opens.map(o => o.idleMs)) },
  };
  fs.writeFileSync(path.join(RESULTS, 'bench.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  fs.rmSync(profile, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; }
}

// Least-squares slope of y over x.
function slope(points) {
  if (points.length < 3) return null;
  const meanX = points.reduce((sum, p) => sum + p[0], 0) / points.length;
  const meanY = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  let over = 0;
  let under = 0;
  for (const [x, y] of points) { over += (x - meanX) * (y - meanY); under += (x - meanX) ** 2; }
  return under ? over / under : null;
}

function summarize(folder) {
  const samples = readJsonl(path.join(folder, 'samples.jsonl'));
  const events = readJsonl(path.join(folder, 'events.jsonl'));
  let run = {};
  try { run = JSON.parse(fs.readFileSync(path.join(folder, 'run.json'), 'utf8')); } catch { /* an interrupted run has none */ }
  if (!samples.length) { console.log('no samples to summarize in', folder); return null; }
  const hours = samples.at(-1).t / 3600;
  // Leave the first tenth out of trends: caches fill and windows open there.
  const settled = samples.filter(s => s.t >= samples.at(-1).t * 0.1);
  const series = (list, read) => list.map(s => [s.t / 3600, read(s)]).filter(([, y]) => Number.isFinite(y));
  const trend = (list, read) => {
    const points = series(list, read);
    if (!points.length) return null;
    const values = points.map(p => p[1]);
    return { first: round(values[0]), last: round(values.at(-1)), min: round(Math.min(...values)), max: round(Math.max(...values)),
      perHour: round(slope(points), 2) };
  };
  const roleRss = role => s => { const list = s.processes.filter(p => p.role === role); return list.length ? list.reduce((sum, p) => sum + p.rssMb, 0) : NaN; };
  const within = (run.latencies ?? []).map(l => l.within).filter(Number.isFinite).sort((a, b) => a - b);
  const roleCpu = role => s => { const list = s.processes.filter(p => p.role === role && p.cpuPercent !== null); return list.length ? list.reduce((sum, p) => sum + p.cpuPercent, 0) : NaN; };
  const cpu = (role) => {
    const values = samples.map(roleCpu(role)).filter(Number.isFinite);
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return { mean: round(values.reduce((a, b) => a + b, 0) / values.length), p95: round(sorted[Math.floor(sorted.length * 0.95)]), max: round(sorted.at(-1)) };
  };
  const devices = {};
  for (const device of samples.at(-1).devices ?? []) {
    const first = samples.find(s => s.devices?.some(d => d.display_name === device.display_name))?.devices.find(d => d.display_name === device.display_name) ?? {};
    const delta = name => (device[name] ?? 0) - (first[name] ?? 0);
    const ring = samples.map(s => s.devices?.find(d => d.display_name === device.display_name)?.ring_occupancy_frames).filter(Number.isFinite);
    devices[device.display_name] = {
      default: device.is_default, sampleRate: device.sample_rate, state: device.runtime_state,
      underruns: delta('underrun_count'), underrunFrames: delta('underrun_frames'), overruns: delta('overrun_count'),
      hardResyncs: delta('hard_resync_count'), deviceLosses: delta('device_loss_count'), recoveries: delta('device_recovery_count'),
      streamRecoveries: delta('stream_recovery_count'), reroutes: delta('reroute_count'), interruptions: delta('interruption_count'),
      correctionLimits: delta('correction_limit_count'),
      ringFramesMean: ring.length ? round(ring.reduce((a, b) => a + b, 0) / ring.length, 0) : null,
      ringFramesMax: ring.length ? Math.max(...ring) : null,
    };
  }
  const latencies = (run.latencies ?? []).map(l => l.ms).filter(Number.isFinite).sort((a, b) => a - b);
  const at = fraction => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * fraction))] : null);
  const gaps = samples.map(s => s.meterWindow?.maxGapMs).filter(Number.isFinite).sort((a, b) => a - b);
  const meterFrames = samples.slice(1).map(s => s.meterWindow?.frames).filter(Number.isFinite);
  const cueSamples = samples.filter(s => s.cues);
  // Frame counts restart with each picture; add up every picture's last count.
  const video = { pictures: 0, frames: 0, dropped: 0 };
  let lastVideo = null;
  const closeVideo = () => { if (lastVideo?.total) { video.pictures += 1; video.frames += lastVideo.total; video.dropped += lastVideo.dropped ?? 0; } };
  for (const s of samples) {
    const v = s.video;
    if (!v || !Number.isFinite(v.total)) continue;
    if (lastVideo && (v.source !== lastVideo.source || v.total < lastVideo.total)) closeVideo();
    lastVideo = v;
  }
  closeVideo();
  const engineLog = events.filter(e => e.type === 'engine-log');
  const logKinds = {};
  for (const entry of engineLog) {
    const kind = entry.line.replace(/^\[[^\]]+\]\s*/, '').replace(/'[^']*'/g, "'…'").replace(/[0-9a-f]{8,}[-0-9a-f]*/g, '#').replace(/\d+(\.\d+)?/g, 'N').slice(0, 110);
    logKinds[kind] = (logKinds[kind] || 0) + 1;
  }
  const failureKinds = {};
  for (const failure of run.failures ?? events.filter(e => e.type === 'failure')) failureKinds[failure.kind] = (failureKinds[failure.kind] || 0) + 1;
  const summary = {
    app: run.app ?? null, output: run.output ?? null, seed: run.seed ?? null,
    hours: round(hours, 2), planned: run.minutesPlanned ? round(run.minutesPlanned / 60, 2) : null, stoppedEarly: run.fatal ?? null,
    start: events.find(e => e.type === 'started')?.startMs ?? null, open: events.find(e => e.type === 'opened')?.openMs ?? null,
    steps: run.steps ?? null, actions: run.counts ?? null,
    failures: { total: Object.values(failureKinds).reduce((a, b) => a + b, 0), kinds: failureKinds },
    goStartMs: latencies.length ? { count: latencies.length, median: at(0.5), p95: at(0.95), max: latencies.at(-1), min: latencies[0],
      knownWithin: within.length ? within[Math.floor(within.length / 2)] : null } : null,
    devices,
    decoder: cueSamples.length ? { readAheadUnderruns: cueSamples.at(-1).cues.readAheadUnderruns - cueSamples[0].cues.readAheadUnderruns, decodeErrors: cueSamples.at(-1).cues.decodeErrors } : null,
    meterBroadcast: { perSecond: meterFrames.length ? round(meterFrames.reduce((a, b) => a + b, 0) / (meterFrames.length * 15)) : null,
      worstGapMs: gaps.length ? gaps.at(-1) : null, p99GapMs: gaps.length ? gaps[Math.floor(gaps.length * 0.99)] : null },
    memoryMb: {
      engine: trend(settled, roleRss('engine')), mainProcess: trend(settled, roleRss('main')),
      mainWindow: trend(settled, roleRss('renderer-main')), videoOutputWindow: trend(settled, roleRss('renderer-video')),
      gpu: trend(settled, roleRss('gpu')),
      videoPageHeap: trend(settled, s => s.videoPage?.heapMb),
      pageHeapAfterCollection: trend(settled.filter(s => s.collected), s => s.page?.heapMb),
    },
    page: { nodes: trend(settled, s => s.page?.nodes), listeners: trend(settled, s => s.page?.listeners), documents: trend(settled, s => s.page?.documents) },
    cpuPercent: { engine: cpu('engine'), mainProcess: cpu('main'), mainWindow: cpu('renderer-main'), videoOutputWindow: cpu('renderer-video'), gpu: cpu('gpu') },
    screenAgreesWithEngine: { checks: samples.filter(s => 'agrees' in s).length, disagreements: samples.filter(s => s.agrees === false).length },
    video: { ...video, outputFaults: samples.filter(s => s.output && (s.output.error || s.output.recovery || s.output.responsive === false)).length },
    engineLog: { warningsAndErrors: engineLog.length, kinds: logKinds },
    pageErrors: events.filter(e => e.type === 'page-exception' || e.type === 'page-console-error').length,
    nativeDialogs: run.native?.dialogs?.length ?? null, processesGone: run.native?.gone ?? null,
  };
  fs.writeFileSync(path.join(folder, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

// ---------------------------------------------------------------------------
(async () => {
  if (mode === 'summarize') { summarize(RESULTS); return; }
  if (!fs.existsSync(EXECUTABLE)) throw new Error(`packaged app missing: ${APP}. Build it first (see scripts/README.md).`);
  if (mode === 'bench') await runBench({ launches: Number(option('launches', 5)), cueCount: Number(option('cues', 300)) });
  else await runSoak({ minutes: Number(option('minutes', 240)), seed: Number(option('seed', 1)), probe: mode === 'probe' });
})().catch((error) => { console.error(error); process.exitCode = 1; });
