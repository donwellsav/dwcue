<template>
  <div id="app" :data-theme="theme" :style="isVideoOutputWindow ? undefined : { zoom: uiFontScale / 100 }">
    <!-- Video Output window: passive render surface — no app chrome, no modals. -->
    <template v-if="isVideoOutputWindow">
      <VideoOutputView />
    </template>

    <!-- Detached One Shots window (legacy query name retained for IPC compatibility). -->
    <template v-else-if="isCartWindow">
      <div class="cart-window-root">
        <header class="cart-window-brand">
          <img
            :src="theme === 'dark' ? './assets/icons/SVG/app_icon_darkmode@web.svg' : './assets/icons/SVG/app_icon_lightmode@web.svg'"
            alt=""
            class="cart-brand-logo"
          />
          <span class="cart-brand-wordmark">DONWELLS CUE</span>
          <span class="cart-brand-url">dwcue.com</span>
        </header>
        <template v-if="currentProject && detachedProjectIdentity">
          <p v-if="detachedProjectError" class="cart-window-error" role="alert">{{ detachedProjectError }}</p>
          <OneShotPanel :is-detached-window="true" />
        </template>
        <div v-else class="cart-window-loading">
          <CueSymbol name="one-shots" />
          <p v-if="detachedProjectError">{{ detachedProjectError }}</p>
        </div>
      </div>

      <!-- The detached cart window fires cues too, so it needs the same
           lockout: without it, cart pads here would keep accepting presses
           that silently never reach the server. -->
      <ConnectionLostModal />

      <!-- Multi-item delete confirm, also needed in the detached cart window -->
      <DeleteSelectionModal
        :visible="deleteDialogVisible"
        :count="deleteDialogCount"
        :name="deleteDialogName"
        :allow-only="deleteDialogAllowOnly"
        @delete-all="deleteDialogConfirmAll"
        @delete-only="deleteDialogConfirmOnly"
        @cancel="deleteDialogCancel"
      />
    </template>

    <!-- Normal mode -->
    <template v-else>
      <WelcomeScreen
        v-if="!currentProject"
        ref="welcomeScreen"
        :open-project="guardedOpenProject"
        :project-file-dialog-open="projectFileDialogOpen"
        @new-project="showNewProjectDialog"
        @open-project="showOpenProjectPicker"
      />
      <div v-else-if="projectHydrationStatus === 'failed'" class="project-hydration-error" role="alert">
        <strong>{{ t('projectHydration.failed') }}</strong>
        <span v-if="projectHydrationError">{{ projectHydrationError }}</span>
        <button type="button" data-testid="project-hydration-stop-all" @click="stopAllCues()">
          {{ t('controls.stopAll') }}
        </button>
        <button type="button" @click="retryProjectHydration">{{ t('projectHydration.retry') }}</button>
        <button type="button" @click="showOpenProjectPicker(currentProject.folderPath)">
          {{ t('projectHydration.chooseAnotherShow') }}
        </button>
      </div>
      <MainWorkspace v-else />
    <!-- Accent Color Picker Modal -->
    <div v-if="showColorPicker" class="color-picker-overlay" @click="showColorPicker = false">
      <div class="color-picker-dialog" @click.stop>
        <h3>{{ t('colors.chooseAccent') }}</h3>
        <div class="color-grid">
          <button
            v-for="color in accentColors"
            :key="color"
            class="color-option"
            :style="{ backgroundColor: color }"
            @click="changeAccentColor(color)"
          ></button>
        </div>
        <button class="close-dialog" @click="showColorPicker = false">{{ t('common.cancel') }}</button>
      </div>
    </div>
    
    <!-- About Modal -->
    <AboutModal v-if="showAboutModal" @close="showAboutModal = false" />
    
    <!-- Update Modal -->
    <UpdateModal
      v-if="showUpdateModal"
      :current-version="updateInfo.currentVersion"
      :new-version="updateInfo.newVersion"
      :release-notes="updateInfo.releaseNotes"
      :release-date="updateInfo.releaseDate"
      @close="showUpdateModal = false"
      @install="handleUpdateInstall"
      @install-on-exit="handleUpdateInstallOnExit"
    />

    <Transition name="update-toast">
      <div v-if="unsavedDialogBlocked && !unsavedDialogVisible" class="update-toast" role="status">{{ t('unsavedModal.waitForSave') }}</div>
      <div v-else-if="upToDateToast" class="update-toast">{{ upToDateToast }}</div>
    </Transition>
    
    <!-- Progress Modal for Import/Export -->
    <ProgressModal
      :visible="progressModal.visible"
      :title="progressModal.title"
      :message="progressModal.message"
      :percentage="progressModal.percentage"
    />
    
    <!-- Project Selection Modal -->
    <ProjectSelectionModal
      :visible="showProjectSelection"
      :projects="availableProjects"
      @select="handleProjectSelection"
      @cancel="handleProjectSelectionCancel"
    />

    <!-- The New Show form owns both values. Browsing for a location temporarily
         swaps to the server-side picker so remote servers remain supported. -->
    <ServerFilePickerModal
      :open="projectPicker !== null"
      :mode="projectPicker === 'new-location' ? 'directory' : 'file'"
      :filter="projectPicker === 'new-location' ? 'all' : '.dwcue'"
      :filter-options="projectPicker === 'new-location' ? ['all'] : ['.dwcue', 'all']"
      :fallback-start-path="projectPickerFallback"
      :location-context="projectPicker === 'new-location' ? 'project-create' : 'project-open'"
      @pick="onProjectPickerPick"
      @close="closeProjectPicker"
    />

    <Teleport to="body">
      <div v-if="showNewShowDialog" class="name-dialog-backdrop" :data-theme="theme" @click.self="cancelNewShowDialog">
        <form
          class="name-dialog new-show-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="welcome-new-show-title"
          @submit.prevent="createNewShow"
          @keydown.stop
          @keydown.escape.prevent="cancelNewShowDialog"
        >
          <h3 id="welcome-new-show-title" class="name-dialog__title">{{ t('project.newShow') }}</h3>
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

    <!-- Loading overlay (project open / create / save) -->
    <LoadingOverlay :visible="isLoading" :title="loadingMessage" />

    <!-- Project repair dialog -->
    <ProjectRepairModal
      :visible="repairDialogVisible"
      :issues="repairDialogIssues"
      @confirm="confirmRepair"
      @cancel="cancelRepair"
    />

    <!-- Unsaved-changes prompt (shown when leaving a project with autosave off) -->
    <UnsavedChangesModal
      :visible="unsavedDialogVisible && unsavedDialogReason === 'project'"
      :blocked="unsavedDialogBlocked"
      @save="unsavedSave"
      @discard="unsavedDiscard"
      @cancel="unsavedCancel"
    />

    <!-- Confirm prompt shown when deleting a multi-item selection -->
    <DeleteSelectionModal
      :visible="deleteDialogVisible"
      :count="deleteDialogCount"
      :name="deleteDialogName"
      :allow-only="deleteDialogAllowOnly"
      @delete-all="deleteDialogConfirmAll"
      @delete-only="deleteDialogConfirmOnly"
      @cancel="deleteDialogCancel"
    />

    <!-- Background audio-loading progress (when document already rendered) -->
    <AudioLoadProgress />

    <!-- LocalServerStatus pill intentionally not mounted. The local server
         now runs as a visible application with its own console window /
         taskbar entry, so the user has a direct way to see and stop it.
         Keep the component on disk in case we want to re-enable it later. -->
    <!-- <LocalServerStatus /> -->

    <!-- Persistent disconnect → ask the user how to recover -->
    <ConnectionLostModal />

    <!-- Reconnected, but the server no longer holds our project (it restarted)
         → resume from where we left off, or go back to the welcome screen. -->
    <SessionRecoveryModal />

    <!-- App-quit confirmation: unsaved changes, then (in local mode) whether
         to also shut the local audio server down. -->
    <QuitConfirmModal
      :visible="unsavedDialogVisible && unsavedDialogReason === 'quit'"
      :title="t('quitModal.unsavedTitle')"
      :message="t('quitModal.unsavedMessage') + (unsavedDialogBlocked ? ' ' + t('unsavedModal.finishCurrent') : '')"
      :buttons="quitUnsavedButtons"
      @pick="onQuitUnsavedPick"
    />
    <QuitConfirmModal
      :visible="quitServerVisible"
      :title="t('quitModal.serverTitle')"
      :message="t('quitModal.serverMessage')"
      :buttons="quitServerButtons"
      @pick="onQuitServerPick"
    />

    <!-- Import: server vs client choice (only for remote servers). -->
    <LocationChoiceModal
      :visible="importChoiceVisible"
      :title="t('importProject.chooseSourceTitle')"
      :message="t('importProject.chooseSourceMessage')"
      :server-label="t('importProject.fromServer')"
      :client-label="t('importProject.fromThisComputer')"
      :cancel-label="t('common.cancel')"
      @pick="onImportChoice"
      @cancel="importChoiceVisible = false"
    />

    <!-- Server file picker — used both to choose a show archive
         on the server and to choose the extract destination. -->
    <ServerFilePickerModal
      :open="importServerPickerOpen"
      :mode="importServerPickerStage === 'destination' ? 'directory' : 'file'"
      :filter="importServerPickerStage === 'destination' ? 'all' : '.dwcuepack'"
      :filter-options="importServerPickerStage === 'destination' ? ['all'] : ['.dwcuepack', 'all']"
      :location-context="importServerPickerStage === 'destination' ? 'archive-import-destination' : 'archive-import'"
      @pick="onImportServerPickerPick"
      @close="importServerPickerOpen = false"
    />
    </template>
    <ServerAlert />
  </div>
</template>

<script setup lang="ts">
import 'material-symbols/rounded.css';
import OneShotPanel from './components/OneShotPanel.vue';
import WelcomeScreen from './components/WelcomeScreen.vue';
import type { ProjectFileKind } from '~/utils/projectFileFormats';
import { projectFileAction } from '~/utils/projectFileFormats';
import type { OneShotMutationIdentity, OneShotMutationRequest, OneShotMutationResult, OneShotProjectEnvelope } from '~/types/oneShotMutation';
import { sameOneShotMutationIdentity } from '~/types/oneShotMutation';
import { createProjectOpenGuard } from '~/utils/projectOpenGuard';
import { runExclusivePendingAction } from '~/utils/acknowledgedAction';
import { applyOneShotMutation, enforceOneShotDisarmFences } from '~/utils/oneShotMutation';

const {
  currentProject, saveProject, createNewProject, openProject, confirmUnsavedChanges,
  autoSaveEnabled, projectSyncIdentity,
  projectHydrationStatus, projectHydrationError, retryProjectHydration,
  isLoading, loadingMessage,
  repairDialogVisible, repairDialogIssues, confirmRepair, cancelRepair,
  unsavedDialogVisible, unsavedDialogReason, unsavedDialogBlocked, unsavedSave, unsavedDiscard, unsavedCancel,
  deleteDialogVisible, deleteDialogCount, deleteDialogName, deleteDialogAllowOnly,
  deleteDialogConfirmAll, deleteDialogConfirmOnly, deleteDialogCancel,
} = useProject();
const { stopAllCues } = useAudioEngine();
const { cartOnlyItems, clearCartOnlyItems, addCartOnlyItem } = useCartItems();
import LoadingOverlay from './components/LoadingOverlay.vue';
import AudioLoadProgress from './components/AudioLoadProgress.vue';
import LocationChoiceModal from './components/LocationChoiceModal.vue';
import ServerFilePickerModal from './components/ServerFilePickerModal.vue';
const { currentLocale, setLocale, getDirection, t } = useLocalization();

const openProjectGuard = createProjectOpenGuard({
  confirmUnsavedChanges,
  openProject(path) {
    useLiveplayServer().clearLastError();
    return openProject(path);
  },
  onOpenFailed(path) {
    const server = useLiveplayServer();
    server.lastError ??= t('project.openFailed', { path });
  },
});
const guardedOpenProject = (path: string) => {
  if (projectFileAction(path) !== 'open-project') {
    useLiveplayServer().lastError = t('project.openFailed', { path });
    return Promise.resolve(false);
  }
  return runExclusivePendingAction('project-file-change', `open:${path}`, () => openProjectGuard(path));
};

const welcomeScreen = ref<InstanceType<typeof WelcomeScreen> | null>(null);
const projectPicker = ref<'open' | 'new-location' | null>(null);
const projectPickerFallback = ref('');
const showNewShowDialog = ref(false);
const projectFileDialogOpen = computed(() => showNewShowDialog.value || projectPicker.value !== null);
const newShowName = ref('');
const newShowLocation = ref('');
const newShowLocations = useFilePickerLocations(() => String(useLiveplayServer().serverUrl), 'project-create');
const newShowNameInput = ref<HTMLInputElement | null>(null);
const newShowBrowseButton = ref<HTMLButtonElement | null>(null);
const newShowDialogReturnFocus = ref<HTMLElement | null>(null);
const creatingNewShow = ref(false);
const canCreateNewShow = computed(() => !!newShowName.value.trim() && !!newShowLocation.value.trim());

function showNewProjectDialog(fallbackFolder: string) {
  if (projectFileDialogOpen.value || isLoading.value || unsavedDialogVisible.value) return;
  projectPickerFallback.value = fallbackFolder;
  newShowName.value = '';
  newShowLocation.value = newShowLocations.lastFolder.value ?? fallbackFolder;
  newShowDialogReturnFocus.value = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  showNewShowDialog.value = true;
  nextTick(() => newShowNameInput.value?.focus());
}

function showOpenProjectPicker(fallbackFolder: string) {
  if (projectFileDialogOpen.value || isLoading.value || unsavedDialogVisible.value) return;
  projectPickerFallback.value = fallbackFolder;
  projectPicker.value = 'open';
}

function browseNewShowLocation() {
  showNewShowDialog.value = false;
  projectPicker.value = 'new-location';
}

function closeProjectPicker() {
  if (projectPicker.value === 'new-location') {
    showNewShowDialog.value = true;
    nextTick(() => newShowBrowseButton.value?.focus());
  }
  projectPicker.value = null;
}

function onProjectPickerPick(path: string) {
  const intent = projectPicker.value;
  closeProjectPicker();
  if (!path) return;
  if (intent === 'new-location') newShowLocation.value = path;
  else if (intent === 'open') void guardedOpenProject(path);
}

async function createNewShow() {
  const name = newShowName.value.trim();
  const folder = newShowLocation.value.trim();
  if (!name || !folder || creatingNewShow.value) return;
  creatingNewShow.value = true;
  try {
    const created = await runExclusivePendingAction('project-file-change', 'create', async () => {
      if (!await confirmUnsavedChanges()) return false;
      const ok = await createNewProject(name, folder);
      if (!ok) useLiveplayServer().lastError = t('project.createFailed');
      return ok;
    });
    if (created) showNewShowDialog.value = false;
    else nextTick(() => newShowNameInput.value?.focus());
  } finally {
    creatingNewShow.value = false;
  }
}

function cancelNewShowDialog() {
  if (creatingNewShow.value) return;
  showNewShowDialog.value = false;
  nextTick(() => {
    if (newShowDialogReturnFocus.value?.isConnected) newShowDialogReturnFocus.value.focus();
    else welcomeScreen.value?.queueStageFocus();
  });
}

let activeFileRoute = '';
async function routePendingFile(data: { filePath: string; kind: ProjectFileKind }) {
  if (!data?.filePath || activeFileRoute) return;
  activeFileRoute = data.filePath;
  try {
    if (data.kind === 'native-project') {
      await guardedOpenProject(data.filePath);
      return;
    }
    if (data.kind === 'native-archive' && projectFileAction(data.filePath) === 'import-archive') {
      if (!(await confirmUnsavedChanges())) return;
      pendingArchiveClientPath.value = data.filePath;
      pendingArchiveName.value = data.filePath.split(/[\/]/).pop() || 'import.dwcuepack';
      importServerPickerStage.value = 'destination';
      importServerPickerOpen.value = true;
      return;
    }
  } finally {
    activeFileRoute = '';
  }
}

const theme = useState('theme', () => 'dark');
// Global interface text scale (Settings → Interface font size). The app's
// styles are px-based, so the lever is `zoom` on the root — it scales text
// and chrome uniformly without touching hundreds of px rules.
const { uiFontScale, uiMode } = useUiMode();

watch(theme, (value) => {
  if (import.meta.client) document.documentElement.dataset.theme = value;
}, { immediate: true });

// Detect if this window is the detached cart player window
const isCartWindow = import.meta.client
  ? new URLSearchParams(window.location.search).get('cartWindow') === '1'
  : false;
// Detect if this window is the video output window (?videoOutput=1)
const isVideoOutputWindow = import.meta.client
  ? new URLSearchParams(window.location.search).get('videoOutput') === '1'
  : false;
const { mount: mountFailedHydrationHotkeys, unmount: unmountFailedHydrationHotkeys } = useCartHotkeys();
watch(() => !isCartWindow && !isVideoOutputWindow && projectHydrationStatus.value === 'failed', (failed) => {
  if (!import.meta.client) return;
  if (failed) mountFailedHydrationHotkeys();
  else unmountFailedHydrationHotkeys();
}, { immediate: true });
onBeforeUnmount(unmountFailedHydrationHotkeys);

// Initialize state viewer for dev mode
useStateViewer();

// Progress modal state
const progressModal = ref({
  visible: false,
  title: '',
  message: '',
  percentage: 0
});

// Project selection modal state
const showProjectSelection = ref(false);
const availableProjects = ref<string[]>([]);
const pendingImportPath = ref<string>('');

// Color picker for accent color
const showColorPicker = ref(false);
const DEFAULT_ACCENT = '#315fcf';
const retiredBrandAccents = new Set(['#a45d00', '#8f5000', '#c47a00', '#ffb000']);
const displayAccent = (color?: string) =>
  color && !retiredBrandAccents.has(color.toLowerCase()) ? color : DEFAULT_ACCENT;

// About modal
const showAboutModal = ref(false);

// Update modal
const showUpdateModal = ref(false);
const updateInfo = ref({
  currentVersion: '',
  newVersion: '',
  releaseNotes: '',
  releaseDate: '',
});
// Transient "you're up to date" confirmation for the manual Help-menu check.
const upToDateToast = ref('');
let upToDateToastTimer: number | null = null;
let installOnExitRequested = false;

const accentColors = [
  '#315fcf', '#3c6fe0', '#5a83e8', // DonWells cobalt
  '#007d79', '#009d9a', '#08bdba', // Teals
  '#da1e28', '#a2191f', '#750e13', // Reds
  '#24a148', '#198038', '#0e6027', // Greens
  '#f1c21b', '#d2a106', '#b28600', // Yellows
  '#8a3ffc', '#6929c4', '#491d8b', // Purples
  '#ff7eb6', '#ee5396', '#d02670', // Pinks
];

const detachedProjectIdentity = useState<OneShotMutationIdentity | null>(
  'oneShots.detachedProjectIdentity', () => null,
);
const detachedProjectError = useState<string>('oneShots.detachedMutationError', () => '');
const detachedDisarmFences = useState<Set<string>>('oneShots.detachedDisarmFences', () => new Set());
let rejectedDetachedIdentity: OneShotMutationIdentity | null = null;

function applyCartWindowProjectData(envelope: OneShotProjectEnvelope | null) {
  if (!isCartWindow) return;
  const projectData = envelope?.project ?? null;
  const identity = envelope?.identity ?? null;
  if (!projectData || !identity) {
    rejectedDetachedIdentity = detachedProjectIdentity.value;
    detachedProjectIdentity.value = null;
    currentProject.value = null;
    clearCartOnlyItems();
    detachedProjectError.value = t('oneShots.detachedNoPrimary');
    return;
  }
  if (rejectedDetachedIdentity && sameOneShotMutationIdentity(identity, rejectedDetachedIdentity)) return;
  const currentIdentity = detachedProjectIdentity.value;
  if (currentIdentity?.ownerSessionId === identity.ownerSessionId
    && currentIdentity.projectPath === identity.projectPath
    && identity.projectEpoch < currentIdentity.projectEpoch) return;
  enforceOneShotDisarmFences(
    projectData,
    projectData.cartOnlyItems ?? [],
    detachedDisarmFences.value,
  );
  detachedProjectIdentity.value = identity;
  detachedProjectError.value = '';
  clearCartOnlyItems();
  if (Array.isArray(projectData.cartOnlyItems)) {
    for (const item of projectData.cartOnlyItems) addCartOnlyItem(item);
  }
  currentProject.value = projectData;
  if (projectData.theme?.mode) theme.value = projectData.theme.mode;
  if (projectData.theme?.accentColor) {
    document.documentElement.style.setProperty('--color-accent-custom', displayAccent(projectData.theme.accentColor));
  }
}

let oneShotMutationTail = Promise.resolve();
const handleOneShotMutationRequest = (request: OneShotMutationRequest): void => {
  const api = window.electronAPI;
  const run = async () => {
    const identity = projectSyncIdentity.value;
    let result: OneShotMutationResult = {
      requestId: request.requestId,
      identity: request.identity,
      accepted: false,
      persisted: false,
      error: t('oneShots.detachedStale'),
    };
    if (!identity || !sameOneShotMutationIdentity(identity, request.identity) || !currentProject.value) {
      api.completeOneShotMutation(result);
      return;
    }
    const applied = applyOneShotMutation({ project: currentProject.value, cartOnlyItems: cartOnlyItems.value }, request);
    if (!applied.accepted) {
      result = { ...result, error: applied.error ?? t('oneShots.detachedRejected') };
      api.completeOneShotMutation(result);
      return;
    }
    const shouldPersist = autoSaveEnabled.value;
    const saved = await saveProject();
    if (!sameOneShotMutationIdentity(projectSyncIdentity.value, identity)) {
      api.completeOneShotMutation(result);
      return;
    }
    result = {
      requestId: request.requestId,
      identity,
      accepted: true,
      persisted: shouldPersist && saved,
      ...shouldPersist && !saved ? { error: t('oneShots.detachedSaveFailed') } : {},
    };
    api.completeOneShotMutation(result);
  };
  oneShotMutationTail = oneShotMutationTail.then(run, run);
};

// Listen to menu events
onMounted(() => {
  if (import.meta.client && window.electronAPI) {
    // The video output window renders passively and dies with the app: no
    // menu, file-association, or quit-flow listeners belong here.
    if (isVideoOutputWindow) return;

    // Mouse-activated controls must not keep focus: a focused button treats
    // Space/Enter as "click me again", which hijacks the global transport
    // shortcuts after any mouse click. Keyboard activation has detail === 0
    // and is left alone, so Tab+Space navigation still works.
    window.addEventListener('click', (e: MouseEvent) => {
      if (e.detail === 0) return;
      const el = (e.target as HTMLElement | null)?.closest?.('button, [role="button"], a[href], summary') as HTMLElement | null;
      if (el && typeof el.blur === 'function') el.blur();
    }, true);

    // Cart window initialisation: load project data then listen for updates
    if (isCartWindow) {
      window.electronAPI.getCartWindowProjectData().then((projectData: any) => {
        applyCartWindowProjectData(projectData);
      });
      window.electronAPI.onCartWindowProjectUpdate((projectData) => {
        applyCartWindowProjectData(projectData);
      });
      // Apply locale from localStorage (already handled by useLocalization)
      return; // skip main-window-only event listeners below
    }
    window.electronAPI.onOneShotMutationRequest?.(handleOneShotMutationRequest);

    // When the frameless Video Output owns keyboard focus (most visibly on
    // Windows), main forwards app shortcuts here. Re-dispatching one marked
    // event keeps every existing shortcut binding on the control renderer.
    window.electronAPI.videoOutput?.onShortcut?.((shortcut) => {
      const event = new KeyboardEvent('keydown', {
        key: shortcut.key,
        code: shortcut.code,
        ctrlKey: shortcut.ctrlKey,
        shiftKey: shortcut.shiftKey,
        altKey: shortcut.altKey,
        metaKey: shortcut.metaKey,
        repeat: shortcut.repeat,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, 'dwcueForwardedFromVideoOutput', { value: true });
      window.dispatchEvent(event);
    });

    // Main pushes this when the window is about to close; we run the
    // quit-confirmation dialogs then call confirmQuit to actually quit.
    (window as any).electronAPI.app?.onRequestQuit?.(() => { void runQuitFlow(); });

    window.electronAPI.onMenuToggleDarkMode(() => {
      theme.value = theme.value === 'dark' ? 'light' : 'dark';
      if (currentProject.value) {
        currentProject.value.theme.mode = theme.value as 'dark' | 'light';
        saveProject();
      }
    });

    window.electronAPI.onMenuChangeAccentColor(() => {
      showColorPicker.value = true;
    });

    window.electronAPI.onMenuChangeLanguage((event: any, locale: string) => {
      setLocale(locale);
    });
    
    window.electronAPI.onMenuShowAbout(() => {
      showAboutModal.value = true;
    });

    window.electronAPI.onMenuNewProject(() => {
      if (currentProject.value) showNewProjectDialog(currentProject.value.folderPath);
      else welcomeScreen.value?.handleNewProject();
    });
    window.electronAPI.onMenuOpenProject(() => {
      if (currentProject.value) showOpenProjectPicker(currentProject.value.folderPath);
      else welcomeScreen.value?.handleOpenProject();
    });
    window.electronAPI.onMenuOpenRecentProject((_event, path) => {
      if (!projectFileDialogOpen.value && (currentProject.value || welcomeScreen.value?.projectPickerReady)) {
        return guardedOpenProject(path);
      }
    });
    
    // File > Import Project. Local servers can browse a .dwcuepack directly.
    // Remote servers can browse their filesystem or
    // upload an archive selected on this computer. Extraction always happens
    // beside the server's audio engine so imported media paths resolve.
    window.electronAPI.onMenuImportProject(() => {
      startImportFlow();
    });

    // Update flow. The modal is deferred while Show Mode is active — never
    // interrupt a running show — and shown as soon as the operator exits
    // back to edit mode. A check that finds nothing (manual Help-menu check)
    // gets a transient "up to date" toast instead of silence.
    interface UpdateAvailableInfo {
      currentVersion: string;
      newVersion: string;
      releaseNotes?: string;
      releaseDate?: string;
    }
    let pendingUpdateInfo: UpdateAvailableInfo | null = null;
    const presentUpdateInfo = () => {
      if (uiMode.value === 'playback') return; // defer during a show
      if (!pendingUpdateInfo) return;
      updateInfo.value = {
        currentVersion: pendingUpdateInfo.currentVersion,
        newVersion: pendingUpdateInfo.newVersion,
        releaseNotes: pendingUpdateInfo.releaseNotes ?? '',
        releaseDate: pendingUpdateInfo.releaseDate ?? '',
      };
      pendingUpdateInfo = null;
      showUpdateModal.value = true;
    };
    window.electronAPI.onUpdateAvailable((_event, info) => {
      pendingUpdateInfo = info;
      presentUpdateInfo();
    });
    watch(uiMode, (mode) => {
      if (mode !== 'playback') presentUpdateInfo();
    });
    window.electronAPI.onUpdateUpToDate((_event, info) => {
      upToDateToast.value = t('update.upToDate', { version: info.version });
      if (upToDateToastTimer) clearTimeout(upToDateToastTimer);
      upToDateToastTimer = window.setTimeout(() => { upToDateToast.value = ''; }, 4000);
    });
    window.electronAPI.onMenuCheckForUpdates(() => {
      void window.electronAPI.checkForUpdates();
    });
    
    // Cold and warm file associations share the same native format routing.
    window.electronAPI.onOpenFileAssociation((_event: any, data: { filePath: string; kind: ProjectFileKind }) => {
      void routePendingFile(data);
    });
    window.electronAPI.getPendingOpenFile?.().then((pending) => {
      if (pending?.filePath) void routePendingFile(pending);
    }).catch(() => { /* no pending file */ });

    // Sync menu with current UI language on startup
    window.electronAPI.updateMenuLanguage(currentLocale.value);
  }
});

// ---------------------------------------------------------------------------
// App-quit confirmation flow.
// Main vetoes the window close and pushes `app:request-quit`; we run a
// two-step dialog sequence then call confirmQuit (which actually quits):
//   1. Unsaved-changes prompt — only when there are pending edits. The user
//      can save-then-close, close & discard, or return to the project.
//   2. Local-server prompt — only when the audio server is running locally
//      on this machine (we manage it). The user can close the server too
//      (stops playback + disconnects other clients), close just the client,
//      or return to the project.
// Either prompt's "return" aborts the quit entirely.
// ---------------------------------------------------------------------------
const quitServerVisible  = ref(false);
let _quitServerResolve:  ((choice: 'server'  | 'client' | 'cancel') => void) | null = null;
let quitFlowActive = false;

const quitUnsavedButtons = computed(() => [
  { key: 'cancel',  label: t('quitModal.return'),           variant: 'ghost'   as const },
  { key: 'discard', label: t('quitModal.unsavedDiscard'),   variant: 'danger'  as const },
  { key: 'save',    label: t('quitModal.unsavedSaveClose'), variant: 'primary' as const, icon: 'save' },
]);
const quitServerButtons = computed(() => [
  { key: 'cancel', label: t('quitModal.return'),            variant: 'ghost'  as const },
  { key: 'client', label: t('quitModal.serverCloseClient'), variant: undefined },
  { key: 'server', label: t('quitModal.serverCloseServer'), variant: 'danger' as const, icon: 'power_settings_new' },
]);

function onQuitUnsavedPick(choice: string) {
  if (choice === 'save') void unsavedSave();
  else if (choice === 'discard') void unsavedDiscard();
  else void unsavedCancel();
}
function onQuitServerPick(choice: string)  { _quitServerResolve?.(choice as 'server' | 'client' | 'cancel'); }

function askQuitServer(): Promise<'server' | 'client' | 'cancel'> {
  quitServerVisible.value = true;
  return new Promise((resolve) => {
    _quitServerResolve = (choice) => {
      quitServerVisible.value = false;
      _quitServerResolve = null;
      resolve(choice);
    };
  });
}

async function runQuitFlow() {
  if (quitFlowActive) return;
  quitFlowActive = true;
  const api = (window as any).electronAPI;
  try {
    // Step 1 — unsaved changes (including a failed autosave).
    if (!await confirmUnsavedChanges('quit')) return;
    if (installOnExitRequested) {
      const accepted = await api?.app?.confirmQuit?.({
        installUpdate: true,
        runAfterInstall: false,
      });
      if (accepted) installOnExitRequested = false;
      return;
    }


    // Step 2 — local audio server (only when we manage one that's running).
    let serverIsLocal = false;
    try {
      const status = await api?.liveplayServer?.getStatus?.();
      serverIsLocal = !!status && status.config?.mode === 'local' && !!status.running;
    } catch (e) {
      console.warn('[quit] could not read server status:', e);
    }

    if (serverIsLocal) {
      const choice = await askQuitServer();
      if (choice === 'cancel') return;
      await api?.app?.confirmQuit?.({ stopServer: choice === 'server' });
    } else {
      await api?.app?.confirmQuit?.({ stopServer: false });
    }
  } finally {
    quitFlowActive = false;
  }
}
// An update install is a quit action too: run the same unsaved-changes guard
// before handing control to electron-updater. A failed forced save aborts.
async function handleUpdateInstall() {
  if (!import.meta.client || !window.electronAPI) return;
  if (!(await confirmUnsavedChanges())) return;
  const accepted = await window.electronAPI.installUpdate();
  if (!accepted) {
    console.warn('[update] install request was not accepted');
  }
}

const handleUpdateInstallOnExit = () => {
  installOnExitRequested = true;
  showUpdateModal.value = false;
};


const changeAccentColor = (color: string) => {
  if (currentProject.value) {
    currentProject.value.theme.accentColor = color;
    document.documentElement.style.setProperty('--color-accent-custom', color);
    saveProject();
    showColorPicker.value = false;
  }
};

// ---------------------------------------------------------------------------
// Import project flow (dual-dialog when client and server are on different
// machines). Extraction happens server-side beside the audio engine.
// ---------------------------------------------------------------------------
const importChoiceVisible       = ref(false);
const importServerPickerOpen    = ref(false);
const importServerPickerStage   = ref<'archive' | 'destination'>('archive');
const pendingArchiveOnServer    = ref('');
const pendingArchiveClientPath  = ref('');
const pendingArchiveName        = ref('');

let importFlowActive = false;
async function startImportFlow() {
  if (importFlowActive) return;
  importFlowActive = true;
  try {
    if (!(await confirmUnsavedChanges())) return;
    const server = useLiveplayServer();
    importServerPickerStage.value = 'archive';
    if (server.isLocalServer) importServerPickerOpen.value = true;
    else importChoiceVisible.value = true;
  } finally {
    importFlowActive = false;
  }
}

async function onImportChoice(choice: 'server' | 'client') {
  importChoiceVisible.value = false;
  if (choice === 'server') {
    importServerPickerStage.value = 'archive';
    importServerPickerOpen.value = true;
    return;
  }
  const project = currentProject.value;
  const server = useLiveplayServer();
  const serverUrl = server.serverUrl;
  const archivePath = await window.electronAPI.showOpenArchiveDialog();
  if (!archivePath || currentProject.value !== project || server.serverUrl !== serverUrl) return;
  pendingArchiveClientPath.value = archivePath;
  pendingArchiveName.value = archivePath.split(/[\/]/).pop() || 'import.dwcuepack';
  importServerPickerStage.value = 'destination';
  importServerPickerOpen.value = true;
}

async function onImportServerPickerPick(serverPath: string) {
  importServerPickerOpen.value = false;
  if (!serverPath) return;
  const server = useLiveplayServer();
  if (importServerPickerStage.value === 'archive') {
    if (projectFileAction(serverPath) !== 'import-archive') {
      server.lastError = t('importProgress.openFailed');
      return;
    }
    pendingArchiveOnServer.value = serverPath;
    importServerPickerStage.value = 'destination';
    importServerPickerOpen.value = true;
    return;
  }

  progressModal.value = {
    visible: true,
    title: t('importProgress.title'),
    message: t('importProgress.message') + ' ' + (pendingArchiveName.value
      || pendingArchiveOnServer.value.split(/[\/]/).pop() || '') + '…',
    percentage: 40,
  };
  try {
    const result = pendingArchiveClientPath.value
      ? server.isLocalServer
        ? await server.importProjectArchiveFromServer(pendingArchiveClientPath.value, serverPath)
        : await server.importProjectArchiveFromClientPath(
            pendingArchiveClientPath.value, serverPath, pendingArchiveName.value)
      : await server.importProjectArchiveFromServer(pendingArchiveOnServer.value, serverPath);
    progressModal.value.percentage = 100;
    if (result.projectFiles.length === 0) {
      server.lastError = t('importProgress.openFailed');
      return;
    }
    if (result.projectFiles.length > 1) {
      availableProjects.value = result.projectFiles;
      pendingImportPath.value = result.extractPath;
      showProjectSelection.value = true;
    } else {
      await guardedOpenProject(result.extractPath + '/' + result.projectFiles[0]);
    }
  } catch (error) {
    console.error('Import failed:', error);
    server.lastError = t('importProgress.openFailed');
  } finally {
    window.setTimeout(() => { progressModal.value.visible = false; }, 300);
    pendingArchiveOnServer.value = '';
    pendingArchiveClientPath.value = '';
    pendingArchiveName.value = '';
  }
}

const handleProjectSelection = async (projectName: string) => {
  const projectPath = pendingImportPath.value + '/' + projectName;
  if (!await guardedOpenProject(projectPath)) return;
  showProjectSelection.value = false;
  pendingImportPath.value = '';
  availableProjects.value = [];
};

const handleProjectSelectionCancel = () => {
  showProjectSelection.value = false;
  pendingImportPath.value = '';
  availableProjects.value = [];
};

// Set initial theme from project
watch(currentProject, (project) => {
  if (project) {
    theme.value = project.theme.mode;
    
    // Set accent color
    if (import.meta.client && project.theme.accentColor) {
      document.documentElement.style.setProperty('--color-accent-custom', displayAccent(project.theme.accentColor));
    }
  } else if (import.meta.client) {
    document.documentElement.style.removeProperty('--color-accent-custom');
  }
}, { immediate: true });

// Apply RTL direction when locale changes
watch(currentLocale, () => {
  if (import.meta.client) {
    const direction = getDirection();
    document.documentElement.setAttribute('dir', direction);
  }
}, { immediate: true });

// Enable drag-and-drop globally.
// Chromium requires preventDefault() on EVERY dragover event (including on
// intermediate elements) for the drop event to fire. Using capture phase
// ensures this runs before any component handlers.
onMounted(() => {
  if (import.meta.client) {
    document.addEventListener('dragenter', (e) => {
      e.preventDefault();
    }, true);
    document.addEventListener('dragover', (e) => {
      e.preventDefault();
    }, true);
  }
});
</script>

<style scoped>
#app {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.color-picker-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-modal);
}

.color-picker-dialog {
  background: var(--color-surface);
  padding: var(--spacing-xl);
  border-radius: var(--border-radius-lg);
  min-width: 400px;
  color: var(--color-text-primary);
}

.color-picker-dialog h3 {
  margin-bottom: var(--spacing-md);
  color: var(--color-text-primary);
}

.color-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-md);
}

.color-option {
  width: 50px;
  height: 50px;
  border: 2px solid var(--color-border);
  border-radius: var(--border-radius-sm);
  cursor: pointer;
  transition: transform var(--transition-fast);
}

.color-option:hover {
  transform: scale(1.1);
  border-color: var(--color-text-primary);
}

.update-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  padding: var(--spacing-sm) var(--spacing-lg);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-lg);
  color: var(--color-text-primary);
  z-index: var(--z-modal);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
}

.update-toast-enter-active,
.update-toast-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.update-toast-enter-from,
.update-toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}

.close-dialog {
  width: 100%;
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-background);
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-sm);
  color: var(--color-text-primary);
}

.close-dialog:hover {
  background: var(--color-surface-hover);
}


.project-hydration-error {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-lg);
  color: var(--color-text-primary);
  text-align: center;
}

.project-hydration-error span {
  max-width: 48rem;
  color: var(--color-text-secondary);
}

.project-hydration-error button {
  padding: var(--spacing-xs) var(--spacing-md);
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-sm);
  background: var(--color-surface);
  color: var(--color-text-primary);
}
.cart-window-root {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: var(--color-background);

  :deep(.one-shot-panel) {
    flex: 1;
    min-height: 0;
  }
}

.cart-window-brand {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--color-border);
}

.cart-brand-logo {
  width: 20px;
  height: 20px;
  object-fit: contain;
}

.cart-brand-wordmark {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.16em;
  color: var(--color-text-secondary);
}

.cart-brand-url {
  margin-left: auto;
  font-size: 10px;
  color: var(--color-text-secondary);
  opacity: 0.7;
}

.cart-window-error {
  flex: none;
  margin: 0;
  padding: 6px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-danger) 45%, var(--color-border));
  background: color-mix(in srgb, var(--color-danger) 10%, var(--color-background));
  color: var(--color-danger);
  font-size: 12px;
}

.cart-window-loading {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--color-background);
  color: var(--color-text-secondary);

  :deep(.cue-symbol) {
    font-size: 48px;
    opacity: 0.3;
  }
}
</style>

<style>
/* New Show form is teleported to body. */
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
