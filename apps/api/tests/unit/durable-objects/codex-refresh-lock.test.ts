/**
 * Unit tests for the CodexRefreshLock Durable Object.
 *
 * Tests the core business logic: token comparison, credential lookup,
 * decryption/re-encryption, upstream forwarding, stale token handling,
 * and lock timeout.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock cloudflare:workers
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    env: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// Mock encryption service
vi.mock('../../../src/services/encryption', () => ({
  decrypt: vi.fn(),
  encrypt: vi.fn(),
}));

// Mock secrets helper
vi.mock('../../../src/lib/secrets', () => ({
  getCredentialEncryptionKey: vi.fn().mockReturnValue('test-encryption-key'),
}));

// Mock logger
const mockLogWarn = vi.fn();
vi.mock('../../../src/lib/logger', () => ({
  log: {
    info: vi.fn(),
    warn: mockLogWarn,
    error: vi.fn(),
  },
}));

const { CodexRefreshLock } = await import(
  '../../../src/durable-objects/codex-refresh-lock'
);
const { decrypt, encrypt } = await import('../../../src/services/encryption');

function createMockEnv(overrides: Record<string, unknown> = {}) {
  return {
    DATABASE: createMockD1(),
    ENCRYPTION_KEY: 'test-encryption-key',
    ...overrides,
  };
}

function createMockD1() {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(null),
        run: vi.fn().mockResolvedValue({}),
      }),
    }),
  };
}

function createDO(envOverrides: Record<string, unknown> = {}) {
  const env = createMockEnv(envOverrides);
  const ctx = { storage: {} };
  return { do: new CodexRefreshLock(ctx, env), env };
}

function makeRequest(payload: Record<string, unknown>): Request {
  return new Request('https://do-internal/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

const storedAuthJson = JSON.stringify({
  tokens: {
    access_token: 'stored-access',
    refresh_token: 'stored-refresh',
    id_token: 'stored-id',
  },
});

function setupCredentialFound(env: ReturnType<typeof createMockEnv>) {
  const mockFirst = vi.fn().mockResolvedValue({
    id: 'cred-1',
    encrypted_token: 'encrypted-data',
    iv: 'test-iv',
  });
  vi.mocked(env.DATABASE.prepare).mockReturnValue({
    bind: vi.fn().mockReturnValue({
      first: mockFirst,
      run: vi.fn().mockResolvedValue({}),
    }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return mockFirst;
}

describe('CodexRefreshLock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(decrypt).mockResolvedValue(storedAuthJson);
    vi.mocked(encrypt).mockResolvedValue({
      ciphertext: 'new-encrypted',
      iv: 'new-iv',
    });
    // Reset global fetch mock
    vi.stubGlobal('fetch', vi.fn());
  });

  // -----------------------------------------------------------------------
  // Method validation
  // -----------------------------------------------------------------------

  it('returns 405 for non-POST requests', async () => {
    const { do: doInstance } = createDO();
    const req = new Request('https://do-internal/refresh', { method: 'GET' });
    const res = await doInstance.fetch(req);
    expect(res.status).toBe(405);
    const json = await res.json();
    expect(json.error).toBe('method_not_allowed');
  });

  // -----------------------------------------------------------------------
  // Payload validation
  // -----------------------------------------------------------------------

  it('returns 400 when refreshToken is missing', async () => {
    const { do: doInstance } = createDO();
    const res = await doInstance.fetch(makeRequest({ userId: 'user-1' }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_request');
  });

  it('returns 400 when userId is missing', async () => {
    const { do: doInstance } = createDO();
    const res = await doInstance.fetch(
      makeRequest({ refreshToken: 'rt_test' }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_request');
  });

  // -----------------------------------------------------------------------
  // No credential
  // -----------------------------------------------------------------------

  it('returns 401 when no credential is found for user', async () => {
    const { do: doInstance } = createDO();
    // Default mock returns null (no credential)
    const res = await doInstance.fetch(
      makeRequest({ refreshToken: 'rt_test', userId: 'user-1' }),
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('refresh_token_invalidated');
  });

  // -----------------------------------------------------------------------
  // Decrypt failure
  // -----------------------------------------------------------------------

  it('returns 500 when credential decryption fails', async () => {
    const { do: doInstance, env } = createDO();
    setupCredentialFound(env);
    vi.mocked(decrypt).mockRejectedValue(new Error('bad key'));

    const res = await doInstance.fetch(
      makeRequest({ refreshToken: 'rt_test', userId: 'user-1' }),
    );
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('internal_error');
    expect(json.message).toContain('decrypt');
  });

  // -----------------------------------------------------------------------
  // Invalid stored JSON
  // -----------------------------------------------------------------------

  it('returns 500 when stored credential is not valid JSON', async () => {
    const { do: doInstance, env } = createDO();
    setupCredentialFound(env);
    vi.mocked(decrypt).mockResolvedValue('not-json{{{');

    const res = await doInstance.fetch(
      makeRequest({ refreshToken: 'rt_test', userId: 'user-1' }),
    );
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('internal_error');
    expect(json.message).toContain('JSON');
  });

  // -----------------------------------------------------------------------
  // Stale token — return cached tokens
  // -----------------------------------------------------------------------

  it('returns cached tokens when refresh_token is stale (no upstream call)', async () => {
    const { do: doInstance, env } = createDO();
    setupCredentialFound(env);

    const res = await doInstance.fetch(
      makeRequest({
        refreshToken: 'rt_stale_token',
        userId: 'user-1',
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.access_token).toBe('stored-access');
    expect(json.refresh_token).toBe('stored-refresh');
    expect(json.id_token).toBe('stored-id');

    // No upstream fetch should have been made
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Token match — forward to upstream
  // -----------------------------------------------------------------------

  it('forwards to upstream when refresh_token matches stored', async () => {
    const { do: doInstance, env } = createDO();
    setupCredentialFound(env);

    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          id_token: 'new-id',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await doInstance.fetch(
      makeRequest({
        refreshToken: 'stored-refresh', // matches stored token
        userId: 'user-1',
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.access_token).toBe('new-access');
    expect(json.refresh_token).toBe('new-refresh');
    expect(json.id_token).toBe('new-id');

    // Verify upstream was called
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://auth.openai.com/oauth/token');
    expect(opts?.method).toBe('POST');

    // Verify credential was re-encrypted and saved
    expect(vi.mocked(encrypt)).toHaveBeenCalledTimes(1);
    expect(env.DATABASE.prepare).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE credentials'),
    );
  });

  // -----------------------------------------------------------------------
  // Upstream errors
  // -----------------------------------------------------------------------

  it('returns 502 with upstream_timeout on fetch abort', async () => {
    const { do: doInstance, env } = createDO({
      CODEX_REFRESH_UPSTREAM_TIMEOUT_MS: '1', // 1ms timeout
    });
    setupCredentialFound(env);

    // Simulate a slow upstream
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(
            () => reject(new DOMException('Aborted', 'AbortError')),
            5,
          );
        }),
    );

    const res = await doInstance.fetch(
      makeRequest({
        refreshToken: 'stored-refresh',
        userId: 'user-1',
      }),
    );
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe('upstream_timeout');
  });

  it('returns 502 with upstream_error on network failure', async () => {
    const { do: doInstance, env } = createDO();
    setupCredentialFound(env);

    vi.mocked(fetch).mockRejectedValue(new TypeError('Network error'));

    const res = await doInstance.fetch(
      makeRequest({
        refreshToken: 'stored-refresh',
        userId: 'user-1',
      }),
    );
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe('upstream_error');
  });

  it('filters upstream error responses to only safe fields', async () => {
    const { do: doInstance, env } = createDO();
    setupCredentialFound(env);

    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({
        error: 'invalid_grant',
        error_description: 'Token has been revoked',
        debug_info: 'sensitive-data-should-not-leak',
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }),
    );

    const res = await doInstance.fetch(
      makeRequest({
        refreshToken: 'stored-refresh',
        userId: 'user-1',
      }),
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('invalid_grant');
    expect(json.error_description).toBe('Token has been revoked');
    expect(json.debug_info).toBeUndefined(); // filtered out
  });

  it('returns generic error for non-JSON upstream error responses', async () => {
    const { do: doInstance, env } = createDO();
    setupCredentialFound(env);

    vi.mocked(fetch).mockResolvedValue(
      new Response('<html>Server Error</html>', {
        status: 500,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    const res = await doInstance.fetch(
      makeRequest({
        refreshToken: 'stored-refresh',
        userId: 'user-1',
      }),
    );
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('upstream_error');
  });

  // -----------------------------------------------------------------------
  // Scope validation
  // -----------------------------------------------------------------------

  it('succeeds without warning when upstream returns no scope field', async () => {
    const { do: doInstance, env } = createDO({
      CODEX_EXPECTED_SCOPES: 'openid,offline_access',
    });
    setupCredentialFound(env);
    mockLogWarn.mockClear();

    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          id_token: 'new-id',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await doInstance.fetch(
      makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
    );
    expect(res.status).toBe(200);
    expect(mockLogWarn).not.toHaveBeenCalledWith(
      'codex_refresh.unexpected_scopes',
      expect.anything(),
    );
  });

  it('warns when upstream returns unexpected scopes', async () => {
    const { do: doInstance, env } = createDO({
      CODEX_EXPECTED_SCOPES: 'openid,offline_access',
    });
    setupCredentialFound(env);
    mockLogWarn.mockClear();

    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          id_token: 'new-id',
          scope: 'openid offline_access admin:write',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await doInstance.fetch(
      makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
    );
    // Should still succeed (warning only, not blocking)
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.access_token).toBe('new-access');

    expect(mockLogWarn).toHaveBeenCalledWith(
      'codex_refresh.unexpected_scopes',
      expect.objectContaining({
        unexpectedScopes: 'admin:write',
      }),
    );
  });

  it('does not warn when scopes match expected', async () => {
    const { do: doInstance, env } = createDO({
      CODEX_EXPECTED_SCOPES: 'openid,offline_access',
    });
    setupCredentialFound(env);
    mockLogWarn.mockClear();

    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          scope: 'openid offline_access',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await doInstance.fetch(
      makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
    );
    expect(res.status).toBe(200);
    expect(mockLogWarn).not.toHaveBeenCalledWith(
      'codex_refresh.unexpected_scopes',
      expect.anything(),
    );
  });

  it('skips scope validation when CODEX_EXPECTED_SCOPES is not configured', async () => {
    const { do: doInstance, env } = createDO();
    // No CODEX_EXPECTED_SCOPES set
    setupCredentialFound(env);
    mockLogWarn.mockClear();

    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          scope: 'openid offline_access admin:write some:other:scope',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await doInstance.fetch(
      makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
    );
    expect(res.status).toBe(200);
    expect(mockLogWarn).not.toHaveBeenCalledWith(
      'codex_refresh.unexpected_scopes',
      expect.anything(),
    );
  });

  it('warns on non-string scope in upstream response', async () => {
    const { do: doInstance, env } = createDO({
      CODEX_EXPECTED_SCOPES: 'openid',
    });
    setupCredentialFound(env);
    mockLogWarn.mockClear();

    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          scope: 42, // non-string scope
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await doInstance.fetch(
      makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
    );
    expect(res.status).toBe(200);
    expect(mockLogWarn).toHaveBeenCalledWith(
      'codex_refresh.scope_validation',
      expect.objectContaining({
        scopeType: 'number',
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Configurable upstream URL and client_id
  // -----------------------------------------------------------------------

  it('uses configurable upstream URL and client_id', async () => {
    const { do: doInstance, env } = createDO({
      CODEX_REFRESH_UPSTREAM_URL: 'https://custom-auth.example.com/token',
      CODEX_CLIENT_ID: 'custom_client_id',
    });
    setupCredentialFound(env);

    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new',
          refresh_token: 'new-rt',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await doInstance.fetch(
      makeRequest({
        refreshToken: 'stored-refresh',
        userId: 'user-1',
      }),
    );

    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://custom-auth.example.com/token');
    const body = JSON.parse(opts?.body as string);
    expect(body.client_id).toBe('custom_client_id');
  });
});
