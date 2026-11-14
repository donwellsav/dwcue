'use strict';

const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

function createStandbyCaptureStore(maxBytes = MAX_CAPTURE_BYTES) {
  let session = null;
  let standby = null;
  let bytes = 0;
  const cues = new Map();

  function reset() {
    session = standby = null;
    bytes = 0;
    cues.clear();
  }

  function put(sessionId, itemUuid, media, url) {
    if (session !== sessionId) reset();
    const previous = itemUuid ? cues.get(itemUuid)?.url : standby;
    const nextBytes = bytes - (previous?.length ?? 0) + url.length;
    if (nextBytes > maxBytes) throw new Error('Session capture storage is full. Clear a captured still before capturing another.');
    session = sessionId;
    if (itemUuid) cues.set(itemUuid, { media, url });
    else standby = url;
    bytes = nextBytes;
  }

  function remove(sessionId, itemUuid) {
    if (session !== sessionId) return;
    if (itemUuid) {
      bytes -= cues.get(itemUuid)?.url.length ?? 0;
      cues.delete(itemUuid);
    } else {
      bytes -= standby?.length ?? 0;
      standby = null;
    }
  }

  function read(sessionId, itemUuid, media) {
    if (session !== sessionId) return { standby: null, cue: null };
    const entry = cues.get(itemUuid);
    return { standby, cue: entry && entry.media === media ? entry.url : null };
  }

  return { reset, put, remove, read };
}

function findCaptureCue(project, uuid) {
  const lists = [project?.items, project?.cartOnlyItems];
  while (lists.length) {
    const items = lists.pop();
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item?.uuid === uuid && item.type === 'audio') return item;
      if (Array.isArray(item?.children)) lists.push(item.children);
    }
  }
  return null;
}

function captureImageUrl(image) {
  if (!image || image.isEmpty()) throw new Error('No picture was captured. Check that the source is visible and capture is permitted.');
  const { width, height } = image.getSize();
  const scale = Math.min(1, 1920 / width, 1080 / height);
  const still = scale < 1 ? image.resize({
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    quality: 'best',
  }) : image;
  const png = still.toPNG();
  // shortcut: keep small captures lossless within the session memory budget; use disk-backed stills if the bank needs more.
  if (png.length && png.length <= 1024 * 1024) {
    return 'data:image/png;base64,' + png.toString('base64');
  }
  const jpeg = still.toJPEG(94);
  if (!jpeg.length) throw new Error('The captured picture could not be encoded.');
  return 'data:image/jpeg;base64,' + jpeg.toString('base64');
}

module.exports = { createStandbyCaptureStore, findCaptureCue, captureImageUrl };
