import { AsyncLocalStorage } from 'node:async_hooks';

const scopes = new AsyncLocalStorage<AbortSignal>();
export const cancellationSignal = (): AbortSignal | undefined => scopes.getStore();
export function checkCancelled(): void { cancellationSignal()?.throwIfAborted(); }

/** Fetch and body consumption share the phase signal. No process-global patch. */
export function scopedFetch(input: Parameters<typeof fetch>[0], init: RequestInit = {}): Promise<Response> {
  checkCancelled();
  const phase = cancellationSignal();
  const signal = phase && init.signal ? AbortSignal.any([phase, init.signal]) : phase ?? init.signal;
  return fetch(input, { ...init, signal });
}

export function cancellableDelay(ms: number): Promise<void> {
  checkCancelled();
  const signal = cancellationSignal();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Work must start inside the scope so pages, retries and fetches inherit cancellation. */
export async function withTimeout<T>(run: () => Promise<T>, ms: number, fallback: T): Promise<T> {
  const controller = new AbortController();
  const parent = cancellationSignal();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      scopes.run(signal, async () => { checkCancelled(); const result = await run(); checkCancelled(); return result; }),
      new Promise<T>(resolve => { timer = setTimeout(() => {
        // Resolve first; abort rejection must not turn the documented timeout fallback into an exception.
        resolve(fallback);
        controller.abort(new Error('Scraper phase cancelled after timeout'));
      }, ms); }),
    ]);
  } finally {
    clearTimeout(timer);
    // Also stop sibling workers when one rejects before the deadline.
    controller.abort(new Error('Scraper phase finished'));
  }
}
