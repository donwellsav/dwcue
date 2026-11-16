const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const serverBinary = process.env.DWCUE_TEST_SERVER_BINARY || path.join(root, 'server', 'build', process.platform === 'win32' ? 'dwcue-server.exe' : 'dwcue-server');
const accessToken = 'show-backups-test-token-1234';

test('the engine keeps automatic backups of the show file and can restore them', { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dwcue-show-backups-'));
  const showFolder = path.join(temporary, 'show');
  const showFile = path.join(showFolder, 'My Show.dwcue');
  const backupsFolder = path.join(showFolder, 'Backups');
  const media = path.join(temporary, 'bed.wav');
  const restoreGate = path.join(temporary, 'restore.gate');
  await mkdir(showFolder);
  await writeFile(media, silentWav(10));

  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(serverBinary, ['--bind', '127.0.0.1', '--port', String(port)], {
    cwd: temporary,
    env: { ...process.env, LIVEPLAY_STATE_DIR: path.join(temporary, 'state'),
      LIVEPLAY_ACCESS_TOKEN: accessToken, LIVEPLAY_ALLOWED_ORIGINS: baseUrl,
      DWCUE_TEST_BACKUP_RESTORE_GATE: restoreGate },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stdout.on('data', chunk => { diagnostics += chunk; });
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  t.after(async () => { await stopServer(child); await rm(temporary, { recursive: true, force: true }); });

  const backupName = /^My Show \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.dwcue$/;
  const show = name => ({ name, version: '2.0.0', folderPath: showFolder,
    items: [{ uuid: 'bed', type: 'audio', displayName: 'Bed', mediaServerPath: media,
      duration: 10, endBehavior: { action: 'loop' } }],
    cartOnlyItems: [], cartItems: [], settings: {}, theme: { accentColor: '#123456' },
  });
  const post = (pathname, body, headers) => request(baseUrl, pathname, { method: 'POST', body: JSON.stringify(body), headers });
  const ok = async response => {
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const save = async name => ok(await post('/api/project/save', { path: showFile, document: show(name) }));
  const settled = async () => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const progress = await (await request(baseUrl, '/api/project/progress')).json();
      if (!progress.loading) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('the show must finish loading');
  };
  const current = async () => {
    await settled();
    const doc = await (await request(baseUrl, '/api/project')).json();
    return { name: doc.name, path: doc.server.projectFilePath, session: doc.server.projectSessionId };
  };
  const list = async () => {
    const body = await ok(await request(baseUrl, '/api/project/backups'));
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.backups));
    return body.backups;
  };
  const restore = (name, headers) => post('/api/project/backups/restore', { name }, headers);
  const playing = async () => (await (await request(baseUrl, '/api/state/summary')).json())
    .playing.map(item => item.itemUuid);
  const onDisk = () => readFile(showFile);
  const backupFiles = async () => (await readdir(backupsFolder)).sort();
  const refused = async (response, status, pattern) => {
    const text = await response.text();
    assert.equal(response.status, status, text);
    const { error } = JSON.parse(text);
    assert.equal(typeof error, 'string');
    if (pattern) assert.match(error, pattern);
  };

  try {
    await waitForServer(baseUrl, child);
    let created, second, third, firstBackup, undoBackup;

    await t.test('a show that is not on disk has no backups and nothing to restore', async () => {
      assert.deepEqual(await list(), [], 'no show is open');
      await ok(await post('/api/project/load', { document: show('Version 1') }));
      await settled();
      assert.deepEqual(await list(), []);
      await refused(await restore('My Show 2026-01-01 10.00.00.dwcue'), 400);
      // Saving a new show overwrites nothing, so there is nothing to keep.
      await save('Version 1');
      created = await onDisk();
      assert.deepEqual(await readdir(showFolder), ['My Show.dwcue']);
      assert.deepEqual(await list(), []);
    });

    await t.test('saving twice quickly makes one backup', async () => {
      await save('Version 2');
      second = await onDisk();
      await save('Version 3');
      third = await onDisk();
      assert.notDeepEqual(second, created);
      assert.notDeepEqual(third, second);
      const files = await backupFiles();
      assert.equal(files.length, 1, files.join(', '));
      assert.match(files[0], backupName);
      firstBackup = files[0];
      assert.deepEqual(await readFile(path.join(backupsFolder, firstBackup)), created,
        'the backup holds the file that the save was about to overwrite');
    });

    await t.test('the list reports each backup by name, time and size, newest first', async () => {
      const backups = await list();
      assert.deepEqual(Object.keys(backups[0]).sort(), ['name', 'savedAt', 'size']);
      assert.deepEqual(backups.map(backup => backup.name), [firstBackup]);
      assert.equal(backups[0].size, created.length);
      assert.ok(Number.isSafeInteger(backups[0].savedAt));
      assert.ok(Math.abs(backups[0].savedAt - Date.now()) < 2 * 3600 * 1000, 'savedAt is epoch milliseconds');
    });

    await t.test('restore is refused for anything but one of this show\'s backup names', async () => {
      const outside = path.join(temporary, 'Outside 2026-01-01 10.00.00.dwcue');
      await writeFile(outside, JSON.stringify(show('Outside')));
      await writeFile(path.join(backupsFolder, 'Other Show 2026-01-01 10.00.00.dwcue'), JSON.stringify(show('Other')));
      await writeFile(path.join(backupsFolder, 'notes.txt'), 'not a backup');
      const before = await current();
      for (const name of [
        '', '.', '..', 'notes.txt', 'My Show.dwcue', '../My Show.dwcue', `../${firstBackup}`,
        `Backups/${firstBackup}`, `./${firstBackup}`, `${firstBackup}/..`, `..\\${firstBackup}`,
        path.join(backupsFolder, firstBackup), outside, `../../${path.basename(outside)}`,
        'Other Show 2026-01-01 10.00.00.dwcue', 'My Show 2026-01-01 10.00.00.dwcue',
        firstBackup.replace('.dwcue', '.DWCUE'), `${firstBackup}\u0000.txt`, ` ${firstBackup}`,
      ]) {
        await refused(await restore(name), 400);
      }
      for (const body of [{}, { name: 7 }, { name: [firstBackup] }, { name: null }, [firstBackup]]) {
        await refused(await post('/api/project/backups/restore', body), 400);
      }
      await refused(await request(baseUrl, '/api/project/backups/restore', { method: 'POST', body: '{' }), 400);
      assert.deepEqual(await onDisk(), third);
      assert.deepEqual(await current(), before);
      assert.deepEqual((await list()).map(backup => backup.name), [firstBackup], 'foreign files are never listed');
      await rm(path.join(backupsFolder, 'Other Show 2026-01-01 10.00.00.dwcue'));
      await rm(path.join(backupsFolder, 'notes.txt'));
    });

    await t.test('restore is refused while a cue is playing', async () => {
      const before = await current();
      await ok(await post('/api/project/items/bed/play', {}));
      assert.deepEqual(await playing(), ['bed']);
      await refused(await restore(firstBackup), 409, /playing/i);
      assert.deepEqual(await playing(), ['bed'], 'the running show is left alone');
      assert.deepEqual(await onDisk(), third);
      assert.deepEqual(await current(), before);
      assert.deepEqual(await backupFiles(), [firstBackup], 'a refused restore makes no undo copy');
      await ok(await post('/api/transport/stop_all', { fade_ms: 0 }));
      assert.deepEqual(await playing(), []);
    });

    await t.test('a cue that starts while a restore is under way wins, and the show file is put back', async () => {
      const before = await current();
      await writeFile(restoreGate, '');
      const pending = restore(firstBackup);
      try {
        for (let attempt = 0; ; attempt++) {
          if (await access(`${restoreGate}.entered`).then(() => true, () => false)) break;
          assert.ok(attempt < 400, 'the restore must reach the reload step');
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        // The restore passed its checks and has replaced the file; only the reload is left.
        assert.deepEqual(await onDisk(), created);
        await ok(await post('/api/project/items/bed/play', {}));
        assert.deepEqual(await playing(), ['bed']);
      } finally { await rm(restoreGate, { force: true }); }
      await refused(await pending, 409, /playing/i);
      assert.deepEqual(await playing(), ['bed'], 'the cue that started keeps playing');
      assert.deepEqual(await onDisk(), third, 'the show file is exactly as it was');
      assert.deepEqual(await current(), before, 'the open show and its session are untouched');
      const files = await backupFiles();
      assert.equal(files.length, 2, 'the copy made for the attempted restore is an ordinary backup');
      for (const file of files) assert.match(file, backupName);
      await ok(await post('/api/transport/stop_all', { fade_ms: 0 }));
      assert.deepEqual(await playing(), []);
      await rm(`${restoreGate}.entered`, { force: true });
    });

    await t.test('restore brings back the earlier content, keeps an undo backup and tells clients', async () => {
      const before = await current();
      assert.equal(before.name, 'Version 3');
      const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws?access_token=${accessToken}`);
      t.after(() => socket.close());
      const changed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('clients were not told the project changed')), 5000);
        socket.addEventListener('message', event => {
          const message = JSON.parse(String(event.data));
          if (message.type === 'doc_patch' && message.op === 'project_changed') { clearTimeout(timer); resolve(); }
        });
      });
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', () => reject(new Error('WebSocket failed to open')), { once: true });
      });

      const restored = await ok(await restore(firstBackup, { 'X-DWCUE-Project-Session': before.session }));
      assert.equal(restored.ok, true);
      assert.equal(restored.restoredFrom, firstBackup);
      assert.match(restored.undoBackup, backupName);
      assert.notEqual(restored.undoBackup, firstBackup);
      // The rest is what /api/project/load answers.
      assert.equal(restored.name, 'Version 1');
      assert.equal(restored.itemCount, 1);
      assert.equal(restored.hasOpenProject, true);
      assert.equal(restored.server.projectFilePath, showFile);
      assert.notEqual(restored.server.projectSessionId, before.session);
      await changed;
      socket.close();

      undoBackup = restored.undoBackup;
      assert.deepEqual(await onDisk(), created, 'the show file is the backup, byte for byte');
      const after = await current();
      assert.deepEqual(after, { name: 'Version 1', path: showFile, session: restored.server.projectSessionId });
      assert.deepEqual((await list()).map(backup => backup.name), [undoBackup, firstBackup]);
      assert.deepEqual(await readFile(path.join(backupsFolder, undoBackup)), third,
        'the undo backup holds the show as it was just before the restore');
      assert.deepEqual(await readFile(path.join(backupsFolder, firstBackup)), created, 'the restored backup is kept');
    });

    await t.test('a restore can be undone, and saves right after a restore add no backups', async () => {
      await save('Version 4');
      const fourth = await onDisk();
      assert.deepEqual(await backupFiles(), [firstBackup, undoBackup].sort());
      const undone = await ok(await restore(undoBackup));
      assert.equal(undone.name, 'Version 3');
      assert.deepEqual(await onDisk(), third);
      assert.equal((await current()).name, 'Version 3');
      const backups = await list();
      assert.deepEqual(backups.map(backup => backup.name), [undone.undoBackup, undoBackup, firstBackup]);
      assert.deepEqual(await readFile(path.join(backupsFolder, undone.undoBackup)), fourth);
      // The undo copy was made a moment ago: a save right after it adds nothing.
      await save('Version 5');
      assert.equal((await backupFiles()).length, 3);
    });

    await t.test('a backup that is not a readable show changes nothing', async () => {
      const broken = 'My Show 2001-01-01 00.00.00.dwcue';
      const unrelated = 'My Show 2001-01-02 00.00.00.dwcue';
      await writeFile(path.join(backupsFolder, broken), '{');
      await writeFile(path.join(backupsFolder, unrelated), '{"event":"This is not a show"}');
      const before = await current();
      const bytes = await onDisk();
      const files = await backupFiles();
      assert.equal((await list()).length, 5);
      for (const name of [broken, unrelated]) {
        await refused(await restore(name), 422, /nothing was changed/i);
        assert.deepEqual(await onDisk(), bytes);
        assert.deepEqual(await current(), before);
        assert.deepEqual(await backupFiles(), files);
      }
      await rm(path.join(backupsFolder, broken));
      await rm(path.join(backupsFolder, unrelated));
    });

    await t.test('the backup routes use the same authentication and session checks as the other project routes', async () => {
      const before = await current();
      for (const [pathname, options] of [
        ['/api/project/backups', {}],
        ['/api/project/backups/restore', { method: 'POST', body: JSON.stringify({ name: firstBackup }) }],
      ]) {
        const anonymous = await fetch(`${baseUrl}${pathname}`, { ...options,
          headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(2000) });
        assert.equal(anonymous.status, 401);
        const stale = await request(baseUrl, pathname, { ...options, headers: { 'X-DWCUE-Project-Session': 'a-previous-session' } });
        assert.equal(stale.status, 409, await stale.text());
      }
      assert.deepEqual(await current(), before);
      assert.equal((await backupFiles()).length, 3);
    });

    await t.test('Backups contains only backup files', async () => {
      const files = await backupFiles();
      assert.equal(files.length, 3);
      for (const file of files) assert.match(file, backupName);
      assert.deepEqual((await readdir(showFolder)).sort(), ['Backups', 'My Show.dwcue'], 'no temporary files are left beside the show');
    });

    await t.test('the first save after opening keeps the opened show, and only the newest ten backups stay', async () => {
      const opened = await onDisk();
      const old = [];
      for (let day = 1; day <= 12; day++) {
        old.push(`My Show 2020-01-${String(day).padStart(2, '0')} 08.00.00.dwcue`);
        await writeFile(path.join(backupsFolder, old.at(-1)), JSON.stringify(show(`Old ${day}`)));
      }
      const foreign = ['Other Show 2019-01-01 08.00.00.dwcue', 'My Show_backup_2019-01-01_08-00.dwcue',
        'My Show 2 2019-01-01 08.00.00.dwcue', 'notes.txt'];
      for (const name of foreign) await writeFile(path.join(backupsFolder, name), `keep ${name}`);
      assert.equal((await list()).length, 15);

      await ok(await post('/api/project/load', { path: showFile }));
      await settled();
      // Inside five minutes of the last backup, but it is the first save since the show was opened.
      await save('Version 6');
      const backups = await list();
      assert.equal(backups.length, 10);
      assert.deepEqual(await readFile(path.join(backupsFolder, backups[0].name)), opened);
      const kept = new Set(backups.map(backup => backup.name));
      for (const name of [firstBackup, undoBackup]) assert.ok(kept.has(name));
      assert.deepEqual(old.filter(name => kept.has(name)), old.slice(6), 'the oldest backups are the ones removed');
      const files = await backupFiles();
      for (const name of foreign) {
        assert.ok(files.includes(name), `${name} is not this show's backup and must be left alone`);
        assert.equal(await readFile(path.join(backupsFolder, name), 'utf8'), `keep ${name}`);
      }
      assert.equal(files.length, 10 + foreign.length);
      // The next quick save adds nothing.
      await save('Version 7');
      assert.equal((await list()).length, 10);
    });

    await t.test('a failed backup never fails the save', async () => {
      const blockedFolder = path.join(temporary, 'blocked');
      const blockedShow = path.join(blockedFolder, 'Blocked.dwcue');
      await mkdir(blockedFolder);
      await writeFile(path.join(blockedFolder, 'Backups'), 'a file where the folder should be');
      await writeFile(blockedShow, JSON.stringify({ ...show('Blocked'), folderPath: blockedFolder }));
      await ok(await post('/api/project/load', { path: blockedShow }));
      await settled();
      await ok(await post('/api/project/save', { path: blockedShow, document: { ...show('Blocked again'), folderPath: blockedFolder } }));
      assert.equal(JSON.parse(await readFile(blockedShow, 'utf8')).name, 'Blocked again');
      assert.equal(await readFile(path.join(blockedFolder, 'Backups'), 'utf8'), 'a file where the folder should be');
      assert.deepEqual(await list(), []);
      for (let attempt = 0; attempt < 100 && !/Show backup: skipped/.test(diagnostics); attempt++)
        await new Promise(resolve => setTimeout(resolve, 10));
      assert.match(diagnostics, /Show backup: skipped/, 'the failure is logged as a warning');
    });

    await t.test('a project archive leaves the Backups folder out', async () => {
      await ok(await post('/api/project/load', { path: showFile }));
      await settled();
      const archive = path.join(temporary, 'My Show.dwcuepack');
      const extracted = path.join(temporary, 'extracted');
      await ok(await post('/api/project/export', { folderPath: showFolder, outputPath: archive }));
      await ok(await post('/api/project/import', { archivePath: archive, extractPath: extracted }));
      assert.deepEqual(await readdir(extracted), ['My Show.dwcue']);
      assert.ok((await backupFiles()).length >= 10, 'the backups themselves stay where they are');
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

async function waitForServer(baseUrl, child) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assert.equal(child.exitCode ?? child.signalCode, null, `server exited before becoming ready (exit ${child.exitCode}, signal ${child.signalCode})`);
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { Authorization: `Bearer ${accessToken}` },
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
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 2000);
    child.once('exit', () => { clearTimeout(forceTimer); resolve(); });
    child.kill('SIGTERM');
  });
}

async function request(baseUrl, pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(5000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
}
