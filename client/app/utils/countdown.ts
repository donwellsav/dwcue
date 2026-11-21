// Whole seconds left, as every countdown in the app shows it: rounded up, so
// 4.5 s left reads 0:05 and 0:00 appears only at the very end. The header,
// rows, the active card and QuickPlay tiles all use this, so they agree.
export function secondsLeft(remaining: number): number {
  if (!Number.isFinite(remaining)) return 0;
  return Math.max(0, Math.ceil(remaining - 0.001));
}
