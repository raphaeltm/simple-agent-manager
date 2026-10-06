import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { TaskRunner } from '../../src/durable-objects/task-runner';
import { requestIncompatiblePoolNodeDrain } from '../../src/durable-objects/task-runner/incompatible-node-drain';
import { findNodeWithCapacity } from '../../src/durable-objects/task-runner/node-selection';
import { handleNodeProvisioning } from '../../src/durable-objects/task-runner/node-steps';
import { retireRevokedTaskRunner } from '../../src/durable-objects/task-runner/task-execution-authority';
import type { TaskRunnerState } from '../../src/durable-objects/task-runner/types';
import type { Env } from '../../src/env';
import { sweepDestroyingHandoffNodes } from '../../src/scheduled/node-cleanup/node-phases';
import { emptyResult, resolveCleanupConfig } from '../../src/scheduled/node-cleanup/shared';
import { claimNodeForCleanup } from '../../src/scheduled/node-cleanup/shared';
import * as nodesService from '../../src/services/nodes';
import { filterReusableNodesByCurrentAuthority } from '../../src/services/reusable-node-authority';
import { markSessionSnapshotSleeping } from '../../src/services/session-snapshots';
import { createIncompatibleCapacityFixture } from '../helpers/incompatible-agent-capacity-fixture';

// Only the Workers runtime base/storage boundary is simulated. The real alarm,
// authority checks, admission SQL, pool trigger and node creation execute.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: DurableObjectState,
      public env: Env
    ) {}
  },
}));

let fixture: ReturnType<typeof createIncompatibleCapacityFixture>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-05T12:00:00.000Z'));
  fixture = createIncompatibleCapacityFixture();
});
afterEach(() => {
  fixture?.sqlite.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const snapshot = () =>
  fixture.sqlite
    .prepare('SELECT * FROM session_snapshots WHERE chat_session_id = ?')
    .get('old-chat') as Record<string, unknown> | undefined;

describe('incompatible occupied host capacity admission', () => {
  it('queues safe sleep and real admission wait without creating a node beyond the pool limit', async () => {
    const provision = vi.spyOn(nodesService, 'provisionNode');
    await handleNodeProvisioning(fixture.state, fixture.rc);
    expect(JSON.stringify(fixture.state.stepResults.placementDiagnostics)).toContain(
      'Host agent version is incompatible'
    );
    expect(snapshot()).toMatchObject({
      workspace_id: 'old-workspace',
      node_id: 'existing-node',
      sleep_status: 'scheduled',
      sleep_after: new Date().toISOString(),
    });
    expect(
      fixture.sqlite
        .prepare('SELECT state, reason FROM vm_task_admissions WHERE task_id = ?')
        .get('task-1')
    ).toEqual({ state: 'waiting', reason: 'capacity_pool_node_limit' });
    expect(fixture.sqlite.prepare('SELECT status FROM workspaces').get()).toEqual({
      status: 'running',
    });
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM nodes').get()).toEqual({
      count: 1,
    });
    expect(provision).not.toHaveBeenCalled();
    expect(fixture.rc.ctx.storage.setAlarm).toHaveBeenCalledWith(Date.now() + 1000);
  });

  it('admits a replacement only after sleep and guarded cleanup release the occupied slot', async () => {
    const { sqlite, state, rc } = fixture;
    const provision = vi.spyOn(nodesService, 'provisionNode').mockImplementation(async (id) => {
      sqlite
        .prepare("UPDATE nodes SET status='running',agent_version='current-agent' WHERE id=?")
        .run(id);
    });
    await handleNodeProvisioning(state, rc);
    const node = { id: 'existing-node', user_id: 'user-1', status: 'running' };
    expect(await claimNodeForCleanup(rc.env, node, new Date().toISOString())).toBe(false);
    // Model the snapshot/runtime stop boundary's receipt; use the existing sleep
    // lifecycle writer and cleanup ownership CAS, never the drain to release work.
    sqlite.exec(
      "UPDATE session_snapshots SET status='available',degradation='none',snapshot_generation='generation-1'"
    );
    expect(
      await markSessionSnapshotSleeping(drizzle(fixture.database, { schema }), rc.env, 'old-chat')
    ).toBe(true);
    sqlite.exec(
      "UPDATE workspaces SET status='sleeping',runtime_deletion_confirmed_at='2026-10-05T12:00:00.000Z'"
    );
    sqlite.prepare('UPDATE workspaces SET updated_at=?').run(new Date().toISOString());
    expect(await claimNodeForCleanup(rc.env, node, new Date().toISOString())).toBe(false);
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    expect(await claimNodeForCleanup(rc.env, node, new Date().toISOString())).toBe(true);
    // The provider deletion receipt is the external boundary; its confirmed
    // terminal state is what makes the production DB cap permit a replacement.
    sqlite.exec(
      "UPDATE nodes SET status='deleted',runtime_termination_confirmed_at='2026-10-05T12:00:00.000Z' WHERE id='existing-node'"
    );
    vi.advanceTimersByTime(1001);
    await handleNodeProvisioning(state, rc);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(state.stepResults.nodeId).toBeTruthy();
    expect(state.stepResults.nodeId).not.toBe('existing-node');
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM nodes WHERE status IN ('running','creating','destroying') AND capacity_pool_id='pool-1'"
        )
        .get()
    ).toEqual({ count: 1 });
    expect(snapshot()).toMatchObject({
      sleep_status: 'sleeping',
      snapshot_generation: 'generation-1',
    });
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
  });

  it('eligible full host waits to its configured deadline without requesting drain', async () => {
    fixture.rc.env.VM_ADMISSION_WAIT_TIMEOUT_MS = '60000';
    fixture.sqlite.prepare("UPDATE nodes SET agent_version='current-agent'").run();
    fixture.sqlite.prepare('UPDATE workspaces SET resolved_reservation_json=?').run(
      JSON.stringify({
        version: 3,
        cpuMillis: 1000,
        memoryMb: 15872,
        diskMb: 2048,
        exclusiveNode: false,
        source: 'task',
        sourceId: 'old-task',
      })
    );
    expect(
      await filterReusableNodesByCurrentAuthority(fixture.database, {
        userId: 'user-1',
        projectId: 'project-1',
        selections: [
          {
            nodeId: 'existing-node',
            capacityPlacementSnapshot: fixture.state.stepResults.capacityPlacementSnapshot!,
          },
        ],
      })
    ).toEqual(new Set(['existing-node']));
    await handleNodeProvisioning(fixture.state, fixture.rc);
    expect(JSON.stringify(fixture.state.stepResults.placementDiagnostics)).toContain(
      'memory budget would be exceeded after host reserve'
    );
    expect(snapshot()).toBeUndefined();
    vi.advanceTimersByTime(60001);
    await expect(handleNodeProvisioning(fixture.state, fixture.rc)).rejects.toMatchObject({
      permanent: true,
    });
    expect(
      fixture.sqlite.prepare('SELECT state FROM vm_task_admissions WHERE task_id = ?').get('task-1')
    ).toEqual({ state: 'expired' });
    expect(snapshot()).toBeUndefined();
  });

  it.each([
    ["UPDATE nodes SET user_id='another-user'"],
    ["UPDATE nodes SET capacity_pool_id='another-pool'"],
    ["UPDATE nodes SET node_class='user-owned'"],
    ["UPDATE nodes SET node_role='deployment'"],
    ["UPDATE nodes SET runtime='cf-container'"],
    ["DELETE FROM tasks WHERE id='old-task'"],
    ["UPDATE workspaces SET status='creating'"],
  ])('does not drain a host outside managed same-owner pool provenance: %s', async (sql) => {
    fixture.sqlite.exec(sql);
    await requestIncompatiblePoolNodeDrain(fixture.state, fixture.rc);
    expect(snapshot()).toBeUndefined();
  });

  it.each(['failed', 'terminal_failed', 'preparing', 'capturing', 'stopping', 'scheduled'])(
    'preserves existing %s sleep episode and its budgets',
    async (status) => {
      await requestIncompatiblePoolNodeDrain(fixture.state, fixture.rc);
      fixture.sqlite
        .prepare(
          "UPDATE session_snapshots SET sleep_status=?, sleep_after='2026-10-06T00:00:00.000Z',sleep_claim_id='claim',sleep_attempts=3,sleep_episode_failures=2"
        )
        .run(status);
      const before = snapshot();
      await requestIncompatiblePoolNodeDrain(fixture.state, fixture.rc);
      expect(snapshot()).toEqual(before);
    }
  );

  it('preserves a claim won after candidate selection before the final scheduling CAS', async () => {
    await requestIncompatiblePoolNodeDrain(fixture.state, fixture.rc);
    fixture.sqlite.exec('UPDATE session_snapshots SET sleep_status=NULL');
    const prepare = fixture.database.prepare.bind(fixture.database);
    vi.spyOn(fixture.database, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes("UPDATE session_snapshots SET sleep_status = 'scheduled'"))
        fixture.sqlite.exec(
          "UPDATE session_snapshots SET sleep_status='capturing',sleep_claim_id='winning-claim',sleep_episode_failures=2"
        );
      return prepare(sql);
    });
    await requestIncompatiblePoolNodeDrain(fixture.state, fixture.rc);
    expect(snapshot()).toMatchObject({
      sleep_status: 'capturing',
      sleep_claim_id: 'winning-claim',
      sleep_episode_failures: 2,
    });
  });

  it('reports usable memory through real node selection even when resolver removed the offering', async () => {
    fixture.sqlite.exec(
      "UPDATE nodes SET agent_version='current-agent',provider_instance_memory_mb=4096,observed_provider_instance_memory_mb=4096"
    );
    fixture.state.config.resolvedReservation!.memoryMb = 3712;
    fixture.state.config.capacityPoolSelection!.candidates = [];
    expect(await findNodeWithCapacity(fixture.state, fixture.rc)).toBeNull();
    expect(JSON.stringify(fixture.state.stepResults.placementDiagnostics)).toContain(
      'Host memory cannot satisfy the requested resources after host reserve'
    );
    expect(JSON.stringify(fixture.state.stepResults.placementDiagnostics)).not.toContain(
      'Host is outside the current pool allocation authority'
    );
  });

  it.each(['expired', 'deleted'])(
    'does not let an unqueueable %s snapshot consume the bounded drain candidate limit',
    async (status) => {
      await requestIncompatiblePoolNodeDrain(fixture.state, fixture.rc);
      fixture.sqlite.prepare('UPDATE session_snapshots SET sleep_status=NULL,status=?').run(status);
      fixture.sqlite.exec(`
      INSERT INTO workspaces (id,user_id,node_id,project_id,chat_session_id,status) VALUES ('z-valid-workspace','user-1','existing-node','project-1','z-valid-chat','running');
      INSERT INTO agent_sessions (id,workspace_id,status,created_at) VALUES ('z-valid-agent','z-valid-workspace','running','2026-10-01T00:00:00.000Z');
    `);
      fixture.rc.env.WORKSPACE_CLEANUP_SWEEP_LIMIT = '1';
      await requestIncompatiblePoolNodeDrain(fixture.state, fixture.rc);
      expect(snapshot()).toMatchObject({ status, sleep_status: null });
      expect(
        fixture.sqlite
          .prepare(
            "SELECT sleep_status FROM session_snapshots WHERE chat_session_id='z-valid-chat'"
          )
          .get()
      ).toEqual({ sleep_status: 'scheduled' });
    }
  );

  it('rejects a relocation racing between selection and placeholder insertion', async () => {
    const prepare = fixture.database.prepare.bind(fixture.database);
    vi.spyOn(fixture.database, 'prepare').mockImplementation((sql: string) => {
      if (sql.startsWith('INSERT INTO session_snapshots'))
        fixture.sqlite.exec("UPDATE workspaces SET node_id='replacement-node'");
      return prepare(sql);
    });
    await requestIncompatiblePoolNodeDrain(fixture.state, fixture.rc);
    expect(snapshot()).toBeUndefined();
  });
});

function alarmRunner() {
  let persisted = structuredClone(fixture.state);
  let alarm: number | null = null;
  const storage = {
    get: vi.fn(async () => structuredClone(persisted)),
    put: vi.fn(async (_key: string, value: TaskRunnerState) => {
      persisted = structuredClone(value);
    }),
    setAlarm: vi.fn(async (value: number | Date) => {
      alarm = Number(value);
    }),
    getAlarm: vi.fn(async () => alarm),
    deleteAlarm: vi.fn(async () => {
      alarm = null;
    }),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(storage)),
  };
  const ctx = { storage, waitUntil: vi.fn() } as unknown as DurableObjectState;
  fixture.rc.env.KV = { get: vi.fn(async () => null) } as unknown as KVNamespace;
  return {
    runner: new TaskRunner(ctx, fixture.rc.env),
    storage,
    state: () => persisted,
    replaceState: (value: TaskRunnerState) => {
      persisted = structuredClone(value);
    },
    alarm: () => alarm,
  };
}

describe('advisory drain failures during actual admission alarms', () => {
  it('preserves a newer admission and alarm when drain persistence loses its attempt fence', async () => {
    const run = alarmRunner();
    const newer = structuredClone(fixture.state);
    newer.config.recoveryAttemptId = 'newer-during-advisory-drain';
    newer.currentStep = 'node_agent_ready';
    const newAlarm = Date.now() + 12345;
    const transaction = run.storage.transaction.getMockImplementation()!;
    let superseded = false;
    let admissionBefore: unknown;
    let taskBefore: unknown;
    run.storage.transaction.mockImplementation(async (callback) => {
      const diagnostics = fixture.sqlite
        .prepare("SELECT placement_explanation_json FROM tasks WHERE id='task-1'")
        .get() as { placement_explanation_json: string | null };
      if (!superseded && diagnostics.placement_explanation_json?.includes('Queued safe drain')) {
        // The newer wake commits after advisory D1 diagnostics but before the
        // old run's storage transaction reads its attempt identity.
        superseded = true;
        run.replaceState(newer);
        await run.storage.setAlarm(newAlarm);
        fixture.sqlite.exec(`
          INSERT INTO vm_task_admissions
            (task_id,project_id,user_id,state,reason,fencing_token,attempt_count,scope_key)
          VALUES ('task-1','project-1','user-1','provisioning_granted','provisioning_started',42,7,'newer-scope');
          UPDATE tasks SET status='in_progress',execution_step='node_agent_ready',
            admission_state='provisioning_granted',admission_reason='provisioning_started' WHERE id='task-1';
        `);
        admissionBefore = fixture.sqlite
          .prepare("SELECT * FROM vm_task_admissions WHERE task_id='task-1'")
          .get();
        taskBefore = fixture.sqlite.prepare("SELECT * FROM tasks WHERE id='task-1'").get();
      }
      return transaction(callback);
    });
    const provider = vi.spyOn(nodesService, 'provisionNode');
    const create = vi.spyOn(nodesService, 'createNodeRecord');
    await run.runner.alarm();
    expect(superseded).toBe(true);
    expect(
      fixture.sqlite.prepare("SELECT * FROM vm_task_admissions WHERE task_id='task-1'").get()
    ).toEqual(admissionBefore);
    expect(fixture.sqlite.prepare("SELECT * FROM tasks WHERE id='task-1'").get()).toEqual(
      taskBefore
    );
    expect(run.state()).toEqual(newer);
    expect(run.alarm()).toBe(newAlarm);
    expect(run.storage.setAlarm).toHaveBeenCalledTimes(1);
    expect(provider).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(snapshot()).toMatchObject({ sleep_status: 'scheduled' });
  });

  it.each(['candidate-select', 'drain-diagnostics'])(
    'keeps the capacity wait and retry budget when %s fails',
    async (boundary) => {
      const prepare = fixture.database.prepare.bind(fixture.database);
      let failDrainDiagnostics = false;
      let failures = 0;
      vi.spyOn(fixture.database, 'prepare').mockImplementation((sql: string) => {
        if (
          boundary === 'candidate-select' &&
          sql.includes('ORDER BY n.created_at, w.id LIMIT ?')
        ) {
          failures++;
          throw new Error('D1_ERROR: database is overloaded');
        }
        if (boundary === 'drain-diagnostics') {
          if (sql.includes("UPDATE session_snapshots SET sleep_status = 'scheduled'")) {
            failDrainDiagnostics = true;
          } else if (
            failDrainDiagnostics &&
            sql.includes('UPDATE tasks SET placement_explanation_json')
          ) {
            failDrainDiagnostics = false;
            failures++;
            throw new Error('D1_ERROR: database is overloaded');
          }
        }
        return prepare(sql);
      });
      const provider = vi.spyOn(nodesService, 'provisionNode');
      const create = vi.spyOn(nodesService, 'createNodeRecord');
      const run = alarmRunner();
      let deadline: string | undefined;
      for (let attempt = 0; attempt < 4; attempt++) {
        await run.runner.alarm();
        const admission = fixture.sqlite
          .prepare(
            "SELECT state,reason,wait_deadline_at FROM vm_task_admissions WHERE task_id='task-1'"
          )
          .get() as { state: string; reason: string; wait_deadline_at: string };
        expect(admission).toMatchObject({ state: 'waiting', reason: 'capacity_pool_node_limit' });
        deadline ??= admission.wait_deadline_at;
        expect(admission.wait_deadline_at).toBe(deadline);
        expect(run.state()).toMatchObject({
          completed: false,
          retryCount: 0,
          currentStep: 'node_provisioning',
        });
        expect(run.alarm()).toBe(Date.now() + 1000);
        expect(
          fixture.sqlite.prepare("SELECT status,execution_step FROM tasks WHERE id='task-1'").get()
        ).toEqual({ status: 'queued', execution_step: 'waiting_for_node_capacity' });
        vi.advanceTimersByTime(1001);
      }
      expect(failures).toBe(boundary === 'candidate-select' ? 4 : 1);
      expect(provider).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM nodes').get()).toEqual({
        count: 1,
      });
      expect(fixture.sqlite.prepare('SELECT status FROM workspaces').get()).toEqual({
        status: 'running',
      });
      if (boundary === 'candidate-select') expect(snapshot()).toBeUndefined();
      else expect(snapshot()).toMatchObject({ sleep_status: 'scheduled' });
    }
  );
});

describe('cancelled admission alarms', () => {
  it('stops a cancelled pool-full waiter before a freed slot can allocate replacement compute', async () => {
    fixture.sqlite.exec("UPDATE nodes SET agent_version='current-agent'");
    fixture.sqlite.prepare('UPDATE workspaces SET resolved_reservation_json=?').run(
      JSON.stringify({
        version: 3,
        cpuMillis: 1000,
        memoryMb: 15872,
        diskMb: 2048,
        exclusiveNode: false,
        source: 'task',
        sourceId: 'old-task',
      })
    );
    const provider = vi.spyOn(nodesService, 'provisionNode');
    const createNode = vi.spyOn(nodesService, 'createNodeRecord');
    const run = alarmRunner();
    await run.runner.alarm();
    expect(
      fixture.sqlite.prepare("SELECT state FROM vm_task_admissions WHERE task_id='task-1'").get()
    ).toEqual({ state: 'waiting' });
    expect(run.alarm()).toBe(Date.now() + 1000);
    expect(snapshot()).toBeUndefined();
    fixture.sqlite.exec(
      "UPDATE tasks SET status='cancelled', error_message='CANCELLED' WHERE id='task-1'; UPDATE nodes SET status='deleted',runtime_termination_confirmed_at='2026-10-05T12:00:00.000Z' WHERE id='existing-node'"
    );
    vi.advanceTimersByTime(1001);
    await run.runner.alarm();
    expect(createNode).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM nodes').get()).toEqual({
      count: 1,
    });
    expect(
      fixture.sqlite.prepare("SELECT status,error_message FROM tasks WHERE id='task-1'").get()
    ).toEqual({ status: 'cancelled', error_message: 'CANCELLED' });
    expect(run.state().completed).toBe(true);
    expect(run.alarm()).toBeNull();
    expect(run.storage.deleteAlarm).toHaveBeenCalled();
  });
  it.each(['allocation-write', 'provider-boundary'])(
    'preserves cancellation racing at %s and deletes only its newly allocated empty host',
    async (boundary) => {
      fixture.sqlite.exec(
        "UPDATE nodes SET status='deleted',runtime_termination_confirmed_at='2026-10-05T12:00:00.000Z' WHERE id='existing-node'"
      );
      const provider = vi.spyOn(nodesService, 'provisionNode');
      const deleted: string[] = [];
      const cleanup = vi
        .spyOn(nodesService, 'deleteNodeResourcesStrict')
        .mockImplementation(async (nodeId) => {
          expect(fixture.sqlite.prepare('SELECT status FROM nodes WHERE id=?').get(nodeId)).toEqual(
            { status: 'destroying' }
          );
          deleted.push(nodeId);
          // Confirmed external deletion receipt; the cleanup ownership SQL stays real.
          fixture.sqlite
            .prepare(
              "UPDATE nodes SET status='deleted',runtime_termination_confirmed_at=? WHERE id=?"
            )
            .run(new Date().toISOString(), nodeId);
          return {
            providerVm: 'deleted',
            runtimeTerminationConfirmedAt: new Date().toISOString(),
            runtimeIncarnationId: (
              fixture.sqlite
                .prepare('SELECT runtime_incarnation_id AS id FROM nodes WHERE id=?')
                .get(nodeId) as { id: string | null }
            ).id,
            providerInstanceId: null,
          };
        });
      let raced = false;
      const prepare = fixture.database.prepare.bind(fixture.database);
      vi.spyOn(fixture.database, 'prepare').mockImplementation((sql: string) => {
        const matches =
          boundary === 'allocation-write'
            ? sql.includes('SET auto_provisioned_node_id = ?')
            : sql.includes('SET inflight_node_id = ?');
        if (matches && !raced) {
          raced = true;
          fixture.sqlite.exec(
            "UPDATE tasks SET status='cancelled',error_message='CANCELLED' WHERE id='task-1'"
          );
        }
        return prepare(sql);
      });
      const run = alarmRunner();
      await run.runner.alarm();
      expect(raced).toBe(true);
      expect(provider).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(deleted).toEqual([run.state().stepResults.nodeId]);
      expect(deleted[0]).not.toBe('existing-node');
      expect(
        fixture.sqlite
          .prepare(
            "SELECT status,error_message,auto_provisioned_node_id FROM tasks WHERE id='task-1'"
          )
          .get()
      ).toEqual({
        status: 'cancelled',
        error_message: 'CANCELLED',
        auto_provisioned_node_id: boundary === 'allocation-write' ? null : deleted[0],
      });
      expect(
        fixture.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM nodes WHERE status IN ('creating','running','destroying')"
          )
          .get()
      ).toEqual({ count: 0 });
      expect(
        fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM vm_provisioning_leases').get()
      ).toEqual({ count: 0 });
      expect(run.state().completed).toBe(true);
      expect(run.alarm()).toBeNull();
    }
  );

  it('honors another live warm placement claim before its workspace exists and preserves its lease', async () => {
    fixture.sqlite.exec(
      "DELETE FROM workspaces; UPDATE tasks SET auto_provisioned_node_id=NULL WHERE id='old-task'; UPDATE tasks SET status='cancelled',error_message='CANCELLED',auto_provisioned_node_id='existing-node' WHERE id='task-1'; UPDATE tasks SET status='queued',claimed_warm_node_id='existing-node' WHERE id='old-task'"
    );
    fixture.sqlite
      .prepare("UPDATE tasks SET claimed_warm_node_at=? WHERE id='old-task'")
      .run(new Date().toISOString());
    fixture.sqlite.exec(
      "INSERT INTO vm_provisioning_leases(scope_key,owner_task_id,fencing_token,provider,credential_domain_key,provider_domain_key,requested_vm_size,expires_at) VALUES ('shared-scope','old-task',2,'hetzner','credential-1','domain','large','2026-10-06T00:00:00.000Z')"
    );
    fixture.state.stepResults.nodeId = 'existing-node';
    fixture.state.stepResults.autoProvisioned = true;
    fixture.state.admissionScopeKey = 'shared-scope';
    fixture.state.admissionLeaseToken = 1;
    const cleanup = vi.spyOn(nodesService, 'deleteNodeResourcesStrict');
    const leaseBefore = fixture.sqlite.prepare('SELECT * FROM vm_provisioning_leases').get();
    const run = alarmRunner();
    await run.runner.alarm();
    expect(cleanup).not.toHaveBeenCalled();
    expect(
      fixture.sqlite.prepare("SELECT status FROM nodes WHERE id='existing-node'").get()
    ).toEqual({ status: 'running' });
    expect(fixture.sqlite.prepare('SELECT * FROM vm_provisioning_leases').get()).toEqual(
      leaseBefore
    );
    expect(
      fixture.sqlite.prepare("SELECT claimed_warm_node_id FROM tasks WHERE id='old-task'").get()
    ).toEqual({ claimed_warm_node_id: 'existing-node' });
    expect(run.state().completed).toBe(true);
    expect(run.alarm()).toBeNull();
  });

  it.each(['running', 'creating', 'recovery'])(
    'does not delete a host with an active %s workspace reservation on cancellation',
    async (status) => {
      fixture.sqlite.prepare('UPDATE workspaces SET status=?').run(status);
      fixture.sqlite.exec(
        "UPDATE tasks SET auto_provisioned_node_id=NULL WHERE id='old-task'; UPDATE tasks SET status='cancelled',error_message='CANCELLED',auto_provisioned_node_id='existing-node' WHERE id='task-1'"
      );
      fixture.state.stepResults.nodeId = 'existing-node';
      fixture.state.stepResults.autoProvisioned = true;
      const cleanup = vi.spyOn(nodesService, 'deleteNodeResourcesStrict');
      await alarmRunner().runner.alarm();
      expect(cleanup).not.toHaveBeenCalled();
      expect(
        fixture.sqlite.prepare("SELECT status FROM nodes WHERE id='existing-node'").get()
      ).toEqual({ status: 'running' });
      expect(fixture.sqlite.prepare('SELECT status FROM workspaces').get()).toEqual({ status });
    }
  );

  it.each([
    "DELETE FROM tasks WHERE id='task-1'",
    "UPDATE tasks SET user_id='another-user' WHERE id='task-1'",
    "UPDATE tasks SET project_id='another-project' WHERE id='task-1'",
    "UPDATE tasks SET status='sleeping' WHERE id='task-1'",
  ])(
    'does not allocate when current task identity/execution authority is revoked: %s',
    async (sql) => {
      fixture.sqlite.exec(sql);
      const provider = vi.spyOn(nodesService, 'provisionNode');
      const create = vi.spyOn(nodesService, 'createNodeRecord');
      const run = alarmRunner();
      await run.runner.alarm();
      expect(provider).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(run.state().completed).toBe(true);
      expect(run.alarm()).toBeNull();
    }
  );

  it.each([false, true])(
    'retires paid compute after cancellation races provider success (delete fails=%s)',
    async (deleteFails) => {
      fixture.sqlite.exec(
        "UPDATE nodes SET status='deleted',runtime_termination_confirmed_at='2026-10-05T12:00:00.000Z' WHERE id='existing-node'"
      );
      const provider = vi
        .spyOn(nodesService, 'provisionNode')
        .mockImplementation(async (nodeId) => {
          fixture.sqlite
            .prepare(
              "UPDATE nodes SET status='running',provider_instance_id='paid-provider-instance' WHERE id=?"
            )
            .run(nodeId);
          fixture.sqlite.exec(
            "UPDATE tasks SET status='cancelled',error_message='CANCELLED' WHERE id='task-1'"
          );
        });
      const cleanup = vi
        .spyOn(nodesService, 'deleteNodeResourcesStrict')
        .mockImplementation(async (nodeId) => {
          expect(
            fixture.sqlite
              .prepare('SELECT status,provider_instance_id FROM nodes WHERE id=?')
              .get(nodeId)
          ).toEqual({ status: 'destroying', provider_instance_id: 'paid-provider-instance' });
          if (deleteFails) throw new Error('provider delete temporarily unavailable');
          fixture.sqlite
            .prepare(
              "UPDATE nodes SET status='deleted',runtime_termination_confirmed_at=? WHERE id=?"
            )
            .run(new Date().toISOString(), nodeId);
          return {
            providerVm: 'deleted',
            runtimeTerminationConfirmedAt: new Date().toISOString(),
            runtimeIncarnationId: (
              fixture.sqlite
                .prepare('SELECT runtime_incarnation_id AS id FROM nodes WHERE id=?')
                .get(nodeId) as { id: string | null }
            ).id,
            providerInstanceId: 'paid-provider-instance',
          };
        });
      const run = alarmRunner();
      if (deleteFails)
        await expect(run.runner.alarm()).rejects.toThrow('provider delete temporarily unavailable');
      else await run.runner.alarm();
      expect(provider).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(
        fixture.sqlite.prepare("SELECT status,error_message FROM tasks WHERE id='task-1'").get()
      ).toEqual({ status: 'cancelled', error_message: 'CANCELLED' });
      expect(
        fixture.sqlite
          .prepare('SELECT status FROM nodes WHERE id=?')
          .get(run.state().stepResults.nodeId)
      ).toEqual({ status: deleteFails ? 'destroying' : 'deleted' });
      expect(
        fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM vm_provisioning_leases').get()
      ).toEqual({ count: 0 });
      expect(run.state().completed).toBe(true);
      expect(run.alarm()).toBeNull();
      if (deleteFails) {
        cleanup.mockImplementation(async (nodeId) => {
          const now = new Date().toISOString();
          fixture.sqlite
            .prepare('UPDATE nodes SET runtime_termination_confirmed_at=? WHERE id=?')
            .run(now, nodeId);
          return {
            providerVm: 'deleted',
            runtimeTerminationConfirmedAt: now,
            runtimeIncarnationId: (
              fixture.sqlite
                .prepare('SELECT runtime_incarnation_id AS id FROM nodes WHERE id=?')
                .get(nodeId) as { id: string | null }
            ).id,
            providerInstanceId: 'paid-provider-instance',
          };
        });
        vi.advanceTimersByTime(30 * 60 * 1000 + 1);
        const result = emptyResult();
        await sweepDestroyingHandoffNodes(
          drizzle(fixture.database, { schema }),
          fixture.rc.env,
          new Date(),
          resolveCleanupConfig(fixture.rc.env),
          result
        );
        expect(result.lifetimeDestroyed).toBe(1);
        expect(cleanup).toHaveBeenCalledTimes(2);
        expect(
          fixture.sqlite
            .prepare('SELECT status FROM nodes WHERE id=?')
            .get(run.state().stepResults.nodeId)
        ).toEqual({ status: 'deleted' });
        expect(
          fixture.sqlite.prepare("SELECT status,error_message FROM tasks WHERE id='task-1'").get()
        ).toEqual({ status: 'cancelled', error_message: 'CANCELLED' });
      }
    }
  );

  it.each(['reused', 'foreign-owner', 'user-owned', 'deployment', 'other-task-owner'])(
    'does not delete protected %s host on cancellation',
    async (kind) => {
      fixture.sqlite.exec(
        "DELETE FROM workspaces; UPDATE tasks SET auto_provisioned_node_id=NULL WHERE id='old-task'; UPDATE tasks SET status='cancelled',error_message='CANCELLED' WHERE id='task-1'"
      );
      fixture.state.stepResults.nodeId = 'existing-node';
      fixture.state.stepResults.autoProvisioned = kind !== 'reused';
      if (kind === 'foreign-owner') fixture.sqlite.exec("UPDATE nodes SET user_id='another-user'");
      if (kind === 'user-owned') fixture.sqlite.exec("UPDATE nodes SET node_class='user-owned'");
      if (kind === 'deployment') fixture.sqlite.exec("UPDATE nodes SET node_role='deployment'");
      if (kind === 'other-task-owner')
        fixture.sqlite.exec(
          "UPDATE tasks SET auto_provisioned_node_id='existing-node' WHERE id='old-task'"
        );
      const cleanup = vi.spyOn(nodesService, 'deleteNodeResourcesStrict');
      const run = alarmRunner();
      await run.runner.alarm();
      expect(cleanup).not.toHaveBeenCalled();
      expect(
        fixture.sqlite.prepare("SELECT status FROM nodes WHERE id='existing-node'").get()
      ).toEqual({ status: 'running' });
      expect(run.state().completed).toBe(true);
    }
  );

  it('does not retire or delete resources owned by a newer wake when old alarm authority is revoked', async () => {
    const run = alarmRunner();
    const newer = structuredClone(fixture.state);
    newer.config.recoveryAttemptId = 'newer-wake-attempt';
    newer.stepResults.nodeId = 'newer-wake-node';
    const cleanup = vi.spyOn(nodesService, 'deleteNodeResourcesStrict');
    const create = vi.spyOn(nodesService, 'createNodeRecord');
    const prepare = fixture.database.prepare.bind(fixture.database);
    let superseded = false;
    vi.spyOn(fixture.database, 'prepare').mockImplementation((sql: string) => {
      if (
        !superseded &&
        sql.includes('SELECT id FROM tasks WHERE id = ? AND project_id = ? AND user_id = ?')
      ) {
        superseded = true;
        run.replaceState(newer);
        fixture.sqlite.exec(
          "UPDATE tasks SET status='cancelled',error_message='CANCELLED' WHERE id='task-1'"
        );
      }
      return prepare(sql);
    });
    await run.storage.setAlarm(Date.now() + 5000);
    await run.runner.alarm();
    expect(superseded).toBe(true);
    expect(run.state()).toEqual(newer);
    expect(run.alarm()).toBe(Date.now() + 5000);
    expect(run.storage.deleteAlarm).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
  it.each(['lease-release', 'node-claim'])(
    'retries cancellation cleanup after transient %s D1 failure without allocating again',
    async (failureBoundary) => {
      fixture.sqlite.exec(
        "DELETE FROM workspaces; UPDATE tasks SET auto_provisioned_node_id=NULL WHERE id='old-task'; UPDATE tasks SET status='cancelled',error_message='CANCELLED',auto_provisioned_node_id='existing-node' WHERE id='task-1'; UPDATE nodes SET provider_instance_id='paid-existing-instance' WHERE id='existing-node'"
      );
      fixture.sqlite.exec(
        "INSERT INTO vm_provisioning_leases(scope_key,owner_task_id,fencing_token,provider,credential_domain_key,provider_domain_key,requested_vm_size,expires_at) VALUES ('owned-scope','task-1',1,'hetzner','credential-1','domain','large','2026-10-06T00:00:00.000Z')"
      );
      fixture.state.stepResults.nodeId = 'existing-node';
      fixture.state.stepResults.autoProvisioned = true;
      fixture.state.admissionScopeKey = 'owned-scope';
      fixture.state.admissionLeaseToken = 1;
      const provider = vi.spyOn(nodesService, 'provisionNode');
      const create = vi.spyOn(nodesService, 'createNodeRecord');
      const cleanup = vi
        .spyOn(nodesService, 'deleteNodeResourcesStrict')
        .mockImplementation(async (nodeId) => {
          expect(fixture.sqlite.prepare('SELECT status FROM nodes WHERE id=?').get(nodeId)).toEqual(
            { status: 'destroying' }
          );
          const now = new Date().toISOString();
          fixture.sqlite
            .prepare(
              "UPDATE nodes SET status='deleted',runtime_termination_confirmed_at=? WHERE id=?"
            )
            .run(now, nodeId);
          return {
            providerVm: 'deleted',
            runtimeTerminationConfirmedAt: now,
            runtimeIncarnationId: (
              fixture.sqlite
                .prepare('SELECT runtime_incarnation_id AS id FROM nodes WHERE id=?')
                .get(nodeId) as { id: string | null }
            ).id,
            providerInstanceId: 'paid-existing-instance',
          };
        });
      const prepare = fixture.database.prepare.bind(fixture.database);
      let faulted = false;
      vi.spyOn(fixture.database, 'prepare').mockImplementation((sql: string) => {
        const matches =
          failureBoundary === 'lease-release'
            ? sql.includes('DELETE FROM vm_provisioning_leases')
            : sql.includes("UPDATE nodes SET status = 'destroying'");
        if (matches && !faulted) {
          faulted = true;
          throw new Error('transient cleanup D1 failure');
        }
        return prepare(sql);
      });
      const run = alarmRunner();
      await run.storage.setAlarm(Date.now() + 1000);
      await expect(run.runner.alarm()).rejects.toThrow('transient cleanup D1 failure');
      expect(faulted).toBe(true);
      expect(run.state().completed).toBe(false);
      expect(run.storage.deleteAlarm).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();
      expect(
        fixture.sqlite
          .prepare("SELECT status,provider_instance_id FROM nodes WHERE id='existing-node'")
          .get()
      ).toEqual({ status: 'running', provider_instance_id: 'paid-existing-instance' });
      await run.runner.alarm();
      expect(provider).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledExactlyOnceWith('existing-node', 'user-1', fixture.rc.env);
      expect(
        fixture.sqlite.prepare("SELECT status FROM nodes WHERE id='existing-node'").get()
      ).toEqual({ status: 'deleted' });
      expect(
        fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM vm_provisioning_leases').get()
      ).toEqual({ count: 0 });
      expect(
        fixture.sqlite.prepare("SELECT status,error_message FROM tasks WHERE id='task-1'").get()
      ).toEqual({ status: 'cancelled', error_message: 'CANCELLED' });
      expect(run.state().completed).toBe(true);
      expect(run.alarm()).toBeNull();
    }
  );
  it('does not resurrect a cancelled admission when cancellation races the provisioning lease grant', async () => {
    const create = vi.spyOn(nodesService, 'createNodeRecord');
    const provider = vi.spyOn(nodesService, 'provisionNode');
    const run = alarmRunner();
    await run.runner.alarm();
    expect(
      fixture.sqlite.prepare("SELECT state FROM vm_task_admissions WHERE task_id='task-1'").get()
    ).toEqual({ state: 'waiting' });
    fixture.sqlite.exec(
      "UPDATE nodes SET status='deleted',runtime_termination_confirmed_at='2026-10-05T12:00:00.000Z' WHERE id='existing-node'"
    );
    const prepare = fixture.database.prepare.bind(fixture.database);
    let raced = false;
    vi.spyOn(fixture.database, 'prepare').mockImplementation((sql: string) => {
      if (!raced && sql.includes("SET state = 'provisioning_granted'")) {
        raced = true;
        fixture.sqlite.exec(
          "UPDATE tasks SET status='cancelled',error_message='CANCELLED',admission_state='cancelled',admission_reason='cancelled' WHERE id='task-1'; UPDATE vm_task_admissions SET state='cancelled',reason='cancelled',completed_at='2026-10-05T12:00:00.000Z',next_retry_at=NULL WHERE task_id='task-1'"
        );
      }
      return prepare(sql);
    });
    vi.advanceTimersByTime(1001);
    await run.runner.alarm();
    expect(raced).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(
      fixture.sqlite.prepare("SELECT state FROM vm_task_admissions WHERE task_id='task-1'").get()
    ).toEqual({ state: 'cancelled' });
    expect(
      fixture.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM vm_task_admissions WHERE state IN ('queued','waiting','provisioning_granted','provisioning','node_ready')"
        )
        .get()
    ).toEqual({ count: 0 });
    expect(
      fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM vm_provisioning_leases').get()
    ).toEqual({ count: 0 });
    expect(
      fixture.sqlite
        .prepare("SELECT status,error_message,admission_state FROM tasks WHERE id='task-1'")
        .get()
    ).toEqual({ status: 'cancelled', error_message: 'CANCELLED', admission_state: 'cancelled' });
    expect(run.state().completed).toBe(true);
    expect(run.alarm()).toBeNull();
  });

  it.each(['newer-token', 'foreign-user', 'foreign-project'])(
    'leaves another admission generation intact on cancellation cleanup: %s',
    async (kind) => {
      const run = alarmRunner();
      await run.runner.alarm();
      fixture.sqlite.exec(
        "UPDATE tasks SET status='cancelled',error_message='CANCELLED' WHERE id='task-1'; UPDATE vm_task_admissions SET state='provisioning_granted',fencing_token=1 WHERE task_id='task-1'"
      );
      if (kind === 'newer-token')
        fixture.sqlite.exec("UPDATE vm_task_admissions SET fencing_token=2 WHERE task_id='task-1'");
      if (kind === 'foreign-user')
        fixture.sqlite.exec(
          "UPDATE vm_task_admissions SET user_id='another-user' WHERE task_id='task-1'"
        );
      if (kind === 'foreign-project')
        fixture.sqlite.exec(
          "UPDATE vm_task_admissions SET project_id='another-project' WHERE task_id='task-1'"
        );
      fixture.sqlite.exec(
        "INSERT INTO vm_provisioning_leases(scope_key,owner_task_id,fencing_token,provider,credential_domain_key,provider_domain_key,requested_vm_size,expires_at) VALUES ('shared-generation-scope','old-task',2,'hetzner','credential-1','domain','large','2026-10-06T00:00:00.000Z')"
      );
      const persisted = structuredClone(run.state());
      persisted.admissionScopeKey = 'shared-generation-scope';
      persisted.admissionLeaseToken = 1;
      run.replaceState(persisted);
      const admissionBefore = fixture.sqlite
        .prepare("SELECT * FROM vm_task_admissions WHERE task_id='task-1'")
        .get();
      const leaseBefore = fixture.sqlite.prepare('SELECT * FROM vm_provisioning_leases').get();
      const create = vi.spyOn(nodesService, 'createNodeRecord');
      const provider = vi.spyOn(nodesService, 'provisionNode');
      await run.runner.alarm();
      expect(
        fixture.sqlite.prepare("SELECT * FROM vm_task_admissions WHERE task_id='task-1'").get()
      ).toEqual(admissionBefore);
      expect(fixture.sqlite.prepare('SELECT * FROM vm_provisioning_leases').get()).toEqual(
        leaseBefore
      );
      expect(create).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
      expect(run.state().completed).toBe(true);
    }
  );
  it.each(['repair', 'newer-token', 'executable-replacement'])(
    'replays a partial admission/mirror cleanup commit safely: %s',
    async (outcome) => {
      const run = alarmRunner();
      await run.runner.alarm();
      fixture.sqlite.exec(
        "UPDATE tasks SET status='cancelled',error_message='CANCELLED',admission_state='provisioning_granted' WHERE id='task-1'; UPDATE vm_task_admissions SET state='provisioning_granted',fencing_token=1 WHERE task_id='task-1'"
      );
      const persisted = structuredClone(run.state());
      persisted.admissionLeaseToken = 1;
      run.replaceState(persisted);
      const create = vi.spyOn(nodesService, 'createNodeRecord');
      const provider = vi.spyOn(nodesService, 'provisionNode');
      const prepare = fixture.database.prepare.bind(fixture.database);
      let faulted = false;
      vi.spyOn(fixture.database, 'prepare').mockImplementation((sql: string) => {
        if (!faulted && sql.includes("UPDATE tasks SET admission_state = 'cancelled'")) {
          faulted = true;
          throw new Error('admission mirror D1 write failed');
        }
        return prepare(sql);
      });
      await expect(run.runner.alarm()).rejects.toThrow('admission mirror D1 write failed');
      expect(faulted).toBe(true);
      expect(
        fixture.sqlite
          .prepare("SELECT state,reason FROM vm_task_admissions WHERE task_id='task-1'")
          .get()
      ).toEqual({ state: 'cancelled', reason: 'task_execution_authority_revoked' });
      expect(
        fixture.sqlite.prepare("SELECT admission_state FROM tasks WHERE id='task-1'").get()
      ).toEqual({ admission_state: 'provisioning_granted' });
      expect(run.state().completed).toBe(false);
      expect(run.storage.deleteAlarm).not.toHaveBeenCalled();
      if (outcome === 'repair') {
        const terminalBefore = fixture.sqlite
          .prepare("SELECT * FROM vm_task_admissions WHERE task_id='task-1'")
          .get();
        await run.runner.alarm();
        expect(
          fixture.sqlite.prepare("SELECT * FROM vm_task_admissions WHERE task_id='task-1'").get()
        ).toEqual(terminalBefore);
        expect(
          fixture.sqlite
            .prepare(
              "SELECT status,error_message,admission_state,admission_reason,admission_next_retry_at FROM tasks WHERE id='task-1'"
            )
            .get()
        ).toEqual({
          status: 'cancelled',
          error_message: 'CANCELLED',
          admission_state: 'cancelled',
          admission_reason: 'task_execution_authority_revoked',
          admission_next_retry_at: null,
        });
      } else {
        if (outcome === 'newer-token')
          fixture.sqlite.exec(
            "UPDATE vm_task_admissions SET state='provisioning_granted',fencing_token=2,reason='newer_grant' WHERE task_id='task-1'; UPDATE tasks SET admission_reason='newer_grant' WHERE id='task-1'"
          );
        else
          fixture.sqlite.exec(
            "UPDATE tasks SET status='queued',error_message=NULL,admission_state='provisioning_granted',admission_reason='replacement_grant' WHERE id='task-1'; UPDATE vm_task_admissions SET state='provisioning_granted',reason='replacement_grant' WHERE task_id='task-1'"
          );
        const admissionBefore = fixture.sqlite
          .prepare("SELECT * FROM vm_task_admissions WHERE task_id='task-1'")
          .get();
        const taskBefore = fixture.sqlite.prepare("SELECT * FROM tasks WHERE id='task-1'").get();
        // Exercise the late old cleanup response directly: a current executable
        // replacement would otherwise dispatch normally from its own alarm.
        await retireRevokedTaskRunner(structuredClone(run.state()), {
          ...fixture.rc,
          ctx: { ...fixture.rc.ctx, storage: run.storage } as unknown as DurableObjectState,
        });
        expect(
          fixture.sqlite.prepare("SELECT * FROM vm_task_admissions WHERE task_id='task-1'").get()
        ).toEqual(admissionBefore);
        expect(fixture.sqlite.prepare("SELECT * FROM tasks WHERE id='task-1'").get()).toEqual(
          taskBefore
        );
      }
      expect(create).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
      expect(run.state().completed).toBe(true);
      expect(run.alarm()).toBeNull();
    }
  );
  it('protects paid compute taken by an executable restart of the same task before workspace insertion', async () => {
    fixture.sqlite.exec(
      "DELETE FROM workspaces; UPDATE tasks SET auto_provisioned_node_id=NULL WHERE id='old-task'; UPDATE tasks SET status='cancelled',error_message='CANCELLED',auto_provisioned_node_id='existing-node' WHERE id='task-1'; UPDATE nodes SET provider_instance_id='paid-restarted-instance' WHERE id='existing-node'"
    );
    fixture.state.stepResults.nodeId = 'existing-node';
    fixture.state.stepResults.autoProvisioned = true;
    const run = alarmRunner();
    const cleanup = vi.spyOn(nodesService, 'deleteNodeResourcesStrict');
    const provider = vi.spyOn(nodesService, 'provisionNode');
    const prepare = fixture.database.prepare.bind(fixture.database);
    let restartTask: unknown;
    let restartAdmission: unknown;
    vi.spyOn(fixture.database, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes("UPDATE nodes SET status = 'destroying'")) {
        fixture.sqlite.exec(
          "UPDATE tasks SET status='queued',error_message=NULL,admission_state='provisioning_granted',admission_reason='restart_owns_node' WHERE id='task-1'; INSERT INTO vm_task_admissions(task_id,project_id,user_id,state,fencing_token,reason) VALUES ('task-1','project-1','user-1','provisioning_granted',2,'restart_owns_node') ON CONFLICT(task_id) DO UPDATE SET state='provisioning_granted',fencing_token=2,reason='restart_owns_node'"
        );
        restartTask = fixture.sqlite.prepare("SELECT * FROM tasks WHERE id='task-1'").get();
        restartAdmission = fixture.sqlite
          .prepare("SELECT * FROM vm_task_admissions WHERE task_id='task-1'")
          .get();
      }
      return prepare(sql);
    });
    await run.runner.alarm();
    expect(restartTask).toBeDefined();
    expect(fixture.sqlite.prepare("SELECT * FROM tasks WHERE id='task-1'").get()).toEqual(
      restartTask
    );
    expect(
      fixture.sqlite.prepare("SELECT * FROM vm_task_admissions WHERE task_id='task-1'").get()
    ).toEqual(restartAdmission);
    expect(
      fixture.sqlite
        .prepare("SELECT status,provider_instance_id FROM nodes WHERE id='existing-node'")
        .get()
    ).toEqual({ status: 'running', provider_instance_id: 'paid-restarted-instance' });
    expect(cleanup).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it('atomically completes old state and alarm before a newly reactivated run installs its own alarm', async () => {
    fixture.sqlite.exec(
      "UPDATE tasks SET status='cancelled',error_message='CANCELLED' WHERE id='task-1'"
    );
    const run = alarmRunner();
    const newer = structuredClone(fixture.state);
    newer.config.recoveryAttemptId = 'reactivated-after-commit';
    const newAlarm = Date.now() + 12345;
    let reactivated = false;
    const transaction = run.storage.transaction.getMockImplementation()!;
    run.storage.transaction.mockImplementation(async (callback) => {
      const result = await transaction(callback);
      if (!reactivated) {
        reactivated = true;
        // A reactivation waits until the completion transaction releases its
        // lock, then commits its new state and alarm as one operation.
        run.replaceState(newer);
        await run.storage.setAlarm(newAlarm);
      }
      return result;
    });
    await run.runner.alarm();
    expect(reactivated).toBe(true);
    expect(run.state()).toEqual(newer);
    expect(run.alarm()).toBe(newAlarm);
    expect(run.storage.deleteAlarm).toHaveBeenCalledTimes(1);
  });
  it('fences late cancellation completion against a newer persisted wake and its alarm', async () => {
    fixture.sqlite.exec(
      "UPDATE tasks SET status='cancelled',error_message='CANCELLED' WHERE id='task-1'"
    );
    const run = alarmRunner();
    const newer = structuredClone(fixture.state);
    newer.config.recoveryAttemptId = 'newer-before-retirement-commit';
    const newAlarm = Date.now() + 12345;
    const transaction = run.storage.transaction.getMockImplementation()!;
    let reactivated = false;
    run.storage.transaction.mockImplementation(async (callback) => {
      if (!reactivated) {
        reactivated = true;
        run.replaceState(newer);
        await run.storage.setAlarm(newAlarm);
      }
      return transaction(callback);
    });
    await expect(run.runner.alarm()).rejects.toMatchObject({
      name: 'SessionRecoveryAuthorityRevokedError',
    });
    expect(reactivated).toBe(true);
    expect(run.state()).toEqual(newer);
    expect(run.alarm()).toBe(newAlarm);
    expect(run.storage.deleteAlarm).not.toHaveBeenCalled();
  });
});
