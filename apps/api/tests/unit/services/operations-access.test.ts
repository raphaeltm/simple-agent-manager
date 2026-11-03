/**
 * The Operations debugger-tool gate against a real SQL engine (rule 28): every condition is
 * read from D1 through the production resolvers, the mode is written through the real admin
 * settings mutation path, and each attack case sits beside an owner-path control.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  __resetAdminSettingsCacheForTest,
  updateAdminSettings,
} from '../../../src/services/admin-settings';
import {
  getOperationsAccessStatus,
  isOperationsProject,
  OPERATIONS_AUDIT_DETAIL_MAX_CHARS,
  OperationsAccessError,
  type OperationsToolsMode,
  purgeExpiredOperationsAudit,
  recordOperationsAudit,
  requireOperationsAccess,
  resolveOperationsToolsMode,
} from '../../../src/services/operations-access';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';
import { applySqliteMigration, createSchemaTables } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/logger')>()),
  log: mocks.log,
}));

const OPS_PROJECT = 'ops-project';
const OTHER_PROJECT = 'other-project';
const SUPERADMIN = 'user-superadmin';
const MEMBER = 'user-member';
const OPS_TASK = 'task-ops';
const MEMBER_TASK = 'task-member';
const OTHER_TASK = 'task-other-project';

let sqlite: Database.Database;
let env: Env;

function setMode(mode: OperationsToolsMode) {
  return updateAdminSettings(env, {
    actorUserId: SUPERADMIN,
    changes: [{ name: 'operations.debuggerTools', value: mode }],
  });
}

function token(overrides: Partial<{ projectId: string; taskId: string; userId: string }> = {}) {
  return {
    projectId: OPS_PROJECT,
    taskId: OPS_TASK,
    userId: SUPERADMIN,
    workspaceId: 'ws-1',
    ...overrides,
  };
}

async function denialOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof OperationsAccessError) return err.reason;
    throw err;
  }
  return 'allowed';
}

beforeEach(() => {
  __resetAdminSettingsCacheForTest();
  ({ sqlite, env } = createAdminSettingsEnv({ PLATFORM_FEEDBACK_PROJECT_ID: OPS_PROJECT }));
  createSchemaTables(sqlite, [schema.users, schema.tasks]);
  applySqliteMigration(
    sqlite,
    new URL('../../../src/db/migrations/0217_operations_audit_log.sql', import.meta.url)
  );
  const user = sqlite.prepare('INSERT INTO users (id, email, role, status) VALUES (?, ?, ?, ?)');
  user.run(SUPERADMIN, 'root@example.com', 'superadmin', 'active');
  user.run(MEMBER, 'member@example.com', 'user', 'active');
  const task = sqlite.prepare('INSERT INTO tasks (id, project_id, user_id) VALUES (?, ?, ?)');
  task.run(OPS_TASK, OPS_PROJECT, SUPERADMIN);
  task.run(MEMBER_TASK, OPS_PROJECT, MEMBER);
  task.run(OTHER_TASK, OTHER_PROJECT, SUPERADMIN);
  mocks.log.warn.mockClear();
  mocks.log.error.mockClear();
});

afterEach(() => {
  sqlite.close();
});

describe('resolveOperationsToolsMode', () => {
  it('defaults to off and follows the admin setting written through the real mutation path', async () => {
    expect(await resolveOperationsToolsMode(env)).toBe('off');
    await setMode('read_ask');
    expect(await resolveOperationsToolsMode(env)).toBe('read_ask');
  });

  it('observes a turned-down dial on the very next call (no cache window)', async () => {
    await setMode('read_auto_safe');
    expect(await resolveOperationsToolsMode(env)).toBe('read_auto_safe');
    await setMode('off');
    expect(await resolveOperationsToolsMode(env)).toBe('off');
  });

  it('sees a dial turned down by another isolate on the next call', async () => {
    await setMode('read_ask');
    expect(await resolveOperationsToolsMode(env)).toBe('read_ask');
    // Another isolate's write does not invalidate this isolate's settings cache.
    sqlite
      .prepare("UPDATE platform_settings SET value = ? WHERE key = 'operations.debuggerTools'")
      .run(JSON.stringify('off'));
    expect(await resolveOperationsToolsMode(env)).toBe('off');
  });

  it('rejects an unknown value at write time', async () => {
    await expect(
      updateAdminSettings(env, {
        actorUserId: SUPERADMIN,
        changes: [{ name: 'operations.debuggerTools', value: 'everything' }],
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('fails closed to off when the settings store is unreadable', async () => {
    await setMode('read');
    __resetAdminSettingsCacheForTest();
    sqlite.exec('DROP TABLE platform_settings');
    expect(await resolveOperationsToolsMode(env)).toBe('off');
  });
});

describe('isOperationsProject', () => {
  it('uses the runtime feedback.projectId setting before the environment fallback', async () => {
    expect(await isOperationsProject(env, OPS_PROJECT)).toBe(true);
    sqlite
      .prepare("INSERT INTO platform_settings (key, value) VALUES ('feedback.projectId', ?)")
      .run('runtime-ops');
    expect(await isOperationsProject(env, OPS_PROJECT)).toBe(false);
    expect(await isOperationsProject(env, 'runtime-ops')).toBe(true);
  });

  it('is false for every project when no Operations project is configured', async () => {
    env = { ...env, PLATFORM_FEEDBACK_PROJECT_ID: undefined };
    expect(await isOperationsProject(env, OPS_PROJECT)).toBe(false);
    expect(await isOperationsProject(env, '')).toBe(false);
  });
});

describe('requireOperationsAccess', () => {
  it('allows the happy path and returns the access context (owner control)', async () => {
    await setMode('read_ask');
    await expect(requireOperationsAccess(env, token(), { capability: 'read' })).resolves.toEqual({
      mode: 'read_ask',
      projectId: OPS_PROJECT,
      taskId: OPS_TASK,
      userId: SUPERADMIN,
    });
    await expect(
      requireOperationsAccess(env, token(), { capability: 'act' })
    ).resolves.toMatchObject({ mode: 'read_ask' });
  });

  it('denies a non-Operations project even for a superadmin-owned task there', async () => {
    await setMode('read_auto_safe');
    expect(
      await denialOf(
        requireOperationsAccess(env, token({ projectId: OTHER_PROJECT, taskId: OTHER_TASK }), {
          capability: 'read',
        })
      )
    ).toBe('not_operations_project');
  });

  it('denies a user-scoped (non-task) token', async () => {
    await setMode('read');
    expect(
      await denialOf(requireOperationsAccess(env, token({ taskId: '' }), { capability: 'read' }))
    ).toBe('not_task_scoped');
  });

  it('denies a task owned by a non-superadmin Operations project member', async () => {
    await setMode('read');
    expect(
      await denialOf(
        requireOperationsAccess(env, token({ taskId: MEMBER_TASK, userId: MEMBER }), {
          capability: 'read',
        })
      )
    ).toBe('not_superadmin');
  });

  it('denies a superadmin demoted after the task started, on the next call', async () => {
    await setMode('read');
    await expect(
      requireOperationsAccess(env, token(), { capability: 'read' })
    ).resolves.toBeDefined();
    sqlite.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(SUPERADMIN);
    expect(await denialOf(requireOperationsAccess(env, token(), { capability: 'read' }))).toBe(
      'not_superadmin'
    );
  });

  it('denies a superadmin whose account is no longer active', async () => {
    await setMode('read');
    sqlite.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(SUPERADMIN);
    expect(await denialOf(requireOperationsAccess(env, token(), { capability: 'read' }))).toBe(
      'not_superadmin'
    );
  });

  it('denies a token whose user is not the owner of its task', async () => {
    await setMode('read');
    // A superadmin token pointed at a member's task: the task owner decides, not the token.
    expect(
      await denialOf(
        requireOperationsAccess(env, token({ taskId: MEMBER_TASK }), { capability: 'read' })
      )
    ).toBe('task_owner_mismatch');
  });

  it('denies a task id that belongs to another project', async () => {
    await setMode('read');
    expect(
      await denialOf(
        requireOperationsAccess(env, token({ taskId: OTHER_TASK }), { capability: 'read' })
      )
    ).toBe('task_not_found');
  });

  it('denies every capability while the mode is off', async () => {
    expect(await denialOf(requireOperationsAccess(env, token(), { capability: 'read' }))).toBe(
      'mode_off'
    );
    expect(await denialOf(requireOperationsAccess(env, token(), { capability: 'act' }))).toBe(
      'mode_off'
    );
  });

  it('allows read but denies act in read mode', async () => {
    await setMode('read');
    await expect(
      requireOperationsAccess(env, token(), { capability: 'read' })
    ).resolves.toBeDefined();
    expect(await denialOf(requireOperationsAccess(env, token(), { capability: 'act' }))).toBe(
      'mode_read_only'
    );
  });

  it('logs every denial with the identifiers needed to trace it', async () => {
    await denialOf(requireOperationsAccess(env, token(), { capability: 'act' }));
    expect(mocks.log.warn).toHaveBeenCalledWith('operations.access_denied', {
      reason: 'mode_off',
      capability: 'act',
      projectId: OPS_PROJECT,
      taskId: OPS_TASK,
      userId: SUPERADMIN,
      workspaceId: 'ws-1',
      action: 'rejected',
    });
  });
});

describe('getOperationsAccessStatus', () => {
  it('reports both capabilities and the reason for any denial', async () => {
    await setMode('read');
    expect(await getOperationsAccessStatus(env, token())).toEqual({
      operationsProject: true,
      mode: 'read',
      capabilities: { read: true, act: false },
      denials: {
        act: { reason: 'mode_read_only', message: expect.stringContaining('read-only') },
      },
    });
  });

  it('reports the identity denial for a non-superadmin owner even when the mode allows act', async () => {
    await setMode('read_auto_safe');
    const status = await getOperationsAccessStatus(
      env,
      token({ taskId: MEMBER_TASK, userId: MEMBER })
    );
    expect(status.capabilities).toEqual({ read: false, act: false });
    expect(status.denials.read?.reason).toBe('not_superadmin');
  });

  it('does not reveal the mode outside the Operations project', async () => {
    await setMode('read_ask');
    const status = await getOperationsAccessStatus(
      env,
      token({ projectId: OTHER_PROJECT, taskId: OTHER_TASK })
    );
    expect(status).toMatchObject({
      operationsProject: false,
      capabilities: { read: false, act: false },
    });
    expect(status).not.toHaveProperty('mode');
  });
});

describe('operations audit', () => {
  it('writes one row per call with a bounded detail', async () => {
    const written = await recordOperationsAudit(env, {
      actorUserId: SUPERADMIN,
      taskId: OPS_TASK,
      tool: 'ops_get_access_status',
      targetType: 'installation',
      outcome: 'allowed',
      detail: { blob: 'x'.repeat(OPERATIONS_AUDIT_DETAIL_MAX_CHARS * 2) },
    });
    expect(written).toBe(true);
    const row = sqlite.prepare('SELECT * FROM operations_audit_log').get() as Record<
      string,
      string | null
    >;
    expect(row).toMatchObject({
      actor_user_id: SUPERADMIN,
      task_id: OPS_TASK,
      tool: 'ops_get_access_status',
      target_type: 'installation',
      target_id: null,
      outcome: 'allowed',
      approval_id: null,
    });
    expect(row.detail).toHaveLength(OPERATIONS_AUDIT_DETAIL_MAX_CHARS);
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('never throws when the audit write fails, and logs it at error level', async () => {
    sqlite.exec('DROP TABLE operations_audit_log');
    await expect(
      recordOperationsAudit(env, {
        actorUserId: SUPERADMIN,
        taskId: OPS_TASK,
        tool: 'ops_get_access_status',
        targetType: 'installation',
        outcome: 'allowed',
      })
    ).resolves.toBe(false);
    expect(mocks.log.error).toHaveBeenCalledWith(
      'operations.audit_write_failed',
      expect.objectContaining({ taskId: OPS_TASK, tool: 'ops_get_access_status' })
    );
  });

  it('purges only rows older than the configured retention', async () => {
    await updateAdminSettings(env, {
      actorUserId: SUPERADMIN,
      changes: [{ name: 'operations.auditRetentionDays', value: 7 }],
    });
    const insert = sqlite.prepare(
      `INSERT INTO operations_audit_log (id, actor_user_id, task_id, tool, target_type, outcome, created_at)
       VALUES (?, ?, ?, 'ops_get_access_status', 'installation', 'allowed', ?)`
    );
    insert.run('old', SUPERADMIN, OPS_TASK, '2026-10-01T00:00:00.000Z');
    insert.run('fresh', SUPERADMIN, OPS_TASK, '2026-10-30T00:00:00.000Z');
    const result = await purgeExpiredOperationsAudit(env, new Date('2026-11-03T00:00:00.000Z'));
    expect(result).toEqual({ retentionDays: 7, deleted: 1 });
    expect(sqlite.prepare('SELECT id FROM operations_audit_log').all()).toEqual([{ id: 'fresh' }]);
  });
});
