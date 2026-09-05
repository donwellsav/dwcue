export const PROJECT_FILE_EXTENSIONS = {
  nativeProject: '.dwcue',
  nativeArchive: '.dwcuepack',
  legacyProject: '.liveplay',
  legacyArchive: '.lpa',
} as const;

export type ProjectFileKind =
  | 'native-project'
  | 'native-archive'
  | 'legacy-project'
  | 'legacy-archive';

export type ProjectFileAction =
  | 'open-project'
  | 'import-legacy-project'
  | 'import-archive';

function extensionForFilePath(filePath: string): string {
  const basename = filePath.split(/[\\/]/).pop() || '';
  const dot = basename.lastIndexOf('.');
  return dot > 0 ? basename.slice(dot).toLowerCase() : '';
}

export function projectFileKind(filePath: string): ProjectFileKind | null {
  switch (extensionForFilePath(filePath)) {
    case PROJECT_FILE_EXTENSIONS.nativeProject:
      return 'native-project';
    case PROJECT_FILE_EXTENSIONS.nativeArchive:
      return 'native-archive';
    case PROJECT_FILE_EXTENSIONS.legacyProject:
      return 'legacy-project';
    case PROJECT_FILE_EXTENSIONS.legacyArchive:
      return 'legacy-archive';
    default:
      return null;
  }
}

export function projectFileAction(filePath: string): ProjectFileAction | null {
  const kind = projectFileKind(filePath);
  if (kind === 'native-project') return 'open-project';
  if (kind === 'legacy-project') return 'import-legacy-project';
  if (kind === 'native-archive' || kind === 'legacy-archive') return 'import-archive';
  return null;
}

export function isNativeProjectPath(filePath: string): boolean {
  return projectFileKind(filePath) === 'native-project';
}

export function isLegacyProjectPath(filePath: string): boolean {
  return projectFileKind(filePath) === 'legacy-project';
}

export function projectPathInFolder(folderPath: string, projectName: string): string {
  const folder = folderPath.replace(/[\\/]+$/, '');
  const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return `${folder}${separator}${projectName}${PROJECT_FILE_EXTENSIONS.nativeProject}`;
}
