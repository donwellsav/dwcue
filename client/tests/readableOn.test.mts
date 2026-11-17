import assert from 'node:assert/strict';
import test from 'node:test';
import { DARK_INK, LIGHT_INK, readableOn } from '../app/utils/readableOn.ts';

test('a light colour gets dark text and a dark colour gets white text', () => {
  assert.equal(readableOn('#FFD23F'), DARK_INK);   // yellow
  assert.equal(readableOn('#3ecf7a'), DARK_INK);   // green
  assert.equal(readableOn('#F4762A'), DARK_INK);   // orange
  assert.equal(readableOn('#9900FF'), LIGHT_INK);  // purple
  assert.equal(readableOn('#315FCF'), LIGHT_INK);  // blue
  assert.equal(readableOn('#000'), LIGHT_INK);
  assert.equal(readableOn('#fff'), DARK_INK);
});

test('anything that is not a hex colour gets white text', () => {
  for (const value of [null, undefined, '', 'red', 'var(--x)', '#12', '#12345']) {
    assert.equal(readableOn(value as string), LIGHT_INK);
  }
});
