<template>
  <!--
    Vertical canvas-based volume fader.

    Why canvas instead of <input type="range" rotate(-90deg)>: the rotated
    range input was unreliable across Chromium builds — pointer math broke
    in containers with transforms, the thumb hit-box drifted, and dark-mode
    label colours leaked from the UA stylesheet. Canvas gives us pixel-exact
    control of the track, thumb, drag math, and theming.

    Interaction:
      • Click + vertical drag       → set value (coarse)
      • Shift + drag                → fine adjust (¼ sensitivity)
      • Wheel                       → ±0.5 dB step
      • Double-click                → emit('reset')
  -->
  <div
    ref="hostRef"
    class="canvas-fader"
    role="slider"
    tabindex="0"
    aria-orientation="vertical"
    :aria-label="label || 'Volume'"
    :aria-valuemin="minDb"
    :aria-valuemax="maxDb"
    :aria-valuenow="Math.max(minDb, db)"
    :aria-valuetext="ariaValueText"
    @mousedown="onMouseDown"
    @dblclick="$emit('reset')"
    @wheel.prevent="onWheel"
    @keydown="onKeyDown"
  >
    <canvas ref="canvasRef" class="canvas-fader__canvas" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  consolePositionToDb,
  dbToConsolePosition,
} from '~/utils/audio';

const props = withDefaults(defineProps<{
  db: number;
  minDb?: number;
  maxDb?: number;
  label?: string;
}>(), {
  minDb: -60,
  maxDb: 6,
});

const emit = defineEmits<{
  (e: 'input', db: number): void;
  (e: 'reset'): void;
}>();

const hostRef   = ref<HTMLElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const trackPadding = 10;

const ariaValueText = computed(() =>
  props.db <= props.minDb
    ? 'minus infinity decibels'
    : `${props.db > 0 ? 'plus ' : ''}${props.db} decibels`,
);

// Shared with StereoMeter so live level and fader travel follow one scale.
const dbToNorm = (db: number) =>
  dbToConsolePosition(db, props.minDb, props.maxDb);
const normToDb = (n: number) =>
  consolePositionToDb(n, props.minDb, props.maxDb);

function readCssVar(name: string, fallback: string): string {
  const host = hostRef.value;
  if (!host) return fallback;
  const v = getComputedStyle(host).getPropertyValue(name).trim();
  return v || fallback;
}

function draw() {
  const cv = canvasRef.value;
  const host = hostRef.value;
  if (!cv || !host) return;

  const dpr = window.devicePixelRatio || 1;
  const w = host.clientWidth;
  const h = host.clientHeight;
  if (w === 0 || h === 0) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width  = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const trackW = 6;
  const trackCenterX = w / 2;
  const trackX = trackCenterX - trackW / 2;
  const padTop    = trackPadding;
  const padBottom = trackPadding;
  const trackTop    = padTop;
  const trackBottom = h - padBottom;
  const trackH = trackBottom - trackTop;

  const border = readCssVar('--color-border', '#444');
  const borderStrong = readCssVar('--color-border-strong', '#666');
  const accent = readCssVar('--color-accent', '#0f62fe');
  const surface = readCssVar('--color-surface', '#1f2226');
  const surfaceRaised = readCssVar('--color-surface-raised', '#2b2f36');
  const background = readCssVar('--color-background', '#0d0f13');
  const secondary = readCssVar('--color-text-secondary', '#888');

  // Recessed rail: neutral rather than accent-filled, so it reads as a
  // physical console control instead of a progress bar.
  ctx.fillStyle = border;
  ctx.beginPath();
  if (typeof (ctx as any).roundRect === 'function') {
    (ctx as any).roundRect(trackX - 4, trackTop, trackW + 8, trackH, 5);
  } else {
    ctx.rect(trackX - 4, trackTop, trackW + 8, trackH);
  }
  ctx.fill();
  ctx.fillStyle = background;
  ctx.fillRect(trackX, trackTop, trackW, trackH);

  const zeroY = trackTop + (1 - dbToNorm(0)) * trackH;
  const valY  = trackTop + (1 - dbToNorm(props.db)) * trackH;

  // Strong unity reference.
  ctx.strokeStyle = secondary;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(trackCenterX - 12, zeroY);
  ctx.lineTo(trackCenterX + 12, zeroY);
  ctx.stroke();

  // Raised rectangular cap with a clear pickup line. This keeps the whole
  // canvas as the hit target while giving the eye a familiar DAW fader.
  const capW = Math.min(38, w - 6);
  const capH = 22;
  const capX = trackCenterX - capW / 2;
  const capY = valY - capH / 2;
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 2;
  const capGradient = ctx.createLinearGradient(0, capY, 0, capY + capH);
  capGradient.addColorStop(0, surfaceRaised);
  capGradient.addColorStop(0.52, surface);
  capGradient.addColorStop(1, background);
  ctx.fillStyle = capGradient;
  ctx.beginPath();
  if (typeof (ctx as any).roundRect === 'function') {
    (ctx as any).roundRect(capX, capY, capW, capH, 4);
  } else {
    ctx.rect(capX, capY, capW, capH);
  }
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = borderStrong;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(capX + 5, valY);
  ctx.lineTo(capX + capW - 5, valY);
  ctx.stroke();
}

watch(() => [props.db, props.minDb, props.maxDb], () => draw());

let resizeObserver: ResizeObserver | null = null;
let themeObserver: MutationObserver | null = null;
onMounted(() => {
  draw();
  if (hostRef.value) {
    resizeObserver = new ResizeObserver(() => draw());
    resizeObserver.observe(hostRef.value);
  }
  // Redraw whenever the theme attribute changes on the root element so that
  // CSS variable colours (accent, border, surface) are picked up immediately.
  themeObserver = new MutationObserver(() => draw());
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
});
onUnmounted(() => {
  if (resizeObserver) resizeObserver.disconnect();
  resizeObserver = null;
  if (themeObserver) themeObserver.disconnect();
  themeObserver = null;
});

// ---- Pointer interaction ---------------------------------------------------
// Drag math is anchored: at mouse-down we record the current dB AND mouse
// position. Subsequent moves translate the *delta* into a dB delta over the
// available track height. This avoids the "jumps to cursor" feel of an
// absolute-position fader, and lets shift-drag scale sensitivity cleanly.
let dragging   = false;
let dragStartY = 0;
let dragStartNorm = 0;

function trackHeightPx(): number {
  const host = hostRef.value;
  if (!host) return 1;
  return Math.max(1, host.clientHeight - trackPadding * 2);
}

function onMouseDown(e: MouseEvent) {
  if (e.button !== 0) return;
  dragging = true;
  dragStartY = e.clientY;
  dragStartNorm = dbToNorm(props.db);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  // For a single click without drag, snap to clicked position. We use a
  // tiny threshold: only snap if the click is far from the thumb.
  const host = hostRef.value;
  if (host) {
    const rect = host.getBoundingClientRect();
    const yInside = e.clientY - rect.top;
    const norm = 1 - (yInside - trackPadding) / trackHeightPx();
    const targetDb = normToDb(norm);
    if (Math.abs(norm - dbToNorm(props.db)) * trackHeightPx() > 8) {
      // Re-anchor the drag to the snapped value so further drag is relative.
      dragStartNorm = dbToNorm(targetDb);
      emit('input', clampToStep(targetDb, /*fine*/ false));
    }
  }
}

function onMouseMove(e: MouseEvent) {
  if (!dragging) return;
  const dy = dragStartY - e.clientY; // dragging up = positive
  const sens = e.shiftKey ? 0.25 : 1;
  const nextDb = clampToStep(
    normToDb(dragStartNorm + (dy / trackHeightPx()) * sens),
    e.shiftKey,
  );
  emit('input', nextDb);
}

function onMouseUp() {
  dragging = false;
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mouseup', onMouseUp);
}

function onWheel(e: WheelEvent) {
  const step = e.shiftKey ? 0.1 : 0.5;
  const dir  = e.deltaY < 0 ? 1 : -1;
  const current = Math.max(props.minDb, props.db);
  emit('input', clampToStep(current + dir * step, e.shiftKey));
}

function onKeyDown(e: KeyboardEvent) {
  const step = e.shiftKey ? 0.1 : 0.5;
  const current = Math.max(props.minDb, props.db);
  let next: number | null = null;
  if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = current + step;
  else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = current - step;
  else if (e.key === 'PageUp') next = current + 3;
  else if (e.key === 'PageDown') next = current - 3;
  else if (e.key === 'Home') next = props.minDb;
  else if (e.key === 'End') next = props.maxDb;
  if (next == null) return;
  e.preventDefault();
  emit('input', clampToStep(next, e.shiftKey));
}

function clampToStep(db: number, fine: boolean): number {
  const step = fine ? 0.1 : 0.5;
  const snapped = Math.round(db / step) * step;
  const v = Math.max(props.minDb, Math.min(props.maxDb, snapped));
  // Avoid -0 noise
  return Object.is(v, -0) ? 0 : Number(v.toFixed(2));
}
</script>

<style scoped>
.canvas-fader {
  flex: 1;
  width: 48px;
  min-height: 40px;
  cursor: ns-resize;
  user-select: none;
  touch-action: none;
}
.canvas-fader:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
  border-radius: 4px;
}
.canvas-fader__canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
