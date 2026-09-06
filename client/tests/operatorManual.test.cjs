'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const {
  clampDocumentBounds,
  classifyManualNavigation,
  createOperatorManual,
  isAllowedManualExternalUrl,
  isExactManualIpcSender,
  manualShortcutAction,
  normalizeSearchRequest,
  resolveOperatorManualPaths,
  searchOperationFor,
} = require('../electron/operator-manual');

const moduleDir = path.join(path.sep, 'workspace', 'client', 'electron');
const policy = {
  readerPath: path.join(moduleDir, 'manual-help', 'index.html'),
  pdfPath: path.join(path.sep, 'workspace', 'docs', 'operators-manual.pdf'),
};

test('resolves the development and packaged manual without depending on cwd', () => {
  const development = resolveOperatorManualPaths({
    isPackaged: false,
    resourcesPath: path.join(path.sep, 'unused'),
    moduleDir,
  });
  assert.deepEqual(development, {
    readerPath: path.join(moduleDir, 'manual-help', 'index.html'),
    preloadPath: path.join(moduleDir, 'manual-help', 'preload.js'),
    scriptPath: path.join(moduleDir, 'manual-help', 'reader.js'),
    stylePath: path.join(moduleDir, 'manual-help', 'reader.css'),
    pdfPath: path.join(path.sep, 'workspace', 'docs', 'operators-manual.pdf'),
  });

  const resourcesPath = path.join(path.sep, 'Applications', 'Cue.app', 'Contents', 'Resources');
  const packaged = resolveOperatorManualPaths({ isPackaged: true, resourcesPath, moduleDir });
  assert.equal(packaged.pdfPath, path.join(resourcesPath, 'help', 'operators-manual.pdf'));
  assert.equal(packaged.readerPath, development.readerPath);
});

test('navigation admits only the fixed reader/PDF files and exact public HTTPS hosts', () => {
  assert.equal(classifyManualNavigation(pathToFileURL(policy.readerPath).href, policy), 'internal');
  assert.equal(classifyManualNavigation(`${pathToFileURL(policy.pdfPath).href}#page=23`, policy), 'internal');
  assert.equal(
    classifyManualNavigation(pathToFileURL(path.join(moduleDir, 'preload.js')).href, policy),
    'deny',
  );
  assert.equal(classifyManualNavigation(`${pathToFileURL(policy.readerPath).href}?redirect=x`, policy), 'deny');

  for (const host of ['github.com', 'dwcue.com', 'commons.wikimedia.org', 'creativecommons.org']) {
    const url = `https://${host}/manual/reference`;
    assert.equal(isAllowedManualExternalUrl(url), true);
    assert.equal(classifyManualNavigation(url, policy), 'external');
  }

  for (const url of [
    'http://github.com/donwellsav/dwcue',
    'https://docs.github.com/',
    'https://github.com.evil.example/',
    'https://user@github.com/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://dwcue.com\n.example/',
  ]) {
    assert.equal(isAllowedManualExternalUrl(url), false, url);
    assert.equal(classifyManualNavigation(url, policy), 'deny', url);
  }
});

test('search policy starts native sessions, advances both directions, and clears empty input', () => {
  assert.deepEqual(searchOperationFor({ query: '  output routing  ', direction: 'start' }), {
    type: 'find',
    query: 'output routing',
    options: { forward: true, findNext: true, matchCase: false },
  });
  assert.deepEqual(searchOperationFor({ query: 'output routing', direction: 'next' }, 'output routing'), {
    type: 'find',
    query: 'output routing',
    options: { forward: true, findNext: false, matchCase: false },
  });
  assert.deepEqual(searchOperationFor({ query: 'output routing', direction: 'previous' }, 'output routing'), {
    type: 'find',
    query: 'output routing',
    options: { forward: false, findNext: false, matchCase: false },
  });
  assert.deepEqual(searchOperationFor({ query: 'different', direction: 'next' }, 'output routing'), {
    type: 'find',
    query: 'different',
    options: { forward: true, findNext: true, matchCase: false },
  });
  assert.deepEqual(searchOperationFor({ query: '   ', direction: 'start' }), { type: 'clear', query: '' });
  assert.deepEqual(searchOperationFor({ direction: 'clear' }), { type: 'clear', query: '' });
  assert.equal(normalizeSearchRequest({ query: 'x', direction: 'sideways' }), null);
  assert.equal(normalizeSearchRequest({ query: 'x\nmalformed', direction: 'start' }), null);
  assert.equal(normalizeSearchRequest({ query: 'x'.repeat(257), direction: 'start' }), null);
});

test('search IPC requires both the owned WebContents and its exact main frame', () => {
  const mainFrame = {};
  const contents = { mainFrame };
  assert.equal(isExactManualIpcSender({ sender: contents, senderFrame: mainFrame }, contents), true);
  assert.equal(isExactManualIpcSender({ sender: contents, senderFrame: {} }, contents), false);
  assert.equal(isExactManualIpcSender({ sender: {}, senderFrame: mainFrame }, contents), false);
  assert.equal(isExactManualIpcSender(null, contents), false);
});

test('manual keyboard policy handles reader controls without claiming transport keys', () => {
  assert.equal(manualShortcutAction({ type: 'keyDown', key: 'f', meta: true }), 'focus-search');
  assert.equal(manualShortcutAction({ type: 'keyDown', key: 'F', control: true }), 'focus-search');
  assert.equal(manualShortcutAction({ type: 'keyDown', key: 'w', meta: true }), 'close');
  assert.equal(manualShortcutAction({ type: 'keyDown', key: 'Escape' }), 'clear-search');
  assert.equal(manualShortcutAction({ type: 'keyDown', key: ' ', control: false }), null);
  assert.equal(manualShortcutAction({ type: 'keyDown', key: 'F1' }), null);
  assert.equal(manualShortcutAction({ type: 'keyDown', key: 'ArrowRight' }), null);
  assert.equal(manualShortcutAction({ type: 'keyDown', key: 'f', meta: true, shift: true }), null);
  assert.equal(manualShortcutAction({ type: 'keyUp', key: 'w', meta: true }), null);
});

test('document bounds are finite integers clamped to the help content area', () => {
  assert.deepEqual(
    clampDocumentBounds({ x: 10.2, y: 20.8, width: 100.5, height: 200.1 }, { width: 500, height: 400 }),
    { x: 10, y: 20, width: 101, height: 201 },
  );
  assert.deepEqual(
    clampDocumentBounds({ x: -8, y: -4, width: 120, height: 80 }, { width: 100, height: 60 }),
    { x: 0, y: 0, width: 100, height: 60 },
  );
  assert.deepEqual(
    clampDocumentBounds({ x: 490, y: 390, width: 100, height: 100 }, { width: 500, height: 400 }),
    { x: 490, y: 390, width: 10, height: 10 },
  );
  assert.equal(clampDocumentBounds({ x: 0, y: 0, width: Number.NaN, height: 10 }, { width: 20, height: 20 }), null);
  assert.equal(clampDocumentBounds(null, { width: 20, height: 20 }), null);
});

test('factory exposes only the reusable help lifecycle', () => {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request !== 'electron') return originalLoad.call(this, request, parent, isMain);
    return {
      app: { isPackaged: false },
      BrowserWindow: class {},
      dialog: {},
      ipcMain: { on() {} },
      shell: {},
      WebContentsView: class {},
    };
  };
  try {
    const manual = createOperatorManual();
    assert.deepEqual(Object.keys(manual).sort(), ['close', 'open', 'owns']);
  } finally {
    Module._load = originalLoad;
  }
});
