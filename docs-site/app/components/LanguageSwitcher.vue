<template>
  <div class="language-switcher">
    <button
      class="language-button"
      @click="toggleDropdown"
      :aria-label="t('common.changeLanguage')"
      :aria-expanded="isOpen"
    >
      <span class="current-locale">{{ locale }}</span>
      <span class="language-chevron" aria-hidden="true">⌄</span>
    </button>
    
    <div v-if="isOpen" class="language-dropdown">
      <button
        v-for="(name, code) in locales"
        :key="code"
        class="language-option"
        :class="{ active: locale === code }"
        @click="selectLocale(code)"
      >
        {{ name }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useI18n } from '../composables/useI18n';

const { t, locale, locales, setLocale } = useI18n();
const isOpen = ref(false);

const toggleDropdown = () => {
  isOpen.value = !isOpen.value;
};

const selectLocale = async (code: string) => {
  await setLocale(code);
  isOpen.value = false;
};

// Close dropdown when clicking outside
const handleClickOutside = (event: MouseEvent) => {
  const target = event.target as HTMLElement;
  if (!target.closest('.language-switcher')) {
    isOpen.value = false;
  }
};

onMounted(() => {
  document.addEventListener('click', handleClickOutside);
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
});
</script>

<style scoped lang="scss">
.language-switcher {
  position: relative;

  .language-button {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-height: 36px;
    padding: 0 10px;
    background: transparent;
    border: 1px solid rgba(21, 24, 29, 0.15);
    border-radius: 4px;
    color: #15181d;
    cursor: pointer;
    transition: background 0.16s ease, border-color 0.16s ease;
    font-size: 12px;

    &:hover {
      background: rgba(49, 95, 207, 0.08);
      border-color: #315fcf;
    }

    .language-chevron {
      color: #65707b;
      font-size: 15px;
      line-height: 1;
    }

    .current-locale {
      text-transform: uppercase;
      font-weight: 600;
      font: 600 10px/1 'IBM Plex Mono', ui-monospace, monospace;
      letter-spacing: 0.1em;
    }
  }

  .language-dropdown {
    position: absolute;
    top: calc(100% + 0.5rem);
    right: 0;
    background: #f3f1ec;
    border: 1px solid rgba(21, 24, 29, 0.18);
    border-radius: 4px;
    box-shadow: 8px 10px 0 rgba(21, 24, 29, 0.08), 0 12px 24px rgba(21, 24, 29, 0.12);
    min-width: 150px;
    overflow: hidden;
    z-index: 1000;

    .language-option {
      display: block;
      width: 100%;
      padding: 10px 12px;
      background: transparent;
      border: none;
      color: #65707b;
      cursor: pointer;
      transition: background 0.16s ease, color 0.16s ease;
      text-align: left;
      font-size: 12px;

      &:hover {
        background: rgba(49, 95, 207, 0.08);
        color: #15181d;
      }

      &.active {
        background: rgba(49, 95, 207, 0.1);
        color: #315fcf;
        font-weight: 600;
      }

      &:not(:last-child) {
        border-bottom: 1px solid rgba(21, 24, 29, 0.09);
      }
    }
  }
}

@media (max-width: 480px) {
  .language-switcher {
    .language-button {
      padding: 0 9px;

      .current-locale {
        font-size: 9px;
      }
    }
  }
}
</style>
