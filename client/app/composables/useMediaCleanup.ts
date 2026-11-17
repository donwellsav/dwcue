// File > Clean Up Media: opens the panel that lists the files in the show's
// media folder nothing uses any more (MediaCleanupPanel.vue). It changes what
// is on disk, so it is an Edit Mode panel and is never opened in Show Mode.
export function useMediaCleanup() {
  const { currentProject, projectHydrationStatus, workspaceImportPanel } = useProject();
  const { uiMode } = useUiMode();
  const { t } = useLocalization();
  const { showHeaderWarning } = useHeaderWarnings();
  const showProjectSettings = useState('showProjectSettings', () => false);

  function openMediaCleanup() {
    if (!currentProject.value || projectHydrationStatus.value === 'failed') return;
    // A pending delete confirmation is never pushed aside for it.
    if (workspaceImportPanel.value === 'delete-selection') return;
    if (uiMode.value === 'playback') {
      showHeaderWarning(t('mediaCleanup.editModeOnly'));
      return;
    }
    showProjectSettings.value = false;
    workspaceImportPanel.value = 'media-cleanup';
  }

  return { openMediaCleanup };
}
