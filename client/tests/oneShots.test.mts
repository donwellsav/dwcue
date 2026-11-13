import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOneShotSlots,
  cloneAsIndependentOneShot,
  cloneAsPlaylistItem,
  flattenOneShots,
  markAsOneShot,
  nextAvailableOneShotOrder,
  nextOneShotOrder,
  removeOneShotDesignation,
} from '../app/utils/oneShots.ts';
import { computed, ref } from 'vue';
import { useOneShotPlayback } from '../app/composables/useOneShotPlayback.ts';
import { resolveKeyboardBindings } from '../app/composables/useCartHotkeys.ts';
import type { AudioItem } from '../app/types/project.ts';

const audio = (uuid: string, order?: number) => ({
  uuid,
  index: [],
  displayName: uuid,
  color: '#00CC99',
  type: 'audio' as const,
  mediaFileName: `${uuid}.wav`,
  mediaPath: `media/${uuid}.wav`,
  waveformPath: '',
  inPoint: 0,
  outPoint: 10,
  volume: 1,
  endBehavior: { action: 'next' as const },
  startBehavior: { action: 'play-next' as const },
  customActions: [],
  duckingBehavior: { mode: 'stop-all' as const },
  duration: 10,
  fadeOutDuration: 1,
  playFade: 0,
  stopFade: 0,
  crossFade: 0,
  ...(order === undefined ? {} : { oneShot: { order, retrigger: 'restart' as const } }),
});

test('flattens only designated audio cues in stable One Shot order', () => {
  const unordered = audio('unordered');
  (unordered as any).oneShot = { retrigger: 'restart' };
  const items = [
    audio('not-one-shot'),
    {
      uuid: 'group', index: [1], displayName: 'Group', color: '#333', type: 'group' as const,
      startBehavior: { action: 'play-first' as const }, endBehavior: { action: 'nothing' as const },
      isExpanded: true,
      children: [audio('second', 8), unordered, audio('first', 2)],
    },
  ];
  assert.deepEqual(flattenOneShots(items as any).map(item => item.uuid), [
    'first', 'second', 'unordered',
  ]);
  assert.equal(nextOneShotOrder(items as any), 9);
});

test('new designation uses safe quick-play defaults', () => {
  const item = audio('announcement');
  markAsOneShot(item as any, 4);
  assert.deepEqual((item as any).oneShot, { order: 4, retrigger: 'restart' });
  assert.deepEqual(item.endBehavior, { action: 'nothing' });
  assert.deepEqual(item.startBehavior, { action: 'nothing' });
  assert.deepEqual(item.duckingBehavior, { mode: 'stop-all' });
  assert.equal(item.playFade, 0.1);
  assert.equal(item.stopFade, 0.5);
  assert.equal(item.fadeOutDuration, 0.5);
});

test('playlist cues copy into independent One Shots without sharing behavior', () => {
  const source = audio('playlist-source');
  Object.assign(source, { crossFade: 3, startNextEnabled: true });
  const clone = cloneAsIndependentOneShot(source as any, 'one-shot-copy', 3);

  assert.equal(clone.uuid, 'one-shot-copy');
  assert.deepEqual(clone.index, [-1, 3]);
  assert.equal(clone.oneShot?.sourceUuid, 'playlist-source');
  assert.deepEqual(clone.duckingBehavior, { mode: 'stop-all' });
  assert.equal(clone.playFade, 0.1);
  assert.equal(clone.stopFade, 0.5);
  assert.equal(clone.crossFade, 0);
  assert.equal(clone.startNextEnabled, false);
  assert.equal(source.crossFade, 3);
  assert.equal(source.playFade, 0);
  assert.deepEqual(clone.startBehavior, { action: 'nothing' });
  assert.deepEqual(clone.endBehavior, { action: 'nothing' });
  clone.displayName = 'Independent name';
  assert.equal(source.displayName, 'playlist-source');
  assert.equal((source as any).oneShot, undefined);
});

test('digits follow slot position and saved keyboard assignments take precedence', () => {
  const slots: (AudioItem | null)[] = Array.from({ length: 21 }, (_, index) => audio(String(index), index));
  const { keyMappings, playbackMappings, pauseAlternate } = resolveKeyboardBindings(slots);
  assert.deepEqual(Object.values(keyMappings).map(binding => binding.key), [...'12345678901234567890']);
  assert.deepEqual(Object.values(keyMappings).map(binding => binding.shiftKey),
    [...Array(10).fill(false), ...Array(10).fill(true)]);
  assert.equal(keyMappings[20], undefined);
  assert.equal(playbackMappings['set-up-next']?.key, 'Enter');
  assert.equal(playbackMappings['set-up-next']?.shiftKey, false);
  assert.equal(playbackMappings['play-selected']?.key, 'Enter');
  assert.equal(playbackMappings['play-selected']?.shiftKey, true);
  assert.equal(playbackMappings['toggle-loop']?.key, 'l');
  assert.equal(playbackMappings['jump-cue']?.key, 'j');
  assert.equal(playbackMappings['cue-to-continue']?.key, 'c');
  assert.equal(playbackMappings['pause-resume']?.key, 'p');
  assert.deepEqual(pauseAlternate, { key: ' ', ctrlKey: false, shiftKey: true, altKey: false });
  assert.equal(playbackMappings['play-next']?.key, ' ');
  assert.equal(playbackMappings['toggle-video-output']?.key, 'v');

  const key = (value: string) => ({ key: value, ctrlKey: false, shiftKey: false, altKey: false });
  slots[0] = null;
  slots[2]!.oneShot!.hotkey = null;
  slots[10]!.oneShot!.hotkey = key('2');
  const saved = resolveKeyboardBindings(slots, { 'stop-all': key('4'), 'play-selected': key('Enter') });
  for (const index of [0, 1, 2, 3]) assert.equal(saved.keyMappings[index], undefined);
  assert.equal(saved.keyMappings[9].key, '0');
  assert.equal(saved.keyMappings[10].key, '2');
  assert.equal(saved.playbackMappings['stop-all']?.key, '4');
  assert.equal(saved.playbackMappings['play-selected']?.key, 'Enter');
  assert.equal(saved.playbackMappings['set-up-next'], undefined);
  const shiftedDigit = { ...key('0'), shiftKey: true };
  assert.equal(resolveKeyboardBindings(slots, { 'stop-all': shiftedDigit }).keyMappings[19], undefined);
  slots[10]!.oneShot!.hotkey = key('Enter');
  assert.equal(resolveKeyboardBindings(slots).playbackMappings['set-up-next'], undefined);
  slots[10]!.oneShot!.hotkey = key('v');
  assert.equal(resolveKeyboardBindings(slots).playbackMappings['toggle-video-output'], undefined);
  slots[10]!.oneShot!.hotkey = key('L');
  assert.equal(resolveKeyboardBindings(slots).playbackMappings['toggle-loop'], undefined);
  slots[10]!.oneShot!.hotkey = { ...key('Enter'), shiftKey: true };
  const shifted = resolveKeyboardBindings(slots, { 'toggle-loop': null });
  assert.equal(shifted.playbackMappings['play-selected'], undefined);
  assert.equal(shifted.playbackMappings['set-up-next']?.key, 'Enter');
  assert.equal(shifted.playbackMappings['toggle-loop'], null);
  assert.equal(resolveKeyboardBindings(slots, { 'jump-cue': key('l') }).playbackMappings['toggle-loop'], undefined);
  assert.equal(resolveKeyboardBindings(slots, { 'pause-resume': null }).pauseAlternate, null);
  assert.equal(resolveKeyboardBindings(slots, { 'stop-all': pauseAlternate }).pauseAlternate, null);
  slots[10]!.oneShot!.hotkey = pauseAlternate;
  assert.equal(resolveKeyboardBindings(slots).pauseAlternate, null);
  slots[10]!.oneShot!.hotkey = key('j');
  assert.equal(resolveKeyboardBindings(slots).playbackMappings['jump-cue'], undefined);
  assert.equal(resolveKeyboardBindings(slots, { 'select-up': key('c') }).playbackMappings['cue-to-continue'], undefined);
});

test('One Shot copies into the playlist without consuming the source cell', () => {
  const source = audio('one-shot-source', 4);
  (source as any).oneShot.sourceUuid = 'original-playlist-cue';
  source.displayName = 'Announcement';

  const clone = cloneAsPlaylistItem(source as any, 'playlist-copy');

  assert.equal(clone.uuid, 'playlist-copy');
  assert.deepEqual(clone.index, [0]);
  assert.equal(clone.oneShot, undefined);
  assert.equal(clone.displayName, 'Announcement');
  assert.equal(source.oneShot?.order, 4);
});

test('builds permanent addressable cells across playlist and standalone One Shots', () => {
  const playlistItems = [audio('playlist', 2)];
  const standaloneItems = [audio('standalone', 0), audio('later', 5)];
  const slots = buildOneShotSlots(playlistItems as any, standaloneItems as any, 4);

  assert.equal(slots.length, 6);
  assert.equal(slots[0]?.uuid, 'standalone');
  assert.equal(slots[1], null);
  assert.equal(slots[2]?.uuid, 'playlist');
  assert.equal(slots[5]?.uuid, 'later');
  assert.deepEqual(
    flattenOneShots(playlistItems as any, standaloneItems as any).map(item => item.uuid),
    ['standalone', 'playlist', 'later'],
  );
  assert.equal(nextAvailableOneShotOrder(playlistItems as any, standaloneItems as any), 1);
});

test('repairs duplicate and invalid saved cell orders without creating an unbounded grid', () => {
  const duplicate = audio('duplicate', 1);
  const first = audio('first', 1);
  const corrupt = audio('corrupt', 999_999);
  const slots = buildOneShotSlots([first, duplicate, corrupt] as any, [], 2);

  assert.equal(slots.length, 3);
  assert.equal(slots[1]?.uuid, 'first');
  assert.deepEqual(slots.filter(Boolean).map(item => item!.uuid).sort(), [
    'corrupt', 'duplicate', 'first',
  ]);
});

test('removing One Shot designation never deletes or rewrites the cue', () => {
  const item = audio('sting', 3);
  const expected = structuredClone(item) as any;
  delete expected.oneShot;

  removeOneShotDesignation(item as any);

  assert.deepEqual(item, expected);
});

test('One Shots use primary or detached show readiness, with no arm requirement', async () => {
  const hydration = ref('loading');
  const identity = ref<object | null>(null);
  const activeCues = ref(new Map());
  const item = audio('sting', 0) as AudioItem;
  let detached = false;
  const starts: string[] = [];
  Object.assign(globalThis, {
    computed,
    useProject: () => ({ projectHydrationStatus: hydration }),
    useDetachedOneShotMutation: () => ({ isDetached: detached, identity }),
    useAudioEngine: () => ({ activeCues, playCue: async (cue: AudioItem) => {
      starts.push(cue.uuid);
      return true;
    } }),
  });
  const primary = useOneShotPlayback();
  assert.equal(await primary.playOneShot(item), false);
  hydration.value = 'ready';
  assert.equal(await primary.playOneShot(item), true, 'an unarmed cue fires directly');
  item.oneShot!.armed = true;
  item.oneShot!.autoDisarm = true;
  assert.equal(await primary.playOneShot(item), true);
  assert.equal(item.oneShot!.armed, true, 'legacy metadata is untouched');

  detached = true;
  hydration.value = 'failed';
  const bank = useOneShotPlayback();
  assert.equal(await bank.playOneShot(item), false, 'the detached bank needs a current owner');
  identity.value = {};
  assert.equal(await bank.playOneShot(item), true);
  item.oneShot!.retrigger = 'ignore';
  activeCues.value.set(item.uuid, {});
  assert.equal(await bank.playOneShot(item), false);
  identity.value = null;
  activeCues.value.clear();
  assert.equal(await bank.playOneShot(item), false);
  assert.deepEqual(starts, ['sting', 'sting', 'sting']);
});
