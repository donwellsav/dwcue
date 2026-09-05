const { contextBridge, ipcRenderer } = require('electron');

// Try to import webUtils, but it may not be available in all Electron versions
let webUtils;
try {
  webUtils = require('electron').webUtils;
} catch (e) {
  console.warn('webUtils not available:', e);
}

function replaceIpcListener(channel, callback) {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, callback);
  return () => ipcRenderer.removeListener(channel, callback);
}

contextBridge.exposeInMainWorld('electronAPI', {
  // File dialogs
  selectProjectFolder: () => ipcRenderer.invoke('select-project-folder'),
  selectProjectFile: () => ipcRenderer.invoke('select-project-file'),
  selectAudioFiles: () => ipcRenderer.invoke('select-audio-files'),

  // File operations
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, data) => ipcRenderer.invoke('write-file', filePath, data),
  // Dialogs + binary helpers used by the dual-dialog import/export flows.
  showSaveArchiveDialog: (defaultName) => ipcRenderer.invoke('show-save-archive-dialog', defaultName),
  showOpenArchiveDialog: () => ipcRenderer.invoke('show-open-archive-dialog'),
  getBinaryFileInfo: (filePath) => ipcRenderer.invoke('get-binary-file-info', filePath),
  readBinaryFileChunk: (filePath, offset, length) =>
    ipcRenderer.invoke('read-binary-file-chunk', filePath, offset, length),
  downloadArchiveToFile: (request) =>
    ipcRenderer.invoke('download-archive-to-file', request),
  copyFile: (source, destination) => ipcRenderer.invoke('copy-file', source, destination),
  ensureDirectory: (dirPath) => ipcRenderer.invoke('ensure-directory', dirPath),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  getImportPreferences: () => ipcRenderer.invoke('get-import-preferences'),
  setSpotifyImportDestination: (destination) =>
    ipcRenderer.invoke('set-spotify-import-destination', destination),
  setSpotifyImportRecovery: (recovery) =>
    ipcRenderer.invoke('set-spotify-import-recovery', recovery),
  clearSpotifyImportRecovery: (activeProjectFolderPath) =>
    ipcRenderer.invoke('clear-spotify-import-recovery', activeProjectFolderPath),
  
  // Get file path from dropped file
  getFilePath: (file) => {
    try {
      if (webUtils && webUtils.getPathForFile) {
        const filePath = webUtils.getPathForFile(file);
        if (filePath) ipcRenderer.send('authorize-dropped-file', filePath);
        return filePath;
      }
      return null;
    } catch (error) {
      console.error('Error getting file path:', error);
      return null;
    }
  },

  // Project management
  setCurrentProject: (projectPath) => ipcRenderer.invoke('set-current-project', projectPath),

  // Waveform generation
  generateWaveform: (audioPath, outputPath) => ipcRenderer.invoke('generate-waveform', audioPath, outputPath),

  // FFmpeg check
  checkFfmpeg: () => ipcRenderer.invoke('check-ffmpeg'),

  // YouTube features
  searchYouTube: (query) => ipcRenderer.invoke('search-youtube', query),
  getYouTubeInfo: (videoId) => ipcRenderer.invoke('get-youtube-info', videoId),
  downloadYouTubeAudio: (jobId, videoId, title, projectFolderPath, outputMode, progressCallback) => {
    // Set up progress listener
    const progressListener = (event, progress) => {
      if (progress.jobId === jobId && progressCallback) {
        progressCallback(progress);
      }
    };
    ipcRenderer.on('youtube-download-progress', progressListener);
    
    // Start download and clean up listener when done
    return ipcRenderer.invoke(
      'download-youtube-audio',
      jobId,
      videoId,
      title,
      projectFolderPath,
      outputMode,
    )
      .finally(() => {
        ipcRenderer.removeListener('youtube-download-progress', progressListener);
      });
  },
  cancelYouTubeDownload: (jobId) => ipcRenderer.invoke('cancel-youtube-download', jobId),

  // Spotify track / album / playlist import
  preflightSpotify: (jobId, url) => ipcRenderer.invoke('spotify-preflight', jobId, url),
  cancelSpotifyPreflight: (jobId) => ipcRenderer.invoke('cancel-spotify-preflight', jobId),
  downloadSpotifyAudio: (jobId, url, destinationParentPath, selection, progressCallback) => {
    const progressListener = (_event, progress) => {
      if (progress.jobId === jobId && progressCallback) progressCallback(progress);
    };
    ipcRenderer.on('spotify-download-progress', progressListener);
    return ipcRenderer.invoke(
      'download-spotify-audio', jobId, url, destinationParentPath, selection,
    ).finally(() => {
      ipcRenderer.removeListener('spotify-download-progress', progressListener);
    });
  },
  cancelSpotifyDownload: (jobId) =>
    ipcRenderer.invoke('cancel-spotify-download', jobId),
  finalizeSpotifyImport: (jobId, keepFiles) =>
    ipcRenderer.invoke('finalize-spotify-import', jobId, keepFiles),

  // Menu events. These are mounted by Vue components that can be replaced when
  // projects are opened/closed; keep one live renderer listener per channel so
  // menu actions do not fire once for every previous component instance.
  onMenuNewProject: (callback) => replaceIpcListener('menu-new-project', callback),
  onMenuOpenProject: (callback) => replaceIpcListener('menu-open-project', callback),
  onMenuSaveProject: (callback) => replaceIpcListener('menu-save-project', callback),
  onMenuExportProject: (callback) => replaceIpcListener('menu-export-project', callback),
  onMenuImportProject: (callback) => replaceIpcListener('menu-import-project', callback),
  onMenuCloseProject: (callback) => replaceIpcListener('menu-close-project', callback),
  onMenuOpenRecentProject: (callback) => replaceIpcListener('menu-open-recent-project', callback),
  onMenuOpenProjectFolder: (callback) => replaceIpcListener('menu-open-project-folder', callback),
  onMenuToggleDarkMode: (callback) => replaceIpcListener('menu-toggle-dark-mode', callback),
  onMenuChangeAccentColor: (callback) => replaceIpcListener('menu-change-accent-color', callback),
  onMenuChangeLanguage: (callback) => replaceIpcListener('menu-change-language', callback),
  onMenuShowAbout: (callback) => replaceIpcListener('menu-show-about', callback),

  // External links
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  
  // Update menu language
  updateMenuLanguage: (locale) => ipcRenderer.invoke('update-menu-language', locale),
  
  // Get system locale
  getSystemLocale: () => ipcRenderer.invoke('get-system-locale'),
  
  // Get available locales and locale data
  getAvailableLocales: () => ipcRenderer.invoke('get-available-locales'),
  getLocaleData: (localeCode) => ipcRenderer.invoke('get-locale-data', localeCode),

  // Auto-updater
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  getUpdateInstallSupported: () => ipcRenderer.invoke('get-update-install-supported'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', callback),
  onUpdateUpToDate: (callback) => ipcRenderer.on('update-up-to-date', callback),
  onUpdateDownloadProgress: (callback) => ipcRenderer.on('update-download-progress', callback),
  onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', callback),
  onUpdateError: (callback) => ipcRenderer.on('update-error', callback),
  onMenuCheckForUpdates: (callback) => ipcRenderer.on('menu-check-for-updates', callback),

  // Project data sync between the main and detached cart windows.
  syncProjectData: (data) => ipcRenderer.send('sync-project-data', data),
  
  // File association routing for canonical shows/archives and explicit legacy imports.
  // Push: main → renderer for warm-start / macOS open-file events.
  onOpenFileAssociation: (callback) => ipcRenderer.on('open-file-association', callback),
  // Pull: renderer asks on mount for any file queued before it was ready
  // (cold start). Returns { filePath, kind } | null.
  getPendingOpenFile: () => ipcRenderer.invoke('get-pending-open-file'),
  
  // Cart player window — detach/attach
  openCartPlayerWindow: (projectFolderPath) => ipcRenderer.invoke('open-cart-player-window', projectFolderPath),
  attachCartPlayerWindow: () => ipcRenderer.send('cart-player-window-attach'),
  getCartWindowProjectData: () => ipcRenderer.invoke('get-cart-window-project-data'),
  onCartPlayerWindowOpened: (callback) => replaceIpcListener('cart-player-window-opened', callback),
  onCartPlayerWindowClosed: (callback) => replaceIpcListener('cart-player-window-closed', callback),
  onCartWindowProjectUpdate: (callback) => ipcRenderer.on('cart-window-project-update', callback),

  // UI mode ("show mode") sync across windows
  broadcastUiMode: (mode) => ipcRenderer.send('ui-mode-changed', mode),
  onUiModeSet: (callback) => ipcRenderer.on('ui-mode-set', callback),
  broadcastCartGridLayouts: (layouts) => ipcRenderer.send('cart-grid-layouts-changed', layouts),
  onCartGridLayoutsSet: (callback) => ipcRenderer.on('cart-grid-layouts-set', callback),

  // State viewer - send state updates to main process
  updateAppState: (state) => ipcRenderer.send('update-app-state', state),
  // Main tells us when a state viewer window opens/closes; the renderer only
  // broadcasts state while one is open (avoids 500ms whole-project churn).
  onStateViewerActive: (callback) => ipcRenderer.on('state-viewer:active', (_event, active) => callback(active)),
  
  // Check if dev mode is enabled
  isDevMode: () => ipcRenderer.invoke('is-dev-mode'),

  // MIDI config
  readMidiConfig: () => ipcRenderer.invoke('read-midi-config'),
  writeMidiConfig: (config) => ipcRenderer.invoke('write-midi-config', config),

  // DonWells Cue audio server lifecycle (C++ server spawned by main process)
  liveplayServer: {
    getConfig: () => ipcRenderer.invoke('liveplay-server:get-config'),
    setConfig: (cfg) => ipcRenderer.invoke('liveplay-server:set-config', cfg),
    getStatus: () => ipcRenderer.invoke('liveplay-server:get-status'),
    restart:   () => ipcRenderer.invoke('liveplay-server:restart'),
    shutdown:  () => ipcRenderer.invoke('liveplay-server:shutdown'),
    ensureRunning: () => ipcRenderer.invoke('liveplay-server:ensure-running'),
    onStateChange: (callback) => {
      const listener = (_e, payload) => callback(payload);
      ipcRenderer.on('liveplay-server:state', listener);
      return () => ipcRenderer.removeListener('liveplay-server:state', listener);
    },
  },

  // Top-level app lifecycle (used by the connection-lost modal and the
  // quit-confirmation flow).
  app: {
    relaunch: () => ipcRenderer.invoke('app:relaunch'),
    exit:     () => ipcRenderer.invoke('app:exit'),
    // Quit confirmation: main vetoes the window close and pushes
    // `app:request-quit`; the renderer shows its dialogs then calls
    // confirmQuit({ stopServer, installUpdate?, runAfterInstall? }) to
    // actually quit (optionally shutting the local audio server down first).
    confirmQuit: (opts) => ipcRenderer.invoke('app:confirm-quit', opts),
    onRequestQuit: (callback) => {
      const listener = () => callback();
      ipcRenderer.on('app:request-quit', listener);
      return () => ipcRenderer.removeListener('app:request-quit', listener);
    },
  },

  // LAN auto-discovery of other DonWells Cue servers (UDP beacons on the LAN).
  liveplayDiscovery: {
    start:   () => ipcRenderer.invoke('liveplay-discovery:start'),
    list:    () => ipcRenderer.invoke('liveplay-discovery:list'),
    solicit: () => ipcRenderer.invoke('liveplay-discovery:solicit'),
    onServers: (callback) => {
      const listener = (_e, servers) => callback(servers);
      ipcRenderer.on('liveplay-discovery:servers', listener);
      return () => ipcRenderer.removeListener('liveplay-discovery:servers', listener);
    },
    // Recent-servers history (persisted) — robust reconnect fallback.
    recentList:   ()    => ipcRenderer.invoke('liveplay-discovery:recent-list'),
    recentAdd:    (e)   => ipcRenderer.invoke('liveplay-discovery:recent-add', e),
    recentRemove: (url) => ipcRenderer.invoke('liveplay-discovery:recent-remove', url),
  },

  // Recent-projects history (persisted) — last 10 canonical shows opened on
  // this client. Surfaced in the File > Open Recent menu.
  liveplayProjects: {
    recentList:   ()     => ipcRenderer.invoke('liveplay-projects:recent-list'),
    recentAdd:    (e)    => ipcRenderer.invoke('liveplay-projects:recent-add', e),
    recentRemove: (path) => ipcRenderer.invoke('liveplay-projects:recent-remove', path),
    recentClear:  ()     => ipcRenderer.invoke('liveplay-projects:recent-clear'),
  },
  // Video Output window (slice 1: window lifecycle, display assignment, test
  // card). Display identity is machine-level state owned by the main process;
  // renderers only arm/disarm and pick a display.
  videoOutput: {
    open:         ()           => ipcRenderer.invoke('video-output:open'),
    close:        ()           => ipcRenderer.invoke('video-output:close'),
    status:       ()           => ipcRenderer.invoke('video-output:status'),
    listDisplays: ()           => ipcRenderer.invoke('video-output:list-displays'),
    identifyDisplays: ()       => ipcRenderer.invoke('video-output:identify-displays'),
    setDisplay:   (displayId)  => ipcRenderer.invoke('video-output:set-display', displayId),
    setTestCard:  (show)       => ipcRenderer.invoke('video-output:test-card', show),
    setFullscreen:    (on)     => ipcRenderer.invoke('video-output:set-fullscreen', on),
    toggleFullscreen: ()       => ipcRenderer.invoke('video-output:toggle-fullscreen'),
    onShortcut: (callback) => {
      const listener = (_e, shortcut) => callback(shortcut);
      ipcRenderer.on('video-output:shortcut', listener);
      return () => ipcRenderer.removeListener('video-output:shortcut', listener);
    },
    onStatus: (callback) => {
      const listener = (_e, status) => callback(status);
      ipcRenderer.on('video-output:status-changed', listener);
      return () => ipcRenderer.removeListener('video-output:status-changed', listener);
    },
    onTestCard: (callback) => {
      const listener = (_e, show) => callback(show === true);
      ipcRenderer.on('video-output:test-card', listener);
      return () => ipcRenderer.removeListener('video-output:test-card', listener);
    },
    onFrame: (callback) => {
      const listener = (_e, frame) => callback(frame);
      ipcRenderer.on('video-output:frame', listener);
      return () => ipcRenderer.removeListener('video-output:frame', listener);
    },
  },
});
