<template>
  <div v-if="isOpen" class="modal-overlay" @click.self="closeModal">
    <div class="modal-content youtube-import-modal" role="dialog" aria-modal="true" :aria-labelledby="titleId">
      <div class="modal-header">
        <h2 :id="titleId">{{ t('youtube.importFromYouTube') }}</h2>
        <button type="button" class="close-btn" :aria-label="t('actions.close')" @click="closeModal">
          <span class="material-symbols-rounded" aria-hidden="true">close</span>
        </button>
      </div>

      <div class="modal-body">
        <!-- Search Bar -->
        <div class="search-section">
          <div class="search-bar">
            <input
              v-model="searchQuery"
              type="text"
              :aria-label="t('youtube.searchPlaceholder')"
              :placeholder="t('youtube.searchPlaceholder')"
              @keyup.enter="performSearch"
            />
            <button
              type="button"
              class="search-btn"
              :aria-label="t('youtube.searchPlaceholder')"
              :disabled="isSearching || !searchQuery.trim()"
              @click="performSearch"
            >
              <span class="material-symbols-rounded" aria-hidden="true">search</span>
            </button>
          </div>
          <p class="search-hint">{{ t('youtube.searchOrPaste') }}</p>
        </div>

        <section v-if="selectedVideo" class="import-plan" :aria-labelledby="planTitleId">
          <div class="plan-heading">
            <h3 :id="planTitleId">{{ t('youtube.importPlan') }}</h3>
            <label class="add-to-playlist-option">
              <input v-model="addDownloadedAudio" type="checkbox">
              <span>{{ t('youtube.addDownloadedAudio') }}</span>
            </label>
          </div>

          <div class="plan-grid">
            <div class="plan-field plan-selection">
              <span class="plan-label">{{ t('youtube.selectedVideo') }}</span>
              <strong :title="selectedVideo.title">{{ selectedVideo.title }}</strong>
              <span class="plan-detail">
                {{ selectedVideo.channelTitle }}<template v-if="selectedVideo.length"> · {{ selectedVideo.length }}</template>
              </span>
            </div>

            <div class="plan-field plan-destination">
              <span class="plan-label">{{ t('youtube.mediaDestination') }}</span>
              <strong :title="mediaDestination">{{ mediaDestination }}</strong>
            </div>

            <label class="plan-field plan-format">
              <span class="plan-label">{{ t('youtube.outputFormat') }}</span>
              <select v-model="outputMode">
                <option value="source">{{ t('youtube.outputFormatSource') }}</option>
                <option value="mp3">{{ t('youtube.outputFormatMp3V0') }}</option>
              </select>
            </label>

            <div class="plan-field plan-processing" :class="{ skipped: !addDownloadedAudio }">
              <span class="plan-label">{{ t('youtube.projectProcessing') }}</span>
              <div class="processing-list">
                <span v-for="setting in processingSettings" :key="setting.label">
                  {{ setting.label }}: {{ setting.value }}
                </span>
              </div>
              <span v-if="!addDownloadedAudio" class="plan-detail">{{ t('youtube.processingSkipped') }}</span>
            </div>
          </div>
        </section>

        <div class="content-container">
          <!-- Search Results -->
          <div class="results-section full-width">
            <div v-if="isSearching" class="loading-state">
              <span class="material-symbols-rounded spinning">progress_activity</span>
              <p>{{ t('youtube.searching') }}</p>
            </div>

            <div v-else-if="searchError" class="error-state">
              <span class="material-symbols-rounded">error</span>
              <p>{{ searchError }}</p>
            </div>

            <div v-else-if="searchResults.length === 0 && hasSearched" class="empty-state">
              <span class="material-symbols-rounded">search_off</span>
              <p>{{ t('youtube.noResults') }}</p>
            </div>

            <div v-else-if="searchResults.length > 0" class="results-list">
              <div
                v-for="video in searchResults"
                :key="video.id"
                class="video-item"
                :class="{ selected: selectedVideo?.id === video.id }"
                @click="selectedVideo = video"
              >
                <img :src="video.thumbnail" :alt="video.title" class="video-thumbnail" />
                <div class="video-info">
                  <div class="video-title-line">
                    <h3 class="video-title">{{ video.title }}</h3>
                    <span v-if="video.isLive" class="live-badge">{{ t('youtube.liveStream') }}</span>
                  </div>
                  <p class="video-channel">{{ video.channelTitle }}</p>
                  <p v-if="video.length" class="video-duration">{{ video.length }}</p>
                </div>
                <div class="video-actions">
                  <button type="button" class="action-btn preview-btn" @click="previewVideo(video)">
                    <span class="material-symbols-rounded" aria-hidden="true">play_circle</span>
                    <span>{{ t('youtube.preview') }}</span>
                  </button>
                  <button 
                    type="button"
                    class="action-btn download-btn" 
                    @click="downloadVideo(video)"
                    :disabled="video.isLive || isDownloading(video.id)"
                    :title="video.isLive ? t('youtube.liveUnsupported') : undefined"
                  >
                    <span class="material-symbols-rounded" aria-hidden="true">download</span>
                    <span>{{ isDownloading(video.id) ? t('youtube.downloading') : t('youtube.download') }}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Download Queue -->
        <div v-if="downloadQueue.length > 0" class="download-queue">
          <h3>{{ t('youtube.downloadQueue') }}</h3>
          <div class="queue-list">
            <div v-for="download in downloadQueue" :key="download.jobId" class="queue-item">
              <div class="queue-info">
                <span class="video-title">{{ download.title }}</span>
                <span class="queue-status" aria-live="polite">{{ getDownloadStatus(download) }}</span>
                <span class="queue-format">
                  {{ download.outputMode === 'source' ? t('youtube.outputFormatSource') : t('youtube.outputFormatMp3V0') }}
                </span>
                <span v-if="download.savedPath" class="saved-path" :title="download.savedPath">
                  {{ t('youtube.savedPath', { path: download.savedPath }) }}
                </span>
                <span v-if="download.actionError" class="queue-action-error">{{ download.actionError }}</span>
              </div>
              <div
                class="progress-bar"
                role="progressbar"
                :aria-label="download.title"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-valuenow="Math.round(download.progress)"
              >
                <div class="progress-fill" :style="{ width: download.progress + '%' }"></div>
              </div>
              <span class="progress-text">{{ download.progress.toFixed(1) }}%</span>
              <button
                v-if="download.folderPath"
                type="button"
                class="action-btn preview-btn open-folder-btn"
                @click="openDownloadFolder(download)"
              >
                <span class="material-symbols-rounded" aria-hidden="true">folder_open</span>
                <span>{{ t('youtube.openFolder') }}</span>
              </button>
              <button
                v-if="isActiveDownload(download)"
                type="button"
                class="action-btn cancel-btn"
                @click="cancelDownload(download)"
              >
                <span class="material-symbols-rounded" aria-hidden="true">close</span>
                <span>{{ t('youtube.cancel') }}</span>
              </button>
              <button
                v-else-if="download.status === 'error' || download.status === 'cancelled'"
                type="button"
                class="action-btn download-btn"
                @click="retryDownload(download)"
              >
                <span class="material-symbols-rounded" aria-hidden="true">refresh</span>
                <span>{{ t('youtube.retry') }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';

const { t } = useLocalization();
const { currentProject } = useProject();

interface YouTubeVideo {
  id: string;
  title: string;
  thumbnail: string;
  channelTitle: string;
  length?: string;
  isLive?: boolean;
}

interface ImportBatchResult {
  success: boolean;
  imported: number;
  error?: string;
  retainFiles?: boolean;
}

interface ImportBatchOptions {
  displayNames?: string[];
}

interface DownloadProgress {
  jobId: string;
  videoId: string;
  title: string;
  progress: number;
  status: 'downloading' | 'converting' | 'importing' | 'completed' | 'cancelled' | 'error';
  outputMode: 'source' | 'mp3';
  savedPath?: string;
  folderPath?: string;
  error?: string;
  actionError?: string;
}

const props = defineProps<{
  isOpen: boolean;
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

const searchQuery = ref('');
const searchResults = ref<YouTubeVideo[]>([]);
const isSearching = ref(false);
const hasSearched = ref(false);
const searchError = ref('');
const selectedVideo = ref<YouTubeVideo | null>(null);
const downloadQueue = ref<DownloadProgress[]>([]);
const storedOptions = (() => {
  try { return JSON.parse(localStorage.getItem('liveplay-youtube-import-options') || '{}'); }
  catch { return {}; }
})();
const addDownloadedAudio = ref(storedOptions.addDownloadedAudio !== false);
const outputMode = ref<'source' | 'mp3'>(storedOptions.outputMode === 'mp3' ? 'mp3' : 'source');
watch([addDownloadedAudio, outputMode], () => localStorage.setItem(
  'liveplay-youtube-import-options',
  JSON.stringify({ addDownloadedAudio: addDownloadedAudio.value, outputMode: outputMode.value }),
));
const titleId = `youtube-import-${Math.random().toString(36).slice(2)}`;
const planTitleId = `${titleId}-plan`;

const mediaDestination = computed(() => appendPath(props.projectFolderPath, 'media'));

const processingSettings = computed(() => {
  const settings = currentProject.value?.settings;
  return [
    {
      label: t('settings.transitionMode'),
      value: settings?.defaultTransitionMode === 'start-next'
        ? t('settings.transitionModeStartNext')
        : t('settings.transitionModeCrossfade'),
    },
    { label: t('youtube.trimSilence'), value: settingState(settings?.autoTrimSilenceOnImport === true) },
    { label: t('youtube.matchLoudness'), value: settingState(settings?.autoMatchLoudnessOnImport === true) },
    { label: t('youtube.truePeakProtection'), value: settingState(settings?.autoReduceTruePeaksOnImport !== false) },
    { label: t('youtube.cycleTrackColors'), value: settingState(settings?.cycleTrackColors !== false) },
  ];
});

function settingState(enabled: boolean): string {
  return enabled ? t('youtube.on') : t('youtube.off');
}

const performSearch = async () => {
  if (!searchQuery.value.trim()) return;

  isSearching.value = true;
  searchError.value = '';
  hasSearched.value = true;
  searchResults.value = [];

  try {
    const videoId = extractYouTubeVideoId(searchQuery.value);
    const results = videoId
      ? [await window.electronAPI.getYouTubeInfo(videoId)]
      : await window.electronAPI.searchYouTube(searchQuery.value);
    searchResults.value = results;
    selectedVideo.value = results[0] ?? null;
  } catch (error: any) {
    searchError.value = error.message || t('youtube.searchError');
    console.error('YouTube search error:', error);
  } finally {
    isSearching.value = false;
  }
};

const previewVideo = (video: YouTubeVideo) => {
  selectedVideo.value = video;
  // Open in system browser instead of iframe (works in production)
  if (import.meta.client && window.electronAPI) {
    window.electronAPI.openExternal(`https://www.youtube.com/watch?v=${video.id}`);
  }
};

const downloadVideo = async (video: YouTubeVideo) => {
  if (video.isLive || isDownloading(video.id)) return;

  const projectFolderPath = props.projectFolderPath;
  const projectEpoch = props.projectEpoch;
  if (!projectFolderPath) return;

  selectedVideo.value = video;
  const shouldImport = addDownloadedAudio.value;
  const selectedOutputMode = outputMode.value;

  // A finished entry remains visible so the operator can verify/reveal its
  // saved path. A new attempt for that result replaces only the old entry.
  downloadQueue.value = downloadQueue.value.filter(download =>
    download.videoId !== video.id || isActiveDownload(download));

  // Add to download queue
  const downloadItem: DownloadProgress = {
    jobId: crypto.randomUUID(),
    videoId: video.id,
    title: video.title,
    progress: 0,
    status: 'downloading',
    outputMode: selectedOutputMode,
  };
  downloadQueue.value.push(downloadItem);

  try {
    // Start download
    const result = await window.electronAPI.downloadYouTubeAudio(
      downloadItem.jobId,
      video.id,
      video.title,
      projectFolderPath,
      selectedOutputMode,
      (progress: any) => {
        const item = downloadQueue.value.find(d => d.jobId === downloadItem.jobId);
        if (item) {
          const percentage = Number(progress.percentage);
          if (Number.isFinite(percentage)) {
            item.progress = Math.max(item.progress, Math.min(100, Math.max(0, percentage)));
          }
          item.status = progress.status === 'converting' ? 'converting' : 'downloading';
        }
      }
    );

    const item = downloadQueue.value.find(d => d.jobId === downloadItem.jobId);
    if (item) {
      item.progress = 100;
      item.savedPath = result.file;
      item.folderPath = parentDirectory(result.file) || appendPath(projectFolderPath, 'media');

      if (shouldImport &&
          (props.projectFolderPath !== projectFolderPath || props.projectEpoch !== projectEpoch)) {
        throw new Error(t('youtube.projectChanged'));
      }

      if (shouldImport) {
        item.status = 'importing';
        const imported = await props.importFiles(
          [result.file],
          undefined,
          { displayNames: [result.title] },
        );
        if (props.projectFolderPath !== projectFolderPath || props.projectEpoch !== projectEpoch) {
          throw new Error(t('youtube.projectChanged'));
        }
        if (!imported.success || imported.imported !== 1) {
          throw new Error(imported.error || t('youtube.importError'));
        }
      }

      item.status = 'completed';
    }
  } catch (error: any) {
    const item = downloadQueue.value.find(d => d.jobId === downloadItem.jobId);
    if (item && item.status !== 'cancelled') {
      item.status = 'error';
      item.error = error.message || t('youtube.downloadError');
    }
    console.error('YouTube download error:', error);
  }
};

const isDownloading = (videoId: string) => {
  return downloadQueue.value.some(d => d.videoId === videoId && isActiveDownload(d));
};

const isActiveDownload = (download: DownloadProgress) =>
  !['completed', 'cancelled', 'error'].includes(download.status);

const cancelDownload = async (download: DownloadProgress) => {
  if (!isActiveDownload(download)) return;
  await window.electronAPI.cancelYouTubeDownload(download.jobId);
  download.status = 'cancelled';
  download.error = t('youtube.statusCancelled');
};

const retryDownload = (download: DownloadProgress) => {
  void downloadVideo({
    id: download.videoId,
    title: download.title,
    thumbnail: '',
    channelTitle: '',
  });
};

const getDownloadStatus = (download: DownloadProgress) => {
  switch (download.status) {
    case 'downloading':
      return t('youtube.statusDownloading');
    case 'converting':
      return t('youtube.statusConverting');
    case 'importing':
      return t('youtube.statusImporting');
    case 'completed':
      return t('youtube.statusCompleted');
    case 'cancelled':
      return t('youtube.statusCancelled');
    case 'error':
      return download.error || t('youtube.statusError');
    default:
      return '';
  }
};

const openDownloadFolder = async (download: DownloadProgress) => {
  if (!download.folderPath) return;
  download.actionError = '';
  try {
    const result = await window.electronAPI.openFolder(download.folderPath);
    if (!result.success) {
      throw new Error(result.error || t('youtube.openFolderError'));
    }
  } catch (error: any) {
    download.actionError = error?.message || t('youtube.openFolderError');
  }
};

function appendPath(parent: string, child: string): string {
  if (!parent) return '—';
  const separator = parent.includes('\\') ? '\\' : '/';
  return `${parent.replace(/[\\/]+$/, '')}${separator}${child}`;
}

function parentDirectory(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/, '');
  const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return separatorIndex > 0 ? trimmed.slice(0, separatorIndex) : '';
}

function extractYouTubeVideoId(value: string): string {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let id = '';
    if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0] || '';
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      id = url.searchParams.get('v') ||
        (['shorts', 'embed', 'live'].includes(parts[0] || '') ? parts[1] || '' : '');
    }
    return /^[A-Za-z0-9_-]{6,32}$/.test(id) ? id : '';
  } catch { return ''; }
}

const closeModal = async () => {
  await Promise.allSettled(downloadQueue.value
    .filter(isActiveDownload)
    .map(download => window.electronAPI.cancelYouTubeDownload(download.jobId)));
  emit('close');
  // Reset state
  searchQuery.value = '';
  searchResults.value = [];
  hasSearched.value = false;
  selectedVideo.value = null;
};
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--dialog-backdrop);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.youtube-import-modal {
  background: var(--dialog-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--dialog-radius);
  width: 90%;
  max-width: 1200px;
  height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--dialog-shadow);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--dialog-header-padding);
  border-bottom: 1px solid var(--color-border);
}

.modal-header h2 {
  margin: 0;
  color: var(--color-text-primary);
}

.close-btn {
  background: transparent;
  border: none;
  color: var(--color-text-secondary);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: background 0.2s;
}

.close-btn:hover {
  background: var(--color-surface-hover);
}

.modal-body {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding: var(--dialog-body-padding);
  gap: 20px;
}

.search-section {
  flex-shrink: 0;
}

.search-bar {
  display: flex;
  gap: 10px;
}

.search-bar input {
  flex: 1;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-surface);
  color: var(--color-text-primary);
  font-size: 14px;
}

.search-btn {
  padding: 12px 24px;
  background: var(--color-accent);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  transition: opacity 0.2s;
}

.search-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.import-plan {
  flex-shrink: 0;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-surface);
}

.plan-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 10px;
}

.plan-heading h3 {
  margin: 0;
  color: var(--color-text-primary);
  font-size: 14px;
  font-weight: 600;
}

.add-to-playlist-option {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--color-text-primary);
  font-size: 13px;
  cursor: pointer;
}

.add-to-playlist-option input {
  margin: 0;
  accent-color: var(--color-accent);
}

.plan-grid {
  display: grid;
  grid-template-columns: minmax(180px, 1.2fr) minmax(180px, 1fr) minmax(220px, 0.9fr);
  column-gap: 16px;
  row-gap: 10px;
  align-items: start;
}

.plan-field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
  color: var(--color-text-primary);
  font-size: 12px;
}

.plan-field strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
}

.plan-label {
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.plan-detail {
  overflow: hidden;
  color: var(--color-text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plan-format select {
  width: 100%;
  height: 32px;
  padding: 0 28px 0 9px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-background);
  color: var(--color-text-primary);
  font: inherit;
}

.plan-processing {
  grid-column: 1 / -1;
}

.plan-processing.skipped .processing-list {
  opacity: 0.5;
}

.processing-list {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 4px 0;
  color: var(--color-text-primary);
}

.processing-list span:not(:last-child)::after {
  content: '\00b7';
  margin: 0 8px;
  color: var(--color-text-secondary);
}

.content-container {
  display: flex;
  gap: 20px;
  flex: 1;
  min-height: 0;
}

.results-section {
  flex: 1;
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 10px;
}

.results-section.full-width {
  width: 100%;
}

.loading-state,
.error-state,
.empty-state {
  text-align: center;
  padding: 40px;
  color: var(--color-text-secondary);
}

.loading-state .material-symbols-rounded,
.error-state .material-symbols-rounded,
.empty-state .material-symbols-rounded {
  font-size: 48px;
  display: block;
  margin-bottom: 10px;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.results-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.video-item {
  display: flex;
  gap: 12px;
  padding: 12px;
  background: var(--color-surface);
  border-radius: 4px;
  border: 1px solid transparent;
  transition: border-color 0.2s;
}

.video-item.selected {
  border-color: var(--color-accent);
}

.video-thumbnail {
  width: 120px;
  height: 90px;
  object-fit: cover;
  border-radius: 4px;
  flex-shrink: 0;
}

.video-info {
  flex: 1;
  min-width: 0;
}

.video-title-line {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 8px;
}

.video-title {
  flex: 1;
  min-width: 0;
  margin: 0 0 4px 0;
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
}

.live-badge {
  flex-shrink: 0;
  padding: 2px 5px;
  border: 1px solid var(--color-danger);
  border-radius: 3px;
  color: var(--color-danger);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
}

.video-channel,
.video-duration {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.video-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}

.action-btn {
  padding: 8px 12px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  transition: opacity 0.2s;
  white-space: nowrap;
}

.preview-btn {
  background: var(--color-surface-hover);
  color: var(--color-text-primary);
}

.download-btn {
  background: var(--color-accent);
  color: white;
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.download-queue {
  border-top: 1px solid var(--color-border);
  padding-top: 20px;
  flex-shrink: 0;
}

.download-queue h3 {
  margin: 0 0 10px 0;
  font-size: 14px;
  color: var(--color-text-primary);
}

.queue-list {
  display: flex;
  max-height: 180px;
  overflow-y: auto;
  flex-direction: column;
  gap: 10px;
}

.queue-item {
  background: var(--color-surface);
  padding: 12px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.queue-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.queue-info .video-title {
  font-size: 13px;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-status {
  font-size: 11px;
  color: var(--color-text-secondary);
}

.queue-format,
.saved-path,
.queue-action-error {
  overflow: hidden;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-format,
.saved-path {
  color: var(--color-text-secondary);
}

.queue-action-error {
  color: var(--color-danger);
}

.progress-bar {
  width: 200px;
  height: 6px;
  background: var(--color-border);
  border-radius: 3px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--color-accent);
  transition: width 0.3s;
}

.progress-text {
  font-size: 12px;
  color: var(--color-text-secondary);
  width: 50px;
  text-align: right;
}

.open-folder-btn {
  flex-shrink: 0;
}

button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

@media (max-width: 760px) {
  .youtube-import-modal {
    width: calc(100% - 24px);
  }

  .modal-body {
    padding: 12px;
    gap: 12px;
  }

  .plan-heading {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }

  .plan-grid {
    grid-template-columns: 1fr;
  }

  .plan-processing {
    grid-column: auto;
  }

  .video-thumbnail {
    width: 96px;
    height: 72px;
  }

  .video-actions {
    align-self: stretch;
  }

  .action-btn {
    justify-content: center;
  }

  .queue-item {
    align-items: stretch;
    flex-wrap: wrap;
  }

  .queue-info {
    flex-basis: 100%;
  }

  .progress-bar {
    flex: 1;
    width: auto;
  }
}
</style>
