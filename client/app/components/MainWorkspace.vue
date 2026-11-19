<template>
  <div class="main-workspace" :class="{ 'show-mode': uiMode === 'playback' }">
    <!-- Show Mode reuses the full editor layout (header, transport, resizable/
         detachable playlist⇄QuickPlay split). It is not a separate view: the child
         components read useUiMode() and hide their edit affordances, and
         nothing else: every size, waveform, colour, duration, behaviour flag
         and warning renders exactly as in Edit Mode. -->
    <ProjectHeader :inert="recoveryOpen" />
    <PlaybackControls />
    <LevelCheckBar :inert="recoveryOpen" />

    <div ref="workspaceContent" class="workspace-content" :style="{ '--reserved-playlist-row-height': `${reservedPlaylistRowHeight}px` }">
      <aside
        v-if="monitorAssigned"
        :inert="recoveryOpen"
        class="monitor-console output-console"
        aria-label="Monitor"
      >
        <div class="output-console__header workspace-panel-header">
          <span class="workspace-panel-header__title">Monitor</span>
        </div>
        <div class="output-console__strips">
          <section class="output-pair" :aria-label="monitorLabel" :title="monitorLabel">
            <StereoMeter
              :left-index="30"
              :right-index="31"
              :label="monitorLabel"
              :show-peak-value="true"
              :min-db="outputConsoleMinDb"
              :max-db="outputConsoleMaxDb"
            >
              <template #scale-control>
                <VolumeSlider
                  class="output-pair__fader"
                  :inline-scale="true"
                  :db="getOutputGainDb(30)"
                  :min-db="outputConsoleMinDb"
                  :max-db="outputConsoleMaxDb"
                  :title="monitorLabel"
                  @input="(db: number) => onOutputGainInput(30, 31, db)"
                  @reset="resetOutputGain(30, 31)"
                />
              </template>
            </StereoMeter>
          </section>
        </div>
      </aside>

      <div class="workspace-panels">
        <div
          v-if="quickPlayVisible"
          v-show="!recoveryOpen || !quickPlayFullscreen"
          :inert="recoveryOpen"
          id="quickplay-workspace-panel"
          class="quickplay-section"
          :class="{ 'quickplay-section--fullscreen': quickPlayFullscreen }"
          :style="{ width: quickPlayFullscreen ? '100%' : `${quickPlayWidth}px` }"
        >
          <QuickPlayPanel>
            <template #header-leading>
              <button
                type="button"
                class="quickplay-toggle quickplay-toggle--open"
                :aria-label="t('quickPlays.hide')"
                :title="t('quickPlays.hide')"
                :aria-expanded="true"
                aria-controls="quickplay-workspace-panel"
                @click="toggleQuickPlays"
              >
                <span class="material-symbols-rounded quickplay-toggle__collapse" aria-hidden="true">chevron_left</span>
              </button>
            </template>
          </QuickPlayPanel>
        </div>

        <div
          v-if="!quickPlayDetached"
          v-show="!recoveryOpen || !quickPlayFullscreen"
          :inert="recoveryOpen"
          class="resize-handle"
          :class="{ 'collapsed-left': quickPlayClosed, 'collapsed-right': quickPlayFullscreen, dragging: isResizing }"
          @pointerdown="startResize"
        ></div>

        <div v-show="recoveryOpen || !quickPlayFullscreen || quickPlayDetached" class="playlist-section">
          <div class="playlist-panel">
            <PlaylistView :read-only="recoveryOpen">
              <template #header-leading>
                <button
                  v-if="quickPlayClosed && !quickPlayDetached"
                  :disabled="recoveryOpen"
                  type="button"
                  class="quickplay-toggle quickplay-toggle--reveal"
                  :aria-label="t('quickPlays.show')"
                  :title="t('quickPlays.show')"
                  :aria-expanded="false"
                  @click="toggleQuickPlays"
                >
                  <CueSymbol name="quickplays" />
                  <span class="quickplay-toggle__label">{{ t('quickPlays.show') }}</span>
                </button>
              </template>
            </PlaylistView>
          </div>
        </div>
      </div>

      <aside class="output-console" :class="{ 'output-console--collapsed': metersCollapsed }"
        :aria-label="t('properties.output')" :inert="recoveryOpen">
        <!-- Folded away, the strip is a slim rail: the playlist gets the width
             back on a small screen. The limiter keeps working either way. -->
        <button v-if="metersCollapsed" type="button" class="output-console__fold output-console__fold--rail"
          :aria-label="t('outputConsole.showMeters')" :title="t('outputConsole.showMeters')"
          aria-expanded="false" @click="metersCollapsed = false">
          <span class="material-symbols-rounded" aria-hidden="true">chevron_left</span>
          <span class="output-console__rail-label" aria-hidden="true">{{ t('properties.output') }}</span>
        </button>
        <div v-show="!metersCollapsed" class="output-console__header workspace-panel-header">
          <button type="button" class="output-console__fold"
            :aria-label="t('outputConsole.hideMeters')" :title="t('outputConsole.hideMeters')"
            aria-expanded="true" @click="metersCollapsed = true">
            <span class="material-symbols-rounded" aria-hidden="true">chevron_right</span>
          </button>
          <div class="output-console__header-controls">

            <button
              type="button"
              class="limiter-toggle"
              :class="{ 'is-enabled': limiterEnabled }"
              :aria-pressed="!limiterEnabled"
              :aria-label="`${limiterToggleLabel}. ${limiterGainReductionLabel}`"
              :title="limiterToggleLabel"
              :disabled="limiterChangePending || !currentProject"
              @click="toggleLimiter"
            >
              <span class="limiter-toggle__label">{{ t('outputConsole.limiter') }}</span>
              <span
                class="limiter-toggle__gr"
                :class="{ 'is-reducing': limiterGainReductionDb > 0.05 }"
              >{{ limiterGainReductionLabel }}</span>
            </button>
            <div class="limiter-ceiling-control">
              <div class="limiter-ceiling-value">
                <input
                  ref="limiterCeilingInput"
                  type="number"
                  class="limiter-ceiling-input"
                  :class="{ 'is-danger': limiterCeilingDb >= -0.05 }"
                  :value="limiterCeilingDb.toFixed(1)"
                  min="-60"
                  max="0"
                  step="0.1"
                  inputmode="decimal"
                  :aria-label="t('outputConsole.ceilingInputLabel')"
                  :title="`${t('outputConsole.ceiling')}: ${limiterCeilingLabel}`"
                  :disabled="limiterChangePending || !currentProject"
                  @change="onLimiterCeilingChange"
                  @pointerdown="startLimiterCeilingDrag"
                  @pointermove="scrubLimiterCeiling"
                  @pointerup="finishLimiterCeilingDrag"
                  @pointercancel="cancelLimiterCeilingDrag"
                />
                <div class="limiter-ceiling-steppers">
                  <button
                    type="button"
                    :aria-label="`${t('outputConsole.ceilingInputLabel')}: +0.1 dB`"
                    title="+0.1 dB"
                    :disabled="limiterChangePending || !currentProject"
                    @click="stepLimiterCeiling(0.1)"
                  ><span class="material-symbols-rounded" aria-hidden="true">keyboard_arrow_up</span></button>
                  <button
                    type="button"
                    :aria-label="`${t('outputConsole.ceilingInputLabel')}: −0.1 dB`"
                    title="−0.1 dB"
                    :disabled="limiterChangePending || !currentProject"
                    @click="stepLimiterCeiling(-0.1)"
                  ><span class="material-symbols-rounded" aria-hidden="true">keyboard_arrow_down</span></button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div v-show="!metersCollapsed" class="output-console__strips">
          <section
            v-for="pair in outputPairs"
            :key="pair.key"
            class="output-pair"
            :aria-label="pair.label"
            :title="pair.label"
          >
            <StereoMeter
              :left-index="pair.leftIndex"
              :right-index="pair.rightIndex"
              :label="pair.label"
              :show-peak-value="true"
              :min-db="outputConsoleMinDb"
              :max-db="outputConsoleMaxDb"
            >
              <template #scale-control>
                <VolumeSlider
                  class="output-pair__fader"
                  :inline-scale="true"
                  :db="getOutputGainDb(pair.leftIndex)"
                  :min-db="outputConsoleMinDb"
                  :max-db="outputConsoleMaxDb"
                  :title="pair.label"
                  @input="(db: number) => onOutputGainInput(pair.leftIndex, pair.rightIndex, db)"
                  @reset="resetOutputGain(pair.leftIndex, pair.rightIndex)"
                />
              </template>
            </StereoMeter>
          </section>
        </div>
      </aside>
    </div>

    <div id="preview-lower-panel" class="preview-lower-panel" aria-live="polite"></div>

    <div v-if="!recoveryOpen" class="workspace-status">
      <AudioLoadProgress />
      <div v-if="projectRepair" class="repair-status">
        <span role="status">{{ t('repair.noticeTitle') }}</span>
        <Btn class="repair-review" type="button" icon="warning" :text="t('repair.review')" :disabled="decisionOpen"
          :aria-expanded="visibleImportPanel === 'repair' && !decisionOpen"
          aria-controls="workspace-import-host" @click="toggleRepairReview" />
      </div>
    </div>
    <ShortcutsBar :inert="recoveryOpen" />

    <div v-show="lowerPanelOpen" ref="lowerPanel" class="lower-workspace-panel"
      :class="{ 'lower-workspace-panel--deciding': decisionOpen, 'lower-workspace-panel--browsing-files': filePicker }"
      :style="{ height: lowerPanelHeight, maxHeight: `${panelMaxPercent}%` }"
      @keydown.capture="handlePanelKeydown($event, true)"
      @keydown="handlePanelKeydown">
      <div v-if="!autoSizeImportPanel && !compactShowCheck" class="lower-panel-resize-handle" role="separator" aria-orientation="horizontal"
        :aria-label="showProjectSettings ? t('settings.title') : importPanelTitle || t('properties.title')"
        :aria-valuemin="MIN_PANEL_HEIGHT" :aria-valuemax="panelMaxHeight"
        :aria-valuenow="visiblePanelHeight || panelHeight || MIN_PANEL_HEIGHT" tabindex="0"
        @pointerdown="startPanelResize" @pointermove="movePanelResize"
        @lostpointercapture="panelDrag = null" @keydown="handlePanelResizeKey"
      ></div>
      <ProjectSettingsModal :open="showProjectSettings" @close="showProjectSettings = false" />
      <PropertiesPanel v-if="showCueProperties" />
      <section v-show="visibleImportPanel" class="workspace-import" :aria-label="importPanelTitle">
        <header class="workspace-panel-header">
          <h2 class="workspace-panel-header__title">{{ importPanelTitle }}</h2>
          <button v-if="tallImportPanel" type="button" class="workspace-import-close workspace-import-resize"
            :aria-label="t(importExpanded ? 'actions.panelSmaller' : 'actions.panelLarger')"
            :title="t(importExpanded ? 'actions.panelSmaller' : 'actions.panelLarger')"
            :aria-pressed="importExpanded" @click="toggleImportExpanded">
            <span class="material-symbols-rounded" aria-hidden="true">{{ importExpanded ? 'collapse_content' : 'expand_content' }}</span>
          </button>
          <button type="button" class="workspace-import-close" :aria-label="t('actions.close')" @click="closeImportPanel">
            <span class="material-symbols-rounded" aria-hidden="true">close</span>
          </button>
        </header>
        <div id="workspace-import-host" ref="importHost" class="workspace-import-host"
          :class="{ 'workspace-import-host--archive': visibleImportPanel?.startsWith('archive-') }">
          <DeleteSelectionPanel v-if="visibleImportPanel === 'delete-selection'" />
          <ProjectRepairNotice v-else-if="visibleImportPanel === 'repair' && projectRepair" :notice="projectRepair" @save="saveRepairedProject" />
          <PreShowCheckPanel v-else-if="visibleImportPanel === 'show-check'" />
          <VideoCaptureControls v-else-if="visibleImportPanel === 'video-capture'" class="workspace-capture" />
          <MediaCleanupPanel v-else-if="visibleImportPanel === 'media-cleanup'" />
        </div>
      </section>
      <div v-show="decisionOpen" id="workspace-project-decision"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import LevelCheckBar from './LevelCheckBar.vue';
import PreShowCheckPanel from './PreShowCheckPanel.vue';
import ProjectSettingsModal from './ProjectSettingsModal.vue';
import StereoMeter from './StereoMeter.vue';
import VolumeSlider from './VolumeSlider.vue';
import { bindingsMatch, eventToBinding } from '~/composables/useQuickPlayHotkeys';
import { usePreShowCheckLongList } from '~/composables/usePreShowCheck';
import { flattenQuickPlays } from '~/utils/quickPlays';

const { decisionOpen, recoveryOpen } = defineProps<{ decisionOpen: boolean; recoveryOpen: boolean }>();
const {
  selectedItem,
  selectedItems,
  openItemProperties,
  propertiesPanelOpen,
  workspaceImportPanel,
  quickPlayEditor,
  previewItemUuid,
  saveProject,
  closeProject,
  confirmUnsavedChanges,
  currentProject,
  projectHydrationStatus,
  projectSyncIdentity,
  selectAllItems,
  duplicateItems,
  copyItemsToClipboard,
  pasteItemsFromClipboard,
  requestDeleteFromKeyboard,
  pendingDelete,
  cancelDelete,
  projectRepair,
  saveRepairedProject,
} = useProject();
const { quickPlayItems } = useQuickPlayItems();
const { t } = useLocalization();
const server = useLiveplayServer();
const { uiMode, uiFontScale, regularPlaylistRowHeight, folderPlaylistRowHeight } = useUiMode();
const { levels: outputTargetLevels } = useOutputTarget();
const showProjectSettings = useState('showProjectSettings', () => false);
const quickPlayImportSlot = useState<number | null>('quickPlayImportSlot', () => null);
const visibleImportPanel = computed(() => {
  const panel = workspaceImportPanel.value;
  if (panel === 'delete-selection') return !showProjectSettings.value && pendingDelete.value ? panel : null;
  if (panel === 'repair') return !showProjectSettings.value && projectRepair.value ? panel : null;
  // Read-only, so the Pre-show check is available in Show Mode as well.
  // So is capturing a picture: it is used during a show.
  if (panel === 'show-check' || panel === 'video-capture') return !showProjectSettings.value ? panel : null;
  return !showProjectSettings.value && (uiMode.value !== 'playback' || panel === 'quickplay' || panel?.startsWith('archive-')) ? panel : null;
});
const importPanelTitle = computed(() => {
  if (visibleImportPanel.value === 'import-choice') return t('playlist.importMenu');
  if (visibleImportPanel.value === 'media') return t('importAudio.title');
  if (visibleImportPanel.value === 'youtube') return t('youtube.importFromYouTube');
  if (visibleImportPanel.value === 'spotify') return t('spotifyImport.title');
  if (visibleImportPanel.value === 'archive-import') return t('importProject.chooseSourceTitle');
  if (visibleImportPanel.value === 'archive-export') return t('exportProject.chooseLocationTitle');
  if (visibleImportPanel.value === 'delete-selection') return t('deleteSelection.title');
  if (visibleImportPanel.value === 'repair') return t('repair.noticeTitle');
  if (visibleImportPanel.value === 'show-check') return t('showCheck.title');
  if (visibleImportPanel.value === 'video-capture') return t('standbyCapture.panelTitle');
  if (visibleImportPanel.value === 'media-cleanup') return t('mediaCleanup.title');
  if (visibleImportPanel.value === 'quickplay') return t(quickPlayEditor.value?.remove
    ? 'quickPlays.removeConfirmTitle' : quickPlayEditor.value ? 'quickPlays.settings' : 'quickPlays.importInto',
    { number: (quickPlayImportSlot.value ?? 0) + 1 });
  return '';
});
function toggleRepairReview() {
  const open = visibleImportPanel.value === 'repair';
  showProjectSettings.value = false;
  workspaceImportPanel.value = open ? null : 'repair';
}
function closeImportPanel() {
  if (workspaceImportPanel.value === 'delete-selection') return cancelDelete();
  if (workspaceImportPanel.value === 'quickplay') quickPlayEditor.value = null;
  workspaceImportPanel.value = null;
}
const editableSelectedItem = computed(() => {
  if (!selectedItem.value) return null;
  if (uiMode.value !== 'playback' || selectedItem.value.uuid === previewItemUuid.value) return selectedItem.value;
  return null;
});
const showCueProperties = computed(() =>
  !showProjectSettings.value && !visibleImportPanel.value && propertiesPanelOpen.value && !!editableSelectedItem.value);
const lowerPanelOpen = computed(() => decisionOpen || showProjectSettings.value || !!visibleImportPanel.value || !!showCueProperties.value);
const filePicker = useState<'cue' | 'standby' | 'replace-media' | null>('workspaceFilePicker', () => null);
// Leave room for one row, cue or folder, when the lower panel is maximized.
const reservedPlaylistRowHeight = computed(() => Math.max(folderPlaylistRowHeight.value, regularPlaylistRowHeight.value));

const MIN_PANEL_HEIGHT = 120;
const MAX_PANEL_HEIGHT_PERCENT = 60;
// The importers show long lists (files, search results, tracks). They may
// grow to most of the window, and the file browser opens tall; the transport
// bar and Stop All Cues stay in view either way.
const IMPORT_PANEL_HEIGHT_PERCENT = 58;
const IMPORT_MAX_PANEL_HEIGHT_PERCENT = 84;
const settingsHeight = useState<number | null>('ProjectSettingsPanel.height', () => null);
const propertiesHeight = useState<number | null>('PropertiesPanel.height', () => null);
const importHeight = useState<number | null>('ImportPanel.height', () => null);
const autoSizeImportPanel = computed(() => visibleImportPanel.value === 'delete-selection' || visibleImportPanel.value === 'repair'
  || visibleImportPanel.value === 'import-choice' || visibleImportPanel.value === 'video-capture');
const panelHeight = computed(() => showProjectSettings.value ? settingsHeight.value
  : autoSizeImportPanel.value ? null
  : visibleImportPanel.value ? importHeight.value : propertiesHeight.value);
// The Pre-show check fits its contents like the panels above. Only a long
// list of named cues turns it into a resizable panel, as an importer is.
const showCheckLongList = usePreShowCheckLongList();
const compactShowCheck = computed(() => visibleImportPanel.value === 'show-check' && !showCheckLongList.value);
// The output meter strip can be folded to a slim rail; the choice is remembered.
const METERS_COLLAPSED_KEY = 'dwcue.outputMetersCollapsed';
const metersCollapsed = useState<boolean>('OutputConsole.collapsed', () => false);
if (import.meta.client) {
  try { metersCollapsed.value = localStorage.getItem(METERS_COLLAPSED_KEY) === '1'; } catch { /* keep the default */ }
  watch(metersCollapsed, (collapsed) => {
    try { localStorage.setItem(METERS_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch { /* not remembered this time */ }
  });
}
const noteEditRequest = useState<string | null>('playlistNoteEditRequest', () => null);
// The video check works in the background from the moment a show is open (see
// useVideoPreflight): it needs an owner that is always there.
if (import.meta.client && window.electronAPI?.videoOutput?.checkFrame) useVideoPreflight();
const playlistSearchFocusRequest = useState<number>('playlistSearchFocusRequest', () => 0);
const importExpanded = useState<boolean>('ImportPanel.expanded', () => false);
const tallImportPanel = computed(() => !showProjectSettings.value && !!visibleImportPanel.value && !autoSizeImportPanel.value
  && !compactShowCheck.value);
// Anything that lists files or results may use the larger limit: importers,
// the Open / Save As browser, and the file pickers inside Properties.
const roomyPanel = computed(() => tallImportPanel.value || decisionOpen || !!filePicker.value);
const panelMaxPercent = computed(() => roomyPanel.value ? IMPORT_MAX_PANEL_HEIGHT_PERCENT : MAX_PANEL_HEIGHT_PERCENT);
const lowerPanelHeight = computed(() => {
  if (decisionOpen || compactShowCheck.value) return 'auto';
  if (tallImportPanel.value && importExpanded.value) return `${IMPORT_MAX_PANEL_HEIGHT_PERCENT}%`;
  if (panelHeight.value !== null) return `${panelHeight.value}px`;
  // Browsing files needs the room at once. Search and track lists start
  // small and grow with their results, up to the same limit.
  return tallImportPanel.value && visibleImportPanel.value === 'media' ? `${IMPORT_PANEL_HEIGHT_PERCENT}%` : 'auto';
});
function toggleImportExpanded() {
  importExpanded.value = !importExpanded.value;
}
const workspaceContent = ref<HTMLElement | null>(null);
const lowerPanel = ref<HTMLElement | null>(null);
const importHost = ref<HTMLElement | null>(null);
watch(visibleImportPanel, () => {
  if (importHost.value) importHost.value.scrollTop = 0;
}, { flush: 'post' });
watch(projectRepair, (notice) => {
  if (!notice && workspaceImportPanel.value === 'repair') workspaceImportPanel.value = null;
});
const visiblePanelHeight = ref(0);
const panelMaxHeight = ref(MIN_PANEL_HEIGHT);
let panelObserver: ResizeObserver | undefined;
let panelDrag: { pointerId: number; startY: number; height: number; max: number } | null = null;

function availablePanelHeight() {
  const content = workspaceContent.value;
  const panel = lowerPanel.value;
  if (!content || !panel?.parentElement) return MIN_PANEL_HEIGHT;
  const reserved = parseFloat(getComputedStyle(content).minHeight);
  return Math.max(MIN_PANEL_HEIGHT, Math.floor(Math.min(
    panel.parentElement.clientHeight * panelMaxPercent.value / 100,
    panel.offsetHeight + content.offsetHeight - reserved)));
}

function setPanelHeight(height: number, max: number) {
  const size = showProjectSettings.value ? settingsHeight : visibleImportPanel.value ? importHeight : propertiesHeight;
  // Dragging the handle is a deliberate size; it replaces the expanded state.
  if (size === importHeight) importExpanded.value = false;
  size.value = Math.round(Math.max(MIN_PANEL_HEIGHT, Math.min(max, height)));
}

function startPanelResize(event: PointerEvent) {
  if (event.button !== 0 || !event.isPrimary) return;
  const handle = event.currentTarget as HTMLElement;
  event.preventDefault();
  handle.focus({ preventScroll: true });
  handle.setPointerCapture(event.pointerId);
  panelDrag = {
    pointerId: event.pointerId, startY: event.clientY,
    height: lowerPanel.value?.offsetHeight ?? MIN_PANEL_HEIGHT, max: availablePanelHeight(),
  };
}

function movePanelResize(event: PointerEvent) {
  if (panelDrag?.pointerId !== event.pointerId) return;
  setPanelHeight(panelDrag.height + (panelDrag.startY - event.clientY) * 100 / uiFontScale.value, panelDrag.max);
}

function handlePanelResizeKey(event: KeyboardEvent) {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  event.stopPropagation();
  const height = lowerPanel.value?.offsetHeight ?? MIN_PANEL_HEIGHT;
  setPanelHeight(height + (event.key === 'ArrowUp' ? 16 : -16), availablePanelHeight());
}


// Resizable QuickPlay width. 336 px starts each of the two tiles wide enough
// for its number, key, a time up to 59:59 and the edit buttons on one line.
const quickPlayWidth = ref(336);
const isResizing = ref(false);
const quickPlayClosed = ref(true);
const quickPlayVisibilityExplicit = ref(false);
const hasAssignedQuickPlays = computed(() => {
  const project = currentProject.value;
  return !!project && flattenQuickPlays(
    project.items ?? [],
    project.quickPlayItems ?? [],
  ).length > 0;
});
watch(hasAssignedQuickPlays, (assigned) => {
  if (quickPlayVisibilityExplicit.value) return;
  quickPlayClosed.value = !assigned;
  // Once existing assigned content arrives through paged project hydration,
  // keep the user's resulting panel state stable.
  if (assigned) quickPlayVisibilityExplicit.value = true;
}, { immediate: true });
const quickPlayFullscreen = ref(false);
const quickPlayDetached = ref(false);
const quickPlayVisible = computed(() => !quickPlayClosed.value && !quickPlayDetached.value);
const { mount: mountHotkeys, unmount: unmountHotkeys, playbackMappings } = useQuickPlayHotkeys({
  'toggle-settings': () => { showProjectSettings.value = !showProjectSettings.value; },
  'toggle-properties': () => {
    const item = editableSelectedItem.value;
    if (!item) return;
    if (showCueProperties.value) propertiesPanelOpen.value = false;
    else openItemProperties(item.uuid);
  },
  'toggle-quickplays': () => { if (!quickPlayDetached.value) toggleQuickPlays(); },
});
const { stopAllCues } = useAudioEngine();
const outputConsoleMinDb = -60;
const outputConsoleMaxDb = 40;
const limiterCeilingDragPixelsPerStep = 6;
const limiterChangePending = ref(false);
const limiterCeilingInput = ref<HTMLInputElement | null>(null);
let limiterCeilingDrag: {
  input: HTMLInputElement;
  pointerId: number;
  startY: number;
  startDb: number;
  moved: boolean;
} | null = null;
const limiterEnabled = computed(() =>
  (currentProject.value as any)?.settings?.disableLimiter !== true,
);
const limiterCeilingDb = computed(() => {
  const value = (currentProject.value as any)?.settings?.limiterCeilingDb;
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(-60, Math.min(0, value))
    : outputTargetLevels.value.limiterCeilingDb;
});
const limiterCeilingLabel = computed(() => {
  const db = limiterCeilingDb.value;
  return `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db).toFixed(1)} dBTP`;
});

const limiterToggleLabel = computed(() =>
  t(limiterEnabled.value ? 'outputConsole.bypassLimiter' : 'outputConsole.enableLimiter'),
);
const limiterGainReductionDb = computed(() => {
  const channels = server.meters?.master_channels ?? [];
  const left = channels.find(channel => channel.index === 0)?.gain_reduction_db ?? 0;
  const right = channels.find(channel => channel.index === 1)?.gain_reduction_db ?? 0;
  return Math.abs(Math.min(0, left, right));
});
const limiterGainReductionLabel = computed(() =>
  `GR −${limiterGainReductionDb.value.toFixed(1)}`,
);

async function patchLimiterSettings(patch: Record<string, unknown>) {
  const project = currentProject.value as any;
  if (!project || limiterChangePending.value) return;

  const previousSettings = { ...(project.settings ?? {}) };
  project.settings = { ...previousSettings, ...patch };
  limiterChangePending.value = true;
  try {
    await server.patchSettings(patch);
    if (!await saveProject()) {
      server.lastError = 'Output settings applied, but the project save did not complete.';
    }
  } catch (error) {
    project.settings = previousSettings;
    server.lastError = `Output settings failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    limiterChangePending.value = false;
  }
}

async function toggleLimiter() {
  await patchLimiterSettings({ disableLimiter: limiterEnabled.value });
}

function normalizeLimiterCeiling(value: number) {
  return Math.round(Math.max(-60, Math.min(0, value)) * 10) / 10;
}

async function commitLimiterCeiling(input: HTMLInputElement) {
  const value = Number(input.value);
  if (!Number.isFinite(value)) {
    input.value = limiterCeilingDb.value.toFixed(1);
    return;
  }

  const db = normalizeLimiterCeiling(value);
  input.value = db.toFixed(1);
  if (db === limiterCeilingDb.value) return;
  await patchLimiterSettings({ limiterCeilingDb: db });
}

async function onLimiterCeilingChange(event: Event) {
  await commitLimiterCeiling(event.target as HTMLInputElement);
}

async function stepLimiterCeiling(delta: number) {
  const input = limiterCeilingInput.value;
  if (!input || input.disabled) return;
  input.value = normalizeLimiterCeiling(limiterCeilingDb.value + delta).toFixed(1);
  await commitLimiterCeiling(input);
}

function startLimiterCeilingDrag(event: PointerEvent) {
  const input = event.currentTarget as HTMLInputElement;
  if (event.button !== 0 || input.disabled) return;
  limiterCeilingDrag = {
    input,
    pointerId: event.pointerId,
    startY: event.clientY,
    startDb: limiterCeilingDb.value,
    moved: false,
  };
}

function scrubLimiterCeiling(event: PointerEvent) {
  const drag = limiterCeilingDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;

  const deltaY = drag.startY - event.clientY;
  if (!drag.moved && Math.abs(deltaY) < 3) return;
  if (!drag.moved) {
    drag.moved = true;
    drag.input.setPointerCapture(event.pointerId);
  }

  const steps = Math.round(deltaY / limiterCeilingDragPixelsPerStep);
  drag.input.value = normalizeLimiterCeiling(drag.startDb + steps * 0.1).toFixed(1);
  event.preventDefault();
}

async function finishLimiterCeilingDrag(event: PointerEvent) {
  const drag = limiterCeilingDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  limiterCeilingDrag = null;
  if (drag.input.hasPointerCapture(event.pointerId)) {
    drag.input.releasePointerCapture(event.pointerId);
  }
  if (!drag.moved) return;
  event.preventDefault();
  await commitLimiterCeiling(drag.input);
}

function cancelLimiterCeilingDrag(event: PointerEvent) {
  const drag = limiterCeilingDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  limiterCeilingDrag = null;
  drag.input.value = limiterCeilingDb.value.toFixed(1);
}

function toggleQuickPlays() {
  quickPlayVisibilityExplicit.value = true;
  quickPlayClosed.value = !quickPlayClosed.value;
  quickPlayFullscreen.value = false;
}

// Dynamic program-output bank. Main (0/1) is always represented and device
// overrides (2+) appear while active. Preview (30/31) has its own conditional
// Monitor strip on the opposite side of the workspace.
// Keeping the original selection rules here makes this a layout move only:
// the faders still write the same server-authoritative stereo channel gains.
// Which other output pairs have signal, as a plain key: the strips rebuild
// only when that changes, not on every meter frame (30 a second), which
// re-rendered the whole workspace. The meters update themselves.
const activeOverridePairs = computed(() => {
  const active = new Set((server.meters?.master_channels ?? []).map((meter: any) => meter.index as number));
  const pairs: number[] = [];
  for (let index = 2; index < 30; index += 2) {
    if (active.has(index) || active.has(index + 1)) pairs.push(index);
  }
  return pairs.join(',');
});

const outputPairs = computed(() => {
  const activeIndices = new Set(activeOverridePairs.value.split(',').filter(Boolean).map(Number));

  // Main plays through the output chosen in Settings (kept by its display
  // name), or the system default when none is chosen.
  const configured = (currentProject.value as any)?.settings?.defaultOutputDevice;
  const mainLabel = configured
    ? (server.devices.find((device: any) => device.display_name === configured || device.id === configured)
      ?.display_name ?? configured)
    : (server.devices.find((device: any) => device.is_default)?.display_name ?? 'Main');
  const pairs: Array<{
    key: string;
    leftIndex: number;
    rightIndex: number;
    label: string;
  }> = [];
  const overridePairs: typeof pairs = [];

  for (let index = 2; index < 30; index += 2) {
    if (activeIndices.has(index)) {
      overridePairs.push({
        key: `out-${index}`,
        leftIndex: index,
        rightIndex: index + 1,
        label: `Out ${index / 2}`,
      });
    }
  }

  pairs.push({ key: 'main', leftIndex: 0, rightIndex: 1, label: mainLabel });
  pairs.push(...overridePairs);

  return pairs;
});

const monitorAssigned = computed(() => !!(currentProject.value as any)?.settings?.previewDevice);

const monitorLabel = computed(() => {
  const deviceId = (currentProject.value as any)?.settings?.previewDevice;
  return server.devices.find((device: any) => device.id === deviceId)?.display_name ?? 'Monitor';
});

function getOutputGainDb(leftIndex: number): number {
  return server.outputChannelGains[leftIndex] ?? 0;
}

function onOutputGainInput(leftIndex: number, rightIndex: number, db: number) {
  const serverDb = db <= outputConsoleMinDb ? -120 : db;
  server.setOutputChannelGainDb(leftIndex, serverDb);
  server.setOutputChannelGainDb(rightIndex, serverDb);
}

function resetOutputGain(leftIndex: number, rightIndex: number) {
  server.setOutputChannelGainDb(leftIndex, 0);
  server.setOutputChannelGainDb(rightIndex, 0);
}

// Pointer events (not mouse events) so the splitter is draggable by touch and
// pen as well as mouse. Pointer capture keeps the drag alive when the finger
// slides off the 5px bar — without it a touch drag died on the first move,
// which is why the divider was effectively immovable on touch devices. The
// handle also carries `touch-action: none` so the browser doesn't claim the
// gesture for scrolling before we ever see a pointermove.
const startResize = (e: PointerEvent) => {
  // Ignore secondary mouse buttons and any second finger landing on the bar —
  // a concurrent drag would register a duplicate set of document listeners.
  if (isResizing.value || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
  quickPlayVisibilityExplicit.value = true;
  const handle = e.currentTarget as HTMLElement | null;
  isResizing.value = true;
  e.preventDefault();
  try { handle?.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }

  const handleMouseMove = (e: PointerEvent) => {
    if (!isResizing.value) return;

    const container = document.querySelector<HTMLElement>('.workspace-panels');
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const zoom = rect.width / container.offsetWidth || 1;
    const fromStart = getComputedStyle(container).direction === 'rtl' ? rect.right - e.clientX : e.clientX - rect.left;
    const newWidth = fromStart / zoom;

    // Snap zones
    const snapThreshold = 100; // pixels from edge to trigger snap
    
    // Snap closed at the bank's outer edge.
    if (newWidth < snapThreshold) {
      quickPlayClosed.value = true;
      quickPlayFullscreen.value = false;
      return;
    }
    
    // Expand the bank at the opposite edge.
    if (newWidth > container.offsetWidth - snapThreshold) {
      quickPlayFullscreen.value = true;
      quickPlayClosed.value = false;
      return;
    }
    
    // Normal resize
    quickPlayClosed.value = false;
    quickPlayFullscreen.value = false;
    quickPlayWidth.value = Math.round(newWidth);
  };
  
  const handleMouseUp = () => {
    isResizing.value = false;
    try { handle?.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    document.removeEventListener('pointermove', handleMouseMove);
    document.removeEventListener('pointerup', handleMouseUp);
    document.removeEventListener('pointercancel', handleMouseUp);
  };

  document.addEventListener('pointermove', handleMouseMove);
  document.addEventListener('pointerup', handleMouseUp);
  // A touch drag interrupted by the OS (gesture takeover, call, etc.) fires
  // pointercancel instead of pointerup — without this the handle stayed "stuck"
  // to the finger and kept resizing on the next touch anywhere.
  document.addEventListener('pointercancel', handleMouseUp);
};

// Listen for menu events
if (import.meta.client && window.electronAPI) {
  window.electronAPI.onMenuSaveProject(() => {
    // File > Save always writes to disk, even when autosave is off.
    saveProject({ force: true });
  });

  window.electronAPI.onMenuCloseProject(async () => {
    if (!(await confirmUnsavedChanges())) return;
    void closeProject();
  });

  window.electronAPI.onMenuOpenProjectFolder(() => {
    if (currentProject.value) {
      window.electronAPI.openFolder(currentProject.value.folderPath);
    }
  });

  // QuickPlay window detach/attach
  window.electronAPI.onDetachedQuickPlayWindowOpened(() => {
    quickPlayDetached.value = true;
  });
  window.electronAPI.onDetachedQuickPlayWindowClosed(() => {
    quickPlayDetached.value = false;
  });

}

// Keep the main process HTTP API server up-to-date with the full project state.
// Waveform peak arrays are stripped from the bulk playlist (large, and API
// consumers don't need them), but PRESERVED for items the detached QuickPlay
// window has to render: QuickPlay-only items, plus any playlist item referenced
// by a QuickPlay slot. Without this the detached QuickPlay window's waveform canvases
// stay blank because it can't poll the project folder when the server is
// remote.
// NOTE: This watcher should NOT run in QuickPlay window mode to avoid feedback loops.
const stripWaveformsKeeping = (items: any[], keep: Set<string>): any[] =>
  items.map(item => {
    const copy: any = { ...item };
    if (!keep.has(item.uuid)) copy.waveform = null;
    if (copy.children) copy.children = stripWaveformsKeeping(copy.children, keep);
    return copy;
  });

// Check if this is QuickPlay window mode by looking at URL query param
const isQuickPlayWindowMode = import.meta.client
  ? new URLSearchParams(window.location.search).get('quickPlayWindow') === '1'
  : false;

watch(
  [currentProject, projectSyncIdentity, projectHydrationStatus, () => server.projectSessionId,
    () => server.connected && !server.cueStartsBlocked],
  ([project, identity, hydrationStatus, sessionId, verified]) => {
    // Only sync from the main window, not from the detached QuickPlay window.
    if (!import.meta.client || !window.electronAPI || isQuickPlayWindowMode) return;
    if (!project || !identity || hydrationStatus !== 'ready') {
      window.electronAPI.syncProjectData(null, null);
      return;
    }
    if (!verified || !sessionId) return;
    const quickPlayReferenced = new Set<string>([
      ...flattenQuickPlays(project.items || []).map(item => item.uuid),
      ...(project.quickPlaySlots || []).map((ci: any) => ci.itemUuid).filter(Boolean),
    ]);
    const data = {
      ...project,
      items: stripWaveformsKeeping(project.items || [], quickPlayReferenced),
      // QuickPlay-only items always keep their waveform — the detached QuickPlay window
      // needs them and QuickPlays are bounded to 64 slots.
      quickPlayItems: Array.from(quickPlayItems.value.values()).map(i => ({ ...i })),
    };
    window.electronAPI.syncProjectData(JSON.parse(JSON.stringify(data)), identity, sessionId);
  },
  { deep: true, immediate: true },
);

// True when the user is typing in a text field — selection/clipboard
// shortcuts must defer to native editing behaviour there.
const isTextInputFocused = (): boolean => {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || el.isContentEditable;
};

const isForwardedFromVideoOutput = (e: KeyboardEvent): boolean =>
  (e as KeyboardEvent & { dwcueForwardedFromVideoOutput?: boolean })
    .dwcueForwardedFromVideoOutput === true;

function handlePanelKeydown(event: KeyboardEvent, beforeTabNavigation = false) {
  if (event.defaultPrevented) return;
  const target = event.target as HTMLElement | null;
  // A remapped Stop All must reach transport before tab navigation consumes it.
  if (beforeTabNavigation && !target?.closest?.('[role="tab"]')) return;
  const stop = playbackMappings.value['stop-all'];
  const typing = isTextInputFocused() && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
  if (!typing && stop && bindingsMatch(stop, eventToBinding(event))) {
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) void stopAllCues();
    return;
  }
  if (beforeTabNavigation) return;
  if (target?.closest?.('select') ||
      ['Delete', 'Backspace'].includes(event.key) ||
      (['Enter', ' '].includes(event.key) && target?.closest?.('button, a[href], summary'))) event.stopPropagation();
}

const handleKeydown = (e: KeyboardEvent) => {
  if (e.defaultPrevented || projectHydrationStatus.value !== 'ready') return;
  // Save on F1 key (alternative to big play button)
  if (e.key === 'F1') {
    e.preventDefault();
    if (selectedItem.value && selectedItem.value.type === 'audio') {
      const { playCue } = useAudioEngine();
      void playCue(selectedItem.value as any);
    }
    return;
  }

  // F2 writes a playlist note on the one selected cue or group, in Edit Mode.
  if (e.key === 'F2') {
    if (uiMode.value !== 'playback' && !isTextInputFocused() && selectedItems.value.size === 1) {
      e.preventDefault();
      noteEditRequest.value = Array.from(selectedItems.value)[0] ?? null;
    }
    return;
  }

  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const destructiveShortcut = e.key === 'Delete' || e.key === 'Backspace' ||
    (ctrl && !e.altKey && (key === 'd' || key === 'v'));
  if (uiMode.value === 'playback' && (!isTextInputFocused() || isForwardedFromVideoOutput(e)) && destructiveShortcut) {
    e.preventDefault();
    return;
  }

  // Delete / Backspace removes the current selection. A multi-selection opens
  // the confirmation panel; a single item is removed outright. Must defer to
  // native editing inside text fields.
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if ((!isForwardedFromVideoOutput(e) && isTextInputFocused()) || !currentProject.value) return;
    if (requestDeleteFromKeyboard()) e.preventDefault();
    return;
  }

  // Selection / clipboard shortcuts. These all require a project and must not
  // fire while editing text (so native Ctrl+A/C/V keep working in inputs).
  if (!ctrl || e.altKey || !currentProject.value ||
      (!isForwardedFromVideoOutput(e) && isTextInputFocused())) return;

  if (key === 'a') {
    e.preventDefault();
    selectAllItems();
  } else if (key === 'd') {
    e.preventDefault();
    const uuids = Array.from(selectedItems.value);
    if (uuids.length > 0) duplicateItems(uuids);
  } else if (key === 'c') {
    if (!isForwardedFromVideoOutput(e) && (window.getSelection()?.isCollapsed === false ||
        (e.target as HTMLElement | null)?.closest?.('.lower-workspace-panel'))) return;
    const uuids = Array.from(selectedItems.value);
    if (uuids.length > 0) {
      e.preventDefault();
      void copyItemsToClipboard(uuids);
    }
  } else if (key === 'v') {
    e.preventDefault();
    void pasteItemsFromClipboard();
  } else if (key === 'f' && !e.shiftKey && !isForwardedFromVideoOutput(e)) {
    // Find: put the cursor in the playlist search field (see PlaylistSearch).
    e.preventDefault();
    playlistSearchFocusRequest.value++;
  }
};

onMounted(() => {
  if (import.meta.client) {
    mountHotkeys();
    window.addEventListener('keydown', handleKeydown);
    panelObserver = new ResizeObserver(() => {
      visiblePanelHeight.value = lowerPanel.value?.offsetHeight ?? 0;
      if (visiblePanelHeight.value) panelMaxHeight.value = availablePanelHeight();
    });
    if (lowerPanel.value) panelObserver.observe(lowerPanel.value);
    if (workspaceContent.value) panelObserver.observe(workspaceContent.value);
  }
});

onUnmounted(() => {
  if (import.meta.client) {
    panelObserver?.disconnect();
    unmountHotkeys();
    window.removeEventListener('keydown', handleKeydown);
  }
});
</script>

<style scoped lang="scss">
.main-workspace {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-background);
}

.workspace-content {
  flex: 1 1 0;
  min-height: calc(var(--panel-header-height) + var(--reserved-playlist-row-height) + 2 * var(--workspace-gutter));
  display: flex;
  overflow: hidden;
  position: relative;
  background: var(--color-background);
}

.preview-lower-panel {
  flex: 0 0 auto;
  box-sizing: border-box;
  padding: var(--spacing-xs) var(--workspace-gutter);
  overflow: hidden;
  background: var(--color-surface);
  border-top: 1px solid var(--color-border);
}

.preview-lower-panel:empty {
  display: none;
}

.workspace-status {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 2px var(--workspace-gutter);
  border-top: 1px solid var(--color-border);
  background: var(--color-surface);
}

.workspace-status:empty { display: none; }
.repair-status {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--spacing-xs);
  margin-inline-start: auto;
  color: var(--color-text-secondary);
  font-size: var(--type-metadata-size);
}
.workspace-status .repair-review { flex: none; color: var(--color-warning); }

.lower-workspace-panel {
  position: relative;
  flex: 0 1 auto;
  min-height: 120px;
  display: flex;
  flex-direction: column;
}

.lower-workspace-panel--deciding {
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;

  > :not(#workspace-project-decision) { display: none; }
}

.lower-workspace-panel--browsing-files :deep(.picker-dock) {
  flex: 1 1 clamp(300px, 52vh, 620px);
  overflow: auto;
}

.workspace-import {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--color-border);
  background: var(--color-background);
}

.workspace-import-close {
  display: grid;
  place-items: center;
  width: var(--panel-control-height);
  height: var(--panel-control-height);
  padding: 0;
  border: 0;
  border-radius: var(--control-radius);
  background: none;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.workspace-import-resize {
  margin-left: auto;
}

.workspace-import-close:hover {
  background: var(--color-surface-hover);
}

.workspace-capture {
  padding: var(--spacing-sm) var(--workspace-gutter);
}

.workspace-import-host {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  container-type: inline-size;
  // A column, so an importer can give its list all the height the panel has.
  display: flex;
  flex-direction: column;
}

.workspace-import-host--archive {
  display: flex;
  flex-direction: column;
}

.lower-panel-resize-handle {
  position: absolute;
  z-index: 2;
  inset: -6px calc(50% - 48px) auto;
  height: 12px;
  cursor: ns-resize;
  touch-action: none;
}

.lower-panel-resize-handle::after {
  content: '';
  position: absolute;
  top: 5px;
  left: calc(50% - 24px);
  width: 48px;
  height: 2px;
  background: var(--color-border-strong);
}

.lower-panel-resize-handle:hover::after,
.lower-panel-resize-handle:focus-visible::after {
  background: var(--color-accent);
}

.workspace-panels {
  flex: 1;
  min-width: 0;
  display: flex;
  overflow: hidden;
  position: relative;
  container-type: inline-size;
}

.playlist-section {
  isolation: isolate;
  flex: 1 1 0;
  width: auto;
  min-width: var(--playlist-split-min-width);
  overflow: hidden;
  display: flex;
  min-height: 0;
}

.playlist-panel {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.output-console {
  display: flex;
  flex-direction: column;
  flex: 0 0 var(--output-console-width);
  width: var(--output-console-width);
  min-height: 0;
  overflow: hidden;
  background: var(--color-surface);
  border-inline-start: 1px solid var(--color-border);
}

.output-console--collapsed {
  flex-basis: 36px;
  width: 36px;
}

/* Slim: the limiter controls need the rest of this narrow header. */
.output-console__fold {
  flex: none;
  display: grid;
  place-items: center;
  width: 18px;
  margin-inline: -6px -2px;
  height: var(--panel-control-height);
  padding: 0;
  border: 0;
  border-radius: var(--control-radius);
  background: none;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.output-console__fold:hover {
  background: var(--color-surface-hover);
  color: var(--color-text-primary);
}

.output-console__fold--rail {
  align-content: start;
  gap: var(--spacing-sm);
  width: 100%;
  height: 100%;
  padding-top: var(--spacing-sm);
  border-radius: 0;
}

.output-console__rail-label {
  writing-mode: vertical-rl;
  font-size: 12px;
  letter-spacing: 0.04em;
}

.monitor-console {
  border-inline-start: 0;
  border-inline-end: 1px solid var(--color-border);
}

.output-console__strips {
  display: flex;
  flex: 1;
  gap: var(--spacing-sm);
  min-height: 0;
  overflow-x: auto;
  overflow-y: auto;
  padding: var(--spacing-sm);
  background: var(--color-background);
  box-shadow: none;
}

.output-console__header {
  gap: var(--spacing-xs);
  padding-block: 2px;
}

.output-console__header-controls {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: flex-end;
  gap: var(--spacing-sm);
  width: 100%;
  min-width: 0;
}

.limiter-ceiling-control {
  display: flex;
  align-items: center;
  flex: 1 1 0;
  min-width: 0;
  height: calc(var(--panel-control-height) + 6px);
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background: var(--color-control);
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast);

  &:hover,
  &:focus-within {
    background: var(--color-surface-hover);
    border-color: var(--color-border-strong);
  }
}

.limiter-ceiling-value {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 20px;
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  height: 100%;
  background: var(--color-control);
}

.limiter-ceiling-input {
  width: 100%;
  height: 100%;
  min-width: 0;
  padding: 0 2px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--color-warning);
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 600;
  text-align: center;
  font-variant-numeric: tabular-nums;
  cursor: ns-resize;
  touch-action: none;
  user-select: none;

  &::-webkit-inner-spin-button,
  &::-webkit-outer-spin-button {
    appearance: none;
    margin: 0;
  }

  &:focus-visible {
    outline: 2px solid var(--color-focus-ring);
    outline-offset: 1px;
  }

  &.is-danger {
    color: var(--color-danger);
  }
}

.limiter-ceiling-steppers {
  display: grid;
  grid-template-rows: 1fr 1fr;
  width: 20px;
  height: 100%;
  overflow: hidden;
  border-left: 1px solid var(--color-border);
  border-radius: 0 var(--control-radius) var(--control-radius) 0;

  button {
    display: grid;
    place-items: center;
    min-width: 0;
    min-height: 0;
    padding: 0;
    color: var(--color-text-secondary);
    background: var(--color-control);

    &:first-child {
      border-bottom: 1px solid var(--color-border);
    }

    &:hover:not(:disabled),
    &:focus-visible {
      color: var(--color-text-primary);
      background: var(--color-surface-hover);
    }
  }

  .material-symbols-rounded {
    font-size: 14px;
    line-height: 1;
  }
}

.limiter-toggle {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 92px;
  height: calc(var(--panel-control-height) + 6px);
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background: var(--color-control);
  color: var(--color-text-secondary);
  line-height: 1;
  cursor: pointer;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);

  &.is-enabled {
    background: color-mix(in srgb, var(--color-success) 12%, var(--color-control));
    border-color: color-mix(in srgb, var(--color-success) 55%, var(--color-border));
    color: var(--color-text-primary);
  }

  &:hover {
    background: var(--color-surface-hover);
    border-color: var(--color-border-strong);
    color: var(--color-text-primary);
  }

  &.is-enabled:hover {
    background: color-mix(in srgb, var(--color-success) 16%, var(--color-control));
    border-color: color-mix(in srgb, var(--color-success) 65%, var(--color-border));
  }

  &:focus-visible {
    outline: 2px solid var(--color-focus-ring);
    outline-offset: 2px;
  }
}

.limiter-toggle__label {
  font-size: 13.5px;
  font-weight: 650;
}

.limiter-toggle__gr {
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;

  &.is-reducing {
    color: var(--color-warning);
  }
}

.output-pair {
  position: relative;
  display: flex;
  flex: 0 0 var(--output-strip-width);
  min-height: 144px;
  align-items: stretch;
  border-radius: var(--control-radius);
  box-shadow: none;
}

.output-pair :deep(.stereo-meter--strip) {
  background: var(--color-surface);
  border-color: var(--color-border);
  box-shadow: none;
}

.output-pair__fader {
  display: contents;
}

.resize-handle {
  width: var(--resize-handle-width);
  background: var(--color-border);
  cursor: col-resize;
  transition: background-color var(--transition-fast);
  position: relative;
  z-index: 10;
  flex: 0 0 auto;
  /* Claim the gesture outright: without this the browser treats a touch-drag
     on the bar as a pan and never delivers pointermove to us. */
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;

  /* Invisible grab zone. A 5px bar is a fine mouse target but far below the
     ~24px a finger can reliably hit, so widen the *hit* area without moving the
     pixels the user sees. Only on touch-capable displays — on a pure mouse
     setup the extra 20px would steal clicks from adjacent content for no gain. */
  &::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: -4px;
    right: -4px;
  }

  @media (any-pointer: coarse) {
    &::before {
      left: -10px;
      right: -10px;
    }
  }

  &:hover {
    background: var(--color-accent);
  }

  &:active,
  &.dragging {
    background: var(--color-accent);
  }

  &.collapsed-left {
    position: absolute;
    inset-inline-start: 0;
    top: var(--panel-header-height);
    bottom: 0;
    width: 8px;
    background: transparent;

    /* Collapsed states float ON TOP of a panel, so the grab zone may only grow
       inward — growing outward too would swallow taps on the panel behind it. */
    @media (any-pointer: coarse) {
      &::before {
        inset-inline-start: 0;
        inset-inline-end: -16px;
      }
    }

    &::after {
      content: '';
      position: absolute;
      inset-inline-start: 0;
      top: 0;
      bottom: 0;
      width: 1px;
      background-color: var(--color-border);
      opacity: 1;
    }
    
    &:hover::after {
      width: 4px;
      background-color: var(--color-accent);
      opacity: 1;
    }

  }
  
  &.collapsed-right {
    position: absolute;
    inset-inline-end: 0;
    top: var(--panel-header-height);
    bottom: 0;
    width: 8px;
    background: transparent;

    @media (any-pointer: coarse) {
      &::before {
        inset-inline-start: -16px;
        inset-inline-end: 0;
      }
    }

    &::after {
      content: '';
      position: absolute;
      inset-inline-end: 0;
      top: 0;
      bottom: 0;
      width: 1px;
      background-color: var(--color-border);
      opacity: 1;
    }
    
    &:hover::after {
      width: 4px;
      background-color: var(--color-accent);
      opacity: 1;
    }

  }
}

.quickplay-toggle {
  display: grid;
  place-items: center;
  flex: 0 0 var(--panel-control-height);
  width: var(--panel-control-height);
  height: var(--panel-control-height);
  padding: 0;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--control-radius);
  background: var(--color-surface-raised);
  color: var(--color-text-primary);
  cursor: pointer;

  :deep(.cue-symbol) {
    font-size: 20px;
  }


  &.quickplay-toggle--reveal {
    width: auto;
    flex-basis: auto;
    grid-auto-flow: column;
    gap: 6px;
    padding-inline: 10px;
  }

  .quickplay-toggle__label {
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }
  &.quickplay-toggle--open {
    color: var(--color-accent-text);
    border-color: var(--color-accent);
  }

  &:hover {
    color: var(--color-accent-text);
    border-color: var(--color-accent);
    background: var(--color-surface-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
}

.quickplay-toggle__collapse:dir(rtl) { transform: scaleX(-1); }

.quickplay-section {
  --quickplay-max-width: calc(100% - var(--playlist-split-min-width) - var(--resize-handle-width));
  flex: 0 0 auto;
  min-width: min(220px, var(--quickplay-max-width));
  max-width: var(--quickplay-max-width);
  overflow: hidden;

  &.quickplay-section--fullscreen {
    max-width: none;
  }
}

/* Let the existing compact cue rows reflow before either panel loses its controls. */
@container (max-width: 940px) {
  .playlist-section {
    min-width: 0;
  }

  .quickplay-section:not(.quickplay-section--fullscreen) {
    --quickplay-max-width: min(32%, 280px);
    min-width: min(170px, var(--quickplay-max-width));
  }
}
</style>
