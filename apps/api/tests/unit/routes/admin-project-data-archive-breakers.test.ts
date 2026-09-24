import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
import { createAdminProjectDataStorageApp } from './helpers/admin-project-data-storage-route';

const LIST_URL =
  'http://localhost/api/admin/project-data/storage/archive-sharding/circuit-breakers';

function makeEnv(sqlite: Database.Database): Env {
  return { DATABASE: createSqliteD1(sqlite) } as Env;
}

function createTables(sqlite: Database.Database): void {
  createSchemaTables(sqlite, [schema.projects, schema.projectDataArchiveCircuitBreakers]);
}

function seedProject(sqlite: Database.Database, id: string, name: string): void {
  sqlite
    .prepare(
      `INSERT INTO projects (id, user_id, name, normalized_name, repository, created_at, updated_at)
       VALUES (?, 'owner', ?, ?, ?, 1, 1)`
    )
    .run(id, name, name.toLowerCase(), `org/${id}`);
}

function seedBreaker(
  sqlite: Database.Database,
  input: {
    projectId: string;
    state: string;
    reason?: string | null;
    openedAt?: number | null;
    updatedAt: number;
  }
): void {
  sqlite
    .prepare(
      `INSERT INTO project_data_archive_circuit_breakers (project_id, state, reason, opened_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      input.projectId,
      input.state,
      input.reason ?? null,
      input.openedAt ?? null,
      input.updatedAt
    );
}

describe('GET /api/admin/project-data/storage/archive-sharding/circuit-breakers', () => {
  it('lists breakers with project names, open breakers first, and skips malformed rows', async () => {
    const sqlite = new Database(':memory:');
    createTables(sqlite);
    seedProject(sqlite, 'project-open', 'SAM');
    seedProject(sqlite, 'project-closed', 'Other');
    seedBreaker(sqlite, {
      projectId: 'project-closed',
      state: 'closed',
      reason: 'operator reset',
      updatedAt: 5_000,
    });
    seedBreaker(sqlite, {
      projectId: 'project-open',
      state: 'open',
      reason: 'attempts_exhausted:Error',
      openedAt: 1_000,
      updatedAt: 2_000,
    });
    // Breaker for a deleted project: still listed, name null.
    seedBreaker(sqlite, { projectId: 'project-gone', state: 'frozen', updatedAt: 3_000 });
    // Malformed state must be skipped, not fail the list (rule 50).
    seedBreaker(sqlite, { projectId: 'project-bad', state: 'bogus', updatedAt: 4_000 });

    const app = createAdminProjectDataStorageApp();
    const response = await app.request(
      LIST_URL,
      { headers: { 'x-test-role': 'superadmin' } },
      makeEnv(sqlite)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      breakers: Array<Record<string, unknown>>;
      skippedRows: number;
      limit: number;
    };
    expect(body.skippedRows).toBe(1);
    expect(body.breakers.map((b) => b.projectId)).toEqual([
      'project-gone',
      'project-open',
      'project-closed',
    ]);
    expect(body.breakers[1]).toEqual({
      projectId: 'project-open',
      projectName: 'SAM',
      repository: 'org/project-open',
      state: 'open',
      reason: 'attempts_exhausted:Error',
      openedAt: 1_000,
      updatedAt: 2_000,
    });
    expect(body.breakers[0]).toMatchObject({
      projectName: null,
      repository: null,
      state: 'frozen',
    });
  });

  it('rejects non-superadmin callers', async () => {
    const sqlite = new Database(':memory:');
    createTables(sqlite);
    const app = createAdminProjectDataStorageApp();
    const response = await app.request(LIST_URL, {}, makeEnv(sqlite));
    expect(response.status).toBe(403);
  });

  it('rejects an out-of-range limit', async () => {
    const sqlite = new Database(':memory:');
    createTables(sqlite);
    const app = createAdminProjectDataStorageApp();
    const response = await app.request(
      `${LIST_URL}?limit=0`,
      { headers: { 'x-test-role': 'superadmin' } },
      makeEnv(sqlite)
    );
    expect(response.status).toBe(400);
  });

  it('closes a breaker through the control route and the list reflects it', async () => {
    const sqlite = new Database(':memory:');
    createTables(sqlite);
    seedProject(sqlite, 'project-open', 'SAM');
    seedBreaker(sqlite, {
      projectId: 'project-open',
      state: 'open',
      reason: 'attempts_exhausted:Error',
      openedAt: 1_000,
      updatedAt: 2_000,
    });
    const app = createAdminProjectDataStorageApp();
    const env = makeEnv(sqlite);

    const close = await app.request(
      'http://localhost/api/admin/project-data/storage/project-open/archive-sharding/circuit-breaker',
      {
        method: 'POST',
        headers: { 'x-test-role': 'superadmin', 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'closed', reason: 'Closed from admin UI' }),
      },
      env
    );
    expect(close.status).toBe(200);

    const list = await app.request(LIST_URL, { headers: { 'x-test-role': 'superadmin' } }, env);
    const body = (await list.json()) as { breakers: Array<Record<string, unknown>> };
    expect(body.breakers).toHaveLength(1);
    expect(body.breakers[0]).toMatchObject({
      projectId: 'project-open',
      state: 'closed',
      reason: 'Closed from admin UI',
      openedAt: null,
    });
  });
});
