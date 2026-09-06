import assert from 'node:assert/strict';
import test from 'node:test';

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
