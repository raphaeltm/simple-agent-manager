import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const h = vi.hoisted(() => ({
  leaseSetupSlot: vi.fn(),
  releaseSetupSlot: vi.fn(),
  startSetupSession: vi.fn(),
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
});
