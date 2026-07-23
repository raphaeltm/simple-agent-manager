import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/middleware/error';

/**
 * Callback-token binding for the node-level ACP heartbeat (security-critique #1, rule 28).
 * A node-scoped token must equal body.nodeId (pure). A workspace-scoped token is accepted only if
 * that workspace is actually assigned to body.nodeId (indexed lookup). The client-supplied
 * body.nodeId is NEVER trusted on its own — the forgery tests below are discriminating: on pre-fix
 * code (which did no cross-check at all) the attacker's guessed nodeId is accepted.
 */
const mocks = vi.hoisted(() => ({
  workspaceRow: null as { nodeId: string | null } | null,
  jwt: { verifyCallbackToken: vi.fn() },
  projectData: { updateNodeHeartbeats: vi.fn() },
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const env = { DATABASE: {} } as never;

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ get: vi.fn().mockResolvedValue(mocks.workspaceRow) }),
      }),
    }),
  }),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: mocks.log,
  createModuleLogger: () => mocks.log,
}));

vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: mocks.jwt.verifyCallbackToken,
}));

vi.mock('../../../src/services/project-data', () => mocks.projectData);

async function createTestApp(): Promise<Hono> {
  const { nodeAcpHeartbeatRoute } = await import(
    '../../../src/routes/projects/node-acp-heartbeat'
  );
  const app = new Hono();
  app.route('/api/projects', nodeAcpHeartbeatRoute);
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 409 | 500);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: String(err) }, 500);
  });
  return app;
}

function postHeartbeat(app: Hono, nodeId: string): Promise<Response> {
  return app.request(
    '/api/projects/project-1/node-acp-heartbeat',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId }),
    },
    env
  );
}

describe('node ACP heartbeat callback-token binding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workspaceRow = null;
    mocks.projectData.updateNodeHeartbeats.mockResolvedValue(1);
  });

  it('accepts a node-scoped token bound to the reported node', async () => {
    mocks.jwt.verifyCallbackToken.mockResolvedValue({
      workspace: 'node-1',
      type: 'callback',
      scope: 'node',
    });
    const app = await createTestApp();

    const response = await postHeartbeat(app, 'node-1');

    expect(response.status).toBe(204);
    expect(mocks.projectData.updateNodeHeartbeats).toHaveBeenCalledWith(env, 'project-1', 'node-1');
  });

  it('rejects a node-scoped token reporting a DIFFERENT node (forgery)', async () => {
    // Attacker holds a valid node token for their own node-999 and guesses the victim's node-1.
    mocks.jwt.verifyCallbackToken.mockResolvedValue({
      workspace: 'node-999',
      type: 'callback',
      scope: 'node',
    });
    const app = await createTestApp();

    const response = await postHeartbeat(app, 'node-1');

    expect(response.status).toBe(403);
    expect(mocks.projectData.updateNodeHeartbeats).not.toHaveBeenCalled();
  });

  it('accepts a workspace-scoped token whose workspace is assigned to the reported node', async () => {
    mocks.jwt.verifyCallbackToken.mockResolvedValue({
      workspace: 'ws-1',
      type: 'callback',
      scope: 'workspace',
    });
    mocks.workspaceRow = { nodeId: 'node-1' }; // ws-1 lives on node-1
    const app = await createTestApp();

    const response = await postHeartbeat(app, 'node-1');

    expect(response.status).toBe(204);
    expect(mocks.projectData.updateNodeHeartbeats).toHaveBeenCalledWith(env, 'project-1', 'node-1');
  });

  it('rejects a workspace-scoped token whose workspace lives on a DIFFERENT node (forgery)', async () => {
    // Attacker's workspace ws-1 is on their own node-999; they report the victim's node-1.
    mocks.jwt.verifyCallbackToken.mockResolvedValue({
      workspace: 'ws-1',
      type: 'callback',
      scope: 'workspace',
    });
    mocks.workspaceRow = { nodeId: 'node-999' };
    const app = await createTestApp();

    const response = await postHeartbeat(app, 'node-1');

    expect(response.status).toBe(403);
    expect(mocks.projectData.updateNodeHeartbeats).not.toHaveBeenCalled();
  });

  it('rejects a workspace-scoped token whose workspace does not exist (fails closed)', async () => {
    mocks.jwt.verifyCallbackToken.mockResolvedValue({
      workspace: 'ws-missing',
      type: 'callback',
      scope: 'workspace',
    });
    mocks.workspaceRow = null;
    const app = await createTestApp();

    const response = await postHeartbeat(app, 'node-1');

    expect(response.status).toBe(403);
    expect(mocks.projectData.updateNodeHeartbeats).not.toHaveBeenCalled();
  });
});
