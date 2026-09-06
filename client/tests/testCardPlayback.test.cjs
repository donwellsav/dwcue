const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { cleanupConnectionFor, TestCardPlayback } = require('../electron/test-card-playback');

const connection = { serverUrl: 'http://cue.test', accessToken: 'credential', local: true };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const desired = (rate = 60, overrides = {}) => ({ rate, deviceId: 'default', connection, ...overrides });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

function harness({ beforeRequest, assetPath = rate => `/bundled/${rate}.webm` } = {}) {
  const cues = new Map();
  const requests = [];
  let sequence = 0;
  const player = new TestCardPlayback({
    assetPath,
    onChange() {},
    async request(url, options) {
      requests.push({ url, options });
      const intercepted = await beforeRequest?.(url, options);
      if (intercepted) return intercepted;
      const route = new URL(url).pathname;
      if (route === '/api/diagnostics/av-sync') {
        const cue = { id: `diagnostic-${++sequence}`, file_path: '/native/clip.webm', duration_sec: 4.008, file_loaded: true, playing: false };
        cues.set(cue.id, cue);
        return response(cue);
      }
      const id = route.split('/')[3];
      const cue = cues.get(id);
      if (!cue) return response({ error: 'not found' }, 404);
      if (options.method === 'DELETE') cues.delete(id);
      else if (route.endsWith('/play')) cue.playing = true;
      return response({ ok: true });
    },
  });
  return { player, cues, requests };
}

test('one native cue survives irrelevant config/status updates and is unloaded on disable', async () => {
  const h = harness();
  await h.player.update(desired());
  const id = h.player.playback.cueId;
  assert.equal(h.cues.get(id).playing, true);
  await h.player.update(desired());
  assert.equal(h.player.playback.cueId, id);
  assert.equal(h.requests.length, 2);
  await h.player.update(null);
  assert.equal(h.cues.size, 0);
  assert.equal(h.player.playback, null);
  assert.equal(h.player.error, null);
});

test('identical updates during load do not cancel or restart the tone', async () => {
  const entered = deferred();
  const load = deferred();
  const h = harness({ beforeRequest: async url => {
    if (url.endsWith('/api/diagnostics/av-sync')) { entered.resolve(); await load.promise; }
  } });
  const first = h.player.update(desired());
  await entered.promise;
  const repeated = h.player.update(desired());
  load.resolve();
  await Promise.all([first, repeated]);
  assert.equal(h.cues.size, 1);
  assert.equal(h.requests.filter(r => r.url.endsWith('/av-sync')).length, 1);
  assert.equal([...h.cues.values()][0].playing, true);
  await h.player.update(null);
});

test('replacement during load discards the old cue before playing only the newest rate', async () => {
  const entered = deferred();
  const load = deferred();
  let first = true;
  const h = harness({ beforeRequest: async url => {
    if (url.endsWith('/av-sync') && first) { first = false; entered.resolve(); await load.promise; }
  } });
  const old = h.player.update(desired(24));
  await entered.promise;
  const latest = h.player.update(desired(120));
  load.resolve();
  await Promise.all([old, latest]);
  assert.equal(h.cues.size, 1);
  assert.equal(h.player.playback.cueId, 'diagnostic-2');
  assert.equal(h.requests.some(r => r.url.endsWith('/diagnostic-1/play')), false);
  assert.equal(h.cues.get('diagnostic-2').playing, true);
  await h.player.update(null);
});

test('close during load releases the returned cue without ever playing it', async () => {
  const entered = deferred();
  const load = deferred();
  const h = harness({ beforeRequest: async url => {
    if (url.endsWith('/av-sync')) { entered.resolve(); await load.promise; }
  } });
  const start = h.player.update(desired());
  await entered.promise;
  const close = h.player.update(null);
  load.resolve();
  await Promise.all([start, close]);
  assert.equal(h.cues.size, 0);
  assert.equal(h.requests.some(r => r.url.endsWith('/play')), false);
});

test('failed cleanup retains ownership and prevents a second tone', async () => {
  let denyDelete = false;
  const h = harness({ beforeRequest: async (_url, options) => {
    if (options.method === 'DELETE' && denyDelete) return response({ error: 'unavailable' }, 503);
  } });
  await h.player.update(desired(24));
  const id = h.player.playback.cueId;
  denyDelete = true;
  await h.player.update(desired(120));
  assert.equal(h.player.playback.cueId, id);
  assert.equal(h.cues.size, 1);
  assert.equal(h.player.error, 'unavailable');
  denyDelete = false;
  await h.player.update(null);
  assert.equal(h.cues.size, 0);
  assert.equal(h.player.error, null);
});

test('network, auth, and non-canonical 404 cleanup failures retain the exact cue', async () => {
  for (const failure of [
    () => { throw new TypeError('network down'); },
    () => response({ error: 'unauthorized' }, 401),
    () => response({ error: 'proxy route missing' }, 404),
  ]) {
    let failDelete = false;
    const h = harness({ beforeRequest: async (_url, options) => {
      if (failDelete && options.method === 'DELETE') return failure();
    } });
    await h.player.update(desired());
    const cueId = h.player.playback.cueId;
    failDelete = true;
    await h.player.update(null);
    assert.equal(h.player.playback.cueId, cueId);
    assert.equal(h.cues.size, 1);
  }
});

test('cleanup retry preserves ownership and never creates a second tone', async () => {
  let failDelete = true;
  const h = harness({ beforeRequest: async (_url, options) => {
    if (failDelete && options.method === 'DELETE') throw new TypeError('network down');
  } });
  await h.player.update(desired());
  const cueId = h.player.playback.cueId;
  await h.player.update(null);
  assert.equal(h.player.playback.cueId, cueId);
  failDelete = false;
  await h.player.update(null);
  assert.equal(h.player.playback, null);
  assert.equal(h.cues.size, 0);
  assert.equal(h.requests.filter(request => request.url.endsWith('/api/diagnostics/av-sync')).length, 1);
});

test('canonical 404 for the exact owned cue confirms cleanup', async () => {
  const h = harness();
  await h.player.update(desired());
  h.cues.clear();
  await h.player.update(null);
  assert.equal(h.player.playback, null);
  assert.equal(h.player.error, null);
});

test('play failure releases the loaded cue and reports the real failure', async () => {
  const h = harness({ beforeRequest: async url => {
    if (url.endsWith('/play')) return response({ error: 'device unavailable' }, 409);
  } });
  await h.player.update(desired());
  assert.equal(h.cues.size, 0);
  assert.equal(h.player.playback, null);
  assert.equal(h.player.error, 'device unavailable');
});

test('remote creation uploads the exact bundled bytes, not a client filesystem path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cue-card-test-'));
  try {
    const file = path.join(root, '60.webm');
    const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0xfe]);
    await writeFile(file, bytes);
    const h = harness({ assetPath: () => file });
    await h.player.update(desired(60, { connection: { ...connection, local: false } }));
    const { options } = h.requests[0];
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get('file_path'), null);
    assert.equal(options.body.get('file').name, '60.webm');
    assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()), bytes);
    assert.equal(h.cues.size, 1);
    await h.player.update(null);
    assert.equal(h.cues.size, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('video failure stops its tone and stays visible until an explicit restart', async () => {
  const h = harness();
  await h.player.update(desired());
  await h.player.fail('Video could not decode', connection);
  assert.equal(h.cues.size, 0);
  assert.equal(h.player.playback, null);
  assert.equal(h.player.error, 'Video could not decode');
  await h.player.update(desired());
  assert.equal(h.cues.size, 1);
  assert.equal(h.player.error, null);
  await h.player.update(null);
});

test('managed credential rotation preserves the exact owned cue endpoint', () => {
  const sessionConnection = { serverUrl: 'http://127.0.0.1:4480', accessToken: 'old', local: true };
  assert.deepEqual(cleanupConnectionFor(sessionConnection, null, { port: 4480, accessToken: 'new' }), {
    serverUrl: sessionConnection.serverUrl,
    accessToken: 'new',
    local: true,
  });
  assert.equal(cleanupConnectionFor(sessionConnection, null, { port: 4481, accessToken: 'new' }), null);
  assert.equal(cleanupConnectionFor(
    { serverUrl: 'https://remote.example:4480', accessToken: 'old', local: false },
    null,
    { port: 4480, accessToken: 'new' },
  ), null);
});

test('shutdown can confirm absence using a restarted server credential on the same endpoint', async () => {
  let restarted = false;
  const h = harness({ beforeRequest: async (_url, options) => {
    if (restarted && options.method === 'DELETE' && options.headers.Authorization === 'Bearer credential') {
      return response({ error: 'unauthorized' }, 401);
    }
  } });
  await h.player.update(desired());
  restarted = true;
  h.cues.clear();
  await h.player.update(null, { ...connection, accessToken: 'replacement' });
  assert.equal(h.player.playback, null);
  assert.equal(h.player.error, null);
  assert.equal(h.requests.at(-1).options.headers.Authorization, 'Bearer replacement');
  assert.ok(h.requests.every(r => new URL(r.url).origin === connection.serverUrl));
});
