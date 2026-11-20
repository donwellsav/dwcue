const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { access, mkdtemp, rm, writeFile } = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const binary = process.env.DWCUE_TEST_SERVER_BINARY || path.resolve(
  __dirname, '../server/build', process.platform === 'win32' ? 'dwcue-server.exe' : 'dwcue-server');
const token = 'show-change-state-test-token';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// When another show replaces one that is playing, every client must hear
// that its cues stopped (they are retired with the show, not stopped one by
// one) and that Up Next is now empty, or the old show's playing rows and Up
// Next stay on screen.
test('opening another show tells clients its playing cue stopped and Up Next cleared', { timeout: 30000 }, async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'dwcue-show-change-'));
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
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const force = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => { clearTimeout(force); resolve(); });
        child.kill('SIGTERM');
      });
    }
    await rm(folder, { recursive: true, force: true });
  });
  const rest = (route, body) => new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, path: route, agent: false, method: body === undefined ? 'GET' : 'POST', timeout: 5000,
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
  const cue = uuid => ({ uuid, type: 'audio', displayName: uuid, mediaServerPath: media, duration: 10, volume: 1,
    playFade: 0, fadeOutDuration: 0, duckingBehavior: { mode: 'no-ducking' }, endBehavior: { action: 'nothing' } });
  const first = path.join(folder, 'first.dwcue');
  await writeFile(first, JSON.stringify({ name: 'first', folderPath: folder, settings: {}, quickPlayItems: [],
    items: [cue('opening'), cue('second')] }));
  // The next show arms nothing on open.
  const empty = path.join(folder, 'empty.dwcue');
  await writeFile(empty, JSON.stringify({ name: 'empty', folderPath: folder, settings: {}, quickPlayItems: [], items: [] }));

  const loaded = await rest('/api/project/load', { path: first });
  assert.equal(loaded.status, 200, loaded.body);
  await until(async () => JSON.parse((await rest('/api/project/header')).body).server?.audioReadiness?.ready === true,
    'the media was not ready');
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?access_token=${token}`);
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const messages = [];
  socket.addEventListener('message', event => messages.push(JSON.parse(String(event.data))));
  socket.send(JSON.stringify({ type: 'play', item_uuid: 'opening', command_id: 'play-opening' }));
  await until(() => messages.some(m => m.type === 'cue_state' && m.item_uuid === 'opening' && m.transport !== 0),
    'the cue did not start');
  const playingCue = messages.find(m => m.type === 'cue_state' && m.item_uuid === 'opening' && m.transport !== 0).cue_id;
  messages.length = 0;

  const switched = await rest('/api/project/load', { path: empty });
  assert.equal(switched.status, 200, switched.body);
  await until(() => messages.some(m => m.type === 'cue_state' && m.cue_id === playingCue && m.transport === 0),
    'clients were never told the retired cue stopped');

  // A show with its first cue armed as Up Next, replaced before anything plays.
  messages.length = 0;
  const reopened = await rest('/api/project/load', { path: first });
  assert.equal(reopened.status, 200, reopened.body);
  await until(() => messages.some(m => m.type === 'doc_patch' && m.op === 'next_item_set' && m.itemUuid === 'opening'),
    'the first show did not arm its opening cue');
  messages.length = 0;
  const replaced = await rest('/api/project/load', { path: empty });
  assert.equal(replaced.status, 200, replaced.body);
  await until(() => messages.some(m => m.type === 'doc_patch' && m.op === 'next_item_set' && !m.itemUuid),
    'clients were never told Up Next is empty');
});
