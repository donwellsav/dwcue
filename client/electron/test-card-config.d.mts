export type TestCardType =
  | 'alteka'
  | 'bars'
  | 'grid'
  | 'ramp'
  | 'placeholder'
  | 'audioSync'
  | 'deghost'
  | 'led';

export type TestCardBarsType = 'simple' | 'smpte' | 'arib' | 'hdr' | 'sdi' | 'single';
export type TestCardBarsLevel = '-9' | '0' | '75' | '100' | '109';
export type TestCardBarsColor = 'white' | 'Red' | 'Green' | 'Blue' | 'Cyan' | 'Magenta' | 'Yellow';
export type TestCardRampDirection = 'Horizontal' | 'Vertical' | 'Diagonal' | 'Radial';
export type TestCardRotation = 0 | 90 | 180 | 270;
export type TestCardAudioSyncRate = 24 | 25 | 29.97 | 30 | 50 | 59.94 | 60 | 100 | 120;

export interface TestCardConfig {
  visible: boolean;
  name: string;
  cardType: TestCardType;
  animated: boolean;
  showInfo: boolean;
  windowed: boolean;
  fullsize: boolean;
  screen: number;
  raster: boolean;
  showClock: boolean;
  infoCircleAnimated: boolean;
  notFilledCard: {
    width: number;
    height: number;
    top: number;
    left: number;
    bounds: boolean;
    rotate: TestCardRotation;
  };
  window: {
    width: number;
    height: number;
  };
  mask: {
    enabled: boolean;
    applyBounds: boolean;
    image: string;
  };
  placeholder: {
    bg: string;
    fg: string;
    gradient: boolean;
    icon: string;
    custom: string;
  };
  bars: {
    type: TestCardBarsType;
    overlay: boolean;
    level: TestCardBarsLevel;
    color: TestCardBarsColor;
  };
  grid: {
    bg: string;
    crosshair: string;
    lines: string;
    size: number;
    circles: boolean;
    diagonals: boolean;
    diagColour: string;
  };
  led: {
    width: number;
    height: number;
    rows: number;
    columns: number;
    border: boolean;
    position: boolean;
  };
  audioSync: {
    deviceId: string;
    rate: TestCardAudioSyncRate;
  };
  alteka: {
    logo: string;
    showLogo: boolean;
    bg: string;
    fg: string;
    textColour: string;
    gradient: boolean;
  };
  ramp: {
    direction: TestCardRampDirection;
    reverse: boolean;
    stepped: boolean;
    double: boolean;
    overlay: boolean;
  };
  deghost: {
    density: 33 | 75 | 125 | 166;
    speed: 1 | 3 | 6 | 11;
  };
  predefineColors: string[];
}

export interface TestCardPreset {
  readonly id: string;
  readonly label: string;
  readonly cardType: TestCardType;
  readonly barsType?: TestCardBarsType;
}

export const AUDIO_SYNC_RATES: readonly TestCardAudioSyncRate[];
export const TEST_CARD_PRESETS: readonly TestCardPreset[];
export function createTestCardConfig(value?: unknown): TestCardConfig;
