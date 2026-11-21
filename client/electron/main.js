const { app, BrowserWindow, View, ipcMain, dialog, shell, Menu, net, session, screen, desktopCapturer, powerSaveBlocker, webContents } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const youtubesearchapi = require('youtube-search-api');
const { promisify } = require('util');
const https = require('https');
const { fileURLToPath } = require('url');
const { PathCapabilityRegistry } = require('./path-capabilities');
const {
  ProjectFileKind,
  canonicalArchivePath,
  fileKindFor,
  getOpenableFileFromArgv,
  shouldRegisterProtocolClient,
  shouldScanInitialOpenFileArgv,
} = require('./project-file-formats');
const {
  shouldForwardVideoOutputShortcut,
  toRendererShortcut,
} = require('./video-output-shortcuts');
const { buildVideoOutputContextTemplate } = require('./video-output-context-menu');
const os = require('node:os');
const { createTestCardConfig, AUDIO_SYNC_RATES } = require('./test-card-config');
const {
  downloadToFile,
  extractTarballEntry,
  ffmpegToolsFor,
  fileMatchesIntegrity,
  toolFileName,
} = require('./ffmpeg-tools');
const { cleanupConnectionFor, TestCardPlayback } = require('./test-card-playback');
const { managedWebSocketHeaders } = require('./managed-websocket-origin');
const { createQuickPlayMutationBroker, validateIdentity, sameIdentity } = require('./quickplay-mutation-broker');
const { findCaptureCue, captureImageUrl } = require('./video-standby-capture');
const { DEFAULT_VIDEO_FRAMING, readVideoFraming, videoFrameCaptureRect } = require('./video-output-framing.mjs');
const { planGeometryCorrection, readViewportReport } = require('./video-output-geometry');
const {
  canToggleOutputFullscreen,
  claimSoleOutput,
  isOutputFullscreen,
  keepOutOfFullscreenSpaces,
  physicalOutputWindowOptions,
  previewWindowOptions,
  releaseOutputFullscreen,
  resolveAssignedDisplay,
  seatPhysicalOutput,
  setOutputFullscreen,
  usesNativeFullscreen,
} = require('./video-output-window');
const { checkVideoFrame } = require('./video-frame-check');
const { convertVideoForOutput, cueSourcePath } = require('./video-convert');
const {
  collectReferences, findUnusedMedia, isPlainFileName, isReferenced, isShowDocument, mediaFilePath, mediaFolderFor,
} = require('./unused-media');
const { createAppLifecycleActions, createWillQuitHandler } = require('./terminal-action');
const { createOperatorManual } = require('./operator-manual');
const {
  CUE_SHEET_LIMITS,
  buildCueSheetHtml,
  cueSheetFileName,
  cueSheetPdfOptions,
  cueSheetWindowOptions,
  normalizeCueSheet,
  normalizeCueSheetLabels,
} = require('./cue-sheet');
const { applyKeepAwake, keepAwakePlan } = require('./keep-awake');
const {
  SPOTIFY_AUDIO_PROVIDERS,
  normalizeSpotifyBitrate,
  normalizeSpotifyRecovery,
  normalizeSpotifyTrackIds,
  renewSpotifyReview,
  spotifyContentParts,
  spotifyReviewIsValid,
  validatedSpotifyUrl,
} = require('./spotify-import-reliability');
const execFilePromise = promisify(execFile);

app.setName('DonWells Cue');

// Product branding changed, but this storage path is an installed-app contract:
// it contains projects, preferences, Chromium state, and the detached server's
// pidfile. Keeping it also lets the new client safely retire a running legacy
// server instead of losing its identity during an upgrade.
// DWCUE_USERDATA overrides it for a dev instance that must run alongside an
// installed production copy (the single-instance lock and server port would
// otherwise collide); it is unset in every packaged build.
app.setPath('userData', process.env.DWCUE_USERDATA || path.join(app.getPath('appData'), 'LivePlay'));

let ffmpegPath = null;
let ffmpegSetupPromise = null;

const MAX_IPC_PATH_LENGTH = 32768;
const MAX_BINARY_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_DOWNLOAD_BYTES = 64 * 1024 * 1024 * 1024;
const pathCapabilities = new PathCapabilityRegistry();
const EXTERNAL_HTTPS_HOSTS = new Set([
  'github.com',
  'www.gnu.org',
  'gnu.org',
  'www.youtube.com',
  'youtube.com',
  'youtu.be',
  'dwcue.com',
  'www.dwcue.com',
]);

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isTrustedRendererUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!app.isPackaged && parsed.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(parsed.hostname) &&
        parsed.port === '3000') {
      return true;
    }
    if (parsed.protocol !== 'file:') return false;
    const rendererRoot = path.resolve(__dirname, '../.output/public');
    return isPathInside(fileURLToPath(parsed), rendererRoot);
  } catch {
    return false;
  }
}

function requireTrustedIpc(event) {
  const senderUrl = event.senderFrame?.url || event.sender?.getURL?.() || '';
  if (!isTrustedRendererUrl(senderUrl)) {
    throw new Error('IPC request rejected from an untrusted renderer');
  }
}

function requireIpcString(value, name, maxLength = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength ||
      value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string no longer than ${maxLength} characters`);
  }
  return value;
}

function requireBoundedIpcObject(value, name, maxBytes) {
  if (value === null) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new RangeError(`${name} exceeds the ${maxBytes}-byte limit`);
  }
  return value;
}

function requireAbsoluteIpcPath(value, name = 'path') {
  const checked = requireIpcString(value, name, MAX_IPC_PATH_LENGTH);
  if (!path.isAbsolute(checked)) throw new TypeError(`${name} must be an absolute path`);
  return path.normalize(checked);
}

function requireAuthorizedIpcPath(value, name = 'path', allowMissing = false) {
  const checked = requireAbsoluteIpcPath(value, name);
  return pathCapabilities.require(checked, { allowMissing, label: name });
}

function isAllowedExternalUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048 ||
      /[\0\r\n]/.test(rawUrl)) {
    return false;
  }
  if (/^mailto:[^?]{1,320}$/i.test(rawUrl)) return true;
  if (/^tel:\+?[0-9(). -]{3,32}$/i.test(rawUrl)) return true;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      EXTERNAL_HTTPS_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function safeOpenExternal(rawUrl) {
  if (!isAllowedExternalUrl(rawUrl)) {
    throw new Error('External URL is not allowed');
  }
  await shell.openExternal(rawUrl);
}

// No window of this app opens a macOS fullscreen Space (video-output-window.js).
app.on('browser-window-created', (_event, window) => keepOutOfFullscreenSpaces(window, process.platform));

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-navigate', (event, targetUrl) => {
    if (operatorManual.owns(contents)) return;
    if (isTrustedRendererUrl(targetUrl)) return;
    event.preventDefault();
    if (isAllowedExternalUrl(targetUrl)) {
      void safeOpenExternal(targetUrl).catch((error) => {
        console.warn('[navigation] failed to open external URL:', error.message);
      });
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void safeOpenExternal(url).catch((error) => {
        console.warn('[navigation] failed to open external URL:', error.message);
      });
    }
    return { action: 'deny' };
  });
});

function cspHashesForInlineScripts(html) {
  return Array.from(
    html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi),
    ([, source]) => source
      ? `'sha256-${crypto.createHash('sha256').update(source, 'utf8').digest('base64')}'`
      : null,
  ).filter(Boolean);
}

function configureSessionSecurity() {
  // Chromium asks for "midiSysex" for every Web MIDI request, including the
  // app's requestMIDIAccess({ sysex: false }); "midi" alone refuses MIDI.
  const allowedPermissions = new Set(['clipboard-read', 'clipboard-sanitized-write', 'midi', 'midiSysex']);
  const permissionAllowed = (webContents, permission) =>
    !!webContents &&
    isTrustedRendererUrl(webContents.getURL()) &&
    allowedPermissions.has(permission);

  session.defaultSession.setPermissionCheckHandler((webContents, permission) =>
    permissionAllowed(webContents, permission));
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) =>
    callback(permissionAllowed(webContents, permission)));

  if (!app.isPackaged) return;
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['ws://127.0.0.1/*'] },
    (details, callback) => {
      const sender = webContents.fromId(details.webContentsId);
      const trusted = !!sender && !sender.isDestroyed() && isTrustedRendererUrl(sender.getURL());
      callback({ requestHeaders: managedWebSocketHeaders(details, liveplayServerIdentity, trusted) });
    },
  );
  const rendererHtml = fs.readFileSync(
    path.join(__dirname, '../.output/public/index.html'), 'utf8');
  const inlineScriptHashes = cspHashesForInlineScripts(rendererHtml).join(' ');
  const csp = [
    "default-src 'self' file:",
    `script-src 'self' file: ${inlineScriptHashes}`,
    "style-src 'self' 'unsafe-inline' file:",
    "img-src 'self' data: blob: file: https:",
    "font-src 'self' data: file:",
    "media-src 'self' data: blob: file: http: https:",
    "connect-src http: https: ws: wss:",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['file://*/*'] },
    (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [csp],
        },
      });
    },
  );
}

// ===========================================================================
// DonWells Cue C++ server lifecycle
// ---------------------------------------------------------------------------
// When the user runs the desktop client in "local" server mode, Electron
// spawns the bundled liveplay-server binary as a *detached* child process —
// it survives renderer reloads and Electron quits. A lockfile records the
// PID + port so the next launch can reattach to the running instance
// instead of spawning a duplicate (which would clash on the same port).
//
// Users can explicitly shut the server down via the
// `liveplay-server:shutdown` IPC handle. Config lives in
// <userData>/liveplay-server.json; lock in <userData>/liveplay-server.lock.
// ===========================================================================
const LIVEPLAY_DEFAULT_PORT = 4480;
const LIVEPLAY_CONFIG_FILENAME = 'liveplay-server.json';
const LIVEPLAY_LOCK_FILENAME   = 'liveplay-server.lock';
let liveplayServerIdentity = null;
let liveplayServerStartPromise = null;
let liveplayServerLifecyclePromise = Promise.resolve();

function liveplayConfigPath() {
  return path.join(app.getPath('userData'), LIVEPLAY_CONFIG_FILENAME);
}
function liveplayLockPath() {
  return path.join(app.getPath('userData'), LIVEPLAY_LOCK_FILENAME);
}

function validManagedAccessToken(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function readLiveplayLock() {
  let fd;
  try {
    const lockPath = liveplayLockPath();
    const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    // Tighten permissions through the already-open descriptor before reading
    // a credential, avoiding both disclosure windows and symlink races.
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) {
      fs.fchmodSync(fd, 0o600);
    }
    const raw = fs.readFileSync(fd, 'utf-8');
    const j = JSON.parse(raw);
    if (Number.isSafeInteger(j.pid) && j.pid > 0 &&
        Number.isSafeInteger(j.port) && j.port >= 1 && j.port <= 65535 &&
        (j.startedAt === undefined ||
         (Number.isSafeInteger(j.startedAt) && j.startedAt > 0)) &&
        (j.instanceToken === undefined ||
         /^[0-9a-f]{32}$/.test(j.instanceToken))) {
      // Keep malformed/missing credentials from becoming usable, but retain
      // the process identity so an owned older generation can be stopped
      // safely instead of launching a second audio engine beside it.
      return {
        ...j,
        accessToken: validManagedAccessToken(j.accessToken) ? j.accessToken : '',
      };
    }
  } catch {} finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; /* process exists but we lack permission */ }
}

function healthMatchesIdentity(health, identity) {
  return health?.pid === identity.pid &&
    /^[0-9a-f]{32}$/.test(identity.instanceToken || '') &&
    health.instanceToken === identity.instanceToken;
}

function isLegacyServerHealth(health) {
  return health?.ok === true &&
    health?.name === 'liveplay-server' &&
    !Object.hasOwn(health, 'pid') &&
    !Object.hasOwn(health, 'instanceToken');
}

function commandLineHasArgPair(commandLine, flag, value) {
  if (typeof commandLine !== 'string') return false;
  const escape = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const optionalQuote = '["\\\']?';
  return new RegExp(
    `(?:^|\\s)${optionalQuote}${escape(flag)}${optionalQuote}` +
    `\\s+${optionalQuote}${escape(value)}${optionalQuote}(?=\\s|$)`,
  ).test(commandLine);
}

function sameExecutablePath(left, right) {
  if (typeof left !== 'string' || !left || typeof right !== 'string' || !right) {
    return false;
  }
  try { left = fs.realpathSync.native(left); } catch { left = path.resolve(left); }
  try { right = fs.realpathSync.native(right); } catch { right = path.resolve(right); }
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function inspectServerProcess(pid) {
  if (process.platform === 'linux') {
    const executable = fs.readlinkSync(`/proc/${pid}/exe`);
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`);
    if (argv.length > 64 * 1024) throw new Error('process command line is too long');
    return {
      executable,
      args: argv.toString('utf8').split('\0').filter(Boolean),
      commandLine: '',
    };
  }
  if (process.platform === 'darwin') {
    const options = { timeout: 2000, maxBuffer: 64 * 1024 };
    const [{ stdout: executable }, { stdout: commandLine }] = await Promise.all([
      execFilePromise('ps', ['-ww', '-p', String(pid), '-o', 'comm='], options),
      execFilePromise('ps', ['-ww', '-p', String(pid), '-o', 'command='], options),
    ]);
    return { executable: executable.trim(), args: null, commandLine };
  }
  if (process.platform === 'win32') {
    const command = [
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
      '$p | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress',
    ].join('; ');
    const { stdout } = await execFilePromise(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      // PowerShell can take several seconds to start on a busy or freshly
      // booted machine. Timing out here reads as "cannot prove it is ours",
      // which blocks stopping or replacing a server that has hung.
      { timeout: 8000, windowsHide: true, maxBuffer: 64 * 1024 },
    );
    const info = JSON.parse(stdout);
    return {
      executable: info?.ExecutablePath,
      args: null,
      commandLine: String(info?.CommandLine || ''),
    };
  }
  throw new Error(`unsupported process identity platform: ${process.platform}`);
}

function processInfoHasArgPair(info, flag, value) {
  if (Array.isArray(info.args)) {
    const index = info.args.indexOf(flag);
    return index >= 0 && info.args[index + 1] === String(value);
  }
  return commandLineHasArgPair(info.commandLine, flag, value);
}

async function processRunsOwnedServer(pid, instanceToken) {
  if (!isPidAlive(pid) || !/^[0-9a-f]{32}$/.test(instanceToken || '')) return false;
  try {
    const info = await inspectServerProcess(pid);
    return sameExecutablePath(info.executable, resolveServerBinaryPath()) &&
      processInfoHasArgPair(info, '--instance-token', instanceToken);
  } catch (error) {
    console.warn('[liveplay-server] process identity probe failed:', error.message);
    return false;
  }
}

async function processRunsLegacyServer(identity) {
  if (!identity || identity.instanceToken || !isPidAlive(identity.pid)) return false;
  try {
    const info = await inspectServerProcess(identity.pid);
    const expectedName = process.platform === 'win32'
      ? 'liveplay-server.exe'
      : 'liveplay-server';
    return path.basename(String(info.executable || '')).toLowerCase() === expectedName &&
      path.basename(path.dirname(String(info.executable || ''))).toLowerCase() === 'server-bin' &&
      processInfoHasArgPair(info, '--port', identity.port) &&
      processInfoHasArgPair(info, '--pidfile', liveplayLockPath());
  } catch (error) {
    console.warn('[liveplay-server] legacy process identity probe failed:', error.message);
    return false;
  }
}

async function terminateLiveplayPid(pid, port, instanceToken, legacy = false) {
  if (!isPidAlive(pid)) return true;
  const identity = { pid, port, instanceToken, legacy };
  const identityMatches = async () => legacy
    ? processRunsLegacyServer(identity)
    : healthMatchesIdentity(await probeServerHealth(port), identity) ||
      await processRunsOwnedServer(pid, instanceToken);
  if (!(await identityMatches())) {
    console.error('[liveplay-server] refusing to signal unverified lock PID:', pid);
    return false;
  }

  try {
    if (process.platform === 'win32') {
      if (!(await identityMatches())) return false;
      await new Promise((resolve) => execFile(
        'taskkill.exe', ['/pid', String(pid), '/T', '/F'],
        { timeout: 3000, windowsHide: true }, resolve,
      ));
    } else {
      process.kill(pid, 'SIGINT');
      const deadline = Date.now() + 2000;
      while (isPidAlive(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (isPidAlive(pid)) {
        if (!(await identityMatches())) return false;
        process.kill(pid, 'SIGKILL');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  } catch (e) {
    console.error('[liveplay-server] kill failed:', e);
  }

  return !isPidAlive(pid);
}

async function probeServerHealth(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = require('http').get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 4096) {
            res.destroy();
            finish(null);
          }
        });
        res.on('end', () => {
          try {
            const health = JSON.parse(body);
            const modern = health?.ok === true &&
              health?.name === 'dwcue-server' &&
              Number.isInteger(health?.pid) &&
              health.pid > 0 &&
              (health.instanceToken === '' ||
               /^[0-9a-f]{32}$/.test(health.instanceToken || ''));
            finish(res.statusCode === 200 && (modern || isLegacyServerHealth(health))
              ? health
              : null);
          } catch {
            finish(null);
          }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error',   () => finish(null));
  });
}

const validTcpPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65535;

// `localPort` is the port the local server uses right now. It is normally the
// configured port. When that port is taken by another program the app moves
// the server to a free one by itself (see launchLiveplayServerWithFallback)
// and remembers it here, so every reader keeps working without knowing.
// `configuredLocalPort` is what the operator chose and what the next fresh
// launch tries first.
function readLiveplayConfig() {
  try {
    const raw = fs.readFileSync(liveplayConfigPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    const configuredLocalPort = Number.isInteger(parsed.localPort) ? parsed.localPort : LIVEPLAY_DEFAULT_PORT;
    const fallback = validTcpPort(parsed.localPortFallback) && parsed.localPortFallbackFor === configuredLocalPort
      ? parsed.localPortFallback : null;
    return {
      mode:      parsed.mode === 'remote' ? 'remote' : 'local',
      remoteUrl: typeof parsed.remoteUrl === 'string' ? parsed.remoteUrl : `http://127.0.0.1:${LIVEPLAY_DEFAULT_PORT}`,
      localPort: fallback ?? configuredLocalPort,
      configuredLocalPort,
    };
  } catch {
    return { mode: 'local', remoteUrl: `http://127.0.0.1:${LIVEPLAY_DEFAULT_PORT}`,
      localPort: LIVEPLAY_DEFAULT_PORT, configuredLocalPort: LIVEPLAY_DEFAULT_PORT };
  }
}

function writeLiveplayConfig(cfg) {
  try {
    const configured = validTcpPort(cfg.configuredLocalPort) ? cfg.configuredLocalPort : cfg.localPort;
    const stored = { mode: cfg.mode, remoteUrl: cfg.remoteUrl, localPort: configured };
    if (cfg.localPort !== configured) {
      stored.localPortFallback = cfg.localPort;
      stored.localPortFallbackFor = configured;
    }
    fs.writeFileSync(liveplayConfigPath(), JSON.stringify(stored, null, 2));
  } catch (e) {
    console.error('[liveplay-server] could not persist config:', e);
  }
}

function importPreferencesPath() {
  return path.join(app.getPath('userData'), 'import-preferences.json');
}

let unsavedImportPreferences = null;

function readImportPreferences() {
  if (unsavedImportPreferences) return unsavedImportPreferences;
  try {
    const value = JSON.parse(fs.readFileSync(importPreferencesPath(), 'utf8'));
    const pickerFolders = value.pickerFolders && typeof value.pickerFolders === 'object' && !Array.isArray(value.pickerFolders)
      ? value.pickerFolders : {};
    if (typeof pickerFolders.media !== 'string' && typeof value.mediaPickerFolder === 'string') {
      pickerFolders.media = value.mediaPickerFolder;
    }
    return {
      spotifyDestination: typeof value.spotifyDestination === 'string' ? value.spotifyDestination : '',
      spotifyRecovery: normalizeSpotifyRecovery(value.spotifyRecovery),
      pickerFolders,
    };
  } catch { return { spotifyDestination: '', spotifyRecovery: null, pickerFolders: {} }; }
}

function writeImportPreferences(value) {
  try {
    fs.writeFileSync(importPreferencesPath(), JSON.stringify(value, null, 2));
    unsavedImportPreferences = null;
    return true;
  } catch (error) {
    // A stale disk record must not resurrect already imported tracks in this session.
    unsavedImportPreferences = value;
    console.warn('[import-preferences] could not save:', error.message);
    return false;
  }
}

function nativePickerFolder(purpose) {
  const folder = readImportPreferences().pickerFolders[purpose];
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return undefined;
  try { return fs.statSync(folder).isDirectory() ? folder : undefined; }
  catch { return undefined; }
}

function rememberNativePickerFolder(purpose, folder) {
  const preferences = readImportPreferences();
  writeImportPreferences({
    ...preferences, pickerFolders: { ...preferences.pickerFolders, [purpose]: folder },
  });
}

let nativeFilePickerOpen = false;
async function showNativeFilePicker(show) {
  if (nativeFilePickerOpen) return { canceled: true };
  nativeFilePickerOpen = true;
  try {
    // The chooser stays independent of the operator window so Stop All remains available.
    return await show();
  } finally {
    nativeFilePickerOpen = false;
  }
}

// ---------------------------------------------------------------------------
// Recent-servers history (separate file so it survives config rewrites).
// Stored newest-first, capped, keyed by normalised URL.
// ---------------------------------------------------------------------------
const LIVEPLAY_RECENT_FILENAME = 'liveplay-recent-servers.json';
const LIVEPLAY_RECENT_MAX      = 8;

function liveplayRecentPath() {
  return path.join(app.getPath('userData'), LIVEPLAY_RECENT_FILENAME);
}

function readRecentServers() {
  try {
    const raw = fs.readFileSync(liveplayRecentPath(), 'utf-8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(e => e && typeof e.url === 'string')
      .map(e => ({
        url:         e.url,
        name:        typeof e.name === 'string' ? e.name : '',
        host:        typeof e.host === 'string' ? e.host : '',
        port:        Number.isInteger(e.port) ? e.port : LIVEPLAY_DEFAULT_PORT,
        lastSeen:    Number.isInteger(e.lastSeen) ? e.lastSeen : 0,
      }))
      .slice(0, LIVEPLAY_RECENT_MAX);
  } catch {
    return [];
  }
}

function writeRecentServers(list) {
  try {
    fs.writeFileSync(liveplayRecentPath(), JSON.stringify(list, null, 2));
  } catch (e) {
    console.warn('[liveplay-discovery] could not persist recent servers:', e);
  }
}

function addRecentServer(entry) {
  if (!entry || typeof entry.url !== 'string' || !entry.url) return readRecentServers();
  // Strip trailing slash so the same server doesn't appear twice.
  const url = entry.url.replace(/\/+$/, '');
  const next = readRecentServers().filter(e => e.url !== url);
  next.unshift({
    url,
    name:     typeof entry.name === 'string' ? entry.name : '',
    host:     typeof entry.host === 'string' ? entry.host : '',
    port:     Number.isInteger(entry.port) ? entry.port : LIVEPLAY_DEFAULT_PORT,
    lastSeen: Date.now(),
  });
  const capped = next.slice(0, LIVEPLAY_RECENT_MAX);
  writeRecentServers(capped);
  return capped;
}

function removeRecentServer(url) {
  if (typeof url !== 'string') return readRecentServers();
  const clean = url.replace(/\/+$/, '');
  const next = readRecentServers().filter(e => e.url !== clean);
  writeRecentServers(next);
  return next;
}

// ---------------------------------------------------------------------------
// Recent-projects history — the last N canonical show files this client opened.
// Stored newest-first, capped, keyed by the project file path. Per-client
// (lives in userData), so it follows the machine rather than the project.
// Surfaced as a File > Open Recent submenu and rebuilt whenever the list
// changes. Paths are server-filesystem paths (the same value openProject
// loads), so they resolve correctly as long as the same server is connected.
// ---------------------------------------------------------------------------
const LIVEPLAY_RECENT_PROJECTS_FILENAME = 'liveplay-recent-projects.json';
const LIVEPLAY_RECENT_PROJECTS_MAX      = 10;

function liveplayRecentProjectsPath() {
  return path.join(app.getPath('userData'), LIVEPLAY_RECENT_PROJECTS_FILENAME);
}

function readRecentProjects() {
  try {
    const raw = fs.readFileSync(liveplayRecentProjectsPath(), 'utf-8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(e => e && typeof e.path === 'string' && e.path)
      .map(e => ({
        path:       e.path,
        name:       typeof e.name === 'string' ? e.name : '',
        folderPath: typeof e.folderPath === 'string' ? e.folderPath : '',
        lastOpened: Number.isInteger(e.lastOpened) ? e.lastOpened : 0,
        // Only entries explicitly recorded from an already-authorized local
        // path can restore local filesystem access. Legacy and remote entries
        // remain useful history but never become capabilities by coincidence.
        localTrusted: e.localTrusted === true,
      }))
      .slice(0, LIVEPLAY_RECENT_PROJECTS_MAX);
  } catch {
    return [];
  }
}

function writeRecentProjects(list) {
  try {
    fs.writeFileSync(liveplayRecentProjectsPath(), JSON.stringify(list, null, 2));
  } catch (e) {
    console.warn('[liveplay-projects] could not persist recent projects:', e);
  }
}

function addRecentProject(entry, localTrusted) {
  if (!entry || typeof entry.path !== 'string' || !entry.path) return readRecentProjects();
  // Normalise separators so the same file doesn't appear twice (e.g. when one
  // open used "/" and another "\"). Compare case-insensitively on Windows.
  const norm = (p) => {
    const s = p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  const key = norm(entry.path);
  const next = readRecentProjects().filter(e => norm(e.path) !== key);
  next.unshift({
    path:       entry.path,
    name:       typeof entry.name === 'string' ? entry.name : '',
    folderPath: typeof entry.folderPath === 'string' ? entry.folderPath : '',
    lastOpened: Date.now(),
    localTrusted: localTrusted === true,
  });
  const capped = next.slice(0, LIVEPLAY_RECENT_PROJECTS_MAX);
  writeRecentProjects(capped);
  return capped;
}

function removeRecentProject(projectPath) {
  if (typeof projectPath !== 'string') return readRecentProjects();
  const norm = (p) => {
    const s = p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  const key = norm(projectPath);
  const next = readRecentProjects().filter(e => norm(e.path) !== key);
  writeRecentProjects(next);
  return next;
}

function clearRecentProjects() {
  writeRecentProjects([]);
  return [];
}

function authorizeOpenableFilePath(filePath) {
  const checked = requireAbsoluteIpcPath(filePath, 'filePath');
  if (!fs.existsSync(checked) || !fs.statSync(checked).isFile()) {
    throw new Error('Selected show/archive file does not exist');
  }
  const kind = fileKindFor(checked);
  if (kind === ProjectFileKind.NativeProject) {
    return pathCapabilities.authorizeProjectFile(checked);
  }
  if (kind !== null) return pathCapabilities.authorizeFile(checked);
  throw new Error('Selected file is not a supported show or archive');
}

function tryAuthorizeOpenableFilePath(filePath) {
  if (typeof filePath !== 'string') return null;
  try {
    const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    return authorizeOpenableFilePath(absolute);
  } catch (error) {
    console.warn('[file-association] rejected file:', error.message);
    return null;
  }
}

function initializeCapabilitiesFromRecentProjects() {
  for (const entry of readRecentProjects()) {
    if (!entry.localTrusted) continue;
    try {
      if (path.isAbsolute(entry.path) && fs.existsSync(entry.path)) {
        authorizeOpenableFilePath(entry.path);
      }
    } catch (error) {
      console.warn('[path-capabilities] skipped stale recent project:', error.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Recovering by itself from the states that used to need a person.
// ---------------------------------------------------------------------------
// The lock file can outlive its server: Windows ends a detached server at
// sign-out or shutdown without letting it clean up, and the process id in the
// lock is later handed to some other program. The checks above rightly refuse
// to touch a live process they cannot prove is ours — but they must not treat
// "could not prove it" as "it is ours" forever. A lock is discarded only on
// positive evidence that no server of ours is behind it.
const LIVEPLAY_SERVER_IMAGE_NAMES = new Set([
  'dwcue-server', 'dwcue-server.exe', 'liveplay-server', 'liveplay-server.exe',
]);

// Program name of a running process, or null when it cannot be read. Only a
// name that was actually read is ever used as evidence.
async function processImageName(pid) {
  try {
    if (process.platform === 'win32') {
      // tasklist ships with every Windows, answers in a fraction of a second,
      // and can name system processes this user is not allowed to open.
      const { stdout } = await execFilePromise(
        'tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        { timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024 },
      );
      const row = /^"([^"]+)","(\d+)"/m.exec(stdout);
      return row && Number(row[2]) === pid ? row[1].toLowerCase() : null;
    }
    const info = await inspectServerProcess(pid);
    return path.basename(String(info.executable || '')).toLowerCase() || null;
  } catch {
    return null;
  }
}

// A lock written before this computer last started cannot belong to anything
// running now, whatever has since been given its process id.
function liveplayLockPredatesBoot() {
  try {
    const startedAt = Date.now() - os.uptime() * 1000;
    return fs.statSync(liveplayLockPath()).mtimeMs < startedAt - 10000;
  } catch {
    return false;
  }
}

// True when `identity` (a lock, or this app's own record) names a live process
// that is provably not a server of ours; the stale record is then removed so
// the next launch is not blocked by it. Callers have already failed to verify
// it as ours through health and process identity.
async function discardStaleLiveplayIdentity(identity) {
  if (!identity || !isPidAlive(identity.pid)) return false;
  const lock = readLiveplayLock();
  const fromLock = !!lock && lock.pid === identity.pid;
  let reason = fromLock && liveplayLockPredatesBoot() ? 'the lock predates the last system start' : '';
  if (!reason) {
    const image = await processImageName(identity.pid);
    if (image && !LIVEPLAY_SERVER_IMAGE_NAMES.has(image)) reason = `its process id now belongs to ${image}`;
  }
  if (!reason) return false;
  console.warn('[liveplay-server] discarding stale server record for pid', identity.pid, '-', reason);
  if (fromLock) {
    try { fs.rmSync(liveplayLockPath(), { force: true }); }
    catch (error) { console.warn('[liveplay-server] could not remove stale lock:', error.message); }
  }
  if (liveplayServerIdentity?.pid === identity.pid) clearLiveplayIdentity();
  return true;
}

// Whether a server could listen on this port right now. Asked before every
// launch because on Windows a second program can bind a port that is already
// being served, and the server would then never be reachable.
function isLoopbackPortFree(port) {
  return new Promise((resolve) => {
    const probe = require('net').createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ host: '127.0.0.1', port }, () => probe.close(() => resolve(true)));
  });
}

// A free port on this computer only, chosen by the operating system.
function findFreeLoopbackPort() {
  return new Promise((resolve) => {
    const probe = require('net').createServer();
    probe.once('error', () => resolve(null));
    probe.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = probe.address();
      probe.close(() => resolve(address && typeof address === 'object' ? address.port : null));
    });
  });
}

// The last thing the server itself said went wrong, if it said so just now.
function lastLiveplayServerLogError() {
  let fd;
  try {
    const file = path.join(app.getPath('userData'), 'logs', 'dwcue-server.log');
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > 60000) return '';
    const length = Math.min(stat.size, 16384);
    const tail = Buffer.alloc(length);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, tail, 0, length, stat.size - length);
    const errors = tail.toString('utf8').split(/\r?\n/).filter(line => line.includes('[ERROR]'));
    return (errors.at(-1) || '')
      .replace(/\u001b\[[0-9;]*m/g, '')
      .replace(/^.*?\[ERROR\]\s*/, '')
      .trim().slice(0, 300);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

function resolveServerBinaryPath() {
  const exeName = process.platform === 'win32' ? 'dwcue-server.exe' : 'dwcue-server';

  if (app.isPackaged) {
    // Bundled via electron-builder extraResources → resourcesPath/server-bin/
    return path.join(process.resourcesPath, 'server-bin', exeName);
  }

  // Dev: client/electron/main.js → ../../server/build/{Release/}<exe>
  const repoServerDir = path.join(__dirname, '..', '..', 'server', 'build');
  const candidates = [
    path.join(repoServerDir, 'Release', exeName),  // MSBuild multi-config
    path.join(repoServerDir, exeName),              // Ninja single-config
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0]; // return first as a useful error path
}

function adoptLiveplayIdentity(identity) {
  liveplayServerIdentity = {
    pid: identity.pid,
    port: identity.port,
    startedAt: identity.startedAt,
    instanceToken: identity.instanceToken,
    accessToken: validManagedAccessToken(identity.accessToken)
      ? identity.accessToken
      : '',
    legacy: identity.legacy === true,
  };
  return liveplayServerIdentity;
}

function sameLiveplayIdentity(left, right) {
  return !!left && !!right &&
    left.pid === right.pid &&
    left.port === right.port &&
    left.instanceToken === right.instanceToken &&
    left.accessToken === right.accessToken &&
    left.startedAt === right.startedAt;
}
function clearLiveplayIdentity(identity = null) {
  if (!identity || sameLiveplayIdentity(liveplayServerIdentity, identity)) {
    liveplayServerIdentity = null;
  }
}

async function verifyLiveplayLock(lock) {
  if (!lock || !isPidAlive(lock.pid)) return null;
  const health = await probeServerHealth(lock.port);
  if (/^[0-9a-f]{32}$/.test(lock.instanceToken || '')) {
    // A tokenless generation from an older release may be stopped only after
    // the existing PID + health/process identity checks prove we own it.
    if ((healthMatchesIdentity(health, lock) ||
        await processRunsOwnedServer(lock.pid, lock.instanceToken)) && isPidAlive(lock.pid)) {
      return { ...lock, legacy: false };
    }
    return null;
  }
  if (isLegacyServerHealth(health) && await processRunsLegacyServer(lock) && isPidAlive(lock.pid)) {
    return { ...lock, legacy: true };
  }
  return null;
}

// A crashing server starts its replacement at once, and the replacement
// publishes its process id before doing anything else. So a replacement shows
// up in the lock within moments or not at all; only one that has shown up is
// worth the longer wait for it to finish starting.
const LIVEPLAY_REPLACEMENT_APPEAR_MS = 3000;

async function waitForCrashReplacement(staleIdentity, timeoutMs = 6500) {
  if (!/^[0-9a-f]{32}$/.test(staleIdentity?.instanceToken || '')) return null;
  // Nothing that died with the last system start is coming back.
  if (liveplayLockPredatesBoot()) return null;
  const started = Date.now();
  const deadline = started + timeoutMs;
  const appearDeadline = started + Math.min(timeoutMs, LIVEPLAY_REPLACEMENT_APPEAR_MS);
  let replacementSeen = false;
  while (Date.now() < deadline) {
    const lock = readLiveplayLock();
    if (lock && lock.pid !== staleIdentity.pid &&
        lock.instanceToken === staleIdentity.instanceToken &&
        lock.accessToken === staleIdentity.accessToken &&
        isPidAlive(lock.pid)) {
      replacementSeen = true;
      const replacement = await verifyLiveplayLock(lock);
      if (replacement) return adoptLiveplayIdentity(replacement);
    }
    if (!replacementSeen && Date.now() >= appearDeadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

// The C++ crash handler replaces the process and rewrites the pidfile. Always
// reconcile that current identity before lifecycle operations so Electron
// never acts on an old in-memory PID.
async function reconcileLiveplayServerIdentity(waitForReplacement = false) {
  const lock = readLiveplayLock();
  const verifiedLock = await verifyLiveplayLock(lock);
  if (verifiedLock) return adoptLiveplayIdentity(verifiedLock);

  if (waitForReplacement && lock && !isPidAlive(lock.pid)) {
    const replacement = await waitForCrashReplacement(lock);
    if (replacement) return replacement;
  }

  const current = liveplayServerIdentity;
  if (current) {
    if (isPidAlive(current.pid)) {
      const health = await probeServerHealth(current.port);
      const owned = current.legacy
        ? await processRunsLegacyServer(current)
        : healthMatchesIdentity(health, current) ||
          await processRunsOwnedServer(current.pid, current.instanceToken);
      if (owned && isPidAlive(current.pid)) {
        return current;
      }
      // A failed probe is not evidence that a live child has exited.
      if (isPidAlive(current.pid)) return null;
    }
    clearLiveplayIdentity(current);
  }
  return null;
}

// Reattach to a verified detached server. A tokenless pre-rebrand server is
// adopted only after both its old health response and exact process arguments
// agree, then replaced once with the tokenized current binary.
function runLiveplayServerOperation(operation) {
  const pending = liveplayServerLifecyclePromise.then(operation);
  liveplayServerLifecyclePromise = pending.catch(() => {});
  return pending;
}

async function tryReattachLiveplayServer() {
  return runLiveplayServerOperation(tryReattachLiveplayServerOnce);
}

async function tryReattachLiveplayServerOnce() {
  const lock = readLiveplayLock();
  if (!lock) return;
  const identity = await reconcileLiveplayServerIdentity(true);
  if (!identity) {
    if (isPidAlive(lock.pid)) {
      console.warn('[liveplay-server] unverified lock PID left untouched:', lock.pid);
    }
    return null;
  }
  console.log('[liveplay-server] reattaching to pid', identity.pid, 'on port', identity.port);
  notifyServerStateChange();

  const cfg = readLiveplayConfig();
  if (cfg.mode === 'remote') {
    await stopVerifiedLiveplayServer(identity);
    return null;
  }
  if (identity.legacy || !validManagedAccessToken(identity.accessToken) ||
      identity.port !== cfg.localPort) {
    if (!(await stopVerifiedLiveplayServer(identity))) return identity;
    return startLiveplayServerOnce();
  }
  return identity;
}

async function startLiveplayServer() {
  if (liveplayServerStartPromise) return liveplayServerStartPromise;
  const pending = runLiveplayServerOperation(startLiveplayServerOnce);
  liveplayServerStartPromise = pending;
  try { return await pending; }
  finally { if (liveplayServerStartPromise === pending) liveplayServerStartPromise = null; }
}

async function startLiveplayServerOnce() {
  let cfg = readLiveplayConfig();
  if (cfg.mode !== 'local') return;

  const current = await reconcileLiveplayServerIdentity(true);
  cfg = readLiveplayConfig();
  if (cfg.mode !== 'local') return null;
  if (current) {
    if (!current.legacy && validManagedAccessToken(current.accessToken) &&
        current.port === cfg.localPort) return current;
    if (!(await stopVerifiedLiveplayServer(current))) return null;
    cfg = readLiveplayConfig();
    if (cfg.mode !== 'local') return null;
  }

  // Never signal, adopt, or overwrite a live PID that failed identity checks:
  // spawning beside a server of ours risks two independent audio engines. A
  // record that provably points at some other program is not such a server;
  // it is discarded so a leftover lock can never keep the app from starting.
  for (const candidate of [readLiveplayLock(), liveplayServerIdentity]) {
    if (!candidate || !isPidAlive(candidate.pid)) continue;
    if (await discardStaleLiveplayIdentity(candidate)) continue;
    console.error('[liveplay-server] refusing to launch beside unverified pid',
                  candidate.pid);
    notifyServerStateChange();
    return null;
  }

  const exePath = resolveServerBinaryPath();
  if (!fs.existsSync(exePath)) {
    console.error('[liveplay-server] binary not found at', exePath,
                  '— skipping spawn. Build the server (cmake --build server/build) or switch to Remote mode.');
    notifyServerStateChange();
    return;
  }

  return launchLiveplayServerWithFallback(exePath, cfg);
}

// Start the server on the operator's port; if it declines to start there,
// move it to a free port instead of leaving the operator with a dead app.
async function launchLiveplayServerWithFallback(exePath, startConfig) {
  let cfg = startConfig;
  // A fresh launch always tries the operator's own port first.
  if (cfg.localPort !== cfg.configuredLocalPort) {
    writeLiveplayConfig({ ...cfg, localPort: cfg.configuredLocalPort });
    cfg = readLiveplayConfig();
  }
  let launch = { identity: null, declined: true };
  if (await isLoopbackPortFree(cfg.localPort)) {
    launch = await launchLiveplayServerProcess(exePath, cfg.localPort);
  } else {
    console.warn('[liveplay-server] port', cfg.localPort, 'is in use by another program');
  }
  if (!launch.identity && launch.declined && readLiveplayConfig().mode === 'local') {
    const fallbackPort = await findFreeLoopbackPort();
    if (fallbackPort && fallbackPort !== cfg.localPort) {
      console.warn('[liveplay-server] server would not start on port', cfg.localPort,
                   '— retrying on free port', fallbackPort);
      writeLiveplayConfig({ ...cfg, localPort: fallbackPort });
      cfg = readLiveplayConfig();
      launch = await launchLiveplayServerProcess(exePath, cfg.localPort);
      if (!launch.identity && launch.declined) {
        // The port was not the reason. Leave the configuration as it was.
        writeLiveplayConfig({ ...cfg, localPort: cfg.configuredLocalPort });
      }
    }
  }
  notifyServerStateChange();
  return launch.identity;
}

// One launch attempt. `declined` means the server ended itself before it was
// ready with its own "could not start" status, as it does for a busy port.
async function launchLiveplayServerProcess(exePath, port) {
  // Launch detached and headless; retain ownership even if readiness stalls.
  const lockPath = liveplayLockPath();
  const instanceToken = crypto.randomBytes(16).toString('hex');
  const accessToken = crypto.randomBytes(32).toString('hex');
  const allowedOrigins = app.isPackaged ? '' : 'http://localhost:3000';
  console.log('[liveplay-server] launching in background', exePath, 'on port', port);
  const serverArgs = [
    '--port',           String(port),
    '--pidfile',        lockPath,
    '--instance-token', instanceToken,
  ];
  let launcher;
  try {
    // All platforms: spawn the server directly and headless. On Windows
    // `windowsHide: true` prevents the console-subsystem server binary from
    // opening a terminal window in the taskbar; server logs remain available
    // via the log file.
    launcher = spawn(exePath, serverArgs, {
      cwd: path.dirname(exePath),
      stdio: 'ignore',
      windowsHide: true,
      detached: true,
      env: {
        ...process.env,
        LIVEPLAY_ACCESS_TOKEN: accessToken,
        LIVEPLAY_ALLOWED_ORIGINS: allowedOrigins,
      },
    });
  } catch (e) {
    console.error('[liveplay-server] spawn failed:', e);
    notifyServerStateChange();
    return { identity: null, declined: false };
  }

  const launchState = { error: null, exitCode: null };
  launcher.once('error', (error) => {
    launchState.error = error;
    console.error('[liveplay-server] spawn failed:', error);
    notifyServerStateChange();
  });
  // The server ends itself with status 1 when it cannot start where it was
  // told to (a busy port above all). A crash ends differently and starts its
  // own replacement, which the readiness wait below still adopts.
  launcher.once('exit', (code) => { launchState.exitCode = code; });

  if (Number.isSafeInteger(launcher.pid) && launcher.pid > 0) {
    adoptLiveplayIdentity({ pid: launcher.pid, port,
      instanceToken, accessToken, legacy: false });
  }
  try { launcher.unref(); } catch {}

  // Readiness still requires the server's authenticated health response.
  const identity = await pollPidfileForServerPid(
    lockPath, instanceToken, accessToken, port, launchState,
  );
  const declined = !identity && launchState.exitCode === 1;
  // A server that has ended is not ours to keep track of.
  if (declined && liveplayServerIdentity?.pid === launcher.pid) clearLiveplayIdentity();

  notifyServerStateChange();
  return { identity, declined };
}

// Watch the pidfile until the server publishes the expected generation (or we
// time out). Crash replacements publish before their hand-off delay, so health
// identity—not mere file presence—is the readiness check.
async function pollPidfileForServerPid(
  lockPath, expectedInstanceToken, expectedAccessToken, expectedPort, launchState,
) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (launchState.error) return null;
    // Declined to start: waiting out the clock would only delay the retry.
    if (launchState.exitCode === 1) return null;
    const lock = readLiveplayLock();
    const health = lock ? await probeServerHealth(lock.port) : null;
    if (lock?.instanceToken === expectedInstanceToken &&
        lock.accessToken === expectedAccessToken &&
        lock.port === expectedPort &&
        healthMatchesIdentity(health, lock)) {
      const identity = adoptLiveplayIdentity({ ...lock, legacy: false });
      notifyServerStateChange();
      return identity;
    }
    await new Promise(r => setTimeout(r, 150));
  }
  console.warn('[liveplay-server] pidfile did not appear at', lockPath,
               '— server may have failed to launch (check the server log).');
  return null;
}

// Stop the detached local server by its verified pidfile identity.
async function stopVerifiedLiveplayServer(identity) {
  if (!identity) return true;
  console.log('[liveplay-server] stopping pid', identity.pid);
  const stopped = await terminateLiveplayPid(
    identity.pid, identity.port, identity.instanceToken, identity.legacy,
  );
  if (stopped) {
    clearLiveplayIdentity(identity);
    // A server ended by force (always, on Windows) cannot remove its own lock.
    // Left behind, it would later name whatever program inherits the id.
    try {
      if (readLiveplayLock()?.pid === identity.pid) fs.rmSync(liveplayLockPath(), { force: true });
    } catch (error) {
      console.warn('[liveplay-server] could not remove the stopped server lock:', error.message);
    }
  }
  notifyServerStateChange();
  return stopped;
}

async function stopLiveplayServer() {
  liveplayServerStartPromise = null;
  return runLiveplayServerOperation(stopLiveplayServerOnce);
}

async function stopLiveplayServerOnce() {
  const identity = await reconcileLiveplayServerIdentity(true);
  if (!identity) {
    // A record that provably points at another program is nothing to stop.
    for (const candidate of [readLiveplayLock(), liveplayServerIdentity]) {
      if (!candidate || !isPidAlive(candidate.pid)) continue;
      if (await discardStaleLiveplayIdentity(candidate)) continue;
      console.error('[liveplay-server] refusing to stop unverified lock PID:',
                    candidate.pid);
      notifyServerStateChange();
      return false;
    }
    clearLiveplayIdentity();
    notifyServerStateChange();
    return true;
  }
  return stopVerifiedLiveplayServer(identity);
}

function liveplayServerStatus() {
  const pid = liveplayServerIdentity?.pid ?? null;
  const accessToken = validManagedAccessToken(liveplayServerIdentity?.accessToken)
    ? liveplayServerIdentity.accessToken
    : '';
  return {
    running: !!pid,
    pid,
    accessToken,
    config: readLiveplayConfig(),
  };
}

function notifyServerStateChange() {
  const status = liveplayServerStatus();
  for (const window of new Set([mainWindow, detachedQuickPlayWindow, videoOutputWindow])) {
    if (window && !window.isDestroyed()) {
      window.webContents.send('liveplay-server:state', status);
    }
  }
}

// IPC: renderer reads/writes config and queries state.
ipcMain.handle('liveplay-server:get-config', (event) => {
  requireTrustedIpc(event);
  return readLiveplayConfig();
});

ipcMain.handle('liveplay-server:set-config', async (event, incoming) => {
  requireTrustedIpc(event);
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw new TypeError('server config must be an object');
  }
  const current = readLiveplayConfig();
  const next = {
    mode: incoming.mode === undefined
      ? current.mode
      : (incoming.mode === 'remote' ? 'remote' : 'local'),
    remoteUrl: typeof incoming.remoteUrl === 'string' && incoming.remoteUrl.length <= 2048
      ? incoming.remoteUrl
      : current.remoteUrl,
    localPort: incoming.localPort === undefined ? current.localPort : incoming.localPort,
  };
  // Sanity: clamp port to a valid TCP range.
  if (!Number.isInteger(next.localPort) || next.localPort < 1 || next.localPort > 65535) {
    next.localPort = LIVEPLAY_DEFAULT_PORT;
  }
  // A fallback port stands in for the configured one. Saving settings that
  // still show it must not turn it into the operator's choice; a different
  // port is a new choice and ends the fallback.
  next.configuredLocalPort = next.localPort === current.localPort
    ? current.configuredLocalPort
    : next.localPort;
  try {
    const remote = new URL(next.remoteUrl);
    if (!['http:', 'https:'].includes(remote.protocol) || remote.username || remote.password) {
      throw new Error('invalid remote URL');
    }
    next.remoteUrl = remote.toString().replace(/\/+$/, '');
  } catch {
    next.remoteUrl = current.remoteUrl;
  }

  writeLiveplayConfig(next);
  notifyServerStateChange();

  liveplayServerStartPromise = null;
  await runLiveplayServerOperation(() => readLiveplayConfig().mode === 'remote'
    ? stopLiveplayServerOnce() : startLiveplayServerOnce());

  notifyServerStateChange();
  return next;
});

ipcMain.handle('liveplay-server:get-status', async (event) => {
  requireTrustedIpc(event);
  await reconcileLiveplayServerIdentity();
  return liveplayServerStatus();
});

// Generic app lifecycle controls used by the connection-lost modal.
// The detached liveplay-server survives ordinary relaunch/exit. Only an explicit
// confirmed stop or the existing updater install path stops it.
const appLifecycleActions = createAppLifecycleActions({
  prepare: prepareForTerminalAction,
  relaunch: () => app.relaunch(),
  exit: (code) => app.exit(code),
  stopServer: stopLiveplayServer,
  installUpdate: installDownloadedUpdate,
});

function sendMainHeaderWarning(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const contents = mainWindow.webContents;
  if (contents.isDestroyed() || contents.isLoadingMainFrame()) return false;
  try {
    contents.send('header-warning', message);
    return true;
  } catch {
    return false;
  }
}

function showTerminalActionFailure(error) {
  const rawDetail = error instanceof Error ? error.message : String(error);
  const detail = rawDetail.slice(0, 2000);
  if (sendMainHeaderWarning(`DonWells Cue could not close safely. ${detail}`)) return;
  dialog.showErrorBox(
    'DonWells Cue could not close safely',
    'The requested action was cancelled because shutdown cleanup did not finish. '
      + 'DonWells Cue remains open so you can resolve the connection or server issue and try again.\n\n'
      + detail,
  );
}

ipcMain.handle('app:relaunch', async (event) => {
  requireTrustedIpc(event);
  try {
    return await appLifecycleActions.relaunch();
  } catch (error) {
    showTerminalActionFailure(error);
    throw error;
  }
});
ipcMain.handle('app:exit', async (event) => {
  requireTrustedIpc(event);
  try {
    return await appLifecycleActions.exit();
  } catch (error) {
    showTerminalActionFailure(error);
    throw error;
  }
});

// Two-step quit confirmation. The renderer drives the dialogs (unsaved
// changes → optionally shut the local audio server down); once the user
// has decided it calls app:confirm-quit. Update-on-exit uses the same
// IPC boundary so the managed server is stopped before replacing binaries.
ipcMain.handle('app:confirm-quit', async (event, opts) => {
  requireTrustedIpc(event);
  try {
    return await appLifecycleActions.confirm(opts);
  } catch (error) {
    showTerminalActionFailure(error);
    throw error;
  }
});

ipcMain.handle('liveplay-server:restart', async (event) => {
  requireTrustedIpc(event);
  liveplayServerStartPromise = null;
  return runLiveplayServerOperation(async () => {
    if (!(await stopLiveplayServerOnce())) return false;
    await startLiveplayServerOnce();
    return true;
  });
});

// Explicit shutdown — the server is now detached, so quitting the
// renderer no longer kills it. The user (or the about-to-quit prompt)
// invokes this when they really want it gone.
ipcMain.handle('liveplay-server:shutdown', async (event) => {
  requireTrustedIpc(event);
  return stopLiveplayServer();
});

// Start the server (if not already running) and wait until /api/health
// answers. The welcome screen calls this when the user picks Local mode
// so the renderer doesn't try to connect before the server is bound.
// Returns { ok, port, accessToken?, error? } — never throws.
// Wait for the server this app owns to answer on `cfg.localPort`. Resolves to
// the result for the renderer, or null when the wait ran out.
async function awaitLiveplayServerHealthy(cfg, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = readLiveplayLock();
    const health = lock?.port === cfg.localPort
      ? await probeServerHealth(cfg.localPort, 800)
      : null;
    const currentConfig = readLiveplayConfig();
    if (currentConfig.mode !== 'local' || currentConfig.localPort !== cfg.localPort) {
      return { ok: false, port: cfg.localPort, error: 'server configuration changed while connecting' };
    }
    if (lock && isPidAlive(lock.pid) && liveplayServerIdentity?.pid === lock.pid &&
        liveplayServerIdentity.instanceToken === lock.instanceToken && healthMatchesIdentity(health, lock)) {
      if (!validManagedAccessToken(lock.accessToken)) {
        return {
          ok: false,
          port: cfg.localPort,
          error: 'owned server must be restarted to enable local authentication',
        };
      }
      const identity = adoptLiveplayIdentity({ ...lock, legacy: false });
      notifyServerStateChange();
      return { ok: true, port: cfg.localPort, accessToken: identity.accessToken };
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

async function ensureLiveplayServerRunning() {
  let cfg = readLiveplayConfig();
  if (cfg.mode !== 'local') {
    return { ok: false, port: cfg.localPort, error: 'config mode is not local' };
  }
  if (!fs.existsSync(resolveServerBinaryPath())) {
    return { ok: false, port: cfg.localPort, error: 'its program file is missing from this installation' };
  }
  try { await startLiveplayServer(); }
  catch (e) { return { ok: false, port: cfg.localPort, error: String(e) }; }
  // The launch may have moved the server to a free port.
  cfg = readLiveplayConfig();
  if (cfg.mode !== 'local') {
    return { ok: false, port: cfg.localPort, error: 'config mode is not local' };
  }

  // The detached server process needs a moment to bind. With no server and no
  // lock at all, the launch already failed and there is nothing to wait for.
  let ready = (liveplayServerIdentity || readLiveplayLock())
    ? await awaitLiveplayServerHealthy(cfg, 10000)
    : null;
  if (!ready) {
    // Running but not answering. Restarting the computer used to be the only
    // cure; restart just the server instead, once. Only a server proven to be
    // ours is ever stopped (stopLiveplayServerOnce refuses anything else).
    const stuck = liveplayServerIdentity;
    if (stuck && isPidAlive(stuck.pid)) {
      console.warn('[liveplay-server] server pid', stuck.pid, 'is running but not answering; restarting it');
      liveplayServerStartPromise = null;
      const restarted = await runLiveplayServerOperation(async () => {
        // Every window asks at once. If another request already replaced the
        // stuck server while this one waited its turn, do not replace it again.
        if (liveplayServerIdentity?.pid !== stuck.pid) return true;
        if (!(await stopLiveplayServerOnce())) return false;
        await startLiveplayServerOnce();
        return true;
      }).catch(() => false);
      if (restarted) {
        cfg = readLiveplayConfig();
        if (cfg.mode === 'local') ready = await awaitLiveplayServerHealthy(cfg, 10000);
      }
    }
  }
  if (ready) return ready;
  // Say what the server itself reported, not just that time ran out.
  const reported = lastLiveplayServerLogError();
  return {
    ok: false,
    port: cfg.localPort,
    error: reported ? `it reported: ${reported}` : 'it did not respond in time',
  };
}

// What the running engine says about itself: its version and whether it is in use.
function fetchEngineSummary(port, accessToken, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const req = require('http').get({
      host: '127.0.0.1', port, path: '/api/state/summary', timeout: timeoutMs,
      headers: { Authorization: `Bearer ${accessToken}` },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4 * 1024 * 1024) { res.destroy(); finish(null); }
      });
      res.on('end', () => {
        try { finish(res.statusCode === 200 ? JSON.parse(body) : null); } catch { finish(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  });
}

// The engine keeps running after the app quits, so an updated app can find the
// previous version's engine still there and would talk to it in a newer
// dialect. Swap it for the engine this app ships with, but only while it is
// doing nothing: no show open, nothing loading, nothing playing. An engine in
// use is never interrupted; it is replaced the next time it is found idle.
let engineUpdateCheck = null;   // shared by every window asking at once
let engineUpdateSettled = false;

async function replaceOutdatedIdleEngine(ready) {
  const summary = await fetchEngineSummary(ready.port, ready.accessToken);
  const engineVersion = summary?.server?.version;
  if (typeof engineVersion !== 'string') return ready;
  if (engineVersion === app.getVersion()) {
    engineUpdateSettled = true;
    return ready;
  }
  const inUse = summary.project?.hasOpenProject !== false || summary.project?.audioLoading === true ||
    !Array.isArray(summary.playing) || summary.playing.length > 0;
  if (inUse) {
    console.warn('[liveplay-server] engine', engineVersion, 'is older than this app but in use; leaving it running');
    return ready;
  }
  // One swap per run: if the replacement reports the same version, the
  // installation itself is mismatched and restarting again cannot help.
  engineUpdateSettled = true;
  console.log('[liveplay-server] replacing idle engine', engineVersion, 'with', app.getVersion());
  if (!(await stopLiveplayServer())) return ready;
  return ensureLiveplayServerRunning();
}

async function ensureCurrentEngineRunning() {
  const ready = await ensureLiveplayServerRunning();
  if (!ready?.ok || engineUpdateSettled) return ready;
  if (!engineUpdateCheck) {
    engineUpdateCheck = replaceOutdatedIdleEngine(ready)
      .catch(() => ready)
      .finally(() => { engineUpdateCheck = null; });
  }
  return engineUpdateCheck;
}

ipcMain.handle('liveplay-server:ensure-running', async (event) => {
  requireTrustedIpc(event);
  return ensureCurrentEngineRunning();
});

// ---------------------------------------------------------------------------
// Engine self-test, used by the release build
// ---------------------------------------------------------------------------
// `--engine-self-test=<file>` starts the audio engine exactly the way choosing
// "This computer" does, writes what happened to <file>, stops the engine and
// exits (0 = healthy). The release build runs it against the packaged app so
// an installer whose engine cannot start is never published.
function engineSelfTestResultPath(argv) {
  const prefix = '--engine-self-test=';
  const arg = argv.find(value => typeof value === 'string' && value.startsWith(prefix));
  const target = arg ? arg.slice(prefix.length) : '';
  return path.isAbsolute(target) ? target : null;
}

function liveplayServerLogTail(maxBytes = 12288) {
  let fd;
  try {
    const file = path.join(app.getPath('userData'), 'logs', 'dwcue-server.log');
    const stat = fs.statSync(file);
    const length = Math.min(stat.size, maxBytes);
    const tail = Buffer.alloc(length);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, tail, 0, length, stat.size - length);
    return tail.toString('utf8').replace(/\u001b\[[0-9;]*m/g, '');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

async function runEngineSelfTest(resultPath) {
  const result = {
    ok: false,
    appVersion: app.getVersion(),
    platform: `${process.platform}-${process.arch}`,
    engineBinary: resolveServerBinaryPath(),
  };
  // A check that hangs must still end with a verdict.
  setTimeout(() => {
    result.error = 'the check did not finish within 90 seconds';
    result.engineLog = liveplayServerLogTail();
    try { fs.writeFileSync(resultPath, JSON.stringify(result, null, 2)); } catch { /* reported by exit code */ }
    app.exit(1);
  }, 90000).unref();
  try {
    writeLiveplayConfig({ ...readLiveplayConfig(), mode: 'local' });
    const started = await ensureLiveplayServerRunning();
    result.port = started?.port ?? null;
    if (!started?.ok) {
      result.error = started?.error || 'the engine did not start';
    } else {
      const summary = await fetchEngineSummary(started.port, started.accessToken, 5000);
      result.engineVersion = summary?.server?.version ?? null;
      if (!summary) result.error = 'the engine started but did not answer an authenticated request';
      else if (result.engineVersion !== result.appVersion) {
        result.error = `the packaged engine is version ${result.engineVersion}, the app is ${result.appVersion}`;
      } else result.ok = true;
    }
  } catch (error) {
    result.error = String(error?.message || error);
  }
  try {
    result.stopped = await stopLiveplayServer();
    if (result.ok && !result.stopped) { result.ok = false; result.error = 'the engine did not stop'; }
  } catch (error) {
    result.ok = false;
    result.error = 'stopping the engine failed: ' + String(error?.message || error);
  }
  result.engineLog = liveplayServerLogTail();
  try { fs.writeFileSync(resultPath, JSON.stringify(result, null, 2)); }
  catch (error) { console.error('[engine-self-test] could not write the result:', error.message); }
  console.log('[engine-self-test]', result.ok ? 'passed' : `failed: ${result.error}`);
  app.exit(result.ok ? 0 : 1);
}

// ===========================================================================
// LAN auto-discovery — listen for the C++ server's UDP beacon and surface
// every nearby server in the welcome screen's remote-mode picker.
// ---------------------------------------------------------------------------
// We bind a single dgram socket lazily on first discover-start request and
// keep it alive for the rest of the process — repeatedly binding/closing
// causes brief windows where beacons are missed. Last-seen entries are
// pruned after 12 s so a server that's been turned off disappears from
// the picker quickly enough to feel responsive.
// ===========================================================================
const dgram = require('dgram');
const DISCOVERY_PORT     = 4481;
const DISCOVERY_TIMEOUT  = 12000;
const DISCOVERY_GROUP    = '239.255.69.80';   // must match server DiscoveryConfig
const SOLICIT_PACKET     = Buffer.from(JSON.stringify({ type: 'liveplay-solicit' }), 'utf-8');
let discoverySocket  = null;
let discoveryStarted = false;
let solicitTimer     = null;
const discoveredServers = new Map(); // key: instanceId, value: {entry, lastSeen}

// Send an active "who's there" probe. Servers reply with a UNICAST beacon
// straight back to us — which traverses WiFi client-isolation and stateful
// firewalls that silently drop inbound broadcast/multicast. We fan it out to
// the limited broadcast and the multicast group; the unicast reply is what
// actually gets discovery working across awkward networks.
function sendSolicitation() {
  if (!discoverySocket) return;
  const targets = ['255.255.255.255', DISCOVERY_GROUP];
  for (const addr of targets) {
    try {
      discoverySocket.send(SOLICIT_PACKET, 0, SOLICIT_PACKET.length, DISCOVERY_PORT, addr);
    } catch {}
  }
}

function startDiscoveryListener() {
  if (discoveryStarted) return;
  discoveryStarted = true;
  try {
    discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  } catch (e) {
    console.warn('[liveplay-discovery] createSocket failed:', e);
    discoveryStarted = false;
    return;
  }
  discoverySocket.on('error', (err) => {
    console.warn('[liveplay-discovery] socket error:', err.message);
  });
  discoverySocket.on('message', (buf, rinfo) => {
    let msg;
    try { msg = JSON.parse(buf.toString('utf-8')); } catch { return; }
    // Ignore our own solicitations (and anything that isn't a beacon).
    if (!msg || msg.type !== 'liveplay-beacon') return;
    const id = String(msg.instanceId || `${rinfo.address}:${msg.port}`);
    const entry = {
      instanceId:     id,
      name:           String(msg.name || 'liveplay'),
      host:           rinfo.address,                       // LAN IP the packet came from
      port:           Number.isInteger(msg.port) ? msg.port : 4480,
      version:        String(msg.version || ''),
      projectName:    String(msg.projectName || ''),
      hasOpenProject: !!msg.hasOpenProject,
      itemCount:      Number.isInteger(msg.itemCount) ? msg.itemCount : 0,
      url:            `http://${rinfo.address}:${Number.isInteger(msg.port) ? msg.port : 4480}`,
    };
    discoveredServers.set(id, { entry, lastSeen: Date.now() });
    broadcastDiscovered();
  });
  try {
    // Bind on 0.0.0.0:DISCOVERY_PORT to receive broadcasts. reuseAddr lets
    // multiple DonWells Cue clients on the same machine coexist.
    discoverySocket.bind(DISCOVERY_PORT, () => {
      try { discoverySocket.setBroadcast(true); } catch {}
      // Join the multicast group on all interfaces (no iface arg = default
      // chosen by the OS; we also try each known interface below). Some
      // networks pass multicast where broadcast is filtered.
      try { discoverySocket.addMembership(DISCOVERY_GROUP); } catch {}
      try {
        const os = require('os');
        const ifaces = os.networkInterfaces();
        for (const name of Object.keys(ifaces)) {
          for (const ni of ifaces[name] || []) {
            if (ni.family === 'IPv4' && !ni.internal) {
              try { discoverySocket.addMembership(DISCOVERY_GROUP, ni.address); } catch {}
            }
          }
        }
      } catch {}
      console.log('[liveplay-discovery] listening on UDP/' + DISCOVERY_PORT);
      // Kick off discovery immediately with a short burst so the picker
      // populates within a second instead of waiting for a passive beacon.
      sendSolicitation();
      setTimeout(sendSolicitation, 250);
      setTimeout(sendSolicitation, 750);
    });
  } catch (e) {
    console.warn('[liveplay-discovery] bind failed:', e);
  }

  // Keep soliciting on an interval — cheap, and means servers that come up
  // later (or clients that just opened the picker) are found promptly even
  // if their broadcasts aren't reaching us.
  solicitTimer = setInterval(sendSolicitation, 3000);
  solicitTimer.unref?.();

  // Periodically prune stale entries.
  setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [id, v] of discoveredServers) {
      if (now - v.lastSeen > DISCOVERY_TIMEOUT) {
        discoveredServers.delete(id);
        changed = true;
      }
    }
    if (changed) broadcastDiscovered();
  }, 4000).unref();
}

function broadcastDiscovered() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const list = Array.from(discoveredServers.values()).map(v => v.entry);
  mainWindow.webContents.send('liveplay-discovery:servers', list);
}

ipcMain.handle('liveplay-discovery:start', (event) => {
  requireTrustedIpc(event);
  startDiscoveryListener();
  sendSolicitation();             // fresh probe whenever the picker opens
  broadcastDiscovered();          // immediate refresh for the new subscriber
  return true;
});

ipcMain.handle('liveplay-discovery:list', (event) => {
  requireTrustedIpc(event);
  return Array.from(discoveredServers.values()).map(v => v.entry);
});

// Fire an on-demand solicitation (e.g. user hit a "rescan" button).
ipcMain.handle('liveplay-discovery:solicit', (event) => {
  requireTrustedIpc(event);
  startDiscoveryListener();
  sendSolicitation();
  return true;
});

// Recent-servers history — the robust fallback when discovery can't reach a
// server (different subnet, VPN, locked-down WiFi). The renderer records a
// server here whenever it successfully connects, and reads the list to offer
// one-tap reconnect + auto-reconnect on launch.
ipcMain.handle('liveplay-discovery:recent-list', (event) => {
  requireTrustedIpc(event);
  return readRecentServers();
});

ipcMain.handle('liveplay-discovery:recent-add', (event, entry) => {
  requireTrustedIpc(event);
  requireBoundedIpcObject(entry, 'recent server entry', 16 * 1024);
  return addRecentServer(entry);
});

ipcMain.handle('liveplay-discovery:recent-remove', (event, url) => {
  requireTrustedIpc(event);
  requireIpcString(url, 'url', 2048);
  return removeRecentServer(url);
});

// Recent-projects history — last N canonical shows opened on this client.
// Every mutation rebuilds the menu so the File > Open Recent submenu stays
// in sync without the renderer having to poke the menu directly.
ipcMain.handle('liveplay-projects:recent-list', (event) => {
  requireTrustedIpc(event);
  return readRecentProjects();
});

ipcMain.handle('liveplay-projects:recent-add', (event, entry) => {
  requireTrustedIpc(event);
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      typeof entry.path !== 'string' || entry.path.length > MAX_IPC_PATH_LENGTH) {
    throw new TypeError('recent project entry is invalid');
  }
  let localTrusted = false;
  let storedEntry = entry;
  if (path.isAbsolute(entry.path) &&
      fileKindFor(entry.path) === ProjectFileKind.NativeProject &&
      fs.existsSync(entry.path) && pathCapabilities.allows(entry.path)) {
    const trustedProjectPath = pathCapabilities.authorizeProjectFile(
      pathCapabilities.require(entry.path, { label: 'projectPath' }),
    );
    storedEntry = {
      ...entry,
      path: trustedProjectPath,
      folderPath: path.dirname(trustedProjectPath),
    };
    localTrusted = true;
  }
  const list = addRecentProject(storedEntry, localTrusted);
  createMenu(currentLocale, isDevMode);
  return list;
});

ipcMain.handle('liveplay-projects:recent-remove', (event, projectPath) => {
  requireTrustedIpc(event);
  requireIpcString(projectPath, 'projectPath', MAX_IPC_PATH_LENGTH);
  const list = removeRecentProject(projectPath);
  createMenu(currentLocale, isDevMode);
  return list;
});

ipcMain.handle('liveplay-projects:recent-clear', (event) => {
  requireTrustedIpc(event);
  const list = clearRecentProjects();
  createMenu(currentLocale, isDevMode);
  return list;
});

// ===========================================================================
// ffmpeg + ffprobe for the YouTube and Spotify importers
// ---------------------------------------------------------------------------
// These are not in the installer. The first import that needs them downloads
// the builds pinned in ffmpeg-tools.js into userData/bin; nothing is fetched
// at startup, or ever for a show that does not use the importers. Both
// programs share one folder because yt-dlp and spotDL look for ffprobe beside
// ffmpeg. (The audio engine decodes with its own FFmpeg and needs neither.)
// ===========================================================================
const FFMPEG_TOOL_NAMES = Object.freeze(['ffmpeg', 'ffprobe']);

function ffmpegBinDir() {
  return path.join(app.getPath('userData'), 'bin');
}

function ffmpegToolPath(tool) {
  return path.join(ffmpegBinDir(), toolFileName(tool, process.platform));
}

function ffmpegReceiptPath() {
  return path.join(ffmpegBinDir(), 'ffmpeg-tools.json');
}

// What was installed, and from which pinned download.
function readFfmpegReceipt() {
  try {
    const receipt = JSON.parse(fs.readFileSync(ffmpegReceiptPath(), 'utf8'));
    return receipt && typeof receipt === 'object' && !Array.isArray(receipt) ? receipt : {};
  } catch {
    return {};
  }
}

async function ffmpegToolRuns(toolPath, timeout = 10000) {
  try {
    await execFilePromise(toolPath, ['-version'], { timeout, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// An installed tool is used only while it is the build this version of the
// app pins and its file is unchanged since it was verified.
async function installedFfmpegToolIsCurrent(tool, pinned, receipt) {
  const entry = receipt[tool];
  if (!entry || entry.source !== pinned.integrity || typeof entry.sha256 !== 'string') return false;
  return await hasExpectedSha256(ffmpegToolPath(tool), entry.sha256) &&
    await ffmpegToolRuns(ffmpegToolPath(tool));
}

async function installFfmpegTool(tool, pinned) {
  const toolPath = ffmpegToolPath(tool);
  const archivePath = path.join(ffmpegBinDir(), tool + '.download.tgz');
  // The candidate keeps the program's own file name so it can be run for the
  // check below on every platform.
  const candidateDir = path.join(ffmpegBinDir(), tool + '.candidate');
  const candidatePath = path.join(candidateDir, toolFileName(tool, process.platform));
  fs.rmSync(candidateDir, { recursive: true, force: true });
  fs.mkdirSync(candidateDir, { recursive: true });
  try {
    await downloadToFile(net.fetch, pinned.url, archivePath);
    if (!await fileMatchesIntegrity(archivePath, pinned.integrity)) {
      throw new Error(tool + ' download failed its integrity check');
    }
    const entryName = 'package/' + toolFileName(tool, process.platform);
    if (!await extractTarballEntry(archivePath, entryName, candidatePath)) {
      throw new Error(tool + ' was missing from its download');
    }
    if (process.platform !== 'win32') fs.chmodSync(candidatePath, 0o755);
    // A security scan of a new program can make its first run slow.
    if (!await ffmpegToolRuns(candidatePath, 30000)) {
      throw new Error('downloaded ' + tool + ' did not run');
    }
    const sha256 = await sha256File(candidatePath);
    replaceVerifiedFile(candidatePath, toolPath);
    return { source: pinned.integrity, sha256 };
  } finally {
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(candidateDir, { recursive: true, force: true });
  }
}

async function installPinnedFfmpeg(pinned) {
  fs.mkdirSync(ffmpegBinDir(), { recursive: true });
  const receipt = readFfmpegReceipt();
  const results = await Promise.allSettled(FFMPEG_TOOL_NAMES.map(async (tool) => {
    if (await installedFfmpegToolIsCurrent(tool, pinned[tool], receipt)) return;
    console.log('Installing integrity-verified ' + tool + '...');
    receipt[tool] = await installFfmpegTool(tool, pinned[tool]);
  }));
  // Keep whichever tool did install, so a retry only fetches what is missing.
  fs.writeFileSync(ffmpegReceiptPath(), JSON.stringify(receipt, null, 2));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return ffmpegToolPath('ffmpeg');
}

// Used only when the pinned build cannot be installed.
async function findSystemFfmpeg() {
  try {
    const locate = process.platform === 'win32' ? 'where.exe' : 'which';
    const { stdout } = await execFilePromise(locate, ['ffmpeg'], { timeout: 5000, windowsHide: true });
    const candidate = stdout.split(/\r?\n/)[0].trim();
    return candidate && await ffmpegToolRuns(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

async function initializeFfmpeg() {
  ffmpegPath = null;
  try {
    const pinned = ffmpegToolsFor(process.platform, process.arch);
    if (pinned) {
      try {
        ffmpegPath = await installPinnedFfmpeg(pinned);
        console.log('ffmpeg ready:', ffmpegPath);
        return true;
      } catch (error) {
        console.error('Failed to install verified ffmpeg:', error.message);
      }
    }
    ffmpegPath = await findSystemFfmpeg();
    if (ffmpegPath) console.log('Using system ffmpeg:', ffmpegPath);
  } catch (error) {
    console.error('Failed to set up ffmpeg:', error.message);
  }
  return Boolean(ffmpegPath);
}

// Shared by every import in flight; a failure is forgotten so the next import
// tries again rather than staying broken until the app is restarted.
function setupFfmpeg() {
  if (!ffmpegSetupPromise) {
    ffmpegSetupPromise = initializeFfmpeg().then((ready) => {
      if (!ready) ffmpegSetupPromise = null;
      return ready;
    });
  }
  return ffmpegSetupPromise;
}

// ===========================================================================
// yt-dlp + deno (JS runtime) management
// ---------------------------------------------------------------------------
// Runtime tools are pinned deliberately. Their release assets are accepted
// only when they match checksums published with those exact GitHub releases;
// changing a version therefore requires reviewing and updating this table.
// yt-dlp publishes SHA2-256SUMS; Deno publishes <asset>.sha256sum files.
// Deno binary hashes below are derived from those verified release archives.
// ===========================================================================
const YT_DLP_RELEASE = Object.freeze({
  version: '2026.08.19',
  assets: Object.freeze({
    'darwin:arm64': {
      name: 'yt-dlp_macos',
      sha256: '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202',
    },
    'darwin:x64': {
      name: 'yt-dlp_macos',
      sha256: '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202',
    },
    'linux:x64': {
      name: 'yt-dlp_linux',
      sha256: '58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a',
    },
    'win32:x64': {
      name: 'yt-dlp.exe',
      sha256: '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a',
    },
  }),
});

const DENO_RELEASE = Object.freeze({
  tag: 'v2.9.4',
  version: '2.9.4',
  assets: Object.freeze({
    'darwin:arm64': {
      name: 'deno-aarch64-apple-darwin.zip',
      archiveSha256: '6d17647fdbf9c587a581dba205054c4ccf732dae0a196cc1e9b44c07589db412',
      binarySha256: '433088c827fa0e39ff162ab0e475f1fd4c7690eaedec500cf678edc3865e9287',
    },
    'darwin:x64': {
      name: 'deno-x86_64-apple-darwin.zip',
      archiveSha256: 'f757df6d3991e37601c69fad56c22b37c4ea77b5dcfad3636a642c2ba4c9b19f',
      binarySha256: 'e0d641386d4f396414da81fa4cfda7b73533ce092a8e12ab0f0551d1a2bc8dcd',
    },
    'linux:x64': {
      name: 'deno-x86_64-unknown-linux-gnu.zip',
      archiveSha256: 'c24f955d9fbfe0ea5ae2b501c8e71ae76e31e4c9782390a54a284b3364fda725',
      binarySha256: '1d97ecaf9e6bbb2a99e991caaf64ba9d62bf98759e8ef9938b9005855772b017',
    },
    'win32:x64': {
      name: 'deno-x86_64-pc-windows-msvc.zip',
      archiveSha256: '68ed08b05c56cf887e9aa509947dc3f468f7e12f47a13e5c1abd51d46d1453ef',
      binarySha256: '4a2757fe99afc2c62c46500c8221cfa0189ac4bfb7064141875ad9c0f04b60ef',
    },
  }),
});

const SPOTDL_RELEASE = Object.freeze({
  tag: 'v4.5.2',
  version: '4.5.2',
  assets: Object.freeze({
    'darwin:arm64': {
      name: 'spotdl-4.5.2-darwin',
      sha256: '0e6a1b704253eda7dda7e85e2a8137b024fdd09cf94e9ab6286350dee95fcabc',
    },
    'linux:x64': {
      name: 'spotdl-4.5.2-linux',
      sha256: '5d7db2fe9adefdea7544413c1a0cca6e913c23376bf5763c172729b4e434b25d',
    },
    'win32:x64': {
      name: 'spotdl-4.5.2-win32.exe',
      sha256: '4490ae3b38c4321173e17975a9990a130cf9a9aea8132ee2978afecefbeeb477',
    },
  }),
});

let ytDlpPath;
let ytDlpReady = false;
let denoPath = null;
let denoReady = false;
let spotDlPath = null;
let spotDlSetupPromise = null;

function currentReleaseAsset(release) {
  return release.assets[process.platform + ':' + process.arch] || null;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function hasExpectedSha256(filePath, expected) {
  if (!fs.existsSync(filePath)) return false;
  try {
    return (await sha256File(filePath)) === expected;
  } catch {
    return false;
  }
}

async function downloadVerifiedFile(url, destination, expectedSha256) {
  const temporaryPath = destination + '.download';
  if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  try {
    // Electron's network stack follows the system proxy settings, and the
    // download gives up when the connection stalls instead of hanging.
    await app.whenReady();
    await downloadToFile(net.fetch, url, temporaryPath);
    const actualSha256 = await sha256File(temporaryPath);
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        'checksum mismatch (expected ' + expectedSha256 + ', got ' + actualSha256 + ')',
      );
    }
    return temporaryPath;
  } catch (error) {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    throw error;
  }
}

function replaceVerifiedFile(candidatePath, destinationPath) {
  const backupPath = destinationPath + '.bak';
  if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
  if (fs.existsSync(destinationPath)) fs.renameSync(destinationPath, backupPath);
  try {
    fs.renameSync(candidatePath, destinationPath);
  } catch (error) {
    if (fs.existsSync(backupPath) && !fs.existsSync(destinationPath)) {
      fs.renameSync(backupPath, destinationPath);
    }
    throw error;
  }
  if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
}

// Run <binary> --version without involving a shell.
async function getBinaryVersion(binaryPath, timeout = 10000) {
  try {
    const { stdout } = await execFilePromise(binaryPath, ['--version'], {
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function initializeYtDlp() {
  ytDlpReady = false;
  ytDlpPath = null;
  const asset = currentReleaseAsset(YT_DLP_RELEASE);
  if (!asset) {
    console.warn(
      'No checksum-pinned yt-dlp asset for ' + process.platform + '/' + process.arch +
      '; automatic installation is disabled.',
    );
    return false;
  }

  try {
    const binDir = path.join(app.getPath('userData'), 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const binaryPath = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    const installedVersion = await getBinaryVersion(binaryPath);
    const installedIsVerified =
      installedVersion === YT_DLP_RELEASE.version &&
      await hasExpectedSha256(binaryPath, asset.sha256);

    if (!installedIsVerified) {
      const url =
        'https://github.com/yt-dlp/yt-dlp/releases/download/' +
        YT_DLP_RELEASE.version + '/' + asset.name;
      console.log('Installing checksum-verified yt-dlp ' + YT_DLP_RELEASE.version + '...');
      const candidatePath = await downloadVerifiedFile(url, binaryPath, asset.sha256);
      if (process.platform !== 'win32') fs.chmodSync(candidatePath, 0o755);
      if (await getBinaryVersion(candidatePath) !== YT_DLP_RELEASE.version) {
        fs.unlinkSync(candidatePath);
        throw new Error('downloaded yt-dlp reported an unexpected version');
      }
      replaceVerifiedFile(candidatePath, binaryPath);
    }

    if (!await hasExpectedSha256(binaryPath, asset.sha256)) {
      throw new Error('installed yt-dlp failed checksum verification');
    }
    ytDlpPath = binaryPath;
    ytDlpReady = true;
    console.log('yt-dlp ready (' + YT_DLP_RELEASE.version + ')');
    return true;
  } catch (error) {
    console.error('Failed to initialize verified yt-dlp:', error.message);
    return false;
  }
}

async function initializeDeno() {
  denoReady = false;
  denoPath = null;
  const asset = currentReleaseAsset(DENO_RELEASE);
  if (!asset) {
    console.warn(
      'No checksum-pinned deno asset for ' + process.platform + '/' + process.arch +
      '; automatic installation is disabled.',
    );
    return false;
  }

  let archivePath = null;
  let extractDir = null;
  try {
    const binDir = path.join(app.getPath('userData'), 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const exeName = process.platform === 'win32' ? 'deno.exe' : 'deno';
    const binaryPath = path.join(binDir, exeName);
    const versionOutput = await getBinaryVersion(binaryPath);
    const installedVersion = versionOutput?.match(/deno\s+(\d+\.\d+\.\d+)/i)?.[1] || null;
    const installedIsVerified =
      installedVersion === DENO_RELEASE.version &&
      await hasExpectedSha256(binaryPath, asset.binarySha256);

    if (!installedIsVerified) {
      const url =
        'https://github.com/denoland/deno/releases/download/' +
        DENO_RELEASE.tag + '/' + asset.name;
      console.log('Installing checksum-verified deno ' + DENO_RELEASE.version + '...');
      archivePath = await downloadVerifiedFile(
        url,
        path.join(binDir, asset.name),
        asset.archiveSha256,
      );
      extractDir = fs.mkdtempSync(path.join(binDir, 'deno-extract-'));
      const extractZip = require('extract-zip');
      await extractZip(archivePath, { dir: extractDir });
      const candidatePath = path.join(extractDir, exeName);
      if (!await hasExpectedSha256(candidatePath, asset.binarySha256)) {
        throw new Error('extracted deno failed checksum verification');
      }
      if (process.platform !== 'win32') fs.chmodSync(candidatePath, 0o755);
      const candidateVersion =
        (await getBinaryVersion(candidatePath))?.match(/deno\s+(\d+\.\d+\.\d+)/i)?.[1] || null;
      if (candidateVersion !== DENO_RELEASE.version) {
        throw new Error('downloaded deno reported an unexpected version');
      }
      replaceVerifiedFile(candidatePath, binaryPath);
    }

    if (!await hasExpectedSha256(binaryPath, asset.binarySha256)) {
      throw new Error('installed deno failed checksum verification');
    }
    denoPath = binaryPath;
    denoReady = true;
    console.log('deno ready (' + DENO_RELEASE.version + ')');
    return true;
  } catch (error) {
    console.error('Failed to initialize verified deno:', error.message);
    return false;
  } finally {
    if (archivePath && fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
    if (extractDir && fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  }
}

async function initializeSpotDl() {
  spotDlPath = null;
  const asset = currentReleaseAsset(SPOTDL_RELEASE);
  if (!asset) {
    console.warn(
      'No checksum-pinned spotDL asset for ' + process.platform + '/' + process.arch +
      '; Spotify import is unavailable on this platform.',
    );
    return false;
  }

  try {
    const binDir = path.join(app.getPath('userData'), 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const binaryPath = path.join(
      binDir,
      process.platform === 'win32' ? 'spotdl.exe' : 'spotdl',
    );
    const installedIsVerified =
      await getBinaryVersion(binaryPath, 30000) === SPOTDL_RELEASE.version &&
      await hasExpectedSha256(binaryPath, asset.sha256);

    if (!installedIsVerified) {
      const url =
        'https://github.com/spotDL/spotify-downloader/releases/download/' +
        SPOTDL_RELEASE.tag + '/' + asset.name;
      console.log('Installing checksum-verified spotDL ' + SPOTDL_RELEASE.version + '...');
      const candidatePath = await downloadVerifiedFile(url, binaryPath, asset.sha256);
      if (process.platform !== 'win32') fs.chmodSync(candidatePath, 0o755);
      if (await getBinaryVersion(candidatePath, 30000) !== SPOTDL_RELEASE.version) {
        fs.unlinkSync(candidatePath);
        throw new Error('downloaded spotDL reported an unexpected version');
      }
      replaceVerifiedFile(candidatePath, binaryPath);
    }

    if (!await hasExpectedSha256(binaryPath, asset.sha256)) {
      throw new Error('installed spotDL failed checksum verification');
    }
    spotDlPath = binaryPath;
    console.log('spotDL ready (' + SPOTDL_RELEASE.version + ')');
    return true;
  } catch (error) {
    console.error('Failed to initialize verified spotDL:', error.message);
    return false;
  }
}

function setupSpotDl() {
  if (!spotDlSetupPromise) {
    spotDlSetupPromise = initializeSpotDl().then((ready) => {
      if (!ready) spotDlSetupPromise = null;
      return ready;
    });
  }
  return spotDlSetupPromise;
}

// Start initialization immediately (concurrently; both are independent).
// yt-dlp and Deno are fetched in the background at startup so the first import
// is quick. A computer that was offline then is not left without them: each
// failed attempt is forgotten, and the next import simply tries again.
let ytDlpSetupPromise = null;
function setupYtDlp() {
  if (!ytDlpSetupPromise) {
    ytDlpSetupPromise = initializeYtDlp().then((ready) => {
      if (!ready) ytDlpSetupPromise = null;
      return ready;
    });
  }
  return ytDlpSetupPromise;
}

let denoSetupPromise = null;
function setupDeno() {
  if (!denoSetupPromise) {
    denoSetupPromise = initializeDeno().then((ready) => {
      if (!ready) denoSetupPromise = null;
      return ready;
    });
  }
  return denoSetupPromise;
}

void setupYtDlp();
const denoInitialization = setupDeno();

let mainWindow = null;
// Set by the updater after it completes shutdown preparation.
let quitConfirmed = false;
let currentProject = null;
let currentProjectData = null; // Full project data synced between Electron windows
let currentProjectIdentity = null; // Separate ownership fence; never merged into project documents
let currentCaptureSession = null;
let fileToOpen = null; // Store file path if app is opened with a file
let stateViewerWindow = null; // Debug state viewer window
let detachedQuickPlayWindow = null;  // Detached QuickPlay window
const quickPlayMutationBroker = createQuickPlayMutationBroker({
  getQuickPlayWebContents: () => detachedQuickPlayWindow?.webContents ?? null,
  getPrimaryWebContents: () => mainWindow?.webContents ?? null,
  getCurrentIdentity: () => currentProjectIdentity,
});

// Check if --dev flag is present in command line arguments
const isDevMode = process.argv.includes('--dev') || !app.isPackaged;

const operatorManual = createOperatorManual({
  onFocus: () => createMenu(currentLocale, isDevMode),
  onClosed: () => createMenu(currentLocale, isDevMode),
  onOpenError: sendMainHeaderWarning,
});
app.on('browser-window-focus', (_event, window) => {
  if (!operatorManual.owns(window.webContents)) createMenu(currentLocale, isDevMode);
});

// Configure auto-updater
autoUpdater.autoDownload = false; // Don't auto-download, ask user first
// Installation is always explicit: Install Now calls quitAndInstall, while
// Install on Exit arms a guarded quit path in the renderer.
autoUpdater.autoInstallOnAppQuit = false;

// The update feed is the DonWells Cue GitHub Releases of this repository.
// Pin it explicitly (setFeedURL) rather than trusting the app-update.yml
// electron-builder derives from package.json "repository": a fork rename or
// a dev build would otherwise silently retarget updates at some other repo's
// binaries. The repo ships signed+notarized macOS and (for now) unsigned
// Windows installers; the updater itself enforces macOS notarization via
// Squirrel.Mac and Windows signature checks are publisher-gated by
// app-update.yml only when a publisher name is configured (currently none).
autoUpdater.setFeedURL({
  provider: 'github',
  owner: 'donwellsav',
  repo: 'dwcue',
});

// Linux: only an AppImage build can update in place. Package installs
// (deb/rpm and other non-AppImage packages) can still discover releases, but
// their installers must be obtained from the downloads page. electron-updater
// uses AppImageUpdater for Linux by default, whose isUpdaterActive() returns
// false when APPIMAGE is absent. Force that updater's check-only path for a
// packaged non-AppImage install; download-update and install-update remain
// blocked by updatesInstallSupported.
const isLinuxAppImage =
  process.platform === 'linux' && process.env.APPIMAGE != null;
const updatesInstallSupported =
  process.platform === 'darwin' ||
  process.platform === 'win32' ||
  (isLinuxAppImage && app.isPackaged);

if (process.platform === 'linux' && app.isPackaged && !isLinuxAppImage) {
  autoUpdater.forceDevUpdateConfig = true;
}

// True when the update flow is active. Always true now that the branded
// release feed exists; the flag stays as a single switch for the safety
// script to assert on and for any future channel-splitting.
const DWCUE_UPDATES_CONFIGURED = true;

// Manual check semantics: the Help → "Check for Updates…" item wants explicit
// feedback for BOTH outcomes ("update available" and "you're up to date").
// autoUpdater.checkForUpdates() emits update-available / update-not-available
// events itself; route the not-available case back to the renderer so it can
// show a transient confirmation instead of doing nothing.
let manualCheckPending = false;
// electron-updater reports installer-launch failures through its error event
// instead of throwing from quitAndInstall. Keep the close veto armed only
// while an install attempt is actually live.
let updateInstallAttemptActive = false;
let downloadedUpdateVersion = '';
// A downloaded update must not replace the app while the detached audio
// server still owns files from the current installation (especially the old
// Windows executable). Both Install Now and Install on Exit use this helper.
async function installDownloadedUpdate({ runAfterInstall = true } = {}) {
  if (!DWCUE_UPDATES_CONFIGURED || !updatesInstallSupported || !downloadedUpdateVersion) return false;
  try {
    await prepareForTerminalAction();
    const serverStopped = await stopLiveplayServer();
    if (!serverStopped) {
      console.error('[update] refusing install while the managed server is running');
      return false;
    }
    const shouldRunAfterInstall = runAfterInstall !== false;
    // BaseUpdater uses autoRunAppAfterInstall for non-silent installs. The
    // exit path is silent on Windows and must also set this property because
    // MacUpdater reads it later when Squirrel finishes downloading.
    autoUpdater.autoRunAppAfterInstall = shouldRunAfterInstall;
    updateInstallAttemptActive = true;
    quitConfirmed = true;
    autoUpdater.quitAndInstall(!shouldRunAfterInstall, shouldRunAfterInstall);
    return updateInstallAttemptActive;
  } catch (error) {
    updateInstallAttemptActive = false;
    autoUpdater.autoRunAppAfterInstall = true;
    quitConfirmed = false;
    console.error('[update] failed to prepare install:', error);
    return false;
  }
}

autoUpdater.on('update-not-available', (info) => {
  console.log('Update not available. Current version is latest:', info.version);
  if (manualCheckPending && mainWindow) {
    manualCheckPending = false;
    mainWindow.webContents.send('update-up-to-date', { version: info.version });
  }
});

autoUpdater.on('checking-for-update', () => {
  console.log('Checking for updates...');
});

autoUpdater.on('update-available', (info) => {
  console.log('Update available:', info.version);
  manualCheckPending = false;
  if (mainWindow) {
    mainWindow.webContents.send('update-available', {
      currentVersion: app.getVersion(),
      newVersion: info.version,
      releaseNotes: info.releaseNotes,
      releaseDate: info.releaseDate
    });
  }
});

autoUpdater.on('error', (err) => {
  console.error('Error in auto-updater:', err);
  manualCheckPending = false;
  if (updateInstallAttemptActive) {
    updateInstallAttemptActive = false;
    quitConfirmed = false;
    autoUpdater.autoRunAppAfterInstall = true;
  }
  if (mainWindow) mainWindow.webContents.send('update-error', err.message);
});
autoUpdater.on('download-progress', (progressObj) => {
  console.log(`Download speed: ${progressObj.bytesPerSecond} - Downloaded ${progressObj.percent}%`);
  if (mainWindow) {
    mainWindow.webContents.send('update-download-progress', {
      percent: progressObj.percent,
      transferred: progressObj.transferred,
      total: progressObj.total
    });
  }
});

autoUpdater.on('update-downloaded', (info) => {
  downloadedUpdateVersion = info.version;
  console.log('Update downloaded:', info.version);
  if (mainWindow) {
    mainWindow.webContents.send('update-downloaded', {
      version: info.version
    });
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    icon: path.join(__dirname, '../assets/icons/2x/app_icon_darkmode@2x.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
    show: false
  });

  // Use the global isDevMode flag
  if (isDevMode) {
    mainWindow.loadURL('http://localhost:3000');
    // Open DevTools in development
    mainWindow.webContents.openDevTools();
  } else {
    // In production, load the generated static files
    const indexPath = path.join(__dirname, '../.output/public/index.html');
    console.log('Loading production index from:', indexPath);
    console.log('File exists:', fs.existsSync(indexPath));
    
    mainWindow.loadFile(indexPath).catch(err => {
      console.error('Failed to load index.html:', err);
    });
  }

  // Log any loading errors
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load:', errorCode, errorDescription);
  });
  reloadAfterRendererCrash(mainWindow, 'main-window');

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Veto the first close so the renderer can run its quit-confirmation
  // flow (unsaved changes → optionally shut the local audio server down).
  // Confirmed quits exit after cleanup. An unresponsive renderer cannot
  // present the prompt, so leave that window's native close available.
  let responsive = true;
  mainWindow.on('unresponsive', () => { responsive = false; });
  mainWindow.on('responsive', () => { responsive = true; });
  mainWindow.on('close', (e) => {
    if (quitConfirmed || !responsive) return;
    if (!mainWindow || mainWindow.webContents.isDestroyed() || mainWindow.webContents.isCrashed()) return;
    // Packaged-app smoke test launches with --smoke-quit: no human is
    // present to answer the quit-confirmation dialogs, so skip the veto.
    if (process.argv.includes('--smoke-quit')) return;
    e.preventDefault();
    mainWindow.webContents.send('app:request-quit');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Nothing reports for the show any more: let the computer sleep again.
    releaseKeepAwake();
  });


  createMenu('en', isDevMode);
}

// A crashed operator or QuickPlays window comes back by itself: it reloads,
// and the operator window rejoins the show the engine is still playing, so
// keys, MIDI and Stop All return. One that keeps crashing reloads less often.
function reloadAfterRendererCrash(window, label) {
  const crashes = [];
  let pending = null;
  window.webContents.on('render-process-gone', (_event, details) => {
    const reason = details?.reason || 'unknown';
    console.error(`[${label}] Renderer stopped:`, reason, details?.exitCode ?? 'unknown');
    if (reason === 'clean-exit' || quitConfirmed) return;
    if (pending) return;   // one reload covers crashes reported together
    const now = Date.now();
    while (crashes.length && now - crashes[0] > 60_000) crashes.shift();
    crashes.push(now);
    pending = setTimeout(() => {
      pending = null;
      if (quitConfirmed) return;
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.reload();
    }, crashes.length > 3 ? 10_000 : 250);
  });
}

// Create the detached QuickPlays window.
function createDetachedQuickPlayWindow() {
  if (detachedQuickPlayWindow) {
    detachedQuickPlayWindow.focus();
    return;
  }

  detachedQuickPlayWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 380,
    minHeight: 400,
    title: 'DonWells Cue - QuickPlays',
    icon: path.join(__dirname, '../assets/icons/2x/app_icon_darkmode@2x.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    }
  });

  if (isDevMode) {
    detachedQuickPlayWindow.loadURL('http://localhost:3000/?quickPlayWindow=1');
  } else {
    const indexPath = path.join(__dirname, '../.output/public/index.html');
    detachedQuickPlayWindow.loadFile(indexPath, { query: { quickPlayWindow: '1' } });
  }

  detachedQuickPlayWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('[QuickPlaysWindow] Failed to load:', errorCode, errorDescription);
  });
  reloadAfterRendererCrash(detachedQuickPlayWindow, 'QuickPlaysWindow');

  detachedQuickPlayWindow.on('closed', () => {
    detachedQuickPlayWindow = null;
    if (mainWindow) {
      mainWindow.webContents.send('detached-quickplay-window-closed');
    }
  });

  // Notify main window that QuickPlay window is open
  detachedQuickPlayWindow.webContents.once('did-finish-load', () => {
    if (mainWindow) {
      mainWindow.webContents.send('detached-quickplay-window-opened');
    }
  });
}
// ===========================================================================
// Video Output window (video playback, slice 1 — see VIDEO_PLAYBACK_V1.md).
//
// One session-scoped, borderless, always-on-top window covering the display
// the operator assigned as the video output (typically the HDMI feed to a
// switcher/projector), and only that display: which display that is, and how
// the window takes it over on each platform, is decided in
// video-output-window.js. The Nuxt page at ?videoOutput=1 renders the layer
// stack (black / standby image / per-cue image / muted video); this block owns
// the window, display assignment, shortcut forwarding, and show hygiene.
//
// Neither the display assignment nor open/closed state is persisted: every
// app launch starts closed with no display assigned, so a stale assignment
// cannot black out the operator's control screen or close the preview.
// Framing and test card settings are kept in <userData>/video-output.json.
// ===========================================================================
const VIDEO_OUTPUT_CONFIG_FILENAME = 'video-output.json';

let videoOutputWindow = null;
let videoOutputSessionEnabled = false;
let videoOutputPowerSaveId = null;
let videoOutputWatchdogInstalled = false;
let videoOutputWatchdogTimer = null;
let videoOutputTestCard = false;
let videoOutputPlaybackError = null;
let videoOutputRendererReady = false;
let videoOutputRendererResponsive = true;
let videoOutputRecoveryRequired = false;
let videoOutputRestarting = false;
// Automatic Restart Output after a crash or a hang (see scheduleVideoOutputRestart).
const videoOutputAutoRestarts = [];
let videoOutputAutoRestartTimer = null;
let videoOutputReadyTimer = null;
let videoOutputReadyLimitMs = 15_000;
let videoOutputPictureHealth = null;
const videoOutputDiagnostics = [];
let capturingVideoStandby = false;
let displayIdentifierWindows = [];
let displayIdentifierTimer = null;
const videoOutputWindowsPreservingSession = new WeakSet();

// Placement check for a physical output (see video-output-geometry.js). The
// output page reports what it really covers; main puts back a window that is
// on a screen it was not given (any platform) or that falls short of its
// display (Windows), and records what it measured and did in
// <userData>/video-output-geometry.json so a fault on someone else's machine
// can be read afterwards instead of guessed at.
const VIDEO_OUTPUT_GEOMETRY_FILENAME = 'video-output-geometry.json';
const newVideoOutputGeometry = (fullscreenWanted = false) => ({
  report: null,          // latest measurement from the output page
  corrections: 0,        // attempts made on this window
  fullscreenWanted,      // the operator's last choice, not our own transitions
  busy: false,           // a correction is being applied
  settleTimer: null,
  uncovered: false,      // gave up: the operator is warned
  compensated: false,    // bounds enlarged on purpose: no longer evidence of position
  recorded: null,        // outcome last written to disk
  actions: [],
});
let videoOutputGeometry = newVideoOutputGeometry();
function resetVideoOutputGeometry(fullscreenWanted = false) {
  clearTimeout(videoOutputGeometry.settleTimer);
  videoOutputGeometry = newVideoOutputGeometry(fullscreenWanted);
}

let videoOutputTestCardConnection = null;
const testCardPlayback = new TestCardPlayback({
  assetPath: (rate) => {
    if (!AUDIO_SYNC_RATES.includes(rate)) throw new Error('Invalid AV Sync frame rate');
    const root = app.isPackaged
      ? path.join(app.getAppPath().replace(/\.asar$/, '.asar.unpacked'), '.output', 'public')
      : path.join(app.getAppPath(), 'public');
    return path.join(root, 'assets', 'testcards', 'audiosync', rate + '.webm');
  },
  onChange: () => broadcastVideoOutputStatus(),
});

function reconcileTestCardPlayback() {
  const config = readVideoOutputConfig().testCardConfig;
  const active = videoOutputTestCard && videoOutputWindow && !videoOutputWindow.isDestroyed()
    && config.cardType === 'audioSync' && videoOutputTestCardConnection;
  return testCardPlayback.update(active ? {
    rate: config.audioSync.rate,
    deviceId: config.audioSync.deviceId,
    connection: videoOutputTestCardConnection,
  } : null, videoOutputTestCardConnection);
}

async function setVideoOutputTestCard(show) {
  videoOutputTestCard = show === true;
  broadcastVideoOutputStatus();
  await reconcileTestCardPlayback();
  return videoOutputTestCard;
}

async function stopTestCardForQuit() {
  videoOutputTestCard = false;
  const sessionConnection = testCardPlayback.session?.connection ?? null;
  let managedIdentity = null;
  if (sessionConnection?.local) {
    try { managedIdentity = await reconcileLiveplayServerIdentity(); }
    catch { /* cleanup still tries the session's exact original connection */ }
  }
  const connection = cleanupConnectionFor(
    sessionConnection,
    videoOutputTestCardConnection,
    managedIdentity,
  );
  await testCardPlayback.update(null, connection);
  if (testCardPlayback.session) throw new Error(testCardPlayback.error || 'Could not stop AV Sync.');
  videoOutputTestCardConnection = null;
}

async function prepareForTerminalAction() {
  await stopTestCardForQuit();
  await cancelAllSpotifyDownloads(true);
  await cancelAllYouTubeDownloads();
}


function requireVideoOutputIpc(event) {
  if (!videoOutputWindow || videoOutputWindow.isDestroyed() ||
      event.sender !== videoOutputWindow.webContents) {
    throw new Error('IPC request rejected: sender is not the video output window');
  }
}

function sanitizeVideoPlaybackErrorMessage(message) {
  return message
    .replace(/\/api\/media\?[^\s"'<>)]*/gi, '/api/media')
    .replace(/\bhttps?:\/\/[^\s"'<>)]*/gi, (rawUrl) => {
      try {
        const parsed = new URL(rawUrl);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return '[media URL]';
      }
    });
}

function normalizeVideoPlaybackError(payload) {
  if (payload === null) return null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('playbackError must be an object or null');
  }
  const itemUuid = payload.itemUuid === null
    ? null
    : requireIpcString(payload.itemUuid, 'itemUuid', 256);
  const message = sanitizeVideoPlaybackErrorMessage(
    requireIpcString(payload.message, 'message', 2000));
  return { itemUuid, message };
}

function videoOutputConfigPath() {
  return path.join(app.getPath('userData'), VIDEO_OUTPUT_CONFIG_FILENAME);
}

// Screens are chosen fresh every time the app starts. Which display is the
// output, and which one a capture is taken from, hold for this run only and
// are never written to disk; screens remembered by an earlier version are
// ignored. Framing and test card settings are still saved.
const videoOutputScreens = {
  displayId: null,
  // Resolution+label hint for re-attach when the OS hands out a new display
  // id after a reconnect. Ambiguous for two identical projectors — the id
  // stays the primary key; the fingerprint is only a fallback hint.
  displayFingerprint: null,
  // Other screens of the same size and name that were connected next to
  // the assigned display: never the output (resolveAssignedDisplay).
  displayLookalikes: [],
  captureDisplayId: null,
};

// How far the picture runs ahead of the sound, to make up for a switcher,
// scaler or projector that delays it. Whole milliseconds, 0 to 500; this
// machine's video chain, so it lives with the display and framing.
const PICTURE_OFFSET_MAX_MS = 500;
function readPictureOffset(value) {
  return Number.isInteger(value) && value >= 0 && value <= PICTURE_OFFSET_MAX_MS ? value : null;
}

function readVideoOutputConfig() {
  const screens = { ...videoOutputScreens, displayLookalikes: [...videoOutputScreens.displayLookalikes] };
  try {
    const parsed = JSON.parse(fs.readFileSync(videoOutputConfigPath(), 'utf-8'));
    return {
      ...screens,
      framing: readVideoFraming(parsed.framing) ?? DEFAULT_VIDEO_FRAMING,
      pictureOffsetMs: readPictureOffset(parsed.pictureOffsetMs) ?? 0,
      testCardConfig: createTestCardConfig(parsed.testCardConfig),
    };
  } catch {
    return { ...screens, framing: DEFAULT_VIDEO_FRAMING, pictureOffsetMs: 0, testCardConfig: createTestCardConfig() };
  }
}

function writeVideoOutputConfig(cfg) {
  videoOutputScreens.displayId = cfg.displayId ?? null;
  videoOutputScreens.displayFingerprint = cfg.displayFingerprint ?? null;
  videoOutputScreens.displayLookalikes = [...(cfg.displayLookalikes ?? [])];
  videoOutputScreens.captureDisplayId = cfg.captureDisplayId ?? null;
  try {
    fs.writeFileSync(videoOutputConfigPath(),
      JSON.stringify({ framing: cfg.framing, pictureOffsetMs: cfg.pictureOffsetMs ?? 0,
        testCardConfig: cfg.testCardConfig }, null, 2));
    return true;
  } catch (e) {
    console.error('[video-output] failed to persist config:', e);
    return false;
  }
}

function videoOutputFingerprint(d) {
  return `${d.size.width}x${d.size.height}:${d.label || ''}`;
}

function orderedVideoOutputDisplays() {
  return [...screen.getAllDisplays()].sort((a, b) =>
    a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y || a.id - b.id);
}

function videoOutputDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;
  return orderedVideoOutputDisplays().map((d, position) => ({
    id: String(d.id),
    index: position + 1,
    label: d.label || `Display ${d.id}`,
    width: d.size.width,
    height: d.size.height,
    primary: d.id === primaryId,
  }));
}

// Screens of the same size and name as the assigned display, seen connected
// next to it this session: known to be other screens.
const videoOutputLookalikes = new Set();

function videoOutputLookalikeIds(displays, assigned) {
  const fingerprint = videoOutputFingerprint(assigned);
  return displays.filter(display => display !== assigned && videoOutputFingerprint(display) === fingerprint)
    .map(display => String(display.id));
}

function resolveVideoOutputDisplay(cfg) {
  const displays = screen.getAllDisplays();
  const control = mainWindow && !mainWindow.isDestroyed()
    ? screen.getDisplayMatching(mainWindow.getBounds()) : null;
  const target = resolveAssignedDisplay({
    displays,
    displayId: cfg.displayId,
    fingerprint: cfg.displayFingerprint,
    fingerprintOf: videoOutputFingerprint,
    lookalikeIds: [...(cfg.displayLookalikes || []), ...videoOutputLookalikes],
    controlDisplayId: control ? control.id : null,
  });
  if (!target) return null;
  if (String(target.id) !== cfg.displayId) {
    // The assigned display came back under a new id. It is the assigned
    // display from here on, so an identical screen plugged in later is a
    // look-alike and not a rival that would close the output mid-show.
    cfg.displayId = String(target.id);
    cfg.displayLookalikes = [...new Set([...(cfg.displayLookalikes || []), ...videoOutputLookalikes])];
    writeVideoOutputConfig(cfg);
  }
  for (const id of videoOutputLookalikeIds(displays, target)) videoOutputLookalikes.add(id);
  return target;
}

function videoOutputStatus() {
  const cfg = readVideoOutputConfig();
  const displays = videoOutputDisplays();
  const target = resolveVideoOutputDisplay(cfg);
  let warning = null;
  if (videoOutputSessionEnabled) {
    if (!target) {
      // One logical display can also mean the OS is mirroring — either way the
      // projector is not independently addressable right now.
      warning = displays.length < 2 ? 'single-display' : 'display-missing';
    } else if (mainWindow && !mainWindow.isDestroyed() &&
               screen.getDisplayMatching(mainWindow.getBounds()).id === target.id) {
      // Output and control on the same screen = mirrored displays or a
      // mis-assignment; the operator must know before showtime.
      warning = 'display-shared-with-control';
    } else if (videoOutputGeometry.uncovered) {
      // The window could not be made to fill its display.
      warning = 'display-not-covered';
    }
  }
  return {
    enabled: videoOutputSessionEnabled,
    open: videoOutputWindow !== null && !videoOutputWindow.isDestroyed(),
    displayId: cfg.displayId,
    captureDisplayId: cfg.captureDisplayId,
    framing: cfg.framing,
    pictureOffsetMs: cfg.pictureOffsetMs ?? 0,
    targetId: target ? String(target.id) : null,
    targetLabel: target ? (target.label || `Display ${target.id}`) : null,
    displays,
    warning,
    playbackError: videoOutputPlaybackError,
    rendererReady: videoOutputRendererReady,
    rendererResponsive: videoOutputRendererResponsive,
    recoveryRequired: videoOutputRecoveryRequired,
    restarting: videoOutputRestarting,
    pictureHealth: videoOutputPictureHealth,
    testCard: videoOutputTestCard,
    testCardConfig: cfg.testCardConfig,
    testCardPlayback: testCardPlayback.playback,
    testCardError: testCardPlayback.error ? sanitizeVideoPlaybackErrorMessage(testCardPlayback.error) : null,
    testCardInfo: {
      displayFrequency: (target || (videoOutputWindow && !videoOutputWindow.isDestroyed()
        ? screen.getDisplayMatching(videoOutputWindow.getBounds()) : screen.getPrimaryDisplay())).displayFrequency || 0,
      network: [...new Set(Object.values(os.networkInterfaces()).flat()
        .filter(entry => entry && entry.family === 'IPv4' && !entry.internal)
        .map(entry => entry.address))],
    },
    fullscreen: videoOutputWindow !== null &&
                !videoOutputWindow.isDestroyed() &&
                isOutputFullscreen(videoOutputWindow, process.platform),
  };
}

function broadcastVideoOutputStatus() {
  const status = videoOutputStatus();
  for (const win of [mainWindow, videoOutputWindow]) {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('video-output:status-changed', status);
    }
  }
  return status;
}
function videoOutputContextLabels() {
  const t = menuTranslations[currentLocale] || menuTranslations.en || {};
  return {
    enterFullscreen: t.videoOutputEnterFullscreen || 'Enter Full Screen',
    exitFullscreen: t.videoOutputExitFullscreen || 'Exit Full Screen',
    showTestCard: t.videoOutputShowTestCard || 'Show Test Card',
    exitOutput: t.videoOutputExit || 'Exit Video Output',
  };
}

function showVideoOutputContextMenu(outputWindow) {
  if (!outputWindow || outputWindow.isDestroyed()) return;
  const template = buildVideoOutputContextTemplate({
    fullscreen: isOutputFullscreen(outputWindow, process.platform),
    canToggleFullscreen: canToggleOutputFullscreen(outputWindow, process.platform),
    testCard: videoOutputTestCard,
    labels: videoOutputContextLabels(),
    onToggleFullscreen: () => {
      if (!outputWindow.isDestroyed()) {
        setOutputFullscreen(outputWindow, process.platform, !isOutputFullscreen(outputWindow, process.platform));
        broadcastVideoOutputStatus();
      }
    },
    onToggleTestCard: (visible) => { void setVideoOutputTestCard(visible); },
    onExit: () => closeVideoOutputWindow(),
  });
  Menu.buildFromTemplate(template).popup({ window: outputWindow });
}

function closeDisplayIdentifierWindows() {
  if (displayIdentifierTimer !== null) {
    clearTimeout(displayIdentifierTimer);
    displayIdentifierTimer = null;
  }
  for (const identifierWindow of displayIdentifierWindows) {
    if (!identifierWindow.isDestroyed()) identifierWindow.destroy();
  }
  displayIdentifierWindows = [];
}

function escapeDisplayIdentifierText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function identifyVideoOutputDisplays() {
  closeDisplayIdentifierWindows();
  const displays = orderedVideoOutputDisplays();
  const primaryId = screen.getPrimaryDisplay().id;

  displayIdentifierWindows = displays.map((display, position) => {
    const width = Math.min(360, Math.max(240, Math.round(display.bounds.width * 0.22)));
    const height = Math.min(240, Math.max(180, Math.round(display.bounds.height * 0.22)));
    const identifierWindow = new BrowserWindow({
      x: display.bounds.x + Math.round((display.bounds.width - width) / 2),
      y: display.bounds.y + Math.round((display.bounds.height - height) / 2),
      width,
      height,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      backgroundColor: '#0b1327',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    identifierWindow.setAlwaysOnTop(true, 'screen-saver');
    identifierWindow.setIgnoreMouseEvents(true);
    try {
      // Keep the operator app in the Dock and app switcher on macOS.
      identifierWindow.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true, skipTransformProcessType: true,
      });
    } catch { /* not supported by every Linux window manager */ }

    const label = escapeDisplayIdentifierText(display.label || `Display ${display.id}`);
    const primary = display.id === primaryId ? ' · Primary' : '';
    const html = `<!doctype html>
      <html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
      <style>
        html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#0b1327;color:#fff}
        body{display:grid;place-items:center;font-family:Arial,sans-serif;text-align:center;
          box-sizing:border-box;border:8px solid #5b8cff}
        strong{display:block;font-size:clamp(72px,42vw,144px);line-height:.8;font-weight:800}
        span{display:block;margin-top:18px;font-size:18px;font-weight:700}
        small{display:block;margin-top:7px;color:#b8c8ee;font-size:13px}
      </style></head><body><div>
        <strong>${position + 1}</strong>
        <span>${label}</span>
        <small>${display.size.width}×${display.size.height}${primary}</small>
      </div></body></html>`;
    identifierWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
    identifierWindow.once('ready-to-show', () => {
      if (!identifierWindow.isDestroyed()) identifierWindow.showInactive();
    });
    return identifierWindow;
  });

  displayIdentifierTimer = setTimeout(closeDisplayIdentifierWindows, 5000);
  return videoOutputDisplays();
}

function loadVideoOutputWindow(outputWindow) {
  return isDevMode
    ? outputWindow.loadURL('http://localhost:3000/?videoOutput=1')
    : outputWindow.loadFile(path.join(__dirname, '../.output/public/index.html'), { query: { videoOutput: '1' } });
}

function failVideoOutputRenderer(outputWindow, message, restoreOperator = true) {
  if (videoOutputWindow !== outputWindow || outputWindow.isDestroyed()) return;
  videoOutputRendererReady = false;
  videoOutputRecoveryRequired = true;
  videoOutputPictureHealth = null;
  outputWindow.videoOutputCover.setVisible(true);
  videoOutputPlaybackError = { itemUuid: null, message };
  videoOutputDiagnostics.push({ at: Date.now(), error: sanitizeVideoPlaybackErrorMessage(message) });
  if (videoOutputDiagnostics.length > 32) videoOutputDiagnostics.shift();
  const connection = videoOutputTestCardConnection;
  videoOutputTestCardConnection = null;
  void testCardPlayback.update(null, connection);
  // Bring the operator back once: an output that keeps failing, and the
  // restarts that follow, must not take the keyboard away every few seconds.
  const repeated = videoOutputAutoRestarts.some(at => Date.now() - at < 60_000);
  if (restoreOperator && !repeated && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
  broadcastVideoOutputStatus();
}

function markVideoOutputReady(event) {
  requireVideoOutputIpc(event);
  if (event.senderFrame !== event.sender.mainFrame) throw new Error('Expected output main frame');
  if (!videoOutputRecoveryRequired) {
    videoOutputRendererReady = true;
    videoOutputRendererResponsive = true;
    videoOutputWindow.videoOutputCover.setVisible(false);
  }
  return broadcastVideoOutputStatus();
}

function reportVideoPictureHealth(event, payload) {
  requireVideoOutputIpc(event);
  if (event.senderFrame !== event.sender.mainFrame) throw new Error('Expected output main frame');
  if (videoOutputRecoveryRequired) return;
  if (!payload || !['idle', 'still', 'paused', 'loading', 'seeking', 'playing', 'clock-wait', 'error'].includes(payload.state)
    || !(payload.itemUuid === null || (typeof payload.itemUuid === 'string' && payload.itemUuid.length <= 128))
    || !(payload.sourceItemUuid === null || (typeof payload.sourceItemUuid === 'string' && payload.sourceItemUuid.length <= 128))
    || !(payload.fileRevision === null || (typeof payload.fileRevision === 'string' && payload.fileRevision.length <= 1024))
    || !Number.isInteger(payload.readyState) || payload.readyState < 0 || payload.readyState > 4) {
    throw new Error('Invalid picture health');
  }
  for (const key of ['mediaTime', 'presentedFrames', 'presentedAgeMs', 'droppedFrames', 'totalFrames', 'preparedSeconds']) {
    if (payload[key] !== null && (!Number.isFinite(payload[key]) || payload[key] < 0)) throw new Error('Invalid picture health');
  }
  const { itemUuid, sourceItemUuid, fileRevision, preparedSeconds, state, mediaTime, presentedFrames, presentedAgeMs, droppedFrames, totalFrames, readyState } = payload;
  videoOutputPictureHealth = { itemUuid, sourceItemUuid, fileRevision, preparedSeconds, state, mediaTime, presentedFrames, presentedAgeMs,
    droppedFrames, totalFrames, readyState, receivedAt: Date.now() };
  videoOutputDiagnostics.push(videoOutputPictureHealth);
  if (videoOutputDiagnostics.length > 32) videoOutputDiagnostics.shift();
  broadcastVideoOutputStatus();
}

// A crashed or hung output restarts by itself behind its black cover, as
// Restart Output would, and rejoins the cue playing. One that keeps crashing
// restarts less often.
function scheduleVideoOutputRestart(outputWindow) {
  if (quitConfirmed || videoOutputRestarting || videoOutputAutoRestartTimer) return;
  if (videoOutputWindow !== outputWindow || outputWindow.isDestroyed()) return;
  const now = Date.now();
  while (videoOutputAutoRestarts.length && now - videoOutputAutoRestarts[0] > 60_000) videoOutputAutoRestarts.shift();
  videoOutputAutoRestarts.push(now);
  videoOutputAutoRestartTimer = setTimeout(() => {
    videoOutputAutoRestartTimer = null;
    if (!quitConfirmed && videoOutputWindow === outputWindow && !outputWindow.isDestroyed())
      void restartVideoOutputWindow();
  }, videoOutputAutoRestarts.length > 3 ? 10_000 : 250);
}

// A restarted output that loads but never reports its picture ready is
// restarted again rather than left black.
function watchVideoOutputReady(outputWindow) {
  clearTimeout(videoOutputReadyTimer);
  videoOutputReadyTimer = setTimeout(() => {
    videoOutputReadyTimer = null;
    if (videoOutputWindow !== outputWindow || outputWindow.isDestroyed() || videoOutputRendererReady
      || videoOutputRecoveryRequired || videoOutputRestarting) return;
    failVideoOutputRenderer(outputWindow, 'Video Output did not become ready. Audience output is held black while it restarts.');
    scheduleVideoOutputRestart(outputWindow);
  }, videoOutputReadyLimitMs);
}

async function restartVideoOutputWindow() {
  const outputWindow = videoOutputWindow;
  if (!outputWindow || outputWindow.isDestroyed() || videoOutputRestarting) return videoOutputStatus();
  videoOutputRestarting = true;
  failVideoOutputRenderer(outputWindow, 'Restarting Video Output; audience output is held black.', false);
  try {
    if (!outputWindow.webContents.isCrashed()) {
      await new Promise((resolve, reject) => {
        const done = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          outputWindow.webContents.removeListener('render-process-gone', done);
          reject(new Error('Video Output renderer did not stop. Retry Restart Output.'));
        }, 3000);
        outputWindow.webContents.once('render-process-gone', done);
        outputWindow.webContents.forcefullyCrashRenderer();
      });
    }
    if (videoOutputWindow !== outputWindow || outputWindow.isDestroyed()) return videoOutputStatus();
    videoOutputRecoveryRequired = false;
    videoOutputPlaybackError = null;
    videoOutputRendererReady = false;
    await loadVideoOutputWindow(outputWindow);
    watchVideoOutputReady(outputWindow);
  } catch (error) {
    failVideoOutputRenderer(outputWindow, `Video Output restart failed: ${error.message}`, false);
  } finally {
    if (videoOutputWindow === outputWindow) {
      videoOutputRestarting = false;
      broadcastVideoOutputStatus();
      // A restart that failed is tried again (less often if it keeps failing).
      if (videoOutputRecoveryRequired) scheduleVideoOutputRestart(outputWindow);
    }
  }
  return videoOutputStatus();
}

function videoOutputTargetDisplay(outputWindow) {
  const id = outputWindow?.videoOutputTargetDisplayId;
  return id == null ? null : screen.getAllDisplays().find(display => display.id === id) ?? null;
}

// Evidence for a fault that only shows on someone else's machine. Display
// labels and sizes only; nothing about the show.
function recordVideoOutputGeometry(outputWindow, target, outcome) {
  const geometry = videoOutputGeometry;
  if (geometry.recorded === outcome) return;
  geometry.recorded = outcome;
  try {
    const primaryId = screen.getPrimaryDisplay().id;
    fs.writeFileSync(path.join(app.getPath('userData'), VIDEO_OUTPUT_GEOMETRY_FILENAME), JSON.stringify({
      recordedAt: new Date().toISOString(),
      outcome,
      app: app.getVersion(),
      electron: process.versions.electron,
      platform: process.platform,
      targetDisplayId: target.id,
      displays: screen.getAllDisplays().map(display => ({
        id: display.id, label: display.label || '', primary: display.id === primaryId,
        bounds: display.bounds, size: display.size, workArea: display.workArea,
        scaleFactor: display.scaleFactor, rotation: display.rotation, internal: display.internal === true,
      })),
      window: {
        bounds: outputWindow.getBounds(),
        contentSize: outputWindow.getContentSize(),
        fullscreen: outputWindow.isFullScreen(),
        onDisplayId: screen.getDisplayMatching(outputWindow.getBounds()).id,
      },
      viewport: geometry.report,
      fullscreenWanted: geometry.fullscreenWanted,
      corrections: geometry.actions,
    }, null, 2));
  } catch (error) {
    console.warn('[video-output] could not record output geometry:', error.message);
  }
}

function evaluateVideoOutputGeometry(outputWindow) {
  const geometry = videoOutputGeometry;
  if (videoOutputWindow !== outputWindow || outputWindow.isDestroyed() || geometry.busy || !geometry.report) return;
  // A preview window is an ordinary window; a vanished display is the watchdog's.
  const target = videoOutputTargetDisplay(outputWindow);
  if (!target) return;
  const windowBounds = outputWindow.getBounds();
  // Bounds this check enlarged on purpose say nothing about where the window
  // really is; after that only what the page measures is evidence.
  const positionTrusted = !geometry.compensated;
  const plan = planGeometryCorrection({
    platform: process.platform,
    report: geometry.report,
    corrections: geometry.corrections,
    fullscreenWanted: geometry.fullscreenWanted && usesNativeFullscreen(process.platform),
    onTargetDisplay: !positionTrusted || screen.getDisplayMatching(windowBounds).id === target.id,
    windowBounds,
    targetBounds: target.bounds,
    otherBounds: positionTrusted
      ? screen.getAllDisplays().filter(display => display.id !== target.id).map(display => display.bounds)
      : [],
  });

  if (plan.action === 'none' || plan.action === 'give-up') {
    const uncovered = plan.action === 'give-up';
    const outcome = plan.covered ? (geometry.corrections ? 'covered-after-correction' : 'covered')
      : uncovered ? (plan.misplaced ? 'on-another-screen' : 'not-covered')
        : 'short-not-corrected-on-this-platform';
    recordVideoOutputGeometry(outputWindow, target, outcome);
    if (geometry.uncovered !== uncovered) {
      geometry.uncovered = uncovered;
      if (uncovered) {
        console.error('[video-output] output is still not exactly on its display after corrections:',
          JSON.stringify({ viewport: geometry.report, windowBounds, target: target.bounds }));
      }
      broadcastVideoOutputStatus();
    }
    return;
  }

  geometry.corrections += 1;
  geometry.busy = true;
  geometry.compensated = plan.action === 'compensate';
  geometry.actions.push({
    action: plan.action, bounds: plan.bounds, fullscreen: plan.fullscreen === true,
    viewport: geometry.report, windowBounds, wasFullscreen: outputWindow.isFullScreen(),
  });
  console.warn('[video-output] output is not exactly on its display; applying', plan.action,
    JSON.stringify({ viewport: geometry.report, windowBounds, target: target.bounds }));
  const current = () => videoOutputWindow === outputWindow && !outputWindow.isDestroyed()
    && videoOutputGeometry === geometry;
  if (outputWindow.isFullScreen()) outputWindow.setFullScreen(false);
  outputWindow.setBounds(plan.bounds);
  setTimeout(() => {
    if (!current()) return;
    // A move between displays with different scaling needs a second
    // placement, once the window is on the display, for the size to stick.
    outputWindow.setBounds(plan.bounds);
    if (plan.fullscreen) outputWindow.setFullScreen(true);
    setTimeout(() => {
      // The page reports again within two seconds and is judged afresh.
      if (current()) geometry.busy = false;
    }, 300);
  }, 120);
}

function reportVideoOutputViewport(event, payload) {
  requireVideoOutputIpc(event);
  const report = readViewportReport(payload);
  if (!report) throw new TypeError('Invalid viewport report.');
  const outputWindow = videoOutputWindow;
  const geometry = videoOutputGeometry;
  geometry.report = report;
  // Sizes arrive in a burst while a window settles; judge only the last one.
  clearTimeout(geometry.settleTimer);
  geometry.settleTimer = setTimeout(() => {
    geometry.settleTimer = null;
    if (videoOutputGeometry === geometry) evaluateVideoOutputGeometry(outputWindow);
  }, 400);
  return true;
}

function createVideoOutputWindow() {
  if (videoOutputWindow && !videoOutputWindow.isDestroyed()) return;
  videoOutputPlaybackError = null;
  videoOutputRendererReady = false;
  videoOutputRendererResponsive = true;
  videoOutputRecoveryRequired = false;
  videoOutputRestarting = false;
  videoOutputPictureHealth = null;

  const cfg = readVideoOutputConfig();
  const target = resolveVideoOutputDisplay(cfg);
  const realOutput = target !== null && screen.getAllDisplays().length > 1;

  const options = {
    title: 'DonWells Cue - Video Output',
    icon: path.join(__dirname, '../assets/icons/2x/app_icon_darkmode@2x.png'),
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      // This surface is the show's picture: it must keep painting and chasing
      // the playhead while the operator works in the main window. Without
      // this, Chromium suspends rAF/timers (and on macOS stops committing
      // frames entirely) the moment the window is occluded or unfocused.
      backgroundThrottling: false,
    },
  };

  // A physical output takes over its display and no other; anything else is
  // an ordinary preview window.
  Object.assign(options, realOutput
    ? physicalOutputWindowOptions(process.platform, target.bounds)
    : previewWindowOptions(process.platform));

  const outputWindow = new BrowserWindow(options);
  claimSoleOutput(outputWindow);
  videoOutputWindow = outputWindow;
  // Only a physical output must cover its display; the preview is a normal window.
  resetVideoOutputGeometry(realOutput);
  if (realOutput) outputWindow.videoOutputTargetDisplayId = target.id;
  // A preview opened while its assigned display is not connected becomes the
  // output on that display when it returns (installVideoOutputWatchdog).
  if (cfg.displayId && !target) outputWindow.videoOutputWaitingForDisplay = true;
  // Native coverage survives renderer loss and hides the control page during hydration.
  const cover = new View();
  cover.setBackgroundColor('#000000');
  outputWindow.videoOutputCover = cover;
  outputWindow.contentView.addChildView(cover);
  const resizeCover = () => {
    const [width, height] = outputWindow.getContentSize();
    cover.setBounds({ x: 0, y: 0, width, height });
  };
  resizeCover();
  cover.setVisible(true);
  outputWindow.on('resize', resizeCover);
  if (realOutput) seatPhysicalOutput(outputWindow, process.platform, target.bounds);

  outputWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (videoOutputWindow !== outputWindow) return;
    console.error('[video-output] Failed to load:', errorCode, errorDescription);
    if (isMainFrame && errorCode !== -3) {
      failVideoOutputRenderer(outputWindow, `Video Output could not load (${errorCode}). Audience output is held black while it retries.`);
      scheduleVideoOutputRestart(outputWindow);
    }
  });

  outputWindow.webContents.on('did-finish-load', () => {
    if (videoOutputWindow !== outputWindow) return;
    broadcastVideoOutputStatus();
    void reconcileTestCardPlayback();
  });
  outputWindow.webContents.on('render-process-gone', (_event, details) => {
    if (videoOutputWindow !== outputWindow) return;
    const reason = details?.reason || 'unknown';
    const exitCode = details?.exitCode ?? 'unknown';
    console.error('[video-output] Renderer stopped:', reason, exitCode);
    videoOutputRendererResponsive = false;
    if (videoOutputRestarting) return;   // the restart stopped it on purpose
    failVideoOutputRenderer(outputWindow, `Video Output renderer stopped (${reason}, exit code ${exitCode}). Audience output is held black while it restarts.`);
    scheduleVideoOutputRestart(outputWindow);
  });
  outputWindow.webContents.on('unresponsive', () => {
    if (videoOutputWindow !== outputWindow) return;
    videoOutputRendererResponsive = false;
    failVideoOutputRenderer(outputWindow, 'Video Output is not responding. Audience output is held black while it restarts.');
    // A hang that never ends (a GPU or decoder deadlock) is restarted too.
    scheduleVideoOutputRestart(outputWindow);
  });
  outputWindow.webContents.on('responsive', () => {
    if (videoOutputWindow !== outputWindow) return;
    videoOutputRendererResponsive = true;
    broadcastVideoOutputStatus();
    // Answering again is not enough to trust its picture: restart it.
    if (videoOutputRecoveryRequired) scheduleVideoOutputRestart(outputWindow);
  });

  // The passive output renderer otherwise owns keyboard focus on Windows.
  // Forward app-level shortcuts back to the control renderer while preserving
  // native app accelerators and OS escape hatches such as Alt+F4.
  outputWindow.webContents.on('before-input-event', (event, input) => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    if (!shouldForwardVideoOutputShortcut(input, process.platform)) return;
    const shortcut = toRendererShortcut(input);
    // Escape is Stop All. On the preview window it also leaves fullscreen, as
    // in any app. An audience display must never drop out of fullscreen
    // because the operator stopped the show while it had keyboard focus.
    if (shortcut.key === 'Escape' && outputWindow.videoOutputTargetDisplayId == null &&
        isOutputFullscreen(outputWindow, process.platform)) {
      setOutputFullscreen(outputWindow, process.platform, false);
      broadcastVideoOutputStatus();
    }
    mainWindow.webContents.send('video-output:shortcut', shortcut);
    event.preventDefault();
  });

  outputWindow.webContents.on('context-menu', (event) => {
    event.preventDefault();
    showVideoOutputContextMenu(outputWindow);
  });

  // Remember the operator's own choice. Transitions made while re-seating the
  // window are ours and must not be mistaken for it.
  const rememberFullscreenChoice = (wanted) => {
    if (videoOutputWindow === outputWindow && !videoOutputGeometry.busy) {
      videoOutputGeometry.fullscreenWanted = wanted;
    }
    broadcastVideoOutputStatus();
  };
  outputWindow.on('enter-full-screen', () => rememberFullscreenChoice(true));
  outputWindow.on('leave-full-screen', () => rememberFullscreenChoice(false));

  // Closed from its own title bar or the keyboard: see closeVideoOutputWindow.
  outputWindow.on('close', () => releaseOutputFullscreen(outputWindow, process.platform));
  outputWindow.on('closed', () => {
    const preserveSession = videoOutputWindowsPreservingSession.delete(outputWindow);
    if (videoOutputWindow !== outputWindow) return;
    closeVideoOutputWindow({ preserveSession });
    broadcastVideoOutputStatus();
  });

  // The projector/switcher chain must never sleep mid-show.
  if (videoOutputPowerSaveId === null || !powerSaveBlocker.isStarted(videoOutputPowerSaveId)) {
    videoOutputPowerSaveId = powerSaveBlocker.start('prevent-display-sleep');
  }
  outputWindow.show();
  void loadVideoOutputWindow(outputWindow).catch(error => {
    failVideoOutputRenderer(outputWindow, `Video Output could not load: ${error.message}`);
  });
}

function closeVideoOutputWindow({ preserveSession = false, playbackError = null } = {}) {
  const outputWindow = videoOutputWindow;
  if (!preserveSession) videoOutputSessionEnabled = false;
  // Release this generation before destroy can emit a late closed event.
  videoOutputWindow = null;
  videoOutputPlaybackError = playbackError;
  videoOutputRendererReady = false;
  videoOutputRendererResponsive = true;
  videoOutputRecoveryRequired = false;
  videoOutputRestarting = false;
  clearTimeout(videoOutputAutoRestartTimer);
  videoOutputAutoRestartTimer = null;
  clearTimeout(videoOutputReadyTimer);
  videoOutputReadyTimer = null;
  videoOutputPictureHealth = null;
  resetVideoOutputGeometry();
  const connection = videoOutputTestCardConnection;
  videoOutputTestCardConnection = null;
  void testCardPlayback.update(null, connection);
  if (videoOutputPowerSaveId !== null) {
    try { powerSaveBlocker.stop(videoOutputPowerSaveId); } catch { /* already stopped */ }
    videoOutputPowerSaveId = null;
  }
  if (!outputWindow || outputWindow.isDestroyed()) return;
  if (preserveSession) videoOutputWindowsPreservingSession.add(outputWindow);
  // A Mac preview covering its screen hides the menu bar and Dock; hand them back.
  releaseOutputFullscreen(outputWindow, process.platform);
  outputWindow.destroy();
}

// macOS: a physical output whose display drops out (a switcher or extender
// re-syncing, an input change, a cable knock) is hidden at once and kept,
// still playing in step, instead of being torn down: when the display
// returns it is seated and shown with the picture live, not after seconds of
// black while a new window boots. Elsewhere it is still closed and recreated.
function parkVideoOutputWindow(outputWindow) {
  if (outputWindow.videoOutputDisplayLost) return;
  outputWindow.videoOutputDisplayLost = true;
  outputWindow.hide();
}

function restoreVideoOutputWindow(outputWindow, target) {
  outputWindow.videoOutputDisplayLost = false;
  outputWindow.videoOutputTargetDisplayId = target.id;
  resetVideoOutputGeometry(true);
  seatPhysicalOutput(outputWindow, process.platform, target.bounds);
  outputWindow.show();
}

// Watchdog: when the display topology changes (switcher EDID renegotiation,
// cable replug, OS reshuffle), keep the output on its assigned display or take
// it down cleanly — it must never silently settle onto the control screen.
function installVideoOutputWatchdog() {
  if (videoOutputWatchdogInstalled) return;
  videoOutputWatchdogInstalled = true;
  const keepsLostOutput = process.platform === 'darwin';
  const onDisplayChange = () => {
    // Hide a lost output at once: the OS moves windows off a vanished
    // display, and the output must not cover the operator screen meanwhile.
    if (keepsLostOutput && videoOutputSessionEnabled && videoOutputWindow &&
        !videoOutputWindow.isDestroyed() && videoOutputWindow.videoOutputTargetDisplayId != null &&
        !resolveVideoOutputDisplay(readVideoOutputConfig())) {
      parkVideoOutputWindow(videoOutputWindow);
    }
    // Display events arrive in bursts; settle before reacting.
    clearTimeout(videoOutputWatchdogTimer);
    videoOutputWatchdogTimer = setTimeout(() => {
      videoOutputWatchdogTimer = null;
      const cfg = readVideoOutputConfig();
      if (!videoOutputSessionEnabled) { broadcastVideoOutputStatus(); return; }
      const target = resolveVideoOutputDisplay(cfg);
      if (videoOutputWindow && videoOutputWindow.videoOutputTargetDisplayId != null && !target) {
        // The physical output's display is gone: keep it hidden (macOS) or
        // close it, never let the OS park it on the operator's control
        // display. The preview window has no display to lose and lives on
        // the control screen, so metrics events there (e.g. entering
        // fullscreen) never close it, even when an assigned display is not
        // connected.
        if (keepsLostOutput) parkVideoOutputWindow(videoOutputWindow);
        else closeVideoOutputWindow({ preserveSession: true });
      } else if (videoOutputWindow && !videoOutputWindow.isDestroyed() &&
                 videoOutputWindow.videoOutputDisplayLost && target && screen.getAllDisplays().length > 1) {
        // Its display is back: seat the kept output there and show it, live.
        restoreVideoOutputWindow(videoOutputWindow, target);
      } else if (!videoOutputWindow && target) {
        // Display (re)appeared while armed: re-acquire it.
        createVideoOutputWindow();
      } else if (videoOutputWindow && target && videoOutputWindow.videoOutputWaitingForDisplay &&
                 screen.getAllDisplays().length > 1) {
        // The assigned display is back while the preview opened in its
        // absence is up: make that the output on it, as assigning a display
        // in Settings does, instead of moving a window with a title bar there.
        closeVideoOutputWindow({ preserveSession: true });
        createVideoOutputWindow();
      } else if (videoOutputWindow && target &&
                 screen.getAllDisplays().length > 1 &&
                 !videoOutputWindow.isDestroyed()) {
        // Still present but possibly reshuffled: re-assert bounds. Physical
        // output → raw bounds. (Electron can need a delayed second call on
        // Windows for the move to stick.)
        const wBounds = videoOutputWindow.getBounds();
        const tBounds = target.bounds;
        // On Windows a fullscreen window is sized by the OS: its logical
        // bounds can differ from the display's by a rounding pixel under
        // fractional scaling, and resizing it by hand takes it out of the
        // fullscreen rectangle. The coverage check owns that case there.
        const seated = process.platform === 'win32' && videoOutputWindow.isFullScreen() &&
          screen.getDisplayMatching(wBounds).id === target.id;
        if (!seated && JSON.stringify(wBounds) !== JSON.stringify(tBounds)) {
          videoOutputWindow.setBounds(tBounds);
          setTimeout(() => {
            if (videoOutputWindow && !videoOutputWindow.isDestroyed()) {
              videoOutputWindow.setBounds(tBounds);
            }
          }, 80);
        }
      }
      broadcastVideoOutputStatus();
    }, 300);
  };
  screen.on('display-added', onDisplayChange);
  screen.on('display-removed', onDisplayChange);
  screen.on('display-metrics-changed', onDisplayChange);
}


function openVideoOutputWindow() {
  videoOutputSessionEnabled = true;
  installVideoOutputWatchdog();
  createVideoOutputWindow();
}

ipcMain.handle('video-output:open', (event) => {
  requireTrustedIpc(event);
  openVideoOutputWindow();
  return broadcastVideoOutputStatus();
});

ipcMain.handle('video-output:close', (event) => {
  requireTrustedIpc(event);
  closeVideoOutputWindow();
  return broadcastVideoOutputStatus();
});

ipcMain.handle('video-output:status', (event) => {
  requireTrustedIpc(event);
  return videoOutputStatus();
});
ipcMain.handle('video-output:restart', (event) => {
  requireTrustedIpc(event);
  return restartVideoOutputWindow();
});
ipcMain.handle('video-output:renderer-ready', markVideoOutputReady);
ipcMain.handle('video-output:picture-health', reportVideoPictureHealth);
ipcMain.handle('video-output:viewport', reportVideoOutputViewport);
ipcMain.handle('video-output:diagnostics', (event) => {
  requireTrustedIpc(event);
  return { runtime: { electron: process.versions.electron, chromium: process.versions.chrome,
    platform: process.platform, arch: process.arch }, status: videoOutputStatus(), recent: [...videoOutputDiagnostics] };
});
ipcMain.handle('video-output:report-playback-error', async (event, payload) => {
  requireVideoOutputIpc(event);
  if (videoOutputRecoveryRequired) return broadcastVideoOutputStatus();
  videoOutputPlaybackError = normalizeVideoPlaybackError(payload);
  if (videoOutputPlaybackError) {
    videoOutputDiagnostics.push({ at: Date.now(), ...videoOutputPlaybackError });
    if (videoOutputDiagnostics.length > 32) videoOutputDiagnostics.shift();
  }
  if (videoOutputPlaybackError?.itemUuid === testCardPlayback.session?.cue.id
    && videoOutputPlaybackError) {
    await testCardPlayback.fail(videoOutputPlaybackError.message, videoOutputTestCardConnection);
  }
  return broadcastVideoOutputStatus();
});

ipcMain.handle('video-output:list-displays', (event) => {
  requireTrustedIpc(event);
  return videoOutputDisplays();
});

ipcMain.handle('video-output:identify-displays', (event) => {
  requireTrustedIpc(event);
  return identifyVideoOutputDisplays();
});

function requireCaptureOwner(event) {
  requireTrustedIpc(event);
  if (event.sender !== mainWindow?.webContents) {
    throw new Error('Standby capture requires the main workspace.');
  }
}

function requireCaptureTarget(event, target) {
  requireCaptureOwner(event);
  requireBoundedIpcObject(target, 'capture target', 64 * 1024);
  validateIdentity(target?.identity);
  const sessionId = requireIpcString(target.sessionId, 'sessionId', 256);
  if (!sameIdentity(target.identity, currentProjectIdentity) || sessionId !== currentCaptureSession) {
    throw new Error('The active show changed. Try again in the current show.');
  }
  if (target.itemUuid === null) return null;
  const uuid = requireIpcString(target.itemUuid, 'itemUuid', 256);
  const cue = findCaptureCue(currentProjectData, uuid);
  if (!cue) throw new Error('Select a media cue in the current show.');
  return cue;
}

ipcMain.handle('video-output:set-picture-offset', (event, value) => {
  requireTrustedIpc(event);
  if (event.sender !== mainWindow?.webContents) throw new Error('Picture sync requires the main workspace.');
  const offset = readPictureOffset(value);
  if (offset === null) throw new TypeError('Picture sync must be a whole number of milliseconds from 0 to 500.');
  const config = readVideoOutputConfig();
  config.pictureOffsetMs = offset;
  if (!writeVideoOutputConfig(config)) throw new Error('Could not save picture sync.');
  return broadcastVideoOutputStatus();
});

ipcMain.handle('video-output:set-framing', (event, value) => {
  requireTrustedIpc(event);
  if (event.sender !== mainWindow?.webContents) throw new Error('Picture framing requires the main workspace.');
  const framing = readVideoFraming(value);
  if (!framing) throw new TypeError('Invalid picture framing.');
  const config = readVideoOutputConfig();
  config.framing = framing;
  if (!writeVideoOutputConfig(config)) throw new Error('Could not save picture framing.');
  return broadcastVideoOutputStatus();
});

let videoFrameProbe = null;

function requireVideoCheckOwner(event) {
  requireTrustedIpc(event);
  if (event.sender !== mainWindow?.webContents || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Video checks require the main workspace.');
  }
}

ipcMain.on('video-output:cancel-frame-check', (event, checkId) => {
  if (event.sender !== mainWindow?.webContents || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) return;
  if (videoFrameProbe?.id === checkId) videoFrameProbe.controller.abort();
});

ipcMain.handle('video-output:check-frame', async (event, request) => {
  requireVideoCheckOwner(event);
  requireBoundedIpcObject(request, 'video check', 64 * 1024);
  const id = requireIpcString(request?.id, 'checkId', 64);
  const sessionId = requireIpcString(request.sessionId, 'sessionId', 256);
  const uuid = requireIpcString(request.uuid, 'itemUuid', 256);
  const fileRevision = request.fileRevision === null ? null
    : requireIpcString(request.fileRevision, 'fileRevision', 1024);
  const { inPoint, outPoint = null, accessToken } = request;
  if (!Number.isFinite(inPoint) || inPoint < 0) throw new TypeError('Invalid video cue in point.');
  if (outPoint !== null && (!Number.isFinite(outPoint) || outPoint <= inPoint)) {
    throw new TypeError('Invalid video cue out point.');
  }
  if (typeof accessToken !== 'string' || accessToken.length > 8192 || /[\0\r\n]/.test(accessToken)) {
    throw new TypeError('Invalid server credential.');
  }
  const serverUrl = new URL(requireIpcString(request.serverUrl, 'serverUrl', 2048));
  const config = readLiveplayConfig();
  const configuredUrl = new URL(config.mode === 'remote'
    ? config.remoteUrl : `http://127.0.0.1:${config.localPort}`);
  const base = serverUrl.href.replace(/\/+$/, '');
  if (!['http:', 'https:'].includes(serverUrl.protocol) || serverUrl.username || serverUrl.password ||
    serverUrl.search || serverUrl.hash || base !== configuredUrl.href.replace(/\/+$/, '')) {
    throw new Error('Video checks must use the selected Cue server.');
  }
  if (sessionId !== currentCaptureSession || !findCaptureCue(currentProjectData, uuid)?.hasVideo) {
    throw new Error('The video cue is no longer in the current show.');
  }
  if (videoFrameProbe) throw new Error('A video check is already running.');

  const params = new URLSearchParams({ item_uuid: uuid, project_session_id: sessionId });
  if (fileRevision) params.set('file_revision', fileRevision);
  if (accessToken) params.set('access_token', accessToken);
  const owner = event.sender;
  const controller = new AbortController();
  videoFrameProbe = { id, controller };
  const cancel = () => controller.abort();
  const onNavigate = details => {
    if (details.isMainFrame && !details.isSameDocument) cancel();
  };
  owner.once('destroyed', cancel);
  owner.once('render-process-gone', cancel);
  owner.on('did-start-navigation', onNavigate);
  try {
    return await checkVideoFrame(`${base}/api/media?${params}`, { inPoint, outPoint }, controller.signal);
  } finally {
    videoFrameProbe = null;
    if (!owner.isDestroyed()) {
      owner.removeListener('destroyed', cancel);
      owner.removeListener('render-process-gone', cancel);
      owner.removeListener('did-start-navigation', onNavigate);
    }
  }
});

// ---------------------------------------------------------------------------
// Converting a video this machine cannot show
// ---------------------------------------------------------------------------
// The renderer names the cue; where its file is comes from the project data
// held here. The copy is made beside the original with the converter the app
// already downloads for online imports (see video-convert.js).
let videoConversion = null;

ipcMain.on('video-output:cancel-convert', (event, conversionId) => {
  if (event.sender !== mainWindow?.webContents || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) return;
  if (videoConversion?.id === conversionId) videoConversion.controller.abort();
});

ipcMain.handle('video-output:convert-cue', async (event, request) => {
  requireVideoCheckOwner(event);
  requireBoundedIpcObject(request, 'video conversion', 4096);
  const id = requireIpcString(request?.id, 'conversionId', 64);
  const sessionId = requireIpcString(request.sessionId, 'sessionId', 256);
  const uuid = requireIpcString(request.uuid, 'itemUuid', 256);
  const cue = sessionId === currentCaptureSession ? findCaptureCue(currentProjectData, uuid) : null;
  if (!cue?.hasVideo) throw new Error('The video cue is no longer in the current show.');
  if (videoConversion) throw new Error('A video conversion is already running.');
  // The show's files are on this computer only when the engine is.
  if (readLiveplayConfig().mode === 'remote') return { status: 'failed', reason: 'remote' };
  const sourcePath = cueSourcePath(currentProjectData?.folderPath, cue);
  if (!sourcePath) return { status: 'failed', reason: 'missing' };

  const owner = event.sender;
  const controller = new AbortController();
  videoConversion = { id, controller };
  const cancel = () => controller.abort();
  owner.once('destroyed', cancel);
  owner.once('render-process-gone', cancel);
  try {
    if (!await setupFfmpeg() || !ffmpegPath) return { status: 'failed', reason: 'no-converter' };
    let reported = -1;
    const result = await convertVideoForOutput({
      ffmpegPath, sourcePath, signal: controller.signal,
      onProgress: (value) => {
        const percent = Math.floor(value * 100);
        if (percent === reported || owner.isDestroyed()) return;
        reported = percent;
        owner.send('video-output:convert-progress', { id, uuid, percent });
      },
    });
    if (result.status === 'converted' || result.status === 'reused') return { status: result.status, path: result.path };
    if (result.status === 'failed') console.warn('[video-convert]', path.basename(sourcePath), result.reason, result.detail ?? '');
    return { status: result.status, reason: result.reason ?? null };
  } finally {
    videoConversion = null;
    if (!owner.isDestroyed()) {
      owner.removeListener('destroyed', cancel);
      owner.removeListener('render-process-gone', cancel);
    }
  }
});

// ---------------------------------------------------------------------------
// Clean Up Media: files in the show's media folder that nothing uses
// ---------------------------------------------------------------------------
// The window names files and nothing more. Which folder, which of its files
// are unused and where each one is are worked out here, every time, from the
// show as it is open, the show file, its backups and any other show saved in
// the same folder (see unused-media.js). A file is only ever moved to the
// Trash, where it can be put back; nothing here removes or rewrites a file.
const MAX_CLEANUP_NAMES = 5000;
const MAX_SHOW_DOCUMENT_BYTES = 64 * 1024 * 1024;
// Few enough names at a time that a long search never holds this process up.
const CLEANUP_SEARCH_BATCH = 25;
let mediaCleanupRunning = false;
const afterOtherWork = () => new Promise(resolve => setImmediate(resolve));

function requireMediaCleanupOwner(event) {
  requireTrustedIpc(event);
  if (event.sender !== mainWindow?.webContents || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Media clean-up requires the main workspace.');
  }
}

// A show document as parsed JSON. One that will not parse still counts, as
// plain text: a file named anywhere in it is kept.
async function readShowDocument(file) {
  const stat = await fs.promises.stat(file);
  if (!stat.isFile() || stat.size > MAX_SHOW_DOCUMENT_BYTES) throw new Error('The show document cannot be read.');
  const text = await fs.promises.readFile(file, 'utf8');
  // A byte-order mark at the start is not part of the JSON.
  try { return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text); } catch { return text; }
}

// The show documents in a folder and in the Backups folder inside it
// ("backups" is the same folder on Windows and macOS).
async function showDocumentsIn(folder) {
  const entries = await fs.promises.readdir(folder, { withFileTypes: true });
  const documents = entries.filter(entry => entry.isFile() && isShowDocument(entry.name))
    .map(entry => path.join(folder, entry.name));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.toLowerCase() !== 'backups') continue;
    const backups = path.join(folder, entry.name);
    for (const backup of await fs.promises.readdir(backups, { withFileTypes: true })) {
      if (backup.isFile() && isShowDocument(backup.name)) documents.push(path.join(backups, backup.name));
    }
  }
  return documents;
}

// What the open show's media folder holds that nothing uses, worked out afresh.
async function findUnusedShowMedia() {
  // The show's files are on this computer only when the engine is.
  if (readLiveplayConfig().mode === 'remote') return { available: false, reason: 'remote' };
  const identity = currentProjectIdentity;
  const showFolder = currentProjectData?.folderPath;
  const showFile = identity?.projectPath;
  const mediaFolder = mediaFolderFor(showFolder);
  if (!mediaFolder || typeof showFile !== 'string' || !path.isAbsolute(showFile) ||
      fileKindFor(showFile) !== ProjectFileKind.NativeProject) {
    return { available: false, reason: 'no-folder' };
  }

  // The folder is read before the documents: a file that arrives while this
  // runs is not in the list at all, and one changed since is too new to list.
  const now = Date.now();
  let entries = [];
  try {
    entries = await fs.promises.readdir(mediaFolder, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const files = [];
  for (const entry of entries) {
    // A regular file directly in the folder: never a folder, never a link.
    if (!entry.isFile()) continue;
    try {
      const stat = await fs.promises.lstat(path.join(mediaFolder, entry.name));
      files.push({
        name: entry.name, size: stat.size, modifiedAt: stat.mtimeMs, isFile: stat.isFile(),
        changedAt: Math.max(stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs),
      });
    } catch { /* gone since the folder was read */ }
  }

  const references = collectReferences([]);
  const savedShow = path.resolve(showFile);
  const unreadable = { available: false, reason: 'unreadable' };
  try {
    // Without the show as it was saved, nothing can be called unused.
    const saved = await readShowDocument(savedShow);
    if (!saved || typeof saved !== 'object') return unreadable;
    collectReferences([saved], references);
    for (const folder of new Set([path.resolve(showFolder), path.dirname(savedShow)])) {
      for (const file of await showDocumentsIn(folder)) {
        if (file === savedShow) continue;
        try {
          collectReferences([await readShowDocument(file)], references);
        } catch (error) {
          // A backup the engine pruned while this ran took its references with it.
          if (error?.code !== 'ENOENT') throw error;
        }
        await afterOtherWork();
      }
    }
  } catch {
    return unreadable;
  }

  // The show as it is open now, read last so it is as current as it can be.
  if (!currentProjectData || !sameIdentity(identity, currentProjectIdentity)) throw new Error('The open show changed.');
  collectReferences([currentProjectData], references);
  const unused = [];
  for (let start = 0; start < files.length; start += CLEANUP_SEARCH_BATCH) {
    unused.push(...findUnusedMedia({ files: files.slice(start, start + CLEANUP_SEARCH_BATCH), references, now }));
    await afterOtherWork();
  }
  return { available: true, identity, showFolder, files: unused };
}

ipcMain.handle('media:list-unused', async (event) => {
  requireMediaCleanupOwner(event);
  const found = await findUnusedShowMedia();
  if (!found.available) return found;
  const files = found.files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { available: true, files, totalBytes: files.reduce((total, file) => total + file.size, 0) };
});

ipcMain.handle('media:trash-unused', async (event, request) => {
  requireMediaCleanupOwner(event);
  requireBoundedIpcObject(request, 'media clean-up', 4 * 1024 * 1024);
  const names = request?.names;
  if (!Array.isArray(names) || names.length === 0 || names.length > MAX_CLEANUP_NAMES) {
    throw new TypeError(`names must list between 1 and ${MAX_CLEANUP_NAMES} files`);
  }
  for (const name of names) {
    requireIpcString(name, 'file name', 255);
    if (!isPlainFileName(name)) throw new TypeError('A file is named without a folder.');
  }
  if (mediaCleanupRunning) throw new Error('A media clean-up is already running.');
  mediaCleanupRunning = true;
  try {
    // What was unused when the window listed it is not trusted: it is worked
    // out again now, and only a name still on that list is touched.
    const wanted = [...new Set(names)];
    const found = await findUnusedShowMedia();
    const trashed = [];
    const failed = [];
    const kept = [];
    // Not on this computer, no folder, or a show file that cannot be read:
    // nothing is touched, and the list the window reads next says which.
    if (!found.available) return { trashed, failed, kept };
    const unused = new Map(found.files.map(file => [file.name, file]));
    // The open show has the last word on every file, at the moment it would
    // be moved, however long the files before it took.
    let openShow = null;
    let openShowReferences = null;
    const openShowUses = (name) => {
      if (!currentProjectData || !sameIdentity(found.identity, currentProjectIdentity)) return true;
      if (currentProjectData !== openShow) {
        openShow = currentProjectData;
        openShowReferences = collectReferences([openShow]);
      }
      return isReferenced(openShowReferences, name);
    };
    for (const name of wanted) {
      const listed = unused.get(name);
      const target = listed ? mediaFilePath(found.showFolder, name) : null;
      if (!target || openShowUses(name)) {
        kept.push(name);
        continue;
      }
      try {
        const stat = await fs.promises.lstat(target);
        // Changed since it was looked at a moment ago: something is using it.
        if (!stat.isFile() || stat.size !== listed.size || stat.mtimeMs !== listed.modifiedAt || openShowUses(name)) {
          kept.push(name);
          continue;
        }
        await shell.trashItem(target);
        trashed.push(name);
      } catch (error) {
        failed.push(name);
        console.warn('[media-cleanup] not moved to the Trash:', name, String(error?.message || error).split('\n')[0].slice(0, 200));
      }
    }
    return { trashed, failed, kept };
  } finally {
    mediaCleanupRunning = false;
  }
});

// Which other screen a capture may be taken from. What a capture is used for is
// said at the moment it is taken, never remembered here.
ipcMain.handle('video-output:set-capture-settings', (event, displayId) => {
  requireCaptureOwner(event);
  const config = readVideoOutputConfig();
  if (displayId !== null) requireIpcString(displayId, 'displayId', 64);
  if (displayId !== config.captureDisplayId && displayId !== null &&
      !videoOutputDisplays().some(display => display.id === displayId)) {
    throw new Error('The selected capture display is unavailable.');
  }
  config.captureDisplayId = displayId;
  writeVideoOutputConfig(config); // held for this run only: nothing to save
  return broadcastVideoOutputStatus();
});

// Take a picture of the Video Output or of another screen and hand it back.
// The main workspace saves it into the show and sets it as the standby
// picture or a cue's picture, exactly as a picture chosen from a file is.
ipcMain.handle('video-output:capture-standby', async (event, source, target) => {
  const cue = requireCaptureTarget(event, target);
  if (capturingVideoStandby) throw new Error('A capture is already in progress.');
  const media = cue?.mediaServerPath || cue?.mediaPath;
  let image;
  capturingVideoStandby = true;
  try {
    if (source === 'output') {
      const output = videoOutputWindow;
      const ready = () => output && videoOutputWindow === output && !output.isDestroyed() &&
        !output.webContents.isDestroyed() && videoOutputRendererReady &&
        videoOutputRendererResponsive && !videoOutputRecoveryRequired;
      if (!ready()) throw new Error('Open Video Output and wait for its picture before capturing.');
      const [width, height] = output.getContentSize();
      const framing = readVideoOutputConfig().framing;
      const { scaleFactor } = screen.getDisplayMatching(output.getBounds());
      image = await output.webContents.capturePage(videoFrameCaptureRect(width, height, framing, scaleFactor));
      if (!ready()) throw new Error('Video Output changed during capture. Try again.');
      const [currentWidth, currentHeight] = output.getContentSize();
      if (currentWidth !== width || currentHeight !== height
          || screen.getDisplayMatching(output.getBounds()).scaleFactor !== scaleFactor
          || JSON.stringify(readVideoOutputConfig().framing) !== JSON.stringify(framing)) {
        throw new Error('Video Output changed during capture. Try again.');
      }
    } else if (source === 'display') {
      const { captureDisplayId } = readVideoOutputConfig();
      const available = () => videoOutputDisplays().some(display => display.id === captureDisplayId);
      if (!captureDisplayId || !available()) throw new Error('Choose an available capture display in Video Output settings.');
      const sources = await desktopCapturer.getSources({
        types: ['screen'], thumbnailSize: { width: 3840, height: 2160 },
      });
      if (!available() || readVideoOutputConfig().captureDisplayId !== captureDisplayId) {
        throw new Error('The selected capture display changed. Try again.');
      }
      image = sources.find(entry => entry.display_id === captureDisplayId)?.thumbnail;
      if (!image || image.isEmpty()) {
        throw new Error('That screen could not be captured: this computer has not let the app see it.');
      }
    } else {
      throw new TypeError('Invalid standby capture source.');
    }
    const current = requireCaptureTarget(event, target);
    if ((current?.mediaServerPath || current?.mediaPath) !== media) {
      throw new Error('The cue changed during capture. Try again.');
    }
    return { image: captureImageUrl(image) };
  } finally {
    capturingVideoStandby = false;
  }
});

ipcMain.handle('video-output:set-display', (event, displayId) => {
  requireTrustedIpc(event);
  const checked = displayId === null
    ? null
    : requireIpcString(displayId, 'displayId', 64);
  const cfg = readVideoOutputConfig();
  cfg.displayId = checked;
  const target = checked
    ? screen.getAllDisplays().find((d) => String(d.id) === checked)
    : null;
  cfg.displayFingerprint = target ? videoOutputFingerprint(target) : null;
  // A new assignment starts a clean record of its look-alikes.
  cfg.displayLookalikes = target ? videoOutputLookalikeIds(screen.getAllDisplays(), target) : [];
  videoOutputLookalikes.clear();
  writeVideoOutputConfig(cfg);
  if (videoOutputSessionEnabled && videoOutputWindow) {
    // Re-place on the new display; recreate is the only clean way to move a
    // fullscreen frameless window across displays.
    closeVideoOutputWindow({ preserveSession: true });
    createVideoOutputWindow();
  }
  return broadcastVideoOutputStatus();
});

// Fullscreen toggle for the output window. The assigned-display case is
// already fullscreen/borderless by construction; this covers the preview
// window (single-display machines) and lets the operator drop a real output
// back to windowed for setup. The renderer drives it: double-click toggles,
// Escape exits.
ipcMain.handle('video-output:set-fullscreen', (event, on) => {
  requireTrustedIpc(event);
  if (videoOutputWindow && !videoOutputWindow.isDestroyed()) {
    // The output page only ever asks to leave fullscreen for its Escape key.
    // That stays a preview-window convenience; an audience display leaves
    // fullscreen only when the operator chooses it from the control window
    // or the output's own menu.
    const escapeOnAudienceDisplay = on !== true &&
      event.sender === videoOutputWindow.webContents &&
      videoOutputWindow.videoOutputTargetDisplayId != null;
    if (!escapeOnAudienceDisplay) setOutputFullscreen(videoOutputWindow, process.platform, on === true);
  }
  return broadcastVideoOutputStatus();
});

ipcMain.handle('video-output:toggle-fullscreen', (event, openIfClosed) => {
  requireTrustedIpc(event);
  const wasOpen = videoOutputWindow && !videoOutputWindow.isDestroyed();
  if (!wasOpen && openIfClosed === true) openVideoOutputWindow();
  if (videoOutputWindow && !videoOutputWindow.isDestroyed()) {
    setOutputFullscreen(videoOutputWindow, process.platform,
      !wasOpen || !isOutputFullscreen(videoOutputWindow, process.platform));
  }
  return broadcastVideoOutputStatus();
});

ipcMain.handle('video-output:test-card', async (event, show) => {
  requireTrustedIpc(event);
  return setVideoOutputTestCard(show);
});

ipcMain.handle('video-output:test-card-config', async (event, value) => {
  requireTrustedIpc(event);
  const config = readVideoOutputConfig();
  config.testCardConfig = createTestCardConfig(value);
  writeVideoOutputConfig(config);
  broadcastVideoOutputStatus();
  await reconcileTestCardPlayback();
  return videoOutputStatus();
});

ipcMain.handle('video-output:test-card-connection', async (event, value) => {
  requireVideoOutputIpc(event);
  const previousConnection = videoOutputTestCardConnection;
  if (value === null) {
    videoOutputTestCardConnection = null;
  } else {
    const config = readLiveplayConfig();
    const expectedUrl = config.mode === 'remote'
      ? config.remoteUrl : 'http://127.0.0.1:' + config.localPort;
    const serverUrl = new URL(requireIpcString(value?.serverUrl, 'serverUrl', 2048));
    if (!['http:', 'https:'].includes(serverUrl.protocol) || serverUrl.username || serverUrl.password
      || serverUrl.toString().replace(/\/+$/, '') !== new URL(expectedUrl).toString().replace(/\/+$/, '')) {
      throw new Error('AV Sync must use the selected Cue server.');
    }
    const accessToken = typeof value.accessToken === 'string' ? value.accessToken : '';
    if (accessToken.length > 8192 || /[\0\r\n]/.test(accessToken)) throw new Error('Invalid server credential.');
    videoOutputTestCardConnection = {
      serverUrl: serverUrl.toString().replace(/\/+$/, ''), accessToken,
      local: config.mode !== 'remote',
    };
  }
  if (value === null) await testCardPlayback.update(null, previousConnection);
  else await reconcileTestCardPlayback();
  return videoOutputStatus();
});

// Create state viewer window for debugging
function createStateViewerWindow() {
  if (stateViewerWindow) {
    stateViewerWindow.focus();
    return;
  }
  // Tell the main renderer a viewer exists so it starts broadcasting state
  // (it stays silent otherwise — serialising whole-project state every
  // 500ms for nobody was the update-app-state spam source).
  mainWindow?.webContents.send('state-viewer:active', true);

  stateViewerWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'DonWells Cue - Current State Viewer',
    icon: path.join(__dirname, '../assets/icons/2x/app_icon_darkmode@2x.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload-state-viewer.js'),
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    }
  });

  // Create a simple HTML page for the state viewer
  const stateViewerHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>DonWells Cue State Viewer</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background: #1e1e1e;
          color: #d4d4d4;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          height: 100vh;
        }
        
        .header {
          background: #252526;
          padding: 12px 20px;
          border-bottom: 1px solid #3e3e42;
          flex-shrink: 0;
        }
        
        h1 {
          font-size: 16px;
          font-weight: 600;
          color: #cccccc;
        }
        
        .container {
          flex: 1;
          overflow-y: auto;
          padding: 20px;
        }
        
        .state-section {
          margin-bottom: 24px;
          background: #252526;
          border: 1px solid #3e3e42;
          border-radius: 4px;
          overflow: hidden;
        }
        
        .section-header {
          background: #2d2d30;
          padding: 10px 16px;
          font-weight: 600;
          font-size: 13px;
          color: #cccccc;
          border-bottom: 1px solid #3e3e42;
          cursor: pointer;
          user-select: none;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        
        .section-header:hover {
          background: #3e3e42;
        }
        
        .collapse-icon {
          font-size: 12px;
          transition: transform 0.2s;
        }
        
        .collapse-icon.collapsed {
          transform: rotate(-90deg);
        }
        
        .section-content {
          padding: 16px;
          overflow: hidden;
        }
        
        .section-content.collapsed {
          display: none;
        }
        
        pre {
          font-family: 'IBM Plex Mono', 'Consolas', monospace;
          font-size: 12px;
          line-height: 1.5;
          overflow-x: auto;
          white-space: pre;
        }
        
        /* JSON Syntax Highlighting */
        .json-key {
          color: #9cdcfe;
        }
        
        .json-string {
          color: #ce9178;
        }
        
        .json-number {
          color: #b5cea8;
        }
        
        .json-boolean {
          color: #569cd6;
        }
        
        .json-null {
          color: #569cd6;
        }
        
        .update-time {
          font-size: 11px;
          color: #858585;
          margin-top: 8px;
        }
        
        ::-webkit-scrollbar {
          width: 10px;
          height: 10px;
        }
        
        ::-webkit-scrollbar-track {
          background: #1e1e1e;
        }
        
        ::-webkit-scrollbar-thumb {
          background: #424242;
          border-radius: 5px;
        }
        
        ::-webkit-scrollbar-thumb:hover {
          background: #4e4e4e;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>DonWells Cue - Current State Viewer (Development Mode)</h1>
      </div>
      <div class="container" id="container"></div>
      
      <script>
        const collapsedSections = new Set();
        const scrollPositions = new Map();
        
        function syntaxHighlight(json) {
          json = JSON.stringify(json, null, 2);
          json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          return json.replace(/("(\\\\u[a-zA-Z0-9]{4}|\\\\[^u]|[^\\\\"])*"(\\s*:)?|\\b(true|false|null)\\b|-?\\d+(?:\\.\\d*)?(?:[eE][+\\-]?\\d+)?)/g, function (match) {
            let cls = 'json-number';
            if (/^"/.test(match)) {
              if (/:$/.test(match)) {
                cls = 'json-key';
              } else {
                cls = 'json-string';
              }
            } else if (/true|false/.test(match)) {
              cls = 'json-boolean';
            } else if (/null/.test(match)) {
              cls = 'json-null';
            }
            return '<span class="' + cls + '">' + match + '</span>';
          });
        }
        
        function toggleSection(sectionId) {
          const section = document.getElementById(sectionId);
          const icon = document.getElementById(sectionId + '-icon');
          const content = document.getElementById(sectionId + '-content');
          
          if (collapsedSections.has(sectionId)) {
            collapsedSections.delete(sectionId);
            content.classList.remove('collapsed');
            icon.classList.remove('collapsed');
          } else {
            // Save scroll position before collapsing
            scrollPositions.set(sectionId, content.scrollTop);
            collapsedSections.add(sectionId);
            content.classList.add('collapsed');
            icon.classList.add('collapsed');
          }
        }
        
        function updateState(state) {
          console.log('[State Viewer] updateState called with:', Object.keys(state));
          const container = document.getElementById('container');
          if (!container) {
            console.error('[State Viewer] Container not found!');
            return;
          }
          
          const currentScroll = container.scrollTop;
          
          // Save scroll positions for each section
          const sections = container.querySelectorAll('.section-content');
          sections.forEach(section => {
            if (section.id) {
              scrollPositions.set(section.id, section.scrollTop);
            }
          });
          
          let html = '';
          
          for (const [key, value] of Object.entries(state)) {
            const sectionId = 'section-' + key;
            const isCollapsed = collapsedSections.has(sectionId);
            
            html += \`
              <div class="state-section">
                <div class="section-header" onclick="toggleSection('\${sectionId}')">
                  <span>\${key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}</span>
                  <span class="collapse-icon \${isCollapsed ? 'collapsed' : ''}" id="\${sectionId}-icon">▼</span>
                </div>
                <div class="section-content \${isCollapsed ? 'collapsed' : ''}" id="\${sectionId}-content">
                  <pre>\${syntaxHighlight(value)}</pre>
                  <div class="update-time">Last updated: \${new Date().toLocaleTimeString()}</div>
                </div>
              </div>
            \`;
          }
          
          container.innerHTML = html;
          console.log('[State Viewer] Updated DOM with', Object.keys(state).length, 'sections');
          
          // Restore scroll positions
          container.scrollTop = currentScroll;
          scrollPositions.forEach((scrollTop, sectionId) => {
            const section = document.getElementById(sectionId);
            if (section) {
              section.scrollTop = scrollTop;
            }
          });
        }
        
        // Listen for state updates
        window.electronAPI.onStateUpdate((event, state) => {
          console.log('[State Viewer] Received state update:', Object.keys(state));
          updateState(state);
        });
        
        // Initial message
        console.log('[State Viewer] Initialized, waiting for updates...');
        updateState({
          message: 'Waiting for state updates from main application...'
        });
      </script>
    </body>
    </html>
  `;

  stateViewerWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(stateViewerHTML));

  // Make sure the window is ready before we start receiving updates
  stateViewerWindow.webContents.once('did-finish-load', () => {
    console.log('[Main] State viewer window loaded and ready');
  });

  stateViewerWindow.on('closed', () => {
    stateViewerWindow = null;
    console.log('[Main] State viewer closed — notifying renderer to stop state broadcasts');
    mainWindow?.webContents.send('state-viewer:active', false);
  });
}

// Translation strings for menu (default: English)
// Dynamically load all locale files from the locales directory
function loadLocaleFiles() {
  const localesDir = path.join(__dirname, '../locales');
  const localeFiles = {};
  
  try {
    // Read all files in the locales directory
    const files = fs.readdirSync(localesDir);
    
    // Filter for JSON files and load them
    files.forEach(file => {
      if (file.endsWith('.json')) {
        const code = file.replace('.json', '');
        try {
          localeFiles[code] = require(path.join(localesDir, file));
          console.log(`Loaded locale: ${code}`);
        } catch (error) {
          console.error(`Failed to load locale ${code}:`, error);
        }
      }
    });
    
    console.log(`Loaded ${Object.keys(localeFiles).length} locale files`);
  } catch (error) {
    console.error('Failed to read locales directory:', error);
    // Fallback to English if directory read fails
    localeFiles.en = require('../locales/en.json');
  }
  
  return localeFiles;
}

const localeFiles = loadLocaleFiles();

// Build menu translations from locale files
const menuTranslations = Object.entries(localeFiles).reduce((acc, [code, data]) => {
  acc[code] = {
    file: data.menu.file,
    newProject: data.menu.newProject,
    openProject: data.menu.openProject,
    openRecent: data.menu.openRecent || 'Open Recent',
    clearRecentProjects: data.menu.clearRecentProjects || 'Clear Recently Opened',
    noRecentProjects: data.menu.noRecentProjects || 'No Recent Projects',
    saveProject: data.menu.saveProject,
    exportProject: data.menu.exportProject,
    exportCueSheet: data.menu.exportCueSheet || 'Export Cue Sheet (PDF)…',
    cleanUpMedia: data.menu.cleanUpMedia || 'Clean Up Media…',
    importProject: data.menu.importProject,
    closeProject: data.menu.closeProject,
    openProjectFolder: data.menu.openProjectFolder,
    exit: data.menu.exit,
    view: data.menu.view,
    toggleDarkMode: data.menu.toggleDarkMode,
    changeAccentColor: data.menu.changeAccentColor,
    fullscreen: data.menu.fullscreen,
    language: data.menu.language,
    help: data.menu.help,
    operatorManual: data.menu.operatorManual,
    checkForUpdates: data.menu.checkForUpdates,
    about: data.menu.about,
    videoOutputEnterFullscreen: data.menu.videoOutputEnterFullscreen,
    videoOutputExitFullscreen: data.menu.videoOutputExitFullscreen,
    videoOutputShowTestCard: data.menu.videoOutputShowTestCard,
    videoOutputExit: data.menu.videoOutputExit
  };
  return acc;
}, {});

let currentLocale = 'en';

// Build the File > Open Recent submenu from the persisted recent-projects
// list. Each entry sends its server-filesystem path to the renderer, which
// closes any open project (with an unsaved-changes guard) before loading it.
// A disabled placeholder is shown when the list is empty.
function buildRecentProjectsSubmenu(t) {
  const recent = readRecentProjects();
  if (recent.length === 0) {
    return [{ label: t.noRecentProjects, enabled: false }];
  }
  const items = recent.map((entry) => ({
    label: entry.name ? `${entry.name}  —  ${entry.path}` : entry.path,
    click: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('menu-open-recent-project', entry.path);
      }
    },
  }));
  items.push(
    { type: 'separator' },
    {
      label: t.clearRecentProjects,
      click: () => { clearRecentProjects(); createMenu(currentLocale, isDevMode); },
    },
  );
  return items;
}

function createMenu(locale = 'en', isDev = false) {
  currentLocale = locale;
  const t = menuTranslations[locale] || menuTranslations.en;
  const appMenu = process.platform === 'darwin' ? [{ role: 'appMenu' }] : [];

  if (operatorManual.owns(BrowserWindow.getFocusedWindow()?.webContents)) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...appMenu,
      { label: t.file, submenu: [{ role: 'close' }] },
      { role: 'editMenu' },
      { label: t.help, submenu: [{ label: t.operatorManual, click: () => void operatorManual.open(mainWindow, t.operatorManual) }] },
    ]));
    return;
  }
  const template = [
    ...appMenu,
    {
      label: t.file,
      submenu: [
        {
          label: t.newProject,
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            mainWindow.webContents.send('menu-new-project');
          }
        },
        {
          label: t.openProject,
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            mainWindow.webContents.send('menu-open-project');
          }
        },
        {
          label: t.openRecent,
          submenu: buildRecentProjectsSubmenu(t),
        },
        {
          label: t.saveProject,
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            mainWindow.webContents.send('menu-save-project');
          }
        },
        { type: 'separator' },
        {
          label: t.exportProject,
          enabled: currentProject !== null,
          click: () => {
            mainWindow.webContents.send('menu-export-project');
          }
        },
        {
          label: t.importProject,
          click: () => {
            mainWindow.webContents.send('menu-import-project');
          }
        },
        {
          label: t.exportCueSheet,
          enabled: currentProject !== null,
          click: () => {
            mainWindow.webContents.send('menu-export-cue-sheet');
          }
        },
        {
          label: t.cleanUpMedia,
          enabled: currentProject !== null,
          click: () => {
            mainWindow.webContents.send('menu-clean-up-media');
          }
        },
        { type: 'separator' },
        {
          label: t.openProjectFolder,
          enabled: currentProject !== null &&
            path.isAbsolute(currentProject) &&
            pathCapabilities.allows(currentProject),
          click: () => {
            mainWindow.webContents.send('menu-open-project-folder');
          }
        },
        { type: 'separator' },
        {
          label: t.closeProject,
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            mainWindow.webContents.send('menu-close-project');
          }
        },
        { type: 'separator' },
        {
          label: t.exit,
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            app.quit();
          }
        }
      ]
    },
    { role: 'editMenu' },
    {
      label: t.view,
      submenu: [
        {
          label: t.toggleDarkMode,
          click: () => {
            mainWindow.webContents.send('menu-toggle-dark-mode');
          }
        },
        {
          label: t.changeAccentColor,
          enabled: !!currentProject,
          click: () => {
            mainWindow.webContents.send('menu-change-accent-color');
          }
        },
        { type: 'separator' },
        // macOS fullscreen is a Space, and one would blank the audience
        // display (video-output-window.js): a Mac window fills its screen instead.
        process.platform === 'darwin' ? { role: 'zoom' } : {
          label: t.fullscreen,
          accelerator: 'F11',
          click: () => {
            const isFullScreen = mainWindow.isFullScreen();
            mainWindow.setFullScreen(!isFullScreen);
          }
        },
        { type: 'separator' },
        {
          label: t.language,
          submenu: Object.values(localeFiles).map((localeData) => ({
            label: localeData._metadata.nativeName,
            type: 'radio',
            checked: locale === localeData._metadata.code,
            click: () => {
              mainWindow.webContents.send('menu-change-language', localeData._metadata.code);
              createMenu(localeData._metadata.code, isDev);
            }
          }))
        },
        ...(isDev ? [
          { type: 'separator' },
          {
            label: 'Show Current State',
            accelerator: 'CmdOrCtrl+Shift+D',
            click: () => {
              createStateViewerWindow();
            }
          },
          { type: 'separator' },
          { role: 'reload' },
          { role: 'forceReload' },
          { 
          label: 'Toggle Developer Tools',
          accelerator: process.platform === 'darwin' ? 'Alt+Command+I' : 'Ctrl+Shift+I',
          click: () => {
            if (mainWindow && mainWindow.webContents) {
              mainWindow.webContents.toggleDevTools();
            }
          }
        }
        ] : [])
      ]
    },
    {
      label: t.help,
      submenu: [
        {
          label: t.operatorManual,
          click: () => void operatorManual.open(mainWindow, t.operatorManual),
        },
        { type: 'separator' },
        ...(!isDev ? [
          {
            label: t.checkForUpdates,
            click: () => {
              mainWindow.webContents.send('menu-check-for-updates');
            }
          },
          { type: 'separator' },
        ] : []),
        {
          label: t.about,
          click: () => {
            mainWindow.webContents.send('menu-show-about');
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// IPC Handlers
ipcMain.handle('help:open-operator-manual', (event) => {
  requireTrustedIpc(event);
  const t = menuTranslations[currentLocale] || menuTranslations.en;
  return operatorManual.open(mainWindow, t.operatorManual);
});

ipcMain.handle('select-project-folder', async (event) => {
  requireTrustedIpc(event);
  const result = await showNativeFilePicker(() => dialog.showOpenDialog({
    defaultPath: nativePickerFolder('project-folder'),
    properties: ['openDirectory', 'createDirectory']
  }));

  if (!result.canceled && result.filePaths.length > 0) {
    rememberNativePickerFolder('project-folder', result.filePaths[0]);
    return pathCapabilities.authorizeRoot(result.filePaths[0]);
  }
  return null;
});

ipcMain.handle('select-project-file', async (event) => {
  requireTrustedIpc(event);
  const result = await showNativeFilePicker(() => dialog.showOpenDialog({
    defaultPath: nativePickerFolder('project-open'),
    properties: ['openFile'],
    filters: [{ name: 'DonWells Cue Show', extensions: ['dwcue'] }],
  }));

  if (result.canceled || result.filePaths.length === 0) return null;
  const selectedPath = result.filePaths[0];
  if (fileKindFor(selectedPath) !== ProjectFileKind.NativeProject) return null;
  rememberNativePickerFolder('project-open', path.dirname(selectedPath));
  return authorizeOpenableFilePath(selectedPath);
});

// File > Export Cue Sheet (PDF). Read-only: the renderer sends a plain summary
// of the open show and nothing here touches the transport or the show file.
// The sheet is printed by a hidden, sandboxed window with JavaScript off. It
// loads a private temporary file because Chromium rejects data: URLs over
// 2 MB, which a long playlist exceeds.
const CUE_SHEET_RENDER_TIMEOUT_MS = 120000;
let cueSheetExportActive = false;

async function renderCueSheetPdf(html, pdfOptions) {
  const folder = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'dwcue-cue-sheet-'));
  let printWindow = null;
  let timer = null;
  try {
    const htmlPath = path.join(folder, 'cue-sheet.html');
    await fs.promises.writeFile(htmlPath, html, 'utf8');
    printWindow = new BrowserWindow(cueSheetWindowOptions());
    const printed = printWindow.loadFile(htmlPath)
      .then(() => printWindow.webContents.printToPDF(pdfOptions));
    // If the timeout wins, the abandoned print rejects when its window closes.
    printed.catch(() => {});
    return await Promise.race([
      printed,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out while rendering the cue sheet')),
          CUE_SHEET_RENDER_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (printWindow && !printWindow.isDestroyed()) printWindow.destroy();
    await fs.promises.rm(folder, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

// Keep the computer awake during a show. The operator window reports whether
// a show is open, whether it is in Show Mode and whether anything is playing;
// keep-awake.js turns that into the holds to take. Independent of the Video
// Output's own hold, which exists while that window does.
const keepAwakeHolds = { system: null, display: null };

function releaseKeepAwake() {
  applyKeepAwake(powerSaveBlocker, keepAwakeHolds, { system: false, display: false });
}

ipcMain.handle('power:keep-awake', (event, state) => {
  requireTrustedIpc(event);
  requireBoundedIpcObject(state, 'keep-awake state', 1024);
  // Only the operator window speaks for the show; the QuickPlays and Video
  // Output windows see the same project and would only repeat it.
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  applyKeepAwake(powerSaveBlocker, keepAwakeHolds, keepAwakePlan(state));
  return true;
});

ipcMain.handle('export-cue-sheet', async (event, payload) => {
  requireTrustedIpc(event);
  if (payload === null) throw new TypeError('cue sheet must be an object');
  requireBoundedIpcObject(payload, 'cue sheet', CUE_SHEET_LIMITS.maxPayloadBytes);
  if (cueSheetExportActive) return { status: 'busy' };
  cueSheetExportActive = true;
  try {
    const sheet = normalizeCueSheet(payload);
    const labels = normalizeCueSheetLabels(payload.labels);
    // The destination comes only from this dialog, never from the renderer.
    const folder = nativePickerFolder('cue-sheet');
    const fileName = cueSheetFileName(sheet.showName);
    const result = await showNativeFilePicker(() => dialog.showSaveDialog({
      defaultPath: folder ? path.join(folder, fileName) : fileName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    }));
    if (result.canceled || !result.filePath) return { status: 'cancelled' };

    const language = { locale: currentLocale, direction: localeFiles[currentLocale]?._metadata?.direction };
    const pdf = await renderCueSheetPdf(
      buildCueSheetHtml(sheet, labels, { ...language, generatedAt: new Date() }),
      cueSheetPdfOptions(sheet.showName, labels, language),
    );
    await fs.promises.writeFile(result.filePath, pdf);
    rememberNativePickerFolder('cue-sheet', path.dirname(result.filePath));
    return { status: 'saved', fileName: path.basename(result.filePath) };
  } catch (error) {
    const message = String(error?.message || error).split('\n')[0].slice(0, 200);
    console.warn('[cue-sheet] export failed:', message);
    return { status: 'failed', error: message };
  } finally {
    cueSheetExportActive = false;
  }
});

const mediaPickerExtensions = [
  'mp3', 'wav', 'aiff', 'aif', 'flac', 'ogg', 'oga', 'm4a', 'aac', 'mp2',
  'wma', 'opus', 'ac3', 'amr', 'au', 'caf',
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'mpg', 'mpeg', 'm2ts', 'mts',
  'wmv', 'flv', '3gp',
];

ipcMain.handle('scan-media-folder', async (event, input) => {
  requireTrustedIpc(event);
  if (readLiveplayConfig().mode !== 'local') throw new Error('Folder scan requires the local audio engine');
  const folder = requireAbsoluteIpcPath(input, 'folder');
  const remaining = [folder];
  const files = [];
  const skippedFolders = [];
  while (remaining.length) {
    const dir = remaining.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (dir === folder) throw error;
      skippedFolders.push(path.relative(folder, dir));
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) remaining.push(fullPath);
      else if (entry.isFile() && mediaPickerExtensions.includes(path.extname(entry.name).slice(1).toLowerCase()))
        files.push(fullPath);
    }
  }
  files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { name: path.basename(folder) || folder, files, skippedFolders: skippedFolders.sort() };
});

ipcMain.handle('get-import-preferences', (event) => {
  requireTrustedIpc(event);
  const preferences = readImportPreferences();
  const destination = preferences.spotifyDestination;
  const response = { spotifyDestination: '', spotifyRecovery: null };
  if (destination && path.isAbsolute(destination) && fs.existsSync(destination) &&
      fs.statSync(destination).isDirectory()) {
    response.spotifyDestination = pathCapabilities.authorizeRoot(destination);
  }
  const recovery = preferences.spotifyRecovery;
  if (recovery && [
    recovery.activeProjectFolderPath,
    recovery.destinationParentPath,
    recovery.projectFolderPath,
  ].every((folderPath) => fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory())) {
    const availablePending = recovery.pendingTrackIds
      .map((id, index) => ({ id, file: recovery.pendingFiles[index] }))
      .filter(({ file }) => file && fs.existsSync(file) && fs.statSync(file).isFile());
    const missingPendingIds = recovery.pendingTrackIds
      .filter((id) => !availablePending.some((pending) => pending.id === id));
    const restoredRecovery = normalizeSpotifyRecovery({
      ...recovery,
      failedTrackIds: [...new Set([...recovery.failedTrackIds, ...missingPendingIds])],
      pendingTrackIds: availablePending.map(({ id }) => id),
      pendingFiles: availablePending.map(({ file }) => file),
    });
    pathCapabilities.authorizeRoot(recovery.activeProjectFolderPath);
    pathCapabilities.authorizeRoot(recovery.destinationParentPath);
    pathCapabilities.authorizeRoot(recovery.projectFolderPath);
    for (const { file } of availablePending) pathCapabilities.authorizeFile(file);
    response.spotifyRecovery = restoredRecovery;
    if (restoredRecovery && missingPendingIds.length) {
      writeImportPreferences({ ...preferences, spotifyRecovery: restoredRecovery });
    }
  }
  return { ...response, preferencesSaved: !unsavedImportPreferences };
});

// The preload only calls this with a path extracted from an OS-backed File.
ipcMain.handle('authorize-dropped-spotify-folder', (event, folder) => {
  requireTrustedIpc(event);
  return pathCapabilities.authorizeRoot(requireAbsoluteIpcPath(folder, 'folder'));
});

ipcMain.handle('set-spotify-import-destination', (event, destination) => {
  requireTrustedIpc(event);
  destination = requireAuthorizedIpcPath(destination, 'destination');
  if (!fs.statSync(destination).isDirectory()) throw new TypeError('destination must be a directory');
  return writeImportPreferences({ ...readImportPreferences(), spotifyDestination: destination });
});

ipcMain.handle('set-spotify-import-recovery', (event, rawRecovery) => {
  requireTrustedIpc(event);
  rawRecovery = requireBoundedIpcObject(rawRecovery, 'recovery', 1024 * 1024);
  const recovery = normalizeSpotifyRecovery(rawRecovery);
  if (!recovery) throw new TypeError('recovery is invalid');
  for (const [name, folderPath] of [
    ['activeProjectFolderPath', recovery.activeProjectFolderPath],
    ['destinationParentPath', recovery.destinationParentPath],
    ['projectFolderPath', recovery.projectFolderPath],
  ]) {
    requireAuthorizedIpcPath(folderPath, name);
    if (!fs.statSync(folderPath).isDirectory()) throw new TypeError(`${name} must be a directory`);
  }
  for (const filePath of recovery.pendingFiles) {
    requireAuthorizedIpcPath(filePath, 'pendingFile');
    if (!fs.statSync(filePath).isFile()) throw new TypeError('pendingFile must be a file');
  }
  return writeImportPreferences({ ...readImportPreferences(), spotifyRecovery: recovery });
});

ipcMain.handle('clear-spotify-import-recovery', (event, activeProjectFolderPath) => {
  requireTrustedIpc(event);
  activeProjectFolderPath = requireAuthorizedIpcPath(
    activeProjectFolderPath, 'activeProjectFolderPath');
  const preferences = readImportPreferences();
  if (preferences.spotifyRecovery?.activeProjectFolderPath === activeProjectFolderPath) {
    return writeImportPreferences({ ...preferences, spotifyRecovery: null });
  }
  return !unsavedImportPreferences;
});

// This channel is intentionally not exposed directly. The preload invokes it
// only after Electron's webUtils extracts a real OS path from a dropped File.
ipcMain.on('authorize-dropped-file', (event, filePath) => {
  try {
    requireTrustedIpc(event);
    const checkedPath = requireAbsoluteIpcPath(filePath, 'filePath');
    if (!fs.existsSync(checkedPath) || !fs.statSync(checkedPath).isFile()) return;
    if (fileKindFor(checkedPath) === ProjectFileKind.NativeProject) {
      pathCapabilities.authorizeProjectFile(checkedPath);
    } else {
      pathCapabilities.authorizeFile(checkedPath);
    }
  } catch (error) {
    console.warn('[path-capabilities] rejected dropped file:', error.message);
  }
});

ipcMain.handle('read-file', async (event, filePath) => {
  try {
    requireTrustedIpc(event);
    const checkedPath = requireAuthorizedIpcPath(filePath, 'filePath');
    const data = fs.readFileSync(checkedPath, 'utf8');
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-binary-file-info', async (event, filePath) => {
  try {
    requireTrustedIpc(event);
    const checkedPath = requireAuthorizedIpcPath(filePath, 'filePath');
    const stat = await fs.promises.stat(checkedPath);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size)) {
      throw new Error('filePath is not a regular file with a supported size');
    }
    return { success: true, size: stat.size, name: path.basename(checkedPath) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('read-binary-file-chunk', async (event, filePath, offset, length) => {
  let handle;
  try {
    requireTrustedIpc(event);
    const checkedPath = requireAuthorizedIpcPath(filePath, 'filePath');
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError('offset must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_BINARY_CHUNK_BYTES) {
      throw new RangeError(`length must be between 1 and ${MAX_BINARY_CHUNK_BYTES} bytes`);
    }
    handle = await fs.promises.open(checkedPath, 'r');
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const bytes = buffer.subarray(0, bytesRead);
    return {
      success: true,
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    await handle?.close().catch(() => {});
  }
});

ipcMain.handle('write-file', async (event, filePath, data) => {
  let tempPath = '';
  try {
    requireTrustedIpc(event);
    const checkedPath = requireAuthorizedIpcPath(filePath, 'filePath', true);
    if (typeof data !== 'string') throw new TypeError('data must be a string');
    tempPath = path.join(
      path.dirname(checkedPath),
      `.dwcue-write-${crypto.randomBytes(16).toString('hex')}.tmp`,
    );
    await fs.promises.writeFile(tempPath, data, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await fs.promises.rename(tempPath, checkedPath);
    tempPath = '';
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    if (tempPath) await fs.promises.unlink(tempPath).catch(() => {});
  }
});

const archiveDownloadFolders = new Set();
ipcMain.handle('archive-download-folder', async (event, droppedPath) => {
  requireTrustedIpc(event);
  const selected = requireAbsoluteIpcPath(droppedPath ?? app.getPath('downloads'), 'folder');
  const folder = await fs.promises.realpath(selected);
  if (!(await fs.promises.stat(folder)).isDirectory()) throw new Error('Choose a folder.');
  archiveDownloadFolders.add(folder);
  return folder;
});

// Stage the stream next to its destination so an incomplete transfer cannot replace a backup.
ipcMain.handle('download-archive-to-file', async (event, request) => {
  let tempPath = '';
  try {
    requireTrustedIpc(event);
    const checked = requireBoundedIpcObject(request, 'request', 16 * 1024);
    const folder = requireAbsoluteIpcPath(checked.folder, 'folder');
    if (!archiveDownloadFolders.has(folder) || await fs.promises.realpath(folder) !== folder) {
      throw new Error('Choose a download folder first.');
    }
    const name = requireIpcString(checked.filename, 'filename', 255).trim();
    const filename = canonicalArchivePath(name);
    if (!name || name.startsWith('.') || /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
        /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *\./i.test(filename) ||
        Buffer.byteLength(filename, 'utf8') > 255) {
      throw new Error('Enter a valid archive filename.');
    }
    const destination = path.join(folder, filename);
    const token = requireIpcString(checked.token, 'token', 64);
    if (!/^[0-9a-f]{64}$/.test(token)) {
      throw new TypeError('token must be 64 lowercase hexadecimal characters');
    }
    const rawBaseUrl = requireIpcString(checked.baseUrl, 'baseUrl', 2048);
    const baseUrl = new URL(rawBaseUrl);
    if (!['http:', 'https:'].includes(baseUrl.protocol) ||
        baseUrl.username || baseUrl.password) {
      throw new TypeError('baseUrl must be an HTTP(S) URL without credentials');
    }
    const accessToken = checked.accessToken ?? '';
    if (typeof accessToken !== 'string' || accessToken.length > 8192 ||
        /[\0\r\n]/.test(accessToken)) {
      throw new TypeError('accessToken is invalid');
    }

    const endpoint = new URL(baseUrl);
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/api/file/download';
    endpoint.search = '';
    endpoint.searchParams.set('token', token);
    endpoint.hash = '';
    const headers = accessToken
      ? { Authorization: `Bearer ${accessToken}` }
      : undefined;
    const response = await fetch(endpoint, { headers, redirect: 'error' });
    if (!response.ok || !response.body) {
      throw new Error(`download failed: ${response.status} ${response.statusText}`);
    }
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null &&
        (!/^\d+$/.test(declaredLength) ||
         Number(declaredLength) > MAX_ARCHIVE_DOWNLOAD_BYTES)) {
      throw new Error('download exceeds the supported archive size');
    }

    tempPath = path.join(
      path.dirname(destination),
      `.dwcue-download-${crypto.randomBytes(16).toString('hex')}.part`);
    let received = 0;
    const sizeLimit = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        callback(
          received <= MAX_ARCHIVE_DOWNLOAD_BYTES
            ? null
            : new Error('download exceeds the supported archive size'),
          chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      sizeLimit,
      fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }));
    if (declaredLength !== null && Number(declaredLength) !== received) {
      throw new Error('The archive download was incomplete.');
    }
    try {
      await fs.promises.link(tempPath, destination);
    } catch (error) {
      if (!['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EXDEV'].includes(error.code)) throw error;
      // shortcut: On filesystems without hard links, copy once more. Use a no-replace rename if large copies become a bottleneck.
      await fs.promises.copyFile(tempPath, destination, fs.constants.COPYFILE_EXCL);
    }

    await fetch(endpoint, {
      method: 'DELETE',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined);
    return { success: true, path: destination };
  } catch (error) {
    return { success: false, error: error.code === 'EEXIST'
      ? 'An archive with that name already exists. Enter a different filename.'
      : error.message };
  } finally {
    if (tempPath) await fs.promises.unlink(tempPath).catch(() => {});
  }
});

ipcMain.handle('copy-file', async (event, source, destination) => {
  try {
    requireTrustedIpc(event);
    const checkedSource = requireAuthorizedIpcPath(source, 'source');
    const checkedDestination = requireAuthorizedIpcPath(destination, 'destination', true);
    // Ensure destination directory exists
    const destDir = path.dirname(checkedDestination);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.copyFileSync(checkedSource, checkedDestination);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ensure-directory', async (event, dirPath) => {
  try {
    requireTrustedIpc(event);
    const checkedPath = requireAuthorizedIpcPath(dirPath, 'dirPath', true);
    if (!fs.existsSync(checkedPath)) {
      fs.mkdirSync(checkedPath, { recursive: true });
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('open-folder', async (event, folderPath) => {
  try {
    requireTrustedIpc(event);
    const checkedPath = requireAuthorizedIpcPath(folderPath, 'folderPath');
    const error = await shell.openPath(checkedPath);
    if (error) throw new Error(error);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Open external URL in default browser
ipcMain.handle('open-external', async (event, url) => {
  try {
    requireTrustedIpc(event);
    await safeOpenExternal(url);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Update menu language from renderer
ipcMain.handle('update-menu-language', async (event, locale) => {
  requireTrustedIpc(event);
  if (typeof locale !== 'string' || !(locale in localeFiles)) {
    throw new TypeError('locale is not available');
  }
  createMenu(locale, isDevMode);
  return { success: true };
});

// Auto-updater IPC handlers. The feed is configured above (setFeedURL pins
// donwellsav/dwcue); these only run the flow.
ipcMain.handle('check-for-updates', async (event, silent = false) => {
  requireTrustedIpc(event);
  if (!DWCUE_UPDATES_CONFIGURED || (silent === true && isDevMode)) {
    return { success: false, error: 'Updates are not configured for this build.' };
  }
  try {
    if (silent !== true) manualCheckPending = true;
    const result = await autoUpdater.checkForUpdates();
    // update-available / update-not-available events carry the renderer
    // notification; this return also reports which update was found (null
    // when current version is the latest).
    return { success: true, updateInfo: result?.updateInfo ?? null };
  } catch (error) {
    manualCheckPending = false;
    console.error('Check for updates error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('download-update', async (event) => {
  requireTrustedIpc(event);
  if (!DWCUE_UPDATES_CONFIGURED) {
    return { success: false, error: 'Updates are not configured for this build.' };
  }
  if (!updatesInstallSupported) {
    return { success: false, error: 'updates-unsupported-package' };
  }
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (error) {
    console.error('Download update error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('install-update', async (event) => {
  requireTrustedIpc(event);
  return installDownloadedUpdate();
});

// Whether this install can self-update in place (see updatesInstallSupported
// above): macOS/Windows always; Linux only when launched as an AppImage. Other
// Linux package installs use this to offer the downloads page instead.
ipcMain.handle('get-update-install-supported', (event) => {
  requireTrustedIpc(event);
  return updatesInstallSupported;
});

ipcMain.handle('get-app-version', (event) => {
  requireTrustedIpc(event);
  return app.getVersion();
});

ipcMain.handle('get-system-locale', (event) => {
  requireTrustedIpc(event);
  // Get the system locale from Electron
  const systemLocale = app.getLocale(); // Returns locale like 'en-US', 'es-ES', 'fr-FR', etc.
  
  // Extract just the language code (e.g., 'en' from 'en-US')
  const languageCode = systemLocale.split('-')[0].toLowerCase();
  
  return languageCode;
});

ipcMain.handle('get-available-locales', (event) => {
  requireTrustedIpc(event);
  // Return list of available locale codes and metadata
  return Object.keys(localeFiles).map(code => ({
    code,
    name: localeFiles[code]._metadata.nativeName,
    direction: localeFiles[code]._metadata.direction
  }));
});

ipcMain.handle('get-locale-data', (event, localeCode) => {
  requireTrustedIpc(event);
  requireIpcString(localeCode, 'localeCode', 32);
  // Return the full locale data for a specific locale
  if (localeCode in localeFiles) {
    return localeFiles[localeCode];
  }
  // Fallback to English if locale not found
  return localeFiles.en;
});

ipcMain.handle('set-current-project', async (event, projectPath) => {
  requireTrustedIpc(event);
  if (projectPath === null || projectPath === '') {
    currentProject = null;
  } else {
    const checked = requireIpcString(projectPath, 'projectPath', MAX_IPC_PATH_LENGTH);
    // A live local canonical show is authorized on report, even if no dialog
    // picked it (for example after server auto-restore).
    const isNativeProjectFile = path.isAbsolute(checked) &&
      fileKindFor(checked) === ProjectFileKind.NativeProject &&
      fs.existsSync(checked);
    if (isNativeProjectFile ||
        (path.isAbsolute(checked) && pathCapabilities.allows(checked))) {
      currentProject = isNativeProjectFile
        ? pathCapabilities.authorizeProjectFile(checked)
        : pathCapabilities.require(checked, { label: 'projectPath' });
    } else {
      // Server-side paths may be absolute but are not local capabilities.
      currentProject = checked;
    }
  }
  // Rebuild menu to update enabled/disabled state of menu items
  createMenu(currentLocale, isDevMode);
  return { success: true };
});

// Receive full project data from the primary renderer. Ownership identity stays
// separate from the document so existing API consumers continue to see plain project data.
ipcMain.on('sync-project-data', (event, projectData, identity, captureSession = null) => {
  try {
    requireTrustedIpc(event);
    if (event.sender !== mainWindow?.webContents) {
      throw new Error('sender is not the primary project owner');
    }
    requireBoundedIpcObject(projectData, 'projectData', 10 * 1024 * 1024);
    if (projectData === null) {
      if (identity !== null) throw new TypeError('identity must be null when clearing project data');
    } else {
      validateIdentity(identity);
    }
    if (captureSession !== null) requireIpcString(captureSession, 'captureSession', 256);
  } catch (error) {
    console.warn('[sync-project-data] rejected payload:', error.message);
    return;
  }

  const nextCaptureSession = projectData ? captureSession : null;
  if (nextCaptureSession !== currentCaptureSession || (identity && !sameIdentity(identity, currentProjectIdentity))) {
    videoFrameProbe?.controller.abort();
    videoConversion?.controller.abort();
  }
  currentCaptureSession = nextCaptureSession;
  currentProjectData = projectData;
  currentProjectIdentity = identity;
  // Keep the menu's "Export Project" / similar items in sync with whether
  // a project is actually open in the renderer. The server-backed flow
  // never calls set-current-project explicitly, so without this the menu
  // gate (enabled: currentProject !== null) would stay stuck off forever
  // and File > Export Project would appear greyed out even with a project
  // loaded. Rebuild the menu only when the open/closed transition flips,
  // since createMenu() is not free.
  const nextOpen = projectData
    ? (projectData.folderPath || projectData.name || 'open')
    : null;
  const wasOpen = currentProject !== null;
  const isOpen = nextOpen !== null;
  if (wasOpen !== isOpen) {
    currentProject = nextOpen;
    createMenu(currentLocale, isDevMode);
  } else {
    currentProject = nextOpen;
  }
  // Forward every snapshot, including project closure, to the detached window.
  if (detachedQuickPlayWindow && !detachedQuickPlayWindow.isDestroyed()
      && !detachedQuickPlayWindow.webContents.isDestroyed()) {
    detachedQuickPlayWindow.webContents.send('quickplay-window-project-update', {
      project: currentProjectData,
      identity: currentProjectIdentity,
      projectSessionId: currentCaptureSession,
    });
  }
});

// QuickPlay window IPC handlers
ipcMain.handle('open-detached-quickplay-window', (event, projectFolderPath) => {
  requireTrustedIpc(event);
  if (projectFolderPath !== undefined) {
    requireIpcString(projectFolderPath, 'projectFolderPath', MAX_IPC_PATH_LENGTH);
  }
  createDetachedQuickPlayWindow();
});

ipcMain.handle('toggle-detached-quickplay-window', (event) => {
  requireTrustedIpc(event);
  if (detachedQuickPlayWindow) detachedQuickPlayWindow.close();
  else createDetachedQuickPlayWindow();
});

// The detached QuickPlay window has no full show: its transport keys (GO, Up
// Next, pause...) run in the operator window, as the Video Output's do.
ipcMain.on('quickplay-window:shortcut', (event, shortcut) => {
  try {
    requireTrustedIpc(event);
  } catch (error) {
    console.warn('[quickplay-window:shortcut] rejected event:', error.message);
    return;
  }
  if (!detachedQuickPlayWindow || detachedQuickPlayWindow.isDestroyed() ||
      event.sender !== detachedQuickPlayWindow.webContents) return;
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  if (!shortcut || typeof shortcut !== 'object' || typeof shortcut.key !== 'string' ||
      !shortcut.key || shortcut.key.length > 32) return;
  mainWindow.webContents.send('video-output:shortcut', {
    key: shortcut.key,
    code: typeof shortcut.code === 'string' ? shortcut.code.slice(0, 32) : '',
    ctrlKey: shortcut.ctrlKey === true,
    shiftKey: shortcut.shiftKey === true,
    altKey: shortcut.altKey === true,
    metaKey: shortcut.metaKey === true,
    repeat: shortcut.repeat === true,
  });
});

ipcMain.on('detached-quickplay-window-attach', (event) => {
  try {
    requireTrustedIpc(event);
  } catch (error) {
    console.warn('[detached-quickplay-window-attach] rejected event:', error.message);
    return;
  }
  if (detachedQuickPlayWindow) {
    detachedQuickPlayWindow.close();
  }
});

// UI mode (edit / "show mode") sync across windows. Each renderer owns its
// own state, so broadcast a change from any window to every other window so
// the detached QuickPlay window stays in lockstep with the main window.
ipcMain.on('ui-mode-changed', (event, mode) => {
  try {
    requireTrustedIpc(event);
    if (mode !== 'edit' && mode !== 'playback') {
      throw new TypeError('mode must be edit or playback');
    }
  } catch (error) {
    console.warn('[ui-mode-changed] rejected event:', error.message);
    return;
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.id === event.sender.id) continue;
    if (win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('ui-mode-set', mode);
    }
  }
});

ipcMain.on('quickplay-grid-layouts-changed', (event, layouts) => {
  try {
    requireTrustedIpc(event);
    requireIpcString(layouts, 'layouts', 4096);
  } catch (error) {
    console.warn('[quickplay-grid-layouts-changed] rejected event:', error.message);
    return;
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.id === event.sender.id) continue;
    if (win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('quickplay-grid-layouts-set', layouts);
    }
  }
});

ipcMain.handle('get-quickplay-window-project-data', (event) => {
  requireTrustedIpc(event);
  return { project: currentProjectData, identity: currentProjectIdentity, projectSessionId: currentCaptureSession };
});

ipcMain.handle('quickplay-mutation:request', (event, request) => {
  requireTrustedIpc(event);
  return quickPlayMutationBroker.request(event.sender, request);
});

ipcMain.on('quickplay-mutation:complete', (event, result) => {
  try {
    requireTrustedIpc(event);
    quickPlayMutationBroker.complete(event.sender, result);
  } catch (error) {
    console.warn('[quickplay-mutation:complete] rejected result:', error.message);
  }
});

// State viewer: Receive state updates from renderer and forward to state viewer window
ipcMain.on('update-app-state', (event, state) => {
  try {
    requireTrustedIpc(event);
    requireBoundedIpcObject(state, 'state', 2 * 1024 * 1024);
  } catch (error) {
    console.warn('[update-app-state] rejected payload:', error.message);
    return;
  }
  //console.log('[Main] Received state update, viewer window exists:', !!stateViewerWindow);
  if (stateViewerWindow && !stateViewerWindow.isDestroyed()) {
    // Make sure webContents is ready
    if (stateViewerWindow.webContents && !stateViewerWindow.webContents.isDestroyed()) {
      stateViewerWindow.webContents.send('state-update', state);
    }
  }
});

// Check if dev mode is enabled
ipcMain.handle('is-dev-mode', (event) => {
  requireTrustedIpc(event);
  return isDevMode;
});

const activeSpotifyDownloads = new Map();
const activeSpotifyPreflightJobs = new Map();
const spotifyPreflights = new Map();

function sendSpotifyProgress(sender, progress) {
  if (!sender.isDestroyed()) sender.send('spotify-download-progress', progress);
}

function terminateSpotifyChild(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'],
      { windowsHide: true }, () => {});
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  const timer = setTimeout(() => {
    if (child.exitCode !== null) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }, 2000);
  timer.unref();
}

function summarizeSpotDlError(stdout, stderr, code) {
  const lines = `${stdout}\n${stderr}`
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '').split(/\r?\n/);
  const useful = lines.findLast((line) =>
    !/^\s*\[PYI-\d+:ERROR\] Failed to execute script\b/i.test(line) &&
    /\b(?:\w*(?:error|exception)|failed|no songs found)\b/i.test(line));
  return useful?.trim() || `spotDL exited with code ${code}`;
}

function sanitizeSpotifyFolderName(value) {
  let name = typeof value === 'string' ? value.slice(0, 512).normalize('NFKC') : '';
  name = name
    .replace(/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[ .]+|[ .]+$/g, '');
  while (Buffer.byteLength(name, 'utf8') > 120) name = name.slice(0, -1);
  name = name.replace(/[ .]+$/g, '');
  if (!name ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name)) {
    return 'Spotify Import';
  }
  return name;
}

function spotifyTrackId(track) {
  const id = typeof track?.song_id === 'string' ? track.song_id : '';
  return /^[A-Za-z0-9]{10,64}$/.test(id) ? id : '';
}

function spotifyEmbedCoverUrl(entity) {
  const sources = [
    ...(Array.isArray(entity?.coverArt?.sources) ? entity.coverArt.sources : []),
    ...(Array.isArray(entity?.visualIdentity?.image) ? entity.visualIdentity.image : []),
  ];
  return sources.find((source) => typeof source?.url === 'string')?.url || null;
}

function spotifyEmbedArtists(track) {
  if (Array.isArray(track?.artists)) {
    const names = track.artists
      .map((artist) => typeof artist === 'string' ? artist : artist?.name)
      .filter((artist) => typeof artist === 'string' && artist.trim())
      .map((artist) => artist.trim());
    if (names.length > 0) return names;
  }
  const subtitle = typeof track?.subtitle === 'string' ? track.subtitle.trim() : '';
  return subtitle ? [subtitle] : [];
}

function spotifyEmbedDate(track, entity) {
  const value = track?.releaseDate?.isoString || entity?.releaseDate?.isoString;
  return typeof value === 'string' && value ? value : null;
}

async function fetchSpotifyEmbedTracks(rawUrl) {
  let currentUrl = new URL(rawUrl);
  let content = spotifyContentParts(currentUrl);
  for (let redirectCount = 0; !content && redirectCount < 5; redirectCount += 1) {
    if (!['spotify.link', 'spotify.app.link'].includes(currentUrl.hostname.toLowerCase())) {
      throw new Error('Spotify share URL did not resolve to a supported item');
    }
    const redirected = await fetch(currentUrl, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    const location = redirected.headers.get('location');
    await redirected.body?.cancel().catch(() => {});
    if (!location) throw new Error('Spotify share URL did not redirect');
    currentUrl = new URL(location, currentUrl);
    if (currentUrl.protocol !== 'https:' ||
        !['spotify.link', 'spotify.app.link', 'open.spotify.com']
          .includes(currentUrl.hostname.toLowerCase())) {
      throw new Error('Spotify share URL redirected to an unsupported host');
    }
    content = spotifyContentParts(currentUrl);
  }
  if (!content) throw new Error('Spotify share URL did not resolve to a supported item');

  // Playlist embeds are previews; the existing spotDL metadata path paginates.
  if (content.type === 'playlist') {
    return { playlistUrl: `https://open.spotify.com/playlist/${content.id}` };
  }

  const response = await fetch(
    `https://open.spotify.com/embed/${content.type}/${content.id}`,
    {
      headers: { accept: 'text/html' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) throw new Error(`Spotify embed request failed (${response.status})`);
  const html = await response.text();
  const nextData = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!nextData) throw new Error('Spotify embed did not include track metadata');

  const entity = JSON.parse(nextData[1])?.props?.pageProps?.state?.data?.entity;
  const sourceTracks = entity?.type === 'track'
    ? [entity]
    : (Array.isArray(entity?.trackList) ? entity.trackList : []);
  if (sourceTracks.length === 0) {
    throw new Error('Spotify embed returned no usable tracks');
  }

  const playlistName = typeof entity?.title === 'string' && entity.title.trim()
    ? entity.title.trim()
    : null;
  const listName = entity?.type === 'track' ? null : playlistName;
  const listLength = sourceTracks.length;
  const coverUrl = spotifyEmbedCoverUrl(entity);
  const listUrl = `https://open.spotify.com/${content.type}/${content.id}`;
  const rawTracks = sourceTracks.map((track, index) => {
    const uri = typeof track?.uri === 'string' ? track.uri : '';
    const id = uri.match(/^spotify:track:([A-Za-z0-9]{10,64})$/)?.[1] ||
      (typeof track?.id === 'string' && /^[A-Za-z0-9]{10,64}$/.test(track.id)
        ? track.id
        : '');
    if (!id) return null;

    const artists = spotifyEmbedArtists(track);
    const durationMs = typeof track.duration === 'string' ? Number(track.duration) : track.duration;
    const date = spotifyEmbedDate(track, entity);
    const title = typeof track.title === 'string' && track.title ? track.title : track.name;
    return {
      name: (typeof title === 'string' && title ? title : 'Untitled').slice(0, 500),
      artists,
      artist: artists[0] || '',
      genres: null,
      disc_number: null,
      disc_count: null,
      album_name: null,
      album_artist: null,
      duration: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs / 1000)) : 0,
      year: null,
      date,
      track_number: null,
      tracks_count: null,
      song_id: id,
      explicit: track?.isExplicit === true,
      publisher: null,
      url: `https://open.spotify.com/track/${id}`,
      isrc: null,
      cover_url: entity?.type === 'track' ? coverUrl : null,
      copyright_text: null,
      download_url: null,
      lyrics: null,
      popularity: null,
      album_id: null,
      list_name: listName,
      list_url: listUrl,
      list_position: index + 1,
      list_length: listLength,
      artist_id: null,
      album_type: null,
    };
  });
  if (!rawTracks.some(Boolean)) throw new Error('Spotify embed returned no usable tracks');

  return {
    playlistName: playlistName || (rawTracks.length === 1
      ? `${rawTracks[0].artists.join(', ')} - ${rawTracks[0].name}`
      : 'Spotify Import'),
    rawTracks,
  };
}

ipcMain.handle('spotify-preflight', async (event, jobId, rawUrl) => {
  requireTrustedIpc(event);
  jobId = requireIpcString(jobId, 'jobId', 64);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(jobId)) throw new TypeError('jobId is invalid');
  const url = validatedSpotifyUrl(requireIpcString(rawUrl, 'url', 2048));
  if (activeSpotifyPreflightJobs.has(jobId)) throw new Error('Spotify review job already exists');
  let cancelReview;
  const cancelledSignal = new Promise((resolve) => { cancelReview = resolve; });
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const job = {
    child: null,
    cancelled: false,
    sender: event.sender,
    senderId: event.sender.id,
    cancelOnRendererExit: null,
    cancelReview,
    cancelledSignal,
    done,
    resolveDone,
  };
  activeSpotifyPreflightJobs.set(jobId, job);
  const cancelOnRendererExit = () => cancelSpotifyPreflight(jobId);
  job.cancelOnRendererExit = cancelOnRendererExit;
  for (const eventName of ['destroyed', 'render-process-gone', 'did-start-navigation']) {
    event.sender.once(eventName, cancelOnRendererExit);
  }

  let reviewDir = '';
  let rawTracks;
  let embedReview = null;
  try {
    try {
      embedReview = await Promise.race([
        fetchSpotifyEmbedTracks(url),
        job.cancelledSignal.then(() => { throw new Error('Spotify review cancelled'); }),
      ]);
    } catch (error) {
      if (job.cancelled) throw new Error('Spotify review cancelled');
      console.warn('[spotify] embed preflight unavailable; falling back to spotDL:', error.message);
    }

    if (embedReview?.rawTracks) {
      rawTracks = embedReview.rawTracks;
    } else {
      const setupResult = await Promise.race([
        Promise.all([setupSpotDl(), setupFfmpeg()])
          .then((value) => ({ value }), (error) => ({ error })),
        job.cancelledSignal.then(() => ({ cancelled: true })),
      ]);
      if (setupResult.cancelled || job.cancelled) throw new Error('Spotify review cancelled');
      if (setupResult.error) throw setupResult.error;
      const [spotDlReady, ffmpegReady] = setupResult.value;
      if (!spotDlReady || !spotDlPath) throw new Error('Spotify downloader is unavailable');
      if (!ffmpegReady || !ffmpegPath) throw new Error('FFmpeg is unavailable for Spotify review');
      const metadataUrl = embedReview?.playlistUrl || url;
      reviewDir = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'dwcue-spotify-review-'));
      if (job.cancelled) throw new Error('Spotify review cancelled');
      const metadataFile = path.join(reviewDir, 'tracks.spotdl');
      const outputLimit = 32 * 1024 * 1024;
      await new Promise((resolve, reject) => {
        // Review only needs metadata. Skip the YouTube Music connection check and lyrics lookups.
        const child = spawn(spotDlPath, [
          'save', metadataUrl, '--save-file', metadataFile, '--ffmpeg', ffmpegPath,
          '--threads', '8', '--audio', 'youtube', '--lyrics',
        ], {
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        job.child = child;
        let output = '';
        let errors = '';
        let bytes = 0;
        let settled = false;
        let timeout;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          error ? reject(error) : resolve();
        };
        const append = (chunk, stderr = false) => {
          bytes += chunk.length;
          if (bytes > outputLimit) {
            terminateSpotifyChild(child);
            finish(new Error('Spotify review output was too large'));
            return;
          }
          if (stderr) errors += chunk.toString();
          else output += chunk.toString();
        };
        child.stdout.on('data', (chunk) => append(chunk));
        child.stderr.on('data', (chunk) => append(chunk, true));
        child.once('error', (error) => finish(error));
        child.once('close', (code) => {
          job.child = null;
          if (job.cancelled) finish(new Error('Spotify review cancelled'));
          else if (code !== 0) finish(new Error(summarizeSpotDlError(output, errors, code)));
          else finish();
        });
        timeout = setTimeout(() => {
          terminateSpotifyChild(child);
          finish(new Error('Spotify review timed out'));
        }, 300000);
        timeout.unref();
      });
      try {
        const info = await fs.promises.stat(metadataFile);
        if (!info.isFile()) throw new Error('Spotify review output is not a file');
        if (info.size > outputLimit) throw new Error('Spotify review output was too large');
        rawTracks = JSON.parse(await fs.promises.readFile(metadataFile, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') throw new Error('Spotify returned no track list');
        if (error instanceof SyntaxError) throw new Error('Spotify returned an unreadable track list');
        throw error;
      }
      if (job.cancelled) throw new Error('Spotify review cancelled');
    }
  } finally {
    if (reviewDir) await fs.promises.rm(reviewDir, { recursive: true, force: true }).catch(error => {
      console.warn('[spotify] Could not remove review files:', error.message);
    });
    for (const eventName of ['destroyed', 'render-process-gone', 'did-start-navigation']) {
      event.sender.removeListener(eventName, cancelOnRendererExit);
    }
    if (activeSpotifyPreflightJobs.get(jobId) === job) activeSpotifyPreflightJobs.delete(jobId);
    job.resolveDone();
  }

  if (!Array.isArray(rawTracks)) {
    throw new Error('Spotify returned an invalid track list');
  }
  const usableTracks = rawTracks.filter(spotifyTrackId);
  if (usableTracks.length === 0) throw new Error('Spotify returned no usable tracks');
  // spotDL returns completed metadata lookups out of playlist order.
  if (embedReview?.playlistUrl && usableTracks.every((track) => Number.isSafeInteger(track.list_position))) {
    usableTracks.sort((a, b) => a.list_position - b.list_position);
  }
  const tracksById = new Map();
  for (const track of usableTracks) {
    const id = spotifyTrackId(track);
    if (tracksById.has(id)) continue;
    const artists = Array.isArray(track.artists)
      ? track.artists.filter((artist) => typeof artist === 'string' && artist.trim()).slice(0, 20)
      : [];
    if (!artists.length && typeof track.artist === 'string' && track.artist.trim()) artists.push(track.artist);
    tracksById.set(id, {
      id,
      title: (typeof track.name === 'string' && track.name ? track.name : 'Untitled').slice(0, 500),
      artists,
      album: typeof track.album_name === 'string' ? track.album_name.slice(0, 500) : '',
      duration: Number.isFinite(track.duration) ? Math.max(0, track.duration) : 0,
      coverUrl: typeof track.cover_url === 'string' ? track.cover_url : '',
      spotifyUrl: `https://open.spotify.com/track/${id}`,
    });
  }
  const tracks = [...tracksById.values()];
  const preflightId = crypto.randomUUID();
  const playlistName = sanitizeSpotifyFolderName(
    embedReview?.playlistName ||
    rawTracks.find((track) => typeof track?.list_name === 'string' && track.list_name.trim())?.list_name ||
    (tracks.length === 1 ? `${tracks[0].artists.join(', ')} - ${tracks[0].title}` : 'Spotify Import'),
  );
  for (const [id, review] of spotifyPreflights) {
    if (review.senderId === event.sender.id || review.expiresAt < Date.now()) spotifyPreflights.delete(id);
  }
  spotifyPreflights.set(preflightId, renewSpotifyReview({
    senderId: event.sender.id,
    url,
    playlistName,
    tracksById,
  }));
  return {
    preflightId,
    playlistName,
    tracks,
    skippedTrackCount: rawTracks.length - usableTracks.length,
    totalDuration: tracks.reduce((sum, track) => sum + track.duration, 0),
  };
});

function cancelSpotifyPreflight(jobId, senderId = null) {
  const job = activeSpotifyPreflightJobs.get(jobId);
  if (!job || (senderId !== null && job.senderId !== senderId)) return false;
  job.cancelled = true;
  job.cancelReview();
  terminateSpotifyChild(job.child);
  return true;
}

ipcMain.handle('cancel-spotify-preflight', async (event, jobId) => {
  requireTrustedIpc(event);
  jobId = requireIpcString(jobId, 'jobId', 64);
  return cancelSpotifyPreflight(jobId, event.sender.id);
});

async function createSpotifyProjectFolder(destinationParentPath, playlistName, job, reusePath = '') {
  if (reusePath) {
    const relative = path.relative(destinationParentPath, reusePath);
    if (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
      const mediaDir = path.join(reusePath, 'media');
      const reusable = await fs.promises.stat(reusePath).then((stat) => stat.isDirectory()).catch(() => false);
      if (reusable) {
        await fs.promises.mkdir(mediaDir, { recursive: true });
        return { projectFolderPath: reusePath, mediaDir };
      }
    }
  }
  for (let suffix = 1; suffix < 100000; suffix++) {
    const folderName = suffix === 1 ? playlistName : `${playlistName} (${suffix})`;
    const projectFolderPath = path.join(destinationParentPath, folderName);
    try {
      await fs.promises.mkdir(projectFolderPath);
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    job.ownedDirectories.push(projectFolderPath);
    const mediaDir = path.join(projectFolderPath, 'media');
    await fs.promises.mkdir(mediaDir);
    job.ownedDirectories.push(mediaDir);
    return { projectFolderPath, mediaDir };
  }
  throw new Error(`Could not create a unique folder for ${playlistName}`);
}

function spotifyOutputTrackId(filePath, trackIds = []) {
  const name = path.basename(filePath);
  return trackIds.find((id) =>
    name.startsWith(id) && !/[A-Za-z0-9]/.test(name[id.length] || '')) || '';
}

function orderedSpotifyOutputs(stagingDir, trackIds = []) {
  const files = new Map(
    fs.readdirSync(stagingDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.mp3$/i.test(entry.name))
      .map((entry) => [entry.name, path.join(stagingDir, entry.name)]),
  );
  const ordered = [];
  const listed = new Set();
  if (trackIds.length) {
    for (const id of trackIds) {
      const match = [...files.entries()].find(([, filePath]) =>
        spotifyOutputTrackId(filePath, [id]) === id);
      if (!match) continue;
      ordered.push(match[1]);
      listed.add(match[0]);
    }
  }
  const m3uPath = path.join(stagingDir, 'dwcue-spotify-order.m3u8');
  if (fs.existsSync(m3uPath)) {
    for (const line of fs.readFileSync(m3uPath, 'utf8').split(/\r?\n/)) {
      const value = line.trim();
      if (!value || value.startsWith('#')) continue;
      const name = value.split(/[\\/]/).pop();
      const filePath = files.get(name);
      if (!filePath || listed.has(name)) continue;
      ordered.push(filePath);
      listed.add(name);
    }
  }
  return [
    ...ordered,
    ...[...files.entries()]
      .filter(([name]) => !listed.has(name))
      .map(([, filePath]) => filePath)
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b))),
  ];
}

async function cleanupSpotifyFiles(job) {
  const files = job.files.splice(0);
  const results = await Promise.allSettled(files.map((filePath) =>
    fs.promises.rm(filePath, { force: true })));
  const failed = files.filter((_, index) => results[index].status === 'rejected');
  if (failed.length > 0) {
    job.files.push(...failed);
    console.error('[spotify] failed to remove job-owned media:', failed);
    throw new Error(`Could not remove ${failed.length} Spotify media file(s)`);
  }
  for (const directory of (job.ownedDirectories?.splice(0) || []).reverse()) {
    await fs.promises.rmdir(directory).catch((error) => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    });
  }
}

async function copySpotifyOutputsToMedia(sourcePaths, mediaDir, job) {
  for (const sourcePath of sourcePaths) {
    if (job.cancelled) throw new Error('Spotify download cancelled');
    const parsed = path.parse(path.basename(sourcePath));
    const cleanBase = parsed.base.replace(/^[A-Za-z0-9]{10,64}(?:\s+-\s+|[-_]+)/, '');
    const cleanParsed = path.parse(cleanBase);
    let copied = false;
    for (let suffix = 1; suffix < 100000; suffix++) {
      const name = suffix === 1
        ? cleanParsed.base
        : `${cleanParsed.name} (${suffix})${cleanParsed.ext}`;
      const destination = path.join(mediaDir, name);
      try {
        await pipeline(
          fs.createReadStream(sourcePath),
          fs.createWriteStream(destination, { flags: 'wx' }),
          { signal: job.abortController.signal },
        );
        job.files.push(destination);
        copied = true;
        break;
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        await fs.promises.rm(destination, { force: true });
        throw error;
      }
    }
    if (!copied) throw new Error(`Could not create a unique media file for ${parsed.base}`);
  }
  if (job.cancelled) throw new Error('Spotify download cancelled');
  return [...job.files];
}

function releaseSpotifyJob(jobId, job) {
  if (!job.released) {
    for (const eventName of ['destroyed', 'render-process-gone', 'did-start-navigation']) {
      job.sender.removeListener(eventName, job.cancelOnRendererExit);
    }
    if (activeSpotifyDownloads.get(jobId) === job) activeSpotifyDownloads.delete(jobId);
    job.released = true;
  }
  if (job.stagingCleaned) job.resolveDone();
}

async function cancelSpotifyDownload(
  jobId,
  senderId = null,
  preserveImportedFiles = false,
) {
  const job = activeSpotifyDownloads.get(jobId);
  if (!job || (senderId !== null && job.senderId !== senderId)) return false;
  job.cancelled = true;
  job.abortController.abort();
  if (job.children) for (const tracked of job.children) terminateSpotifyChild(tracked);
  else terminateSpotifyChild(job.child);
  if (job.awaitingImport) {
    job.awaitingImport = false;
    try {
      if (!preserveImportedFiles) await cleanupSpotifyFiles(job);
    } finally {
      releaseSpotifyJob(jobId, job);
    }
  }
  return true;
}

async function cancelAllSpotifyDownloads(preserveImportedFiles = false) {
  const reviews = [...activeSpotifyPreflightJobs.entries()];
  for (const [jobId] of reviews) cancelSpotifyPreflight(jobId);
  const jobs = [...activeSpotifyDownloads.entries()];
  await Promise.allSettled([
    ...reviews.map(([, job]) => job.done),
    ...jobs.map(async ([jobId, job]) => {
      try {
        await cancelSpotifyDownload(jobId, null, preserveImportedFiles);
      } finally {
        await job.done;
      }
    }),
  ]);
}

ipcMain.handle('cancel-spotify-download', async (event, jobId) => {
  requireTrustedIpc(event);
  jobId = requireIpcString(jobId, 'jobId', 64);
  return cancelSpotifyDownload(jobId, event.sender.id);
});

ipcMain.handle('finalize-spotify-import', async (event, jobId, keepFiles) => {
  requireTrustedIpc(event);
  jobId = requireIpcString(jobId, 'jobId', 64);
  if (typeof keepFiles !== 'boolean') throw new TypeError('keepFiles must be a boolean');
  const job = activeSpotifyDownloads.get(jobId);
  if (!job || job.senderId !== event.sender.id || !job.awaitingImport) return false;
  job.awaitingImport = false;
  try {
    if (!keepFiles || job.cancelled) await cleanupSpotifyFiles(job);
  } finally {
    releaseSpotifyJob(jobId, job);
  }
  return keepFiles && !job.cancelled;
});

ipcMain.handle(
  'download-spotify-audio',
  async (event, jobId, rawUrl, destinationParentPath, selection = null) => {
    requireTrustedIpc(event);
    jobId = requireIpcString(jobId, 'jobId', 64);
    if (!/^[A-Za-z0-9-]{8,64}$/.test(jobId)) throw new TypeError('jobId is invalid');
    const url = validatedSpotifyUrl(requireIpcString(rawUrl, 'url', 2048));
    destinationParentPath = requireAuthorizedIpcPath(
      destinationParentPath, 'destinationParentPath');
    if (!fs.statSync(destinationParentPath).isDirectory()) {
      throw new TypeError('destinationParentPath must be a directory');
    }
    selection = requireBoundedIpcObject(selection, 'selection', 1024 * 1024);
    if (selection?.reusePreviousFolder !== undefined &&
        typeof selection.reusePreviousFolder !== 'boolean') {
      throw new TypeError('reusePreviousFolder must be a boolean');
    }
    const audioBitrate = normalizeSpotifyBitrate(selection?.audioBitrate);
    const activeProjectFolderPath = requireAuthorizedIpcPath(
      selection?.activeProjectFolderPath, 'activeProjectFolderPath');
    if (!fs.statSync(activeProjectFolderPath).isDirectory()) {
      throw new TypeError('activeProjectFolderPath must be a directory');
    }
    let existingProjectFolderPath = '';
    if (selection?.existingProjectFolderPath !== undefined) {
      existingProjectFolderPath = requireAuthorizedIpcPath(
        selection.existingProjectFolderPath, 'existingProjectFolderPath');
      const relative = path.relative(destinationParentPath, existingProjectFolderPath);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative) || !fs.statSync(existingProjectFolderPath).isDirectory()) {
        throw new TypeError('existingProjectFolderPath must be a child of destinationParentPath');
      }
    }
    const preflightId = requireIpcString(selection?.preflightId, 'preflightId', 64);
    const selectedTrackIds = Array.isArray(selection?.selectedTrackIds)
      ? normalizeSpotifyTrackIds([...new Set(selection.selectedTrackIds)])
      : null;
    if (!selectedTrackIds?.length) {
      throw new TypeError('selectedTrackIds must contain valid Spotify track IDs');
    }
    const preflight = spotifyPreflights.get(preflightId);
    if (!spotifyReviewIsValid(preflight, event.sender.id, url)) {
      throw new Error('Spotify review expired; review the link again');
    }
    renewSpotifyReview(preflight);
    const selectedTracks = selectedTrackIds.map((id) => preflight.tracksById.get(id));
    if (selectedTracks.some((track) => !track)) throw new Error('Selected Spotify track is not in this review');
    if (activeSpotifyDownloads.has(jobId)) throw new Error('Spotify job already exists');
    // ponytail: one job avoids spotDL's shared cache/temp races; add a queue
    // only if concurrent playlist imports become a real operator need.
    if (activeSpotifyDownloads.size > 0) {
      throw new Error('Another Spotify download is already running');
    }

    const stagingDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'dwcue-spotify-'));
    const abortController = new AbortController();
    const cancelledSignal = new Promise((resolve) => {
      abortController.signal.addEventListener('abort', resolve, { once: true });
    });
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const job = {
      children: new Set(),
      cancelled: false,
      abortController,
      cancelledSignal,
      files: [],
      ownedDirectories: [],
      awaitingImport: false,
      sender: event.sender,
      senderId: event.sender.id,
      cancelOnRendererExit: null,
      done,
      resolveDone,
      released: false,
      stagingCleaned: false,
    };
    activeSpotifyDownloads.set(jobId, job);
    const cancelOnRendererExit = () => {
      void cancelSpotifyDownload(jobId, null, true).catch((error) => {
        console.error('[spotify] renderer-exit cleanup failed:', error.message);
      });
    };
    job.cancelOnRendererExit = cancelOnRendererExit;
    for (const eventName of ['destroyed', 'render-process-gone', 'did-start-navigation']) {
      event.sender.once(eventName, cancelOnRendererExit);
    }

    const progress = (status, extra = {}) => sendSpotifyProgress(event.sender, {
      jobId,
      status,
      total: 0,
      completed: 0,
      ...extra,
    });

    try {
      progress('preparing', { message: 'Preparing Spotify downloader…' });
      const setupResult = await Promise.race([
        Promise.all([setupSpotDl(), denoInitialization, setupFfmpeg()])
          .then((value) => ({ value }), (error) => ({ error })),
        job.cancelledSignal.then(() => ({ cancelled: true })),
      ]);
      if (setupResult.cancelled || job.cancelled) {
        throw new Error('Spotify download cancelled');
      }
      if (setupResult.error) throw setupResult.error;
      const [spotDlReady, , ffmpegReady] = setupResult.value;
      if (!spotDlReady || !spotDlPath) throw new Error('Spotify downloader is unavailable');
      if (!ffmpegReady || !ffmpegPath) throw new Error('FFmpeg is unavailable');

      const env = { ...process.env };
      const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
      env[pathKey] = [
        denoReady && denoPath ? path.dirname(denoPath) : null,
        path.dirname(ffmpegPath),
        env[pathKey],
      ].filter(Boolean).join(path.delimiter);
      // Keep spotDL's log lines unwrapped so match results parse one per line.
      env.COLUMNS = '2000';

      // spotDL's bundled yt-dlp is frozen at its build date and can no longer
      // download from YouTube (HTTP 403 since the 2026-08 PO-token rollout).
      // spotDL remains the best metadata matcher, so run it in match-only
      // mode (`spotdl url`) in batches, then
      // download and convert with our own maintained yt-dlp.
      const total = selectedTrackIds.length;
      let playlistName = preflight.playlistName;
      const failures = [];
      const runTracked = (command, commandArgs, timeoutMs, onLine = null, onSpawn = null) => new Promise((resolve, reject) => {
        const tracked = spawn(command, commandArgs, {
          cwd: stagingDir,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: process.platform !== 'win32',
        });
        job.children.add(tracked);
        if (onSpawn) onSpawn(tracked);
        let outputTail = '';
        let lineBuf = '';
        const onData = (chunk) => {
          const text = chunk.toString('utf8');
          outputTail = (outputTail + text).slice(-8000);
          if (onLine) {
            lineBuf += text;
            let nl = lineBuf.indexOf('\n');
            while (nl !== -1) {
              onLine(lineBuf.slice(0, nl).trimEnd());
              lineBuf = lineBuf.slice(nl + 1);
              nl = lineBuf.indexOf('\n');
            }
          }
        };
        tracked.stdout.on('data', onData);
        tracked.stderr.on('data', onData);
        const timer = setTimeout(() => terminateSpotifyChild(tracked), timeoutMs);
        tracked.once('error', (error) => {
          clearTimeout(timer);
          job.children.delete(tracked);
          reject(error);
        });
        tracked.once('close', (code, signal) => {
          clearTimeout(timer);
          job.children.delete(tracked);
          resolve({ code, signal, tail: outputTail });
        });
      });
      const trackLabel = (index) => {
        const track = selectedTracks[index];
        return [track.artists.join(', '), track.title].filter(Boolean).join(' - ');
      };
      const runPool = async (concurrency, count, visit) => {
        let cursor = 0;
        const worker = async () => {
          for (let index = cursor; index < count; index = cursor) {
            cursor += 1;
            if (job.cancelled) return;
            await visit(index);
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(concurrency, count) }, () => worker()));
      };

      progress('resolving', { total, completed: 0, message: 'Matching tracks…' });
      const matchedUrls = new Array(total).fill(null);
      const trackIndexById = new Map(selectedTrackIds.map((id, index) => [id, index]));
      let matched = 0;
      let resolveFinished = false;

      const sanitizeFilePart = (value) => String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/, '');

      // Download pipeline: each match is queued the moment it lands so saving
      // overlaps matching — a long playlist starts landing MP3s within a
      // couple of minutes instead of only after the full match phase.
      // 'downloading' progress events are held until matching finishes so the
      // modal shows one phase at a time; the first event then already carries
      // the overlapped count.
      const downloadQueue = [];
      const parkedWorkers = new Set();
      const wakeWorkers = () => {
        for (const park of [...parkedWorkers]) park();
      };
      let attempted = 0;
      const enqueueDownload = (index) => {
        downloadQueue.push(index);
        wakeWorkers();
      };
      const downloadTrack = async (index) => {
        const providerUrl = matchedUrls[index];
        const track = selectedTracks[index];
        if (!providerUrl) {
          attempted += 1;
          return;
        }
        const baseName = [
          selectedTrackIds[index],
          sanitizeFilePart(track.artists.join(', ')),
          sanitizeFilePart(track.title),
        ].filter(Boolean).join(' - ').slice(0, 160);
        const outputPath = path.join(stagingDir, `${baseName}.mp3`);
        for (let attempt = 1; attempt <= 2 && !job.cancelled; attempt += 1) {
          const result = await runTracked(ytDlpPath, [
            '-f', 'bestaudio',
            '-x', '--audio-format', 'mp3', '--audio-quality', audioBitrate,
            '--ffmpeg-location', ffmpegPath,
            '--no-playlist', '--newline', '--retries', '3',
            '-o', path.join(stagingDir, `${baseName}.%(ext)s`),
            providerUrl,
          ], 600000);
          if (result.code === 0 && fs.existsSync(outputPath)) break;
          if (attempt === 2) {
            failures.push(`${trackLabel(index)}: download failed`);
          }
        }
        if (!job.cancelled && fs.existsSync(outputPath)) {
          const taggedPath = `${outputPath}.tagged.mp3`;
          const tagResult = await runTracked(ffmpegPath, [
            '-y', '-i', outputPath, '-c', 'copy', '-id3v2_version', '3',
            '-metadata', `title=${track.title}`,
            '-metadata', `artist=${track.artists.join(', ')}`,
            '-metadata', `album=${playlistName}`,
            '-metadata', `track=${index + 1}`,
            taggedPath,
          ], 120000);
          if (tagResult.code === 0 && fs.existsSync(taggedPath)) {
            fs.renameSync(taggedPath, outputPath);
          } else {
            fs.rmSync(taggedPath, { force: true });
          }
        }
        attempted += 1;
        if (resolveFinished) {
          progress('downloading', { total, completed: attempted, message: trackLabel(index) });
        }
      };
      const downloadWorker = async () => {
        for (;;) {
          if (job.cancelled) return;
          while (downloadQueue.length === 0 && !resolveFinished && !job.cancelled) {
            await new Promise((resolve) => {
              const park = () => {
                parkedWorkers.delete(park);
                resolve();
              };
              parkedWorkers.add(park);
            });
          }
          if (job.cancelled || (downloadQueue.length === 0 && resolveFinished)) return;
          await downloadTrack(downloadQueue.shift());
        }
      };
      const downloadWorkers = Array.from(
        { length: Math.min(4, total) },
        () => downloadWorker(),
      );

      // MATCH-level lines carry the Spotify ID, so titles cannot conflate tracks.
      const onMatchLine = (line) => {
        const resultMatch = line.match(
          /^\[([A-Za-z0-9]{10,64})\]\s+Returning (?:verified )?best result\s+(\S+)/);
        if (!resultMatch) return;
        const index = trackIndexById.get(resultMatch[1]);
        if (index === undefined || matchedUrls[index]) return;
        matchedUrls[index] = resultMatch[2];
        matched += 1;
        progress('resolving', { total, completed: matched, message: trackLabel(index) });
        enqueueDownload(index);
      };
      // Bound argv for Windows while retaining at most four parallel matchers;
      // 100 is a batch size, not a playlist limit. Each matcher uses two threads.
      let lastMatchActivity = Date.now();
      const batchChildren = new Set();
      const matchConcurrency = Math.min(4, Math.max(1, Math.ceil(total / 10)));
      const chunkSize = Math.min(100, Math.ceil(total / matchConcurrency));
      let metadataSeen = 0;
      const onChunkLine = (line) => {
        lastMatchActivity = Date.now();
        if (/^Processing query: https?:\/\/open\.spotify\.com\/track\//.test(line)) {
          metadataSeen += 1;
          if (!matchedUrls.some(Boolean)) {
            progress('resolving', {
              total,
              completed: 0,
              message: `Reading Spotify metadata ${Math.min(metadataSeen, total)}/${total}…`,
            });
          }
          return;
        }
        onMatchLine(line);
      };
      const matchChunk = async (chunkIndex) => {
        const c = chunkIndex * chunkSize;
        const chunkTracks = selectedTracks.slice(c, c + chunkSize);
        await runTracked(spotDlPath, [
          'url', ...chunkTracks.map((track) => track.spotifyUrl),
          '--audio', ...SPOTIFY_AUDIO_PROVIDERS,
          '--max-retries', '1',
          '--threads', '2',
          '--cache-path', path.join(stagingDir, `match-cache-batch-${chunkIndex}`),
          '--log-level', 'MATCH',
          '--log-format', '%(message)s',
        ], Math.max(300000, chunkTracks.length * 60000), onChunkLine,
        (tracked) => {
          batchChildren.add(tracked);
          tracked.once('close', () => batchChildren.delete(tracked));
        });
      };
      // A hung track can stall a batch matcher; cut it loose and let the
      // per-track fallback below take the stragglers.
      const watchdog = setInterval(() => {
        if (!job.cancelled && Date.now() - lastMatchActivity > 240000) {
          console.warn('[spotify] match batch stalled; falling back to per-track matching');
          for (const child of batchChildren) terminateSpotifyChild(child);
        }
      }, 30000);
      try {
        await runPool(matchConcurrency, Math.ceil(total / chunkSize), matchChunk);
      } finally {
        clearInterval(watchdog);
      }

      if (!job.cancelled) {
        const missed = [];
        for (let index = 0; index < total; index += 1) {
          if (!matchedUrls[index]) missed.push(index);
        }
        await runPool(4, missed.length, async (missedCursor) => {
          const index = missed[missedCursor];
          const track = selectedTracks[index];
          for (let attempt = 1; attempt <= 2 && !job.cancelled; attempt += 1) {
            const result = await runTracked(spotDlPath, [
              'url', track.spotifyUrl,
              '--audio', ...SPOTIFY_AUDIO_PROVIDERS,
              '--max-retries', '1',
              '--cache-path', path.join(stagingDir, `match-cache-${selectedTrackIds[index]}`),
              '--log-level', 'ERROR',
            ], 120000);
            const urlMatch = result.tail.match(/https?:\/\/\S+/);
            if (urlMatch) {
              matchedUrls[index] = urlMatch[0];
              break;
            }
          }
          if (!matchedUrls[index]) {
            failures.push(`${trackLabel(index)}: no audio source matched`);
          } else {
            matched += 1;
            progress('resolving', { total, completed: matched, message: trackLabel(index) });
            enqueueDownload(index);
          }
        });
      }

      resolveFinished = true;
      wakeWorkers();
      progress('downloading', { total, completed: attempted, message: 'Downloading…' });
      await Promise.all(downloadWorkers);
      if (job.cancelled) {
        progress('cancelled', { message: 'Download cancelled' });
        throw new Error('Spotify download cancelled');
      }

      const outputs = orderedSpotifyOutputs(stagingDir, selectedTrackIds);
      if (outputs.length === 0) {
        throw new Error(failures.length
          ? `No tracks could be downloaded. ${failures.slice(0, 3).join('; ')}`
          : 'No tracks could be downloaded');
      }
      playlistName = sanitizeSpotifyFolderName(playlistName);
      const { projectFolderPath, mediaDir } = await createSpotifyProjectFolder(
        destinationParentPath,
        playlistName,
        job,
        selection.reusePreviousFolder
          ? (existingProjectFolderPath || preflight.projectFolderPath)
          : '',
      );
      preflight.projectFolderPath = projectFolderPath;

      progress('importing', {
        playlistName,
        total,
        completed: outputs.length,
        message: 'Adding tracks to project…',
      });
      const files = await copySpotifyOutputsToMedia(outputs, mediaDir, job);
      const partial = failures.length > 0 || files.length < total;
      const error = partial
        ? `${total - files.length} of ${total} track(s) failed${failures.length ? ` — ${failures[0]}` : ''}`
        : undefined;
      const completedTrackIds = outputs
        .map((filePath) => spotifyOutputTrackId(filePath, selectedTrackIds))
        .filter(Boolean);
      const completedTrackIdSet = new Set(completedTrackIds);
      const failedTrackIds = selectedTrackIds.filter((id) => !completedTrackIdSet.has(id));
      const groupUuid = crypto.randomUUID();
      const recovery = normalizeSpotifyRecovery({
        version: 1,
        activeProjectFolderPath,
        destinationParentPath,
        projectFolderPath,
        url,
        playlistName,
        audioBitrate,
        selectedTrackIds,
        completedTrackIds: [],
        failedTrackIds,
        pendingTrackIds: completedTrackIds,
        pendingFiles: files,
        total,
        completed: 0,
        groupUuid,
        updatedAt: Date.now(),
      });
      if (!recovery) throw new Error('Could not verify Spotify download results');
      const preferencesSaved = writeImportPreferences({
        ...readImportPreferences(),
        spotifyDestination: destinationParentPath,
        spotifyRecovery: recovery,
      });
      renewSpotifyReview(preflight);
      job.awaitingImport = true;
      progress('importing', {
        playlistName,
        total,
        completed: files.length,
        message: 'Saving cues to the project…',
      });
      return {
        files,
        total,
        completed: files.length,
        partial,
        error,
        playlistName,
        projectFolderPath,
        completedTrackIds,
        failedTrackIds,
        groupUuid,
        preferencesSaved,
      };
    } catch (error) {
      try {
        await cleanupSpotifyFiles(job);
      } catch (cleanupError) {
        console.error('[spotify] media rollback failed:', cleanupError.message);
      }
      if (!job.cancelled) {
        progress('error', { message: error.message });
      }
      throw error;
    } finally {
      if (!job.awaitingImport) releaseSpotifyJob(jobId, job);
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch((error) => {
        console.warn('[spotify] failed to remove staging directory:', error.message);
      });
      job.stagingCleaned = true;
      if (job.released) job.resolveDone();
    }
  },
);

const activeYouTubeDownloads = new Map();

function releaseYouTubeJob(jobId, job) {
  for (const eventName of ['destroyed', 'render-process-gone', 'did-start-navigation']) {
    job.sender.removeListener(eventName, job.cancelOnRendererExit);
  }
  if (activeYouTubeDownloads.get(jobId) === job) activeYouTubeDownloads.delete(jobId);
}

async function cancelYouTubeDownload(jobId, senderId = null) {
  const job = activeYouTubeDownloads.get(jobId);
  if (!job || (senderId !== null && job.senderId !== senderId)) return false;
  job.cancelled = true;
  const child = job.child;
  if (child?.pid && isPidAlive(child.pid)) {
    if (process.platform === 'win32') {
      execFile('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'],
        { windowsHide: true }, () => {});
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      const timer = setTimeout(() => {
        if (activeYouTubeDownloads.get(jobId)?.child !== child || !isPidAlive(child.pid)) return;
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }, 2000);
      timer.unref();
    }
  }
  job.cleanup?.();
  return true;
}

async function cancelAllYouTubeDownloads() {
  await Promise.allSettled([...activeYouTubeDownloads.keys()].map((jobId) =>
    cancelYouTubeDownload(jobId)));
}

ipcMain.handle('cancel-youtube-download', async (event, jobId) => {
  requireTrustedIpc(event);
  jobId = requireIpcString(jobId, 'jobId', 64);
  return cancelYouTubeDownload(jobId, event.sender.id);
});

async function waitForYtDlp() {
  void setupDeno();   // optional; the download below waits briefly for it
  if (!await setupYtDlp() || !ytDlpPath) {
    throw new Error('The YouTube downloader could not be downloaded. The next import will try again.');
  }
}

ipcMain.handle('get-youtube-info', async (event, videoId) => {
  requireTrustedIpc(event);
  videoId = requireIpcString(videoId, 'videoId', 32);
  if (!/^[A-Za-z0-9_-]{6,32}$/.test(videoId)) throw new TypeError('videoId is invalid');
  await waitForYtDlp();
  const args = [
    `https://www.youtube.com/watch?v=${videoId}`,
    '--skip-download', '--no-playlist', '--no-warnings',
    '--print', '%(.{id,title,thumbnail,channel,uploader,duration,is_live,live_status})j',
  ];
  if (denoReady && denoPath) args.push('--js-runtimes', `deno:${denoPath}`);
  const { stdout } = await execFilePromise(ytDlpPath, args, {
    windowsHide: true,
    timeout: 45000,
    // The compact --print payload contains only the fields used below.
    // Keep a finite guard, but do not buffer yt-dlp's full format/subtitle
    // metadata dump just to read title and duration.
    maxBuffer: 256 * 1024,
  });

  const info = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}');
  if (info.id !== videoId || typeof info.title !== 'string') {
    throw new Error('YouTube did not return usable video information');
  }
  return {
    id: videoId,
    title: info.title.slice(0, 500),
    thumbnail: typeof info.thumbnail === 'string' ? info.thumbnail : '',
    channelTitle: String(info.channel || info.uploader || '').slice(0, 300),
    length: Number.isFinite(info.duration) ? new Date(info.duration * 1000).toISOString().slice(11, 19).replace(/^00:/, '') : '',
    isLive: info.is_live === true || info.live_status === 'is_live',
  };
});

// YouTube Search Handler
ipcMain.handle('search-youtube', async (event, query) => {
  try {
    requireTrustedIpc(event);
    query = requireIpcString(query, 'query', 500);
    const result = await youtubesearchapi.GetListByKeyword(query, false, 20, [{ type: 'video' }]);
    
    // Format results
    const videos = result.items.map(item => ({
      id: item.id,
      title: item.title,
      thumbnail: item.thumbnail.thumbnails[item.thumbnail.thumbnails.length - 1].url,
      channelTitle: item.channelTitle,
      length: item.length?.simpleText || '',
      isLive: item.isLive === true,
    }));
    
    return videos;
  } catch (error) {
    console.error('YouTube search error:', error);
    throw new Error('Failed to search YouTube');
  }
});

// YouTube Download Handler
ipcMain.handle('download-youtube-audio', async (event, jobId, videoId, title, projectFolderPath, outputMode = 'mp3') => {
  requireTrustedIpc(event);
  jobId = requireIpcString(jobId, 'jobId', 64);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(jobId)) throw new TypeError('jobId is invalid');
  videoId = requireIpcString(videoId, 'videoId', 32);
  if (!/^[A-Za-z0-9_-]{6,32}$/.test(videoId)) throw new TypeError('videoId is invalid');
  title = requireIpcString(title, 'title', 500);
  projectFolderPath = requireAuthorizedIpcPath(projectFolderPath, 'projectFolderPath');
  outputMode = requireIpcString(outputMode, 'outputMode', 16);
  if (!['source', 'mp3', 'video'].includes(outputMode)) throw new TypeError('outputMode is invalid');
  if (activeYouTubeDownloads.has(jobId)) throw new Error('YouTube job already exists');
  const job = {
    child: null,
    cleanup: null,
    cancelled: false,
    sender: event.sender,
    senderId: event.sender.id,
    cancelOnRendererExit: null,
  };
  const cancelOnRendererExit = () => { void cancelYouTubeDownload(jobId); };
  job.cancelOnRendererExit = cancelOnRendererExit;
  activeYouTubeDownloads.set(jobId, job);
  for (const eventName of ['destroyed', 'render-process-gone', 'did-start-navigation']) {
    event.sender.once(eventName, cancelOnRendererExit);
  }

  const task = (async () => {
    console.log('YouTube download - Project folder path:', projectFolderPath);

    const outputPath = path.join(projectFolderPath, 'media');
    console.log('YouTube download - Output path:', outputPath);

    // Ensure output directory exists
    if (!fs.existsSync(outputPath)) {
      fs.mkdirSync(outputPath, { recursive: true });
      console.log('Created media directory:', outputPath);
    }

    // Clean filename
    const sanitizedTitle = title.replace(/[<>:"/\\|?*]/g, '').trim().substring(0, 180)
      || `YouTube ${outputMode === 'video' ? 'video' : 'audio'} ${videoId}`;
    const outputBaseName = `${sanitizedTitle} [${videoId}]`;
    const fileName = outputMode === 'mp3' ? `${outputBaseName}.mp3`
      : outputMode === 'video' ? `${outputBaseName}.mp4` : '';
    const outputTemplate = path.join(outputPath, outputBaseName);
    const outputPrefix = `${outputBaseName}.`;
    const existingOutputs = new Set(
      fs.readdirSync(outputPath).filter(candidate => candidate.startsWith(outputPrefix)),
    );
    const cleanupNewOutputs = () => {
      try {
        for (const candidate of fs.readdirSync(outputPath)) {
          if (!candidate.startsWith(outputPrefix) || existingOutputs.has(candidate)) continue;
          fs.unlinkSync(path.join(outputPath, candidate));
        }
      } catch (cleanupError) {
        console.error('Failed to clean up YouTube download:', cleanupError);
      }
    };
    job.cleanup = cleanupNewOutputs;

    console.log('YouTube download - Output template:', outputTemplate);

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    console.log(`Starting YouTube download: ${videoId} -> ${fileName}`);
    console.log(`Video URL: ${videoUrl}`);

    // Wait for yt-dlp to be ready (with timeout)
    await waitForYtDlp();
    if (job.cancelled) throw new Error('YouTube download cancelled');

    // Video mode needs ffmpeg to mux the separate video+audio streams; mp3
    // mode needs it for transcode.
    if ((outputMode === 'mp3' || outputMode === 'video') && !(await setupFfmpeg())) {
      throw new Error('The converter this import needs could not be downloaded. The next import will try again.');
    }

    try {
      // Build yt-dlp arguments. Video mode strongly prefers an H.264+AAC pair
      // (the engine decodes the AAC track; Chromium shows the picture) and
      // takes the highest resolution available in that pairing.
      const args = outputMode === 'video'
        ? [videoUrl, '-f',
           'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[ext=mp4]/bv*+ba/b',
           '--merge-output-format', 'mp4']
        : [videoUrl, '-f', 'bestaudio'];
      if (outputMode === 'mp3') {
        args.push(
          '--extract-audio',
          '--audio-format', 'mp3',
          '--audio-quality', '0', // V0: best variable-bit-rate MP3 quality.
        );
      }
      args.push(
        '-o', outputTemplate + '.%(ext)s',
        '--no-playlist',
        '--progress',
        '--newline' // Force progress on new lines for easier parsing
      );

      // Add ffmpeg path if we have it
      if ((outputMode === 'mp3' || outputMode === 'video') && ffmpegPath) {
        args.push('--ffmpeg-location', ffmpegPath);
      }

      // Give deno a brief chance to finish initialising on first launch (the
      // ~40MB download may still be in flight), then enable it as yt-dlp's JS
      // runtime so YouTube's nsig challenge can be solved. Non-fatal: if deno
      // isn't ready we fall back to JS-runtime-free extraction.
      if (!denoReady) {
        let denoAttempts = 0;
        while (!denoReady && !job.cancelled && denoAttempts < 15) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          denoAttempts++;
        }
      }
      if (denoReady && denoPath) {
        args.push('--js-runtimes', `deno:${denoPath}`);
      } else {
        console.warn('Proceeding without a JS runtime; some videos may fail to extract.');
      }
      if (job.cancelled) throw new Error('YouTube download cancelled');

      return await new Promise((resolve, reject) => {
        console.log('Running yt-dlp with args:', args);
        console.log('yt-dlp path:', ytDlpPath);

        // Use spawn to get a proper ChildProcess
        const downloadProcess = spawn(ytDlpPath, args, {
          windowsHide: true,
          detached: process.platform !== 'win32',
        });
        job.child = downloadProcess;

        // Check if downloadProcess is valid
        if (!downloadProcess || !downloadProcess.stdout) {
          throw new Error('Failed to start yt-dlp process');
        }

        let lastProgress = 0;
        let stderrBuffer = '';

        // Track progress by parsing stdout
        downloadProcess.stdout.on('data', (data) => {
          if (job.cancelled || event.sender.isDestroyed()) return;
          const output = data.toString();

          // Parse download progress
          const downloadMatch = output.match(/\[download\]\s+(\d+\.?\d*)%/);
          if (downloadMatch) {
            const percentage = parseFloat(downloadMatch[1]);
            if (percentage > lastProgress) {
              lastProgress = percentage;
              event.sender.send('youtube-download-progress', {
                jobId,
                videoId,
                percentage: percentage,
                status: (outputMode === 'mp3' || outputMode === 'video') && percentage >= 100
                  ? 'converting'
                  : 'downloading'
              });
            }
          }

          // Check for post-processing
          if (outputMode === 'mp3' && output.includes('[ExtractAudio]')) {
            event.sender.send('youtube-download-progress', {
              jobId,
              videoId,
              percentage: 95,
              status: 'converting'
            });
          }
          if (outputMode === 'video' && output.includes('[Merger]')) {
            event.sender.send('youtube-download-progress', {
              jobId,
              videoId,
              percentage: 95,
              status: 'converting'
            });
          }
        });

        downloadProcess.stderr.on('data', (data) => {
          const errorOutput = data.toString();
          // yt-dlp uses stderr for normal output as well as errors. Keep the
          // tail of everything so we can report the real cause on failure.
          stderrBuffer += errorOutput;
          if (stderrBuffer.length > 8000) {
            stderrBuffer = stderrBuffer.slice(-8000);
          }
          if (errorOutput.includes('ERROR')) {
            console.error('yt-dlp error:', errorOutput);
          }
        });

        downloadProcess.on('error', (error) => {
          console.error('yt-dlp process error:', error);
          cleanupNewOutputs();
          reject(new Error(`Download process failed: ${error.message}`));
        });

        downloadProcess.on('close', (code) => {
          try {
            job.child = null;
            console.log(`yt-dlp process closed with code: ${code}`);

            if (job.cancelled) {
              cleanupNewOutputs();
              reject(new Error('YouTube download cancelled'));
              return;
            }
            if (code !== 0) {
              cleanupNewOutputs();
              // Surface the real reason from yt-dlp's stderr instead of just the code.
              const errorLines = stderrBuffer
                .split('\n')
                .filter(line => line.includes('ERROR') || line.includes('error:'))
                .map(line => line.trim());
              const detail = errorLines.length > 0
                ? errorLines.join('\n')
                : stderrBuffer.trim().split('\n').slice(-5).join('\n');

              console.error('yt-dlp failed. Full stderr:\n', stderrBuffer);

              let hint = '';
              if (/Sign in to confirm|not a bot|cookies/i.test(stderrBuffer)) {
                hint = ' (YouTube is requiring sign-in/bot verification for this video.)';
              } else if (/Video unavailable|Private video|members-only|age/i.test(stderrBuffer)) {
                hint = ' (This video is unavailable, private, age-restricted, or members-only.)';
              } else if (/Requested format is not available/i.test(stderrBuffer)) {
                hint = ' (No downloadable audio format was found for this video.)';
              } else if (/Unable to extract|nsig|player|update.*yt-dlp/i.test(stderrBuffer)) {
                hint = ' (yt-dlp may be out of date — YouTube changed something. Restart the app to fetch the latest yt-dlp.)';
              }

              reject(new Error(`yt-dlp exited with code ${code}.${hint}${detail ? '\n\n' + detail : ''}`));
              return;
            }

            console.log(`Download completed: ${outputBaseName}`);

            // Source audio keeps the provider's actual container/codec, so discover
            // the extension after yt-dlp finishes. The video ID makes this lookup
            // exact even when two results share a title.
            const expectedFile = fileName ? path.join(outputPath, fileName) : '';
            let actualFile = expectedFile;

            // Check if file exists with expected name
            if (!expectedFile || !fs.existsSync(expectedFile)) {
              const files = fs.readdirSync(outputPath);
              const matchingFile = files.find(f => {
                const parsed = path.parse(f);
                return parsed.name === outputBaseName &&
                  !/\.(?:part|ytdl|tmp)$/i.test(f) &&
                  (outputMode === 'source' ||
                   parsed.ext.toLowerCase() === (outputMode === 'video' ? '.mp4' : '.mp3'));
              });

              if (matchingFile) {
                actualFile = path.join(outputPath, matchingFile);
                console.log('Found downloaded file:', matchingFile);

                // MP3 mode has one canonical filename. Source mode must retain the
                // downloaded extension because changing it would mislabel the codec.
                if (expectedFile && matchingFile !== fileName) {
                  try {
                    fs.renameSync(actualFile, expectedFile);
                    actualFile = expectedFile;
                    console.log('Renamed file to:', fileName);
                  } catch (renameError) {
                    console.error('Failed to rename file:', renameError);
                  }
                }
              } else {
                console.error('Could not find downloaded file. Files in directory:', files);
                reject(new Error('Downloaded file not found in expected location'));
                return;
              }
            }

            // Send 100% progress
            event.sender.send('youtube-download-progress', {
              jobId,
              videoId,
              percentage: 100,
              status: 'completed'
            });

            resolve({
              success: true,
              file: actualFile,
              fileName: path.basename(actualFile),
              title,
            });
          } catch (error) {
            cleanupNewOutputs();
            reject(error);
          }
        });
      });

    } catch (error) {
      console.error('YouTube download error:', error);
      console.error('Error stack:', error.stack);

      cleanupNewOutputs();

      throw new Error(`Download failed: ${error.message}`);
    }
  })();
  return task.finally(() => releaseYouTubeJob(jobId, job));
});

// Isolated preview instances must not mutate machine-wide protocol defaults.
if (shouldRegisterProtocolClient(process.env.DWCUE_USERDATA)) {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('dwcue', process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient('dwcue');
  }
}

// For Windows, we need to handle the protocol differently
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    // Someone tried to run a second instance, we should focus our window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    // Warm file opens arrive on the second instance command line on Windows
    // and Linux (and may do so in development on macOS).
    const f = tryAuthorizeOpenableFilePath(getOpenableFileFromArgv(commandLine));
    if (f) {
      if (mainWindow && mainWindow.webContents) {
        openFile(f);
      } else {
        fileToOpen = f;
      }
    }
  });

  app.whenReady().then(async () => {
    configureSessionSecurity();
    initializeCapabilitiesFromRecentProjects();

    // Native OS About panel (macOS app-menu "About DonWells Cue"): same
    // brand + license facts as the in-app About surfaces.
    app.setAboutPanelOptions({
      applicationName: 'DonWells Cue',
      applicationVersion: app.getVersion(),
      copyright: '© 2026 Don Wells',
      credits: [
        'Don Wells is the sole contributor to DonWells Cue.',
        'Forked from LivePlay in July 2026. Original LivePlay software © Thomas Doukinitsas and contributors.',
        'Redistribution is permitted under AGPL-3.0-only. The software comes without warranty to the extent permitted by law.',
        'License and source: https://github.com/donwellsav/dwcue',
      ].join('\n'),
    });

    // The release build's engine check runs without any window: nothing else
    // may start, stop or reconnect to the engine while it is being judged.
    const engineSelfTest = engineSelfTestResultPath(process.argv);
    if (engineSelfTest) {
      void runEngineSelfTest(engineSelfTest);
      return;
    }

    createWindow();

    // Register this only after ready. macOS may emit `activate` during the
    // ready transition; constructing a BrowserWindow from that early event
    // throws before the app has completed initialization.
    app.on('activate', () => {
      if (mainWindow === null || mainWindow.isDestroyed()) {
        createWindow();
      }
    });

    // Rejoin a verified detached server. A pre-rebrand or wrong-port server is
    // replaced in Local mode; Remote mode retires it. With no lock, a fresh
    // launch still waits until the user selects Local.
    void tryReattachLiveplayServer();

    // Start listening for discovery beacons early so the welcome screen's
    // picker is already populated by the time the user reaches it.
    try { startDiscoveryListener(); } catch (e) { console.warn('[liveplay-discovery]', e); }

    // NOTE: a file opened before the app was ready (cold start) is delivered
    // via the pull path — the renderer calls `get-pending-open-file` on mount
    // and drives the open itself. We intentionally do NOT push here so a cold
    // start can't double-open (push + pull) the same file.
  });
}

// Handle file opening on macOS (the only platform that fires 'open-file';
// Windows/Linux deliver the path via argv / second-instance instead).
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  filePath = tryAuthorizeOpenableFilePath(filePath);
  if (!filePath) return;

  if (mainWindow && mainWindow.webContents) {
    // Window is ready, push the file to the renderer immediately.
    openFile(filePath);
  } else {
    // Window not ready yet (cold start) — queue for the renderer's pull.
    fileToOpen = filePath;
  }
});

// Packaged macOS uses open-file; development launches can pass a positional
// show/archive path just like Windows and Linux.
if (shouldScanInitialOpenFileArgv(process.platform, process.defaultApp)) {
  const fileArg = tryAuthorizeOpenableFilePath(getOpenableFileFromArgv(process.argv));
  if (fileArg) fileToOpen = fileArg;
}

// Pull path for cold start: the renderer asks for any file that was queued
// before it was ready, then drives the open/import flow itself. Returns null
// when nothing is pending. Clears the queue so it's delivered exactly once.
ipcMain.handle('get-pending-open-file', async (event) => {
  requireTrustedIpc(event);
  if (!fileToOpen) return null;
  const filePath = fileToOpen;
  fileToOpen = null;
  return { filePath, kind: fileKindFor(filePath) };
});

// Push a queued/warm-start file to the renderer. The renderer (WelcomeScreen)
// owns the actual work: starting/connecting a server and opening or importing
// the project. The main process only hands over the path + kind.
function openFile(filePath) {
  if (!mainWindow || !mainWindow.webContents) return;
  try {
    filePath = requireAuthorizedIpcPath(filePath, 'filePath');
  } catch (error) {
    console.warn('[file-association] refused dispatch:', error.message);
    return;
  }
  mainWindow.webContents.send('open-file-association', {
    filePath,
    kind: fileKindFor(filePath),
  });
  console.log('Dispatched file association to renderer:', filePath);
}

// MIDI Config Handlers
const midiConfigPath = path.join(app.getPath('userData'), 'midi-config.json');

ipcMain.handle('read-midi-config', async (event) => {
  try {
    requireTrustedIpc(event);
    if (fs.existsSync(midiConfigPath)) {
      const data = fs.readFileSync(midiConfigPath, 'utf-8');
      return JSON.parse(data);
    }
    return {};
  } catch (error) {
    console.error('Failed to read MIDI config:', error);
    return {};
  }
});

ipcMain.handle('write-midi-config', async (event, config) => {
  try {
    requireTrustedIpc(event);
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new TypeError('MIDI config must be an object');
    }
    const serialized = JSON.stringify(config, null, 2);
    if (serialized.length > 1024 * 1024) throw new Error('MIDI config is too large');
    fs.writeFileSync(midiConfigPath, serialized, 'utf-8');
    return { success: true };
  } catch (error) {
    console.error('Failed to write MIDI config:', error);
    throw new Error('Failed to save MIDI configuration');
  }
});

app.on('window-all-closed', () => {
  // The liveplay audio server is intentionally NOT stopped here — it was
  // spawned detached so it survives renderer reloads and Electron quits.
  // Users explicitly shut it down via the `liveplay-server:shutdown` IPC
  // (or by killing the PID directly). On next launch we reattach via the
  // lockfile.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// The audio server is deliberately detached. Even quit paths without a live
// control renderer must settle this window-owned diagnostic before exiting.
// On failure, restore the control window so cleanup can be retried rather than
// leaving the still-owned native tone behind while Electron exits headless.
app.on('will-quit', createWillQuitHandler({
  prepare: prepareForTerminalAction,
  exit: () => app.exit(0),
  onFailure: (error) => {
    console.error('[lifecycle] cleanup on exit failed:', error.message);
    showTerminalActionFailure(error);
  },
  recover: () => {
    quitConfirmed = false;
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  },
}));
