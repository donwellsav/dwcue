import assert from 'node:assert/strict';
import test from 'node:test';
import { nextVideoWork, type VideoWorkCue } from '../app/utils/videoPreflightPlan.ts';

const cue = (uuid: string, issue: string | null = null, source = `file-${uuid}`): VideoWorkCue => ({ uuid, source, issue });
const map = (entries: Record<string, string>) => new Map(Object.entries(entries));

test('a cue is checked once, and again when its file or trim changes', () => {
  const cues = [cue('a'), cue('b'), cue('c', null, 'file-c-trimmed')];
  assert.deepEqual(nextVideoWork(cues, new Map(), new Map(), true), { check: ['a', 'b', 'c'], convert: [], stillFailing: [] });
  assert.deepEqual(
    nextVideoWork(cues, map({ a: 'file-a', b: 'file-b', c: 'file-c' }), new Map(), true),
    { check: ['c'], convert: [], stillFailing: [] },
  );
});

test('only a picture that cannot be decoded is converted', () => {
  const cues = [cue('ok'), cue('prores', 'no-frame'), cue('mpeg2', 'decode'),
    cue('gone', 'unreadable'), cue('slow', 'timeout'), cue('trim', 'in-point'), cue('end', 'duration'), cue('probe', 'probe-error')];
  const checked = new Map(cues.map(entry => [entry.uuid, entry.source]));
  assert.deepEqual(nextVideoWork(cues, checked, new Map(), true), { check: [], convert: ['prores', 'mpeg2'], stillFailing: [] });
});

test('nothing is converted where the app cannot convert', () => {
  const cues = [cue('prores', 'no-frame')];
  assert.deepEqual(nextVideoWork(cues, map({ prores: 'file-prores' }), new Map(), false), { check: [], convert: [], stillFailing: [] });
});

test('checking comes before converting, cue by cue', () => {
  const cues = [cue('new'), cue('prores', 'no-frame')];
  assert.deepEqual(nextVideoWork(cues, map({ prores: 'file-prores' }), new Map(), true),
    { check: ['new'], convert: ['prores'], stillFailing: [] });
});

test('a conversion is tried once per file, and a copy is never converted again', () => {
  const failed = [cue('prores', 'no-frame')];
  assert.deepEqual(nextVideoWork(failed, map({ prores: 'file-prores' }), map({ prores: 'file-prores' }), true),
    { check: [], convert: [], stillFailing: ['prores'] });
  // Pointed at its copy: checked next, and passing clears it.
  const copy = [cue('prores', null, 'copy-prores')];
  assert.deepEqual(nextVideoWork(copy, map({ prores: 'file-prores' }), map({ prores: 'copy-prores' }), true),
    { check: ['prores'], convert: [], stillFailing: [] });
  assert.deepEqual(nextVideoWork(copy, map({ prores: 'copy-prores' }), map({ prores: 'copy-prores' }), true),
    { check: [], convert: [], stillFailing: [] });
  // A copy that still has no picture is reported, not converted again.
  assert.deepEqual(
    nextVideoWork([cue('prores', 'decode', 'copy-prores')], map({ prores: 'copy-prores' }), map({ prores: 'copy-prores' }), true),
    { check: [], convert: [], stillFailing: ['prores'] },
  );
  // Replaced by hand with another unplayable file: that one gets its own try.
  assert.deepEqual(
    nextVideoWork([cue('prores', 'decode', 'other-file')], map({ prores: 'other-file' }), map({ prores: 'copy-prores' }), true),
    { check: [], convert: ['prores'], stillFailing: [] },
  );
});
