/**
 * A node auto-provisioned for a task must admit that task, and a node that cannot must
 * fail the task fast instead of spinning in a replan loop.
 *
 * 2026-11-05 staging: a 3.5 GB task provisioned a cx23 (4096 MB); admission charged the
 * node's measured host use (459 MB) on top of the 512 MB host reserve and refused it. The
 * TaskRunner went back to node selection, re-adopted the same node from
 * `tasks.auto_provisioned_node_id`, and repeated every ~6 s until the 15-minute
 * provisioning timeout. These tests drive the real TaskRunner Durable Object against real
 * D1 through that loop: workspace_creation → node_selection → node_provisioning (adopt) →
 * node_agent_ready → workspace_creation. Defaults come from the real resolvers; the test
 * env sets no admission override.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import type {
  StartTaskInput,
  TaskRunner,
  TaskRunnerState,
} from '../../src/durable-objects/task-runner';
import { WORKSPACE_PLACEMENT_REFUSED_NOTE_PREFIX } from '../../src/durable-objects/task-runner/workspace-placement-rejection';
import { DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS } from '../../src/services/provisioning-attempt-limits';
import {
  DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB,
  MEASURED_MEMORY_OVERRUN_REASON,
  resolveWorkspaceAdmissionPolicy,
  WORKSPACE_BUSY_BUILD_QUEUE_REASON,
} from '../../src/services/workspace-resource-capacity';
import { seedInstallation, seedNode, seedProject, seedTask, seedUser } from './helpers/seed-d1';

const USER_ID = 'user-provisioned-admission';
const INSTALLATION_ID = 'installation-provisioned-admission';
const PROJECT_ID = 'project-provisioned-admission';
/** The documented dispatch ceiling for a 4 GB machine (`.claude/rules/09`): 4096 - 1024. */
const DOCUMENTED_CAP_MEMORY_MB = 3072;
const CX23_MEMORY_MB = 4096;

beforeAll(async () => {
  await seedUser(USER_ID);
  await seedInstallation(INSTALLATION_ID, USER_ID);
  await seedProject(PROJECT_ID, USER_ID, INSTALLATION_ID);
});

/** A healthy, heartbeating cx23 that this task provisioned, reporting `memoryPercent`. */
async function seedProvisionedCx23(
  nodeId: string,
  taskId: string,
  metrics: { memoryPercent: number; creatingWorkspaces?: number }
): Promise<void> {
  const now = new Date().toISOString();
  await seedNode(nodeId, USER_ID, { vmSize: 'small', lastHeartbeatAt: now });
  await env.DATABASE.prepare(
    `UPDATE nodes SET
       runtime = 'vm', node_role = 'workspace', cloud_provider = 'hetzner',
       provider_instance_id = ?, provider_instance_type = 'cx23',
       provider_instance_vcpu_count = 2, provider_instance_memory_mb = ?,
       provider_instance_disk_gb = 40,
       observed_provider_instance_type = 'cx23', observed_provider_instance_vcpu_count = 2,
       observed_provider_instance_memory_mb = ?, observed_provider_instance_disk_gb = 40,
       observed_hardware_source = 'observed', agent_ready_at = ?, last_metrics = ?
     WHERE id = ?`
  )
    .bind(
      `server-${nodeId}`,
      CX23_MEMORY_MB,
      CX23_MEMORY_MB,
      now,
      JSON.stringify({
        version: 1,
        cpuLoadAvg1: 0,
        memoryPercent: metrics.memoryPercent,
        diskPercent: 19.5,
        creatingWorkspaces: metrics.creatingWorkspaces ?? 0,
      }),
      nodeId
    )
    .run();
  await seedTask(taskId, PROJECT_ID, USER_ID, {
    status: 'queued',
    executionStep: 'workspace_creation',
    autoProvisionedNodeId: nodeId,
    taskMode: 'task',
  });
}

function taskRunnerInput(taskId: string, memoryMb: number): StartTaskInput {
  return {
    taskId,
    projectId: PROJECT_ID,
    userId: USER_ID,
    config: {
      vmSize: 'small',
      vmLocation: 'nbg1',
      branch: 'main',
      preferredNodeId: null,
      userName: 'Provisioned Admission Test',
      userEmail: 'provisioned-admission@example.com',
      githubId: null,
      taskTitle: taskId,
      taskDescription: null,
      repository: 'test-org/provisioned-admission',
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
      projectScaling: {},
      resolvedReservation: {
        cpuMillis: 2_000,
        memoryMb,
        diskMb: 10_240,
        exclusiveNode: true,
        source: 'task',
        sourceId: 'task',
        version: 1,
      },
    },
  };
}

function taskRunner(taskId: string): DurableObjectStub<TaskRunner> {
  return env.TASK_RUNNER.get(env.TASK_RUNNER.idFromName(taskId)) as DurableObjectStub<TaskRunner>;
}

/** Start the runner as if node_provisioning had just handed it the node it created. */
async function startAtWorkspaceCreation(
  taskId: string,
  nodeId: string,
  memoryMb: number,
  priorRejections = 0
): Promise<void> {
  await runInDurableObject(taskRunner(taskId), async (instance) => {
    await instance.start(taskRunnerInput(taskId, memoryMb));
    await instance.ctx.storage.deleteAlarm();
    const state = await instance.ctx.storage.get<TaskRunnerState>('state');
    if (!state) throw new Error('TaskRunner state was not initialized');
    state.currentStep = 'workspace_creation';
    state.stepResults.nodeId = nodeId;
    state.stepResults.autoProvisioned = true;
    state.provisioningStartedAt = Date.now();
    state.workspacePlacementRejections = priorRejections;
    await instance.ctx.storage.put('state', state);
  });
}

/** Fire the runner's alarm once; returns the step it ran and the state it left. */
async function fireAlarm(taskId: string): Promise<{ ran: string; state: TaskRunnerState }> {
  return runInDurableObject(taskRunner(taskId), async (instance) => {
    const before = await instance.ctx.storage.get<TaskRunnerState>('state');
    await instance.alarm();
    await instance.ctx.storage.deleteAlarm();
    const after = await instance.ctx.storage.get<TaskRunnerState>('state');
    if (!before || !after) throw new Error('TaskRunner state missing');
    return { ran: before.currentStep, state: after };
  });
}

async function taskRow(taskId: string) {
  return env.DATABASE.prepare(
    `SELECT status, workspace_id AS workspaceId, error_message AS errorMessage,
       placement_explanation_json AS placement
     FROM tasks WHERE id = ?`
  )
    .bind(taskId)
    .first<{
      status: string;
      workspaceId: string | null;
      errorMessage: string | null;
      placement: string | null;
    }>();
}

async function activeWorkspacesOn(nodeId: string): Promise<number> {
  const row = await env.DATABASE.prepare(
    `SELECT COUNT(*) AS n FROM workspaces WHERE node_id = ? AND status IN ('running', 'creating', 'recovery')`
  )
    .bind(nodeId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function placementNotes(placement: string | null): string[] {
  const parsed = JSON.parse(placement ?? '{}') as { diagnostics?: { notes?: string[] } };
  return parsed.diagnostics?.notes ?? [];
}

describe('a node provisioned for a task admits that task', () => {
  it('resolves the shared defaults through the real resolver', () => {
    expect(DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB).toBe(1024);
    expect(resolveWorkspaceAdmissionPolicy(env as never).hostMemoryReserveMb).toBe(1024);
    expect(DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS).toBe(3);
  });

  it('places a task at the documented cap on the cx23 it provisioned', async () => {
    const nodeId = 'node-provisioned-at-cap';
    const taskId = 'task-provisioned-at-cap';
    // 14% of 4096 = 573 MB, the production average for an idle 4 GB host. The old formula
    // needed 573 + 512 + 3072 = 4157 MB of a 4096 MB node and refused it forever.
    await seedProvisionedCx23(nodeId, taskId, { memoryPercent: 14 });
    // One refusal below the cap is already on the run; a success must end that episode.
    await startAtWorkspaceCreation(taskId, nodeId, DOCUMENTED_CAP_MEMORY_MB, 2);

    const { ran, state } = await fireAlarm(taskId);

    expect(ran).toBe('workspace_creation');
    expect(state.currentStep).toBe('workspace_dispatch');
    expect(state.stepResults.nodeId).toBe(nodeId);
    expect(state.workspacePlacementRejections).toBe(0);
    const task = await taskRow(taskId);
    expect(task).toMatchObject({ status: 'delegated', errorMessage: null });
    expect(task?.workspaceId).toBeTruthy();
    expect(await activeWorkspacesOn(nodeId)).toBe(1);
  });

  it('still refuses measured use above the reserve, then fails fast after the cap and hands the node off', async () => {
    const nodeId = 'node-provisioned-overrun';
    const taskId = 'task-provisioned-overrun';
    // 60% = 2458 MB that no workspace observation explains (a leak or an orphaned container).
    // Declared accounting fits (1024 + 3072 = 4096); only the measured overrun refuses it.
    await seedProvisionedCx23(nodeId, taskId, { memoryPercent: 60 });
    await startAtWorkspaceCreation(taskId, nodeId, DOCUMENTED_CAP_MEMORY_MB);

    const ran: string[] = [];
    let state: TaskRunnerState | null = null;
    // More alarms than the loop needs: the pre-fix runner never completes within them.
    for (let i = 0; i < 40; i++) {
      const fired = await fireAlarm(taskId);
      ran.push(fired.ran);
      state = fired.state;
      if (state.completed) break;
    }

    // The real loop ran: each refusal went back through selection, adoption and readiness.
    const creations = ran.filter((step) => step === 'workspace_creation').length;
    expect(creations).toBe(DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS);
    expect(ran.length).toBeGreaterThan(DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS);
    expect(ran).toEqual(expect.arrayContaining(['node_selection', 'node_agent_ready']));
    expect(state?.completed).toBe(true);
    // The node stays on the run so failure cleanup hands it off rather than orphaning it.
    expect(state?.stepResults).toMatchObject({ nodeId, autoProvisioned: true });

    const task = await taskRow(taskId);
    expect(task?.status).toBe('failed');
    expect(task?.errorMessage).toContain(
      `refused ${DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS} times in a row`
    );
    expect(task?.errorMessage).toContain(MEASURED_MEMORY_OVERRUN_REASON);
    const notes = placementNotes(task?.placement ?? null);
    expect(notes.filter((note) => note.startsWith(WORKSPACE_PLACEMENT_REFUSED_NOTE_PREFIX))).toEqual([
      expect.stringContaining(
        `(${DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS}/${DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS} consecutive): ${MEASURED_MEMORY_OVERRUN_REASON}`
      ),
    ]);

    expect(await activeWorkspacesOn(nodeId)).toBe(0);
    const node = await env.DATABASE.prepare(`SELECT status, warm_since AS warmSince FROM nodes WHERE id = ?`)
      .bind(nodeId)
      .first<{ status: string; warmSince: string | null }>();
    expect(node?.status).toBe('running');
    expect(node?.warmSince).toBeTruthy();
  });

  it('does not count a busy build queue against the cap', async () => {
    const nodeId = 'node-provisioned-busy-build';
    const taskId = 'task-provisioned-busy-build';
    await seedProvisionedCx23(nodeId, taskId, { memoryPercent: 14, creatingWorkspaces: 1 });
    await startAtWorkspaceCreation(taskId, nodeId, 1024, DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS - 1);

    const { ran, state } = await fireAlarm(taskId);

    expect(ran).toBe('workspace_creation');
    // A survivable wait: back to selection, which defers on the build queue, not a failure.
    expect(state.completed).toBe(false);
    expect(state.currentStep).toBe('node_selection');
    expect(state.workspacePlacementRejections).toBe(DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS - 1);
    const task = await taskRow(taskId);
    expect(task?.status).toBe('queued');
    expect(placementNotes(task?.placement ?? null)).toEqual(
      expect.arrayContaining([expect.stringContaining(WORKSPACE_BUSY_BUILD_QUEUE_REASON)])
    );
  });
});
