// =====================================================================
// utils/playlistSearch.ts
// ---------------------------------------------------------------------
// Matching and stepping for the playlist search field. Pure: the playlist
// tree and the typed text in, row uuids out. PlaylistSearch.vue owns the
// field; PlaylistView scrolls to the row and holds its groups open.
//
// The search only ever points at a row. It never filters or reorders the
// playlist: hiding rows during a show is dangerous.
// =====================================================================

// The parts of a cue or group the search reads. AudioItem and GroupItem fit.
export interface SearchablePlaylistItem {
  uuid: string;
  displayName: string;
  note?: string;
  index?: number[] | null;
  children?: readonly SearchablePlaylistItem[];
}

export interface PlaylistSearchMatches {
  // Every matching row in playlist order, groups and their children included.
  uuids: string[];
  // Where a new search lands: the row whose cue number is exactly what was
  // typed, otherwise the first match. -1 when nothing matches.
  start: number;
}

// The accents of Latin, Greek and Cyrillic letters once they are decomposed.
// Other scripts keep their marks: in Devanagari, say, the marks are the vowels.
const ACCENTS = /[̀-ͯ]/g;

/**
 * Fold case, accents and spacing, so "cafe" finds "Café" and "STRASSE" finds
 * "Straße". Upper-casing before lower-casing is what folds ß to ss and the
 * Turkish dotless i to i.
 */
export function normalizeSearchText(text: unknown): string {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(ACCENTS, '')
    .toUpperCase()
    .toLowerCase()
    .replace(/ς/g, 'σ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find every cue and group whose title, playlist note or displayed cue number
 * contains the query. `formatNumber` turns an item's index into the number the
 * playlist row shows.
 */
export function findPlaylistMatches(
  items: readonly SearchablePlaylistItem[],
  query: string,
  formatNumber: (index?: number[] | null) => string,
): PlaylistSearchMatches {
  const needle = normalizeSearchText(query);
  const uuids: string[] = [];
  if (!needle) return { uuids, start: -1 };

  let exactNumber = -1;
  const walk = (level: readonly SearchablePlaylistItem[]) => {
    for (const item of level) {
      const number = normalizeSearchText(formatNumber(item.index));
      if (number.includes(needle)
          || normalizeSearchText(item.displayName).includes(needle)
          || normalizeSearchText(item.note).includes(needle)) {
        // Typing "2" should land on cue 2, not on cue 1,2 further up the list.
        if (number === needle && exactNumber === -1) exactNumber = uuids.length;
        uuids.push(item.uuid);
      }
      if (Array.isArray(item.children)) walk(item.children);
    }
  };
  walk(items);

  return { uuids, start: exactNumber !== -1 ? exactNumber : uuids.length > 0 ? 0 : -1 };
}

/**
 * The match after (1) or before (-1) the current one, wrapping round at either
 * end. With no current match it starts from the first, or from the last when
 * stepping backwards.
 */
export function stepPlaylistMatch(
  uuids: readonly string[],
  current: string | null,
  direction: 1 | -1,
): string | null {
  if (uuids.length === 0) return null;
  const at = current === null ? -1 : uuids.indexOf(current);
  if (at === -1) return uuids[direction === 1 ? 0 : uuids.length - 1] ?? null;
  return uuids[(at + direction + uuids.length) % uuids.length] ?? null;
}
