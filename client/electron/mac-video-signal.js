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
  let state = emptyReport('idle');

  function send(assign, apply) {
    const owner = child;
    const command = { ...config, id: Number(config.id), control: Number(config.control), assign, apply,
      uuid: identity, revision: ++revision };
    clearTimeout(deadline);
    deadline = setTimeout(() => owner.kill(), 8000);
    owner.stdin.write(JSON.stringify(command) + '\n', error => {
      if (error && owner === child) owner.kill();
    });
  }

  function start() {
    const owner = launch(binaryPath(), [], { stdio: ['pipe', 'pipe', 'ignore'] });
    child = owner;
    const lines = createInterface({ input: owner.stdout });
    lines.on('line', line => {
      if (owner !== child) return;
      let report;
      try { report = JSON.parse(line); } catch { owner.kill(); return; }
      if (report.revision !== revision) return;
      clearTimeout(deadline);
      failures = 0;
      if (report.uuid) identity = report.uuid;
      state = report;
      onReport();
    });
    owner.stdin.on('error', () => {});
    function lost(error) {
      if (owner !== child) return;
      child = null;
      clearTimeout(deadline);
      lines.close();
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

  function configure(next, force = false) {
    const assign = !config || config.id !== next.id;
    const apply = force || assign || !config.enabled || config.format !== next.format;
    if (!force && !assign && config.enabled === next.enabled &&
        config.format === next.format && config.control === next.control) return;
    config = next;
    if (assign) identity = '';
    clearTimeout(retry);
    state = assign || !next.enabled || !next.id || next.id === next.control
      ? emptyReport(next.id ? 'checking' : 'idle') : { ...state, phase: 'checking' };
    if (child) send(assign, apply);
    else if (next.id) start();
  }

  function recheck(apply = false) {
    if (!child || !config.id) return;
    // Quartz and Electron announce a replug separately. Invalidate the old
    // readback before a recycled display ID can show the audience window.
    state = emptyReport('checking');
    send(false, apply && config.enabled);
    onReport();
  }

  function displayRemoved(id) {
    if (String(id) === (state.id ?? config?.id)) recheck();
  }

  return { configure, displayRemoved, recheck, get state() { return state; } };
}

module.exports = { broadcastFormats, createMacVideoSignal, isSignalFormat };
