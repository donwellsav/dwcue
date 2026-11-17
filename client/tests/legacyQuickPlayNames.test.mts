import assert from 'node:assert/strict';
import test from 'node:test';
import { convertLegacyQuickPlayNames } from '../app/utils/legacyQuickPlayNames.ts';

const settings = { order: 2, retrigger: 'restart', hotkey: { key: 'q' } };

// A show as a version before the rename saved it.
const oldShow = () => ({
  name: 'Old show',
  items: [
    { uuid: 'a', type: 'audio', oneShot: { ...settings } },
    { uuid: 'g', type: 'group', children: [
      { uuid: 'b', type: 'audio' },
      { uuid: 'h', type: 'group', children: [{ uuid: 'c', type: 'audio', oneShot: { order: 5 } }] },
    ] },
  ],
  cartItems: [{ slot: 0, itemUuid: 'a', index: [-1, 0] }],
  cartSlotKeys: { 0: { key: '1' } },
  cartOnlyItems: [{ uuid: 'd', type: 'audio', index: [-1, 1], oneShot: { order: 1 } }],
  settings: { autoSave: true, cartSlotCount: 24 },
});

const oldNames = (value: unknown): string[] => {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) =>
    [...(/cart|one[-_]?shot/i.test(key) ? [key] : []), ...oldNames(child)]);
};

test('an old show comes out with every QuickPlay name current and no value changed', () => {
  const show = oldShow();
  const converted = convertLegacyQuickPlayNames(show) as any;
  assert.equal(converted, show, 'the document is converted in place');
  assert.deepEqual(oldNames(converted), []);
  assert.deepEqual(converted.quickPlaySlots, [{ slot: 0, itemUuid: 'a', index: [-1, 0] }]);
  assert.deepEqual(converted.quickPlaySlotKeys, { 0: { key: '1' } });
  assert.deepEqual(converted.settings, { autoSave: true, quickPlaySlotCount: 24 });
  assert.deepEqual(converted.items[0].quickPlay, settings);
  assert.deepEqual(converted.items[1].children[1].children[0].quickPlay, { order: 5 });
  assert.deepEqual(converted.quickPlayItems, [{ uuid: 'd', type: 'audio', index: [-1, 1], quickPlay: { order: 1 } }]);
  assert.equal(converted.name, 'Old show');
});

test('when a document has both names for one thing the current name wins', () => {
  const converted = convertLegacyQuickPlayNames({
    cartOnlyItems: [{ uuid: 'old' }], quickPlayItems: [{ uuid: 'new', oneShot: { order: 9 }, quickPlay: { order: 1 } }],
    cartItems: [{ slot: 1 }], quickPlaySlots: [{ slot: 2 }],
    cartSlotKeys: { 1: {} }, quickPlaySlotKeys: { 2: {} },
    settings: { cartSlotCount: 8, quickPlaySlotCount: 32 },
    items: [{ uuid: 'a', oneShot: { order: 4 }, quickPlay: { order: 0 } }],
  }) as any;
  assert.deepEqual(converted, {
    // The two lists of cues are the exception: nothing in either is dropped.
    quickPlayItems: [{ uuid: 'old' }, { uuid: 'new', quickPlay: { order: 1 } }],
    quickPlaySlots: [{ slot: 2 }],
    quickPlaySlotKeys: { 2: {} },
    settings: { quickPlaySlotCount: 32 },
    items: [{ uuid: 'a', quickPlay: { order: 0 } }],
  });
});

// An older version opens a show this version saved: it cannot see our list,
// keeps it in the file, and writes its own beside it.
test('QuickPlays made in an older version are kept beside ours', () => {
  const ours = [{ uuid: 'ours-a', quickPlay: { order: 0 } }, { uuid: 'ours-b', quickPlay: { order: 1 } }];
  assert.deepEqual(convertLegacyQuickPlayNames({
    cartOnlyItems: [{ uuid: 'made-in-old', oneShot: { order: 0 } }, { uuid: 'ours-b', oneShot: { order: 4 } }],
    quickPlayItems: structuredClone(ours),
  }), {
    // The older version's arrangement comes first; a cue in both is not doubled.
    quickPlayItems: [
      { uuid: 'made-in-old', quickPlay: { order: 0 } }, { uuid: 'ours-b', quickPlay: { order: 4 } },
      // Ours wanted cell 0, which the older version's cue now has: first free cell.
      { uuid: 'ours-a', quickPlay: { order: 1 }, index: [-1, 1] },
    ],
  });
  // The usual case: the older version made none, so it wrote an empty list.
  assert.deepEqual(convertLegacyQuickPlayNames({ cartOnlyItems: [], quickPlayItems: structuredClone(ours) }),
    { quickPlayItems: ours });
  // A list that is not a list is not merged: the current name wins.
  assert.deepEqual(convertLegacyQuickPlayNames({ cartOnlyItems: 'not a list', quickPlayItems: structuredClone(ours) }),
    { quickPlayItems: ours });
});

test('a current document is left exactly as it is, however often it is converted', () => {
  const current = convertLegacyQuickPlayNames(oldShow());
  const copy = structuredClone(current);
  assert.deepEqual(convertLegacyQuickPlayNames(convertLegacyQuickPlayNames(current)), copy);
});

test('the parts the engine sends separately convert too: a header and a page of items', () => {
  assert.deepEqual(
    convertLegacyQuickPlayNames({ hasOpenProject: true, cartItems: [], cartSlotKeys: {}, cartOnlyItems: [], settings: { cartSlotCount: 16 } }),
    { hasOpenProject: true, quickPlaySlots: [], quickPlaySlotKeys: {}, quickPlayItems: [], settings: { quickPlaySlotCount: 16 } },
  );
  assert.deepEqual(
    convertLegacyQuickPlayNames({ offset: 0, total: 1, items: [{ uuid: 'a', oneShot: { order: 0 } }] }),
    { offset: 0, total: 1, items: [{ uuid: 'a', quickPlay: { order: 0 } }] },
  );
});

test('anything that is not a show document passes through untouched', () => {
  for (const value of [null, undefined, '', 'show', 12, true]) {
    assert.equal(convertLegacyQuickPlayNames(value), value);
  }
  const list = [{ oneShot: 1 }];
  assert.equal(convertLegacyQuickPlayNames(list), list);
  assert.deepEqual(list, [{ oneShot: 1 }]);
  // Fields of the wrong shape are not a reason to fail: a damaged show still opens.
  assert.deepEqual(
    convertLegacyQuickPlayNames({ items: 'x', cartOnlyItems: [null, 3, { children: 'y' }], settings: [] }),
    { items: 'x', quickPlayItems: [null, 3, { children: 'y' }], settings: [] },
  );
});
