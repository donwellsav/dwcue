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
  assert.equal(item.duckingBehavior.mode, 'no-ducking');
});

test('playlist cues copy into independent One Shots without sharing behavior', () => {
  const source = audio('playlist-source');
  const clone = cloneAsIndependentOneShot(source as any, 'one-shot-copy', 3);

  assert.equal(clone.uuid, 'one-shot-copy');
  assert.deepEqual(clone.index, [-1, 3]);
  assert.equal(clone.oneShot?.sourceUuid, 'playlist-source');
  assert.equal(clone.duckingBehavior.mode, 'no-ducking');
  assert.deepEqual(clone.startBehavior, { action: 'nothing' });
  assert.deepEqual(clone.endBehavior, { action: 'nothing' });
  clone.displayName = 'Independent name';
  assert.equal(source.displayName, 'playlist-source');
  assert.equal((source as any).oneShot, undefined);
});

test('One Shot copies into the playlist without consuming the source cell', () => {
  const source = audio('one-shot-source', 4);
  source.oneShot!.sourceUuid = 'original-playlist-cue';
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
