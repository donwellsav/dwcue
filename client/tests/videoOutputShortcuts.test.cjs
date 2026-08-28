'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeShortcutKey,
  shouldForwardVideoOutputShortcut,
  toRendererShortcut,
} = require('../electron/video-output-shortcuts');
const { buildVideoOutputContextTemplate } = require('../electron/video-output-context-menu');

const keyDown = (key, overrides = {}) => ({
  type: 'keyDown',
  key,
  code: '',
  control: false,
  shift: false,
  alt: false,
  meta: false,
  isAutoRepeat: false,
  ...overrides,
});

test('forwards configurable app shortcuts from the Windows video output', () => {
  assert.equal(shouldForwardVideoOutputShortcut(keyDown('p'), 'win32'), true);
  assert.equal(shouldForwardVideoOutputShortcut(keyDown('Space'), 'win32'), true);
  assert.equal(shouldForwardVideoOutputShortcut(keyDown('c', { control: true }), 'win32'), true);
  assert.equal(shouldForwardVideoOutputShortcut(keyDown('Escape'), 'win32'), true);
});

test('preserves Windows and Electron-native escape hatches', () => {
  assert.equal(shouldForwardVideoOutputShortcut(keyDown('F4', { alt: true }), 'win32'), false);
  assert.equal(shouldForwardVideoOutputShortcut(keyDown('d', { meta: true }), 'win32'), false);
  assert.equal(shouldForwardVideoOutputShortcut(keyDown('s', { control: true }), 'win32'), false);
  assert.equal(shouldForwardVideoOutputShortcut(keyDown('F11'), 'win32'), false);
  assert.equal(shouldForwardVideoOutputShortcut({ type: 'keyUp', key: 'p' }, 'win32'), false);
});

test('normalizes Electron key aliases and serializes renderer modifiers', () => {
  assert.equal(normalizeShortcutKey(keyDown('Spacebar')), ' ');
  assert.equal(normalizeShortcutKey(keyDown('Esc')), 'Escape');
  assert.equal(normalizeShortcutKey(keyDown('Up')), 'ArrowUp');
  assert.deepEqual(toRendererShortcut(keyDown('P', {
    code: 'KeyP',
    control: true,
    shift: true,
    isAutoRepeat: true,
  })), {
    key: 'P',
    code: 'KeyP',
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    repeat: true,
  });
});

test('video output context menu exposes recovery and exit actions', () => {
  const calls = [];
  const template = buildVideoOutputContextTemplate({
    fullscreen: true,
    testCard: false,
    labels: {
      enterFullscreen: 'Enter Full Screen',
      exitFullscreen: 'Exit Full Screen',
      showTestCard: 'Show Test Card',
      exitOutput: 'Exit Video Output',
    },
    onToggleFullscreen: () => calls.push('fullscreen'),
    onToggleTestCard: (visible) => calls.push(`test-card:${visible}`),
    onExit: () => calls.push('exit'),
  });

  assert.equal(template[0].label, 'Exit Full Screen');
  assert.deepEqual(template[1], {
    label: 'Show Test Card',
    type: 'checkbox',
    checked: false,
    click: template[1].click,
  });
  assert.equal(template[3].label, 'Exit Video Output');

  template[0].click();
  template[1].click({ checked: true });
  template[3].click();
  assert.deepEqual(calls, ['fullscreen', 'test-card:true', 'exit']);
});
