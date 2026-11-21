const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

const rates = ['23.976', '24', '25', '29.97', '30', '50', '59.94', '60.00'];
const broadcastFormats = [
  ...['1080p', '720p', '2160p'].flatMap(scan => rates.map(rate => scan + rate)),
  '1080i50', '1080i59.94', '1080i60.00',
  '480i59.94', '480p59.94', '480i60.00', '480p60.00', '576i50', '576p50',
];
function isSignalFormat(value) {
  return value === 'auto' || value === 'current' || broadcastFormats.includes(value) ||
    (typeof value === 'string' && value.length <= 100 &&
      /^native:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:[\da-f]{1,8}:\d{1,5}x\d{1,5}[ip]:\d{1,10}$/i.test(value));
}

function emptyReport(phase) {
  return { phase, id: null, formats: [], nativeModes: {}, actual: {}, chosen: '', canPresent: false };
}

// One Quartz owner for this desktop session. A revision ties each readback to
// the display, control screen, format and open/closed state that requested it.
function createMacVideoSignal(binaryPath, onReport, launch = spawn) {
  let child = null;
  let config = null;
  let revision = 0;
  let identity = '';
  let retry = null;
  let deadline = null;
  let failures = 0;
  let trial = null;
  let retiring = null;
  let restoreUnconfirmed = false;
  let state = emptyReport('idle');

  function send(assign, apply, close = false) {
    const owner = child;
    const command = { ...config, format: trial?.format ?? config.format,
      id: Number(config.id), control: Number(config.control), assign, apply,
      uuid: identity, revision: ++revision };
    clearTimeout(deadline);
    deadline = setTimeout(() => owner.kill(), 8000);
    const line = JSON.stringify(command) + '\n';
    const sent = error => {
      if (error && owner === child) owner.kill();
    };
    if (close) {
      retiring = { id: config.id };
      owner.stdin.end(line, sent);
    } else {
      owner.stdin.write(line, sent);
    }
  }

  function failTrial(message) {
    if (!trial) return;
    const request = trial;
    trial = null;
    request.reject(new Error(message));
  }

  function start() {
    clearTimeout(retry);
    const owner = launch(binaryPath(), [], { stdio: ['pipe', 'pipe', 'ignore'] });
    child = owner;
    const lines = createInterface({ input: owner.stdout });
    lines.on('line', line => {
      if (owner !== child) return;
      let report;
      try { report = JSON.parse(line); } catch { owner.kill(); return; }
      if (report.revision !== revision) return;
      if (retiring) {
        if (retiring.id === config.id) {
          if (report.uuid) identity = report.uuid;
          if (!config.enabled && report.restoreFailed) restoreUnconfirmed = true;
        }
        return;
      }
      clearTimeout(deadline);
      failures = 0;
      if (report.uuid) identity = report.uuid;
      state = restoreUnconfirmed ? { ...report, restoreFailed: true } : report;
      if (trial) {
        const confirmed = report.canPresent && ['current', 'matched'].includes(report.phase);
        if (confirmed && trial.save(trial.format)) {
          const accepted = trial;
          trial = null;
          config = { ...config, format: accepted.format };
          accepted.resolve();
        } else {
          failTrial(confirmed ? 'Could not save the confirmed video signal format.'
            : 'macOS could not confirm the requested format. Cue is keeping the previous format setting.');
          state = { ...report, phase: 'checking' };
          send(false, !report.canPresent || confirmed);
        }
      }
      onReport();
    });
    owner.stdin.on('error', () => {});
    function lost(error) {
      if (owner !== child) return;
      child = null;
      clearTimeout(deadline);
      lines.close();
      if (retiring) {
        retiring = null;
        state = emptyReport(config.id ? 'checking' : 'idle');
        if (config.id) start();
        onReport();
        return;
      }
      failTrial('The Mac display service stopped before confirming the requested format.');
      state = emptyReport('error');
      onReport();
      // A changed numeric ID cannot establish identity after the helper dies.
      if (config?.id && identity && error?.code !== 'ENOENT') {
        retry = setTimeout(start, Math.min(1000 * 2 ** Math.min(failures++, 4), 15000));
      }
    }
    owner.once('error', lost);
    owner.once('close', () => lost());
    send(true, config.enabled);
  }

  function configure(next) {
    const assign = !config || config.id !== next.id;
    const close = config?.enabled && !next.enabled;
    const apply = assign || !config.enabled || config.format !== next.format;
    if (!assign && config.enabled === next.enabled &&
        config.format === next.format && config.control === next.control) return;
    if (assign || close) failTrial('Video Output changed before confirming the requested format.');
    if (assign || next.enabled) restoreUnconfirmed = false;
    config = next;
    if (assign) identity = '';
    clearTimeout(retry);
    state = assign || !next.enabled || !next.id || next.id === next.control
      ? emptyReport(next.id ? 'checking' : 'idle') : { ...state, phase: 'checking' };
    if (retiring) return;
    // End the app-scoped Quartz session on Close, including after a replug
    // where the helper had to discard the old display-mode reference.
    if (child) send(assign, close ? false : apply, close);
    else if (next.id) start();
  }

  function applyFormat(format, save) {
    if (trial) return Promise.reject(new Error('A video signal format change is already in progress.'));
    return new Promise((resolve, reject) => {
      trial = { format, save, resolve, reject };
      state = { ...state, phase: 'checking' };
      if (!retiring) {
        if (child) send(false, true);
        else start();
      }
      onReport();
    });
  }

  function recheck(apply = false) {
    if (!child || retiring || !config.id) return;
    const restore = !!trial;
    failTrial('The audience display changed before confirming the requested format.');
    // Quartz and Electron announce a replug separately. Invalidate the old
    // readback before a recycled display ID can show the audience window.
    state = emptyReport('checking');
    send(false, (apply || restore) && config.enabled);
    onReport();
  }

  function displayRemoved(id) {
    if (String(id) === (state.id ?? config?.id)) recheck();
  }

  return { configure, applyFormat, displayRemoved, recheck, get state() { return state; } };
}

module.exports = { broadcastFormats, createMacVideoSignal, isSignalFormat };
