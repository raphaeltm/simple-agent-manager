/**
 * CodexRefreshLock Durable Object — per-user serialization of Codex OAuth token refreshes.
 *
 * Keyed by userId. Prevents concurrent refresh requests from racing against OpenAI's
 * rotating refresh token — only one refresh against OpenAI happens at a time per user.
 * Second concurrent request detects stale token and returns latest from DB instead.
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
 *  - Project vs user fallback (HIGH #2): if `projectId` is supplied AND any project-scoped row
 *    exists for (userId, projectId) — active OR inactive — we do NOT fall back to the
 *    user-scoped row. An inactive project row means the user explicitly deactivated
 *    project-scope in favor of something else; rotating the user-scoped row would affect
 *    every other project inheriting it.
 *  - Rate limiting (MEDIUM #5): token-bucket state is held in DO storage (strongly consistent,
 *    atomic increments). KV read-modify-write is not safe for enforcement under concurrency.
 *  - Scope anomaly detection (MEDIUM #6, reworked): upstream scopes are compared against an
 *    allowlist of Codex OAuth scopes. Anomalies raise a durable diagnostic (persisted to the
 *    observability DB — Workers Logs are 1%-sampled) but NEVER discard the rotated tokens:
 *    by the time scopes are visible, OpenAI has already consumed the one-time-use refresh
 *    token, so refusing to persist would strand the whole token family (this exact
 *    block-and-discard behavior burned production credentials on 2026-07-11 and 2026-07-22 —
 *    see tasks/archive/2026-07-22-fix-codex-refresh-scope-gate-family-burn.md).
 *    Disable detection with CODEX_EXPECTED_SCOPES="".
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';

import { log } from '../lib/logger';
import { readResponseJson } from '../lib/runtime-validation';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { syncActiveAgentCredentialSecret } from '../services/composable-credentials/agent-sync';
import { decrypt, encrypt } from '../services/encryption';
import { persistError } from '../services/observability';
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

    const lockTimeout = parseInt(this.env.CODEX_REFRESH_LOCK_TIMEOUT_MS || '', 10) || DEFAULT_LOCK_TIMEOUT_MS;
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
      return new Response(
        JSON.stringify({ error: 'internal_error' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async handleRefresh(request: Request, signal: AbortSignal): Promise<Response> {
    const payload: RefreshRequestPayload = await request.json();
    const { refreshToken, userId, projectId } = payload;

    if (!refreshToken || !userId) {
      return new Response(
        JSON.stringify({ error: 'invalid_request', message: 'Missing required fields' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Serialize the read→refresh→write critical section so concurrent refreshes
    // for the same user cannot both consume the same one-time-use refresh token.
    return this.withRefreshLock(() =>
      this.runRefresh(refreshToken, userId, projectId ?? null, signal)
    );
  }

  /**
   * The serialized critical section. Reads the stored credential, decides
   * grace/stale/match, optionally refreshes against OpenAI, and persists the
   * rotated tokens. MUST run under `withRefreshLock` — reading the credential
   * here (rather than before acquiring the lock) is what lets a queued
   * concurrent request observe the rotated token and take the grace-window path
   * instead of replaying the consumed token against OpenAI.
   */
  private async runRefresh(
    refreshToken: string,
    userId: string,
    projectId: string | null,
    signal: AbortSignal
  ): Promise<Response> {
    // Derive encryption key from DO env (not from caller).
    const encryptionKey = getCredentialEncryptionKey(this.env);

    // Look up the stored credential — prefer project-scoped when projectId is set.
    const credential = await this.getStoredCredential(userId, projectId ?? null);
    if (!credential) {
      return new Response(
        JSON.stringify({ error: 'refresh_token_invalidated' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Decrypt the stored credential to get the current auth.json.
    let storedAuthJson: string;
    try {
      storedAuthJson = await decrypt(credential.encryptedToken, credential.iv, encryptionKey);
    } catch {
      return new Response(
        JSON.stringify({ error: 'internal_error', message: 'Failed to decrypt stored credential' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Parse the stored auth.json to extract the current refresh token.
    let storedAuth: Record<string, unknown>;
    try {
      storedAuth = JSON.parse(storedAuthJson);
    } catch {
      return new Response(
        JSON.stringify({ error: 'internal_error', message: 'Stored credential is not valid JSON' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const tokens = storedAuth.tokens as Record<string, string> | undefined;
    const storedRefreshToken = tokens?.refresh_token;

    if (refreshToken !== storedRefreshToken) {
      // Stale token path — the caller's refresh token doesn't match what's in DB.
      // Check if it was recently rotated (grace window) before rejecting.
      const graceWindowMs = this.getGraceWindowMs();
      const withinGrace = await this.isWithinGraceWindow(refreshToken, graceWindowMs);

      if (withinGrace) {
        // The caller's token was valid recently — this is a legitimate concurrent
        // session that started before the rotation. Return the full token set
        // so the session can continue operating without re-auth.
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
          graceWindowMs,
        });
        return this.createTokenResponse({
          accessToken: tokens?.access_token ?? null,
          refreshToken: tokens?.refresh_token ?? null,
          idToken: tokens?.id_token ?? null,
        });
      }

      // Outside grace window — CRITICAL #1 still applies.
      // The caller did NOT prove possession of the current refresh token AND
      // the token is too old to be from a legitimate concurrent session. Do NOT
      // return the refresh_token. Return short-lived tokens only.
      log.warn('codex_refresh.stale_token_rejected', {
        userId,
        graceWindowMs,
      });
      return this.createTokenResponse({
        accessToken: tokens?.access_token ?? null,
        idToken: tokens?.id_token ?? null,
        stale: true,
      });
    }

    // Atomic per-credential rate limit (MEDIUM #5) — DO state is strongly
    // consistent, so increments cannot race the way KV read-modify-write can.
    // Enforced HERE (only on the real-refresh path) so cached grace-window and
    // stale-credential responses above do NOT consume budget — those never hit
    // OpenAI and must not contribute to the rate limit that guards real upstream
    // refreshes.
    const rateLimitResult = await this.enforceRateLimit(credential.id);
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
    const upstreamTimeout = parseInt(this.env.CODEX_REFRESH_UPSTREAM_TIMEOUT_MS || '', 10) || DEFAULT_UPSTREAM_TIMEOUT_MS;

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
        const parsed = JSON.parse(rawBody) as Record<string, unknown>;
        if (typeof parsed.error === 'string') {
          // Flat OAuth2 form.
          safeError.error = parsed.error;
          upstreamErrorCode = parsed.error;
          if (typeof parsed.error_description === 'string') {
            safeError.error_description = parsed.error_description;
            upstreamErrorMessage = parsed.error_description;
          }
        } else if (parsed.error && typeof parsed.error === 'object') {
          // OpenAI nested form: { error: { code, message, type } }.
          const nested = parsed.error as Record<string, unknown>;
          if (typeof nested.code === 'string') {
            safeError.error = nested.code;
            upstreamErrorCode = nested.code;
          }
          if (typeof nested.message === 'string') {
            safeError.error_description = nested.message;
            upstreamErrorMessage = nested.message;
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
        credentialId: credential.id,
        status: upstreamResponse.status,
        upstreamContentType,
        upstreamErrorCode,
        upstreamErrorMessage,
      });
      // Family-fatal rejections mean the stored credential is dead at OpenAI
      // and every future refresh will fail until the user re-links. Persist a
      // durable diagnostic — Workers Logs are 1%-sampled, so the warn above is
      // effectively invisible in production (this exact blindness delayed the
      // 2026-07-22 incident diagnosis).
      if (
        upstreamErrorCode === 'refresh_token_reused' ||
        upstreamErrorCode === 'refresh_token_invalidated' ||
        upstreamErrorCode === 'refresh_token_expired'
      ) {
        await this.persistAuthDiagnostic('codex_refresh.family_fatal_rejection', userId, {
          credentialId: credential.id,
          status: upstreamResponse.status,
          upstreamErrorCode,
          upstreamErrorMessage,
        });
      }
      return new Response(JSON.stringify(safeError), {
        status: upstreamResponse.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // From this point the upstream exchange has SUCCEEDED: OpenAI has consumed
    // the one-time-use refresh token and issued its successor. The rotation
    // MUST be persisted no matter what — any path that discards it (an abort,
    // a validation gate) strands the token family permanently. This is why
    // there is deliberately NO lock-abort check between here and the DB writes,
    // and why scope anomalies are detected only AFTER persistence.
    const newTokens = await readResponseJson(upstreamResponse, v.record(v.string(), v.unknown()), 'codex-refresh.tokens');

    // Before updating tokens, record the old refresh_token in the grace window
    // so concurrent sessions holding it can still refresh successfully.
    if (storedRefreshToken && typeof newTokens.refresh_token === 'string' && newTokens.refresh_token !== storedRefreshToken) {
      await this.recordRotatedToken(storedRefreshToken);
    }

    // Update the stored auth.json with new tokens.
    if (!storedAuth.tokens || typeof storedAuth.tokens !== 'object') {
      storedAuth.tokens = {};
    }
    const authTokens = storedAuth.tokens as Record<string, string>;
    if (typeof newTokens.access_token === 'string') authTokens.access_token = newTokens.access_token;
    if (typeof newTokens.refresh_token === 'string') authTokens.refresh_token = newTokens.refresh_token;
    if (typeof newTokens.id_token === 'string') authTokens.id_token = newTokens.id_token;
    authTokens.last_refresh = new Date().toISOString();

    // Re-encrypt with fresh IV and update the database.
    const updatedAuthJson = JSON.stringify(storedAuth);
    const { ciphertext, iv } = await encrypt(updatedAuthJson, encryptionKey);

    const db = this.env.DATABASE;
    await db
      .prepare('UPDATE credentials SET encrypted_token = ?, iv = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .bind(ciphertext, iv, credential.id)
      .run();

    // CORE FIX (dual-write): mirror the rotated token into the composable-
    // credentials store. The legacy UPDATE above only touches the `credentials`
    // table; workspaces seed ~/.codex/auth.json from the `cc_credentials`
    // snapshot. Without this sync, cc_credentials stays frozen at backfill time,
    // fresh workspaces present a stale refresh_token, and Codex enters a
    // 401 → re-refresh loop that exceeds the rate limit → 429.
    //
    // Reuse the same ciphertext/iv just persisted to the legacy row, and pass
    // the credential row's OWN scope (scopeProjectId) — NOT the workspace's —
    // so the matching active cc_credentials row is updated (mirrors runtime.ts).
    try {
      const ccRowsUpdated = await syncActiveAgentCredentialSecret(db, {
        userId,
        projectId: credential.scopeProjectId ?? undefined,
        agentType: 'openai-codex',
        credentialKind: 'oauth-token',
        encryptedToken: ciphertext,
        iv,
      });
      if (ccRowsUpdated === 0) {
        // The legacy row rotated but no matching active cc_credentials row was
        // found to mirror into. This is the exact silent desync this fix exists
        // to prevent, so surface it (no token material) for diagnosis.
        log.warn('codex_refresh.cc_sync_no_row', {
          userId,
          credentialId: credential.id,
          scopeProjectId: credential.scopeProjectId ?? null,
        });
      }
    } catch (err) {
      // Never let a cc_credentials sync failure break the refresh — the legacy
      // row is already updated and the caller has working tokens. Log without
      // any token material so the desync is diagnosable.
      log.error('codex_refresh.cc_sync_failed', {
        userId,
        credentialId: credential.id,
        message: err instanceof Error ? err.message : 'unknown',
      });
    }

    // Scope anomaly detection (MEDIUM #6, alert-only) — runs AFTER persistence.
    // The rotation is already durable; an unexpected scope is provider drift or
    // an allowlist that lags codex's login scopes, and the correct response is a
    // loud durable alert, never discarding tokens the upstream already rotated.
    const scopeFinding = this.detectUnexpectedScopes(newTokens, userId);
    if (scopeFinding) {
      log.error('codex_refresh.unexpected_scopes_detected', {
        userId,
        credentialId: credential.id,
        ...scopeFinding,
      });
      await this.persistAuthDiagnostic('codex_refresh.unexpected_scopes_detected', userId, {
        credentialId: credential.id,
        ...scopeFinding,
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
  private async enforceRateLimit(credentialId: string): Promise<{ allowed: boolean; resetAt: number }> {
    const limit = parseInt(this.env.RATE_LIMIT_CODEX_REFRESH_PER_HOUR || '', 10) || DEFAULT_RATE_LIMIT;
    const windowSeconds = parseInt(this.env.RATE_LIMIT_CODEX_REFRESH_WINDOW_SECONDS || '', 10) || DEFAULT_RATE_WINDOW_SECONDS;
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
   * Detect unexpected scopes in the upstream token response (alert-only).
   *
   * Returns a finding describing the anomaly, or null when the scopes conform
   * (or detection is disabled). The caller persists a durable diagnostic for
   * findings — it MUST NOT discard the rotated tokens: by the time the scopes
   * are visible, the upstream has already consumed the one-time-use refresh
   * token, so refusing to persist would strand the token family (the 2026-07
   * Codex auth incidents).
   *
   * Override allowlist with CODEX_EXPECTED_SCOPES (comma-separated). Empty
   * string disables detection entirely.
   */
  private detectUnexpectedScopes(
    tokens: Record<string, unknown>,
    userId: string
  ): { expectedScopes: string; returnedScopes: string; unexpectedScopes: string } | null {
    const scope = tokens.scope;
    if (scope === undefined || scope === null) {
      // No scope in response — common for legacy tokens. Nothing to detect.
      return null;
    }

    // Read configured scopes. Distinguish "env var unset" (use default) from
    // "env var set to empty string" (detection disabled).
    const expectedScopesEnv = this.env.CODEX_EXPECTED_SCOPES;
    const rawScopes =
      expectedScopesEnv === undefined
        ? DEFAULT_EXPECTED_SCOPES
        : expectedScopesEnv;
    if (rawScopes === '') {
      // Explicitly disabled.
      return null;
    }

    if (typeof scope !== 'string') {
      log.warn('codex_refresh.scope_validation_nonstring', {
        userId,
        scopeType: typeof scope,
      });
      return {
        expectedScopes: rawScopes,
        returnedScopes: `<non-string:${typeof scope}>`,
        unexpectedScopes: `<non-string:${typeof scope}>`,
      };
    }

    const expectedScopes = new Set(rawScopes.split(',').map((s) => s.trim()).filter(Boolean));
    const returnedScopes = scope.split(' ').filter(Boolean);
    const unexpected = returnedScopes.filter((s) => !expectedScopes.has(s));

    if (unexpected.length > 0) {
      return {
        expectedScopes: [...expectedScopes].join(','),
        returnedScopes: returnedScopes.join(' '),
        unexpectedScopes: unexpected.join(','),
      };
    }

    return null;
  }

  /**
   * Persist a durable auth diagnostic to the observability database.
   *
   * Workers Logs are head-sampled (1% in production), so log lines alone are
   * effectively invisible for low-volume critical events like family-fatal
   * refresh rejections. `persistError` is itself fail-silent; the optional
   * binding guard keeps unit tests and minimal envs working. Never include
   * token material in `context`.
   */
  private async persistAuthDiagnostic(
    message: string,
    userId: string,
    context: Record<string, unknown>
  ): Promise<void> {
    const observabilityDb = this.env.OBSERVABILITY_DATABASE;
    if (!observabilityDb) return;
    await persistError(observabilityDb, {
      source: 'api',
      level: 'error',
      message,
      context,
      userId,
    });
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
  private async recordRotatedToken(oldRefreshToken: string): Promise<void> {
    const hash = await this.hashToken(oldRefreshToken);
    const now = Date.now();
    const graceWindowMs = this.getGraceWindowMs();
    const entries = await this.getRotatedTokenEntries();

    // Prune expired entries and add the new one.
    const fresh = entries
      .filter((e) => now - e.rotatedAt < graceWindowMs)
      .slice(-(MAX_ROTATED_TOKEN_ENTRIES - 1));
    fresh.push({ tokenHash: hash, rotatedAt: now });

    await this.ctx.storage.put('rotated-tokens', fresh);
  }

  /**
   * Check whether the given refresh token was rotated out within the grace window.
   * Returns true if the token hash matches a recently-rotated entry.
   */
  private async isWithinGraceWindow(
    refreshToken: string,
    graceWindowMs: number
  ): Promise<boolean> {
    const entries = await this.getRotatedTokenEntries();
    if (entries.length === 0) return false;

    const hash = await this.hashToken(refreshToken);
    const now = Date.now();

    return entries.some(
      (e) => e.tokenHash === hash && now - e.rotatedAt < graceWindowMs
    );
  }

  private getGraceWindowMs(): number {
    return (
      parseInt(this.env.CODEX_REFRESH_GRACE_WINDOW_MS || '', 10) ||
      DEFAULT_GRACE_WINDOW_MS
    );
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
   * Look up the active openai-codex oauth-token credential for the given user.
   *
   * HIGH #2 fix: when `projectId` is supplied, we look for a project-scoped row first.
   *  - Active project row found → use it.
   *  - Inactive project row found (or any row exists for the project) → return null.
   *    We do NOT fall back to user-scoped, because an inactive row indicates the user
   *    explicitly deactivated this credential (e.g., via `autoActivate: true` on
   *    another project row). Rotating the user-scoped row would change the credential
   *    for every other project inheriting it.
   *  - No project row at all → fall back to the user-scoped row (preserves the
   *    inheritance model — a project without its own override inherits the user default).
   */
  private async getStoredCredential(
    userId: string,
    projectId: string | null
  ): Promise<{ id: string; encryptedToken: string; iv: string; scopeProjectId: string | null } | null> {
    const db = this.env.DATABASE;

    if (projectId) {
      // Fetch ANY project-scoped row (active or inactive) to decide fallback behavior.
      const projectAny = await db
        .prepare(
          `SELECT id, encrypted_token, iv, is_active FROM credentials
           WHERE user_id = ? AND project_id = ? AND credential_type = 'agent-api-key'
             AND agent_type = 'openai-codex' AND credential_kind = 'oauth-token'
           LIMIT 1`
        )
        .bind(userId, projectId)
        .first<{ id: string; encrypted_token: string; iv: string; is_active: number }>();

      if (projectAny) {
        if (projectAny.is_active === 1) {
          return {
            id: projectAny.id,
            encryptedToken: projectAny.encrypted_token,
            iv: projectAny.iv,
            // Scope of the matched row — used to mirror the rotation into the
            // correct cc_credentials row (project-scoped, not workspace-scoped).
            scopeProjectId: projectId,
          };
        }
        // Project-scoped row exists but is inactive — do NOT fall back.
        // User explicitly deactivated; refusing forces re-auth at project scope.
        log.warn('codex_refresh.inactive_project_credential_no_fallback', {
          userId,
          projectId,
        });
        return null;
      }
    }

    const result = await db
      .prepare(
        `SELECT id, encrypted_token, iv FROM credentials
         WHERE user_id = ? AND project_id IS NULL AND credential_type = 'agent-api-key'
           AND agent_type = 'openai-codex' AND credential_kind = 'oauth-token'
           AND is_active = 1
         LIMIT 1`
      )
      .bind(userId)
      .first<{ id: string; encrypted_token: string; iv: string }>();

    if (!result) return null;
    // User-scoped fallback row — its scope is null (no project override).
    return { id: result.id, encryptedToken: result.encrypted_token, iv: result.iv, scopeProjectId: null };
  }
}
