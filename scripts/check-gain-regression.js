const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function sourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, directory), {
    withFileTypes: true,
  })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(relative));
    else if (/\.(?:ts|vue)$/.test(entry.name)) files.push(relative);
  }
  return files;
}

function range(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`);
  return { from, to, source: source.slice(from, to) };
}

function callSites(files, functionName) {
  const sites = [];
  const pattern = new RegExp(`\\b${functionName}\\s*\\(`, 'g');
  for (const [file, source] of files) {
    for (const match of source.matchAll(pattern)) {
      const before = source.slice(Math.max(0, match.index - 80), match.index);
      if (/\bfunction\s*$/.test(before)) continue;
      sites.push({ file, source, index: match.index });
    }
  }
  return sites;
}

const files = sourceFiles('client/app')
  .map(file => [file, read(file)]);
const byFile = new Map(files);

const projectTypes = byFile.get('client/app/types/project.ts');
const defaultSettings = range(
  projectTypes,
  'export const DEFAULT_PROJECT_SETTINGS',
  'export const DEFAULT_AUDIO_ITEM',
).source;
assert.match(defaultSettings, /autoTrimSilenceOnImport:\s*false/,
  'new projects must default automatic trimming off');
assert.match(defaultSettings, /autoMatchLoudnessOnImport:\s*false/,
  'new projects must default automatic loudness matching off');

for (const [name, source] of [
  ['playlist audio', range(
    projectTypes,
    'export const DEFAULT_AUDIO_ITEM',
    'export const DEFAULT_CART_AUDIO_ITEM',
  ).source],
  ['cart audio', range(
    projectTypes,
    'export const DEFAULT_CART_AUDIO_ITEM',
    'export const DEFAULT_GROUP_ITEM',
  ).source],
]) {
  assert.match(source, /volume:\s*1(?:\.0)?\s*,/,
    `${name} must default to unity gain`);
}

let audioConstructors = 0;
for (const [file, source] of files) {
  for (const match of source.matchAll(
    /type:\s*['"]audio['"](?:\s+as\s+const)?\s*,/g,
  )) {
    audioConstructors++;
    const before = source.slice(Math.max(0, match.index - 1000), match.index);
    const spreadAt = Math.max(
      before.lastIndexOf('...DEFAULT_AUDIO_ITEM'),
      before.lastIndexOf('...DEFAULT_CART_AUDIO_ITEM'),
    );
    assert.match(
      before,
      /\.\.\.DEFAULT_(?:CART_)?AUDIO_ITEM/,
      `${file}: imported audio must inherit a unity-gain default`,
    );
    const after = source.slice(match.index);
    const objectEnd = after.match(/\n\s*}\s*(?:as\s+AudioItem)?[,;]/);
    assert.ok(spreadAt >= 0 && objectEnd,
      `${file}: could not isolate imported audio object`);
    assert.doesNotMatch(
      before.slice(spreadAt) + after.slice(0, objectEnd.index),
      /\bvolume\s*:/,
      `${file}: imported audio must not override the unity-gain default`,
    );
  }
}
assert.ok(audioConstructors >= 4,
  'expected playlist, Spotify, YouTube, and cart import constructors');

const useProject = byFile.get('client/app/composables/useProject.ts');
assert.match(
  range(useProject, 'const createNewProject', 'const tryRejoinExistingProject').source,
  /settings:\s*\{\s*\.\.\.DEFAULT_PROJECT_SETTINGS\s*\}/,
  'new .liveplay files must persist safe import defaults',
);

const playlistView = byFile.get('client/app/components/PlaylistView.vue');
const templateSettings = range(
  playlistView,
  'const settings: ProjectSettings =',
  'let templateCommitted',
).source;
assert.match(
  templateSettings,
  /\.\.\.DEFAULT_PROJECT_SETTINGS/,
  'detached Spotify templates must start from safe import defaults',
);
assert.match(
  templateSettings,
  /autoTrimSilenceOnImport:\s*[\s\S]*===\s*true/,
  'template auto-trim must remain off unless explicitly enabled',
);
assert.match(
  templateSettings,
  /autoMatchLoudnessOnImport:\s*[\s\S]*===\s*true/,
  'template loudness matching must remain off unless explicitly enabled',
);
assert.match(
  range(
    playlistView,
    'const templateProject: Project =',
    'const writeResult',
  ).source,
  /\bsettings\s*,/,
  'detached Spotify templates must persist safe import defaults',
);
assert.match(
  range(
    playlistView,
    'const scanForMissingWaveforms',
    'watch(',
  ).source,
  /if \(ai\.waveform\?\.analysis_version === 1\) continue;/,
  'legacy peak-only waveforms must be regenerated once for real analysis',
);

const audioUtils = byFile.get('client/app/utils/audio.ts');
assert.doesNotMatch(
  files.map(([, source]) => source).join('\n'),
  /\bapplyAutoProcessing\b/,
  'the peak-RMS auto-gain path must not return',
);

const loudnessVolume = range(
  audioUtils,
  'export function loudnessMatchedVolume',
  'export function applyLoudnessMatch',
).source;
for (const field of [
  'analysis_version',
  'integrated_lufs',
  'true_peak_dbtp',
  'loudnessTargetLufs',
  'limiterCeilingDb',
]) {
  assert.match(loudnessVolume, new RegExp(`\\b${field}\\b`),
    `measured normalization must consume ${field}`);
}
assert.match(
  loudnessVolume,
  /limiterCeilingDb\s*-\s*\(analysis\.true_peak_dbtp/,
  'normalization gain must respect measured true peak',
);
assert.doesNotMatch(
  loudnessVolume,
  /peaks|calculatePerceivedLoudness|calculateRMS/,
  'normalization must not infer loudness from display peaks',
);

const applyLoudness = range(
  audioUtils,
  'export function applyLoudnessMatch',
  'export function exceedsTruePeakCeiling',
).source;
assert.match(applyLoudness, /loudnessMatchedVolume\(/,
  'the volume mutation must use measured loudness gain');
assert.match(applyLoudness, /item\.volume\s*=\s*volume/,
  'measured normalization must be the only gain assignment');
assert.match(
  audioUtils,
  /export function exceedsTruePeakCeiling[\s\S]*item\.inPoint > 0\.001[\s\S]*outPoint < duration - 0\.001[\s\S]*return false/,
  'whole-file true peak must not produce false warnings for trimmed cues',
);

const properties = byFile.get('client/app/components/PropertiesPanel.vue');
const explicitNormalize = range(
  properties,
  'const handleNormalize',
  'const handleTrimSilence',
);
assert.match(explicitNormalize.source, /fetchWaveform(?:ByPath)?\(/,
  'explicit normalization must request measured analysis');
assert.match(explicitNormalize.source, /\bstartMs\b/,
  'explicit normalization must analyze from the cue in-point');
assert.match(explicitNormalize.source, /\bendMs\b/,
  'explicit normalization must analyze through the cue out-point');
assert.match(explicitNormalize.source, /applyLoudnessMatch\(/,
  'explicit normalization must apply measured analysis');
assert.doesNotMatch(
  explicitNormalize.source,
  /calculatePerceivedLoudness|calculateRMS|\.peaks/,
  'explicit normalization must not use waveform display peaks',
);

let guardedLoudnessCalls = 0;
let explicitLoudnessCalls = 0;
for (const site of callSites(files, 'applyLoudnessMatch')) {
  if (site.file === 'client/app/components/PropertiesPanel.vue' &&
      site.index >= explicitNormalize.from && site.index < explicitNormalize.to) {
    explicitLoudnessCalls++;
    continue;
  }
  const before = site.source.slice(Math.max(0, site.index - 2200), site.index);
  assert.match(
    before,
    /autoMatchLoudnessOnImport\s*===\s*true/,
    `${site.file}: automatic loudness matching must be explicitly opted in`,
  );
  guardedLoudnessCalls++;
}
assert.ok(explicitLoudnessCalls >= 1,
  'expected an explicit measured-normalization call');
assert.ok(guardedLoudnessCalls >= 1,
  'expected an opt-in automatic measured-normalization call');
assert.match(
  useProject,
  /const requestedVolume = \(target as AudioItem\)\.volume[\s\S]*current\.volume !== requestedVolume[\s\S]*return;[\s\S]*applyLoudnessMatch\(/,
  'delayed import analysis must not overwrite an operator volume edit',
);

let guardedTrimCalls = 0;
for (const site of callSites(files, 'trimSilence')) {
  const before = site.source.slice(Math.max(0, site.index - 1000), site.index);
  assert.match(
    before,
    /autoTrimSilenceOnImport\s*===\s*true/,
    `${site.file}: automatic trimming must be explicitly opted in`,
  );
  guardedTrimCalls++;
}
assert.ok(guardedTrimCalls >= 1, 'expected an opt-in automatic trim call');

for (const [file, source] of files) {
  for (const match of source.matchAll(/\bcalculatePerceivedLoudness\s*\(/g)) {
    const context = source.slice(
      Math.max(0, match.index - 1200),
      match.index + 1800,
    );
    assert.doesNotMatch(
      context,
      /(?:item|audioItem|cue|target|current)\.volume\s*=/,
      `${file}: fake perceived loudness must never set cue volume`,
    );
  }
}

const serverTypes = byFile.get('client/app/types/server.ts');
for (const field of ['analysis_version', 'integrated_lufs', 'true_peak_dbtp']) {
  assert.match(serverTypes, new RegExp(`\\b${field}\\b`),
    `client waveform contract must expose ${field}`);
}
assert.match(serverTypes, /\bloudnessTargetLufs\b/,
  'output targets must name an actual LUFS target');

const controlServer = read('server/src/net/control_server.cpp');
const waveformJson = range(
  controlServer,
  'json waveform_data_json',
  'bool current_waveform_cache',
).source;
for (const field of ['analysis_version', 'integrated_lufs', 'true_peak_dbtp']) {
  assert.match(waveformJson, new RegExp(`"${field}"`),
    `server waveform JSON must persist ${field} at top level`);
}

console.log('Gain regression checks passed.');
