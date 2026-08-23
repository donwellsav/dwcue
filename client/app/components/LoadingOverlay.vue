<template>
  <div v-if="visible" class="loading-overlay">
    <div class="loading-panel">
      <img
        :src="isDark ? './assets/icons/SVG/app_icon_darkmode@web.svg' : './assets/icons/SVG/app_icon_lightmode@web.svg'"
        alt="DonWells Cue"
        class="loading-logo"
      />
      <div class="spinner">
        <div class="spinner-ring"></div>
      </div>
      <div class="loading-text">
        <h2>{{ title || t('common.loading') }}</h2>
        <p v-if="subtitle" class="loading-subtitle">{{ subtitle }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  visible: boolean;
  title?: string;
  subtitle?: string;
}>();

const { t } = useLocalization();

const theme = useState('theme', () => 'dark');
const isDark = computed(() => theme.value === 'dark');
</script>

<style scoped>
.loading-overlay {
  position: fixed;
  inset: 0;
  background: var(--dialog-backdrop);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
}

.loading-logo {
  width: 56px;
  height: 56px;
  object-fit: contain;
}

.loading-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  padding: 28px 36px;
  background: var(--dialog-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--dialog-radius);
  color: var(--color-text-primary);
  box-shadow: var(--dialog-shadow);
  min-width: 260px;
}

.spinner {
  width: 48px;
  height: 48px;
  position: relative;
}
.spinner-ring {
  width: 100%;
  height: 100%;
  border: 4px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.85s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

.loading-text {
  text-align: center;
}
.loading-text h2 {
  margin: 0;
  font-size: 16px;
  color: var(--color-text-primary);
}
.loading-subtitle {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--color-text-secondary);
}
</style>
