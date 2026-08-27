import assert from 'node:assert/strict';
import test from 'node:test';

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
