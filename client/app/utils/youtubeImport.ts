interface ReadinessOptions {
  attempts?: number;
  delayMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal?.throwIfAborted();
  const abort = () => {
    clearTimeout(timer);
    reject(signal?.reason);
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', abort);
    resolve();
  }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});

/**
 * Waits for a newly downloaded media file to become readable by the server.
 * Only the read-only probe is retried; the project import itself must run once.
 * The guard is checked before and after every probe so a project switch cannot
 * move the downloaded file into a newly opened project.
 */
export async function waitForDownloadedMediaReady(
  probe: (signal?: AbortSignal) => Promise<void>,
  canContinue: () => boolean,
  options: ReadinessOptions = {},
): Promise<void> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const delayMs = Math.max(0, options.delayMs ?? 500);
  const sleep = options.sleep ?? wait;
  const signal = options.signal;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    signal?.throwIfAborted();
    if (!canContinue()) throw new DOMException('Project changed', 'AbortError');
    try {
      await probe(signal);
      signal?.throwIfAborted();
      if (!canContinue()) throw new DOMException('Project changed', 'AbortError');
      return;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      lastError = error;
      if (attempt === attempts) break;
      await sleep(delayMs * attempt, signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Downloaded media is not ready');
}
