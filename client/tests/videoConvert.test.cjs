'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  conversionArgs, convertedPathFor, cueSourcePath, parseSourceInfo, pickH264Encoder, publishCopy,
} = require('../electron/video-convert');

test('the copy goes beside the original, and a copy is not copied again', () => {
  assert.equal(convertedPathFor(path.join('shows', 'media', 'Opening film.mov')),
    path.join('shows', 'media', 'Opening film (converted).mp4'));
  assert.equal(convertedPathFor(path.join('shows', 'Clip.v2.final.MXF')), path.join('shows', 'Clip.v2.final (converted).mp4'));
  assert.equal(convertedPathFor(path.join('shows', 'Opening film (converted).mp4')), null);
});

test('the best H.264 encoder the converter has is used', () => {
  const list = [
    'Encoders:', ' V..... = Video', ' ------',
    ' V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)',
    ' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)',
    ' A....D aac                  AAC (Advanced Audio Coding)',
  ].join('\n');
  assert.equal(pickH264Encoder(list), 'libx264');
  assert.equal(pickH264Encoder(list.replace(/^.*libx264 .*$/m, '')), 'h264_videotoolbox');
  assert.equal(pickH264Encoder(' V....D h264_mf              H264 via MediaFoundation (codec h264)\r\n'), 'h264_mf');
  assert.equal(pickH264Encoder(' V....D mpeg2video           MPEG-2 video\n A....D libx264 not a video encoder'), null);
  assert.equal(pickH264Encoder(''), null);
});

test('what is in the source is read from the converter\'s description of it', () => {
  const prores = [
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'Opening film.mov':",
    '  Duration: 00:01:02.50, start: 0.000000, bitrate: 147210 kb/s',
    '  Stream #0:0(und): Video: prores (HQ) (apch / 0x68637061), yuv422p10le(tv, bt709, progressive), 1920x1080, 146010 kb/s, 25 fps',
    '  Stream #0:1(und): Audio: pcm_s24le (in24 / 0x34326E69), 48000 Hz, stereo, s32 (24 bit), 2304 kb/s',
  ].join('\n');
  assert.deepEqual(parseSourceInfo(prores),
    { durationSeconds: 62.5, videoCodec: 'prores', width: 1920, height: 1080, audioCodec: 'pcm_s24le' });
  assert.deepEqual(parseSourceInfo('  Duration: N/A\n  Stream #0:0: Audio: mp3, 44100 Hz'),
    { durationSeconds: null, videoCodec: null, width: null, height: null, audioCodec: 'mp3' });

  // A cover picture is listed as a video stream; the film is the one that is not.
  const withCover = [
    '  Duration: 00:00:02.00, start: 0.000000, bitrate: 364 kb/s',
    '  Stream #0:0: Video: mjpeg (Baseline), yuvj420p(pc), 600x600 [SAR 1:1 DAR 1:1], 90k tbr, 90k tbn, 90k tbc (attached pic)',
    '  Stream #0:1(und): Video: prores (HQ) (apch / 0x68637061), yuv422p10le, 1920x1080, 25 fps',
  ].join('\r\n');
  assert.deepEqual(parseSourceInfo(withCover),
    { durationSeconds: 2, videoCodec: 'prores', width: 1920, height: 1080, audioCodec: null });
  // A sound file with artwork has no picture to convert.
  assert.equal(parseSourceInfo(withCover.split('\r\n').slice(0, 2).join('\n')).videoCodec, null);
});

test('the finished copy is put in place in one step, waiting out a file that is briefly busy', async () => {
  const busy = code => Object.assign(new Error(code), { code });
  const calls = [];
  let waits = 0;
  const wait = async () => { waits += 1; };
  // Free on the third try: nothing is deleted first, the rename itself replaces.
  let failures = 2;
  await publishCopy('copy.part', 'copy.mp4', {
    wait, rename: (from, to) => { calls.push([from, to]); if (failures-- > 0) throw busy('EBUSY'); },
  });
  assert.deepEqual(calls, [['copy.part', 'copy.mp4'], ['copy.part', 'copy.mp4'], ['copy.part', 'copy.mp4']]);
  assert.equal(waits, 2);

  // Still busy after every try, or a fault that waiting cannot cure: reported.
  let tries = 0;
  await assert.rejects(publishCopy('a', 'b', { wait, tries: 4, rename: () => { tries += 1; throw busy('EPERM'); } }), /EPERM/);
  assert.equal(tries, 4);
  tries = 0;
  await assert.rejects(publishCopy('a', 'b', { wait, rename: () => { tries += 1; throw busy('ENOSPC'); } }), /ENOSPC/);
  assert.equal(tries, 1);
});

test('the conversion keeps the first picture and sound, and writes what Chromium plays', () => {
  const info = { durationSeconds: 10, videoCodec: 'prores', width: 1920, height: 1080, audioCodec: 'pcm_s24le' };
  const args = conversionArgs({ input: 'in.mov', output: 'out.mp4.part', encoder: 'libx264', info, threads: 4 });
  const after = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(after('-i'), 'in.mov');
  assert.equal(args.at(-1), 'out.mp4.part');
  assert.equal(after('-f'), 'mp4');
  // 'V', not 'v': a cover picture is never taken for the film.
  assert.deepEqual(args.filter((value, index) => args[index - 1] === '-map'), ['0:V:0', '0:a:0?']);
  assert.match(after('-vf'), /yadif=deint=interlaced.*scale=trunc\(iw\/2\)\*2:trunc\(ih\/2\)\*2.*format=yuv420p/);
  assert.equal(after('-c:v'), 'libx264');
  assert.equal(after('-crf'), '18');
  assert.equal(after('-c:a'), 'aac');
  assert.equal(after('-b:a'), '320k');
  assert.equal(after('-threads'), '4');
  assert.equal(after('-movflags'), '+faststart');
  // Nothing may push the first picture away from zero.
  assert.equal(args.includes('-avoid_negative_ts'), false);

  // Sound an MP4 already carries is not encoded a second time.
  const aac = conversionArgs({ input: 'in.mts', output: 'o.part', encoder: 'libx264', info: { ...info, audioCodec: 'aac' }, threads: 1 });
  assert.equal(aac[aac.indexOf('-c:a') + 1], 'copy');
  assert.equal(aac.includes('-b:a'), false);

  // An encoder with no quality setting gets a bit rate sized to the picture.
  const hardware = conversionArgs({ input: 'i', output: 'o', encoder: 'h264_videotoolbox', info, threads: 1 });
  assert.equal(hardware[hardware.indexOf('-b:v') + 1], '14M');
  const uhd = conversionArgs({ input: 'i', output: 'o', encoder: 'h264_mf', info: { ...info, width: 3840, height: 2160 }, threads: 1 });
  assert.equal(uhd[uhd.indexOf('-b:v') + 1], '56M');
});

test('a cue\'s file is found in the show folder first, then where it links to', () => {
  const show = path.resolve('shows', 'Gala');
  const copied = path.join(show, 'media', 'Film.mov');
  const linked = path.resolve('volumes', 'Stick', 'Film.mov');
  const here = (...files) => (candidate) => files.includes(candidate);
  // Copied into the show: the copy in the show folder, even when the saved
  // absolute path still points at another computer's folder.
  assert.equal(cueSourcePath(show, { mediaPath: 'media/Film.mov', mediaServerPath: linked }, here(copied, linked)), copied);
  assert.equal(cueSourcePath(show, { mediaPath: 'media/Film.mov', mediaServerPath: linked }, here(linked)), linked);
  // Linked in place: where it links to.
  assert.equal(cueSourcePath(show, { mediaPath: '', mediaServerPath: linked }, here(linked)), linked);
  // Not on this computer at all.
  assert.equal(cueSourcePath(show, { mediaPath: 'media/Film.mov', mediaServerPath: linked }, here()), null);
  // A show file cannot point the converter outside the show folder with a relative path.
  const outside = path.resolve(show, '..', 'Other', 'secret.mov');
  assert.equal(cueSourcePath(show, { mediaPath: '../Other/secret.mov', mediaServerPath: '' }, here(outside)), null);
  assert.equal(cueSourcePath(show, { mediaPath: 'media/Film.mov', mediaServerPath: 'relative/Film.mov' }, here()), null);
  assert.equal(cueSourcePath('', { mediaPath: 'media/Film.mov', mediaServerPath: linked }, here(linked)), linked);
  assert.equal(cueSourcePath(show, null, here(copied)), null);
});

// On Windows a stopped converter can still hold its unfinished file, so
// removing it throws. The conversion must still report back, or every later
// conversion is refused as "already running" until the app restarts.
test('a cancelled conversion reports back even when its unfinished file cannot be removed yet',
  { skip: process.platform === 'win32' }, async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const { convertVideoForOutput } = require('../electron/video-convert');
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dwcue-convert-'));
    const ffmpeg = path.join(folder, 'ffmpeg');
    fs.writeFileSync(ffmpeg, [
      '#!/bin/sh',
      'case "$*" in',
      '  *-encoders*) echo " V....D libx264              H.264";;',
      '  *-progress*) exec sleep 30;;',
      '  *) echo "Duration: 00:00:10.00" >&2; echo "Stream #0:0: Video: prores, yuv422p, 1920x1080" >&2;;',
      'esac',
    ].join('\n'), { mode: 0o755 });
    const source = path.join(folder, 'Opening film.mov');
    fs.writeFileSync(source, 'not really a film');
    const controller = new AbortController();
    const realRemove = fs.rmSync;
    fs.rmSync = () => { throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' }); };
    try {
      const conversion = convertVideoForOutput({ ffmpegPath: ffmpeg, sourcePath: source, signal: controller.signal });
      setTimeout(() => controller.abort(), 300);
      const result = await Promise.race([conversion,
        new Promise(resolve => setTimeout(() => resolve({ status: 'never reported' }), 3000))]);
      assert.equal(result.status, 'canceled');
    } finally {
      fs.rmSync = realRemove;
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
