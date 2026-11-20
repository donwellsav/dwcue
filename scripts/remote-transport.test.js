const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const binary = process.env.DWCUE_TEST_SERVER_BINARY || path.resolve(
  __dirname, '../server/build', process.platform === 'win32' ? 'dwcue-server.exe' : 'dwcue-server');
const token = 'remote-transport-test-token';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// The routes a Companion button or other remote uses.
test('remote Pause leaves a stopping cue alone, GO says why it did nothing, a limiter bypass is saved', { timeout: 30000 }, async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'dwcue-remote-'));
  const reserve = net.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const child = spawn(binary, ['--bind', '127.0.0.1', '--port', String(port)], {
    cwd: folder,
    env: { ...process.env, LIVEPLAY_STATE_DIR: path.join(folder, 'state'), LIVEPLAY_ACCESS_TOKEN: token,
      LIVEPLAY_ALLOWED_ORIGINS: `http://127.0.0.1:${port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stdout.on('data', chunk => { diagnostics += chunk; });
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const force = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => { clearTimeout(force); resolve(); });
        child.kill('SIGTERM');
      });
    }
    await rm(folder, { recursive: true, force: true });
  });

  const rest = (route, body, method) => new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, path: route, agent: false, method: method ?? (body === undefined ? 'GET' : 'POST'),
      timeout: 5000,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    request.on('timeout', () => request.destroy(new Error(`${route} timed out`)));
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const until = async (predicate, message) => {
    for (let i = 0; i < 250; i++) {
      if (await predicate()) return;
      await delay(20);
    }
    assert.fail(`${message}\n${diagnostics}`);
  };
  const summary = async () => JSON.parse((await rest('/api/state/summary')).body);
  await until(async () => {
    assert.equal(child.exitCode ?? child.signalCode, null, diagnostics);
    try { return (await rest('/api/health')).status === 200; } catch { return false; }
  }, 'the engine did not start');

  const wav = Buffer.alloc(44 + 48000 * 2 * 10);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  const media = path.join(folder, 'silence.wav');
  await writeFile(media, wav);
  const cue = (uuid, extra = {}) => ({ uuid, type: 'audio', displayName: uuid, mediaServerPath: media, duration: 10,
    volume: 1, playFade: 0, fadeOutDuration: 0, duckingBehavior: { mode: 'no-ducking' }, endBehavior: { action: 'nothing' },
    ...extra });
  const show = path.join(folder, 'remote.dwcue');
  await writeFile(show, JSON.stringify({ name: 'remote', folderPath: folder, settings: {}, quickPlayItems: [], items: [
    cue('bed'), cue('nowhere', { deviceOverride: 'an output that is not connected' }),
  ] }));
  assert.equal((await rest('/api/project/load', { path: show })).status, 200);
  await until(async () => JSON.parse((await rest('/api/project/header')).body).server?.audioReadiness?.ready === true,
    'the media was not ready');

  // Pause during a Stop All fade would hold the stopping cue on air.
  assert.equal((await rest('/api/project/items/bed/play', {})).status, 200);
  // Played a little: a stop while a cue still waits for its first audio is immediate.
  await until(async () => (await summary()).playing?.some(p => p.itemUuid === 'bed' && p.transport === 'playing' &&
    p.playheadSec > 0.3), 'the bed did not start');
  assert.equal((await rest('/api/transport/stop_all', { fade_ms: 3000 })).status, 200);
  const fading = await summary();
  assert.ok(fading.playing.some(p => p.itemUuid === 'bed' && p.transport === 'fading_out'),
    `the bed is fading out: ${JSON.stringify(fading.playing)}`);
  const pause = await rest('/api/transport/pause_toggle', {});
  assert.equal(pause.status, 404, `pause during a Stop All fade: ${pause.body}`);
  assert.ok(!(await summary()).playing.some(p => p.paused), 'the stopping cue was not held');
  assert.equal((await rest('/api/transport/stop_all', { fade_ms: 0 })).status, 200);

  // GO with an armed cue that cannot start is not "nothing armed".
  assert.equal((await rest('/api/transport/arm_selected', {})).status, 404, 'nothing selected yet');
  assert.equal((await rest('/api/selection', { itemUuid: 'nowhere' })).status, 200);
  assert.equal((await rest('/api/transport/arm_selected', {})).status, 200);
  const go = await rest('/api/transport/go', {});
  assert.equal(go.status, 409, `GO of an armed cue that cannot start: ${go.body}`);
  assert.match(go.body, /Up Next could not start/);

  // A remote limiter bypass belongs to the show: the next settings save, which
  // carries every setting, must not switch the limiter back on.
  assert.equal((await rest('/api/master/limiter', { enabled: false })).status, 200);
  const settings = JSON.parse((await rest('/api/project/header')).body).settings;
  assert.equal(settings.disableLimiter, true, 'the bypass is in the show');
  assert.equal((await rest('/api/project/settings', { ...settings, autoSave: false }, 'PATCH')).status, 200);
  assert.equal(JSON.parse((await rest('/api/master/limiter')).body).enabled, false,
    'another setting saved afterwards leaves the limiter bypassed');
});
