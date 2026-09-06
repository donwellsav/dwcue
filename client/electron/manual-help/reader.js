'use strict';

const searchForm = document.querySelector('#search-form');
const searchInput = document.querySelector('#search-input');
const previousButton = document.querySelector('#previous-match');
const nextButton = document.querySelector('#next-match');
const resultOutput = document.querySelector('#search-result');
const contentsButton = document.querySelector('#contents-page');
const manualSurface = document.querySelector('#manual-surface');

let activeQuery = '';

function queryValue() {
  return searchInput.value.trim();
}

function updateButtonState() {
  const disabled = queryValue().length === 0;
  previousButton.disabled = disabled;
  nextButton.disabled = disabled;
}

function presentResult(result) {
  const matches = Number.isInteger(result?.matches) ? result.matches : 0;
  const active = Number.isInteger(result?.activeMatchOrdinal) ? result.activeMatchOrdinal : 0;
  if (!activeQuery) {
    resultOutput.value = 'No search';
  } else if (matches === 0 && result?.finalUpdate === true) {
    resultOutput.value = 'No matches';
  } else if (matches === 0) {
    resultOutput.value = 'Searching…';
  } else {
    resultOutput.value = `${Math.max(1, active)} of ${matches}`;
  }
}

function clearSearch({ focus = false } = {}) {
  searchInput.value = '';
  activeQuery = '';
  updateButtonState();
  presentResult({ matches: 0, activeMatchOrdinal: 0 });
  window.operatorManual.clearSearch();
  if (focus) searchInput.focus();
}

function beginSearch() {
  const query = queryValue();
  updateButtonState();
  if (!query) {
    clearSearch();
    return;
  }
  activeQuery = query;
  resultOutput.value = 'Searching…';
  window.operatorManual.search(query, 'start');
}

function moveToMatch(direction) {
  const query = queryValue();
  if (!query) return;
  if (query !== activeQuery) {
    beginSearch();
    return;
  }
  window.operatorManual.search(query, direction);
}

function reportDocumentBounds() {
  const { x, y, width, height } = manualSurface.getBoundingClientRect();
  window.operatorManual.setDocumentBounds({ x, y, width, height });
}

new ResizeObserver(reportDocumentBounds).observe(manualSurface);
contentsButton.addEventListener('click', () => window.operatorManual.openContents());

searchForm.addEventListener('submit', event => {
  event.preventDefault();
  moveToMatch('next');
});

searchInput.addEventListener('input', beginSearch);
previousButton.addEventListener('click', () => moveToMatch('previous'));

window.operatorManual.onSearchResult(presentResult);
window.operatorManual.onFocusSearch(() => {
  searchInput.focus();
  searchInput.select();
});
window.operatorManual.onClearSearch(() => clearSearch({ focus: true }));

window.addEventListener('keydown', event => {
  const primary = event.metaKey || event.ctrlKey;
  if (primary && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
  } else if (!primary && !event.altKey && !event.shiftKey && event.key === 'Escape') {
    event.preventDefault();
    clearSearch({ focus: true });
  }
});

updateButtonState();
reportDocumentBounds();
