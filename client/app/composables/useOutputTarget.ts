// =====================================================================
// useOutputTarget.ts
// ---------------------------------------------------------------------
// Exposes the output-target loudness levels and meter mode that the
// server computes and embeds in settings.outputTargetLevels. The numbers
// are platform-specific (EBU R128, Streaming, Radio, Netflix, Live) and
// are never hardcoded in the UI — always read from what the server reports.
// =====================================================================
import type { OutputTargetLevels, MeterMode } from '~/types/server';

// Fallback for legacy projects whose server header has no embedded levels.
export const DEFAULT_OUTPUT_TARGET_LEVELS: OutputTargetLevels = {
  blueBelow:          -28,
  greenMin:           -28,
  greenMax:           -20,
  yellowMin:          -20,
  yellowMax:          -1,
  redAbove:           -1,
  limiterCeilingDb:   -1,
  loudnessTargetLufs: -23,
  meterUnit:          'LUFS',
  waveformColor:      '#00e676',
};

// The 4 meter zone colours (applied consistently across meter, waveform, etc.)
export const METER_COLORS = {
  blue:   '#00b8d4',
  green:  '#00e676',
  yellow: '#ffc400',
  red:    '#ff1744',
} as const;

export function useOutputTarget() {
  const { currentProject } = useProject();

  const levels = computed<OutputTargetLevels>(() => {
    const s = (currentProject.value as any)?.settings;
    if (s?.outputTargetLevels && typeof s.outputTargetLevels === 'object') {
      const raw = s.outputTargetLevels as Record<string, unknown>;
      const target = typeof raw.loudnessTargetLufs === 'number'
        ? raw.loudnessTargetLufs
        // Narrow compatibility window for an old hydrated server document.
        : typeof raw.autoVolumeTargetDb === 'number'
          ? raw.autoVolumeTargetDb
          : DEFAULT_OUTPUT_TARGET_LEVELS.loudnessTargetLufs;
      return {
        ...DEFAULT_OUTPUT_TARGET_LEVELS,
        ...raw,
        loudnessTargetLufs: target,
      } as OutputTargetLevels;
    }
    // A named target without levels is a fresh/partially-hydrated document.
    // Wait for the server authority instead of applying the EBU fallback to a
    // live/streaming/etc. project.
    if (s?.outputTarget) {
      return {
        ...DEFAULT_OUTPUT_TARGET_LEVELS,
        loudnessTargetLufs: Number.NaN,
      };
    }
    return DEFAULT_OUTPUT_TARGET_LEVELS;
  });

  // Active meter display mode — set by the user in project settings,
  // defaulting to the platform's recommended unit.
  const meterMode = computed<MeterMode>(() => {
    const s = (currentProject.value as any)?.settings;
    if (s?.meterMode) return s.meterMode as MeterMode;
    return levels.value.meterUnit;
  });

  // Return the meter zone colour for a given dB reading.
  function colorForLevel(db: number): string {
    const lv = levels.value;
    if (db >= lv.redAbove)    return METER_COLORS.red;
    if (db >= lv.yellowMin)   return METER_COLORS.yellow;
    if (db >= lv.greenMin)    return METER_COLORS.green;
    return METER_COLORS.blue;
  }

  // Text uses theme-aware semantic colours at the same server-defined
  // thresholds so small values remain readable against either neutral theme.
  function textColorForLevel(db: number): string {
    const lv = levels.value;
    if (db >= lv.redAbove) return 'var(--color-danger)';
    if (db >= lv.yellowMin) return 'var(--color-warning)';
    if (db >= lv.greenMin) return 'var(--color-success)';
    return 'color-mix(in srgb, var(--color-accent) 45%, var(--color-text-primary))';
  }

  return { levels, meterMode, colorForLevel, textColorForLevel };
}
