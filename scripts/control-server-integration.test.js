const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const serverBinary = path.join(root, 'server', 'build', process.platform === 'win32' ? 'dwcue-server.exe' : 'dwcue-server');
const accessToken = 'integration-test-token-1234';

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

function silentWav() {
  const dataBytes = 48_000 * 2;
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
    const savedProject = await readFile(projectPath, 'utf8');
    assert.doesNotMatch(savedProject, /clientMutationId|mutation-first|mutation-second/);

    stream.socket.close();
  } catch (error) {
    error.message += `\nserver output:\n${diagnostics}`;
    throw error;
  }
});

test('native media, recovery correlation, and authoritative trigger order stay coherent', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dwcue-media-integration-'));
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

    const audioPath = path.join(home, 'trigger-order.wav');
    await writeFile(audioPath, silentWav());
    for (const uuid of ['older-trigger', 'newer-trigger']) {
      const created = await request(baseUrl, '/api/project/items', {
        method: 'POST',
        body: JSON.stringify({
          item: { uuid, type: 'audio', displayName: uuid, mediaServerPath: audioPath },
          parentUuid: '',
          index: 0,
        }),
      });
      assert.equal(created.status, 200, `audio item creation failed: ${await created.text()}`);
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const project = await (await request(baseUrl, '/api/project')).json();
      if (!project.server.audioLoading) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    for (const uuid of ['older-trigger', 'newer-trigger']) {
      const played = await request(baseUrl, `/api/project/items/${uuid}/play`, { method: 'POST' });
      assert.equal(played.status, 200, `play failed: ${await played.text()}`);
    }
    const stream = openEventStream(
      'ws://127.0.0.1:' + port + '/ws?access_token=' + encodeURIComponent(accessToken),
    );
    t.after(() => stream.socket.close());
    await stream.opened;
    const snapshot = await stream.next(message =>
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
