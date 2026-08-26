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
  projectActiveWorkspaceRow: undefined as
    | {
        id: string;
        status: string;
      }
    | null
    | undefined,
  projectWorkspaceRow: { id: 'ws-1', status: 'running' } as {
    id: string;
    status: string;
  } | null,
  activeWorkspaceStatuses: new Set(['creating', 'running', 'recovery']),
  projectWorkspaceLookupCount: 0,
  workspaceRow: null as {
    nodeId: string | null;
    projectId: string | null;
    status: string;
  } | null,
  nodeRow: { status: 'running' } as { status: string } | null,
  jwt: { verifyCallbackToken: vi.fn() },
  projectData: { updateNodeHeartbeats: vi.fn() },
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const env = { DATABASE: {} } as never;

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: (columns: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          get: vi.fn().mockImplementation(() => {
            if (Object.hasOwn(columns, 'nodeId')) {
              return Promise.resolve(mocks.workspaceRow);
            }
            if (Object.hasOwn(columns, 'id')) {
              return Promise.resolve(mocks.projectWorkspaceRow);
            }
            if (Object.hasOwn(columns, 'status')) {
              return Promise.resolve(mocks.nodeRow);
            }
            return Promise.resolve(null);
          }),
          limit: vi.fn().mockReturnValue({
            get: vi.fn().mockImplementation(() => {
              if (Object.hasOwn(columns, 'id')) {
                const activeRow =
                  mocks.projectActiveWorkspaceRow !== undefined
                    ? mocks.projectActiveWorkspaceRow
                    : mocks.projectWorkspaceRow &&
                        mocks.activeWorkspaceStatuses.has(mocks.projectWorkspaceRow.status)
                      ? mocks.projectWorkspaceRow
                      : null;
                const row =
                  mocks.projectWorkspaceLookupCount === 0 ? activeRow : mocks.projectWorkspaceRow;
                mocks.projectWorkspaceLookupCount++;
                return Promise.resolve(row);
              }
              return Promise.resolve(null);
            }),
          }),
        }),
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
  const { nodeAcpHeartbeatRoute } = await import('../../../src/routes/projects/node-acp-heartbeat');
  const app = new Hono();
  app.route('/api/projects', nodeAcpHeartbeatRoute);
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 409 | 410 | 500);
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
    mocks.projectActiveWorkspaceRow = undefined;
    mocks.projectWorkspaceRow = { id: 'ws-1', status: 'running' };
    mocks.projectWorkspaceLookupCount = 0;
    mocks.workspaceRow = null;
    mocks.nodeRow = { status: 'running' };
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
    mocks.workspaceRow = { nodeId: 'node-1', projectId: 'project-1', status: 'running' }; // ws-1 lives on node-1 in project-1
    const app = await createTestApp();

    const response = await postHeartbeat(app, 'node-1');

    expect(response.status).toBe(204);
    expect(mocks.projectData.updateNodeHeartbeats).toHaveBeenCalledWith(env, 'project-1', 'node-1');
  });

  it('accepts a legacy unscoped workspace token whose workspace is assigned to the reported node', async () => {
    mocks.jwt.verifyCallbackToken.mockResolvedValue({
      workspace: 'ws-1',
      type: 'callback',
    });
    mocks.workspaceRow = { nodeId: 'node-1', projectId: 'project-1', status: 'running' };
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
    mocks.workspaceRow = { nodeId: 'node-999', projectId: 'project-1', status: 'running' };
    const app = await createTestApp();

    const response = await postHeartbeat(app, 'node-1');

    expect(response.status).toBe(403);
    expect(mocks.projectData.updateNodeHeartbeats).not.toHaveBeenCalled();
  });

  it('rejects a workspace-scoped token whose workspace belongs to a different project', async () => {
    mocks.jwt.verifyCallbackToken.mockResolvedValue({
      workspace: 'ws-1',
      type: 'callback',
      scope: 'workspace',
    });
    mocks.workspaceRow = { nodeId: 'node-1', projectId: 'project-other', status: 'running' };
    const app = await createTestApp();

    const response = await postHeartbeat(app, 'node-1');

    expect(response.status).toBe(403);
    expect(mocks.projectData.updateNodeHeartbeats).not.toHaveBeenCalled();
  });

  it('returns terminal gone for a workspace-scoped token whose workspace does not exist', async () => {
    mocks.jwt.verifyCallbackToken.mockResolvedValue({
      workspace: 'ws-missing',
      type: 'callback',
      scope: 'workspace',
    });
    mocks.workspaceRow = null;
    const app = await createTestApp();

    const response = await postHeartbeat(app, 'node-1');

    expect(response.status).toBe(410);
    expect(mocks.projectData.updateNodeHeartbeats).not.toHaveBeenCalled();
  });

  it('rejects a node-scoped token whose node is not bound to the route project', async () => {
    mocks.jwt.verifyCallbackToken.mockResolvedValue({
      workspace: 'node-1',
      type: 'callback',
      scope: 'node',
    });
    mocks.projectActiveWorkspaceRow = null;
    mocks.projectWorkspaceRow = null;
    const app = await createTestApp();

    const response = await postHeartbeat(app, 'node-1');

    expect(response.status).toBe(403);
    expect(mocks.projectData.updateNodeHeartbeats).not.toHaveBeenCalled();
  });

  it('accepts a node-scoped token when the same node and project have mixed active and inactive workspaces', async () => {
    mocks.jwt.verifyCallbackToken.mockResolvedValue({
      workspace: 'node-1',
      type: 'callback',
      scope: 'node',
    });
    mocks.projectActiveWorkspaceRow = { id: 'ws-running', status: 'running' };
    mocks.projectWorkspaceRow = { id: 'ws-stopped', status: 'stopped' };
    const app = await createTestApp();

    const response = await postHeartbeat(app, 'node-1');

    expect(response.status).toBe(204);
    expect(mocks.projectData.updateNodeHeartbeats).toHaveBeenCalledWith(env, 'project-1', 'node-1');
  });

  it('returns terminal gone for a node-scoped token bound only to a stopped project workspace', async () => {
    mocks.jwt.verifyCallbackToken.mockResolvedValue({
      workspace: 'node-1',
      type: 'callback',
      scope: 'node',
    });
    mocks.projectWorkspaceRow = { id: 'ws-stopped', status: 'stopped' };
    const app = await createTestApp();

    const response = await postHeartbeat(app, 'node-1');

    expect(response.status).toBe(410);
    expect(mocks.projectData.updateNodeHeartbeats).not.toHaveBeenCalled();
  });

  it('returns terminal gone for a node-scoped token bound to a deleted node', async () => {
    mocks.jwt.verifyCallbackToken.mockResolvedValue({
      workspace: 'node-1',
      type: 'callback',
      scope: 'node',
    });
    mocks.nodeRow = { status: 'deleted' };
    const app = await createTestApp();

    const response = await postHeartbeat(app, 'node-1');

    expect(response.status).toBe(410);
    expect(mocks.projectData.updateNodeHeartbeats).not.toHaveBeenCalled();
  });

  it('returns terminal gone for a workspace-scoped token assigned to a deleted node', async () => {
    mocks.jwt.verifyCallbackToken.mockResolvedValue({
      workspace: 'ws-1',
      type: 'callback',
      scope: 'workspace',
    });
    mocks.workspaceRow = { nodeId: 'node-1', projectId: 'project-1', status: 'running' };
    mocks.nodeRow = { status: 'deleted' };
    const app = await createTestApp();

    const response = await postHeartbeat(app, 'node-1');

    expect(response.status).toBe(410);
    expect(mocks.projectData.updateNodeHeartbeats).not.toHaveBeenCalled();
  });
});
