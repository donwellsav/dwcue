const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { EventEmitter } = require('node:events');
const { pipeline } = require('node:stream/promises');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const electronSource = ts.createSourceFile('main.js',
  fs.readFileSync(path.join(root, 'client/electron/main.js'), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

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
  normalizeSpotifyTrackIds,
  normalizeSpotifyBitrate,
  renewSpotifyReview,
  spotifyContentParts,
  spotifyReviewIsValid,
  validatedSpotifyUrl,
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
for (const host of ['spotify.link', 'spotify.app.link']) {
  const url = `https://${host}/Share12345`;
  assert.equal(normalizeSpotifyRecovery({ ...recovery, url: url + '#fragment' })?.url, url);
}
for (const url of [
  'https://spotify.link.example.test/Share12345',
  'https://user@spotify.link/Share12345',
  'https://spotify.app.link:8443/Share12345',
  'https://open.spotify.com/episode/0123456789ABCDEFGHIJKL',
]) {
  assert.equal(normalizeSpotifyRecovery({ ...recovery, url }), null);
}
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
  const source = electronSource;
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

function spotifyHandler(channel, context) {
  const channels = Array.isArray(channel) ? channel : [channel];
  const helpers = new Set([
    'spotifyTrackId',
    'spotifyEmbedCoverUrl', 'spotifyEmbedArtists', 'spotifyEmbedDate',
    'fetchSpotifyEmbedTracks', 'sanitizeSpotifyFolderName', 'summarizeSpotDlError',
    'requireBoundedIpcObject', 'releaseYouTubeJob', 'cancelYouTubeDownload',
    'createSpotifyProjectFolder', 'spotifyOutputTrackId', 'orderedSpotifyOutputs',
    'copySpotifyOutputsToMedia', 'cleanupSpotifyFiles', 'releaseSpotifyJob',
    'importPreferencesPath', 'readImportPreferences', 'writeImportPreferences',
  ]);
  const handlers = new Map();
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(electronSource) === 'ipcMain.handle' &&
        channels.includes(node.arguments[0]?.text)) {
      handlers.set(node.arguments[0].text, node.arguments[1].getText(electronSource));
    }
    ts.forEachChild(node, visit);
  };
  visit(electronSource);
  assert.equal(handlers.size, channels.length);
  const declarations = electronSource.statements.filter(node =>
    ts.isFunctionDeclaration(node) && helpers.has(node.name?.text) && !Object.hasOwn(context, node.name.text));
  const handler = Array.isArray(channel)
    ? `{${[...handlers].map(([name, code]) => `${JSON.stringify(name)}: ${code}`).join(',')}}`
    : handlers.get(channel);
  return vm.runInNewContext(
    declarations.map(node => node.getText(electronSource)).join('\n') + `\n(${handler})`,
    { URL, AbortSignal, Buffer, path, process, crypto: require('node:crypto'),
      renewSpotifyReview, spotifyContentParts, spotifyReviewIsValid, validatedSpotifyUrl, normalizeSpotifyBitrate,
      normalizeSpotifyRecovery, normalizeSpotifyTrackIds, unsavedImportPreferences: null,
      requireTrustedIpc() {},
      requireIpcString(value) { assert.equal(typeof value, 'string'); return value; },
      requireAuthorizedIpcPath(value) { return value; },
      ...context },
  );
}

test('failed preference writes keep the selected Spotify destination and the latest recovery state for this session', () => {
  let preferences = { spotifyRecovery: recovery };
  let writable = false;
  const handlers = spotifyHandler([
    'get-import-preferences', 'set-spotify-import-destination', 'clear-spotify-import-recovery',
  ], {
    app: { getPath: () => '/user-data' },
    fs: {
      readFileSync: () => JSON.stringify(preferences),
      writeFileSync(_path, value) {
        if (!writable) throw new Error('Preferences are read-only');
        preferences = JSON.parse(value);
      },
      existsSync: () => true,
      statSync: file => ({ isDirectory: () => !file.endsWith('.mp3'), isFile: () => file.endsWith('.mp3') }),
    },
    pathCapabilities: { authorizeRoot: folder => folder, authorizeFile: file => file },
    console: { warn() {} },
  });
  const event = {};
  const choose = handlers['set-spotify-import-destination'];
  const get = handlers['get-import-preferences'];
  assert.throws(() => choose(event, '/Music/invalid.mp3'), /must be a directory/);
  assert.equal(choose(event, '/Music/New Destination'), false);
  assert.equal(get(event).spotifyDestination, '/Music/New Destination');
  assert.equal(get(event).preferencesSaved, false);
  assert.equal(get(event).spotifyRecovery.url, recovery.url);
  assert.equal(handlers['clear-spotify-import-recovery'](event, recovery.activeProjectFolderPath), false);
  assert.equal(get(event).spotifyRecovery, null);
  assert.ok(preferences.spotifyRecovery);
  writable = true;
  assert.equal(choose(event, '/Music/Final Destination'), true);
  assert.equal(get(event).preferencesSaved, true);
  assert.equal(preferences.spotifyRecovery, null);
});

function youtubeDownloadHarness(overrides = {}) {
  const sender = new EventEmitter();
  sender.id = 17;
  sender.isDestroyed = () => false;
  const progress = [];
  sender.send = (...args) => progress.push(args);
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const jobs = new Map();
  const spawns = [], timers = [], detachedErrors = [];
  const fakeFs = { existsSync: () => true, mkdirSync() {}, readdirSync: () => [], unlinkSync() {}, renameSync() {} };
  const context = {
    fs: fakeFs, activeYouTubeDownloads: jobs,
    waitForYtDlp: async () => {}, setupFfmpeg: async () => true,
    denoReady: true, denoPath: '/mock/deno', ffmpegPath: '/mock/ffmpeg', ytDlpPath: '/mock/yt-dlp',
    spawn: (...args) => { spawns.push(args); return child; },
    setTimeout: callback => { timers.push(callback); return { unref() {} }; },
    isPidAlive: () => false,
    console: { log() {}, warn() {}, error() {} },
    // Observe ignored async-executor rejections without creating an unhandled
    // rejection in node:test; leave the production task's settlement unchanged.
    Promise: function (executor) {
      return new Promise((resolve, reject) => {
        const ignored = executor(resolve, reject);
        if (ignored?.catch) ignored.catch(error => detachedErrors.push(error));
      });
    },
    ...overrides,
  };
  const event = { sender };
  const jobId = 'youtube-test-job';
  return { sender, child, jobs, spawns, timers, detachedErrors, fakeFs, progress,
    start: () => {
      const pending = spotifyHandler('download-youtube-audio', context)(event, jobId, 'abcdefghi', 'Test', '/mock/show', 'video');
      pending.catch(() => {});
      return pending;
    },
    cancel: () => spotifyHandler('cancel-youtube-download', context)(event, jobId),
  };
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
async function youtubeOutcome(pending) {
  return Promise.race([
    pending.then(value => ({ status: 'resolved', value }), error => ({ status: 'rejected', message: error.message })),
    nextTurn().then(() => ({ status: 'pending' })),
  ]);
}
function assertYouTubeReleased(h) {
  assert.equal(h.jobs.size, 0);
  for (const name of ['destroyed', 'render-process-gone', 'did-start-navigation'])
    assert.equal(h.sender.listenerCount(name), 0);
  assert.equal(h.detachedErrors.length, 0);
}

for (const stage of ['mkdir', 'readdir', 'ffmpeg']) {
  test(`YouTube ${stage} initialization failure rejects IPC and releases its job`, async () => {
    const h = youtubeDownloadHarness(stage === 'ffmpeg' ? {
      setupFfmpeg: async () => { throw new Error('mock setup failure'); },
    } : {});
    if (stage === 'mkdir') {
      h.fakeFs.existsSync = () => false;
      h.fakeFs.mkdirSync = () => { throw new Error('mock mkdir failure'); };
    }
    if (stage === 'readdir') h.fakeFs.readdirSync = () => { throw new Error('mock readdir failure'); };
    const outcome = await youtubeOutcome(h.start());
    assert.equal(outcome.status, 'rejected');
    assert.match(outcome.message, /mock .*failure/);
    assert.equal(h.spawns.length, 0);
    assertYouTubeReleased(h);
  });
}

for (const stage of ['ffmpeg', 'deno']) {
  test(`YouTube cancellation during ${stage} preparation never spawns yt-dlp afterward`, async () => {
    let finishFfmpeg;
    const h = youtubeDownloadHarness(stage === 'ffmpeg' ? {
      setupFfmpeg: () => new Promise(resolve => { finishFfmpeg = resolve; }),
    } : { denoReady: false });
    const pending = h.start();
    await nextTurn();
    assert.equal(await h.cancel(), true);
    finishFfmpeg?.(true);
    for (let i = 0; i < 16; i++) {
      h.timers.shift()?.();
      await nextTurn();
    }
    const outcome = await youtubeOutcome(pending);
    assert.equal(h.spawns.length, 0);
    assert.equal(outcome.status, 'rejected');
    assert.match(outcome.message, /cancelled/);
    assertYouTubeReleased(h);
  });
}

test('YouTube successful and cancelled child completion both release the job', async () => {
  for (const cancel of [false, true]) {
    const h = youtubeDownloadHarness();
    const pending = h.start();
    await nextTurn();
    assert.equal(h.spawns.length, 1);
    if (cancel) await h.cancel();
    h.child.emit('close', 0);
    const outcome = await youtubeOutcome(pending);
    assert.equal(outcome.status, cancel ? 'rejected' : 'resolved');
    if (!cancel) assert.equal(outcome.value.success, true);
    assertYouTubeReleased(h);
  }
});

test('YouTube buffered progress cannot send to a renderer after its exit cancels the job', async () => {
  const h = youtubeDownloadHarness();
  const pending = h.start();
  await nextTurn();
  h.sender.emit('destroyed');
  h.sender.isDestroyed = () => true;
  h.sender.send = () => { throw new Error('renderer destroyed'); };
  assert.doesNotThrow(() => h.child.stdout.emit('data', Buffer.from('[download] 30%')));
  h.child.emit('close', 0);
  assert.equal((await youtubeOutcome(pending)).status, 'rejected');
  assertYouTubeReleased(h);
});

test('YouTube output-directory read failure at child completion rejects without escaping the callback', async () => {
  const h = youtubeDownloadHarness();
  const pending = h.start();
  await nextTurn();
  h.fakeFs.existsSync = () => false;
  h.fakeFs.readdirSync = () => { throw new Error('mock disconnected media directory'); };
  assert.doesNotThrow(() => h.child.emit('close', 0));
  const outcome = await youtubeOutcome(pending);
  assert.equal(outcome.status, 'rejected');
  assert.match(outcome.message, /disconnected media directory/);
  assertYouTubeReleased(h);
});

function spotifyReviewHarness(count, {
  kind = 'playlist', exitCode = 0, failedStdout = '',
  failedStderr = 'Error: playlist metadata unavailable', ffmpegReady = true, reverseResults = false,
} = {}) {
  const rawTracks = Array.from({ length: count }, (_, index) => ({
    song_id: String(index).padStart(22, '0'), name: `Track ${index + 1}`,
    artists: ['Artist'], duration: 60, list_name: 'Entire playlist', list_position: index + 1,
    url: `https://open.spotify.com/track/${String(index).padStart(22, '0')}`,
  }));
  const canonicalUrl = `https://open.spotify.com/${kind}/0123456789ABCDEFGHIJKL`;
  const fetches = [], commands = [];
  const activeSpotifyPreflightJobs = new Map(), spotifyPreflights = new Map();
  const sender = new EventEmitter();
  sender.id = 7;
  const run = spotifyHandler('spotify-preflight', {
    activeSpotifyPreflightJobs, spotifyPreflights, spotDlPath: '/tools/spotdl',
    console: { warn() {} }, setupSpotDl: async () => true, terminateSpotifyChild() {},
    ffmpegPath: '/tools/bundled ffmpeg/ffmpeg', setupFfmpeg: async () => ffmpegReady,
    setTimeout: () => ({ unref() {} }), clearTimeout() {},
    async fetch(url) {
      fetches.push(String(url));
      if (new URL(url).hostname !== 'open.spotify.com') return {
        headers: { get: () => canonicalUrl }, body: { cancel: async () => {} },
      };
      const embedTracks = rawTracks.slice(0, 100).map(track => track && ({
        uri: `spotify:track:${track.song_id}`, title: track.name,
        artists: track.artists, duration: track.duration * 1000,
      }));
      const entity = kind === 'track'
        ? { ...embedTracks[0], type: kind }
        : { type: kind, title: 'Preview only', trackList: embedTracks };
      return { ok: true, text: async () => '<script id="__NEXT_DATA__">' + JSON.stringify({
        props: { pageProps: { state: { data: { entity } } } },
      }) + '</script>' };
    },
    spawn(binary, args) {
      commands.push([binary, [...args]]);
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => {
        const result = reverseResults ? [...rawTracks].reverse() : rawTracks;
        child.stdout.emit('data', Buffer.from(exitCode ? failedStdout : JSON.stringify(result)));
        child.stderr.emit('data', Buffer.from(exitCode ? failedStderr : ''));
        child.emit('close', exitCode);
      });
      return child;
    },
  });
  return { run: url => run({ sender }, 'review-job-12345', url || canonicalUrl), rawTracks,
    canonicalUrl, commands, fetches, activeSpotifyPreflightJobs, spotifyPreflights, sender };
}

for (const count of [100, 235, 10001]) {
  test(`Spotify review returns all ${count} playlist tracks instead of its 100-track embed`, async () => {
    const harness = spotifyReviewHarness(count);
    const review = await harness.run();
    assert.equal(review.tracks.length, count);
    assert.deepEqual([...review.tracks.map(track => track.id)], harness.rawTracks.map(track => track.song_id));
    assert.equal(review.totalDuration, count * 60);
    assert.equal(review.playlistName, 'Entire playlist');
    assert.deepEqual(harness.commands, [['/tools/spotdl', [
      'save', harness.canonicalUrl, '--save-file', '-', '--ffmpeg', '/tools/bundled ffmpeg/ffmpeg',
      '--threads', '8', '--audio', 'youtube', '--lyrics',
    ]]]);
    assert.equal(harness.fetches.length, 0, 'playlist embeds cannot prove that their track list is complete');
    assert.equal(harness.spotifyPreflights.get(review.preflightId).tracksById.size, count);
    assert.equal(harness.activeSpotifyPreflightJobs.size, 0);
  });
}

test('Spotify review restores playlist order after concurrent metadata lookups', async () => {
  const harness = spotifyReviewHarness(235, { reverseResults: true });
  const review = await harness.run();
  const expected = harness.rawTracks.map(track => track.song_id);
  assert.deepEqual([...review.tracks.map(track => track.id)], expected);
  assert.deepEqual([...harness.spotifyPreflights.get(review.preflightId).tracksById.keys()], expected);
});

test('Spotify review skips unusable rows and keeps the remaining tracks in order', async () => {
  for (const kind of ['playlist', 'album']) {
    const harness = spotifyReviewHarness(5, { kind, reverseResults: true });
    const [first, , , fourth] = harness.rawTracks;
    harness.rawTracks[1] = null;
    harness.rawTracks[2] = { name: 'Missing track ID' };
    harness.rawTracks[4] = { ...first, name: 'Repeated entry', list_position: 5 };
    const review = await harness.run();
    assert.equal(review.skippedTrackCount, 2);
    assert.deepEqual(Array.from(review.tracks, track => [track.id, track.title]),
      [[first.song_id, first.name], [fourth.song_id, fourth.name]]);
    assert.equal(review.totalDuration, 120);
    if (kind === 'album') assert.equal(harness.commands.length, 0);
  }
});

test('Spotify reports a clear error when no usable tracks remain', async () => {
  const harness = spotifyReviewHarness(2);
  harness.rawTracks.splice(0, 2, null, { song_id: 'invalid' });
  await assert.rejects(harness.run(), /no usable tracks/);
  assert.equal(harness.spotifyPreflights.size, 0);
});

test('Spotify keeps the first appearance and skips repeated selections without failing the import', async (t) => {
  const harness = spotifyReviewHarness(4, { reverseResults: true });
  const [first, second, , unavailable] = harness.rawTracks;
  second.name = first.name;
  const secondUrl = second.url;
  second.url = null;
  second.artists = null;
  harness.rawTracks[2] = { ...first, name: 'Repeated entry', list_position: 3 };
  const url = 'https://spotify.link/Share12345';
  const review = await harness.run(url);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dwcue-spotify-repeat-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const activeSpotifyDownloads = new Map();
  const matched = [], downloaded = [];
  const preferencesPath = path.join(folder, 'import-preferences.json');
  let writable = true;
  const run = spotifyHandler('download-spotify-audio', {
    fs: {
      ...fs,
      writeFileSync(file, value) {
        if (!writable && file === preferencesPath) throw new Error('Preferences are read-only');
        fs.writeFileSync(file, value);
      },
    },
    pipeline, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    app: { getPath: () => folder }, activeSpotifyDownloads,
    spotifyPreflights: harness.spotifyPreflights,
    sendSpotifyProgress() {}, setupSpotDl: async () => true, setupFfmpeg: async () => true,
    spotDlPath: '/tools/spotdl', ytDlpPath: '/tools/yt-dlp', ffmpegPath: '/tools/ffmpeg',
    denoInitialization: Promise.resolve(), denoReady: false, SPOTIFY_AUDIO_PROVIDERS,
    console: { warn() {} },
    spawn(binary, args) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        if (binary === '/tools/spotdl' && args.includes('MATCH')) {
          for (const url of args.slice(1, args.indexOf('--audio'))) {
            matched.push(url);
            if (url === unavailable.url) continue;
            const id = url.split('/').pop();
            child.stdout.emit('data', Buffer.from(`[${id}] Returning best result https://example.test/${id}\n`));
          }
        } else if (binary === '/tools/yt-dlp') {
          const id = args.at(-1).split('/').pop();
          downloaded.push(id);
          fs.writeFileSync(args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp3'), id);
        }
        child.emit('close', 0);
      });
      return child;
    },
  });
  const selection = {
    activeProjectFolderPath: folder, preflightId: review.preflightId,
    selectedTrackIds: [first.song_id, second.song_id, first.song_id, unavailable.song_id],
  };
  const result = await run({ sender: harness.sender }, 'download-job-12345', url, folder, selection);
  assert.deepEqual([...review.tracks.map(track => track.spotifyUrl)], [first.url, secondUrl, unavailable.url]);
  assert.equal(review.tracks[0].title, first.name);
  assert.equal(review.totalDuration, 180);
  assert.deepEqual(matched, [first.url, secondUrl, unavailable.url]);
  assert.deepEqual(downloaded.sort(), [first.song_id, second.song_id].sort());
  assert.equal(result.total, 3);
  assert.equal(result.completed, 2);
  assert.deepEqual([...result.completedTrackIds], [first.song_id, second.song_id]);
  assert.deepEqual([...result.failedTrackIds], [unavailable.song_id]);
  assert.deepEqual(Array.from(result.files, file => fs.readFileSync(file, 'utf8')), [first.song_id, second.song_id]);
  const recovery = normalizeSpotifyRecovery(JSON.parse(fs.readFileSync(preferencesPath, 'utf8')).spotifyRecovery);
  assert.equal(recovery.url, url);
  assert.deepEqual([...recovery.selectedTrackIds], [first.song_id, second.song_id, unavailable.song_id]);
  assert.deepEqual([...recovery.pendingTrackIds], [first.song_id, second.song_id]);
  assert.deepEqual([...recovery.pendingFiles], [...result.files]);
  const finalize = spotifyHandler('finalize-spotify-import', { activeSpotifyDownloads });
  assert.equal(await finalize({ sender: harness.sender }, 'download-job-12345', true), true);

  writable = false;
  const unsaved = await run({ sender: harness.sender }, 'download-job-23456', url, folder, selection);
  assert.equal(unsaved.preferencesSaved, false);
  assert.deepEqual(Array.from(unsaved.files, file => fs.readFileSync(file, 'utf8')), [first.song_id, second.song_id]);
  assert.equal(await finalize({ sender: harness.sender }, 'download-job-23456', true), true);
});

test('Spotify playlist share links resolve to the full metadata query', async () => {
  for (const host of ['spotify.link', 'spotify.app.link']) {
    const harness = spotifyReviewHarness(235);
    const review = await harness.run(`https://${host}/Share12345`);
    assert.equal(review.tracks.length, 235);
    assert.equal(harness.commands[0][1][1], harness.canonicalUrl);
    assert.equal(harness.fetches.length, 1, 'only the validated share redirect is fetched');
  }
});

test('a failed full Spotify playlist review never returns a successful truncated preview', async () => {
  const harness = spotifyReviewHarness(235, { exitCode: 1 });
  await assert.rejects(harness.run(), /playlist metadata unavailable/);
  assert.equal(harness.spotifyPreflights.size, 0);
  assert.equal(harness.activeSpotifyPreflightJobs.size, 0);
});

test('Spotify review reports the downloader error from stdout past the PyInstaller footer', async () => {
  const harness = spotifyReviewHarness(235, {
    exitCode: 1,
    failedStdout: 'FFmpegError: FFmpeg is not installed.\n',
    failedStderr: "[PYI-42:ERROR] Failed to execute script '__main__' due to unhandled exception!\n",
  });
  await assert.rejects(harness.run(), { message: 'FFmpegError: FFmpeg is not installed.' });
});

test('Spotify review reports an unavailable FFmpeg before spawning the downloader', async () => {
  const harness = spotifyReviewHarness(235, { ffmpegReady: false });
  await assert.rejects(harness.run(), /FFmpeg is unavailable/);
  assert.equal(harness.commands.length, 0);
  assert.equal(harness.activeSpotifyPreflightJobs.size, 0);
});

test('individual Spotify track review keeps its complete embed fast path', async () => {
  const harness = spotifyReviewHarness(1, { kind: 'track' });
  const review = await harness.run();
  assert.equal(review.tracks.length, 1);
  assert.equal(review.tracks[0].id, harness.rawTracks[0].song_id);
  assert.equal(harness.commands.length, 0);
});

test('large Spotify reviews remain selectable for download and recoverable', async () => {
  const harness = spotifyReviewHarness(10001);
  const { preflightId, tracks } = await harness.run();
  const selectedTrackIds = tracks.map(track => track.id);
  const run = spotifyHandler('download-spotify-audio', {
    fs: { statSync: () => ({ isDirectory: () => true }) },
    spotifyPreflights: harness.spotifyPreflights,
    activeSpotifyDownloads: { has: () => true },
  });
  // The existing-job boundary follows selection validation, before any I/O.
  await assert.rejects(run({ sender: harness.sender }, 'download-job-12345', harness.canonicalUrl, '/Music', {
    activeProjectFolderPath: '/Projects/Show', preflightId, selectedTrackIds,
  }), /Spotify job already exists/);
  const largeRecovery = normalizeSpotifyRecovery({
    ...recovery, selectedTrackIds, completedTrackIds: [], failedTrackIds: selectedTrackIds,
    pendingTrackIds: [], pendingFiles: [], total: tracks.length, completed: 0,
  });
  assert.equal(largeRecovery?.selectedTrackIds.length, tracks.length);
});

test('large Spotify downloads match every selected track in bounded batches with at most four processes', async () => {
  const source = electronSource.text;
  const start = source.indexOf('      let lastMatchActivity = Date.now();');
  const end = source.indexOf('\n      if (!job.cancelled) {', start);
  let pool;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(electronSource) === 'runPool') {
      pool = node.initializer.getText(electronSource);
    }
    ts.forEachChild(node, visit);
  };
  visit(electronSource);
  assert.ok(start >= 0 && end > start && pool);
  const { tracks: selectedTracks } = await spotifyReviewHarness(10001).run();
  const batches = [];
  let active = 0, peakActive = 0;
  const run = vm.runInNewContext(`(async () => {
    const runPool = ${pool};
    ${source.slice(start, end)}
  })`, {
    total: selectedTracks.length, selectedTracks, job: { cancelled: false },
    path, stagingDir: '/isolated-staging', spotDlPath: '/tools/spotdl', SPOTIFY_AUDIO_PROVIDERS,
    matchedUrls: [], onMatchLine() {}, progress() {},
    setInterval: () => 1, clearInterval() {}, terminateSpotifyChild() {}, console,
    async runTracked(_command, args) {
      batches.push([...args.slice(1, args.indexOf('--audio'))]);
      peakActive = Math.max(peakActive, ++active);
      await new Promise(resolve => setImmediate(resolve));
      --active;
    },
  });
  await run();
  assert.ok(batches.every(batch => batch.length <= 100), 'batch argv must fit Windows command-line limits');
  assert.equal(peakActive, 4, 'batch count must not create unbounded helper processes');
  assert.deepEqual(batches.flat(), Array.from(selectedTracks, track => track.spotifyUrl));
});

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
