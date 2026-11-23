/**
 * FILE SIZE EXCEPTION: lifecycle regression fixtures and tests share one real SQLite harness.
 * Teardown ordering and recovery for the CredentialSetupSession DO
 * (apps/api/src/durable-objects/credential-setup-session/index.ts).
 *
 * Incident (found on the self-host branch, applies on Cloudflare too; task
 * tasks/archive/2026-11-17-l19-credential-setup-teardown-robustness.md): teardown
 * claimed the terminal status in DO SQLite, then awaited the sandbox scrub and destroy,
 * and only then wrote D1. A process death in between left D1 active, so
 * `POST /api/agent-credential-setup-sessions` kept returning the dead session for ~19
 * minutes. And a scrub against a never-started container waited out the SDK's start
 * retries before the destroy ran.
 *
 * Harness: the DO's SQLite and the D1 table are both real SQLite (better-sqlite3), so
 * the additive column migration, the claim, and the create route's one-active lookup
 * run real SQL. Only the Sandbox container (no Docker here), the pool DO and the
 * session-start RPC are mocked at the module boundary, as in
 * credential-setup-session.test.ts. A "process death" is a sandbox call that never
 * settles, followed by a NEW DO instance over the same storage.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { createSqliteD1 } from '../../helpers/sqlite-d1';
import { createSqlStorage } from './sql-storage-test-utils';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('../../../src/services/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/sandbox')>();
  return { ...actual, getSandboxInstance: vi.fn(), destroySandboxInstance: vi.fn() };
});

vi.mock('../../../src/services/setup-session-pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/setup-session-pool')>();
  return { ...actual, leaseSetupSlot: vi.fn(), releaseSetupSlot: vi.fn() };
});

vi.mock('../../../src/services/credential-setup-session', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/credential-setup-session')>();
  return { ...actual, startSetupSession: vi.fn(), getSetupSessionState: vi.fn() };
});

vi.mock('../../../src/services/observability-errors', () => ({ persistError: vi.fn() }));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  getUserId: () => 'owner-user',
}));

const { CredentialSetupSession } =
  await import('../../../src/durable-objects/credential-setup-session');
const { getSandboxInstance, destroySandboxInstance } =
  await import('../../../src/services/sandbox');
const { leaseSetupSlot, releaseSetupSlot } =
  await import('../../../src/services/setup-session-pool');
const { startSetupSession, getSetupSessionState } =
  await import('../../../src/services/credential-setup-session');
const { agentCredentialSetupSessionsRoutes } =
  await import('../../../src/routes/agent-credential-setup-sessions');
const { DEFAULT_SETUP_SESSION_MAX_CLEANUP_RECOVERY_ATTEMPTS, SANDBOX_PERMANENT_STARTUP_MESSAGE } =
  await import('../../../src/services/credential-setup-config');

const { persistError } = await import('../../../src/services/observability-errors');

const SESSION_ID = 'setup-dead';
const USER_ID = 'owner-user';
const LEASE_ID = 'lease-dead';
const SETUP_HOME = '/tmp/codex-setup-dead';
const POLL_MS = 3_000;

type DoRow = {
  status: string;
  cleanup_pending: number | null;
  cleanup_from_status: string | null;
  cleanup_attempts: number | null;
};

function createD1Database(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(
    `CREATE TABLE agent_credential_setup_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT,
      scope TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      credential_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      sandbox_id TEXT NOT NULL,
      pool_lease_id TEXT,
      expires_at TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    )`
  );
  // The row the create route reserves before starting the DO.
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO agent_credential_setup_sessions
       (id, user_id, project_id, scope, agent_type, credential_kind, status, sandbox_id,
        pool_lease_id, expires_at, created_at, updated_at)
       VALUES (?, ?, NULL, 'user', 'openai-codex', 'oauth-token', 'provisioning', ?, ?, ?, ?, ?)`
    )
    .run(
      SESSION_ID,
      USER_ID,
      SESSION_ID,
      LEASE_ID,
      new Date(Date.now() + 900_000).toISOString(),
      now,
      now
    );
  return sqlite;
}

function d1Status(d1: Database.Database, id = SESSION_ID): string | undefined {
  return (
    d1.prepare('SELECT status FROM agent_credential_setup_sessions WHERE id = ?').get(id) as
      { status: string } | undefined
  )?.status;
}

function doRow(doDb: Database.Database): DoRow {
  return doDb
    .prepare(
      'SELECT status, cleanup_pending, cleanup_from_status, cleanup_attempts FROM setup_session'
    )
    .get() as DoRow;
}

/** One DO "isolate" over persistent storage. A new instance over the same doDb = restart. */
function createInstance(doDb: Database.Database, env: Env) {
  let scheduledAlarm: number | null = null;
  const storage = {
    sql: createSqlStorage(doDb),
    setAlarm: vi.fn(async (at: number) => {
      scheduledAlarm = at;
    }),
    getAlarm: vi.fn(async () => scheduledAlarm),
    deleteAlarm: vi.fn(async () => {
      scheduledAlarm = null;
    }),
  };
  const ctx = {
    storage,
    waitUntil: vi.fn(),
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
  const instance = new CredentialSetupSession(ctx as never, env);
  const runAlarm = instance.alarm.bind(instance);
  instance.alarm = async () => {
    scheduledAlarm = null;
    return runAlarm();
  };
  return { instance, storage };
}

function createFakeSandbox() {
  return {
    exec: vi.fn().mockResolvedValue({ success: true, stdout: '', stderr: '', exitCode: 0 }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue({
      content: JSON.stringify({
        status: 'waiting_for_user',
        verificationUrl: 'https://auth.openai.com/device',
        userCode: 'ABCD-EFGH',
      }),
    }),
    exists: vi.fn().mockImplementation(async (path: string) => ({
      exists: path.endsWith('device-auth-state.json'),
    })),
  };
}

function scrubCalls(sandbox: ReturnType<typeof createFakeSandbox>) {
  return sandbox.exec.mock.calls.filter(([command]) => String(command).startsWith('rm -rf'));
}

interface Fixture {
  d1: Database.Database;
  doDb: Database.Database;
  env: Env;
  sandbox: ReturnType<typeof createFakeSandbox>;
}

function createFixture(envOverrides: Record<string, string> = {}): Fixture {
  const d1 = createD1Database();
  const doDb = new Database(':memory:');
  const env = {
    DATABASE: createSqliteD1(d1),
    SANDBOX: {},
    CREDENTIAL_SETUP_SESSION: {},
    SETUP_SESSION_POOL: {},
    ...envOverrides,
  } as unknown as Env;
  const sandbox = createFakeSandbox();
  vi.mocked(getSandboxInstance).mockResolvedValue(sandbox as never);
  return { d1, doDb, env, sandbox };
}

async function startSession(
  fixture: Fixture,
  toWaitingForUser: boolean,
  agentType: 'openai-codex' | 'claude-code' = 'openai-codex'
) {
  const handle = createInstance(fixture.doDb, fixture.env);
  await handle.instance.create({
    id: SESSION_ID,
    userId: USER_ID,
    projectId: null,
    scope: 'user',
    agentType,
    credentialKind: 'oauth-token',
    provider: 'openai',
    agentName: 'OpenAI Codex',
    poolLeaseId: LEASE_ID,
    setupHome: SETUP_HOME,
    ttlMs: 900_000,
    capturePollMs: POLL_MS,
  });
  if (toWaitingForUser) {
    await handle.instance.alarm(); // provisioning -> admitting
    await handle.instance.alarm(); // admitting -> waiting_for_user
    expect(d1Status(fixture.d1)).toBe('waiting_for_user');
  }
  return handle;
}

/**
 * Leave a settled failed destroy for recovery. Unsettled SDK promises have their own
 * flight/watchdog fixtures below and must never masquerade as retryable failures.
 */
async function interruptTeardown(fixture: Fixture) {
  const handle = await startSession(fixture, true);
  const seen: string[] = [];
  fixture.sandbox.exec.mockImplementation(async (command: string) => {
    if (command.startsWith('rm -rf')) seen.push(`scrub:${d1Status(fixture.d1)}`);
    return { success: true, stdout: '', stderr: '', exitCode: 0 };
  });
  vi.mocked(destroySandboxInstance).mockImplementation(() => {
    seen.push(`destroy:${d1Status(fixture.d1)}`);
    return Promise.reject(new Error('destroy unavailable'));
  });
  // Clear the provisioning-time alarms so assertions see only the claim-time one.
  handle.storage.setAlarm.mockClear();
  const cancelledAt = Date.now();
  await handle.instance.cancel();
  await vi.waitFor(() => expect(destroySandboxInstance).toHaveBeenCalledTimes(1));
  return { ...handle, seen, cancelledAt };
}

function createRouteApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) => {
    const status = 'statusCode' in error ? Number(error.statusCode) : 500;
    return c.json({ error: error.message }, status as 400 | 404 | 409 | 500);
  });
  app.route('/api/agent-credential-setup-sessions', agentCredentialSetupSessionsRoutes);
  return app;
}

beforeEach(() => {
  vi.mocked(persistError).mockReset().mockResolvedValue(undefined);
  vi.mocked(getSandboxInstance).mockReset();
  vi.mocked(destroySandboxInstance).mockReset().mockResolvedValue(undefined);
  vi.mocked(releaseSetupSlot).mockReset().mockResolvedValue(undefined);
  vi.mocked(leaseSetupSlot).mockReset();
  vi.mocked(startSetupSession).mockReset();
  vi.mocked(getSetupSessionState).mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CredentialSetupSession teardown — interrupted after the DO claim', () => {
  it('marks D1 terminal before any sandbox I/O, so a new create for the same user and agent starts a fresh session', async () => {
    const fixture = createFixture();
    const { storage, seen, cancelledAt } = await interruptTeardown(fixture);

    // D1 was already terminal when the scrub and the destroy were called.
    expect(seen).toEqual(['scrub:cancelled', 'destroy:cancelled']);
    expect(d1Status(fixture.d1)).toBe('cancelled');
    // Cleanup is recorded as owed, with the status that decides whether to scrub,
    // and a recovery alarm was armed before the sandbox I/O.
    expect(doRow(fixture.doDb)).toEqual({
      status: 'cancelled',
      cleanup_pending: 1,
      cleanup_from_status: 'waiting_for_user',
      cleanup_attempts: 0,
    });
    expect(storage.setAlarm).toHaveBeenCalledTimes(2); // claim plus settled-failure recovery
    expect(storage.setAlarm.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(cancelledAt + POLL_MS);
    // The sign-in URL and user code are gone with the claim, not after the cleanup.
    expect(fixture.doDb.prepare('SELECT COUNT(*) AS n FROM device_auth_details').get()).toEqual({
      n: 0,
    });
    expect(storage.deleteAlarm).not.toHaveBeenCalled();
    expect(releaseSetupSlot).toHaveBeenCalledWith(expect.anything(), LEASE_ID); // settled failure still runs independent cleanup

    // The real create route no longer finds the dead session as active.
    vi.mocked(leaseSetupSlot).mockResolvedValue({ granted: true, leaseId: 'lease-new' });
    vi.mocked(startSetupSession).mockImplementation(async (_env, params) => ({
      id: params.id,
      status: 'provisioning',
      expiresAt: Date.now() + 900_000,
      errorCode: null,
      errorMessage: null,
      verificationUrl: null,
      userCode: null,
    }));
    const response = await createRouteApp().request(
      '/api/agent-credential-setup-sessions',
      { method: 'POST' },
      fixture.env
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; status: string };
    expect(body.id).not.toBe(SESSION_ID);
    expect(body.status).toBe('provisioning');
    expect(startSetupSession).toHaveBeenCalledTimes(1);
    expect(d1Status(fixture.d1, body.id)).toBe('provisioning');
  });
});

describe('CredentialSetupSession teardown — recovery alarm', () => {
  it('preserves the legacy retry budget when a newer setting lowers the cap', async () => {
    const config = await import('../../../src/services/credential-setup-config');
    const setting = vi
      .spyOn(config, 'getSetupSessionCleanupRecoveryConfig')
      .mockResolvedValue({ stepTimeoutMs: 5_000, maxAttempts: 1 });
    try {
      const fixture = createFixture();
      fixture.env.OBSERVABILITY_DATABASE = {} as D1Database;
      await interruptTeardown(fixture);
      fixture.doDb
        .prepare(
          'UPDATE setup_session SET cleanup_attempts = 2, cleanup_recovery_max_attempts = NULL'
        )
        .run();
      vi.mocked(destroySandboxInstance).mockClear();
      await createInstance(fixture.doDb, fixture.env).instance.alarm();
      expect(
        fixture.doDb.prepare('SELECT cleanup_recovery_max_attempts FROM setup_session').get()
      ).toEqual({
        cleanup_recovery_max_attempts: DEFAULT_SETUP_SESSION_MAX_CLEANUP_RECOVERY_ATTEMPTS,
      });
      expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1, cleanup_attempts: 3 });
      expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
      expect(persistError).not.toHaveBeenCalled();
      await createInstance(fixture.doDb, fixture.env).instance.alarm();
      expect(doRow(fixture.doDb).cleanup_attempts).toBe(4);
      expect(persistError).toHaveBeenCalledTimes(1);
    } finally {
      setting.mockRestore();
    }
  });

  it('snapshots the configured retry cap without allowing later settings to revive quarantine', async () => {
    const config = await import('../../../src/services/credential-setup-config');
    const setting = vi
      .spyOn(config, 'getSetupSessionCleanupRecoveryConfig')
      .mockResolvedValue({ stepTimeoutMs: 5_000, maxAttempts: 5 });
    try {
      const fixture = createFixture();
      fixture.env.OBSERVABILITY_DATABASE = {} as D1Database;
      const first = await startSession(fixture, true);
      vi.mocked(destroySandboxInstance).mockRejectedValue(new Error('destroy unavailable'));
      await first.instance.cancel();
      expect(setting).not.toHaveBeenCalled();
      for (let attempt = 1; attempt <= 5; attempt++) {
        await createInstance(fixture.doDb, fixture.env).instance.alarm();
        expect(doRow(fixture.doDb)).toMatchObject({
          cleanup_pending: 1,
          cleanup_attempts: attempt,
        });
        expect(
          fixture.doDb.prepare('SELECT cleanup_recovery_max_attempts FROM setup_session').get()
        ).toEqual({ cleanup_recovery_max_attempts: 5 });
      }
      setting.mockResolvedValue({ stepTimeoutMs: 5_000, maxAttempts: 1 });
      await createInstance(fixture.doDb, fixture.env).instance.alarm();
      expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1, cleanup_attempts: 6 });
      expect(persistError).toHaveBeenCalledTimes(1);
      vi.mocked(destroySandboxInstance).mockClear();
      setting.mockResolvedValue({ stepTimeoutMs: 5_000, maxAttempts: 10 });
      await createInstance(fixture.doDb, fixture.env).instance.alarm();
      expect(destroySandboxInstance).not.toHaveBeenCalled();
      expect(persistError).toHaveBeenCalledTimes(1);
    } finally {
      setting.mockRestore();
    }
  });

  it('keeps a legacy NULL-cap quarantine closed when the configured retry cap increases', async () => {
    const config = await import('../../../src/services/credential-setup-config');
    const setting = vi
      .spyOn(config, 'getSetupSessionCleanupRecoveryConfig')
      .mockResolvedValue({ stepTimeoutMs: 5_000, maxAttempts: 5 });
    try {
      const fixture = createFixture();
      await interruptTeardown(fixture);
      fixture.doDb
        .prepare(
          'UPDATE setup_session SET cleanup_attempts = 4, cleanup_recovery_max_attempts = NULL'
        )
        .run();
      vi.mocked(destroySandboxInstance).mockClear();
      await createInstance(fixture.doDb, fixture.env).instance.alarm();
      expect(destroySandboxInstance).not.toHaveBeenCalled();
      expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1, cleanup_attempts: 4 });
      expect(
        fixture.doDb.prepare('SELECT cleanup_recovery_max_attempts FROM setup_session').get()
      ).toEqual({ cleanup_recovery_max_attempts: null });
      expect(setting).not.toHaveBeenCalled();
    } finally {
      setting.mockRestore();
    }
  });

  it('rejects an alarm with unresolved cleanup and no durable wake, then retries successfully', async () => {
    const fixture = createFixture();
    const first = await startSession(fixture, true);
    vi.mocked(destroySandboxInstance).mockRejectedValueOnce(
      new Error('initial destroy unavailable')
    );
    await first.instance.cancel();
    const restarted = createInstance(fixture.doDb, fixture.env);
    restarted.storage.setAlarm.mockRejectedValue(new Error('alarm storage unavailable'));
    vi.mocked(destroySandboxInstance).mockRejectedValueOnce(new Error('destroy unavailable'));
    await expect(restarted.instance.alarm()).rejects.toThrow();
    expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1 });
    expect(d1Status(fixture.d1)).toBe('cancelled');
    // Cloudflare retries an uncaught alarm exception; model that new invocation.
    await createInstance(fixture.doDb, fixture.env).instance.alarm();
    expect(doRow(fixture.doDb).cleanup_pending).toBe(0);
  });

  it('keeps cancellation active and sweep-eligible until its recovery alarm is durable', async () => {
    const fixture = createFixture();
    const handle = await startSession(fixture, true);
    handle.storage.setAlarm.mockRejectedValue(new Error('storage unavailable'));

    await expect(handle.instance.cancel()).rejects.toThrow();
    expect(d1Status(fixture.d1)).toBe('waiting_for_user');
    expect(doRow(fixture.doDb)).toMatchObject({
      status: 'waiting_for_user',
      cleanup_pending: null,
    });
    expect(
      fixture.d1
        .prepare(
          "SELECT COUNT(*) AS n FROM agent_credential_setup_sessions WHERE status IN ('provisioning','admitting','waiting_for_user','exchanging','capturing','saving')"
        )
        .get()
    ).toEqual({ n: 1 });
    expect(destroySandboxInstance).not.toHaveBeenCalled();
    expect(releaseSetupSlot).not.toHaveBeenCalled();
    handle.storage.setAlarm.mockResolvedValue(undefined);
    await expect(handle.instance.cancel()).resolves.toMatchObject({ status: 'cancelled' });
    expect(doRow(fixture.doDb).cleanup_pending).toBe(0);
  });

  it('joins concurrent cancellation before arming and claims terminal state only after the arm succeeds', async () => {
    const fixture = createFixture();
    const handle = await startSession(fixture, true);
    let finishArm: (() => void) | undefined;
    const arming = new Promise<void>((resolve) => {
      finishArm = resolve;
    });
    handle.storage.setAlarm.mockClear().mockImplementationOnce(() => arming);
    vi.mocked(destroySandboxInstance).mockImplementationOnce(async () => {
      expect(d1Status(fixture.d1)).toBe('cancelled');
      expect(doRow(fixture.doDb).status).toBe('cancelled');
    });
    const first = handle.instance.cancel();
    await vi.waitFor(() => expect(handle.storage.setAlarm).toHaveBeenCalledTimes(1));
    const second = handle.instance.cancel();
    try {
      await Promise.resolve();
      expect(handle.storage.setAlarm).toHaveBeenCalledTimes(1);
      expect(doRow(fixture.doDb)).toMatchObject({
        status: 'waiting_for_user',
        cleanup_pending: null,
      });
      expect(d1Status(fixture.d1)).toBe('waiting_for_user');
      expect(destroySandboxInstance).not.toHaveBeenCalled();
      finishArm?.();
      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.status)).toEqual(['cancelled', 'cancelled']);
      expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
      expect(releaseSetupSlot).toHaveBeenCalledTimes(1);
    } finally {
      finishArm?.();
      await Promise.allSettled([first, second]);
    }
  });

  it('preserves a real capture saving commit that lands while cancellation waits for its initial alarm', async () => {
    const fixture = createFixture();
    const handle = await startSession(fixture, true);
    let finishArm: (() => void) | undefined;
    let finishSave: (() => void) | undefined;
    const armGate = new Promise<void>((resolve) => {
      finishArm = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    handle.storage.setAlarm.mockClear().mockImplementationOnce(() => armGate);
    const saveModule = await import('../../../src/services/agent-credential-save');
    const save = vi.spyOn(saveModule, 'saveAgentCredentialForUser').mockImplementation(async () => {
      await saveGate;
      return {
        created: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });
    const token = `${btoa(JSON.stringify({ alg: 'RS256' }))}.${btoa(JSON.stringify({ sub: 'test', exp: Math.floor(Date.now() / 1000) + 3600 }))}.test-signature`;
    fixture.sandbox.exists.mockResolvedValue({ exists: true });
    fixture.sandbox.readFile.mockImplementation(async (path: string) => ({
      content: path.endsWith('device-auth-state.json')
        ? JSON.stringify({ status: 'completed' })
        : JSON.stringify({
            tokens: {
              access_token: token,
              refresh_token: 'fixture-refresh',
              account_id: 'fixture-account',
            },
            last_refresh: new Date().toISOString(),
          }),
    }));
    const cancel = handle.instance.cancel();
    await vi.waitFor(() => expect(handle.storage.setAlarm).toHaveBeenCalledTimes(1));
    const capture = handle.instance.alarm();
    try {
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      expect(doRow(fixture.doDb).status).toBe('saving');
      finishArm?.();
      await expect(cancel).resolves.toMatchObject({ status: 'saving' });
      expect(destroySandboxInstance).not.toHaveBeenCalled();
      finishSave?.();
      await capture;
      expect(doRow(fixture.doDb)).toMatchObject({ status: 'completed', cleanup_pending: 0 });
      expect(d1Status(fixture.d1)).toBe('completed');
      expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
    } finally {
      finishArm?.();
      finishSave?.();
      await Promise.allSettled([cancel, capture]);
      save.mockRestore();
    }
  });

  it('finishes interrupted cleanup even when re-arming its recovery alarm fails', async () => {
    const fixture = createFixture();
    await interruptTeardown(fixture);
    vi.mocked(destroySandboxInstance).mockReset().mockResolvedValue(undefined);
    const restarted = createInstance(fixture.doDb, fixture.env);
    restarted.storage.setAlarm.mockRejectedValue(new Error('storage unavailable'));

    await expect(restarted.instance.alarm()).resolves.toBeUndefined();

    expect(d1Status(fixture.d1)).toBe('cancelled');
    expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
    expect(releaseSetupSlot).toHaveBeenCalledWith(expect.anything(), LEASE_ID);
    expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 0, cleanup_attempts: 1 });
  });

  it('retains unresolved cleanup when both destruction and its failure re-arm fail', async () => {
    const fixture = createFixture();
    const handle = await startSession(fixture, true);
    // The initial alarm succeeds; only the post-failure re-arm rejects.
    handle.storage.setAlarm
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('storage unavailable'));
    vi.mocked(destroySandboxInstance).mockRejectedValueOnce(new Error('destroy unavailable'));

    await expect(handle.instance.cancel()).resolves.toMatchObject({ status: 'cancelled' });

    expect(d1Status(fixture.d1)).toBe('cancelled');
    expect(releaseSetupSlot).toHaveBeenCalledWith(expect.anything(), LEASE_ID);
    expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1 });
    expect(handle.storage.deleteAlarm).not.toHaveBeenCalled();
  });

  it('conservatively scrubs legacy NULL-flight cleanup interrupted during provisioning', async () => {
    const fixture = createFixture();
    const first = await startSession(fixture, false);
    vi.mocked(destroySandboxInstance).mockRejectedValueOnce(new Error('destroy unavailable'));
    await first.instance.cancel();
    // Legacy objects have no flight metadata; this is not an unobserved live SDK call.
    fixture.doDb.prepare('UPDATE setup_session SET cleanup_sandbox_io_pending = NULL').run();
    await vi.waitFor(() => expect(destroySandboxInstance).toHaveBeenCalledTimes(1));
    expect(scrubCalls(fixture.sandbox)).toHaveLength(0);
    expect(doRow(fixture.doDb)).toMatchObject({
      status: 'cancelled',
      cleanup_pending: 1,
      cleanup_from_status: 'provisioning',
    });

    vi.mocked(destroySandboxInstance).mockReset().mockResolvedValue(undefined);
    const restarted = createInstance(fixture.doDb, fixture.env);
    await restarted.instance.alarm();

    expect(scrubCalls(fixture.sandbox)).toEqual([[`rm -rf '${SETUP_HOME}'`, expect.anything()]]);
    expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
    expect(releaseSetupSlot).toHaveBeenCalledWith(expect.anything(), LEASE_ID);
    expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 0, cleanup_attempts: 1 });
  });

  it('does not recreate a destroyed sandbox when recovery resumes at the pool release', async () => {
    const fixture = createFixture();
    const first = await startSession(fixture, true);
    vi.mocked(releaseSetupSlot).mockImplementationOnce(() => new Promise(() => {}));
    void first.instance.cancel();
    await vi.waitFor(() => expect(releaseSetupSlot).toHaveBeenCalledTimes(1));
    expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
    expect(
      fixture.doDb.prepare('SELECT cleanup_sandbox_destroyed FROM setup_session').get()
    ).toEqual({ cleanup_sandbox_destroyed: 1 });
    expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1 });

    vi.mocked(getSandboxInstance).mockClear();
    vi.mocked(destroySandboxInstance).mockClear();
    vi.mocked(releaseSetupSlot).mockReset().mockResolvedValue(undefined);
    fixture.sandbox.exec.mockClear();
    const restarted = createInstance(fixture.doDb, fixture.env);
    await restarted.instance.alarm();

    expect(getSandboxInstance).not.toHaveBeenCalled();
    expect(fixture.sandbox.exec).not.toHaveBeenCalled();
    expect(destroySandboxInstance).not.toHaveBeenCalled();
    expect(releaseSetupSlot).toHaveBeenCalledWith(expect.anything(), LEASE_ID);
    expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 0, cleanup_attempts: 0 });
    expect(restarted.storage.deleteAlarm).toHaveBeenCalledTimes(1);
  });

  it('a restarted instance finishes the interrupted cleanup on its alarm, and the next alarm is a no-op', async () => {
    const fixture = createFixture();
    await interruptTeardown(fixture);
    vi.mocked(destroySandboxInstance).mockReset().mockResolvedValue(undefined);
    fixture.sandbox.exec.mockClear();

    // The isolate died: a new instance over the same storage gets the alarm.
    const restarted = createInstance(fixture.doDb, fixture.env);
    await restarted.instance.alarm();

    // The original scrub settled before the interrupted destroy; durable proof
    // avoids issuing another potentially restarting SDK call.
    expect(fixture.doDb.prepare('SELECT cleanup_scrub_state FROM setup_session').get()).toEqual({
      cleanup_scrub_state: 2,
    });
    expect(scrubCalls(fixture.sandbox)).toHaveLength(0);
    expect(destroySandboxInstance).toHaveBeenCalledWith(
      expect.anything(),
      SESSION_ID,
      {
        sandboxId: SESSION_ID,
      },
      { timeoutMs: null }
    );
    expect(releaseSetupSlot).toHaveBeenCalledWith(expect.anything(), LEASE_ID);
    expect(doRow(fixture.doDb)).toEqual({
      status: 'cancelled',
      cleanup_pending: 0,
      cleanup_from_status: 'waiting_for_user',
      cleanup_attempts: 1,
    });
    expect(restarted.storage.deleteAlarm).toHaveBeenCalledTimes(1);
    expect(d1Status(fixture.d1)).toBe('cancelled');

    vi.mocked(destroySandboxInstance).mockClear();
    vi.mocked(releaseSetupSlot).mockClear();
    fixture.sandbox.exec.mockClear();
    restarted.storage.setAlarm.mockClear();

    await restarted.instance.alarm();

    expect(fixture.sandbox.exec).not.toHaveBeenCalled();
    expect(destroySandboxInstance).not.toHaveBeenCalled();
    expect(releaseSetupSlot).not.toHaveBeenCalled();
    expect(restarted.storage.setAlarm).not.toHaveBeenCalled();
    expect(doRow(fixture.doDb).cleanup_pending).toBe(0);
  });

  it('an alarm that fires while the inline cleanup is still running joins it instead of running a second one', async () => {
    const fixture = createFixture();
    const handle = await startSession(fixture, true);
    let openGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    vi.mocked(destroySandboxInstance).mockImplementation(() => gate);

    const cancel = handle.instance.cancel();
    await vi.waitFor(() => expect(destroySandboxInstance).toHaveBeenCalledTimes(1));
    // Hold the inline destroy open while the alarm reaches the resume path: the row is
    // terminal with cleanup still pending at this point.
    expect(doRow(fixture.doDb)).toMatchObject({ status: 'cancelled', cleanup_pending: 1 });
    const resume = vi.spyOn(
      handle.instance as unknown as { resumeCleanup: () => unknown },
      'resumeCleanup'
    );
    handle.storage.setAlarm.mockClear();
    const alarm = handle.instance.alarm();
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    // Past the resume decision: a second run would have counted an attempt and re-armed
    // synchronously before its first await.
    expect(doRow(fixture.doDb).cleanup_attempts).toBe(0);
    expect(handle.storage.setAlarm).not.toHaveBeenCalled();
    expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
    openGate?.();
    await Promise.all([cancel, alarm]);

    expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
    expect(releaseSetupSlot).toHaveBeenCalledTimes(1);
    expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 0, cleanup_attempts: 0 });
  });

  it('re-arms after a failed cleanup whose original alarm joined the inline attempt', async () => {
    const fixture = createFixture();
    const handle = await startSession(fixture, true);
    let failDestroy: ((error: Error) => void) | undefined;
    const gate = new Promise<void>((_resolve, reject) => {
      failDestroy = reject;
    });
    vi.mocked(destroySandboxInstance).mockImplementationOnce(() => gate);
    const cancel = handle.instance.cancel();
    await vi.waitFor(() => expect(destroySandboxInstance).toHaveBeenCalledTimes(1));
    const resume = vi.spyOn(
      handle.instance as unknown as { resumeCleanup: () => unknown },
      'resumeCleanup'
    );
    const alarm = handle.instance.alarm();
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    handle.storage.setAlarm.mockClear();
    const failedAt = Date.now();
    failDestroy?.(new Error('unavailable'));
    await Promise.all([cancel, alarm]);

    expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1, cleanup_attempts: 0 });
    expect(handle.storage.setAlarm).toHaveBeenCalledTimes(1);
    expect(handle.storage.setAlarm.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(failedAt + POLL_MS);
    expect(handle.storage.deleteAlarm).not.toHaveBeenCalled();
    await handle.instance.alarm();
    expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 0, cleanup_attempts: 1 });
  });

  it.each(['d1', 'pool'])(
    'bounds an alarm joining stalled inline %s without duplicating cleanup',
    async (step) => {
      const fixture = createFixture();
      const handle = await startSession(fixture, true);
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      let held = false;
      if (step === 'pool') {
        vi.mocked(releaseSetupSlot).mockImplementationOnce(() => {
          held = true;
          return gate;
        });
      } else {
        const realDb = fixture.env.DATABASE;
        fixture.env.DATABASE = {
          ...realDb,
          prepare(query: string) {
            const statement = realDb.prepare(query);
            if (held || !query.includes('completed_at') || query.includes('IN (')) return statement;
            held = true;
            return {
              ...statement,
              bind: (...args: unknown[]) => {
                const bound = statement.bind(...args);
                return { ...bound, run: async () => (await gate, bound.run()) };
              },
            };
          },
        } as Env['DATABASE'];
      }
      const config = await import('../../../src/services/credential-setup-config');
      const budget = vi
        .spyOn(config, 'getSetupSessionCleanupRecoveryStepTimeoutMs')
        .mockResolvedValue(750);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const cancel = handle.instance.cancel();
      try {
        await vi.waitFor(() => expect(held).toBe(true));
        let finished = false;
        const alarm = handle.instance.alarm().then(() => {
          finished = true;
        });
        await vi.advanceTimersByTimeAsync(749);
        expect(finished).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(finished).toBe(true);
        expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1, cleanup_attempts: 0 });
        const row = fixture.doDb.prepare('SELECT expires_at FROM setup_session').get() as {
          expires_at: number;
        };
        expect(await handle.storage.getAlarm()).toBe(row.expires_at);
        // The original inline owner remains responsible; the alarm never starts another run.
        expect(destroySandboxInstance).toHaveBeenCalledTimes(step === 'pool' ? 1 : 0);
        openGate();
        await Promise.all([cancel, alarm]);
        expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
        expect(releaseSetupSlot).toHaveBeenCalledTimes(1);
        expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 0, cleanup_attempts: 0 });
      } finally {
        openGate();
        await cancel;
        budget.mockRestore();
      }
    }
  );

  it('settlement during watchdog scheduling restores the earlier recovery wake', async () => {
    const fixture = createFixture();
    const handle = await startSession(fixture, true);
    let failPool!: (error: Error) => void;
    const poolGate = new Promise<void>((_resolve, reject) => {
      failPool = reject;
    });
    vi.mocked(releaseSetupSlot).mockImplementationOnce(() => poolGate);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const cancel = handle.instance.cancel();
    await vi.waitFor(() => expect(releaseSetupSlot).toHaveBeenCalledTimes(1));
    const row = fixture.doDb.prepare('SELECT expires_at FROM setup_session').get() as {
      expires_at: number;
    };
    let scheduleWatchdog!: () => void;
    const scheduleGate = new Promise<void>((resolve) => {
      scheduleWatchdog = resolve;
    });
    const setAlarm = handle.storage.setAlarm.getMockImplementation()!;
    let watchdogStarted = false;
    handle.storage.setAlarm.mockImplementation(async (at: number) => {
      if (at === row.expires_at) {
        watchdogStarted = true;
        await scheduleGate;
      }
      await setAlarm(at);
    });
    const alarm = handle.instance.alarm();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(watchdogStarted).toBe(true);
    failPool(new Error('pool unavailable'));
    await cancel;
    expect(await handle.storage.getAlarm()).toBe(Date.now() + POLL_MS);
    scheduleWatchdog();
    await alarm;
    await vi.advanceTimersByTimeAsync(0);
    expect(await handle.storage.getAlarm()).toBe(Date.now() + POLL_MS);
    expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1, cleanup_attempts: 0 });
    expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
    await handle.instance.alarm();
    // Proven destruction needs only successful metadata reconciliation, before the failure budget.
    expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 0, cleanup_attempts: 0 });
  });

  it('quarantines a permanently stalled inline owner at its immutable watchdog without repeated work', async () => {
    const fixture = createFixture();
    fixture.env.OBSERVABILITY_DATABASE = fixture.env.DATABASE;
    const handle = await startSession(fixture, true);
    let releasePool!: () => void;
    const gate = new Promise<void>((resolve) => {
      releasePool = resolve;
    });
    vi.mocked(releaseSetupSlot).mockImplementationOnce(() => gate);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const cancel = handle.instance.cancel();
    await vi.waitFor(() => expect(releaseSetupSlot).toHaveBeenCalledTimes(1));
    const alarm = handle.instance.alarm();
    await vi.advanceTimersByTimeAsync(5_000);
    await alarm;
    const row = fixture.doDb.prepare('SELECT expires_at FROM setup_session').get() as {
      expires_at: number;
    };
    expect(await handle.storage.getAlarm()).toBe(row.expires_at);
    vi.setSystemTime(row.expires_at);
    await handle.instance.alarm();
    await handle.instance.alarm();
    expect(doRow(fixture.doDb)).toMatchObject({
      cleanup_pending: 1,
      cleanup_attempts: DEFAULT_SETUP_SESSION_MAX_CLEANUP_RECOVERY_ATTEMPTS + 1,
    });
    expect(persistError).toHaveBeenCalledTimes(1);
    expect(await handle.storage.getAlarm()).toBeNull();
    expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
    expect(releaseSetupSlot).toHaveBeenCalledTimes(1);
    handle.storage.setAlarm.mockClear();
    releasePool();
    await cancel;
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.storage.setAlarm).not.toHaveBeenCalled();
  });

  it('an alarm that fires during the claim-time D1 write joins the teardown, not a second cleanup', async () => {
    const fixture = createFixture();
    const handle = await startSession(fixture, true);
    const realDb = fixture.env.DATABASE;
    let releaseD1: (() => void) | undefined;
    const d1Gate = new Promise<void>((resolve) => {
      releaseD1 = resolve;
    });
    let held = false;
    fixture.env.DATABASE = {
      ...realDb,
      prepare(query: string) {
        const statement = realDb.prepare(query);
        // Hold only the claim-time terminal write (the repair carries an active-status IN list).
        if (held || !query.includes('completed_at') || query.includes('IN (')) return statement;
        held = true;
        return {
          ...statement,
          bind: (...args: unknown[]) => {
            const bound = statement.bind(...args);
            return { ...bound, run: async () => (await d1Gate, bound.run()) };
          },
        };
      },
    } as Env['DATABASE'];

    const cancel = handle.instance.cancel();
    await vi.waitFor(() => expect(held).toBe(true));
    // The recovery alarm fires while D1 is still being written: nothing has started the
    // sandbox cleanup yet, so only the in-flight registration can stop a second one.
    const resume = vi.spyOn(
      handle.instance as unknown as { resumeCleanup: () => unknown },
      'resumeCleanup'
    );
    const alarm = handle.instance.alarm();
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    // Still holding D1: an unjoined alarm would already have counted an attempt.
    expect(doRow(fixture.doDb).cleanup_attempts).toBe(0);
    releaseD1?.();
    await Promise.all([cancel, alarm]);

    expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
    expect(releaseSetupSlot).toHaveBeenCalledTimes(1);
    expect(scrubCalls(fixture.sandbox)).toHaveLength(1);
    expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 0, cleanup_attempts: 0 });
    expect(d1Status(fixture.d1)).toBe('cancelled');
  });

  it('quarantines unresolved cleanup after the recovery cap and alerts operators once', async () => {
    const fixture = createFixture();
    fixture.env.OBSERVABILITY_DATABASE = {} as D1Database;
    await interruptTeardown(fixture);

    for (
      let attempt = 1;
      attempt <= DEFAULT_SETUP_SESSION_MAX_CLEANUP_RECOVERY_ATTEMPTS;
      attempt++
    ) {
      vi.mocked(destroySandboxInstance).mockClear();
      const dying = createInstance(fixture.doDb, fixture.env);
      await dying.instance.alarm();
      await vi.waitFor(() => expect(destroySandboxInstance).toHaveBeenCalledTimes(1));
      expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1, cleanup_attempts: attempt });
      expect(dying.storage.setAlarm).toHaveBeenCalledTimes(2); // pre-I/O and failed-attempt retry
    }

    vi.mocked(destroySandboxInstance).mockClear();
    const last = createInstance(fixture.doDb, fixture.env);
    await last.instance.alarm();

    expect(destroySandboxInstance).not.toHaveBeenCalled();
    expect(last.storage.setAlarm).toHaveBeenCalledTimes(1); // pre-I/O safety alarm is then disarmed
    expect(last.storage.deleteAlarm).toHaveBeenCalledTimes(1);
    expect(doRow(fixture.doDb)).toMatchObject({
      status: 'cancelled',
      cleanup_pending: 1,
      cleanup_attempts: DEFAULT_SETUP_SESSION_MAX_CLEANUP_RECOVERY_ATTEMPTS + 1,
    });
    expect(persistError).toHaveBeenCalledTimes(1);
    expect(persistError).toHaveBeenCalledWith(
      fixture.env.OBSERVABILITY_DATABASE,
      expect.objectContaining({
        source: 'api',
        level: 'error',
        message: 'credential_setup.cleanup_abandoned',
        sessionId: SESSION_ID,
      }),
      fixture.env
    );
    const restarted = createInstance(fixture.doDb, fixture.env);
    await restarted.instance.alarm();
    expect(persistError).toHaveBeenCalledTimes(1);
    expect(destroySandboxInstance).not.toHaveBeenCalled();
    expect(restarted.storage.setAlarm).not.toHaveBeenCalled();
  });

  it.each(['destroy', 'pool', 'd1'])(
    'retries a %s failure without claiming cleanup succeeded',
    async (step) => {
      const fixture = createFixture();
      const handle = await startSession(fixture, true);
      const realDb = fixture.env.DATABASE;
      if (step === 'destroy')
        vi.mocked(destroySandboxInstance).mockRejectedValueOnce(new Error('unavailable'));
      if (step === 'pool')
        vi.mocked(releaseSetupSlot).mockRejectedValueOnce(new Error('unavailable'));
      if (step === 'd1')
        fixture.env.DATABASE = {
          ...realDb,
          prepare: () => {
            throw new Error('unavailable');
          },
        } as Env['DATABASE'];

      await handle.instance.cancel();
      expect(doRow(fixture.doDb)).toMatchObject({ status: 'cancelled', cleanup_pending: 1 });
      expect(handle.storage.deleteAlarm).not.toHaveBeenCalled();
      expect(
        fixture.doDb.prepare('SELECT cleanup_sandbox_destroyed FROM setup_session').get()
      ).toEqual({
        cleanup_sandbox_destroyed: step === 'destroy' ? null : 1,
      });
      fixture.env.DATABASE = realDb;
      const restarted = createInstance(fixture.doDb, fixture.env);
      await restarted.instance.alarm();
      expect(doRow(fixture.doDb)).toMatchObject({
        cleanup_pending: 0,
        cleanup_attempts: step === 'destroy' ? 1 : 0,
      });
      expect(d1Status(fixture.d1)).toBe('cancelled');
      expect(restarted.storage.deleteAlarm).toHaveBeenCalledTimes(1);
    }
  );
});

describe('CredentialSetupSession teardown — the claim', () => {
  it('an alarm step that awaited sandbox I/O across a completed cancel does not tear down again', async () => {
    const fixture = createFixture();
    const { instance } = await startSession(fixture, true);
    let releaseRead: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    // The driver reports failure, but the read is held: the alarm passed its own
    // non-terminal check and is now awaiting sandbox I/O.
    fixture.sandbox.readFile.mockClear(); // startSession's admitting step already read it
    fixture.sandbox.readFile.mockImplementationOnce(async () => {
      await readGate;
      return { content: JSON.stringify({ status: 'failed', code: 'process_exited' }) };
    });
    const alarm = instance.alarm();
    await vi.waitFor(() => expect(fixture.sandbox.readFile).toHaveBeenCalled());

    await instance.cancel(); // terminalizes immediately, defers destruction until the read settles
    expect(d1Status(fixture.d1)).toBe('cancelled');
    expect(destroySandboxInstance).not.toHaveBeenCalled();
    releaseRead?.();
    await alarm;
    await instance.alarm(); // recovery finishes the single owed cleanup

    expect(doRow(fixture.doDb)).toMatchObject({
      status: 'cancelled',
      cleanup_pending: 0,
      cleanup_from_status: 'waiting_for_user',
    });
    expect(d1Status(fixture.d1)).toBe('cancelled');
    expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
    expect(releaseSetupSlot).toHaveBeenCalledTimes(1);
  });

  it('a cancel during saving does not claim: the credential write is the commit point', async () => {
    const fixture = createFixture();
    const { instance } = await startSession(fixture, true);
    fixture.doDb.prepare(`UPDATE setup_session SET status = 'saving'`).run();

    const result = await instance.cancel();

    expect(result.status).toBe('saving');
    expect(doRow(fixture.doDb)).toMatchObject({ status: 'saving', cleanup_pending: null });
    expect(destroySandboxInstance).not.toHaveBeenCalled();
    expect(releaseSetupSlot).not.toHaveBeenCalled();
  });

  it('TTL expiry on the alarm tears down through the same path', async () => {
    const fixture = createFixture();
    const { instance } = await startSession(fixture, true);
    fixture.doDb.prepare('UPDATE setup_session SET expires_at = ?').run(Date.now() - 1);

    await instance.alarm();

    const row = fixture.d1
      .prepare('SELECT status, error_code FROM agent_credential_setup_sessions WHERE id = ?')
      .get(SESSION_ID);
    expect(row).toEqual({ status: 'expired', error_code: 'setup_session_expired' });
    expect(scrubCalls(fixture.sandbox)).toHaveLength(1);
    expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
    expect(releaseSetupSlot).toHaveBeenCalledWith(expect.anything(), LEASE_ID);
    expect(doRow(fixture.doDb)).toMatchObject({
      cleanup_pending: 0,
      cleanup_from_status: 'waiting_for_user',
    });
  });
});

describe('CredentialSetupSession teardown — D1 repair', () => {
  it('repairs D1 to terminal when the claim-time D1 write failed', async () => {
    const fixture = createFixture();
    const realDb = fixture.env.DATABASE;
    let failNextTerminalWrite = true;
    fixture.env.DATABASE = {
      ...realDb,
      prepare(query: string) {
        // The claim-time terminal write has no active-status guard; the repair has one.
        if (failNextTerminalWrite && query.includes('completed_at') && !query.includes('IN (')) {
          failNextTerminalWrite = false;
          throw new Error('D1 unavailable');
        }
        return realDb.prepare(query);
      },
    } as Env['DATABASE'];
    const { instance } = await startSession(fixture, true);

    await instance.cancel();

    expect(failNextTerminalWrite).toBe(false); // the failure was injected
    expect(d1Status(fixture.d1)).toBe('cancelled');
    expect(doRow(fixture.doDb).cleanup_pending).toBe(0);
  });

  it('never overwrites a D1 row another writer already made terminal (the sweep)', async () => {
    const fixture = createFixture();
    await interruptTeardown(fixture);
    // The setup-session sweep forces D1 terminal on its own (scheduled/setup-session-sweep.ts).
    fixture.d1
      .prepare(
        `UPDATE agent_credential_setup_sessions SET status = 'expired', error_code = 'swept' WHERE id = ?`
      )
      .run(SESSION_ID);
    vi.mocked(destroySandboxInstance).mockReset().mockResolvedValue(undefined);

    const restarted = createInstance(fixture.doDb, fixture.env);
    await restarted.instance.alarm();

    expect(doRow(fixture.doDb).cleanup_pending).toBe(0); // liveness: the cleanup did run
    expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
    const row = fixture.d1
      .prepare('SELECT status, error_code FROM agent_credential_setup_sessions WHERE id = ?')
      .get(SESSION_ID);
    expect(row).toEqual({ status: 'expired', error_code: 'swept' });
  });
});

describe('CredentialSetupSession teardown — never-started container', () => {
  it('skips the scrub exec when cancelled from provisioning, and still destroys and releases', async () => {
    const fixture = createFixture();
    const { instance } = await startSession(fixture, false);

    const result = await instance.cancel();

    expect(result.status).toBe('cancelled');
    expect(fixture.sandbox.exec).not.toHaveBeenCalled();
    expect(destroySandboxInstance).toHaveBeenCalledWith(
      expect.anything(),
      SESSION_ID,
      {
        sandboxId: SESSION_ID,
      },
      { timeoutMs: null }
    );
    expect(releaseSetupSlot).toHaveBeenCalledWith(expect.anything(), LEASE_ID);
    expect(d1Status(fixture.d1)).toBe('cancelled');
    expect(doRow(fixture.doDb)).toMatchObject({
      cleanup_pending: 0,
      cleanup_from_status: 'provisioning',
    });
  });

  it('skips the scrub when provisioning itself failed (container start error)', async () => {
    const fixture = createFixture();
    const { instance } = await startSession(fixture, false);
    fixture.sandbox.exec.mockRejectedValueOnce(new Error('Container is starting. Please retry'));

    await instance.alarm(); // provision -> mkdir fails -> teardown('failed')

    expect(fixture.sandbox.exec).toHaveBeenCalledTimes(1); // the mkdir only
    expect(scrubCalls(fixture.sandbox)).toHaveLength(0);
    expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
    expect(releaseSetupSlot).toHaveBeenCalledWith(expect.anything(), LEASE_ID);
    expect(d1Status(fixture.d1)).toBe('failed');
  });

  it('names a permanent container start failure sandbox_runtime_unavailable, not a generic failure', async () => {
    const fixture = createFixture();
    const { instance } = await startSession(fixture, false);
    // What the Sandbox SDK client throws for the SDK's own permanent-startup 500.
    fixture.sandbox.exec.mockRejectedValueOnce(new Error(SANDBOX_PERMANENT_STARTUP_MESSAGE));

    await instance.alarm();

    const row = fixture.d1
      .prepare('SELECT status, error_code FROM agent_credential_setup_sessions WHERE id = ?')
      .get(SESSION_ID) as { status: string; error_code: string };
    expect(row).toEqual({ status: 'failed', error_code: 'sandbox_runtime_unavailable' });
    expect(scrubCalls(fixture.sandbox)).toHaveLength(0);
    expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
    expect(releaseSetupSlot).toHaveBeenCalledWith(expect.anything(), LEASE_ID);
  });

  it('keeps sandbox_provision_failed for any other provisioning error (control)', async () => {
    const fixture = createFixture();
    const { instance } = await startSession(fixture, false);
    fixture.sandbox.exec.mockRejectedValueOnce(new Error('Container is starting. Please retry'));

    await instance.alarm();

    const row = fixture.d1
      .prepare('SELECT error_code FROM agent_credential_setup_sessions WHERE id = ?')
      .get(SESSION_ID) as { error_code: string };
    expect(row.error_code).toBe('sandbox_provision_failed');
  });
});

describe('CredentialSetupSession teardown — unresolved asynchronous operations', () => {
  it.each(['recovered', 'delayed_recovery', 'still_failing'])(
    'uses completed destruction once to finish final-attempt D1 cleanup when metadata is %s',
    async (outcome) => {
      const fixture = createFixture();
      fixture.env.OBSERVABILITY_DATABASE = {} as D1Database;
      const first = await startSession(fixture, true);
      const realDb = fixture.env.DATABASE;
      fixture.env.DATABASE = {
        ...realDb,
        prepare(query: string) {
          const statement = realDb.prepare(query);
          return {
            ...statement,
            bind: (...args: unknown[]) => {
              const bound = statement.bind(...args);
              if (args[0] !== 'cancelled') return bound;
              return {
                ...bound,
                run: async () => {
                  throw new Error('D1 terminal repair unavailable');
                },
              };
            },
          };
        },
      } as Env['DATABASE'];
      vi.mocked(destroySandboxInstance).mockRejectedValue(new Error('destroy unavailable'));
      await first.instance.cancel();
      await first.instance.alarm();
      await first.instance.alarm();
      expect(doRow(fixture.doDb).cleanup_attempts).toBe(2);
      vi.mocked(destroySandboxInstance).mockReset().mockResolvedValue(undefined);
      vi.mocked(releaseSetupSlot).mockClear();
      if (outcome === 'still_failing')
        vi.mocked(releaseSetupSlot).mockRejectedValue(new Error('pool unavailable'));
      await first.instance.alarm();
      expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1, cleanup_attempts: 3 });
      expect(d1Status(fixture.d1)).toBe('waiting_for_user');
      expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
      expect(
        fixture.doDb.prepare('SELECT cleanup_sandbox_destroyed FROM setup_session').get()
      ).toEqual({ cleanup_sandbox_destroyed: 1 });
      if (outcome === 'recovered') fixture.env.DATABASE = realDb;
      await first.instance.alarm();
      expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
      if (outcome === 'delayed_recovery') {
        expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1, cleanup_attempts: 3 });
        expect(releaseSetupSlot).toHaveBeenCalledTimes(2);
        fixture.env.DATABASE = realDb;
        await first.instance.alarm();
        expect(d1Status(fixture.d1)).toBe('cancelled');
        expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 0, cleanup_attempts: 3 });
        expect(persistError).not.toHaveBeenCalled();
        expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
        return;
      }
      if (outcome === 'recovered') {
        expect(d1Status(fixture.d1)).toBe('cancelled');
        expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 0, cleanup_attempts: 3 });
        expect(persistError).not.toHaveBeenCalled();
      } else {
        expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1, cleanup_attempts: 3 });
        expect(releaseSetupSlot).toHaveBeenCalledTimes(2);
        await first.instance.alarm();
        expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1, cleanup_attempts: 4 });
        expect(persistError).toHaveBeenCalledTimes(1);
        expect(releaseSetupSlot).toHaveBeenCalledTimes(3);
        await first.instance.alarm();
        expect(persistError).toHaveBeenCalledTimes(1);
        expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
        expect(releaseSetupSlot).toHaveBeenCalledTimes(3);
      }
    }
  );

  it('scrubs after a cancelled provisioning driver settles even when destruction fails', async () => {
    const fixture = createFixture();
    const first = await startSession(fixture, false);
    let finishDriver: (() => void) | undefined;
    const driver = new Promise<void>((resolve) => {
      finishDriver = resolve;
    });
    fixture.sandbox.exec
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 })
      .mockImplementationOnce(async () => {
        await driver;
        return { success: true, stdout: '', stderr: '', exitCode: 0 };
      });
    const provisioning = first.instance.alarm();
    await vi.waitFor(() => expect(fixture.sandbox.exec).toHaveBeenCalledTimes(2));
    try {
      await first.instance.cancel();
      expect(scrubCalls(fixture.sandbox)).toHaveLength(0);
      finishDriver?.();
      await provisioning;
      vi.mocked(destroySandboxInstance).mockRejectedValueOnce(new Error('destroy unavailable'));
      await createInstance(fixture.doDb, fixture.env).instance.alarm();
      expect(scrubCalls(fixture.sandbox)).toEqual([[`rm -rf '${SETUP_HOME}'`, expect.anything()]]);
      expect(doRow(fixture.doDb).cleanup_pending).toBe(1);
      expect(fixture.doDb.prepare('SELECT cleanup_scrub_state FROM setup_session').get()).toEqual({
        cleanup_scrub_state: 2,
      });
      await createInstance(fixture.doDb, fixture.env).instance.alarm();
      expect(doRow(fixture.doDb).cleanup_pending).toBe(0);
    } finally {
      finishDriver?.();
      await provisioning;
    }
  });

  it.each([
    ['scrub', 'success'],
    ['destroy', 'success'],
    ['scrub', 'success_chain'],
    ['scrub', 'rejection'],
    ['destroy', 'rejection'],
    ['scrub', 'pool_failure'],
    ['destroy', 'pool_failure'],
  ])(
    'finishes the final-attempt %s after late %s without creating an unbounded retry budget',
    async (phase, outcome) => {
      const fixture = createFixture();
      fixture.env.OBSERVABILITY_DATABASE = {} as D1Database;
      const first = await startSession(fixture, true);
      if (phase === 'scrub') fixture.sandbox.exec.mockRejectedValue(new Error('scrub unavailable'));
      vi.mocked(destroySandboxInstance).mockRejectedValue(new Error('destroy unavailable'));
      await first.instance.cancel();
      await first.instance.alarm();
      await first.instance.alarm();
      expect(doRow(fixture.doDb).cleanup_attempts).toBe(2);
      let resolveWork: (() => void) | undefined;
      let rejectWork: ((error: Error) => void) | undefined;
      const work = new Promise<void>((resolve, reject) => {
        resolveWork = resolve;
        rejectWork = reject;
      });
      fixture.sandbox.exec
        .mockReset()
        .mockResolvedValue({ success: true, stdout: '', stderr: '', exitCode: 0 });
      vi.mocked(destroySandboxInstance).mockReset().mockResolvedValue(undefined);
      vi.mocked(releaseSetupSlot).mockClear();
      if (phase === 'scrub')
        fixture.sandbox.exec.mockImplementationOnce(async () => {
          await work;
          return { success: true, stdout: '', stderr: '', exitCode: 0 };
        });
      else vi.mocked(destroySandboxInstance).mockImplementationOnce(() => work);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const finalAttempt = createInstance(fixture.doDb, fixture.env).instance.alarm();
      await vi.waitFor(() =>
        expect(
          phase === 'scrub' ? fixture.sandbox.exec : destroySandboxInstance
        ).toHaveBeenCalledTimes(1)
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await finalAttempt;
      expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1, cleanup_attempts: 3 });
      expect(releaseSetupSlot).not.toHaveBeenCalled();
      if (outcome === 'rejection') rejectWork?.(new Error('original work failed'));
      else resolveWork?.();
      await vi.advanceTimersByTimeAsync(0);
      if (outcome === 'pool_failure')
        vi.mocked(releaseSetupSlot).mockRejectedValue(new Error('pool unavailable'));
      if (outcome === 'success_chain') {
        let finishDestroy: (() => void) | undefined;
        const destroyGate = new Promise<void>((resolve) => {
          finishDestroy = resolve;
        });
        vi.mocked(destroySandboxInstance).mockImplementationOnce(() => destroyGate);
        const continuation = createInstance(fixture.doDb, fixture.env).instance.alarm();
        await vi.waitFor(() => expect(destroySandboxInstance).toHaveBeenCalledTimes(1));
        await vi.advanceTimersByTimeAsync(5_000);
        await continuation;
        expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1, cleanup_attempts: 3 });
        expect(releaseSetupSlot).not.toHaveBeenCalled();
        finishDestroy?.();
        await vi.advanceTimersByTimeAsync(0);
      }
      await createInstance(fixture.doDb, fixture.env).instance.alarm();
      if (outcome === 'success' || outcome === 'success_chain') {
        expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 0, cleanup_attempts: 3 });
        expect(releaseSetupSlot).toHaveBeenCalledTimes(1);
        expect(persistError).not.toHaveBeenCalled();
      } else {
        if (outcome === 'pool_failure') {
          expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1, cleanup_attempts: 3 });
          expect(releaseSetupSlot).toHaveBeenCalledTimes(1);
          await createInstance(fixture.doDb, fixture.env).instance.alarm();
          if (phase === 'scrub') {
            // The completed destruction is a second distinct proof, not a renewed work budget.
            expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1, cleanup_attempts: 3 });
            expect(releaseSetupSlot).toHaveBeenCalledTimes(2);
            await createInstance(fixture.doDb, fixture.env).instance.alarm();
          }
          expect(releaseSetupSlot).toHaveBeenCalledTimes(phase === 'scrub' ? 3 : 2);
        }
        expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1, cleanup_attempts: 4 });
        expect(persistError).toHaveBeenCalledTimes(1);
      }
    }
  );

  it('preserves destruction uncertainty when the successful SDK result cannot persist its proof', async () => {
    const fixture = createFixture();
    const first = await startSession(fixture, true);
    const exec = first.storage.sql.exec.bind(first.storage.sql);
    vi.spyOn(first.storage.sql, 'exec').mockImplementation(
      (query: string, ...args: SqlStorageValue[]) => {
        if (query.includes('SET cleanup_sandbox_destroyed = 1'))
          throw new Error('proof storage unavailable');
        return exec(query, ...args);
      }
    );
    await first.instance.cancel();
    expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
    expect(releaseSetupSlot).not.toHaveBeenCalled();
    expect(
      fixture.doDb
        .prepare('SELECT cleanup_sandbox_io_pending, cleanup_sandbox_destroyed FROM setup_session')
        .get()
    ).toEqual({ cleanup_sandbox_io_pending: 1, cleanup_sandbox_destroyed: null });
    const scrubCount = scrubCalls(fixture.sandbox).length;
    await createInstance(fixture.doDb, fixture.env).instance.alarm();
    expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
    expect(scrubCalls(fixture.sandbox)).toHaveLength(scrubCount);
    expect(releaseSetupSlot).not.toHaveBeenCalled();
    expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1, cleanup_attempts: 0 });
  });

  it.each(['success', 'rejection', 'eviction'])(
    'retains a timed-out destroy flight until original %s is observed',
    async (outcome) => {
      const fixture = createFixture({ SANDBOX_EXEC_TIMEOUT_MS: '30000' });
      fixture.env.OBSERVABILITY_DATABASE = {} as D1Database;
      const first = await startSession(fixture, true);
      vi.mocked(destroySandboxInstance).mockRejectedValueOnce(
        new Error('initial destroy unavailable')
      );
      await first.instance.cancel();
      expect(doRow(fixture.doDb).cleanup_pending).toBe(1);
      vi.mocked(destroySandboxInstance).mockClear();
      vi.mocked(releaseSetupSlot).mockClear();
      vi.mocked(getSandboxInstance).mockClear();
      fixture.sandbox.exec.mockClear();
      let resolveDestroy: (() => void) | undefined;
      let rejectDestroy: ((error: Error) => void) | undefined;
      const destruction = new Promise<void>((resolve, reject) => {
        resolveDestroy = resolve;
        rejectDestroy = reject;
      });
      vi.mocked(destroySandboxInstance).mockImplementationOnce(() => destruction);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const resumed = createInstance(fixture.doDb, fixture.env);
      const recovery = resumed.instance.alarm();
      await vi.waitFor(() => expect(destroySandboxInstance).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(5_000);
      await recovery;
      expect(releaseSetupSlot).not.toHaveBeenCalled();
      expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1, cleanup_attempts: 1 });
      expect(
        fixture.doDb
          .prepare(
            'SELECT cleanup_sandbox_io_pending, cleanup_sandbox_destroyed FROM setup_session'
          )
          .get()
      ).toEqual({ cleanup_sandbox_io_pending: 1, cleanup_sandbox_destroyed: null });
      for (let tick = 0; tick < 5; tick++) {
        await createInstance(fixture.doDb, fixture.env).instance.alarm();
        expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1, cleanup_attempts: 1 });
      }
      expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
      expect(fixture.sandbox.exec).not.toHaveBeenCalled();
      expect(releaseSetupSlot).not.toHaveBeenCalled();
      if (outcome === 'eviction') {
        const clocks = fixture.doDb
          .prepare('SELECT expires_at, completed_at FROM setup_session')
          .get() as { expires_at: number; completed_at: number };
        vi.setSystemTime(Math.max(clocks.expires_at, clocks.completed_at + 30_000 + POLL_MS));
        const quarantined = createInstance(fixture.doDb, fixture.env);
        await quarantined.instance.alarm();
        expect(doRow(fixture.doDb)).toMatchObject({
          cleanup_pending: 1,
          cleanup_attempts: DEFAULT_SETUP_SESSION_MAX_CLEANUP_RECOVERY_ATTEMPTS + 1,
        });
        expect(persistError).toHaveBeenCalledTimes(1);
        quarantined.storage.setAlarm.mockClear();
        await quarantined.instance.alarm();
        expect(quarantined.storage.setAlarm).not.toHaveBeenCalled();
        expect(persistError).toHaveBeenCalledTimes(1);
        expect(releaseSetupSlot).not.toHaveBeenCalled();
        return;
      }
      if (outcome === 'success') resolveDestroy?.();
      else rejectDestroy?.(new Error('original destruction failed'));
      await vi.advanceTimersByTimeAsync(0);
      expect(
        fixture.doDb
          .prepare(
            'SELECT cleanup_sandbox_io_pending, cleanup_sandbox_destroyed FROM setup_session'
          )
          .get()
      ).toEqual({
        cleanup_sandbox_io_pending: 0,
        cleanup_sandbox_destroyed: outcome === 'success' ? 1 : null,
      });
      expect(resumed.storage.setAlarm).toHaveBeenLastCalledWith(Date.now() + POLL_MS);
      await createInstance(fixture.doDb, fixture.env).instance.alarm();
      expect(destroySandboxInstance).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 2);
      expect(getSandboxInstance).not.toHaveBeenCalled();
      expect(fixture.sandbox.exec).not.toHaveBeenCalled();
      expect(releaseSetupSlot).toHaveBeenCalledTimes(1);
      expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 0 });
    }
  );

  it.each(['expires_at', 'completed_at'])(
    'quarantines pending SDK work with invalid %s once',
    async (clock) => {
      const fixture = createFixture();
      fixture.env.OBSERVABILITY_DATABASE = {} as D1Database;
      const first = await startSession(fixture, false);
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      fixture.sandbox.exec.mockImplementationOnce(async () => {
        await gate;
        return { success: true, stdout: '', stderr: '', exitCode: 0 };
      });
      const provision = first.instance.alarm();
      await vi.waitFor(() => expect(fixture.sandbox.exec).toHaveBeenCalledTimes(1));
      try {
        await first.instance.cancel();
        if (clock === 'expires_at')
          fixture.doDb.prepare('UPDATE setup_session SET expires_at = 0').run();
        else fixture.doDb.prepare('UPDATE setup_session SET completed_at = NULL').run();
        const restarted = createInstance(fixture.doDb, fixture.env);
        await restarted.instance.alarm();
        expect(doRow(fixture.doDb)).toMatchObject({
          cleanup_pending: 1,
          cleanup_attempts: DEFAULT_SETUP_SESSION_MAX_CLEANUP_RECOVERY_ATTEMPTS + 1,
        });
        expect(persistError).toHaveBeenCalledTimes(1);
        expect(persistError).toHaveBeenCalledWith(
          fixture.env.OBSERVABILITY_DATABASE,
          expect.objectContaining({
            message: 'credential_setup.cleanup_abandoned',
            context: expect.objectContaining({ reason: 'sdk_uncertainty_watchdog' }),
          }),
          fixture.env
        );
        expect(restarted.storage.setAlarm).toHaveBeenCalledTimes(1);
        expect(restarted.storage.deleteAlarm).toHaveBeenCalledTimes(1);
        restarted.storage.setAlarm.mockClear();
        await restarted.instance.alarm();
        expect(restarted.storage.setAlarm).not.toHaveBeenCalled();
        expect(persistError).toHaveBeenCalledTimes(1);
        expect(destroySandboxInstance).not.toHaveBeenCalled();
        expect(releaseSetupSlot).not.toHaveBeenCalled();
      } finally {
        release?.();
        await provision;
      }
    }
  );

  it('re-reads settled SDK state after a held D1 repair rather than replacing its prompt wake with a watchdog', async () => {
    const fixture = createFixture();
    const first = await startSession(fixture, false);
    let releaseSdk: (() => void) | undefined;
    const sdkGate = new Promise<void>((resolve) => {
      releaseSdk = resolve;
    });
    fixture.sandbox.exec.mockImplementationOnce(async () => {
      await sdkGate;
      return { success: true, stdout: '', stderr: '', exitCode: 0 };
    });
    const provision = first.instance.alarm();
    await vi.waitFor(() => expect(fixture.sandbox.exec).toHaveBeenCalledTimes(1));
    const realDb = fixture.env.DATABASE;
    // Both inline terminal writes fail while the original SDK operation remains held.
    fixture.env.DATABASE = {
      ...realDb,
      prepare: () => {
        throw new Error('D1 unavailable');
      },
    } as Env['DATABASE'];
    await first.instance.cancel();
    expect(d1Status(fixture.d1)).toBe('provisioning');
    let releaseRepair: (() => void) | undefined;
    const repairGate = new Promise<void>((resolve) => {
      releaseRepair = resolve;
    });
    let repairHeld = false;
    fixture.env.DATABASE = {
      ...realDb,
      prepare(query: string) {
        const statement = realDb.prepare(query);
        return {
          ...statement,
          bind: (...args: unknown[]) => {
            const bound = statement.bind(...args);
            return {
              ...bound,
              run: async () => {
                repairHeld = true;
                await repairGate;
                return bound.run();
              },
            };
          },
        };
      },
    } as Env['DATABASE'];
    const restarted = createInstance(fixture.doDb, fixture.env);
    const recovery = restarted.instance.alarm();
    try {
      await vi.waitFor(() => expect(repairHeld).toBe(true));
      expect(doRow(fixture.doDb)).toMatchObject({ cleanup_attempts: 0 });
      releaseSdk?.();
      await provision;
      releaseRepair?.();
      await recovery;
      expect(d1Status(fixture.d1)).toBe('cancelled');
      expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 0, cleanup_attempts: 1 });
      expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
      expect(releaseSetupSlot).toHaveBeenCalledWith(expect.anything(), LEASE_ID);
      expect(scrubCalls(fixture.sandbox)).toHaveLength(1);
    } finally {
      releaseSdk?.();
      releaseRepair?.();
      await Promise.all([provision, recovery]);
    }
  });

  it.each(['rejection', 'nonzero', 'unsuccessful'])(
    'retries a %s scrub when destruction also failed',
    async (failure) => {
      const fixture = createFixture();
      const first = await startSession(fixture, true);
      fixture.sandbox.exec.mockClear();
      if (failure === 'rejection')
        fixture.sandbox.exec.mockRejectedValueOnce(new Error('scrub unavailable'));
      else
        fixture.sandbox.exec.mockResolvedValueOnce({
          success: failure === 'nonzero',
          stdout: '',
          stderr: '',
          exitCode: failure === 'nonzero' ? 1 : 0,
        });
      vi.mocked(destroySandboxInstance).mockRejectedValueOnce(new Error('destroy unavailable'));
      await first.instance.cancel();
      expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1 });
      expect(fixture.doDb.prepare('SELECT cleanup_scrub_state FROM setup_session').get()).toEqual({
        cleanup_scrub_state: null,
      });
      await createInstance(fixture.doDb, fixture.env).instance.alarm();
      expect(scrubCalls(fixture.sandbox)).toHaveLength(2);
      expect(destroySandboxInstance).toHaveBeenCalledTimes(2);
      expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 0 });
    }
  );

  it('does not spend cleanup attempts on pending SDK watchdog alarms before settlement', async () => {
    const fixture = createFixture({ SANDBOX_EXEC_TIMEOUT_MS: '30000' });
    fixture.env.OBSERVABILITY_DATABASE = {} as D1Database;
    const first = await startSession(fixture, false);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.sandbox.exec.mockImplementationOnce(async () => {
      await gate;
      return { success: true, stdout: '', stderr: '', exitCode: 0 };
    });
    const provision = first.instance.alarm();
    await vi.waitFor(() => expect(fixture.sandbox.exec).toHaveBeenCalledTimes(1));
    try {
      await first.instance.cancel();
      // An already-expired session still grants the immutable post-teardown SDK grace.
      fixture.doDb.prepare('UPDATE setup_session SET expires_at = ?').run(Date.now() - 1);
      const clocks = fixture.doDb
        .prepare('SELECT expires_at, completed_at FROM setup_session')
        .get() as { expires_at: number; completed_at: number };
      const expectedWatchdog = Math.max(clocks.expires_at, clocks.completed_at + 30_000 + POLL_MS);
      vi.useFakeTimers({ toFake: ['Date'] });
      for (let tick = 0; tick < 6; tick++) {
        vi.setSystemTime(Date.now() + POLL_MS);
        const resumed = createInstance(fixture.doDb, fixture.env);
        await resumed.instance.alarm();
        expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1, cleanup_attempts: 0 });
        expect(resumed.storage.setAlarm).toHaveBeenLastCalledWith(expectedWatchdog);
      }
      expect(persistError).not.toHaveBeenCalled();
      expect(destroySandboxInstance).not.toHaveBeenCalled();
      release?.();
      await provision;
      await createInstance(fixture.doDb, fixture.env).instance.alarm();
      expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 0, cleanup_attempts: 1 });
      expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
    } finally {
      release?.();
      await provision;
    }
  });

  it.each(['acquisition', 'mkdir', 'writeFile', 'driver'])(
    'defers teardown across cancelled provisioning %s and prevents late SDK operations',
    async (phase) => {
      const fixture = createFixture();
      const first = await startSession(fixture, false);
      let finishFlight: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        finishFlight = resolve;
      });
      const result = { success: true, stdout: '', stderr: '', exitCode: 0 };
      if (phase === 'acquisition')
        vi.mocked(getSandboxInstance).mockImplementationOnce(async () => {
          await gate;
          return fixture.sandbox as never;
        });
      else if (phase === 'writeFile')
        fixture.sandbox.writeFile.mockImplementationOnce(async () => {
          await gate;
        });
      else {
        if (phase === 'driver') fixture.sandbox.exec.mockResolvedValueOnce(result);
        fixture.sandbox.exec.mockImplementationOnce(async () => {
          await gate;
          return result;
        });
      }
      const provision = first.instance.alarm();
      await vi.waitFor(() =>
        expect(
          phase === 'acquisition'
            ? getSandboxInstance
            : phase === 'writeFile'
              ? fixture.sandbox.writeFile
              : fixture.sandbox.exec
        ).toHaveBeenCalledTimes(phase === 'driver' ? 2 : 1)
      );
      const beforeExecs = fixture.sandbox.exec.mock.calls.length;
      const beforeWrites = fixture.sandbox.writeFile.mock.calls.length;
      try {
        await first.instance.cancel();
        expect(d1Status(fixture.d1)).toBe('cancelled');
        expect(destroySandboxInstance).not.toHaveBeenCalled();
        expect(releaseSetupSlot).not.toHaveBeenCalled();
        const restarted = createInstance(fixture.doDb, fixture.env);
        await restarted.instance.alarm();
        expect(destroySandboxInstance).not.toHaveBeenCalled();
        expect(fixture.sandbox.exec).toHaveBeenCalledTimes(beforeExecs);
        finishFlight?.();
        await provision;
        expect(fixture.sandbox.writeFile).toHaveBeenCalledTimes(beforeWrites);
        expect(fixture.sandbox.exec).toHaveBeenCalledTimes(beforeExecs);
        await restarted.instance.alarm();
        expect(scrubCalls(fixture.sandbox)).toHaveLength(1);
        expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
        expect(releaseSetupSlot).toHaveBeenCalledWith(expect.anything(), LEASE_ID);
        expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 0 });
        expect(d1Status(fixture.d1)).toBe('cancelled');
      } finally {
        finishFlight?.();
        await provision;
      }
    }
  );

  it.each(['admitting', 'exchanging', 'capturing'] as const)(
    'finishes cleanup while the original %s D1 write remains held',
    async (phase) => {
      const fixture = createFixture();
      const handle = await startSession(
        fixture,
        phase !== 'admitting',
        phase === 'exchanging' ? 'claude-code' : 'openai-codex'
      );
      const realDb = fixture.env.DATABASE;
      let releaseWrite: (() => void) | undefined;
      let writeHeld = false;
      const gate = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      fixture.env.DATABASE = {
        ...realDb,
        prepare(query: string) {
          const statement = realDb.prepare(query);
          return {
            ...statement,
            bind: (...args: unknown[]) => {
              const bound = statement.bind(...args);
              if (args[0] !== phase) return bound;
              return {
                ...bound,
                run: async () => {
                  writeHeld = true;
                  await gate;
                  return bound.run();
                },
              };
            },
          };
        },
      } as Env['DATABASE'];
      if (phase === 'capturing') fixture.sandbox.exists.mockResolvedValue({ exists: true });
      const provision =
        phase === 'exchanging'
          ? handle.instance.submitVerificationCode('test-code')
          : handle.instance.alarm();
      try {
        await vi.waitFor(() => expect(writeHeld).toBe(true));
        expect(
          fixture.doDb.prepare('SELECT cleanup_sandbox_io_pending FROM setup_session').get()
        ).toEqual({ cleanup_sandbox_io_pending: 0 });
        const readsBeforeCancel = fixture.sandbox.readFile.mock.calls.length;
        await handle.instance.cancel();
        expect(d1Status(fixture.d1)).toBe('cancelled');
        expect(doRow(fixture.doDb)).toMatchObject({ status: 'cancelled', cleanup_pending: 0 });
        expect(scrubCalls(fixture.sandbox)).toHaveLength(1);
        expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
        expect(releaseSetupSlot).toHaveBeenCalledWith(expect.anything(), LEASE_ID);
        releaseWrite?.();
        await provision;
        // Assert before recovery can repair a resurrected active mirror.
        expect(d1Status(fixture.d1)).toBe('cancelled');
        expect(doRow(fixture.doDb)).toMatchObject({ status: 'cancelled', cleanup_pending: 0 });
        expect(fixture.sandbox.readFile).toHaveBeenCalledTimes(readsBeforeCancel);
        await handle.instance.alarm();
        await handle.instance.alarm();
        expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 0 });
        expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
      } finally {
        releaseWrite?.();
        await provision;
      }
    }
  );

  it('keeps an issued scrub pending across eviction and tears down only after its original promise settles', async () => {
    const fixture = createFixture({ SANDBOX_EXEC_TIMEOUT_MS: '30000' });
    const first = await startSession(fixture, true);
    let settleScrub: (() => void) | undefined;
    const scrub = new Promise<{
      success: boolean;
      stdout: string;
      stderr: string;
      exitCode: number;
    }>((resolve) => {
      settleScrub = () => resolve({ success: true, stdout: '', stderr: '', exitCode: 0 });
    });
    fixture.sandbox.exec.mockClear().mockImplementation(() => scrub);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const cancel = first.instance.cancel();
    await vi.waitFor(() => expect(scrubCalls(fixture.sandbox)).toHaveLength(1));
    const restarted = createInstance(fixture.doDb, fixture.env);
    const recovery = restarted.instance.alarm();
    await vi.advanceTimersByTimeAsync(5_000);
    await recovery;

    expect(destroySandboxInstance).not.toHaveBeenCalled();
    expect(releaseSetupSlot).not.toHaveBeenCalled();
    expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1 });
    expect(scrubCalls(fixture.sandbox)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(25_000);
    await cancel;
    expect(destroySandboxInstance).not.toHaveBeenCalled();
    first.storage.setAlarm.mockClear();
    settleScrub?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.storage.setAlarm).toHaveBeenCalledTimes(1);
    await restarted.instance.alarm();
    expect(scrubCalls(fixture.sandbox)).toHaveLength(1);
    expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
    expect(releaseSetupSlot).toHaveBeenCalledWith(expect.anything(), LEASE_ID);
    expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 0 });
  });

  it('keeps cleanup deferred until overlapping poll and verification SDK flights both settle', async () => {
    const fixture = createFixture();
    fixture.d1
      .prepare("UPDATE agent_credential_setup_sessions SET agent_type = 'claude-code'")
      .run();
    const handle = await startSession(fixture, true, 'claude-code');
    let finishPoll: (() => void) | undefined;
    let finishCode: (() => void) | undefined;
    const pollGate = new Promise<void>((resolve) => {
      finishPoll = resolve;
    });
    const codeGate = new Promise<void>((resolve) => {
      finishCode = resolve;
    });
    fixture.sandbox.exec.mockClear();
    fixture.sandbox.readFile.mockClear().mockImplementationOnce(async () => {
      await pollGate;
      return {
        content: JSON.stringify({
          status: 'waiting_for_user',
          verificationUrl: 'https://example.com/verify',
        }),
      };
    });
    fixture.sandbox.writeFile.mockClear().mockImplementationOnce(async () => {
      await codeGate;
    });
    const poll = handle.instance.alarm();
    await vi.waitFor(() => expect(fixture.sandbox.readFile).toHaveBeenCalledTimes(1));
    const code = handle.instance.submitVerificationCode('test-code').then(
      () => undefined,
      () => undefined
    );
    await vi.waitFor(() => expect(fixture.sandbox.writeFile).toHaveBeenCalledTimes(1));
    try {
      await handle.instance.cancel();
      expect(d1Status(fixture.d1)).toBe('cancelled');
      expect(destroySandboxInstance).not.toHaveBeenCalled();
      finishPoll?.();
      await poll;
      const row = fixture.doDb
        .prepare('SELECT cleanup_sandbox_io_pending FROM setup_session')
        .get() as { cleanup_sandbox_io_pending: number };
      expect(row.cleanup_sandbox_io_pending).toBeGreaterThan(0);
      await handle.instance.alarm();
      expect(destroySandboxInstance).not.toHaveBeenCalled();
      expect(releaseSetupSlot).not.toHaveBeenCalled();
      expect(fixture.sandbox.exec).not.toHaveBeenCalled();
      expect(fixture.sandbox.readFile).toHaveBeenCalledTimes(1);
      finishCode?.();
      await code;
      await handle.instance.alarm();
      expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
      expect(releaseSetupSlot).toHaveBeenCalledWith(expect.anything(), LEASE_ID);
      expect(doRow(fixture.doDb)).toMatchObject({ status: 'cancelled', cleanup_pending: 0 });
      expect(d1Status(fixture.d1)).toBe('cancelled');
    } finally {
      finishPoll?.();
      finishCode?.();
      await Promise.all([poll, code]);
    }
  });

  it('quarantines an unsettled scrub and never re-arms after late original settlement', async () => {
    const fixture = createFixture({ SANDBOX_EXEC_TIMEOUT_MS: '30000' });
    fixture.env.OBSERVABILITY_DATABASE = {} as D1Database;
    const first = await startSession(fixture, true);
    let settleScrub: (() => void) | undefined;
    const gate = new Promise<{
      success: boolean;
      stdout: string;
      stderr: string;
      exitCode: number;
    }>((resolve) => {
      settleScrub = () => resolve({ success: true, stdout: '', stderr: '', exitCode: 0 });
    });
    fixture.sandbox.exec.mockClear().mockImplementation(() => gate);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const cancel = first.instance.cancel();
    await vi.waitFor(() => expect(scrubCalls(fixture.sandbox)).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(30_000);
    await cancel;
    const clocks = fixture.doDb
      .prepare('SELECT expires_at, completed_at FROM setup_session')
      .get() as { expires_at: number; completed_at: number };
    const deadline = Math.max(clocks.expires_at, clocks.completed_at + 30_000 + POLL_MS);
    vi.setSystemTime(deadline - 1);
    const beforeDeadline = createInstance(fixture.doDb, fixture.env);
    await beforeDeadline.instance.alarm();
    expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1, cleanup_attempts: 0 });
    expect(beforeDeadline.storage.setAlarm).toHaveBeenLastCalledWith(deadline);
    vi.setSystemTime(deadline);
    const quarantined = createInstance(fixture.doDb, fixture.env);
    await quarantined.instance.alarm();
    expect(doRow(fixture.doDb)).toMatchObject({
      cleanup_pending: 1,
      cleanup_attempts: DEFAULT_SETUP_SESSION_MAX_CLEANUP_RECOVERY_ATTEMPTS + 1,
    });
    expect(persistError).toHaveBeenCalledTimes(1);
    expect(destroySandboxInstance).not.toHaveBeenCalled();
    expect(releaseSetupSlot).not.toHaveBeenCalled();
    first.storage.setAlarm.mockClear();
    settleScrub?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.storage.setAlarm).not.toHaveBeenCalled();
    quarantined.storage.setAlarm.mockClear();
    await quarantined.instance.alarm();
    expect(quarantined.storage.setAlarm).not.toHaveBeenCalled();
    expect(persistError).toHaveBeenCalledTimes(1);
    expect(
      fixture.doDb
        .prepare('SELECT cleanup_scrub_state, cleanup_sandbox_destroyed FROM setup_session')
        .get()
    ).toEqual({ cleanup_scrub_state: 2, cleanup_sandbox_destroyed: null });
    expect(doRow(fixture.doDb).cleanup_pending).toBe(1);
  });

  it.each(['pool', 'd1'])(
    'bounds a stalled recovery %s write and preserves its cleanup obligation',
    async (step) => {
      const fixture = createFixture();
      await interruptTeardown(fixture);
      vi.mocked(destroySandboxInstance).mockReset().mockResolvedValue(undefined);
      if (step === 'pool')
        vi.mocked(releaseSetupSlot).mockImplementation(() => new Promise(() => {}));
      let repairStarted = false;
      if (step === 'd1') {
        const realDb = fixture.env.DATABASE;
        fixture.env.DATABASE = {
          ...realDb,
          prepare(query: string) {
            const statement = realDb.prepare(query);
            if (!query.includes('completed_at') || !query.includes('IN (')) return statement;
            return {
              ...statement,
              bind: (...args: unknown[]) => {
                const bound = statement.bind(...args);
                return {
                  ...bound,
                  run: () => {
                    repairStarted = true;
                    return new Promise(() => {});
                  },
                };
              },
            };
          },
        } as Env['DATABASE'];
      }
      const restarted = createInstance(fixture.doDb, fixture.env);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let finished = false;
      const recovery = restarted.instance.alarm().then(() => {
        finished = true;
      });
      await vi.waitFor(() =>
        expect(
          step === 'pool' ? vi.mocked(releaseSetupSlot).mock.calls.length > 0 : repairStarted
        ).toBe(true)
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(finished).toBe(true);
      await recovery;
      expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1 });
      expect(restarted.storage.deleteAlarm).not.toHaveBeenCalled();
    }
  );
});

describe('CredentialSetupSession teardown — recovery I/O budget', () => {
  it('never starts a late scrub after acquisition outlives its recovery deadline', async () => {
    const fixture = createFixture({ SANDBOX_EXEC_TIMEOUT_MS: '30000' });
    await interruptTeardown(fixture);
    // Legacy pending cleanup has no positive scrub/provision settlement metadata.
    fixture.doDb
      .prepare(
        'UPDATE setup_session SET cleanup_scrub_state = NULL, cleanup_sandbox_io_pending = NULL'
      )
      .run();
    const config = await import('../../../src/services/credential-setup-config');
    // Prove the cleanup consumer uses its configurable recovery budget.
    const budget = vi
      .spyOn(config, 'getSetupSessionCleanupRecoveryStepTimeoutMs')
      .mockResolvedValue(750);
    let acquired: ((sandbox: ReturnType<typeof createFakeSandbox>) => void) | undefined;
    const acquisition = new Promise<ReturnType<typeof createFakeSandbox>>((resolve) => {
      acquired = resolve;
    });
    vi.mocked(getSandboxInstance)
      .mockReset()
      .mockImplementation(() => acquisition as never);
    vi.mocked(destroySandboxInstance).mockReset().mockResolvedValue(undefined);
    fixture.sandbox.exec.mockClear();
    const restarted = createInstance(fixture.doDb, fixture.env);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const recovery = restarted.instance.alarm();
      await vi.waitFor(() => expect(getSandboxInstance).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(750);
      await recovery;
      expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 0 });
      expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
      expect(
        fixture.doDb.prepare('SELECT cleanup_sandbox_destroyed FROM setup_session').get()
      ).toEqual({ cleanup_sandbox_destroyed: 1 });
      acquired?.(fixture.sandbox);
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.sandbox.exec).not.toHaveBeenCalled();
    } finally {
      budget.mockRestore();
    }
  });

  it.each(['scrub', 'destroy'])(
    'bounds stalled recovery %s separately below the interactive timeout',
    async (step) => {
      const fixture = createFixture({ SANDBOX_EXEC_TIMEOUT_MS: '30000' });
      await interruptTeardown(fixture);
      vi.mocked(releaseSetupSlot).mockClear();
      vi.mocked(destroySandboxInstance)
        .mockReset()
        .mockImplementation(() => new Promise(() => {}));
      if (step === 'scrub') {
        fixture.doDb
          .prepare(
            'UPDATE setup_session SET cleanup_scrub_state = NULL, cleanup_sandbox_io_pending = NULL'
          )
          .run();
        fixture.sandbox.exec.mockClear().mockImplementation(() => new Promise(() => {}));
      }
      const restarted = createInstance(fixture.doDb, fixture.env);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let finished = false;
      const recovery = restarted.instance.alarm().then(() => {
        finished = true;
      });
      await vi.waitFor(() =>
        expect(
          step === 'scrub'
            ? scrubCalls(fixture.sandbox).length
            : vi.mocked(destroySandboxInstance).mock.calls.length
        ).toBe(1)
      );
      await vi.advanceTimersByTimeAsync(4_000);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await recovery;
      expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1 });
      expect(
        fixture.doDb.prepare('SELECT cleanup_sandbox_destroyed FROM setup_session').get()
      ).toEqual({ cleanup_sandbox_destroyed: null });
      if (step === 'scrub') {
        expect(destroySandboxInstance).not.toHaveBeenCalled();
        expect(releaseSetupSlot).not.toHaveBeenCalled();
      }
      expect(restarted.storage.deleteAlarm).not.toHaveBeenCalled();
    }
  );
});

describe('CredentialSetupSession teardown — scrub timeout', () => {
  it('returns after the interactive scrub deadline but retains uncertainty until SDK settlement', async () => {
    const fixture = createFixture({ SANDBOX_EXEC_TIMEOUT_MS: '30000' });
    const { instance } = await startSession(fixture, true);
    fixture.sandbox.exec.mockImplementation(() => new Promise(() => undefined));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    let settled = false;
    const cancel = instance.cancel().then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(scrubCalls(fixture.sandbox)).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(29_000);
    expect(destroySandboxInstance).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await cancel;

    expect(destroySandboxInstance).not.toHaveBeenCalled();
    expect(releaseSetupSlot).not.toHaveBeenCalled();
    expect(doRow(fixture.doDb).cleanup_pending).toBe(1);
  });
});

describe('CredentialSetupSession — cleanup columns on an existing object', () => {
  it('adds the columns to a pre-existing setup_session table without losing the row, idempotently', async () => {
    const fixture = createFixture();
    fixture.doDb.exec(
      `CREATE TABLE setup_session (
        id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, project_id TEXT,
        scope TEXT NOT NULL, agent_type TEXT NOT NULL, credential_kind TEXT NOT NULL,
        provider TEXT NOT NULL, agent_name TEXT NOT NULL, status TEXT NOT NULL,
        pool_lease_id TEXT, codex_home TEXT NOT NULL, expires_at INTEGER NOT NULL,
        capture_poll_ms INTEGER NOT NULL, error_code TEXT, error_message TEXT,
        completed_at INTEGER
      )`
    );
    fixture.doDb
      .prepare(
        `INSERT INTO setup_session VALUES (?, ?, NULL, 'user', 'openai-codex', 'oauth-token',
          'openai', 'OpenAI Codex', 'waiting_for_user', ?, ?, ?, ?, NULL, NULL, NULL)`
      )
      .run(SESSION_ID, USER_ID, LEASE_ID, SETUP_HOME, Date.now() + 900_000, POLL_MS);

    createInstance(fixture.doDb, fixture.env);
    const { instance } = createInstance(fixture.doDb, fixture.env); // second constructor run

    expect(
      fixture.doDb.prepare('SELECT cleanup_sandbox_destroyed FROM setup_session').get()
    ).toEqual({ cleanup_sandbox_destroyed: null });
    expect(doRow(fixture.doDb)).toEqual({
      status: 'waiting_for_user',
      cleanup_pending: null,
      cleanup_from_status: null,
      cleanup_attempts: null,
    });
    await instance.cancel();
    expect(doRow(fixture.doDb)).toEqual({
      status: 'cancelled',
      cleanup_pending: 0,
      cleanup_from_status: 'waiting_for_user',
      cleanup_attempts: 0,
    });
    expect(scrubCalls(fixture.sandbox)).toHaveLength(1);
  });

  it('does not resume a terminal row torn down before the columns existed (cleanup_pending NULL)', async () => {
    const fixture = createFixture();
    const { instance, storage } = createInstance(fixture.doDb, fixture.env);
    fixture.doDb
      .prepare(
        `INSERT INTO setup_session (id, user_id, project_id, scope, agent_type, credential_kind,
          provider, agent_name, status, pool_lease_id, codex_home, expires_at, capture_poll_ms)
         VALUES (?, ?, NULL, 'user', 'openai-codex', 'oauth-token', 'openai', 'OpenAI Codex',
          'cancelled', ?, ?, ?, ?)`
      )
      .run(SESSION_ID, USER_ID, LEASE_ID, SETUP_HOME, Date.now() + 900_000, POLL_MS);

    await instance.alarm();

    expect(doRow(fixture.doDb).status).toBe('cancelled'); // liveness: the row is the one read
    expect(fixture.sandbox.exec).not.toHaveBeenCalled();
    expect(destroySandboxInstance).not.toHaveBeenCalled();
    expect(releaseSetupSlot).not.toHaveBeenCalled();
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });
});

describe('CredentialSetupSession — Sandbox SDK permanent-start contract', () => {
  it('the real destruction helper with caller-owned deadline observes the raw SDK promise beyond 30 seconds', async () => {
    const actual = await vi.importActual<typeof import('../../../src/services/sandbox')>(
      '../../../src/services/sandbox'
    );
    let finishDestroy: (() => void) | undefined;
    const raw = new Promise<void>((resolve) => {
      finishDestroy = resolve;
    });
    const destroy = vi.fn(() => raw);
    vi.doMock('@cloudflare/sandbox', () => ({ getSandbox: () => ({ destroy }) }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const operation = actual
      .destroySandboxInstance(
        { SANDBOX: {}, SANDBOX_EXEC_TIMEOUT_MS: '30000' } as Env,
        SESSION_ID,
        { sandboxId: SESSION_ID },
        { timeoutMs: null }
      )
      .then(() => {
        settled = true;
      });
    try {
      await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(35_000);
      expect(settled).toBe(false);
      finishDestroy?.();
      await operation;
      expect(settled).toBe(true);
    } finally {
      finishDestroy?.();
      vi.doUnmock('@cloudflare/sandbox');
    }
  });

  it('the installed @cloudflare/sandbox still answers permanent start failures with the matched message', () => {
    // The session maps this exact text to sandbox_runtime_unavailable. If an SDK upgrade
    // rewords it, the mapping silently falls back to sandbox_provision_failed; fail here instead.
    const require = createRequire(import.meta.url);
    const distDir = dirname(require.resolve('@cloudflare/sandbox'));
    const bundles = readdirSync(distDir).filter((name) => name.endsWith('.js'));
    const containing = bundles.filter((name) =>
      readFileSync(join(distDir, name), 'utf-8').includes(SANDBOX_PERMANENT_STARTUP_MESSAGE)
    );
    expect(bundles.length).toBeGreaterThan(0);
    expect(containing.length).toBeGreaterThan(0);
  });
});
