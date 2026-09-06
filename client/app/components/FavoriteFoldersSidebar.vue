<template>
  <aside class="favorite-folders" :aria-label="t('filePicker.favorites')">
    <div class="favorite-folders__heading">
      <span>{{ t('filePicker.favorites') }}</span>
      <button
        type="button"
        class="favorite-folders__add"
        :disabled="!currentPath || isCurrentFavorite"
        :title="t(isCurrentFavorite ? 'filePicker.currentFolderFavorite' : 'filePicker.addCurrentFolder')"
        :aria-label="t(isCurrentFavorite ? 'filePicker.currentFolderFavorite' : 'filePicker.addCurrentFolder')"
        @click="emit('add', currentPath)"
      >
        <span class="material-symbols-rounded" aria-hidden="true">add</span>
      </button>
    </div>

    <div v-if="favorites.length" class="favorite-folders__list">
      <div v-for="folder in favorites" :key="folder" class="favorite-folders__row">
        <button
          type="button"
          class="favorite-folders__folder"
          :class="{ active: normalizePickerPath(folder) === normalizePickerPath(currentPath) }"
          :title="folder"
          @click="emit('navigate', folder)"
        >
          <span class="material-symbols-rounded" aria-hidden="true">folder</span>
          <span>{{ folderLabel(folder) }}</span>
        </button>
        <button
          type="button"
          class="favorite-folders__remove"
          :title="t('filePicker.removeFavorite', { name: folderLabel(folder) })"
          :aria-label="t('filePicker.removeFavorite', { name: folderLabel(folder) })"
          @click="emit('remove', folder)"
        >
          <span class="material-symbols-rounded" aria-hidden="true">close</span>
        </button>
      </div>
    </div>
    <p v-else class="favorite-folders__empty">{{ t('filePicker.emptyFavorites') }}</p>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { normalizePickerPath } from '~/composables/useFilePickerLocations';

const props = defineProps<{
  favorites: string[];
  currentPath: string;
}>();
const { t } = useLocalization();

const emit = defineEmits<{
  (e: 'navigate', folder: string): void;
  (e: 'add', folder: string): void;
  (e: 'remove', folder: string): void;
}>();

const isCurrentFavorite = computed(() => {
  const current = normalizePickerPath(props.currentPath);
  return !!current && props.favorites.some(folder => normalizePickerPath(folder) === current);
});

function folderLabel(folder: string): string {
  const normalized = normalizePickerPath(folder);
  if (normalized === '/' || /^[A-Za-z]:[\\/]$/u.test(normalized)) return normalized;
  const parts = normalized.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) || normalized;
}
</script>

<style lang="scss" scoped>
.favorite-folders {
  width: 176px;
  min-width: 176px;
  min-height: 0;
  padding: 10px 8px;
  overflow: auto;
  background: var(--color-surface-raised);
  border-right: 1px solid var(--color-border);
  color: var(--color-text-secondary);
}

.favorite-folders__heading {
  min-height: 28px;
  padding: 0 4px 6px 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  color: var(--color-text-tertiary);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.favorite-folders__heading > span {
  min-width: 0;
  flex: 1;
  white-space: normal;
  overflow-wrap: anywhere;
}

.favorite-folders__add,
.favorite-folders__remove,
.favorite-folders__folder {
  border: 0;
  color: inherit;
  cursor: pointer;
}

.favorite-folders__add,
.favorite-folders__remove {
  width: 26px;
  height: 26px;
  padding: 0;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  border-radius: var(--control-radius);
  background: transparent;

  .material-symbols-rounded { font-size: 16px; }
  &:hover:not(:disabled) { background: var(--color-surface-hover); color: var(--color-text-primary); }
  &:disabled { cursor: default; opacity: 0.35; }
}

.favorite-folders__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.favorite-folders__row {
  display: flex;
  align-items: center;
  gap: 2px;
}

.favorite-folders__folder {
  min-width: 0;
  min-height: 32px;
  padding: 5px 8px;
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1;
  border-radius: var(--control-radius);
  background: transparent;
  text-align: left;

  .material-symbols-rounded { flex: 0 0 auto; font-size: 17px; color: var(--color-accent); }
  span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  &:hover { background: var(--color-surface-hover); color: var(--color-text-primary); }
  &.active { background: var(--color-control); color: var(--color-text-primary); }
}

.favorite-folders__remove {
  opacity: 0;
}
.favorite-folders__row:hover .favorite-folders__remove,
.favorite-folders__remove:focus-visible {
  opacity: 1;
}

.favorite-folders__empty {
  margin: 4px 8px;
  color: var(--color-text-tertiary);
  font-size: 11px;
  line-height: 1.4;
}
</style>
