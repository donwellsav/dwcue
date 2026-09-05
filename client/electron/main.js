const { app, BrowserWindow, ipcMain, dialog, shell, Menu, session, screen, powerSaveBlocker } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, exec, execFile } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const youtubesearchapi = require('youtube-search-api');
const YTDlpWrap = require('yt-dlp-wrap').default;
const ffmpeg = require('fluent-ffmpeg');
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
const { TestCardPlayback } = require('./test-card-playback');
const {
  SPOTIFY_AUDIO_PROVIDERS,
  normalizeSpotifyBitrate,
  normalizeSpotifyRecovery,
  renewSpotifyReview,
  spotifyReviewIsValid,
} = require('./spotify-import-reliability');
const execPromise = promisify(exec);
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
let ffmpegAvailable = false;
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

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-navigate', (event, targetUrl) => {
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
  const allowedPermissions = new Set(['clipboard-read', 'clipboard-sanitized-write', 'midi']);
  const permissionAllowed = (webContents, permission) =>
    !!webContents &&
    isTrustedRendererUrl(webContents.getURL()) &&
    allowedPermissions.has(permission);

  session.defaultSession.setPermissionCheckHandler((webContents, permission) =>
    permissionAllowed(webContents, permission));
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) =>
    callback(permissionAllowed(webContents, permission)));

  if (!app.isPackaged) return;
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
      { timeout: 3000, windowsHide: true, maxBuffer: 64 * 1024 },
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
        'taskkill.exe', ['/pid', String(pid), '/T', '/F'], resolve,
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

function readLiveplayConfig() {
  try {
    const raw = fs.readFileSync(liveplayConfigPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      mode:      parsed.mode === 'remote' ? 'remote' : 'local',
      remoteUrl: typeof parsed.remoteUrl === 'string' ? parsed.remoteUrl : `http://127.0.0.1:${LIVEPLAY_DEFAULT_PORT}`,
      localPort: Number.isInteger(parsed.localPort) ? parsed.localPort : LIVEPLAY_DEFAULT_PORT,
    };
  } catch {
    return { mode: 'local', remoteUrl: `http://127.0.0.1:${LIVEPLAY_DEFAULT_PORT}`, localPort: LIVEPLAY_DEFAULT_PORT };
  }
}

function writeLiveplayConfig(cfg) {
  try {
    fs.writeFileSync(liveplayConfigPath(), JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('[liveplay-server] could not persist config:', e);
  }
}

function importPreferencesPath() {
  return path.join(app.getPath('userData'), 'import-preferences.json');
}

function readImportPreferences() {
  try {
    const value = JSON.parse(fs.readFileSync(importPreferencesPath(), 'utf8'));
    return {
      spotifyDestination: typeof value.spotifyDestination === 'string' ? value.spotifyDestination : '',
      spotifyRecovery: normalizeSpotifyRecovery(value.spotifyRecovery),
    };
  } catch { return { spotifyDestination: '', spotifyRecovery: null }; }
}

function writeImportPreferences(value) {
  fs.writeFileSync(importPreferencesPath(), JSON.stringify(value, null, 2));
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
    if (healthMatchesIdentity(health, lock) ||
        await processRunsOwnedServer(lock.pid, lock.instanceToken)) {
      return { ...lock, legacy: false };
    }
    return null;
  }
  if (isLegacyServerHealth(health) && await processRunsLegacyServer(lock)) {
    return { ...lock, legacy: true };
  }
  return null;
}

async function waitForCrashReplacement(staleIdentity, timeoutMs = 6500) {
  if (!/^[0-9a-f]{32}$/.test(staleIdentity?.instanceToken || '')) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = readLiveplayLock();
    if (lock && lock.pid !== staleIdentity.pid &&
        lock.instanceToken === staleIdentity.instanceToken &&
        lock.accessToken === staleIdentity.accessToken &&
        isPidAlive(lock.pid)) {
      const replacement = await verifyLiveplayLock(lock);
      if (replacement) return adoptLiveplayIdentity(replacement);
    }
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
      if (owned) {
        return current;
      }
    }
    clearLiveplayIdentity(current);
  }
  return null;
}

// Reattach to a verified detached server. A tokenless pre-rebrand server is
// adopted only after both its old health response and exact process arguments
// agree, then replaced once with the tokenized current binary.
async function tryReattachLiveplayServer() {
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
    return startLiveplayServer();
  }
  return identity;
}

async function startLiveplayServer() {
  if (liveplayServerStartPromise) return liveplayServerStartPromise;
  liveplayServerStartPromise = startLiveplayServerOnce();
  try {
    return await liveplayServerStartPromise;
  } finally {
    liveplayServerStartPromise = null;
  }
}

async function startLiveplayServerOnce() {
  const cfg = readLiveplayConfig();
  if (cfg.mode !== 'local') return;

  const current = await reconcileLiveplayServerIdentity(true);
  if (current) {
    if (!current.legacy && validManagedAccessToken(current.accessToken) &&
        current.port === cfg.localPort) return current;
    if (!(await stopVerifiedLiveplayServer(current))) return null;
  }

  // Never signal, adopt, or overwrite a live PID that failed identity checks.
  // The user can stop that process directly; spawning beside it risks two
  // independent audio engines if the configured port also changed.
  const unverifiedLock = readLiveplayLock();
  if (unverifiedLock && isPidAlive(unverifiedLock.pid)) {
    console.error('[liveplay-server] refusing to launch beside unverified pid',
                  unverifiedLock.pid);
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

  // Launch detached and headless. The server writes its real PID to the
  // lockfile and persists logs under its state directory.
  const lockPath = liveplayLockPath();
  const instanceToken = crypto.randomBytes(16).toString('hex');
  const accessToken = crypto.randomBytes(32).toString('hex');
  const allowedOrigins = app.isPackaged ? '' : 'http://localhost:3000';
  console.log('[liveplay-server] launching in background', exePath, 'on port', cfg.localPort);
  const serverArgs = [
    '--port',           String(cfg.localPort),
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
    return null;
  }

  const launchState = { error: null };
  launcher.once('error', (error) => {
    launchState.error = error;
    console.error('[liveplay-server] spawn failed:', error);
    notifyServerStateChange();
  });

  // We don't track the spawn handle's lifetime — the server's real PID
  // arrives via the pidfile within ~1 s. unref() so Electron can quit
  // independently.
  try { launcher.unref(); } catch {}

  // Adopt the real PID before completing this launch so a concurrent stop or
  // restart cannot miss the new server in the pidfile handoff window.
  const identity = await pollPidfileForServerPid(
    lockPath, instanceToken, accessToken, cfg.localPort, launchState,
  );

  notifyServerStateChange();
  return identity;
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
  if (stopped) clearLiveplayIdentity(identity);
  notifyServerStateChange();
  return stopped;
}

async function stopLiveplayServer() {
  if (liveplayServerStartPromise) await liveplayServerStartPromise;
  const identity = await reconcileLiveplayServerIdentity(true);
  if (!identity) {
    const unverifiedLock = readLiveplayLock();
    if (unverifiedLock && isPidAlive(unverifiedLock.pid)) {
      console.error('[liveplay-server] refusing to stop unverified lock PID:',
                    unverifiedLock.pid);
      clearLiveplayIdentity();
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
  for (const window of new Set([mainWindow, cartPlayerWindow, videoOutputWindow])) {
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

  if (next.mode === 'remote') {
    await stopLiveplayServer();
  } else {
    // Start is promise-coalesced, and startLiveplayServerOnce replaces a
    // verified legacy or wrong-port generation before launching.
    await startLiveplayServer();
    const identity = await reconcileLiveplayServerIdentity();
    if (identity && (identity.legacy ||
        !validManagedAccessToken(identity.accessToken) ||
        identity.port !== next.localPort)) {
      if (await stopVerifiedLiveplayServer(identity)) await startLiveplayServer();
    }
  }

  notifyServerStateChange();
  return next;
});

ipcMain.handle('liveplay-server:get-status', async (event) => {
  requireTrustedIpc(event);
  await reconcileLiveplayServerIdentity();
  return liveplayServerStatus();
});

// Generic app lifecycle controls used by the connection-lost modal.
// `relaunch` re-spawns the renderer in a clean state (the detached
// liveplay-server keeps running and is reattached on the next launch).
// `exit` just quits without touching the server.
ipcMain.handle('app:relaunch', async (event) => {
  requireTrustedIpc(event);
  await stopTestCardForQuit();
  await cancelAllSpotifyDownloads(true);
  await cancelAllYouTubeDownloads();
  app.relaunch();
  app.exit(0);
  return true;
});
ipcMain.handle('app:exit', async (event) => {
  requireTrustedIpc(event);
  await stopTestCardForQuit();
  await cancelAllSpotifyDownloads(true);
  await cancelAllYouTubeDownloads();
  app.exit(0);
  return true;
});

// Two-step quit confirmation. The renderer drives the dialogs (unsaved
// changes → optionally shut the local audio server down); once the user
// has decided it calls `app:confirm-quit`. Update-on-exit uses the same
// IPC boundary so the managed server is stopped before replacing binaries.
ipcMain.handle('app:confirm-quit', async (event, opts) => {
  requireTrustedIpc(event);
  await stopTestCardForQuit();
  if (opts?.installUpdate === true) {
    return installDownloadedUpdate({
      runAfterInstall: opts.runAfterInstall !== false,
    });
  }
  if (opts && opts.stopServer) await stopLiveplayServer();
  await cancelAllSpotifyDownloads(true);
  await cancelAllYouTubeDownloads();
  quitConfirmed = true;
  app.quit();
  return true;
});

ipcMain.handle('liveplay-server:restart', async (event) => {
  requireTrustedIpc(event);
  if (!(await stopLiveplayServer())) return false;
  await startLiveplayServer();
  return true;
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
ipcMain.handle('liveplay-server:ensure-running', async (event) => {
  requireTrustedIpc(event);
  const cfg = readLiveplayConfig();
  if (cfg.mode !== 'local') {
    return { ok: false, port: cfg.localPort, error: 'config mode is not local' };
  }
  try { await startLiveplayServer(); }
  catch (e) { return { ok: false, port: cfg.localPort, error: String(e) }; }

  // Poll health. The detached server process needs a moment to bind.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const lock = readLiveplayLock();
    const health = lock?.port === cfg.localPort
      ? await probeServerHealth(cfg.localPort, 800)
      : null;
    if (lock && healthMatchesIdentity(health, lock)) {
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
  return { ok: false, port: cfg.localPort, error: 'server did not become healthy within 10s' };
});

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

// Setup bundled ffmpeg - always use the bundled version to avoid
// issues on OS's with strict security requirements
async function checkAndSetupFfmpeg() {
  try {
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    ffmpegPath = ffmpegInstaller.path;
    
    // In packaged app, the path may be inside app.asar - resolve it
    if (ffmpegPath.includes('app.asar')) {
      ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
    }
    
    // Verify bundled version works
    await execFilePromise(ffmpegPath, ['-version'], { timeout: 5000 });
    ffmpegAvailable = true;
    console.log('Using bundled ffmpeg:', ffmpegPath);
    
    // Set ffprobe path from @ffprobe-installer/ffprobe
    try {
      const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
      let ffprobePath = ffprobeInstaller.path;
      if (ffprobePath.includes('app.asar')) {
        ffprobePath = ffprobePath.replace('app.asar', 'app.asar.unpacked');
      }
      ffmpeg.setFfprobePath(ffprobePath);
      console.log('Using bundled ffprobe:', ffprobePath);
    } catch (e) {
      // Fallback: try ffprobe next to ffmpeg
      const ffprobeFileName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
      const ffprobePath = path.join(path.dirname(ffmpegPath), ffprobeFileName);
      if (fs.existsSync(ffprobePath)) {
        ffmpeg.setFfprobePath(ffprobePath);
        console.log('Using ffprobe from ffmpeg directory:', ffprobePath);
      } else {
        // Fallback: try system-wide ffprobe from PATH
        try {
          const whichProbeCmd = process.platform === 'win32' ? 'where ffprobe' : 'which ffprobe';
          const probeResult = await execPromise(whichProbeCmd, { timeout: 5000 });
          const systemProbePath = probeResult.stdout.trim().split('\n')[0].trim();
          ffmpeg.setFfprobePath(systemProbePath);
          console.log('Using system ffprobe:', systemProbePath);
        } catch (probeErr) {
          console.warn('ffprobe not found, some features may be limited');
        }
      }
    }
    
    return true;
  } catch (error) {
    console.error('Failed to setup bundled ffmpeg:', error);
    
    // Fallback: try system-wide ffmpeg from PATH
    try {
      const whichCmd = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg';
      const { stdout } = await execPromise(whichCmd, { timeout: 5000 });
      const systemFfmpegPath = stdout.trim().split('\n')[0].trim();
      
      // Verify the system binary works
      await execFilePromise(systemFfmpegPath, ['-version'], { timeout: 5000 });
      ffmpegPath = systemFfmpegPath;
      ffmpegAvailable = true;
      console.log('Using system ffmpeg:', ffmpegPath);
      
      // Try to find system ffprobe too
      try {
        const whichProbeCmd = process.platform === 'win32' ? 'where ffprobe' : 'which ffprobe';
        const probeResult = await execPromise(whichProbeCmd, { timeout: 5000 });
        const systemFfprobePath = probeResult.stdout.trim().split('\n')[0].trim();
        ffmpeg.setFfprobePath(systemFfprobePath);
        console.log('Using system ffprobe:', systemFfprobePath);
      } catch (probeErr) {
        console.warn('System ffprobe not found, some features may be limited');
      }
      
      return true;
    } catch (systemError) {
      console.error('System ffmpeg not found either:', systemError.message);
      ffmpegAvailable = false;
      return false;
    }
  }
}

function setupFfmpeg() {
  if (!ffmpegSetupPromise) ffmpegSetupPromise = checkAndSetupFfmpeg();
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
    await YTDlpWrap.downloadFile(url, temporaryPath);
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
void initializeYtDlp();
const denoInitialization = initializeDeno();

let mainWindow = null;
// Set once the renderer-driven quit confirmation has resolved, so the
// next main-window `close` is allowed through instead of being vetoed
// to re-show the dialogs. See the `close` handler in createWindow().
let quitConfirmed = false;
let currentProject = null;
let currentProjectData = null; // Full project data synced between Electron windows
let fileToOpen = null; // Store file path if app is opened with a file
let stateViewerWindow = null; // Debug state viewer window
let cartPlayerWindow = null;  // Detached cart player window

// Check if --dev flag is present in command line arguments
const isDevMode = process.argv.includes('--dev') || !app.isPackaged;

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
// A downloaded update must not replace the app while the detached audio
// server still owns files from the current installation (especially the old
// Windows executable). Both Install Now and Install on Exit use this helper.
async function installDownloadedUpdate({ runAfterInstall = true } = {}) {
  if (!DWCUE_UPDATES_CONFIGURED || !updatesInstallSupported) return false;
  try {
    const serverStopped = await stopLiveplayServer();
    if (!serverStopped) {
      console.error('[update] refusing install while the managed server is running');
      return false;
    }
    await cancelAllSpotifyDownloads(true);
    await cancelAllYouTubeDownloads();
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

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    
    // Silent startup check against the pinned GitHub feed. The renderer
    // defers showing the update modal while Show Mode is active.
    if (!isDevMode && DWCUE_UPDATES_CONFIGURED) {
      // Wait a bit for the window to fully load before checking updates
      setTimeout(() => {
        autoUpdater.checkForUpdates().catch(err => {
          console.error('Failed to check for updates:', err);
        });
      }, 3000);
    }
  });

  // Veto the first close so the renderer can run its quit-confirmation
  // flow (unsaved changes → optionally shut the local audio server down).
  // The renderer responds via `app:confirm-quit`, which sets quitConfirmed
  // and calls app.quit() — re-entering here with the veto lifted. If the
  // renderer is gone (crash / already destroyed) we let the close proceed.
  mainWindow.on('close', (e) => {
    if (quitConfirmed) return;
    if (!mainWindow || mainWindow.webContents.isDestroyed()) return;
    // Packaged-app smoke test launches with --smoke-quit: no human is
    // present to answer the quit-confirmation dialogs, so skip the veto.
    if (process.argv.includes('--smoke-quit')) return;
    e.preventDefault();
    mainWindow.webContents.send('app:request-quit');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  createMenu('en', isDevMode);
}

// Create detached One Shots window (IPC/query names stay backward compatible).
function createCartPlayerWindow() {
  if (cartPlayerWindow) {
    cartPlayerWindow.focus();
    return;
  }

  cartPlayerWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 380,
    minHeight: 400,
    title: 'DonWells Cue - One Shots',
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
    cartPlayerWindow.loadURL('http://localhost:3000/?cartWindow=1');
  } else {
    const indexPath = path.join(__dirname, '../.output/public/index.html');
    cartPlayerWindow.loadFile(indexPath, { query: { cartWindow: '1' } });
  }

  cartPlayerWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('[OneShotsWindow] Failed to load:', errorCode, errorDescription);
  });

  cartPlayerWindow.on('closed', () => {
    cartPlayerWindow = null;
    if (mainWindow) {
      mainWindow.webContents.send('cart-player-window-closed');
    }
  });

  // Notify main window that cart window is open
  cartPlayerWindow.webContents.once('did-finish-load', () => {
    if (mainWindow) {
      mainWindow.webContents.send('cart-player-window-opened');
    }
  });
}
// ===========================================================================
// Video Output window (video playback, slice 1 — see VIDEO_PLAYBACK_V1.md).
//
// One session-scoped, borderless, always-on-top window fullscreen on the
// display the operator assigned as the video output (typically the HDMI feed
// to a switcher/projector). The Nuxt page at ?videoOutput=1 renders the layer
// stack (black / standby image / per-cue image / muted video); this block owns
// the window, display assignment, shortcut forwarding, and show hygiene.
//
// Display assignment is MACHINE-level state in <userData>/video-output.json.
// Open/closed state is deliberately never persisted: every app launch starts
// closed so a stale assignment cannot black out the operator's control screen.
// ===========================================================================
const VIDEO_OUTPUT_CONFIG_FILENAME = 'video-output.json';

let videoOutputWindow = null;
let videoOutputSessionEnabled = false;
let videoOutputPowerSaveId = null;
let videoOutputWatchdogInstalled = false;
let videoOutputWatchdogTimer = null;
let videoOutputTestCard = false;
let videoOutputPlaybackError = null;
let videoOutputFrameTimer = null;
let displayIdentifierWindows = [];
let displayIdentifierTimer = null;
const videoOutputWindowsPreservingSession = new WeakSet();

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
  const connection = videoOutputTestCardConnection;
  videoOutputTestCardConnection = null;
  await testCardPlayback.update(null, connection);
  if (testCardPlayback.session) throw new Error(testCardPlayback.error || 'Could not stop AV Sync.');
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

// Confidence monitor: 1 fps JPEG thumbnails of the output window for the
// operator UI. capturePage renders exactly what the audience sees — video,
// standby image, test card, or a hung frame (which is itself the alarm).
// Runs only while the output window exists.
function startVideoOutputFrames() {
  if (videoOutputFrameTimer !== null) return;
  videoOutputFrameTimer = setInterval(async () => {
    if (!videoOutputWindow || videoOutputWindow.isDestroyed()) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const img = await videoOutputWindow.webContents.capturePage();
      if (!img || img.isEmpty()) return;
      const thumb = img.resize({ width: 320, quality: 'good' });
      mainWindow.webContents.send('video-output:frame', {
        jpeg: thumb.toJPEG(60).toString('base64'),
        at: Date.now(),
      });
    } catch { /* window mid-teardown; the closed handler stops the timer */ }
  }, 1000);
}

function stopVideoOutputFrames() {
  if (videoOutputFrameTimer !== null) {
    clearInterval(videoOutputFrameTimer);
    videoOutputFrameTimer = null;
  }
}

function videoOutputConfigPath() {
  return path.join(app.getPath('userData'), VIDEO_OUTPUT_CONFIG_FILENAME);
}

function readVideoOutputConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(videoOutputConfigPath(), 'utf-8'));
    return {
      displayId: typeof parsed.displayId === 'string' ? parsed.displayId : null,
      // Resolution+label hint for re-attach when the OS hands out a new display
      // id after a reconnect. Ambiguous for two identical projectors — the id
      // stays the primary key; the fingerprint is only a fallback hint.
      displayFingerprint: typeof parsed.displayFingerprint === 'string'
        ? parsed.displayFingerprint : null,
      testCardConfig: createTestCardConfig(parsed.testCardConfig),
    };
  } catch {
    return { displayId: null, displayFingerprint: null, testCardConfig: createTestCardConfig() };
  }
}

function writeVideoOutputConfig(cfg) {
  try {
    fs.writeFileSync(videoOutputConfigPath(), JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('[video-output] failed to persist config:', e);
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

function resolveVideoOutputDisplay(cfg) {
  const displays = screen.getAllDisplays();
  if (cfg.displayId) {
    const hit = displays.find((d) => String(d.id) === cfg.displayId);
    if (hit) return hit;
  }
  if (cfg.displayFingerprint) {
    const hit = displays.find(
      (d) => videoOutputFingerprint(d) === cfg.displayFingerprint);
    if (hit) return hit;
  }
  return null;
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
    }
  }
  return {
    enabled: videoOutputSessionEnabled,
    open: videoOutputWindow !== null && !videoOutputWindow.isDestroyed(),
    displayId: cfg.displayId,
    targetId: target ? String(target.id) : null,
    targetLabel: target ? (target.label || `Display ${target.id}`) : null,
    displays,
    warning,
    playbackError: videoOutputPlaybackError,
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
                videoOutputWindow.isFullScreen(),
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
    fullscreen: outputWindow.isFullScreen(),
    testCard: videoOutputTestCard,
    labels: videoOutputContextLabels(),
    onToggleFullscreen: () => {
      if (!outputWindow.isDestroyed()) {
        outputWindow.setFullScreen(!outputWindow.isFullScreen());
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
      identifierWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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

function createVideoOutputWindow() {
  if (videoOutputWindow && !videoOutputWindow.isDestroyed()) return;
  videoOutputPlaybackError = null;

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

  if (realOutput) {
    // Raw display bounds: this is a physical output, so no DPI correction
    // (correction is only for capture-only outputs, e.g. a future NDI sink).
    Object.assign(options, {
      x: target.bounds.x,
      y: target.bounds.y,
      width: target.bounds.width,
      height: target.bounds.height,
      frame: false,
      fullscreen: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      // Keep the Windows Alt+F4 escape hatch available even though this output
      // has no frame. The closed handler disarms the session so it stays shut.
      closable: true,
      alwaysOnTop: true,
    });
  } else {
    // Preview mode: single-display (or unassigned) machines get a normal
    // window instead of a hostile fullscreen black takeover.
    Object.assign(options, { width: 960, height: 540, minWidth: 320, minHeight: 180 });
  }

  const outputWindow = new BrowserWindow(options);
  videoOutputWindow = outputWindow;
  if (realOutput) outputWindow.setAlwaysOnTop(true, 'screen-saver');
  startVideoOutputFrames();

  outputWindow.once('ready-to-show', () => {
    if (!outputWindow.isDestroyed()) outputWindow.show();
  });

  if (isDevMode) {
    outputWindow.loadURL('http://localhost:3000/?videoOutput=1');
  } else {
    const indexPath = path.join(__dirname, '../.output/public/index.html');
    outputWindow.loadFile(indexPath, { query: { videoOutput: '1' } });
  }

  outputWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    console.error('[video-output] Failed to load:', errorCode, errorDescription);
    if (isMainFrame && errorCode !== -3) {
      const connection = videoOutputTestCardConnection;
      videoOutputTestCardConnection = null;
      void testCardPlayback.update(null, connection);
    }
  });

  outputWindow.webContents.on('did-finish-load', () => {
    broadcastVideoOutputStatus();
    void reconcileTestCardPlayback();
  });
  outputWindow.webContents.on('render-process-gone', () => {
    const connection = videoOutputTestCardConnection;
    videoOutputTestCardConnection = null;
    void testCardPlayback.update(null, connection);
  });

  // The passive output renderer otherwise owns keyboard focus on Windows.
  // Forward app-level shortcuts back to the control renderer while preserving
  // native app accelerators and OS escape hatches such as Alt+F4.
  outputWindow.webContents.on('before-input-event', (event, input) => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    if (!shouldForwardVideoOutputShortcut(input, process.platform)) return;
    const shortcut = toRendererShortcut(input);
    if (shortcut.key === 'Escape' && outputWindow.isFullScreen()) {
      outputWindow.setFullScreen(false);
    }
    mainWindow.webContents.send('video-output:shortcut', shortcut);
    event.preventDefault();
  });

  outputWindow.webContents.on('context-menu', (event) => {
    event.preventDefault();
    showVideoOutputContextMenu(outputWindow);
  });

  outputWindow.on('enter-full-screen', broadcastVideoOutputStatus);
  outputWindow.on('leave-full-screen', broadcastVideoOutputStatus);

  outputWindow.on('closed', () => {
    const preserveSession = videoOutputWindowsPreservingSession.delete(outputWindow);
    if (!preserveSession) videoOutputSessionEnabled = false;
    if (videoOutputWindow === outputWindow) videoOutputWindow = null;
    videoOutputPlaybackError = null;
    const connection = videoOutputTestCardConnection;
    videoOutputTestCardConnection = null;
    void testCardPlayback.update(null, connection);
    stopVideoOutputFrames();
    if (videoOutputPowerSaveId !== null) {
      try { powerSaveBlocker.stop(videoOutputPowerSaveId); } catch { /* already stopped */ }
      videoOutputPowerSaveId = null;
    }
    broadcastVideoOutputStatus();
  });

  // The projector/switcher chain must never sleep mid-show.
  if (videoOutputPowerSaveId === null || !powerSaveBlocker.isStarted(videoOutputPowerSaveId)) {
    videoOutputPowerSaveId = powerSaveBlocker.start('prevent-display-sleep');
  }
}

function closeVideoOutputWindow({ preserveSession = false } = {}) {
  const outputWindow = videoOutputWindow;
  if (!preserveSession) videoOutputSessionEnabled = false;
  if (!outputWindow || outputWindow.isDestroyed()) {
    videoOutputWindow = null;
    videoOutputPlaybackError = null;
    const connection = videoOutputTestCardConnection;
    videoOutputTestCardConnection = null;
    void testCardPlayback.update(null, connection);
    return;
  }
  if (preserveSession) videoOutputWindowsPreservingSession.add(outputWindow);
  outputWindow.destroy();
  if (videoOutputWindow === outputWindow) videoOutputWindow = null;
}

// Watchdog: when the display topology changes (switcher EDID renegotiation,
// cable replug, OS reshuffle), keep the output on its assigned display or take
// it down cleanly — it must never silently settle onto the control screen.
function installVideoOutputWatchdog() {
  if (videoOutputWatchdogInstalled) return;
  videoOutputWatchdogInstalled = true;
  const onDisplayChange = () => {
    // Display events arrive in bursts; settle before reacting.
    clearTimeout(videoOutputWatchdogTimer);
    videoOutputWatchdogTimer = setTimeout(() => {
      videoOutputWatchdogTimer = null;
      const cfg = readVideoOutputConfig();
      if (!videoOutputSessionEnabled) { broadcastVideoOutputStatus(); return; }
      const target = resolveVideoOutputDisplay(cfg);
      if (videoOutputWindow && cfg.displayId && !target) {
        // Assigned display is gone: close rather than let the OS park the
        // fullscreen window on the operator's control display. Preview mode
        // (no display assigned) intentionally lives on the control screen —
        // metrics events there (e.g. entering fullscreen) must not kill it.
        closeVideoOutputWindow({ preserveSession: true });
      } else if (!videoOutputWindow && target) {
        // Display (re)appeared while armed: re-acquire it.
        createVideoOutputWindow();
      } else if (videoOutputWindow && target &&
                 screen.getAllDisplays().length > 1 &&
                 !videoOutputWindow.isDestroyed()) {
        // Still present but possibly reshuffled: re-assert bounds. Physical
        // output → raw bounds. (Electron can need a delayed second call on
        // Windows for the move to stick.)
        const wBounds = videoOutputWindow.getBounds();
        const tBounds = target.bounds;
        if (JSON.stringify(wBounds) !== JSON.stringify(tBounds)) {
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


ipcMain.handle('video-output:open', (event) => {
  requireTrustedIpc(event);
  videoOutputSessionEnabled = true;
  installVideoOutputWatchdog();
  createVideoOutputWindow();
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
ipcMain.handle('video-output:report-playback-error', async (event, payload) => {
  requireVideoOutputIpc(event);
  videoOutputPlaybackError = normalizeVideoPlaybackError(payload);
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
    videoOutputWindow.setFullScreen(on === true);
  }
  return broadcastVideoOutputStatus();
});

ipcMain.handle('video-output:toggle-fullscreen', (event) => {
  requireTrustedIpc(event);
  if (videoOutputWindow && !videoOutputWindow.isDestroyed()) {
    videoOutputWindow.setFullScreen(!videoOutputWindow.isFullScreen());
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
  
  const template = [
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
          click: () => {
            mainWindow.webContents.send('menu-change-accent-color');
          }
        },
        { type: 'separator' },
        {
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
ipcMain.handle('select-project-folder', async (event) => {
  requireTrustedIpc(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return pathCapabilities.authorizeRoot(result.filePaths[0]);
  }
  return null;
});

ipcMain.handle('select-project-file', async (event) => {
  requireTrustedIpc(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'DonWells Cue Show', extensions: ['dwcue'] },
      { name: 'Legacy Show (Import)', extensions: ['liveplay'] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) return null;
  const selectedPath = result.filePaths[0];
  const kind = fileKindFor(selectedPath);
  if (kind !== ProjectFileKind.NativeProject &&
      kind !== ProjectFileKind.LegacyProject) return null;
  return authorizeOpenableFilePath(selectedPath);
});

ipcMain.handle('select-audio-files', async (event) => {
  requireTrustedIpc(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    // Audio plus the video containers the engine decodes (H.264/HEVC tracks);
    // imported video cues play their audio through the engine and drive the
    // Video Output window.
    filters: [{
      name: 'Audio & video',
      extensions: [
        'mp3', 'wav', 'aiff', 'aif', 'flac', 'ogg', 'oga', 'm4a', 'aac', 'mp2',
        'wma', 'opus', 'ac3', 'amr', 'au', 'caf',
        'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'mpg', 'mpeg', 'm2ts', 'mts',
        'wmv', 'flv', '3gp',
      ],
    }],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths.map(filePath => pathCapabilities.authorizeFile(filePath));
  }
  return null;
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
  return response;
});

ipcMain.handle('set-spotify-import-destination', (event, destination) => {
  requireTrustedIpc(event);
  destination = requireAuthorizedIpcPath(destination, 'destination');
  if (!fs.statSync(destination).isDirectory()) throw new TypeError('destination must be a directory');
  writeImportPreferences({ ...readImportPreferences(), spotifyDestination: destination });
  return true;
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
  writeImportPreferences({ ...readImportPreferences(), spotifyRecovery: recovery });
  return true;
});

ipcMain.handle('clear-spotify-import-recovery', (event, activeProjectFolderPath) => {
  requireTrustedIpc(event);
  activeProjectFolderPath = requireAuthorizedIpcPath(
    activeProjectFolderPath, 'activeProjectFolderPath');
  const preferences = readImportPreferences();
  if (preferences.spotifyRecovery?.activeProjectFolderPath === activeProjectFolderPath) {
    writeImportPreferences({ ...preferences, spotifyRecovery: null });
  }
  return true;
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

// Save dialog for the canonical archive download flow. Returns the chosen
// absolute .dwcuepack path or null on cancel.
ipcMain.handle('show-save-archive-dialog', async (event, defaultName) => {
  requireTrustedIpc(event);
  const requestedName = typeof defaultName === 'string' && defaultName.length <= 255
    ? path.basename(defaultName)
    : 'project.dwcuepack';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save DonWells Cue Show Archive',
    defaultPath: canonicalArchivePath(requestedName),
    filters: [{ name: 'DonWells Cue Show Archive', extensions: ['dwcuepack'] }],
  });
  if (result.canceled || !result.filePath) return null;
  return pathCapabilities.authorizeFile(
    canonicalArchivePath(result.filePath), { allowMissing: true });
});

// Choose either a canonical archive or an explicitly imported legacy archive.
ipcMain.handle('show-open-archive-dialog', async (event) => {
  requireTrustedIpc(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose DonWells Cue Show Archive',
    properties: ['openFile'],
    filters: [
      { name: 'DonWells Cue Show Archive', extensions: ['dwcuepack'] },
      { name: 'Legacy Show Archive (Import)', extensions: ['lpa'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const selectedPath = result.filePaths[0];
  const kind = fileKindFor(selectedPath);
  if (kind !== ProjectFileKind.NativeArchive &&
      kind !== ProjectFileKind.LegacyArchive) return null;
  return pathCapabilities.authorizeFile(selectedPath);
});

// Stream a one-shot server archive directly to an authorized local path.
// The renderer never holds the archive in memory, and the destination is
// replaced only after the complete response reaches a sibling temp file.
ipcMain.handle('download-archive-to-file', async (event, request) => {
  let tempPath = '';
  try {
    requireTrustedIpc(event);
    const checked = requireBoundedIpcObject(request, 'request', 16 * 1024);
    const destination = requireAuthorizedIpcPath(
      checked.destination, 'destination', true);
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
    await fs.promises.rename(tempPath, destination);
    tempPath = '';

    await fetch(endpoint, {
      method: 'DELETE',
      headers,
      redirect: 'error',
    }).catch(() => undefined);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
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
ipcMain.handle('check-for-updates', async (event) => {
  requireTrustedIpc(event);
  if (!DWCUE_UPDATES_CONFIGURED) {
    return { success: false, error: 'Updates are not configured for this build.' };
  }
  try {
    console.log('Manual update check requested');
    manualCheckPending = true;
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
    // picked it (for example after server auto-restore). Legacy .liveplay files
    // are import sources only and must never become writable project roots.
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

// Receive full project data from renderer to power HTTP API GET/PATCH endpoints
// Only sync from the main window, not from the detached cart window (to avoid feedback loops)
ipcMain.on('sync-project-data', (event, projectData) => {
  try {
    requireTrustedIpc(event);
    requireBoundedIpcObject(projectData, 'projectData', 10 * 1024 * 1024);
  } catch (error) {
    console.warn('[sync-project-data] rejected payload:', error.message);
    return;
  }
  // Check if this sync is coming from the main window (not the cart window)
  const isFromMainWindow = event.sender === mainWindow?.webContents;

  if (isFromMainWindow) {
    currentProjectData = projectData;
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
    const isOpen  = nextOpen   !== null;
    if (wasOpen !== isOpen) {
      currentProject = nextOpen;
      createMenu(currentLocale, isDevMode);
    } else {
      currentProject = nextOpen;
    }
    // Forward project updates to the detached cart window if open
    if (cartPlayerWindow && projectData) {
      cartPlayerWindow.webContents.send('cart-window-project-update', projectData);
    }
  }
  // Silently ignore syncs from the cart window to prevent feedback loops
});

// Cart player window IPC handlers
ipcMain.handle('open-cart-player-window', (event, projectFolderPath) => {
  requireTrustedIpc(event);
  if (projectFolderPath !== undefined) {
    requireIpcString(projectFolderPath, 'projectFolderPath', MAX_IPC_PATH_LENGTH);
  }
  createCartPlayerWindow();
});

ipcMain.on('cart-player-window-attach', (event) => {
  try {
    requireTrustedIpc(event);
  } catch (error) {
    console.warn('[cart-player-window-attach] rejected event:', error.message);
    return;
  }
  if (cartPlayerWindow) {
    cartPlayerWindow.close();
  }
});

// UI mode (edit / "show mode") sync across windows. Each renderer owns its
// own state, so broadcast a change from any window to every other window so
// the detached cart player stays in lockstep with the main window.
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

ipcMain.on('cart-grid-layouts-changed', (event, layouts) => {
  try {
    requireTrustedIpc(event);
    requireIpcString(layouts, 'layouts', 4096);
  } catch (error) {
    console.warn('[cart-grid-layouts-changed] rejected event:', error.message);
    return;
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.id === event.sender.id) continue;
    if (win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('cart-grid-layouts-set', layouts);
    }
  }
});

ipcMain.handle('get-cart-window-project-data', (event) => {
  requireTrustedIpc(event);
  return currentProjectData || null;
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

// Check FFmpeg availability
ipcMain.handle('check-ffmpeg', async (event) => {
  requireTrustedIpc(event);
  await setupFfmpeg();
  return {
    available: ffmpegAvailable,
    path: ffmpegPath || null
  };
});

// Waveform generation
ipcMain.handle('generate-waveform', async (event, audioFilePath, outputPath) => {
  requireTrustedIpc(event);
  audioFilePath = requireAuthorizedIpcPath(audioFilePath, 'audioFilePath');
  outputPath = requireAuthorizedIpcPath(outputPath, 'outputPath', true);
  if (!(await setupFfmpeg())) throw new Error('FFmpeg is unavailable');
  return new Promise((resolve, reject) => {
    console.log('Generating waveform for:', audioFilePath);
    console.log('Output path:', outputPath);
    
    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Use the detected ffmpeg path
    if (ffmpegPath) {
      ffmpeg.setFfmpegPath(ffmpegPath);
    }
    
    // First, get the duration
    ffmpeg.ffprobe(audioFilePath, (err, metadata) => {
      if (err) {
        console.error('FFprobe error:', err);
        reject(err);
        return;
      }
      
      const duration = metadata.format.duration;
      if (!duration) {
        reject(new Error('Could not determine audio duration'));
        return;
      }
      
      // Calculate samples: 10 per second
      const targetSamples = Math.ceil(duration * 10);
      const samples = [];
      const tempOutput = outputPath + '.temp.wav';
      
      // Extract raw audio data
      ffmpeg(audioFilePath)
        .audioChannels(1)
        .audioFrequency(8000) // Lower frequency for smaller data
        .format('s16le')
        .on('error', (err) => {
          console.error('FFmpeg waveform error:', err);
          reject(err);
        })
        .on('end', () => {
          // Read the temp file and process samples
          try {
            if (fs.existsSync(tempOutput)) {
              const buffer = fs.readFileSync(tempOutput);
              
              // Process samples to get exactly 10 per second
              const sampleInterval = Math.floor(buffer.length / (targetSamples * 2)); // 2 bytes per sample
              
              for (let i = 0; i < buffer.length - 1 && samples.length < targetSamples; i += sampleInterval * 2) {
                const sample = buffer.readInt16LE(i) / 32768.0; // Normalize to -1 to 1
                samples.push(Math.abs(sample));
              }
              
              // Clean up temp file
              fs.unlinkSync(tempOutput);
              
              // Save waveform data (including duration for convenience)
              const waveformData = {
                peaks: samples,
                sampleRate: 10, // 10 samples per second
                duration: duration // Include duration in seconds
              };
              
              fs.writeFileSync(outputPath, JSON.stringify(waveformData));
              console.log('Waveform generated successfully:', samples.length, 'samples @10/sec for', duration.toFixed(2), 'seconds');
              
              resolve({ success: true });
            } else {
              reject(new Error('Temporary audio file not created'));
            }
          } catch (error) {
            console.error('Error processing waveform:', error);
            reject(error);
          }
        })
        .save(tempOutput);
    });
  });
});

const activeSpotifyDownloads = new Map();
const activeSpotifyPreflightJobs = new Map();
const spotifyPreflights = new Map();

function validatedSpotifyUrl(rawUrl) {
  const checked = requireIpcString(rawUrl, 'url', 2048);
  const parsed = new URL(checked);
  if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password) {
    throw new TypeError('A valid Spotify HTTPS URL is required');
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'open.spotify.com') {
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (/^intl-[a-z]{2}(?:-[a-z]{2})?$/i.test(parts[0] || '')) parts.shift();
    if (parts.length !== 2 ||
        !['track', 'album', 'playlist', 'artist'].includes(parts[0]) ||
        !/^[A-Za-z0-9]{10,64}$/.test(parts[1])) {
      throw new TypeError('Use a Spotify track, album, playlist, or artist URL');
    }
  } else if (
    !['spotify.link', 'spotify.app.link'].includes(host) ||
    !/^\/[A-Za-z0-9_-]{3,128}\/?$/.test(parsed.pathname)
  ) {
    throw new TypeError('Use a Spotify share URL');
  }

  parsed.hash = '';
  return parsed.toString();
}

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

function summarizeSpotDlError(lines, code) {
  const useful = [...lines].reverse().find((line) =>
    /(?:\bError\b|\bException\b|failed|no songs found|spotify playlist error)/i.test(line));
  return useful || lines.slice(-5).join('\n') || `spotDL exited with code ${code}`;
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

function spotifyContentParts(rawUrl) {
  const parsed = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  if (parsed.hostname.toLowerCase() !== 'open.spotify.com') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (/^intl-[a-z]{2}(?:-[a-z]{2})?$/i.test(parts[0] || '')) parts.shift();
  if (parts.length !== 2 ||
      !['track', 'album', 'playlist', 'artist'].includes(parts[0]) ||
      !/^[A-Za-z0-9]{10,64}$/.test(parts[1])) {
    return null;
  }
  return { type: parts[0], id: parts[1] };
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
  if (sourceTracks.length === 0 || sourceTracks.length > 10000) {
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
    if (!id) throw new Error(`Spotify track ${index + 1} has no usable ID`);

    const artists = spotifyEmbedArtists(track);
    const durationMs = Number(track?.duration);
    const date = spotifyEmbedDate(track, entity);
    return {
      name: String(track?.title || track?.name || 'Untitled').slice(0, 500),
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
  const url = validatedSpotifyUrl(rawUrl);
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

  let stdout = '';
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

    if (!embedReview) {
      const setupResult = await Promise.race([
        setupSpotDl().then((ready) => ({ ready }), (error) => ({ error })),
        job.cancelledSignal.then(() => ({ cancelled: true })),
      ]);
      if (setupResult.cancelled || job.cancelled) throw new Error('Spotify review cancelled');
      if (setupResult.error) throw setupResult.error;
      if (!setupResult.ready || !spotDlPath) throw new Error('Spotify downloader is unavailable');
      stdout = await new Promise((resolve, reject) => {
        const child = spawn(spotDlPath, ['save', url, '--save-file', '-'], {
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
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          error ? reject(error) : resolve(value);
        };
        const append = (chunk, stderr = false) => {
          bytes += chunk.length;
          if (bytes > 32 * 1024 * 1024) {
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
          else if (code !== 0) finish(new Error(summarizeSpotDlError(errors.split(/\r?\n/), code)));
          else finish(null, output);
        });
        timeout = setTimeout(() => {
          terminateSpotifyChild(child);
          finish(new Error('Spotify review timed out'));
        }, 300000);
        timeout.unref();
      });
    }
  } finally {
    for (const eventName of ['destroyed', 'render-process-gone', 'did-start-navigation']) {
      event.sender.removeListener(eventName, cancelOnRendererExit);
    }
    if (activeSpotifyPreflightJobs.get(jobId) === job) activeSpotifyPreflightJobs.delete(jobId);
    job.resolveDone();
  }

  const clean = stdout.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '').trim();
  const rawTracks = embedReview?.rawTracks || (() => {
    const start = clean.indexOf('[');
    const end = clean.lastIndexOf(']');
    if (start < 0 || end <= start) throw new Error('Spotify returned no track list');
    return JSON.parse(clean.slice(start, end + 1));
  })();
  if (!Array.isArray(rawTracks) || rawTracks.length === 0 || rawTracks.length > 10000) {
    throw new Error('Spotify returned an invalid track list');
  }
  const tracks = rawTracks.map((track, index) => {
    const id = spotifyTrackId(track);
    if (!id) throw new Error(`Spotify track ${index + 1} has no usable ID`);
    const artists = Array.isArray(track.artists)
      ? track.artists.filter((artist) => typeof artist === 'string').slice(0, 20)
      : [];
    return {
      id,
      title: String(track.name || 'Untitled').slice(0, 500),
      artists,
      album: String(track.album_name || '').slice(0, 500),
      duration: Number.isFinite(track.duration) ? Math.max(0, track.duration) : 0,
      coverUrl: typeof track.cover_url === 'string' ? track.cover_url : '',
      spotifyUrl: `https://open.spotify.com/track/${id}`,
    };
  });
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
    rawTracks,
  }));
  return {
    preflightId,
    playlistName,
    tracks,
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
    const url = validatedSpotifyUrl(rawUrl);
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
    if (!Array.isArray(selection?.selectedTrackIds) || selection.selectedTrackIds.length === 0 ||
        selection.selectedTrackIds.length > 10000) {
      throw new TypeError('selectedTrackIds must be a non-empty array');
    }
    const preflight = spotifyPreflights.get(preflightId);
    if (!spotifyReviewIsValid(preflight, event.sender.id, url)) {
      throw new Error('Spotify review expired; review the link again');
    }
    renewSpotifyReview(preflight);
    const selectedTrackIds = selection.selectedTrackIds.map((id) => {
      id = requireIpcString(id, 'trackId', 64);
      if (!/^[A-Za-z0-9]{10,64}$/.test(id)) throw new TypeError('trackId is invalid');
      return id;
    });
    if (new Set(selectedTrackIds).size !== selectedTrackIds.length) {
      throw new TypeError('selectedTrackIds contains duplicates');
    }
    const rawById = new Map(preflight.rawTracks.map((track) => [spotifyTrackId(track), track]));
    const selectedRawTracks = selectedTrackIds.map((id) => rawById.get(id));
    if (selectedRawTracks.some((track) => !track)) throw new Error('Selected Spotify track is not in this review');
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
      // mode (`spotdl url`) for the whole playlist in one process, then
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
        const track = selectedRawTracks[index];
        return `${track.artists.join(', ') || track.artist} - ${track.name}`;
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
        const track = selectedRawTracks[index];
        if (!providerUrl) {
          attempted += 1;
          return;
        }
        const baseName = [
          selectedTrackIds[index],
          sanitizeFilePart(track.artists.join(', ')),
          sanitizeFilePart(track.name),
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
            '-metadata', `title=${track.name}`,
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

      // Match every selected track in one spotDL process — one interpreter
      // start and one Spotify session for the whole playlist, with spotDL's
      // own thread pool running the provider searches. Measured on this
      // playlist: one process per track at concurrency 4 took 42-73s per
      // track and left the progress counter at 0 for over a minute; the
      // threaded batch lands a match about every 11s. Per-track results are
      // parsed from MATCH-level log lines, which carry the Spotify track id.
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
      // Split the playlist into a few chunks matched by concurrent spotDL
      // processes. spotDL fetches each track's Spotify metadata serially
      // inside a process (~5s per track — the phase that used to leave the
      // counter at 0 for many minutes on long playlists), so chunking
      // parallelizes exactly the part that dominates. --threads 2 per chunk
      // keeps ~8 provider searches in flight overall, the highest measured
      // rate that does not trigger throttling.
      let lastMatchActivity = Date.now();
      const batchChildren = new Set();
      const chunkCount = Math.min(4, Math.max(1, Math.ceil(total / 10)));
      const chunkSize = Math.ceil(total / chunkCount);
      const chunkRuns = [];
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
      for (let c = 0; c < total; c += chunkSize) {
        const chunkTracks = selectedRawTracks.slice(c, c + chunkSize);
        const chunkIndex = chunkRuns.length;
        chunkRuns.push(runTracked(spotDlPath, [
          'url', ...chunkTracks.map((track) => track.url),
          '--audio', ...SPOTIFY_AUDIO_PROVIDERS,
          '--max-retries', '1',
          '--threads', '2',
          '--cache-path', path.join(stagingDir, `match-cache-batch-${chunkIndex}`),
          '--log-level', 'MATCH',
          '--log-format', '%(message)s',
        ], Math.max(300000, chunkTracks.length * 60000), onChunkLine,
        (tracked) => batchChildren.add(tracked)));
      }
      // A hung track can stall a batch matcher; cut it loose and let the
      // per-track fallback below take the stragglers.
      const watchdog = setInterval(() => {
        if (!job.cancelled && Date.now() - lastMatchActivity > 240000) {
          console.warn('[spotify] match batch stalled; falling back to per-track matching');
          for (const child of batchChildren) terminateSpotifyChild(child);
        }
      }, 30000);
      try {
        await Promise.all(chunkRuns);
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
          const track = selectedRawTracks[index];
          for (let attempt = 1; attempt <= 2 && !job.cancelled; attempt += 1) {
            const result = await runTracked(spotDlPath, [
              'url', track.url,
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
        total: total || outputs.length,
        completed: outputs.length,
        message: 'Adding tracks to project…',
      });
      const files = await copySpotifyOutputsToMedia(outputs, mediaDir, job);
      const partial = failures.length > 0 || (total > 0 && files.length < total);
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
        total: total || files.length,
        completed: 0,
        groupUuid,
        updatedAt: Date.now(),
      });
      if (!recovery) throw new Error('Could not save Spotify recovery state');
      writeImportPreferences({
        ...readImportPreferences(),
        spotifyDestination: destinationParentPath,
        spotifyRecovery: recovery,
      });
      renewSpotifyReview(preflight);
      job.awaitingImport = true;
      progress('importing', {
        playlistName,
        total: total || files.length,
        completed: files.length,
        message: 'Saving cues to the project…',
      });
      return {
        files,
        total: total || files.length,
        completed: files.length,
        partial,
        error,
        playlistName,
        projectFolderPath,
        completedTrackIds,
        failedTrackIds,
        groupUuid,
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
  for (let attempts = 0; !ytDlpReady && attempts < 30; attempts++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ytDlpReady || !ytDlpPath) {
    throw new Error('yt-dlp failed to initialize. Please restart the application.');
  }
}

ipcMain.handle('get-youtube-info', async (event, videoId) => {
  requireTrustedIpc(event);
  videoId = requireIpcString(videoId, 'videoId', 32);
  if (!/^[A-Za-z0-9_-]{6,32}$/.test(videoId)) throw new TypeError('videoId is invalid');
  await waitForYtDlp();
  const args = [
    `https://www.youtube.com/watch?v=${videoId}`,
    '--dump-single-json', '--skip-download', '--no-playlist', '--no-warnings',
  ];
  if (denoReady && denoPath) args.push('--js-runtimes', `deno:${denoPath}`);
  const { stdout } = await execFilePromise(ytDlpPath, args, {
    windowsHide: true,
    timeout: 45000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const info = JSON.parse(stdout);
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

  const task = new Promise(async (resolve, reject) => {
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
    try { await waitForYtDlp(); }
    catch (error) { reject(error); return; }
    if (job.cancelled) { reject(new Error('YouTube download cancelled')); return; }
    
    // Video mode needs ffmpeg to mux the separate video+audio streams; mp3
    // mode needs it for transcode.
    if ((outputMode === 'mp3' || outputMode === 'video') && !(await setupFfmpeg())) {
      reject(new Error('Bundled FFmpeg failed to initialize. Please restart the application.'));
      return;
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
        while (!denoReady && denoAttempts < 15) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          denoAttempts++;
        }
      }
      if (denoReady && denoPath) {
        args.push('--js-runtimes', `deno:${denoPath}`);
      } else {
        console.warn('Proceeding without a JS runtime; some videos may fail to extract.');
      }

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
      });
      
    } catch (error) {
      console.error('YouTube download error:', error);
      console.error('Error stack:', error.stack);
      
      cleanupNewOutputs();
      
      reject(new Error(`Download failed: ${error.message}`));
    }
  });
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
      copyright: `© ${new Date().getFullYear()} Don Wells — dwcue.com`,
      credits: 'Free software under AGPL-3.0-only — source: github.com/donwellsav/dwcue',
    });

    createWindow();

    // Register this only after ready. macOS may emit `activate` during the
    // ready transition; constructing a BrowserWindow from that early event
    // throws before the app has completed initialization.
    app.on('activate', () => {
      if (mainWindow === null || mainWindow.isDestroyed()) {
        createWindow();
      }
    });

    // Tool probing must never gate first paint. Feature handlers await the
    // same bounded setup promise if the user reaches them immediately.
    void setupFfmpeg().then((ready) => {
      if (!ready) {
        console.error('Warning: Bundled ffmpeg failed to initialize. Audio processing may be limited.');
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
app.on('will-quit', (event) => {
  event.preventDefault();
  void stopTestCardForQuit().catch((error) => {
    console.error('[video-output] AV Sync cleanup on exit failed:', error.message);
  }).finally(() => {
    // All windows have already accepted closing. Complete this quit after
    // cleanup rather than reentering Electron's in-progress app.quit().
    app.exit(0);
  });
});
