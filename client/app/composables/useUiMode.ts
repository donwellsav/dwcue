// =====================================================================
// useUiMode.ts
// ---------------------------------------------------------------------
// Global edit/playback ("Show Mode") toggle for Stage 1 of the
// touch-friendly playback surface (see IMPROVEMENTS_PLAN.md §2).
//
// Persisted per-device via localStorage (NOT in the project file) — the
// same project may be open on an editing laptop and a touch tablet at
// the same time, and each device should remember its own preference.
// =====================================================================

export type UiMode = 'edit' | 'playback';

export type CartGridLayout = {
  rows: number;
  columns: number;
  minHeight: number;
};

export const CART_GRID_LIMITS = {
  rows: { min: 1, max: 16 },
  columns: { min: 1, max: 16 },
} as const;

export const CART_GRID_PROFILES = {
  attachedRegular: {
    minHeight: 64,
    maxHeight: 600,
    default: { rows: 8, columns: 2, minHeight: 88 },
  },
  attachedShow: {
    minHeight: 72,
    maxHeight: 600,
    default: { rows: 8, columns: 2, minHeight: 112 },
  },
  detachedRegular: {
    minHeight: 64,
    maxHeight: 600,
    default: { rows: 6, columns: 3, minHeight: 88 },
  },
  detachedShow: {
    minHeight: 72,
    maxHeight: 600,
    default: { rows: 6, columns: 3, minHeight: 112 },
  },
} as const;

export type CartGridProfile = keyof typeof CART_GRID_PROFILES;
export type CartGridLayouts = Record<CartGridProfile, CartGridLayout>;

const CART_GRID_PROFILE_KEYS = Object.keys(CART_GRID_PROFILES) as CartGridProfile[];

const normalizeBoundedInteger = (
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number => {
  const number = typeof value === 'number' || (typeof value === 'string' && value.trim())
    ? Number(value)
    : Number.NaN;
  return Number.isFinite(number)
    ? Math.min(max, Math.max(min, Math.round(number)))
    : fallback;
};

export const PLAYLIST_ROW_HEIGHTS = {
  regular: { min: 44, max: 72, default: 44 },
  show: { min: 60, max: 96, default: 68 },
  folder: { min: 60, max: 96, default: 60 },
} as const;

export const WAVEFORM_OPACITY = { min: 0, max: 100, default: 10 } as const;

export type PlaylistRowMode = keyof typeof PLAYLIST_ROW_HEIGHTS;

export const normalizePlaylistRowHeight = (value: unknown, mode: PlaylistRowMode): number => {
  const range = PLAYLIST_ROW_HEIGHTS[mode];
  return normalizeBoundedInteger(value, range.min, range.max, range.default);
};

export const normalizeWaveformOpacity = (value: unknown): number =>
  normalizeBoundedInteger(
    value,
    WAVEFORM_OPACITY.min,
    WAVEFORM_OPACITY.max,
    WAVEFORM_OPACITY.default,
  );

export const normalizeCartGridLayouts = (value: unknown): CartGridLayouts => {
  const source = value && typeof value === 'object'
    ? value as Partial<Record<CartGridProfile, Partial<CartGridLayout>>>
    : {};
  return Object.fromEntries(CART_GRID_PROFILE_KEYS.map((profile) => {
    const spec = CART_GRID_PROFILES[profile];
    const raw = source[profile] ?? {};
    return [profile, {
      rows: normalizeBoundedInteger(
        raw.rows,
        CART_GRID_LIMITS.rows.min,
        CART_GRID_LIMITS.rows.max,
        spec.default.rows,
      ),
      columns: normalizeBoundedInteger(
        raw.columns,
        CART_GRID_LIMITS.columns.min,
        CART_GRID_LIMITS.columns.max,
        spec.default.columns,
      ),
      minHeight: normalizeBoundedInteger(
        raw.minHeight,
        spec.minHeight,
        spec.maxHeight,
        spec.default.minHeight,
      ),
    }];
  })) as CartGridLayouts;
};

const STORAGE_KEY = 'liveplay-ui-mode';
const REGULAR_ROW_HEIGHT_KEY = 'liveplay-playlist-row-height-regular';
const SHOW_ROW_HEIGHT_KEY = 'liveplay-playlist-row-height-show';
const FOLDER_ROW_HEIGHT_KEY = 'liveplay-playlist-row-height-folder';
const WAVEFORM_OPACITY_KEY = 'liveplay-playlist-waveform-opacity';
const CART_GRID_LAYOUTS_KEY = 'liveplay-cart-grid-layouts-v1';

const parseCartGridLayouts = (value: string | null): CartGridLayouts => {
  if (!value) return normalizeCartGridLayouts(null);
  try { return normalizeCartGridLayouts(JSON.parse(value)); } catch { return normalizeCartGridLayouts(null); }
};

// Guards the one-time localStorage read so multiple components calling
// useUiMode() don't repeatedly touch storage or clobber each other.
let _hydrated = false;

export const useUiMode = () => {
  const uiMode = useState<UiMode>('useUiMode.uiMode', () => 'edit');
  const regularPlaylistRowHeight = useState<number>(
    'useUiMode.regularPlaylistRowHeight',
    () => PLAYLIST_ROW_HEIGHTS.regular.default,
  );
  const showPlaylistRowHeight = useState<number>(
    'useUiMode.showPlaylistRowHeight',
    () => PLAYLIST_ROW_HEIGHTS.show.default,
  );
  const folderPlaylistRowHeight = useState<number>(
    'useUiMode.folderPlaylistRowHeight',
    () => PLAYLIST_ROW_HEIGHTS.folder.default,
  );
  const waveformOpacity = useState<number>(
    'useUiMode.waveformOpacity',
    () => WAVEFORM_OPACITY.default,
  );
  const cartGridLayouts = useState<CartGridLayouts>(
    'useUiMode.cartGridLayouts',
    () => normalizeCartGridLayouts(null),
  );

  if (import.meta.client && !_hydrated) {
    _hydrated = true;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'edit' || saved === 'playback') uiMode.value = saved;
      regularPlaylistRowHeight.value = normalizePlaylistRowHeight(
        localStorage.getItem(REGULAR_ROW_HEIGHT_KEY),
        'regular',
      );
      showPlaylistRowHeight.value = normalizePlaylistRowHeight(
        localStorage.getItem(SHOW_ROW_HEIGHT_KEY),
        'show',
      );
      folderPlaylistRowHeight.value = normalizePlaylistRowHeight(
        localStorage.getItem(FOLDER_ROW_HEIGHT_KEY),
        'folder',
      );
      waveformOpacity.value = normalizeWaveformOpacity(
        localStorage.getItem(WAVEFORM_OPACITY_KEY),
      );
      cartGridLayouts.value = parseCartGridLayouts(localStorage.getItem(CART_GRID_LAYOUTS_KEY));
    } catch {
      // localStorage unavailable (e.g. private browsing) — fall back to 'edit'.
    }

    // Keep separate windows (e.g. the detached cart player) in sync. Each
    // window is its own renderer with its own useState, so a mode change in
    // one window would otherwise not reach the others. The `storage` event
    // fires in every *other* same-origin window when localStorage changes.
    try {
      window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY) {
          const next = e.newValue;
          if (next === 'edit' || next === 'playback') uiMode.value = next;
        } else if (e.key === REGULAR_ROW_HEIGHT_KEY) {
          regularPlaylistRowHeight.value = normalizePlaylistRowHeight(e.newValue, 'regular');
        } else if (e.key === SHOW_ROW_HEIGHT_KEY) {
          showPlaylistRowHeight.value = normalizePlaylistRowHeight(e.newValue, 'show');
        } else if (e.key === FOLDER_ROW_HEIGHT_KEY) {
          folderPlaylistRowHeight.value = normalizePlaylistRowHeight(e.newValue, 'folder');
        } else if (e.key === WAVEFORM_OPACITY_KEY) {
          waveformOpacity.value = normalizeWaveformOpacity(e.newValue);
        } else if (e.key === CART_GRID_LAYOUTS_KEY) {
          cartGridLayouts.value = parseCartGridLayouts(e.newValue);
        }
      });
    } catch {
      // window/addEventListener unavailable — sync simply won't happen.
    }

    // The `storage` event is unreliable across separate Electron
    // BrowserWindows (especially file:// origins), so also sync over IPC.
    try {
      window.electronAPI?.onUiModeSet?.((_event, mode) => {
        if (mode === 'edit' || mode === 'playback') uiMode.value = mode;
      });
      window.electronAPI?.onCartGridLayoutsSet?.((_event, value) => {
        cartGridLayouts.value = parseCartGridLayouts(value);
      });
    } catch {
      // electronAPI unavailable (browser context) — IPC sync won't happen.
    }
  }

  const setUiMode = (mode: UiMode) => {
    uiMode.value = mode;
    if (import.meta.client) {
      try { localStorage.setItem(STORAGE_KEY, mode); } catch {}
      // Broadcast to other windows (detached cart player) so they follow the
      // overall application show-mode state rather than the mode they launched in.
      try { window.electronAPI?.broadcastUiMode?.(mode); } catch {}
    }
  };

  const setRegularPlaylistRowHeight = (value: unknown) => {
    const next = normalizePlaylistRowHeight(value, 'regular');
    regularPlaylistRowHeight.value = next;
    if (import.meta.client) {
      try { localStorage.setItem(REGULAR_ROW_HEIGHT_KEY, String(next)); } catch {}
    }
  };

  const setShowPlaylistRowHeight = (value: unknown) => {
    const next = normalizePlaylistRowHeight(value, 'show');
    showPlaylistRowHeight.value = next;
    if (import.meta.client) {
      try { localStorage.setItem(SHOW_ROW_HEIGHT_KEY, String(next)); } catch {}
    }
  };

  const setFolderPlaylistRowHeight = (value: unknown) => {
    const next = normalizePlaylistRowHeight(value, 'folder');
    folderPlaylistRowHeight.value = next;
    if (import.meta.client) {
      try { localStorage.setItem(FOLDER_ROW_HEIGHT_KEY, String(next)); } catch {}
    }
  };

  const setWaveformOpacity = (value: unknown) => {
    const next = normalizeWaveformOpacity(value);
    waveformOpacity.value = next;
    if (import.meta.client) {
      try { localStorage.setItem(WAVEFORM_OPACITY_KEY, String(next)); } catch {}
    }
  };

  const setCartGridLayout = (
    profile: CartGridProfile,
    patch: Partial<CartGridLayout>,
  ) => {
    const next = normalizeCartGridLayouts({
      ...cartGridLayouts.value,
      [profile]: { ...cartGridLayouts.value[profile], ...patch },
    });
    cartGridLayouts.value = next;
    if (import.meta.client) {
      const serialized = JSON.stringify(next);
      try { localStorage.setItem(CART_GRID_LAYOUTS_KEY, serialized); } catch {}
      try { window.electronAPI?.broadcastCartGridLayouts?.(serialized); } catch {}
    }
  };

  const enterPlaybackMode = () => setUiMode('playback');
  const exitPlaybackMode = () => setUiMode('edit');
  const toggleUiMode = () => setUiMode(uiMode.value === 'playback' ? 'edit' : 'playback');

  return {
    uiMode,
    regularPlaylistRowHeight,
    showPlaylistRowHeight,
    folderPlaylistRowHeight,
    waveformOpacity,
    cartGridLayouts,
    setUiMode,
    setRegularPlaylistRowHeight,
    setShowPlaylistRowHeight,
    setFolderPlaylistRowHeight,
    setWaveformOpacity,
    setCartGridLayout,
    enterPlaybackMode,
    exitPlaybackMode,
    toggleUiMode,
  };
};
