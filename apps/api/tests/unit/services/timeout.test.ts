/**
 * The provisioning-timeout cron (`checkProvisioningTimeouts`) on a real SQLite engine.
 *
 * It errors a 'creating' workspace only past the shared per-attempt deadline
 * (`workspace-creating-deadline.ts`): the queue budget before the build starts, the build budget
 * (`PROVISIONING_TIMEOUT_MS`) from the durable build start. Before migration 0228 it errored
 * every 'creating' row 30 minutes after `created_at`, so a workspace still queued behind a
 * node's single build slot, or restarted long after it was created, was killed.
 */
import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  __resetAdminSettingsCacheForTest,
  updateAdminSettings,
} from '../../../src/services/admin-settings';
import {
  checkProvisioningTimeouts,
  isWorkspaceWithinCreatingDeadline,
} from '../../../src/services/timeout';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../../helpers/sqlite-d1';

const MINUTE = 60_000;

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

function seedCreating(
  id: string,
  clock: { createdAt: string; creatingStartedAt?: string | null; buildStartedAt?: string | null },
  status = 'creating'
): void {
  sqlite
    .prepare(
      `INSERT INTO workspaces
       (id, node_id, user_id, project_id, name, repository, branch, status, vm_size, vm_location,
        created_at, updated_at, creating_started_at, build_started_at)
       VALUES (?, 'node-1', 'user-1', 'project-1', ?, 'acme/repo', 'main', ?, 'small', 'fsn1',
        ?, ?, ?, ?)`
    )
    .run(
      id,
      id,
      status,
      clock.createdAt,
      clock.createdAt,
      clock.creatingStartedAt ?? null,
      clock.buildStartedAt ?? null
    );
}

function statusOf(id: string): { status: string; error_message: string | null } {
  return sqlite.prepare('SELECT status, error_message FROM workspaces WHERE id = ?').get(id) as {
    status: string;
    error_message: string | null;
  };
}

describe('checkProvisioningTimeouts', () => {
  it('leaves a workspace queued 45 minutes for its build slot alone (the old 30-minute kill)', async () => {
    seedCreating('queued-45', { createdAt: ago(45), creatingStartedAt: ago(45) });
    // Liveness: a workspace past the queue budget in the same pass is timed out.
    seedCreating('queued-61', { createdAt: ago(61), creatingStartedAt: ago(61) });

    await expect(checkProvisioningTimeouts(env.DATABASE, env)).resolves.toBe(1);

    expect(statusOf('queued-45')).toEqual({ status: 'creating', error_message: null });
    expect(statusOf('queued-61')).toEqual({
      status: 'error',
      error_message: 'Provisioning timed out: the workspace build did not start within 60 minutes',
    });
  });

  it('measures a started build from its build start, not from the queue time before it', async () => {
    seedCreating('building-fresh', {
      createdAt: ago(55),
      creatingStartedAt: ago(55),
      buildStartedAt: ago(20),
    });
    // A build genuinely stuck after it started is still timed out.
    seedCreating('building-stuck', {
      createdAt: ago(40),
      creatingStartedAt: ago(40),
      buildStartedAt: ago(31),
    });

    await expect(checkProvisioningTimeouts(env.DATABASE, env)).resolves.toBe(1);

    expect(statusOf('building-fresh').status).toBe('creating');
    expect(statusOf('building-stuck')).toEqual({
      status: 'error',
      error_message: 'Provisioning timed out 30 minutes after the workspace build started',
    });
  });

  it('anchors a restarted attempt on its own start, not on created_at', async () => {
    seedCreating('restarted', { createdAt: ago(600), creatingStartedAt: ago(5) });
    await expect(checkProvisioningTimeouts(env.DATABASE, env)).resolves.toBe(0);
    expect(statusOf('restarted').status).toBe('creating');
  });

  it('falls back to created_at for rows from before the attempt clock existed', async () => {
    seedCreating('legacy-fresh', { createdAt: ago(45) });
    seedCreating('legacy-old', { createdAt: ago(61) });
    await expect(checkProvisioningTimeouts(env.DATABASE, env)).resolves.toBe(1);
    expect(statusOf('legacy-fresh').status).toBe('creating');
    expect(statusOf('legacy-old').status).toBe('error');
  });

  it('never touches a workspace that is not creating', async () => {
    seedCreating('running-old', { createdAt: ago(600), creatingStartedAt: ago(600) }, 'running');
    await expect(checkProvisioningTimeouts(env.DATABASE, env)).resolves.toBe(0);
    expect(statusOf('running-old')).toEqual({ status: 'running', error_message: null });
  });

  it('does not overwrite a workspace that became ready between the read and the write', async () => {
    seedCreating('racing', { createdAt: ago(61), creatingStartedAt: ago(61) });
    const realDb = env.DATABASE;
    let raced = false;
    // Hold the cron at its midpoint: the ready callback lands right before the error UPDATE.
    const database = new Proxy(realDb, {
      get(target, prop) {
        if (prop !== 'prepare') {
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (query: string) => {
          if (query.includes("SET status = 'error'") && !raced) {
            raced = true;
            sqlite.prepare("UPDATE workspaces SET status = 'running' WHERE id = 'racing'").run();
          }
          return target.prepare(query);
        };
      },
    });

    await expect(checkProvisioningTimeouts(database, env)).resolves.toBe(0);

    expect(raced).toBe(true);
    expect(statusOf('racing')).toEqual({ status: 'running', error_message: null });
  });

  it('does not error a queued workspace whose build started between the read and the write', async () => {
    seedCreating('starting', { createdAt: ago(61), creatingStartedAt: ago(61) });
    const realDb = env.DATABASE;
    let started = false;
    const database = new Proxy(realDb, {
      get(target, prop) {
        if (prop !== 'prepare') {
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (query: string) => {
          if (query.includes("SET status = 'error'") && !started) {
            started = true;
            sqlite
              .prepare('UPDATE workspaces SET build_started_at = ? WHERE id = ?')
              .run(new Date().toISOString(), 'starting');
          }
          return target.prepare(query);
        };
      },
    });

    await expect(checkProvisioningTimeouts(database, env)).resolves.toBe(0);
    expect(started).toBe(true);
    expect(statusOf('starting').status).toBe('creating');
  });

  it('applies a non-default queue budget through the admin setting', async () => {
    await updateAdminSettings(env, {
      actorUserId: 'admin-1',
      changes: [{ name: 'operations.workspaceBuildQueueTimeoutMinutes', value: 90 }],
    });
    // Past the 60-minute default but inside the configured 90.
    seedCreating('queued-75', { createdAt: ago(75), creatingStartedAt: ago(75) });
    seedCreating('queued-91', { createdAt: ago(91), creatingStartedAt: ago(91) });

    await expect(checkProvisioningTimeouts(env.DATABASE, env)).resolves.toBe(1);
    expect(statusOf('queued-75').status).toBe('creating');
    expect(statusOf('queued-91')).toEqual({
      status: 'error',
      error_message: 'Provisioning timed out: the workspace build did not start within 90 minutes',
    });
  });

  it('never shortens a longer build budget for a start that does not report its build', async () => {
    await updateAdminSettings(env, {
      actorUserId: 'admin-1',
      changes: [{ name: 'operations.workspaceBuildQueueTimeoutMinutes', value: 10 }],
    });
    // A direct create never reports a build start. With a 45-minute build budget and a
    // 10-minute queue budget it gets the larger of the two for the whole attempt.
    const longBuild = { ...env, PROVISIONING_TIMEOUT_MS: String(45 * MINUTE) } as Env;
    seedCreating('direct-30', { createdAt: ago(30), creatingStartedAt: ago(30) });
    seedCreating('direct-46', { createdAt: ago(46), creatingStartedAt: ago(46) });

    await expect(checkProvisioningTimeouts(env.DATABASE, longBuild)).resolves.toBe(1);
    expect(statusOf('direct-30').status).toBe('creating');
    expect(statusOf('direct-46').status).toBe('error');
  });
});

describe('isWorkspaceWithinCreatingDeadline', () => {
  it('is true only for a creating workspace inside its deadline', async () => {
    const now = new Date();
    seedCreating('inside', { createdAt: ago(45), creatingStartedAt: ago(45) });
    seedCreating('outside', { createdAt: ago(61), creatingStartedAt: ago(61) });
    seedCreating('ready', { createdAt: ago(5), creatingStartedAt: ago(5) }, 'running');

    expect(await isWorkspaceWithinCreatingDeadline(env.DATABASE, env, 'inside', now)).toBe(true);
    expect(await isWorkspaceWithinCreatingDeadline(env.DATABASE, env, 'outside', now)).toBe(false);
    expect(await isWorkspaceWithinCreatingDeadline(env.DATABASE, env, 'ready', now)).toBe(false);
    expect(await isWorkspaceWithinCreatingDeadline(env.DATABASE, env, 'missing', now)).toBe(false);
  });
});
