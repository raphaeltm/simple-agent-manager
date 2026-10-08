import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Only transport faults, throttling and upstream server failures are retryable. */
export async function requestOriginCertificate<T>(
  env: Env,
  request: (signal: AbortSignal) => Promise<Response>,
  read: (response: Response) => Promise<T>
): Promise<T> {
  const attempts = parsePositiveInt(env.ORIGIN_CA_RETRY_MAX_ATTEMPTS, DEFAULT_ATTEMPTS);
  const baseDelay = parsePositiveInt(env.ORIGIN_CA_RETRY_BASE_DELAY_MS, DEFAULT_BASE_DELAY_MS);
  const maxDelay = parsePositiveInt(env.ORIGIN_CA_RETRY_MAX_DELAY_MS, DEFAULT_MAX_DELAY_MS);
  const timeout = parsePositiveInt(env.ORIGIN_CA_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS);
  for (let attempt = 1; ; attempt++) {
    let retryable = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await request(controller.signal);
      retryable = response.status === 429 || response.status >= 500;
      return await read(response);
    } catch (error) {
      if ((!retryable && !controller.signal.aborted) || attempt >= attempts) throw error;
      // Do not log provider bodies, CSR material or request credentials.
      log.warn('origin_ca.retry', {
        attempt,
        reason: controller.signal.aborted ? 'timeout' : 'transient_failure',
      });
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(maxDelay, baseDelay * 2 ** (attempt - 1)))
    );
  }
}
