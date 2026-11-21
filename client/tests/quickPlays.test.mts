import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildQuickPlayCells,
  cloneAsIndependentQuickPlay,
  cloneAsPlaylistItem,
  flattenQuickPlays,
  getQuickPlayEndMode,
  markAsQuickPlay,
  nextAvailableQuickPlayOrder,
  nextQuickPlayOrder,
  quickPlayFollowsUpNext,
  removeQuickPlayDesignation,
  setQuickPlayEndMode,
} from '../app/utils/quickPlays.ts';
import { computed, ref } from 'vue';
import { useQuickPlayPlayback } from '../app/composables/useQuickPlayPlayback.ts';
import { bindingsMatch, resolveKeyboardBindings } from '../app/composables/useQuickPlayHotkeys.ts';
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
  ...(order === undefined ? {} : { quickPlay: { order, retrigger: 'restart' as const } }),
});

test('flattens only designated audio cues in stable QuickPlay order', () => {
  const unordered = audio('unordered');
  (unordered as any).quickPlay = { retrigger: 'restart' };
  const items = [
    audio('not-quickplay'),
    {
      uuid: 'group', index: [1], displayName: 'Group', color: '#333', type: 'group' as const,
      startBehavior: { action: 'play-first' as const }, endBehavior: { action: 'nothing' as const },
      isExpanded: true,
      children: [audio('second', 8), unordered, audio('first', 2)],
    },
  ];
  assert.deepEqual(flattenQuickPlays(items as any).map(item => item.uuid), [
    'first', 'second', 'unordered',
  ]);
  assert.equal(nextQuickPlayOrder(items as any), 9);
});

test('new designation uses safe quick-play defaults', () => {
  const item = audio('announcement');
  markAsQuickPlay(item as any, 4);
  assert.deepEqual((item as any).quickPlay, { order: 4, retrigger: 'restart' });
  assert.deepEqual(item.endBehavior, { action: 'nothing' });
  assert.deepEqual(item.startBehavior, { action: 'nothing' });
  assert.deepEqual(item.duckingBehavior, { mode: 'stop-all' });
  assert.equal(item.playFade, 0.1);
  assert.equal(item.stopFade, 0.5);
  assert.equal(item.fadeOutDuration, 0.5);
});

test('playlist cues copy into independent QuickPlays without sharing behavior', () => {
  const source = audio('playlist-source');
  Object.assign(source, { crossFade: 3, startNextEnabled: true });
  const clone = cloneAsIndependentQuickPlay(source as any, 'quickplay-copy', 3);

  assert.equal(clone.uuid, 'quickplay-copy');
  assert.deepEqual(clone.index, [-1, 3]);
  assert.equal(clone.quickPlay?.sourceUuid, 'playlist-source');
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
  assert.equal((source as any).quickPlay, undefined);
});

test('digits follow slot position and saved keyboard assignments take precedence', () => {
  const key = (value: string) => ({ key: value, ctrlKey: false, shiftKey: false, altKey: false });
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
  assert.deepEqual(playbackMappings['fullscreen-video-output'], key('f'));
  assert.deepEqual(playbackMappings['locate-live'], key('/'));
  assert.ok(bindingsMatch(playbackMappings['locate-up-next']!, key('?')));
  assert.ok(bindingsMatch(playbackMappings['locate-up-next']!, { ...key('?'), shiftKey: true }));
  assert.equal(resolveKeyboardBindings(slots, { 'play-selected': key('f') }).playbackMappings['fullscreen-video-output'], undefined);
  assert.deepEqual(playbackMappings['toggle-settings'], { key: 's', ctrlKey: false, shiftKey: false, altKey: false });
  assert.deepEqual(playbackMappings['toggle-properties'], { key: 's', ctrlKey: false, shiftKey: true, altKey: false });
  assert.deepEqual(playbackMappings['toggle-quickplays'], key('q'));
  assert.deepEqual(playbackMappings['toggle-detached-quickplays'], { ...key('q'), shiftKey: true });

  slots[0] = null;
  slots[2]!.quickPlay!.hotkey = null;
  slots[10]!.quickPlay!.hotkey = key('2');
  const saved = resolveKeyboardBindings(slots, { 'stop-all': key('4'), 'play-selected': key('Enter') });
  for (const index of [0, 1, 2, 3]) assert.equal(saved.keyMappings[index], undefined);
  assert.equal(saved.keyMappings[9].key, '0');
  assert.equal(saved.keyMappings[10].key, '2');
  assert.equal(saved.playbackMappings['stop-all']?.key, '4');
  assert.equal(saved.playbackMappings['play-selected']?.key, 'Enter');
  assert.equal(saved.playbackMappings['set-up-next'], undefined);
  const shiftedDigit = { ...key('0'), shiftKey: true };
  assert.equal(resolveKeyboardBindings(slots, { 'stop-all': shiftedDigit }).keyMappings[19], undefined);
  slots[10]!.quickPlay!.hotkey = key('Enter');
  assert.equal(resolveKeyboardBindings(slots).playbackMappings['set-up-next'], undefined);
  slots[10]!.quickPlay!.hotkey = key('v');
  assert.equal(resolveKeyboardBindings(slots).playbackMappings['toggle-video-output'], undefined);
  slots[10]!.quickPlay!.hotkey = key('L');
  assert.equal(resolveKeyboardBindings(slots).playbackMappings['toggle-loop'], undefined);
  slots[10]!.quickPlay!.hotkey = { ...key('Enter'), shiftKey: true };
  const shifted = resolveKeyboardBindings(slots, { 'toggle-loop': null });
  assert.equal(shifted.playbackMappings['play-selected'], undefined);
  assert.equal(shifted.playbackMappings['set-up-next']?.key, 'Enter');
  assert.equal(shifted.playbackMappings['toggle-loop'], null);
  assert.equal(resolveKeyboardBindings(slots, { 'jump-cue': key('l') }).playbackMappings['toggle-loop'], undefined);
  assert.equal(resolveKeyboardBindings(slots, { 'pause-resume': null }).pauseAlternate, null);
  assert.equal(resolveKeyboardBindings(slots, { 'stop-all': pauseAlternate }).pauseAlternate, null);
  slots[10]!.quickPlay!.hotkey = pauseAlternate;
  assert.equal(resolveKeyboardBindings(slots).pauseAlternate, null);
  slots[10]!.quickPlay!.hotkey = key('j');
  assert.equal(resolveKeyboardBindings(slots).playbackMappings['jump-cue'], undefined);
  assert.equal(resolveKeyboardBindings(slots, { 'select-up': key('c') }).playbackMappings['cue-to-continue'], undefined);

  const shiftS = { ...key('S'), shiftKey: true };
  slots[10]!.quickPlay!.hotkey = key('s');
  const panelKeys = resolveKeyboardBindings(slots, { 'stop-all': shiftS });
  assert.deepEqual(panelKeys.keyMappings[10], key('s'));
  assert.deepEqual(panelKeys.playbackMappings['stop-all'], shiftS);
  assert.equal(panelKeys.playbackMappings['toggle-settings'], undefined);
  assert.equal(panelKeys.playbackMappings['toggle-properties'], undefined);
  const customized = resolveKeyboardBindings(slots, { 'toggle-settings': key('k'), 'toggle-properties': null });
  assert.deepEqual(customized.playbackMappings['toggle-settings'], key('k'));
  assert.equal(customized.playbackMappings['toggle-properties'], null);

  slots[10]!.quickPlay!.hotkey = key('q');
  const shiftQ = { ...key('Q'), shiftKey: true };
  const quickPlayKeys = resolveKeyboardBindings(slots, { 'stop-all': shiftQ });
  assert.deepEqual(quickPlayKeys.keyMappings[10], key('q'));
  assert.deepEqual(quickPlayKeys.playbackMappings['stop-all'], shiftQ);
  assert.equal(quickPlayKeys.playbackMappings['toggle-quickplays'], undefined);
  assert.equal(quickPlayKeys.playbackMappings['toggle-detached-quickplays'], undefined);
});

test('QuickPlay copies into the playlist without consuming the source cell', () => {
  const source = audio('quickplay-source', 4);
  (source as any).quickPlay.sourceUuid = 'original-playlist-cue';
  source.displayName = 'Announcement';

  const clone = cloneAsPlaylistItem(source as any, 'playlist-copy');

  assert.equal(clone.uuid, 'playlist-copy');
  assert.deepEqual(clone.index, [0]);
  assert.equal(clone.quickPlay, undefined);
  assert.equal(clone.displayName, 'Announcement');
  assert.equal(source.quickPlay?.order, 4);
});

test('builds permanent addressable cells across playlist and standalone QuickPlays', () => {
  const playlistItems = [audio('playlist', 2)];
  const standaloneItems = [audio('standalone', 0), audio('later', 5)];
  const slots = buildQuickPlayCells(playlistItems as any, standaloneItems as any, 4);

  assert.equal(slots.length, 6);
  assert.equal(slots[0]?.uuid, 'standalone');
  assert.equal(slots[1], null);
  assert.equal(slots[2]?.uuid, 'playlist');
  assert.equal(slots[5]?.uuid, 'later');
  assert.deepEqual(
    flattenQuickPlays(playlistItems as any, standaloneItems as any).map(item => item.uuid),
    ['standalone', 'playlist', 'later'],
  );
  assert.equal(nextAvailableQuickPlayOrder(playlistItems as any, standaloneItems as any), 1);
});

test('repairs duplicate and invalid saved cell orders without creating an unbounded grid', () => {
  const duplicate = audio('duplicate', 1);
  const first = audio('first', 1);
  const corrupt = audio('corrupt', 999_999);
  const slots = buildQuickPlayCells([first, duplicate, corrupt] as any, [], 2);

  assert.equal(slots.length, 3);
  assert.equal(slots[1]?.uuid, 'first');
  assert.deepEqual(slots.filter(Boolean).map(item => item!.uuid).sort(), [
    'corrupt', 'duplicate', 'first',
  ]);
});

test('removing QuickPlay designation never deletes or rewrites the cue', () => {
  const item = audio('sting', 3);
  const expected = structuredClone(item) as any;
  delete expected.quickPlay;

  removeQuickPlayDesignation(item as any);

  assert.deepEqual(item, expected);
});

test('QuickPlays use primary or detached show readiness, with no arm requirement', async () => {
  const hydration = ref('loading');
  const identity = ref<object | null>(null);
  const activeCues = ref(new Map());
  const item = audio('sting', 0) as AudioItem;
  let detached = false;
  const starts: string[] = [];
  Object.assign(globalThis, {
    computed,
    useProject: () => ({ projectHydrationStatus: hydration }),
    useDetachedQuickPlayMutation: () => ({ isDetached: detached, identity }),
    useAudioEngine: () => ({ activeCues, playCue: async (cue: AudioItem) => {
      starts.push(cue.uuid);
      return true;
    } }),
  });
  const primary = useQuickPlayPlayback();
  assert.equal(await primary.playQuickPlay(item), false);
  hydration.value = 'ready';
  assert.equal(await primary.playQuickPlay(item), true, 'an unarmed cue fires directly');
  item.quickPlay!.armed = true;
  item.quickPlay!.autoDisarm = true;
  assert.equal(await primary.playQuickPlay(item), true);
  assert.equal(item.quickPlay!.armed, true, 'legacy metadata is untouched');

  detached = true;
  hydration.value = 'failed';
  const bank = useQuickPlayPlayback();
  assert.equal(await bank.playQuickPlay(item), false, 'the detached bank needs a current owner');
  identity.value = {};
  assert.equal(await bank.playQuickPlay(item), true);
  item.quickPlay!.retrigger = 'ignore';
  activeCues.value.set(item.uuid, {});
  assert.equal(await bank.playQuickPlay(item), false);
  identity.value = null;
  activeCues.value.clear();
  assert.equal(await bank.playQuickPlay(item), false);
  assert.deepEqual(starts, ['sting', 'sting', 'sting']);
});

test('a QuickPlay ending reports and sets Stop, Loop and Play Next without losing a Go to target', () => {
  const item = audio('sting', 0) as AudioItem;
  item.endBehavior = { action: 'nothing' };
  assert.equal(getQuickPlayEndMode(item), 'stop');
  setQuickPlayEndMode(item, 'next');
  assert.deepEqual(item.endBehavior, { action: 'next' });
  assert.equal(getQuickPlayEndMode(item), 'next', 'Play Next is never misreported as Stop');
  setQuickPlayEndMode(item, 'loop');
  assert.equal(getQuickPlayEndMode(item), 'loop');
  setQuickPlayEndMode(item, 'stop');
  assert.deepEqual(item.endBehavior, { action: 'nothing' });

  item.endBehavior = { action: 'goto-item', targetUuid: 'finale' };
  assert.equal(getQuickPlayEndMode(item), 'goto');
  setQuickPlayEndMode(item, 'goto');
  assert.deepEqual(item.endBehavior, { action: 'goto-item', targetUuid: 'finale' },
    're-selecting the reported Go to ending keeps its target');
  item.endBehavior = { action: 'goto-index', targetIndex: [2] };
  assert.equal(getQuickPlayEndMode(item), 'goto');
});

test('the Cue to Continue toggle shows the playing pass first and the saved ending otherwise', () => {
  const item = audio('sting', 0) as AudioItem;
  item.endBehavior = { action: 'nothing' };
  assert.equal(quickPlayFollowsUpNext(item), false);
  assert.equal(quickPlayFollowsUpNext(item, 'armed'), true, 'armed for this pass');
  item.endBehavior = { action: 'next' };
  assert.equal(quickPlayFollowsUpNext(item), true, 'a saved Play Next follows without arming');
  assert.equal(quickPlayFollowsUpNext(item, null), true);
  assert.equal(quickPlayFollowsUpNext(item, 'suppressed'), false, 'cancelled for this pass');
  item.endBehavior = { action: 'loop' };
  assert.equal(quickPlayFollowsUpNext(item), false);
  assert.equal(quickPlayFollowsUpNext(item, 'armed'), true, 'an armed loop finishes into Up Next');
  item.endBehavior = { action: 'goto-item', targetUuid: 'finale' };
  assert.equal(quickPlayFollowsUpNext(item), false, 'Go to Item is not Up Next');
});
