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
    const check = (name, inPoint = 0, signal = new AbortController().signal, timeout = 5000) =>
      checkVideoFrame(base + '/' + name, inPoint, signal, timeout);

    assert.equal(await check('good'), 'ok');
    assert.equal(await check('good', 1.25), 'ok');
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
  require('node:test')('video preflight decodes the In point and releases failed, stalled and canceled probes', { timeout: 30000 }, async t => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'dwcue-video-preflight-'));
    t.after(() => fs.rm(folder, { recursive: true, force: true }));
    const ffmpeg = require('@ffmpeg-installer/ffmpeg').path;
    const encode = (name, args) => promisify(execFile)(ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', ...args, path.join(folder, name)]);
    await encode('good.mp4', ['-i', 'testsrc2=size=320x180:rate=30', '-t', '2', '-an',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']);
    await encode('audio.mp4', ['-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:a', 'aac']);
    const media = {
      '/good': await fs.readFile(path.join(folder, 'good.mp4')),
      '/audio': await fs.readFile(path.join(folder, 'audio.mp4')),
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
