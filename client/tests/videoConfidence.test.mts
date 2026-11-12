import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import ts from 'typescript';

test('fresh captures do not claim frame progress and sparse/paused pictures do not trigger a freeze alarm', () => {
  const source = readFileSync(new URL('../app/components/VideoConfidenceChip.vue', import.meta.url), 'utf8');
  const script = parse(source).descriptor.scriptSetup!.content.replaceAll('import.meta.client', 'true');
  const compiled = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const build = Function('deps', `const { ref, shallowRef, computed, watch, defineProps, useLocalization, onMounted, onUnmounted } = deps;
    ${compiled}; return { status, now, lastFrameAt, stale, pictureLabel };`);
  const scope = Vue.effectScope();
  const chip = scope.run(() => build({ ...Vue, defineProps: () => ({ open: true }),
    useLocalization: () => ({ t: (key: string, args: unknown) => `${key}:${JSON.stringify(args)}` }),
    onMounted() {}, onUnmounted() {},
  }));
  chip.now.value = 100000;
  chip.lastFrameAt.value = 100000;
  chip.status.value = { rendererReady: true, rendererResponsive: true, pictureHealth: {
    state: 'playing', receivedAt: 100000, presentedAgeMs: 60000, mediaTime: 3, droppedFrames: 1,
  } };
  assert.equal(chip.stale.value, false, 'VFR/still video can legitimately have a long frame interval');
  assert.match(chip.pictureLabel.value, /frameAge.*60/);
  chip.status.value = { ...chip.status.value, pictureHealth: { ...chip.status.value.pictureHealth, state: 'paused' } };
  assert.equal(chip.stale.value, false);
  assert.match(chip.pictureLabel.value, /states.paused/);
  chip.now.value += 4000;
  chip.lastFrameAt.value = chip.now.value;
  assert.equal(chip.stale.value, true, 'fresh capture cannot hide missing renderer health messages');
  chip.status.value = { ...chip.status.value, recoveryRequired: true };
  assert.match(chip.pictureLabel.value, /heldBlack/);
  scope.stop();
});
