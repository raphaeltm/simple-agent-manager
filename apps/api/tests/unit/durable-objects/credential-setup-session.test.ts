/**
 * Unit tests for the CredentialSetupSession DO state machine
 * (apps/api/src/durable-objects/credential-setup-session/index.ts).
 *
 * Harness notes (read before extending):
 *  - `vi.mock('cloudflare:workers', ...)` mirrors the established pattern in
 *    tests/unit/durable-objects/trial-counter.test.ts — it lets the DO module
 *    (which imports `DurableObject` from the Workers-runtime-only
 *    'cloudflare:workers' specifier) load under the plain Node test runner.
 *  - `services/sandbox` (getSandboxInstance/destroySandboxInstance) and
 *    `services/setup-session-pool` (releaseSetupSlot) are mocked at the
 *    module boundary — the real Cloudflare Sandbox is a Docker-backed
 *    Container binding that Miniflare/vitest-pool-workers cannot run in this
 *    environment (module mocking does not work in the workers pool either —
 *    see cron-trigger-sweep.test.ts's comment — so this plain-unit harness
 *    with `vi.mock` is the only place these seams can be substituted at all).
 *  - `services/agent-credential-save` (saveAgentCredentialForUser) is ALSO
 *    mocked here — this test's job is the DO's OWN orchestration (does it
 *    call save with the right params at the right transition, does a save
 *    failure tear down as 'failed'). The real encrypt+D1+cc-dual-write
 *    behavior of saveAgentCredentialForUser is covered separately, with NO
 *    internal mocking, in tests/workers/agent-credential-save-dual-write.test.ts.
 *    This test is therefore a DO-orchestration unit test, not a full
 *    D1-backed vertical slice (see this task's final report for the harness
 *    limitation that prevents a true end-to-end DO+D1+Sandbox test here).
 *  - `services/validation` (CredentialValidator) is deliberately NOT mocked —
 *    the DO's polling/validation behavior (partial file -> keep polling,
 *    valid file -> save) is exercised against the REAL validator with
 *    realistic auth.json content.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// Partial mocks (via importOriginal) rather than full replacements: only the
// two Sandbox-container-backed functions are faked. Everything else (e.g.
// getSandboxConfig, shellQuote, requireSandbox) stays the REAL implementation
// so this test does not silently drift out of sync with that module's actual
// export surface (see this task's report for the exact drift this caught —
// a concurrently-landed `getSandboxConfig(this.env).execTimeoutMs` refactor).
vi.mock('../../../src/services/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/sandbox')>();
  return {
    ...actual,
    getSandboxInstance: vi.fn(),
    destroySandboxInstance: vi.fn(),
  };
});

vi.mock('../../../src/services/setup-session-pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/setup-session-pool')>();
  return { ...actual, releaseSetupSlot: vi.fn() };
});

vi.mock('../../../src/services/agent-credential-save', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/agent-credential-save')>();
  return { ...actual, saveAgentCredentialForUser: vi.fn() };
});

const { CredentialSetupSession } = await import(
  '../../../src/durable-objects/credential-setup-session'
);
const { getSandboxInstance, destroySandboxInstance } = await import(
  '../../../src/services/sandbox'
);
const { releaseSetupSlot } = await import('../../../src/services/setup-session-pool');
const { saveAgentCredentialForUser } = await import('../../../src/services/agent-credential-save');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' })).replace(/=/g, '');
  const body = btoa(JSON.stringify(payload)).replace(/=/g, '');
  return `${header}.${body}.test-signature`;
}

const VALID_ACCESS_TOKEN = makeJwt({ sub: 'test', exp: Math.floor(Date.now() / 1000) + 3600 });

function validAuthJson(): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: VALID_ACCESS_TOKEN,
      refresh_token: 'refresh-token-value',
      account_id: 'acct-test',
    },
    last_refresh: '2026-07-01T00:00:00.000Z',
  });
}

// ---------------------------------------------------------------------------
// Fake SqlStorage — single-row `setup_session` table, matching the DO's own
// hand-written SQL text (see index.ts's constructor/create/setStatus/readRow).
// ---------------------------------------------------------------------------

interface FakeRow {
  id: string;
  user_id: string;
  project_id: string | null;
  scope: string;
  agent_type: string;
  credential_kind: string;
  provider: string;
  agent_name: string;
  status: string;
  pool_lease_id: string | null;
  codex_home: string;
  expires_at: number;
  capture_poll_ms: number;
  error_code: string | null;
  error_message: string | null;
  completed_at: number | null;
}

function createFakeSql() {
  let row: FakeRow | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exec = vi.fn((query: string, ...args: any[]) => {
    const q = query.trim().toLowerCase();

    if (q.startsWith('create table')) {
      return { toArray: () => [] };
    }

    if (q.includes('insert or replace into setup_session')) {
      const [id, userId, projectId, scope, agentType, credentialKind, provider, agentName, poolLeaseId, codexHome, expiresAt, capturePollMs] =
        args;
      row = {
        id,
        user_id: userId,
        project_id: projectId,
        scope,
        agent_type: agentType,
        credential_kind: credentialKind,
        provider,
        agent_name: agentName,
        status: 'provisioning',
        pool_lease_id: poolLeaseId,
        codex_home: codexHome,
        expires_at: expiresAt,
        capture_poll_ms: capturePollMs,
        error_code: null,
        error_message: null,
        completed_at: null,
      };
      return { toArray: () => [] };
    }

    if (q.includes('select * from setup_session')) {
      return { toArray: () => (row ? [{ ...row }] : []) };
    }

    if (q.includes('update setup_session')) {
      const [status, errorCode, errorMessage, completedAt] = args;
      if (row) {
        row = {
          ...row,
          status,
          error_code: errorCode ?? null,
          error_message: errorMessage ?? null,
          completed_at: completedAt ?? row.completed_at,
        };
      }
      return { toArray: () => [] };
    }

    return { toArray: () => [] };
  });

  return { exec, getRow: () => row };
}

function createFakeDatabase() {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          calls.push({ sql, args });
          return { success: true };
        },
      }),
    }),
    _calls: calls,
  };
}

function createFakeCtx() {
  const sql = createFakeSql();
  const setAlarm = vi.fn(async () => undefined);
  const deleteAlarm = vi.fn(async () => undefined);
  const blockConcurrencyWhile = vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => fn());
  return {
    storage: { sql, setAlarm, deleteAlarm },
    blockConcurrencyWhile,
    _sql: sql,
  };
}

function createFakeSandbox() {
  return {
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue({ content: '' }),
    exists: vi.fn().mockResolvedValue({ exists: false }),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createDO(): { instance: InstanceType<typeof CredentialSetupSession>; ctx: any; database: ReturnType<typeof createFakeDatabase> } {
  const ctx = createFakeCtx();
  const database = createFakeDatabase();
  const env = { DATABASE: database } as unknown as Env;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instance = new CredentialSetupSession(ctx as any, env);
  return { instance, ctx, database };
}

const BASE_PARAMS = {
  userId: 'user-1',
  projectId: null as string | null,
  scope: 'user',
  agentType: 'openai-codex' as const,
  credentialKind: 'oauth-token' as const,
  provider: 'openai',
  agentName: 'OpenAI Codex',
  poolLeaseId: 'lease-abc',
  capturePollMs: 3_000,
};

beforeEach(() => {
  vi.mocked(getSandboxInstance).mockReset();
  vi.mocked(destroySandboxInstance).mockReset().mockResolvedValue(undefined);
  vi.mocked(releaseSetupSlot).mockReset().mockResolvedValue(undefined);
  vi.mocked(saveAgentCredentialForUser).mockReset();
});

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------

describe('CredentialSetupSession — create()', () => {
  it('writes a provisioning row and arms an immediate alarm', async () => {
    const { instance, ctx } = createDO();
    await Promise.resolve();
    const before = Date.now();

    const result = await instance.create({
      id: 'setup-1',
      codexHome: '/tmp/codex-setup-setup-1',
      ttlMs: 900_000,
      ...BASE_PARAMS,
    });

    expect(result.status).toBe('provisioning');
    expect(result.errorCode).toBeNull();
    expect(ctx.storage.setAlarm).toHaveBeenCalledTimes(1);
    const armedAt = ctx.storage.setAlarm.mock.calls[0][0] as number;
    expect(armedAt).toBeGreaterThanOrEqual(before);

    const state = await instance.getState();
    expect(state?.status).toBe('provisioning');
  });
});

// ---------------------------------------------------------------------------
// alarm() — provisioning
// ---------------------------------------------------------------------------

describe('CredentialSetupSession — alarm() provisioning step', () => {
  it('provisions the sandbox and transitions to waiting_for_user', async () => {
    const { instance, ctx, database } = createDO();
    await Promise.resolve();
    const fakeSandbox = createFakeSandbox();
    vi.mocked(getSandboxInstance).mockResolvedValue(fakeSandbox as never);

    await instance.create({
      id: 'setup-1',
      codexHome: '/tmp/codex-setup-setup-1',
      ttlMs: 900_000,
      ...BASE_PARAMS,
    });

    await instance.alarm();

    expect(fakeSandbox.exec).toHaveBeenCalledWith(
      expect.stringContaining('mkdir -p'),
      expect.objectContaining({ timeout: expect.any(Number) })
    );
    expect(fakeSandbox.writeFile).toHaveBeenCalledWith(
      '/tmp/codex-setup-setup-1/config.toml',
      expect.stringContaining('cli_auth_credentials_store')
    );

    const state = await instance.getState();
    expect(state?.status).toBe('waiting_for_user');
    expect(ctx.storage.setAlarm).toHaveBeenCalledTimes(2); // create() + provision() reschedule
    expect(database._calls.some((c) => c.args.includes('waiting_for_user'))).toBe(true);
  });

  it('tears down as failed when the sandbox fails to provision', async () => {
    const { instance, ctx, database } = createDO();
    await Promise.resolve();
    const fakeSandbox = createFakeSandbox();
    fakeSandbox.exec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    fakeSandbox.exec.mockRejectedValueOnce(new Error('mkdir failed: no space left'));
    vi.mocked(getSandboxInstance).mockResolvedValue(fakeSandbox as never);

    await instance.create({
      id: 'setup-1',
      codexHome: '/tmp/codex-setup-setup-1',
      ttlMs: 900_000,
      ...BASE_PARAMS,
    });

    await instance.alarm();

    const state = await instance.getState();
    expect(state?.status).toBe('failed');
    expect(state?.errorCode).toBe('sandbox_provision_failed');

    // Teardown ran: scrub (best-effort), destroy, release, D1 marked terminal, alarm disarmed.
    expect(destroySandboxInstance).toHaveBeenCalledWith(
      expect.anything(),
      'setup-1',
      { sandboxId: 'setup-1' }
    );
    expect(releaseSetupSlot).toHaveBeenCalledWith(expect.anything(), 'lease-abc');
    expect(ctx.storage.deleteAlarm).toHaveBeenCalledTimes(1);
    expect(database._calls.some((c) => c.args.includes('failed'))).toBe(true);
    expect(saveAgentCredentialForUser).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// alarm() — capture polling
// ---------------------------------------------------------------------------

describe('CredentialSetupSession — alarm() capture polling', () => {
  async function createAndProvision(id = 'setup-1') {
    const created = createDO();
    await Promise.resolve();
    const fakeSandbox = createFakeSandbox();
    vi.mocked(getSandboxInstance).mockResolvedValue(fakeSandbox as never);

    await created.instance.create({
      id,
      codexHome: `/tmp/codex-setup-${id}`,
      ttlMs: 900_000,
      ...BASE_PARAMS,
    });
    await created.instance.alarm(); // provisioning -> waiting_for_user
    return { ...created, fakeSandbox };
  }

  it('keeps polling while auth.json has not appeared yet', async () => {
    const { instance, ctx, fakeSandbox } = await createAndProvision();
    fakeSandbox.exists.mockResolvedValue({ exists: false });

    await instance.alarm();

    const state = await instance.getState();
    expect(state?.status).toBe('waiting_for_user'); // unchanged
    expect(fakeSandbox.readFile).not.toHaveBeenCalled();
    expect(saveAgentCredentialForUser).not.toHaveBeenCalled();
    expect(ctx.storage.setAlarm).toHaveBeenCalledTimes(3); // create + provision + this poll
  });

  it('transitions to capturing but keeps polling on a partial/invalid auth.json', async () => {
    const { instance, fakeSandbox } = await createAndProvision();
    fakeSandbox.exists.mockResolvedValue({ exists: true });
    fakeSandbox.readFile.mockResolvedValue({ content: '{"partial": true' }); // truncated JSON

    await instance.alarm();

    const state = await instance.getState();
    expect(state?.status).toBe('capturing');
    expect(saveAgentCredentialForUser).not.toHaveBeenCalled();
  });

  it('captures a valid auth.json, saves the credential, and completes teardown', async () => {
    const { instance, ctx, database, fakeSandbox } = await createAndProvision();
    const authJson = validAuthJson();
    fakeSandbox.exists.mockResolvedValue({ exists: true });
    fakeSandbox.readFile.mockResolvedValue({ content: authJson });
    vi.mocked(saveAgentCredentialForUser).mockResolvedValue({
      created: true,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });

    await instance.alarm();

    expect(saveAgentCredentialForUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: BASE_PARAMS.userId,
        projectId: null,
        agentType: 'openai-codex',
        credentialKind: 'oauth-token',
        credential: authJson,
        provider: 'openai',
        agentName: 'OpenAI Codex',
        autoActivate: true,
      })
    );

    const state = await instance.getState();
    expect(state?.status).toBe('completed');
    expect(fakeSandbox.exec).toHaveBeenCalledWith(
      expect.stringContaining('rm -rf'),
      expect.objectContaining({ timeout: expect.any(Number) })
    );
    expect(destroySandboxInstance).toHaveBeenCalledWith(expect.anything(), 'setup-1', {
      sandboxId: 'setup-1',
    });
    expect(releaseSetupSlot).toHaveBeenCalledWith(expect.anything(), 'lease-abc');
    expect(ctx.storage.deleteAlarm).toHaveBeenCalledTimes(1);
    expect(database._calls.some((c) => c.args.includes('completed'))).toBe(true);
  });

  it('tears down as failed when saveAgentCredentialForUser rejects', async () => {
    const { instance, database, fakeSandbox } = await createAndProvision();
    const authJson = validAuthJson();
    fakeSandbox.exists.mockResolvedValue({ exists: true });
    fakeSandbox.readFile.mockResolvedValue({ content: authJson });
    vi.mocked(saveAgentCredentialForUser).mockRejectedValue(new Error('encryption key missing'));

    await instance.alarm();

    const state = await instance.getState();
    expect(state?.status).toBe('failed');
    expect(state?.errorCode).toBe('capture_save_failed');
    expect(releaseSetupSlot).toHaveBeenCalledWith(expect.anything(), 'lease-abc');
    expect(database._calls.some((c) => c.args.includes('failed'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TTL expiry
// ---------------------------------------------------------------------------

describe('CredentialSetupSession — TTL expiry', () => {
  it('expires a session whose TTL has elapsed, regardless of current status', async () => {
    const { instance } = await (async () => {
      const created = createDO();
      await Promise.resolve();
      const fakeSandbox = createFakeSandbox();
      vi.mocked(getSandboxInstance).mockResolvedValue(fakeSandbox as never);
      // Negative TTL => already expired the moment create() runs.
      await created.instance.create({
        id: 'setup-expired',
        codexHome: '/tmp/codex-setup-expired',
        ttlMs: -60_000,
        ...BASE_PARAMS,
      });
      return { ...created, fakeSandbox };
    })();

    await instance.alarm();

    const state = await instance.getState();
    expect(state?.status).toBe('expired');
    expect(state?.errorCode).toBe('setup_session_expired');
    expect(saveAgentCredentialForUser).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Terminal idempotency
// ---------------------------------------------------------------------------

describe('CredentialSetupSession — terminal state is a stable fixed point', () => {
  it('alarm() on an already-terminal session is a no-op', async () => {
    const { instance } = createDO();
    await Promise.resolve();
    const fakeSandbox = createFakeSandbox();
    vi.mocked(getSandboxInstance).mockResolvedValue(fakeSandbox as never);
    await instance.create({
      id: 'setup-term',
      codexHome: '/tmp/codex-setup-term',
      ttlMs: -60_000, // immediately expired -> alarm() drives it to 'expired'
      ...BASE_PARAMS,
    });
    await instance.alarm();
    expect((await instance.getState())?.status).toBe('expired');

    vi.mocked(releaseSetupSlot).mockClear();
    vi.mocked(destroySandboxInstance).mockClear();

    await instance.alarm(); // second call — must be a pure no-op

    expect(releaseSetupSlot).not.toHaveBeenCalled();
    expect(destroySandboxInstance).not.toHaveBeenCalled();
    expect((await instance.getState())?.status).toBe('expired');
  });
});

// ---------------------------------------------------------------------------
// cancel()
// ---------------------------------------------------------------------------

describe('CredentialSetupSession — cancel()', () => {
  it('tears down a non-terminal session as cancelled', async () => {
    const { instance } = createDO();
    await Promise.resolve();
    const fakeSandbox = createFakeSandbox();
    vi.mocked(getSandboxInstance).mockResolvedValue(fakeSandbox as never);
    await instance.create({
      id: 'setup-cancel',
      codexHome: '/tmp/codex-setup-cancel',
      ttlMs: 900_000,
      ...BASE_PARAMS,
    });

    const result = await instance.cancel();

    expect(result.status).toBe('cancelled');
    expect(releaseSetupSlot).toHaveBeenCalledWith(expect.anything(), 'lease-abc');
    expect(destroySandboxInstance).toHaveBeenCalled();
  });

  it('is idempotent on an already-terminal session (does not re-run teardown)', async () => {
    const { instance } = createDO();
    await Promise.resolve();
    const fakeSandbox = createFakeSandbox();
    vi.mocked(getSandboxInstance).mockResolvedValue(fakeSandbox as never);
    await instance.create({
      id: 'setup-cancel-2',
      codexHome: '/tmp/codex-setup-cancel-2',
      ttlMs: 900_000,
      ...BASE_PARAMS,
    });
    await instance.cancel(); // -> cancelled
    vi.mocked(releaseSetupSlot).mockClear();
    vi.mocked(destroySandboxInstance).mockClear();

    const second = await instance.cancel();

    expect(second.status).toBe('cancelled');
    expect(releaseSetupSlot).not.toHaveBeenCalled();
    expect(destroySandboxInstance).not.toHaveBeenCalled();
  });

  it('returns a synthetic cancelled result when no row was ever created (no side effects)', async () => {
    const { instance } = createDO();
    await Promise.resolve();

    const result = await instance.cancel();

    expect(result).toEqual({
      id: '',
      status: 'cancelled',
      expiresAt: 0,
      errorCode: null,
      errorMessage: null,
    });
    expect(getSandboxInstance).not.toHaveBeenCalled();
    expect(releaseSetupSlot).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getState()
// ---------------------------------------------------------------------------

describe('CredentialSetupSession — getState()', () => {
  it('returns null when no session was ever created', async () => {
    const { instance } = createDO();
    await Promise.resolve();
    expect(await instance.getState()).toBeNull();
  });
});
