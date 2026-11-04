const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { appendFile, link, mkdtemp, mkdir, readFile, readdir, rename, rm, utimes, writeFile } = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const serverBinary = process.env.DWCUE_TEST_SERVER_BINARY || path.resolve(
  __dirname, '..', 'server', 'build', process.platform === 'win32' ? 'dwcue-server.exe' : 'dwcue-server',
);
const accessToken = 'import-copy-boundary-test-token';

test('copy import preserves bytes, rejects reference relocation and pins its project destination', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dwcue-copy-boundary-'));
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const copyGate = path.join(temporary, 'copy-gate');
  const child = spawn(serverBinary, ['--bind', '127.0.0.1', '--port', String(port)], {
    cwd: temporary,
    env: {
      ...process.env,
      LIVEPLAY_STATE_DIR: path.join(temporary, 'server-state'),
      LIVEPLAY_ACCESS_TOKEN: accessToken,
      LIVEPLAY_ALLOWED_ORIGINS: baseUrl,
      DWCUE_TEST_COPY_GATE: copyGate,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stdout.on('data', chunk => { diagnostics += chunk; });
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const force = setTimeout(() => child.kill('SIGKILL'), 2000);
        child.once('exit', () => { clearTimeout(force); resolve(); });
        child.kill('SIGTERM');
      });
    }
    await rm(temporary, { recursive: true, force: true });
  });
  const request = (pathname, body) => fetch(`${baseUrl}${pathname}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(2000),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode ?? child.signalCode, null, diagnostics);
      try { ready = (await request('/api/health')).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(ready, diagnostics);
    const projects = {};
    for (const name of ['A', 'B']) {
      const folder = path.join(temporary, name);
      await mkdir(folder);
      const file = path.join(folder, `${name}.dwcue`);
      await writeFile(file, JSON.stringify({
        name, version: '2.0.0', folderPath: folder, items: [], cartItems: [], settings: {},
      }));
      projects[name] = { folder, file, media: path.join(folder, 'media') };
    }
    const load = async project => {
      const response = await request('/api/project/load', { path: project.file });
      assert.equal(response.status, 200, await response.text());
    };
    const copy = (source, project = projects.A, duplicatePolicy = 'keep') => request('/api/copy_to_media', {
      source_path: source,
      duplicate_policy: duplicatePolicy,
      expected_project_file_path: project.file,
      expected_media_root: project.media,
    });
    await load(projects.A);

    for (const extension of ['m3u', 'm3u8', 'pls', 'ram', 'CUE', 'xspf', 'asx', 'wax', 'wvx', 'smil', 'smi']) {
      const source = path.join(temporary, `reference.${extension}`);
      await writeFile(source, 'relative/audio.wav');
      const rejected = await copy(source);
      const message = await rejected.text();
      assert.equal(rejected.status, 400, `${extension}: ${message}`);
      assert.match(message, /Choose Link.*audio file/);
      assert.equal(await readFile(source, 'utf8'), 'relative/audio.wav');
    }
    assert.deepEqual(await readdir(projects.A.media).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    }), []);

    await mkdir(projects.A.media, { recursive: true });
    const inPlace = path.join(projects.A.media, 'existing.cue');
    await writeFile(inPlace, 'FILE "audio.wav" WAVE');
    const noOp = await copy(inPlace);
    assert.equal(noOp.status, 200, await noOp.clone().text());
    assert.equal((await noOp.json()).dest_path, inPlace);
    const externalLink = path.join(temporary, 'existing.cue');
    await link(inPlace, externalLink);
    const relocatedLink = await copy(externalLink);
    assert.equal(relocatedLink.status, 400,
      'a hardlink outside media still changes relative dependency resolution');

    const source = path.join(temporary, 'original.wav');
    const bytes = Buffer.from([0, 255, 0, 128, 42, 13, 10, 7]);
    await writeFile(source, bytes);
    const first = await copy(source);
    assert.equal(first.status, 200, await first.clone().text());
    const firstPath = (await first.json()).dest_path;
    assert.deepEqual(await readFile(firstPath), bytes);
    const second = await copy(source);
    assert.equal(second.status, 200, await second.clone().text());
    assert.notEqual((await second.json()).dest_path, firstPath);
    for (const policy of ['reuse', 'skip']) {
      const duplicate = await copy(source, projects.A, policy);
      assert.equal(duplicate.status, 200, await duplicate.clone().text());
      const result = await duplicate.json();
      assert.equal(result.duplicate, true);
      assert.equal(result.skipped, policy === 'skip');
      assert.deepEqual(await readFile(result.dest_path), bytes);
    }
    assert.deepEqual(await readFile(source), bytes);

    await t.test('rejects a WAVE prefix whose declared bytes have not arrived', async () => {
      const prefix = Buffer.alloc(44 + 24000);
      prefix.write('RIFF'); prefix.writeUInt32LE(36 + 96000, 4); prefix.write('WAVEfmt ', 8);
      prefix.writeUInt32LE(16, 16); prefix.writeUInt16LE(1, 20); prefix.writeUInt16LE(1, 22);
      prefix.writeUInt32LE(48000, 24); prefix.writeUInt32LE(96000, 28);
      prefix.writeUInt16LE(2, 32); prefix.writeUInt16LE(16, 34);
      prefix.write('data', 36); prefix.writeUInt32LE(96000, 40);
      const unfinished = path.join(temporary, 'unfinished.wav');
      await writeFile(unfinished, prefix);
      const before = await readdir(projects.A.media);
      const rejected = await copy(unfinished);
      assert.equal(rejected.status, 409, await rejected.text());
      assert.deepEqual(await readdir(projects.A.media), before, 'no incomplete destination is published');
      await appendFile(unfinished, Buffer.alloc(72000));
      const complete = await copy(unfinished);
      assert.equal(complete.status, 200, await complete.clone().text());
      assert.deepEqual(await readFile((await complete.json()).dest_path), await readFile(unfinished));
    });

    for (const changing of [false, true]) await t.test(changing
      ? 'a source changed during copying is refused without publication'
      : 'a copied file stays hidden until atomic publication', async () => {
      const filename = changing ? 'changed.bin' : 'atomic.bin';
      const input = path.join(temporary, filename);
      await writeFile(input, bytes);
      await rm(`${copyGate}.entered`, { force: true });
      await writeFile(copyGate, '');
      const pending = copy(input);
      let response;
      try {
        let entered = false;
        for (let i = 0; i < 100; i++) {
          try { await readFile(`${copyGate}.entered`); entered = true; break; } catch {}
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.ok(entered, 'copy reached the publication boundary');
        const names = await readdir(projects.A.media);
        if (changing) await appendFile(input, Buffer.from([99]));
        else assert.ok(!names.includes(filename), 'the final media name must not expose a partial copy');
      } finally {
        await rm(copyGate, { force: true });
        response = await pending;
        await rm(`${copyGate}.entered`, { force: true });
      }
      assert.equal(response.status, changing ? 409 : 200, await response.clone().text());
      if (changing) assert.ok(!(await readdir(projects.A.media)).includes(filename));
      else assert.deepEqual(await readFile((await response.json()).dest_path), bytes);
      assert.ok(!(await readdir(projects.A.media)).some(name => name.endsWith('.part')));
    });

    await t.test('metadata revision changes for a same-size same-date replacement at the same path', async () => {
      const input = path.join(temporary, 'revision.bin');
      const replacement = `${input}.replacement`;
      const date = new Date('2020-01-01T00:00:00Z');
      await writeFile(input, bytes);
      await utimes(input, date, date);
      const first = await (await request(`/api/metadata?path=${encodeURIComponent(input)}`)).json();
      assert.equal(typeof first.file_revision, 'string');
      await writeFile(replacement, bytes);
      await utimes(replacement, date, date);
      await rename(replacement, input);
      const second = await (await request(`/api/metadata?path=${encodeURIComponent(input)}`)).json();
      assert.equal(typeof second.file_revision, 'string');
      assert.notEqual(first.file_revision, second.file_revision);
    });

    const missingIdentity = await request('/api/copy_to_media', { source_path: source });
    assert.equal(missingIdentity.status, 400);
    await load(projects.B);
    const stale = await copy(source);
    assert.equal(stale.status, 409, await stale.text());
    const wrongRoot = await copy(source, { ...projects.B, media: projects.A.media });
    assert.equal(wrongRoot.status, 409, await wrongRoot.text());
    assert.deepEqual(await readdir(projects.B.media).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    }), [], 'an import started in A must never land in B');
  } catch (error) {
    error.message += `\nServer diagnostics:\n${diagnostics}`;
    throw error;
  }
});
