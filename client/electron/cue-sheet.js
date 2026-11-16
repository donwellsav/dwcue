'use strict';

// Printable cue sheet (File > Export Cue Sheet). Pure: no Electron and no file
// system. main.js owns the save dialog, the hidden print window and the write;
// this module turns the renderer's untrusted summary of the open show into
// bounded plain data and into the HTML that window prints. Every string that
// reaches the page goes through escapeHtml, and the page carries no script.

// The text limits also bound the printout: a row of full-length wide (CJK)
// text stays under half a page, so the row limit is at most about 2,500 pages.
// Chromium's print renderer was measured to fail somewhere past 4,200.
const CUE_SHEET_LIMITS = Object.freeze({
  // Playlist rows (cues and groups) plus QuickPlays rows.
  maxRows: 5000,
  maxQuickPlays: 256,
  maxDepth: 16,
  maxShowNameLength: 200,
  maxTitleLength: 200,
  // The playlist's own note field stops at 120 characters.
  maxNoteLength: 200,
  maxLabelLength: 120,
  // The whole show crosses IPC in 10 MB (sync-project-data); this is part of it.
  maxPayloadBytes: 10 * 1024 * 1024,
});

const MAX_DURATION_SECONDS = 1000 * 3600;
const MAX_LINEAR_VOLUME = 1000;
const MAX_GROUP_GAIN_DB = 200;
const MAX_INDEX_VALUE = 1000000;
// The playlist shows nested cue numbers as "2,1" (utils/indexDisplay.ts).
const CUE_NUMBER_SEPARATOR = ',';
const EMPTY_CELL = '—';
// Deeper groups keep the fourth indent; their cue numbers still tell them apart.
const MAX_INDENT_DEPTH = 4;

// English fallbacks. The renderer sends translated strings under the same
// names (locale keys cueSheet.<name>); anything missing or invalid uses these.
const DEFAULT_CUE_SHEET_LABELS = Object.freeze({
  title: 'Cue sheet',
  generated: 'Generated',
  cues: 'Cues',
  runningTime: 'Total running time',
  playlist: 'Playlist',
  quickPlays: 'QuickPlays',
  columnNumber: '#',
  columnSlot: 'Slot',
  columnTitle: 'Title',
  columnNote: 'Note',
  columnDuration: 'Duration',
  columnLevel: 'Level (dB)',
  columnEnd: 'At end',
  endNothing: 'Stop',
  endNext: 'Next',
  endGoto: 'Go to',
  endLoop: 'Loop',
  emptyPlaylist: 'No cues in the playlist.',
  truncated: 'This list was shortened to the first {count} rows.',
  page: 'Page {page} of {pages}',
  untitledShow: 'Untitled show',
});

// A translation that drops a placeholder would silently lose the number.
const LABEL_PLACEHOLDERS = Object.freeze({
  truncated: ['{count}'],
  page: ['{page}', '{pages}'],
});

const END_ACTIONS = new Map([
  ['nothing', 'nothing'],
  ['next', 'next'],
  ['loop', 'loop'],
  ['goto', 'goto'],
  ['goto-item', 'goto'],
  ['goto-index', 'goto'],
]);

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const HTML_ENTITIES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
}

// One line of bounded text: control characters and line breaks become spaces,
// and anything longer than the limit ends in an ellipsis.
function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  // Bound the work before any regex runs over a hostile multi-megabyte string.
  const bounded = value.length > maxLength * 4 ? value.slice(0, maxLength * 4) : value;
  const text = bounded.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  const characters = Array.from(text);
  return characters.length > maxLength
    ? `${characters.slice(0, maxLength - 1).join('').trimEnd()}…`
    : text;
}

function boundedNumber(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeIndexPath(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > CUE_SHEET_LIMITS.maxDepth) return [];
  return value.every((part) => Number.isSafeInteger(part) && part >= 0 && part <= MAX_INDEX_VALUE)
    ? [...value]
    : [];
}

function normalizeEndBehavior(raw) {
  const action = isRecord(raw) && typeof raw.action === 'string'
    ? END_ACTIONS.get(raw.action) ?? ''
    : '';
  return {
    action,
    targetIndex: action === 'goto' ? normalizeIndexPath(raw.targetIndex) : [],
  };
}

function normalizeItems(rawItems, depth, budget) {
  const items = [];
  if (!Array.isArray(rawItems)) return items;
  for (const entry of rawItems) {
    if (budget.rows >= CUE_SHEET_LIMITS.maxRows) {
      budget.truncated = true;
      break;
    }
    budget.rows += 1;
    // A malformed entry still takes its place: cue numbers come from the
    // position in the list, so dropping it would renumber everything after it.
    const raw = isRecord(entry) ? entry : {};
    const item = {
      type: raw.type === 'group' ? 'group' : 'audio',
      displayName: cleanText(raw.displayName, CUE_SHEET_LIMITS.maxTitleLength),
      note: cleanText(raw.note, CUE_SHEET_LIMITS.maxNoteLength),
      endBehavior: normalizeEndBehavior(raw.endBehavior),
    };
    if (item.type === 'group') {
      item.groupGainDb = boundedNumber(raw.groupGainDb, -MAX_GROUP_GAIN_DB, MAX_GROUP_GAIN_DB) ?? 0;
      if (depth + 1 < CUE_SHEET_LIMITS.maxDepth) {
        item.children = normalizeItems(raw.children, depth + 1, budget);
      } else {
        item.children = [];
        if (Array.isArray(raw.children) && raw.children.length > 0) budget.truncated = true;
      }
    } else {
      item.duration = boundedNumber(raw.duration, 0, MAX_DURATION_SECONDS);
      item.volume = boundedNumber(raw.volume, 0, MAX_LINEAR_VOLUME);
    }
    items.push(item);
  }
  return items;
}

function normalizeQuickPlays(rawQuickPlays, budget) {
  const quickPlays = [];
  if (!Array.isArray(rawQuickPlays)) return quickPlays;
  for (const raw of rawQuickPlays) {
    if (!isRecord(raw)) continue;
    if (quickPlays.length >= CUE_SHEET_LIMITS.maxQuickPlays || budget.rows >= CUE_SHEET_LIMITS.maxRows) {
      budget.truncated = true;
      break;
    }
    budget.rows += 1;
    quickPlays.push({
      slot: Number.isSafeInteger(raw.slot) && raw.slot >= 1 && raw.slot <= MAX_INDEX_VALUE ? raw.slot : null,
      displayName: cleanText(raw.displayName, CUE_SHEET_LIMITS.maxTitleLength),
      duration: boundedNumber(raw.duration, 0, MAX_DURATION_SECONDS),
      volume: boundedNumber(raw.volume, 0, MAX_LINEAR_VOLUME),
      endBehavior: normalizeEndBehavior(raw.endBehavior),
    });
  }
  return quickPlays;
}

// Untrusted payload in, bounded plain data out, in the same shape, so
// normalising twice changes nothing. Never throws: unusable fields become
// blanks that print as a dash.
function normalizeCueSheet(payload) {
  const raw = isRecord(payload) ? payload : {};
  const budget = { rows: 0, truncated: raw.truncated === true };
  const items = normalizeItems(raw.items, 0, budget);
  const quickPlays = normalizeQuickPlays(raw.quickPlays, budget);
  return {
    showName: cleanText(raw.showName, CUE_SHEET_LIMITS.maxShowNameLength),
    // Number shown for the first playlist cue (Settings > First cue number).
    indexStart: Number.isSafeInteger(raw.indexStart) && raw.indexStart >= 1 && raw.indexStart <= MAX_INDEX_VALUE
      ? raw.indexStart
      : 1,
    items,
    quickPlays,
    truncated: budget.truncated,
  };
}

function normalizeCueSheetLabels(rawLabels) {
  const raw = isRecord(rawLabels) ? rawLabels : {};
  const labels = {};
  for (const [name, fallback] of Object.entries(DEFAULT_CUE_SHEET_LABELS)) {
    const value = Object.hasOwn(raw, name) && typeof raw[name] === 'string' &&
      raw[name].length <= CUE_SHEET_LIMITS.maxLabelLength
      ? cleanText(raw[name], CUE_SHEET_LIMITS.maxLabelLength)
      : '';
    const placeholders = LABEL_PLACEHOLDERS[name] || [];
    labels[name] = value && placeholders.every((placeholder) => value.includes(placeholder))
      ? value
      : fallback;
  }
  return labels;
}

// m:ss, or h:mm:ss from one hour up; whole seconds are floored like the
// playlist row. '' when the length is unknown.
function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}`
    : `${minutes}:${rest}`;
}

// Linear cue volume to dB: -Infinity for silence, null when unknown.
function volumeToDb(volume) {
  if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0) return null;
  return volume === 0 ? -Infinity : 20 * Math.log10(volume);
}

function formatLevelDb(db) {
  if (typeof db !== 'number' || Number.isNaN(db)) return '';
  if (db === -Infinity) return '-∞';
  if (db === Infinity) return '';
  const rounded = Math.round(db * 10) / 10;
  if (rounded === 0) return '0.0';
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}`;
}

function formatCueNumber(indexPath, indexStart) {
  return indexPath.map((part) => part + indexStart).join(CUE_NUMBER_SEPARATOR);
}

function formatGeneratedAt(value, locale) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) return '';
  for (const candidate of [locale, undefined]) {
    try {
      return new Intl.DateTimeFormat(
        typeof candidate === 'string' && candidate ? candidate : undefined,
        { dateStyle: 'medium', timeStyle: 'short' },
      ).format(date);
    } catch {
      // Unknown locale tag: fall through to the system default.
    }
  }
  return date.toISOString();
}

function flattenPlaylist(sheet) {
  const rows = [];
  const known = new Set();
  let cueCount = 0;
  let totalSeconds = 0;
  const walk = (items, parentPath, depth) => {
    items.forEach((item, position) => {
      const indexPath = [...parentPath, position];
      known.add(indexPath.join(','));
      rows.push({ item, depth, number: formatCueNumber(indexPath, sheet.indexStart) });
      if (item.type === 'group') {
        walk(item.children, indexPath, depth + 1);
      } else {
        cueCount += 1;
        totalSeconds += item.duration ?? 0;
      }
    });
  };
  walk(sheet.items, [], 0);
  return { rows, known, cueCount, totalSeconds };
}

function endText(endBehavior, labels, sheet, known) {
  switch (endBehavior.action) {
    case 'nothing': return labels.endNothing;
    case 'next': return labels.endNext;
    case 'loop': return labels.endLoop;
    case 'goto': {
      const target = endBehavior.targetIndex;
      // Name the target only when it is a row on this sheet.
      return target.length > 0 && known.has(target.join(','))
        ? `${labels.endGoto} ${formatCueNumber(target, sheet.indexStart)}`
        : labels.endGoto;
    }
    default: return '';
  }
}

const cell = (className, text) => `<td class="${className}">${escapeHtml(text)}</td>`;

const SHEET_FONT = "-apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

// Page margins in inches, shared by the print options and the page footer.
const PAGE_MARGIN_INCHES = Object.freeze({ top: 0.55, bottom: 0.75, left: 0.55, right: 0.55 });

const SHEET_STYLE = `
  @page { size: A4 portrait; }
  * { box-sizing: border-box; }
  html { background: #fff; }
  body { margin: 0; background: #fff; color: #111; font: 11pt/1.35 ${SHEET_FONT};
    -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet-header { border-bottom: 1.5pt solid #111; padding-bottom: 8pt; margin-bottom: 14pt; }
  .sheet-kind { margin: 0 0 2pt; font-size: 10pt; font-weight: 700; letter-spacing: 0.08em;
    text-transform: uppercase; color: #444; }
  h1 { margin: 0 0 6pt; font-size: 20pt; line-height: 1.2; overflow-wrap: anywhere; }
  .sheet-meta { margin: 0; display: flex; flex-wrap: wrap; gap: 2pt 22pt; }
  .sheet-meta div { display: flex; gap: 5pt; }
  .sheet-meta dt { color: #444; }
  .sheet-meta dd { margin: 0; font-weight: 700; font-variant-numeric: tabular-nums; }
  h2 { margin: 0 0 5pt; font-size: 13pt; break-after: avoid; }
  section + section { margin-top: 18pt; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th, td { padding: 4pt 5pt; border-bottom: 0.5pt solid #9aa1ab; vertical-align: top;
    text-align: start; overflow-wrap: anywhere; }
  th { font-size: 10pt; font-weight: 700; background: #eef0f3; border-bottom: 1pt solid #111;
    overflow-wrap: normal; }
  .number, .duration, .level { font-variant-numeric: tabular-nums; }
  .duration, .level { text-align: end; white-space: nowrap; }
  .note { color: #2b2f36; }
  .end { padding-inline-start: 10pt; }
  tr.group td { font-weight: 700; background: #e3e7ee; border-bottom-color: #6f7783; }
  ${Array.from({ length: MAX_INDENT_DEPTH }, (_, index) =>
    `.depth-${index + 1} .title { padding-inline-start: ${5 + (index + 1) * 10}pt; }`).join('\n  ')}
  .empty, .notice { margin: 6pt 0 0; color: #444; }
`;

const PLAYLIST_COLUMNS = [8, 31, 25, 12, 12, 12];
const QUICK_PLAY_COLUMNS = [8, 56, 12, 12, 12];

const colgroup = (widths) =>
  `<colgroup>${widths.map((width) => `<col style="width:${width}%">`).join('')}</colgroup>`;

const headerRow = (cells) => `<thead><tr>${cells.map(([className, text]) =>
  `<th class="${className}" scope="col">${escapeHtml(text)}</th>`).join('')}</tr></thead>`;

function safeLanguageTag(locale) {
  return typeof locale === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale) ? locale : 'en';
}

// data: the renderer payload or the result of normalizeCueSheet (it is
// normalised here either way). labels: already-translated strings, see
// DEFAULT_CUE_SHEET_LABELS. options: { generatedAt, locale, direction }.
function buildCueSheetHtml(data, labels, options = {}) {
  const sheet = normalizeCueSheet(data);
  const text = normalizeCueSheetLabels(labels);
  const { rows, known, cueCount, totalSeconds } = flattenPlaylist(sheet);
  const showName = sheet.showName || text.untitledShow;
  const direction = options.direction === 'rtl' ? 'rtl' : 'ltr';
  const level = (item) => formatLevelDb(item.type === 'group' ? item.groupGainDb : volumeToDb(item.volume));

  const html = [
    '<!doctype html>',
    `<html lang="${escapeHtml(safeLanguageTag(options.locale))}" dir="${direction}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">',
    `<title>${escapeHtml(`${showName} – ${text.title}`)}</title>`,
    `<style>${SHEET_STYLE}</style>`,
    '</head>',
    '<body>',
    '<header class="sheet-header">',
    `<p class="sheet-kind">${escapeHtml(text.title)}</p>`,
    `<h1>${escapeHtml(showName)}</h1>`,
    '<dl class="sheet-meta">',
    `<div><dt>${escapeHtml(text.generated)}</dt><dd>${escapeHtml(formatGeneratedAt(options.generatedAt, options.locale))}</dd></div>`,
    `<div><dt>${escapeHtml(text.cues)}</dt><dd>${cueCount}</dd></div>`,
    `<div><dt>${escapeHtml(text.runningTime)}</dt><dd>${escapeHtml(formatDuration(totalSeconds))}</dd></div>`,
    '</dl>',
    '</header>',
    '<section class="playlist">',
    `<h2>${escapeHtml(text.playlist)}</h2>`,
  ];

  if (rows.length === 0) {
    html.push(`<p class="empty">${escapeHtml(text.emptyPlaylist)}</p>`);
  } else {
    html.push(
      '<table>',
      colgroup(PLAYLIST_COLUMNS),
      headerRow([
        ['number', text.columnNumber],
        ['title', text.columnTitle],
        ['note', text.columnNote],
        ['duration', text.columnDuration],
        ['level', text.columnLevel],
        ['end', text.columnEnd],
      ]),
      '<tbody>',
    );
    for (const { item, depth, number } of rows) {
      const group = item.type === 'group';
      const classes = [group ? 'group' : 'cue'];
      if (depth > 0) classes.push(`depth-${Math.min(depth, MAX_INDENT_DEPTH)}`);
      html.push(
        `<tr class="${classes.join(' ')}">` +
        cell('number', number) +
        cell('title', item.displayName || EMPTY_CELL) +
        cell('note', item.note) +
        cell('duration', group ? '' : formatDuration(item.duration) || EMPTY_CELL) +
        cell('level', level(item) || EMPTY_CELL) +
        cell('end', endText(item.endBehavior, text, sheet, known)) +
        '</tr>',
      );
    }
    html.push('</tbody>', '</table>');
  }
  html.push('</section>');

  if (sheet.quickPlays.length > 0) {
    html.push(
      '<section class="quickplays">',
      `<h2>${escapeHtml(text.quickPlays)}</h2>`,
      '<table>',
      colgroup(QUICK_PLAY_COLUMNS),
      headerRow([
        ['number', text.columnSlot],
        ['title', text.columnTitle],
        ['duration', text.columnDuration],
        ['level', text.columnLevel],
        ['end', text.columnEnd],
      ]),
      '<tbody>',
    );
    for (const quickPlay of sheet.quickPlays) {
      html.push(
        '<tr class="cue">' +
        cell('number', quickPlay.slot === null ? EMPTY_CELL : String(quickPlay.slot)) +
        cell('title', quickPlay.displayName || EMPTY_CELL) +
        cell('duration', formatDuration(quickPlay.duration) || EMPTY_CELL) +
        cell('level', formatLevelDb(volumeToDb(quickPlay.volume)) || EMPTY_CELL) +
        cell('end', endText(quickPlay.endBehavior, text, sheet, known)) +
        '</tr>',
      );
    }
    html.push('</tbody>', '</table>', '</section>');
  }

  if (sheet.truncated) {
    const shown = rows.length + sheet.quickPlays.length;
    html.push(`<p class="notice">${escapeHtml(text.truncated.replace('{count}', String(shown)))}</p>`);
  }
  html.push('</body>', '</html>');
  return html.join('\n');
}

// Chromium fills .pageNumber and .totalPages itself; the template has no script.
function buildCueSheetFooter(showName, labels, options = {}) {
  const text = normalizeCueSheetLabels(labels);
  const name = cleanText(showName, CUE_SHEET_LIMITS.maxShowNameLength) || text.untitledShow;
  const page = escapeHtml(text.page)
    .replace('{page}', '<span class="pageNumber"></span>')
    .replace('{pages}', '<span class="totalPages"></span>');
  const direction = options.direction === 'rtl' ? 'rtl' : 'ltr';
  return `<div dir="${direction}" style="width:100%;box-sizing:border-box;` +
    `padding:0 ${PAGE_MARGIN_INCHES.right}in 0 ${PAGE_MARGIN_INCHES.left}in;display:flex;` +
    `justify-content:space-between;gap:12pt;font-family:${SHEET_FONT};font-size:8pt;color:#444;">` +
    `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(name)}</span>` +
    `<span style="white-space:nowrap;">${page}</span></div>`;
}

// webContents.printToPDF options: A4 portrait with the show name and
// "Page X of Y" in the bottom margin.
function cueSheetPdfOptions(showName, labels, options = {}) {
  return {
    pageSize: 'A4',
    landscape: false,
    printBackground: true,
    preferCSSPageSize: false,
    margins: { ...PAGE_MARGIN_INCHES },
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: buildCueSheetFooter(showName, labels, options),
  };
}

// The hidden window that prints the sheet: sandboxed, isolated in its own
// in-memory session, and with JavaScript off (printing does not need it).
function cueSheetWindowOptions() {
  return {
    show: false,
    width: 794,
    height: 1123,
    skipTaskbar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      webSecurity: true,
      devTools: false,
      spellcheck: false,
      partition: 'cue-sheet-export',
    },
  };
}

// "<show name> cue sheet.pdf", safe as a file name on Windows, macOS and Linux.
function cueSheetFileName(showName) {
  const base = cleanText(showName, 80)
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return `${base || 'Show'} cue sheet.pdf`;
}

module.exports = {
  CUE_SHEET_LIMITS,
  DEFAULT_CUE_SHEET_LABELS,
  buildCueSheetFooter,
  buildCueSheetHtml,
  cueSheetFileName,
  cueSheetPdfOptions,
  cueSheetWindowOptions,
  escapeHtml,
  formatDuration,
  formatLevelDb,
  normalizeCueSheet,
  normalizeCueSheetLabels,
  volumeToDb,
};
