export {};

declare global {
  interface Window {
    electronAPI: {
      selectProjectFolder: () => Promise<string | null>;
      selectProjectFile: () => Promise<string | null>;
      selectAudioFiles: () => Promise<string[] | null>;
      readFile: (filePath: string) => Promise<{ success: boolean; data?: string; error?: string }>;
      writeFile: (filePath: string, data: string) => Promise<{ success: boolean; error?: string }>;
      showSaveArchiveDialog: (defaultName?: string) => Promise<string | null>;
      showOpenArchiveDialog: () => Promise<string | null>;
      getBinaryFileInfo: (filePath: string) => Promise<{
        success: boolean;
        size?: number;
        name?: string;
        error?: string;
      }>;
      readBinaryFileChunk: (filePath: string, offset: number, length: number) => Promise<{
        success: boolean;
        data?: ArrayBuffer;
        error?: string;
      }>;
      downloadArchiveToFile: (request: {
        baseUrl: string;
        token: string;
        destination: string;
        accessToken?: string;
      }) => Promise<{ success: boolean; error?: string }>;
      copyFile: (source: string, destination: string) => Promise<{ success: boolean; error?: string }>;
      ensureDirectory: (dirPath: string) => Promise<{ success: boolean; error?: string }>;
      generateWaveform: (audioPath: string, outputPath: string) => Promise<{ success: boolean; error?: string }>;
      openFolder: (folderPath: string) => Promise<{ success: boolean; error?: string }>;
      setCurrentProject: (projectPath: string) => Promise<{ success: boolean }>;
      getFilePath: (file: File) => string | null;
      checkFfmpeg: () => Promise<{ available: boolean; path: string | null }>;
      searchYouTube: (query: string) => Promise<Array<{
        id: string;
        title: string;
        thumbnail: string;
        channelTitle: string;
        length?: string;
      }>>;
      downloadYouTubeAudio: (
        videoId: string,
        title: string,
        projectFolderPath: string,
        progressCallback?: (progress: { videoId: string; percentage: number; status: string }) => void
      ) => Promise<{ success: boolean; file: string; fileName: string; title: string }>;
      downloadSpotifyAudio: (
        jobId: string,
        url: string,
        destinationParentPath: string,
        progressCallback?: (progress: {
          jobId: string;
          status: 'preparing' | 'resolving' | 'downloading' | 'importing' |
            'complete' | 'partial' | 'cancelled' | 'error';
          playlistName?: string;
          total: number;
          completed: number;
          message?: string;
        }) => void
      ) => Promise<{
        files: string[];
        total: number;
        completed: number;
        partial: boolean;
        error?: string;
        playlistName: string;
        projectFolderPath: string;
      }>;
      cancelSpotifyDownload: (jobId: string) => Promise<boolean>;
      finalizeSpotifyImport: (jobId: string, keepFiles: boolean) => Promise<boolean>;
      onMenuNewProject: (callback: () => void) => void;
      onMenuOpenProject: (callback: () => void) => void;
      onMenuSaveProject: (callback: () => void) => void;
      onMenuExportProject: (callback: () => void) => void;
      onMenuImportProject: (callback: () => void) => void;
      onMenuCloseProject: (callback: () => void) => void;
      onMenuOpenRecentProject: (callback: (event: any, projectPath: string) => void) => void;
      onMenuOpenProjectFolder: (callback: () => void) => void;
      onMenuToggleDarkMode: (callback: () => void) => void;
      onMenuChangeAccentColor: (callback: () => void) => void;
      onMenuChangeLanguage: (callback: (event: any, locale: string) => void) => void;
      onMenuShowAbout: (callback: () => void) => void;
      openExternal: (url: string) => Promise<void>;
      updateMenuLanguage: (locale: string) => Promise<{ success: boolean }>;
      getSystemLocale: () => Promise<string>;
      getAvailableLocales: () => Promise<Array<{ code: string; name: string; direction: string }>>;
      getLocaleData: (localeCode: string) => Promise<any>;
      checkForUpdates: () => Promise<{ success: boolean; updateInfo?: any; error?: string }>;
      downloadUpdate: () => Promise<{ success: boolean; error?: string }>;
      installUpdate: () => void;
      getAppVersion: () => Promise<string>;
      onUpdateAvailable: (callback: (event: any, info: { currentVersion: string; newVersion: string; releaseNotes?: string; releaseDate?: string }) => void) => void;
      onUpdateDownloadProgress: (callback: (event: any, progress: { percent: number; transferred: number; total: number }) => void) => void;
      onUpdateDownloaded: (callback: (event: any, info: { version: string }) => void) => void;
      onUpdateError: (callback: (event: any, error: string) => void) => void;
      syncProjectData: (data: any) => void;
      onOpenFileAssociation: (callback: (event: any, data: { filePath: string; kind: 'liveplay' | 'lpa' }) => void) => void;
      getPendingOpenFile: () => Promise<{ filePath: string; kind: 'liveplay' | 'lpa' } | null>;
      readMidiConfig: () => Promise<Record<string, any>>;
      writeMidiConfig: (config: Record<string, any>) => Promise<{ success: boolean }>;
      // Cart player window
      openCartPlayerWindow: (projectFolderPath: string) => Promise<void>;
      attachCartPlayerWindow: () => void;
      getCartWindowProjectData: () => Promise<any>;
      onCartPlayerWindowOpened: (callback: () => void) => void;
      onCartPlayerWindowClosed: (callback: () => void) => void;
      onCartWindowProjectUpdate: (callback: (event: any, projectData: any) => void) => void;
      // UI mode ("show mode") sync across windows
      broadcastUiMode: (mode: 'edit' | 'playback') => void;
      onUiModeSet: (callback: (event: any, mode: 'edit' | 'playback') => void) => void;
      broadcastCartGridLayouts: (layouts: string) => void;
      onCartGridLayoutsSet: (callback: (event: any, layouts: string) => void) => void;
      // Recent-projects history (last 10 .liveplay files opened on this client).
      liveplayProjects?: {
        recentList: () => Promise<Array<{ path: string; name: string; folderPath: string; lastOpened: number }>>;
        recentAdd: (entry: { path: string; name?: string; folderPath?: string }) => Promise<Array<{ path: string; name: string; folderPath: string; lastOpened: number }>>;
        recentRemove: (path: string) => Promise<Array<{ path: string; name: string; folderPath: string; lastOpened: number }>>;
        recentClear: () => Promise<Array<never>>;
      };
    };
  }

  interface ImportMeta {
    client: boolean;
  }
}
