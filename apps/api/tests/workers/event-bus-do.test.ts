import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { EventBusIdentity } from '../../src/durable-objects/project-data/event-bus';
import { storeMcpToken } from '../../src/services/mcp-token';
import {
  seedAgentSession,
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

interface JsonRpcToolResponse {
  jsonrpc: '2.0';
  id: string;
  result?: {
    content?: Array<{ type: string; text: string }>;
  };
  error?: {
    code: number;
    message: string;
  };
}

interface SeededProjectGraph {
  userId: string;
  projectId: string;
  workspaceId: string;
  taskId: string;
  agentSessionId: string;
  sessionId: string;
}

const TEST_PREFIX = `event-bus-mcp-${Date.now()}`;

function getStub(projectId: string): DurableObjectStub<ProjectDataTestDouble> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  return env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectDataTestDouble>;
}

async function seedProjectGraph(suffix: string): Promise<SeededProjectGraph> {
  const userId = `${TEST_PREFIX}-${suffix}-user`;
  const installationId = `${TEST_PREFIX}-${suffix}-installation`;
  const projectId = `${TEST_PREFIX}-${suffix}-project`;
  const nodeId = `${TEST_PREFIX}-${suffix}-node`;
  const workspaceId = `${TEST_PREFIX}-${suffix}-workspace`;
  const taskId = `${TEST_PREFIX}-${suffix}-task`;
  const agentSessionId = `${TEST_PREFIX}-${suffix}-agent-session`;

  await seedUser(userId, { githubId: `${TEST_PREFIX}-${suffix}-gh` });
  await seedInstallation(installationId, userId, {
    installationIdValue: `${TEST_PREFIX}-${suffix}-external-installation`,
    accountName: `${TEST_PREFIX}-${suffix}-account`,
  });
  await seedProject(projectId, userId, installationId, {
    name: `${TEST_PREFIX}-${suffix} Project`,
    repository: `${TEST_PREFIX}/${suffix}`,
  });
  await seedNode(nodeId, userId);
  const projectData = getStub(projectId);
  await projectData.ensureProjectId(projectId);
  const sessionId = await projectData.createSession(
    workspaceId,
    'Event bus vertical session',
    taskId,
    userId
  );
  await seedWorkspace(workspaceId, nodeId, userId, { projectId, chatSessionId: sessionId });
  await seedTask(taskId, projectId, userId, {
    workspaceId,
    title: 'Event bus vertical task',
    status: 'in_progress',
  });
  await env.DATABASE.prepare(
    'UPDATE tasks SET chat_session_id = ? WHERE id = ? AND project_id = ?'
  )
    .bind(sessionId, taskId, projectId)
    .run();
  await seedAgentSession(agentSessionId, workspaceId, userId);

  return { userId, projectId, workspaceId, taskId, agentSessionId, sessionId };
}

async function storeToken(token: string, graph: SeededProjectGraph): Promise<void> {
  await storeMcpToken(env.KV, token, {
    taskId: graph.taskId,
    projectId: graph.projectId,
    userId: graph.userId,
    workspaceId: graph.workspaceId,
    chatSessionId: graph.sessionId,
    agentSessionId: graph.agentSessionId,
    createdAt: new Date().toISOString(),
  });
}

async function callMcpTool(
  token: string,
  name: string,
  args: Record<string, unknown>
): Promise<JsonRpcToolResponse> {
  const response = await SELF.fetch('https://api.test.example.com/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${name}-request`,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });

  expect(response.status).toBe(200);
  return response.json<JsonRpcToolResponse>();
}

function parseToolContent(response: JsonRpcToolResponse): Record<string, unknown> {
  expect(response.error).toBeUndefined();
  const content = response.result?.content;
  expect(content).toHaveLength(1);
  const text = content?.[0]?.text;
  expect(text).toBeDefined();
  return JSON.parse(text ?? '{}') as Record<string, unknown>;
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

  it('retrieves and acknowledges event deliveries through the real /mcp route', async () => {
    const graph = await seedProjectGraph('vertical');
    const token = `${TEST_PREFIX}-vertical-token`;
    await storeToken(token, graph);
    const stub = getStub(graph.projectId);

    await stub.createEventBusSubscription({
      id: `${graph.projectId}-subscription`,
      ownerType: 'task',
      ownerId: graph.taskId,
      targetTaskId: graph.taskId,
      targetSessionId: graph.sessionId,
      targetAgentSessionId: graph.agentSessionId,
      eventTypes: ['task.completed'],
      deliveryPolicy: 'ack_required',
    });
    await stub.publishEventBusEvent({
      id: `${graph.projectId}-event-1`,
      type: 'task.completed',
      source: 'orchestrator',
      subject: { type: 'task', id: `${graph.projectId}-child-task-1` },
      actor: { type: 'system', id: null },
      metadata: { reason: 'condition_met' },
      payload: { secret: 'vertical-payload-secret', output: 'done-1' },
    });
    await stub.publishEventBusEvent({
      id: `${graph.projectId}-event-2`,
      type: 'task.completed',
      source: 'orchestrator',
      subject: { type: 'task', id: `${graph.projectId}-child-task-2` },
      actor: { type: 'system', id: null },
      metadata: { reason: 'condition_met' },
      payload: { secret: 'vertical-payload-secret-2', output: 'done-2' },
    });

    const firstPage = await callMcpTool(token, 'list_subscription_events', {
      subscriptionId: `${graph.projectId}-subscription`,
      limit: 1,
    });
    const firstBody = parseToolContent(firstPage);
    const events = firstBody.events as Array<{
      id: string;
      delivery: { id: string; state: string; policy: string };
    }>;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: `${graph.projectId}-event-1`,
      delivery: { state: 'delivered', policy: 'ack_required' },
    });
    expect(firstBody.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(firstBody)).not.toContain('vertical-payload-secret');
    expect(JSON.stringify(firstBody)).not.toContain('"payload"');

    const secondPage = await callMcpTool(token, 'list_subscription_events', {
      subscriptionId: `${graph.projectId}-subscription`,
      cursor: firstBody.nextCursor,
      limit: 10,
    });
    const secondBody = parseToolContent(secondPage);
    expect((secondBody.events as Array<{ id: string }>).map((event) => event.id)).toEqual([
      `${graph.projectId}-event-2`,
    ]);

    const fetched = await callMcpTool(token, 'get_event', {
      eventId: `${graph.projectId}-event-1`,
    });
    const fetchedBody = parseToolContent(fetched);
    expect(fetchedBody.event).toMatchObject({
      id: `${graph.projectId}-event-1`,
      payload: { secret: 'vertical-payload-secret', output: 'done-1' },
    });

    const ack = await callMcpTool(token, 'ack_event_delivery', {
      deliveryId: events[0]!.delivery.id,
    });
    expect(parseToolContent(ack)).toMatchObject({
      acknowledged: true,
      idempotent: false,
      delivery: { state: 'acknowledged', eventId: `${graph.projectId}-event-1` },
    });

    const duplicateAck = await callMcpTool(token, 'ack_event_delivery', {
      deliveryId: events[0]!.delivery.id,
    });
    expect(parseToolContent(duplicateAck)).toMatchObject({
      acknowledged: true,
      idempotent: true,
      delivery: { state: 'acknowledged', eventId: `${graph.projectId}-event-1` },
    });
  });

  it('does not disclose cross-project events and rejects stale token identity through /mcp', async () => {
    const owner = await seedProjectGraph('owner');
    const caller = await seedProjectGraph('caller');
    const ownerStub = getStub(owner.projectId);

    await ownerStub.createEventBusSubscription({
      id: `${owner.projectId}-subscription`,
      ownerType: 'task',
      ownerId: owner.taskId,
      targetTaskId: owner.taskId,
      eventTypes: ['task.completed'],
      deliveryPolicy: 'ack_required',
    });
    await ownerStub.publishEventBusEvent({
      id: `${owner.projectId}-secret-event`,
      type: 'task.completed',
      source: 'orchestrator',
      subject: { type: 'task', id: `${owner.projectId}-child-task` },
      actor: { type: 'system', id: null },
      metadata: { reason: 'secret-metadata' },
      payload: { secret: 'cross-project-secret' },
    });

    const callerToken = `${TEST_PREFIX}-caller-token`;
    await storeToken(callerToken, caller);
    const crossProject = await callMcpTool(callerToken, 'get_event', {
      eventId: `${owner.projectId}-secret-event`,
    });

    expect(crossProject.error?.message).toBe('Event not found or not visible to this agent');
    expect(JSON.stringify(crossProject)).not.toContain('cross-project-secret');
    expect(JSON.stringify(crossProject)).not.toContain(`${owner.projectId}-secret-event`);

    const staleToken = `${TEST_PREFIX}-stale-token`;
    await storeMcpToken(env.KV, staleToken, {
      taskId: owner.taskId,
      projectId: caller.projectId,
      userId: caller.userId,
      workspaceId: owner.workspaceId,
      chatSessionId: owner.sessionId,
      agentSessionId: owner.agentSessionId,
      createdAt: new Date().toISOString(),
    });
    const staleIdentity = await callMcpTool(staleToken, 'get_event', {
      eventId: `${owner.projectId}-secret-event`,
    });

    expect(staleIdentity.error?.message).toBe('Caller identity is not valid for this project');
    expect(JSON.stringify(staleIdentity)).not.toContain('cross-project-secret');
  });

  it('maps malformed opaque cursors through /mcp without leaking payload data', async () => {
    const graph = await seedProjectGraph('errors');
    const token = `${TEST_PREFIX}-errors-token`;
    await storeToken(token, graph);
    const stub = getStub(graph.projectId);

    await stub.createEventBusSubscription({
      id: `${graph.projectId}-subscription`,
      ownerType: 'task',
      ownerId: graph.taskId,
      targetTaskId: graph.taskId,
      eventTypes: ['task.completed'],
      deliveryPolicy: 'ack_required',
    });
    await stub.publishEventBusEvent({
      id: `${graph.projectId}-event`,
      type: 'task.completed',
      source: 'orchestrator',
      subject: { type: 'task', id: `${graph.projectId}-child-task` },
      actor: { type: 'system', id: null },
      metadata: { reason: 'condition_met' },
      payload: { secret: 'error-path-secret' },
    });

    const cursorError = await callMcpTool(token, 'list_subscription_events', {
      subscriptionId: `${graph.projectId}-subscription`,
      cursor: btoa('null').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''),
    });
    expect(cursorError.error?.message).toBe('Invalid cursor');
    expect(JSON.stringify(cursorError)).not.toContain('error-path-secret');
  });
});
