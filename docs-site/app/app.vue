<template>
  <div class="site-shell" :dir="direction">
    <a class="skip-link" href="#main">Skip to content</a>

    <header class="site-header">
      <div class="wrap site-header__inner">
        <a class="brand" href="#top" aria-label="DonWells Cue home">
          <img :src="asset('assets/logo.svg')" alt="" class="brand__mark" />
          <span class="brand__name">DonWells Cue</span>
          <span class="brand__rule" aria-hidden="true"></span>
          <span class="brand__descriptor">LIVE AUDIO</span>
        </a>

        <nav class="site-nav" aria-label="Primary navigation">
          <a href="#workflow">Workflow</a>
          <a href="#one-shots">One Shots</a>
          <a href="#show-mode">Show Mode</a>
          <a href="#download">Downloads</a>
          <a href="#docs">Docs</a>
        </nav>

        <div class="site-header__actions">
          <LanguageSwitcher />
          <a class="button button--compact button--dark" href="#download">Download</a>
        </div>
      </div>
    </header>

    <main id="main">
      <section id="top" class="hero">
        <div class="wrap hero__grid">
          <div class="hero__copy">
            <p class="eyebrow"><span class="eyebrow__signal" aria-hidden="true"></span> DonWells Cue · v{{ version }}</p>
            <h1>Make the next cue feel inevitable.</h1>
            <p class="hero__lede">
              A calm, local-first playback surface for live shows. Prepare every detail, keep the live view legible, and fire the right sound without hunting for it.
            </p>
            <div class="hero__actions">
              <a class="button button--primary" href="#download">Get DonWells Cue <span aria-hidden="true">↗</span></a>
              <a class="text-link" href="#workflow">See how it works <span aria-hidden="true">↓</span></a>
            </div>
            <dl class="hero__facts">
              <div>
                <dt>01</dt>
                <dd>Prepare</dd>
              </div>
              <div>
                <dt>02</dt>
                <dd>Rehearse</dd>
              </div>
              <div>
                <dt>03</dt>
                <dd>Perform</dd>
              </div>
            </dl>
          </div>

          <div class="hero__visual" aria-label="DonWells Cue main workspace screenshot">
            <div class="product-frame">
              <div class="product-frame__bar">
                <span class="window-dots" aria-hidden="true"><i></i><i></i><i></i></span>
                <span class="product-frame__path">DONWELLS CUE / LIVE VIEW</span>
                <span class="product-frame__version">{{ version }}</span>
              </div>
              <div class="product-frame__image">
                <img
                  :src="asset('screenshots/donwells_cue_main.jpg')"
                  alt="DonWells Cue showing a color-coded playlist, One Shots grid, and output meters"
                />
              </div>
              <div class="product-frame__caption">
                <span>PLAYLIST · ONE SHOTS · OUTPUT</span>
                <span>LOCAL SESSION</span>
              </div>
            </div>
            <div class="hero__annotation hero__annotation--top">PLAYLIST WORKSPACE</div>
            <div class="hero__annotation hero__annotation--bottom">PROGRAM / MONITOR</div>
          </div>
        </div>
      </section>

      <section class="signal-band" aria-label="DonWells Cue product facts">
        <div class="wrap signal-band__grid">
          <div class="signal-band__item"><strong>Local-first</strong><span>Run the show on the machine you trust.</span></div>
          <div class="signal-band__item"><strong>Windows · macOS · Linux</strong><span>One workflow across the booth.</span></div>
          <div class="signal-band__item"><strong>AGPL-3.0</strong><span>Open source, built to be inspected.</span></div>
          <div class="signal-band__item"><strong>v{{ version }}</strong><span>Current packaged release.</span></div>
        </div>
      </section>

      <section id="workflow" class="section workflow-section">
        <div class="wrap">
          <div class="section-heading section-heading--split">
            <div>
              <p class="eyebrow">THE WORKFLOW</p>
              <h2>Three surfaces. One show.</h2>
            </div>
            <p>DonWells Cue keeps preparation, auditioning, and performance distinct so the live operator always sees the information that matters now.</p>
          </div>

          <div class="workflow-grid">
            <article v-for="(step, index) in workflowSteps" :key="step.title" class="workflow-card">
              <div class="workflow-card__top"><span>0{{ index + 1 }}</span><span class="workflow-card__mark" aria-hidden="true">↘</span></div>
              <h3>{{ step.title }}</h3>
              <p>{{ step.description }}</p>
              <span class="workflow-card__line" aria-hidden="true"></span>
            </article>
          </div>
        </div>
      </section>

      <section id="one-shots" class="feature-band feature-band--ink">
        <div class="wrap feature-band__grid">
          <div class="feature-band__media">
            <div class="media-frame">
              <span class="media-frame__label">01 / QUICK PLAY</span>
              <img
                :src="asset('screenshots/donwells_cue_one_shots.jpg')"
                alt="DonWells Cue One Shots panel with permanent cells ready for quick playback"
              />
            </div>
          </div>
          <div class="feature-band__copy">
            <p class="eyebrow eyebrow--light">ONE SHOTS</p>
            <h2>Keep the important sounds one touch away.</h2>
            <p>One Shots are a permanent quick-play surface for announcements, stings, effects, walk-ons, and beds. The cells stay in place whether they are full or empty, so the operator always knows where a sound lives.</p>
            <ul class="feature-list">
              <li><span>01</span> Drag a file or copy a playlist cue into a cell.</li>
              <li><span>02</span> Play the cell without changing the source playlist.</li>
              <li><span>03</span> Keep settings close, without crowding the live view.</li>
            </ul>
            <a class="text-link text-link--light" href="#docs">Read the workflow notes <span aria-hidden="true">→</span></a>
          </div>
        </div>
      </section>

      <section id="show-mode" class="feature-band feature-band--paper">
        <div class="wrap feature-band__grid feature-band__grid--reverse">
          <div class="feature-band__media">
            <div class="media-frame media-frame--light">
              <span class="media-frame__label">02 / PERFORMANCE VIEW</span>
              <img
                :src="asset('screenshots/donwells_cue_show_mode.jpg')"
                alt="DonWells Cue Show Mode with a simplified playlist and live output meters"
              />
            </div>
          </div>
          <div class="feature-band__copy feature-band__copy--paper">
            <p class="eyebrow">SHOW MODE</p>
            <h2>Less interface when the room is live.</h2>
            <p>Switch to a simplified, touch-friendly playback view for the performance. Current, next, transport, and output information remain clear while edit-only controls step out of the way.</p>
            <div class="feature-stat-row">
              <div><strong>Current</strong><span>what is on air</span></div>
              <div><strong>Next</strong><span>what is ready</span></div>
              <div><strong>Safe</strong><span>where the meters sit</span></div>
            </div>
            <a class="text-link" href="#download">Download the current release <span aria-hidden="true">→</span></a>
          </div>
        </div>
      </section>

      <section class="section safety-section">
        <div class="wrap safety-section__grid">
          <div class="section-heading">
            <p class="eyebrow">SIGNAL DISCIPLINE</p>
            <h2>See the risk before it reaches the room.</h2>
            <p>Properties gives the tech the detail needed before the show: peak and RMS waveform views, playheads, editable markers, fades, routing, normalization, and transport from the cue location.</p>
          </div>
          <div class="safety-card">
            <div class="safety-card__header"><span>WHAT IS IN THE APP</span><span>PROPERTIES / OUTPUT</span></div>
            <ul class="safety-card__list">
              <li><span>01</span><div><strong>Peak + RMS waveforms</strong><p>Inspect the cue before air, with the same track color used in the playlist.</p></div></li>
              <li><span>02</span><div><strong>Editable playheads and markers</strong><p>Set in, out, and next-at-marker locations from the waveform or exact time fields.</p></div></li>
              <li><span>03</span><div><strong>Normalization and true-peak protection</strong><p>Normalize to a chosen target, then keep the output ceiling visible while you work.</p></div></li>
              <li><span>04</span><div><strong>Program and Preview routing</strong><p>Audition privately, route the show deliberately, and keep both meter paths readable.</p></div></li>
            </ul>
            <a class="safety-card__link" href="https://github.com/donwellsav/dwcue#readme" target="_blank" rel="noopener noreferrer">Read the current workflow documentation <span aria-hidden="true">↗</span></a>
          </div>
        </div>
      </section>

      <section id="download" class="section download-section">
        <div class="wrap">
          <div class="section-heading section-heading--split section-heading--download">
            <div>
              <p class="eyebrow">INSTALL THE CURRENT BUILD</p>
              <h2>Choose your show machine.</h2>
            </div>
            <p v-if="detectedOS">We detected <strong>{{ detectedOSLabel }}</strong>. The matching build is highlighted, and every supported platform stays visible below.</p>
            <p v-else>Download the current packaged release for the platform you run at the show.</p>
          </div>

          <div class="download-grid">
            <a
              v-for="platform in platformCards"
              :key="platform.key"
              :href="downloadLinks[platform.key]"
              class="download-card"
              :class="{ 'download-card--recommended': platform.key === detectedOSKey }"
              target="_blank"
              rel="noopener noreferrer"
            >
              <div class="download-card__top"><span>{{ platform.index }}</span><span v-if="platform.key === detectedOSKey" class="download-card__badge">RECOMMENDED</span></div>
              <h3>{{ platform.title }}</h3>
              <p>{{ platform.description }}</p>
              <span class="download-card__action">{{ platform.action }} <span aria-hidden="true">↗</span></span>
              <span class="download-card__meta">{{ platform.meta }}</span>
            </a>
          </div>

          <div class="download-links">
            <span>Other formats</span>
            <a :href="downloadLinks.macArmZip" target="_blank" rel="noopener noreferrer">macOS .zip</a>
            <a :href="downloadLinks.deb" target="_blank" rel="noopener noreferrer">Linux .deb</a>
            <a :href="downloadLinks.rpm" target="_blank" rel="noopener noreferrer">Linux .rpm</a>
            <a href="https://github.com/donwellsav/dwcue/releases" target="_blank" rel="noopener noreferrer">All releases ↗</a>
          </div>

          <div class="install-note">
            <span class="install-note__mark" aria-hidden="true">!</span>
            <div><strong>Unsigned build notice.</strong> macOS may require <code>xattr -rd com.apple.quarantine</code> after installation; Windows may show SmartScreen until the installer has a signing reputation.</div>
          </div>
        </div>
      </section>

      <section id="docs" class="docs-section">
        <div class="wrap docs-section__grid">
          <div>
            <p class="eyebrow eyebrow--light">DOCUMENTATION</p>
            <h2>Build the show. Then trust the surface.</h2>
            <p class="docs-section__lede">The README is the source of truth for the current client/server workflow, packaging, network operation, and project setup.</p>
            <div class="docs-section__actions">
              <a class="button button--light" href="https://github.com/donwellsav/dwcue#readme" target="_blank" rel="noopener noreferrer">Read the README <span aria-hidden="true">↗</span></a>
              <a class="text-link text-link--light" href="https://github.com/donwellsav/dwcue" target="_blank" rel="noopener noreferrer">View source <span aria-hidden="true">↗</span></a>
            </div>
          </div>
          <div class="docs-checklist">
            <div class="docs-checklist__heading"><span>FIRST RUN</span><span>01—04</span></div>
            <ol>
              <li><span>01</span><p>Choose a project folder and let DonWells Cue create its media directory.</p></li>
              <li><span>02</span><p>Set the program output, target, and private Preview output in Project Settings.</p></li>
              <li><span>03</span><p>Prepare cue markers and fades in Properties; copy repeatable sounds to One Shots.</p></li>
              <li><span>04</span><p>Switch to Show Mode, verify the meters, and run the show.</p></li>
            </ol>
          </div>
        </div>
      </section>
    </main>

    <footer class="site-footer">
      <div class="wrap site-footer__inner">
        <div><strong>DonWells Cue</strong><span>Open-source audio playback for live events.</span></div>
        <div class="site-footer__links"><a href="https://github.com/donwellsav/dwcue" target="_blank" rel="noopener noreferrer">GitHub</a><a href="https://github.com/donwellsav/dwcue/blob/main/LICENCE.txt" target="_blank" rel="noopener noreferrer">AGPL-3.0</a><a href="#top">Back to top ↑</a></div>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from './composables/useI18n';

const { t, direction, initLocale, isLocaleLoaded } = useI18n();
const baseURL = useRuntimeConfig().app.baseURL;
const asset = (path: string) => `${baseURL}${path.replace(/^\/+/, '')}`;
const siteURL = baseURL === '/' ? 'https://dwcue.com/' : 'https://tdoukinitsas.github.io/liveplay/';

const version = ref('2.5.18');
const detectedOS = ref<string | null>(null);

const workflowSteps = [
  { title: 'Prepare in Properties', description: 'Shape the cue at its source: markers, fades, volume, routing, normalization, and transport from the exact location you need.' },
  { title: 'Audition on Preview', description: 'Listen privately without touching the program bus. Set the next cue, check the trim, and keep the show moving.' },
  { title: 'Perform in Show Mode', description: 'Reduce the surface to what matters live: current, next, transport, One Shots, and meters you can read at a glance.' }
];

type PlatformKey = 'windows' | 'macArm' | 'linux';
const osPlatformMap: Record<string, PlatformKey> = { windows: 'windows', mac: 'macArm', linux: 'linux' };

const detectOS = (): string | null => {
  if (typeof navigator === 'undefined') return null;
  const uaData = (navigator as any).userAgentData;
  const source = `${uaData?.platform ?? ''} ${navigator.userAgent ?? ''} ${(navigator as any).platform ?? ''}`.toLowerCase();
  if (source.includes('win')) return 'windows';
  if (source.includes('mac')) return 'mac';
  if (source.includes('linux') || source.includes('x11') || source.includes('android') || source.includes('chrome os')) return 'linux';
  return null;
};

const detectedOSKey = computed<PlatformKey | null>(() => detectedOS.value ? osPlatformMap[detectedOS.value] ?? null : null);
const detectedOSLabel = computed(() => detectedOS.value === 'mac' ? 'macOS Apple Silicon' : detectedOS.value === 'windows' ? 'Windows x64' : 'Linux x64');

const downloadLinks = computed<Record<string, string>>(() => {
  const v = version.value;
  const baseUrl = `https://github.com/donwellsav/dwcue/releases/download/v${v}`;
  return {
    windows: `${baseUrl}/DonWells-Cue-Setup-${v}.exe`,
    macArm: `${baseUrl}/DonWells-Cue-${v}-arm64.dmg`,
    linux: `${baseUrl}/DonWells-Cue-${v}-x86_64.AppImage`,
    deb: `${baseUrl}/DonWells-Cue-${v}-amd64.deb`,
    rpm: `${baseUrl}/DonWells-Cue-${v}-x86_64.rpm`,
    macArmZip: `${baseUrl}/DonWells-Cue-${v}-arm64.zip`
  };
});

const platformCards = computed(() => [
  { key: 'windows' as PlatformKey, index: '01', title: t('download.windows.title'), description: 'Windows 10/11 · 64-bit installer', action: 'Download .exe', meta: 'NSIS installer' },
  { key: 'macArm' as PlatformKey, index: '02', title: t('download.macArm.title'), description: 'M1/M2/M3 and newer · arm64', action: 'Download .dmg', meta: 'Apple Silicon' },
  { key: 'linux' as PlatformKey, index: '03', title: t('download.linux.title'), description: 'x86_64 · AppImage', action: 'Download AppImage', meta: 'Portable build' }
]);

const updateSeoMeta = () => {
  if (!isLocaleLoaded.value) return;
  const title = `DonWells Cue — ${t('header.tagline')}`;
  const description = 'Local-first audio cue playback for live events, with One Shots, Show Mode, Properties, and true-peak protection.';
  const ogImage = `${siteURL}screenshots/donwells_cue_main.jpg`;
  useHead({ title, meta: [{ name: 'description', content: description }] });
  useSeoMeta({ title, description, ogTitle: title, ogDescription: description, ogType: 'website', ogUrl: siteURL, ogImage, ogImageWidth: '1920', ogImageHeight: '1080', ogImageType: 'image/jpeg', twitterCard: 'summary_large_image', twitterTitle: title, twitterDescription: description, twitterImage: ogImage });
};

onMounted(async () => {
  detectedOS.value = detectOS();
  await initLocale();
  updateSeoMeta();
  try {
    const response = await fetch(asset('package.json'));
    version.value = (await response.json()).version;
  } catch (error) {
    console.warn('Using fallback site version:', error);
  }
});

watch(isLocaleLoaded, () => {
  if (isLocaleLoaded.value) updateSeoMeta();
});

useHead({ title: 'DonWells Cue — Audio Cue Playback for Live Events' });
</script>

<style lang="scss">
:root { color-scheme: light; font-family: 'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif; background: #f3f1ec; color: #15181d; font-synthesis: none; text-rendering: optimizeLegibility; }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; min-width: 320px; background: #f3f1ec; }
a { color: inherit; }
button, a { -webkit-tap-highlight-color: transparent; }
:focus-visible { outline: 3px solid #315fcf; outline-offset: 4px; }

.site-shell { --paper: #f3f1ec; --paper-deep: #e9e6de; --ink: #15181d; --muted: #65707b; --line: rgba(21,24,29,.15); --blue: #315fcf; --blue-dark: #244aa8; --amber: #e1ad32; min-height: 100vh; background: var(--paper); color: var(--ink); overflow: hidden; }
.wrap { width: min(1180px, calc(100% - 64px)); margin: 0 auto; }
.skip-link { position: fixed; z-index: 20; top: 12px; left: 12px; transform: translateY(-160%); padding: 10px 14px; background: var(--ink); color: white; border-radius: 4px; text-decoration: none; font-weight: 600; }
.skip-link:focus { transform: translateY(0); }
.site-header { position: sticky; top: 0; z-index: 10; background: rgba(243,241,236,.9); border-bottom: 1px solid var(--line); backdrop-filter: blur(16px); }
.site-header__inner { min-height: 72px; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.brand { display: inline-flex; align-items: center; gap: 10px; text-decoration: none; white-space: nowrap; }.brand__mark { width: 32px; height: 32px; border-radius: 8px; }.brand__name { font-size: 15px; font-weight: 700; letter-spacing: -.02em; }.brand__rule { width: 1px; height: 18px; background: var(--line); }
.brand__descriptor, .eyebrow, .product-frame__path, .product-frame__version, .product-frame__caption, .media-frame__label, .docs-checklist__heading, .download-card__badge { font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; }.brand__descriptor { color: var(--muted); }
.site-nav { display: flex; align-items: center; gap: 22px; margin-left: auto; }.site-nav a, .site-footer__links a { color: var(--muted); text-decoration: none; font-size: 13px; transition: color 160ms ease; }.site-nav a:hover, .site-footer__links a:hover { color: var(--ink); }.site-header__actions { display: flex; align-items: center; gap: 12px; }
.button { display: inline-flex; align-items: center; justify-content: center; gap: 10px; min-height: 46px; padding: 0 18px; border: 1px solid transparent; border-radius: 5px; font-size: 14px; font-weight: 700; text-decoration: none; transition: transform 160ms ease, background 160ms ease, border-color 160ms ease, color 160ms ease; }.button:hover { transform: translateY(-2px); }.button--compact { min-height: 36px; padding: 0 14px; font-size: 12px; }.button--dark { background: var(--ink); color: white; }.button--dark:hover { background: #2a3038; }.button--primary { background: var(--blue); color: white; }.button--primary:hover { background: var(--blue-dark); }.button--light { background: white; color: var(--ink); }.button--light:hover { background: var(--amber); }
.text-link { display: inline-flex; align-items: center; gap: 10px; color: var(--ink); font-size: 14px; font-weight: 700; text-decoration: none; border-bottom: 1px solid var(--line); padding-bottom: 6px; transition: color 160ms ease, border-color 160ms ease; }.text-link:hover { color: var(--blue); border-color: var(--blue); }.text-link--light { color: white; border-color: rgba(255,255,255,.35); }.text-link--light:hover { color: var(--amber); border-color: var(--amber); }

.hero { padding: 104px 0 88px; background: radial-gradient(circle at 78% 22%, rgba(49,95,207,.12), transparent 35%), var(--paper); }.hero__grid { display: grid; grid-template-columns: minmax(0,.82fr) minmax(0,1.18fr); gap: 80px; align-items: center; }.eyebrow { display: flex; align-items: center; gap: 8px; color: var(--blue); font-weight: 600; margin: 0 0 20px; }.eyebrow__signal { width: 7px; height: 7px; border-radius: 50%; background: var(--amber); box-shadow: 0 0 0 4px rgba(225,173,50,.16); }.eyebrow--light { color: #bfcaf0; }.hero h1 { max-width: 570px; margin: 0; font-size: clamp(3.5rem,7vw,6.6rem); line-height: .92; letter-spacing: -.075em; font-weight: 700; }.hero__lede { max-width: 490px; margin: 28px 0 0; color: var(--muted); font-size: 18px; line-height: 1.65; }.hero__actions { display: flex; align-items: center; gap: 24px; margin-top: 34px; flex-wrap: wrap; }.hero__facts { display: flex; gap: 30px; padding: 0; margin: 62px 0 0; }.hero__facts div { display: grid; grid-template-columns: auto auto; gap: 8px; align-items: baseline; padding-top: 12px; border-top: 1px solid var(--line); min-width: 108px; }.hero__facts dt { color: var(--blue); font: 600 11px 'IBM Plex Mono', monospace; }.hero__facts dd { margin: 0; font-size: 13px; color: var(--muted); }
.hero__visual { position: relative; }.product-frame { position: relative; padding: 10px; background: #222832; border: 1px solid rgba(21,24,29,.4); box-shadow: 18px 24px 0 rgba(21,24,29,.07), 0 24px 70px rgba(21,24,29,.18); transform: rotate(1.2deg); }.product-frame__bar { display: flex; align-items: center; min-height: 28px; padding: 0 4px 8px; color: #c4cbd5; }.window-dots { display: inline-flex; gap: 4px; margin-right: 12px; }.window-dots i { width: 6px; height: 6px; border-radius: 50%; background: #ec625b; }.window-dots i:nth-child(2) { background: #e7b747; }.window-dots i:nth-child(3) { background: #58bc72; }.product-frame__path { color: #aeb8c6; font-size: 8px; }.product-frame__version { margin-left: auto; font-size: 8px; color: #768393; }.product-frame__image { overflow: hidden; background: #101217; border: 1px solid rgba(255,255,255,.12); }.product-frame__image img { display: block; width: 100%; height: auto; }.product-frame__caption { display: flex; justify-content: space-between; gap: 10px; padding: 8px 4px 0; color: #8d99aa; font-size: 8px; }.hero__annotation { position: absolute; display: inline-flex; align-items: center; gap: 8px; color: var(--blue); font: 600 10px 'IBM Plex Mono', monospace; letter-spacing: .1em; }.hero__annotation::before { content: ''; width: 30px; height: 1px; background: var(--blue); }.hero__annotation--top { top: 12%; right: -100px; }.hero__annotation--bottom { bottom: 8%; left: -88px; flex-direction: row-reverse; }.hero__annotation--bottom::before { background: var(--amber); }
.signal-band { background: var(--ink); color: white; border-block: 1px solid rgba(255,255,255,.12); }.signal-band__grid { display: grid; grid-template-columns: repeat(4,1fr); }.signal-band__item { min-height: 108px; padding: 24px 24px 22px 0; border-right: 1px solid rgba(255,255,255,.12); }.signal-band__item:not(:first-child) { padding-left: 24px; }.signal-band__item:last-child { border-right: 0; }.signal-band__item strong { display: block; font-size: 14px; letter-spacing: -.01em; }.signal-band__item span { display: block; margin-top: 8px; color: #9aa4b2; font-size: 12px; line-height: 1.45; }
.section { padding: 120px 0; }.section-heading--split { display: flex; justify-content: space-between; align-items: end; gap: 60px; }.section-heading--split > p { max-width: 390px; margin: 0 0 4px; color: var(--muted); font-size: 16px; line-height: 1.65; }.section-heading h2, .feature-band h2, .docs-section h2 { max-width: 720px; margin: 0; font-size: clamp(2.4rem,4.6vw,4.6rem); line-height: .98; letter-spacing: -.065em; }.workflow-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 1px; margin-top: 64px; background: var(--line); border: 1px solid var(--line); }.workflow-card { min-height: 280px; padding: 28px; background: var(--paper); }.workflow-card__top { display: flex; justify-content: space-between; color: var(--blue); font: 600 11px 'IBM Plex Mono', monospace; }.workflow-card__mark { color: var(--amber); font-size: 20px; }.workflow-card h3 { margin: 70px 0 14px; max-width: 230px; font-size: 24px; line-height: 1.02; letter-spacing: -.04em; }.workflow-card p { max-width: 275px; margin: 0; color: var(--muted); font-size: 14px; line-height: 1.6; }.workflow-card__line { display: block; width: 40px; height: 3px; margin-top: 32px; background: var(--blue); }.workflow-card:nth-child(2) .workflow-card__line { background: var(--amber); }.workflow-card:nth-child(3) .workflow-card__line { background: var(--ink); }
.feature-band { padding: 120px 0; }.feature-band--ink { background: var(--ink); color: white; }.feature-band--paper { background: var(--paper-deep); }.feature-band__grid { display: grid; grid-template-columns: minmax(0,1.12fr) minmax(0,.88fr); gap: 88px; align-items: center; }.feature-band__grid--reverse { grid-template-columns: minmax(0,.88fr) minmax(0,1.12fr); }.feature-band__grid--reverse .feature-band__media { order: 2; }.feature-band__grid--reverse .feature-band__copy { order: 1; }.media-frame { position: relative; padding: 10px; background: #232833; box-shadow: 14px 18px 0 rgba(0,0,0,.16); }.media-frame--light { background: #d9d6cf; box-shadow: 14px 18px 0 rgba(21,24,29,.12); }.media-frame__label { display: block; padding: 0 0 9px 2px; color: #9eabbf; font-size: 8px; }.media-frame--light .media-frame__label { color: #626a73; }.media-frame img { display: block; width: 100%; height: auto; border: 1px solid rgba(255,255,255,.13); }.feature-band__copy h2 { max-width: 530px; }.feature-band__copy > p:not(.eyebrow) { max-width: 520px; margin: 28px 0 0; color: #aeb7c4; font-size: 17px; line-height: 1.65; }.feature-band__copy--paper > p:not(.eyebrow) { color: var(--muted); }.feature-list { display: grid; gap: 14px; margin: 34px 0 30px; padding: 0; list-style: none; }.feature-list li { display: grid; grid-template-columns: 30px 1fr; gap: 12px; align-items: baseline; padding-top: 12px; border-top: 1px solid rgba(255,255,255,.16); color: #e0e5eb; font-size: 14px; line-height: 1.45; }.feature-list li span { color: var(--amber); font: 600 10px 'IBM Plex Mono', monospace; }.feature-stat-row { display: grid; grid-template-columns: repeat(3,1fr); gap: 12px; margin: 34px 0 30px; }.feature-stat-row div { padding-top: 12px; border-top: 1px solid var(--line); }.feature-stat-row strong, .feature-stat-row span { display: block; }.feature-stat-row strong { font-size: 16px; }.feature-stat-row span { margin-top: 5px; color: var(--muted); font-size: 12px; }
.safety-section { background: white; }.safety-section__grid { display: grid; grid-template-columns: minmax(0,.9fr) minmax(0,1.1fr); gap: 80px; align-items: center; }.safety-section .section-heading > p:not(.eyebrow) { max-width: 500px; margin: 28px 0 0; color: var(--muted); font-size: 17px; line-height: 1.65; }.safety-card { padding: 22px 24px; background: var(--ink); color: white; border: 1px solid #333b47; box-shadow: 12px 14px 0 rgba(21,24,29,.08); }.safety-card__header { display: flex; justify-content: space-between; gap: 20px; padding-bottom: 14px; border-bottom: 1px solid rgba(255,255,255,.15); color: #aab4c2; font: 10px 'IBM Plex Mono', monospace; letter-spacing: .1em; }.safety-card__list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }.safety-card__list li { display: grid; grid-template-columns: 32px 1fr; gap: 14px; padding: 18px 0; border-bottom: 1px solid rgba(255,255,255,.12); }.safety-card__list li > span { color: var(--amber); font: 600 11px 'IBM Plex Mono', monospace; }.safety-card__list strong, .safety-card__list p { display: block; }.safety-card__list strong { font-size: 15px; }.safety-card__list p { max-width: 420px; margin: 5px 0 0; color: #aab4c2; font-size: 12px; line-height: 1.5; }.safety-card__link { display: inline-flex; align-items: center; gap: 10px; margin-top: 18px; color: white; font-size: 13px; font-weight: 700; text-decoration: none; border-bottom: 1px solid rgba(255,255,255,.35); padding-bottom: 5px; }.safety-card__link:hover { color: var(--amber); border-color: var(--amber); }
.download-section { background: var(--paper-deep); }.section-heading--download { align-items: start; }.section-heading--download > p { margin-top: 14px; }.download-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 14px; margin-top: 58px; }.download-card { display: flex; min-height: 266px; flex-direction: column; padding: 24px; border: 1px solid var(--line); background: var(--paper); text-decoration: none; transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease; }.download-card:hover, .download-card--recommended { transform: translateY(-4px); border-color: var(--blue); box-shadow: 8px 10px 0 rgba(49,95,207,.1); }.download-card--recommended { background: white; }.download-card__top { display: flex; justify-content: space-between; color: var(--blue); font: 600 11px 'IBM Plex Mono', monospace; }.download-card__badge { padding: 5px 7px; background: rgba(49,95,207,.1); color: var(--blue); font-size: 8px; }.download-card h3 { margin: 56px 0 8px; font-size: 26px; letter-spacing: -.04em; }.download-card p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }.download-card__action { margin-top: auto; color: var(--blue); font-size: 14px; font-weight: 700; }.download-card__meta { margin-top: 8px; color: var(--muted); font: 10px 'IBM Plex Mono', monospace; text-transform: uppercase; letter-spacing: .08em; }.download-links { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; margin-top: 28px; color: var(--muted); font-size: 13px; }.download-links a { color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--line); padding-bottom: 3px; }.download-links a:hover { color: var(--blue); border-color: var(--blue); }.install-note { display: flex; gap: 12px; align-items: flex-start; max-width: 720px; margin-top: 34px; color: var(--muted); font-size: 12px; line-height: 1.5; }.install-note__mark { flex: 0 0 20px; display: grid; place-items: center; width: 20px; height: 20px; background: var(--amber); color: var(--ink); font: 700 12px 'IBM Plex Mono', monospace; }.install-note strong { color: var(--ink); }.install-note code { font-family: 'IBM Plex Mono', monospace; font-size: .92em; color: var(--ink); }
.docs-section { padding: 112px 0; background: var(--ink); color: white; }.docs-section__grid { display: grid; grid-template-columns: minmax(0,.95fr) minmax(0,1.05fr); gap: 90px; align-items: start; }.docs-section h2 { max-width: 550px; }.docs-section__lede { max-width: 470px; margin: 26px 0 0; color: #aab4c2; font-size: 17px; line-height: 1.65; }.docs-section__actions { display: flex; align-items: center; gap: 22px; flex-wrap: wrap; margin-top: 32px; }.docs-checklist { border-top: 1px solid rgba(255,255,255,.2); }.docs-checklist__heading { display: flex; justify-content: space-between; padding: 14px 0; color: #909baa; font-size: 9px; }.docs-checklist ol { margin: 0; padding: 0; list-style: none; }.docs-checklist li { display: grid; grid-template-columns: 34px 1fr; gap: 14px; padding: 20px 0; border-top: 1px solid rgba(255,255,255,.13); }.docs-checklist li > span { color: var(--amber); font: 600 11px 'IBM Plex Mono', monospace; }.docs-checklist p { margin: 0; color: #dbe1e8; font-size: 14px; line-height: 1.55; }
.site-footer { background: var(--paper); border-top: 1px solid var(--line); }.site-footer__inner { display: flex; justify-content: space-between; align-items: center; gap: 30px; min-height: 92px; }.site-footer__inner > div:first-child { display: flex; align-items: baseline; gap: 14px; }.site-footer strong { font-size: 14px; }.site-footer span, .site-footer__links a { color: var(--muted); font-size: 12px; }.site-footer__links { display: flex; gap: 20px; }

@media (max-width: 980px) { .wrap { width: min(100% - 40px, 760px); }.site-nav { display: none; }.hero { padding: 76px 0 70px; }.hero__grid, .feature-band__grid, .feature-band__grid--reverse, .safety-section__grid, .docs-section__grid { grid-template-columns: 1fr; gap: 52px; }.hero__copy { max-width: 650px; }.hero__visual { margin: 0 22px; }.hero__annotation { display: none; }.feature-band__grid--reverse .feature-band__media, .feature-band__grid--reverse .feature-band__copy { order: initial; }.section-heading--split { display: block; }.section-heading--split > p { margin-top: 24px; }.workflow-grid, .download-grid { grid-template-columns: 1fr; }.workflow-card { min-height: auto; }.workflow-card h3 { margin-top: 48px; }.signal-band__grid { grid-template-columns: repeat(2,1fr); }.signal-band__item:nth-child(2) { border-right: 0; }.signal-band__item:nth-child(3), .signal-band__item:nth-child(4) { border-top: 1px solid rgba(255,255,255,.12); }.signal-band__item:nth-child(4) { border-right: 0; }.safety-card { max-width: 680px; } }
@media (max-width: 620px) { .wrap { width: min(100% - 28px, 520px); }.site-header__inner { min-height: 64px; gap: 12px; }.brand__descriptor, .brand__rule { display: none; }.brand__name { font-size: 14px; }.site-header__actions .button { display: none; }.hero { padding: 62px 0; }.hero h1 { font-size: clamp(3.2rem,16vw,5rem); }.hero__lede { font-size: 16px; }.hero__facts { gap: 12px; margin-top: 44px; }.hero__facts div { min-width: 0; flex: 1; }.hero__visual { margin: 0; }.product-frame { transform: none; }.signal-band__item { min-height: 96px; padding: 18px 12px 18px 0; }.signal-band__item:not(:first-child) { padding-left: 12px; }.signal-band__item strong { font-size: 12px; }.signal-band__item span { font-size: 11px; }.section, .feature-band, .docs-section { padding: 76px 0; }.section-heading h2, .feature-band h2, .docs-section h2 { font-size: 3rem; }.feature-band__grid { gap: 38px; }.feature-band__copy > p:not(.eyebrow), .safety-section .section-heading > p:not(.eyebrow), .docs-section__lede { font-size: 15px; }.feature-stat-row { gap: 8px; }.feature-stat-row strong { font-size: 14px; }.feature-stat-row span { font-size: 10px; }.safety-card { padding: 18px; }.safety-card__header { font-size: 8px; }.safety-card__list li { grid-template-columns: 26px 1fr; gap: 10px; padding: 15px 0; }.download-card { min-height: 220px; }.download-card h3 { margin-top: 42px; }.download-links { gap: 14px; }.site-footer__inner, .site-footer__inner > div:first-child { align-items: flex-start; flex-direction: column; gap: 12px; padding: 20px 0; }.site-footer__links { flex-wrap: wrap; gap: 14px; } }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } *, *::before, *::after { transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; } }
</style>
