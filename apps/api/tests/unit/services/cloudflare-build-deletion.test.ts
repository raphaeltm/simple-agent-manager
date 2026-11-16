import { readFileSync } from 'node:fs';

import {
  admitCloudflareBuild,
  assertNoReservedCloudflareBuilds,
  isCloudflareBuildDeletionConflict,
  releaseCloudflareBuildReservation,
} from '@simple-agent-manager/app-deployment';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const limits = { platform: 6, project: 2, classMax: 6, deadlineMs: 1_200_000 };
beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  for (const table of [
    'projects',
    'deployment_environments',
    'nodes',
    'users',
    'deployment_releases',
    'workspaces',
  ]) {
    sqlite.exec(
      `CREATE TABLE ${table} (id TEXT PRIMARY KEY); INSERT INTO ${table} VALUES ('owner')`
    );
  }
  // Real job FKs and shipped trigger, not the constraint-free schema test helper.
  for (const file of [
    '0077_deployment_publish_jobs.sql',
    '0227_publish_job_heartbeat.sql',
    '0230_publish_job_build_context.sql',
    '0231_publish_job_context_shadow.sql',
    '0242_cloudflare_build_executor.sql',
    '0243_cloudflare_build_reservation_deletion_guard.sql',
  ]) {
    sqlite.exec(
      readFileSync(new URL(`../../../src/db/migrations/${file}`, import.meta.url), 'utf8')
    );
  }
  sqlite
    .prepare(
      `INSERT INTO deployment_publish_jobs
    (id,project_id,environment_id,workspace_id,node_id,requested_by,environment_name,executor,status,context_r2_key,context_sha256,created_at)
    VALUES ('job','owner','owner','owner','owner','owner','production','cloudflare','context_ready','key','sha',?)`
    )
    .run(new Date().toISOString());
  db = drizzle(createSqliteD1(sqlite), { schema });
});
afterEach(() => sqlite.close());

describe('Cloudflare reservation deletion fence', () => {
  it.each(['deployment_publish_jobs', 'nodes', 'projects', 'deployment_environments', 'users'])(
    'blocks %s deletion, even for terminal reservations, then allows it after confirmed release',
    async (table) => {
      expect(await admitCloudflareBuild(db, 'job', limits)).toBeTruthy();
      const id = table === 'deployment_publish_jobs' ? 'job' : 'owner';
      for (const status of ['starting', 'building', 'canceled', 'succeeded']) {
        sqlite.prepare('UPDATE deployment_publish_jobs SET status=?').run(status);
        expect(() => sqlite.prepare(`DELETE FROM ${table} WHERE id=?`).run(id)).toThrow(
          'cloudflare_build_reservation_held'
        );
        expect(sqlite.prepare('SELECT id FROM deployment_publish_jobs').get()).toEqual({
          id: 'job',
        });
        if (table !== 'deployment_publish_jobs')
          expect(sqlite.prepare(`SELECT id FROM ${table}`).get()).toBeTruthy();
      }
      await releaseCloudflareBuildReservation(db, 'job', 1);
      sqlite.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
      expect(sqlite.prepare('SELECT id FROM deployment_publish_jobs').get()).toBeUndefined();
    }
  );
  it.each(["executor='node'", 'context_shadow=1', 'executor_instance_id=NULL'])(
    'preserves legacy, shadow and unreserved deletion behavior: %s',
    (mutation) => {
      sqlite.prepare("UPDATE deployment_publish_jobs SET executor_instance_id='job'").run();
      sqlite.exec(`UPDATE deployment_publish_jobs SET ${mutation}`);
      sqlite.exec("DELETE FROM nodes WHERE id='owner'");
      expect(sqlite.prepare('SELECT id FROM deployment_publish_jobs').get()).toBeUndefined();
    }
  );
  it('delete-before-admission cannot acquire a missing job', async () => {
    sqlite.exec("DELETE FROM projects WHERE id='owner'");
    expect(await admitCloudflareBuild(db, 'job', limits)).toBeNull();
  });
  it('workspace deletion does not erase the job: workspace_id has deliberately never been an FK', async () => {
    await admitCloudflareBuild(db, 'job', limits);
    sqlite.exec("DELETE FROM workspaces WHERE id='owner'");
    expect(
      sqlite.prepare('SELECT executor_instance_id FROM deployment_publish_jobs').get()
    ).toEqual({ executor_instance_id: 'job' });
  });
  it('preflights all supported scopes, including terminal-but-stop-pending, and permits after release', async () => {
    await admitCloudflareBuild(db, 'job', limits);
    sqlite.exec("UPDATE deployment_publish_jobs SET status='succeeded'");
    for (const scope of [{ nodeId: 'owner' }, { projectId: 'owner' }, { environmentId: 'owner' }]) {
      await expect(assertNoReservedCloudflareBuilds(db, scope)).rejects.toMatchObject({
        statusCode: 409,
      });
    }
    await expect(
      assertNoReservedCloudflareBuilds(db, { nodeId: 'other' })
    ).resolves.toBeUndefined();
    await releaseCloudflareBuildReservation(db, 'job', 1);
    await expect(
      assertNoReservedCloudflareBuilds(db, { nodeId: 'owner' })
    ).resolves.toBeUndefined();
  });
  it('maps a wrapped final-mutation conflict to a safe 409 response', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleAppError);
    app.delete('/resource', () => {
      throw new Error('Failed query with private params', {
        cause: new Error('D1_ERROR: cloudflare_build_reservation_held: SQLITE_CONSTRAINT'),
      });
    });
    const response = await app.request('/resource', { method: 'DELETE' }, {} as Env);
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('private params');
  });
  it('recognizes only the fixed trigger marker through nested D1 causes, with cycle protection', () => {
    const cause = new Error('D1_ERROR: cloudflare_build_reservation_held: SQLITE_CONSTRAINT');
    expect(
      isCloudflareBuildDeletionConflict(new Error('Failed query: private params', { cause }))
    ).toBe(true);
    expect(isCloudflareBuildDeletionConflict(new Error('another constraint'))).toBe(false);
    const cycle = new Error('cycle');
    cycle.cause = cycle;
    expect(isCloudflareBuildDeletionConflict(cycle)).toBe(false);
  });
});
