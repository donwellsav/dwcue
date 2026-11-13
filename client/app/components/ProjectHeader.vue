<template>
  <div class="project-header">
    <div class="header-left">
      <img
        :src="isDark ? './assets/icons/SVG/app_icon_darkmode@web.svg' : './assets/icons/SVG/app_icon_lightmode@web.svg'"
        alt="DonWells Cue"
        class="header-logo"
      />
      <div class="header-name-line">
        <h2
          class="project-name"
          :title="currentProject?.name || t('project.noProject')"
        >{{ currentProject?.name || t('project.noProject') }}</h2>
        <div class="header-warning-line">
          <div
            v-if="silenceSeconds !== null"
            class="silence-warning"
            :title="`${t('project.silenceWarning')} ${silenceSeconds} ${t('project.seconds')}`"
          >
            <span class="silence-warning__label">{{ t('project.silenceWarning') }}</span>
            <bdi class="silence-warning__seconds">{{ silenceSeconds }}</bdi>
            <span class="silence-warning__label">{{ t('project.seconds') }}</span>
          </div>
          <div id="project-header-warnings" class="header-warning-slot"></div>
        </div>
      </div>
      <span
        v-if="currentProject && !autoSaveEnabled && hasUnsavedChanges"
        class="unsaved-pill"
      >{{ t('project.unsavedChanges') }}</span>
    </div>

    <div class="header-right">
      <!-- Appears the moment the socket drops; spins for as long as we retry. -->
      <ConnectionStatusPill />

      <Btn :text="t('settings.title')" @click="showProjectSettings = true" />
      <Btn
        :text="t('settings.tabVideoOutput')"
        symbol="video-output"
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
        <div class="digital-clock clock--large clock--time-left" :class="primaryActiveCue ? 'clock--active' : 'clock--inactive'">
          <span class="clock-label">{{ t('project.timeLeft') }}</span>
          <span class="clock-value" :style="{ color: timeLeftColor ?? undefined }">{{ timeLeft }}</span>
        </div>
        <div class="digital-clock clock--large clock--wall">
          <span class="clock-label">{{ t('project.clock') }}</span>
          <span class="clock-value">{{ currentTime }}</span>
        </div>
        <div v-if="hasLtcDevice" class="digital-clock clock--ltc" :class="ltcTimecode ? 'clock--active' : 'clock--inactive'">
          <span class="clock-label"><CueSymbol name="ltc" /> LTC</span>
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
import { useVideoOutputToggle } from '~/composables/useCartHotkeys';
import { countdownColorForSeconds, type AudioItem } from '~/types/project';

const { currentProject, findItemByUuid, findItemByIndex, autoSaveEnabled, hasUnsavedChanges, setAutoSave } = useProject();
const { t } = useLocalization();
const { activeCues } = useAudioEngine();
const { uiMode, toggleUiMode } = useUiMode();
const { silenceRemaining } = useHeaderWarnings();

const showControlConfig = useState('showControlConfig', () => false);
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
const silenceSeconds = computed(() => silenceWarning.value === null
  ? null
  : Math.max(0, Math.ceil(silenceWarning.value)));
watch(silenceSeconds, (seconds) => { silenceRemaining.value = seconds; }, { flush: 'sync' });
onUnmounted(() => { silenceRemaining.value = null; });

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

const toggleVideoOutput = useVideoOutputToggle();

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

  onUnmounted(() => {
    clearInterval(clockInterval);
    clearInterval(silenceInterval);
  });
});
</script>

<style scoped lang="scss">
.project-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm);
  flex: 0 0 var(--app-header-height);
  height: var(--app-header-height);
  padding: var(--spacing-xs) var(--workspace-gutter);
  background-color: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
}

.header-left {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  gap: var(--spacing-sm);
}

.header-logo {
  width: 30px;
  height: 30px;
  object-fit: contain;
  flex-shrink: 0;
}

.header-name-line,
.header-warning-line {
  display: flex;
  align-items: center;
  flex: 1;
  gap: var(--spacing-xs);
  min-width: 0;
}

.header-warning-slot {
  min-width: 0;
}

.header-warning-slot:empty {
  display: none;
}

.project-name {
  font-size: var(--type-project-size);
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--color-text-primary);
  margin: 0;
  flex: none;
  max-width: min(40%, 420px, max(4rem, calc(100% - 264px)));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-right {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 6px;
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

/* Operational clocks stay side-by-side in one stable, tabular strip. */
.clock-pair {
  display: flex;
  gap: 0;
  align-items: stretch;
  min-width: 0;
  padding-left: var(--spacing-sm);
  border-left: 1px solid var(--color-border);
}

.digital-clock {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 3px 10px;
  border: 0;
  border-left: 1px solid var(--color-border);
  border-radius: 0;
  background-color: transparent;
  transition: color var(--transition-base);
  min-width: 104px;
  height: 40px;
}

.digital-clock.clock--large {
  width: clamp(148px, 13vw, var(--output-strip-width));
  min-width: clamp(148px, 13vw, var(--output-strip-width));
  box-sizing: border-box;
}

.clock--ltc {
  width: clamp(104px, 9vw, 120px);
}

.clock--wall {
  color: var(--color-text-primary);
}

.clock--active {
  color: var(--color-text-primary);
}

.clock--active .clock-value {
  color: color-mix(in srgb, var(--color-accent) 72%, var(--color-text-primary));
}

.clock--time-left.clock--active .clock-value {
  color: var(--state-playing);
}

.clock--inactive {
  color: var(--color-text-secondary);
  opacity: 0.52;
}

.clock-label {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: var(--font-mono);
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  line-height: 1;
  margin-bottom: 3px;
}

.clock-value {
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  line-height: 1;
  white-space: nowrap;
}

.clock--large .clock-label {
  font-size: 9px;
}

.clock--large .clock-value {
  font-size: var(--type-clock-size);
}

.silence-warning {
  flex: none;
  display: flex;
  align-items: center;
  box-sizing: border-box;
  max-width: calc(100% - 60px);
  white-space: nowrap;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) var(--spacing-lg);
  border: 2px solid var(--state-up-next);
  border-radius: var(--control-radius);
  background-color: var(--color-surface-raised);
  font-weight: 700;
  font-size: 14px;
  color: var(--state-up-next);
}

.silence-warning__label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.silence-warning__seconds {
  flex: none;
  inline-size: 2ch;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 1320px) {
  .project-header {
    padding-inline: 6px;
  }

  .header-right {
    gap: var(--spacing-xs);
  }

  .header-right :deep(.btn),
  .autosave-toggle {
    padding-inline: 6px;
  }

  .digital-clock.clock--large {
    width: 150px;
    min-width: 150px;
  }

  .clock--large .clock-value {
    font-size: 22px;
  }
}

@media (max-width: 1220px) {
  .header-logo {
    width: 26px;
    height: 26px;
  }

  .header-left,
  .header-right {
    gap: 3px;
  }

  .autosave-toggle {
    gap: 4px;
  }

  .digital-clock.clock--large {
    width: 140px;
    min-width: 140px;
  }

  .digital-clock {
    min-width: 100px;
    padding-inline: 7px;
  }

  .clock--large .clock-value {
    font-size: 20px;
  }
}
</style>
