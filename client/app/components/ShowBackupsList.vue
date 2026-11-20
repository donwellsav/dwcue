<template>
  <!-- The engine keeps recent copies of the show file by itself. This lists
       them and lets the operator go back to one; the show as it is now is
       backed up first, so a restore can itself be undone. Settings supplies
       the heading and the explanation around it. -->
  <div class="show-backups">
    <p v-if="loading && backups.length === 0" class="show-backups__status" role="status">{{ t('common.loading') }}</p>
    <p v-else-if="listError" class="show-backups__error" role="alert">{{ t('backups.listFailed', { reason: listError }) }}</p>
    <p v-else-if="backups.length === 0" class="show-backups__status">{{ t('backups.none') }}</p>

    <ul v-else class="show-backups__list">
      <li v-for="backup in backups" :key="backup.name" class="show-backups__row">
        <span class="show-backups__when">{{ formatWhen(backup.savedAt) }}</span>
        <span class="show-backups__size">{{ formatSize(backup.size) }}</span>
        <template v-if="confirming === backup.name">
          <span class="show-backups__confirm">{{ t('backups.confirm') }}</span>
          <Btn type="button" class="show-backups__restore" :text="t('backups.restore')"
            :disabled="restoring" @click="restore(backup)" />
          <Btn type="button" :text="t('common.cancel')" :disabled="restoring" @click="confirming = null" />
        </template>
        <Btn v-else type="button" icon="history" :text="t('backups.restore')"
          :aria-label="t('backups.restoreFrom', { when: formatWhen(backup.savedAt) })"
          :disabled="restoring || !ready" @click="confirming = backup.name" />
      </li>
    </ul>

    <p v-if="restoreError" class="show-backups__error" role="alert">{{ t('backups.restoreFailed', { reason: restoreError }) }}</p>
  </div>
</template>

<script setup lang="ts">
import Btn from './Btn.vue';

interface ShowBackup { name: string; savedAt: number; size: number }

const { t, currentLocale } = useLocalization();
const server = useLiveplayServer();
const { currentProject, projectHydrationStatus, hasUnsavedChanges } = useProject();
const { showHeaderWarning } = useHeaderWarnings();

const backups = ref<ShowBackup[]>([]);
const loading = ref(false);
const listError = ref('');
const restoreError = ref('');
const confirming = ref<string | null>(null);
const restoring = ref(false);
const ready = computed(() => !!currentProject.value && projectHydrationStatus.value === 'ready');

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 200);

const formatWhen = (savedAt: number) => new Date(savedAt).toLocaleString(currentLocale.value || undefined, {
  dateStyle: 'medium', timeStyle: 'medium',
});
const formatSize = (bytes: number) => bytes >= 1024 * 1024
  ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  : `${Math.max(1, Math.round(bytes / 1024))} KB`;

let request = 0;
async function refresh() {
  const mine = ++request;
  if (!currentProject.value) { backups.value = []; listError.value = ''; return; }
  loading.value = true;
  try {
    const list = await server.listShowBackups();
    if (mine !== request) return;
    backups.value = list;
    listError.value = '';
  } catch (error) {
    if (mine !== request) return;
    listError.value = reason(error);
  } finally {
    if (mine === request) loading.value = false;
  }
}

async function restore(backup: ShowBackup) {
  if (restoring.value) return;
  restoring.value = true;
  restoreError.value = '';
  // The engine keeps this show's unsaved edits in the restore's undo backup,
  // so the restored show replaces it here too, instead of the window asking
  // whose show should win (where keeping its own would undo the restore).
  const wasUnsaved = hasUnsavedChanges.value;
  hasUnsavedChanges.value = false;
  try {
    await server.restoreShowBackup(backup.name);
    confirming.value = null;
    showHeaderWarning(t('backups.restored', { when: formatWhen(backup.savedAt) }));
  } catch (error) {
    hasUnsavedChanges.value = wasUnsaved;
    restoreError.value = reason(error);
  } finally {
    restoring.value = false;
    void refresh();
  }
}

// Listed when Settings shows this, and again whenever the show is saved or
// replaced, since each of those can add a backup.
onMounted(refresh);
watch(() => [currentProject.value?.folderPath, currentProject.value?.name, projectHydrationStatus.value], refresh);
</script>

<style scoped lang="scss">
.show-backups {
  display: grid;
  gap: var(--spacing-xs);
  min-width: 0;
}

.show-backups__status {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.show-backups__list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr));
  gap: var(--spacing-xs);
  margin: 0;
  padding: 0;
  list-style: none;
}

.show-backups__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-sm);
  min-height: 32px;
  padding: 2px var(--spacing-sm);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background: var(--color-control);
}

.show-backups__when {
  flex: 1 1 14ch;
  font-variant-numeric: tabular-nums;
}

.show-backups__size {
  color: var(--color-text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.show-backups__confirm { color: var(--color-warning); }

.show-backups__restore { border-color: var(--color-warning); }

.show-backups__error {
  margin: 0;
  color: var(--color-danger);
  font-size: 12px;
}
</style>
