import type {
  ProjectEventFilterV1,
  ProjectEventSubscriptionAgentCaller,
  ProjectEventSubscriptionOwner,
  ProjectEventSubscriptionRecord,
} from '@simple-agent-manager/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectEventIdempotencyConflictError } from '../../../src/durable-objects/project-data/project-events-contracts';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';

const projectDataMocks = vi.hoisted(() => ({
  createProjectEventSubscription: vi.fn(),
  listProjectEventSubscriptions: vi.fn(),
  getProjectEventSubscription: vi.fn(),
  cancelProjectEventSubscription: vi.fn(),
  expireProjectEventSubscriptions: vi.fn(),
}));

vi.mock('../../../src/services/project-data', () => ({
  createProjectEventSubscription: projectDataMocks.createProjectEventSubscription,
  listProjectEventSubscriptions: projectDataMocks.listProjectEventSubscriptions,
  getProjectEventSubscription: projectDataMocks.getProjectEventSubscription,
  cancelProjectEventSubscription: projectDataMocks.cancelProjectEventSubscription,
  expireProjectEventSubscriptions: projectDataMocks.expireProjectEventSubscriptions,
}));

import {
  cancelProjectEventSubscriptionForCaller,
  createProjectEventSubscriptionForCaller,
  expireProjectEventSubscriptionsForCaller,
  getProjectEventSubscriptionForCaller,
  listProjectEventSubscriptionsForCaller,
} from '../../../src/services/project-event-subscriptions';

type TaskRow = {
  id: string;
  project_id: string;
  user_id: string;
  status: string;
  workspace_id: string | null;
  chat_session_id: string | null;
};

type WorkspaceRow = {
  id: string;
  project_id: string | null;
  user_id: string;
  status: string;
  chat_session_id: string | null;
};

type AgentSessionRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  status: string;
};

type D1Fixtures = {
  tasks?: Record<string, TaskRow>;
  workspaces?: Record<string, WorkspaceRow>;
  agentSessions?: Record<string, AgentSessionRow>;
};

const now = Date.parse('2026-08-28T12:00:00.000Z');

const filter: ProjectEventFilterV1 = {
  version: 1,
  source: 'github',
  eventType: 'check_suite.completed',
  severity: 'error',
};

function makeEnv(fixtures: D1Fixtures = {}): Env {
  const tasks = fixtures.tasks ?? {
    'task-1': {
      id: 'task-1',
      project_id: 'project-1',
      user_id: 'user-1',
      status: 'in_progress',
      workspace_id: 'workspace-1',
      chat_session_id: 'session-1',
    },
  };
  const workspaces = fixtures.workspaces ?? {
    'workspace-1': {
      id: 'workspace-1',
      project_id: 'project-1',
      user_id: 'user-1',
      status: 'running',
      chat_session_id: 'session-1',
    },
  };
  const agentSessions = fixtures.agentSessions ?? {
    'agent-session-1': {
      id: 'agent-session-1',
      workspace_id: 'workspace-1',
      user_id: 'user-1',
      status: 'running',
    },
  };

  return {
    MCP_TOKEN_TTL_SECONDS: '120',
    MCP_TOKEN_MAX_LIFETIME_SECONDS: '300',
    DATABASE: {
      prepare: vi.fn((sql: string) => {
        const statement = {
          params: [] as unknown[],
          bind: vi.fn((...params: unknown[]) => {
            statement.params = params;
            return statement;
          }),
          first: vi.fn(async () => {
            if (sql.includes('FROM tasks')) {
              const [taskId, projectId] = statement.params as [string, string];
              const task = tasks[taskId];
              return task?.project_id === projectId ? task : null;
            }
            if (sql.includes('INNER JOIN workspaces')) {
              const [agentSessionId, projectId] = statement.params as [string, string];
              const agentSession = agentSessions[agentSessionId];
              const workspace = agentSession ? workspaces[agentSession.workspace_id] : null;
              if (!agentSession || workspace?.project_id !== projectId) return null;
              return { ...agentSession, project_id: workspace.project_id };
            }
            if (sql.includes('FROM agent_sessions')) {
              const [agentSessionId] = statement.params as [string];
              return agentSessions[agentSessionId] ?? null;
            }
            if (sql.includes('FROM workspaces')) {
              const [workspaceId] = statement.params as [string];
              return workspaces[workspaceId] ?? null;
            }
            return null;
          }),
        };
        return statement;
      }),
    },
  } as unknown as Env;
}

function makeAgentCaller(
  overrides: Partial<ProjectEventSubscriptionAgentCaller> = {}
): ProjectEventSubscriptionAgentCaller {
  return {
    kind: 'agent',
    projectId: 'project-1',
    userId: 'user-1',
    workspaceId: 'workspace-1',
    taskId: 'task-1',
    chatSessionId: 'session-1',
    agentSessionId: 'agent-session-1',
    ownerName: 'agent-session-1',
    mcpTokenCreatedAt: new Date(now - 60_000).toISOString(),
    ...overrides,
  };
}

function makeSubscription(
  overrides: Partial<ProjectEventSubscriptionRecord> = {}
): ProjectEventSubscriptionRecord {
  const owner: ProjectEventSubscriptionOwner = {
    type: 'agent',
    id: 'agent-session-1',
    name: 'agent-session-1',
  };
  return {
    id: 'subscription-1',
    projectId: 'project-1',
    contractVersion: 1,
    owner,
    idempotencyKey: 'idem-1',
    filter,
    filterFingerprint: 'filter-fp',
    matchKeyCount: 3,
    deliveryPreference: {
      requested: 'existing_session_prompt',
      resolved: 'recorded_not_injected',
      target: {
        sessionId: 'session-1',
        taskId: 'task-1',
        runtimeId: null,
        agentId: 'agent-session-1',
      },
    },
    state: 'active',
    reason: 'watch CI',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 120_000,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    lastMatchedAt: null,
    ...overrides,
  };
}

async function expectAppError(
  promise: Promise<unknown>,
  statusCode: number,
  messagePart: string
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await expect(promise).rejects.toMatchObject({
    statusCode,
    message: expect.stringContaining(messagePart),
  });
}

describe('internal ProjectData event subscription surface', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.clearAllMocks();
    projectDataMocks.createProjectEventSubscription.mockImplementation(
      async (_env: Env, projectId: string, input: Record<string, unknown>) => ({
        subscription: makeSubscription({
          projectId,
          owner: input.owner as ProjectEventSubscriptionOwner,
          idempotencyKey: input.idempotencyKey as string,
          filter: input.filter as ProjectEventFilterV1,
          deliveryPreference: input.deliveryPreference as ProjectEventSubscriptionRecord['deliveryPreference'],
          reason: input.reason as string | null,
          expiresAt: input.expiresAt as number | null,
        }),
        idempotent: false,
        changed: true,
      })
    );
    projectDataMocks.listProjectEventSubscriptions.mockResolvedValue({
      subscriptions: [makeSubscription()],
      hasMore: false,
    });
    projectDataMocks.getProjectEventSubscription.mockResolvedValue(makeSubscription());
    projectDataMocks.cancelProjectEventSubscription.mockResolvedValue({
      subscription: makeSubscription({ state: 'cancelled', cancelledAt: now, updatedAt: now }),
      idempotent: false,
      changed: true,
    });
    projectDataMocks.expireProjectEventSubscriptions.mockResolvedValue({ expired: 2 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates agent-owned session-scoped subscriptions with derived project, owner, target, and TTL', async () => {
    const env = makeEnv();

    const response = await createProjectEventSubscriptionForCaller(env, makeAgentCaller(), {
      idempotencyKey: 'idem-1',
      filter,
      requestedDelivery: 'existing_session_prompt',
      target: {
        sessionId: 'session-1',
        taskId: 'task-1',
        agentId: 'agent-session-1',
      },
      reason: 'watch CI',
    });

    expect(response).toMatchObject({ callerKind: 'agent', changed: true, idempotent: false });
    expect(projectDataMocks.createProjectEventSubscription).toHaveBeenCalledWith(
      env,
      'project-1',
      {
        owner: { type: 'agent', id: 'agent-session-1', name: 'agent-session-1' },
        idempotencyKey: 'idem-1',
        filter,
        deliveryPreference: {
          requested: 'existing_session_prompt',
          resolved: 'recorded_not_injected',
          target: {
            sessionId: 'session-1',
            taskId: 'task-1',
            runtimeId: null,
            agentId: 'agent-session-1',
          },
        },
        reason: 'watch CI',
        expiresAt: now + 120_000,
      }
    );
  });

  it('caps agent subscription expiry by the MCP token maximum lifetime', async () => {
    await expectAppError(
      createProjectEventSubscriptionForCaller(makeEnv(), makeAgentCaller({ mcpTokenCreatedAt: null }), {
        idempotencyKey: 'idem-1',
        filter,
        requestedDelivery: 'record_only',
        expiresAt: now + 301_000,
      }),
      403,
      'token lifetime'
    );
    expect(projectDataMocks.createProjectEventSubscription).not.toHaveBeenCalled();
  });

  it('rejects agent owner, target, runtime, and project overrides before storage writes', async () => {
    const env = makeEnv();

    await expectAppError(
      createProjectEventSubscriptionForCaller(env, makeAgentCaller(), {
        owner: { type: 'policy', id: 'policy-1' },
        idempotencyKey: 'idem-1',
        filter,
        requestedDelivery: 'record_only',
      }),
      403,
      'owner identity'
    );
    await expectAppError(
      createProjectEventSubscriptionForCaller(env, makeAgentCaller(), {
        idempotencyKey: 'idem-1',
        filter,
        requestedDelivery: 'record_only',
        target: { sessionId: 'session-2' },
      }),
      403,
      'target session'
    );
    await expectAppError(
      createProjectEventSubscriptionForCaller(env, makeAgentCaller(), {
        idempotencyKey: 'idem-1',
        filter,
        requestedDelivery: 'runtime_steer',
        target: { runtimeId: 'runtime-2' },
      }),
      403,
      'runtimes directly'
    );
    await expectAppError(
      createProjectEventSubscriptionForCaller(env, makeAgentCaller(), {
        projectId: 'project-2',
        idempotencyKey: 'idem-1',
        filter,
        requestedDelivery: 'record_only',
      } as never),
      403,
      'projectId'
    );

    expect(projectDataMocks.createProjectEventSubscription).not.toHaveBeenCalled();
  });

  it('rejects invalid caller project and workspace bindings before storage writes', async () => {
    await expectAppError(
      createProjectEventSubscriptionForCaller(makeEnv(), makeAgentCaller({ projectId: 'project-2' }), {
        idempotencyKey: 'idem-1',
        filter,
        requestedDelivery: 'record_only',
      }),
      404,
      'Calling task'
    );

    await expectAppError(
      createProjectEventSubscriptionForCaller(
        makeEnv({
          workspaces: {
            'workspace-1': {
              id: 'workspace-1',
              project_id: 'project-2',
              user_id: 'user-1',
              status: 'running',
              chat_session_id: 'session-1',
            },
          },
        }),
        makeAgentCaller(),
        {
          idempotencyKey: 'idem-1',
          filter,
          requestedDelivery: 'record_only',
        }
      ),
      403,
      'workspace is not bound'
    );

    expect(projectDataMocks.createProjectEventSubscription).not.toHaveBeenCalled();
  });

  it('allows platform-owned policy and standing-watch subscriptions behind explicit gates', async () => {
    const env = makeEnv();
    const platformCaller = {
      kind: 'platform' as const,
      projectId: 'project-1',
      actorId: 'policy-engine',
      permissions: {
        managePolicySubscriptions: true,
        manageStandingWatchSubscriptions: true,
      },
    };

    await createProjectEventSubscriptionForCaller(env, platformCaller, {
      owner: { type: 'policy', id: 'policy-1', name: 'Quiet hours' },
      idempotencyKey: 'policy-idem',
      filter,
      requestedDelivery: 'record_only',
    });
    await createProjectEventSubscriptionForCaller(env, platformCaller, {
      owner: { type: 'standing_watch', id: 'watch-1', name: 'PR CI watch' },
      idempotencyKey: 'watch-idem',
      filter,
      requestedDelivery: 'existing_session_prompt',
    });

    expect(projectDataMocks.createProjectEventSubscription).toHaveBeenCalledTimes(2);
    expect(projectDataMocks.createProjectEventSubscription).toHaveBeenNthCalledWith(
      1,
      env,
      'project-1',
      expect.objectContaining({
        owner: { type: 'policy', id: 'policy-1', name: 'Quiet hours' },
        expiresAt: null,
      })
    );
    expect(projectDataMocks.createProjectEventSubscription).toHaveBeenNthCalledWith(
      2,
      env,
      'project-1',
      expect.objectContaining({
        owner: { type: 'standing_watch', id: 'watch-1', name: 'PR CI watch' },
        deliveryPreference: expect.objectContaining({
          requested: 'existing_session_prompt',
          resolved: 'recorded_not_injected',
        }),
      })
    );
  });

  it('rejects platform targets that are not bound to the caller project', async () => {
    const env = makeEnv({
      tasks: {
        'foreign-task': {
          id: 'foreign-task',
          project_id: 'project-2',
          user_id: 'user-2',
          status: 'in_progress',
          workspace_id: 'workspace-2',
          chat_session_id: 'session-2',
        },
      },
    });

    await expectAppError(
      createProjectEventSubscriptionForCaller(
        env,
        {
          kind: 'platform',
          projectId: 'project-1',
          actorId: 'policy-engine',
          permissions: { managePolicySubscriptions: true },
        },
        {
          owner: { type: 'policy', id: 'policy-1', name: 'Quiet hours' },
          idempotencyKey: 'policy-idem',
          filter,
          requestedDelivery: 'existing_session_prompt',
          target: { taskId: 'foreign-task' },
        }
      ),
      404,
      'Target task'
    );
    expect(projectDataMocks.createProjectEventSubscription).not.toHaveBeenCalled();
  });

  it('blocks platform owner types without the matching placeholder gate', async () => {
    await expectAppError(
      createProjectEventSubscriptionForCaller(
        makeEnv(),
        { kind: 'platform', projectId: 'project-1', actorId: 'platform', permissions: {} },
        {
          owner: { type: 'policy', id: 'policy-1' },
          idempotencyKey: 'policy-idem',
          filter,
          requestedDelivery: 'record_only',
        }
      ),
      403,
      'policy event subscriptions'
    );
    await expectAppError(
      createProjectEventSubscriptionForCaller(
        makeEnv(),
        {
          kind: 'platform',
          projectId: 'project-1',
          actorId: 'platform',
          permissions: { manageSystemSubscriptions: true },
        },
        {
          owner: { type: 'human', id: 'user-2' },
          idempotencyKey: 'human-idem',
          filter,
          requestedDelivery: 'record_only',
        }
      ),
      403,
      'Human-owned'
    );
  });

  it('surfaces B1 idempotency conflicts from ProjectData unchanged', async () => {
    projectDataMocks.createProjectEventSubscription.mockRejectedValueOnce(
      new ProjectEventIdempotencyConflictError()
    );

    await expect(
      createProjectEventSubscriptionForCaller(makeEnv(), makeAgentCaller(), {
        idempotencyKey: 'idem-1',
        filter,
        requestedDelivery: 'record_only',
      })
    ).rejects.toMatchObject({ code: 'PROJECT_EVENT_IDEMPOTENCY_CONFLICT' });
  });

  it('applies required-subscription semantics and agent session scoping on reads', async () => {
    projectDataMocks.listProjectEventSubscriptions.mockResolvedValueOnce({
      subscriptions: [
        makeSubscription(),
        makeSubscription({
          id: 'subscription-2',
          deliveryPreference: {
            requested: 'record_only',
            resolved: 'record_only',
            target: { sessionId: 'session-2', taskId: 'task-1', runtimeId: null, agentId: null },
          },
        }),
      ],
      hasMore: false,
    });

    const listed = await listProjectEventSubscriptionsForCaller(makeEnv(), makeAgentCaller());
    expect(listed.subscriptions.map((subscription) => subscription.id)).toEqual(['subscription-1']);
    expect(projectDataMocks.listProjectEventSubscriptions).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      {
        state: 'active',
        owner: { type: 'agent', id: 'agent-session-1', name: 'agent-session-1' },
        limit: null,
      }
    );

    projectDataMocks.getProjectEventSubscription.mockResolvedValueOnce(null);
    await expect(
      getProjectEventSubscriptionForCaller(makeEnv(), makeAgentCaller(), {
        subscriptionId: 'missing',
      })
    ).rejects.toMatchObject({ statusCode: 404 });

    projectDataMocks.getProjectEventSubscription.mockResolvedValueOnce(null);
    await expect(
      getProjectEventSubscriptionForCaller(makeEnv(), makeAgentCaller(), {
        subscriptionId: 'missing',
        required: false,
      })
    ).resolves.toEqual({ subscription: null, required: false });

    projectDataMocks.getProjectEventSubscription.mockResolvedValueOnce(
      makeSubscription({ owner: { type: 'agent', id: 'task-2' } })
    );
    await expect(
      getProjectEventSubscriptionForCaller(makeEnv(), makeAgentCaller(), {
        subscriptionId: 'subscription-2',
      })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('handles cancellation and expiry races without widening ownership', async () => {
    projectDataMocks.cancelProjectEventSubscription.mockResolvedValueOnce({
      subscription: makeSubscription({ state: 'expired', updatedAt: now + 1 }),
      idempotent: true,
      changed: false,
    });

    await expect(
      cancelProjectEventSubscriptionForCaller(makeEnv(), makeAgentCaller(), {
        subscriptionId: 'subscription-1',
        reason: 'done',
      })
    ).resolves.toMatchObject({
      subscription: { state: 'expired' },
      idempotent: true,
      changed: false,
      required: true,
    });
    expect(projectDataMocks.cancelProjectEventSubscription).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      {
        subscriptionId: 'subscription-1',
        cancelledBy: { type: 'agent', id: 'agent-session-1', name: 'agent-session-1' },
        reason: 'done',
      }
    );

    projectDataMocks.getProjectEventSubscription.mockResolvedValueOnce(null);
    await expect(
      cancelProjectEventSubscriptionForCaller(makeEnv(), makeAgentCaller(), {
        subscriptionId: 'missing',
        required: false,
      })
    ).resolves.toEqual({
      subscription: null,
      idempotent: true,
      changed: false,
      required: false,
    });
  });

  it('keeps expiry internal to explicitly authorized platform callers', async () => {
    await expectAppError(
      expireProjectEventSubscriptionsForCaller(makeEnv(), makeAgentCaller(), {}),
      403,
      'Only platform'
    );

    await expect(
      expireProjectEventSubscriptionsForCaller(
        makeEnv(),
        {
          kind: 'platform',
          projectId: 'project-1',
          actorId: 'sweeper',
          permissions: { expireSubscriptions: true },
        },
        { now, limit: 10 }
      )
    ).resolves.toEqual({ expired: 2, callerKind: 'platform' });
    expect(projectDataMocks.expireProjectEventSubscriptions).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      { now, limit: 10 }
    );
  });
});
