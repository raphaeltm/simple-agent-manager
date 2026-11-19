/**
 * CodexRefreshLock Durable Object — per-user serialization of Codex OAuth token refreshes.
 *
 * Keyed by userId. Prevents concurrent refresh requests from racing against OpenAI's
 * rotating refresh token — only one refresh against OpenAI happens at a time per user.
 * A queued concurrent request presenting the just-rotated token takes the grace path.
 *
 * Accessed via `env.CODEX_REFRESH_LOCK.idFromName(userId)`.
 *
 * Trust boundary: the route handler (`codex-refresh.ts`) verifies the JWT callback token
 * and resolves userId from D1 before forwarding to this DO. The DO trusts the caller-supplied
 * userId — it does not re-verify auth.
 *
 * Security notes:
 *  - Stale-refresh branch (CRITICAL #1) with grace window: When a caller submits a non-matching
 *    refresh token, we check if it was recently rotated (within CODEX_REFRESH_GRACE_WINDOW_MS,
 *    default 5 min). If so, the caller is a legitimate concurrent session that started before
 *    the rotation — we return the full token set including the current refresh_token. Outside
 *    the grace window, we return only short-lived tokens (access_token, id_token) without the
 *    refresh_token, forcing re-auth. This balances security (don't hand out rotating credentials
 *    to truly old/stolen tokens) with operational correctness (don't break concurrent sessions).
 *  - Which credential (HIGH #2, and pinned accounts): the route resolves the credentials the
 *    calling workspace's runs were seeded with (`resolveRunAgentCredentialReferences`: the
 *    recorded agent-key choice, else the same cc resolver), so a project or profile pin is
 *    refreshed against its own row and never against the user's default. An inactive candidate
 *    is skipped, never replaced by another credential. The rotation is written with a
 *    compare-and-set on the ciphertext that was read (`writeRotatedAgentCredential`).
 *  - Grace entries record the credential the token was rotated out of, and only that
 *    credential's tokens are returned for a grace hit.
 *  - Rate limiting (MEDIUM #5): token-bucket state is held in DO storage (strongly consistent,
 *    atomic increments). KV read-modify-write is not safe for enforcement under concurrency.
 *  - Scope validation (MEDIUM #6): unexpected upstream scopes are checked against a conservative
 *    allowlist of Codex OAuth scopes. Unexpected scopes block the refresh with 502 by default.
 *    Disable with CODEX_EXPECTED_SCOPES="" to explicitly opt out of validation.
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';

import { log } from '../lib/logger';
import { readResponseJson } from '../lib/runtime-validation';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { encrypt } from '../services/encryption';
import {
  credentialGenerationFingerprint,
  writeRotatedAgentCredential,
} from '../services/run-agent-credential';
import {
  CODEX_AGENT_TYPE,
  CODEX_CREDENTIAL_KIND,
  loadRefreshCandidates,
  readSafeUpstreamError,
  type RefreshCandidate,
} from './codex-refresh-lock-candidates';
import {
  type CodexRefreshEnv,
  DEFAULT_CLIENT_ID,
  DEFAULT_EXPECTED_SCOPES,
  DEFAULT_GRACE_WINDOW_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_RATE_LIMIT,
  DEFAULT_RATE_WINDOW_SECONDS,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  DEFAULT_UPSTREAM_URL,
  MAX_ROTATED_TOKEN_ENTRIES,
  type RateLimitState,
  type RefreshRequestPayload,
  type RotatedTokenEntry,
} from './codex-refresh-lock-config';

export class CodexRefreshLock extends DurableObject<CodexRefreshEnv> {
  /**
   * In-memory mutex (promise chain) serializing the read→refresh→write critical
   * section within a single DO instance.
   *
   * IMPORTANT: a Durable Object does NOT serialize concurrent `async fetch()`
   * handlers across `await` points. When a handler awaits an external `fetch()`
   * to OpenAI, the DO is free to start processing the next queued request. Two
   * concurrent refreshes for the same user could therefore both read the same
   * stored refresh_token, both pass the match check, and both POST it to OpenAI.
   * OpenAI rotates the one-time-use refresh_token on first use and revokes the
   * whole token family when the now-consumed token is replayed — which breaks
   * every subsequent refresh (401 → re-refresh loop → 429). The AbortController
   * timeout is NOT a mutex; only this promise chain provides real serialization.
   *
   * The credential read MUST happen inside the lock so that a queued second
   * request re-reads the post-rotation token and takes the grace-window path
   * instead of replaying the consumed token against OpenAI.
   */
  private refreshLock: Promise<unknown> = Promise.resolve();

  /**
   * Run `fn` exclusively with respect to other refreshes in this DO instance.
   * Each call chains onto the previous one so the critical sections execute
   * strictly one-at-a-time, even across `await` boundaries.
   */
  private withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.refreshLock.then(() => fn());
    // Keep the chain alive even if this run rejects, so a failed refresh does
    // not permanently wedge the lock for subsequent requests.
    this.refreshLock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Handle an incoming refresh request. The actual refresh runs inside
   * `withRefreshLock` so concurrent requests for the same user are serialized.
   *
   * An AbortController enforces the lock timeout — if the overall operation
   * exceeds the limit, the upstream fetch is aborted and no background writes occur.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const lockTimeout =
      parseInt(this.env.CODEX_REFRESH_LOCK_TIMEOUT_MS || '', 10) || DEFAULT_LOCK_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), lockTimeout);

    try {
      return await this.handleRefresh(request, controller.signal);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return new Response(
          JSON.stringify({ error: 'lock_timeout', message: 'Refresh lock timed out' }),
          { status: 504, headers: { 'Content-Type': 'application/json' } }
        );
      }
      // Do not expose internal error details to caller.
      return new Response(JSON.stringify({ error: 'internal_error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async handleRefresh(request: Request, signal: AbortSignal): Promise<Response> {
    const payload: RefreshRequestPayload = await request.json();
    const { refreshToken, userId, credentialReferences } = payload;

    if (
      !refreshToken ||
      !userId ||
      !Array.isArray(credentialReferences) ||
      credentialReferences.length === 0 ||
      !credentialReferences.every((ref) => typeof ref === 'string' && ref !== '')
    ) {
      return new Response(
        JSON.stringify({ error: 'invalid_request', message: 'Missing required fields' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Serialize the read→refresh→write critical section so concurrent refreshes
    // for the same user cannot both consume the same one-time-use refresh token.
    return this.withRefreshLock(() =>
      this.runRefresh(refreshToken, userId, credentialReferences, signal)
    );
  }

  /**
   * The serialized critical section. Reads the candidate credentials, decides
   * match/grace/stale, optionally refreshes against OpenAI, and persists the
   * rotated tokens. MUST run under `withRefreshLock` — reading the credentials
   * here (rather than before acquiring the lock) is what lets a queued
   * concurrent request observe the rotated token and take the grace-window path
   * instead of replaying the consumed token against OpenAI.
   *
   * Candidates are only the credentials the calling workspace's runs were seeded
   * with (`resolveRunAgentCredentialReferences`). The one to serve is chosen by
   * possession: the credential whose stored refresh_token the caller presented,
   * else the credential that token was recently rotated out of. With no proof of
   * possession, a single candidate gets short-lived tokens and several get none,
   * because nothing says which account the caller is on.
   */
  private async runRefresh(
    refreshToken: string,
    userId: string,
    credentialReferences: string[],
    signal: AbortSignal
  ): Promise<Response> {
    // The lock deadline may have passed while this request waited for the mutex.
    // Nothing has been consumed yet, so stop here (the caller gets 504).
    throwIfLockExpired(signal);

    // Derive encryption key from DO env (not from caller).
    const encryptionKey = getCredentialEncryptionKey(this.env);

    const { candidates, readFailure } = await loadRefreshCandidates(
      this.env.DATABASE,
      encryptionKey,
      userId,
      credentialReferences
    );
    if (candidates.length === 0) {
      if (readFailure) {
        return new Response(JSON.stringify({ error: 'internal_error', message: readFailure }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'refresh_token_invalidated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const match = candidates.find((c) => c.identity.refreshToken === refreshToken);
    if (!match) {
      // Stale token path — the caller's refresh token doesn't match what's in DB.
      // Check if it was recently rotated (grace window) before rejecting.
      const graceWindowMs = this.getGraceWindowMs();
      const graceCandidate = await this.findGraceCandidate(refreshToken, candidates, graceWindowMs);

      if (graceCandidate) {
        // The caller's token was rotated out of THIS credential recently — this is
        // a legitimate concurrent session that started before the rotation. Return
        // the full token set so the session can continue operating without re-auth.
        //
        // Deliberately NOT rate-limited: reaching here requires presenting a
        // refresh_token that was valid within the grace window, so the successor
        // token returned is the legitimate rotation handoff the caller is already
        // entitled to — not an escalation. Counting these calls would re-consume
        // the OpenAI-refresh budget for responses that never hit OpenAI, which is
        // exactly the multi-workspace concurrent re-sync path whose budget
        // exhaustion produced the original 429. The enforceRateLimit() below
        // guards only the real upstream-refresh path.
        log.info('codex_refresh.grace_window_hit', {
          userId,
          credentialReference: graceCandidate.credential.reference,
          graceWindowMs,
        });
        return this.createTokenResponse({
          accessToken: graceCandidate.identity.accessToken ?? null,
          refreshToken: graceCandidate.identity.refreshToken ?? null,
          idToken: graceCandidate.identity.idToken ?? null,
        });
      }

      // Short-lived tokens without proof of possession only when the run recorded
      // exactly one credential and it is still readable: if a second recorded one
      // was dropped (inactive, unreadable), the caller may be on that account.
      // And only for a cc credential: a legacy row can be rewritten in place with
      // another account's secret (Replace, Make default), so its current tokens
      // may not belong to the account this run started with.
      const [only] = candidates;
      if (
        credentialReferences.length !== 1 ||
        candidates.length !== 1 ||
        !only ||
        only.credential.table !== 'cc_credentials'
      ) {
        log.warn('codex_refresh.stale_token_no_tokens', {
          userId,
          candidateCount: candidates.length,
          referenceCount: credentialReferences.length,
        });
        return new Response(JSON.stringify({ error: 'refresh_token_invalidated' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Outside grace window — CRITICAL #1 still applies.
      // The caller did NOT prove possession of the current refresh token AND
      // the token is too old to be from a legitimate concurrent session. Do NOT
      // return the refresh_token. Return short-lived tokens only, of the one
      // credential this workspace's run was seeded with.
      log.warn('codex_refresh.stale_token_rejected', {
        userId,
        credentialReference: only.credential.reference,
        graceWindowMs,
      });
      return this.createTokenResponse({
        accessToken: only.identity.accessToken ?? null,
        idToken: only.identity.idToken ?? null,
        stale: true,
      });
    }

    const credential = match.credential;
    const storedAuth = match.auth;
    const storedRefreshToken = match.identity.refreshToken;

    // Atomic per-credential rate limit (MEDIUM #5) — DO state is strongly
    // consistent, so increments cannot race the way KV read-modify-write can.
    // Enforced HERE (only on the real-refresh path) so cached grace-window and
    // stale-credential responses above do NOT consume budget — those never hit
    // OpenAI and must not contribute to the rate limit that guards real upstream
    // refreshes.
    const rateLimitResult = await this.enforceRateLimit(credential.reference);
    if (!rateLimitResult.allowed) {
      const retryAfter = Math.max(1, rateLimitResult.resetAt - Math.floor(Date.now() / 1000));
      log.warn('codex_refresh.rate_limited', { userId });
      return new Response(
        JSON.stringify({ error: 'rate_limit_exceeded', message: 'Too many refresh requests' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': retryAfter.toString(),
          },
        }
      );
    }

    // Last point before the one-time-use token is spent at OpenAI.
    throwIfLockExpired(signal);

    // Token matches — forward to OpenAI for a real refresh.
    const upstreamUrl = this.env.CODEX_REFRESH_UPSTREAM_URL || DEFAULT_UPSTREAM_URL;
    const upstreamTimeout =
      parseInt(this.env.CODEX_REFRESH_UPSTREAM_TIMEOUT_MS || '', 10) || DEFAULT_UPSTREAM_TIMEOUT_MS;

    // Use the lock-level signal for the upstream fetch, with a tighter upstream-specific timeout.
    const upstreamController = new AbortController();
    const upstreamTimeoutId = setTimeout(() => upstreamController.abort(), upstreamTimeout);
    // If the lock-level signal fires, also abort the upstream fetch.
    const onLockAbort = () => upstreamController.abort();
    signal.addEventListener('abort', onLockAbort);

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: this.env.CODEX_CLIENT_ID || DEFAULT_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
        signal: upstreamController.signal,
      });
    } catch (err) {
      // Re-throw lock-level aborts so the outer handler catches them.
      if (signal.aborted) {
        throw err;
      }
      const isAbort = err instanceof Error && err.name === 'AbortError';
      return new Response(
        JSON.stringify({ error: isAbort ? 'upstream_timeout' : 'upstream_error' }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    } finally {
      clearTimeout(upstreamTimeoutId);
      signal.removeEventListener('abort', onLockAbort);
    }

    if (!upstreamResponse.ok) {
      const { safeError, upstreamErrorCode, upstreamErrorMessage } =
        await readSafeUpstreamError(upstreamResponse);
      const upstreamContentType = upstreamResponse.headers.get('Content-Type');
      // Diagnostic: log OpenAI's structured rejection reason so we can
      // distinguish a revoked/expired/consumed refresh_token (e.g.
      // `refresh_token_invalidated`) from a transient upstream fault or an
      // edge/WAF block. Only the parsed OAuth/OpenAI error code + message are
      // logged — never the raw body — so a refresh token can never leak.
      log.warn('codex_refresh.upstream_rejected', {
        userId,
        credentialReference: credential.reference,
        status: upstreamResponse.status,
        upstreamContentType,
        upstreamErrorCode,
        upstreamErrorMessage,
      });
      return new Response(JSON.stringify(safeError), {
        status: upstreamResponse.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // OpenAI has rotated the token: from here the successor is persisted even if
    // the lock deadline passed meanwhile. Discarding it would leave storage holding
    // a consumed token that no later refresh could use.

    // Parse new tokens from OpenAI response.
    const newTokens = await readResponseJson(
      upstreamResponse,
      v.record(v.string(), v.unknown()),
      'codex-refresh.tokens'
    );

    // Scope validation (MEDIUM #6) — fail closed by default. Disable with
    // CODEX_EXPECTED_SCOPES="" only when explicitly opting out of validation.
    const scopeResult = this.validateUpstreamScopes(newTokens, userId);
    if (!scopeResult.ok) {
      return new Response(
        JSON.stringify({ error: 'upstream_unexpected_scope', message: scopeResult.reason }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Update the stored auth.json with new tokens.
    if (!storedAuth.tokens || typeof storedAuth.tokens !== 'object') {
      storedAuth.tokens = {};
    }
    const authTokens = storedAuth.tokens as Record<string, string>;
    if (typeof newTokens.access_token === 'string')
      authTokens.access_token = newTokens.access_token;
    if (typeof newTokens.refresh_token === 'string')
      authTokens.refresh_token = newTokens.refresh_token;
    if (typeof newTokens.id_token === 'string') authTokens.id_token = newTokens.id_token;
    authTokens.last_refresh = new Date().toISOString();

    // Re-encrypt with fresh IV and write back into exactly the credential that
    // was read: compare-and-set on its ciphertext, then rotate every other stored
    // copy of that same credential generation (legacy row or cc row). If the row
    // changed while OpenAI was answering (replaced, switched, deactivated), the
    // write is skipped everywhere rather than landing on another account.
    const updatedAuthJson = JSON.stringify(storedAuth);
    const { ciphertext, iv } = await encrypt(updatedAuthJson, encryptionKey);
    const write = await writeRotatedAgentCredential(this.env.DATABASE, {
      userId,
      agentType: CODEX_AGENT_TYPE,
      credentialKind: CODEX_CREDENTIAL_KIND,
      target: credential,
      next: { encryptedToken: ciphertext, iv },
    });
    if (write.applied) {
      // Concurrent sessions still holding the old refresh token get this successor
      // through the grace path. The entry names every reference that now holds the
      // successor (the row and its mirrors) and the exact generation written, so it
      // stops applying once that row is replaced or rotated again. A lost CAS records
      // nothing: storage does not hold this successor.
      if (
        storedRefreshToken &&
        typeof newTokens.refresh_token === 'string' &&
        newTokens.refresh_token !== storedRefreshToken
      ) {
        await this.recordRotatedToken(
          storedRefreshToken,
          [credential.reference, ...write.mirroredReferences],
          await credentialGenerationFingerprint(ciphertext, iv)
        );
      }
      log.info('codex_refresh.rotation_stored', {
        userId,
        credentialReference: credential.reference,
        mirroredRows: write.mirroredRows,
      });
    } else {
      log.warn('codex_refresh.rotation_cas_lost', {
        userId,
        credentialReference: credential.reference,
      });
    }

    // Return the new tokens to Codex.
    return this.createTokenResponse({
      accessToken: typeof newTokens.access_token === 'string' ? newTokens.access_token : null,
      refreshToken: typeof newTokens.refresh_token === 'string' ? newTokens.refresh_token : null,
      idToken: typeof newTokens.id_token === 'string' ? newTokens.id_token : null,
    });
  }

  /**
   * Atomically increment the per-credential rate limit counter in DO storage.
   * Returns `{ allowed: false }` once the configured limit for the current
   * window is exceeded.
   *
   * Keyed by credential ID (not userId) so distinct credentials owned by the
   * same user — e.g. a project-scoped override and the user-scoped default —
   * have independent budgets. A loop on one credential must not exhaust the
   * budget for the user's other credentials.
   */
  private async enforceRateLimit(
    credentialId: string
  ): Promise<{ allowed: boolean; resetAt: number }> {
    const limit =
      parseInt(this.env.RATE_LIMIT_CODEX_REFRESH_PER_HOUR || '', 10) || DEFAULT_RATE_LIMIT;
    const windowSeconds =
      parseInt(this.env.RATE_LIMIT_CODEX_REFRESH_WINDOW_SECONDS || '', 10) ||
      DEFAULT_RATE_WINDOW_SECONDS;
    const now = Math.floor(Date.now() / 1000);
    const currentWindowStart = Math.floor(now / windowSeconds) * windowSeconds;
    const resetAt = currentWindowStart + windowSeconds;

    const storageKey = `rate-limit:${credentialId}`;
    const stored = (await this.ctx.storage.get<RateLimitState>(storageKey)) ?? null;
    const state: RateLimitState =
      stored && stored.windowStart === currentWindowStart
        ? stored
        : { windowStart: currentWindowStart, count: 0 };

    if (state.count >= limit) {
      return { allowed: false, resetAt };
    }

    state.count += 1;
    await this.ctx.storage.put(storageKey, state);
    return { allowed: true, resetAt };
  }

  /**
   * Validate scopes in the upstream token response.
   *
   * Returns { ok: false } when scopes don't match the allowlist. The caller blocks
   * by default.
   *
   * Override allowlist with CODEX_EXPECTED_SCOPES (comma-separated). Empty
   * string disables validation entirely.
   */
  private validateUpstreamScopes(
    tokens: Record<string, unknown>,
    userId: string
  ): { ok: true } | { ok: false; reason: string } {
    const scope = tokens.scope;
    if (scope === undefined || scope === null) {
      // No scope in response — common for legacy tokens. Nothing to validate.
      return { ok: true };
    }

    if (typeof scope !== 'string') {
      log.warn('codex_refresh.scope_validation_nonstring', {
        userId,
        scopeType: typeof scope,
      });
      return { ok: false, reason: 'Upstream scope is not a string' };
    }

    // Read configured scopes. Distinguish "env var unset" (use default) from
    // "env var set to empty string" (validation disabled).
    const expectedScopesEnv = this.env.CODEX_EXPECTED_SCOPES;
    const rawScopes = expectedScopesEnv === undefined ? DEFAULT_EXPECTED_SCOPES : expectedScopesEnv;
    if (rawScopes === '') {
      // Explicitly disabled.
      return { ok: true };
    }

    const expectedScopes = new Set(
      rawScopes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
    const returnedScopes = scope.split(' ').filter(Boolean);
    const unexpected = returnedScopes.filter((s) => !expectedScopes.has(s));

    if (unexpected.length > 0) {
      log.warn('codex_refresh.unexpected_scopes_blocked', {
        userId,
        expectedScopes: [...expectedScopes].join(','),
        returnedScopes: returnedScopes.join(' '),
        unexpectedScopes: unexpected.join(','),
      });
      return {
        ok: false,
        reason: `Upstream returned unexpected scope(s): ${unexpected.join(',')}`,
      };
    }

    return { ok: true };
  }

  /**
   * Hash a refresh token using SHA-256. We store hashes (not raw tokens) in DO
   * storage so that a storage compromise doesn't leak old refresh tokens.
   */
  private async hashToken(token: string): Promise<string> {
    const data = new TextEncoder().encode(token);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Record a recently-rotated refresh token in DO storage. Called after a
   * successful upstream refresh replaces the stored token with a new one.
   * Keeps at most MAX_ROTATED_TOKEN_ENTRIES entries; prunes expired ones.
   */
  private async recordRotatedToken(
    oldRefreshToken: string,
    credentialReferences: string[],
    successorGeneration: string
  ): Promise<void> {
    const hash = await this.hashToken(oldRefreshToken);
    const now = Date.now();
    const graceWindowMs = this.getGraceWindowMs();
    const entries = await this.getRotatedTokenEntries();

    // Prune expired entries, then cap per credential so rotations of one pinned
    // account never evict another account's grace entry; across credentials the
    // list stays bounded by the grace window.
    let fresh = entries.filter((e) => now - e.rotatedAt < graceWindowMs);
    for (const credentialReference of credentialReferences) {
      const same = fresh.filter((e) => e.credentialReference === credentialReference);
      const kept = new Set(same.slice(-(MAX_ROTATED_TOKEN_ENTRIES - 1)));
      fresh = fresh.filter((e) => e.credentialReference !== credentialReference || kept.has(e));
      fresh.push({ tokenHash: hash, rotatedAt: now, credentialReference, successorGeneration });
    }

    await this.ctx.storage.put('rotated-tokens', fresh);
  }

  private getGraceWindowMs(): number {
    return parseInt(this.env.CODEX_REFRESH_GRACE_WINDOW_MS || '', 10) || DEFAULT_GRACE_WINDOW_MS;
  }

  private async getRotatedTokenEntries(): Promise<RotatedTokenEntry[]> {
    return (await this.ctx.storage.get<RotatedTokenEntry[]>('rotated-tokens')) ?? [];
  }

  private createTokenResponse({
    accessToken,
    refreshToken,
    idToken,
    stale,
  }: {
    accessToken: string | null;
    refreshToken?: string | null;
    idToken: string | null;
    stale?: boolean;
  }): Response {
    return new Response(
      JSON.stringify({
        access_token: accessToken,
        ...(refreshToken !== undefined ? { refresh_token: refreshToken } : {}),
        id_token: idToken,
        ...(stale ? { stale: true } : {}),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  private async findGraceCandidate(
    refreshToken: string,
    candidates: RefreshCandidate[],
    graceWindowMs: number
  ): Promise<RefreshCandidate | null> {
    const entries = await this.getRotatedTokenEntries();
    if (entries.length === 0) return null;
    const hash = await this.hashToken(refreshToken);
    const now = Date.now();
    for (const entry of entries) {
      if (entry.tokenHash !== hash || now - entry.rotatedAt >= graceWindowMs) continue;
      if (!entry.credentialReference || !entry.successorGeneration) continue;
      const candidate = candidates.find(
        (c) => c.credential.reference === entry.credentialReference
      );
      // The row must still hold exactly the generation this rotation wrote: a row
      // replaced with another account, or rotated again since, does not hand over
      // its current tokens to the holder of an old token.
      if (
        candidate &&
        (await credentialGenerationFingerprint(
          candidate.credential.encryptedToken,
          candidate.credential.iv
        )) === entry.successorGeneration
      ) {
        return candidate;
      }
    }
    return null;
  }
}

function throwIfLockExpired(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Lock timeout', 'AbortError');
}
