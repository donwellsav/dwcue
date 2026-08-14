const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

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

console.log('Spotify import reliability checks passed.');
