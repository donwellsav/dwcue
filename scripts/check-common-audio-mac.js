const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

assert.equal(process.platform, 'darwin', 'this regression check is macOS-only');

const root = path.resolve(__dirname, '..');
const buildDirectory = path.join(root, 'server', 'build');

const fixtures = [
  ['pcm.wav', ['-c:a', 'pcm_s16le']],
  ['broadcast.bwf', ['-c:a', 'pcm_s24le', '-write_bext', '1', '-f', 'wav']],
  ['rf64.rf64', ['-c:a', 'pcm_s24le', '-rf64', 'always', '-f', 'wav']],
  ['wave64.w64', ['-c:a', 'pcm_s24le', '-f', 'w64']],
  ['aiff.aiff', ['-c:a', 'pcm_s16be']],
  ['aiff-c.aifc', ['-c:a', 'pcm_s16le', '-f', 'aiff']],
  ['pcm.caf', ['-c:a', 'pcm_s16be']],
  ['sun.au', ['-c:a', 'pcm_s16be']],
  ['flac.flac', ['-c:a', 'flac']],
  ['alac.m4a', ['-c:a', 'alac', '-f', 'ipod']],
  ['wavpack.wv', ['-c:a', 'wavpack']],
  ['true-audio.tta', ['-c:a', 'tta']],
  ['mpeg-layer-2.mp2', ['-c:a', 'mp2', '-b:a', '192k', '-f', 'mp2']],
  ['mp3.mp3', ['-c:a', 'libmp3lame', '-b:a', '128k']],
  ['aac-adts.aac', ['-c:a', 'aac', '-b:a', '128k', '-f', 'adts']],
  ['aac.m4a', ['-c:a', 'aac', '-b:a', '128k', '-f', 'ipod']],
  ['aac.mp4', ['-c:a', 'aac', '-b:a', '128k', '-f', 'mp4']],
  ['aac.3gp', ['-c:a', 'aac', '-b:a', '128k', '-f', '3gp']],
  ['vorbis.ogg', ['-c:a', 'libvorbis', '-q:a', '4', '-f', 'ogg']],
  ['opus.opus', ['-c:a', 'libopus', '-b:a', '96k', '-f', 'ogg']],
  ['wma.wma', ['-c:a', 'wmav2', '-b:a', '128k', '-f', 'asf']],
  ['dolby-digital.ac3', ['-c:a', 'ac3', '-b:a', '192k', '-f', 'ac3']],
  ['dolby-digital-plus.eac3', ['-c:a', 'eac3', '-b:a', '192k', '-f', 'eac3']],
  ['matroska.mka', ['-c:a', 'flac', '-f', 'matroska']],
  ['webm.webm', ['-c:a', 'libopus', '-b:a', '96k', '-f', 'webm']],
  ['quicktime.mov', ['-c:a', 'aac', '-b:a', '128k', '-f', 'mov']],
  ['creative-voice.voc', ['-c:a', 'pcm_s16le', '-f', 'voc']],
];

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${label} failed\n${[result.stdout, result.stderr].filter(Boolean).join('\n')}`,
  );
}

assert.ok(
  fs.existsSync(path.join(buildDirectory, 'CMakeCache.txt')),
  'server/build is not configured; configure the server tests first',
);
run('cmake', ['--build', buildDirectory, '--target', 'decoder-check'], 'build decoder-check');
const decoder = path.join(buildDirectory, 'decoder-check');
const ffmpeg = require(require.resolve('@ffmpeg-installer/ffmpeg', {
  paths: [path.join(root, 'client')],
})).path;

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'donwells-cue-audio-'));
try {
  const input = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.25',
    '-ac', '2',
  ];
  const files = fixtures.map(([name, output]) => {
    const file = path.join(directory, name);
    run(ffmpeg, [...input, ...output, file], `generate ${name}`);
    return file;
  });

  const before = fs.readdirSync(directory).sort();
  run(decoder, files, 'decoder-check');
  assert.deepEqual(
    fs.readdirSync(directory).sort(),
    before,
    'decoder created a converted or cache file beside an input',
  );
  console.log(`macOS common-audio decoder check passed (${files.length} fixtures)`);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
