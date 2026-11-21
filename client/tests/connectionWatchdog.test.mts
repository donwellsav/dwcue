import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ref } from 'vue';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(url: string | URL) { this.url = String(url); sockets.push(this); }
  send(): void {}
  close(): void { this.readyState = FakeWebSocket.CLOSED; }
  open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.({}); }
  receive(payload: Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify(payload) }); }
}

const sockets: FakeWebSocket[] = [];
const nuxtState = new Map<string, ReturnType<typeof ref>>();
const storage = new Map<string, string>();
let now = 1_000;
Object.defineProperty(globalThis, 'useState', {
  configurable: true,
  value: (key: string, initialize: () => unknown) => {
    if (!nuxtState.has(key)) nuxtState.set(key, ref(initialize()));
    return nuxtState.get(key);
  },
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) } },
});
Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeWebSocket });
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  value: async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
});
Object.defineProperty(performance, 'now', { configurable: true, value: () => now });

const tick = () => new Promise(resolve => setTimeout(resolve, 1_150));

test('a connection that goes silent is reported lost and reconnects; the next message clears it', async () => {
  const { useLiveplayServer } = await import('../app/composables/useLiveplayServer.ts');
  const server = useLiveplayServer();
  server.configureManagedConnection('http://127.0.0.1:4480', 'c'.repeat(64));
  const first = sockets.at(-1)!;
  first.open();
  assert.equal(server.connectionLost, false);

  now += 5_000;  // meters pausing for a few seconds is not a loss
  await tick();
  assert.equal(server.connectionLost, false);
  assert.equal(sockets.length, 1);

  first.receive({ type: 'meters', items: [] });
  now += 9_000;  // then nothing at all for longer than the limit
  await tick();
  assert.equal(server.connectionLost, true, 'the operator is told the engine stopped answering');
  assert.equal(sockets.length, 2, 'and it connects again');

  const second = sockets.at(-1)!;
  second.open();
  assert.equal(server.connectionLost, true, 'an open socket alone does not prove the engine answers');
  second.receive({ type: 'meters', items: [] });
  assert.equal(server.connectionLost, false, 'its first message does');
});

test('the operator window starts a local engine that stopped for good, while the connection stays lost', () => {
  const plugin = readFileSync(new URL('../app/plugins/liveplay-server.client.ts', import.meta.url), 'utf8');
  assert.match(plugin, /query\.get\('quickPlayWindow'\) !== '1' && query\.get\('videoOutput'\) !== '1'/, 'the operator window only');
  assert.match(plugin, /if \(reviving \|\| !server\.connectionLost\) return;/);
  assert.match(plugin, /if \(!cfg \|\| cfg\.mode === 'remote' \|\| status\?\.running\) return;/, 'not a remote or still-running engine');
  assert.match(plugin, /await applyElectronConfig\(cfg, status, true\);/);
});
