<template>
  <div class="test-card-controls">
    <fieldset class="test-card-fieldset" :disabled="disabled">
      <legend>{{ t('testCard.cardType') }}</legend>
      <div class="test-card-grid test-card-grid--two test-card-preset-row">
        <InlineChoicePicker class="test-card-preset" :label="t('testCard.preset')" :value="selectedPresetId"
          :options="presetOptions" :disabled="disabled" @change="onPresetChange" />
        <label class="test-card-control test-card-name">
          <span>{{ t('testCard.name') }}</span>
          <input :value="config.name" type="text" maxlength="120" @input="updateName">
        </label>
      </div>
      <div class="test-card-checks">
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
        <InlineColorPicker :label="t('testCard.background')" :value="config.alteka.bg" @change="updateAlteka({ bg: $event })" />
        <InlineColorPicker :label="t('testCard.foreground')" :value="config.alteka.fg" @change="updateAlteka({ fg: $event })" />
        <InlineColorPicker :label="t('testCard.centerText')" :value="config.alteka.textColour" @change="updateAlteka({ textColour: $event })" />
        <CheckControl :label="t('testCard.gradient')" :checked="config.alteka.gradient" @change="updateAlteka({ gradient: $event })" />
      </div>
      <div class="test-card-image-row">
        <CheckControl :label="t('testCard.customLogo')" :checked="config.alteka.showLogo" @change="updateAlteka({ showLogo: $event })" />
        <div class="test-card-image-drop" role="group" :tabindex="disabled ? undefined : 0"
          :aria-label="t('testCard.dropLogo')" :aria-disabled="disabled"
          @dragover.prevent @drop.stop.prevent="pickImage($event.dataTransfer?.files, 'logo')"
          @paste.stop.prevent="pickImage($event.clipboardData?.files, 'logo')">
          {{ t('testCard.dropLogo') }}
        </div>
        <button v-if="config.alteka.logo" type="button" class="test-card-button" @click="clearImage('logo')">
          {{ t('testCard.clearImage') }}
        </button>
        <img v-if="config.alteka.logo" class="test-card-logo-preview" :src="config.alteka.logo" alt="">
      </div>
      <p v-if="imageStatus.logo === 'reading'" class="test-card-help" role="status">{{ t('testCard.checkingImage') }}</p>
      <p v-if="imageStatus.logo === 'invalid'" class="test-card-error" role="alert">{{ t('testCard.imageRejected') }}</p>
      <p v-if="config.alteka.showLogo" class="test-card-help">{{ t('testCard.logoHelp') }}</p>
    </fieldset>

    <fieldset v-if="config.cardType === 'bars'" class="test-card-fieldset" :disabled="disabled">
      <legend>{{ t('testCard.bars') }}</legend>
      <div class="test-card-grid test-card-grid--three">
        <div class="test-card-control">
          <span>{{ t('testCard.barsStyle') }}</span>
          <InlineChoicePicker :label="t('testCard.barsStyle')" :value="config.bars.type" :options="barsTypeOptions"
            :disabled="disabled" @change="updateBars({ type: $event })" />
        </div>
        <CheckControl :label="t('testCard.details')" :checked="config.bars.overlay" @change="updateBars({ overlay: $event })" />
        <div v-if="config.bars.type === 'single'" class="test-card-control">
          <span>{{ t('testCard.color') }}</span>
          <InlineChoicePicker :label="t('testCard.color')" :value="config.bars.color" :options="barsColorOptions"
            :disabled="disabled" @change="updateBars({ color: $event })" />
        </div>
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
        <InlineColorPicker :label="t('testCard.background')" :value="config.grid.bg" @change="updateGrid({ bg: $event })" />
        <InlineColorPicker :label="t('testCard.crosshair')" :value="config.grid.crosshair" @change="updateGrid({ crosshair: $event })" />
        <InlineColorPicker :label="t('testCard.lines')" :value="config.grid.lines" @change="updateGrid({ lines: $event })" />
        <InlineColorPicker :label="t('testCard.diagonalsColor')" :value="config.grid.diagColour" @change="updateGrid({ diagColour: $event })" />
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
        <div class="test-card-control test-card-control--wide">
          <span>{{ t('testCard.direction') }}</span>
          <InlineChoicePicker :label="t('testCard.direction')" :value="config.ramp.direction" :options="rampDirectionOptions"
            :disabled="disabled" @change="updateRamp({ direction: $event })" />
        </div>
      </div>
    </fieldset>

    <fieldset v-if="config.cardType === 'placeholder'" class="test-card-fieldset" :disabled="disabled">
      <legend>{{ t('testCard.nameCard') }}</legend>
      <div class="test-card-grid test-card-grid--three">
        <InlineColorPicker :label="t('testCard.background')" :value="config.placeholder.bg" @change="updatePlaceholder({ bg: $event })" />
        <InlineColorPicker :label="t('testCard.foreground')" :value="config.placeholder.fg" @change="updatePlaceholder({ fg: $event })" />
        <CheckControl :label="t('testCard.gradient')" :checked="config.placeholder.gradient" @change="updatePlaceholder({ gradient: $event })" />
        <div class="test-card-control">
          <span>{{ t('testCard.icon') }}</span>
          <InlineChoicePicker :label="t('testCard.icon')" :value="config.placeholder.icon" :options="placeholderIconOptions"
            :disabled="disabled" @change="updatePlaceholder({ icon: $event })" />
        </div>
        <label v-if="config.placeholder.icon === 'custom'" class="test-card-control test-card-control--wide">
          <span>{{ t('testCard.fontAwesomeIcon') }}</span>
          <input :value="config.placeholder.custom" type="text" maxlength="120" @input="updatePlaceholder({ custom: eventString($event) })">
        </label>
      </div>
    </fieldset>

    <fieldset v-if="config.cardType === 'audioSync'" class="test-card-fieldset" :disabled="disabled">
      <legend>{{ t('testCard.audioSync') }}</legend>
      <div class="test-card-grid test-card-grid--two">
        <div class="test-card-control">
          <span>{{ t('testCard.audioDevice') }}</span>
          <InlineChoicePicker :label="t('testCard.audioDevice')" :value="config.audioSync.deviceId" :options="audioDeviceOptions"
            :disabled="disabled" @change="updateAudioSync({ deviceId: $event })" />
        </div>
        <div class="test-card-control">
          <span>{{ t('testCard.rateFps') }}</span>
          <InlineChoicePicker :label="t('testCard.rateFps')" :value="config.audioSync.rate" :options="audioRateOptions"
            :disabled="disabled" @change="updateAudioSync({ rate: $event })" />
        </div>
      </div>
      <p class="test-card-help">{{ t('testCard.audioSyncHelp') }}</p>
    </fieldset>

    <fieldset v-if="config.cardType === 'deghost'" class="test-card-fieldset" :disabled="disabled">
      <legend>{{ t('testCard.deghost') }}</legend>
      <div class="test-card-grid test-card-grid--two">
        <div class="test-card-control">
          <span>{{ t('testCard.density') }}</span>
          <InlineChoicePicker :label="t('testCard.density')" :value="config.deghost.density" :options="deghostDensityOptions"
            :disabled="disabled" @change="updateDeghost({ density: $event })" />
        </div>
        <div class="test-card-control">
          <span>{{ t('testCard.speed') }}</span>
          <InlineChoicePicker :label="t('testCard.speed')" :value="config.deghost.speed" :options="deghostSpeedOptions"
            :disabled="disabled" @change="updateDeghost({ speed: $event })" />
        </div>
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
      <div class="test-card-checks">
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
        <div class="test-card-image-drop" role="group" :tabindex="disabled ? undefined : 0"
          :aria-label="t('testCard.dropMask')" :aria-disabled="disabled"
          @dragover.prevent @drop.stop.prevent="pickImage($event.dataTransfer?.files, 'mask')"
          @paste.stop.prevent="pickImage($event.clipboardData?.files, 'mask')">
          {{ t('testCard.dropMask') }}
        </div>
        <button v-if="config.mask.image" type="button" class="test-card-button" @click="clearImage('mask')">{{ t('testCard.clearImage') }}</button>
        <img v-if="config.mask.image" class="test-card-mask-preview" :src="config.mask.image" alt="">
      </div>
      <p v-if="config.mask.image" class="test-card-help">{{ t('testCard.maskHelp') }}</p>
      <p v-if="imageStatus.mask === 'reading'" class="test-card-help" role="status">{{ t('testCard.checkingImage') }}</p>
      <p v-if="imageStatus.mask === 'invalid'" class="test-card-error" role="alert">{{ t('testCard.imageRejected') }}</p>
    </fieldset>
  </div>
</template>

<script setup lang="ts">
import type {
  TestCardBarsColor,
  TestCardBarsLevel,
  TestCardConfig,
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
type ImageTarget = 'logo' | 'mask';
const imageStatus = reactive<Record<ImageTarget, 'reading' | 'invalid' | null>>({ logo: null, mask: null });
const imageRequest = { logo: 0, mask: 0 };
onScopeDispose(() => {
  imageRequest.logo++;
  imageRequest.mask++;
});

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

const presetOptions = computed(() => TEST_CARD_PRESETS.map(preset => ({
  value: preset.id, label: t(`testCard.presets.${preset.id}`),
})));
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
const barsTypeOptions = computed(() => [
  { value: 'simple', label: t('testCard.simple') },
  { value: 'smpte', label: 'SMPTE' },
  { value: 'arib', label: 'ARIB' },
  { value: 'hdr', label: 'HDR' },
  { value: 'sdi', label: 'SDI' },
  { value: 'single', label: t('testCard.single') },
] as const);
const barsColorOptions = computed(() => BAR_COLORS.map(value => ({
  value, label: t(`testCard.barColors.${value.toLowerCase()}`),
})));
const rampDirectionOptions = computed(() => [
  { value: 'Horizontal', label: t('testCard.horizontal') },
  { value: 'Vertical', label: t('testCard.vertical') },
  { value: 'Diagonal', label: t('testCard.diagonal') },
  { value: 'Radial', label: t('testCard.radial') },
] as const);
const placeholderIconOptions = computed(() => PLACEHOLDER_ICONS.map(icon => ({
  value: icon.id, label: t(icon.labelKey),
})));
const audioDeviceOptions = computed(() => [
  { value: 'default', label: t('testCard.programOutput') },
  ...audioDevices.value.map(device => ({ value: device.display_name, label: device.display_name })),
]);
const audioRateOptions = AUDIO_SYNC_RATES.map(value => ({ value, label: String(value) }));
const deghostDensityOptions = computed(() => DEGHOST_DENSITIES.map(option => ({
  value: option.value, label: t(option.labelKey),
})));
const deghostSpeedOptions = computed(() => DEGHOST_SPEEDS.map(option => ({
  value: option.value, label: t(option.labelKey),
})));
const ledWidth = computed(() => props.config.led.width * props.config.led.columns);
const ledHeight = computed(() => props.config.led.height * props.config.led.rows);

function eventString(event: Event): string {
  return (event.target as HTMLInputElement).value;
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

function onPresetChange(id: string): void {
  const preset = TEST_CARD_PRESETS.find(candidate => candidate.id === id);
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

function clearImage(target: ImageTarget): void {
  imageRequest[target]++;
  imageStatus[target] = null;
  if (target === 'logo') updateAlteka({ logo: '' });
  else updateMask({ image: '', enabled: false });
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

async function pickImage(files: FileList | undefined, target: ImageTarget): Promise<void> {
  if (props.disabled) return;
  const request = ++imageRequest[target];
  const file = files?.length === 1 ? files[0] : undefined;
  if (!file?.size || file.size > 5_500_000 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
    imageStatus[target] = 'invalid';
    return;
  }

  imageStatus[target] = 'reading';
  try {
    const image = await readImage(file);
    if (imageRequest[target] !== request) return;
    const preview = new Image();
    preview.src = image;
    await preview.decode();
    if (imageRequest[target] !== request || props.disabled) return;
    const candidate = target === 'logo'
      ? createTestCardConfig({ ...props.config, alteka: { ...props.config.alteka, logo: image } })
      : createTestCardConfig({ ...props.config, mask: { ...props.config.mask, image, enabled: true } });
    const accepted = target === 'logo' ? candidate.alteka.logo : candidate.mask.image;
    if (!accepted) throw new Error('Image is not supported');
    emit('change', candidate);
  } catch {
    if (imageRequest[target] === request) imageStatus[target] = 'invalid';
  } finally {
    if (imageRequest[target] === request && imageStatus[target] === 'reading') imageStatus[target] = null;
  }
}
</script>


<style>
.test-card-controls {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 2px 8px;
}
.test-card-fieldset {
  min-width: 0;
  margin: 0;
  padding: 2px 0;
  border: 0;
  border-top: 1px solid var(--color-border);
}
.test-card-fieldset > legend {
  padding: 0 4px 0 0;
  color: var(--color-text-primary);
  font-size: 12px;
  font-weight: 650;
  line-height: 1.35;
}
.test-card-grid {
  display: grid;
  gap: 2px 6px;
  align-items: end;
}
.test-card-grid + .test-card-grid,
.test-card-grid + .test-card-checks,
.test-card-subheading + .test-card-grid {
  margin-top: 3px;
}
.test-card-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 0 6px;
}
.test-card-grid--two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.test-card-grid--three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.test-card-grid--four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.test-card-preset-row { align-items: start; }
.test-card-preset[open] { grid-column: 1 / -1; }
.test-card-grid:has(> .inline-color-picker) { align-items: start; }
.test-card-grid--four:has(> .inline-color-picker) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.test-card-control,
.test-card-check {
  display: flex;
  color: var(--color-text-primary);
  font-size: 12px;
  line-height: 1.25;
}
.test-card-control {
  min-width: 0;
  flex-direction: column;
  gap: 5px;
}
.test-card-control--wide { grid-column: span 2; }
.test-card-name { flex-direction: row; align-items: center; }
.test-card-check {
  min-height: var(--settings-control-height);
  align-items: center;
  gap: 5px;
}
.test-card-check input {
  width: 16px;
  height: 16px;
  flex: none;
  margin: 0;
  accent-color: var(--color-accent);
}
.test-card-control input[type='text'],
.test-card-control input[type='number'] {
  min-width: 0;
  width: 100%;
  height: var(--settings-control-height);
  box-sizing: border-box;
  padding: 0 6px;
  background: var(--color-control);
  color: var(--color-text-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  font: inherit;
}
.test-card-number-row,
.test-card-image-row,
.test-card-choice-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.test-card-number-row input { flex: 1; }
.test-card-image-row { flex-wrap: wrap; gap: 4px; }
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
.test-card-image-drop {
  display: flex;
  flex: 1 0 auto;
  align-items: center;
  min-height: var(--settings-control-height);
  max-width: 100%;
  padding: 3px 8px;
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--control-radius);
  color: var(--color-text-primary);
  font-size: 12px;
}
.test-card-button {
  min-height: var(--settings-control-height);
  padding: 3px 8px;
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
  .test-card-controls { grid-template-columns: minmax(0, 1fr); }
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
