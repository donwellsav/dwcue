// State viewer for development mode
// Sends application state to the state viewer window in real-time

let updateInterval: NodeJS.Timeout | null = null;
// Only true while a state viewer window is open (main tells us via IPC).
// Broadcasting whole-project state every 500ms with no viewer attached was
// pure churn — and payloads over the 2MB IPC bound spammed rejections.
let viewerActive = false;

export const useStateViewer = () => {
  const { currentProject } = useProject();
  const { activeCues, activeGroups, masterOutputLevel, masterPeakLevel } = useAudioEngine();
  const { cartOnlyItems } = useCartItems();
  const { currentLocale } = useLocalization();

  const startStateUpdates = () => {
    if (updateInterval) return; // Already running

    // Update every 500ms
        updateInterval = setInterval(() => {
      if (!window.electronAPI) return;
      if (!viewerActive) return;
      
      const electronAPI = window.electronAPI as any;
      if (!electronAPI.updateAppState) return;

      // Collect all relevant state (serialize to remove non-cloneable objects)
      const state = {
        project: currentProject.value ? JSON.parse(JSON.stringify(currentProject.value)) : { message: 'No project loaded' },
        
        audioEngine: {
          activeCues: activeCues.value ? Array.from(activeCues.value.entries()).map(([uuid, cue]) => ({
            uuid,
            displayName: cue.displayName,
            duration: cue.duration,
            currentTime: cue.currentTime,
            isPaused: cue.isPaused,
            color: cue.color,
            inPoint: cue.inPoint,
            outPoint: cue.outPoint,
            serverCueId: cue.serverCueId,
          })) : [],
          activeGroups: activeGroups.value ? Array.from(activeGroups.value) : [],
          masterOutputLevel: masterOutputLevel.value,
          masterPeakLevel: masterPeakLevel.value
        },
        
        cartItems: cartOnlyItems.value ? JSON.parse(JSON.stringify(cartOnlyItems.value)) : [],
        
        locale: {
          currentLocale: currentLocale.value
        },
        
        metadata: {
          timestamp: new Date().toISOString(),
          activeCueCount: activeCues.value?.size || 0
        }
      };

      // Send to main process. Electron's structured-clone IPC is stricter
      // than JSON (rejects Proxies, Maps, Sets, class instances, etc.) so
      // funnel through JSON first and swallow any leftover non-cloneables.
      // Waveform data is the bulk of a large project and useless in the
      // viewer — it's a WaveformData object whose peaks/rms/channel arrays
      // are the weight, so collapse it to its shape + loudness summary.
      try {
        const slim = JSON.parse(JSON.stringify(state, (key, value) =>
          key === 'waveform' && value && typeof value === 'object' && !Array.isArray(value)
            ? { peaks: value.peaks?.length ?? 0, channels: value.channelPeaks?.length ?? 0, integrated_lufs: value.integrated_lufs ?? null }
            : value
        ));
        electronAPI.updateAppState(slim);
      } catch (err) {
        // One tick of state viewer is not worth crashing the renderer over.
        // Stay quiet after the first warning to avoid log spam.
        if (!(window as any).__stateViewerWarned) {
          (window as any).__stateViewerWarned = true;
          console.warn('[stateViewer] skipping un-serialisable state:', err);
        }
      }
    }, 500);
  };

  const stopStateUpdates = () => {
    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
    }
  };

  // Check if dev mode and start automatically
  onMounted(async () => {
    if (import.meta.client && window.electronAPI) {
      const electronAPI = window.electronAPI as any;
      electronAPI.onStateViewerActive?.((active: boolean) => { viewerActive = active; });
      if (electronAPI.isDevMode) {
        const isDevMode = await electronAPI.isDevMode();
        if (isDevMode) {
          startStateUpdates();
        }
      }
    }
  });

  onUnmounted(() => {
    stopStateUpdates();
  });

  return {
    startStateUpdates,
    stopStateUpdates
  };
};
