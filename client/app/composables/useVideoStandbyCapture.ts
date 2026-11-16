import type { AudioItem } from '~/types/project';
import { captureFileName, dataUrlToFile, showMediaUrl, showRelativePath } from '~/utils/stillCapture';

export type StillTarget = 'standby' | 'cue';

// The last capture, kept so it can be shown and undone.
export interface StillCaptureRecord {
  target: StillTarget;
  itemUuid: string | null;
  // The cue it was captured for, as the operator knows it ('' for standby).
  cueLabel: string;
  // The picture as it was captured.
  image: string;
  // Where it was saved, and what was there before.
  path: string;
  previous: string | null;
}

/**
 * Capturing a picture of the Video Output (or of another screen) for the show.
 *
 * A capture is saved into the show's media folder and set as the show's
 * standby picture or as a cue's picture: the same two things a picture chosen
 * from a file sets. So it stays with the show, and there is one kind of
 * picture, not two. What a capture is for is said when it is taken; nothing
 * about the destination is remembered between captures.
 */
export function useVideoStandbyCapture() {
  const {
    currentProject, projectSyncIdentity, projectHydrationStatus, selectedItem, findItemByUuid, formatItemIndex,
    saveProject, workspaceImportPanel,
  } = useProject();
  const showProjectSettings = useState('showProjectSettings', () => false);
  const { cartOnlyItems } = useCartItems();
  const { activeCues } = useAudioEngine();
  const server = useLiveplayServer();
  const { t } = useLocalization();
  const { showHeaderWarning } = useHeaderWarnings();
  const standbyCapturePending = useState('videoStandbyCapturePending', () => false);
  const lastCapture = useState<StillCaptureRecord | null>('videoStillLastCapture', () => null);

  const findCue = (uuid: string | null | undefined): AudioItem | null => {
    if (!uuid) return null;
    const item = findItemByUuid(uuid) ?? cartOnlyItems.value.get(uuid);
    return item?.type === 'audio' ? item as AudioItem : null;
  };

  // The cue a capture is for: the one that is playing (the newest, during a
  // crossfade), otherwise the one selected in the playlist. A playing cue comes
  // first because that is what is on the screen being captured.
  const captureCue = computed<AudioItem | null>(() => {
    for (const uuid of [...activeCues.value.keys()].reverse()) {
      const cue = findCue(uuid);
      if (cue) return cue;
    }
    return selectedItem.value?.type === 'audio' ? selectedItem.value as AudioItem : null;
  });

  const cueLabel = (cue: AudioItem) => {
    const name = cue.displayName || cue.mediaFileName || '';
    const number = cue.index?.[0] >= 0 ? formatItemIndex(cue.index) : '';
    return number ? `${number} · ${name}` : name;
  };

  const standbyPath = computed<string | null>(() =>
    (currentProject.value as any)?.settings?.videoStandbyImage || null);
  const pictureUrl = (path: string | null | undefined) =>
    showMediaUrl(server.serverUrl, server.effectiveAccessToken, currentProject.value?.folderPath, path);

  // Null or '' is "no picture". The engine merges what it is sent, so the
  // field is emptied rather than removed: a removed field would linger there.
  function setStandbyPicture(path: string | null) {
    const project = currentProject.value as any;
    if (!project) return;
    project.settings = { ...(project.settings ?? {}), videoStandbyImage: path || null };
  }

  function setCuePicture(cue: AudioItem, path: string | null) {
    cue.imagePath = path || '';
    // A QuickPlay's own cue is saved with the show, like any change to a tile.
    if (!(cue.index?.[0] >= 0)) void saveProject();
  }

  const failureText = (error: unknown) => {
    const message = error instanceof Error
      ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error|TypeError): /, '') : '';
    return message || t('standbyCapture.failed');
  };

  /** Capture what is on the Video Output (or the chosen other screen) for `target`. */
  async function captureStill(target: StillTarget, source: 'output' | 'display' = 'output') {
    const api = window.electronAPI?.videoOutput;
    if (!api?.captureStandby || standbyCapturePending.value) return;
    const project = currentProject.value;
    const identity = projectSyncIdentity.value;
    const sessionId = server.projectSessionId;
    if (!project || !identity || !sessionId || projectHydrationStatus.value !== 'ready') {
      showHeaderWarning(t('standbyCapture.noShow'));
      return;
    }
    const cue = target === 'cue' ? captureCue.value : null;
    if (target === 'cue' && !cue) {
      showHeaderWarning(t('standbyCapture.selectCue'));
      return;
    }
    const isCurrent = () => currentProject.value === project && server.projectSessionId === sessionId
      && projectSyncIdentity.value === identity;
    standbyCapturePending.value = true;
    try {
      const { image } = await api.captureStandby(source, { identity, sessionId, itemUuid: cue?.uuid ?? null });
      if (!isCurrent()) return;
      const label = cue ? cueLabel(cue) : '';
      const name = captureFileName(cue ? (cue.displayName || cue.mediaFileName || 'Cue') : 'Standby', new Date(), image);
      const saved = (await server.uploadFile(dataUrlToFile(image, name), name, sessionId))?.saved?.[0];
      if (!saved) throw new Error(t('standbyCapture.failed'));
      if (!isCurrent()) return;
      const path = showRelativePath(project.folderPath, saved);
      const target_ = cue && findCue(cue.uuid);
      if (cue && !target_) return;
      const previous = target_ ? (target_.imagePath || null) : standbyPath.value;
      if (target_) setCuePicture(target_, path);
      else setStandbyPicture(path);
      lastCapture.value = { target, itemUuid: cue?.uuid ?? null, cueLabel: label, image, path, previous };
      showHeaderWarning(cue ? t('standbyCapture.cueCaptured', { cue: label }) : t('standbyCapture.sessionCaptured'));
    } catch (error) {
      if (isCurrent()) showHeaderWarning(failureText(error));
    } finally {
      standbyCapturePending.value = false;
    }
  }

  // Undo is offered only while the capture is still what is in use.
  const canUndo = computed(() => {
    const last = lastCapture.value;
    if (!last) return false;
    if (last.target === 'standby') return standbyPath.value === last.path;
    return findCue(last.itemUuid)?.imagePath === last.path;
  });

  /** Put back what the last capture replaced. The captured file is left where it is. */
  function undoCapture() {
    const last = lastCapture.value;
    if (!last || !canUndo.value) return;
    if (last.target === 'standby') setStandbyPicture(last.previous);
    else setCuePicture(findCue(last.itemUuid)!, last.previous);
    lastCapture.value = null;
    showHeaderWarning(t('standbyCapture.undone'));
  }

  /** Remove the standby picture, or the capture cue's picture. */
  function clearPicture(target: StillTarget) {
    if (target === 'standby') setStandbyPicture(null);
    else if (captureCue.value) setCuePicture(captureCue.value, null);
    else return;
    if (lastCapture.value?.target === target) lastCapture.value = null;
    showHeaderWarning(t('standbyCapture.cleared'));
  }

  // The capture panel in the lower workspace; a second press closes it. A
  // pending delete confirmation is never pushed aside for it.
  function openCapturePanel() {
    if (!currentProject.value || workspaceImportPanel.value === 'delete-selection') return;
    if (workspaceImportPanel.value === 'video-capture' && !showProjectSettings.value) {
      workspaceImportPanel.value = null;
      return;
    }
    showProjectSettings.value = false;
    workspaceImportPanel.value = 'video-capture';
  }

  // Another show: its last capture is not this one's.
  watch(() => server.projectSessionId, () => { lastCapture.value = null; });

  return {
    captureStill, undoCapture, clearPicture, canUndo, standbyCapturePending, lastCapture,
    captureCue, cueLabel, standbyPath, pictureUrl, openCapturePanel,
  };
}
