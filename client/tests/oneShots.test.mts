import assert from 'node:assert/strict';
import test from 'node:test';

import {
  flattenOneShots,
  markAsOneShot,
  nextOneShotOrder,
  removeOneShotDesignation,
} from '../app/utils/oneShots.mts';

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

test('removing One Shot designation never deletes or rewrites the cue', () => {
  const item = audio('sting', 3);
  const expected = structuredClone(item) as any;
  delete expected.oneShot;

  removeOneShotDesignation(item as any);

  assert.deepEqual(item, expected);
});
