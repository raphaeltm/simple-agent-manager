/**
 * CodexRefreshLock Durable Object — per-user serialization of Codex OAuth token refreshes.
 *
 * Keyed by userId. Prevents concurrent refresh requests from racing against OpenAI's
 * rotating refresh token — only one refresh against OpenAI happens at a time per user.
 * Second concurrent request detects stale token and returns latest from DB instead.
 *
 * Accessed via `env.CODEX_REFRESH_LOCK.idFromName(userId)`.
 */
import { DurableObject } from 'cloudflare:workers';

interface RefreshRequestPayload {
  /** The refresh token sent by Codex. */
  refreshToken: string;
  /** The userId to look up credentials for. */
  userId: string;
  /** The encryption key for credential decryption/re-encryption. */
  encryptionKey: string;
}

interface CodexRefreshEnv {
  DATABASE: D1Database;
  CODEX_REFRESH_UPSTREAM_URL?: string;
  CODEX_REFRESH_UPSTREAM_TIMEOUT_MS?: string;
  CODEX_REFRESH_LOCK_TIMEOUT_MS?: string;
  CODEX_CLIENT_ID?: string;
}

const DEFAULT_UPSTREAM_URL = 'https://auth.openai.com/oauth/token';
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

export class CodexRefreshLock extends DurableObject<CodexRefreshEnv> {
  /**
   * Handle an incoming refresh request. The DO's single-threaded execution model
   * guarantees that only one request is processed at a time per userId instance,
   * providing the per-user lock without explicit mutex logic.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const lockTimeout = parseInt(this.env.CODEX_REFRESH_LOCK_TIMEOUT_MS || '', 10) || DEFAULT_LOCK_TIMEOUT_MS;

    return Promise.race([
      this.handleRefresh(request),
      new Promise<Response>((resolve) =>
        setTimeout(
          () =>
            resolve(
              new Response(
                JSON.stringify({ error: 'lock_timeout', message: 'Refresh lock timed out' }),
                { status: 504, headers: { 'Content-Type': 'application/json' } }
              )
            ),
          lockTimeout
        )
      ),
    ]);
  }

  private async handleRefresh(request: Request): Promise<Response> {
    try {
      const payload: RefreshRequestPayload = await request.json();
      const { refreshToken, userId, encryptionKey } = payload;

      if (!refreshToken || !userId || !encryptionKey) {
        return new Response(
          JSON.stringify({ error: 'invalid_request', message: 'Missing required fields' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Look up the stored credential.
      const credential = await this.getStoredCredential(userId);
      if (!credential) {
        return new Response(
          JSON.stringify({ error: 'refresh_token_invalidated' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Decrypt the stored credential to get the current auth.json.
      const { decrypt, encrypt } = await import('../services/encryption');
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

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), upstreamTimeout);

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
          signal: controller.signal,
        });
      } catch (err) {
        const isAbort = err instanceof Error && err.name === 'AbortError';
        return new Response(
          JSON.stringify({ error: isAbort ? 'upstream_timeout' : 'upstream_error' }),
          { status: 502, headers: { 'Content-Type': 'application/json' } }
        );
      } finally {
        clearTimeout(timeoutId);
      }

      if (!upstreamResponse.ok) {
        // Forward error responses as-is — Codex understands OpenAI error format.
        const errorBody = await upstreamResponse.text();
        return new Response(errorBody, {
          status: upstreamResponse.status,
          headers: { 'Content-Type': 'application/json' },
        });
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
        .prepare('UPDATE credentials SET encrypted_token = ?, iv = ?, updated_at = ? WHERE id = ?')
        .bind(ciphertext, iv, new Date().toISOString(), credential.id)
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
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return new Response(
        JSON.stringify({ error: 'internal_error', message }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
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
