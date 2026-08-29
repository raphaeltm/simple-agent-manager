import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import type {
  SamEventBusAckResult,
  SamEventBusEvent,
  SamEventBusEventListResult,
  SamEventBusEventSummary,
} from '../../../src/durable-objects/project-data/event-bus';
import { MCP_TOOLS } from '../../../src/routes/mcp/_helpers';
import type { JsonRpcResponse, McpTokenData } from '../../../src/routes/mcp/_helpers';
import {
  EventBusToolStorageError,
  handleAckEventDelivery,
  handleGetEvent,
  handleListSubscriptionEvents,
  type EventBusToolStorageAdapter,
} from '../../../src/routes/mcp/event-bus-tools';

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

function eventSummary(overrides: Partial<SamEventBusEventSummary> = {}): SamEventBusEventSummary {
  return {
    id: 'event-1',
    sequence: 1,
    type: 'task.completed',
    source: 'orchestrator',
    subject: { type: 'task', id: 'child-task-1' },
    actor: { type: 'system', id: null },
    metadata: { reason: 'condition_met' },
    occurredAt: 1_000,
    createdAt: 1_010,
    payloadAvailable: true,
    delivery: {
      id: 'delivery-1',
      subscriptionId: 'sub-1',
      state: 'delivered',
      policy: 'ack_required',
      ackRequired: true,
      createdAt: 1_010,
      deliveredAt: 2_000,
      acknowledgedAt: null,
    },
    ...overrides,
  };
}

function event(overrides: Partial<SamEventBusEvent> = {}): SamEventBusEvent {
  return {
    ...eventSummary(overrides),
    payload: { secret: 'full-payload-secret', output: 'ok' },
    ...overrides,
  };
}

function listResult(overrides: Partial<SamEventBusEventListResult> = {}): SamEventBusEventListResult {
  return {
    subscriptionId: 'sub-1',
    events: [eventSummary()],
    nextCursor: null,
    hasMore: false,
    ...overrides,
  };
}

function ackResult(overrides: Partial<SamEventBusAckResult> = {}): SamEventBusAckResult {
  return {
    acknowledged: true,
    idempotent: false,
    delivery: {
      id: 'delivery-1',
      subscriptionId: 'sub-1',
      eventId: 'event-1',
      state: 'acknowledged',
      policy: 'ack_required',
      ackRequired: true,
      createdAt: 1_010,
      deliveredAt: 2_000,
      acknowledgedAt: 3_000,
    },
    ...overrides,
  };
}

function storage(
  overrides: Partial<EventBusToolStorageAdapter> = {}
): EventBusToolStorageAdapter {
  return {
    getEventBusEvent: vi.fn().mockResolvedValue(event()),
    listEventBusSubscriptionEvents: vi.fn().mockResolvedValue(listResult()),
    acknowledgeEventBusDelivery: vi.fn().mockResolvedValue(ackResult()),
    ...overrides,
  };
}

function env(
  overrides: Partial<Env> & {
    taskRow?: { chat_session_id: string | null; workspace_id: string | null } | null;
    workspaceRow?: { chat_session_id: string | null } | null;
    agentSessionRow?: { id: string; workspace_id: string } | null;
  } = {}
): Env & {
  DATABASE: D1Database & {
    _prepare: ReturnType<typeof vi.fn>;
  };
} {
  const prepare = vi.fn((sql: string) => {
    const statement = {
      params: [] as unknown[],
      bind: vi.fn((...params: unknown[]) => {
        statement.params = params;
        return statement;
      }),
      first: vi.fn(async () => {
        if (sql.includes('FROM tasks')) {
          return overrides.taskRow === undefined
            ? { chat_session_id: 'session-1', workspace_id: 'workspace-1' }
            : overrides.taskRow;
        }
        if (sql.includes('FROM workspaces')) {
          return overrides.workspaceRow === undefined
            ? { chat_session_id: 'session-1' }
            : overrides.workspaceRow;
        }
        if (sql.includes('FROM agent_sessions')) {
          return overrides.agentSessionRow === undefined
            ? { id: 'agent-session-1', workspace_id: 'workspace-1' }
            : overrides.agentSessionRow;
        }
        return null;
      }),
    };
    return statement;
  });

  return {
    MCP_EVENT_BUS_LIST_LIMIT: '2',
    MCP_EVENT_BUS_LIST_MAX: '3',
    DATABASE: {
      prepare,
      _prepare: prepare,
    },
    ...overrides,
  } as unknown as Env & {
    DATABASE: D1Database & {
      _prepare: ReturnType<typeof vi.fn>;
    };
  };
}

function parseToolText(response: JsonRpcResponse): Record<string, unknown> {
  expect(response.error).toBeUndefined();
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('MCP project event-bus tools', () => {
  it('registers the event-bus tools in tools/list metadata', () => {
    const names = MCP_TOOLS.map((tool) => tool.name);

    expect(names).toContain('get_event');
    expect(names).toContain('list_subscription_events');
    expect(names).toContain('ack_event_delivery');
  });

  it('fetches one authorized event with full payload using token-derived identity', async () => {
    const adapter = storage();
    const response = await handleGetEvent(
      1,
      { eventId: 'event-1' },
      token({ chatSessionId: undefined }),
      env(),
      adapter
    );

    const body = parseToolText(response);
    expect(body.event).toMatchObject({
      id: 'event-1',
      payload: { secret: 'full-payload-secret', output: 'ok' },
    });
    expect(adapter.getEventBusEvent).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      'event-1',
      expect.objectContaining({
        projectId: 'project-1',
        taskId: 'task-1',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        agentSessionId: 'agent-session-1',
      })
    );
  });

  it('lists subscription events with bounded limits and payload-free summaries', async () => {
    const adapter = storage({
      listEventBusSubscriptionEvents: vi.fn().mockResolvedValue(
        listResult({
          events: [eventSummary(), eventSummary({ id: 'event-2', sequence: 2 })],
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
    expect(adapter.listEventBusSubscriptionEvents).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      { subscriptionId: 'sub-1', limit: 3, cursor: null },
      expect.objectContaining({ taskId: 'task-1', sessionId: 'session-1' })
    );
    expect(body).toMatchObject({
      subscriptionId: 'sub-1',
      nextCursor: 'opaque-cursor',
      hasMore: true,
    });
    expect(JSON.stringify(body)).not.toContain('full-payload-secret');
    expect(JSON.stringify(body)).not.toContain('"payload"');
  });

  it('acknowledges delivery idempotently', async () => {
    const adapter = storage({
      acknowledgeEventBusDelivery: vi.fn().mockResolvedValue(ackResult({ idempotent: true })),
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
      delivery: { id: 'delivery-1', state: 'acknowledged' },
    });
    expect(adapter.acknowledgeEventBusDelivery).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      { deliveryId: 'delivery-1' },
      expect.objectContaining({ projectId: 'project-1', taskId: 'task-1' })
    );
  });

  it('does not disclose whether an event is nonexistent or unauthorized', async () => {
    const missingStorage = storage({ getEventBusEvent: vi.fn().mockResolvedValue(null) });
    const unauthorizedStorage = storage({ getEventBusEvent: vi.fn().mockResolvedValue(null) });

    const missing = await handleGetEvent(1, { eventId: 'missing-event' }, token(), env(), missingStorage);
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

  it('rejects caller-supplied identity fields before storage access', async () => {
    const adapter = storage();
    const response = await handleGetEvent(
      1,
      { eventId: 'event-1', projectId: 'project-2', sessionId: 'session-2' },
      token(),
      env(),
      adapter
    );

    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message).toContain('derived from the MCP token');
    expect(adapter.getEventBusEvent).not.toHaveBeenCalled();
  });

  it('rejects malformed list cursors and structurally invalid limits', async () => {
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

    expect(malformedCursor.error?.message).toBe('cursor must be a string when provided');
    expect(malformedLimit.error?.message).toBe('limit must be a finite number when provided');
    expect(adapter.listEventBusSubscriptionEvents).not.toHaveBeenCalled();
  });

  it('uses project-predicated D1 identity checks and rejects cross-project/stale identities', async () => {
    const adapter = storage();
    const response = await handleGetEvent(
      1,
      { eventId: 'event-1' },
      token({ projectId: 'project-2' }),
      env({ taskRow: null, workspaceRow: null, agentSessionRow: null }),
      adapter
    );

    expect(response.error?.message).toBe('Caller identity is not valid for this project');
    expect(adapter.getEventBusEvent).not.toHaveBeenCalled();
  });

  it('returns nondisclosing subscription and delivery errors from storage misses', async () => {
    const adapter = storage({
      listEventBusSubscriptionEvents: vi.fn().mockResolvedValue(null),
      acknowledgeEventBusDelivery: vi.fn().mockResolvedValue(null),
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

  it('returns explicit ack-policy errors without leaking payload data', async () => {
    const adapter = storage({
      acknowledgeEventBusDelivery: vi
        .fn()
        .mockRejectedValue(new EventBusToolStorageError('ack_not_required')),
    });

    const response = await handleAckEventDelivery(
      1,
      { deliveryId: 'delivery-no-ack' },
      token(),
      env(),
      adapter
    );

    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message).toBe('Delivery does not require acknowledgement');
    expect(JSON.stringify(response)).not.toContain('payload');
  });
});
