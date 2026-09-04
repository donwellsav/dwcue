const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function loadTypeScriptModule(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require,
  }, { filename: relativePath });
  return module.exports;
}

const { canonicalSpotifyMediaReference } = loadTypeScriptModule(
  'client/app/utils/spotifyImport.ts',
);
const {
  SPOTIFY_AUDIO_PROVIDERS,
  SPOTIFY_REVIEW_TTL_MS,
  normalizeSpotifyRecovery,
  normalizeSpotifyBitrate,
  renewSpotifyReview,
  spotifyReviewIsValid,
} = require('../client/electron/spotify-import-reliability');

assert.deepEqual(
  [...SPOTIFY_AUDIO_PROVIDERS],
  ['youtube-music', 'youtube', 'soundcloud', 'bandcamp'],
  'Spotify matching must fall back beyond YouTube Music while preserving provider confidence checks',
);

assert.deepEqual(
  { ...canonicalSpotifyMediaReference('/Music/Conference Playlist/media/Artist - Song.mp3') },
  {
    mediaFileName: 'Artist - Song.mp3',
    mediaPath: '',
    mediaServerPath: '/Music/Conference Playlist/media/Artist - Song.mp3',
  },
  'Spotify cues must reference the selected collection media instead of creating a second copy',
);
assert.deepEqual(
  { ...canonicalSpotifyMediaReference('C:\\Music\\Conference Playlist\\media\\Artist - Song.mp3') },
  {
    mediaFileName: 'Artist - Song.mp3',
    mediaPath: '',
    mediaServerPath: 'C:\\Music\\Conference Playlist\\media\\Artist - Song.mp3',
  },
  'canonical Spotify media references must work on Windows 11 paths',
);

const now = Date.UTC(2026, 7, 14, 12, 0, 0);
const review = renewSpotifyReview({ senderId: 7, url: 'https://open.spotify.com/playlist/abc' }, now);
assert.equal(review.expiresAt, now + SPOTIFY_REVIEW_TTL_MS);
assert.equal(
  spotifyReviewIsValid(review, 7, review.url, now + (3 * 60 * 60 * 1000)),
  true,
  'a reviewed large playlist must remain retryable after a multi-hour download',
);
assert.equal(
  spotifyReviewIsValid(review, 8, review.url, now + 1),
  false,
  'a review must remain bound to the renderer that created it',
);
assert.equal(normalizeSpotifyBitrate('256k'), '256k');
assert.equal(normalizeSpotifyBitrate('lossless'), '320k');

const recovery = normalizeSpotifyRecovery({
  version: 1,
  activeProjectFolderPath: '/Projects/Show',
  destinationParentPath: '/Music/Spotify',
  projectFolderPath: '/Music/Spotify/Conference Playlist',
  url: 'https://open.spotify.com/playlist/abc1234567',
  playlistName: 'Conference Playlist',
  audioBitrate: '256k',
  selectedTrackIds: ['track0000001', 'track0000002', 'track0000003'],
  completedTrackIds: ['track0000001'],
  failedTrackIds: ['track0000002'],
  pendingTrackIds: ['track0000003'],
  pendingFiles: ['/Music/Spotify/Conference Playlist/media/Artist - Pending.mp3'],
  total: 3,
  completed: 1,
  groupUuid: 'group-1',
  updatedAt: now,
});
assert.equal(recovery.failedTrackIds[0], 'track0000002');
assert.equal(recovery.pendingTrackIds[0], 'track0000003');
assert.equal(recovery.pendingFiles[0], '/Music/Spotify/Conference Playlist/media/Artist - Pending.mp3');
assert.equal(recovery.groupUuid, 'group-1');
assert.equal(recovery.audioBitrate, '256k');
assert.equal(
  normalizeSpotifyRecovery({ ...recovery, projectFolderPath: 'relative/path' }),
  null,
  'recovery state must reject non-absolute media folders',
);
assert.equal(
  normalizeSpotifyRecovery({
    ...recovery,
    pendingFiles: ['/Music/Other Collection/media/Artist - Pending.mp3'],
  }),
  null,
  'recovery state must not attach a pending file from outside its collection folder',
);
assert.equal(
  normalizeSpotifyRecovery({
    ...recovery,
    pendingTrackIds: ['track0000001'],
  }),
  null,
  'a track cannot be both completed and pending',
);

// Exercise the production tracked-process implementation without network access
// or real timers. Parsing the initializer avoids matching a particular wrapper.
function trackedProcessHarness() {
  const source = ts.createSourceFile('main.js',
    fs.readFileSync(path.join(root, 'client/electron/main.js'), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const initializers = [];
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'runTracked') {
      initializers.push(node.initializer.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(initializers.length, 1, 'the production tracked runner must be unambiguous');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const job = { children: new Set() };
  const calls = [];
  const timers = new Map();
  const terminated = [];
  const run = vm.runInNewContext(initializers[0], {
    spawn: (...args) => { calls.push(args); return child; },
    stagingDir: '/isolated-staging', env: {}, process: { platform: 'darwin' }, job,
    setTimeout: (callback, delay) => { timers.set(1, { callback, delay }); return 1; },
    clearTimeout: (timer) => timers.delete(timer),
    terminateSpotifyChild: (tracked) => terminated.push(tracked),
  });
  return { run, child, job, calls, timers, terminated };
}

test('Spotify tools receive literal argv and release tracked children on completion', async () => {
  const harness = trackedProcessHarness();
  const args = ['url', 'https://open.spotify.com/track/example;$(not-a-command)', '--audio', 'youtube'];
  const lines = [];
  const result = harness.run('/tools/spot dl', args, 1000, (line) => lines.push(line));
  assert.equal(harness.calls[0][0], '/tools/spot dl');
  assert.equal(harness.calls[0][1], args, 'arguments must not be joined into a shell command');
  assert.notEqual(harness.calls[0][2].shell, true, 'a shell must never interpret imported arguments');
  assert.equal(harness.job.children.has(harness.child), true);
  harness.child.stdout.emit('data', Buffer.from('one\ntw'));
  harness.child.stdout.emit('data', Buffer.from('o\n'));
  harness.child.emit('close', 0, null);
  const completed = await result;
  assert.equal(completed.code, 0);
  assert.deepEqual(lines, ['one', 'two']);
  assert.equal(harness.job.children.size, 0);
  assert.equal(harness.timers.size, 0);
});

test('Spotify tool spawn errors reject and release cancellation tracking', async () => {
  const harness = trackedProcessHarness();
  const result = harness.run('/missing/helper', [], 1000);
  harness.child.emit('error', new Error('ENOENT'));
  await assert.rejects(result, /ENOENT/);
  assert.equal(harness.job.children.size, 0);
  assert.equal(harness.timers.size, 0);
});

test('Spotify tool deadlines terminate the tracked child and settle on exit', async () => {
  const harness = trackedProcessHarness();
  const result = harness.run('/tools/spotdl', [], 1000);
  assert.equal(harness.timers.get(1).delay, 1000);
  harness.timers.get(1).callback();
  assert.deepEqual(harness.terminated, [harness.child]);
  harness.child.emit('close', null, 'SIGTERM');
  assert.equal((await result).signal, 'SIGTERM');
  assert.equal(harness.job.children.size, 0);
  assert.equal(harness.timers.size, 0);
});

console.log('Spotify import reliability checks passed.');
