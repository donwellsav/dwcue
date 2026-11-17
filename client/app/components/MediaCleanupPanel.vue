<template>
  <!-- File > Clean Up Media. The main process works out which files in the
       show's media folder nothing uses; this lists them and names the ones to
       move to the Trash. It sends file names only, and the main process checks
       each one again before it moves anything. Nothing here is modal, and
       nothing here starts, stops or reloads a cue. -->
  <section class="media-cleanup" :aria-label="t('mediaCleanup.title')" :aria-busy="status === 'loading' || moving">
    <header class="media-cleanup__head">
      <p class="media-cleanup__status" role="status">{{ statusText }}</p>
      <Btn v-if="status !== 'remote' && status !== 'no-folder'" type="button" class="media-cleanup__again"
        icon="refresh" :text="t('mediaCleanup.again')" :disabled="status === 'loading' || moving" @click="refresh" />
    </header>

    <template v-if="status === 'ready' && files.length">
      <div class="media-cleanup__tools">
        <Btn type="button" :text="t('mediaCleanup.selectAll')" :disabled="moving || selected.length === files.length"
          @click="unticked.clear()" />
        <Btn type="button" :text="t('mediaCleanup.selectNone')" :disabled="moving || !selected.length"
          @click="selectNone" />
        <span class="media-cleanup__total">{{ t('mediaCleanup.total', { count: files.length, size: formatSize(totalBytes) }) }}</span>
        <Btn type="button" class="media-cleanup__move" icon="delete" :text="moveText" :disabled="!canMove" @click="move" />
      </div>
      <p v-if="playing" class="media-cleanup__note" role="status">{{ t('mediaCleanup.playing') }}</p>

      <ul class="media-cleanup__list">
        <li v-for="file in files" :key="file.name" class="media-cleanup__row">
          <label class="media-cleanup__file">
            <input type="checkbox" :checked="!unticked.has(file.name)" :disabled="moving" @change="toggle(file.name)" />
            <bdi class="media-cleanup__name">{{ file.name }}</bdi>
          </label>
          <span class="media-cleanup__size">{{ formatSize(file.size) }}</span>
          <span class="media-cleanup__when">{{ formatWhen(file.modifiedAt) }}</span>
        </li>
      </ul>
    </template>

    <div v-if="report" class="media-cleanup__report" role="status">
      <p v-if="report.moved">{{ t('mediaCleanup.moved', { count: report.moved, bin }) }}</p>
      <p v-if="report.error" class="media-cleanup__problem">{{ t('mediaCleanup.moveFailed') }}</p>
      <template v-if="report.failed.length">
        <p class="media-cleanup__problem">{{ t('mediaCleanup.notMoved', { bin }) }}</p>
        <ul class="media-cleanup__names">
          <li v-for="name in report.failed" :key="name"><bdi>{{ name }}</bdi></li>
        </ul>
      </template>
      <template v-if="report.kept.length">
        <p>{{ t('mediaCleanup.kept') }}</p>
        <ul class="media-cleanup__names">
          <li v-for="name in report.kept" :key="name"><bdi>{{ name }}</bdi></li>
        </ul>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import Btn from './Btn.vue';

type Status = 'loading' | 'ready' | 'remote' | 'no-folder' | 'unreadable' | 'failed';

// The most names the main process takes in one request.
const MAX_NAMES = 5000;

const { t, currentLocale } = useLocalization();
const server = useLiveplayServer();
const { currentProject, projectEpoch, projectHydrationStatus, previewItemUuid } = useProject();
const { activeCues } = useAudioEngine();
// A capture that can still be undone goes back to the picture it replaced, and
// only this window knows which picture that is. It is never offered here.
const { lastCapture, canUndo } = useVideoStandbyCapture();

const api = import.meta.client ? window.electronAPI?.media : undefined;
const bin = computed(() => t(import.meta.client && /Windows/i.test(navigator.userAgent)
  ? 'mediaCleanup.recycleBin' : 'mediaCleanup.trash'));

const status = ref<Status>('loading');
const listed = ref<UnusedMediaFile[]>([]);
// What the operator has unticked. Everything else is ticked, including a file
// that first appears when the list is read again.
const unticked = ref(new Set<string>());
const moving = ref(false);
const report = ref<{ moved: number; failed: string[]; kept: string[]; error: boolean } | null>(null);

const fileName = (path: string) => path.split(/[\\/]/).pop() || '';
const heldForUndo = computed(() => canUndo.value ? fileName(lastCapture.value?.previous ?? '').toLowerCase() : '');
const files = computed(() => listed.value.filter(file => file.name.toLowerCase() !== heldForUndo.value));
const selected = computed(() => files.value.filter(file => !unticked.value.has(file.name)));
const totalBytes = computed(() => files.value.reduce((total, file) => total + file.size, 0));
const selectedBytes = computed(() => selected.value.reduce((total, file) => total + file.size, 0));

// Nothing is moved while a cue or Preview is running, or while this window
// and the engine are not agreed on what the show is.
const playing = computed(() => activeCues.value.size > 0 || !!previewItemUuid.value);
const showSettled = computed(() => !!currentProject.value && projectHydrationStatus.value === 'ready'
  && server.connected && !server.cueStartsBlocked);
const canMove = computed(() => status.value === 'ready' && !moving.value && !playing.value && showSettled.value
  && selected.value.length > 0);

// "512 MB", "1.4 GB"; anything under a kilobyte that is not empty is "1 KB".
const formatSize = (bytes: number) => {
  if (bytes < 1024 ** 2) return `${bytes > 0 ? Math.max(1, Math.round(bytes / 1024)) : 0} KB`;
  const [value, unit] = bytes >= 1024 ** 3 ? [bytes / 1024 ** 3, 'GB'] : [bytes / 1024 ** 2, 'MB'];
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${unit}`;
};
const formatWhen = (modifiedAt: number) => new Date(modifiedAt).toLocaleString(currentLocale.value || undefined, {
  dateStyle: 'medium', timeStyle: 'short',
});

const statusText = computed(() => {
  if (status.value === 'loading') return t('mediaCleanup.loading');
  if (status.value === 'remote') return t('mediaCleanup.remote');
  if (status.value === 'no-folder') return t('mediaCleanup.noFolder');
  if (status.value === 'unreadable') return t('mediaCleanup.unreadable');
  if (status.value === 'failed') return t('mediaCleanup.listFailed');
  return files.value.length ? t('mediaCleanup.intro', { bin: bin.value }) : t('mediaCleanup.none');
});
const moveText = computed(() => moving.value ? t('mediaCleanup.moving')
  : t(selected.value.length === 1 ? 'mediaCleanup.moveOne' : 'mediaCleanup.move',
    { count: selected.value.length, bin: bin.value, size: formatSize(selectedBytes.value) }));

function toggle(name: string) {
  if (!unticked.value.delete(name)) unticked.value.add(name);
}

function selectNone() {
  for (const file of files.value) unticked.value.add(file.name);
}

let request = 0;
async function refresh() {
  const mine = ++request;
  status.value = 'loading';
  try {
    const list = await api?.listUnused();
    if (mine !== request) return;
    listed.value = list && 'files' in list ? list.files : [];
    status.value = !list ? 'failed' : 'reason' in list ? list.reason : 'ready';
  } catch {
    if (mine !== request) return;
    listed.value = [];
    status.value = 'failed';
  }
}

async function move() {
  if (!api || !canMove.value) return;
  const names = selected.value.map(file => file.name);
  const outcome = { moved: 0, failed: [] as string[], kept: [] as string[], error: false };
  moving.value = true;
  report.value = null;
  try {
    for (let start = 0; start < names.length; start += MAX_NAMES) {
      // A cue started between two requests: the rest stay where they are, and
      // stay in the list.
      if (playing.value || !showSettled.value) break;
      const result = await api.trashUnused(names.slice(start, start + MAX_NAMES));
      outcome.moved += result.trashed.length;
      outcome.failed.push(...result.failed);
      outcome.kept.push(...result.kept);
    }
  } catch {
    outcome.error = true;
  } finally {
    moving.value = false;
    report.value = outcome;
    void refresh();
  }
}

// Opening the panel is the request to look, and so is the show being loaded
// again. Another folder is another show: what was unticked and what was
// reported belong to the one that was open.
void refresh();
watch(() => [currentProject.value?.folderPath, projectEpoch.value], () => { void refresh(); });
watch(() => currentProject.value?.folderPath, () => {
  unticked.value.clear();
  report.value = null;
});
</script>

<style scoped lang="scss">
.media-cleanup {
  display: grid;
  flex: none;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--workspace-gutter);
  font-size: var(--type-metadata-size);
  overflow-wrap: anywhere;
}

.media-cleanup__head,
.media-cleanup__tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-xs) var(--spacing-sm);
}

/* The selection and the button stay in view while a long list scrolls. */
.media-cleanup__tools {
  position: sticky;
  top: 0;
  z-index: 1;
  padding-block: var(--spacing-xs);
  background: var(--color-background);
}

.media-cleanup__status {
  flex: 1 1 32ch;
  margin: 0;
  line-height: 1.35;
}

.media-cleanup__again,
.media-cleanup__move {
  margin-inline-start: auto;
}

.media-cleanup__total,
.media-cleanup__note {
  margin: 0;
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}

.media-cleanup__move:not(:disabled) {
  border-color: var(--color-warning);
}

/* One grid for every row, so sizes and dates line up under each other. */
.media-cleanup__list {
  display: grid;
  grid-template-columns: minmax(0, 1fr) max-content max-content;
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background: var(--color-surface);
}

.media-cleanup__row {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
  align-items: center;
  gap: 2px var(--spacing-md);
  padding: 2px var(--spacing-sm);
}

.media-cleanup__row + .media-cleanup__row {
  border-top: 1px solid var(--color-border);
}

/* The whole name is the target for its checkbox: 34px tall, as a button is. */
.media-cleanup__file {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  min-width: 0;
  min-height: var(--panel-control-height);
  cursor: pointer;

  input {
    flex: none;
    width: 16px;
    height: 16px;
    margin: 0;
  }
}

.media-cleanup__name {
  min-width: 0;
  font-weight: 600;
}

.media-cleanup__size,
.media-cleanup__when {
  color: var(--color-text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.media-cleanup__size {
  text-align: end;
}

.media-cleanup__report {
  display: grid;
  gap: var(--spacing-xs);

  p {
    margin: 0;
  }
}

.media-cleanup__problem {
  color: var(--color-danger);
}

.media-cleanup__names {
  display: grid;
  gap: 2px;
  margin: 0;
  padding-inline-start: var(--spacing-md);
  color: var(--color-text-secondary);
  list-style: none;
}

/* A narrow panel puts the size and date under the name. */
@container (max-width: 560px) {
  .media-cleanup__list {
    grid-template-columns: minmax(0, 1fr) max-content;
  }

  .media-cleanup__file {
    grid-column: 1 / -1;
  }

  .media-cleanup__size {
    text-align: start;
  }
}
</style>
