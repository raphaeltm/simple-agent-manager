import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { agentCredentialSetupSessionsRoutes } from '../../../src/routes/agent-credential-setup-sessions';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown
    ) {}
  },
}));

vi.mock('../../../src/services/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/sandbox')>();
  return {
    ...actual,
    getSandboxInstance: vi.fn(),
    destroySandboxInstance: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('../../../src/services/setup-session-pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/setup-session-pool')>();
  return { ...actual, releaseSetupSlot: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../src/services/agent-credential-save', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/agent-credential-save')>();
  return { ...actual, saveAgentCredentialForUser: vi.fn() };
});

const { CredentialSetupSession } =
  await import('../../../src/durable-objects/credential-setup-session');
const { getSandboxInstance } = await import('../../../src/services/sandbox');
const { saveAgentCredentialForUser } = await import('../../../src/services/agent-credential-save');

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  getUserId: () => 'owner-user',
}));

function setupDatabase(): Database.Database {
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
      updated_at TEXT NOT NULL
    )`
  );
  return sqlite;
}

function createDoContext() {
  let row: Record<string, unknown> | undefined;
  let details: Record<string, unknown> | undefined;
  const sql = {
    exec: vi.fn((query: string, ...args: unknown[]) => {
      const normalized = query.trim().toLowerCase();
      if (normalized.startsWith('create table')) return { toArray: () => [] };
      if (normalized.includes('insert or replace into setup_session')) {
        const [
          id,
          userId,
          projectId,
          scope,
          agentType,
          credentialKind,
          provider,
          agentName,
          poolLeaseId,
          codexHome,
          expiresAt,
          capturePollMs,
        ] = args;
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
      } else if (normalized.includes('insert or replace into device_auth_details')) {
        details = { verification_url: args[0], user_code: args[1] };
      } else if (normalized.includes('delete from device_auth_details')) {
        details = undefined;
      } else if (normalized.includes('update setup_session') && row) {
        row = {
          ...row,
          status: args[0],
          error_code: args[1] ?? null,
          error_message: args[2] ?? null,
          completed_at: args[3] ?? row.completed_at,
        };
      }
      if (normalized.includes('select * from setup_session')) {
        return { toArray: () => (row ? [{ ...row }] : []) };
      }
      if (normalized.includes('select verification_url, user_code')) {
        return { toArray: () => (details ? [{ ...details }] : []) };
      }
      return { toArray: () => [] };
    }),
  };
  return {
    storage: {
      sql,
      setAlarm: vi.fn().mockResolvedValue(undefined),
      deleteAlarm: vi.fn().mockResolvedValue(undefined),
    },
    blockConcurrencyWhile: vi.fn(async (callback: () => Promise<unknown>) => callback()),
  };
}

describe('native Codex setup route vertical slice', () => {
  it('carries owned D1 session state through the DO boundary without persisting device details', async () => {
    const sqlite = setupDatabase();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO agent_credential_setup_sessions
         (id, user_id, project_id, scope, agent_type, credential_kind, status,
          sandbox_id, pool_lease_id, expires_at, created_at, updated_at)
         VALUES (?, ?, NULL, 'user', 'openai-codex', 'oauth-token',
          'waiting_for_user', ?, 'lease-1', ?, ?, ?)`
      )
      .run(
        'session-1',
        'owner-user',
        'session-1',
        new Date(Date.now() + 60_000).toISOString(),
        now,
        now
      );

    const getState = vi.fn().mockResolvedValue({
      id: 'session-1',
      status: 'waiting_for_user',
      expiresAt: Date.now() + 60_000,
      errorCode: null,
      errorMessage: null,
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
    });
    const env = {
      DATABASE: createSqliteD1(sqlite),
      CREDENTIAL_SETUP_SESSION: {
        idFromName: vi.fn(() => ({ toString: () => 'do-session-1' })),
        get: vi.fn(() => ({ getState })),
      },
    } as unknown as Env;
    const app = new Hono<{ Bindings: Env }>();
    app.onError((error, c) => {
      const status = 'statusCode' in error ? Number(error.statusCode) : 500;
      return c.json({ error: 'not_found' }, status as 404 | 500);
    });
    app.route('/api/agent-credential-setup-sessions', agentCredentialSetupSessionsRoutes);

    const response = await app.request('/api/agent-credential-setup-sessions/session-1', {}, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: 'session-1',
      status: 'waiting_for_user',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
    });
    expect(getState).toHaveBeenCalledOnce();
    const persisted = sqlite
      .prepare('SELECT * FROM agent_credential_setup_sessions WHERE id = ?')
      .get('session-1') as Record<string, unknown>;
    expect(JSON.stringify(persisted)).not.toContain('auth.openai.com');
    expect(JSON.stringify(persisted)).not.toContain('ABCD-EFGH');
  });

  it('does not cross the DO boundary for a session owned by another user', async () => {
    const sqlite = setupDatabase();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO agent_credential_setup_sessions
         (id, user_id, project_id, scope, agent_type, credential_kind, status,
          sandbox_id, pool_lease_id, expires_at, created_at, updated_at)
         VALUES (?, ?, NULL, 'user', 'openai-codex', 'oauth-token',
          'waiting_for_user', ?, 'lease-2', ?, ?, ?)`
      )
      .run(
        'session-other',
        'other-user',
        'session-other',
        new Date(Date.now() + 60_000).toISOString(),
        now,
        now
      );
    const getState = vi.fn();
    const env = {
      DATABASE: createSqliteD1(sqlite),
      CREDENTIAL_SETUP_SESSION: {
        idFromName: vi.fn(() => ({ toString: () => 'do-session-other' })),
        get: vi.fn(() => ({ getState })),
      },
    } as unknown as Env;
    const app = new Hono<{ Bindings: Env }>();
    app.onError((error, c) => {
      const status = 'statusCode' in error ? Number(error.statusCode) : 500;
      return c.json({ error: 'not_found' }, status as 404 | 500);
    });
    app.route('/api/agent-credential-setup-sessions', agentCredentialSetupSessionsRoutes);

    const response = await app.request(
      '/api/agent-credential-setup-sessions/session-other',
      {},
      env
    );

    expect(response.status).toBe(404);
    expect(env.CREDENTIAL_SETUP_SESSION.idFromName).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
  });

  it('submits an owned Claude browser verification code through the DO boundary without persisting the secret in D1', async () => {
    const sqlite = setupDatabase();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO agent_credential_setup_sessions
         (id, user_id, project_id, scope, agent_type, credential_kind, status,
          sandbox_id, pool_lease_id, expires_at, created_at, updated_at)
         VALUES (?, ?, NULL, 'user', 'claude-code', 'oauth-token',
          'waiting_for_user', ?, 'lease-claude', ?, ?, ?)`
      )
      .run(
        'session-claude',
        'owner-user',
        'session-claude',
        new Date(Date.now() + 60_000).toISOString(),
        now,
        now
      );

    const code = 'abc123#state456';
    const token = `sk-ant-oat${'V'.repeat(48)}`;
    const sandbox = {
      exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockImplementation(async (path: string) => ({
        exists: path.endsWith('device-auth-state.json') || path.endsWith('claude-oauth-token.txt'),
      })),
      readFile: vi.fn().mockImplementation(async (path: string) => ({
        content: path.endsWith('device-auth-state.json')
          ? JSON.stringify({
              status: 'waiting_for_user',
              verificationUrl: 'https://claude.ai/oauth/device',
            })
          : `${token}\n`,
      })),
    };
    vi.mocked(getSandboxInstance).mockResolvedValue(sandbox as never);
    vi.mocked(saveAgentCredentialForUser).mockResolvedValue({
      created: true,
      createdAt: now,
      updatedAt: now,
    });
    const env = {
      DATABASE: createSqliteD1(sqlite),
      KV: { get: vi.fn().mockResolvedValue(null) },
    } as unknown as Env;
    const setupSession = new CredentialSetupSession(createDoContext() as never, env);
    await Promise.resolve();
    await setupSession.create({
      id: 'session-claude',
      userId: 'owner-user',
      projectId: null,
      scope: 'user',
      agentType: 'claude-code',
      credentialKind: 'oauth-token',
      provider: 'anthropic',
      agentName: 'Claude Code',
      poolLeaseId: 'lease-claude',
      setupHome: '/tmp/claude-route-vertical',
      ttlMs: 60_000,
      capturePollMs: 10,
    });
    await setupSession.alarm();
    await setupSession.alarm();
    Object.assign(env, {
      CREDENTIAL_SETUP_SESSION: {
        idFromName: vi.fn(() => ({ toString: () => 'do-session-claude' })),
        get: vi.fn(() => setupSession),
      },
    });
    const app = new Hono<{ Bindings: Env }>();
    app.onError((error, c) => {
      const status = 'statusCode' in error ? Number(error.statusCode) : 500;
      return c.json({ error: error.message }, status as 400 | 404 | 409 | 500);
    });
    app.route('/api/agent-credential-setup-sessions', agentCredentialSetupSessionsRoutes);

    const response = await app.request(
      '/api/agent-credential-setup-sessions/session-claude/verification-code',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: ` abc123 #state456\n` }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: 'session-claude',
      status: 'exchanging',
      agentType: 'claude-code',
    });
    expect(sandbox.writeFile).toHaveBeenCalledWith(
      '/tmp/claude-route-vertical/verification-code.txt',
      code
    );
    const persisted = sqlite
      .prepare('SELECT * FROM agent_credential_setup_sessions WHERE id = ?')
      .get('session-claude') as Record<string, unknown>;
    expect(JSON.stringify(persisted)).not.toContain(code);

    await setupSession.alarm();
    expect(saveAgentCredentialForUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner-user',
        agentType: 'claude-code',
        credential: token,
      })
    );
    const completedResponse = await app.request(
      '/api/agent-credential-setup-sessions/session-claude',
      {},
      env
    );
    expect(completedResponse.status).toBe(200);
    expect(await completedResponse.json()).toMatchObject({ status: 'completed' });
  });

  it('passes code shape validation to the DO boundary for authoritative validation', async () => {
    const sqlite = setupDatabase();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO agent_credential_setup_sessions
         (id, user_id, project_id, scope, agent_type, credential_kind, status,
          sandbox_id, pool_lease_id, expires_at, created_at, updated_at)
         VALUES (?, ?, NULL, 'user', 'claude-code', 'oauth-token',
          'waiting_for_user', ?, 'lease-claude', ?, ?, ?)`
      )
      .run(
        'session-bad-token',
        'owner-user',
        'session-bad-token',
        new Date(Date.now() + 60_000).toISOString(),
        now,
        now
      );

    const submitVerificationCode = vi.fn().mockResolvedValue({
      id: 'session-bad-token',
      status: 'exchanging',
      expiresAt: Date.now() + 60_000,
      errorCode: null,
      errorMessage: null,
      verificationUrl: 'https://claude.ai/oauth/device',
      userCode: null,
    });
    const env = {
      DATABASE: createSqliteD1(sqlite),
      CREDENTIAL_SETUP_SESSION: {
        idFromName: vi.fn(() => ({ toString: () => 'do-session-bad-token' })),
        get: vi.fn(() => ({ submitVerificationCode })),
      },
    } as unknown as Env;
    const app = new Hono<{ Bindings: Env }>();
    app.onError((error, c) => {
      const status = 'statusCode' in error ? Number(error.statusCode) : 500;
      return c.json({ error: error.message }, status as 400 | 404 | 409 | 500);
    });
    app.route('/api/agent-credential-setup-sessions', agentCredentialSetupSessionsRoutes);

    const response = await app.request(
      '/api/agent-credential-setup-sessions/session-bad-token/verification-code',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'invalid code!' }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(submitVerificationCode).toHaveBeenCalledWith('invalid code!');
  });
});
