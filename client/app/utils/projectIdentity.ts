export interface ProjectIdentityDocument {
  name?: string;
  folderPath?: string;
  createdAt?: string;
}

export interface ProjectIdentityHeader extends ProjectIdentityDocument {
  hasOpenProject?: boolean;
  server?: { projectFilePath?: string | null };
}

export const projectPathFromHeader = (header: ProjectIdentityHeader): string =>
  header.hasOpenProject === true && typeof header.server?.projectFilePath === 'string'
    ? header.server.projectFilePath
    : '';

export const isSameProjectIdentity = (
  header: ProjectIdentityHeader,
  current: ProjectIdentityDocument,
  currentPath: string,
): boolean => {
  if (header.hasOpenProject !== true) return false;
  const serverPath = projectPathFromHeader(header);
  if (serverPath || currentPath) return serverPath === currentPath;
  return header.name === current.name
    && header.folderPath === current.folderPath
    && header.createdAt === current.createdAt;
};

export const isCurrentSaveIdentity = <T extends object>(
  capturedProject: T,
  capturedPath: string,
  capturedEpoch: number,
  currentProject: T | null,
  currentPath: string,
  currentEpoch: number,
): boolean => currentProject === capturedProject
  && currentPath === capturedPath
  && currentEpoch === capturedEpoch;
