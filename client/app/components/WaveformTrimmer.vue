<template>
  <div class="waveform-trimmer">
    <!-- Volume Control with dB Display -->
    <div class="volume-control-section">
      <div class="volume-label">
        <span>{{ t('properties.volume') }}</span>
        <span class="db-value">{{ volumeDB.toFixed(1) }} dB</span>
      </div>
      <div class="volume-slider-container">
        <input
          type="range"
          orient="vertical"
          class="volume-slider-vertical"
          :min="-60"
          :max="10"
          step="0.1"
          :value="volumeDB"
          :aria-label="t('properties.volume')"
          @input="handleVolumeInput"
          @change="handleVolumeDragEnd"
          :style="{ '--volume-handle-color': trackColor }"
        />
        <div class="volume-markers">
          <span>+10</span>
          <span>0</span>
          <span>-12</span>
          <span>-24</span>
          <span>-∞</span>
        </div>
      </div>
    </div>

    

    <!-- Waveform Display -->
    <div class="waveform-section">
      <!-- Waveform Tools -->
      <div class="waveform-controls">
        <Teleport v-if="!multiSelect" defer to="#properties-transport-host">
          <div class="audition-transport" role="group" :aria-label="t('properties.playback')">
            <button type="button" class="audition-btn" @click="jumpAudition(-1)" :title="t('actions.jumpPreviewBack')">
              <span class="material-symbols-rounded" aria-hidden="true">fast_rewind</span>
            </button>
            <button type="button" class="audition-btn audition-btn--primary" @click="toggleAudition" :title="auditionToggleLabel">
              <span class="material-symbols-rounded" aria-hidden="true">{{ auditionToggleIcon }}</span>
            </button>
            <button type="button" class="audition-btn audition-btn--stop" @click="stopAudition" :title="t('actions.stop')">
              <span class="material-symbols-rounded" aria-hidden="true">stop</span>
            </button>
            <button type="button" class="audition-btn" @click="jumpAudition(1)" :title="t('actions.jumpPreviewForward')">
              <span class="material-symbols-rounded" aria-hidden="true">fast_forward</span>
            </button>
            <label class="audition-jump">
              <input v-model.number="auditionJumpSeconds" type="number" min="0.1" max="99.9" step="0.1" :aria-label="t('actions.previewJump')" />
              <span>s</span>
            </label>
            <output class="audition-time">{{ formatTimeDetailed(playbackPosition) }}</output>
            <button
              v-if="previewMode"
              type="button"
              class="audition-set-next"
              :class="{ active: auditionIsNext }"
              @click="setAuditionAsNext"
            >
              {{ t('actions.setAsNext') }}
            </button>
          </div>
        </Teleport>
        <!-- Audio Tools -->
        <div class="audio-tools">
          <!-- Trim Silence Button -->
          <button class="trim-silence-btn" @click="trimSilence" :title="t('properties.trimSilence')">
            <span class="material-symbols-rounded">content_cut</span>
            <span>{{ t('properties.trimSilence') }}</span>
          </button>
          
          <details
            ref="normalizeMenu"
            class="normalize-menu"
            @focusout="handleNormalizeFocusOut"
            @keydown.esc.prevent.stop="closeNormalizeMenu"
          >
            <summary class="normalize-btn" :title="t('properties.normalizeHelp')">
              <span class="material-symbols-rounded">tune</span>
              <span>{{ t('properties.normalize') }}</span>
              <span class="material-symbols-rounded normalize-chevron">expand_more</span>
            </summary>
            <div class="normalize-popover">
              <label class="normalize-field">
                <span>{{ t('properties.normalizeMode') }}</span>
                <select v-model="normalizationMode" class="normalize-mode">
                  <option value="loudness">{{ t('properties.loudnessTargets') }}</option>
                  <option value="truePeak">{{ t('properties.truePeakTargets') }}</option>
                </select>
              </label>
              <label class="normalize-field">
                <span>{{ t('properties.normalizeTarget') }}</span>
                <span class="normalize-level">
                  <input
                    v-model.number.lazy="normalizationTarget"
                    class="normalize-target"
                    type="number"
                    min="-60"
                    :max="normalizationTargetMax"
                    step="0.1"
                    :title="t('properties.normalizeHelp')"
                  />
                  <span class="normalize-unit">{{ normalizationUnit }}</span>
                </span>
              </label>
              <button class="normalize-apply" type="button" @click="normalizeAudio">
                {{ t('properties.normalize') }}
              </button>
            </div>
          </details>
        </div>
      </div>

      <!-- Waveform Canvas Container. Kept mounted in ALL modes so the
           ResizeObserver target is stable; only its contents swap between the
           single-item canvas and the multi-selection message. -->
      <div
        class="waveform-container"
        ref="waveformContainer"
        @wheel.prevent="handleWheel"
      >
        <!-- Multi-selection: the single-item canvas can't represent many items. -->
        <div v-if="multiSelect" class="waveform-multi-message">
          <span class="material-symbols-rounded">layers</span>
          <p>{{ t('properties.multiSelectWaveform') }}</p>
        </div>

        <template v-else>
        <canvas
          ref="waveformCanvas"
          class="waveform-canvas"
          role="slider"
          tabindex="0"
          :aria-label="t('properties.waveform')"
          :aria-valuemin="inPoint"
          :aria-valuemax="outPoint"
          :aria-valuenow="playbackPosition"
          :aria-valuetext="formatTimeDetailed(playbackPosition)"
          @pointerdown="handleCanvasPointerDown"
          @keydown="handlePlayheadKeyDown"
        ></canvas>

        <!-- Trim Handles -->
        <div
          class="trim-handle trim-handle-in"
          :style="{ left: inPointPosition + 'px' }"
          @mousedown.prevent="startDragHandle('in', $event)"
        >
          <div class="trim-line"></div>
          <div class="trim-grip">
            <span class="material-symbols-rounded">arrow_forward</span>
          </div>
        </div>
        
        <div 
          class="trim-handle trim-handle-out"
          :style="{ left: outPointPosition + 'px' }"
          @mousedown.prevent="startDragHandle('out', $event)"
        >
          <div class="trim-line"></div>
          <div class="trim-grip">
            <span class="material-symbols-rounded">arrow_back</span>
          </div>
        </div>

        <!-- Trim Region Overlay -->
        <div 
          class="trim-overlay trim-overlay-left"
          :style="{ width: inPointPosition + 'px' }"
        ></div>
        <div 
          class="trim-overlay trim-overlay-right"
          :style="{ left: outPointPosition + 'px' }"
        ></div>
        
        <!-- Fade Handles (hidden for cart items) -->
        <template v-if="!isCartItem">
          <!-- Play Fade Handle (fade in end) -->
          <div 
            v-if="playFade > 0"
            class="fade-handle fade-handle-play"
            :style="{ left: playFadePosition + 'px' }"
            @mousedown.prevent="startDragFade('play', $event)"
            :title="t('waveform.playFadeTitle', { seconds: playFade.toFixed(1) })"
          >
            <div class="fade-line fade-line-red"></div>
            <div class="fade-grip fade-grip-red">
              <span class="material-symbols-rounded">trending_up</span>
            </div>
          </div>
          
          <!-- Stop Fade Handle (fade out start) -->
          <div 
            v-if="stopFade > 0"
            class="fade-handle fade-handle-stop"
            :style="{ left: stopFadePosition + 'px' }"
            @mousedown.prevent="startDragFade('stop', $event)"
            :title="t('waveform.stopFadeTitle', { seconds: stopFade.toFixed(1) })"
          >
            <div class="fade-line fade-line-red"></div>
            <div class="fade-grip fade-grip-red">
              <span class="material-symbols-rounded">trending_down</span>
            </div>
          </div>
          
          <!-- Cross Fade Handle (crossfade start) -->
          <div
            v-if="crossFade > 0"
            class="fade-handle fade-handle-cross"
            :style="{ left: crossFadePosition + 'px' }"
            @mousedown.prevent="startDragFade('cross', $event)"
            :title="t('waveform.crossFadeTitle', { seconds: crossFade.toFixed(1) })"
          >
            <div class="fade-line fade-line-yellow"></div>
            <div class="fade-grip fade-grip-yellow">
              <span class="material-symbols-rounded">swap_horiz</span>
            </div>
          </div>

          <!-- Start Next Marker (radio-style segue point) -->
          <div
            v-if="startNextEnabled"
            class="fade-handle fade-handle-startnext"
            :style="{ left: startNextPosition + 'px' }"
            @mousedown.prevent="startDragFade('startNext', $event)"
            :title="t('waveform.startNextTitle', { time: formatTimeDetailed(startNextTime) })"
          >
            <div class="fade-line fade-line-startnext"></div>
            <div class="fade-grip fade-grip-startnext">
              <span class="material-symbols-rounded">skip_next</span>
            </div>
          </div>
        </template>
        </template>
      </div>

      <!-- Horizontal Scrollbar -->
      <div class="waveform-scrollbar" v-if="!multiSelect">
        <input
          type="range"
          class="scroll-slider"
          min="0"
          :max="maxScroll"
          step="0.1"
          :value="scrollPosition"
          :style="{ '--range-progress': `${scrollProgress}%` }"
          :disabled="maxScroll === 0"
          :aria-label="`${t('properties.waveform')} view position`"
          @input="handleScrollInput"
        />
        <div class="zoom-control">
          <span class="material-symbols-rounded">zoom_out</span>
          <input
            type="range"
            class="zoom-slider"
            min="1"
            max="20"
            step="0.5"
            v-model.number="zoomLevel"
            :style="{ '--range-progress': `${zoomProgress}%` }"
            :aria-label="`${t('properties.waveform')} zoom`"
            :aria-valuetext="`${Math.round(zoomLevel * 100)}%`"
          />
          <span class="material-symbols-rounded">zoom_in</span>
          <span class="zoom-level-text">{{ Math.round(zoomLevel * 100) }}%</span>
        </div>
      </div>
    </div>

    <!-- Time Display (moved to right side) -->
    <div class="time-display-section">
      <div class="time-field">
        <div class="time-field-label-row">
          <label>{{ t('properties.inPoint') }}</label>
          <button v-if="!multiSelect" type="button" class="audition-marker-btn time-field-set-btn" @click="setInPointAtPlayhead">
            {{ t('actions.setIn') }}
          </button>
        </div>
        <div class="time-input-with-buttons">
          <button class="time-decrement" @click="adjustInPoint(-0.5)" :title="t('waveform.decreaseBy', { seconds: '0.5' })">
            <span class="material-symbols-rounded">remove</span>
          </button>
          <input 
            type="text"
            class="time-input"
            :value="formatTimeDetailed(inPoint)"
            @change="handleInPointTextChange"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <button class="time-increment" @click="adjustInPoint(0.5)" :title="t('waveform.increaseBy', { seconds: '0.5' })">
            <span class="material-symbols-rounded">add</span>
          </button>
        </div>
      </div>
      <div
        class="time-field"
        :class="{ 'time-field-disabled': multiSelect }"
        :title="multiSelect ? t('properties.multiSelectOutPointDisabled') : undefined"
      >
        <div class="time-field-label-row">
          <label>{{ t('properties.outPoint') }}</label>
          <button v-if="!multiSelect" type="button" class="audition-marker-btn time-field-set-btn" @click="setOutPointAtPlayhead">
            {{ t('actions.setOut') }}
          </button>
        </div>
        <div class="time-input-with-buttons">
          <button class="time-decrement" @click="adjustOutPoint(-0.5)" :disabled="multiSelect" :title="multiSelect ? t('properties.multiSelectOutPointDisabled') : t('waveform.decreaseBy', { seconds: '0.5' })">
            <span class="material-symbols-rounded">remove</span>
          </button>
          <input
            type="text"
            class="time-input"
            :value="multiSelect ? '—' : formatTimeDetailed(outPoint)"
            :disabled="multiSelect"
            :title="multiSelect ? t('properties.multiSelectOutPointDisabled') : undefined"
            @change="handleOutPointTextChange"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <button class="time-increment" @click="adjustOutPoint(0.5)" :disabled="multiSelect" :title="multiSelect ? t('properties.multiSelectOutPointDisabled') : t('waveform.increaseBy', { seconds: '0.5' })">
            <span class="material-symbols-rounded">add</span>
          </button>
        </div>
      </div>
      <div class="time-field">
        <label>{{ t('properties.duration') }}</label>
        <input 
          type="text"
          class="time-input"
          :value="formatTimeDetailed(duration)"
          readonly
        />
      </div>
    </div>

    <!-- Fade & Transition Controls (hidden for cart items) -->
    <div v-if="!isCartItem" class="fade-controls-section">
      <div class="fade-column">
        <div class="fade-control-group">
          <label>{{ t('properties.playFade') }}</label>
          <div class="time-input-with-buttons">
            <button class="time-decrement" @click="adjustPlayFade(-0.5)" :title="t('waveform.decreaseBy', { seconds: '0.5' })">
              <span class="material-symbols-rounded">remove</span>
            </button>
            <input
              type="text"
              class="time-input fade-input"
              :value="formatTimeDetailed(playFade)"
              @change="handlePlayFadeTextChange"
              @focus="($event.target as HTMLInputElement).select()"
            />
            <button class="time-increment" @click="adjustPlayFade(0.5)" :title="t('waveform.increaseBy', { seconds: '0.5' })">
              <span class="material-symbols-rounded">add</span>
            </button>
          </div>
        </div>
        <div class="fade-control-group">
          <label>{{ t('properties.crossFade') }}</label>
          <div class="time-input-with-buttons">
            <button class="time-decrement" @click="adjustCrossFade(-0.5)" :title="t('waveform.decreaseBy', { seconds: '0.5' })">
              <span class="material-symbols-rounded">remove</span>
            </button>
            <input
              type="text"
              class="time-input fade-input"
              :value="formatTimeDetailed(crossFade)"
              @change="handleCrossFadeTextChange"
              @focus="($event.target as HTMLInputElement).select()"
            />
            <button class="time-increment" @click="adjustCrossFade(0.5)" :title="t('waveform.increaseBy', { seconds: '0.5' })">
              <span class="material-symbols-rounded">add</span>
            </button>
          </div>
        </div>
      </div>
      <div class="fade-column">
        <div class="fade-control-group">
          <label>{{ t('properties.stopFade') }}</label>
          <div class="time-input-with-buttons">
            <button class="time-decrement" @click="adjustStopFade(-0.5)" :title="t('waveform.decreaseBy', { seconds: '0.5' })">
              <span class="material-symbols-rounded">remove</span>
            </button>
            <input
              type="text"
              class="time-input fade-input"
              :value="formatTimeDetailed(stopFade)"
              @change="handleStopFadeTextChange"
              @focus="($event.target as HTMLInputElement).select()"
            />
            <button class="time-increment" @click="adjustStopFade(0.5)" :title="t('waveform.increaseBy', { seconds: '0.5' })">
              <span class="material-symbols-rounded">add</span>
            </button>
          </div>
        </div>
        <label class="start-next-toggle">
          <input
            type="checkbox"
            :checked="startNextEnabled"
            @change="handleStartNextEnabledChange"
          />
          <span>{{ t('properties.startNextEnable') }}</span>
        </label>
        <div class="fade-control-group" :class="{ 'start-next-disabled': !startNextEnabled }">
          <label>{{ t('properties.startNextTime') }}</label>
          <div class="time-input-with-buttons">
            <button class="time-decrement" :disabled="!startNextEnabled" @click="adjustStartNextTime(-0.5)" :title="t('waveform.decreaseBy', { seconds: '0.5' })">
              <span class="material-symbols-rounded">remove</span>
            </button>
            <input
              type="text"
              class="time-input fade-input"
              :value="formatTimeDetailed(startNextTime)"
              :disabled="!startNextEnabled"
              @change="handleStartNextTimeTextChange"
              @focus="($event.target as HTMLInputElement).select()"
            />
            <button class="time-increment" :disabled="!startNextEnabled" @click="adjustStartNextTime(0.5)" :title="t('waveform.increaseBy', { seconds: '0.5' })">
              <span class="material-symbols-rounded">add</span>
            </button>
          </div>
        </div>
        <label class="start-next-toggle" :class="{ 'start-next-disabled': !startNextEnabled }">
          <input
            type="checkbox"
            :checked="startNextFadeOut"
            :disabled="!startNextEnabled"
            @change="handleStartNextFadeOutChange"
          />
          <span>{{ t('properties.startNextFadeOut') }}</span>
        </label>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
import type { AudioItem, WaveformData } from '~/types/project';
import { useOutputTarget } from '~/composables/useOutputTarget';
import { useLiveplayServer } from '~/composables/useLiveplayServer';
import { buildWaveformFromChannels } from '~/utils/audio';

const props = defineProps<{
  audioItem: AudioItem;
  // True when more than one item is selected. The single-item waveform canvas
  // and the out-point control are meaningless across a heterogeneous selection
  // (each item has its own duration), so they're replaced/disabled. Crucially
  // this ALSO suppresses the self-healing waveform re-request below: with many
  // items selected that re-request fires per displayed anchor and races the
  // batch edit, which is what made auto-trim / auto-volume revert.
  multiSelect?: boolean;
  previewMode?: boolean;
}>();

const emit = defineEmits<{
  'update:volume': [value: number];
  'update:inPoint': [value: number];
  'update:outPoint': [value: number];
  'update:playFade': [value: number];
  'update:stopFade': [value: number];
  'update:pauseFade': [value: number];
  'update:crossFade': [value: number];
  'update:startNextEnabled': [value: boolean];
  'update:startNextTime': [value: number];
  'update:startNextFadeOut': [value: boolean];
  'change': [];
  'normalize': [mode: 'loudness' | 'truePeak', target: number];
  'trimSilence': [];
}>();

const { t } = useLocalization();
const { levels: outputTargetLevels } = useOutputTarget();

type NormalizationMode = 'loudness' | 'truePeak';

const normalizationMode = ref<NormalizationMode>('truePeak');
const normalizeMenu = ref<HTMLDetailsElement | null>(null);
const customLoudnessTarget = ref<number | null>(null);
const customTruePeakTarget = ref<number | null>(-0.1);
const projectLoudnessTarget = computed(() =>
  Number.isFinite(outputTargetLevels.value.loudnessTargetLufs)
    ? outputTargetLevels.value.loudnessTargetLufs
    : -23,
);
const projectTruePeakTarget = computed(() =>
  Number.isFinite(outputTargetLevels.value.limiterCeilingDb)
    ? Math.max(-60, Math.min(0, outputTargetLevels.value.limiterCeilingDb))
    : -1,
);
const normalizationTargetMax = computed(() =>
  normalizationMode.value === 'truePeak' ? projectTruePeakTarget.value : 0,
);
const normalizationUnit = computed(() =>
  normalizationMode.value === 'truePeak' ? 'dBTP' : 'LUFS',
);
const normalizationTarget = computed<number>({
  get: () => normalizationMode.value === 'truePeak'
    ? customTruePeakTarget.value ?? projectTruePeakTarget.value
    : customLoudnessTarget.value ?? projectLoudnessTarget.value,
  set: (value) => {
    if (!Number.isFinite(value)) return;
    const target = Math.round(
      Math.max(-60, Math.min(normalizationTargetMax.value, value)) * 10,
    ) / 10;
    if (normalizationMode.value === 'truePeak') customTruePeakTarget.value = target;
    else customLoudnessTarget.value = target;
  },
});

const closeNormalizeMenu = () => normalizeMenu.value?.removeAttribute('open');
const handleNormalizeFocusOut = (event: FocusEvent) => {
  const next = event.relatedTarget as Node | null;
  if (!next || !normalizeMenu.value?.contains(next)) closeNormalizeMenu();
};

const { activeCues, nextItemOverrideUuid, setNextItem } = useAudioEngine();
const {
  currentProject,
  previewItemUuid,
  previewCueId,
  startPreview,
} = useProject();
const server = useLiveplayServer();
const previewCueIsCurrent = computed(() => previewItemUuid.value === props.audioItem.uuid && !!previewCueId.value);
const previewMeter = useCueMeters(() => previewCueIsCurrent.value ? previewCueId.value || null : null);

// Check if this is a cart item
const isCartItem = computed(() => {
  return props.audioItem.index && props.audioItem.index.length > 0 && props.audioItem.index[0] === -1;
});

// Fade values
const playFade = computed(() => props.audioItem.playFade || 0);
const stopFade = computed(() => props.audioItem.stopFade || 0);
const crossFade = computed(() => props.audioItem.crossFade || 0);

// Start Next marker (absolute seconds within the file)
const startNextEnabled = computed(() => !!props.audioItem.startNextEnabled);
const startNextTime = computed(() => props.audioItem.startNextTime || 0);
const startNextFadeOut = computed(() => !!props.audioItem.startNextFadeOut);

// Refs
const waveformCanvas = ref<HTMLCanvasElement | null>(null);
const waveformContainer = ref<HTMLDivElement | null>(null);
const isDrawing = ref(false);

// Zoom and scroll
const zoomLevel = ref(1);
const scrollPosition = ref(0);

const auditionPosition = ref(0);
const auditionJumpSeconds = useState<number>('PlaybackControls.previewJumpSeconds', () => 5);
const regularCue = computed(() => activeCues.value.get(props.audioItem.uuid));
const previewIsCurrent = computed(() => !!props.previewMode && previewCueIsCurrent.value);
const previewCueIsRunning = computed(() => previewCueIsCurrent.value && previewMeter.transport.value !== 0);
const previewIsRunning = computed(() => !!props.previewMode && previewCueIsRunning.value);
const auditionIsPaused = computed(() => props.previewMode
  ? previewIsRunning.value && previewMeter.transport.value === 4
  : !!regularCue.value?.isPaused);
const auditionIsRunning = computed(() => props.previewMode ? previewIsRunning.value : !!regularCue.value);
const auditionToggleIcon = computed(() => auditionIsRunning.value && !auditionIsPaused.value ? 'pause' : 'play_arrow');
const auditionToggleLabel = computed(() => auditionIsRunning.value && !auditionIsPaused.value
  ? t('actions.pause')
  : auditionIsPaused.value ? t('actions.resume') : t('actions.play'));
const auditionIsNext = computed(() => nextItemOverrideUuid.value === props.audioItem.uuid);

const liveMainPlayheadPosition = computed<number | null>(() => {
  const cue = regularCue.value;
  if (!cue) return null;
  if (typeof cue.playheadSeconds === 'number') return cue.playheadSeconds;
  return cue.currentTime + (props.audioItem.inPoint || 0);
});
const mainPlayheadPosition = computed<number | null>(() => liveMainPlayheadPosition.value
  ?? (!props.previewMode ? auditionPosition.value : null));
const previewPlayheadPosition = computed<number | null>(() => previewCueIsRunning.value
  ? previewMeter.playhead.value
  : props.previewMode ? auditionPosition.value : null);

// The transport follows the mode-specific playhead. Main and Preview remain
// separate marker streams so both can be shown when the same file is active.
const playbackPosition = computed(() => {
  if (props.previewMode) return previewPlayheadPosition.value ?? auditionPosition.value;
  return mainPlayheadPosition.value ?? auditionPosition.value;
});

// Use the combined peak trace for drawing and silence trim only. Loudness and
// true peak come from the server's decoded-sample analysis.
const detailedWaveform = shallowRef<WaveformData | null>(null);
const displayedWaveform = computed(() => detailedWaveform.value ?? props.audioItem?.waveform ?? null);
const waveformData = computed(() => displayedWaveform.value?.peaks ?? null);
const hasWaveform = computed(() => waveformData.value && waveformData.value.length > 0);

interface WaveformLane {
  peaks: number[];
  rms?: number[];
}

// Lanes to draw: one per source channel when the server gave us per-channel
// data (stereo renders L above R), otherwise a single combined lane. The
// server's RMS trace supplies the readable body while peaks retain transient
// and level-zone information. Legacy peak-only waveforms still render.
const waveformLanes = computed<WaveformLane[]>(() => {
  const wf = displayedWaveform.value;
  if (!wf) return [];
  const perChannel = wf.channelPeaks;
  if (Array.isArray(perChannel) && perChannel.length > 1 &&
      perChannel.every(lane => Array.isArray(lane) && lane.length > 0)) {
    return perChannel.map((peaks, index) => ({
      peaks,
      rms: Array.isArray(wf.channelRms?.[index]) ? wf.channelRms[index] : undefined,
    }));
  }
  return wf.peaks && wf.peaks.length > 0 ? [{ peaks: wf.peaks, rms: wf.rms }] : [];
});

// ---- Self-healing waveform regeneration -------------------------------------
// Occasionally an item ends up with no waveform (e.g. a server re-sync that
// stripped peaks before the client cache had seen them). Rather than make the
// user press "Regenerate waveform", request it from the server automatically
// whenever the panel shows an item with no peaks. The result arrives as a
// waveform_ready doc_patch which sets audioItem.waveform and redraws.
// Resolve the server-side absolute media path, falling back to project folder +
// relative mediaPath for legacy items (mirrors the manual regenerate button).
const resolveMediaPath = (): string => {
  const it = props.audioItem;
  if (!it) return '';
  if (it.mediaServerPath) return it.mediaServerPath;
  const folder = currentProject.value?.folderPath || '';
  if (it.mediaPath && folder) {
    const rel = it.mediaPath.replace(/^[\\/]+/, '');
    return `${folder.replace(/[\\/]+$/, '')}/${rel}`;
  }
  return '';
};

// The playlist's compact 1,000-bucket waveform is enough for rows, but not
// for a 20x editor zoom. Fetch one display-only high-resolution trace while
// Properties is open; saved analysis and information colours stay unchanged.
const DETAIL_WAVEFORM_BUCKETS = 8192;
let detailedWaveformRequest = 0;
const loadDetailedWaveform = async () => {
  const request = ++detailedWaveformRequest;
  detailedWaveform.value = null;
  const waveform = props.audioItem.waveform;
  if (props.multiSelect || !waveform?.peaks?.length || waveform.peaks.length >= DETAIL_WAVEFORM_BUCKETS) return;
  const path = resolveMediaPath();
  if (!path) return;
  try {
    const data = await server.fetchWaveformByPath(path, DETAIL_WAVEFORM_BUCKETS);
    const built = buildWaveformFromChannels(data.channels, data.duration_ms / 1000, data);
    if (request === detailedWaveformRequest && built) detailedWaveform.value = built;
  } catch {
    // The persisted waveform remains the complete fallback.
  }
};

watch([
  () => props.audioItem.uuid,
  () => props.audioItem.waveform?.peaks?.length,
  () => props.multiSelect,
], loadDetailedWaveform, { immediate: true });

// Guard so we don't spam the server while a generation is in flight. Reset
// when the item changes or once a waveform actually arrives.
let waveformRequestedFor: string | null = null;
// A property edit briefly round-trips the item through the server (PATCH →
// item_updated echo), during which the local waveform can momentarily read as
// absent before `restoreWaveform` re-attaches it from the session cache. Firing
// a forced server regen in that window is wasteful (and used to cause the
// values to snap back). So we DEFER the self-heal and only act if the waveform
// is still genuinely missing after the echo has had time to land.
let ensureWaveformTimer: ReturnType<typeof setTimeout> | null = null;
const SELF_HEAL_DELAY_MS = 600;

const requestWaveformNow = () => {
  const it = props.audioItem;
  if (!it || it.type !== 'audio') return;
  if (props.multiSelect) return;
  if (hasWaveform.value) { waveformRequestedFor = null; return; }
  if (waveformRequestedFor === it.uuid) return;
  const path = resolveMediaPath();
  if (!path) return;
  waveformRequestedFor = it.uuid;
  useLiveplayServer().requestWaveformGeneration(path, it.uuid, true)
    .catch(() => { /* best-effort — the manual button remains as a fallback */ });
};

const ensureWaveform = () => {
  const it = props.audioItem;
  if (!it || it.type !== 'audio') return;
  // Don't self-heal while multiple items are selected — the canvas isn't shown,
  // and a forced regen here echoes back a waveform_ready that can clobber the
  // values a multi-item auto-trim / auto-volume just applied.
  if (props.multiSelect) return;
  if (hasWaveform.value) { waveformRequestedFor = null; return; }
  // Debounce: re-check after the echo window. A transient drop heals itself and
  // this becomes a no-op; only a real, persistent gap reaches the server.
  if (ensureWaveformTimer) clearTimeout(ensureWaveformTimer);
  ensureWaveformTimer = setTimeout(() => { ensureWaveformTimer = null; requestWaveformNow(); }, SELF_HEAL_DELAY_MS);
};

// React to the panel switching items, or a waveform appearing/disappearing.
// A new item is missing immediately and persistently, so request it without the
// settle delay; a disappearance goes through the debounced ensureWaveform.
watch(() => props.audioItem?.uuid, () => {
  if (ensureWaveformTimer) { clearTimeout(ensureWaveformTimer); ensureWaveformTimer = null; }
  waveformRequestedFor = null;
  if (!hasWaveform.value) ensureWaveform();
});
watch(hasWaveform, (has) => {
  if (!has) ensureWaveform();
  else {
    waveformRequestedFor = null;
    if (ensureWaveformTimer) { clearTimeout(ensureWaveformTimer); ensureWaveformTimer = null; }
  }
});

// Volume in dB
const volumeDB = computed({
  get: () => {
    // Convert linear volume (0-2+) to dB
    const linear = props.audioItem?.volume ?? 1;
    if (linear <= 0) return -60; // -infinity
    return 20 * Math.log10(linear);
  },
  set: (db: number) => {
    const linear = db <= -60 ? 0 : Math.pow(10, db / 20);
    emit('update:volume', linear);
  }
});

const trackColor = computed(() => /^#[0-9a-f]{6}$/i.test(props.audioItem.color)
  ? props.audioItem.color
  : '#687386');

// Time values
const inPoint = computed(() => props.audioItem?.inPoint ?? 0);
const outPoint = computed(() => props.audioItem?.outPoint ?? props.audioItem?.duration ?? 0);
// Use waveform's own duration as fallback — audioItem.duration can be 0 if
// metadata hasn't arrived yet, but the waveform object always carries duration.
const duration = computed(() =>
  props.audioItem?.duration || props.audioItem?.waveform?.duration || 0
);

const clampAuditionPosition = (value: number) => Math.max(
  inPoint.value,
  Math.min(Number.isFinite(value) ? value : inPoint.value, outPoint.value || duration.value),
);

watch(() => props.audioItem.uuid, () => {
  auditionPosition.value = inPoint.value;
}, { immediate: true });
watch([inPoint, outPoint], () => {
  auditionPosition.value = clampAuditionPosition(auditionPosition.value);
});
watch(playbackPosition, (position) => {
  if (auditionIsRunning.value) auditionPosition.value = clampAuditionPosition(position);
});

// Canvas dimensions - use reactive ref to ensure handle positions update on resize
const containerWidth = ref(800);
const canvasWidth = computed(() => containerWidth.value);

// Calculate visible range based on zoom and scroll
const visibleDuration = computed(() => duration.value / zoomLevel.value);
const visibleStart = computed(() => {
  const maxStart = Math.max(0, duration.value - visibleDuration.value);
  return (scrollPosition.value / 100) * maxStart;
});
const visibleEnd = computed(() => Math.min(duration.value, visibleStart.value + visibleDuration.value));

// Max scroll value
const maxScroll = computed(() => (zoomLevel.value > 1 ? 100 : 0));
const zoomProgress = computed(() => ((zoomLevel.value - 1) / 19) * 100);
const scrollProgress = computed(() => maxScroll.value === 0 ? 0 : scrollPosition.value);

// Position calculations for trim handles
const inPointPosition = computed(() => {
  const relativeTime = inPoint.value - visibleStart.value;
  return (relativeTime / visibleDuration.value) * canvasWidth.value;
});

const outPointPosition = computed(() => {
  const relativeTime = outPoint.value - visibleStart.value;
  return (relativeTime / visibleDuration.value) * canvasWidth.value;
});

// Fade handle positions (respecting trim points)
const playFadePosition = computed(() => {
  const fadeEndTime = inPoint.value + playFade.value;
  const relativeTime = fadeEndTime - visibleStart.value;
  return (relativeTime / visibleDuration.value) * canvasWidth.value;
});

const stopFadePosition = computed(() => {
  const fadeStartTime = outPoint.value - stopFade.value;
  const relativeTime = fadeStartTime - visibleStart.value;
  return (relativeTime / visibleDuration.value) * canvasWidth.value;
});

const crossFadePosition = computed(() => {
  const crossFadeStartTime = outPoint.value - crossFade.value;
  const relativeTime = crossFadeStartTime - visibleStart.value;
  return (relativeTime / visibleDuration.value) * canvasWidth.value;
});

const startNextPosition = computed(() => {
  const relativeTime = startNextTime.value - visibleStart.value;
  return (relativeTime / visibleDuration.value) * canvasWidth.value;
});

const seekToPosition = (absoluteTime: number) => {
  const position = clampAuditionPosition(absoluteTime);
  auditionPosition.value = position;
  if (props.previewMode && previewIsCurrent.value) {
    server.seekCueId(previewCueId.value, position);
  } else if (!props.previewMode && regularCue.value) {
    server.seekItem(props.audioItem.uuid, position);
  }
};

const syncPropertiesPreviewRange = () => {
  if (!previewCueId.value || outPoint.value <= inPoint.value) return;
  void server.setPreviewRange(
    inPoint.value,
    outPoint.value,
    props.audioItem.endBehavior?.action === 'loop',
  );
};

const toggleAudition = async () => {
  const position = clampAuditionPosition(playbackPosition.value);
  if (props.previewMode) {
    if (!previewIsCurrent.value) {
      await startPreview(props.audioItem.uuid);
      if (!previewCueId.value) return;
      syncPropertiesPreviewRange();
      server.seekCueId(previewCueId.value, position);
      return;
    }
    if (auditionIsPaused.value) {
      await server.resumeCueId(previewCueId.value);
    } else if (previewIsRunning.value) {
      await server.pauseCueId(previewCueId.value);
    } else {
      syncPropertiesPreviewRange();
      server.seekCueId(previewCueId.value, position);
      await server.play(previewCueId.value);
    }
    return;
  }

  if (regularCue.value?.isPaused) {
    await server.resumeItem(props.audioItem.uuid);
  } else if (regularCue.value) {
    await server.pauseItem(props.audioItem.uuid);
  } else {
    server.seekItem(props.audioItem.uuid, position);
    await server.playItem(props.audioItem.uuid);
  }
};

const stopAudition = async () => {
  auditionPosition.value = clampAuditionPosition(playbackPosition.value);
  if (props.previewMode) {
    if (previewCueId.value) await server.stop(previewCueId.value);
  } else {
    await server.stopItem(props.audioItem.uuid);
  }
};

const jumpAudition = (direction: -1 | 1) => {
  const jump = Math.max(0.1, Math.min(99.9, Number(auditionJumpSeconds.value) || 5));
  auditionJumpSeconds.value = Math.round(jump * 10) / 10;
  seekToPosition(playbackPosition.value + direction * auditionJumpSeconds.value);
};

const setAuditionAsNext = () => setNextItem(props.audioItem.uuid);
const setInPointAtPlayhead = () => {
  emit('update:inPoint', Math.max(0, Math.min(playbackPosition.value, outPoint.value - 0.01)));
  emit('change');
};
const setOutPointAtPlayhead = () => {
  emit('update:outPoint', Math.min(duration.value, Math.max(playbackPosition.value, inPoint.value + 0.01)));
  emit('change');
};

// Handle dragging
const dragState = ref<{ handle: 'in' | 'out' | 'play' | 'stop' | 'cross' | 'startNext' | null; startX: number; startValue: number }>({
  handle: null,
  startX: 0,
  startValue: 0
});

const startDragHandle = (handle: 'in' | 'out', event: MouseEvent) => {
  dragState.value = {
    handle,
    startX: event.clientX,
    startValue: handle === 'in' ? inPoint.value : outPoint.value
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!dragState.value.handle) return;

    const deltaX = e.clientX - dragState.value.startX;
    const deltaTime = (deltaX / canvasWidth.value) * visibleDuration.value;
    const newValue = Math.max(0, Math.min(duration.value, dragState.value.startValue + deltaTime));

    if (dragState.value.handle === 'in') {
      emit('update:inPoint', Math.min(newValue, outPoint.value - 0.01));
    } else if (dragState.value.handle === 'out') {
      emit('update:outPoint', Math.max(newValue, inPoint.value + 0.01));
    }
  };

  const handleMouseUp = () => {
    if (dragState.value.handle) {
      emit('change');
    }
    dragState.value.handle = null;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  };

  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
};

// Handle fade dragging
const startDragFade = (fadeType: 'play' | 'stop' | 'cross' | 'startNext', event: MouseEvent) => {
  const currentValue = fadeType === 'play' ? playFade.value
    : fadeType === 'stop' ? stopFade.value
    : fadeType === 'cross' ? crossFade.value
    : startNextTime.value;
  
  dragState.value = {
    handle: fadeType,
    startX: event.clientX,
    startValue: currentValue
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!dragState.value.handle) return;

    const deltaX = e.clientX - dragState.value.startX;
    const deltaTime = (deltaX / canvasWidth.value) * visibleDuration.value;
    
    if (dragState.value.handle === 'play') {
      // Play fade: drag right increases fade duration
      const newValue = Math.max(0, Math.min(10, dragState.value.startValue + deltaTime));
      emit('update:playFade', newValue);
    } else if (dragState.value.handle === 'stop') {
      // Stop fade: drag left increases fade duration (moving the start point earlier)
      const newValue = Math.max(0, Math.min(10, dragState.value.startValue - deltaTime));
      emit('update:stopFade', newValue);
    } else if (dragState.value.handle === 'cross') {
      // Cross fade: drag left increases fade duration (moving the start point earlier)
      const newValue = Math.max(0, Math.min(10, dragState.value.startValue - deltaTime));
      emit('update:crossFade', newValue);
    } else if (dragState.value.handle === 'startNext') {
      // Start Next marker: absolute position, clamped to the trimmed region.
      const newValue = Math.max(inPoint.value, Math.min(outPoint.value, dragState.value.startValue + deltaTime));
      emit('update:startNextTime', newValue);
    }
  };

  const handleMouseUp = () => {
    if (dragState.value.handle) {
      emit('change');
    }
    dragState.value.handle = null;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  };

  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
};

const handleCanvasPointerDown = (event: PointerEvent) => {
  if (dragState.value.handle || event.button !== 0 || !event.isPrimary) return;
  const canvas = waveformCanvas.value;
  if (!canvas) return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);

  const update = (clientX: number) => {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    seekToPosition(visibleStart.value + ratio * visibleDuration.value);
  };
  const move = (moveEvent: PointerEvent) => update(moveEvent.clientX);
  const finish = () => {
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', finish);
    canvas.removeEventListener('pointercancel', finish);
  };
  update(event.clientX);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
};

const handlePlayheadKeyDown = (event: KeyboardEvent) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  seekToPosition(playbackPosition.value + (event.key === 'ArrowLeft' ? -0.1 : 0.1));
};

// Handle wheel zoom
const handleWheel = (event: WheelEvent) => {
  if (props.multiSelect) return; // no canvas to zoom in multi-selection
  const delta = event.deltaY > 0 ? -0.5 : 0.5;
  zoomLevel.value = Math.max(1, Math.min(20, zoomLevel.value + delta));
};

const handleScrollInput = (event: Event) => {
  const value = Number((event.currentTarget as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  scrollPosition.value = Math.max(0, Math.min(maxScroll.value, value));
};

// Real-time volume preview during drag — updates the value but does NOT save.
const handleVolumeInput = (event: Event) => {
  const db = parseFloat((event.target as HTMLInputElement).value);
  if (!isNaN(db)) volumeDB.value = db;
};

// Fires once when the drag ends (mouseup/touchend) — this is when we save.
const handleVolumeDragEnd = () => {
  emit('change');
};

// Fade change handlers
const handlePlayFadeChange = (event: Event) => {
  const target = event.target as HTMLInputElement;
  const value = parseFloat(target.value);
  emit('update:playFade', value);
  emit('change');
};

const handleStopFadeChange = (event: Event) => {
  const target = event.target as HTMLInputElement;
  const value = parseFloat(target.value);
  emit('update:stopFade', value);
  emit('change');
};

const handlePauseFadeChange = (event: Event) => {
  const target = event.target as HTMLInputElement;
  const value = parseFloat(target.value);
  emit('update:pauseFade', value);
  emit('change');
};

const handleCrossFadeChange = (event: Event) => {
  const target = event.target as HTMLInputElement;
  const value = parseFloat(target.value);
  emit('update:crossFade', value);
  emit('change');
};

// Format time as HH:MM:SS.mmm
const formatTimeDetailed = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const milliseconds = Math.floor((seconds % 1) * 1000);

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
};

// Parse time from HH:MM:SS.mmm format
const parseTimeDetailed = (timeStr: string): number => {
  const parts = timeStr.split(':');
  if (parts.length !== 3) return 0;

  const hours = parseInt(parts[0]) || 0;
  const minutes = parseInt(parts[1]) || 0;
  const secondsParts = parts[2].split('.');
  const seconds = parseInt(secondsParts[0]) || 0;
  const milliseconds = parseInt(secondsParts[1]) || 0;

  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
};

// Handle time input changes
const handleInPointTextChange = (event: Event) => {
  const value = (event.target as HTMLInputElement).value;
  const parsed = parseTimeDetailed(value);
  emit('update:inPoint', Math.max(0, Math.min(parsed, outPoint.value - 0.01)));
  emit('change');
};

const handleOutPointTextChange = (event: Event) => {
  const value = (event.target as HTMLInputElement).value;
  const parsed = parseTimeDetailed(value);
  emit('update:outPoint', Math.min(props.audioItem.duration, Math.max(parsed, inPoint.value + 0.01)));
  emit('change');
};

// Adjustment functions for increment/decrement buttons
const adjustInPoint = (delta: number) => {
  const newValue = Math.max(0, Math.min(inPoint.value + delta, outPoint.value - 0.01));
  emit('update:inPoint', newValue);
  emit('change');
};

const adjustOutPoint = (delta: number) => {
  const newValue = Math.min(props.audioItem.duration, Math.max(outPoint.value + delta, inPoint.value + 0.01));
  emit('update:outPoint', newValue);
  emit('change');
};

const adjustPlayFade = (delta: number) => {
  const newValue = Math.max(0, Math.min(playFade.value + delta, 10));
  emit('update:playFade', newValue);
  emit('change');
};

const adjustStopFade = (delta: number) => {
  const newValue = Math.max(0, Math.min(stopFade.value + delta, 10));
  emit('update:stopFade', newValue);
  emit('change');
};

const adjustCrossFade = (delta: number) => {
  const newValue = Math.max(0, Math.min(crossFade.value + delta, 10));
  emit('update:crossFade', newValue);
  emit('change');
};

// Text change handlers for fade inputs
const handlePlayFadeTextChange = (event: Event) => {
  const value = (event.target as HTMLInputElement).value;
  const parsed = parseTimeDetailed(value);
  emit('update:playFade', Math.max(0, Math.min(parsed, 10)));
  emit('change');
};

const handleStopFadeTextChange = (event: Event) => {
  const value = (event.target as HTMLInputElement).value;
  const parsed = parseTimeDetailed(value);
  emit('update:stopFade', Math.max(0, Math.min(parsed, 10)));
  emit('change');
};

const handleCrossFadeTextChange = (event: Event) => {
  const value = (event.target as HTMLInputElement).value;
  const parsed = parseTimeDetailed(value);
  emit('update:crossFade', Math.max(0, Math.min(parsed, 10)));
  emit('change');
};

// Start Next marker handlers
const handleStartNextEnabledChange = (event: Event) => {
  const enabled = (event.target as HTMLInputElement).checked;
  emit('update:startNextEnabled', enabled);
  // First enable: default the marker near the end of the trimmed region so
  // it's immediately visible and roughly where a segue point usually lives.
  if (enabled && startNextTime.value <= 0) {
    emit('update:startNextTime', Math.max(inPoint.value, outPoint.value - 5));
  }
  emit('change');
};

const handleStartNextFadeOutChange = (event: Event) => {
  emit('update:startNextFadeOut', (event.target as HTMLInputElement).checked);
  emit('change');
};

const adjustStartNextTime = (delta: number) => {
  const newValue = Math.max(inPoint.value, Math.min(startNextTime.value + delta, outPoint.value));
  emit('update:startNextTime', newValue);
  emit('change');
};

const handleStartNextTimeTextChange = (event: Event) => {
  const value = (event.target as HTMLInputElement).value;
  const parsed = parseTimeDetailed(value);
  emit('update:startNextTime', Math.max(inPoint.value, Math.min(parsed, outPoint.value)));
  emit('change');
};

// Trim silence from start and end based on waveform peaks
const trimSilence = () => {
  if (!waveformData.value || waveformData.value.length === 0) {
    console.warn('No waveform data available for trimming');
    return;
  }

  // Emit trimSilence event to trigger batch trimming in parent.
  // The parent (handleTrimSilence) trims every selected item INDIVIDUALLY
  // based on its own waveform and persists the result itself. We deliberately
  // do NOT emit 'change' here: that would run the multi-select snapshot-diff
  // in handleSave and overwrite each item's individually-computed in/out
  // points with the anchor item's values.
  emit('trimSilence');
};

// Normalize audio to the selected loudness or true-peak level.
const normalizeAudio = () => {
  if (!waveformData.value || waveformData.value.length === 0) {
    console.warn('No waveform data available for normalization');
    return;
  }

  const mode = normalizationMode.value;
  const target = normalizationTarget.value;
  if (!Number.isFinite(target)) return;

  // Emit normalize event to trigger batch normalization in parent.
  // The parent (handleNormalize) normalizes every selected item INDIVIDUALLY
  // from its own measured loudness or true peak, and
  // persists itself. We deliberately do NOT emit 'change' here: that would run
  // the multi-select snapshot-diff in handleSave and overwrite each item's
  // individually-computed volume with the anchor item's volume.
  emit('normalize', mode, target);
  closeNormalizeMenu();
};

// Draw waveform on canvas
const drawWaveform = () => {
  const canvas = waveformCanvas.value;
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Set canvas dimensions with device pixel ratio
  const dpr = window.devicePixelRatio || 1;
  const canvasHeight = Math.max(120, waveformContainer.value?.clientHeight ?? 120);
  canvas.width = canvasWidth.value * dpr;
  canvas.height = canvasHeight * dpr;
  canvas.style.width = `${canvasWidth.value}px`;
  ctx.scale(dpr, dpr);

  // Clear canvas with background color
  const rootStyle = getComputedStyle(document.documentElement);
  const bgColor = rootStyle.getPropertyValue('--color-background').trim();
  ctx.fillStyle = bgColor || '#000';
  ctx.fillRect(0, 0, canvasWidth.value, canvasHeight);

  const middleY = canvasHeight / 2;

  // Draw time grid (always shown, behind waveform if present)
  ctx.strokeStyle = 'rgba(128, 128, 128, 0.3)';
  ctx.lineWidth = 1;
  ctx.font = '10px sans-serif';
  ctx.fillStyle = 'rgba(128, 128, 128, 0.6)';

  // Calculate dynamic time step based on visible duration and zoom level
  // Goal: Show grid lines every ~50-100 pixels
  const pixelsPerSecond = canvasWidth.value / visibleDuration.value;
  const targetPixelsPerGrid = 75; // Ideal spacing between grid lines
  
  // Calculate initial time step
  let timeStep = targetPixelsPerGrid / pixelsPerSecond;
  
  // Round to nice intervals: 0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600 seconds
  const niceIntervals = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600];
  timeStep = niceIntervals.reduce((prev, curr) => 
    Math.abs(curr - timeStep) < Math.abs(prev - timeStep) ? curr : prev
  );

  for (let time = Math.ceil(visibleStart.value / timeStep) * timeStep; time <= visibleEnd.value; time += timeStep) {
    const x = (time - visibleStart.value) * pixelsPerSecond;
    
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvasHeight);
    ctx.stroke();

    // Draw time label - format depends on scale
    let label: string;
    if (timeStep < 1) {
      // Show with decimal for sub-second intervals
      label = time.toFixed(1) + 's';
    } else if (timeStep < 60) {
      // Show seconds
      const minutes = Math.floor(time / 60);
      const seconds = Math.floor(time % 60);
      label = minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, '0')}` : `${seconds}s`;
    } else {
      // Show minutes:seconds
      const minutes = Math.floor(time / 60);
      const seconds = Math.floor(time % 60);
      label = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }
    ctx.fillText(label, x + 4, 12);
  }

  if (hasWaveform.value && waveformLanes.value.length > 0 && duration.value > 0) {
    // One lane per source channel (#47): a stereo file draws L above R, mono
    // (and legacy single-array waveforms) fills the full height as before.
    const lanes = waveformLanes.value;
    const laneHeight = canvasHeight / lanes.length;
    const volumeMultiplier = props.audioItem?.volume ?? 1;

    const rmsColor = `#${(0xffffff ^ Number.parseInt(trackColor.value.slice(1), 16))
      .toString(16).padStart(6, '0')}`;

    const heightFraction = (linear: number) =>
      Math.min(Math.max(linear, 0), 1);

    lanes.forEach((lane, laneIndex) => {
      const laneCenter = laneIndex * laneHeight + laneHeight / 2;
      const peaks = lane.peaks;
      const rms = lane.rms;
      const totalPeaks = peaks.length;

      // Calculate visible peak range
      const startPeak = Math.max(0, Math.floor(
        (visibleStart.value / duration.value) * totalPeaks,
      ));
      const endPeak = Math.min(totalPeaks, Math.max(startPeak + 1, Math.ceil(
        (visibleEnd.value / duration.value) * totalPeaks,
      )));
      const visibleCount = endPeak - startPeak;
      if (visibleCount <= 0) return;

      // One envelope point per source bucket while zoomed in, or per screen
      // pixel while zoomed out. Peak uses max-hold so transients survive;
      // RMS uses power averaging so mastered material still has visible shape.
      const pointCount = Math.min(
        visibleCount,
        Math.max(2, Math.floor(canvasWidth.value)),
      );
      const bucketsPerPoint = visibleCount / pointCount;
      const halfHeight = Math.max(1, laneHeight / 2 - 2);
      const samples: Array<{
        x: number;
        base: number;
        peak: number;
        rms: number;
      }> = [];

      for (let point = 0; point < pointCount; point++) {
        const from = startPeak + Math.floor(point * bucketsPerPoint);
        const to = Math.min(endPeak, Math.max(
          from + 1,
          startPeak + Math.ceil((point + 1) * bucketsPerPoint),
        ));
        let peak = 0;
        let rmsPower = 0;
        let rmsCount = 0;
        for (let index = from; index < to; index++) {
          const peakValue = peaks[index] ?? 0;
          if (Number.isFinite(peakValue)) peak = Math.max(peak, peakValue);
          const rmsValue = rms?.[index];
          if (Number.isFinite(rmsValue)) {
            rmsPower += (rmsValue as number) ** 2;
            rmsCount++;
          }
        }

        const audiblePeak = Math.max(0, peak * volumeMultiplier);
        const measuredRms = rmsCount > 0 ? Math.sqrt(rmsPower / rmsCount) : peak;
        const audibleRms = Math.min(audiblePeak, Math.max(0, measuredRms * volumeMultiplier));
        samples.push({
          x: pointCount === 1 ? 0 : (point / (pointCount - 1)) * canvasWidth.value,
          base: heightFraction(peak) * halfHeight,
          peak: heightFraction(audiblePeak) * halfHeight,
          rms: heightFraction(audibleRms) * halfHeight,
        });
      }
      if (samples.length === 1) samples.push({ ...samples[0]!, x: canvasWidth.value });

      const envelopePath = (key: 'base' | 'peak' | 'rms') => {
        const path = new Path2D();
        path.moveTo(samples[0]!.x, laneCenter - samples[0]![key]);
        for (let index = 1; index < samples.length; index++) {
          path.lineTo(samples[index]!.x, laneCenter - samples[index]![key]);
        }
        for (let index = samples.length - 1; index >= 0; index--) {
          path.lineTo(samples[index]!.x, laneCenter + samples[index]![key]);
        }
        path.closePath();
        return path;
      };

      // Peak matches the playlist cue colour; RMS uses its complementary hue
      // so the energy body stays distinct for every preset track colour.

      ctx.strokeStyle = 'rgba(128, 128, 128, 0.28)';
      ctx.lineWidth = 1;
      ctx.stroke(envelopePath('base'));

      ctx.fillStyle = trackColor.value;
      ctx.globalAlpha = 0.18;
      ctx.fill(envelopePath('peak'));

      ctx.fillStyle = rmsColor;
      ctx.globalAlpha = 0.82;
      ctx.fill(envelopePath('rms'));

      ctx.strokeStyle = trackColor.value;
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 1.25;
      ctx.stroke(envelopePath('peak'));
      ctx.globalAlpha = 1;

      // Lane zero line + divider between lanes, so L/R read as two strips.
      if (lanes.length > 1) {
        ctx.strokeStyle = 'rgba(128, 128, 128, 0.25)';
        ctx.beginPath();
        ctx.moveTo(0, laneCenter);
        ctx.lineTo(canvasWidth.value, laneCenter);
        ctx.stroke();
        if (laneIndex > 0) {
          ctx.strokeStyle = 'rgba(128, 128, 128, 0.15)';
          ctx.beginPath();
          ctx.moveTo(0, laneIndex * laneHeight);
          ctx.lineTo(canvasWidth.value, laneIndex * laneHeight);
          ctx.stroke();
        }
      }
    });
  } else {
    // Draw "No Waveform Data" message
    ctx.font = '14px sans-serif';
    ctx.fillStyle = 'rgba(128, 128, 128, 0.5)';
    ctx.textAlign = 'center';
    ctx.fillText(t('properties.noWaveformData'), canvasWidth.value / 2, middleY);
    ctx.textAlign = 'left';
  }

  // Draw center line
  ctx.strokeStyle = 'rgba(128, 128, 128, 0.3)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, middleY);
  ctx.lineTo(canvasWidth.value, middleY);
  ctx.stroke();

  // Draw fade visualizations (always, regardless of playback state)
  if (duration.value > 0) {
    const pixelsPerSecond = canvasWidth.value / visibleDuration.value;

    // Play Fade (fade in at start) — red diagonal
    if (props.audioItem.playFade && props.audioItem.playFade > 0) {
      const fadeStartTime = inPoint.value;
      const fadeEndTime = inPoint.value + props.audioItem.playFade;
      if (fadeEndTime >= visibleStart.value && fadeStartTime <= visibleEnd.value) {
        const fadeStartX = Math.max(0, (fadeStartTime - visibleStart.value) * pixelsPerSecond);
        const fadeEndX = Math.min(canvasWidth.value, (fadeEndTime - visibleStart.value) * pixelsPerSecond);
        const fadeWidth = fadeEndX - fadeStartX;
        if (fadeWidth > 0) {
          ctx.fillStyle = 'rgba(220, 38, 38, 0.2)';
          ctx.fillRect(fadeStartX, 0, fadeWidth, canvasHeight);
          ctx.strokeStyle = 'rgba(220, 38, 38, 0.8)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(fadeStartX, canvasHeight);
          ctx.lineTo(fadeEndX, 0);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(fadeEndX, 0);
          ctx.lineTo(fadeEndX, canvasHeight);
          ctx.stroke();
        }
      }
    }

    // Stop Fade (fade out before end) — red diagonal
    if (props.audioItem.stopFade && props.audioItem.stopFade > 0) {
      const fadeStartTime = outPoint.value - props.audioItem.stopFade;
      const fadeEndTime = outPoint.value;
      if (fadeStartTime <= visibleEnd.value && fadeEndTime >= visibleStart.value) {
        const fadeStartX = Math.max(0, (fadeStartTime - visibleStart.value) * pixelsPerSecond);
        const fadeEndX = Math.min(canvasWidth.value, (fadeEndTime - visibleStart.value) * pixelsPerSecond);
        const fadeWidth = fadeEndX - fadeStartX;
        if (fadeWidth > 0) {
          ctx.fillStyle = 'rgba(220, 38, 38, 0.2)';
          ctx.fillRect(fadeStartX, 0, fadeWidth, canvasHeight);
          ctx.strokeStyle = 'rgba(220, 38, 38, 0.8)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(fadeStartX, 0);
          ctx.lineTo(fadeEndX, canvasHeight);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(fadeStartX, 0);
          ctx.lineTo(fadeStartX, canvasHeight);
          ctx.stroke();
        }
      }
    }

    // Cross Fade — yellow X
    if (props.audioItem.crossFade && props.audioItem.crossFade > 0) {
      const crossFadeStartTime = outPoint.value - props.audioItem.crossFade;
      const crossFadeEndTime = outPoint.value;
      if (crossFadeStartTime <= visibleEnd.value && crossFadeEndTime >= visibleStart.value) {
        const crossStartX = Math.max(0, (crossFadeStartTime - visibleStart.value) * pixelsPerSecond);
        const crossEndX = Math.min(canvasWidth.value, (crossFadeEndTime - visibleStart.value) * pixelsPerSecond);
        const crossWidth = crossEndX - crossStartX;
        if (crossWidth > 0) {
          ctx.fillStyle = 'rgba(234, 179, 8, 0.2)';
          ctx.fillRect(crossStartX, 0, crossWidth, canvasHeight);
          ctx.strokeStyle = 'rgba(234, 179, 8, 0.8)';
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(crossStartX, 0); ctx.lineTo(crossEndX, canvasHeight); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(crossStartX, canvasHeight); ctx.lineTo(crossEndX, 0); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(crossStartX, 0); ctx.lineTo(crossStartX, canvasHeight); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(crossEndX, 0); ctx.lineTo(crossEndX, canvasHeight); ctx.stroke();
        }
      }
    }

    // Start Next marker — the same warning/next colour used throughout the app.
    if (props.audioItem.startNextEnabled && startNextTime.value > 0) {
      const markerTime = startNextTime.value;
      const markerColor = rootStyle.getPropertyValue('--state-up-next').trim() || '#d8ad35';
      if (markerTime >= visibleStart.value && markerTime <= visibleEnd.value) {
        const markerX = (markerTime - visibleStart.value) * pixelsPerSecond;
        ctx.strokeStyle = markerColor;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(markerX, 0); ctx.lineTo(markerX, canvasHeight); ctx.stroke();
      }
      if (props.audioItem.startNextFadeOut) {
        const fadeDur = props.audioItem.fadeOutDuration || 1;
        const fadeEndTime = Math.min(markerTime + fadeDur, outPoint.value);
        if (markerTime <= visibleEnd.value && fadeEndTime >= visibleStart.value) {
          const fadeStartX = Math.max(0, (markerTime - visibleStart.value) * pixelsPerSecond);
          const fadeEndX = Math.min(canvasWidth.value, (fadeEndTime - visibleStart.value) * pixelsPerSecond);
          const fadeWidth = fadeEndX - fadeStartX;
          if (fadeWidth > 0) {
            ctx.globalAlpha = 0.15;
            ctx.fillStyle = markerColor;
            ctx.fillRect(fadeStartX, 0, fadeWidth, canvasHeight);
            ctx.globalAlpha = 0.8;
            ctx.strokeStyle = markerColor;
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(fadeStartX, 0); ctx.lineTo(fadeEndX, canvasHeight); ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
      }
    }
  }

  const drawPlayheadMarker = (position: number | null, color: string, preview: boolean) => {
    if (position === null || duration.value <= 0) return;
    const relativeTime = position - visibleStart.value;
    const playheadX = (relativeTime / visibleDuration.value) * canvasWidth.value;
    if (playheadX < 0 || playheadX > canvasWidth.value) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash(preview ? [5, 3] : []);
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, canvasHeight);
    ctx.stroke();
    ctx.setLineDash([]);
    if (preview) {
      ctx.beginPath();
      ctx.arc(playheadX, 5, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(playheadX, canvasHeight - 5, 4, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(playheadX, 10);
      ctx.lineTo(playheadX - 6, 0);
      ctx.lineTo(playheadX + 6, 0);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(playheadX, canvasHeight - 10);
      ctx.lineTo(playheadX - 6, canvasHeight);
      ctx.lineTo(playheadX + 6, canvasHeight);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  };

  drawPlayheadMarker(
    mainPlayheadPosition.value,
    rootStyle.getPropertyValue('--state-playing').trim() || '#35a96b',
    false,
  );
  drawPlayheadMarker(
    previewPlayheadPosition.value,
    rootStyle.getPropertyValue('--state-preview').trim() || '#315fcf',
    true,
  );
};

// Throttle drawWaveform to prevent excessive redraws
let drawTimeout: NodeJS.Timeout | null = null;
const throttledDraw = () => {
  if (drawTimeout) clearTimeout(drawTimeout);
  drawTimeout = setTimeout(() => {
    drawWaveform();
  }, 16); // ~60fps
};

// Watch for changes and redraw
watch([
  zoomLevel, 
  scrollPosition, 
  () => props.audioItem?.volume, 
  () => props.audioItem?.inPoint, 
  () => props.audioItem?.outPoint,
  () => props.audioItem?.playFade,
  () => props.audioItem?.stopFade,
  () => props.audioItem?.crossFade,
  () => props.audioItem?.startNextEnabled,
  () => props.audioItem?.startNextTime,
  () => props.audioItem?.startNextFadeOut,
  () => props.audioItem?.color,
  waveformData,
  playbackPosition,
  mainPlayheadPosition,
  previewPlayheadPosition,
], () => {
  throttledDraw();
});

// Redraw whenever waveform data arrives or changes. `immediate` ensures we
// schedule a draw on mount even if the data was already set (e.g. when the
// panel is reopened for the same item). The canvas ref is null at that point
// so drawWaveform returns early; the real draw comes from onMounted's rAF.
watch(() => props.audioItem?.waveform, () => {
  throttledDraw();
}, { immediate: true });
watch(detailedWaveform, throttledDraw);

// Leaving multi-selection re-creates the canvas element (it's only rendered in
// single-item mode). Re-measure the container and draw once it's back, and run
// the self-heal that was suppressed while multiple items were selected.
watch(() => props.multiSelect, (multi) => {
  if (multi) return;
  nextTick(() => requestAnimationFrame(() => {
    if (waveformContainer.value) containerWidth.value = waveformContainer.value.clientWidth;
    drawWaveform();
    ensureWaveform();
  }));
});

// Watch for canvas width changes
const resizeObserver = ref<ResizeObserver | null>(null);

onMounted(() => {
  // Wait for layout to settle (nextTick ensures the DOM is painted; rAF
  // ensures the browser has committed the layout pass so clientWidth is real).
  nextTick(() => {
    requestAnimationFrame(() => {
      if (waveformContainer.value) {
        containerWidth.value = waveformContainer.value.clientWidth;
      }
      drawWaveform();

      // If waveform data is missing, ask the server to (re)generate it.
      ensureWaveform();
    });
  });

  if (waveformContainer.value) {
    resizeObserver.value = new ResizeObserver(() => {
      if (waveformContainer.value) {
        containerWidth.value = waveformContainer.value.clientWidth;
      }
      throttledDraw();
    });
    resizeObserver.value.observe(waveformContainer.value);
  }
});

onUnmounted(() => {
  // Clear any pending draw / self-heal operations
  if (drawTimeout) clearTimeout(drawTimeout);
  if (ensureWaveformTimer) clearTimeout(ensureWaveformTimer);
  
  // Clean up resize observer
  if (resizeObserver.value && waveformContainer.value) {
    resizeObserver.value.unobserve(waveformContainer.value);
    resizeObserver.value.disconnect();
  }
});

</script>

<style scoped>
.waveform-trimmer {
  display: grid;
  background: transparent;
  grid-template-columns: 80px minmax(300px, 1fr) 184px minmax(260px, 296px);
  align-items: stretch;
  gap: var(--spacing-sm);
  width: 100%;
  min-width: 0;
  height: 100%;
  min-height: 188px;
  padding: 0;
}

.volume-control-section,
.waveform-section,
.time-display-section,
.fade-controls-section {
  min-height: 0;
  height: 100%;
  box-sizing: border-box;
}

/* Volume Control */
.volume-control-section {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  min-width: 0;
  padding: 0 var(--spacing-sm) 0 0;
  border-right: 1px solid var(--color-border);
}

.volume-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--type-metadata-size);
  color: var(--color-text-primary);
  font-weight: 600;
}

.db-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0;
  text-transform: none;
}

.volume-slider-container {
  display: flex;
  gap: var(--spacing-xs);
  align-items: center;
  flex: 1;
  min-height: 0;
}

.volume-slider-vertical {
  writing-mode: vertical-lr;
  direction: rtl;
  width: 40px;
  height: 100%;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
  background: transparent;
  border-radius: 4px;
  position: relative;
}

/* Volume slider track with dB steps */
.volume-slider-vertical::-webkit-slider-runnable-track {
  width: 10px;
  height: 100%;
  background: linear-gradient(
    to right,
    var(--color-control) 0 4px,
    var(--color-background) 4px 6px,
    var(--color-control) 6px 100%
  );
  border: 1px solid var(--color-border);
  border-radius: 4px;
  box-shadow: inset 0 0 4px rgba(0, 0, 0, 0.45);
}

.volume-slider-vertical::-moz-range-track {
  width: 10px;
  height: 100%;
  background: linear-gradient(
    to right,
    var(--color-control) 0 4px,
    var(--color-background) 4px 6px,
    var(--color-control) 6px 100%
  );
  border: 1px solid var(--color-border);
  border-radius: 4px;
  box-shadow: inset 0 0 4px rgba(0, 0, 0, 0.45);
}

.volume-slider-vertical::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 38px;
  height: 22px;
  background:
    linear-gradient(to bottom, transparent 9px, var(--volume-handle-color, var(--color-accent)) 9px 11px, transparent 11px),
    var(--color-surface-raised);
  cursor: pointer;
  border-radius: 6px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.32);
  border: 1px solid var(--color-border-strong);
}

.volume-slider-vertical::-moz-range-thumb {
  width: 38px;
  height: 22px;
  background:
    linear-gradient(to bottom, transparent 9px, var(--volume-handle-color, var(--color-accent)) 9px 11px, transparent 11px),
    var(--color-surface-raised);
  cursor: pointer;
  border-radius: 6px;
  border: 1px solid var(--color-border-strong);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.32);
}

.volume-slider-vertical:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: -2px;
  border-radius: var(--border-radius-sm);
}

.volume-markers {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  height: 100%;
  font-size: 12px;
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
}

/* Fade & Transition Controls Section */
.fade-controls-section {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  align-items: start;
  gap: var(--spacing-xs);
  padding: 0 0 0 var(--spacing-sm);
  border-left: 1px solid var(--color-border);
  width: auto;
  min-width: 0;
}

.fade-column {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  min-width: 0;
}

.fade-control-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.start-next-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--type-metadata-size);
  color: var(--color-text-primary);
  font-weight: 600;
  cursor: pointer;
  text-wrap: wrap;
}

.start-next-toggle input[type='checkbox'] {
  accent-color: rgb(22, 163, 74);
  cursor: pointer;
}

.start-next-disabled {
  opacity: 0.62;
  pointer-events: auto;
}

.fade-control-group label {
  font-size: var(--type-metadata-size);
  color: var(--color-text-primary);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.fade-input {
  width: 100%;
  height: 30px;
  padding: 4px var(--spacing-xs);
  background: var(--color-control);
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-sm);
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-size: var(--type-metadata-size);
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.fade-input:focus {
  outline: none;
  border-color: var(--color-accent);
}

.fade-unit {
  display: inline-block;
  font-size: 12px;
  color: var(--color-text-secondary);
  margin-top: 2px;
}

/* Waveform Section */
.waveform-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  min-width: 0;
}

.waveform-controls {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  min-height: 36px;
  padding: var(--spacing-xs) var(--spacing-sm);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-sm);
  gap: var(--spacing-md);
}

.audition-transport {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.audition-btn,
.audition-set-next,
.audition-marker-btn {
  height: 30px;
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-sm);
  background: var(--color-control);
  color: var(--color-text-primary);
}

.audition-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  padding: 0;
}

.audition-btn:hover,
.audition-set-next:hover,
.audition-marker-btn:hover {
  background: var(--color-surface-hover);
  border-color: var(--color-border-strong);
}

.audition-btn:focus-visible,
.audition-set-next:focus-visible,
.audition-marker-btn:focus-visible,
.audition-jump input:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 1px;
}

.audition-btn .material-symbols-rounded {
  font-size: 19px;
}

.audition-btn--primary {
  border-color: color-mix(in srgb, var(--color-accent) 60%, var(--color-border));
  color: var(--color-accent);
}

.audition-btn--stop {
  color: var(--color-danger);
}

.audition-jump {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding-right: 6px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-sm);
  background: var(--color-control);
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: 12px;
}

.audition-jump input {
  width: 48px;
  height: 100%;
  padding: 0 3px 0 6px;
  border: 0;
  background: transparent;
  color: var(--color-text-primary);
  font: inherit;
  text-align: right;
}

.audition-time {
  min-width: 78px;
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.audition-set-next {
  padding: 0 var(--spacing-sm);
  font-size: 12px;
  font-weight: 650;
}

.audition-marker-btn {
  padding: 0 var(--spacing-sm);
  font-size: 11px;
  font-weight: 650;
}

.audition-set-next.active {
  background: color-mix(in srgb, var(--state-up-next) 72%, var(--color-control));
  border-color: var(--state-up-next);
  color: #171b25;
}

.audition-set-next:hover {
  background: color-mix(in srgb, var(--state-up-next) 34%, var(--color-control));
}

.zoom-control {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--spacing-xs);
}

.zoom-control .material-symbols-rounded {
  font-size: 18px;
  color: var(--color-text-secondary);
}

.zoom-slider {
  width: 120px;
}

.zoom-slider,
.scroll-slider {
  --range-progress: 0%;
  -webkit-appearance: none;
  appearance: none;
  height: 12px;
  margin: 0;
  box-sizing: border-box;
  background: linear-gradient(
    to right,
    var(--color-accent) 0 var(--range-progress),
    var(--color-surface) var(--range-progress) 100%
  );
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-sm);
  cursor: pointer;
  direction: ltr;
}

.zoom-slider::-webkit-slider-runnable-track,
.scroll-slider::-webkit-slider-runnable-track {
  height: 10px;
  background: transparent;
  border: 0;
}

.zoom-slider::-webkit-slider-thumb,
.scroll-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  margin-top: -2px;
  background: var(--color-surface-raised);
  border: 2px solid var(--color-accent);
  cursor: pointer;
  border-radius: 50%;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}

.zoom-slider::-moz-range-track,
.scroll-slider::-moz-range-track {
  height: 10px;
  background: transparent;
  border: 0;
}

.zoom-slider::-moz-range-thumb,
.scroll-slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  background: var(--color-surface-raised);
  border: 2px solid var(--color-accent);
  border-radius: 50%;
  cursor: pointer;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}

.zoom-slider:focus-visible,
.scroll-slider:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}

.zoom-slider:disabled,
.scroll-slider:disabled {
  cursor: default;
  background: var(--color-surface);
  opacity: 0.72;
}

.audio-tools {
  display: flex;
  gap: 8px;
  align-items: center;
}

.normalize-menu {
  position: relative;
  min-height: 30px;
}

.normalize-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 4px var(--spacing-sm);
  background: var(--color-control);
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-sm);
  color: var(--color-text-primary);
  cursor: pointer;
  list-style: none;
}

.normalize-btn::-webkit-details-marker {
  display: none;
}

.normalize-btn:hover,
.normalize-menu[open] > .normalize-btn {
  background: var(--color-surface-hover);
  border-color: var(--color-border-strong);
}

.normalize-btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.normalize-chevron {
  margin-left: 2px;
  font-size: 16px;
  transition: transform var(--transition-fast);
}

.normalize-menu[open] .normalize-chevron {
  transform: rotate(180deg);
}

.normalize-popover {
  position: absolute;
  z-index: var(--z-dropdown);
  top: calc(100% + 6px);
  right: 0;
  display: grid;
  gap: var(--spacing-sm);
  width: 256px;
  padding: var(--spacing-sm);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--border-radius-md);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.42);
}

.normalize-field {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  align-items: center;
  gap: var(--spacing-sm);
  font-size: 12px;
  color: var(--color-text-secondary);
}

.normalize-field select,
.normalize-level {
  min-height: 30px;
}

.normalize-level {
  display: flex;
  align-items: stretch;
  overflow: hidden;
  background: var(--color-control);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
}

.normalize-target {
  width: 72px;
  min-width: 0;
  padding: 4px 3px 4px 7px;
  background: transparent;
  border: 0;
  border-radius: 0;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.normalize-target:focus {
  box-shadow: none;
}

.normalize-unit {
  display: inline-flex;
  flex: 1;
  align-items: center;
  padding: 4px 7px 4px 3px;
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  pointer-events: none;
}

.normalize-apply {
  justify-self: end;
  min-height: 30px;
}

.trim-silence-btn,
.normalize-btn,
.normalize-apply {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 4px var(--spacing-sm);
  background: var(--color-control);
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-sm);
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition:
    color var(--transition-fast),
    background-color var(--transition-fast),
    border-color var(--transition-fast);
  
  &:hover {
    background: var(--color-accent-soft);
    border-color: color-mix(in srgb, var(--color-accent) 52%, var(--color-border));
    color: var(--color-text-primary);
  }
  
  .material-symbols-rounded {
    font-size: 18px;
  }
}



.zoom-level-text {
  font-size: 12px;
  color: var(--color-text-secondary);
  min-width: 45px;
  text-align: right;
}

/* Waveform Container */
.waveform-container {
  position: relative;
  width: 100%;
  flex: 1;
  min-height: 120px;
  background: var(--color-background);
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-sm);
  overflow: hidden;
  cursor: crosshair;
}

.waveform-canvas {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
}

.waveform-canvas:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: -2px;
}

/* Multi-selection placeholder shown in place of the single-item canvas.
   Fills the (already-bordered) waveform container. */
.waveform-multi-message {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-xs);
  width: 100%;
  height: 100%;
  color: var(--color-text-secondary);
  text-align: center;
  padding: 0 var(--spacing-lg);
}

.waveform-multi-message .material-symbols-rounded {
  font-size: 28px;
  opacity: 0.7;
}

.waveform-multi-message p {
  font-size: 12px;
  max-width: 320px;
}

.time-field-disabled {
  opacity: 0.55;
}

/* Trim Handles */
.trim-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  cursor: ew-resize;
  z-index: 10;
  user-select: none;
}

.trim-handle-in {
  background: rgba(34, 197, 94, 0.3);
}

.trim-handle-out {
  background: rgba(239, 68, 68, 0.3);
}

.trim-line {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: currentColor;
}

.trim-handle-in .trim-line {
  background: rgb(34, 197, 94);
}

.trim-handle-out .trim-line {
  background: rgb(239, 68, 68);
}

.trim-grip {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 20px;
  height: 32px;
  background: var(--color-surface);
  border: 2px solid currentColor;
  border-radius: var(--border-radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  user-select: none;
}

.trim-handle-in .trim-grip {
  left: -10px;
  color: rgb(34, 197, 94);
}

.trim-handle-out .trim-grip {
  right: -10px;
  color: rgb(239, 68, 68);
}

.trim-grip .material-symbols-rounded {
  font-size: 14px;
}

/* Fade Handles */
.fade-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  cursor: ew-resize;
  z-index: 11;
  user-select: none;
}

.fade-line {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
}

.fade-line-red {
  background: rgba(220, 38, 38, 0.8);
}

.fade-line-yellow {
  background: rgba(234, 179, 8, 0.8);
}

.fade-line-startnext {
  background: var(--state-up-next);
}

.fade-grip {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 24px;
  height: 24px;
  background: var(--color-surface);
  border: 2px solid currentColor;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
  user-select: none;
  transition: transform 0.15s ease;
}

.fade-handle:hover .fade-grip {
  transform: translateY(-50%) scale(1.15);
}

.fade-grip-red {
  color: rgb(220, 38, 38);
  border-color: rgb(220, 38, 38);
}

.fade-grip-yellow {
  color: rgb(234, 179, 8);
  border-color: rgb(234, 179, 8);
}

.fade-grip-startnext {
  color: var(--state-up-next);
  border-color: var(--state-up-next);
}

.fade-handle-play .fade-grip {
  left: 50%;
  transform: translate(-50%, -50%);
}

.fade-handle-play:hover .fade-grip {
  transform: translate(-50%, -50%) scale(1.15);
}

.fade-handle-stop .fade-grip,
.fade-handle-cross .fade-grip,
.fade-handle-startnext .fade-grip {
  left: 50%;
  transform: translate(-50%, -50%);
}

.fade-handle-stop:hover .fade-grip,
.fade-handle-cross:hover .fade-grip,
.fade-handle-startnext:hover .fade-grip {
  transform: translate(-50%, -50%) scale(1.15);
}

.fade-grip .material-symbols-rounded {
  font-size: 14px;
}

/* Trim Overlays */
.trim-overlay {
  position: absolute;
  top: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  pointer-events: none;
}

.trim-overlay-left {
  left: 0;
}

.trim-overlay-right {
  right: 0;
  width: auto;
  left: auto;
}

/* Scrollbar */
.waveform-scrollbar {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  width: 100%;
}

.scroll-slider {
  flex: 1 1 auto;
  min-width: 0;
  width: auto;
}

/* Time Display Section (right side) */
.time-display-section {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  width: auto;
  min-width: 0;
  padding: 0 0 0 var(--spacing-sm);
  border-left: 1px solid var(--color-border);
}

.time-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.time-field-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 22px;
  gap: var(--spacing-xs);
}

.time-field-label-row label,
.time-field > label {
  font-size: var(--type-metadata-size);
  color: var(--color-text-primary);
  font-weight: 600;
}

.time-field-set-btn {
  height: 22px;
  padding: 0 6px;
  font-size: 10px;
}

.time-input-with-buttons {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) 30px;
  align-items: center;
  gap: 2px;
}

.time-decrement,
.time-increment {
  padding: 2px;
  background: var(--color-control);
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-sm);
  color: var(--color-text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  height: 30px;
  transition:
    color var(--transition-fast),
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    border-color var(--transition-fast);
}

.time-decrement:hover,
.time-increment:hover {
  background: var(--color-surface-hover);
  color: var(--color-text-primary);
  border-color: var(--color-accent);
}

.time-decrement .material-symbols-rounded,
.time-increment .material-symbols-rounded {
  font-size: 16px;
  font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20;
}

.time-input {
  height: 30px;
  padding: 4px var(--spacing-xs);
  background: var(--color-control);
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-sm);
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-size: var(--type-metadata-size);
  text-align: center;
  font-variant-numeric: tabular-nums;
  flex: 1;
  min-width: 0;
}

.time-input:focus-visible,
.fade-input:focus-visible,
.time-decrement:focus-visible,
.time-increment:focus-visible,
.trim-silence-btn:focus-visible,
.normalize-btn:focus-visible,
.normalize-mode:focus-visible,
.normalize-target:focus-visible {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: 0 0 0 2px var(--color-focus-ring);
}

.time-input:read-only {
  color: var(--color-text-secondary);
  cursor: default;
}
</style>
