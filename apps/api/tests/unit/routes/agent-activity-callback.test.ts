import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/middleware/error';

const mocks = vi.hoisted(() => ({
  updateSets: [] as Array<Record<string, unknown>>,
  updateReject: null as Error | null,
  workspace: null as Record<string, unknown> | null,
  nodeStatus: 'running',
  workspaceStatus: 'running',
  statusLookupCount: 0,
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
    getSessionState: vi.fn(),
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
        return {
          where: vi.fn().mockImplementation(() => {
            if (mocks.updateReject) return Promise.reject(mocks.updateReject);
            return Promise.resolve(undefined);
          }),
        };
      },
    }),
    // Supports both the idle-branch workspace⋈nodes read (selection includes
    // `id`) and the S2 guard's agent_sessions⋈workspaces⋈nodes read (selection
    // includes `updatedAt`). Any number of leftJoins chain into the same `where`.
    select: (selection?: Record<string, unknown>) => {
      const rowFor = () => {
        if (selection && 'updatedAt' in selection) return mocks.guardRow;
        if (selection && Object.keys(selection).length === 1 && 'status' in selection) {
          mocks.statusLookupCount += 1;
          return {
            status: mocks.statusLookupCount === 1 ? mocks.nodeStatus : mocks.workspaceStatus,
          };
        }
        return mocks.workspace;
      };
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
    mocks.updateReject = null;
    mocks.workspace = null;
    mocks.nodeStatus = 'running';
    mocks.workspaceStatus = 'running';
    mocks.statusLookupCount = 0;
    mocks.guardRow = { updatedAt: null, runtime: 'vm' };
    mocks.jwt.verifyCallbackToken.mockResolvedValue({
      workspace: 'workspace-1',
      type: 'callback',
      scope: 'workspace',
    });
    mocks.projectData.getAcpSession.mockResolvedValue(assignedAcpSession());
    mocks.projectData.getSessionState.mockResolvedValue({ runtimeWorkState: 'inactive' });
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
    mocks.nodeAgent.hibernateAgentSessionOnNode.mockResolvedValueOnce({
      status: 'pending',
      accepted: true,
    });
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
        background: true,
      }
    );
    expect(mocks.container.markVmAgentContainerActiveWorkEndedBestEffort).not.toHaveBeenCalled();
  });

  it('persists normalized harness work and keeps an idle runtime active', async () => {
    mocks.projectData.getSessionState.mockResolvedValueOnce({ runtimeWorkState: 'active' });
    const app = await createTestApp();

    const response = await postActivity(app, {
      activity: 'idle',
      nodeId: 'node-1',
      agentType: 'claude-code',
      runtimeWorkState: 'active',
      runtimeWorkCount: 1,
      runtimeWorkSource: 'claude_sdk',
      runtimeWorkProgressAt: 1234,
    });

    expect(response.status).toBe(204);
    expect(mocks.projectData.reportAcpSessionActivity).toHaveBeenCalledWith(
      env,
      'project-1',
      'agent-session-1',
      'idle',
      expect.objectContaining({
        runtimeWorkState: 'active',
        runtimeWorkCount: 1,
        runtimeWorkSource: 'claude_sdk',
        runtimeWorkProgressAt: 1234,
      })
    );
    expect(mocks.nodeAgent.hibernateAgentSessionOnNode).not.toHaveBeenCalled();
    expect(mocks.container.markVmAgentContainerActiveWorkEndedBestEffort).not.toHaveBeenCalled();
    expect(mocks.updateSets).toContainEqual(
      expect.objectContaining({ sleepStatus: null, sleepClaimId: null })
    );
  });

  it('does not fail valid activity callbacks when best-effort sleep cancellation fails', async () => {
    mocks.projectData.getSessionState.mockResolvedValueOnce({ runtimeWorkState: 'active' });
    mocks.updateReject = new Error('Failed query: update "session_snapshots" set ...');
    const app = await createTestApp();

    const response = await postActivity(app, {
      activity: 'idle',
      nodeId: 'node-1',
      agentType: 'claude-code',
      runtimeWorkState: 'active',
      runtimeWorkCount: 1,
      runtimeWorkSource: 'claude_sdk',
      runtimeWorkProgressAt: 1234,
    });

    expect(response.status).toBe(204);
    expect(mocks.projectData.reportAcpSessionActivity).toHaveBeenCalledWith(
      env,
      'project-1',
      'agent-session-1',
      'idle',
      expect.objectContaining({ runtimeWorkState: 'active' })
    );
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'acp_activity.cancel_scheduled_sleep_failed',
      expect.objectContaining({
        sessionId: 'agent-session-1',
        projectId: 'project-1',
      })
    );
  });

  it('does not hand back runtime for a delayed inactive report when persisted work is active', async () => {
    mocks.projectData.getSessionState.mockResolvedValueOnce({ runtimeWorkState: 'active' });
    const app = await createTestApp();

    const response = await postActivity(app, {
      activity: 'idle',
      nodeId: 'node-1',
      agentType: 'claude-code',
      runtimeWorkState: 'inactive',
      runtimeWorkCount: 0,
      runtimeWorkSource: 'claude_sdk',
      runtimeWorkProgressAt: 1000,
    });

    expect(response.status).toBe(204);
    expect(mocks.nodeAgent.hibernateAgentSessionOnNode).not.toHaveBeenCalled();
    expect(mocks.container.markVmAgentContainerActiveWorkEndedBestEffort).not.toHaveBeenCalled();
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

  // --- Callback-token binding (security-critique #1, rule 28) ---------------------------------
  // The token's OWN identity (payload.workspace) must be bound to the session; the client-supplied
  // body.nodeId is NOT trusted for authorization. Each rejection test is discriminating: on pre-fix
  // code (which only compared existing.nodeId !== body.nodeId) the attacker supplies the victim's
  // real nodeId, so the forgery is ACCEPTED — these tests would fail.

  it('rejects a workspace-scoped token bound to a DIFFERENT tenant workspace (forgery)', async () => {
    // Attacker holds a valid workspace-scoped token for their own workspace-999, targets the
    // victim's session (workspace-1/node-1) and truthfully supplies the victim's nodeId.
    mocks.jwt.verifyCallbackToken.mockResolvedValueOnce({
      workspace: 'workspace-999',
      type: 'callback',
      scope: 'workspace',
    });
    const app = await createTestApp();

    const response = await postActivity(app, { activity: 'error', nodeId: 'node-1' });

    expect(response.status).toBe(403);
    // The forged report must NOT mutate the victim's session.
    expect(mocks.projectData.reportAcpSessionActivity).not.toHaveBeenCalled();
    expect(mocks.projectData.transitionAcpSession).not.toHaveBeenCalled();
    expect(mocks.projectData.failSession).not.toHaveBeenCalled();
  });

  it('does not cancel victim sleep for an unauthorized active harness report', async () => {
    mocks.jwt.verifyCallbackToken.mockResolvedValueOnce({
      workspace: 'workspace-999',
      type: 'callback',
      scope: 'workspace',
    });
    const app = await createTestApp();

    const response = await postActivity(app, {
      activity: 'idle',
      nodeId: 'node-1',
      agentType: 'claude-code',
      runtimeWorkState: 'active',
      runtimeWorkCount: 1,
      runtimeWorkSource: 'claude_sdk',
      runtimeWorkProgressAt: 1234,
    });

    expect(response.status).toBe(403);
    expect(mocks.updateSets).toHaveLength(0);
    expect(mocks.projectData.reportAcpSessionActivity).not.toHaveBeenCalled();
  });

  it('rejects a node-scoped token bound to a DIFFERENT node (forgery)', async () => {
    // Attacker holds a valid node-scoped token for their own node-999, supplies the victim's node-1.
    mocks.jwt.verifyCallbackToken.mockResolvedValueOnce({
      workspace: 'node-999',
      type: 'callback',
      scope: 'node',
    });
    const app = await createTestApp();

    const response = await postActivity(app, { activity: 'error', nodeId: 'node-1' });

    expect(response.status).toBe(403);
    expect(mocks.projectData.reportAcpSessionActivity).not.toHaveBeenCalled();
  });

  it('accepts a node-scoped token bound to the session node', async () => {
    mocks.jwt.verifyCallbackToken.mockResolvedValueOnce({
      workspace: 'node-1',
      type: 'callback',
      scope: 'node',
    });
    const app = await createTestApp();

    const response = await postActivity(app, { activity: 'idle', nodeId: 'node-1' });

    expect(response.status).toBe(204);
    expect(mocks.projectData.reportAcpSessionActivity).toHaveBeenCalled();
  });

  it('returns 410 and does not mutate when the session node is deleted', async () => {
    mocks.nodeStatus = 'deleted';
    const app = await createTestApp();

    const response = await postActivity(app, { activity: 'error', nodeId: 'node-1' });

    expect(response.status).toBe(410);
    expect(mocks.projectData.reportAcpSessionActivity).not.toHaveBeenCalled();
    expect(mocks.projectData.transitionAcpSession).not.toHaveBeenCalled();
    expect(mocks.projectData.failSession).not.toHaveBeenCalled();
    expect(mocks.updateSets).toHaveLength(0);
  });

  it('returns 410 and does not mutate when the session workspace is stopped', async () => {
    mocks.workspaceStatus = 'stopped';
    const app = await createTestApp();

    const response = await postActivity(app, { activity: 'idle', nodeId: 'node-1' });

    expect(response.status).toBe(410);
    expect(mocks.projectData.reportAcpSessionActivity).not.toHaveBeenCalled();
    expect(mocks.container.markVmAgentContainerActiveWorkEndedBestEffort).not.toHaveBeenCalled();
    expect(mocks.updateSets).toHaveLength(0);
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
      expect(mocks.container.markVmAgentContainerActiveWorkEndedBestEffort).not.toHaveBeenCalled();
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
