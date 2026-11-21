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
const token = 'stuck-cue-start-test-token';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// A GO whose media read hangs (a drive that stopped answering) must hold
// only its own connection: Stop All answers at once, and when the storage
// finally answers, a start the operator gave up on is not made late.
test('a cue start held by storage never delays Stop All and never starts late', { timeout: 30000 }, async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'dwcue-stuck-start-'));
  const reserve = net.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const gate = path.join(folder, 'cue-start-gate');
  const child = spawn(binary, ['--bind', '127.0.0.1', '--port', String(port)], {
    cwd: folder,
    env: { ...process.env, LIVEPLAY_STATE_DIR: path.join(folder, 'state'), LIVEPLAY_ACCESS_TOKEN: token,
      LIVEPLAY_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`, DWCUE_TEST_CUE_START_GATE: gate },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stdout.on('data', chunk => { diagnostics += chunk; });
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  const sockets = [];
  t.after(async () => {
    await rm(gate, { force: true });
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

  // Every request on a fresh connection, as a Stop All after a stall would be.
  const rest = (route, body, timeout = 5000) => new Promise((resolve, reject) => {
    const started = performance.now();
    const request = http.request({
      host: '127.0.0.1', port, path: route, agent: false, method: body === undefined ? 'GET' : 'POST', timeout,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString(),
        ms: performance.now() - started }));
    });
    request.on('timeout', () => request.destroy(new Error(`${route} timed out after ${timeout} ms`)));
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const until = async (predicate, message, tries = 250) => {
    for (let i = 0; i < tries; i++) {
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
  const show = path.join(folder, 'stuck.dwcue');
  await writeFile(show, JSON.stringify({ name: 'stuck', folderPath: folder, settings: {}, quickPlayItems: [], items: [{
    uuid: 'held', type: 'audio', displayName: 'held', mediaServerPath: media, duration: 10, volume: 1,
    playFade: 0, fadeOutDuration: 0, duckingBehavior: { mode: 'no-ducking' }, endBehavior: { action: 'nothing' },
  }] }));
  const loaded = await rest('/api/project/load', { path: show });
  assert.equal(loaded.status, 200, loaded.body);
  await until(async () => JSON.parse((await rest('/api/project/header')).body).server?.audioReadiness?.ready === true,
    'the media was not ready');

  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?access_token=${token}`);
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const acks = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.type === 'command_ack') acks.set(message.command_id, message);
  });
  const entered = `${gate}.entered`;
  const hold = async () => {
    await rm(entered, { force: true });
    await writeFile(gate, '');
  };
  const heldUntilEntered = () => until(async () => access(entered).then(() => true, () => false),
    'the cue start did not reach the held read');

  // 1. Stop All while a start waits on storage.
  await hold();
  socket.send(JSON.stringify({ type: 'play', item_uuid: 'held', command_id: 'held-1' }));
  await heldUntilEntered();
  // As many requests at once as the engine has connection threads, so one
  // lands on the thread that received the held start; Stop All among them.
  const probes = await Promise.all([
    rest('/api/transport/stop_all', {}, 3000),
    ...Array.from({ length: os.cpus().length + 2 }, () => rest('/api/health', undefined, 3000)),
  ]);
  const stopAll = probes[0];
  assert.equal(stopAll.status, 200, stopAll.body);
  const slowest = Math.max(...probes.map(probe => probe.ms));
  assert.ok(slowest < 500, `a request waited ${Math.round(slowest)} ms behind a held cue start`);
  await rm(gate, { force: true });
  await until(() => acks.has('held-1'), 'the held start was never answered');
  assert.equal(acks.get('held-1').ok, false, 'a start overtaken by Stop All does not play');

  // 2. A start held past the point the operator gave up on it.
  await hold();
  socket.send(JSON.stringify({ type: 'play', item_uuid: 'held', command_id: 'held-2' }));
  await heldUntilEntered();
  await delay(2300);
  await rm(gate, { force: true });
  await until(() => acks.has('held-2'), 'the late start was never answered');
  assert.equal(acks.get('held-2').ok, false, 'storage answering late does not start the cue late');
});
