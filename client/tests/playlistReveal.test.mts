import assert from 'node:assert/strict';
import test from 'node:test';
import { usePlaylistReveal } from '../app/composables/usePlaylistReveal.ts';

test('locating Up Next reveals nested groups without changing selection or saved expansion', () => {
  const selected = { uuid: 'selection', type: 'group', isExpanded: false, children: [{ uuid: 'editing' }] };
  const inner = { uuid: 'inner', type: 'group', isExpanded: false, children: [{ uuid: 'queued' }] };
  const outer = { uuid: 'outer', type: 'group', isExpanded: false, children: [inner] };
  Object.assign(globalThis, {
    useProject: () => ({ currentProject: { value: { items: [selected, outer] } } }),
    useState: (_key: string, init: () => Set<string>) => ({ value: init() }),
  });
  const { revealItems, isRevealed } = usePlaylistReveal();

  revealItems('editing', 'queued');
  assert.deepEqual(['selection', 'outer', 'inner'].map(isRevealed), [true, true, true]);
  assert.deepEqual([selected, outer, inner].map(group => group.isExpanded), [false, false, false]);

  revealItems('editing');
  assert.deepEqual(['selection', 'outer', 'inner'].map(isRevealed), [true, false, false]);
});
