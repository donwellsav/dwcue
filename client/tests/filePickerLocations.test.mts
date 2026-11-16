import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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

const projectContext = pickerLocationContext('file', '.dwcue');

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

test('native pickers leave the operator window enabled and authorize one selection at a time', async (t) => {
  const folder = await mkdtemp(path.join(tmpdir(), 'dwcue-picker-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const cases = new Map([
    ['select-project-folder', { selected: folder, authorization: 'root' }],
    ['select-project-file', { selected: path.join(folder, 'Show.dwcue'), authorization: 'project' }],
  ]);
  const source = ts.createSourceFile('main.js',
    fs.readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const code = source.statements.filter(node => {
    if (ts.isVariableStatement(node)) {
      return node.declarationList.declarations.some(decl =>
        ['nativeFilePickerOpen', 'mediaPickerExtensions'].includes(decl.name.getText(source)));
    }
    if (ts.isFunctionDeclaration(node)) {
      return ['showNativeFilePicker', 'rememberNativePickerFolder', 'writeImportPreferences',
        'authorizeOpenableFilePath'].includes(node.name?.text || '');
    }
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return false;
    const [channel] = node.expression.arguments;
    return node.expression.expression.getText(source) === 'ipcMain.handle'
      && channel && ts.isStringLiteral(channel) && (cases.has(channel.text) || channel.text === 'scan-media-folder');
  }).map(node => node.getText(source)).join('\n');

  const handlers = new Map<string, (event?: unknown, input?: string) => Promise<unknown>>();
  const authorized: Array<[string, string, boolean]> = [];
  const warnings: string[] = [];
  const authorize = (kind: string) => (file: string, options?: { allowMissing?: boolean }) => {
    authorized.push([kind, file, options?.allowMissing === true]);
    return file;
  };
  let selected = '';
  let canceled = false;
  let hold: Promise<void> | undefined;
  let unreadable = '';
  let mode = 'local';
  const choose = async (...args: unknown[]) => {
    assert.equal(args.length, 1, 'passing an operator window disables it during native file selection');
    assert.ok(args[0] && typeof args[0] === 'object');
    await hold;
    return { canceled, filePaths: [selected] };
  };
  runInNewContext(code, {
    ...createRequire(import.meta.url)('../electron/project-file-formats.js'),
    path, mainWindow: {}, ipcMain: { handle: handlers.set.bind(handlers) },
    requireTrustedIpc() {}, nativePickerFolder() {},
    readLiveplayConfig: () => ({ mode }),
    requireAbsoluteIpcPath: (file: string) => {
      if (!path.isAbsolute(file)) throw new TypeError('Expected an absolute path');
      return file;
    },
    dialog: { showOpenDialog: choose },
    fs: {
      promises: { readdir: (dir: string, options: { withFileTypes: true }) => {
        if (dir === unreadable) return Promise.reject(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));
        return readdir(dir, options);
      } },
      existsSync: () => true,
      statSync: () => ({ isFile: () => true }),
      writeFileSync() { throw new Error('Folder history is read-only'); },
    },
    pathCapabilities: { authorizeRoot: authorize('root'), authorizeProjectFile: authorize('project'), authorizeFile: authorize('file') },
    readImportPreferences: () => ({ pickerFolders: {} }),
    importPreferencesPath: () => '/isolated/import-preferences.json',
    unsavedImportPreferences: null,
    console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')) },
  });
  for (const [channel, item] of cases) {
    selected = item.selected;
    const pick = handlers.get(channel);
    assert.ok(pick, channel);
    const result = await pick();
    assert.deepEqual(Array.isArray(result) ? [...result] : [result], [selected], channel);
    assert.deepEqual(authorized.pop(), [item.authorization, selected, false], channel);
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
    const overlapping = handlers.get('select-project-file')!();
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

  const nested = path.join(folder, 'Video');
  await mkdir(nested);
  const media = ['Cue 2.WAV', 'Cue 10.wav', path.join('Video', 'Opening.mp4')];
  await Promise.all([...media, '.Hidden.wav', 'notes.pdf'].map(name => writeFile(path.join(folder, name), 'fixture')));
  const scanMediaFolder = (dir: string) => handlers.get('scan-media-folder')!({}, dir);
  unreadable = path.join(folder, 'Unavailable');
  await mkdir(unreadable);
  await writeFile(path.join(unreadable, 'Skipped.wav'), 'fixture');
  const batch = await scanMediaFolder(folder) as { name: string; files: string[]; skippedFolders: string[] };
  assert.equal(batch.name, path.basename(folder));
  assert.deepEqual([...batch.files], media.map(name => path.join(folder, name)));
  assert.deepEqual([...batch.skippedFolders], ['Unavailable']);
  unreadable = folder;
  await assert.rejects(scanMediaFolder(folder), /Permission denied/);
  await assert.rejects(scanMediaFolder('relative'), /absolute path/);
  mode = 'remote';
  await assert.rejects(scanMediaFolder(folder), /requires the local audio engine/);
});

test('docked archive download validates the folder and publishes only complete, non-overwriting files', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'dwcue-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = await realpath(root);
  const droppedFolder = path.join(folder, 'Dropped');
  await mkdir(droppedFolder);
  const source = fs.readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  let length = 6;
  let deletes = 0;
  let fallback = false;
  runInNewContext(source.slice(source.indexOf('const archiveDownloadFolders'),
    source.indexOf("ipcMain.handle('copy-file'")), {
    ...createRequire(import.meta.url)('../electron/project-file-formats.js'),
    crypto, path, Buffer, URL, Transform, Readable, pipeline, AbortSignal,
    fs: { ...fs, promises: { ...fs.promises, link(from: string, to: string) {
      if (fallback) throw Object.assign(new Error('Hard links unavailable'), { code: 'ENOTSUP' });
      return fs.promises.link(from, to);
    } } },
    MAX_ARCHIVE_DOWNLOAD_BYTES: 1024,
    ipcMain: { handle: handlers.set.bind(handlers) },
    app: { getPath: () => root },
    requireTrustedIpc() {},
    requireBoundedIpcObject: (value: unknown) => value,
    requireAbsoluteIpcPath: (value: string) => value,
    requireIpcString: (value: string) => value,
    fetch: async (_url: URL, opts: { method?: string }) => {
      if (opts.method === 'DELETE') {
        deletes++;
        return new Response(null, { status: 204 });
      }
      return new Response('backup', { headers: { 'content-length': String(length) } });
    },
  });

  const selectFolder = handlers.get('archive-download-folder')!;
  const download = handlers.get('download-archive-to-file')!;
  const request = { folder, filename: 'Show', token: 'a'.repeat(64), baseUrl: 'http://127.0.0.1' };
  assert.match((await download({}, request)).error, /Choose a download folder/);
  assert.equal(await selectFolder({}), folder);
  assert.match((await download({}, { ...request, filename: '../outside' })).error, /valid archive filename/);
  const existing = path.join(folder, 'Show.dwcuepack');
  await writeFile(existing, 'original');
  assert.match((await download({}, request)).error, /already exists/);
  assert.equal(await readFile(existing, 'utf8'), 'original');
  await assert.rejects(selectFolder({}, existing), /Choose a folder/);

  assert.equal(await selectFolder({}, droppedFolder), droppedFolder);
  length = 7;
  assert.match((await download({}, { ...request, folder: droppedFolder })).error, /incomplete/);
  assert.deepEqual(await readdir(droppedFolder), []);
  assert.equal(deletes, 0);
  length = 6;
  fallback = true;
  const saved = await download({}, { ...request, folder: droppedFolder, filename: 'Show.DWCUEPACK' });
  assert.equal(saved.path, path.join(droppedFolder, 'Show.dwcuepack'));
  assert.equal(await readFile(saved.path, 'utf8'), 'backup');
  assert.deepEqual(await readdir(droppedFolder), ['Show.dwcuepack']);
  assert.deepEqual((await readdir(folder)).sort(), ['Dropped', 'Show.dwcuepack']);
  assert.equal(deletes, 1);
});
