import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { computed, ref } from 'vue';
import * as audio from '../app/utils/audio';
import * as project from '../app/types/project';

const read = (name: string) => readFileSync(new URL(`../app/${name}`, import.meta.url), 'utf8');
const section = (source: string, from: string, to: string) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
};
const compile = (source: string, context: Record<string, unknown>, result: string) => {
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(context), `${code}\nreturn ${result};`)(...Object.values(context));
};
const oldSettings = {
  autoTrimSilenceOnImport: true,
  autoMatchLoudnessOnImport: true,
  autoReduceTruePeaksOnImport: true,
  outputTargetLevels: { loudnessTargetLufs: -18, limiterCeilingDb: -0.1 },
};
const measured = {
  duration_ms: 10000, analysis_version: 2, integrated_lufs: -5, true_peak_dbtp: 6,
  channels: [{ peak: [0.001, 0.9, 0.001, 0.001], rms: [0.001, 0.4, 0.001, 0.001] }],
};
const playlist = read('components/PlaylistView.vue');
const projectSource = read('composables/useProject.ts');
const serverSource = read('composables/useLiveplayServer.ts');

test('manual loudness normalization uses its LUFS target without a peak-ceiling input', () => {
  const item = { volume: 1 };
  assert.equal(audio.applyLoudnessMatch(item, {
    analysis_version: 2, integrated_lufs: -24, true_peak_dbtp: null,
  }, -18), true);
  assert.ok(Math.abs(20 * Math.log10(item.volume) - 6) < 1e-9);
  assert.equal(audio.applyLoudnessMatch(item, {
    analysis_version: 2, integrated_lufs: -24, true_peak_dbtp: 3,
  }, -18), false);
});

test('peak reduction leaves safe cues and existing attenuation unchanged', () => {
  for (const [truePeak, volume] of [[-18, 1], [0.9, 0.25], [-18, 2], [3, 0]] as const) {
    const item = { volume, inPoint: 1, outPoint: 9 };
    assert.equal(audio.applyTruePeakCeiling(item, {
      analysis_version: 2, true_peak_dbtp: truePeak,
    }, -1), false);
    assert.deepEqual(item, { volume, inPoint: 1, outPoint: 9 });
  }
});

test('peak reduction only lowers overs, respects current gain and never moves trim points', () => {
  for (const [truePeak, volume, ceiling] of [[3, 1, -1], [-9, 10, -1], [6, 1, -60]] as const) {
    const item = { volume, inPoint: 1, outPoint: 9 };
    const analysis = { analysis_version: 2 as const, true_peak_dbtp: truePeak };
    assert.equal(audio.applyTruePeakCeiling(item, analysis, ceiling), true);
    assert.ok(item.volume < volume);
    assert.ok(Math.abs(truePeak + 20 * Math.log10(item.volume) - ceiling) < 1e-9);
    assert.equal(item.inPoint, 1);
    assert.equal(item.outPoint, 9);
    assert.equal(audio.applyTruePeakCeiling(item, analysis, ceiling), false);
  }
});

test('invalid peak reduction inputs cannot change cue gain', () => {
  for (const truePeak of [null, NaN, Infinity, -Infinity, -120]) {
    const item = { volume: 0.5 };
    assert.equal(audio.applyTruePeakCeiling(item, {
      analysis_version: 2, true_peak_dbtp: truePeak,
    }, -1), false);
    assert.equal(item.volume, 0.5);
  }
  for (const volume of [NaN, Infinity, -Infinity, -1]) {
    const item = { volume };
    assert.equal(audio.applyTruePeakCeiling(item, {
      analysis_version: 2, true_peak_dbtp: 3,
    }, -1), false);
    assert.ok(Object.is(item.volume, volume));
  }
});

test('manual loudness matching and peak reduction are independent of the output ceiling', async () => {
  const properties = read('components/PropertiesPanel.vue');
  for (const mode of ['loudness', 'truePeak']) {
    for (const ceiling of [-1, -12, -36]) {
      const item = {
        type: 'audio', duration: 10, inPoint: 0, outPoint: 10, volume: 1,
        waveform: { analysis_version: 2, integrated_lufs: -24, true_peak_dbtp: -9 },
      };
      const normalize = compile(section(properties, 'const handleNormalize =', '// Handle trim silence:'), {
        ...audio, getSelectedItems: () => [item], selectedItem: { value: null },
        outputTargetLevels: { value: { limiterCeilingDb: ceiling } },
        saveProject: async () => true, console: { log() {}, warn() {} },
      }, 'handleNormalize');
      await normalize(mode, mode === 'loudness' ? -18 : -1);
      assert.ok(Math.abs(20 * Math.log10(item.volume) - (mode === 'loudness' ? 6 : 0)) < 1e-9);
    }
  }
});

test('the normalization control does not move or constrain its target when the ceiling changes', () => {
  const levels = ref({ loudnessTargetLufs: -18, limiterCeilingDb: -12 });
  const model = compile(section(read('components/WaveformTrimmer.vue'), 'type NormalizationMode =', 'const closeNormalizeMenu ='), {
    ref, computed, outputTargetLevels: levels,
  }, '{ normalizationTarget, normalizationMode }');
  assert.equal(model.normalizationTarget.value, -0.1);
  model.normalizationTarget.value = -1;
  assert.equal(model.normalizationTarget.value, -1);
  levels.value.limiterCeilingDb = -36;
  assert.equal(model.normalizationTarget.value, -1);
  model.normalizationMode.value = 'loudness';
  assert.equal(model.normalizationTarget.value, -18);
});

test('import ignores legacy DSP flags and preserves unity gain and the full source region', async () => {
  let analyses = 0;
  const levels = { ...oldSettings.outputTargetLevels };
  const build = compile(section(playlist, 'const buildVerifiedAudioCue =', 'const buildSpotifyCueSpecs ='), {
    ...project, ...audio, crypto: globalThis.crypto, t: (key: string) => key,
    outputTargetLevels: { value: levels },
    server: {
      fetchMetadata: async () => ({ valid: true, duration_ms: 10000 }),
      fetchWaveformByPath: async () => { analyses++; return measured; },
    },
  }, 'buildVerifiedAudioCue');
  for (const ceiling of [-0.1, -6, -30]) {
    levels.limiterCeilingDb = ceiling;
    const { cue } = await build('/show/media/original.wav', {
      ...oldSettings, outputTargetLevels: levels,
    }, 0);
    assert.equal(cue.volume, 1);
    assert.equal(cue.inPoint, 0);
    assert.equal(cue.outPoint, 10);
  }
  assert.equal(analyses, 3);
});

test('silence with no measured true peak is not reported as a zero-dBTP source', async () => {
  const build = compile(section(playlist, 'const buildVerifiedAudioCue =', 'const buildSpotifyCueSpecs ='), {
    ...project, ...audio, crypto: globalThis.crypto, t: (key: string) => key,
    outputTargetLevels: { value: oldSettings.outputTargetLevels },
    server: {
      fetchMetadata: async () => ({ valid: true, duration_ms: 10000 }),
      fetchWaveformByPath: async () => ({ ...measured, true_peak_dbtp: null }),
    },
  }, 'buildVerifiedAudioCue');
  const result = await build('/show/media/silence.wav', {}, 0);
  assert.equal(result.details.truePeakDbtp, null);
  assert.equal(result.warning, undefined);
});

test('missing waveform admits only decoder-verified media at the same file revision', async () => {
  let probe = { verified: true, duration_ms: 9000, file_revision: 'exact', sample_rate: 48000, source_channels: 2 };
  const build = compile(section(playlist, 'const buildVerifiedAudioCue =', 'const buildSpotifyCueSpecs ='), {
    ...project, ...audio, crypto: globalThis.crypto, t: (key: string) => key,
    server: {
      fetchMetadata: async () => ({ valid: true, duration_ms: 10000, file_revision: 'exact' }),
      fetchWaveformByPath: async () => { throw new Error('analysis unavailable'); },
      verifyAudioFile: async (path: string, revision: string) => {
        assert.equal(path, '/show/clip.wav');
        assert.equal(revision, 'exact');
        return probe;
      },
    },
  }, 'buildVerifiedAudioCue');
  const result = await build('/show/clip.wav', {}, 0);
  assert.equal(result.warning, 'importAudio.analysisUnavailable');
  assert.equal(result.cue.waveform, undefined);
  assert.equal(result.cue.outPoint, 9);
  assert.equal(result.cue.volume, 1);
  probe = { ...probe, file_revision: 'replacement' };
  await assert.rejects(build('/show/clip.wav', {}, 0));
  probe = { ...probe, verified: false, file_revision: 'exact' };
  await assert.rejects(build('/show/clip.wav', {}, 0));
});

test('upload continues after a failed file and retries only the failed selection', async () => {
  const calls: string[] = [];
  const projectEpoch = ref(0);
  const selectedUploaded = ref<string[]>([]);
  const failedUploads = ref<Array<{ file: File; reason: string }>>([]);
  let fail = true;
  const server = { serverUrl: 'http://engine', projectSessionId: 'show', connected: true,
    async uploadFile(_file: File, name: string, session: string) {
      assert.equal(session, 'show');
      calls.push(name);
      if (name === 'bad.wav' && fail) throw new Error('400 invalid source');
      if (name === 'late.wav') projectEpoch.value++;
      return { saved: [`/media/${name}`] };
    },
  };
  const upload = compile(section(read('components/AudioImportModal.vue'), 'async function uploadFiles(', 'function formatBytes('), {
    server, projectEpoch, currentProject: ref({}), uploadBatch: 0, uploading: ref(false), uploadStatus: ref(''),
    selectedUploaded, failedUploads, uploadedThisSession: ref([]), uploadedSizes: ref({}), t: (key: string) => key,
  }, 'uploadFiles');
  await upload(['first.wav', 'bad.wav', 'third.wav'].map(name => new File(['sample'], name)));
  assert.deepEqual(calls, ['first.wav', 'bad.wav', 'third.wav']);
  assert.deepEqual(selectedUploaded.value, ['/media/first.wav', '/media/third.wav']);
  assert.equal(failedUploads.value[0]?.file.name, 'bad.wav');
  fail = false;
  await upload(failedUploads.value.map(entry => entry.file));
  assert.deepEqual(failedUploads.value, []);
  assert.deepEqual(calls.slice(3), ['bad.wav']);
  await upload(['late.wav', 'wrong-show.wav'].map(name => new File(['sample'], name)));
  assert.deepEqual(calls.slice(4), ['late.wav']);
  assert.equal(selectedUploaded.value.includes('/media/late.wav'), false);
});

test('a later waveform cannot overwrite an imported cue gain or trim edit', async () => {
  const item = { type: 'audio', uuid: 'cue', duration: 10, inPoint: 1, outPoint: 9, volume: 0.75 };
  const cache = new Map();
  const handler = compile(`const apply = (patch: any) => { switch (patch.op) { ${section(
    projectSource, "case 'waveform_ready':", "case 'waveform_failed':",
  )} } };`, {
    ...project, ...audio, markRaw: (value: unknown) => value,
    findItemByUuid: () => item, _waveformCache: cache,
    findItemAndParent: () => null, lastItems: [], lastCartOnly: [],
    cacheWaveform: (uuid: string, value: unknown) => cache.set(uuid, value),
    _importProcessingPendingUuids: new Set(['cue']),
    currentProject: { value: { settings: oldSettings } },
    server: () => ({ fetchWaveformByPath: async () => measured }),
    resolveProjectPath: (path: string) => path,
    triggerWaveformUpdate() {}, _syncItemsDiffFn: async () => {}, saveProject: async () => true,
  }, 'apply');
  handler({ op: 'waveform_ready', item_uuid: 'cue', ...measured });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(item.volume, 0.75);
  assert.equal(item.inPoint, 1);
  assert.equal(item.outPoint, 9);
});

test('saving imported analysis keeps it in the session cache without sending waveform blobs', () => {
  const cache = new Map();
  const serialize = compile(section(projectSource, 'const _deepToRaw =', 'const isCartWindowMode ='), {
    toRaw: (value: unknown) => value,
    cacheWaveform: (uuid: string, value: unknown) => cache.set(uuid, value),
  }, 'itemsToJSON');
  const waveform = { peaks: [0.2, 0.8], length: 2, duration: 10 };
  const result = serialize([{ type: 'audio', uuid: 'cue', waveform, volume: 1 }]);
  assert.equal(cache.get('cue'), waveform);
  assert.equal('waveform' in result[0], false);
  assert.equal(result[0].volume, 1);
});

test('explicit silence trim preserves quiet audio around a louder transient', () => {
  const cue = {
    duration: 10, inPoint: 0, outPoint: 10, volume: 1,
    waveform: { duration: 10, length: 10, peaks: [0, 0, 0.001, 0.9, 0.00002, 0.00001, 0.000002, 0.000001, 0, 0] },
  };
  assert.equal(audio.trimSilence(cue), true);
  assert.equal(cue.inPoint, 1.9);
  assert.equal(cue.outPoint, 8.1);
  assert.equal(cue.volume, 1);
});

test('media copy sends the captured project and destination identity', async () => {
  let body: Record<string, unknown> = {};
  const copy = compile(section(serverSource, 'async function copyToMediaResult(', '  // Land a file dropped'), {
    currentProjectForImport: { value: { folderPath: '/shows/A/' } },
    projectPathForImport: { value: '/shows/A/A.dwcue' },
    detachedProjectForImport: { value: null },
    rest: async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return { dest_path: '/shows/A/media/original.wav' };
    },
  }, 'copyToMediaResult');
  await copy('/original.wav', 'reuse');
  assert.equal(body.expected_project_file_path, '/shows/A/A.dwcue');
  assert.equal(body.expected_media_root, '/shows/A/media');
});

test('detached media copy uses the owner project identity', async () => {
  let body: Record<string, unknown> = {};
  const copy = compile(section(serverSource, 'async function copyToMediaResult(', '  // Land a file dropped'), {
    currentProjectForImport: { value: { folderPath: '/shows/A' } },
    projectPathForImport: { value: '' },
    detachedProjectForImport: { value: { projectPath: '/shows/A/A.dwcue', projectEpoch: 1, ownerSessionId: 'owner' } },
    rest: async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return { dest_path: '/shows/A/media/original.wav' };
    },
  }, 'copyToMediaResult');
  await copy('/original.wav', 'reuse');
  assert.equal(body.expected_project_file_path, '/shows/A/A.dwcue');
});

test('a rejected local copy is not bypassed by uploading the same file', async () => {
  let uploads = 0;
  const resolve = compile(section(serverSource, 'async function resolveDroppedFileToMedia(', '  // Queue an async waveform')
    .replaceAll('import.meta.client', 'true'), {
    window: { electronAPI: { getFilePath: () => '/original.m3u' } },
    isLocalServer: { value: true },
    currentProjectForImport: { value: { folderPath: '/shows/A' } },
    projectPathForImport: { value: '/shows/A/A.dwcue' },
    detachedProjectForImport: { value: null },
    copyToMedia: async () => { throw new Error('400 Bad Request — Choose Link'); },
    uploadFile: async () => { uploads++; return { saved: ['/shows/A/media/original.m3u'] }; },
    console: { warn() {}, error() {} },
  }, 'resolveDroppedFileToMedia');
  await assert.rejects(resolve({ name: 'original.m3u' }), /Choose Link/);
  assert.equal(uploads, 0);
});

test('playlist import verifies the final copied file', async () => {
  const calls: string[] = [];
  const prepare = compile(section(playlist, 'const prepareImportFromServerPath =', 'const importFromServerPaths ='), {
    currentProject: { value: { settings: oldSettings } }, projectEpoch: { value: 1 },
    t: (key: string) => key, console: { error() {} },
    server: { copyToMediaResult: async () => { calls.push('copy'); return { destPath: '/show/media/copied.wav' }; } },
    buildVerifiedAudioCue: async (path: string) => {
      calls.push(path);
      return { cue: { mediaFileName: 'copied.wav', displayName: 'Copied' }, details: {} };
    },
  }, 'prepareImportFromServerPath');
  const result = await prepare('/original.wav');
  assert.equal(result.result.status, 'ready');
  assert.deepEqual(calls, ['copy', '/show/media/copied.wav']);
});

test('a playlist file drop cannot carry imported paths into a different project', async () => {
  const currentProject = { value: { items: [], folderPath: '/shows/A' } };
  const projectEpoch = { value: 1 };
  let imported = 0;
  const handleDrop = compile(section(playlist, 'const handleDrop =', '</script>'), {
    showMode: { value: false }, currentProject, projectEpoch,
    server: { resolveDroppedFileToMedia: async () => {
      currentProject.value = { items: [], folderPath: '/shows/B' };
      projectEpoch.value++;
      return '/shows/A/media/original.wav';
    } },
    importFromServerPaths: async () => { imported++; },
  }, 'handleDrop');
  await handleDrop({ preventDefault() {}, dataTransfer: { getData: () => '', files: [{ name: 'original.wav' }] } });
  assert.equal(imported, 0);
});
