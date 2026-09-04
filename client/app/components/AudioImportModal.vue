<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @click.self="close">
      <div class="modal">
        <header>
          <h2>{{ t('importAudio.title') }}</h2>
          <button class="x" :aria-label="t('actions.close')" :disabled="busy" @click="close">✕</button>
        </header>

        <!-- Source mode toggle. Only rendered when the server is on a
             different machine; otherwise "upload" makes no sense and we
             skip the tabs entirely. -->
        <div v-if="!server.isLocalServer" class="tabs">
          <button class="tab" :class="{ active: tab === 'upload' }" @click="tab = 'upload'">
            {{ t('importProject.fromThisComputer') }}
          </button>
          <button class="tab" :class="{ active: tab === 'server' }" @click="tab = 'server'">
            {{ t('importProject.fromServer') }}
          </button>
        </div>

        <!-- Local installs lead with the native picker. Server browsing stays
             available without making operators navigate a filesystem first. -->
        <section v-if="tab === 'server'" class="pane">
          <template v-if="server.isLocalServer && hasElectron">
            <p>{{ t('importAudio.localIntro') }}</p>
            <div class="row">
              <button class="btn primary" :disabled="pickingLocal || busy" @click="pickLocal">
                <span class="material-symbols-rounded" aria-hidden="true">folder_open</span>
                {{ pickingLocal ? t('importAudio.verifying') : t('importAudio.chooseFiles') }}
              </button>
            </div>
            <ul v-if="localPicked.length" class="uploaded">
              <li v-for="(p, i) in localPicked"
                  :key="p"
                  :class="{ selected: selectedLocal.includes(p) }"
                  @click="toggleLocal(p, i, $event)">
                <span class="icon material-symbols-rounded">{{ isVideoPath(p) ? 'movie' : 'audio_file' }}</span>
                <span class="name">{{ basename(p) }}</span>
              </li>
            </ul>
            <div v-if="localPicked.length" class="list-footer">
              <button class="btn primary" :disabled="!selectedLocal.length || busy" @click="importLocalSelected">
                {{ busy ? t('importAudio.verifying') : t('importAudio.importSelected') }}<span v-if="selectedLocal.length"> ({{ selectedLocal.length }})</span>
              </button>
            </div>
            <details class="source-browser">
              <summary>{{ t('importProject.fromServer') }}</summary>
              <ServerFileBrowser :start-path="projectStartPath" @select="onServerPick" />
              <p class="hint">{{ t('importAudio.serverHint') }}</p>
            </details>
          </template>
          <template v-else>
            <ServerFileBrowser :start-path="projectStartPath" @select="onServerPick" />
            <p class="hint">{{ t('importAudio.serverHint') }}</p>
          </template>
        </section>

        <!-- "Upload" tab — browser file picker, then upload to /api/upload -->
        <section v-else class="pane">
          <p>{{ t('importAudio.uploadIntro') }}</p>

          <div class="row">
            <input
              ref="uploadInput"
              class="file-input"
              type="file"
              multiple
              :accept="mediaAccept"
              @change="uploadSelectedFiles"
            >
            <button class="btn primary" :disabled="uploading || busy" @click="uploadInput?.click()">
              <span class="material-symbols-rounded" style="font-size:16px;vertical-align:middle;">folder_open</span>
              {{ uploading ? t('importAudio.uploading') : t('importAudio.chooseFiles') }}
            </button>
            <span v-if="uploadStatus" class="status" role="status" aria-live="polite">
              {{ uploadStatus }}
            </span>
          </div>

          <ul v-if="uploadedThisSession.length" class="uploaded">
            <li v-for="(p, i) in uploadedThisSession"
                :key="p"
                :class="{ selected: selectedUploaded.includes(p) }"
                @click="toggleUploaded(p, i, $event)">
              <span class="icon material-symbols-rounded">{{ isVideoPath(p) ? 'movie' : 'audio_file' }}</span>
              <span class="name">{{ basename(p) }}</span>
              <span v-if="uploadedSizes[p] !== undefined" class="size">
                {{ formatBytes(uploadedSizes[p]) }}
              </span>
            </li>
          </ul>
          <div v-if="uploadedThisSession.length" class="list-footer">
            <button class="btn primary" :disabled="!selectedUploaded.length || busy" @click="importUploadedSelected">
              {{ busy ? t('importAudio.verifying') : t('importAudio.importSelected') }}<span v-if="selectedUploaded.length"> ({{ selectedUploaded.length }})</span>
            </button>
          </div>
        </section>

        <details class="import-advanced">
          <summary>{{ t('importAudio.advanced') }}</summary>
          <section v-if="tab === 'server'" class="import-options" :aria-label="t('importAudio.fileHandling')">
            <label>
              <span>{{ t('importAudio.fileHandling') }}</span>
              <select v-model="fileMode" :disabled="busy">
                <option value="copy">{{ t('importAudio.copyFiles') }}</option>
                <option value="link">{{ t('importAudio.linkFiles') }}</option>
              </select>
            </label>
            <label v-if="fileMode === 'copy'">
              <span>{{ t('importAudio.duplicates') }}</span>
              <select v-model="duplicatePolicy" :disabled="busy">
                <option value="reuse">{{ t('importAudio.reuseDuplicate') }}</option>
                <option value="skip">{{ t('importAudio.skipDuplicate') }}</option>
                <option value="keep">{{ t('importAudio.keepDuplicate') }}</option>
              </select>
            </label>
            <p v-if="fileMode === 'link'" class="option-note">{{ t('importAudio.linkWarning') }}</p>
          </section>

          <section class="import-plan" :aria-label="t('importAudio.planTitle')">
            <div class="plan-heading">
              <h3>{{ t('importAudio.planTitle') }}</h3>
              <span v-if="knownSelectionCount !== null" class="plan-count">
                {{ t('importAudio.selectedCount', { count: knownSelectionCount }) }}
              </span>
            </div>
            <dl class="plan-grid">
              <div>
                <dt>{{ t('importAudio.destination') }}</dt>
                <dd>
                  <span class="destination" :title="mediaDestination">{{ mediaDestination }}</span>
                  <span class="destination-note">{{ t('importAudio.destinationFallback') }}</span>
                </dd>
              </div>
              <div>
                <dt>{{ t('importAudio.processing') }}</dt>
                <dd class="settings-summary">
                  <span class="setting-pill">
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
        </details>

        <section v-if="busy && progress" class="import-progress" role="status" aria-live="polite">
          <span>{{ t('importAudio.progress', progress) }}</span>
          <button type="button" class="btn small" @click="emit('cancel')">{{ t('importAudio.cancelImport') }}</button>
        </section>

        <section v-if="result" class="import-results" aria-live="polite">
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
import { computed, ref, watch } from 'vue';
import { useLiveplayServer } from '~/composables/useLiveplayServer';
import ServerFileBrowser from '~/components/ServerFileBrowser.vue';

type FileMode = 'copy' | 'link';
type DuplicatePolicy = 'reuse' | 'skip' | 'keep';
type ImportStatus = 'ready' | 'warning' | 'failed' | 'skipped';
interface ImportResult {
  success: boolean;
  imported: number;
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
  busy?: boolean;
  result?: ImportResult | null;
  progress?: { current: number; total: number; name: string } | null;
}>();
const emit  = defineEmits<{
  (e: 'pick', serverPaths: string[], options: { fileMode: FileMode; duplicatePolicy: DuplicatePolicy }): void;
  (e: 'cancel'): void;
  (e: 'close'): void;
}>();

const server = useLiveplayServer();
const { currentProject } = useProject();
const { t }  = useLocalization();

// Local Electron uses the server tab shell for its native picker; remote
// clients lead with upload and can switch to the server browser.
const tab = ref<'server' | 'upload'>(server.isLocalServer ? 'server' : 'upload');
const fileMode = ref<FileMode>('copy');
const duplicatePolicy = ref<DuplicatePolicy>('reuse');

watch(() => props.open, (open) => {
  if (!open) return;
  tab.value = server.isLocalServer ? 'server' : 'upload';
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
    label: t('settings.autoTrimSilenceOnImport'),
    enabled: projectSettings.value?.autoTrimSilenceOnImport === true,
  },
  {
    label: t('settings.autoMatchLoudnessOnImport'),
    enabled: projectSettings.value?.autoMatchLoudnessOnImport === true,
  },
  {
    label: t('settings.autoReduceTruePeaksOnImport'),
    enabled: projectSettings.value?.autoReduceTruePeaksOnImport !== false,
  },
  {
    label: t('settings.cycleTrackColors'),
    enabled: projectSettings.value?.cycleTrackColors !== false,
  },
]);

const uploading           = ref(false);
const uploadStatus        = ref<string>('');
const uploadedThisSession = ref<string[]>([]);
const selectedUploaded    = ref<string[]>([]);
const uploadedSizes       = ref<Record<string, number>>({});
const uploadedAnchor      = { i: -1 };
const uploadInput          = ref<HTMLInputElement | null>(null);
const mediaAccept = [
  'mp3', 'wav', 'aiff', 'aif', 'flac', 'ogg', 'oga', 'm4a', 'aac', 'mp2',
  'wma', 'opus', 'ac3', 'amr', 'au', 'caf', 'mp4', 'm4v', 'mov', 'mkv',
  'webm', 'avi', 'mpg', 'mpeg', 'm2ts', 'mts', 'wmv', 'flv', '3gp',
].map(extension => '.' + extension).join(',');
type ImportSource = 'server' | 'local' | 'upload';
const lastImportSource = ref<ImportSource>('local');

// Local file picker (used when server is local — same machine, so local paths = server paths)
const hasElectron = !!(globalThis as any).electronAPI?.selectAudioFiles;
const localPicked  = ref<string[]>([]);
const selectedLocal = ref<string[]>([]);
const localAnchor   = { i: -1 };
const pickingLocal = ref(false);
const knownSelectionCount = computed<number | null>(() => {
  if (tab.value === 'upload') return selectedUploaded.value.length;
  if (localPicked.value.length) return selectedLocal.value.length;
  // ServerFileBrowser owns and displays its own selection count.
  return null;
});

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

function close()       { if (!props.busy) emit('close'); }
// Auto-close once the import finishes cleanly. Any failed file keeps the
// modal open so the result list and retry affordance stay visible.
watch([() => props.result, () => props.busy], ([result, busy]) => {
  if (!result || busy) return;
  if (result.results.length > 0 && result.results.every(item => item.status !== 'failed')) close();
});
function basename(p: string): string { return p.split(/[\\/]/).pop() || p; }

// Server file browser emits a batch of already-on-server paths.
function onServerPick(serverPaths: string[]) {
  if (serverPaths.length && !props.busy) emitPick(serverPaths, 'server');
}

function importLocalSelected() {
  if (selectedLocal.value.length && !props.busy) emitPick([...selectedLocal.value], 'local');
}

function importUploadedSelected() {
  if (selectedUploaded.value.length && !props.busy) emitPick([...selectedUploaded.value], 'upload');
}

function emitPick(paths: string[], source: ImportSource = lastImportSource.value) {
  lastImportSource.value = source;
  const options = source === 'upload'
    ? { fileMode: 'copy' as const, duplicatePolicy: 'reuse' as const }
    : { fileMode: fileMode.value, duplicatePolicy: duplicatePolicy.value };
  emit('pick', paths, options);
}

const failedPaths = computed(() => props.result?.results
  .filter(item => item.status === 'failed')
  .map(item => item.sourcePath) ?? []);

function retryFailed() {
  if (failedPaths.value.length) emitPick(failedPaths.value, lastImportSource.value);
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

function toggleLocal(item: string, index: number, e: MouseEvent) {
  selectedLocal.value = clickSelect(localPicked.value, selectedLocal.value, localAnchor, item, index, e);
}

function toggleUploaded(item: string, index: number, e: MouseEvent) {
  selectedUploaded.value = clickSelect(uploadedThisSession.value, selectedUploaded.value, uploadedAnchor, item, index, e);
}

async function pickLocal() {
  const api: any = (globalThis as any).electronAPI;
  if (!api?.selectAudioFiles) return;
  pickingLocal.value = true;
  try {
    const paths: string[] | null = await api.selectAudioFiles();
    if (paths?.length) {
      for (const p of paths) {
        if (!localPicked.value.includes(p)) {
          localPicked.value.push(p);
          selectedLocal.value.push(p);   // pre-select newly picked files
        }
      }
    }
  } finally {
    pickingLocal.value = false;
  }
}

// File-backed browser uploads avoid copying audio through Electron IPC.
async function uploadSelectedFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (files.length === 0) return;

  uploading.value = true;
  try {
    let uploadedCount = 0;
    for (let i = 0; i < files.length; ++i) {
      const file = files[i];
      uploadStatus.value = t('importAudio.uploadingProgress',
        { i: i + 1, total: files.length, name: file.name });
      const out = await server.uploadFile(file, file.name);
      if (out?.saved?.length) {
        for (const savedPath of out.saved) {
          uploadedThisSession.value.push(savedPath);
          selectedUploaded.value.push(savedPath);   // pre-select for one-click import
          uploadedSizes.value[savedPath] = file.size;
          uploadedCount++;
        }
      }
    }
    uploadStatus.value = t('importAudio.uploadedCount', { count: uploadedCount });
  } catch (e: any) {
    uploadStatus.value = t('importAudio.uploadFailed', { error: e?.message ?? e });
  } finally {
    uploading.value = false;
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

  header { display: flex; justify-content: space-between; align-items: center; min-height: 32px; }
  h2 { margin: 0; font-size: 18px; }
  .x {
    display: grid; place-items: center;
    width: 32px; height: 32px; padding: 0;
    background: transparent; border: none; border-radius: var(--control-radius);
    color: var(--color-text-secondary); cursor: pointer; font-size: 18px;
    &:hover { background: var(--color-surface-hover); color: var(--color-text-primary); }
  }

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
  .divider {
    display: flex; align-items: center; gap: 8px;
    font-size: 11px; color: var(--color-text-tertiary); margin: 4px 0;

    &::before, &::after { content: ''; flex: 1; border-top: 1px solid var(--color-border); }
  }

  .source-browser,
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

  .source-browser > :not(summary),
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
  .row { display: flex; gap: 10px; align-items: center; }
  .file-input { display: none; }
  .status { font-size: 12px; color: var(--color-text-secondary); }

  .uploaded {
    list-style: none; margin: 0; padding: 0;
    border: 1px solid var(--color-border); border-radius: var(--control-radius); background: var(--color-background);
    max-height: 200px; overflow: auto;
    li {
      display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; gap: 8px; align-items: center;
      padding: 6px 10px; border-bottom: 1px solid var(--color-border); cursor: pointer;
      &:hover { background: var(--color-surface-hover); }
      &.selected { background: var(--color-accent); .name, .icon, .size { color: var(--color-text-on-accent); } }
      .icon { font-size: 18px; color: var(--color-accent); }
      .name { color: var(--color-text-primary); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      .size { color: var(--color-text-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    }
  }
  .list-footer { display: flex; justify-content: flex-end; }
  .import-progress {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    color: var(--color-text-secondary); font-size: 11px;
  }

  .import-options {
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px;
    padding: 10px; border: 1px solid var(--color-border); border-radius: var(--control-radius); background: var(--color-background);
    label { display: grid; gap: 5px; color: var(--color-text-secondary); font-size: 11px; }
    select { min-width: 0; }
    .option-note { grid-column: 1 / -1; margin: 0; color: var(--color-warning); font-size: 11px; }
  }

  .import-plan {
    border-top: 1px solid var(--color-border);
    padding-top: 10px;
  }
  .plan-heading {
    display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
    margin-bottom: 8px;
    h3 { margin: 0; color: var(--color-text-primary); font-size: 12px; font-weight: 650; }
    .plan-count { color: var(--color-text-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
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
    .destination-note { display: block; margin-top: 2px; color: var(--color-text-tertiary); font-size: 10px; line-height: 1.35; }
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
</style>
