<template>
  <!-- Shared About content: shown standalone in AboutModal (Help menu) and
       embedded as the About tab in Project Settings. Keep credits, license
       text and links in this ONE place so the two surfaces never drift. -->
  <div class="about-content">
    <div class="about-header">
      <img
        :src="isDark ? './assets/icons/SVG/app_icon_darkmode@web.svg' : './assets/icons/SVG/app_icon_lightmode@web.svg'"
        alt="DonWells Cue"
        class="about-logo"
      />
      <div class="about-text">
        <h1 class="about-title">
          DonWells Cue
          <span class="version-badge">v{{ appVersion }}</span>
        </h1>
        <p class="about-subtitle">{{ t('welcome.subtitle') }}</p>
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
      <div v-if="update.downloading" class="about-update-actions">
        <progress :value="update.percent" max="100" :aria-label="t('update.downloading')"></progress>
        <span>{{ t('update.downloading') }} {{ Math.round(update.percent) }}%</span>
      </div>
      <p v-if="update.downloaded && !canInstallNow">{{ t('update.stopBeforeInstall') }}</p>
      <p v-if="update.installOnExit" role="status">{{ t('update.installScheduled') }}</p>
      <p v-if="update.error" role="status">{{ update.error }}</p>
    </section>

    <div class="about-info">
      <div class="info-section">
        <p class="developer">© 2026 Don Wells</p>
        <p class="original-credit">
          Forked from
          <a href="https://github.com/tdoukinitsas/liveplay" class="translator-link"
             @click.prevent="openExternal('https://github.com/tdoukinitsas/liveplay')">LivePlay</a>
          in July 2026. Original LivePlay software © Thomas Doukinitsas and contributors.
        </p>
        <p class="original-credit">
          {{ t('testCard.cardType') }}:
          <a href="https://github.com/Alteka/Kards" class="translator-link"
             @click.prevent="openExternal('https://github.com/Alteka/Kards')">Alteka Kards</a>
          · GPL-3.0-only
        </p>
        <!-- AGPL-3.0-only compliance: state the license and where the
             complete corresponding source lives. The clickable affordances
             are in the links section right below. -->
        <p class="license-note">{{ t('about.licenseText') }}</p>
        <p class="license-note">{{ t('about.distributionText') }}</p>
        <p class="license-note">{{ t('about.sourceText') }}</p>
      </div>

      <div class="info-section links">
        <a
          href="https://dwcue.com"
          class="info-link"
          @click.prevent="openExternal('https://dwcue.com')"
        >
          <span class="material-symbols-rounded">language</span>
          <span>dwcue.com</span>
        </a>

        <a
          href="https://github.com/donwellsav/dwcue"
          class="info-link"
          @click.prevent="openExternal('https://github.com/donwellsav/dwcue')"
        >
          <span class="material-symbols-rounded">code</span>
          <span>{{ t('about.githubRepo') }}</span>
        </a>

        <a
          href="https://www.gnu.org/licenses/agpl-3.0.en.html"
          class="info-link"
          @click.prevent="openExternal('https://www.gnu.org/licenses/agpl-3.0.en.html')"
        >
          <span class="material-symbols-rounded">description</span>
          <span>{{ t('about.license') }}</span>
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
const appVersion = ref('2.6.21');
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

<style scoped lang="scss">
.about-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-lg);
  margin-bottom: var(--spacing-xl);
  padding-bottom: var(--spacing-xl);
  border-bottom: 1px solid var(--color-border);
}

.about-logo {
  width: 64px;
  height: 64px;
  object-fit: contain;
  flex-shrink: 0;
}

.about-text {
  flex: 1;
  min-width: 0;
}

.about-title {
  font-size: 36px;
  font-weight: 600;
  margin: 0 0 var(--spacing-xs) 0;
  color: var(--color-text-primary);
  letter-spacing: -1px;
  line-height: 1;
  display: flex;
  align-items: baseline;
  gap: var(--spacing-sm);
  flex-wrap: wrap;
}

.version-badge {
  font-size: 14px;
  font-weight: 400;
  color: var(--color-text-secondary);
  opacity: 0.6;
  letter-spacing: 0;
}

.about-subtitle {
  font-size: 16px;
  color: var(--color-text-secondary);
  margin: 0;
  line-height: 1.4;
}

.about-updates {
  padding: var(--spacing-sm) 0;
  margin-bottom: var(--spacing-lg);
  border-bottom: 1px solid var(--color-border);
  font-size: 13px;
}
.about-update-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-sm);
}
.about-update-actions strong {
  color: var(--state-up-next);
}
.about-updates p {
  margin: var(--spacing-sm) 0 0;
}

.about-info {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
}

.original-credit {
  color: var(--color-text-secondary);
  font-size: 12px;
}

.license-note {
  color: var(--color-text-secondary);
  font-size: 12px;
  margin: 0;
  line-height: 1.5;
}

.info-section {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.developer {
  margin: 0;
  color: var(--color-text-primary);
  font-size: 14px;
}

.translator-link {
  color: var(--color-accent);
  text-decoration: none;
  transition: opacity var(--transition-fast);

  &:hover {
    opacity: 0.7;
    text-decoration: underline;
  }
}

.links {
  gap: var(--spacing-xs);
}

.info-link {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  background-color: var(--color-background);
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-md);
  color: var(--color-text-primary);
  text-decoration: none;
  font-size: 14px;
  transition: all var(--transition-fast);

  &:hover {
    background-color: var(--color-surface-hover);
    border-color: var(--color-accent);
    color: var(--color-accent);
  }

  .material-symbols-rounded {
    font-size: 20px;
  }
}
</style>
