'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');

const MANUAL_SEARCH_CHANNEL = 'operator-manual:search';
const MANUAL_SEARCH_RESULT_CHANNEL = 'operator-manual:search-result';
const MANUAL_FOCUS_SEARCH_CHANNEL = 'operator-manual:focus-search';
const MANUAL_CLEAR_SEARCH_CHANNEL = 'operator-manual:clear-search';
const MANUAL_BOUNDS_CHANNEL = 'operator-manual:document-bounds';
const MANUAL_CONTENTS_CHANNEL = 'operator-manual:open-contents';
const ALLOWED_MANUAL_HOSTS = new Set([
  'github.com',
  'dwcue.com',
  'commons.wikimedia.org',
  'creativecommons.org',
]);

function resolveOperatorManualPaths({ isPackaged, resourcesPath, moduleDir = __dirname }) {
  const helpDir = path.join(moduleDir, 'manual-help');
  return {
    readerPath: path.join(helpDir, 'index.html'),
    preloadPath: path.join(helpDir, 'preload.js'),
    scriptPath: path.join(helpDir, 'reader.js'),
    stylePath: path.join(helpDir, 'reader.css'),
    pdfPath: isPackaged
      ? path.join(resourcesPath, 'help', 'operators-manual.pdf')
      : path.resolve(moduleDir, '..', '..', 'docs', 'operators-manual.pdf'),
  };
}

function exactFilePath(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'file:' || parsed.username || parsed.password || parsed.search) return null;
    return { path: path.resolve(fileURLToPath(parsed)), hash: parsed.hash };
  } catch {
    return null;
  }
}

function isAllowedManualExternalUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048 || /[\0\r\n]/.test(rawUrl)) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port &&
      ALLOWED_MANUAL_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function classifyManualNavigation(rawUrl, { readerPath, pdfPath }) {
  const local = exactFilePath(rawUrl);
  if (local) {
    if (local.path === path.resolve(readerPath) && local.hash === '') return 'internal';
    if (local.path === path.resolve(pdfPath)) return 'internal';
    return 'deny';
  }
  return isAllowedManualExternalUrl(rawUrl) ? 'external' : 'deny';
}

function normalizeSearchRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const direction = value.direction;
  if (!['start', 'next', 'previous', 'clear'].includes(direction)) return null;
  if (direction === 'clear') return { query: '', direction };
  if (typeof value.query !== 'string' || value.query.length > 256 || /[\0\r\n]/.test(value.query)) return null;
  const query = value.query.trim();
  if (!query) return { query: '', direction: 'clear' };
  return { query, direction };
}

function searchOperationFor(request, activeQuery = '') {
  const normalized = normalizeSearchRequest(request);
  if (!normalized) return null;
  if (normalized.direction === 'clear') return { type: 'clear', query: '' };
  const startsSession = normalized.direction === 'start' || normalized.query !== activeQuery;
  return {
    type: 'find',
    query: normalized.query,
    options: {
      forward: normalized.direction !== 'previous',
      findNext: startsSession,
      matchCase: false,
    },
  };
}

function isExactManualIpcSender(event, contents) {
  return !!event && !!contents &&
    event.sender === contents &&
    event.senderFrame === contents.mainFrame;
}

function manualShortcutAction(input) {
  if (!input || input.type !== 'keyDown' || typeof input.key !== 'string') return null;
  const key = input.key.toLowerCase();
  const primary = !!input.meta || !!input.control;
  if (primary && !input.alt && !input.shift && key === 'f') return 'focus-search';
  if (primary && !input.alt && !input.shift && key === 'w') return 'close';
  if (!primary && !input.alt && !input.shift && key === 'escape') return 'clear-search';
  return null;
}

function clampDocumentBounds(value, contentSize) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!contentSize || typeof contentSize !== 'object') return null;
  const numbers = [value.x, value.y, value.width, value.height, contentSize.width, contentSize.height];
  if (!numbers.every(number => Number.isFinite(number))) return null;
  const contentWidth = Math.max(0, Math.floor(contentSize.width));
  const contentHeight = Math.max(0, Math.floor(contentSize.height));
  const x = Math.min(contentWidth, Math.max(0, Math.floor(value.x)));
  const y = Math.min(contentHeight, Math.max(0, Math.floor(value.y)));
  const right = Math.min(contentWidth, Math.max(x, Math.ceil(value.x + Math.max(0, value.width))));
  const bottom = Math.min(contentHeight, Math.max(y, Math.ceil(value.y + Math.max(0, value.height))));
  return { x, y, width: right - x, height: bottom - y };
}

function createOperatorManual({ onFocus = () => {}, onClosed = () => {} } = {}) {
  const { app, BrowserWindow, dialog, ipcMain, shell, WebContentsView } = require('electron');
  const assets = resolveOperatorManualPaths({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  const ownedContents = new Set();
  let helpWindow = null;
  let pdfView = null;
  let readerWebContents = null;
  let pdfWebContents = null;
  let openingPromise = null;
  let boundParent = null;
  let activeQuery = '';
  let activeRequestId = null;
  let lastDocumentBounds = null;

  function safelyNotify(callback) {
    try {
      callback();
    } catch (error) {
      console.warn('[operator-manual] lifecycle callback failed:', error.message);
    }
  }

  function usableParent(parent) {
    return parent && typeof parent.isDestroyed === 'function' && !parent.isDestroyed() ? parent : null;
  }

  function focusOpenWindow(title) {
    if (!helpWindow || helpWindow.isDestroyed()) return false;
    if (typeof title === 'string' && title.trim()) helpWindow.setTitle(title.trim());
    if (helpWindow.isMinimized()) helpWindow.restore();
    helpWindow.show();
    helpWindow.focus();
    return true;
  }

  function unbindParent() {
    if (boundParent && !boundParent.isDestroyed()) boundParent.removeListener('closed', close);
    boundParent = null;
  }

  function close() {
    if (helpWindow && !helpWindow.isDestroyed()) helpWindow.close();
  }

  function owns(contents) {
    return !!contents && ownedContents.has(contents);
  }

  function readerContents() {
    return readerWebContents && !readerWebContents.isDestroyed() ? readerWebContents : null;
  }

  function pdfContents() {
    return pdfWebContents && !pdfWebContents.isDestroyed() ? pdfWebContents : null;
  }

  function sendToReader(channel, value) {
    const contents = readerContents();
    if (contents && !contents.isDestroyed()) contents.send(channel, value);
  }

  function handleSearch(event, request) {
    const reader = readerContents();
    const pdf = pdfContents();
    if (!reader || !pdf || !isExactManualIpcSender(event, reader)) return;
    const operation = searchOperationFor(request, activeQuery);
    if (!operation) return;
    if (operation.type === 'clear') {
      activeQuery = '';
      activeRequestId = null;
      pdf.stopFindInPage('clearSelection');
      sendToReader(MANUAL_SEARCH_RESULT_CHANNEL, {
        activeMatchOrdinal: 0,
        matches: 0,
        finalUpdate: true,
      });
      return;
    }
    activeQuery = operation.query;
    activeRequestId = pdf.findInPage(operation.query, operation.options);
  }

  function applyDocumentBounds(rawBounds) {
    if (!helpWindow || helpWindow.isDestroyed() || !pdfView) return;
    const content = helpWindow.getContentBounds();
    const bounds = clampDocumentBounds(rawBounds, { width: content.width, height: content.height });
    if (bounds) pdfView.setBounds(bounds);
  }

  ipcMain.on(MANUAL_SEARCH_CHANNEL, handleSearch);
  ipcMain.on(MANUAL_BOUNDS_CHANNEL, (event, bounds) => {
    const reader = readerContents();
    if (!reader || !isExactManualIpcSender(event, reader)) return;
    lastDocumentBounds = bounds;
    applyDocumentBounds(bounds);
  });
  ipcMain.on(MANUAL_CONTENTS_CHANNEL, event => {
    const reader = readerContents();
    const pdf = pdfContents();
    if (!reader || !pdf || !isExactManualIpcSender(event, reader)) return;
    const contentsUrl = `${pathToFileURL(assets.pdfPath).href}#page=2&view=FitH&navpanes=1&pagemode=bookmarks`;
    void pdf.loadURL(contentsUrl).catch(error => {
      console.warn('[operator-manual] failed to open contents page:', error.message);
    });
  });

  async function showOpenError(parent, error) {
    const options = {
      type: 'error',
      title: 'Operator Manual',
      message: 'The operator manual could not be opened.',
      detail: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
      buttons: ['OK'],
      defaultId: 0,
      noLink: true,
    };
    try {
      const owner = usableParent(parent);
      if (owner) await dialog.showMessageBox(owner, options);
      else await dialog.showMessageBox(options);
    } catch (dialogError) {
      console.error('[operator-manual] failed to show error dialog:', dialogError);
    }
  }

  function installNavigationGuard(contents, localPath) {
    const policy = { readerPath: assets.readerPath, pdfPath: assets.pdfPath };
    const allowedPath = path.resolve(localPath);
    const allowsHash = allowedPath === path.resolve(assets.pdfPath);
    const openAllowedExternal = rawUrl => {
      if (!isAllowedManualExternalUrl(rawUrl)) return;
      void shell.openExternal(rawUrl).catch(error => {
        console.warn('[operator-manual] failed to open external URL:', error.message);
      });
    };
    const guard = (event, rawUrl) => {
      const local = exactFilePath(rawUrl);
      if (local && local.path === allowedPath && (allowsHash || !local.hash)) return;
      const decision = classifyManualNavigation(rawUrl, policy);
      event.preventDefault();
      if (decision === 'external') openAllowedExternal(rawUrl);
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.setWindowOpenHandler(({ url }) => {
      openAllowedExternal(url);
      return { action: 'deny' };
    });
  }

  function installKeyboardPolicy(contents, candidate, candidateReaderContents) {
    contents.setIgnoreMenuShortcuts(true);
    contents.on('before-input-event', (event, input) => {
      const action = manualShortcutAction(input);
      if (!action) return;
      event.preventDefault();
      if (action === 'close') {
        candidate.close();
        return;
      }
      candidateReaderContents.focus();
      sendToReader(action === 'focus-search' ? MANUAL_FOCUS_SEARCH_CHANNEL : MANUAL_CLEAR_SEARCH_CHANNEL);
    });
  }

  async function createAndOpen(parent, title) {
    let candidate = null;
    let candidatePdfView = null;
    let candidateReaderContents = null;
    let candidatePdfContents = null;
    try {
      await Promise.all(Object.values(assets).map(asset => fs.promises.access(asset, fs.constants.R_OK)));
      const owner = usableParent(parent);
      const pdfUrl = pathToFileURL(assets.pdfPath).href;
      const readerUrl = pathToFileURL(assets.readerPath).href;
      const windowTitle = typeof title === 'string' && title.trim() ? title.trim() : 'Operator Manual';

      candidate = new BrowserWindow({
        width: 1240,
        height: 860,
        minWidth: 820,
        minHeight: 600,
        show: false,
        title: windowTitle,
        autoHideMenuBar: true,
        backgroundColor: '#17191e',
        webPreferences: {
          preload: assets.preloadPath,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          plugins: false,
          webSecurity: true,
        },
      });
      candidatePdfView = new WebContentsView({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          plugins: true,
          webSecurity: true,
        },
      });
      candidateReaderContents = candidate.webContents;
      candidatePdfContents = candidatePdfView.webContents;
      helpWindow = candidate;
      pdfView = candidatePdfView;
      readerWebContents = candidateReaderContents;
      pdfWebContents = candidatePdfContents;
      ownedContents.add(candidateReaderContents);
      ownedContents.add(candidatePdfContents);
      candidate.contentView.addChildView(candidatePdfView);
      const initial = candidate.getContentBounds();
      candidatePdfView.setBounds({ x: 0, y: 112, width: initial.width, height: Math.max(0, initial.height - 112) });
      candidate.setMenuBarVisibility(false);

      installNavigationGuard(candidateReaderContents, assets.readerPath);
      installNavigationGuard(candidatePdfContents, assets.pdfPath);
      installKeyboardPolicy(candidateReaderContents, candidate, candidateReaderContents);
      installKeyboardPolicy(candidatePdfContents, candidate, candidateReaderContents);
      candidateReaderContents.on('page-title-updated', event => event.preventDefault());
      candidatePdfContents.on('found-in-page', (_event, result) => {
        if (!result || result.requestId !== activeRequestId) return;
        sendToReader(MANUAL_SEARCH_RESULT_CHANNEL, {
          activeMatchOrdinal: Number.isInteger(result.activeMatchOrdinal) ? result.activeMatchOrdinal : 0,
          matches: Number.isInteger(result.matches) ? result.matches : 0,
          finalUpdate: !!result.finalUpdate,
        });
      });
      candidate.on('resize', () => {
        if (lastDocumentBounds) applyDocumentBounds(lastDocumentBounds);
      });
      candidate.on('focus', () => safelyNotify(onFocus));
      candidate.once('closed', () => {
        ownedContents.delete(candidateReaderContents);
        ownedContents.delete(candidatePdfContents);
        if (!candidatePdfContents.isDestroyed()) candidatePdfContents.close();
        if (helpWindow === candidate) helpWindow = null;
        if (pdfView === candidatePdfView) pdfView = null;
        if (readerWebContents === candidateReaderContents) readerWebContents = null;
        if (pdfWebContents === candidatePdfContents) pdfWebContents = null;
        activeQuery = '';
        activeRequestId = null;
        lastDocumentBounds = null;
        unbindParent();
        safelyNotify(onClosed);
      });
      if (owner) {
        boundParent = owner;
        owner.once('closed', close);
      }

      await Promise.all([
        candidate.loadURL(readerUrl),
        candidatePdfContents.loadURL(`${pdfUrl}#view=FitH&navpanes=1&pagemode=bookmarks`),
      ]);
      if (candidate.isDestroyed() || candidatePdfContents.isDestroyed()) return false;
      candidate.show();
      candidate.focus();
      return true;
    } catch (error) {
      if (candidatePdfContents && !candidatePdfContents.isDestroyed()) candidatePdfContents.close();
      if (candidate && !candidate.isDestroyed()) candidate.destroy();
      await showOpenError(parent, error);
      return false;
    }
  }

  async function open(parent, title) {
    if (openingPromise) {
      const opened = await openingPromise;
      if (opened) focusOpenWindow(title);
      return opened;
    }
    if (focusOpenWindow(title)) return true;
    openingPromise = createAndOpen(parent, title);
    try {
      return await openingPromise;
    } finally {
      openingPromise = null;
    }
  }

  return { open, owns, close };
}

module.exports = {
  clampDocumentBounds,
  classifyManualNavigation,
  createOperatorManual,
  isAllowedManualExternalUrl,
  isExactManualIpcSender,
  manualShortcutAction,
  normalizeSearchRequest,
  resolveOperatorManualPaths,
  searchOperationFor,
};
