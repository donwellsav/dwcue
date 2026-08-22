<!--
  VideoOutputView.vue
  ---------------------------------------------------------------------------
  The ?videoOutput=1 render surface. Slice 1 scope: an opaque black base layer
  plus the test card; per-cue images / standby image / muted <video> arrive in
  slice 3 on top of this same component.

  Rules that matter here (learned the hard way by Inkue/FreeShow):
  - The window must paint OPAQUE BLACK when idle — never nothing (Wayland and
    some switchers treat a never-committed frame as "no signal").
  - A cut replaces content in the same frame; never leave a frozen last frame.
  - Nothing on this surface may animate continuously; each repaint is GPU work
    that competes with video decode on weak iGPUs.
  - No cursor, no selection, no scrolling, no window chrome interactions.
-->
<template>
  <div class="video-output" aria-hidden="true">
    <!-- Layer stack, bottom to top: black < standby image < per-cue image <
         video. Lower layers show through whenever the layers above them are
         empty — no visibility logic needed beyond the top two. -->
    <div class="layer layer-black" />

    <img
      v-if="standbySrc"
      class="layer layer-media"
      :src="standbySrc"
      alt=""
      draggable="false"
    >

    <img
      v-if="cueImageSrc"
      class="layer layer-media"
      :src="cueImageSrc"
      alt=""
      draggable="false"
    >

    <!-- Muted always: video audio goes through the engine to the PA, never
         to HDMI. Stay mounted (v-show, not v-if) so preloading an armed cue
         doesn't tear down the element when the previous cue stops. -->
    <video
      v-show="showVideo"
      ref="videoEl"
      class="layer layer-media"
      :src="videoSrc ?? undefined"
      muted
      playsinline
      preload="auto"
      disablepictureinpicture
      @loadedmetadata="onVideoLoadedMetadata"
      @canplay="onVideoCanPlay"
      @error="onVideoError"
    />

    <div v-if="testCard" class="layer layer-testcard">
      <div class="safe-area safe-area--action" />
      <div class="safe-area safe-area--title" />
      <div class="crosshair crosshair--h" />
      <div class="crosshair crosshair--v" />

      <div class="testcard-text">
        <div class="testcard-app">DONWELLS CUE</div>
        <div class="testcard-title">VIDEO OUTPUT</div>
        <div class="testcard-meta">{{ resolutionText }}</div>
        <div v-if="displayText" class="testcard-meta testcard-meta--dim">{{ displayText }}</div>
      </div>

      <div class="testcard-corner testcard-corner--tl" />
      <div class="testcard-corner testcard-corner--tr" />
      <div class="testcard-corner testcard-corner--bl" />
      <div class="testcard-corner testcard-corner--br" />
    </div>
  </div>
</template>

<script setup lang="ts">
const {
  videoEl, videoSrc, showVideo, cueImageSrc, standbySrc,
  onVideoLoadedMetadata, onVideoCanPlay, onVideoError,
} = useVideoOutput();

const testCard = ref(false);
const displayLabel = ref<string | null>(null);

// Physical pixels matter to the person at the switcher — CSS pixels lie on
// scaled displays (macOS Retina, Windows 125%/150%).
const cssWidth = ref(0);
const cssHeight = ref(0);

const resolutionText = computed(() => {
  if (!cssWidth.value || !cssHeight.value) return '';
  const scale = window.devicePixelRatio || 1;
  const w = Math.round(cssWidth.value * scale);
  const h = Math.round(cssHeight.value * scale);
  return scale !== 1
    ? `${w} × ${h}  (${cssWidth.value} × ${cssHeight.value} @ ${scale}x)`
    : `${w} × ${h}`;
});

const displayText = computed(() => displayLabel.value ?? '');

function readViewport() {
  cssWidth.value = window.innerWidth;
  cssHeight.value = window.innerHeight;
}

let offStatus: (() => void) | null = null;
let offTestCard: (() => void) | null = null;

// Distinct OS-level title so the output is identifiable in Mission Control,
// the Window menu, and screen-sharing pickers. Must go through useHead —
// Nuxt's head manager owns <title> and would revert a raw assignment.
useHead({ title: 'DonWells Cue — Video Output' });

onMounted(() => {
  readViewport();
  window.addEventListener('resize', readViewport);

  const api = window.electronAPI?.videoOutput;
  if (!api) return; // pure-browser dev preview

  api.status().then((status) => {
    displayLabel.value = status.targetLabel;
    testCard.value = status.testCard;
  }).catch(() => { /* main not ready yet; the onStatus push will land */ });

  offStatus = api.onStatus((status) => {
    displayLabel.value = status.targetLabel;
  });
  offTestCard = api.onTestCard((show) => {
    testCard.value = show;
  });
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', readViewport);
  offStatus?.();
  offTestCard?.();
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

.layer {
  position: absolute;
  inset: 0;
}

.layer-black {
  background: #000;
}

/* Video + stills: letterbox, never crop — a switcher expects the full frame.
   The black base layer makes the letterbox bars invisible by construction. */
.layer-media {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

/* --- Test card -----------------------------------------------------------
   Thin 65%-white lines on black: readable on a projector at distance without
   lighting up the room. Safe areas follow the classic 90% action / 80% title
   convention so the switcher op can check framing. */

.layer-testcard {
  border: 2px solid rgba(255, 255, 255, 0.65);
  box-sizing: border-box;
}

.safe-area {
  position: absolute;
  border: 1px dashed rgba(255, 255, 255, 0.4);
  box-sizing: border-box;
}
.safe-area--action { inset: 5%; }
.safe-area--title  { inset: 10%; }

.crosshair {
  position: absolute;
  background: rgba(255, 255, 255, 0.35);
}
.crosshair--h { left: 0; right: 0; top: 50%; height: 1px; }
.crosshair--v { top: 0; bottom: 0; left: 50%; width: 1px; }

.testcard-text {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.2vh;
  color: rgba(255, 255, 255, 0.85);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  text-align: center;
  letter-spacing: 0.35em;
  text-indent: 0.35em; /* optically re-centre the tracked text */
}

.testcard-app   { font-size: 2.2vh; opacity: 0.7; }
.testcard-title { font-size: 6vh; font-weight: 700; }
.testcard-meta  { font-size: 2.6vh; letter-spacing: 0.15em; text-indent: 0.15em; }
.testcard-meta--dim { opacity: 0.55; }

.testcard-corner {
  position: absolute;
  width: 3vh;
  height: 3vh;
  border: 2px solid rgba(255, 255, 255, 0.65);
}
.testcard-corner--tl { top: 2vh;    left: 2vh;  border-right: none; border-bottom: none; }
.testcard-corner--tr { top: 2vh;    right: 2vh; border-left: none;  border-bottom: none; }
.testcard-corner--bl { bottom: 2vh; left: 2vh;  border-right: none; border-top: none; }
.testcard-corner--br { bottom: 2vh; right: 2vh; border-left: none;  border-top: none; }
</style>
