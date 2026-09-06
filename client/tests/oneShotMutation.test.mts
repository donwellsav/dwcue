import assert from 'node:assert/strict';
import test from 'node:test';
import { reactive } from 'vue';
import type { AudioItem, Project } from '../app/types/project';
import type { OneShotMutationIdentity, OneShotMutationRequest } from '../app/types/oneShotMutation';
import type { OneShotMutationDraft } from '../app/utils/oneShotMutation';
import { applyOneShotMutation, createDetachedOneShotMutationClient } from '../app/utils/oneShotMutation';

const identity: OneShotMutationIdentity = {
  projectPath: '/shows/a.dwcue', projectEpoch: 7, ownerSessionId: 'primary-1',
};
const audio = (uuid: string, order: number): AudioItem => ({
  uuid, index: [], displayName: uuid, color: '#00cc99', type: 'audio',
  mediaFileName: `${uuid}.wav`, mediaPath: `media/${uuid}.wav`, waveformPath: '',
  inPoint: 0, outPoint: 10, volume: 1, duration: 10, fadeOutDuration: 1,
  playFade: 0, stopFade: 0, crossFade: 0, customActions: [],
  endBehavior: { action: 'nothing' }, startBehavior: { action: 'nothing' },
  duckingBehavior: { mode: 'duck-others', duckLevel: 0.1 },
  oneShot: { order, retrigger: 'restart', armed: true },
});
const document = () => {
  const playlist = audio('playlist', 0);
  const standalone = audio('standalone', 1);
  const project: Project = {
    name: 'Test', version: '2', folderPath: '/shows/a', items: [playlist], cartItems: [],
    cartOnlyItems: [standalone], theme: { mode: 'dark', accentColor: '#315fcf' }, settings: {},
    createdAt: '', lastModified: '',
  };
  return { project, cartOnlyItems: new Map([[standalone.uuid, standalone]]), playlist, standalone };
};
const request = (value: OneShotMutationDraft): OneShotMutationRequest =>
  ({ ...value, requestId: crypto.randomUUID(), identity } as OneShotMutationRequest);

test('applies every allowed detached field and rejects arbitrary patch keys', () => {
  const state = document();
  const result = applyOneShotMutation(state, request({
    kind: 'set-fields', itemUuid: 'standalone', payload: { fields: {
      displayName: 'Updated', color: '#112233', volume: 0.5, playFade: 2, stopFade: 3,
      duckLevel: 0.2, duckFadeIn: 0.3, duckFadeOut: 0.4, deviceOverride: 'out-2',
      retrigger: 'ignore', autoDisarm: false, hotkey: { key: 'F1' },
      playbackMode: 'replace', endMode: 'loop',
    } },
  }));
  assert.equal(result.accepted, true);
  assert.equal(state.standalone.displayName, 'Updated');
  assert.equal(state.standalone.volume, 0.5);
  assert.deepEqual(state.standalone.duckingBehavior, {
    mode: 'stop-all', duckLevel: 0.2, duckFadeIn: 0.3, duckFadeOut: 0.4,
  });
  assert.equal(state.standalone.oneShot?.retrigger, 'ignore');
  assert.equal(state.standalone.oneShot?.autoDisarm, false);
  assert.deepEqual(state.standalone.oneShot?.hotkey, { key: 'F1' });
  assert.equal(state.standalone.endBehavior.action, 'loop');
  const rejected = applyOneShotMutation(state, request({
    kind: 'set-fields', itemUuid: 'standalone',
    payload: { fields: { server: { projectFilePath: '/evil' } } },
  } as unknown as OneShotMutationDraft));
  assert.equal(rejected.accepted, false);
});

test('arms, disarms all, moves, removes, and replaces topology', () => {
  const state = document();
  applyOneShotMutation(state, request({ kind: 'set-armed', itemUuid: 'standalone', payload: { armed: false } }));
  assert.equal(state.standalone.oneShot?.armed, undefined);
  applyOneShotMutation(state, request({ kind: 'set-armed', itemUuid: 'standalone', payload: { armed: true } }));
  applyOneShotMutation(state, request({ kind: 'disarm-all', payload: {} }));
  assert.equal(state.playlist.oneShot?.armed, undefined);
  assert.equal(state.standalone.oneShot?.armed, undefined);
  applyOneShotMutation(state, request({
    kind: 'move-slot', itemUuid: 'standalone', payload: { sourceSlot: 1, targetSlot: 0 },
  }));
  assert.equal(state.standalone.oneShot?.order, 0);
  assert.equal(state.playlist.oneShot?.order, 1);
  applyOneShotMutation(state, request({ kind: 'remove-slot', itemUuid: 'playlist', payload: {} }));
  assert.equal(state.playlist.oneShot, undefined);
  const replacement = audio('replacement', 0);
  assert.equal(applyOneShotMutation(state, request({
    kind: 'replace-slot', payload: { slot: 0, item: replacement },
  })).accepted, true);
  assert.equal(state.cartOnlyItems.get('replacement')?.uuid, 'replacement');
});

test('invalid replacements and slot moves preserve every existing cue', () => {
  const invalidReplacements = [
    audio('', 1),
    { ...audio('replacement', 1), mediaPath: '' },
    { ...audio('replacement', 1), duration: Number.NaN },
    audio('playlist', 1),
    audio('standalone', 1),
  ];
  for (const item of invalidReplacements) {
    const state = document();
    const before = JSON.stringify({ project: state.project, cart: [...state.cartOnlyItems] });
    const result = applyOneShotMutation(state, request({ kind: 'replace-slot', payload: { slot: 1, item } }));
    assert.equal(result.accepted, false);
    assert.equal(JSON.stringify({ project: state.project, cart: [...state.cartOnlyItems] }), before);
  }
  for (const slot of [-1, 256, Number.MAX_SAFE_INTEGER, 1.5]) {
    const state = document();
    assert.equal(applyOneShotMutation(state, request({
      kind: 'move-slot', itemUuid: 'standalone', payload: { sourceSlot: 1, targetSlot: slot },
    })).accepted, false);
    assert.equal(applyOneShotMutation(state, request({
      kind: 'replace-slot', payload: { slot, item: audio('replacement', slot) },
    })).accepted, false);
    assert.equal(state.standalone.oneShot?.order, 1);
    assert.equal(state.cartOnlyItems.get('standalone'), state.standalone);
    assert.equal(state.playlist.oneShot?.order, 0);
  }
  const state = document();
  assert.equal(applyOneShotMutation(state, request({
    kind: 'move-slot', itemUuid: 'standalone', payload: { sourceSlot: 1, targetSlot: 255 },
  })).accepted, true);
  assert.equal(state.standalone.oneShot?.order, 255);
});
test('replace-slot rejects incomplete or malformed nested AudioItems without changing state', () => {
  const requiredFields: Array<keyof AudioItem> = [
    'outPoint', 'startBehavior', 'endBehavior', 'duckingBehavior', 'customActions',
    'fadeOutDuration', 'playFade', 'stopFade', 'crossFade',
  ];
  const incomplete = requiredFields.map((field) => {
    const item = structuredClone(audio('replacement', 1));
    Reflect.deleteProperty(item, field);
    return item;
  });
  const malformed: unknown[] = [
    { ...audio('replacement', 1), outPoint: Number.NaN },
    { ...audio('replacement', 1), playFade: -1 },
    { ...audio('replacement', 1), stopFade: Number.POSITIVE_INFINITY },
    { ...audio('replacement', 1), crossFade: 31 },
    { ...audio('replacement', 1), duckingBehavior: { mode: 'duck-everything', duckLevel: 0.1 } },
    { ...audio('replacement', 1), duckingBehavior: { mode: 'duck-others', duckLevel: 2 } },
    { ...audio('replacement', 1), endBehavior: { action: 'goto-item' } },
    { ...audio('replacement', 1), endBehavior: { action: 'mystery' } },
    { ...audio('replacement', 1), startBehavior: { action: 'play-index', targetIndex: [0, -1] } },
    { ...audio('replacement', 1), customActions: [{ timePoint: -1, action: { type: 'stop-all' } }] },
    { ...audio('replacement', 1), customActions: [{ timePoint: 1, action: { type: 'play-item', uuid: '' } }] },
    { ...audio('replacement', 1), customActions: [{
      timePoint: 1, action: { type: 'http-request', request: { method: 'PATCH', url: '/hook', contentType: 'json' } },
    }] },
    { ...audio('replacement', 1), oneShot: { order: 1, retrigger: 'sometimes' } },
  ];

  for (const item of [...incomplete, ...malformed]) {
    const state = document();
    const before = structuredClone({ project: state.project, cart: [...state.cartOnlyItems] });
    const draft = { kind: 'replace-slot', payload: { slot: 1, item } } as unknown as OneShotMutationDraft;
    const result = applyOneShotMutation(state, request(draft));
    assert.equal(result.accepted, false);
    assert.deepEqual({ project: state.project, cart: [...state.cartOnlyItems] }, before);
  }
});

test('replace-slot preserves a complete factory-shaped AudioItem exactly', () => {
  const state = document();
  const replacement = audio('factory-replacement', 1);
  replacement.customActions = [{ timePoint: 2, action: { type: 'stop-all' } }];
  replacement.startBehavior = { action: 'play-item', targetUuid: 'playlist' };
  replacement.endBehavior = { action: 'goto-index', targetIndex: [0] };
  replacement.duckingBehavior = { mode: 'duck-others', duckLevel: 0.25, duckFadeIn: 0.5, duckFadeOut: 1 };
  const result = applyOneShotMutation(state, request({
    kind: 'replace-slot', payload: { slot: 1, item: replacement },
  }));
  assert.equal(result.accepted, true);
  assert.deepEqual(state.cartOnlyItems.get(replacement.uuid), replacement);
  assert.notEqual(state.cartOnlyItems.get(replacement.uuid), replacement);
});

test('detached requests are serialized and stale completions are rejected', async () => {
  const pending: Array<{
    request: OneShotMutationRequest;
    resolve(value: { requestId: string; identity: OneShotMutationIdentity; accepted: boolean; persisted: boolean }): void;
  }> = [];
  const client = createDetachedOneShotMutationClient({
    requestOneShotMutation(mutation) {
      return new Promise(resolve => pending.push({ request: mutation, resolve }));
    },
  }, () => identity);
  const first = client({ kind: 'set-armed', itemUuid: 'standalone', payload: { armed: false } });
  const second = client({ kind: 'set-armed', itemUuid: 'standalone', payload: { armed: true } });
  await Promise.resolve();
  assert.equal(pending.length, 1);
  pending[0]!.resolve({
    requestId: pending[0]!.request.requestId, identity, accepted: true, persisted: false,
  });
  assert.equal((await first).accepted, true);
  await Promise.resolve();
  assert.equal(pending.length, 2);
  pending[1]!.resolve({
    requestId: pending[1]!.request.requestId,
    identity: { ...identity, projectEpoch: 6 }, accepted: true, persisted: true,
  });
  assert.equal((await second).accepted, false);
});

test('detached requests cross the IPC boundary as plain DTOs when identity and payload are reactive', async () => {
  const reactiveIdentity = reactive({ ...identity });
  const reactiveDraft = reactive({
    kind: 'set-fields' as const,
    itemUuid: 'standalone',
    payload: {
      fields: {
        retrigger: 'ignore' as const,
        hotkey: { key: 'Digit1', ctrl: true },
      },
    },
  });
  let received: OneShotMutationRequest | null = null;
  const client = createDetachedOneShotMutationClient({
    async requestOneShotMutation(mutation) {
      received = structuredClone(mutation);
      return { requestId: mutation.requestId, identity: mutation.identity, accepted: true, persisted: true };
    },
  }, () => reactiveIdentity);

  const result = await client(reactiveDraft);

  assert.equal(result.accepted, true);
  assert.deepEqual(received?.identity, identity);
  assert.deepEqual(received?.payload, {
    fields: { retrigger: 'ignore', hotkey: { key: 'Digit1', ctrl: true } },
  });
});
