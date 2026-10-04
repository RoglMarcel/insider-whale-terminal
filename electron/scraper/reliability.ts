import { checkCancelled, cancellableDelay } from './cancellation';
/** Bounded retries for temporary transport failures, never access denials. */
export class SourceHttpError extends Error {
  constructor(public status: number, public retryAfter: string | null = null) {
    super(`Source returned HTTP ${status}`);
  }
}

export const pause = cancellableDelay;

export async function retryTransient<T>(run: () => Promise<T>): Promise<T> {
  try {
    checkCancelled();
    return await run();
  } catch (error) {
    checkCancelled();
    let delay = 1500;
    if (error instanceof SourceHttpError) {
      if (![408, 429, 500, 502, 503, 504].includes(error.status)) throw error;
      if (error.retryAfter) {
        const seconds = Number(error.retryAfter);
        const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(error.retryAfter) - Date.now();
        if (Number.isFinite(requested)) delay = Math.max(delay, requested);
      }
    } else if (!(error instanceof Error) || !/timeout|timed out|fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ERR_CONNECTION|ERR_NETWORK/i.test(error.name + ' ' + error.message)) {
      throw error;
    }
    // A longer Retry-After is left for the next scheduled scrape, not shortened.
    if (delay > 10_000) throw error;
    await pause(delay);
    return run();
  }
}

/** Serialize request starts across workers, including after an event-loop stall. */
export function createRequestPacer(gapMs: number): () => Promise<void> {
  let tail = Promise.resolve();
  let last = -Infinity;
  return () => {
    tail = tail.catch(() => undefined).then(async () => {
      checkCancelled();
      await pause(Math.max(0, last + gapMs - Date.now()));
      last = Date.now();
    });
    return tail;
  };
}
