import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { reactive } from 'vue';
import { DEFAULT_CART_AUDIO_ITEM, DEFAULT_PROJECT_SETTINGS, colorForNewAudioItem } from '../app/types/project';
import type { AudioItem, Project } from '../app/types/project';
import { sameOneShotMutationIdentity } from '../app/types/oneShotMutation';
import { buildWaveformFromChannels } from '../app/utils/audio';
import { applyOneShotMutation } from '../app/utils/oneShotMutation';
import { buildOneShotSlots, cloneAsIndependentOneShot, markAsOneShot, removeOneShotDesignation } from '../app/utils/oneShots';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const waveform = {
  duration_ms: 10000, analysis_version: 2 as const, integrated_lufs: -20, true_peak_dbtp: 6,
  channels: [{ peak: [0, 0.9, 0.9, 0], rms: [0, 0.4, 0.4, 0] }],
};
const makeProject = (name = 'A'): Project => ({
  name, version: '2', folderPath: `/shows/${name}`, items: [], cartItems: [], cartOnlyItems: [],
  settings: { ...DEFAULT_PROJECT_SETTINGS, autoMatchLoudnessOnImport: true, autoReduceTruePeaksOnImport: true, autoTrimSilenceOnImport: true },
  server: { projectFilePath: `/shows/${name}/${name}.dwcue` },
  theme: { mode: 'dark', accentColor: '#315fcf' }, createdAt: '', lastModified: '',
} as Project);
const cue = (uuid: string, slot = 0): AudioItem => {
  const item = {
    ...structuredClone(DEFAULT_CART_AUDIO_ITEM), uuid, index: [-1, slot], type: 'audio',
    displayName: uuid, mediaFileName: `${uuid}.wav`, mediaPath: `media/${uuid}.wav`,
    mediaServerPath: `/shows/A/media/${uuid}.wav`, waveformPath: '', duration: 10, outPoint: 10,
  } as AudioItem;
  markAsOneShot(item, slot);
  return item;
};

function harness(isDetached = false) {
  const project = makeProject();
  const currentProject = { value: project as Project | null };
  const projectEpoch = { value: 1 };
  const projectHydrationStatus = { value: 'ready' };
  const detachedIdentity = { value: { projectPath: '/shows/A/A.dwcue', projectEpoch: 1, ownerSessionId: 'owner' } };
  const showMode = { value: false };
  const cartOnlyItems = { value: new Map<string, AudioItem>() };
  const slotErrors: Record<number, string> = {};
  const pendingProcessing = new Set<string>();
  const snapshots: Project[] = [];
  const generated: unknown[][] = [];
  let save = async () => {
    currentProject.value!.cartOnlyItems = Array.from(cartOnlyItems.value.values());
    snapshots.push(structuredClone(currentProject.value!));
    return true;
  };
  const server = {
    copyToMediaResult: async (..._args: unknown[]) => ({ destPath: '/shows/A/media/hot.wav', skipped: false }),
    fetchMetadata: async (_path: string) => ({ valid: true, duration_ms: 10000 }),
    fetchWaveformByPath: async (_path: string) => waveform,
    resolveDroppedFileToMedia: async (_file: unknown) => '/shows/A/media/hot.wav' as string | null,
    requestWaveformGeneration: async (...args: unknown[]) => { generated.push(args); },
  };
  const dependencies = {
    DEFAULT_CART_AUDIO_ITEM, colorForNewAudioItem, buildWaveformFromChannels,
    cloneAsIndependentOneShot, markAsOneShot, removeOneShotDesignation, sameOneShotMutationIdentity,
    currentProject, projectEpoch, projectHydrationStatus, detachedIdentity, isDetached, showMode,
    canMutate: { get value() { return isDetached ? !!detachedIdentity.value : projectHydrationStatus.value === 'ready'; } },
    busySlot: { value: null }, importSlot: { value: 0 }, dragOverSlot: { value: null }, slotErrors,
    clearSlotError: (slot: number) => { delete slotErrors[slot]; },
    cartOnlyItems,
    oneShotSlots: { get value() { return buildOneShotSlots(currentProject.value?.items ?? [], [...cartOnlyItems.value.values()]); } },
    addCartOnlyItem: (item: AudioItem) => { cartOnlyItems.value.set(item.uuid, item); },
    removeCartOnlyItem: (uuid: string) => { cartOnlyItems.value.delete(uuid); },
    selectedItems: { value: new Set<string>() }, selectedItem: { value: null }, propertiesPanelOpen: { value: false },
    findItemByUuid: (uuid: string) => cartOnlyItems.value.get(uuid) ?? currentProject.value?.items.find(item => item.uuid === uuid),
    saveProject: () => save(),
    mutate: async (request: Parameters<typeof applyOneShotMutation>[1]) => applyOneShotMutation({ project: currentProject.value!, cartOnlyItems: cartOnlyItems.value }, request),
    markPendingImportProcessing: (uuid: string) => { pendingProcessing.add(uuid); },
    triggerWaveformUpdate() {}, server, crypto,
    t: (key: string, values?: { reason?: string }) => values?.reason ?? key,
    console: { error() {}, warn() {} },
  };
  const filename = new URL('../app/components/OneShotPanel.vue', import.meta.url);
  const script = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname }).descriptor.scriptSetup!.content;
  const start = script.indexOf('const errorMessage =');
  const end = script.indexOf('const handleDetach =', start);
  assert.ok(start >= 0 && end > start, 'One Shot import and mutation handlers must exist');
  const compiled = ts.transpileModule(script.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const handlers = Function(...Object.keys(dependencies), `${compiled}\nreturn { importFromServerPath, handleDrop, copyPlaylistItemIntoSlot, replaceSlotItem };`)(...Object.values(dependencies));
  return {
    ...dependencies, ...handlers, project, pendingProcessing, snapshots, generated,
    setSave(next: typeof save) { save = next; },
    switchProject() {
      currentProject.value = makeProject('B');
      projectEpoch.value++;
      detachedIdentity.value = { ...detachedIdentity.value, projectPath: '/shows/B/B.dwcue', projectEpoch: 2 };
      cartOnlyItems.value.clear();
      cartOnlyItems.value.set('B-existing', cue('B-existing'));
    },
  };
}
const importCue = (h: ReturnType<typeof harness>, fileMode = 'link') =>
  h.importFromServerPath('/external/hot.wav', 0, { fileMode, duplicatePolicy: 'reuse' });

for (const detached of [false, true]) {
  test(`${detached ? 'detached' : 'attached'} import preserves source gain and full timing with legacy flags enabled`, async () => {
    const h = harness(detached);
    assert.equal(await importCue(h), true);
    const imported = [...h.cartOnlyItems.value.values()][0]!;
    assert.deepEqual(imported.index, [-1, 0]);
    assert.equal(imported.volume, 1);
    assert.equal(imported.inPoint, 0);
    assert.equal(imported.outPoint, 10);
    assert.equal(imported.waveform?.true_peak_dbtp, 6);
    assert.equal(h.pendingProcessing.size, 0, 'no delayed import gain or trim');
    assert.equal(h.generated.length, 0, 'already-fetched analysis must not be decoded again');
    imported.volume = 0.75;
    imported.inPoint = 2;
    await Promise.resolve();
    assert.equal(imported.volume, 0.75);
    assert.equal(imported.inPoint, 2);
  });
}

test('copy and analysis completions cannot import into a replacement project', async () => {
  for (const stage of ['copy', 'analysis']) {
    const h = harness();
    const blocked = deferred<any>();
    if (stage === 'copy') h.server.copyToMediaResult = () => blocked.promise;
    else h.server.fetchWaveformByPath = () => blocked.promise;
    const pending = importCue(h, stage === 'copy' ? 'copy' : 'link');
    h.switchProject();
    const before = structuredClone(h.currentProject.value);
    blocked.resolve(stage === 'copy' ? { destPath: '/shows/A/media/hot.wav', skipped: false } : waveform);
    assert.equal(await pending, false);
    assert.deepEqual(h.currentProject.value, before);
    assert.deepEqual([...h.cartOnlyItems.value.keys()], ['B-existing']);
    assert.equal(h.snapshots.length, 0);
    assert.deepEqual(h.slotErrors, {});
  }
});

test('epoch, Show Mode, and hydration changes cancel an analyzing import', async () => {
  for (const change of ['epoch', 'show', 'hydration', 'detached-identity']) {
    const h = harness(change === 'detached-identity');
    const blocked = deferred<typeof waveform>();
    h.server.fetchWaveformByPath = () => blocked.promise;
    const pending = importCue(h);
    if (change === 'epoch') h.projectEpoch.value++;
    if (change === 'show') h.showMode.value = true;
    if (change === 'hydration') h.projectHydrationStatus.value = 'loading';
    if (change === 'detached-identity') h.detachedIdentity.value = { ...h.detachedIdentity.value, ownerSessionId: 'replacement-owner' };
    blocked.resolve(waveform);
    assert.equal(await pending, false, change);
    assert.equal(h.cartOnlyItems.value.size, 0, change);
    assert.equal(h.snapshots.length, 0, change);
    assert.deepEqual(h.slotErrors, {}, change);
  }
});

test('a detached same-project snapshot during analysis keeps the import valid', async () => {
  const h = harness(true);
  const blocked = deferred<typeof waveform>();
  h.server.fetchWaveformByPath = () => blocked.promise;
  const pending = importCue(h);
  h.currentProject.value = structuredClone(h.project);
  blocked.resolve(waveform);
  assert.equal(await pending, true);
  assert.equal(h.cartOnlyItems.value.size, 1);
  assert.deepEqual(h.slotErrors, {});
});

test('a stale dropped-file resolution never starts a new import', async () => {
  const h = harness();
  const blocked = deferred<string | null>();
  h.server.resolveDroppedFileToMedia = () => blocked.promise;
  const pending = h.handleDrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { getData: () => '', files: [{}] } }, 0);
  h.switchProject();
  blocked.resolve('/shows/A/media/hot.wav');
  await pending;
  assert.deepEqual([...h.cartOnlyItems.value.keys()], ['B-existing']);
  assert.equal(h.snapshots.length, 0);
  assert.deepEqual(h.slotErrors, {});
});

test('a stale failed save cannot roll back old cues into the replacement project', async () => {
  const h = harness();
  const previous = cue('previous');
  h.cartOnlyItems.value.set(previous.uuid, previous);
  const blocked = deferred<boolean>();
  const started = deferred<void>();
  h.setSave(() => { started.resolve(); return blocked.promise; });
  const pending = importCue(h);
  await started.promise;
  h.switchProject();
  const before = structuredClone(h.currentProject.value);
  blocked.resolve(false);
  assert.equal(await pending, false);
  assert.deepEqual(h.currentProject.value, before);
  assert.deepEqual([...h.cartOnlyItems.value.keys()], ['B-existing']);
  assert.deepEqual(h.slotErrors, {});
});

test('a current failed save restores the previous standalone cue and reports failure', async () => {
  const h = harness();
  const previous = reactive(cue('previous'));
  h.cartOnlyItems.value.set(previous.uuid, previous);
  h.setSave(async () => false);
  assert.equal(await importCue(h), false);
  assert.deepEqual([...h.cartOnlyItems.value.values()], [previous]);
  assert.equal(h.slotErrors[0], 'oneShots.saveFailed');
});

test('a failed save restores the same project slot after Show Mode or hydration changes', async () => {
  for (const change of ['show', 'hydration']) {
    for (const standalone of [false, true]) {
      const h = harness();
      const previous = cue('previous');
      if (standalone) h.cartOnlyItems.value.set(previous.uuid, previous);
      else h.project.items.push(previous);
      const blocked = deferred<boolean>();
      const started = deferred<void>();
      h.setSave(() => { started.resolve(); return blocked.promise; });
      const pending = importCue(h);
      await started.promise;
      assert.notEqual(h.oneShotSlots.value[0]?.uuid, previous.uuid);
      if (change === 'show') h.showMode.value = true;
      else h.projectHydrationStatus.value = 'loading';
      blocked.resolve(false);
      assert.equal(await pending, false);
      assert.equal(h.oneShotSlots.value[0], previous);
      assert.equal(h.cartOnlyItems.value.size, standalone ? 1 : 0);
      assert.equal(h.slotErrors[0], 'oneShots.saveFailed');
    }
  }
});

test('detached playlist clone uses the real replacement contract', async () => {
  const h = harness(true);
  h.project.items.push(cue('playlist-source'));
  await h.copyPlaylistItemIntoSlot('playlist-source', 1);
  const imported = [...h.cartOnlyItems.value.values()][0]!;
  assert.ok(imported);
  assert.equal(imported.oneShot?.sourceUuid, 'playlist-source');
  assert.deepEqual(imported.index, [-1, 1]);
  assert.deepEqual(h.slotErrors, {});
});
