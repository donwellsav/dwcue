#!/usr/bin/env node

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LEGACY_DEFAULT_TARGET_DB = -23;
const UNITY = 1.0;

function parseJson(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: invalid JSON (${error.message})`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: expected a JSON object`);
  }
  return value;
}

function collectAudioEntries(root) {
  const entries = [];

  function visit(value, location) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'audio') {
      entries.push({ item: value, location });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${location}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, `${location}.${key}`);
    }
  }

  visit(root, '$');
  return entries;
}

function loadProject(inputPath) {
  const requestedPath = path.resolve(inputPath);
  if (path.extname(requestedPath).toLowerCase() !== '.dwcue') {
    throw new Error(`${requestedPath}: expected a .dwcue show`);
  }
  const filePath = fs.realpathSync(requestedPath);
  if (!fs.statSync(filePath).isFile()) {
    throw new Error(`${filePath}: expected a regular file`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const value = parseJson(raw, filePath);
  if (!Array.isArray(value.items)) {
    throw new Error(`${filePath}: missing project items array`);
  }
  return {
    filePath,
    directory: path.dirname(filePath),
    raw,
    value,
    entries: collectAudioEntries(value),
  };
}

function numberKey(value) {
  return Object.is(value, -0) ? '-0' : String(value);
}

function cueFingerprint(item) {
  if (typeof item.mediaFileName !== 'string' || item.mediaFileName.length === 0) {
    return null;
  }
  const numbers = [item.duration, item.inPoint, item.outPoint, item.volume];
  if (!numbers.every(Number.isFinite)) return null;
  return JSON.stringify([item.mediaFileName, ...numbers.map(numberKey)]);
}

function parseWaveform(value, label) {
  if (Array.isArray(value.channels)) {
    const lanes = value.channels
      .map(channel => channel?.peak)
      .filter(peaks => Array.isArray(peaks) && peaks.length > 0);
    if (lanes.length > 0) {
      for (const lane of lanes) {
        if (!lane.every(Number.isFinite)) {
          throw new Error(`${label}: waveform peaks must be finite numbers`);
        }
      }
      const length = Math.max(...lanes.map(lane => lane.length));
      const peaks = new Array(length).fill(0);
      for (const lane of lanes) {
        for (let index = 0; index < lane.length; index++) {
          const sample = lane[index] ?? 0;
          if (sample > peaks[index]) peaks[index] = sample;
        }
      }
      return {
        peaks,
        duration: Number.isFinite(value.duration)
          ? value.duration
          : (Number.isFinite(value.duration_ms) ? value.duration_ms / 1000 : 0),
      };
    }
  }

  if (Array.isArray(value.peaks) && value.peaks.length > 0) {
    if (!value.peaks.every(Number.isFinite)) {
      throw new Error(`${label}: waveform peaks must be finite numbers`);
    }
    return {
      peaks: value.peaks,
      duration: Number.isFinite(value.duration) ? value.duration : 0,
    };
  }

  throw new Error(`${label}: unsupported waveform JSON`);
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' && !path.isAbsolute(relative);
}

function readWaveform(project, item, cache) {
  if (typeof item.waveformPath !== 'string' || item.waveformPath.length === 0) {
    return { kind: 'missing' };
  }

  const requestedPath = path.resolve(project.directory, item.waveformPath);
  if (!isInside(project.directory, requestedPath)) {
    throw new Error(`${project.filePath}: waveform path escapes the project folder`);
  }
  if (cache.has(requestedPath)) return cache.get(requestedPath);

  let filePath;
  try {
    filePath = fs.realpathSync(requestedPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const missing = { kind: 'missing' };
      cache.set(requestedPath, missing);
      return missing;
    }
    throw error;
  }
  if (!isInside(project.directory, filePath)) {
    throw new Error(`${filePath}: waveform symlink escapes the project folder`);
  }
  if (!fs.statSync(filePath).isFile()) {
    throw new Error(`${filePath}: expected a waveform file`);
  }

  const waveform = {
    kind: 'present',
    ...parseWaveform(
      parseJson(fs.readFileSync(filePath, 'utf8'), filePath),
      filePath,
    ),
  };
  cache.set(requestedPath, waveform);
  return waveform;
}

function legacyTargetDb(project) {
  const levels = project.value?.settings?.outputTargetLevels;
  const target = Number.isFinite(levels?.loudnessTargetLufs)
    ? levels.loudnessTargetLufs
    : levels?.autoVolumeTargetDb;
  return Number.isFinite(target) ? target : LEGACY_DEFAULT_TARGET_DB;
}

function legacyGeneratedVolume(item, waveform, targetDb) {
  const duration = item.duration || waveform.duration || 0;
  if (!(duration > 0) || waveform.peaks.length === 0) return null;

  const start = Math.floor((item.inPoint / duration) * waveform.peaks.length);
  const end = Math.ceil((item.outPoint / duration) * waveform.peaks.length);
  const peaks = waveform.peaks.slice(start, end);
  if (peaks.length === 0) return null;

  let sumSquares = 0;
  for (const sample of peaks) sumSquares += sample * sample;
  const rms = Math.sqrt(sumSquares / peaks.length);
  const intrinsicLoudness = rms <= 0 ? -60 : 20 * Math.log10(rms);
  if (intrinsicLoudness <= -60) return null;

  const gainDb = targetDb - intrinsicLoudness;
  const newVolume = Math.pow(10, gainDb / 20);
  const maxVolume = Math.pow(10, 10 / 20);
  return Math.min(Math.max(newVolume, 0.001), maxVolume);
}

function planRepairs(projects) {
  const waveformCache = new Map();
  const active = [];
  const detached = [];

  for (const project of projects) {
    const targetDb = legacyTargetDb(project);
    for (const entry of project.entries) {
      const fingerprint = cueFingerprint(entry.item);
      if (!fingerprint || entry.item.volume === UNITY) continue;

      const waveform = readWaveform(project, entry.item, waveformCache);
      if (waveform.kind === 'missing') {
        detached.push({ project, entry, fingerprint });
        continue;
      }

      const expected = legacyGeneratedVolume(entry.item, waveform, targetDb);
      if (expected !== null && Object.is(entry.item.volume, expected)) {
        active.push({
          project,
          entry,
          fingerprint,
          kind: 'active',
        });
      }
    }
  }

  const verifiedFingerprints = new Set(active.map(repair => repair.fingerprint));
  return [
    ...active,
    ...detached
      .filter(candidate => verifiedFingerprints.has(candidate.fingerprint))
      .map(candidate => ({ ...candidate, kind: 'detached' })),
  ];
}

function timestamp() {
  return new Date().toISOString().replace(/[-:.]/g, '');
}

function atomicWriteJson(project, serialized) {
  const tempPath = path.join(
    project.directory,
    `.${path.basename(project.filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(
      tempPath,
      'wx',
      fs.statSync(project.filePath).mode & 0o777,
    );
    fs.fchmodSync(descriptor, fs.statSync(project.filePath).mode & 0o777);
    fs.writeFileSync(descriptor, serialized, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    parseJson(fs.readFileSync(tempPath, 'utf8'), tempPath);
    fs.renameSync(tempPath, project.filePath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(tempPath, { force: true });
  }
}

function applyRepairs(repairs, quiet = false) {
  const byProject = new Map();
  for (const repair of repairs) {
    const projectRepairs = byProject.get(repair.project) ?? [];
    projectRepairs.push(repair);
    byProject.set(repair.project, projectRepairs);
  }

  const changes = [];
  for (const [project, projectRepairs] of byProject) {
    for (const repair of projectRepairs) repair.entry.item.volume = UNITY;
    const serialized = JSON.stringify(project.value, null, 2) +
      (project.raw.endsWith('\n') ? '\n' : '');
    parseJson(serialized, `${project.filePath} (generated repair)`);
    changes.push({ project, repairs: projectRepairs, serialized });
  }

  for (const { project } of changes) {
    if (fs.readFileSync(project.filePath, 'utf8') !== project.raw) {
      throw new Error(`${project.filePath}: changed after it was read; refusing to overwrite`);
    }
  }

  const stamp = timestamp();
  for (const change of changes) {
    const backupPath =
      `${change.project.filePath}.gain-repair-backup-${stamp}.bak`;
    fs.copyFileSync(
      change.project.filePath,
      backupPath,
      fs.constants.COPYFILE_EXCL,
    );
    const backupRaw = fs.readFileSync(backupPath, 'utf8');
    if (backupRaw !== change.project.raw) {
      throw new Error(`${backupPath}: backup does not match the source project`);
    }
    parseJson(backupRaw, backupPath);
    change.backupPath = backupPath;
  }

  for (const change of changes) {
    if (fs.readFileSync(change.project.filePath, 'utf8') !== change.project.raw) {
      throw new Error(
        `${change.project.filePath}: changed after backup; refusing to overwrite`,
      );
    }
    atomicWriteJson(change.project, change.serialized);
    if (!quiet) {
      console.log(
        `[repair-generated-auto-gain] repaired ${change.repairs.length} cue(s) in ` +
        `${change.project.filePath}`,
      );
      console.log(
        `[repair-generated-auto-gain] backup: ${change.backupPath}`,
      );
    }
  }
}

function printPlan(repairs, apply) {
  const byProject = new Map();
  for (const repair of repairs) {
    const counts = byProject.get(repair.project.filePath) ??
      { active: 0, detached: 0 };
    counts[repair.kind]++;
    byProject.set(repair.project.filePath, counts);
  }
  for (const [filePath, counts] of byProject) {
    console.log(
      `[repair-generated-auto-gain] ${filePath}: ` +
      `${counts.active} waveform-verified, ${counts.detached} fingerprint-matched`,
    );
  }
  if (!apply && repairs.length > 0) {
    console.log(
      '[repair-generated-auto-gain] dry run only; pass --apply with the same paths to repair',
    );
  }
}

function selfCheck() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dwcue-gain-repair-'));
  try {
    const targetDb = -14;
    const waveformPath = path.join(directory, 'waveforms', 'active.json');
    fs.mkdirSync(path.dirname(waveformPath));
    fs.writeFileSync(
      waveformPath,
      JSON.stringify({
        channels: [
          { peak: [0.25, 0.5, 0.5, 0.25] },
          { peak: [0.2, 0.4, 0.4, 0.2] },
        ],
        duration_ms: 4000,
      }),
    );

    const baseCue = {
      type: 'audio',
      uuid: 'active',
      mediaFileName: 'verified.wav',
      waveformPath: 'waveforms/active.json',
      duration: 4,
      inPoint: 1,
      outPoint: 3,
      volume: 0,
    };
    const waveform = parseWaveform(
      parseJson(fs.readFileSync(waveformPath, 'utf8'), waveformPath),
      waveformPath,
    );
    baseCue.volume = legacyGeneratedVolume(
      baseCue,
      waveform,
      targetDb,
    );
    const wrongCue = {
      ...baseCue,
      uuid: 'wrong',
      mediaFileName: 'wrong.wav',
      volume: baseCue.volume + Number.EPSILON,
    };
    const detachedCue = {
      ...baseCue,
      uuid: 'detached',
      waveformPath: 'waveforms/missing.json',
    };

    const activePath = path.join(directory, 'active.DWCUE');
    const detachedPath = path.join(directory, 'detached.dwcue');
    const activeProject = {
      settings: {
        outputTargetLevels: { loudnessTargetLufs: targetDb },
      },
      items: [baseCue, wrongCue],
    };
    const detachedProject = { items: [detachedCue] };
    fs.writeFileSync(activePath, JSON.stringify(activeProject, null, 2));
    fs.writeFileSync(detachedPath, JSON.stringify(detachedProject, null, 2));
    const legacyPath = path.join(directory, 'legacy.liveplay');
    const legacyRaw = JSON.stringify(activeProject, null, 2);
    fs.writeFileSync(legacyPath, legacyRaw);
    assert.throws(
      () => loadProject(legacyPath),
      /expected a \.dwcue show/,
      'legacy .liveplay input must be rejected',
    );
    assert.equal(
      fs.readFileSync(legacyPath, 'utf8'),
      legacyRaw,
      'rejecting a legacy show must not mutate it',
    );

    const projects = [loadProject(activePath), loadProject(detachedPath)];
    const repairs = planRepairs(projects);
    assert.deepEqual(
      repairs.map(repair => repair.kind).sort(),
      ['active', 'detached'],
    );
    applyRepairs(repairs, true);

    const repairedActive = parseJson(
      fs.readFileSync(activePath, 'utf8'),
      activePath,
    );
    const repairedDetached = parseJson(
      fs.readFileSync(detachedPath, 'utf8'),
      detachedPath,
    );
    assert.deepEqual(repairedActive, {
      ...activeProject,
      items: [{ ...baseCue, volume: UNITY }, wrongCue],
    });
    assert.deepEqual(repairedDetached, {
      ...detachedProject,
      items: [{ ...detachedCue, volume: UNITY }],
    });
    assert.equal(
      planRepairs([loadProject(activePath), loadProject(detachedPath)]).length,
      0,
      'a second run must be a no-op',
    );
    assert.equal(
      fs.readdirSync(directory)
        .filter(name => name.includes('.gain-repair-backup-')).length,
      2,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log('Generated auto-gain repair self-check passed.');
}

function usage() {
  console.log(
    'Usage: node scripts/repair-generated-auto-gain.js [--apply] ' +
    '<show.dwcue> [more.dwcue ...]\n' +
    '       node scripts/repair-generated-auto-gain.js --self-check',
  );
}

function main(argv) {
  let apply = false;
  let selfCheckRequested = false;
  let positionalOnly = false;
  const projectPaths = [];

  for (const argument of argv) {
    if (!positionalOnly && argument === '--') {
      positionalOnly = true;
    } else if (!positionalOnly && argument === '--apply') {
      apply = true;
    } else if (!positionalOnly && argument === '--self-check') {
      selfCheckRequested = true;
    } else if (!positionalOnly && ['--help', '-h'].includes(argument)) {
      usage();
      return;
    } else if (!positionalOnly && argument.startsWith('-')) {
      throw new Error(`unknown option: ${argument}`);
    } else {
      projectPaths.push(argument);
    }
  }

  if (selfCheckRequested) {
    if (apply || projectPaths.length > 0) {
      throw new Error('--self-check does not accept project paths or --apply');
    }
    selfCheck();
    return;
  }
  if (projectPaths.length === 0) {
    usage();
    throw new Error('at least one explicit project path is required');
  }

  const projects = projectPaths.map(loadProject);
  const uniquePaths = new Set(projects.map(project => project.filePath));
  if (uniquePaths.size !== projects.length) {
    throw new Error('duplicate project paths are not allowed');
  }

  const repairs = planRepairs(projects);
  if (repairs.length === 0) {
    console.log('[repair-generated-auto-gain] no verified broken gains found');
    return;
  }
  printPlan(repairs, apply);
  if (apply) applyRepairs(repairs);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`[repair-generated-auto-gain] ${error.message}`);
  process.exitCode = 1;
}
