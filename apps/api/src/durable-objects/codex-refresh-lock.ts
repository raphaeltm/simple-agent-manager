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
import { maybeJsonRecord, readResponseJson } from '../lib/runtime-validation';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { decrypt, encrypt } from '../services/encryption';
import {
  type CodexAuthIdentity,
  loadRunAgentCredential,
  parseCodexAuth,
  type RunAgentCredential,
  writeRotatedAgentCredential,
} from '../services/run-agent-credential';
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
    // Derive encryption key from DO env (not from caller).
    const encryptionKey = getCredentialEncryptionKey(this.env);

    const { candidates, readFailure } = await this.loadCandidates(
      userId,
      credentialReferences,
      encryptionKey
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

      const [only] = candidates;
      if (candidates.length !== 1 || !only) {
        // No proof of which account the caller is on, and more than one account
        // this workspace could be using: hand out nothing.
        log.warn('codex_refresh.stale_token_ambiguous', {
          userId,
          candidateCount: candidates.length,
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
      // Parse and filter upstream error — only forward safe fields to prevent
      // information leakage (e.g., if OpenAI echoes back the refresh token).
      // OpenAI returns errors in TWO shapes: the flat OAuth2 form
      // `{ error, error_description }` and a nested form
      // `{ error: { code, message, type } }`. Parse both so the structured
      // diagnostic captures the rejection reason (e.g. `refresh_token_invalidated`,
      // which means the stored token was revoked at OpenAI — log out / re-login /
      // a sibling refresh consumed it — versus a transient upstream fault).
      const safeError: Record<string, string> = { error: 'upstream_error' };
      let upstreamErrorCode: string | null = null;
      let upstreamErrorMessage: string | null = null;
      const upstreamContentType = upstreamResponse.headers.get('Content-Type');
      let rawBody = '';
      try {
        rawBody = await upstreamResponse.text();
      } catch {
        // Body unreadable — leave rawBody empty.
      }
      try {
        const parsedRaw = JSON.parse(rawBody) as unknown;
        const parsed = maybeJsonRecord(parsedRaw);
        if (parsed && typeof parsed.error === 'string') {
          // Flat OAuth2 form.
          safeError.error = parsed.error;
          upstreamErrorCode = parsed.error;
          if (typeof parsed.error_description === 'string') {
            safeError.error_description = parsed.error_description;
            upstreamErrorMessage = parsed.error_description;
          }
        } else if (parsed && parsed.error && typeof parsed.error === 'object') {
          // OpenAI nested form: { error: { code, message, type } }.
          const nested = maybeJsonRecord(parsed.error);
          if (nested) {
            if (typeof nested.code === 'string') {
              safeError.error = nested.code;
              upstreamErrorCode = nested.code;
            }
            if (typeof nested.message === 'string') {
              safeError.error_description = nested.message;
              upstreamErrorMessage = nested.message;
            }
          }
        }
      } catch {
        // Non-JSON upstream response — use generic error.
      }
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

    // Check lock-level abort before writing to DB.
    if (signal.aborted) {
      throw new DOMException('Lock timeout', 'AbortError');
    }

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

    // Before updating tokens, record the old refresh_token in the grace window
    // so concurrent sessions holding it can still refresh successfully.
    if (
      storedRefreshToken &&
      typeof newTokens.refresh_token === 'string' &&
      newTokens.refresh_token !== storedRefreshToken
    ) {
      await this.recordRotatedToken(storedRefreshToken, credential.reference);
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
    credentialReference: string
  ): Promise<void> {
    const hash = await this.hashToken(oldRefreshToken);
    const now = Date.now();
    const graceWindowMs = this.getGraceWindowMs();
    const entries = await this.getRotatedTokenEntries();

    // Prune expired entries and add the new one. The cap applies per credential, so
    // rotations of one pinned account never evict another account's grace entry;
    // across credentials the list stays bounded by the grace window.
    const live = entries.filter((e) => now - e.rotatedAt < graceWindowMs);
    const sameCredential = live.filter((e) => e.credentialReference === credentialReference);
    const kept = new Set(sameCredential.slice(-(MAX_ROTATED_TOKEN_ENTRIES - 1)));
    const fresh = live.filter((e) => e.credentialReference !== credentialReference || kept.has(e));
    fresh.push({ tokenHash: hash, rotatedAt: now, credentialReference });

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

  /**
   * Read every candidate credential, skipping rows that are gone, inactive, or
   * unreadable. An inactive candidate is never replaced by another credential
   * (rule 28): a deactivated pin forces re-auth instead of falling back to the
   * user's default account.
   */
  private async loadCandidates(
    userId: string,
    credentialReferences: string[],
    encryptionKey: string
  ): Promise<{ candidates: RefreshCandidate[]; readFailure: string | null }> {
    let readFailure: string | null = null;
    const loaded = await Promise.all(
      credentialReferences.map(async (reference): Promise<RefreshCandidate | null> => {
        const credential = await loadRunAgentCredential(this.env.DATABASE, {
          userId,
          reference,
          agentType: CODEX_AGENT_TYPE,
          credentialKind: CODEX_CREDENTIAL_KIND,
        });
        if (!credential) {
          log.warn('codex_refresh.credential_not_found', {
            userId,
            credentialReference: reference,
          });
          return null;
        }
        if (!credential.isActive) {
          log.warn('codex_refresh.inactive_credential_no_fallback', {
            userId,
            credentialReference: reference,
          });
          return null;
        }
        let decrypted: string;
        try {
          decrypted = await decrypt(credential.encryptedToken, credential.iv, encryptionKey);
        } catch {
          readFailure ??= 'Failed to decrypt stored credential';
          log.error('codex_refresh.credential_decrypt_failed', {
            userId,
            credentialReference: reference,
          });
          return null;
        }
        const parsed = parseCodexAuth(decrypted);
        if (!parsed) {
          readFailure ??= 'Stored credential is not valid JSON';
          log.error('codex_refresh.credential_not_json', {
            userId,
            credentialReference: reference,
          });
          return null;
        }
        return { credential, auth: parsed.auth, identity: parsed.identity };
      })
    );
    const candidates = loaded.filter((c): c is RefreshCandidate => c !== null);
    return { candidates, readFailure };
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
    const hit = entries.find((e) => e.tokenHash === hash && now - e.rotatedAt < graceWindowMs);
    if (!hit?.credentialReference) return null;
    return candidates.find((c) => c.credential.reference === hit.credentialReference) ?? null;
  }
}

const CODEX_AGENT_TYPE = 'openai-codex';
const CODEX_CREDENTIAL_KIND = 'oauth-token';

interface RefreshCandidate {
  credential: RunAgentCredential;
  auth: Record<string, unknown>;
  identity: CodexAuthIdentity;
}
