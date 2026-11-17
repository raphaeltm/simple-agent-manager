/**
 * Teardown ordering and recovery for the CredentialSetupSession DO
 * (apps/api/src/durable-objects/credential-setup-session/index.ts).
 *
 * Incident (found on the self-host branch, applies on Cloudflare too; task
 * tasks/active/2026-11-17-l19-credential-setup-teardown-robustness.md): teardown
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
  const storage = {
    sql: createSqlStorage(doDb),
    setAlarm: vi.fn(async (_at: number) => undefined),
    deleteAlarm: vi.fn(async () => undefined),
  };
  const ctx = {
    storage,
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
  const instance = new CredentialSetupSession(ctx as never, env);
  return { instance, storage };
}

function createFakeSandbox() {
  return {
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
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

async function startSession(fixture: Fixture, toWaitingForUser: boolean) {
  const handle = createInstance(fixture.doDb, fixture.env);
  await handle.instance.create({
    id: SESSION_ID,
    userId: USER_ID,
    projectId: null,
    scope: 'user',
    agentType: 'openai-codex',
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
 * Start a cancel whose sandbox destroy never settles, the way an isolate that dies
 * mid-teardown never gets past it. Records the D1 status seen by each sandbox call.
 */
async function interruptTeardown(fixture: Fixture) {
  const handle = await startSession(fixture, true);
  const seen: string[] = [];
  fixture.sandbox.exec.mockImplementation(async (command: string) => {
    if (command.startsWith('rm -rf')) seen.push(`scrub:${d1Status(fixture.d1)}`);
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  vi.mocked(destroySandboxInstance).mockImplementation(() => {
    seen.push(`destroy:${d1Status(fixture.d1)}`);
    return new Promise<void>(() => undefined);
  });
  // Clear the provisioning-time alarms so assertions see only the claim-time one.
  handle.storage.setAlarm.mockClear();
  const cancelledAt = Date.now();
  void handle.instance.cancel();
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
    expect(storage.setAlarm).toHaveBeenCalledTimes(1);
    expect(storage.setAlarm.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(cancelledAt + POLL_MS);
    // The sign-in URL and user code are gone with the claim, not after the cleanup.
    expect(fixture.doDb.prepare('SELECT COUNT(*) AS n FROM device_auth_details').get()).toEqual({
      n: 0,
    });
    expect(storage.deleteAlarm).not.toHaveBeenCalled();
    expect(releaseSetupSlot).not.toHaveBeenCalled(); // the "process" never got that far

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
  it('scrubs on recovery after a cancellation interrupted during provisioning', async () => {
    const fixture = createFixture();
    const first = await startSession(fixture, false);
    vi.mocked(destroySandboxInstance).mockImplementation(() => new Promise(() => {}));
    void first.instance.cancel();
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

  it('a restarted instance finishes the interrupted cleanup on its alarm, and the next alarm is a no-op', async () => {
    const fixture = createFixture();
    await interruptTeardown(fixture);
    vi.mocked(destroySandboxInstance).mockReset().mockResolvedValue(undefined);
    fixture.sandbox.exec.mockClear();

    // The isolate died: a new instance over the same storage gets the alarm.
    const restarted = createInstance(fixture.doDb, fixture.env);
    await restarted.instance.alarm();

    // A resumed cleanup still scrubs: on Cloudflare the container outlives the dead
    // isolate, so the captured credential may still be on it.
    expect(scrubCalls(fixture.sandbox)).toEqual([[`rm -rf '${SETUP_HOME}'`, expect.anything()]]);
    expect(destroySandboxInstance).toHaveBeenCalledWith(expect.anything(), SESSION_ID, {
      sandboxId: SESSION_ID,
    });
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
      void dying.instance.alarm();
      await vi.waitFor(() => expect(destroySandboxInstance).toHaveBeenCalledTimes(1));
      expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 1, cleanup_attempts: attempt });
      expect(dying.storage.setAlarm).toHaveBeenCalledTimes(1); // re-armed before its I/O
    }

    vi.mocked(destroySandboxInstance).mockClear();
    const last = createInstance(fixture.doDb, fixture.env);
    await last.instance.alarm();

    expect(destroySandboxInstance).not.toHaveBeenCalled();
    expect(last.storage.setAlarm).not.toHaveBeenCalled();
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
      fixture.env.DATABASE = realDb;
      const restarted = createInstance(fixture.doDb, fixture.env);
      await restarted.instance.alarm();
      expect(doRow(fixture.doDb)).toMatchObject({ cleanup_pending: 0, cleanup_attempts: 1 });
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

    await instance.cancel(); // claims and finishes the whole teardown meanwhile
    expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
    releaseRead?.();
    await alarm;

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
    expect(destroySandboxInstance).toHaveBeenCalledWith(expect.anything(), SESSION_ID, {
      sandboxId: SESSION_ID,
    });
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

describe('CredentialSetupSession teardown — scrub timeout', () => {
  it('abandons a scrub exec that never settles after SANDBOX_EXEC_TIMEOUT_MS and still destroys', async () => {
    const fixture = createFixture({ SANDBOX_EXEC_TIMEOUT_MS: '5000' });
    const { instance } = await startSession(fixture, true);
    fixture.sandbox.exec.mockImplementation(() => new Promise(() => undefined));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    let settled = false;
    const cancel = instance.cancel().then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(scrubCalls(fixture.sandbox)).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(destroySandboxInstance).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await cancel;

    expect(destroySandboxInstance).toHaveBeenCalledTimes(1);
    expect(releaseSetupSlot).toHaveBeenCalledWith(expect.anything(), LEASE_ID);
    expect(doRow(fixture.doDb).cleanup_pending).toBe(0);
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
