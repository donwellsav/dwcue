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
const fetchRequests: Array<{ url: string; method: string }> = [];
let nextRecoveryRequestId = 73;

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
  value: async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchAuthorizations.push(new Headers(init?.headers).get('Authorization') ?? '');
    fetchRequests.push({ url, method: init?.method ?? 'GET' });
    const recovery = url.endsWith('/api/devices/device%2Fmain/recover');
    const body = recovery
      ? { accepted: true, request_id: nextRecoveryRequestId++ }
      : [];
    return new Response(JSON.stringify(body), {
      status: recovery ? 202 : 200,
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
  const { recoveryResultForRequest } = await import('../app/types/server.ts');
  const server = useLiveplayServer();
  const docPatches: Array<Record<string, unknown>> = [];
  server.onDocPatch((patch) => { docPatches.push(patch); });
  let recoveryHookCalls = 0;
  server.onReconnected(() => { recoveryHookCalls++; });
  let cueStateItemUuid: string | undefined;
  let cueStateTriggerSeq: number | undefined;
  let snapshotTriggerSeq: number | undefined;
  server.onCueState((state) => {
    cueStateItemUuid = state.item_uuid;
    cueStateTriggerSeq = state.trigger_seq;
  });
  server.onPlaybackSnapshot((snapshot) => {
    snapshotTriggerSeq = snapshot.cues[0]?.trigger_seq;
  });

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
  const stalledDevice = {
    id: 'device/main',
    display_name: 'Main Output',
    channel_count: 2,
    sample_rate: 48_000,
    is_default: true,
    is_open: true,
    is_available: true,
    is_clock_master: true,
    runtime_state: 'stalled',
    recovery_request_id: 0,
    recovery_status: 'idle',
    callback_entry_count: 0,
    stream_recovery_count: 0,
    underrun_count: 0,
    underrun_frames: 0,
    overrun_count: 0,
    hard_resync_count: 0,
    device_loss_count: 0,
    device_recovery_count: 0,
    reroute_count: 0,
    interruption_count: 0,
    correction_limit_count: 0,
    ring_occupancy_frames: 0,
    clock_correction_ppm: 0,
  } as const;
  // Let the initial REST catalogue settle before exercising the live WS update.
  await server.fetchDevices();
  const socketCountBeforeDeviceState = sockets.length;
  firstSocket.receive({ type: 'device_state', device: stalledDevice });
  assert.equal(server.connected, true);
  assert.equal(sockets.length, socketCountBeforeDeviceState);
  assert.equal(server.devices[0]?.runtime_state, 'stalled');
  assert.equal(server.devices[0]?.callback_entry_count, 0);

  const recovery = await server.recoverDevice(stalledDevice.id);
  assert.deepEqual(recovery, { accepted: true, request_id: 73 });
  assert.deepEqual(fetchRequests.at(-1), {
    url: localUrl + '/api/devices/device%2Fmain/recover',
    method: 'POST',
  });
  assert.equal(fetchAuthorizations.at(-1), 'Bearer ' + managedToken);
  assert.equal(server.devices[0]?.runtime_state, 'stalled');
  assert.equal(sockets.length, socketCountBeforeDeviceState);

  firstSocket.receive({
    type: 'device_state',
    device: {
      ...stalledDevice,
      runtime_state: 'starting',
      recovery_request_id: recovery.request_id,
      recovery_status: 'pending',
    },
  });
  const pendingAttempt = server.devices[0];
  assert.ok(pendingAttempt);
  assert.equal(recoveryResultForRequest(pendingAttempt, recovery.request_id), null);

  // A running callback correlated to another request cannot complete this one.
  firstSocket.receive({
    type: 'device_state',
    device: {
      ...stalledDevice,
      runtime_state: 'running',
      recovery_request_id: recovery.request_id - 1,
      recovery_status: 'succeeded',
      callback_entry_count: 1,
    },
  });
  const staleSuccess = server.devices[0];
  assert.ok(staleSuccess);
  assert.equal(recoveryResultForRequest(staleSuccess, recovery.request_id), null);

  firstSocket.receive({
    type: 'device_state',
    device: {
      ...stalledDevice,
      recovery_request_id: recovery.request_id,
      recovery_status: 'failed',
    },
  });
  const failedAttempt = server.devices[0];
  assert.ok(failedAttempt);
  assert.equal(recoveryResultForRequest(failedAttempt, recovery.request_id), 'failed');

  const retry = await server.recoverDevice(stalledDevice.id);
  assert.deepEqual(retry, { accepted: true, request_id: 74 });
  firstSocket.receive({
    type: 'device_state',
    device: {
      ...stalledDevice,
      runtime_state: 'running',
      recovery_request_id: recovery.request_id,
      recovery_status: 'succeeded',
      callback_entry_count: 2,
    },
  });
  const priorAttemptSuccess = server.devices[0];
  assert.ok(priorAttemptSuccess);
  assert.equal(recoveryResultForRequest(priorAttemptSuccess, retry.request_id), null);

  firstSocket.receive({
    type: 'device_state',
    device: {
      ...stalledDevice,
      runtime_state: 'running',
      recovery_request_id: retry.request_id,
      recovery_status: 'succeeded',
      callback_entry_count: 3,
      stream_recovery_count: 1,
    },
  });
  const successfulRetry = server.devices[0];
  assert.ok(successfulRetry);
  assert.equal(recoveryResultForRequest(successfulRetry, retry.request_id), 'succeeded');
  assert.equal(successfulRetry.runtime_state, 'running');
  assert.equal(successfulRetry.callback_entry_count, 3);
  assert.equal(recoveryResultForRequest(
    { ...successfulRetry, runtime_state: 'starting' },
    retry.request_id,
  ), 'failed');
  firstSocket.receive({
    type: 'cue_state',
    cue_id: 'cue-1',
    item_uuid: 'item-1',
    transport: 1,
    playhead_seconds: 0.25,
    trigger_seq: 41,
  });
  assert.equal(cueStateItemUuid, 'item-1');
  assert.equal(cueStateTriggerSeq, 41);
  firstSocket.receive({
    type: 'playback_snapshot',
    cues: [{
      cue_id: 'cue-1',
      item_uuid: 'item-1',
      transport: 1,
      playhead_seconds: 0.25,
      trigger_seq: 42,
    }],
    next_item_uuid: '',
    master_gain_db: 0,
    output_channel_gains: [],
    selected_item_uuid: '',
    show_mode: false,
    locale: 'en',
    preview: { item_uuid: '', cue_id: '' },
  });
  assert.equal(snapshotTriggerSeq, 42);

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
  const nextResult = server.setNextItem('item-8');
  const nextFrame = JSON.parse(rotatedSocket.sent.at(-1) ?? '{}');
  assert.equal(nextFrame.type, 'set_next_item');
  assert.equal(nextFrame.item_uuid, 'item-8');
  assert.equal(typeof nextFrame.command_id, 'string');
  rotatedSocket.receive({ type: 'command_ack', command_id: nextFrame.command_id, ok: true });
  assert.equal(await nextResult, true);

  const invalidNextResult = server.setNextItem('missing-item');
  const invalidNextFrame = JSON.parse(rotatedSocket.sent.at(-1) ?? '{}');
  rotatedSocket.receive({
    type: 'command_ack',
    command_id: invalidNextFrame.command_id,
    ok: false,
    error: 'unknown set-next target',
  });
  assert.equal(await invalidNextResult, false);
  assert.equal(server.lastError, 'unknown set-next target');

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
  const primaryPlay = server.playItem('source-item');
  const primaryPlayFrame = JSON.parse(rotatedSocket.sent.at(-1) ?? '{}');
  rotatedSocket.receive({
    type: 'playback_error',
    code: 'sequence_target_invalid',
    message: 'Start action target was unavailable or cyclic',
    item_uuid: 'source-item',
    target_uuid: 'missing-secondary',
  });
  const sequenceWarning = 'Start action target was unavailable or cyclic (target missing-secondary). The source cue is still playing.';
  assert.equal(server.lastError, sequenceWarning);
  rotatedSocket.receive({ type: 'command_ack', command_id: primaryPlayFrame.command_id, ok: true });
  assert.equal(await primaryPlay, true);
  assert.equal(server.lastError, sequenceWarning, 'successful primary acknowledgement cleared the secondary-action warning');

  const lostAckResult = server.setNextItem('item-9');
  rotatedSocket.receive({ type: 'doc_patch', op: 'next_item_set', itemUuid: 'item-9' });
  assert.deepEqual(docPatches.at(-1), {
    type: 'doc_patch',
    op: 'next_item_set',
    itemUuid: 'item-9',
  });
  rotatedSocket.onclose?.({});
  assert.equal(await lostAckResult, false);
  assert.equal(rotatedSocket.sent.filter((frame) => {
    const parsed = JSON.parse(frame);
    return parsed.type === 'set_next_item' && parsed.item_uuid === 'item-9';
  }).length, 1, 'unconfirmed Set As Next command was retried automatically');

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
