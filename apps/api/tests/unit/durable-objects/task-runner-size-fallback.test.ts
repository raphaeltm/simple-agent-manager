import { ProviderError } from '@simple-agent-manager/providers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleNodeProvisioning } from '../../../src/durable-objects/task-runner/node-steps';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';

// Mock the dynamically-imported service modules. node-steps imports these via
// `await import(...)` inside handleNodeProvisioning, so the mocks apply to the
// dynamic import too.
const createNodeRecord = vi.fn();
const provisionNode = vi.fn();
vi.mock('../../../src/services/nodes', () => ({
  createNodeRecord: (...args: unknown[]) => createNodeRecord(...args),
  provisionNode: (...args: unknown[]) => provisionNode(...args),
}));

const getRuntimeLimits = vi.fn(() => ({ nodeHeartbeatStaleSeconds: 180 }));
vi.mock('../../../src/services/limits', () => ({
  getRuntimeLimits: (...args: unknown[]) => getRuntimeLimits(...args),
}));

const resolveCredentialSource = vi.fn();
vi.mock('../../../src/services/provider-credentials', () => ({
  resolveCredentialSource: (...args: unknown[]) => resolveCredentialSource(...args),
}));

const checkQuotaForUser = vi.fn();
vi.mock('../../../src/services/compute-quotas', () => ({
  checkQuotaForUser: (...args: unknown[]) => checkQuotaForUser(...args),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({}),
}));

function capacityError(size: string): ProviderError {
  return new ProviderError('hetzner', 503, `No ${size} capacity`, {
    providerCode: 'resource_unavailable',
    category: 'transient_capacity',
  });
}

interface DbMockOptions {
  nodeCount?: number;
  /** Status returned by the post-provision verification SELECT, keyed by node id. */
  nodeStatusById?: Record<string, { status: string; error_message: string | null }>;
}

function createDbMock(opts: DbMockOptions) {
  const runCalls: Array<{ sql: string; args: unknown[] }> = [];
  const DATABASE = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          bound = args;
          return this;
        },
        first() {
          if (sql.includes('SELECT COUNT(*) as c FROM nodes')) {
            return Promise.resolve({ c: opts.nodeCount ?? 0 });
          }
          if (sql.includes('SELECT status, error_message FROM nodes')) {
            const id = String(bound[0]);
            return Promise.resolve(
              opts.nodeStatusById?.[id] ?? { status: 'running', error_message: null }
            );
          }
          return Promise.resolve(null);
        },
        run() {
          runCalls.push({ sql, args: bound });
          return Promise.resolve({ success: true });
        },
      };
    },
  };
  return { DATABASE, runCalls };
}

function createContext(
  database: ReturnType<typeof createDbMock>['DATABASE'],
  envOverrides: Record<string, string> = {}
): TaskRunnerContext {
  return {
    env: {
      DATABASE: database,
      MAX_NODES_PER_USER: '10',
      COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'false',
      ...envOverrides,
    },
    ctx: {
      storage: {
        put: vi.fn().mockResolvedValue(undefined),
        setAlarm: vi.fn(),
      },
    },
    advanceToStep: vi.fn().mockResolvedValue(undefined),
    getProvisionPollIntervalMs: vi.fn(() => 1000),
    getProvisionTimeoutMs: vi.fn(() => 600_000),
    updateD1ExecutionStep: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskRunnerContext;
}

function createState(
  overrides: { vmSize?: 'small' | 'medium' | 'large'; vmSizeSource?: string } = {}
): TaskRunnerState {
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
      chatSessionId: null,
      agentSessionId: null,
      agentStarted: false,
      mcpToken: null,
      provisionedVmSize: null,
    },
    config: {
      vmSize: overrides.vmSize ?? 'large',
      vmLocation: 'fsn1',
      branch: 'main',
      preferredNodeId: null,
      userName: null,
      userEmail: null,
      githubId: null,
      taskTitle: 'capacity test',
      taskDescription: null,
      repository: 'owner/repo',
      installationId: '123',
      outputBranch: null,
      defaultBranch: 'main',
      projectDefaultVmSize: null,
      chatSessionId: null,
      agentType: null,
      workspaceProfile: null,
      devcontainerConfigName: null,
      cloudProvider: null,
      taskMode: 'task',
      model: null,
      permissionMode: null,
      opencodeProvider: null,
      opencodeBaseUrl: null,
      systemPromptAppend: null,
      agentProfileHint: null,
      attachments: null,
      projectScaling: null,
      vmSizeSource: (overrides.vmSizeSource ?? 'project') as TaskRunnerState['config']['vmSizeSource'],
    },
    retryCount: 0,
    workspaceReadyReceived: false,
    workspaceReadyStatus: null,
    workspaceErrorMessage: null,
    createdAt: Date.now(),
    lastStepAt: Date.now(),
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

beforeEach(() => {
  vi.clearAllMocks();
  getRuntimeLimits.mockReturnValue({ nodeHeartbeatStaleSeconds: 180 });
  createNodeRecord.mockImplementation(async (_env: unknown, opts: { vmSize: string }) => ({
    id: `node-${opts.vmSize}`,
  }));
});

describe('TaskRunner size-fallback descent', () => {
  it('descends to the next-smaller size on transient capacity and records the downgrade', async () => {
    provisionNode.mockImplementation(async (id: string) => {
      if (id === 'node-large') throw capacityError('large');
      // node-medium succeeds
    });
    const { DATABASE, runCalls } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({ vmSize: 'large', vmSizeSource: 'project' });

    await handleNodeProvisioning(state, rc);

    // A fresh node row is created per size attempt (create-then-try per iteration).
    expect(createNodeRecord).toHaveBeenCalledTimes(2);
    expect(provisionNode).toHaveBeenCalledTimes(2);
    expect(state.stepResults.nodeId).toBe('node-medium');
    expect(state.stepResults.autoProvisioned).toBe(true);
    expect(state.stepResults.provisionedVmSize).toBe('medium');
    expect(state.config.vmSize).toBe('medium');
    // provisioned_vm_size persisted to the task for UI surfacing
    const downgradeWrite = runCalls.find((c) =>
      c.sql.includes('UPDATE tasks SET provisioned_vm_size = ?')
    );
    expect(downgradeWrite).toBeDefined();
    expect(downgradeWrite?.args[0]).toBe('medium');
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
  });

  it('descends from a project-default medium to small when medium is exhausted', async () => {
    provisionNode.mockImplementation(async (id: string) => {
      if (id === 'node-medium') throw capacityError('medium');
      // node-small succeeds
    });
    const { DATABASE, runCalls } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({ vmSize: 'medium', vmSizeSource: 'project' });

    await handleNodeProvisioning(state, rc);

    expect(createNodeRecord).toHaveBeenCalledTimes(2);
    expect(provisionNode).toHaveBeenCalledTimes(2);
    expect(state.stepResults.nodeId).toBe('node-small');
    expect(state.stepResults.provisionedVmSize).toBe('small');
    expect(state.config.vmSize).toBe('small');
    const downgradeWrite = runCalls.find((c) =>
      c.sql.includes('UPDATE tasks SET provisioned_vm_size = ?')
    );
    expect(downgradeWrite).toBeDefined();
    expect(downgradeWrite?.args[0]).toBe('small');
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
  });

  it('does NOT record a downgrade when the first (requested) size succeeds', async () => {
    provisionNode.mockResolvedValue(undefined);
    const { DATABASE, runCalls } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({ vmSize: 'large', vmSizeSource: 'project' });

    await handleNodeProvisioning(state, rc);

    expect(provisionNode).toHaveBeenCalledTimes(1);
    expect(state.stepResults.provisionedVmSize).toBe('large');
    expect(state.config.vmSize).toBe('large');
    expect(
      runCalls.find((c) => c.sql.includes('UPDATE tasks SET provisioned_vm_size = ?'))
    ).toBeUndefined();
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
  });

  it('never downgrades an explicit size — fails with a clear message', async () => {
    provisionNode.mockImplementation(async () => {
      throw capacityError('large');
    });
    const { DATABASE, runCalls } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({ vmSize: 'large', vmSizeSource: 'task' });

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      message: 'There were no large machines available.',
      permanent: true,
    });
    // Only the requested size attempted — no descent.
    expect(provisionNode).toHaveBeenCalledTimes(1);
    expect(
      runCalls.find((c) => c.sql.includes('UPDATE tasks SET provisioned_vm_size = ?'))
    ).toBeUndefined();
    expect(rc.advanceToStep).not.toHaveBeenCalled();
  });

  it.each(['trigger', 'agent-profile'])(
    'never downgrades a %s-sourced size — fails with a clear message',
    async (source) => {
      provisionNode.mockImplementation(async () => {
        throw capacityError('large');
      });
      const { DATABASE, runCalls } = createDbMock({});
      const rc = createContext(DATABASE);
      const state = createState({ vmSize: 'large', vmSizeSource: source });

      await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
        message: 'There were no large machines available.',
        permanent: true,
      });
      expect(provisionNode).toHaveBeenCalledTimes(1);
      expect(
        runCalls.find((c) => c.sql.includes('UPDATE tasks SET provisioned_vm_size = ?'))
      ).toBeUndefined();
      expect(rc.advanceToStep).not.toHaveBeenCalled();
    }
  );

  it('reports the medium-start chain in the terminal message when all sizes are exhausted', async () => {
    provisionNode.mockImplementation(async () => {
      throw capacityError('any');
    });
    const { DATABASE } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({ vmSize: 'medium', vmSizeSource: 'project' });

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      message: 'No capacity for any available VM size (tried medium, small).',
      permanent: true,
    });
    expect(provisionNode).toHaveBeenCalledTimes(2);
    expect(rc.advanceToStep).not.toHaveBeenCalled();
  });

  it('fails terminally when every size in the chain is capacity-exhausted', async () => {
    provisionNode.mockImplementation(async () => {
      throw capacityError('any');
    });
    const { DATABASE } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({ vmSize: 'large', vmSizeSource: 'platform' });

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      message: 'No capacity for any available VM size (tried large, medium, small).',
      permanent: true,
    });
    expect(provisionNode).toHaveBeenCalledTimes(3);
    expect(rc.advanceToStep).not.toHaveBeenCalled();
  });

  it('fails fast on a non-capacity provider error without descending', async () => {
    provisionNode.mockImplementation(async () => {
      throw new ProviderError('hetzner', 400, 'Bad VM config', {
        providerCode: 'invalid_input',
        category: 'invalid_config',
      });
    });
    const { DATABASE } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({ vmSize: 'large', vmSizeSource: 'project' });

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      message: 'Bad VM config',
      permanent: true,
    });
    expect(provisionNode).toHaveBeenCalledTimes(1);
    expect(rc.advanceToStep).not.toHaveBeenCalled();
  });

  it('fails fast on a quota-exhausted provider error without descending', async () => {
    provisionNode.mockImplementation(async () => {
      throw new ProviderError('hetzner', 429, 'Server limit exceeded', {
        providerCode: 'server_limit_exceeded',
        category: 'quota_exceeded',
      });
    });
    const { DATABASE, runCalls } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({ vmSize: 'large', vmSizeSource: 'project' });

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      message: 'Server limit exceeded',
      permanent: true,
    });
    // quota_exceeded is NOT transient capacity — descent must not happen.
    expect(provisionNode).toHaveBeenCalledTimes(1);
    expect(
      runCalls.find((c) => c.sql.includes('UPDATE tasks SET provisioned_vm_size = ?'))
    ).toBeUndefined();
    expect(rc.advanceToStep).not.toHaveBeenCalled();
  });

  it('does not descend when the kill switch disables fallback', async () => {
    provisionNode.mockImplementation(async () => {
      throw capacityError('large');
    });
    const { DATABASE } = createDbMock({});
    const rc = createContext(DATABASE, { CAPACITY_SIZE_FALLBACK_ENABLED: 'false' });
    const state = createState({ vmSize: 'large', vmSizeSource: 'project' });

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      message: 'There were no large machines available.',
      permanent: true,
    });
    expect(provisionNode).toHaveBeenCalledTimes(1);
  });

  it('recovers an already-provisioned node after a crash instead of creating a duplicate', async () => {
    // Simulate a prior attempt that provisioned node-medium (a downgrade from
    // the requested large) but crashed before persisting nodeId to DO storage.
    // The task row still records the node via auto_provisioned_node_id.
    const runCalls: Array<{ sql: string; args: unknown[] }> = [];
    const DATABASE = {
      prepare(sql: string) {
        let bound: unknown[] = [];
        return {
          bind(...args: unknown[]) {
            bound = args;
            return this;
          },
          first() {
            if (sql.includes('SELECT auto_provisioned_node_id FROM tasks')) {
              return Promise.resolve({ auto_provisioned_node_id: 'node-medium' });
            }
            if (sql.includes('SELECT id, status, vm_size FROM nodes')) {
              return Promise.resolve({ id: 'node-medium', status: 'running', vm_size: 'medium' });
            }
            if (sql.includes('SELECT id, status, error_message FROM nodes')) {
              return Promise.resolve({ id: 'node-medium', status: 'running', error_message: null });
            }
            if (sql.includes('SELECT COUNT(*) as c FROM nodes')) {
              return Promise.resolve({ c: 0 });
            }
            return Promise.resolve(null);
          },
          run() {
            runCalls.push({ sql, args: bound });
            return Promise.resolve({ success: true });
          },
        };
      },
    } as unknown as ReturnType<typeof createDbMock>['DATABASE'];
    const rc = createContext(DATABASE);
    const state = createState({ vmSize: 'large', vmSizeSource: 'project' });

    await handleNodeProvisioning(state, rc);

    // No duplicate node created — the existing one was adopted.
    expect(createNodeRecord).not.toHaveBeenCalled();
    expect(provisionNode).not.toHaveBeenCalled();
    expect(state.stepResults.nodeId).toBe('node-medium');
    expect(state.stepResults.autoProvisioned).toBe(true);
    expect(state.stepResults.provisionedVmSize).toBe('medium');
    expect(state.config.vmSize).toBe('medium');
    // The hydrated state must be persisted to DO storage so a subsequent crash
    // resumes from the adopted node rather than re-running recovery.
    expect(rc.ctx.storage.put).toHaveBeenCalledWith('state', state);
    // The downgrade is re-recorded in case the crash pre-empted the original write.
    const downgradeWrite = runCalls.find((c) =>
      c.sql.includes('UPDATE tasks SET provisioned_vm_size = ?')
    );
    expect(downgradeWrite?.args[0]).toBe('medium');
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
  });

  it('does not adopt a capacity-deleted node row on recovery and (re)provisions', async () => {
    // auto_provisioned_node_id points to a node that was deleted after a capacity
    // failure — the row is gone, so recovery must fall through to fresh provisioning.
    provisionNode.mockResolvedValue(undefined);
    const runCalls: Array<{ sql: string; args: unknown[] }> = [];
    const DATABASE = {
      prepare(sql: string) {
        let bound: unknown[] = [];
        return {
          bind(...args: unknown[]) {
            bound = args;
            return this;
          },
          first() {
            if (sql.includes('SELECT auto_provisioned_node_id FROM tasks')) {
              return Promise.resolve({ auto_provisioned_node_id: 'node-deleted' });
            }
            if (sql.includes('SELECT id, status, vm_size FROM nodes')) {
              return Promise.resolve(null); // deleted row
            }
            if (sql.includes('SELECT status, error_message FROM nodes')) {
              return Promise.resolve({ status: 'running', error_message: null });
            }
            if (sql.includes('SELECT COUNT(*) as c FROM nodes')) {
              return Promise.resolve({ c: 0 });
            }
            return Promise.resolve(null);
          },
          run() {
            runCalls.push({ sql, args: bound });
            return Promise.resolve({ success: true });
          },
        };
      },
    } as unknown as ReturnType<typeof createDbMock>['DATABASE'];
    const rc = createContext(DATABASE);
    const state = createState({ vmSize: 'large', vmSizeSource: 'project' });

    await handleNodeProvisioning(state, rc);

    expect(createNodeRecord).toHaveBeenCalledTimes(1);
    expect(provisionNode).toHaveBeenCalledTimes(1);
    expect(state.stepResults.nodeId).toBe('node-large');
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
  });

  it('fails fast on quota exhaustion before any node is created', async () => {
    resolveCredentialSource.mockResolvedValue({ credentialSource: 'platform' });
    checkQuotaForUser.mockResolvedValue({ allowed: false, used: 100, limit: 100 });
    const { DATABASE } = createDbMock({});
    const rc = createContext(DATABASE, { COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'true' });
    const state = createState({ vmSize: 'large', vmSizeSource: 'project' });

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      permanent: true,
    });
    expect(createNodeRecord).not.toHaveBeenCalled();
    expect(provisionNode).not.toHaveBeenCalled();
  });
});
