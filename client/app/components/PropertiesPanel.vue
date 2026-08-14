<template>
  <div class="properties-panel" :style="{ height: `${panelHeight}px` }">
    <div
      class="properties-resize-handle"
      role="separator"
      aria-orientation="horizontal"
      :aria-label="t('properties.title')"
      aria-valuemin="240"
      :aria-valuenow="panelHeight"
      tabindex="0"
      @pointerdown="startPanelResize"
      @keydown="handlePanelResizeKey"
    ></div>
    <div class="properties-header workspace-panel-header">
      <h3 class="workspace-panel-header__title">{{ selectedItems.size > 1 ? t('properties.multipleItemsSelected', { count: selectedItems.size }) : (t('properties.title') + ': ' + (selectedItem?.displayName || '')) }}</h3>
      <div class="properties-tabs" role="tablist">
        <button
          v-for="tab in availableTabs"
          :key="tab.id"
          :class="['tab-btn', { active: activeTab === tab.id }]"
          role="tab"
          :aria-selected="activeTab === tab.id"
          @click="activeTab = tab.id"
        >
          <span class="material-symbols-rounded">{{ tab.icon }}</span>
          <span>{{ tab.label }}</span>
        </button>
      </div>
      <button class="close-btn" :title="t('cart.close')" :aria-label="t('cart.close')" @click="handleClose">
        <span class="material-symbols-rounded">close</span>
      </button>
    </div>
    
    <div class="properties-content">
      <!-- Basic Info Tab -->
      <div v-if="activeTab === 'basic'" class="tab-panel basic-panel">
        <div class="property-field">
          <label>{{ t('properties.displayName') }}</label>
          <input 
            v-model="selectedItem.displayName" 
            type="text" 
            @change="handleSave"
          />
        </div>

        <div v-if="hasSelectedAudioItems" class="property-field one-shot-designation">
          <label class="one-shot-designation__toggle">
            <input
              type="checkbox"
              :checked="oneShotEnabled"
              @change="handleOneShotDesignationChange"
            />
            <span>{{ t('oneShots.designation') }}</span>
          </label>
          <p class="property-help">{{ t('oneShots.designationHelp') }}</p>
        </div>

        <div v-if="selectedItem.type === 'audio'" class="property-field">
          <label>{{ t('properties.file') }}</label>
          <div class="input-with-btn">
            <input :value="audioItem.mediaFileName" readonly />
            <button class="icon-btn" :disabled="isReplacingMedia" :title="t('properties.replaceMedia')" @click="handleReplaceMedia">
              <span class="material-symbols-rounded">swap_horiz</span>
            </button>
          </div>
        </div>

        <div v-if="selectedItem.type === 'audio'" class="property-field">
          <label>{{ t('properties.duration') }}</label>
          <input :value="formatTime(audioItem.duration)" readonly />
        </div>
        
        <div class="property-field">
          <label>{{ t('properties.color') }}</label>
          <div class="color-picker">
            <button
              v-for="color in PRESET_COLORS"
              :key="color"
              class="color-btn"
              :style="{ backgroundColor: color }"
              :class="{ active: selectedItem.color === color }"
              @click="() => { selectedItem.color = color; handleSave(); }"
            ></button>
          </div>
          <button
            v-if="hasSelectedAudioItems"
            type="button"
            class="action-btn-small"
            @click="handleCycleSelectedColors"
          >
            {{ t('properties.cycleSelectedColors') }}
          </button>
        </div>
        
        <div class="property-field">
          <label>{{ t('properties.uuid') }}</label>
          <div class="input-with-btn">
            <input :value="selectedItem.uuid" readonly />
            <button class="icon-btn" @click="copyToClipboard(selectedItem.uuid)">
              <span class="material-symbols-rounded">content_copy</span>
            </button>
          </div>
          <p v-if="replaceMediaStatus" class="property-help" :class="{ 'property-help--error': replaceMediaError }">
            {{ replaceMediaStatus }}
          </p>
        </div>
        
        <div class="property-field">
          <label>{{ t('properties.index') }}</label>
          <input :value="formatItemIndex(selectedItem.index)" readonly />
        </div>
        
        <div class="property-field" v-if="selectedItem.type === 'audio'">
          <label>{{ t('properties.apiTriggerUrl') }} · POST</label>
          <div class="input-with-btn">
            <input :value="apiTriggerUrl" readonly />
            <button class="icon-btn" @click="copyToClipboard(apiTriggerUrl)">
              <span class="material-symbols-rounded">content_copy</span>
            </button>
          </div>
        </div>

        <div v-if="selectedItem.type === 'audio'" class="property-field">
          <label>{{ t('properties.waveform') }}</label>
          <button class="icon-btn regen-btn" :disabled="isRegenerating" @click="handleRegenerateWaveform">
            <span class="material-symbols-rounded" :class="{ spinning: isRegenerating }">refresh</span>
            <span>{{ isRegenerating ? t('properties.regeneratingWaveform') : t('properties.regenerateWaveform') }}</span>
          </button>
        </div>
      </div>
      
      <!-- Playback Tab -->
      <div v-if="activeTab === 'playback' && selectedItem.type === 'audio'" class="tab-panel playback-panel">
        <WaveformTrimmer
          v-if="audioItem && (audioItem.mediaPath || audioItem.mediaServerPath) && audioItem.duration > 0"
          :audio-item="audioItem"
          :multi-select="selectedItems.size > 1"
          :preview-mode="uiMode === 'playback'"
          @update:volume="(v) => { beginItemBatch(); audioItem.volume = v; }"
          @update:in-point="(v) => { beginItemBatch(); audioItem.inPoint = v; }"
          @update:out-point="(v) => { beginItemBatch(); audioItem.outPoint = v; }"
          @update:play-fade="(v) => { beginItemBatch(); handlePlayFadeUpdate(v); }"
          @update:stop-fade="(v) => { beginItemBatch(); handleStopFadeUpdate(v); }"
          @update:cross-fade="(v) => { beginItemBatch(); handleCrossFadeUpdate(v); }"
          @update:start-next-enabled="(v) => { beginItemBatch(); handleStartNextEnabledUpdate(v); }"
          @update:start-next-time="(v) => { beginItemBatch(); handleStartNextTimeUpdate(v); }"
          @update:start-next-fade-out="(v) => { beginItemBatch(); handleStartNextFadeOutUpdate(v); }"
          @change="handleSave"
          @normalize="handleNormalize"
          @trim-silence="handleTrimSilence"
        />
        <div v-else class="loading-message">
          <span class="material-symbols-rounded">pending</span>
          <p>{{ t('properties.loadingAudioData')}}</p>
        </div>
      </div>

      <div
        v-if="activeTab === 'playback' && selectedItem.type === 'audio' && selectedItems.size === 1"
        id="properties-transport-host"
        class="properties-playback-info"
      ></div>
      
      <!-- Output Tab -->
      <div v-if="activeTab === 'output' && selectedItem.type === 'audio'" class="tab-panel">
        <div class="property-field">
          <label>{{ t('properties.deviceOverride') }}</label>
          <select
            :value="(audioItem as any).deviceOverride ?? ''"
            @change="onDeviceOverrideChange"
          >
            <option value="">{{ t('settings.useProjectDefault') }}</option>
            <option
              v-for="d in devicesList"
              :key="d.id"
              :value="d.id"
            >
              {{ d.display_name }}{{ d.is_default ? ' (' + t('common.default') + ')' : '' }}
            </option>
          </select>
          <p class="property-help">{{ t('properties.deviceOverrideHelp') }}</p>
        </div>

        <!-- LTC Output Section -->
        <div class="property-field" :class="{ 'field-disabled': !ltcDeviceConfigured }">
          <label class="ltc-checkbox-label">
            <input
              type="checkbox"
              :checked="(audioItem.ltcEnabled ?? false) && ltcDeviceConfigured"
              :disabled="!ltcDeviceConfigured"
              @change="onLtcEnabledChange"
            />
            {{ t('properties.ltcOutputTimecode') }}
          </label>
          <p class="property-help">
            {{ ltcDeviceConfigured
                ? t('properties.ltcOutputTimecodeHelp')
                : (t('properties.ltcRequiresDevice') || 'Select an LTC output device in Project Settings to enable timecode output.') }}
          </p>
        </div>

        <div class="property-field" :class="{ 'field-disabled': !(audioItem.ltcEnabled ?? false) }">
          <label>{{ t('properties.ltcStartTimecode') }}</label>
          <input
            type="text"
            :value="audioItem.ltcStartTimecode ?? '00:00:00:00'"
            :disabled="!(audioItem.ltcEnabled ?? false)"
            :class="{ invalid: !ltcTimecodeValid }"
            placeholder="HH:MM:SS:FF"
            maxlength="11"
            @change="onLtcTimecodeChange"
          />
          <p v-if="!ltcTimecodeValid" class="property-help property-help--error">
            {{ t('properties.ltcTimecodeFormat') }}
          </p>
        </div>

        <div class="property-field" :class="{ 'field-disabled': !(audioItem.ltcEnabled ?? false) }">
          <label>{{ t('properties.ltcFrameRate') }}</label>
          <select
            :value="audioItem.ltcFrameRate ?? 4"
            :disabled="!(audioItem.ltcEnabled ?? false)"
            @change="onLtcFrameRateChange"
          >
            <option v-for="opt in ltcFrameRateOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </div>
      </div>

      <div
        v-if="activeTab === 'basic' && selectedItem.type === 'audio'"
        class="tab-panel playback-behavior playback-behavior--ducking"
      >
        <div class="property-field">
          <label>{{ t('properties.ducking') }}</label>
          <select v-model="audioItem.duckingBehavior.mode" @change="handleSave">
            <option value="stop-all">{{ t('duckingBehavior.stopAll') }}</option>
            <option value="no-ducking">{{ t('duckingBehavior.noDucking') }}</option>
            <option value="duck-others">{{ t('duckingBehavior.duckOthers') }}</option>
          </select>
        </div>
        
        <div class="property-field" v-if="audioItem.duckingBehavior.mode === 'duck-others'">
          <label>{{ t('properties.duckLevel') }} ({{ duckLevelDB.toFixed(1) }} dB)</label>
          <input 
            v-model.number="duckLevelDB" 
            type="range" 
            class="app-range"
            min="-60" 
            max="0" 
            step="0.5"
            @change="handleSave"
          />
          <div class="db-range-labels">
            <span>-60 dB</span>
            <span>0 dB</span>
          </div>
        </div>
      </div>
      
      <div
        v-if="(activeTab === 'basic' && selectedItem.type === 'audio') || (activeTab === 'startBehavior' && selectedItem.type === 'group')"
        class="tab-panel playback-behavior playback-behavior--start"
      >
        <div class="property-field">
          <label>{{ selectedItem.type === 'audio' ? t('properties.startBehavior') : t('properties.action') }}</label>
          <select v-model="startBehaviorAction" @change="handleSave">
            <option v-if="selectedItem.type === 'audio'" value="nothing">{{ t('startBehavior.nothing') }}</option>
            <option v-if="selectedItem.type === 'audio'" value="play-next">{{ t('startBehavior.playNext') }}</option>
            <option v-if="selectedItem.type === 'audio'" value="play-item">{{ t('startBehavior.playItem') }}</option>
            <option v-if="selectedItem.type === 'audio'" value="play-index">{{ t('startBehavior.playIndex') }}</option>
            <option v-if="selectedItem.type === 'group'" value="play-first">{{ t('startBehavior.playFirst') }}</option>
            <option v-if="selectedItem.type === 'group'" value="play-all">{{ t('startBehavior.playAll') }}</option>
          </select>
        </div>
        
        <div class="property-field" v-if="startBehaviorAction === 'play-item'">
          <label>{{ t('properties.targetUuid') }}</label>
          <input 
            v-model="startBehaviorTargetUuid"
            type="text"
            @change="handleSave"
          />
        </div>
        
        <div class="property-field" v-if="startBehaviorAction === 'play-index'">
          <label>{{ t('properties.targetIndex') }}</label>
          <input 
            :value="formatItemIndex(startBehaviorTargetIndex)"
            @change="handleStartBehaviorIndexChange"
            type="text"
          />
        </div>
      </div>

      <div
        v-if="(activeTab === 'basic' && selectedItem.type === 'audio') || (activeTab === 'endBehavior' && selectedItem.type === 'group')"
        class="tab-panel playback-behavior playback-behavior--end"
      >
        <div class="property-field">
          <label>{{ selectedItem.type === 'audio' ? t('properties.endBehavior') : t('properties.action') }}</label>
          <select v-model="endBehaviorAction" @change="handleSave">
            <option value="nothing">{{ t('endBehavior.nothing') }}</option>
            <option value="next">{{ t('endBehavior.next') }}</option>
            <option value="goto-item">{{ t('endBehavior.gotoItem') }}</option>
            <option value="goto-index">{{ t('endBehavior.gotoIndex') }}</option>
            <option v-if="selectedItem.type === 'audio'" value="loop">{{ t('endBehavior.loop') }}</option>
          </select>
        </div>
        
        <div class="property-field" v-if="endBehaviorAction === 'goto-item'">
          <label>{{ t('properties.targetUuid') }}</label>
          <input 
            v-model="endBehaviorTargetUuid"
            type="text"
            @change="handleSave"
          />
        </div>
        
        <div class="property-field" v-if="endBehaviorAction === 'goto-index'">
          <label>{{ t('properties.targetIndex') }}</label>
          <input 
            :value="formatItemIndex(endBehaviorTargetIndex)"
            @change="handleEndBehaviorIndexChange"
            type="text"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { AudioItem, GroupItem } from '~/types/project';
import { PRESET_COLORS } from '~/types/project';
import {
  applyLoudnessMatch,
  applyTruePeakNormalization,
  buildWaveformFromChannels,
  trimSilence,
  type MeasuredLoudness,
} from '~/utils/audio';
import {
  isOneShot,
  markAsOneShot,
  nextOneShotOrder,
  removeOneShotDesignation,
} from '~/utils/oneShots';
import { useOutputTarget } from '~/composables/useOutputTarget';

const {
  selectedItem,
  selectedItems,
  propertiesPanelOpen,
  getSelectedItems,
  saveProject,
  currentProject,
  beginItemBatch,
  endItemBatch,
  formatItemIndex,
  parseItemIndexInput,
} = useProject();
const { t } = useLocalization();
const { uiMode } = useUiMode();
const { levels: outputTargetLevels } = useOutputTarget();
const panelHeight = useState<number>('PropertiesPanel.height', () => 320);

const clampPanelHeight = (height: number) => Math.max(
  240,
  Math.min(import.meta.client ? window.innerHeight - 180 : 640, height),
);

const startPanelResize = (event: PointerEvent) => {
  if (event.button !== 0 || !event.isPrimary) return;
  const handle = event.currentTarget as HTMLElement;
  const startY = event.clientY;
  const startHeight = panelHeight.value;
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  const move = (moveEvent: PointerEvent) => {
    panelHeight.value = clampPanelHeight(startHeight + startY - moveEvent.clientY);
  };
  const finish = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', finish);
    handle.removeEventListener('pointercancel', finish);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
};

const handlePanelResizeKey = (event: KeyboardEvent) => {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  panelHeight.value = clampPanelHeight(
    panelHeight.value + (event.key === 'ArrowUp' ? 16 : -16),
  );
};

const audioItem = computed(() => selectedItem.value as AudioItem);
const selectedAudioItems = computed(() => getSelectedItems().filter(
  (item): item is AudioItem => item.type === 'audio',
));
const hasSelectedAudioItems = computed(() => selectedAudioItems.value.length > 0);
const oneShotEnabled = computed(() => selectedAudioItems.value.length > 0
  && selectedAudioItems.value.every(isOneShot));

const handleOneShotDesignationChange = (event: Event) => {
  if (!currentProject.value) return;
  const enabled = (event.target as HTMLInputElement).checked;
  let order = nextOneShotOrder(currentProject.value.items);
  selectedAudioItems.value.forEach((item) => {
    if (enabled && !isOneShot(item)) markAsOneShot(item, order++);
    if (!enabled) removeOneShotDesignation(item);
  });
  void handleSave();
};

// LTC output is only meaningful when a project-wide LTC device is configured.
// The checkbox stays disabled until then to prevent users from "enabling"
// timecode that has nowhere to go (which is the most common LTC-silent
// support report we get).
const ltcDeviceConfigured = computed(() => {
  const dev = (currentProject.value as any)?.settings?.ltcDevice;
  return typeof dev === 'string' && dev.length > 0;
});

// Available output devices (for the per-item Output tab). Pulled from the
// shared server state — populated once on connect.
const _server = useLiveplayServer();
const devicesList = computed(() => _server.devices ?? []);

// API endpoint that triggers playback of the selected item. Points at the
// audio server's transport route (routed through ProjectState so ducking,
// in-point, and fades are honoured) — not the client's local trigger proxy.
const apiTriggerUrl = computed(() => {
  const base = (_server.serverUrl ?? 'http://127.0.0.1:4480').replace(/\/+$/, '');
  return `${base}/api/project/items/${selectedItem.value?.uuid}/play`;
});
const onDeviceOverrideChange = (e: Event) => {
  const v = (e.target as HTMLSelectElement).value;
  const it = audioItem.value as any;
  if (!v) {
    delete it.deviceOverride;
  } else {
    it.deviceOverride = v;
  }
  handleSave();
};

// LTC helpers
const SMPTE_RE = /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/;

const ltcTimecodeValid = computed(() => {
  const tc = audioItem.value?.ltcStartTimecode ?? '00:00:00:00';
  return SMPTE_RE.test(tc);
});

const ltcFrameRateOptions = [
  { value: 0, label: '24 fps' },
  { value: 1, label: '25 fps' },
  { value: 2, label: '29.97 fps NDF' },
  { value: 3, label: '29.97 fps DF' },
  { value: 4, label: '30 fps' },
];

const onLtcEnabledChange = (e: Event) => {
  audioItem.value.ltcEnabled = (e.target as HTMLInputElement).checked;
  if (audioItem.value.ltcEnabled && !audioItem.value.ltcStartTimecode) {
    audioItem.value.ltcStartTimecode = '00:00:00:00';
  }
  if (audioItem.value.ltcFrameRate === undefined) {
    audioItem.value.ltcFrameRate = 4;
  }
  handleSave();
};

const onLtcTimecodeChange = (e: Event) => {
  const raw = (e.target as HTMLInputElement).value.trim();
  // Normalise: replace semicolon separator (DF convention) with colon for storage.
  const normalised = raw.replace(/;(\d{2})$/, ':$1');
  if (SMPTE_RE.test(normalised)) {
    audioItem.value.ltcStartTimecode = normalised;
    handleSave();
  } else {
    // Reset the input to the last valid value.
    (e.target as HTMLInputElement).value = audioItem.value.ltcStartTimecode ?? '00:00:00:00';
  }
};

const onLtcFrameRateChange = (e: Event) => {
  audioItem.value.ltcFrameRate = parseInt((e.target as HTMLSelectElement).value, 10);
  handleSave();
};
const groupItem = computed(() => selectedItem.value as GroupItem);

// Check if selected item is a cart item
const isCartItem = computed(() => {
  if (selectedItem.value && selectedItem.value.type === 'audio') {
    const item = selectedItem.value as AudioItem;
    return item.index && item.index.length > 0 && item.index[0] === -1;
  }
  return false;
});

// Tab management
const activeTab = ref(uiMode.value === 'playback' && selectedItem.value?.type === 'audio'
  ? 'playback'
  : 'basic');

interface Tab {
  id: string;
  label: string;
  icon: string;
  audioOnly?: boolean;
  groupOnly?: boolean;
}

const allTabs = computed<Tab[]>(() => [
  { id: 'basic', label: t('properties.basicInfo'), icon: 'info' },
  { id: 'playback', label: t('properties.playback'), icon: 'play_circle', audioOnly: true },
  { id: 'output', label: t('properties.output'), icon: 'speaker', audioOnly: true },
  { id: 'startBehavior', label: t('properties.startBehavior'), icon: 'play_arrow', groupOnly: true },
  { id: 'endBehavior', label: t('properties.endBehavior'), icon: 'stop_circle', groupOnly: true }
]);

const availableTabs = computed(() => {
  return allTabs.value.filter(tab => {
    if (tab.audioOnly) return selectedItem.value?.type === 'audio';
    if (tab.groupOnly) return selectedItem.value?.type === 'group';
    return true;
  });
});

// Computed properties for behavior fields
const endBehaviorAction = computed({
  get: () => {
    if (selectedItem.value?.type === 'audio') {
      return audioItem.value.endBehavior.action;
    } else if (selectedItem.value?.type === 'group') {
      return groupItem.value.endBehavior.action;
    }
    return 'nothing';
  },
  set: (value) => {
    if (selectedItem.value?.type === 'audio') {
      audioItem.value.endBehavior.action = value as any;
    } else if (selectedItem.value?.type === 'group') {
      groupItem.value.endBehavior.action = value as any;
    }
  }
});

const endBehaviorTargetUuid = computed({
  get: () => {
    if (selectedItem.value?.type === 'audio') {
      return audioItem.value.endBehavior.targetUuid || '';
    } else if (selectedItem.value?.type === 'group') {
      return groupItem.value.endBehavior.targetUuid || '';
    }
    return '';
  },
  set: (value) => {
    if (selectedItem.value?.type === 'audio') {
      audioItem.value.endBehavior.targetUuid = value;
    } else if (selectedItem.value?.type === 'group') {
      groupItem.value.endBehavior.targetUuid = value;
    }
  }
});

const endBehaviorTargetIndex = computed(() => {
  if (selectedItem.value?.type === 'audio') {
    return audioItem.value.endBehavior.targetIndex;
  } else if (selectedItem.value?.type === 'group') {
    return groupItem.value.endBehavior.targetIndex;
  }
  return undefined;
});

const handleEndBehaviorIndexChange = (e: Event) => {
  const input = e.target as HTMLInputElement;
  const parsed = parseItemIndexInput(input.value);
  // Reflect the normalised path back into the field so the user sees the
  // canonical comma form (e.g. typing "1.10" shows "1,10").
  input.value = formatItemIndex(parsed);
  if (selectedItem.value?.type === 'audio') {
    if (parsed.length > 0) audioItem.value.endBehavior.targetIndex = parsed;
    else delete audioItem.value.endBehavior.targetIndex;
  } else if (selectedItem.value?.type === 'group') {
    if (parsed.length > 0) groupItem.value.endBehavior.targetIndex = parsed;
    else delete groupItem.value.endBehavior.targetIndex;
  }
  handleSave();
};

const startBehaviorAction = computed({
  get: () => {
    if (selectedItem.value?.type === 'audio') {
      return audioItem.value.startBehavior.action;
    } else if (selectedItem.value?.type === 'group') {
      return groupItem.value.startBehavior.action;
    }
    return 'nothing';
  },
  set: (value) => {
    if (selectedItem.value?.type === 'audio') {
      audioItem.value.startBehavior.action = value as any;
    } else if (selectedItem.value?.type === 'group') {
      groupItem.value.startBehavior.action = value as any;
    }
  }
});

const startBehaviorTargetUuid = computed({
  get: () => {
    if (selectedItem.value?.type === 'audio') {
      return audioItem.value.startBehavior.targetUuid || '';
    }
    return '';
  },
  set: (value) => {
    if (selectedItem.value?.type === 'audio') {
      audioItem.value.startBehavior.targetUuid = value;
    }
  }
});

const startBehaviorTargetIndex = computed(() => {
  if (selectedItem.value?.type === 'audio') {
    return audioItem.value.startBehavior.targetIndex;
  }
  return undefined;
});

const handleStartBehaviorIndexChange = (e: Event) => {
  const input = e.target as HTMLInputElement;
  const parsed = parseItemIndexInput(input.value);
  input.value = formatItemIndex(parsed);
  if (selectedItem.value?.type === 'audio') {
    if (parsed.length > 0) audioItem.value.startBehavior.targetIndex = parsed;
    else delete audioItem.value.startBehavior.targetIndex;
  }
  handleSave();
};

// Duck level in dB
const duckLevelDB = computed({
  get: () => {
    const linear = audioItem.value.duckingBehavior.duckLevel;
    if (linear <= 0) return -60;
    return 20 * Math.log10(linear);
  },
  set: (db: number) => {
    const linear = db <= -60 ? 0 : Math.pow(10, db / 20);
    audioItem.value.duckingBehavior.duckLevel = linear;
  }
});

// Store a snapshot of the original values when properties panel opens
const originalSnapshot = ref<any>(null);
const isInitializing = ref(false);

// When selectedItem changes, take a snapshot
watch(selectedItem, (newItem, oldItem) => {
  if (newItem) {
    // Only reset tab if it's a different item (not just property updates)
    const isDifferentItem = !oldItem || newItem.uuid !== oldItem.uuid;
    
    if (isDifferentItem) {
      isInitializing.value = true;
      originalSnapshot.value = JSON.parse(JSON.stringify(newItem));
      
      // Keep the current section when possible; fall back when the new item
      // does not support it (for example, Playback on a group).
      if (!oldItem || !availableTabs.value.some(tab => tab.id === activeTab.value)) {
        activeTab.value = 'basic';
      }
      
      setTimeout(() => {
        isInitializing.value = false;
      }, 0);
    }
  } else {
    originalSnapshot.value = null;
  }
}, { immediate: true });

const handleClose = () => {
  // Close the panel but leave the current selection intact so the highlighted
  // rows stay highlighted. Only the panel's visibility is toggled here.
  propertiesPanelOpen.value = false;
  originalSnapshot.value = null;
};

const handleSave = async () => {
  // End any active drag batch so stale intermediate values are never
  // PATCHed to the server and echoed back as item_updated reversions.
  endItemBatch();
  // If multiple items are selected, update all of them with ONLY changed properties
  const items = getSelectedItems();
  if (items.length > 1 && originalSnapshot.value && selectedItem.value) {
    const current = selectedItem.value;
    const original = originalSnapshot.value;
    
    items.forEach(item => {
      // Only update properties that have changed
      if (current.displayName !== original.displayName) {
        item.displayName = current.displayName;
      }
      if (current.color !== original.color) {
        item.color = current.color;
      }
      
      // Copy type-specific properties only if they changed
      if (item.type === 'audio' && current.type === 'audio') {
        const sourceAudio = current as AudioItem;
        const originalAudio = original as AudioItem;
        const targetAudio = item as AudioItem;
        
        if (sourceAudio.volume !== originalAudio.volume) {
          targetAudio.volume = sourceAudio.volume;
        }
        if (sourceAudio.inPoint !== originalAudio.inPoint) {
          targetAudio.inPoint = sourceAudio.inPoint;
        }
        if (sourceAudio.outPoint !== originalAudio.outPoint) {
          targetAudio.outPoint = sourceAudio.outPoint;
        }
        if (JSON.stringify(sourceAudio.duckingBehavior) !== JSON.stringify(originalAudio.duckingBehavior)) {
          targetAudio.duckingBehavior = { ...sourceAudio.duckingBehavior };
        }
        if (JSON.stringify(sourceAudio.endBehavior) !== JSON.stringify(originalAudio.endBehavior)) {
          targetAudio.endBehavior = { ...sourceAudio.endBehavior };
        }
        if (JSON.stringify(sourceAudio.startBehavior) !== JSON.stringify(originalAudio.startBehavior)) {
          targetAudio.startBehavior = { ...sourceAudio.startBehavior };
        }
      } else if (item.type === 'group' && current.type === 'group') {
        const sourceGroup = current as GroupItem;
        const originalGroup = original as GroupItem;
        const targetGroup = item as GroupItem;
        
        if (JSON.stringify(sourceGroup.startBehavior) !== JSON.stringify(originalGroup.startBehavior)) {
          targetGroup.startBehavior = { ...sourceGroup.startBehavior };
        }
        if (JSON.stringify(sourceGroup.endBehavior) !== JSON.stringify(originalGroup.endBehavior)) {
          targetGroup.endBehavior = { ...sourceGroup.endBehavior };
        }
      }
    });
    
  }

  // Always refresh the diff baseline to the primary item's current state —
  // for single AND multi selection. This is what prevents an earlier edit
  // (e.g. a colour change made while only one item was selected) from later
  // leaking onto the rest of a multi-selection: every save resets the
  // baseline so the next diff only ever reflects the property just touched.
  if (selectedItem.value) {
    originalSnapshot.value = JSON.parse(JSON.stringify(selectedItem.value));
  }

  await saveProject();
};

const handleCycleSelectedColors = async () => {
  const items = getSelectedItems().filter(
    (item): item is AudioItem => item.type === 'audio',
  );
  if (items.length === 0) return;

  const currentIndex = PRESET_COLORS.indexOf(items[0]!.color.toUpperCase());
  const startIndex = (currentIndex + 1) % PRESET_COLORS.length;
  items.forEach((item, index) => {
    item.color = PRESET_COLORS[(startIndex + index) % PRESET_COLORS.length]!;
  });

  if (selectedItem.value) {
    originalSnapshot.value = JSON.parse(JSON.stringify(selectedItem.value));
  }
  await saveProject();
};

// Handle normalize: normalize ALL selected audio items individually
const handleNormalize = async (
  mode: 'loudness' | 'truePeak',
  normalizeTarget: number,
) => {
  let items = getSelectedItems();
  
  // Fallback to selectedItem if no items in selectedItems set (shouldn't happen now, but safe)
  if (items.length === 0 && selectedItem.value) {
    items = [selectedItem.value];
  }
  
  const limiterCeilingDb = outputTargetLevels.value.limiterCeilingDb;
  const effectiveTarget = Math.max(-60, Math.min(
    mode === 'truePeak' ? limiterCeilingDb : 0,
    normalizeTarget,
  ));
  if (!Number.isFinite(effectiveTarget)) return;
  
  let normalizedCount = 0;
  
  for (const item of items) {
    if (item.type !== 'audio') continue;
    
    const audioItem = item as AudioItem;
    
    const duration = Math.max(0, audioItem.duration || audioItem.waveform?.duration || 0);
    const inPoint = Math.max(0, audioItem.inPoint || 0);
    const outPoint = audioItem.outPoint > 0 ? audioItem.outPoint : duration;
    const isFullFile = inPoint <= 0.001 &&
      (duration <= 0 || outPoint >= duration - 0.001);
    let analysis: MeasuredLoudness | undefined = audioItem.waveform;

    if (!isFullFile || analysis?.analysis_version !== 1) {
      const folder = currentProject.value?.folderPath || '';
      const relativePath = audioItem.mediaPath?.replace(/^[\\/]+/, '') || '';
      const mediaPath = audioItem.mediaServerPath ||
        (folder && relativePath
          ? `${folder.replace(/[\\/]+$/, '')}/${relativePath}`
          : '');
      if (!mediaPath) {
        console.warn(`Skipping ${audioItem.displayName}: media path unavailable`);
        continue;
      }
      try {
        analysis = await _server.fetchWaveformByPath(
          mediaPath,
          1000,
          isFullFile ? undefined : {
            startMs: inPoint * 1000,
            endMs: outPoint * 1000,
          },
        );
      } catch (error) {
        console.warn(`Skipping ${audioItem.displayName}: analysis failed`, error);
        continue;
      }
    }

    const changed = mode === 'truePeak'
      ? applyTruePeakNormalization(audioItem, analysis, effectiveTarget)
      : applyLoudnessMatch(
          audioItem,
          analysis,
          effectiveTarget,
          limiterCeilingDb,
        );
    if (changed) {
      normalizedCount++;
    }
  }
  
  if (normalizedCount > 0) {
    await saveProject();
    console.log(`Normalized ${normalizedCount} item(s) to ${
      effectiveTarget.toFixed(1)
    } ${mode === 'truePeak' ? 'dBTP' : 'LUFS'}`);
  }
};

// Handle trim silence: trim ALL selected audio items individually
const handleTrimSilence = async () => {
  let items = getSelectedItems();
  
  // Fallback to selectedItem if no items in selectedItems set (shouldn't happen now, but safe)
  if (items.length === 0 && selectedItem.value) {
    items = [selectedItem.value];
  }
  
  let trimmedCount = 0;
  items.forEach(item => {
    if (item.type === 'audio' && trimSilence(item as AudioItem)) trimmedCount++;
  });

  if (trimmedCount > 0) {
    if (selectedItem.value) originalSnapshot.value = structuredClone(selectedItem.value);
    await saveProject();
    console.log(`Trimmed ${trimmedCount} item(s)`);
  }
};

// Handle fade updates: apply to ALL selected audio items
const handlePlayFadeUpdate = (value: number) => {
  const items = getSelectedItems();
  items.forEach(item => {
    if (item.type === 'audio') {
      (item as AudioItem).playFade = value;
    }
  });
};

const handleStopFadeUpdate = (value: number) => {
  const items = getSelectedItems();
  items.forEach(item => {
    if (item.type === 'audio') {
      (item as AudioItem).stopFade = value;
    }
  });
};

const handleCrossFadeUpdate = (value: number) => {
  const items = getSelectedItems();
  items.forEach(item => {
    if (item.type === 'audio') {
      (item as AudioItem).crossFade = value;
    }
  });
};

const handleStartNextEnabledUpdate = (value: boolean) => {
  const items = getSelectedItems();
  items.forEach(item => {
    if (item.type === 'audio') {
      (item as AudioItem).startNextEnabled = value;
    }
  });
};

const handleStartNextTimeUpdate = (value: number) => {
  const items = getSelectedItems();
  items.forEach(item => {
    if (item.type === 'audio') {
      (item as AudioItem).startNextTime = value;
    }
  });
};

const handleStartNextFadeOutUpdate = (value: boolean) => {
  const items = getSelectedItems();
  items.forEach(item => {
    if (item.type === 'audio') {
      (item as AudioItem).startNextFadeOut = value;
    }
  });
};

const isRegenerating = ref(false);
const isReplacingMedia = ref(false);
const replaceMediaStatus = ref('');
const replaceMediaError = ref(false);
watch(() => selectedItem.value?.uuid, () => {
  if (!isReplacingMedia.value) replaceMediaStatus.value = '';
});

const handleRegenerateWaveform = async () => {
  if (isRegenerating.value) return;

  let items = getSelectedItems().filter(i => i.type === 'audio') as AudioItem[];
  if (items.length === 0 && selectedItem.value?.type === 'audio') {
    items = [selectedItem.value as AudioItem];
  }
  if (items.length === 0) return;

  isRegenerating.value = true;
  try {
    const folder = currentProject.value?.folderPath || '';
    for (const item of items) {
      let path = item.mediaServerPath || '';
      if (!path && item.mediaPath && folder) {
        const rel = item.mediaPath.replace(/^[\\/]+/, '');
        path = `${folder.replace(/[\\/]+$/, '')}/${rel}`;
      }
      if (!path) continue;
      item.waveform = undefined;
      await _server.requestWaveformGeneration(path, item.uuid, true).catch((e: Error) => {
        console.warn(`[waveform] regeneration failed for ${item.displayName}:`, e);
      });
    }
  } finally {
    isRegenerating.value = false;
  }
};

const handleReplaceMedia = async () => {
  if (!import.meta.client || !window.electronAPI || isReplacingMedia.value) return;

  const files = await window.electronAPI.selectAudioFiles();
  const sourcePath = files?.[0];
  const item = audioItem.value;
  if (!sourcePath || !item) return;

  const snapshot = structuredClone(item);
  let mutated = false;
  isReplacingMedia.value = true;
  replaceMediaError.value = false;
  replaceMediaStatus.value = t('properties.verifyingReplacement');
  try {
    const [metadata, serverWaveform] = await Promise.all([
      _server.fetchMetadata(sourcePath),
      _server.fetchWaveformByPath(sourcePath),
    ]);
    const metadataDuration = Number((metadata as any)?.duration_ms);
    const durationMs = Number.isFinite(metadataDuration) && metadataDuration > 0
      ? metadataDuration
      : Number(serverWaveform.duration_ms);
    const duration = durationMs / 1000;
    const waveform = buildWaveformFromChannels(serverWaveform.channels, duration, serverWaveform);
    if ((metadata as any)?.valid !== true || !Number.isFinite(duration) || duration <= 0 || !waveform) {
      throw new Error(t('properties.replacementDecodeFailed'));
    }

    const linked = !snapshot.mediaPath;
    const mediaServerPath = linked ? sourcePath : await _server.copyToMedia(sourcePath);
    const fileName = mediaServerPath.split(/[\\/]/).pop() || sourcePath.split(/[\\/]/).pop() || 'audio';
    const usedWholeFile = snapshot.inPoint <= 0 && Math.abs(snapshot.outPoint - snapshot.duration) < 0.01;

    mutated = true;
    item.mediaFileName = fileName;
    item.mediaServerPath = mediaServerPath;
    item.mediaPath = linked ? '' : `media/${fileName}`;
    item.waveform = waveform;
    item.duration = duration;
    item.inPoint = usedWholeFile ? 0 : Math.min(snapshot.inPoint, Math.max(0, duration - 0.01));
    item.outPoint = usedWholeFile ? duration : Math.min(duration, Math.max(item.inPoint + Math.min(0.01, duration), Math.min(snapshot.outPoint, duration)));
    if (typeof item.startNextTime === 'number') {
      item.startNextTime = Math.max(item.inPoint, Math.min(item.startNextTime, item.outPoint));
    }

    if (!await saveProject()) throw new Error(t('properties.replacementSaveFailed'));
    originalSnapshot.value = structuredClone(item);
    replaceMediaStatus.value = t('properties.replacementComplete');
    void _server.requestWaveformGeneration(mediaServerPath, item.uuid, true).catch(() => {});
  } catch (error: any) {
    Object.assign(item, snapshot);
    if (mutated) await saveProject();
    replaceMediaError.value = true;
    replaceMediaStatus.value = error?.message || t('properties.replacementFailed');
  } finally {
    isReplacingMedia.value = false;
  }
};

const copyToClipboard = async (text: string) => {
  if (import.meta.client) {
    try {
      await navigator.clipboard.writeText(text);
      // Could show a toast notification here
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  }
};

const formatTime = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};
</script>

<style scoped>
.properties-panel {
  position: relative;
  flex: 0 0 auto;
  border-top: 1px solid var(--color-border);
  background-color: var(--color-background);
  display: flex;
  flex-direction: column;
  box-shadow: inset 0 1px color-mix(in srgb, var(--color-text-primary) 4%, transparent);
}

.properties-resize-handle {
  position: absolute;
  z-index: 2;
  top: -4px;
  right: 0;
  left: 0;
  height: 8px;
  cursor: ns-resize;
  touch-action: none;
}

.properties-resize-handle::after {
  content: '';
  position: absolute;
  top: 3px;
  right: 45%;
  left: 45%;
  height: 2px;
  border-radius: 1px;
  background: var(--color-border-strong);
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.properties-resize-handle:hover::after,
.properties-resize-handle:focus-visible::after {
  opacity: 1;
}

.properties-resize-handle:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: -2px;
}

.properties-header {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto var(--panel-control-height);
  justify-content: stretch;
  gap: var(--spacing-sm);
}

.properties-header .workspace-panel-header__title {
  max-width: none;
}

.close-btn {
  width: var(--panel-control-height);
  height: var(--panel-control-height);
  padding: 0;
  border-radius: var(--border-radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text);
  
  &:hover {
    background-color: var(--color-surface-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--color-focus-ring);
    outline-offset: 1px;
  }
  
  .material-symbols-rounded {
    font-size: 20px;
    color: var(--color-text);
  }
}

/* Tab Navigation */
.properties-tabs {
  display: flex;
  align-self: stretch;
  justify-self: start;
  min-width: 0;
  gap: 2px;
  padding: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.tab-btn {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex: 0 0 auto;
  height: 100%;
  padding: 0 var(--spacing-sm);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  transition:
    color var(--transition-fast),
    background-color var(--transition-fast),
    border-color var(--transition-fast);
  
  .material-symbols-rounded {
    font-size: 18px;
    color: inherit;
  }
  
  &:hover {
    color: var(--color-text-primary);
    background-color: var(--color-surface-hover);
  }
  
  &.active {
    color: var(--color-accent);
    background-color: var(--color-accent-soft);
    border-bottom-color: var(--color-accent);
  }
}

/* Tab Content */
.properties-content {
  flex: 1;
  overflow-x: hidden;
  overflow-y: auto;
  padding: var(--spacing-md);
  min-height: 0;
}

.properties-content:has(.playback-panel) {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(188px, 1fr);
  gap: var(--spacing-sm);
  overflow-y: hidden;
}

.properties-content:has(.basic-panel) {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--spacing-md);
  align-content: start;
}

.tab-panel {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--spacing-md);
  align-content: flex-start;
  min-height: min-content;
  width: 100%;
}

.playback-panel {
  display: block;
  grid-column: 1 / -1;
  grid-row: 1;
  height: auto;
  min-height: 188px;
  container-type: inline-size;
}

.properties-playback-info {
  display: flex;
  grid-column: 1 / -1;
  grid-row: 2;
  align-items: center;
  min-width: 0;
  padding-top: var(--spacing-xs);
  border-top: 1px solid var(--color-border);
}

.basic-panel {
  grid-column: 1 / -1;
}

.properties-content:has(.basic-panel) .playback-behavior {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  flex-wrap: nowrap;
  align-items: stretch;
  gap: var(--spacing-xs);
  padding-top: var(--spacing-xs);
  border-top: 1px solid var(--color-border);
}

.properties-content:has(.basic-panel) .playback-behavior--ducking {
  grid-column: 1;
}

.properties-content:has(.basic-panel) .playback-behavior--start {
  grid-column: 2;
}

.properties-content:has(.basic-panel) .playback-behavior--end {
  grid-column: 3;
}

.properties-content:has(.basic-panel) .playback-behavior .property-field {
  display: grid;
  grid-template-columns: minmax(88px, max-content) minmax(120px, 1fr);
  align-items: center;
  justify-content: stretch;
  flex: 0 0 auto;
  min-width: 0;
  gap: var(--spacing-sm);
}

.properties-content:has(.basic-panel) .playback-behavior label {
  color: var(--color-text-primary);
  font-weight: 600;
  white-space: nowrap;
}

.properties-content:has(.basic-panel) .playback-behavior select {
  justify-self: start;
  width: auto;
  max-width: 100%;
}

.properties-content:has(.basic-panel) .playback-behavior input:not([type='range']) {
  width: 100%;
}

.properties-content:has(.basic-panel) .playback-behavior .db-range-labels {
  grid-column: 2;
  margin-top: 0;
  font-size: 12px;
  line-height: 1;
}

.property-field {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  min-width: 0;
  width: 100%;
  color: var(--color-text-secondary);
}

.property-field label {
  color: var(--color-text-primary);
  font-size: var(--type-metadata-size);
  font-weight: 600;
}

.one-shot-designation {
  padding: var(--spacing-sm) var(--spacing-md);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background: var(--color-control);
}

.one-shot-designation__toggle {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  cursor: pointer;
}

.one-shot-designation__toggle input[type="checkbox"] {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  accent-color: var(--color-accent);
}

.property-field input,
.property-field select {
  width: 100%;
  padding: var(--spacing-sm);
  background-color: var(--color-control);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  color: var(--color-text);
  min-height: var(--panel-control-height);
  font-size: var(--type-metadata-size);
  
  &:focus {
    outline: none;
    border-color: var(--color-accent);
    box-shadow: 0 0 0 2px var(--color-focus-ring);
  }
  
  &[readonly] {
    color: var(--color-text-secondary);
    cursor: default;
  }
}

.input-with-btn {
  display: flex;
  gap: var(--spacing-xs);
  
  input {
    flex: 1;
  }
}

.icon-btn {
  width: var(--panel-control-height);
  min-width: var(--panel-control-height);
  height: var(--panel-control-height);
  padding: 0;
  background: var(--color-control);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  cursor: pointer;
  color: var(--color-text);
  display: flex;
  align-items: center;
  justify-content: center;

  &:hover:not(:disabled) {
    background-color: var(--color-accent-soft);
    border-color: color-mix(in srgb, var(--color-accent) 52%, var(--color-border));
    color: var(--color-text-primary);
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .material-symbols-rounded {
    font-size: 18px;
    color: inherit;
  }
}

.regen-btn {
  width: max-content;
  min-width: 0;
  gap: var(--spacing-xs);
  font-size: var(--type-metadata-size);
  padding: var(--spacing-sm) var(--spacing-md);

  .spinning {
    animation: spin 1s linear infinite;
  }
}

.color-picker {
  display: grid;
  grid-template-columns: repeat(8, 28px);
  gap: var(--spacing-xs);
}

.color-btn {
  width: 28px;
  height: 28px;
  aspect-ratio: 1;
  border-radius: var(--border-radius-sm);
  border: 2px solid transparent;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  
  &:hover {
    border-color: var(--color-border-strong);
  }
  
  &.active {
    border-color: var(--color-text-primary);
    box-shadow: 0 0 0 2px var(--color-background);
  }
}

.uuid-field,
.file-field {
  display: flex;
  gap: var(--spacing-xs);
}

.uuid-field input,
.file-field input {
  flex: 1;
  min-width: 0;
}

.copy-btn,
.action-btn-small {
  min-height: var(--panel-control-height);
  padding: 0 var(--spacing-md);
  background-color: var(--color-control);
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-sm);
  white-space: nowrap;
  
  &:hover {
    background-color: var(--color-surface-hover);
    border-color: var(--color-accent);
  }
}

.db-range-labels {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--color-text-secondary);
  margin-top: 4px;
}

.ltc-checkbox-label {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;

  input[type="checkbox"] {
    width: 16px;
    height: 16px;
    accent-color: var(--color-accent);
    cursor: pointer;
  }
}

.field-disabled {
  opacity: 0.62;
  pointer-events: none;
}

.property-field input.invalid {
  border-color: #e53e3e;

  &:focus {
    border-color: #e53e3e;
  }
}

.property-help {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin-top: 2px;
}

.property-help--error {
  color: var(--color-danger);
}

.loading-message {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-xl);
  color: var(--color-text-secondary);
}

.loading-message .material-symbols-rounded {
  font-size: 48px;
  animation: spin 2s linear infinite;
}

.loading-message p {
  font-size: 14px;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
