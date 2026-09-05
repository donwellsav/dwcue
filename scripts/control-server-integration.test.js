const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
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
