<template>
  <details class="inline-color-picker" name="settings-color" @toggle="resetClosedDraft">
    <summary :aria-label="`${label} ${value}`" :title="value">
      <span v-if="!hideLabel" class="inline-color-label">{{ label }}</span>
      <span class="inline-color-chip" :style="{ backgroundColor: value }" aria-hidden="true"></span>
      <span v-if="hideLabel" class="inline-color-value">{{ value }}</span>
    </summary>
    <div class="inline-color-presets" role="group" :aria-label="t('colors.presets')">
      <button v-for="color in presets" :key="color" type="button" :aria-label="color"
        :aria-pressed="color === currentColor" :title="color" :style="{ backgroundColor: color }"
        @click="applyColor(color)" />
    </div>
    <form class="inline-color-form" @submit.prevent="applyColor(draft)">
      <input v-model="draft" type="text" maxlength="9" autocomplete="off" spellcheck="false"
        :aria-label="t('colors.hexFor', { label })" :aria-invalid="invalid" :aria-describedby="invalid ? errorId : undefined"
        @input="invalid = false" @keydown.enter.stop>
      <button type="submit" :aria-label="t('colors.applyHex')" :title="t('colors.applyHex')">
        <span class="material-symbols-rounded" aria-hidden="true">check</span>
      </button>
    </form>
    <p v-if="invalid" :id="errorId" class="inline-color-error" role="alert">
      {{ t(opaque ? 'colors.invalidOpaqueHex' : 'colors.invalidHex') }}
    </p>
  </details>
</template>

<script setup lang="ts">
import { DEFAULT_COUNTDOWN_COLOR_BANDS } from '~/types/project';

const props = defineProps<{
  label: string;
  value: string;
  hideLabel?: boolean;
  opaque?: boolean;
}>();
const emit = defineEmits<{ change: [color: string] }>();
const { t } = useLocalization();
const errorId = useId();
const draft = ref(props.value);
const invalid = ref(false);
const presets = ['#000000', '#FFFFFF', ...DEFAULT_COUNTDOWN_COLOR_BANDS.map(band => band.color),
  '#00CCFF', '#315FCF', '#9900FF'];
const currentColor = computed(() => readHexColor(props.value, !!props.opaque));

function readHexColor(value: string, opaque: boolean): string | null {
  const digits = value.trim().replace(/^#/, '').toUpperCase();
  const lengths = opaque ? [3, 6] : [3, 4, 6, 8];
  if (!lengths.includes(digits.length) || !/^[0-9A-F]+$/.test(digits)) return null;
  return '#' + (digits.length < 5 ? digits.replace(/./g, '$&$&') : digits);
}

function applyColor(value: string) {
  const color = readHexColor(value, !!props.opaque);
  invalid.value = color === null;
  if (color === null) return;
  draft.value = color;
  emit('change', color);
}

function resetDraft() {
  draft.value = props.value;
  invalid.value = false;
}

function resetClosedDraft(event: Event) {
  if (!(event.currentTarget as HTMLDetailsElement).open) resetDraft();
}

watch(() => props.value, resetDraft);
</script>

<style scoped>
.inline-color-picker { min-width: 0; color: var(--color-text-primary); }
.inline-color-picker summary {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: var(--settings-control-height);
  padding-inline: 5px;
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background: var(--color-control);
  font-size: 12px;
  cursor: pointer;
  list-style: none;
}
.inline-color-picker summary::-webkit-details-marker { display: none; }
.inline-color-picker summary:hover,
.inline-color-picker[open] summary { border-color: var(--color-border-strong); }
.inline-color-label { flex: 1; min-width: 0; }
.inline-color-value { font: 11px var(--font-mono); }
.inline-color-chip,
.inline-color-presets button {
  flex: none;
  width: 16px;
  height: 16px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--control-radius);
}
.inline-color-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 5px 2px;
}
.inline-color-presets button { padding: 0; }
.inline-color-presets button[aria-pressed="true"] {
  outline: 1px solid var(--color-text-primary);
  outline-offset: 1px;
}
.inline-color-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 2px;
}
.inline-color-form input,
.inline-color-form button {
  min-width: 0;
  height: var(--settings-control-height);
  padding-inline: 3px;
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background: var(--color-control);
  color: var(--color-text-primary);
}
.inline-color-form input { width: 100%; font: 11px var(--font-mono); }
.inline-color-form button { display: grid; place-items: center; }
.inline-color-form button span { font-size: 14px; }
.inline-color-form button:hover { background: var(--color-surface-hover); }
.inline-color-form input[aria-invalid="true"] { border-color: var(--color-danger); }
.inline-color-error {
  margin: 4px 0 0;
  color: var(--color-danger);
  font-size: 11px;
  line-height: 1.3;
}
</style>
