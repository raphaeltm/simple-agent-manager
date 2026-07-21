import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/middleware/error';

const mocks = vi.hoisted(() => ({
  updateSets: [] as Array<Record<string, unknown>>,
  workspace: null as Record<string, unknown> | null,
  // Row returned to the S2 staleness guard's combined agent_sessions⋈nodes read
  // ({ updatedAt, runtime }). Default is non-Instant so existing error tests
  // still process (the guard only engages for cf-container runtimes).
  guardRow: { updatedAt: null as string | null, runtime: 'vm' as string | null },
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
    // Supports both the idle-branch workspace⋈nodes read (selection includes
    // `id`) and the S2 guard's agent_sessions⋈workspaces⋈nodes read (selection
    // includes `updatedAt`). Any number of leftJoins chain into the same `where`.
    select: (selection?: Record<string, unknown>) => {
      const rowFor = () =>
        selection && 'updatedAt' in selection ? mocks.guardRow : mocks.workspace;
      const terminal = { get: () => Promise.resolve(rowFor()) };
      const joinable: { leftJoin: () => typeof joinable; where: () => typeof terminal } = {
        leftJoin: () => joinable,
        where: () => terminal,
      };
      return { from: () => joinable };
    },
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

/**
 * Build an (unsigned) JWT whose payload carries `iat`. `verifyCallbackToken` is
 * mocked, so the signature is irrelevant — the S2 guard only needs `decodeJwt`
 * to read `iat` from an already-verified token.
 */
function tokenWithIatSeconds(iatSeconds: number): string {
  const seg = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${seg({ alg: 'RS256', typ: 'JWT' })}.${seg({ iat: iatSeconds, workspace: 'workspace-1' })}.sig`;
}

async function postActivity(
  app: Hono,
  body: Record<string, unknown>,
  token = 'callback-token'
): Promise<Response> {
  return app.request(
    '/api/projects/project-1/acp-sessions/agent-session-1/activity',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
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
    mocks.workspace = null;
    mocks.guardRow = { updatedAt: null, runtime: 'vm' };
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

  it('snapshots an idle Instant session with the exact agent type before handback', async () => {
    mocks.projectData.getAcpSession.mockResolvedValueOnce(
      assignedAcpSession({ status: 'active', acpSdkSessionId: 'sdk-session-1' })
    );
    mocks.workspace = {
      id: 'workspace-1',
      userId: 'user-1',
      chatSessionId: 'chat-session-1',
      runtime: 'cf-container',
    };
    mocks.nodeAgent.hibernateAgentSessionOnNode.mockResolvedValueOnce({ status: 'available' });
    const app = await createTestApp();

    const response = await postActivity(app, {
      activity: 'idle',
      nodeId: 'node-1',
      agentType: 'openai-codex',
    });

    expect(response.status).toBe(204);
    expect(mocks.nodeAgent.hibernateAgentSessionOnNode).toHaveBeenCalledWith(
      'node-1',
      'workspace-1',
      'sdk-session-1',
      env,
      'user-1',
      {
        chatSessionId: 'chat-session-1',
        runtime: 'cf-container',
        agentType: 'openai-codex',
      }
    );
    expect(mocks.container.markVmAgentContainerActiveWorkEndedBestEffort).toHaveBeenCalledWith(
      env,
      'node-1',
      'agent_activity_idle'
    );
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

  // --- S2: stale superseded-generation callback guard (Instant recovery race) ---
  describe('stale Instant callback guard', () => {
    const TOKEN_IAT_SECONDS = 1_700_000_000;
    const TOKEN_IAT_MS = TOKEN_IAT_SECONDS * 1000;
    const OLD_TOKEN = tokenWithIatSeconds(TOKEN_IAT_SECONDS);

    beforeEach(() => {
      // The session the DO recovered is healthy + running (canTransition→failed),
      // so WITHOUT the guard a late error WOULD regress it.
      mocks.projectData.getAcpSession.mockResolvedValue(
        assignedAcpSession({ status: 'running', acpSdkSessionId: 'sdk-1' })
      );
    });

    it('(a) rejects a stale error callback after recovery completed — session NOT regressed', async () => {
      // Recovery completed: agent_sessions.updated_at reconciled to running well
      // after the OLD container's token was issued (gap 180s ≫ 60s margin).
      mocks.guardRow = {
        runtime: 'cf-container',
        updatedAt: new Date(TOKEN_IAT_MS + 180_000).toISOString(),
      };
      const app = await createTestApp();

      const response = await postActivity(
        app,
        {
          activity: 'error',
          nodeId: 'node-1',
          agentType: 'openai-codex',
          statusError: 'peer disconnected before response',
        },
        OLD_TOKEN
      );

      expect(response.status).toBe(204);
      // Fully short-circuited: no mirror flip, no destructive transition, no
      // active-work-ended on the live recovered generation.
      expect(mocks.projectData.reportAcpSessionActivity).not.toHaveBeenCalled();
      expect(mocks.projectData.transitionAcpSession).not.toHaveBeenCalled();
      expect(mocks.projectData.failSession).not.toHaveBeenCalled();
      expect(mocks.updateSets).toHaveLength(0);
      expect(
        mocks.container.markVmAgentContainerActiveWorkEndedBestEffort
      ).not.toHaveBeenCalled();
      expect(mocks.log.warn).toHaveBeenCalledWith(
        'acp_activity.rejected_stale_callback',
        expect.objectContaining({
          projectId: 'project-1',
          sessionId: 'agent-session-1',
          nodeId: 'node-1',
          runtime: 'cf-container',
          action: 'rejected_stale_callback',
        })
      );
    });

    it('(b) still fails the session for a genuine crash of the CURRENT container (no recovery)', async () => {
      // Same generation: the row was last reconciled ~at token issuance (gap
      // 0.5s ≪ margin), so the error is legitimate and MUST fail the session.
      mocks.guardRow = {
        runtime: 'cf-container',
        updatedAt: new Date(TOKEN_IAT_MS + 500).toISOString(),
      };
      const app = await createTestApp();

      const response = await postActivity(
        app,
        {
          activity: 'error',
          nodeId: 'node-1',
          agentType: 'openai-codex',
          statusError: 'ACP NewSession failed: context deadline exceeded',
        },
        OLD_TOKEN
      );

      expect(response.status).toBe(204);
      expect(mocks.projectData.reportAcpSessionActivity).toHaveBeenCalled();
      expect(mocks.projectData.transitionAcpSession).toHaveBeenCalledWith(
        env,
        'project-1',
        'agent-session-1',
        'failed',
        expect.objectContaining({ actorType: 'vm-agent', actorId: 'node-1' })
      );
      expect(mocks.projectData.failSession).toHaveBeenCalled();
      expect(mocks.updateSets).toContainEqual(expect.objectContaining({ status: 'error' }));
      expect(mocks.log.warn).not.toHaveBeenCalledWith(
        'acp_activity.rejected_stale_callback',
        expect.anything()
      );
    });

    it('(c) rejects a stale error arriving DURING recovery (row reconciled to recovery, not yet running)', async () => {
      // persistRuntimeRecovering has stamped the row (updated_at fresh, 300s
      // after the old token) but recovery has not completed. The mid-recovery
      // session must NOT be regressed by the superseded generation's callback;
      // the current generation will report its own state after restore.
      mocks.guardRow = {
        runtime: 'cf-container',
        updatedAt: new Date(TOKEN_IAT_MS + 300_000).toISOString(),
      };
      const app = await createTestApp();

      const response = await postActivity(
        app,
        { activity: 'error', nodeId: 'node-1', statusError: 'container_stopped' },
        OLD_TOKEN
      );

      expect(response.status).toBe(204);
      expect(mocks.projectData.transitionAcpSession).not.toHaveBeenCalled();
      expect(mocks.projectData.failSession).not.toHaveBeenCalled();
      expect(mocks.updateSets).toHaveLength(0);
      expect(mocks.log.warn).toHaveBeenCalledWith(
        'acp_activity.rejected_stale_callback',
        expect.objectContaining({ action: 'rejected_stale_callback' })
      );
    });

    it('does not engage for VM-runtime nodes even when the row is newer than the token', async () => {
      // Non-Instant runtime never has the generation-replacement race → process.
      mocks.guardRow = {
        runtime: 'vm',
        updatedAt: new Date(TOKEN_IAT_MS + 999_000).toISOString(),
      };
      const app = await createTestApp();

      const response = await postActivity(
        app,
        { activity: 'error', nodeId: 'node-1', statusError: 'agent crashed' },
        OLD_TOKEN
      );

      expect(response.status).toBe(204);
      expect(mocks.projectData.transitionAcpSession).toHaveBeenCalled();
      expect(mocks.projectData.failSession).toHaveBeenCalled();
    });
  });
});
