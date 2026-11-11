<template>
  <aside class="repair-notice" :aria-label="t('repair.noticeTitle')">
    <strong role="status">{{ t('repair.noticeTitle') }}</strong>
    <details>
      <summary>{{ t('repair.review') }}</summary>
      <p>{{ t('repair.dataLossWarning') }}</p>
      <ul>
        <li v-for="(issue, index) in notice.issues" :key="index">{{ issue }}</li>
      </ul>
    </details>
    <Btn type="button" :disabled="notice.saving" :text="notice.saving ? t('common.loading') : t('repair.saveRepaired')" @click="emit('save')" />
    <p v-if="notice.failed" role="alert">{{ t('repair.saveFailed') }}</p>
  </aside>
</template>

<script setup lang="ts">
defineProps<{ notice: { issues: string[]; saving: boolean; failed: boolean } }>();
const emit = defineEmits<{ save: [] }>();
const { t } = useLocalization();
</script>

<style scoped>
.repair-notice {
  position: fixed;
  left: 16px;
  bottom: 16px;
  z-index: 1400;
  display: grid;
  gap: 8px;
  width: min(320px, calc(100vw - 32px));
  max-height: 45vh;
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--color-warning);
  border-radius: var(--dialog-radius);
  background: var(--dialog-surface);
  color: var(--color-text-primary);
  box-shadow: var(--dialog-shadow);
}

.repair-notice p { margin: 0; }
.repair-notice summary { cursor: pointer; }
</style>
