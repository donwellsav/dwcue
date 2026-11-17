// Show Mode must be Edit Mode with controls taken out: nothing else may move
// or change size. This opens the packaged app on a throwaway show, measures
// every visible element in both modes at several window sizes, and fails on
// any difference. It also checks that a cue stays on one line and that ten
// QuickPlays fit beside the playlist at the default window size.
//
//   npm run build && node --test scripts/mode-layout.test.cjs
//
// It plays nothing. It needs the packaged app (client/dist-electron) and a
// desktop session, so it is a local and release-machine check, not part of
// check:client.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'client', 'dist-electron');
const executable = [
  path.join(out, 'mac-arm64', 'DonWells Cue.app', 'Contents', 'MacOS', 'DonWells Cue'),
  path.join(out, 'mac', 'DonWells Cue.app', 'Contents', 'MacOS', 'DonWells Cue'),
  path.join(out, 'win-unpacked', 'DonWells Cue.exe'),
  path.join(out, 'linux-unpacked', 'donwells-cue'),
].find(candidate => fs.existsSync(candidate));

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

// A silent WAV: 8 kHz, mono, 16 bit.
function silentWav(file, seconds) {
  const data = Buffer.alloc(8000 * 2 * seconds);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

function writeShow(folder) {
  const media = path.join(folder, 'media');
  fs.mkdirSync(media, { recursive: true });
  let serial = 0;
  const cue = (name, seconds, color, extra = {}) => {
    const file = path.join(media, `cue-${++serial}.wav`);
    silentWav(file, seconds);
    return {
      uuid: `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`, type: 'audio', displayName: name, color,
      index: [0], mediaFileName: path.basename(file), mediaPath: `media/${path.basename(file)}`, mediaServerPath: file,
      waveformPath: '', inPoint: 0, outPoint: seconds, duration: seconds, volume: 1,
      endBehavior: { action: 'nothing' }, startBehavior: { action: 'nothing' }, customActions: [],
      duckingBehavior: { mode: 'stop-all', duckFadeIn: 0.25, duckFadeOut: 1 },
      fadeOutDuration: 1, playFade: 0, stopFade: 0, crossFade: 0,
      startNextEnabled: false, startNextTime: 0, startNextFadeOut: false, ...extra,
    };
  };
  const group = (id, name, color, isExpanded, children) => ({
    uuid: `00000000-0000-4000-9000-${String(id).padStart(12, '0')}`, type: 'group', displayName: name, color,
    index: [0], isExpanded, startBehavior: { action: 'play-first' }, endBehavior: { action: 'nothing' }, children,
  });
  const quick = (slot, name, seconds, color) => cue(name, seconds, color, {
    index: [-1, slot], quickPlay: { order: slot, retrigger: 'restart' },
    duckingBehavior: { mode: 'no-ducking', duckFadeIn: 0.25, duckFadeOut: 1 },
  });
  const items = [
    group(1, 'Walk-in music', '#0066FF', true, [
      cue('Walk-in track 1 - Morning lobby', 190, '#0066FF'), cue('Walk-in track 2 - Easy tempo', 168, '#0066FF')]),
    cue('Chairman walk-on', 25, '#00CC99'),
    cue('Speaker introduction sting', 12, '#FFCC00'),
    cue('Practice cue (loops)', 40, '#9900FF', { endBehavior: { action: 'loop' } }),
    cue('Closing theme and credits', 95, '#00AAFF'),
    group(2, 'Interval music', '#66BB44', false, [cue('Interval track 1', 240, '#66BB44')]),
  ];
  items.forEach((item, n) => { item.index = [n]; (item.children ?? []).forEach((child, m) => { child.index = [n, m]; }); });
  const show = path.join(folder, 'Mode layout.dwcue');
  fs.writeFileSync(show, JSON.stringify({
    name: 'Mode layout', version: '2.0.0', folderPath: folder, items,
    quickPlayItems: [quick(0, 'Applause sting', 8, '#FFCC00'), quick(1, 'Countdown bumper', 14, '#FF00CC'),
      quick(2, 'Hold music bed', 30, '#9900FF'), quick(10, 'House announcement', 18, '#00CC99')],
    quickPlaySlots: [], settings: { autoSave: true }, theme: { mode: 'dark', accentColor: '#315FCF' },
  }, null, 2));
  return show;
}

// Every visible element, keyed by a path that does not depend on the mode.
const MEASURE = `(() => {
  const DROP = new Set(['show-mode', 'item-level__value--readout', 'is-selected', 'item-actions--single', 'delete-action--parked']);
  const MOVING = /progress|clock-value|meter|level-bar|peak/;
  const sig = (el) => {
    let tag = el.tagName.toLowerCase();
    const cls = [...el.classList].filter(c => !DROP.has(c)).sort();
    if (cls.includes('item-level__value')) tag = 'value';
    const uuid = el.getAttribute('data-item-uuid');
    return tag + (cls.length ? '.' + cls.join('.') : '') + (uuid ? '#' + uuid : '');
  };
  const out = {};
  const walk = (el, key) => {
    const counts = {};
    for (const child of el.children) {
      if (['STYLE', 'SCRIPT', 'CANVAS'].includes(child.tagName)) continue;
      const s = sig(child);
      counts[s] = (counts[s] || 0) + 1;
      const k = key + ' > ' + s + (s.includes('#') ? '' : '[' + counts[s] + ']');
      const cs = getComputedStyle(child);
      if (cs.display === 'none') continue;
      const b = child.getBoundingClientRect();
      if (b.width > 0 && b.height > 0 && cs.visibility !== 'hidden' && !MOVING.test(s)) {
        out[k] = [b.x, b.y, b.width, b.height].map(v => Math.round(v * 2) / 2).join(',') + '|' + cs.fontSize;
      }
      walk(child, k);
    }
  };
  walk(document.querySelector('#app'), 'app');
  return out;
})()`;

test('Show Mode differs from Edit Mode only by the controls it removes', { timeout: 120_000, skip: executable ? false : 'the packaged app is not built (npm run build)' }, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dwcue-mode-layout-'));
  const profile = path.join(work, 'profile');
  fs.mkdirSync(profile);
  const show = writeShow(path.join(work, 'show'));
  const [debugPort, enginePort] = [await freePort(), await freePort()];
  fs.writeFileSync(path.join(profile, 'liveplay-server.json'),
    JSON.stringify({ mode: 'local', remoteUrl: `http://127.0.0.1:${enginePort}`, localPort: enginePort }));
  fs.writeFileSync(path.join(profile, 'liveplay-recent-projects.json'), JSON.stringify([{
    path: show, name: 'Mode layout', folderPath: path.dirname(show), lastOpened: Date.now(), localTrusted: true }]));

  const app = spawn(executable, [`--remote-debugging-port=${debugPort}`, '--smoke-quit'],
    { env: { ...process.env, DWCUE_USERDATA: profile }, stdio: 'ignore' });
  t.after(async () => {
    app.kill();
    await delay(1500);
    try { process.kill(JSON.parse(fs.readFileSync(path.join(profile, 'liveplay-server.lock'), 'utf8')).pid); } catch { /* already gone */ }
    await delay(500);
    fs.rmSync(work, { recursive: true, force: true });
  });

  // The app's main window, over the DevTools protocol.
  let page;
  for (let attempt = 0; attempt < 80 && !page; attempt += 1) {
    await delay(250);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      page = targets.find(target => target.type === 'page' && /index\.html/.test(target.url));
    } catch { /* not listening yet */ }
  }
  assert.ok(page, 'the app window did not appear');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  t.after(() => socket.close());
  let id = 0;
  const waiting = new Map();
  socket.onmessage = (event) => { const message = JSON.parse(event.data); waiting.get(message.id)?.(message); waiting.delete(message.id); };
  const send = (method, params = {}) => new Promise(resolve => { waiting.set(++id, resolve); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(reply.result.exceptionDetails, undefined, reply.result.exceptionDetails?.exception?.description);
    return reply.result.result.value;
  };
  const until = async (expression, what) => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (await evaluate(expression)) return;
      await delay(250);
    }
    assert.fail(`timed out waiting for ${what}`);
  };

  await until(`[...document.querySelectorAll('button')].some(b => /Mode layout/.test(b.innerText))`, 'the recent show on the welcome screen');
  await evaluate(`[...document.querySelectorAll('button')].find(b => /Mode layout/.test(b.innerText)).click()`);
  await until(`document.querySelectorAll('.playlist-item').length >= 8 && document.querySelectorAll('.quickplay-tile').length >= 4`, 'the show to open');
  await evaluate(`(() => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}'; document.head.appendChild(s); })()`);
  const setMode = async (show) => {
    await evaluate(`(() => { const t = document.querySelector('.showmode-toggle'); if ((t.getAttribute('aria-checked') === 'true') !== ${show}) t.click(); })()`);
    await until(`!!document.querySelector('.main-workspace.show-mode') === ${show}`, show ? 'Show Mode' : 'Edit Mode');
    await delay(300);
  };

  for (const [width, height] of [[1400, 868], [1200, 700], [1700, 1000]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await delay(400);
    await setMode(false);
    const edit = await evaluate(MEASURE);
    await setMode(true);
    const showMode = await evaluate(MEASURE);
    const shared = Object.keys(edit).filter(key => key in showMode);
    assert.ok(shared.length > 250, `expected to compare the whole window at ${width}x${height}, found ${shared.length} shared elements`);
    const moved = shared.filter(key => edit[key] !== showMode[key])
      .map(key => `${key.split(' > ').slice(-2).join(' > ')}: edit ${edit[key]} show ${showMode[key]}`);
    assert.deepEqual(moved, [], `elements that move or change size between the modes at ${width}x${height}`);

    // A cue is one line: every cue row has one height, every group row another.
    const rows = await evaluate(`(() => { const h = (sel) => [...new Set([...document.querySelectorAll(sel)].map(r => Math.round(r.getBoundingClientRect().height)))];
      return { cues: h('.playlist-item.is-audio > .item-content'), groups: h('.playlist-item.is-group > .item-content') }; })()`);
    assert.equal(rows.cues.length, 1, `cue rows must share one height at ${width}x${height}: ${rows.cues}`);
    assert.equal(rows.groups.length, 1, `group rows must share one height at ${width}x${height}: ${rows.groups}`);
    await setMode(false);

    if (width === 1400) {
      const fit = await evaluate(`(() => { const grid = document.querySelector('.quickplay-grid'); const edge = grid.getBoundingClientRect().bottom + 1;
        return [...grid.children].filter(cell => cell.getBoundingClientRect().bottom <= edge).length; })()`);
      assert.ok(fit >= 10, `ten QuickPlays must fit beside the playlist at the default window size, ${fit} do`);
    }
  }
});
