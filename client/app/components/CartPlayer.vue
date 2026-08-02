<template>
  <div class="cart-player" :class="{ 'show-mode': showMode }" :style="cartGridStyle">
    <div class="cart-header workspace-panel-header">
      <div class="workspace-panel-header__leading">
        <slot name="header-leading" />
        <div class="cart-header__copy">
          <h2 class="workspace-panel-header__title">{{ t('cart.title') }}</h2>
          <span v-if="!showMode" id="cart-load-hint" class="cart-header__hint">
            {{ t('cart.clickToImport') }}
          </span>
        </div>
      </div>
      <div class="cart-header-actions">
        <Btn
          v-if="!isDetachedWindow"
          icon="open_in_new"
          :text="t('cart.detach')"
          :disabled="!currentProject"
          @click="handleDetach"
        />
        <Btn
          v-else
          icon="picture_in_picture_alt"
          :text="t('cart.attach')"
          @click="handleAttach"
        />
      </div>
    </div>

    <div class="cart-grid">
      <CartSlot
        v-for="slot in cartSlotCount"
        :key="slot"
        :slot="slot - 1"
        :max-slot="cartSlotCount - 1"
        :item="getCartItem(slot - 1)"
        :keyLabel="getKeyLabel(slot - 1)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { normalizeCartSlotCount, type AudioItem } from '~/types/project';
import type { CartGridProfile } from '~/composables/useUiMode';
import { formatKeyLabel } from '~/composables/useCartHotkeys';
import Btn from './Btn.vue';

const props = defineProps<{
  isDetachedWindow?: boolean;
}>();

const { currentProject, requestDeleteFromKeyboard } = useProject();
const { getCartItem } = useCartItems();
const { keyMappings, mount: mountHotkeys, unmount: unmountHotkeys } = useCartHotkeys();
const { mount: mountMidi, unmount: unmountMidi } = useMidiController();
const { t } = useLocalization();
const { uiMode, cartGridLayouts } = useUiMode();
const showMode = computed(() => uiMode.value === 'playback');
const cartSlotCount = computed(() => normalizeCartSlotCount(
  currentProject.value?.settings?.cartSlotCount,
  currentProject.value?.cartItems ?? [],
  currentProject.value?.cartSlotKeys ?? {},
));
const CART_GRID_GAP_PX = 8; // Matches --spacing-sm used by .cart-grid.
const cartGridProfile = computed<CartGridProfile>(() => {
  if (props.isDetachedWindow) return showMode.value ? 'detachedShow' : 'detachedRegular';
  return showMode.value ? 'attachedShow' : 'attachedRegular';
});
const cartGridStyle = computed(() => {
  const layout = cartGridLayouts.value[cartGridProfile.value];
  const rowPercent = 100 / layout.rows;
  const rowGapOffset = CART_GRID_GAP_PX * (layout.rows - 1) / layout.rows;
  return {
    '--cart-columns': String(layout.columns),
    '--cart-card-row-height': `max(${layout.minHeight}px, calc(${rowPercent}% - ${rowGapOffset}px))`,
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

const getKeyLabel = (slotIndex: number): string => {
  const binding = keyMappings.value[slotIndex];
  return binding ? formatKeyLabel(binding) : '';
};

// In the detached cart window there's no MainWorkspace to own the global
// DEL key, so handle it here. (In the attached layout MainWorkspace already
// does — adding it there too would double-fire.)
const isTextInputFocused = (): boolean => {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || el.isContentEditable;
};
const handleCartKeydown = (e: KeyboardEvent) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  if (isTextInputFocused() || !currentProject.value) return;
  if (showMode.value) {
    e.preventDefault();
    return;
  }
  if (requestDeleteFromKeyboard()) e.preventDefault();
};

onMounted(() => {
  if (import.meta.client) {
    mountHotkeys();
    mountMidi();
    if (props.isDetachedWindow) window.addEventListener('keydown', handleCartKeydown);

    onUnmounted(() => {
      unmountHotkeys();
      unmountMidi();
      if (props.isDetachedWindow) window.removeEventListener('keydown', handleCartKeydown);
    });
  }
});
</script>

<style scoped>
.cart-player {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: var(--color-background);
}

.cart-header__copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.cart-header__hint {
  color: var(--color-text-tertiary);
  font-size: var(--type-status-size);
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cart-header-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  margin-left: auto;
  gap: var(--spacing-sm);
}

.cart-header,
.cart-grid {
  scrollbar-gutter: stable;
}

.cart-header {
  overflow-y: auto;
}

.cart-grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(var(--cart-columns, 2), minmax(0, 1fr));
  grid-auto-rows: var(--cart-card-row-height, 88px);
  gap: var(--spacing-sm);
  padding: var(--spacing-sm);
  overflow-y: auto;
  align-content: start;
}
</style>
