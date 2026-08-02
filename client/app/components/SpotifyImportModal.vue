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

        <form class="modal-body" @submit.prevent="reviewState ? startDownload() : reviewSpotify()">
          <label class="field">
            <span class="field-label">{{ t('spotifyImport.urlLabel') }}</span>
            <input
              ref="urlInput"
              v-model.trim="spotifyUrl"
              type="url"
              :placeholder="t('spotifyImport.urlPlaceholder')"
              :disabled="isBusy"
              spellcheck="false"
              autocomplete="off"
            >
          </label>

          <p class="hint">{{ t('spotifyImport.hint') }}</p>

          <section class="import-plan" :aria-labelledby="planId">
            <h3 :id="planId">{{ t('spotifyImport.importPlan') }}</h3>

            <dl class="plan-list">
              <div class="plan-row">
                <dt>{{ t('spotifyImport.source') }}</dt>
                <dd>{{ sourceTypeText }}</dd>
              </div>
              <div class="plan-row">
                <dt>{{ t('spotifyImport.audioFormat') }}</dt>
                <dd>{{ t('spotifyImport.audioFormatValue') }}</dd>
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
                    :disabled="isBusy || isChoosingDestination"
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
              <ul>
                <li>
                  <span>{{ t('settings.transitionMode') }}</span>
                  <strong>{{ cueProcessingSettings.transition }}</strong>
                </li>
                <li>
                  <span>{{ t('settings.autoTrimSilenceOnImport') }}</span>
                  <strong>{{ settingStateText(cueProcessingSettings.trimSilence) }}</strong>
                </li>
                <li>
                  <span>{{ t('settings.autoMatchLoudnessOnImport') }}</span>
                  <strong>{{ settingStateText(cueProcessingSettings.matchLoudness) }}</strong>
                </li>
                <li>
                  <span>{{ t('settings.autoReduceTruePeaksOnImport') }}</span>
                  <strong>{{ settingStateText(cueProcessingSettings.reduceTruePeaks) }}</strong>
                </li>
                <li>
                  <span>{{ t('settings.cycleTrackColors') }}</span>
                  <strong>{{ settingStateText(cueProcessingSettings.cycleColors) }}</strong>
                </li>
              </ul>
            </div>
          </section>

          <section v-if="reviewState" class="track-review" :aria-label="t('spotifyImport.reviewTitle')">
            <div class="review-heading">
              <div>
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
                <label>
                  <input
                    type="checkbox"
                    :checked="selectedTrackIds.includes(track.id)"
                    :disabled="isBusy"
                    @change="toggleTrack(track.id)"
                  >
                  <img v-if="track.coverUrl" :src="track.coverUrl" alt="">
                  <span class="track-info">
                    <strong>{{ track.title }}</strong>
                    <span>{{ track.artists.join(', ') }}<template v-if="track.album"> · {{ track.album }}</template></span>
                    <small>{{ trackMatchText(track.id) }}</small>
                  </span>
                  <time>{{ formatDuration(track.duration) }}</time>
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
          >
            <div
              class="status-top"
              role="status"
              aria-live="polite"
              aria-atomic="false"
            >
              <div>
                <p class="status-label">{{ statusText }}</p>
                <p v-if="progressState?.playlistName" class="status-detail">{{ progressState.playlistName }}</p>
                <p v-if="progressState?.message && isActive" class="status-detail">{{ progressState.message }}</p>
                <p v-if="resultState" class="status-detail">
                  {{ t('spotifyImport.completionSummary', {
                    completed: resultState.completed,
                    total: resultState.total,
                  }) }}
                </p>
                <p v-if="resultState?.projectFolderPath" class="status-detail">{{ resultState.projectFolderPath }}</p>
              </div>
              <p v-if="countText" class="status-count">{{ countText }}</p>
            </div>

            <div
              class="progress-bar"
              role="progressbar"
              :aria-label="t('spotifyImport.progressLabel')"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="progressValue"
              :aria-valuetext="countText || statusText"
            >
              <div class="progress-fill" :style="{ width: `${progressPercent}%` }" />
            </div>

            <p v-if="errorMessage" class="status-error" role="alert">{{ errorMessage }}</p>
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
              v-if="resultState?.failedTrackIds?.length && !isActive"
              type="button"
              class="btn"
              @click="retryFailed"
            >{{ t('spotifyImport.retryFailed') }}</button>
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
    selection: { preflightId: string; selectedTrackIds: string[]; reusePreviousFolder?: boolean },
    progressCallback: (progress: SpotifyDownloadProgress) => void,
  ) => Promise<SpotifyDownloadResult>;
  preflightSpotify: (jobId: string, url: string) => Promise<SpotifyPreflight>;
  cancelSpotifyPreflight: (jobId: string) => Promise<boolean>;
  cancelSpotifyDownload: (jobId: string) => Promise<boolean>;
  finalizeSpotifyImport: (jobId: string, keepFiles: boolean) => Promise<boolean>;
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
const { currentProject, previewItemUuid, startPreview, stopPreview } = useProject();

const titleId = `spotify-import-${Math.random().toString(36).slice(2)}`;
const planId = `${titleId}-plan`;
const urlInput = ref<HTMLInputElement | null>(null);
const spotifyUrl = ref('');
const destinationParentPath = ref('');
const activeJobId = ref('');
const reviewJobId = ref('');
const progressState = ref<SpotifyDownloadProgress | null>(null);
const resultState = ref<SpotifyDownloadResult | null>(null);
const errorMessage = ref('');
const reviewState = ref<SpotifyPreflight | null>(null);
const trackImportResults = ref<Record<string, NonNullable<ImportBatchResult['results']>[number]>>({});
const selectedTrackIds = ref<string[]>([]);
const isReviewing = ref(false);
const isCancelling = ref(false);
const isImportingCues = ref(false);
const isChoosingDestination = ref(false);
const importAbortController = ref<AbortController | null>(null);
const retryingFailed = ref(false);

const isActive = computed(() => !!activeJobId.value);
const isBusy = computed(() => isActive.value || isReviewing.value);
const normalizedUrl = computed(() => normalizeSpotifyUrl(spotifyUrl.value));
const canStart = computed(() => !!props.projectFolderPath && !!normalizedUrl.value &&
  !isBusy.value && !isChoosingDestination.value &&
  (!reviewState.value || selectedTrackIds.value.length > 0));
const selectedDuration = computed(() => reviewState.value?.tracks
  .filter(track => selectedTrackIds.value.includes(track.id))
  .reduce((sum, track) => sum + track.duration, 0) ?? 0);

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
    transition: settings?.defaultTransitionMode === 'start-next'
      ? t('settings.transitionModeStartNext')
      : t('settings.transitionModeCrossfade'),
    trimSilence: settings?.autoTrimSilenceOnImport === true,
    matchLoudness: settings?.autoMatchLoudnessOnImport === true,
    reduceTruePeaks: settings?.autoReduceTruePeaksOnImport !== false,
    cycleColors: settings?.cycleTrackColors !== false,
  };
});

const progressPercent = computed(() => {
  const source = resultState.value ?? progressState.value;
  if (!source?.total) return progressState.value ? 8 : 0;
  return Math.max(8, Math.min(100, (source.completed / source.total) * 100));
});

const progressValue = computed(() => {
  const source = resultState.value ?? progressState.value;
  return source?.total ? Math.round(progressPercent.value) : undefined;
});

const statusText = computed(() => {
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
  if (isActive.value) return;
  errorMessage.value = '';
  resultState.value = null;
  progressState.value = null;
  reviewState.value = null;
  selectedTrackIds.value = [];
  trackImportResults.value = {};
  retryingFailed.value = false;
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
      !api?.preflightSpotify) {
    return null;
  }
  return api as Window['electronAPI'] & SpotifyElectronApi;
}

function settingStateText(enabled: boolean): string {
  return enabled ? t('spotifyImport.settingOn') : t('spotifyImport.settingOff');
}

async function chooseDestination(): Promise<string> {
  const api = getSpotifyApi();
  if (!api || isActive.value || isChoosingDestination.value) return '';
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
  if (!import.meta.client || destinationParentPath.value) return;
  const preferences = await window.electronAPI.getImportPreferences().catch(() => null);
  if (preferences?.spotifyDestination) destinationParentPath.value = preferences.spotifyDestination;
}

async function reviewSpotify() {
  const api = getSpotifyApi();
  if (!api || !normalizedUrl.value || isBusy.value) return;
  isReviewing.value = true;
  const jobId = crypto.randomUUID();
  reviewJobId.value = jobId;
  errorMessage.value = '';
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
  if (resultState.value?.failedTrackIds.includes(id)) return 'failed';
  if (resultState.value?.completedTrackIds.includes(id)) return 'complete';
  return '';
}
function trackMatchText(id: string) {
  if (resultState.value?.failedTrackIds.includes(id)) {
    const reason = trackImportResults.value[id]?.reason;
    return reason ? `${t('spotifyImport.matchFailed')}: ${reason}` : t('spotifyImport.matchFailed');
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
function retryFailed() {
  if (!resultState.value?.failedTrackIds.length) return;
  selectedTrackIds.value = [...resultState.value.failedTrackIds];
  retryingFailed.value = true;
  void startDownload();
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
      },
      (progress) => {
        if (progress.jobId !== activeJobId.value) return;
        progressState.value = progress;
      },
    );

    needsFinalize = true;
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
      existingGroupUuid: previousGroupUuid,
    });
    isImportingCues.value = false;
    for (const [index, result] of (imported.results ?? []).entries()) {
      const id = downloadedTrackIds[index];
      if (id) trackImportResults.value[id] = result;
    }
    downloadResult.groupUuid = imported.groupUuid || previousGroupUuid;
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
    const importSucceeded =
      imported.success && imported.imported === downloadResult.files.length;
    const keepFiles = importSucceeded || imported.retainFiles === true;
    finalizeKeepFiles = keepFiles;
    const finalized = await api.finalizeSpotifyImport(jobId, keepFiles);
    needsFinalize = false;
    if (!importSucceeded || !finalized) {
      throw new Error(imported.error || t('spotifyImport.cueImportFailed'));
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

    if (downloadResult.error) {
      errorMessage.value = downloadResult.error;
    } else if (downloadResult.partial) {
      errorMessage.value = t('spotifyImport.partialWarning');
    }
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
  spotifyUrl.value = '';
  activeJobId.value = '';
  reviewJobId.value = '';
  progressState.value = null;
  resultState.value = null;
  errorMessage.value = '';
  isCancelling.value = false;
  isChoosingDestination.value = false;
  reviewState.value = null;
  selectedTrackIds.value = [];
  trackImportResults.value = {};
  retryingFailed.value = false;
  isReviewing.value = false;
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
  padding: 16px;
  background: rgba(0, 0, 0, 0.6);
}

.modal {
  width: min(760px, 100%);
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-surface);
  color: var(--color-text-primary);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 16px 12px;
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
  padding: 16px;
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

  h3,
  p,
  dl,
  dd {
    margin: 0;
  }

  h3 {
    font-size: 13px;
    font-weight: 650;
  }
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
  display: flex;
  flex-direction: column;
  gap: 6px;

  ul {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 5px 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
    font-size: 11px;
    color: var(--color-text-secondary);

    strong {
      flex: none;
      color: var(--color-text-primary);
      font-weight: 600;
    }
  }
}

.processing-title {
  font-size: 11px;
  font-weight: 650;
  color: var(--color-text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
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
  li.complete { box-shadow: inset 3px 0 #62c88b; }
  li.failed { box-shadow: inset 3px 0 #f28b82; }
  label {
    display: grid;
    min-width: 0;
    grid-template-columns: auto 36px minmax(0, 1fr) auto;
    align-items: center;
    gap: 9px;
    padding: 7px 6px;
    cursor: pointer;
  }
  input { width: auto; margin: 0; padding: 0; }
  img { width: 36px; height: 36px; border-radius: 3px; object-fit: cover; }
  .track-info { min-width: 0; display: grid; gap: 2px; }
  strong, span, small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  strong { font-size: 12px; }
  span { color: var(--color-text-secondary); font-size: 10px; }
  small { color: var(--color-text-tertiary); font-size: 9px; }
  time { color: var(--color-text-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
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

.progress-bar {
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-border) 70%, transparent);
}

.progress-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--color-accent);
  transition: width 140ms ease;
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
    color: #fff;
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
  .processing-summary ul {
    grid-template-columns: 1fr;
  }

  .destination-row dd {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
