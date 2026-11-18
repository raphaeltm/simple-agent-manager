import { type Auth, createAuth } from '../auth';
import type { Env } from '../env';
import {
  createRequestScopedD1,
  resolveD1BindingIdentity,
  resolveD1SessionMode,
} from '../lib/d1-session';
import { AppError } from '../middleware/error';
import { resolveAdminSettingDetailsMany } from './admin-settings';
import { AdminSettingsUnavailableError } from './admin-settings-cache';
import { DEFAULT_AUTH_READ_ATTEMPTS, DEFAULT_CONFIG_READ_TIMEOUT_MS } from './config-read-deadline';
import { IoTimeoutError, withDeadline } from './fetch-timeout';

/** GET only: retry a stalled read with a fresh D1 session, never cached authorization data. */
export async function withAuthReadDeadline<T>(
  env: Env,
  request: Request,
  read: (auth: Auth) => Promise<T>
): Promise<T> {
  request.signal.throwIfAborted();
  const startedAt = Date.now();
  const operation = async (readEnv: Env) => {
    const auth = await createAuth(readEnv);
    return read(auth);
  };
  // Start the normal read alongside limit resolution. Both share the existing settings
  // snapshot, so adding a deadline does not add a configuration round trip or waterfall.
  const firstRead = operation(env).then(
    (response) => ({ response }),
    (error: unknown) => ({ error })
  );
  let timeoutMs = DEFAULT_CONFIG_READ_TIMEOUT_MS;
  let attempts = DEFAULT_AUTH_READ_ATTEMPTS;
  try {
    const limits = await withDeadline(
      () =>
        resolveAdminSettingDetailsMany(env, [
          'performance.configReadTimeoutMs',
          'performance.authReadAttempts',
        ]),
      timeoutMs,
      request.signal
    );
    timeoutMs = Number(limits[0]?.value ?? timeoutMs);
    attempts = Number(limits[1]?.value ?? attempts);
  } catch (error) {
    if (request.signal.aborted) throw error;
    // The first bootstrap load may itself have timed out. Its pending entry is evicted;
    // use the bounded bootstrap default to try the actual read again.
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const readEnv =
        attempt === 0
          ? env
          : {
              ...env,
              DATABASE: createRequestScopedD1(
                resolveD1BindingIdentity(env.DATABASE),
                resolveD1SessionMode(env)
              ),
            };
      return await withDeadline(
        async () => {
          if (attempt > 0) return operation(readEnv);
          const result = await firstRead;
          if ('error' in result) throw result.error;
          return result.response;
        },
        attempt === 0 ? Math.max(1, timeoutMs - (Date.now() - startedAt)) : timeoutMs,
        request.signal
      );
    } catch (error) {
      if (request.signal.aborted) throw error;
      const retryable =
        error instanceof IoTimeoutError || error instanceof AdminSettingsUnavailableError;
      if (!retryable) throw error;
      if (attempt + 1 === attempts) break;
    }
  }
  throw new AppError(
    503,
    'AUTH_UNAVAILABLE',
    'Session verification is temporarily unavailable. Retry.'
  );
}

export async function readAuthSession(env: Env, request: Request): Promise<Response> {
  try {
    return await withAuthReadDeadline(env, request, (auth) => auth.handler(request));
  } catch (error) {
    if (request.signal.aborted) throw error;
    return Response.json(
      {
        error: 'AUTH_UNAVAILABLE',
        message: 'Session verification is temporarily unavailable. Retry.',
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
