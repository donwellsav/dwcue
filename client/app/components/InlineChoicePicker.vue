<template>
  <details ref="picker" class="inline-choice-picker" name="inline-choice-picker">
    <summary :aria-label="selectedLabel ? `${label} ${selectedLabel}` : label"
      :aria-disabled="disabled || undefined" :tabindex="disabled ? -1 : undefined" @click="guardDisabled">
      <span>{{ selectedLabel }}</span>
      <span class="material-symbols-rounded" aria-hidden="true">{{ disabled ? 'remove' : 'expand_more' }}</span>
    </summary>
    <div class="inline-choice-options" role="group" :aria-label="label">
      <button v-for="option in options" :key="option.value" type="button" :disabled="disabled || option.disabled"
        :aria-pressed="option.value === value" @click="choose(option.value)">
        {{ option.label }}
      </button>
    </div>
  </details>
</template>

<script setup lang="ts" generic="T extends string">
const props = defineProps<{
  label: string;
  value: T;
  options: readonly { value: T; label: string; disabled?: boolean }[];
  disabled?: boolean;
}>();
const emit = defineEmits<{ change: [value: T] }>();
const picker = ref<HTMLDetailsElement>();
const selectedLabel = computed(() => props.options.find(option => option.value === props.value)?.label);

function guardDisabled(event: MouseEvent) {
  if (props.disabled) event.preventDefault();
}

function choose(value: T) {
  if (picker.value) {
    picker.value.open = false;
    picker.value.querySelector('summary')?.focus({ preventScroll: true });
  }
  if (value !== props.value) emit('change', value);
}
</script>

<style scoped>
.inline-choice-picker { min-width: 0; }
.inline-choice-picker summary,
.inline-choice-picker button {
  min-height: var(--settings-control-height);
  padding: 2px 5px;
  color: var(--color-text-primary);
  background: var(--color-control);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  font-size: var(--type-metadata-size);
  line-height: 1.25;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.inline-choice-picker summary {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 4px;
  list-style: none;
}
.inline-choice-picker summary::-webkit-details-marker { display: none; }
.inline-choice-picker .material-symbols-rounded { flex: none; font-size: 16px; }
.inline-choice-picker[open] .material-symbols-rounded { transform: rotate(180deg); }
.inline-choice-picker summary:hover,
.inline-choice-picker button:hover { border-color: var(--color-border-strong); }
.inline-choice-picker :is(summary, button):focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
.inline-choice-picker [aria-disabled='true'],
.inline-choice-picker button:disabled { cursor: default; opacity: .6; }
.inline-choice-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 8rem), 1fr));
  gap: 3px;
  margin-top: 3px;
}
.inline-choice-options button { text-align: start; }
.inline-choice-options [aria-pressed='true'] { border-color: var(--color-accent); }
</style>
