<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @click.self="close">
      <div class="modal">
        <header>
          <h2>{{ t('serverSettings.title') }}</h2>
          <button class="x" @click="close">✕</button>
        </header>

        <p class="status" :class="{ ok: server.connected, bad: !server.connected }">
          <span v-if="server.connected">{{ t('serverSettings.connected') }}</span>
          <span v-else-if="server.reconnecting">{{ t('serverSettings.reconnecting') }}</span>
          <span v-else>{{ t('serverSettings.disconnected') }}</span>
          <span v-if="server.lastError" class="err">  ({{ server.lastError }})</span>
        </p>

        <!-- Mode selector: Local (Electron spawns the C++ server) vs Remote -->
        <div class="mode-group">
          <label class="mode-option">
            <input type="radio" value="local" v-model="draftMode" />
            <div>
              <strong>{{ t('welcome.localMode') }}</strong>
              <small>{{ t('serverSettings.localModeDesc') }}</small>
            </div>
          </label>
          <label class="mode-option">
            <input type="radio" value="remote" v-model="draftMode" />
            <div>
              <strong>{{ t('welcome.remoteMode') }}</strong>
              <small>{{ t('serverSettings.remoteModeDesc') }}</small>
            </div>
          </label>
        </div>

        <label v-if="draftMode === 'local'">
          {{ t('serverSettings.localPort') }}
          <input v-model.number="draftLocalPort" type="number" min="1" max="65535" placeholder="4480" />
        </label>
        <label v-else>
          {{ t('serverSettings.remoteUrl') }}
          <input v-model="draftRemoteUrl" placeholder="http://192.168.1.42:4480" />
        </label>
        <label v-if="draftMode === 'remote'">
          Access token
          <input
            v-model="draftAccessToken"
            type="password"
            autocomplete="off"
            placeholder="Required by LAN servers"
          />
        </label>

        <p v-if="serverStatus" class="server-pid">
          <template v-if="draftMode === 'local'">
            <span v-if="serverStatus.running">{{ t('serverSettings.engineRunning', { pid: serverStatus.pid }) }}</span>
            <span v-else class="warn">{{ t('serverSettings.engineNotRunning') }}</span>
          </template>
          <template v-else>
            <span class="hint">{{ t('serverSettings.externalHint') }}</span>
          </template>
        </p>

        <div class="row">
          <button class="btn primary" @click="apply">{{ t('serverSettings.apply') }}</button>
          <button class="btn" @click="server.connect">{{ t('serverSettings.retryConnect') }}</button>
          <button v-if="draftMode === 'local' && hasElectron" class="btn" @click="restartLocal">{{ t('serverSettings.restartEngine') }}</button>
        </div>

        <section v-if="server.connected">
          <h3>{{ t('serverSettings.outputDevices') }}</h3>
          <ul class="devices">
            <li v-for="d in server.devices" :key="d.id">
              <span :class="{ default: d.is_default }">{{ d.display_name }}</span>
              <small>{{ d.channel_count }} ch @ {{ d.sample_rate }} Hz</small>
              <button
                v-if="d.is_open"
                class="btn small"
                @click="server.closeDevice(d.id)"
              >{{ t('settings.close') }}</button>
              <button
                v-else
                class="btn small"
                :disabled="!d.is_available"
                @click="server.openDevice(d.display_name, d.channel_count)"
              >{{ t('serverSettings.open') }}</button>
            </li>
            <li v-if="server.devices.length === 0" class="empty">{{ t('serverSettings.noDevices') }}</li>
          </ul>
        </section>
      </div>
    </div>
  </Teleport>
</template>

<!--
  ServerSettingsModal.vue
  -----------------------------------------------------------------------
  Configures the C++ server URL the client talks to, shows connection
  health, lets the operator open hardware devices on the server side.
-->
<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { useLiveplayServer } from '~/composables/useLiveplayServer';

const { t } = useLocalization();

const props = defineProps<{ open: boolean }>();
const emit  = defineEmits<{ (e: 'close'): void }>();

const server = useLiveplayServer();

// Local/Remote configuration is owned by the Electron main process (it
// also spawns the child server when mode === 'local'). In a pure-web
// context (`electronAPI` undefined), Local mode is hidden because the
// browser can't spawn binaries — we fall through to Remote-only.
const electronApi: any = (globalThis as any).electronAPI?.liveplayServer;
const hasElectron = !!electronApi;

const draftMode      = ref<'local' | 'remote'>('local');
const draftRemoteUrl = ref('http://127.0.0.1:4480');
const draftLocalPort = ref(4480);
const draftAccessToken = ref('');
const serverStatus   = ref<{ running: boolean; pid?: number } | null>(null);

let stopStatusListener: (() => void) | null = null;

async function loadConfig() {
  if (!electronApi) {
    // Web fallback: only remote mode is meaningful.
    draftMode.value = 'remote';
    draftRemoteUrl.value = server.serverUrl;
    return;
  }
  const cfg    = await electronApi.getConfig();
  const status = await electronApi.getStatus();
  draftMode.value      = cfg.mode;
  draftRemoteUrl.value = cfg.remoteUrl || 'http://127.0.0.1:4480';
  draftLocalPort.value = cfg.localPort || 4480;
  draftAccessToken.value = String(server.accessToken || '');
  serverStatus.value   = { running: status.running, pid: status.pid };
}

onMounted(() => {
  loadConfig();
  if (electronApi) {
    stopStatusListener = electronApi.onStateChange((p: any) => {
      serverStatus.value = { running: p.running, pid: p.pid };
    });
  }
});

onBeforeUnmount(() => { if (stopStatusListener) stopStatusListener(); });

watch(() => props.open, o => {
  if (o) {
    loadConfig();
    server.fetchDevices();
  }
});

async function apply() {
  server.setAccessToken(draftMode.value === 'remote' ? draftAccessToken.value : '');
  if (electronApi) {
    // Main process persists the choice and starts/stops the child as needed.
    // The plugin's onStateChange listener will retarget the WebSocket.
    await electronApi.setConfig({
      mode:      draftMode.value,
      remoteUrl: draftRemoteUrl.value.trim(),
      localPort: draftLocalPort.value,
    });
  } else {
    // Web fallback: just point the client at the typed URL.
    server.setServerUrl(draftRemoteUrl.value.trim());
  }
}

async function restartLocal() {
  if (electronApi) await electronApi.restart();
}

function close() { emit('close'); }
</script>

<style lang="scss" scoped>
.modal-backdrop {
  position: fixed; inset: 0;
  background: var(--dialog-backdrop);
  display: flex; align-items: center; justify-content: center;
  // Above ConnectionLostModal (9500) and SessionRecoveryModal (9600):
  // pointing the client at a different server is one of the ways out of a
  // lost connection, so this dialog has to stay usable underneath them.
  z-index: 9700;
}
.modal {
  width: min(520px, 90vw);
  background: var(--dialog-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--dialog-radius);
  padding: var(--dialog-padding);
  color: var(--color-text-primary);
  box-shadow: var(--dialog-shadow);
  display: flex; flex-direction: column; gap: 12px;

  header { display: flex; justify-content: space-between; align-items: center; min-height: 32px; }
  h2 { margin: 0; font-size: 18px; }
  .x {
    display: grid; place-items: center;
    width: 32px; height: 32px; padding: 0;
    background: transparent; border: none; border-radius: var(--control-radius);
    color: var(--color-text-secondary); cursor: pointer; font-size: 18px;
    &:hover { background: var(--color-surface-hover); color: var(--color-text-primary); }
  }
  .status { font-family: var(--font-mono); font-size: 12px;
    &.ok  { color: var(--color-success); }
    &.bad { color: var(--color-danger); }
    .err { color: var(--color-danger); }
  }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--color-text-secondary); }
  input {
    background: var(--color-control); border: 1px solid var(--color-border);
    color: var(--color-text-primary); padding: 6px 10px; border-radius: var(--control-radius);
    font-family: var(--font-mono);
  }
  .mode-group {
    display: grid; gap: 6px;
    border: 1px solid var(--color-border); border-radius: var(--control-radius);
    padding: 6px; background: var(--color-background);
  }
  .mode-option {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 8px; border-radius: var(--control-radius); cursor: pointer;
    color: var(--color-text-primary); font-size: 13px;
    &:hover { background: var(--color-surface-hover); }
    input[type="radio"] { margin-top: 4px; }
    div { display: flex; flex-direction: column; gap: 2px; }
    strong { font-size: 13px; }
    small { font-size: 11px; color: var(--color-text-tertiary); }
  }
  .server-pid {
    font-size: 11px; color: var(--color-text-secondary); margin: 0;
    .warn { color: var(--color-warning); }
    .hint { color: var(--color-accent); }
  }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .btn {
    min-height: var(--panel-control-height);
    background: var(--color-surface-raised); border: 1px solid var(--color-border);
    border-radius: var(--control-radius); padding: 6px 12px; color: var(--color-text-primary); cursor: pointer;
    &:hover:not(:disabled) { background: var(--color-surface-hover); border-color: var(--color-border-strong); }
    &.primary { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-text-on-accent); }
    &.small   { min-height: 28px; padding: 2px 8px; font-size: 12px; }
  }
  h3 { margin: 8px 0 4px; font-size: 13px; color: var(--color-text-primary); }
  .devices {
    list-style: none; padding: 0; margin: 0; max-height: 200px; overflow: auto;
    border: 1px solid var(--color-border); border-radius: var(--control-radius); background: var(--color-background);
    li {
      display: grid; grid-template-columns: 1fr auto auto;
      gap: 8px; align-items: center; padding: 6px 10px;
      border-bottom: 1px solid var(--color-border);
      &:last-child { border-bottom: none; }
      small { color: var(--color-text-tertiary); font-size: 11px; }
      .default { color: var(--color-warning); }
    }
    .empty { color: var(--color-text-tertiary); padding: 12px; text-align: center; font-style: italic; }
  }
}
</style>
