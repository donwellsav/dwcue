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
          <Btn v-if="detachedRecoveryOpen" class="cart-recovery-stop" data-recovery-panel type="button"
            icon="stop_circle" :text="t('controls.stopAll')" @click="stopAllCues()" @keydown.enter.space.stop />
          <span v-else class="cart-brand-url">dwcue.com</span>
        </header>
        <template v-if="currentProject && detachedProjectIdentity">
          <p v-if="detachedProjectError" class="cart-window-error" role="alert">{{ detachedProjectError }}</p>
          <OneShotPanel :is-detached-window="true" :inert="detachedRecoveryOpen" />
          <DeleteSelectionPanel v-if="!detachedRecoveryOpen" />
        </template>
        <div v-else class="cart-window-loading">
          <CueSymbol name="one-shots" />
          <p v-if="detachedProjectError">{{ detachedProjectError }}</p>
        </div>
        <div v-if="detachedRecoveryOpen" class="cart-recovery-panel" data-recovery-panel>
          <ConnectionLostModal v-if="reconnectPanelOpen" docked :show-stop-all="false" />
          <p v-else class="cart-recovery-wait" role="status">{{ t('oneShots.detachedWaitingForShow') }}</p>
        </div>
      </div>
    </template>

    <!-- Normal mode -->
    <template v-else>
      <div v-if="!hasWorkspace" class="startup-workspace" :inert="recoveryPanelOpen">
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
          <button type="button" :disabled="!!projectLoad" @click="retryProjectHydration">{{ t('projectHydration.retry') }}</button>
          <button type="button" @click="showOpenProjectPicker(currentProject.folderPath)">
            {{ t('projectHydration.chooseAnotherShow') }}
          </button>
        </div>
      </div>
      <MainWorkspace v-else :decision-open="projectPanelOpen" :recovery-open="recoveryPanelOpen" />
      <Teleport v-if="projectPanelOpen" :key="hasWorkspace ? 'decision-dock' : 'decision-startup'"
        defer to="#workspace-project-decision" :disabled="!hasWorkspace">
        <div v-if="recoveryPanelOpen" data-recovery-panel>
          <ConnectionLostModal v-if="reconnectPanelOpen" docked :show-stop-all="!hasWorkspace" />
          <SessionRecoveryModal v-else :show-stop-all="!hasWorkspace" />
        </div>
        <ProjectDecisionPanel v-else-if="projectDecision" :title="projectDecision.title" :message="projectDecision.message"
          :buttons="projectDecision.buttons" @pick="projectDecision.pick" />
        <section v-else class="project-file-panel"
          :class="{ 'project-file-panel--startup': !hasWorkspace, 'project-file-panel--browse': projectPicker && !projectFileBusy }"
          aria-labelledby="project-file-panel-title">
          <header class="workspace-panel-header">
            <h2 id="project-file-panel-title" class="workspace-panel-header__title">
              {{ t(projectLoad === 'open' || projectPicker === 'open' ? 'menu.openProject' : 'project.newShow') }}
            </h2>
            <Btn v-if="!hasWorkspace" type="button" icon="stop_circle" :text="t('controls.stopAll')" @click="stopAllCues()" />
          </header>
          <p v-if="projectFileBusy" class="project-file-status" role="status">{{ projectFileStatus }}</p>
          <ServerFilePickerModal v-else-if="projectPicker" docked :open="true"
            :mode="projectPicker === 'open' ? 'file' : 'directory'"
            :filter="projectPicker === 'open' ? '.dwcue' : 'all'"
            :filter-options="projectPicker === 'open' ? ['.dwcue', 'all'] : ['all']"
            :location-context="projectPicker === 'open' ? 'project-open' : 'project-create'"
            :cancel-label="t(projectPicker === 'open' ? 'common.cancel' : 'common.back')"
            :fallback-start-path="projectPickerFallback"
            @pick="onProjectPickerPick" @close="closeProjectPicker" />
          <form v-else class="new-show-form" @submit.prevent="createNewShow">
            <label class="new-show-field" for="welcome-new-show-name">
              <span>{{ t('project.showName') }}</span>
              <input id="welcome-new-show-name" ref="newShowNameInput" v-model="newShowName"
                :placeholder="t('project.placeholder')" autocomplete="off" />
            </label>
            <div class="new-show-field new-show-field--location">
              <label for="welcome-new-show-location">{{ t('project.location') }}</label>
              <div class="new-show-location">
                <input id="welcome-new-show-location" :value="newShowLocation" readonly />
                <button ref="newShowBrowseButton" type="button" @click="browseNewShowLocation">{{ t('project.chooseLocation') }}</button>
              </div>
            </div>
            <div class="new-show-actions">
              <Btn type="button" :text="t('common.cancel')" @click="cancelNewShowDialog" />
              <Btn type="submit" class="new-show-create" :text="t('project.createShow')" :disabled="!canCreateNewShow" />
            </div>
            <p v-if="newShowError" class="new-show-error" role="alert">{{ newShowError }}</p>
          </form>
        </section>
      </Teleport>
      <section v-if="!hasWorkspace && showStartupAbout && !projectPanelOpen && !archivePanel"
        class="project-file-panel project-file-panel--startup startup-about-panel" aria-labelledby="startup-about-title">
        <header class="workspace-panel-header">
          <h2 id="startup-about-title" class="workspace-panel-header__title">{{ t('settings.tabAbout') }}</h2>
          <Btn type="button" icon="close" :text="t('actions.close')" @click="showStartupAbout = false" />
        </header>
        <div class="startup-about-content">
          <AboutContent />
        </div>
      </section>
      <Teleport v-if="archivePanel" :key="hasWorkspace ? 'workspace' : 'startup'"
        defer to="#workspace-import-host" :disabled="!hasWorkspace">
        <section v-show="hasWorkspace || !projectPanelOpen" class="archive-panel"
          :class="{ 'archive-panel--startup': !hasWorkspace, 'archive-panel--browse': !archiveStatus && !controllerArchivePicker }"
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
            <progress v-if="archiveStatus.phase === 'working'" class="workspace-import-progress" :aria-label="archiveTitle" />
          </template>
          <div v-else-if="server.connected && controllerArchivePicker && archivePanel === 'archive-import'" class="archive-controller">
            <div class="archive-row">
              <div class="archive-drop" role="group" tabindex="0" :aria-label="t('archive.dropSource')"
                @dragover.prevent @drop.stop.prevent="chooseControllerArchive($event.dataTransfer?.files)"
                @paste.stop.prevent="chooseControllerArchive($event.clipboardData?.files)">
                {{ t('archive.dropSource') }}
              </div>
              <Btn type="button" :text="t('common.back')" @click="closeControllerArchivePicker" />
            </div>
            <p v-if="controllerArchiveError" class="archive-error" role="alert">{{ controllerArchiveError }}</p>
          </div>
          <form v-else-if="server.connected && controllerArchivePicker" class="archive-controller" @submit.prevent="downloadControllerArchive">
            <div class="archive-row">
              <div class="archive-drop" :aria-busy="archiveFolderPending" @dragover.prevent @drop.stop.prevent="dropArchiveDownloadFolder">
                <strong :title="archiveDownloadFolder">{{ archiveDownloadFolder || t('archive.downloadFolder') }}</strong>
                <span>{{ t('archive.dropDownloadFolder') }}</span>
              </div>
            </div>
            <div class="archive-row">
              <label class="archive-name">
                {{ t('archive.downloadName') }}
                <input v-model.trim="archiveDownloadName" type="text" maxlength="255" :placeholder="exportArchiveName">
              </label>
              <div class="archive-actions">
                <Btn type="button" :text="t('common.back')" @click="closeControllerArchivePicker" />
                <Btn type="submit" class="archive-save" :text="t('archive.saveHere')"
                  :disabled="!archiveDownloadFolder || archiveFolderPending" />
              </div>
            </div>
            <p v-if="controllerArchiveError" class="archive-error" role="alert">{{ controllerArchiveError }}</p>
          </form>
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
                  @click="browseControllerArchive" />
              </template>
            </ServerFilePickerModal>
            <p v-else class="archive-row" role="status">{{ t('archive.waitingForEngine') }}</p>
          </template>
        </section>
      </Teleport>
    <!-- LocalServerStatus pill intentionally not mounted. The local server
         now runs as a visible application with its own console window /
         taskbar entry, so the user has a direct way to see and stop it.
         Keep the component on disk in case we want to re-enable it later. -->
    <!-- <LocalServerStatus /> -->

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
import { isNewerOneShotProject, sameOneShotMutationIdentity } from '~/types/oneShotMutation';
import { createProjectOpenGuard } from '~/utils/projectOpenGuard';
import { runExclusivePendingAction } from '~/utils/acknowledgedAction';
import { applyOneShotMutation } from '~/utils/oneShotMutation';
import { suppressTooltips } from '~/utils/tooltips';

const {
  currentProject, projectEpoch, saveProject, createNewProject, openProject, confirmUnsavedChanges, workspaceImportPanel,
  autoSaveEnabled, projectSyncIdentity, saveRevision,
  projectHydrationStatus, projectHydrationError, retryProjectHydration,
  projectLoad,
  unsavedDialogVisible, unsavedDialogReason, unsavedDialogBlocked, unsavedSave, unsavedDiscard, unsavedCancel,
} = useProject();
const { stopAllCues } = useAudioEngine();
const { cartOnlyItems, clearCartOnlyItems, addCartOnlyItem } = useCartItems();
import ServerFilePickerModal from './components/ServerFilePickerModal.vue';
const { currentLocale, setLocale, getDirection, t } = useLocalization();
const server = useLiveplayServer();
const { sessionLost } = useConnectionGuard();
const hasWorkspace = computed(() => !!currentProject.value && projectHydrationStatus.value !== 'failed');
const { showHeaderWarning } = useHeaderWarnings();
const { exportCueSheet } = useCueSheetExport();
const { openMediaCleanup } = useMediaCleanup();
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
const projectFileDialogOpen = computed(() => !!projectLoad.value || showNewShowDialog.value || projectPicker.value !== null);
const newShowName = ref('');
const newShowLocation = ref('');
const newShowLocations = useFilePickerLocations(() => String(useLiveplayServer().serverUrl), 'project-create');
const newShowNameInput = ref<HTMLInputElement | null>(null);
const newShowBrowseButton = ref<HTMLButtonElement | null>(null);
const newShowDialogReturnFocus = ref<HTMLElement | null>(null);
const creatingNewShow = ref(false);
const openingFromPicker = ref(false);
const projectFileBusy = computed(() => !!projectLoad.value || creatingNewShow.value || openingFromPicker.value);
const projectFileStatus = computed(() => {
  if (projectLoad.value === 'open') return 'Loading project…';
  if (projectLoad.value === 'create') return 'Creating project…';
  return t('common.loading');
});
const newShowError = ref<string | null>(null);
const canCreateNewShow = computed(() => !!newShowName.value.trim() && !!newShowLocation.value.trim());

function showNewProjectDialog(fallbackFolder: string) {
  if (projectFileDialogOpen.value || unsavedDialogVisible.value) return;
  projectPickerFallback.value = fallbackFolder;
  newShowName.value = '';
  newShowError.value = null;
  newShowLocation.value = newShowLocations.lastFolder.value ?? fallbackFolder;
  newShowDialogReturnFocus.value = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  showNewShowDialog.value = true;
  nextTick(() => newShowNameInput.value?.focus());
}

function showOpenProjectPicker(fallbackFolder: string) {
  if (projectFileDialogOpen.value || unsavedDialogVisible.value) return;
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

async function onProjectPickerPick(path: string) {
  if (!path || !projectPicker.value || openingFromPicker.value) return;
  if (projectPicker.value === 'new-location') {
    newShowLocation.value = path;
    closeProjectPicker();
    return;
  }
  openingFromPicker.value = true;
  try {
    await guardedOpenProject(path);
  } finally {
    closeProjectPicker();
    openingFromPicker.value = false;
  }
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
const { uiFontScale, showTooltips } = useUiMode();

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
// The operator window alone reports for the show (see useKeepAwake).
if (!isCartWindow && !isVideoOutputWindow) useKeepAwake();
watch(() => isVideoOutputWindow || !showTooltips.value, (suppressed, _previous, onCleanup) => {
  if (import.meta.client && suppressed) onCleanup(suppressTooltips(document.body));
}, { immediate: true, flush: 'post' });
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
const DEFAULT_ACCENT = '#315fcf';
const retiredBrandAccents = new Set(['#a45d00', '#8f5000', '#c47a00', '#ffb000']);
const displayAccent = (color?: string) =>
  color && !retiredBrandAccents.has(color.toLowerCase()) ? color : DEFAULT_ACCENT;

const showStartupAbout = ref(false);
watch(hasWorkspace, (ready) => { if (ready) showStartupAbout.value = false; });

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
  if (hasWorkspace.value) {
    settingsTab.value = 'about';
    showProjectSettings.value = true;
  } else {
    showStartupAbout.value = true;
  }
}

const detachedProjectIdentity = useState<OneShotMutationIdentity | null>(
  'oneShots.detachedProjectIdentity', () => null,
);
const detachedProjectError = useState<string>('oneShots.detachedMutationError', () => '');
let rejectedDetachedIdentity: OneShotMutationIdentity | null = null;

function applyCartWindowProjectData(envelope: OneShotProjectEnvelope | null, liveUpdate = false) {
  if (!isCartWindow) return;
  const projectData = envelope?.project ?? null;
  const identity = envelope?.identity ?? null;
  const projectSessionId = envelope?.projectSessionId;
  if (!projectData || !identity || !projectSessionId) {
    rejectedDetachedIdentity = detachedProjectIdentity.value ?? rejectedDetachedIdentity;
    detachedProjectIdentity.value = null;
    currentProject.value = null;
    clearCartOnlyItems();
    detachedProjectError.value = t('oneShots.detachedNoPrimary');
    return;
  }
  const currentIdentity = detachedProjectIdentity.value;
  const fresh = isNewerOneShotProject(identity, currentIdentity ?? rejectedDetachedIdentity);
  if (!fresh && !sameOneShotMutationIdentity(identity, currentIdentity)) return;
  detachedProjectIdentity.value = identity;
  detachedProjectError.value = '';
  clearCartOnlyItems();
  if (Array.isArray(projectData.cartOnlyItems)) {
    for (const item of projectData.cartOnlyItems) addCartOnlyItem(item);
  }
  currentProject.value = projectData;
  server.projectSessionId = projectSessionId;
  if (liveUpdate && fresh) {
    sessionLost.value = false;
    server.showVerification = null;
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

    // A delayed cached snapshot must not replace an update from the owner.
    if (isCartWindow) {
      let receivedUpdate = false;
      window.electronAPI.onCartWindowProjectUpdate((projectData) => {
        receivedUpdate = true;
        applyCartWindowProjectData(projectData, true);
      });
      window.electronAPI.getCartWindowProjectData().then((projectData) => {
        if (!receivedUpdate) applyCartWindowProjectData(projectData);
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
    // lower-panel decisions then call confirmQuit to actually quit.
    (window as any).electronAPI.app?.onRequestQuit?.(() => { void runQuitFlow(); });

    window.electronAPI.onMenuToggleDarkMode(() => {
      theme.value = theme.value === 'dark' ? 'light' : 'dark';
      if (currentProject.value) {
        currentProject.value.theme.mode = theme.value as 'dark' | 'light';
        saveProject();
      }
    });

    window.electronAPI.onMenuChangeAccentColor(() => {
      if (!hasWorkspace.value) return;
      settingsTab.value = 'ui';
      showProjectSettings.value = true;
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
    window.electronAPI.onMenuExportCueSheet?.(() => { void exportCueSheet(); });
    window.electronAPI.onMenuCleanUpMedia?.(() => openMediaCleanup());

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
// two-step confirmation then call confirmQuit (which actually quits):
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

const projectDecision = computed(() => {
  if (unsavedDialogVisible.value) {
    const quitting = unsavedDialogReason.value === 'quit';
    return {
      title: t(quitting ? 'quitModal.unsavedTitle' : 'unsavedModal.title'),
      message: t(quitting ? 'quitModal.unsavedMessage' : 'unsavedModal.message') +
        (unsavedDialogBlocked.value ? ' ' + t('unsavedModal.finishCurrent') : ''),
      buttons: [
        { key: 'cancel', label: t(quitting ? 'quitModal.return' : 'unsavedModal.cancel') },
        { key: 'discard', label: t(quitting ? 'quitModal.unsavedDiscard' : 'unsavedModal.discard'), variant: 'danger' as const },
        { key: 'save', label: t(quitting ? 'quitModal.unsavedSaveClose' : 'unsavedModal.save'), variant: 'primary' as const, icon: 'save' },
      ],
      pick: onUnsavedPick,
    };
  }
  if (quitServerVisible.value) return {
    title: t('quitModal.serverTitle'),
    message: t('quitModal.serverMessage'),
    buttons: [
      { key: 'cancel', label: t('quitModal.return') },
      { key: 'client', label: t('quitModal.serverCloseClient') },
      { key: 'server', label: t('quitModal.serverCloseServer'), variant: 'danger' as const, icon: 'power_settings_new' },
    ],
    pick: onQuitServerPick,
  };
  return null;
});
const projectPanelOpen = useState('projectPanelOpen', () => false);
const reconnectPanelOpen = computed(() => server.connectionLost || !!server.showVerification);
const detachedRecoveryOpen = computed(() => reconnectPanelOpen.value || sessionLost.value);
const recoveryPanelOpen = computed(() => !isCartWindow && !isVideoOutputWindow &&
  (reconnectPanelOpen.value || (sessionLost.value && !!currentProject.value)));
watch(() => recoveryPanelOpen.value || !!projectDecision.value || projectFileDialogOpen.value,
  (open) => { projectPanelOpen.value = open; }, { immediate: true });

function onUnsavedPick(choice: string) {
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
    const confirmedRevision = saveRevision.value;
    const confirmedEpoch = projectEpoch.value;
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

    const choice = serverIsLocal ? await askQuitServer() : 'client';
    if (choice === 'cancel') return;
    // Transport stays available while deciding, so edits made in that time need their own approval.
    if ((projectEpoch.value !== confirmedEpoch || saveRevision.value !== confirmedRevision) &&
        !await confirmUnsavedChanges('quit')) return;
    await api?.app?.confirmQuit?.({ stopServer: choice === 'server' });
  } finally {
    quitFlowActive = false;
  }
}
type ArchivePanel = 'archive-import' | 'archive-export';
type ArchiveStatus = { phase: 'working' | 'done' | 'failed'; message: string };
type ArchiveSource = { path: string; client: boolean } | { file: File };

const importArchiveStatus = ref<ArchiveStatus | null>(null);
const exportArchiveStatus = ref<ArchiveStatus | null>(null);
const importArchiveSource = shallowRef<ArchiveSource | null>(null);
const archiveReceipt = shallowRef<{
  serverUrl: string; accessToken: string; extractPath: string; projectFiles: string[];
} | null>(null);
const archiveOpening = ref(false);
const controllerArchivePicker = ref(false);
const controllerArchiveError = ref('');
const archiveDownloadFolder = ref('');
const archiveDownloadName = ref('');
const archiveFolderPending = ref(false);
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
const archiveSourceName = (source: ArchiveSource) => 'file' in source ? source.file.name : archiveFilename(source.path);
const exportArchiveName = computed(() => (currentProject.value?.name || 'Project') + PROJECT_FILE_EXTENSIONS.nativeArchive);
const archivePickerCaption = computed(() => {
  if (archiveChoosingSource.value) return t('archive.chooseSource');
  if (archivePanel.value === 'archive-export') return t('archive.exportDestination', { name: exportArchiveName.value });
  return t('archive.importDestination', { name: importArchiveSource.value ? archiveSourceName(importArchiveSource.value) : '' });
});

let archivePickerRevision = 0;
watch([workspaceImportPanel, showProjectSettings, projectEpoch,
  () => server.serverUrl, () => server.effectiveAccessToken, () => server.projectSessionId], () => {
  closeControllerArchivePicker();
}, { flush: 'sync' });
watch([() => server.serverUrl, () => server.effectiveAccessToken], () => {
  const source = importArchiveSource.value;
  if (source && 'path' in source && !source.client) importArchiveSource.value = null;
}, { flush: 'sync' });

function openArchivePanel(panel: ArchivePanel) {
  showProjectSettings.value = false;
  workspaceImportPanel.value = panel;
}

function resetArchivePanel() {
  if (archivePanel.value === 'archive-export') {
    if (exportArchiveStatus.value?.phase === 'done') closeControllerArchivePicker();
    exportArchiveStatus.value = null;
  } else {
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

function closeControllerArchivePicker() {
  archivePickerRevision++;
  controllerArchivePicker.value = false;
  controllerArchiveError.value = '';
  archiveDownloadFolder.value = '';
  archiveDownloadName.value = '';
  archiveFolderPending.value = false;
}

function browseControllerArchive() {
  if (!archivePanel.value || archiveStatus.value) return;
  controllerArchivePicker.value = true;
  if (archivePanel.value === 'archive-export') void chooseArchiveDownloadFolder();
}

function chooseControllerArchive(files: FileList | undefined) {
  const file = files?.length === 1 ? files[0] : undefined;
  if (!file || projectFileAction(file.name) !== 'import-archive' || !file.size) {
    controllerArchiveError.value = t('archive.unsupported');
    return;
  }
  importArchiveSource.value = { file };
  closeControllerArchivePicker();
}

function dropArchiveDownloadFolder(event: DragEvent) {
  const files = event.dataTransfer?.files;
  if (files?.length === 1) void chooseArchiveDownloadFolder(files[0]);
  else controllerArchiveError.value = t('archive.invalidDownloadFolder');
}

async function chooseArchiveDownloadFolder(file?: File) {
  const revision = ++archivePickerRevision;
  archiveFolderPending.value = true;
  controllerArchiveError.value = '';
  try {
    const api = window.electronAPI;
    const folder = await api.getArchiveDownloadFolder(file);
    if (!folder) throw new Error('Folder unavailable');
    if (archivePickerRevision === revision) archiveDownloadFolder.value = folder;
  } catch {
    if (archivePickerRevision === revision) controllerArchiveError.value = t('archive.invalidDownloadFolder');
  } finally {
    if (archivePickerRevision === revision) archiveFolderPending.value = false;
  }
}

function downloadControllerArchive() {
  if (!archiveDownloadFolder.value || archiveFolderPending.value) return;
  void runExport({ outputPath: '', downloadTo: { folder: archiveDownloadFolder.value, name: archiveDownloadName.value } });
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

async function runExport(opts: { outputPath: string; downloadTo?: { folder: string; name: string } }) {
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
    let path = result.archivePath;
    if (opts.downloadTo) {
      if (!result.downloadToken || !sameServer()) throw new Error(t('archive.downloadUnavailable'));
      exportArchiveStatus.value.message = t('exportProgress.downloading') + ' ' + name + '…';
      path = await server.downloadArchiveToFile(result.downloadToken, opts.downloadTo.folder,
        opts.downloadTo.name || result.downloadFilename || name);
    }
    exportArchiveStatus.value = {
      phase: 'done', message: t('exportProgress.saved', { path }),
    };
  } catch (error) {
    showArchiveFailure('archive-export', error);
  }
}

async function runImport(source: ArchiveSource, destination: string) {
  const serverUrl = server.serverUrl;
  const accessToken = server.effectiveAccessToken;
  const upload = 'file' in source || (source.client && !server.isLocalServer);
  const name = archiveSourceName(source);
  importArchiveStatus.value = {
    phase: 'working', message: t(upload ? 'archive.uploading' : 'importProgress.message') + ' ' + name + '…',
  };
  try {
    const result = 'file' in source
      ? await server.importProjectArchiveUpload(source.file, destination)
      : upload
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

watch([currentProject, () => currentProject.value?.theme?.accentColor], ([project, color]) => {
  if (project?.theme?.mode) theme.value = project.theme.mode;
  if (!import.meta.client) return;
  if (project) document.documentElement.style.setProperty('--color-accent-custom', displayAccent(color));
  else document.documentElement.style.removeProperty('--color-accent-custom');
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

.project-file-panel {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--color-border);
  background: var(--color-background);
}

.project-file-panel--startup {
  /* Nothing else needs this screen: let the browser use most of it. */
  max-height: 80%;
  overflow: auto;
}

.startup-about-panel { overflow: hidden; }
.startup-about-content {
  min-height: 0;
  overflow: auto;
  padding: var(--spacing-sm) var(--workspace-gutter);
}

.project-file-panel--browse {
  height: clamp(300px, 58vh, 680px);
}

.new-show-form,
.new-show-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: var(--spacing-sm);
}

.new-show-form,
.project-file-status {
  margin: 0;
  padding: var(--spacing-sm) var(--workspace-gutter);
}

.new-show-field {
  flex: 1 1 180px;
  min-width: 0;
  display: grid;
  gap: var(--spacing-xs);
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 600;
}

.new-show-field--location { flex-basis: 290px; }

.new-show-location {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--spacing-xs);
}

.new-show-field input,
.new-show-location button {
  min-height: var(--panel-control-height);
  min-width: 0;
  padding: var(--spacing-xs) var(--spacing-sm);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background: var(--color-control);
  color: var(--color-text-primary);
  font: inherit;
}

.new-show-location input { text-overflow: ellipsis; }
.new-show-location button:hover { background: var(--color-surface-hover); }
.new-show-actions { margin-inline-start: auto; }

.new-show-actions .new-show-create,
.archive-actions .archive-save:not(:disabled) {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-text-on-accent);
}

.new-show-actions .new-show-create:hover:not(:disabled),
.archive-actions .archive-save:hover:not(:disabled) { filter: brightness(1.1); }

.new-show-error {
  flex: 0 0 100%;
  margin: 0;
  color: var(--color-danger);
  overflow-wrap: anywhere;
}

.archive-panel {
  display: flex;
  flex-direction: column;
  width: min(100%, var(--settings-width));
  padding: 0 var(--workspace-gutter) var(--spacing-xs);
  min-width: 0;
  color: var(--color-text-primary);
}

.archive-panel--browse {
  flex: 1 1 auto;
  height: clamp(300px, 54vh, 640px);
  min-height: 240px;
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
  flex-wrap: wrap;
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
  max-width: 100%;
}

.archive-controller p { margin: 0; }

.archive-drop {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-xs) var(--workspace-gutter);
  flex: 1 1 16rem;
  min-width: 0;
  padding: var(--spacing-xs) var(--workspace-gutter);
  border: 1px dashed var(--color-border);
  min-height: var(--panel-control-height);

  span { color: var(--color-text-secondary); }
}

.archive-name {
  display: flex;
  flex: 0 1 30rem;
  align-items: center;
  gap: var(--workspace-gutter);
  min-width: 0;

  input { flex: 1; min-width: 0; }
}

.archive-error { color: var(--color-danger); }

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
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  color: var(--color-text-secondary);
}

.cart-brand-url {
  margin-left: auto;
  font-size: 11px;
  color: var(--color-text-secondary);
  opacity: 0.7;
}

.cart-recovery-stop {
  flex: none;
  margin-inline-start: auto;
  color: var(--color-danger);
}

.cart-recovery-panel {
  flex: 0 0 auto;
  max-height: 60%;
  overflow: auto;
}

.cart-recovery-wait {
  margin: 0;
  padding: var(--spacing-sm) var(--workspace-gutter);
  border-top: 1px solid var(--color-border);
  color: var(--color-text-secondary);
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
