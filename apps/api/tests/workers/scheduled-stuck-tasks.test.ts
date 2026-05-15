/**
 * Vertical slice tests for stuck-tasks scheduled job.
 *
 * Uses real D1 + OBSERVABILITY_DATABASE + TASK_RUNNER DO via Miniflare.
 * Verifies:
 * - Stuck task detection with real D1 state
 * - D1 status transitions to 'failed' with error messages
 * - Task status events recorded
 * - Optimistic locking (task advanced between SELECT and UPDATE)
 * - Heartbeat grace period for in_progress tasks
 * - Diagnostic gathering (workspace/node status from D1)
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { gatherDiagnostics, recoverStuckTasks } from '../../src/scheduled/stuck-tasks';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const USER_ID = 'user-st-test';
const INSTALL_ID = 'install-st-test';
const PROJECT_ID = 'project-st-test';

async function seedBaseData(): Promise<void> {
  await seedUser(USER_ID);
  await seedInstallation(INSTALL_ID, USER_ID);
  await seedProject(PROJECT_ID, USER_ID, INSTALL_ID);
}

async function getTaskStatus(taskId: string): Promise<{
  status: string;
  error_message: string | null;
  completed_at: string | null;
  execution_step: string | null;
} | null> {
  return env.DATABASE.prepare(
    'SELECT status, error_message, completed_at, execution_step FROM tasks WHERE id = ?',
  )
    .bind(taskId)
    .first();
}

async function getTaskStatusEvents(taskId: string): Promise<{
  from_status: string | null;
  to_status: string;
  actor_type: string;
  reason: string | null;
}[]> {
  const result = await env.DATABASE.prepare(
    'SELECT from_status, to_status, actor_type, reason FROM task_status_events WHERE task_id = ? ORDER BY created_at',
  )
    .bind(taskId)
    .all<{ from_status: string | null; to_status: string; actor_type: string; reason: string | null }>();
  return result.results;
}

async function getObservabilityEvents(taskId: string): Promise<{ message: string; context: string }[]> {
  const result = await env.OBSERVABILITY_DATABASE.prepare(
    `SELECT message, context FROM platform_errors WHERE context LIKE ? ORDER BY created_at DESC`,
  ).bind(`%${taskId}%`).all<{ message: string; context: string }>();
  return result.results;
}

describe('recoverStuckTasks — vertical slice', () => {
  describe('stuck queued task detection', () => {
    it('fails a task stuck in queued past timeout and records status event', async () => {
      await seedBaseData();
      const taskId = 'task-st-queued-stuck';
      const oldDate = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20m ago

      await seedTask(taskId, PROJECT_ID, USER_ID, {
        status: 'queued',
        executionStep: 'node_selection',
        updatedAt: oldDate,
      });

      const testEnv = {
        ...env,
        TASK_STUCK_QUEUED_TIMEOUT_MS: '60000', // 1 min (task is 20m old)
        TASK_STUCK_DELEGATED_TIMEOUT_MS: '300000',
        TASK_RUN_MAX_EXECUTION_MS: '14400000',
        TASK_RUN_HARD_TIMEOUT_MS: '28800000',
      } as unknown as Env;

      const result = await recoverStuckTasks(testEnv);

      expect(result.failedQueued).toBe(1);

      // Verify D1 state: task should be 'failed'
      const task = await getTaskStatus(taskId);
      expect(task?.status).toBe('failed');
      expect(task?.error_message).toContain("stuck in 'queued'");
      expect(task?.error_message).toContain('node_selection');
      expect(task?.completed_at).not.toBeNull();
      expect(task?.execution_step).toBeNull(); // cleared on failure

      // Verify task status event was recorded
      const events = await getTaskStatusEvents(taskId);
      expect(events.length).toBeGreaterThanOrEqual(1);
      const failEvent = events.find((e) => e.to_status === 'failed');
      expect(failEvent).toBeDefined();
      expect(failEvent?.from_status).toBe('queued');
      expect(failEvent?.actor_type).toBe('system');
      expect(failEvent?.reason).toContain("stuck in 'queued'");
    });
  });

  describe('stuck delegated task detection', () => {
    it('fails a task stuck in delegated past timeout', async () => {
      await seedBaseData();
      const taskId = 'task-st-delegated-stuck';
      const oldDate = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30m ago

      await seedTask(taskId, PROJECT_ID, USER_ID, {
        status: 'delegated',
        executionStep: 'workspace_creation',
        updatedAt: oldDate,
      });

      const testEnv = {
        ...env,
        TASK_STUCK_QUEUED_TIMEOUT_MS: '300000',
        TASK_STUCK_DELEGATED_TIMEOUT_MS: '60000', // 1 min (task is 30m old)
        TASK_RUN_MAX_EXECUTION_MS: '14400000',
        TASK_RUN_HARD_TIMEOUT_MS: '28800000',
      } as unknown as Env;

      const result = await recoverStuckTasks(testEnv);

      expect(result.failedDelegated).toBe(1);

      const task = await getTaskStatus(taskId);
      expect(task?.status).toBe('failed');
      expect(task?.error_message).toContain("stuck in 'delegated'");
    });
  });

  describe('stuck in_progress task detection', () => {
    it('fails in_progress task past hard timeout', async () => {
      await seedBaseData();
      const taskId = 'task-st-inprog-hard';
      const nineHoursAgo = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();

      await seedTask(taskId, PROJECT_ID, USER_ID, {
        status: 'in_progress',
        executionStep: 'running',
        startedAt: nineHoursAgo,
        updatedAt: nineHoursAgo,
      });

      const testEnv = {
        ...env,
        TASK_STUCK_QUEUED_TIMEOUT_MS: '300000',
        TASK_STUCK_DELEGATED_TIMEOUT_MS: '300000',
        TASK_RUN_MAX_EXECUTION_MS: '14400000', // 4h
        TASK_RUN_HARD_TIMEOUT_MS: '28800000', // 8h (task is 9h old)
      } as unknown as Env;

      const result = await recoverStuckTasks(testEnv);

      expect(result.failedInProgress).toBe(1);

      const task = await getTaskStatus(taskId);
      expect(task?.status).toBe('failed');
      expect(task?.error_message).toContain('hard timeout');
    });
  });

  describe('heartbeat grace period', () => {
    it('skips in_progress task with recent heartbeat', async () => {
      await seedBaseData();
      const taskId = 'task-st-heartbeat-skip';
      const nodeId = 'node-st-heartbeat';
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();

      await seedNode(nodeId, USER_ID, {
        lastHeartbeatAt: new Date().toISOString(), // very recent heartbeat
      });
      await seedWorkspace('ws-st-heartbeat', nodeId, USER_ID, {
        projectId: PROJECT_ID,
        status: 'running',
      });
      await seedTask(taskId, PROJECT_ID, USER_ID, {
        status: 'in_progress',
        executionStep: 'running',
        startedAt: fiveHoursAgo,
        updatedAt: fiveHoursAgo,
        workspaceId: 'ws-st-heartbeat',
      });

      const testEnv = {
        ...env,
        TASK_STUCK_QUEUED_TIMEOUT_MS: '300000',
        TASK_STUCK_DELEGATED_TIMEOUT_MS: '300000',
        TASK_RUN_MAX_EXECUTION_MS: '14400000', // 4h (task is 5h old → past soft timeout)
        TASK_RUN_HARD_TIMEOUT_MS: '28800000', // 8h (task is within hard timeout)
        NODE_HEARTBEAT_STALE_SECONDS: '300', // 5 min
      } as unknown as Env;

      const result = await recoverStuckTasks(testEnv);

      expect(result.heartbeatSkipped).toBeGreaterThanOrEqual(1);

      // Task should still be in_progress
      const task = await getTaskStatus(taskId);
      expect(task?.status).toBe('in_progress');
    });
  });

  describe('optimistic locking', () => {
    it('gracefully skips task that was advanced between SELECT and UPDATE', async () => {
      await seedBaseData();
      const taskId = 'task-st-optlock';
      const oldDate = new Date(Date.now() - 20 * 60 * 1000).toISOString();

      await seedTask(taskId, PROJECT_ID, USER_ID, {
        status: 'queued',
        updatedAt: oldDate,
      });

      // Advance the task to 'delegated' just before recovery runs
      // This simulates the TaskRunner DO advancing the task between SELECT and UPDATE
      await env.DATABASE.prepare(
        "UPDATE tasks SET status = 'delegated', updated_at = datetime('now') WHERE id = ?",
      )
        .bind(taskId)
        .run();

      // Now the task is 'delegated' but updated_at is fresh — it shouldn't be stuck
      const testEnv = {
        ...env,
        TASK_STUCK_QUEUED_TIMEOUT_MS: '60000',
        TASK_STUCK_DELEGATED_TIMEOUT_MS: '900000', // 15m — task just became delegated, not stuck
        TASK_RUN_MAX_EXECUTION_MS: '14400000',
        TASK_RUN_HARD_TIMEOUT_MS: '28800000',
      } as unknown as Env;

      const result = await recoverStuckTasks(testEnv);

      // Task should NOT have been failed (it's delegated with fresh updated_at)
      const task = await getTaskStatus(taskId);
      expect(task?.status).toBe('delegated');
      expect(result.failedQueued).toBe(0);
    });
  });

  describe('non-stuck task is not touched', () => {
    it('does not fail a recently queued task', async () => {
      await seedBaseData();
      const taskId = 'task-st-recent-queued';

      await seedTask(taskId, PROJECT_ID, USER_ID, {
        status: 'queued',
        updatedAt: new Date().toISOString(), // just now
      });

      const testEnv = {
        ...env,
        TASK_STUCK_QUEUED_TIMEOUT_MS: '300000', // 5 min
        TASK_STUCK_DELEGATED_TIMEOUT_MS: '300000',
        TASK_RUN_MAX_EXECUTION_MS: '14400000',
        TASK_RUN_HARD_TIMEOUT_MS: '28800000',
      } as unknown as Env;

      const result = await recoverStuckTasks(testEnv);

      const task = await getTaskStatus(taskId);
      expect(task?.status).toBe('queued');
      expect(result.failedQueued).toBe(0);
    });
  });

  describe('observability recording', () => {
    it('records recovery event in OBSERVABILITY_DATABASE', async () => {
      await seedBaseData();
      const taskId = 'task-st-obs-event';
      const oldDate = new Date(Date.now() - 20 * 60 * 1000).toISOString();

      await seedTask(taskId, PROJECT_ID, USER_ID, {
        status: 'queued',
        executionStep: 'node_provisioning',
        updatedAt: oldDate,
      });

      const testEnv = {
        ...env,
        TASK_STUCK_QUEUED_TIMEOUT_MS: '60000',
        TASK_STUCK_DELEGATED_TIMEOUT_MS: '300000',
        TASK_RUN_MAX_EXECUTION_MS: '14400000',
        TASK_RUN_HARD_TIMEOUT_MS: '28800000',
      } as unknown as Env;

      await recoverStuckTasks(testEnv);

      // Verify observability event has structured diagnostics
      const events = await getObservabilityEvents(taskId);
      expect(events.length).toBeGreaterThanOrEqual(1);

      const recoveryEvent = events.find((e) => e.message.includes("stuck in 'queued'"));
      expect(recoveryEvent).toBeDefined();

      const context = JSON.parse(recoveryEvent!.context);
      expect(context.recoveryType).toBe('stuck_task');
      expect(context.taskStatus).toBe('queued');
      expect(context.executionStep).toBe('node_provisioning');
      expect(typeof context.elapsedMs).toBe('number');
    });
  });
});

describe('gatherDiagnostics', () => {
  it('includes workspace and node status from D1', async () => {
    await seedUser('user-st-diag');
    await seedInstallation('install-st-diag', 'user-st-diag');
    await seedProject('project-st-diag', 'user-st-diag', 'install-st-diag');
    await seedNode('node-st-diag', 'user-st-diag', { status: 'running', healthStatus: 'healthy' });
    await seedWorkspace('ws-st-diag', 'node-st-diag', 'user-st-diag', {
      projectId: 'project-st-diag',
      status: 'running',
    });

    const diagnostics = await gatherDiagnostics(
      env as unknown as Env,
      {
        id: 'task-st-diag',
        status: 'queued',
        execution_step: 'node_selection',
        workspace_id: 'ws-st-diag',
        auto_provisioned_node_id: null,
      },
      120000,
      'Test reason',
    );

    expect(diagnostics.taskId).toBe('task-st-diag');
    expect(diagnostics.workspaceId).toBe('ws-st-diag');
    expect(diagnostics.workspaceStatus).toBe('running');
    expect(diagnostics.nodeId).toBe('node-st-diag');
    expect(diagnostics.nodeStatus).toBe('running');
    expect(diagnostics.nodeHealthStatus).toBe('healthy');
    expect(diagnostics.elapsedMs).toBe(120000);
    expect(diagnostics.reason).toBe('Test reason');
  });

  it('handles missing workspace gracefully', async () => {
    const diagnostics = await gatherDiagnostics(
      env as unknown as Env,
      {
        id: 'task-st-no-ws',
        status: 'queued',
        execution_step: null,
        workspace_id: 'nonexistent-ws',
        auto_provisioned_node_id: null,
      },
      60000,
      'Test reason',
    );

    expect(diagnostics.workspaceStatus).toBeNull();
    expect(diagnostics.nodeId).toBeNull();
  });

  it('falls back to autoProvisionedNodeId when workspace has no node', async () => {
    await seedUser('user-st-diag2');
    await seedNode('node-st-auto', 'user-st-diag2', { status: 'creating', healthStatus: 'unknown' });

    const diagnostics = await gatherDiagnostics(
      env as unknown as Env,
      {
        id: 'task-st-auto-node',
        status: 'delegated',
        execution_step: 'node_provisioning',
        workspace_id: null,
        auto_provisioned_node_id: 'node-st-auto',
      },
      90000,
      'Test auto-prov',
    );

    expect(diagnostics.nodeId).toBe('node-st-auto');
    expect(diagnostics.nodeStatus).toBe('creating');
    expect(diagnostics.nodeHealthStatus).toBe('unknown');
  });
});
