import type {
  ProjectEventDeliveryAckResult,
  ProjectEventSubscriptionEvent,
  ProjectEventSubscriptionEventListResult,
  ProjectEventSubscriptionEventSummary,
} from '@simple-agent-manager/shared';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import type { JsonRpcResponse, McpTokenData } from '../../../src/routes/mcp/_helpers';
import { MCP_TOOLS } from '../../../src/routes/mcp/_helpers';
import {
  handleAckEventDelivery,
  handleGetEvent,
  handleListSubscriptionEvents,
  type ProjectEventToolStorageAdapter,
} from '../../../src/routes/mcp/project-event-tools';
import {
  ProjectEventAckStateError,
  ProjectEventCursorError,
} from '../../../src/services/project-data';
import { ProjectEventCallerIdentityError } from '../../../src/services/project-event-deliveries';

function token(overrides: Partial<McpTokenData> = {}): McpTokenData {
  return {
    taskId: 'task-1',
    projectId: 'project-1',
    userId: 'user-1',
    workspaceId: 'workspace-1',
    chatSessionId: 'session-1',
    agentSessionId: 'agent-session-1',
    createdAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  };
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    PROJECT_EVENT_LIST_LIMIT: '2',
    PROJECT_EVENT_LIST_MAX: '3',
    PROJECT_EVENT_SUBSCRIPTION_EVENT_CURSOR_MAX_LENGTH: '10',
    ...overrides,
  } as Env;
}

function eventSummary(
  overrides: Partial<ProjectEventSubscriptionEventSummary> = {}
): ProjectEventSubscriptionEventSummary {
  return {
    id: 'event-1',
    source: 'github',
    eventType: 'check_suite.completed',
    subject: { type: 'pull_request', id: '42' },
    severity: 'warning',
    metadata: { conclusion: 'failure' },
    display: { title: 'CI failed', summary: 'Tests failed', untrusted: true },
    occurredAt: 1_000,
    receivedAt: 1_010,
    matchId: 'match-1',
    payloadRefAvailable: true,
    delivery: {
      id: 'delivery-1',
      subscriptionId: 'sub-1',
      state: 'delivered',
      ackRequired: true,
      requestedDelivery: 'existing_session_prompt',
      resolvedDelivery: 'recorded_not_injected',
      createdAt: 1_010,
      deliveredAt: 2_000,
      acknowledgedAt: null,
    },
    ...overrides,
  };
}

function event(
  overrides: Partial<ProjectEventSubscriptionEvent> = {}
): ProjectEventSubscriptionEvent {
  return {
    ...eventSummary(overrides),
    projectId: 'project-1',
    contractVersion: 1,
    deliveryKey: 'github-delivery-1',
    payloadFingerprint: 'sha256:fingerprint',
    rawPayloadRef: { provider: 'r2', uri: 'r2://full-payload-secret', contentHash: 'sha256:full' },
    updatedAt: 1_010,
    state: 'recorded',
    duplicateCount: 0,
    conflictCount: 0,
    conflictFingerprint: null,
    conflictDetectedAt: null,
    ...overrides,
  };
}

function listResult(
  overrides: Partial<ProjectEventSubscriptionEventListResult> = {}
): ProjectEventSubscriptionEventListResult {
  return {
    subscriptionId: 'sub-1',
    events: [eventSummary()],
    nextCursor: null,
    hasMore: false,
    ...overrides,
  };
}

function ackResult(
  overrides: Partial<ProjectEventDeliveryAckResult> = {}
): ProjectEventDeliveryAckResult {
  return {
    acknowledged: true,
    idempotent: false,
    delivery: {
      id: 'delivery-1',
      subscriptionId: 'sub-1',
      state: 'acked',
      ackRequired: true,
      requestedDelivery: 'existing_session_prompt',
      resolvedDelivery: 'recorded_not_injected',
      createdAt: 1_010,
      deliveredAt: 2_000,
      acknowledgedAt: 3_000,
      eventId: 'event-1',
      eventIds: ['event-1'],
    },
    ...overrides,
  };
}

function storage(
  overrides: Partial<ProjectEventToolStorageAdapter> = {}
): ProjectEventToolStorageAdapter {
  return {
    getProjectEventForCaller: vi.fn().mockResolvedValue(event()),
    listProjectEventSubscriptionEventsForCaller: vi.fn().mockResolvedValue(listResult()),
    ackProjectEventDeliveryForCaller: vi.fn().mockResolvedValue(ackResult()),
    ...overrides,
  };
}

function parseToolText(response: JsonRpcResponse): Record<string, unknown> {
  expect(response.error).toBeUndefined();
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('MCP ProjectData event retrieval tools', () => {
  it('registers the retrieval and ack tools in tools/list metadata', () => {
    const names = MCP_TOOLS.map((tool) => tool.name);

    expect(names).toContain('get_event');
    expect(names).toContain('list_subscription_events');
    expect(names).toContain('ack_event_delivery');
  });

  it('fetches one authorized event with full canonical payload details using token-derived identity', async () => {
    const adapter = storage();
    const response = await handleGetEvent(1, { eventId: 'event-1' }, token(), env(), adapter);

    const body = parseToolText(response);
    expect(body.event).toMatchObject({
      id: 'event-1',
      rawPayloadRef: { uri: 'r2://full-payload-secret' },
    });
    expect(adapter.getProjectEventForCaller).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'agent',
        projectId: 'project-1',
        taskId: 'task-1',
        chatSessionId: 'session-1',
        agentSessionId: 'agent-session-1',
      }),
      { eventId: 'event-1' }
    );
  });

  it('lists subscription events with bounded limits and payload-free summaries', async () => {
    const adapter = storage({
      listProjectEventSubscriptionEventsForCaller: vi.fn().mockResolvedValue(
        listResult({
          events: [eventSummary(), eventSummary({ id: 'event-2', matchId: 'match-2' })],
          nextCursor: 'opaque-cursor',
          hasMore: true,
        })
      ),
    });
    const response = await handleListSubscriptionEvents(
      1,
      { subscriptionId: 'sub-1', limit: 99 },
      token(),
      env(),
      adapter
    );

    const body = parseToolText(response);
    expect(adapter.listProjectEventSubscriptionEventsForCaller).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ taskId: 'task-1', chatSessionId: 'session-1' }),
      { subscriptionId: 'sub-1', limit: 3, cursor: null, cursorMaxLength: 10 }
    );
    expect(body).toMatchObject({
      subscriptionId: 'sub-1',
      nextCursor: 'opaque-cursor',
      hasMore: true,
    });
    expect(JSON.stringify(body)).not.toContain('full-payload-secret');
    expect(JSON.stringify(body)).not.toContain('rawPayloadRef');
  });

  it('acknowledges delivery idempotently', async () => {
    const adapter = storage({
      ackProjectEventDeliveryForCaller: vi.fn().mockResolvedValue(ackResult({ idempotent: true })),
    });
    const response = await handleAckEventDelivery(
      1,
      { deliveryId: 'delivery-1' },
      token(),
      env(),
      adapter
    );

    expect(parseToolText(response)).toMatchObject({
      acknowledged: true,
      idempotent: true,
      delivery: { id: 'delivery-1', state: 'acked' },
    });
    expect(adapter.ackProjectEventDeliveryForCaller).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectId: 'project-1', taskId: 'task-1' }),
      { deliveryId: 'delivery-1' }
    );
  });

  it('does not disclose whether an event is nonexistent or unauthorized', async () => {
    const missingStorage = storage({ getProjectEventForCaller: vi.fn().mockResolvedValue(null) });
    const unauthorizedStorage = storage({
      getProjectEventForCaller: vi.fn().mockResolvedValue(null),
    });

    const missing = await handleGetEvent(
      1,
      { eventId: 'missing-event' },
      token(),
      env(),
      missingStorage
    );
    const unauthorized = await handleGetEvent(
      2,
      { eventId: 'event-from-other-subscription' },
      token(),
      env(),
      unauthorizedStorage
    );

    expect(missing.error).toEqual(unauthorized.error);
    expect(missing.error?.message).toBe('Event not found or not visible to this agent');
    expect(JSON.stringify(missing)).not.toContain('event-from-other-subscription');
    expect(JSON.stringify(unauthorized)).not.toContain('event-from-other-subscription');
  });

  it('rejects caller-supplied identity fields and unexpected parameters before storage access', async () => {
    const adapter = storage();
    const identityOverride = await handleGetEvent(
      1,
      { eventId: 'event-1', project_id: 'project-2', session_id: 'session-2' },
      token(),
      env(),
      adapter
    );
    const unexpected = await handleAckEventDelivery(
      2,
      { deliveryId: 'delivery-1', extra: 'ignored' },
      token(),
      env(),
      adapter
    );

    expect(identityOverride.error?.code).toBe(-32602);
    expect(identityOverride.error?.message).toContain('derived from the MCP token');
    expect(unexpected.error?.message).toBe('Unexpected parameter: extra');
    expect(adapter.getProjectEventForCaller).not.toHaveBeenCalled();
    expect(adapter.ackProjectEventDeliveryForCaller).not.toHaveBeenCalled();
  });

  it('rejects malformed list cursors and structurally invalid limits before storage access', async () => {
    const adapter = storage();
    const malformedCursor = await handleListSubscriptionEvents(
      1,
      { subscriptionId: 'sub-1', cursor: 123 },
      token(),
      env(),
      adapter
    );
    const malformedLimit = await handleListSubscriptionEvents(
      2,
      { subscriptionId: 'sub-1', limit: '100' },
      token(),
      env(),
      adapter
    );
    const fractionalLimit = await handleListSubscriptionEvents(
      3,
      { subscriptionId: 'sub-1', limit: 0.99 },
      token(),
      env(),
      adapter
    );
    const zeroLimit = await handleListSubscriptionEvents(
      4,
      { subscriptionId: 'sub-1', limit: 0 },
      token(),
      env(),
      adapter
    );
    const oversizedCursor = await handleListSubscriptionEvents(
      5,
      { subscriptionId: 'sub-1', cursor: 'a'.repeat(11) },
      token(),
      env(),
      adapter
    );

    expect(malformedCursor.error?.message).toBe('cursor must be a string when provided');
    expect(malformedLimit.error?.message).toBe('limit must be a finite number when provided');
    expect(fractionalLimit.error?.message).toBe('limit must be an integer when provided');
    expect(zeroLimit.error?.message).toBe('limit must be greater than 0');
    expect(oversizedCursor.error?.message).toBe('Invalid cursor');
    expect(adapter.listProjectEventSubscriptionEventsForCaller).not.toHaveBeenCalled();
  });

  it('maps storage cursor and caller-identity failures to stable client errors', async () => {
    const cursorStorage = storage({
      listProjectEventSubscriptionEventsForCaller: vi
        .fn()
        .mockRejectedValue(new ProjectEventCursorError()),
    });
    const identityStorage = storage({
      getProjectEventForCaller: vi.fn().mockRejectedValue(new ProjectEventCallerIdentityError()),
    });

    const cursor = await handleListSubscriptionEvents(
      1,
      { subscriptionId: 'sub-1' },
      token(),
      env(),
      cursorStorage
    );
    const identity = await handleGetEvent(
      2,
      { eventId: 'event-1' },
      token({ projectId: 'project-2' }),
      env(),
      identityStorage
    );

    expect(cursor.error?.message).toBe('Invalid cursor');
    expect(identity.error?.message).toBe('Caller identity is not valid for this project');
  });

  it('returns nondisclosing subscription and delivery errors from storage misses', async () => {
    const adapter = storage({
      listProjectEventSubscriptionEventsForCaller: vi.fn().mockResolvedValue(null),
      ackProjectEventDeliveryForCaller: vi.fn().mockResolvedValue(null),
    });

    const list = await handleListSubscriptionEvents(
      1,
      { subscriptionId: 'sub-other' },
      token(),
      env(),
      adapter
    );
    const ack = await handleAckEventDelivery(
      2,
      { deliveryId: 'delivery-other' },
      token(),
      env(),
      adapter
    );

    expect(list.error?.message).toBe('Subscription not found or not visible to this agent');
    expect(ack.error?.message).toBe('Delivery not found or not visible to this agent');
    expect(JSON.stringify(list)).not.toContain('sub-other');
    expect(JSON.stringify(ack)).not.toContain('delivery-other');
  });

  it('returns explicit ack-state errors without leaking payload data', async () => {
    const adapter = storage({
      ackProjectEventDeliveryForCaller: vi.fn().mockRejectedValue(new ProjectEventAckStateError()),
    });

    const response = await handleAckEventDelivery(
      1,
      { deliveryId: 'delivery-failed' },
      token(),
      env(),
      adapter
    );

    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message).toBe('Delivery cannot be acknowledged in its current state');
    expect(JSON.stringify(response)).not.toContain('delivery-failed');
    expect(JSON.stringify(response)).not.toContain('payload');
  });
});
