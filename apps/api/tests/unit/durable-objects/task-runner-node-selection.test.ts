import { describe, expect, it, vi } from 'vitest';

import { handleNodeSelection } from '../../../src/durable-objects/task-runner/node-steps';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';

type D1ResultMap = {
  preferredNode?: { id: string; status: string; vm_size: string } | null;
  warmNodes?: Array<{ id: string; vm_size: string; vm_location: string }>;
  freshWarmNode?: { status: string; warm_since: string | null } | null;
  existingNodes?: Array<{
    id: string;
    vm_size: string;
    vm_location: string;
    health_status: string;
    last_metrics: string | null;
  }>;
  workspaceCounts?: Array<{ node_id: string; c: number }>;
  healthByNode?: Record<string, { health_status: string | null; last_heartbeat_at: string | null }>;
};

function createStatement(sql: string, results: D1ResultMap) {
  let bound: unknown[] = [];
  return {
    bind(...args: unknown[]) {
      bound = args;
      return this;
    },
    first() {
      if (sql.includes('SELECT id, status, vm_size FROM nodes')) {
        return Promise.resolve(results.preferredNode ?? null);
      }
      if (sql.includes('SELECT status, warm_since FROM nodes')) {
        return Promise.resolve(results.freshWarmNode ?? null);
      }
      if (sql.includes('SELECT health_status, last_heartbeat_at FROM nodes')) {
        return Promise.resolve(results.healthByNode?.[String(bound[0])] ?? null);
      }
      return Promise.resolve(null);
    },
    all() {
      if (sql.includes('warm_since IS NOT NULL')) {
        return Promise.resolve({ results: results.warmNodes ?? [] });
      }
      if (sql.includes('SELECT id, vm_size, vm_location, health_status, last_metrics FROM nodes')) {
        return Promise.resolve({ results: results.existingNodes ?? [] });
      }
      if (sql.includes('SELECT node_id, COUNT(*) as c FROM workspaces')) {
        return Promise.resolve({ results: results.workspaceCounts ?? [] });
      }
      return Promise.resolve({ results: [] });
    },
  };
}

function createContext(results: D1ResultMap): TaskRunnerContext {
  return {
    env: {
      DATABASE: {
        prepare(sql: string) {
          return createStatement(sql, results);
        },
      },
      NODE_HEARTBEAT_STALE_SECONDS: '180',
      MAX_WORKSPACES_PER_NODE: '5',
    },
    ctx: {
      storage: {
        setAlarm: vi.fn(),
      },
    },
    advanceToStep: vi.fn().mockResolvedValue(undefined),
    getAgentPollIntervalMs: vi.fn(() => 1000),
    getAgentReadyTimeoutMs: vi.fn(() => 1000),
    getWorkspaceReadyTimeoutMs: vi.fn(() => 1000),
    getWorkspaceReadyPollIntervalMs: vi.fn(() => 1000),
    getProvisionPollIntervalMs: vi.fn(() => 1000),
    updateD1ExecutionStep: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskRunnerContext;
}

function createState(overrides: Partial<TaskRunnerState> = {}): TaskRunnerState {
  return {
    version: 1,
    taskId: 'task-1',
    projectId: 'project-1',
    userId: 'user-1',
    currentStep: 'node_selection',
    stepResults: {
      nodeId: null,
      autoProvisioned: false,
      workspaceId: null,
      chatSessionId: null,
      agentSessionId: null,
      agentStarted: false,
      mcpToken: null,
    },
    config: {
      vmSize: 'large',
      vmLocation: 'fsn1',
      branch: 'main',
      preferredNodeId: null,
      userName: null,
      userEmail: null,
      githubId: null,
      taskTitle: 'VM size regression',
      taskDescription: null,
      repository: 'owner/repo',
      installationId: '123',
      outputBranch: null,
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
      attachments: null,
      projectScaling: null,
    },
    retryCount: 0,
    workspaceReadyReceived: false,
    workspaceReadyStatus: null,
    workspaceErrorMessage: null,
    createdAt: Date.now(),
    lastStepAt: Date.now(),
    agentReadyStartedAt: null,
    workspaceReadyStartedAt: null,
    completed: false,
    ...overrides,
  };
}

describe('TaskRunner node selection VM size minimum behavior', () => {
  it('rejects an undersized preferred node before health verification', async () => {
    const state = createState({
      config: { ...createState().config, preferredNodeId: 'node-medium', vmSize: 'large' },
    });
    const rc = createContext({
      preferredNode: { id: 'node-medium', status: 'running', vm_size: 'medium' },
    });

    await expect(handleNodeSelection(state, rc)).rejects.toMatchObject({
      message: 'Specified node is smaller than the requested VM size',
      permanent: true,
    });
    expect(rc.advanceToStep).not.toHaveBeenCalled();
  });

  it('does not claim undersized warm nodes and falls through to provisioning', async () => {
    const lifecycleGet = vi.fn();
    const state = createState();
    const rc = createContext({
      warmNodes: [{ id: 'warm-medium', vm_size: 'medium', vm_location: 'fsn1' }],
      existingNodes: [],
    });
    rc.env.NODE_LIFECYCLE = {
      idFromName: vi.fn((id: string) => id),
      get: lifecycleGet,
    } as unknown as DurableObjectNamespace;

    await handleNodeSelection(state, rc);

    expect(lifecycleGet).not.toHaveBeenCalled();
    expect(state.stepResults.nodeId).toBeNull();
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_provisioning');
  });

  it('selects a larger existing node and skips smaller existing nodes', async () => {
    const state = createState({ config: { ...createState().config, vmSize: 'large' } });
    const rc = createContext({
      existingNodes: [
        {
          id: 'node-medium',
          vm_size: 'medium',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({ cpuLoadAvg1: 1, memoryPercent: 1 }),
        },
        {
          id: 'node-large',
          vm_size: 'large',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({ cpuLoadAvg1: 20, memoryPercent: 20 }),
        },
      ],
      healthByNode: {
        'node-large': {
          health_status: 'healthy',
          last_heartbeat_at: new Date().toISOString(),
        },
      },
    });

    await handleNodeSelection(state, rc);

    expect(state.stepResults.nodeId).toBe('node-large');
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'workspace_creation');
  });
});
