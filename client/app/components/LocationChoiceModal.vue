<template>
  <Teleport to="body">
    <div v-if="visible" class="lc-backdrop" :data-theme="theme" @click.self="cancel">
      <div class="lc-modal" role="dialog" aria-modal="true">
        <header class="lc-header">
          <h3>{{ title }}</h3>
        </header>
        <p class="lc-message">{{ message }}</p>
        <div class="lc-actions">
          <button class="lc-btn primary" @click="pick('server')">
            <span class="material-symbols-rounded">cloud</span>
            <span>{{ serverLabel }}</span>
          </button>
          <button class="lc-btn primary" @click="pick('client')">
            <span class="material-symbols-rounded">computer</span>
            <span>{{ clientLabel }}</span>
          </button>
        </div>
        <div class="lc-footer">
          <button class="lc-btn ghost" @click="cancel">{{ cancelLabel }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<!--
  LocationChoiceModal.vue
  ---------------------------------------------------------------------
  Two-button modal asking the user whether an action targets the SERVER's
  filesystem or this CLIENT computer's filesystem. Used by the dual-dialog
  Import/Export flows when the client and server live on different
  machines (sharing a host means the choice is meaningless, so callers
  skip the modal in that case).

  Theme note: the project's theme CSS variables (--color-surface etc.) are
  defined under `[data-theme='dark']` / `[data-theme='light']` rules that
  live on `#app`. Because <Teleport to="body"> hoists this modal OUT of
  #app, those vars would resolve to nothing and the modal would render
  transparent. We mirror the app's current theme value onto the teleported
  root so the same selectors match here too.
-->
<script setup lang="ts">
defineProps<{
  visible: boolean;
  title: string;
  message: string;
  serverLabel: string;
  clientLabel: string;
  cancelLabel: string;
}>();

const emit = defineEmits<{
  pick: ['server' | 'client'];
  cancel: [];
}>();

// Mirror the app-wide theme so [data-theme='…'] CSS variables resolve
// inside the teleported subtree.
const theme = useState<string>('theme', () => 'dark');

function pick(choice: 'server' | 'client') { emit('pick', choice); }
function cancel() { emit('cancel'); }
</script>

<!--
  Styles are intentionally NOT scoped. The modal's root is teleported to
  <body>, and a previous scoped variant was producing an unstyled box
  (the `data-v-xxx` attribute apparently wasn't landing on the teleported
  root in the packaged Electron build). The `.lc-*` class prefix keeps
  these selectors namespaced enough not to leak.
-->
<style lang="scss">
.lc-backdrop {
  position: fixed; inset: 0;
  background: var(--dialog-backdrop);
  display: flex; align-items: center; justify-content: center;
  z-index: 10000;
}
.lc-modal {
  box-sizing: border-box;
  background: var(--dialog-surface);
  border: 1px solid var(--color-border);
  color: var(--color-text-primary);
  border-radius: var(--dialog-radius);
  width: min(var(--modal-width, 560px), 92vw);
  padding: var(--dialog-padding);
  box-shadow: var(--dialog-shadow);
  display: flex; flex-direction: column; gap: 16px;
}
.lc-header h3 {
  margin: 0;
  color: var(--color-text-primary, #f4f4f4);
  font-size: 18px;
  font-weight: 600;
}
.lc-message {
  margin: 0;
  color: var(--color-text-secondary, #c6c6c6);
  font-size: 14px;
  line-height: 1.5;
}
.lc-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.lc-btn {
  min-height: 40px;
  padding: 8px 12px;
  border-radius: var(--control-radius);
  border: 1px solid var(--color-border);
  background: var(--color-surface-raised);
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 8px;
  &:hover {
    background: var(--color-surface-hover);
    border-color: var(--color-border-strong);
  }

  &.primary {
    border-color: var(--color-accent, #315fcf);
    &:hover { background: var(--color-accent); color: var(--color-text-on-accent); }
  }
  &.ghost {
    background: transparent;
    border-color: transparent;
    color: var(--color-text-secondary);
    &:hover { color: var(--color-text-primary); }
  }
}
.lc-footer {
  display: flex; justify-content: flex-end;
}
</style>
