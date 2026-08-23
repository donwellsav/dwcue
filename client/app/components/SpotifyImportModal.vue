<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @click.self="handleClose">
      <div class="modal" role="dialog" aria-modal="true" :aria-labelledby="titleId">
        <header class="modal-header">
          <h2 :id="titleId">{{ t('spotifyImport.title') }}</h2>
          <button
            type="button"
            class="icon-btn"
            :aria-label="t('actions.close')"
            :disabled="isBusy"
            @click="handleClose"
          >
            <span class="material-symbols-rounded" aria-hidden="true">close</span>
          </button>
        </header>

        <form class="modal-body" @submit.prevent="handleSubmit">
          <label class="field">
            <span class="field-label">{{ t('spotifyImport.urlLabel') }}</span>
            <input
              ref="urlInput"
              v-model.trim="spotifyUrl"
              type="url"
              :placeholder="t('spotifyImport.urlPlaceholder')"
              :disabled="isBusy || hasLockedDestination"
              spellcheck="false"
              autocomplete="off"
            >
          </label>

          <p class="hint selectable">{{ t('spotifyImport.hint') }}</p>

          <section class="import-plan selectable" :aria-labelledby="planId">
            <button
              type="button"
              class="plan-toggle"
              :aria-expanded="!planCollapsed"
              :aria-controls="planBodyId"
              @click="planCollapsed = !planCollapsed"
            >
              <span
                class="material-symbols-rounded plan-chevron"
                :class="{ open: !planCollapsed }"
                aria-hidden="true"
              >chevron_right</span>
              <span :id="planId" class="plan-title">{{ t('spotifyImport.importPlan') }}</span>
              <span v-if="planCollapsed" class="plan-summary">{{ planSummary }}</span>
            </button>

            <div v-show="!planCollapsed" :id="planBodyId" class="plan-body">
            <dl class="plan-list">
              <div class="plan-row">
                <dt>{{ t('spotifyImport.source') }}</dt>
                <dd>{{ sourceTypeText }}</dd>
              </div>
              <div class="plan-row">
                <dt>{{ t('spotifyImport.audioFormat') }}</dt>
                <dd>
                  <label class="inline-option">
                    <span class="sr-only">{{ t('spotifyImport.audioBitrate') }}</span>
                    <select v-model="audioBitrate" :disabled="isBusy">
                      <option value="320k">{{ t('spotifyImport.audioBitrate320') }}</option>
                      <option value="256k">{{ t('spotifyImport.audioBitrate256') }}</option>
                      <option value="192k">{{ t('spotifyImport.audioBitrate192') }}</option>
                    </select>
                  </label>
                </dd>
              </div>
              <div class="plan-row">
                <dt>{{ t('spotifyImport.searchSources') }}</dt>
                <dd>{{ t('spotifyImport.searchSourcesValue') }}</dd>
              </div>
              <div class="plan-row destination-row">
                <dt>{{ t('spotifyImport.destination') }}</dt>
                <dd>
                  <span class="path-value" :title="destinationParentPath">
                    {{ destinationParentPath || t('spotifyImport.destinationNotSelected') }}
                  </span>
                  <button
                    type="button"
                    class="btn compact"
                    :disabled="isBusy || isChoosingDestination || hasLockedDestination"
                    @click="chooseDestination"
                  >
                    <span class="material-symbols-rounded" aria-hidden="true">folder_open</span>
                    <span>
                      {{ destinationParentPath
                        ? t('spotifyImport.changeDestination')
                        : t('spotifyImport.chooseDestination') }}
                    </span>
                  </button>
                </dd>
              </div>
            </dl>

            <p class="plan-note">{{ t('spotifyImport.createsDescription') }}</p>

            <div class="processing-summary">
              <p class="processing-title">{{ t('spotifyImport.cueSetup') }}</p>
              <label class="processing-control processing-control--select">
                <span>{{ t('settings.transitionMode') }}</span>
                <select
                  :value="cueProcessingSettings.transitionMode"
                  :disabled="isBusy || isSavingSettings"
                  @change="updateTransitionMode"
                >
                  <option value="crossfade">{{ t('settings.transitionModeCrossfade') }}</option>
                  <option value="start-next">{{ t('settings.transitionModeStartNext') }}</option>
                </select>
              </label>
              <label class="processing-control">
                <input
                  type="checkbox"
                  :checked="cueProcessingSettings.trimSilence"
                  :disabled="isBusy || isSavingSettings"
                  @change="updateBooleanSetting('autoTrimSilenceOnImport', $event)"
                >
                <span>{{ t('settings.autoTrimSilenceOnImport') }}</span>
              </label>
              <label class="processing-control">
                <input
                  type="checkbox"
                  :checked="cueProcessingSettings.matchLoudness"
                  :disabled="isBusy || isSavingSettings"
                  @change="updateBooleanSetting('autoMatchLoudnessOnImport', $event)"
                >
                <span>{{ t('settings.autoMatchLoudnessOnImport') }}</span>
              </label>
              <label class="processing-control">
                <input
                  type="checkbox"
                  :checked="cueProcessingSettings.reduceTruePeaks"
                  :disabled="isBusy || isSavingSettings"
                  @change="updateBooleanSetting('autoReduceTruePeaksOnImport', $event)"
                >
                <span>{{ t('settings.autoReduceTruePeaksOnImport') }}</span>
              </label>
              <label class="processing-control">
                <input
                  type="checkbox"
                  :checked="cueProcessingSettings.cycleColors"
                  :disabled="isBusy || isSavingSettings"
                  @change="updateBooleanSetting('cycleTrackColors', $event)"
                >
                <span>{{ t('settings.cycleTrackColors') }}</span>
              </label>
              <p v-if="settingsSaveError" class="settings-save-error" role="alert">
                {{ settingsSaveError }}
              </p>
            </div>
            </div>
          </section>

          <section v-if="reviewState" class="track-review" :aria-label="t('spotifyImport.reviewTitle')">
            <div class="review-heading">
              <div class="selectable">
                <h3>{{ reviewState.playlistName }}</h3>
                <p>{{ t('spotifyImport.reviewSummary', {
                  selected: selectedTrackIds.length,
                  total: reviewState.tracks.length,
                  duration: formatDuration(selectedDuration),
                }) }}</p>
              </div>
              <div class="review-actions">
                <button type="button" class="btn compact" :disabled="isBusy" @click="selectAllTracks">{{ t('spotifyImport.selectAll') }}</button>
                <button type="button" class="btn compact" :disabled="isBusy" @click="selectedTrackIds = []">{{ t('spotifyImport.selectNone') }}</button>
              </div>
            </div>
            <ul class="track-list">
              <li
                v-for="track in reviewState.tracks"
                :key="track.id"
                :class="trackResultClass(track.id)"
              >
                <label :class="{ 'has-cover': !!track.coverUrl }">
                  <input
                    type="checkbox"
                    :checked="selectedTrackIds.includes(track.id)"
                    :disabled="isBusy"
                    @change="toggleTrack(track.id)"
                  >
                  <img v-if="track.coverUrl" :src="track.coverUrl" alt="">
                  <span class="track-info selectable">
                    <strong>{{ track.title }}</strong>
                    <span>{{ track.artists.join(', ') }}<template v-if="track.album"> · {{ track.album }}</template></span>
                    <small>{{ trackMatchText(track.id) }}</small>
                  </span>
                  <time class="selectable">{{ formatDuration(track.duration) }}</time>
                </label>
                <button
                  v-if="trackImportResults[track.id]?.itemUuid && trackImportResults[track.id]?.status !== 'failed'"
                  type="button"
                  class="track-preview"
                  :title="previewItemUuid === trackImportResults[track.id]?.itemUuid ? t('actions.stopPreview') : t('actions.preview')"
                  @click="toggleImportedPreview(track.id)"
                >
                  <span class="material-symbols-rounded" aria-hidden="true">
                    {{ previewItemUuid === trackImportResults[track.id]?.itemUuid ? 'stop_circle' : 'headphones' }}
                  </span>
                </button>
              </li>
            </ul>
          </section>

          <div
            v-if="progressState || resultState || errorMessage"
            class="status-card"
            :class="{
              'has-result': !!resultState,
              'has-ready-tracks': (resultState?.completed ?? 0) > 0,
              'has-import-errors': importFailedTrackCount > 0 || !!errorMessage,
            }"
          >
            <div
              class="status-top"
              role="status"
              aria-live="polite"
              aria-atomic="false"
            >
              <div class="selectable">
                <p class="status-label">{{ statusText }}</p>
                <p v-if="progressState?.playlistName" class="status-detail">{{ progressState.playlistName }}</p>
                <p v-if="progressState?.message && isActive" class="status-detail">{{ progressState.message }}</p>
                <p v-if="pendingRecoveryCount" class="status-detail">
                  {{ t('spotifyImport.resumeExplanation', { count: pendingRecoveryCount }) }}
                </p>
                <p v-else-if="unavailableTrackCount" class="status-detail">
                  {{ t('spotifyImport.partialExplanation', { failed: unavailableTrackCount }) }}
                </p>
                <p v-if="importFailedTrackCount" class="status-error" role="alert">
                  {{ t('spotifyImport.importFailureExplanation', { count: importFailedTrackCount }) }}
                </p>
                <p v-if="resultState?.projectFolderPath" class="status-detail">{{ resultState.projectFolderPath }}</p>
              </div>
              <p v-if="countText" class="status-count selectable">{{ countText }}</p>
            </div>

            <div
              class="progress-bar"
              role="progressbar"
              :aria-label="resultState ? t('spotifyImport.resultLabel') : t('spotifyImport.progressLabel')"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="progressValue"
              :aria-valuetext="countText || statusText"
            >
              <div
                class="progress-fill"
                :style="{ transform: `scaleX(${progressPercent / 100})` }"
              />
            </div>

            <p v-if="errorMessage" class="status-error selectable" role="alert">{{ errorMessage }}</p>
            <details v-if="technicalMessage" class="status-technical selectable">
              <summary>{{ t('spotifyImport.technicalDetails') }}</summary>
              <p>{{ technicalMessage }}</p>
            </details>
            <button
              v-if="resultState?.projectFolderPath"
              type="button"
              class="btn compact open-folder"
              @click="openResultFolder"
            >
              <span class="material-symbols-rounded" aria-hidden="true">folder_open</span>
              <span>{{ t('spotifyImport.openFolder') }}</span>
            </button>
          </div>

          <div class="actions">
            <template v-if="resultState && !isActive">
              <button
                v-if="pendingRecoveryCount"
                type="button"
                class="btn primary"
                @click="resumeImport"
              >
                <span class="material-symbols-rounded" aria-hidden="true">library_add</span>
                <span>{{ t('spotifyImport.resumeImport', { count: pendingRecoveryCount }) }}</span>
              </button>
              <template v-else>
                <button type="button" class="btn" @click="startAnotherImport">
                  <span>{{ t('spotifyImport.startAnother') }}</span>
                </button>
                <button
                  v-if="failedTrackCount"
                  type="button"
                  class="btn"
                  @click="resumeImport"
                >
                  <span class="material-symbols-rounded" aria-hidden="true">refresh</span>
                  <span>{{ t(importFailedTrackCount
                    ? 'spotifyImport.retryTracks'
                    : 'spotifyImport.retryUnmatched', { count: failedTrackCount }) }}</span>
                </button>
                <button type="button" class="btn primary" @click="continueToProject">
                  <span class="material-symbols-rounded" aria-hidden="true">arrow_forward</span>
                  <span>{{ resultState.completed
                    ? t('spotifyImport.continueWithTracks', { count: resultState.completed })
                    : t('spotifyImport.done') }}</span>
                </button>
              </template>
            </template>
            <template v-else>
              <button type="submit" class="btn primary" :disabled="!canStart">
                <span class="material-symbols-rounded" aria-hidden="true">library_add</span>
                <span>{{ isReviewing
                  ? t('spotifyImport.reviewing')
                  : isActive
                    ? t('spotifyImport.downloading')
                    : reviewState
                      ? t('spotifyImport.downloadSelected', { count: selectedTrackIds.length })
                      : t('spotifyImport.reviewTracks') }}</span>
              </button>
              <button
                v-if="isBusy"
                type="button"
                class="btn"
                :disabled="isCancelling"
                @click="cancelDownload"
              >
                <span class="material-symbols-rounded" aria-hidden="true">close</span>
                <span>{{ isCancelling ? t('spotifyImport.cancelling') : t('common.cancel') }}</span>
              </button>
            </template>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

type SpotifyJobStatus =
  | 'preparing'
  | 'resolving'
  | 'downloading'
  | 'importing'
  | 'complete'
  | 'partial'
  | 'cancelled'
  | 'error';

interface SpotifyDownloadProgress {
  jobId: string;
  status: SpotifyJobStatus;
  playlistName?: string;
  total: number;
  completed: number;
  message?: string;
}

interface SpotifyDownloadResult {
  files: string[];
  total: number;
  completed: number;
  partial: boolean;
  error?: string;
  playlistName: string;
  projectFolderPath: string;
  completedTrackIds: string[];
  failedTrackIds: string[];
  groupUuid?: string;
}

interface SpotifyRecoveryState {
  version: 1;
  activeProjectFolderPath: string;
  destinationParentPath: string;
  projectFolderPath: string;
  url: string;
  playlistName: string;
  audioBitrate: '192k' | '256k' | '320k';
  selectedTrackIds: string[];
  completedTrackIds: string[];
  failedTrackIds: string[];
  pendingTrackIds: string[];
  pendingFiles: string[];
  total: number;
  completed: number;
  groupUuid?: string;
  updatedAt: number;
}

interface SpotifyTrackReview {
  id: string;
  title: string;
  artists: string[];
  album: string;
  duration: number;
  coverUrl: string;
  spotifyUrl: string;
}

interface SpotifyPreflight {
  preflightId: string;
  playlistName: string;
  totalDuration: number;
  tracks: SpotifyTrackReview[];
}

interface ImportBatchResult {
  success: boolean;
  imported: number;
  error?: string;
  retainFiles?: boolean;
  groupUuid?: string;
  results?: Array<{
    sourcePath: string;
    status: 'ready' | 'warning' | 'failed' | 'skipped';
    reason?: string;
    itemUuid?: string;
  }>;
}

interface ImportBatchOptions {
  groupName: string;
  templateFolderPath: string;
  existingGroupUuid?: string;
}

interface SpotifyElectronApi {
  downloadSpotifyAudio: (
    jobId: string,
    url: string,
    destinationParentPath: string,
    selection: {
      preflightId: string;
      selectedTrackIds: string[];
      reusePreviousFolder?: boolean;
      activeProjectFolderPath: string;
      audioBitrate: '192k' | '256k' | '320k';
      existingProjectFolderPath?: string;
    },
    progressCallback: (progress: SpotifyDownloadProgress) => void,
  ) => Promise<SpotifyDownloadResult>;
  preflightSpotify: (jobId: string, url: string) => Promise<SpotifyPreflight>;
  cancelSpotifyPreflight: (jobId: string) => Promise<boolean>;
  cancelSpotifyDownload: (jobId: string) => Promise<boolean>;
  finalizeSpotifyImport: (jobId: string, keepFiles: boolean) => Promise<boolean>;
  setSpotifyImportRecovery: (recovery: SpotifyRecoveryState) => Promise<boolean>;
  clearSpotifyImportRecovery: (activeProjectFolderPath: string) => Promise<boolean>;
}

const props = defineProps<{
  open: boolean;
  projectFolderPath: string;
  projectEpoch: number;
  importFiles: (
    files: string[],
    signal?: AbortSignal,
    options?: ImportBatchOptions,
  ) => Promise<ImportBatchResult>;
}>();

const emit = defineEmits<{
  close: [];
}>();

const { t } = useLocalization();
const { currentProject, previewItemUuid, startPreview, stopPreview, saveProject } = useProject();
const server = useLiveplayServer();

const titleId = `spotify-import-${Math.random().toString(36).slice(2)}`;
const planId = `${titleId}-plan`;
const planBodyId = `${planId}-body`;
// Accordion: the import plan folds away once tracks load so the review list
// and the Download button sit next to each other without scrolling. It
// reopens when the review is dismissed (start another import).
const planCollapsed = ref(false);
const planSummary = computed(() => {
  const parts: string[] = [audioBitrate.value];
  const dest = destinationParentPath.value.split(/[\\/]/).filter(Boolean).pop();
  if (dest) parts.push(dest);
  return parts.join(' · ');
});
const urlInput = ref<HTMLInputElement | null>(null);
const spotifyUrl = ref('');
const storedAudioBitrate = import.meta.client
  ? localStorage.getItem('liveplay-spotify-bitrate')
  : null;
const audioBitrate = ref<'192k' | '256k' | '320k'>(
  storedAudioBitrate === '192k' || storedAudioBitrate === '256k' ? storedAudioBitrate : '320k',
);
const destinationParentPath = ref('');
const activeJobId = ref('');
const reviewJobId = ref('');
const progressState = ref<SpotifyDownloadProgress | null>(null);
const resultState = ref<SpotifyDownloadResult | null>(null);
const errorMessage = ref('');
const technicalMessage = ref('');
const reviewState = ref<SpotifyPreflight | null>(null);
watch(reviewState, (state, prev) => {
  if (state && !prev) planCollapsed.value = true;
  if (!state) planCollapsed.value = false;
});
const trackImportResults = ref<Record<string, NonNullable<ImportBatchResult['results']>[number]>>({});
const selectedTrackIds = ref<string[]>([]);
const isReviewing = ref(false);
const isCancelling = ref(false);
const isImportingCues = ref(false);
const isChoosingDestination = ref(false);
const importAbortController = ref<AbortController | null>(null);
const retryingFailed = ref(false);
const pendingRecoveryFiles = ref<string[]>([]);
const pendingRecoveryTrackIds = ref<string[]>([]);
const restoringRecovery = ref(false);
const suppressUrlReset = ref(false);
const isSavingSettings = ref(false);
const settingsSaveError = ref('');

watch(audioBitrate, value => {
  if (import.meta.client) localStorage.setItem('liveplay-spotify-bitrate', value);
});

const isActive = computed(() => !!activeJobId.value);
const isBusy = computed(() => isActive.value || isReviewing.value);
const normalizedUrl = computed(() => normalizeSpotifyUrl(spotifyUrl.value));
const canStart = computed(() => !!props.projectFolderPath && !!normalizedUrl.value &&
  !isBusy.value && !isChoosingDestination.value &&
  (!reviewState.value || selectedTrackIds.value.length > 0));
const selectedDuration = computed(() => reviewState.value?.tracks
  .filter(track => selectedTrackIds.value.includes(track.id))
  .reduce((sum, track) => sum + track.duration, 0) ?? 0);
const failedTrackCount = computed(() => resultState.value?.failedTrackIds.length ?? 0);
const importFailedTrackCount = computed(() => resultState.value?.failedTrackIds
  .filter(id => trackImportResults.value[id]?.status === 'failed').length ?? 0);
const unavailableTrackCount = computed(() => Math.max(
  0,
  failedTrackCount.value - importFailedTrackCount.value,
));
const pendingRecoveryCount = computed(() => pendingRecoveryFiles.value.length);
const hasLockedDestination = computed(() => !!resultState.value || pendingRecoveryCount.value > 0);

const sourceTypeText = computed(() => {
  if (!normalizedUrl.value) return t('spotifyImport.sourceNotSelected');
  const url = new URL(normalizedUrl.value);
  if (url.hostname !== 'open.spotify.com') return t('spotifyImport.sourceTypes.share');
  const type = url.pathname.split('/').filter(Boolean)[0];
  return t(`spotifyImport.sourceTypes.${type}`);
});

const cueProcessingSettings = computed(() => {
  const settings = currentProject.value?.settings;
  return {
    transitionMode: settings?.defaultTransitionMode === 'start-next' ? 'start-next' : 'crossfade',
    trimSilence: settings?.autoTrimSilenceOnImport === true,
    matchLoudness: settings?.autoMatchLoudnessOnImport === true,
    reduceTruePeaks: settings?.autoReduceTruePeaksOnImport !== false,
    cycleColors: settings?.cycleTrackColors !== false,
  };
});

const progressPercent = computed(() => {
  const source = resultState.value ?? progressState.value;
  if (!source?.total) return progressState.value ? 8 : 0;
  const percent = (source.completed / source.total) * 100;
  return resultState.value
    ? Math.max(0, Math.min(100, percent))
    : Math.max(8, Math.min(100, percent));
});

const progressValue = computed(() => {
  const source = resultState.value ?? progressState.value;
  return source?.total ? Math.round(progressPercent.value) : undefined;
});

const statusText = computed(() => {
  if (resultState.value) {
    if (resultState.value.completed > 0) {
      return t('spotifyImport.tracksReady', { completed: resultState.value.completed });
    }
    if (unavailableTrackCount.value > 0 && importFailedTrackCount.value === 0) {
      return t('spotifyImport.noMatchesTitle');
    }
  }
  const status = progressState.value?.status;
  if (status) {
    switch (status) {
      case 'preparing':
        return t('spotifyImport.status.preparing');
      case 'resolving':
        return t('spotifyImport.status.resolving');
      case 'downloading':
        return t('spotifyImport.status.downloading');
      case 'importing':
        return t('spotifyImport.status.importing');
      case 'complete':
        return t('spotifyImport.status.complete');
      case 'partial':
        return t('spotifyImport.status.partial');
      case 'cancelled':
        return t('spotifyImport.status.cancelled');
      case 'error':
        return t('spotifyImport.status.error');
    }
  }
  if (resultState.value) {
    return resultState.value.partial
      ? t('spotifyImport.status.partial')
      : t('spotifyImport.status.complete');
  }
  return t('spotifyImport.idle');
});

const countText = computed(() => {
  const source = resultState.value ?? progressState.value;
  if (!source?.total) return '';
  if (resultState.value) {
    if (importFailedTrackCount.value) {
      return t('spotifyImport.resultCountWithErrors', {
        completed: resultState.value.completed,
        unavailable: unavailableTrackCount.value,
        failed: importFailedTrackCount.value,
      });
    }
    if (unavailableTrackCount.value) {
      return t('spotifyImport.resultCount', {
        completed: resultState.value.completed,
        unavailable: unavailableTrackCount.value,
      });
    }
  }
  return t('spotifyImport.count', { completed: source.completed, total: source.total });
});

watch(
  () => props.open,
  (open) => {
    if (!open && isBusy.value) {
      void cancelDownload();
      return;
    }
    if (!open) {
      resetState();
      return;
    }
    if (open) {
      void loadImportPreferences();
      nextTick(() => urlInput.value?.focus());
    }
  },
);

watch(spotifyUrl, () => {
  if (isActive.value || restoringRecovery.value || suppressUrlReset.value) return;
  errorMessage.value = '';
  technicalMessage.value = '';
  resultState.value = null;
  progressState.value = null;
  reviewState.value = null;
  selectedTrackIds.value = [];
  trackImportResults.value = {};
  retryingFailed.value = false;
  pendingRecoveryFiles.value = [];
  pendingRecoveryTrackIds.value = [];
  if (props.projectFolderPath) {
    void getSpotifyApi()?.clearSpotifyImportRecovery(props.projectFolderPath).catch(() => {});
  }
});

watch(
  () => [props.projectFolderPath, props.projectEpoch] as const,
  ([folderPath, epoch], [previousFolderPath, previousEpoch]) => {
    if (isBusy.value &&
        (folderPath !== previousFolderPath || epoch !== previousEpoch)) {
      void cancelDownload();
    }
  },
);

onBeforeUnmount(() => {
  importAbortController.value?.abort();
  const api = getSpotifyApi();
  if (api && activeJobId.value && !isImportingCues.value) {
    void api.cancelSpotifyDownload(activeJobId.value).catch(() => {});
  }
  if (api && reviewJobId.value) {
    void api.cancelSpotifyPreflight(reviewJobId.value).catch(() => {});
  }
});

function getSpotifyApi(): (Window['electronAPI'] & SpotifyElectronApi) | null {
  if (!import.meta.client) return null;
  const api = window.electronAPI as (Window['electronAPI'] & Partial<SpotifyElectronApi>) | undefined;
  if (!api?.downloadSpotifyAudio ||
      !api?.cancelSpotifyDownload ||
      !api?.cancelSpotifyPreflight ||
      !api?.finalizeSpotifyImport ||
      !api?.setSpotifyImportRecovery ||
      !api?.clearSpotifyImportRecovery ||
      !api?.preflightSpotify) {
    return null;
  }
  return api as Window['electronAPI'] & SpotifyElectronApi;
}

async function persistProjectSetting(patch: Record<string, unknown>) {
  if (!currentProject.value || isSavingSettings.value) return;
  const previous = { ...(currentProject.value.settings || {}) };
  currentProject.value.settings = { ...previous, ...patch };
  isSavingSettings.value = true;
  settingsSaveError.value = '';
  try {
    await server.patchSettings(patch);
    if (!await saveProject()) throw new Error(t('spotifyImport.settingsSaveFailed'));
  } catch (error: any) {
    currentProject.value.settings = previous;
    settingsSaveError.value = error?.message || t('spotifyImport.settingsSaveFailed');
  } finally {
    isSavingSettings.value = false;
  }
}

function updateTransitionMode(event: Event) {
  void persistProjectSetting({
    defaultTransitionMode: (event.target as HTMLSelectElement).value,
  });
}

function updateBooleanSetting(key: string, event: Event) {
  void persistProjectSetting({ [key]: (event.target as HTMLInputElement).checked });
}

async function chooseDestination(): Promise<string> {
  const api = getSpotifyApi();
  if (!api || isActive.value || isChoosingDestination.value || hasLockedDestination.value) return '';
  isChoosingDestination.value = true;
  try {
    const selected = await api.selectProjectFolder();
    if (selected) {
      destinationParentPath.value = selected;
      await api.setSpotifyImportDestination(selected);
    }
    return selected || '';
  } catch (error: any) {
    errorMessage.value = error?.message || t('spotifyImport.destinationFailed');
    return '';
  } finally {
    isChoosingDestination.value = false;
  }
}

async function loadImportPreferences() {
  if (!import.meta.client) return;
  const preferences = await window.electronAPI.getImportPreferences().catch(() => null);
  if (!destinationParentPath.value && preferences?.spotifyDestination) {
    destinationParentPath.value = preferences.spotifyDestination;
  }
  if (preferences?.spotifyRecovery?.activeProjectFolderPath === props.projectFolderPath) {
    await restoreSpotifyRecovery(preferences.spotifyRecovery);
  }
}

async function restoreSpotifyRecovery(recovery: SpotifyRecoveryState) {
  const api = getSpotifyApi();
  if (!api || isBusy.value) return;
  restoringRecovery.value = true;
  spotifyUrl.value = recovery.url;
  destinationParentPath.value = recovery.destinationParentPath;
  audioBitrate.value = recovery.audioBitrate;
  isReviewing.value = true;
  const jobId = crypto.randomUUID();
  reviewJobId.value = jobId;
  try {
    const review = await api.preflightSpotify(jobId, recovery.url);
    reviewState.value = review;
    const knownIds = new Set(review.tracks.map(track => track.id));
    const pending = recovery.pendingTrackIds
      .map((id, index) => ({ id, file: recovery.pendingFiles[index] }))
      .filter(({ id, file }) => knownIds.has(id) && !!file);
    pendingRecoveryFiles.value = pending.map(({ file }) => file);
    pendingRecoveryTrackIds.value = pending.map(({ id }) => id);
    selectedTrackIds.value = recovery.failedTrackIds.filter(id => knownIds.has(id));
    resultState.value = {
      files: [...recovery.pendingFiles],
      total: recovery.total,
      completed: recovery.completed,
      partial: true,
      playlistName: recovery.playlistName,
      projectFolderPath: recovery.projectFolderPath,
      completedTrackIds: [...recovery.completedTrackIds],
      failedTrackIds: recovery.failedTrackIds.filter(id => knownIds.has(id)),
      groupUuid: recovery.groupUuid,
    };
    progressState.value = {
      jobId,
      status: 'partial',
      playlistName: recovery.playlistName,
      total: recovery.total,
      completed: recovery.completed,
    };
  } catch (error: any) {
    errorMessage.value = error?.message || t('spotifyImport.recoveryFailed');
  } finally {
    if (reviewJobId.value === jobId) reviewJobId.value = '';
    isReviewing.value = false;
    restoringRecovery.value = false;
  }
}

function recoveryForResult(
  result: SpotifyDownloadResult,
  pendingTrackIds: string[] = [],
  pendingFiles: string[] = [],
): SpotifyRecoveryState {
  return {
    version: 1,
    activeProjectFolderPath: props.projectFolderPath,
    destinationParentPath: destinationParentPath.value,
    projectFolderPath: result.projectFolderPath,
    url: normalizedUrl.value,
    playlistName: result.playlistName,
    audioBitrate: audioBitrate.value,
    selectedTrackIds: [...new Set([
      ...result.completedTrackIds,
      ...result.failedTrackIds,
      ...pendingTrackIds,
    ])],
    completedTrackIds: [...result.completedTrackIds],
    failedTrackIds: [...result.failedTrackIds],
    pendingTrackIds: [...pendingTrackIds],
    pendingFiles: [...pendingFiles],
    total: result.total,
    completed: result.completedTrackIds.length,
    ...(result.groupUuid ? { groupUuid: result.groupUuid } : {}),
    updatedAt: Date.now(),
  };
}

async function persistRecovery(result: SpotifyDownloadResult) {
  const api = getSpotifyApi();
  if (!api) return;
  if (!result.failedTrackIds.length && !pendingRecoveryFiles.value.length) {
    await api.clearSpotifyImportRecovery(props.projectFolderPath);
    return;
  }
  await api.setSpotifyImportRecovery(recoveryForResult(
    result,
    pendingRecoveryTrackIds.value,
    pendingRecoveryFiles.value,
  ));
}

async function reviewSpotify() {
  const api = getSpotifyApi();
  if (!api || !normalizedUrl.value || isBusy.value) return;
  isReviewing.value = true;
  const jobId = crypto.randomUUID();
  reviewJobId.value = jobId;
  errorMessage.value = '';
  technicalMessage.value = '';
  try {
    reviewState.value = await api.preflightSpotify(jobId, normalizedUrl.value);
    selectedTrackIds.value = reviewState.value.tracks.map(track => track.id);
  } catch (error: any) {
    errorMessage.value = error?.message || t('spotifyImport.reviewFailed');
  } finally {
    if (reviewJobId.value === jobId) reviewJobId.value = '';
    isReviewing.value = false;
  }
}

function selectAllTracks() {
  selectedTrackIds.value = reviewState.value?.tracks.map(track => track.id) ?? [];
}
function toggleTrack(id: string) {
  selectedTrackIds.value = selectedTrackIds.value.includes(id)
    ? selectedTrackIds.value.filter(value => value !== id)
    : [...selectedTrackIds.value, id];
}
function formatDuration(seconds: number) {
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  return hours
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    : `${minutes}:${secs.toString().padStart(2, '0')}`;
}
function trackResultClass(id: string) {
  if (resultState.value?.failedTrackIds.includes(id)) {
    return trackImportResults.value[id]?.status === 'failed' ? 'import-error' : 'unavailable';
  }
  if (resultState.value?.completedTrackIds.includes(id)) return 'complete';
  return '';
}
function trackMatchText(id: string) {
  if (resultState.value?.failedTrackIds.includes(id)) {
    const reason = trackImportResults.value[id]?.reason;
    return reason
      ? `${t('spotifyImport.matchImportFailed')}: ${reason}`
      : t('spotifyImport.matchFailed');
  }
  if (resultState.value?.completedTrackIds.includes(id)) return t('spotifyImport.matchComplete');
  return t('spotifyImport.matchPending');
}
function toggleImportedPreview(id: string) {
  const uuid = trackImportResults.value[id]?.itemUuid;
  if (!uuid) return;
  if (previewItemUuid.value === uuid) void stopPreview();
  else void startPreview(uuid);
}
function resumeImport() {
  if (pendingRecoveryFiles.value.length) {
    void resumeRecoveredFiles();
    return;
  }
  retryFailed();
}

function handleSubmit() {
  if (resultState.value && !isActive.value) {
    if (pendingRecoveryCount.value) resumeImport();
    else continueToProject();
    return;
  }
  if (reviewState.value) void startDownload();
  else void reviewSpotify();
}

function continueToProject() {
  handleClose();
}

function retryFailed() {
  if (!resultState.value?.failedTrackIds.length) return;
  selectedTrackIds.value = [...resultState.value.failedTrackIds];
  retryingFailed.value = true;
  void startDownload();
}

async function resumeRecoveredFiles() {
  const previous = resultState.value;
  if (!previous || !pendingRecoveryFiles.value.length || isBusy.value) return;
  const files = [...pendingRecoveryFiles.value];
  const trackIds = [...pendingRecoveryTrackIds.value];
  const controller = new AbortController();
  const jobId = crypto.randomUUID();
  activeJobId.value = jobId;
  importAbortController.value = controller;
  isImportingCues.value = true;
  errorMessage.value = '';
  technicalMessage.value = '';
  progressState.value = {
    jobId,
    status: 'importing',
    playlistName: previous.playlistName,
    total: previous.total,
    completed: previous.completed,
    message: t('spotifyImport.status.importing'),
  };
  try {
    const imported = await props.importFiles(files, controller.signal, {
      groupName: previous.playlistName,
      templateFolderPath: previous.projectFolderPath,
      existingGroupUuid: previous.groupUuid,
    });
    const successfulTrackIds: string[] = [];
    const verificationFailedIds: string[] = [];
    const importResults = imported.results ?? (imported.success
      ? files.map(sourcePath => ({ sourcePath, status: 'ready' as const }))
      : []);
    for (const [index, item] of importResults.entries()) {
      const id = trackIds[index];
      if (!id) continue;
      trackImportResults.value[id] = item;
      if (item.status === 'failed') verificationFailedIds.push(id);
      else successfulTrackIds.push(id);
    }
    const completedTrackIds = [...new Set([
      ...previous.completedTrackIds,
      ...successfulTrackIds,
    ])];
    const failedTrackIds = [...new Set([
      ...previous.failedTrackIds,
      ...verificationFailedIds,
    ])].filter(id => !completedTrackIds.includes(id));
    pendingRecoveryFiles.value = [];
    pendingRecoveryTrackIds.value = [];
    const resumed: SpotifyDownloadResult = {
      ...previous,
      files: [],
      completedTrackIds,
      failedTrackIds,
      completed: completedTrackIds.length,
      partial: failedTrackIds.length > 0,
      groupUuid: imported.groupUuid || previous.groupUuid,
    };
    resultState.value = resumed;
    progressState.value = {
      jobId,
      status: resumed.partial ? 'partial' : 'complete',
      playlistName: resumed.playlistName,
      total: resumed.total,
      completed: resumed.completed,
    };
    technicalMessage.value = imported.error || '';
    await persistRecovery(resumed);
  } catch (error: any) {
    errorMessage.value = error?.message || t('spotifyImport.recoveryFailed');
    progressState.value = {
      jobId,
      status: 'partial',
      playlistName: previous.playlistName,
      total: previous.total,
      completed: previous.completed,
    };
  } finally {
    activeJobId.value = '';
    isImportingCues.value = false;
    isCancelling.value = false;
    importAbortController.value = null;
  }
}

async function openResultFolder() {
  const folderPath = resultState.value?.projectFolderPath;
  if (!folderPath || !import.meta.client) return;
  try {
    const result = await window.electronAPI.openFolder(folderPath);
    if (!result.success) throw new Error(result.error);
  } catch (error: any) {
    errorMessage.value = error?.message || t('spotifyImport.openFolderFailed');
  }
}

async function startAnotherImport() {
  if (props.projectFolderPath) {
    await getSpotifyApi()?.clearSpotifyImportRecovery(props.projectFolderPath).catch(() => {});
  }
  const destination = destinationParentPath.value;
  resetState();
  destinationParentPath.value = destination;
  await nextTick();
  urlInput.value?.focus();
}

function normalizeSpotifyUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return '';
    if (['spotify.link', 'spotify.app.link'].includes(url.hostname)) {
      return /^\/[A-Za-z0-9_-]{3,128}\/?$/.test(url.pathname) ? url.toString() : '';
    }
    if (url.hostname !== 'open.spotify.com') return '';
    const parts = url.pathname.split('/').filter(Boolean);
    if (/^intl-[a-z]{2}(?:-[a-z]{2})?$/i.test(parts[0] || '')) parts.shift();
    const [type, id] = parts;
    if (parts.length !== 2 ||
        !['track', 'album', 'playlist', 'artist'].includes(type || '') ||
        !/^[A-Za-z0-9]{10,64}$/.test(id || '')) return '';
    return `https://open.spotify.com/${type}/${id}`;
  } catch {
    return '';
  }
}

async function startDownload() {
  const api = getSpotifyApi();
  if (!api) {
    errorMessage.value = t('spotifyImport.unavailable');
    return;
  }
  if (!normalizedUrl.value) {
    errorMessage.value = t('spotifyImport.invalidUrl');
    return;
  }
  if (!props.projectFolderPath || isActive.value) return;
  if (!reviewState.value || selectedTrackIds.value.length === 0) return;

  const projectFolderPath = props.projectFolderPath;
  const projectEpoch = props.projectEpoch;
  const destinationParentPathForJob =
    destinationParentPath.value || await chooseDestination();
  if (!destinationParentPathForJob ||
      props.projectFolderPath !== projectFolderPath ||
      props.projectEpoch !== projectEpoch) return;

  const jobId = crypto.randomUUID();
  const retry = retryingFailed.value;
  const previousResult = retry ? resultState.value : null;
  const previousGroupUuid = previousResult?.groupUuid;
  const attemptedTrackIds = [...selectedTrackIds.value];
  if (!retry) trackImportResults.value = {};
  const importController = new AbortController();
  activeJobId.value = jobId;
  importAbortController.value = importController;
  isCancelling.value = false;
  isImportingCues.value = false;
  errorMessage.value = '';
  technicalMessage.value = '';
  resultState.value = null;
  progressState.value = {
    jobId,
    status: 'preparing',
    total: 0,
    completed: 0,
  };

  let needsFinalize = false;
  let finalizeKeepFiles = false;
  let downloadResult: SpotifyDownloadResult | null = null;
  try {
    downloadResult = await api.downloadSpotifyAudio(
      jobId,
      normalizedUrl.value,
      destinationParentPathForJob,
      {
        preflightId: reviewState.value.preflightId,
        selectedTrackIds: attemptedTrackIds,
        reusePreviousFolder: retry,
        activeProjectFolderPath: projectFolderPath,
        audioBitrate: audioBitrate.value,
        ...(previousResult?.projectFolderPath
          ? { existingProjectFolderPath: previousResult.projectFolderPath }
          : {}),
      },
      (progress) => {
        if (progress.jobId !== activeJobId.value) return;
        progressState.value = progress;
      },
    );

    needsFinalize = true;
    // ponytail: once files reach the user-selected collection, preserve them as canonical media.
    finalizeKeepFiles = true;
    if (props.projectFolderPath !== projectFolderPath ||
        props.projectEpoch !== projectEpoch) {
      importController.abort();
      throw new Error(t('spotifyImport.cancelled'));
    }
    isImportingCues.value = true;
    progressState.value = {
      jobId,
      status: 'importing',
      playlistName: progressState.value?.playlistName,
      total: downloadResult.total,
      completed: downloadResult.completed,
      message: t('spotifyImport.status.importing'),
    };
    const downloadedTrackIds = [...downloadResult.completedTrackIds];
    const imported = await props.importFiles(downloadResult.files, importController.signal, {
      groupName: downloadResult.playlistName,
      templateFolderPath: downloadResult.projectFolderPath,
      existingGroupUuid: previousGroupUuid || downloadResult.groupUuid,
    });
    isImportingCues.value = false;
    for (const [index, result] of (imported.results ?? []).entries()) {
      const id = downloadedTrackIds[index];
      if (id) trackImportResults.value[id] = result;
    }
    downloadResult.groupUuid = imported.groupUuid || downloadResult.groupUuid || previousGroupUuid;
    const verificationFailedIds = (imported.results ?? [])
      .map((result, index) => result.status === 'failed'
        ? downloadedTrackIds[index]
        : '')
      .filter(Boolean);
    downloadResult.failedTrackIds = [...new Set([
      ...downloadResult.failedTrackIds,
      ...verificationFailedIds,
    ])];
    downloadResult.completedTrackIds = downloadResult.completedTrackIds
      .filter(id => !downloadResult!.failedTrackIds.includes(id));
    if (previousResult) {
      downloadResult.completedTrackIds = [...new Set([
        ...previousResult.completedTrackIds,
        ...downloadResult.completedTrackIds,
      ])];
      downloadResult.failedTrackIds = [...new Set([
        ...previousResult.failedTrackIds.filter(id => !attemptedTrackIds.includes(id)),
        ...downloadResult.failedTrackIds,
      ])];
      downloadResult.total = previousResult.total;
    }
    downloadResult.completed = downloadResult.completedTrackIds.length;
    downloadResult.partial = downloadResult.partial || downloadResult.failedTrackIds.length > 0;
    pendingRecoveryFiles.value = [];
    pendingRecoveryTrackIds.value = [];
    const importSucceeded =
      imported.success && imported.imported === downloadResult.files.length;
    // The selected collection is the media library, so downloaded files are never disposable copies.
    const keepFiles = true;
    finalizeKeepFiles = keepFiles;
    if (downloadResult.partial) await persistRecovery(downloadResult);
    const finalized = await api.finalizeSpotifyImport(jobId, keepFiles);
    needsFinalize = false;
    if (!importSucceeded || !finalized) {
      throw new Error(imported.error || t('spotifyImport.cueImportFailed'));
    }

    if (!downloadResult.partial) {
      await api.clearSpotifyImportRecovery(projectFolderPath);
    }

    resultState.value = downloadResult;
    progressState.value = {
      jobId,
      status: downloadResult.partial ? 'partial' : 'complete',
      playlistName: downloadResult.playlistName,
      total: downloadResult.total,
      completed: downloadResult.completed,
      message: progressState.value?.message,
    };

    technicalMessage.value = downloadResult.error || '';
  } catch (error: any) {
    if (finalizeKeepFiles && error?.message) {
      if (downloadResult) resultState.value = downloadResult;
      errorMessage.value = error.message;
      progressState.value = {
        jobId,
        status: 'partial',
        playlistName: downloadResult?.playlistName || progressState.value?.playlistName,
        total: downloadResult?.total ?? progressState.value?.total ?? 0,
        completed: downloadResult?.completed ?? progressState.value?.completed ?? 0,
      };
    } else if (isCancelling.value ||
        importController.signal.aborted ||
        progressState.value?.status === 'cancelled') {
      errorMessage.value = t('spotifyImport.cancelled');
      progressState.value = {
        jobId,
        status: 'cancelled',
        total: progressState.value?.total ?? 0,
        completed: progressState.value?.completed ?? 0,
      };
    } else {
      errorMessage.value = error?.message || t('spotifyImport.downloadFailed');
      progressState.value = null;
    }
  } finally {
    if (needsFinalize) {
      await api.finalizeSpotifyImport(jobId, finalizeKeepFiles).catch(() => {});
    }
    activeJobId.value = '';
    isCancelling.value = false;
    isImportingCues.value = false;
    importAbortController.value = null;
    retryingFailed.value = false;
  }
}

async function cancelDownload() {
  const api = getSpotifyApi();
  if (!api || isCancelling.value) return;
  if (reviewJobId.value) {
    isCancelling.value = true;
    try {
      await api.cancelSpotifyPreflight(reviewJobId.value);
    } finally {
      isCancelling.value = false;
    }
    return;
  }
  if (!activeJobId.value) return;
  isCancelling.value = true;
  importAbortController.value?.abort();
  if (isImportingCues.value) return;
  try {
    const cancelled = await api.cancelSpotifyDownload(activeJobId.value);
    if (!cancelled) {
      errorMessage.value = t('spotifyImport.cancelFailed');
      isCancelling.value = false;
    }
  } catch (error: any) {
    errorMessage.value = error?.message || t('spotifyImport.cancelFailed');
    isCancelling.value = false;
  }
}

function handleClose() {
  if (isBusy.value) return;
  resetState();
  emit('close');
}

function resetState() {
  suppressUrlReset.value = true;
  spotifyUrl.value = '';
  activeJobId.value = '';
  reviewJobId.value = '';
  progressState.value = null;
  resultState.value = null;
  errorMessage.value = '';
  technicalMessage.value = '';
  isCancelling.value = false;
  isChoosingDestination.value = false;
  reviewState.value = null;
  selectedTrackIds.value = [];
  trackImportResults.value = {};
  retryingFailed.value = false;
  pendingRecoveryFiles.value = [];
  pendingRecoveryTrackIds.value = [];
  restoringRecovery.value = false;
  isReviewing.value = false;
  settingsSaveError.value = '';
  nextTick(() => { suppressUrlReset.value = false; });
}
</script>

<style scoped lang="scss">
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-lg);
  background: var(--dialog-backdrop);
}

.modal {
  width: min(760px, 100%);
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--dialog-radius);
  background: var(--dialog-surface);
  color: var(--color-text-primary);
  box-shadow: var(--dialog-shadow);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--dialog-header-padding);
  border-bottom: 1px solid var(--color-border);

  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 650;
  }
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;

  &:hover:not(:disabled) {
    background: var(--color-surface-hover);
    color: var(--color-text-primary);
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}

.modal-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: var(--dialog-body-padding);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

input {
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background);
  color: var(--color-text-primary);
  padding: 10px 12px;
  font-size: 13px;

  &:focus {
    outline: none;
    border-color: var(--color-accent);
  }

  &:disabled {
    opacity: 0.7;
  }
}

.hint {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.import-plan {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background);

    .plan-title,
  p,
  dl,
  dd {
    margin: 0;
  }

    .plan-title {
    font-size: 13px;
    font-weight: 650;
  }
}

.plan-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: var(--color-text-primary);
  text-align: left;
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
    border-radius: 4px;
  }
}

.plan-chevron {
  font-size: 18px;
  color: var(--color-text-tertiary);
  transition: transform 0.15s ease;

  &.open { transform: rotate(90deg); }
}

.plan-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  color: var(--color-text-tertiary);
  font-size: 11px;
  font-weight: 400;
}

.plan-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.plan-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.plan-row {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr);
  align-items: start;
  gap: 10px;
  font-size: 12px;

  dt {
    color: var(--color-text-tertiary);
  }

  dd {
    color: var(--color-text-primary);
    overflow-wrap: anywhere;
  }
}

.destination-row dd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.path-value {
  min-width: 0;
  color: var(--color-text-secondary);
}

.plan-note {
  padding-top: 9px;
  border-top: 1px solid var(--color-border);
  font-size: 12px;
  line-height: 1.45;
  color: var(--color-text-secondary);
}

.processing-summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.processing-title {
  grid-column: 1 / -1;
  font-size: 11px;
  font-weight: 650;
  color: var(--color-text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.processing-control {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 32px;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: var(--color-surface-raised);
  color: var(--color-text-primary);
  font-size: 12px;
  cursor: pointer;

  input[type='checkbox'] {
    flex: none;
    width: 15px;
    height: 15px;
    margin: 0;
    padding: 0;
    accent-color: var(--color-accent);
  }

  span {
    min-width: 0;
    line-height: 1.3;
  }

  &:has(:focus-visible) {
    border-color: var(--color-accent);
    outline: 2px solid color-mix(in srgb, var(--color-accent) 30%, transparent);
    outline-offset: 1px;
  }
}

.processing-control--select {
  grid-column: 1 / -1;
  justify-content: space-between;

  select {
    min-width: min(240px, 55%);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-background);
    color: var(--color-text-primary);
    padding: 6px 28px 6px 8px;
    font: inherit;
  }
}

.settings-save-error {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--color-danger);
  font-size: 11px;
}

.track-review {
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background);
}

.review-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 9px;

  h3, p { margin: 0; }
  h3 { font-size: 13px; }
  p { margin-top: 3px; color: var(--color-text-secondary); font-size: 11px; }
}

.review-actions { display: flex; gap: 6px; }

.track-list {
  max-height: 300px;
  overflow-y: auto;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--color-border);
  list-style: none;

  li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    border-bottom: 1px solid var(--color-border);
  }
  li.complete .track-info > small { color: var(--color-success); }
  li.unavailable .track-info > small { color: var(--color-text-secondary); }
  li.import-error .track-info > small { color: var(--color-danger); }
  label {
    display: grid;
    width: 100%;
    min-width: 0;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 9px;
    padding: 7px 6px;
    cursor: pointer;
  }
  label.has-cover { grid-template-columns: auto 36px minmax(0, 1fr) auto; }
  input { width: auto; margin: 0; padding: 0; }
  img { width: 36px; height: 36px; border-radius: 3px; object-fit: cover; }
  .track-info { min-width: 0; display: grid; gap: 2px; }
  .track-info > strong,
  .track-info > span,
  .track-info > small { overflow-wrap: anywhere; }
  .track-info > strong { font-size: 13px; line-height: 1.3; }
  .track-info > span { color: var(--color-text-secondary); font-size: 11px; }
  .track-info > small { color: var(--color-text-tertiary); font-size: 11px; line-height: 1.35; }
  time {
    color: var(--color-text-secondary);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .track-preview {
    display: inline-grid; place-items: center;
    width: 28px; height: 28px; margin-right: 6px;
    border: 1px solid var(--color-border); border-radius: 6px;
    background: var(--color-surface-raised); color: var(--color-text-primary); cursor: pointer;
    .material-symbols-rounded { font-size: 16px; }
  }
}

.status-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface-raised);
}

.status-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.status-label,
.status-detail,
.status-count,
.status-error {
  margin: 0;
}

.open-folder {
  align-self: flex-start;
}

.status-label {
  font-size: 13px;
  font-weight: 600;
}

.status-detail,
.status-count {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.status-error {
  font-size: 12px;
  color: #f28b82;
}

.status-card.has-ready-tracks:not(.has-import-errors) {
  border-color: color-mix(in srgb, var(--color-success) 45%, var(--color-border));
  background: color-mix(in srgb, var(--color-success) 7%, var(--color-surface-raised));

  .progress-fill {
    background: var(--color-success);
  }
}

.status-card.has-import-errors {
  border-color: color-mix(in srgb, var(--color-warning) 55%, var(--color-border));
}

.status-technical {
  font-size: 11px;
  color: var(--color-text-tertiary);

  summary {
    width: max-content;
    cursor: pointer;
    color: var(--color-text-secondary);
  }

  p {
    margin: 6px 0 0;
    overflow-wrap: anywhere;
  }
}

.progress-bar {
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-border) 70%, transparent);
}

.progress-fill {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  background: var(--color-accent);
  transform-origin: left center;
  transition: transform 140ms ease;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.btn {
  min-height: 34px;
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface-raised);
  color: var(--color-text-primary);
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;

  &:hover:not(:disabled) {
    background: var(--color-surface-hover);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  &.primary {
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: var(--color-text-on-accent);

    &:hover:not(:disabled) {
      background: color-mix(in srgb, var(--color-accent) 88%, white);
    }
  }

  &.compact {
    flex: none;
    min-height: 28px;
    padding: 3px 8px;
  }

  .material-symbols-rounded {
    font-size: 18px;
  }
}

@media (max-width: 520px) {
  .processing-summary {
    grid-template-columns: 1fr;
  }

  .processing-control--select {
    align-items: stretch;
    flex-direction: column;

    select { min-width: 100%; }
  }

  .destination-row dd {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
