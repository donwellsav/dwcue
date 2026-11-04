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

function project(items: unknown[], cartOnlyItems: unknown[] = []) {
  return {
    folderPath: '/shows/current',
    items,
    cartOnlyItems,
    settings: { videoStandbyImage: 'images/standby.png' },
  };
}

function videoElement(): MockVideo {
  return {
    currentTime: 0,
    currentSrc: '',
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

function createHarness(initialProject: unknown, connected = true) {
  const cueStateHandlers = new Set<(value: unknown) => void>();
  const meterHandlers = new Set<(value: any) => void>();
  const snapshotHandlers = new Set<(value: unknown) => void>();
  const patchHandlers = new Set<(value: unknown) => void>();
  const reports: Array<{ itemUuid: string | null; message: string } | null> = [];
  let fetchProject = async () => initialProject;

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
    fetchProject: () => fetchProject(),
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
      electronAPI: {
        videoOutput: {
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
  const controller = scope.run(() => useVideoOutput(diagnostic));
  assert.ok(controller);
  const element = videoElement();
  controller.videoEl.value = element as unknown as HTMLVideoElement;

  return {
    controller,
    diagnostic,
    element,
    reports,
    server,
    setFetchProject(next: () => Promise<unknown>) {
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

test('resolves canonical group children and cart-only video through item_uuid', async () => {
  const groupChild = audioItem('group-child', { hasVideo: true, mediaPath: 'media/group.mp4' });
  const cartOnly = audioItem('cart-only', {
    hasVideo: true,
    mediaServerPath: '/Volumes/media/cart.mp4',
  });
  const harness = createHarness(project([{
    uuid: 'group',
    type: 'group',
    children: [groupChild],
  }], [cartOnly]));
  await flush();

  harness.emitSnapshot({
    cues: [snapshotCue('group-child', 'cue-group', 1, 2), snapshotCue('cart-only', 'cue-cart', 2, 3)],
    preview: null,
    next_item_uuid: '',
  });
  await flush();

  const cartUrl = new URL(harness.controller.videoSrc.value!);
  assert.equal(cartUrl.pathname, '/api/media');
  assert.equal(cartUrl.searchParams.get('item_uuid'), 'cart-only');
  assert.equal(cartUrl.searchParams.has('path'), false, 'absolute server paths never leak into video URLs');

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
  harness.element.currentTime = 5.28;
  harness.emitMeters({ items: [{ cue_id: 'loop-cue', transport: 1, playhead_seconds: 5.25 }] });
  assert.ok(harness.element.currentTime > 5.25, 'soft drift remains rate-corrected instead of seeking every meter');
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
    for (const clock of [1, 1.033, 1.066]) {
      h.element.currentTime = clock + .035;
      h.emitMeters({ items: [{ cue_id: 'video-cue', transport: 1, playhead_seconds: clock }] });
      const before = h.element.currentTime;
      h.controller.onVideoCanPlay();
      assert.equal(h.element.currentTime, before, 'readiness restoration must not bypass soft drift correction');
      assert.ok(h.element.playbackRate < 1);
      assert.equal(h.element.paused, false);
    }
    h.emitMeters({ items: [{ cue_id: 'video-cue', transport: 1, playhead_seconds: 2 }] });
    assert.equal(h.element.currentTime, 2, 'large drift still uses the existing hard seek');
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

  harness.emitPatch({ op: 'preview_started', itemUuid: 'preview-video' });
  harness.emitCue(snapshotCue('preview-video', 'preview-cue', 100, 0, 1));
  assert.equal(new URL(harness.controller.videoSrc.value!).searchParams.get('item_uuid'), 'older-video');
  harness.stop();
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
