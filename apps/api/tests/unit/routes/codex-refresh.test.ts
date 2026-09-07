/**
 * Behavioral tests for the POST /api/auth/codex-refresh endpoint.
 *
 * Tests the centralized Codex OAuth token refresh proxy — verifying:
 * - Token match case (forward to OpenAI via DO)
 * - Stale token case (return from DB via DO)
 * - No credential case (401 via DO)
 * - Kill switch (503 when disabled)
 * - Auth validation (missing/invalid token, node-scoped token)
 * - Request validation (missing fields)
 * - Rate limiting (per workspace)
 * - Contract: request/response format matches Codex hardcoded format
 */
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { codexRefreshRoutes } from '../../../src/routes/codex-refresh';

// Mock drizzle-orm/d1 (same pattern as agent-credential-sync tests)
vi.mock('drizzle-orm/d1');

// Mock JWT verification
vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn(),
}));

// Note: rate limiting now lives inside the CodexRefreshLock DO (MEDIUM #5).
// We simulate rate-limited responses by having the DO's fetch mock return 429.

const { verifyCallbackToken } = await import('../../../src/services/jwt');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockDrizzleWithWorkspace(userId: string | null, projectId: string | null = null): any {
  const rows = userId ? [{ userId, projectId }] : [];
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  };
}

describe('POST /api/auth/codex-refresh', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockDoFetch: ReturnType<typeof vi.fn>;
  let mockIdFromName: ReturnType<typeof vi.fn>;
  let mockGetStub: ReturnType<typeof vi.fn>;

  function makeMockEnv(overrides: Record<string, unknown> = {}): Env {
    return {
      DATABASE: {} as D1Database,
      ENCRYPTION_KEY: 'test-key',
      JWT_PUBLIC_KEY: 'test-public-key',
      BASE_DOMAIN: 'test.example.com',
      CODEX_REFRESH_LOCK: {
        idFromName: mockIdFromName,
        get: mockGetStub,
      },
      ...overrides,
    } as unknown as Env;
  }

  function postRefresh(
    body: unknown,
    queryToken = 'valid-callback-token',
    env?: Env,
  ): Promise<Response> {
    const url = queryToken
      ? `/api/auth/codex-refresh?token=${queryToken}`
      : '/api/auth/codex-refresh';
    return app.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, env ?? makeMockEnv());
  }

  const validBody = {
    client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    grant_type: 'refresh_token',
    refresh_token: 'rt_test_refresh_token',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode as 400 | 500);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route('/api/auth', codexRefreshRoutes);

    // JWT: default valid workspace-scoped callback token
    vi.mocked(verifyCallbackToken).mockResolvedValue({
      workspace: 'ws-123',
      type: 'callback',
      scope: 'workspace',
    });

    // Drizzle: default returns workspace with userId
    vi.mocked(drizzle).mockReturnValue(mockDrizzleWithWorkspace('user-abc'));

    // DO: default returns success
    mockDoFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: 'new-id',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    mockIdFromName = vi.fn().mockReturnValue({ toString: () => 'do-id' });
    mockGetStub = vi.fn().mockReturnValue({ fetch: mockDoFetch });
  });

  // -----------------------------------------------------------------------
  // Auth validation
  // -----------------------------------------------------------------------

  it('returns 401 when no token query param is provided', async () => {
    const res = await postRefresh(validBody, '');
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('invalid_request');
  });

  it('returns 401 when callback token is invalid', async () => {
    vi.mocked(verifyCallbackToken).mockRejectedValue(new Error('Invalid token'));
    const res = await postRefresh(validBody);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('invalid_token');
  });

  it('returns 403 for node-scoped tokens', async () => {
    vi.mocked(verifyCallbackToken).mockResolvedValue({
      workspace: 'node-123',
      type: 'callback',
      scope: 'node',
    });
    const res = await postRefresh(validBody);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('insufficient_scope');
  });

  it('accepts legacy tokens without scope claim (backward compatibility)', async () => {
    vi.mocked(verifyCallbackToken).mockResolvedValue({
      workspace: 'ws-123',
      type: 'callback',
      // scope is undefined — legacy token
    });
    const res = await postRefresh(validBody);
    expect(res.status).toBe(200);
  });

  // -----------------------------------------------------------------------
  // Request validation
  // -----------------------------------------------------------------------

  it('returns 400 when grant_type is missing', async () => {
    const res = await postRefresh({ client_id: 'test', refresh_token: 'rt' });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_request');
  });

  it('returns 400 when refresh_token is missing', async () => {
    const res = await postRefresh({ client_id: 'test', grant_type: 'refresh_token' });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_request');
  });

  it('returns 400 when grant_type has wrong value', async () => {
    const res = await postRefresh({ client_id: 'test', grant_type: 'authorization_code', refresh_token: 'rt' });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_request');
  });

  it('returns 400 for malformed JSON body', async () => {
    const url = '/api/auth/codex-refresh?token=valid-callback-token';
    const res = await app.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    }, makeMockEnv());
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_request');
  });

  // -----------------------------------------------------------------------
  // Kill switch
  // -----------------------------------------------------------------------

  it('returns 503 when proxy is disabled', async () => {
    const res = await postRefresh(
      validBody,
      'valid-callback-token',
      makeMockEnv({ CODEX_REFRESH_PROXY_ENABLED: 'false' }),
    );
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe('service_unavailable');
  });

  it('allows requests when CODEX_REFRESH_PROXY_ENABLED is unset (default enabled)', async () => {
    const res = await postRefresh(validBody);
    expect(res.status).toBe(200);
  });

  // -----------------------------------------------------------------------
  // Workspace lookup
  // -----------------------------------------------------------------------

  it('returns 401 when workspace is not found', async () => {
    vi.mocked(drizzle).mockReturnValue(mockDrizzleWithWorkspace(null));

    const res = await postRefresh(validBody);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('refresh_token_invalidated');
  });

  // -----------------------------------------------------------------------
  // Success path — forwards to DO and returns response
  // -----------------------------------------------------------------------

  it('forwards request to CodexRefreshLock DO and returns success', async () => {
    const res = await postRefresh(validBody);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.access_token).toBe('new-access');
    expect(json.refresh_token).toBe('new-refresh');
    expect(json.id_token).toBe('new-id');

    // Verify DO was called with correct userId
    expect(mockIdFromName).toHaveBeenCalledWith('user-abc');
    expect(mockGetStub).toHaveBeenCalled();

    // Verify DO fetch was called with the refresh token
    expect(mockDoFetch).toHaveBeenCalledTimes(1);
    const doRequestBody = JSON.parse(
      await (mockDoFetch.mock.calls[0][0] as Request).text(),
    );
    expect(doRequestBody.refreshToken).toBe('rt_test_refresh_token');
    expect(doRequestBody.userId).toBe('user-abc');
    // projectId is forwarded so the DO updates the correct scoped row.
    // User-scoped workspace forwards projectId=null (default mock).
    expect(doRequestBody.projectId).toBeNull();
    // encryptionKey is NOT in the DO request — DO derives it from its own env
    expect(doRequestBody.encryptionKey).toBeUndefined();
  });

  it('forwards projectId to DO when workspace belongs to a project (project-scoped refresh)', async () => {
    vi.mocked(drizzle).mockReturnValue(mockDrizzleWithWorkspace('user-abc', 'proj-xyz'));

    const res = await postRefresh(validBody);
    expect(res.status).toBe(200);

    expect(mockDoFetch).toHaveBeenCalledTimes(1);
    const doRequestBody = JSON.parse(
      await (mockDoFetch.mock.calls[0][0] as Request).text(),
    );
    // Critical: the projectId from the workspace row must reach the DO so the DO
    // updates the project-scoped credential, not the user-scoped one.
    expect(doRequestBody.projectId).toBe('proj-xyz');
    expect(doRequestBody.userId).toBe('user-abc');
  });

  it('forwards DO error responses (401) back to Codex', async () => {
    mockDoFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'refresh_token_invalidated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await postRefresh(validBody);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('refresh_token_invalidated');
  });

  it('forwards DO 502 for upstream errors (Codex retries transient errors)', async () => {
    mockDoFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'upstream_error' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await postRefresh(validBody);
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe('upstream_error');
  });

  it('forwards access_token + id_token from DO when refresh_token is stale (CRITICAL #1)', async () => {
    // Simulate the stale token case: DO returns 200 with access + id token
    // but intentionally OMITS refresh_token — the caller did not prove possession
    // of a current refresh token, so we must not hand one out.
    mockDoFetch.mockResolvedValue(
      new Response(JSON.stringify({
        access_token: 'cached-access',
        id_token: 'cached-id',
        // refresh_token intentionally omitted (CRITICAL #1 fix)
        stale: true,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const res = await postRefresh(validBody);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.access_token).toBe('cached-access');
    expect(json.id_token).toBe('cached-id');
    // CRITICAL #1 regression guard: the stale-token response from the DO must
    // NOT contain refresh_token. The route forwards the DO's body verbatim,
    // so verifying here locks in the end-to-end contract.
    expect(json.refresh_token).toBeUndefined();
    expect(json.stale).toBe(true);

    // Verify the DO was still called (not short-circuited before reaching DO)
    expect(mockDoFetch).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Rate limiting (MEDIUM #5 — enforced atomically in the DO, propagated to caller)
  // -----------------------------------------------------------------------

  it('returns 429 with Retry-After when the DO reports rate limit exceeded', async () => {
    mockDoFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'rate_limit_exceeded', message: 'Too many refresh requests' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '1800',
          },
        },
      ),
    );

    const res = await postRefresh(validBody);
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toBe('rate_limit_exceeded');
    // The route must forward Retry-After so clients can honour the window.
    expect(res.headers.get('Retry-After')).toBe('1800');
  });

  it('keys rate limiting per-user via DO idFromName(userId)', async () => {
    vi.mocked(verifyCallbackToken).mockResolvedValue({
      workspace: 'ws-specific-id',
      type: 'callback',
      scope: 'workspace',
    });
    vi.mocked(drizzle).mockReturnValue(mockDrizzleWithWorkspace('user-specific-id'));

    await postRefresh(validBody);

    // Rate limit state now lives in the per-user DO instance. Verifying the DO
    // is keyed by userId is the closest contract to "the rate limiter saw this
    // user" after the move away from the KV-based middleware.
    expect(mockIdFromName).toHaveBeenCalledWith('user-specific-id');
  });

  // -----------------------------------------------------------------------
  // Contract tests — format matches Codex expectations
  // -----------------------------------------------------------------------

  describe('contract: request format matches Codex hardcoded format', () => {
    it('accepts the exact request format Codex sends', async () => {
      const codexRequest = {
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        grant_type: 'refresh_token',
        refresh_token: 'rt_some_token_value',
      };
      const res = await postRefresh(codexRequest);
      expect(res.status).toBe(200);
    });
  });

  describe('contract: response format matches what Codex expects', () => {
    it('returns all three token fields (access_token, refresh_token, id_token)', async () => {
      const res = await postRefresh(validBody);
      const json = await res.json();

      // All three fields must be present (Codex merges non-null fields into auth state)
      expect(json).toHaveProperty('access_token');
      expect(json).toHaveProperty('refresh_token');
      expect(json).toHaveProperty('id_token');
    });
  });

  describe('contract: error format matches Codex error parsing', () => {
    it('returns error field on 401 (permanent failure)', async () => {
      mockDoFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: 'refresh_token_expired' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const res = await postRefresh(validBody);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json).toHaveProperty('error');
      expect(typeof json.error).toBe('string');
    });

    it('returns 5xx for transient errors (Codex will retry)', async () => {
      mockDoFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: 'upstream_timeout' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const res = await postRefresh(validBody);
      expect(res.status).toBeGreaterThanOrEqual(500);
    });
  });
});
