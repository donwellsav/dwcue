const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const http = require('node:http');
const {
  FFMPEG_TOOLS, downloadToFile, extractTarballEntry, ffmpegToolsFor, fileMatchesIntegrity, toolFileName,
} = require('../electron/ffmpeg-tools.js');

// A minimal ustar writer, so the reader is checked against real archive bytes.
function tarEntry(name, body, type = '0') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000755\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write('ustar\0' + '00', 257);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}
const tgz = (...entries) => zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dwcue-ffmpeg-tools-'));

test('every supported platform has pinned ffmpeg and ffprobe downloads matching the lock file', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package-lock.json'), 'utf8'));
  for (const [key, tools] of Object.entries(FFMPEG_TOOLS)) {
    const platform = key.replace(':', '-');
    for (const tool of ['ffmpeg', 'ffprobe']) {
      const locked = lock.packages[`node_modules/@${tool}-installer/${platform}`];
      assert.ok(locked, `${tool} for ${platform} is in the lock file`);
      assert.equal(tools[tool].url, locked.resolved, `${tool} ${platform} URL`);
      assert.equal(tools[tool].integrity, locked.integrity, `${tool} ${platform} integrity`);
      assert.match(tools[tool].url, /^https:\/\/registry\.npmjs\.org\//);
    }
  }
  assert.deepEqual(Object.keys(FFMPEG_TOOLS).sort(), ['darwin:arm64', 'darwin:x64', 'linux:x64', 'win32:x64']);
  assert.equal(ffmpegToolsFor('win32', 'x64'), FFMPEG_TOOLS['win32:x64']);
  assert.equal(ffmpegToolsFor('linux', 'arm64'), null, 'an unsupported platform downloads nothing');
  assert.equal(toolFileName('ffprobe', 'win32'), 'ffprobe.exe');
  assert.equal(toolFileName('ffmpeg', 'darwin'), 'ffmpeg');
});

test('a download is accepted only when its contents match the pinned integrity', async () => {
  const dir = workspace();
  try {
    const file = path.join(dir, 'download.tgz');
    fs.writeFileSync(file, 'the real archive');
    const integrity = 'sha512-' + crypto.createHash('sha512').update('the real archive').digest('base64');
    assert.equal(await fileMatchesIntegrity(file, integrity), true);
    fs.writeFileSync(file, 'the real archive, tampered');
    assert.equal(await fileMatchesIntegrity(file, integrity), false);
    assert.equal(await fileMatchesIntegrity(file, 'not-an-integrity'), false);
    assert.equal(await fileMatchesIntegrity(file, ''), false);
    assert.equal(await fileMatchesIntegrity(path.join(dir, 'missing'), integrity), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('only the named program is copied out of an archive, byte for byte', async () => {
  const dir = workspace();
  try {
    const program = crypto.randomBytes(200_000);   // spans many blocks and stream chunks
    const archive = path.join(dir, 'tool.tgz');
    fs.writeFileSync(archive, tgz(
      tarEntry('package/README.md', Buffer.from('readme')),
      tarEntry('package/ffmpeg', program),
      tarEntry('package/package.json', Buffer.from('{}')),
    ));
    const destination = path.join(dir, 'ffmpeg');
    assert.equal(await extractTarballEntry(archive, 'package/ffmpeg', destination), true);
    assert.ok(fs.readFileSync(destination).equals(program));
    assert.deepEqual(fs.readdirSync(dir).sort(), ['ffmpeg', 'tool.tgz'], 'nothing else is unpacked');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(destination).mode & 0o111, 0o111, 'the program is executable');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an archive cannot choose where its files are written', async () => {
  const dir = workspace();
  try {
    const archive = path.join(dir, 'hostile.tgz');
    fs.writeFileSync(archive, tgz(
      tarEntry('../../outside', Buffer.from('escape')),
      tarEntry('package/ffmpeg', Buffer.from('link'), '2'),   // a symlink entry, not a file
    ));
    const destination = path.join(dir, 'ffmpeg');
    assert.equal(await extractTarballEntry(archive, 'package/ffmpeg', destination), false,
      'a link with the right name is not the program');
    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(fs.readdirSync(dir), ['hostile.tgz']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('missing, truncated and corrupt archives leave nothing installed', async () => {
  const dir = workspace();
  try {
    const destination = path.join(dir, 'ffprobe');
    const missing = path.join(dir, 'missing-entry.tgz');
    fs.writeFileSync(missing, tgz(tarEntry('package/README.md', Buffer.from('readme'))));
    assert.equal(await extractTarballEntry(missing, 'package/ffprobe', destination), false);
    assert.equal(fs.existsSync(destination), false);

    const whole = Buffer.concat([tarEntry('package/ffprobe', crypto.randomBytes(50_000)), Buffer.alloc(1024)]);
    const truncated = path.join(dir, 'truncated.tgz');
    fs.writeFileSync(truncated, zlib.gzipSync(whole.subarray(0, 20_000)));
    assert.equal(await extractTarballEntry(truncated, 'package/ffprobe', destination), false);
    assert.equal(fs.existsSync(destination), false, 'a partial program is removed');

    const corrupt = path.join(dir, 'corrupt.tgz');
    fs.writeFileSync(corrupt, 'this is not gzip');
    await assert.rejects(extractTarballEntry(corrupt, 'package/ffprobe', destination));
    assert.equal(fs.existsSync(destination), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// A local web server standing in for the download host.
async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('a download is written to disk, following redirects', async () => {
  const dir = workspace();
  try {
    const payload = crypto.randomBytes(300_000);
    await withServer((request, response) => {
      if (request.url === '/start') { response.writeHead(302, { location: '/file' }); response.end(); return; }
      response.writeHead(200);
      response.end(payload);
    }, async (origin) => {
      const destination = path.join(dir, 'tool.tgz');
      await downloadToFile(fetch, `${origin}/start`, destination);
      assert.ok(fs.readFileSync(destination).equals(payload));
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed, stalled or oversized download ends with an error and no file', async () => {
  const dir = workspace();
  try {
    const destination = path.join(dir, 'tool.tgz');
    await withServer((request, response) => {
      if (request.url === '/missing') { response.writeHead(404); response.end('no'); return; }
      if (request.url === '/stall') { response.writeHead(200); response.write('partial'); return; }   // never ends
      response.writeHead(200);
      response.end(Buffer.alloc(50_000));
    }, async (origin) => {
      await assert.rejects(downloadToFile(fetch, `${origin}/missing`, destination), /HTTP 404/);
      assert.equal(fs.existsSync(destination), false);

      const started = Date.now();
      await assert.rejects(downloadToFile(fetch, `${origin}/stall`, destination, { stallMs: 200 }), /download stalled/);
      assert.ok(Date.now() - started < 5000, 'a stalled download gives up promptly');
      assert.equal(fs.existsSync(destination), false);

      await assert.rejects(downloadToFile(fetch, `${origin}/big`, destination, { maxBytes: 10_000 }), /larger than expected/);
      assert.equal(fs.existsSync(destination), false);
    });
    await assert.rejects(downloadToFile(fetch, 'http://127.0.0.1:9/unreachable', destination));
    assert.equal(fs.existsSync(destination), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
