export const useAppUpdate = () => {
  const state = useState('appUpdate', () => ({
    version: '',
    installSupported: false,
    checking: false,
    downloading: false,
    downloaded: false,
    percent: 0,
    installOnExit: false,
    error: '',
  }));
  const update = state.value;
  const { t } = useLocalization();
  const { showHeaderWarning } = useHeaderWarnings();

  async function checkForAppUpdate() {
    const api = window.electronAPI;
    if (!api?.checkForUpdates || update.checking || update.downloading) return;
    update.checking = true;
    update.error = '';
    try {
      const result = await api.checkForUpdates();
      if (!result.success) throw new Error(result.error || t('update.checkFailed'));
    } catch (error) {
      update.error = error instanceof Error ? error.message : t('update.checkFailed');
      showHeaderWarning(t('update.checkFailed'));
    } finally {
      update.checking = false;
    }
  }

  return { update, checkForAppUpdate };
};
