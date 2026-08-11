/**
 * Behavioral placement persistence coverage for the TaskRunner production path.
 *
 * The D1 boundary is backed by real in-memory SQLite. Node selection, provisioning
 * state transitions, and workspace creation all run through their production
 * handlers; only external Durable Object scheduling/storage is substituted.
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import {
  handleNodeAgentReady,
  handleNodeProvisioning,
  handleNodeSelection,
} from '../../src/durable-objects/task-runner/node-steps';
import { recordProvisioningAttempt } from '../../src/durable-objects/task-runner/placement';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../src/durable-objects/task-runner/types';
import { handleWorkspaceCreation } from '../../src/durable-objects/task-runner/workspace-steps';
import type { Env } from '../../src/env';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const REQUIRED_AGENT_VERSION = 'a'.repeat(40);
const REUSED_NODE_ID = '01KZR2JAP92AK3SKW951E4H21M';
const PROVISIONED_NODE_ID = '01KZRHQ4PVD1V55YP18H3BWKBF';

type PlacementRow = {
  placement_explanation_json: string | null;
};

let sqlite: Database.Database | null = null;

function createDatabase(): Env {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  return {
    DATABASE: createSqliteD1(sqlite),
    MAX_WORKSPACES_PER_NODE: '5',
    NODE_HEARTBEAT_STALE_SECONDS: '180',
    VM_AGENT_REQUIRED_VERSION: REQUIRED_AGENT_VERSION,
  } as Env;
}

function seedTask(): void {
  const now = new Date().toISOString();
  sqlite
    ?.prepare(
      `INSERT INTO tasks
         (id, project_id, user_id, title, status, task_mode, created_by, created_at, updated_at)
       VALUES ('task-1', 'project-1', 'user-1', 'Placement task', 'queued', 'task',
               'user-1', ?, ?)`
    )
    .run(now, now);
}

function seedNode(id: string, status: 'creating' | 'running'): void {
  const now = new Date().toISOString();
  sqlite
    ?.prepare(
      `INSERT INTO nodes
         (id, user_id, name, status, vm_size, vm_location, runtime, node_role,
          node_mode, health_status, heartbeat_stale_after_seconds,
          last_heartbeat_at, agent_ready_at, agent_version, last_metrics,
          credential_source, created_at, updated_at)
       VALUES (?, 'user-1', 'Placement node', ?, 'medium', 'hel1', 'vm', 'workspace',
               'shared', 'healthy', 180, ?, ?, ?, ?, 'user', ?, ?)`
    )
    .run(
      id,
      status,
      now,
      now,
      REQUIRED_AGENT_VERSION,
      JSON.stringify({ cpuLoadAvg1: 2, memoryPercent: 10 }),
      now,
      now
    );
}

function createState(): TaskRunnerState {
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
      provisionedVmSize: null,
    },
    config: {
      vmSize: 'medium',
      vmLocation: 'hel1',
      branch: 'main',
      preferredNodeId: null,
      userName: 'Test User',
      userEmail: 'user-1@example.test',
      githubId: null,
      taskTitle: 'Placement task',
      taskDescription: null,
      repository: 'owner/repository',
      installationId: 'installation-1',
      outputBranch: null,
      defaultBranch: 'main',
      projectDefaultVmSize: null,
      chatSessionId: null,
      agentType: null,
      workspaceProfile: null,
      devcontainerConfigName: null,
      cloudProvider: null,
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

function parsePlacement(table: 'tasks' | 'workspaces'): Record<string, unknown> {
  const row = sqlite?.prepare(`SELECT placement_explanation_json FROM ${table} LIMIT 1`).get() as
    | PlacementRow
    | undefined;
  expect(row?.placement_explanation_json).toBeTypeOf('string');
  return JSON.parse(row?.placement_explanation_json ?? '{}') as Record<string, unknown>;
}

function createContext(
  env: Env,
  advances: string[],
  provisioningTimeoutMs = 15 * 60 * 1000
): TaskRunnerContext {
  return {
    env,
    ctx: {
      storage: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        setAlarm: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as DurableObjectState,
    advanceToStep: vi.fn(async (_state, nextStep) => {
      if (nextStep === 'workspace_creation') {
        // Selection or provisioning evidence must be durable before the runner
        // can proceed to workspace creation.
        expect(parsePlacement('tasks')).toMatchObject({ schemaVersion: 2 });
      }
      if (nextStep === 'workspace_dispatch') {
        // Workspace evidence must exist before dispatch can be scheduled.
        expect(parsePlacement('workspaces')).toEqual(parsePlacement('tasks'));
      }
      advances.push(nextStep);
    }),
    getAgentPollIntervalMs: () => 1_000,
    getAgentReadyTimeoutMs: () => 15 * 60 * 1000,
    getWorkspaceDispatchTimeoutMs: () => 15 * 60 * 1000,
    getWorkspaceDispatchBaseDelayMs: () => 1_000,
    getWorkspaceDispatchMaxDelayMs: () => 30_000,
    getWorkspaceReadyTimeoutMs: () => 30 * 60 * 1000,
    getWorkspaceReadyPollIntervalMs: () => 1_000,
    getProvisionPollIntervalMs: () => 1_000,
    getProvisionTimeoutMs: () => provisioningTimeoutMs,
    updateD1ExecutionStep: vi.fn().mockResolvedValue(undefined),
  };
}

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

describe('TaskRunner placement persistence vertical slice', () => {
  it('persists a reused-node decision to the task before workspace creation and dispatch', async () => {
    const env = createDatabase();
    seedTask();
    seedNode(REUSED_NODE_ID, 'running');
    const state = createState();
    const advances: string[] = [];
    const rc = createContext(env, advances);

    await handleNodeSelection(state, rc);

    expect(state.stepResults.nodeId).toBe(REUSED_NODE_ID);
    expect(parsePlacement('tasks')).toMatchObject({
      schemaVersion: 2,
      outcome: 'reused',
      selectedNodeId: REUSED_NODE_ID,
      evaluatedNodes: [{ nodeId: REUSED_NODE_ID, accepted: true, rejectionReasons: [] }],
    });

    await handleWorkspaceCreation(state, rc);

    expect(parsePlacement('workspaces')).toEqual(parsePlacement('tasks'));
    expect(sqlite?.prepare(`SELECT status FROM tasks WHERE id = 'task-1'`).get()).toEqual({
      status: 'delegated',
    });
    expect(advances).toEqual(['workspace_creation', 'workspace_dispatch']);
  });

  it('carries finalized provision-new evidence from selection through workspace dispatch', async () => {
    const env = createDatabase();
    seedTask();
    const state = createState();
    const advances: string[] = [];
    const rc = createContext(env, advances);

    await handleNodeSelection(state, rc);
    expect(parsePlacement('tasks')).toMatchObject({
      outcome: 'provisioned',
      selectionPath: 'provisioning',
      selectedNodeId: null,
    });

    seedNode(PROVISIONED_NODE_ID, 'running');
    state.stepResults.nodeId = PROVISIONED_NODE_ID;
    state.stepResults.autoProvisioned = true;
    state.provisioningStartedAt = Date.now();
    await recordProvisioningAttempt(
      state,
      rc,
      { vmSize: 'medium', vmLocation: 'hel1', outcome: 'started' },
      PROVISIONED_NODE_ID
    );
    await handleNodeProvisioning(state, rc);
    await handleNodeAgentReady(state, rc);
    await handleWorkspaceCreation(state, rc);

    expect(parsePlacement('tasks')).toMatchObject({
      schemaVersion: 2,
      outcome: 'provisioned',
      selectionPath: 'provisioning',
      selectedNodeId: PROVISIONED_NODE_ID,
      provisioningAttempts: [{ outcome: 'started' }, { outcome: 'succeeded' }],
    });
    expect(parsePlacement('workspaces')).toEqual(parsePlacement('tasks'));
    expect(advances).toEqual([
      'node_provisioning',
      'node_agent_ready',
      'workspace_creation',
      'workspace_dispatch',
    ]);
  });

  it('persists a typed terminal provisioning failure without creating a workspace', async () => {
    const env = createDatabase();
    seedTask();
    const state = createState();
    const advances: string[] = [];
    const rc = createContext(env, advances, 1_000);

    await handleNodeSelection(state, rc);
    seedNode(PROVISIONED_NODE_ID, 'creating');
    state.stepResults.nodeId = PROVISIONED_NODE_ID;
    state.stepResults.autoProvisioned = true;
    state.provisioningStartedAt = Date.now() - 2_000;
    await recordProvisioningAttempt(
      state,
      rc,
      { vmSize: 'medium', vmLocation: 'hel1', outcome: 'started' },
      PROVISIONED_NODE_ID
    );

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({ permanent: true });

    expect(parsePlacement('tasks')).toMatchObject({
      schemaVersion: 2,
      outcome: 'failed',
      selectedNodeId: PROVISIONED_NODE_ID,
      provisioningAttempts: [
        { outcome: 'started' },
        { outcome: 'failed', failureReason: 'provisioning-timeout' },
      ],
    });
    expect(sqlite?.prepare(`SELECT COUNT(*) AS count FROM workspaces`).get()).toEqual({ count: 0 });
    expect(advances).toEqual(['node_provisioning']);
  });
});
