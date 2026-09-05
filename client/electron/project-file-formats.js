'use strict';

const ProjectFileKind = Object.freeze({
  NativeProject: 'native-project',
  NativeArchive: 'native-archive',
  LegacyProject: 'legacy-project',
  LegacyArchive: 'legacy-archive',
});

const PROJECT_EXTENSIONS = Object.freeze({
  nativeProject: '.dwcue',
  nativeArchive: '.dwcuepack',
  legacyProject: '.liveplay',
  legacyArchive: '.lpa',
});

function extensionForFilePath(filePath) {
  if (typeof filePath !== 'string') return '';
  const basename = filePath.split(/[\\/]/).pop() || '';
  const dot = basename.lastIndexOf('.');
  return dot > 0 ? basename.slice(dot).toLowerCase() : '';
}

function fileKindFor(filePath) {
  switch (extensionForFilePath(filePath)) {
    case PROJECT_EXTENSIONS.nativeProject:
      return ProjectFileKind.NativeProject;
    case PROJECT_EXTENSIONS.nativeArchive:
      return ProjectFileKind.NativeArchive;
    case PROJECT_EXTENSIONS.legacyProject:
      return ProjectFileKind.LegacyProject;
    case PROJECT_EXTENSIONS.legacyArchive:
      return ProjectFileKind.LegacyArchive;
    default:
      return null;
  }
}

function fileActionFor(filePath) {
  switch (fileKindFor(filePath)) {
    case ProjectFileKind.NativeProject:
      return 'open-project';
    case ProjectFileKind.LegacyProject:
      return 'import-legacy-project';
    case ProjectFileKind.NativeArchive:
    case ProjectFileKind.LegacyArchive:
      return 'import-archive';
    default:
      return null;
  }
}

function canonicalArchivePath(filePath) {
  const extension = extensionForFilePath(filePath);
  if (extension === PROJECT_EXTENSIONS.nativeArchive ||
      extension === PROJECT_EXTENSIONS.legacyArchive) {
    return filePath.slice(0, -extension.length) + PROJECT_EXTENSIONS.nativeArchive;
  }
  return filePath + PROJECT_EXTENSIONS.nativeArchive;
}

function getOpenableFileFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  return argv.find(arg => fileKindFor(arg) !== null) || null;
}

function shouldScanInitialOpenFileArgv(platform, defaultApp) {
  return platform === 'win32' || platform === 'linux' || defaultApp === true;
}

function shouldRegisterProtocolClient(userDataOverride) {
  return typeof userDataOverride !== 'string' || userDataOverride.length === 0;
}

module.exports = {
  PROJECT_EXTENSIONS,
  ProjectFileKind,
  canonicalArchivePath,
  extensionForFilePath,
  fileActionFor,
  fileKindFor,
  getOpenableFileFromArgv,
  shouldRegisterProtocolClient,
  shouldScanInitialOpenFileArgv,
};
