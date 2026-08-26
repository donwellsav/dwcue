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

    <div class="about-info">
      <div class="info-section">
        <p class="developer">
          © {{ new Date().getFullYear() }}
          <a
            href="https://dwcue.com"
            class="translator-link"
            @click.prevent="openExternal('https://dwcue.com')"
          ><strong>Don Wells</strong></a>
        </p>
        <p class="original-credit">
          Original software © Thomas Doukinitsas and contributors.
        </p>
        <p class="translator" v-if="t('translationContributor.name')">
          <strong>{{ t('translationContributor.title') }}: </strong>
          <a
            :href="formatContributorLink(t('translationContributor.contributeLink'))"
            class="translator-link"
            @click.prevent="handleContributorLinkClick(t('translationContributor.contributeLink'))"
          >
            {{ t('translationContributor.name') }}
          </a>
        </p>
        <p class="translator" v-if="contributors.length">
          <strong>{{ t('about.contributors') }}: </strong>
          <template v-for="(contributor, index) in contributors" :key="contributor.name">
            <a
              :href="contributor.link"
              class="translator-link"
              @click.prevent="openExternal(contributor.link)"
            >{{ contributor.name }}</a><template v-if="index < contributors.length - 1">, </template>
          </template>
        </p>
        <!-- AGPL-3.0-only compliance: state the license and where the
             complete corresponding source lives. The clickable affordances
             are in the links section right below. -->
        <p class="license-note">{{ t('about.licenseText') }}</p>
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
          <span>AGPL-3.0-only License</span>
        </a>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import contributorsJson from '~~/assets/json/contributors.json';

const { t } = useLocalization();

const contributors = computed(() =>
  Object.values(contributorsJson.contributors) as { name: string; link: string }[]
);

// Get app version
const appVersion = ref('2.6.8');
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

// Format contributor link to handle different types (website, email, phone)
const formatContributorLink = (link: string): string => {
  if (!link) return '#';

  // If it's an email
  if (link.includes('@') && !link.startsWith('mailto:')) {
    return `mailto:${link}`;
  }

  // If it's a phone number (starts with + or contains only numbers and spaces/dashes)
  if (link.match(/^[\+\d\s\-\(\)]+$/)) {
    return `tel:${link.replace(/\s/g, '')}`;
  }

  // If it's a URL without protocol, add https://
  if (!link.startsWith('http://') && !link.startsWith('https://') && !link.startsWith('mailto:') && !link.startsWith('tel:')) {
    return `https://${link}`;
  }

  return link;
};

// Handle contributor link click
const handleContributorLinkClick = (link: string) => {
  const formattedLink = formatContributorLink(link);

  // For email or tel links, use default behavior, otherwise use openExternal
  if (formattedLink.startsWith('mailto:') || formattedLink.startsWith('tel:')) {
    window.location.href = formattedLink;
  } else {
    openExternal(formattedLink);
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

  strong {
    font-weight: 600;
  }
}

.translator {
  margin: 0;
  color: var(--color-text-primary);
  font-size: 14px;

  strong {
    font-weight: 600;
  }
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
