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
 */
import { DurableObject } from 'cloudflare:workers';

import { getCredentialEncryptionKey } from '../lib/secrets';
import { decrypt, encrypt } from '../services/encryption';

interface RefreshRequestPayload {
  /** The refresh token sent by Codex. */
  refreshToken: string;
  /** The userId to look up credentials for. */
  userId: string;
}

interface CodexRefreshEnv {
  DATABASE: D1Database;
  ENCRYPTION_KEY: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  CODEX_REFRESH_UPSTREAM_URL?: string;
  CODEX_REFRESH_UPSTREAM_TIMEOUT_MS?: string;
  CODEX_REFRESH_LOCK_TIMEOUT_MS?: string;
  CODEX_CLIENT_ID?: string;
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
      const message = err instanceof Error ? err.message : 'Unknown error';
      return new Response(
        JSON.stringify({ error: 'internal_error', message }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async handleRefresh(request: Request, signal: AbortSignal): Promise<Response> {
    const payload: RefreshRequestPayload = await request.json();
    const { refreshToken, userId } = payload;

    if (!refreshToken || !userId) {
      return new Response(
        JSON.stringify({ error: 'invalid_request', message: 'Missing required fields' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Derive encryption key from DO env (not from caller).
    const encryptionKey = getCredentialEncryptionKey(this.env);

    // Look up the stored credential.
    const credential = await this.getStoredCredential(userId);
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
      // Stale token — another workspace already refreshed.
      // Return the latest tokens from DB.
      return new Response(
        JSON.stringify({
          access_token: tokens?.access_token ?? null,
          refresh_token: storedRefreshToken ?? null,
          id_token: tokens?.id_token ?? null,
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
      // Forward error responses — preserve upstream Content-Type.
      const errorBody = await upstreamResponse.text();
      return new Response(errorBody, {
        status: upstreamResponse.status,
        headers: { 'Content-Type': upstreamResponse.headers.get('Content-Type') ?? 'application/json' },
      });
    }

    // Check lock-level abort before writing to DB.
    if (signal.aborted) {
      throw new DOMException('Lock timeout', 'AbortError');
    }

    // Parse new tokens from OpenAI response.
    const newTokens: Record<string, string> = await upstreamResponse.json();

    // Update the stored auth.json with new tokens.
    if (!storedAuth.tokens || typeof storedAuth.tokens !== 'object') {
      storedAuth.tokens = {};
    }
    const authTokens = storedAuth.tokens as Record<string, string>;
    if (newTokens.access_token) authTokens.access_token = newTokens.access_token;
    if (newTokens.refresh_token) authTokens.refresh_token = newTokens.refresh_token;
    if (newTokens.id_token) authTokens.id_token = newTokens.id_token;
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
        access_token: newTokens.access_token ?? null,
        refresh_token: newTokens.refresh_token ?? null,
        id_token: newTokens.id_token ?? null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  /**
   * Look up the active openai-codex oauth-token credential for the given user.
   */
  private async getStoredCredential(
    userId: string
  ): Promise<{ id: string; encryptedToken: string; iv: string } | null> {
    const db = this.env.DATABASE;
    const result = await db
      .prepare(
        `SELECT id, encrypted_token, iv FROM credentials
         WHERE user_id = ? AND credential_type = 'agent-api-key'
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
