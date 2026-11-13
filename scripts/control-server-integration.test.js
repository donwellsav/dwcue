const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { constants } = require('node:fs');
const { mkdir, mkdtemp, open, readFile, rename, rm, stat, utimes, writeFile } = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const serverBinary = process.env.DWCUE_TEST_SERVER_BINARY || path.join(root, 'server', 'build', process.platform === 'win32' ? 'dwcue-server.exe' : 'dwcue-server');
const accessToken = 'integration-test-token-1234';

test('project session preconditions reject delayed edits after switching or reopening a show', { timeout: 30000 }, async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'dwcue-project-session-'));
  const writeGate = path.join(folder, 'new-show-write.gate');
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(serverBinary, ['--bind', '127.0.0.1', '--port', String(port)], {
    cwd: folder,
    env: { ...process.env, LIVEPLAY_STATE_DIR: path.join(folder, 'state'),
      LIVEPLAY_ACCESS_TOKEN: accessToken, LIVEPLAY_ALLOWED_ORIGINS: baseUrl,
      DWCUE_TEST_NEW_SHOW_WRITE_GATE: writeGate },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stdout.on('data', chunk => { diagnostics += chunk; });
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  t.after(async () => { await stopServer(child); await rm(folder, { recursive: true, force: true }); });
  const project = name => ({ name, version: '2.0.0', folderPath: folder,
    items: ['shared', 'sibling'].map(uuid => ({ uuid, type: 'group', children: [], displayName: `${name}-${uuid}` })),
    cartOnlyItems: [], cartItems: [{ slot: 0, itemUuid: 'shared' }],
    settings: { autoSave: true }, theme: { accentColor: '#123456' },
  });
  const p = path.join(folder, 'P.dwcue'), q = path.join(folder, 'Q.dwcue');
  const load = async file => {
    const response = await request(baseUrl, '/api/project/load', { method: 'POST', body: JSON.stringify({ path: file }) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const current = async () => {
    for (let i = 0; i < 100; i++) {
      const progress = await (await request(baseUrl, '/api/project/progress')).json();
      if (!progress.loading) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const doc = await (await request(baseUrl, '/api/project')).json();
    return { name: doc.name, items: doc.items, cartItems: doc.cartItems, theme: doc.theme, settings: doc.settings,
      path: doc.server.projectFilePath, session: doc.server.projectSessionId };
  };
  const actions = [
    ['PATCH', '/api/project/items/shared', { displayName: 'late-edit' }],
    ['POST', '/api/project/items', { item: { uuid: 'late-add', type: 'group', children: [] } }],
    ['DELETE', '/api/project/items/shared', {}],
    ['POST', '/api/project/items/reorder', { uuids: ['sibling', 'shared'] }],
    ['POST', '/api/project/cart', { slot: 0, itemUuid: 'sibling' }],
    ['DELETE', '/api/project/cart/0', {}],
    ['PATCH', '/api/project/theme', { accentColor: '#abcdef' }],
    ['PATCH', '/api/project/settings', { autoSave: false }],
    ['PUT', '/api/project/document', project('late-replacement')],
    ['POST', '/api/project/save', { path: p, document: project('late-save') }],
    ['POST', '/api/project/export', { folderPath: path.dirname(p), outputPath: path.join(path.dirname(p), 'Test.dwcuepack') }],
    ['POST', '/api/project/close', {}],
    ['POST', '/api/project/repair', {}],
    ['POST', '/api/project/load', { path: p }],
  ];
  try {
    await waitForServer(baseUrl, child);
    for (const reopen of [false, true]) {
      for (const [method, pathname, body] of actions) {
        await t.test(`${reopen ? 'same-file reopen' : 'P to Q'}: ${method} ${pathname}`, async () => {
          await writeFile(p, JSON.stringify(project('P')));
          await writeFile(q, JSON.stringify(project('Q')));
          const header = await load(p);
          const oldSession = header.server.projectSessionId ?? 'before-session-support';
          const bytes = Buffer.from(JSON.stringify(body));
          let response;
          const completed = new Promise((resolve, reject) => {
            response = http.request(`${baseUrl}${pathname}`, { method,
              headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json',
                'Content-Length': bytes.length, 'X-DWCUE-Project-Session': oldSession },
            }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
            response.on('error', reject);
            response.setTimeout(3000, () => response.destroy(new Error('delayed project request timed out')));
          });
          await new Promise((resolve, reject) => response.write(bytes.subarray(0, bytes.length - 1), error => error ? reject(error) : resolve()));
          try {
            await load(reopen ? p : q);
            const before = await current();
            response.end(bytes.subarray(bytes.length - 1));
            assert.equal(await completed, 409, 'an already-sent old-session request must be rejected');
            assert.deepEqual(await current(), before, 'the active show must remain untouched');
            if (method === 'DELETE' && pathname === '/api/project/cart/0') {
              const bound = await request(baseUrl, '/api/project/cart', { method: 'POST', body: JSON.stringify({ slot: 0, itemUuid: 'shared' }),
                headers: { 'X-DWCUE-Project-Session': before.session } });
              assert.equal(bound.status, 200, await bound.text());
            }
            const valid = await request(baseUrl, pathname, { method, body: JSON.stringify(body),
              headers: { 'X-DWCUE-Project-Session': before.session } });
            assert.equal(valid.status, 200, await valid.text());
          } finally { response.destroy(); }
        });
      }
    }
    await t.test('normal saves preserve the session; Save As, close and same-file open replace it', async () => {
      await writeFile(p, JSON.stringify(project('P')));
      const first = await load(p);
      const session = first.server.projectSessionId;
      assert.equal(typeof session, 'string');
      assert.ok(session.length > 0);
      const save = await request(baseUrl, '/api/project/save', { method: 'POST', body: JSON.stringify({ path: p, document: project('P') }),
        headers: { 'X-DWCUE-Project-Session': session } });
      assert.equal(save.status, 200, await save.text());
      assert.equal((await current()).session, session);
      const updated = await request(baseUrl, '/api/project/document', { method: 'PUT', body: JSON.stringify({ ...project('P'), playbackKeys: { go: null } }),
        headers: { 'X-DWCUE-Project-Session': session } });
      assert.equal(updated.status, 200, await updated.text());
      assert.equal((await current()).session, session, 'in-place full-document updates must not invalidate other editors');
      const saveAs = await request(baseUrl, '/api/project/save', { method: 'POST', body: JSON.stringify({ path: q }),
        headers: { 'X-DWCUE-Project-Session': session } });
      assert.equal(saveAs.status, 200, await saveAs.text());
      const savedSession = (await current()).session;
      assert.notEqual(savedSession, session);
      const reopened = await load(q);
      assert.notEqual(reopened.server.projectSessionId, savedSession);
      const stalePage = await request(baseUrl, '/api/project/items?offset=0&limit=100', {
        headers: { 'X-DWCUE-Project-Session': savedSession } });
      assert.equal(stalePage.status, 409, 'paged hydration cannot mix two show sessions');
    });
    await t.test('new document loads publish an empty path and a new session before the first save', async () => {
      const before = await current();
      const loaded = await request(baseUrl, '/api/project/load', { method: 'POST', body: JSON.stringify({ document: project('New') }),
        headers: { 'X-DWCUE-Project-Session': before.session } });
      assert.equal(loaded.status, 200, await loaded.clone().text());
      const header = await loaded.json();
      assert.equal(header.server.projectFilePath, '');
      assert.notEqual(header.server.projectSessionId, before.session);
      const saved = await request(baseUrl, '/api/project/save', { method: 'POST', body: JSON.stringify({ path: q, document: project('New') }),
        headers: { 'X-DWCUE-Project-Session': header.server.projectSessionId } });
      assert.equal(saved.status, 200, await saved.text());
      assert.equal((await current()).path, q);
    });
    await t.test('rejected show files and failed New Show writes preserve playing cues', async () => {
      const media = path.join(folder, 'show-bed.wav');
      await writeFile(media, silentWav(10));
      await writeFile(p, JSON.stringify({ ...project('Running'), items: [{
        uuid: 'show-bed', type: 'audio', displayName: 'Show bed', mediaServerPath: media,
        duration: 10, endBehavior: { action: 'loop' },
      }] }));
      await load(p);
      const before = await current();
      const play = await request(baseUrl, '/api/project/items/show-bed/play', {
        method: 'POST', body: '{}',
      });
      assert.equal(play.status, 200, await play.text());
      const playing = async () => (await (await request(baseUrl, '/api/state/summary')).json())
        .playing.map(item => item.itemUuid);
      assert.deepEqual(await playing(), ['show-bed']);
      const broken = path.join(folder, 'Broken.dwcue');
      const unrelated = path.join(folder, 'Unrelated.dwcue');
      const legacy = path.join(folder, 'Foreign.liveplay');
      await writeFile(broken, '{');
      await writeFile(unrelated, '{"event":"This is not a show"}');
      const createPath = path.join(folder, 'New.dwcue');
      const newShow = { ...project('New'), items: [], cartItems: [] };
      const legacyBytes = JSON.stringify(newShow);
      await writeFile(legacy, legacyBytes);
      const originalBytes = await readFile(p, 'utf8');
      const change = (route, body) => request(baseUrl, `/api/project/${route}`, {
        method: 'POST', body: JSON.stringify(body),
        headers: { 'X-DWCUE-Project-Session': before.session },
      });
      const lease = async () => {
        const response = await request(baseUrl, '/api/project/header?open_deadline=1');
        assert.equal(response.status, 200);
        const { openDeadlineMs, createDeadlineSupported } = await response.json();
        assert.ok(Number.isSafeInteger(openDeadlineMs) && openDeadlineMs > 0);
        assert.equal(createDeadlineSupported, true);
        return openDeadlineMs;
      };
      const openDeadlineMs = await lease();
      for (const [route, body, status] of [
        ['load', { path: broken }, 400],
        ['load', { path: unrelated }, 400],
        ['load', { path: path.join(folder, 'Missing.dwcue') }, 400],
        ['load', { path: legacy }, 400],
        ['import-legacy', { path: legacy }, 404],
        ['load', { create: { document: newShow, path: createPath } }, 400],
        ['load', { create: { document: newShow, path: path.join(folder, 'missing', 'New.dwcue') }, openDeadlineMs }, 500],
        ['load', { create: { document: newShow, path: p }, openDeadlineMs }, 409],
      ]) {
        const result = await change(route, body);
        assert.equal(result.status, status, await result.text());
        assert.deepEqual(await current(), before);
        assert.deepEqual(await playing(), ['show-bed']);
      }
      assert.equal(await readFile(p, 'utf8'), originalBytes);
      assert.equal(await readFile(legacy, 'utf8'), legacyBytes);
      await assert.rejects(readFile(path.join(folder, 'Foreign.dwcue')), { code: 'ENOENT' });
      const extractPath = path.join(folder, 'foreign-archive');
      const archiveRefused = await change('import', {
        archivePath: path.join(folder, 'Foreign.LPA'), extractPath,
      });
      assert.equal(archiveRefused.status, 400);
      assert.match(await archiveRefused.text(), /archivePath must use \.dwcuepack/);
      const uploadRefused = await request(baseUrl, '/api/upload/start', {
        method: 'POST', body: JSON.stringify({
          filename: 'Foreign.LPA', size: 16, purpose: 'project_import', extract_path: extractPath,
        }),
      });
      assert.equal(uploadRefused.status, 400);
      assert.match(await uploadRefused.text(), /filename must use \.dwcuepack/);
      assert.deepEqual(await current(), before);
      assert.deepEqual(await playing(), ['show-bed']);
      await writeFile(q, JSON.stringify(newShow));
      const expired = await change('load', { path: q, openDeadlineMs: 0 });
      assert.equal(expired.status, 410, await expired.text());
      assert.deepEqual(await current(), before);
      assert.deepEqual(await playing(), ['show-bed']);

      if (process.platform !== 'win32') {
        const delayed = path.join(folder, 'Delayed.dwcue');
        const fifo = spawn('mkfifo', [delayed]);
        assert.equal(await new Promise(resolve => fifo.once('exit', resolve)), 0);
        // Shorten the engine's 25-second lease to hold a real file read past expiry.
        const pending = change('load', { path: delayed, openDeadlineMs: await lease() - 24_000 });
        let writer;
        try {
          for (let attempt = 0; attempt < 80 && !writer; ++attempt) {
            try { writer = await open(delayed, constants.O_WRONLY | constants.O_NONBLOCK); }
            catch (error) {
              if (error.code !== 'ENXIO') throw error;
              await new Promise(resolve => setTimeout(resolve, 10));
            }
          }
          assert.ok(writer, 'the engine must be reading the delayed file');
          await new Promise(resolve => setTimeout(resolve, 1100));
          assert.deepEqual(await playing(), ['show-bed']);
          await writer.writeFile(JSON.stringify(newShow));
        } finally { await writer?.close(); }
        const rejected = await pending;
        assert.equal(rejected.status, 410, await rejected.text());
        assert.deepEqual(await current(), before);
        assert.deepEqual(await playing(), ['show-bed']);
      }

      const create = { document: newShow, path: createPath };
      const expiredCreate = await change('load', { create, openDeadlineMs: 0 });
      assert.equal(expiredCreate.status, 412, await expiredCreate.text());
      await assert.rejects(readFile(createPath), { code: 'ENOENT' });
      assert.deepEqual(await current(), before);
      assert.deepEqual(await playing(), ['show-bed']);

      const latePath = path.join(folder, 'Late.dwcue');
      const waitForWrite = async () => {
        for (let attempt = 0; attempt < 80; ++attempt) {
          if (await readFile(writeGate + '.entered').then(() => true, () => false)) return;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.fail('the engine did not enter the held New Show write');
      };
      await writeFile(writeGate, '');
      const pendingCreate = change('load', {
        create: { ...create, path: latePath }, openDeadlineMs: await lease() - 24_000,
      });
      try {
        await waitForWrite();
        assert.deepEqual(await playing(), ['show-bed']);
        const stop = await request(baseUrl, '/api/transport/stop_all', {
          method: 'POST', body: JSON.stringify({ fade_ms: 0 }),
        });
        assert.equal(stop.status, 200, await stop.text());
        assert.deepEqual(await playing(), []);
        assert.deepEqual(await current(), before);
        await new Promise(resolve => setTimeout(resolve, 1100));
      } finally { await rm(writeGate, { force: true }); }
      const savedLate = await pendingCreate;
      assert.equal(savedLate.status, 410, await savedLate.clone().text());
      assert.ok((await savedLate.json()).error.endsWith(latePath));
      assert.equal(JSON.parse(await readFile(latePath, 'utf8')).name, 'New');
      assert.deepEqual(await current(), before);
      assert.deepEqual(await playing(), []);

      const created = await change('load', { create, openDeadlineMs: await lease() });
      assert.equal(created.status, 200, await created.clone().text());
      const header = await created.json();
      assert.equal(header.server.projectFilePath, createPath);
      assert.notEqual(header.server.projectSessionId, before.session);
      assert.equal(JSON.parse(await readFile(createPath, 'utf8')).name, 'New');
      assert.deepEqual(await playing(), []);
      const fresh = await request(baseUrl, '/api/project/load', {
        method: 'POST', body: JSON.stringify({ path: latePath, openDeadlineMs: await lease() }),
      });
      assert.equal(fresh.status, 200, await fresh.clone().text());
      const reopened = (await fresh.json()).server;
      assert.equal(reopened.projectFilePath, latePath);

      const supersededPath = path.join(folder, 'Superseded.dwcue');
      await rm(writeGate + '.entered');
      await writeFile(writeGate, '');
      const superseded = request(baseUrl, '/api/project/load', {
        method: 'POST',
        body: JSON.stringify({ create: { ...create, path: supersededPath }, openDeadlineMs: await lease() }),
        headers: { 'X-DWCUE-Project-Session': reopened.projectSessionId },
      });
      let replacement;
      try {
        await waitForWrite();
        replacement = await load(q);
      } finally { await rm(writeGate, { force: true }); }
      const savedSuperseded = await superseded;
      assert.equal(savedSuperseded.status, 410, await savedSuperseded.text());
      assert.equal(JSON.parse(await readFile(supersededPath, 'utf8')).name, 'New');
      assert.equal((await current()).session, replacement.server.projectSessionId);
    });
    await t.test('a repaired show stays usable and reports its repairs until the file is saved', async () => {
      const file = path.join(folder, 'Repair.dwcue');
      const media = path.join(folder, 'show-bed.wav');
      const cue = { uuid: 'repair-bed', type: 'audio', displayName: 'Bed', mediaServerPath: media,
        duration: 10, endBehavior: { action: 'loop' } };
      const original = JSON.stringify({ ...project('Repair'), items: [cue, cue] });
      await writeFile(file, original);
      const opened = await request(baseUrl, '/api/project/load', { method: 'POST', body: JSON.stringify({ path: file }) });
      assert.equal(opened.status, 200, await opened.clone().text());
      const accepted = await opened.json();
      assert.equal(accepted.needsRepair, true);
      assert.equal(accepted.itemCount, 1);
      const header = async () => (await request(baseUrl, '/api/project/header')).json();
      assert.deepEqual((await header()).repairIssues, accepted.repairIssues);
      const session = accepted.server.projectSessionId;
      const save = () => request(baseUrl, '/api/project/save', {
        method: 'POST', body: '{}', headers: { 'X-DWCUE-Project-Session': session },
      });
      const tmp = file + '.tmp';
      await mkdir(tmp);
      assert.equal((await save()).status, 500);
      assert.equal(await readFile(file, 'utf8'), original);
      assert.equal((await header()).needsRepair, true);
      assert.equal((await current()).session, session);
      const play = await request(baseUrl, '/api/project/items/repair-bed/play', { method: 'POST', body: '{}' });
      assert.equal(play.status, 200, await play.text());
      await rm(tmp, { recursive: true });
      assert.equal((await save()).status, 200);
      assert.equal((await header()).needsRepair, false);
      assert.equal(JSON.parse(await readFile(file, 'utf8')).items.length, 1);
      await load(q);
      assert.equal((await save()).status, 409);
    });
  } catch (error) { error.message += `\nNative server diagnostics:\n${diagnostics}`; throw error; }
});

async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function silentWav(seconds = 1) {
  const dataBytes = 48_000 * 2 * seconds;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48_000, 24); wav.writeUInt32LE(96_000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

test('waveform caches and analysis identify the current file revision', { timeout: 15000 }, async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'dwcue-waveform-revision-'));
  const media = path.join(folder, 'media.wav'), show = path.join(folder, 'show.dwcue');
  const date = new Date('2020-01-01T00:00:00Z');
  const samples = value => {
    const bytes = silentWav();
    for (let i = 44; i < bytes.length; i += 2) bytes.writeInt16LE(value, i);
    return bytes;
  };
  await writeFile(media, samples(8192)); await utimes(media, date, date);
  await writeFile(show, JSON.stringify({ name: 'waveform-revision', folderPath: folder,
    items: [{ uuid: 'media', type: 'audio', displayName: 'media', mediaServerPath: media }],
    cartOnlyItems: [], cartItems: [], settings: {} }));
  const port = await unusedPort(), baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(serverBinary, ['--bind', '127.0.0.1', '--port', String(port)], {
    cwd: folder, env: { ...process.env, LIVEPLAY_STATE_DIR: path.join(folder, 'state'),
      LIVEPLAY_ACCESS_TOKEN: accessToken, LIVEPLAY_ALLOWED_ORIGINS: baseUrl }, stdio: 'ignore',
  });
  t.after(async () => { await stopServer(child); await rm(folder, { recursive: true, force: true }); });
  await waitForServer(baseUrl, child);
  const loaded = await request(baseUrl, '/api/project/load', { method: 'POST', body: JSON.stringify({ path: show }) });
  assert.equal(loaded.status, 200, await loaded.text());
  for (let i = 0; i < 100; i++) {
    if (!(await (await request(baseUrl, '/api/project/progress')).json()).loading) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const original = await (await request(baseUrl, '/api/project')).json();
  const ws = openEventStream(baseUrl.replace('http', 'ws') + `/ws?access_token=${accessToken}`); await ws.opened;
  t.after(() => ws.socket.close());
  const generate = async () => {
    const ready = ws.next(message => message.op === 'waveform_ready' && message.item_uuid === 'media');
    const response = await request(baseUrl, '/api/waveform_generate', {
      method: 'POST', body: JSON.stringify({ path: media, item_uuid: 'media' }),
    });
    assert.equal(response.status, 200, await response.text());
    return ready;
  };
  const first = await generate();
  assert.ok(Math.abs(Math.max(...first.channels[0].peak) - 0.25) < 1e-5);
  const metadata = await (await request(baseUrl, `/api/metadata?path=${encodeURIComponent(media)}`)).json();
  await t.test('analysis and cache carry the probed revision', async () => {
    assert.equal(first.file_revision, metadata.file_revision);
    const cached = JSON.parse(await readFile(path.join(folder, 'waveforms', 'media.json')));
    assert.equal(cached.file_revision, metadata.file_revision);
  });
  await t.test('player media is scoped to the loaded file revision and project session', async () => {
    assert.equal(original.server.audioReadiness.fileRevisions?.media, metadata.file_revision);
    const good = await request(baseUrl, `/api/media?item_uuid=media&file_revision=${encodeURIComponent(metadata.file_revision)}&project_session_id=${original.server.projectSessionId}`, { method: 'HEAD' });
    assert.equal(good.status, 200);
    assert.equal(good.headers.get('X-DWCUE-Media-Revision'), metadata.file_revision);
    const stale = await request(baseUrl, '/api/media?item_uuid=media&file_revision=outdated', { method: 'HEAD' });
    assert.equal(stale.status, 409);
    const wrongShow = await request(baseUrl, '/api/media?item_uuid=media&project_session_id=outdated', { method: 'HEAD' });
    assert.equal(wrongShow.status, 409);
  });
  const replacement = `${media}.replacement`;
  await writeFile(replacement, samples(16384)); await utimes(replacement, date, date);
  await rename(replacement, media);
  let reloaded = false;
  for (let i = 0; i < 400; i++) {
    const document = await (await request(baseUrl, '/api/project')).json();
    const progress = await (await request(baseUrl, '/api/project/progress')).json();
    if (document.items[0].cueId !== original.items[0].cueId && progress.ready) { reloaded = true; break; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(reloaded, 'the stopped decoder must reload the replacement');
  const second = await generate();
  await t.test('same UUID/path/size/date never reuses peaks from the replaced file', () => {
    assert.ok(Math.abs(Math.max(...second.channels[0].peak) - 0.5) < 1e-5);
    assert.notEqual(second.file_revision, first.file_revision);
  });
  await t.test('synchronous path analysis carries the current revision too', async () => {
    const waveform = await (await request(baseUrl, `/api/waveform_path?path=${encodeURIComponent(media)}`)).json();
    const current = await (await request(baseUrl, `/api/metadata?path=${encodeURIComponent(media)}`)).json();
    assert.equal(waveform.file_revision, current.file_revision);
  });
  await t.test('decode-only verification checks the exact media revision and rejects unreadable audio', async () => {
    const verify = (file, revision) => request(baseUrl, `/api/waveform_path?${new URLSearchParams({ path: file, verify_revision: revision })}`);
    const response = await verify(media, second.file_revision);
    assert.equal(response.status, 200, await response.clone().text());
    const decoded = await response.json();
    assert.equal(decoded.verified, true);
    assert.equal(decoded.duration_ms, 1000);
    assert.equal(decoded.file_revision, second.file_revision);
    assert.deepEqual(decoded.channels, []);
    assert.equal((await verify(media, first.file_revision)).status, 409);

    const invalid = path.join(folder, 'unreadable.wav');
    await writeFile(invalid, 'no audio stream');
    const probe = await (await request(baseUrl, `/api/metadata?path=${encodeURIComponent(invalid)}`)).json();
    assert.equal((await verify(invalid, probe.file_revision)).status, 500);
  });
  await t.test('a stale media upload cannot stage a file in the replacement show', async () => {
    const stale = await request(baseUrl, '/api/upload/start', {
      method: 'POST', body: JSON.stringify({ filename: 'late.wav', size: 64, purpose: 'media' }),
      headers: { 'X-DWCUE-Project-Session': 'superseded-session' },
    });
    assert.equal(stale.status, 409, await stale.text());
  });
  await t.test('old-session analysis requests are rejected before writing a cache', async () => {
    const stale = await request(baseUrl, '/api/waveform_generate', { method: 'POST',
      headers: { 'X-DWCUE-Project-Session': 'superseded-session' },
      body: JSON.stringify({ path: media, item_uuid: 'late-old-show' }) });
    assert.equal(stale.status, 409, await stale.text());
  });
});

test('crash recovery respects newer intent and resumes without repeating crossed actions', { timeout: 45000 }, async t => {
  for (const action of ['none', 'stop', 'panic', 'play', 'close', 'replace', 'load', 'automation']) {
    await t.test(action, async t => {
      const folder = await mkdtemp(path.join(os.tmpdir(), 'dwcue-crash-recovery-'));
      const stateDir = path.join(folder, 'state');
      const media = path.join(folder, 'silence.wav');
      const show = path.join(folder, 'show.dwcue');
      await mkdir(stateDir);
      await writeFile(media, silentWav(10));
      const cue = uuid => ({ uuid, type: 'audio', displayName: uuid, mediaServerPath: media,
        duration: 10, playFade: 0, fadeOutDuration: 0, duckingBehavior: { mode: 'no-ducking' },
        endBehavior: { action: 'loop' } });
      const recovering = cue('recovering');
      if (action === 'automation') {
        recovering.startBehavior = { action: 'play-item', targetUuid: 'newer' };
        recovering.customActions = [{ timePoint: 0.2, action: { type: 'stop-all' } }];
      }
      const document = { name: 'recovery', folderPath: folder, items: [recovering, cue('newer')],
        cartOnlyItems: [], cartItems: [], settings: {} };
      await writeFile(show, JSON.stringify(document));
      await writeFile(path.join(stateDir, '.crash-resume.json'), JSON.stringify({
        projectFile: show, itemUuid: 'recovering', positionSec: 0.6,
      }));
      const port = await unusedPort(), baseUrl = `http://127.0.0.1:${port}`;
      const child = spawn(serverBinary, ['--bind', '127.0.0.1', '--port', String(port)], {
        cwd: folder, env: { ...process.env, LIVEPLAY_STATE_DIR: stateDir,
          LIVEPLAY_ACCESS_TOKEN: accessToken, LIVEPLAY_ALLOWED_ORIGINS: baseUrl },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let diagnostics = '';
      child.stdout.on('data', chunk => { diagnostics += chunk; });
      child.stderr.on('data', chunk => { diagnostics += chunk; });
      t.after(async () => { await stopServer(child); await rm(folder, { recursive: true, force: true }); });
      await waitForServer(baseUrl, child);
      for (let i = 0; i < 100; i++) {
        const doc = await (await request(baseUrl, '/api/project/header')).json();
        const progress = await (await request(baseUrl, '/api/project/progress')).json();
        if (doc.name === 'recovery' && !progress.loading) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const send = async (route, body = {}, method = 'POST') => {
        const response = await request(baseUrl, route, { method, body: JSON.stringify(body) });
        assert.equal(response.status, 200, await response.text());
      };
      if (action === 'stop') await send('/api/project/items/recovering/stop');
      if (action === 'panic') await send('/api/transport/stop_all', { fade_ms: 0 });
      if (action === 'play') await send('/api/project/items/newer/play');
      if (action === 'close') await send('/api/project/close');
      if (action === 'replace') await send('/api/project/load', { document: { ...document, name: 'replacement' } });
      if (action === 'load') await send('/api/project/load', { path: show });
      await new Promise(resolve => setTimeout(resolve, 3500));
      const summary = await (await request(baseUrl, '/api/state/summary')).json();
      assert.equal(child.exitCode ?? child.signalCode, null, diagnostics);
      const expected = action === 'play' ? ['newer'] : ['none', 'automation'].includes(action) ? ['recovering'] : [];
      assert.deepEqual(summary.playing.map(item => item.itemUuid).sort(), expected, diagnostics);
      if (action === 'none' || action === 'automation')
        assert.ok(summary.playing[0].playheadSec >= 0.6, 'recovery must apply sub-second position before play');
    });
  }
});

async function waitForServer(baseUrl, child, closeConnection = false) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assert.equal(child.exitCode ?? child.signalCode, null, `server exited before becoming ready (exit ${child.exitCode}, signal ${child.signalCode})`);
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { Authorization: `Bearer ${accessToken}`, ...(closeConnection ? { Connection: 'close' } : {}) },
        signal: AbortSignal.timeout(250),
      });
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`server did not become ready: ${lastError}`);
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    let forceTimer;
    const onExit = () => {
      if (forceTimer) clearTimeout(forceTimer);
      resolve();
    };
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.removeListener('exit', onExit);
      resolve();
      return;
    }
    forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 2000);
    child.kill('SIGTERM');
  });
}

function openEventStream(url) {
  const socket = new WebSocket(url);
  const messages = [];
  const waiters = [];

  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    const waiterIndex = waiters.findIndex(waiter => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      messages.push(message);
    }
  });

  const opened = new Promise((resolve, reject) => {
    const openTimer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for WebSocket to open'));
    }, 2000);
    const cleanup = () => {
      clearTimeout(openTimer);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('WebSocket failed to open'));
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
  });

  function next(predicate) {
    const index = messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: undefined };
      waiters.push(waiter);
      waiter.timer = setTimeout(() => {
        const pendingIndex = waiters.indexOf(waiter);
        if (pendingIndex >= 0) {
          waiters.splice(pendingIndex, 1);
          reject(new Error('timed out waiting for WebSocket event'));
        }
      }, 2000);
    });
  }

  return { socket, opened, next };
}

async function request(baseUrl, pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    signal: AbortSignal.timeout(2000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
}

test('media readers cannot block WebSocket control, HTTP framing, or cancellation', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dwcue-media-backpressure-'));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const mediaPath = path.join(home, 'range-contract.mp4');
  const bytes = Buffer.alloc(20 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
  await writeFile(mediaPath, bytes);
  await mkdir(path.join(home, 'static'));
  await writeFile(path.join(home, 'static', 'head.bin'), bytes.subarray(0, 4096));
  const child = spawn(serverBinary, ['--bind', '127.0.0.1', '--port', String(port)], {
    cwd: home,
    env: { ...process.env, HOME: home, LIVEPLAY_ACCESS_TOKEN: accessToken,
      LIVEPLAY_ALLOWED_ORIGINS: baseUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stdout.on('data', chunk => { diagnostics += chunk; });
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  t.after(async () => {
    await stopServer(child);
    await rm(home, { recursive: true, force: true });
  });
  try {
    // With no retained HTTP health connection, the first WebSocket and media
    // connection share Crow's least-used I/O worker deterministically.
    await waitForServer(baseUrl, child, true);
    const stream = openEventStream(`ws://127.0.0.1:${port}/ws?access_token=${accessToken}`);
    t.after(() => stream.socket.close());
    await stream.opened;
    const stop = async commandId => {
      const ack = stream.next(message => message.type === 'command_ack' && message.command_id === commandId);
      stream.socket.send(JSON.stringify({ type: 'stop_all', fade_ms: 0, command_id: commandId }));
      assert.equal((await ack).ok, true);
    };
    await stop('media-before');
    const mediaUrl = `/api/media?path=${encodeURIComponent(mediaPath)}&access_token=${accessToken}`;
    const exchange = payload => new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      const chunks = [];
      socket.on('data', chunk => chunks.push(chunk));
      socket.once('connect', () => socket.write(payload));
      socket.once('error', reject);
      socket.once('end', () => resolve(Buffer.concat(chunks)));
      socket.setTimeout(3000, () => socket.destroy(new Error('HTTP exchange timed out')));
    });
    for (const range of [true, false]) {
      await t.test(range ? 'paused range reader' : 'paused whole-file reader', async () => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.on('error', () => {});
        socket.pause();
        try {
          await new Promise((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('error', reject);
          });
          socket.write(`GET ${mediaUrl} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
            (range ? 'Range: bytes=0-\r\n' : '') + 'Connection: close\r\n\r\n');
          await new Promise(resolve => setTimeout(resolve, 200));
          const started = performance.now();
          await stop(`media-during-${range}`);
          assert.ok(performance.now() - started < 1000, 'media backpressure delayed transport acknowledgement');
        } finally {
          socket.destroy();
        }
        await stop(`media-after-abort-${range}`);
      });
    }
    await t.test('exact range bytes and HEAD length', async () => {
      const headers = { Range: 'bytes=70001-74096' };
      const response = await request(baseUrl, mediaUrl, { headers });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), `bytes 70001-74096/${bytes.length}`);
      assert.equal(response.headers.get('content-type'), 'video/mp4');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(70001, 74097));
      const head = await request(baseUrl, mediaUrl, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-length'), String(bytes.length));
      assert.equal((await head.arrayBuffer()).byteLength, 0);
      const rangeHead = await request(baseUrl, mediaUrl, { method: 'HEAD', headers });
      assert.equal(rangeHead.status, 206);
      assert.equal(rangeHead.headers.get('content-length'), '4096');
      assert.equal((await rangeHead.arrayBuffer()).byteLength, 0);
    });
    await t.test('early errors, OPTIONS, malformed requests, and HEAD finish cleanly', async () => {
      const unknown = await request(baseUrl, '/api/no-such-route');
      assert.equal(unknown.status, 404);
      await unknown.arrayBuffer();
      const wrongMethod = await request(baseUrl, '/api/health', { method: 'POST' });
      assert.equal(wrongMethod.status, 405);
      await wrongMethod.arrayBuffer();
      const denied = await fetch(`${baseUrl}/api/media?path=${encodeURIComponent(mediaPath)}`, { signal: AbortSignal.timeout(2000) });
      assert.equal(denied.status, 401);
      await denied.arrayBuffer();
      const options = await fetch(`${baseUrl}/api/project/items/cors-probe`, {
        method: 'OPTIONS', signal: AbortSignal.timeout(2000), headers: {
          Origin: baseUrl, 'Access-Control-Request-Method': 'PATCH',
          'Access-Control-Request-Headers': 'Authorization, Content-Type',
        },
      });
      assert.equal(options.status, 204);
      assert.equal(options.headers.get('access-control-allow-origin'), baseUrl);
      const head = await exchange(`HEAD /api/no-such-route HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${accessToken}\r\nConnection: close\r\n\r\n`);
      assert.match(head.toString(), /^HTTP\/1\.1 404/);
      assert.equal(head.length, head.indexOf('\r\n\r\n') + 4, 'HEAD error response leaked a body');
      const staticHead = await exchange(`HEAD /static/head.bin HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${accessToken}\r\nConnection: close\r\n\r\n`);
      assert.match(staticHead.toString(), /^HTTP\/1\.1 200/);
      assert.match(staticHead.toString(), /content-length: 4096(?:\r\n|$)/i);
      assert.equal(staticHead.length, staticHead.indexOf('\r\n\r\n') + 4, 'implicit static HEAD sent file bytes');
      await exchange(`GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nMalformed Header\r\n\r\n`).catch(error => assert.equal(error.code, 'ECONNRESET'));
      await stop('media-after-malformed');
    });
    await t.test('Expect 100-continue retains one parser and one final response', async () => {
      const body = JSON.stringify({ showMode: true });
      let continuations = 0;
      const response = await new Promise((resolve, reject) => {
        const req = http.request(`${baseUrl}/api/project/settings`, {
          method: 'PATCH', headers: {
            Authorization: `Bearer ${accessToken}`, Expect: '100-continue',
            'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
          },
        }, res => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.once('error', reject);
          res.once('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        });
        req.on('continue', () => { continuations += 1; req.end(body); });
        req.once('error', reject);
        req.setTimeout(2000, () => req.destroy(new Error('100-continue request timed out')));
        req.flushHeaders();
      });
      assert.equal(continuations, 1);
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body).showMode, true);
    });
    await t.test('pipelined responses keep their own bytes until writes finish', async () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      const received = [];
      socket.on('data', chunk => received.push(chunk));
      const completed = new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.once('end', resolve);
        socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('pipelined media response timed out')); });
      });
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
      socket.pause();
      socket.write(`GET ${mediaUrl} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${accessToken}\r\nRange: bytes=0-1048575\r\n\r\n` +
        `HEAD ${mediaUrl} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${accessToken}\r\n\r\n` +
        `GET ${mediaUrl} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${accessToken}\r\nRange: bytes=70001-74096\r\nConnection: close\r\n\r\n`);
      setTimeout(() => socket.resume(), 200);
      await completed;
      const data = Buffer.concat(received);
      let offset = 0;
      for (const [status, length, expected] of [
        [206, 1048576, bytes.subarray(0, 1048576)],
        [200, bytes.length, Buffer.alloc(0)],
        [206, 4096, bytes.subarray(70001, 74097)],
      ]) {
        const end = data.indexOf('\r\n\r\n', offset);
        assert.ok(end >= offset, 'missing pipelined response headers');
        const header = data.subarray(offset, end).toString();
        assert.match(header, new RegExp(`^HTTP/1.1 ${status}`));
        assert.match(header, new RegExp(`content-length: ${length}(?:\\r\\n|$)`, 'i'));
        offset = end + 4;
        assert.deepEqual(data.subarray(offset, offset + expected.length), expected);
        offset += expected.length;
      }
      assert.equal(offset, data.length, 'extra bytes corrupted HTTP response boundaries');
    });
    assert.equal(child.exitCode ?? child.signalCode, null, 'server exited during media cancellation');
  } catch (error) {
    error.message += `\n\nServer diagnostics:\n${diagnostics}`;
    throw error;
  }
});

test('native server echoes mutation IDs only on matching WebSocket events', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dwcue-server-integration-'));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const projectPath = path.join(home, 'mutation-contract.dwcue');
  const child = spawn(serverBinary, ['--bind', '127.0.0.1', '--port', String(port)], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      LIVEPLAY_ACCESS_TOKEN: accessToken,
      LIVEPLAY_ALLOWED_ORIGINS: baseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stdout.on('data', chunk => { diagnostics += chunk; });
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  t.after(async () => {
    await stopServer(child);
    await rm(home, { recursive: true, force: true });
  });

  try {
    await waitForServer(baseUrl, child);

    const preflight = await fetch(`${baseUrl}/api/project/items/cors-probe`, {
      method: 'OPTIONS',
      signal: AbortSignal.timeout(2000),
      headers: {
        Origin: baseUrl,
        'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'X-DWCUE-Mutation-ID, Content-Type',
      },
    });
    assert.ok(preflight.ok, `preflight failed with ${preflight.status}`);
    assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /(?:^|,\s*)X-DWCUE-Mutation-ID(?:,|$)/i);

    const itemUuid = 'mutation-contract-item';
    const create = await request(baseUrl, '/api/project/items', {
      method: 'POST',
      body: JSON.stringify({
        item: { uuid: itemUuid, type: 'audio', displayName: 'Mutation contract cue' },
        parentUuid: '',
        index: 0,
      }),
    });
    assert.equal(create.status, 200, `item creation failed: ${await create.text()}`);

    const stream = openEventStream(`ws://127.0.0.1:${port}/ws?access_token=${encodeURIComponent(accessToken)}`);
    t.after(() => {
      try {
        stream.socket.close();
      } catch (error) {
        if (stream.socket.readyState !== WebSocket.CLOSED) throw error;
      }
    });
    await stream.opened;
    const sendCommand = async payload => {
      const ack = stream.next(message =>
        message.type === 'command_ack' && message.command_id === payload.command_id);
      stream.socket.send(JSON.stringify(payload));
      return ack;
    };
    for (const [commandId, payload] of [
      ['set-next-missing', { type: 'set_next_item' }],
      ['set-next-wrong-type', { type: 'set_next_item', item_uuid: 42 }],
      ['set-next-unknown', { type: 'set_next_item', item_uuid: 'not-a-project-item' }],
    ]) {
      const ack = await sendCommand({ ...payload, command_id: commandId });
      assert.equal(ack.ok, false, commandId);
      assert.match(ack.error, /set_next_item/);
    }
    const acceptedNext = await sendCommand({
      type: 'set_next_item', command_id: 'set-next-valid', item_uuid: itemUuid,
    });
    assert.equal(acceptedNext.ok, true);

    const duplicateAcks = [
      stream.next(message => message.type === 'command_ack' && message.command_id === 'dedup-stop-all'),
      stream.next(message => message.type === 'command_ack' && message.command_id === 'dedup-stop-all'),
    ];
    const duplicatedCommand = JSON.stringify({
      type: 'stop_all', command_id: 'dedup-stop-all', fade_ms: 0,
    });
    stream.socket.send(duplicatedCommand);
    stream.socket.send(duplicatedCommand);
    const [firstDuplicate, secondDuplicate] = await Promise.all(duplicateAcks);
    assert.deepEqual(secondDuplicate, firstDuplicate);
    const firstPong = stream.next(message => message.type === 'pong');
    stream.socket.send(JSON.stringify({ type: 'ping', command_id: 'dedup-ping' }));
    const pongA = await firstPong;
    const duplicatePong = stream.next(message => message.type === 'pong');
    stream.socket.send(JSON.stringify({ type: 'ping', command_id: 'dedup-ping' }));
    const pongB = await duplicatePong;
    assert.deepEqual(pongB, pongA, 'duplicate ping must resolve from the bounded result cache');
    for (let index = 0; index < 260; index += 1) {
      const earlyError = await sendCommand({
        type: 'unsupported-integration-command',
        command_id: `dedup-early-error-${index}`,
      });
      assert.equal(earlyError.ok, false);
      assert.equal(earlyError.error, 'unknown type');
    }
    const pongAfterEviction = stream.next(message => message.type === 'pong');
    stream.socket.send(JSON.stringify({ type: 'ping', command_id: 'dedup-ping' }));
    assert.deepEqual(await pongAfterEviction, pongA,
      'ping must execute again after bounded result-cache eviction');

    const clearNext = await sendCommand({
      type: 'set_next_item', command_id: 'set-next-clear', item_uuid: '',
    });
    assert.equal(clearNext.ok, true);

    const patch = { notes: 'identical payload' };
    for (const mutationId of ['mutation-first', 'mutation-second']) {
      const eventPromise = stream.next(message => message.type === 'doc_patch' && message.op === 'item_updated');
      const response = await request(baseUrl, `/api/project/items/${itemUuid}`, {
        method: 'PATCH',
        headers: { 'X-DWCUE-Mutation-ID': mutationId },
        body: JSON.stringify(patch),
      });
      assert.equal(response.status, 200, `PATCH failed: ${await response.text()}`);
      const event = await eventPromise;
      assert.deepEqual(event.patch, patch);
      assert.equal(event.uuid, itemUuid);
      assert.equal(event.clientMutationId, mutationId);
    }

    const withoutIdPromise = stream.next(message => message.type === 'doc_patch' && message.op === 'item_updated');
    const withoutId = await request(baseUrl, `/api/project/items/${itemUuid}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    assert.equal(withoutId.status, 200, `headerless PATCH failed: ${await withoutId.text()}`);
    const withoutIdEvent = await withoutIdPromise;
    assert.equal(Object.hasOwn(withoutIdEvent, 'clientMutationId'), false);

    const projectResponse = await request(baseUrl, '/api/project');
    assert.equal(projectResponse.status, 200);
    const projectText = await projectResponse.text();
    assert.doesNotMatch(projectText, /clientMutationId|mutation-first|mutation-second/);

    const save = await request(baseUrl, '/api/project/save', {
      method: 'POST',
      body: JSON.stringify({ path: projectPath }),
    });
    assert.equal(save.status, 200, `project save failed: ${await save.text()}`);
    const concurrentSaves = await Promise.all(Array.from({ length: 12 }, () =>
      request(baseUrl, '/api/project/save', {
        method: 'POST', body: JSON.stringify({ path: projectPath }),
      })));
    assert.deepEqual(concurrentSaves.map(response => response.status),
      Array(12).fill(200), 'same-path saves must serialize without temp-file collisions');
    const savedProject = await readFile(projectPath, 'utf8');
    assert.doesNotThrow(() => JSON.parse(savedProject));
    assert.doesNotMatch(savedProject, /clientMutationId|mutation-first|mutation-second/);
    const bytesBeforeFailedSaveAs = await readFile(projectPath, 'utf8');
    const failedPath = path.join(home, 'missing-parent', 'failed.dwcue');
    const failedSaveAs = await request(baseUrl, '/api/project/save', {
      method: 'POST', body: JSON.stringify({ path: failedPath }),
    });
    assert.equal(failedSaveAs.status, 500);
    assert.equal(await readFile(projectPath, 'utf8'), bytesBeforeFailedSaveAs,
      'failed Save As must preserve prior project bytes');
    const afterFailure = await (await request(baseUrl, '/api/project')).json();
    assert.equal(afterFailure.server.projectFilePath, projectPath,
      'failed Save As must preserve current project identity');

    const pathlessAfterFailure = await request(baseUrl, '/api/project/save', {
      method: 'POST', body: JSON.stringify({}),
    });
    assert.equal(pathlessAfterFailure.status, 200);
    assert.equal((await pathlessAfterFailure.json()).path, projectPath,
      'pathless save after failure must publish to the prior identity');

    const documentA = structuredClone(afterFailure);
    const documentB = structuredClone(afterFailure);
    documentA.items.find(item => item.uuid === itemUuid).notes = 'snapshot-a';
    documentB.items.find(item => item.uuid === itemUuid).notes = 'snapshot-b';
    const pathA = path.join(home, 'snapshot-a.dwcue');
    const pathB = path.join(home, 'snapshot-b.dwcue');
    const [saveA, saveB] = await Promise.all([
      request(baseUrl, '/api/project/save', {
        method: 'POST', body: JSON.stringify({ path: pathA, document: documentA }),
      }),
      request(baseUrl, '/api/project/save', {
        method: 'POST', body: JSON.stringify({ path: pathB, document: documentB }),
      }),
    ]);
    assert.equal(saveA.status, 200);
    assert.equal(saveB.status, 200);
    assert.equal((await saveA.json()).path, pathA);
    assert.equal((await saveB.json()).path, pathB);
    const diskA = JSON.parse(await readFile(pathA, 'utf8'));
    const diskB = JSON.parse(await readFile(pathB, 'utf8'));
    assert.equal(diskA.items.find(item => item.uuid === itemUuid).notes, 'snapshot-a');
    assert.equal(diskB.items.find(item => item.uuid === itemUuid).notes, 'snapshot-b');

    const afterConcurrent = await (await request(baseUrl, '/api/project')).json();
    assert.ok([pathA, pathB].includes(afterConcurrent.server.projectFilePath));
    const pathlessConcurrent = await request(baseUrl, '/api/project/save', {
      method: 'POST', body: JSON.stringify({}),
    });
    assert.equal(pathlessConcurrent.status, 200);
    assert.equal((await pathlessConcurrent.json()).path,
      afterConcurrent.server.projectFilePath,
      'pathless save must use the identity committed with the last atomic snapshot');

    stream.socket.close();
  } catch (error) {
    error.message += `\nserver output:\n${diagnostics}`;
    throw error;
  }
});

test('native media, recovery correlation, and authoritative trigger order stay coherent', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dwcue-media-integration-'));
  const loaderGate = path.join(home, 'loader.gate');
  const loaderEntered = loaderGate + '.entered';
  const audioPath = path.join(home, 'trigger-order.wav');
  const gateContents = JSON.stringify(audioPath); // Native gate targets this actual decoder, including paths with spaces.
  await writeFile(loaderGate, gateContents);
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(serverBinary, ['--bind', '127.0.0.1', '--port', String(port)], {
    cwd: home,
    env: {
      ...process.env, HOME: home, LIVEPLAY_ACCESS_TOKEN: accessToken,
      LIVEPLAY_ALLOWED_ORIGINS: baseUrl, DWCUE_TEST_LOADER_GATE: loaderGate,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stdout.on('data', chunk => { diagnostics += chunk; });
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  t.after(async () => {
    await rm(loaderGate, { force: true });
    await stopServer(child);
    await rm(home, { recursive: true, force: true });
  });

  try {
    await waitForServer(baseUrl, child);
    const fallbackPath = path.join(home, 'fallback-video.mp4');
    const bytes = Buffer.from('0123456789abcdef');
    await writeFile(fallbackPath, bytes);
    const itemUuid = 'video-fallback-contract';
    const create = await request(baseUrl, '/api/project/items', {
      method: 'POST',
      body: JSON.stringify({
        item: {
          uuid: itemUuid,
          type: 'video',
          displayName: 'Fallback video',
          mediaPath: 'missing-relative.mp4',
          mediaServerPath: fallbackPath,
        },
        parentUuid: '',
        index: 0,
      }),
    });
    assert.equal(create.status, 200, `item creation failed: ${await create.text()}`);

    const range = await request(baseUrl, `/api/media?item_uuid=${itemUuid}`, {
      headers: { Range: 'bytes=3-7' },
    });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), 'bytes 3-7/16');
    assert.equal(Buffer.from(await range.arrayBuffer()).toString(), '34567');

    const head = await request(baseUrl, `/api/media?item_uuid=${itemUuid}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(head.headers.get('accept-ranges'), 'bytes');

    const direct = await request(baseUrl, `/api/media?path=${encodeURIComponent(fallbackPath)}`);
    assert.equal(direct.status, 200);
    assert.deepEqual(Buffer.from(await direct.arrayBuffer()), bytes);

    const missing = await request(baseUrl, '/api/media?item_uuid=unknown-item');
    assert.equal(missing.status, 404);
    assert.doesNotMatch(await missing.text(), /access_token|fallback-video/);

    const recoveryStream = openEventStream(
      'ws://127.0.0.1:' + port + '/ws?access_token=' + encodeURIComponent(accessToken),
    );
    t.after(() => recoveryStream.socket.close());
    await recoveryStream.opened;

    const devicesResponse = await request(baseUrl, '/api/devices');
    assert.equal(devicesResponse.status, 200);
    const devices = await devicesResponse.json();
    assert.ok(Array.isArray(devices));
    for (const device of devices) {
      assert.equal(typeof device.recovery_request_id, 'number');
      assert.match(device.recovery_status, /^(idle|pending|succeeded|failed)$/);
    }

    // Exercise the full 202 -> correlated terminal WebSocket contract when
    // this host exposes an audio output. Headless CI legitimately cannot open
    // a native device, but still verifies the serialized idle fields above.
    const opened = await request(baseUrl, '/api/devices/open', {
      method: 'POST',
      body: JSON.stringify({ name: '', channels: 2 }),
    });
    if (opened.status === 200) {
      const { device_id: deviceId } = await opened.json();
      const accepted = await request(
        baseUrl,
        '/api/devices/' + encodeURIComponent(deviceId) + '/recover',
        { method: 'POST' },
      );
      assert.equal(accepted.status, 202);
      const acceptedBody = await accepted.json();
      assert.equal(acceptedBody.accepted, true);
      assert.ok(Number.isSafeInteger(acceptedBody.request_id));
      assert.ok(acceptedBody.request_id > 0);

      const terminal = await recoveryStream.next(message =>
        message.type === 'device_state' &&
        message.device?.id === deviceId &&
        message.device?.recovery_request_id === acceptedBody.request_id &&
        /^(succeeded|failed)$/.test(message.device?.recovery_status));
      if (terminal.device.recovery_status === 'succeeded') {
        assert.equal(terminal.device.runtime_state, 'running');
      } else {
        const retryResponse = await request(
          baseUrl,
          '/api/devices/' + encodeURIComponent(deviceId) + '/recover',
          { method: 'POST' },
        );
        assert.equal(retryResponse.status, 202);
        const retryBody = await retryResponse.json();
        assert.ok(retryBody.request_id > acceptedBody.request_id);
        await recoveryStream.next(message =>
          message.type === 'device_state' &&
          message.device?.id === deviceId &&
          message.device?.recovery_request_id === retryBody.request_id &&
          /^(succeeded|failed)$/.test(message.device?.recovery_status));
      }

      const closed = await request(baseUrl, '/api/devices/close', {
        method: 'POST',
        body: JSON.stringify({ id: deviceId }),
      });
      assert.equal(closed.status, 200);
    } else {
      assert.equal(opened.status, 400);
    }
    recoveryStream.socket.close();

    const recovery = await request(baseUrl, '/api/devices/not-a-device/recover', { method: 'POST' });
    assert.equal(recovery.status, 404);
    assert.deepEqual(await recovery.json(), { error: 'device not found or recovery unavailable' });

    await writeFile(audioPath, silentWav());
    for (const uuid of ['older-trigger', 'newer-trigger']) {
      const created = await request(baseUrl, '/api/project/items', {
        method: 'POST',
        body: JSON.stringify({
          item: {
            uuid, type: 'audio', displayName: uuid, mediaServerPath: audioPath,
            duckingBehavior: { mode: 'none' },
          },
          parentUuid: '',
          index: 0,
        }),
      });
      assert.equal(created.status, 200, `audio item creation failed: ${await created.text()}`);
    }
    let loaderReachedGate = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await readFile(loaderEntered);
        loaderReachedGate = true;
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    assert.equal(loaderReachedGate, true, 'real decoder worker did not reach test latch');
    const latchStream = openEventStream(
      'ws://127.0.0.1:' + port + '/ws?access_token=' + encodeURIComponent(accessToken),
    );
    t.after(() => latchStream.socket.close());
    await latchStream.opened;
    const pendingPlayAck = latchStream.next(message =>
      message.type === 'command_ack' && message.command_id === 'pending-play');
    const causalStopAck = latchStream.next(message =>
      message.type === 'command_ack' && message.command_id === 'causal-stop-all');
    const commandStart = performance.now();
    latchStream.socket.send(JSON.stringify({
      type: 'play', item_uuid: 'older-trigger', command_id: 'pending-play',
    }));
    latchStream.socket.send(JSON.stringify({
      type: 'stop_all', command_id: 'causal-stop-all', fade_ms: 0,
    }));
    assert.equal((await pendingPlayAck).ok, false, 'pending cue play must reject');
    assert.equal((await causalStopAck).ok, true, 'Stop All must dispatch while decode is latched');
    assert.ok(performance.now() - commandStart < 500,
      'latched decoder delayed command dispatch');
    assert.equal(await readFile(loaderGate, 'utf8'), gateContents,
      'Stop All incorrectly waited for or released decoder latch');
    const staleContinue = latchStream.next(message =>
      message.type === 'command_ack' && message.command_id === 'old-continue');
    latchStream.socket.send(JSON.stringify({
      type: 'cue_to_continue', item_uuid: 'older-trigger', command_id: 'old-continue', stop_revision: 0,
    }));
    const expired = await staleContinue;
    assert.equal(expired.ok, false);
    assert.match(expired.error, /expired after Stop All/);
    await rm(loaderGate, { force: true });
    latchStream.socket.close();
    let readiness;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      readiness = await (await request(baseUrl, '/api/project/progress')).json();
      if (!readiness.loading) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(readiness?.ready, true, JSON.stringify(readiness));
    const stream = openEventStream(
      'ws://127.0.0.1:' + port + '/ws?access_token=' + encodeURIComponent(accessToken),
    );
    t.after(() => stream.socket.close());
    await stream.opened;

    const invalidStartPatch = await request(baseUrl, '/api/project/items/older-trigger', {
      method: 'PATCH',
      body: JSON.stringify({
        startBehavior: { action: 'play-item', targetUuid: 'missing-start-target' },
      }),
    });
    assert.equal(invalidStartPatch.status, 200);
    const warning = stream.next(message =>
      message.type === 'playback_error' && message.code === 'sequence_target_invalid');
    const primaryAck = stream.next(message =>
      message.type === 'command_ack' && message.command_id === 'invalid-secondary-primary');
    stream.socket.send(JSON.stringify({
      type: 'play', item_uuid: 'older-trigger', command_id: 'invalid-secondary-primary',
    }));
    assert.equal((await primaryAck).ok, true, 'primary play must succeed');
    assert.deepEqual(await warning, {
      type: 'playback_error',
      code: 'sequence_target_invalid',
      message: 'Start action target was unavailable or cyclic',
      item_uuid: 'older-trigger',
      target_uuid: 'missing-start-target',
    });
    stream.socket.send(JSON.stringify({ type: 'stop_all', command_id: 'clear-primary' }));
    assert.equal((await stream.next(message =>
      message.type === 'command_ack' && message.command_id === 'clear-primary')).ok, true);
    const clearStartPatch = await request(baseUrl, '/api/project/items/older-trigger', {
      method: 'PATCH', body: JSON.stringify({ startBehavior: { action: 'nothing' } }),
    });
    assert.equal(clearStartPatch.status, 200);

    const stopReply = await request(baseUrl, '/api/transport/stop_all', {
      method: 'POST', body: JSON.stringify({ fade_ms: 0 }),
    });
    assert.equal(stopReply.status, 200);
    const { stop_revision: stopRevision } = await stopReply.json();
    assert.ok(Number.isSafeInteger(stopRevision) && stopRevision > 0);
    for (const type of ['go', 'play', 'resume']) {
      const commandId = `pre-stop-${type}`;
      const received = stream.next(message => message.type === 'command_ack' && message.command_id === commandId);
      stream.socket.send(JSON.stringify({
        type, command_id: commandId, item_uuid: 'older-trigger', stop_revision: stopRevision - 1,
      }));
      const ack = await received;
      assert.equal(ack.ok, false);
      assert.match(ack.error, /expired after Stop All/);
    }

    for (const uuid of ['older-trigger', 'newer-trigger']) {
      const played = await request(baseUrl, `/api/project/items/${uuid}/play`, { method: 'POST' });
      assert.equal(played.status, 200, `play failed: ${await played.text()}`);
    }
    // Snapshots are sent on connect; subscribe after both accepted plays so
    // the assertion cannot race an earlier empty connection snapshot.
    const snapshotStream = openEventStream(
      'ws://127.0.0.1:' + port + '/ws?access_token=' + encodeURIComponent(accessToken),
    );
    t.after(() => snapshotStream.socket.close());
    await snapshotStream.opened;
    const snapshot = await snapshotStream.next(message =>
      message.type === 'playback_snapshot' &&
      message.cues?.some(cue => cue.item_uuid === 'older-trigger') &&
      message.cues?.some(cue => cue.item_uuid === 'newer-trigger'));
    const older = snapshot.cues.find(cue => cue.item_uuid === 'older-trigger');
    const newer = snapshot.cues.find(cue => cue.item_uuid === 'newer-trigger');
    assert.ok(older && newer, 'snapshot omitted playing cues');
    assert.ok(Number.isInteger(older.trigger_seq));
    assert.ok(newer.trigger_seq > older.trigger_seq, 'snapshot did not preserve authoritative firing order');
  } catch (error) {
    error.message += `\nserver output:\n${diagnostics}`;
    throw error;
  }
});

test('AV-sync diagnostics allocate transient looping cues and release owned uploads', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dwcue-av-sync-integration-'));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(serverBinary, ['--bind', '127.0.0.1', '--port', String(port)], {
    cwd: home,
    env: { ...process.env, HOME: home, LIVEPLAY_ACCESS_TOKEN: accessToken, LIVEPLAY_ALLOWED_ORIGINS: baseUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stdout.on('data', chunk => { diagnostics += chunk; });
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  t.after(async () => {
    await stopServer(child);
    await rm(home, { recursive: true, force: true });
  });

  async function createFromPath(filePath, outputDeviceId) {
    const body = { file_path: filePath };
    if (outputDeviceId !== undefined) body.output_device_id = outputDeviceId;
    return request(baseUrl, '/api/diagnostics/av-sync', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async function uploadWebm(bytes) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'video/webm' }), '24.webm');
    return fetch(`${baseUrl}/api/diagnostics/av-sync`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  try {
    await waitForServer(baseUrl, child);
    const audioPath = path.join(home, 'diagnostic-loop.wav');
    const audioBytes = silentWav();
    await writeFile(audioPath, audioBytes);

    const firstResponse = await createFromPath(audioPath);
    const firstText = await firstResponse.text();
    assert.equal(firstResponse.status, 200, firstText);
    const first = JSON.parse(firstText);
    assert.equal(first.transport, 0);
    assert.equal(first.file_loaded, true);
    assert.equal(first.file_path, audioPath);

    const secondResponse = await createFromPath(audioPath, 'default');
    const secondText = await secondResponse.text();
    assert.equal(secondResponse.status, 200, secondText);
    const second = JSON.parse(secondText);
    assert.notEqual(second.id, first.id, 'diagnostic cue creation de-duplicated by file path');

    const project = await (await request(baseUrl, '/api/project')).text();
    assert.ok(!project.includes(first.id), 'first diagnostic leaked into the project document');
    assert.ok(!project.includes(second.id), 'second diagnostic leaked into the project document');

    const cuesBeforeFailure = await (await request(baseUrl, '/api/cues')).json();
    const invalidDevice = await createFromPath(audioPath, 'not-an-exact-device');
    assert.equal(invalidDevice.status, 400);
    assert.match((await invalidDevice.json()).error, /exactly match/);
    const invalidFile = await createFromPath(path.join(home, 'missing.wav'));
    assert.equal(invalidFile.status, 400);
    const cuesAfterFailure = await (await request(baseUrl, '/api/cues')).json();
    assert.equal(cuesAfterFailure.length, cuesBeforeFailure.length, 'failed diagnostics leaked a cue');

    const devices = await (await request(baseUrl, '/api/devices')).json();
    const selectors = new Set();
    const openedDevice = devices.find(device => device.is_open && device.id);
    if (openedDevice) selectors.add(openedDevice.id);
    const namedDevice = devices.find(device => device.is_available && device.display_name);
    if (namedDevice) selectors.add(namedDevice.display_name);
    for (const selector of selectors) {
      const routedResponse = await createFromPath(audioPath, selector);
      const routedText = await routedResponse.text();
      assert.equal(routedResponse.status, 200, `exact selector ${selector} failed: ${routedText}`);
      const routed = JSON.parse(routedText);
      const removed = await request(baseUrl, `/api/cues/${encodeURIComponent(routed.id)}`, {
        method: 'DELETE',
      });
      assert.equal(removed.status, 200);
    }

    const stream = openEventStream(
      'ws://127.0.0.1:' + port + '/ws?access_token=' + encodeURIComponent(accessToken),
    );
    t.after(() => stream.socket.close());
    await stream.opened;
    const played = await request(baseUrl, `/api/cues/${encodeURIComponent(first.id)}/play`, {
      method: 'POST',
    });
    assert.equal(played.status, 200);
    const meterFrame = await stream.next(message =>
      message.type === 'meters' && message.items?.some(item => item.cue_id === first.id));
    assert.ok(meterFrame.items.some(item => item.cue_id === first.id), 'WebSocket meters omitted diagnostic cue');

    await new Promise(resolve => setTimeout(resolve, 1250));
    const loopedResponse = await request(baseUrl, `/api/cues/${encodeURIComponent(first.id)}`);
    const looped = await loopedResponse.json();
    assert.equal(loopedResponse.status, 200);
    assert.notEqual(looped.transport, 0, 'one-second diagnostic stopped instead of looping');
    assert.ok(looped.playhead_seconds < 1, 'diagnostic playhead did not wrap at full-media EOF');
    await request(baseUrl, `/api/cues/${encodeURIComponent(first.id)}/stop`, { method: 'POST' });

    const deleted = await request(baseUrl, `/api/cues/${encodeURIComponent(first.id)}`, {
      method: 'DELETE',
    });
    assert.equal(deleted.status, 200);
    assert.equal((await request(baseUrl, `/api/cues/${encodeURIComponent(first.id)}`)).status, 404);

    // Device/cue withdrawal acknowledges before the decoder-owned file is retired.
    const waitForOwnedFileRemoval = async file => {
      for (let attempt = 0; attempt < 100; ++attempt) {
        try { await stat(file); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('the retired diagnostic upload still exists');
    };
    const webmBytes = await readFile(path.join(root, 'client', 'public', 'assets', 'testcards', 'audiosync', '24.webm'));
    const uploadResponse = await uploadWebm(webmBytes);
    const uploadText = await uploadResponse.text();
    assert.equal(uploadResponse.status, 200, uploadText);
    const uploaded = JSON.parse(uploadText);
    assert.deepEqual(await readFile(uploaded.file_path), webmBytes, 'multipart staging changed WebM bytes');
    assert.equal((await request(baseUrl, `/api/cues/${encodeURIComponent(uploaded.id)}`, {
      method: 'DELETE',
    })).status, 200);
    await waitForOwnedFileRemoval(uploaded.file_path);

    const resetUploadResponse = await uploadWebm(webmBytes);
    const resetUploadText = await resetUploadResponse.text();
    assert.equal(resetUploadResponse.status, 200, resetUploadText);
    const resetUpload = JSON.parse(resetUploadText);
    assert.equal((await request(baseUrl, '/api/project/close', { method: 'POST' })).status, 200);
    assert.equal((await request(baseUrl, `/api/cues/${encodeURIComponent(resetUpload.id)}`)).status, 404);
    assert.equal((await request(baseUrl, `/api/cues/${encodeURIComponent(second.id)}`)).status, 404);
    await waitForOwnedFileRemoval(resetUpload.file_path);
    assert.deepEqual(await readFile(audioPath), audioBytes, 'server deleted caller-owned JSON media');
    stream.socket.close();
  } catch (error) {
    error.message += `\nserver output:\n${diagnostics}`;
    throw error;
  }
});
