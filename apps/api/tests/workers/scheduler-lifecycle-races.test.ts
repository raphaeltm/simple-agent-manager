/**
 * Real workerd/D1 race slices for scheduler lifecycle ownership.
 *
 * These tests deliberately race the production placement and cleanup CAS
 * statements. They do not mock D1, and they require no provider credentials.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import type {
  StartTaskInput,
  TaskRunner,
  TaskRunnerState,
} from '../../src/durable-objects/task-runner';
import type { Env } from '../../src/env';
import { claimNodeForCleanup } from '../../src/scheduled/node-cleanup/shared';
import {
  reserveWorkspacePlacement,
  type WorkspacePlacementInput,
} from '../../src/services/workspace-placement';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const USER_ID = 'user-scheduler-races';
const INSTALLATION_ID = 'installation-scheduler-races';
const PROJECT_ID = 'project-scheduler-races';
const RACE_REPETITIONS = 24;

beforeAll(async () => {
  await seedUser(USER_ID);
  await seedInstallation(INSTALLATION_ID, USER_ID);
  await seedProject(PROJECT_ID, USER_ID, INSTALLATION_ID);
});

function placement(
  workspaceId: string,
  nodeId: string,
  createdAt = new Date().toISOString()
): WorkspacePlacementInput {
  return {
    id: workspaceId,
    nodeId,
    projectId: PROJECT_ID,
    userId: USER_ID,
    installationId: INSTALLATION_ID,
    name: `Workspace ${workspaceId}`,
    displayName: `Workspace ${workspaceId}`,
    normalizedDisplayName: workspaceId,
    repository: 'test-org/scheduler-races',
    branch: 'main',
    vmSize: 'medium',
    vmLocation: 'nbg1',
    workspaceProfile: 'full',
    devcontainerConfigName: null,
    agentProfileHint: null,
    createdAt,
  };
}

async function nodeState(nodeId: string): Promise<{ status: string; active: number }> {
  const node = await env.DATABASE.prepare('SELECT status FROM nodes WHERE id = ?')
    .bind(nodeId)
    .first<{ status: string }>();
  const workspaces = await env.DATABASE.prepare(
    `SELECT COUNT(*) AS active
     FROM workspaces
     WHERE node_id = ? AND status IN ('running', 'creating', 'recovery')`
  )
    .bind(nodeId)
    .first<{ active: number }>();
  return { status: node?.status ?? 'missing', active: workspaces?.active ?? 0 };
}

function taskRunnerInput(taskId: string): StartTaskInput {
  return {
    taskId,
    projectId: PROJECT_ID,
    userId: USER_ID,
    config: {
      vmSize: 'medium',
      vmLocation: 'nbg1',
      branch: 'main',
      preferredNodeId: null,
      userName: 'Scheduler Race Test',
      userEmail: 'scheduler-race@example.com',
      githubId: null,
      taskTitle: taskId,
      taskDescription: null,
      repository: 'test-org/scheduler-races',
      installationId: INSTALLATION_ID,
      outputBranch: null,
      defaultBranch: 'main',
      projectDefaultVmSize: null,
      chatSessionId: null,
      agentType: 'openai-codex',
      workspaceProfile: 'full',
      devcontainerConfigName: null,
      cloudProvider: null,
      credentialAttributionUserId: USER_ID,
      credentialAttributionProjectId: null,
      credentialAttributionSource: 'user',
      taskMode: 'task',
      model: null,
      effort: null,
      permissionMode: null,
      opencodeProvider: null,
      opencodeBaseUrl: null,
      systemPromptAppend: null,
      agentProfileHint: null,
      attachments: null,
      projectScaling: { maxWorkspacesPerNode: 1 },
    },
  };
}

describe('scheduler lifecycle D1 races', () => {
  it('allows only one concurrent placement to consume the final node slot', async () => {
    for (let iteration = 0; iteration < RACE_REPETITIONS; iteration += 1) {
      const nodeId = `node-scheduler-final-slot-${iteration}`;
      await seedNode(nodeId, USER_ID);

      const placements = [
        () =>
          reserveWorkspacePlacement(
            env.DATABASE,
            placement(`workspace-scheduler-final-slot-${iteration}-a`, nodeId),
            1
          ),
        () =>
          reserveWorkspacePlacement(
            env.DATABASE,
            placement(`workspace-scheduler-final-slot-${iteration}-b`, nodeId),
            1
          ),
      ];
      if (iteration % 2 === 1) placements.reverse();
      const outcomes = await Promise.all(placements.map((reserve) => reserve()));

      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(await nodeState(nodeId)).toEqual({ status: 'running', active: 1 });
    }
  });

  it('serializes cleanup and placement so both cannot own the node', async () => {
    for (let iteration = 0; iteration < RACE_REPETITIONS; iteration += 1) {
      const nodeId = `node-scheduler-cleanup-placement-${iteration}`;
      const taskId = `task-scheduler-cleanup-placement-${iteration}`;
      const old = new Date(Date.now() - 60 * 60_000).toISOString();
      await seedNode(nodeId, USER_ID, { createdAt: old, updatedAt: old });
      await seedTask(taskId, PROJECT_ID, USER_ID, {
        status: 'in_progress',
        autoProvisionedNodeId: nodeId,
        updatedAt: old,
      });

      const claimCleanup = () =>
        claimNodeForCleanup(
          env as unknown as Env,
          { id: nodeId, user_id: USER_ID, status: 'running' },
          new Date().toISOString()
        );
      const reservePlacement = () =>
        reserveWorkspacePlacement(
          env.DATABASE,
          placement(`workspace-scheduler-cleanup-placement-${iteration}`, nodeId),
          1
        );
      let cleanupClaimed: boolean;
      let placementReserved: boolean;
      if (iteration % 2 === 0) {
        [cleanupClaimed, placementReserved] = await Promise.all([
          claimCleanup(),
          reservePlacement(),
        ]);
      } else {
        [placementReserved, cleanupClaimed] = await Promise.all([
          reservePlacement(),
          claimCleanup(),
        ]);
      }
      const state = await nodeState(nodeId);

      expect(Number(cleanupClaimed) + Number(placementReserved)).toBe(1);
      expect(state).toEqual(
        cleanupClaimed ? { status: 'destroying', active: 0 } : { status: 'running', active: 1 }
      );
    }
  });

  it('keeps a fresh pre-workspace provisioning claim out of cleanup via node created_at fallback', async () => {
    const nodeId = 'node-scheduler-provisioning-claim';
    const taskId = 'task-scheduler-provisioning-claim';
    await seedNode(nodeId, USER_ID);
    await seedTask(taskId, PROJECT_ID, USER_ID, {
      status: 'queued',
      autoProvisionedNodeId: nodeId,
      executionStep: 'node_provisioning',
    });

    const claimed = await claimNodeForCleanup(
      env as unknown as Env,
      { id: nodeId, user_id: USER_ID, status: 'running' },
      new Date().toISOString()
    );

    expect(claimed).toBe(false);
    expect(await nodeState(nodeId)).toEqual({ status: 'running', active: 0 });
  });

  it('does not let an in-progress task pin an old workspace-less auto-provisioned node', async () => {
    const nodeId = 'node-scheduler-old-in-progress-claim';
    const taskId = 'task-scheduler-old-in-progress-claim';
    const old = new Date(Date.now() - 60 * 60_000).toISOString();

    await seedNode(nodeId, USER_ID, { createdAt: old, updatedAt: old });
    await seedTask(taskId, PROJECT_ID, USER_ID, {
      status: 'in_progress',
      autoProvisionedNodeId: nodeId,
      executionStep: 'running',
      updatedAt: old,
    });

    const claimed = await claimNodeForCleanup(
      env as unknown as Env,
      { id: nodeId, user_id: USER_ID, status: 'running' },
      new Date().toISOString()
    );

    expect(claimed).toBe(true);
    expect(await nodeState(nodeId)).toEqual({ status: 'destroying', active: 0 });
  });

  it('protects a recent warm-reuse claim until reserveWorkspacePlacement creates the active row', async () => {
    const nodeId = 'node-scheduler-warm-placement-race';
    const priorTaskId = 'task-scheduler-warm-placement-prior';
    const claimantTaskId = 'task-scheduler-warm-placement-claim';
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const claimTime = new Date().toISOString();

    await seedNode(nodeId, USER_ID, {
      status: 'running',
      warmSince: old,
      createdAt: old,
      updatedAt: old,
    });
    await seedTask(priorTaskId, PROJECT_ID, USER_ID, {
      status: 'completed',
      autoProvisionedNodeId: nodeId,
      updatedAt: old,
    });
    await seedTask(claimantTaskId, PROJECT_ID, USER_ID, {
      status: 'queued',
      executionStep: 'node_selection',
    });
    await env.DATABASE.prepare(
      `UPDATE tasks
       SET claimed_warm_node_id = ?, claimed_warm_node_at = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(nodeId, claimTime, claimTime, claimantTaskId)
      .run();

    const claimedDuringPreRowWindow = await claimNodeForCleanup(
      env as unknown as Env,
      { id: nodeId, user_id: USER_ID, status: 'running' },
      claimTime
    );

    expect(claimedDuringPreRowWindow).toBe(false);
    expect(await nodeState(nodeId)).toEqual({ status: 'running', active: 0 });

    const placementReserved = await reserveWorkspacePlacement(
      env.DATABASE,
      placement('workspace-scheduler-warm-placement-race', nodeId, claimTime),
      1
    );

    expect(placementReserved).toBe(true);

    await env.DATABASE.prepare(
      `UPDATE tasks
       SET claimed_warm_node_at = ?
       WHERE id = ?`
    )
      .bind(old, claimantTaskId)
      .run();

    const claimedAfterPlacement = await claimNodeForCleanup(
      env as unknown as Env,
      { id: nodeId, user_id: USER_ID, status: 'running' },
      new Date().toISOString()
    );

    expect(claimedAfterPlacement).toBe(false);
    expect(await nodeState(nodeId)).toEqual({ status: 'running', active: 1 });
  });

  it('lets an abandoned warm-reuse claim age out of the bounded placement guard', async () => {
    const nodeId = 'node-scheduler-stale-warm-placement-claim';
    const priorTaskId = 'task-scheduler-stale-warm-placement-prior';
    const claimantTaskId = 'task-scheduler-stale-warm-placement-claim';
    const old = new Date(Date.now() - 60 * 60_000).toISOString();

    await seedNode(nodeId, USER_ID, {
      status: 'running',
      warmSince: old,
      createdAt: old,
      updatedAt: old,
    });
    await seedTask(priorTaskId, PROJECT_ID, USER_ID, {
      status: 'completed',
      autoProvisionedNodeId: nodeId,
      updatedAt: old,
    });
    await seedTask(claimantTaskId, PROJECT_ID, USER_ID, {
      status: 'delegated',
      executionStep: 'workspace_creation',
      updatedAt: new Date().toISOString(),
    });
    await env.DATABASE.prepare(
      `UPDATE tasks
       SET claimed_warm_node_id = ?, claimed_warm_node_at = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(nodeId, old, new Date().toISOString(), claimantTaskId)
      .run();

    const claimed = await claimNodeForCleanup(
      env as unknown as Env,
      { id: nodeId, user_id: USER_ID, status: 'running' },
      new Date().toISOString()
    );

    expect(claimed).toBe(true);
    expect(await nodeState(nodeId)).toEqual({ status: 'destroying', active: 0 });
  });

  it('makes the real TaskRunner reselect when its advisory node slot was consumed', async () => {
    const nodeId = 'node-scheduler-task-runner-reselect';
    const taskId = 'task-scheduler-task-runner-reselect';
    await seedNode(nodeId, USER_ID);
    await seedWorkspace('workspace-scheduler-existing-occupant', nodeId, USER_ID, {
      projectId: PROJECT_ID,
      status: 'running',
    });
    await seedTask(taskId, PROJECT_ID, USER_ID, {
      status: 'queued',
      executionStep: 'workspace_creation',
    });

    const stub = env.TASK_RUNNER.get(
      env.TASK_RUNNER.idFromName(taskId)
    ) as DurableObjectStub<TaskRunner>;
    await runInDurableObject(stub, async (instance) => {
      await instance.start(taskRunnerInput(taskId));
      await instance.ctx.storage.deleteAlarm();
      const state = await instance.ctx.storage.get<TaskRunnerState>('state');
      if (!state) throw new Error('TaskRunner state was not initialized');
      state.currentStep = 'workspace_creation';
      state.stepResults.nodeId = nodeId;
      await instance.ctx.storage.put('state', state);
      await instance.alarm();
    });

    const status = await stub.getStatus();
    const task = await env.DATABASE.prepare('SELECT status, workspace_id FROM tasks WHERE id = ?')
      .bind(taskId)
      .first<{ status: string; workspace_id: string | null }>();

    expect(status).toMatchObject({
      currentStep: 'node_selection',
      stepResults: { nodeId: null, workspaceId: null },
      completed: false,
    });
    expect(task).toEqual({ status: 'queued', workspace_id: null });
    expect(await nodeState(nodeId)).toEqual({ status: 'running', active: 1 });
  });
});
