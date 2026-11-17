// What the video check should do next, worked out from what it already knows.

export interface VideoWorkCue {
  uuid: string;
  // The cue's file and trim, as one string: a change means look again.
  source: string;
  // What the last check found wrong with it, if anything.
  issue: string | null;
}

export interface VideoWork {
  // Not checked yet, or changed since.
  check: string[];
  // Checked, and the picture cannot be decoded here: make a copy that can.
  convert: string[];
  // Already a converted copy (or already tried), and still no picture.
  stillFailing: string[];
}

// Only a picture this computer cannot decode is worth converting. A file that
// is missing, times out or is trimmed past its end would fail again as a copy.
const CONVERTIBLE = new Set(['decode', 'no-frame']);

export function nextVideoWork(
  cues: readonly VideoWorkCue[],
  checked: ReadonlyMap<string, string>,
  converted: ReadonlyMap<string, string>,
  canConvert: boolean,
): VideoWork {
  const work: VideoWork = { check: [], convert: [], stillFailing: [] };
  for (const cue of cues) {
    if (checked.get(cue.uuid) !== cue.source) work.check.push(cue.uuid);
    else if (!cue.issue || !CONVERTIBLE.has(cue.issue)) continue;
    else if (converted.get(cue.uuid) === cue.source) work.stillFailing.push(cue.uuid);
    else if (canConvert) work.convert.push(cue.uuid);
  }
  return work;
}
