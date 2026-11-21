<template>
  <details class="video-frame-picker" @toggle="open = ($event.target as HTMLDetailsElement).open">
    <summary>{{ t('videoThumbnail.choose') }}</summary>
    <template v-if="open && source">
      <video ref="video" :key="source" crossorigin="anonymous" muted playsinline preload="auto"
        :src="source" :aria-label="t('videoThumbnail.choose')"
        @loadedmetadata="initialize" @loadeddata="frameReady" @seeked="frameReady" @error="fail" />
      <p v-if="failed || !ready" class="property-help" role="status">
        {{ t(failed ? 'videoThumbnail.unavailable' : 'videoThumbnail.loading') }}
      </p>
      <template v-if="range && !failed">
        <label class="frame-position">
          {{ t('videoThumbnail.time') }}
          <output>{{ time.toFixed(3) }} s</output>
          <input type="range" class="app-range" :min="range.start" :max="range.end" step="any"
            :value="time" :aria-valuetext="`${time.toFixed(3)} s`"
            @input="seek(($event.target as HTMLInputElement).valueAsNumber)"
            @keydown.left.prevent="seek(time - 0.01)" @keydown.right.prevent="seek(time + 0.01)" />
        </label>
        <div class="frame-actions">
          <Btn type="button" :text="t('videoThumbnail.first')" @click="seek(range.start)" />
          <Btn type="button" :text="t('videoThumbnail.middle')" @click="seek(range.middle)" />
          <Btn type="button" :text="t('videoThumbnail.apply')" :disabled="!ready || disabled"
            @click="emit('apply', time)" />
          <Btn type="button" :text="t('videoThumbnail.saveCue')" :disabled="!ready || disabled || standbyCapturePending"
            @click="saveFrame('cue')" />
          <Btn type="button" :text="t('videoThumbnail.saveStandby')" :disabled="!ready || disabled || standbyCapturePending"
            @click="saveFrame('standby')" />
        </div>
      </template>
    </template>
  </details>
</template>

<script setup lang="ts">
import type { AudioItem } from '~/types/project';
import type { StillTarget } from '~/composables/useVideoStandbyCapture';
import { cueVideoUrl, drawVideoStill, videoThumbnailRange } from '~/utils/videoThumbnail';

const props = defineProps<{ cue: AudioItem; disabled: boolean }>();
const emit = defineEmits<{ apply: [time: number] }>();
const { t } = useLocalization();
const server = useLiveplayServer();
const { saveStill, standbyCapturePending } = useVideoStandbyCapture();
const { showHeaderWarning } = useHeaderWarnings();
const open = ref(false);
const video = ref<HTMLVideoElement | null>(null);
const duration = ref(0);
const range = computed(() => duration.value ? videoThumbnailRange(props.cue, duration.value) : null);
const time = ref(0);
const ready = ref(false);
const failed = ref(false);
const source = computed(() => server.connected && server.projectSessionId && server.serverUrl
  ? cueVideoUrl(server.serverUrl, server.projectSessionId, server.effectiveAccessToken, props.cue.uuid)
  : null);

watch([open, source], () => {
  duration.value = 0;
  ready.value = false;
  failed.value = false;
}, { flush: 'sync' });

function fail() {
  ready.value = false;
  failed.value = true;
}

function initialize() {
  const element = video.value;
  if (!element?.videoWidth || !Number.isFinite(element.duration) || element.duration <= 0) return fail();
  duration.value = element.duration;
  if (range.value) seek(range.value.time);
}

function seek(position: number) {
  const element = video.value;
  if (!element || !range.value || !Number.isFinite(position)) return;
  time.value = Math.max(range.value.start, Math.min(range.value.end, position));
  if (element.currentTime !== time.value) {
    ready.value = false;
    element.currentTime = time.value;
  }
  frameReady();
}

function frameReady() {
  const element = video.value;
  if (!element || failed.value) return;
  ready.value = !element.seeking && element.readyState >= element.HAVE_CURRENT_DATA &&
    Math.abs(element.currentTime - time.value) <= 0.05;
}

function saveFrame(target: StillTarget) {
  const element = video.value;
  if (!element || !ready.value || props.disabled) return;
  try {
    const image = drawVideoStill(element, 1920);
    if (image) return saveStill(target, props.cue, image);
  } catch {}
  showHeaderWarning(t('standbyCapture.failed'));
}
</script>

<style scoped>
.video-frame-picker { margin-block: 6px; }
summary { cursor: pointer; }
video {
  display: block;
  width: 100%;
  max-height: 210px;
  margin-block: 8px;
  background: #08080a;
  object-fit: contain;
}
.frame-position {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px 8px;
}
.frame-position input { grid-column: 1 / -1; width: 100%; }
.frame-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-block-start: 8px; }
</style>
