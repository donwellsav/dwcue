<template>
  <div ref="headerRef" class="project-header">
    <div ref="leftRef" class="header-left">
      <img
        ref="logoRef"
        :src="isDark ? './assets/icons/SVG/app_icon_darkmode@web.svg' : './assets/icons/SVG/app_icon_lightmode@web.svg'"
        alt="DonWells Cue"
        class="header-logo"
      />
      <div class="header-titles">
        <span
          class="brand-wordmark"
          :class="{ 'brand-wordmark--hidden': hideTitle }"
        >{{ t('app.name') }}</span>
        <h2
          class="project-name"
          :class="{ 'project-name--hidden': hideTitle }"
          :title="currentProject?.name || t('project.noProject')"
        >{{ currentProject?.name || t('project.noProject') }}</h2>
      </div>
      <span
        v-if="currentProject && !autoSaveEnabled && hasUnsavedChanges"
        class="unsaved-pill"
      >{{ t('project.unsavedChanges') }}</span>
    </div>

    <div
      v-if="silenceWarning"
      ref="warningRef"
      class="silence-warning"
      :class="[silenceWarningClass, { 'silence-warning--left': warningMode === 'left' }]"
      :style="warningStyle"
    >
      {{ t('project.silenceWarning') }} {{ Math.ceil(silenceWarning) }} {{ t('project.seconds') }}
    </div>

    <div ref="rightRef" class="header-right">
      <!-- Appears the moment the socket drops; spins for as long as we retry. -->
      <ConnectionStatusPill />

      <Btn :text="t('settings.title')" @click="showProjectSettings = true" />
      <Btn :text="t('controls.shortcutBtn')" @click="showShortcutsBar = !showShortcutsBar" />
      <Btn
        :text="t('settings.tabVideoOutput')"
        :class="{ 'video-toggle--active': videoOutputOpen }"
        @click="toggleVideoOutput"
      />
      <Btn
        :text="t('levelCheck.title')"
        :class="{ 'level-check-toggle--active': levelCheckActive }"
        :disabled="levelCheckCount === 0"
        @click="toggleLevelCheck"
      />

      <!-- Autosave toggle: on by default; when off the project is only saved
           via File > Save and an "Unsaved Changes" pill appears by the title. -->
      <button
        type="button"
        class="autosave-toggle"
        role="switch"
        :aria-checked="autoSaveEnabled"
        :aria-label="t('project.autosave')"
        :disabled="!currentProject"
        @click="setAutoSave(!autoSaveEnabled)"
      >
        <span class="autosave-toggle__label">{{ t('project.autosave') }}</span>
        <span class="autosave-toggle__track" :class="{ 'autosave-toggle__track--on': autoSaveEnabled }">
          <span class="autosave-toggle__thumb"></span>
        </span>
      </button>

      <!-- Show Mode toggle: flips the whole workspace into the touch-friendly
           playback layout (edit buttons hidden, larger touch targets) and back.
           Persisted per-device, not in the project. -->
      <button
        type="button"
        class="autosave-toggle showmode-toggle"
        role="switch"
        :aria-checked="uiMode === 'playback'"
        :aria-label="t('showMode.toggle')"
        :disabled="!currentProject"
        :title="t('showMode.toggleHint')"
        @click="toggleUiMode"
      >
        <span class="autosave-toggle__label">{{ t('showMode.toggle') }}</span>
        <span class="autosave-toggle__track" :class="{ 'autosave-toggle__track--on': uiMode === 'playback' }">
          <span class="autosave-toggle__thumb"></span>
        </span>
      </button>

      <!-- Clock pair: wall clock always shown; LTC box only appears once an
           LTC output device is configured in Project Settings — otherwise
           it's permanent header clutter that never does anything. -->
      <div class="clock-pair">
        <VideoConfidenceChip :open="videoOutputOpen" />
        <div class="digital-clock clock--large" :class="primaryActiveCue ? 'clock--active' : 'clock--inactive'">
          <span class="clock-label">{{ t('project.timeLeft') }}</span>
          <span class="clock-value" :style="{ color: timeLeftColor ?? undefined }">{{ timeLeft }}</span>
        </div>
        <div class="digital-clock clock--large clock--active">
          <span class="clock-label">{{ t('project.clock') }}</span>
          <span class="clock-value">{{ currentTime }}</span>
        </div>
        <div v-if="hasLtcDevice" class="digital-clock" :class="ltcTimecode ? 'clock--active' : 'clock--inactive'">
          <span class="clock-label">LTC</span>
          <span class="clock-value">{{ ltcTimecode ?? '--:--:--:--' }}</span>
        </div>
      </div>
    </div>
  </div>

  <ControlConfigModal
    v-if="showControlConfig"
    @close="showControlConfig = false"
  />
  <ProjectSettingsModal
    :open="showProjectSettings"
    @close="showProjectSettings = false"
    @open-shortcuts="showProjectSettings = false; showControlConfig = true"
  />
</template>

<script setup lang="ts">
import ProjectSettingsModal from './ProjectSettingsModal.vue';
import Btn from './Btn.vue';
import VideoConfidenceChip from './VideoConfidenceChip.vue';
import { countdownColorForSeconds, type AudioItem } from '~/types/project';

const { currentProject, findItemByUuid, findItemByIndex, autoSaveEnabled, hasUnsavedChanges, setAutoSave } = useProject();
const { t } = useLocalization();
const { activeCues } = useAudioEngine();
const { uiMode, toggleUiMode } = useUiMode();

const showControlConfig = useState('showControlConfig', () => false);
const showShortcutsBar = useState('showShortcutsBar', () => false);
const showProjectSettings = useState('showProjectSettings', () => false);

const isDark = computed(() => currentProject.value?.theme.mode === 'dark');
const currentTime = ref('00:00:00');

// Match PlaylistView's primary-cue convention: during a seamless advance the
// newest cue is the one the operator is now following.
const primaryActiveCue = computed(() => [...activeCues.value.values()].at(-1) ?? null);
const displayedRemainingSeconds = computed<number | null>(() => {
  const cue = primaryActiveCue.value;
  if (!cue
      || !Number.isFinite(cue.duration)
      || !Number.isFinite(cue.currentTime)
      || cue.duration <= 0) {
    return null;
  }
  return Math.max(0, Math.ceil(cue.duration - cue.currentTime));
});
const timeLeft = computed(() => {
  const total = displayedRemainingSeconds.value;
  if (total === null) return '--:--';
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${String(minutes).padStart(2, '0')}:${seconds}`;
});
const timeLeftColor = computed(() => countdownColorForSeconds(
  displayedRemainingSeconds.value,
  (currentProject.value as any)?.settings?.countdownColorBands,
));

// ---- Silence warning -------------------------------------------------------

const silenceWarning = ref<number | null>(null);

const silenceWarningClass = computed(() => {
  if (!silenceWarning.value) return '';
  const seconds = silenceWarning.value;
  if (seconds <= 5) return 'flash-fast';
  if (seconds <= 10) return 'flash-medium';
  if (seconds <= 30) return 'flash-slow';
  return 'warning-yellow';
});

// ---- Silence-warning placement --------------------------------------------
// The warning sits centred over the header, but the header's right side now
// carries buttons + clocks. We adapt:
//   1. center : enough room → keep it centred over the whole header.
//   2. gap    : centred banner would overlap the left/right blocks → centre it
//               in the free gap between the title area and the buttons/clocks.
//   3. left   : it still won't fit in the gap → align it left and let it take
//               the project title's place (the logo stays put).
const headerRef  = ref<HTMLElement | null>(null);
const leftRef    = ref<HTMLElement | null>(null);
const logoRef    = ref<HTMLElement | null>(null);
const rightRef   = ref<HTMLElement | null>(null);
const warningRef = ref<HTMLElement | null>(null);

const warningMode = ref<'center' | 'gap' | 'left'>('center');
const warningLeftPx = ref(0);
const warningMaxWidthPx = ref<number | null>(null);
const hideTitle = computed(() => !!silenceWarning.value && warningMode.value === 'left');

const warningStyle = computed(() => ({
  left: `${warningLeftPx.value}px`,
  maxWidth: warningMaxWidthPx.value === null ? undefined : `${warningMaxWidthPx.value}px`,
  transform: warningMode.value === 'left' ? 'translateX(0)' : 'translateX(-50%)',
}));

const PLACEMENT_MARGIN = 12; // breathing room kept from neighbouring blocks

function recomputeWarningPlacement() {
  const header = headerRef.value;
  const warning = warningRef.value;
  const left = leftRef.value;
  const logo = logoRef.value;
  const right = rightRef.value;
  if (!header || !warning || !left || !logo || !right) return;

  const headerRect = header.getBoundingClientRect();
  // Geometry is measured with the title always occupying space, so the chosen
  // mode never oscillates: in "left" mode the title is only made invisible, it
  // keeps its layout box.
  const leftEdge  = left.getBoundingClientRect().right - headerRect.left;
  const rightEdge = right.getBoundingClientRect().left - headerRect.left;
  const logoEdge  = logo.getBoundingClientRect().right - headerRect.left;
  const w = warning.offsetWidth;
  const center = headerRect.width / 2;

  // 1. Centred over the whole header without touching either block?
  if (center - w / 2 >= leftEdge + PLACEMENT_MARGIN &&
      center + w / 2 <= rightEdge - PLACEMENT_MARGIN) {
    warningMode.value = 'center';
    warningMaxWidthPx.value = null;
    warningLeftPx.value = center;
    return;
  }

  // 2. Centred within the free gap between the two blocks?
  const gapAvail = (rightEdge - leftEdge) - 2 * PLACEMENT_MARGIN;
  if (w <= gapAvail) {
    warningMode.value = 'gap';
    warningMaxWidthPx.value = null;
    warningLeftPx.value = (leftEdge + rightEdge) / 2;
    return;
  }

  // 3. Fall back to left-aligned, taking the title's place (logo stays).
  warningMode.value = 'left';
  warningLeftPx.value = logoEdge + PLACEMENT_MARGIN;
  warningMaxWidthPx.value = Math.max(0, rightEdge - warningLeftPx.value - PLACEMENT_MARGIN);
}

// Recompute whenever the displayed text changes (digit count shifts width) or
// the header is resized.
watch(() => [silenceWarning.value, isDark.value], () => {
  nextTick(recomputeWarningPlacement);
});

const checkForSilence = () => {
  // The user can opt out of the silence warning entirely in project settings.
  if (!currentProject.value
      || activeCues.value.size === 0
      || (currentProject.value as any).settings?.disableSilenceWarning) {
    silenceWarning.value = null;
    return;
  }

  const cueEndTimes = new Map<string, { time: number; hasValidBehavior: boolean }>();

  for (const [uuid, cue] of activeCues.value) {
    const item = findItemByUuid(uuid);
    if (!item || item.type !== 'audio') continue;
    const audioItem = item as any;
    const timeRemaining = cue.duration - cue.currentTime;
    const hasValidEndBehavior = validateEndBehavior(audioItem);
    cueEndTimes.set(uuid, { time: timeRemaining, hasValidBehavior: hasValidEndBehavior });
  }

  if (cueEndTimes.size === 1) {
    const [, { time, hasValidBehavior }] = Array.from(cueEndTimes.entries())[0];
    silenceWarning.value = (!hasValidBehavior && time <= 60) ? time : null;
    return;
  }

  let minTimeToActualSilence = Infinity;
  const sortedCues = Array.from(cueEndTimes.entries()).sort((a, b) => a[1].time - b[1].time);

  for (let i = 0; i < sortedCues.length; i++) {
    const [, { time, hasValidBehavior }] = sortedCues[i];
    let cuesStillPlaying = 0;
    for (let j = 0; j < sortedCues.length; j++) {
      if (i === j) continue;
      if (sortedCues[j][1].time > time) cuesStillPlaying++;
    }
    if (cuesStillPlaying === 0 && !hasValidBehavior) {
      minTimeToActualSilence = Math.min(minTimeToActualSilence, time);
      break;
    }
  }

  silenceWarning.value = (minTimeToActualSilence <= 60 && minTimeToActualSilence !== Infinity)
    ? minTimeToActualSilence
    : null;
};

const validateEndBehavior = (audioItem: any): boolean => {
  if (!audioItem.endBehavior || audioItem.endBehavior.action === 'nothing') return false;
  const action = audioItem.endBehavior.action;
  if (action === 'next' || action === 'play-next') {
    const currentIndex = audioItem.index;
    if (!currentIndex || !currentProject.value) return false;
    const parentIndex = currentIndex.slice(0, -1);
    const currentPosition = currentIndex[currentIndex.length - 1];
    if (parentIndex.length === 0) {
      return !!currentProject.value.items[currentPosition + 1];
    } else {
      const parent = findItemByIndex(parentIndex);
      return !!(parent && parent.type === 'group' && (parent as any).children[currentPosition + 1]);
    }
  }
  if (action === 'goto-item') {
    return !!(audioItem.endBehavior.targetUuid && findItemByUuid(audioItem.endBehavior.targetUuid));
  }
  if (action === 'goto-index') {
    const ti = audioItem.endBehavior.targetIndex;
    return !!(ti && Array.isArray(ti) && findItemByIndex(ti));
  }
  if (action === 'loop') return true;
  return false;
};

// ---- Wall clock ------------------------------------------------------------

const updateClock = () => {
  const now = new Date();
  currentTime.value = [
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
  ].map(n => String(n).padStart(2, '0')).join(':');
};

// ---- LTC timecode ----------------------------------------------------------

// Frame-rate lookup: index matches the ltcFrameRateIndex values in project.ts
const FPS_TABLE = [24, 25, 29.97, 29.97, 30] as const;

function parseTcToFrames(tc: string, fps: number): number {
  const parts = tc.replace(';', ':').split(':');
  if (parts.length !== 4) return 0;
  const [h, m, s, f] = parts.map(Number);
  return ((h * 3600 + m * 60 + s) * Math.round(fps)) + f;
}

function framesToTc(totalFrames: number, fps: number): string {
  const fpsInt = Math.round(fps);
  const f = totalFrames % fpsInt;
  const totalSecs = Math.floor(totalFrames / fpsInt);
  const s = totalSecs % 60;
  const m = Math.floor(totalSecs / 60) % 60;
  const h = Math.floor(totalSecs / 3600);
  return [h, m, s, f].map(n => String(n).padStart(2, '0')).join(':');
}

// Whether the project has an LTC output device configured at all — the LTC
// clock box is only rendered when this is true, so it doesn't sit in the
// (increasingly crowded) header as permanent dead weight for projects that
// never use timecode.
const hasLtcDevice = computed(() => !!(currentProject.value as any)?.settings?.ltcDevice);

// Returns the current LTC timecode string if any active cue is outputting LTC
// to a configured LTC device, otherwise null (→ box shown grey with dashes).
const ltcTimecode = computed<string | null>(() => {
  const ltcDevice = (currentProject.value as any)?.settings?.ltcDevice;
  if (!ltcDevice) return null;

  for (const [uuid, cue] of activeCues.value) {
    const item = findItemByUuid(uuid);
    if (!item || item.type !== 'audio') continue;
    const ai = item as AudioItem & { ltcEnabled?: boolean; ltcFrameRateIndex?: number; ltcStartTimecode?: string };
    if (!ai.ltcEnabled) continue;

    const fps = FPS_TABLE[ai.ltcFrameRateIndex ?? 4] ?? 30;
    const startTc = ai.ltcStartTimecode ?? '00:00:00:00';
    const startFrames = parseTcToFrames(startTc, fps);
    const elapsedFrames = Math.floor(cue.currentTime * fps);
    return framesToTc(startFrames + elapsedFrames, fps);
  }
  return null;
});

// Video Output window toggle: state comes from main (status poll once, then
// the push channel keeps it in sync however the window was opened/closed).
const videoOutputOpen = ref(false);
let stopVideoStatus: (() => void) | null = null;

const toggleVideoOutput = () => {
  const api = (window as any).electronAPI?.videoOutput;
  if (!api) return;
  if (videoOutputOpen.value) void api.close();
  else void api.open();
};

// Level Check: soundcheck walk through each cue's loudest window on the
// PROGRAM output (the external mixer must see it — preview routes elsewhere).
// The bar lives in MainWorkspace; this only toggles the mode.
const {
  active: levelCheckActive,
  items: levelCheckItems,
  start: startLevelCheck,
  exit: exitLevelCheck,
} = useLevelCheck();
const levelCheckCount = computed(() => levelCheckItems.value.length);
const toggleLevelCheck = () => {
  if (levelCheckActive.value) void exitLevelCheck();
  else startLevelCheck();
};

onMounted(async () => {
  if (!import.meta.client || !(window as any).electronAPI?.videoOutput) return;
  const api = (window as any).electronAPI.videoOutput;
  const s = await api.status();
  videoOutputOpen.value = !!s?.open;
  stopVideoStatus = api.onStatus((status: any) => { videoOutputOpen.value = !!status?.open; });
  onUnmounted(() => { stopVideoStatus?.(); });
});

onMounted(() => {
  updateClock();
  const clockInterval = setInterval(updateClock, 1000);
  const silenceInterval = setInterval(checkForSilence, 100);

  // Re-place the silence banner whenever the header geometry changes
  // (window resize, sidebar toggles, clock width shifts, …).
  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => recomputeWarningPlacement());
    if (headerRef.value) resizeObserver.observe(headerRef.value);
    if (leftRef.value) resizeObserver.observe(leftRef.value);
    if (rightRef.value) resizeObserver.observe(rightRef.value);
  }

  onUnmounted(() => {
    clearInterval(clockInterval);
    clearInterval(silenceInterval);
    if (resizeObserver) resizeObserver.disconnect();
  });
});
</script>

<style scoped lang="scss">
.project-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: 0 0 var(--app-header-height);
  height: var(--app-header-height);
  padding: var(--spacing-xs) var(--workspace-gutter);
  background-color: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--color-border) 35%, transparent);
}

.header-left {
  display: flex;
  align-items: center;
  flex: 0 1 auto;
  min-width: 0;
  gap: var(--spacing-sm);
}

.header-logo {
  width: 30px;
  height: 30px;
  object-fit: contain;
}

/* Brand lockup: product wordmark sits over the project name so the header
   carries DonWells identity at all times, not just the icon. */
.header-titles {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
}

.brand-wordmark {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  line-height: 1.1;
  white-space: nowrap;
  color: var(--color-text-secondary);
}

.brand-wordmark--hidden {
  display: none;
}

.project-name {
  font-size: var(--type-project-size);
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--color-text-primary);
  margin: 0;
  max-width: clamp(140px, 24vw, 420px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-right {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: var(--spacing-sm);
}

/* Settings and shortcuts are useful, but the live clocks and transport own
   this band. Keep these secondary controls quiet until the operator hovers. */
.header-right :deep(.btn) {
  min-height: 32px;
  padding: 5px 8px;
  color: var(--color-text-secondary);
  background-color: transparent;
  border-color: transparent;
  border-radius: var(--control-radius);
  box-shadow: none;
}

.header-right :deep(.video-toggle--active),
.header-right :deep(.level-check-toggle--active) {
  color: var(--color-accent);
}

.header-right :deep(.btn:hover:not(:disabled)),
.autosave-toggle:hover:not(:disabled) {
  color: var(--color-text-primary);
  background-color: var(--color-surface-hover);
  border-color: var(--color-border);
}

/* "Unsaved Changes" pill — styled like the playback status pills (yellow
   warning, black text), shown next to the project title when autosave is off
   and edits are pending. */
.unsaved-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: var(--pill-radius);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
  background-color: var(--state-up-next);
  color: black;
}

/* Autosave toggle switch */
.autosave-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--control-radius);
  padding: 4px var(--spacing-sm);
  color: var(--color-text-secondary);
  font-family: inherit;
}

.autosave-toggle__label {
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.autosave-toggle__track {
  position: relative;
  width: 30px;
  height: 16px;
  border-radius: 8px;
  background-color: var(--color-control);
  box-shadow: inset 0 0 0 1px var(--color-border-strong);
  transition: background-color var(--transition-base);
  flex-shrink: 0;
}

.autosave-toggle__track--on {
  background-color: var(--color-accent);
}

.autosave-toggle__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background-color: var(--color-text-primary);
  transition: transform var(--transition-base);
}

.autosave-toggle__track--on .autosave-toggle__thumb {
  transform: translateX(14px);
}

/* Two clocks side-by-side, never re-arrange */
.clock-pair {
  display: flex;
  gap: var(--spacing-xs);
  align-items: stretch;
  padding-left: var(--spacing-sm);
  border-left: 1px solid var(--color-border);
}

.digital-clock {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4px var(--spacing-sm);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background-color: var(--color-control);
  transition: color var(--transition-base), border-color var(--transition-base);
  min-width: 108px;
  height: 44px;
  box-shadow:
    inset 0 1px 3px rgba(0, 0, 0, 0.18),
    0 1px 0 color-mix(in srgb, var(--color-text-primary) 5%, transparent);
}

.digital-clock.clock--large {
  width: var(--output-strip-width);
  min-width: var(--output-strip-width);
  box-sizing: border-box;
  padding: 5px 10px;
}

.clock--active {
  color: var(--color-text-primary);
}

.clock--active .clock-value {
  color: var(--color-accent);
}

.clock--inactive {
  color: var(--color-text-secondary);
  opacity: 0.5;
}

.clock-label {
  font-family: var(--font-mono);
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  line-height: 1;
  margin-bottom: 2px;
}

.clock-value {
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  line-height: 1;
}

.clock--large .clock-label {
  font-size: 10px;
}

.clock--large .clock-value {
  font-size: var(--type-clock-size);
}

.silence-warning {
  position: absolute;
  /* left + transform are set inline (adaptive placement, see script).
     Vertical centring comes from the flex container's static position. */
  padding: var(--spacing-xs) var(--spacing-lg);
  border-radius: var(--control-radius);
  font-weight: 700;
  font-size: 16px;
  color: #000;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  z-index: 10;
}

/* Left-aligned fallback sits in the title's place — tighten the horizontal
   padding so it reads like a header label rather than a centred banner. */
.silence-warning--left {
  padding-left: var(--spacing-md);
  padding-right: var(--spacing-md);
}

/* In the left-aligned fallback the project title is hidden but keeps its
   layout box, so placement geometry stays stable (no flip-flopping). */
.project-name--hidden {
  visibility: hidden;
}

.silence-warning.warning-yellow  { background-color: #fbbf24; }
.silence-warning.flash-slow      { background-color: #fbbf24; animation: flash-slow   2s   ease-in-out infinite; }
.silence-warning.flash-medium    { background-color: #f56d1f; animation: flash-medium 1s   ease-in-out infinite; }
.silence-warning.flash-fast      { background-color: #dc2626; color: #fff; animation: flash-fast 0.5s ease-in-out infinite; }

@keyframes flash-slow   { 0%, 100% { opacity: 0; } 50% { opacity: 1; } }
@keyframes flash-medium { 0%, 100% { opacity: 0; } 50% { opacity: 1; } }
@keyframes flash-fast   { 0%, 100% { opacity: 0; } 50% { opacity: 1; } }

@media (prefers-reduced-motion: reduce) {
  .silence-warning {
    animation: none !important;
    opacity: 1;
  }
}
</style>
