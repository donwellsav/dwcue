<template>
  <div class="test-card-controls">
    <fieldset class="test-card-fieldset" :disabled="disabled">
      <legend>{{ t('testCard.cardType') }}</legend>
      <label class="test-card-control test-card-control--wide">
        <span>{{ t('testCard.preset') }}</span>
        <select class="test-card-select" :value="selectedPresetId" @change="onPresetChange">
          <option v-for="preset in TEST_CARD_PRESETS" :key="preset.id" :value="preset.id">
            {{ t(`testCard.presets.${preset.id}`) }}
          </option>
        </select>
      </label>

      <div class="test-card-grid test-card-grid--three">
        <label class="test-card-control">
          <span>{{ t('testCard.name') }}</span>
          <input :value="config.name" type="text" maxlength="120" @input="updateName">
        </label>
        <CheckControl :label="t('testCard.showInfo')" :checked="config.showInfo" @change="update({ showInfo: $event })" />
        <CheckControl
          :label="t('testCard.motion')"
          :checked="config.animated"
          :disabled="motionDisabled"
          @change="update({ animated: $event })"
        />
        <CheckControl :label="t('testCard.showClock')" :checked="config.showClock" @change="update({ showClock: $event })" />
        <CheckControl
          :label="t('testCard.animateInfoCircle')"
          :checked="config.infoCircleAnimated"
          :disabled="!infoCircleAvailable"
          @change="update({ infoCircleAnimated: $event })"
        />
        <CheckControl
          :label="t('testCard.rasterBox')"
          :checked="config.raster"
          :disabled="config.windowed"
          @change="update({ raster: $event })"
        />
      </div>
    </fieldset>

    <fieldset v-if="config.cardType === 'alteka'" class="test-card-fieldset" :disabled="disabled">
      <legend>{{ t('testCard.brandCard') }}</legend>
      <div class="test-card-grid test-card-grid--four">
        <ColorControl :label="t('testCard.background')" :value="config.alteka.bg" @change="updateAlteka({ bg: $event })" />
        <ColorControl :label="t('testCard.foreground')" :value="config.alteka.fg" @change="updateAlteka({ fg: $event })" />
        <ColorControl :label="t('testCard.centerText')" :value="config.alteka.textColour" @change="updateAlteka({ textColour: $event })" />
        <CheckControl :label="t('testCard.gradient')" :checked="config.alteka.gradient" @change="updateAlteka({ gradient: $event })" />
      </div>
      <div class="test-card-image-row">
        <CheckControl :label="t('testCard.customLogo')" :checked="config.alteka.showLogo" @change="updateAlteka({ showLogo: $event })" />
        <button type="button" class="test-card-button" @click="logoInput?.click()">{{ t('testCard.selectImage') }}</button>
        <button v-if="config.alteka.logo" type="button" class="test-card-button" @click="updateAlteka({ logo: '' })">
          {{ t('testCard.clearImage') }}
        </button>
        <img v-if="config.alteka.logo" class="test-card-logo-preview" :src="config.alteka.logo" alt="">
        <input
          ref="logoInput"
          class="test-card-file-input"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          @change="onImagePicked($event, 'logo')"
        >
      </div>
      <p class="test-card-help">{{ t('testCard.logoHelp') }}</p>
    </fieldset>

    <fieldset v-if="config.cardType === 'bars'" class="test-card-fieldset" :disabled="disabled">
      <legend>{{ t('testCard.bars') }}</legend>
      <div class="test-card-grid test-card-grid--three">
        <label class="test-card-control">
          <span>{{ t('testCard.barsStyle') }}</span>
          <select class="test-card-select" :value="config.bars.type" @change="updateBars({ type: eventString($event) as TestCardBarsType })">
            <option value="simple">{{ t('testCard.simple') }}</option>
            <option value="smpte">SMPTE</option>
            <option value="arib">ARIB</option>
            <option value="hdr">HDR</option>
            <option value="sdi">SDI</option>
            <option value="single">{{ t('testCard.single') }}</option>
          </select>
        </label>
        <CheckControl :label="t('testCard.details')" :checked="config.bars.overlay" @change="updateBars({ overlay: $event })" />
        <label v-if="config.bars.type === 'single'" class="test-card-control">
          <span>{{ t('testCard.color') }}</span>
          <select class="test-card-select" :value="config.bars.color" @change="updateBars({ color: eventString($event) as TestCardBarsColor })">
            <option v-for="color in BAR_COLORS" :key="color" :value="color">{{ t(`testCard.barColors.${color.toLowerCase()}`) }}</option>
          </select>
        </label>
      </div>
      <div v-if="config.bars.type === 'simple' || config.bars.type === 'single'" class="test-card-choice-row">
        <span>{{ t('testCard.level') }}</span>
        <label v-for="level in visibleBarLevels" :key="level">
          <input
            type="radio"
            name="test-card-bars-level"
            :value="level"
            :checked="config.bars.level === level"
            @change="updateBars({ level })"
          >
          {{ level }}
        </label>
      </div>
    </fieldset>

    <fieldset v-if="config.cardType === 'grid'" class="test-card-fieldset" :disabled="disabled">
      <legend>{{ t('testCard.grid') }}</legend>
      <div class="test-card-grid test-card-grid--four">
        <ColorControl :label="t('testCard.background')" :value="config.grid.bg" @change="updateGrid({ bg: $event })" />
        <ColorControl :label="t('testCard.crosshair')" :value="config.grid.crosshair" @change="updateGrid({ crosshair: $event })" />
        <ColorControl :label="t('testCard.lines')" :value="config.grid.lines" @change="updateGrid({ lines: $event })" />
        <ColorControl :label="t('testCard.diagonalsColor')" :value="config.grid.diagColour" @change="updateGrid({ diagColour: $event })" />
        <CheckControl :label="t('testCard.showDiagonals')" :checked="config.grid.diagonals" @change="updateGrid({ diagonals: $event })" />
        <CheckControl :label="t('testCard.showCircles')" :checked="config.grid.circles" @change="updateGrid({ circles: $event })" />
        <NumberControl
          :label="t('testCard.gridSpacing')"
          :value="config.grid.size"
          :min="1"
          :max="4096"
          :step="5"
          suffix="px"
          @change="updateGrid({ size: $event })"
        />
      </div>
    </fieldset>

    <fieldset v-if="config.cardType === 'ramp'" class="test-card-fieldset" :disabled="disabled">
      <legend>{{ t('testCard.ramp') }}</legend>
      <div class="test-card-grid test-card-grid--four">
        <CheckControl :label="t('testCard.stepped')" :checked="config.ramp.stepped" @change="updateRamp({ stepped: $event })" />
        <CheckControl :label="t('testCard.double')" :checked="config.ramp.double" @change="updateRamp({ double: $event })" />
        <CheckControl :label="t('testCard.reverse')" :checked="config.ramp.reverse" @change="updateRamp({ reverse: $event })" />
        <CheckControl
          :label="t('testCard.overlay')"
          :checked="config.ramp.overlay"
          :disabled="!rampOverlayAvailable"
          @change="updateRamp({ overlay: $event })"
        />
        <label class="test-card-control test-card-control--wide">
          <span>{{ t('testCard.direction') }}</span>
          <select class="test-card-select" :value="config.ramp.direction" @change="updateRamp({ direction: eventString($event) as TestCardRampDirection })">
            <option value="Horizontal">{{ t('testCard.horizontal') }}</option>
            <option value="Vertical">{{ t('testCard.vertical') }}</option>
            <option value="Diagonal">{{ t('testCard.diagonal') }}</option>
            <option value="Radial">{{ t('testCard.radial') }}</option>
          </select>
        </label>
      </div>
    </fieldset>

    <fieldset v-if="config.cardType === 'placeholder'" class="test-card-fieldset" :disabled="disabled">
      <legend>{{ t('testCard.nameCard') }}</legend>
      <div class="test-card-grid test-card-grid--three">
        <ColorControl :label="t('testCard.background')" :value="config.placeholder.bg" @change="updatePlaceholder({ bg: $event })" />
        <ColorControl :label="t('testCard.foreground')" :value="config.placeholder.fg" @change="updatePlaceholder({ fg: $event })" />
        <CheckControl :label="t('testCard.gradient')" :checked="config.placeholder.gradient" @change="updatePlaceholder({ gradient: $event })" />
        <label class="test-card-control">
          <span>{{ t('testCard.icon') }}</span>
          <select class="test-card-select" :value="config.placeholder.icon" @change="updatePlaceholder({ icon: eventString($event) })">
            <option v-for="icon in PLACEHOLDER_ICONS" :key="icon.id" :value="icon.id">{{ t(icon.labelKey) }}</option>
          </select>
        </label>
        <label v-if="config.placeholder.icon === 'custom'" class="test-card-control test-card-control--wide">
          <span>{{ t('testCard.fontAwesomeIcon') }}</span>
          <input :value="config.placeholder.custom" type="text" maxlength="120" @input="updatePlaceholder({ custom: eventString($event) })">
        </label>
      </div>
    </fieldset>

    <fieldset v-if="config.cardType === 'audioSync'" class="test-card-fieldset" :disabled="disabled">
      <legend>{{ t('testCard.audioSync') }}</legend>
      <div class="test-card-grid test-card-grid--two">
        <label class="test-card-control">
          <span>{{ t('testCard.audioDevice') }}</span>
          <select class="test-card-select" :value="config.audioSync.deviceId" @change="updateAudioSync({ deviceId: eventString($event) })">
            <option value="default">{{ t('testCard.programOutput') }}</option>
            <option v-for="device in audioDevices" :key="device.id" :value="device.display_name">
              {{ device.display_name }}
            </option>
          </select>
        </label>
        <label class="test-card-control">
          <span>{{ t('testCard.rateFps') }}</span>
          <select class="test-card-select" :value="config.audioSync.rate" @change="updateAudioSync({ rate: eventNumber($event) as TestCardAudioSyncRate })">
            <option v-for="rate in AUDIO_SYNC_RATES" :key="rate" :value="rate">{{ rate }}</option>
          </select>
        </label>
      </div>
      <p class="test-card-help">{{ t('testCard.audioSyncHelp') }}</p>
    </fieldset>

    <fieldset v-if="config.cardType === 'deghost'" class="test-card-fieldset" :disabled="disabled">
      <legend>{{ t('testCard.deghost') }}</legend>
      <div class="test-card-grid test-card-grid--two">
        <label class="test-card-control">
          <span>{{ t('testCard.density') }}</span>
          <select class="test-card-select" :value="config.deghost.density" @change="updateDeghost({ density: eventNumber($event) as TestCardConfig['deghost']['density'] })">
            <option v-for="option in DEGHOST_DENSITIES" :key="option.value" :value="option.value">{{ t(option.labelKey) }}</option>
          </select>
        </label>
        <label class="test-card-control">
          <span>{{ t('testCard.speed') }}</span>
          <select class="test-card-select" :value="config.deghost.speed" @change="updateDeghost({ speed: eventNumber($event) as TestCardConfig['deghost']['speed'] })">
            <option v-for="option in DEGHOST_SPEEDS" :key="option.value" :value="option.value">{{ t(option.labelKey) }}</option>
          </select>
        </label>
      </div>
    </fieldset>

    <fieldset v-if="config.cardType === 'led'" class="test-card-fieldset" :disabled="disabled">
      <legend>{{ t('testCard.ledWall') }}</legend>
      <div class="test-card-grid test-card-grid--four">
        <NumberControl :label="t('testCard.panelWidth')" :value="config.led.width" :min="16" :max="720" @change="updateLed({ width: $event })" />
        <NumberControl :label="t('testCard.panelHeight')" :value="config.led.height" :min="16" :max="720" @change="updateLed({ height: $event })" />
        <NumberControl :label="t('testCard.columns')" :value="config.led.columns" :min="1" :max="128" @change="updateLed({ columns: $event })" />
        <NumberControl :label="t('testCard.rows')" :value="config.led.rows" :min="1" :max="128" @change="updateLed({ rows: $event })" />
        <CheckControl :label="t('testCard.border')" :checked="config.led.border" @change="updateLed({ border: $event })" />
        <CheckControl :label="t('testCard.position')" :checked="config.led.position" @change="updateLed({ position: $event })" />
      </div>
      <p class="test-card-help">{{ t('testCard.ledSize', { width: ledWidth, height: ledHeight }) }}</p>
    </fieldset>

    <fieldset class="test-card-fieldset" :disabled="disabled">
      <legend>{{ t('testCard.outputOptions') }}</legend>
      <div class="test-card-grid test-card-grid--three">
        <CheckControl :label="t('testCard.windowed')" :checked="config.windowed" @change="setWindowed" />
        <CheckControl
          :label="t('testCard.fillOutput')"
          :checked="config.fullsize"
          :disabled="config.windowed || config.cardType === 'led'"
          @change="update({ fullsize: $event })"
        />
        <CheckControl
          :label="t('testCard.showBounds')"
          :checked="config.notFilledCard.bounds"
          :disabled="config.fullsize"
          @change="updateNotFilled({ bounds: $event })"
        />
      </div>

      <div v-if="config.windowed" class="test-card-grid test-card-grid--two">
        <NumberControl :label="t('testCard.windowWidth')" :value="config.window.width" :min="48" :max="16384" :step="5" @change="updateWindow({ width: $event })" />
        <NumberControl :label="t('testCard.windowHeight')" :value="config.window.height" :min="39" :max="16384" :step="5" @change="updateWindow({ height: $event })" />
      </div>

      <template v-if="!config.fullsize">
        <div class="test-card-subheading">{{ t('testCard.cardSizePosition') }}</div>
        <div class="test-card-grid test-card-grid--four">
          <NumberControl :label="t('testCard.width')" :value="config.notFilledCard.width" :min="1" :max="16384" :step="5" :disabled="config.cardType === 'led'" @change="updateNotFilled({ width: $event })" />
          <NumberControl :label="t('testCard.height')" :value="config.notFilledCard.height" :min="1" :max="16384" :step="5" :disabled="config.cardType === 'led'" @change="updateNotFilled({ height: $event })" />
          <NumberControl :label="t('testCard.left')" :value="config.notFilledCard.left" :min="-32768" :max="32768" :step="5" @change="updateNotFilled({ left: $event })" />
          <NumberControl :label="t('testCard.top')" :value="config.notFilledCard.top" :min="-32768" :max="32768" :step="5" @change="updateNotFilled({ top: $event })" />
        </div>
        <div class="test-card-choice-row">
          <span>{{ t('testCard.rotation') }}</span>
          <label v-for="rotation in ROTATIONS" :key="rotation">
            <input
              type="radio"
              name="test-card-rotation"
              :value="rotation"
              :checked="config.notFilledCard.rotate === rotation"
              @change="updateNotFilled({ rotate: rotation })"
            >
            {{ rotation }}º
          </label>
        </div>
      </template>
    </fieldset>

    <fieldset class="test-card-fieldset" :disabled="disabled">
      <legend>{{ t('testCard.mask') }}</legend>
      <div class="test-card-image-row">
        <CheckControl :label="t('testCard.enableMask')" :checked="config.mask.enabled" :disabled="!config.mask.image" @change="updateMask({ enabled: $event })" />
        <CheckControl
          :label="t('testCard.applyMaskToBounds')"
          :checked="config.mask.applyBounds"
          :disabled="config.fullsize || config.windowed"
          @change="updateMask({ applyBounds: $event })"
        />
        <button type="button" class="test-card-button" @click="maskInput?.click()">{{ t('testCard.selectImage') }}</button>
        <button v-if="config.mask.image" type="button" class="test-card-button" @click="clearMask">{{ t('testCard.clearImage') }}</button>
        <img v-if="config.mask.image" class="test-card-mask-preview" :src="config.mask.image" alt="">
        <input
          ref="maskInput"
          class="test-card-file-input"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          @change="onImagePicked($event, 'mask')"
        >
      </div>
      <p class="test-card-help">{{ t('testCard.maskHelp') }}</p>
      <p v-if="imageError" class="test-card-error" role="alert">{{ imageError }}</p>
    </fieldset>
  </div>
</template>

<script setup lang="ts">
import type {
  TestCardAudioSyncRate,
  TestCardBarsColor,
  TestCardBarsLevel,
  TestCardBarsType,
  TestCardConfig,
  TestCardRampDirection,
  TestCardRotation,
} from '../../electron/test-card-config.mjs';
import {
  AUDIO_SYNC_RATES,
  TEST_CARD_PRESETS,
  createTestCardConfig,
} from '../../electron/test-card-config.mjs';
import { defineComponent, h } from 'vue';

const CheckControl = defineComponent({
  name: 'TestCardCheckControl',
  props: {
    label: { type: String, required: true },
    checked: { type: Boolean, required: true },
    disabled: { type: Boolean, default: false },
  },
  emits: ['change'],
  setup(componentProps, { emit: componentEmit }) {
    return () => h('label', { class: 'test-card-check' }, [
      h('input', {
        type: 'checkbox',
        checked: componentProps.checked,
        disabled: componentProps.disabled,
        onChange: (event: Event) => componentEmit('change', (event.target as HTMLInputElement).checked),
      }),
      h('span', componentProps.label),
    ]);
  },
});

const ColorControl = defineComponent({
  name: 'TestCardColorControl',
  props: {
    label: { type: String, required: true },
    value: { type: String, required: true },
  },
  emits: ['change'],
  setup(componentProps, { emit: componentEmit }) {
    return () => h('label', { class: ['test-card-control', 'test-card-color'] }, [
      h('span', componentProps.label),
      h('span', { class: 'test-card-color-row' }, [
        h('input', {
          type: 'color',
          value: componentProps.value,
          onInput: (event: Event) => componentEmit('change', (event.target as HTMLInputElement).value),
        }),
        h('code', componentProps.value),
      ]),
    ]);
  },
});

const NumberControl = defineComponent({
  name: 'TestCardNumberControl',
  props: {
    label: { type: String, required: true },
    value: { type: Number, required: true },
    min: { type: Number, required: true },
    max: { type: Number, required: true },
    step: { type: Number, default: 1 },
    suffix: { type: String, default: '' },
    disabled: { type: Boolean, default: false },
  },
  emits: ['change'],
  setup(componentProps, { emit: componentEmit }) {
    return () => h('label', { class: 'test-card-control' }, [
      h('span', componentProps.label),
      h('span', { class: 'test-card-number-row' }, [
        h('input', {
          type: 'number',
          value: componentProps.value,
          min: componentProps.min,
          max: componentProps.max,
          step: componentProps.step,
          disabled: componentProps.disabled,
          onChange: (event: Event) => componentEmit('change', (event.target as HTMLInputElement).valueAsNumber),
        }),
        componentProps.suffix ? h('span', componentProps.suffix) : null,
      ]),
    ]);
  },
});

const props = withDefaults(defineProps<{
  config: TestCardConfig;
  disabled?: boolean;
}>(), {
  disabled: false,
});
const emit = defineEmits<{
  (event: 'change', config: TestCardConfig): void;
}>();

const { t } = useLocalization();
const server = useLiveplayServer();
const logoInput = ref<HTMLInputElement | null>(null);
const maskInput = ref<HTMLInputElement | null>(null);
const imageError = ref('');

const BAR_COLORS: readonly TestCardBarsColor[] = ['Red', 'Green', 'Blue', 'Cyan', 'Magenta', 'Yellow', 'white'];
const ROTATIONS: readonly TestCardRotation[] = [0, 90, 180, 270];
const PLACEHOLDER_ICONS = [
  { id: '', labelKey: 'testCard.iconBlank' },
  { id: 'fa-desktop', labelKey: 'testCard.iconDesktop' },
  { id: 'fa-phone', labelKey: 'testCard.iconPhone' },
  { id: 'fa-chart-line', labelKey: 'testCard.iconChart' },
  { id: 'fa-image', labelKey: 'testCard.iconImage' },
  { id: 'fa-file-powerpoint', labelKey: 'testCard.iconPresentation' },
  { id: 'fa-camera', labelKey: 'testCard.iconCamera' },
  { id: 'fa-film', labelKey: 'testCard.iconFilm' },
  { id: 'fa-microphone', labelKey: 'testCard.iconMicrophone' },
  { id: 'fa-clock', labelKey: 'testCard.iconClock' },
  { id: 'custom', labelKey: 'testCard.iconOther' },
] as const;
const DEGHOST_DENSITIES = [
  { value: 33, labelKey: 'testCard.low' },
  { value: 75, labelKey: 'testCard.medium' },
  { value: 125, labelKey: 'testCard.high' },
  { value: 166, labelKey: 'testCard.maximum' },
] as const;
const DEGHOST_SPEEDS = [
  { value: 1, labelKey: 'testCard.low' },
  { value: 3, labelKey: 'testCard.medium' },
  { value: 6, labelKey: 'testCard.high' },
  { value: 11, labelKey: 'testCard.maximum' },
] as const;

const selectedPresetId = computed(() => {
  const match = TEST_CARD_PRESETS.find((preset) => preset.cardType === props.config.cardType
    && (preset.cardType !== 'bars' || preset.barsType === props.config.bars.type));
  return match?.id ?? 'alteka';
});
const motionDisabled = computed(() => ['alteka', 'audioSync', 'deghost', 'led'].includes(props.config.cardType));
const infoCircleAvailable = computed(() =>
  props.config.cardType === 'grid'
  || props.config.cardType === 'ramp'
  || (props.config.cardType === 'bars' && props.config.bars.type !== 'hdr'));
const rampOverlayAvailable = computed(() =>
  props.config.ramp.stepped
  && (props.config.ramp.direction === 'Horizontal' || props.config.ramp.direction === 'Vertical'));
const visibleBarLevels = computed<readonly TestCardBarsLevel[]>(() =>
  props.config.bars.type === 'simple' ? ['75', '100', '109'] : ['-9', '0', '75', '100', '109']);
const audioDevices = computed(() => {
  const uniqueDevices = new Map<string, (typeof server.devices)[number]>();
  for (const device of server.devices ?? []) {
    if (device.display_name && !uniqueDevices.has(device.display_name)) uniqueDevices.set(device.display_name, device);
  }
  return [...uniqueDevices.values()];
});
const ledWidth = computed(() => props.config.led.width * props.config.led.columns);
const ledHeight = computed(() => props.config.led.height * props.config.led.rows);

function eventString(event: Event): string {
  return (event.target as HTMLInputElement | HTMLSelectElement).value;
}

function eventNumber(event: Event): number {
  return Number(eventString(event));
}

function update(patch: Partial<TestCardConfig>): void {
  emit('change', createTestCardConfig({ ...props.config, ...patch }));
}

function updateName(event: Event): void {
  update({ name: eventString(event) });
}

function updateAlteka(patch: Partial<TestCardConfig['alteka']>): void {
  update({ alteka: { ...props.config.alteka, ...patch } });
}

function updateBars(patch: Partial<TestCardConfig['bars']>): void {
  update({ bars: { ...props.config.bars, ...patch } });
}

function updateGrid(patch: Partial<TestCardConfig['grid']>): void {
  update({ grid: { ...props.config.grid, ...patch } });
}

function updateRamp(patch: Partial<TestCardConfig['ramp']>): void {
  update({ ramp: { ...props.config.ramp, ...patch } });
}

function updatePlaceholder(patch: Partial<TestCardConfig['placeholder']>): void {
  update({ placeholder: { ...props.config.placeholder, ...patch } });
}

function updateAudioSync(patch: Partial<TestCardConfig['audioSync']>): void {
  update({ audioSync: { ...props.config.audioSync, ...patch } });
}

function updateDeghost(patch: Partial<TestCardConfig['deghost']>): void {
  update({ deghost: { ...props.config.deghost, ...patch } });
}

function updateLed(patch: Partial<TestCardConfig['led']>): void {
  const led = { ...props.config.led, ...patch };
  const width = led.width * led.columns;
  const height = led.height * led.rows;
  update({
    led,
    notFilledCard: { ...props.config.notFilledCard, width, height },
    window: props.config.windowed ? { width, height } : props.config.window,
  });
}

function updateNotFilled(patch: Partial<TestCardConfig['notFilledCard']>): void {
  update({ notFilledCard: { ...props.config.notFilledCard, ...patch } });
}

function updateWindow(patch: Partial<TestCardConfig['window']>): void {
  update({ window: { ...props.config.window, ...patch } });
}

function updateMask(patch: Partial<TestCardConfig['mask']>): void {
  update({ mask: { ...props.config.mask, ...patch } });
}

function onPresetChange(event: Event): void {
  const preset = TEST_CARD_PRESETS.find((candidate) => candidate.id === eventString(event));
  if (!preset) return;
  const patch: Partial<TestCardConfig> = { cardType: preset.cardType };
  if (preset.barsType) patch.bars = { ...props.config.bars, type: preset.barsType };
  if (preset.cardType === 'led') {
    const width = props.config.led.width * props.config.led.columns;
    const height = props.config.led.height * props.config.led.rows;
    patch.fullsize = props.config.windowed;
    patch.notFilledCard = { ...props.config.notFilledCard, width, height };
    if (props.config.windowed) patch.window = { width, height };
  }
  update(patch);
}

function setWindowed(windowed: boolean): void {
  if (!windowed) {
    update({ windowed: false, fullsize: props.config.cardType !== 'led' });
    return;
  }
  const patch: Partial<TestCardConfig> = { windowed: true, fullsize: true };
  if (props.config.cardType === 'led') patch.window = { width: ledWidth.value, height: ledHeight.value };
  update(patch);
}

function clearMask(): void {
  updateMask({ image: '', enabled: false });
}

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('not a data URL')));
    reader.addEventListener('error', () => reject(reader.error ?? new Error('read failed')));
    reader.readAsDataURL(file);
  });
}

async function onImagePicked(event: Event, target: 'logo' | 'mask'): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;

  imageError.value = '';
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 5_500_000) {
    imageError.value = t('testCard.imageRejected');
    return;
  }

  try {
    const image = await readImage(file);
    const candidate = target === 'logo'
      ? createTestCardConfig({ ...props.config, alteka: { ...props.config.alteka, logo: image } })
      : createTestCardConfig({ ...props.config, mask: { ...props.config.mask, image, enabled: true } });
    const accepted = target === 'logo' ? candidate.alteka.logo : candidate.mask.image;
    if (!accepted) {
      imageError.value = t('testCard.imageRejected');
      return;
    }
    emit('change', candidate);
  } catch {
    imageError.value = t('testCard.imageRejected');
  }
}
</script>


<style>
.test-card-controls {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.test-card-fieldset {
  min-width: 0;
  margin: 0;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-md);
}
.test-card-fieldset > legend {
  padding: 0 6px;
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 650;
}
.test-card-grid {
  display: grid;
  gap: 10px 12px;
  align-items: end;
}
.test-card-grid + .test-card-grid,
.test-card-subheading + .test-card-grid {
  margin-top: 10px;
}
.test-card-grid--two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.test-card-grid--three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.test-card-grid--four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.test-card-control,
.test-card-check {
  display: flex;
  color: var(--color-text-primary);
  font-size: 12px;
}
.test-card-control {
  min-width: 0;
  flex-direction: column;
  gap: 5px;
}
.test-card-control--wide { grid-column: span 2; }
.test-card-check {
  min-height: 34px;
  align-items: center;
  gap: 7px;
}
.test-card-check input {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--color-accent);
}
.test-card-control input[type='text'],
.test-card-control input[type='number'],
.test-card-select {
  min-width: 0;
  width: 100%;
  height: 34px;
  box-sizing: border-box;
  padding: 0 9px;
  background: var(--color-control);
  color: var(--color-text-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  font: inherit;
}
.test-card-color-row,
.test-card-number-row,
.test-card-image-row,
.test-card-choice-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.test-card-color-row input[type='color'] {
  width: 36px;
  height: 34px;
  padding: 2px;
  background: var(--color-control);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
}
.test-card-color-row code {
  color: var(--color-text-secondary);
  font-size: 11px;
}
.test-card-number-row input { flex: 1; }
.test-card-image-row { flex-wrap: wrap; }
.test-card-logo-preview,
.test-card-mask-preview {
  display: block;
  max-width: 135px;
  height: 45px;
  object-fit: contain;
  background: #1a1a1a;
  border: 1px solid var(--color-border);
}
.test-card-mask-preview { width: 80px; object-fit: cover; }
.test-card-file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}
.test-card-button {
  min-height: 32px;
  padding: 5px 10px;
  background: var(--color-surface);
  color: var(--color-text-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  font: inherit;
  cursor: pointer;
}
.test-card-button:hover { background: var(--color-surface-hover); }
.test-card-choice-row {
  margin-top: 10px;
  flex-wrap: wrap;
  color: var(--color-text-primary);
  font-size: 12px;
}
.test-card-choice-row > span { margin-right: 4px; font-weight: 600; }
.test-card-choice-row label { display: inline-flex; align-items: center; gap: 4px; }
.test-card-choice-row input { accent-color: var(--color-accent); }
.test-card-subheading {
  margin-top: 12px;
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: .04em;
}
.test-card-help,
.test-card-error {
  margin: 7px 0 0;
  font-size: 11px;
  line-height: 1.4;
}
.test-card-help { color: var(--color-text-secondary); }
.test-card-error { color: var(--color-danger); }
.test-card-fieldset:disabled { opacity: .58; }
@media (max-width: 720px) {
  .test-card-grid--three,
  .test-card-grid--four { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 460px) {
  .test-card-grid--two,
  .test-card-grid--three,
  .test-card-grid--four { grid-template-columns: 1fr; }
  .test-card-control--wide { grid-column: auto; }
}
</style>
