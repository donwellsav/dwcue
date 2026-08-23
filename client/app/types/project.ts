// Base item interface that all items extend from
export interface BaseItem {
  uuid: string;
  index: number[];
  displayName: string;
  color: string;
  type: 'audio' | 'group' | 'action'; // Extensible for future item types
}

// Audio-specific properties
export interface AudioItem extends BaseItem {
  type: 'audio';
  mediaFileName: string;
  mediaPath: string; // Relative path from project folder (e.g., "media/audio.mp3")
  // Optional absolute path on the server's filesystem. When set, the audio
  // engine uses this directly and ignores mediaPath/folder construction.
  // Populated when a cue is imported via the server file browser or by
  // uploading a file to the server's media_root (rather than the old local
  // copy-into-project-folder path).
  mediaServerPath?: string;
  // Server-probed at import (decoder file_has_video_stream): the media file is
  // a video container with a real video stream. Drives the Video Output
  // window; audio still plays through the engine exactly as before.
  hasVideo?: boolean;
  // Optional per-cue still image, project-relative like mediaPath, shown on
  // the video output while this audio-only cue plays.
  imagePath?: string;
  waveformPath: string;
  waveform?: WaveformData; // Optional: waveform data for visualization
  inPoint: number; // in seconds
  outPoint: number; // in seconds
  volume: number; // 0-2 (1 is normal, >1 is louder, <1 is quieter)
  endBehavior: EndBehavior;
  startBehavior: StartBehavior;
  customActions: CustomAction[];
  duckingBehavior: DuckingBehavior;
  duration: number; // total duration in seconds
  fadeOutDuration: number; // fade out duration in seconds when stopping (default: 1)
  playFade: number; // fade in duration when playing (default: 0)
  stopFade: number; // fade out duration before end (default: 0)
  crossFade: number; // cross-fade duration to next track (default: 0)
  // "Start Next" segue marker (radio-style transition): when the playhead
  // crosses startNextTime, the next item starts at its own volume/fades
  // while this one keeps playing. Independent of the fade-out markers.
  startNextEnabled?: boolean;
  startNextTime?: number;     // absolute seconds within the file
  startNextFadeOut?: boolean; // also begin this item's fade-out at the marker
  // LTC (SMPTE Linear Timecode) output for this cue.
  ltcEnabled?: boolean;         // output LTC on the project's ltcDevice when playing
  ltcStartTimecode?: string;    // starting timecode "HH:MM:SS:FF" (default "00:00:00:00")
  ltcFrameRate?: number;        // 0=24, 1=25, 2=29.97NDF, 3=29.97DF, 4=30 (default 4)
  // Presence designates this canonical playlist cue as a quick-fire One Shot.
  // Playback behavior continues to use the cue's existing audio fields.
  oneShot?: OneShotSettings;
}

// Waveform data format (from the server's decoder, or legacy ffmpeg files)
export interface WaveformData {
  length: number;
  duration: number;
  // Combined trace: the per-bucket maximum across every source channel.
  // Normalized 0..1. Auto-trim and the compact row/cart renderers use this
  // combined trace; loudness and true peak come only from decoded-sample
  // server analysis.
  peaks: number[];
  // Combined RMS trace. This is the waveform's readable energy body; peaks
  // remain the transient/ceiling outline. Optional for legacy waveform files.
  rms?: number[];
  // Per-channel traces, in source channel order (stereo = [L, R]). Present for
  // waveforms produced by the server; absent for legacy single-array data.
  // Renderers with room for it (the trimmer) draw one lane per channel.
  channelPeaks?: number[][];
  channelRms?: number[][];
  // BS.1770 analysis measured from decoded samples by the server. Legacy
  // waveform files have none of these fields and are never loudness-matched.
  analysis_version?: 1;
  integrated_lufs?: number | null;
  true_peak_dbtp?: number | null;
}

// Group item properties
export interface GroupItem extends BaseItem {
  type: 'group';
  children: (AudioItem | GroupItem)[];
  startBehavior: GroupStartBehavior;
  endBehavior: EndBehavior;
  isExpanded: boolean; // UI state
}

// End behavior options
export interface EndBehavior {
  action: 'nothing' | 'next' | 'goto-item' | 'goto-index' | 'loop';
  targetUuid?: string; // for goto-item
  targetIndex?: number[]; // for goto-index
}

// Start behavior options
export interface StartBehavior {
  action: 'nothing' | 'play-next' | 'play-item' | 'play-index';
  targetUuid?: string;
  targetIndex?: number[];
}

// Group start behavior
export interface GroupStartBehavior {
  action: 'play-first' | 'play-all';
}

// Custom action at specific time
export interface CustomAction {
  timePoint: number; // in seconds
  action: CustomActionType;
}

export type CustomActionType = 
  | { type: 'play-item'; uuid: string }
  | { type: 'play-index'; index: number[] }
  | { type: 'stop-all' }
  | { type: 'http-request'; request: HttpRequest };

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  contentType: 'form' | 'json';
  body?: Record<string, any>;
}

// Ducking behavior
export interface DuckingBehavior {
  mode: 'stop-all' | 'no-ducking' | 'duck-others';
  duckLevel?: number; // 0-1, volume multiplier for other cues
  duckFadeIn?: number; // fade in duration in seconds when ducking (default: 0.25)
  duckFadeOut?: number; // fade out duration in seconds when restoring (default: 1)
}

// Cart slot key binding
export interface CartSlotKeyBinding {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface OneShotSettings {
  order: number;
  retrigger: 'restart' | 'ignore';
  hotkey?: CartSlotKeyBinding;
  // Set when a playlist cue was copied into an independent One Shot. This is
  // only an origin reference for the Properties toggle; playback stays local.
  sourceUuid?: string;
}

// Configurable playback keyboard actions
export type PlaybackKeyAction =
  | 'pause-resume'
  | 'toggle-loop'
  | 'cue-to-continue'
  | 'jump-cue'
  | 'stop-all'
  | 'select-up'
  | 'select-down'
  | 'play-selected'
  | 'play-next';

// Cart player item
export interface CartItem {
  slot: number; // 0-63
  itemUuid: string;
  index: number[]; // [-1, slot] for API triggering
}

export const CART_SLOT_COUNT_LIMITS = { min: 1, max: 64, default: 16 } as const;

export function normalizeCartSlotCount(
  value: unknown,
  cartItems: readonly Pick<CartItem, 'slot'>[] = [],
  cartSlotKeys: object = {},
): number {
  const numeric = typeof value === 'number' || (typeof value === 'string' && value.trim())
    ? Number(value)
    : Number.NaN;
  const configured = Number.isFinite(numeric)
    ? Math.min(CART_SLOT_COUNT_LIMITS.max, Math.max(CART_SLOT_COUNT_LIMITS.min, Math.round(numeric)))
    : CART_SLOT_COUNT_LIMITS.default;
  let occupied = 0;
  const includeSlot = (slot: unknown) => {
    if (typeof slot === 'number' && Number.isInteger(slot)
      && slot >= 0 && slot < CART_SLOT_COUNT_LIMITS.max) {
      occupied = Math.max(occupied, slot + 1);
    }
  };
  for (const item of cartItems) includeSlot(item?.slot);
  for (const slot of Object.keys(cartSlotKeys)) includeSlot(Number(slot));
  return Math.max(configured, occupied);
}

export interface CountdownColorBand {
  startSeconds: number;
  color: string;
}

export interface ProjectSettings {
  defaultOutputDevice?: string | null;
  previewDevice?: string | null;
  ltcDevice?: string | null;
  outputTarget?: string;
  outputTargetLevels?: Record<string, unknown>;
  limiterCeilingDb?: number; // dBTP; key retained for file/API compatibility
  meterMode?: string;
  defaultTransitionMode?: TransitionMode;
  autoCueNextWithoutEndBehavior?: boolean;
  stopAllFadeMs?: number;
  uiScrollToPlaying?: boolean;
  autoTrimSilenceOnImport?: boolean;
  autoMatchLoudnessOnImport?: boolean;
  autoReduceTruePeaksOnImport?: boolean;
  cycleTrackColors?: boolean;
  disableLimiter?: boolean;
  disableSilenceWarning?: boolean;
  autoSave?: boolean;
  countdownColorBands?: CountdownColorBand[];
  cartSlotCount?: number;
  // Global standby image for the video output, project-relative. Shown when
  // nothing is playing and no black/test card is up.
  videoStandbyImage?: string;

  /**
   * Number shown for the first playlist item.
   *
   * This affects UI display and user-entered index paths only.
   * Internal item.index values, stored targetIndex values, and REST by-index
   * paths remain zero-based for backwards compatibility.
   */
  indexDisplayStart?: number;
}


// Project structure
export interface Project {
  name: string;
  version: string;
  folderPath: string;
  items: (AudioItem | GroupItem)[];
  cartItems: CartItem[];
  cartSlotKeys?: Record<number, CartSlotKeyBinding>;
  playbackKeys?: Record<string, CartSlotKeyBinding | null>;
  cartOnlyItems: AudioItem[]; // Items that exist only in cart (not in playlist)
  theme: Theme;
  settings?: ProjectSettings;
  createdAt: string;
  lastModified: string;
}

// Theme configuration
export interface Theme {
  mode: 'light' | 'dark';
  accentColor: string;
}

// Which track-to-track transition newly imported tracks default to. Stored in
// project settings as `defaultTransitionMode`; every track can still be
// switched individually in its properties.
export type TransitionMode = 'crossfade' | 'start-next';

// Transition defaults for a freshly imported audio item, derived from the
// project's `settings.defaultTransitionMode`. Spread these over
// DEFAULT_AUDIO_ITEM when creating the item.
export function transitionDefaultsForImport(
  mode: TransitionMode | string | undefined,
  duration: number
): Partial<AudioItem> {
  if (mode === 'start-next') {
    return {
      startNextEnabled: true,
      // Same default as the per-track toggle: 5s before the end. The engine
      // ignores the marker while it is <= 0 (e.g. duration still unknown).
      startNextTime: Math.max(0, duration - 5),
      startNextFadeOut: false,
    };
  }
  return {};
}

// Re-anchor a freshly imported item's default start-next marker once its real
// trim window is known — waveform arrival and auto-trim can both move the out
// point after import. Only call this for items imported this session, before
// the user has had a chance to edit the marker.
export function anchorStartNextMarker(item: AudioItem): void {
  if (!item.startNextEnabled) return;
  item.startNextTime = Math.max(item.inPoint, item.outPoint - 5);
}

// Active playback state
export interface ActiveCue {
  uuid: string;
  displayName: string;
  startTime: number;
  currentTime: number;
  duration: number;
  volume: number;
  isDucked: boolean;
  originalVolume: number;
  audioContext?: AudioContext;
  audioSource?: AudioBufferSourceNode;
  gainNode?: GainNode;
}

// Predefined colors for items
export const PRESET_COLORS = [
  '#FF6600', // Orange
  '#FFCC00', // Yellow
  '#99CC00', // Lime
  '#00CC00', // Green
  '#00CC99', // Teal
  '#00CCFF', // Cyan
  '#0066FF', // Blue
  '#3300FF', // Indigo
  '#9900FF', // Purple
  '#FF00CC', // Magenta
  '#FF0066', // Pink
  '#996600', // Brown
  '#666666', // Gray
  '#30303a'  // Dark Gray
];

export const colorForNewAudioItem = (
  settings?: ProjectSettings,
  sequenceIndex = 0,
): string =>
  settings?.cycleTrackColors === false
    ? PRESET_COLORS[0]!
    : PRESET_COLORS[sequenceIndex % PRESET_COLORS.length]!;

// Default values
export const DEFAULT_THEME: Theme = {
  mode: 'dark',
  accentColor: '#315FCF'
};

export const DEFAULT_COUNTDOWN_COLOR_BANDS: CountdownColorBand[] = [
  { startSeconds: 11, color: '#35A96B' },
  { startSeconds: 6, color: '#D8AD35' },
  { startSeconds: 0, color: '#E54855' },
];

const COUNTDOWN_HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function normalizeCountdownColorBands(value: unknown): CountdownColorBand[] {
  const source = Array.isArray(value) ? value : DEFAULT_COUNTDOWN_COLOR_BANDS;
  const byStart = new Map<number, string>();

  for (const raw of source) {
    if (!raw || typeof raw !== 'object') continue;
    const start = Number((raw as any).startSeconds);
    const color = typeof (raw as any).color === 'string'
      ? (raw as any).color.trim().toUpperCase()
      : '';
    if (!Number.isFinite(start) || start < 0 || !COUNTDOWN_HEX_COLOR.test(color)) continue;
    byStart.set(Math.round(start), color);
  }

  if (byStart.size === 0) {
    return DEFAULT_COUNTDOWN_COLOR_BANDS.map(band => ({ ...band }));
  }
  if (!byStart.has(0)) {
    byStart.set(0, DEFAULT_COUNTDOWN_COLOR_BANDS.at(-1)!.color);
  }

  return [...byStart]
    .map(([startSeconds, color]) => ({ startSeconds, color }))
    .sort((a, b) => b.startSeconds - a.startSeconds);
}

export function countdownColorForSeconds(
  seconds: number | null,
  value: unknown,
): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const displayedSeconds = Math.max(0, Math.ceil(seconds));
  return normalizeCountdownColorBands(value)
    .find(band => displayedSeconds >= band.startSeconds)!.color;
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  outputTarget: 'live',
  meterMode: 'dBFS',
  autoTrimSilenceOnImport: false,
  autoMatchLoudnessOnImport: false,
  autoReduceTruePeaksOnImport: true,
  cycleTrackColors: true,
  cartSlotCount: CART_SLOT_COUNT_LIMITS.default,
  countdownColorBands: DEFAULT_COUNTDOWN_COLOR_BANDS.map(band => ({ ...band })),
};

export const DEFAULT_AUDIO_ITEM: Partial<AudioItem> = {
  color: PRESET_COLORS[0],
  inPoint: 0,
  volume: 1.0,
  endBehavior: { action: 'next' }, // Default: play next item
  startBehavior: { action: 'nothing' },
  customActions: [],
  duckingBehavior: {
    mode: 'stop-all', // Default for playlist items: stop all other cues
    duckFadeIn: 0.25,
    duckFadeOut: 1.0
  },
  fadeOutDuration: 1.0,
  playFade: 0,
  stopFade: 0,
  crossFade: 0,
  startNextEnabled: false,
  startNextTime: 0,
  startNextFadeOut: false,
  ltcEnabled: false,
  ltcStartTimecode: '00:00:00:00',
  ltcFrameRate: 4,
};

// Default for cart items (different from playlist)
export const DEFAULT_CART_AUDIO_ITEM: Partial<AudioItem> = {
  color: PRESET_COLORS[0],
  inPoint: 0,
  volume: 1.0,
  endBehavior: { action: 'nothing' },
  startBehavior: { action: 'nothing' },
  customActions: [],
  duckingBehavior: {
    mode: 'duck-others', // Default for cart items: duck to -20dB
    duckLevel: 0.1,
    duckFadeIn: 0.25,
    duckFadeOut: 1.0
  },
  fadeOutDuration: 1.0,
  playFade: 0,
  stopFade: 0,
  crossFade: 0,
  startNextEnabled: false,
  startNextTime: 0,
  startNextFadeOut: false
};

export const DEFAULT_GROUP_ITEM: Partial<GroupItem> = {
  color: PRESET_COLORS[7],
  startBehavior: { action: 'play-first' },
  endBehavior: { action: 'nothing' },
  isExpanded: true,
  children: []
};

// Cart slots have no default key bindings — user assigns them manually
export const DEFAULT_CART_SLOT_KEYS: Record<number, CartSlotKeyBinding> = {};

// Default keyboard bindings for playback actions
export const DEFAULT_PLAYBACK_KEYS: Partial<Record<PlaybackKeyAction, CartSlotKeyBinding>> = {
  'play-next':     { key: ' ',         ctrlKey: false, shiftKey: false, altKey: false },
  'pause-resume':  { key: 'p',         ctrlKey: false, shiftKey: false, altKey: false },
  'stop-all':      { key: 'Escape',    ctrlKey: false, shiftKey: false, altKey: false },
  'select-up':     { key: 'ArrowUp',   ctrlKey: false, shiftKey: false, altKey: false },
  'select-down':   { key: 'ArrowDown', ctrlKey: false, shiftKey: false, altKey: false },
  'play-selected': { key: 'Enter',     ctrlKey: false, shiftKey: false, altKey: false },
};
