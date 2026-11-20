import assert from 'node:assert/strict';
import test from 'node:test';
import { ref } from 'vue';

class FakeWebSocket {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(url: string | URL) { this.url = String(url); sockets.push(this); }
  send(): void {}
  close(): void { this.readyState = FakeWebSocket.CLOSED; }
}
const sockets: FakeWebSocket[] = [];
const nuxtState = new Map<string, ReturnType<typeof ref>>();
let releaseCatalogue: ((cues: unknown[]) => void) | null = null;
Object.defineProperty(globalThis, 'useState', {
  configurable: true,
  value: (key: string, initialize: () => unknown) => {
    if (!nuxtState.has(key)) nuxtState.set(key, ref(initialize()));
    return nuxtState.get(key);
  },
});
Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: { getItem: () => null, setItem: () => {} } } });
Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeWebSocket });
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  value: async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/api/cues')) {
      const cues = await new Promise<unknown[]>(resolve => { releaseCatalogue = resolve; });
      return new Response(JSON.stringify(cues), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  },
});

test('a slow cue catalogue reply cannot bring a stopped cue back as playing', async () => {
  const { useLiveplayServer } = await import('../app/composables/useLiveplayServer.ts');
  const server = useLiveplayServer() as any;
  server.configureManagedConnection('http://127.0.0.1:4480', 'd'.repeat(64));
  const socket = sockets.at(-1)!;
  socket.readyState = FakeWebSocket.OPEN;
  socket.onopen?.({});
  releaseCatalogue?.([]);  // the first connection's catalogue
  await new Promise(resolve => setTimeout(resolve, 10));

  const fetching = server.fetchCues();          // asked while the cue still plays
  await new Promise(resolve => setTimeout(resolve, 10));
  socket.onmessage?.({ data: JSON.stringify({ type: 'cue_state', cue_id: 'cue-1', transport: 0, playhead_seconds: 0 }) });
  releaseCatalogue?.([{ id: 'cue-1', transport: 1, playhead_seconds: 9.5 }]);  // the engine answered before the cue ended
  await fetching;
  assert.equal(server.cues.find((cue: any) => cue.id === 'cue-1')?.transport, 0, 'the newer stop stands');
});
