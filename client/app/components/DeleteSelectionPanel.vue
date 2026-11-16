<template>
  <section v-if="pendingDelete" class="delete-selection" :aria-label="t('deleteSelection.title')">
    <p role="status">{{ count === 1 ? t('actions.confirmDelete', { name: pendingDelete.name })
      : t('deleteSelection.message', { count }) }}</p>
    <div class="delete-selection-actions">
      <Btn type="button" :text="t('deleteSelection.cancel')" @click="cancelDelete" />
      <Btn v-if="pendingDelete.onlyUuid" type="button"
        :text="t('deleteSelection.deleteOnly', { name: shortenedName })"
        :title="pendingDelete.name" @click="confirmDelete(true)" />
      <Btn type="button" class="delete-selection-danger" icon="delete"
        :text="count === 1 ? t('actions.delete') : t('deleteSelection.deleteAll', { count })"
        @click="confirmDelete(false)" />
    </div>
  </section>
</template>

<script setup lang="ts">
const { pendingDelete, confirmDelete, cancelDelete } = useProject();
const { t } = useLocalization();
const count = computed(() => pendingDelete.value?.uuids.length ?? 0);
const shortenedName = computed(() => {
  const name = pendingDelete.value?.name ?? '';
  return name.length > 32 ? `${name.slice(0, 31)}…` : name;
});
</script>

<style scoped>
.delete-selection {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
  border-top: 1px solid var(--color-border);
  padding: 8px 12px;
}
.delete-selection p {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--color-text-secondary);
}
.delete-selection-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.delete-selection-actions .delete-selection-danger {
  color: var(--color-danger);
  border-color: var(--color-danger);
}
</style>
