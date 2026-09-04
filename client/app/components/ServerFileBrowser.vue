<template>
  <div class="server-file-browser">
    <div class="server-file-browser__bar">
      <button class="btn" :disabled="!canGoUp" @click="goUp" title="Up one level">
        <span class="material-symbols-rounded" style="font-size:16px;vertical-align:middle;">arrow_upward</span>
        Up
      </button>
      <input
        v-model="pathInput"
        class="path-input"
        @keydown.enter="goTo(pathInput)"
        placeholder="Server path (Enter to browse)"
      />
      <button class="btn primary" @click="goTo(pathInput)">Go</button>
    </div>

    <div v-if="error" class="error">{{ error }}</div>
    <div v-else-if="loading" class="status">Loading…</div>

    <ul v-else class="entries">
      <li v-for="(entry, idx) in sortedEntries"
          :key="entry.full_path"
          class="entry"
          :class="[entry.kind, {
            selected: isSelected(entry.full_path),
            'unsupported-file': isObviouslyNonMedia(entry),
            'unknown-file': isUnknownFileType(entry),
          }]"
          :aria-disabled="isObviouslyNonMedia(entry) ? 'true' : undefined"
          @click="onEntryClick(entry, idx, $event)"
          @dblclick="onEntryActivate(entry)">
        <span class="icon material-symbols-rounded">{{ iconFor(entry) }}</span>
        <span class="name">{{ entry.name }}</span>
        <span v-if="isObviouslyNonMedia(entry)" class="size file-type-note unsupported">{{ t('importAudio.unsupportedFileType') }}</span>
        <span v-else-if="isUnknownFileType(entry)" class="size file-type-note">{{ t('importAudio.verifyFileType') }}</span>
        <span v-else-if="entry.kind === 'file' && entry.size != null" class="size">{{ formatBytes(entry.size) }}</span>
      </li>
      <li v-if="(listing?.entries?.length ?? 0) === 0" class="empty">
        {{ t('importAudio.emptyServerFolder') }}
      </li>
    </ul>

    <div v-if="canSelect" class="server-file-browser__footer">
      <span class="sel-count">{{ selectedCountLabel }}</span>
      <button class="btn primary" :disabled="selected.length === 0" @click="importSelected">
        {{ t('importAudio.importSelected') }}<span v-if="selected.length"> ({{ selected.length }})</span>
      </button>
    </div>
  </div>
</template>

<!--
  ServerFileBrowser.vue
  -----------------------------------------------------------------------
  Browse the *server's* filesystem (not the client's) via /api/fs/list, so
  the client can pick cue files when running against a remote DonWells Cue
  server. The 1.x client used Electron's dialog.showOpenDialog which only
  worked when client and audio engine ran on the same machine.

  Selection model:
    Files can be multi-selected (plain click = single, Ctrl/Cmd-click =
    toggle, Shift-click = range). A single "Import selected" button at the
    bottom emits the whole batch. Double-clicking a file imports it directly;
    double-clicking a folder/drive descends into it.

  Emits:
    select(fullPaths: string[]) — user picked one or more audio files.
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useLiveplayServer } from '~/composables/useLiveplayServer';
import type { ServerFsEntry, ServerFsListing } from '~/types/server';

const props = withDefaults(defineProps<{
  startPath?: string;
  canSelect?: boolean;
}>(), {
  startPath: '',
  canSelect: true,
});

const emit = defineEmits<{
  (e: 'select', fullPaths: string[]): void;
}>();

const server = useLiveplayServer();
const { t }  = useLocalization();
const listing = ref<ServerFsListing | null>(null);
const loading = ref(false);
const error   = ref<string | null>(null);
const pathInput = ref<string>(props.startPath);

// Multi-selection of file paths. `anchorIndex` is the last plain/Ctrl click,
// used as the pivot for Shift-range selection.
const selected   = ref<string[]>([]);
let   anchorIndex = -1;

const canGoUp = computed(() =>
  !!listing.value && (!!listing.value.parent || !listing.value.is_root));

const sortedEntries = computed(() => {
  const entries = listing.value?.entries ?? [];
  const rank: Record<string, number> = { home: 0, drive: 1, dir: 2, file: 3 };
  return [...entries].sort((a, b) => {
    const r = (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9);
    return r !== 0 ? r : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
});

const selectedCountLabel = computed(() =>
  selected.value.length ? t('importAudio.selectedCount', { count: selected.value.length }) : '');

function isSelected(p: string): boolean { return selected.value.includes(p); }

const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.wav', '.aiff', '.aif', '.flac', '.ogg', '.oga', '.m4a', '.aac',
  '.mp2', '.wma', '.opus', '.ac3', '.amr', '.au', '.caf',
]);
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mpg', '.mpeg', '.m2ts',
  '.mts', '.wmv', '.flv', '.3gp',
]);
const OBVIOUS_NON_MEDIA_EXTENSIONS = new Set([
  '.txt', '.md', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.json', '.xml', '.csv', '.html', '.css', '.js', '.ts', '.vue', '.liveplay',
  '.lpa', '.zip', '.rar', '.7z', '.tar', '.gz', '.dmg', '.exe', '.app',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
]);

function fileExtension(entry: ServerFsEntry): string {
  if (entry.kind !== 'file') return '';
  const match = /\.[a-z0-9]+$/i.exec(entry.name);
  return match?.[0].toLowerCase() ?? '';
}

function isObviouslyNonMedia(entry: ServerFsEntry): boolean {
  return OBVIOUS_NON_MEDIA_EXTENSIONS.has(fileExtension(entry));
}

function isUnknownFileType(entry: ServerFsEntry): boolean {
  if (entry.kind !== 'file' || isObviouslyNonMedia(entry)) return false;
  const extension = fileExtension(entry);
  return !AUDIO_EXTENSIONS.has(extension) && !VIDEO_EXTENSIONS.has(extension);
}

function iconFor(entry: ServerFsEntry): string {
  if (entry.kind === 'home') return 'home';
  if (entry.kind === 'drive') return 'storage';
  if (entry.kind === 'dir') return 'folder';
  const extension = fileExtension(entry);
  if (VIDEO_EXTENSIONS.has(extension)) return 'movie';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio_file';
  return 'draft';
}

async function goTo(path: string) {
  loading.value = true;
  error.value   = null;
  try {
    listing.value   = await server.listServerPath(path);
    pathInput.value = listing.value.path;
    selected.value  = [];
    anchorIndex     = -1;
  } catch (e: any) {
    error.value = String(e.message || e);
  } finally {
    loading.value = false;
  }
}

function goUp() {
  if (!listing.value) return;
  if (listing.value.parent) goTo(listing.value.parent);
  else if (!listing.value.is_root) goTo('');   // at a drive root → drive menu
}

function onEntryClick(entry: ServerFsEntry, index: number, e: MouseEvent) {
  if (!props.canSelect || entry.kind !== 'file' || isObviouslyNonMedia(entry)) return;
  const multi = e.ctrlKey || e.metaKey;
  const range = e.shiftKey;

  if (range && anchorIndex >= 0) {
    const [lo, hi] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
    const inRange = sortedEntries.value
      .slice(lo, hi + 1)
      .filter(en => en.kind === 'file' && !isObviouslyNonMedia(en))
      .map(en => en.full_path);
    selected.value = multi
      ? Array.from(new Set([...selected.value, ...inRange]))
      : inRange;
  } else if (multi) {
    selected.value = isSelected(entry.full_path)
      ? selected.value.filter(p => p !== entry.full_path)
      : [...selected.value, entry.full_path];
    anchorIndex = index;
  } else {
    selected.value = [entry.full_path];
    anchorIndex = index;
  }
}

function onEntryActivate(entry: ServerFsEntry) {
  if (entry.kind === 'dir' || entry.kind === 'drive' || entry.kind === 'home') {
    goTo(entry.full_path);
  } else if (props.canSelect && !isObviouslyNonMedia(entry)) {
    emit('select', [entry.full_path]);
  }
}

function importSelected() {
  if (selected.value.length === 0) return;
  emit('select', [...selected.value]);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

onMounted(() => goTo(props.startPath));
watch(() => props.startPath, p => goTo(p));
</script>

<style lang="scss" scoped>
.server-file-browser {
  display: flex;
  flex-direction: column;
  gap: 8px;

  &__bar {
    display: flex;
    gap: 6px;

    .path-input {
      flex: 1;
      padding: 6px 10px;
      background: var(--color-control);
      border: 1px solid var(--color-border);
      border-radius: var(--control-radius);
      color: var(--color-text-primary);
      font-family: var(--font-mono);
    }
  }

  &__footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;

    .sel-count { color: var(--color-text-secondary); font-size: 12px; }
  }

  .btn {
    min-height: var(--panel-control-height);
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--control-radius);
    padding: 6px 12px;
    color: var(--color-text-primary);
    cursor: pointer;
    display: inline-flex; align-items: center; gap: 4px;
    &:hover:not(:disabled) { background: var(--color-surface-hover); border-color: var(--color-border-strong); }
    &:disabled { opacity: 0.5; cursor: not-allowed; }
    &.primary  { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-text-on-accent); }
    &.small    { min-height: 28px; padding: 2px 8px; font-size: 12px; }
  }

  .entries {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 400px;
    overflow: auto;
    border: 1px solid var(--color-border);
    border-radius: var(--control-radius);
    background: var(--color-background);

    .entry {
      display: grid;
      grid-template-columns: 28px 1fr auto;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      cursor: pointer;
      border-bottom: 1px solid var(--color-border);
      user-select: none;
      &:last-child { border-bottom: none; }
      &:hover { background: var(--color-surface-hover); }
      .size   { color: var(--color-text-tertiary); font-size: 11px; font-family: var(--font-mono); }
      .name   { color: var(--color-text-primary); }
      &.drive .name,
      &.home .name { font-weight: 600; }
      .icon { font-size: 18px; text-align: center; color: var(--color-text-primary); }
      &.file .icon { color: var(--color-accent); }

      &.unsupported-file {
        cursor: not-allowed;
        opacity: .58;

        .icon,
        .name,
        .size { color: var(--color-text-tertiary); }
      }

      &.unknown-file .icon { color: var(--color-text-secondary); }

      .file-type-note {
        font-size: 10px;
        font-style: italic;
      }

      .file-type-note.unsupported { color: var(--color-danger); }
      &.selected {
        background: var(--color-accent);
        .name, .icon, .size { color: var(--color-text-on-accent); }
      }
    }
    .empty {
      padding: 12px;
      text-align: center;
      color: var(--color-text-tertiary);
      font-style: italic;
    }
  }
  .error  { color: var(--color-danger); padding: 8px; }
  .status { color: var(--color-text-tertiary); padding: 8px; }
}
</style>
