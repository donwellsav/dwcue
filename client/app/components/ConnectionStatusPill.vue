<template>
  <!-- Only visible when something is wrong. A permanent "connected" light is
       noise the operator learns to stop seeing; an element that appears only
       on trouble is the one they'll actually notice. Shows from the moment the
       socket drops — ahead of the modal's grace period — so a brief blip is
       still visible to anyone watching, without stealing the whole screen. -->
  <transition name="csp-fade">
    <div
      v-if="!connected"
      class="conn-pill"
      :class="{ 'conn-pill--lost': lost }"
      :title="title"
      role="status"
      aria-live="polite"
    >
      <span
        class="material-symbols-rounded conn-pill__icon"
        :class="{ 'is-spinning': !lost }"
        aria-hidden="true"
      >{{ lost ? 'cloud_off' : 'sync' }}</span>
      <span class="conn-pill__label">{{ lost ? t('connectionLost.title') : t('connectionLost.pill') }}</span>
    </div>
  </transition>
</template>

<script setup lang="ts">
const { t } = useLocalization();
const server = useLiveplayServer();

const connected = computed(() => !!server.connected);
// Escalates from amber (retrying quietly) to red once we've given up on the
// blip theory and locked the UI.
const lost = computed(() => !!server.connectionLost);
const title = computed(() =>
  t('connectionLost.message', { url: String(server.serverUrl) }));
</script>

<style scoped>
.conn-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  /* Matches Btn and the unsaved-changes pill next to it — the header is all
     2px corners, and a fully-rounded pill reads as a foreign element. */
  border-radius: var(--pill-radius);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  color: #8a6100;
  background: rgba(241, 194, 27, 0.16);
  border: 1px solid rgba(241, 194, 27, 0.5);
}
.conn-pill--lost {
  color: #da1e28;
  background: rgba(218, 30, 40, 0.12);
  border-color: rgba(218, 30, 40, 0.5);
}
:global([data-theme='dark']) .conn-pill { color: #f1c21b; }
:global([data-theme='dark']) .conn-pill--lost { color: #ff8389; }

.conn-pill__icon {
  font-size: 15px;
}
.conn-pill__icon.is-spinning {
  animation: conn-spin 1.1s linear infinite;
}
@keyframes conn-spin { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .conn-pill__icon { animation: none; }
}

.csp-fade-enter-active, .csp-fade-leave-active { transition: opacity 0.2s ease; }
.csp-fade-enter-from, .csp-fade-leave-to { opacity: 0; }
</style>
