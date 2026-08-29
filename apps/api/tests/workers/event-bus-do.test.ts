import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { EventBusIdentity } from '../../src/durable-objects/project-data/event-bus';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

function getStub(projectId: string): DurableObjectStub<ProjectDataTestDouble> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  return env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectDataTestDouble>;
}

describe('ProjectData event bus RPC', () => {
  it('publishes, lists, fetches, and acknowledges a visible event delivery', async () => {
    const projectId = `event-bus-${crypto.randomUUID()}`;
    const stub = getStub(projectId);
    const identity: EventBusIdentity = {
      projectId,
      userId: 'user-1',
      taskId: 'task-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      agentSessionId: 'agent-session-1',
    };

    const subscription = await stub.createEventBusSubscription({
      id: 'subscription-1',
      ownerType: 'task',
      ownerId: 'task-1',
      targetTaskId: 'task-1',
      targetSessionId: 'session-1',
      eventTypes: ['task.completed'],
      deliveryPolicy: 'ack_required',
    });

    const published = await stub.publishEventBusEvent({
      id: 'event-1',
      type: 'task.completed',
      source: 'orchestrator',
      subject: { type: 'task', id: 'child-task-1' },
      actor: { type: 'system', id: null },
      metadata: { reason: 'condition_met' },
      payload: { secret: 'worker-payload-secret', output: 'done' },
    });

    expect(subscription.id).toBe('subscription-1');
    expect(published.deliveryIds).toHaveLength(1);

    const listed = await stub.listEventBusSubscriptionEvents(
      { subscriptionId: 'subscription-1', limit: 10 },
      identity
    );
    expect(listed?.events).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('worker-payload-secret');
    expect(listed?.events[0]).toMatchObject({
      id: 'event-1',
      delivery: { state: 'delivered', policy: 'ack_required' },
    });

    const fetched = await stub.getEventBusEvent('event-1', identity);
    expect(fetched).toMatchObject({
      id: 'event-1',
      payload: { secret: 'worker-payload-secret', output: 'done' },
    });

    const ack = await stub.acknowledgeEventBusDelivery(
      { deliveryId: listed!.events[0]!.delivery.id },
      identity
    );
    expect(ack).toMatchObject({
      acknowledged: true,
      idempotent: false,
      delivery: { eventId: 'event-1', state: 'acknowledged' },
    });
  });
});
