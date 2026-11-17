'use strict';

// Run on a desktop host. A real Chromium decoder uses local generated media.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { execFile, spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

if (process.versions.electron) {
  const { app, BrowserWindow } = require('electron');
  const { checkVideoFrame } = require('../client/electron/video-frame-check');
  app.setPath('userData', process.env.DWCUE_PREFLIGHT_DATA);
  void (async () => {
    await app.whenReady();
    const operator = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await operator.loadURL('data:text/html,<!doctype html><title>Operator</title>');
    const base = process.env.DWCUE_PREFLIGHT_URL;
    const check = (name, inPoint = 0, signal = new AbortController().signal, timeout = 5000, outPoint = null) =>
      checkVideoFrame(base + '/' + name, { inPoint, outPoint }, signal, timeout);

    assert.equal(await check('good'), 'ok');
    assert.equal(await check('good', 1.25), 'ok');
    // A file whose first picture is a little after zero plays, so it passes:
    // the playhead settles on that first picture instead of exactly on zero.
    assert.equal(await check('late'), 'ok');
    // A picture Chromium cannot decode fails, and its converted copy passes.
    assert.notEqual(await check('unsupported'), 'ok');
    assert.equal(await check('converted'), 'ok');
    const lateFailure = check('good', 0.2, undefined, 5000, 1.6);
    const lateProbe = BrowserWindow.getAllWindows().find(win => win !== operator);
    const exec = lateProbe.webContents.executeJavaScript.bind(lateProbe.webContents);
    let sampled;
    lateProbe.webContents.executeJavaScript = async script => {
      const result = await exec(`(async () => {
        const sampled = [];
        const bitmap = window.createImageBitmap.bind(window);
        window.createImageBitmap = (video, options) => {
          sampled.push(video.currentTime);
          return video.currentTime > 1.35 ? Promise.reject(new Error('frame error')) : bitmap(video, options);
        };
        return { status: await (${script}), sampled };
      })()`);
      sampled = result.sampled;
      return result.status;
    };
    assert.equal(await lateFailure, 'no-frame');
    assert.equal(sampled.length, 3);
    for (const [index, expected] of [0.2, 0.9, 1.56].entries())
      assert.ok(Math.abs(sampled[index] - expected) < 0.005, JSON.stringify(sampled));
    assert.equal(await check('good', 5), 'in-point');
    assert.equal(await check('audio'), 'no-frame');
    assert.equal(await check('corrupt'), 'decode');
    assert.notEqual(await check('missing'), 'ok');
    assert.equal(await check('stall', 0, new AbortController().signal, 600), 'timeout');
    assert.deepEqual(BrowserWindow.getAllWindows(), [operator]);

    const cancel = new AbortController();
    const pending = check('stall', 0, cancel.signal);
    const probe = BrowserWindow.getAllWindows().find(win => win !== operator);
    assert.ok(probe);
    assert.equal(probe.isVisible(), false);
    await once(probe.webContents, 'did-finish-load');
    assert.notEqual(probe.webContents.getOSProcessId(), operator.webContents.getOSProcessId());
    assert.equal(await operator.webContents.executeJavaScript('6 * 7'), 42);
    cancel.abort();
    assert.equal(await pending, 'canceled');
    assert.equal(probe.isDestroyed(), true);
    assert.equal(await check('good'), 'ok');
    assert.deepEqual(BrowserWindow.getAllWindows(), [operator]);
    operator.destroy();
    app.exit(0);
  })().catch(error => { console.error(error); app.exit(1); });
} else {
  require('node:test')('video preflight samples the cue range and releases failed, stalled and canceled probes', { timeout: 30000 }, async t => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'dwcue-video-preflight-'));
    t.after(() => fs.rm(folder, { recursive: true, force: true }));
    const ffmpeg = require('@ffmpeg-installer/ffmpeg').path;
    const encode = (name, args) => promisify(execFile)(ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', ...args, path.join(folder, name)]);
    await encode('good.mp4', ['-i', 'testsrc2=size=320x180:rate=30', '-t', '2', '-an',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']);
    await encode('audio.mp4', ['-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:a', 'aac']);
    await encode('late.mp4', ['-i', 'testsrc2=size=320x180:rate=25', '-t', '2', '-an',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-output_ts_offset', '0.08']);
    // MPEG-2 with sound: readable by the converter, not by Chromium.
    await promisify(execFile)(ffmpeg, ['-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '2', '-c:v', 'mpeg2video', '-b:v', '1M', '-c:a', 'mp2', path.join(folder, 'unsupported.mpg')]);
    const { convertVideoForOutput, convertedPathFor } = require('../client/electron/video-convert');
    const source = path.join(folder, 'unsupported.mpg');
    let progress = 0;
    const made = await convertVideoForOutput({ ffmpegPath: ffmpeg, sourcePath: source, onProgress: value => { progress = value; } });
    assert.deepEqual(made, { status: 'converted', path: convertedPathFor(source) });
    assert.equal(progress, 1);
    // The copy made from this file is used again rather than made twice.
    assert.equal((await convertVideoForOutput({ ffmpegPath: ffmpeg, sourcePath: source })).status, 'reused');
    // A copy is never converted again, and a stopped conversion leaves nothing behind.
    assert.deepEqual(await convertVideoForOutput({ ffmpegPath: ffmpeg, sourcePath: made.path }),
      { status: 'failed', reason: 'already-converted' });
    await fs.copyFile(source, path.join(folder, 'stopped.mpg'));
    const stop = new AbortController();
    const stopped = convertVideoForOutput({ ffmpegPath: ffmpeg, sourcePath: path.join(folder, 'stopped.mpg'), signal: stop.signal });
    setTimeout(() => stop.abort(), 30);
    assert.deepEqual(await stopped, { status: 'canceled' });
    assert.deepEqual((await fs.readdir(folder)).filter(name => name.startsWith('stopped')), ['stopped.mpg']);
    assert.deepEqual(await convertVideoForOutput({ ffmpegPath: ffmpeg, sourcePath: path.join(folder, 'gone.mpg') }),
      { status: 'failed', reason: 'missing' });
    const media = {
      '/good': await fs.readFile(path.join(folder, 'good.mp4')),
      '/audio': await fs.readFile(path.join(folder, 'audio.mp4')),
      '/late': await fs.readFile(path.join(folder, 'late.mp4')),
      '/unsupported': await fs.readFile(source),
      '/converted': await fs.readFile(made.path),
      '/corrupt': Buffer.from('not a video'),
    };
    const server = http.createServer((request, response) => {
      if (request.url === '/stall') return;
      const file = media[request.url];
      if (!file) return response.writeHead(404).end();
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
      const start = Number(range?.[1] || 0);
      const end = range?.[2] ? Math.min(Number(range[2]), file.length - 1) : file.length - 1;
      response.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${file.length}` } : {}),
      }).end(file.subarray(start, end + 1));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const env = { ...process.env, DWCUE_PREFLIGHT_DATA: path.join(folder, 'profile'),
      DWCUE_PREFLIGHT_URL: `http://127.0.0.1:${server.address().port}` };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [__filename], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    try {
      const [code] = await once(child, 'close', { signal: AbortSignal.timeout(24000) });
      assert.equal(code, 0, output);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
