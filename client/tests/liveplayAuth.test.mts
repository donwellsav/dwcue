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

test('keeps managed credentials session-only and authenticates every transport', async () => {
  const remoteToken = 'remote-access-token-1234';
  const managedToken = 'a'.repeat(64);
  const localUrl = 'http://127.0.0.1:4480';
  storage.setItem('liveplay.serverUrl', 'https://remote.example');
  storage.setItem('liveplay.accessToken', remoteToken);

  const { useLiveplayServer } = await import('../app/composables/useLiveplayServer.ts');
  const server = useLiveplayServer();

  server.configureManagedConnection(localUrl, managedToken);
  assert.equal(server.effectiveAccessToken, managedToken);
  assert.equal(storage.getItem('liveplay.accessToken'), remoteToken);
  assert.equal(
    new URL(sockets.at(-1)?.url ?? '').searchParams.get('access_token'),
    managedToken,
  );
  assert.throws(
    () => server.configureManagedConnection(localUrl, 'too-short'),
    /invalid access token/,
  );

  await server.fetchCues();
  assert.equal(fetchAuthorizations.at(-1), `Bearer ${managedToken}`);

  const socket = sockets.at(-1);
  assert.ok(socket);
  socket.readyState = FakeWebSocket.OPEN;

  const goResult = server.go();
  const goFrame = JSON.parse(socket.sent.at(-1) ?? '{}');
  assert.equal(goFrame.type, 'go');
  assert.equal(typeof goFrame.command_id, 'string');
  socket.receive({ type: 'command_ack', command_id: goFrame.command_id, ok: true });
  assert.equal(await goResult, true);

  const continueResult = server.cueToContinue('item-7');
  const continueFrame = JSON.parse(socket.sent.at(-1) ?? '{}');
  assert.equal(continueFrame.type, 'cue_to_continue');
  assert.equal(continueFrame.item_uuid, 'item-7');
  socket.receive({
    type: 'command_ack',
    command_id: continueFrame.command_id,
    ok: false,
    error: 'item cannot be cued',
  });
  assert.equal(await continueResult, false);

  const nextRemoteToken = 'next-remote-token-5678';
  server.configureRemoteConnection('https://next.example', nextRemoteToken);
  assert.equal(server.effectiveAccessToken, nextRemoteToken);
  assert.equal(storage.getItem('liveplay.accessToken'), nextRemoteToken);
  assert.equal(
    new URL(sockets.at(-1)?.url ?? '').searchParams.get('access_token'),
    nextRemoteToken,
  );
  assert.equal(
    sockets.some(({ url }) => url.startsWith(`${localUrl}/ws`) && url.includes(remoteToken)),
    false,
  );

  server.destroy();
});
