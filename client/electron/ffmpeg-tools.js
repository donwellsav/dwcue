'use strict';

// ffmpeg and ffprobe for the YouTube and Spotify importers.
//
// The installer used to carry a second copy of FFmpeg (the audio engine has
// its own) just for these two importers: 145 MB on Windows for a feature that
// already needs the internet. They are now fetched the first time an import
// needs them, like yt-dlp, Deno and spotDL.
//
// The downloads are the exact npm tarballs the app bundled until now, pinned
// by the integrity values recorded in package-lock.json. Changing a version
// means updating its URL and integrity together.

const crypto = require('node:crypto');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const registry = 'https://registry.npmjs.org/';
const tarball = (scope, platform, version, integrity) => Object.freeze({
  url: `${registry}@${scope}-installer/${platform}/-/${platform}-${version}.tgz`,
  integrity,
});

const FFMPEG_TOOLS = Object.freeze({
  'darwin:arm64': Object.freeze({
    ffmpeg: tarball('ffmpeg', 'darwin-arm64', '4.1.5',
      'sha512-hYqTiP63mXz7wSQfuqfFwfLOfwwFChUedeCVKkBtl/cliaTM7/ePI9bVzfZ2c+dWu3TqCwLDRWNSJ5pqZl8otA=='),
    ffprobe: tarball('ffprobe', 'darwin-arm64', '5.0.1',
      'sha512-vwNCNjokH8hfkbl6m95zICHwkSzhEvDC3GVBcUp5HX8+4wsX10SP3B+bGur7XUzTIZ4cQpgJmEIAx6TUwRepMg=='),
  }),
  'darwin:x64': Object.freeze({
    ffmpeg: tarball('ffmpeg', 'darwin-x64', '4.1.0',
      'sha512-Z4EyG3cIFjdhlY8wI9aLUXuH8nVt7E9SlMVZtWvSPnm2sm37/yC2CwjUzyCQbJbySnef1tQwGG2Sx+uWhd9IAw=='),
    ffprobe: tarball('ffprobe', 'darwin-x64', '5.1.0',
      'sha512-J+YGscZMpQclFg31O4cfVRGmDpkVsQ2fZujoUdMAAYcP0NtqpC49Hs3SWJpBdsGB4VeqOt5TTm1vSZQzs1NkhA=='),
  }),
  'linux:x64': Object.freeze({
    ffmpeg: tarball('ffmpeg', 'linux-x64', '4.1.0',
      'sha512-Y5BWhGLU/WpQjOArNIgXD3z5mxxdV8c41C+U15nsE5yF8tVcdCGet5zPs5Zy3Ta6bU7haGpIzryutqCGQA/W8A=='),
    ffprobe: tarball('ffprobe', 'linux-x64', '5.2.0',
      'sha512-D3UeqTLYPNs7pBWPLUYGehPdRVqU8eACox4OZy3pZUZatxye2YKlvBwEfaLdL1v2Z4FOAlLUhms0kY8m8kqSRA=='),
  }),
  'win32:x64': Object.freeze({
    ffmpeg: tarball('ffmpeg', 'win32-x64', '4.1.0',
      'sha512-Drt5u2vzDnIONf4ZEkKtFlbvwj6rI3kxw1Ck9fpudmtgaZIHD4ucsWB2lCZBXRxJgXR+2IMSti+4rtM4C4rXgg=='),
    ffprobe: tarball('ffprobe', 'win32-x64', '5.1.0',
      'sha512-jMGYeAgkrdn4e2vvYt/qakgHRE3CPju4bn5TmdPfoAm1BlX1mY9cyMd8gf5vSzI8gH8Zq5WQAyAkmekX/8TSTg=='),
  }),
});

function ffmpegToolsFor(platform, arch) {
  return FFMPEG_TOOLS[`${platform}:${arch}`] || null;
}

// Name of a tool's program file, inside its tarball and once installed.
function toolFileName(tool, platform) {
  return platform === 'win32' ? `${tool}.exe` : tool;
}

// True when the file's contents match an npm integrity value ("sha512-<base64>").
function fileMatchesIntegrity(filePath, integrity) {
  const match = /^(sha512|sha384|sha256)-([A-Za-z0-9+/]+=*)$/.exec(integrity || '');
  if (!match) return Promise.resolve(false);
  return new Promise((resolve) => {
    const hash = crypto.createHash(match[1]);
    const input = fs.createReadStream(filePath);
    input.on('error', () => resolve(false));
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('base64') === match[2]));
  });
}

/**
 * Stream `url` into `destination` using the given fetch implementation.
 * It fails instead of waiting forever: the connection is dropped when no data
 * arrives for `stallMs`, and a response larger than `maxBytes` is refused.
 * A failed download leaves no file behind.
 */
async function downloadToFile(fetchImpl, url, destination, { stallMs = 30000, maxBytes = 256 * 1024 * 1024 } = {}) {
  const controller = new AbortController();
  let stalled = false;
  let timer = null;
  const expectData = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { stalled = true; controller.abort(); }, stallMs);
  };
  expectData();
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`download failed (HTTP ${response.status})`);
    let received = 0;
    const body = async function* () {
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > maxBytes) throw new Error('download is larger than expected');
        expectData();
        yield chunk;
      }
    };
    await pipeline(Readable.from(body(), { objectMode: false }), fs.createWriteStream(destination));
  } catch (error) {
    controller.abort();
    fs.rmSync(destination, { force: true });
    throw stalled ? new Error('download stalled') : error;
  } finally {
    clearTimeout(timer);
  }
}

const BLOCK = 512;
const field = (header, start, length) => {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.toString('utf8', 0, end === -1 ? raw.length : end);
};

/**
 * Copy one regular file out of a .tgz to `destination`, without unpacking
 * anything else. The entry is chosen by exact name, so nothing in the archive
 * can decide where a file is written. Resolves false when it is not there.
 */
async function extractTarballEntry(tarballPath, entryName, destination) {
  let carry = Buffer.alloc(0);
  let toSkip = 0;        // bytes left in the current entry, padding included
  let toWrite = 0;       // bytes of the wanted entry still to copy
  let output = null;
  let found = false;

  const closeOutput = () => {
    if (output !== null) { fs.closeSync(output); output = null; }
  };
  const consume = (chunk) => {
    let data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    carry = Buffer.alloc(0);
    let offset = 0;
    while (offset < data.length) {
      if (toSkip > 0) {
        const available = Math.min(toSkip, data.length - offset);
        if (output !== null && toWrite > 0) {
          const body = Math.min(available, toWrite);
          fs.writeSync(output, data, offset, body);
          toWrite -= body;
          if (toWrite === 0) { closeOutput(); found = true; }
        }
        toSkip -= available;
        offset += available;
        continue;
      }
      if (data.length - offset < BLOCK) { carry = Buffer.from(data.subarray(offset)); return; }
      const header = data.subarray(offset, offset + BLOCK);
      offset += BLOCK;
      if (header.every(byte => byte === 0)) continue;   // end-of-archive padding
      const size = parseInt(field(header, 124, 12).trim() || '0', 8);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('unreadable archive entry');
      const prefix = field(header, 345, 155);
      const name = (prefix ? `${prefix}/` : '') + field(header, 0, 100);
      const regularFile = header[156] === 0 || header[156] === 0x30;
      toSkip = Math.ceil(size / BLOCK) * BLOCK;
      if (!found && regularFile && name === entryName) {
        output = fs.openSync(destination, 'w', 0o755);
        toWrite = size;
        if (size === 0) { closeOutput(); found = true; }
      }
    }
  };

  try {
    await pipeline(
      fs.createReadStream(tarballPath),
      zlib.createGunzip(),
      new Writable({
        write(chunk, _encoding, done) {
          try { consume(chunk); done(); } catch (error) { done(error); }
        },
      }),
    );
  } finally {
    closeOutput();
  }
  // A file cut short by a truncated archive is not the tool.
  if (toWrite > 0) found = false;
  if (!found) fs.rmSync(destination, { force: true });
  return found;
}

module.exports = {
  FFMPEG_TOOLS,
  downloadToFile,
  extractTarballEntry,
  ffmpegToolsFor,
  fileMatchesIntegrity,
  toolFileName,
};
