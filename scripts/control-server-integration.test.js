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
  await writeFile(loaderGate, 'closed');
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

    const audioPath = path.join(home, 'trigger-order.wav');
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
    assert.equal(await readFile(loaderGate, 'utf8'), 'closed',
      'Stop All incorrectly waited for or released decoder latch');
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

    for (const uuid of ['older-trigger', 'newer-trigger']) {
      const played = await request(baseUrl, `/api/project/items/${uuid}/play`, { method: 'POST' });
      assert.equal(played.status, 200, `play failed: ${await played.text()}`);
    }
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

    const webmBytes = await readFile(path.join(root, 'client', 'public', 'assets', 'testcards', 'audiosync', '24.webm'));
    const uploadResponse = await uploadWebm(webmBytes);
    const uploadText = await uploadResponse.text();
    assert.equal(uploadResponse.status, 200, uploadText);
    const uploaded = JSON.parse(uploadText);
    assert.deepEqual(await readFile(uploaded.file_path), webmBytes, 'multipart staging changed WebM bytes');
    assert.equal((await request(baseUrl, `/api/cues/${encodeURIComponent(uploaded.id)}`, {
      method: 'DELETE',
    })).status, 200);
    await assert.rejects(readFile(uploaded.file_path), { code: 'ENOENT' });

    const resetUploadResponse = await uploadWebm(webmBytes);
    const resetUploadText = await resetUploadResponse.text();
    assert.equal(resetUploadResponse.status, 200, resetUploadText);
    const resetUpload = JSON.parse(resetUploadText);
    assert.equal((await request(baseUrl, '/api/project/close', { method: 'POST' })).status, 200);
    assert.equal((await request(baseUrl, `/api/cues/${encodeURIComponent(resetUpload.id)}`)).status, 404);
    assert.equal((await request(baseUrl, `/api/cues/${encodeURIComponent(second.id)}`)).status, 404);
    await assert.rejects(readFile(resetUpload.file_path), { code: 'ENOENT' });
    assert.deepEqual(await readFile(audioPath), audioBytes, 'server deleted caller-owned JSON media');
    stream.socket.close();
  } catch (error) {
    error.message += `\nserver output:\n${diagnostics}`;
    throw error;
  }
});
