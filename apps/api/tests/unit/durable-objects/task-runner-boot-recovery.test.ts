import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { handleNodeAgentReady } from '../../../src/durable-objects/task-runner/node-agent-ready-step';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';
import type { Env } from '../../../src/env';
import { nodeBootFailureRoutes } from '../../../src/routes/node-boot-failure';
import { deleteNodeResourcesStrict } from '../../../src/services/strict-node-deletion';
import { releaseVmProvisioningLease } from '../../../src/services/vm-admission-control';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: vi
    .fn()
    .mockResolvedValue({ workspace: 'node', scope: 'node', type: 'callback' }),
}));
vi.mock('../../../src/services/strict-node-deletion', () => ({
  deleteNodeResourcesStrict: vi.fn(),
}));
vi.mock('../../../src/services/vm-admission-control', () => ({
  releaseVmProvisioningLease: vi.fn(),
  renewVmProvisioningLease: vi.fn(),
  markVmAdmissionNodeReady: vi.fn(),
}));
let sqlite: Database.Database;
let state: TaskRunnerState;
let saved: TaskRunnerState;
let rc: TaskRunnerContext;
const version = 'a'.repeat(40);
beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  sqlite.exec(`
    INSERT INTO users (id, email, status) VALUES ('user', 'user@example.test', 'active');
    INSERT INTO projects (id, user_id, name) VALUES ('project', 'user', 'Project');
    INSERT INTO tasks (id, project_id, user_id, title, status, auto_provisioned_node_id) VALUES ('task', 'project', 'user', 'Boot', 'delegated', 'node');
    INSERT INTO nodes (id, user_id, name, status, health_status, node_class, runtime, node_role) VALUES ('node', 'user', 'Node', 'running', 'unhealthy', 'managed', 'vm', 'workspace');
  `);
  state = {
    version: 1,
    taskId: 'task',
    projectId: 'project',
    userId: 'user',
    currentStep: 'node_agent_ready',
    stepResults: { nodeId: 'node', autoProvisioned: true, workspaceId: null, agentStarted: false },
    config: {},
    agentReadyStartedAt: Date.now() - 400_000,
  } as TaskRunnerState;
  saved = structuredClone(state);
  rc = {
    env: { DATABASE: createSqliteD1(sqlite), VM_AGENT_REQUIRED_VERSION: version },
    ctx: {
      storage: {
        put: vi.fn(async (_key, value) => {
          saved = structuredClone(value);
        }),
        setAlarm: vi.fn(),
      },
    },
    updateD1ExecutionStep: vi.fn(),
    getAgentReadyTimeoutMs: () => 900_000,
    getAgentReadyFreshnessSkewMs: () => 30_000,
    getAgentPollIntervalMs: () => 5_000,
    advanceToStep: vi.fn(async (s, step) => {
      s.currentStep = step;
      saved = structuredClone(s);
    }),
  } as unknown as TaskRunnerContext;
  vi.mocked(deleteNodeResourcesStrict).mockImplementation(async () => {
    sqlite
      .prepare("UPDATE nodes SET runtime_termination_confirmed_at = ? WHERE id = 'node'")
      .run(new Date().toISOString());
    return {
      providerVm: 'deleted',
      runtimeTerminationConfirmedAt: new Date().toISOString(),
      runtimeIncarnationId: null,
      providerInstanceId: null,
    };
  });
});
afterEach(() => sqlite.close());
function healthy(agentVersion = version) {
  sqlite
    .prepare(
      "UPDATE nodes SET health_status = 'healthy', last_heartbeat_at = ?, agent_ready_at = ?, agent_version = ? WHERE id = 'node'"
    )
    .run(new Date().toISOString(), new Date().toISOString(), agentVersion);
}

describe('fresh VM boot recovery', () => {
  it('replaces a never-heartbeating VM before the 15-minute deadline', async () => {
    await handleNodeAgentReady(state, rc);
    expect(deleteNodeResourcesStrict).toHaveBeenCalledTimes(1);
    expect(state.bootReplacementCount).toBe(1);
    expect(state.currentStep).toBe('node_provisioning');
    expect(state.stepResults.nodeId).toBeNull();
    expect(sqlite.prepare('SELECT status FROM nodes').get()).toEqual({ status: 'deleted' });
    expect(sqlite.prepare('SELECT auto_provisioned_node_id FROM tasks').get()).toEqual({
      auto_provisioned_node_id: null,
    });
  });
  it('supports disabling replacement while still cleaning the failed VM', async () => {
    rc.env.TASK_RUNNER_BOOT_MAX_REPLACEMENTS = '0';
    await expect(handleNodeAgentReady(state, rc)).rejects.toThrow('recovery exhausted');
    expect(state.bootReplacementCount).toBeUndefined();
    expect(deleteNodeResourcesStrict).toHaveBeenCalledTimes(1);
    expect(rc.advanceToStep).not.toHaveBeenCalled();
  });
  it('ignores old boot errors after successful startup', async () => {
    healthy();
    sqlite.exec("UPDATE nodes SET error_message = 'Node boot failed: origin_ca_bootstrap'");
    await handleNodeAgentReady(state, rc);
    expect(state.currentStep).toBe('workspace_creation');
    expect(deleteNodeResourcesStrict).not.toHaveBeenCalled();
  });
  it('fails closed when another workspace already occupies the node', async () => {
    sqlite.exec(
      "INSERT INTO workspaces (id, node_id, user_id, name, status) VALUES ('occupied', 'node', 'user', 'Workspace', 'running')"
    );
    await expect(handleNodeAgentReady(state, rc)).rejects.toThrow('empty-node proof missing');
    expect(deleteNodeResourcesStrict).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT status FROM nodes').get()).toEqual({ status: 'running' });
  });
  it.each(['warm_claim', 'other_owner'])(
    'protects a %s before its workspace is inserted',
    async (kind) => {
      sqlite
        .prepare(
          `INSERT INTO tasks (id, project_id, user_id, title, status, claimed_warm_node_id, claimed_warm_node_at, auto_provisioned_node_id)
      VALUES ('other', 'project', 'user', 'Other', 'delegated', ?, ?, ?)`
        )
        .run(
          kind === 'warm_claim' ? 'node' : null,
          new Date().toISOString(),
          kind === 'other_owner' ? 'node' : null
        );
      await expect(handleNodeAgentReady(state, rc)).rejects.toThrow('empty-node proof missing');
      expect(deleteNodeResourcesStrict).not.toHaveBeenCalled();
      expect(sqlite.prepare('SELECT status FROM nodes').get()).toEqual({ status: 'running' });
    }
  );
  it('does not replace a normal five-minute boot', async () => {
    state.agentReadyStartedAt = Date.now() - 330_000;
    await handleNodeAgentReady(state, rc);
    expect(rc.ctx.storage.setAlarm).toHaveBeenCalled();
    expect(deleteNodeResourcesStrict).not.toHaveBeenCalled();
  });
  it('replaces a healthy wrong-version node within one poll', async () => {
    healthy('b'.repeat(40));
    state.agentReadyStartedAt = Date.now();
    await handleNodeAgentReady(state, rc);
    expect(state.currentStep).toBe('node_provisioning');
    expect(deleteNodeResourcesStrict).toHaveBeenCalledTimes(1);
  });
  it('advances a matching-version control without replacing it', async () => {
    healthy();
    await handleNodeAgentReady(state, rc);
    expect(state.currentStep).toBe('workspace_creation');
    expect(deleteNodeResourcesStrict).not.toHaveBeenCalled();
  });
  it('reacts to explicit bootstrap failure without waiting for the deadline', async () => {
    state.agentReadyStartedAt = Date.now();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/nodes', nodeBootFailureRoutes);
    const response = await app.request(
      '/api/nodes/node/boot-failure',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer node-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'origin_ca_bootstrap' }),
      },
      rc.env
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true });
    await handleNodeAgentReady(state, rc);
    expect(state.currentStep).toBe('node_provisioning');
  });
  it('recovers the production deleted-node path', async () => {
    sqlite.exec("UPDATE nodes SET status = 'deleted'");
    await handleNodeAgentReady(state, rc);
    expect(state.currentStep).toBe('node_provisioning');
  });
  it('cleans a second failed boot but does not replace again', async () => {
    state.bootReplacementCount = 1;
    await expect(handleNodeAgentReady(state, rc)).rejects.toThrow('recovery exhausted');
    expect(deleteNodeResourcesStrict).toHaveBeenCalledTimes(1);
    expect(rc.advanceToStep).not.toHaveBeenCalled();
    expect(state.stepResults.autoProvisioned).toBe(false);
  });
  it('replays an exhausted cleanup verdict after reload without another deletion or allocation', async () => {
    state.bootReplacementCount = 1;
    await expect(handleNodeAgentReady(state, rc)).rejects.toThrow('recovery exhausted');
    state = structuredClone(saved);
    await expect(handleNodeAgentReady(state, rc)).rejects.toThrow('recovery exhausted');
    expect(deleteNodeResourcesStrict).toHaveBeenCalledTimes(1);
    expect(rc.advanceToStep).not.toHaveBeenCalled();
    expect(state.bootReplacementCount).toBe(1);
  });
  it('retains intent and budget when deletion fails, then resumes from durable state', async () => {
    vi.mocked(deleteNodeResourcesStrict).mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(handleNodeAgentReady(state, rc)).rejects.toThrow('provider unavailable');
    expect(rc.advanceToStep).not.toHaveBeenCalled();
    expect(saved.bootRecovery?.nodeId).toBe('node');
    state = structuredClone(saved);
    await handleNodeAgentReady(state, rc);
    expect(state.bootReplacementCount).toBe(1);
    expect(state.currentStep).toBe('node_provisioning');
  });
  it('resumes after task-pointer clearing without redoing provider deletion', async () => {
    vi.mocked(releaseVmProvisioningLease).mockRejectedValueOnce(
      new Error('crash after D1 cleanup')
    );
    await expect(handleNodeAgentReady(state, rc)).rejects.toThrow('crash');
    expect(saved.bootRecovery?.terminated).toBe(true);
    state = structuredClone(saved);
    await handleNodeAgentReady(state, rc);
    expect(deleteNodeResourcesStrict).toHaveBeenCalledTimes(1);
    expect(state.bootReplacementCount).toBe(1);
  });
  it.each(['reused', 'workspace', 'started', 'byo', 'foreign'])(
    'never deletes an unsafe %s node',
    async (kind) => {
      if (kind === 'reused') state.stepResults.autoProvisioned = false;
      if (kind === 'workspace') state.stepResults.workspaceId = 'workspace';
      if (kind === 'started') state.stepResults.agentStarted = true;
      if (kind === 'byo') sqlite.exec("UPDATE nodes SET node_class = 'byo'");
      if (kind === 'foreign') sqlite.exec('UPDATE tasks SET auto_provisioned_node_id = NULL');
      await expect(handleNodeAgentReady(state, rc)).rejects.toThrow();
      expect(deleteNodeResourcesStrict).not.toHaveBeenCalled();
    }
  );
});
