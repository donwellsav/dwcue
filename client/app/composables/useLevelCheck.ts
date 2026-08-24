// Level Check: soundcheck mode that plays each cue's loudest ~5 s window
// through the PROGRAM output — deliberately the normal transport, because
// the operator is setting gains on the external mixer, which never sees the
// preview device. Peak position comes from the stored waveform buckets
// (per-bucket max across channels), clamped to the cue's in/out region.
//
// Enter with no auto-play (mixer faders may be up); Next/Prev auto-play so
// a walk through 24 cues is 24 keypresses.

import { computed, ref } from 'vue';
import type { AudioItem } from '~/types/project';

const PRE_ROLL_S = 2;
const WINDOW_S = 5;

export interface PeakWindow {
  start: number;
  end: number;
  peakAt: number;
}

// Loudest-bucket window for one cue, or null when the cue has no usable
// waveform (never analysed, or fully silent — nothing to check).
export function peakWindow(item: AudioItem): PeakWindow | null {
  const wf = item.waveform;
  const peaks = wf?.peaks;
  if (!peaks || peaks.length === 0) return null;
  const duration = (wf?.duration ?? 0) > 0 ? wf!.duration : item.duration;
  if (!(duration > 0)) return null;
  const inPt = Math.max(0, item.inPoint || 0);
  const outPt = Math.min(item.outPoint || duration, duration);
  if (outPt <= inPt) return null;
  const lo = Math.max(0, Math.floor((inPt / duration) * peaks.length));
  const hi = Math.min(peaks.length - 1, Math.ceil((outPt / duration) * peaks.length));
  let best = 0;
  let bestI = -1;
  for (let i = lo; i <= hi; i++) {
    const p = peaks[i] ?? 0;
    if (p > best) { best = p; bestI = i; }
  }
  if (bestI < 0) return null; // silent region — nothing to gain-check
  const peakAt = ((bestI + 0.5) / peaks.length) * duration;
  const start = Math.max(inPt, peakAt - PRE_ROLL_S);
  const end = Math.min(outPt, start + WINDOW_S);
  return { start, end, peakAt };
}

const active = ref(false);
const index = ref(0);
let stopTimer: ReturnType<typeof setTimeout> | null = null;

export function useLevelCheck() {
  const { currentProject, getAllItemsFlat } = useProject();
  const { activeCues, stopCue } = useAudioEngine();
  const server = useLiveplayServer();

  const items = computed<AudioItem[]>(() => {
    if (!currentProject.value) return [];
    return (getAllItemsFlat() as (AudioItem | { type: string })[])
      .filter((i): i is AudioItem => (i as AudioItem).type === 'audio' && peakWindow(i as AudioItem) !== null);
  });

  // Clamped lookup doubles as mutation-safety: a deleted cue mid-check just
  // slides the cursor to the last remaining item, no watcher needed.
  const currentItem = computed<AudioItem | null>(
    () => items.value[Math.min(index.value, items.value.length - 1)] ?? null,
  );
  const currentWindow = computed<PeakWindow | null>(() => {
    const item = currentItem.value;
    return item ? peakWindow(item) : null;
  });
  // Truth comes from the engine: the cue is "playing" while the server has it
  // active (it may end early if the window runs into the cue's out point).
  const playing = computed(() => {
    const item = currentItem.value;
    return item ? activeCues.value.has(item.uuid) : false;
  });

  function clearStopTimer() {
    if (stopTimer !== null) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
  }

  async function playCurrent() {
    const item = currentItem.value;
    const win = currentWindow.value;
    if (!item || !win) return;
    clearStopTimer();
    server.playItem(item.uuid, win.start);
    const ms = Math.max(300, Math.round((win.end - win.start) * 1000));
    const uuid = item.uuid;
    stopTimer = setTimeout(() => {
      stopTimer = null;
      void stopCue(uuid);
    }, ms);
  }

  async function stopCurrent() {
    clearStopTimer();
    const item = currentItem.value;
    if (item && activeCues.value.has(item.uuid)) await stopCue(item.uuid);
  }

  function start() {
    if (items.value.length === 0) return;
    index.value = 0;
    active.value = true;
  }

  async function exit() {
    await stopCurrent();
    active.value = false;
  }

  async function next() {
    if (index.value >= items.value.length - 1) return;
    await stopCurrent();
    index.value += 1;
    await playCurrent();
  }

  async function prev() {
    if (index.value <= 0) return;
    await stopCurrent();
    index.value -= 1;
    await playCurrent();
  }


  return {
    active,
    index,
    items,
    currentItem,
    currentWindow,
    playing,
    start,
    exit,
    next,
    prev,
    playCurrent,
    stopCurrent,
  };
}
