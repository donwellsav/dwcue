import type { CueSheetPayload } from '../types/cueSheet';
import { cueSheetContents } from '../utils/cueSheet';

// Strings printed on the sheet, sent as locale keys cueSheet.<name>. The main
// process holds an English fallback for each (electron/cue-sheet.js).
const SHEET_LABELS = [
  'title', 'generated', 'cues', 'runningTime', 'playlist', 'quickPlays',
  'columnNumber', 'columnSlot', 'columnTitle', 'columnNote', 'columnDuration',
  'columnLevel', 'columnEnd', 'endNothing', 'endNext', 'endGoto', 'endLoop',
  'emptyPlaylist', 'truncated', 'page', 'untitledShow',
] as const;

let exporting = false;

// File > Export Cue Sheet (PDF): a read-only summary of the open show. The
// main process asks where to save it and writes the file.
export function useCueSheetExport() {
  const { currentProject, indexDisplayStart } = useProject();
  const { quickPlayItems } = useQuickPlayItems();
  const { t } = useLocalization();
  const { showHeaderWarning } = useHeaderWarnings();

  // t() answers with the key itself while a string is not in the locale files.
  const notice = (key: string, english: string, params: Record<string, string>): string => {
    let text = t(key);
    if (text === key) text = english;
    for (const [name, value] of Object.entries(params)) text = text.replace(`{${name}}`, () => value);
    return text;
  };
  const failed = (error: string) => showHeaderWarning(
    notice('cueSheet.exportFailed', 'Could not export the cue sheet: {error}', { error }), 'urgent');

  async function exportCueSheet(): Promise<void> {
    const project = currentProject.value;
    if (!project || exporting || !import.meta.client || !window.electronAPI?.exportCueSheet) return;
    exporting = true;
    try {
      const labels: Record<string, string> = {};
      for (const name of SHEET_LABELS) {
        const key = `cueSheet.${name}`;
        const text = t(key);
        if (text !== key) labels[name] = text;
      }
      const payload: CueSheetPayload = {
        showName: project.name ?? '',
        indexStart: indexDisplayStart.value,
        ...cueSheetContents(project.items ?? [], Array.from(quickPlayItems.value.values())),
        labels,
      };
      const result = await window.electronAPI.exportCueSheet(payload);
      if (result.status === 'saved') {
        showHeaderWarning(notice('cueSheet.exported', 'Cue sheet saved as {name}', { name: result.fileName }));
      } else if (result.status === 'failed') {
        failed(result.error);
      }
    } catch (error) {
      failed(error instanceof Error ? error.message : String(error));
    } finally {
      exporting = false;
    }
  }

  return { exportCueSheet };
}
