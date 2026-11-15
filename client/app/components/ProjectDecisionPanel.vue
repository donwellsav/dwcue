<template>
  <section class="project-decision-panel" :aria-label="title">
    <header class="workspace-panel-header">
      <h2 class="workspace-panel-header__title">{{ title }}</h2>
    </header>
    <div class="decision-row">
      <p role="status">{{ message }}</p>
      <div class="decision-actions">
        <Btn v-for="button in buttons" :key="button.key" type="button"
          :text="button.label" :icon="button.icon" :class="button.variant"
          @click="$emit('pick', button.key)" />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
defineProps<{
  title: string;
  message: string;
  buttons: { key: string; label: string; variant?: 'primary' | 'danger'; icon?: string }[];
}>();

defineEmits<{ pick: [key: string] }>();
</script>

<style scoped>
.project-decision-panel {
  flex: 0 1 auto;
  min-height: 0;
  overflow: auto;
  border-top: 1px solid var(--color-border);
  background: var(--color-background);
}

.decision-row,
.decision-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-xs);
}

.decision-row {
  padding: var(--spacing-sm) var(--workspace-gutter);
  gap: var(--spacing-sm) var(--workspace-gutter);
}

.decision-row p {
  flex: 1 1 34ch;
  margin: 0;
  color: var(--color-text-secondary);
}

.decision-actions {
  margin-inline-start: auto;
  justify-content: flex-end;
}

.decision-actions .btn {
  white-space: normal;
}

.decision-actions .primary {
  border-color: var(--color-accent);
}

.decision-actions .danger {
  color: var(--color-danger);
  border-color: var(--color-danger);
}
</style>
