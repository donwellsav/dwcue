import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { compile, NodeTypes, parse as parseTemplate } from '@vue/compiler-dom';
import { parse as parseSfc } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import ts from 'typescript';

function panicButtonSource(): string {
  const filename = new URL('../app/components/PlaybackControls.vue', import.meta.url);
  const source = readFileSync(filename, 'utf8');
  const descriptor = parseSfc(source, { filename: filename.pathname }).descriptor;
  assert.ok(descriptor.template, 'PlaybackControls must have a template');
  const root = parseTemplate(descriptor.template.content);

  const visit = (node: any): any => {
    if (node.type === NodeTypes.ELEMENT && node.tag === 'button') {
      const classAttribute = node.props.find((prop: any) =>
        prop.type === NodeTypes.ATTRIBUTE && prop.name === 'class');
      if (classAttribute?.value?.content.split(/\s+/).includes('panic-btn')) return node;
    }
    for (const child of node.children ?? []) {
      const match = visit(child);
      if (match) return match;
    }
    return null;
  };

  const button = visit(root);
  assert.ok(button, 'PlaybackControls must render its panic button');
  return button.loc.source;
}

test('Stop All remains clickable when no project-backed cue is active', () => {
  const code = compile(panicButtonSource(), { mode: 'function' }).code;
  const render = Function('Vue', `${code}; return render;`)(Vue);
  let panicCalls = 0;
  const button = render({
    activeCues: new Map(),
    handlePanic: () => { panicCalls += 1; },
    stopAllTooltip: 'Stop All',
    t: (key: string) => key,
  }, []);

  assert.notEqual(button.props?.disabled, true);
  button.props?.onClick();
  assert.equal(panicCalls, 1);
});
function loadHandleKeydown(dependencies: Record<string, unknown>) {
  const filename = new URL('../app/composables/useCartHotkeys.ts', import.meta.url);
  const source = readFileSync(filename, 'utf8');
  const start = source.indexOf('  const handleKeydown =');
  const end = source.indexOf('  const updateBinding =', start);
  assert.ok(start >= 0 && end > start, 'hotkey handler must be present');
  const factorySource = `
    function buildHandleKeydown(dependencies: Record<string, any>) {
      const {
        currentProject,
        dispatchPlaybackAction,
        findPlaybackActionForEvent,
        findSlotForEvent,
        isForwardedFromVideoOutput,
        isTextInputFocused,
        triggerSlot,
      } = dependencies;
      ${source.slice(start, end)}
      return handleKeydown;
    }
  `;
  const compiled = ts.transpileModule(factorySource, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const buildHandleKeydown = Function(`${compiled}; return buildHandleKeydown;`)();
  return buildHandleKeydown(dependencies) as (event: any) => void;
}

test('Stop All shortcut reaches the server-global action without an open project', () => {
  const actions: string[] = [];
  const handleKeydown = loadHandleKeydown({
    currentProject: { value: null },
    dispatchPlaybackAction: (action: string) => { actions.push(action); },
    findPlaybackActionForEvent: (event: any) => event.key === 'Escape' ? 'stop-all' : 'play-next',
    findSlotForEvent: () => -1,
    isForwardedFromVideoOutput: () => false,
    isTextInputFocused: () => false,
    triggerSlot() {},
  });
  const keyEvent = (key: string) => ({
    key,
    preventDefault() {},
    stopPropagation() {},
  });

  handleKeydown(keyEvent('Escape'));
  assert.deepEqual(actions, ['stop-all']);

  handleKeydown(keyEvent(' '));
  assert.deepEqual(actions, ['stop-all'], 'non-panic playback bypassed the no-project guard');
});
