import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatClockSeconds, playedSeconds, playlistRemainingSeconds, type RemainingListItem,
} from '../app/utils/playlistRemaining.ts';

const cue = (uuid: string, duration: number, extra: Partial<RemainingListItem> = {}): RemainingListItem =>
  ({ uuid, type: 'audio', duration, ...extra });
const group = (uuid: string): RemainingListItem => ({ uuid, type: 'group' });

// 1 (60 s), a group holding 2 (30 s) and 3 (120 s trimmed to 90 s), then 4 (45 s).
const list = [cue('1', 60), group('g'), cue('2', 30), cue('3', 120, { inPoint: 10, outPoint: 100 }), cue('4', 45)];

test('a trimmed cue counts its played length, and bad lengths count nothing', () => {
  assert.equal(playedSeconds(cue('a', 120, { inPoint: 10, outPoint: 100 })), 90);
  assert.equal(playedSeconds(cue('a', 120, { inPoint: 20 })), 100);
  assert.equal(playedSeconds(cue('a', 0)), 0);
  assert.equal(playedSeconds({ uuid: 'a', type: 'audio' }), 0);
  assert.equal(playedSeconds(cue('a', 10, { inPoint: 30 })), 0);
});

test('nothing playing and nothing next has nowhere to count from', () => {
  assert.equal(playlistRemainingSeconds(list, [], null), null);
  assert.equal(playlistRemainingSeconds(list, [], 'not-in-the-list'), null);
  assert.equal(playlistRemainingSeconds([], [], null), null);
});

test('before the show it counts from Up Next to the end', () => {
  assert.equal(playlistRemainingSeconds(list, [], '1'), 60 + 30 + 90 + 45);
  assert.equal(playlistRemainingSeconds(list, [], '3'), 90 + 45);
});

test('a group that is Up Next counts its children and what follows', () => {
  assert.equal(playlistRemainingSeconds(list, [], 'g'), 30 + 90 + 45);
});

test('while a cue plays it is the rest of that cue, then Up Next onward', () => {
  const live = [{ uuid: '1', duration: 60, currentTime: 20 }];
  assert.equal(playlistRemainingSeconds(list, live, '2'), 40 + 30 + 90 + 45);
  // No Up Next: everything after the live cue.
  assert.equal(playlistRemainingSeconds(list, live, null), 40 + 30 + 90 + 45);
});

test('cues the operator skipped are left out, and a jump back is counted again', () => {
  const liveFirst = [{ uuid: '1', duration: 60, currentTime: 0 }];
  assert.equal(playlistRemainingSeconds(list, liveFirst, '4'), 60 + 45);
  const liveLast = [{ uuid: '4', duration: 45, currentTime: 5 }];
  assert.equal(playlistRemainingSeconds(list, liveLast, '2'), 40 + 30 + 90 + 45);
});

test('the last cue alone leaves only its own remainder', () => {
  assert.equal(playlistRemainingSeconds(list, [{ uuid: '4', duration: 45, currentTime: 44.2 }], null), 45 - 44.2);
});

test('QuickPlays are not in the list and do not move the count', () => {
  const quickPlay = [{ uuid: 'quickplay-1', duration: 5, currentTime: 1 }];
  assert.equal(playlistRemainingSeconds(list, quickPlay, null), null);
  assert.equal(playlistRemainingSeconds(list, quickPlay, '3'), 90 + 45);
});

test('during a crossfade it follows the cue further down the list', () => {
  const both = [{ uuid: '2', duration: 30, currentTime: 10 }, { uuid: '1', duration: 60, currentTime: 58 }];
  assert.equal(playlistRemainingSeconds(list, both, '3'), 20 + 90 + 45);
});

test('a playhead past the end or a missing length never goes negative', () => {
  assert.equal(playlistRemainingSeconds(list, [{ uuid: '4', duration: 45, currentTime: 50 }], null), 0);
  assert.equal(playlistRemainingSeconds(list, [{ uuid: '4', duration: Number.NaN, currentTime: 1 }], null), 0);
});

test('the clock reads mm:ss, then h:mm:ss, and rounds up like Time Left', () => {
  assert.equal(formatClockSeconds(null), '--:--');
  assert.equal(formatClockSeconds(0), '00:00');
  assert.equal(formatClockSeconds(0.2), '00:01');
  assert.equal(formatClockSeconds(225), '03:45');
  assert.equal(formatClockSeconds(3600), '1:00:00');
  assert.equal(formatClockSeconds(5025.4), '1:23:46');
});
