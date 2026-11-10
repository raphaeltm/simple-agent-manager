/**
 * CONTAINER_RUNTIME_AVAILABLE gates: guided credential setup and the Instant (cf-container)
 * runtime. The container Durable Object bindings exist on every runtime; whether a container
 * runtime is behind them is declared by CONTAINER_RUNTIME_AVAILABLE ("false" = absent, unset =
 * present, so Cloudflare deployments are unchanged).
 *
 * Guided setup is exercised through the real route module; only the Durable Object-backed
 * session services (slot lease, session start) are boundary mocks, as in the existing route tests.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { getSandboxConfig } from '../../../src/services/sandbox';
import {
  getVmAgentContainerConfig,
  isInstantRuntimeAvailable,
} from '../../../src/services/vm-agent-container';
import { resolveWorkspaceRuntime } from '../../../src/services/workspace-runtime';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const h = vi.hoisted(() => ({
  leaseSetupSlot: vi.fn(),
  releaseSetupSlot: vi.fn(),
  startSetupSession: vi.fn(),
  getSetupSessionState: vi.fn(),
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  getUserId: () => 'owner-user',
}));

vi.mock('../../../src/services/setup-session-pool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/setup-session-pool')>()),
  leaseSetupSlot: h.leaseSetupSlot,
  releaseSetupSlot: h.releaseSetupSlot,
}));

vi.mock('../../../src/services/credential-setup-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/credential-setup-session')>()),
  startSetupSession: h.startSetupSession,
  getSetupSessionState: h.getSetupSessionState,
}));

const { agentCredentialSetupSessionsRoutes } = await import(
  '../../../src/routes/agent-credential-setup-sessions'
);

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

function app() {
  const testApp = new Hono<{ Bindings: Env }>();
  testApp.onError(handleAppError);
  testApp.route('/api/agent-credential-setup-sessions', agentCredentialSetupSessionsRoutes);
  return testApp;
}

/** Every binding guided setup needs; the container runtime itself is what varies. */
function setupEnv(overrides: Record<string, unknown> = {}) {
  const sqlite = setupDatabase();
  const env = {
    DATABASE: createSqliteD1(sqlite),
    SANDBOX: {},
    CREDENTIAL_SETUP_SESSION: {},
    SETUP_SESSION_POOL: {},
    ...overrides,
  } as unknown as Env;
  return { sqlite, env };
}

const createRequest = {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agentType: 'claude-code' }),
};

beforeEach(() => {
  vi.clearAllMocks();
  h.leaseSetupSlot.mockResolvedValue({ granted: true, leaseId: 'lease-1' });
  h.startSetupSession.mockImplementation(async (_env: Env, params: { id: string }) => ({
    id: params.id,
    status: 'provisioning',
    expiresAt: Date.now() + 900_000,
    errorCode: null,
    errorMessage: null,
    verificationUrl: null,
    userCode: null,
  }));
});

describe('guided credential setup', () => {
  it('GET /config is enabled with the bindings present and CONTAINER_RUNTIME_AVAILABLE unset (Cloudflare behaviour)', async () => {
    const { env } = setupEnv();

    const res = await app().request('/api/agent-credential-setup-sessions/config', {}, env);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: true });
  });

  it('GET /config is disabled with the bindings present and CONTAINER_RUNTIME_AVAILABLE=false', async () => {
    const { env } = setupEnv({ CONTAINER_RUNTIME_AVAILABLE: 'false' });

    const res = await app().request('/api/agent-credential-setup-sessions/config', {}, env);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      enabled: false,
      agentTypes: ['openai-codex', 'claude-code'],
      scopes: ['user', 'project'],
    });
  });

  it('GET /config stays enabled for any other CONTAINER_RUNTIME_AVAILABLE value (only "false" opts out)', async () => {
    const { env } = setupEnv({ CONTAINER_RUNTIME_AVAILABLE: 'true' });

    const res = await app().request('/api/agent-credential-setup-sessions/config', {}, env);

    expect(await res.json()).toMatchObject({ enabled: true });
  });

  it('POST / creates a session with the bindings present and the runtime unset (Cloudflare behaviour)', async () => {
    const { sqlite, env } = setupEnv();

    const res = await app().request('/api/agent-credential-setup-sessions', createRequest, env);

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: 'provisioning', agentType: 'claude-code' });
    expect(h.leaseSetupSlot).toHaveBeenCalledTimes(1);
    expect(h.startSetupSession).toHaveBeenCalledTimes(1);
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS n FROM agent_credential_setup_sessions').get() as { n: number }).n
    ).toBe(1);
  });

  it.each([
    ['POST /', '/api/agent-credential-setup-sessions'],
    ['POST /project', '/api/agent-credential-setup-sessions/project'],
  ])('%s answers 404 when CONTAINER_RUNTIME_AVAILABLE=false and starts nothing', async (_label, path) => {
    const { sqlite, env } = setupEnv({ CONTAINER_RUNTIME_AVAILABLE: 'false' });

    const res = await app().request(path, createRequest, env);

    expect(res.status).toBe(404);
    expect(h.leaseSetupSlot).not.toHaveBeenCalled();
    expect(h.startSetupSession).not.toHaveBeenCalled();
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS n FROM agent_credential_setup_sessions').get() as { n: number }).n
    ).toBe(0);
  });
});

describe('isInstantRuntimeAvailable', () => {
  const instant = (overrides: Record<string, unknown> = {}) =>
    ({
      CF_CONTAINER_ENABLED: 'true',
      VM_AGENT_CONTAINER: {},
      ...overrides,
    }) as unknown as Env;

  it('is true with the flag and binding present and CONTAINER_RUNTIME_AVAILABLE unset (Cloudflare behaviour)', () => {
    expect(isInstantRuntimeAvailable(instant())).toBe(true);
  });

  it('is false with the flag and binding present and CONTAINER_RUNTIME_AVAILABLE=false', () => {
    expect(isInstantRuntimeAvailable(instant({ CONTAINER_RUNTIME_AVAILABLE: 'false' }))).toBe(false);
  });

  it('keeps its existing conditions: flag off or binding missing is still false', () => {
    expect(isInstantRuntimeAvailable(instant({ CF_CONTAINER_ENABLED: 'false' }))).toBe(false);
    expect(isInstantRuntimeAvailable(instant({ VM_AGENT_CONTAINER: undefined }))).toBe(false);
  });
});

describe('container runtime declaration gates the start paths, not only the advertisement', () => {
  const on = { CF_CONTAINER_ENABLED: 'true', SANDBOX_ENABLED: 'true' };

  it('an explicit cf-container request falls back to VM when no container runtime exists', async () => {
    const decision = await resolveWorkspaceRuntime(
      {} as never,
      { ...on, CONTAINER_RUNTIME_AVAILABLE: 'false' } as Env,
      { userId: 'u1', explicitRuntime: 'cf-container' }
    );
    expect(decision).toEqual({ runtime: 'vm', reason: 'sandbox-disabled' });
  });

  it('keeps the Cloudflare decision when the declaration is unset', async () => {
    // A query builder that answers every chain with "no rows" (no credentials stored).
    const noRows: unknown = new Proxy(() => noRows, {
      get: (_target, property) =>
        property === 'then' ? (resolve: (rows: unknown[]) => void) => resolve([]) : noRows,
      apply: () => noRows,
    });
    const decision = await resolveWorkspaceRuntime(noRows as never, on as Env, {
      userId: 'u1',
      explicitRuntime: 'cf-container',
    });
    expect(decision.runtime).toBe('cf-container');
  });

  it('turns the container config and the legacy sandbox off, and only when declared absent', () => {
    expect(getVmAgentContainerConfig({ ...on, CONTAINER_RUNTIME_AVAILABLE: 'false' } as Env).enabled).toBe(false);
    expect(getVmAgentContainerConfig(on as Env).enabled).toBe(true);
    expect(getSandboxConfig({ ...on, CONTAINER_RUNTIME_AVAILABLE: 'false' } as Env).enabled).toBe(false);
    expect(getSandboxConfig(on as Env).enabled).toBe(true);
  });
});

