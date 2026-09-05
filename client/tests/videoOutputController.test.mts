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
  frameCallbacks: Map<number, (timestamp: number) => void>;
  nextFrameId: number;
  pause: () => void;
  play: () => Promise<void>;
  requestVideoFrameCallback: (callback: (timestamp: number) => void) => number;
  cancelVideoFrameCallback: (id: number) => void;
  fireVideoFrame: (timestamp: number) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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
    fireVideoFrame(timestamp) {
      const callbacks = Array.from(this.frameCallbacks.values());
      this.frameCallbacks.clear();
      for (const callback of callbacks) callback(timestamp);
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
