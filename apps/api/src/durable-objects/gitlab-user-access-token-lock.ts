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

/**
 * Per-user mutex around BetterAuth GitLab access-token lookup/refresh.
 *
 * BetterAuth performs the account read, upstream refresh, and account update
 * inside `getAccessToken`. GitLab refresh tokens are single-use and rotating,
 * so SAM must serialize that whole call per user — a concurrent replay of a
 * consumed refresh token revokes the entire token family upstream. The read
 * happens inside this DO lock because reading before acquiring the lock would
 * let overlapping callers race with the same stale refresh token.
 */
export class GitLabUserAccessTokenLock extends DurableObject<Env> {
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

    let payload: v.InferOutput<typeof requestSchema>;
    try {
      payload = await readResponseJson(
        new Response(await request.text(), {
          headers: { 'Content-Type': request.headers.get('Content-Type') ?? 'application/json' },
        }),
        requestSchema,
        'gitlab.user_access_token_lock.request'
      );
    } catch {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }

    return this.withRefreshLock(() => this.getAccessToken(payload));
  }

  private async getAccessToken(payload: v.InferOutput<typeof requestSchema>): Promise<Response> {
    try {
      const auth = await createAuth(this.env);
      const token = await auth.api.getAccessToken({
        headers: new Headers(payload.headers),
        body: { providerId: 'gitlab', userId: payload.userId },
      });

      return Response.json({
        accessToken: token.accessToken ?? null,
        accessTokenExpiresAt: token.accessTokenExpiresAt
          ? new Date(token.accessTokenExpiresAt).toISOString()
          : null,
        scopes: token.scopes ?? [],
      });
    } catch (err) {
      log.warn('gitlab.user_access_token_lock.unavailable', {
        flow: payload.flow,
        userId: payload.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'token_unavailable' }, { status: 401 });
    }
  }
}
