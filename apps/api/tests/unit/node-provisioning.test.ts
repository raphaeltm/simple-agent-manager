/** Execute extracted handlers against SQLite; only node service boundaries are mocked. */
import { ProviderError } from '@simple-agent-manager/providers';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { parseEnvInt } from '../../src/durable-objects/task-runner/helpers';
import {
  handleNodeAgentReady,
  handleNodeProvisioning,
} from '../../src/durable-objects/task-runner/node-steps';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../src/durable-objects/task-runner/types';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const { createNodeRecord, provisionNode } = vi.hoisted(() => ({
  createNodeRecord: vi.fn(),
  provisionNode: vi.fn(),
}));
vi.mock('../../src/services/nodes', () => ({ createNodeRecord, provisionNode }));

let sqlite: Database.Database;
const persistedStates: TaskRunnerState[] = [];
const NOW = Date.parse('2026-09-07T12:00:00Z');

function makeState(): TaskRunnerState {
  return {
    version: 1,
    taskId: 'task-1',
    projectId: 'project-1',
    userId: 'user-1',
    currentStep: 'node_provisioning',
    stepResults: {
      nodeId: null,
      autoProvisioned: false,
      workspaceId: null,
      chatSessionId: 'chat-1',
      agentSessionId: null,
      agentStarted: false,
      mcpToken: null,
    },
    config: {
      vmSize: 'medium',
      vmLocation: 'hel1',
      branch: 'main',
      preferredNodeId: null,
      userName: 'Test User',
      userEmail: 'test@example.com',
      githubId: null,
      taskTitle: 'Provision this task with a title longer than forty characters',
      taskDescription: null,
      repository: 'org/repo',
      installationId: 'installation-1',
      outputBranch: null,
      defaultBranch: 'main',
      projectDefaultVmSize: null,
      chatSessionId: null,
      agentType: null,
      workspaceProfile: null,
      devcontainerConfigName: null,
      cloudProvider: 'hetzner',
      credentialAttributionUserId: 'user-1',
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
      projectScaling: null,
      capacityPoolSelection: null,
    },
    retryCount: 0,
    workspaceReadyReceived: false,
    workspaceReadyStatus: null,
    workspaceErrorMessage: null,
    createdAt: NOW,
    lastStepAt: NOW,
    provisioningStartedAt: null,
    agentReadyStartedAt: null,
    workspaceReadyStartedAt: null,
    workspaceDispatchStartedAt: null,
    workspaceDispatchAttempts: 0,
    workspaceDispatchLastAttemptAt: null,
    workspaceDispatchLastError: null,
    workspaceDispatchAckedAt: null,
    lastD1Step: null,
    completed: false,
  };
}

function makeContext(envOverrides: Record<string, string> = {}): TaskRunnerContext {
  return {
    env: {
      DATABASE: createSqliteD1(sqlite),
      COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'false',
      VM_AGENT_REQUIRED_VERSION: '0123456789abcdef0123456789abcdef01234567',
      ...envOverrides,
    },
    ctx: {
      storage: {
        put: vi.fn(async (_key: string, state: TaskRunnerState) => {
          persistedStates.push(structuredClone(state));
        }),
        setAlarm: vi.fn().mockResolvedValue(undefined),
      },
    },
    assertRecoveryAuthority: vi.fn().mockResolvedValue(undefined),
    advanceToStep: vi.fn().mockResolvedValue(undefined),
    updateD1ExecutionStep: vi.fn().mockResolvedValue(undefined),
    getProvisionPollIntervalMs: () => 700,
    getProvisionTimeoutMs: () => 60_000,
    getAgentPollIntervalMs: () => 900,
    getAgentReadyTimeoutMs: () => 120_000,
    getAgentReadyFreshnessSkewMs: () => 2_000,
  } as unknown as TaskRunnerContext;
}

function seedNode(
  id: string,
  status = 'running',
  userId = 'user-1',
  role = 'workspace',
  nodeClass = 'managed'
): void {
  sqlite
    .prepare(
      `INSERT INTO nodes
    (id, user_id, name, status, vm_size, vm_location, cloud_provider, node_role, node_class)
    VALUES (?, ?, ?, ?, 'medium', 'hel1', 'hetzner', ?, ?)`
    )
    .run(id, userId, id, status, role, nodeClass);
}

beforeEach(() => {
  vi.resetAllMocks();
  persistedStates.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  sqlite.exec(
    `INSERT INTO tasks (id, project_id, user_id) VALUES ('task-1', 'project-1', 'user-1')`
  );
  createNodeRecord.mockImplementation(async () => {
    seedNode('new-node', 'creating');
    return { id: 'new-node' };
  });
  provisionNode.mockImplementation(async (nodeId: string) => {
    sqlite.prepare("UPDATE nodes SET status = 'running' WHERE id = ?").run(nodeId);
  });
});

afterEach(() => {
  sqlite.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('node limit enforcement', () => {
  it.each([
    [undefined, 10],
    ['5', 5],
    ['1', 1],
    ['0', 10],
    ['-3', 10],
    ['unlimited', 10],
    ['50', 50],
  ] as const)('parses configured limit %s as %s', (value, expected) => {
    expect(parseEnvInt(value, 10)).toBe(expected);
  });

  it.each(['running', 'creating', 'recovery'])(
    'counts managed %s nodes at the exact limit',
    async (status) => {
      seedNode('existing', status);
      const rc = makeContext({ MAX_NODES_PER_USER: '1' });
      await expect(handleNodeProvisioning(makeState(), rc)).rejects.toMatchObject({
        message: 'Maximum 1 nodes allowed. Cannot auto-provision.',
        permanent: true,
      });
      expect(createNodeRecord).not.toHaveBeenCalled();
      expect(provisionNode).not.toHaveBeenCalled();
    }
  );

  it('uses the default limit of ten and rejects counts above it', async () => {
    for (let index = 0; index < 11; index++) seedNode(`existing-${index}`);
    await expect(handleNodeProvisioning(makeState(), makeContext())).rejects.toMatchObject({
      message: 'Maximum 10 nodes allowed. Cannot auto-provision.',
      permanent: true,
    });
    expect(createNodeRecord).not.toHaveBeenCalled();
  });

  it('excludes stopped, deleted, other-user, deployment, and user-owned nodes from the limit', async () => {
    seedNode('stopped', 'stopped');
    seedNode('deleted', 'deleted');
    seedNode('other-user', 'running', 'user-2');
    seedNode('deployment', 'running', 'user-1', 'deployment');
    seedNode('byo', 'running', 'user-1', 'workspace', 'user-owned');
    const state = makeState();
    const rc = makeContext({ MAX_NODES_PER_USER: '1' });
    await handleNodeProvisioning(state, rc);
    expect(createNodeRecord).toHaveBeenCalledOnce();
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
  });
});

describe('provisioning service handoff', () => {
  it('persists task ownership before allocation and passes placement plus task context', async () => {
    const state = makeState();
    const rc = makeContext();
    let ownershipAtAllocation: unknown;
    provisionNode.mockImplementation(async (nodeId: string) => {
      ownershipAtAllocation = sqlite
        .prepare('SELECT auto_provisioned_node_id FROM tasks WHERE id = ?')
        .get(state.taskId);
      expect(persistedStates.at(-1)?.stepResults).toMatchObject({
        nodeId: 'new-node',
        autoProvisioned: true,
      });
      sqlite.prepare("UPDATE nodes SET status = 'running' WHERE id = ?").run(nodeId);
    });
    await handleNodeProvisioning(state, rc);
    expect(ownershipAtAllocation).toEqual({ auto_provisioned_node_id: 'new-node' });
    expect(createNodeRecord).toHaveBeenCalledWith(
      rc.env,
      expect.objectContaining({
        userId: 'user-1',
        name: `Auto: ${state.config.taskTitle.slice(0, 40)}`,
        vmSize: 'medium',
        vmLocation: 'hel1',
        cloudProvider: 'hetzner',
      })
    );
    expect(provisionNode).toHaveBeenCalledWith(
      'new-node',
      rc.env,
      {
        projectId: 'project-1',
        chatSessionId: 'chat-1',
        taskId: 'task-1',
        taskMode: 'task',
      },
      expect.objectContaining({
        rethrowProviderError: true,
        assertExternalMutationAuthority: expect.any(Function),
      })
    );
    expect(state.stepResults).toMatchObject({ nodeId: 'new-node', autoProvisioned: true });
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
  });

  it.each(['creating', 'error', 'missing'])(
    'does not advance when provisionNode returns with node %s',
    async (status) => {
      provisionNode.mockImplementation(async () => {
        if (status === 'missing') sqlite.prepare('DELETE FROM nodes WHERE id = ?').run('new-node');
        else sqlite.prepare('UPDATE nodes SET status = ? WHERE id = ?').run(status, 'new-node');
      });
      const rc = makeContext();
      await expect(handleNodeProvisioning(makeState(), rc)).rejects.toThrow(
        'Node provisioning failed'
      );
      expect(rc.advanceToStep).not.toHaveBeenCalled();
    }
  );

  it('propagates a provider failure without allocating again or advancing', async () => {
    const error = new ProviderError('hetzner', 401, 'Unauthorized', { category: 'auth_error' });
    provisionNode.mockRejectedValue(error);
    const rc = makeContext();
    await expect(handleNodeProvisioning(makeState(), rc)).rejects.toMatchObject({
      message: 'Unauthorized',
      permanent: true,
    });
    expect(createNodeRecord).toHaveBeenCalledOnce();
    expect(provisionNode).toHaveBeenCalledOnce();
    expect(rc.advanceToStep).not.toHaveBeenCalled();
  });

  it.each(['running', 'creating', 'error', 'stopped'])(
    'resumes an existing %s node without duplicating it',
    async (status) => {
      seedNode('existing', status);
      const state = makeState();
      state.stepResults.nodeId = 'existing';
      const rc = makeContext();
      if (status === 'error' || status === 'stopped') {
        await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({ permanent: true });
        expect(rc.advanceToStep).not.toHaveBeenCalled();
      } else {
        await handleNodeProvisioning(state, rc);
        if (status === 'running')
          expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
        else expect(rc.ctx.storage.setAlarm).toHaveBeenCalledWith(NOW + 700);
      }
      expect(createNodeRecord).not.toHaveBeenCalled();
      expect(provisionNode).not.toHaveBeenCalled();
    }
  );
});

describe('agent readiness through persisted heartbeat records', () => {
  it('rejects a missing node id before checking readiness', async () => {
    await expect(handleNodeAgentReady(makeState(), makeContext())).rejects.toThrow(
      'No nodeId in state'
    );
  });

  it.each([
    ['fresh', 0, true],
    ['inside configured skew', -1_000, true],
    ['outside configured skew', -3_000, false],
  ] as const)(
    '%s heartbeat controls dispatch without a direct VM fetch',
    async (_name, offset, ready) => {
      seedNode('existing');
      sqlite
        .prepare(
          `UPDATE nodes SET health_status = 'healthy', agent_version = '0123456789abcdef0123456789abcdef01234567',
      last_heartbeat_at = ?, agent_ready_at = ? WHERE id = 'existing'`
        )
        .run(new Date(NOW + offset).toISOString(), new Date(NOW - 10_000).toISOString());
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const state = makeState();
      state.stepResults.nodeId = 'existing';
      const rc = makeContext();
      await handleNodeAgentReady(state, rc);
      expect(state.agentReadyStartedAt).toBe(NOW);
      expect(rc.ctx.storage.put).toHaveBeenCalledWith('state', state);
      expect(fetch).not.toHaveBeenCalled();
      if (ready) {
        expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'workspace_creation');
        expect(rc.ctx.storage.setAlarm).not.toHaveBeenCalled();
      } else {
        expect(rc.advanceToStep).not.toHaveBeenCalled();
        expect(rc.ctx.storage.setAlarm).toHaveBeenCalledWith(NOW + 900);
      }
    }
  );

  it('throws a permanent error at the configured agent-ready timeout', async () => {
    seedNode('existing');
    const state = makeState();
    state.stepResults.nodeId = 'existing';
    state.agentReadyStartedAt = NOW - 120_001;
    const rc = makeContext();
    await expect(handleNodeAgentReady(state, rc)).rejects.toMatchObject({
      message: 'Node agent not ready within 120000ms',
      permanent: true,
    });
    expect(rc.advanceToStep).not.toHaveBeenCalled();
    expect(rc.ctx.storage.setAlarm).not.toHaveBeenCalled();
  });
});
