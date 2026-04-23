/**
 * Unit tests for the CodexRefreshLock Durable Object.
 *
 * Covers:
 *  - Method + payload validation
 *  - CRITICAL #1: stale-token branch does not return `refresh_token`
 *  - HIGH #2: project-scope resolution — active row preferred, inactive row blocks
 *    fallback, absent row falls through to user-scoped
 *  - MEDIUM #5: rate-limit state held in `ctx.storage` (atomic per-user), 429 with
 *    Retry-After on exceed
 *  - MEDIUM #6: upstream scope validation (warn-only by default; block when CODEX_SCOPE_VALIDATION_MODE=block)
 *  - Decrypt/parse failure handling
 *  - Upstream error paths (timeout, network, filtered error body)
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
const mockLogInfo = vi.fn();
const mockLogError = vi.fn();
vi.mock('../../../src/lib/logger', () => ({
  log: {
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
  },
}));

const { CodexRefreshLock } = await import(
  '../../../src/durable-objects/codex-refresh-lock'
);
const { decrypt, encrypt } = await import('../../../src/services/encryption');

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function createMockEnv(overrides: Record<string, unknown> = {}) {
  return {
    DATABASE: createMockD1(),
    ENCRYPTION_KEY: 'test-encryption-key',
    // Disable scope validation by default for tests that don't exercise it —
    // individual tests re-enable with CODEX_EXPECTED_SCOPES overrides.
    CODEX_EXPECTED_SCOPES: '',
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

/**
 * Minimal in-memory ctx.storage stub — the DO rate limiter does get/put against
 * a single `rate-limit` key. Tests that need to simulate "already at limit" can
 * pre-seed the store.
 */
function createMockCtx(prePopulated: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(prePopulated));
  return {
    storage: {
      get: vi.fn(async (key: string) => store.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
      _store: store,
    },
  };
}

function createDO(
  envOverrides: Record<string, unknown> = {},
  storagePrePopulated: Record<string, unknown> = {}
) {
  const env = createMockEnv(envOverrides);
  const ctx = createMockCtx(storagePrePopulated);
  return { do: new CodexRefreshLock(ctx, env), env, ctx };
}

async function createDOWithRotatedToken(
  token: string,
  ageMs: number,
  envOverrides: Record<string, unknown> = {},
) {
  const setup = createDO(envOverrides, await createRotatedTokenStorage(token, ageMs));
  setupCredentialFound(setup.env);
  return setup;
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

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function createRotatedTokenStorage(token: string, ageMs: number) {
  return {
    'rotated-tokens': [
      {
        tokenHash: await sha256Hex(token),
        rotatedAt: Date.now() - ageMs,
      },
    ],
  };
}

function mockSuccessfulRefreshResponse(
  tokens: Record<string, string> = {
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    id_token: 'new-id',
  },
) {
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify(tokens), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

/**
 * Configure the D1 mock to return a user-scoped credential row for the SECOND
 * query (the first, project-scoped query returns null when called).
 *
 * DO query order (getStoredCredential):
 *  1. If projectId: lookup project-scoped row (may be null)
 *  2. Always (when no active project row): lookup user-scoped row
 */
function setupCredentialFound(env: ReturnType<typeof createMockEnv>) {
  const userFirst = vi.fn().mockResolvedValue({
    id: 'cred-1',
    encrypted_token: 'encrypted-data',
    iv: 'test-iv',
  });
  vi.mocked(env.DATABASE.prepare).mockReturnValue({
    bind: vi.fn().mockReturnValue({
      first: userFirst,
      run: vi.fn().mockResolvedValue({}),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return userFirst;
}

describe('CodexRefreshLock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(decrypt).mockResolvedValue(storedAuthJson);
    vi.mocked(encrypt).mockResolvedValue({
      ciphertext: 'new-encrypted',
      iv: 'new-iv',
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  // -----------------------------------------------------------------------
  // Method + payload validation
  // -----------------------------------------------------------------------

  it('returns 405 for non-POST requests', async () => {
    const { do: doInstance } = createDO();
    const req = new Request('https://do-internal/refresh', { method: 'GET' });
    const res = await doInstance.fetch(req);
    expect(res.status).toBe(405);
    const json = await res.json();
    expect(json.error).toBe('method_not_allowed');
  });

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
    const res = await doInstance.fetch(
      makeRequest({ refreshToken: 'rt_test', userId: 'user-1' }),
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('refresh_token_invalidated');
  });

  // -----------------------------------------------------------------------
  // Decrypt / parse failure
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
  // CRITICAL #1 — stale-token branch MUST NOT return refresh_token
  // -----------------------------------------------------------------------

  it('stale-token branch returns access_token + id_token but NOT refresh_token (CRITICAL #1)', async () => {
    const { do: doInstance, env } = createDO();
    setupCredentialFound(env);

    const res = await doInstance.fetch(
      makeRequest({
        refreshToken: 'rt_stale_token', // does not match 'stored-refresh'
        userId: 'user-1',
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();

    // CRITICAL #1 lock: refresh_token MUST NOT appear in the stale response.
    expect(json.refresh_token).toBeUndefined();
    // Short-lived tokens may still be returned so a legit concurrent caller can continue.
    expect(json.access_token).toBe('stored-access');
    expect(json.id_token).toBe('stored-id');
    expect(json.stale).toBe(true);

    // No upstream fetch should have been made (no valid refresh token to spend).
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Grace window — recently-rotated tokens receive full response
  // -----------------------------------------------------------------------

  describe('grace window for recently-rotated tokens', () => {
    it('returns full tokens (including refresh_token) when stale token is within grace window', async () => {
      const { do: doInstance } = await createDOWithRotatedToken('old-refresh', 60_000);

      const res = await doInstance.fetch(
        makeRequest({
          refreshToken: 'old-refresh', // stale, but recently rotated
          userId: 'user-1',
        }),
      );
      expect(res.status).toBe(200);
      const json = await res.json();

      // Grace window hit: full tokens returned including refresh_token.
      expect(json.access_token).toBe('stored-access');
      expect(json.refresh_token).toBe('stored-refresh');
      expect(json.id_token).toBe('stored-id');
      expect(json.stale).toBeUndefined(); // no stale flag

      // No upstream fetch — we return stored tokens directly.
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(mockLogInfo).toHaveBeenCalledWith(
        'codex_refresh.grace_window_hit',
        expect.objectContaining({ userId: 'user-1' }),
      );
    });

    it('rejects stale token outside grace window (CRITICAL #1 still applies)', async () => {
      const { do: doInstance } = await createDOWithRotatedToken('very-old-refresh', 600_000);

      const res = await doInstance.fetch(
        makeRequest({
          refreshToken: 'very-old-refresh',
          userId: 'user-1',
        }),
      );
      expect(res.status).toBe(200);
      const json = await res.json();

      // CRITICAL #1: outside grace window → no refresh_token.
      expect(json.refresh_token).toBeUndefined();
      expect(json.access_token).toBe('stored-access');
      expect(json.id_token).toBe('stored-id');
      expect(json.stale).toBe(true);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it('rejects completely unknown stale token (no grace window entry)', async () => {
      const { do: doInstance, env } = createDO();
      setupCredentialFound(env);

      const res = await doInstance.fetch(
        makeRequest({
          refreshToken: 'totally-unknown-token',
          userId: 'user-1',
        }),
      );
      expect(res.status).toBe(200);
      const json = await res.json();

      // No grace window entry → CRITICAL #1 applies.
      expect(json.refresh_token).toBeUndefined();
      expect(json.stale).toBe(true);
    });

    it('records rotated token in DO storage on successful refresh', async () => {
      const { do: doInstance, env, ctx } = createDO();
      setupCredentialFound(env);
      mockSuccessfulRefreshResponse();

      await doInstance.fetch(
        makeRequest({
          refreshToken: 'stored-refresh', // matches stored → fresh path
          userId: 'user-1',
        }),
      );

      // The old 'stored-refresh' should be recorded in rotated-tokens.
      const rotatedTokens = ctx.storage._store.get('rotated-tokens') as Array<{
        tokenHash: string;
        rotatedAt: number;
      }>;
      expect(rotatedTokens).toBeDefined();
      expect(rotatedTokens.length).toBe(1);
      expect(rotatedTokens[0].rotatedAt).toBeGreaterThan(0);

      // Verify the hash matches 'stored-refresh'.
      expect(rotatedTokens[0].tokenHash).toBe(await sha256Hex('stored-refresh'));
    });

    it('does NOT record rotated token when refresh_token is unchanged', async () => {
      const { do: doInstance, env, ctx } = createDO();
      setupCredentialFound(env);
      mockSuccessfulRefreshResponse({
        access_token: 'new-access',
        refresh_token: 'stored-refresh',
        id_token: 'new-id',
      });

      await doInstance.fetch(
        makeRequest({
          refreshToken: 'stored-refresh',
          userId: 'user-1',
        }),
      );

      // No rotation happened — rotated-tokens should not be written.
      const rotatedTokens = ctx.storage._store.get('rotated-tokens');
      expect(rotatedTokens).toBeUndefined();
    });

    it('respects configurable grace window via CODEX_REFRESH_GRACE_WINDOW_MS', async () => {
      const { do: doInstance } = await createDOWithRotatedToken(
        'recently-rotated',
        2_000,
        { CODEX_REFRESH_GRACE_WINDOW_MS: '1000' },
      );

      const res = await doInstance.fetch(
        makeRequest({
          refreshToken: 'recently-rotated',
          userId: 'user-1',
        }),
      );
      expect(res.status).toBe(200);
      const json = await res.json();

      // Outside the short grace window → stale.
      expect(json.refresh_token).toBeUndefined();
      expect(json.stale).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Fresh-token path — forwards to upstream and persists
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
        refreshToken: 'stored-refresh',
        userId: 'user-1',
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.access_token).toBe('new-access');
    expect(json.refresh_token).toBe('new-refresh');
    expect(json.id_token).toBe('new-id');

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://auth.openai.com/oauth/token');
    expect(opts?.method).toBe('POST');

    // Credential re-encrypted and persisted.
    expect(vi.mocked(encrypt)).toHaveBeenCalledTimes(1);
    expect(env.DATABASE.prepare).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE credentials'),
    );
  });

  // -----------------------------------------------------------------------
  // HIGH #2 — Project-scope credential resolution
  // -----------------------------------------------------------------------

  describe('HIGH #2 — project vs user fallback', () => {
    /**
     * Wire the D1 mock to simulate a two-query pattern: first bind(userId, projectId)
     * targets the project-scoped SELECT, second bind(userId) targets user-scoped.
     */
    function setupScopedCredentials(
      env: ReturnType<typeof createMockEnv>,
      opts: {
        projectRow: null | { id: string; is_active: 0 | 1 };
        userRow: null | { id: string };
      }
    ) {
      const projectFirst = vi.fn().mockResolvedValue(
        opts.projectRow
          ? {
              id: opts.projectRow.id,
              encrypted_token: 'encrypted-data',
              iv: 'test-iv',
              is_active: opts.projectRow.is_active,
            }
          : null
      );
      const userFirst = vi.fn().mockResolvedValue(
        opts.userRow
          ? {
              id: opts.userRow.id,
              encrypted_token: 'encrypted-data',
              iv: 'test-iv',
            }
          : null
      );
      const userBind = vi.fn().mockReturnValue({
        first: userFirst,
        run: vi.fn().mockResolvedValue({}),
      });
      const projectBind = vi.fn().mockReturnValue({
        first: projectFirst,
        run: vi.fn().mockResolvedValue({}),
      });

      // Route by number of bind args: project query binds 2 args, user query binds 1.
      const runUpdate = vi.fn().mockResolvedValue({});
      const prepare = vi.fn((sql: string) => {
        if (sql.includes('UPDATE credentials')) {
          return { bind: () => ({ run: runUpdate }) };
        }
        if (sql.includes('project_id = ?')) {
          return { bind: projectBind };
        }
        return { bind: userBind };
      });
      vi.mocked(env.DATABASE.prepare).mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        prepare as any
      );
      return { projectFirst, userFirst, projectBind, userBind, runUpdate };
    }

    it('prefers active project-scoped row when projectId is supplied', async () => {
      const { do: doInstance, env } = createDO();
      const { projectFirst, userFirst, runUpdate } = setupScopedCredentials(env, {
        projectRow: { id: 'proj-cred-1', is_active: 1 },
        userRow: { id: 'user-cred-1' },
      });

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
          refreshToken: 'stored-refresh',
          userId: 'user-1',
          projectId: 'proj-a',
        }),
      );

      expect(res.status).toBe(200);
      expect(projectFirst).toHaveBeenCalled();
      // User-scoped query should NOT be consulted — project row was active.
      expect(userFirst).not.toHaveBeenCalled();
      // DB update targets the PROJECT-scoped row id.
      expect(runUpdate).toHaveBeenCalled();
    });

    it('blocks fallback when project-scoped row exists but is inactive (HIGH #2)', async () => {
      const { do: doInstance, env } = createDO();
      const { projectFirst, userFirst, runUpdate } = setupScopedCredentials(env, {
        projectRow: { id: 'proj-cred-1', is_active: 0 },
        userRow: { id: 'user-cred-1' }, // present but MUST NOT be used
      });

      const res = await doInstance.fetch(
        makeRequest({
          refreshToken: 'stored-refresh',
          userId: 'user-1',
          projectId: 'proj-a',
        }),
      );

      // Inactive project row blocks — return 401, do not fall back.
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe('refresh_token_invalidated');

      expect(projectFirst).toHaveBeenCalled();
      // User-scoped row MUST NOT be consulted when inactive project row is present.
      expect(userFirst).not.toHaveBeenCalled();
      // User-scoped row MUST NOT be updated (would leak rotation across projects).
      expect(runUpdate).not.toHaveBeenCalled();
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(mockLogWarn).toHaveBeenCalledWith(
        'codex_refresh.inactive_project_credential_no_fallback',
        expect.objectContaining({ userId: 'user-1', projectId: 'proj-a' }),
      );
    });

    it('falls back to user-scoped row when no project row exists', async () => {
      const { do: doInstance, env } = createDO();
      const { projectFirst, userFirst } = setupScopedCredentials(env, {
        projectRow: null,
        userRow: { id: 'user-cred-1' },
      });

      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const res = await doInstance.fetch(
        makeRequest({
          refreshToken: 'stored-refresh',
          userId: 'user-1',
          projectId: 'proj-a',
        }),
      );

      expect(res.status).toBe(200);
      expect(projectFirst).toHaveBeenCalled();
      expect(userFirst).toHaveBeenCalled(); // fallback occurred
    });

    it('uses user-scoped row when no projectId is supplied', async () => {
      const { do: doInstance, env } = createDO();
      const { projectFirst, userFirst } = setupScopedCredentials(env, {
        projectRow: null,
        userRow: { id: 'user-cred-1' },
      });

      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: 'new', refresh_token: 'new-rt' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
      );

      expect(res.status).toBe(200);
      // No projectId → skip project query entirely.
      expect(projectFirst).not.toHaveBeenCalled();
      expect(userFirst).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // MEDIUM #5 — DO-state rate limit (atomic, 429 with Retry-After)
  // -----------------------------------------------------------------------

  describe('MEDIUM #5 — rate limit', () => {
    it('counts successful refresh requests in ctx.storage', async () => {
      const { do: doInstance, env, ctx } = createDO({
        RATE_LIMIT_CODEX_REFRESH_PER_HOUR: '5',
      });
      setupCredentialFound(env);
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: 'a', refresh_token: 'r' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
      );

      // Rate-limit state must have been written at least once.
      expect(ctx.storage.put).toHaveBeenCalledWith(
        'rate-limit',
        expect.objectContaining({ count: expect.any(Number) }),
      );
      const stored = ctx.storage._store.get('rate-limit') as {
        count: number;
        windowStart: number;
      };
      expect(stored.count).toBeGreaterThanOrEqual(1);
    });

    it('returns 429 with Retry-After when the per-window limit is exceeded', async () => {
      const windowSeconds = 60;
      const now = Math.floor(Date.now() / 1000);
      const currentWindowStart = Math.floor(now / windowSeconds) * windowSeconds;

      const { do: doInstance, env, ctx } = createDO(
        {
          RATE_LIMIT_CODEX_REFRESH_PER_HOUR: '3',
          RATE_LIMIT_CODEX_REFRESH_WINDOW_SECONDS: windowSeconds.toString(),
        },
        {
          'rate-limit': { windowStart: currentWindowStart, count: 3 },
        }
      );
      setupCredentialFound(env);

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
      );

      expect(res.status).toBe(429);
      const json = await res.json();
      expect(json.error).toBe('rate_limit_exceeded');

      const retryAfter = res.headers.get('Retry-After');
      expect(retryAfter).not.toBeNull();
      expect(parseInt(retryAfter!, 10)).toBeGreaterThanOrEqual(1);

      // No upstream fetch and no DB write should have happened.
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      // Count must NOT be incremented past the limit.
      const stored = ctx.storage._store.get('rate-limit') as { count: number };
      expect(stored.count).toBe(3);
    });

    it('resets counter when the window rolls over', async () => {
      const windowSeconds = 60;
      const now = Math.floor(Date.now() / 1000);
      const currentWindowStart = Math.floor(now / windowSeconds) * windowSeconds;
      const stalePastWindowStart = currentWindowStart - windowSeconds;

      const { do: doInstance, env, ctx } = createDO(
        {
          RATE_LIMIT_CODEX_REFRESH_PER_HOUR: '3',
          RATE_LIMIT_CODEX_REFRESH_WINDOW_SECONDS: windowSeconds.toString(),
        },
        {
          'rate-limit': { windowStart: stalePastWindowStart, count: 3 },
        }
      );
      setupCredentialFound(env);
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: 'a', refresh_token: 'r' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
      );

      expect(res.status).toBe(200);
      const stored = ctx.storage._store.get('rate-limit') as {
        count: number;
        windowStart: number;
      };
      // New window — counter reset to 1, windowStart advanced.
      expect(stored.windowStart).toBe(currentWindowStart);
      expect(stored.count).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // MEDIUM #6 — Scope validation (warn-only by default, block when opted in)
  // -----------------------------------------------------------------------

  describe('MEDIUM #6 — scope validation', () => {
    it('warns but allows refresh on unexpected scope by default (warn mode)', async () => {
      const { do: doInstance, env } = createDO({
        CODEX_EXPECTED_SCOPES: 'openid,offline_access',
        // CODEX_SCOPE_VALIDATION_MODE not set — defaults to 'warn'
      });
      setupCredentialFound(env);

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
      // Warn mode: refresh succeeds despite unexpected scopes
      expect(res.status).toBe(200);
      expect(vi.mocked(encrypt)).toHaveBeenCalled();
      expect(mockLogWarn).toHaveBeenCalledWith(
        'codex_refresh.unexpected_scopes_allowed',
        expect.objectContaining({ validationMode: 'warn' }),
      );
    });

    it('blocks with 502 on unexpected scope when CODEX_SCOPE_VALIDATION_MODE=block', async () => {
      const { do: doInstance, env } = createDO({
        CODEX_EXPECTED_SCOPES: 'openid,offline_access',
        CODEX_SCOPE_VALIDATION_MODE: 'block',
      });
      setupCredentialFound(env);

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
      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json.error).toBe('upstream_unexpected_scope');

      // MUST NOT persist tokens that fail validation in block mode.
      expect(vi.mocked(encrypt)).not.toHaveBeenCalled();
      expect(mockLogWarn).toHaveBeenCalledWith(
        'codex_refresh.unexpected_scopes_blocked',
        expect.objectContaining({ unexpectedScopes: 'admin:write' }),
      );
    });

    it('allows refresh when scopes match expected', async () => {
      const { do: doInstance, env } = createDO({
        CODEX_EXPECTED_SCOPES: 'openid,offline_access',
      });
      setupCredentialFound(env);

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
      expect(vi.mocked(encrypt)).toHaveBeenCalled();
    });

    it('warns by default when CODEX_EXPECTED_SCOPES is unset (uses default allowlist in warn mode)', async () => {
      // Omit CODEX_EXPECTED_SCOPES entirely — DO must apply DEFAULT_EXPECTED_SCOPES.
      const env = createMockEnv();
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (env as Record<string, unknown>).CODEX_EXPECTED_SCOPES;
      const ctx = createMockCtx();
      const doInstance = new CodexRefreshLock(ctx, env);
      setupCredentialFound(env);

      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            scope: 'openid offline_access admin:write', // unexpected by default
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
      );
      // Default is warn mode — refresh succeeds, warning logged
      expect(res.status).toBe(200);
      expect(vi.mocked(encrypt)).toHaveBeenCalled();
      expect(mockLogWarn).toHaveBeenCalledWith(
        'codex_refresh.unexpected_scopes_allowed',
        expect.objectContaining({ validationMode: 'warn' }),
      );
    });

    it('allows all scopes when CODEX_EXPECTED_SCOPES is set to empty string (escape hatch)', async () => {
      const { do: doInstance, env } = createDO({ CODEX_EXPECTED_SCOPES: '' });
      setupCredentialFound(env);

      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            scope: 'openid offline_access admin:write anything:goes',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
      );
      expect(res.status).toBe(200);
      expect(vi.mocked(encrypt)).toHaveBeenCalled();
    });

    it('blocks non-string scope values in block mode', async () => {
      const { do: doInstance, env } = createDO({
        CODEX_EXPECTED_SCOPES: 'openid',
        CODEX_SCOPE_VALIDATION_MODE: 'block',
      });
      setupCredentialFound(env);

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
      expect(res.status).toBe(502);
      expect(mockLogWarn).toHaveBeenCalledWith(
        'codex_refresh.scope_validation_nonstring',
        expect.objectContaining({ scopeType: 'number' }),
      );
      expect(vi.mocked(encrypt)).not.toHaveBeenCalled();
    });

    it('warns but allows non-string scope values in default warn mode', async () => {
      const { do: doInstance, env } = createDO({
        CODEX_EXPECTED_SCOPES: 'openid',
      });
      setupCredentialFound(env);

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
      // Warn mode: refresh succeeds despite non-string scope
      expect(res.status).toBe(200);
      expect(mockLogWarn).toHaveBeenCalledWith(
        'codex_refresh.scope_validation_nonstring',
        expect.objectContaining({ scopeType: 'number' }),
      );
      expect(vi.mocked(encrypt)).toHaveBeenCalled();
    });

    it('allows responses with no scope field', async () => {
      const { do: doInstance, env } = createDO({
        CODEX_EXPECTED_SCOPES: 'openid,offline_access',
      });
      setupCredentialFound(env);

      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
      );
      expect(res.status).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // Upstream errors
  // -----------------------------------------------------------------------

  it('returns 502 with upstream_timeout on fetch abort', async () => {
    const { do: doInstance, env } = createDO({
      CODEX_REFRESH_UPSTREAM_TIMEOUT_MS: '1',
    });
    setupCredentialFound(env);

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
      makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
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
      makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
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
      makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('invalid_grant');
    expect(json.error_description).toBe('Token has been revoked');
    expect(json.debug_info).toBeUndefined();
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
      makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
    );
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('upstream_error');
  });

  // -----------------------------------------------------------------------
  // Configurable upstream URL + client_id
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

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://custom-auth.example.com/token');
    const body = JSON.parse(opts?.body as string);
    expect(body.client_id).toBe('custom_client_id');
  });
});
