// Run explicitly on a desktop host: node --test scripts/video-transition-playback.test.js
// Uses real Chromium media with synthetic cue/clock messages, never a saved show.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const soakSeconds = Number(process.env.DWCUE_VIDEO_SOAK_SECONDS || 0);
if (!Number.isFinite(soakSeconds) || soakSeconds < 0) throw new Error('DWCUE_VIDEO_SOAK_SECONDS must be nonnegative');

async function electronCheck() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.DWCUE_VIDEO_TEST_DATA);
  let window;
  try {
    await app.whenReady();
    window = new BrowserWindow({
      title: 'DonWells Cue — isolated video transition check',
      width: 640, height: 360, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      process.stderr.write(`Video check renderer exited: ${JSON.stringify(details)}\n`);
      app.exit(1);
    });
    window.webContents.on('console-message', event => {
      if (event.message) process.stderr.write(`Renderer: ${event.message}\n`);
    });
    await window.loadURL(process.env.DWCUE_VIDEO_TEST_URL);
    window.showInactive();
    const ts = require('typescript');
    const source = await fs.readFile(process.env.DWCUE_VIDEO_TEST_CONTROLLER || path.resolve(__dirname,
      '../client/app/composables/useVideoOutput.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const vue = await fs.readFile(require.resolve('vue/dist/vue.runtime.global.prod.js'), 'utf8');
    await window.webContents.executeJavaScript(`${vue}\n;Object.assign(globalThis, Vue); void 0;`);
    await window.webContents.executeJavaScript(`(() => {
      const exports = {};
      ${compiled}
      const handlers = Object.fromEntries(['cue', 'meter', 'snapshot', 'patch'].map(key => [key, new Set()]));
      const reports = [];
      const uuids = ['a', 'audio', 'c', 'bad', 'bench-0', 'bench-1', 'bench-2', 'soak-hd'];
      const doc = { folderPath: '/isolated', settings: {},
        server: { projectSessionId: 'fixture', audioReadiness: { fileRevisions: Object.fromEntries(uuids.map(id => [id, 'v1'])) } },
        items: uuids.map(uuid => ({
        uuid, type: 'audio', hasVideo: uuid !== 'audio', mediaPath: uuid + '.mp4',
        inPoint: uuid.startsWith('bench-') ? 1.25 : 0, outPoint: uuid === 'soak-hd' ? 3 : 5,
      })) };
      globalThis.electronAPI = { videoOutput: { reportPlaybackError: value => { reports.push(value); } } };
      const server = reactive({
        connected: true, serverUrl: location.origin, effectiveAccessToken: '',
        devices: [{ is_clock_master: true, runtime_state: 'running' }],
        fetchProject: async () => doc,
        onCueState: fn => { handlers.cue.add(fn); return () => handlers.cue.delete(fn); },
        onMeters: fn => { handlers.meter.add(fn); return () => handlers.meter.delete(fn); },
        onPlaybackSnapshot: fn => { handlers.snapshot.add(fn); return () => handlers.snapshot.delete(fn); },
        onDocPatch: fn => { handlers.patch.add(fn); return () => handlers.patch.delete(fn); },
      });
      globalThis.useLiveplayServer = () => server;
      let controller;
      const playing = new Map();
      let ticks = 0;
      let presentedFrames = 0;
      let pendingGo = null;
      const latencies = [];
      const timer = setInterval(() => {
        ticks++;
        const items = [...playing.values()].map(cue => {
          if (cue.transport !== 4) cue.playhead_seconds += .05;
          return { cue_id: cue.cue_id, playhead_seconds: cue.playhead_seconds, transport: cue.transport };
        });
        for (const fn of handlers.meter) fn({ items });
      }, 50);
      createApp({
        setup() {
          controller = exports.useVideoOutput();
          onMounted(() => {
            const element = controller.videoEl.value;
            const observe = () => element.requestVideoFrameCallback((_time, metadata) => {
              presentedFrames++;
              if (pendingGo && controller.showVideo.value && element.currentSrc.includes('item_uuid=' + pendingGo.uuid)
                && metadata.mediaTime >= pendingGo.position - .04) {
                latencies.push(performance.now() - pendingGo.at);
                pendingGo = null;
              }
              observe();
            });
            observe();
          });
          return () => h('video', { ref: controller.videoEl, src: controller.videoSrc.value ?? undefined,
            muted: true, playsinline: true, preload: 'auto',
            style: { width: '100%', height: '100%', display: controller.showVideo.value ? '' : 'none' },
            onLoadedmetadata: controller.onVideoLoadedMetadata,
            onCanplay: controller.onVideoCanPlay, onError: controller.onVideoError });
        },
      }).mount('#app');
      globalThis.check = {
        reset() { for (const cue of [...playing.values()]) this.cue(cue.item_uuid, cue.trigger_seq, 0, cue.playhead_seconds); },
        next(uuid) { for (const fn of handlers.patch) fn({ op: 'next_item_set', itemUuid: uuid }); },
        measureGo(uuid, position) { pendingGo = { uuid, position, at: performance.now() }; },
        latencies,
        async standbyExperiment() {
          const onAir = controller.videoEl.value;
          const source = onAir.currentSrc;
          const beforeFrames = presentedFrames;
          const beforeDropped = onAir.getVideoPlaybackQuality().droppedVideoFrames;
          const probe = document.createElement('video');
          probe.muted = true;
          probe.playsInline = true;
          probe.preload = 'auto';
          probe.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0;pointer-events:none';
          document.body.append(probe);
          const started = performance.now();
          let timer;
          try {
            await new Promise((resolve, reject) => {
              timer = setTimeout(() => reject(new Error('standby decode timeout')), 5000);
              probe.onerror = () => reject(new Error('standby decode error'));
              probe.onloadedmetadata = () => { probe.currentTime = 1.25; void probe.play().catch(reject); };
              const observe = () => probe.requestVideoFrameCallback((_at, metadata) => {
                if (metadata.mediaTime < 1.21) { observe(); return; }
                probe.pause(); resolve();
              });
              observe();
              probe.src = location.origin + '/api/media?item_uuid=standby-hd';
            });
            const preparationMs = performance.now() - started;
            const go = performance.now();
            const frame = new Promise(resolve => probe.requestVideoFrameCallback(() => resolve(performance.now() - go)));
            probe.style.cssText = 'position:fixed;inset:0;width:100%;height:100%';
            await probe.play();
            const goMs = await frame;
            return { preparationMs, goMs, onAirSourcePreserved: source === onAir.currentSrc,
              onAirFramesDuringPreparation: presentedFrames - beforeFrames,
              onAirDropped: onAir.getVideoPlaybackQuality().droppedVideoFrames - beforeDropped,
              probeWidth: probe.videoWidth, decoderSlots: 2 };
          } finally { clearTimeout(timer); probe.pause(); probe.removeAttribute('src'); probe.load(); probe.remove(); }
        },
        cue(uuid, seq, transport = 1, position = 0) {
          const cue = { item_uuid: uuid, cue_id: 'cue-' + uuid, trigger_seq: seq,
            transport, playhead_seconds: position };
          if (transport === 0) playing.delete(uuid); else playing.set(uuid, cue);
          for (const fn of handlers.cue) fn(cue);
        },
        state() {
          const el = controller.videoEl.value;
          const quality = el.getVideoPlaybackQuality();
          return { show: controller.showVideo.value, failed: reports.at(-1) != null,
            paused: el.paused, currentTime: el.currentTime, width: el.videoWidth,
            source: el.currentSrc, reports, ticks, presentedFrames,
            quality: { totalVideoFrames: quality.totalVideoFrames, droppedVideoFrames: quality.droppedVideoFrames },
            pictureHealth: controller.getPictureHealth() };
        },
        stop() { clearInterval(timer); },
      };
    })()`);
    const run = code => window.webContents.executeJavaScript(code);
    const waitFor = async (predicate, label) => {
      for (let i = 0; i < 200; i++) {
        if (await run(predicate)) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error(`${label}: ${JSON.stringify(await run('check.state()'))}`);
    };
    await run('check.cue("a", 1)');
    // Delay the actual media response so rapid cueing interrupts asynchronous play.
    await new Promise(resolve => setTimeout(resolve, 100));
    await run('check.cue("audio", 2)');
    await run('fetch("/release").then(response => response.text())');
    await new Promise(resolve => setTimeout(resolve, 100));
    await run('check.cue("a", 3)');
    await waitFor('check.state().show && !check.state().paused && check.state().width > 0',
      'video → audio → same video did not recover');
    await waitFor('check.state().currentTime > .1', 'decoded video did not advance');
    await run('check.cue("c", 4)');
    await waitFor('check.state().source.includes("item_uuid=c") && !check.state().paused && check.state().width > 0',
      'video → video did not start the replacement');
    await run('check.cue("c", 4, 4, 1.25)');
    await waitFor('check.state().paused && Math.abs(check.state().currentTime - 1.25) < .15',
      'paused video seek did not settle');
    await run('check.cue("c", 4, 1, 1.25)');
    await waitFor('!check.state().paused', 'video Resume did not recover');
    for (let index = 0; index < 10; index++) {
      await run(`check.cue("audio", ${5 + index * 2})`);
      await run(`check.cue("${index % 2 ? 'c' : 'a'}", ${6 + index * 2})`);
    }
    await waitFor('check.state().show && !check.state().paused && check.state().width > 0',
      'rapid video/audio/video cueing did not settle');
    const beforeFrames = await run('check.state().presentedFrames');
    await waitFor(`check.state().presentedFrames >= ${beforeFrames + 3}`,
      'replacement video stopped presenting decoded frames');
    const state = await run('check.state()');
    assert.ok(state.ticks >= 4, 'renderer clock/control loop stopped responding');
    assert.equal(state.failed, false);
    assert.ok(state.pictureHealth.presentedFrames > 0);
    assert.ok(state.pictureHealth.mediaTime >= 0);
    assert.ok(state.pictureHealth.presentedAgeMs < 1000, 'actual compositor frame metadata is current');
    assert.deepEqual(state.reports.filter(Boolean), []);
    const preparation = [];
    for (let index = 0; index < 3; index++) {
      await run('check.reset()');
      await run('check.cue("audio", ' + (100 + index * 2) + ')');
      const uuid = 'bench-' + index;
      await run('check.next("' + uuid + '")');
      await new Promise(resolve => setTimeout(resolve, 500));
      const warm = await run('check.state().pictureHealth');
      preparation.push(warm.sourceItemUuid === uuid && warm.preparedSeconds === 1.25);
      await run('check.measureGo("' + uuid + '", 1.25); check.cue("' + uuid + '", ' + (101 + index * 2) + ', 1, 1.25)');
      await waitFor('check.latencies.length > ' + index, 'no correct visible frame at benchmark GO');
    }
    const standby = await run('check.standbyExperiment()');
    assert.equal(standby.onAirSourcePreserved, true);
    assert.ok(standby.onAirFramesDuringPreparation > 0, 'standby preparation stopped current presentation');
    assert.equal(standby.probeWidth, 1920);
    const measurements = { preparedDuringAudio: preparation, goLatencyMs: await run('check.latencies'), standby };
    if (!process.env.DWCUE_VIDEO_TEST_CONTROLLER) assert.equal(preparation.every(Boolean), true, 'eligible next videos must decode/seek while audio remains on air');
    process.stdout.write('Preparation experiment: ' + JSON.stringify(measurements) + '\n');
    let refusalSequence = 200;
    if (soakSeconds > 0) {
      const start = Date.now();
      const initialFrames = await run('check.state().presentedFrames');
      let round = 0, sequence = 1_000, nextReport = start + 30_000;
      const samples = [];
      while (Date.now() - start < soakSeconds * 1_000) {
        const before = await run('check.state()');
        await run(`check.reset(); check.cue("audio", ${sequence++})`);
        await new Promise(resolve => setTimeout(resolve, 100));
        const uuid = round % 2 ? 'soak-hd' : 'a';
        const goAt = Date.now();
        await run(`check.cue("${uuid}", ${sequence++})`);
        await waitFor(`check.state().source.includes("item_uuid=${uuid}") && !check.state().paused && check.state().width > 0`,
          'soak cue did not start');
        await waitFor(`check.state().presentedFrames >= ${before.presentedFrames + 5}`, 'soak video stopped presenting');
        const goMs = Date.now() - goAt; // Ready picture plus five observed frames, not first-frame latency.
        await new Promise(resolve => setTimeout(resolve, 1_000));
        const primary = await run('check.state()');
        assert.equal(primary.width, uuid === 'soak-hd' ? 1920 : 320, 'soak did not decode the intended resolution');
        if (round % 3 === 0) {
          await run(`check.cue("c", ${sequence++})`);
          const frame = await run('check.state().presentedFrames');
          await waitFor(`check.state().presentedFrames >= ${frame + 3}`, 'soak video-to-video transition froze');
        }
        const current = await run('check.state()');
        assert.ok(current.ticks > before.ticks, 'soak renderer/control clock froze');
        assert.ok(current.pictureHealth.presentedAgeMs < 1_000, 'soak picture became stale');
        assert.equal(current.failed, false, JSON.stringify(current.reports));
        const metrics = app.getAppMetrics();
        const renderer = metrics.find(metric => metric.pid === window.webContents.getOSProcessId());
        assert.ok(Number.isFinite(renderer?.memory.workingSetSize), 'soak renderer memory sample unavailable');
        assert.ok(Number.isFinite(primary.quality.totalVideoFrames) &&
          Number.isFinite(primary.quality.droppedVideoFrames), 'soak frame-quality sample unavailable');
        samples.push({ elapsedMs: Date.now() - start, round, uuid, goMs,
          presentedFrames: current.presentedFrames - initialFrames,
          totalFrames: current.quality.totalVideoFrames, droppedFrames: current.quality.droppedVideoFrames,
          primaryFrames: primary.quality.totalVideoFrames, primaryDroppedFrames: primary.quality.droppedVideoFrames,
          rendererWorkingSetKB: renderer?.memory.workingSetSize ?? null,
          gpuWorkingSetKB: metrics.filter(metric => metric.type === 'GPU').map(metric => metric.memory.workingSetSize) });
        ++round;
        if (Date.now() >= nextReport) {
          process.stdout.write('Video soak progress: ' + JSON.stringify(samples.at(-1)) + '\n');
          nextReport = Date.now() + 30_000;
        }
      }
      assert.ok(samples.length >= 2, 'soak needs repeated transitions');
      refusalSequence = sequence;
      process.stdout.write('Video soak result: ' + JSON.stringify({ durationMs: Date.now() - start,
        rounds: round, presentedFrames: samples.at(-1).presentedFrames, samples }) + '\n');
    }
    await run(`check.cue("bad", ${refusalSequence})`);
    await waitFor('check.state().failed', 'unplayable exact file must report player failure');
    assert.equal((await run('check.state().pictureHealth')).preparedSeconds, null);
    await run('check.stop()');
    process.stdout.write(`Real Chromium video transitions passed: ${JSON.stringify(state)}\n`);
    window.destroy();
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error.stack}\n`);
    if (window && !window.isDestroyed()) window.destroy();
    app.exit(1);
  }
}

if (process.versions.electron) {
  void electronCheck();
} else {
  const test = require('node:test');
  const http = require('node:http');
  const os = require('node:os');
  test('real Chromium transitions, decode refusal, preparation and optional mixed-media soak', { timeout: 60000 + soakSeconds * 1000 }, async t => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'dwcue-video-transitions-'));
    const media = path.join(folder, 'moving-test.mp4');
    await promisify(execFile)(require('@ffmpeg-installer/ffmpeg').path, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
      '-t', '5', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', media,
    ]);
    const bytes = await fs.readFile(media);
    const hd = path.join(folder, 'hd-test.mp4');
    await promisify(execFile)(require('@ffmpeg-installer/ffmpeg').path, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
      '-t', '3', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', hd,
    ]);
    const hdBytes = await fs.readFile(hd);
    const mediaDelays = new Map();
    const pending = new Set();
    let hold = true;
    const server = http.createServer((request, response) => {
      if (request.url === '/') return response.writeHead(200, { 'Content-Type': 'text/html',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'" }).end('<div id="app"></div>');
      if (request.url === '/release') {
        hold = false;
        for (const send of pending) send();
        pending.clear();
        return response.end('released');
      }
      const uuid = new URL(request.url, 'http://fixture').searchParams.get('item_uuid');
      const content = uuid === 'bad' ? Buffer.from('Not a decodable video')
        : uuid === 'standby-hd' || uuid === 'soak-hd' ? hdBytes : bytes;
      if ((uuid?.startsWith('bench-') || uuid === 'standby-hd') && !mediaDelays.has(uuid)) mediaDelays.set(uuid, Date.now() + 250);
      const send = () => {
        if (response.destroyed) return;
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
        const begin = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), content.length - 1) : content.length - 1;
        response.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
          'Content-Length': end - begin + 1, 'Cache-Control': 'no-store',
          ...(range ? { 'Content-Range': `bytes ${begin}-${end}/${content.length}` } : {}) });
        response.end(content.subarray(begin, end + 1));
      };
      const delayedSend = () => setTimeout(send, Math.max(0, (mediaDelays.get(uuid) ?? 0) - Date.now()));
      if (hold) pending.add(delayedSend); else delayedSend();
    });
    let child;
    t.after(async () => {
      if (child && child.exitCode === null) child.kill('SIGKILL');
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await fs.rm(folder, { recursive: true, force: true });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    child = spawn(require('electron'), [__filename], { env: { ...process.env,
      ELECTRON_RUN_AS_NODE: '', DWCUE_VIDEO_TEST_DATA: path.join(folder, 'userData'),
      DWCUE_VIDEO_TEST_URL: `http://127.0.0.1:${server.address().port}/` },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0, output);
  });
}
