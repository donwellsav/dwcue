<template>
  <span ref="badge" role="img" :aria-label="label" :title="warning || undefined"
    :tabindex="image ? 0 : undefined"
    @pointerenter="enter" @pointerleave="closePreview" @pointercancel="closePreview"
    @focus="schedulePreview" @blur="closePreview" @keydown.esc="closePreview"
    @click.stop @dragstart.stop.prevent>
    <img v-if="image" class="video-thumbnail" :src="image" alt="" draggable="false" />
    <span v-else>VIDEO</span>
    <span v-if="warning" class="video-thumbnail-warning" aria-hidden="true">!</span>
    <Teleport to="body">
      <img v-if="previewStyle && image" class="video-thumbnail-preview" :style="previewStyle"
        :src="image" alt="" aria-hidden="true" />
    </Teleport>
  </span>
</template>

<script setup lang="ts">
import type { CSSProperties } from 'vue';
import type { AudioItem } from '~/types/project';
import { cueVideoUrl, readVideoThumbnail } from '~/utils/videoThumbnail';

const props = defineProps<{ cue: AudioItem; label: string; warning?: string }>();
const server = useLiveplayServer();
const { videoHoverScale } = useUiMode();
const badge = ref<HTMLSpanElement | null>(null);
const image = ref<string | null>(null);
const previewStyle = shallowRef<CSSProperties | null>(null);
const visible = ref(false);
let observer: IntersectionObserver | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

onMounted(() => {
  if (!badge.value) return;
  observer = new IntersectionObserver(([entry]) => { visible.value = !!entry?.isIntersecting; });
  observer.observe(badge.value);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  closePreview();
});

watch(() => {
  const { uuid, mediaPath, mediaServerPath, inPoint, outPoint, videoThumbnailTime } = props.cue;
  return { uuid, mediaPath, mediaServerPath, inPoint, outPoint, videoThumbnailTime,
    session: server.connected ? server.projectSessionId : null, url: server.serverUrl, token: server.effectiveAccessToken };
}, (source, _, onSourceChange) => {
  image.value = null;
  closePreview();
  if (!source.session || !source.url) return;
  const stop = watch(visible, (inView, _, onVisibilityChange) => {
    if (!inView) closePreview();
    if (!inView || image.value) return;
    const controller = new AbortController();
    onVisibilityChange(() => controller.abort());
    const url = cueVideoUrl(source.url, source.session, source.token, source.uuid);
    void readVideoThumbnail(url, source, controller.signal).then(frame => {
      if (!controller.signal.aborted) image.value = frame;
    });
  }, { immediate: true });
  onSourceChange(stop);
}, { immediate: true });

function closePreview() {
  clearTimeout(timer);
  if (!import.meta.client) return;
  previewStyle.value = null;
  window.removeEventListener('scroll', closePreview, true);
  window.removeEventListener('resize', closePreview);
  window.removeEventListener('blur', closePreview);
}

function schedulePreview() {
  closePreview();
  window.addEventListener('scroll', closePreview, true);
  window.addEventListener('resize', closePreview);
  window.addEventListener('blur', closePreview);
  timer = setTimeout(() => {
    if (!image.value || !badge.value) return;
    const rect = badge.value.getBoundingClientRect();
    const gutter = 8;
    const availableAbove = rect.top - gutter * 2;
    const availableBelow = window.innerHeight - rect.bottom - gutter * 2;
    const scale = Math.min(videoHoverScale.value, (window.innerWidth - gutter * 2) / rect.width,
      Math.max(availableAbove, availableBelow) / rect.height);
    if (scale <= 1) return;
    const width = rect.width * scale;
    const height = rect.height * scale;
    const left = Math.max(gutter, Math.min(rect.left + (rect.width - width) / 2, window.innerWidth - width - gutter));
    const top = availableAbove >= height ? rect.top - height - gutter : rect.bottom + gutter;
    previewStyle.value = { width: `${width}px`, height: `${height}px`, top: `${top}px`, left: `${left}px` };
  }, 3000);
}

function enter(event: PointerEvent) {
  if (event.pointerType === 'mouse' || event.pointerType === 'pen') schedulePreview();
}
</script>

<style scoped>
.video-thumbnail {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: inherit;
}
.video-thumbnail-warning {
  position: absolute;
  top: 0;
  inset-inline-end: 0;
  padding: 1px 3px;
  border-radius: 2px;
  background: var(--color-control);
  color: var(--color-danger);
}
.video-thumbnail-preview {
  position: fixed;
  z-index: 1200;
  pointer-events: none;
  box-sizing: border-box;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--control-radius);
  background: #08080a;
  object-fit: contain;
  box-shadow: 0 4px 18px #0009;
}
</style>
