<template>
  <Teleport to="body">
    <div v-if="open" class="picker-backdrop" @click.self="cancel">
      <div class="picker">
        <!-- Top toolbar: navigation + breadcrumb path -->
        <header class="toolbar">
          <button class="nav-btn neutral" :disabled="historyBack.length === 0" @click="goBack" title="Back">←</button>
          <button class="nav-btn neutral" :disabled="!canGoUp" @click="goUp" title="Up one level">↑</button>
          <input
            class="path-input"
            v-model="pathDraft"
            @keydown.enter="navigate(pathDraft)"
            placeholder="Type a path and press Enter"
          />
          <button class="nav-btn neutral" @click="navigate('')" title="Computer / drives">
            <span class="material-symbols-rounded">computer</span>
          </button>
        </header>

        <!-- Breadcrumb -->
        <div v-if="!isRoot && currentPath" class="breadcrumb">
          <span v-for="(seg, idx) in breadcrumbs" :key="idx">
            <button class="crumb" @click="navigate(seg.path)">{{ seg.name }}</button>
            <span v-if="idx < breadcrumbs.length - 1" class="crumb-sep">›</span>
          </span>
        </div>

        <div v-if="notice" class="status" role="status">{{ notice }}</div>
        <!-- Favorite shortcuts and main listing share the same server scope. -->
        <div class="browser-body">
          <FavoriteFoldersSidebar
            :favorites="pickerLocations.favorites.value"
            :current-path="currentPath"
            @navigate="navigate"
            @add="pickerLocations.addFavorite"
            @remove="pickerLocations.removeFavorite"
          />
          <div class="listing" :class="{ loading }">
            <div v-if="error" class="status error">{{ error }}</div>
            <div v-else-if="loading" class="status">Loading…</div>
            <ul v-else class="entries">
              <li v-for="entry in sortedEntries"
                  :key="entry.full_path"
                  class="entry"
                  :class="[entry.kind, { selected: selected === entry.full_path }]"
                  @click="onEntryClick(entry)"
                  @dblclick="onEntryActivate(entry)">
                <span class="icon material-symbols-rounded">{{ iconNameFor(entry) }}</span>
                <span class="name">{{ entry.name }}</span>
                <span v-if="entry.kind === 'file' && entry.size != null" class="size">
                  {{ formatBytes(entry.size) }}
                </span>
              </li>
              <li v-if="sortedEntries.length === 0" class="empty">
                <em>{{ filterLabel }} — no matching items in this folder.</em>
              </li>
            </ul>
          </div>
        </div>

        <!-- Bottom bar: selection + filter + action buttons -->
        <footer class="footer">
          <div v-if="mode === 'file'" class="filename-row">
            <label>File:&nbsp;</label>
            <input class="filename" v-model="filenameDraft" placeholder="(select a file above)" />
          </div>
          <!-- New-folder inline form — shown while creating -->
          <div v-if="newFolderMode" class="newfolder-row">
            <span class="material-symbols-rounded newfolder-icon">create_new_folder</span>
            <input
              ref="newFolderInput"
              class="newfolder-name"
              v-model="newFolderName"
              placeholder="New folder name"
              @keydown.enter="confirmNewFolder"
              @keydown.escape="cancelNewFolder"
            />
            <button class="btn primary small" @click="confirmNewFolder" :disabled="!newFolderName.trim()">Create</button>
            <button class="btn small" @click="cancelNewFolder">Cancel</button>
          </div>
          <div class="filter-row">
            <select v-if="mode === 'file'" v-model="filter" @change="reload" class="filter">
              <option v-if="filterOptions.includes('audio')" value="audio">Audio files</option>
              <option v-for="opt in filterOptions.filter(o => o !== 'audio' && o !== 'all')"
                      :key="opt" :value="opt">{{ filterDisplay(opt) }}</option>
              <option v-if="filterOptions.includes('all')" value="all">All files</option>
            </select>
            <button
              v-if="!isRoot"
              class="btn"
              :disabled="newFolderMode || loading || !!error || !listing"
              @click="startNewFolder"
              title="New folder"
            >
              <span class="material-symbols-rounded" style="font-size:16px;vertical-align:middle;">create_new_folder</span>
              New folder
            </button>
            <span class="spacer"></span>
            <button class="btn" @click="cancel">Cancel</button>
            <button class="btn primary" :disabled="!canConfirm" @click="confirm">
              {{ mode === 'directory' ? 'Select folder' : 'Open' }}
            </button>
          </div>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<!--
  ServerFilePickerModal.vue
  -----------------------------------------------------------------------
  Native-feeling file picker driven entirely by the server's /api/fs/list
  endpoint. Lets the user browse the server's full filesystem (drives,
  network shares, anywhere), so a client running in remote mode can open
  projects/media stored on the server.

  Props:
    open       : boolean   — modal visibility (v-model:open style)
    mode       : 'file' | 'directory'
                            — pick a file (with extension filter) or a folder
    filter     : string    — initial filter token, e.g. 'audio', 'all',
                              '.dwcue,.liveplay', '.dwcuepack,.lpa'
    filterOptions: string[]— filters offered in the dropdown
    startPath  : string    — initial directory (empty = computer root)
    title      : string    — header text shown if you want one

  Emits:
    pick(fullPath: string) — user confirmed a selection
    close                  — user cancelled
-->
<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import FavoriteFoldersSidebar from './FavoriteFoldersSidebar.vue';
import {
  pickerLocationContext,
  resolvePickerStartPath,
  useFilePickerLocations,
} from '~/composables/useFilePickerLocations';
import { useLiveplayServer } from '~/composables/useLiveplayServer';
import type { ServerFsEntry, ServerFsListing } from '~/types/server';

const props = withDefaults(defineProps<{
  open:               boolean;
  mode?:              'file' | 'directory';
  filter?:            string;
  filterOptions?:     string[];
  startPath?:         string;
  fallbackStartPath?: string;
  locationContext?:   string;
}>(), {
  mode:          'file',
  filter:        'audio',
  filterOptions: () => ['audio', 'all'],
});

const emit = defineEmits<{
  (e: 'pick', fullPath: string): void;
  (e: 'close'): void;
}>();

const server = useLiveplayServer();
const pickerContext = computed(() => props.locationContext ?? pickerLocationContext(props.mode, props.filter));
const pickerLocations = useFilePickerLocations(
  () => String(server.serverUrl),
  pickerContext,
);

// ---------------------------------------------------------------------------
// Local state — current listing, selection, breadcrumbs, history
// ---------------------------------------------------------------------------
const listing       = ref<ServerFsListing | null>(null);
const loading       = ref(false);
const error         = ref<string | null>(null);
const notice        = ref<string | null>(null);
const { t } = useLocalization();
const selected      = ref<string>('');
const filenameDraft = ref<string>('');
const pathDraft     = ref<string>('');
const filter        = ref<string>(props.filter);

// Simple back-history (no forward stack; native dialogs work fine without).
const historyBack = ref<string[]>([]);
let navigationRevision = 0;
onScopeDispose(() => { navigationRevision++; });

const currentPath = computed(() => listing.value?.path ?? '');
const isRoot      = computed(() => !!listing.value?.is_root);
const canGoUp     = computed(() =>
  !!listing.value && (!!listing.value.parent || !listing.value.is_root));

const breadcrumbs = computed(() => {
  const path = currentPath.value;
  if (!path) return [];
  // Split on / OR \ and rebuild absolute segments
  const isWin = /^[A-Za-z]:[\\/]/.test(path);
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const segs: { name: string; path: string }[] = [];
  if (isWin) {
    const drive = parts[0]; // e.g. "F:"
    segs.push({ name: drive, path: drive + '\\' });
    let cur = drive + '\\';
    for (let i = 1; i < parts.length; ++i) {
      cur = cur + parts[i] + '\\';
      segs.push({ name: parts[i], path: cur });
    }
  } else {
    let cur = '/';
    segs.push({ name: '/', path: cur });
    for (const p of parts) {
      cur = cur + p + '/';
      segs.push({ name: p, path: cur });
    }
  }
  return segs;
});

const sortedEntries = computed(() => {
  const list = listing.value?.entries ?? [];
  // Home first, then drives, directories, files. Alpha within each group.
  const rank: Record<string, number> = { home: 0, drive: 1, dir: 2, file: 3 };
  return [...list].sort((a, b) => {
    const r = (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9);
    return r !== 0 ? r : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
});

const canConfirm = computed(() => {
  if (loading.value || error.value || !listing.value) return false;
  if (props.mode === 'directory') {
    // In directory mode the user confirms the current folder, or an
    // explicitly-selected one. Disallow at the computer root.
    return !isRoot.value && (!!selected.value || !!currentPath.value);
  }
  return !!selected.value && fileFor(selected.value)?.kind === 'file';
});

const filterLabel = computed(() => filterDisplay(filter.value));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function iconNameFor(entry: ServerFsEntry): string {
  if (entry.kind === 'home')  return 'home';
  if (entry.kind === 'drive') return 'storage';
  if (entry.kind === 'dir')   return 'folder';
  return 'description';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function filterDisplay(f: string): string {
  if (f === 'all')        return 'All files';
  if (f === 'audio')      return 'Audio files';
  if (f === '.dwcue') return 'DonWells Cue Shows (.dwcue)';
  if (f === '.liveplay') return 'Legacy Shows (.liveplay)';
  if (f === '.dwcue,.liveplay') return 'DonWells Cue Shows (.dwcue; legacy .liveplay)';
  if (f === '.dwcuepack') return 'DonWells Cue Show Archives (.dwcuepack)';
  if (f === '.dwcuepack,.lpa') return 'DonWells Cue Show Archives (.dwcuepack; legacy .lpa)';
  return f;
}

function fileFor(fullPath: string): ServerFsEntry | undefined {
  return listing.value?.entries.find(e => e.full_path === fullPath);
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
async function navigate(path: string, recordHistory = true, fallbackPath?: string): Promise<boolean> {
  const revision = ++navigationRevision;
  const endpoint = String(server.serverUrl);
  const previousPath = listing.value?.path;
  const isCurrent = () => revision === navigationRevision && props.open && endpoint === String(server.serverUrl);
  loading.value = true;
  error.value = null;
  notice.value = null;
  selected.value = '';
  filenameDraft.value = '';
  pathDraft.value = path;
  try {
    const next = await server.listServerPath(path, filter.value);
    if (!isCurrent()) return false;
    if (recordHistory && previousPath !== undefined && previousPath !== next.path) {
      historyBack.value.push(previousPath);
    }
    listing.value = next;
    pathDraft.value = next.path;
    pickerLocations.rememberFolder(next.path);
    return true;
  } catch (cause) {
    if (!isCurrent()) return false;
    const message = cause instanceof Error ? cause.message : String(cause);
    if (fallbackPath !== undefined && /^404(?:\s|$)/.test(message)) {
      const recovered = await navigate(fallbackPath, false);
      if (recovered) notice.value = t('filePicker.unavailableFolder', { path });
      return recovered;
    }
    error.value = message;
    return false;
  } finally {
    if (isCurrent()) loading.value = false;
  }
}

function reload() { void navigate(currentPath.value, false); }

function goUp() {
  if (!listing.value) return;
  if (listing.value.parent) navigate(listing.value.parent);
  else if (!listing.value.is_root) navigate('');   // back to drive root
}

async function goBack() {
  const previous = historyBack.value.at(-1);
  if (previous !== undefined && await navigate(previous, false)) historyBack.value.pop();
}

function onEntryClick(entry: ServerFsEntry) {
  if (loading.value || error.value) return;
  selected.value = entry.full_path;
  if (entry.kind === 'file') filenameDraft.value = entry.name;
  else filenameDraft.value = '';
}

function onEntryActivate(entry: ServerFsEntry) {
  if (loading.value || error.value) return;
  if (entry.kind === 'dir' || entry.kind === 'drive' || entry.kind === 'home') {
    navigate(entry.full_path);
  } else if (entry.kind === 'file') {
    selected.value = entry.full_path;
    confirm();
  }
}

function confirm() {
  if (!canConfirm.value) return;
  if (props.mode === 'directory') {
    // Prefer an explicit folder selection; fall back to the current folder.
    const chosen = (selected.value && fileFor(selected.value)?.kind === 'dir')
      ? selected.value
      : currentPath.value;
    pickerLocations.rememberFolder(chosen);
    emit('pick', chosen);
  } else {
    emit('pick', selected.value);
  }
}

function cancel() { emit('close'); }

// ---------------------------------------------------------------------------
// New-folder inline creation
// ---------------------------------------------------------------------------
const newFolderMode  = ref(false);
const newFolderName  = ref('');
const newFolderInput = ref<HTMLInputElement | null>(null);

async function startNewFolder() {
  if (isRoot.value) return;
  newFolderName.value = '';
  newFolderMode.value = true;
  await nextTick();
  newFolderInput.value?.focus();
}

async function confirmNewFolder() {
  const name = newFolderName.value.trim();
  if (!name) return;
  const parent = currentPath.value;
  if (!parent) return;
  const isWin = /^[A-Za-z]:[\\/]/.test(parent);
  const sep = isWin ? '\\' : '/';
  const newPath = parent.replace(/[\\/]+$/, '') + sep + name;
  try {
    await server.createServerDirectory(newPath);
    newFolderMode.value = false;
    newFolderName.value = '';
    await navigate(newPath);   // navigate into the freshly-created folder
  } catch (e: any) {
    error.value = String(e?.message ?? e);
    newFolderMode.value = false;
    newFolderName.value = '';
  }
}

function cancelNewFolder() {
  newFolderMode.value = false;
  newFolderName.value = '';
}

// ---------------------------------------------------------------------------
// Open / close lifecycle
// ---------------------------------------------------------------------------
watch([() => props.open, () => String(server.serverUrl), () => props.mode, () => props.filter,
  () => props.startPath, () => props.fallbackStartPath, () => props.locationContext], () => {
  navigationRevision++;
  loading.value = false;
  error.value = null;
  notice.value = null;
  selected.value = '';
  filenameDraft.value = '';
  listing.value = null;
  historyBack.value = [];
  newFolderMode.value = false;
  if (!props.open) return;
  filter.value = props.filter;
  const remembered = pickerLocations.lastFolder.value;
  const start = resolvePickerStartPath(props.startPath, remembered, props.fallbackStartPath);
  const fallback = props.startPath === undefined && remembered !== undefined && start
    ? (props.fallbackStartPath !== start ? props.fallbackStartPath ?? '' : '') : undefined;
  void navigate(start, false, fallback);
}, { immediate: true });
</script>

<style lang="scss" scoped>
.picker-backdrop {
  position: fixed; inset: 0; z-index: 9100;
  background: var(--dialog-backdrop);
  display: flex; align-items: center; justify-content: center;
}
.picker {
  width: min(820px, 95vw);
  height: min(640px, 90vh);
  background: var(--dialog-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--dialog-radius);
  display: flex; flex-direction: column;
  color: var(--color-text-primary);
  font-size: 13px;
  overflow: hidden;
  box-shadow: var(--dialog-shadow);
}
.toolbar {
  display: flex; gap: var(--spacing-sm); padding: var(--spacing-md);
  border-bottom: 1px solid var(--color-border);
  .nav-btn {
    min-height: 32px; border-radius: var(--control-radius); padding: 4px 10px;
    cursor: pointer;
  }
  .nav-btn.neutral {
    background: var(--color-surface-raised); border: 1px solid var(--color-border);
    color: var(--color-text-primary);
    &:hover:not(:disabled) { background: var(--color-surface-hover); border-color: var(--color-border-strong); }
    &:disabled { opacity: 0.4; cursor: not-allowed; }
  }
  .path-input {
    flex: 1;
    background: var(--color-control); border: 1px solid var(--color-border);
    border-radius: var(--control-radius); padding: 4px 10px;
    color: var(--color-text-primary); font-family: var(--font-mono); font-size: 12px;
  }
}
.breadcrumb {
  padding: 6px 12px; font-size: 11px; color: var(--color-text-secondary);
  border-bottom: 1px solid var(--color-border); background: var(--color-background);
  .crumb {
    background: transparent; border: none; color: var(--color-accent); cursor: pointer;
    padding: 2px 4px; font-size: 11px;
    &:hover { text-decoration: underline; }
  }
  .crumb-sep { color: var(--color-text-tertiary); padding: 0 2px; }
}
.browser-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.listing {
  flex: 1; min-height: 0; overflow: auto;
  background: var(--color-background);
  &.loading { opacity: 0.6; }
}
.entries {
  list-style: none; margin: 0; padding: 0;
}
.entry {
  display: grid; grid-template-columns: 28px 1fr auto;
  gap: 8px; align-items: center; padding: 6px 14px;
  cursor: pointer; border-bottom: 1px solid var(--color-border);
  &:hover { background: var(--color-surface-hover); }
  // Drives & folders: white icons. Selectable files: accent icon, white name.
  .icon { text-align: center; color: var(--color-text-primary); }
  &.file .icon { color: var(--color-accent); }
  .name { color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .size { color: var(--color-text-tertiary); font-family: var(--font-mono); font-size: 11px; }
  &.drive .name,
  &.home .name { font-weight: 600; }
  &.selected {
    background: var(--color-accent);
    .name, .icon, .size { color: var(--color-text-on-accent); }
  }
}
.empty {
  padding: 18px; text-align: center; color: var(--color-text-tertiary); font-style: italic;
}
.status {
  padding: 18px; text-align: center;
  &.error { color: var(--color-danger); }
}
.footer {
  border-top: 1px solid var(--color-border);
  padding: var(--dialog-footer-padding);
  display: flex; flex-direction: column; gap: 8px;
  background: var(--dialog-surface);
}
.filename-row {
  display: flex; align-items: center; gap: 6px;
  .filename {
    flex: 1;
    background: var(--color-control); border: 1px solid var(--color-border);
    border-radius: var(--control-radius); padding: 4px 10px;
    color: var(--color-text-primary);
  }
}
.filter-row {
  display: flex; align-items: center; gap: 8px;
  .filter {
    background: var(--color-control); border: 1px solid var(--color-border); color: var(--color-text-primary);
    padding: 4px 8px; border-radius: var(--control-radius);
  }
  .spacer { flex: 1; }
  .btn {
    min-height: var(--panel-control-height);
    background: var(--color-surface-raised); border: 1px solid var(--color-border);
    border-radius: var(--control-radius); padding: 6px 16px; color: var(--color-text-primary); cursor: pointer;
    display: inline-flex; align-items: center; gap: 4px;
    &:hover:not(:disabled) { background: var(--color-surface-hover); border-color: var(--color-border-strong); }
    &:disabled { opacity: 0.5; cursor: not-allowed; }
    &.primary { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-text-on-accent); }
    &.small { min-height: 28px; padding: 4px 10px; font-size: 12px; }
  }
}
.newfolder-row {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 0;
  border-top: 1px solid var(--color-border);
  .newfolder-icon { color: var(--color-accent); font-size: 18px; flex-shrink: 0; }
  .newfolder-name {
    flex: 1;
    background: var(--color-control); border: 1px solid var(--color-border);
    border-radius: var(--control-radius); padding: 4px 10px;
    color: var(--color-text-primary); font-size: 13px;
    &:focus { outline: none; border-color: var(--color-accent); }
  }
  .btn {
    min-height: 28px;
    background: var(--color-surface-raised); border: 1px solid var(--color-border);
    border-radius: var(--control-radius); padding: 4px 10px; font-size: 12px; color: var(--color-text-primary); cursor: pointer;
    &:hover:not(:disabled) { background: var(--color-surface-hover); border-color: var(--color-border-strong); }
    &:disabled { opacity: 0.5; cursor: not-allowed; }
    &.primary { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-text-on-accent); }
  }
}
</style>
