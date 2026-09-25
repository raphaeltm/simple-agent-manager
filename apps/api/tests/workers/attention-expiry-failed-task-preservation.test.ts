/**
 * Failed-task work preservation from a real ProjectData Durable Object alarm
 * (idea 01M1XGHX7NQZQYWQRV5C1PJ60N). An expired SAM check-in fails the task; the
 * preservation decision then either queues a snapshot-backed sleep or, when
 * nothing can be preserved, says so in the chat before failing the session.
 *
 * The notice is written through `projectDataService.persistMessage` — an RPC from
 * inside this object's own alarm back into itself. Unit tests mock that boundary,
 * so this runs it at Workers-runtime fidelity (real D1, real Durable Object).
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';
import type { Env } from '../../src/env';
import {
  failedTaskNoticeId,
  failedTaskWorkLossMessage,
} from '../../src/services/failed-task-preservation';
import {
  seedAgentSession,
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const originalFetch = globalThis.fetch;
const mutableEnv = env as unknown as Env & Record<string, string | undefined>;
let previousCleanupDelay: string | undefined;

beforeEach(() => {
  // The teardown runs off the alarm's critical path; with no delay it finishes
  // inside the test instead of outliving it.
  previousCleanupDelay = mutableEnv.TASK_RUN_CLEANUP_DELAY_MS;
  mutableEnv.TASK_RUN_CLEANUP_DELAY_MS = '0';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('.vm.test.example.com')) return new Response(null, { status: 204 });
      return originalFetch(input);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousCleanupDelay === undefined) delete mutableEnv.TASK_RUN_CLEANUP_DELAY_MS;
  else mutableEnv.TASK_RUN_CLEANUP_DELAY_MS = previousCleanupDelay;
});

function projectStub(projectId: string): DurableObjectStub<ProjectData> {
  return env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectData>;
}

async function seedExpiredCheckIn(agentSessionStatus: string) {
  const prefix = `attn-preserve-${crypto.randomUUID()}`;
  const userId = `${prefix}-user`;
  const installationId = `${prefix}-install`;
  const projectId = `${prefix}-project`;
  const nodeId = `${prefix}-node`;
  const workspaceId = `${prefix}-workspace`;
  const taskId = `${prefix}-task`;

  await seedUser(userId);
  await seedInstallation(installationId, userId, { installationIdValue: `${prefix}-ext` });
  await seedProject(projectId, userId, installationId);
  await seedNode(nodeId, userId, { status: 'running' });
  const stub = projectStub(projectId);
  await stub.ensureProjectId(projectId);
  const chatSessionId = await stub.createSession(null, 'Failed task preservation');
  await seedWorkspace(workspaceId, nodeId, userId, {
    projectId,
    status: 'running',
    chatSessionId,
  });
  await seedAgentSession(`${prefix}-agent`, workspaceId, userId, { status: agentSessionStatus });
  await seedTask(taskId, projectId, userId, {
    status: 'in_progress',
    workspaceId,
    chatSessionId,
    executionStep: 'running',
  });
  await stub.createAttentionMarker({
    sessionId: chatSessionId,
    taskId,
    workspaceId,
    kind: 'reconciliation_checkin',
    source: 'sam_orchestrator',
    reason: 'Agent idle — SAM check-in sent',
    expiresAt: Date.now() - 1_000,
  });
  return { stub, projectId, chatSessionId, taskId, workspaceId };
}

async function runAlarm(stub: DurableObjectStub<ProjectData>): Promise<void> {
  await runInDurableObject(stub, async (instance, state) => {
    await instance.alarm();
    await state.storage.deleteAlarm();
  });
}

async function taskRow(taskId: string) {
  return env.DATABASE.prepare('SELECT status, error_message FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ status: string; error_message: string | null }>();
}

async function workspaceStatus(workspaceId: string) {
  return (
    await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
      .bind(workspaceId)
      .first<{ status: string }>()
  )?.status;
}

async function systemMessages(stub: DurableObjectStub<ProjectData>, chatSessionId: string) {
  const { messages } = await stub.getMessages(chatSessionId);
  return messages.filter((message) => message.role === 'system');
}

describe('attention expiry from a real ProjectData alarm', () => {
  it('says the work was not preserved, through its own RPC, before failing the session', async () => {
    // The agent session already ended, so there is nothing to snapshot.
    const { stub, chatSessionId, taskId, workspaceId } = await seedExpiredCheckIn('failed');

    await runAlarm(stub);

    expect(await taskRow(taskId)).toEqual({
      status: 'failed',
      error_message: 'Agent became unresponsive after SAM check-in',
    });
    expect(await systemMessages(stub, chatSessionId)).toEqual([
      expect.objectContaining({
        id: failedTaskNoticeId('work-loss', taskId, chatSessionId),
        content: failedTaskWorkLossMessage('no_resumable_agent_session'),
      }),
    ]);
    expect((await stub.getSession(chatSessionId))?.status).toBe('failed');
    // The teardown runs after the alarm and still completes.
    await vi.waitFor(async () => expect(await workspaceStatus(workspaceId)).toBe('stopped'), {
      timeout: 5_000,
    });
  });

  it('queues a snapshot-backed sleep and leaves the conversation open when the runtime is live', async () => {
    const { stub, chatSessionId, taskId, workspaceId } = await seedExpiredCheckIn('running');

    await runAlarm(stub);

    expect((await taskRow(taskId))?.status).toBe('failed');
    expect(
      await env.DATABASE.prepare(
        'SELECT status, sleep_status FROM session_snapshots WHERE chat_session_id = ?'
      )
        .bind(chatSessionId)
        .first()
    ).toEqual({ status: 'pending', sleep_status: 'scheduled' });
    expect((await stub.getSession(chatSessionId))?.status).toBe('active');
    expect(await systemMessages(stub, chatSessionId)).toEqual([]);
    expect(await workspaceStatus(workspaceId)).toBe('running');
  });
});
