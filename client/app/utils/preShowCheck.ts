// =====================================================================
// utils/preShowCheck.ts
// ---------------------------------------------------------------------
// Decision logic for the Pre-show check. Pure: plain facts in, lines out.
// usePreShowCheck gathers the facts; PreShowCheckPanel draws the lines.
//
// One rule holds in every branch: a line is 'pass' only for something the
// app verified during this check. Whatever it could not verify is
// 'unchecked' and says why. Nothing is assumed to be fine.
// =====================================================================

export type CheckStatus = 'pass' | 'attention' | 'unchecked';
export type CheckLineId = 'engine' | 'output' | 'media' | 'file' | 'video';

// A localisation key with its parameters; the panel passes both to t().
export interface CheckText {
  key: string;
  params?: Record<string, string | number>;
}

// One named thing under a line: a cue, or an output with a job.
export interface CheckEntry {
  id: string;
  status: CheckStatus;
  label: CheckText | null;   // "Cue 3", "QuickPlay 2", "Preview output"
  name: string;              // cue or device name as authored; never translated
  detail: CheckText;
  itemUuid: string | null;   // set when the entry is a cue with a playlist row
  path: string | null;       // the file the engine tried, when it reported one
}

export interface CheckLine {
  id: CheckLineId;
  status: CheckStatus;
  title: CheckText;
  detail: CheckText;
  entries: CheckEntry[];
  problems: number;          // separate things needing attention on this line
  action: 'open-video-check' | null;
}

export interface PreShowCheckResult {
  lines: CheckLine[];
  status: CheckStatus;
  verdict: CheckText;
  attention: number;         // things needing attention across all lines
  unchecked: number;         // lines that could not be checked
}

// ---- Facts -----------------------------------------------------------

export interface EngineFacts {
  connected: boolean;            // the control connection is open
  answered: boolean;             // the engine answered a request made by this check
  startsHeld: boolean;           // the app is holding cue starts (reconnect, show being confirmed)
  engineVersion: string | null;  // as reported by the engine in that answer
  appVersion: string | null;     // null when this window cannot know it
}

export interface OutputDeviceFact {
  id: string;
  name: string;
  isDefault: boolean;
  isOpen: boolean;
  isAvailable: boolean;
  state: string;                 // engine runtime_state
}

export interface OutputFacts {
  devices: OutputDeviceFact[] | null;  // null: the engine did not return its list during this check
  main: string | null;                 // settings.defaultOutputDevice; empty means system default
  preview: string | null;
  ltc: string | null;
}

export interface CueFact {
  uuid: string;
  name: string;
  inPlaylist: boolean;             // has a playlist row that can be selected
  cueNumber: string | null;        // number as the playlist shows it, e.g. "3" or "2,1"
  quickPlayNumber: number | null;  // 1-based QuickPlay cell
  output: string | null;           // the cue's own output device, when it has one
  hasVideo: boolean;
}

export interface MediaFailure {
  itemUuid: string;
  code: string;
  path: string;
}

// The engine's readiness report (GET /api/project/progress), reduced.
export interface MediaReport {
  loading: boolean;
  failures: MediaFailure[];
  // Item uuids the engine holds a loaded file for. null when the engine does
  // not list them, in which case no cue can be confirmed individually.
  loaded: string[] | null;
}

export interface MediaFacts {
  listReady: boolean;            // this window has the whole cue list
  report: MediaReport | null;    // null: the engine did not answer the readiness request
}

export interface FileFacts {
  hasFile: boolean;
  unsaved: boolean;
  saveFailed: boolean;
  autoSave: boolean;
  repairPending: boolean;
}

export type VideoCheckPhase = 'running' | 'done' | 'stopped' | 'stale' | 'interrupted' | 'unavailable';

// The existing video check's own state; this module never runs that check.
export interface VideoFacts {
  available: boolean;            // this window can run the video check
  phase: VideoCheckPhase | null; // null: not run for this show
  checked: number;
  total: number;
  issueUuids: string[];
}

export interface PreShowCheckInput {
  engine: EngineFacts;
  output: OutputFacts;
  cues: CueFact[];
  media: MediaFacts;
  file: FileFacts;
  video: VideoFacts;
}

// ---- Helpers ---------------------------------------------------------

function line(
  id: CheckLineId,
  status: CheckStatus,
  key: string,
  params?: Record<string, string | number>,
  entries: CheckEntry[] = [],
  problems = status === 'attention' ? 1 : 0,
): CheckLine {
  return {
    id, status, entries, problems,
    title: { key: `showCheck.${id}.title` },
    detail: params ? { key, params } : { key },
    action: null,
  };
}

function cueLabel(cue: CueFact): CheckText | null {
  if (cue.inPlaylist && cue.cueNumber) return { key: 'showCheck.cueNumber', params: { number: cue.cueNumber } };
  if (cue.quickPlayNumber !== null) return { key: 'showCheck.quickPlayNumber', params: { number: cue.quickPlayNumber } };
  return null;
}

function cueEntry(cue: CueFact, prefix: string, detail: CheckText, path: string | null = null): CheckEntry {
  return {
    id: `${prefix}:${cue.uuid}`, status: 'attention', label: cueLabel(cue), name: cue.name, detail,
    itemUuid: cue.inPlaylist ? cue.uuid : null, path,
  };
}

// ---- 1. Audio engine -------------------------------------------------

const normalizeVersion = (version: string | null): string => (version ?? '').trim().replace(/^v/i, '');

export function checkEngine(facts: EngineFacts): CheckLine {
  if (!facts.connected) return line('engine', 'attention', 'showCheck.engine.disconnected');
  if (!facts.answered) return line('engine', 'attention', 'showCheck.engine.noAnswer');
  if (facts.startsHeld) return line('engine', 'attention', 'showCheck.engine.startsHeld');
  const engine = normalizeVersion(facts.engineVersion);
  const app = normalizeVersion(facts.appVersion);
  if (!engine) return line('engine', 'unchecked', 'showCheck.engine.versionNotReported');
  if (!app) return line('engine', 'unchecked', 'showCheck.engine.appVersionUnknown', { engine });
  if (engine !== app) return line('engine', 'attention', 'showCheck.engine.versionMismatch', { engine, app });
  return line('engine', 'pass', 'showCheck.engine.ok', { version: engine });
}

// ---- 2. Output device ------------------------------------------------

export type OutputState = 'ok' | 'stalled' | 'ambiguous' | 'missing';

const LOST_STATES = new Set(['disconnected', 'interrupted', 'closing']);
const usable = (device: OutputDeviceFact): boolean => device.isAvailable && !LOST_STATES.has(device.state);

// Mirrors the engine's own choice (resolve_output_device): an opened device
// matched by id wins; otherwise the hardware name must match exactly one
// available device. A selection the engine cannot resolve will not play.
export function resolveOutput(selection: string, devices: OutputDeviceFact[]): { state: OutputState; name: string } {
  const present = devices.filter(usable);
  const opened = present.filter(device => device.isOpen && device.id === selection);
  const named = present.filter(device => device.name === selection);
  const known = devices.find(device => device.id === selection || device.name === selection)?.name ?? selection;
  if (opened.length > 1) return { state: 'ambiguous', name: known };
  const device = opened[0] ?? (named.length === 1 ? named[0] : undefined);
  if (!device) return { state: named.length > 1 ? 'ambiguous' : 'missing', name: known };
  return { state: device.state === 'stalled' ? 'stalled' : 'ok', name: device.name };
}

const MAIN_KEYS: Record<OutputState, string> = {
  ok: 'showCheck.output.mainOk',
  stalled: 'showCheck.output.mainStalled',
  ambiguous: 'showCheck.output.mainAmbiguous',
  missing: 'showCheck.output.mainMissing',
};

export function checkOutput(facts: OutputFacts, cues: CueFact[]): CheckLine {
  const devices = facts.devices;
  if (!devices) return line('output', 'unchecked', 'showCheck.output.noList');

  let main: { state: OutputState; name: string };
  let mainKey: string;
  if (facts.main) {
    main = resolveOutput(facts.main, devices);
    mainKey = MAIN_KEYS[main.state];
  } else {
    const fallback = devices.find(device => device.isDefault && usable(device));
    main = fallback
      ? { state: fallback.state === 'stalled' ? 'stalled' : 'ok', name: fallback.name }
      : { state: 'missing', name: '' };
    mainKey = main.state === 'ok' ? 'showCheck.output.defaultOk'
      : main.state === 'stalled' ? MAIN_KEYS.stalled : 'showCheck.output.defaultMissing';
  }

  const entries: CheckEntry[] = [];
  for (const [role, selection] of [['preview', facts.preview], ['ltc', facts.ltc]] as const) {
    if (!selection) continue;
    const resolved = resolveOutput(selection, devices);
    entries.push({
      id: role, status: resolved.state === 'ok' ? 'pass' : 'attention',
      label: { key: `showCheck.output.${role}` }, name: resolved.name,
      detail: { key: `showCheck.output.${resolved.state}` }, itemUuid: null, path: null,
    });
  }
  // A cue sent to its own output is only named when that output is a problem.
  const resolvedByName = new Map<string, { state: OutputState; name: string }>();
  for (const cue of cues) {
    if (!cue.output) continue;
    let resolved = resolvedByName.get(cue.output);
    if (!resolved) resolvedByName.set(cue.output, resolved = resolveOutput(cue.output, devices));
    if (resolved.state === 'ok') continue;
    entries.push(cueEntry(cue, 'output', {
      key: `showCheck.output.cue.${resolved.state}`, params: { device: resolved.name },
    }));
  }

  const problems = (main.state === 'ok' ? 0 : 1) + entries.filter(entry => entry.status === 'attention').length;
  return line('output', problems ? 'attention' : 'pass', mainKey,
    main.name ? { name: main.name } : undefined, entries, problems);
}

// ---- 3. Media --------------------------------------------------------

// Engine failure codes → the reason shown. The engine's load-time code does
// not tell a file that is gone from one it cannot decode, so neither do we.
const FAILURE_REASONS: Record<string, string> = {
  missing_media_path: 'noFile',
  decoder_init_failed: 'unreadable',
  load_exception: 'loadFailed',
  media_changed: 'changed',
};

export function checkMedia(cues: CueFact[], facts: MediaFacts): CheckLine {
  if (!facts.listReady) return line('media', 'unchecked', 'showCheck.media.listLoading');
  const report = facts.report;
  if (!report) return line('media', 'unchecked', 'showCheck.media.noReport');
  const total = cues.length;
  if (!total) return line('media', 'pass', 'showCheck.media.none');

  const failures = new Map(report.failures.map(failure => [failure.itemUuid, failure]));
  const loaded = report.loaded ? new Set(report.loaded) : null;
  const entries: CheckEntry[] = [];
  let ready = 0;
  for (const cue of cues) {
    const failure = failures.get(cue.uuid);
    if (failure) {
      const reason = FAILURE_REASONS[failure.code];
      entries.push(cueEntry(cue, 'media', reason
        ? { key: `showCheck.media.reason.${reason}` }
        : { key: 'showCheck.media.reason.failed', params: { code: failure.code } }, failure.path || null));
    } else if (!loaded) {
      continue;
    } else if (loaded.has(cue.uuid)) {
      ready++;
    } else {
      entries.push(cueEntry(cue, 'media', {
        key: report.loading ? 'showCheck.media.reason.loading' : 'showCheck.media.reason.notLoaded',
      }));
    }
  }

  if (!loaded) {
    // An engine that does not list its loaded cues can only report failures,
    // so the cues it did not fail stay unconfirmed rather than counted ready.
    return entries.length
      ? line('media', 'attention', 'showCheck.media.problemsOnly', { count: entries.length, total }, entries, entries.length)
      : line('media', 'unchecked', 'showCheck.media.notListed', { total });
  }
  return line('media', entries.length ? 'attention' : 'pass', 'showCheck.media.ready', { ready, total },
    entries, entries.length);
}

// ---- 4. Show file ----------------------------------------------------

export function checkFile(facts: FileFacts): CheckLine {
  if (!facts.hasFile) return line('file', 'attention', 'showCheck.file.noFile');
  if (facts.saveFailed) return line('file', 'attention', 'showCheck.file.saveFailed');
  if (facts.unsaved) return line('file', 'attention', facts.autoSave ? 'showCheck.file.saving' : 'showCheck.file.unsaved');
  if (facts.repairPending) return line('file', 'attention', 'showCheck.file.repairPending');
  return line('file', 'pass', facts.autoSave ? 'showCheck.file.saved' : 'showCheck.file.savedAutosaveOff');
}

// ---- 5. Video --------------------------------------------------------

// Reports what the existing video check last found and offers the way to it.
// Returns null for a show with no video cues: there is nothing to report.
export function checkVideo(cues: CueFact[], facts: VideoFacts): CheckLine | null {
  const videos = new Set(cues.filter(cue => cue.hasVideo).map(cue => cue.uuid));
  const count = videos.size;
  if (!count) return null;
  if (!facts.available) return line('video', 'unchecked', 'showCheck.video.unavailable', { count });

  const issues = facts.issueUuids.filter(uuid => videos.has(uuid)).length;
  const progress = { checked: facts.checked, total: facts.total };
  // A finished run only speaks for the video cues the show has now.
  const covers = facts.total === count && facts.checked >= count;
  const result = issues
    ? line('video', 'attention', 'showCheck.video.issues', { ...progress, count: issues }, [], issues)
    : facts.phase === 'done' && covers ? line('video', 'pass', 'showCheck.video.passed', progress)
      : facts.phase === 'done' || facts.phase === 'stale' ? line('video', 'unchecked', 'showCheck.video.stale')
        : facts.phase === 'running' ? line('video', 'unchecked', 'showCheck.video.running', progress)
          : facts.phase === null ? line('video', 'unchecked', 'showCheck.video.notRun', { count })
            : line('video', 'unchecked', 'showCheck.video.incomplete', progress);
  result.action = 'open-video-check';
  return result;
}

// ---- Verdict ---------------------------------------------------------

export function summarize(lines: CheckLine[]): PreShowCheckResult {
  const attention = lines.reduce((sum, entry) => sum + entry.problems, 0);
  const unchecked = lines.filter(entry => entry.status === 'unchecked').length;
  if (attention) {
    return {
      lines, attention, unchecked, status: 'attention',
      verdict: { key: attention === 1 ? 'showCheck.verdict.attentionOne' : 'showCheck.verdict.attention', params: { count: attention } },
    };
  }
  return unchecked
    ? { lines, attention, unchecked, status: 'unchecked', verdict: { key: 'showCheck.verdict.incomplete' } }
    : { lines, attention, unchecked, status: 'pass', verdict: { key: 'showCheck.verdict.ready' } };
}

export function runPreShowCheck(input: PreShowCheckInput): PreShowCheckResult {
  const video = checkVideo(input.cues, input.video);
  return summarize([
    checkEngine(input.engine),
    checkOutput(input.output, input.cues),
    checkMedia(input.cues, input.media),
    checkFile(input.file),
    ...(video ? [video] : []),
  ]);
}
