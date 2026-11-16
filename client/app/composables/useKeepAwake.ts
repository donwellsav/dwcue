// Tells the main process what the show is doing so it can keep the computer
// (and, in Show Mode or during playback, the screen) from sleeping. The
// decision itself lives in electron/keep-awake.js.
export function useKeepAwake() {
  if (!import.meta.client) return;
  const { currentProject } = useProject();
  const { uiMode } = useUiMode();
  const { activeCues } = useAudioEngine();

  const showOpen = computed(() => !!currentProject.value);
  const showMode = computed(() => uiMode.value === 'playback');
  const playing = computed(() => activeCues.value.size > 0);

  watch([showOpen, showMode, playing], ([open, show, play]) => {
    // Best effort: a failed report only means the system's own sleep timer applies.
    void window.electronAPI?.keepAwake?.({ showOpen: open, showMode: show, playing: play })?.catch(() => {});
  }, { immediate: true });
}
