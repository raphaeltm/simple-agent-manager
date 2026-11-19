/** Real cancellation writer races the production readiness -> boot replacement path. */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { handleNodeAgentReady } from '../../../src/durable-objects/task-runner/node-agent-ready-step';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';
import { setTaskStatus } from '../../../src/routes/tasks/_helpers';
import { deleteNodeResourcesStrict } from '../../../src/services/strict-node-deletion';
import { releaseVmProvisioningLease } from '../../../src/services/vm-admission-control';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/services/strict-node-deletion', () => ({
  deleteNodeResourcesStrict: vi.fn(),
}));
vi.mock('../../../src/services/vm-admission-control', () => ({
  releaseVmProvisioningLease: vi.fn(),
  renewVmProvisioningLease: vi.fn(),
  markVmAdmissionNodeReady: vi.fn(),
}));

let sqlite: Database.Database;
afterEach(() => {
  sqlite?.close();
  vi.resetAllMocks();
});

describe('boot replacement cancellation boundary', () => {
  it.each([
    ['provider deletion', false],
    ['provider deletion', true],
    ['lease release', false],
    ['lease release', true],
  ] as const)('rechecks task authority after %s (cancelled: %s)', async (boundary, cancelled) => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(`
      INSERT INTO users(id,email,status) VALUES('user','owner@example.test','active');
      INSERT INTO projects(id,user_id,name) VALUES('project','user','Project');
      INSERT INTO tasks(id,project_id,user_id,title,status,auto_provisioned_node_id)
        VALUES('task','project','user','Boot','delegated','node');
      INSERT INTO nodes(id,user_id,name,status,health_status,node_class,runtime,node_role)
        VALUES('node','user','Node','running','unhealthy','managed','vm','workspace');
    `);
    const database = createSqliteD1(sqlite);
    const state = {
      version: 1,
      taskId: 'task',
      projectId: 'project',
      userId: 'user',
      currentStep: 'node_agent_ready',
      config: {},
      stepResults: {
        nodeId: 'node',
        autoProvisioned: true,
        workspaceId: null,
        agentStarted: false,
      },
      agentReadyStartedAt: Date.now() - 400_000,
    } as TaskRunnerState;
    const rc = {
      env: { DATABASE: database, VM_AGENT_REQUIRED_VERSION: 'a'.repeat(40) },
      ctx: { storage: { put: vi.fn(async () => undefined), setAlarm: vi.fn() } },
      updateD1ExecutionStep: vi.fn(),
      getAgentReadyTimeoutMs: () => 900_000,
      getAgentReadyFreshnessSkewMs: () => 30_000,
      getAgentPollIntervalMs: () => 5_000,
      advanceToStep: vi.fn(async (s, step) => {
        s.currentStep = step;
      }),
    } as unknown as TaskRunnerContext;
    let entered!: () => void;
    const deleting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const deletionBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(deleteNodeResourcesStrict).mockImplementationOnce(async () => {
      if (boundary === 'provider deletion') {
        entered();
        await deletionBarrier;
      }
      const confirmedAt = new Date().toISOString();
      sqlite
        .prepare("UPDATE nodes SET runtime_termination_confirmed_at=? WHERE id='node'")
        .run(confirmedAt);
      return {
        providerVm: 'deleted',
        runtimeTerminationConfirmedAt: confirmedAt,
        runtimeIncarnationId: null,
        providerInstanceId: null,
      };
    });
    if (boundary === 'lease release') {
      vi.mocked(releaseVmProvisioningLease).mockImplementationOnce(async () => {
        entered();
        await deletionBarrier;
      });
    }
    const outcome = handleNodeAgentReady(state, rc).then(
      () => null,
      (error: unknown) => error
    );
    await deleting;
    expect(rc.advanceToStep).not.toHaveBeenCalled();
    if (cancelled) {
      const db = drizzle(database, { schema });
      const task = await db.select().from(schema.tasks).get();
      expect(task?.status).toBe('delegated');
      const result = await setTaskStatus(db, task!, 'cancelled', 'user', 'user');
      expect(result.status).toBe('cancelled');
    }
    release();
    const error = await outcome;
    expect(deleteNodeResourcesStrict).toHaveBeenCalledOnce();
    expect(
      sqlite.prepare('SELECT runtime_termination_confirmed_at FROM nodes').get()
    ).toMatchObject({
      runtime_termination_confirmed_at: expect.any(String),
    });
    if (cancelled) {
      expect(error).toMatchObject({ name: 'TaskExecutionAuthorityRevokedError' });
      expect(rc.advanceToStep).not.toHaveBeenCalled();
      expect(releaseVmProvisioningLease).toHaveBeenCalledTimes(
        boundary === 'lease release' ? 1 : 0
      );
      expect(state.stepResults.nodeId).toBe('node');
      expect(state.bootRecovery?.terminated).toBe(true);
      expect(sqlite.prepare('SELECT status,auto_provisioned_node_id FROM tasks').get()).toEqual({
        status: 'cancelled',
        auto_provisioned_node_id: boundary === 'provider deletion' ? 'node' : null,
      });
    } else {
      expect(error).toBeNull();
      expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_provisioning');
      expect(state.stepResults.nodeId).toBeNull();
    }
  });
});
