'use strict';

const CARD_TYPES = Object.freeze([
  'alteka',
  'bars',
  'grid',
  'ramp',
  'placeholder',
  'audioSync',
  'deghost',
  'led',
]);
const BARS_TYPES = Object.freeze(['simple', 'smpte', 'arib', 'hdr', 'sdi', 'single']);
const BARS_LEVELS = Object.freeze(['-9', '0', '75', '100', '109']);
const BARS_COLORS = Object.freeze(['white', 'Red', 'Green', 'Blue', 'Cyan', 'Magenta', 'Yellow']);
const RAMP_DIRECTIONS = Object.freeze(['Horizontal', 'Vertical', 'Diagonal', 'Radial']);
const PLACEHOLDER_ICONS = Object.freeze([
  '',
  'fa-desktop',
  'fa-phone',
  'fa-chart-line',
  'fa-image',
  'fa-file-powerpoint',
  'fa-camera',
  'fa-film',
  'fa-microphone',
  'fa-clock',
  'custom',
]);
const ROTATIONS = Object.freeze([0, 90, 180, 270]);
const DEGHOST_DENSITIES = Object.freeze([33, 75, 125, 166]);
const DEGHOST_SPEEDS = Object.freeze([1, 3, 6, 11]);
const MAX_IMAGE_DATA_URL_LENGTH = 8 * 1024 * 1024;

const AUDIO_SYNC_RATES = Object.freeze([24, 25, 29.97, 30, 50, 59.94, 60, 100, 120]);

const TEST_CARD_PRESETS = Object.freeze([
  Object.freeze({ id: 'alteka', label: 'DonWells Cue', cardType: 'alteka' }),
  Object.freeze({ id: 'bars-simple', label: 'Bars · Simple', cardType: 'bars', barsType: 'simple' }),
  Object.freeze({ id: 'bars-smpte', label: 'Bars · SMPTE', cardType: 'bars', barsType: 'smpte' }),
  Object.freeze({ id: 'bars-arib', label: 'Bars · ARIB', cardType: 'bars', barsType: 'arib' }),
  Object.freeze({ id: 'bars-hdr', label: 'Bars · HDR', cardType: 'bars', barsType: 'hdr' }),
  Object.freeze({ id: 'bars-sdi', label: 'Bars · SDI', cardType: 'bars', barsType: 'sdi' }),
  Object.freeze({ id: 'bars-single', label: 'Bars · Single', cardType: 'bars', barsType: 'single' }),
  Object.freeze({ id: 'grid', label: 'Grid', cardType: 'grid' }),
  Object.freeze({ id: 'ramp', label: 'Ramp', cardType: 'ramp' }),
  Object.freeze({ id: 'placeholder', label: 'Name', cardType: 'placeholder' }),
  Object.freeze({ id: 'audio-sync', label: 'AV Sync', cardType: 'audioSync' }),
  Object.freeze({ id: 'deghost', label: 'DeGhost', cardType: 'deghost' }),
  Object.freeze({ id: 'led', label: 'LED Wall', cardType: 'led' }),
]);

const DEFAULT_COLORS = Object.freeze([
  '#ffffff', '#d3d3d3', '#7f7f7f', '#3e3e3e', '#000000',
  '#ff0000', '#ff7f00', '#ffff00', '#00ff00', '#00ffff',
  '#0000ff', '#ff00ff', '#BF3030', '#BF9B30', '#78BF30',
  '#30BF54', '#30BFBF', '#3054BF', '#7830BF', '#BF309B',
]);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}


function integer(value, fallback, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function enumeration(value, values, fallback) {
  return values.includes(value) ? value : fallback;
}

function text(value, fallback, maximumLength) {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, maximumLength);
}

function opaqueId(value, fallback) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return fallback;
  }
  return value;
}

function color(value, fallback) {
  return typeof value === 'string' && /^#[0-9a-f]{3,8}$/iu.test(value) && [4, 5, 7, 9].includes(value.length)
    ? value
    : fallback;
}

function fontAwesomeClass(value, fallback) {
  return typeof value === 'string'
    && value.length <= 120
    && /^(?:fa[a-z]*|fa-[a-z0-9-]+)(?: (?:fa[a-z]*|fa-[a-z0-9-]+))*$/u.test(value)
    ? value
    : fallback;
}

function safeImage(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > MAX_IMAGE_DATA_URL_LENGTH) return '';

  if (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/]+={0,2}$/iu.test(value)) {
    return value;
  }

  if (!value.startsWith('/assets/testcards/') || !/^\/[a-z0-9_./-]+\.(?:png|jpe?g|webp|gif|svg)$/iu.test(value)) {
    return '';
  }
  const segments = value.split('/');
  return segments.includes('..') || segments.includes('.') ? '' : value;
}

function createTestCardConfig(value) {
  const source = record(value);
  const notFilledCard = record(source.notFilledCard);
  const window = record(source.window);
  const mask = record(source.mask);
  const placeholder = record(source.placeholder);
  const bars = record(source.bars);
  const grid = record(source.grid);
  const led = record(source.led);
  const audioSync = record(source.audioSync);
  const alteka = record(source.alteka);
  const ramp = record(source.ramp);
  const deghost = record(source.deghost);

  const predefineColors = Array.isArray(source.predefineColors)
    ? source.predefineColors.slice(0, 64).filter((entry) => color(entry, '') !== '')
    : [];

  const config = {
    visible: boolean(source.visible, false),
    name: text(source.name, 'DonWells Cue', 120),
    cardType: enumeration(source.cardType, CARD_TYPES, 'alteka'),
    animated: boolean(source.animated, false),
    showInfo: boolean(source.showInfo, true),
    windowed: boolean(source.windowed, false),
    fullsize: boolean(source.fullsize, true),
    screen: integer(source.screen, 0, 0, 256),
    raster: boolean(source.raster, false),
    showClock: boolean(source.showClock, true),
    infoCircleAnimated: boolean(source.infoCircleAnimated, true),
    notFilledCard: {
      width: integer(notFilledCard.width, 1920, 1, 16384),
      height: integer(notFilledCard.height, 1080, 1, 16384),
      top: integer(notFilledCard.top, 0, -32768, 32768),
      left: integer(notFilledCard.left, 0, -32768, 32768),
      bounds: boolean(notFilledCard.bounds, false),
      rotate: enumeration(notFilledCard.rotate, ROTATIONS, 0),
    },
    window: {
      width: integer(window.width, 1280, 48, 16384),
      height: integer(window.height, 720, 39, 16384),
    },
    mask: {
      enabled: boolean(mask.enabled, false),
      applyBounds: boolean(mask.applyBounds, false),
      image: safeImage(mask.image),
    },
    placeholder: {
      bg: color(placeholder.bg, '#6ab42f'),
      fg: color(placeholder.fg, '#fff'),
      gradient: boolean(placeholder.gradient, true),
      icon: enumeration(placeholder.icon, PLACEHOLDER_ICONS, 'fa-desktop'),
      custom: fontAwesomeClass(placeholder.custom, 'fa-brands fa-spotify'),
    },
    bars: {
      type: enumeration(bars.type, BARS_TYPES, 'simple'),
      overlay: boolean(bars.overlay, false),
      level: enumeration(bars.level, BARS_LEVELS, '75'),
      color: enumeration(bars.color, BARS_COLORS, 'white'),
    },
    grid: {
      bg: color(grid.bg, '#000'),
      crosshair: color(grid.crosshair, '#ffffff'),
      lines: color(grid.lines, '#888888'),
      size: integer(grid.size, 50, 1, 4096),
      circles: boolean(grid.circles, false),
      diagonals: boolean(grid.diagonals, false),
      diagColour: color(grid.diagColour, '#6ab42f'),
    },
    led: {
      width: integer(led.width, 128, 16, 720),
      height: integer(led.height, 128, 16, 720),
      rows: integer(led.rows, 4, 1, 128),
      columns: integer(led.columns, 6, 1, 128),
      border: boolean(led.border, true),
      position: boolean(led.position, true),
    },
    audioSync: {
      deviceId: opaqueId(audioSync.deviceId, 'default'),
      rate: enumeration(audioSync.rate, AUDIO_SYNC_RATES, 60),
    },
    alteka: {
      logo: safeImage(alteka.logo),
      showLogo: boolean(alteka.showLogo, false),
      bg: color(alteka.bg, '#666'),
      fg: color(alteka.fg, '#6AB42F'),
      textColour: color(alteka.textColour, '#ffffff'),
      gradient: boolean(alteka.gradient, true),
    },
    ramp: {
      direction: enumeration(ramp.direction, RAMP_DIRECTIONS, 'Horizontal'),
      reverse: boolean(ramp.reverse, false),
      stepped: boolean(ramp.stepped, false),
      double: boolean(ramp.double, false),
      overlay: boolean(ramp.overlay, false),
    },
    deghost: {
      density: enumeration(deghost.density, DEGHOST_DENSITIES, 75),
      speed: enumeration(deghost.speed, DEGHOST_SPEEDS, 3),
    },
    predefineColors: predefineColors.length > 0 ? predefineColors : [...DEFAULT_COLORS],
  };

  if (config.windowed) config.fullsize = true;
  if (!config.mask.image) config.mask.enabled = false;
  if (config.cardType === 'led') {
    const width = config.led.width * config.led.columns;
    const height = config.led.height * config.led.rows;
    config.notFilledCard.width = width;
    config.notFilledCard.height = height;
    if (config.windowed) {
      config.window.width = width;
      config.window.height = height;
    } else {
      config.fullsize = false;
    }
  }

  return config;
}

module.exports = {
  AUDIO_SYNC_RATES,
  TEST_CARD_PRESETS,
  createTestCardConfig,
};
