import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';

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
  return buildApplyPatch(dependencies) as (patch: Record<string, unknown>) => Promise<string>;
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
  const harness = settingsHarness({ autoTrimSilenceOnImport: false });

  const first = harness.applyPatch({ autoTrimSilenceOnImport: true });
  await Promise.resolve();
  assert.equal(harness.project.settings.autoTrimSilenceOnImport, true);
  assert.equal(harness.patchRequests.length, 1);

  const second = harness.applyPatch({ autoTrimSilenceOnImport: false });
  await Promise.resolve();
  assert.equal(harness.patchRequests.length, 1, 'second edit must wait for the first acknowledgement');

  harness.patchRequests[0]!.pending.reject(new Error('first rejected'));
  assert.equal(await first, 'failed');
  await Promise.resolve();
  assert.equal(harness.patchRequests.length, 2);
  assert.equal(harness.project.settings.autoTrimSilenceOnImport, false);

  harness.patchRequests[1]!.pending.reject(new Error('second rejected'));
  assert.equal(await second, 'failed');
  assert.equal(harness.project.settings.autoTrimSilenceOnImport, false);
  assert.equal(harness.settingsError.value, 'second rejected');
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
