/**
 * Startup-backlog placement through the real TaskRunner Durable Object and real D1.
 *
 * 2026-11-08 production: a chat waited 17 minutes for one node's build slot behind five
 * setups while the ranking preferred that node. The TaskRunner now ranks admitted nodes by
 * their D1 startup backlog and guards the final reservation against the backlog growing in
 * between. These tests start a run at node_selection and fire its real alarms:
 * selection → reservation → (conflict → reselection) → placement.
 */
import {
  DEFAULT_WORKSPACE_PLACEMENT_BACKLOG_CONFLICT_RETRIES,
} from '@simple-agent-manager/scheduler-core';
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  StartTaskInput,
  TaskRunner,
  TaskRunnerState,
} from '../../src/durable-objects/task-runner';
import { STARTUP_BACKLOG_CONFLICT_REASON } from '../../src/durable-objects/task-runner/workspace-placement-rejection';
import type { Env } from '../../src/env';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const USER_ID = 'user-backlog-loop';
const INSTALLATION_ID = 'installation-backlog-loop';
const PROJECT_ID = 'project-backlog-loop';
const MEMORY_MB = 4096;
const SMALL_RESERVATION = {
  cpuMillis: 500,
  memoryMb: 512,
  diskMb: 1024,
  exclusiveNode: false,
  source: 'task',
  sourceId: 'task',
  version: 1,
} as const;

beforeAll(async () => {
  await seedUser(USER_ID);
  await seedInstallation(INSTALLATION_ID, USER_ID);
  await seedProject(PROJECT_ID, USER_ID, INSTALLATION_ID);
});

/** A healthy, heartbeating cx23 reusable by any run of this user. */
async function seedReadyCx23(
  nodeId: string,
  metrics: Partial<{ diskPercent: number }> = {}
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
       observed_hardware_source = 'observed', agent_ready_at = ?, agent_version = ?,
       last_metrics = ?
     WHERE id = ?`
  )
    .bind(
      `server-${nodeId}`,
      MEMORY_MB,
      MEMORY_MB,
      now,
      env.VM_AGENT_REQUIRED_VERSION ?? null,
      JSON.stringify({
        version: 1,
        cpuLoadAvg1: 0,
        memoryPercent: 14,
        diskPercent: metrics.diskPercent ?? 19.5,
        // Heartbeats report a build in progress on both: only D1 knows how deep each queue is.
        creatingWorkspaces: 1,
      }),
      nodeId
    )
    .run();
}

async function queueStartupOn(nodeId: string, workspaceId: string): Promise<void> {
  await seedWorkspace(workspaceId, nodeId, USER_ID, {
    projectId: PROJECT_ID,
    status: 'creating',
    resolvedReservationJson: JSON.stringify({ ...SMALL_RESERVATION, source: 'platform' }),
  });
}

function runnerInput(taskId: string): StartTaskInput {
  return {
    taskId,
    projectId: PROJECT_ID,
    userId: USER_ID,
    config: {
      vmSize: 'small',
      vmLocation: 'nbg1',
      explicitVmLocation: false,
      branch: 'main',
      preferredNodeId: null,
      userName: 'Backlog Loop Test',
      userEmail: 'backlog-loop@example.com',
      githubId: null,
      taskTitle: taskId,
      taskDescription: null,
      repository: 'test-org/backlog-loop',
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
      resolvedReservation: { ...SMALL_RESERVATION },
    },
  };
}

function taskRunner(taskId: string): DurableObjectStub<TaskRunner> {
  return env.TASK_RUNNER.get(env.TASK_RUNNER.idFromName(taskId)) as DurableObjectStub<TaskRunner>;
}

async function startAtNodeSelection(taskId: string): Promise<void> {
  await seedTask(taskId, PROJECT_ID, USER_ID, {
    status: 'queued',
    executionStep: 'node_selection',
    taskMode: 'task',
  });
  await runInDurableObject(taskRunner(taskId), async (instance) => {
    await instance.start(runnerInput(taskId));
    await instance.ctx.storage.deleteAlarm();
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

async function workspacesOf(taskId: string): Promise<Array<{ nodeId: string; status: string }>> {
  const task = await env.DATABASE.prepare(
    'SELECT workspace_id AS workspaceId FROM tasks WHERE id = ?'
  )
    .bind(taskId)
    .first<{ workspaceId: string | null }>();
  if (!task?.workspaceId) return [];
  const rows = await env.DATABASE.prepare(
    'SELECT node_id AS nodeId, status FROM workspaces WHERE id = ?'
  )
    .bind(task.workspaceId)
    .all<{ nodeId: string; status: string }>();
  return rows.results ?? [];
}

async function provisionedNodeCount(): Promise<number> {
  const row = await env.DATABASE.prepare(
    "SELECT COUNT(*) AS n FROM nodes WHERE user_id = ? AND id NOT LIKE 'node-loop-%'"
  )
    .bind(USER_ID)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('startup backlog placement loop', () => {
  // Every test seeds its own nodes for the same user; retire the previous test's nodes so they
  // are not candidates here.
  beforeEach(async () => {
    await env.DATABASE.prepare("UPDATE nodes SET status = 'stopped' WHERE user_id = ?")
      .bind(USER_ID)
      .run();
  });

  it('reselects the other node after losing the queue race, then places there', async () => {
    const nodeA = 'node-loop-a';
    const nodeB = 'node-loop-b';
    const taskId = 'task-backlog-loop';
    await seedReadyCx23(nodeA);
    await seedReadyCx23(nodeB);
    await queueStartupOn(nodeA, 'ws-loop-a-queued');
    await startAtNodeSelection(taskId);

    // 1. Selection: B has the shorter queue (0 against 1).
    let fired = await fireAlarm(taskId);
    expect(fired.ran).toBe('node_selection');
    expect(fired.state.currentStep).toBe('workspace_creation');
    expect(fired.state.stepResults.nodeId).toBe(nodeB);
    expect(fired.state.stepResults.rankedStartupBacklog).toEqual({ nodeId: nodeB, backlog: 0 });

    // Two other runs reserve B before this run's reservation lands.
    await queueStartupOn(nodeB, 'ws-loop-b-raced-1');
    await queueStartupOn(nodeB, 'ws-loop-b-raced-2');

    // 2. Reservation: refused as a fairness conflict, not as a capacity refusal.
    fired = await fireAlarm(taskId);
    expect(fired.ran).toBe('workspace_creation');
    expect(fired.state.completed).toBe(false);
    expect(fired.state.currentStep).toBe('node_selection');
    expect(fired.state.workspacePlacementRejections ?? 0).toBe(0);
    expect(fired.state.startupBacklogConflicts).toBe(1);
    expect(fired.state.stepResults.placementDiagnostics?.notes).toEqual(
      expect.arrayContaining([expect.stringContaining(STARTUP_BACKLOG_CONFLICT_REASON)])
    );

    // 3. Reselection: A's queue (1) is now shorter than B's (2).
    fired = await fireAlarm(taskId);
    expect(fired.ran).toBe('node_selection');
    expect(fired.state.stepResults.nodeId).toBe(nodeA);
    expect(fired.state.stepResults.rankedStartupBacklog).toEqual({ nodeId: nodeA, backlog: 1 });

    // 4. Placement on A; the conflict episode ends.
    fired = await fireAlarm(taskId);
    expect(fired.ran).toBe('workspace_creation');
    expect(fired.state.currentStep).toBe('workspace_dispatch');
    expect(fired.state.startupBacklogConflicts).toBe(0);
    expect(await workspacesOf(taskId)).toEqual([{ nodeId: nodeA, status: 'creating' }]);
    // Nothing was provisioned to relieve either queue.
    expect(await provisionedNodeCount()).toBe(0);
  });

  it('does not count a fairness refusal whose queue drained before the diagnostic re-read', async () => {
    const nodeA = 'node-loop-drain-a';
    const nodeB = 'node-loop-drain-b';
    const taskId = 'task-backlog-loop-drain';
    await seedReadyCx23(nodeA);
    await seedReadyCx23(nodeB);
    await queueStartupOn(nodeA, 'ws-loop-drain-a-queued');
    await startAtNodeSelection(taskId);
    const selected = await fireAlarm(taskId);
    expect(selected.state.stepResults.rankedStartupBacklog).toEqual({ nodeId: nodeB, backlog: 0 });

    // Another run reserves B, so the guarded INSERT is refused. Its build then finishes in the
    // window between that refusal and the handler's re-read: the re-read sees an empty queue.
    await queueStartupOn(nodeB, 'ws-loop-drain-b-raced');
    const fired = await runInDurableObject(taskRunner(taskId), async (instance) => {
      const realEnv = (instance as unknown as { env: Env }).env;
      const realDb = realEnv.DATABASE;
      let drained = false;
      const db = new Proxy(realDb, {
        get(target, prop) {
          if (prop !== 'prepare') {
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (sql: string) => {
            const statement = target.prepare(sql);
            // The refusal diagnostic's node read is the midpoint: drain the queue right before it.
            if (
              !drained &&
              sql.includes('last_heartbeat_at AS lastHeartbeatAt') &&
              sql.includes('FROM nodes WHERE id = ? AND user_id = ?')
            ) {
              drained = true;
              return new Proxy(statement, {
                get(stmt, key) {
                  const value = Reflect.get(stmt, key, stmt);
                  if (key !== 'bind') return typeof value === 'function' ? value.bind(stmt) : value;
                  return (...binds: unknown[]) => {
                    const bound = stmt.bind(...binds);
                    return {
                      first: async <T>() => {
                        await realDb
                          .prepare("UPDATE workspaces SET status = 'running' WHERE id = ?")
                          .bind('ws-loop-drain-b-raced')
                          .run();
                        return bound.first<T>();
                      },
                    };
                  };
                },
              });
            }
            return statement;
          };
        },
      });
      (instance as unknown as { env: Env }).env = { ...realEnv, DATABASE: db };
      try {
        await instance.alarm();
      } finally {
        (instance as unknown as { env: Env }).env = realEnv;
      }
      await instance.ctx.storage.deleteAlarm();
      const state = await instance.ctx.storage.get<TaskRunnerState>('state');
      if (!state) throw new Error('TaskRunner state missing');
      return { state, drained };
    });

    // Liveness: the hook ran, so the re-read really saw the drained queue.
    expect(fired.drained).toBe(true);
    expect(fired.state.completed).toBe(false);
    expect(fired.state.currentStep).toBe('node_selection');
    expect(fired.state.workspacePlacementRejections ?? 0).toBe(0);
    expect(fired.state.startupBacklogConflicts).toBe(1);
    const notes = fired.state.stepResults.placementDiagnostics?.notes ?? [];
    expect(notes).toEqual(
      expect.arrayContaining([expect.stringContaining('drained before this check')])
    );
    expect(await provisionedNodeCount()).toBe(0);
  });

  it('counts a real capacity refusal against the budget even when the queue also grew', async () => {
    const nodeId = 'node-loop-capacity';
    const otherNodeId = 'node-loop-capacity-other';
    const taskId = 'task-backlog-loop-capacity';
    await seedReadyCx23(nodeId);
    await seedReadyCx23(otherNodeId);
    await queueStartupOn(otherNodeId, 'ws-loop-capacity-other-queued');
    await startAtNodeSelection(taskId);
    const selected = await fireAlarm(taskId);
    expect(selected.state.stepResults.rankedStartupBacklog).toEqual({ nodeId, backlog: 0 });

    // The queue grows AND the node crosses the disk pressure veto before the reservation.
    await queueStartupOn(nodeId, 'ws-loop-capacity-raced');
    await env.DATABASE.prepare(
      `UPDATE nodes SET last_metrics = json_set(last_metrics, '$.diskPercent', 95) WHERE id = ?`
    )
      .bind(nodeId)
      .run();

    const fired = await fireAlarm(taskId);

    expect(fired.ran).toBe('workspace_creation');
    expect(fired.state.workspacePlacementRejections).toBe(1);
    expect(fired.state.startupBacklogConflicts ?? 0).toBe(0);
    const notes = fired.state.stepResults.placementDiagnostics?.notes ?? [];
    expect(notes).toEqual(
      expect.arrayContaining([expect.stringContaining('disk pressure threshold reached')])
    );
    expect(notes.join('\n')).not.toContain(STARTUP_BACKLOG_CONFLICT_REASON);
  });

  it('keeps every capacity guard after the bounded fallback drops the fairness guard', async () => {
    const unsafeNode = 'node-loop-fallback-unsafe';
    const safeNode = 'node-loop-fallback-safe';
    const taskId = 'task-backlog-loop-fallback';
    await seedReadyCx23(unsafeNode);
    await seedReadyCx23(safeNode);
    for (const index of [1, 2]) await queueStartupOn(safeNode, `ws-loop-fallback-safe-${index}`);
    await startAtNodeSelection(taskId);
    const selected = await fireAlarm(taskId);
    expect(selected.state.stepResults.nodeId).toBe(unsafeNode);

    // The run has used up its conflict budget, so the next reservation carries no backlog
    // guard; the chosen node then becomes unsafe (disk pressure) before that reservation.
    await runInDurableObject(taskRunner(taskId), async (instance) => {
      const state = await instance.ctx.storage.get<TaskRunnerState>('state');
      if (!state) throw new Error('TaskRunner state missing');
      state.startupBacklogConflicts = DEFAULT_WORKSPACE_PLACEMENT_BACKLOG_CONFLICT_RETRIES;
      await instance.ctx.storage.put('state', state);
    });
    await env.DATABASE.prepare(
      `UPDATE nodes SET last_metrics = json_set(last_metrics, '$.diskPercent', 95) WHERE id = ?`
    )
      .bind(unsafeNode)
      .run();

    const refused = await fireAlarm(taskId);
    expect(refused.ran).toBe('workspace_creation');
    expect(refused.state.currentStep).toBe('node_selection');
    expect(refused.state.workspacePlacementRejections).toBe(1);
    expect(await workspacesOf(taskId)).toEqual([]);

    // Reselection excludes the unsafe node despite its empty queue and places on the safe one.
    const reselected = await fireAlarm(taskId);
    expect(reselected.state.stepResults.nodeId).toBe(safeNode);
    const placed = await fireAlarm(taskId);
    expect(placed.state.currentStep).toBe('workspace_dispatch');
    expect(await workspacesOf(taskId)).toEqual([{ nodeId: safeNode, status: 'creating' }]);
  });

  it('places a task parked under the removed busy-build wait and closes its admission row', async () => {
    const nodeId = 'node-loop-legacy-waiter';
    const taskId = 'task-backlog-loop-legacy-waiter';
    await seedReadyCx23(nodeId);
    for (const index of [1, 2]) await queueStartupOn(nodeId, `ws-loop-legacy-${index}`);
    await startAtNodeSelection(taskId);
    // The admission row the old code wrote when it parked this task behind the build queue.
    const parkedAt = new Date(Date.now() - 25 * 60_000).toISOString();
    await env.DATABASE.prepare(
      `INSERT INTO vm_task_admissions (
         task_id, project_id, user_id, provider, credential_domain_key, provider_domain_key,
         scope_key, requested_vm_size, requested_vm_location, state, reason, next_retry_at,
         wait_deadline_at, enqueued_at, updated_at
       ) VALUES (?, ?, ?, 'hetzner', 'platform:hetzner', 'hetzner:platform:hetzner', ?, 'small',
         'nbg1', 'waiting', 'compatible_node_building_workspace', ?, ?, ?, ?)`
    )
      .bind(
        taskId,
        PROJECT_ID,
        USER_ID,
        `user:${USER_ID}:workspace-vm:hetzner:platform:hetzner`,
        parkedAt,
        // Past the old 20-minute budget, which used to end in provisioning.
        new Date(Date.now() - 5 * 60_000).toISOString(),
        parkedAt,
        parkedAt
      )
      .run();

    const selected = await fireAlarm(taskId);
    expect(selected.state.stepResults.nodeId).toBe(nodeId);
    const placed = await fireAlarm(taskId);

    expect(placed.state.currentStep).toBe('workspace_dispatch');
    expect(await workspacesOf(taskId)).toEqual([{ nodeId, status: 'creating' }]);
    const admission = await env.DATABASE.prepare(
      'SELECT state, selected_node_id AS selectedNodeId FROM vm_task_admissions WHERE task_id = ?'
    )
      .bind(taskId)
      .first<{ state: string; selectedNodeId: string | null }>();
    expect(admission).toEqual({ state: 'placed', selectedNodeId: nodeId });
    expect(await provisionedNodeCount()).toBe(0);
  });

  it('releases a warm claim whose node gained a queued start and places on the occupied node', async () => {
    const warmNode = 'node-loop-warm';
    const occupiedNode = 'node-loop-occupied';
    const taskId = 'task-backlog-loop-warm';
    await seedReadyCx23(warmNode);
    await seedReadyCx23(occupiedNode);
    // The occupied node runs one workspace: no queue, but it is not warm.
    await seedWorkspace('ws-loop-occupied-running', occupiedNode, USER_ID, {
      projectId: PROJECT_ID,
      status: 'running',
      resolvedReservationJson: JSON.stringify({ ...SMALL_RESERVATION, source: 'platform' }),
    });
    const lifecycle = env.NODE_LIFECYCLE.get(env.NODE_LIFECYCLE.idFromName(warmNode));
    await lifecycle.markIdle(warmNode, USER_ID);
    expect((await lifecycle.getStatus()).status).toBe('warm');
    await startAtNodeSelection(taskId);

    // 1. The warm shortcut claims the empty node, guarded at a backlog of 0.
    let fired = await fireAlarm(taskId);
    expect(fired.ran).toBe('node_selection');
    expect(fired.state.stepResults.claimedWarmNodeId).toBe(warmNode);
    expect(fired.state.stepResults.rankedStartupBacklog).toEqual({ nodeId: warmNode, backlog: 0 });

    // An ordinary placement lands on the warm node before this run's reservation.
    await queueStartupOn(warmNode, 'ws-loop-warm-raced');

    // 2. Refused as a fairness conflict; the claim is given back in NodeLifecycle and D1.
    fired = await fireAlarm(taskId);
    expect(fired.ran).toBe('workspace_creation');
    expect(fired.state.currentStep).toBe('node_selection');
    expect(fired.state.workspacePlacementRejections ?? 0).toBe(0);
    expect(fired.state.startupBacklogConflicts).toBe(1);
    expect(fired.state.stepResults.claimedWarmNodeId ?? null).toBeNull();
    expect((await lifecycle.getStatus()).claimedByTask).toBeNull();
    const claim = await env.DATABASE.prepare(
      'SELECT claimed_warm_node_id AS claimed FROM tasks WHERE id = ?'
    )
      .bind(taskId)
      .first<{ claimed: string | null }>();
    expect(claim?.claimed ?? null).toBeNull();

    // 3. Reselection skips the queued warm node and ranks the occupied one (0 against 1).
    fired = await fireAlarm(taskId);
    expect(fired.ran).toBe('node_selection');
    expect(fired.state.stepResults.nodeId).toBe(occupiedNode);
    expect(fired.state.stepResults.claimedWarmNodeId ?? null).toBeNull();

    // 4. Placement on the occupied node; nothing provisioned.
    fired = await fireAlarm(taskId);
    expect(fired.ran).toBe('workspace_creation');
    expect(fired.state.currentStep).toBe('workspace_dispatch');
    expect(await workspacesOf(taskId)).toEqual([{ nodeId: occupiedNode, status: 'creating' }]);
    expect(await provisionedNodeCount()).toBe(0);
  });
});
