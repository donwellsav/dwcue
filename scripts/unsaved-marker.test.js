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
const token = 'unsaved-marker-test-token';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// The window can reload (a renderer crash) while the engine keeps the show.
// The engine must say whether that show holds edits not yet written to disk,
// or quitting afterwards would not offer to save them.
test('the show header says when the engine holds unsaved edits', { timeout: 30000 }, async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'dwcue-unsaved-'));
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
      host: '127.0.0.1', port, path: route, agent: false, timeout: 5000,
      method: method ?? (body === undefined ? 'GET' : 'POST'),
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
  for (let i = 0; i < 250; i++) {
    assert.equal(child.exitCode ?? child.signalCode, null, diagnostics);
    try { if ((await rest('/api/health')).status === 200) break; } catch { /* starting */ }
    await delay(20);
  }
  const unsaved = async () => JSON.parse((await rest('/api/project/header')).body).unsavedChanges;

  const show = path.join(folder, 'edited.dwcue');
  await writeFile(show, JSON.stringify({ name: 'edited', folderPath: folder, settings: {}, quickPlayItems: [], items: [
    { uuid: 'note', type: 'audio', displayName: 'Opening', mediaServerPath: path.join(folder, 'missing.wav') },
  ] }));
  assert.equal((await rest('/api/project/load', { path: show })).status, 200);
  assert.equal(await unsaved(), false, 'a show just opened has nothing unsaved');
  assert.equal((await rest('/api/project/items/note', { displayName: 'Opening, renamed' }, 'PATCH')).status, 200);
  assert.equal(await unsaved(), true, 'an edit not yet saved is reported');
  const saved = await rest('/api/project/save', {});
  assert.equal(saved.status, 200, saved.body);
  assert.equal(await unsaved(), false, 'saving clears it');
  assert.equal((await rest('/api/project/items/note', { displayName: 'Opening' }, 'PATCH')).status, 200);
  assert.equal(await unsaved(), true, 'a later edit is reported again');
});
