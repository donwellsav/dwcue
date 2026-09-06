const assert = require('node:assert/strict');
const test = require('node:test');
const { managedWebSocketHeaders } = require('../electron/managed-websocket-origin');

const token = 'ab'.repeat(32);
const identity = { port: 4480, accessToken: token, legacy: false };
function request(overrides = {}) {
  return {
    resourceType: 'webSocket',
    url: `ws://127.0.0.1:4480/ws?access_token=${token}`,
    requestHeaders: { Origin: 'file://', Upgrade: 'websocket' },
    ...overrides,
  };
}

test('only a trusted authenticated managed WebSocket receives the opaque origin', () => {
  const details = request();
  assert.deepEqual(managedWebSocketHeaders(details, identity, true), {
    Origin: 'null', Upgrade: 'websocket',
  });
  assert.equal(details.requestHeaders.Origin, 'file://');
  const lowerCase = request({ requestHeaders: { origin: 'file://' } });
  assert.deepEqual(managedWebSocketHeaders(lowerCase, identity, true), { origin: 'null' });
});

test('untrusted renderers, unmanaged identities, and non-WebSocket traffic are untouched', () => {
  for (const [details, managed, trusted] of [
    [request(), identity, false],
    [request(), null, true],
    [request(), { ...identity, legacy: true }, true],
    [request(), { ...identity, accessToken: '' }, true],
    [request({ resourceType: 'xhr' }), identity, true],
  ]) {
    assert.equal(managedWebSocketHeaders(details, managed, trusted), details.requestHeaders);
  }
});

test('alternate destinations and credentials cannot gain the compatibility origin', () => {
  for (const url of [
    `ws://remote.example:4480/ws?access_token=${token}`,
    `ws://127.0.0.1:4481/ws?access_token=${token}`,
    `ws://127.0.0.1:4480/other?access_token=${token}`,
    `wss://127.0.0.1:4480/ws?access_token=${token}`,
    `ws://user@127.0.0.1:4480/ws?access_token=${token}`,
    'ws://127.0.0.1:4480/ws',
    'ws://127.0.0.1:4480/ws?access_token=wrong',
    `ws://127.0.0.1:4480/ws?access_token=${token}&access_token=${token}`,
  ]) {
    const details = request({ url });
    assert.equal(managedWebSocketHeaders(details, identity, true), details.requestHeaders);
  }
});

test('existing opaque, website, absent, and malformed origins are not rewritten', () => {
  for (const requestHeaders of [{}, { Origin: 'null' }, { Origin: 'https://evil.example' }, { Origin: 'file://untrusted' }]) {
    const details = request({ requestHeaders });
    assert.equal(managedWebSocketHeaders(details, identity, true), requestHeaders);
  }
});
