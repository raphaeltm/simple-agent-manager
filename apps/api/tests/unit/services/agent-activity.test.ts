import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { listAgentActivityTasks } from '../../../src/services/agent-activity';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

function createActivityDb() {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.users,
    schema.projects,
    schema.workspaces,
    schema.tasks,
    schema.sessionSnapshots,
  ]);
  const env = {
    DATABASE: createSqliteD1(sqlite),
    SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS: '3',
  } as unknown as Env;
  seedProject(sqlite, 'project-1', 'user-1', 'Project One');
  seedProject(sqlite, 'project-2', 'user-1', 'Project Two');
  return { sqlite, env };
}

function seedProject(sqlite: Database.Database, id: string, userId: string, name: string): void {
  sqlite
    .prepare(
      `INSERT INTO projects
         (id, user_id, name, normalized_name, installation_id, repository,
          default_branch, repo_provider, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'main', 'github', 'active', ?, ?, ?)`
    )
    .run(
      id,
      userId,
      name,
      name.toLowerCase().replaceAll(' ', '-'),
      `install-${id}`,
      `owner/${id}`,
      userId,
      '2026-08-30T00:00:00.000Z',
      '2026-08-30T00:00:00.000Z'
    );
}

function seedWorkspace(
  sqlite: Database.Database,
  id: string,
  projectId: string,
  status: string
): void {
  sqlite
    .prepare(
      `INSERT INTO workspaces
         (id, project_id, user_id, name, repository, branch, status, vm_size,
          vm_location, created_at, updated_at)
       VALUES (?, ?, 'user-1', ?, 'owner/repo', 'main', ?, 'small', 'nbg1', ?, ?)`
    )
    .run(id, projectId, id, status, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
}

function seedTask(
  sqlite: Database.Database,
  overrides: {
    id: string;
    projectId?: string;
    userId?: string;
    workspaceId?: string | null;
    chatSessionId?: string | null;
    status?: string;
    executionStep?: string | null;
    supersededByTaskId?: string | null;
    createdAt?: string;
  }
): void {
  sqlite
    .prepare(
      `INSERT INTO tasks
         (id, project_id, user_id, chat_session_id, workspace_id,
          superseded_by_task_id, title, status, execution_step, priority,
          created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    )
    .run(
      overrides.id,
      overrides.projectId ?? 'project-1',
      overrides.userId ?? 'user-1',
      overrides.chatSessionId ?? null,
      overrides.workspaceId ?? null,
      overrides.supersededByTaskId ?? null,
      `Task ${overrides.id}`,
      overrides.status ?? 'in_progress',
      overrides.executionStep ?? 'running',
      overrides.userId ?? 'user-1',
      overrides.createdAt ?? '2026-08-30T00:00:00.000Z',
      overrides.createdAt ?? '2026-08-30T00:00:00.000Z'
    );
}

function seedSleepingSnapshot(
  sqlite: Database.Database,
  overrides: {
    id: string;
    projectId?: string;
    workspaceId?: string;
    chatSessionId?: string;
    status?: string;
    degradation?: string;
    sleepStatus?: string | null;
    sleepingAt?: string | null;
    recoveryAttempts?: number;
    expiresAt?: string;
  }
): void {
  sqlite
    .prepare(
      `INSERT INTO session_snapshots
         (id, project_id, workspace_id, user_id, chat_session_id, runtime, status,
          degradation, manifest_r2_key, expires_at, sleep_status, sleeping_at,
          recovery_attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'user-1', ?, 'vm', ?, ?, 'manifest.json', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      overrides.id,
      overrides.projectId ?? 'project-1',
      overrides.workspaceId ?? 'ws-sleep',
      overrides.chatSessionId ?? 'chat-sleep',
      overrides.status ?? 'available',
      overrides.degradation ?? 'none',
      overrides.expiresAt ?? '2099-08-30T00:00:00.000Z',
      overrides.sleepStatus ?? 'sleeping',
      overrides.sleepingAt ?? '2026-08-30T00:00:00.000Z',
      overrides.recoveryAttempts ?? 0,
      '2026-08-30T00:00:00.000Z',
      '2026-08-30T00:00:00.000Z'
    );
}

describe('agent activity derivation', () => {
  it('returns active non-superseded tasks with working, awake-idle, and sleeping states', async () => {
    const { sqlite, env } = createActivityDb();
    try {
      seedWorkspace(sqlite, 'ws-working', 'project-1', 'running');
      seedWorkspace(sqlite, 'ws-sleep', 'project-1', 'deleted');
      seedTask(sqlite, {
        id: 'task-working',
        workspaceId: 'ws-working',
        chatSessionId: 'chat-working',
        executionStep: 'running',
      });
      seedTask(sqlite, {
        id: 'task-sleeping',
        workspaceId: 'ws-sleep',
        chatSessionId: 'chat-sleep',
        executionStep: 'awaiting_followup',
      });
      seedTask(sqlite, {
        id: 'task-idle',
        workspaceId: null,
        chatSessionId: 'chat-idle',
        executionStep: 'awaiting_followup',
      });
      seedTask(sqlite, {
        id: 'task-superseded',
        chatSessionId: null,
        supersededByTaskId: 'task-successor',
      });
      seedSleepingSnapshot(sqlite, { id: 'snapshot-sleeping' });

      const rows = await listAgentActivityTasks(env, {
        userId: 'user-1',
        activeOnly: true,
        nowMs: Date.parse('2026-08-30T12:00:00.000Z'),
      });
      const states = Object.fromEntries(rows.map((row) => [row.id, row.agentActivityState]));

      expect(states).toEqual({
        'task-idle': 'awake-idle',
        'task-sleeping': 'sleeping',
        'task-working': 'working',
      });
      expect(rows.map((row) => row.id)).not.toContain('task-superseded');
    } finally {
      sqlite.close();
    }
  });

  it('keeps superseded rows visible only when active filtering is disabled', async () => {
    const { sqlite, env } = createActivityDb();
    try {
      seedTask(sqlite, {
        id: 'task-superseded',
        chatSessionId: null,
        supersededByTaskId: 'task-successor',
      });

      await expect(
        listAgentActivityTasks(env, { userId: 'user-1', activeOnly: true })
      ).resolves.toHaveLength(0);

      await expect(
        listAgentActivityTasks(env, { userId: 'user-1', activeOnly: false })
      ).resolves.toEqual([
        expect.objectContaining({
          id: 'task-superseded',
          agentActivityState: 'superseded',
        }),
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('does not classify a task as sleeping from another project snapshot', async () => {
    const { sqlite, env } = createActivityDb();
    try {
      seedTask(sqlite, {
        id: 'task-cross-project',
        projectId: 'project-1',
        chatSessionId: 'chat-shared',
        executionStep: 'awaiting_followup',
      });
      seedSleepingSnapshot(sqlite, {
        id: 'snapshot-cross-project',
        projectId: 'project-2',
        workspaceId: 'ws-other',
        chatSessionId: 'chat-shared',
      });

      const rows = await listAgentActivityTasks(env, {
        projectId: 'project-1',
        activeOnly: true,
        nowMs: Date.parse('2026-08-30T12:00:00.000Z'),
      });

      expect(rows).toEqual([
        expect.objectContaining({
          id: 'task-cross-project',
          agentActivityState: 'awake-idle',
        }),
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('requires a restorable unexpired sleeping snapshot before marking sleeping', async () => {
    const { sqlite, env } = createActivityDb();
    try {
      seedTask(sqlite, {
        id: 'task-expired-snapshot',
        chatSessionId: 'chat-expired',
        executionStep: 'awaiting_followup',
      });
      seedSleepingSnapshot(sqlite, {
        id: 'snapshot-expired',
        chatSessionId: 'chat-expired',
        expiresAt: '2026-08-29T00:00:00.000Z',
      });

      const rows = await listAgentActivityTasks(env, {
        userId: 'user-1',
        activeOnly: true,
        nowMs: Date.parse('2026-08-30T12:00:00.000Z'),
      });

      expect(rows).toEqual([
        expect.objectContaining({
          id: 'task-expired-snapshot',
          agentActivityState: 'awake-idle',
        }),
      ]);
    } finally {
      sqlite.close();
    }
  });
});
