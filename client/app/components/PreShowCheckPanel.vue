<template>
  <!-- Read-only by design: nothing here starts, stops or reloads a cue, and
       nothing is modal, so the transport and its keys stay live throughout. -->
  <section class="show-check" :aria-label="t('showCheck.title')" :aria-busy="busy">
    <header class="show-check__head">
      <span class="material-symbols-rounded show-check__mark" :class="`show-check__mark--${head.status}`"
        aria-hidden="true">{{ head.icon }}</span>
      <p class="show-check__verdict" role="status">{{ head.text }}</p>
      <p v-if="headNote" class="show-check__note">{{ headNote }}</p>
      <Btn type="button" class="show-check__again" icon="refresh" :text="t('showCheck.again')"
        :disabled="busy" @click="run" />
    </header>

    <ul v-if="result" class="show-check__lines" :class="{ 'show-check__lines--superseded': busy || outdated }">
      <li v-for="line in result.lines" :key="line.id" class="show-check__line">
        <span class="material-symbols-rounded show-check__mark" :class="`show-check__mark--${line.status}`"
          aria-hidden="true">{{ ICONS[line.status] }}</span>
        <strong class="show-check__title">{{ t(line.title.key) }}</strong>
        <span class="show-check__status" :class="`show-check__status--${line.status}`">
          {{ t(`showCheck.status.${line.status}`) }}
        </span>
        <p class="show-check__detail">{{ text(line.detail) }}</p>
        <Btn v-if="line.action === 'open-video-check'" type="button" class="show-check__action"
          :text="t('showCheck.video.open')" @click="openVideoCheck" />

        <ul v-if="line.entries.length" class="show-check__entries">
          <li v-for="entry in line.entries" :key="entry.id" class="show-check__entry">
            <span class="material-symbols-rounded show-check__mark show-check__mark--entry"
              :class="`show-check__mark--${entry.status}`" aria-hidden="true">{{ ICONS[entry.status] }}</span>
            <!-- A cue with a playlist row can be found from here. Selecting it
                 is all this does; the playlist then brings the row into view. -->
            <button v-if="entry.itemUuid" type="button" class="show-check__subject show-check__subject--cue"
              :title="t('showCheck.selectCue')" @click="reveal(entry.itemUuid)">
              <span v-if="entry.label" class="show-check__subject-label">{{ text(entry.label) }}</span>
              <span class="show-check__subject-name">{{ entry.name }}</span>
            </button>
            <span v-else class="show-check__subject">
              <span v-if="entry.label" class="show-check__subject-label">{{ text(entry.label) }}</span>
              <span class="show-check__subject-name">{{ entry.name }}</span>
            </span>
            <span class="show-check__reason">
              {{ text(entry.detail) }}
              <bdi v-if="entry.path" class="show-check__file" :title="entry.path">{{ fileName(entry.path) }}</bdi>
            </span>
          </li>
        </ul>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import Btn from './Btn.vue';
import { usePreShowCheck } from '~/composables/usePreShowCheck';
import type { CheckStatus, CheckText } from '~/utils/preShowCheck';

const { t } = useLocalization();
const { result, busy, outdated, checkedAt, run, reveal, openVideoCheck } = usePreShowCheck();

// A plain circle for "not checked": a question mark would read as a help
// affordance, and the status word beside it says what the circle means.
const ICONS: Record<CheckStatus, string> = {
  pass: 'check_circle',
  attention: 'warning',
  unchecked: 'radio_button_unchecked',
};

const text = (value: CheckText) => t(value.key, value.params);
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

// The verdict is only shown for a result that still describes the show as it
// stands. While a check runs, or once the show has moved on, it says so.
const head = computed<{ status: CheckStatus; icon: string; text: string }>(() => {
  if (busy.value) return { status: 'unchecked', icon: 'hourglass_empty', text: t('showCheck.checking') };
  const current = result.value;
  if (!current || outdated.value) return { status: 'unchecked', icon: ICONS.unchecked, text: t('showCheck.outdated') };
  return { status: current.status, icon: ICONS[current.status], text: text(current.verdict) };
});

const headNote = computed(() => {
  const current = result.value;
  if (busy.value || !current) return '';
  const notes: string[] = [];
  if (!outdated.value && current.unchecked) {
    notes.push(t('showCheck.verdict.notChecked', { count: current.unchecked }));
  }
  if (checkedAt.value !== null) {
    const at = new Date(checkedAt.value);
    const time = [at.getHours(), at.getMinutes(), at.getSeconds()].map(part => String(part).padStart(2, '0')).join(':');
    notes.push(t('showCheck.checkedAt', { time }));
  }
  return notes.join(' · ');
});

// Opening the panel is the request to check, including when it returns from
// behind Settings after the video check was run there. Started here rather
// than after mounting so the first paint already says a check is running.
void run();
</script>

<style scoped lang="scss">
.show-check {
  display: grid;
  flex: none;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--workspace-gutter);
  font-size: var(--type-metadata-size);
  overflow-wrap: anywhere;
}

.show-check__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-xs) var(--spacing-sm);
}

.show-check__verdict {
  font-size: var(--type-track-size);
  font-weight: 650;
  line-height: 1.25;
}

.show-check__note {
  color: var(--color-text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.show-check__again {
  margin-inline-start: auto;
}

.show-check__mark {
  flex: none;
  font-size: 20px;

  &--pass { color: var(--color-success); }
  &--attention { color: var(--color-warning); }
  &--unchecked { color: var(--color-text-secondary); }
  &--entry { font-size: 16px; }
}

/* One grid for every line, so titles, status words and sentences line up. */
.show-check__lines {
  display: grid;
  grid-template-columns: auto max-content max-content minmax(0, 1fr) auto;
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background: var(--color-surface);
  transition: opacity var(--transition-base);
}

.show-check__lines--superseded {
  opacity: 0.55;
}

.show-check__line {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
  align-items: center;
  gap: 2px var(--spacing-sm);
  padding: 6px var(--spacing-sm);
}

.show-check__line + .show-check__line {
  border-top: 1px solid var(--color-border);
}

.show-check__title {
  font-weight: 650;
}

.show-check__status {
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;

  &--pass { color: var(--color-success); }
  &--attention { color: var(--color-warning); }
  &--unchecked { color: var(--color-text-secondary); }
}

.show-check__detail {
  grid-column: 4;
  color: var(--color-text-secondary);
}

.show-check__action {
  grid-column: 5;
}

.show-check__entries {
  display: grid;
  grid-column: 2 / -1;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.show-check__entry {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px var(--spacing-sm);
}

/* The named cue or output. As a button it is a full-size target: 34px, from
   the shared panel control height. */
.show-check__subject {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  min-height: var(--panel-control-height);
  font-weight: 600;
  text-align: start;
}

.show-check__subject--cue {
  padding: 2px var(--spacing-sm);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background: var(--color-surface-raised);

  &:hover {
    background: var(--color-surface-hover);
    border-color: var(--color-border-strong);
  }
}

.show-check__subject-label {
  flex: none;
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}

.show-check__reason {
  color: var(--color-text-secondary);
}

.show-check__file {
  margin-inline-start: var(--spacing-xs);
  font-family: var(--font-mono);
  font-size: 12px;
}

/* A narrow panel stacks each line: mark and title, then the sentence. */
@container (max-width: 640px) {
  .show-check__lines {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }

  .show-check__detail {
    grid-column: 2 / -1;
  }

  .show-check__action {
    grid-column: 2 / -1;
    justify-self: start;
  }
}
</style>
