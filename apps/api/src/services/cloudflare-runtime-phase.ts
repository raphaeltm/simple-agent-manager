import { log } from '../lib/logger';

export interface CloudflareRuntimePhaseEvents {
  start: string;
  success: string;
  error: string;
}

export async function runCloudflareRuntimePhase<T>(
  events: CloudflareRuntimePhaseEvents,
  phase: string,
  detail: Record<string, unknown>,
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  log.info(events.start, { phase, ...detail });
  try {
    const result = await fn();
    log.info(events.success, {
      phase,
      durationMs: Date.now() - start,
      ...detail,
    });
    return result;
  } catch (err) {
    log.error(events.error, {
      phase,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
      errorName: err instanceof Error ? err.name : undefined,
      ...detail,
    });
    throw err;
  }
}
