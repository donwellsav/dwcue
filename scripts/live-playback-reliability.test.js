const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const binary = process.env.DWCUE_TEST_SERVER_BINARY || path.resolve(
  __dirname, '../server/build', process.platform === 'win32' ? 'dwcue-server.exe' : 'dwcue-server');
const token = 'live-playback-reliability-token';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}
async function until(predicate, message) {
  for (let i = 0; i < 150; i++) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail(message);
}

test('HTTP cue actions have one server executor with zero or multiple clients', { timeout: 20000 }, async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'dwcue-live-reliability-'));
  const received = [];
  const sink = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ path: request.url, method: request.method, body: Buffer.concat(chunks).toString() });
    response.writeHead(request.url === '/fail' ? 500 : 200).end('received');
  });
  const sinkPort = await listen(sink);
  const temporarySocket = net.createServer();
  const port = await listen(temporarySocket);
  await new Promise(resolve => temporarySocket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(binary, ['--bind', '127.0.0.1', '--port', String(port)], {
    cwd: folder,
    env: { ...process.env, LIVEPLAY_STATE_DIR: path.join(folder, 'state'), LIVEPLAY_ACCESS_TOKEN: token, LIVEPLAY_ALLOWED_ORIGINS: base },
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
        const force = setTimeout(() => child.kill('SIGKILL'), 2000);
        child.once('exit', () => { clearTimeout(force); resolve(); });
        child.kill('SIGTERM');
      });
    }
    await new Promise(resolve => sink.close(resolve));
    await rm(folder, { recursive: true, force: true });
  });
  const request = (route, body) => fetch(`${base}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(2000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  await until(async () => {
    assert.equal(child.exitCode ?? child.signalCode, null, diagnostics);
    try { return (await request('/api/health')).ok; } catch { return false; }
  }, 'isolated server did not start');
  const wav = Buffer.alloc(44 + 48000 * 2 * 10);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  const media = path.join(folder, 'silence.wav');
  await writeFile(media, wav);
  const cue = (uuid, endpoint, body) => ({
    uuid, type: 'audio', displayName: uuid, mediaServerPath: media, duration: 10,
    volume: 1, playFade: 0, fadeOutDuration: 0, duckingBehavior: { mode: 'no-ducking' }, endBehavior: { action: 'nothing' },
    customActions: [{ timePoint: 0, action: { type: 'http-request', request: {
      url: `http://127.0.0.1:${sinkPort}${endpoint}`, method: 'POST', contentType: 'json', body,
    } } }],
  });
  const show = path.join(folder, 'test.dwcue');
  await writeFile(show, JSON.stringify({ name: 'reliability', folderPath: folder,
    items: [cue('headless', '/headless', { cue: 1 }), cue('multi', '/multi', { cue: 2 }), cue('failure', '/fail', { cue: 3 })], settings: {}, cartOnlyItems: [] }));
  const loaded = await request('/api/project/load', { path: show });
  assert.equal(loaded.status, 200, await loaded.text());
  await until(async () => (await (await request('/api/project/header')).json()).server?.audioReadiness?.ready === true,
    `media was not ready: ${diagnostics}`);
  const play = async uuid => {
    const response = await request(`/api/project/items/${uuid}/play`, {});
    assert.equal(response.status, 200, await response.text());
  };
  await play('headless');
  await until(() => received.some(item => item.path === '/headless'), 'headless cue HTTP action was dropped');
  for (let i = 0; i < 2; i++) {
    const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?access_token=${token}`);
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
  }
  await play('multi');
  await until(() => received.some(item => item.path === '/multi'), 'multi-client cue did not execute');
  await play('failure');
  await until(() => received.some(item => item.path === '/fail'), 'failing HTTP cue was not attempted');
  await delay(200);
  assert.deepEqual(received, [
    { path: '/headless', method: 'POST', body: '{"cue":1}' },
    { path: '/multi', method: 'POST', body: '{"cue":2}' },
    { path: '/fail', method: 'POST', body: '{"cue":3}' },
  ], 'a cue side effect must have only one attempt, including server errors');
});

test('project changes discard cached broadcast batches without consuming reconnect snapshots', { timeout: 30000 }, async t => {
  const source = await readFile(path.join(__dirname, '../server/src/net/control_server.cpp'), 'utf8');
  const fanoutStart = source.indexOf('        // Fan out meters + cue_state events');
  const fanoutEnd = source.indexOf('        // Sleep to maintain the broadcast cadence', fanoutStart);
  const patchStart = source.indexOf('void ControlServer::broadcast_doc_patch(');
  const patchEnd = source.indexOf('\n}\n', patchStart) + 3;
  const epochCapture = source.match(/const auto batch_epoch = [^;]+;/)?.[0];
  assert.ok(fanoutStart >= 0 && fanoutEnd > fanoutStart && patchStart >= 0 && patchEnd > patchStart);
  assert.ok(epochCapture && source.indexOf(epochCapture) < source.indexOf('// Build the meters payload.'));
  // Compile the real publication code with fake connections so the cached
  // batch can be held deterministically across a project change.
  const folder = await mkdtemp(path.join(os.tmpdir(), 'dwcue-broadcast-epoch-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const cpp = path.join(folder, 'check.cpp');
  const executable = path.join(folder, process.platform === 'win32' ? 'check.exe' : 'check');
  await writeFile(cpp, `
#include <atomic>
#include <cassert>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>
struct json {
    std::string op;
    std::string value(const char*, const std::string&) const { return op; }
    std::string dump() const { return op; }
};
struct Logger {
    template<class... Args> static void error(const char*, Args&&...) {}
};
struct Connection {
    std::vector<std::string> messages;
    void send_text(const std::string& message) { messages.push_back(message); }
};
struct ControlServer {
    struct Impl {
        std::mutex ws_mutex, http_mutex;
        std::vector<Connection*> ws_clients;
        std::unordered_set<Connection*> ws_clients_pending_snapshot;
        std::atomic<std::uint64_t> http_generation{0};
        std::vector<int> http_actions{1};
    };
    std::unique_ptr<Impl> impl_ = std::make_unique<Impl>();
    std::unordered_map<std::string, int> prev_transports{{"cue", 1}}, prev_device_states{{"device", 1}};
    void broadcast_doc_patch(const json& payload);
    std::function<void()> cached_batch() {
        ${epochCapture}
        return [this, batch_epoch] {
            const std::string serialized = "meters", snapshot_serialized = "snapshot";
            const std::vector<std::string> cue_state_events{"playing"}, device_state_events{"device"};
            auto& prev_transports = this->prev_transports;
            auto& prev_device_states = this->prev_device_states;
${source.slice(fanoutStart, fanoutEnd)}
        };
    }
};
${source.slice(patchStart, patchEnd)}
int main() {
    ControlServer server;
    Connection client;
    server.impl_->ws_clients.push_back(&client);
    server.impl_->ws_clients_pending_snapshot.insert(&client);
    auto stale = server.cached_batch();
    server.broadcast_doc_patch({"project_changed"});
    stale();
    assert(client.messages == std::vector<std::string>{"project_changed"});
    assert(server.impl_->ws_clients_pending_snapshot.contains(&client));
    assert(server.prev_transports.empty() && server.prev_device_states.empty());
    assert(server.impl_->http_actions.empty());
    server.cached_batch()();
    assert((client.messages == std::vector<std::string>{"project_changed", "snapshot", "meters", "playing", "device"}));
    assert(server.impl_->ws_clients_pending_snapshot.empty());
    const auto epoch = server.impl_->http_generation.load();
    server.broadcast_doc_patch({"item_updated"});
    assert(server.impl_->http_generation.load() == epoch);
    auto current = server.cached_batch();
    current();
    assert(client.messages.back() == "device");
}
`);
  const cache = await readFile(path.join(__dirname, '../server/build/CMakeCache.txt'), 'utf8').catch(() => '');
  const compiler = cache.match(/^CMAKE_CXX_COMPILER:FILEPATH=(.+)$/m)?.[1].trim()
    || process.env.CXX || (process.platform === 'win32' ? 'cl' : 'c++');
  const msvc = /(?:^|[\\/])cl(?:\.exe)?$/i.test(compiler);
  const args = msvc
    ? ['/nologo', '/std:c++20', '/EHsc', `/Fe${executable}`, `/Fo${path.join(folder, 'check.obj')}`, cpp]
    : ['-std=c++20', '-pthread', cpp, '-o', executable];
  await promisify(execFile)(compiler, args);
  await promisify(execFile)(executable, []);
});
