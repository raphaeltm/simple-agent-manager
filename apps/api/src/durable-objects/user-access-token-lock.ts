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
 * The lock is an in-memory promise chain, so a lookup that never settles would
 * queue every later lookup by the same user behind it until the object restarts.
 * On the self-hosted celld runtime that happened whenever a browser aborted a
 * request mid-lookup: celld cancels the Durable Object event and drops its pending
 * I/O promises without settling them, unless the event has `waitUntil` work. One
 * aborted page load made every chat send for that user hang for 80 minutes. Two
 * guards keep the chain moving:
 *
 * 1. Each lookup is registered with `ctx.waitUntil`, so a caller that goes away
 *    does not orphan the lookup it started (celld keeps a `waitUntil` event's I/O).
 * 2. Each waiter bounds both its wait for the previous holder and its own lookup by
 *    `performance.userAccessTokenLockTimeoutMs`, measured with timers it owns. A
 *    deadline created inside the holder would be dropped with the holder's other
 *    I/O, so it cannot be the only guard. A waiter that outlasts a stuck holder
 *    proceeds; a stuck holder that later wakes could then overlap it, which is far
 *    less harmful than a user who can never get a token again.
 *
 * Subclasses only supply the BetterAuth provider id; the exported subclass
 * names are bound in wrangler.toml and must not change.
 */
export abstract class UserAccessTokenLock extends DurableObject<Env> {
  protected abstract readonly providerId: 'github' | 'gitlab';

  private refreshLock: Promise<unknown> = Promise.resolve();

  private withRefreshLock<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    onStaleHolder: () => void
  ): Promise<T> {
    const previous = this.refreshLock;
    const run = waitForHolder(previous, timeoutMs, onStaleHolder).then(() =>
      withDeadline(() => fn(), timeoutMs)
    );
    this.refreshLock = run.then(
      () => undefined,
      () => undefined
    );
    // Keep the lookup alive if the caller disconnects (see the class comment).
    this.ctx.waitUntil(this.refreshLock);
    return run;
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
            action: 'proceeded',
          })
      );
    } catch (err) {
      if (!(err instanceof IoTimeoutError)) throw err;
      log.warn(`${this.providerId}.user_access_token_lock.timeout`, {
        ...context,
        action: 'released_lock',
      });
      return Response.json({ error: 'token_lock_timeout' }, { status: 503 });
    }
  }

  private async lockTimeoutMs(): Promise<number> {
    const value = Number(
      await resolveAdminSetting(this.env, 'performance.userAccessTokenLockTimeoutMs')
    );
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_USER_ACCESS_TOKEN_LOCK_TIMEOUT_MS;
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

/**
 * Wait for the previous lock holder, but no longer than `timeoutMs`, using a timer this
 * waiter owns. Never rejects: a failed or stuck holder must not fail the next lookup.
 */
function waitForHolder(
  previous: Promise<unknown>,
  timeoutMs: number,
  onStale: () => void
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stale = new Promise<'stale'>((resolve) => {
    timer = setTimeout(() => resolve('stale'), timeoutMs);
  });
  return Promise.race([previous.then(() => 'settled' as const), stale]).then((outcome) => {
    clearTimeout(timer);
    if (outcome === 'stale') onStale();
  });
}
