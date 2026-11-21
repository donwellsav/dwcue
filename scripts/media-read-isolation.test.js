const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm, stat, writeFile } = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const serverBinary = process.env.DWCUE_TEST_SERVER_BINARY || path.resolve(
  __dirname, '..', 'server', 'build', process.platform === 'win32' ? 'dwcue-server.exe' : 'dwcue-server',
);
const accessToken = 'media-read-isolation-test-token';

// Video reads run on the engine's storage workers, not on the threads that
// carry GO, meters and every other request. Storage that stops answering (a
// USB drive, a network share) may hold those workers; nothing else may wait.
test('held media reads never delay a control request', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dwcue-media-isolation-'));
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  const gate = path.join(temporary, 'media-read-gate');
  const child = spawn(serverBinary, ['--bind', '127.0.0.1', '--port', String(port)], {
    cwd: temporary,
    env: {
      ...process.env,
      LIVEPLAY_STATE_DIR: path.join(temporary, 'server-state'),
      LIVEPLAY_ACCESS_TOKEN: accessToken,
      LIVEPLAY_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
      DWCUE_TEST_MEDIA_READ_GATE: gate,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stdout.on('data', chunk => { diagnostics += chunk; });
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  const held = [];
  t.after(async () => {
    await rm(gate, { force: true });
    for (const request of held) request.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const force = setTimeout(() => child.kill('SIGKILL'), 2000);
        child.once('exit', () => { clearTimeout(force); resolve(); });
        child.kill('SIGTERM');
      });
    }
    await rm(temporary, { recursive: true, force: true });
  });

  // A fresh connection for every request, as the browser opens them.
  const get = (pathname, headers = {}, timeout = 2000) => new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, path: pathname, agent: false, timeout,
      headers: { Authorization: `Bearer ${accessToken}`, ...headers },
    }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('timeout', () => request.destroy(new Error(`${pathname} timed out after ${timeout} ms`)));
    request.on('error', reject);
    request.end();
    return request;
  });

  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    assert.equal(child.exitCode ?? child.signalCode, null, diagnostics);
    try { ready = (await get('/api/health')) === 200; } catch {}
    if (!ready) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(ready, diagnostics);

  const media = path.join(temporary, 'clip.mp4');
  await writeFile(media, Buffer.alloc(256 * 1024, 7));
  await writeFile(gate, '');
  // More reads than the server has threads, so any read left on a server
  // thread would hold every one of them.
  const count = Math.min(os.cpus().length + 2, 48);
  const url = `/api/media?path=${encodeURIComponent(media)}`;
  for (let i = 0; i < count; i++) {
    const request = http.request({
      host: '127.0.0.1', port, path: url, agent: false,
      headers: { Authorization: `Bearer ${accessToken}`, Range: 'bytes=0-65535' },
    });
    request.on('error', () => {});
    request.end();
    held.push(request);
  }
  const entered = path.join(temporary, 'media-read-gate.entered');
  let holding = 0;
  for (let attempt = 0; attempt < 200 && holding === 0; attempt++) {
    holding = await stat(entered).then(info => info.size, () => 0);
    if (holding === 0) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(holding > 0, `no media read reached the held read\n${diagnostics}`);
  await new Promise(resolve => setTimeout(resolve, 200));

  const started = performance.now();
  assert.equal(await get('/api/health', {}, 1000), 200);
  const waited = performance.now() - started;
  assert.ok(waited < 500, `a request waited ${Math.round(waited)} ms behind held media reads`);
});
