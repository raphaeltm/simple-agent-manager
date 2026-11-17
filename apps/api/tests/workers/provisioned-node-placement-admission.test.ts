/**
 * A node auto-provisioned for a task must admit that task, and a node that cannot must
 * get one bounded fallback to normal placement instead of spinning in a replan loop.
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
import {
  DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB,
  DEFAULT_WORKSPACE_PLACEMENT_BACKLOG_CONFLICT_RETRIES,
  DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS,
  MEASURED_MEMORY_OVERRUN_REASON,
  resolveWorkspaceAdmissionPolicy,
} from '@simple-agent-manager/scheduler-core';
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type {
  StartTaskInput,
  TaskRunner,
  TaskRunnerState,
} from '../../src/durable-objects/task-runner';
import {
  STARTUP_BACKLOG_CONFLICT_REASON,
  WORKSPACE_PLACEMENT_REFUSED_NOTE_PREFIX,
} from '../../src/durable-objects/task-runner/workspace-placement-rejection';
import type { Env } from '../../src/env';
import { invalidateAdminSettings } from '../../src/services/admin-settings-resolution';
import { isNodePastLifetimeAdmissionCutoff } from '../../src/services/node-lifetime-admission';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const USER_ID = 'user-provisioned-admission';
const INSTALLATION_ID = 'installation-provisioned-admission';
const PROJECT_ID = 'project-provisioned-admission';
/** The documented dispatch ceiling for a 4 GB machine (`.claude/rules/09`): 4096 - 1024. */
const DOCUMENTED_CAP_MEMORY_MB = 3072;
const CX23_MEMORY_MB = 4096;
/** A co-tenant small enough that a shared start still fits a cx23 beside it. */
const SIBLING_RESERVATION = {
  cpuMillis: 500,
  memoryMb: 512,
  diskMb: 1024,
  exclusiveNode: false,
  source: 'platform',
  sourceId: 'platform',
  version: 1,
};

beforeAll(async () => {
  await seedUser(USER_ID);
  await seedInstallation(INSTALLATION_ID, USER_ID);
  await seedProject(PROJECT_ID, USER_ID, INSTALLATION_ID);
});

/** A healthy, heartbeating cx23 that this task provisioned, reporting `memoryPercent`. */
async function seedProvisionedCx23(
  nodeId: string,
  taskId: string,
  metrics: { memoryPercent: number; creatingWorkspaces?: number; memoryMb?: number }
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
      metrics.memoryMb ?? CX23_MEMORY_MB,
      metrics.memoryMb ?? CX23_MEMORY_MB,
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

function taskRunnerInput(
  taskId: string,
  memoryMb: number,
  preferredNodeId: string | null = null
): StartTaskInput {
  return {
    taskId,
    projectId: PROJECT_ID,
    userId: USER_ID,
    config: {
      vmSize: 'small',
      vmLocation: 'nbg1',
      branch: 'main',
      preferredNodeId,
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

/** Keep immediate production alarms from racing this test's explicitly stepped alarms. */
async function withPausedAlarms<T>(
  taskId: string,
  fn: (instance: TaskRunner) => Promise<T>
): Promise<T> {
  return runInDurableObject(taskRunner(taskId), (instance) =>
    instance.ctx.blockConcurrencyWhile(() => fn(instance))
  );
}

/** Start the runner as if node_provisioning had just handed it the node it created. */
async function startAtWorkspaceCreation(
  taskId: string,
  nodeId: string,
  memoryMb: number,
  options: {
    priorRejections?: number;
    priorFallback?: boolean;
    preferred?: boolean;
    /** Share the node with other workspaces: a small, non-exclusive reservation. */
    shared?: boolean;
    rankedStartupBacklog?: TaskRunnerState['stepResults']['rankedStartupBacklog'];
    startupBacklogConflicts?: number;
  } = {}
): Promise<void> {
  const preferred = options.preferred === true;
  await withPausedAlarms(taskId, async (instance) => {
    await instance.start(taskRunnerInput(taskId, memoryMb, preferred ? nodeId : null));
    await instance.ctx.storage.deleteAlarm();
    const state = await instance.ctx.storage.get<TaskRunnerState>('state');
    if (!state) throw new Error('TaskRunner state was not initialized');
    state.currentStep = 'workspace_creation';
    state.stepResults.nodeId = nodeId;
    // A specified node is one the user already had, not one this run provisioned.
    state.stepResults.autoProvisioned = !preferred;
    state.provisioningStartedAt = Date.now();
    state.workspacePlacementRejections = options.priorRejections ?? 0;
    if (options.priorFallback) state.rejectedAutoProvisionedNodeId = 'earlier-rejected-node';
    if (options.shared && state.config.resolvedReservation) {
      state.config.resolvedReservation = {
        ...state.config.resolvedReservation,
        cpuMillis: 500,
        exclusiveNode: false,
      };
    }
    state.stepResults.rankedStartupBacklog = options.rankedStartupBacklog ?? null;
    state.startupBacklogConflicts = options.startupBacklogConflicts ?? 0;
    await instance.ctx.storage.put('state', state);
  });
}

/** Fire the runner's alarm once; returns the step it ran and the state it left. */
async function fireAlarm(taskId: string): Promise<{ ran: string; state: TaskRunnerState }> {
  return withPausedAlarms(taskId, async (instance) => {
    const before = await instance.ctx.storage.get<TaskRunnerState>('state');
    await instance.alarm();
    await instance.ctx.storage.deleteAlarm();
    const after = await instance.ctx.storage.get<TaskRunnerState>('state');
    if (!before || !after) throw new Error('TaskRunner state missing');
    return { ran: before.currentStep, state: after };
  });
}

/** The node's next heartbeat reports a new memory reading. */
async function reportMemoryPercent(nodeId: string, memoryPercent: number): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE nodes SET last_heartbeat_at = ?, last_metrics = json_set(last_metrics, '$.memoryPercent', ?)
     WHERE id = ?`
  )
    .bind(new Date().toISOString(), memoryPercent, nodeId)
    .run();
}

async function warmSince(nodeId: string): Promise<string | null> {
  const node = await env.DATABASE.prepare(`SELECT warm_since AS warmSince FROM nodes WHERE id = ?`)
    .bind(nodeId)
    .first<{ warmSince: string | null }>();
  return node?.warmSince ?? null;
}

const MAX_REJECTIONS_SETTING = 'operations.workspacePlacementMaxRejections';

/** Persist an admin override the way the settings UI does, then drop the per-isolate cache. */
async function setMaxRejections(value: number | null): Promise<void> {
  await env.DATABASE.prepare('DELETE FROM platform_settings WHERE key = ?')
    .bind(MAX_REJECTIONS_SETTING)
    .run();
  if (value !== null) {
    await env.DATABASE.prepare(
      'INSERT INTO platform_settings(key, value, updated_at, updated_by) VALUES (?, ?, ?, NULL)'
    )
      .bind(MAX_REJECTIONS_SETTING, String(value), new Date().toISOString())
      .run();
  }
  invalidateAdminSettings(env as unknown as Env);
}

/** Fire alarms until the run completes; returns the steps it ran. */
async function runToCompletion(taskId: string): Promise<{ ran: string[]; state: TaskRunnerState }> {
  const ran: string[] = [];
  let state: TaskRunnerState | null = null;
  for (let i = 0; i < 60; i++) {
    const fired = await fireAlarm(taskId);
    ran.push(fired.ran);
    state = fired.state;
    if (state.completed) break;
  }
  if (!state) throw new Error('TaskRunner never ran');
  return { ran, state };
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
  afterEach(async () => {
    await setMaxRejections(null);
  });

  it('resolves the shared defaults through the real resolver', () => {
    expect(DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB).toBe(1024);
    expect(resolveWorkspaceAdmissionPolicy(env as never).hostMemoryReserveMb).toBe(1024);
    expect(DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS).toBe(3);
  });

  it('places a task at the documented cap on the cx23 it provisioned, ending a refusal episode', async () => {
    const nodeId = 'node-provisioned-at-cap';
    const taskId = 'task-provisioned-at-cap';
    // Start with a transient spike (60%) so two real refusals land on the run first.
    await seedProvisionedCx23(nodeId, taskId, { memoryPercent: 60 });
    await startAtWorkspaceCreation(taskId, nodeId, DOCUMENTED_CAP_MEMORY_MB);
    let state: TaskRunnerState | null = null;
    for (let i = 0; i < 40 && (state?.workspacePlacementRejections ?? 0) < 2; i++) {
      state = (await fireAlarm(taskId)).state;
    }
    expect(state?.workspacePlacementRejections).toBe(2);
    expect(state?.completed).toBe(false);

    // The host settles at 14% (573 MB), the production average for an idle 4 GB host. The old
    // formula needed 573 + 512 + 3072 = 4157 MB of a 4096 MB node and refused it forever.
    await reportMemoryPercent(nodeId, 14);
    const ran: string[] = [];
    for (let i = 0; i < 40 && state?.currentStep !== 'workspace_dispatch'; i++) {
      const fired = await fireAlarm(taskId);
      ran.push(fired.ran);
      state = fired.state;
    }

    expect(ran).toContain('workspace_creation');
    expect(state?.currentStep).toBe('workspace_dispatch');
    expect(state?.stepResults.nodeId).toBe(nodeId);
    // A reservation that succeeds ends the refusal episode (rule 61).
    expect(state?.workspacePlacementRejections).toBe(0);
    const task = await taskRow(taskId);
    expect(task).toMatchObject({ status: 'delegated', errorMessage: null });
    expect(task?.workspaceId).toBeTruthy();
    expect(await activeWorkspacesOn(nodeId)).toBe(1);
  });

  it.each([
    ['ranked', false],
    ['ranked', true],
    ['pinned', false],
    ['pinned', true],
    ['warm', false],
    ['warm', true],
  ] as const)('holds A’s 8 GB booting node from B (%s, exclusive: %s)', async (path, exclusive) => {
    const nodeId = `node-booting-owner-a-${path}-${exclusive}`;
    const ownerId = `task-booting-owner-a-${path}-${exclusive}`;
    const contenderId = `task-booting-contender-b-${path}-${exclusive}`;
    await seedProvisionedCx23(nodeId, ownerId, { memoryPercent: 10, memoryMb: 8192 });
    await env.DATABASE.prepare("UPDATE nodes SET status = 'creating' WHERE id = ?")
      .bind(nodeId)
      .run();
    await seedTask(contenderId, PROJECT_ID, USER_ID, { status: 'queued', taskMode: 'task' });
    await startAtWorkspaceCreation(ownerId, nodeId, 4096, { shared: !exclusive });
    await withPausedAlarms(contenderId, async (instance) => {
      const input = taskRunnerInput(contenderId, 4096, path === 'pinned' ? nodeId : null);
      if (input.config.resolvedReservation)
        input.config.resolvedReservation.exclusiveNode = exclusive;
      await instance.start(input);
      await instance.ctx.storage.deleteAlarm();
      const state = await instance.ctx.storage.get<TaskRunnerState>('state');
      if (!state) throw new Error('Missing contender state');
      state.currentStep = 'node_selection';
      await instance.ctx.storage.put('state', state);
    });
    // N becomes ready before B selects capacity, as in the production incident.
    await env.DATABASE.prepare("UPDATE nodes SET status = 'running' WHERE id = ?")
      .bind(nodeId)
      .run();
    if (path === 'warm')
      await env.DATABASE.prepare('UPDATE nodes SET warm_since = ? WHERE id = ?')
        .bind(new Date().toISOString(), nodeId)
        .run();
    const contender = (await fireAlarm(contenderId)).state;
    expect(contender.stepResults.nodeId).not.toBe(nodeId);
    if (path === 'pinned') expect(contender.completed).toBe(true);
    else expect(contender.currentStep).toBe('node_provisioning');
    expect(await activeWorkspacesOn(nodeId)).toBe(0);
    const owner = (await fireAlarm(ownerId)).state;
    expect(owner.currentStep).toBe('workspace_dispatch');
    expect(owner.stepResults.nodeId).toBe(nodeId);
    expect(await activeWorkspacesOn(nodeId)).toBe(1);
  });

  it.each(['normal', 'intent', 'released'] as const)(
    'falls back from a full provisioned node (resuming interrupted fallback: %s)',
    async (resuming) => {
      const nodeId = `node-full-owned-${resuming}`;
      const taskId = `task-full-owned-${resuming}`;
      const alternativeId = `node-idle-alternative-${resuming}`;
      await seedProvisionedCx23(nodeId, taskId, { memoryPercent: 14 });
      await seedWorkspace(`ws-full-owned-sibling-${resuming}`, nodeId, USER_ID, {
        projectId: PROJECT_ID,
        status: 'running',
        resolvedReservationJson: JSON.stringify({ ...SIBLING_RESERVATION, memoryMb: 2048 }),
      });
      await startAtWorkspaceCreation(taskId, nodeId, DOCUMENTED_CAP_MEMORY_MB, {
        priorRejections: DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS - 1,
      });
      if (resuming !== 'normal') {
        await withPausedAlarms(taskId, async (instance) => {
          const state = await instance.ctx.storage.get<TaskRunnerState>('state');
          if (!state) throw new Error('Missing state');
          state.rejectedAutoProvisionedNodeId = nodeId;
          await instance.ctx.storage.put('state', state);
        });
      }
      if (resuming === 'released') {
        await env.DATABASE.prepare('UPDATE nodes SET task_provisioned = 1 WHERE id = ?')
          .bind(nodeId)
          .run();
        await env.DATABASE.prepare('UPDATE tasks SET auto_provisioned_node_id = NULL WHERE id = ?')
          .bind(taskId)
          .run();
      }
      await seedProvisionedCx23(alternativeId, `task-alternative-finished-${resuming}`, {
        memoryPercent: 14,
      });
      await env.DATABASE.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?")
        .bind(`task-alternative-finished-${resuming}`)
        .run();
      let state: TaskRunnerState | undefined;
      for (let i = 0; i < 40; i++) {
        state = (await fireAlarm(taskId)).state;
        if (state.completed || state.currentStep === 'workspace_dispatch') break;
      }
      expect(state?.completed).toBe(false);
      expect(state?.currentStep).toBe('workspace_dispatch');
      expect(state?.stepResults.nodeId).toBe(alternativeId);
      expect((await taskRow(taskId))?.status).toBe('delegated');
      expect(await activeWorkspacesOn(nodeId)).toBe(1);
      expect(await warmSince(nodeId)).toBeNull();
      expect(
        await env.DATABASE.prepare('SELECT status FROM nodes WHERE id = ?')
          .bind(nodeId)
          .first('status')
      ).toBe('running');
      expect(await activeWorkspacesOn(alternativeId)).toBe(1);
      const owner = await env.DATABASE.prepare(
        'SELECT auto_provisioned_node_id AS nodeId FROM tasks WHERE id = ?'
      )
        .bind(taskId)
        .first<{ nodeId: string | null }>();
      expect(owner?.nodeId).toBeNull();
      expect(
        await env.DATABASE.prepare('SELECT task_provisioned FROM nodes WHERE id = ?')
          .bind(nodeId)
          .first('task_provisioned')
      ).toBe(1);
    }
  );

  it('fails a specified node on its first refusal and leaves that node alone', async () => {
    const nodeId = 'node-specified-overrun';
    const taskId = 'task-specified-overrun';
    await seedProvisionedCx23(nodeId, taskId, { memoryPercent: 60 });
    await startAtWorkspaceCreation(taskId, nodeId, DOCUMENTED_CAP_MEMORY_MB, { preferred: true });

    const { ran, state } = await fireAlarm(taskId);

    expect(ran).toBe('workspace_creation');
    expect(state.completed).toBe(true);
    const task = await taskRow(taskId);
    expect(task?.status).toBe('failed');
    expect(task?.errorMessage).toContain(
      'Specified node lost capacity or became unavailable before workspace creation'
    );
    expect(placementNotes(task?.placement ?? null)).toEqual(
      expect.arrayContaining([expect.stringContaining(`(1/`)])
    );
    // The user's own node is neither occupied nor sent to the warm pool by this failure.
    expect(await activeWorkspacesOn(nodeId)).toBe(0);
    expect(await warmSince(nodeId)).toBeNull();
  });

  it.each([1, 5])('spends one real fallback then exhausts the replacement budget (%i)', async (limit) => {
    await setMaxRejections(limit);
    const nodeId = `node-first-fallback-${limit}`;
    const replacementId = `node-second-fallback-${limit}`;
    const taskId = `task-real-fallback-budget-${limit}`;
    await seedProvisionedCx23(nodeId, taskId, { memoryPercent: 60 });
    await startAtWorkspaceCreation(taskId, nodeId, DOCUMENTED_CAP_MEMORY_MB);
    let state: TaskRunnerState | undefined;
    for (let i = 0; i < 40; i++) {
      state = (await fireAlarm(taskId)).state;
      if (state.rejectedAutoProvisionedNodeId || state.completed) break;
    }
    expect(state?.completed).toBe(false);
    expect(state?.rejectedAutoProvisionedNodeId).toBe(nodeId);
    expect(state?.workspacePlacementRejections).toBe(0);
    // Simulate the provider/readiness boundary for the normally admitted replacement; no
    // paid provider is involved. Its measured pressure still cannot admit the owner.
    await seedProvisionedCx23(replacementId, `finished-replacement-owner-${limit}`, { memoryPercent: 60 });
    await env.DATABASE.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").bind(`finished-replacement-owner-${limit}`).run();
    await env.DATABASE.prepare('UPDATE tasks SET auto_provisioned_node_id = ? WHERE id = ?').bind(replacementId, taskId).run();
    await withPausedAlarms(taskId, async (instance) => {
      const persisted = (await instance.ctx.storage.get<TaskRunnerState>('state'))!;
      expect(persisted.rejectedAutoProvisionedNodeId).toBe(nodeId);
      persisted.stepResults.nodeId = replacementId;
      persisted.stepResults.autoProvisioned = true;
      persisted.currentStep = 'workspace_creation';
      await instance.ctx.storage.put('state', persisted);
    });
    const result = await runToCompletion(taskId);
    expect(result.state.completed).toBe(true);
    expect(result.state.rejectedAutoProvisionedNodeId).toBe(nodeId);
    expect(result.ran.filter((step) => step === 'workspace_creation')).toHaveLength(limit);
    expect((await taskRow(taskId))?.errorMessage).toContain(`refused ${limit} times in a row`);
    expect(await env.DATABASE.prepare('SELECT COUNT(*) FROM nodes WHERE user_id = ?').bind(USER_ID).first('COUNT(*)')).toBe(2);
  });

  it.each([false, true])('does not re-adopt a rejected node from a stale D1 pointer (rejected: %s)', async (rejected) => {
    const nodeId = `node-crash-readoption-${rejected}`;
    const taskId = `task-crash-readoption-${rejected}`;
    await seedProvisionedCx23(nodeId, taskId, { memoryPercent: 14 });
    await startAtWorkspaceCreation(taskId, nodeId, DOCUMENTED_CAP_MEMORY_MB);
    await withPausedAlarms(taskId, async (instance) => {
      const persisted = (await instance.ctx.storage.get<TaskRunnerState>('state'))!;
      persisted.currentStep = 'node_provisioning';
      persisted.stepResults.nodeId = null;
      persisted.stepResults.autoProvisioned = false;
      if (rejected) persisted.rejectedAutoProvisionedNodeId = nodeId;
      await instance.ctx.storage.put('state', persisted);
    });
    const { state } = await fireAlarm(taskId);
    if (rejected) {
      expect(state.stepResults.nodeId).toBeNull();
      expect(state.completed).toBe(true); // No alternative or cloud credential in this fixture.
    } else {
      expect(state.stepResults.nodeId).toBe(nodeId);
      expect(state.completed).toBe(false);
    }
  });

  it('hands an empty rejected host to warm retention and keeps lifetime/cleanup provenance after replacement', async () => {
    const nodeId = 'node-empty-rejected';
    const taskId = 'task-empty-rejected';
    await seedProvisionedCx23(nodeId, taskId, { memoryPercent: 60 });
    await startAtWorkspaceCreation(taskId, nodeId, DOCUMENTED_CAP_MEMORY_MB, {
      priorRejections: DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS - 1,
    });
    const { state } = await fireAlarm(taskId);
    expect(state.currentStep).toBe('node_selection');
    expect(state.rejectedAutoProvisionedNodeId).toBe(nodeId);
    // Legacy unpooled fixture has no other teardown provenance: this requires retained history.
    expect(await warmSince(nodeId)).toBeTruthy();
    await env.DATABASE.prepare(
      "UPDATE nodes SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
    )
      .bind(nodeId)
      .run();
    expect(await isNodePastLifetimeAdmissionCutoff(env.DATABASE, nodeId, 1000)).toBe(true);
    await seedNode('node-replacement-provenance', USER_ID);
    await env.DATABASE.prepare('UPDATE tasks SET auto_provisioned_node_id = ? WHERE id = ?')
      .bind('node-replacement-provenance', taskId)
      .run();
    expect(await isNodePastLifetimeAdmissionCutoff(env.DATABASE, nodeId, 1000)).toBe(true);
    // Full migration chain: node deletion nulls history without deleting the task or resetting
    // the DO's consumed fallback budget.
    await env.DATABASE.prepare('DELETE FROM nodes WHERE id = ?').bind(nodeId).run();
    expect(await taskRow(taskId)).not.toBeNull();
    await withPausedAlarms(taskId, async (instance) => {
      expect(
        (await instance.ctx.storage.get<TaskRunnerState>('state'))?.rejectedAutoProvisionedNodeId
      ).toBe(nodeId);
    });
  });

  it('bounds fallback by failing at the cap after a prior provisioned-node fallback', async () => {
    const nodeId = 'node-provisioned-overrun';
    const taskId = 'task-provisioned-overrun';
    // 60% = 2458 MB that no workspace observation explains (a leak or an orphaned container).
    // Declared accounting fits (1024 + 3072 = 4096); only the measured overrun refuses it.
    await seedProvisionedCx23(nodeId, taskId, { memoryPercent: 60 });
    await startAtWorkspaceCreation(taskId, nodeId, DOCUMENTED_CAP_MEMORY_MB, {
      priorFallback: true,
    });

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
    expect(
      notes.filter((note) => note.startsWith(WORKSPACE_PLACEMENT_REFUSED_NOTE_PREFIX))
    ).toEqual([
      expect.stringContaining(
        `(${DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS}/${DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS} consecutive): ${MEASURED_MEMORY_OVERRUN_REASON}`
      ),
    ]);

    expect(await activeWorkspacesOn(nodeId)).toBe(0);
    expect(await warmSince(nodeId)).toBeTruthy();
  });

  it('reserves on a node that is building another workspace instead of refusing it', async () => {
    const nodeId = 'node-provisioned-busy-build';
    const taskId = 'task-provisioned-busy-build';
    await seedProvisionedCx23(nodeId, taskId, { memoryPercent: 14, creatingWorkspaces: 1 });
    await seedWorkspace('ws-building-sibling', nodeId, USER_ID, {
      projectId: PROJECT_ID,
      status: 'creating',
      resolvedReservationJson: JSON.stringify(SIBLING_RESERVATION),
    });
    await startAtWorkspaceCreation(taskId, nodeId, 512, {
      shared: true,
      priorRejections: DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS - 1,
    });

    const { ran, state } = await fireAlarm(taskId);

    expect(ran).toBe('workspace_creation');
    expect(state.currentStep).toBe('workspace_dispatch');
    expect(state.workspacePlacementRejections).toBe(0);
    expect(await activeWorkspacesOn(nodeId)).toBe(2);
  });

  describe('startup backlog conflicts', () => {
    async function seedQueuedNode(nodeId: string, taskId: string): Promise<void> {
      await seedProvisionedCx23(nodeId, taskId, { memoryPercent: 14, creatingWorkspaces: 1 });
      // Another run reserved this node after ours ranked it with an empty queue.
      await seedWorkspace(`ws-queued-${nodeId}`, nodeId, USER_ID, {
        projectId: PROJECT_ID,
        status: 'creating',
        resolvedReservationJson: JSON.stringify(SIBLING_RESERVATION),
      });
    }

    it('replans without spending the rejection budget when the queue grew after ranking', async () => {
      const nodeId = 'node-backlog-conflict';
      const taskId = 'task-backlog-conflict';
      await seedQueuedNode(nodeId, taskId);
      await startAtWorkspaceCreation(taskId, nodeId, 512, {
        shared: true,
        priorRejections: DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS - 1,
        rankedStartupBacklog: { nodeId, backlog: 0 },
      });

      const { ran, state } = await fireAlarm(taskId);

      expect(ran).toBe('workspace_creation');
      // Fairness, not capacity: no failure, no budget spent, a fresh selection next.
      expect(state.completed).toBe(false);
      expect(state.currentStep).toBe('node_selection');
      expect(state.workspacePlacementRejections).toBe(
        DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS - 1
      );
      expect(state.startupBacklogConflicts).toBe(1);
      expect(state.stepResults.rankedStartupBacklog).toBeNull();
      expect(await activeWorkspacesOn(nodeId)).toBe(1);
      const task = await taskRow(taskId);
      expect(task?.status).toBe('queued');
      expect(placementNotes(task?.placement ?? null)).toEqual(
        expect.arrayContaining([expect.stringContaining(STARTUP_BACKLOG_CONFLICT_REASON)])
      );
    });

    it('drops only the fairness guard after the configured number of conflicts, then resets', async () => {
      expect(DEFAULT_WORKSPACE_PLACEMENT_BACKLOG_CONFLICT_RETRIES).toBe(3);
      const nodeId = 'node-backlog-fallback';
      const taskId = 'task-backlog-fallback';
      await seedQueuedNode(nodeId, taskId);
      await startAtWorkspaceCreation(taskId, nodeId, 512, {
        shared: true,
        rankedStartupBacklog: { nodeId, backlog: 0 },
        startupBacklogConflicts: DEFAULT_WORKSPACE_PLACEMENT_BACKLOG_CONFLICT_RETRIES,
      });

      const { state } = await fireAlarm(taskId);

      expect(state.currentStep).toBe('workspace_dispatch');
      expect(state.startupBacklogConflicts).toBe(0);
      expect(await activeWorkspacesOn(nodeId)).toBe(2);
    });

    it('keeps the guard one conflict short of the bound', async () => {
      const nodeId = 'node-backlog-before-fallback';
      const taskId = 'task-backlog-before-fallback';
      await seedQueuedNode(nodeId, taskId);
      await startAtWorkspaceCreation(taskId, nodeId, 512, {
        shared: true,
        rankedStartupBacklog: { nodeId, backlog: 0 },
        startupBacklogConflicts: DEFAULT_WORKSPACE_PLACEMENT_BACKLOG_CONFLICT_RETRIES - 1,
      });

      const { state } = await fireAlarm(taskId);

      expect(state.currentStep).toBe('node_selection');
      expect(state.workspacePlacementRejections ?? 0).toBe(0);
      expect(state.startupBacklogConflicts).toBe(
        DEFAULT_WORKSPACE_PLACEMENT_BACKLOG_CONFLICT_RETRIES
      );
      expect(await activeWorkspacesOn(nodeId)).toBe(1);
    });

    it('ignores a backlog observed for a different node', async () => {
      const nodeId = 'node-backlog-other-node';
      const taskId = 'task-backlog-other-node';
      await seedQueuedNode(nodeId, taskId);
      await startAtWorkspaceCreation(taskId, nodeId, 512, {
        shared: true,
        rankedStartupBacklog: { nodeId: 'some-other-node', backlog: 0 },
      });

      const { state } = await fireAlarm(taskId);

      expect(state.currentStep).toBe('workspace_dispatch');
      expect(await activeWorkspacesOn(nodeId)).toBe(2);
    });
  });

  it.each([1, 5])('fails after exactly the configured %i consecutive refusals', async (limit) => {
    const nodeId = `node-provisioned-limit-${limit}`;
    const taskId = `task-provisioned-limit-${limit}`;
    await seedProvisionedCx23(nodeId, taskId, { memoryPercent: 60 });
    await setMaxRejections(limit);
    await startAtWorkspaceCreation(taskId, nodeId, DOCUMENTED_CAP_MEMORY_MB, {
      priorFallback: true,
    });

    const { ran, state } = await runToCompletion(taskId);

    // A handler hard-coded to the default would stop after 3 here, not 1 or 5.
    expect(ran.filter((step) => step === 'workspace_creation')).toHaveLength(limit);
    expect(state.completed).toBe(true);
    const task = await taskRow(taskId);
    expect(task?.status).toBe('failed');
    expect(task?.errorMessage).toContain(`refused ${limit} times in a row`);
  });
});
