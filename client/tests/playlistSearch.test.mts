import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDisplayIndexPath } from '../app/utils/indexDisplay.ts';
import {
  findPlaylistMatches, normalizeSearchText, stepPlaylistMatch, type SearchablePlaylistItem,
} from '../app/utils/playlistSearch.ts';

// The number a playlist row shows, with cue numbers starting at 1.
const shownNumber = (index?: number[] | null) => formatDisplayIndexPath(index, 1);
const cue = (uuid: string, displayName: string, index: number[], extra: Partial<SearchablePlaylistItem> = {}) =>
  ({ uuid, displayName, index, ...extra });

// 1 Preshow (group)
//   1,1 Walk-in Music        note: house open
//   1,2 Café Sting
//   1,3 Inner (group)
//     1,3,1 Hidden Fanfare
// 2 Act 2 Opener
// 3 Straße
// 4 Bows                     note: WALK ON
const show = (): SearchablePlaylistItem[] => [
  cue('preshow', 'Preshow', [0], {
    children: [
      cue('walk-in', 'Walk-in Music', [0, 0], { note: 'house open' }),
      cue('cafe', 'Café Sting', [0, 1]),
      cue('inner', 'Inner', [0, 2], { children: [cue('fanfare', 'Hidden Fanfare', [0, 2, 0])] }),
    ],
  }),
  cue('opener', 'Act 2 Opener', [1]),
  cue('strasse', 'Straße', [2]),
  cue('bows', 'Bows', [3], { note: 'WALK ON' }),
];
const search = (query: string) => findPlaylistMatches(show(), query, shownNumber);

test('text is compared without case, accents or stray spaces', () => {
  assert.equal(normalizeSearchText('  Café   ÉTÉ '), 'cafe ete');
  assert.equal(normalizeSearchText('STRASSE'), normalizeSearchText('Straße'));
  assert.equal(normalizeSearchText('IŞIK'), normalizeSearchText('ışık'));
  assert.equal(normalizeSearchText('ΟΔΟΣ'), normalizeSearchText('οδοσ'));
  assert.equal(normalizeSearchText('Ёлка'), 'елка');
  // Full-width digits typed through an input method are still digits.
  assert.equal(normalizeSearchText('１２'), '12');
  // Marks that are a script's vowels are letters, not accents.
  assert.notEqual(normalizeSearchText('की'), normalizeSearchText('क'));
  assert.equal(normalizeSearchText(undefined), '');
});

test('a search reads titles, notes and cue numbers through every nested group, in playlist order', () => {
  assert.deepEqual(search('walk').uuids, ['walk-in', 'bows']);
  assert.deepEqual(search('FANFARE').uuids, ['fanfare']);
  assert.deepEqual(search('house').uuids, ['walk-in']);
  assert.deepEqual(search('1,3').uuids, ['inner', 'fanfare']);
  assert.deepEqual(search('pre').uuids, ['preshow']);
  // Part of a word is enough, and so is the unaccented spelling.
  assert.deepEqual(search('cafe st').uuids, ['cafe']);
  assert.deepEqual(search('CAFÉ').uuids, ['cafe']);
  assert.deepEqual(search('strasse').uuids, ['strasse']);
});

test('an empty search matches nothing, so nothing is outlined', () => {
  for (const query of ['', '   ', '\t']) assert.deepEqual(search(query), { uuids: [], start: -1 });
  assert.deepEqual(search('no such cue'), { uuids: [], start: -1 });
});

test('a new search lands on the first match, or on the cue whose number was typed', () => {
  assert.equal(search('walk').start, 0);
  // "2" is in "1,2", in "Act 2 Opener" and is cue 2: the list keeps playlist
  // order, and the search starts on cue 2.
  const two = search('2');
  assert.deepEqual(two.uuids, ['cafe', 'opener']);
  assert.equal(two.uuids[two.start], 'opener');
  const nested = search('1,2');
  assert.equal(nested.uuids[nested.start], 'cafe');
});

test('cue numbers are matched as the playlist shows them', () => {
  // A show set to number its cues from 10: the fourth row is cue 13.
  const fromTen = (index?: number[] | null) => formatDisplayIndexPath(index, 10);
  assert.deepEqual(findPlaylistMatches(show(), '13', fromTen), { uuids: ['bows'], start: 0 });
  assert.deepEqual(findPlaylistMatches(show(), '4', fromTen), { uuids: [], start: -1 });
});

test('searching never changes the playlist', () => {
  const items = show();
  const before = structuredClone(items);
  findPlaylistMatches(items, 'walk', shownNumber);
  assert.deepEqual(items, before);
});

test('a row with missing text is skipped, not a crash', () => {
  const broken = [{ uuid: 'broken' }, cue('ok', 'Walk', [1])] as unknown as SearchablePlaylistItem[];
  assert.deepEqual(findPlaylistMatches(broken, 'walk', shownNumber).uuids, ['ok']);
});

test('Enter and Shift+Enter step through the matches and wrap round', () => {
  const uuids = ['a', 'b', 'c'];
  assert.equal(stepPlaylistMatch(uuids, 'a', 1), 'b');
  assert.equal(stepPlaylistMatch(uuids, 'c', 1), 'a');
  assert.equal(stepPlaylistMatch(uuids, 'a', -1), 'c');
  assert.equal(stepPlaylistMatch(uuids, 'b', -1), 'a');
  // No current match, or one that no longer matches: start from the near end.
  assert.equal(stepPlaylistMatch(uuids, null, 1), 'a');
  assert.equal(stepPlaylistMatch(uuids, null, -1), 'c');
  assert.equal(stepPlaylistMatch(uuids, 'gone', 1), 'a');
  assert.equal(stepPlaylistMatch(uuids, 'gone', -1), 'c');
  // A single match is found again; no match is nothing.
  assert.equal(stepPlaylistMatch(['only'], 'only', 1), 'only');
  assert.equal(stepPlaylistMatch([], 'a', 1), null);
});
