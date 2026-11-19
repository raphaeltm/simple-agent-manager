import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const h = vi.hoisted(() => ({
  leaseSetupSlot: vi.fn(),
  releaseSetupSlot: vi.fn(),
  startSetupSession: vi.fn(),
  requireProjectCapability: vi.fn(),
  getSetupSessionState: vi.fn(),
}));

vi.mock('../../../src/middleware/project-auth', async (importOriginal) => ({
  OWN_AGENT_ACCOUNT_PROJECT_CAPABILITY: (
    await importOriginal<typeof import('../../../src/middleware/project-auth')>()
  ).OWN_AGENT_ACCOUNT_PROJECT_CAPABILITY,
  requireProjectCapability: h.requireProjectCapability,
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  getUserId: () => 'owner-user',
}));

vi.mock('../../../src/services/setup-session-pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/setup-session-pool')>();
  return {
    ...actual,
    leaseSetupSlot: h.leaseSetupSlot,
    releaseSetupSlot: h.releaseSetupSlot,
  };
});

vi.mock('../../../src/services/credential-setup-session', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/credential-setup-session')>();
  return {
    ...actual,
    startSetupSession: h.startSetupSession,
    getSetupSessionState: h.getSetupSessionState,
  };
});

const { agentCredentialSetupSessionsRoutes } =
  await import('../../../src/routes/agent-credential-setup-sessions');

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
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    )`
  );
  return sqlite;
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) => {
    const status = 'statusCode' in error ? Number(error.statusCode) : 500;
    return c.json({ error: error.message }, status as 400 | 404 | 409 | 500);
  });
  app.route('/api/agent-credential-setup-sessions', agentCredentialSetupSessionsRoutes);
  return app;
}

describe('guided setup route creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([true, false])(
    'advertises project setup capability independently of binding availability (%s)',
    async (enabled) => {
      const env = {
        DATABASE: createSqliteD1(setupDatabase()),
        ...(enabled ? { SANDBOX: {}, CREDENTIAL_SETUP_SESSION: {}, SETUP_SESSION_POOL: {} } : {}),
      } as unknown as Env;
      const response = await createApp().request(
        '/api/agent-credential-setup-sessions/config',
        {},
        env
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        enabled,
        agentTypes: ['openai-codex', 'claude-code'],
        scopes: ['user', 'project'],
      });
      expect(h.leaseSetupSlot).not.toHaveBeenCalled();
    }
  );

  it('creates a Claude Code setup session with Claude-specific setup home metadata', async () => {
    const sqlite = setupDatabase();
    h.leaseSetupSlot.mockResolvedValue({ granted: true, leaseId: 'lease-claude' });
    h.startSetupSession.mockImplementation(async (_env: Env, params: { id: string }) => ({
      id: params.id,
      status: 'provisioning',
      expiresAt: Date.now() + 900_000,
      errorCode: null,
      errorMessage: null,
      verificationUrl: null,
      userCode: null,
    }));

    const env = {
      DATABASE: createSqliteD1(sqlite),
      SANDBOX: {},
      CREDENTIAL_SETUP_SESSION: {},
      SETUP_SESSION_POOL: {},
    } as unknown as Env;

    const response = await createApp().request(
      '/api/agent-credential-setup-sessions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentType: 'claude-code' }),
      },
      env
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      status: 'provisioning',
      agentType: 'claude-code',
    });
    expect(h.startSetupSession).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        agentType: 'claude-code',
        credentialKind: 'oauth-token',
        provider: 'anthropic',
        agentName: 'Claude Code',
        setupHome: expect.stringContaining('/root/.claude-setup-'),
      })
    );
    const persisted = sqlite
      .prepare('SELECT agent_type, credential_kind, status FROM agent_credential_setup_sessions')
      .get() as Record<string, unknown>;
    expect(persisted).toEqual({
      agent_type: 'claude-code',
      credential_kind: 'oauth-token',
      status: 'provisioning',
    });
  });

  it('falls back to the default agent type when no request body is sent at all (jsonValidator migration must preserve the pre-existing tolerant-empty-body behavior)', async () => {
    const sqlite = setupDatabase();
    h.leaseSetupSlot.mockResolvedValue({ granted: true, leaseId: 'lease-default' });
    h.startSetupSession.mockImplementation(async (_env: Env, params: { id: string }) => ({
      id: params.id,
      status: 'provisioning',
      expiresAt: Date.now() + 900_000,
      errorCode: null,
      errorMessage: null,
      verificationUrl: null,
      userCode: null,
    }));

    const env = {
      DATABASE: createSqliteD1(sqlite),
      SANDBOX: {},
      CREDENTIAL_SETUP_SESSION: {},
      SETUP_SESSION_POOL: {},
    } as unknown as Env;

    const response = await createApp().request(
      '/api/agent-credential-setup-sessions',
      { method: 'POST' },
      env
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      status: 'provisioning',
      agentType: 'openai-codex',
    });
  });

  it('rejects malformed JSON without starting a personal setup', async () => {
    const sqlite = setupDatabase();
    h.leaseSetupSlot.mockResolvedValue({ granted: true, leaseId: 'lease-malformed' });
    h.startSetupSession.mockImplementation(async (_env: Env, params: { id: string }) => ({
      id: params.id,
      status: 'provisioning',
      expiresAt: Date.now() + 900_000,
      errorCode: null,
      errorMessage: null,
      verificationUrl: null,
      userCode: null,
    }));

    const env = {
      DATABASE: createSqliteD1(sqlite),
      SANDBOX: {},
      CREDENTIAL_SETUP_SESSION: {},
      SETUP_SESSION_POOL: {},
    } as unknown as Env;

    const response = await createApp().request(
      '/api/agent-credential-setup-sessions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json{',
      },
      env
    );

    expect(response.status).toBe(400);
    expect(h.leaseSetupSlot).not.toHaveBeenCalled();
  });

  it('rejects an unsupported agentType with the existing badRequest message (not the generic 400 shape)', async () => {
    const sqlite = setupDatabase();

    const env = {
      DATABASE: createSqliteD1(sqlite),
      SANDBOX: {},
      CREDENTIAL_SETUP_SESSION: {},
      SETUP_SESSION_POOL: {},
    } as unknown as Env;

    const response = await createApp().request(
      '/api/agent-credential-setup-sessions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentType: 'unsupported-agent' }),
      },
      env
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Guided setup currently supports only');
    expect(h.leaseSetupSlot).not.toHaveBeenCalled();
  });

  it('rejects wrongly typed fields without starting personal setup', async () => {
    const sqlite = setupDatabase();
    h.leaseSetupSlot.mockResolvedValue({ granted: true, leaseId: 'lease-wrong-type' });
    h.startSetupSession.mockImplementation(async (_env: Env, params: { id: string }) => ({
      id: params.id,
      status: 'provisioning',
      expiresAt: Date.now() + 900_000,
      errorCode: null,
      errorMessage: null,
      verificationUrl: null,
      userCode: null,
    }));

    const env = {
      DATABASE: createSqliteD1(sqlite),
      SANDBOX: {},
      CREDENTIAL_SETUP_SESSION: {},
      SETUP_SESSION_POOL: {},
    } as unknown as Env;

    const response = await createApp().request(
      '/api/agent-credential-setup-sessions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentType: { nested: true } }),
      },
      env
    );

    expect(response.status).toBe(400);
    expect(h.leaseSetupSlot).not.toHaveBeenCalled();
  });
  it.each(['claude-code', 'openai-codex'])(
    'persists project scope for %s after authorization',
    async (agentType) => {
      const sqlite = setupDatabase();
      const env = {
        DATABASE: createSqliteD1(sqlite),
        SANDBOX: {},
        CREDENTIAL_SETUP_SESSION: {},
        SETUP_SESSION_POOL: {},
      } as unknown as Env;
      h.leaseSetupSlot.mockResolvedValue({ granted: true, leaseId: 'lease' });
      h.startSetupSession.mockImplementation(async (_env, params) => ({
        ...params,
        status: 'provisioning',
      }));
      const response = await createApp().request(
        '/api/agent-credential-setup-sessions/project',
        {
          method: 'POST',
          body: JSON.stringify({ agentType, projectId: 'project-a' }),
        },
        env
      );
      expect(response.status).toBe(201);
      expect(h.requireProjectCapability).toHaveBeenCalledWith(
        expect.anything(),
        'project-a',
        'owner-user',
        'task:write'
      );
      expect(
        sqlite.prepare('SELECT project_id, scope FROM agent_credential_setup_sessions').get()
      ).toEqual({ project_id: 'project-a', scope: 'project' });
      expect(h.startSetupSession).toHaveBeenCalledWith(
        env,
        expect.objectContaining({ projectId: 'project-a', scope: 'project' })
      );
    }
  );

  it.each([null, '', 12, {}])('rejects invalid projectId %s', async (projectId) => {
    const env = {
      DATABASE: createSqliteD1(setupDatabase()),
      SANDBOX: {},
      CREDENTIAL_SETUP_SESSION: {},
      SETUP_SESSION_POOL: {},
    } as unknown as Env;
    const response = await createApp().request(
      '/api/agent-credential-setup-sessions/project',
      { method: 'POST', body: JSON.stringify({ projectId }) },
      env
    );
    expect(response.status).toBe(400);
    expect(h.leaseSetupSlot).not.toHaveBeenCalled();
  });

  it('rejects unauthorized projects before leasing a container', async () => {
    const { errors } = await import('../../../src/middleware/error');
    h.requireProjectCapability.mockRejectedValueOnce(
      errors.forbidden('Project capability is required')
    );
    const env = {
      DATABASE: createSqliteD1(setupDatabase()),
      SANDBOX: {},
      CREDENTIAL_SETUP_SESSION: {},
      SETUP_SESSION_POOL: {},
    } as unknown as Env;
    const response = await createApp().request(
      '/api/agent-credential-setup-sessions/project',
      { method: 'POST', body: JSON.stringify({ projectId: 'project-a' }) },
      env
    );
    expect(response.status).toBe(403);
    expect(h.leaseSetupSlot).not.toHaveBeenCalled();
  });

  it.each(['project-b', null])(
    'does not reuse an active session from another scope (%s)',
    async (existingProjectId) => {
      const sqlite = setupDatabase();
      sqlite
        .prepare(
          `INSERT INTO agent_credential_setup_sessions (id,user_id,project_id,scope,agent_type,credential_kind,status,sandbox_id,expires_at,created_at,updated_at) VALUES ('existing','owner-user',?,'user','claude-code','oauth-token','provisioning','sandbox','later','now','now')`
        )
        .run(existingProjectId);
      const env = {
        DATABASE: createSqliteD1(sqlite),
        SANDBOX: {},
        CREDENTIAL_SETUP_SESSION: {},
        SETUP_SESSION_POOL: {},
      } as unknown as Env;
      const response = await createApp().request(
        '/api/agent-credential-setup-sessions/project',
        {
          method: 'POST',
          body: JSON.stringify({ projectId: 'project-a', agentType: 'claude-code' }),
        },
        env
      );
      expect(response.status).toBe(409);
      expect(h.leaseSetupSlot).not.toHaveBeenCalled();
      expect(h.getSetupSessionState).not.toHaveBeenCalled();
    }
  );
  it.each(['project-a', null])(
    'reuses the active session in the same scope (%s)',
    async (projectId) => {
      const sqlite = setupDatabase();
      sqlite
        .prepare(
          `INSERT INTO agent_credential_setup_sessions (id,user_id,project_id,scope,agent_type,credential_kind,status,sandbox_id,expires_at,created_at,updated_at) VALUES ('existing','owner-user',?,'user','claude-code','oauth-token','provisioning','sandbox','later','now','now')`
        )
        .run(projectId);
      h.getSetupSessionState.mockResolvedValue({ status: 'waiting_for_user' });
      const env = {
        DATABASE: createSqliteD1(sqlite),
        SANDBOX: {},
        CREDENTIAL_SETUP_SESSION: {},
        SETUP_SESSION_POOL: {},
      } as unknown as Env;
      const response = await createApp().request(
        `/api/agent-credential-setup-sessions${projectId ? '/project' : ''}`,
        {
          method: 'POST',
          body: JSON.stringify({ ...(projectId ? { projectId } : {}), agentType: 'claude-code' }),
        },
        env
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: 'existing', status: 'waiting_for_user' });
      expect(h.leaseSetupSlot).not.toHaveBeenCalled();
    }
  );
  it.each([
    { path: '/project', body: {} },
    { path: '', body: { projectId: 'project-a' } },
  ])('rejects mismatched scope at $path', async ({ path, body }) => {
    const env = {
      DATABASE: createSqliteD1(setupDatabase()),
      SANDBOX: {},
      CREDENTIAL_SETUP_SESSION: {},
      SETUP_SESSION_POOL: {},
    } as unknown as Env;
    const response = await createApp().request(
      `/api/agent-credential-setup-sessions${path}`,
      { method: 'POST', body: JSON.stringify(body) },
      env
    );
    expect(response.status).toBe(400);
    expect(h.leaseSetupSlot).not.toHaveBeenCalled();
    expect(h.startSetupSession).not.toHaveBeenCalled();
  });
});
