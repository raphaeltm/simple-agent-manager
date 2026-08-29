import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

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

const TEST_PREFIX = `project-event-mcp-${Date.now()}`;

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
    'Project event MCP vertical session',
    taskId,
    userId
  );
  await seedWorkspace(workspaceId, nodeId, userId, { projectId, chatSessionId: sessionId });
  await seedTask(taskId, projectId, userId, {
    workspaceId,
    title: 'Project event MCP vertical task',
    status: 'in_progress',
  });
  await env.DATABASE.prepare('UPDATE tasks SET chat_session_id = ? WHERE id = ? AND project_id = ?')
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

async function createSubscriptionAndEvents(graph: SeededProjectGraph): Promise<string> {
  const stub = getStub(graph.projectId);
  const created = await stub.createProjectEventSubscription({
    projectId: graph.projectId,
    owner: { type: 'agent', id: graph.agentSessionId, name: graph.agentSessionId },
    idempotencyKey: `${graph.projectId}-subscription`,
    filter: { version: 1, source: 'github', eventType: 'check_suite.completed' },
    deliveryPreference: {
      requested: 'existing_session_prompt',
      resolved: 'recorded_not_injected',
      target: {
        sessionId: graph.sessionId,
        taskId: graph.taskId,
        runtimeId: null,
        agentId: graph.agentSessionId,
      },
    },
    expiresAt: Date.now() + 60_000,
  });
  for (const index of [1, 2]) {
    await stub.admitProjectEvent({
      projectId: graph.projectId,
      source: 'github',
      eventType: 'check_suite.completed',
      subject: { type: 'pull_request', id: `${graph.projectId}-pr-${index}` },
      severity: 'warning',
      deliveryKey: `${graph.projectId}-delivery-${index}`,
      payloadFingerprint: `sha256:${graph.projectId}-${index}`,
      metadata: { conclusion: 'failure', index },
      display: { title: `CI failed ${index}`, summary: `Failure ${index}` },
      rawPayloadRef: {
        provider: 'r2',
        uri: `r2://${graph.projectId}-vertical-payload-secret-${index}`,
        contentHash: `sha256:${graph.projectId}-payload-${index}`,
      },
      occurredAt: Date.now() + index,
      receivedAt: Date.now() + index,
    });
  }
  return created.subscription.id;
}

describe('ProjectData event MCP tools vertical route', () => {
  it('lists, fetches, and acknowledges visible canonical ProjectData event deliveries', async () => {
    const graph = await seedProjectGraph('vertical');
    const token = `${TEST_PREFIX}-vertical-token`;
    await storeToken(token, graph);
    const subscriptionId = await createSubscriptionAndEvents(graph);

    const firstPage = await callMcpTool(token, 'list_subscription_events', {
      subscriptionId,
      limit: 1,
    });
    const firstBody = parseToolContent(firstPage);
    const events = firstBody.events as Array<{
      id: string;
      delivery: { id: string; state: string; ackRequired: boolean };
    }>;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      delivery: { state: 'delivered', ackRequired: true },
    });
    expect(firstBody.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(firstBody)).not.toContain('vertical-payload-secret');
    expect(JSON.stringify(firstBody)).not.toContain('rawPayloadRef');

    const secondPage = await callMcpTool(token, 'list_subscription_events', {
      subscriptionId,
      cursor: firstBody.nextCursor,
      limit: 10,
    });
    const secondBody = parseToolContent(secondPage);
    expect((secondBody.events as Array<{ id: string }>).map((event) => event.id)).toHaveLength(1);

    const fetched = await callMcpTool(token, 'get_event', {
      eventId: events[0]!.id,
    });
    const fetchedBody = parseToolContent(fetched);
    expect(fetchedBody.event).toMatchObject({
      id: events[0]!.id,
      rawPayloadRef: { uri: expect.stringContaining('vertical-payload-secret') },
      delivery: { state: 'delivered', ackRequired: true },
    });

    const ack = await callMcpTool(token, 'ack_event_delivery', {
      deliveryId: events[0]!.delivery.id,
    });
    expect(parseToolContent(ack)).toMatchObject({
      acknowledged: true,
      idempotent: false,
      delivery: { state: 'acked', eventId: events[0]!.id },
    });

    const duplicateAck = await callMcpTool(token, 'ack_event_delivery', {
      deliveryId: events[0]!.delivery.id,
    });
    expect(parseToolContent(duplicateAck)).toMatchObject({
      acknowledged: true,
      idempotent: true,
      delivery: { state: 'acked', eventId: events[0]!.id },
    });
  });

  it('does not disclose cross-project events and rejects stale token identity through /mcp', async () => {
    const owner = await seedProjectGraph('owner');
    const caller = await seedProjectGraph('caller');
    const ownerToken = `${TEST_PREFIX}-owner-token`;
    const callerToken = `${TEST_PREFIX}-caller-token`;
    await storeToken(ownerToken, owner);
    await storeToken(callerToken, caller);
    const ownerSubscriptionId = await createSubscriptionAndEvents(owner);

    const ownerList = parseToolContent(
      await callMcpTool(ownerToken, 'list_subscription_events', {
        subscriptionId: ownerSubscriptionId,
        limit: 1,
      })
    );
    const ownerEventId = (ownerList.events as Array<{ id: string }>)[0]?.id ?? '';

    const crossProject = await callMcpTool(callerToken, 'get_event', {
      eventId: ownerEventId,
    });
    expect(crossProject.error?.message).toBe('Event not found or not visible to this agent');
    expect(JSON.stringify(crossProject)).not.toContain(ownerEventId);
    expect(JSON.stringify(crossProject)).not.toContain('vertical-payload-secret');

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
      eventId: ownerEventId,
    });
    expect(staleIdentity.error?.message).toBe('Caller identity is not valid for this project');
  });

  it('maps malformed opaque cursors through /mcp without leaking stored event data', async () => {
    const graph = await seedProjectGraph('cursor-errors');
    const token = `${TEST_PREFIX}-cursor-token`;
    await storeToken(token, graph);
    const subscriptionId = await createSubscriptionAndEvents(graph);

    const cursorError = await callMcpTool(token, 'list_subscription_events', {
      subscriptionId,
      cursor: btoa('null').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, ''),
    });

    expect(cursorError.error?.message).toBe('Invalid cursor');
    expect(JSON.stringify(cursorError)).not.toContain('vertical-payload-secret');
  });
});
