import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/middleware/error';

const mocks = vi.hoisted(() => ({
  updateSets: [] as Array<Record<string, unknown>>,
  jwt: {
    verifyCallbackToken: vi.fn(),
  },
  projectData: {
    failSession: vi.fn(),
    getAcpSession: vi.fn(),
    reportAcpSessionActivity: vi.fn(),
    transitionAcpSession: vi.fn(),
  },
  nodeAgent: {
    hibernateAgentSessionOnNode: vi.fn(),
  },
  container: {
    markVmAgentContainerActiveWorkEndedBestEffort: vi.fn(),
  },
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const env = {
  DATABASE: {},
} as never;

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    update: () => ({
      set: (values: Record<string, unknown>) => {
        mocks.updateSets.push(values);
        return { where: vi.fn().mockResolvedValue(undefined) };
      },
    }),
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({ get: vi.fn().mockResolvedValue(null) }),
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

vi.mock('../../../src/services/node-agent', () => ({
  hibernateAgentSessionOnNode: mocks.nodeAgent.hibernateAgentSessionOnNode,
}));

vi.mock('../../../src/services/project-data', () => mocks.projectData);

vi.mock('../../../src/services/vm-agent-container', () => mocks.container);

async function createTestApp(): Promise<Hono> {
  const { agentActivityCallbackRoute } =
    await import('../../../src/routes/projects/agent-activity-callback');
  const app = new Hono();
  app.route('/api/projects', agentActivityCallbackRoute);
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 409 | 500);
    }
    return c.json(
      { error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) },
      500
    );
  });
  return app;
}

function assignedAcpSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-session-1',
    chatSessionId: 'chat-session-1',
    workspaceId: 'workspace-1',
    nodeId: 'node-1',
    acpSdkSessionId: null,
    status: 'assigned',
    agentType: 'openai-codex',
    ...overrides,
  };
}

async function postActivity(app: Hono, body: Record<string, unknown>): Promise<Response> {
  return app.request(
    '/api/projects/project-1/acp-sessions/agent-session-1/activity',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer callback-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    env
  );
}

describe('agent activity callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateSets.length = 0;
    mocks.jwt.verifyCallbackToken.mockResolvedValue({
      workspace: 'workspace-1',
      type: 'callback',
      scope: 'workspace',
    });
    mocks.projectData.getAcpSession.mockResolvedValue(assignedAcpSession());
    mocks.projectData.reportAcpSessionActivity.mockResolvedValue(undefined);
    mocks.projectData.transitionAcpSession.mockResolvedValue({});
    mocks.projectData.failSession.mockResolvedValue(undefined);
    mocks.container.markVmAgentContainerActiveWorkEndedBestEffort.mockResolvedValue(undefined);
  });

  it('turns VM-agent error activity into durable failed control-plane state', async () => {
    const app = await createTestApp();

    const response = await postActivity(app, {
      activity: 'error',
      nodeId: 'node-1',
      agentType: 'openai-codex',
      restartCount: 0,
      statusError: 'ACP NewSession failed: context deadline exceeded',
    });

    expect(response.status).toBe(204);
    expect(mocks.projectData.reportAcpSessionActivity).toHaveBeenCalledWith(
      env,
      'project-1',
      'agent-session-1',
      'error',
      expect.objectContaining({
        agentType: 'openai-codex',
        restartCount: 0,
        statusError: 'ACP NewSession failed: context deadline exceeded',
      })
    );
    expect(mocks.updateSets).toContainEqual(
      expect.objectContaining({
        status: 'error',
        errorMessage: 'Agent failed: ACP NewSession failed: context deadline exceeded',
      })
    );
    expect(mocks.projectData.transitionAcpSession).toHaveBeenCalledWith(
      env,
      'project-1',
      'agent-session-1',
      'failed',
      expect.objectContaining({
        actorType: 'vm-agent',
        actorId: 'node-1',
        errorMessage: 'Agent failed: ACP NewSession failed: context deadline exceeded',
      })
    );
    expect(mocks.projectData.failSession).toHaveBeenCalledWith(
      env,
      'project-1',
      'chat-session-1',
      'Agent failed: ACP NewSession failed: context deadline exceeded'
    );
    expect(mocks.container.markVmAgentContainerActiveWorkEndedBestEffort).toHaveBeenCalledWith(
      env,
      'node-1',
      'agent_activity_error'
    );
  });

  it('does not re-fail terminal ACP sessions on duplicate late error activity', async () => {
    mocks.projectData.getAcpSession.mockResolvedValueOnce(
      assignedAcpSession({ status: 'completed', acpSdkSessionId: 'sdk-1' })
    );
    const app = await createTestApp();

    const response = await postActivity(app, {
      activity: 'error',
      nodeId: 'node-1',
      statusError: 'late duplicate error',
    });

    expect(response.status).toBe(204);
    expect(mocks.projectData.reportAcpSessionActivity).toHaveBeenCalled();
    expect(mocks.projectData.transitionAcpSession).not.toHaveBeenCalled();
    expect(mocks.projectData.failSession).not.toHaveBeenCalled();
    expect(mocks.updateSets).toHaveLength(0);
    expect(mocks.container.markVmAgentContainerActiveWorkEndedBestEffort).toHaveBeenCalledWith(
      env,
      'node-1',
      'agent_activity_error'
    );
  });
});
