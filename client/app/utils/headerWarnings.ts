export const HEADER_WARNING_TIMING = {
  noCountdown: { default: 5, min: 0.1, max: 60, step: 0.1 },
  longCountdown: { default: 3, min: 0.1, max: 60, step: 0.1 },
  shortCountdown: { default: 2, min: 0.1, max: 60, step: 0.1 },
  urgentCountdown: { default: 1, min: 0.1, max: 60, step: 0.1 },
  upperThreshold: { default: 30, min: 0, max: 60, step: 1 },
  lowerThreshold: { default: 15, min: 0, max: 60, step: 1 },
} as const;

export type HeaderWarningTiming = Record<keyof typeof HEADER_WARNING_TIMING, number>;
export type HeaderWarningSeverity = 'urgent' | 'advisory';
export type HeaderWarning = { message: string; severity: HeaderWarningSeverity };

export function normalizeHeaderWarningTiming(value: unknown): HeaderWarningTiming {
  const input = value && typeof value === 'object' ? value as Partial<HeaderWarningTiming> : {};
  const timing = Object.fromEntries(
    (Object.keys(HEADER_WARNING_TIMING) as (keyof HeaderWarningTiming)[]).map((key) => {
      const spec = HEADER_WARNING_TIMING[key];
      const number = input[key];
      const valid = typeof number === 'number' && number >= spec.min && number <= spec.max
        && (spec.step !== 1 || Number.isInteger(number));
      return [key, valid ? number : spec.default];
    }),
  ) as HeaderWarningTiming;
  if (timing.lowerThreshold >= timing.upperThreshold) {
    timing.lowerThreshold = HEADER_WARNING_TIMING.lowerThreshold.default;
    timing.upperThreshold = HEADER_WARNING_TIMING.upperThreshold.default;
  }
  return timing;
}

export function headerWarningDuration(timing: HeaderWarningTiming, silenceSeconds: number | null): number {
  if (silenceSeconds === null) return timing.noCountdown;
  if (silenceSeconds > timing.upperThreshold) return timing.longCountdown;
  if (silenceSeconds < timing.lowerThreshold) return timing.urgentCountdown;
  return timing.shortCountdown;
}

export function canReplaceHeaderWarning(active: HeaderWarning | null, next: HeaderWarning): boolean {
  if (!active) return true;
  if (active.severity === 'urgent' && next.severity === 'advisory') return false;
  return active.severity !== next.severity || active.message !== next.message;
}
