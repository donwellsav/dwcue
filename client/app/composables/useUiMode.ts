// =====================================================================
// useUiMode.ts
// ---------------------------------------------------------------------
// Global edit/playback ("Show Mode") toggle. Show Mode is Edit Mode with
// the editing taken out: every size comes from the same settings.
//
// Persisted per-device via localStorage (NOT in the project file) — the
// same project may be open on an editing laptop and a touch tablet at
// the same time, and each device should remember its own preference.
// =====================================================================

import { normalizeHeaderWarningTiming } from '../utils/headerWarnings';

export type UiMode = 'edit' | 'playback';

export type QuickPlayGridLayout = {
  rows: number;
  columns: number;
  minHeight: number;
};

export const QUICK_PLAY_GRID_LIMITS = {
  rows: { min: 1, max: 16 },
  columns: { min: 1, max: 16 },
} as const;

// One QuickPlays layout for the attached panel and one for the detached
// window, used in Edit Mode and Show Mode alike. The names end in "Regular"
// because saved layouts already use them.
export const QUICK_PLAY_GRID_PROFILES = {
  // Beside the playlist, ten QuickPlays show by default (the ten with number
  // keys): two across and five down. The detached window shows twenty (the
  // number keys and their Shift row): five across and four down.
  attachedRegular: {
    minHeight: 64,
    maxHeight: 600,
    default: { rows: 5, columns: 2, minHeight: 112 },
  },
  detachedRegular: {
    minHeight: 64,
    maxHeight: 600,
    default: { rows: 4, columns: 5, minHeight: 112 },
  },
} as const;

export type QuickPlayGridProfile = keyof typeof QUICK_PLAY_GRID_PROFILES;
export type QuickPlayGridLayouts = Record<QuickPlayGridProfile, QuickPlayGridLayout>;

const QUICK_PLAY_GRID_PROFILE_KEYS = Object.keys(QUICK_PLAY_GRID_PROFILES) as QuickPlayGridProfile[];

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

// Cue rows have one height, used in Edit Mode and Show Mode alike.
export const PLAYLIST_ROW_HEIGHTS = {
  regular: { min: 44, max: 72, default: 44 },
  folder: { min: 60, max: 96, default: 60 },
} as const;

export const VIDEO_HOVER_SCALE = { min: 2, max: 5, default: 3 } as const;
export const WAVEFORM_OPACITY = { min: 0, max: 100, default: 10 } as const;
// Percentages: 100 = the original interface text size. Defaults sit below
// 100 — both were introduced as "smaller than before" preferences.
// 100% draws the interface at its designed sizes (11px smallest text). It
// used to default to 90%, which shrank everything.
// A saved preference is kept; the range lets a laptop go denser or a touch
// screen go larger.
export const UI_FONT_SCALE = { min: 80, max: 125, default: 100 } as const;
export const QUICK_PLAY_FONT_SCALE = { min: 70, max: 130, default: 85 } as const;

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
export const normalizeUiFontScale = (value: unknown): number =>
  normalizeBoundedInteger(
    value,
    UI_FONT_SCALE.min,
    UI_FONT_SCALE.max,
    UI_FONT_SCALE.default,
  );

export const normalizeQuickPlayFontScale = (value: unknown): number =>
  normalizeBoundedInteger(
    value,
    QUICK_PLAY_FONT_SCALE.min,
    QUICK_PLAY_FONT_SCALE.max,
    QUICK_PLAY_FONT_SCALE.default,
  );

export const normalizeQuickPlayGridLayouts = (value: unknown): QuickPlayGridLayouts => {
  const source = value && typeof value === 'object'
    ? value as Partial<Record<QuickPlayGridProfile, Partial<QuickPlayGridLayout>>>
    : {};
  return Object.fromEntries(QUICK_PLAY_GRID_PROFILE_KEYS.map((profile) => {
    const spec = QUICK_PLAY_GRID_PROFILES[profile];
    const raw = source[profile] ?? {};
    return [profile, {
      rows: normalizeBoundedInteger(
        raw.rows,
        QUICK_PLAY_GRID_LIMITS.rows.min,
        QUICK_PLAY_GRID_LIMITS.rows.max,
        spec.default.rows,
      ),
      columns: normalizeBoundedInteger(
        raw.columns,
        QUICK_PLAY_GRID_LIMITS.columns.min,
        QUICK_PLAY_GRID_LIMITS.columns.max,
        spec.default.columns,
      ),
      minHeight: normalizeBoundedInteger(
        raw.minHeight,
        spec.minHeight,
        spec.maxHeight,
        spec.default.minHeight,
      ),
    }];
  })) as QuickPlayGridLayouts;
};

const STORAGE_KEY = 'liveplay-ui-mode';
const REGULAR_ROW_HEIGHT_KEY = 'liveplay-playlist-row-height-regular';
const FOLDER_ROW_HEIGHT_KEY = 'liveplay-playlist-row-height-folder';
const WAVEFORM_OPACITY_KEY = 'liveplay-playlist-waveform-opacity';
const UI_FONT_SCALE_KEY = 'liveplay-ui-font-scale';
const QUICK_PLAY_FONT_SCALE_KEY = 'liveplay-quickplay-font-scale';
const QUICK_PLAY_GRID_LAYOUTS_KEY = 'liveplay-quickplay-grid-layouts-v1';
const HEADER_WARNING_TIMING_KEY = 'dwcue-header-warning-timing';
const VIDEO_HOVER_SCALE_KEY = 'dwcue-video-hover-scale';
const SHOW_TOOLTIPS_KEY = 'dwcue-show-tooltips';

// These two preferences were saved under older keys before the feature was
// named QuickPlay everywhere. The old key is read only when the current one
// holds nothing, so an operator's saved text size and grid layout carry over.
const LEGACY_QUICK_PLAY_FONT_SCALE_KEY = 'liveplay-one-shot-font-scale';
const LEGACY_QUICK_PLAY_GRID_LAYOUTS_KEY = 'liveplay-cart-grid-layouts-v1';
const readSavedOrLegacy = (key: string, legacyKey: string): string | null =>
  localStorage.getItem(key) ?? localStorage.getItem(legacyKey);

const parseQuickPlayGridLayouts = (value: string | null): QuickPlayGridLayouts => {
  if (!value) return normalizeQuickPlayGridLayouts(null);
  try { return normalizeQuickPlayGridLayouts(JSON.parse(value)); } catch { return normalizeQuickPlayGridLayouts(null); }
};

const parseHeaderWarningTiming = (value: string | null) => {
  try { return normalizeHeaderWarningTiming(value && JSON.parse(value)); }
  catch { return normalizeHeaderWarningTiming(null); }
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
  const folderPlaylistRowHeight = useState<number>(
    'useUiMode.folderPlaylistRowHeight',
    () => PLAYLIST_ROW_HEIGHTS.folder.default,
  );
  const waveformOpacity = useState<number>(
    'useUiMode.waveformOpacity',
    () => WAVEFORM_OPACITY.default,
  );
  const uiFontScale = useState<number>(
    'useUiMode.uiFontScale',
    () => UI_FONT_SCALE.default,
  );
  const quickPlayFontScale = useState<number>(
    'useUiMode.quickPlayFontScale',
    () => QUICK_PLAY_FONT_SCALE.default,
  );
  const quickPlayGridLayouts = useState<QuickPlayGridLayouts>(
    'useUiMode.quickPlayGridLayouts',
    () => normalizeQuickPlayGridLayouts(null),
  );
  const headerWarningTiming = useState('headerWarningTiming', () => normalizeHeaderWarningTiming(null));
  const showTooltips = useState('useUiMode.showTooltips', () => true);

  const videoHoverScale = useState<number>('videoHoverScale', () => VIDEO_HOVER_SCALE.default);
  const normalizeVideoHoverScale = (value: unknown) =>
    normalizeBoundedInteger(value, VIDEO_HOVER_SCALE.min, VIDEO_HOVER_SCALE.max, VIDEO_HOVER_SCALE.default);

  if (import.meta.client && !_hydrated) {
    _hydrated = true;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'edit' || saved === 'playback') uiMode.value = saved;
      regularPlaylistRowHeight.value = normalizePlaylistRowHeight(
        localStorage.getItem(REGULAR_ROW_HEIGHT_KEY),
        'regular',
      );
      folderPlaylistRowHeight.value = normalizePlaylistRowHeight(
        localStorage.getItem(FOLDER_ROW_HEIGHT_KEY),
        'folder',
      );
      waveformOpacity.value = normalizeWaveformOpacity(
        localStorage.getItem(WAVEFORM_OPACITY_KEY),
      );
      uiFontScale.value = normalizeUiFontScale(
        localStorage.getItem(UI_FONT_SCALE_KEY),
      );
      quickPlayFontScale.value = normalizeQuickPlayFontScale(
        readSavedOrLegacy(QUICK_PLAY_FONT_SCALE_KEY, LEGACY_QUICK_PLAY_FONT_SCALE_KEY),
      );
      quickPlayGridLayouts.value = parseQuickPlayGridLayouts(
        readSavedOrLegacy(QUICK_PLAY_GRID_LAYOUTS_KEY, LEGACY_QUICK_PLAY_GRID_LAYOUTS_KEY),
      );
      headerWarningTiming.value = parseHeaderWarningTiming(localStorage.getItem(HEADER_WARNING_TIMING_KEY));
      videoHoverScale.value = normalizeVideoHoverScale(localStorage.getItem(VIDEO_HOVER_SCALE_KEY));
      showTooltips.value = localStorage.getItem(SHOW_TOOLTIPS_KEY) !== 'false';
    } catch {
      // localStorage unavailable (e.g. private browsing) — fall back to 'edit'.
    }

    // Keep separate windows (e.g. the detached QuickPlay window) in sync. Each
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
        } else if (e.key === FOLDER_ROW_HEIGHT_KEY) {
          folderPlaylistRowHeight.value = normalizePlaylistRowHeight(e.newValue, 'folder');
        } else if (e.key === WAVEFORM_OPACITY_KEY) {
          waveformOpacity.value = normalizeWaveformOpacity(e.newValue);
        } else if (e.key === UI_FONT_SCALE_KEY) {
          uiFontScale.value = normalizeUiFontScale(e.newValue);
        } else if (e.key === QUICK_PLAY_FONT_SCALE_KEY) {
          quickPlayFontScale.value = normalizeQuickPlayFontScale(e.newValue);
        } else if (e.key === QUICK_PLAY_GRID_LAYOUTS_KEY) {
          quickPlayGridLayouts.value = parseQuickPlayGridLayouts(e.newValue);
        } else if (e.key === HEADER_WARNING_TIMING_KEY) {
          headerWarningTiming.value = parseHeaderWarningTiming(e.newValue);
        } else if (e.key === SHOW_TOOLTIPS_KEY) {
          showTooltips.value = e.newValue !== 'false';
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
      window.electronAPI?.onQuickPlayGridLayoutsSet?.((_event, value) => {
        quickPlayGridLayouts.value = parseQuickPlayGridLayouts(value);
      });
    } catch {
      // electronAPI unavailable (browser context) — IPC sync won't happen.
    }
  }

  const setUiMode = (mode: UiMode) => {
    uiMode.value = mode;
    if (import.meta.client) {
      try { localStorage.setItem(STORAGE_KEY, mode); } catch {}
      // Broadcast to other windows (detached QuickPlay window) so they follow the
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
  const setUiFontScale = (value: unknown) => {
    const next = normalizeUiFontScale(value);
    uiFontScale.value = next;
    if (import.meta.client) {
      try { localStorage.setItem(UI_FONT_SCALE_KEY, String(next)); } catch {}
    }
  };

  const setQuickPlayFontScale = (value: unknown) => {
    const next = normalizeQuickPlayFontScale(value);
    quickPlayFontScale.value = next;
    if (import.meta.client) {
      try { localStorage.setItem(QUICK_PLAY_FONT_SCALE_KEY, String(next)); } catch {}
    }
  };

  const setVideoHoverScale = (value: unknown) => {
    videoHoverScale.value = normalizeVideoHoverScale(value);
    if (import.meta.client) {
      try { localStorage.setItem(VIDEO_HOVER_SCALE_KEY, String(videoHoverScale.value)); } catch {}
    }
  };

  const setShowTooltips = (enabled: boolean) => {
    showTooltips.value = enabled;
    if (import.meta.client) {
      try { localStorage.setItem(SHOW_TOOLTIPS_KEY, String(enabled)); } catch {}
    }
  };

  const setQuickPlayGridLayout = (
    profile: QuickPlayGridProfile,
    patch: Partial<QuickPlayGridLayout>,
  ) => {
    const next = normalizeQuickPlayGridLayouts({
      ...quickPlayGridLayouts.value,
      [profile]: { ...quickPlayGridLayouts.value[profile], ...patch },
    });
    quickPlayGridLayouts.value = next;
    if (import.meta.client) {
      const serialized = JSON.stringify(next);
      try { localStorage.setItem(QUICK_PLAY_GRID_LAYOUTS_KEY, serialized); } catch {}
      try { window.electronAPI?.broadcastQuickPlayGridLayouts?.(serialized); } catch {}
    }
  };

  const enterPlaybackMode = () => setUiMode('playback');
  const setHeaderWarningTiming = (value: unknown) => {
    headerWarningTiming.value = normalizeHeaderWarningTiming(value);
    if (import.meta.client) {
      try { localStorage.setItem(HEADER_WARNING_TIMING_KEY, JSON.stringify(headerWarningTiming.value)); } catch {}
    }
  };
  const exitPlaybackMode = () => setUiMode('edit');
  const toggleUiMode = () => setUiMode(uiMode.value === 'playback' ? 'edit' : 'playback');

  return {
    uiMode,
    regularPlaylistRowHeight,
    folderPlaylistRowHeight,
    waveformOpacity,
    uiFontScale,
    quickPlayFontScale,
    quickPlayGridLayouts,
    headerWarningTiming,
    showTooltips,
    videoHoverScale,
    setVideoHoverScale,
    setUiMode,
    setRegularPlaylistRowHeight,
    setFolderPlaylistRowHeight,
    setWaveformOpacity,
    setUiFontScale,
    setQuickPlayFontScale,
    setQuickPlayGridLayout,
    setHeaderWarningTiming,
    setShowTooltips,
    enterPlaybackMode,
    exitPlaybackMode,
    toggleUiMode,
  };
};
