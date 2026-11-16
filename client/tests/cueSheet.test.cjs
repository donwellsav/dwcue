'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const {
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
} = require('../electron/cue-sheet');

const GENERATED_AT = new Date(2026, 10, 16, 19, 30);
const build = (data, labels, options = {}) =>
  buildCueSheetHtml(data, labels, { generatedAt: GENERATED_AT, locale: 'en', ...options });

const audio = (displayName, extra = {}) => ({
  type: 'audio', displayName, duration: 60, volume: 1, endBehavior: { action: 'next' }, ...extra,
});
const group = (displayName, children, extra = {}) => ({
  type: 'group', displayName, children, endBehavior: { action: 'nothing' }, ...extra,
});

// Cells of every body row, in document order, with the markup stripped.
function bodyRows(html) {
  return Array.from(html.matchAll(/<tr class="([^"]*)">(.*?)<\/tr>/g), ([, classes, cells]) => ({
    classes: classes.split(' '),
    cells: Array.from(cells.matchAll(/<td class="[^"]*">(.*?)<\/td>/g), ([, text]) => text),
  }));
}

test('hostile titles, notes, show names and labels are escaped, and the page has no script', () => {
  const html = build({
    showName: 'Tom & Jerry\'s <b>Show</b>',
    items: [
      audio('<script>alert("x")</script>', { note: '"quoted" & \'single\' <img src=x onerror=alert(1)>' }),
      group('</td></tr></table><script src="https://evil.example/x.js"></script>', []),
    ],
    quickPlays: [{ slot: 1, displayName: '<svg onload=alert(1)>', duration: 3, volume: 1 }],
  }, { columnTitle: '<i>Title</i>', page: '<u>{page}</u> / {pages}' });

  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<(img|svg|b|i|u)\b/i);
  // No real tag carries an event handler or a link to anything.
  assert.doesNotMatch(html, /<[^>]*\s(on\w+|src|href)\s*=/i);
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
  assert.ok(html.includes('&quot;quoted&quot; &amp; &#39;single&#39; &lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('<h1>Tom &amp; Jerry&#39;s &lt;b&gt;Show&lt;/b&gt;</h1>'));
  assert.ok(html.includes('&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;&lt;script src=&quot;https://evil.example/x.js&quot;&gt;'));
  assert.ok(html.includes('&lt;svg onload=alert(1)&gt;'));
  assert.ok(html.includes('&lt;i&gt;Title&lt;/i&gt;'));
  // Nothing remote can load, and the structure survives the hostile text.
  assert.ok(html.includes('content="default-src \'none\'; style-src \'unsafe-inline\'"'));
  assert.equal(html.match(/<table>/g).length, 2);
  assert.equal(bodyRows(html).length, 3);

  const footer = buildCueSheetFooter('Tom & Jerry\'s <b>Show</b>', { page: '<u>{page}</u> / {pages}' });
  assert.doesNotMatch(footer, /<(script|b|u)\b/i);
  assert.ok(footer.includes('Tom &amp; Jerry&#39;s &lt;b&gt;Show&lt;/b&gt;'));
  assert.ok(footer.includes('&lt;u&gt;<span class="pageNumber"></span>&lt;/u&gt; / <span class="totalPages"></span>'));

  assert.equal(escapeHtml('<a href="x">\'&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
});

test('cue numbers follow the playlist position through nested groups', () => {
  const items = [
    audio('Walk-in'),
    group('Act one', [
      audio('Overture'),
      group('Scene two', [audio('Thunder')]),
      audio('Bows'),
    ]),
    audio('Walk-out'),
  ];
  const rows = bodyRows(build({ items }));
  assert.deepEqual(rows.map(row => row.cells[0]), ['1', '2', '2,1', '2,2', '2,2,1', '2,3', '3']);
  assert.deepEqual(rows.map(row => row.cells[1]),
    ['Walk-in', 'Act one', 'Overture', 'Scene two', 'Thunder', 'Bows', 'Walk-out']);
  // Groups are their own rows; children are indented by depth beneath them.
  assert.deepEqual(rows.map(row => row.classes), [
    ['cue'], ['group'], ['cue', 'depth-1'], ['group', 'depth-1'], ['cue', 'depth-2'], ['cue', 'depth-1'], ['cue'],
  ]);

  // Settings > First cue number moves every level, like the playlist.
  const shifted = bodyRows(build({ items, indexStart: 10 }));
  assert.deepEqual(shifted.map(row => row.cells[0]), ['10', '11', '11,10', '11,11', '11,11,10', '11,12', '12']);
  for (const indexStart of [0, -3, 1.5, '4', null, Infinity]) {
    assert.equal(bodyRows(build({ items, indexStart }))[0].cells[0], '1');
  }
});

test('durations print as m:ss, and h:mm:ss from one hour', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(7.9), '0:07');
  assert.equal(formatDuration(61), '1:01');
  assert.equal(formatDuration(3599.99), '59:59');
  assert.equal(formatDuration(3600), '1:00:00');
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(36000 + 59), '10:00:59');
  for (const invalid of [NaN, -1, Infinity, undefined, null, '90', {}]) {
    assert.equal(formatDuration(invalid), '');
  }

  const html = build({ items: [audio('Short', { duration: 75 }), audio('Long', { duration: 5400.5 })] });
  const rows = bodyRows(html);
  assert.equal(rows[0].cells[3], '1:15');
  assert.equal(rows[1].cells[3], '1:30:00');
});

test('levels print in dB with one decimal, and silence as -∞', () => {
  assert.equal(formatLevelDb(volumeToDb(1)), '0.0');
  assert.equal(formatLevelDb(volumeToDb(0.5)), '-6.0');
  assert.equal(formatLevelDb(volumeToDb(2)), '+6.0');
  assert.equal(formatLevelDb(volumeToDb(0)), '-∞');
  assert.equal(formatLevelDb(-0.04), '0.0');
  assert.equal(formatLevelDb(0.04), '0.0');
  assert.equal(formatLevelDb(-12.34), '-12.3');
  for (const invalid of [NaN, -0.1, Infinity, undefined, null, '1']) {
    assert.equal(formatLevelDb(volumeToDb(invalid)), '');
  }

  const rows = bodyRows(build({
    items: [
      audio('Unity', { volume: 1 }),
      audio('Muted', { volume: 0 }),
      audio('Quiet', { volume: 0.1 }),
      group('Bed', [], { groupGainDb: -4.5 }),
      group('Default gain', []),
    ],
    quickPlays: [{ slot: 3, displayName: 'Sting', duration: 2, volume: 0 }],
  }));
  assert.deepEqual(rows.map(row => row.cells.at(-2)), ['0.0', '-∞', '-20.0', '-4.5', '0.0', '-∞']);
});

test('the sheet stops at the row limit and says so', () => {
  const many = Array.from({ length: CUE_SHEET_LIMITS.maxRows + 1000 }, (_, i) => audio(`Cue ${i + 1}`));
  const sheet = normalizeCueSheet({ items: many, quickPlays: [{ slot: 1, displayName: 'Sting' }] });
  assert.equal(sheet.items.length, CUE_SHEET_LIMITS.maxRows);
  assert.equal(sheet.quickPlays.length, 0);
  assert.equal(sheet.truncated, true);
  const html = build({ items: many });
  assert.equal(bodyRows(html).length, CUE_SHEET_LIMITS.maxRows);
  assert.ok(html.includes(`shortened to the first ${CUE_SHEET_LIMITS.maxRows} rows`));
  assert.ok(html.includes(`<dd>${CUE_SHEET_LIMITS.maxRows}</dd>`));

  // The limit counts groups and their children together.
  const nested = Array.from({ length: 1500 }, (_, i) =>
    group(`Group ${i + 1}`, [audio('a'), audio('b'), audio('c')]));
  const nestedSheet = normalizeCueSheet({ items: nested });
  const count = items => items.reduce((sum, item) => sum + 1 + count(item.children || []), 0);
  assert.equal(count(nestedSheet.items), CUE_SHEET_LIMITS.maxRows);
  assert.equal(nestedSheet.truncated, true);

  const quickPlays = Array.from({ length: CUE_SHEET_LIMITS.maxQuickPlays + 5 }, (_, i) =>
    ({ slot: i + 1, displayName: `QuickPlay ${i + 1}` }));
  const capped = normalizeCueSheet({ items: [audio('One')], quickPlays });
  assert.equal(capped.quickPlays.length, CUE_SHEET_LIMITS.maxQuickPlays);
  assert.equal(capped.truncated, true);

  // Nesting is bounded too, so a hostile payload cannot exhaust the stack.
  let deep = audio('bottom');
  for (let i = 0; i < 200; i++) deep = group(`level ${i}`, [deep]);
  const deepSheet = normalizeCueSheet({ items: [deep] });
  assert.equal(count(deepSheet.items), CUE_SHEET_LIMITS.maxDepth);
  assert.equal(deepSheet.truncated, true);

  const small = normalizeCueSheet({ items: [audio('One')] });
  assert.equal(small.truncated, false);
  assert.doesNotMatch(build({ items: [audio('One')] }), /shortened/);
});

test('long text is cut to its limit and control characters are removed', () => {
  const sheet = normalizeCueSheet({
    showName: 'S'.repeat(5000),
    items: [audio(`A\u0000B\r\nC\tD\u2028E   F${'x'.repeat(5000)}`, { note: '😀'.repeat(2000) })],
  });
  assert.equal(Array.from(sheet.showName).length, CUE_SHEET_LIMITS.maxShowNameLength);
  assert.ok(sheet.showName.endsWith('…'));
  const [item] = sheet.items;
  assert.ok(item.displayName.startsWith('A B C D E Fxxx'));
  assert.equal(Array.from(item.displayName).length, CUE_SHEET_LIMITS.maxTitleLength);
  assert.equal(Array.from(item.note).length, CUE_SHEET_LIMITS.maxNoteLength);
  // No half of a surrogate pair is left behind by the cut.
  assert.equal(item.note, `${'😀'.repeat(CUE_SHEET_LIMITS.maxNoteLength - 1)}…`);
});

test('missing and invalid fields are tolerated and keep their place', () => {
  const items = [
    null,
    42,
    'text',
    {},
    { type: 'group' },
    { type: 'audio', displayName: 7, note: {}, duration: 'abc', volume: -1, endBehavior: 'loop' },
    { type: 'group', displayName: 'Bad group', children: 'nope', groupGainDb: NaN, endBehavior: { action: 'explode' } },
    { type: 'video', displayName: 'Other type', duration: -5, volume: Infinity, endBehavior: { action: 'constructor' } },
    audio('Good'),
  ];
  const html = build({ showName: 99, indexStart: 'x', items, quickPlays: [null, 'x', { slot: 'two' }, []], labels: 'nope' });
  const rows = bodyRows(html);
  assert.deepEqual(rows.slice(0, 9).map(row => row.cells[0]), ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  assert.deepEqual(rows[0].cells, ['1', '—', '', '—', '—', '']);
  assert.deepEqual(rows[4].cells, ['5', '—', '', '', '0.0', '']);
  assert.deepEqual(rows[5].cells, ['6', '—', '', '—', '—', '']);
  assert.deepEqual(rows[6].cells, ['7', 'Bad group', '', '', '0.0', '']);
  assert.deepEqual(rows[7].cells, ['8', 'Other type', '', '—', '—', '']);
  assert.deepEqual(rows[8].cells, ['9', 'Good', '', '1:00', '0.0', 'Next']);
  // The one usable QuickPlay entry prints with dashes for what it lacks.
  assert.deepEqual(rows[9].cells, ['—', '—', '—', '—', '']);
  assert.ok(html.includes('<h1>Untitled show</h1>'));

  for (const payload of [undefined, null, [], 'show', 12, { items: 'x', quickPlays: {} }]) {
    const empty = build(payload);
    assert.ok(empty.includes('No cues in the playlist.'));
    assert.ok(empty.includes('<h1>Untitled show</h1>'));
    assert.doesNotMatch(empty, /<table>/);
  }

  // Normalising is stable: main validates once, the builder validates again.
  const once = normalizeCueSheet({ showName: 'Show', indexStart: 3, items, quickPlays: [{ slot: 2, displayName: 'Q' }] });
  assert.deepEqual(normalizeCueSheet(once), once);
  assert.equal(build(once), build({ showName: 'Show', indexStart: 3, items, quickPlays: [{ slot: 2, displayName: 'Q' }] }));
});

test('the ending column uses short words and names a Go to target that exists', () => {
  const rows = bodyRows(build({
    items: [
      audio('Stops', { endBehavior: { action: 'nothing' } }),
      audio('Continues', { endBehavior: { action: 'next' } }),
      audio('Loops', { endBehavior: { action: 'loop' } }),
      group('Scene', [
        audio('Jumps by index', { endBehavior: { action: 'goto-index', targetIndex: [0] } }),
        audio('Jumps to a child', { endBehavior: { action: 'goto-item', targetIndex: [3, 0] } }),
      ], { endBehavior: { action: 'goto-index', targetIndex: [9, 9] } }),
      audio('No target', { endBehavior: { action: 'goto-item' } }),
      audio('Bad target', { endBehavior: { action: 'goto-index', targetIndex: [-1, 'x'] } }),
    ],
    quickPlays: [{ slot: 1, displayName: 'Sting', endBehavior: { action: 'goto-index', targetIndex: [2] } }],
  }));
  assert.deepEqual(rows.map(row => row.cells.at(-1)),
    ['Stop', 'Next', 'Loop', 'Go to', 'Go to 1', 'Go to 4,1', 'Go to', 'Go to', 'Go to 3']);
});

test('the header carries the show name, the date, the cue count and the running time', () => {
  const html = build({
    showName: 'Spring Gala',
    items: [
      audio('One', { duration: 90 }),
      group('Two', [audio('Two A', { duration: 3600 }), audio('Two B', { duration: null })]),
    ],
    quickPlays: [{ slot: 1, displayName: 'Sting', duration: 500, volume: 1 }],
  });
  assert.ok(html.includes('<title>Spring Gala – Cue sheet</title>'));
  assert.ok(html.includes('<p class="sheet-kind">Cue sheet</p>'));
  assert.ok(html.includes('<h1>Spring Gala</h1>'));
  // Groups are rows but not cues; QuickPlays are listed apart from the running order.
  assert.ok(html.includes('<dt>Cues</dt><dd>3</dd>'));
  assert.ok(html.includes('<dt>Total running time</dt><dd>1:01:30</dd>'));
  const generated = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(GENERATED_AT);
  assert.ok(html.includes(`<dt>Generated</dt><dd>${generated}</dd>`));
  assert.ok(generated.includes('2026'));
  // An unknown locale tag falls back instead of throwing.
  assert.match(build({ items: [] }, undefined, { locale: 'not a locale!' }), /<html lang="en" dir="ltr">/);
  assert.match(build({ items: [] }, undefined, { locale: 'ar', direction: 'rtl' }), /<html lang="ar" dir="rtl">/);
  // The table header repeats on every printed page.
  assert.match(html, /thead \{ display: table-header-group; \}/);
  assert.equal(html.match(/<thead>/g).length, 2);
});

test('the QuickPlays section is left out when there are none', () => {
  const without = build({ items: [audio('One')], quickPlays: [] });
  assert.doesNotMatch(without, /class="quickplays"/);
  assert.doesNotMatch(without, /<h2>QuickPlays<\/h2>/);
  assert.equal(without.match(/<table>/g).length, 1);
  assert.doesNotMatch(build({ items: [audio('One')] }), /class="quickplays"/);

  const withSome = build({
    items: [audio('One')],
    quickPlays: [
      { slot: 1, displayName: 'Applause', duration: 12, volume: 0.5, endBehavior: { action: 'nothing' } },
      { slot: 4, displayName: 'Air horn', duration: 3.2, volume: 1, endBehavior: { action: 'loop' } },
    ],
  });
  assert.match(withSome, /<section class="quickplays">\n<h2>QuickPlays<\/h2>/);
  assert.deepEqual(bodyRows(withSome).slice(1).map(row => row.cells), [
    ['1', 'Applause', '0:12', '-6.0', 'Stop'],
    ['4', 'Air horn', '0:03', '0.0', 'Loop'],
  ]);
  const headings = Array.from(withSome.matchAll(/<th class="[^"]*" scope="col">(.*?)<\/th>/g), ([, text]) => text);
  assert.deepEqual(headings, [
    '#', 'Title', 'Note', 'Duration', 'Level (dB)', 'At end',
    'Slot', 'Title', 'Duration', 'Level (dB)', 'At end',
  ]);
});

test('labels fall back to English when missing or invalid', () => {
  assert.deepEqual(normalizeCueSheetLabels(undefined), { ...DEFAULT_CUE_SHEET_LABELS });
  assert.deepEqual(normalizeCueSheetLabels(null), { ...DEFAULT_CUE_SHEET_LABELS });
  assert.deepEqual(normalizeCueSheetLabels(['Title']), { ...DEFAULT_CUE_SHEET_LABELS });

  const labels = normalizeCueSheetLabels({
    title: 'Feuille de conduite',
    columnTitle: '  Titre\n ',
    columnNote: 42,
    columnDuration: '',
    columnLevel: 'x'.repeat(CUE_SHEET_LIMITS.maxLabelLength + 1),
    endLoop: '\u0000',
    page: 'Page sans numéro',
    truncated: 'Liste limitée à {count} lignes.',
    constructor: 'ignored',
    extra: 'ignored',
  });
  assert.equal(labels.title, 'Feuille de conduite');
  assert.equal(labels.columnTitle, 'Titre');
  assert.equal(labels.columnNote, DEFAULT_CUE_SHEET_LABELS.columnNote);
  assert.equal(labels.columnDuration, DEFAULT_CUE_SHEET_LABELS.columnDuration);
  assert.equal(labels.columnLevel, DEFAULT_CUE_SHEET_LABELS.columnLevel);
  assert.equal(labels.endLoop, DEFAULT_CUE_SHEET_LABELS.endLoop);
  // A translation that lost its placeholders would lose the page numbers.
  assert.equal(labels.page, DEFAULT_CUE_SHEET_LABELS.page);
  assert.equal(labels.truncated, 'Liste limitée à {count} lignes.');
  assert.deepEqual(Object.keys(labels), Object.keys(DEFAULT_CUE_SHEET_LABELS));

  const english = build({ items: [audio('One', { endBehavior: { action: 'nothing' } })] });
  for (const text of ['Cue sheet', 'Generated', 'Cues', 'Total running time', 'Playlist', 'Title', 'Note',
    'Duration', 'Level (dB)', 'At end', 'Stop']) {
    assert.ok(english.includes(`>${text}<`), `${text} is printed`);
  }
  const translated = build({ items: [audio('One')] }, { title: 'Feuille de conduite', endNext: 'Suivant' });
  assert.ok(translated.includes('<p class="sheet-kind">Feuille de conduite</p>'));
  assert.ok(translated.includes('>Suivant<'));
  assert.ok(translated.includes('>Total running time<'));
});

test('print settings: A4 portrait, a footer with page numbers, and a locked-down window', () => {
  const options = cueSheetPdfOptions('Spring Gala', undefined);
  assert.equal(options.pageSize, 'A4');
  assert.equal(options.landscape, false);
  assert.equal(options.printBackground, true);
  assert.equal(options.displayHeaderFooter, true);
  assert.ok(options.margins.bottom >= 0.5);
  assert.doesNotMatch(options.headerTemplate + options.footerTemplate, /<script/i);
  assert.match(options.footerTemplate,
    />Spring Gala<\/span>.*Page <span class="pageNumber"><\/span> of <span class="totalPages"><\/span>/);
  assert.match(cueSheetPdfOptions('', undefined).footerTemplate, />Untitled show</);
  assert.match(cueSheetPdfOptions('Show', { page: 'Seite {page} von {pages}' }, { direction: 'rtl' }).footerTemplate,
    /^<div dir="rtl".*Seite <span class="pageNumber"><\/span> von <span class="totalPages"><\/span>/);

  const windowOptions = cueSheetWindowOptions();
  assert.equal(windowOptions.show, false);
  assert.deepEqual(
    (({ sandbox, contextIsolation, nodeIntegration, javascript }) =>
      ({ sandbox, contextIsolation, nodeIntegration, javascript }))(windowOptions.webPreferences),
    { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  );
  assert.equal('preload' in windowOptions.webPreferences, false);
  assert.notEqual(cueSheetWindowOptions(), windowOptions);
});

test('the default file name is the show name made safe for every platform', () => {
  assert.equal(cueSheetFileName('Spring Gala'), 'Spring Gala cue sheet.pdf');
  assert.equal(cueSheetFileName('My/Show: "Final"? <v2>|*\\'), 'My Show Final v2 cue sheet.pdf');
  assert.equal(cueSheetFileName('..\\..\\evil'), 'evil cue sheet.pdf');
  assert.equal(cueSheetFileName('  ...  '), 'Show cue sheet.pdf');
  assert.equal(cueSheetFileName('line\nbreak\u0000name.'), 'line break name cue sheet.pdf');
  for (const missing of ['', undefined, null, 12, {}]) {
    assert.equal(cueSheetFileName(missing), 'Show cue sheet.pdf');
  }
  assert.ok(cueSheetFileName('n'.repeat(5000)).length <= 100);
});

test('the module is pure and the IPC handler is trusted, bounded and dialog-driven', () => {
  const moduleSource = readFileSync(require.resolve('../electron/cue-sheet'), 'utf8');
  assert.doesNotMatch(moduleSource, /require\(/);

  const mainSource = readFileSync(require.resolve('../electron/main.js'), 'utf8');
  const start = mainSource.indexOf("ipcMain.handle('export-cue-sheet'");
  assert.ok(start >= 0);
  const handler = mainSource.slice(start, mainSource.indexOf('\n});', start));
  assert.match(handler,
    /^ipcMain\.handle\('export-cue-sheet', async \(event, payload\) => \{\s*requireTrustedIpc\(event\);[\s\S]*requireBoundedIpcObject\(payload, 'cue sheet', CUE_SHEET_LIMITS\.maxPayloadBytes\);[\s\S]*normalizeCueSheet\(payload\)[\s\S]*dialog\.showSaveDialog\([\s\S]*writeFile\(result\.filePath, pdf\)/);
  // Only the normalised sheet and labels are used after validation.
  assert.deepEqual(handler.match(/payload\.\w+/g), ['payload.labels']);
  assert.match(mainSource,
    /new BrowserWindow\(cueSheetWindowOptions\(\)\)[\s\S]*\} finally \{[\s\S]{0,120}printWindow\.destroy\(\)/);
  assert.match(mainSource,
    /label: t\.exportCueSheet,\s*enabled: currentProject !== null,\s*click: \(\) => \{\s*mainWindow\.webContents\.send\('menu-export-cue-sheet'\);/);

  const preloadSource = readFileSync(require.resolve('../electron/preload.js'), 'utf8');
  assert.match(preloadSource, /exportCueSheet: \(sheet\) => ipcRenderer\.invoke\('export-cue-sheet', sheet\)/);
  assert.match(preloadSource, /onMenuExportCueSheet: \(callback\) => replaceIpcListener\('menu-export-cue-sheet', callback\)/);
});
