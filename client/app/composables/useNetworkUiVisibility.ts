// =====================================================================
// useNetworkUiVisibility.ts
// ---------------------------------------------------------------------
// Gate for the network/remote-server UI (video v1 locked decision:
// same-machine only). The capability stays intact — this is a UI
// simplification, not a removal — so the flag lives in localStorage per
// device (NOT in the project file) and flips from Server Settings or the
// welcome screen's reveal link. Default: hidden.
// =====================================================================

const STORAGE_KEY = 'liveplay-show-network-ui';

// Guards the one-time localStorage read (same convention as useUiMode).
let _hydrated = false;

export const useNetworkUiVisibility = () => {
  const showNetworkUi = useState<boolean>('useNetworkUiVisibility.show', () => false);

  if (import.meta.client && !_hydrated) {
    _hydrated = true;
    try {
      showNetworkUi.value = localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      // localStorage unavailable (private browsing) — stay hidden.
    }
  }

  const setNetworkUiVisible = (visible: boolean) => {
    showNetworkUi.value = visible;
    if (import.meta.client) {
      try { localStorage.setItem(STORAGE_KEY, visible ? '1' : '0'); } catch {}
    }
  };

  return { showNetworkUi, setNetworkUiVisible };
};
