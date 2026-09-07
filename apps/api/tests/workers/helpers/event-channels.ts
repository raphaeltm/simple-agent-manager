import { env, SELF } from 'cloudflare:test';
import { expect } from 'vitest';

import type { Env } from '../../../src/env';
import { storeMcpToken } from '../../../src/services/mcp-token';
import * as service from '../../../src/services/project-data';
import type { ProjectDataTestDouble } from '../support/expected-error-doubles';
import {
  seedAgentSession,
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './seed-d1';
const testEnv = env as unknown as Env;

export async function fixture() {
  const id = crypto.randomUUID();
  const projectId = `p-${id}`,
    userId = `u-${id}`,
    taskId = `t-${id}`,
    workspaceId = `w-${id}`;
  const nodeId = `n-${id}`,
    agentSessionId = `a-${id}`;
  await seedUser(userId);
  await seedInstallation(id, userId, { installationIdValue: id, accountName: userId });
  await seedProject(projectId, userId, id);
  await seedNode(nodeId, userId);
  const stub = env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectDataTestDouble>;
  await stub.ensureProjectId(projectId);
  const sessionId = await stub.createSession(workspaceId, 'Channels test', taskId, userId);
  await seedWorkspace(workspaceId, nodeId, userId, { projectId, chatSessionId: sessionId });
  await seedTask(taskId, projectId, userId, {
    workspaceId,
    chatSessionId: sessionId,
    status: 'in_progress',
  });
  await seedAgentSession(agentSessionId, workspaceId, userId);
  const token = crypto.randomUUID();
  await storeMcpToken(env.KV, token, {
    projectId,
    userId,
    taskId,
    workspaceId,
    agentSessionId,
    chatSessionId: sessionId,
    createdAt: new Date().toISOString(),
  });
  const actor = { userId, taskId, workspaceId, chatSessionId: sessionId, agentSessionId };
  const publish = (key: string, channel = 'builds', message = `message ${key}`) =>
    service.publishProjectEventChannel(testEnv, projectId, {
      actor,
      channel,
      idempotencyKey: key,
      message,
    });
  const tool = async (name: string, args: Record<string, unknown>) => {
    const response = await SELF.fetch('https://api.test.example.com/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'test',
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    expect(response.status).toBe(200);
    return response.json<{
      error?: { message: string };
      result?: { content: Array<{ text: string }> };
    }>();
  };
  return {
    projectId,
    userId,
    taskId,
    workspaceId,
    sessionId,
    agentSessionId,
    stub,
    publish,
    tool,
    actor,
    token,
  };
}

export function body<T>(reply: {
  error?: unknown;
  result?: { content: Array<{ text: string }> };
}): T {
  expect(reply.error).toBeUndefined();
  return JSON.parse(reply.result!.content[0]!.text).result as T;
}
