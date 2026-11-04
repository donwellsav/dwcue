import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, reactive, ref, watch } from 'vue';

import { waitForDownloadedMediaReady } from '../app/utils/youtubeImport.ts';

test('retries a transient media readiness failure without importing', async () => {
  let probes = 0;
  const sleeps: number[] = [];

  await waitForDownloadedMediaReady(
    async () => {
      probes++;
      if (probes < 2) throw new Error('waveform not ready');
    },
    () => true,
    { delayMs: 25, sleep: async ms => { sleeps.push(ms); } },
  );

  assert.equal(probes, 2);
  assert.deepEqual(sleeps, [25]);
});

test('stops before the next probe when the project changes', async () => {
  let probes = 0;
  let current = true;

  await assert.rejects(
    waitForDownloadedMediaReady(
      async () => {
        probes++;
        current = false;
        throw new Error('transient');
      },
      () => current,
      { sleep: async () => {} },
    ),
    error => error instanceof DOMException && error.name === 'AbortError',
  );

  assert.equal(probes, 1);
});

test('reports a persistent readiness failure after bounded attempts', async () => {
  let probes = 0;

  await assert.rejects(
    waitForDownloadedMediaReady(
      async () => {
        probes++;
        throw new Error('decode failed');
      },
      () => true,
      { attempts: 3, sleep: async () => {} },
    ),
    /decode failed/,
  );

  assert.equal(probes, 3);
});

test('readiness cancellation reaches the probe and prevents retries', async () => {
  const controller = new AbortController();
  let probes = 0;
  await assert.rejects(waitForDownloadedMediaReady(async signal => {
    probes++;
    assert.equal(signal, controller.signal);
    controller.abort();
    throw new DOMException('Cancelled', 'AbortError');
  }, () => true, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(probes, 1);

  await assert.rejects(waitForDownloadedMediaReady(async () => {
    probes++;
  }, () => true, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(probes, 1, 'a cancelled job must not start another probe');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function modalHarness(metadata = async (_signal?: AbortSignal) => ({ valid: true, duration_ms: 1000 })) {
  const source = readFileSync(new URL('../app/components/YouTubeImportModal.vue', import.meta.url), 'utf8');
  const script = parse(source).descriptor.scriptSetup!.content
    .replace(/^import .*;\s*$/gm, '')
    .replaceAll('import.meta.client', 'true');
  const props = reactive({ isOpen: true, projectFolderPath: '/shows/A', projectEpoch: 1 });
  const downloads: Array<ReturnType<typeof deferred<{ file: string; title: string }>>> = [];
  const probes: AbortSignal[] = [];
  const imports: Array<{ signal?: AbortSignal; pending: ReturnType<typeof deferred<any>> }> = [];
  const watchers: Array<() => void> = [];
  const unmounts: Array<() => void> = [];
  let progress: (value: unknown) => void = () => {};
  const dependencies = {
    ref, computed,
    watch: (...args: any[]) => { const stop = (watch as any)(...args); watchers.push(stop); return stop; },
    onBeforeUnmount: (callback: () => void) => unmounts.push(callback),
    useLocalization: () => ({ t: (key: string) => key }),
    useProject: () => ({ currentProject: ref({ settings: {} }) }),
    useLiveplayServer: () => ({
      fetchMetadata: async (_path: string, signal?: AbortSignal) => {
        if (signal) probes.push(signal);
        return metadata(signal);
      },
      fetchWaveformByPath: async () => {
        throw new Error('readiness must not decode a second full waveform');
      },
    }),
    defineProps: () => Object.assign(props, {
      importFiles: async (_files: string[], signal?: AbortSignal) => {
        const pending = deferred<any>();
        imports.push({ signal, pending });
        return pending.promise;
      },
    }),
    defineEmits: () => () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    waitForDownloadedMediaReady,
    window: { electronAPI: {
      downloadYouTubeAudio: (...args: any[]) => {
        progress = args.at(-1);
        const pending = deferred<{ file: string; title: string }>();
        downloads.push(pending);
        return pending.promise;
      },
      cancelYouTubeDownload: async () => true,
    } },
    console: { error: () => {} },
  };
  const compiled = ts.transpileModule(script, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modal = Function(...Object.keys(dependencies), `${compiled}\nreturn { downloadVideo, downloadQueue, cancelDownload, retryImport, retryDownload, closeModal };`)(...Object.values(dependencies));
  return {
    modal, props, downloads, imports, probes,
    progress: (value: unknown) => progress(value),
    dispose: () => { unmounts.forEach(callback => callback()); watchers.forEach(stop => stop()); },
    unmount: () => unmounts.forEach(callback => callback()),
  };
}

async function importingDownload(harness: ReturnType<typeof modalHarness>) {
  const pending = harness.modal.downloadVideo({ id: 'video-1', title: 'Video' });
  harness.downloads[0]!.resolve({ file: '/shows/A/media/video.m4a', title: 'Video' });
  for (let i = 0; i < 20 && harness.imports.length === 0; i++) await Promise.resolve();
  assert.equal(harness.imports.length, 1);
  return { pending, item: harness.modal.downloadQueue.value[0] };
}

test('cancelling YouTube import aborts preflight and shared import without late completion', async t => {
  const harness = modalHarness();
  t.after(harness.dispose);
  const { pending, item } = await importingDownload(harness);
  const signal = harness.imports[0]!.signal;
  assert.ok(signal, 'the shared import must receive its job cancellation signal');
  assert.equal(harness.probes.length, 1);
  assert.ok(harness.probes.every(probe => probe === signal));
  await harness.modal.cancelDownload(item);
  assert.equal(signal.aborted, true);
  harness.progress({ percentage: 100, status: 'completed' });
  harness.imports[0]!.pending.resolve({ success: true, imported: 1 });
  await pending;
  assert.equal(item.status, 'cancelled');
});

test('cancelling during metadata readiness prevents project import', async t => {
  const harness = modalHarness(signal => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
  }));
  t.after(harness.dispose);
  const pending = harness.modal.downloadVideo({ id: 'video-1', title: 'Video' });
  harness.downloads[0]!.resolve({ file: '/shows/A/media/video.m4a', title: 'Video' });
  for (let i = 0; i < 20 && harness.probes.length === 0; i++) await Promise.resolve();
  assert.equal(harness.probes.length, 1);
  const item = harness.modal.downloadQueue.value[0];
  await harness.modal.cancelDownload(item);
  await pending;
  assert.equal(harness.probes[0]!.aborted, true);
  assert.equal(harness.imports.length, 0);
  assert.equal(item.status, 'cancelled');
});

test('retry import gets a fresh signal and cancellation fences its late success', async t => {
  const harness = modalHarness();
  t.after(harness.dispose);
  const { pending, item } = await importingDownload(harness);
  harness.imports[0]!.pending.resolve({ success: false, imported: 0, error: 'temporary failure' });
  await pending;
  assert.equal(item.status, 'error');
  const retry = harness.modal.retryImport(item);
  for (let i = 0; i < 20 && harness.imports.length < 2; i++) await Promise.resolve();
  assert.equal(harness.imports.length, 2);
  assert.notEqual(harness.imports[1]!.signal, harness.imports[0]!.signal);
  await harness.modal.cancelDownload(item);
  assert.equal(harness.imports[1]!.signal?.aborted, true);
  harness.imports[1]!.pending.resolve({ success: true, imported: 1 });
  await retry;
  assert.equal(item.status, 'cancelled');
});

test('close, project change and unmount fence late imports and retries', async t => {
  for (const stop of ['close', 'project', 'unmount']) {
    const harness = modalHarness();
    t.after(harness.dispose);
    const { pending, item } = await importingDownload(harness);
    if (stop === 'close') await harness.modal.closeModal();
    if (stop === 'project') harness.props.projectEpoch++;
    if (stop === 'unmount') harness.unmount();
    const signal = harness.imports[0]!.signal;
    assert.equal(signal?.aborted, true, stop);
    harness.imports[0]!.pending.resolve({ success: true, imported: 1 });
    await pending;
    assert.equal(item.status, 'cancelled', stop);
    await harness.modal.retryImport(item);
    harness.modal.retryDownload(item);
    assert.equal(harness.imports.length, 1, `${stop}: import retry must not mutate the project`);
    assert.equal(harness.downloads.length, 1, `${stop}: download retry must not use the new project`);
  }
});
