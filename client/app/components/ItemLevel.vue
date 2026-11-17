<template>
  <!-- One level control for a cue, a group or a QuickPlay. It edits the values
       Properties already owns, nothing new: a cue's `volume` (stored linear,
       shown in dB, -60 to +10 like the Volume field) and a group's
       `groupGainDb` (-60 to 0 like the Group level slider). -->
  <span class="item-level" draggable="false"
    @click.stop @dblclick.stop @pointerdown.stop @mousedown.stop>
    <!-- Read-only is Show Mode: a number that is not a text field, so nothing
         here can take the keyboard from GO. -->
    <output v-if="readOnly" class="item-level__value item-level__value--readout"
      :aria-label="t(label, { name: item.displayName })">{{ level.toFixed(1) }}</output>
    <input v-else class="item-level__value" type="number" inputmode="decimal" draggable="false"
      :min="range.min" :max="range.max" :step="STEP_DB" :value="level.toFixed(1)"
      :aria-label="t(label, { name: item.displayName })"
      :title="t(label, { name: item.displayName })"
      :disabled="disabled"
      @keydown.stop @keyup.stop @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
      @change="setLevel(($event.target as HTMLInputElement).valueAsNumber, $event)" />
    <span class="item-level__unit" aria-hidden="true">dB</span>
    <!-- Stacked up and down arrows, half a dB a press. -->
    <span class="item-level__spin">
      <button type="button" class="item-level__nudge" draggable="false" tabindex="-1"
        :aria-label="t('playlist.groupLevelUp', { name: item.displayName })"
        :title="t('playlist.groupLevelUp', { name: item.displayName })"
        :disabled="disabled || level >= range.max"
        @click.stop="nudge(1, $event)"><span class="material-symbols-rounded" aria-hidden="true">arrow_drop_up</span></button>
      <button type="button" class="item-level__nudge" draggable="false" tabindex="-1"
        :aria-label="t('playlist.groupLevelDown', { name: item.displayName })"
        :title="t('playlist.groupLevelDown', { name: item.displayName })"
        :disabled="disabled || level <= range.min"
        @click.stop="nudge(-1, $event)"><span class="material-symbols-rounded" aria-hidden="true">arrow_drop_down</span></button>
    </span>
  </span>
</template>

<script setup lang="ts">
import type { AudioItem, GroupItem } from '~/types/project';
import { dbToLinear, linearToDb } from '~/utils/audio';

const props = defineProps<{
  item: AudioItem | GroupItem;
  readOnly?: boolean;   // Show Mode: display the number instead of a field
  disabled?: boolean;
  maxDb?: number;       // a QuickPlay's gain goes to +12 dB, as in its settings
  // How the change is stored. The default saves the show; a QuickPlay tile
  // passes its own, which also works from the detached QuickPlays window.
  persist?: () => void;
}>();

const { t } = useLocalization();
const { saveProject } = useProject();

// One press of an arrow: to the next half dB in that direction.
const STEP_DB = 0.5;
const range = computed(() => props.item.type === 'group'
  ? { min: -60, max: 0, step: 0.5 }
  : { min: -60, max: props.maxDb ?? 10, step: 0.1 });
const label = computed(() => props.item.type === 'group' ? 'playlist.groupLevelFor' : 'playlist.cueLevelFor');
const level = computed(() => {
  const { min, max } = range.value;
  const db = props.item.type === 'group' ? props.item.groupGainDb : linearToDb(props.item.volume ?? 1);
  return typeof db === 'number' && Number.isFinite(db) ? Math.min(max, Math.max(min, db)) : 0;
});

let pendingSave: ReturnType<typeof setTimeout> | undefined;
function setLevel(value: number, event?: Event) {
  if (props.disabled) return;
  const { min, max, step } = range.value;
  const next = Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value / step) * step))
    : level.value;
  // Show what was accepted, even when it equals the old value (out-of-range entry).
  const field = event?.target as HTMLInputElement | undefined;
  if (field?.tagName === 'INPUT') field.value = next.toFixed(1);
  if (Math.abs(next - level.value) < 0.001) return;
  // Reaches the engine at once, like the same edit made in Properties.
  if (props.item.type === 'group') props.item.groupGainDb = next;
  else props.item.volume = dbToLinear(next);
  // Several presses in a row become one save of the show file.
  clearTimeout(pendingSave);
  pendingSave = setTimeout(() => { if (props.persist) props.persist(); else void saveProject(); }, 400);
}
function nudge(direction: number, event: Event) {
  const steps = level.value / STEP_DB;
  setLevel((direction > 0 ? Math.floor(steps + 1e-6) + 1 : Math.ceil(steps - 1e-6) - 1) * STEP_DB);
  // Leave the keyboard with the transport: Space must stay GO, not this button.
  (event.currentTarget as HTMLElement | null)?.blur();
}
</script>

<style scoped lang="scss">
/* Compact on purpose: the title owns the space, the level is a small field. */
.item-level {
  flex: none;
  display: inline-flex;
  align-items: stretch;
  height: var(--cue-cell-height, 28px);
  padding-left: 4px;
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background: var(--color-control);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  cursor: default;
}

.item-level__value {
  align-self: center;
  width: 5ch;
  padding: 0;
  border: 0;
  background: none;
  color: var(--color-text-primary);
  font: inherit;
  font-size: 12px;
  text-align: right;
  appearance: textfield;
  -moz-appearance: textfield;

  &::-webkit-outer-spin-button,
  &::-webkit-inner-spin-button { appearance: none; margin: 0; }
  &:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 1px; border-radius: 2px; }
}

.item-level__value--readout { display: inline-block; }

.item-level__unit {
  align-self: center;
  margin: 0 3px 0 2px;
  color: var(--color-text-secondary);
  font-size: 11px;
}

/* Stacked arrows, 16px wide. */
.item-level__spin {
  display: grid;
  grid-template-rows: 1fr 1fr;
  width: 16px;
  border-left: 1px solid var(--color-border);
}

.item-level__nudge {
  display: grid;
  place-items: center;
  min-height: 0;
  padding: 0;
  border: 0;
  background: none;
  color: var(--color-text-secondary);
  cursor: pointer;
  overflow: hidden;

  .material-symbols-rounded { font-size: 18px; line-height: 0.7; }
  &:hover:not(:disabled) { background: var(--color-surface-hover); color: var(--color-text-primary); }
  &:disabled { color: var(--color-text-disabled); cursor: default; }
}

</style>
