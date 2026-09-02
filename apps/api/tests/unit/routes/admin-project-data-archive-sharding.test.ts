import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import {
  PROJECT_DATA_ARCHIVE_TABLES,
  type ProjectDataArchiveTableName,
} from '../../../src/project-data-archive/contract';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const PROJECT_ID = 'project-archive';
const SESSION_ID = 'session-archive';
const SOURCE_OWNER = PROJECT_ID;
const TARGET_OWNER = `${PROJECT_ID}:archive:g1:s1`;
const TERMINAL_SHA = 'a'.repeat(64);
const TARGET_SHA = 'b'.repeat(64);

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireSuperadmin: () =>
    vi.fn(
      (
        c: {
          req: { header: (name: string) => string | undefined };
          json: (body: unknown, status: 403) => Response;
        },
        next: () => Promise<void>
      ) =>
        c.req.header('x-test-role') === 'superadmin'
          ? next()
          : c.json({ error: 'FORBIDDEN', message: 'Superadmin access required' }, 403)
    ),
}));

const { requireAuth, requireApproved, requireSuperadmin } =
  await import('../../../src/middleware/auth');
const { adminProjectDataStorageRoutes } =
  await import('../../../src/routes/admin/project-data-storage');

function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.use('/api/admin/project-data/storage/*', requireAuth(), requireApproved(), requireSuperadmin());
  app.route('/api/admin/project-data/storage', adminProjectDataStorageRoutes);
  return app;
}

function makeEnv(sqlite: Database.Database, overrides: Partial<Env> = {}): Env {
  return {
    DATABASE: createSqliteD1(sqlite),
    ...overrides,
  } as Env;
}

function createTables(sqlite: Database.Database): void {
  createSchemaTables(sqlite, [
    schema.sessionSummaries,
    schema.sessionSnapshots,
    schema.projectDataArchiveCircuitBreakers,
    schema.projectDataArchiveMigrations,
    schema.projectDataSessionLocations,
  ]);
}

function seedSessionSummary(sqlite: Database.Database, projectId: string, sessionId: string): void {
  sqlite
    .prepare(
      `INSERT INTO session_summaries
         (id, project_id, user_id, status, topic, message_count, started_at, ended_at, updated_at)
       VALUES (?, ?, 'owner', 'stopped', 'Route canary', 1, 100, 200, 300)`
    )
    .run(sessionId, projectId);
}

function seedArchiveMigration(
  sqlite: Database.Database,
  input: {
    migrationId: string;
    projectId?: string;
    sessionId?: string;
    state?: string;
    locationState?: string;
  }
): void {
  const projectId = input.projectId ?? PROJECT_ID;
  const sessionId = input.sessionId ?? SESSION_ID;
  const state = input.state ?? 'failed';
  const locationState = input.locationState ?? 'migrating';
  sqlite
    .prepare(
      `INSERT INTO project_data_archive_migrations
         (migration_id, project_id, session_id, state, source_owner_name,
          target_owner_name, target_generation, source_intent_token,
          terminal_version_sha256, target_aggregate_sha256, r2_manifest_key,
          lease_epoch, attempt_count, error_code, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'old-token', ?, ?, 'manifest-key',
               0, 1, 'test_error', 'test message', 900, 1000)`
    )
    .run(input.migrationId, projectId, sessionId, state, SOURCE_OWNER, TARGET_OWNER, TERMINAL_SHA, TARGET_SHA);
  sqlite
    .prepare(
      `INSERT INTO project_data_session_locations
         (project_id, session_id, location_state, owner_kind, owner_name,
          generation, migration_id, source_owner_name, target_owner_name,
          target_aggregate_sha256, routing_schema_version, updated_at)
       VALUES (?, ?, ?, 'archive_shard', ?, 1, ?, ?, ?, ?, 1, 1000)`
    )
    .run(
      projectId,
      sessionId,
      locationState,
      TARGET_OWNER,
      input.migrationId,
      SOURCE_OWNER,
      TARGET_OWNER,
      TARGET_SHA
    );
}

function makeArchiveChunk(tableName: ProjectDataArchiveTableName, ordinal: number) {
  return {
    migrationId: 'migration-copy-back',
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    sourceOwnerName: SOURCE_OWNER,
    targetOwnerName: TARGET_OWNER,
    targetGeneration: 1,
    tableName,
    ordinal,
    rows: [],
    rowIds: [],
    rowCount: 0,
    byteCount: 2,
    sha256: 'chunk-sha',
    cursor: null,
    hasMore: false,
  };
}

function createArchiveProjectDataNamespace(overrides: Record<string, unknown> = {}): DurableObjectNamespace {
  const source = {
    ensureProjectId: vi.fn(async () => true),
    archiveSourceInspectIntent: vi.fn(async () => ({
      exists: true,
      state: 'source_deleted',
      sourceIntentToken: 'old-token',
      terminalVersionSha256: TERMINAL_SHA,
      targetAggregateSha256: TARGET_SHA,
      r2ManifestKey: 'manifest-key',
      messageCount: 0,
      sourceDeletedAt: 1200,
      databaseSizeBeforeBytes: 100,
      databaseSizeAfterBytes: 10,
      databaseSizeBytes: 10,
    })),
    archiveSourceRestoreChunk: vi.fn(async () => true),
    archiveSourceMarkCopyBackRestored: vi.fn(async () => true),
  };
  const target = {
    ensureProjectId: vi.fn(async () => true),
    archiveTargetInspectSession: vi.fn(async () => ({
      exists: true,
      state: 'sealed',
      terminalVersionSha256: TERMINAL_SHA,
      aggregateSha256: TARGET_SHA,
      messageCount: 0,
      chunks: PROJECT_DATA_ARCHIVE_TABLES.map((tableName, ordinal) =>
        makeArchiveChunk(tableName, ordinal)
      ),
      databaseSizeBytes: 10,
    })),
    archiveTargetExportChunk: vi.fn(
      async (input: { tableName: ProjectDataArchiveTableName; ordinal: number }) =>
        makeArchiveChunk(input.tableName, input.ordinal)
    ),
    archiveTargetMarkRehomeExported: vi.fn(async () => true),
  };
  return {
    idFromName: (name: string) => name,
    get: (id: string) => {
      const stub = { [SOURCE_OWNER]: source, [TARGET_OWNER]: target, ...overrides }[id];
      if (!stub) throw new Error(`Missing fake ProjectData stub ${id}`);
      return stub;
    },
  } as unknown as DurableObjectNamespace;
}

describe('admin ProjectData archive-sharding rollout routes', () => {
  it('rejects non-superadmins before reading archive rollout state', async () => {
    const prepare = vi.fn();
    const env = { DATABASE: { prepare } } as unknown as Env;

    const response = await createApp().request(
      '/api/admin/project-data/storage/project-archive/archive-sharding/state',
      { headers: { 'x-test-role': 'user' } },
      env
    );

    expect(response.status).toBe(403);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('enforces configured rollout list bounds on D1 inspection endpoints', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      const env = makeEnv(sqlite, {
        PROJECT_DATA_ARCHIVE_ROLLOUT_LIST_LIMIT_DEFAULT: '2',
        PROJECT_DATA_ARCHIVE_ROLLOUT_LIST_LIMIT_MAX: '3',
      });

      const ok = await createApp().request(
        '/api/admin/project-data/storage/project-archive/archive-sharding/state?limit=3',
        { headers: { 'x-test-role': 'superadmin' } },
        env
      );
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ state: { filters: { limit: 3 } } });

      const tooLarge = await createApp().request(
        '/api/admin/project-data/storage/project-archive/archive-sharding/state?limit=4',
        { headers: { 'x-test-role': 'superadmin' } },
        env
      );
      expect(tooLarge.status).toBe(400);
      expect(await tooLarge.json()).toMatchObject({
        error: 'BAD_REQUEST',
        message: 'limit must be between 1 and 3',
      });
    } finally {
      sqlite.close();
    }
  });

  it('defaults manual canary requests to D1-only dry-run with global cron disabled', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      seedSessionSummary(sqlite, 'project-archive', 'session-target');
      const projectDataGet = vi.fn();
      const r2Put = vi.fn();
      const env = makeEnv(sqlite, {
        PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
        PROJECT_DATA: {
          idFromName: (name: string) => name,
          get: projectDataGet,
        } as unknown as DurableObjectNamespace,
        PROJECT_DATA_ARCHIVE_R2: { put: r2Put } as unknown as R2Bucket,
      });

      const response = await createApp().request(
        '/api/admin/project-data/storage/project-archive/archive-sharding/canary',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-test-role': 'superadmin' },
          body: JSON.stringify({ sessionId: 'session-target' }),
        },
        env
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: {
          dryRun: true,
          globalCronEnabled: false,
          selected: [
            {
              projectId: 'project-archive',
              sessionId: 'session-target',
              state: 'eligible_session',
            },
          ],
          stats: { selected: 1, migrated: 0 },
        },
      });
      expect(
        (
          sqlite
            .prepare('SELECT COUNT(*) AS count FROM project_data_archive_migrations')
            .get() as { count: number }
        ).count
      ).toBe(0);
      expect(projectDataGet).not.toHaveBeenCalled();
      expect(r2Put).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it('requires an explicit reason before non-dry canary execution', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      const response = await createApp().request(
        '/api/admin/project-data/storage/project-archive/archive-sharding/canary',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-test-role': 'superadmin' },
          body: JSON.stringify({ dryRun: false, sessionId: 'session-target' }),
        },
        makeEnv(sqlite)
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: 'BAD_REQUEST',
        message: 'reason is required when dryRun is false',
      });
    } finally {
      sqlite.close();
    }
  });

  it('refuses non-dry canary through the admin route while exact routing is disabled', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      seedSessionSummary(sqlite, 'project-archive', 'session-target');

      const response = await createApp().request(
        '/api/admin/project-data/storage/project-archive/archive-sharding/canary',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-test-role': 'superadmin' },
          body: JSON.stringify({
            dryRun: false,
            sessionId: 'session-target',
            reason: 'operator scoped canary',
          }),
        },
        makeEnv(sqlite, {
          PROJECT_DATA_ARCHIVE_R2: { put: vi.fn() } as unknown as R2Bucket,
          PROJECT_DATA: createArchiveProjectDataNamespace(),
        })
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: 'BAD_REQUEST',
        message: 'non-dry archive-sharding canary requires exact archive routing to be enabled',
      });
      expect(
        (
          sqlite
            .prepare('SELECT COUNT(*) AS count FROM project_data_archive_migrations')
            .get() as { count: number }
        ).count
      ).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it('wires frozen-intent inspection through the superadmin route', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      seedArchiveMigration(sqlite, {
        migrationId: 'migration-frozen-intent',
        state: 'failed',
      });
      const response = await createApp().request(
        '/api/admin/project-data/storage/project-archive/archive-sharding/frozen-intents',
        { headers: { 'x-test-role': 'superadmin' } },
        makeEnv(sqlite, {
          PROJECT_DATA: createArchiveProjectDataNamespace(),
        })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        inspections: [
          {
            migrationId: 'migration-frozen-intent',
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            journalState: 'failed',
            sourceIntent: { exists: true, state: 'source_deleted' },
            target: { exists: true, aggregateSha256: TARGET_SHA },
          },
        ],
        limit: 5,
      });
    } finally {
      sqlite.close();
    }
  });

  it('caps frozen-intent inspection below the D1-only rollout list maximum', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      const response = await createApp().request(
        '/api/admin/project-data/storage/project-archive/archive-sharding/frozen-intents?limit=11',
        { headers: { 'x-test-role': 'superadmin' } },
        makeEnv(sqlite, {
          PROJECT_DATA_ARCHIVE_FROZEN_INTENT_INSPECTION_LIMIT_MAX: '500',
        })
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: 'BAD_REQUEST',
        message: 'limit must be between 1 and 10',
      });
    } finally {
      sqlite.close();
    }
  });

  it('requires and returns a reason for copy-back recovery through the route', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      seedArchiveMigration(sqlite, {
        migrationId: 'migration-copy-back',
        state: 'published',
      });

      const missingReason = await createApp().request(
        '/api/admin/project-data/storage/project-archive/archive-sharding/migrations/migration-copy-back/copy-back',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-test-role': 'superadmin' },
          body: JSON.stringify({}),
        },
        makeEnv(sqlite, {
          PROJECT_DATA: createArchiveProjectDataNamespace(),
        })
      );
      expect(missingReason.status).toBe(400);

      const response = await createApp().request(
        '/api/admin/project-data/storage/project-archive/archive-sharding/migrations/migration-copy-back/copy-back',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-test-role': 'superadmin' },
          body: JSON.stringify({ reason: 'operator recovery' }),
        },
        makeEnv(sqlite, {
          PROJECT_DATA: createArchiveProjectDataNamespace(),
        })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: {
          migrationId: 'migration-copy-back',
          projectId: PROJECT_ID,
          sessionId: SESSION_ID,
          reason: 'operator recovery',
          restoredToRoot: true,
        },
      });
      expect(
        sqlite
          .prepare(
            `SELECT location_state, owner_kind, owner_name FROM project_data_session_locations
             WHERE project_id = ? AND session_id = ?`
          )
          .get(PROJECT_ID, SESSION_ID)
      ).toEqual({ location_state: 'root', owner_kind: 'root', owner_name: SOURCE_OWNER });
    } finally {
      sqlite.close();
    }
  });

  it('does not expose a misleading rehome recovery endpoint in this rollout slice', async () => {
    const sqlite = new Database(':memory:');
    try {
      const response = await createApp().request(
        '/api/admin/project-data/storage/project-archive/archive-sharding/migrations/migration-copy-back/rehome',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-test-role': 'superadmin' },
          body: JSON.stringify({ reason: 'operator rehome' }),
        },
        makeEnv(sqlite)
      );

      expect(response.status).toBe(404);
    } finally {
      sqlite.close();
    }
  });
});
