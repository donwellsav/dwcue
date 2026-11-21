import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { secondsLeft } from '../app/utils/countdown.ts';
import { computeActiveGroups } from '../app/utils/groupProgress.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const audio = (uuid: string, length: number) => ({ uuid, type: 'audio', displayName: uuid, length }) as any;
const group = (uuid: string, action: 'play-first' | 'play-all', children: any[]) =>
  ({ uuid, type: 'group', displayName: uuid, startBehavior: { action }, children }) as any;
const lengthOf = (item: any) => item.length;

test('every countdown rounds the same way: up, reaching 0:00 only at the end', () => {
  assert.equal(secondsLeft(4.5), 5);
  assert.equal(secondsLeft(4.0000001), 4, 'float noise does not add a second');
  assert.equal(secondsLeft(0.4), 1);
  assert.equal(secondsLeft(0), 0);
  assert.equal(secondsLeft(-2), 0);
  for (const file of ['../app/components/PlaylistItem.vue', '../app/components/ActiveCueItem.vue',
    '../app/components/QuickPlayTile.vue', '../app/components/ProjectHeader.vue']) {
    assert.match(source(file), /secondsLeft\(/, `${file} uses the shared countdown`);
  }
});

test('a Play All group lasts as long as its longest child and never runs backwards', () => {
  const show = [group('all', 'play-all', [audio('a', 60), audio('b', 30), audio('c', 45)])];
  const at = (seconds: number, playing: string[]) =>
    computeActiveGroups(show, new Map(playing.map(uuid => [uuid, seconds])), lengthOf).get('all')!;
  assert.equal(at(10, ['a', 'b', 'c']).totalDuration, 60);
  assert.equal(at(10, ['a', 'b', 'c']).currentTime, 10);
  assert.equal(at(45, ['a']).currentTime, 45, 'the shorter children ending does not pull it back');
});

test('a group playing in turn counts what has played, and a playing sub-group counts toward its parent', () => {
  const inner = group('inner', 'play-first', [audio('x', 20), audio('y', 10)]);
  const show = [group('outer', 'play-first', [audio('intro', 30), inner, audio('outro', 40)])];
  const groups = computeActiveGroups(show, new Map([['y', 4]]), lengthOf);
  assert.deepEqual([groups.get('inner')!.totalDuration, groups.get('inner')!.currentTime], [30, 24]);
  assert.deepEqual([groups.get('outer')!.totalDuration, groups.get('outer')!.currentTime], [100, 54],
    'the parent shows progress while its sub-group plays');
});

test('state on screen follows the engine: retired cues, trims, loops, QuickPlays, meters', () => {
  const engine = source('../app/composables/useAudioEngine.ts');
  assert.match(engine, /A cue it leaves out[\s\S]{0,900}removeActiveCue\(uuid\)/, 'a reconnect snapshot drops cues it does not list');
  assert.match(engine, /keep its length, In and Out points with the item/, 'a trim edited while a cue plays reaches its countdown');
  assert.match(engine, /if \(restarted\) activeCues\.value\.delete\(item\.uuid\);/, 'a restart is the newest start');
  assert.match(source('../app/components/ActiveCueItem.vue'), /if \(item\.endBehavior\?\.action === 'loop'\) return null;/,
    'a looping cue shows no Start Next countdown');
  const header = source('../app/components/ProjectHeader.vue');
  assert.match(header, /return !!item && !item\.quickPlay;/, 'Time Left follows the show cue, not a stinger over it');
  assert.match(header, /quickPlayFollowsUpNext\(audioItem, cueFollowOverrides\.value\.get\(audioItem\.uuid\)\)/,
    'a QuickPlay that follows Up Next does not warn of silence');
  const meters = source('../app/composables/useLiveMeters.ts');
  assert.equal((meters.match(/watch\(\(\) => server\.connected && !server\.connectionLost/g) ?? []).length, 2,
    'cue and master meters fall to silence when the connection is not live');
});
