import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it('falls back to the default agent type when the request body is invalid JSON', async () => {
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

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ agentType: 'openai-codex' });
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

  it('falls back to the default agent type for a wrong-type agentType (JSON object instead of string) — documented judgment call: parseOptionalBody treats a schema mismatch the same as an absent body', async () => {
    // NOTE: this is a deliberate, narrow divergence from the pre-migration behavior.
    // Before this migration, `body.agentType` (from an unsafe generic cast) would have
    // been passed as-is to `isValidAgentType`, which safely returns false for a
    // non-string value and produces the "Guided setup currently supports only ..."
    // 400 below. `parseOptionalBody` (the shared helper this route now uses, per its
    // own doc comment, for routes that tolerate a missing/invalid body) folds *any*
    // schema validation failure into the same fallback as a missing body, so a
    // wrong-type (but syntactically valid JSON) agentType now silently uses the
    // default instead of reaching that specific error message. Real clients only ever
    // send a string agentType, so this does not change any realistic caller's outcome.
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

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ agentType: 'openai-codex' });
  });
});
