<template>
  <div
    class="volume-slider"
    :class="{ 'volume-slider--inline': inlineScale }"
    :title="title"
  >
    <CanvasFader
      :db="db"
      :min-db="minDb"
      :max-db="maxDb"
      :label="title"
      @input="$emit('input', $event)"
      @reset="$emit('reset')"
    />
    <div class="volume-slider__label-wrap">
      <span
        v-if="!isEditing"
        class="volume-slider__label"
        :title="t('actions.clickToEdit')"
        @click="startEdit"
      >
        <span class="volume-slider__value">{{ formatLabel(db) }}</span>
        <span class="volume-slider__unit" aria-hidden="true">dB</span>
      </span>
      <input
        v-else
        ref="inputRef"
        type="number"
        class="volume-slider__input"
        v-model.number="editValue"
        step="0.1"
        @blur="commitEdit"
        @keyup.enter="commitEdit"
        @keyup.escape="cancelEdit"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import CanvasFader from './CanvasFader.vue';

const props = withDefaults(defineProps<{
  db: number;
  minDb?: number;
  maxDb?: number;
  title?: string;
  inlineScale?: boolean;
}>(), {
  minDb: -60,
  maxDb: 6,
  inlineScale: false,
});

const emit = defineEmits<{
  (e: 'input', db: number): void;
  (e: 'reset'): void;
}>();

const { t } = useLocalization();

const isEditing = ref(false);
const editValue = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);

function formatLabel(db: number): string {
  if (db <= -60) return '−∞';
  if (db === 0) return '0';
  return (db > 0 ? '+' : '') + db.toFixed(db % 1 === 0 ? 0 : 1);
}

function startEdit() {
  editValue.value = Number(Math.max(props.minDb, props.db).toFixed(1));
  isEditing.value = true;
  nextTick(() => {
    if (inputRef.value) {
      inputRef.value.focus();
      inputRef.value.select();
    }
  });
}

function commitEdit() {
  if (!isEditing.value) return;
  let val = Number(editValue.value);
  if (isNaN(val)) val = 0;
  val = Math.max(props.minDb, Math.min(props.maxDb, val));
  emit('input', val);
  isEditing.value = false;
}

function cancelEdit() {
  isEditing.value = false;
}
</script>

<style scoped>
.volume-slider {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 64px;
  padding: 2px 0;
}

.volume-slider--inline {
  display: contents;
}

.volume-slider--inline :deep(.canvas-fader) {
  grid-column: 3;
  grid-row: 2;
  z-index: 1;
  justify-self: center;
  width: 48px;
  height: 100%;
}

.volume-slider--inline .volume-slider__label-wrap {
  grid-column: 3;
  grid-row: 3;
  z-index: 1;
  justify-self: end;
  height: 20px;
  width: 64px;
}

.volume-slider--inline .volume-slider__label {
  width: 64px;
  padding: 2px 4px;
}

.volume-slider--inline .volume-slider__input {
  right: 0;
  left: auto;
  transform: none;
  box-sizing: border-box;
  width: 64px;
  height: 20px;
  padding: 0 4px;
  text-align: right;
}

.volume-slider__label-wrap {
  position: relative;
  height: 24px;
  width: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
}

.volume-slider__label {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 3px;
  min-width: 64px;
  padding: 3px 4px;
  box-sizing: border-box;
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-sm);
  background: var(--color-control);
  color: var(--color-text-primary);
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  cursor: text;
  user-select: none;
}

.volume-slider__value {
  min-width: 0;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.volume-slider__unit {
  color: var(--color-text-secondary);
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
  white-space: nowrap;
}

.volume-slider__input {
  position: absolute;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--z-index-dropdown, 1000);
  width: 56px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--color-accent);
  border-radius: var(--border-radius-sm);
  outline: none;
  background: var(--color-control);
  color: var(--color-text-primary);
  font-family: var(--font-mono, monospace);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.volume-slider__input::-webkit-inner-spin-button,
.volume-slider__input::-webkit-outer-spin-button {
  appearance: none;
  margin: 0;
}
</style>
