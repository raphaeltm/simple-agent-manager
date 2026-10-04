import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import {
  DIRECT_PROVISIONING_KEY,
  type DirectProvisioningIntent,
  NodeLifecycleProvisioning,
} from '../../src/durable-objects/node-lifecycle-provisioning';
import { failTask } from '../../src/durable-objects/task-runner/state-machine';
import type { Env } from '../../src/env';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

vi.mock('../../src/services/observability', () => ({
  persistError: vi.fn(async () => undefined),
  redactSensitiveData: vi.fn((value: unknown) => value),
}));
vi.mock('../../src/services/node-provisioning', () => ({
  provisionNode: vi.fn(),
}));
vi.mock('../../src/services/direct-workspace-creation', () => ({
  assertDirectCreationAuthority: vi.fn(),
  continueDirectWorkspaceCreation: vi.fn(),
}));
vi.mock('../../src/scheduled/failed-sweep-notifications', () => ({
  notifyFailedSweeps: vi.fn(async () => undefined),
}));
vi.mock('../../src/services/task-terminal-transition-hooks', () => ({
  createProjectEventTaskTerminalTransitionHook: vi.fn(() => vi.fn()),
  createTaskWaitTerminalTransitionHook: vi.fn(() => vi.fn()),
  runTaskTerminalTransitionHooks: vi.fn(async () => undefined),
}));
vi.mock('../../src/services/trigger-execution-sync', () => ({
  syncTriggerExecutionStatus: vi.fn(async () => undefined),
}));
vi.mock('../../src/services/vm-admission-control', () => ({
  cancelVmTaskAdmission: vi.fn(async () => undefined),
  wakeVmAdmissionWaiters: vi.fn(async () => undefined),
}));
vi.mock('../../src/services/project-lifecycle-events', () => ({
  recordTaskLifecycleEventBestEffort: vi.fn(async () => undefined),
}));
vi.mock('../../src/durable-objects/task-runner/workspace-reserved-allocation', () => ({
  recoverReservedWorkspaceAllocationForCleanup: vi.fn(async () => undefined),
}));

describe('task failure entry points use terminal-safe SQL', () => {
  let sqlite: Database.Database;

  afterEach(() => sqlite.close());

  function taskRunnerContext(status: string) {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.tasks, schema.taskStatusEvents, schema.sessionSnapshots]);
    sqlite.prepare('INSERT INTO tasks (id, status) VALUES (?, ?)').run('task-1', status);
    const storage = { put: vi.fn(async () => undefined) };
    const rc = {
      env: { DATABASE: createSqliteD1(sqlite) } as Env,
      ctx: { storage, waitUntil: vi.fn() },
    } as never;
    const state = {
      taskId: 'task-1',
      projectId: 'project-1',
      userId: 'user-1',
      currentStep: 'agent_session',
      createdAt: Date.now(),
      retryCount: 0,
      completed: false,
      admissionScopeKey: null,
      admissionLeaseToken: null,
      config: {},
      stepResults: {},
    } as never;
    return { rc, state };
  }

  it.each(['completed', 'cancelled'])('TaskRunner does not overwrite %s', async (status) => {
    const { rc, state } = taskRunnerContext(status);
    await failTask(state, 'late runner failure', rc);
    expect(sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get('task-1')).toEqual({
      status,
    });
  });

  it('TaskRunner still fails an in-progress task', async () => {
    const { rc, state } = taskRunnerContext('in_progress');
    await failTask(state, 'owner failure', rc);
    expect(
      sqlite.prepare('SELECT status, error_message FROM tasks WHERE id = ?').get('task-1')
    ).toEqual({ status: 'failed', error_message: 'owner failure' });
  });

  async function runNodeProvisioningFailure(status: string): Promise<string> {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.tasks,
      schema.workspaces,
      schema.nodes,
      schema.computeUsage,
    ]);
    sqlite
      .prepare(
        `INSERT INTO nodes (id, user_id, status, runtime_incarnation_id)
         VALUES ('node-1', 'user-1', 'provisioning', 'incarnation-1')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, user_id, project_id, node_id, status)
         VALUES ('workspace-1', 'user-1', 'project-1', 'node-1', 'creating')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO tasks (id, user_id, workspace_id, status)
         VALUES ('task-1', 'user-1', 'workspace-1', ?)`
      )
      .run(status);

    const intent = {
      input: {
        nodeId: 'node-1',
        userId: 'user-1',
        workspace: {
          placement: {
            id: 'workspace-1',
            userId: 'user-1',
            projectId: 'project-1',
            nodeId: 'node-1',
          },
          taskId: 'task-1',
          chatSessionId: null,
          mustProvisionNode: false,
        },
      },
      initialIncarnationId: 'incarnation-1',
      incarnationId: 'incarnation-1',
      createdAt: 0,
      nextAttemptAt: 0,
      attempts: 30,
      status: 'reporting',
      reportAttempts: 1,
      lastError: 'provider unavailable',
    } as DirectProvisioningIntent;
    const stored = new Map<string, unknown>([[DIRECT_PROVISIONING_KEY, intent]]);
    const pending: Promise<unknown>[] = [];
    const ctx = {
      storage: {
        get: vi.fn(async (key: string) => stored.get(key)),
        put: vi.fn(async (key: string, value: unknown) => stored.set(key, value)),
        setAlarm: vi.fn(async () => undefined),
        deleteAlarm: vi.fn(async () => undefined),
      },
      waitUntil: vi.fn((promise: Promise<unknown>) => pending.push(promise)),
    } as never;
    const env = {
      DATABASE: createSqliteD1(sqlite),
      NODE_PROVISIONING_RETRY_INTERVAL_MS: '1',
      NODE_PROVISIONING_MAX_ATTEMPTS: '30',
    } as unknown as Env;

    await new NodeLifecycleProvisioning(ctx, env).alarm();
    await Promise.all(pending);
    return (
      sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get('task-1') as { status: string }
    ).status;
  }

  it.each(['completed', 'cancelled'])('node provisioning does not overwrite %s', async (status) => {
    expect(await runNodeProvisioningFailure(status)).toBe(status);
  });

  it('node provisioning still fails an in-progress task', async () => {
    expect(await runNodeProvisioningFailure('in_progress')).toBe('failed');
  });
});
