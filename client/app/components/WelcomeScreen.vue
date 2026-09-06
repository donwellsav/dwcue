<template>
  <div class="welcome-screen">
    <div class="welcome-container">
      <div class="welcome-header">
        <img
          :src="isDark ? './assets/icons/SVG/app_icon_darkmode@web.svg' : './assets/icons/SVG/app_icon_lightmode@web.svg'"
          alt="DonWells Cue"
          class="welcome-logo"
        />
        <div class="welcome-text">
          <h1 class="welcome-title">
            {{ t('welcome.title') }}
            <span class="version-badge">v{{ appVersion }}</span>
          </h1>
          <p class="welcome-subtitle">{{ t('welcome.subtitle') }}</p>
          <p class="welcome-byline">by <strong>Don Wells</strong></p>
        </div>
      </div>

      <!-- Stage 1: mode picker. Hidden once we've connected. -->
      <div v-if="stage === 'mode'" class="welcome-stage">
        <h2 class="stage-title">{{ t('welcome.modeTitle') }}</h2>
        <p class="stage-subtitle">{{ t('welcome.modeSubtitle') }}</p>
                <div class="welcome-actions" :class="{ 'welcome-actions--single': !showNetworkUi }">

          <button
            
ref="localModeButton"
            class="welcome-button primary"
            type="button"
            :disabled="connecting"
            @click="chooseLocal"
          >
            <span class="button-icon">
              <span v-if="connecting && mode === 'local'" class="material-symbols-rounded spin" aria-hidden="true">progress_activity</span>
              <span v-else class="material-symbols-rounded" aria-hidden="true">computer</span>
            </span>
            <span class="button-label">
              <span class="button-label-line">
                {{ connecting && mode === 'local' ? t('welcome.startingLocalServer') : t('welcome.localMode') }}
              </span>
              <span class="button-label-sub">{{ t('welcome.localModeDescription') }}</span>
            </span>
          </button>

          <button v-if="showNetworkUi" class="welcome-button" type="button" :disabled="connecting" @click="chooseRemote">
            <span class="button-icon"><span class="material-symbols-rounded" aria-hidden="true">lan</span></span>
            <span class="button-label">
              <span class="button-label-line">{{ t('welcome.remoteMode') }}</span>
              <span class="button-label-sub">{{ t('welcome.remoteModeDescription') }}</span>
            </span>
          </button>
        </div>
        <!-- v1 is same-machine only; the remote path is hidden by default
             but stays one click away for the future networked renderer. -->
        <button
          v-if="!showNetworkUi"
          class="link-button network-reveal"
          type="button"
          @click="revealNetworkUi"
        >{{ t('welcome.showNetworkUi') }}</button>
        <p
          v-if="connectionError"
          class="remote-error"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >{{ connectionError }}</p>
      </div>

      <!-- Stage 2: remote address entry. -->
      <div v-else-if="stage === 'remote'" class="welcome-stage">
        <h2 class="stage-title">{{ t('welcome.remoteConnect') }}</h2>
        <p class="stage-subtitle">{{ t('welcome.remoteAddressHint') }}</p>

        <!-- Auto-discovered servers on this LAN. Populated by the UDP beacon
             and active solicitation. Header always shown so the user can
             rescan even when nothing has been found yet. -->
          <div class="discovered-servers" :aria-busy="scanning ? 'true' : 'false'">
            <div class="discovered-header">
              <span class="material-symbols-rounded" :class="{ spin: scanning }" aria-hidden="true">radar</span>
              <span>{{ t('welcome.serversOnThisNetwork') }}</span>
              <button
                class="discovered-rescan"
                :disabled="scanning"
                :title="t('welcome.rescan')"
                :aria-label="t('welcome.rescan')"
                @click="rescan"
              >
                <span class="material-symbols-rounded" aria-hidden="true">refresh</span>
              </button>
            </div>
          <button
            v-for="srv in discoveredServers"
            :key="srv.instanceId"
            class="discovered-row"
            @click="connectToDiscovered(srv)"
            :disabled="connecting"
          >
            <span class="material-symbols-rounded discovered-icon" aria-hidden="true">dns</span>
            <span class="discovered-main">
              <span class="discovered-name">{{ srv.name }}</span>
              <span class="discovered-meta">
                {{ srv.host }}:{{ srv.port }}
                <span v-if="srv.hasOpenProject" class="discovered-project">
                  · {{ srv.projectName || 'project open' }} ({{ srv.itemCount }})
                </span>
              </span>
            </span>
            <span class="material-symbols-rounded discovered-arrow" aria-hidden="true">arrow_forward</span>
          </button>
          <p
            v-if="discoveredServers.length === 0"
            class="discovered-empty"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {{ scanning ? t('welcome.scanning') : t('welcome.noServersFound') }}
          </p>
        </div>

        <!-- Recently-connected servers. The robust fallback when discovery
             can't reach a server (different subnet, VPN, locked-down WiFi). -->
        <div v-if="recentServers.length > 0" class="discovered-servers">
          <div class="discovered-header">
            <span class="material-symbols-rounded" aria-hidden="true">history</span>
            <span>{{ t('welcome.recentServers') }}</span>
          </div>
          <div
            v-for="srv in recentServers"
            :key="srv.url"
            class="discovered-row-group"
          >
            <button
              class="discovered-row"
              :disabled="connecting"
              @click="connectToRecent(srv)"
            >
              <span class="material-symbols-rounded discovered-icon" aria-hidden="true">lan</span>
              <span class="discovered-main">
                <span class="discovered-name">{{ srv.name || srv.host || srv.url }}</span>
                <span class="discovered-meta">{{ srv.host }}:{{ srv.port }}</span>
              </span>
            </button>
            <button
              class="discovered-forget"
              type="button"
              :disabled="connecting"
              :title="t('welcome.forget')"
              :aria-label="`${t('welcome.forget')} ${srv.name || srv.host || srv.url}`"
              @click="forgetRecent(srv)"
            >
              <span class="material-symbols-rounded discovered-remove" aria-hidden="true">close</span>
            </button>
          </div>
        </div>

        <div class="remote-form">
          <label class="remote-field-label" for="welcome-remote-address">{{ t('welcome.serverAddress') }}</label>
          <input
            id="welcome-remote-address"
            ref="remoteAddressInput"
            v-model="remoteAddress"
            type="text"
            class="remote-field-input"
            :placeholder="t('welcome.serverAddressPlaceholder')"
            @keydown.enter="connectToRemote"
          />
          <label class="remote-field-label" for="welcome-remote-access-token">Access token</label>
          <input
            id="welcome-remote-access-token"
            v-model="remoteAccessToken"
            type="password"
            class="remote-field-input"
            autocomplete="off"
            placeholder="Required by LAN servers"
            @keydown.enter="connectToRemote"
          />
          <p
            v-if="connectionError"
            class="remote-error"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >{{ connectionError }}</p>
        </div>
        <div class="remote-actions">
          <button class="welcome-button" type="button" @click="stage = 'mode'">
            <span class="material-symbols-rounded" aria-hidden="true">arrow_back</span>
            <span>{{ t('welcome.back') }}</span>
          </button>
          <button
            class="welcome-button primary"
            type="button"
            :disabled="!remoteAddress || connecting"
            @click="connectToRemote"
          >
            <span class="material-symbols-rounded" aria-hidden="true">link</span>
            <span>{{ connecting ? t('welcome.connecting') : t('welcome.connect') }}</span>
          </button>
        </div>
      </div>

      <!-- Stage 3: project picker. -->
      <div v-else-if="stage === 'project'" class="welcome-stage">
        <p class="stage-subtitle connection-summary">
          <span class="material-symbols-rounded connection-icon" aria-hidden="true">{{ mode === 'remote' ? 'lan' : 'computer' }}</span>
          {{ mode === 'remote'
              ? t('welcome.connectedTo', { url: serverUrlDisplay })
              : t('welcome.connectedLocal') }}
          <button
            ref="changeModeButton"
            class="link-button"
            type="button"
            @click="changeMode"
          >{{ t('welcome.changeMode') }}</button>
        </p>
        <div class="welcome-actions">
          <button ref="newProjectButton" class="welcome-button primary" type="button" @click="handleNewProject">
            <span class="button-icon"><span class="material-symbols-rounded" aria-hidden="true">add</span></span>
            <span>{{ t('welcome.newShow') }}</span>
          </button>

          <button class="welcome-button" type="button" @click="handleOpenProject">
            <span class="button-icon"><span class="material-symbols-rounded" aria-hidden="true">folder</span></span>
            <span>{{ t('welcome.openProject') }}</span>
          </button>
        </div>

        <div v-if="recentProjects.length > 0" class="discovered-servers recent-projects">
          <div class="discovered-header">
            <span class="material-symbols-rounded" aria-hidden="true">history</span>
            <span>{{ t('menu.openRecent') }}</span>
          </div>
          <div
            v-for="project in recentProjects"
            :key="project.path"
            class="discovered-row-group"
          >
            <button
              class="discovered-row recent-project-row"
              type="button"
              @click="openRecentProject(project)"
            >
              <span class="material-symbols-rounded discovered-icon" aria-hidden="true">description</span>
              <span class="discovered-main">
                <span class="discovered-name">{{ project.name || projectBasename(project.path) }}</span>
                <span class="discovered-meta">{{ project.folderPath || projectFolder(project.path) }}</span>
              </span>
            </button>
            <button
              class="discovered-forget"
              type="button"
              :title="t('welcome.forget')"
              :aria-label="`${t('welcome.forget')} ${project.name || projectBasename(project.path)}`"
              @click="removeRecentProject(project)"
            >
              <span class="material-symbols-rounded discovered-remove" aria-hidden="true">close</span>
            </button>
          </div>
        </div>
        <p v-else class="discovered-empty recent-projects-empty">{{ t('menu.noRecentProjects') }}</p>
      </div>
      <button
        v-if="canOpenOperatorManual"
        type="button"
        class="link-button"
        @click="openOperatorManual"
      >{{ t('menu.operatorManual') }}</button>
    </div>

    <!-- The New Show form owns both values. Browsing for a location temporarily
         swaps to the server-side picker so remote servers remain supported. -->
    <ServerFilePickerModal
      :open="showPicker"
      :mode="pickerMode"
      :filter="pickerFilter"
      :filter-options="pickerFilterOptions"
      :start-path="pickerStart"
      :fallback-start-path="pickerFallbackStart"
      :location-context="pickerIntent === 'new-location' ? 'project-create' : 'project-open'"
      @pick="onPickerPick"
      @close="onPickerClose"
    />

    <Teleport to="body">
      <div v-if="showNewShowDialog" class="name-dialog-backdrop" :data-theme="theme" @click.self="cancelNewShowDialog">
        <form
          class="name-dialog new-show-dialog"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="newShowDialogTitleId"
          @submit.prevent="createNewShow"
          @keydown.escape.prevent="cancelNewShowDialog"
        >
          <h3 :id="newShowDialogTitleId" class="name-dialog__title">{{ t('project.newShow') }}</h3>
          <label class="new-show-field" for="welcome-new-show-name">
            <span>{{ t('project.showName') }}</span>
            <input
              id="welcome-new-show-name"
              ref="newShowNameInput"
              class="name-dialog__input"
              v-model="newShowName"
              :placeholder="t('project.placeholder')"
              autocomplete="off"
            />
          </label>
          <div class="new-show-field">
            <label for="welcome-new-show-location">{{ t('project.location') }}</label>
            <div class="new-show-location">
              <input id="welcome-new-show-location" class="name-dialog__input" :value="newShowLocation" readonly />
              <button ref="newShowBrowseButton" type="button" class="name-dialog__btn" @click="browseNewShowLocation">
                {{ t('project.chooseLocation') }}
              </button>
            </div>
          </div>
          <div class="name-dialog__actions">
            <button type="button" class="name-dialog__btn" :disabled="creatingNewShow" @click="cancelNewShowDialog">{{ t('common.cancel') }}</button>
            <button type="submit" class="name-dialog__btn name-dialog__btn--primary" :disabled="!canCreateNewShow || creatingNewShow">{{ t('project.createShow') }}</button>
          </div>
        </form>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import ServerFilePickerModal from './ServerFilePickerModal.vue';
import type { ProjectFileKind } from '~/utils/projectFileFormats';
import { projectFileAction } from '~/utils/projectFileFormats';

const { createNewProject, importLegacyProject, openProject, tryRejoinExistingProject } = useProject();
const { t } = useLocalization();
const server = useLiveplayServer();

// Three-stage flow: mode picker → (optional remote address) → project picker.
type Stage = 'mode' | 'remote' | 'project';
const stage = ref<Stage>('mode');
const mode  = ref<'local' | 'remote'>('local');

const remoteAddress   = ref('');
const remoteAccessToken = ref(String(server.accessToken || ''));
const connecting      = ref(false);
const connectionError = ref<string>('');

// File-association routing is extension-aware. Canonical .dwcue shows open;
// legacy .liveplay shows convert through the explicit importer; .dwcuepack and
// legacy .lpa archives continue through app.vue's archive destination flow.
const pendingFileOpen = useState<{ path: string; kind: ProjectFileKind } | null>(
  'liveplay:pendingFileOpen', () => null);
const pendingArchiveImportReady = useState<string | null>(
  'liveplay:pendingLpaImportReady', () => null);
const importAfterConnect = ref(false);
const pendingArchivePath = ref('');

// LAN-discovered servers (populated from the UDP beacon via Electron IPC).
type DiscoveredServer = {
  instanceId: string;
  name: string;
  host: string;
  port: number;
  version: string;
  projectName: string;
  hasOpenProject: boolean;
  itemCount: number;
  url: string;
};
const discoveredServers = ref<DiscoveredServer[]>([]);
let stopDiscoverySub: (() => void) | null = null;

// Recently-connected servers (persisted by the Electron main process).
type RecentServer = { url: string; name: string; host: string; port: number; lastSeen: number };
const recentServers = ref<RecentServer[]>([]);
const scanning = ref(false);

type RecentProject = {
  path: string;
  name?: string;
  folderPath?: string;
  lastOpened?: number;
};
const recentProjects = ref<RecentProject[]>([]);
const localModeButton = ref<HTMLButtonElement | null>(null);
const remoteAddressInput = ref<HTMLInputElement | null>(null);
const changeModeButton = ref<HTMLButtonElement | null>(null);
const newProjectButton = ref<HTMLButtonElement | null>(null);
const newShowNameInput = ref<HTMLInputElement | null>(null);
const newShowBrowseButton = ref<HTMLButtonElement | null>(null);
const newShowDialogReturnFocus = ref<HTMLElement | null>(null);
const newShowDialogTitleId = 'welcome-new-show-title';

const canOpenOperatorManual = import.meta.client && typeof window.electronAPI?.openOperatorManual === 'function';
const openOperatorManual = () => { void window.electronAPI.openOperatorManual(); };

// Computed reflection of the currently-configured server URL.
const serverUrlDisplay = computed(() => server.serverUrl ?? 'http://127.0.0.1:4480');

// Server file picker state — Open Project, plus the location chooser launched
// from the combined New Show form.
const showPicker          = ref(false);
const pickerMode          = ref<'file' | 'directory'>('directory');
const pickerFilter        = ref<string>('.dwcue,.liveplay');
const pickerFilterOptions = ref<string[]>(['.dwcue,.liveplay', 'all']);
const pickerStart         = ref<string | undefined>(undefined);
const pickerFallbackStart = ref<string>('');
const pickerIntent        = ref<'new-location' | 'open'>('open');

// Get app version
const appVersion = ref('2.6.16');
onMounted(async () => {
  if (import.meta.client && (window as any).electronAPI?.getAppVersion) {
    appVersion.value = await (window as any).electronAPI.getAppVersion();
  }

  // Read the persisted mode/server config from Electron (if available) and
  // auto-skip the mode picker if the user has already chosen a side.
  try {
    if (import.meta.client && (window as any).electronAPI?.liveplayServer?.getConfig) {
      const cfg = await (window as any).electronAPI.liveplayServer.getConfig();
      if (cfg?.mode === 'remote' && cfg.remoteUrl) {
        mode.value = 'remote';
        remoteAddress.value = stripScheme(cfg.remoteUrl);
        server.configureRemoteConnection(cfg.remoteUrl, server.accessToken);
      } else if (cfg?.mode === 'local') {
        mode.value = 'local';
      }
    }
  } catch (e) {
    console.warn('[welcome] could not read liveplay-server config:', e);
  }

  await loadRecentProjects();

  // A queued native open or explicit legacy import takes precedence over the
  // ordinary welcome flow.
  const pending = pendingFileOpen.value;
  if (pending) {
    await handlePendingFileOpen(pending);
  } else {
    // If the user just hit File > New / Open while a project was open, we
    // closed that project to land them here — skip the mode picker (their
    // server is still configured) and pop the appropriate picker straight
    // away. Without this, File > New would dump them at the mode picker
    // instead of the new-project flow they actually asked for.
    let welcomeOpenPath: string | null = null;
    try { welcomeOpenPath = sessionStorage.getItem('liveplay:welcomeOpenPath'); } catch {}
    let welcomeIntent: string | null = null;
    try { welcomeIntent = sessionStorage.getItem('liveplay:welcomeIntent'); } catch {}
    if (welcomeOpenPath) {
      // File > Open Recent closed the previous project to land us here with an
      // exact path to open or import. The server connection remains active.
      try { sessionStorage.removeItem('liveplay:welcomeOpenPath'); } catch {}
      stage.value = 'project';
      nextTick(async () => {
        const ok = await openSelectedProject(welcomeOpenPath!);
        if (!ok) alert('Failed to open project');
      });
    } else if (welcomeIntent === 'new' || welcomeIntent === 'open') {
      try { sessionStorage.removeItem('liveplay:welcomeIntent'); } catch {}
      stage.value = 'project';
      // Defer to next tick so the project-stage UI is mounted before we
      // ask it to open its modal.
      nextTick(() => {
        if (welcomeIntent === 'new') handleNewProject();
        else                          handleOpenProject();
      });
    } else {
      // This release ships local-only: skip the server-choice screen and go
      // straight to the embedded engine. The remote/network UI stays in place
      // (behind the per-device toggle) for a future update. stage is already
      // 'mode', so if the local server fails to start the picker reappears
      // with the error visible.
      void chooseLocal();
    }
  }

  // Start LAN discovery so the remote-mode stage immediately shows any
  // servers visible on the network.
  try {
    const disc = (window as any).electronAPI?.liveplayDiscovery;
    if (disc) {
      await disc.start();
      const initial = await disc.list();
      if (Array.isArray(initial)) discoveredServers.value = initial;
      stopDiscoverySub = disc.onServers((list: DiscoveredServer[]) => {
        discoveredServers.value = list ?? [];
      });
      // Load the persisted recent-servers list for the fallback picker.
      try {
        const recent = await disc.recentList?.();
        if (Array.isArray(recent)) recentServers.value = recent;
      } catch {}
    }
  } catch (e) {
    console.warn('[welcome] discovery start failed:', e);
  }
  queueStageFocus();
});

watch(stage, (s) => {
  if (s === 'project') void loadRecentProjects();
  queueStageFocus(s);
});

// Drive a queued native open or legacy import. Show files use the local server;
// archives hand off to app.vue after the local connection is ready.
async function handlePendingFileOpen(p: { path: string; kind: ProjectFileKind }) {
  pendingFileOpen.value = null;
  if (p.kind === 'native-project' || p.kind === 'legacy-project') {
    mode.value = 'local';
    connectionError.value = '';
    connecting.value = true;
    try {
      if (!(await ensureLocalServer())) { stage.value = 'mode'; return; }
      const ok = await openSelectedProject(p.path);
      if (!ok) {
        connectionError.value = t('welcome.connectionFailed');
        stage.value = 'mode';
      }
    } catch (e: any) {
      connectionError.value = e?.message ?? String(e);
      stage.value = 'mode';
    } finally {
      connecting.value = false;
    }
    return;
  }

  pendingArchivePath.value = p.path;
  importAfterConnect.value = true;
  void chooseLocal();
}

// Late-arrival case: a file double-clicked while this screen is already
// mounted (e.g. sitting on the welcome screen with no project open). onMounted
// won't re-run, so react to the shared state changing.
watch(pendingFileOpen, (p) => {
  if (p) void handlePendingFileOpen(p);
});

onUnmounted(() => {
  if (stopDiscoverySub) { try { stopDiscoverySub(); } catch {} stopDiscoverySub = null; }
});

// Get theme from app state (works even when no project is open)
const theme = useState('theme', () => 'dark');
const isDark = computed(() => theme.value === 'dark');

// ---- Mode handlers ---------------------------------------------------------
function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}
function normaliseRemoteUrl(input: string): string {
  let v = input.trim();
  if (!v) return '';
  // Allow bare host or host:port. Default to http:// and port 4480.
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
  // If no explicit port, append :4480 for convenience.
  try {
    const u = new URL(v);
    if (!u.port) u.port = '4480';
    return u.origin;
  } catch {
    return v;
  }
}

// Probe a server's HTTP control port before we commit to it. LAN discovery
// runs over UDP, so a server can be visible in the list while its TCP control
// port (REST + WebSocket) is unreachable — e.g. a firewall that allows the
// discovery beacon but blocks 4480. Without this check we'd set the URL,
// fail every request silently, and still land the user on New/Open as if
// connected. A short timeout keeps a dropped SYN from hanging the UI.
async function probeServerReachable(url: string): Promise<void> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, 5000);
  try {
    const r = await fetch(url + '/api/health', { method: 'GET', signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch (e: any) {
    // A dropped TCP SYN (firewall) surfaces as our timeout-driven abort; a
    // refused connection as a TypeError. Both mean "port unreachable" — give
    // a clearer message than the raw AbortError/TypeError text.
    if (timedOut || e?.name === 'AbortError') {
      throw new Error(t('welcome.serverUnreachable'));
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Configure local mode, set the server URL, and spawn (or reattach to) the
// local server, waiting until /api/health answers so a follow-up WS connect
// doesn't race the bind. Returns false (and sets connectionError) on failure.
// Shared by the Local button and file-association routes.
async function ensureLocalServer(): Promise<boolean> {
  const api = (window as any).electronAPI?.liveplayServer;
  if (!import.meta.client || !api?.setConfig || !api?.ensureRunning) {
    connectionError.value = t('welcome.connectionFailed') + ' (local server controls unavailable)';
    return false;
  }

  const cfg = await api.setConfig({ mode: 'local' });
  const res = await api.ensureRunning();
  if (!res?.ok || !res.accessToken) {
    connectionError.value = res?.error
      ? 'Local server failed to start: ' + res.error
      : 'Local server failed to provide an access credential. Restart DonWells Cue and try again.';
    return false;
  }

  const port = res.port ?? cfg.localPort ?? 4480;
  server.configureManagedConnection('http://127.0.0.1:' + port, res.accessToken);
  return true;
}

async function chooseLocal() {
  mode.value = 'local';
  connectionError.value = '';
  connecting.value = true;
  try {
    if (!(await ensureLocalServer())) return;
    // A queued archive skips the project picker and proceeds to extraction.
    if (importAfterConnect.value) { beginImportDestination(); return; }
    // If a project is already open server-side (e.g. the user kept the
    // detached server running between renderer reloads), drop straight
    // into the workspace.
    if (await tryRejoinExistingProject()) return;
    stage.value = 'project';
  } catch (e: any) {
    connectionError.value = e?.message ?? String(e);
  } finally {
    connecting.value = false;
  }
}

// Hand a queued archive to app.vue, which owns destination selection, upload,
// extraction, and canonical project open. Cancelling leaves this screen usable.
function beginImportDestination() {
  importAfterConnect.value = false;
  const archivePath = pendingArchivePath.value;
  pendingArchivePath.value = '';
  stage.value = 'project';
  if (archivePath) pendingArchiveImportReady.value = archivePath;
}

const { showNetworkUi, setNetworkUiVisible } = useNetworkUiVisibility();

function revealNetworkUi() {
  setNetworkUiVisible(true);
  chooseRemote();
}

function chooseRemote() {
  mode.value = 'remote';
  connectionError.value = '';
  if (!remoteAddress.value) {
    const fallback = stripScheme(server.serverUrl ?? '');
    if (fallback && fallback !== '127.0.0.1:4480') remoteAddress.value = fallback;
  }
  stage.value = 'remote';
}

function changeMode() {
  stage.value = 'mode';
  connectionError.value = '';
}

async function connectToRemote() {
  if (!remoteAddress.value) return;
  const url = normaliseRemoteUrl(remoteAddress.value);
  if (!url) {
    connectionError.value = t('welcome.connectionFailed');
    return;
  }

  connecting.value = true;
  connectionError.value = '';
  try {
    // Probe the server's /api/health before committing.
    await probeServerReachable(url);

    server.configureRemoteConnection(url, remoteAccessToken.value);
    if (import.meta.client && (window as any).electronAPI?.liveplayServer?.setConfig) {
      await (window as any).electronAPI.liveplayServer.setConfig({
        mode: 'remote',
        remoteUrl: url,
      });
    }
    void rememberServer(url);
    // A queued archive skips the project picker and proceeds to extraction.
    if (importAfterConnect.value) { beginImportDestination(); return; }
    // Multi-client: if the remote server is already running a project,
    // join the live session directly instead of showing New/Open.
    if (await tryRejoinExistingProject()) return;
    stage.value = 'project';
  } catch (e: any) {
    console.warn('[welcome] remote connect failed:', e);
    connectionError.value = t('welcome.connectionFailed') + ' (' + (e?.message ?? e) + ')';
  } finally {
    connecting.value = false;
  }
}

// Click handler on a row in the discovered-servers list. Skips the manual
// URL probe (the beacon proved the server is up) and dives straight into
// the rejoin flow.
async function connectToDiscovered(srv: DiscoveredServer) {
  if (connecting.value) return;
  connecting.value = true;
  connectionError.value = '';
  try {
    const url = srv.url;
    // The beacon proves the server is up on UDP, but the TCP control port may
    // still be unreachable (firewall, different subnet). Probe before we
    // commit so a blocked port shows an error instead of a fake welcome screen.
    await probeServerReachable(url);
    remoteAddress.value = stripScheme(url);
    server.configureRemoteConnection(url, remoteAccessToken.value);
    if (import.meta.client && (window as any).electronAPI?.liveplayServer?.setConfig) {
      await (window as any).electronAPI.liveplayServer.setConfig({
        mode: 'remote',
        remoteUrl: url,
      });
    }
    void rememberServer(url, { name: srv.name });
    if (importAfterConnect.value) { beginImportDestination(); return; }
    if (await tryRejoinExistingProject()) return;
    stage.value = 'project';
  } catch (e: any) {
    console.warn('[welcome] discovered-server connect failed:', e);
    connectionError.value = t('welcome.connectionFailed') + ' (' + (e?.message ?? e) + ')';
  } finally {
    connecting.value = false;
  }
}

// ---- Discovery + recent-server helpers -------------------------------------

// Persist a freshly-connected server to the recent list, and refresh the ref.
async function rememberServer(url: string, meta?: { name?: string }) {
  try {
    const disc = (window as any).electronAPI?.liveplayDiscovery;
    if (!disc?.recentAdd) return;
    let host = '', port = 4480;
    try { const u = new URL(url); host = u.hostname; port = Number(u.port) || 4480; } catch {}
    const updated = await disc.recentAdd({ url, host, port, name: meta?.name ?? host });
    if (Array.isArray(updated)) recentServers.value = updated;
  } catch {}
}

// Fire a fresh solicitation burst and show a brief scanning spinner.
async function rescan() {
  if (scanning.value) return;
  scanning.value = true;
  try {
    await (window as any).electronAPI?.liveplayDiscovery?.solicit?.();
  } catch {}
  setTimeout(() => { scanning.value = false; }, 1500);
}

// Connect to a remembered server. Like the manual path but pre-filled.
async function connectToRecent(srv: RecentServer) {
  remoteAddress.value = stripScheme(srv.url);
  await connectToRemote();
}

async function forgetRecent(srv: RecentServer) {
  try {
    const disc = (window as any).electronAPI?.liveplayDiscovery;
    const updated = await disc?.recentRemove?.(srv.url);
    if (Array.isArray(updated)) recentServers.value = updated;
  } catch {}
}

// ---- Recent project helpers ------------------------------------------------

async function loadRecentProjects() {
  if (!import.meta.client) return;
  try {
    const api = (window as any).electronAPI?.liveplayProjects;
    const list = await api?.recentList?.();
    recentProjects.value = Array.isArray(list) ? list : [];
  } catch (e) {
    console.warn('[welcome] could not load recent projects:', e);
    recentProjects.value = [];
  }
}

function projectBasename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function projectFolder(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, '');
}
async function openSelectedProject(projectPath: string): Promise<boolean> {
  const action = projectFileAction(projectPath);
  if (action === 'open-project') return openProject(projectPath);
  if (action === 'import-legacy-project') return importLegacyProject(projectPath);
  return false;
}

function recentProjectStartPath(): string {
  const first = recentProjects.value[0];
  return first?.folderPath || (first?.path ? projectFolder(first.path) : '');
}

async function openRecentProject(project: RecentProject) {
  if (!project.path) return;

  const ok = await openSelectedProject(project.path);

  if (!ok) {
    console.warn('[welcome] failed to open recent project:', project.path);
    alert(
      `Failed to open project.\n\n` +
      `DonWells Cue could not load this recent project from the current server. ` +
      `The file may exist, but it may be unavailable, locked, not fully synced, or not readable by the server.\n\n` +
      `Recent entry:\n${project.path}\n\n` +
      `The entry was not removed. You can remove it manually with the X button.`
    );
  }
}

async function removeRecentProject(project: RecentProject) {
  if (!project.path) return;
  try {
    const api = (window as any).electronAPI?.liveplayProjects;
    const updated = await api?.recentRemove?.(project.path);
    if (Array.isArray(updated)) recentProjects.value = updated;
    else await loadRecentProjects();
  } catch {}
}


function focusIfConnected(el: HTMLElement | null | undefined) {
  if (el?.isConnected) el.focus();
}

function queueStageFocus(targetStage = stage.value) {
  nextTick(() => {
    if (showNewShowDialog.value || showPicker.value) return;
    if (targetStage === 'remote') {
      focusIfConnected(remoteAddressInput.value);
      return;
    }
    if (targetStage === 'project') {
      focusIfConnected(newProjectButton.value ?? changeModeButton.value);
      return;
    }
    focusIfConnected(localModeButton.value);
  });
}
// ---- Project pickers -------------------------------------------------------
const showNewShowDialog = ref(false);
const newShowName = ref('');
const newShowLocation = ref('');
const newShowLocations = useFilePickerLocations(() => String(server.serverUrl), 'project-create');
const creatingNewShow = ref(false);
const canCreateNewShow = computed(() => !!newShowName.value.trim() && !!newShowLocation.value.trim());

const handleNewProject = () => {
  newShowName.value = '';
  newShowLocation.value = newShowLocations.lastFolder.value ?? recentProjectStartPath();
  newShowDialogReturnFocus.value = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  showNewShowDialog.value = true;
  nextTick(() => newShowNameInput.value?.focus());
};

function browseNewShowLocation() {
  pickerIntent.value        = 'new-location';
  pickerMode.value          = 'directory';
  pickerFilter.value        = 'all';
  pickerFilterOptions.value = ['all'];
  pickerStart.value         = undefined;
  pickerFallbackStart.value = recentProjectStartPath();
  showNewShowDialog.value   = false;
  showPicker.value          = true;
}

const handleOpenProject = () => {
  pickerIntent.value        = 'open';
  pickerMode.value          = 'file';
  pickerFilter.value        = '.dwcue,.liveplay';
  pickerFilterOptions.value = ['.dwcue,.liveplay', 'all'];
  pickerStart.value         = undefined;
  pickerFallbackStart.value = recentProjectStartPath();
  showPicker.value          = true;
};

const onPickerPick = async (fullPath: string) => {
  showPicker.value = false;
  if (pickerIntent.value === 'new-location') {
    if (fullPath) newShowLocation.value = fullPath;
    showNewShowDialog.value = true;
    nextTick(() => newShowBrowseButton.value?.focus());
    return;
  }
  if (!fullPath) return;
  const ok = await openSelectedProject(fullPath);
  if (!ok) alert('Failed to open project');
};

function onPickerClose() {
  showPicker.value = false;
  if (pickerIntent.value !== 'new-location') return;
  showNewShowDialog.value = true;
  nextTick(() => newShowBrowseButton.value?.focus());
}

function restoreNewShowDialogFocus() {
  nextTick(() => {
    if (newShowDialogReturnFocus.value?.isConnected) {
      newShowDialogReturnFocus.value.focus();
      return;
    }
    queueStageFocus();
  });
}

async function createNewShow() {
  const name = newShowName.value.trim();
  const location = newShowLocation.value.trim();
  if (!name || !location || creatingNewShow.value) return;
  creatingNewShow.value = true;
  const ok = await createNewProject(name, location);
  creatingNewShow.value = false;
  if (!ok) {
    alert('Failed to create project');
    nextTick(() => newShowNameInput.value?.focus());
    return;
  }
  showNewShowDialog.value = false;
}

function cancelNewShowDialog() {
  if (creatingNewShow.value) return;
  showNewShowDialog.value = false;
  restoreNewShowDialogFocus();
}

// Listen for menu events
if (import.meta.client && (window as any).electronAPI) {
  (window as any).electronAPI.onMenuNewProject(() => {
    if (stage.value === 'project') handleNewProject();
  });

  (window as any).electronAPI.onMenuOpenProject(() => {
    if (stage.value === 'project') handleOpenProject();
  });

  // File > Open Recent while no project is open (we're already on the project
  // stage, connected to a server) — open the chosen path directly.
  (window as any).electronAPI.onMenuOpenRecentProject(async (_e: any, projectPath: string) => {
    if (stage.value !== 'project' || !projectPath) return;
    const ok = await openSelectedProject(projectPath);
    if (!ok) alert('Failed to open project');
  });
}
</script>

<style scoped>
.welcome-screen {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-background);
}

.welcome-container {
  width: min(720px, calc(100% - 64px));
  max-height: calc(100% - 64px);
  text-align: left;
  padding: 0;
}

.welcome-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  margin-bottom: var(--spacing-lg);
  padding: 0 var(--spacing-xs);
}

.welcome-logo {
  width: 80px;
  height: 80px;
  object-fit: contain;
}

.welcome-text { text-align: left; }

.welcome-title {
  font-size: 34px;
  font-weight: 650;
  margin-bottom: var(--spacing-xs);
  color: var(--color-text-primary);
  letter-spacing: -0.035em;
  line-height: 1.05;
  display: flex;
  align-items: baseline;
  gap: var(--spacing-sm);
}

.version-badge {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-tertiary);
  letter-spacing: 0.02em;
}

.welcome-byline {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin: 2px 0 0;
}

.welcome-byline strong {
  color: var(--color-text-primary);
  font-weight: 600;
}

.welcome-subtitle {
  font-size: 14px;
  color: var(--color-text-secondary);
  margin: 0;
}

.welcome-stage {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--spacing-sm);
  padding: var(--spacing-xl);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-lg);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.14);
  max-height: calc(100vh - 180px);
  overflow: auto;
}

.stage-title {
  font-size: 18px;
  font-weight: 650;
  letter-spacing: -0.01em;
  margin: 0;
  color: var(--color-text-primary);
}

.stage-subtitle {
  margin: 0 0 var(--spacing-sm);
  font-size: 13px;
  color: var(--color-text-secondary);
}

.connection-summary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  justify-content: flex-start;
}
.connection-icon {
  font-size: 18px;
  vertical-align: middle;
}

.link-button {
  background: none;
  border: none;
  color: var(--color-accent);
  text-underline-offset: 3px;
  cursor: pointer;
  font-size: inherit;
}

.welcome-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--spacing-sm);
  margin-top: var(--spacing-xs);
}

.welcome-actions--single {
  grid-template-columns: minmax(0, 1fr);
}

.network-reveal {
  justify-self: center;
  margin-top: var(--spacing-sm);
  font-size: 0.85em;
  opacity: 0.75;
}

.welcome-button {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: var(--spacing-md);
  min-height: 76px;
  padding: var(--spacing-md) var(--spacing-lg);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-md);
  cursor: pointer;
  font-size: 14px;
  color: var(--color-text-primary);
  text-align: left;
}
.welcome-button:hover:not(:disabled) {
  background: var(--color-surface-hover);
  border-color: var(--color-border-strong);
}
.welcome-button.primary {
  background: var(--color-accent-soft);
  color: var(--color-text-primary);
  border-color: var(--color-accent);
}
.welcome-button.primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-accent) 24%, var(--color-surface));
  border-color: var(--color-accent-hover);
}
.welcome-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.button-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  border-radius: var(--border-radius-sm);
  background: var(--color-control);
  color: var(--color-accent);
}

.button-label {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.button-label-line { font-weight: 600; }
.button-label-sub {
  font-size: 12px;
  color: var(--color-text-secondary);
  line-height: 1.35;
}

/* Remote form */
.remote-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
}
.remote-field-label {
  font-size: 13px;
  color: var(--color-text-secondary);
}
.remote-field-input {
  min-height: 40px;
}
.remote-field-input:focus {
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}
.remote-error {
  color: #e34c4c;
  font-size: 13px;
  margin: 0;
}
.remote-actions {
  display: flex;
  gap: 12px;
  margin-top: 12px;
  justify-content: flex-end;
}
.remote-actions .welcome-button {
  min-height: 40px;
  padding: var(--spacing-sm) var(--spacing-lg);
}

.discovered-servers {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  margin: var(--spacing-sm) 0 var(--spacing-md);
  padding: var(--spacing-sm);
  background: var(--color-control);
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-md);
}
.discovered-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 2px var(--spacing-xs) var(--spacing-xs);
}
.discovered-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-surface);
  border: 1px solid transparent;
  border-radius: var(--border-radius-sm);
  color: var(--color-text-primary);
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast);
}
.discovered-row-group {
  display: flex;
  align-items: stretch;
  gap: 8px;
}
.discovered-row-group .discovered-row { flex: 1; }
.discovered-row:hover:not(:disabled) {
  background: var(--color-surface-hover);
  border-color: var(--color-accent);
}
.discovered-row:disabled { opacity: 0.5; cursor: default; }
.discovered-icon { color: var(--color-accent); }
.discovered-main { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.discovered-name { font-weight: 600; }
.discovered-meta {
  font-size: 12px;
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.discovered-project { color: var(--color-accent); }
.discovered-arrow { color: var(--color-text-secondary); }
.discovered-rescan {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  background: transparent;
  border: none;
  color: var(--color-text-secondary);
  cursor: pointer;
  border-radius: 4px;
}
.discovered-rescan:hover:not(:disabled) { color: var(--color-accent); background: var(--color-surface-hover); }
.discovered-rescan:disabled { opacity: 0.5; cursor: default; }
.discovered-rescan .material-symbols-rounded { font-size: 18px; }
.discovered-forget {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  padding: 0 8px;
  background: var(--color-surface);
  border: 1px solid transparent;
  border-radius: var(--border-radius-sm);
  color: var(--color-text-secondary);
}
.discovered-forget:hover:not(:disabled) {
  background: var(--color-surface-hover);
  border-color: var(--color-accent);
}
.discovered-forget:disabled { opacity: 0.5; cursor: default; }
.discovered-empty {
  font-size: 12px;
  color: var(--color-text-secondary);
  padding: 4px 2px;
  margin: 0;
}
.discovered-remove {
  font-size: 18px;
}
.discovered-forget:hover:not(:disabled) .discovered-remove { color: var(--color-danger, #e5534b); }

.recent-projects { margin-top: var(--spacing-md); }
.recent-project-row .discovered-meta { max-width: 430px; }
.recent-projects-empty { margin-top: 12px; }

@keyframes lp-spin { to { transform: rotate(360deg); } }
.spin { display: inline-block; animation: lp-spin 0.85s linear infinite; }

@media (max-width: 720px) {
  .welcome-container {
    width: calc(100% - 32px);
  }

  .welcome-actions {
    grid-template-columns: 1fr;
  }
}
</style>

/* New-project name dialog — unscoped due to Teleport to body */
<style>
.name-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9200;
  background: var(--dialog-backdrop);
  display: flex;
  align-items: center;
  justify-content: center;
}

.name-dialog {
  background: var(--dialog-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--dialog-radius);
  padding: var(--dialog-padding);
  min-width: 360px;
  max-width: 480px;
  width: 90vw;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
  box-shadow: var(--dialog-shadow);
}

.name-dialog__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.name-dialog__input {
  padding: 10px 12px;
  background: var(--color-background);
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-md);
  color: var(--color-text-primary);
  font-size: 14px;
  outline: none;
  transition: border-color var(--transition-fast);
}

.name-dialog__input:focus { border-color: var(--color-accent); }

.new-show-dialog { width: min(520px, 92vw); }

.new-show-field {
  display: grid;
  gap: 6px;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 600;
}

.new-show-location {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--spacing-sm);
}

.new-show-location .name-dialog__input {
  min-width: 0;
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  text-overflow: ellipsis;
}

.name-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-sm);
}

.name-dialog__btn {
  min-height: var(--panel-control-height);
  padding: 6px 12px;
  border-radius: var(--control-radius);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid var(--color-border);
  background: var(--color-surface-raised);
  color: var(--color-text-primary);
  transition: background var(--transition-fast), border-color var(--transition-fast);
}

.name-dialog__btn:hover:not(:disabled) {
  background: var(--color-surface-hover);
  border-color: var(--color-accent);
}

.name-dialog__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.name-dialog__btn--primary {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: #fff;
}

.name-dialog__btn--primary:hover:not(:disabled) {
  filter: brightness(1.1);
  background: var(--color-accent);
  border-color: var(--color-accent);
}
</style>
