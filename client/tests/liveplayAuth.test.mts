import assert from 'node:assert/strict';
import test from 'node:test';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    sockets.push(this);
  }

  send(payload: string): void {
    this.sent.push(String(payload));
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  receive(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

const storage = new MemoryStorage();
const sockets: FakeWebSocket[] = [];
const fetchAuthorizations: string[] = [];

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { localStorage: storage },
});
Object.defineProperty(globalThis, 'WebSocket', {
  configurable: true,
  value: FakeWebSocket,
});
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  value: async (_input: RequestInfo | URL, init?: RequestInit) => {
    fetchAuthorizations.push(new Headers(init?.headers).get('Authorization') ?? '');
    return new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  },
});

test('deduplicates server state, rotates managed credentials, and fences stale sockets', async () => {
  const remoteToken = 'remote-access-token-1234';
  const managedToken = 'a'.repeat(64);
  const rotatedManagedToken = 'b'.repeat(64);
  const localUrl = 'http://127.0.0.1:4480';
  storage.setItem('liveplay.serverUrl', 'https://remote.example');
  storage.setItem('liveplay.accessToken', remoteToken);

  const { useLiveplayServer } = await import('../app/composables/useLiveplayServer.ts');
  const server = useLiveplayServer();
  let recoveryHookCalls = 0;
  server.onReconnected(() => { recoveryHookCalls++; });

  server.configureManagedConnection(localUrl, managedToken);
  assert.equal(sockets.length, 1);
  const firstSocket = sockets[0];
  assert.ok(firstSocket);
  assert.equal(server.effectiveAccessToken, managedToken);
  assert.equal(storage.getItem('liveplay.accessToken'), remoteToken);
  assert.equal(
    new URL(firstSocket.url).searchParams.get('access_token'),
    managedToken,
  );
  assert.throws(
    () => server.configureManagedConnection(localUrl, 'too-short'),
    /invalid access token/,
  );

  // Repeated Electron state broadcasts must not replace an in-flight or open
  // socket, nor reset the fact that this client has connected before.
  server.configureManagedConnection(localUrl, managedToken);
  assert.equal(sockets.length, 1);
  assert.equal(firstSocket.readyState, FakeWebSocket.CONNECTING);
  firstSocket.readyState = FakeWebSocket.OPEN;
  firstSocket.onopen?.({});
  assert.equal(server.connected, true);
  assert.equal(recoveryHookCalls, 0);
  server.configureManagedConnection(localUrl, managedToken);
  assert.equal(sockets.length, 1);
  assert.equal(firstSocket.readyState, FakeWebSocket.OPEN);
  assert.equal(server.connected, true);

  // A pre-handshake failure after an established connection is still counted;
  // an idempotent state broadcast must not have reset hasEverConnected.
  firstSocket.readyState = FakeWebSocket.CLOSED;
  firstSocket.onclose?.({});
  server.configureManagedConnection(localUrl, managedToken);
  const retrySocket = sockets.at(-1);
  assert.ok(retrySocket);
  assert.notEqual(retrySocket, firstSocket);
  retrySocket.readyState = FakeWebSocket.CLOSED;
  retrySocket.onclose?.({});
  assert.equal(server.failedReconnectAttempts, 1);

  server.configureManagedConnection(localUrl, managedToken);
  const recoveredSocket = sockets.at(-1);
  assert.ok(recoveredSocket);
  recoveredSocket.readyState = FakeWebSocket.OPEN;
  recoveredSocket.onopen?.({});
  assert.equal(server.connected, true);
  assert.equal(recoveryHookCalls, 1);
  const staleOpen = recoveredSocket.onopen;
  const staleClose = recoveredSocket.onclose;
  assert.ok(staleOpen);
  assert.ok(staleClose);

  // A managed server restart keeps the endpoint but rotates the credential.
  // That is a real configuration change and must replace the socket exactly once.
  const socketCountBeforeRotation = sockets.length;
  server.configureManagedConnection(localUrl, rotatedManagedToken);
  assert.equal(sockets.length, socketCountBeforeRotation + 1);
  assert.equal(recoveredSocket.readyState, FakeWebSocket.CLOSED);
  const rotatedSocket = sockets.at(-1);
  assert.ok(rotatedSocket);
  assert.equal(
    new URL(rotatedSocket.url).searchParams.get('access_token'),
    rotatedManagedToken,
  );
  rotatedSocket.readyState = FakeWebSocket.OPEN;
  rotatedSocket.onopen?.({});
  assert.equal(server.connected, true);
  assert.equal(recoveryHookCalls, 2);

  // Already-queued callbacks from the replaced generation cannot close,
  // reopen, fetch for, or otherwise take ownership of the current socket.
  const fetchCountBeforeStaleCallbacks = fetchAuthorizations.length;
  staleClose?.({});
  staleOpen?.({});
  assert.equal(server.connected, true);
  assert.equal(sockets.length, socketCountBeforeRotation + 1);
  assert.equal(fetchAuthorizations.length, fetchCountBeforeStaleCallbacks);

  server.configureManagedConnection(localUrl, rotatedManagedToken);
  assert.equal(sockets.length, socketCountBeforeRotation + 1);
  assert.equal(rotatedSocket.readyState, FakeWebSocket.OPEN);

  await server.fetchCues();
  assert.equal(fetchAuthorizations.at(-1), `Bearer ${rotatedManagedToken}`);

  const goResult = server.go();
  const goFrame = JSON.parse(rotatedSocket.sent.at(-1) ?? '{}');
  assert.equal(goFrame.type, 'go');
  assert.equal(typeof goFrame.command_id, 'string');
  rotatedSocket.receive({ type: 'command_ack', command_id: goFrame.command_id, ok: true });
  assert.equal(await goResult, true);

  const continueResult = server.cueToContinue('item-7');
  const continueFrame = JSON.parse(rotatedSocket.sent.at(-1) ?? '{}');
  assert.equal(continueFrame.type, 'cue_to_continue');
  assert.equal(continueFrame.item_uuid, 'item-7');
  rotatedSocket.receive({
    type: 'command_ack',
    command_id: continueFrame.command_id,
    ok: false,
    error: 'item cannot be cued',
  });
  assert.equal(await continueResult, false);

  const nextRemoteToken = 'next-remote-token-5678';
  server.configureRemoteConnection('https://next.example', nextRemoteToken);
  const remoteSocket = sockets.at(-1);
  assert.ok(remoteSocket);
  const socketCountBeforeRepeatedRemoteState = sockets.length;
  server.configureRemoteConnection('https://next.example', nextRemoteToken);
  assert.equal(sockets.length, socketCountBeforeRepeatedRemoteState);
  remoteSocket.readyState = FakeWebSocket.OPEN;
  remoteSocket.onopen?.({});
  assert.equal(server.connected, true);
  assert.equal(recoveryHookCalls, 2);
  assert.equal(server.effectiveAccessToken, nextRemoteToken);
  assert.equal(storage.getItem('liveplay.accessToken'), nextRemoteToken);
  assert.equal(
    new URL(remoteSocket.url).searchParams.get('access_token'),
    nextRemoteToken,
  );
  assert.equal(
    sockets.some(({ url }) => url.startsWith(`${localUrl}/ws`) && url.includes(remoteToken)),
    false,
  );

  server.destroy();
});
