<template>
  <div id="app" :data-theme="theme" :class="{ 'operator-window': !isVideoOutputWindow && !isCartWindow }"
    :style="isVideoOutputWindow ? undefined : { zoom: uiFontScale / 100 }">
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
          <div id="cart-header-warnings" class="cart-header-warnings"></div>
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
      <div v-if="!hasWorkspace" class="startup-workspace">
        <div id="startup-header-warnings" class="startup-header-warnings"></div>
        <WelcomeScreen
          v-if="!currentProject"
          ref="welcomeScreen"
          :open-project="guardedOpenProject"
          :project-file-dialog-open="projectFileDialogOpen"
          @new-project="showNewProjectDialog"
          @open-project="showOpenProjectPicker"
          @open-about="openAbout"
        />
        <div v-else class="project-hydration-error" role="alert">
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
      </div>
      <MainWorkspace v-else />
      <Teleport v-if="archivePanel" :key="hasWorkspace ? 'workspace' : 'startup'"
        defer to="#workspace-import-host" :disabled="!hasWorkspace">
        <section class="archive-panel"
          :class="{ 'archive-panel--startup': !hasWorkspace, 'archive-panel--browse': !archiveStatus }"
          :aria-label="archiveTitle">
          <header v-if="!hasWorkspace" class="workspace-panel-header">
            <h2 class="workspace-panel-header__title">{{ archiveTitle }}</h2>
            <Btn type="button" :text="t('actions.close')" @click="workspaceImportPanel = null" />
          </header>
          <template v-if="archiveStatus">
            <div class="archive-row">
              <p :role="archiveStatus.phase === 'failed' ? 'alert' : 'status'"
                :class="{ 'archive-error': archiveStatus.phase === 'failed' }">{{ archiveStatus.message }}</p>
              <div class="archive-actions">
                <Btn v-for="file in (archivePanel === 'archive-import' ? archiveReceipt?.projectFiles : [])" :key="file"
                  type="button" :text="archiveReceipt?.projectFiles.length === 1 ? t('selectProject.open') : file" :title="file"
                  :disabled="archiveOpening || !archiveCanOpen" @click="openImportedArchive(file)" />
                <Btn v-if="archiveStatus.phase !== 'working'" type="button"
                  :text="t(archiveStatus.phase === 'failed' ? 'archive.retry' : 'archive.another')"
                  :disabled="archiveOpening" @click="resetArchivePanel" />
              </div>
            </div>
            <progress v-if="archiveStatus.phase === 'working'" class="archive-progress" :aria-label="archiveTitle" />
          </template>
          <template v-else>
            <div class="archive-row">
              <p :title="archivePickerCaption">{{ archivePickerCaption }}</p>
            </div>
            <ServerFilePickerModal v-if="server.connected" :key="archivePanel" docked :open="true" :mode="archiveChoosingSource ? 'file' : 'directory'"
              :filter="archiveChoosingSource ? '.dwcuepack' : 'all'"
              :filter-options="archiveChoosingSource ? ['.dwcuepack'] : ['all']"
              :fallback-start-path="currentProject?.folderPath ?? ''"
              :location-context="archiveChoosingSource ? 'archive-import' : archivePanel === 'archive-import' ? 'archive-import-destination' : 'archive-export'"
              :cancel-label="t(archivePanel === 'archive-import' && importArchiveSource ? 'common.back' : 'common.cancel')"
              :confirm-label="t(archiveChoosingSource ? 'archive.chooseArchive' : archivePanel === 'archive-import' ? 'archive.extractHere' : 'archive.saveHere')"
              @pick="onArchivePickerPick" @close="cancelArchivePicker">
              <template #actions>
                <Btn v-if="!server.isLocalServer && (archivePanel === 'archive-export' || archiveChoosingSource)" type="button"
                  :text="t(archivePanel === 'archive-export' ? 'exportProject.downloadHere' : 'importProject.fromThisComputer')"
                  :disabled="nativeArchivePickerOpen" @click="browseControllerArchive" />
              </template>
            </ServerFilePickerModal>
            <p v-else class="archive-row" role="status">{{ t('archive.waitingForEngine') }}</p>
          </template>
        </section>
      </Teleport>
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
      <div v-if="showNewShowDialog && !(creatingNewShow && isLoading)" class="name-dialog-backdrop" :data-theme="theme" @click.self="cancelNewShowDialog">
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
          <p v-if="newShowError" class="new-show-error" role="alert">{{ newShowError }}</p>
          <div class="name-dialog__actions">
            <button type="button" class="name-dialog__btn" :disabled="creatingNewShow" @click="cancelNewShowDialog">{{ t('common.cancel') }}</button>
            <button type="submit" class="name-dialog__btn name-dialog__btn--primary" :disabled="!canCreateNewShow || creatingNewShow">{{ t('project.createShow') }}</button>
          </div>
        </form>
      </div>
    </Teleport>

    <!-- Loading overlay (project open / create / save) -->
    <LoadingOverlay :visible="isLoading" :title="loadingMessage" />

    <ProjectRepairNotice v-if="projectRepair" :notice="projectRepair" @save="saveRepairedProject" />

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

    </template>
    <ServerAlert v-if="!isVideoOutputWindow" :target="isCartWindow ? '#cart-header-warnings'
      : currentProject && projectHydrationStatus !== 'failed' ? '#project-header-warnings'
        : '#startup-header-warnings'" />
  </div>
</template>

<script setup lang="ts">
import 'material-symbols/rounded.css';
import OneShotPanel from './components/OneShotPanel.vue';
import WelcomeScreen from './components/WelcomeScreen.vue';
import type { ProjectFileKind } from '~/utils/projectFileFormats';
import { PROJECT_FILE_EXTENSIONS, projectFileAction } from '~/utils/projectFileFormats';
import type { OneShotMutationIdentity, OneShotMutationRequest, OneShotMutationResult, OneShotProjectEnvelope } from '~/types/oneShotMutation';
import { sameOneShotMutationIdentity } from '~/types/oneShotMutation';
import { createProjectOpenGuard } from '~/utils/projectOpenGuard';
import { runExclusivePendingAction } from '~/utils/acknowledgedAction';
import { applyOneShotMutation } from '~/utils/oneShotMutation';

const {
  currentProject, projectEpoch, saveProject, createNewProject, openProject, confirmUnsavedChanges, workspaceImportPanel,
  autoSaveEnabled, projectSyncIdentity,
  projectHydrationStatus, projectHydrationError, retryProjectHydration,
  isLoading, loadingMessage,
  projectRepair, saveRepairedProject,
  unsavedDialogVisible, unsavedDialogReason, unsavedDialogBlocked, unsavedSave, unsavedDiscard, unsavedCancel,
  deleteDialogVisible, deleteDialogCount, deleteDialogName, deleteDialogAllowOnly,
  deleteDialogConfirmAll, deleteDialogConfirmOnly, deleteDialogCancel,
} = useProject();
const { stopAllCues } = useAudioEngine();
const { cartOnlyItems, clearCartOnlyItems, addCartOnlyItem } = useCartItems();
import LoadingOverlay from './components/LoadingOverlay.vue';
import AudioLoadProgress from './components/AudioLoadProgress.vue';
import ServerFilePickerModal from './components/ServerFilePickerModal.vue';
const { currentLocale, setLocale, getDirection, t } = useLocalization();
const server = useLiveplayServer();
const hasWorkspace = computed(() => !!currentProject.value && projectHydrationStatus.value !== 'failed');
const { showHeaderWarning } = useHeaderWarnings();
let stopHeaderWarnings: (() => void) | undefined;
onMounted(() => {
  if (isCartWindow || isVideoOutputWindow) return;
  stopHeaderWarnings = window.electronAPI?.onHeaderWarning?.((message) => showHeaderWarning(message, 'urgent'));
});
onBeforeUnmount(() => stopHeaderWarnings?.());
watch(() => unsavedDialogBlocked.value && !unsavedDialogVisible.value, (waiting) => {
  if (waiting) showHeaderWarning(t('unsavedModal.waitForSave'));
});

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
const guardedOpenProject = (path: string, canOpen?: () => boolean) => {
  if (projectFileAction(path) !== 'open-project') {
    useLiveplayServer().lastError = t('project.openFailed', { path });
    return Promise.resolve(false);
  }
  return runExclusivePendingAction('project-file-change', `open:${path}`, () => openProjectGuard(path, canOpen));
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
const newShowError = ref<string | null>(null);
const canCreateNewShow = computed(() => !!newShowName.value.trim() && !!newShowLocation.value.trim());

function showNewProjectDialog(fallbackFolder: string) {
  if (projectFileDialogOpen.value || isLoading.value || unsavedDialogVisible.value) return;
  projectPickerFallback.value = fallbackFolder;
  newShowName.value = '';
  newShowError.value = null;
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
  newShowError.value = null;
  try {
    const created = await runExclusivePendingAction('project-file-change', 'create', async () => {
      if (!await confirmUnsavedChanges()) return false;
      const server = useLiveplayServer();
      server.clearLastError();
      const ok = await createNewProject(name, folder);
      if (!ok) newShowError.value = server.lastError ?? t('project.createFailed');
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
      if (importArchiveStatus.value?.phase === 'working' || archiveOpening.value) return;
      importArchiveStatus.value = null;
      archiveReceipt.value = null;
      importArchiveSource.value = { path: data.filePath, client: true };
      openArchivePanel('archive-import');
    }
  } finally {
    activeFileRoute = '';
  }
}

const theme = useState('theme', () => 'dark');
// Global interface text scale (Settings → Interface font size). The app's
// styles are px-based, so the lever is `zoom` on the root — it scales text
// and chrome uniformly without touching hundreds of px rules.
const { uiFontScale } = useUiMode();

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

// Color picker for accent color
const showColorPicker = ref(false);
const DEFAULT_ACCENT = '#315fcf';
const retiredBrandAccents = new Set(['#a45d00', '#8f5000', '#c47a00', '#ffb000']);
const displayAccent = (color?: string) =>
  color && !retiredBrandAccents.has(color.toLowerCase()) ? color : DEFAULT_ACCENT;

// About modal
const showAboutModal = ref(false);

const { update, checkForAppUpdate } = useAppUpdate();
let announcedUpdate = '';
watch(() => [update.version, t('update.headerAvailable', { version: update.version })] as const, ([version, message]) => {
  if (!version || version === announcedUpdate || message === 'update.headerAvailable') return;
  announcedUpdate = version;
  showHeaderWarning(message, 'advisory', 5);
});
const showProjectSettings = useState('showProjectSettings', () => false);
const settingsTab = useState('projectSettingsTab', () => 'audio');

function openAbout() {
  if (currentProject.value && projectHydrationStatus.value !== 'failed') {
    settingsTab.value = 'about';
    showProjectSettings.value = true;
  } else {
    showAboutModal.value = true;
  }
}

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
      if (e.detail === 0 || (e.target as HTMLElement | null)?.closest?.('.binding-button')) return;
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
    
    window.electronAPI.onMenuShowAbout(openAbout);

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
    
    window.electronAPI.onMenuImportProject(() => openArchivePanel('archive-import'));
    window.electronAPI.onMenuExportProject(() => {
      if (currentProject.value) openArchivePanel('archive-export');
    });

    const api = window.electronAPI;
    void api.getUpdateInstallSupported?.().then(supported => { update.installSupported = supported; }).catch(() => {});
    api.onUpdateAvailable?.((_event, info) => {
      if (update.version === info.newVersion || update.downloading || update.downloaded) return;
      update.version = info.newVersion;
      update.downloaded = false;
      update.installOnExit = false;
      update.error = '';
    });
    api.onUpdateUpToDate?.((_event, info) => {
      if (!update.downloading && !update.downloaded) update.version = '';
      showHeaderWarning(t('update.upToDate', { version: info.version }));
    });
    api.onUpdateDownloadProgress?.((_event, progress) => { update.percent = progress.percent; });
    api.onUpdateDownloaded?.((_event, info) => {
      if (info.version === update.version) update.downloaded = true;
    });
    api.onUpdateError?.((_event, error) => {
      if (update.checking || update.downloading || update.downloaded) update.error = error;
    });
    api.onMenuCheckForUpdates?.(() => { void checkForAppUpdate(); });
    // Register the listeners before asking Electron to check the release feed.
    void api.checkForUpdates?.(true).catch(() => {});

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
    if (update.installOnExit) {
      const accepted = await api?.app?.confirmQuit?.({
        installUpdate: true,
        runAfterInstall: false,
      });
      if (accepted) update.installOnExit = false;
      else showHeaderWarning(t('update.installFailed'), 'urgent');
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
const changeAccentColor = (color: string) => {
  if (currentProject.value) {
    currentProject.value.theme.accentColor = color;
    document.documentElement.style.setProperty('--color-accent-custom', color);
    saveProject();
    showColorPicker.value = false;
  }
};

type ArchivePanel = 'archive-import' | 'archive-export';
type ArchiveStatus = { phase: 'working' | 'done' | 'failed'; message: string };

const importArchiveStatus = ref<ArchiveStatus | null>(null);
const exportArchiveStatus = ref<ArchiveStatus | null>(null);
const importArchiveSource = shallowRef<{ path: string; client: boolean } | null>(null);
const archiveReceipt = shallowRef<{
  serverUrl: string; accessToken: string; extractPath: string; projectFiles: string[];
} | null>(null);
const archiveOpening = ref(false);
const nativeArchivePickerOpen = ref(false);
const archivePanel = computed(() => {
  const panel = workspaceImportPanel.value;
  return panel === 'archive-import' || panel === 'archive-export' ? panel : null;
});
const archiveTitle = computed(() => t(archivePanel.value === 'archive-export'
  ? 'exportProject.chooseLocationTitle' : 'importProject.chooseSourceTitle'));
const archiveStatus = computed(() => archivePanel.value === 'archive-export'
  ? exportArchiveStatus.value : importArchiveStatus.value);
const archiveCanOpen = computed(() => !!archiveReceipt.value && server.connected && !server.cueStartsBlocked &&
  archiveReceipt.value.serverUrl === server.serverUrl && archiveReceipt.value.accessToken === server.effectiveAccessToken);
const archiveChoosingSource = computed(() => archivePanel.value === 'archive-import' && !importArchiveSource.value);
const archiveFilename = (path: string) => path.split(/[\\/]/).pop() || '';
const exportArchiveName = computed(() => (currentProject.value?.name || 'Project') + PROJECT_FILE_EXTENSIONS.nativeArchive);
const archivePickerCaption = computed(() => {
  if (archiveChoosingSource.value) return t('archive.chooseSource');
  if (archivePanel.value === 'archive-export') return t('archive.exportDestination', { name: exportArchiveName.value });
  return t('archive.importDestination', { name: archiveFilename(importArchiveSource.value?.path ?? '') });
});

let archivePickerRevision = 0;
watch([workspaceImportPanel, showProjectSettings, projectEpoch,
  () => server.serverUrl, () => server.effectiveAccessToken, () => server.projectSessionId], () => {
  archivePickerRevision++;
}, { flush: 'sync' });
watch([() => server.serverUrl, () => server.effectiveAccessToken], () => {
  if (!importArchiveSource.value?.client) importArchiveSource.value = null;
}, { flush: 'sync' });

function openArchivePanel(panel: ArchivePanel) {
  showProjectSettings.value = false;
  workspaceImportPanel.value = panel;
}

function resetArchivePanel() {
  if (archivePanel.value === 'archive-export') exportArchiveStatus.value = null;
  else {
    if (importArchiveStatus.value?.phase === 'done') importArchiveSource.value = null;
    importArchiveStatus.value = null;
    archiveReceipt.value = null;
  }
}

function cancelArchivePicker() {
  if (archivePanel.value === 'archive-import' && importArchiveSource.value) importArchiveSource.value = null;
  else workspaceImportPanel.value = null;
}

function showArchiveFailure(panel: ArchivePanel, error: unknown) {
  const status = panel === 'archive-export' ? exportArchiveStatus : importArchiveStatus;
  const message = t(panel === 'archive-export' ? 'archive.exportFailed' : 'archive.importFailed', {
    error: error instanceof Error ? error.message : String(error),
  });
  status.value = { phase: 'failed', message };
  showHeaderWarning(message, 'urgent');
}

async function browseControllerArchive() {
  const panel = archivePanel.value;
  if (!panel || nativeArchivePickerOpen.value || archiveStatus.value) return;
  const revision = archivePickerRevision;
  const source = importArchiveSource.value;
  const isCurrent = () => archivePickerRevision === revision && !archiveStatus.value &&
    (panel === 'archive-export' || importArchiveSource.value === source);
  nativeArchivePickerOpen.value = true;
  let path: string | null;
  try {
    const api = window.electronAPI;
    path = panel === 'archive-export'
      ? await api.showSaveArchiveDialog(exportArchiveName.value)
      : await api.showOpenArchiveDialog();
  } catch (error) {
    if (isCurrent()) showArchiveFailure(panel, error);
    return;
  } finally {
    nativeArchivePickerOpen.value = false;
  }
  if (!path || !isCurrent()) return;
  if (panel === 'archive-export') await runExport({ outputPath: '', downloadTo: path });
  else importArchiveSource.value = { path, client: true };
}

async function onArchivePickerPick(path: string) {
  const panel = archivePanel.value;
  if (!path || !panel || archiveStatus.value) return;
  if (panel === 'archive-export') {
    await runExport({ outputPath: path.replace(/[\\/]+$/, '') + '/' + exportArchiveName.value });
  } else if (archiveChoosingSource.value) {
    if (projectFileAction(path) !== 'import-archive') {
      showArchiveFailure(panel, t('archive.unsupported'));
      return;
    }
    importArchiveSource.value = { path, client: false };
  } else if (importArchiveSource.value) {
    await runImport(importArchiveSource.value, path);
  }
}

async function runExport(opts: { outputPath: string; downloadTo?: string }) {
  const project = currentProject.value;
  if (!project || exportArchiveStatus.value) return;
  const serverUrl = server.serverUrl;
  const accessToken = server.effectiveAccessToken;
  const session = server.projectSessionId;
  const sameServer = () => server.serverUrl === serverUrl && server.effectiveAccessToken === accessToken;
  const name = exportArchiveName.value;
  exportArchiveStatus.value = { phase: 'working', message: t('archive.savingShow') };
  try {
    if (!await saveProject({ force: true })) throw new Error(t('archive.saveFailed'));
    if (currentProject.value !== project || !sameServer() || server.projectSessionId !== session) {
      throw new Error(t('archive.showChanged'));
    }
    exportArchiveStatus.value.message = t('exportProgress.message') + ' ' + name + '…';
    const result = await server.exportProjectArchive(project.folderPath, project.name, opts.outputPath, session);
    if (opts.downloadTo) {
      if (!result.downloadToken || !sameServer()) throw new Error(t('archive.downloadUnavailable'));
      exportArchiveStatus.value.message = t('exportProgress.downloading') + ' ' + name + '…';
      await server.downloadArchiveToFile(result.downloadToken, opts.downloadTo);
    }
    exportArchiveStatus.value = {
      phase: 'done', message: t('exportProgress.saved', { path: opts.downloadTo || result.archivePath }),
    };
  } catch (error) {
    showArchiveFailure('archive-export', error);
  }
}

async function runImport(source: { path: string; client: boolean }, destination: string) {
  const serverUrl = server.serverUrl;
  const accessToken = server.effectiveAccessToken;
  const upload = source.client && !server.isLocalServer;
  const name = archiveFilename(source.path);
  importArchiveStatus.value = {
    phase: 'working', message: t(upload ? 'archive.uploading' : 'importProgress.message') + ' ' + name + '…',
  };
  try {
    const result = upload
      ? await server.importProjectArchiveFromClientPath(source.path, destination, name)
      : await server.importProjectArchiveFromServer(source.path, destination);
    if (result.projectFiles.length === 0) throw new Error(t('importProgress.openFailed'));
    archiveReceipt.value = { ...result, serverUrl, accessToken };
    importArchiveStatus.value = {
      phase: 'done', message: t('importProgress.savedOnServer', { path: result.extractPath, server: serverUrl }),
    };
  } catch (error) {
    showArchiveFailure('archive-import', error);
  }
}

async function openImportedArchive(file: string) {
  const receipt = archiveReceipt.value;
  if (archiveOpening.value || !receipt?.projectFiles.includes(file) || !archiveCanOpen.value) return;
  const session = server.projectSessionId;
  const epoch = projectEpoch.value;
  archiveOpening.value = true;
  try {
    const path = receipt.extractPath.replace(/[\\/]+$/, '') + '/' + file;
    if (await guardedOpenProject(path, () => archivePanel.value === 'archive-import' && archiveCanOpen.value && archiveReceipt.value === receipt &&
      server.projectSessionId === session && projectEpoch.value === epoch)) {
      archiveReceipt.value = null;
      importArchiveStatus.value = null;
      importArchiveSource.value = null;
      if (archivePanel.value === 'archive-import') workspaceImportPanel.value = null;
    }
  } finally {
    archiveOpening.value = false;
  }
}

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

.operator-window {
  display: flex;
  flex-direction: column;
}

.startup-workspace {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.archive-panel {
  display: flex;
  flex-direction: column;
  width: min(100%, var(--settings-width));
  padding: 0 var(--workspace-gutter) var(--spacing-xs);
  min-width: 0;
}

.archive-panel--browse {
  flex: 1 1 auto;
  height: clamp(230px, 32vh, 320px);
  min-height: 210px;
}

.archive-panel--startup {
  flex: 0 1 auto;
  padding-top: var(--spacing-xs);
  border-top: 1px solid var(--color-border);
  overflow: auto;
}

.archive-panel--startup .workspace-panel-header {
  padding-inline: 0;
}

.archive-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: 0 0 auto;
  min-height: var(--panel-control-height);
  gap: var(--workspace-gutter);
  margin: 0;
  padding: var(--spacing-xs) 0;
  overflow-wrap: anywhere;

  p { margin: 0; }
}

.archive-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-xs);
  flex-shrink: 0;
}

.archive-error { color: var(--color-danger); }

.archive-progress {
  width: min(24rem, 100%);
  height: 8px;
  margin-block: 0 var(--spacing-sm);
  accent-color: var(--color-accent);
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

.startup-header-warnings {
  position: fixed;
  inset-block-start: var(--spacing-sm);
  inset-inline-start: var(--workspace-gutter);
  max-inline-size: calc(100% - 2 * var(--workspace-gutter));
  z-index: var(--z-dropdown);
}

.cart-header-warnings {
  min-width: 0;
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

.new-show-error {
  margin: 0;
  color: var(--color-text-primary);
  overflow-wrap: anywhere;
}

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
