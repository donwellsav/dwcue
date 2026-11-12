export function useVideoStandbyCapture() {
  const { projectSyncIdentity, projectHydrationStatus, selectedItem } = useProject();
  const server = useLiveplayServer();
  const { t } = useLocalization();
  const { showHeaderWarning } = useHeaderWarnings();
  const standbyCapturePending = useState('videoStandbyCapturePending', () => false);

  async function captureStandby(source: 'output' | 'display' | 'clear', destination?: VideoStandbyDestination) {
    const api = window.electronAPI?.videoOutput;
    if (!api?.captureStandby || standbyCapturePending.value) return;
    const identity = projectSyncIdentity.value;
    const sessionId = server.projectSessionId;
    const item = selectedItem.value;
    if (!identity || !sessionId || projectHydrationStatus.value !== 'ready') {
      showHeaderWarning(t('standbyCapture.noShow'));
      return;
    }
    standbyCapturePending.value = true;
    try {
      const targetMode = destination ?? (await api.status()).captureTarget;
      if (projectSyncIdentity.value !== identity || server.projectSessionId !== sessionId) return;
      if (targetMode === 'cue' && item?.type !== 'audio') {
        showHeaderWarning(t('standbyCapture.selectCue'));
        return;
      }
      const itemUuid = targetMode === 'cue' ? item!.uuid : null;
      const target = { identity, sessionId, itemUuid };
      if (source === 'clear') await api.clearStandbyCapture(target);
      else await api.captureStandby(source, target);
      if (server.projectSessionId === sessionId && projectSyncIdentity.value === identity) {
        showHeaderWarning(t(source === 'clear' ? 'standbyCapture.cleared'
          : itemUuid ? 'standbyCapture.cueCaptured' : 'standbyCapture.sessionCaptured'));
      }
    } catch (error) {
      if (server.projectSessionId === sessionId && projectSyncIdentity.value === identity) {
        const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error|TypeError): /, '') : '';
        showHeaderWarning(message || t('standbyCapture.failed'));
      }
    } finally {
      standbyCapturePending.value = false;
    }
  }

  return { captureStandby, standbyCapturePending };
}
