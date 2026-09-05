<template>
  <div v-if="!isVideoOutputWindow" class="server-alert-stack">
    <div v-if="audioDevice" class="server-alert server-alert--warning" role="alert">
      <span class="material-symbols-rounded" aria-hidden="true">timer_off</span>
      <span>{{ audioHealthMessage }}</span>
      <button
        v-if="!pendingRecovery"
        type="button"
        class="server-alert__action"
        :disabled="recoveryRequesting"
        @click="retryAudioOutput"
      >
        {{ recoveryRequesting ? t('common.loading') : t('connectionLost.reconnect') }}
      </button>
      <span v-else class="server-alert__waiting" aria-hidden="true">•••</span>
    </div>

    <div v-if="videoPlaybackError" class="server-alert" role="alert">
      <span class="material-symbols-rounded" aria-hidden="true">videocam_off</span>
      <span>
        <strong>{{ t('settings.tabVideoOutput') }} · {{ t('common.error') }}</strong>
        — {{ videoPlaybackError.message }}
      </span>
    </div>

    <div v-if="server.connected && server.lastError" class="server-alert" role="alert">
      <span class="material-symbols-rounded" aria-hidden="true">error</span>
      <span>{{ server.lastError }}</span>
      <button
        type="button"
        class="server-alert__dismiss"
        :aria-label="t('actions.close')"
        @click="server.clearLastError()"
      >×</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { recoveryResultForRequest } from '~/types/server';

const server = useLiveplayServer();
const { t } = useLocalization();
const isVideoOutputWindow = computed(() => import.meta.client &&
  new URLSearchParams(window.location.search).get('videoOutput') === '1');
const videoStatus = ref<VideoOutputStatus | null>(null);
type RecoveryTarget = { id: string; name: string };
const pendingRecovery = ref<(RecoveryTarget & { requestId: number }) | null>(null);
const failedRecovery = ref<RecoveryTarget | null>(null);
const recoveryRequesting = ref(false);
let stopVideoStatus: (() => void) | null = null;

const stalledDevice = computed(() =>
  server.devices.find(device => device.is_open && device.runtime_state === 'stalled') ?? null);
const audioDevice = computed(() => {
  const target = pendingRecovery.value ?? failedRecovery.value;
  if (!target) return stalledDevice.value;
  return server.devices.find(device => device.id === target.id) ?? {
    id: target.id,
    display_name: target.name,
    runtime_state: 'stalled' as const,
  };
});
const audioHealthMessage = computed(() => {
  const device = audioDevice.value;
  if (!device) return '';
  if (failedRecovery.value) return t('audioHealth.recoveryFailed', { name: device.display_name });
  if (pendingRecovery.value) {
    return device.runtime_state === 'starting'
      ? t('audioHealth.starting', { name: device.display_name })
      : t('audioHealth.queued', { name: device.display_name });
  }
  return t('audioHealth.stalled', { name: device.display_name });
});
const videoPlaybackError = computed(() => videoStatus.value?.playbackError ?? null);

watch(
  () => {
    const pending = pendingRecovery.value;
    return pending
      ? server.devices.find(device => device.id === pending.id) ?? null
      : null;
  },
  (device) => {
    const pending = pendingRecovery.value;
    if (!pending || !device) return;
    const result = recoveryResultForRequest(device, pending.requestId);
    if (!result) return;
    pendingRecovery.value = null;
    failedRecovery.value = result === 'failed'
      ? { id: pending.id, name: pending.name }
      : null;
  },
);

async function retryAudioOutput() {
  const device = audioDevice.value;
  if (!device || recoveryRequesting.value) return;
  const target = { id: device.id, name: device.display_name };
  recoveryRequesting.value = true;
  failedRecovery.value = null;
  try {
    const response = await server.recoverDevice(device.id);
    if (response.accepted !== true ||
        !Number.isSafeInteger(response.request_id) || response.request_id <= 0) {
      throw new Error('Recovery was not accepted');
    }
    pendingRecovery.value = { ...target, requestId: response.request_id };
  } catch {
    pendingRecovery.value = null;
    failedRecovery.value = target;
  } finally {
    recoveryRequesting.value = false;
  }
}

onMounted(() => {
  if (isVideoOutputWindow.value) return;
  const api = window.electronAPI?.videoOutput;
  if (!api) return;
  void api.status().then((status) => { videoStatus.value = status; }).catch(() => {});
  stopVideoStatus = api.onStatus((status) => { videoStatus.value = status; });
});

onBeforeUnmount(() => {
  stopVideoStatus?.();
  stopVideoStatus = null;
});
</script>

<style scoped>
.server-alert-stack {
  position: fixed;
  z-index: 9800;
  left: 50%;
  bottom: 20px;
  transform: translateX(-50%);
  display: grid;
  gap: 8px;
  width: min(680px, calc(100vw - 32px));
}

.server-alert {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  color: var(--color-text-primary);
  background: var(--color-surface);
  border: 1px solid var(--color-danger, #da1e28);
  border-radius: var(--border-radius-md);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
  font-size: 13px;
}

.server-alert--warning {
  border-color: var(--color-warning, #f1c21b);
}

.server-alert > .material-symbols-rounded {
  color: var(--color-danger, #da1e28);
}

.server-alert--warning > .material-symbols-rounded {
  color: var(--color-warning, #f1c21b);
}

.server-alert button {
  min-height: 28px;
  color: var(--color-text-secondary);
  background: transparent;
  border: 0;
  border-radius: var(--border-radius-sm);
  cursor: pointer;
}

.server-alert button:hover:not(:disabled) {
  color: var(--color-text-primary);
  background: var(--color-surface-hover);
}

.server-alert__action {
  padding: 4px 8px;
  border: 1px solid var(--color-border) !important;
  font: inherit;
  font-weight: 600;
}

.server-alert__dismiss {
  width: 28px;
  padding: 0;
  font-size: 20px;
}

.server-alert__waiting {
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  letter-spacing: 0.08em;
}
</style>
