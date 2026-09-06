<!-- Audience output: the existing native-clocked video is also used by AV Sync.
     Test-card animation is explicit; the ordinary idle surface stays black. -->
<template>
  <div class="video-output" aria-hidden="true">
    <div class="layer layer-black" />
    <img v-if="standbySrc" class="layer layer-media" :src="standbySrc" alt="" draggable="false">
    <img v-if="cueImageSrc" class="layer layer-media" :src="cueImageSrc" alt="" draggable="false">

    <!-- The target must exist before Teleport resolves an updated destination. -->
    <KardsTestCard
      v-if="testCard"
      class="layer"
      :config="config"
      :display-frequency="status?.testCardInfo.displayFrequency ?? 0"
      :network="status?.testCardInfo.network ?? []"
      :audio-description="status?.testCardPlayback?.description ?? 'Program output'"
    >
      <template #audio-sync><div id="test-card-video-target" /></template>
    </KardsTestCard>

    <!-- Move, rather than recreate, the same muted video into Kards' original
         AV Sync rectangle. Native audio remains the only audio/clock source. -->
    <Teleport defer :disabled="!showAudioSyncCard" :to="showAudioSyncCard ? '#test-card-video-target' : 'body'">
      <video
        v-show="showVideo && (!testCard || (showAudioSyncCard && diagnosticSource !== null))"
        ref="videoEl"
        :class="showAudioSyncCard ? 'vt' : 'layer layer-media'"
        :src="videoSrc ?? undefined"
        muted
        playsinline
        preload="auto"
        disablepictureinpicture
        @loadedmetadata="onVideoLoadedMetadata"
        @canplay="onVideoCanPlay"
        @error="onVideoError"
      />
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import KardsTestCard from './testcards/KardsTestCard.vue';
import { createTestCardConfig } from '../../electron/test-card-config.mjs';

const server = useLiveplayServer();
const status = shallowRef<VideoOutputStatus | null>(null);
const config = computed(() => status.value?.testCardConfig ?? createTestCardConfig());
const testCard = computed(() => status.value?.testCard === true);
const showAudioSyncCard = computed(() => testCard.value && config.value.cardType === 'audioSync');
const diagnosticSource = computed(() => showAudioSyncCard.value ? status.value?.testCardPlayback ?? null : null);
const {
  videoEl, videoSrc, showVideo, cueImageSrc, standbySrc,
  onVideoLoadedMetadata, onVideoCanPlay, onVideoError,
} = useVideoOutput(diagnosticSource);

useHead({ title: 'DonWells Cue — Video Output' });
let offStatus: (() => void) | null = null;
let statusRevision = 0;
let infoTimer: ReturnType<typeof setInterval> | undefined;

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

onMounted(() => {
  const api = window.electronAPI?.videoOutput;
  if (!api) return;
  offStatus = api.onStatus((next) => { statusRevision += 1; status.value = next; });
  void refreshStatus();
  syncConnection();
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('dblclick', onDblClick);
});
onBeforeUnmount(() => {
  clearInterval(infoTimer);
  offStatus?.();
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
  background: #000;
  cursor: none;
  user-select: none;
  overflow: hidden;
  -webkit-app-region: no-drag;
}
.layer { position: absolute; inset: 0; }
.layer-black { background: #000; }
.layer-media { width: 100%; height: 100%; object-fit: contain; }
</style>
