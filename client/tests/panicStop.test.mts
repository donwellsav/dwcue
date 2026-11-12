import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { compile, NodeTypes, parse as parseTemplate } from '@vue/compiler-dom';
import { parse as parseSfc } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import ts from 'typescript';
import { runExclusivePendingAction } from '../app/utils/acknowledgedAction.ts';
import { DEFAULT_PLAYBACK_KEYS } from '../app/types/project.ts';
import { bindingsMatch, eventToBinding } from '../app/composables/useCartHotkeys.ts';

function elementSource(component: string, tag: string, className?: string): string {
  const filename = new URL(`../app/components/${component}.vue`, import.meta.url);
  const source = readFileSync(filename, 'utf8');
  const descriptor = parseSfc(source, { filename: filename.pathname }).descriptor;
  assert.ok(descriptor.template, `${component} must have a template`);
  const root = parseTemplate(descriptor.template.content);

  const visit = (node: any): any => {
    if (node.type === NodeTypes.ELEMENT && node.tag === tag) {
      const classAttribute = node.props.find((prop: any) =>
        prop.type === NodeTypes.ATTRIBUTE && prop.name === 'class');
      if (!className || classAttribute?.value?.content.split(/\s+/).includes(className)) return node;
    }
    for (const child of node.children ?? []) {
      const match = visit(child);
      if (match) return match;
    }
    return null;
  };

  const element = visit(root);
  assert.ok(element, `${component} must render ${className || tag}`);
  return element.loc.source;
}

test('Stop All remains clickable when no project-backed cue is active', () => {
  const code = compile(elementSource('PlaybackControls', 'button', 'panic-btn'), { mode: 'function' }).code;
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

test('Stop All sends the normal command from transfer, file selection and loading dialogs', () => {
  const dialogs = [
    ['AudioImportModal', 'header'],
    ['SpotifyImportModal', 'header'],
    ['YouTubeImportModal', 'div', 'modal-header'],
    ['ProgressModal', 'div', 'modal-content'],
    ['ServerFilePickerModal', 'header', 'toolbar'],
    ['LocationChoiceModal', 'div', 'lc-footer'],
    ['ConnectionLostModal', 'div', 'clm-dialog'],
    ['LoadingOverlay', 'div', 'loading-panel'],
  ];
  for (const [component, tag, className] of dialogs) {
    const code = compile(elementSource(component, tag, className), { mode: 'function' }).code;
    const render = Function('Vue', `${code}; return render;`)({
      ...Vue, resolveComponent: (name: string) => name, withDirectives: (vnode: Vue.VNode) => vnode,
      renderSlot: () => Vue.createCommentVNode(),
    });
    const stopCalls: unknown[][] = [];
    const region = render({
      $slots: {},
      t: (key: string) => key,
      busy: true, isBusy: true, visible: true, background: false, percentage: 50, attempts: 0, actionError: '', verifying: false,
      titleId: 'import-test', title: 'Working', message: 'Working', isDark: true, subtitle: '',
      pickingLocal: true, isChoosingDestination: true,
      historyBack: [], canGoUp: false, pathDraft: '', goBack() {}, goUp() {}, navigate() {}, cancelLabel: 'Cancel',
      server: { stopAll: (...args: unknown[]) => { stopCalls.push(args); } },
      onReconnect() {}, onRestart() {}, onExit() {},
      close: () => assert.fail('Stop All must not close the import'),
      cancel: () => assert.fail('Stop All must not cancel file selection'),
      handleClose: () => assert.fail('Stop All must not close the import'),
      closeModal: () => assert.fail('Stop All must not close the import'),
    }, []);
    const button = region.children.find((child: Vue.VNode) => child.props?.text === 'controls.stopAll');
    assert.ok(button, `${component} must show Stop All during its operation`);
    assert.notEqual(button.props.disabled, true);
    assert.equal(button.props.type, 'button', 'Stop All must not submit an import form');
    button.props.onClick();
    assert.deepEqual(stopCalls, [[]], `${component} must let the server apply the configured Stop All fade`);
  }
});

test('Stop All remains available inside the recovery prompt while a recovery choice is pending', () => {
  const code = compile(elementSource('SessionRecoveryModal', 'div', 'srm-dialog'), { mode: 'function' }).code;
  const render = Function('Vue', `${code}; return render;`)({ ...Vue, resolveComponent: (name: string) => name });
  const stopCalls: unknown[][] = [];
  const server = { connected: true, stopAll: (...args: unknown[]) => stopCalls.push(args) };
  const context = { t: (key: string) => key, projectChanged: true, recovering: true, server,
    currentProject: { name: 'Local show' }, serverProjectName: 'Server show', actionFailed: false };
  const findStop = () => render(context, []).children.find((child: Vue.VNode) =>
    child.props?.text === 'controls.stopAll');
  const button = findStop();
  assert.ok(button, 'recovery must offer Stop All when the transport is connected');
  assert.notEqual(button.props.disabled, true);
  button.props.onClick();
  assert.deepEqual(stopCalls, [[]], 'recovery uses the normal server fade');
  server.connected = false;
  assert.ok(findStop(), 'the HTTP stop must remain available during a second disconnect');
});

test('the configured Stop All shortcut works during recovery and project loading', () => {
  const source = readFileSync(new URL('../app/composables/useConnectionGuard.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  const trapKeydown =');
  const end = source.indexOf('  window.addEventListener', start);
  assert.ok(start >= 0 && end > start);
  const code = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const calls: unknown[][] = [];
  const sessionLost = { value: true };
  const projectLoading = { value: false };
  const server = {
    connected: true, connectionLost: false, showVerification: false,
    get cueStartsBlocked() { return this.connectionLost || this.showVerification || sessionLost.value; },
    stopAll: (...args: unknown[]) => calls.push(args),
  };
  const currentProject = { value: { playbackKeys: {} as Record<string, unknown> } };
  const trap = Function('server', 'projectLoading', 'currentProject', 'DEFAULT_PLAYBACK_KEYS', 'bindingsMatch', 'eventToBinding',
    `${code}\nreturn trapKeydown;`)(server, projectLoading, currentProject, DEFAULT_PLAYBACK_KEYS, bindingsMatch, eventToBinding);
  const press = (key: string, opts = {}) => {
    let swallowed = false;
    trap({ key, target: { closest: () => null }, ctrlKey: false, metaKey: false, shiftKey: false,
      altKey: false, repeat: false, preventDefault() {}, stopImmediatePropagation() { swallowed = true; }, ...opts });
    return swallowed;
  };
  assert.equal(press(' '), true, 'GO must stay guarded');
  assert.equal(press('Tab'), false);
  assert.deepEqual(calls, []);
  assert.equal(press('Escape'), true);
  press('Escape', { repeat: true });
  assert.deepEqual(calls, [[]]);
  currentProject.value.playbackKeys['stop-all'] = { key: 'k', ctrlKey: true, shiftKey: false, altKey: false };
  press('Escape');
  assert.equal(press('K', { metaKey: true, target: { closest: (selector: string) => selector.includes('.srm-overlay') } }), true);
  currentProject.value.playbackKeys['stop-all'] = null;
  press('Escape');
  assert.deepEqual(calls, [[], []]);
  server.connected = false;
  server.connectionLost = true;
  currentProject.value.playbackKeys = {};
  press('Escape');
  assert.deepEqual(calls, [[], [], []]);
  server.connected = true;
  server.connectionLost = false;
  sessionLost.value = false;
  server.showVerification = true;
  assert.equal(press(' '), true);
  assert.equal(press('Escape'), true);
  assert.deepEqual(calls, [[], [], [], []]);
  server.showVerification = false;
  projectLoading.value = true;
  currentProject.value.playbackKeys['stop-all'] = { key: 'F9', ctrlKey: false, shiftKey: false, altKey: false };
  assert.equal(press('F9'), true, 'loading captures Stop All without the One Shots panel');
  assert.equal(press(' '), false, 'loading leaves other shortcuts to their usual handlers');
  projectLoading.value = false;
  assert.equal(press('F9'), false, 'the trap defers to normal routing after loading');
  assert.deepEqual(calls, [[], [], [], [], []]);
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
        oneShotPlaybackReady = { get value() { return projectHydrationStatus.value === 'ready'; } },
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

test('workspace shortcuts keep Stop All, repeat suppression, and text focus behavior', () => {
  const actions: string[] = [];
  let typing = false;
  const handleKeydown = loadHandleKeydown({
    currentProject: { value: {} },
    projectHydrationStatus: { value: 'ready' },
    dispatchPlaybackAction: (action: string) => actions.push(action),
    findPlaybackActionForEvent: ({ key }: { key: string }) =>
      key === 'F9' ? 'stop-all' : key === ' ' ? 'play-next' : null,
    findSlotForEvent: () => 0,
    isForwardedFromVideoOutput: (event: { forwarded?: boolean }) => event.forwarded === true,
    isTextInputFocused: () => typing,
    triggerSlot: () => actions.push('one-shot'),
  });
  const press = (key: string, overrides = {}) => handleKeydown({
    key, preventDefault() {}, stopPropagation() {}, ...overrides,
  });

  press(' ');
  press('1');
  press('F9');
  press('F9', { repeat: true });
  press('F9', { defaultPrevented: true });
  typing = true;
  press('F9');
  press('1');
  assert.deepEqual(actions, ['play-next', 'one-shot', 'stop-all']);
  press('F9', { forwarded: true });

  typing = false;
  press(' ');
  press('1');
  press('F9');
  assert.deepEqual(actions, ['play-next', 'one-shot', 'stop-all', 'stop-all', 'play-next', 'one-shot', 'stop-all']);
});

function transpileFactory(source: string, factoryName: string): (...args: any[]) => any {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return Function(`${compiled}; return ${factoryName};`)();
}

function midiRecoveryHarness() {
  const source = readFileSync(new URL('../app/composables/useMidiController.ts', import.meta.url), 'utf8');
  const slice = (start: string, end: string) => {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    return source.slice(from, to);
  };
  const sessionLost = { value: true };
  const projectHydrationStatus = { value: 'ready' };
  const learning = { value: null as string | null };
  const server = {
    connectionLost: false, showVerification: false,
    get cueStartsBlocked() { return this.connectionLost || this.showVerification || sessionLost.value; },
  };
  const calls: string[] = [], learned: unknown[] = [];
  const build = transpileFactory(`
    function buildMidi(deps: Record<string, any>) {
      const { sessionLost, projectHydrationStatus, learning, server, calls, learned } = deps;
      const useLiveplayServer = () => server;
      const config = { value: { bindings: {
        'play-next': { channel: 0, type: 'note', number: 60 },
        'stop-all': { channel: 0, type: 'note', number: 61 },
        'master-volume': { channel: 0, type: 'cc', number: 7 },
      }, masterVolumeMultiplier: 1 } };
      const MIDI_ACTIONS = [
        { id: 'play-next', continuous: false }, { id: 'stop-all', continuous: false },
        { id: 'master-volume', continuous: true },
      ];
      const DEFAULT_MASTER_VOLUME_MULTIPLIER = 1;
      const lastMidiMessage = { value: null };
      let lastMasterVolumeRaw = null;
      const onLearnCapture = binding => learned.push(binding);
      const playNext = async () => { calls.push('go'); return true; };
      const stopAllCues = async () => { calls.push('stop'); return true; };
      const adjustMasterGain = async db => { calls.push('gain:' + db); return true; };
      ${slice('const bindingsMatch =', '// Shared singleton state')}
      ${slice('  const dispatchDiscrete =', '  /**\n   * Update connected device list')}
      return handleMidiMessage;
    }
  `, 'buildMidi');
  const handle = build({ sessionLost, projectHydrationStatus, learning, server, calls, learned });
  return { sessionLost, projectHydrationStatus, learning, server, calls, learned,
    send: (status: number, number: number, value: number) => handle({
      data: new Uint8Array([status, number, value]), target: { name: 'synthetic-controller' },
    }),
  };
}

test('MIDI cannot fire GO or change master level while session recovery is unresolved', () => {
  const midi = midiRecoveryHarness();
  midi.send(0x90, 60, 127);
  midi.send(0xb0, 7, 64);
  midi.send(0xb0, 7, 65);
  assert.deepEqual(midi.calls, []);
  midi.sessionLost.value = false;
  midi.send(0x90, 60, 127);
  midi.send(0xb0, 7, 66);
  midi.send(0xb0, 7, 67);
  assert.deepEqual(midi.calls, ['go', 'gain:1']);
});

test('MIDI Stop and Learn remain available during recovery', () => {
  const midi = midiRecoveryHarness();
  midi.projectHydrationStatus.value = 'loading';
  midi.send(0x90, 61, 127);
  assert.deepEqual(midi.calls, ['stop']);
  midi.server.connectionLost = true;
  midi.sessionLost.value = false;
  midi.projectHydrationStatus.value = 'ready';
  midi.send(0x90, 60, 127);
  midi.send(0x90, 61, 127);
  assert.deepEqual(midi.calls, ['stop', 'stop']);
  midi.server.connectionLost = false;
  midi.server.showVerification = true;
  midi.send(0x90, 60, 127);
  assert.deepEqual(midi.calls, ['stop', 'stop']);
  midi.learning.value = 'play-next';
  midi.send(0x90, 60, 127);
  assert.deepEqual(midi.learned, [{ channel: 0, type: 'note', number: 60 }]);
  assert.deepEqual(midi.calls, ['stop', 'stop']);
});

test('held keys fire discrete actions once while selection arrows can repeat', () => {
  const actions: string[] = [];
  let slots = 0;
  const handle = loadHandleKeydown({
    currentProject: { value: {} }, projectHydrationStatus: { value: 'ready' },
    dispatchPlaybackAction: (action: string) => { actions.push(action); },
    findPlaybackActionForEvent: (event: any) => ({
      ' ': 'play-next', Enter: 'play-selected', p: 'pause-resume',
      Escape: 'stop-all', ArrowDown: 'select-down',
    }[event.key] ?? null),
    findSlotForEvent: (event: any) => event.key === '1' ? 0 : -1,
    isForwardedFromVideoOutput: () => false, isTextInputFocused: () => false,
    triggerSlot: () => { slots++; },
  });
  for (const key of [' ', 'Enter', 'p', 'Escape', 'ArrowDown', '1']) {
    for (const repeat of [false, true, true]) {
      handle({ key, repeat, preventDefault() {}, stopPropagation() {} });
    }
  }
  assert.deepEqual(actions, [
    'play-next', 'play-selected', 'pause-resume', 'stop-all',
    'select-down', 'select-down', 'select-down',
  ]);
  assert.equal(slots, 1);
});

test('broadcast HTTP actions cannot execute side effects in client windows', () => {
  const source = readFileSync(new URL('../app/composables/useAudioEngine.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  server.onDocPatch((patch: any) => {');
  const end = source.indexOf('  // Meter broadcast:', start);
  assert.ok(start >= 0 && end > start);
  let callback: (patch: unknown) => void = () => {};
  let requests = 0;
  const code = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  Function('server', 'nextItemOverrideUuid', 'masterGainDb', 'executeHttpRequest', code)(
    { onDocPatch: (handler: typeof callback) => { callback = handler; } },
    { value: null }, { value: 0 }, () => { requests++; },
  );
  callback({ op: 'custom_action_http', action: { request: { url: 'http://stage.invalid/cue' } } });
  assert.equal(requests, 0);
});

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
  const end = source.indexOf('  return {', start);
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
      const { adjustMasterGain, config, DEFAULT_MASTER_VOLUME_MULTIPLIER, projectHydrationStatus, sessionLost } = dependencies;
      let lastMasterVolumeRaw: number | null = null;
      ${source.slice(start, end)}
      return dispatchContinuous;
    }
  `, 'buildMidiContinuous');
  return factory(dependencies);
}

test('Up Next follows playlist order when active cues arrived in reverse order', () => {
  const source = readFileSync(new URL('../app/composables/useAudioEngine.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  const autoNextItemUuid =');
  const end = source.indexOf('  // ---- WS / REST plumbing', start);
  assert.ok(start >= 0 && end > start);
  const build = transpileFactory(`
    function buildNext(deps: Record<string, any>) {
      const { computed, currentProject, activeCues, findItemByUuid, findItemByIndex, getAllItemsFlat } = deps;
      ${source.slice(start, end)}
      return autoNextItemUuid;
    }
  `, 'buildNext');
  const items = ['a', 'b', 'c', 'd'].map((uuid, i) => ({ uuid, type: 'audio', index: [i], endBehavior: { action: 'next' } }));
  const cart = { uuid: 'cart', type: 'audio', index: [-1, 0], endBehavior: { action: 'loop' } };
  const currentProject = Vue.ref({ items, settings: { autoCueNextWithoutEndBehavior: true } });
  const activeCues = Vue.ref(new Map(['cart', 'c', 'a'].map(uuid => [uuid, {}])));
  const next = build({ computed: Vue.computed, currentProject, activeCues,
    getAllItemsFlat: () => currentProject.value.items,
    findItemByUuid: (uuid: string) => [...currentProject.value.items, cart].find(item => item.uuid === uuid),
    findItemByIndex: ([index]: number[]) => currentProject.value.items[index],
  });
  assert.equal(next.value, 'b');
  currentProject.value.items[0].endBehavior.action = 'loop';
  assert.equal(next.value, 'a');
  activeCues.value = new Map([['a', {}]]);
  currentProject.value.items[0].endBehavior.action = 'nothing';
  assert.equal(next.value, 'b');
  currentProject.value.settings.autoCueNextWithoutEndBehavior = false;
  assert.equal(next.value, null);
});

test('MIDI Master Volume changes only the Global Master after its first reference sample', () => {
  const globalSteps: number[] = [];
  const pairWrites: number[] = [];
  const projectHydrationStatus = { value: 'loading' };
  const dispatch = loadMidiContinuous({
    DEFAULT_MASTER_VOLUME_MULTIPLIER: 1,
    adjustMasterGain: (deltaDb: number) => { globalSteps.push(deltaDb); return Promise.resolve(true); },
    config: { value: { masterVolumeMultiplier: 2.5 } },
    projectHydrationStatus,
    sessionLost: { value: false },
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
