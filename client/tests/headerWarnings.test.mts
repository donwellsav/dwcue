import assert from 'node:assert/strict';
import test from 'node:test';
import { canReplaceHeaderWarning, headerWarningDuration, normalizeHeaderWarningTiming } from '../app/utils/headerWarnings.ts';

test('header warnings use the configured duration for the displayed silence countdown', () => {
  const defaults = normalizeHeaderWarningTiming(undefined);
  assert.deepEqual([null, 31, 30, 15, 14, 0].map(seconds => headerWarningDuration(defaults, seconds)),
    [5, 3, 2, 2, 1, 1]);
  const custom = normalizeHeaderWarningTiming({
    noCountdown: 0.5, longCountdown: 0.4, shortCountdown: 0.3, urgentCountdown: 0.2,
    upperThreshold: 45, lowerThreshold: 10,
  });
  assert.deepEqual([null, 46, 45, 10, 9].map(seconds => headerWarningDuration(custom, seconds)),
    [0.5, 0.4, 0.3, 0.3, 0.2]);
  assert.deepEqual(normalizeHeaderWarningTiming({
    noCountdown: Infinity, longCountdown: 0, shortCountdown: '3', urgentCountdown: -4,
    upperThreshold: 5, lowerThreshold: 20,
  }), defaults);
});

test('urgent warnings take priority and repeated messages keep their original expiry', () => {
  const advisory = { message: 'Waiting for save', severity: 'advisory' as const };
  const urgent = { message: 'Output failed', severity: 'urgent' as const };
  assert.equal(canReplaceHeaderWarning(null, advisory), true);
  assert.equal(canReplaceHeaderWarning(advisory, urgent), true);
  assert.equal(canReplaceHeaderWarning(urgent, advisory), false);
  assert.equal(canReplaceHeaderWarning(urgent, { ...urgent }), false);
  assert.equal(canReplaceHeaderWarning(urgent, { ...urgent, message: 'Stop All unconfirmed' }), true);
});
