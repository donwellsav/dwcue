<template>
  <div class="repair-notice">
    <div class="repair-actions">
      <p>{{ t('repair.dataLossWarning') }}</p>
      <Btn type="button" :disabled="notice.saving" :aria-busy="notice.saving"
        :text="notice.saving ? t('common.loading') : t('repair.saveRepaired')" @click="emit('save')" />
    </div>
    <p v-if="notice.failed" role="alert">{{ t('repair.saveFailed') }}</p>
    <ul v-if="notice.issues.length">
      <li v-for="(issue, index) in notice.issues" :key="index">{{ issue }}</li>
    </ul>
  </div>
</template>

<script setup lang="ts">
defineProps<{ notice: { issues: string[]; saving: boolean; failed: boolean } }>();
const emit = defineEmits<{ save: [] }>();
const { t } = useLocalization();
</script>

<style scoped>
.repair-notice {
  display: grid;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) var(--workspace-gutter);
  overflow-wrap: anywhere;
}

.repair-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--spacing-xs); }
.repair-notice ul { margin: 0; padding-inline-start: 2ch; }
.repair-notice p { margin: 0; }
.repair-notice [role='alert'] { color: var(--color-danger); }
</style>
