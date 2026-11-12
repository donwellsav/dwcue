import type { AudioItem } from '~/types/project';

export function useOneShotPlayback() {
  const { projectHydrationStatus } = useProject();
  const { isDetached, identity } = useDetachedOneShotMutation();
  const { activeCues, playCue } = useAudioEngine();
  // The detached bank receives its ready document from the primary window.
  const oneShotPlaybackReady = computed(() =>
    isDetached ? identity.value !== null : projectHydrationStatus.value === 'ready');

  function playOneShot(item: AudioItem) {
    if (!oneShotPlaybackReady.value || (item.oneShot?.retrigger === 'ignore' && activeCues.value.has(item.uuid))) {
      return Promise.resolve(false);
    }
    return playCue(item);
  }

  return { oneShotPlaybackReady, playOneShot };
}
