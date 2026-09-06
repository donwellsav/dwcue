'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const SEARCH_CHANNEL = 'operator-manual:search';
const SEARCH_RESULT_CHANNEL = 'operator-manual:search-result';
const FOCUS_SEARCH_CHANNEL = 'operator-manual:focus-search';
const CLEAR_SEARCH_CHANNEL = 'operator-manual:clear-search';
const BOUNDS_CHANNEL = 'operator-manual:document-bounds';
const CONTENTS_CHANNEL = 'operator-manual:open-contents';

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('A callback is required');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('operatorManual', {
  setDocumentBounds(bounds) {
    ipcRenderer.send(BOUNDS_CHANNEL, bounds);
  },
  openContents() {
    ipcRenderer.send(CONTENTS_CHANNEL);
  },
  search(query, direction) {
    ipcRenderer.send(SEARCH_CHANNEL, { query, direction });
  },
  clearSearch() {
    ipcRenderer.send(SEARCH_CHANNEL, { direction: 'clear' });
  },
  onSearchResult(callback) {
    return subscribe(SEARCH_RESULT_CHANNEL, callback);
  },
  onFocusSearch(callback) {
    return subscribe(FOCUS_SEARCH_CHANNEL, callback);
  },
  onClearSearch(callback) {
    return subscribe(CLEAR_SEARCH_CHANNEL, callback);
  },
});
