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
// old one is dropped.
const renameKey = (object: JsonObject, oldName: string, newName: string): void => {
  if (!Object.hasOwn(object, oldName)) return;
  if (!Object.hasOwn(object, newName)) object[newName] = object[oldName];
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
  renameKey(document, 'cartOnlyItems', 'quickPlayItems');
  renameKey(document, 'cartItems', 'quickPlaySlots');
  renameKey(document, 'cartSlotKeys', 'quickPlaySlotKeys');
  if (isObject(document.settings)) renameKey(document.settings, 'cartSlotCount', 'quickPlaySlotCount');
  renameItemKeys(document.items);
  renameItemKeys(document.quickPlayItems);
  return document;
}
