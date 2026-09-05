<template>
  <!--
    Stereo meter with EBU R128-inspired colour scheme and dB scale.
    Used for both per-cue source metering (pass cueId) and per-output
    master-bus metering (pass leftIndex + rightIndex).

    Bug fix: composables are always called unconditionally so that a cueId
    which resolves after mount (server decorates items asynchronously) still
    activates the subscription on the next meter frame.
  -->
  <div class="stereo-meter" :class="{ 'stereo-meter--strip': hasScaleControl }">
    <div v-if="label" class="stereo-meter__label">{{ label }}</div>

    <div class="stereo-meter__body">
      <div class="stereo-meter__clips">
        <button
          type="button"
          class="stereo-meter__clip"
          :class="{ 'is-clipped': holdL.clipped.value }"
          :aria-label="holdL.clipped.value ? 'Left clip indicator, clipped. Activate to reset' : 'Left clip indicator, clear'"
          :title="holdL.clipped.value ? 'Left clip — click to reset' : 'Left clip — clear'"
          @click="holdL.resetClip"
        />
        <button
          type="button"
          class="stereo-meter__clip"
          :class="{ 'is-clipped': holdR.clipped.value }"
          :aria-label="holdR.clipped.value ? 'Right clip indicator, clipped. Activate to reset' : 'Right clip indicator, clear'"
          :title="holdR.clipped.value ? 'Right clip — click to reset' : 'Right clip — clear'"
          @click="holdR.resetClip"
        />
      </div>

      <!-- L + R tracks occupy the exact same grid row as the shared scale. -->
      <div class="stereo-meter__bars">
        <div class="stereo-meter__chan">
          <div class="stereo-meter__bar-group">
            <div class="stereo-meter__track">
              <div class="stereo-meter__rms-fill" :style="rmsStyleL" />
              <div class="stereo-meter__peak-cap" :style="peakStyleL" />
              <div v-if="holdVisibleL" class="stereo-meter__hold" :style="holdStyleL" />
            </div>
          </div>
        </div>
        <div class="stereo-meter__chan">
          <div class="stereo-meter__bar-group">
            <div class="stereo-meter__track">
              <div class="stereo-meter__rms-fill" :style="rmsStyleR" />
              <div class="stereo-meter__peak-cap" :style="peakStyleR" />
              <div v-if="holdVisibleR" class="stereo-meter__hold" :style="holdStyleR" />
            </div>
          </div>
        </div>
      </div>

      <div
        v-if="hasScaleControl"
        class="stereo-meter__gr-lane"
        role="meter"
        aria-label="Maximum gain reduction of independent left and right limiters"
        aria-valuemin="0"
        :aria-valuemax="Math.abs(Math.min(props.minDb, 0))"
        :aria-valuenow="Math.min(gainReduction, Math.abs(Math.min(props.minDb, 0)))"
        :aria-valuetext="gainReductionAriaLabel"
      >
        <div class="stereo-meter__gr-track" />
        <div class="stereo-meter__gr-fill" :style="gainReductionFillStyle" />
      </div>

      <div
        v-if="showPeakValue"
        class="stereo-meter__peak-text"
        :style="{ color: peakReadoutColor }"
      >
        {{ peakLabel }}<template v-if="meterMode === 'LUFS'"> · {{ shortTermLabel }}</template>
      </div>

      <!-- The fader slot shares this precise grid cell with the tick scale. -->
      <div v-if="hasScaleControl" class="stereo-meter__scale">
        <div
          v-for="m in scaleMarks"
          :key="m.db"
          class="stereo-meter__mark"
          :style="{ bottom: m.pct + '%' }"
        >
          <span class="stereo-meter__mark-text" :style="{ color: m.labelColor }">{{ m.label }}</span>
          <span class="stereo-meter__mark-tick" :style="{ background: m.color }" />
        </div>
      </div>
      <slot name="scale-control" />
    </div>
    <div v-if="slots.footer" class="stereo-meter__footer">
      <slot name="footer" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, useSlots } from 'vue';
import { useMasterMeter, useCueMeters, usePeakHold, lufsFromKwMs } from '~/composables/useLiveMeters';
import { useOutputTarget, METER_COLORS } from '~/composables/useOutputTarget';
import { dbToConsolePosition } from '~/utils/audio';

const props = withDefaults(defineProps<{
  leftIndex?: number | null;
  rightIndex?: number | null;
  cueId?: string | null;
  label?: string;
  showPeakValue?: boolean;
  minDb?: number;
  maxDb?: number;
}>(), {
  leftIndex: null,
  rightIndex: null,
  cueId: null,
  label: '',
  showPeakValue: false,
  minDb: -60,
  maxDb: 0,
});

const slots = useSlots();
const hasScaleControl = computed(() => !!slots['scale-control']);

// Always subscribe unconditionally — composables handle null IDs by returning
// silence. This ensures a cueId that resolves after mount (the server
// decorates items asynchronously after mirroring audio into the engine)
// still activates the meter subscription on the next broadcast frame.
const cueStream   = useCueMeters(() => props.cueId);
const leftStream  = useMasterMeter(() => props.leftIndex);
const rightStream = useMasterMeter(() => props.rightIndex);

// Server-reported output-target levels and meter mode.
const { levels, meterMode, colorForLevel, textColorForLevel } = useOutputTarget();

// A meter measures signal level, not fader gain. Keep the fader's +40…−60
// scale untouched while giving every signal bar its own standard dBFS range.
const meterMinDb = -60;
const meterMaxDb = 0;
const meterPosition = (db: number) =>
  dbToConsolePosition(db, meterMinDb, meterMaxDb);

// Raw signal values from the server (always peak_db and rms_db).
const rawPeakL = computed(() => props.cueId != null
  ? (cueStream.sources.value[0]?.peak_db ?? -120)
  : leftStream.peak.value);
const rawRmsL = computed(() => props.cueId != null
  ? (cueStream.sources.value[0]?.rms_db ?? -120)
  : leftStream.rms.value);
const rawPeakR = computed(() => props.cueId != null
  ? (cueStream.sources.value[1]?.peak_db ?? cueStream.sources.value[0]?.peak_db ?? -120)
  : rightStream.peak.value);
const rawRmsR = computed(() => props.cueId != null
  ? (cueStream.sources.value[1]?.rms_db ?? cueStream.sources.value[0]?.rms_db ?? -120)
  : rightStream.rms.value);

// Lossless raw max since the previous frame — drives peak hold + clip latch.
// In dBTP mode the true-peak max is used, so intersample overs latch clip.
const rawMaxL = computed(() => {
  if (props.cueId != null) {
    const s = cueStream.sources.value[0];
    return (meterMode.value === 'dBTP' ? s?.true_peak_max_db : s?.peak_max_db) ?? -120;
  }
  return meterMode.value === 'dBTP' ? leftStream.truePeakMax.value : leftStream.peakMax.value;
});
const rawMaxR = computed(() => {
  if (props.cueId != null) {
    const s = cueStream.sources.value[1] ?? cueStream.sources.value[0];
    return (meterMode.value === 'dBTP' ? s?.true_peak_max_db : s?.peak_max_db) ?? -120;
  }
  return meterMode.value === 'dBTP' ? rightStream.truePeakMax.value : rightStream.peakMax.value;
});

const holdL = usePeakHold(() => rawMaxL.value);
const holdR = usePeakHold(() => rawMaxR.value);

// True-peak stream (4× oversampled server-side when the project's meter
// mode is dBTP; mirrors sample peak otherwise).
const rawTpL = computed(() => props.cueId != null
  ? (cueStream.sources.value[0]?.true_peak_db ?? -120)
  : leftStream.truePeak.value);
const rawTpR = computed(() => props.cueId != null
  ? (cueStream.sources.value[1]?.true_peak_db ?? cueStream.sources.value[0]?.true_peak_db ?? -120)
  : rightStream.truePeak.value);

// Loudness (BS.1770) of the metered pair: sum of the channels' K-weighted
// mean squares. One value for the pair — loudness has no L/R.
// Momentary (400 ms, EBU "M") drives the bars; short-term (3 s, EBU "S")
// is shown as a second readout.
const lufsMomentary = computed(() => {
  if (props.cueId != null) {
    return lufsFromKwMs(cueStream.sources.value.map(s => s.kw_ms));
  }
  return lufsFromKwMs([leftStream.kwMs.value, rightStream.kwMs.value]);
});
const lufsShortTerm = computed(() => {
  if (props.cueId != null) {
    return lufsFromKwMs(cueStream.sources.value.map(s => s.kw_ms_s));
  }
  return lufsFromKwMs([leftStream.kwMsS.value, rightStream.kwMsS.value]);
});

// Display value selected by the active meter mode.
// dBTP → oversampled true peak; dBFS → sample peak; RMS → rms;
// LUFS → K-weighted momentary loudness (same value on both bars — loudness
// is a property of the pair, not of a channel).
const displayL = computed(() => {
  switch (meterMode.value) {
    case 'RMS':  return rawRmsL.value;
    case 'LUFS': return lufsMomentary.value;
    case 'dBTP': return rawTpL.value;
    default:     return rawPeakL.value; // dBFS
  }
});
const displayR = computed(() => {
  switch (meterMode.value) {
    case 'RMS':  return rawRmsR.value;
    case 'LUFS': return lufsMomentary.value;
    case 'dBTP': return rawTpR.value;
    default:     return rawPeakR.value;
  }
});

const bodyL = computed(() => meterMode.value === 'LUFS'
  ? lufsMomentary.value
  : rawRmsL.value);
const bodyR = computed(() => meterMode.value === 'LUFS'
  ? lufsMomentary.value
  : rawRmsR.value);

const meterGradient = computed(() => {
  const yellow = meterPosition(levels.value.yellowMin) * 100;
  const red = Math.max(yellow, meterPosition(levels.value.redAbove) * 100);
  return `linear-gradient(to top,
    ${METER_COLORS.green} 0%,
    ${METER_COLORS.green} ${yellow.toFixed(2)}%,
    ${METER_COLORS.yellow} ${yellow.toFixed(2)}%,
    ${METER_COLORS.yellow} ${red.toFixed(2)}%,
    ${METER_COLORS.red} ${red.toFixed(2)}%,
    ${METER_COLORS.red} 100%)`;
});

function fillStyle(db: number): Record<string, string> {
  const pct = meterPosition(db) * 100;
  return {
    height: '100%',
    background: meterGradient.value,
    clipPath: `inset(${(100 - pct).toFixed(2)}% 0 0 0)`,
  };
}

function lineStyle(db: number): Record<string, string> {
  return { bottom: `${(meterPosition(db) * 100).toFixed(2)}%` };
}

function peakCapStyle(db: number): Record<string, string> {
  return {
    ...lineStyle(db),
    color: colorForLevel(db),
  };
}

const peakStyleL = computed(() => peakCapStyle(displayL.value));
const rmsStyleL  = computed(() => fillStyle(bodyL.value));
const peakStyleR = computed(() => peakCapStyle(displayR.value));
const rmsStyleR  = computed(() => fillStyle(bodyR.value));

// Peak-hold line is deliberately neutral so it remains visible in every zone.
function holdStyle(db: number): Record<string, string> {
  return lineStyle(db);
}
const holdVisibleL = computed(() => holdL.held.value > meterMinDb);
const holdVisibleR = computed(() => holdR.held.value > meterMinDb);
const holdStyleL = computed(() => holdStyle(holdL.held.value));
const holdStyleR = computed(() => holdStyle(holdR.held.value));

// Each master channel owns an independent limiter. One compact lane therefore
// shows the worst (most-negative) side; it must not imply a stereo-linked
// envelope that the engine does not provide.
const worstGainReductionDb = computed(() => Math.min(
  0,
  leftStream.gainReduction.value,
  rightStream.gainReduction.value,
));
const gainReduction = computed(() => Math.abs(worstGainReductionDb.value));
const gainReductionAriaLabel = computed(() =>
  `Maximum of independent left and right limiters: ${gainReduction.value.toFixed(1)} decibels`,
);

// Gain reduction starts at 0 dB at the top of its lane and grows downward
// through the same negative console taper the operator already sees on the
// shared scale. Positive fader headroom is intentionally excluded here.
const gainReductionFloorDb = computed(() => Math.min(props.minDb, 0));
const gainReductionExtent = computed(() => {
  const floor = gainReductionFloorDb.value;
  const clamped = Math.max(floor, Math.min(0, worstGainReductionDb.value));
  return (1 - dbToConsolePosition(clamped, floor, 0)) * 100;
});
const gainReductionFillStyle = computed(() => ({
  height: `${gainReductionExtent.value.toFixed(2)}%`,
}));

// Bars keep the high-chroma meter palette. Numeric readouts use the theme's
// semantic equivalents so those thresholds stay legible in both themes.
const peakReadoutColor = computed(() =>
  textColorForLevel(Math.max(displayL.value, displayR.value)),
);

// Scale tick marks at key zone boundary levels from the server-reported
// output target. Ticks use the zone colour for their position.
const scaleMarks = computed(() => {
  const { minDb, maxDb } = props;
  const candidates = [
    maxDb,
    20,
    10,
    5,
    0,
    -5,
    -10,
    -20,
    -40,
    minDb,
  ];
  return [...new Set(candidates)]
    .filter(db => db >= minDb && db <= maxDb)
    .sort((a, b) => b - a)
    .map(db => ({
      db,
      pct: dbToConsolePosition(db, minDb, maxDb) * 100,
      label: db > 0 ? `+${Math.round(db)}` : String(Math.round(db)).replace('-', '−'),
      labelColor: textColorForLevel(db),
      color: colorForLevel(db),
    }));
});

const modeLabel = computed(() => meterMode.value);

const peakLabel = computed(() => {
  const m = Math.max(displayL.value, displayR.value);
  if (m <= -119) return '−∞';
  // LUFS mode: label the momentary value "M"; the S line follows below.
  if (meterMode.value === 'LUFS') return `M ${m.toFixed(1)}`;
  return `${m.toFixed(1)} ${modeLabel.value}`;
});

const shortTermLabel = computed(() => {
  const s = lufsShortTerm.value;
  return s <= -119 ? 'S −∞' : `S ${s.toFixed(1)}`;
});
</script>

<style lang="scss" scoped>
.stereo-meter {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 54px;
  padding: 4px 5px;
  box-sizing: border-box;
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-sm);
  background: var(--color-surface);
  gap: 3px;
  flex-shrink: 0;

  &--strip {
    width: var(--output-strip-width, 192px);
    padding: 6px 8px;
    gap: 6px;
  }

  &--strip &__label {
    color: var(--color-text-primary);
    font-family: inherit;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0;
    line-height: 1.1;
    min-height: 36px;
    justify-content: flex-start;
    text-align: left;
    text-transform: none;
  }

  &__label {
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 700;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    text-align: center;
    flex-shrink: 0;
    overflow: hidden;
    white-space: normal;
    max-width: 100%;
    min-height: 23px;
    line-height: 1.1;
    display: flex;
    align-items: center;
    justify-content: center;
    text-wrap: balance;
  }

  &__body {
    display: grid;
    grid-template-columns: 26px;
    grid-template-rows: 6px minmax(40px, 1fr);
    justify-content: center;
    column-gap: 4px;
    row-gap: 3px;
    flex: 1;
    min-height: 0;
  }

  &--strip &__body {
    grid-template-columns: 28px 8px 72px;
    grid-template-rows: 6px minmax(40px, 1fr) 20px;
    column-gap: 8px;
    row-gap: 2px;
  }

  &__clips {
    grid-column: 1;
    grid-row: 1;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 3px;
    justify-items: center;
    width: 26px;
  }

  &__scale {
    grid-column: 3;
    grid-row: 2;
    position: relative;
    min-width: 0;
    margin: 10px 0;
    border-left: 1px solid var(--color-border);
  }

  &__scale::before {
    content: 'GAIN';
    position: absolute;
    top: -9px;
    left: 4px;
    color: var(--color-text-tertiary);
    font-family: var(--font-mono);
    font-size: 7px;
    font-weight: 600;
    letter-spacing: 0.08em;
    line-height: 1;
  }

  &__mark {
    position: absolute;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
    transform: translateY(50%);
    pointer-events: none;
  }

  &__mark-text {
    color: var(--color-text-secondary);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    text-align: right;
    white-space: nowrap;
  }

  &--strip &__mark-text {
    color: var(--color-text-primary);
    font-size: 12px;
  }

  &__mark-tick {
    display: block;
    width: 5px;
    height: 1px;
    background: var(--color-border-strong);
    flex-shrink: 0;
  }

  // Stereo signal pair has its own fixed -60..0 dBFS travel. It is visibly
  // separated from the +40..-60 gain control so neither rail implies the
  // other's numeric range.
  &__bars {
    grid-column: 1;
    grid-row: 2;
    display: flex;
    flex-direction: row;
    position: relative;
    width: 26px;
    min-height: 0;
    padding: 10px 0;
    box-sizing: border-box;
    gap: 2px;
    justify-content: center;
    justify-self: start;
  }

  &--strip &__bars::before {
    content: 'LVL';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    color: var(--color-text-tertiary);
    font-family: var(--font-mono);
    font-size: 7px;
    font-weight: 600;
    letter-spacing: 0.08em;
    line-height: 1;
    text-align: center;
  }

  // Each master channel owns its limiter. This lane shows the larger absolute
  // reduction, growing down from zero; it is not a stereo-linked envelope.
  &__gr-lane {
    grid-column: 2;
    grid-row: 2;
    position: relative;
    justify-self: center;
    width: 8px;
    min-height: 0;
    margin: 10px 0;
  }

  &--strip &__gr-lane::before {
    content: 'GR';
    position: absolute;
    top: -9px;
    left: 50%;
    transform: translateX(-50%);
    color: var(--color-text-tertiary);
    font-family: var(--font-mono);
    font-size: 7px;
    font-weight: 600;
    line-height: 1;
  }

  &__gr-track,
  &__gr-fill {
    position: absolute;
    inset-inline: 0;
    top: 0;
    bottom: 0;
    border-radius: 1px;
    pointer-events: none;
  }

  &__gr-track {
    border: 1px solid var(--color-border);
    background: var(--color-control);
  }

  &__gr-fill {
    z-index: 1;
    bottom: auto;
    background: var(--color-warning);
    transition: height 35ms linear;
  }

  &__chan {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  // Clip lamps remain independent buttons: raw max latches each side and the
  // operator acknowledges it by activating the corresponding lamp.
  &__clip {
    appearance: none;
    position: relative;
    width: 11px;
    height: 5px;
    padding: 0;
    border: 1px solid var(--color-border-strong);
    border-radius: 1px;
    background: var(--color-control);
    cursor: pointer;
    flex-shrink: 0;

    &::before {
      content: '';
      position: absolute;
      inset: -7px -6px;
    }

    &.is-clipped {
      border-color: var(--color-danger);
      background: var(--color-danger);
    }

    &:focus-visible {
      outline: 2px solid var(--color-focus-ring);
      outline-offset: 2px;
    }
  }

  // One wider signal track per channel; limiter reduction stays in the
  // permanent numeric readout rather than consuming another meter lane.
  &__bar-group {
    height: 100%;
    min-height: 0;
  }

  // Matte segmented signal bar. The engine owns ballistics; CSS only bridges
  // one broadcast frame so the display does not shimmer between updates.
  &__track {
    position: relative;
    width: 11px;
    height: 100%;
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: 1px;
    background: var(--color-control);
    flex-shrink: 0;
  }

  &__track::after {
    content: '';
    position: absolute;
    inset: 0;
    background: repeating-linear-gradient(
      to top,
      transparent 0 4px,
      var(--color-control) 4px 6px
    );
    pointer-events: none;
  }

  &__rms-fill {
    position: absolute;
    inset: 0;
    opacity: 0.72;
    transition: clip-path 35ms linear;
  }

  // Peak and hold are precise reference lines, not glowing decoration.
  &__peak-cap {
    position: absolute;
    left: 1px;
    right: 1px;
    height: 2px;
    z-index: 2;
    border-radius: 0;
    background: currentColor;
    pointer-events: none;
    transform: translateY(50%);
    transition: bottom 35ms linear, color 35ms linear;
  }

  &__hold {
    position: absolute;
    left: 0;
    right: 0;
    height: 1px;
    z-index: 3;
    background: var(--color-text-primary);
    pointer-events: none;
  }

  &__peak-text {
    grid-column: 1 / -1;
    grid-row: 3;
    align-self: center;
    justify-self: stretch;
    box-sizing: border-box;
    padding-right: 64px;
    color: var(--color-text-primary);
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    text-align: center;
    white-space: nowrap;
  }

  &__footer {
    width: 100%;
    height: 34px;
    flex: 0 0 34px;
  }

  &--strip &__footer {
    width: calc(100% + 20px);
    margin: 0 -10px -7px;
  }
}

// The cue/preview meter has no scale-control slot. It stays vertical, but
// drops the console-strip chrome and spends its height on signal instead.
.stereo-meter:not(.stereo-meter--strip) {
  width: 26px;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: 0;
  gap: 0;
}

.stereo-meter:not(.stereo-meter--strip) .stereo-meter__body {
  grid-template-rows: 6px minmax(0, 1fr);
  row-gap: 2px;
}

.stereo-meter:not(.stereo-meter--strip) .stereo-meter__bars {
  padding: 1px 0;
}
</style>
