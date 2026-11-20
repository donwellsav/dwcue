import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { createProjectOpenGuard } from '../app/utils/projectOpenGuard';

test('cancel and failed saves retain the current project without opening the target', async () => {
  const opened: string[] = [];
  let allow = false;
  const guard = createProjectOpenGuard({
    async confirmUnsavedChanges() { return allow; },
    async openProject(path) { opened.push(path); return true; },
    onOpenFailed() { assert.fail('open failure callback must not run on cancel'); },
  });
  assert.equal(await guard('/shows/b.dwcue'), false);
  assert.deepEqual(opened, []);
  allow = true;
  assert.equal(await guard('/shows/b.dwcue'), true);
  assert.deepEqual(opened, ['/shows/b.dwcue']);
});

test('duplicate and raced selections cannot switch to an uncaptured target', async () => {
  let release!: (value: boolean) => void;
  const confirmation = new Promise<boolean>(resolve => { release = resolve; });
  const opened: string[] = [];
  const guard = createProjectOpenGuard({
    confirmUnsavedChanges: () => confirmation,
    async openProject(path) { opened.push(path); return true; },
    onOpenFailed() {},
  });
  const first = guard('/shows/b.dwcue');
  const duplicate = guard('/shows/b.dwcue');
  const raced = guard('/shows/c.dwcue');
  assert.equal(first, duplicate);
  assert.equal(await raced, false);
  release(true);
  assert.equal(await first, true);
  assert.deepEqual(opened, ['/shows/b.dwcue']);
});

test('false open result is surfaced exactly once', async () => {
  const failures: string[] = [];
  const guard = createProjectOpenGuard({
    async confirmUnsavedChanges() { return true; },
    async openProject() { return false; },
    onOpenFailed(path) { failures.push(path); },
  });
  assert.equal(await guard('/shows/b.dwcue'), false);
  assert.deepEqual(failures, ['/shows/b.dwcue']);
});

test('archive Open rechecks its originating show after the save prompt', async () => {
  let release!: (value: boolean) => void;
  const confirmation = new Promise<boolean>(resolve => { release = resolve; });
  let sameShow = true;
  const guard = createProjectOpenGuard({
    confirmUnsavedChanges: () => confirmation,
    async openProject() { assert.fail('a stale archive must not switch shows'); },
    onOpenFailed() { assert.fail('a withdrawn open is not a failed file'); },
  });
  const pending = guard('/shows/extracted.dwcue', () => sameShow);
  sameShow = false;
  release(true);
  assert.equal(await pending, false);
});

test('New and Open menu cancellation and a rejected recent file keep the active show', async () => {
  const menu = ['onMenuNewProject', 'onMenuOpenProject', 'onMenuOpenRecentProject'];
  const callbacks = new Map<string, (...args: any[]) => unknown>();
  const bindings: string[] = [];
  for (const file of ['app.vue', 'components/MainWorkspace.vue']) {
    const source = readFileSync(new URL(`../app/${file}`, import.meta.url), 'utf8');
    const script = parse(source).descriptor.scriptSetup!.content;
    const ast = ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const find = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          menu.includes(node.expression.name.text)) bindings.push(node.getText(ast));
      ts.forEachChild(node, find);
    };
    find(ast);
  }
  const running = { folderPath: '/shows/live' };
  const currentProject = { value: running as typeof running | null };
  const dialogs: string[] = [];
  const failures: string[] = [];
  const guardedOpenProject = createProjectOpenGuard({
    async confirmUnsavedChanges() { return true; },
    async openProject(path) {
      if (path !== '/shows/valid.dwcue') return false;
      currentProject.value = { folderPath: '/shows/valid' };
      return true;
    },
    onOpenFailed(path) { failures.push(path); },
  });
  const dependencies = {
    window: { electronAPI: Object.fromEntries(menu.map(name => [name, (fn: () => void) => callbacks.set(name, fn)])) },
    currentProject, guardedOpenProject, projectFileDialogOpen: { value: false },
    showNewProjectDialog: (path: string) => dialogs.push(`new:${path}`),
    showOpenProjectPicker: (path: string) => dialogs.push(`open:${path}`),
    confirmUnsavedChanges: async () => true,
    closeProject: async () => { currentProject.value = null; },
  };
  const compiled = ts.transpileModule(bindings.join(';\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies));
  await callbacks.get('onMenuNewProject')!();
  assert.equal(currentProject.value, running, 'New menu must leave the current show open');
  await callbacks.get('onMenuOpenProject')!();
  assert.equal(currentProject.value, running, 'Open menu must leave the current show open');
  assert.deepEqual(dialogs, ['new:/shows/live', 'open:/shows/live']);
  await callbacks.get('onMenuOpenRecentProject')!(null, '/shows/broken.dwcue');
  assert.equal(currentProject.value, running);
  assert.deepEqual(failures, ['/shows/broken.dwcue']);
  await callbacks.get('onMenuOpenRecentProject')!(null, '/shows/valid.dwcue');
  assert.equal(currentProject.value?.folderPath, '/shows/valid');
});

test('switching shows while something plays asks first, before the unsaved-changes choice', async () => {
  const asked: string[] = [];
  const opened: string[] = [];
  let keepPlaying = true;
  const guard = createProjectOpenGuard({
    async confirmStopPlayback() { asked.push('playing'); return !keepPlaying; },
    async confirmUnsavedChanges() { asked.push('unsaved'); return true; },
    async openProject(path) { opened.push(path); return true; },
    onOpenFailed() { assert.fail('keeping the show playing is not a failed open'); },
  });
  assert.equal(await guard('/shows/b.dwcue'), false, 'Keep playing leaves the show running');
  assert.deepEqual(asked, ['playing'], 'nothing else is asked once the operator keeps playing');
  assert.deepEqual(opened, []);
  keepPlaying = false;
  asked.length = 0;
  assert.equal(await guard('/shows/b.dwcue'), true);
  assert.deepEqual(asked, ['playing', 'unsaved']);
  assert.deepEqual(opened, ['/shows/b.dwcue']);
});

test('the operator window asks before Open, a double-clicked show file and New Show replace a playing show', () => {
  const app = readFileSync(new URL('../app/app.vue', import.meta.url), 'utf8');
  assert.match(app, /function confirmStopPlayback\(\): Promise<boolean> \{\s*if \(useAudioEngine\(\)\.activeCues\.value\.size === 0\) return Promise\.resolve\(true\);/,
    'nothing playing: no question');
  assert.match(app, /createProjectOpenGuard\(\{\s*confirmStopPlayback,/, 'every guarded open asks');
  assert.match(app, /'create', async \(\) => \{\s*if \(!await confirmStopPlayback\(\)\) return false;/, 'New Show asks');
  assert.match(app, /if \(replacePlayingVisible\.value\) return \{[\s\S]*?key: 'keep'[\s\S]*?variant: 'primary'[\s\S]*?key: 'switch'[\s\S]*?variant: 'danger'/,
    'Keep playing is the primary choice; switching is marked as the dangerous one');
  for (const code of ['ar', 'bn', 'de', 'el', 'en', 'es', 'fa', 'fr', 'hi', 'it', 'ja', 'ko', 'no', 'pt', 'ro', 'ru', 'sq', 'sv', 'tr', 'ur', 'zh']) {
    const messages = JSON.parse(readFileSync(new URL(`../locales/${code}.json`, import.meta.url), 'utf8'));
    for (const key of ['title', 'message', 'keep', 'switch']) assert.ok(messages.replacePlaying?.[key], `${code} replacePlaying.${key}`);
  }
});
