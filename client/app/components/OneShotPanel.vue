<template>
  <section class="one-shot-panel" :class="{ 'show-mode': showMode }" aria-labelledby="one-shot-title">
    <header class="one-shot-header workspace-panel-header">
      <div class="workspace-panel-header__leading">
        <slot name="header-leading" />
        <div class="one-shot-header__copy">
          <h2 id="one-shot-title" class="workspace-panel-header__title">{{ t('oneShots.title') }}</h2>
          <span v-if="!showMode" class="one-shot-header__hint">{{ t('oneShots.hint') }}</span>
        </div>
      </div>
      <div class="one-shot-header__actions">
        <Btn
          v-if="!isDetachedWindow"
          icon="open_in_new"
          :text="t('oneShots.detach')"
          :disabled="!currentProject"
          @click="handleDetach"
        />
        <Btn
          v-else
          icon="picture_in_picture_alt"
          :text="t('oneShots.attach')"
          @click="handleAttach"
        />
      </div>
    </header>

    <div v-if="oneShots.length" class="one-shot-grid" :style="oneShotGridStyle">
      <OneShotTile
        v-for="(item, index) in oneShots"
        :key="item.uuid"
        :item="item"
        :position="index"
      />
    </div>
    <div v-else class="one-shot-empty">
      <span class="material-symbols-rounded" aria-hidden="true">bolt</span>
      <strong>{{ t('oneShots.emptyTitle') }}</strong>
      <span>{{ t('oneShots.emptyBody') }}</span>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { CartGridProfile } from '~/composables/useUiMode';
import { flattenOneShots } from '~/utils/oneShots';
import Btn from './Btn.vue';

const props = defineProps<{ isDetachedWindow?: boolean }>();
const { currentProject } = useProject();
const { uiMode, cartGridLayouts } = useUiMode();
const { t } = useLocalization();
const { mount: mountHotkeys, unmount: unmountHotkeys } = useCartHotkeys();
const { mount: mountMidi, unmount: unmountMidi } = useMidiController();

const showMode = computed(() => uiMode.value === 'playback');
const oneShots = computed(() => flattenOneShots(currentProject.value?.items ?? []));
const GRID_GAP_PX = 8;
const gridProfile = computed<CartGridProfile>(() => {
  if (props.isDetachedWindow) return showMode.value ? 'detachedShow' : 'detachedRegular';
  return showMode.value ? 'attachedShow' : 'attachedRegular';
});
const oneShotGridStyle = computed(() => {
  const layout = cartGridLayouts.value[gridProfile.value];
  const rowPercent = 100 / layout.rows;
  const rowGapOffset = GRID_GAP_PX * (layout.rows - 1) / layout.rows;
  return {
    '--one-shot-columns': String(layout.columns),
    '--one-shot-row-height': `max(${layout.minHeight}px, calc(${rowPercent}% - ${rowGapOffset}px))`,
  };
});

const handleDetach = () => {
  if (!currentProject.value || !import.meta.client || !window.electronAPI) return;
  window.electronAPI.openCartPlayerWindow(currentProject.value.folderPath);
};

const handleAttach = () => {
  if (!import.meta.client || !window.electronAPI) return;
  window.electronAPI.attachCartPlayerWindow();
};

onMounted(() => {
  mountHotkeys();
  mountMidi();
});

onUnmounted(() => {
  unmountHotkeys();
  unmountMidi();
});
</script>

<style scoped>
.one-shot-panel {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-background);
}

.one-shot-header__copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.one-shot-header__hint {
  overflow: hidden;
  color: var(--color-text-tertiary);
  font-size: var(--type-status-size);
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.one-shot-header__actions {
  margin-left: auto;
  flex: 0 0 auto;
}

.one-shot-grid {
  min-height: 0;
  flex: 1;
  display: grid;
  grid-template-columns: repeat(var(--one-shot-columns, 2), minmax(0, 1fr));
  grid-auto-rows: var(--one-shot-row-height, 106px);
  align-content: start;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm);
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.one-shot-empty {
  min-height: 0;
  flex: 1;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-lg);
  color: var(--color-text-tertiary);
  text-align: center;
}

.one-shot-empty .material-symbols-rounded {
  font-size: 30px;
  color: var(--color-text-secondary);
}

.one-shot-empty strong {
  color: var(--color-text-primary);
}
</style>
