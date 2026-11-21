'use strict';

// Makes an H.264 copy of a video whose picture this machine cannot show.
//
// The Video Output window is drawn by Chromium, whose decoders are fixed: it
// has no ProRes, DNxHD, MPEG-2, WMV and so on. The converter the app already
// downloads for online imports can read those, so the copy is made with it
// and the cue is pointed at the copy. The original file is never touched.

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONVERTED_SUFFIX = ' (converted)';
// Preferred first. Every build of the converter the app pins has libx264; the
// others are there for a system converter that was built without it.
const H264_ENCODERS = ['libx264', 'h264_videotoolbox', 'h264_mf', 'libopenh264'];
// Audio that an MP4 can carry and Chromium can ignore safely is kept as it is.
const COPYABLE_AUDIO = new Set(['aac', 'mp3']);
const STALL_MS = 90_000;

/** Where the copy of `sourcePath` goes: beside it. Null for a copy of a copy. */
function convertedPathFor(sourcePath) {
  const parsed = path.parse(sourcePath);
  if (!parsed.name || parsed.name.endsWith(CONVERTED_SUFFIX)) return null;
  return path.join(parsed.dir, `${parsed.name}${CONVERTED_SUFFIX}.mp4`);
}

const isFile = (candidate) => {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
};

/**
 * Where a cue's media is on this computer: in the show's own folder when it
 * was copied there, otherwise where the cue links to. Null when neither is here.
 */
function cueSourcePath(showFolder, cue, exists = isFile) {
  const candidates = [];
  if (typeof showFolder === 'string' && showFolder && typeof cue?.mediaPath === 'string' && cue.mediaPath &&
      !path.isAbsolute(cue.mediaPath)) {
    const inShow = path.resolve(showFolder, cue.mediaPath);
    // Never outside the show folder, whatever the show file says.
    if (inShow.startsWith(path.resolve(showFolder) + path.sep)) candidates.push(inShow);
  }
  if (typeof cue?.mediaServerPath === 'string' && path.isAbsolute(cue.mediaServerPath)) {
    candidates.push(cue.mediaServerPath);
  }
  return candidates.find(candidate => exists(candidate)) ?? null;
}

function pickH264Encoder(encodersText) {
  const available = new Set();
  for (const line of String(encodersText).split(/\r?\n/)) {
    const match = /^\s*V[\w.]{5}\s+(\S+)/.exec(line);
    if (match) available.add(match[1]);
  }
  return H264_ENCODERS.find(name => available.has(name)) ?? null;
}

/** What the converter prints about a file when asked to open it. */
function parseSourceInfo(text) {
  const duration = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);
  // A cover picture or thumbnail is listed as a video stream too; it is not the film.
  const film = String(text).split(/\r?\n/).filter(line => !/\(attached pic\)/.test(line)).join('\n');
  const video = /Stream #\d+:\d+[^\n]*?: Video: (\w+)[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(film);
  const audio = /Stream #\d+:\d+[^\n]*?: Audio: (\w+)/.exec(text);
  return {
    durationSeconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null,
    videoCodec: video ? video[1] : null,
    width: video ? Number(video[2]) : null,
    height: video ? Number(video[3]) : null,
    audioCodec: audio ? audio[1] : null,
  };
}

function conversionArgs({ input, output, encoder, info, threads }) {
  const pixels = (info.width || 1920) * (info.height || 1080);
  // Hardware and fallback encoders take a bit rate rather than a quality.
  const megabits = Math.max(8, Math.round(pixels / (1920 * 1080) * 14));
  const video = encoder === 'libx264'
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18']
    : ['-c:v', encoder, '-b:v', `${megabits}M`];
  const audio = COPYABLE_AUDIO.has(info.audioCodec) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '320k'];
  return [
    '-hide_banner', '-nostdin', '-y', '-nostats', '-progress', 'pipe:1',
    '-fflags', '+genpts', '-i', input,
    // The first picture and the first sound track, as the cue already plays.
    // 'V' leaves out cover pictures and thumbnails, which are video streams too.
    '-map', '0:V:0', '-map', '0:a:0?', '-sn', '-dn',
    // Interlaced pictures are woven into whole frames; Chromium needs 8-bit
    // 4:2:0 with even dimensions.
    '-vf', 'yadif=deint=interlaced,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
    ...video, ...audio,
    '-threads', String(threads),
    // The index goes first, so the picture seeks without reading the whole file.
    '-movflags', '+faststart',
    '-max_muxing_queue_size', '2048',
    '-f', 'mp4', output,
  ];
}

function run(file, args, options = {}) {
  return new Promise(resolve => {
    execFile(file, args, { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024, ...options },
      (error, stdout, stderr) => resolve({ error, stdout: String(stdout), stderr: String(stderr) }));
  });
}

// On Windows a file cannot be replaced while a virus scanner, the indexer or a
// player has it open, which is often true for a moment after a long write. The
// finished copy is worth a few tries. The copy it replaces is never removed
// first: a rename swaps it in one step, so the cue's file is never missing.
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);
async function publishCopy(partial, output, {
  rename = fs.renameSync, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), tries = 10,
} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rename(partial, output);
      return;
    } catch (error) {
      if (attempt >= tries || !BUSY.has(error?.code)) throw error;
      await wait(250);
    }
  }
}

const sameOrNewer = (candidate, source) => {
  try {
    const made = fs.statSync(candidate);
    return made.isFile() && made.size > 0 && made.mtimeMs >= fs.statSync(source).mtimeMs;
  } catch {
    return false;
  }
};

/**
 * Convert `sourcePath`, reporting progress from 0 to 1.
 * Resolves { status: 'converted' | 'reused', path } or
 * { status: 'failed' | 'canceled', reason }. Never rejects.
 */
async function convertVideoForOutput({ ffmpegPath, sourcePath, signal, onProgress = () => {} }) {
  if (signal?.aborted) return { status: 'canceled' };
  const output = convertedPathFor(sourcePath);
  if (!output) return { status: 'failed', reason: 'already-converted' };
  try {
    if (!fs.statSync(sourcePath).isFile()) return { status: 'failed', reason: 'missing' };
  } catch {
    return { status: 'failed', reason: 'missing' };
  }
  // A copy made earlier from this same file is used again.
  if (sameOrNewer(output, sourcePath)) return { status: 'reused', path: output };

  const encoder = pickH264Encoder((await run(ffmpegPath, ['-hide_banner', '-encoders'])).stdout);
  if (!encoder) return { status: 'failed', reason: 'no-encoder' };
  // Asking the converter to open a file with no output prints what is in it.
  const info = parseSourceInfo((await run(ffmpegPath, ['-hide_banner', '-nostdin', '-i', sourcePath])).stderr);
  if (!info.videoCodec) return { status: 'failed', reason: 'no-picture' };
  if (signal?.aborted) return { status: 'canceled' };

  const partial = `${output}.part`;
  const threads = Math.max(1, Math.floor(os.cpus().length / 2));
  const args = conversionArgs({ input: sourcePath, output: partial, encoder, info, threads });
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ status: 'failed', reason: 'converter' });
      return;
    }
    // The show's sound comes first: the conversion works at low priority on
    // half the processor.
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
    let settled = false;
    let converted = false;
    let lastWord = '';
    let stall;
    // On Windows the stopped converter can hold the unfinished file for a
    // moment; it is removed again when the converter has exited. A failed
    // removal must never keep the result from being reported, or every later
    // conversion would be refused as "already running".
    const removePartial = () => {
      try { fs.rmSync(partial, { force: true }); } catch { /* removed when the converter exits */ }
    };
    const finish = result => {
      if (settled) return;
      settled = true;
      converted = result.status === 'converted';
      clearTimeout(stall);
      signal?.removeEventListener('abort', cancel);
      if (!converted) removePartial();
      resolve(result);
    };
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
    const cancel = () => { kill(); finish({ status: 'canceled' }); };
    const watch = () => {
      clearTimeout(stall);
      stall = setTimeout(() => { kill(); finish({ status: 'failed', reason: 'stalled' }); }, STALL_MS);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    watch();
    let pending = '';
    child.stdout.on('data', chunk => {
      watch();
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        const done = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (done && info.durationSeconds) {
          onProgress(Math.max(0, Math.min(1, Number(done[1]) / 1e6 / info.durationSeconds)));
        }
      }
    });
    child.stderr.on('data', chunk => { lastWord = (lastWord + chunk).slice(-600); });
    child.on('error', () => finish({ status: 'failed', reason: 'converter' }));
    child.on('close', async code => {
      if (settled) {
        if (!converted) removePartial();
        return;
      }
      if (code !== 0) return finish({ status: 'failed', reason: 'converter', detail: lastWord.trim().split(/\r?\n/).pop() });
      try {
        if (fs.statSync(partial).size === 0) throw new Error('empty');
        await publishCopy(partial, output);
      } catch {
        return finish({ status: 'failed', reason: 'write' });
      }
      if (settled) return;   // cancelled while waiting for the file to come free
      onProgress(1);
      finish({ status: 'converted', path: output });
    });
  });
}

module.exports = {
  CONVERTED_SUFFIX, conversionArgs, convertVideoForOutput, convertedPathFor, cueSourcePath, parseSourceInfo,
  pickH264Encoder, publishCopy,
};
