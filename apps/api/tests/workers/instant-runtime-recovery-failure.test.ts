import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  persistRuntimeRecoveryFailed,
  RUNTIME_RECOVERY_DEGRADED_MESSAGE,
} from '../../src/durable-objects/vm-agent-container-recovery';
import type { Env } from '../../src/env';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

describe('Instant runtime terminal reconciliation with Miniflare D1', () => {
  it('fails every related runtime row and the active task after recovery exhaustion', async () => {
    const prefix = `runtime-failure-${Date.now()}-${crypto.randomUUID()}`;
    const userId = `${prefix}-user`;
    const installationId = `${prefix}-installation`;
    const projectId = `${prefix}-project`;
    const nodeId = `${prefix}-node`;
    const workspaceId = `${prefix}-workspace`;
    const chatSessionId = `${prefix}-chat`;
    const agentSessionId = `${prefix}-agent`;
    const taskId = `${prefix}-task`;

    await seedUser(userId);
    await seedInstallation(installationId, userId, {
      installationIdValue: `${prefix}-external`,
    });
    await seedProject(projectId, userId, installationId);
    await seedNode(nodeId, userId, { status: 'recovery', healthStatus: 'unhealthy' });
    await env.DATABASE.prepare(`UPDATE nodes SET runtime = 'cf-container' WHERE id = ?`)
      .bind(nodeId)
      .run();
    await seedWorkspace(workspaceId, nodeId, userId, {
      projectId,
      status: 'recovery',
      chatSessionId,
    });
    await env.DATABASE.prepare(
      `INSERT INTO agent_sessions
         (id, workspace_id, user_id, status, agent_type, created_at, updated_at)
       VALUES (?, ?, ?, 'recovery', 'codex', datetime('now'), datetime('now'))`
    )
      .bind(agentSessionId, workspaceId, userId)
      .run();
    await seedTask(taskId, projectId, userId, {
      status: 'in_progress',
      workspaceId,
      autoProvisionedNodeId: nodeId,
      executionStep: 'agent_running',
    });

    await persistRuntimeRecoveryFailed(env as unknown as Env, {
      nodeId,
      workspaceId,
      projectId,
      chatSessionId,
      agentSessionId,
    });

    const node = await env.DATABASE.prepare(
      `SELECT status, health_status, error_message FROM nodes WHERE id = ?`
    )
      .bind(nodeId)
      .first<Record<string, string>>();
    const workspace = await env.DATABASE.prepare(
      `SELECT status, error_message FROM workspaces WHERE id = ?`
    )
      .bind(workspaceId)
      .first<Record<string, string>>();
    const agent = await env.DATABASE.prepare(
      `SELECT status, stopped_at, error_message FROM agent_sessions WHERE id = ?`
    )
      .bind(agentSessionId)
      .first<Record<string, string>>();
    const task = await env.DATABASE.prepare(
      `SELECT status, execution_step, error_message FROM tasks WHERE id = ?`
    )
      .bind(taskId)
      .first<Record<string, string | null>>();
    const event = await env.DATABASE.prepare(
      `SELECT from_status, to_status, actor_type, reason
       FROM task_status_events WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`
    )
      .bind(taskId)
      .first<Record<string, string>>();

    expect(node).toEqual({
      status: 'error',
      health_status: 'unhealthy',
      error_message: RUNTIME_RECOVERY_DEGRADED_MESSAGE,
    });
    expect(workspace).toEqual({
      status: 'error',
      error_message: RUNTIME_RECOVERY_DEGRADED_MESSAGE,
    });
    expect(agent).toMatchObject({
      status: 'error',
      error_message: RUNTIME_RECOVERY_DEGRADED_MESSAGE,
    });
    expect(agent?.stopped_at).toEqual(expect.any(String));
    expect(task).toEqual({
      status: 'failed',
      execution_step: null,
      error_message: RUNTIME_RECOVERY_DEGRADED_MESSAGE,
    });
    expect(event).toEqual({
      from_status: 'in_progress',
      to_status: 'failed',
      actor_type: 'system',
      reason: 'Instant runtime recovery exhausted',
    });
  });
});
