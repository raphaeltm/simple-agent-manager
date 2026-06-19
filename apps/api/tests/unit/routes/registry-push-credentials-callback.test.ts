import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/middleware/error';

const WORKSPACES = { __table: 'workspaces', id: 'workspaces.id' };

let workspaceRows: Array<{ projectId: string | null; userId: string }> = [];
let deployEnabled = true;
let verifiedPayload: { workspace: string; type: string; scope?: string } = {
  workspace: 'ws-1',
  type: 'callback',
  scope: 'workspace',
};

const mintedCredential = {
  registry: 'registry.cloudflare.com',
  username: 'token',
  password: 'super-secret-do-not-log',
  namespace: 'acct-1/sam-proj-1',
  expiresAt: '2026-06-19T01:00:00.000Z',
};

const mintMock = vi.fn(async () => mintedCredential);

// Minimal in-memory KV stand-in so we can drive the rate-limit branch.
let kvStore: Map<string, string>;

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
}));

vi.mock('../../../src/db/schema', () => ({
  workspaces: WORKSPACES,
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(workspaceRows),
        }),
      }),
    })),
  }),
}));

vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn(async () => verifiedPayload),
}));

vi.mock('../../../src/services/deployment-control', () => ({
  isProjectAgentDeployEnabled: vi.fn(async () => deployEnabled),
}));

vi.mock('../../../src/services/registry-credentials', () => ({
  getRegistryCredentialRateLimit: () => ({ maxRequests: 2, windowSeconds: 300 }),
  mintProjectRegistryCredential: (...args: unknown[]) => mintMock(...(args as [])),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

function makeKv() {
  return {
    get: vi.fn(async (key: string) => kvStore.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      kvStore.set(key, value);
    }),
  };
}

async function buildApp() {
  const { registryPushCredentialsCallbackRoute } = await import(
    '../../../src/routes/projects/registry-push-credentials-callback'
  );
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 400);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: (err as Error).message }, 500);
  });
  app.route('/api/projects', registryPushCredentialsCallbackRoute);
  return app;
}

function request(app: Hono, projectId: string) {
  return app.request(
    `/api/projects/${projectId}/registry-push-credentials`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer cb-token' },
    },
    { DATABASE: {}, KV: makeKv() },
  );
}

describe('registry-push-credentials callback (vertical slice)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kvStore = new Map();
    workspaceRows = [{ projectId: 'proj-1', userId: 'user-1' }];
    deployEnabled = true;
    verifiedPayload = { workspace: 'ws-1', type: 'callback', scope: 'workspace' };
  });

  it('mints a project-scoped push credential and returns it verbatim to the agent', async () => {
    const app = await buildApp();
    const res = await request(app, 'proj-1');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(mintedCredential);

    // Minted for the resolved project + workspace user, with pull+push, no task context.
    expect(mintMock).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      'user-1',
      '',
      undefined,
      { permissions: ['pull', 'push'] },
    );
  });

  it('rejects when the workspace project does not match the route param', async () => {
    workspaceRows = [{ projectId: 'proj-OTHER', userId: 'user-1' }];
    const app = await buildApp();
    const res = await request(app, 'proj-1');

    expect(res.status).toBe(403);
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('rejects when the workspace is not linked to a project', async () => {
    workspaceRows = [{ projectId: null, userId: 'user-1' }];
    const app = await buildApp();
    const res = await request(app, 'proj-1');

    expect(res.status).toBe(403);
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('rejects when agent deployment is disabled for the project', async () => {
    deployEnabled = false;
    const app = await buildApp();
    const res = await request(app, 'proj-1');

    expect(res.status).toBe(403);
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('rejects a token whose scope is neither workspace nor node', async () => {
    verifiedPayload = { workspace: 'ws-1', type: 'callback', scope: 'ai-proxy' };
    const app = await buildApp();
    const res = await request(app, 'proj-1');

    expect(res.status).toBe(403);
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('rejects node-scoped tokens because the workspace claim is a node id', async () => {
    verifiedPayload = { workspace: 'node-1', type: 'callback', scope: 'node' };
    const app = await buildApp();
    const res = await request(app, 'proj-1');

    expect(res.status).toBe(403);
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('rate-limits per project once the window count reaches the max', async () => {
    const app = await buildApp();

    // maxRequests = 2: first two mint, third is rejected.
    expect((await request(app, 'proj-1')).status).toBe(200);
    expect((await request(app, 'proj-1')).status).toBe(200);

    const third = await request(app, 'proj-1');
    expect(third.status).toBe(429);
    expect(mintMock).toHaveBeenCalledTimes(2);
  });

  it('translates a mint failure into a 500 without leaking the internal error', async () => {
    mintMock.mockRejectedValueOnce(new Error('CF API 502: namespace lookup failed'));
    const app = await buildApp();
    const res = await request(app, 'proj-1');

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('CF API 502');
  });
});
