// Plain summary of the open show sent to the main process for
// File > Export Cue Sheet (PDF). client/electron/cue-sheet.js validates and
// bounds every field, so this only describes what the renderer sends.

export interface CueSheetEndBehavior {
  action: string;
  // Zero-based playlist path of a Go to target, when it resolves to a cue.
  targetIndex?: number[];
}

export interface CueSheetItem {
  type: 'audio' | 'group';
  displayName: string;
  note?: string;
  // Played length in seconds (trimmed by the in/out points), audio only.
  duration?: number;
  // Linear cue volume, audio only.
  volume?: number;
  // Group level in dB, groups only.
  groupGainDb?: number;
  endBehavior?: CueSheetEndBehavior;
  children?: CueSheetItem[];
}

export interface CueSheetQuickPlay {
  // Slot number as shown on the QuickPlays grid (first slot is 1).
  slot: number;
  displayName: string;
  duration?: number;
  volume?: number;
  endBehavior?: CueSheetEndBehavior;
}

export interface CueSheetPayload {
  showName: string;
  // Number shown for the first playlist cue (settings.indexDisplayStart).
  indexStart: number;
  items: CueSheetItem[];
  quickPlays: CueSheetQuickPlay[];
  // Translated strings for the sheet, keyed like the cueSheet.* locale keys.
  labels: Record<string, string>;
}

export type CueSheetExportResult =
  | { status: 'saved'; fileName: string }
  | { status: 'cancelled' }
  | { status: 'busy' }
  | { status: 'failed'; error: string };
