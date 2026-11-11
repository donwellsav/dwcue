import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import {
  createFilePickerLocationStore,
  pickerLocationContext,
  pickerParentPath,
  resolvePickerStartPath,
  type FilePickerLocationStorage,
} from '../app/composables/useFilePickerLocations';

class MemoryStorage implements FilePickerLocationStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const projectContext = pickerLocationContext('file', '.dwcue,.liveplay');

test('restores the last successful folder after a new store instance without crossing server or picker scopes', () => {
  const storage = new MemoryStorage();
  const firstRun = createFilePickerLocationStore(storage);
  const endpointWithCredential = 'https://cue.example:4480/?access_token=do-not-persist';

  firstRun.rememberFolder(
    endpointWithCredential,
    projectContext,
    '/Users/operator/Documents/dw cue 1/shows/',
  );
  firstRun.rememberFolder(endpointWithCredential, 'media', '/Volumes/Media/Act One');

  const restarted = createFilePickerLocationStore(storage);
  const projectState = restarted.read('https://cue.example:4480');
  assert.equal(projectState.lastFolders[projectContext], '/Users/operator/Documents/dw cue 1/shows');
  assert.equal(projectState.lastFolders.media, '/Volumes/Media/Act One');
  assert.deepEqual(restarted.read('https://another.example:4480'), {
    favorites: [],
    lastFolders: {},
  });
  assert.equal([...storage.values.keys()].some(key => key.includes('do-not-persist')), false);
});

test('honors explicit start paths, including an explicit computer root, before remembered and fallback paths', () => {
  assert.equal(resolvePickerStartPath('/requested/show', '/remembered/show', '/fallback/show'), '/requested/show');
  assert.equal(resolvePickerStartPath('', '/remembered/show', '/fallback/show'), '');
  assert.equal(resolvePickerStartPath(undefined, '/remembered/show', '/fallback/show'), '/remembered/show');
  assert.equal(resolvePickerStartPath(undefined, undefined, '/fallback/show'), '/fallback/show');
  assert.equal(resolvePickerStartPath(undefined, '', '/fallback/show'), '');
});

test('persists favorite add and remove operations without truncation or endpoint leakage', () => {
  const storage = new MemoryStorage();
  const endpoint = 'http://127.0.0.1:4480/';
  const firstRun = createFilePickerLocationStore(storage);
  const favorites = Array.from({ length: 60 }, (_, index) => `/Volumes/Shows/Favorite ${index + 1}`);

  for (const favorite of favorites) firstRun.addFavorite(endpoint, favorite);
  firstRun.addFavorite(endpoint, `${favorites[0]}/`);

  const restarted = createFilePickerLocationStore(storage);
  assert.deepEqual(restarted.read('http://127.0.0.1:4480').favorites, favorites);

  restarted.removeFavorite(endpoint, favorites[25]);
  const afterRemoval = createFilePickerLocationStore(storage).read(endpoint).favorites;
  assert.equal(afterRemoval.length, 59);
  assert.equal(afterRemoval.includes(favorites[25]), false);
  assert.deepEqual(createFilePickerLocationStore(storage).read('http://127.0.0.1:4481').favorites, []);
});

test('derives native media selection folders for POSIX and Windows paths', () => {
  assert.equal(pickerParentPath('/Users/operator/Documents/dw cue 1/media/intro.wav'), '/Users/operator/Documents/dw cue 1/media');
  assert.equal(pickerParentPath('D:\\Shows\\Act One\\intro.wav'), 'D:\\Shows\\Act One');
});

test('native pickers leave the operator window enabled and authorize one selection at a time', async () => {
  const folder = path.join(tmpdir(), 'dwcue-picker');
  const cases = new Map([
    ['select-project-folder', { selected: folder, authorization: 'root' }],
    ['select-project-file', { selected: path.join(folder, 'Show.dwcue'), authorization: 'project' }],
    ['select-audio-files', { selected: path.join(folder, 'Cue.wav'), authorization: 'file' }],
    ['show-open-archive-dialog', { selected: path.join(folder, 'Show.dwcuepack'), authorization: 'file' }],
    ['show-save-archive-dialog', { selected: path.join(folder, 'Backup'), authorization: 'file' }],
  ]);
  const source = ts.createSourceFile('main.js',
    readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const code = source.statements.filter(node => {
    if (ts.isVariableStatement(node)) {
      return node.declarationList.declarations.some(decl => decl.name.getText(source) === 'nativeFilePickerOpen');
    }
    if (ts.isFunctionDeclaration(node)) {
      return ['showNativeFilePicker', 'rememberNativePickerFolder', 'authorizeOpenableFilePath'].includes(node.name?.text || '');
    }
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return false;
    const [channel] = node.expression.arguments;
    return node.expression.expression.getText(source) === 'ipcMain.handle'
      && channel && ts.isStringLiteral(channel) && cases.has(channel.text);
  }).map(node => node.getText(source)).join('\n');

  const handlers = new Map<string, () => Promise<string | string[] | null>>();
  const authorized: Array<[string, string, boolean]> = [];
  const warnings: string[] = [];
  const authorize = (kind: string) => (file: string, options?: { allowMissing?: boolean }) => {
    authorized.push([kind, file, options?.allowMissing === true]);
    return file;
  };
  let selected = '';
  let canceled = false;
  let hold: Promise<void> | undefined;
  const choose = async (saving: boolean, ...args: unknown[]) => {
    assert.equal(args.length, 1, 'passing an operator window disables it during native file selection');
    assert.ok(args[0] && typeof args[0] === 'object');
    await hold;
    return saving ? { canceled, filePath: selected } : { canceled, filePaths: [selected] };
  };
  runInNewContext(code, {
    ...createRequire(import.meta.url)('../electron/project-file-formats.js'),
    path, mainWindow: {}, ipcMain: { handle: handlers.set.bind(handlers) },
    requireTrustedIpc() {}, nativePickerFolder() {}, requireAbsoluteIpcPath: (file: string) => file,
    dialog: {
      showOpenDialog: (...args: unknown[]) => choose(false, ...args),
      showSaveDialog: (...args: unknown[]) => choose(true, ...args),
    },
    fs: { existsSync: () => true, statSync: () => ({ isFile: () => true }) },
    pathCapabilities: { authorizeRoot: authorize('root'), authorizeProjectFile: authorize('project'), authorizeFile: authorize('file') },
    readImportPreferences: () => ({ pickerFolders: {} }),
    writeImportPreferences() { throw new Error('Folder history is read-only'); },
    console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')) },
  });
  for (const [channel, item] of cases) {
    selected = item.selected;
    const pick = handlers.get(channel);
    assert.ok(pick, channel);
    const saving = channel === 'show-save-archive-dialog';
    const expected = saving ? `${selected}.dwcuepack` : selected;
    const result = await pick();
    assert.deepEqual(Array.isArray(result) ? [...result] : [result], [expected], channel);
    assert.deepEqual(authorized.pop(), [item.authorization, expected, saving], channel);
    canceled = true;
    assert.equal(await pick(), null, channel);
    canceled = false;
  }
  assert.equal(authorized.length, 0);
  assert.equal(warnings.length, cases.size);
  assert.ok(warnings.every(message => message.includes('Folder history is read-only')));

  let finish!: () => void;
  hold = new Promise<void>(resolve => { finish = resolve; });
  selected = folder;
  const first = handlers.get('select-project-folder')!();
  try {
    const overlapping = handlers.get('show-save-archive-dialog')!();
    const pending = new Promise(resolve => setImmediate(() => resolve('pending')));
    assert.equal(await Promise.race([overlapping, pending]), null);
  } finally {
    finish();
    await first;
  }
  assert.deepEqual(authorized, [['root', folder, false]]);

  const chooseFolder = handlers.get('select-project-folder')!;
  hold = Promise.reject(new Error('Native panel could not open'));
  await assert.rejects(chooseFolder(), /Native panel could not open/);
  hold = undefined;
  assert.equal(await chooseFolder(), folder, 'a native failure must release the picker for a retry');
});
