<template>
  <!-- Finds a cue and jumps to it. The playlist itself is never filtered or
       reordered: hiding rows during a show is dangerous. -->
  <div class="playlist-search" :class="{ 'is-disabled': disabled, 'has-query': !!query }" role="search">
    <span class="material-symbols-rounded playlist-search__icon" aria-hidden="true">search</span>
    <!-- Enter and Shift+Enter are the only keys handled here. Every other key
         is left exactly as the app handles it, Stop All above all: this field
         binds no other key and stops none from travelling on. -->
    <input
      ref="input"
      v-model="query"
      class="playlist-search__input"
      type="text"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      :disabled="disabled"
      :placeholder="t('playlistSearch.placeholder')"
      :aria-label="t('playlistSearch.label')"
      :title="t('playlistSearch.tooltip')"
      @keydown.enter.exact.prevent="step(1)"
      @keydown.enter.shift.exact.prevent="step(-1)"
    />
    <span class="playlist-search__count" aria-live="polite">{{ counter }}</span>
    <button
      v-if="query"
      type="button"
      class="playlist-search__clear"
      :disabled="disabled"
      :title="t('playlistSearch.clear')"
      :aria-label="t('playlistSearch.clear')"
      @click="clear"
    >
      <span class="material-symbols-rounded" aria-hidden="true">close</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { findPlaylistMatches, normalizeSearchText, stepPlaylistMatch } from '~/utils/playlistSearch';

const props = defineProps<{ disabled: boolean }>();
// The playlist owns its scrolling and its groups, so it is told which row to
// show (see PlaylistView).
const emit = defineEmits<{ jump: [uuid: string] }>();

const { currentProject, formatItemIndex, projectEpoch } = useProject();
const { t } = useLocalization();

const input = ref<HTMLInputElement | null>(null);
const query = ref('');
// Uuid of the row outlined as the search hit. PlaylistItem reads the same state.
const hit = useState<string | null>('playlistSearchHit', () => null);
// Raised by Cmd/Ctrl+F in the operator window (see MainWorkspace). The field
// takes the cursor only then, or on a click: never by itself.
const focusRequest = useState<number>('playlistSearchFocusRequest', () => 0);

const needle = computed(() => normalizeSearchText(query.value));
const found = computed(() =>
  findPlaylistMatches(currentProject.value?.items ?? [], needle.value, formatItemIndex));
const counter = computed(() => {
  if (!needle.value) return '';
  const total = found.value.uuids.length;
  if (total === 0) return t('playlistSearch.noMatch');
  return t('playlistSearch.counter', { current: found.value.uuids.indexOf(hit.value ?? '') + 1, total });
});

function goTo(uuid: string | null) {
  hit.value = uuid;
  if (uuid) emit('jump', uuid);
}

// Typing jumps to where the search starts; emptying the field removes the outline.
watch(needle, () => goTo(found.value.uuids[found.value.start] ?? null));

// A row that no longer matches (renamed, deleted) loses its outline. A playlist
// that changes under the operator never moves the list by itself.
watch(() => found.value.uuids, (uuids) => {
  if (hit.value && !uuids.includes(hit.value)) hit.value = null;
});

function step(direction: 1 | -1) {
  goTo(stepPlaylistMatch(found.value.uuids, hit.value, direction));
}

// The cursor is not put back in the field: with it there, Space types a space
// instead of playing the next cue.
function clear() {
  query.value = '';
}

// Another show: the old search means nothing in it.
watch(projectEpoch, clear);

watch(focusRequest, () => {
  if (props.disabled) return;
  input.value?.focus();
  input.value?.select();
});

onBeforeUnmount(() => { hit.value = null; });
</script>

<style scoped>
/* One box for the icon, the text, the match counter and the clear button, as
   tall as the other header controls. */
.playlist-search {
  /* Compact while idle, so the buttons beside it keep their labels. It opens
     to 200px (where the playlist has the room) while it is in use. */
  flex: 0 0 130px;
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  min-width: 0;
  min-height: var(--panel-control-height);
  height: var(--panel-control-height);
  padding-inline: var(--spacing-sm) 2px;
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background-color: var(--color-control);
  transition:
    flex-basis var(--transition-fast),
    border-color var(--transition-fast),
    box-shadow var(--transition-fast);
}

.playlist-search:focus-within,
.playlist-search.has-query {
  flex-basis: clamp(130px, 100cqi - 470px, 200px);
}

/* Show Mode has no edit buttons beside it, so the field is always open. */
.playlist-view.show-mode .playlist-search {
  flex-basis: clamp(130px, 100cqi - 300px, 240px);
}

/* The same focus look as every other text field in the app. */
.playlist-search:focus-within {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.playlist-search.is-disabled {
  opacity: 0.5;
}

.playlist-search__icon {
  flex: none;
  color: var(--color-text-tertiary);
  font-size: 18px;
}

/* On a narrow playlist the field is narrow too: the typed text gets the room. */
@container (max-width: 640px) {
  .playlist-search__icon {
    display: none;
  }
}

.playlist-search__input,
.playlist-search__input:focus,
.playlist-search__input:disabled {
  flex: 1 1 0;
  width: 0;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  opacity: 1;
  font-size: 13px;
}

.playlist-search__input::placeholder {
  color: var(--color-text-tertiary);
  opacity: 1;
}

.playlist-search__count {
  /* A long "no match" in another language must not push the typed text out. */
  flex: 0 1 auto;
  min-width: 0;
  max-width: 50%;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--color-text-secondary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.playlist-search__clear {
  flex: none;
  align-self: stretch;
  display: grid;
  place-items: center;
  width: calc(var(--panel-control-height) - 8px);
  margin-block: 1px;
  padding: 0;
  border-radius: var(--control-radius);
  color: var(--color-text-secondary);
}

.playlist-search__clear:hover:not(:disabled) {
  background-color: var(--color-surface-hover);
  color: var(--color-text-primary);
}

.playlist-search__clear .material-symbols-rounded {
  font-size: 18px;
}

/* Show Mode is read from further away and worked by touch. */
.playlist-view.show-mode .playlist-search__input {
  font-size: 15px;
}

.playlist-view.show-mode .playlist-search__count {
  font-size: 13px;
}
</style>
