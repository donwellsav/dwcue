import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, markRaw, nextTick, reactive, ref, toRaw, watch } from 'vue';
import { isCurrentSaveIdentity } from '../app/utils/projectIdentity';

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
  const end = source.indexOf('// Client-side waveform cache', start);
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
    '  const { currentProject, itemPatchIdentity, isHydrating, findItemAndParent, restoreWaveform, previewItemUuid, previewCueId } = dependencies;\n' +
    source.slice(start, end) +
    '  return applyDocPatch;\n' +
    '}';
  const compiled = ts.transpileModule(factorySource, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const buildApplyDocPatch = Function(compiled + '; return buildApplyDocPatch;')();
  return buildApplyDocPatch(dependencies) as (patch: unknown) => void;
}

function loadItemsSync(dependencies: Record<string, unknown>) {
  const source = readFileSync(new URL('../app/composables/useProject.ts', import.meta.url), 'utf8');
  const slice = (start: string, end: string) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `project sync source contains ${start}`);
    return source.slice(from, to);
  };
  const compiled = ts.transpileModule(`
    function build(dependencies: Record<string, any>) {
      const { currentProject, server, itemPatchIdentity, isCurrentSaveIdentity,
        ref, toRaw, watch, markRaw,
        projectFilePathRef = { value: '/show.dwcue' }, projectEpoch = { value: 1 },
        sessionLost = { value: false }, recoveringProject = { value: false },
        projectHydrationStatus = { value: 'ready' }, isHydrating = ref(false),
        previewItemUuid = ref(''), previewCueId = ref('') } = dependencies;
      const { applyPreviewState = (state: any) => {
        previewItemUuid.value = state.itemUuid || ''; previewCueId.value = state.cueId || '';
      } } = dependencies;
      const _waveformCache = new Map();
      const cacheWaveform = (uuid: string, waveform: any) => _waveformCache.set(uuid, waveform);
      const restoreWaveform = () => {};
      const triggerWaveformUpdate = () => {};
      const buildWaveformFromChannels = () => ({ peaks: [0.1] });
      const useCartItems = () => ({
        getCartOnlyItem: (uuid: string) => currentProject.value?.cartOnlyItems?.find((i: any) => i.uuid === uuid),
        addCartOnlyItem() {}, removeCartOnlyItem() {},
      });
      const findItemByUuid = (uuid: string) => findItemAndParent(uuid)?.item
        ?? currentProject.value?.cartOnlyItems?.find((i: any) => i.uuid === uuid);
      ${slice('  const toJSON =', '  const isCartWindowMode =')}
      ${slice('  const updateIndices =', '  // Add an item to the project')}
      ${slice('    let lastItems:', '    // Expose a refresh hook')}
      ${slice('    const findItemAndParent =', '    server().onDocPatch(applyDocPatch);')}
      ${slice('    const flatten =', '    _syncItemsDiffFn = queueItemsDiff;')}
      return { captureBaselines, syncItemsDiff, applyDocPatch, baseline: () => lastItems,
        baselines: () => ({ items: lastItems, cartOnly: lastCartOnly, cart: lastCart, theme: lastTheme, settings: lastSettings }) };
    }
  `, { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText;
  return Function(`${compiled}; return build;`)()({ ...dependencies, isCurrentSaveIdentity, ref, toRaw, watch, markRaw });
}

function loadPreviewControls(server: unknown) {
  const source = readFileSync(new URL('../app/composables/useProject.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  // ---- Preview controls');
  const end = source.indexOf('  // Force UI update for waveforms', start);
  const previewItemUuid = ref('a'); const previewCueId = ref('a-cue');
  const previewStateRevision = ref(-1); const previewStateSession = ref('');
  const serverProjectSessionId = ref('show');
  const compiled = ts.transpileModule(`
    function build(dependencies: any) {
      const { server, previewItemUuid, previewCueId, previewStateRevision, previewStateSession,
        serverProjectSessionId } = dependencies;
      const useLiveplayServer = () => server;
      ${source.slice(start, end)}
      return { startPreview, stopPreview, applyPreviewState };
    }
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return { ...Function(`${compiled}; return build;`)()({ server, previewItemUuid, previewCueId,
    previewStateRevision, previewStateSession, serverProjectSessionId }), previewItemUuid, previewCueId,
      serverProjectSessionId };
}

test('a delayed Preview stop completion cannot hide the newer audition', async () => {
  let release!: (value: unknown) => void;
  const oldStop = new Promise(resolve => { release = resolve; });
  const h = loadPreviewControls({ stopPreview: () => oldStop,
    startPreview: async () => ({ itemUuid: 'b', cueId: 'b-cue', revision: 3, project_session_id: 'show' }) });
  const stopped = h.stopPreview();
  await h.startPreview('b');
  release({ itemUuid: '', cueId: '', revision: 2, project_session_id: 'show' });
  await stopped;
  assert.equal(h.previewItemUuid.value, 'b');
  assert.equal(h.previewCueId.value, 'b-cue');
});

test('a delayed Preview start completion cannot resurrect an audition after Stop', async () => {
  let release!: (value: unknown) => void;
  const oldStart = new Promise(resolve => { release = resolve; });
  const h = loadPreviewControls({ startPreview: () => oldStart,
    stopPreview: async () => ({ itemUuid: '', cueId: '', revision: 4, project_session_id: 'show' }) });
  const started = h.startPreview('a');
  await h.stopPreview();
  release({ itemUuid: 'a', cueId: 'a-cue', revision: 3, project_session_id: 'show' });
  await started;
  assert.equal(h.previewItemUuid.value, '');
  assert.equal(h.previewCueId.value, '');
});

test('Preview broadcasts use the same ordering fence and a new server snapshot resets its scope', () => {
  const h = loadPreviewControls({});
  const currentProject = ref<any>({ items: [], cartOnlyItems: [] });
  const sync = loadItemsSync({ currentProject, itemPatchIdentity: loadCreateItemPatchMutationIdentity()('local'),
    previewItemUuid: h.previewItemUuid, previewCueId: h.previewCueId,
    applyPreviewState: h.applyPreviewState, server: () => ({ connected: true }) });
  sync.captureBaselines();
  sync.applyDocPatch({ op: 'preview_started', itemUuid: 'b', cueId: 'b-cue', revision: 50, project_session_id: 'show' });
  sync.applyDocPatch({ op: 'preview_stopped', revision: 49, project_session_id: 'show' });
  sync.applyDocPatch({ op: 'preview_started', itemUuid: 'a', cueId: 'a-cue', revision: 48, project_session_id: 'show' });
  assert.equal(h.previewCueId.value, 'b-cue');
  h.applyPreviewState({ itemUuid: 'c', cueId: 'c-cue', revision: 1, project_session_id: 'new-server' }, true);
  sync.applyDocPatch({ op: 'preview_stopped', revision: 51, project_session_id: 'show' });
  assert.equal(h.previewCueId.value, 'c-cue');
});

test('an in-flight item diff stops dispatching after its project or connection identity changes', async () => {
  for (const change of ['project', 'close', 'reopen', 'endpoint', 'token', 'recovery']) {
    for (const phase of ['move', 'remove', 'add', 'update', 'reorder']) {
      const audio = (uuid: string) => ({ type: 'audio', uuid, inPoint: 0 });
      const group = (uuid: string, children: unknown[]) => ({ type: 'group', uuid, children });
      const initial = phase === 'move' ? [group('g1', [audio('a')]), group('g2', [])]
        : phase === 'reorder' ? [group('g1', [audio('a'), audio('b')]), group('g2', [audio('c'), audio('d')])]
          : phase === 'add' ? [] : [audio('a'), audio('b')];
      const currentProject = ref<any>({ items: initial, cartOnlyItems: [] });
      const projectFilePathRef = ref('/p.dwcue');
      const projectEpoch = ref(1);
      const sessionLost = ref(false);
      const calls: string[] = [];
      let release!: () => void;
      const firstResponse = new Promise<void>(resolve => { release = resolve; });
      const srv = { connected: true, serverUrl: 'http://p', effectiveAccessToken: 'p-token',
        removeProjectItem: async () => { calls.push('remove'); await firstResponse; },
        addProjectItem: async () => { calls.push('add'); await firstResponse; },
        updateProjectItem: async () => { calls.push('update'); await firstResponse; },
        reorderProjectItems: async () => { calls.push('reorder'); await firstResponse; },
      };
      const sync = loadItemsSync({ currentProject, projectFilePathRef, projectEpoch, sessionLost,
        server: () => srv, itemPatchIdentity: loadCreateItemPatchMutationIdentity()('local'),
      });
      sync.captureBaselines();
      if (phase === 'move') currentProject.value.items[1].children.push(currentProject.value.items[0].children.pop());
      if (phase === 'remove') currentProject.value.items = [];
      if (phase === 'add') currentProject.value.items = [audio('a'), audio('b')];
      if (phase === 'update') currentProject.value.items.forEach((item: any) => { item.inPoint = 1; });
      if (phase === 'reorder') currentProject.value.items.forEach((item: any) => item.children.reverse());
      const pending = sync.syncItemsDiff();
      assert.equal(calls.length, 1, `${phase} must wait for its first mutation`);
      if (change === 'project') { currentProject.value = { items: [audio('q')], cartOnlyItems: [] }; projectFilePathRef.value = '/q.dwcue'; }
      if (change === 'close') currentProject.value = null;
      if (change === 'reopen') projectEpoch.value++;
      if (change === 'endpoint') srv.serverUrl = 'http://q';
      if (change === 'token') srv.effectiveAccessToken = 'q-token';
      if (change === 'recovery') sessionLost.value = true;
      sync.captureBaselines();
      const replacementBaseline = sync.baseline();
      release();
      await pending;
      assert.equal(calls.length, 1, `${change} during ${phase} must stop subsequent old mutations`);
      assert.equal(sync.baseline(), replacementBaseline, 'a stale completion must not replace the new baseline');
    }
  }
});

test('current-project item mutations retain remove/add/update/reorder ordering', async () => {
  const currentProject = ref<any>({ items: [
    { uuid: 'g', type: 'group', children: [{ uuid: 'm', type: 'audio' }] },
    { uuid: 'a', type: 'audio', inPoint: 0 }, { uuid: 'b', type: 'audio' }, { uuid: 'r', type: 'audio' },
  ], cartOnlyItems: [] });
  const calls: string[] = [];
  const sync = loadItemsSync({ currentProject, itemPatchIdentity: loadCreateItemPatchMutationIdentity()('local'),
    server: () => ({ connected: true,
      removeProjectItem: async (uuid: string) => { calls.push(`remove:${uuid}`); },
      addProjectItem: async (item: any) => { calls.push(`add:${item.uuid}`); },
      updateProjectItem: async (uuid: string) => { calls.push(`update:${uuid}`); },
      reorderProjectItems: async () => { calls.push('reorder'); },
    }),
  });
  sync.captureBaselines();
  const [g, a, b] = currentProject.value.items;
  a.inPoint = 1;
  currentProject.value.items = [g, b, a, g.children.pop(), { uuid: 'n', type: 'audio' }];
  await sync.syncItemsDiff();
  assert.deepEqual(calls, ['remove:m', 'add:m', 'remove:r', 'add:n', 'update:a', 'reorder']);
  await sync.syncItemsDiff();
  assert.equal(calls.length, 6, 'an unchanged project must not resend mutations');
});

test('runtime patches preserve pending authored edits while document patches hydrate without echo', async () => {
  for (const op of ['next_item_set', 'master_gain_changed', 'custom_action_result',
    'preview_started', 'preview_stopped', 'waveform_failed', 'unknown_runtime_op']) {
    const item = { type: 'audio', uuid: 'pending-trim', inPoint: 0, outPoint: 12 };
    const requests: unknown[] = [];
    const currentProject = ref({ items: [item], cartOnlyItems: [] });
    const itemPatchIdentity = loadCreateItemPatchMutationIdentity()('local-client');
    const previewItemUuid = ref('old-preview');
    const previewCueId = ref('old-cue');
    const sync = loadItemsSync({ currentProject, itemPatchIdentity, previewItemUuid, previewCueId,
      server: () => ({ connected: true, updateProjectItem: async (...args: unknown[]) => { requests.push(args); } }),
    });
    sync.captureBaselines();
    const apply = sync.applyDocPatch;
    currentProject.value.items[0].inPoint = 1;
    apply({ op, itemUuid: 'new-preview', cueId: 'new-cue' });
    await nextTick();
    await nextTick();
    await sync.syncItemsDiff();
    assert.equal(requests.length, 1, `${op} must leave the authored edit pending`);
    assert.equal((requests[0] as any[])[1].inPoint, 1);
    assert.equal(previewItemUuid.value, op === 'preview_started' ? 'new-preview' : op === 'preview_stopped' ? '' : 'old-preview');
    assert.equal(previewCueId.value, op === 'preview_started' ? 'new-cue' : op === 'preview_stopped' ? '' : 'old-cue');

    requests.length = 0;
    apply({ op: 'item_updated', uuid: item.uuid, patch: { inPoint: 2 } });
    await nextTick();
    await nextTick();
    await sync.syncItemsDiff();
    assert.equal(currentProject.value.items[0].inPoint, 2);
    assert.deepEqual(requests, [], 'a remote document edit must not echo back');
  }
});

test('granular document patches acknowledge only their portion and preserve unrelated unsent edits', async () => {
  const patches = [
    { op: 'item_updated', uuid: 'b', patch: { inPoint: 2 } },
    { op: 'item_updated', uuid: 'a', patch: { volume: 0.5 } },
    { op: 'item_updated', uuid: 'b', patch: {} },
    { op: 'item_added', uuid: 'c', item: { uuid: 'c', type: 'audio', index: [2], inPoint: 0 } },
    { op: 'item_added', uuid: 'cart-new', cartOnly: true, item: { uuid: 'cart-new', type: 'audio', index: [-1, 1], inPoint: 0 } },
    { op: 'item_removed', uuid: 'b' },
    { op: 'items_reordered', uuids: ['b', 'a'] },
    { op: 'cart_slot_set', slot: 0, itemUuid: 'b' },
    { op: 'cart_slot_set', slot: 0, itemUuid: '' },
    { op: 'cart_slot_cleared', slot: 0 },
    { op: 'theme_patched', theme: { accent: 'blue' } },
    { op: 'settings_patched', settings: { autoSave: false } },
    { op: 'waveform_ready', item_uuid: 'b', duration_ms: 12000, channels: [[0.1]] },
  ];
  for (const patch of patches) {
    const currentProject = ref({ items: ['a', 'b'].map((uuid, i) => ({
      uuid, type: 'audio', index: [i], inPoint: 0, volume: 1, duration: 0, outPoint: 0,
    })), cartOnlyItems: [], cartItems: [{ slot: 0, itemUuid: 'a', index: [-1, 0] }], theme: {}, settings: {} });
    const requests: any[][] = [];
    const sync = loadItemsSync({ currentProject,
      itemPatchIdentity: loadCreateItemPatchMutationIdentity()('local-client'),
      server: () => ({ connected: true, invalidateWaveformCache() {},
        updateProjectItem: async (...args: any[]) => { requests.push(args); },
        addProjectItem: async (...args: any[]) => { requests.push(['add', ...args]); },
        removeProjectItem: async (...args: any[]) => { requests.push(['remove', ...args]); },
        reorderProjectItems: async (...args: any[]) => { requests.push(['reorder', ...args]); },
      }),
    });
    sync.captureBaselines();
    currentProject.value.items[0].inPoint = 1;
    sync.applyDocPatch(patch);
    await nextTick();
    await nextTick();
    await sync.syncItemsDiff();
    assert.equal(requests.length, 1, `${patch.op} must retain the unsent local trim`);
    assert.equal(requests[0][0], 'a');
    assert.equal(requests[0][1].inPoint, 1);
    if (patch.op === 'item_updated' && patch.uuid === 'b' && 'inPoint' in patch.patch)
      assert.equal(currentProject.value.items.find(i => i.uuid === 'b')?.inPoint, 2);
  }
});

test('full server snapshots preserve local fields the server has not changed', async () => {
  const currentProject = ref<any>({ items: [], cartOnlyItems: [
    { uuid: 'cart', type: 'audio', index: [-1, 0], inPoint: 0, volume: 1 },
  ], cartItems: [{ slot: 9, itemUuid: 'original', index: [-1, 9] }],
  theme: { background: 'black' }, settings: { autoSave: false, defaultOutputDevice: 'old' } });
  const requests: any[][] = [];
  const sync = loadItemsSync({ currentProject,
    itemPatchIdentity: loadCreateItemPatchMutationIdentity()('local-client'),
    server: () => ({ connected: true, updateProjectItem: async (...args: any[]) => { requests.push(args); } }),
  });
  sync.captureBaselines();
  currentProject.value.cartOnlyItems[0].inPoint = 1;
  currentProject.value.cartItems[0].itemUuid = 'pending';
  currentProject.value.theme.background = 'pending';
  currentProject.value.settings.defaultOutputDevice = 'pending';
  sync.applyDocPatch({ op: 'item_updated', uuid: 'cart', patch: {
    uuid: 'cart', type: 'audio', index: [-1, 0], inPoint: 0, volume: 0.5,
  } });
  sync.applyDocPatch({ op: 'cart_slot_set', slot: 0, itemUuid: 'remote' });
  sync.applyDocPatch({ op: 'theme_patched', theme: { background: 'black', accent: 'blue' } });
  sync.applyDocPatch({ op: 'settings_patched', settings: {
    autoSave: false, defaultOutputDevice: 'old', autoCueNextWithoutEndBehavior: false,
  } });
  await nextTick();
  await nextTick();
  await sync.syncItemsDiff();
  assert.equal(requests.length, 1);
  assert.equal(requests[0][1].inPoint, 1);
  assert.equal(requests[0][1].volume, 0.5);
  assert.equal(currentProject.value.cartOnlyItems[0].volume, 0.5, 'remote cart-only update reaches its current store item');
  assert.equal(currentProject.value.theme.background, 'pending');
  assert.equal(currentProject.value.settings.defaultOutputDevice, 'pending');
  assert.deepEqual(sync.baselines().cart, [
    { slot: 9, itemUuid: 'original', index: [-1, 9] }, { slot: 0, itemUuid: 'remote', index: [-1, 0] },
  ]);
  assert.deepEqual(sync.baselines().theme, { background: 'black', accent: 'blue' });
  assert.deepEqual(sync.baselines().settings, { autoSave: false, defaultOutputDevice: 'old', autoCueNextWithoutEndBehavior: false });
  requests.length = 0;
  currentProject.value.cartOnlyItems[0].inPoint = 3;
  sync.applyDocPatch({ op: 'item_updated', uuid: 'cart', patch: { inPoint: 2 } });
  sync.applyDocPatch({ op: 'theme_patched', theme: { background: 'remote-change' } });
  sync.applyDocPatch({ op: 'settings_patched', settings: { defaultOutputDevice: 'remote-change' } });
  await nextTick();
  await sync.syncItemsDiff();
  assert.equal(currentProject.value.cartOnlyItems[0].inPoint, 2, 'a changed server value still resolves an actual field conflict');
  assert.equal(currentProject.value.theme.background, 'remote-change');
  assert.equal(currentProject.value.settings.defaultOutputDevice, 'remote-change');
  assert.deepEqual(requests, [], 'accepted server changes must not echo back');
});

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
