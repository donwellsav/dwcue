'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AUDIO_SYNC_RATES,
  TEST_CARD_PRESETS,
  createTestCardConfig,
} = require('../electron/test-card-config');

test('creates complete source-faithful DonWells Cue defaults', () => {
  const config = createTestCardConfig();

  assert.deepEqual(config, {
    visible: false,
    name: 'DonWells Cue',
    cardType: 'alteka',
    animated: false,
    showInfo: true,
    windowed: false,
    fullsize: true,
    screen: 0,
    raster: false,
    showClock: true,
    infoCircleAnimated: true,
    notFilledCard: { width: 1920, height: 1080, top: 0, left: 0, bounds: false, rotate: 0 },
    window: { width: 1280, height: 720 },
    mask: { enabled: false, applyBounds: false, image: '' },
    placeholder: {
      bg: '#6ab42f',
      fg: '#fff',
      gradient: true,
      icon: 'fa-desktop',
      custom: 'fa-brands fa-spotify',
    },
    bars: { type: 'simple', overlay: false, level: '75', color: 'white' },
    grid: {
      bg: '#000',
      crosshair: '#ffffff',
      lines: '#888888',
      size: 50,
      circles: false,
      diagonals: false,
      diagColour: '#6ab42f',
    },
    led: { width: 128, height: 128, rows: 4, columns: 6, border: true, position: true },
    audioSync: { deviceId: 'default', rate: 60 },
    alteka: {
      logo: '',
      showLogo: false,
      bg: '#666',
      fg: '#6AB42F',
      textColour: '#ffffff',
      gradient: true,
    },
    ramp: { direction: 'Horizontal', reverse: false, stepped: false, double: false, overlay: false },
    deghost: { density: 75, speed: 3 },
    predefineColors: [
      '#ffffff', '#d3d3d3', '#7f7f7f', '#3e3e3e', '#000000',
      '#ff0000', '#ff7f00', '#ffff00', '#00ff00', '#00ffff',
      '#0000ff', '#ff00ff', '#BF3030', '#BF9B30', '#78BF30',
      '#30BF54', '#30BFBF', '#3054BF', '#7830BF', '#BF309B',
    ],
  });

  const second = createTestCardConfig();
  assert.notStrictEqual(second, config);
  assert.notStrictEqual(second.grid, config.grid);
  assert.notStrictEqual(second.predefineColors, config.predefineColors);
});

test('publishes all thirteen card presets and all nine native AV-sync rates', () => {
  assert.deepEqual(AUDIO_SYNC_RATES, [24, 25, 29.97, 30, 50, 59.94, 60, 100, 120]);
  assert.equal(TEST_CARD_PRESETS.length, 13);
  assert.deepEqual(
    TEST_CARD_PRESETS.map(({ id, cardType, barsType }) => ({ id, cardType, barsType })),
    [
      { id: 'alteka', cardType: 'alteka', barsType: undefined },
      { id: 'bars-simple', cardType: 'bars', barsType: 'simple' },
      { id: 'bars-smpte', cardType: 'bars', barsType: 'smpte' },
      { id: 'bars-arib', cardType: 'bars', barsType: 'arib' },
      { id: 'bars-hdr', cardType: 'bars', barsType: 'hdr' },
      { id: 'bars-sdi', cardType: 'bars', barsType: 'sdi' },
      { id: 'bars-single', cardType: 'bars', barsType: 'single' },
      { id: 'grid', cardType: 'grid', barsType: undefined },
      { id: 'ramp', cardType: 'ramp', barsType: undefined },
      { id: 'placeholder', cardType: 'placeholder', barsType: undefined },
      { id: 'audio-sync', cardType: 'audioSync', barsType: undefined },
      { id: 'deghost', cardType: 'deghost', barsType: undefined },
      { id: 'led', cardType: 'led', barsType: undefined },
    ],
  );
  assert.ok(Object.isFrozen(AUDIO_SYNC_RATES));
  assert.ok(Object.isFrozen(TEST_CARD_PRESETS));
  assert.ok(TEST_CARD_PRESETS.every(Object.isFrozen));
});

test('preserves valid visual settings and drops unrelated upstream controls', () => {
  const config = createTestCardConfig({
    visible: true,
    name: 'Camera 4',
    cardType: 'bars',
    animated: true,
    showInfo: false,
    windowed: true,
    fullsize: false,
    screen: 9,
    raster: true,
    showClock: false,
    infoCircleAnimated: false,
    notFilledCard: { width: 3840, height: 2160, top: -25, left: 40, bounds: true, rotate: 270 },
    window: { width: 640, height: 480 },
    mask: { enabled: true, applyBounds: true, image: '/assets/testcards/masks/16-9.png' },
    placeholder: { bg: '#12345678', fg: '#abc', gradient: false, icon: 'custom', custom: 'fa-solid fa-bolt' },
    bars: { type: 'single', overlay: true, level: '-9', color: 'Magenta' },
    grid: { bg: '#111', crosshair: '#222', lines: '#333', size: 125, circles: true, diagonals: true, diagColour: '#444' },
    led: { width: 720, height: 16, rows: 128, columns: 1, border: false, position: false },
    audioSync: { deviceId: 'Main PA', rate: 59.94 },
    alteka: { logo: '/assets/testcards/brand/logo.svg', showLogo: true, bg: '#555', fg: '#666', textColour: '#777', gradient: false },
    ramp: { direction: 'Radial', reverse: true, stepped: true, double: true, overlay: true },
    deghost: { density: 166, speed: 11 },
    predefineColors: ['#123456', 'not-a-color', '#abc'],
    audio: { enabled: true },
    export: { target: 'wallpaper' },
    osc: { enabled: true },
  });

  assert.equal(config.name, 'Camera 4');
  assert.deepEqual(config.notFilledCard, { width: 3840, height: 2160, top: -25, left: 40, bounds: true, rotate: 270 });
  assert.equal(config.mask.image, '/assets/testcards/masks/16-9.png');
  assert.deepEqual(config.audioSync, { deviceId: 'Main PA', rate: 59.94 });
  assert.deepEqual(config.predefineColors, ['#123456', '#abc']);
  assert.equal(config.bars.color, 'Magenta');
  assert.equal(config.ramp.overlay, true);
  assert.equal('audio' in config, false);
  assert.equal('export' in config, false);
  assert.equal('osc' in config, false);
});

test('normalizes invalid enums, non-finite values, and out-of-range values per field', () => {
  const config = createTestCardConfig({
    cardType: 'script',
    screen: 1.5,
    notFilledCard: { width: 0, height: Infinity, top: -32769, left: NaN, rotate: 45 },
    window: { width: 47, height: 16385 },
    placeholder: { bg: 'red', fg: '#12', icon: 'onclick=run()', custom: 'x" onerror="run()' },
    bars: { type: 'ebu', level: 75, color: 'chartreuse' },
    grid: { size: 0 },
    led: { width: 721, height: 15, rows: 0, columns: 129 },
    audioSync: { deviceId: 'bad\u0000id', rate: 23.98 },
    ramp: { direction: 'Around' },
    deghost: { density: 76, speed: Infinity },
  });

  assert.equal(config.cardType, 'alteka');
  assert.equal(config.screen, 0);
  assert.deepEqual(config.notFilledCard, { width: 1920, height: 1080, top: 0, left: 0, bounds: false, rotate: 0 });
  assert.deepEqual(config.window, { width: 1280, height: 720 });
  assert.deepEqual(config.placeholder, {
    bg: '#6ab42f',
    fg: '#fff',
    gradient: true,
    icon: 'fa-desktop',
    custom: 'fa-brands fa-spotify',
  });
  assert.deepEqual(config.bars, { type: 'simple', overlay: false, level: '75', color: 'white' });
  assert.equal(config.grid.size, 50);
  assert.deepEqual(config.led, { width: 128, height: 128, rows: 4, columns: 6, border: true, position: true });
  assert.deepEqual(config.audioSync, { deviceId: 'default', rate: 60 });
  assert.equal(config.ramp.direction, 'Horizontal');
  assert.deepEqual(config.deghost, { density: 75, speed: 3 });
});

test('normalizes window, LED, and empty-mask invariants enforced by the original controls', () => {
  assert.equal(createTestCardConfig({ windowed: true, fullsize: false }).fullsize, true);

  const led = createTestCardConfig({
    cardType: 'led',
    fullsize: true,
    led: { width: 100, height: 50, columns: 3, rows: 2 },
    notFilledCard: { width: 1, height: 1 },
  });
  assert.equal(led.fullsize, false);
  assert.equal(led.notFilledCard.width, 300);
  assert.equal(led.notFilledCard.height, 100);

  const windowedLed = createTestCardConfig({
    cardType: 'led',
    windowed: true,
    led: { width: 100, height: 50, columns: 3, rows: 2 },
  });
  assert.deepEqual(windowedLed.window, { width: 300, height: 100 });
  assert.equal(windowedLed.fullsize, true);
  assert.equal(createTestCardConfig({ mask: { enabled: true, image: '' } }).mask.enabled, false);
});

test('allows bounded raster data URLs and trusted bundled assets only', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(createTestCardConfig({ alteka: { logo: png } }).alteka.logo, png);
  assert.equal(
    createTestCardConfig({ mask: { image: '/assets/testcards/mask-safe.svg' } }).mask.image,
    '/assets/testcards/mask-safe.svg',
  );

  const rejected = [
    'javascript:alert(1)',
    'https://example.com/logo.png',
    'file:///tmp/logo.png',
    '/assets/testcards/../private.png',
    'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIi8+',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    `data:image/png;base64,${'a'.repeat(8 * 1024 * 1024)}`,
  ];
  for (const image of rejected) {
    assert.equal(createTestCardConfig({ mask: { image } }).mask.image, '', image);
  }
});
