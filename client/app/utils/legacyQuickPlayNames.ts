// Shows saved before QuickPlay had its own name call it "cart" and "one shot".
// This file is the only place in the app that knows a show's old field names.
// A show document, or a list of cues, passes through convertLegacyQuickPlayNames()
// once, at the point it enters the app (from the engine, from a template file
// on disk, from the clipboard), so everything after that reads and writes only
// the current names. The engine does the same on its side.
//
//   document  cartOnlyItems  -> quickPlayItems
//   document  cartItems      -> quickPlaySlots
//   document  cartSlotKeys   -> quickPlaySlotKeys
//   settings  cartSlotCount  -> quickPlaySlotCount
//   per item  oneShot        -> quickPlay

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  !!value && typeof value === 'object' && !Array.isArray(value);

// Moves `oldName` to `newName`. When both exist the current name wins and the
// old one is dropped (the list of QuickPlay cues is the exception, see
// mergeItemLists).
const renameKey = (object: JsonObject, oldName: string, newName: string): void => {
  if (!Object.hasOwn(object, oldName)) return;
  if (!Object.hasOwn(object, newName)) object[newName] = object[oldName];
  delete object[oldName];
};

// The list of QuickPlay cues is the one thing that is merged rather than
// replaced. Both lists exist only when an older version saved a show this
// version made: it kept our list untouched, could not show it, and wrote its
// own beside it. Every cue in either list is kept. The older version's come
// first and keep their cells, because that is the arrangement the operator saw
// last; one of ours whose cell is now taken moves to the first free cell. A
// cue already in the list (same uuid) is not added twice.
const mergeItemLists = (object: JsonObject, oldName: string, newName: string): void => {
  const older = object[oldName];
  const current = object[newName];
  if (!Array.isArray(older) || !Array.isArray(current)) {
    renameKey(object, oldName, newName);
    return;
  }
  const uuidOf = (item: unknown) => (isObject(item) && typeof item.uuid === 'string' ? item.uuid : '');
  // A cue's QuickPlay settings, under whichever name it still has here.
  const settingsOf = (item: unknown): JsonObject | null => {
    if (!isObject(item)) return null;
    return [item.quickPlay, item.oneShot].find(isObject) ?? null;
  };
  const cellOf = (settings: JsonObject) => (Number.isInteger(settings.order) ? settings.order as number : -1);
  const present = new Set(older.map(uuidOf).filter(Boolean));
  const taken = new Set<number>();
  for (const item of older) {
    const settings = settingsOf(item);
    if (settings) taken.add(cellOf(settings));
  }
  const merged = [...older];
  let firstFree = 0;
  for (const item of current) {
    if (present.has(uuidOf(item))) continue;
    const settings = settingsOf(item);
    if (settings) {
      let cell = cellOf(settings);
      if (cell < 0 || taken.has(cell)) {
        while (taken.has(firstFree)) firstFree += 1;
        cell = firstFree;
        settings.order = cell;
        (item as JsonObject).index = [-1, cell];
      }
      taken.add(cell);
    }
    merged.push(item);
  }
  object[newName] = merged;
  delete object[oldName];
};

// Items nest: a group holds its cues in `children`, to any depth.
const renameItemKeys = (items: unknown): void => {
  const pending: unknown[] = [items];
  while (pending.length) {
    const list = pending.pop();
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isObject(item)) continue;
      renameKey(item, 'oneShot', 'quickPlay');
      pending.push(item.children);
    }
  }
};

/**
 * Renames every old name in a show document to its current one, in place,
 * without changing any value, and returns the same document. It also accepts
 * the parts of a document the engine hands over separately (the header, a page
 * of `items`). Anything that is not an object is returned untouched. Safe to
 * call on a document that already uses the current names.
 */
export function convertLegacyQuickPlayNames<T>(document: T): T {
  if (!isObject(document)) return document;
  mergeItemLists(document, 'cartOnlyItems', 'quickPlayItems');
  renameKey(document, 'cartItems', 'quickPlaySlots');
  renameKey(document, 'cartSlotKeys', 'quickPlaySlotKeys');
  if (isObject(document.settings)) renameKey(document.settings, 'cartSlotCount', 'quickPlaySlotCount');
  renameItemKeys(document.items);
  renameItemKeys(document.quickPlayItems);
  return document;
}
