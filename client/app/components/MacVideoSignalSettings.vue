<template>
  <section class="settings-field signal-settings">
    <span class="settings-label">{{ t('settings.videoSignal.title') }}</span>
    <span>{{ label(signal.requested) }}</span>
    <span v-if="actual">{{ t('settings.videoSignal.macReports', { mode: actual }) }}</span>
    <span v-if="signal.restoreFailed" role="status">{{ t('settings.videoSignal.phase.restoreFailed') }}</span>
    <Btn v-if="legacyAlternative" type="button" :text="t('settings.videoSignal.useFormat', { mode: legacyAlternative })"
      :disabled="signal.phase === 'checking'" @click="emit('apply', legacyAlternative)" />
    <details>
      <summary>{{ t('settings.videoSignal.advanced') }}</summary>
      <InlineChoicePicker :label="t('settings.videoSignal.title')" :value="draft" :options="options" @change="draft = $event" />
      <details v-if="nativeOptions.length">
        <summary>{{ t('settings.videoSignal.otherModes') }}</summary>
        <p>{{ t('settings.videoSignal.otherHelp') }}</p>
        <InlineChoicePicker :label="t('settings.videoSignal.otherModes')" :value="nativeDraft"
          :options="[{ value: '', label: t('settings.videoSignal.chooseTiming'), disabled: true }, ...nativeOptions]"
          @change="draft = $event" />
      </details>
      <p>{{ t('settings.videoSignal.autoHelp', { formats: ntscFormats.join(', ') }) }}</p>
      <p>{{ t('settings.videoSignal.applyHelp') }}</p>
      <Btn type="button" :text="t('settings.videoSignal.apply')" :disabled="signal.phase === 'checking' ||
        (draft === signal.requested && !retryable)" @click="emit('apply', draft)" />
      <p>{{ t('settings.videoSignal.measurement') }}</p>
    </details>
  </section>
</template>

<script setup lang="ts">
const props = defineProps<{ signal: MacVideoSignalStatus }>();
const emit = defineEmits<{ apply: [format: string] }>();
const { t } = useLocalization();
const draft = ref(props.signal.requested);
const ntscFormats = ['1080p59.94', '1080i59.94', '720p59.94', '480i59.94', '480p59.94'];
const legacyAlternative = computed(() => {
  const s = props.signal;
  return s.requested === ntscFormats[0] && !s.formats.includes(s.requested)
    ? ntscFormats.find(format => s.formats.includes(format)) : undefined;
});
watch(() => props.signal.requested, saved => { draft.value = saved; });
const label = (format: string) => {
  if (format.startsWith('native:')) return props.signal.nativeModes[format] ?? t('settings.videoSignal.savedTiming');
  return format === 'auto' || format === 'current' ? t(`settings.videoSignal.${format}`) : format;
};
const nativeOptions = computed(() => Object.entries(props.signal.nativeModes)
  .map(([value, mode]) => ({ value, label: mode })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })));
const nativeDraft = computed(() => draft.value.startsWith('native:') ? draft.value : '');
const retryable = computed(() => ['failed', 'unavailable', 'mismatch', 'error'].includes(props.signal.phase));
const options = computed(() => {
  const s = props.signal;
  const known = !!s.actual.width;
  const choices = known ? s.formats : s.presets;
  return [...new Set(['auto', ...choices, s.requested, draft.value, 'current'])].map(value => {
    const unavailable = known && value !== 'auto' && value !== 'current' && !s.formats.includes(value) && !s.nativeModes[value];
    return { value, label: unavailable ? t('settings.videoSignal.unavailableMode', { mode: label(value) }) : label(value),
      disabled: unavailable };
  });
});
const actual = computed(() => {
  const a = props.signal.actual;
  if (!a.width || !a.height) return '';
  const raster = `${a.width}×${a.height}${a.interlaced ? 'i' : 'p'}`;
  return a.hz ? `${raster} · ${Number(a.hz.toFixed(5))} Hz` : t('settings.videoSignal.unknownRate', { raster });
});
</script>

<style scoped>
.signal-settings { display: grid; gap: 4px; }
.signal-settings summary { cursor: pointer; }
.signal-settings details > * + * { margin-top: 6px; }
.signal-settings p { font-size: 12px; color: var(--color-text-secondary); }
</style>
