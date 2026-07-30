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
            :disabled="isActive"
            @click="handleClose"
          >
            <span class="material-symbols-rounded" aria-hidden="true">close</span>
          </button>
        </header>

        <form class="modal-body" @submit.prevent="startDownload">
          <label class="field">
            <span class="field-label">{{ t('spotifyImport.urlLabel') }}</span>
            <input
              ref="urlInput"
              v-model.trim="spotifyUrl"
              type="url"
              :placeholder="t('spotifyImport.urlPlaceholder')"
              :disabled="isActive"
              spellcheck="false"
              autocomplete="off"
            >
          </label>

          <p class="hint">{{ t('spotifyImport.hint') }}</p>

          <div v-if="progressState || resultState || errorMessage" class="status-card">
            <div class="status-top">
              <div>
                <p class="status-label">{{ statusText }}</p>
                <p v-if="progressState?.playlistName" class="status-detail">{{ progressState.playlistName }}</p>
                <p v-else-if="progressState?.message" class="status-detail">{{ progressState.message }}</p>
              </div>
              <p v-if="countText" class="status-count">{{ countText }}</p>
            </div>

            <div class="progress-bar" aria-hidden="true">
              <div class="progress-fill" :style="{ width: `${progressPercent}%` }" />
            </div>

            <p v-if="errorMessage" class="status-error">{{ errorMessage }}</p>
          </div>

          <div class="actions">
            <button type="submit" class="btn primary" :disabled="!canStart">
              <span class="material-symbols-rounded" aria-hidden="true">library_add</span>
              <span>{{ isActive ? t('spotifyImport.downloading') : t('spotifyImport.downloadAndAdd') }}</span>
            </button>
            <button
              v-if="isActive"
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
}

interface ImportBatchResult {
  success: boolean;
  imported: number;
  error?: string;
  retainFiles?: boolean;
}

interface SpotifyElectronApi {
  downloadSpotifyAudio: (
    jobId: string,
    url: string,
    projectFolderPath: string,
    progressCallback: (progress: SpotifyDownloadProgress) => void,
  ) => Promise<SpotifyDownloadResult>;
  cancelSpotifyDownload: (jobId: string) => Promise<boolean>;
  finalizeSpotifyImport: (jobId: string, keepFiles: boolean) => Promise<boolean>;
}

const props = defineProps<{
  open: boolean;
  projectFolderPath: string;
  projectEpoch: number;
  importFiles: (files: string[], signal?: AbortSignal) => Promise<ImportBatchResult>;
}>();

const emit = defineEmits<{
  close: [];
}>();

const { t } = useLocalization();

const titleId = `spotify-import-${Math.random().toString(36).slice(2)}`;
const urlInput = ref<HTMLInputElement | null>(null);
const spotifyUrl = ref('');
const activeJobId = ref('');
const progressState = ref<SpotifyDownloadProgress | null>(null);
const resultState = ref<SpotifyDownloadResult | null>(null);
const errorMessage = ref('');
const isCancelling = ref(false);
const isImportingCues = ref(false);
const importAbortController = ref<AbortController | null>(null);

const isActive = computed(() => !!activeJobId.value);
const normalizedUrl = computed(() => normalizeSpotifyUrl(spotifyUrl.value));
const canStart = computed(() =>
  !!props.projectFolderPath && !!normalizedUrl.value && !isActive.value,
);

const progressPercent = computed(() => {
  const source = resultState.value ?? progressState.value;
  if (!source?.total) return progressState.value ? 8 : 0;
  return Math.max(8, Math.min(100, (source.completed / source.total) * 100));
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
    if (!open && isActive.value) {
      void cancelDownload();
      return;
    }
    if (!open && !isActive.value) {
      resetState();
      return;
    }
    if (open) {
      nextTick(() => urlInput.value?.focus());
    }
  },
);

watch(spotifyUrl, () => {
  if (isActive.value) return;
  errorMessage.value = '';
  resultState.value = null;
  progressState.value = null;
});

watch(
  () => [props.projectFolderPath, props.projectEpoch] as const,
  ([folderPath, epoch], [previousFolderPath, previousEpoch]) => {
    if (isActive.value &&
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
});

function getSpotifyApi(): (Window['electronAPI'] & SpotifyElectronApi) | null {
  if (!import.meta.client) return null;
  const api = window.electronAPI as (Window['electronAPI'] & Partial<SpotifyElectronApi>) | undefined;
  if (!api?.downloadSpotifyAudio ||
      !api?.cancelSpotifyDownload ||
      !api?.finalizeSpotifyImport) {
    return null;
  }
  return api as Window['electronAPI'] & SpotifyElectronApi;
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

  const jobId = crypto.randomUUID();
  const projectFolderPath = props.projectFolderPath;
  const projectEpoch = props.projectEpoch;
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
  try {
    const result = await api.downloadSpotifyAudio(
      jobId,
      normalizedUrl.value,
      projectFolderPath,
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
      total: result.total,
      completed: result.completed,
      message: t('spotifyImport.status.importing'),
    };
    const imported = await props.importFiles(result.files, importController.signal);
    isImportingCues.value = false;
    const importSucceeded =
      imported.success && imported.imported === result.files.length;
    const keepFiles = importSucceeded || imported.retainFiles === true;
    finalizeKeepFiles = keepFiles;
    const finalized = await api.finalizeSpotifyImport(jobId, keepFiles);
    needsFinalize = false;
    if (!importSucceeded || !finalized) {
      throw new Error(imported.error || t('spotifyImport.cueImportFailed'));
    }

    resultState.value = result;
    progressState.value = {
      jobId,
      status: result.partial ? 'partial' : 'complete',
      playlistName: progressState.value?.playlistName,
      total: result.total,
      completed: result.completed,
      message: progressState.value?.message,
    };

    if (result.error) {
      errorMessage.value = result.error;
    } else if (result.partial) {
      errorMessage.value = t('spotifyImport.partialWarning');
    }
  } catch (error: any) {
    if (isCancelling.value ||
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
  }
}

async function cancelDownload() {
  const api = getSpotifyApi();
  if (!api || !activeJobId.value || isCancelling.value) return;
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
  if (isActive.value) return;
  resetState();
  emit('close');
}

function resetState() {
  spotifyUrl.value = '';
  activeJobId.value = '';
  progressState.value = null;
  resultState.value = null;
  errorMessage.value = '';
  isCancelling.value = false;
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
  width: min(460px, 100%);
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

  .material-symbols-rounded {
    font-size: 18px;
  }
}
</style>
