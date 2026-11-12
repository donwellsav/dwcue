const path = require('node:path');

const SPOTIFY_REVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const SPOTIFY_BITRATES = new Set(['192k', '256k', '320k']);
const SPOTIFY_AUDIO_PROVIDERS = Object.freeze([
  'youtube-music',
  'youtube',
  'soundcloud',
  'bandcamp',
]);

function normalizeSpotifyBitrate(value) {
  return SPOTIFY_BITRATES.has(value) ? value : '320k';
}

function renewSpotifyReview(review, now = Date.now()) {
  review.expiresAt = now + SPOTIFY_REVIEW_TTL_MS;
  return review;
}

function spotifyReviewIsValid(review, senderId, url, now = Date.now()) {
  return !!review && review.senderId === senderId && review.url === url && review.expiresAt >= now;
}

function normalizeSpotifyTrackIds(value) {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((id) => typeof id === 'string' && /^[A-Za-z0-9]{10,64}$/.test(id));
  return ids.length === value.length && new Set(ids).size === ids.length ? ids : null;
}

function spotifyContentParts(parsed) {
  if (parsed.hostname !== 'open.spotify.com') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (/^intl-[a-z]{2}(?:-[a-z]{2})?$/i.test(parts[0] || '')) parts.shift();
  if (parts.length !== 2 ||
      !['track', 'album', 'playlist', 'artist'].includes(parts[0]) ||
      !/^[A-Za-z0-9]{10,64}$/.test(parts[1])) {
    return null;
  }
  return { type: parts[0], id: parts[1] };
}

function validatedSpotifyUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password) {
    throw new TypeError('A valid Spotify HTTPS URL is required');
  }
  if (parsed.hostname === 'open.spotify.com') {
    if (!spotifyContentParts(parsed)) {
      throw new TypeError('Use a Spotify track, album, playlist, or artist URL');
    }
  } else if (
    !['spotify.link', 'spotify.app.link'].includes(parsed.hostname) ||
    !/^\/[A-Za-z0-9_-]{3,128}\/?$/.test(parsed.pathname)
  ) {
    throw new TypeError('Use a Spotify share URL');
  }
  parsed.hash = '';
  return parsed.toString();
}

function normalizeSpotifyRecovery(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) return null;
  const paths = [
    value.activeProjectFolderPath,
    value.destinationParentPath,
    value.projectFolderPath,
  ];
  if (paths.some((item) => typeof item !== 'string' || !path.isAbsolute(item))) return null;
  if (typeof value.url !== 'string') return null;
  let url;
  try { url = validatedSpotifyUrl(value.url); } catch { return null; }
  const selectedTrackIds = normalizeSpotifyTrackIds(value.selectedTrackIds);
  const completedTrackIds = normalizeSpotifyTrackIds(value.completedTrackIds);
  const failedTrackIds = normalizeSpotifyTrackIds(value.failedTrackIds);
  const pendingTrackIds = normalizeSpotifyTrackIds(value.pendingTrackIds || []);
  if (!selectedTrackIds || !completedTrackIds || !failedTrackIds || !pendingTrackIds) return null;
  const projectFolderPath = path.normalize(value.projectFolderPath);
  if (!Array.isArray(value.pendingFiles) || value.pendingFiles.length !== pendingTrackIds.length ||
      value.pendingFiles.some((filePath) => {
        if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return true;
        const relative = path.relative(projectFolderPath, path.normalize(filePath));
        return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
      })) {
    return null;
  }
  const selected = new Set(selectedTrackIds);
  if ([...completedTrackIds, ...failedTrackIds, ...pendingTrackIds].some((id) => !selected.has(id))) {
    return null;
  }
  const statuses = [...completedTrackIds, ...failedTrackIds, ...pendingTrackIds];
  if (new Set(statuses).size !== statuses.length) return null;
  if (!Number.isSafeInteger(value.total) || value.total < 1 ||
      !Number.isSafeInteger(value.completed) || value.completed < 0 ||
      value.completed > value.total) return null;
  if (typeof value.playlistName !== 'string' || !value.playlistName.trim() ||
      value.playlistName.length > 500) return null;
  if (value.groupUuid !== undefined &&
      (typeof value.groupUuid !== 'string' || value.groupUuid.length > 128)) return null;
  return {
    version: 1,
    activeProjectFolderPath: path.normalize(value.activeProjectFolderPath),
    destinationParentPath: path.normalize(value.destinationParentPath),
    projectFolderPath,
    url,
    playlistName: value.playlistName.trim(),
    audioBitrate: normalizeSpotifyBitrate(value.audioBitrate),
    selectedTrackIds,
    completedTrackIds,
    failedTrackIds,
    pendingTrackIds,
    pendingFiles: value.pendingFiles.map((filePath) => path.normalize(filePath)),
    total: value.total,
    completed: value.completed,
    ...(value.groupUuid ? { groupUuid: value.groupUuid } : {}),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
  };
}

module.exports = {
  SPOTIFY_AUDIO_PROVIDERS,
  SPOTIFY_REVIEW_TTL_MS,
  normalizeSpotifyBitrate,
  normalizeSpotifyRecovery,
  normalizeSpotifyTrackIds,
  renewSpotifyReview,
  spotifyContentParts,
  spotifyReviewIsValid,
  validatedSpotifyUrl,
};
