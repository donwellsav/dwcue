export type ProjectHydrationStatus = 'loading' | 'ready' | 'failed';

export interface ProjectHydrationSnapshot<T extends object> {
  project: T;
  status: ProjectHydrationStatus;
  error: string | null;
}

export function createProjectHydration<T extends object>(
  onChange: (snapshot: ProjectHydrationSnapshot<T> | null) => void = () => {},
) {
  type Load = {
    project: T;
    ready: Promise<boolean>;
    finish: (complete: boolean, error?: unknown) => void;
    snapshot: ProjectHydrationSnapshot<T>;
  };
  let current: Load | null = null;

  function publish(load: Load | null) {
    if (load && current !== load) return;
    onChange(load?.snapshot ?? null);
  }

  function invalidate() {
    const stale = current;
    current = null;
    stale?.finish(false);
    publish(null);
  }

  function begin(project: T) {
    invalidate();
    let settle!: (complete: boolean) => void;
    let settled = false;
    const ready = new Promise<boolean>(resolve => { settle = resolve; });
    const snapshot: ProjectHydrationSnapshot<T> = { project, status: 'loading', error: null };
    const load: Load = {
      project,
      ready,
      snapshot,
      finish(complete, error) {
        if (settled) return;
        settled = true;
        const isCurrent = current === load;
        if (isCurrent) {
          snapshot.status = complete ? 'ready' : 'failed';
          snapshot.error = complete ? null : error instanceof Error ? error.message : error ? String(error) : null;
          publish(load);
        }
        settle(complete && isCurrent);
      },
    };
    current = load;
    publish(load);
    return load;
  }

  async function wait(project: T): Promise<boolean> {
    const load = current;
    return !!load && load.project === project && await load.ready && current === load;
  }

  return {
    begin,
    invalidate,
    wait,
    current: () => current,
    snapshot: (): ProjectHydrationSnapshot<T> | null => current?.snapshot ?? null,
  };
}

export function createProjectHydrationRetry() {
  let retry: null | (() => Promise<boolean>) = null;
  return {
    set(next: () => Promise<boolean>) {
      retry = next;
    },
    run(): Promise<boolean> {
      return retry?.() ?? Promise.resolve(false);
    },
  };
}
