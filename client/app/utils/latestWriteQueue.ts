export interface LatestWriteResult<T> {
  ok: boolean;
  request: T;
  error?: unknown;
}

interface PendingWrite<T> {
  request: T;
  write: (request: T) => Promise<boolean>;
}

export const createLatestWriteQueue = <T>() => {
  let draining = false;
  let pending: PendingWrite<T> | null = null;
  let waiters: Array<(result: LatestWriteResult<T>) => void> = [];

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    let result: LatestWriteResult<T> | null = null;

    while (pending) {
      const current = pending;
      pending = null;
      try {
        result = {
          ok: await current.write(current.request),
          request: current.request,
        };
      } catch (error) {
        result = { ok: false, request: current.request, error };
      }
    }

    draining = false;
    if (result) {
      const settled = waiters;
      waiters = [];
      for (const resolve of settled) resolve(result);
    }
  };

  const enqueue = (
    request: T,
    write: (request: T) => Promise<boolean>,
  ): Promise<LatestWriteResult<T>> => {
    pending = { request, write };
    const result = new Promise<LatestWriteResult<T>>((resolve) => {
      waiters.push(resolve);
    });
    void drain();
    return result;
  };

  return { enqueue };
};
