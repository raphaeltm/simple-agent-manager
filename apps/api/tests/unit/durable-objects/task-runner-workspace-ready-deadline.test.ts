/**
 * The TaskRunner's workspace_ready deadline on a real SQLite row (`workspace-creating-deadline.ts`).
 *
 * The step reads the durable attempt clock on every poll. It keeps no clock of its own, so a lost
 * build-started notification, a DO restart or a duplicate callback cannot reset or lose the
 * deadline. Before this, the step timed out 30 minutes after it was first entered, so a workspace
 * queued behind the node's single build slot failed its task before its build ever started.
 */
import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';
import { handleWorkspaceReady } from '../../../src/durable-objects/task-runner/workspace-ready-steps';
import type { Env } from '../../../src/env';
import {
  __resetAdminSettingsCacheForTest,
  updateAdminSettings,
} from '../../../src/services/admin-settings';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../../helpers/sqlite-d1';

const MINUTE = 60_000;
const BUILD_BUDGET_MS = 30 * MINUTE;

let sqlite: Database.Database;
let env: Env;

beforeEach(() => {
  __resetAdminSettingsCacheForTest();
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  sqlite.exec(
    readFileSync(
      new URL('../../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
      'utf8'
    )
  );
  env = { DATABASE: createSqliteD1(sqlite), KV: createMemoryKv() } as unknown as Env;
});

afterEach(() => {
  sqlite.close();
  __resetAdminSettingsCacheForTest();
});

const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE).toISOString();

function seedWorkspace(clock: {
  createdAt: string;
  creatingStartedAt?: string | null;
  buildStartedAt?: string | null;
}): void {
  sqlite
    .prepare(
      `INSERT INTO workspaces
       (id, node_id, user_id, project_id, name, repository, branch, status, vm_size, vm_location,
        dispatched_at, created_at, updated_at, creating_started_at, build_started_at)
       VALUES ('ws-1', 'node-1', 'user-1', 'project-1', 'ws', 'acme/repo', 'main', 'creating',
        'small', 'fsn1', ?, ?, ?, ?, ?)`
    )
    .run(
      clock.createdAt,
      clock.createdAt,
      clock.createdAt,
      clock.creatingStartedAt ?? null,
      clock.buildStartedAt ?? null
    );
}

/** A runner as a fresh DO instance sees it: no in-memory record of when anything started. */
function freshState(): TaskRunnerState {
  return {
    taskId: 'task-1',
    projectId: 'project-1',
    userId: 'user-1',
    completed: false,
    currentStep: 'workspace_ready',
    stepResults: { workspaceId: 'ws-1', nodeId: 'node-1' },
    retryCount: 0,
    workspaceReadyReceived: false,
    config: { attachments: [] },
  } as unknown as TaskRunnerState;
}

function context() {
  const setAlarm = vi.fn(async () => undefined);
  const advanceToStep = vi.fn(async () => undefined);
  const rc = {
    env,
    ctx: { storage: { put: vi.fn(), setAlarm } },
    updateD1ExecutionStep: vi.fn(async () => undefined),
    advanceToStep,
    getWorkspaceReadyTimeoutMs: () => BUILD_BUDGET_MS,
    getWorkspaceReadyPollIntervalMs: () => 5_000,
  } as unknown as TaskRunnerContext;
  return { rc, setAlarm, advanceToStep };
}

describe('workspace_ready deadline', () => {
  it('keeps waiting for a workspace queued 45 minutes behind the build slot', async () => {
    seedWorkspace({ createdAt: ago(45), creatingStartedAt: ago(45) });
    const { rc, setAlarm } = context();

    await expect(handleWorkspaceReady(freshState(), rc)).resolves.toBeUndefined();

    expect(setAlarm).toHaveBeenCalledOnce();
  });

  it('fails a workspace whose build has not started within the queue budget', async () => {
    seedWorkspace({ createdAt: ago(61), creatingStartedAt: ago(61) });
    const { rc } = context();

    await expect(handleWorkspaceReady(freshState(), rc)).rejects.toMatchObject({
      message: `Workspace build did not start within ${60 * MINUTE}ms (waiting for the node's build slot)`,
      permanent: true,
    });
  });

  it('uses the durable build start after a missed notification or a restarted DO', async () => {
    // Queued 55 minutes, then the build started 20 minutes ago. The DO never heard about it.
    seedWorkspace({ createdAt: ago(75), creatingStartedAt: ago(75), buildStartedAt: ago(20) });
    const { rc, setAlarm } = context();

    await expect(handleWorkspaceReady(freshState(), rc)).resolves.toBeUndefined();
    // The next poll is no later than the build deadline.
    const [[alarmAt]] = setAlarm.mock.calls as unknown as [[number]];
    expect(alarmAt).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it('fails a build that is genuinely stuck after it started', async () => {
    seedWorkspace({ createdAt: ago(40), creatingStartedAt: ago(40), buildStartedAt: ago(31) });
    const { rc } = context();

    await expect(handleWorkspaceReady(freshState(), rc)).rejects.toMatchObject({
      message: `Workspace did not become ready within ${BUILD_BUDGET_MS}ms of its build starting`,
      permanent: true,
    });
  });

  it('falls back to created_at for a workspace from before the attempt clock', async () => {
    seedWorkspace({ createdAt: ago(45) });
    const { rc } = context();
    await expect(handleWorkspaceReady(freshState(), rc)).resolves.toBeUndefined();
  });

  it('applies a non-default queue budget through the admin setting', async () => {
    await updateAdminSettings(env, {
      actorUserId: 'admin-1',
      changes: [{ name: 'operations.workspaceBuildQueueTimeoutMinutes', value: 90 }],
    });
    seedWorkspace({ createdAt: ago(75), creatingStartedAt: ago(75) });
    const { rc } = context();
    await expect(handleWorkspaceReady(freshState(), rc)).resolves.toBeUndefined();
  });

  it('advances when D1 already shows the workspace running', async () => {
    seedWorkspace({ createdAt: ago(90), creatingStartedAt: ago(90) });
    sqlite.prepare("UPDATE workspaces SET status = 'running' WHERE id = 'ws-1'").run();
    const { rc, advanceToStep } = context();

    await handleWorkspaceReady(freshState(), rc);

    expect(advanceToStep).toHaveBeenCalledWith(expect.anything(), 'agent_session');
  });

  it('fails permanently when the workspace row is gone', async () => {
    const { rc } = context();
    await expect(handleWorkspaceReady(freshState(), rc)).rejects.toMatchObject({
      message: 'Workspace ws-1 no longer exists',
      permanent: true,
    });
  });
});
