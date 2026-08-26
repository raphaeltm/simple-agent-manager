import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { wakeSessionForSnapshotRecovery } from '../../../src/services/project-data';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const PROJECT_ID = 'project-snapshot-wake';
const USER_ID = 'user-snapshot-wake';
const WORKSPACE_ID = 'workspace-snapshot-wake';
const CHAT_SESSION_ID = 'chat-snapshot-wake';
const TASK_ID = 'task-snapshot-wake';
const NOW = new Date('2026-08-26T21:10:00.000Z');

let sqlite: Database.Database;
let wakeSessionRpc: ReturnType<typeof vi.fn>;
let env: Env;

function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

function seedWorkspace(id = WORKSPACE_ID): void {
  sqlite
    .prepare(
      `INSERT INTO workspaces
        (id, project_id, user_id, name, repository, branch, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'org/repo', 'main', 'running', ?, ?)`
    )
    .run(id, PROJECT_ID, USER_ID, `workspace-${id}`, iso(-60 * 60 * 1000), iso(-5 * 60 * 1000));
}

function seedRecoveryTask(
  overrides: { status?: string; triggeredBy?: string; workspaceId?: string } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO tasks
        (id, project_id, user_id, workspace_id, chat_session_id, recovery_source_task_id, title, status,
         priority, triggered_by, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'source-task', 'wake task', ?, 0, ?, ?, ?, ?)`
    )
    .run(
      TASK_ID,
      PROJECT_ID,
      USER_ID,
      overrides.workspaceId ?? WORKSPACE_ID,
      CHAT_SESSION_ID,
      overrides.status ?? 'in_progress',
      overrides.triggeredBy ?? 'session-recovery',
      USER_ID,
      iso(-60 * 60 * 1000),
      iso(-5 * 60 * 1000)
    );
}

function seedSnapshot(
  overrides: {
    expiresAt?: string;
    recoveryTaskId?: string;
    recoveryWorkspaceId?: string;
    recoveryStatus?: string | null;
    sleepStatus?: string | null;
    sleepingAt?: string | null;
  } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO session_snapshots
        (id, project_id, workspace_id, user_id, chat_session_id, runtime, status, degradation,
         manifest_r2_key, expires_at, sleeping_at, sleep_status, recovery_status,
         recovery_task_id, recovery_workspace_id, recovery_attempts, sleep_attempts, created_at, updated_at)
       VALUES ('snapshot-snapshot-wake', ?, ?, ?, ?, 'vm', 'available', 'none', ?, ?, ?, ?, ?,
               ?, ?, 3, 0, ?, ?)`
    )
    .run(
      PROJECT_ID,
      WORKSPACE_ID,
      USER_ID,
      CHAT_SESSION_ID,
      `snapshots/${CHAT_SESSION_ID}/manifest.json`,
      overrides.expiresAt ?? iso(7 * 24 * 60 * 60 * 1000),
      overrides.sleepingAt === undefined ? iso(-5 * 60 * 1000) : overrides.sleepingAt,
      overrides.sleepStatus === undefined ? 'sleeping' : overrides.sleepStatus,
      overrides.recoveryStatus === undefined ? 'waking' : overrides.recoveryStatus,
      overrides.recoveryTaskId ?? TASK_ID,
      overrides.recoveryWorkspaceId ?? WORKSPACE_ID,
      iso(-60 * 60 * 1000),
      iso(-5 * 60 * 1000)
    );
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.sessionSnapshots, schema.tasks, schema.workspaces]);
  wakeSessionRpc = vi.fn(
    async (
      _sessionId: string,
      _workspaceId: string,
      _taskId: string,
      options?: { allowStopped?: boolean }
    ) => Boolean(options?.allowStopped)
  );
  const stub = {
    ensureProjectId: vi.fn(async () => {}),
    wakeSession: wakeSessionRpc,
  };
  env = {
    DATABASE: createSqliteD1(sqlite),
    PROJECT_DATA: {
      idFromName: (projectId: string) => projectId,
      get: () => stub,
    },
  } as unknown as Env;
});

describe('wakeSessionForSnapshotRecovery', () => {
  it('allows a stopped ProjectData session to wake only with an authorized restorable claim', async () => {
    seedWorkspace();
    seedRecoveryTask();
    seedSnapshot();

    await expect(
      wakeSessionForSnapshotRecovery(env, PROJECT_ID, CHAT_SESSION_ID, WORKSPACE_ID, TASK_ID)
    ).resolves.toBe(true);

    expect(wakeSessionRpc).toHaveBeenCalledWith(CHAT_SESSION_ID, WORKSPACE_ID, TASK_ID, {
      allowStopped: true,
    });
  });

  it('does not allow stopped-session wake when the snapshot row was deleted for archive', async () => {
    seedWorkspace();
    seedRecoveryTask();

    await expect(
      wakeSessionForSnapshotRecovery(env, PROJECT_ID, CHAT_SESSION_ID, WORKSPACE_ID, TASK_ID)
    ).resolves.toBe(false);

    expect(wakeSessionRpc).not.toHaveBeenCalled();
  });

  it('does not allow stopped-session wake when the recovery snapshot has expired', async () => {
    seedWorkspace();
    seedRecoveryTask();
    seedSnapshot({ expiresAt: iso(-1_000) });

    await expect(
      wakeSessionForSnapshotRecovery(env, PROJECT_ID, CHAT_SESSION_ID, WORKSPACE_ID, TASK_ID)
    ).resolves.toBe(false);

    expect(wakeSessionRpc).not.toHaveBeenCalled();
  });

  it('does not allow stopped-session wake from a terminal recovery task', async () => {
    seedWorkspace();
    seedRecoveryTask({ status: 'failed' });
    seedSnapshot();

    await expect(
      wakeSessionForSnapshotRecovery(env, PROJECT_ID, CHAT_SESSION_ID, WORKSPACE_ID, TASK_ID)
    ).resolves.toBe(false);

    expect(wakeSessionRpc).not.toHaveBeenCalled();
  });

  it('does not allow stopped-session wake from a non-recovery task claim', async () => {
    seedWorkspace();
    seedRecoveryTask({ triggeredBy: 'manual' });
    seedSnapshot();

    await expect(
      wakeSessionForSnapshotRecovery(env, PROJECT_ID, CHAT_SESSION_ID, WORKSPACE_ID, TASK_ID)
    ).resolves.toBe(false);

    expect(wakeSessionRpc).not.toHaveBeenCalled();
  });

  it('does not allow stopped-session wake when the snapshot is not in a recovery state', async () => {
    seedWorkspace();
    seedRecoveryTask();
    seedSnapshot({ recoveryStatus: null });

    await expect(
      wakeSessionForSnapshotRecovery(env, PROJECT_ID, CHAT_SESSION_ID, WORKSPACE_ID, TASK_ID)
    ).resolves.toBe(false);

    expect(wakeSessionRpc).not.toHaveBeenCalled();
  });

  it('does not allow stopped-session wake for a replacement workspace outside the recovery claim', async () => {
    seedWorkspace();
    seedWorkspace('workspace-snapshot-wake-other');
    seedRecoveryTask();
    seedSnapshot();

    await expect(
      wakeSessionForSnapshotRecovery(
        env,
        PROJECT_ID,
        CHAT_SESSION_ID,
        'workspace-snapshot-wake-other',
        TASK_ID
      )
    ).resolves.toBe(false);

    expect(wakeSessionRpc).not.toHaveBeenCalled();
  });
});
