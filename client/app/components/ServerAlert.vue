<template>
  <div v-if="visible" class="server-alert" role="alert">
    <span class="material-symbols-rounded">error</span>
    <span>{{ server.lastError }}</span>
    <button type="button" aria-label="Dismiss" @click="server.clearLastError()">×</button>
  </div>
</template>

<script setup lang="ts">
const server = useLiveplayServer();
const visible = computed(() => server.connected && !!server.lastError);
</script>

<style scoped>
.server-alert {
  position: fixed;
  z-index: 9800;
  left: 50%;
  bottom: 20px;
  transform: translateX(-50%);
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  width: min(680px, calc(100vw - 32px));
  padding: 10px 12px;
  color: var(--color-text-primary);
  background: var(--color-surface);
  border: 1px solid var(--color-danger, #da1e28);
  border-radius: var(--border-radius-md);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
  font-size: 13px;
}

.server-alert > .material-symbols-rounded {
  color: var(--color-danger, #da1e28);
}

.server-alert button {
  width: 28px;
  height: 28px;
  color: var(--color-text-secondary);
  background: transparent;
  border: 0;
  border-radius: var(--border-radius-sm);
  cursor: pointer;
  font-size: 20px;
}

.server-alert button:hover {
  color: var(--color-text-primary);
  background: var(--color-surface-hover);
}
</style>
