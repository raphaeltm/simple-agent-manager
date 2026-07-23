/**
 * Vertical slice tests for the project-orchestrator.ts proxy service.
 *
 * Verifies the Worker→DO contract: that the proxy correctly resolves the
 * DO stub via idFromName(projectId) and forwards arguments to the
 * ProjectOrchestrator DO.
 *
 * Uses Miniflare with real DOs (embedded SQLite) — no vi.mock().
 */
import type { TaskEventNotification } from '@simple-agent-manager/shared';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectOrchestrator } from '../../src/durable-objects/project-orchestrator';
import {
  cancelMission,
  getOrchestratorStatus,
  getSchedulingQueue,
  notifyTaskEvent,
  overrideTaskState,
  pauseMission,
  resumeMission,
  startOrchestration,
} from '../../src/services/project-orchestrator';
import { seedInstallation, seedMission, seedProject, seedTask, seedUser } from './helpers/seed-d1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_USER_ID = 'user-po-test-001';
const TEST_INSTALL_ID = 'install-po-001';
const TEST_PROJECT_ID = 'proj-po-001';

function getStub(projectId: string): DurableObjectStub<ProjectOrchestrator> {
  const id = env.PROJECT_ORCHESTRATOR.idFromName(projectId);
  return env.PROJECT_ORCHESTRATOR.get(id) as DurableObjectStub<ProjectOrchestrator>;
}

async function seedTestProject(
  projectId: string = TEST_PROJECT_ID,
  userId: string = TEST_USER_ID,
): Promise<void> {
  await seedUser(userId);
  await seedInstallation(TEST_INSTALL_ID, userId);
  await seedProject(projectId, userId, TEST_INSTALL_ID, {
    name: projectId,
    repository: 'test-org/' + projectId,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('project-orchestrator proxy — Worker→DO contract', () => {
  it('startOrchestration registers mission and arms alarm', async () => {
    const projectId = 'proj-po-start-001';
    const missionId = 'mission-start-001';
    await seedTestProject(projectId);
    await seedMission(missionId, projectId, TEST_USER_ID);

    await startOrchestration(env, projectId, missionId);

    // Verify via status
    const status = await getOrchestratorStatus(env, projectId);
    expect(status.projectId).toBe(projectId);
    expect(status.activeMissions).toHaveLength(1);
    expect(status.activeMissions[0]!.missionId).toBe(missionId);
    expect(status.activeMissions[0]!.status).toBe('active');
    expect(status.nextAlarmAt).toBeTruthy();
  });

  it('startOrchestration is idempotent', async () => {
    const projectId = 'proj-po-idempotent-001';
    const missionId = 'mission-idempotent-001';
    await seedTestProject(projectId);
    await seedMission(missionId, projectId, TEST_USER_ID);

    await startOrchestration(env, projectId, missionId);
    await startOrchestration(env, projectId, missionId);

    const status = await getOrchestratorStatus(env, projectId);
    expect(status.activeMissions).toHaveLength(1);
  });

  it('pauseMission transitions active → paused', async () => {
    const projectId = 'proj-po-pause-001';
    const missionId = 'mission-pause-001';
    await seedTestProject(projectId);
    await seedMission(missionId, projectId, TEST_USER_ID);

    await startOrchestration(env, projectId, missionId);
    const result = await pauseMission(env, projectId, missionId);

    expect(result).toBe(true);

    // Verify DO state
    const status = await getOrchestratorStatus(env, projectId);
    expect(status.activeMissions[0]!.status).toBe('paused');

    // Verify D1 was updated
    const dbMission = await env.DATABASE.prepare(
      'SELECT status FROM missions WHERE id = ?',
    ).bind(missionId).first<{ status: string }>();
    expect(dbMission!.status).toBe('paused');
  });

  it('pauseMission returns false for non-active mission', async () => {
    const projectId = 'proj-po-pause-fail-001';
    const missionId = 'mission-pause-fail-001';
    await seedTestProject(projectId);
    await seedMission(missionId, projectId, TEST_USER_ID);

    // Never started — not registered in DO
    const result = await pauseMission(env, projectId, missionId);
    expect(result).toBe(false);
  });

  it('resumeMission transitions paused → active', async () => {
    const projectId = 'proj-po-resume-001';
    const missionId = 'mission-resume-001';
    await seedTestProject(projectId);
    await seedMission(missionId, projectId, TEST_USER_ID);

    await startOrchestration(env, projectId, missionId);
    await pauseMission(env, projectId, missionId);
    const result = await resumeMission(env, projectId, missionId);

    expect(result).toBe(true);

    const status = await getOrchestratorStatus(env, projectId);
    expect(status.activeMissions[0]!.status).toBe('active');

    // Verify D1 was updated
    const dbMission = await env.DATABASE.prepare(
      'SELECT status FROM missions WHERE id = ?',
    ).bind(missionId).first<{ status: string }>();
    expect(dbMission!.status).toBe('active');
  });

  it('resumeMission returns false for non-paused mission', async () => {
    const projectId = 'proj-po-resume-fail-001';
    const missionId = 'mission-resume-fail-001';
    await seedTestProject(projectId);
    await seedMission(missionId, projectId, TEST_USER_ID);

    await startOrchestration(env, projectId, missionId);
    // Already active — resume should fail
    const result = await resumeMission(env, projectId, missionId);
    expect(result).toBe(false);
  });

  it('cancelMission removes mission from DO and updates D1', async () => {
    const projectId = 'proj-po-cancel-001';
    const missionId = 'mission-cancel-001';
    const taskId = 'task-cancel-001';
    await seedTestProject(projectId);
    await seedMission(missionId, projectId, TEST_USER_ID);
    await seedTask(taskId, projectId, TEST_USER_ID, { status: 'delegated' });

    // Link task to mission in D1
    await env.DATABASE.prepare(
      'UPDATE tasks SET mission_id = ?, scheduler_state = ? WHERE id = ?',
    ).bind(missionId, 'pending', taskId).run();

    await startOrchestration(env, projectId, missionId);
    const result = await cancelMission(env, projectId, missionId);

    expect(result).toBe(true);

    // Verify mission removed from DO
    const status = await getOrchestratorStatus(env, projectId);
    expect(status.activeMissions).toHaveLength(0);

    // Verify D1 mission is cancelled
    const dbMission = await env.DATABASE.prepare(
      'SELECT status FROM missions WHERE id = ?',
    ).bind(missionId).first<{ status: string }>();
    expect(dbMission!.status).toBe('cancelled');

    // Verify D1 task is cancelled
    const dbTask = await env.DATABASE.prepare(
      'SELECT status, scheduler_state FROM tasks WHERE id = ?',
    ).bind(taskId).first<{ status: string; scheduler_state: string }>();
    expect(dbTask!.status).toBe('cancelled');
    expect(dbTask!.scheduler_state).toBe('cancelled');
  });

  it('cancelMission returns false for unregistered mission', async () => {
    const projectId = 'proj-po-cancel-fail-001';
    await seedTestProject(projectId);

    const result = await cancelMission(env, projectId, 'nonexistent-mission');
    expect(result).toBe(false);
  });

  it('overrideTaskState updates scheduler_state in D1', async () => {
    const projectId = 'proj-po-override-001';
    const missionId = 'mission-override-001';
    const taskId = 'task-override-001';
    await seedTestProject(projectId);
    await seedMission(missionId, projectId, TEST_USER_ID);
    await seedTask(taskId, projectId, TEST_USER_ID);

    // Link task to mission
    await env.DATABASE.prepare(
      'UPDATE tasks SET mission_id = ? WHERE id = ?',
    ).bind(missionId, taskId).run();

    await startOrchestration(env, projectId, missionId);
    const result = await overrideTaskState(env, projectId, missionId, taskId, 'blocked_human', 'Waiting for dependency');

    expect(result).toBe(true);

    const dbTask = await env.DATABASE.prepare(
      'SELECT scheduler_state FROM tasks WHERE id = ?',
    ).bind(taskId).first<{ scheduler_state: string }>();
    expect(dbTask!.scheduler_state).toBe('blocked_human');
  });

  it('overrideTaskState rejects a task that belongs to another project and leaves it unchanged', async () => {
    const callerProjectId = 'proj-po-override-caller-001';
    const targetProjectId = 'proj-po-override-target-001';
    const missionId = 'mission-override-target-001';
    const taskId = 'task-override-target-001';

    await seedTestProject(callerProjectId);
    await seedTestProject(targetProjectId);
    await seedMission(missionId, targetProjectId, TEST_USER_ID);
    await seedTask(taskId, targetProjectId, TEST_USER_ID, { status: 'delegated' });

    await env.DATABASE.prepare(
      'UPDATE tasks SET mission_id = ?, scheduler_state = ? WHERE id = ?',
    ).bind(missionId, 'schedulable', taskId).run();

    // Defence-in-depth: even if the caller project's orchestrator is somehow
    // tracking the target mission, the task row ownership must still reject.
    await startOrchestration(env, callerProjectId, missionId);
    const result = await overrideTaskState(
      env,
      callerProjectId,
      missionId,
      taskId,
      'blocked_human',
      'Cross-project attempt',
    );

    expect(result).toBe(false);

    const dbTask = await env.DATABASE.prepare(
      'SELECT project_id, scheduler_state FROM tasks WHERE id = ?',
    ).bind(taskId).first<{ project_id: string; scheduler_state: string | null }>();
    expect(dbTask).toEqual({
      project_id: targetProjectId,
      scheduler_state: 'schedulable',
    });
  });

  it('overrideTaskState returns false for invalid state', async () => {
    const projectId = 'proj-po-override-invalid-001';
    const missionId = 'mission-override-invalid-001';
    const taskId = 'task-override-invalid-001';
    await seedTestProject(projectId);
    await seedMission(missionId, projectId, TEST_USER_ID);
    await seedTask(taskId, projectId, TEST_USER_ID);
    await env.DATABASE.prepare(
      'UPDATE tasks SET mission_id = ? WHERE id = ?',
    ).bind(missionId, taskId).run();

    await startOrchestration(env, projectId, missionId);
    // 'completed' is not an overridable state
    const result = await overrideTaskState(
      env, projectId, missionId, taskId,
      'completed' as never, 'Should fail',
    );
    expect(result).toBe(false);
  });

  it('overrideTaskState returns false when task belongs to different mission', async () => {
    const projectId = 'proj-po-cross-mission-001';
    const missionA = 'mission-cross-a-001';
    const missionB = 'mission-cross-b-001';
    const taskA = 'task-cross-a-001';
    const taskB = 'task-cross-b-001';
    await seedTestProject(projectId);
    await seedMission(missionA, projectId, TEST_USER_ID);
    await seedMission(missionB, projectId, TEST_USER_ID);
    await seedTask(taskA, projectId, TEST_USER_ID);
    await seedTask(taskB, projectId, TEST_USER_ID);

    // Link each task to its own mission
    await env.DATABASE.prepare(
      'UPDATE tasks SET mission_id = ? WHERE id = ?',
    ).bind(missionA, taskA).run();
    await env.DATABASE.prepare(
      'UPDATE tasks SET mission_id = ? WHERE id = ?',
    ).bind(missionB, taskB).run();

    await startOrchestration(env, projectId, missionA);
    await startOrchestration(env, projectId, missionB);

    // Attempt to override taskB via missionA — should fail
    const result = await overrideTaskState(env, projectId, missionA, taskB, 'blocked_human', 'Cross-mission attempt');
    expect(result).toBe(false);

    // Verify taskB's scheduler_state was not changed
    const dbTask = await env.DATABASE.prepare(
      'SELECT scheduler_state FROM tasks WHERE id = ?',
    ).bind(taskB).first<{ scheduler_state: string | null }>();
    expect(dbTask!.scheduler_state).not.toBe('blocked_human');
  });

  it('notifyTaskEvent accepts events for an active mission', async () => {
    const projectId = 'proj-po-notify-001';
    const missionId = 'mission-notify-001';
    await seedTestProject(projectId);
    await seedMission(missionId, projectId, TEST_USER_ID);

    await startOrchestration(env, projectId, missionId);

    const notification: TaskEventNotification = {
      missionId,
      taskId: 'task-notify-001',
      event: 'completed',
    };

    // Should not throw — just forwards to DO
    await notifyTaskEvent(env, projectId, notification);

    // The DO should retain the active mission after arming its immediate alarm.
    const status = await getOrchestratorStatus(env, projectId);
    expect(status.activeMissions).toHaveLength(1);
  });

  it('notifyTaskEvent is a no-op for non-orchestrated mission', async () => {
    const projectId = 'proj-po-notify-noop-001';
    await seedTestProject(projectId);

    const notification: TaskEventNotification = {
      missionId: 'nonexistent-mission',
      taskId: 'task-noop-001',
      event: 'failed',
    };

    // Should not throw
    await notifyTaskEvent(env, projectId, notification);
  });

  it('getOrchestratorStatus returns empty state for new project', async () => {
    const projectId = 'proj-po-empty-001';
    await seedTestProject(projectId);

    const status = await getOrchestratorStatus(env, projectId);

    expect(status.projectId).toBe(projectId);
    expect(status.activeMissions).toHaveLength(0);
    expect(status.schedulingQueue).toHaveLength(0);
    expect(status.recentDecisions).toHaveLength(0);
  });

  it('getSchedulingQueue returns empty for new project', async () => {
    const projectId = 'proj-po-queue-empty-001';
    await seedTestProject(projectId);

    const queue = await getSchedulingQueue(env, projectId);
    expect(queue).toHaveLength(0);
  });

  it('proxy uses idFromName for deterministic DO resolution', async () => {
    const projectId = 'proj-po-deterministic-001';
    const missionId = 'mission-deterministic-001';
    await seedTestProject(projectId);
    await seedMission(missionId, projectId, TEST_USER_ID);

    await startOrchestration(env, projectId, missionId);

    // Proxy and direct stub should access the same DO instance
    const proxyStatus = await getOrchestratorStatus(env, projectId);
    const directStatus = await getStub(projectId).getStatus(projectId);

    expect(proxyStatus.activeMissions).toHaveLength(directStatus.activeMissions.length);
    expect(proxyStatus.activeMissions[0]!.missionId).toBe(directStatus.activeMissions[0]!.missionId);
  });

  it('full lifecycle: start → pause → resume → cancel', async () => {
    const projectId = 'proj-po-lifecycle-001';
    const missionId = 'mission-lifecycle-001';
    await seedTestProject(projectId);
    await seedMission(missionId, projectId, TEST_USER_ID);

    // Start
    await startOrchestration(env, projectId, missionId);
    let status = await getOrchestratorStatus(env, projectId);
    expect(status.activeMissions[0]!.status).toBe('active');

    // Pause
    expect(await pauseMission(env, projectId, missionId)).toBe(true);
    status = await getOrchestratorStatus(env, projectId);
    expect(status.activeMissions[0]!.status).toBe('paused');

    // Resume
    expect(await resumeMission(env, projectId, missionId)).toBe(true);
    status = await getOrchestratorStatus(env, projectId);
    expect(status.activeMissions[0]!.status).toBe('active');

    // Cancel
    expect(await cancelMission(env, projectId, missionId)).toBe(true);
    status = await getOrchestratorStatus(env, projectId);
    expect(status.activeMissions).toHaveLength(0);
  });

  it('decision log records lifecycle events', async () => {
    const projectId = 'proj-po-decisions-001';
    const missionId = 'mission-decisions-001';
    await seedTestProject(projectId);
    await seedMission(missionId, projectId, TEST_USER_ID);

    await startOrchestration(env, projectId, missionId);
    await pauseMission(env, projectId, missionId);
    await resumeMission(env, projectId, missionId);

    const status = await getOrchestratorStatus(env, projectId);
    // Should have at least: dispatch (start), pause, resume
    expect(status.recentDecisions.length).toBeGreaterThanOrEqual(3);

    const actions = status.recentDecisions.map((d) => d.action);
    expect(actions).toContain('dispatch');
    expect(actions).toContain('pause');
    expect(actions).toContain('resume');
  });
});
