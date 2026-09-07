import type { ProjectEventSubscriptionRecord } from '@simple-agent-manager/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import type { JsonRpcResponse, McpTokenData } from '../../../src/routes/mcp/_helpers';
import {
  handleCancelProjectEventSubscription,
  handleCreateProjectEventSubscription,
  handleGetProjectEventSubscription,
  handleListProjectEventSubscriptions,
} from '../../../src/routes/mcp/event-subscription-tools';
import { ProjectEventIdempotencyConflictError } from '../../../src/services/project-data';

const serviceMocks = vi.hoisted(() => ({
  createProjectEventSubscriptionForCaller: vi.fn(),
  listProjectEventSubscriptionsForCaller: vi.fn(),
  getProjectEventSubscriptionForCaller: vi.fn(),
  cancelProjectEventSubscriptionForCaller: vi.fn(),
}));

vi.mock('../../../src/services/project-event-subscriptions', () => ({
  createProjectEventSubscriptionForCaller: serviceMocks.createProjectEventSubscriptionForCaller,
  listProjectEventSubscriptionsForCaller: serviceMocks.listProjectEventSubscriptionsForCaller,
  getProjectEventSubscriptionForCaller: serviceMocks.getProjectEventSubscriptionForCaller,
  cancelProjectEventSubscriptionForCaller: serviceMocks.cancelProjectEventSubscriptionForCaller,
}));

function makeToken(overrides: Partial<McpTokenData> = {}): McpTokenData {
  return {
    taskId: 'task-1',
    projectId: 'project-1',
    userId: 'user-1',
    workspaceId: 'workspace-1',
    chatSessionId: 'session-1',
    agentSessionId: 'agent-session-1',
    createdAt: '2026-08-28T12:00:00.000Z',
    ...overrides,
  };
}

function makeSubscription(overrides: Partial<ProjectEventSubscriptionRecord> = {}) {
  return {
    id: 'subscription-1',
    projectId: 'project-1',
    contractVersion: 1,
    owner: { type: 'agent' as const, id: 'agent-session-1', name: 'agent-session-1' },
    idempotencyKey: 'idem-1',
    filter: { version: 1 as const, source: 'github' },
    filterFingerprint: 'filter-fp',
    matchKeyCount: 1,
    deliveryPreference: {
      requested: 'existing_session_prompt' as const,
      resolved: 'recorded_not_injected' as const,
      target: {
        sessionId: 'session-1',
        taskId: 'task-1',
        runtimeId: null,
        agentId: 'agent-session-1',
      },
    },
    state: 'active' as const,
    reason: 'watch CI',
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 2,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    lastMatchedAt: null,
    ...overrides,
  } satisfies ProjectEventSubscriptionRecord;
}

function parseToolResponse(response: JsonRpcResponse): Record<string, unknown> {
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('MCP ProjectData event subscription tools', () => {
  const env = {} as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.createProjectEventSubscriptionForCaller.mockResolvedValue({
      subscription: makeSubscription(),
      idempotent: false,
      changed: true,
      callerKind: 'agent',
    });
    serviceMocks.listProjectEventSubscriptionsForCaller.mockResolvedValue({
      subscriptions: [makeSubscription()],
      hasMore: false,
      ownerScope: 'caller',
    });
    serviceMocks.getProjectEventSubscriptionForCaller.mockResolvedValue({
      subscription: makeSubscription(),
      required: true,
    });
    serviceMocks.cancelProjectEventSubscriptionForCaller.mockResolvedValue({
      subscription: makeSubscription({ state: 'cancelled', cancelledAt: 3, updatedAt: 3 }),
      idempotent: false,
      changed: true,
      required: true,
    });
  });

  it('derives create caller identity from the MCP token and returns the typed response payload', async () => {
    const response = await handleCreateProjectEventSubscription(
      1,
      {
        idempotencyKey: 'idem-1',
        filter: { version: 1, source: 'github' },
        requestedDelivery: 'existing_session_prompt',
        target: { sessionId: 'session-1', taskId: 'task-1', agentId: 'agent-session-1' },
        reason: 'watch CI',
      },
      makeToken(),
      env
    );

    expect(response.error).toBeUndefined();
    expect(serviceMocks.createProjectEventSubscriptionForCaller).toHaveBeenCalledWith(
      env,
      {
        kind: 'agent',
        projectId: 'project-1',
        userId: 'user-1',
        workspaceId: 'workspace-1',
        taskId: 'task-1',
        chatSessionId: 'session-1',
        agentSessionId: 'agent-session-1',
        ownerName: 'agent-session-1',
        mcpTokenCreatedAt: '2026-08-28T12:00:00.000Z',
      },
      {
        idempotencyKey: 'idem-1',
        filter: { version: 1, source: 'github' },
        requestedDelivery: 'existing_session_prompt',
        target: { sessionId: 'session-1', taskId: 'task-1', agentId: 'agent-session-1' },
        reason: 'watch CI',
        expiresAt: undefined,
      }
    );
    expect(parseToolResponse(response)).toMatchObject({
      subscription: { id: 'subscription-1' },
      idempotent: false,
      changed: true,
      callerKind: 'agent',
    });
  });

  it('wires list/get/cancel requests without project or owner arguments', async () => {
    const token = makeToken();

    await handleListProjectEventSubscriptions(1, { state: 'any', limit: 5 }, token, env);
    expect(serviceMocks.listProjectEventSubscriptionsForCaller).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ kind: 'agent', projectId: 'project-1', taskId: 'task-1' }),
      { state: 'any', limit: 5 }
    );

    await handleGetProjectEventSubscription(1, { subscriptionId: 'subscription-1', required: false }, token, env);
    expect(serviceMocks.getProjectEventSubscriptionForCaller).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ kind: 'agent', projectId: 'project-1', taskId: 'task-1' }),
      { subscriptionId: 'subscription-1', required: false }
    );

    await handleCancelProjectEventSubscription(
      1,
      { subscriptionId: 'subscription-1', reason: 'done', required: false },
      token,
      env
    );
    expect(serviceMocks.cancelProjectEventSubscriptionForCaller).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ kind: 'agent', projectId: 'project-1', taskId: 'task-1' }),
      { subscriptionId: 'subscription-1', reason: 'done', required: false }
    );
  });

  it('rejects caller-supplied project or owner overrides before service access', async () => {
    const response = await handleCreateProjectEventSubscription(
      1,
      {
        projectId: 'project-2',
        owner: { type: 'policy', id: 'policy-1' },
        idempotencyKey: 'idem-1',
        filter: { version: 1, source: 'github' },
        requestedDelivery: 'record_only',
      },
      makeToken(),
      env
    );

    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message).toContain('projectId');
    expect(serviceMocks.createProjectEventSubscriptionForCaller).not.toHaveBeenCalled();
  });

  it('maps ProjectData idempotency conflicts to typed invalid-params errors', async () => {
    serviceMocks.createProjectEventSubscriptionForCaller.mockRejectedValueOnce(
      new ProjectEventIdempotencyConflictError()
    );

    const response = await handleCreateProjectEventSubscription(
      1,
      {
        idempotencyKey: 'idem-1',
        filter: { version: 1, source: 'github' },
        requestedDelivery: 'record_only',
      },
      makeToken(),
      env
    );

    expect(response.error?.code).toBe(-32602);
    expect(response.error?.data).toMatchObject({
      error: 'PROJECT_EVENT_SUBSCRIPTION_ERROR',
      code: 'PROJECT_EVENT_IDEMPOTENCY_CONFLICT',
    });
  });
});
