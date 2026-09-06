export interface ProjectOpenGuardDependencies {
  confirmUnsavedChanges(): Promise<boolean>;
  openProject(path: string): Promise<boolean>;
  onOpenFailed(path: string): void;
}

export function createProjectOpenGuard(dependencies: ProjectOpenGuardDependencies) {
  let activeTarget: string | null = null;
  let activeAttempt: Promise<boolean> | null = null;

  return (target: string): Promise<boolean> => {
    if (!target) return Promise.resolve(false);
    if (activeAttempt) return activeTarget === target ? activeAttempt : Promise.resolve(false);
    activeTarget = target;
    activeAttempt = (async () => {
      if (!await dependencies.confirmUnsavedChanges()) return false;
      const opened = await dependencies.openProject(target);
      if (!opened) dependencies.onOpenFailed(target);
      return opened;
    })().finally(() => {
      activeTarget = null;
      activeAttempt = null;
    });
    return activeAttempt;
  };
}
