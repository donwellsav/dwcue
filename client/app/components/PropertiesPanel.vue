<template>
  <div class="properties-panel">
    <div class="properties-header workspace-panel-header">
      <h3 class="workspace-panel-header__title" :title="selectedItem?.displayName">{{ selectedItems.size > 1 ? t('properties.multipleItemsSelected', { count: selectedItems.size }) : (t('properties.title') + ': ' + (selectedItem?.displayName || '')) }}</h3>
      <div class="properties-tabs" :aria-label="t('properties.title')">
        <button
          v-for="tab in availableTabs"
          :key="tab.id"
          :class="['tab-btn', { active: activeTab === tab.id }]"
          :aria-pressed="activeTab === tab.id"
          @click="activeTab = tab.id"
        >
          <span class="material-symbols-rounded" aria-hidden="true">{{ tab.icon }}</span>
          <span>{{ tab.label }}</span>
        </button>
      </div>
      <button class="close-btn" :title="t('actions.close')" :aria-label="t('actions.close')" @click="handleClose">
        <span class="material-symbols-rounded">close</span>
      </button>
    </div>

    <div class="properties-content" :class="{ 'properties-content--audio': selectedItem.type === 'audio' }">
      <!-- Basic Info Tab -->
      <div v-if="activeTab === 'basic'" class="tab-panel basic-panel">
        <section class="property-column">
          <h4>{{ t('properties.basicInfo') }}</h4>
          <div class="property-field">
            <label for="cue-property-displayName">{{ t('properties.displayName') }}</label>
            <input id="cue-property-displayName"
              v-model="selectedItem.displayName"
              type="text"
              @change="handleSave"
            />
          </div>
          <div class="property-field">
            <label for="cue-property-index">{{ t('properties.index') }}</label>
            <input id="cue-property-index" :value="formatItemIndex(selectedItem.index)" readonly />
          </div>
          <div v-if="selectedItem.type === 'audio'" class="property-field">
            <label for="cue-property-duration">{{ t('properties.duration') }}</label>
            <input id="cue-property-duration" :value="formatTime(audioItem.duration)" readonly />
          </div>
          <div class="property-field">
            <span class="property-label">{{ t('properties.color') }}</span>
            <div class="color-picker">
              <button
                v-for="color in PRESET_COLORS"
                :key="color"
                class="color-btn"
                :style="{ backgroundColor: color }"
                :class="{ active: selectedItem.color === color }"
                :aria-pressed="selectedItem.color === color"
                :aria-label="`${t('properties.color')} ${color}`"
                @click="() => { selectedItem.color = color; handleSave(); }"
              ></button>
            </div>
          </div>
          <div v-if="hasSelectedAudioItems" class="property-field">
            <button
              type="button"
              class="action-btn-small color-cycle"
              @click="handleCycleSelectedColors"
            >
              {{ t('properties.cycleSelectedColors') }}
            </button>
          </div>
        </section>
        <section v-if="selectedItem.type === 'audio'" class="property-column">
          <h4>{{ t('properties.media') }}</h4>
          <div class="property-field">
            <label for="cue-property-file">{{ t('properties.file') }}</label>
            <div class="input-with-btn">
              <input id="cue-property-file" :value="audioItem.mediaFileName" readonly />
              <button class="icon-btn" :disabled="isReplacingMedia" :title="t('properties.replaceMedia')" @click="handleReplaceMedia">
                <span class="material-symbols-rounded">swap_horiz</span>
              </button>
            </div>
          </div>
          <div class="property-field">
            <label for="cue-property-cueImage">{{ t('properties.cueImage') }}</label>
            <div class="input-with-btn">
              <input id="cue-property-cueImage"
                :value="audioItem.imagePath || ''"
                readonly
                :placeholder="t('properties.cueImageNone')"
              />
              <button
                class="icon-btn"
                :title="t('properties.cueImageChoose')"
                @click="cueImagePickerOpen = true"
              >
                <span class="material-symbols-rounded">image</span>
              </button>
              <button
                v-if="audioItem.imagePath"
                class="icon-btn"
                :title="t('properties.cueImageClear')"
                @click="handleClearCueImage"
              >
                <span class="material-symbols-rounded">close</span>
              </button>
            </div>
          </div>
          <div class="property-field">
            <label for="cue-property-waveform">{{ t('properties.waveform') }}</label>
            <button id="cue-property-waveform" class="icon-btn regen-btn" :disabled="isRegenerating" @click="handleRegenerateWaveform">
              <span class="material-symbols-rounded" :class="{ spinning: isRegenerating }">refresh</span>
              <span>{{ isRegenerating ? t('properties.regeneratingWaveform') : t('properties.regenerateWaveform') }}</span>
            </button>
          </div>
          <p class="property-help">{{ t('properties.cueImageHelp') }}</p>
          <p v-if="replaceMediaStatus" class="property-help" :class="{ 'property-help--error': replaceMediaError }" role="status">
            {{ replaceMediaStatus }}
          </p>
        </section>
        <section class="property-column">
          <h4>{{ t('properties.identifiers') }}</h4>
          <div class="property-field">
            <label for="cue-property-uuid">{{ t('properties.uuid') }}</label>
            <div class="input-with-btn">
              <input id="cue-property-uuid" :value="selectedItem.uuid" readonly />
              <button class="icon-btn" :aria-label="t('properties.copyIdentifier', { name: t('properties.uuid') })" @click="copyToClipboard(selectedItem.uuid)">
                <span class="material-symbols-rounded">content_copy</span>
              </button>
            </div>
          </div>
          <div class="property-field" v-if="selectedItem.type === 'audio'">
            <label for="cue-property-apiTriggerUrl">{{ t('properties.apiTriggerUrl') }} · POST</label>
            <div class="input-with-btn">
              <input id="cue-property-apiTriggerUrl" :value="apiTriggerUrl" readonly />
              <button class="icon-btn" :aria-label="t('properties.copyIdentifier', { name: t('properties.apiTriggerUrl') })" @click="copyToClipboard(apiTriggerUrl)">
                <span class="material-symbols-rounded">content_copy</span>
              </button>
            </div>
          </div>
          <div v-if="hasSelectedAudioItems" class="property-field">
            <label class="one-shot-designation__toggle">
              <input
                type="checkbox"
                :checked="oneShotEnabled"
                @change="handleOneShotDesignationChange"
              />
              <span>{{ t('oneShots.designation') }}</span>
            </label>
          </div>
          <p v-if="hasSelectedAudioItems" class="property-help">{{ t('oneShots.designationHelp') }}</p>
        </section>
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
        <div
          v-if="propertySaveFailed"
          class="trim-save-feedback"
          role="alert"
        >
          <span class="material-symbols-rounded" aria-hidden="true">warning</span>
          <span>{{ t('project.unsavedChanges') }}</span>
          <button
            type="button"
            class="icon-btn regen-btn trim-save-retry"
            :disabled="propertySavePending"
            @click="retryPropertySave"
          >
            <span class="material-symbols-rounded" aria-hidden="true">
              {{ propertySavePending ? 'progress_activity' : 'save' }}
            </span>
            <span>{{ propertySavePending ? t('common.loading') : t('actions.saveTrim') }}</span>
          </button>
        </div>
      </div>

      <div
        v-if="activeTab === 'playback' && selectedItem.type === 'audio' && selectedItems.size === 1"
        id="properties-transport-host"
        class="properties-playback-info"
      ></div>

      <div v-if="activeTab === 'output' && selectedItem.type === 'audio'" class="tab-panel output-panel">
        <section class="property-column">
          <h4>{{ t('properties.output') }}</h4>
          <div class="property-field">
            <label for="cue-output-device">{{ t('properties.deviceOverride') }}</label>
            <select id="cue-output-device"
              :value="audioDeviceOverride"
              :disabled="deviceOverrideEditPending"
              @change="onDeviceOverrideChange"
            >
              <option value="">{{ t('settings.useProjectDefault') }}</option>
              <option
                v-for="d in devicesList"
                :key="d.id"
                :value="d.display_name"
              >
                {{ d.display_name }}{{ d.is_default ? ' (' + t('common.default') + ')' : '' }}
              </option>
            </select>
          </div>
          <p class="property-help">{{ t('properties.deviceOverrideHelp') }}</p>
        </section>
        <section class="property-column">
          <h4>{{ t('properties.timecode') }}</h4>
          <div class="property-field" :class="{ 'field-disabled': !ltcDeviceConfigured }">
            <label class="ltc-checkbox-label">
              <CueSymbol name="ltc" />
              <input
                type="checkbox"
                :checked="(audioItem.ltcEnabled ?? false) && ltcDeviceConfigured"
                :disabled="!ltcDeviceConfigured"
                @change="onLtcEnabledChange"
              />
              {{ t('properties.ltcOutputTimecode') }}
            </label>
          </div>
          <div class="property-field" :class="{ 'field-disabled': !(audioItem.ltcEnabled ?? false) }">
            <label for="cue-output-timecode">{{ t('properties.ltcStartTimecode') }}</label>
            <input id="cue-output-timecode"
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
            <label for="cue-output-rate">{{ t('properties.ltcFrameRate') }}</label>
            <select id="cue-output-rate"
              :value="audioItem.ltcFrameRate ?? 4"
              :disabled="!(audioItem.ltcEnabled ?? false)"
              @change="onLtcFrameRateChange"
            >
              <option v-for="opt in ltcFrameRateOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </div>
          <p class="property-help">{{ t(ltcDeviceConfigured ? 'properties.ltcOutputTimecodeHelp' : 'properties.ltcRequiresDevice') }}</p>
        </section>
      </div>

      <section v-if="selectedItem.type === 'audio' ? activeTab === 'basic' : activeTab === 'startBehavior' || activeTab === 'endBehavior'"
        class="property-column cue-behaviors">
        <h4>{{ t('settings.cueingSection') }}</h4>
        <div
          v-if="activeTab === 'basic' && selectedItem.type === 'audio'"
          class="playback-behavior playback-behavior--ducking"
        >
          <div class="property-field">
            <label for="cue-property-ducking">{{ t('properties.ducking') }}</label>
            <select id="cue-property-ducking" v-model="audioItem.duckingBehavior.mode" @change="handleSave">
              <option value="stop-all">{{ t('duckingBehavior.stopAll') }}</option>
              <option value="no-ducking">{{ t('duckingBehavior.noDucking') }}</option>
              <option value="duck-others">{{ t('duckingBehavior.duckOthers') }}</option>
            </select>
          </div>

          <div class="property-field" v-if="audioItem.duckingBehavior.mode === 'duck-others'">
            <label for="cue-property-duckLevel">{{ t('properties.duckLevel') }} ({{ duckLevelDB.toFixed(1) }} dB)</label>
            <input id="cue-property-duckLevel"
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
          class="playback-behavior playback-behavior--start"
        >
          <div class="property-field">
            <label for="cue-property-startBehavior">{{ selectedItem.type === 'audio' ? t('properties.startBehavior') : t('properties.action') }}</label>
            <select id="cue-property-startBehavior" v-model="startBehaviorAction" @change="handleSave">
              <option v-if="selectedItem.type === 'audio'" value="nothing">{{ t('startBehavior.nothing') }}</option>
              <option v-if="selectedItem.type === 'audio'" value="play-next">{{ t('startBehavior.playNext') }}</option>
              <option v-if="selectedItem.type === 'audio'" value="play-item">{{ t('startBehavior.playItem') }}</option>
              <option v-if="selectedItem.type === 'audio'" value="play-index">{{ t('startBehavior.playIndex') }}</option>
              <option v-if="selectedItem.type === 'group'" value="play-first">{{ t('startBehavior.playFirst') }}</option>
              <option v-if="selectedItem.type === 'group'" value="play-all">{{ t('startBehavior.playAll') }}</option>
            </select>
          </div>

          <div class="property-field" v-if="startBehaviorAction === 'play-item'">
            <label for="cue-start-Uuid">{{ t('properties.targetUuid') }}</label>
            <input id="cue-start-Uuid"
              v-model="startBehaviorTargetUuid"
              type="text"
              @change="handleSave"
            />
          </div>

          <div class="property-field" v-if="startBehaviorAction === 'play-index'">
            <label for="cue-start-Index">{{ t('properties.targetIndex') }}</label>
            <input id="cue-start-Index"
              :value="formatItemIndex(startBehaviorTargetIndex)"
              @change="handleStartBehaviorIndexChange"
              type="text"
            />
          </div>
        </div>

        <div
          v-if="(activeTab === 'basic' && selectedItem.type === 'audio') || (activeTab === 'endBehavior' && selectedItem.type === 'group')"
          class="playback-behavior playback-behavior--end"
        >
          <div class="property-field">
            <label for="cue-property-endBehavior">{{ selectedItem.type === 'audio' ? t('properties.endBehavior') : t('properties.action') }}</label>
            <select id="cue-property-endBehavior" v-model="endBehaviorAction" @change="handleSave">
              <option value="nothing">{{ t('endBehavior.nothing') }}</option>
              <option value="next">{{ t('endBehavior.next') }}</option>
              <option value="goto-item">{{ t('endBehavior.gotoItem') }}</option>
              <option value="goto-index">{{ t('endBehavior.gotoIndex') }}</option>
              <option v-if="selectedItem.type === 'audio'" value="loop">{{ t('endBehavior.loop') }}</option>
            </select>
          </div>

          <div class="property-field" v-if="endBehaviorAction === 'goto-item'">
            <label for="cue-end-Uuid">{{ t('properties.targetUuid') }}</label>
            <input id="cue-end-Uuid"
              v-model="endBehaviorTargetUuid"
              type="text"
              @change="handleSave"
            />
          </div>

          <div class="property-field" v-if="endBehaviorAction === 'goto-index'">
            <label for="cue-end-Index">{{ t('properties.targetIndex') }}</label>
            <input id="cue-end-Index"
              :value="formatItemIndex(endBehaviorTargetIndex)"
              @change="handleEndBehaviorIndexChange"
              type="text"
            />
          </div>
        </div>
      </section>
    </div>

    <ServerFilePickerModal
      :open="cueImagePickerOpen"
      mode="file"
      filter=".png,.jpg,.jpeg,.webp,.gif,.svg"
      :fallback-start-path="cueImagePickerStart"
      location-context="cue-image"
      @pick="handleCueImagePicked"
      @close="cueImagePickerOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import type { AudioItem, GroupItem } from '~/types/project';
import { PRESET_COLORS } from '~/types/project';
import {
  applyLoudnessMatch,
  applyTruePeakCeiling,
  buildWaveformFromChannels,
  trimSilence,
  type MeasuredLoudness,
} from '~/utils/audio';
import {
  cloneAsIndependentOneShot,
  isOneShot,
  nextAvailableOneShotOrder,
  removeOneShotDesignation,
} from '~/utils/oneShots';

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
const { cartOnlyItems, addCartOnlyItem, removeCartOnlyItem } = useCartItems();
const propertySaveFailed = ref(false);
const propertySavePending = ref(false);
let propertySaveAttempt = 0;

const audioItem = computed(() => selectedItem.value as AudioItem);

// Per-cue still image for the video output. The picked file is copied into
// the project media folder and stored relative, same portability rule as
// mediaPath and the global standby image.
const cueImagePickerOpen = ref(false);
const cueImagePickerStart = computed(() => currentProject.value?.folderPath || '');

const handleCueImagePicked = async (path: string) => {
  cueImagePickerOpen.value = false;
  const item = audioItem.value;
  if (!item || item.type !== 'audio') return;
  try {
    const dest = await _server.copyToMedia(path);
    const folder = currentProject.value?.folderPath || '';
    item.imagePath = folder && dest.startsWith(folder)
      ? dest.slice(folder.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
      : dest;
    await handleSave();
  } catch (e) {
    console.warn('[PropertiesPanel] cue image copy failed:', e);
  }
};

const handleClearCueImage = async () => {
  const item = audioItem.value;
  if (!item || item.type !== 'audio') return;
  delete item.imagePath;
  await handleSave();
};
const selectedAudioItems = computed(() => getSelectedItems().filter(
  (item): item is AudioItem => item.type === 'audio',
));
const hasSelectedAudioItems = computed(() => selectedAudioItems.value.length > 0);
const hasIndependentOneShot = (item: AudioItem): boolean =>
  (cartOnlyItems.value.has(item.uuid) && isOneShot(item))
  || Array.from(cartOnlyItems.value.values()).some(
    oneShot => oneShot.oneShot?.sourceUuid === item.uuid,
  );
const oneShotEnabled = computed(() => selectedAudioItems.value.length > 0
  && selectedAudioItems.value.every(item => isOneShot(item) || hasIndependentOneShot(item)));

const handleOneShotDesignationChange = (event: Event) => {
  if (!currentProject.value) return;
  const enabled = (event.target as HTMLInputElement).checked;
  let removedSelectedOneShot = false;
  selectedAudioItems.value.forEach((item) => {
    if (enabled && !hasIndependentOneShot(item)) {
      const order = nextAvailableOneShotOrder(
        currentProject.value!.items,
        Array.from(cartOnlyItems.value.values()),
      );
      if (order >= 0) {
        addCartOnlyItem(cloneAsIndependentOneShot(item, crypto.randomUUID(), order));
        // A cue designated by an earlier build is decoupled as soon as the
        // Properties action is used; the new copy owns all One Shot behavior.
        if (isOneShot(item)) removeOneShotDesignation(item);
      }
    }
    if (!enabled) {
      if (cartOnlyItems.value.has(item.uuid)) {
        removeCartOnlyItem(item.uuid);
        selectedItems.value.delete(item.uuid);
        removedSelectedOneShot ||= selectedItem.value?.uuid === item.uuid;
      }
      for (const oneShot of Array.from(cartOnlyItems.value.values())) {
        if (oneShot.oneShot?.sourceUuid === item.uuid) removeCartOnlyItem(oneShot.uuid);
      }
      if (isOneShot(item)) removeOneShotDesignation(item);
    }
  });
  if (removedSelectedOneShot) {
    selectedItem.value = null;
    propertiesPanelOpen.value = false;
  }
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
const audioDeviceOverride = computed(() => {
  const selected = (audioItem.value as any)?.deviceOverride || '';
  return devicesList.value.find(device => device.id === selected)?.display_name ?? selected;
});
const deviceOverrideEditPending = ref(false);

// API endpoint that triggers playback of the selected item. Points at the
// audio server's transport route (routed through ProjectState so ducking,
// in-point, and fades are honoured) — not the client's local trigger proxy.
const apiTriggerUrl = computed(() => {
  const base = (_server.serverUrl ?? 'http://127.0.0.1:4480').replace(/\/+$/, '');
  return `${base}/api/project/items/${selectedItem.value?.uuid}/play`;
});
const onDeviceOverrideChange = async (e: Event) => {
  const input = e.target as HTMLSelectElement;
  const value = input.value;
  const project = currentProject.value;
  const item = audioItem.value;
  input.value = audioDeviceOverride.value;
  if (!project || !item || deviceOverrideEditPending.value) return;
  const previous = item.deviceOverride;
  deviceOverrideEditPending.value = true;
  try {
    await _server.updateProjectItem(item.uuid, { deviceOverride: value || null }, crypto.randomUUID());
    if (currentProject.value !== project) return;
    if (item.deviceOverride === previous) {
      if (value) item.deviceOverride = value;
      else delete item.deviceOverride;
    }
    await endItemBatch();
    if (currentProject.value === project) await persistPropertyChanges();
  } catch {
    if (currentProject.value === project) _server.lastError = t('properties.deviceOverrideFailed');
  } finally {
    deviceOverrideEditPending.value = false;
  }
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
  if (input.value.trim() && parsed.length === 0) {
    input.value = formatItemIndex(endBehaviorTargetIndex.value);
    return;
  }
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
  if (input.value.trim() && parsed.length === 0) {
    input.value = formatItemIndex(startBehaviorTargetIndex.value);
    return;
  }
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
      propertySaveAttempt += 1;
      propertySaveFailed.value = false;
      propertySavePending.value = false;
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
    propertySaveAttempt += 1;
    propertySaveFailed.value = false;
    propertySavePending.value = false;
    originalSnapshot.value = null;
  }
}, { immediate: true });

const handleClose = () => {
  // Close the panel but leave the current selection intact so the highlighted
  // rows stay highlighted. Only the panel's visibility is toggled here.
  propertiesPanelOpen.value = false;
  propertySaveAttempt += 1;
  propertySaveFailed.value = false;
  propertySavePending.value = false;
  originalSnapshot.value = null;
};

const persistPropertyChanges = async (): Promise<boolean> => {
  const attempt = ++propertySaveAttempt;
  propertySavePending.value = true;
  let saved = false;
  try {
    saved = await saveProject();
  } catch (error) {
    console.error('Error saving properties:', error);
  }
  if (attempt === propertySaveAttempt) {
    propertySavePending.value = false;
    propertySaveFailed.value = !saved;
  }
  return saved;
};

const retryPropertySave = () => {
  void persistPropertyChanges();
};

const handleSave = async () => {
  // Drain the final item PATCH before saving the authoritative document so an
  // older edit cannot arrive after the save and restore stale cue values.
  await endItemBatch();
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

  await persistPropertyChanges();
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

// Apply manual loudness matching or peak reduction to each selected cue.
const handleNormalize = async (
  mode: 'loudness' | 'truePeak',
  normalizeTarget: number,
) => {
  let items = getSelectedItems();

  // Fallback to selectedItem if no items in selectedItems set (shouldn't happen now, but safe)
  if (items.length === 0 && selectedItem.value) {
    items = [selectedItem.value];
  }

  const effectiveTarget = Math.max(-60, Math.min(0, normalizeTarget));
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

    if (!isFullFile || analysis?.analysis_version !== 2) {
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
      ? applyTruePeakCeiling(audioItem, analysis, effectiveTarget)
      : applyLoudnessMatch(
          audioItem,
          analysis,
          effectiveTarget,
        );
    if (changed) {
      normalizedCount++;
    }
  }

  if (normalizedCount > 0) {
    await saveProject();
    console.log(mode === 'truePeak'
      ? `Reduced peaks above ${effectiveTarget.toFixed(1)} dBTP for ${normalizedCount} item(s)`
      : `Normalized ${normalizedCount} item(s) to ${effectiveTarget.toFixed(1)} LUFS`);
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
    if (selectedItem.value) originalSnapshot.value = JSON.parse(JSON.stringify(selectedItem.value));
    await persistPropertyChanges();
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
  const project = currentProject.value;
  const item = audioItem.value;
  if (!item || item.type !== 'audio') return;
  const isCurrent = () => currentProject.value === project && audioItem.value === item;

  const files = await window.electronAPI.selectAudioFiles();
  const sourcePath = files?.[0];
  if (!sourcePath || !isCurrent()) return;

  const snapshot = JSON.parse(JSON.stringify(item));
  let mutated = false;
  isReplacingMedia.value = true;
  replaceMediaError.value = false;
  replaceMediaStatus.value = t('properties.verifyingReplacement');
  try {
    const [metadata, serverWaveform] = await Promise.all([
      _server.fetchMetadata(sourcePath),
      _server.fetchWaveformByPath(sourcePath),
    ]);
    if (!isCurrent()) return;
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
    if (!isCurrent()) return;
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
    // Re-probe: swapping media can add or remove the video stream.
    if ((metadata as any)?.has_video === true) item.hasVideo = true;
    else delete item.hasVideo;
    if (typeof item.startNextTime === 'number') {
      item.startNextTime = Math.max(item.inPoint, Math.min(item.startNextTime, item.outPoint));
    }

    if (!await saveProject()) throw new Error(t('properties.replacementSaveFailed'));
    originalSnapshot.value = JSON.parse(JSON.stringify(item));
    replaceMediaStatus.value = t('properties.replacementComplete');
    void _server.requestWaveformGeneration(mediaServerPath, item.uuid, true).catch(() => {});
  } catch (error: any) {
    if (mutated) {
      Object.assign(item, snapshot);
      if (currentProject.value === project) await saveProject();
    }
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
  container-type: inline-size;
  flex: 1;
  min-height: 0;
  border-top: 1px solid var(--color-border);
  background-color: var(--color-background);
  display: flex;
  flex-direction: column;
  box-shadow: inset 0 1px color-mix(in srgb, var(--color-text-primary) 4%, transparent);
}

.properties-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) var(--panel-control-height);
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
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(104px, 1fr);
  align-self: stretch;
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
  justify-content: center;
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

.properties-content {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  align-content: start;
  width: min(100%, var(--settings-width));
  flex: 1;
  min-height: 0;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) var(--workspace-gutter);
  overflow: auto;
}

.properties-content:has(.playback-panel) {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(min-content, 1fr);
  align-content: stretch;
}

.playback-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.properties-playback-info {
  display: flex;
  align-items: center;
  min-width: 0;
  padding-top: var(--spacing-xs);
  border-top: 1px solid var(--color-border);
}

.basic-panel, .output-panel {
  display: contents;
}

.output-panel > .property-column {
  grid-column: span 2;
}

.property-column {
  display: grid;
  align-content: start;
  row-gap: 0;
  min-width: 0;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
}

.properties-content--audio .property-column {
  grid-row: span 6;
  grid-template-rows: subgrid;
}

.property-column h4 {
  display: flex;
  align-items: center;
  min-height: var(--settings-row-height);
  padding: var(--spacing-xs) var(--spacing-sm);
  font-size: var(--type-panel-title-size);
}

.playback-behavior {
  display: contents;
}

.property-column .property-field {
  border-top: 1px solid var(--color-border);
}

.property-field {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
  align-content: start;
  align-items: center;
  gap: 0 var(--spacing-xs);
  min-height: var(--settings-row-height);
  min-width: 0;
  padding: 1px var(--spacing-sm) 2px;
}

.property-field > .property-help,
.property-field > .one-shot-designation__toggle,
.property-field > .ltc-checkbox-label {
  grid-column: 1 / -1;
}

.property-field:has(.color-picker) {
  grid-template-columns: minmax(0, 1fr);
}

@container (max-width: 940px) {
  .properties-content:not(:has(.playback-panel)) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .output-panel > .property-column { grid-column: span 1; }
  .properties-content--audio .property-column {
    grid-row: auto;
    grid-template-rows: none;
  }
}

@container (max-width: 560px) {
  .properties-content:not(:has(.playback-panel)) {
    grid-template-columns: minmax(0, 1fr);
  }
  .properties-header { grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) var(--panel-control-height); }
  .properties-tabs { grid-auto-columns: minmax(72px, 1fr); }
  .tab-btn .material-symbols-rounded { display: none; }
}

.property-field label,
.property-label {
  color: var(--color-text-primary);
  font-size: var(--type-metadata-size);
  font-weight: 600;
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

.property-field input:not([type='checkbox'], [type='range']),
.property-field select {
  width: 100%;
  min-width: 0;
  padding: 0 var(--spacing-xs);
  background-color: var(--color-control);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  color: var(--color-text);
  min-height: var(--settings-control-height);
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
    text-overflow: ellipsis;
  }
}

.icon-btn {
  width: var(--settings-control-height);
  min-width: var(--settings-control-height);
  min-height: var(--settings-control-height);
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
  width: 100%;
  min-width: 0;
  gap: var(--spacing-xs);
  font-size: var(--type-metadata-size);
  padding: 0 var(--spacing-xs);

  .spinning {
    animation: spin 1s linear infinite;
  }
}

.color-picker {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: repeat(7, minmax(0, 24px));
  gap: var(--spacing-xs);
  padding-block: 2px;
}

.color-btn {
  width: 100%;
  min-height: 22px;
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

.action-btn-small {
  min-height: var(--settings-control-height);
  padding: 0 var(--spacing-md);
  background-color: var(--color-control);
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-sm);
  color: var(--color-text-primary);
  &:hover {
    background-color: var(--color-surface-hover);
    border-color: var(--color-accent);
  }
}

.color-cycle { grid-column: 1 / -1; justify-self: start; }

.db-range-labels {
  grid-column: 2;
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

  :deep(.cue-symbol) {
    font-size: 18px;
  }

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
  margin: 2px 0;
  overflow-wrap: anywhere;
}

.property-column > .property-help {
  padding-inline: var(--spacing-sm);
}

.property-help--error {
  color: var(--color-danger);
}

.trim-save-feedback {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-top: var(--spacing-xs);
  padding: var(--spacing-xs) var(--spacing-sm);
  border: 1px solid color-mix(in srgb, var(--color-warning) 42%, var(--color-border));
  border-radius: var(--control-radius);
  background: color-mix(in srgb, var(--color-warning) 10%, transparent);
  color: var(--color-text-primary);
  font-size: var(--type-metadata-size);
}

.trim-save-feedback > .material-symbols-rounded {
  color: var(--color-warning);
  font-size: 18px;
}

.trim-save-retry {
  width: auto;
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--color-text-primary);
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
