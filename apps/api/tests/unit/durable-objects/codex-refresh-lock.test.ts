/**
 * Unit tests for the CodexRefreshLock Durable Object.
 *
 * Covers:
 *  - Method + payload validation
 *  - CRITICAL #1: stale-token branch does not return `refresh_token`
 *  - HIGH #2: project-scope resolution — active row preferred, inactive row blocks
 *    fallback, absent row falls through to user-scoped
 *  - MEDIUM #5: rate-limit state held in `ctx.storage` (atomic, keyed per-credential),
 *    429 with Retry-After on exceed; cached/grace/stale responses do not consume budget
 *  - MEDIUM #6: upstream scope anomaly detection (alert-only — a completed rotation is
 *    ALWAYS persisted; empty allowlist is explicit opt-out)
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

// Mock observability service — durable auth diagnostics (persistError is
// fail-silent in production; here we only assert it is invoked with the right
// payload and never receives token material).
vi.mock('../../../src/services/observability', () => ({
  persistError: vi.fn(),
}));

const { CodexRefreshLock } = await import(
  '../../../src/durable-objects/codex-refresh-lock'
);
const { decrypt, encrypt } = await import('../../../src/services/encryption');
const { persistError } = await import('../../../src/services/observability');

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function createMockEnv(overrides: Record<string, unknown> = {}) {
  return {
    DATABASE: createMockD1(),
    // Opaque binding — persistError is module-mocked, the DO only checks presence.
    OBSERVABILITY_DATABASE: {},
    ENCRYPTION_KEY: 'test-encryption-key',
    // Disable scope detection by default for tests that don't exercise it —
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
    is_active: 1,
  });
  vi.mocked(env.DATABASE.prepare).mockReturnValue({
    bind: vi.fn().mockReturnValue({
      first: userFirst,
      // Realistic D1 run() shape: the legacy UPDATE and the cc_credentials
      // dual-write both report a row changed, so rotation-path tests exercise
      // the real success path instead of silently hitting the no-op branch.
      run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return userFirst;
}

function expectNoCredentialUpdate(env: ReturnType<typeof createMockEnv>) {
  expect(vi.mocked(env.DATABASE.prepare)).not.toHaveBeenCalledWith(
    expect.stringContaining('UPDATE credentials'),
  );
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

    it.each([
      {
        name: 'token was rotated outside the default grace window',
        setup: () => createDOWithRotatedToken('very-old-refresh', 600_000),
        refreshToken: 'very-old-refresh',
      },
      {
        name: 'token has no grace-window entry',
        setup: async () => {
          const setup = createDO();
          setupCredentialFound(setup.env);
          return setup;
        },
        refreshToken: 'totally-unknown-token',
      },
      {
        name: 'token is older than the configured custom grace window',
        setup: () =>
          createDOWithRotatedToken(
            'recently-rotated',
            2_000,
            { CODEX_REFRESH_GRACE_WINDOW_MS: '1000' },
          ),
        refreshToken: 'recently-rotated',
      },
    ])('returns stale tokens when $name', async ({ setup, refreshToken }) => {
      const { do: doInstance } = await setup();

      const res = await doInstance.fetch(
        makeRequest({
          refreshToken,
          userId: 'user-1',
        }),
      );
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.refresh_token).toBeUndefined();
      expect(json.access_token).toBe('stored-access');
      expect(json.id_token).toBe('stored-id');
      expect(json.stale).toBe(true);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
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
  // CORE FIX — dual-write: rotation must mirror into cc_credentials
  // (regression for the 429 desync: legacy `credentials` was updated but the
  //  composable-credentials `cc_credentials` snapshot stayed frozen at backfill)
  // -----------------------------------------------------------------------

  describe('dual-write — cc_credentials mirror after rotation', () => {
    /**
     * Route the D1 mock across all four statements the rotation path issues:
     *  - `cc_credentials`  → the mirror UPDATE (checked FIRST: the project-scope
     *    variant also contains `att.project_id = ?`, which would otherwise be
     *    swallowed by the project-SELECT route below)
     *  - `UPDATE credentials` → the legacy persist
     *  - `project_id = ?`  → the project-scoped getStoredCredential SELECT
     *  - else              → the user-scoped getStoredCredential SELECT
     */
    function setupDualWriteCredentials(
      env: ReturnType<typeof createMockEnv>,
      opts: { projectId?: string } = {}
    ) {
      const legacyRun = vi.fn().mockResolvedValue({});
      const legacyBind = vi.fn().mockReturnValue({ run: legacyRun });
      // agent-sync reads `result.meta.changes` — must be a real shape, not {}.
      const ccRun = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
      const ccBind = vi.fn().mockReturnValue({ run: ccRun });

      const credRow = {
        id: 'cred-1',
        encrypted_token: 'encrypted-data',
        iv: 'test-iv',
        is_active: 1,
      };
      const projectFirst = vi
        .fn()
        .mockResolvedValue(opts.projectId ? credRow : null);
      const userFirst = vi.fn().mockResolvedValue(credRow);
      const projectSelectBind = vi.fn().mockReturnValue({ first: projectFirst });
      const userSelectBind = vi.fn().mockReturnValue({ first: userFirst });

      let ccSql = '';
      const prepare = vi.fn((sql: string) => {
        if (sql.includes('cc_credentials')) {
          ccSql = sql;
          return { bind: ccBind };
        }
        if (sql.includes('UPDATE credentials')) {
          return { bind: legacyBind };
        }
        if (sql.includes('project_id = ?')) {
          return { bind: projectSelectBind };
        }
        return { bind: userSelectBind };
      });
      vi.mocked(env.DATABASE.prepare).mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        prepare as any
      );
      return {
        legacyBind,
        legacyRun,
        ccBind,
        ccRun,
        projectFirst,
        userFirst,
        getCcSql: () => ccSql,
      };
    }

    it('mirrors the rotated token into cc_credentials for a user-scoped credential', async () => {
      const { do: doInstance, env } = createDO();
      const { legacyBind, ccBind, getCcSql } = setupDualWriteCredentials(env);
      mockSuccessfulRefreshResponse();

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
      );

      expect(res.status).toBe(200);
      // Legacy credentials row updated with the freshly-encrypted ciphertext/iv.
      expect(legacyBind).toHaveBeenCalledWith('new-encrypted', 'new-iv', 'cred-1');
      // cc_credentials mirror updated exactly once with the SAME ciphertext/iv.
      expect(ccBind).toHaveBeenCalledTimes(1);
      const ccArgs = ccBind.mock.calls[0];
      expect(ccArgs[0]).toBe('new-encrypted');
      expect(ccArgs[1]).toBe('new-iv');
      expect(ccArgs).toContain('user-1');
      expect(ccArgs).toContain('openai-codex');
      // (openai-codex, oauth-token) maps to the auth-json cc kind.
      expect(ccArgs).toContain('auth-json');
      // User scope → IS NULL predicate, NOT the project equality predicate.
      expect(getCcSql()).toContain('att.project_id IS NULL');
      expect(getCcSql()).not.toContain('att.project_id = ?');
    });

    it('mirrors the rotated token into the project-scoped cc_credentials row', async () => {
      const { do: doInstance, env } = createDO();
      const { ccBind, getCcSql } = setupDualWriteCredentials(env, {
        projectId: 'proj-a',
      });
      mockSuccessfulRefreshResponse();

      const res = await doInstance.fetch(
        makeRequest({
          refreshToken: 'stored-refresh',
          userId: 'user-1',
          projectId: 'proj-a',
        }),
      );

      expect(res.status).toBe(200);
      expect(ccBind).toHaveBeenCalledTimes(1);
      const ccArgs = ccBind.mock.calls[0];
      expect(ccArgs[0]).toBe('new-encrypted');
      expect(ccArgs[1]).toBe('new-iv');
      // Mirror targets the credential's OWN project scope, not a workspace scope.
      expect(ccArgs).toContain('proj-a');
      // Project scope → equality predicate, NOT the IS NULL fallback.
      expect(getCcSql()).toContain('att.project_id = ?');
    });

    it('vertical slice: legacy and cc_credentials receive identical ciphertext/iv', async () => {
      const { do: doInstance, env } = createDO();
      const { legacyBind, ccBind } = setupDualWriteCredentials(env);
      mockSuccessfulRefreshResponse();

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
      );

      expect(res.status).toBe(200);
      const legacyArgs = legacyBind.mock.calls[0];
      const ccArgs = ccBind.mock.calls[0];
      // The desync bug rotated legacy without cc; the fix re-uses the SAME
      // ciphertext/iv so a freshly-seeded auth.json reflects the rotated token.
      expect(legacyArgs[0]).toBe('new-encrypted');
      expect(legacyArgs[1]).toBe('new-iv');
      expect(ccArgs[0]).toBe(legacyArgs[0]);
      expect(ccArgs[1]).toBe(legacyArgs[1]);
    });

    it('does NOT touch cc_credentials on the stale-token branch', async () => {
      const { do: doInstance, env } = createDO();
      const { legacyBind, ccBind } = setupDualWriteCredentials(env);

      const res = await doInstance.fetch(
        // Mismatched token, no grace entry → stale branch, no rotation.
        makeRequest({ refreshToken: 'rt_stale_token', userId: 'user-1' }),
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.stale).toBe(true);
      // No rotation happened → neither table is written.
      expect(legacyBind).not.toHaveBeenCalled();
      expect(ccBind).not.toHaveBeenCalled();
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it('keeps the refresh successful when the cc_credentials mirror fails (non-fatal)', async () => {
      const { do: doInstance, env } = createDO();
      const { ccRun } = setupDualWriteCredentials(env);
      ccRun.mockRejectedValue(new Error('cc write failed'));
      mockSuccessfulRefreshResponse();

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
      );

      // Legacy persist already succeeded — a cc mirror failure must not 500
      // or withhold the rotated token from the caller.
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.refresh_token).toBe('new-refresh');
      expect(mockLogError).toHaveBeenCalledWith(
        'codex_refresh.cc_sync_failed',
        expect.objectContaining({ userId: 'user-1', credentialId: 'cred-1' }),
      );
      // Invariant: the desync diagnostic must never carry token material —
      // not the encrypted ciphertext, the iv, or any decrypted secret.
      expect(mockLogError).toHaveBeenCalledWith(
        'codex_refresh.cc_sync_failed',
        expect.not.objectContaining({
          encryptedToken: expect.anything(),
          ciphertext: expect.anything(),
          iv: expect.anything(),
        }),
      );
      // Value-content check: even though the freshly-encrypted ciphertext/iv are
      // in lexical scope at the catch block, the serialized log payload must not
      // contain their VALUES under ANY key (e.g. echoed inside an error message).
      const syncFailCall = mockLogError.mock.calls.find(
        (call) => call[0] === 'codex_refresh.cc_sync_failed',
      );
      expect(syncFailCall).toBeDefined();
      const syncFailPayload = JSON.stringify(syncFailCall?.[1] ?? {});
      expect(syncFailPayload).not.toContain('new-encrypted');
      expect(syncFailPayload).not.toContain('new-iv');
      expect(syncFailPayload).not.toContain('new-refresh');
    });

    it('falls back to the user-scoped cc_credentials row when the project row is absent', async () => {
      const { do: doInstance, env } = createDO();
      // projectId supplied to the DO, but getStoredCredential finds NO active
      // project row → it falls back to the user-scoped credential. The mirror
      // must follow that same fallback and target the IS NULL (user) scope,
      // NOT the project equality predicate, or the rotated token lands on a row
      // that resolution never reads.
      const { ccBind, getCcSql, projectFirst, userFirst } =
        setupDualWriteCredentials(env);
      mockSuccessfulRefreshResponse();

      const res = await doInstance.fetch(
        makeRequest({
          refreshToken: 'stored-refresh',
          userId: 'user-1',
          projectId: 'proj-a',
        }),
      );

      expect(res.status).toBe(200);
      // Project SELECT was attempted (returned null) then user SELECT was used.
      expect(projectFirst).toHaveBeenCalled();
      expect(userFirst).toHaveBeenCalled();
      expect(ccBind).toHaveBeenCalledTimes(1);
      const ccArgs = ccBind.mock.calls[0];
      expect(ccArgs[0]).toBe('new-encrypted');
      expect(ccArgs[1]).toBe('new-iv');
      // Fallback scope → IS NULL predicate, never the project equality predicate.
      expect(getCcSql()).toContain('att.project_id IS NULL');
      expect(getCcSql()).not.toContain('att.project_id = ?');
    });

    it('warns codex_refresh.cc_sync_no_row when the mirror matches no row (no token material)', async () => {
      const { do: doInstance, env } = createDO();
      const { ccRun } = setupDualWriteCredentials(env);
      // Legacy rotated, but the cc_credentials UPDATE matched zero rows — the
      // exact silent desync this fix exists to surface.
      ccRun.mockResolvedValue({ meta: { changes: 0 } });
      mockSuccessfulRefreshResponse();

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
      );

      // Still a successful refresh — the legacy persist already succeeded.
      expect(res.status).toBe(200);
      expect(mockLogWarn).toHaveBeenCalledWith(
        'codex_refresh.cc_sync_no_row',
        expect.objectContaining({
          userId: 'user-1',
          credentialId: 'cred-1',
          scopeProjectId: null,
        }),
      );
      // The desync diagnostic must never carry token material.
      expect(mockLogWarn).toHaveBeenCalledWith(
        'codex_refresh.cc_sync_no_row',
        expect.not.objectContaining({
          encryptedToken: expect.anything(),
          ciphertext: expect.anything(),
          iv: expect.anything(),
          refresh_token: expect.anything(),
        }),
      );
      // Value-content check: the serialized payload must not contain the token
      // VALUES under any key, not just exclude the known key names.
      const noRowCall = mockLogWarn.mock.calls.find(
        (call) => call[0] === 'codex_refresh.cc_sync_no_row',
      );
      expect(noRowCall).toBeDefined();
      const noRowPayload = JSON.stringify(noRowCall?.[1] ?? {});
      expect(noRowPayload).not.toContain('new-encrypted');
      expect(noRowPayload).not.toContain('new-iv');
      expect(noRowPayload).not.toContain('new-refresh');
    });

    it('scopes the mirror UPDATE to the credential owner (cross-user defence)', async () => {
      const { do: doInstance, env } = createDO();
      const { getCcSql } = setupDualWriteCredentials(env);
      mockSuccessfulRefreshResponse();

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
      );

      expect(res.status).toBe(200);
      // A shared cc_configurations/cc_attachments row owned by a different user
      // must not be writable: the UPDATE binds owner_id = att.user_id on both
      // the credential and the configuration so a cross-user attachment cannot
      // be the join target.
      const ccSql = getCcSql();
      expect(ccSql).toContain('cred.owner_id = att.user_id');
      expect(ccSql).toContain('cfg.owner_id = att.user_id');
    });

    it('writes NEITHER legacy nor cc_credentials when rate-limited (429)', async () => {
      const windowSeconds = 60;
      const now = Math.floor(Date.now() / 1000);
      const currentWindowStart = Math.floor(now / windowSeconds) * windowSeconds;

      const { do: doInstance, env } = createDO(
        {
          RATE_LIMIT_CODEX_REFRESH_PER_HOUR: '3',
          RATE_LIMIT_CODEX_REFRESH_WINDOW_SECONDS: windowSeconds.toString(),
        },
        {
          'rate-limit:cred-1': { windowStart: currentWindowStart, count: 3 },
        },
      );
      const { legacyBind, ccBind } = setupDualWriteCredentials(env);

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
      );

      expect(res.status).toBe(429);
      // Rate-limit rejection happens before any rotation — so the legacy persist
      // and the cc_credentials mirror must BOTH be untouched. Without this guard
      // a regression that moved the rate-limit check after the rotation could
      // silently rotate (and desync) tokens on every throttled request.
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(legacyBind).not.toHaveBeenCalled();
      expect(ccBind).not.toHaveBeenCalled();
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

      // Rate-limit state must have been written at least once, keyed per-credential.
      expect(ctx.storage.put).toHaveBeenCalledWith(
        'rate-limit:cred-1',
        expect.objectContaining({ count: expect.any(Number) }),
      );
      const stored = ctx.storage._store.get('rate-limit:cred-1') as {
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
          'rate-limit:cred-1': { windowStart: currentWindowStart, count: 3 },
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
      const stored = ctx.storage._store.get('rate-limit:cred-1') as { count: number };
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
          'rate-limit:cred-1': { windowStart: stalePastWindowStart, count: 3 },
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
      const stored = ctx.storage._store.get('rate-limit:cred-1') as {
        count: number;
        windowStart: number;
      };
      // New window — counter reset to 1, windowStart advanced.
      expect(stored.windowStart).toBe(currentWindowStart);
      expect(stored.count).toBe(1);
    });

    it('rate limits per credential — one credential at its limit does not block another', async () => {
      const windowSeconds = 60;
      const now = Math.floor(Date.now() / 1000);
      const currentWindowStart = Math.floor(now / windowSeconds) * windowSeconds;

      // A DIFFERENT credential is already at its limit. cred-1 has no entry.
      const { do: doInstance, env, ctx } = createDO(
        {
          RATE_LIMIT_CODEX_REFRESH_PER_HOUR: '3',
          RATE_LIMIT_CODEX_REFRESH_WINDOW_SECONDS: windowSeconds.toString(),
        },
        {
          'rate-limit:other-cred': { windowStart: currentWindowStart, count: 3 },
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

      // cred-1 is unaffected by other-cred's exhausted bucket.
      expect(res.status).toBe(200);
      const cred1 = ctx.storage._store.get('rate-limit:cred-1') as { count: number };
      expect(cred1.count).toBe(1);
      // The unrelated credential's bucket must be left untouched.
      const otherCred = ctx.storage._store.get('rate-limit:other-cred') as {
        count: number;
      };
      expect(otherCred.count).toBe(3);
    });

    it('stale-token branch does NOT consume rate-limit budget', async () => {
      const { do: doInstance, env, ctx } = createDO({
        RATE_LIMIT_CODEX_REFRESH_PER_HOUR: '5',
      });
      setupCredentialFound(env);

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'rt_stale_token', userId: 'user-1' }),
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.stale).toBe(true);

      // Cached/stale responses must not touch the rate-limit bucket.
      expect(ctx.storage.put).not.toHaveBeenCalledWith(
        'rate-limit:cred-1',
        expect.anything(),
      );
      expect(ctx.storage._store.has('rate-limit:cred-1')).toBe(false);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it('grace-window branch does NOT consume rate-limit budget', async () => {
      const { do: doInstance, ctx } = await createDOWithRotatedToken(
        'old-refresh',
        60_000,
        { RATE_LIMIT_CODEX_REFRESH_PER_HOUR: '5' },
      );

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'old-refresh', userId: 'user-1' }),
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.refresh_token).toBe('stored-refresh');

      // Grace-window hits return stored tokens directly — no budget consumed.
      expect(ctx.storage.put).not.toHaveBeenCalledWith(
        'rate-limit:cred-1',
        expect.anything(),
      );
      expect(ctx.storage._store.has('rate-limit:cred-1')).toBe(false);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // MEDIUM #6 — Scope anomaly detection (alert-only; a completed rotation is NEVER discarded)
  // -----------------------------------------------------------------------

  describe('MEDIUM #6 — scope anomaly detection (alert-only)', () => {
    it('persists the rotation and raises a durable diagnostic on unexpected scope (regression: block-and-discard stranded token families)', async () => {
      const { do: doInstance, env } = createDO({
        CODEX_EXPECTED_SCOPES: 'openid,offline_access',
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

      // The rotated tokens are delivered — OpenAI already consumed the old
      // refresh token, so the caller must receive its successor.
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.refresh_token).toBe('new-refresh');
      expect(json.access_token).toBe('new-access');

      // The rotation is persisted to the legacy row AND mirrored to cc_credentials
      // in the same operation — a scope anomaly must never strand the family.
      expect(vi.mocked(encrypt)).toHaveBeenCalled();
      expect(vi.mocked(env.DATABASE.prepare)).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE credentials'),
      );
      expect(vi.mocked(env.DATABASE.prepare)).toHaveBeenCalledWith(
        expect.stringContaining('cc_credentials'),
      );

      // The anomaly is loudly reported: structured error log + durable diagnostic
      // (Workers Logs are 1%-sampled — the durable write is the real alert).
      expect(mockLogError).toHaveBeenCalledWith(
        'codex_refresh.unexpected_scopes_detected',
        expect.objectContaining({ unexpectedScopes: 'admin:write' }),
      );
      expect(vi.mocked(persistError)).toHaveBeenCalledWith(
        env.OBSERVABILITY_DATABASE,
        expect.objectContaining({
          message: 'codex_refresh.unexpected_scopes_detected',
          level: 'error',
          userId: 'user-1',
          context: expect.objectContaining({ unexpectedScopes: 'admin:write' }),
        }),
      );
      // The diagnostic payload never contains token material.
      const diagnosticInput = vi.mocked(persistError).mock.calls[0]?.[1];
      expect(JSON.stringify(diagnosticInput)).not.toContain('new-refresh');
      expect(JSON.stringify(diagnosticInput)).not.toContain('new-access');
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

    it('accepts the full codex 0.144.x login scope set under the default allowlist (regression: connector scopes burned every fresh credential)', async () => {
      // Omit CODEX_EXPECTED_SCOPES entirely — DO must apply DEFAULT_EXPECTED_SCOPES,
      // which must cover everything a current `codex login` grant returns.
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
            id_token: 'new-id',
            // Exact scope set requested by codex-rs login (rust-v0.144.6
            // build_authorize_url) — echoed back on refresh responses.
            scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.refresh_token).toBe('new-refresh');
      expect(vi.mocked(encrypt)).toHaveBeenCalled();
      // Conforming scopes: no anomaly log, no durable diagnostic.
      expect(mockLogError).not.toHaveBeenCalledWith(
        'codex_refresh.unexpected_scopes_detected',
        expect.anything(),
      );
      expect(vi.mocked(persistError)).not.toHaveBeenCalled();
    });

    it('flags scopes outside the default allowlist when CODEX_EXPECTED_SCOPES is unset — and still persists', async () => {
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
            scope: 'openid offline_access admin:write', // admin:write unexpected by default
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.refresh_token).toBe('new-refresh');
      expect(vi.mocked(encrypt)).toHaveBeenCalled();
      expect(vi.mocked(env.DATABASE.prepare)).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE credentials'),
      );
      expect(mockLogError).toHaveBeenCalledWith(
        'codex_refresh.unexpected_scopes_detected',
        expect.objectContaining({ unexpectedScopes: 'admin:write' }),
      );
      expect(vi.mocked(persistError)).toHaveBeenCalledWith(
        env.OBSERVABILITY_DATABASE,
        expect.objectContaining({
          message: 'codex_refresh.unexpected_scopes_detected',
        }),
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
      // Detection fully disabled: no anomaly log, no durable diagnostic.
      expect(mockLogError).not.toHaveBeenCalledWith(
        'codex_refresh.unexpected_scopes_detected',
        expect.anything(),
      );
      expect(vi.mocked(persistError)).not.toHaveBeenCalled();
    });

    it('flags non-string scope values without blocking the rotation', async () => {
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
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.refresh_token).toBe('new-refresh');
      expect(vi.mocked(encrypt)).toHaveBeenCalled();
      expect(mockLogWarn).toHaveBeenCalledWith(
        'codex_refresh.scope_validation_nonstring',
        expect.objectContaining({ scopeType: 'number' }),
      );
      expect(vi.mocked(persistError)).toHaveBeenCalledWith(
        env.OBSERVABILITY_DATABASE,
        expect.objectContaining({
          message: 'codex_refresh.unexpected_scopes_detected',
          context: expect.objectContaining({
            unexpectedScopes: '<non-string:number>',
          }),
        }),
      );
    });

    it('ignores the removed CODEX_SCOPE_VALIDATION_MODE env var — detection stays alert-only', async () => {
      // The historical mode knob must not resurrect blocking behavior: even with
      // a value set, an anomalous refresh persists and alerts.
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
            scope: 'openid admin:write',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
      );
      expect(res.status).toBe(200);
      expect(vi.mocked(encrypt)).toHaveBeenCalled();
      expect(vi.mocked(persistError)).toHaveBeenCalledWith(
        env.OBSERVABILITY_DATABASE,
        expect.objectContaining({ message: 'codex_refresh.unexpected_scopes_detected' }),
      );
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

  it('parses OpenAI nested error form and surfaces refresh_token_invalidated (revoked token diagnostic)', async () => {
    const { do: doInstance, env } = createDO();
    setupCredentialFound(env);
    mockLogWarn.mockClear();

    // OpenAI returns the NESTED error shape (not flat OAuth2), which is what a
    // revoked/logged-out token produces in production:
    //   { error: { message, type, param, code } }
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({
        error: {
          message: 'Your session has ended. Please log in again.',
          type: 'invalid_request_error',
          param: null,
          code: 'refresh_token_invalidated',
        },
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await doInstance.fetch(
      makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    // The nested code is surfaced as the forwarded error.
    expect(json.error).toBe('refresh_token_invalidated');
    expect(json.error_description).toBe('Your session has ended. Please log in again.');

    // Structured diagnostic captures the rejection reason — and NEVER the raw body.
    const warnCall = mockLogWarn.mock.calls.find(
      ([event]) => event === 'codex_refresh.upstream_rejected',
    );
    expect(warnCall).toBeDefined();
    const fields = warnCall?.[1] as Record<string, unknown>;
    expect(fields.upstreamErrorCode).toBe('refresh_token_invalidated');
    expect(fields.upstreamErrorMessage).toBe('Your session has ended. Please log in again.');
    expect(fields.status).toBe(401);
    // No raw-body field is logged (refresh token can never leak).
    expect(fields).not.toHaveProperty('rawBodySample');

    // Family-fatal rejection → durable diagnostic (Workers Logs are 1%-sampled,
    // so the warn log alone left the 2026-07 incidents invisible for days).
    expect(vi.mocked(persistError)).toHaveBeenCalledWith(
      env.OBSERVABILITY_DATABASE,
      expect.objectContaining({
        message: 'codex_refresh.family_fatal_rejection',
        level: 'error',
        userId: 'user-1',
        context: expect.objectContaining({
          upstreamErrorCode: 'refresh_token_invalidated',
        }),
      }),
    );
  });

  it('persists a durable diagnostic on refresh_token_reused and leaves the stored credential untouched', async () => {
    const { do: doInstance, env } = createDO();
    setupCredentialFound(env);

    // OpenAI reuse detection: the presented one-time-use token was already
    // exchanged — the family is stranded until the user re-links.
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({
        error: {
          message: 'Your refresh token was already used.',
          type: 'invalid_request_error',
          param: null,
          code: 'refresh_token_reused',
        },
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await doInstance.fetch(
      makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('refresh_token_reused');

    expect(vi.mocked(persistError)).toHaveBeenCalledWith(
      env.OBSERVABILITY_DATABASE,
      expect.objectContaining({
        message: 'codex_refresh.family_fatal_rejection',
        context: expect.objectContaining({ upstreamErrorCode: 'refresh_token_reused' }),
      }),
    );
    // A failed refresh must not touch the stored credential.
    expect(vi.mocked(encrypt)).not.toHaveBeenCalled();
    expectNoCredentialUpdate(env);
    // The diagnostic payload never contains the refresh token.
    const diagnosticInput = vi.mocked(persistError).mock.calls[0]?.[1];
    expect(JSON.stringify(diagnosticInput)).not.toContain('stored-refresh');
  });

  it('persists a durable diagnostic on refresh_token_expired (third family-fatal code)', async () => {
    const { do: doInstance, env } = createDO();
    setupCredentialFound(env);

    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({
        error: {
          message: 'Your refresh token has expired.',
          type: 'invalid_request_error',
          param: null,
          code: 'refresh_token_expired',
        },
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await doInstance.fetch(
      makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
    );
    expect(res.status).toBe(401);
    expect(vi.mocked(persistError)).toHaveBeenCalledWith(
      env.OBSERVABILITY_DATABASE,
      expect.objectContaining({
        message: 'codex_refresh.family_fatal_rejection',
        context: expect.objectContaining({ upstreamErrorCode: 'refresh_token_expired' }),
      }),
    );
  });

  it('persists the rotation even when the grace-window stash write fails (storage failure must not strand the family)', async () => {
    const { do: doInstance, env, ctx } = createDO();
    setupCredentialFound(env);
    mockSuccessfulRefreshResponse();

    // DO storage put fails ONLY for the rotated-tokens grace stash (the
    // rate-limiter's earlier put must succeed so the flow reaches the upstream).
    vi.mocked(ctx.storage.put).mockImplementation(async (key: string, value: unknown) => {
      if (key === 'rotated-tokens') throw new Error('storage unavailable');
      ctx.storage._store.set(key, value);
    });

    const res = await doInstance.fetch(
      makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.refresh_token).toBe('new-refresh');
    expect(vi.mocked(env.DATABASE.prepare)).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE credentials'),
    );
    expect(mockLogWarn).toHaveBeenCalledWith(
      'codex_refresh.grace_stash_failed',
      expect.objectContaining({ userId: 'user-1' }),
    );
  });

  it('does not persist diagnostics for transient (non-family-fatal) upstream errors', async () => {
    const { do: doInstance, env } = createDO();
    setupCredentialFound(env);

    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await doInstance.fetch(
      makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
    );
    expect(res.status).toBe(503);
    expect(vi.mocked(persistError)).not.toHaveBeenCalled();
  });

  it('persists a completed rotation even when the lock timeout fires after the upstream exchange (never discard a consumed one-time-use token)', async () => {
    // Lock timeout fires at 1ms; the upstream "completes" at ~25ms. Pre-fix,
    // an abort check between upstream success and the DB write threw and
    // discarded the rotation (504) — stranding the family exactly like the
    // scope gate did. Post-fix the rotation persists and the caller gets tokens.
    const { do: doInstance, env } = createDO({ CODEX_REFRESH_LOCK_TIMEOUT_MS: '1' });
    setupCredentialFound(env);

    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve(
                new Response(
                  JSON.stringify({
                    access_token: 'new-access',
                    refresh_token: 'new-refresh',
                    id_token: 'new-id',
                  }),
                  { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
              ),
            25,
          );
        }),
    );

    const res = await doInstance.fetch(
      makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.refresh_token).toBe('new-refresh');
    expect(vi.mocked(env.DATABASE.prepare)).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE credentials'),
    );
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

  // -----------------------------------------------------------------------
  // Concurrency serialization (theory A: one-time-use refresh token replay)
  //
  // A Durable Object does NOT serialize concurrent `async fetch()` handlers
  // across `await` points. Two workspaces for the same user can issue
  // overlapping refreshes. OpenAI rotates the one-time-use refresh_token on
  // first use and revokes the whole token family if the consumed token is
  // replayed. So the SECOND overlapping request MUST NOT POST the same token
  // to OpenAI — it must observe the rotated stored credential and take the
  // grace-window handoff path instead. Without the in-DO refreshLock mutex,
  // both requests read the pre-rotation token and both hit OpenAI (2 fetches),
  // replaying a consumed token. With the mutex, exactly ONE fetch occurs.
  // -----------------------------------------------------------------------

  it('serializes concurrent refreshes: consumed token is not replayed to OpenAI', async () => {
    const { do: doInstance, env } = createDO();
    setupCredentialFound(env);

    // Model the stored credential rotating in the DB. `decrypt` returns the
    // CURRENT stored auth.json; `encrypt` (the write step after a successful
    // OpenAI refresh) advances the stored refresh_token to the rotated value —
    // exactly what writing the new auth.json to D1 does in production.
    let currentRefresh = 'stored-refresh';
    vi.mocked(decrypt).mockImplementation(async () =>
      JSON.stringify({
        tokens: {
          access_token: 'stored-access',
          refresh_token: currentRefresh,
          id_token: 'stored-id',
        },
      }),
    );
    vi.mocked(encrypt).mockImplementation(async () => {
      currentRefresh = 'new-refresh';
      return { ciphertext: 'new-encrypted', iv: 'new-iv' };
    });

    // OpenAI returns the rotated token set. If this is called more than once,
    // the second call is a replay of a consumed token (the bug).
    mockSuccessfulRefreshResponse({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      id_token: 'new-id',
    });

    // Two overlapping refreshes for the same user, both presenting the
    // pre-rotation token.
    const [resA, resB] = await Promise.all([
      doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
      ),
      doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }),
      ),
    ]);

    // The consumed token must be presented to OpenAI exactly once.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const jsonA = await resA.json();
    const jsonB = await resB.json();

    // Both callers receive a usable rotated refresh_token (one from the real
    // refresh, one via the grace-window handoff) — neither is forced to re-auth.
    expect(jsonA.refresh_token).toBe('new-refresh');
    expect(jsonB.refresh_token).toBe('new-refresh');

    // The queued second request took the grace-window path rather than hitting
    // OpenAI again.
    expect(mockLogInfo).toHaveBeenCalledWith(
      'codex_refresh.grace_window_hit',
      expect.objectContaining({ userId: 'user-1' }),
    );
  });
});
