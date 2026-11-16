// Running time left in the playlist, for the header's List Left clock.

export interface RemainingListItem {
  uuid: string;
  type: string;
  duration?: number;
  inPoint?: number;
  outPoint?: number;
}

export interface RemainingActiveCue {
  uuid: string;
  duration: number;     // trimmed length, as the engine reports it
  currentTime: number;  // playhead from the in point
}

// Played length as the playlist row shows it: trimmed by the in/out points.
export const playedSeconds = (item: RemainingListItem): number => {
  const length = (item.outPoint || item.duration || 0) - (item.inPoint || 0);
  return Number.isFinite(length) && length > 0 ? length : 0;
};

/**
 * What is left of the playlist cue that is playing, plus Up Next and every
 * cue after it in list order. `flat` is the whole playlist in display order,
 * groups included (a group adds nothing itself; its children follow it).
 *
 * - Something playing, Up Next known: the rest of the live cue, then from Up
 *   Next to the end. Cues the operator skipped over are not counted, and a
 *   jump back counts the cues that will play again.
 * - Something playing, no Up Next: the rest of the live cue and all after it.
 * - Nothing playing: from Up Next to the end.
 * - Neither: null, there is nowhere to count from.
 *
 * QuickPlays are not in the list and are ignored. Time spent waiting for GO
 * is not running time and is not counted; a looping cue counts one pass.
 */
export function playlistRemainingSeconds(
  flat: readonly RemainingListItem[],
  active: readonly RemainingActiveCue[],
  upNextUuid: string | null | undefined,
): number | null {
  const position = new Map<string, number>();
  flat.forEach((item, index) => position.set(item.uuid, index));

  // With a crossfade two list cues can be live; follow the one further down.
  let liveIndex = -1;
  let liveLeft = 0;
  for (const cue of active) {
    const index = position.get(cue.uuid);
    if (index === undefined || index < liveIndex) continue;
    liveIndex = index;
    const left = cue.duration - cue.currentTime;
    liveLeft = Number.isFinite(left) && left > 0 ? left : 0;
  }

  const nextIndex = upNextUuid ? position.get(upNextUuid) ?? -1 : -1;
  if (liveIndex < 0 && nextIndex < 0) return null;

  let total = liveLeft;
  for (let index = nextIndex >= 0 ? nextIndex : liveIndex + 1; index < flat.length; index += 1) {
    const item = flat[index]!;
    if (item.type === 'audio') total += playedSeconds(item);
  }
  return total;
}

/** mm:ss, or h:mm:ss from an hour up; '--:--' when there is nothing to show. */
export function formatClockSeconds(total: number | null): string {
  if (total === null || !Number.isFinite(total)) return '--:--';
  const whole = Math.max(0, Math.ceil(total));
  const seconds = String(whole % 60).padStart(2, '0');
  const minutes = Math.floor(whole / 60) % 60;
  const hours = Math.floor(whole / 3600);
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${String(minutes).padStart(2, '0')}:${seconds}`;
}
