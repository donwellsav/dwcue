import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computed,
  effectScope,
  nextTick,
  onScopeDispose,
  reactive,
  ref,
  shallowRef,
  watch,
  toRaw,
} from 'vue';

import { useVideoOutput } from '../app/composables/useVideoOutput.ts';

Object.assign(globalThis, {
  computed,
  onScopeDispose,
  ref,
  shallowRef,
  watch,
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

interface MockVideo {
  currentTime: number;
  currentSrc: string;
  readyState: number;
  seeking: boolean;
  videoWidth: number;
  videoHeight: number;
  paused: boolean;
  playbackRate: number;
  pauseCount: number;
  playCount: number;
  playError: Error | null;
  frameCallbacks: Map<number, (timestamp: number, metadata?: any) => void>;
  nextFrameId: number;
  pause: () => void;
  play: () => Promise<void>;
  requestVideoFrameCallback: (callback: (timestamp: number, metadata?: any) => void) => number;
  cancelVideoFrameCallback: (id: number) => void;
  fireVideoFrame: (timestamp: number, metadata?: any) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function audioItem(
  uuid: string,
  options: {
    hasVideo?: boolean;
    imagePath?: string;
    mediaPath?: string;
    mediaServerPath?: string;
    inPoint?: number;
    outPoint?: number;
    loop?: boolean;
  } = {},
) {
  return {
    uuid,
    type: 'audio',
    hasVideo: options.hasVideo === true,
    imagePath: options.imagePath,
    mediaPath: options.mediaPath ?? `media/${uuid}.mp4`,
    mediaServerPath: options.mediaServerPath,
    inPoint: options.inPoint ?? 0,
    outPoint: options.outPoint ?? 20,
    endBehavior: { action: options.loop ? 'loop' : 'nothing' },
  };
}

function project(items: unknown[], quickPlayItems: unknown[] = []) {
  return {
    folderPath: '/shows/current',
    items,
    quickPlayItems,
    settings: { videoStandbyImage: 'images/standby.png' },
  };
}

function videoElement(): MockVideo {
  return {
    currentTime: 0,
    currentSrc: '',
    readyState: 4,
    seeking: false,
    videoWidth: 640,
    videoHeight: 360,
    paused: true,
    playbackRate: 1,
    pauseCount: 0,
    playCount: 0,
    playError: null,
    frameCallbacks: new Map(),
    nextFrameId: 1,
    pause() {
      this.paused = true;
      this.pauseCount += 1;
    },
    async play() {
      this.playCount += 1;
      if (this.playError) throw this.playError;
      this.paused = false;
    },
    requestVideoFrameCallback(callback) {
      const id = this.nextFrameId;
      this.nextFrameId += 1;
      this.frameCallbacks.set(id, callback);
      return id;
    },
    cancelVideoFrameCallback(id) {
      this.frameCallbacks.delete(id);
    },
    fireVideoFrame(timestamp, metadata) {
      const callbacks = Array.from(this.frameCallbacks.values());
      this.frameCallbacks.clear();
      for (const callback of callbacks) callback(timestamp, metadata);
    },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

// Timing aside, tests see a start land on the playhead: no learned start lead.
function createHarness(initialProject: unknown, connected = true, captureApi = {}, startLead: string | null = '0',
  pictureOffsetMs = 0) {
  const stored = new Map<string, string>(startLead === null ? [] : [['dwcue.videoStartLead', startLead]]);
  const cueStateHandlers = new Set<(value: unknown) => void>();
  const meterHandlers = new Set<(value: any) => void>();
  const snapshotHandlers = new Set<(value: unknown) => void>();
  const patchHandlers = new Set<(value: unknown) => void>();
  const reports: Array<{ itemUuid: string | null; message: string } | null> = [];
  let fetchProject = async (_signal?: AbortSignal) => initialProject;

  const server = reactive({
    connected,
    devices: [{
      id: 'clock',
      is_clock_master: true,
      is_open: true,
      is_available: true,
      runtime_state: 'running',
    }],
    serverUrl: 'http://127.0.0.1:4480',
    effectiveAccessToken: 'secret-token',
    fetchProject: (signal?: AbortSignal) => fetchProject(signal),
    onCueState(handler: (value: unknown) => void) {
      cueStateHandlers.add(handler);
      return () => cueStateHandlers.delete(handler);
    },
    onMeters(handler: (value: any) => void) {
      meterHandlers.add(handler);
      return () => meterHandlers.delete(handler);
    },
    onPlaybackSnapshot(handler: (value: unknown) => void) {
      snapshotHandlers.add(handler);
      return () => snapshotHandlers.delete(handler);
    },
    onDocPatch(handler: (value: unknown) => void) {
      patchHandlers.add(handler);
      return () => patchHandlers.delete(handler);
    },
  });

  Object.assign(globalThis, {
    window: {
      setTimeout,
      localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } },
      electronAPI: {
        videoOutput: {
          ...captureApi,
          reportPlaybackError(payload: { itemUuid: string | null; message: string } | null) {
            reports.push(payload);
          },
        },
      },
    },
    useLiveplayServer: () => server,
  });

  const scope = effectScope();
  const diagnostic = shallowRef<VideoTestCardPlayback | null>(null);
  const controller = scope.run(() => useVideoOutput(diagnostic, ref(pictureOffsetMs)));
  assert.ok(controller);
  const element = videoElement();
  controller.videoEl.value = element as unknown as HTMLVideoElement;

  return {
    controller,
    diagnostic,
    element,
    reports,
    server,
    setFetchProject(next: (signal?: AbortSignal) => Promise<unknown>) {
      fetchProject = next;
    },
    emitCue(value: unknown) {
      for (const handler of cueStateHandlers) handler(value);
    },
    emitMeters(value: unknown) {
      for (const handler of meterHandlers) handler(value);
    },
    emitSnapshot(value: unknown) {
      for (const handler of snapshotHandlers) handler(value);
    },
    emitPatch(value: unknown) {
      for (const handler of patchHandlers) handler(value);
    },
    stop() {
      scope.stop();
    },
  };
}

test('the pictures shown are the ones saved in the show: the cue picture, else the standby picture', async () => {
  // A captured picture is saved into the show and set as one of these two, so
  // nothing held outside the show can appear on the output.
  let asked = 0;
  const h = createHarness({
    ...project([audioItem('authored', { imagePath: 'images/manual.png' }), audioItem('plain')]),
    server: { projectSessionId: 'show' },
  }, true, { getStandbyCapture: async () => { asked += 1; return { standby: 'data:x', cue: 'data:y' }; } });
  await flush();
  assert.match(h.controller.standbySrc.value ?? '', /standby\.png/);
  h.emitCue(snapshotCue('plain', 'cue1', 1));
  await flush();
  assert.equal(h.controller.cueImageSrc.value, null);
  h.emitCue(snapshotCue('authored', 'cue2', 2));
  await flush();
  assert.match(h.controller.cueImageSrc.value ?? '', /manual\.png/);
  assert.equal(asked, 0);
  h.stop();
});

function snapshotCue(
  itemUuid: string,
  cueId: string,
  triggerSeq: number,
  playheadSeconds = 0,
  transport = 1,
) {
  return {
    item_uuid: itemUuid,
    cue_id: cueId,
    trigger_seq: triggerSeq,
    playhead_seconds: playheadSeconds,
    transport,
  };
}

test('an intentional video-to-audio pause cannot poison a later play of the same video', async () => {
  const h = createHarness(project([audioItem('video', { hasVideo: true }), audioItem('audio')]));
  await flush();
  const pendingPlay = deferred<void>();
  h.element.play = function () {
    this.playCount += 1;
    this.paused = false;
    return pendingPlay.promise;
  };
  h.emitCue(snapshotCue('video', 'video-cue', 1));
  h.controller.onVideoCanPlay();
  h.emitCue(snapshotCue('audio', 'audio-cue', 2));
  pendingPlay.reject(new DOMException('Playback was intentionally paused.', 'AbortError'));
  await flush();
  assert.equal(h.reports.some(report => report !== null), false, 'cancellation is not a decoder failure');

  h.element.play = videoElement().play;
  const attempts = h.element.playCount;
  h.emitCue(snapshotCue('video', 'video-cue', 3));
  assert.equal(h.controller.showVideo.value, true);
  assert.equal(h.element.paused, false);
  assert.equal(h.element.playCount, attempts + 1, 'the unchanged media URL can play again');
  h.stop();
});

test('a video switch waits for its source and ignores the old play promise and media events', async () => {
  const h = createHarness(project([
    audioItem('first', { hasVideo: true }), audioItem('second', { hasVideo: true }),
  ]));
  await flush();
  const firstPlay = deferred<void>();
  h.element.play = function () {
    this.playCount += 1;
    this.paused = false;
    return firstPlay.promise;
  };
  h.emitCue(snapshotCue('first', 'first-cue', 1));
  const firstSource = h.controller.videoSrc.value!;
  h.element.currentSrc = firstSource;
  h.controller.onVideoCanPlay();
  assert.equal(h.element.playCount, 1);

  h.emitCue(snapshotCue('second', 'second-cue', 2));
  assert.equal(h.element.paused, true);
  assert.equal(h.element.playCount, 1, 'the old DOM resource is not played for the new cue');
  h.element.videoWidth = 0;
  h.element.videoHeight = 0;
  h.controller.onVideoLoadedMetadata();
  h.controller.onVideoCanPlay();
  h.controller.onVideoError();
  firstPlay.reject(new DOMException('The resource was replaced.', 'AbortError'));
  await flush();
  assert.equal(h.reports.some(report => report !== null), false);

  h.element.currentSrc = h.controller.videoSrc.value!;
  h.element.videoWidth = 640;
  h.element.videoHeight = 360;
  h.element.play = videoElement().play;
  h.controller.onVideoLoadedMetadata();
  h.controller.onVideoCanPlay();
  assert.equal(h.controller.showVideo.value, true);
  assert.equal(h.element.paused, false);
  assert.equal(h.element.playCount, 2);
  h.stop();
});

test('a late play rejection cannot stop a newer trigger of the same media URL', async () => {
  const h = createHarness(project([audioItem('video', { hasVideo: true })]));
  await flush();
  const oldPlay = deferred<void>();
  h.element.play = function () {
    this.playCount += 1;
    this.paused = false;
    return this.playCount === 1 ? oldPlay.promise : Promise.resolve();
  };
  h.emitCue(snapshotCue('video', 'video-cue', 1));
  h.controller.onVideoCanPlay();
  h.emitCue(snapshotCue('video', 'video-cue', 2));
  oldPlay.reject(new Error('A superseded attempt failed.'));
  await flush();
  assert.equal(h.element.playCount, 2);
  assert.equal(h.controller.showVideo.value, true);
  assert.equal(h.element.paused, false);
  assert.equal(h.reports.some(report => report !== null), false);
  h.stop();
});

test('fallback to an on-air video uses the native position received while an audio cue owned the picture', async () => {
  const h = createHarness(project([audioItem('video', { hasVideo: true }), audioItem('audio'), audioItem('upcoming', { hasVideo: true })]));
  await flush();
  h.emitCue(snapshotCue('video', 'video-cue', 1, 2));
  h.controller.onVideoCanPlay();
  h.emitCue(snapshotCue('audio', 'audio-cue', 2));
  const retainedSource = h.controller.videoSrc.value;
  h.emitPatch({ op: 'next_item_set', itemUuid: 'upcoming' });
  await flush();
  const sourceDuringOverlay = h.controller.videoSrc.value;
  h.emitMeters({ items: [
    { cue_id: 'video-cue', transport: 1, playhead_seconds: 9 },
    { cue_id: 'audio-cue', transport: 1, playhead_seconds: 1 },
  ] });
  h.emitCue(snapshotCue('audio', 'audio-cue', 2, 1, 0));
  assert.equal(h.controller.showVideo.value, true);
  assert.equal(h.element.currentTime, 9);
  assert.equal(h.element.paused, false, 'fallback must resume its retained decoded source immediately');
  assert.equal(sourceDuringOverlay, retainedSource, 'upcoming preparation cannot evict a retained video fallback');
  h.stop();
});

test('a stopped background meter cannot revive that video when the foreground stops', async () => {
  for (const healthy of [true, false]) {
    const h = createHarness(project([
      audioItem('older-image', { imagePath: 'images/older.png' }),
      audioItem('video', { hasVideo: true }), audioItem('foreground'),
    ]));
    await flush();
    h.emitCue(snapshotCue('older-image', 'image-cue', 1));
    h.emitCue(snapshotCue('video', 'video-cue', 2));
    h.controller.onVideoCanPlay();
    h.emitCue(snapshotCue('foreground', 'foreground-cue', 3));
    if (!healthy) {
      h.server.devices[0]!.runtime_state = 'stalled';
      await nextTick();
    }
    h.emitMeters({ items: [{ cue_id: 'video-cue', transport: 0, playhead_seconds: 5 }] });
    h.emitCue(snapshotCue('foreground', 'foreground-cue', 3, 1, 0));
    assert.equal(h.controller.showVideo.value, false);
    assert.match(h.controller.cueImageSrc.value!, /images%2Folder\.png/);
    h.stop();
  }
});

test('a stopped current meter selects the fallback even without its meter in the batch', async () => {
  for (const includeFallbackMeter of [false, true]) {
    const h = createHarness(project([
      audioItem('background', { hasVideo: true }), audioItem('foreground', { hasVideo: true }),
    ]));
    await flush();
    h.emitCue(snapshotCue('background', 'background-cue', 1, 2));
    h.controller.onVideoCanPlay();
    h.emitCue(snapshotCue('foreground', 'foreground-cue', 2));
    h.controller.onVideoCanPlay();
    h.emitMeters({ items: [
      { cue_id: 'foreground-cue', transport: 0, playhead_seconds: 5 },
      ...(includeFallbackMeter ? [{ cue_id: 'background-cue', transport: 1, playhead_seconds: 9 }] : []),
    ] });
    assert.equal(new URL(h.controller.videoSrc.value!).searchParams.get('item_uuid'), 'background');
    h.controller.onVideoCanPlay();
    assert.equal(h.element.currentTime, includeFallbackMeter ? 9 : 2);
    assert.equal(h.controller.showVideo.value, true);
    assert.equal(h.element.paused, false);
    h.stop();
  }
});

test('stopped meters for every normal cue return the audience output to black', async () => {
  const doc = project([
    audioItem('image', { imagePath: 'images/still.png' }), audioItem('video', { hasVideo: true }),
  ]);
  doc.settings.videoStandbyImage = '';
  const h = createHarness(doc);
  await flush();
  h.emitCue(snapshotCue('image', 'image-cue', 1));
  h.emitCue(snapshotCue('video', 'video-cue', 2));
  h.controller.onVideoCanPlay();
  h.server.devices[0]!.runtime_state = 'stalled';
  await nextTick();
  h.emitMeters({ items: [
    { cue_id: 'video-cue', transport: 0, playhead_seconds: 5 },
    { cue_id: 'image-cue', transport: 0, playhead_seconds: 5 },
  ] });
  assert.equal(h.controller.showVideo.value, false);
  assert.equal(h.controller.cueImageSrc.value, null);
  assert.equal(h.controller.standbySrc.value, null);
  assert.equal(h.element.paused, true);
  h.stop();
});

test('a diagnostic stopped meter retains its separate paused-picture behavior', async () => {
  const h = createHarness(project([audioItem('program', { imagePath: 'images/program.png' })]));
  await flush();
  h.emitCue(snapshotCue('program', 'program-cue', 1));
  h.diagnostic.value = { cueId: 'diagnostic', path: '/bundled/card.webm', duration: 4, description: 'Program output' };
  await flush();
  h.emitCue({ cue_id: 'diagnostic', transport: 1, playhead_seconds: 2 });
  h.controller.onVideoCanPlay();
  h.emitMeters({ items: [{ cue_id: 'diagnostic', transport: 0, playhead_seconds: 2 }] });
  assert.equal(new URL(h.controller.videoSrc.value!).searchParams.get('path'), '/bundled/card.webm');
  assert.equal(h.controller.showVideo.value, true);
  assert.equal(h.element.paused, true);
  h.stop();
});

test('an unknown newest cue blanks old media until its document arrives', async () => {
  const video = audioItem('video', { hasVideo: true, imagePath: 'images/video.png' });
  const h = createHarness(project([video]));
  await flush();
  h.emitCue(snapshotCue('video', 'video-cue', 1, 6));
  h.controller.onVideoCanPlay();
  const pendingDoc = deferred<unknown>();
  h.setFetchProject(() => pendingDoc.promise);
  h.emitCue(snapshotCue('new-audio', 'new-cue', 2));
  h.emitMeters({ items: [{ cue_id: 'new-cue', transport: 1, playhead_seconds: 0.5 }] });
  assert.equal(h.controller.showVideo.value, false);
  assert.equal(h.controller.cueImageSrc.value, null);
  assert.equal(h.element.paused, true);
  assert.equal(h.element.currentTime, 6, 'the new cue clock never seeks the old video');
  pendingDoc.resolve(project([video, audioItem('new-audio')]));
  await flush();
  assert.equal(h.controller.showVideo.value, false);
  assert.equal(h.element.paused, true);
  h.stop();
});

test('repeated metadata failures recover the same on-air video at its current playhead', { timeout: 4000 }, async () => {
  const h = createHarness(project([]));
  try {
    await flush();
    const retry = deferred<void>();
    let requests = 0;
    h.setFetchProject(async () => {
      if (++requests <= 2) throw new Error('Temporary project read failure');
      retry.resolve();
      return project([audioItem('late-video', { hasVideo: true })]);
    });
    h.emitCue(snapshotCue('late-video', 'late-cue', 1));
    h.emitMeters({ items: [{ cue_id: 'late-cue', transport: 1, playhead_seconds: 1.25 }] });
    assert.equal(h.controller.showVideo.value, false);
    await flush();
    assert.match(h.reports.at(-1)?.message ?? '', /Video Output is retrying/);

    await retry.promise;
    await flush();
    assert.equal(requests, 3);
    assert.equal(h.reports.at(-1), null);
    const source = h.controller.videoSrc.value;
    assert.ok(source);
    assert.equal(new URL(source).searchParams.get('item_uuid'), 'late-video');
    h.element.currentSrc = source;
    h.controller.onVideoLoadedMetadata();
    h.controller.onVideoCanPlay();
    assert.equal(h.element.currentTime, 1.25);
    assert.equal(h.controller.showVideo.value, true);
  } finally { h.stop(); }
});

test('Stop All aborts an unresolved cue lookup and rejects late picture', async () => {
  const h = createHarness(project([]));
  try {
    await flush();
    h.emitMeters({ stop_revision: 0, items: [] });
    const pending = deferred<unknown>();
    let requestSignal: AbortSignal | undefined;
    h.setFetchProject(signal => { requestSignal = signal; return pending.promise; });
    h.emitCue(snapshotCue('late-video', 'late-cue', 1));
    assert.equal(requestSignal?.aborted, false);

    h.emitMeters({ stop_revision: 1, items: [{ cue_id: 'late-cue', transport: 3, playhead_seconds: 1 }] });
    assert.equal(requestSignal?.aborted, true);
    pending.resolve(project([audioItem('late-video', { hasVideo: true })]));
    await flush();
    assert.equal(h.controller.showVideo.value, false);
    assert.equal(h.controller.videoSrc.value, null);
  } finally { h.stop(); }
});

test('project lifecycle changes clear audience media before the new document arrives', async () => {
  const h = createHarness(project([audioItem('old', { hasVideo: true, imagePath: 'images/old.png' })]));
  await flush();
  h.emitCue(snapshotCue('old', 'old-cue', 5, 1));
  h.controller.onVideoCanPlay();
  assert.ok(h.controller.cueImageSrc.value);
  assert.ok(h.controller.videoSrc.value);
  h.setFetchProject(async () => project([]));
  h.emitPatch({ op: 'project_changed' });
  assert.equal(h.controller.cueImageSrc.value, null);
  assert.equal(h.controller.videoSrc.value, null);
  assert.equal(h.controller.standbySrc.value, null);
  assert.equal(h.controller.showVideo.value, false);
  assert.equal(h.element.paused, true);
  h.stop();
});

test('an old document fetch cannot restore projection after project close', async () => {
  const h = createHarness(project([audioItem('old', { imagePath: 'images/old.png' })]));
  await flush();
  h.emitCue(snapshotCue('old', 'old-cue', 5, 1));
  const oldFetch = deferred<unknown>();
  h.setFetchProject(() => oldFetch.promise);
  h.emitSnapshot({ cues: [snapshotCue('old', 'old-cue', 5, 1)] });
  h.emitPatch({ op: 'project_changed' });
  oldFetch.resolve(project([audioItem('old', { imagePath: 'images/old.png' })]));
  await flush();
  assert.equal(h.controller.cueImageSrc.value, null);
  assert.equal(h.controller.standbySrc.value, null);
  h.stop();
});

test('resolves canonical group children and QuickPlay-only video through item_uuid', async () => {
  const groupChild = audioItem('group-child', { hasVideo: true, mediaPath: 'media/group.mp4' });
  const quickPlayOnly = audioItem('quickplay-only', {
    hasVideo: true,
    mediaServerPath: '/Volumes/media/quickplay.mp4',
  });
  const harness = createHarness(project([{
    uuid: 'group',
    type: 'group',
    children: [groupChild],
  }], [quickPlayOnly]));
  await flush();

  harness.emitSnapshot({
    cues: [snapshotCue('group-child', 'cue-group', 1, 2), snapshotCue('quickplay-only', 'cue-quickplay', 2, 3)],
    preview: null,
    next_item_uuid: '',
  });
  await flush();

  const quickPlayUrl = new URL(harness.controller.videoSrc.value!);
  assert.equal(quickPlayUrl.pathname, '/api/media');
  assert.equal(quickPlayUrl.searchParams.get('item_uuid'), 'quickplay-only');
  assert.equal(quickPlayUrl.searchParams.has('path'), false, 'absolute server paths never leak into video URLs');

  harness.emitCue(snapshotCue('group-child', 'cue-group', 3, 6));
  assert.equal(new URL(harness.controller.videoSrc.value!).searchParams.get('item_uuid'), 'group-child');
  harness.stop();
});

test('paused native seeks show the requested absolute frame and out-point looping cuts cleanly', async () => {
  const clip = audioItem('looping-video', {
    hasVideo: true,
    inPoint: 5,
    outPoint: 10,
    loop: true,
  });
  const harness = createHarness(project([clip]));
  await flush();
  harness.emitSnapshot({
    cues: [snapshotCue('looping-video', 'loop-cue', 4, 5)],
    preview: null,
    next_item_uuid: '',
  });
  harness.controller.onVideoCanPlay();
  await flush();

  harness.emitCue(snapshotCue('looping-video', 'loop-cue', 4, 7.5, 4));
  assert.equal(harness.element.currentTime, 7.5, 'paused seek remains file-absolute, not relative to inPoint');
  assert.equal(harness.element.paused, true);

  harness.emitCue(snapshotCue('looping-video', 'loop-cue', 4, 9.9, 1));
  harness.emitMeters({ items: [{ cue_id: 'loop-cue', transport: 1, playhead_seconds: 10 }] });
  assert.equal(harness.controller.showVideo.value, false, 'native out-point hides the final video frame immediately');
  assert.equal(harness.element.paused, true);

  harness.emitMeters({ items: [{ cue_id: 'loop-cue', transport: 1, playhead_seconds: 5.25 }] });
  assert.equal(harness.controller.showVideo.value, true, 'engine loop reset restores the picture');
  assert.equal(harness.element.currentTime, 5.25, 'loop reset seeks to the absolute in-point region');
  assert.equal(harness.element.paused, false);
  // A lasting 50 ms lead: several readings, as the engine reports them.
  for (const clock of [5.25, 5.283, 5.316, 5.35]) {
    harness.element.currentTime = clock + 0.05;
    harness.emitMeters({ items: [{ cue_id: 'loop-cue', transport: 1, playhead_seconds: clock }] });
  }
  assert.ok(harness.element.currentTime > 5.35, 'soft drift remains rate-corrected instead of seeking every meter');
  assert.ok(harness.element.playbackRate < 1);
  harness.stop();
});

test('repeated canplay keeps soft drift rate-corrected instead of starting another seek', async () => {
  const h = createHarness(project([audioItem('video', { hasVideo: true })]));
  try {
    await flush();
    h.emitCue(snapshotCue('video', 'video-cue', 1, 1));
    h.controller.onVideoCanPlay();
    await flush();
    for (const [i, clock] of [1, 1.033, 1.066, 1.1, 1.133].entries()) {
      h.element.currentTime = clock + .05;
      h.emitMeters({ items: [{ cue_id: 'video-cue', transport: 1, playhead_seconds: clock }] });
      const before = h.element.currentTime;
      h.controller.onVideoCanPlay();
      assert.equal(h.element.currentTime, before, 'readiness restoration must not bypass soft drift correction');
      if (i >= 3) assert.ok(h.element.playbackRate < 1, 'a lasting drift is rate-corrected');
      assert.equal(h.element.paused, false);
    }
    h.emitMeters({ items: [{ cue_id: 'video-cue', transport: 1, playhead_seconds: 2 }] });
    assert.equal(h.element.currentTime, 2, 'large drift still uses the existing hard seek');
  } finally { h.stop(); }
});

test('playhead jitter leaves the speed alone; real drift corrects at one steady speed', async () => {
  const h = createHarness(project([audioItem('video', { hasVideo: true })]));
  try {
    await flush();
    h.emitCue(snapshotCue('video', 'video-cue', 1, 1));
    h.controller.onVideoCanPlay();
    await flush();
    let writes = 0;
    let rate = h.element.playbackRate;
    Object.defineProperty(h.element, 'playbackRate', {
      get: () => rate, set: (value: number) => { writes += 1; rate = value; }, configurable: true,
    });
    // The engine's playhead moves in render bursts: the measured drift jumps
    // around by tens of milliseconds while the picture is in step.
    for (let i = 0; i < 60; i++) {
      const clock = 1 + i / 30;
      h.element.currentTime = clock - [0.005, 0.03, 0.012, 0.025][i % 4];
      h.emitMeters({ items: [{ cue_id: 'video-cue', transport: 1, playhead_seconds: clock }] });
    }
    assert.equal(writes, 0, 'jitter within the band never touches the speed');
    assert.equal(rate, 1);
    // A real, lasting lag is corrected at one speed, set once, until back in step.
    for (let i = 0; i < 12; i++) {
      const clock = 3 + i / 30;
      h.element.currentTime = clock - 0.05;
      h.emitMeters({ items: [{ cue_id: 'video-cue', transport: 1, playhead_seconds: clock }] });
    }
    assert.ok(rate > 1, 'a lagging picture speeds up');
    assert.equal(writes, 1, 'one speed for the whole correction');
    for (let i = 0; i < 12; i++) {
      const clock = 4 + i / 30;
      h.element.currentTime = clock - 0.002;
      h.emitMeters({ items: [{ cue_id: 'video-cue', transport: 1, playhead_seconds: clock }] });
    }
    assert.equal(rate, 1, 'back in step, normal speed');
    assert.equal(writes, 2);
  } finally { h.stop(); }
});

test('the picture follows the cue as heard, not the render position ahead of it', async () => {
  const h = createHarness(project([audioItem('video', { hasVideo: true })]));
  try {
    await flush();
    h.emitCue(snapshotCue('video', 'video-cue', 1, 1));
    h.controller.onVideoCanPlay();
    await flush();
    // The engine renders 60 ms ahead of what is heard; the picture is with the sound.
    for (let i = 0; i < 16; i++) {
      const rendered = 1 + i / 30;
      h.element.currentTime = rendered - 0.06;
      h.emitMeters({ items: [{ cue_id: 'video-cue', transport: 1, playhead_seconds: rendered, audible_seconds: rendered - 0.06 }] });
    }
    assert.equal(h.element.playbackRate, 1, 'in step with the sound needs no correction');
  } finally { h.stop(); }
});

test('one stray reading cannot make the picture jump; a lasting gap or a real jump does', async () => {
  const h = createHarness(project([audioItem('video', { hasVideo: true })]));
  try {
    await flush();
    h.emitCue(snapshotCue('video', 'video-cue', 1, 1));
    h.controller.onVideoCanPlay();
    await flush();
    const at = (clock: number, behind: number) => {
      h.element.currentTime = clock - behind;
      h.emitMeters({ items: [{ cue_id: 'video-cue', transport: 1, playhead_seconds: clock }] });
    };
    for (let i = 0; i < 6; i++) at(1 + i / 30, 0.005);
    at(1.2, 0.09);
    assert.equal(h.element.currentTime, 1.2 - 0.09, 'a single 90 ms reading does not seek');
    at(1.233, 0.005);
    for (let i = 0; i < 8; i++) at(1.3 + i / 30, 0.1);
    // It seeks to the heard position, or ahead of it by what its seeks taught the lead.
    assert.ok(h.element.currentTime >= 1.3 + 7 / 30 - 1e-9, 'a lasting 100 ms gap seeks');
    at(3, 0.9);
    assert.ok(h.element.currentTime >= 3 && h.element.currentTime < 3.25, 'a real jump seeks at once');
  } finally { h.stop(); }
});

test('a start lands in step: the picture starts ahead by a lead it learns from each start', async () => {
  const h = createHarness(project([audioItem('video', { hasVideo: true })]), true, {}, null);
  try {
    await flush();
    h.emitCue(snapshotCue('video', 'cue-1', 1, 0.03));
    h.controller.onVideoCanPlay();
    await flush();
    const firstLead = h.element.currentTime - 0.03;
    assert.ok(firstLead > 0.02 && firstLead < 0.2, `the first start seeks ahead of the sound (${firstLead})`);
    // This start still landed 30 ms behind what is heard.
    for (let i = 0; i < 10; i++) {
      const heard = 0.1 + i / 30;
      h.element.currentTime = heard - 0.03;
      h.emitMeters({ items: [{ cue_id: 'cue-1', transport: 1, playhead_seconds: heard + 0.02, audible_seconds: heard }] });
    }
    h.emitMeters({ items: [{ cue_id: 'cue-1', transport: 0, playhead_seconds: 0.5 }] });
    await flush();
    h.emitCue(snapshotCue('video', 'cue-2', 2, 0.03));
    await flush();
    const secondLead = h.element.currentTime - 0.03;
    assert.ok(secondLead > firstLead + 0.015, `the next start leads by more (${firstLead} then ${secondLead})`);
  } finally { h.stop(); }
});

test('fades and resume on the cue on screen do not seek the picture', async () => {
  const h = createHarness(project([audioItem('video', { hasVideo: true })]));
  try {
    await flush();
    h.emitCue(snapshotCue('video', 'video-cue', 1, 1, 2));  // starts fading in
    h.controller.onVideoCanPlay();
    await flush();
    let seeks = 0;
    let position = h.element.currentTime;
    Object.defineProperty(h.element, 'currentTime', {
      get: () => position, set: (value: number) => { seeks += 1; position = value; }, configurable: true,
    });
    // The engine reports each transport change with its render position,
    // which runs ahead of what is heard (and of the picture).
    position = 3;
    h.emitCue(snapshotCue('video', 'video-cue', 1, 3.04, 1));  // fade-in done
    h.emitCue(snapshotCue('video', 'video-cue', 1, 5.04, 3));  // fade-out starts
    assert.equal(seeks, 0, 'a transport change on the playing cue keeps the picture going');
    h.emitCue(snapshotCue('video', 'video-cue', 1, 6, 4));     // paused: show the exact frame
    assert.equal(position, 6, 'a pause still lands on its frame');
  } finally { h.stop(); }
});

test('a jump while playing lands ahead by the learned lead, so it does not land late and repeat', async () => {
  const h = createHarness(project([audioItem('video', { hasVideo: true })]), true, {}, '0.06');
  try {
    await flush();
    h.emitCue(snapshotCue('video', 'video-cue', 1, 1));
    h.controller.onVideoCanPlay();
    await flush();
    for (let i = 0; i < 4; i++) {
      const clock = 1.2 + i / 30;
      h.element.currentTime = clock;
      h.emitMeters({ items: [{ cue_id: 'video-cue', transport: 1, playhead_seconds: clock }] });
    }
    h.emitMeters({ items: [{ cue_id: 'video-cue', transport: 1, playhead_seconds: 4 }] });  // a jump (loop, scrub)
    assert.ok(Math.abs(h.element.currentTime - 4.06) < 1e-9, `lands ahead by the lead (${h.element.currentTime})`);
  } finally { h.stop(); }
});

test('a video that has played to its end holds its last frame instead of restarting', async () => {
  const h = createHarness(project([audioItem('video', { hasVideo: true })]));
  try {
    await flush();
    h.emitCue(snapshotCue('video', 'video-cue', 1, 1));
    h.controller.onVideoCanPlay();
    await flush();
    const plays = h.element.playCount;
    // The picture ran out while the engine still plays (audio longer than video).
    h.element.paused = true;
    (h.element as any).ended = true;
    h.emitMeters({ items: [{ cue_id: 'video-cue', transport: 1, playhead_seconds: 1.05 }] });
    assert.equal(h.element.playCount, plays, 'no play() on an ended video: Chromium would restart it at frame 0');
  } finally { h.stop(); }
});

test('a playback error mid-cue retries the same source instead of staying black', async () => {
  const h = createHarness(project([audioItem('video', { hasVideo: true })]));
  try {
    await flush();
    h.emitCue(snapshotCue('video', 'video-cue', 1, 1));
    h.controller.onVideoCanPlay();
    await flush();
    const failedSource = h.controller.videoSrc.value;
    h.controller.onVideoError();
    assert.equal(h.controller.showVideo.value, false, 'the failed picture is hidden at once');
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.notEqual(h.controller.videoSrc.value, failedSource, 'the same file is requested again');
    assert.equal(h.controller.showVideo.value, true, 'the picture comes back for the cue still on air');
  } finally { h.stop(); }
});

test('the next video cue waits ready in the spare and the cut swaps to it without a reload', async () => {
  const h = createHarness(project([audioItem('first', { hasVideo: true }), audioItem('second', { hasVideo: true })]));
  try {
    const live = h.element;
    const spare = videoElement();
    h.controller.registerVideoElement(0, live as unknown as HTMLVideoElement);
    h.controller.registerVideoElement(1, spare as unknown as HTMLVideoElement);
    await flush();
    h.emitCue(snapshotCue('first', 'first-cue', 1, 1));
    h.controller.onVideoCanPlay();
    await flush();
    h.emitPatch({ op: 'next_item_set', itemUuid: 'second' });
    await flush();
    const spareSource = h.controller.slotSources.value[1];
    assert.ok(spareSource, 'the next video cue loads into the spare while the first plays');
    assert.equal(h.controller.slotSources.value[0], h.controller.videoSrc.value, 'the live picture keeps its source');
    // The spare reaches its first frame at the In point.
    spare.readyState = 4;
    spare.videoWidth = 640;
    spare.currentTime = 0;
    h.controller.onSpareEvent();
    h.emitCue(snapshotCue('second', 'second-cue', 2, 0.02));
    await flush();
    assert.equal(h.controller.liveSlot.value, 1, 'the spare is now the live picture');
    assert.equal(toRaw(h.controller.videoEl.value), spare as unknown as HTMLVideoElement);
    assert.equal(h.controller.videoSrc.value, spareSource, 'no reload: the same source carries on');
    assert.equal(live.paused, true, 'the outgoing picture stops');
  } finally { h.stop(); }
});

test('a cut from video to a still holds the last frame until the still has loaded', async () => {
  const h = createHarness(project([
    audioItem('clip', { hasVideo: true }),
    audioItem('slide', { imagePath: 'images/slide.png' }),
  ]));
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: () => {} }) } as unknown as HTMLCanvasElement;
  try {
    await flush();
    h.controller.heldFrameEl.value = canvas;
    h.emitCue(snapshotCue('clip', 'clip-cue', 1, 2));
    h.element.currentSrc = h.controller.videoSrc.value!;
    h.controller.onVideoCanPlay();
    h.element.fireVideoFrame(10, { mediaTime: 2, presentedFrames: 60 });
    h.emitCue(snapshotCue('slide', 'slide-cue', 2, 0));
    await flush();
    assert.ok(h.controller.cueImageSrc.value, 'the still is assigned');
    assert.equal(h.controller.showHeldFrame.value, true, 'the last video frame stays up while the still loads');
    h.controller.onCueImageLoaded();
    assert.equal(h.controller.showHeldFrame.value, false, 'the loaded still replaces it');
  } finally { h.stop(); }
});

test('picture sync runs the picture ahead of the sound by the operator offset', async () => {
  const h = createHarness(project([audioItem('video', { hasVideo: true })]), true, {}, '0', 80);
  try {
    await flush();
    h.emitCue(snapshotCue('video', 'video-cue', 1, 0.03));
    h.controller.onVideoCanPlay();
    await flush();
    assert.ok(Math.abs(h.element.currentTime - 0.11) < 1e-9, `the start lands 80 ms ahead (${h.element.currentTime})`);
    // Held 80 ms ahead of the sound, the picture is where it should be.
    for (let i = 0; i < 12; i++) {
      const heard = 0.2 + i / 30;
      h.element.currentTime = heard + 0.08;
      h.emitMeters({ items: [{ cue_id: 'video-cue', transport: 1, playhead_seconds: heard + 0.02, audible_seconds: heard }] });
    }
    assert.equal(h.element.playbackRate, 1, 'no correction away from the offset');
  } finally { h.stop(); }
});

test('with picture sync, the picture stops at the Out point by its own position, ahead of the sound', async () => {
  const h = createHarness(project([audioItem('video', { hasVideo: true, inPoint: 0, outPoint: 5 })]), true, {}, '0', 200);
  try {
    await flush();
    h.emitCue(snapshotCue('video', 'video-cue', 1, 1));
    h.controller.onVideoCanPlay();
    await flush();
    assert.equal(h.controller.showVideo.value, true);
    // The sound is at 4.85, so the picture (200 ms ahead) is past the 5 s Out point.
    h.element.currentTime = 5.05;
    h.emitMeters({ items: [{ cue_id: 'video-cue', transport: 1, playhead_seconds: 4.85 }] });
    assert.equal(h.controller.showVideo.value, false, 'the picture does not play past its trim');
  } finally { h.stop(); }
});

test('with picture sync, a pause shows the frame the offset puts with the paused sound, and resume does not jump', async () => {
  const h = createHarness(project([audioItem('video', { hasVideo: true })]), true, {}, '0.06', 300);
  try {
    await flush();
    h.emitCue(snapshotCue('video', 'video-cue', 1, 1));
    h.controller.onVideoCanPlay();
    await flush();
    let seeks = 0;
    let position = 2.3;
    Object.defineProperty(h.element, 'currentTime', {
      get: () => position, set: (value: number) => { seeks += 1; position = value; }, configurable: true,
    });
    h.emitCue(snapshotCue('video', 'video-cue', 1, 3, 4));  // paused at 3 s of sound
    assert.ok(Math.abs(position - 3.3) < 1e-9, `paused on the frame 300 ms ahead (${position}), no start lead`);
    seeks = 0;
    h.emitCue(snapshotCue('video', 'video-cue', 1, 3, 1));  // resumed
    h.emitMeters({ items: [{ cue_id: 'video-cue', transport: 1, playhead_seconds: 3.03, audible_seconds: 3.01 }] });
    assert.equal(seeks, 0, 'resume carries on from the paused frame');
  } finally { h.stop(); }
});

test('a pause right after a start shows the paused frame, without the start lead', async () => {
  const h = createHarness(project([audioItem('video', { hasVideo: true })]), true, {}, '0.1');
  try {
    await flush();
    h.emitCue(snapshotCue('video', 'video-cue', 1, 1));
    h.controller.onVideoCanPlay();
    await flush();
    h.emitCue(snapshotCue('video', 'video-cue', 1, 1.05, 4));
    assert.ok(Math.abs(h.element.currentTime - 1.05) < 1e-9, `on the paused frame (${h.element.currentTime})`);
  } finally { h.stop(); }
});

test('a seek that keeps landing late teaches the lead at once instead of repeating', async () => {
  const h = createHarness(project([audioItem('video', { hasVideo: true })]), true, {}, '0.06');
  try {
    await flush();
    h.emitCue(snapshotCue('video', 'video-cue', 1, 1));
    h.controller.onVideoCanPlay();
    await flush();
    // Each seek takes 180 ms: it lands 120 ms behind its aim of heard + lead.
    const seekTargets: number[] = [];
    let position = 1;
    Object.defineProperty(h.element, 'currentTime', {
      get: () => position, set: (value: number) => { seekTargets.push(value); position = value; }, configurable: true,
    });
    let clock = 2;
    for (let i = 0; i < 30; i++) {
      clock += 1 / 30;
      position += 1 / 30;
      const before = seekTargets.length;
      h.emitMeters({ items: [{ cue_id: 'video-cue', transport: 1, playhead_seconds: clock }] });
      if (seekTargets.length > before) position = seekTargets.at(-1)! - 0.18;  // landed late by the seek time
    }
    assert.ok(seekTargets.length <= 4, `it stops seeking once the lead covers the seek (${seekTargets.length} seeks)`);
  } finally { h.stop(); }
});

test('one stray reading next to a small landing error cannot make the picture jump', async () => {
  const h = createHarness(project([audioItem('video', { hasVideo: true })]), true, {}, '0');
  try {
    await flush();
    h.emitCue(snapshotCue('video', 'video-cue', 1, 1));
    h.controller.onVideoCanPlay();
    await flush();
    h.element.currentTime = 2;
    h.emitMeters({ items: [{ cue_id: 'video-cue', transport: 1, playhead_seconds: 2 }] });
    h.element.currentTime = 2.033;
    h.emitMeters({ items: [{ cue_id: 'video-cue', transport: 1, playhead_seconds: 2.033 + 0.17 }] });
    assert.equal(h.element.currentTime, 2.033, 'readings of 0 and 0.17 do not average into a seek');
  } finally { h.stop(); }
});

test('a cut from standby to a preloaded video plays from its waiting frame, without a seek', async () => {
  const h = createHarness(project([audioItem('video', { hasVideo: true, inPoint: 0 })]), true, {}, '0.1', 50);
  try {
    await flush();
    h.emitPatch({ op: 'next_item_set', itemUuid: 'video' });
    await flush();
    h.controller.onVideoLoadedMetadata();
    h.controller.onVideoCanPlay();
    await flush();
    assert.ok(Math.abs(h.element.currentTime - 0.05) < 1e-9, `waits at its In point, ahead by the offset (${h.element.currentTime})`);
    let seeks = 0;
    let position = h.element.currentTime;
    Object.defineProperty(h.element, 'currentTime', {
      get: () => position, set: (value: number) => { seeks += 1; position = value; }, configurable: true,
    });
    h.emitCue(snapshotCue('video', 'video-cue', 1, 0.01));
    await flush();
    assert.equal(seeks, 0, 'the cut plays the waiting frame at once');
    assert.ok(h.element.playCount > 0, 'and it plays');
  } finally { h.stop(); }
});

test('a spare whose In point is past the end of its clip waits at the end instead of seeking again and again', async () => {
  const h = createHarness(project([audioItem('first', { hasVideo: true }), audioItem('second', { hasVideo: true, inPoint: 12 })]));
  try {
    const live = h.element;
    const spare = videoElement();
    h.controller.registerVideoElement(0, live as unknown as HTMLVideoElement);
    h.controller.registerVideoElement(1, spare as unknown as HTMLVideoElement);
    await flush();
    h.emitCue(snapshotCue('first', 'first-cue', 1, 1));
    h.controller.onVideoCanPlay();
    await flush();
    h.emitPatch({ op: 'next_item_set', itemUuid: 'second' });
    await flush();
    let seeks = 0;
    let position = 0;
    Object.defineProperty(spare, 'currentTime', {
      get: () => position, set: (value: number) => { seeks += 1; position = Math.min(value, 10); }, configurable: true,
    });
    (spare as any).duration = 10;
    spare.readyState = 4;
    spare.videoWidth = 640;
    for (let i = 0; i < 5; i++) h.controller.onSpareEvent();
    assert.equal(seeks, 1, 'one seek to the end of the clip');
  } finally { h.stop(); }
});

test('a cut from a still to a video keeps the held frame until the video has its first frame', async () => {
  const h = createHarness(project([
    audioItem('clip', { hasVideo: true }),
    audioItem('slide', { imagePath: 'images/slide.png' }),
    audioItem('next', { hasVideo: true }),
  ]));
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: () => {} }) } as unknown as HTMLCanvasElement;
  try {
    await flush();
    h.controller.heldFrameEl.value = canvas;
    h.emitCue(snapshotCue('clip', 'clip-cue', 1, 2));
    h.element.currentSrc = h.controller.videoSrc.value!;
    h.controller.onVideoCanPlay();
    h.element.fireVideoFrame(10, { mediaTime: 2, presentedFrames: 60 });
    h.emitCue(snapshotCue('slide', 'slide-cue', 2, 0));   // the still has not loaded yet
    await flush();
    h.emitCue(snapshotCue('next', 'next-cue', 3, 0));     // a slow video follows within 2 s
    await flush();
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.equal(h.controller.showHeldFrame.value, true, 'the still’s 2 s limit does not drop the frame the video still needs');
  } finally { h.stop(); }
});

test('a selection refresh preserves a playing video and its soft drift correction', async () => {
  const doc = project([audioItem('video', { hasVideo: true }), audioItem('audio')]);
  const h = createHarness(doc);
  try {
    await flush();
    h.emitCue(snapshotCue('video', 'video-cue', 1, 1));
    h.controller.onVideoCanPlay();
    h.element.currentTime = 1.035;
    h.emitMeters({ items: [{ cue_id: 'video-cue', transport: 1, playhead_seconds: 1 }] });
    const source = h.controller.videoSrc.value;
    const pauses = h.element.pauseCount;
    const rate = h.element.playbackRate;
    const fetched = deferred<void>();
    h.setFetchProject(async () => { fetched.resolve(); return doc; });
    h.emitPatch({ op: 'selection_changed', itemUuid: 'audio' });
    await fetched.promise;
    await flush();
    assert.equal(h.element.currentTime, 1.035, 'selection cannot seek the on-air picture');
    assert.equal(h.element.playbackRate, rate);
    assert.equal(h.element.pauseCount, pauses);
    assert.equal(h.element.paused, false);
    assert.equal(h.controller.videoSrc.value, source);
    assert.equal(h.controller.showVideo.value, true);
  } finally { h.stop(); }
});

test('a document refresh still aligns the authoritative paused video frame', async () => {
  const doc = project([audioItem('video', { hasVideo: true })]);
  const h = createHarness(doc);
  try {
    await flush();
    h.emitCue(snapshotCue('video', 'video-cue', 1, 2, 4));
    h.controller.onVideoCanPlay();
    h.element.currentTime = 1.965;
    const fetched = deferred<void>();
    h.setFetchProject(async () => { fetched.resolve(); return doc; });
    h.emitPatch({ op: 'selection_changed', itemUuid: 'video' });
    await fetched.promise;
    await flush();
    assert.equal(h.element.currentTime, 2);
    assert.equal(h.element.paused, true);
  } finally { h.stop(); }
});

for (const event of ['older pause', 'older stop', 'unrelated preview']) {
  test(`${event} preserves the newer video position and playback`, async () => {
    const h = createHarness(project([
      audioItem('bed'), audioItem('video', { hasVideo: true }), audioItem('preview'),
    ]));
    try {
      await flush();
      h.emitCue(snapshotCue('bed', 'bed-cue', 1));
      h.emitCue(snapshotCue('video', 'video-cue', 2, 1));
      h.controller.onVideoCanPlay();
      h.element.currentTime = 1.035;
      const source = h.controller.videoSrc.value;
      const pauses = h.element.pauseCount;
      if (event === 'unrelated preview') {
        h.emitPatch({ op: 'preview_started', itemUuid: 'preview' });
      } else {
        h.emitCue(snapshotCue('bed', 'bed-cue', 1, .5, event === 'older pause' ? 4 : 0));
      }
      assert.equal(h.element.currentTime, 1.035, 'unrelated transport cannot seek the current picture');
      assert.equal(h.element.paused, false);
      assert.equal(h.element.pauseCount, pauses);
      assert.equal(h.controller.videoSrc.value, source);
      assert.equal(h.controller.showVideo.value, true);
    } finally { h.stop(); }
  });
}

test('an older cue event cannot manufacture displayed-video clock recovery', async () => {
  const h = createHarness(project([audioItem('bed'), audioItem('video', { hasVideo: true })]));
  try {
    await flush();
    h.emitCue(snapshotCue('bed', 'bed-cue', 1));
    h.emitCue(snapshotCue('video', 'video-cue', 2, 1));
    h.controller.onVideoCanPlay();
    const pinned = { items: [{ cue_id: 'video-cue', transport: 1, playhead_seconds: 1 }] };
    h.emitMeters(pinned);
    h.emitMeters(pinned);
    assert.equal(h.element.paused, true);
    h.emitCue(snapshotCue('bed', 'bed-cue', 1, 3, 4));
    h.emitMeters(pinned);
    assert.equal(h.element.paused, true, 'only displayed-cue progress can recover its clock');
    assert.equal(h.controller.getPictureHealth().state, 'clock-wait');
    h.emitMeters({ items: [{ cue_id: 'video-cue', transport: 1, playhead_seconds: 1.1 }] });
    assert.equal(h.element.paused, false, 'genuine displayed-cue progress still recovers');
  } finally { h.stop(); }
});

test('first canplay still aligns to the latest native position after delayed decoding', async () => {
  const h = createHarness(project([audioItem('video', { hasVideo: true })]));
  try {
    await flush();
    h.emitCue(snapshotCue('video', 'video-cue', 1));
    h.emitMeters({ items: [{ cue_id: 'video-cue', transport: 1, playhead_seconds: .25 }] });
    assert.equal(h.element.currentTime, 0);
    h.controller.onVideoCanPlay();
    await flush();
    assert.equal(h.element.currentTime, .25);
    assert.equal(h.element.paused, false);
  } finally { h.stop(); }
});

test('keeps the outgoing picture across an automatic stop until the new video submits a frame', async () => {
  const h = createHarness(project([
    {
      ...audioItem('outgoing', { hasVideo: true, outPoint: 0 }),
      duration: 32,
      endBehavior: { action: 'next' },
    },
    audioItem('incoming', { hasVideo: true }),
  ]));
  const drawn: string[] = [];
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({ drawImage: (element: MockVideo) => drawn.push(element.currentSrc) }),
  } as unknown as HTMLCanvasElement;
  try {
    await flush();
    if (h.controller.heldFrameEl) h.controller.heldFrameEl.value = canvas;
    h.emitCue(snapshotCue('outgoing', 'cue-a', 1, 31.9));
    h.element.currentSrc = h.controller.videoSrc.value!;
    h.controller.onVideoCanPlay();
    h.element.fireVideoFrame(10, { mediaTime: 31.9, presentedFrames: 955 });
    const outgoingSrc = h.element.currentSrc;

    h.emitCue(snapshotCue('outgoing', 'cue-a', 1, 32, 0));
    await flush();
    assert.equal(h.controller.showHeldFrame?.value, true, 'the stopped edge must keep the outgoing frame');
    assert.deepEqual(drawn, [outgoingSrc]);

    h.emitCue(snapshotCue('incoming', 'cue-b', 2, .05));
    h.element.currentSrc = h.controller.videoSrc.value!;
    h.controller.onVideoCanPlay();
    assert.equal(h.controller.showHeldFrame.value, true, 'canplay does not replace the held picture');
    h.emitMeters({ items: [{ cue_id: 'cue-b', transport: 1, playhead_seconds: .25 }] });
    assert.equal(h.element.currentTime, .05, 'let the incoming frame land before chasing the clock');
    h.element.fireVideoFrame(20, { mediaTime: .05, presentedFrames: 1 });
    assert.equal(h.controller.showHeldFrame.value, false, 'the new source can replace it once it submits a frame');
    h.emitCue(snapshotCue('incoming', 'cue-b', 2, 0, 0));
    assert.equal(h.controller.showVideo.value, false);
  } finally { h.stop(); }
});

test('Stop All and an incoming decoder failure can always clear the held picture', async () => {
  const h = createHarness(project([
    audioItem('from', { hasVideo: true }),
    audioItem('to', { hasVideo: true }),
  ]));
  try {
    await flush();
    h.controller.heldFrameEl.value = {
      width: 0, height: 0, getContext: () => ({ drawImage() {} }),
    } as unknown as HTMLCanvasElement;
    h.emitMeters({ stop_revision: 2, items: [] });
    h.emitCue(snapshotCue('from', 'cue-a', 1, 1));
    h.controller.onVideoCanPlay();
    h.element.fireVideoFrame(10, { mediaTime: 1, presentedFrames: 1 });
    h.emitCue(snapshotCue('to', 'cue-b', 2));
    assert.equal(h.controller.showHeldFrame.value, true);
    h.emitMeters({ stop_revision: 3, items: [] });
    assert.equal(h.controller.showHeldFrame.value, false);

    h.emitCue(snapshotCue('from', 'cue-a', 3, 1));
    h.controller.onVideoCanPlay();
    h.element.fireVideoFrame(20, { mediaTime: 1, presentedFrames: 1 });
    h.emitCue(snapshotCue('to', 'cue-b', 4));
    assert.equal(h.controller.showHeldFrame.value, true);
    h.controller.onVideoError();
    assert.equal(h.controller.showHeldFrame.value, false);
    assert.deepEqual(h.reports.at(-1), { itemUuid: 'to', message: 'Video playback could not be decoded.' });
  } finally { h.stop(); }
});

test('native position updates do not restart a pending video seek', async () => {
  const h = createHarness(project([audioItem('video', { hasVideo: true })]));
  try {
    await flush();
    h.emitCue(snapshotCue('video', 'cue', 1, 1));
    h.controller.onVideoCanPlay();
    h.element.fireVideoFrame(10, { mediaTime: 1, presentedFrames: 1 });
    h.emitMeters({ items: [{ cue_id: 'cue', transport: 1, playhead_seconds: 2 }] });
    assert.equal(h.element.currentTime, 2);
    h.element.seeking = true;
    h.emitMeters({ items: [{ cue_id: 'cue', transport: 1, playhead_seconds: 2.2 }] });
    assert.equal(h.element.currentTime, 2);
    h.element.seeking = false;
    h.emitMeters({ items: [{ cue_id: 'cue', transport: 1, playhead_seconds: 2.25 }] });
    // That seek landed 250 ms late: the next one aims ahead by what it taught.
    assert.ok(h.element.currentTime > 2.25 && h.element.currentTime <= 2.5, `seeks to the sound (${h.element.currentTime})`);
  } finally { h.stop(); }
});

test('trigger_seq chooses newest-fired program cue while stop and preview preserve program picture', async () => {
  const olderVideo = audioItem('older-video', { hasVideo: true });
  const newerImage = audioItem('newer-image', { imagePath: 'images/newer.png' });
  const previewVideo = audioItem('preview-video', { hasVideo: true });
  const harness = createHarness(project([olderVideo, newerImage, previewVideo]));
  await flush();

  harness.emitSnapshot({
    cues: [
      snapshotCue('newer-image', 'newer-cue', 12, 1),
      snapshotCue('older-video', 'older-cue', 3, 1),
      snapshotCue('preview-video', 'preview-cue', 99, 1),
    ],
    preview: { item_uuid: 'preview-video', cue_id: 'preview-cue' },
    next_item_uuid: '',
  });
  assert.equal(harness.controller.showVideo.value, false, 'newest program audio-only cue cuts the older video');
  assert.match(harness.controller.cueImageSrc.value!, /path=%2Fshows%2Fcurrent%2Fimages%2Fnewer\.png/);

  harness.emitCue(snapshotCue('untracked', 'untracked-cue', 2, 2, 0));
  assert.equal(harness.controller.showVideo.value, false, 'stopping a non-program cue does not clear the program picture');

  harness.emitCue(snapshotCue('newer-image', 'newer-cue', 12, 2, 0));
  assert.equal(harness.controller.showVideo.value, true, 'stopping newest falls back to the older audio/video cue');
  assert.equal(new URL(harness.controller.videoSrc.value!).searchParams.get('item_uuid'), 'older-video');

  harness.emitPatch({ op: 'preview_started', itemUuid: 'preview-video', cueId: 'preview-cue' });
  harness.emitCue(snapshotCue('preview-video', 'preview-cue', 100, 0, 1));
  assert.equal(new URL(harness.controller.videoSrc.value!).searchParams.get('item_uuid'), 'older-video');
  harness.stop();
});

test('auditioning the same playlist item never removes its Program picture', async () => {
  const h = createHarness(project([
    audioItem('outgoing', { hasVideo: true }),
    audioItem('incoming', { hasVideo: true }),
  ]));
  const program = snapshotCue('incoming', 'program-cue', 2, 0.5);
  const preview = snapshotCue('incoming', 'preview-cue', 99, 8);
  try {
    await flush();
    h.emitCue(snapshotCue('outgoing', 'outgoing-cue', 1, 2));
    h.emitPatch({ op: 'preview_started', itemUuid: 'incoming', cueId: 'preview-cue', revision: 1 });
    h.emitCue(snapshotCue('outgoing', 'outgoing-cue', 1, 20, 0));
    h.emitCue(program);
    assert.equal(h.controller.showVideo.value, true, 'automatic follow can take an item already in Preview');
    assert.equal(new URL(h.controller.videoSrc.value!).searchParams.get('item_uuid'), 'incoming');
    h.controller.onVideoCanPlay();
    assert.equal(h.element.currentTime, 0.5);
    h.emitCue(preview);
    h.emitPatch({ op: 'preview_started', itemUuid: 'incoming', cueId: 'preview-cue', revision: 2 });
    h.emitMeters({ items: [{ cue_id: 'preview-cue', transport: 1, playhead_seconds: 9 }] });
    assert.equal(h.controller.showVideo.value, true, 'starting Preview cannot remove an on-air copy');
    assert.equal(h.element.currentTime, 0.5, 'Preview cannot seek the Program picture');

    h.server.connected = false;
    await flush();
    h.server.connected = true;
    await flush();
    h.emitSnapshot({
      cues: [program, preview],
      preview: { item_uuid: 'incoming', cue_id: 'preview-cue', revision: 2 },
    });
    assert.equal(h.controller.showVideo.value, true, 'reconnect keeps the Program copy of the auditioned item');
    assert.equal(h.element.currentTime, 0.5);
    h.emitCue({ ...program, transport: 0 });
    assert.equal(h.controller.showVideo.value, false, 'Preview stays off the audience feed after Program stops');
  } finally { h.stop(); }
});

for (const op of ['preview_stopped', 'preview_started']) {
  test(`a superseded ${op} cannot let the current audition take audience video`, async () => {
    const h = createHarness(project([audioItem('program', { hasVideo: true }),
      audioItem('preview', { hasVideo: true }), audioItem('old-preview')]));
    try {
      await flush(); h.emitCue(snapshotCue('program', 'program-cue', 1));
      h.emitPatch({ op: 'preview_started', itemUuid: 'preview', cueId: 'preview-cue',
        revision: 3, project_session_id: 'show' });
      h.emitPatch({ op, itemUuid: op === 'preview_started' ? 'old-preview' : '',
        revision: 2, project_session_id: 'show' });
      h.emitCue(snapshotCue('preview', 'preview-cue', 99));
      assert.equal(new URL(h.controller.videoSrc.value!).searchParams.get('item_uuid'), 'program');
    } finally { h.stop(); }
  });
}

test('a new server snapshot resets Preview ordering and refuses an older server completion', async () => {
  const h = createHarness(project([audioItem('program', { hasVideo: true }), audioItem('preview', { hasVideo: true })]));
  try {
    await flush(); h.emitCue(snapshotCue('program', 'program-cue', 1));
    h.emitPatch({ op: 'preview_started', itemUuid: 'preview', cueId: 'old-preview-cue', revision: 50, project_session_id: 'old-server' });
    h.emitSnapshot({ cues: [snapshotCue('program', 'program-cue', 1)], preview: {
      item_uuid: 'preview', cue_id: 'preview-cue', revision: 1, project_session_id: 'new-server' } });
    h.emitPatch({ op: 'preview_stopped', revision: 51, project_session_id: 'old-server' });
    h.emitCue(snapshotCue('preview', 'preview-cue', 99));
    await flush();
    assert.equal(new URL(h.controller.videoSrc.value!).searchParams.get('item_uuid'), 'program');
  } finally { h.stop(); }
});

test('a replacement engine can show its first cue after Stop All on the old engine', async () => {
  const items = [audioItem('film', { hasVideo: true })];
  const show = (projectSessionId: string) => ({ ...project(items), server: { projectSessionId } });
  const h = createHarness(show('old-show'));
  try {
    await flush();
    h.emitSnapshot({ cues: [snapshotCue('film', 'old-cue', 9)], stop_revision: 0,
      preview: { project_session_id: 'old-show', revision: 0 } });
    h.emitMeters({ items: [{ cue_id: 'old-cue', transport: 0, playhead_seconds: 0 }], stop_revision: 1 });
    h.server.connected = false;
    await flush();

    h.setFetchProject(async () => show('new-show'));
    h.server.connected = true;
    h.emitSnapshot({ cues: [snapshotCue('film', 'new-cue', 1, 1.25)], stop_revision: 0,
      preview: { project_session_id: 'new-show', revision: 0 } });
    await flush();
    const src = h.controller.videoSrc.value;
    assert.ok(src);
    assert.equal(new URL(src).searchParams.get('project_session_id'), 'new-show');
    h.element.currentSrc = src;
    h.controller.onVideoCanPlay();
    assert.equal(h.controller.showVideo.value, true);
    assert.equal(h.element.currentTime, 1.25);
  } finally { h.stop(); }
});

test('unknown cue edges survive document loading and stale fetches cannot restore an old active source', async () => {
  const initial = project([audioItem('known', { hasVideo: true, mediaPath: 'media/old.mp4' })]);
  const harness = createHarness(initial);
  await flush();
  harness.emitCue(snapshotCue('known', 'known-cue', 7, 1));
  const initialUrl = harness.controller.videoSrc.value!;

  const oldFetch = deferred<unknown>();
  const newFetch = deferred<unknown>();
  let request = 0;
  harness.setFetchProject(() => {
    request += 1;
    return request === 1 ? oldFetch.promise : newFetch.promise;
  });
  harness.emitSnapshot({ cues: [snapshotCue('known', 'known-cue', 7, 1)], preview: null, next_item_uuid: '' });
  harness.emitSnapshot({ cues: [snapshotCue('known', 'known-cue', 7, 1)], preview: null, next_item_uuid: '' });
  newFetch.resolve(project([audioItem('known', { hasVideo: true, mediaPath: 'media/new.mp4' })]));
  await flush();
  const updatedUrl = harness.controller.videoSrc.value!;
  assert.notEqual(updatedUrl, initialUrl, 'active source reloads when its document media changes');

  oldFetch.resolve(project([audioItem('known', { hasVideo: true, mediaPath: 'media/old.mp4' })]));
  await flush();
  assert.equal(harness.controller.videoSrc.value, updatedUrl, 'late older fetch cannot restore stale media');
  harness.stop();

  const unknown = createHarness(project([]), false);
  unknown.setFetchProject(async () => project([audioItem('late-item', { hasVideo: true })]));
  unknown.emitCue(snapshotCue('late-item', 'late-cue', 20, 4));
  await flush();
  assert.equal(unknown.controller.videoSrc.value, null, 'cue recovery waits for the connection');
  unknown.server.connected = true;
  await flush();
  assert.equal(new URL(unknown.controller.videoSrc.value!).searchParams.get('item_uuid'), 'late-item');
  unknown.stop();
});

test('zero-dimensional media reports an undecodable video track even when canplay fires', async () => {
  const harness = createHarness(project([audioItem('unsupported-video', { hasVideo: true })]));
  await flush();
  harness.emitCue(snapshotCue('unsupported-video', 'unsupported-cue', 1));
  harness.element.currentSrc = harness.controller.videoSrc.value!;
  harness.element.videoWidth = 0;
  harness.element.videoHeight = 0;

  harness.controller.onVideoLoadedMetadata();
  const failure = {
    itemUuid: 'unsupported-video',
    message: 'Video playback could not be decoded.',
  };
  assert.equal(harness.controller.showVideo.value, false);
  assert.equal(harness.element.paused, true);
  assert.deepEqual(harness.reports.at(-1), failure);

  const reportCount = harness.reports.length;
  harness.controller.onVideoCanPlay();
  assert.equal(harness.controller.showVideo.value, false, 'canplay cannot reveal a source with no decoded picture');
  assert.equal(harness.element.paused, true);
  assert.equal(harness.reports.length, reportCount, 'canplay cannot clear or duplicate the latched failure');
  assert.deepEqual(harness.reports.at(-1), failure);
  harness.stop();
});

test('a valid next source recovers while delayed zero-dimensional events stay source-fenced', async () => {
  const harness = createHarness(project([
    audioItem('unsupported-video', { hasVideo: true }),
    audioItem('healthy-video', { hasVideo: true }),
  ]));
  await flush();
  harness.emitCue(snapshotCue('unsupported-video', 'unsupported-cue', 1));
  const unsupportedSource = harness.controller.videoSrc.value!;
  harness.element.currentSrc = unsupportedSource;
  harness.element.videoWidth = 0;
  harness.element.videoHeight = 0;
  harness.controller.onVideoCanPlay();
  assert.equal(harness.controller.showVideo.value, false);

  harness.emitCue(snapshotCue('healthy-video', 'healthy-cue', 2));
  const healthySource = harness.controller.videoSrc.value!;
  assert.notEqual(healthySource, unsupportedSource);
  assert.equal(harness.reports.at(-1), null, 'a new source clears the previous source failure');

  harness.element.currentSrc = unsupportedSource;
  harness.controller.onVideoLoadedMetadata();
  harness.controller.onVideoCanPlay();
  assert.equal(harness.reports.at(-1), null, 'late metadata and canplay from the old source are ignored');
  assert.equal(harness.controller.showVideo.value, true);

  harness.element.currentSrc = healthySource;
  harness.element.videoWidth = 640;
  harness.element.videoHeight = 360;
  harness.controller.onVideoLoadedMetadata();
  harness.controller.onVideoCanPlay();
  await flush();
  assert.equal(harness.controller.showVideo.value, true);
  assert.equal(harness.element.paused, false, 'the healthy H264-shaped source resumes playback');
  assert.equal(harness.reports.at(-1), null);
  harness.stop();
});

test('missing and pinned native meters freeze video until progress, including device recovery', async () => {
  const first = audioItem('first-video', { hasVideo: true });
  const second = audioItem('second-video', { hasVideo: true });
  const harness = createHarness(project([first, second]));
  await flush();
  harness.emitCue(snapshotCue('first-video', 'first-cue', 1, 2));
  harness.controller.onVideoCanPlay();
  await flush();
  harness.element.currentTime = 2;
  harness.element.fireVideoFrame(0);
  harness.element.fireVideoFrame(251);
  assert.equal(harness.element.paused, true, 'missing meters freeze video while the socket and device stay healthy');
  const playsAfterMissingMeters = harness.element.playCount;

  harness.emitMeters({ items: [{ cue_id: 'first-cue', transport: 1, playhead_seconds: 2 }] });
  harness.emitMeters({ items: [{ cue_id: 'first-cue', transport: 1, playhead_seconds: 2 }] });
  assert.equal(harness.element.paused, true, 'repeated pinned native meters cannot restart or judder video');
  assert.equal(harness.element.playCount, playsAfterMissingMeters);

  harness.emitMeters({ items: [{ cue_id: 'first-cue', transport: 1, playhead_seconds: 2.5 }] });
  assert.equal(harness.element.currentTime, 2.5);
  assert.equal(harness.element.paused, false, 'fresh advancing native time resumes video');
  const playsBeforeStall = harness.element.playCount;

  harness.server.devices[0]!.runtime_state = 'stalled';
  await nextTick();
  assert.equal(harness.element.paused, true);
  harness.emitMeters({ items: [{ cue_id: 'first-cue', transport: 1, playhead_seconds: 8 }] });
  assert.equal(harness.element.currentTime, 2.5, 'stale meters cannot rewind or advance a frozen output');

  harness.server.devices[0]!.runtime_state = 'running';
  await nextTick();
  assert.equal(harness.element.playCount, playsBeforeStall, 'recovery does not free-run before a fresh engine sample');
  harness.emitMeters({ items: [{ cue_id: 'first-cue', transport: 1, playhead_seconds: 9 }] });
  assert.equal(harness.element.currentTime, 9);
  assert.ok(harness.element.playCount > playsBeforeStall);

  harness.element.currentSrc = harness.controller.videoSrc.value!;
  harness.controller.onVideoError();
  assert.equal(harness.controller.showVideo.value, false);
  const failure = harness.reports.at(-1);
  assert.deepEqual(failure, {
    itemUuid: 'first-video',
    message: 'Video playback could not be decoded.',
  });
  assert.doesNotMatch(JSON.stringify(failure), /api\/media|access_token|secret-token|\.mp4/);

  const staleSource = harness.element.currentSrc;
  harness.emitCue(snapshotCue('second-video', 'second-cue', 2, 0));
  assert.equal(harness.reports.at(-1), null, 'changing source clears the resolved/stale failure');
  harness.element.currentSrc = staleSource;
  harness.controller.onVideoError();
  assert.equal(harness.reports.at(-1), null, 'late error from replaced media is ignored');
  harness.stop();
});

test('AV Sync shares the native clock and restores the current Program cue without document mutation', async () => {
  const doc = project([audioItem('program', { hasVideo: true })]);
  const before = JSON.stringify(doc);
  const h = createHarness(doc);
  await flush();
  h.emitCue(snapshotCue('program', 'program-cue', 1, 1));
  h.controller.onVideoCanPlay();
  const source = { cueId: 'diagnostic', path: '/bundled/60.webm', duration: 4.008, description: 'Program output' };
  h.diagnostic.value = source;
  await flush();
  assert.equal(new URL(h.controller.videoSrc.value!).searchParams.get('path'), source.path);
  assert.equal(new URL(h.controller.videoSrc.value!).searchParams.has('item_uuid'), false);
  h.controller.onVideoCanPlay();
  h.emitCue({ cue_id: 'diagnostic', transport: 1, playhead_seconds: 2 });
  assert.equal(h.element.currentTime, 2);
  assert.equal(h.element.paused, false);
  const plays = h.element.playCount;
  h.diagnostic.value = { ...source };
  await flush();
  assert.equal(h.element.currentTime, 2, 'status refresh must not rewind the existing diagnostic');
  assert.equal(h.element.playCount, plays);
  h.emitMeters({ items: [
    { cue_id: 'program-cue', transport: 1, playhead_seconds: 9 },
    { cue_id: 'diagnostic', transport: 1, playhead_seconds: 2.2 },
  ] });
  assert.equal(h.element.currentTime, 2.2);
  h.emitCue({ cue_id: 'diagnostic', transport: 4, playhead_seconds: 1.75 });
  assert.equal(h.element.currentTime, 1.75);
  assert.equal(h.element.paused, true);
  h.diagnostic.value = null;
  await flush();
  h.controller.onVideoCanPlay();
  assert.equal(new URL(h.controller.videoSrc.value!).searchParams.get('item_uuid'), 'program');
  assert.equal(h.element.currentTime, 9);
  assert.equal(h.element.paused, false);
  assert.equal(JSON.stringify(doc), before);
  h.stop();
});

test('AV Sync accepts orphan reconnect snapshots and freezes on the same clock-loss rule', async () => {
  const h = createHarness(project([]));
  h.diagnostic.value = { cueId: 'diagnostic', path: '/bundled/60.webm', duration: 4.008, description: 'Program output' };
  await flush();
  h.emitSnapshot({ cues: [{ cue_id: 'diagnostic', transport: 1, playhead_seconds: 2.8 }] });
  h.controller.onVideoCanPlay();
  assert.equal(h.element.currentTime, 2.8);
  assert.equal(h.element.paused, false);
  h.element.fireVideoFrame(0);
  h.element.fireVideoFrame(251);
  assert.equal(h.element.paused, true);
  h.emitMeters({ items: [{ cue_id: 'diagnostic', transport: 1, playhead_seconds: 0.1 }] });
  assert.equal(h.element.currentTime, 0.1);
  assert.equal(h.element.paused, false, 'native loop-wrap is fresh progress');
  h.emitCue({ cue_id: 'diagnostic', transport: 0, playhead_seconds: 0.1 });
  assert.equal(h.element.paused, true, 'Stop All does not silently restart the diagnostic');
  h.stop();
});

test('picture health records presented media time separately from renderer/capture and respects paused/still/seek/loop states', async () => {
  const h = createHarness(project([audioItem('picture', { hasVideo: true }), audioItem('still', { imagePath: 'logo.png' })]));
  await flush();
  h.emitCue(snapshotCue('picture', 'picture-cue', 1, 2));
  h.controller.onVideoCanPlay();
  assert.equal(h.controller.getPictureHealth().mediaTime, null, 'canplay alone is not a presented frame');
  h.element.fireVideoFrame(performance.now(), { mediaTime: 2.04, presentedFrames: 3 });
  let health = h.controller.getPictureHealth();
  assert.equal(health.state, 'playing');
  assert.equal(health.mediaTime, 2.04);
  assert.equal(health.presentedFrames, 3);
  assert.ok(health.presentedAgeMs! >= 0);
  const capturedTime = health.mediaTime;
  assert.equal(h.controller.getPictureHealth().mediaTime, capturedTime, 'fresh polling cannot invent frame progress');
  h.emitCue(snapshotCue('picture', 'picture-cue', 1, 2.04, 4));
  assert.equal(h.controller.getPictureHealth().state, 'paused');
  h.element.currentTime = 1;
  h.emitCue(snapshotCue('picture', 'picture-cue', 1, 1));
  h.element.fireVideoFrame(performance.now(), { mediaTime: 1.04, presentedFrames: 4 });
  health = h.controller.getPictureHealth();
  assert.equal(health.mediaTime, 1.04, 'backward loop/seek is valid presentation progress');
  assert.equal(health.presentedFrames, 4);
  h.emitCue(snapshotCue('still', 'still-cue', 2));
  assert.equal(h.controller.getPictureHealth().state, 'still');
  h.stop();
  assert.equal(h.element.frameCallbacks.size, 0, 'observers retire with output');
});

test('exact-file prepared status requires player decode and settled seek, and same-path replacement invalidates it', async () => {
  let doc = { ...project([audioItem('replace', { hasVideo: true, inPoint: 2 })]),
    server: { projectSessionId: 'show-1', audioReadiness: { fileRevisions: { replace: 'revision-1' } } } };
  const h = createHarness(doc);
  h.setFetchProject(async () => doc);
  await flush();
  h.emitSnapshot({ cues: [], next_item_uuid: 'replace' });
  await flush();
  let url = new URL(h.controller.videoSrc.value!);
  assert.equal(url.searchParams.get('file_revision'), 'revision-1');
  assert.equal(url.searchParams.get('project_session_id'), 'show-1');
  assert.equal(h.controller.getPictureHealth().preparedSeconds, null);
  h.element.currentSrc = h.controller.videoSrc.value!;
  Object.assign(h.element, { readyState: 3, seeking: false });
  h.controller.onVideoLoadedMetadata();
  h.controller.onVideoCanPlay();
  assert.equal(h.controller.getPictureHealth().preparedSeconds, 2);
  Object.assign(h.element, { seeking: true });
  assert.equal(h.controller.getPictureHealth().preparedSeconds, null);
  Object.assign(h.element, { seeking: false });
  const firstSource = h.controller.videoSrc.value;
  doc = { ...doc, server: { ...doc.server, audioReadiness: { fileRevisions: { replace: 'revision-2' } } } };
  h.emitPatch({ op: 'media_changed', item_uuid: 'replace', reloaded: true, file_revision: 'revision-2', project_session_id: 'show-1' });
  await flush();
  assert.notEqual(h.controller.videoSrc.value, firstSource);
  assert.equal(h.controller.getPictureHealth().preparedSeconds, null, 'previous revision decode is not readiness for replacement');
  url = new URL(h.controller.videoSrc.value!);
  assert.equal(url.searchParams.get('file_revision'), 'revision-2');
  const replacementSource = h.controller.videoSrc.value;
  h.emitPatch({ op: 'media_changed', item_uuid: 'replace', reloaded: true, project_session_id: 'old-show' });
  await flush();
  assert.equal(h.controller.videoSrc.value, replacementSource);
  h.stop();
});

test('next video uses the free element during audio, follows authored trim, and cannot disturb an on-air video', async () => {
  let doc = { ...project([audioItem('bed'), audioItem('next', { hasVideo: true, inPoint: 2 }), audioItem('other', { hasVideo: true })]),
    server: { projectSessionId: 'show', audioReadiness: { fileRevisions: { next: 'v1', other: 'v2' } } } };
  const h = createHarness(doc);
  h.setFetchProject(async () => doc);
  await flush();
  h.emitCue(snapshotCue('bed', 'bed-cue', 1));
  h.emitPatch({ op: 'next_item_set', itemUuid: 'next' });
  await flush();
  assert.ok(h.controller.videoSrc.value, 'eligible audio bed must prepare upcoming video');
  assert.equal(new URL(h.controller.videoSrc.value!).searchParams.get('item_uuid'), 'next');
  assert.equal(h.controller.showVideo.value, false, 'preparation must not put video over the audio bed');
  Object.assign(h.element, { readyState: 3, seeking: false });
  h.controller.onVideoLoadedMetadata();
  h.controller.onVideoCanPlay();
  assert.equal(h.element.currentTime, 2);
  assert.equal(h.element.paused, true);
  assert.equal(h.controller.getPictureHealth().preparedSeconds, 2);
  const source = h.controller.videoSrc.value;
  doc.items[1]!.inPoint = 3;
  h.emitSnapshot({ cues: [snapshotCue('bed', 'bed-cue', 1)], next_item_uuid: 'next' });
  await flush();
  assert.equal(h.element.currentTime, 3, 'same-file trim edits re-seek the prepared element');
  assert.equal(h.controller.videoSrc.value, source, 'no second decoder/source generation needed for trim-only change');
  h.emitCue(snapshotCue('next', 'video-cue', 2, 3));
  h.emitPatch({ op: 'next_item_set', itemUuid: 'other' });
  await flush();
  assert.equal(h.controller.videoSrc.value, source, 'upcoming video cannot replace the on-air element');
  h.stop();
});
