<template>
  <svg
    class="cue-symbol"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <template v-if="name === 'preview'">
      <path d="M3 8h4l4-3v14l-4-3H3z" />
      <path d="m15 8 6 4-6 4z" />
    </template>

    <template v-else-if="name === 'one-shots'">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <path d="m5.5 7 1.3-2.2v1.5h1.7L7.2 8.5V7z" fill="currentColor" stroke="none" />
    </template>

    <template v-else-if="name === 'ltc'">
      <rect x="2.5" y="6" width="19" height="12" rx="1.5" />
      <path d="M6 3.5V6M18 3.5V6M6.5 9.5v5M9.5 9.5v5M14.5 9.5v5M17.5 9.5v5" />
      <path d="M12 10.5h.01M12 13.5h.01" stroke-width="2.2" />
    </template>

    <template v-else>
      <rect x="2.5" y="4" width="14" height="12" rx="1.5" />
      <path d="M9.5 16v4M6.5 20h6M16.5 8.5h5M19 6l2.5 2.5L19 11" />
    </template>
  </svg>
</template>

<script setup lang="ts">
defineProps<{
  name: 'preview' | 'one-shots' | 'ltc' | 'video-output';
}>();
</script>

<style scoped>
.cue-symbol {
  display: inline-block;
  width: 1em;
  height: 1em;
  flex: none;
  vertical-align: -0.125em;
}
</style>
