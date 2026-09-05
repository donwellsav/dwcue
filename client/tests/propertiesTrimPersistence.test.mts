import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, reactive, ref } from 'vue';

const propertiesScript = (): string => {
  const filename = new URL('../app/components/PropertiesPanel.vue', import.meta.url);
  const source = readFileSync(filename, 'utf8');
  const descriptor = parse(source, { filename: filename.pathname }).descriptor;
  const script = descriptor.scriptSetup?.content;
  assert.ok(script, 'PropertiesPanel must have a script setup block');
  return script;
};

const playbackControlsScript = (): string => {
  const filename = new URL('../app/components/PlaybackControls.vue', import.meta.url);
  const source = readFileSync(filename, 'utf8');
  const descriptor = parse(source, { filename: filename.pathname }).descriptor;
  const script = descriptor.scriptSetup?.content;
  assert.ok(script, 'PlaybackControls must have a script setup block');
  return script;
};

function loadSavePreviewTrim(dependencies: Record<string, unknown>) {
  const script = playbackControlsScript();
  const dirtyStart = script.indexOf('const previewTrimDirty = computed');
  const dirtyEnd = script.indexOf('const previewIsNext = computed', dirtyStart);
  const handlerStart = script.indexOf('async function savePreviewTrim()');
  const handlerEnd = script.indexOf('function handleSetPreviewNext()', handlerStart);
  assert.ok(dirtyStart >= 0 && dirtyEnd > dirtyStart, 'preview dirty state must be present');
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'preview trim save handler must be present');

  const factorySource = [
    'function buildSavePreviewTrim(dependencies: Record<string, any>) {',
    '  const { computed, previewTempIn, previewPermanentIn, previewTempOut,',
    '    previewPermanentOut, previewTrimSaveFailed, previewingItem, saveProject } = dependencies;',
    script.slice(dirtyStart, dirtyEnd),
    script.slice(handlerStart, handlerEnd),
    '  return { previewTrimDirty, savePreviewTrim };',
    '}',
  ].join('\n');
  const compiled = ts.transpileModule(factorySource, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const buildSavePreviewTrim = Function(compiled + '; return buildSavePreviewTrim;')();
  return buildSavePreviewTrim(dependencies) as {
    previewTrimDirty: { value: boolean };
    savePreviewTrim: () => Promise<void>;
  };
}

function loadHandleTrimSilence(dependencies: Record<string, unknown>) {
  const script = propertiesScript();
  const start = script.indexOf('// Handle trim silence:');
  const end = script.indexOf('// Handle fade updates:', start);
  assert.ok(start >= 0 && end > start, 'trim-silence handler must be present');

  const factorySource = `
    function buildHandleTrimSilence(dependencies: Record<string, any>) {
      const {
        getSelectedItems,
        selectedItem,
        trimSilence,
        originalSnapshot,
        persistPropertyChanges,
        console,
      } = dependencies;
      ${script.slice(start, end)}
      return handleTrimSilence;
    }
  `;
  const compiled = ts.transpileModule(factorySource, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const buildHandleTrimSilence = Function(`${compiled}; return buildHandleTrimSilence;`)();
  return buildHandleTrimSilence(dependencies) as () => Promise<void>;
}

function loadHandleReplaceMedia(dependencies: Record<string, unknown>) {
  const script = propertiesScript();
  const start = script.indexOf('const handleReplaceMedia = async () => {');
  const end = script.indexOf('const copyToClipboard = async', start);
  assert.ok(start >= 0 && end > start, 'replace-media handler must be present');

  const handler = script
    .slice(start, end)
    .replaceAll('import.meta.client', 'client')
    .replaceAll('window.electronAPI', 'electronAPI');
  const factorySource = `
    function buildHandleReplaceMedia(dependencies: Record<string, any>) {
      const {
        client,
        electronAPI,
        isReplacingMedia,
        audioItem,
        replaceMediaError,
        replaceMediaStatus,
        t,
        _server,
        buildWaveformFromChannels,
        saveProject,
        originalSnapshot,
      } = dependencies;
      ${handler}
      return handleReplaceMedia;
    }
  `;
  const compiled = ts.transpileModule(factorySource, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const buildHandleReplaceMedia = Function(`${compiled}; return buildHandleReplaceMedia;`)();
  return buildHandleReplaceMedia(dependencies) as () => Promise<void>;
}

function loadHandleSave(dependencies: Record<string, unknown>) {
  const script = propertiesScript();
  const start = script.indexOf('const handleSave = async () => {');
  const end = script.indexOf('const handleCycleSelectedColors = async', start);
  assert.ok(start >= 0 && end > start, 'property-save handler must be present');

  const factorySource = `
    function buildHandleSave(dependencies: Record<string, any>) {
      const {
        endItemBatch,
        getSelectedItems,
        originalSnapshot,
        selectedItem,
        persistPropertyChanges,
      } = dependencies;
      ${script.slice(start, end)}
      return handleSave;
    }
  `;
  const compiled = ts.transpileModule(factorySource, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const buildHandleSave = Function(`${compiled}; return buildHandleSave;`)();
  return buildHandleSave(dependencies) as () => Promise<void>;
}

interface ItemPatchMutationIdentity {
  next: () => string;
  owns: (value: unknown) => boolean;
}

function loadCreateItemPatchMutationIdentity(): (clientId: string) => ItemPatchMutationIdentity {
  const filename = new URL('../app/composables/useProject.ts', import.meta.url);
  const source = readFileSync(filename, 'utf8');
  const start = source.indexOf('const createItemPatchMutationIdentity =');
  const end = source.indexOf('// UUIDs of items that were just added', start);
  assert.ok(start >= 0 && end > start, 'item-patch mutation identity must be present');
  const factorySource = `
    function loadIdentity() {
      ${source.slice(start, end)}
      return createItemPatchMutationIdentity;
    }
  `;
  const compiled = ts.transpileModule(factorySource, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return Function(`${compiled}; return loadIdentity();`)();
}

function loadApplyDocPatch(dependencies: Record<string, unknown>) {
  const filename = new URL('../app/composables/useProject.ts', import.meta.url);
  const source = readFileSync(filename, 'utf8');
  const start = source.indexOf('    const applyDocPatch =');
  const end = source.indexOf('    server().onDocPatch(applyDocPatch);', start);
  assert.ok(start >= 0 && end > start, 'document patch handler must be present');
  const factorySource =
    'function buildApplyDocPatch(dependencies: Record<string, any>) {\n' +
    '  const { currentProject, itemPatchIdentity, isHydrating, findItemAndParent, restoreWaveform } = dependencies;\n' +
    source.slice(start, end) +
    '  return applyDocPatch;\n' +
    '}';
  const compiled = ts.transpileModule(factorySource, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const buildApplyDocPatch = Function(compiled + '; return buildApplyDocPatch;')();
  return buildApplyDocPatch(dependencies) as (patch: unknown) => void;
}

function loadEndItemBatch(dependencies: Record<string, unknown>) {
  const filename = new URL('../app/composables/useProject.ts', import.meta.url);
  const source = readFileSync(filename, 'utf8');
  const start = source.indexOf('  const endItemBatch = async');
  const end = source.indexOf('  return {', start);
  assert.ok(start >= 0 && end > start, 'item batch completion handler must be present');
  const factorySource =
    'function buildEndItemBatch(dependencies: Record<string, any>) {\n' +
    '  const { _suppressItemSyncCount, _syncItemsDiffFn, _captureBaselinesFn, console } = dependencies;\n' +
    source.slice(start, end) +
    '  return endItemBatch;\n' +
    '}';
  const compiled = ts.transpileModule(factorySource, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const buildEndItemBatch = Function(compiled + '; return buildEndItemBatch;')();
  return buildEndItemBatch(dependencies) as () => Promise<void>;
}

test('trim silence snapshots a reactive audio item before reaching save', async () => {
  const item = reactive({
    type: 'audio',
    uuid: 'reactive-audio',
    inPoint: 0,
    outPoint: 12,
  });
  const selectedItem = ref(item);
  const originalSnapshot = ref<Record<string, unknown> | null>(null);
  let saveCalls = 0;
  const handleTrimSilence = loadHandleTrimSilence({
    getSelectedItems: () => [item],
    selectedItem,
    trimSilence: (audio: typeof item) => {
      audio.inPoint = 1.25;
      return true;
    },
    originalSnapshot,
    persistPropertyChanges: async () => {
      saveCalls += 1;
      return true;
    },
    console: { log() {} },
  });

  await assert.doesNotReject(handleTrimSilence());
  assert.equal(saveCalls, 1);
  assert.equal(originalSnapshot.value?.inPoint, 1.25);
  item.inPoint = 2;
  assert.equal(originalSnapshot.value?.inPoint, 1.25, 'snapshot must be detached from the Vue proxy');
});

test('replace media saves the final reactive item and snapshots the replacement', async () => {
  const item = reactive({
    type: 'audio',
    uuid: 'replace-success',
    mediaFileName: 'original.wav',
    mediaPath: '',
    mediaServerPath: '/media/original.wav',
    duration: 12,
    inPoint: 0,
    outPoint: 12,
    startNextTime: 10,
    waveform: [0.1],
  });
  const audioItem = ref(item);
  const originalSnapshot = ref<Record<string, unknown> | null>(null);
  const isReplacingMedia = ref(false);
  const replaceMediaError = ref(false);
  const replaceMediaStatus = ref('');
  const saveSnapshots: Record<string, unknown>[] = [];
  const regenerationCalls: Array<[string, string, boolean]> = [];
  const handleReplaceMedia = loadHandleReplaceMedia({
    client: true,
    electronAPI: {
      selectAudioFiles: async () => ['/media/replacement.wav'],
    },
    isReplacingMedia,
    audioItem,
    replaceMediaError,
    replaceMediaStatus,
    t: (key: string) => key,
    _server: {
      fetchMetadata: async () => ({ valid: true, duration_ms: 8_000, has_video: true }),
      fetchWaveformByPath: async () => ({ duration_ms: 8_000, channels: [[0.25, 0.5]] }),
      copyToMedia: async () => {
        throw new Error('linked media must not be copied');
      },
      requestWaveformGeneration: async (...args: [string, string, boolean]) => {
        regenerationCalls.push(args);
      },
    },
    buildWaveformFromChannels: () => [0.25, 0.5],
    saveProject: async () => {
      saveSnapshots.push(JSON.parse(JSON.stringify(item)));
      return true;
    },
    originalSnapshot,
  });

  await handleReplaceMedia();

  assert.equal(saveSnapshots.length, 1);
  assert.equal(saveSnapshots[0]?.mediaFileName, 'replacement.wav');
  assert.equal(saveSnapshots[0]?.mediaServerPath, '/media/replacement.wav');
  assert.equal(saveSnapshots[0]?.duration, 8);
  assert.equal(saveSnapshots[0]?.inPoint, 0);
  assert.equal(saveSnapshots[0]?.outPoint, 8);
  assert.equal(saveSnapshots[0]?.startNextTime, 8);
  assert.equal(saveSnapshots[0]?.hasVideo, true);
  assert.deepEqual(originalSnapshot.value, saveSnapshots[0]);
  assert.deepEqual(regenerationCalls, [['/media/replacement.wav', 'replace-success', true]]);
  assert.equal(replaceMediaError.value, false);
  assert.equal(replaceMediaStatus.value, 'properties.replacementComplete');
  assert.equal(isReplacingMedia.value, false);

  item.mediaServerPath = '/media/changed-after-save.wav';
  assert.equal(originalSnapshot.value?.mediaServerPath, '/media/replacement.wav');
});

test('replace media restores and re-saves the original reactive item when save rejects it', async () => {
  const item = reactive({
    type: 'audio',
    uuid: 'replace-rejected',
    mediaFileName: 'original.wav',
    mediaPath: '',
    mediaServerPath: '/media/original.wav',
    duration: 12,
    inPoint: 2,
    outPoint: 10,
    startNextTime: 9,
    waveform: [0.1],
    hasVideo: true,
  });
  const baseline = JSON.parse(JSON.stringify(item));
  const audioItem = ref(item);
  const originalSnapshot = ref<Record<string, unknown> | null>(baseline);
  const isReplacingMedia = ref(false);
  const replaceMediaError = ref(false);
  const replaceMediaStatus = ref('');
  const saveSnapshots: Record<string, unknown>[] = [];
  let saveCalls = 0;
  let regenerationCalls = 0;
  const handleReplaceMedia = loadHandleReplaceMedia({
    client: true,
    electronAPI: {
      selectAudioFiles: async () => ['/media/rejected.wav'],
    },
    isReplacingMedia,
    audioItem,
    replaceMediaError,
    replaceMediaStatus,
    t: (key: string) => key,
    _server: {
      fetchMetadata: async () => ({ valid: true, duration_ms: 6_000, has_video: false }),
      fetchWaveformByPath: async () => ({ duration_ms: 6_000, channels: [[0.75]] }),
      copyToMedia: async () => {
        throw new Error('linked media must not be copied');
      },
      requestWaveformGeneration: async () => {
        regenerationCalls += 1;
      },
    },
    buildWaveformFromChannels: () => [0.75],
    saveProject: async () => {
      saveCalls += 1;
      saveSnapshots.push(JSON.parse(JSON.stringify(item)));
      return saveCalls > 1;
    },
    originalSnapshot,
  });

  await handleReplaceMedia();

  assert.equal(saveCalls, 2, 'the restored item must be persisted after the rejected save');
  assert.equal(saveSnapshots[0]?.mediaFileName, 'rejected.wav');
  assert.equal(saveSnapshots[0]?.duration, 6);
  assert.deepEqual(saveSnapshots[1], baseline);
  assert.deepEqual(JSON.parse(JSON.stringify(item)), baseline);
  assert.deepEqual(originalSnapshot.value, baseline);
  assert.equal(regenerationCalls, 0);
  assert.equal(replaceMediaError.value, true);
  assert.equal(replaceMediaStatus.value, 'properties.replacementSaveFailed');
  assert.equal(isReplacingMedia.value, false);
});

test('rapid manual edit then trim survives a delayed local PATCH echo and reload', async () => {
  const item = reactive({
    type: 'audio',
    uuid: 'rapid-trim',
    inPoint: 0.5,
    outPoint: 12,
  });
  const selectedItem = ref(item);
  const originalSnapshot = ref<Record<string, unknown> | null>({ ...item });
  const identity = loadCreateItemPatchMutationIdentity()('local-client');
  const stalePatch = { type: 'audio', uuid: item.uuid, inPoint: 0.5, outPoint: 12 };
  const savedInPoints: number[] = [];
  let staleMutationId = '';
  let acknowledgePatch: () => void = () => {};
  const patchResponse = new Promise<void>((resolve) => {
    acknowledgePatch = resolve;
  });
  const persistPropertyChanges = async () => {
    savedInPoints.push(item.inPoint);
    return true;
  };
  const handleSave = loadHandleSave({
    endItemBatch: async () => {
      staleMutationId = identity.next();
      await patchResponse;
    },
    getSelectedItems: () => [item],
    originalSnapshot,
    selectedItem,
    persistPropertyChanges,
  });
  const handleTrimSilence = loadHandleTrimSilence({
    getSelectedItems: () => [item],
    selectedItem,
    trimSilence: () => {
      item.inPoint = 0;
      return true;
    },
    originalSnapshot,
    persistPropertyChanges,
    console: { log() {} },
  });

  const manualSave = handleSave();
  await Promise.resolve();
  assert.deepEqual(savedInPoints, [], 'the document save must wait for the item PATCH');
  acknowledgePatch();
  await manualSave;
  await handleTrimSilence();
  assert.deepEqual(savedInPoints, [0.5, 0]);


  let syncedBaseline = 0.5;
  let hydrating = false;
  const applyDocPatch = loadApplyDocPatch({
    currentProject: ref({ items: [item] }),
    itemPatchIdentity: identity,
    isHydrating: {
      get value() { return hydrating; },
      set value(value: boolean) {
        hydrating = value;
        if (!value) syncedBaseline = item.inPoint;
      },
    },
    findItemAndParent: () => ({ item, parent: [item] }),
    restoreWaveform() {},
  });
  applyDocPatch({ op: 'item_updated', clientMutationId: staleMutationId, patch: stalePatch });
  await Promise.resolve();
  assert.equal(item.inPoint, 0, 'the acknowledged stale echo must not overwrite the trim');
  assert.equal(syncedBaseline, 0.5, 'the own echo must not baseline the newer unsynced trim');
  const queuedPatch = syncedBaseline === item.inPoint ? null : { inPoint: item.inPoint };
  assert.deepEqual(queuedPatch, { inPoint: 0 });

  const remoteMirror = reactive({ ...item });
  const identicalRemoteEcho = { clientMutationId: 'remote-client:1', patch: stalePatch };
  if (!identity.owns(identicalRemoteEcho.clientMutationId)) {
    Object.assign(remoteMirror, identicalRemoteEcho.patch);
  }
  assert.equal(remoteMirror.inPoint, 0.5, 'an identical patch from another client must still apply');

  const reloaded = reactive({ ...item, inPoint: savedInPoints.at(-1) });
  assert.equal(reloaded.inPoint, 0);
});

test('item batch drain preserves a newer granular edit made while PATCH is in flight', async () => {
  const item = reactive({ inPoint: 0.5 });
  let syncedBaseline = item.inPoint;
  let acknowledgePatch: () => void = () => {};
  const patchResponse = new Promise<void>((resolve) => { acknowledgePatch = resolve; });
  const endItemBatch = loadEndItemBatch({
    _suppressItemSyncCount: ref(1),
    _syncItemsDiffFn: () => patchResponse,
    _captureBaselinesFn: () => { syncedBaseline = item.inPoint; },
    console: { warn() {} },
  });

  const drain = endItemBatch();
  item.inPoint = 0;
  acknowledgePatch();
  await drain;

  const queuedPatch = syncedBaseline === item.inPoint ? null : { inPoint: item.inPoint };
  assert.deepEqual(queuedPatch, { inPoint: 0 });
});

test('preview trim stays retryable when the authoritative save fails', async () => {
  const item = reactive({ type: 'audio', uuid: 'preview-trim', inPoint: 0, outPoint: 12 });
  const previewTempIn = ref(0.5);
  const previewTempOut = ref(11.5);
  const previewTrimSaveFailed = ref(false);
  const saveResults = [false, true];
  let saveCalls = 0;
  const { previewTrimDirty, savePreviewTrim } = loadSavePreviewTrim({
    computed,
    previewTempIn,
    previewPermanentIn: computed(() => item.inPoint),
    previewTempOut,
    previewPermanentOut: computed(() => item.outPoint),
    previewTrimSaveFailed,
    previewingItem: ref(item),
    saveProject: async () => saveResults[saveCalls++] ?? false,
  });

  assert.equal(previewTrimDirty.value, true);
  await savePreviewTrim();
  assert.deepEqual({ inPoint: item.inPoint, outPoint: item.outPoint }, { inPoint: 0.5, outPoint: 11.5 });
  assert.equal(previewTrimSaveFailed.value, true);
  assert.equal(previewTrimDirty.value, true, 'failed persistence must leave the Save Trim retry enabled');

  await savePreviewTrim();
  assert.equal(saveCalls, 2);
  assert.equal(previewTrimSaveFailed.value, false);
  assert.equal(previewTrimDirty.value, false);
});
