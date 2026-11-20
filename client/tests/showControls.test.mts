import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isTextEntry } from '../app/utils/textEntry.ts';
import { controlPressed } from '../app/utils/midiPress.ts';

const element = (tagName: string, type = '', isContentEditable = false) =>
  ({ tagName: tagName.toUpperCase(), type, isContentEditable }) as unknown as Element;
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('a slider, checkbox or button keeps the transport keys; text fields take them', () => {
  for (const type of ['range', 'checkbox', 'radio', 'button', 'color']) {
    assert.equal(isTextEntry(element('input', type)), false, `${type} is not typed into`);
  }
  for (const type of ['', 'text', 'search', 'number', 'password', 'time']) {
    assert.equal(isTextEntry(element('input', type)), true, `${type || 'plain'} input is typed into`);
  }
  assert.equal(isTextEntry(element('textarea')), true);
  assert.equal(isTextEntry(element('div', '', true)), true, 'editable text');
  assert.equal(isTextEntry(element('button')), false);
  assert.equal(isTextEntry(null), false);
});

test('every shortcut handler uses the same text-field rule, and a clicked slider gives up focus', () => {
  assert.match(source('../app/composables/useQuickPlayHotkeys.ts'), /isTextInputFocused = \(\): boolean => isTextEntry\(document\.activeElement\)/);
  assert.match(source('../app/components/MainWorkspace.vue'), /isTextInputFocused = \(\): boolean => isTextEntry\(document\.activeElement\)/);
  assert.match(source('../app/components/LevelCheckBar.vue'), /isEditingTarget = \(e: KeyboardEvent\): boolean => isTextEntry\(/);
  assert.match(source('../app/app.vue'), /closest\?\.\('button, \[role="button"\], a\[href\], summary, input\[type="range"\]/);
});

test('a CC button or fader mapped to GO fires once per press, not on every message', () => {
  const held = new Map<string, boolean>();
  const fired = [0, 40, 64, 90, 127, 127, 100, 70, 30, 0, 80].filter((value) => controlPressed(held, 'ch1:cc:20', value));
  assert.deepEqual(fired, [64, 80], 'fires as it rises past the midpoint, again only after coming back down');
  assert.equal(controlPressed(held, 'ch1:cc:21', 127), true, 'each control is tracked on its own');
});

test('MIDI runs in the operator workspace, not inside the QuickPlay panel', () => {
  const workspace = source('../app/components/MainWorkspace.vue');
  assert.match(workspace, /useMidiController\(\)/);
  assert.match(workspace, /void mountMidi\(\);/);
  assert.match(workspace, /unmountMidi\(\);/);
  assert.doesNotMatch(source('../app/components/QuickPlayPanel.vue'), /useMidiController|mountMidi/,
    'hiding or detaching QuickPlays must not switch MIDI off');
});

test('the detached QuickPlay window hands transport keys to the operator window', () => {
  const hotkeys = source('../app/composables/useQuickPlayHotkeys.ts');
  assert.match(hotkeys, /if \(isDetached && playbackAction !== 'stop-all' && !closingDetached\) \{[\s\S]*?forwardToOperator\(e\)/);
  assert.match(hotkeys, /const forwardToOperator = [\s\S]*?forwardShortcutToOperator/);
  const main = source('../electron/main.js');
  const relay = main.slice(main.indexOf("ipcMain.on('quickplay-window:shortcut'"));
  assert.ok(relay.length > 0, 'main relays the key');
  assert.match(relay.slice(0, 1400), /event\.sender !== detachedQuickPlayWindow\.webContents\) return;/, 'only from the detached window');
  assert.match(relay.slice(0, 1400), /mainWindow\.webContents\.send\('video-output:shortcut'/, 'to the operator window, as Video Output keys go');
  assert.match(source('../electron/preload.js'), /forwardShortcutToOperator: \(shortcut\) => ipcRenderer\.send\('quickplay-window:shortcut', shortcut\)/);
});

test('a socket this window swaps itself skips the reconnect choice; a failed check is retried', () => {
  const server = source('../app/composables/useLiveplayServer.ts');
  assert.match(server, /failPendingCommands\('Stop All canceled the pending cue command\.'\);\s*swapSocket\(\);/,
    'Stop All leaving a stuck GO behind swaps the socket, marked as a swap');
  assert.match(server, /const socketSwap = performance\.now\(\) - socketSwapAt < SOCKET_SWAP_WINDOW_MS;/);
  assert.match(server, /cb\(lifetime\.signal, \{ socketSwap \}\)/);
  const guard = source('../app/composables/useConnectionGuard.ts');
  const swapCheck = guard.indexOf("if (info.socketSwap && header.server.projectSessionId === server.projectSessionId) return 'verified';");
  assert.ok(swapCheck > 0 && swapCheck < guard.indexOf('if (hasUnsavedChanges.value)'),
    'the same engine show after a swap is verified before unsaved edits could ask for a choice');
  assert.match(guard, /for \(let attempt = 0; attempt < VERIFY_ATTEMPTS && !decided; attempt\+\+\)/);
  assert.match(guard, /const VERIFY_ATTEMPTS = 4;/);
});

test('a crashed operator or QuickPlays window reloads by itself', () => {
  const main = source('../electron/main.js');
  assert.match(main, /reloadAfterRendererCrash\(mainWindow, 'main-window'\);/);
  assert.match(main, /reloadAfterRendererCrash\(detachedQuickPlayWindow, 'QuickPlaysWindow'\);/);
  const helper = main.slice(main.indexOf('function reloadAfterRendererCrash'), main.indexOf('function createDetachedQuickPlayWindow'));
  assert.match(helper, /render-process-gone/);
  assert.match(helper, /if \(reason === 'clean-exit' \|\| quitConfirmed\) return;/);
  assert.match(helper, /window\.webContents\.reload\(\)/);
});

test('a lost or interrupted output is announced, in every language', () => {
  const alert = source('../app/components/ServerAlert.vue');
  assert.match(alert, /const TROUBLED_STATES = new Set\(\['stalled', 'disconnected', 'interrupted'\]\);/);
  assert.match(alert, /t\('audioHealth\.lost', \{ name: device\.display_name \}\)/);
  for (const code of ['ar', 'bn', 'de', 'el', 'en', 'es', 'fa', 'fr', 'hi', 'it', 'ja', 'ko', 'no', 'pt', 'ro', 'ru', 'sq', 'sv', 'tr', 'ur', 'zh']) {
    const messages = JSON.parse(source(`../locales/${code}.json`));
    assert.match(messages.audioHealth.lost, /\{name\}/, `${code} names the output`);
  }
});
