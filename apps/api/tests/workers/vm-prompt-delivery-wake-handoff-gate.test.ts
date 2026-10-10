/**
 * The delivery target's wake-handoff gate, against real D1 rows (rule 28: a guard that is a
 * SQL read is tested on a real SQL engine). Each conjunct of `isVmWakeHandoffPending` has a
 * case that discriminates it: the claim status, the recovery workspace, the claiming task's
 * status and the runtime. The real-ordering wake test is
 * `vm-wake-event-delivery-handoff.test.ts`.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { resolveVmPromptDeliveryTarget } from '../../src/services/vm-prompt-delivery-target';
import {
  seedAgentSession,
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

interface GateCase {
  name: string;
  runtime: 'vm' | 'cf-container';
  /** Null means the conversation has never slept, so it has no snapshot row. */
  recoveryStatus: 'waking' | 'restored' | 'failed' | null;
  recoveryWorkspace: 'target' | 'older' | null;
  taskStatus: string;
  held: boolean;
}

const CASES: GateCase[] = [
  {
    name: 'claimed wake whose task is queued',
    runtime: 'vm',
    recoveryStatus: 'waking',
    recoveryWorkspace: null,
    taskStatus: 'queued',
    held: true,
  },
  {
    name: 'claimed wake delegated to this workspace',
    runtime: 'vm',
    recoveryStatus: 'waking',
    recoveryWorkspace: 'target',
    taskStatus: 'delegated',
    held: true,
  },
  {
    name: 'restored snapshot before the handoff commits',
    runtime: 'vm',
    recoveryStatus: 'restored',
    recoveryWorkspace: 'target',
    taskStatus: 'delegated',
    held: true,
  },
  {
    name: 'committed handoff',
    runtime: 'vm',
    recoveryStatus: 'restored',
    recoveryWorkspace: 'target',
    taskStatus: 'in_progress',
    held: false,
  },
  {
    name: 'restore left by an older wake on another workspace',
    runtime: 'vm',
    recoveryStatus: 'restored',
    recoveryWorkspace: 'older',
    taskStatus: 'delegated',
    held: false,
  },
  {
    name: 'claim whose task already returned to sleep',
    runtime: 'vm',
    recoveryStatus: 'waking',
    recoveryWorkspace: 'target',
    taskStatus: 'sleeping',
    held: false,
  },
  {
    name: 'failed wake claim',
    runtime: 'vm',
    recoveryStatus: 'failed',
    recoveryWorkspace: 'target',
    taskStatus: 'delegated',
    held: false,
  },
  {
    name: 'conversation that never slept',
    runtime: 'vm',
    recoveryStatus: null,
    recoveryWorkspace: null,
    taskStatus: 'delegated',
    held: false,
  },
  {
    name: 'Instant runtime woken in place',
    runtime: 'cf-container',
    recoveryStatus: 'restored',
    recoveryWorkspace: 'target',
    taskStatus: 'queued',
    held: false,
  },
];

async function seedDeliveryTarget(testCase: GateCase) {
  const prefix = crypto.randomUUID();
  const userId = `${prefix}-user`;
  const projectId = `${prefix}-project`;
  const nodeId = `${prefix}-node`;
  const workspaceId = `${prefix}-workspace`;
  const olderWorkspaceId = `${prefix}-older-workspace`;
  const taskId = `${prefix}-task`;
  const chatSessionId = `${prefix}-chat`;
  await seedUser(userId);
  await seedInstallation(`${prefix}-installation`, userId);
  await seedProject(projectId, userId, `${prefix}-installation`);
  await seedNode(nodeId, userId);
  await env.DATABASE.prepare('UPDATE nodes SET runtime = ? WHERE id = ?')
    .bind(testCase.runtime, nodeId)
    .run();
  await seedWorkspace(olderWorkspaceId, nodeId, userId, { projectId, status: 'deleted' });
  await seedWorkspace(workspaceId, nodeId, userId, {
    projectId,
    chatSessionId,
    status: 'running',
  });
  await seedAgentSession(`${prefix}-agent`, workspaceId, userId);
  await seedTask(taskId, projectId, userId, {
    status: testCase.taskStatus,
    chatSessionId,
    workspaceId,
  });
  if (testCase.recoveryStatus) {
    const recoveryWorkspaceId =
      testCase.recoveryWorkspace === 'target'
        ? workspaceId
        : testCase.recoveryWorkspace === 'older'
          ? olderWorkspaceId
          : null;
    await env.DATABASE.prepare(
      `INSERT INTO session_snapshots
         (id, project_id, workspace_id, user_id, chat_session_id, runtime, status, degradation,
          manifest_r2_key, expires_at, recovery_status, recovery_task_id, recovery_attempt_id,
          recovery_workspace_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'available', 'none', 'manifest', '2099-01-01T00:00:00Z',
               ?, ?, 'wake-1', ?, datetime('now'), datetime('now'))`
    )
      .bind(
        `${prefix}-snapshot`,
        projectId,
        olderWorkspaceId,
        userId,
        chatSessionId,
        testCase.runtime,
        testCase.recoveryStatus,
        taskId,
        recoveryWorkspaceId
      )
      .run();
  }
  return { projectId, chatSessionId, workspaceId, taskId };
}

describe('delivery target during a VM wake handoff', () => {
  it.each(CASES)('$name: held=$held', async (testCase) => {
    const target = await seedDeliveryTarget(testCase);
    const resolution = await resolveVmPromptDeliveryTarget(
      env as unknown as Env,
      target.projectId,
      target.chatSessionId,
      undefined,
      async () => null
    );
    if (testCase.held) {
      expect(resolution).toEqual({
        kind: 'retry',
        reason: `Session is waking (${target.taskId}); agent handoff not committed`,
      });
    } else {
      // Liveness: a released target resolves to this exact runtime, not merely "not held".
      expect(resolution).toMatchObject({
        kind: 'ready',
        target: { workspaceId: target.workspaceId, runtime: testCase.runtime },
      });
    }
  });
});
