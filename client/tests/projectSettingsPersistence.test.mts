import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parse } from '@vue/compiler-sfc';
import { compile, NodeTypes, parse as parseTemplate } from '@vue/compiler-dom';
import * as Vue from 'vue';
import ts from 'typescript';

import { DEFAULT_VIDEO_FRAMING, VIDEO_FRAME_PRESETS } from '../electron/video-output-framing.mjs';
import { formatDisplayIndexPath, parseDisplayIndexPath } from '../app/utils/indexDisplay.ts';

test('the inline Canvas chooser updates the draft and keeps it when switching to Custom', () => {
  const source = readFileSync(new URL('../app/components/ProjectSettingsModal.vue', import.meta.url), 'utf8');
  const start = source.indexOf('function selectVideoFramePreset(');
  const end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start);
  const code = ts.transpileModule(source.slice(start, end + 2), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const preset = { value: '1080p' };
  const draft = { value: { ...DEFAULT_VIDEO_FRAMING, scale: 80, scaling: 'limit' } };
  const choose = Function('VIDEO_FRAME_PRESETS', 'voFramePreset', 'voFraming',
    `${code}\nreturn selectVideoFramePreset;`)(VIDEO_FRAME_PRESETS, preset, draft);
  choose('720p');
  assert.equal(preset.value, '720p');
  assert.deepEqual(draft.value, { width: 1280, height: 720, scale: 80, scaling: 'limit' });
  choose('custom');
  assert.equal(preset.value, 'custom');
  assert.deepEqual(draft.value, { width: 1280, height: 720, scale: 80, scaling: 'limit' });
});

test('the inline color editor reads shorthand and full hex while fencing transparency to Test Cards', () => {
  const source = readFileSync(new URL('../app/components/InlineColorPicker.vue', import.meta.url), 'utf8');
  const start = source.indexOf('function readHexColor(');
  const end = source.indexOf('function applyColor(', start);
  assert.ok(start >= 0 && end > start);
  const code = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const read = Function(code + '\nreturn readHexColor;')();
  assert.equal(read(' #36a ', true), '#3366AA');
  assert.equal(read('3E159C', true), '#3E159C');
  assert.equal(read('#3698', false), '#33669988');
  assert.equal(read('#33669988', false), '#33669988');
  assert.equal(read('#33669988', true), null);
  assert.equal(read('#3698', true), null);
  assert.equal(read('red', false), null);
  assert.equal(read('#12Z', false), null);
});

test('the Settings accent applies to the current show and saves only an actual change', () => {
  const source = readFileSync(new URL('../app/components/ProjectSettingsModal.vue', import.meta.url), 'utf8');
  const start = source.indexOf('function setAccentColor(');
  const end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start);
  const code = ts.transpileModule(source.slice(start, end + 2), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const currentProject = Vue.ref({ theme: { accentColor: '#315fcf', mode: 'dark' } });
  const hydration = Vue.ref('loading');
  const selectedAccent = Vue.computed(() => currentProject.value.theme.accentColor);
  const saves: string[] = [];
  const select = Function('currentProject', 'projectHydrationStatus', 'selectedAccent', 'saveProject',
    `${code}; return setAccentColor;`)(currentProject, hydration, selectedAccent,
    () => saves.push(selectedAccent.value));
  select('#24a148');
  hydration.value = 'ready';
  select('#24a148');
  select('#24a148');
  assert.deepEqual(saves, ['#24a148']);
  assert.deepEqual(currentProject.value.theme, { accentColor: '#24a148', mode: 'dark' });
});

test('playlist numbering starts at one for new shows and saved zero starts', () => {
  for (const start of [undefined, null, 0, '0', -1, '']) {
    assert.equal(formatDisplayIndexPath([0], start), '1');
    assert.equal(formatDisplayIndexPath([0, 1], start), '1,2');
    assert.deepEqual(parseDisplayIndexPath('1.2', start), [0, 1]);
    assert.deepEqual(parseDisplayIndexPath('1,0,2', start), []);
    assert.deepEqual(parseDisplayIndexPath('1/2x', start), []);
  }
  assert.equal(formatDisplayIndexPath([0, 1], 10), '10,11');
  assert.deepEqual(parseDisplayIndexPath('10/11', 10), [0, 1]);
  assert.equal(formatDisplayIndexPath([-1, 0], 1), '-1,0');
});

test('invalid cue number edits preserve the previously saved target', () => {
  const file = new URL('../app/components/PropertiesPanel.vue', import.meta.url);
  const script = parse(readFileSync(file, 'utf8')).descriptor.scriptSetup!.content;
  for (const phase of ['Start', 'End']) {
    const name = `handle${phase}BehaviorIndexChange`;
    const property = `${phase.toLowerCase()}Behavior`;
    const start = script.indexOf(`const ${name} =`);
    const end = script.indexOf('\n};', start);
    assert.ok(start >= 0 && end > start);
    const code = ts.transpileModule(script.slice(start, end + 3), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    const behavior = { targetIndex: [1] };
    let saves = 0;
    const edit = Function('selectedItem', 'audioItem', `${property}TargetIndex`,
      'parseItemIndexInput', 'formatItemIndex', 'handleSave', `${code}; return ${name};`)(
      { value: { type: 'audio' } }, { value: { [property]: behavior } }, { value: [1] },
      (raw: string) => parseDisplayIndexPath(raw, 1),
      (index: number[]) => formatDisplayIndexPath(index, 1),
      () => { saves++; },
    );
    const input = { value: '1,0,2' };
    edit({ target: input });
    assert.equal(input.value, '2');
    assert.deepEqual(behavior.targetIndex, [1]);
    assert.equal(saves, 0);
    input.value = '1';
    edit({ target: input });
    assert.deepEqual(behavior.targetIndex, [0]);
    assert.equal(saves, 1);
  }
});

test('project and cue output choices persist hardware names instead of opened-session IDs', () => {
  const device = { id: 'ephemeral-opened-device-id', display_name: 'Stage USB output', is_default: true };
  for (const [component, handler] of [
    ['ProjectSettingsModal', 'onAudioDeviceChange'], ['ProjectSettingsModal', 'onPreviewDeviceChange'],
    ['ProjectSettingsModal', 'onLtcDeviceChange'], ['PropertiesPanel', 'onDeviceOverrideChange'],
  ]) {
    const filename = new URL(`../app/components/${component}.vue`, import.meta.url);
    const { template, scriptSetup } = parse(readFileSync(filename, 'utf8')).descriptor;
    const ast = parseTemplate(template!.content);
    const docked = component === 'ProjectSettingsModal';
    const t = (key: string) => key;
    const find = (node: any): any => {
      if (node.type === NodeTypes.ELEMENT && node.tag === (docked ? 'InlineChoicePicker' : 'select') &&
          node.loc.source.includes(`@change="${handler}"`)) return node;
      for (const child of node.children ?? []) {
        const found = find(child);
        if (found) return found;
      }
    };
    const select = find(ast);
    assert.ok(select, `${component} output selector must exist`);
    const code = ts.transpileModule(compile(select.loc.source, { mode: 'function', isTS: true }).code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    let audioDeviceOptions;
    if (docked) {
      const script = scriptSetup!.content;
      const start = script.indexOf('const audioDeviceOptions =');
      const end = script.indexOf('const outputTargetOptions =', start);
      assert.ok(start >= 0 && end > start);
      audioDeviceOptions = Function('computed', 'devices', 't',
        `${script.slice(start, end)}\nreturn audioDeviceOptions.value;`)(Vue.computed, { value: [device] }, t);
    }
    const render = Function('Vue', `${code}; return render;`)({ ...Vue, resolveComponent: (name: string) => name });
    const node = render({
      audioDeviceOptions, devicesList: [device], audioDeviceId: device.display_name,
      previewDeviceId: device.display_name, ltcDeviceId: device.display_name,
      audioItem: { deviceOverride: device.display_name }, audioDeviceOverride: device.display_name,
      deviceOverrideEditPending: false,
      t, [handler]() {},
    }, []);
    if (docked) {
      assert.deepEqual(node.props.options.map((option: {value: string}) => option.value), ['', device.display_name]);
      continue;
    }
    const options: any[] = [];
    const walk = (value: any) => {
      if (value?.type === 'option') options.push(value);
      if (Array.isArray(value?.children)) value.children.forEach(walk);
    };
    walk(node);
    assert.equal(options.find(option => option.key === device.id)?.props.value, device.display_name);
  }
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function loadApplyPatch(dependencies: Record<string, unknown>) {
  const filename = new URL('../app/components/ProjectSettingsModal.vue', import.meta.url);
  const source = readFileSync(filename, 'utf8');
  const descriptor = parse(source, { filename: filename.pathname }).descriptor;
  const script = descriptor.scriptSetup?.content;
  assert.ok(script, 'ProjectSettingsModal must have a script setup block');

  const start = script.indexOf("type PatchResult = 'saved' | 'unsaved' | 'failed';");
  const end = script.indexOf('function countdownBandRange', start);
  assert.ok(start >= 0 && end > start, 'settings persistence block must be present');

  const factorySource = `
    function buildApplyPatch(dependencies: Record<string, any>) {
      const { currentProject, settingsError, server, saveProject, describeSettingsError, t, console } = dependencies;
      ${script.slice(start, end)}
      return applyPatch;
    }
  `;
  const compiled = ts.transpileModule(factorySource, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const buildApplyPatch = Function(`${compiled}; return buildApplyPatch;`)();
  type SettingsPatch = Record<string, unknown>;
  return buildApplyPatch(dependencies) as
    (request: SettingsPatch | ((settings: SettingsPatch) => SettingsPatch | null)) => Promise<string>;
}

function settingsHarness(initialSettings: Record<string, unknown>) {
  const project = { settings: { ...initialSettings } };
  const currentProject = { value: project as { settings: Record<string, unknown> } | null };
  const settingsError = { value: '' };
  const patchRequests: Array<{
    patch: Record<string, unknown>;
    pending: Deferred<void>;
  }> = [];
  let saveProject = async (): Promise<boolean> => true;
  const server = {
    reconnecting: false,
    patchSettings: (patch: Record<string, unknown>) => {
      const pending = deferred<void>();
      patchRequests.push({ patch, pending });
      return pending.promise;
    },
  };
  const applyPatch = loadApplyPatch({
    currentProject,
    settingsError,
    server,
    saveProject: () => saveProject(),
    describeSettingsError: (error: unknown) => error instanceof Error ? error.message : 'Error',
    t: (key: string) => key,
    console: { warn() {} },
  });
  return {
    project,
    currentProject,
    settingsError,
    patchRequests,
    applyPatch,
    setSaveProject(next: () => Promise<boolean>) { saveProject = next; },
  };
}

test('serializes same-key edits so two rejected patches restore the acknowledged value', async () => {
  const harness = settingsHarness({ cycleTrackColors: false });

  const first = harness.applyPatch({ cycleTrackColors: true });
  await Promise.resolve();
  assert.equal(harness.project.settings.cycleTrackColors, true);
  assert.equal(harness.patchRequests.length, 1);

  const second = harness.applyPatch({ cycleTrackColors: false });
  await Promise.resolve();
  assert.equal(harness.patchRequests.length, 1, 'second edit must wait for the first acknowledgement');

  harness.patchRequests[0]!.pending.reject(new Error('first rejected'));
  assert.equal(await first, 'failed');
  await Promise.resolve();
  assert.equal(harness.patchRequests.length, 2);
  assert.equal(harness.project.settings.cycleTrackColors, false);

  harness.patchRequests[1]!.pending.reject(new Error('second rejected'));
  assert.equal(await second, 'failed');
  assert.equal(harness.project.settings.cycleTrackColors, false);
  assert.equal(harness.settingsError.value, 'second rejected');
});

test('queued countdown color edits preserve other bands and ignore a rejected optimistic value', async () => {
  type Band = { startSeconds: number; color: string };
  const initial = [{ startSeconds: 6, color: '#004488' }, { startSeconds: 0, color: '#993311' }];
  const harness = settingsHarness({ countdownColorBands: initial });
  const setColor = (seconds: number, color: string) => harness.applyPatch(settings => ({
    countdownColorBands: (settings.countdownColorBands as Band[]).map(band =>
      band.startSeconds === seconds ? { ...band, color } : band),
  }));
  const first = setColor(6, '#111111');
  const second = setColor(0, '#222222');
  const third = setColor(6, '#333333');
  await Promise.resolve();
  harness.patchRequests[0]!.pending.reject(new Error('refused'));
  assert.equal(await first, 'failed');
  await Promise.resolve();
  assert.deepEqual(harness.patchRequests[1]!.patch.countdownColorBands,
    [initial[0], { ...initial[1], color: '#222222' }]);
  harness.patchRequests[1]!.pending.resolve();
  assert.equal(await second, 'saved');
  await Promise.resolve();
  harness.patchRequests[2]!.pending.resolve();
  assert.equal(await third, 'saved');
  assert.deepEqual(harness.project.settings.countdownColorBands,
    [{ ...initial[0], color: '#333333' }, { ...initial[1], color: '#222222' }]);
});

test('device edits keep the acknowledged project setting until the engine accepts the new route', async () => {
  const harness = settingsHarness({ defaultOutputDevice: 'Running output' });
  const pending = harness.applyPatch({ defaultOutputDevice: 'Cold output' });
  await Promise.resolve();
  assert.equal(harness.project.settings.defaultOutputDevice, 'Running output');
  harness.patchRequests[0]!.pending.reject(new Error('Device open canceled'));
  assert.equal(await pending, 'failed');
  assert.equal(harness.project.settings.defaultOutputDevice, 'Running output');

  const retry = harness.applyPatch({ defaultOutputDevice: 'Cold output' });
  await Promise.resolve();
  assert.equal(harness.project.settings.defaultOutputDevice, 'Running output');
  harness.patchRequests[1]!.pending.resolve();
  assert.equal(await retry, 'saved');
  assert.equal(harness.project.settings.defaultOutputDevice, 'Cold output');
});

test('a refused cue device change preserves the running route and skips the save', async () => {
  const filename = new URL('../app/components/PropertiesPanel.vue', import.meta.url);
  const script = parse(readFileSync(filename, 'utf8')).descriptor.scriptSetup!.content;
  const ast = ts.createSourceFile('PropertiesPanel.ts', script, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.filter(ts.isVariableStatement)
    .flatMap(node => [...node.declarationList.declarations])
    .find(node => node.name.getText(ast) === 'onDeviceOverrideChange');
  assert.ok(declaration);
  const code = ts.transpileModule('const ' + declaration.getText(ast), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const cue = { uuid: 'cue', deviceOverride: 'Running output' };
  const pending = deferred<void>();
  let saves = 0;
  const factory = Function('deps', `
    const { audioItem, currentProject, audioDeviceOverride, deviceOverrideEditPending,
      _server, t, endItemBatch, persistPropertyChanges, handleSave } = deps;
    ${code}
    return onDeviceOverrideChange;
  `);
  const server = { updateProjectItem: () => pending.promise, lastError: '' };
  const change = factory({
    audioItem: { value: cue }, currentProject: { value: {} },
    audioDeviceOverride: { value: cue.deviceOverride }, deviceOverrideEditPending: { value: false },
    _server: server, t: (key: string) => key,
    endItemBatch: async () => {}, persistPropertyChanges: () => { ++saves; }, handleSave: () => { ++saves; },
  });
  const select = { value: 'Cold output' };
  const result = change({ target: select });
  assert.equal(cue.deviceOverride, 'Running output');
  assert.equal(saves, 0);
  pending.reject(new Error('Device open canceled'));
  await result;
  assert.equal(cue.deviceOverride, 'Running output');
  assert.equal(select.value, 'Running output');
  assert.equal(saves, 0);
  assert.equal(server.lastError, 'properties.deviceOverrideFailed');
});
test('does not start a save after the current project changes during PATCH', async () => {
  const harness = settingsHarness({ defaultTransitionMode: 'crossfade' });
  let saveCalls = 0;
  harness.setSaveProject(async () => {
    saveCalls++;
    return true;
  });

  const pending = harness.applyPatch({ defaultTransitionMode: 'start-next' });
  await Promise.resolve();
  const replacement = { settings: { defaultTransitionMode: 'crossfade' } };
  harness.currentProject.value = replacement;
  harness.patchRequests[0]!.pending.resolve();

  assert.equal(await pending, 'saved');
  assert.equal(saveCalls, 0);
  assert.deepEqual(replacement.settings, { defaultTransitionMode: 'crossfade' });
  assert.equal(harness.settingsError.value, '');
});

test('does not save or report against a replacement project', async () => {
  const harness = settingsHarness({ disableLimiter: false });
  const save = deferred<boolean>();
  let saveCalls = 0;
  harness.setSaveProject(() => {
    saveCalls++;
    return save.promise;
  });

  const pending = harness.applyPatch({ disableLimiter: true });
  await Promise.resolve();
  harness.patchRequests[0]!.pending.resolve();
  await Promise.resolve();
  assert.equal(saveCalls, 1);

  const replacement = { settings: { disableLimiter: false } };
  harness.currentProject.value = replacement;
  save.resolve(false);

  assert.equal(await pending, 'saved');
  assert.deepEqual(replacement.settings, { disableLimiter: false });
  assert.equal(harness.settingsError.value, '');
});

test('keeps a server-accepted setting live when the disk save is unsaved', async () => {
  const harness = settingsHarness({ cycleTrackColors: false });
  harness.setSaveProject(async () => false);

  const pending = harness.applyPatch({ cycleTrackColors: true });
  await Promise.resolve();
  harness.patchRequests[0]!.pending.resolve();

  assert.equal(await pending, 'unsaved');
  assert.equal(harness.project.settings.cycleTrackColors, true);
  assert.equal(harness.settingsError.value, 'project.unsavedChanges');
});

function spotifySettingsHarness() {
  const filename = new URL('../app/components/SpotifyImportModal.vue', import.meta.url);
  const script = parse(readFileSync(filename, 'utf8')).descriptor.scriptSetup!.content;
  const ast = ts.createSourceFile('SpotifyImportModal.ts', script, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'persistProjectSetting');
  assert.ok(fn);
  const code = ts.transpileModule(fn.getText(ast), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const project = { settings: { defaultTransitionMode: 'crossfade', keep: 'original' } as Record<string, unknown> };
  const currentProject = { value: project as typeof project | null };
  const patch = deferred<void>();
  const saving = { value: false };
  const error = { value: '' };
  let saveCalls = 0;
  let save = async () => true;
  const persist = Function('currentProject', 'isSavingSettings', 'settingsSaveError', 'server', 'saveProject', 't',
    `${code}; return persistProjectSetting;`)(currentProject, saving, error,
    { patchSettings: () => patch.promise }, () => { saveCalls++; return save(); }, (key: string) => key);
  return { project, currentProject, patch, saving, error, persist,
    get saveCalls() { return saveCalls; }, setSave(next: () => Promise<boolean>) { save = next; } };
}

test('Spotify settings cannot roll back or save a replacement show after PATCH settles', async () => {
  for (const reject of [false, true]) {
    for (const close of [false, true]) {
      const h = spotifySettingsHarness();
      const pending = h.persist({ defaultTransitionMode: 'start-next' });
      const replacement = { settings: { keep: 'replacement' } };
      h.currentProject.value = close ? null : replacement;
      if (reject) h.patch.reject(new Error('PATCH refused')); else h.patch.resolve();
      await pending;
      assert.deepEqual(replacement.settings, { keep: 'replacement' });
      assert.equal(h.saveCalls, 0);
      assert.equal(h.error.value, '');
      assert.equal(h.saving.value, false);
    }
  }
});

test('Spotify keeps accepted live settings on save failure and only rolls back rejected keys', async () => {
  for (const failure of ['patch', 'save-false', 'save-throw']) {
    const h = spotifySettingsHarness();
    h.setSave(async () => { if (failure === 'save-throw') throw new Error('disk unavailable'); return false; });
    const pending = h.persist({ defaultTransitionMode: 'start-next', newSetting: true });
    h.project.settings.keep = 'concurrent change';
    if (failure === 'patch') h.patch.reject(new Error('PATCH refused')); else h.patch.resolve();
    await pending;
    assert.equal(h.project.settings.defaultTransitionMode, failure === 'patch' ? 'crossfade' : 'start-next');
    assert.equal('newSetting' in h.project.settings, failure !== 'patch');
    assert.equal(h.project.settings.keep, 'concurrent change');
    assert.ok(h.error.value);
    assert.equal(h.saving.value, false);
  }
});

test('Spotify save completion cannot report an error on the next show', async () => {
  const h = spotifySettingsHarness();
  const save = deferred<boolean>();
  h.setSave(() => save.promise);
  const pending = h.persist({ defaultTransitionMode: 'start-next' });
  h.patch.resolve();
  await Promise.resolve();
  assert.equal(h.saveCalls, 1);
  h.currentProject.value = { settings: { keep: 'next show' } };
  save.resolve(false);
  await pending;
  assert.deepEqual(h.currentProject.value.settings, { keep: 'next show' });
  assert.equal(h.error.value, '');
});
