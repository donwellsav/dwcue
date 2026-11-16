import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkEngine, checkFile, checkMedia, checkOutput, checkVideo, resolveOutput, runPreShowCheck, summarize,
  type CueFact, type EngineFacts, type FileFacts, type MediaFacts, type OutputDeviceFact, type PreShowCheckInput,
  type VideoFacts,
} from '../app/utils/preShowCheck.ts';

const device = (name: string, extra: Partial<OutputDeviceFact> = {}): OutputDeviceFact => ({
  id: `hw:${name}`, name, isDefault: false, isOpen: false, isAvailable: true, state: 'available', ...extra,
});
const cue = (uuid: string, extra: Partial<CueFact> = {}): CueFact => ({
  uuid, name: `Name ${uuid}`, inPlaylist: true, cueNumber: uuid, quickPlayNumber: null, output: null, hasVideo: false, ...extra,
});
const noVideo: VideoFacts = { available: true, phase: null, checked: 0, total: 0, issueUuids: [] };
const savedFile: FileFacts = { hasFile: true, unsaved: false, saveFailed: false, autoSave: true, repairPending: false };
const engineOk: EngineFacts = {
  connected: true, answered: true, startsHeld: false, engineVersion: '2.6.24', appVersion: '2.6.24',
};

const readyShow = (): PreShowCheckInput => ({
  engine: engineOk,
  output: { devices: [device('Built-in', { isDefault: true }), device('Scarlett')], main: 'Scarlett', preview: null, ltc: null },
  cues: [cue('1'), cue('2')],
  media: { listReady: true, report: { loading: false, failures: [], loaded: ['1', '2'] } },
  file: savedFile,
  video: noVideo,
});

test('a show the app verified end to end is Ready, and says what it verified', () => {
  const result = runPreShowCheck(readyShow());
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.verdict, { key: 'showCheck.verdict.ready' });
  assert.deepEqual(result.lines.map(entry => [entry.id, entry.status]),
    [['engine', 'pass'], ['output', 'pass'], ['media', 'pass'], ['file', 'pass']]);
  assert.deepEqual(result.lines.map(entry => entry.detail), [
    { key: 'showCheck.engine.ok', params: { version: '2.6.24' } },
    { key: 'showCheck.output.mainOk', params: { name: 'Scarlett' } },
    { key: 'showCheck.media.ready', params: { ready: 2, total: 2 } },
    { key: 'showCheck.file.saved' },
  ]);
  assert.deepEqual([result.attention, result.unchecked], [0, 0]);
});

test('the engine line passes only for an answering engine whose version equals the app', () => {
  const status = (facts: Partial<EngineFacts>) => {
    const entry = checkEngine({ ...engineOk, ...facts });
    return [entry.status, entry.detail.key];
  };
  assert.deepEqual(status({}), ['pass', 'showCheck.engine.ok']);
  assert.deepEqual(status({ engineVersion: 'v2.6.24 ' }), ['pass', 'showCheck.engine.ok']);
  assert.deepEqual(status({ connected: false }), ['attention', 'showCheck.engine.disconnected']);
  assert.deepEqual(status({ answered: false }), ['attention', 'showCheck.engine.noAnswer']);
  assert.deepEqual(status({ startsHeld: true }), ['attention', 'showCheck.engine.startsHeld']);
  assert.deepEqual(checkEngine({ ...engineOk, engineVersion: '2.6.23' }).detail,
    { key: 'showCheck.engine.versionMismatch', params: { engine: '2.6.23', app: '2.6.24' } });
  // A version that cannot be compared is never reported as a match.
  assert.deepEqual(status({ engineVersion: null }), ['unchecked', 'showCheck.engine.versionNotReported']);
  assert.deepEqual(status({ appVersion: null }), ['unchecked', 'showCheck.engine.appVersionUnknown']);
});

test('output selections resolve the way the engine resolves them', () => {
  const devices = [
    device('Scarlett'),
    device('Twin', { id: 'hw:a' }), device('Twin', { id: 'hw:b' }),
    device('Unplugged', { isAvailable: false, state: 'disconnected' }),
    device('Stuck', { id: 'open-1', isOpen: true, state: 'stalled' }),
    device('Legacy', { id: 'open-2', isOpen: true, state: 'running' }),
  ];
  assert.deepEqual(resolveOutput('Scarlett', devices), { state: 'ok', name: 'Scarlett' });
  assert.deepEqual(resolveOutput('Twin', devices), { state: 'ambiguous', name: 'Twin' });
  assert.deepEqual(resolveOutput('Unplugged', devices), { state: 'missing', name: 'Unplugged' });
  assert.deepEqual(resolveOutput('Never seen', devices), { state: 'missing', name: 'Never seen' });
  assert.deepEqual(resolveOutput('Stuck', devices), { state: 'stalled', name: 'Stuck' });
  // Older shows stored the opened-device id; the engine still accepts it.
  assert.deepEqual(resolveOutput('open-2', devices), { state: 'ok', name: 'Legacy' });
  // An id only counts while that device is open.
  assert.equal(resolveOutput('hw:Scarlett', devices).state, 'missing');
});

test('the output line covers the main, preview, LTC and per-cue outputs', () => {
  const devices = [device('Built-in', { isDefault: true }), device('Scarlett'), device('Phones')];
  const systemDefault = checkOutput({ devices, main: null, preview: null, ltc: null }, []);
  assert.deepEqual([systemDefault.status, systemDefault.detail],
    ['pass', { key: 'showCheck.output.defaultOk', params: { name: 'Built-in' } }]);

  const noDefault = checkOutput({ devices: [device('Scarlett')], main: null, preview: null, ltc: null }, []);
  assert.deepEqual([noDefault.status, noDefault.detail, noDefault.problems],
    ['attention', { key: 'showCheck.output.defaultMissing' }, 1]);

  const withRoles = checkOutput({ devices, main: 'Scarlett', preview: 'Phones', ltc: 'Timecode box' }, [
    cue('1', { output: 'Scarlett' }),
    cue('2', { output: 'Side fills' }),
    cue('q', { inPlaylist: false, cueNumber: null, quickPlayNumber: 4, output: 'Side fills' }),
  ]);
  assert.equal(withRoles.status, 'attention');
  assert.deepEqual(withRoles.detail, { key: 'showCheck.output.mainOk', params: { name: 'Scarlett' } });
  assert.deepEqual(withRoles.entries.map(entry => [entry.id, entry.status, entry.name, entry.detail.key, entry.itemUuid]), [
    ['preview', 'pass', 'Phones', 'showCheck.output.ok', null],
    ['ltc', 'attention', 'Timecode box', 'showCheck.output.missing', null],
    ['output:2', 'attention', 'Name 2', 'showCheck.output.cue.missing', '2'],
    ['output:q', 'attention', 'Name q', 'showCheck.output.cue.missing', null],
  ]);
  assert.deepEqual(withRoles.entries[2]!.detail.params, { device: 'Side fills' });
  assert.deepEqual(withRoles.entries[3]!.label, { key: 'showCheck.quickPlayNumber', params: { number: 4 } });
  assert.equal(withRoles.problems, 3);

  const mainGone = checkOutput({ devices, main: 'Old desk', preview: null, ltc: null }, []);
  assert.deepEqual([mainGone.status, mainGone.detail],
    ['attention', { key: 'showCheck.output.mainMissing', params: { name: 'Old desk' } }]);

  // No device list means nothing was verified, whatever the show is set to.
  const noList = checkOutput({ devices: null, main: null, preview: null, ltc: null }, []);
  assert.deepEqual([noList.status, noList.detail.key, noList.problems], ['unchecked', 'showCheck.output.noList', 0]);
});

test('the media line counts ready cues and names every other cue with the reason the engine gave', () => {
  const cues = [cue('1'), cue('2'), cue('3'), cue('4'), cue('5'),
    cue('q', { inPlaylist: false, cueNumber: null, quickPlayNumber: 2 })];
  const result = checkMedia(cues, {
    listReady: true,
    report: {
      loading: false,
      loaded: ['1', '5'],
      failures: [
        { itemUuid: '2', code: 'decoder_init_failed', path: '/shows/media/walk-on.wav' },
        { itemUuid: '3', code: 'media_changed', path: 'C:\\shows\\media\\sting.wav' },
        { itemUuid: 'q', code: 'missing_media_path', path: '' },
        { itemUuid: 'gone', code: 'load_exception', path: '/not/in/this/show.wav' },
      ],
    },
  });
  assert.equal(result.status, 'attention');
  assert.deepEqual(result.detail, { key: 'showCheck.media.ready', params: { ready: 2, total: 6 } });
  assert.deepEqual(result.entries.map(entry => [entry.itemUuid, entry.detail.key, entry.path]), [
    ['2', 'showCheck.media.reason.unreadable', '/shows/media/walk-on.wav'],
    ['3', 'showCheck.media.reason.changed', 'C:\\shows\\media\\sting.wav'],
    ['4', 'showCheck.media.reason.notLoaded', null],
    [null, 'showCheck.media.reason.noFile', null],
  ]);
  assert.deepEqual(result.entries[0]!.label, { key: 'showCheck.cueNumber', params: { number: '2' } });
  assert.equal(result.problems, 4);

  const loading = checkMedia([cue('1'), cue('2')], {
    listReady: true, report: { loading: true, loaded: ['1'], failures: [] },
  });
  assert.deepEqual([loading.status, loading.entries.map(entry => entry.detail.key)],
    ['attention', ['showCheck.media.reason.loading']]);

  const unknownCode = checkMedia([cue('1')], {
    listReady: true, report: { loading: false, loaded: [], failures: [{ itemUuid: '1', code: 'new_code', path: '' }] },
  });
  assert.deepEqual(unknownCode.entries[0]!.detail, { key: 'showCheck.media.reason.failed', params: { code: 'new_code' } });
});

test('media that could not be verified is not checked, never ready', () => {
  const keys = (facts: MediaFacts, cues = [cue('1')]) => {
    const entry = checkMedia(cues, facts);
    return [entry.status, entry.detail.key];
  };
  const report = { loading: false, failures: [], loaded: ['1'] };
  assert.deepEqual(keys({ listReady: false, report }), ['unchecked', 'showCheck.media.listLoading']);
  assert.deepEqual(keys({ listReady: true, report: null }), ['unchecked', 'showCheck.media.noReport']);
  // An engine that does not list loaded cues cannot confirm any of them.
  assert.deepEqual(keys({ listReady: true, report: { ...report, loaded: null } }),
    ['unchecked', 'showCheck.media.notListed']);
  const failuresOnly = checkMedia([cue('1'), cue('2')], {
    listReady: true,
    report: { loading: false, loaded: null, failures: [{ itemUuid: '2', code: 'load_exception', path: '/a.wav' }] },
  });
  assert.deepEqual([failuresOnly.status, failuresOnly.detail],
    ['attention', { key: 'showCheck.media.problemsOnly', params: { count: 1, total: 2 } }]);
  assert.deepEqual(keys({ listReady: true, report }, []), ['pass', 'showCheck.media.none']);
});

test('the show file line reports saved, saving, unsaved, failed and repaired-but-unsaved', () => {
  const key = (facts: Partial<FileFacts>) => {
    const entry = checkFile({ ...savedFile, ...facts });
    return [entry.status, entry.detail.key];
  };
  assert.deepEqual(key({}), ['pass', 'showCheck.file.saved']);
  assert.deepEqual(key({ autoSave: false }), ['pass', 'showCheck.file.savedAutosaveOff']);
  assert.deepEqual(key({ unsaved: true }), ['attention', 'showCheck.file.saving']);
  assert.deepEqual(key({ unsaved: true, autoSave: false }), ['attention', 'showCheck.file.unsaved']);
  assert.deepEqual(key({ unsaved: true, saveFailed: true }), ['attention', 'showCheck.file.saveFailed']);
  assert.deepEqual(key({ repairPending: true }), ['attention', 'showCheck.file.repairPending']);
  assert.deepEqual(key({ hasFile: false }), ['attention', 'showCheck.file.noFile']);
});

test('the video line reports the existing video check and never passes on its own', () => {
  const cues = [cue('1'), cue('v1', { hasVideo: true }), cue('v2', { hasVideo: true })];
  const key = (facts: Partial<VideoFacts>) => {
    const entry = checkVideo(cues, { ...noVideo, ...facts })!;
    return [entry.status, entry.detail.key, entry.action];
  };
  assert.equal(checkVideo([cue('1')], noVideo), null);
  assert.deepEqual(key({}), ['unchecked', 'showCheck.video.notRun', 'open-video-check']);
  assert.deepEqual(key({ phase: 'done', checked: 2, total: 2 }), ['pass', 'showCheck.video.passed', 'open-video-check']);
  // A finished run for a different set of video cues says nothing about these.
  assert.deepEqual(key({ phase: 'done', checked: 1, total: 1 }), ['unchecked', 'showCheck.video.stale', 'open-video-check']);
  assert.deepEqual(key({ phase: 'running', checked: 1, total: 2 }), ['unchecked', 'showCheck.video.running', 'open-video-check']);
  assert.deepEqual(key({ phase: 'stale', checked: 2, total: 2 }), ['unchecked', 'showCheck.video.stale', 'open-video-check']);
  assert.deepEqual(key({ phase: 'interrupted', checked: 1, total: 2 }), ['unchecked', 'showCheck.video.incomplete', 'open-video-check']);
  const issues = checkVideo(cues, { ...noVideo, phase: 'done', checked: 2, total: 2, issueUuids: ['v2', 'removed'] })!;
  assert.deepEqual([issues.status, issues.detail, issues.problems],
    ['attention', { key: 'showCheck.video.issues', params: { checked: 2, total: 2, count: 1 } }, 1]);
  assert.deepEqual(key({ available: false }), ['unchecked', 'showCheck.video.unavailable', null]);
});

test('the verdict counts every separate problem and is never Ready with something unchecked', () => {
  const broken = readyShow();
  broken.engine = { ...engineOk, engineVersion: '2.6.0' };
  broken.media.report = { loading: false, loaded: [], failures: [] };
  broken.file = { ...savedFile, unsaved: true, autoSave: false };
  const result = runPreShowCheck(broken);
  assert.equal(result.status, 'attention');
  assert.deepEqual(result.verdict, { key: 'showCheck.verdict.attention', params: { count: 4 } });

  const one = readyShow();
  one.file = { ...savedFile, saveFailed: true };
  assert.deepEqual(runPreShowCheck(one).verdict, { key: 'showCheck.verdict.attentionOne', params: { count: 1 } });

  const unverified = readyShow();
  unverified.output.devices = null;
  unverified.cues.push(cue('v', { hasVideo: true }));
  unverified.media.report!.loaded!.push('v');
  const incomplete = runPreShowCheck(unverified);
  assert.deepEqual([incomplete.status, incomplete.verdict, incomplete.attention, incomplete.unchecked],
    ['unchecked', { key: 'showCheck.verdict.incomplete' }, 0, 2]);
  assert.deepEqual(incomplete.lines.map(entry => entry.id), ['engine', 'output', 'media', 'file', 'video']);

  // Problems outrank unchecked lines, and both are still reported.
  unverified.file = { ...savedFile, saveFailed: true };
  const mixed = runPreShowCheck(unverified);
  assert.deepEqual([mixed.status, mixed.attention, mixed.unchecked], ['attention', 1, 2]);
  assert.equal(summarize(mixed.lines.filter(entry => entry.status === 'pass')).status, 'pass');
});
