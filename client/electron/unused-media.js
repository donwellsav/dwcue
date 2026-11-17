'use strict';

// Which files in a show's media folder nothing uses any more.
//
// Converting a video leaves the original beside the copy, and every screen
// capture is saved as its own picture, so a show's media folder fills up with
// files no cue points at. This works out which they are. It only reads what it
// is given: main.js reads the folder and the documents, and moves the files
// the operator picks to the Trash.
//
// The rule is deliberately blunt. A file is in use when its NAME appears
// anywhere in any string of any document that could bring it back: the show as
// it is open now, the show file on disk, every backup, any other show saved in
// the same folder. A path can only point at a file through that file's name,
// so this covers "media/x.wav", an absolute path, a Windows path and a bare
// file name alike, without trusting how a path written on another computer
// would resolve on this one. It also keeps a file that merely shares its name
// with something a cue links to elsewhere. When in doubt the file stays.

const path = require('node:path');

// A conversion or an upload may still be writing a file this young.
const TOO_NEW_MS = 2 * 60 * 1000;
// Documents that can hold references to media.
const SHOW_DOCUMENT = /\.(?:dwcue|liveplay)$/i;
// A show, or an archive of one, that has ended up in the media folder is not media.
const NEVER_MEDIA = /\.(?:dwcue|dwcuepack|liveplay|part)$/i;

/** Names compare without regard to letter case or to how an accent is encoded. */
const fold = (text) => text.normalize('NFC').toLowerCase();

/** A bare file name: nothing that could step into, or out of, a folder. */
function isPlainFileName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 &&
    !/[\\/\0]/.test(name) && name !== '.' && name !== '..';
}

const isShowDocument = (name) => typeof name === 'string' && SHOW_DOCUMENT.test(name);

/** <show folder>/media: the one folder this ever looks in. Null without a show folder. */
function mediaFolderFor(showFolder) {
  if (typeof showFolder !== 'string' || !path.isAbsolute(showFolder)) return null;
  return path.join(path.resolve(showFolder), 'media');
}

/**
 * Where a named file in the show's media folder is. Null for anything but a
 * bare name, so nothing outside that one folder can ever be addressed.
 */
function mediaFilePath(showFolder, name) {
  const folder = mediaFolderFor(showFolder);
  if (!folder || !isPlainFileName(name)) return null;
  const target = path.join(folder, name);
  return path.dirname(target) === folder && path.basename(target) === name ? target : null;
}

function addText(references, raw) {
  if (references.seen.has(raw)) return;
  references.seen.add(raw);
  references.haystack = null;
  const forms = [raw];
  // A reference written as a URL spells a space as %20.
  if (raw.includes('%')) {
    const decoded = raw.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try { return decodeURIComponent(run); } catch { return run; }
    });
    if (decoded !== raw) forms.push(decoded);
  }
  for (const form of forms) {
    const text = fold(form);
    references.text.push(text);
    // The usual case, a path ending in the name, is found without searching.
    for (const segment of text.split(/[\\/]/)) references.names.add(segment);
  }
}

/**
 * Everything the documents say, ready to be asked about a file name. A
 * document is parsed JSON, or the plain text of a file that would not parse.
 * Every string is read, and every key: nothing is assumed about which fields
 * hold a file. Pass `references` to add to an earlier collection.
 */
function collectReferences(documents, references = { seen: new Set(), names: new Set(), text: [], haystack: null }) {
  const pending = [...documents];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') {
      addText(references, value);
    } else if (Array.isArray(value)) {
      for (const child of value) {
        if (typeof child === 'string' || (child && typeof child === 'object')) pending.push(child);
      }
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        addText(references, key);
        if (typeof child === 'string' || (child && typeof child === 'object')) pending.push(child);
      }
    }
  }
  return references;
}

/** True when the file name appears anywhere in what was collected. */
function isReferenced(references, name) {
  const wanted = fold(name);
  if (references.names.has(wanted)) return true;
  // NUL cannot be in a file name, so a name never matches across two strings.
  references.haystack ??= references.text.join('\0');
  return references.haystack.includes(wanted);
}

function isCandidate(file, now) {
  if (!file || file.isFile !== true || !isPlainFileName(file.name)) return false;
  // Hidden files belong to the operating system, not to the show.
  if (file.name.startsWith('.') || NEVER_MEDIA.test(file.name)) return false;
  const changed = Math.max(file.modifiedAt, file.changedAt ?? file.modifiedAt);
  // A file dated in the future is treated as new: its age cannot be known.
  return Number.isFinite(file.size) && Number.isFinite(changed) && now - changed >= TOO_NEW_MS;
}

/**
 * The files in the media folder that nothing refers to.
 *
 * `files` is what is directly inside <show folder>/media, each as
 * { name, size, modifiedAt, changedAt, isFile } with times in milliseconds;
 * `changedAt` is the latest of every time the file system keeps, so a file
 * copied in a moment ago with an old date still counts as new. Give
 * `documents`, or `references` already collected from them.
 */
function findUnusedMedia({ files, documents = [], references = collectReferences(documents), now }) {
  if (!Number.isFinite(now)) throw new TypeError('now must be a time in milliseconds');
  const unused = [];
  const listed = new Set();
  for (const file of files) {
    if (!isCandidate(file, now) || listed.has(file.name) || isReferenced(references, file.name)) continue;
    listed.add(file.name);
    unused.push({ name: file.name, size: file.size, modifiedAt: file.modifiedAt });
  }
  return unused;
}

module.exports = {
  TOO_NEW_MS, collectReferences, findUnusedMedia, isPlainFileName, isReferenced, isShowDocument,
  mediaFilePath, mediaFolderFor,
};
