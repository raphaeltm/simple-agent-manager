import { log } from './logger';

export type WaitUntilFn = (promise: Promise<unknown>) => void;

/**
 * The request's `waitUntil`, or — when the context has no execution context (unit-test Hono
 * apps) — a fallback that still attaches the promise so its work drains and a rejection is
 * logged instead of becoming an unhandled rejection.
 */
export function resolveWaitUntil(
  c: { executionCtx: { waitUntil(promise: Promise<unknown>): void } },
  fallbackLogEvent = 'wait_until.unavailable_background_failed'
): WaitUntilFn {
  try {
    const executionCtx = c.executionCtx;
    if (typeof executionCtx?.waitUntil === 'function') {
      return (promise) => executionCtx.waitUntil(promise);
    }
  } catch {
    // Unit-test Hono contexts may not expose executionCtx.
  }
  return (promise) => {
    void promise.catch((err) => {
      log.warn(fallbackLogEvent, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };
}
