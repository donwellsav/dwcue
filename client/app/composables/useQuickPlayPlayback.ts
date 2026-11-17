import type { AudioItem } from '~/types/project';

export function useQuickPlayPlayback() {
  const { projectHydrationStatus } = useProject();
  const { isDetached, identity } = useDetachedQuickPlayMutation();
  const { activeCues, playCue } = useAudioEngine();
  // The detached bank receives its ready document from the primary window.
  const quickPlayPlaybackReady = computed(() =>
    isDetached ? identity.value !== null : projectHydrationStatus.value === 'ready');

  function playQuickPlay(item: AudioItem) {
    if (!quickPlayPlaybackReady.value || (item.quickPlay?.retrigger === 'ignore' && activeCues.value.has(item.uuid))) {
      return Promise.resolve(false);
    }
    return playCue(item);
  }

  return { quickPlayPlaybackReady, playQuickPlay };
}
