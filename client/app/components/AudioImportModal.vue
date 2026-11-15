<template>
  <Teleport to="body" :disabled="docked">
    <div v-if="open" v-show="visible !== false" :class="docked ? 'docked-import' : 'modal-backdrop'" @click.self="!docked && close()">
      <div class="import-media" :class="docked ? 'workspace-import-body' : 'modal'">
        <header v-if="!docked">
          <h2>{{ t('importAudio.title') }}</h2>
          <Btn type="button" icon="stop_circle" :text="t('controls.stopAll')" @click="server.stopAll()" />
          <button class="x" :aria-label="t('actions.close')" :disabled="busy || pickingLocal" @click="close">✕</button>
        </header>

        <section v-if="busy && progress" class="import-progress">
          <div class="import-progress-heading">
            <strong role="status" :title="progress.name">{{ t('importAudio.progress', progress) }}</strong>
            <button type="button" class="btn small" @click="emit('cancel')">{{ t('importAudio.cancelImport') }}</button>
          </div>
          <progress class="workspace-import-progress" :max="progress.total"
            :value="Math.max(0, progress.current - 1)" :aria-label="t('importAudio.verifying')" />
        </section>
        <!-- Source mode toggle. Only rendered when the server is on a
             different machine; otherwise "upload" makes no sense and we
             skip the tabs entirely. -->
        <div v-if="!singleFile && !server.isLocalServer" v-show="!docked || !busy" class="tabs">
          <button type="button" class="tab" :class="{ active: tab === 'upload' }"
            :aria-pressed="tab === 'upload'" @click="tab = 'upload'">
            {{ t('importProject.fromThisComputer') }}
          </button>
          <button type="button" class="tab" :class="{ active: tab === 'server' }"
            :aria-pressed="tab === 'server'" @click="tab = 'server'">
            {{ t('importProject.fromServer') }}
          </button>
        </div>

        <div v-show="!docked || !busy" class="import-source" :class="{ 'import-source--picking': localPicker }">
        <section v-if="tab === 'server'" class="pane">
          <template v-if="singleFile">
            <ServerFilePickerModal docked :open="open" :filter="MEDIA_FILE_ACCEPT" :filter-options="[]"
              :fallback-start-path="projectStartPath" location-context="quickplay-import"
              :confirm-label="t('importAudio.importSelected')" @pick="onServerPick([$event])" @close="close" />
            <p v-if="!server.isLocalServer" class="hint">{{ t('oneShots.hint') }}</p>
          </template>
          <template v-else-if="server.isLocalServer && hasElectron">
            <ServerFileBrowser v-if="localPicker === 'files'" staging
              :fallback-start-path="projectStartPath" @select="stageLocalFiles" @close="cancelLocalPicker" />
            <ServerFilePickerModal v-else-if="localPicker === 'folder' && !pickingLocal" docked :open="true"
              mode="directory" :filter="MEDIA_FILE_ACCEPT" :filter-options="[]" :fallback-start-path="projectStartPath"
              location-context="media" :confirm-label="t('importAudio.chooseFolder')"
              @pick="stageLocalFolder" @close="cancelLocalPicker" />
            <div v-else-if="pickingLocal" class="row">
              <span class="status" role="status">{{ t('importAudio.readingSelection') }}</span>
              <button type="button" class="btn" @click="cancelLocalPicker">{{ t('common.cancel') }}</button>
            </div>
            <div v-else class="row">
              <button type="button" class="btn" :disabled="busy" @click="localPicker = 'files'">
                <span class="material-symbols-rounded" aria-hidden="true">audio_file</span>
                {{ t('importAudio.chooseFiles') }}
              </button>
              <button type="button" class="btn" :disabled="busy" @click="localPicker = 'folder'">
                <span class="material-symbols-rounded" aria-hidden="true">folder_open</span>
                {{ t('importAudio.chooseFolder') }}
              </button>
            </div>
            <p v-if="localPickerError" class="picker-error" role="alert">{{ localPickerError }}</p>
            <p v-if="localSkippedFolders.length" class="picker-warning" role="status">
              {{ t('importAudio.foldersSkipped', { folders: localSkippedFolders.join(', ') }) }}
            </p>
          </template>
          <template v-else>
            <ServerFileBrowser :fallback-start-path="projectStartPath" @select="onServerPick" />
            <p class="hint">{{ t('importAudio.serverHint') }}</p>
          </template>
        </section>

        <section v-else class="pane">
          <div class="upload-drop" role="group" tabindex="0" :aria-label="t('importProject.fromThisComputer')"
            aria-describedby="remote-upload-instructions" :aria-disabled="stagingBusy" @dragover.stop.prevent
            @drop.stop.prevent="selectForUpload($event.dataTransfer)" @paste.stop="selectForUpload($event.clipboardData)">
            <span id="remote-upload-instructions">{{ t('importAudio.dropForUpload') }}</span>
          </div>
          <div v-if="readingUploadFolder" class="row">
            <span class="status" role="status">{{ t('importAudio.readingSelection') }}</span>
            <button type="button" class="btn small" @click="cancelUploadFolderRead">
              {{ t('common.cancel') }}
            </button>
          </div>
          <p v-else-if="uploadStatus" class="status" role="status">{{ uploadStatus }}</p>
          <p v-if="skippedUploadEntries.length" class="picker-warning" role="status">
            {{ t('importAudio.uploadEntriesSkipped', { entries: skippedUploadEntries.join(', ') }) }}
          </p>
          <section v-if="failedUploads.length" class="import-results" aria-live="polite">
            <button type="button" class="btn small" :disabled="stagingBusy" @click="uploadFiles(failedUploads.map(entry => entry.file))">
              {{ t('importAudio.retryFailed') }}
            </button>
            <ul>
              <li v-for="(entry, index) in failedUploads" :key="index" class="failed">
                <span class="result-name">{{ entry.file.name }}</span>
                <span class="result-reason">{{ entry.reason }}</span>
              </li>
            </ul>
          </section>

        </section>

        <section v-if="!localPicker && stagedPaths.length" class="staged-media" :aria-label="t('importAudio.filesToImport')">
          <div class="batch-controls">
            <span class="selection-count" role="status">{{ t('importAudio.selectedOfTotal', { count: stagedSelection.length, total: stagedPaths.length }) }}</span>
            <button type="button" class="btn small" :disabled="stagingBusy || stagedSelection.length === stagedPaths.length"
              @click="setStagedSelection([...stagedPaths])">{{ t('importAudio.selectAll') }}</button>
            <button type="button" class="btn small" :disabled="stagingBusy || !stagedSelection.length"
              @click="setStagedSelection([])">{{ t('importAudio.selectNone') }}</button>
            <label v-if="stagedFolder" class="group-option" :title="stagedFolder">
              <input v-model="importAsGroup" type="checkbox" :disabled="stagingBusy">
              <span>{{ t('importAudio.importAsGroup') }}</span>
              <strong>{{ stagedFolder }}</strong>
            </label>
            <button type="button" class="btn primary import-selected" :disabled="stagingBusy || !stagedSelection.length"
              @click="importStaged">{{ t('importAudio.importSelected') }}</button>
          </div>
          <ul class="uploaded">
            <li v-for="(p, i) in stagedPaths" :key="p" :class="{ selected: selectedPaths.has(p) }">
              <label class="staged-row" :title="p">
                <input type="checkbox" :checked="selectedPaths.has(p)" :disabled="stagingBusy"
                  @click="toggleStaged(p, i, $event)">
                <span class="icon material-symbols-rounded" aria-hidden="true">{{ isVideoPath(p) ? 'movie' : 'audio_file' }}</span>
                <span class="name">{{ basename(p) }}</span>
                <span v-if="tab === 'upload' && uploadedSizes[p] !== undefined" class="size">{{ formatBytes(uploadedSizes[p]) }}</span>
              </label>
            </li>
          </ul>
        </section>
        <p v-if="!singleFile && !localPicker" class="hint">{{ t('importAudio.preserveAudio') }}</p>
        </div>

        <component v-show="!localPicker && (!docked || !busy)" :is="docked ? 'section' : 'details'" class="import-advanced">
          <h3 v-if="docked">{{ t('importAudio.planTitle') }}</h3>
          <summary v-else>{{ t('importAudio.advanced') }}</summary>
          <section v-if="tab === 'server'" class="import-options" :aria-label="t('importAudio.fileHandling')">
            <div class="import-option">
              <span>{{ t('importAudio.fileHandling') }}</span>
              <InlineChoicePicker :label="t('importAudio.fileHandling')" :value="fileMode" :options="fileModeOptions"
                :disabled="busy" @change="fileMode = $event" />
            </div>
            <div class="import-option" v-if="fileMode === 'copy'">
              <span>{{ t('importAudio.duplicates') }}</span>
              <InlineChoicePicker :label="t('importAudio.duplicates')" :value="duplicatePolicy" :options="duplicatePolicyOptions"
                :disabled="busy" @change="duplicatePolicy = $event" />
            </div>
            <p v-if="fileMode === 'link'" class="option-note">{{ t('importAudio.linkWarning') }}</p>
          </section>

          <section class="import-plan" :aria-label="t('importAudio.planTitle')">
            <dl class="plan-grid">
              <div v-if="tab === 'upload' || fileMode === 'copy'">
                <dt>{{ t('importAudio.destination') }}</dt>
                <dd class="destination" :title="mediaDestination">{{ mediaDestination }}</dd>
              </div>
              <div>
                <dt>{{ t('importAudio.processing') }}</dt>
                <dd class="settings-summary">
                  <span v-if="!singleFile" class="setting-pill">
                    {{ t('importAudio.playlistTransition') }} {{ transitionLabel }}
                  </span>
                  <span v-for="setting in importSettings" :key="setting.label" class="setting-pill">
                    {{ setting.label }}
                    <strong :class="setting.enabled ? 'on' : 'off'">
                      {{ setting.enabled ? t('importAudio.enabled') : t('importAudio.disabled') }}
                    </strong>
                  </span>
                </dd>
              </div>
            </dl>
          </section>
        </component>

        <section v-if="result && !busy && !localPicker" class="import-results" aria-live="polite">
          <div class="result-heading">
            <h3>{{ t('importAudio.resultsTitle') }}</h3>
            <div class="result-actions">
              <button v-if="hasElectron && projectStartPath" type="button" class="btn small" @click="openMediaFolder">{{ t('importAudio.openFolder') }}</button>
              <button
                v-if="failedPaths.length"
                type="button"
                class="btn small primary"
                :disabled="busy"
                @click="retryFailed"
              >{{ t('importAudio.retryFailed') }}</button>
            </div>
          </div>
          <ul>
            <li v-for="item in result.results" :key="`${item.sourcePath}-${item.status}`" :class="item.status">
              <span class="result-status">{{ statusLabel(item.status) }}</span>
              <span class="result-name" :title="item.sourcePath">{{ item.displayName }}</span>
              <span v-if="item.details" class="result-details">
                {{ detailLabel(item.details) }}
              </span>
              <span v-if="item.reason" class="result-reason">{{ item.reason }}</span>
            </li>
          </ul>
        </section>
      </div>
    </div>
  </Teleport>
</template>

<!--
  AudioImportModal.vue
  -----------------------------------------------------------------------
  Leads with files on this computer. Remote clients upload their selections;
  local Electron clients pass native paths directly. Server filesystem browse
  remains available for remote media and decoder-supported specialist formats.

  Emits:
    pick(serverPaths: string[]) — caller proceeds to create AudioItems for
                                  each selected server-side path (batched).
    close                       — user dismissed the modal.

  Notes:
    The user explicitly chose 'Upload to server's media_root' so that
    both local and remote-server modes behave identically downstream.
-->
<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { useLiveplayServer } from '~/composables/useLiveplayServer';
import ServerFileBrowser from '~/components/ServerFileBrowser.vue';
import ServerFilePickerModal from '~/components/ServerFilePickerModal.vue';
import { MEDIA_FILE_ACCEPT } from '~/utils/audio';

type FileMode = 'copy' | 'link';
type DuplicatePolicy = 'reuse' | 'skip' | 'keep';
type ImportStatus = 'ready' | 'warning' | 'failed' | 'skipped';
type ImportOptions = { fileMode: FileMode; duplicatePolicy: DuplicatePolicy; groupName?: string; existingGroupUuid?: string };
interface ImportResult {
  success: boolean;
  imported: number;
  groupUuid?: string;
  results: Array<{
    sourcePath: string;
    displayName: string;
    status: ImportStatus;
    reason?: string;
    details?: {
      fileType: string;
      duration: number;
      sampleRate: number;
      channels: number;
      bitrateKbps: number;
      truePeakDbtp: number | null;
    };
  }>;
}

const props = defineProps<{
  open: boolean;
  docked?: boolean;
  visible?: boolean;
  singleFile?: boolean;
  busy?: boolean;
  result?: ImportResult | null;
  progress?: { current: number; total: number; name: string } | null;
}>();
const emit  = defineEmits<{
  (e: 'pick', serverPaths: string[], options: ImportOptions): void;
  (e: 'cancel'): void;
  (e: 'close'): void;
}>();

const server = useLiveplayServer();
const { currentProject, projectEpoch } = useProject();
const { t }  = useLocalization();

// Remote clients lead with upload and can switch to the engine's folders.
const tab = ref<'server' | 'upload'>(props.singleFile || server.isLocalServer ? 'server' : 'upload');
const fileMode = ref<FileMode>('copy');
const duplicatePolicy = ref<DuplicatePolicy>('reuse');
const fileModeOptions = computed(() => [
  { value: 'copy', label: t('importAudio.copyFiles') },
  { value: 'link', label: t('importAudio.linkFiles') },
] as const);
const duplicatePolicyOptions = computed(() => [
  { value: 'reuse', label: t('importAudio.reuseDuplicate') },
  { value: 'skip', label: t('importAudio.skipDuplicate') },
  { value: 'keep', label: t('importAudio.keepDuplicate') },
] as const);

watch(() => props.open, (open) => {
  if (!open) return;
  tab.value = props.singleFile || server.isLocalServer ? 'server' : 'upload';
  fileMode.value = 'copy';
  duplicatePolicy.value = 'reuse';
});

const projectStartPath = computed(() => currentProject.value?.folderPath || '');
const mediaDestination = computed(() => {
  const folder = projectStartPath.value.replace(/[\\/]+$/, '');
  if (!folder) return t('importAudio.projectMediaDestination');
  const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return `${folder}${separator}media`;
});

const projectSettings = computed(() => currentProject.value?.settings);
const transitionLabel = computed(() => projectSettings.value?.defaultTransitionMode === 'start-next'
  ? t('settings.transitionModeStartNext')
  : t('settings.transitionModeCrossfade'));
const importSettings = computed(() => [
  {
    label: t('settings.cycleTrackColors'),
    enabled: projectSettings.value?.cycleTrackColors !== false,
  },
]);

const uploading           = ref(false);
let uploadBatch = 0;
const readingUploadFolder = ref(false);
const skippedUploadEntries = ref<string[]>([]);
const failedUploads       = ref<Array<{ file: File; reason: string }>>([]);
const uploadStatus        = ref<string>('');
const uploadedThisSession = ref<string[]>([]);
const selectedUploaded    = ref<string[]>([]);
const uploadedSizes       = ref<Record<string, number>>({});
watch([projectEpoch, () => server.serverUrl, () => server.projectSessionId], () => {
  ++uploadBatch;
  uploading.value = false;
  readingUploadFolder.value = false;
  skippedUploadEntries.value = [];
  uploadedThisSession.value = [];
  selectedUploaded.value = [];
  uploadedFolder.value = '';
  uploadedSizes.value = {};
  failedUploads.value = [];
  uploadStatus.value = '';
}, { flush: 'sync' });
watch([() => props.open, () => props.visible, tab], ([open, visible, source]) => {
  if (!open || visible === false || source !== 'upload') cancelUploadFolderRead();
}, { flush: 'sync' });
onScopeDispose(() => { ++uploadBatch; });
const uploadedAnchor      = { i: -1 };
type ImportSource = 'server' | 'local' | 'upload';
let lastImportOptions: ImportOptions = { fileMode: 'copy', duplicatePolicy: 'reuse' };

const hasElectron = typeof globalThis.window?.electronAPI?.scanMediaFolder === 'function';
const localPicker = ref<'files' | 'folder' | null>(null);
let folderScan = 0;
const localPicked  = ref<string[]>([]);
const selectedLocal = ref<string[]>([]);
const localFolder = ref('');
const uploadedFolder = ref('');
const importAsGroup = ref(false);
const localPickerError = ref('');
const localSkippedFolders = ref<string[]>([]);
const localAnchor   = { i: -1 };
const pickingLocal = ref(false);
watch([() => props.open, () => props.visible, projectEpoch, () => server.serverUrl, () => server.projectSessionId],
  cancelLocalPicker, { flush: 'sync' });
const stagedPaths = computed(() => tab.value === 'upload' ? uploadedThisSession.value : localPicked.value);
const stagedSelection = computed(() => tab.value === 'upload' ? selectedUploaded.value : selectedLocal.value);
const selectedPaths = computed(() => new Set(stagedSelection.value));
const stagedFolder = computed(() => tab.value === 'upload' ? uploadedFolder.value : localFolder.value);
const stagingBusy = computed(() => props.busy || pickingLocal.value || uploading.value || readingUploadFolder.value);

// Browse-time hint only (container extension); the authoritative flag is the
// server's has_video probe, attached to the item at import.
const VIDEO_CONTAINER_EXT = new Set([
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mpg', '.mpeg',
  '.m2ts', '.mts', '.wmv', '.flv', '.3gp',
]);
function isVideoPath(p: string): boolean {
  const m = /\.[a-z0-9]+$/i.exec(p);
  return !!m && VIDEO_CONTAINER_EXT.has(m[0].toLowerCase());
}

function close()       { if (!props.busy && !pickingLocal.value) emit('close'); }
// Auto-close once the import finishes cleanly. Any failed file keeps the
// modal open so the result list and retry affordance stay visible.
watch([() => props.result, () => props.busy], ([result, busy]) => {
  if (!result || busy) return;
  const finished = new Set(result.results.filter(item => item.status !== 'failed').map(item => item.sourcePath));
  localPicked.value = localPicked.value.filter(path => !finished.has(path));
  uploadedThisSession.value = uploadedThisSession.value.filter(path => !finished.has(path));
  selectedLocal.value = selectedLocal.value.filter(path => !finished.has(path));
  selectedUploaded.value = selectedUploaded.value.filter(path => !finished.has(path));
  if (!localPicked.value.length) localFolder.value = '';
  if (!uploadedThisSession.value.length) uploadedFolder.value = '';
  localAnchor.i = uploadedAnchor.i = -1;
  if (result.results.length > 0 && result.results.every(item => item.status !== 'failed')) close();
});
function basename(p: string): string { return p.split(/[\\/]/).pop() || p; }

// Server file browser emits a batch of already-on-server paths.
function onServerPick(serverPaths: string[]) {
  if (serverPaths.length && !props.busy) emitPick(serverPaths, 'server');
}


function importStaged() {
  if (stagedSelection.value.length && !stagingBusy.value) {
    emitPick(stagedPaths.value.filter(path => selectedPaths.value.has(path)),
      tab.value === 'upload' ? 'upload' : 'local');
  }
}

function emitPick(paths: string[], source: ImportSource) {
  lastImportOptions = source === 'upload'
    ? { fileMode: 'copy', duplicatePolicy: 'reuse' }
    : { fileMode: fileMode.value, duplicatePolicy: duplicatePolicy.value };
  if (source !== 'server' && importAsGroup.value && stagedFolder.value) {
    lastImportOptions.groupName = stagedFolder.value;
  }
  emit('pick', paths, lastImportOptions);
}

const failedPaths = computed(() => props.result?.results
  .filter(item => item.status === 'failed')
  .map(item => item.sourcePath) ?? []);

function retryFailed() {
  if (!failedPaths.value.length || stagingBusy.value) return;
  lastImportOptions = {
    ...lastImportOptions,
    existingGroupUuid: props.result?.groupUuid ?? lastImportOptions.existingGroupUuid,
  };
  emit('pick', failedPaths.value, lastImportOptions);
}
async function openMediaFolder() {
  if (hasElectron && projectStartPath.value) {
    await (globalThis as any).electronAPI.openFolder(mediaDestination.value);
  }
}
function statusLabel(status: ImportStatus) { return t(`importAudio.status.${status}`); }
function detailLabel(details: NonNullable<ImportResult['results'][number]['details']>) {
  const duration = `${Math.floor(details.duration / 60)}:${Math.round(details.duration % 60).toString().padStart(2, '0')}`;
  const parts = [details.fileType, duration];
  if (details.sampleRate) parts.push(`${(details.sampleRate / 1000).toFixed(1)} kHz`);
  if (details.channels) parts.push(t('importAudio.channelCount', { count: details.channels }));
  if (details.bitrateKbps) parts.push(`${details.bitrateKbps} kbps`);
  if (details.truePeakDbtp !== null) parts.push(`${details.truePeakDbtp.toFixed(1)} dBTP`);
  return parts.join(' · ');
}

// Shared click-selection for the staging lists (local picks / uploaded files).
// Plain click toggles membership so a batch is easy to build without modifiers;
// Ctrl/Cmd also toggles, Shift extends a range from the last anchor. Returns
// the new selection array.
function clickSelect(
  items: string[],
  current: string[],
  anchor: { i: number },
  item: string,
  index: number,
  e: MouseEvent,
): string[] {
  if (e.shiftKey && anchor.i >= 0) {
    const [lo, hi] = anchor.i < index ? [anchor.i, index] : [index, anchor.i];
    const slice = items.slice(lo, hi + 1);
    return (e.ctrlKey || e.metaKey)
      ? Array.from(new Set([...current, ...slice]))
      : slice;
  }
  anchor.i = index;
  return current.includes(item)
    ? current.filter(p => p !== item)
    : [...current, item];
}

function setStagedSelection(paths: string[]) {
  if (tab.value === 'upload') selectedUploaded.value = paths;
  else selectedLocal.value = paths;
  localAnchor.i = uploadedAnchor.i = -1;
}

function toggleStaged(item: string, index: number, e: MouseEvent) {
  if (tab.value === 'upload') {
    selectedUploaded.value = clickSelect(uploadedThisSession.value, selectedUploaded.value, uploadedAnchor, item, index, e);
  } else {
    selectedLocal.value = clickSelect(localPicked.value, selectedLocal.value, localAnchor, item, index, e);
  }
  (e.currentTarget as HTMLInputElement).checked = selectedPaths.value.has(item);
}

function cancelLocalPicker() {
  ++folderScan;
  localPicker.value = null;
  pickingLocal.value = false;
}

function stageLocalFiles(paths: string[]) {
  if (localPicker.value !== 'files' || props.busy) return;
  const existing = new Set(localPicked.value);
  const added = paths.filter(path => !existing.has(path));
  localPicked.value = [...localPicked.value, ...added];
  selectedLocal.value = [...selectedLocal.value, ...added];
  localPickerError.value = '';
  cancelLocalPicker();
}

async function stageLocalFolder(path: string) {
  if (localPicker.value !== 'folder' || props.busy || pickingLocal.value) return;
  const revision = ++folderScan;
  pickingLocal.value = true;
  localPickerError.value = '';
  try {
    const folder = await window.electronAPI.scanMediaFolder(path);
    if (revision !== folderScan) return;
    localSkippedFolders.value = folder.skippedFolders;
    if (!folder.files.length) {
      localPickerError.value = t('importAudio.emptyMediaFolder');
      return;
    }
    localFolder.value = folder.name;
    importAsGroup.value = false;
    localPicked.value = folder.files;
    selectedLocal.value = [...folder.files];
    localAnchor.i = -1;
  } catch (error) {
    if (revision === folderScan) {
      console.warn('Could not read the selected media folder:', error);
      localPickerError.value = t('importAudio.folderReadFailed');
    }
  } finally {
    if (revision === folderScan) cancelLocalPicker();
  }
}

const uploadExtensions = new Set(MEDIA_FILE_ACCEPT.split(','));
function isUploadMedia(name: string) {
  return uploadExtensions.has(name.match(/\.[^.]+$/)?.[0].toLowerCase() ?? '');
}

async function readDroppedFolder(root: FileSystemDirectoryEntry, isCurrent: () => boolean) {
  const pending: FileSystemEntry[] = [root];
  const files: Array<{ path: string; file: File }> = [];
  const skipped: string[] = [];
  while (pending.length && isCurrent()) {
    const entry = pending.pop()!;
    if (entry !== root && entry.name.startsWith('.')) continue;
    try {
      if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        // The browser can return the directory in several batches.
        while (isCurrent()) {
          const children = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
          if (!children.length) break;
          for (const child of children) pending.push(child);
        }
      } else if (entry.isFile && isUploadMedia(entry.name)) {
        const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
        files.push({ path: entry.fullPath, file });
      }
    } catch (error) {
      if (entry === root) throw error;
      skipped.push(entry.fullPath.slice(root.fullPath.length + 1));
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return { files: files.map(entry => entry.file), skipped: skipped.sort() };
}

function cancelUploadFolderRead() {
  if (!readingUploadFolder.value) return;
  ++uploadBatch;
  readingUploadFolder.value = false;
}

async function selectForUpload(transfer: DataTransfer | null) {
  if (!transfer || stagingBusy.value || !currentProject.value) return;
  const droppedFiles = Array.from(transfer.files);
  const entries = Array.from(transfer.items)
    .filter(item => item.kind === 'file')
    .map(item => item.webkitGetAsEntry?.());
  const folder = entries.find(entry => entry?.isDirectory) as FileSystemDirectoryEntry | undefined;
  if (!folder) {
    const files = droppedFiles.filter(file => isUploadMedia(file.name));
    if (files.length) await uploadFiles(files);
    else if (droppedFiles.length) uploadStatus.value = t('importAudio.dropNoMedia');
    return;
  }
  if (entries.length > 1 || droppedFiles.length > 1) {
    uploadStatus.value = t('importAudio.dropOneFolder');
    return;
  }

  const revision = ++uploadBatch;
  const isCurrent = () => revision === uploadBatch;
  readingUploadFolder.value = true;
  let batch;
  try {
    batch = await readDroppedFolder(folder, isCurrent);
  } catch {
    if (isCurrent()) uploadStatus.value = t('importAudio.folderReadFailed');
    return;
  } finally {
    if (isCurrent()) readingUploadFolder.value = false;
  }
  if (!isCurrent()) return;
  skippedUploadEntries.value = batch.skipped;
  if (!batch.files.length) {
    uploadStatus.value = t('importAudio.emptyMediaFolder');
    return;
  }
  uploadedFolder.value = folder.name;
  importAsGroup.value = false;
  uploadedThisSession.value = [];
  selectedUploaded.value = [];
  uploadedSizes.value = {};
  uploadedAnchor.i = -1;
  failedUploads.value = [];
  await uploadFiles(batch.files);
}

async function uploadFiles(files: File[]) {
  if (!files.length || uploading.value || !currentProject.value) return;
  const serverUrl = server.serverUrl;
  const session = server.projectSessionId;
  const epoch = projectEpoch.value;
  const batch = ++uploadBatch;
  const sameShow = () => batch === uploadBatch && server.serverUrl === serverUrl &&
    server.projectSessionId === session && projectEpoch.value === epoch;
  uploading.value = true;
  failedUploads.value = failedUploads.value.filter(entry => !files.includes(entry.file));
  try {
    let uploadedCount = 0;
    for (let i = 0; i < files.length; ++i) {
      const file = files[i]!;
      if (!sameShow()) return;
      if (!server.connected || server.cueStartsBlocked) {
        failedUploads.value.push(...files.slice(i).map(file => ({ file, reason: t('importAudio.uploadPaused') })));
        break;
      }
      uploadStatus.value = t('importAudio.uploadingProgress',
        { i: i + 1, total: files.length, name: file.name });
      try {
        const out = await server.uploadFile(file, file.name, session);
        if (!sameShow()) return;
        if (!out?.saved?.length) throw new Error(t('importAudio.uploadEmpty'));
        for (const savedPath of out.saved) {
          uploadedThisSession.value.push(savedPath);
          selectedUploaded.value.push(savedPath);   // pre-select for one-click import
          uploadedSizes.value[savedPath] = file.size;
          uploadedCount++;
        }
      } catch (error) {
        if (!sameShow()) return;
        const reason = error instanceof Error ? error.message : String(error);
        failedUploads.value.push({ file, reason });
        if (/^(401|403) /.test(reason) || /project session changed/i.test(reason)) {
          failedUploads.value.push(...files.slice(i + 1).map(file => ({ file, reason: t('importAudio.uploadPaused') })));
          break;
        }
      }
    }
    uploadStatus.value = failedUploads.value.length ? t('importAudio.uploadedCount', { count: uploadedCount }) : '';
  } finally {
    if (batch === uploadBatch) uploading.value = false;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(1)} ${units[unit]}`;
}
</script>

<style lang="scss" scoped>
.modal-backdrop {
  position: fixed; inset: 0;
  background: var(--dialog-backdrop);
  display: flex; align-items: center; justify-content: center;
  z-index: 9000;
}
.modal {
  box-sizing: border-box;
  width: min(720px, 92vw);
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  background: var(--dialog-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--dialog-radius);
  padding: var(--dialog-padding);
  color: var(--color-text-primary);
  box-shadow: var(--dialog-shadow);
  display: flex; flex-direction: column; gap: 12px;

  header {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    min-height: 32px;
    background: var(--dialog-surface);
  }
  h2 { flex: 1; margin: 0; font-size: 18px; }
  .x {
    display: grid; place-items: center;
    width: 32px; height: 32px; padding: 0;
    background: transparent; border: none; border-radius: var(--control-radius);
    color: var(--color-text-secondary); cursor: pointer; font-size: 18px;
    &:hover { background: var(--color-surface-hover); color: var(--color-text-primary); }
  }

}

.import-source {
  display: grid;
  gap: var(--spacing-sm);
  min-width: 0;
}

.import-source--picking {
  grid-column: 1 / -1;
}

.import-media {
  .tabs {
    display: flex; gap: 4px;
    border-bottom: 1px solid var(--color-border);
  }
  .tab {
    flex: 1; background: transparent; border: none; cursor: pointer;
    padding: 8px 12px; color: var(--color-text-secondary); font-size: 13px;
    border-bottom: 2px solid transparent;
    &:hover  { color: var(--color-text-primary); background: var(--color-surface-hover); }
    &.active { color: var(--color-text-primary); border-bottom-color: var(--color-accent); }
  }

  .pane { display: flex; flex-direction: column; gap: 10px; }
  .hint { font-size: 11px; color: var(--color-text-tertiary); margin: 0; }
  .import-advanced {
    border: 1px solid var(--color-border);
    border-radius: var(--control-radius);
    background: var(--color-background);
    overflow: hidden;

    > summary {
      cursor: pointer;
      padding: 9px 10px;
      color: var(--color-text-secondary);
      font-size: 12px;
      font-weight: 700;
      user-select: none;
    }

    &[open] > summary {
      border-bottom: 1px solid var(--color-border);
    }
  }

  .import-advanced > :not(summary) {
    margin: 10px;
  }

  .btn {
    min-height: var(--panel-control-height);
    background: var(--color-surface-raised); border: 1px solid var(--color-border); border-radius: var(--control-radius);
    padding: 6px 12px; color: var(--color-text-primary); cursor: pointer;
    display: inline-flex; align-items: center; gap: 4px;
    &:hover:not(:disabled) { background: var(--color-surface-hover); border-color: var(--color-border-strong); }
    &:disabled { opacity: 0.5; cursor: not-allowed; }
    &.primary { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-text-on-accent); }
    &.small   { min-height: 28px; padding: 2px 8px; font-size: 12px; }
  }
  .row { display: flex; gap: var(--spacing-xs); align-items: center; flex-wrap: wrap; }
  .upload-drop {
    border: 1px dashed var(--color-border-strong);
    border-radius: var(--control-radius);
    padding: var(--spacing-sm);
    color: var(--color-text-primary);
    font-size: var(--type-metadata-size);
    &[aria-disabled="true"] { color: var(--color-text-secondary); }
    &:focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 1px; }
  }
  .status { font-size: 12px; color: var(--color-text-secondary); }
  .picker-error, .picker-warning { margin: 0; overflow-wrap: anywhere; }
  .picker-error { color: var(--color-danger); }
  .picker-warning { color: var(--color-warning); }

  .uploaded {
    list-style: none; margin: 0; padding: 0;
    border: 1px solid var(--color-border); border-radius: var(--control-radius); background: var(--color-background);
    max-height: 200px; overflow: auto;
    li {
      border-bottom: 1px solid var(--color-border);
      &:last-child { border-bottom: 0; }
      &:hover { background: var(--color-surface-hover); }
      &.selected { background: var(--color-surface-raised); }
      .icon { font-size: 16px; color: var(--color-text-secondary); }
      .name { color: var(--color-text-primary); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      .size { color: var(--color-text-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    }
  }
  .staged-row {
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    min-height: 30px;
    padding: 3px 8px;
    cursor: pointer;
  }
  .batch-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }
  .selection-count { color: var(--color-text-secondary); font-size: var(--type-metadata-size); font-variant-numeric: tabular-nums; }
  .group-option {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    min-width: 0;
    color: var(--color-text-primary);
    font-size: var(--type-metadata-size);
    strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    span { flex-shrink: 0; }
  }
  .import-selected { margin-inline-start: auto; }
  .import-progress {
    display: grid;
    gap: var(--spacing-xs);
    padding: var(--spacing-xs) var(--spacing-sm);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    font-size: var(--type-metadata-size);
  }
  .import-progress-heading {
    display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-sm);
    strong { min-width: 0; color: var(--color-text-primary); overflow-wrap: anywhere; }
  }

  .import-options {
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px;
    padding: 10px; border: 1px solid var(--color-border); border-radius: var(--control-radius); background: var(--color-background);
    .import-option { display: grid; align-content: start; gap: 5px; min-width: 0; color: var(--color-text-secondary); font-size: 11px; }
    .option-note { grid-column: 1 / -1; margin: 0; color: var(--color-warning); font-size: 11px; }
  }

  .import-plan {
    border-top: 1px solid var(--color-border);
    padding-top: 10px;
  }
  .plan-grid {
    display: grid; gap: 8px; margin: 0;
    > div { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 10px; align-items: baseline; }
    dt { color: var(--color-text-tertiary); font-size: 10px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; }
    dd { min-width: 0; margin: 0; }
    .destination {
      display: block;
      color: var(--color-text-secondary); font-family: var(--font-mono); font-size: 11px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
  }
  .settings-summary { display: flex; flex-wrap: wrap; gap: 5px; }
  .setting-pill {
    color: var(--color-text-secondary); font-size: 10px; line-height: 1.4; white-space: nowrap;
    & + &::before { content: '•'; margin-right: 5px; color: var(--color-border-strong); }
    strong { margin-left: 3px; font-weight: 700; &.on { color: var(--color-success); } &.off { color: var(--color-text-tertiary); } }
  }
  .import-results {
    border-top: 1px solid var(--color-border); padding-top: 10px;
    .result-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    h3 { margin: 0; font-size: 12px; }
    .result-actions { display: flex; gap: 6px; }
    ul { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 4px; }
    li { display: grid; grid-template-columns: 58px minmax(120px, 1fr) auto; gap: 6px 10px; align-items: center; padding: 7px 8px; background: var(--color-background); border-radius: var(--control-radius); }
    .result-status { font-size: 10px; font-weight: 750; text-transform: uppercase; }
    .ready .result-status { color: var(--color-success); }
    .warning .result-status { color: var(--color-warning); }
    .failed .result-status { color: var(--color-danger); }
    .skipped .result-status { color: var(--color-text-tertiary); }
    .result-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-primary); font-size: 12px; }
    .result-details { color: var(--color-text-tertiary); font-size: 10px; white-space: nowrap; }
    .result-reason { grid-column: 2 / -1; color: var(--color-text-secondary); font-size: 10px; line-height: 1.35; }
  }
}

.docked-import:has(.tabs) {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  .workspace-import-body { flex: 1; }
}

.workspace-import-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 23rem);
  align-content: start;
  align-items: start;
  gap: var(--spacing-sm);
  padding: var(--workspace-gutter);
  .tabs {
    order: 1;
    grid-column: 1 / -1;
    align-self: end;
    position: sticky;
    bottom: 0;
    z-index: 1;
    background: var(--color-surface);
    border-top: 1px solid var(--color-border);
    border-bottom: 0;
  }
  .import-advanced > h3 {
    margin: 0;
    padding: var(--spacing-xs) var(--spacing-sm);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface);
    font-size: var(--type-metadata-size);
  }
  .import-advanced { border-radius: 0; }
  .import-options { padding: 0; border: 0; }
  .import-plan { padding-top: var(--spacing-xs); }
  .pane, .import-source, .plan-grid { gap: var(--spacing-xs); }
  .pane :deep(.picker-dock) { flex-basis: clamp(174px, 28vh, 235px); }
  .pane > p { margin: 0; }
  .import-progress, .import-results { grid-column: 1 / -1; }
  .import-progress .btn { flex-shrink: 0; }
  .import-results ul { max-height: clamp(120px, 26vh, 240px); overflow: auto; overscroll-behavior: contain; }
  .import-results li { grid-template-columns: 58px minmax(0, 1fr) auto; }
  .import-results .result-details { white-space: normal; }
  .import-results .result-reason { overflow-wrap: anywhere; }
}

@container (max-width: 760px) {
  .workspace-import-body { grid-template-columns: minmax(0, 1fr); }
}
</style>
