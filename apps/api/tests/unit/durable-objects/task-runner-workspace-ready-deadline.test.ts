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

function context(options: { betweenReadAndDecision?: () => void } = {}) {
  const setAlarm = vi.fn(async () => undefined);
  const advanceToStep = vi.fn(async () => undefined);
  const assertRecoveryAuthority = vi.fn(async () => undefined);
  const rc = {
    env,
    ctx: { storage: { put: vi.fn(), setAlarm } },
    // Runs after the step's row read and before its timeout decision: the midpoint where a
    // concurrent callback can land.
    updateD1ExecutionStep: vi.fn(async () => options.betweenReadAndDecision?.()),
    advanceToStep,
    assertRecoveryAuthority,
    getWorkspaceReadyTimeoutMs: () => BUILD_BUDGET_MS,
    getWorkspaceReadyPollIntervalMs: () => 5_000,
  } as unknown as TaskRunnerContext;
  return { rc, setAlarm, advanceToStep, assertRecoveryAuthority };
}

function workspaceRow(): { status: string; error_message: string | null } {
  return sqlite.prepare("SELECT status, error_message FROM workspaces WHERE id = 'ws-1'").get() as {
    status: string;
    error_message: string | null;
  };
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
    const message = `Workspace build did not start within ${60 * MINUTE}ms (waiting for the node's build slot)`;

    await expect(handleWorkspaceReady(freshState(), rc)).rejects.toMatchObject({
      message,
      permanent: true,
    });
    // The step won the shared expiry claim, so the workspace is errored with the same reason.
    expect(workspaceRow()).toEqual({ status: 'error', error_message: message });
  });

  it('does not fail when the build starts after the step read the expired row', async () => {
    seedWorkspace({ createdAt: ago(61), creatingStartedAt: ago(61) });
    const { rc, setAlarm } = context({
      betweenReadAndDecision: () => {
        sqlite
          .prepare("UPDATE workspaces SET build_started_at = ? WHERE id = 'ws-1'")
          .run(new Date().toISOString());
      },
    });

    await expect(handleWorkspaceReady(freshState(), rc)).resolves.toBeUndefined();

    expect(workspaceRow()).toEqual({ status: 'creating', error_message: null });
    // Lost the claim: re-poll at once, and the next poll reads the started build.
    expect(setAlarm).toHaveBeenCalledOnce();
  });

  it('does not fail when the workspace became ready after the step read the expired row', async () => {
    seedWorkspace({ createdAt: ago(61), creatingStartedAt: ago(61) });
    const first = context({
      betweenReadAndDecision: () => {
        sqlite.prepare("UPDATE workspaces SET status = 'running' WHERE id = 'ws-1'").run();
      },
    });

    await expect(handleWorkspaceReady(freshState(), first.rc)).resolves.toBeUndefined();
    expect(workspaceRow().status).toBe('running');

    // The re-poll advances the task.
    const second = context();
    await handleWorkspaceReady(freshState(), second.rc);
    expect(second.advanceToStep).toHaveBeenCalledWith(expect.anything(), 'agent_session');
  });

  it.each(['stopped', 'stopping', 'deleted'])(
    'exits on a %s workspace instead of re-polling it forever',
    async (status) => {
      seedWorkspace({ createdAt: ago(61), creatingStartedAt: ago(61) });
      sqlite.prepare('UPDATE workspaces SET status = ? WHERE id = ?').run(status, 'ws-1');
      const { rc, setAlarm } = context();

      await expect(handleWorkspaceReady(freshState(), rc)).rejects.toMatchObject({
        message: `Workspace became ${status} before it was ready`,
        permanent: true,
      });
      expect(setAlarm).not.toHaveBeenCalled();
      // The step does not touch a row it does not own the transition of.
      expect(workspaceRow().status).toBe(status);
    }
  );

  it('re-polls once after a lost claim, then exits when the row was stopped meanwhile', async () => {
    seedWorkspace({ createdAt: ago(61), creatingStartedAt: ago(61) });
    const first = context({
      betweenReadAndDecision: () => {
        sqlite.prepare("UPDATE workspaces SET status = 'stopped' WHERE id = 'ws-1'").run();
      },
    });
    await expect(handleWorkspaceReady(freshState(), first.rc)).resolves.toBeUndefined();
    expect(first.setAlarm).toHaveBeenCalledOnce();

    const second = context();
    await expect(handleWorkspaceReady(freshState(), second.rc)).rejects.toMatchObject({
      message: 'Workspace became stopped before it was ready',
      permanent: true,
    });
    expect(second.setAlarm).not.toHaveBeenCalled();
  });

  it('does not expire the workspace when recovery authority was revoked', async () => {
    seedWorkspace({ createdAt: ago(61), creatingStartedAt: ago(61) });
    const { rc, assertRecoveryAuthority } = context();
    assertRecoveryAuthority.mockRejectedValueOnce(new Error('recovery authority revoked'));

    await expect(handleWorkspaceReady(freshState(), rc)).rejects.toThrow(
      'recovery authority revoked'
    );
    expect(workspaceRow()).toEqual({ status: 'creating', error_message: null });
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
