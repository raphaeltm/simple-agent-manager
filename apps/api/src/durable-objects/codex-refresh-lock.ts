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
 *  - Stale-refresh branch (CRITICAL #1): NEVER returns `refresh_token`. A caller that submits
 *    a non-matching refresh token did not prove possession of the current one, so we must not
 *    hand it out. We do return the short-lived `access_token` so a legitimate concurrent caller
 *    can continue operating without a full re-auth.
 *  - Project vs user fallback (HIGH #2): if `projectId` is supplied AND any project-scoped row
 *    exists for (userId, projectId) — active OR inactive — we do NOT fall back to the
 *    user-scoped row. An inactive project row means the user explicitly deactivated
 *    project-scope in favor of something else; rotating the user-scoped row would affect
 *    every other project inheriting it.
 *  - Rate limiting (MEDIUM #5): token-bucket state is held in DO storage (strongly consistent,
 *    atomic increments). KV read-modify-write is not safe for enforcement under concurrency.
 *  - Scope validation (MEDIUM #6): enabled by default with a conservative allowlist of Codex
 *    OAuth scopes. Unexpected scopes block the refresh with 502 instead of a warn-only log.
 */
import { DurableObject } from 'cloudflare:workers';

import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { decrypt, encrypt } from '../services/encryption';

interface RefreshRequestPayload {
  /** The refresh token sent by Codex. */
  refreshToken: string;
  /** The userId to look up credentials for. */
  userId: string;
  /**
   * Optional projectId — when set, the DO prefers the project-scoped credential
   * row. Preserves scope when rotating OAuth tokens so a project-scoped credential
   * doesn't collapse to user-scoped.
   */
  projectId?: string | null;
}

interface CodexRefreshEnv {
  DATABASE: D1Database;
  ENCRYPTION_KEY: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  CODEX_REFRESH_UPSTREAM_URL?: string;
  CODEX_REFRESH_UPSTREAM_TIMEOUT_MS?: string;
  CODEX_REFRESH_LOCK_TIMEOUT_MS?: string;
  CODEX_CLIENT_ID?: string;
  /**
   * Comma-separated OAuth scopes that the Codex refresh upstream is allowed to return.
   * Empty string disables scope validation. Unset uses DEFAULT_EXPECTED_SCOPES.
   */
  CODEX_EXPECTED_SCOPES?: string;
  /**
   * Rate limit: max refresh requests per user per window. Defaults to 30.
   */
  RATE_LIMIT_CODEX_REFRESH_PER_HOUR?: string;
  /**
   * Rate limit window in seconds. Defaults to 3600 (1 hour).
   */
  RATE_LIMIT_CODEX_REFRESH_WINDOW_SECONDS?: string;
}

const DEFAULT_UPSTREAM_URL = 'https://auth.openai.com/oauth/token';
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
/**
 * Default OpenAI OAuth client_id for Codex.
 * Override via CODEX_CLIENT_ID Worker secret.
 * This is a public client_id registered with OpenAI — not a secret.
 */
const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/**
 * Default expected scopes for the Codex OAuth refresh flow. OpenAI's Codex
 * OAuth grants typically include `openid profile email offline_access` — any
 * upstream response containing additional/unknown scopes is treated as a
 * potential scope escalation or provider drift and blocked with 502.
 *
 * Override via CODEX_EXPECTED_SCOPES (comma-separated). Setting the env var
 * to an empty string disables validation.
 */
const DEFAULT_EXPECTED_SCOPES = 'openid,profile,email,offline_access';
const DEFAULT_RATE_LIMIT = 30;
const DEFAULT_RATE_WINDOW_SECONDS = 3600;

interface RateLimitState {
  /** Start of the current window in unix seconds. */
  windowStart: number;
  /** Count of requests in the current window. */
  count: number;
}

export class CodexRefreshLock extends DurableObject<CodexRefreshEnv> {
  /**
   * Handle an incoming refresh request. The DO's single-threaded execution model
   * guarantees that only one request is processed at a time per userId instance,
   * providing the per-user lock without explicit mutex logic.
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

    // Atomic per-user rate limit (MEDIUM #5) — DO state is strongly consistent,
    // so increments cannot race the way KV read-modify-write can.
    const rateLimitResult = await this.enforceRateLimit();
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
      // CRITICAL #1 fix: stale token path.
      // Another workspace (owned by the same user) rotated the refresh token
      // before this caller's request arrived. The caller did NOT prove possession
      // of the current refresh token, so we MUST NOT return it — doing so would
      // allow any workspace with a stolen/expired refresh token to obtain the
      // current rotating credential.
      //
      // We still return the short-lived `access_token` and `id_token` so a
      // concurrent legitimate caller can continue operating. The caller can
      // obtain a new refresh token only via a full re-auth flow.
      return new Response(
        JSON.stringify({
          access_token: tokens?.access_token ?? null,
          id_token: tokens?.id_token ?? null,
          // refresh_token intentionally omitted (CRITICAL #1)
          stale: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
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
      let safeError: Record<string, string> = { error: 'upstream_error' };
      try {
        const parsed = await upstreamResponse.json() as Record<string, unknown>;
        if (typeof parsed.error === 'string') safeError.error = parsed.error;
        if (typeof parsed.error_description === 'string') {
          safeError = { ...safeError, error_description: parsed.error_description };
        }
      } catch {
        // Non-JSON upstream response — use generic error
      }
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
    const newTokens: Record<string, unknown> = await upstreamResponse.json();

    // Scope validation (MEDIUM #6) — block instead of warn-only when upstream returns
    // unexpected scopes. A scope change signals either provider drift or an escalation
    // attempt; either way we refuse to store the new tokens and return 502 so the
    // caller stays on the previous (validated) credential.
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

    // Return the new tokens to Codex.
    return new Response(
      JSON.stringify({
        access_token: (typeof newTokens.access_token === 'string' ? newTokens.access_token : null),
        refresh_token: (typeof newTokens.refresh_token === 'string' ? newTokens.refresh_token : null),
        id_token: (typeof newTokens.id_token === 'string' ? newTokens.id_token : null),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  /**
   * Atomically increment the per-user rate limit counter in DO storage.
   * Returns `{ allowed: false }` once the configured limit for the current
   * window is exceeded.
   */
  private async enforceRateLimit(): Promise<{ allowed: boolean; resetAt: number }> {
    const limit = parseInt(this.env.RATE_LIMIT_CODEX_REFRESH_PER_HOUR || '', 10) || DEFAULT_RATE_LIMIT;
    const windowSeconds = parseInt(this.env.RATE_LIMIT_CODEX_REFRESH_WINDOW_SECONDS || '', 10) || DEFAULT_RATE_WINDOW_SECONDS;
    const now = Math.floor(Date.now() / 1000);
    const currentWindowStart = Math.floor(now / windowSeconds) * windowSeconds;
    const resetAt = currentWindowStart + windowSeconds;

    const stored = (await this.ctx.storage.get<RateLimitState>('rate-limit')) ?? null;
    const state: RateLimitState =
      stored && stored.windowStart === currentWindowStart
        ? stored
        : { windowStart: currentWindowStart, count: 0 };

    if (state.count >= limit) {
      return { allowed: false, resetAt };
    }

    state.count += 1;
    await this.ctx.storage.put('rate-limit', state);
    return { allowed: true, resetAt };
  }

  /**
   * Validate scopes in the upstream token response.
   *
   * Default behavior (MEDIUM #6 fix): enforce a conservative allowlist derived from
   * known Codex OAuth flow scopes. Unexpected scopes cause the refresh to fail with
   * 502 — the previous token remains valid so the caller can continue operating
   * until an admin investigates.
   *
   * Override with CODEX_EXPECTED_SCOPES (comma-separated). Empty string disables
   * validation entirely (escape hatch for provider rollouts that add new scopes).
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
    const rawScopes =
      expectedScopesEnv === undefined
        ? DEFAULT_EXPECTED_SCOPES
        : expectedScopesEnv;
    if (rawScopes === '') {
      // Explicitly disabled.
      return { ok: true };
    }

    const expectedScopes = new Set(rawScopes.split(',').map((s) => s.trim()).filter(Boolean));
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
  ): Promise<{ id: string; encryptedToken: string; iv: string } | null> {
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
    return { id: result.id, encryptedToken: result.encrypted_token, iv: result.iv };
  }
}
