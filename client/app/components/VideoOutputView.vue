<!-- Audience output: the existing native-clocked video is also used by AV Sync.
     Test-card animation is explicit; the ordinary idle surface stays black. -->
<template>
  <div class="video-output" aria-hidden="true">
    <div class="video-output-frame" :style="frameStyle">
      <img v-if="standbySrc" class="layer layer-media" :src="standbySrc" alt="" draggable="false">
      <!-- One element for every still: a new src keeps the old picture until
           the new one has loaded, so slides cut without a flash of standby. -->
      <img v-if="cueImageSrc" class="layer layer-media" :src="cueImageSrc" alt="" draggable="false"
        @load="($event.currentTarget as HTMLImageElement).classList.add('layer-opaque'); onCueImageLoaded()">

      <!-- The target must exist before Teleport resolves an updated destination. -->
      <KardsTestCard
        v-if="testCard"
        class="layer"
        :style="testCardStyle"
        :config="config"
        :display-timing="testCardTiming"
        :network="status?.testCardInfo.network ?? []"
        :audio-description="status?.testCardPlayback?.description ?? 'Program output'"
      >
        <template #audio-sync><div id="test-card-video-target" /></template>
      </KardsTestCard>

      <!-- Move, rather than recreate, the same muted video into Kards' original
           AV Sync rectangle. Native audio remains the only audio/clock source. -->
      <!-- Two elements: the live picture and a spare that holds the next video
           cue loaded and on its first frame, so a cut swaps them without a reload. -->
      <Teleport defer :disabled="!showAudioSyncCard" :to="showAudioSyncCard ? '#test-card-video-target' : 'body'">
        <video
          v-for="slot in [0, 1]"
          :key="slot"
          v-show="slot !== liveSlot || (showVideo && (!testCard || (showAudioSyncCard && diagnosticSource !== null)))"
          :ref="(element) => registerVideoElement(slot, element as HTMLVideoElement | null)"
          :class="[showAudioSyncCard ? 'vt' : ['layer layer-media', { 'layer-opaque': slot === liveSlot && videoReady }],
            { 'layer-spare': slot !== liveSlot }]"
          :src="slotSources[slot] ?? undefined"
          muted
          playsinline
          preload="auto"
          disablepictureinpicture
          @loadedmetadata="slot === liveSlot ? onVideoLoadedMetadata() : onSpareEvent()"
          @loadeddata="slot === liveSlot ? onVideoCanPlay() : onSpareEvent()"
          @canplay="slot === liveSlot ? onVideoCanPlay() : onSpareEvent()"
          @seeked="slot !== liveSlot && onSpareEvent()"
          @error="slot === liveSlot ? onVideoError() : onSpareError()"
        />
      </Teleport>
      <canvas v-show="showHeldFrame && !testCard" ref="heldFrameEl" class="layer layer-media layer-opaque" />
    </div>
  </div>
</template>

<script setup lang="ts">
import KardsTestCard from './testcards/KardsTestCard.vue';
import { createTestCardConfig } from '../../electron/test-card-config.mjs';
import { DEFAULT_VIDEO_FRAMING, videoFrameLayout } from '../../electron/video-output-framing.mjs';

const server = useLiveplayServer();
const status = shallowRef<VideoOutputStatus | null>(null);
const testCardTiming = computed(() => {
  const s = status.value;
  if (s?.signal) {
    const a = s.signal.actual;
    if (!s.displayId) return 'Preview';
    if (!a.width || !a.height) return '';
    return `Mac · ${a.width}×${a.height}${a.interlaced ? 'i' : 'p'}${a.hz ? ' · ' + Number(a.hz.toFixed(5)) + ' Hz' : ''}`;
  }
  return s?.testCardInfo.displayFrequency ? `${s.testCardInfo.displayFrequency} Hz` : '';
});
const viewport = shallowRef({ width: 0, height: 0, pixelScale: 1 });
const frame = computed(() => {
  const { width, height, pixelScale } = viewport.value;
  return videoFrameLayout(width, height, status.value?.framing ?? DEFAULT_VIDEO_FRAMING, pixelScale);
});
const frameStyle = computed(() => ({
  width: `${frame.value.width}px`, height: `${frame.value.height}px`, '--picture-fit': frame.value.objectFit,
}));
const config = computed(() => status.value?.testCardConfig ?? createTestCardConfig());
const testCardStyle = computed(() => {
  if (!config.value.windowed) return;
  const box = videoFrameLayout(frame.value.width, frame.value.height,
    { ...config.value.window, scale: 100, scaling: 'limit' }, viewport.value.pixelScale);
  return { width: `${box.width}px`, height: `${box.height}px`, margin: 'auto' };
});
const testCard = computed(() => status.value?.testCard === true);
const showAudioSyncCard = computed(() => testCard.value && config.value.cardType === 'audioSync');
const diagnosticSource = computed(() => showAudioSyncCard.value ? status.value?.testCardPlayback ?? null : null);
const {
  videoReady, showVideo, heldFrameEl, showHeldFrame, cueImageSrc, standbySrc,
  liveSlot, slotSources, registerVideoElement, onSpareEvent, onSpareError, onCueImageLoaded,
  onVideoLoadedMetadata, onVideoCanPlay, onVideoError,
  getPictureHealth,
} = useVideoOutput(diagnosticSource, computed(() => status.value?.pictureOffsetMs ?? 0));

useHead({ title: 'DonWells Cue — Video Output' });
let offStatus: (() => void) | null = null;
let statusRevision = 0;
let infoTimer: ReturnType<typeof setInterval> | undefined;
let healthTimer: ReturnType<typeof setInterval> | undefined;
let viewportTimer: ReturnType<typeof setInterval> | undefined;

async function refreshStatus() {
  const api = window.electronAPI?.videoOutput;
  if (!api) return;
  const revision = statusRevision;
  try {
    const next = await api.status();
    if (revision === statusRevision) status.value = next;
  } catch { /* A later status push restores the projection. */ }
}

function syncConnection() {
  const api = window.electronAPI?.videoOutput;
  if (!api) return;
  void api.setTestCardConnection(server.connected ? {
    serverUrl: server.serverUrl, accessToken: server.effectiveAccessToken,
  } : null).catch((error) => {
    void api.reportPlaybackError({
      itemUuid: null,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

watch(() => [server.connected, server.serverUrl, server.effectiveAccessToken], syncConnection);
watch(testCard, (visible) => {
  clearInterval(infoTimer);
  infoTimer = visible ? setInterval(() => { void refreshStatus(); }, 10000) : undefined;
});

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') void window.electronAPI?.videoOutput?.setFullscreen(false);
}
function onDblClick() {
  void window.electronAPI?.videoOutput?.toggleFullscreen();
}
// Tell main what this page really covers. Only the page can see whether the
// window fills the screen it is on; main corrects a short window on Windows.
function updateViewport() {
  const width = Math.round(window.innerWidth);
  const height = Math.round(window.innerHeight);
  const pixelScale = window.devicePixelRatio || 1;
  if (width !== viewport.value.width || height !== viewport.value.height || pixelScale !== viewport.value.pixelScale) {
    viewport.value = { width, height, pixelScale };
  }
  void window.electronAPI?.videoOutput?.reportViewport?.({
    innerWidth: width,
    innerHeight: height,
    screenWidth: Math.round(window.screen.width),
    screenHeight: Math.round(window.screen.height),
    pixelScale,
  }).catch(() => { /* A closing output has no main-side window to report to. */ });
}

onMounted(async () => {
  updateViewport();
  window.addEventListener('resize', updateViewport);
  const api = window.electronAPI?.videoOutput;
  if (!api) return;
  offStatus = api.onStatus((next) => { statusRevision += 1; status.value = next; });
  void refreshStatus();
  syncConnection();
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('dblclick', onDblClick);
  await nextTick();
  // A minimized renderer can withhold animation callbacks behind the native cover.
  void api.rendererReady().catch(() => {});
  healthTimer = setInterval(() => { void api.reportPictureHealth(getPictureHealth()).catch(() => {}); }, 1000);
  // A display can change size or scaling under a window without resizing
  // it, so both are re-read rather than trusted from the last resize event.
  viewportTimer = setInterval(updateViewport, 2000);
});
onBeforeUnmount(() => {
  clearInterval(infoTimer);
  clearInterval(healthTimer);
  clearInterval(viewportTimer);
  offStatus?.();
  window.removeEventListener('resize', updateViewport);
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('dblclick', onDblClick);
  void window.electronAPI?.videoOutput?.setTestCardConnection(null).catch(() => {
    /* The closing output may already be destroyed; main owns native cleanup. */
  });
});
</script>

<style scoped>
.video-output {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  background: #000;
  cursor: none;
  user-select: none;
  overflow: hidden;
  -webkit-app-region: no-drag;
}
.video-output-frame {
  position: relative;
  overflow: hidden;
}
.layer { position: absolute; inset: 0; }
video { object-fit: contain; }
.layer-media { width: 100%; height: 100%; object-fit: var(--picture-fit, contain); }
.layer-opaque { background: #000; }
/* The spare decodes its first frame but is never seen until it is live. */
.layer-spare { opacity: 0; pointer-events: none; }
</style>
