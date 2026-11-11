import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { readResponseJson } from '../lib/runtime-validation';
import { resolveAdminSetting } from '../services/admin-settings-resolution';
import { IoTimeoutError, withDeadline } from '../services/fetch-timeout';
import { getBetterAuthAccessTokenForProvider } from '../services/user-access-token';
import { DEFAULT_USER_ACCESS_TOKEN_LOCK_TIMEOUT_MS } from './user-access-token-lock-config';

const requestSchema = v.object({
  userId: v.string(),
  flow: v.string(),
  headers: v.optional(v.array(v.tuple([v.string(), v.string()]))),
});

type TokenLockPayload = v.InferOutput<typeof requestSchema>;

/**
 * Shared per-user mutex around BetterAuth OAuth access-token lookup/refresh.
 *
 * BetterAuth performs the account read, upstream refresh, and account update
 * inside `getAccessToken`. Providers with single-use (GitHub) or single-use
 * rotating (GitLab) refresh tokens require SAM to serialize that whole call
 * per user — a concurrent replay of a consumed refresh token fails upstream
 * and, for GitLab, revokes the entire token family. The read happens inside
 * the DO lock because reading before acquiring the lock would let overlapping
 * callers race with the same stale refresh token.
 *
 * Lock state lives in memory, so a lookup that never settles would block every
 * later lookup by the same user until the object restarts. On the self-hosted
 * celld runtime that happened whenever a browser aborted a request mid-lookup:
 * celld cancels the Durable Object event and drops its pending I/O promises
 * without settling them, unless the event has `waitUntil` work. One aborted page
 * load made every chat send for that user hang for 80 minutes. Two guards:
 *
 * 1. Each request is registered with `ctx.waitUntil`, so a caller that goes away
 *    does not orphan the lookup it started (celld keeps a `waitUntil` event's I/O).
 * 2. Each holder records a deadline when it starts its lookup
 *    (`performance.userAccessTokenLockTimeoutMs`). Waiters check that deadline with
 *    timers they own (a timer created by an abandoned holder would be dropped with
 *    its other I/O). Once it passes, exactly one waiter takes the lock over; the
 *    rest keep waiting behind it.
 *
 * The lock is released when the lookup settles, never merely because its caller
 * timed out, so a slow lookup keeps serializing. The only overlap left is a
 * holder that outlives its deadline and then wakes up: a second refresh could
 * then replay a consumed refresh token (GitHub rejects it; GitLab revokes the
 * token family and the user must reconnect). That needs a lookup stuck for the
 * whole deadline (default 60 s, normally under 2 s) and is accepted as far less
 * harmful than a user who can never get a token again.
 *
 * Subclasses only supply the BetterAuth provider id; the exported subclass
 * names are bound in wrangler.toml and must not change.
 */
export abstract class UserAccessTokenLock extends DurableObject<Env> {
  protected abstract readonly providerId: 'github' | 'gitlab';

  private holder: LockHolder | null = null;

  private withRefreshLock<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    onStaleHolder: () => void
  ): Promise<T> {
    const operation = (async () => {
      const release = await this.acquire(timeoutMs, onStaleHolder);
      const work = fn();
      // Release when the lookup really settles, not when its caller stops waiting.
      void work.then(release, release);
      return withDeadline(() => work, timeoutMs);
    })();
    // Keep the request alive if the caller disconnects (see the class comment).
    this.ctx.waitUntil(operation.then(noop, noop));
    return operation;
  }

  /**
   * Wait for the lock and claim it. The claim is synchronous after the check, so two
   * waiters can never both take it; a holder past its deadline is taken over once.
   */
  private async acquire(timeoutMs: number, onStaleHolder: () => void): Promise<() => void> {
    for (;;) {
      const current = this.holder;
      if (!current) {
        let release: () => void = noop;
        const settled = new Promise<void>((resolve) => {
          release = resolve;
        });
        const mine: LockHolder = { settled, deadline: Date.now() + timeoutMs };
        this.holder = mine;
        return () => {
          if (this.holder === mine) this.holder = null;
          release();
        };
      }
      const remainingMs = current.deadline - Date.now();
      if (remainingMs <= 0) {
        onStaleHolder();
        this.holder = null;
        continue;
      }
      await settledOrElapsed(current.settled, remainingMs);
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    }

    let payload: TokenLockPayload;
    try {
      payload = await readResponseJson(
        new Response(await request.text(), {
          headers: { 'Content-Type': request.headers.get('Content-Type') ?? 'application/json' },
        }),
        requestSchema,
        `${this.providerId}.user_access_token_lock.request`
      );
    } catch {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }

    // Resolved before queueing, so a slow settings read never holds the lock.
    const timeoutMs = await this.lockTimeoutMs();
    const context = { flow: payload.flow, userId: payload.userId, timeoutMs };
    try {
      return await this.withRefreshLock(
        () => this.getAccessToken(payload),
        timeoutMs,
        () =>
          log.warn(`${this.providerId}.user_access_token_lock.stale_holder`, {
            ...context,
            action: 'took_over',
          })
      );
    } catch (err) {
      if (!(err instanceof IoTimeoutError)) throw err;
      log.warn(`${this.providerId}.user_access_token_lock.timeout`, {
        ...context,
        action: 'answered_503',
      });
      return Response.json({ error: 'token_lock_timeout' }, { status: 503 });
    }
  }

  private async lockTimeoutMs(): Promise<number> {
    try {
      const value = Number(
        await resolveAdminSetting(this.env, 'performance.userAccessTokenLockTimeoutMs')
      );
      if (Number.isFinite(value) && value > 0) return value;
    } catch {
      // A settings failure must not take token lookup down with it.
    }
    return DEFAULT_USER_ACCESS_TOKEN_LOCK_TIMEOUT_MS;
  }

  private async getAccessToken(payload: TokenLockPayload): Promise<Response> {
    try {
      const token = await getBetterAuthAccessTokenForProvider(
        this.env,
        payload.headers ? new Headers(payload.headers) : undefined,
        payload.userId,
        this.providerId
      );
      if (!token) {
        log.warn(`${this.providerId}.user_access_token_lock.account_missing`, {
          flow: payload.flow,
          userId: payload.userId,
        });
        return Response.json({ error: 'token_unavailable' }, { status: 401 });
      }
      return Response.json({
        accessToken: token.accessToken ?? null,
        accessTokenExpiresAt: token.accessTokenExpiresAt
          ? new Date(token.accessTokenExpiresAt).toISOString()
          : null,
        scopes: token.scopes ?? [],
      });
    } catch (err) {
      log.warn(`${this.providerId}.user_access_token_lock.unavailable`, {
        flow: payload.flow,
        userId: payload.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'token_unavailable' }, { status: 401 });
    }
  }
}

interface LockHolder {
  /** Settles when the holder's lookup settles. */
  readonly settled: Promise<void>;
  /** Epoch ms after which a waiter may take the lock over. */
  readonly deadline: number;
}

function noop(): void {}

/** Resolve when `settled` does or after `ms`, using a timer the caller owns. */
function settledOrElapsed(settled: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([settled, elapsed]).finally(() => clearTimeout(timer));
}
