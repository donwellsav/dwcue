'use strict';

// Builds the disposable shows the soak test and the benchmarks play.
//
// Every sound in them is a slow tone between 20 and 35 Hz at about -24 dBFS:
// the meters register it, and a laptop's speakers cannot reproduce it, so a
// run stays silent even if a cue ever reached the wrong output. The pictures
// are FFmpeg test patterns. Nothing here is taken from a real show.

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// name, seconds, format, tone Hz
const AUDIO = [
  ['short-01.wav', 12, 'wav16-44', 25], ['short-02.flac', 15, 'flac-48', 30], ['short-03.mp3', 10, 'mp3-44', 32],
  ['short-04.m4a', 14, 'm4a-48', 28], ['short-05.wav', 18, 'wav24-48', 22], ['short-06.flac', 9, 'flac-96', 34],
  ['short-07.wav', 20, 'wav16-44', 27], ['short-08.flac', 16, 'flac-48', 31],
  ['chain-01.flac', 20, 'flac-48', 24], ['chain-02.wav', 20, 'wav24-48', 29], ['chain-03.mp3', 20, 'mp3-44', 33],
  ['chain-04.m4a', 20, 'm4a-48', 26],
  ['loop-01.wav', 15, 'wav16-44', 23], ['loop-02.flac', 20, 'flac-48', 35],
  ['medium-01.flac', 45, 'flac-48', 21], ['medium-02.mp3', 60, 'mp3-44', 30], ['medium-03.wav', 40, 'wav24-48', 25],
  ['long-01.flac', 420, 'flac-48', 28], ['long-02.mp3', 600, 'mp3-44', 32], ['long-03.m4a', 300, 'm4a-48', 24],
  ['sting-a.wav', 6, 'wav16-44', 30], ['sting-b.flac', 8, 'flac-48', 26], ['sting-c.mp3', 5, 'mp3-44', 34],
  ['sting-d.m4a', 7, 'm4a-48', 22], ['bed.flac', 30, 'flac-48', 27], ['duck.wav', 9, 'wav24-48', 31],
];

// name, seconds, picture, sound
const VIDEO = [
  ['video-720p.mp4', 45, { size: '1280x720', codec: 'h264' }, 26],
  ['video-1080p.mp4', 60, { size: '1920x1080', codec: 'h264' }, 30],
  ['video-silent.mp4', 30, { size: '1280x720', codec: 'h264' }, null],
  ['video-hevc.mp4', 40, { size: '1920x1080', codec: 'hevc' }, 24],
];

const AUDIO_CODEC = {
  'wav16-44': ['-ar', '44100', '-c:a', 'pcm_s16le'],
  'wav24-48': ['-ar', '48000', '-c:a', 'pcm_s24le'],
  'flac-48': ['-ar', '48000', '-c:a', 'flac'],
  'flac-96': ['-ar', '96000', '-c:a', 'flac'],
  'mp3-44': ['-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '192k'],
  'm4a-48': ['-ar', '48000', '-c:a', 'aac', '-b:a', '192k'],
};

const tone = (hz, seconds) => `sine=frequency=${hz}:sample_rate=48000:duration=${seconds}`;
const SHAPE = 'tremolo=f=0.4:d=0.6,volume=0.5';

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
}

// Writes the media once; a later run reuses what is there.
function generateMedia(mediaDir) {
  fs.mkdirSync(mediaDir, { recursive: true });
  for (const [name, seconds, format, hz] of AUDIO) {
    const file = path.join(mediaDir, name);
    if (fs.existsSync(file)) continue;
    ffmpeg(['-f', 'lavfi', '-i', tone(hz, seconds), '-af', SHAPE, '-ac', '2', ...AUDIO_CODEC[format], file]);
  }
  for (const [name, seconds, picture, hz] of VIDEO) {
    const file = path.join(mediaDir, name);
    if (fs.existsSync(file)) continue;
    const video = picture.codec === 'hevc'
      ? ['-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-x265-params', 'log-level=error']
      : ['-c:v', 'libx264', '-preset', 'veryfast'];
    const pattern = ['-f', 'lavfi', '-i', `testsrc2=size=${picture.size}:rate=30:duration=${seconds}`];
    const soundIn = hz === null ? [] : ['-f', 'lavfi', '-i', tone(hz, seconds)];
    const soundOut = hz === null ? ['-an']
      : ['-af', SHAPE, '-ac', '2', '-ar', '48000', '-c:a', 'aac', '-b:a', '160k', '-shortest'];
    ffmpeg([...pattern, ...soundIn, ...video, '-pix_fmt', 'yuv420p', '-g', '30', ...soundOut,
      '-movflags', '+faststart', file]);
  }
}

const secondsOf = Object.fromEntries([...AUDIO, ...VIDEO].map(([name, seconds]) => [name, seconds]));

// A stable id per cue, so two runs of the same show are the same show.
function uuid(key) {
  const h = crypto.createHash('sha1').update(`dwcue-soak/${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function cue(mediaDir, key, name, file, color, extra = {}) {
  const seconds = secondsOf[file];
  return {
    // The importer marks a file that carries a picture; without the mark the
    // cue plays as sound only.
    ...(file.endsWith('.mp4') ? { hasVideo: true } : {}),
    uuid: uuid(key), type: 'audio', displayName: name, color, index: [0],
    mediaFileName: file, mediaPath: `media/${file}`, mediaServerPath: path.join(mediaDir, file), waveformPath: '',
    inPoint: 0, outPoint: seconds, duration: seconds, volume: 1,
    endBehavior: { action: 'nothing' }, startBehavior: { action: 'nothing' }, customActions: [],
    duckingBehavior: { mode: 'stop-all', duckFadeIn: 0.25, duckFadeOut: 1 },
    fadeOutDuration: 1, playFade: 0, stopFade: 0, crossFade: 0,
    startNextEnabled: false, startNextTime: 0, startNextFadeOut: false, ...extra,
  };
}

function quickPlay(mediaDir, slot, key, name, file, color, extra = {}) {
  return cue(mediaDir, key, name, file, color, {
    index: [-1, slot], quickPlay: { order: slot, retrigger: 'restart' },
    duckingBehavior: { mode: 'no-ducking', duckFadeIn: 0.25, duckFadeOut: 1 },
    playFade: 0.1, stopFade: 0.5, fadeOutDuration: 0.5, ...extra,
  });
}

function showDocument(folder, name, items, quickPlays, output) {
  items.forEach((item, n) => { item.index = [n]; });
  return {
    name, version: '2.0.0', folderPath: folder, items, quickPlayItems: quickPlays, quickPlaySlots: [],
    settings: { autoSave: true, ...(output ? { defaultOutputDevice: output } : {}) },
    theme: { mode: 'dark', accentColor: '#315FCF' },
  };
}

// The show the soak test runs: 24 cues that cover every ending and file type,
// four of them video, and six QuickPlays.
function writeSoakShow(folder, output) {
  const mediaDir = path.join(folder, 'media');
  generateMedia(mediaDir);
  const c = (...args) => cue(mediaDir, ...args);
  const follow = { endBehavior: { action: 'next' }, crossFade: 2 };
  const items = [
    c('s1', 'Short 1 (WAV 44.1k)', 'short-01.wav', '#0066FF'),
    c('s2', 'Short 2 (FLAC)', 'short-02.flac', '#00CC99'),
    c('v1', 'Video 720p', 'video-720p.mp4', '#FF6600'),
    c('s3', 'Short 3 (MP3)', 'short-03.mp3', '#FFCC00'),
    c('ch1', 'Chain 1 > next', 'chain-01.flac', '#9900FF', follow),
    c('ch2', 'Chain 2 > next', 'chain-02.wav', '#9900FF', follow),
    c('ch3', 'Chain 3 > next', 'chain-03.mp3', '#9900FF', follow),
    c('ch4', 'Chain 4 (ends)', 'chain-04.m4a', '#9900FF'),
    c('s4', 'Short 4 (M4A)', 'short-04.m4a', '#FF00CC'),
    c('m1', 'Medium 1', 'medium-01.flac', '#00AAFF'),
    c('lp1', 'Loop 1', 'loop-01.wav', '#66BB44', { endBehavior: { action: 'loop' } }),
    c('v2', 'Video 1080p', 'video-1080p.mp4', '#FF6600'),
    c('s5', 'Short 5 (WAV 24-bit)', 'short-05.wav', '#0066FF', { playFade: 1, stopFade: 1 }),
    c('l1', 'Long 1 (7 min)', 'long-01.flac', '#00CC99'),
    c('s6', 'Short 6 (FLAC 96k)', 'short-06.flac', '#FFCC00'),
    c('v3', 'Video without sound', 'video-silent.mp4', '#FF6600'),
    c('m2', 'Medium 2', 'medium-02.mp3', '#00AAFF', { playFade: 2 }),
    c('lp2', 'Loop 2', 'loop-02.flac', '#66BB44', { endBehavior: { action: 'loop' } }),
    c('l2', 'Long 2 (10 min)', 'long-02.mp3', '#00CC99'),
    c('s7', 'Short 7 > next', 'short-07.wav', '#0066FF', { endBehavior: { action: 'next' } }),
    c('v4', 'Video HEVC', 'video-hevc.mp4', '#FF6600'),
    c('m3', 'Medium 3', 'medium-03.wav', '#00AAFF'),
    c('l3', 'Long 3 (5 min)', 'long-03.m4a', '#00CC99'),
    c('s8', 'Short 8 (last)', 'short-08.flac', '#FF00CC'),
  ];
  const q = (...args) => quickPlay(mediaDir, ...args);
  const quickPlays = [
    q(0, 'q1', 'Sting A', 'sting-a.wav', '#FFCC00'),
    q(1, 'q2', 'Sting B', 'sting-b.flac', '#FF00CC'),
    q(2, 'q3', 'Sting C', 'sting-c.mp3', '#00CC99'),
    q(3, 'q4', 'Sting D', 'sting-d.m4a', '#0066FF'),
    q(4, 'q5', 'Looping bed', 'bed.flac', '#9900FF', { endBehavior: { action: 'loop' } }),
    q(5, 'q6', 'Ducking sting', 'duck.wav', '#FF6600',
      { duckingBehavior: { mode: 'duck-others', duckLevel: 0.1, duckFadeIn: 0.25, duckFadeOut: 1 } }),
  ];
  const file = path.join(folder, 'Soak show.dwcue');
  fs.writeFileSync(file, JSON.stringify(showDocument(folder, 'Soak show', items, quickPlays, output), null, 2));
  return {
    file, name: 'Soak show',
    cues: items.map(item => ({ uuid: item.uuid, name: item.displayName, file: item.mediaFileName, seconds: item.duration,
      silent: item.mediaFileName === 'video-silent.mp4', loops: item.endBehavior.action === 'loop',
      follows: item.endBehavior.action === 'next' })),
    quickPlays: quickPlays.map(item => ({ uuid: item.uuid, name: item.displayName, file: item.mediaFileName, slot: item.index[1],
      seconds: item.duration, loops: item.endBehavior.action === 'loop' })),
  };
}

// A large show for the open-time benchmark: `count` three-minute cues, each
// its own file on disk, and twenty QuickPlays.
function writeLargeShow(folder, count, output) {
  const mediaDir = path.join(folder, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const seeds = [];
  for (let n = 0; n < 10; n += 1) {
    const seed = path.join(mediaDir, `seed-${n}.flac`);
    if (!fs.existsSync(seed)) {
      ffmpeg(['-f', 'lavfi', '-i', tone(20 + n, 180), '-af', SHAPE, '-ac', '2', '-ar', '48000', '-c:a', 'flac', seed]);
    }
    seeds.push(seed);
  }
  const colors = ['#0066FF', '#00CC99', '#FFCC00', '#9900FF', '#FF6600', '#FF00CC', '#00AAFF', '#66BB44'];
  const items = [];
  for (let n = 0; n < count; n += 1) {
    const file = `track-${String(n + 1).padStart(3, '0')}.flac`;
    const target = path.join(mediaDir, file);
    if (!fs.existsSync(target)) fs.copyFileSync(seeds[n % seeds.length], target);
    secondsOf[file] = 180;
    items.push(cue(mediaDir, `large-${n}`, `Track ${n + 1}`, file, colors[n % colors.length]));
  }
  const quickPlays = [];
  for (let slot = 0; slot < 20; slot += 1) {
    const file = `track-${String(slot + 1).padStart(3, '0')}.flac`;
    quickPlays.push(quickPlay(mediaDir, slot, `large-q${slot}`, `QuickPlay ${slot + 1}`, file, colors[slot % colors.length]));
  }
  const name = `Large show (${count})`;
  const file = path.join(folder, `${name}.dwcue`);
  fs.writeFileSync(file, JSON.stringify(showDocument(folder, name, items, quickPlays, output), null, 2));
  return { file, name, count };
}

module.exports = { writeSoakShow, writeLargeShow };
