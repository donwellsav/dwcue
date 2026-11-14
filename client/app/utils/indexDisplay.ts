export function normalizeIndexDisplayStart(value: unknown): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 ? n : 1;
}

function isSpecialIndexPath(index: number[] | undefined | null): boolean {
  return Array.isArray(index) && index.length > 0 && index[0] < 0;
}

export function toDisplayIndexPath(index: number[], start: unknown): number[] {
  if (isSpecialIndexPath(index)) return [...index];

  const offset = normalizeIndexDisplayStart(start);
  return index.map(part => part + offset);
}

export function fromDisplayIndexPath(displayIndex: number[], start: unknown): number[] {
  const offset = normalizeIndexDisplayStart(start);
  return displayIndex.every(part => Number.isSafeInteger(part) && part >= offset)
    ? displayIndex.map(part => part - offset)
    : [];
}

export function formatDisplayIndexPath(index: number[] | undefined | null, start: unknown): string {
  if (!index || index.length === 0) return '';
  return toDisplayIndexPath(index, start).join(',');
}

export function parseDisplayIndexPath(raw: string, start: unknown): number[] {
  const parts = raw.split(/[.,/]/).map(part => part.trim());
  return parts.every(part => /^\d+$/.test(part))
    ? fromDisplayIndexPath(parts.map(Number), start)
    : [];
}
