import {
  completeAbortableResponse,
  type ProviderRequestContext,
} from '@simple-agent-manager/providers';

/**
 * GCP HTTP timeout wrapper that composes caller cancellation without changing
 * the existing internal-timeout error returned by fetch.
 */
export async function fetchGcpWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  context?: ProviderRequestContext
): Promise<Response> {
  const signals = [...new Set([init.signal, context?.signal].filter(isAbortSignal))];
  for (const signal of signals) {
    if (signal.aborted) throw signal.reason;
  }

  const controller = new AbortController();
  let callerSignal: AbortSignal | undefined;
  let timedOut = false;
  const listeners = signals.map((signal) => {
    const listener = () => {
      if (callerSignal || timedOut) return;
      callerSignal = signal;
      controller.abort(signal.reason);
    };
    signal.addEventListener('abort', listener, { once: true });
    if (signal.aborted) listener();
    return { signal, listener };
  });
  const timeoutId = setTimeout(() => {
    if (callerSignal || timedOut) return;
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return await completeAbortableResponse(response, controller.signal);
  } catch (error) {
    if (callerSignal) throw callerSignal.reason;
    throw error;
  } finally {
    clearTimeout(timeoutId);
    for (const { signal, listener } of listeners) {
      signal.removeEventListener('abort', listener);
    }
  }
}

function isAbortSignal(value: AbortSignal | null | undefined): value is AbortSignal {
  return value !== undefined && value !== null;
}
