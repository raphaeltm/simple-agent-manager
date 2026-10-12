/**
 * MCP task tools record their activity events in the real ProjectData Durable Object.
 *
 * These events used to be POSTed to `https://do/activity`, which ProjectData.fetch never served
 * (it answers only `/ws`). Nobody checked the 404, so every `task.progress`,
 * `task.awaiting_followup`, `task.completed` and `task.dispatched` event was dropped. The
 * `update_task_status` and `complete_task` calls here go through the real `/mcp` route with a real
 * MCP token, and the rows are read back from the Durable Object (`.claude/rules/62`).
 *
 * `dispatch_task` cannot run end to end in this pool (its TaskRunner start provisions real
 * infrastructure), so the dispatch case calls the helper the tool calls. That the tool reaches the
 * helper is asserted in the dispatch happy-path test in tests/unit/routes/mcp.test.ts.
 *
 * Each event must carry the chat session id: the event-log cleanup reclaims activity rows only
 * by joining them to their chat session.
 */
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { recordDispatchActivityEvent } from '../../src/routes/mcp/dispatch-activity';
import { type McpTokenData, storeMcpToken } from '../../src/services/mcp-token';
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

const testEnv = env as unknown as Env;
const TEST_PREFIX = `mcp-activity-${Date.now()}`;

interface ActivityEvent {
  eventType: string;
  actorType: string;
  actorId: string | null;
  workspaceId: string | null;
  sessionId: string | null;
  taskId: string | null;
  payload: Record<string, unknown> | null;
}

interface SeededTask {
  token: string;
  tokenData: McpTokenData;
  projectData: DurableObjectStub<ProjectDataTestDouble>;
}

async function seedTaskAgent(
  suffix: string,
  taskMode: 'task' | 'conversation'
): Promise<SeededTask> {
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
  });
  await seedProject(projectId, userId, installationId);
  await seedNode(nodeId, userId);

  const projectData = testEnv.PROJECT_DATA.get(
    testEnv.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectDataTestDouble>;
  await projectData.ensureProjectId(projectId);
  const chatSessionId = await projectData.createSession(
    workspaceId,
    'Activity events session',
    taskId,
    userId
  );
  await seedWorkspace(workspaceId, nodeId, userId, { projectId, chatSessionId });
  // No task -> workspace link: task-mode completion then has no runtime to tear down here.
  await seedTask(taskId, projectId, userId, {
    title: 'Activity events task',
    status: 'in_progress',
    taskMode,
    chatSessionId,
  });
  await seedAgentSession(agentSessionId, workspaceId, userId);

  const tokenData: McpTokenData = {
    taskId,
    taskMode,
    projectId,
    userId,
    workspaceId,
    chatSessionId,
    agentSessionId,
    createdAt: new Date().toISOString(),
  };
  const token = `${TEST_PREFIX}-${suffix}-mcp-token`;
  await storeMcpToken(testEnv.KV, token, tokenData);
  return { token, tokenData, projectData };
}

async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await SELF.fetch(`https://api.${testEnv.BASE_DOMAIN}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${name}-request`,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  expect(response.status).toBe(200);
  const body = await response.json<Record<string, unknown>>();
  expect(body.error).toBeUndefined();
  return body;
}

async function activityEvents(seeded: SeededTask, eventType: string): Promise<ActivityEvent[]> {
  const { events } = await seeded.projectData.listActivityEvents(eventType, 50, null, null);
  return events as unknown as ActivityEvent[];
}

describe('MCP task tools write activity events to ProjectData', () => {
  it('records task.progress for a task-backed update_task_status', async () => {
    const seeded = await seedTaskAgent('progress', 'task');

    await callTool(seeded.token, 'update_task_status', { message: 'Wrote the failing test' });

    const events = await activityEvents(seeded, 'task.progress');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'task.progress',
      actorType: 'agent',
      actorId: seeded.tokenData.agentSessionId,
      workspaceId: seeded.tokenData.workspaceId,
      sessionId: seeded.tokenData.chatSessionId,
      taskId: seeded.tokenData.taskId,
      payload: { message: 'Wrote the failing test' },
    });
  });

  it.each([
    {
      taskMode: 'conversation' as const,
      eventType: 'task.awaiting_followup',
      summary: 'Answered the question',
    },
    { taskMode: 'task' as const, eventType: 'task.completed', summary: 'Shipped the fix' },
  ])(
    'records $eventType when a $taskMode-mode task calls complete_task',
    async ({ taskMode, eventType, summary }) => {
      const seeded = await seedTaskAgent(taskMode, taskMode);

      await callTool(seeded.token, 'complete_task', { summary });

      const events = await activityEvents(seeded, eventType);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorType: 'agent',
        actorId: seeded.tokenData.agentSessionId,
        taskId: seeded.tokenData.taskId,
        sessionId: seeded.tokenData.chatSessionId,
        payload: { summary },
      });
    }
  );

  it('records task.dispatched for the child task in the dispatching session', async () => {
    const seeded = await seedTaskAgent('dispatch', 'task');
    const childTaskId = `${TEST_PREFIX}-dispatch-child-task`;

    await recordDispatchActivityEvent({
      env: testEnv,
      tokenData: seeded.tokenData,
      taskId: childTaskId,
      newDepth: 1,
      taskTitle: 'Child task',
      branchName: 'sam/child-task',
      executionRuntime: 'vm',
      runtimeReason: 'default',
      taskMode: 'task',
    });

    const events = await activityEvents(seeded, 'task.dispatched');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: 'agent',
      actorId: seeded.tokenData.agentSessionId,
      sessionId: seeded.tokenData.chatSessionId,
      taskId: childTaskId,
      payload: {
        parentTaskId: seeded.tokenData.taskId,
        dispatchDepth: 1,
        title: 'Child task',
        branchName: 'sam/child-task',
      },
    });
  });
});
