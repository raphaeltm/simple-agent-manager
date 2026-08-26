import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { recoverStuckTasks } from '../../src/scheduled/stuck-tasks';
import { createMemoryKv, createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  stopWorkspaceOnNode: vi.fn(),
  markIdle: vi.fn(),
  scheduleWorkspaceDeletion: vi.fn(),
  persistError: vi.fn(),
  stopStatuses: [] as (string | null)[],
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/services/node-agent', () => ({
  stopWorkspaceOnNode: (...args: unknown[]) => mocks.stopWorkspaceOnNode(...args),
}));

vi.mock('../../src/services/node-lifecycle', () => ({
  markIdle: (...args: unknown[]) => mocks.markIdle(...args),
}));

vi.mock('../../src/services/project-data', () => ({
  cleanupWorkspaceActivity: vi.fn().mockResolvedValue(undefined),
  failSession: vi.fn().mockResolvedValue(undefined),
  getMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
  listAcpSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
  listSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
  reconcileTaskWaits: vi.fn().mockResolvedValue(undefined),
  stopSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/observability', () => ({
  persistError: (...args: unknown[]) => mocks.persistError(...args),
}));

vi.mock('../../src/lib/logger', () => ({
  log: mocks.log,
  createModuleLogger: () => mocks.log,
}));

const PROJECT_ID = 'project-cleanup-order';
const USER_ID = 'user-cleanup-order';
const NODE_ID = 'node-cleanup-order';
const REASSIGNED_NODE_ID = 'node-cleanup-order-reassigned';
const WORKSPACE_ID = 'workspace-cleanup-order';
const TASK_ID = 'task-cleanup-order';

let sqlite: Database.Database;
let env: Env;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function seedRunningVmTask(): void {
  sqlite
    .prepare(
      `INSERT INTO nodes (id, user_id, name, status, health_status, last_heartbeat_at,
                          vm_size, vm_location, cloud_provider, runtime, created_at, updated_at)
       VALUES (?, ?, 'cleanup-node', 'running', 'healthy', ?, 'cpx21', 'nbg1',
               'hetzner', 'vm', ?, ?)`
    )
    .run(NODE_ID, USER_ID, iso(0), iso(-30 * 60 * 1000), iso(0));

  sqlite
    .prepare(
      `INSERT INTO workspaces (id, user_id, name, repository, branch, status, vm_size,
                               vm_location, project_id, chat_session_id, node_id,
                               created_at, updated_at)
       VALUES (?, ?, 'cleanup-ws', 'org/repo', 'main', 'running', 'cpx21', 'nbg1',
               ?, NULL, ?, ?, ?)`
    )
    .run(WORKSPACE_ID, USER_ID, PROJECT_ID, NODE_ID, iso(-30 * 60 * 1000), iso(0));

  sqlite
    .prepare(
      `INSERT INTO tasks (id, project_id, user_id, workspace_id, auto_provisioned_node_id,
                          title, status, priority, execution_step, started_at, created_by,
                          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'cleanup task', 'in_progress', 0, 'running',
               ?, ?, ?, ?)`
    )
    .run(
      TASK_ID,
      PROJECT_ID,
      USER_ID,
      WORKSPACE_ID,
      NODE_ID,
      iso(-10 * 60 * 1000),
      USER_ID,
      iso(-10 * 60 * 1000),
      iso(-10 * 60 * 1000)
    );
}

function seedReplacementNode(): void {
  sqlite
    .prepare(
      `INSERT INTO nodes (id, user_id, name, status, health_status, last_heartbeat_at,
                          vm_size, vm_location, cloud_provider, runtime, created_at, updated_at)
       VALUES (?, ?, 'cleanup-node-reassigned', 'running', 'healthy', ?, 'cpx21', 'nbg1',
               'hetzner', 'vm', ?, ?)`
    )
    .run(REASSIGNED_NODE_ID, USER_ID, iso(0), iso(-30 * 60 * 1000), iso(0));
}

function workspaceStatus(): string {
  return sqlite
    .prepare(`SELECT status FROM workspaces WHERE id = ?`)
    .pluck()
    .get(WORKSPACE_ID) as string;
}

function workspaceNode(): string | null {
  return sqlite.prepare(`SELECT node_id FROM workspaces WHERE id = ?`).pluck().get(WORKSPACE_ID) as
    | string
    | null;
}

function taskStatus(): string {
  return sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).pluck().get(TASK_ID) as string;
}

function taskStatusEventCount(): number {
  return sqlite
    .prepare(`SELECT COUNT(*) FROM task_status_events WHERE task_id = ?`)
    .pluck()
    .get(TASK_ID) as number;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stopStatuses = [];
  mocks.markIdle.mockResolvedValue(undefined);
  mocks.scheduleWorkspaceDeletion.mockResolvedValue(undefined);
  mocks.persistError.mockResolvedValue(undefined);

  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.nodes,
    schema.workspaces,
    schema.tasks,
    schema.taskStatusEvents,
    schema.triggerExecutions,
    schema.agentSessions,
    schema.computeUsage,
    schema.vmTaskAdmissions,
    schema.vmProvisioningLeases,
  ]);

  const d1 = createSqliteD1(sqlite);
  env = {
    DATABASE: d1,
    OBSERVABILITY_DATABASE: d1,
    KV: createMemoryKv(),
    TASK_RUNNER: {
      idFromName: vi.fn().mockReturnValue({ toString: () => 'task-runner-id' }),
      get: vi.fn().mockReturnValue({
        getStatus: vi.fn().mockRejectedValue(new Error('TaskRunner not awake')),
      }),
    },
    NODE_LIFECYCLE: {
      idFromName: vi.fn().mockReturnValue({ toString: () => 'node-lifecycle-id' }),
      get: vi.fn().mockReturnValue({
        scheduleWorkspaceDeletion: mocks.scheduleWorkspaceDeletion,
      }),
    },
    BASE_DOMAIN: 'example.test',
    TASK_RUN_CLEANUP_DELAY_MS: '0',
    TASK_RUN_MAX_EXECUTION_MS: '60000',
    TASK_RUN_HARD_TIMEOUT_MS: '120000',
    TASK_RUN_ABSOLUTE_CEILING_MS: '180000',
    TASK_STUCK_QUEUED_TIMEOUT_MS: '600000',
    TASK_STUCK_DELEGATED_TIMEOUT_MS: '1800000',
    NODE_HEARTBEAT_STALE_SECONDS: '180',
  } as unknown as Env;

  mocks.stopWorkspaceOnNode.mockImplementation(
    async (_nodeId: string, workspaceId: string, stopEnv: Env) => {
      const row = await stopEnv.DATABASE.prepare(`SELECT status FROM workspaces WHERE id = ?`)
        .bind(workspaceId)
        .first<{ status: string }>();
      mocks.stopStatuses.push(row?.status ?? null);
    }
  );
});

describe('scheduled stuck-task terminal cleanup', () => {
  it('lets cleanupTaskRun stop a running VM workspace before D1 is marked stopped', async () => {
    seedRunningVmTask();

    const result = await recoverStuckTasks(env);

    expect(result.failedInProgress).toBe(1);
    expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledWith(NODE_ID, WORKSPACE_ID, env, USER_ID);
    expect(mocks.stopStatuses).toEqual(['running']);
    expect(workspaceStatus()).toBe('stopped');
    expect(mocks.scheduleWorkspaceDeletion).toHaveBeenCalledWith(NODE_ID, WORKSPACE_ID, USER_ID);
  });

  it('skips terminalization and cleanup when stale evidence races with workspace node reassignment', async () => {
    seedRunningVmTask();
    seedReplacementNode();
    mocks.persistError.mockImplementationOnce(async () => {
      sqlite
        .prepare(`UPDATE workspaces SET node_id = ?, updated_at = ? WHERE id = ?`)
        .run(REASSIGNED_NODE_ID, iso(0), WORKSPACE_ID);
    });

    const result = await recoverStuckTasks(env);

    expect(result.failedInProgress).toBe(0);
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    expect(mocks.scheduleWorkspaceDeletion).not.toHaveBeenCalled();
    expect(taskStatus()).toBe('in_progress');
    expect(taskStatusEventCount()).toBe(0);
    expect(workspaceStatus()).toBe('running');
    expect(workspaceNode()).toBe(REASSIGNED_NODE_ID);
  });
});
