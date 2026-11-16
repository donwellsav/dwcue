'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  TOO_NEW_MS, collectReferences, findUnusedMedia, isPlainFileName, isReferenced, isShowDocument,
  mediaFilePath, mediaFolderFor,
} = require('../electron/unused-media');

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const OLD = NOW - 24 * 60 * 60 * 1000;
const file = (name, extra = {}) => ({ name, size: 1000, modifiedAt: OLD, changedAt: OLD, isFile: true, ...extra });
const cue = (fileName, extra = {}) => ({
  uuid: `uuid-${fileName}`, type: 'audio', displayName: fileName.replace(/\.[^.]+$/, ''),
  mediaFileName: fileName, mediaPath: `media/${fileName}`, mediaServerPath: '', ...extra,
});
const unusedNames = (files, documents, now = NOW) =>
  findUnusedMedia({ files: files.map(entry => typeof entry === 'string' ? file(entry) : entry), documents, now })
    .map(entry => entry.name);

test('a file a cue points at is in use, however the path is written', () => {
  const show = {
    items: [
      // Copied into the show: relative to the show folder.
      { type: 'audio', mediaPath: 'media/Walk-in.wav' },
      // Linked by an absolute path, here and as another computer wrote it.
      { type: 'audio', mediaPath: '', mediaServerPath: '/Users/op/Shows/Gala/media/Sting.wav' },
      { type: 'audio', mediaPath: 'media\\Opening film.mov' },
      { type: 'audio', mediaPath: '', mediaServerPath: 'C:\\Shows\\Gala\\media\\Closing film.mp4' },
      { type: 'audio', mediaPath: './media/../media/Bumper.mp3' },
      { type: 'audio', mediaPath: 'file:///Users/op/Shows/Gala/media/Play%20on%20%C3%A9t%C3%A9.wav' },
    ],
  };
  assert.deepEqual(unusedNames([
    'Walk-in.wav', 'Sting.wav', 'Opening film.mov', 'Closing film.mp4', 'Bumper.mp3', 'Play on été.wav', 'Left over.wav',
  ], [show]), ['Left over.wav']);
});

test('a converted video leaves its original unused, and old captures with it', () => {
  const show = {
    items: [cue('Opening film (converted).mp4', { displayName: 'Opening film', hasVideo: true, imagePath: 'media/Capture - Opening film - 2026-11-16 10.42.07.png' })],
    settings: { videoStandbyImage: 'media/Capture - Standby - 2026-11-16 10.40.00.png' },
  };
  assert.deepEqual(unusedNames([
    'Opening film.mov',
    'Opening film (converted).mp4',
    'Capture - Opening film - 2026-11-16 10.42.07.png',
    'Capture - Opening film - 2026-11-16 10.41.55.png',
    'Capture - Standby - 2026-11-16 10.40.00.png',
    'Capture - Standby - 2026-11-16 10.39.12.png',
  ], [show]), [
    'Opening film.mov',
    'Capture - Opening film - 2026-11-16 10.41.55.png',
    'Capture - Standby - 2026-11-16 10.39.12.png',
  ]);
});

test('QuickPlay-only cues and cues inside groups keep their files', () => {
  const show = {
    items: [{ type: 'group', children: [{ type: 'group', children: [cue('Deep.wav')] }, cue('Child.wav')] }],
    cartItems: [{ slot: 0, itemUuid: 'uuid-Airhorn.wav' }],
    cartOnlyItems: [cue('Airhorn.wav', { imagePath: 'media/Airhorn tile.png' })],
  };
  assert.deepEqual(unusedNames(['Deep.wav', 'Child.wav', 'Airhorn.wav', 'Airhorn tile.png', 'Stray.wav'], [show]), ['Stray.wav']);
});

test('a file only a backup, the saved show or another show uses is still in use', () => {
  const open = { items: [cue('Now.wav')] };
  const saved = { items: [cue('Now.wav'), cue('Saved only.wav')] };
  const backup = { items: [cue('Backup only.wav')] };
  const otherShow = { items: [cue('Other show.wav')] };
  const files = ['Now.wav', 'Saved only.wav', 'Backup only.wav', 'Other show.wav', 'Nobody.wav'];
  assert.deepEqual(unusedNames(files, [open, saved, backup, otherShow]), ['Nobody.wav']);
  assert.deepEqual(unusedNames(files, [open]), ['Saved only.wav', 'Backup only.wav', 'Other show.wav', 'Nobody.wav']);
  // Collected a document at a time, as the main process does, the answer is the same.
  const references = collectReferences([open]);
  assert.equal(isReferenced(references, 'Backup only.wav'), false);
  collectReferences([saved], references);
  collectReferences([backup, otherShow], references);
  assert.equal(isReferenced(references, 'Backup only.wav'), true);
  assert.deepEqual(findUnusedMedia({ files: files.map(name => file(name)), references, now: NOW }).map(entry => entry.name), ['Nobody.wav']);
});

test('a backup that is not valid JSON still counts, as plain text', () => {
  const torn = '{"items":[{"mediaPath":"media/Torn backup.wav","mediaServerPath":"C:\\\\Shows\\\\Gala\\\\media\\\\Torn too.wav"';
  assert.deepEqual(unusedNames(['Torn backup.wav', 'Torn too.wav', 'Nobody.wav'], [{ items: [] }, torn]), ['Nobody.wav']);
});

test('the file name alone, anywhere in any string, keeps the file', () => {
  const show = {
    items: [
      { type: 'audio', mediaFileName: 'Name only.wav', mediaPath: '', mediaServerPath: '' },
      // Linked to a file somewhere else that has the same name as one in media/.
      { type: 'audio', mediaPath: '', mediaServerPath: '/Volumes/Stick/Same name.mov' },
      { type: 'audio', notes: 'Fade under "Mentioned in a note.mp3" then go' },
    ],
    'Used as a key.wav': { gainDb: -3 },
    recent: ['https://example.com/get?file=In a query.flac&v=2'],
  };
  assert.deepEqual(unusedNames([
    'Name only.wav', 'Same name.mov', 'Mentioned in a note.mp3', 'Used as a key.wav', 'In a query.flac', 'Nobody.wav',
  ], [show]), ['Nobody.wav']);
  // A name that is the tail of a longer name in use is kept too: in doubt, the
  // file stays. The longer name is not kept by the shorter one.
  assert.deepEqual(unusedNames(['film.mov', 'Opening film.mov'], [{ items: [cue('Opening film.mov')] }]), []);
  assert.deepEqual(unusedNames(['film.mov', 'Opening film.mov'], [{ items: [cue('film.mov')] }]), ['Opening film.mov']);
});

test('names match whatever their letter case or accent encoding', () => {
  const show = { items: [cue('WALK-IN.WAV'), cue('Caf\u00e9 intro.mp3'), { mediaPath: 'MEDIA/Mixed Case.Mov' }] };
  // "é" as one character in the show, as "e" + combining accent on disk (macOS).
  assert.deepEqual(unusedNames(['walk-in.wav', 'Cafe\u0301 intro.mp3', 'mixed case.MOV', 'Nobody.WAV'], [show]), ['Nobody.WAV']);
});

test('a file being written, or changed in the last two minutes, is never listed', () => {
  const justNow = NOW - TOO_NEW_MS + 1;
  const longEnough = NOW - TOO_NEW_MS;
  assert.deepEqual(unusedNames([
    file('Film (converted).mp4.part'),
    file('Upload.WAV.PART'),
    file('Modified just now.wav', { modifiedAt: justNow, changedAt: justNow }),
    // Copied in a moment ago: the copy kept the original's old date.
    file('Copied just now.wav', { modifiedAt: OLD, changedAt: justNow }),
    file('Dated in the future.wav', { modifiedAt: NOW + 60_000, changedAt: OLD }),
    file('No date.wav', { modifiedAt: NaN, changedAt: NaN }),
    file('No size.wav', { size: undefined }),
    file('Old enough.wav', { modifiedAt: longEnough, changedAt: longEnough }),
    file('No change time.wav', { changedAt: undefined }),
  ], [{ items: [] }]), ['Old enough.wav', 'No change time.wav']);
  assert.throws(() => findUnusedMedia({ files: [file('a.wav')], documents: [] }), /now must be a time/);
});

test('only plain files directly inside media/ are ever listed', () => {
  assert.deepEqual(unusedNames([
    file('Unused.wav'),
    file('Stems', { isFile: false }),
    file('Linked elsewhere.wav', { isFile: false }),
    file('Not said.wav', { isFile: undefined }),
    file('../Outside.wav'),
    file('Stems/Inside a folder.wav'),
    file('Stems\\Inside a folder.wav'),
    file('/etc/hosts'),
    file('C:\\Windows\\win.ini'),
    file('..'),
    file('.'),
    file(''),
    file('nul\0.wav'),
    file(42),
    file('x'.repeat(256)),
    // Not media: the operating system's own files, and shows that ended up here.
    file('.DS_Store'),
    file('._Unused.wav'),
    file('Gala.dwcue'),
    file('Gala.DWCUEPACK'),
    file('Gala_backup_2026-07-29_20-03.liveplay'),
    file('Unused.wav'),
    null,
  ], []), ['Unused.wav']);

  const show = path.resolve('shows', 'Gala');
  assert.equal(mediaFolderFor(show), path.join(show, 'media'));
  assert.equal(mediaFolderFor(path.join(show, 'media', '..')), path.join(show, 'media'));
  assert.equal(mediaFolderFor('relative/show'), null);
  assert.equal(mediaFolderFor(undefined), null);
  assert.equal(mediaFilePath(show, 'Unused.wav'), path.join(show, 'media', 'Unused.wav'));
  for (const name of ['../Gala.dwcue', '..', '.', '', 'Stems/a.wav', 'Stems\\a.wav', path.join(show, 'media', 'a.wav'), 'a\0.wav', null, 7]) {
    assert.equal(mediaFilePath(show, name), null, `${String(name)} must not be addressable`);
  }
  assert.equal(mediaFilePath('relative/show', 'a.wav'), null);
  assert.equal(mediaFilePath('', 'a.wav'), null);
  assert.equal(mediaFilePath(null, 'a.wav'), null);
});

test('what the window may name is a bare file name', () => {
  for (const name of ['a.wav', 'Capture - Standby - 2026-11-16 10.39.12.png', '.hidden', 'x'.repeat(255)]) {
    assert.equal(isPlainFileName(name), true, name);
  }
  for (const name of ['', '.', '..', 'a/b', 'a\\b', '/a', 'a\0', 'x'.repeat(256), null, undefined, 5, ['a.wav'], { name: 'a.wav' }]) {
    assert.equal(isPlainFileName(name), false, String(name));
  }
  assert.equal(isShowDocument('Gala 2026-11-16 10.00.00.dwcue'), true);
  assert.equal(isShowDocument('Gala_backup_2026-07-29_20-03.LIVEPLAY'), true);
  assert.equal(isShowDocument('Gala.dwcuepack'), false);
  assert.equal(isShowDocument('Gala.dwcue.txt'), false);
  assert.equal(isShowDocument(undefined), false);
});

test('a deep or awkward document is read without trouble', () => {
  let deep = { mediaPath: 'media/At the bottom.wav' };
  for (let level = 0; level < 20_000; level += 1) deep = { children: [deep] };
  const awkward = { a: null, b: 3, c: true, d: [null, 4, ['media/In an array.wav']], waveform: new Array(5000).fill(0.5), e: '100% wet %ZZ media/Percent.wav' };
  assert.deepEqual(unusedNames(['At the bottom.wav', 'In an array.wav', 'Percent.wav', 'Nobody.wav'], [deep, awkward, null, 12]), ['Nobody.wav']);
});
