import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';

import { createAuth } from '../auth';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { readResponseJson } from '../lib/runtime-validation';

const requestSchema = v.object({
  userId: v.string(),
  flow: v.string(),
  headers: v.array(v.tuple([v.string(), v.string()])),
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
 * Subclasses only supply the BetterAuth provider id; the exported subclass
 * names are bound in wrangler.toml and must not change.
 */
export abstract class UserAccessTokenLock extends DurableObject<Env> {
  protected abstract readonly providerId: string;

  private refreshLock: Promise<unknown> = Promise.resolve();

  private withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.refreshLock.then(() => fn());
    this.refreshLock = run.then(
      () => undefined,
      () => undefined
    );
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

    return this.withRefreshLock(() => this.getAccessToken(payload));
  }

  private async getAccessToken(payload: TokenLockPayload): Promise<Response> {
    try {
      const auth = await createAuth(this.env);
      const token = await auth.api.getAccessToken({
        headers: new Headers(payload.headers),
        body: { providerId: this.providerId, userId: payload.userId },
      });

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
