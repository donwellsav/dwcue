<template>
  <div class="main-workspace" :class="{ 'show-mode': uiMode === 'playback' }">
    <!-- Show Mode reuses the full editor layout (header, transport, resizable/
         detachable playlist⇄cart split). It is not a separate view: the child
         components read useUiMode() and hide their edit affordances + enlarge
         touch targets, so waveforms, colours, durations, behaviour flags and
         warnings all render exactly as in edit mode. -->
    <ProjectHeader />
    <PlaybackControls />
    <LevelCheckBar />

    <div class="workspace-content">
      <aside
        v-if="monitorAssigned"
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
          v-if="!cartClosed && !cartDetached"
          id="cart-player-panel"
          class="cart-section"
          :class="{ 'cart-section--fullscreen': cartFullscreen }"
          :style="{ width: cartFullscreen ? '100%' : `${cartWidth}px` }"
        >
          <OneShotPanel>
            <template #header-leading>
              <button
                type="button"
                class="cart-toggle cart-toggle--open"
                :aria-label="t('oneShots.hide')"
                :title="t('oneShots.hide')"
                :aria-expanded="true"
                aria-controls="cart-player-panel"
                @click="toggleCart"
              >
                <span class="material-symbols-rounded" aria-hidden="true">view_sidebar</span>
              </button>
            </template>
          </OneShotPanel>
        </div>

        <div
          v-if="!cartDetached"
          class="resize-handle"
          :class="{ 'collapsed-left': cartClosed, 'collapsed-right': cartFullscreen, dragging: isResizing }"
          @pointerdown="startResize"
        ></div>

        <div v-if="!cartFullscreen || cartDetached" class="playlist-section">
          <div class="playlist-panel">
            <PlaylistView>
              <template #header-leading>
                <button
                  v-if="cartClosed && !cartDetached"
                  type="button"
                  class="cart-toggle"
                  :aria-label="t('oneShots.show')"
                  :title="t('oneShots.show')"
                  :aria-expanded="false"
                  @click="toggleCart"
                >
                  <span class="material-symbols-rounded" aria-hidden="true">view_sidebar</span>
                </button>
              </template>
            </PlaylistView>
          </div>
        </div>
      </div>

      <aside class="output-console" :aria-label="t('properties.output')">
        <div class="output-console__header workspace-panel-header">
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
              <span class="limiter-toggle__gr">{{ limiterGainReductionLabel }}</span>
            </button>
            <div class="limiter-ceiling-control">
              <div class="limiter-ceiling-value">
                <input
                  ref="limiterCeilingInput"
                  type="number"
                  class="limiter-ceiling-input"
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
        <div class="output-console__strips">
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

    <ShortcutsBar />
    
    <PropertiesPanel
      v-if="propertiesPanelOpen && selectedItem && (uiMode !== 'playback' || selectedItem.uuid === previewItemUuid)"
    />

    <ProgressModal
      :visible="progressModal.visible"
      :title="progressModal.title"
      :message="progressModal.message"
      :percentage="progressModal.percentage"
    />

    <!-- Export: server vs client choice (only shown for remote servers). -->
    <LocationChoiceModal
      :visible="exportChoiceVisible"
      :title="t('exportProject.chooseLocationTitle')"
      :message="t('exportProject.chooseLocationMessage')"
      :server-label="t('exportProject.saveOnServer')"
      :client-label="t('exportProject.downloadHere')"
      :cancel-label="t('common.cancel')"
      @pick="onExportChoice"
      @cancel="exportChoiceVisible = false"
    />

    <!-- Server file picker (directory mode) for "save on server" path. -->
    <ServerFilePickerModal
      :open="exportServerPickerOpen"
      mode="directory"
      filter="all"
      :filter-options="['all']"
      :start-path="currentProject?.folderPath ?? ''"
      @pick="onExportServerPath"
      @close="exportServerPickerOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import LevelCheckBar from './LevelCheckBar.vue';
import LocationChoiceModal from './LocationChoiceModal.vue';
import ServerFilePickerModal from './ServerFilePickerModal.vue';
import StereoMeter from './StereoMeter.vue';
import VolumeSlider from './VolumeSlider.vue';
import { flattenOneShots } from '~/utils/oneShots';

const {
  selectedItem,
  selectedItems,
  propertiesPanelOpen,
  previewItemUuid,
  saveProject,
  closeProject,
  confirmUnsavedChanges,
  currentProject,
  selectAllItems,
  duplicateItems,
  copyItemsToClipboard,
  pasteItemsFromClipboard,
  requestDeleteFromKeyboard,
} = useProject();
const { cartOnlyItems } = useCartItems();
const { t } = useLocalization();
const server = useLiveplayServer();
const { uiMode } = useUiMode();
const { levels: outputTargetLevels } = useOutputTarget();

// Progress modal state
const progressModal = ref({
  visible: false,
  title: '',
  message: '',
  percentage: 0
});

// Resizable cart width
const cartWidth = ref(300);
const isResizing = ref(false);
const cartClosed = ref(false);
const cartFullscreen = ref(false);
const cartDetached = ref(false);
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
const limiterGainReductionLabel = computed(() => {
  const channels = server.meters?.master_channels ?? [];
  const left = channels.find(channel => channel.index === 0)?.gain_reduction_db ?? 0;
  const right = channels.find(channel => channel.index === 1)?.gain_reduction_db ?? 0;
  return `GR −${Math.abs(Math.min(0, left, right)).toFixed(1)}`;
});

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

function toggleCart() {
  cartClosed.value = !cartClosed.value;
  cartFullscreen.value = false;
}

// Dynamic program-output bank. Main (0/1) is always represented and device
// overrides (2+) appear while active. Preview (30/31) has its own conditional
// Monitor strip on the opposite side of the workspace.
// Keeping the original selection rules here makes this a layout move only:
// the faders still write the same server-authoritative stereo channel gains.
const outputPairs = computed(() => {
  const meters = server.meters;
  const activeIndices = new Set(
    (meters?.master_channels ?? []).map((meter: any) => meter.index as number),
  );

  const configuredId = (currentProject.value as any)?.settings?.defaultOutputDevice;
  const mainLabel = configuredId
    ? (server.devices.find((device: any) => device.id === configuredId)?.display_name ?? 'Main')
    : (server.devices.find((device: any) => device.is_default)?.display_name ?? 'Main');
  const pairs: Array<{
    key: string;
    leftIndex: number;
    rightIndex: number;
    label: string;
  }> = [];
  const overridePairs: typeof pairs = [];

  for (let index = 2; index < 30; index += 2) {
    if (activeIndices.has(index) || activeIndices.has(index + 1)) {
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
  const handle = e.currentTarget as HTMLElement | null;
  isResizing.value = true;
  e.preventDefault();
  try { handle?.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }

  const handleMouseMove = (e: PointerEvent) => {
    if (!isResizing.value) return;

    const container = document.querySelector('.workspace-panels');
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const newWidth = e.clientX - rect.left;

    // Snap zones
    const snapThreshold = 100; // pixels from edge to trigger snap
    const handleWidth = Number.parseFloat(
      getComputedStyle(container).getPropertyValue('--resize-handle-width'),
    ) || 1;
    const minPlaylistWidth = Number.parseFloat(
      getComputedStyle(container).getPropertyValue('--playlist-split-min-width'),
    ) || 577;
    const maxWidth = Math.max(0, rect.width - handleWidth - minPlaylistWidth);
    const minWidth = Math.min(300, maxWidth);
    
    // Check for close snap (dragging very close to left edge)
    if (newWidth < snapThreshold) {
      cartClosed.value = true;
      cartFullscreen.value = false;
      return;
    }
    
    // Check for fullscreen snap (dragging very close to right edge)
    if (newWidth > rect.width - snapThreshold) {
      cartFullscreen.value = true;
      cartClosed.value = false;
      return;
    }
    
    // Normal resize
    cartClosed.value = false;
    cartFullscreen.value = false;
    cartWidth.value = Math.round(Math.max(minWidth, Math.min(maxWidth, newWidth)));
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

  window.electronAPI.onMenuExportProject(() => {
    startExportFlow();
  });

  window.electronAPI.onMenuCloseProject(async () => {
    if (!(await confirmUnsavedChanges())) return;
    void closeProject();
  });

  // File > New and File > Open while a project is already open: close the
  // current project (locally + on the server) and stash the intent so the
  // welcome screen pops the corresponding picker as soon as it mounts.
  // Without this, these menu items were silent when something was open —
  // only WelcomeScreen used to subscribe, and it isn't mounted right now.
  window.electronAPI.onMenuNewProject(async () => {
    if (!(await confirmUnsavedChanges())) return;
    try { sessionStorage.setItem('liveplay:welcomeIntent', 'new'); } catch {}
    await closeProject();
  });

  window.electronAPI.onMenuOpenProject(async () => {
    if (!(await confirmUnsavedChanges())) return;
    try { sessionStorage.setItem('liveplay:welcomeIntent', 'open'); } catch {}
    await closeProject();
  });

  // File > Open Recent > <project> while a project is already open. Same
  // shape as onMenuOpenProject, but we stash the exact path so the welcome
  // screen opens it directly instead of popping the file picker.
  window.electronAPI.onMenuOpenRecentProject(async (_e, projectPath) => {
    if (!projectPath) return;
    if (!(await confirmUnsavedChanges())) return;
    try { sessionStorage.setItem('liveplay:welcomeOpenPath', projectPath); } catch {}
    await closeProject();
  });

  window.electronAPI.onMenuOpenProjectFolder(() => {
    if (currentProject.value) {
      window.electronAPI.openFolder(currentProject.value.folderPath);
    }
  });

  // Cart window detach/attach
  window.electronAPI.onCartPlayerWindowOpened(() => {
    cartDetached.value = true;
  });
  window.electronAPI.onCartPlayerWindowClosed(() => {
    cartDetached.value = false;
  });

}

// ---------------------------------------------------------------------------
// Export project flow (dual-dialog when the server is on another machine).
// ---------------------------------------------------------------------------
// When server runs locally, jump straight to a server-side directory picker.
// Otherwise, ask the user where to save: on the server, or back to this
// computer (via a one-shot download token). This replaces the old purely-
// Electron archiver path, which only worked when the project files were
// reachable from this machine.
const exportChoiceVisible   = ref(false);
const exportServerPickerOpen = ref(false);

async function startExportFlow() {
  if (!currentProject.value) return;
  if (server.isLocalServer) {
    // Local: skip the choice modal and go straight to the server picker
    // (the "server" here is this same computer, so this matches the user's
    // expectation of a familiar OS-style directory chooser).
    exportServerPickerOpen.value = true;
  } else {
    exportChoiceVisible.value = true;
  }
}

async function onExportChoice(choice: 'server' | 'client') {
  exportChoiceVisible.value = false;
  if (!currentProject.value) return;

  if (choice === 'server') {
    exportServerPickerOpen.value = true;
    return;
  }

  // client → server packages to its temp dir, returns a token, we download
  // the blob and save it via Electron's native save dialog.
  await exportToClientDownload();
}

async function onExportServerPath(serverDir: string) {
  exportServerPickerOpen.value = false;
  if (!serverDir || !currentProject.value) return;
  const project = currentProject.value;
  const outPath = `${serverDir.replace(/[\\/]+$/, '')}/${project.name}.lpa`;
  await runExport({ outputPath: outPath });
}

async function exportToClientDownload() {
  if (!currentProject.value) return;
  const project = currentProject.value;
  const defaultName = `${project.name}.lpa`;
  // Pick the local destination FIRST so a cancelled save dialog doesn't
  // leave a stray .lpa sitting in the server's temp dir.
  const localDest = await window.electronAPI.showSaveArchiveDialog(defaultName);
  if (!localDest) return;
  await runExport({ outputPath: '', downloadTo: localDest });
}

async function runExport(opts: { outputPath: string; downloadTo?: string }) {
  if (!currentProject.value) return;
  const project = currentProject.value;
  progressModal.value = {
    visible: true,
    title: t('exportProgress.title'),
    message: `${t('exportProgress.message')} ${project.name}.lpa…`,
    percentage: 30,
  };
  try {
    if (!(await saveProject({ force: true }))) {
      throw new Error('Project must be saved before it can be exported');
    }
    const result = await server.exportProjectArchive(
      project.folderPath, project.name, opts.outputPath);
    progressModal.value.percentage = opts.downloadTo ? 60 : 100;

    if (opts.downloadTo && result.downloadToken) {
      progressModal.value.message =
        `${t('exportProgress.downloading')} ${project.name}.lpa…`;
      await server.downloadArchiveToFile(result.downloadToken, opts.downloadTo);
    }
    progressModal.value.percentage = 100;
  } catch (e) {
    console.error('Export failed:', e);
    server.lastError = `Export failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    setTimeout(() => { progressModal.value.visible = false; }, 400);
  }
}

// Keep the main process HTTP API server up-to-date with the full project state.
// Waveform peak arrays are stripped from the bulk playlist (large, and API
// consumers don't need them), but PRESERVED for items the detached cart
// window has to render: cart-only items, plus any playlist item referenced
// by a cart slot. Without this the detached cart window's waveform canvases
// stay blank because it can't poll the project folder when the server is
// remote.
// NOTE: This watcher should NOT run in cart window mode to avoid feedback loops.
const stripWaveformsKeeping = (items: any[], keep: Set<string>): any[] =>
  items.map(item => {
    const copy: any = { ...item };
    if (!keep.has(item.uuid)) copy.waveform = null;
    if (copy.children) copy.children = stripWaveformsKeeping(copy.children, keep);
    return copy;
  });

// Check if this is cart window mode by looking at URL query param
const isCartWindowMode = import.meta.client
  ? new URLSearchParams(window.location.search).get('cartWindow') === '1'
  : false;

watch(currentProject, (project) => {
  // Only sync from main window, not from detached cart window
  if (!import.meta.client || !window.electronAPI || !project || isCartWindowMode) return;
  const cartReferenced = new Set<string>([
    ...flattenOneShots(project.items || []).map(item => item.uuid),
    ...(project.cartItems || []).map((ci: any) => ci.itemUuid).filter(Boolean),
  ]);
  const data = {
    ...project,
    items: stripWaveformsKeeping(project.items || [], cartReferenced),
    // Cart-only items always keep their waveform — the detached cart window
    // needs them and the cart is bounded to 64 slots.
    cartOnlyItems: Array.from(cartOnlyItems.value.values()).map(i => ({ ...i }))
  };
  window.electronAPI.syncProjectData(JSON.parse(JSON.stringify(data)));
}, { deep: true, immediate: true });

// True when the user is typing in a text field — selection/clipboard
// shortcuts must defer to native editing behaviour there.
const isTextInputFocused = (): boolean => {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || el.isContentEditable;
};

const handleKeydown = (e: KeyboardEvent) => {
  // Save on F1 key (alternative to big play button)
  if (e.key === 'F1') {
    e.preventDefault();
    if (selectedItem.value && selectedItem.value.type === 'audio') {
      const { playCue } = useAudioEngine();
      playCue(selectedItem.value as any);
    }
    return;
  }

  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const destructiveShortcut = e.key === 'Delete' || e.key === 'Backspace' ||
    (ctrl && !e.altKey && (key === 'd' || key === 'v'));
  if (uiMode.value === 'playback' && !isTextInputFocused() && destructiveShortcut) {
    e.preventDefault();
    return;
  }

  // Delete / Backspace removes the current selection. A multi-selection opens
  // the confirm dialog; a single item is removed outright. Must defer to
  // native editing inside text fields.
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (isTextInputFocused() || !currentProject.value) return;
    if (requestDeleteFromKeyboard()) e.preventDefault();
    return;
  }

  // Selection / clipboard shortcuts. These all require a project and must not
  // fire while editing text (so native Ctrl+A/C/V keep working in inputs).
  if (!ctrl || e.altKey || !currentProject.value || isTextInputFocused()) return;

  if (key === 'a') {
    e.preventDefault();
    selectAllItems();
  } else if (key === 'd') {
    e.preventDefault();
    const uuids = Array.from(selectedItems.value);
    if (uuids.length > 0) duplicateItems(uuids);
  } else if (key === 'c') {
    const uuids = Array.from(selectedItems.value);
    if (uuids.length > 0) {
      e.preventDefault();
      void copyItemsToClipboard(uuids);
    }
  } else if (key === 'v') {
    e.preventDefault();
    void pasteItemsFromClipboard();
  }
};

onMounted(() => {
  if (import.meta.client) {
    window.addEventListener('keydown', handleKeydown);
  }
});

onUnmounted(() => {
  if (import.meta.client) {
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

.main-workspace.show-mode {
  // PlaylistView contributes 16px of horizontal gutters; 637px leaves the
  // row container at 621px, safely above its 620px compact breakpoint.
  --playlist-split-min-width: 637px;
}

.workspace-content {
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
  background: var(--color-background);
}

.preview-lower-panel {
  flex: 0 0 112px;
  height: 112px;
  box-sizing: border-box;
  padding: var(--workspace-gutter);
  overflow: hidden;
  background: var(--color-surface);
  border-top: 1px solid var(--color-border);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--color-text-primary) 4%, transparent);
}

.preview-lower-panel:empty {
  display: none;
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
  border-left: 1px solid var(--color-border);
}

.monitor-console {
  border-left: 0;
  border-right: 1px solid var(--color-border);
}

.output-console__strips {
  display: flex;
  flex: 1;
  gap: var(--spacing-sm);
  min-height: 0;
  overflow-x: auto;
  overflow-y: hidden;
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
  background: var(--color-surface-raised);
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
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 700;
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
  background: var(--color-surface-raised);
  color: var(--color-text-secondary);
  line-height: 1;
  cursor: pointer;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    box-shadow var(--transition-fast),
    color var(--transition-fast);

  &.is-enabled {
    background: color-mix(in srgb, var(--color-success) 12%, var(--color-surface-raised));
    border-color: color-mix(in srgb, var(--color-success) 55%, var(--color-border));
    color: var(--color-text-primary);
    box-shadow: 0 0 10px color-mix(in srgb, var(--color-success) 25%, transparent);
  }

  &:hover {
    background: var(--color-surface-hover);
    border-color: var(--color-border-strong);
    color: var(--color-text-primary);
  }

  &.is-enabled:hover {
    background: color-mix(in srgb, var(--color-success) 16%, var(--color-surface-raised));
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
  font-size: 10px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.output-pair {
  position: relative;
  display: flex;
  flex: 0 0 var(--output-strip-width);
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
    /* When cart is closed, show handle at left edge */
    position: absolute;
    left: 0;
    top: var(--panel-header-height);
    bottom: 0;
    width: 8px;
    background: transparent;

    /* Collapsed states float ON TOP of a panel, so the grab zone may only grow
       inward — growing outward too would swallow taps on the panel behind it. */
    @media (any-pointer: coarse) {
      &::before {
        left: 0;
        right: -16px;
      }
    }

    &::after {
      content: '';
      position: absolute;
      left: 0;
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
    /* When cart is fullscreen, show handle at right edge */
    position: absolute;
    right: 0;
    top: var(--panel-header-height);
    bottom: 0;
    width: 8px;
    background: transparent;

    @media (any-pointer: coarse) {
      &::before {
        left: -16px;
        right: 0;
      }
    }

    &::after {
      content: '';
      position: absolute;
      right: 0;
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

.cart-toggle {
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
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.035);
  cursor: pointer;

  .material-symbols-rounded {
    font-size: 20px;
  }

  &.cart-toggle--open {
    color: var(--color-accent);
    border-color: var(--color-accent);
  }

  &:hover {
    color: var(--color-accent);
    border-color: var(--color-accent);
    background: var(--color-surface-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
}

.cart-section {
  flex: 0 0 auto;
  max-width: calc(100% - var(--playlist-split-min-width) - var(--resize-handle-width));
  overflow: hidden;

  &.cart-section--fullscreen {
    max-width: none;
  }
}
/* Narrow windows: the playlist's fixed minimum (637px in show mode) plus the
   side consoles can leave the cart section a zero-width "open" strip. Below
   the fit threshold the panel becomes an overlay drawer instead of being
   squeezed to nothing. Inline width is set from JS, hence !important. */
@container (max-width: 925px) {
  .cart-section:not(.cart-section--fullscreen) {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(320px, 85%) !important;
    max-width: none;
    z-index: 20;
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.45);
  }

  .resize-handle:not(.collapsed-left):not(.collapsed-right) {
    display: none;
  }
}
</style>
