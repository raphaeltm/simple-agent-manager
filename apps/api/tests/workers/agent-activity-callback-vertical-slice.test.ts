/**
 * Vertical slice tests for ACP activity callbacks.
 *
 * These tests keep the callback HTTP route, callback handler, ProjectData
 * service wrapper, and real ProjectData Durable Object in the path. External
 * callback JWT and VM side-effect boundaries are mocked because they are not
 * the behavior under test.
 *
 * See: .claude/rules/35-vertical-slice-testing.md
 */
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { signCallbackToken } from '../../src/services/jwt';
import * as projectDataService from '../../src/services/project-data';
import {
  seedAgentSession,
  seedInstallation,
  seedNode,
  seedProject,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const mocks = vi.hoisted(() => ({
  nodeAgent: {
    hibernateAgentSessionOnNode: vi.fn(),
  },
  container: {
    markVmAgentContainerActiveWorkEndedBestEffort: vi.fn(),
  },
}));

vi.mock('../../src/services/node-agent', () => ({
  hibernateAgentSessionOnNode: mocks.nodeAgent.hibernateAgentSessionOnNode,
}));

vi.mock('../../src/services/vm-agent-container', () => ({
  markVmAgentContainerActiveWorkEndedBestEffort:
    mocks.container.markVmAgentContainerActiveWorkEndedBestEffort,
}));

const testEnv = env as unknown as Env;

type ActivityBody = {
  activity: 'prompting' | 'idle' | 'recovering' | 'error';
  nodeId: string;
  promptStartedAt?: number;
  agentType?: string;
  restartCount?: number;
  runtimeWorkState?: 'inactive' | 'active' | 'settling';
  runtimeWorkCount?: number;
  runtimeWorkSource?: string;
  runtimeWorkProgressAt?: number;
};

type SeededCallbackSession = {
  projectId: string;
  userId: string;
  nodeId: string;
  workspaceId: string;
  chatSessionId: string;
  acpSessionId: string;
  callbackToken: string;
};

async function createTestApp(): Promise<Hono<{ Bindings: Env }>> {
  const { agentActivityCallbackRoute } = await import(
    '../../src/routes/projects/agent-activity-callback'
  );
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/projects', agentActivityCallbackRoute);
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 409 | 410 | 500);
    }
    return c.json(
      { error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) },
      500
    );
  });
  return app;
}

async function seedCallbackSession(
  suffix: string,
  opts?: { acpSdkSessionId?: string }
): Promise<SeededCallbackSession> {
  const projectId = `project-acp-callback-${suffix}`;
  const userId = `user-acp-callback-${suffix}`;
  const installationId = `installation-acp-callback-${suffix}`;
  const nodeId = `node-acp-callback-${suffix}`;
  const workspaceId = `workspace-acp-callback-${suffix}`;
  const acpSessionId = `agent-session-acp-callback-${suffix}`;

  await seedUser(userId);
  await seedInstallation(installationId, userId, {
    installationIdValue: `external-${installationId}`,
  });
  await seedProject(projectId, userId, installationId);
  await seedNode(nodeId, userId);

  const chatSessionId = await projectDataService.createSession(
    testEnv,
    projectId,
    workspaceId,
    'ACP callback vertical slice'
  );

  await seedWorkspace(workspaceId, nodeId, userId, {
    projectId,
    chatSessionId,
    status: 'running',
  });
  await seedAgentSession(acpSessionId, workspaceId, userId, {
    status: 'running',
    agentType: 'openai-codex',
  });

  await projectDataService.createAcpSession(
    testEnv,
    projectId,
    chatSessionId,
    'Exercise callback coalescing through HTTP',
    'openai-codex',
    null,
    0,
    acpSessionId
  );
  await projectDataService.transitionAcpSession(testEnv, projectId, acpSessionId, 'assigned', {
    actorType: 'system',
    workspaceId,
    nodeId,
  });
  await projectDataService.transitionAcpSession(testEnv, projectId, acpSessionId, 'running', {
    actorType: 'vm-agent',
    actorId: nodeId,
    ...(opts?.acpSdkSessionId ? { acpSdkSessionId: opts.acpSdkSessionId } : {}),
  });

  const callbackToken = await signCallbackToken(workspaceId, testEnv);

  return { projectId, userId, nodeId, workspaceId, chatSessionId, acpSessionId, callbackToken };
}

async function postActivity(
  app: Hono<{ Bindings: Env }>,
  session: SeededCallbackSession,
  body: ActivityBody
): Promise<Response> {
  return app.request(
    `/api/projects/${session.projectId}/acp-sessions/${session.acpSessionId}/activity`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.callbackToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    testEnv
  );
}

describe('ACP activity callback vertical slice', () => {
  beforeEach(async () => {
    const { resetAcpActivityAdmissionForTests } = await import(
      '../../src/services/acp-activity-admission'
    );
    resetAcpActivityAdmissionForTests();
    vi.clearAllMocks();

    const mutableEnv = testEnv as Env & {
      ACP_ACTIVITY_ADMISSION_ENABLED?: string;
      ACP_ACTIVITY_COALESCE_WINDOW_MS?: string;
    };
    mutableEnv.ACP_ACTIVITY_ADMISSION_ENABLED = 'true';
    mutableEnv.ACP_ACTIVITY_COALESCE_WINDOW_MS = '30000';

    mocks.container.markVmAgentContainerActiveWorkEndedBestEffort.mockResolvedValue(undefined);
    mocks.nodeAgent.hibernateAgentSessionOnNode.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const { resetAcpActivityAdmissionForTests } = await import(
      '../../src/services/acp-activity-admission'
    );
    resetAcpActivityAdmissionForTests();
    vi.clearAllTimers();
    vi.useRealTimers();

    const mutableEnv = testEnv as Env & {
      ACP_ACTIVITY_ADMISSION_ENABLED?: string;
      ACP_ACTIVITY_COALESCE_WINDOW_MS?: string;
    };
    delete mutableEnv.ACP_ACTIVITY_ADMISSION_ENABLED;
    delete mutableEnv.ACP_ACTIVITY_COALESCE_WINDOW_MS;
  });

  it('coalesces redundant intermediate callbacks before a terminal idle write', async () => {
    const suffix = crypto.randomUUID();
    const session = await seedCallbackSession(suffix);
    const app = await createTestApp();
    const baseTime = Date.now();
    vi.useFakeTimers();

    vi.setSystemTime(baseTime);
    const first = await postActivity(app, session, {
      activity: 'prompting',
      nodeId: session.nodeId,
      promptStartedAt: baseTime,
      agentType: 'openai-codex',
      restartCount: 0,
      runtimeWorkState: 'active',
      runtimeWorkCount: 1,
      runtimeWorkSource: 'claude_sdk',
      runtimeWorkProgressAt: baseTime,
    });
    expect(first.status).toBe(204);

    expect(await projectDataService.getSessionState(testEnv, session.projectId, session.acpSessionId))
      .toMatchObject({
        activity: 'prompting',
        activityAt: baseTime,
        promptStartedAt: baseTime,
        runtimeWorkState: 'active',
        runtimeWorkCount: 1,
      });

    vi.setSystemTime(baseTime + 100);
    const redundant = await postActivity(app, session, {
      activity: 'prompting',
      nodeId: session.nodeId,
      promptStartedAt: baseTime,
      agentType: 'openai-codex',
      restartCount: 0,
      runtimeWorkState: 'active',
      runtimeWorkCount: 1,
      runtimeWorkSource: 'claude_sdk',
      runtimeWorkProgressAt: baseTime + 100,
    });
    expect(redundant.status).toBe(204);

    expect(await projectDataService.getSessionState(testEnv, session.projectId, session.acpSessionId))
      .toMatchObject({
        activity: 'prompting',
        activityAt: baseTime,
        promptStartedAt: baseTime,
        runtimeWorkProgressAt: baseTime,
      });

    vi.setSystemTime(baseTime + 200);
    const terminal = await postActivity(app, session, {
      activity: 'idle',
      nodeId: session.nodeId,
      agentType: 'openai-codex',
      restartCount: 0,
      runtimeWorkState: 'inactive',
      runtimeWorkCount: 0,
      runtimeWorkSource: 'claude_sdk',
      runtimeWorkProgressAt: baseTime + 200,
    });
    expect(terminal.status).toBe(204);

    expect(await projectDataService.getSessionState(testEnv, session.projectId, session.acpSessionId))
      .toMatchObject({
        activity: 'idle',
        activityAt: baseTime + 200,
        runtimeWorkState: 'inactive',
        runtimeWorkCount: 0,
      });
  });

  it('does not let a stale callback resurrect activity after terminal idle state', async () => {
    const suffix = crypto.randomUUID();
    const session = await seedCallbackSession(suffix);
    const app = await createTestApp();
    const baseTime = Date.now();
    vi.useFakeTimers();

    vi.setSystemTime(baseTime);
    const terminal = await postActivity(app, session, {
      activity: 'idle',
      nodeId: session.nodeId,
      agentType: 'openai-codex',
      restartCount: 0,
      runtimeWorkState: 'inactive',
      runtimeWorkCount: 0,
      runtimeWorkSource: 'claude_sdk',
      runtimeWorkProgressAt: baseTime,
    });
    expect(terminal.status).toBe(204);

    vi.setSystemTime(baseTime - 1_000);
    const stale = await postActivity(app, session, {
      activity: 'prompting',
      nodeId: session.nodeId,
      promptStartedAt: baseTime - 1_000,
      agentType: 'openai-codex',
      restartCount: 0,
      runtimeWorkState: 'active',
      runtimeWorkCount: 1,
      runtimeWorkSource: 'claude_sdk',
      runtimeWorkProgressAt: baseTime - 1_000,
    });
    expect(stale.status).toBe(204);

    expect(await projectDataService.getSessionState(testEnv, session.projectId, session.acpSessionId))
      .toMatchObject({
        activity: 'idle',
        activityAt: baseTime,
        runtimeWorkState: 'inactive',
        runtimeWorkCount: 0,
      });
  });
});
