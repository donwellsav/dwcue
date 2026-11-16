'use strict';

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
  // A slide stays lossless; a photograph or a film frame is kept small as a JPEG.
  if (png.length && png.length <= 1024 * 1024) {
    return 'data:image/png;base64,' + png.toString('base64');
  }
  const jpeg = still.toJPEG(94);
  if (!jpeg.length) throw new Error('The captured picture could not be encoded.');
  return 'data:image/jpeg;base64,' + jpeg.toString('base64');
}

module.exports = { findCaptureCue, captureImageUrl };
