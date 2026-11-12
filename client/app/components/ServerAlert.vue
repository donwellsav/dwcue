<template>
  <Teleport defer :to="target">
    <div v-if="warning || audioDevice || videoStatus?.recoveryRequired" class="header-warning-group">
      <span
        v-if="warning"
        class="header-warning-text"
        :class="{ 'header-warning-text--urgent': warning.severity === 'urgent' }"
        :role="warning.severity === 'urgent' ? 'alert' : 'status'"
        :title="warning.message"
      >{{ warning.message }}</span>
      <button
        v-if="audioDevice"
        type="button"
        class="header-warning-action"
        :aria-label="t('headerWarnings.retryAudio')"
        :title="`${t('headerWarnings.retryAudio')} · ${audioHealthMessage}`"
        :disabled="recoveryRequesting || !!pendingRecovery"
        @click="retryAudioOutput"
      >
        <span class="material-symbols-rounded" aria-hidden="true">{{ pendingRecovery ? 'hourglass_empty' : 'volume_off' }}</span>
      </button>
      <button
        v-if="videoStatus?.recoveryRequired"
        type="button"
        class="header-warning-action"
        :aria-label="t('settings.videoOutputRestart')"
        :title="`${t('settings.videoOutputRestart')} · ${videoErrorMessage}`"
        :disabled="videoStatus.restarting"
        @click="restartVideoOutput"
      ><span class="material-symbols-rounded" aria-hidden="true">videocam_off</span></button>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { recoveryResultForRequest } from '~/types/server';

defineProps<{ target: string }>();
const server = useLiveplayServer();
const { t } = useLocalization();
const { warning, showHeaderWarning } = useHeaderWarnings();
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
const videoErrorMessage = computed(() => videoStatus.value?.testCardError
  || videoStatus.value?.playbackError?.message || '');

watch(() => server.connected ? server.lastErrorEvent : null, (event) => {
  if (event) showHeaderWarning(event.message, event.severity);
}, { immediate: true });
watch(audioHealthMessage, (message) => {
  if (message) showHeaderWarning(message, pendingRecovery.value ? 'advisory' : 'urgent');
}, { immediate: true });
watch(videoErrorMessage, (message) => {
  if (message) showHeaderWarning(`${t('settings.tabVideoOutput')} · ${message}`, 'urgent');
});

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

async function restartVideoOutput() {
  try {
    const status = await window.electronAPI?.videoOutput?.restart();
    if (status) videoStatus.value = status;
  } catch { /* Main retains the black surface and its actionable error. */ }
}

onMounted(() => {
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
.header-warning-group {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  min-width: 0;
}

.header-warning-text {
  min-width: 0;
  max-width: 40ch;
  height: 18px;
  padding-inline: var(--spacing-xs);
  border: 1px solid currentColor;
  border-radius: var(--control-radius);
  color: var(--state-up-next);
  background: var(--color-surface-raised);
  font-size: 12px;
  line-height: 16px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-warning-text--urgent {
  color: var(--color-danger);
}

.header-warning-action {
  flex: none;
  display: grid;
  place-items: center;
  width: 24px;
  height: 18px;
  border: 1px solid currentColor;
  border-radius: var(--control-radius);
  background: var(--color-surface-raised);
  color: var(--color-danger);
}

.header-warning-action .material-symbols-rounded {
  font-size: 14px;
}

.header-warning-action:hover:not(:disabled) {
  background: var(--color-surface-hover);
}

.header-warning-action:disabled {
  color: var(--color-text-secondary);
}
</style>
