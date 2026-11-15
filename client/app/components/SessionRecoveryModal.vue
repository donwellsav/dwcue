<template>
  <div class="srm-dialog" role="region" aria-labelledby="session-recovery-title" @keydown.stop>
    <div class="srm-header">
      <span class="material-symbols-rounded srm-icon" aria-hidden="true">restart_alt</span>
      <h2 id="session-recovery-title">
        {{ t(projectChanged
          ? 'sessionRecovery.projectChangedTitle'
          : 'sessionRecovery.title') }}
      </h2>
    </div>
    <p class="srm-body">
      {{ projectChanged
        ? t('sessionRecovery.projectChangedMessage', { name: serverProjectName })
        : t('sessionRecovery.message') }}
    </p>
    <p class="srm-project">{{ currentProject?.name }}</p>
    <Btn
      v-if="showStopAll"
      class="srm-stop-all"
      type="button"
      icon="stop_circle"
      :text="t('controls.stopAll')"
      @click="server.stopAll()"
    />
    <p v-if="server.stopAllStatus" class="srm-body" role="status">
      {{ t(`connectionLost.stopAllStatus.${server.stopAllStatus}`) }}
    </p>

    <div class="srm-actions">
      <button
        class="srm-btn primary"
        :disabled="recovering"
        @click="onRecover(projectChanged ? joinServerSession : resumeSession)"
      >
        <span class="material-symbols-rounded" :class="{ spin: recovering }" aria-hidden="true">
          {{ recovering ? 'progress_activity' : (projectChanged ? 'login' : 'restore') }}
        </span>
        <span>
          {{ t(projectChanged
            ? 'sessionRecovery.useServerProject'
            : 'sessionRecovery.resume') }}
        </span>
      </button>
      <button
        class="srm-btn"
        :disabled="recovering"
        @click="projectChanged ? onRecover(resumeSession) : onFresh()"
      >
        <span class="material-symbols-rounded" aria-hidden="true">
          {{ projectChanged ? 'restore' : 'home' }}
        </span>
        <span>
          {{ t(projectChanged
            ? 'sessionRecovery.keepLocalProject'
            : 'sessionRecovery.startFresh') }}
        </span>
      </button>
    </div>
    <p v-if="actionFailed" class="srm-error" role="alert">{{ t('sessionRecovery.actionFailed') }}</p>
    <p class="srm-hint">
      {{ projectChanged
        ? t('sessionRecovery.projectChangedHint')
        : `${t('sessionRecovery.resumeHint')} ${t('sessionRecovery.startFreshHint')}` }}
    </p>
  </div>
</template>

<script setup lang="ts">
// Shown when the client reconnects to a server that has forgotten the
// project — almost always because the server process restarted mid-session.
// The client still holds the whole document, so recovery is a choice, not a
// failure: push it back and carry on, or drop it and start over.
const { showStopAll } = defineProps<{ showStopAll: boolean }>();
const { t } = useLocalization();
const { currentProject } = useProject();
const server = useLiveplayServer();
const {
  projectChanged,
  serverProjectName,
  recovering,
  resumeSession,
  startFresh,
  joinServerSession,
} = useConnectionGuard();

const actionFailed = ref(false);

async function onRecover(recover: () => Promise<boolean>) {
  actionFailed.value = false;
  try {
    actionFailed.value = !await recover();
  } catch (error) {
    console.warn('[SessionRecoveryModal] recovery failed:', error);
    actionFailed.value = true;
  }
}

async function onFresh() {
  actionFailed.value = false;
  await startFresh();
}
</script>

<style scoped>
.srm-dialog {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm) var(--workspace-gutter);
  border-top: 1px solid var(--color-border);
  background: var(--color-background);
  color: var(--color-text-primary);
}
.srm-dialog p { margin: 0; }
.srm-header {
  display: flex;
  align-items: center;
  gap: 10px;
}
.srm-header h2 { margin: 0; font-size: 18px; }
.srm-icon { color: var(--color-accent, #0f62fe); font-size: 28px; }
.srm-body {
  color: var(--color-text-secondary);
  font-size: 14px;
  line-height: 1.5;
}
.srm-project {
  font-size: 13px;
  font-weight: 600;
  background: var(--color-background);
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  word-break: break-all;
}
.srm-stop-all { align-self: flex-start; }
.srm-error { color: var(--color-danger); font-size: 13px; }
.srm-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.srm-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  justify-content: center;
  min-height: var(--panel-control-height);
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background: var(--color-surface-raised);
  color: var(--color-text-primary);
  font-size: 13px;
  cursor: pointer;
}
.srm-btn:hover:not(:disabled) {
  background: var(--color-surface-hover);
  border-color: var(--color-accent);
}
.srm-btn.primary {
  background: var(--color-accent, #0f62fe);
  color: var(--color-text-on-accent);
  border-color: transparent;
}
.srm-btn.primary:hover:not(:disabled) { filter: brightness(1.1); }
.srm-btn:disabled { opacity: 0.5; cursor: default; }
.srm-btn .material-symbols-rounded { font-size: 16px; }
.srm-hint {
  font-size: 11px;
  color: var(--color-text-secondary);
  line-height: 1.4;
}

.spin { animation: srm-spin 1s linear infinite; }
@keyframes srm-spin { to { transform: rotate(360deg); } }

</style>
