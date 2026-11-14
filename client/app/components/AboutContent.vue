<template>
  <div class="about-content">
    <div class="about-overview">
      <div class="about-identity">
        <img
          :src="isDark ? './assets/icons/SVG/app_icon_darkmode@web.svg' : './assets/icons/SVG/app_icon_lightmode@web.svg'"
          alt=""
          class="about-logo"
        />
        <div>
          <h3 class="about-title">DonWells Cue <span class="version-badge">v{{ appVersion }}</span></h3>
          <p class="about-copyright">© 2026 Don Wells</p>
        </div>
      </div>

      <section v-if="canCheckForUpdates" class="about-updates" :aria-label="t('update.updateAvailable')">
        <div class="about-update-actions">
          <strong v-if="update.version">{{ t('update.headerAvailable', { version: update.version }) }}</strong>
          <Btn v-if="update.version && !update.downloaded && !update.downloading && update.installSupported"
            :text="t('update.download')" :disabled="update.checking" @click="downloadUpdate" />
          <Btn v-if="update.version && !update.installSupported" :text="t('update.goToDownloadPage')"
            @click="openExternal('https://dwcue.com/downloads')" />
          <template v-if="update.downloaded">
            <Btn :text="t('update.installNow')" :disabled="!canInstallNow || installing"
              @click="installUpdate" />
            <Btn :text="t(update.installOnExit ? 'update.cancelInstallOnExit' : 'update.installOnExit')"
              @click="update.installOnExit = !update.installOnExit" />
          </template>
          <Btn :text="t(update.checking ? 'update.checking' : 'menu.checkForUpdates')"
            :disabled="update.checking || update.downloading" @click="checkForAppUpdate" />
        </div>
        <div v-if="update.downloading" class="about-progress">
          <progress :value="update.percent" max="100" :aria-label="t('update.downloading')"></progress>
          <span>{{ t('update.downloading') }} {{ Math.round(update.percent) }}%</span>
        </div>
        <p v-if="update.downloaded && !canInstallNow">{{ t('update.stopBeforeInstall') }}</p>
        <p v-if="update.installOnExit" role="status">{{ t('update.installScheduled') }}</p>
        <p v-if="update.error" role="status">{{ update.error }}</p>
      </section>
    </div>

    <div class="about-resources">
      <div class="about-notices">
        <p>
          Forked from
          <a href="https://github.com/tdoukinitsas/liveplay"
             @click.prevent="openExternal('https://github.com/tdoukinitsas/liveplay')">LivePlay</a>
          in July 2026. Original LivePlay software © Thomas Doukinitsas and contributors.
        </p>
        <p>
          {{ t('testCard.cardType') }}:
          <a href="https://github.com/Alteka/Kards"
             @click.prevent="openExternal('https://github.com/Alteka/Kards')">Alteka Kards</a>
          · GPL-3.0-only
        </p>
        <p>{{ t('about.licenseText') }}</p>
        <p>{{ t('about.distributionText') }}</p>
        <p>{{ t('about.sourceText') }}</p>
      </div>

      <div class="about-links">
        <a href="https://dwcue.com" @click.prevent="openExternal('https://dwcue.com')">
          <span class="material-symbols-rounded" aria-hidden="true">language</span>
          dwcue.com
        </a>
        <a href="https://github.com/donwellsav/dwcue"
           @click.prevent="openExternal('https://github.com/donwellsav/dwcue')">
          <span class="material-symbols-rounded" aria-hidden="true">code</span>
          {{ t('about.githubRepo') }}
        </a>
        <a href="https://www.gnu.org/licenses/agpl-3.0.en.html"
           @click.prevent="openExternal('https://www.gnu.org/licenses/agpl-3.0.en.html')">
          <span class="material-symbols-rounded" aria-hidden="true">description</span>
          {{ t('about.license') }}
        </a>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const { t } = useLocalization();

const { update, checkForAppUpdate } = useAppUpdate();
const { activeCues, previewItemUuid, confirmUnsavedChanges } = useProject();
const { uiMode } = useUiMode();
const canCheckForUpdates = import.meta.client && typeof window.electronAPI?.checkForUpdates === 'function';
const canInstallNow = computed(() => uiMode.value !== 'playback' && activeCues.value.size === 0 && !previewItemUuid.value);
const installing = ref(false);

async function downloadUpdate() {
  const api = window.electronAPI;
  if (!update.version || !update.installSupported || update.checking || update.downloading || update.downloaded) return;
  update.downloading = true;
  update.percent = 0;
  update.error = '';
  try {
    const result = await api.downloadUpdate();
    if (!result.success) throw new Error(result.error || t('update.downloadFailed'));
    update.downloaded = true;
  } catch (error) {
    update.error = error instanceof Error ? error.message : t('update.downloadFailed');
  } finally {
    update.downloading = false;
  }
}

async function installUpdate() {
  if (!update.downloaded || !canInstallNow.value || installing.value) return;
  installing.value = true;
  update.error = '';
  try {
    if (await confirmUnsavedChanges() && canInstallNow.value &&
        !await window.electronAPI.installUpdate()) update.error = t('update.installFailed');
  } catch (error) {
    update.error = error instanceof Error ? error.message : t('update.installFailed');
  } finally {
    installing.value = false;
  }
}

// Get app version
const appVersion = ref('2.6.22');
onMounted(async () => {
  if (import.meta.client && window.electronAPI?.getAppVersion) {
    appVersion.value = await window.electronAPI.getAppVersion();
  }
});

// Get theme from app state
const theme = useState('theme', () => 'dark');
const isDark = computed(() => theme.value === 'dark');

const openExternal = (url: string) => {
  if (import.meta.client && window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(url);
  }
};

</script>

<style scoped>
.about-content {
  max-width: 1120px;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
}

.about-overview,
.about-resources {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--spacing-xs) var(--spacing-md);
  padding: var(--spacing-xs) var(--spacing-sm);
}

.about-overview {
  align-items: center;
}

.about-identity {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.about-logo {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
}

.about-title {
  font-size: 17px;
  font-weight: 650;
  line-height: 1.2;
}

.version-badge {
  margin-inline-start: var(--spacing-xs);
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 400;
}

.about-copyright,
.about-updates p,
.about-notices p {
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.4;
}

.about-updates {
  min-width: 0;
  max-width: 100%;
  font-size: 12px;
}

.about-update-actions,
.about-progress,
.about-links {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-xs) var(--spacing-sm);
}

.about-update-actions strong {
  color: var(--state-up-next);
}

.about-progress,
.about-updates p {
  margin-block-start: var(--spacing-xs);
}

.about-updates p {
  overflow-wrap: anywhere;
}

.about-progress progress {
  accent-color: var(--color-accent);
}

.about-resources {
  border-top: 1px solid var(--color-border);
  font-size: 12px;
}

.about-links a {
  color: var(--color-text-primary);
  padding: var(--spacing-xs);
}

.about-links a {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  text-decoration: none;
}

.about-links {
  align-content: start;
}

.about-links .material-symbols-rounded {
  font-size: 16px;
}

.about-links a:hover {
  background: var(--color-surface-hover);
}

.about-notices {
  display: grid;
  gap: var(--spacing-xs);
  flex: 1 1 570px;
  min-width: 0;
  padding-block: var(--spacing-xs);
}

.about-notices a {
  color: var(--color-accent);
}

.about-content--docked { max-width: none; }

.about-content--docked .about-resources {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 1fr);
  gap: var(--spacing-sm);
}

.about-content--docked .about-links {
  display: grid;
  gap: 0;
}

.about-content--docked .about-links a {
  min-height: var(--settings-row-height);
  border-bottom: 1px solid var(--color-border);
}

@container (max-width: 740px) {
  .about-content--docked .about-resources { grid-template-columns: minmax(0, 1fr); }
}
</style>
