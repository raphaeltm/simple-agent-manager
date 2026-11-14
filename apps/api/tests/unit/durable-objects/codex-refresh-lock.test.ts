/**
 * Unit tests for the CodexRefreshLock Durable Object, against a real SQLite engine
 * and real AES-GCM encryption (rule 28: credential predicates need a real SQL engine).
 *
 * Covers:
 *  - Method + payload validation
 *  - CRITICAL #1: stale-token branch does not return `refresh_token`
 *  - Which credential: only the run's candidates, chosen by possession; inactive
 *    candidates are never replaced; several candidates without proof get nothing
 *  - Write-back: compare-and-set on the ciphertext read; mirrors only copies of the
 *    same credential generation; a default switch mid-refresh is left intact
 *  - Grace entries are bound to the credential they were rotated out of
 *  - MEDIUM #5: rate-limit state held in `ctx.storage` (atomic, keyed per-credential),
 *    429 with Retry-After on exceed; cached/grace/stale responses do not consume budget
 *  - MEDIUM #6: upstream scope validation (block by default; empty allowlist is explicit opt-out)
 *  - Decrypt/parse failure handling
 *  - Upstream error paths (timeout, network, filtered error body)
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { decrypt, encrypt } from '../../../src/services/encryption';
import { credentialGenerationFingerprint } from '../../../src/services/run-agent-credential';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

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

// Mock logger
const { mockLogWarn, mockLogInfo, mockLogError } = vi.hoisted(() => ({
  mockLogWarn: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogError: vi.fn(),
}));
vi.mock('../../../src/lib/logger', () => ({
  log: {
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
  },
}));

const { CodexRefreshLock } = await import('../../../src/durable-objects/codex-refresh-lock');

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

const ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const USER = 'user-1';
const DEFAULT_REF = 'cc_credentials:cred-1';

let sqlite: Database.Database;

function createMockEnv(overrides: Record<string, unknown> = {}) {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  return {
    DATABASE: createSqliteD1(sqlite),
    ENCRYPTION_KEY,
    // Disable scope validation by default for tests that don't exercise it —
    // individual tests re-enable with CODEX_EXPECTED_SCOPES overrides.
    CODEX_EXPECTED_SCOPES: '',
    ...overrides,
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
  envOverrides: Record<string, unknown> = {}
) {
  const setup = createDO(envOverrides);
  await setupCredentialFound(setup.env);
  await addGraceEntry(setup.ctx, token, ageMs);
  return setup;
}

/** A DO request; defaults the candidate list to the seeded default cc row. */
function makeRequest(payload: Record<string, unknown>): Request {
  const body =
    'credentialReferences' in payload
      ? payload
      : { ...payload, credentialReferences: [DEFAULT_REF] };
  return new Request('https://do-internal/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const codexAuth = (prefix: string, accountId = `acct-${prefix}`) =>
  JSON.stringify({
    tokens: {
      access_token: `${prefix}-access`,
      refresh_token: `${prefix}-refresh`,
      id_token: `${prefix}-id`,
      account_id: accountId,
    },
  });

const storedAuthJson = codexAuth('stored');

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** The generation fingerprint of a row as currently stored. */
async function generationOf(reference: string): Promise<string> {
  const [table, id] = reference.split(':') as ['cc_credentials' | 'credentials', string];
  const row = sqlite
    .prepare(`SELECT encrypted_token AS t, iv FROM ${table} WHERE id = ?`)
    .get(id) as { t: string; iv: string };
  return credentialGenerationFingerprint(row.t, row.iv);
}

/**
 * Add a grace entry as a completed rotation would leave it: the old token's hash,
 * the credential it was rotated out of, and the generation now stored there.
 * Pass `generation: null` for an entry without one (written before the binding).
 */
async function addGraceEntry(
  ctx: ReturnType<typeof createMockCtx>,
  token: string,
  ageMs: number,
  credentialReference: string | null = DEFAULT_REF,
  generation?: string | null
) {
  const entry: Record<string, unknown> = {
    tokenHash: await sha256Hex(token),
    rotatedAt: Date.now() - ageMs,
  };
  if (credentialReference) entry.credentialReference = credentialReference;
  const successorGeneration =
    generation === undefined && credentialReference
      ? await generationOf(credentialReference)
      : generation;
  if (successorGeneration) entry.successorGeneration = successorGeneration;
  const existing = (ctx.storage._store.get('rotated-tokens') as unknown[]) ?? [];
  ctx.storage._store.set('rotated-tokens', [...existing, entry]);
}

function mockSuccessfulRefreshResponse(
  tokens: Record<string, string> = {
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    id_token: 'new-id',
  }
) {
  vi.mocked(fetch).mockImplementation(
    async () =>
      new Response(JSON.stringify(tokens), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
  );
}

async function seedLegacy(
  id: string,
  plaintext: string,
  opts: {
    userId?: string;
    projectId?: string | null;
    active?: boolean;
    copyOf?: { ciphertext: string; iv: string };
  } = {}
) {
  const { ciphertext, iv } = opts.copyOf ?? (await encrypt(plaintext, ENCRYPTION_KEY));
  sqlite
    .prepare(
      `INSERT INTO credentials (id, user_id, project_id, provider, credential_type, agent_type,
         credential_kind, is_active, encrypted_token, iv, created_at, updated_at)
       VALUES (?, ?, ?, 'openai-codex', 'agent-api-key', 'openai-codex', 'oauth-token', ?, ?, ?, 'old', 'old')`
    )
    .run(
      id,
      opts.userId ?? USER,
      opts.projectId ?? null,
      opts.active === false ? 0 : 1,
      ciphertext,
      iv
    );
  return { ciphertext, iv };
}

/** A cc credential row; pass `copyOf` to store the exact ciphertext of another row. */
async function seedCc(
  id: string,
  plaintext: string,
  opts: {
    owner?: string;
    active?: boolean;
    kind?: string;
    copyOf?: { ciphertext: string; iv: string };
  } = {}
) {
  const { ciphertext, iv } = opts.copyOf ?? (await encrypt(plaintext, ENCRYPTION_KEY));
  sqlite
    .prepare(
      `INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'old', 'old')`
    )
    .run(
      id,
      opts.owner ?? USER,
      id,
      opts.kind ?? 'auth-json',
      ciphertext,
      iv,
      opts.active === false ? 0 : 1
    );
  return { ciphertext, iv };
}

/** The user's default cc credential `cred-1` holding `storedAuthJson`. */
async function setupCredentialFound(_env?: unknown) {
  return seedCc('cred-1', storedAuthJson);
}

async function secretOf(table: 'credentials' | 'cc_credentials', id: string): Promise<string> {
  const row = sqlite
    .prepare(`SELECT encrypted_token AS t, iv FROM ${table} WHERE id = ?`)
    .get(id) as {
    t: string;
    iv: string;
  };
  return decrypt(row.t, row.iv, ENCRYPTION_KEY);
}

async function expectNoCredentialUpdate(_env?: unknown) {
  expect(await secretOf('cc_credentials', 'cred-1')).toBe(storedAuthJson);
}

async function expectCredentialUpdated() {
  expect(await secretOf('cc_credentials', 'cred-1')).not.toBe(storedAuthJson);
}

describe('CodexRefreshLock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    sqlite?.close();
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
    const res = await doInstance.fetch(makeRequest({ refreshToken: 'rt_test' }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_request');
  });

  // -----------------------------------------------------------------------
  // No credential
  // -----------------------------------------------------------------------

  it('returns 401 when no credential is found for user', async () => {
    const { do: doInstance } = createDO();
    const res = await doInstance.fetch(makeRequest({ refreshToken: 'rt_test', userId: 'user-1' }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('refresh_token_invalidated');
  });

  // -----------------------------------------------------------------------
  // Decrypt / parse failure
  // -----------------------------------------------------------------------

  it('returns 500 when credential decryption fails', async () => {
    const { do: doInstance } = createDO();
    // Ciphertext that does not authenticate under the key.
    sqlite
      .prepare(
        `INSERT INTO cc_credentials (id, owner_id, name, kind, is_active, encrypted_token, iv)
           VALUES ('cred-1', ?, 'cred-1', 'auth-json', 1, 'AAAAAAAAAAAAAAAAAAAAAA==', 'AAAAAAAAAAAAAAAA')`
      )
      .run(USER);

    const res = await doInstance.fetch(makeRequest({ refreshToken: 'rt_test', userId: 'user-1' }));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('internal_error');
    expect(json.message).toContain('decrypt');
  });

  it('returns 500 when stored credential is not valid JSON', async () => {
    const { do: doInstance } = createDO();
    await seedCc('cred-1', 'not-json{{{');

    const res = await doInstance.fetch(makeRequest({ refreshToken: 'rt_test', userId: 'user-1' }));
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
    await setupCredentialFound(env);

    const res = await doInstance.fetch(
      makeRequest({
        refreshToken: 'rt_stale_token', // does not match 'stored-refresh'
        userId: 'user-1',
      })
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
        })
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
        expect.objectContaining({ userId: 'user-1' })
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
          await setupCredentialFound(setup.env);
          return setup;
        },
        refreshToken: 'totally-unknown-token',
      },
      {
        name: 'token is older than the configured custom grace window',
        setup: () =>
          createDOWithRotatedToken('recently-rotated', 2_000, {
            CODEX_REFRESH_GRACE_WINDOW_MS: '1000',
          }),
        refreshToken: 'recently-rotated',
      },
    ])('returns stale tokens when $name', async ({ setup, refreshToken }) => {
      const { do: doInstance } = await setup();

      const res = await doInstance.fetch(
        makeRequest({
          refreshToken,
          userId: 'user-1',
        })
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
      await setupCredentialFound(env);
      mockSuccessfulRefreshResponse();

      await doInstance.fetch(
        makeRequest({
          refreshToken: 'stored-refresh', // matches stored → fresh path
          userId: 'user-1',
        })
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
      await setupCredentialFound(env);
      mockSuccessfulRefreshResponse({
        access_token: 'new-access',
        refresh_token: 'stored-refresh',
        id_token: 'new-id',
      });

      await doInstance.fetch(
        makeRequest({
          refreshToken: 'stored-refresh',
          userId: 'user-1',
        })
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
    await setupCredentialFound(env);

    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          id_token: 'new-id',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const res = await doInstance.fetch(
      makeRequest({
        refreshToken: 'stored-refresh',
        userId: 'user-1',
      })
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

    // Credential re-encrypted and persisted into the same row.
    const stored = JSON.parse(await secretOf('cc_credentials', 'cred-1'));
    expect(stored.tokens).toMatchObject({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      id_token: 'new-id',
      account_id: 'acct-stored',
    });
  });

  // -----------------------------------------------------------------------
  // Which credential is served — only the run's candidates, chosen by possession
  // -----------------------------------------------------------------------

  describe('which credential is served', () => {
    const PINNED_REF = 'cc_credentials:cred-pinned';
    const pinnedAuth = codexAuth('pinned');

    it('refreshes a cc-only pinned account against its own row and leaves the default alone', async () => {
      const { do: doInstance } = createDO();
      await setupCredentialFound(); // the user's default (legacy row)
      await seedCc('cred-pinned', pinnedAuth);
      mockSuccessfulRefreshResponse({ access_token: 'p2-access', refresh_token: 'p2-refresh' });

      const res = await doInstance.fetch(
        makeRequest({
          refreshToken: 'pinned-refresh',
          userId: USER,
          credentialReferences: [PINNED_REF],
        })
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.access_token).toBe('p2-access');
      expect(json.refresh_token).toBe('p2-refresh');
      const upstreamBody = JSON.parse(vi.mocked(fetch).mock.calls[0]?.[1]?.body as string);
      expect(upstreamBody.refresh_token).toBe('pinned-refresh');
      const pinned = JSON.parse(await secretOf('cc_credentials', 'cred-pinned'));
      expect(pinned.tokens).toMatchObject({
        refresh_token: 'p2-refresh',
        account_id: 'acct-pinned',
      });
      await expectNoCredentialUpdate();
    });

    it('answers a stale token on a pinned run with the pinned account only, and no refresh_token', async () => {
      const { do: doInstance } = createDO();
      await setupCredentialFound();
      await seedCc('cred-pinned', pinnedAuth);

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'unknown', userId: USER, credentialReferences: [PINNED_REF] })
      );

      const json = await res.json();
      expect(json).toEqual({ access_token: 'pinned-access', id_token: 'pinned-id', stale: true });
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it('chooses among several candidates by the refresh token the caller holds', async () => {
      const { do: doInstance } = createDO();
      await seedCc('cred-a', codexAuth('a'));
      await seedCc('cred-b', codexAuth('b'));
      mockSuccessfulRefreshResponse({ access_token: 'b2-access', refresh_token: 'b2-refresh' });

      const res = await doInstance.fetch(
        makeRequest({
          refreshToken: 'b-refresh',
          userId: USER,
          credentialReferences: ['cc_credentials:cred-a', 'cc_credentials:cred-b'],
        })
      );

      expect(res.status).toBe(200);
      expect(JSON.parse(await secretOf('cc_credentials', 'cred-b')).tokens.refresh_token).toBe(
        'b2-refresh'
      );
      expect(await secretOf('cc_credentials', 'cred-a')).toBe(codexAuth('a'));
    });

    it('hands out nothing when several candidates exist and the caller proves none', async () => {
      const { do: doInstance } = createDO();
      await seedCc('cred-a', codexAuth('a'));
      await seedCc('cred-b', codexAuth('b'));

      const res = await doInstance.fetch(
        makeRequest({
          refreshToken: 'unknown',
          userId: USER,
          credentialReferences: ['cc_credentials:cred-a', 'cc_credentials:cred-b'],
        })
      );

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'refresh_token_invalidated' });
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it('an inactive pinned credential is not replaced by the active default', async () => {
      const { do: doInstance } = createDO();
      await setupCredentialFound();
      await seedCc('cred-pinned', pinnedAuth, { active: false });

      const res = await doInstance.fetch(
        makeRequest({
          refreshToken: 'pinned-refresh',
          userId: USER,
          credentialReferences: [PINNED_REF],
        })
      );

      expect(res.status).toBe(401);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(await secretOf('cc_credentials', 'cred-pinned')).toBe(pinnedAuth);
      await expectNoCredentialUpdate();
    });

    it.each([
      { owner: 'user-2', status: 401 },
      { owner: USER, status: 200 },
    ])(
      'reads a candidate only when it belongs to the caller (owner $owner)',
      async ({ owner, status }) => {
        const { do: doInstance } = createDO();
        await seedCc('cred-pinned', pinnedAuth, { owner });
        mockSuccessfulRefreshResponse();

        const res = await doInstance.fetch(
          makeRequest({
            refreshToken: 'pinned-refresh',
            userId: USER,
            credentialReferences: [PINNED_REF],
          })
        );

        expect(res.status).toBe(status);
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
      }
    );

    it('never serves a platform credential reference', async () => {
      const { do: doInstance } = createDO();
      await setupCredentialFound();

      const res = await doInstance.fetch(
        makeRequest({
          refreshToken: 'stored-refresh',
          userId: USER,
          credentialReferences: ['platform_credentials:plat-1'],
        })
      );

      expect(res.status).toBe(401);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it('a recorded credential that became unreadable keeps the stale path closed', async () => {
      const { do: doInstance } = createDO();
      await seedCc('cred-a', codexAuth('a'), { active: false });
      await seedCc('cred-b', codexAuth('b'));

      // A's run presents A's token; A is now inactive and must not be answered with B.
      const res = await doInstance.fetch(
        makeRequest({
          refreshToken: 'a-refresh',
          userId: USER,
          credentialReferences: ['cc_credentials:cred-a', 'cc_credentials:cred-b'],
        })
      );

      expect(res.status).toBe(401);
      expect(JSON.stringify(await res.json())).not.toContain('b-');
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it('a legacy credential never answers a stale token (it can be rewritten in place)', async () => {
      const { do: doInstance } = createDO();
      await seedLegacy('legacy-1', codexAuth('legacy'));

      const res = await doInstance.fetch(
        makeRequest({
          refreshToken: 'unknown',
          userId: USER,
          credentialReferences: ['credentials:legacy-1'],
        })
      );

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'refresh_token_invalidated' });
    });

    it('control: a legacy credential still refreshes when the caller holds its token', async () => {
      const { do: doInstance } = createDO();
      await seedLegacy('legacy-1', codexAuth('legacy'));
      mockSuccessfulRefreshResponse();

      const res = await doInstance.fetch(
        makeRequest({
          refreshToken: 'legacy-refresh',
          userId: USER,
          credentialReferences: ['credentials:legacy-1'],
        })
      );

      expect(res.status).toBe(200);
      expect(JSON.parse(await secretOf('credentials', 'legacy-1')).tokens.refresh_token).toBe(
        'new-refresh'
      );
    });

    it('returns 400 when the candidate list is missing or empty', async () => {
      const { do: doInstance } = createDO();
      for (const credentialReferences of [undefined, [], [''], [42]]) {
        const res = await doInstance.fetch(
          makeRequest({ refreshToken: 'stored-refresh', userId: USER, credentialReferences })
        );
        expect(res.status).toBe(400);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Write-back — compare-and-set on the ciphertext read, mirror by identity
  // -----------------------------------------------------------------------

  describe('write-back', () => {
    it('rotates every stored copy of the same credential generation, and no other account', async () => {
      const { do: doInstance } = createDO();
      const original = await setupCredentialFound();
      await seedLegacy('legacy-copy', storedAuthJson, { copyOf: original });
      await seedCc('cred-other', codexAuth('other'));
      mockSuccessfulRefreshResponse();

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: USER })
      );

      expect(res.status).toBe(200);
      const primary = await secretOf('cc_credentials', 'cred-1');
      expect(JSON.parse(primary).tokens.refresh_token).toBe('new-refresh');
      // The legacy copy now holds exactly the same ciphertext as the primary.
      expect(await secretOf('credentials', 'legacy-copy')).toBe(primary);
      expect(await secretOf('cc_credentials', 'cred-other')).toBe(codexAuth('other'));
      expect(mockLogInfo).toHaveBeenCalledWith(
        'codex_refresh.rotation_stored',
        expect.objectContaining({ credentialReference: DEFAULT_REF, mirroredRows: 1 })
      );
    });

    it('does not mirror into a row of another user holding the same ciphertext', async () => {
      const { do: doInstance } = createDO();
      const original = await setupCredentialFound();
      await seedCc('cred-foreign', storedAuthJson, { copyOf: original, owner: 'user-2' });
      mockSuccessfulRefreshResponse();

      await doInstance.fetch(makeRequest({ refreshToken: 'stored-refresh', userId: USER }));

      expect(await secretOf('cc_credentials', 'cred-foreign')).toBe(storedAuthJson);
    });

    it('a concurrent write while OpenAI answers is left intact (CAS lost)', async () => {
      const { do: doInstance, ctx } = createDO();
      const original = await setupCredentialFound();
      await seedLegacy('legacy-copy', storedAuthJson, { copyOf: original });
      const switched = await encrypt(codexAuth('switched'), ENCRYPTION_KEY);
      vi.mocked(fetch).mockImplementation(async () => {
        // Another writer (a credential sync, a replacement) changes the row mid-refresh.
        sqlite
          .prepare(`UPDATE cc_credentials SET encrypted_token = ?, iv = ? WHERE id = 'cred-1'`)
          .run(switched.ciphertext, switched.iv);
        return new Response(
          JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh' }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      });

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: USER })
      );

      // The caller proved possession and still gets its own successor tokens.
      expect(res.status).toBe(200);
      expect((await res.json()).refresh_token).toBe('new-refresh');
      expect(await secretOf('cc_credentials', 'cred-1')).toBe(codexAuth('switched'));
      // A lost compare-and-set mirrors nothing and records no grace entry.
      expect(await secretOf('credentials', 'legacy-copy')).toBe(storedAuthJson);
      expect(ctx.storage._store.get('rotated-tokens')).toBeUndefined();
      expect(mockLogWarn).toHaveBeenCalledWith(
        'codex_refresh.rotation_cas_lost',
        expect.objectContaining({ credentialReference: DEFAULT_REF })
      );
    });

    it('a pin deactivated while OpenAI answers is not written', async () => {
      const { do: doInstance } = createDO();
      await seedCc('cred-pinned', codexAuth('pinned'));
      vi.mocked(fetch).mockImplementation(async () => {
        sqlite.prepare(`UPDATE cc_credentials SET is_active = 0 WHERE id = 'cred-pinned'`).run();
        return new Response(JSON.stringify({ access_token: 'x', refresh_token: 'y' }), {
          status: 200,
        });
      });

      await doInstance.fetch(
        makeRequest({
          refreshToken: 'pinned-refresh',
          userId: USER,
          credentialReferences: ['cc_credentials:cred-pinned'],
        })
      );

      // Liveness: the race window was reached and the CAS rejected the write.
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      expect(mockLogWarn).toHaveBeenCalledWith(
        'codex_refresh.rotation_cas_lost',
        expect.objectContaining({ credentialReference: 'cc_credentials:cred-pinned' })
      );
      expect(await secretOf('cc_credentials', 'cred-pinned')).toBe(codexAuth('pinned'));
    });

    it('overlapping refreshes of two accounts of one user each rotate their own account once', async () => {
      const { do: doInstance } = createDO();
      await seedCc('cred-a', codexAuth('a'));
      await seedCc('cred-b', codexAuth('b'));
      vi.mocked(fetch).mockImplementation(async (_url, init) => {
        const presented = JSON.parse(String(init?.body)).refresh_token as string;
        const who = presented.replace(/-refresh$/, '');
        return new Response(
          JSON.stringify({ access_token: `${who}2-access`, refresh_token: `${who}2-refresh` }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const [resA, resB] = await Promise.all([
        doInstance.fetch(
          makeRequest({
            refreshToken: 'a-refresh',
            userId: USER,
            credentialReferences: ['cc_credentials:cred-a'],
          })
        ),
        doInstance.fetch(
          makeRequest({
            refreshToken: 'b-refresh',
            userId: USER,
            credentialReferences: ['cc_credentials:cred-b'],
          })
        ),
      ]);

      expect((await resA.json()).refresh_token).toBe('a2-refresh');
      expect((await resB.json()).refresh_token).toBe('b2-refresh');
      const presented = vi
        .mocked(fetch)
        .mock.calls.map(([, init]) => JSON.parse(String(init?.body)).refresh_token)
        .sort();
      expect(presented).toEqual(['a-refresh', 'b-refresh']);
      expect(JSON.parse(await secretOf('cc_credentials', 'cred-a')).tokens.refresh_token).toBe(
        'a2-refresh'
      );
      expect(JSON.parse(await secretOf('cc_credentials', 'cred-b')).tokens.refresh_token).toBe(
        'b2-refresh'
      );
    });
  });

  describe('lock deadline', () => {
    type RunRefresh = (
      refreshToken: string,
      userId: string,
      references: string[],
      signal: AbortSignal
    ) => Promise<Response>;
    const runRefreshOf = (instance: unknown) =>
      (instance as { runRefresh: RunRefresh }).runRefresh.bind(instance);

    it('a request whose deadline passed while queued never spends the token', async () => {
      const { do: doInstance } = createDO();
      await setupCredentialFound();
      mockSuccessfulRefreshResponse();

      await expect(
        runRefreshOf(doInstance)('stored-refresh', USER, [DEFAULT_REF], AbortSignal.abort())
      ).rejects.toMatchObject({ name: 'AbortError' });

      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      await expectNoCredentialUpdate();
    });

    it('once OpenAI rotated, the successor is stored even if the deadline passed meanwhile', async () => {
      const { do: doInstance } = createDO();
      await setupCredentialFound();
      const controller = new AbortController();
      vi.mocked(fetch).mockImplementation(async () => {
        const response = new Response(
          JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
        controller.abort(); // the lock deadline fires after OpenAI answered
        return response;
      });

      const res = await runRefreshOf(doInstance)(
        'stored-refresh',
        USER,
        [DEFAULT_REF],
        controller.signal
      );

      expect(res.status).toBe(200);
      expect(JSON.parse(await secretOf('cc_credentials', 'cred-1')).tokens.refresh_token).toBe(
        'new-refresh'
      );
    });
  });

  // -----------------------------------------------------------------------
  // Grace entries are bound to the credential they were rotated out of
  // -----------------------------------------------------------------------

  describe('grace entries are credential-bound', () => {
    it.each([
      { name: 'another credential', boundTo: DEFAULT_REF, generation: undefined, full: false },
      { name: 'no credential (pre-binding)', boundTo: null, generation: null, full: false },
      {
        name: 'the served credential, without a generation',
        boundTo: 'cc_credentials:cred-pinned',
        generation: null,
        full: false,
      },
      {
        name: 'the served credential, a generation it no longer holds',
        boundTo: 'cc_credentials:cred-pinned',
        generation: 'f'.repeat(64),
        full: false,
      },
      {
        name: 'the served credential, its current generation',
        boundTo: 'cc_credentials:cred-pinned',
        generation: undefined,
        full: true,
      },
    ])('an entry bound to $name', async ({ boundTo, generation, full }) => {
      const { do: doInstance, ctx } = createDO();
      await setupCredentialFound();
      await seedCc('cred-pinned', codexAuth('pinned'));
      await addGraceEntry(ctx, 'old-refresh', 60_000, boundTo, generation);

      const res = await doInstance.fetch(
        makeRequest({
          refreshToken: 'old-refresh',
          userId: USER,
          credentialReferences: ['cc_credentials:cred-pinned'],
        })
      );

      const json = await res.json();
      expect(json.access_token).toBe('pinned-access');
      expect(json.refresh_token).toBe(full ? 'pinned-refresh' : undefined);
      expect(json.stale).toBe(full ? undefined : true);
    });

    it('a row replaced with another account after rotation no longer honours the grace entry', async () => {
      const { do: doInstance, ctx } = createDO();
      await seedLegacy('legacy-a', codexAuth('a'));
      await addGraceEntry(ctx, 'old-a-refresh', 60_000, 'credentials:legacy-a');
      // The legacy row is rewritten in place with account B (Replace / Make default).
      const b = await encrypt(codexAuth('b'), ENCRYPTION_KEY);
      sqlite
        .prepare(`UPDATE credentials SET encrypted_token = ?, iv = ? WHERE id = 'legacy-a'`)
        .run(b.ciphertext, b.iv);

      const res = await doInstance.fetch(
        makeRequest({
          refreshToken: 'old-a-refresh',
          userId: USER,
          credentialReferences: ['credentials:legacy-a'],
        })
      );

      expect(res.status).toBe(401);
      expect(JSON.stringify(await res.json())).not.toContain('b-');
    });

    it('a holder of the old token is handed over through a mirrored reference', async () => {
      const { do: doInstance } = createDO();
      const original = await seedLegacy('legacy-1', storedAuthJson);
      await seedCc('cc-mirror', storedAuthJson, { copyOf: original });
      mockSuccessfulRefreshResponse();

      // Run 1 (recorded the legacy reference) rotates.
      await doInstance.fetch(
        makeRequest({
          refreshToken: 'stored-refresh',
          userId: USER,
          credentialReferences: ['credentials:legacy-1'],
        })
      );
      // Run 2 (recorded the cc mirror) still holds the old token.
      const res = await doInstance.fetch(
        makeRequest({
          refreshToken: 'stored-refresh',
          userId: USER,
          credentialReferences: ['cc_credentials:cc-mirror'],
        })
      );

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      const json = await res.json();
      expect(json.refresh_token).toBe('new-refresh');
      expect(json.stale).toBeUndefined();
    });

    it("one account's rotations never evict another account's grace entries", async () => {
      const otherEntries = await Promise.all(
        [1, 2, 3, 4, 5].map(async (n) => ({
          tokenHash: await sha256Hex(`other-${n}`),
          rotatedAt: Date.now() - 1_000,
          credentialReference: DEFAULT_REF,
        }))
      );
      const { do: doInstance, ctx } = createDO({}, { 'rotated-tokens': otherEntries });
      await seedCc('cred-pinned', codexAuth('pinned'));
      mockSuccessfulRefreshResponse();

      await doInstance.fetch(
        makeRequest({
          refreshToken: 'pinned-refresh',
          userId: USER,
          credentialReferences: ['cc_credentials:cred-pinned'],
        })
      );

      const stored = ctx.storage._store.get('rotated-tokens') as Array<{
        credentialReference: string;
      }>;
      expect(stored.filter((e) => e.credentialReference === DEFAULT_REF)).toHaveLength(5);
      expect(
        stored.filter((e) => e.credentialReference === 'cc_credentials:cred-pinned')
      ).toHaveLength(1);
    });

    it('caps the grace entries of one credential', async () => {
      const own = await Promise.all(
        [1, 2, 3, 4, 5].map(async (n) => ({
          tokenHash: await sha256Hex(`old-${n}`),
          rotatedAt: Date.now() - 1_000,
          credentialReference: DEFAULT_REF,
        }))
      );
      const { do: doInstance, ctx } = createDO({}, { 'rotated-tokens': own });
      await setupCredentialFound();
      mockSuccessfulRefreshResponse();

      await doInstance.fetch(makeRequest({ refreshToken: 'stored-refresh', userId: USER }));

      const stored = ctx.storage._store.get('rotated-tokens') as Array<{ tokenHash: string }>;
      expect(stored).toHaveLength(5);
      expect(stored.at(-1)?.tokenHash).toBe(await sha256Hex('stored-refresh'));
      expect(stored.map((e) => e.tokenHash)).not.toContain(await sha256Hex('old-1'));
    });

    it('records the credential a token was rotated out of', async () => {
      const { do: doInstance, ctx } = createDO();
      await seedCc('cred-pinned', codexAuth('pinned'));
      mockSuccessfulRefreshResponse();

      await doInstance.fetch(
        makeRequest({
          refreshToken: 'pinned-refresh',
          userId: USER,
          credentialReferences: ['cc_credentials:cred-pinned'],
        })
      );

      expect(ctx.storage._store.get('rotated-tokens')).toEqual([
        expect.objectContaining({
          tokenHash: await sha256Hex('pinned-refresh'),
          credentialReference: 'cc_credentials:cred-pinned',
        }),
      ]);
    });
  });

  describe('MEDIUM #5 — rate limit', () => {
    beforeEach(() => {
      // Credential setup awaits real SQLite/crypto work. Keep its expected window
      // and the request's window on one clock without faking async timeout timers.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-14T08:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('counts successful refresh requests in ctx.storage', async () => {
      const {
        do: doInstance,
        env,
        ctx,
      } = createDO({
        RATE_LIMIT_CODEX_REFRESH_PER_HOUR: '5',
      });
      await setupCredentialFound(env);
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      await doInstance.fetch(makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' }));

      // Rate-limit state must have been written at least once, keyed per-credential.
      expect(ctx.storage.put).toHaveBeenCalledWith(
        'rate-limit:cc_credentials:cred-1',
        expect.objectContaining({ count: expect.any(Number) })
      );
      const stored = ctx.storage._store.get('rate-limit:cc_credentials:cred-1') as {
        count: number;
        windowStart: number;
      };
      expect(stored.count).toBeGreaterThanOrEqual(1);
    });

    it('returns 429 with Retry-After when the per-window limit is exceeded', async () => {
      const windowSeconds = 60;
      const now = Math.floor(Date.now() / 1000);
      const currentWindowStart = Math.floor(now / windowSeconds) * windowSeconds;

      const {
        do: doInstance,
        env,
        ctx,
      } = createDO(
        {
          RATE_LIMIT_CODEX_REFRESH_PER_HOUR: '3',
          RATE_LIMIT_CODEX_REFRESH_WINDOW_SECONDS: windowSeconds.toString(),
        },
        {
          'rate-limit:cc_credentials:cred-1': { windowStart: currentWindowStart, count: 3 },
        }
      );
      await setupCredentialFound(env);

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' })
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
      const stored = ctx.storage._store.get('rate-limit:cc_credentials:cred-1') as {
        count: number;
      };
      expect(stored.count).toBe(3);
    });

    it.each([-1, 0, 1])(
      'resets counter when the window rolls over at minute boundary offset %i ms',
      async (offsetMs) => {
        vi.setSystemTime(new Date(Date.parse('2026-11-14T08:00:00.000Z') + offsetMs));
        const windowSeconds = 60;
        const now = Math.floor(Date.now() / 1000);
        const currentWindowStart = Math.floor(now / windowSeconds) * windowSeconds;
        const stalePastWindowStart = currentWindowStart - windowSeconds;

        const {
          do: doInstance,
          env,
          ctx,
        } = createDO(
          {
            RATE_LIMIT_CODEX_REFRESH_PER_HOUR: '3',
            RATE_LIMIT_CODEX_REFRESH_WINDOW_SECONDS: windowSeconds.toString(),
          },
          {
            'rate-limit:cc_credentials:cred-1': { windowStart: stalePastWindowStart, count: 3 },
          }
        );
        await setupCredentialFound(env);
        vi.mocked(fetch).mockResolvedValue(
          new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );

        const res = await doInstance.fetch(
          makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' })
        );

        expect(res.status).toBe(200);
        const stored = ctx.storage._store.get('rate-limit:cc_credentials:cred-1') as {
          count: number;
          windowStart: number;
        };
        // New window — counter reset to 1, windowStart advanced.
        expect(stored.windowStart).toBe(currentWindowStart);
        expect(stored.count).toBe(1);
      }
    );

    it('rate limits per credential — one credential at its limit does not block another', async () => {
      const windowSeconds = 60;
      const now = Math.floor(Date.now() / 1000);
      const currentWindowStart = Math.floor(now / windowSeconds) * windowSeconds;

      // A DIFFERENT credential is already at its limit. cred-1 has no entry.
      const {
        do: doInstance,
        env,
        ctx,
      } = createDO(
        {
          RATE_LIMIT_CODEX_REFRESH_PER_HOUR: '3',
          RATE_LIMIT_CODEX_REFRESH_WINDOW_SECONDS: windowSeconds.toString(),
        },
        {
          'rate-limit:other-cred': { windowStart: currentWindowStart, count: 3 },
        }
      );
      await setupCredentialFound(env);
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' })
      );

      // cred-1 is unaffected by other-cred's exhausted bucket.
      expect(res.status).toBe(200);
      const cred1 = ctx.storage._store.get('rate-limit:cc_credentials:cred-1') as { count: number };
      expect(cred1.count).toBe(1);
      // The unrelated credential's bucket must be left untouched.
      const otherCred = ctx.storage._store.get('rate-limit:other-cred') as {
        count: number;
      };
      expect(otherCred.count).toBe(3);
    });

    it('stale-token branch does NOT consume rate-limit budget', async () => {
      const {
        do: doInstance,
        env,
        ctx,
      } = createDO({
        RATE_LIMIT_CODEX_REFRESH_PER_HOUR: '5',
      });
      await setupCredentialFound(env);

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'rt_stale_token', userId: 'user-1' })
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.stale).toBe(true);

      // Cached/stale responses must not touch the rate-limit bucket.
      expect(ctx.storage.put).not.toHaveBeenCalledWith(
        'rate-limit:cc_credentials:cred-1',
        expect.anything()
      );
      expect(ctx.storage._store.has('rate-limit:cc_credentials:cred-1')).toBe(false);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it('grace-window branch does NOT consume rate-limit budget', async () => {
      const { do: doInstance, ctx } = await createDOWithRotatedToken('old-refresh', 60_000, {
        RATE_LIMIT_CODEX_REFRESH_PER_HOUR: '5',
      });

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'old-refresh', userId: 'user-1' })
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.refresh_token).toBe('stored-refresh');

      // Grace-window hits return stored tokens directly — no budget consumed.
      expect(ctx.storage.put).not.toHaveBeenCalledWith(
        'rate-limit:cc_credentials:cred-1',
        expect.anything()
      );
      expect(ctx.storage._store.has('rate-limit:cc_credentials:cred-1')).toBe(false);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // MEDIUM #6 — Scope validation (block by default, empty allowlist is explicit opt-out)
  // -----------------------------------------------------------------------

  describe('MEDIUM #6 — scope validation', () => {
    it('blocks with 502 on unexpected scope by default and does not persist tokens', async () => {
      const { do: doInstance, env } = createDO({
        CODEX_EXPECTED_SCOPES: 'openid,offline_access',
      });
      await setupCredentialFound(env);

      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            id_token: 'new-id',
            scope: 'openid offline_access admin:write',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' })
      );
      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json.error).toBe('upstream_unexpected_scope');
      await expectNoCredentialUpdate(env);
      expect(mockLogWarn).toHaveBeenCalledWith(
        'codex_refresh.unexpected_scopes_blocked',
        expect.objectContaining({ unexpectedScopes: 'admin:write' })
      );
    });

    it('allows refresh when scopes match expected', async () => {
      const { do: doInstance, env } = createDO({
        CODEX_EXPECTED_SCOPES: 'openid,offline_access',
      });
      await setupCredentialFound(env);

      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            scope: 'openid offline_access',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' })
      );
      expect(res.status).toBe(200);
      await expectCredentialUpdated();
    });

    it('uses default allowlist and blocks when CODEX_EXPECTED_SCOPES is unset', async () => {
      // Omit CODEX_EXPECTED_SCOPES entirely — DO must apply DEFAULT_EXPECTED_SCOPES.
      const env = createMockEnv();
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (env as Record<string, unknown>).CODEX_EXPECTED_SCOPES;
      const ctx = createMockCtx();
      const doInstance = new CodexRefreshLock(ctx, env);
      await setupCredentialFound(env);

      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            scope: 'openid offline_access admin:write', // unexpected by default
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' })
      );
      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json.error).toBe('upstream_unexpected_scope');
      await expectNoCredentialUpdate(env);
      expect(mockLogWarn).toHaveBeenCalledWith(
        'codex_refresh.unexpected_scopes_blocked',
        expect.objectContaining({ unexpectedScopes: 'admin:write' })
      );
    });

    it('allows all scopes when CODEX_EXPECTED_SCOPES is set to empty string (escape hatch)', async () => {
      const { do: doInstance, env } = createDO({ CODEX_EXPECTED_SCOPES: '' });
      await setupCredentialFound(env);

      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            scope: 'openid offline_access admin:write anything:goes',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' })
      );
      expect(res.status).toBe(200);
      await expectCredentialUpdated();
    });

    it('blocks non-string scope values by default', async () => {
      const { do: doInstance, env } = createDO({
        CODEX_EXPECTED_SCOPES: 'openid',
      });
      await setupCredentialFound(env);

      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            scope: 42, // non-string scope
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' })
      );
      expect(res.status).toBe(502);
      expect(mockLogWarn).toHaveBeenCalledWith(
        'codex_refresh.scope_validation_nonstring',
        expect.objectContaining({ scopeType: 'number' })
      );
      await expectNoCredentialUpdate(env);
    });

    it('blocks non-string scope values even when CODEX_SCOPE_VALIDATION_MODE=warn is set', async () => {
      const { do: doInstance, env } = createDO({
        CODEX_EXPECTED_SCOPES: 'openid',
        CODEX_SCOPE_VALIDATION_MODE: 'warn',
      });
      await setupCredentialFound(env);

      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            scope: 42, // non-string scope
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' })
      );
      expect(res.status).toBe(502);
      expect(mockLogWarn).toHaveBeenCalledWith(
        'codex_refresh.scope_validation_nonstring',
        expect.objectContaining({ scopeType: 'number' })
      );
      await expectNoCredentialUpdate(env);
    });

    it('allows responses with no scope field', async () => {
      const { do: doInstance, env } = createDO({
        CODEX_EXPECTED_SCOPES: 'openid,offline_access',
      });
      await setupCredentialFound(env);

      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' })
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
    await setupCredentialFound(env);

    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 5);
        })
    );

    const res = await doInstance.fetch(
      makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' })
    );
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe('upstream_timeout');
  });

  it('returns 502 with upstream_error on network failure', async () => {
    const { do: doInstance, env } = createDO();
    await setupCredentialFound(env);

    vi.mocked(fetch).mockRejectedValue(new TypeError('Network error'));

    const res = await doInstance.fetch(
      makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' })
    );
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe('upstream_error');
  });

  it('filters upstream error responses to only safe fields', async () => {
    const { do: doInstance, env } = createDO();
    await setupCredentialFound(env);

    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Token has been revoked',
          debug_info: 'sensitive-data-should-not-leak',
        }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        }
      )
    );

    const res = await doInstance.fetch(
      makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' })
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('invalid_grant');
    expect(json.error_description).toBe('Token has been revoked');
    expect(json.debug_info).toBeUndefined();
  });

  it('parses OpenAI nested error form and surfaces refresh_token_invalidated (revoked token diagnostic)', async () => {
    const { do: doInstance, env } = createDO();
    await setupCredentialFound(env);
    mockLogWarn.mockClear();

    // OpenAI returns the NESTED error shape (not flat OAuth2), which is what a
    // revoked/logged-out token produces in production:
    //   { error: { message, type, param, code } }
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: 'Your session has ended. Please log in again.',
            type: 'invalid_request_error',
            param: null,
            code: 'refresh_token_invalidated',
          },
        }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const res = await doInstance.fetch(
      makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' })
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    // The nested code is surfaced as the forwarded error.
    expect(json.error).toBe('refresh_token_invalidated');
    expect(json.error_description).toBe('Your session has ended. Please log in again.');

    // Structured diagnostic captures the rejection reason — and NEVER the raw body.
    const warnCall = mockLogWarn.mock.calls.find(
      ([event]) => event === 'codex_refresh.upstream_rejected'
    );
    expect(warnCall).toBeDefined();
    const fields = warnCall?.[1] as Record<string, unknown>;
    expect(fields.upstreamErrorCode).toBe('refresh_token_invalidated');
    expect(fields.upstreamErrorMessage).toBe('Your session has ended. Please log in again.');
    expect(fields.status).toBe(401);
    // No raw-body field is logged (refresh token can never leak).
    expect(fields).not.toHaveProperty('rawBodySample');
  });

  it('returns generic error for non-JSON upstream error responses', async () => {
    const { do: doInstance, env } = createDO();
    await setupCredentialFound(env);

    vi.mocked(fetch).mockResolvedValue(
      new Response('<html>Server Error</html>', {
        status: 500,
        headers: { 'Content-Type': 'text/html' },
      })
    );

    const res = await doInstance.fetch(
      makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' })
    );
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('upstream_error');
  });

  // The upstream error-body parser replaced a blind
  // `JSON.parse(rawBody) as Record<string, unknown>` cast with `as unknown` +
  // `maybeJsonRecord` (.claude/rules/51). These bodies are syntactically valid
  // JSON but not the expected object shape, so JSON.parse itself does not
  // throw — the old blind cast relied on property access on the wrong shape
  // (e.g. `null.error`) throwing and being swallowed by the surrounding
  // try/catch to reach the same generic-error outcome. Prove the new
  // maybeJsonRecord guard reaches the identical response without relying on
  // that incidental exception, for every non-object JSON shape upstream could
  // plausibly send.
  it.each([
    ['a bare JSON array', JSON.stringify(['unexpected', 'array'])],
    ['a bare JSON null', 'null'],
    ['a bare JSON number', '500'],
    ['a bare JSON string', '"oops"'],
    ['a bare JSON boolean', 'false'],
  ])(
    'returns the generic safe error for a garbage-but-valid-JSON upstream body (%s)',
    async (_label, body) => {
      const { do: doInstance, env } = createDO();
      await setupCredentialFound(env);
      mockLogWarn.mockClear();

      vi.mocked(fetch).mockResolvedValue(
        new Response(body, {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const res = await doInstance.fetch(
        makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' })
      );

      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json).toEqual({ error: 'upstream_error' });
      expect(json.error_description).toBeUndefined();

      // The rejection is still logged with no error code/message extracted —
      // confirms the garbage body reached the diagnostic path without throwing
      // an unhandled error out of runRefresh (which would have surfaced as a
      // 500 internal_error instead of the upstream's own 503 status).
      const warnCall = mockLogWarn.mock.calls.find(
        ([event]) => event === 'codex_refresh.upstream_rejected'
      );
      expect(warnCall).toBeDefined();
      const fields = warnCall?.[1] as Record<string, unknown>;
      expect(fields.upstreamErrorCode).toBeNull();
      expect(fields.upstreamErrorMessage).toBeNull();
      expect(fields.status).toBe(503);
    }
  );

  it('does not surface an existingFile-style nested-array error field as a code/message', async () => {
    // parsed.error being an array (not a string, not a plain object) hits the
    // nested-form branch; maybeJsonRecord converts it to an index-keyed
    // object with no .code/.message, so neither is extracted — matching the
    // pre-fix blind-cast behavior for this shape.
    const { do: doInstance, env } = createDO();
    await setupCredentialFound(env);

    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: ['nested', 'array'] }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const res = await doInstance.fetch(
      makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' })
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toEqual({ error: 'upstream_error' });
  });

  // -----------------------------------------------------------------------
  // Configurable upstream URL + client_id
  // -----------------------------------------------------------------------

  it('uses configurable upstream URL and client_id', async () => {
    const { do: doInstance, env } = createDO({
      CODEX_REFRESH_UPSTREAM_URL: 'https://custom-auth.example.com/token',
      CODEX_CLIENT_ID: 'custom_client_id',
    });
    await setupCredentialFound(env);

    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new',
          refresh_token: 'new-rt',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await doInstance.fetch(
      makeRequest({
        refreshToken: 'stored-refresh',
        userId: 'user-1',
      })
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
    await setupCredentialFound(env);

    // The stored credential really rotates in the database: the second, queued
    // request must re-read it inside the lock and take the grace path.
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
      doInstance.fetch(makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' })),
      doInstance.fetch(makeRequest({ refreshToken: 'stored-refresh', userId: 'user-1' })),
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
      expect.objectContaining({ userId: 'user-1' })
    );
  });
});
