import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { compile, NodeTypes, parse as parseTemplate } from '@vue/compiler-dom';
import { parse as parseSfc } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import ts from 'typescript';
import { runExclusivePendingAction } from '../app/utils/acknowledgedAction.ts';

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
        projectHydrationStatus,
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
  const currentProject = { value: null as Record<string, never> | null };
  const projectHydrationStatus = { value: 'ready' };
  const handleKeydown = loadHandleKeydown({
    currentProject,
    projectHydrationStatus,
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
  currentProject.value = {};
  projectHydrationStatus.value = 'loading';
  handleKeydown(keyEvent(' '));
  assert.deepEqual(actions, ['stop-all'], 'partial project accepted a playback shortcut');
  handleKeydown(keyEvent('Escape'));
  assert.deepEqual(actions, ['stop-all', 'stop-all']);
});

function transpileFactory(source: string, factoryName: string): (...args: any[]) => any {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return Function(`${compiled}; return ${factoryName};`)();
}

function loadSetNextCaller(
  component: 'PlaylistItem' | 'CartSlot' | 'PlaybackControls' | 'WaveformTrimmer',
  dependencies: Record<string, unknown>,
): () => Promise<boolean> {
  const filename = new URL(`../app/components/${component}.vue`, import.meta.url);
  const source = readFileSync(filename, 'utf8');
  const names = {
    PlaylistItem: 'handleSetAsNext',
    CartSlot: 'handleSetAsNext',
    PlaybackControls: 'handleSetPreviewNext',
    WaveformTrimmer: 'setAuditionAsNext',
  } as const;
  const declaration = component === 'PlaybackControls'
    ? `function ${names[component]}`
    : `const ${names[component]}`;
  const start = source.indexOf(declaration);
  const end = component === 'PlaybackControls'
    ? source.indexOf('\n}', start) + 2
    : source.indexOf('\n\n', start);
  assert.ok(start >= 0 && end > start, `${component} Set As Next handler must be present`);
  const factory = transpileFactory(`
    function buildSetNextCaller(dependencies: Record<string, any>) {
      const { isManuallyQueued, previewItemUuid, props, setNextItem } = dependencies;
      ${source.slice(start, end)}
      return ${names[component]};
    }
  `, 'buildSetNextCaller');
  return factory(dependencies);
}

test('playlist and cart toggle Set As Next while Preview and Waveform stay set-only', async () => {
  const calls: Array<string | null> = [];
  const setNextItem = async (uuid: string | null) => {
    calls.push(uuid);
    return true;
  };
  const props = { item: { uuid: 'row-item' }, audioItem: { uuid: 'wave-item' } };
  const isManuallyQueued = { value: false };
  const playlist = loadSetNextCaller('PlaylistItem', { isManuallyQueued, props, setNextItem });
  await playlist();
  isManuallyQueued.value = true;
  await playlist();

  props.item.uuid = 'cart-item';
  isManuallyQueued.value = false;
  const cart = loadSetNextCaller('CartSlot', { isManuallyQueued, props, setNextItem });
  await cart();
  isManuallyQueued.value = true;
  await cart();

  const previewItemUuid = { value: 'preview-item' };
  const preview = loadSetNextCaller('PlaybackControls', { previewItemUuid, setNextItem });
  await preview();
  await preview();

  const waveform = loadSetNextCaller('WaveformTrimmer', { props, setNextItem });
  await waveform();
  await waveform();

  assert.deepEqual(calls, [
    'row-item', null,
    'cart-item', null,
    'preview-item', 'preview-item',
    'wave-item', 'wave-item',
  ]);
});

function loadSetNextCommand(dependencies: Record<string, unknown>) {
  const filename = new URL('../app/composables/useAudioEngine.ts', import.meta.url);
  const source = readFileSync(filename, 'utf8');
  const start = source.indexOf('  const setNextItem =');
  const end = source.indexOf('  // ---- Custom action:', start);
  assert.ok(start >= 0 && end > start, 'engine Set As Next command must be present');
  const factory = transpileFactory(`
    function buildSetNextCommand(dependencies: Record<string, any>) {
      const { server, setNextItemPending, runExclusivePendingAction } = dependencies;
      ${source.slice(start, end)}
      return setNextItem;
    }
  `, 'buildSetNextCommand');
  return factory(dependencies) as (uuid: string | null) => Promise<boolean>;
}

test('Set As Next waits for feedback without changing the displayed target', async () => {
  let resolveAck: (accepted: boolean) => void = () => {};
  const acknowledgement = new Promise<boolean>((resolve) => { resolveAck = resolve; });
  const commands: Array<string | null> = [];
  const displayedTarget = { value: 'previous-target' };
  const setNextItemPending = { value: false };
  const setNextItem = loadSetNextCommand({
    runExclusivePendingAction,
    setNextItemPending,
    server: {
      setNextItem: async (uuid: string | null) => {
        commands.push(uuid);
        return acknowledgement;
      },
    },
  });

  const requested = setNextItem('new-target');
  const duplicate = setNextItem('new-target');
  const conflicting = setNextItem(null);
  await Promise.resolve();
  assert.equal(setNextItemPending.value, true);
  assert.equal(displayedTarget.value, 'previous-target');
  assert.equal(await conflicting, false);
  assert.deepEqual(commands, ['new-target']);

  resolveAck(false);
  assert.deepEqual(await Promise.all([requested, duplicate]), [false, false]);
  assert.equal(setNextItemPending.value, false);
  assert.equal(displayedTarget.value, 'previous-target');
});

function loadNextItemFeedback(dependencies: Record<string, unknown>): {
  snapshot: (payload: any) => void;
  patch: (payload: any) => void;
} {
  const filename = new URL('../app/composables/useAudioEngine.ts', import.meta.url);
  const source = readFileSync(filename, 'utf8');
  const start = source.indexOf('  server.onPlaybackSnapshot');
  const end = source.indexOf('  // Meter broadcast:', start);
  assert.ok(start >= 0 && end > start, 'authoritative next-item feedback handlers must be present');
  const factory = transpileFactory(`
    function buildNextItemFeedback(dependencies: Record<string, any>) {
      const { executeHttpRequest, masterGainDb, nextItemOverrideUuid } = dependencies;
      let snapshot;
      let patch;
      const server = {
        onPlaybackSnapshot(callback: (payload: any) => void) { snapshot = callback; },
        onDocPatch(callback: (payload: any) => void) { patch = callback; },
      };
      ${source.slice(start, end)}
      return { snapshot, patch };
    }
  `, 'buildNextItemFeedback');
  return factory(dependencies);
}

test('only server patch and reconnect snapshot change the displayed next target', () => {
  const masterGainDb = { value: 0 };
  const nextItemOverrideUuid = { value: 'previous-target' as string | null };
  const feedback = loadNextItemFeedback({
    executeHttpRequest() {},
    masterGainDb,
    nextItemOverrideUuid,
  });

  feedback.patch({ op: 'unrelated' });
  assert.equal(nextItemOverrideUuid.value, 'previous-target');
  feedback.patch({ op: 'next_item_set', itemUuid: 'patch-target' });
  assert.equal(nextItemOverrideUuid.value, 'patch-target');
  feedback.snapshot({ next_item_uuid: 'reconnect-target', master_gain_db: -4.5 });
  assert.equal(nextItemOverrideUuid.value, 'reconnect-target');
  assert.equal(masterGainDb.value, -4.5);
  feedback.patch({ op: 'next_item_set', itemUuid: '' });
  assert.equal(nextItemOverrideUuid.value, null);
});

function loadMasterGainController(dependencies: Record<string, unknown>): {
  setMasterGain: (db: number) => Promise<boolean>;
  adjustMasterGain: (deltaDb: number) => Promise<boolean>;
} {
  const filename = new URL('../app/composables/useAudioEngine.ts', import.meta.url);
  const source = readFileSync(filename, 'utf8');
  const start = source.indexOf('  let pendingMasterGainRequests');
  const end = source.indexOf('  const setNextItem =', start);
  assert.ok(start >= 0 && end > start, 'authoritative master-gain controller must be present');
  const factory = transpileFactory(`
    function buildMasterGainController(dependencies: Record<string, any>) {
      const { masterGainDb, server } = dependencies;
      ${source.slice(start, end)}
      return { setMasterGain, adjustMasterGain };
    }
  `, 'buildMasterGainController');
  return factory(dependencies);
}

test('Global Master requests keep display authoritative, accumulate steps, and clamp bounds', async () => {
  const masterGainDb = { value: -4 };
  const requests: number[] = [];
  const releases: Array<() => void> = [];
  const controller = loadMasterGainController({
    masterGainDb,
    server: {
      setMasterGainDb: (db: number) => {
        requests.push(db);
        return new Promise<void>((resolve) => { releases.push(resolve); });
      },
    },
  });

  const first = controller.adjustMasterGain(1);
  const second = controller.adjustMasterGain(1);
  const high = controller.setMasterGain(999);
  const low = controller.setMasterGain(-999);
  assert.deepEqual(requests, [-3, -2, 12, -120]);
  assert.equal(masterGainDb.value, -4);
  releases.forEach(release => release());
  assert.deepEqual(await Promise.all([first, second, high, low]), [true, true, true, true]);
  assert.equal(masterGainDb.value, -4);
});

function loadMidiContinuous(dependencies: Record<string, unknown>): (action: string, value: number) => void {
  const filename = new URL('../app/composables/useMidiController.ts', import.meta.url);
  const source = readFileSync(filename, 'utf8');
  const start = source.indexOf('  const dispatchContinuous =');
  const end = source.indexOf('  /**', start);
  assert.ok(start >= 0 && end > start, 'MIDI continuous dispatcher must be present');
  const factory = transpileFactory(`
    function buildMidiContinuous(dependencies: Record<string, any>) {
      const { adjustMasterGain, config, DEFAULT_MASTER_VOLUME_MULTIPLIER, projectHydrationStatus } = dependencies;
      let lastMasterVolumeRaw: number | null = null;
      ${source.slice(start, end)}
      return dispatchContinuous;
    }
  `, 'buildMidiContinuous');
  return factory(dependencies);
}

test('MIDI Master Volume changes only the Global Master after its first reference sample', () => {
  const globalSteps: number[] = [];
  const pairWrites: number[] = [];
  const projectHydrationStatus = { value: 'loading' };
  const dispatch = loadMidiContinuous({
    DEFAULT_MASTER_VOLUME_MULTIPLIER: 1,
    adjustMasterGain: (deltaDb: number) => { globalSteps.push(deltaDb); return Promise.resolve(true); },
    config: { value: { masterVolumeMultiplier: 2.5 } },
    projectHydrationStatus,
    setOutputChannelGainDb: (db: number) => { pairWrites.push(db); },
  });

  dispatch('master-volume', 64);
  projectHydrationStatus.value = 'ready';
  dispatch('master-volume', 64);
  dispatch('master-volume', 65);
  dispatch('master-volume', 63);
  dispatch('master-volume', 63);
  assert.deepEqual(globalSteps, [2.5, -2.5]);
  assert.deepEqual(pairWrites, []);
});
