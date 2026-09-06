import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type {
  ProjectDataArchiveChunk,
  ProjectDataArchiveJournalState,
  ProjectDataArchiveTableName,
} from '../../../src/project-data-archive/contract';
import {
  abandonProjectDataArchiveMigration,
  copyBackProjectDataArchiveMigration,
  freezeProjectDataArchiveMigration,
  inspectFrozenProjectDataArchiveIntents,
  poisonProjectDataArchiveMigration,
  runProjectDataArchiveSharding,
  runScopedProjectDataArchiveCanary,
} from '../../../src/scheduled/project-data-archive-sharding';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const NOW = Date.now() + 60_000;
const PROJECT_ID = 'project-archive';
const SESSION_ID = 'session-archived';
const MIGRATION_ID = 'migration-resume';
const SOURCE_OWNER = PROJECT_ID;
const TARGET_OWNER = `${PROJECT_ID}:archive:g1:s7`;
const TERMINAL_SHA = 'a'.repeat(64);
const TARGET_SHA = 'b'.repeat(64);
const MANIFEST_KEY = 'project-data/session-archives/project-archive/session-archived/manifest.json';

function makeEnv(sqlite: Database.Database, overrides: Partial<Env> = {}): Env {
  return {
    DATABASE: createSqliteD1(sqlite),
    ...overrides,
  } as Env;
}

function createD1WithOnePublishFailure(
  sqlite: Database.Database,
  failingSessionId: string
): D1Database {
  const database = createSqliteD1(sqlite) as D1Database & {
    prepare(sql: string): D1PreparedStatement;
  };
  let failed = false;
  return {
    ...database,
    prepare: (sql: string) => {
      const statement = database.prepare(sql);
      return {
        ...statement,
        bind: (...params: unknown[]) => {
          const bound = statement.bind(...params) as D1PreparedStatement;
          return {
            ...bound,
            run: async () => {
              if (
                !failed &&
                sql.includes('UPDATE project_data_session_locations') &&
                sql.includes("SET location_state = 'archive_shard'") &&
                params.includes(failingSessionId)
              ) {
                failed = true;
                throw new Error('transient D1 publish failure');
              }
              return bound.run();
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function createCoordinatorTables(sqlite: Database.Database): void {
  createSchemaTables(sqlite, [
    schema.sessionSummaries,
    schema.sessionSnapshots,
    schema.projectDataArchiveCircuitBreakers,
    schema.projectDataArchiveGlobalSweepCadence,
    schema.projectDataArchiveMigrations,
    schema.projectDataSessionLocations,
  ]);
}

function createMemoryR2(): R2Bucket {
  const objects = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => {
      const text = objects.get(key);
      return text === undefined ? null : ({ text: async () => text } as R2ObjectBody);
    }),
    put: vi.fn(async (key: string, value: string) => {
      objects.set(key, value);
      return null;
    }),
  } as unknown as R2Bucket;
}

type SourceState =
  | null
  | 'intent_prepared'
  | 'target_sealed'
  | 'recovery_manifest_persisted'
  | 'source_deleted';

type FakeSourceOptions = {
  state?: SourceState;
  token?: string;
  beforeTargetSealCas?: () => void;
};

function makeChunk(
  tableName: ProjectDataArchiveTableName,
  ordinal: number
): ProjectDataArchiveChunk {
  return {
    migrationId: MIGRATION_ID,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    sourceOwnerName: SOURCE_OWNER,
    targetOwnerName: TARGET_OWNER,
    targetGeneration: 1,
    tableName,
    ordinal,
    rows: [],
    rowIds: [],
    cursor: null,
    hasMore: false,
    rowCount: 0,
    byteCount: 2,
    sha256: `${tableName}:${ordinal}:sha`,
  };
}

function createFakeSource(options: FakeSourceOptions = {}) {
  let state = options.state ?? null;
  let token = options.token ?? 'old-token';
  let targetAggregateSha256: string | null =
    state === 'target_sealed' ||
    state === 'recovery_manifest_persisted' ||
    state === 'source_deleted'
      ? TARGET_SHA
      : null;
  let r2ManifestKey: string | null =
    state === 'recovery_manifest_persisted' || state === 'source_deleted' ? MANIFEST_KEY : null;
  const prepareTokens: string[] = [];
  const source = {
    ensureProjectId: vi.fn(async () => undefined),
    archiveSourceInspectIntent: vi.fn(async () => {
      if (!state) return { exists: false, databaseSizeBytes: 1000 };
      return {
        exists: true,
        state,
        sourceIntentToken: token,
        terminalVersionSha256: TERMINAL_SHA,
        targetAggregateSha256,
        r2ManifestKey,
        lastMessageAt: 1200,
        messageCount: 2,
        sourceDeletedAt: state === 'source_deleted' ? NOW : null,
        databaseSizeBeforeBytes: state === 'source_deleted' ? 1000 : null,
        databaseSizeAfterBytes: state === 'source_deleted' ? 500 : null,
        databaseSizeBytes: state === 'source_deleted' ? 500 : 1000,
      };
    }),
    archiveSourcePrepareIntent: vi.fn(async (input: { sourceIntentToken: string }) => {
      prepareTokens.push(input.sourceIntentToken);
      token = input.sourceIntentToken;
      if (!state) state = 'intent_prepared';
      return {
        idempotent: state !== 'intent_prepared',
        sourceIntentToken: token,
        terminalVersionSha256: TERMINAL_SHA,
        lastMessageAt: 1200,
        messageCount: 2,
        sessionRow: {
          id: SESSION_ID,
          topic: 'Terminal topic',
          status: 'stopped',
          message_count: 2,
          started_at: 1000,
          ended_at: 1200,
          created_at: 1000,
          updated_at: 1200,
        },
        databaseSizeBytes: 1000,
      };
    }),
    archiveSourceExportChunk: vi.fn(
      async (input: { tableName: ProjectDataArchiveTableName; ordinal: number }) =>
        makeChunk(input.tableName, input.ordinal)
    ),
    archiveSourceMarkTargetSealed: vi.fn(async () => {
      options.beforeTargetSealCas?.();
      state = 'target_sealed';
      targetAggregateSha256 = TARGET_SHA;
      return true;
    }),
    archiveSourceMarkRecoveryManifestPersisted: vi.fn(async () => {
      state = 'recovery_manifest_persisted';
      targetAggregateSha256 = TARGET_SHA;
      r2ManifestKey = MANIFEST_KEY;
      return true;
    }),
    archiveSourceFinalizeDelete: vi.fn(async () => {
      state = 'source_deleted';
      targetAggregateSha256 = TARGET_SHA;
      r2ManifestKey = MANIFEST_KEY;
      return {
        idempotent: false,
        lastMessageAt: 1200,
        messagesDeleted: 2,
        groupedRowsDeleted: 1,
        ftsRowsDeleted: 1,
        toolArchiveRowsDeleted: 0,
        databaseSizeBeforeBytes: 1000,
        databaseSizeAfterBytes: 500,
      };
    }),
    archiveSourceRestoreChunk: vi.fn(async () => ({
      idempotent: false,
      rowCount: 0,
      sha256: 'copy',
    })),
    archiveSourceMarkCopyBackRestored: vi.fn(async () => true),
    archiveSourceAbandonIntent: vi.fn(async () => {
      if (state === 'source_deleted') {
        throw new Error('abandon_requires_source_intact');
      }
      const previous = state;
      state = null;
      return { removed: previous !== null, state: previous, databaseSizeBytes: 1000 };
    }),
    prepareTokens,
    get state() {
      return state;
    },
  };
  return source;
}

function createFakeTarget() {
  const chunks: ProjectDataArchiveChunk[] = [];
  let state: 'prepared' | 'copying' | 'sealed' | 'rehome_exported' = 'prepared';
  const target = {
    ensureProjectId: vi.fn(async () => undefined),
    archiveTargetPrepare: vi.fn(async () => ({ idempotent: state !== 'prepared', state })),
    archiveTargetCommitChunk: vi.fn(async (chunk: ProjectDataArchiveChunk) => {
      state = 'copying';
      chunks.push(chunk);
      return {
        idempotent: false,
        tableName: chunk.tableName,
        rowCount: chunk.rowCount,
        sha256: chunk.sha256,
      };
    }),
    archiveTargetSeal: vi.fn(async () => {
      state = 'sealed';
      return { aggregateSha256: TARGET_SHA, messageCount: 2, groupedCount: 1, toolArchiveCount: 0 };
    }),
    archiveTargetInspectSession: vi.fn(async () => ({
      state,
      terminalVersionSha256: TERMINAL_SHA,
      aggregateSha256: TARGET_SHA,
      messageCount: 2,
      groupedCount: 1,
      toolArchiveCount: 0,
      chunks: chunks.map((chunk) => ({
        tableName: chunk.tableName,
        ordinal: chunk.ordinal,
        sha256: chunk.sha256,
        rowCount: chunk.rowCount,
        byteCount: chunk.byteCount,
      })),
      sessionRow: {
        id: SESSION_ID,
        topic: 'Terminal topic',
        status: 'stopped',
        message_count: 2,
        started_at: 1000,
        ended_at: 1200,
        created_at: 1000,
        updated_at: 1200,
      },
      databaseSizeBytes: 750,
    })),
    archiveTargetExportChunk: vi.fn(
      async (input: { tableName: ProjectDataArchiveTableName; ordinal: number }) =>
        makeChunk(input.tableName, input.ordinal)
    ),
    archiveTargetMarkRehomeExported: vi.fn(async () => {
      state = 'rehome_exported';
      return true;
    }),
    archiveTargetAbandonSession: vi.fn(async (input: { sourceIntactVerified?: boolean }) => {
      if (state === 'rehome_exported') throw new Error('target_not_abandonable');
      if (state === 'sealed' && input.sourceIntactVerified !== true) {
        throw new Error('target_sealed_requires_source_proof');
      }
      const removed = chunks.length > 0 || state !== 'prepared';
      const previous = state;
      const rowsDeleted = chunks.reduce((sum, chunk) => sum + chunk.rowCount, 0);
      chunks.length = 0;
      state = 'prepared';
      return {
        removed,
        state: removed ? previous : null,
        messagesDeleted: rowsDeleted,
        groupedRowsDeleted: 0,
        ftsRowsDeleted: 0,
        toolArchiveRowsDeleted: 0,
        chunksDeleted: removed ? 1 : 0,
        databaseSizeBytes: 750,
      };
    }),
  };
  return target;
}

function createProjectDataNamespace(stubs: Record<string, unknown>): DurableObjectNamespace {
  return {
    idFromName: (name: string) => name,
    get: (id: string) => {
      const stub = stubs[id];
      if (!stub) throw new Error(`Missing fake ProjectData stub ${id}`);
      return stub;
    },
  } as unknown as DurableObjectNamespace;
}

function seedMigration(
  sqlite: Database.Database,
  state: ProjectDataArchiveJournalState,
  opts: Partial<{
    migrationId: string;
    projectId: string;
    sessionId: string;
    sourceIntentToken: string | null;
    terminalVersionSha256: string | null;
    targetAggregateSha256: string | null;
    r2ManifestKey: string | null;
    leaseExpiresAt: number | null;
    attemptCount: number;
    updatedAt: number;
    locationState: 'migrating' | 'archive_shard' | 'frozen';
    locationPublishedAt: number | null;
  }> = {}
): string {
  const migrationId = opts.migrationId ?? MIGRATION_ID;
  const projectId = opts.projectId ?? PROJECT_ID;
  const sessionId = opts.sessionId ?? SESSION_ID;
  const updatedAt = opts.updatedAt ?? 1000;
  const locationState = opts.locationState ?? 'migrating';
  const locationPublishedAt = opts.locationPublishedAt ?? null;
  sqlite
    .prepare(
      `INSERT INTO project_data_archive_migrations
         (migration_id, project_id, session_id, state, source_owner_name,
          target_owner_name, target_generation, source_intent_token,
          terminal_version_sha256, target_aggregate_sha256, r2_manifest_key,
          lease_epoch, lease_expires_at, attempt_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0, ?, ?, 1000, ?)`
    )
    .run(
      migrationId,
      projectId,
      sessionId,
      state,
      projectId,
      TARGET_OWNER,
      opts.sourceIntentToken ?? (state === 'candidate' ? null : 'old-token'),
      opts.terminalVersionSha256 ??
        (state === 'candidate' || state === 'leased' ? null : TERMINAL_SHA),
      'targetAggregateSha256' in opts
        ? opts.targetAggregateSha256
        : ['target_sealed', 'recovery_manifest_persisted', 'source_deleted', 'published'].includes(
              state
            )
          ? TARGET_SHA
          : null,
      'r2ManifestKey' in opts
        ? opts.r2ManifestKey
        : ['recovery_manifest_persisted', 'source_deleted', 'published'].includes(state)
          ? MANIFEST_KEY
          : null,
      opts.leaseExpiresAt ?? (state === 'candidate' ? null : 1000),
      opts.attemptCount ?? 0,
      updatedAt
    );
  sqlite
    .prepare(
      `INSERT INTO project_data_session_locations
         (project_id, session_id, location_state, owner_kind, owner_name,
          generation, migration_id, source_owner_name, target_owner_name,
          target_aggregate_sha256, routing_schema_version, published_at, updated_at)
       VALUES (?, ?, ?, 'archive_shard', ?, 1, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(
      projectId,
      sessionId,
      locationState,
      TARGET_OWNER,
      migrationId,
      projectId,
      TARGET_OWNER,
      TARGET_SHA,
      locationPublishedAt,
      updatedAt
    );
  return migrationId;
}

function readMigrationRow(sqlite: Database.Database, migrationId = MIGRATION_ID) {
  return sqlite
    .prepare(
      `SELECT state, source_intent_token, terminal_version_sha256,
              target_aggregate_sha256, r2_manifest_key
       FROM project_data_archive_migrations
       WHERE migration_id = ?`
    )
    .get(migrationId) as Record<string, unknown>;
}

function readLocationRow(
  sqlite: Database.Database,
  sessionId = SESSION_ID,
  projectId = PROJECT_ID
) {
  return sqlite
    .prepare(
      `SELECT location_state, owner_kind, owner_name, generation, published_at
       FROM project_data_session_locations
       WHERE project_id = ? AND session_id = ?`
    )
    .get(projectId, sessionId) as Record<string, unknown>;
}

function seedSessionSummary(
  sqlite: Database.Database,
  input: {
    projectId?: string;
    sessionId?: string;
    status?: 'stopped' | 'failed' | 'active';
    endedAt?: number | null;
    updatedAt?: number;
    messageCount?: number;
  } = {}
): void {
  const projectId = input.projectId ?? PROJECT_ID;
  const sessionId = input.sessionId ?? SESSION_ID;
  const updatedAt = input.updatedAt ?? 1000;
  sqlite
    .prepare(
      `INSERT INTO session_summaries
         (id, project_id, user_id, status, topic, message_count, started_at, ended_at, updated_at)
       VALUES (?, ?, 'owner', ?, 'Terminal session', ?, 500, ?, ?)`
    )
    .run(
      sessionId,
      projectId,
      input.status ?? 'stopped',
      input.messageCount ?? 2,
      input.endedAt ?? 1000,
      updatedAt
    );
}

function countMigrations(sqlite: Database.Database): number {
  const row = sqlite
    .prepare('SELECT COUNT(*) AS count FROM project_data_archive_migrations')
    .get() as { count: number };
  return row.count;
}

function countLocations(sqlite: Database.Database): number {
  const row = sqlite
    .prepare('SELECT COUNT(*) AS count FROM project_data_session_locations')
    .get() as { count: number };
  return row.count;
}

function readCadenceRow(sqlite: Database.Database) {
  return sqlite
    .prepare(
      `SELECT sweep_name, last_started_at, last_completed_at, next_eligible_at,
              last_status, lease_owner, lease_expires_at, run_count
       FROM project_data_archive_global_sweep_cadence
       WHERE sweep_name = 'archive_sharding_global_sweep'`
    )
    .get() as
    | {
        sweep_name: string;
        last_started_at: number | null;
        last_completed_at: number | null;
        next_eligible_at: number;
        last_status: string;
        lease_owner: string | null;
        lease_expires_at: number | null;
        run_count: number;
      }
    | undefined;
}

describe('scheduled ProjectData archive sharding coordinator', () => {
  it('is production-disabled by default', async () => {
    const sqlite = new Database(':memory:');
    try {
      await expect(runProjectDataArchiveSharding(makeEnv(sqlite))).resolves.toMatchObject({
        enabled: false,
        skipped: true,
        skipReason: 'disabled',
        migrated: 0,
      });
    } finally {
      sqlite.close();
    }
  });

  it('fails closed when enabled without the private archive R2 binding', async () => {
    const sqlite = new Database(':memory:');
    try {
      await expect(
        runProjectDataArchiveSharding(
          makeEnv(sqlite, {
            PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
            PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
          })
        )
      ).resolves.toMatchObject({
        enabled: true,
        skipped: true,
        skipReason: 'missing_r2_binding',
        migrated: 0,
      });
    } finally {
      sqlite.close();
    }
  });

  it('does not run the global cron when exact routing is enabled alone', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedSessionSummary(sqlite, { sessionId: 'session-target', updatedAt: 1000 });

      await expect(
        runProjectDataArchiveSharding(
          makeEnv(sqlite, {
            PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
            PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
          }),
          new Date(NOW)
        )
      ).resolves.toMatchObject({
        enabled: false,
        skipped: true,
        skipReason: 'disabled',
        selected: 0,
        migrated: 0,
      });
      expect(countMigrations(sqlite)).toBe(0);
      expect(countLocations(sqlite)).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it('fails the global cron closed when the global gate is enabled without exact routing', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedSessionSummary(sqlite, { sessionId: 'session-target', updatedAt: 1000 });

      await expect(
        runProjectDataArchiveSharding(
          makeEnv(sqlite, {
            PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
            PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
          }),
          new Date(NOW)
        )
      ).resolves.toMatchObject({
        enabled: true,
        skipped: true,
        skipReason: 'exact_routing_disabled',
        selected: 0,
        migrated: 0,
      });
      expect(countMigrations(sqlite)).toBe(0);
      expect(countLocations(sqlite)).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it('dry-runs one explicitly scoped session without global cron enabled or source-side effects', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedSessionSummary(sqlite, { sessionId: 'session-target', updatedAt: 1000 });
      seedSessionSummary(sqlite, { sessionId: 'session-other', updatedAt: 900 });
      seedSessionSummary(sqlite, {
        projectId: 'project-other',
        sessionId: 'session-target-other-project',
        updatedAt: 800,
      });
      const projectDataGet = vi.fn();
      const r2Put = vi.fn();

      const result = await runScopedProjectDataArchiveCanary(
        makeEnv(sqlite, {
          PROJECT_DATA_ARCHIVE_MANUAL_CANARY_MAX_SESSIONS: '5',
          PROJECT_DATA: {
            idFromName: (name: string) => name,
            get: projectDataGet,
          } as unknown as DurableObjectNamespace,
          PROJECT_DATA_ARCHIVE_R2: { put: r2Put } as unknown as R2Bucket,
        }),
        {
          projectId: PROJECT_ID,
          sessionId: 'session-target',
          dryRun: true,
          limit: 5,
          nowDate: new Date(NOW),
        }
      );

      expect(result).toMatchObject({
        dryRun: true,
        globalCronEnabled: false,
        scope: { projectId: PROJECT_ID, sessionId: 'session-target' },
        stats: { enabled: false, skipped: false, selected: 1, migrated: 0 },
        selected: [
          {
            projectId: PROJECT_ID,
            sessionId: 'session-target',
            migrationId: null,
            state: 'eligible_session',
            source: 'eligible_session',
          },
        ],
      });
      expect(countMigrations(sqlite)).toBe(0);
      expect(projectDataGet).not.toHaveBeenCalled();
      expect(r2Put).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it('runs a non-dry scoped canary only for the requested project/session', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'candidate', {
        migrationId: 'migration-target',
        sessionId: SESSION_ID,
      });
      seedMigration(sqlite, 'candidate', {
        migrationId: 'migration-other-session',
        sessionId: 'session-other',
      });
      seedMigration(sqlite, 'candidate', {
        migrationId: 'migration-other-project',
        projectId: 'project-other',
        sessionId: SESSION_ID,
      });
      const source = createFakeSource();
      const target = createFakeTarget();

      const result = await runScopedProjectDataArchiveCanary(
        makeEnv(sqlite, {
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
          PROJECT_DATA: createProjectDataNamespace({
            [SOURCE_OWNER]: source,
            [TARGET_OWNER]: target,
          }),
        }),
        {
          projectId: PROJECT_ID,
          sessionId: SESSION_ID,
          dryRun: false,
          reason: 'operator scoped canary',
          limit: 5,
          nowDate: new Date(NOW),
        }
      );

      expect(result).toMatchObject({
        dryRun: false,
        globalCronEnabled: false,
        stats: { enabled: false, skipped: false, selected: 1, migrated: 1 },
        selected: [
          {
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            migrationId: 'migration-target',
            source: 'existing_migration',
          },
        ],
      });
      expect(readMigrationRow(sqlite, 'migration-target')).toMatchObject({ state: 'published' });
      expect(readMigrationRow(sqlite, 'migration-other-session')).toMatchObject({
        state: 'candidate',
      });
      expect(readMigrationRow(sqlite, 'migration-other-project')).toMatchObject({
        state: 'candidate',
      });
    } finally {
      sqlite.close();
    }
  });

  it('refuses a non-dry scoped canary when exact archive routing is disabled', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'candidate', {
        migrationId: 'migration-target',
        sessionId: SESSION_ID,
      });
      const source = createFakeSource();
      const target = createFakeTarget();

      const result = await runScopedProjectDataArchiveCanary(
        makeEnv(sqlite, {
          PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
          PROJECT_DATA: createProjectDataNamespace({
            [SOURCE_OWNER]: source,
            [TARGET_OWNER]: target,
          }),
        }),
        {
          projectId: PROJECT_ID,
          sessionId: SESSION_ID,
          dryRun: false,
          reason: 'operator scoped canary',
          limit: 1,
          nowDate: new Date(NOW),
        }
      );

      expect(result).toMatchObject({
        dryRun: false,
        globalCronEnabled: false,
        selected: [],
        stats: {
          skipped: true,
          skipReason: 'exact_routing_disabled',
          selected: 0,
          migrated: 0,
          recoveredCrashGaps: 0,
        },
      });
      expect(readMigrationRow(sqlite, 'migration-target')).toMatchObject({ state: 'candidate' });
      expect(readLocationRow(sqlite)).toMatchObject({ location_state: 'migrating' });
      expect(source.archiveSourcePrepareIntent).not.toHaveBeenCalled();
      expect(source.archiveSourceFinalizeDelete).not.toHaveBeenCalled();
      expect(target.archiveTargetPrepare).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it('fails closed without R2 before a non-dry scoped canary can create D1 journal rows', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedSessionSummary(sqlite, { sessionId: 'session-target', updatedAt: 1000 });

      const result = await runScopedProjectDataArchiveCanary(
        makeEnv(sqlite, {
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        }),
        {
          projectId: PROJECT_ID,
          sessionId: 'session-target',
          dryRun: false,
          reason: 'operator scoped canary',
          limit: 1,
          nowDate: new Date(NOW),
        }
      );

      expect(result).toMatchObject({
        dryRun: false,
        reason: 'operator scoped canary',
        globalCronEnabled: false,
        selected: [],
        stats: {
          skipped: true,
          skipReason: 'missing_r2_binding',
          selected: 0,
          migrated: 0,
        },
      });
      expect(countMigrations(sqlite)).toBe(0);
      expect(countLocations(sqlite)).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it('scopes manual canary crash-gap recovery to the requested project/session', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'source_deleted', {
        migrationId: 'migration-target-gap',
        sessionId: SESSION_ID,
      });
      seedMigration(sqlite, 'source_deleted', {
        migrationId: 'migration-other-session-gap',
        sessionId: 'session-other',
      });
      seedMigration(sqlite, 'source_deleted', {
        migrationId: 'migration-other-project-gap',
        projectId: 'project-other',
        sessionId: SESSION_ID,
      });

      const result = await runScopedProjectDataArchiveCanary(
        makeEnv(sqlite, {
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
        }),
        {
          projectId: PROJECT_ID,
          sessionId: SESSION_ID,
          dryRun: false,
          reason: 'operator scoped crash-gap recovery',
          limit: 5,
          nowDate: new Date(NOW),
        }
      );

      expect(result).toMatchObject({
        dryRun: false,
        reason: 'operator scoped crash-gap recovery',
        globalCronEnabled: false,
        stats: { recoveredCrashGaps: 1, selected: 0, migrated: 0 },
      });
      expect(readMigrationRow(sqlite, 'migration-target-gap')).toMatchObject({
        state: 'published',
      });
      expect(readLocationRow(sqlite, SESSION_ID)).toMatchObject({
        location_state: 'archive_shard',
        published_at: NOW,
      });
      expect(readMigrationRow(sqlite, 'migration-other-session-gap')).toMatchObject({
        state: 'source_deleted',
      });
      expect(readLocationRow(sqlite, 'session-other')).toMatchObject({
        location_state: 'migrating',
        published_at: null,
      });
      expect(readMigrationRow(sqlite, 'migration-other-project-gap')).toMatchObject({
        state: 'source_deleted',
      });
      expect(readLocationRow(sqlite, SESSION_ID, 'project-other')).toMatchObject({
        location_state: 'migrating',
        published_at: null,
      });
    } finally {
      sqlite.close();
    }
  });

  it('recovers a source_deleted crash gap by publishing the D1 location exactly once', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'source_deleted', { migrationId: 'migration-crash-gap' });

      const stats = await runProjectDataArchiveSharding(
        makeEnv(sqlite, {
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
        }),
        new Date(NOW)
      );

      expect(stats).toMatchObject({
        enabled: true,
        skipped: false,
        recoveredCrashGaps: 1,
        migrated: 0,
        failed: 0,
      });
      expect(readLocationRow(sqlite)).toMatchObject({
        location_state: 'archive_shard',
        owner_kind: 'archive_shard',
        owner_name: TARGET_OWNER,
        generation: 1,
        published_at: NOW,
      });
      expect(readMigrationRow(sqlite, 'migration-crash-gap')).toMatchObject({
        state: 'published',
      });
    } finally {
      sqlite.close();
    }
  });

  it('gates five-minute scheduled archive-sharding invocations behind the persisted daily cadence', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'source_deleted', { migrationId: 'migration-daily-gate-gap' });
      const env = makeEnv(sqlite, {
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
      });

      const first = await runProjectDataArchiveSharding(env, new Date(NOW));
      expect(first).toMatchObject({
        skipped: false,
        recoveredCrashGaps: 1,
        cadence: {
          claimed: true,
          intervalMs: 86_400_000,
          nextEligibleAt: NOW + 86_400_000,
          lastStatus: 'succeeded',
          runCount: 1,
        },
      });
      expect(readCadenceRow(sqlite)).toMatchObject({
        last_started_at: NOW,
        next_eligible_at: NOW + 86_400_000,
        last_status: 'succeeded',
        lease_owner: null,
        lease_expires_at: null,
        run_count: 1,
      });

      const second = await runProjectDataArchiveSharding(env, new Date(NOW + 5 * 60 * 1000));
      expect(second).toMatchObject({
        skipped: true,
        skipReason: 'cadence_not_due',
        selected: 0,
        migrated: 0,
        recoveredCrashGaps: 0,
        cadence: {
          claimed: false,
          nextEligibleAt: NOW + 86_400_000,
          remainingMs: 86_100_000,
          lastStatus: 'succeeded',
          runCount: 1,
        },
      });
      expect(readCadenceRow(sqlite)?.run_count).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it('lets scoped manual dry-run canaries bypass the global cadence gate', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'source_deleted', { migrationId: 'migration-cadence-primer' });
      const projectDataGet = vi.fn();
      const env = makeEnv(sqlite, {
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
        PROJECT_DATA: {
          idFromName: (name: string) => name,
          get: projectDataGet,
        } as unknown as DurableObjectNamespace,
        PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
      });

      await runProjectDataArchiveSharding(env, new Date(NOW));
      const skipped = await runProjectDataArchiveSharding(env, new Date(NOW + 5 * 60 * 1000));
      expect(skipped.skipReason).toBe('cadence_not_due');
      seedSessionSummary(sqlite, { sessionId: 'session-manual-bypass', updatedAt: 2000 });

      const manualDryRun = await runScopedProjectDataArchiveCanary(env, {
        projectId: PROJECT_ID,
        sessionId: 'session-manual-bypass',
        dryRun: true,
        limit: 1,
        nowDate: new Date(NOW + 5 * 60 * 1000),
      });

      expect(manualDryRun).toMatchObject({
        dryRun: true,
        globalCronEnabled: true,
        stats: {
          skipped: false,
          selected: 1,
          migrated: 0,
        },
        selected: [
          {
            projectId: PROJECT_ID,
            sessionId: 'session-manual-bypass',
            source: 'eligible_session',
          },
        ],
      });
      expect(projectDataGet).not.toHaveBeenCalled();
      expect(readCadenceRow(sqlite)?.run_count).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it('advances cadence on partial scheduled runs but retries recoverable work after the interval', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'candidate', { migrationId: 'migration-partial-cadence' });
      const env = makeEnv(sqlite, {
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
      });

      const first = await runProjectDataArchiveSharding(env, new Date(NOW));
      expect(first).toMatchObject({
        skipped: false,
        selected: 1,
        failed: 1,
        cadence: {
          lastStatus: 'partial',
          nextEligibleAt: NOW + 86_400_000,
          runCount: 1,
        },
      });
      expect(readMigrationRow(sqlite, 'migration-partial-cadence')).toMatchObject({
        state: 'failed',
      });

      const immediateRetry = await runProjectDataArchiveSharding(
        env,
        new Date(NOW + 5 * 60 * 1000)
      );
      expect(immediateRetry).toMatchObject({
        skipped: true,
        skipReason: 'cadence_not_due',
        selected: 0,
        failed: 0,
        cadence: {
          lastStatus: 'partial',
          runCount: 1,
        },
      });

      const nextDailyRun = await runProjectDataArchiveSharding(env, new Date(NOW + 86_400_000 + 1));
      expect(nextDailyRun).toMatchObject({
        skipped: false,
        selected: 1,
        failed: 1,
        cadence: {
          lastStatus: 'partial',
          nextEligibleAt: NOW + 2 * 86_400_000 + 1,
          runCount: 2,
        },
      });
      expect(readCadenceRow(sqlite)).toMatchObject({
        last_started_at: NOW + 86_400_000 + 1,
        run_count: 2,
        last_status: 'partial',
      });
    } finally {
      sqlite.close();
    }
  });

  it('does not let an older verified-published row starve a later source_deleted crash gap with a sweep size of one', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'published', {
        migrationId: 'migration-already-published',
        sessionId: 'session-already-published',
        updatedAt: 1000,
        locationState: 'archive_shard',
        locationPublishedAt: 1000,
      });
      seedMigration(sqlite, 'source_deleted', {
        migrationId: 'migration-later-crash-gap',
        sessionId: 'session-later-crash-gap',
        updatedAt: 2000,
      });

      const stats = await runProjectDataArchiveSharding(
        makeEnv(sqlite, {
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '1',
          PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
        }),
        new Date(NOW)
      );

      expect(stats).toMatchObject({
        enabled: true,
        skipped: false,
        recoveredCrashGaps: 1,
        failed: 0,
      });
      expect(readMigrationRow(sqlite, 'migration-already-published')).toMatchObject({
        state: 'published',
      });
      expect(readLocationRow(sqlite, 'session-already-published')).toMatchObject({
        location_state: 'archive_shard',
        published_at: 1000,
      });
      expect(readMigrationRow(sqlite, 'migration-later-crash-gap')).toMatchObject({
        state: 'published',
      });
      expect(readLocationRow(sqlite, 'session-later-crash-gap')).toMatchObject({
        location_state: 'archive_shard',
        owner_kind: 'archive_shard',
        owner_name: TARGET_OWNER,
        published_at: NOW,
      });
    } finally {
      sqlite.close();
    }
  });

  it('isolates crash-gap publish failures so a transient D1 error cannot block a later published-location gap', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'published', {
        migrationId: 'migration-transient-publish-failure',
        sessionId: 'session-transient-publish-failure',
        updatedAt: 1000,
      });
      seedMigration(sqlite, 'published', {
        migrationId: 'migration-recoverable-after-bad-row',
        sessionId: 'session-recoverable-after-bad-row',
        updatedAt: 2000,
      });

      const stats = await runProjectDataArchiveSharding(
        {
          ...makeEnv(sqlite, {
            PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
            PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
            PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '2',
            PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
          }),
          DATABASE: createD1WithOnePublishFailure(sqlite, 'session-transient-publish-failure'),
        },
        new Date(NOW)
      );

      expect(stats).toMatchObject({
        enabled: true,
        skipped: false,
        recoveredCrashGaps: 1,
        failed: 1,
      });
      expect(readMigrationRow(sqlite, 'migration-transient-publish-failure')).toMatchObject({
        state: 'published',
      });
      expect(readLocationRow(sqlite, 'session-transient-publish-failure')).toMatchObject({
        location_state: 'migrating',
        published_at: null,
      });
      expect(readMigrationRow(sqlite, 'migration-recoverable-after-bad-row')).toMatchObject({
        state: 'published',
      });
      expect(readLocationRow(sqlite, 'session-recoverable-after-bad-row')).toMatchObject({
        location_state: 'archive_shard',
        published_at: NOW,
      });
    } finally {
      sqlite.close();
    }
  });

  it('skips non-actionable published rows before a sweep limit of one so later published-location gaps recover', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'published', {
        migrationId: 'migration-missing-location',
        sessionId: 'session-missing-location',
        updatedAt: 1000,
      });
      sqlite
        .prepare(
          `DELETE FROM project_data_session_locations
           WHERE project_id = ? AND session_id = ?`
        )
        .run(PROJECT_ID, 'session-missing-location');
      seedMigration(sqlite, 'published', {
        migrationId: 'migration-missing-hash',
        sessionId: 'session-missing-hash',
        targetAggregateSha256: null,
        updatedAt: 2000,
      });
      seedMigration(sqlite, 'published', {
        migrationId: 'migration-empty-hash',
        sessionId: 'session-empty-hash',
        targetAggregateSha256: '',
        updatedAt: 3000,
      });
      seedMigration(sqlite, 'published', {
        migrationId: 'migration-later-published-gap',
        sessionId: 'session-later-published-gap',
        updatedAt: 4000,
      });

      const stats = await runProjectDataArchiveSharding(
        makeEnv(sqlite, {
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '1',
          PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
        }),
        new Date(NOW)
      );

      expect(stats).toMatchObject({
        enabled: true,
        skipped: false,
        recoveredCrashGaps: 1,
        failed: 0,
      });
      expect(readMigrationRow(sqlite, 'migration-missing-location')).toMatchObject({
        state: 'published',
      });
      expect(readMigrationRow(sqlite, 'migration-missing-hash')).toMatchObject({
        state: 'published',
        target_aggregate_sha256: null,
      });
      expect(readMigrationRow(sqlite, 'migration-empty-hash')).toMatchObject({
        state: 'published',
        target_aggregate_sha256: '',
      });
      expect(readMigrationRow(sqlite, 'migration-later-published-gap')).toMatchObject({
        state: 'published',
      });
      expect(readLocationRow(sqlite, 'session-later-published-gap')).toMatchObject({
        location_state: 'archive_shard',
        published_at: NOW,
      });
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ['candidate', null],
    ['leased', 'intent_prepared'],
    ['intent_prepared', 'intent_prepared'],
    ['target_prepared', 'intent_prepared'],
    ['copying', 'intent_prepared'],
    ['target_sealed', 'target_sealed'],
    ['recovery_manifest_persisted', 'recovery_manifest_persisted'],
    ['failed', 'recovery_manifest_persisted'],
  ] satisfies Array<[ProjectDataArchiveJournalState, SourceState]>)(
    'resumes and publishes an expired %s migration',
    async (journalState, sourceState) => {
      const sqlite = new Database(':memory:');
      try {
        createCoordinatorTables(sqlite);
        const source = createFakeSource({ state: sourceState, token: 'old-token' });
        const target = createFakeTarget();
        seedMigration(sqlite, journalState, {
          sourceIntentToken: journalState === 'candidate' ? null : 'old-token',
          attemptCount: journalState === 'failed' ? 1 : 0,
        });

        const stats = await runProjectDataArchiveSharding(
          makeEnv(sqlite, {
            PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
            PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
            PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
            PROJECT_DATA: createProjectDataNamespace({
              [SOURCE_OWNER]: source,
              [TARGET_OWNER]: target,
            }),
          }),
          new Date(NOW)
        );

        expect(stats.failed).toBe(0);
        expect(stats.migrated).toBe(1);
        expect(readMigrationRow(sqlite)).toMatchObject({
          state: 'published',
          terminal_version_sha256: TERMINAL_SHA,
          target_aggregate_sha256: TARGET_SHA,
          r2_manifest_key: expect.stringContaining(
            'project-data/session-archives/project-archive/session-archived/'
          ),
        });
        expect(readLocationRow(sqlite)).toMatchObject({
          location_state: 'archive_shard',
          owner_kind: 'archive_shard',
          owner_name: TARGET_OWNER,
          published_at: NOW,
        });
        if (journalState === 'failed') {
          expect(source.prepareTokens.at(-1)).not.toBe('old-token');
        }
      } finally {
        sqlite.close();
      }
    }
  );

  it.each(['frozen', 'poisoned'] as const)(
    'checks the copying -> target_sealed CAS and does not finalize after a %s interleave',
    async (blockedState) => {
      const sqlite = new Database(':memory:');
      try {
        createCoordinatorTables(sqlite);
        seedMigration(sqlite, 'copying', { attemptCount: 1 });
        const source = createFakeSource({
          state: 'intent_prepared',
          beforeTargetSealCas: () => {
            sqlite
              .prepare(
                `UPDATE project_data_archive_migrations
                 SET state = ?, lease_owner = NULL, lease_expires_at = NULL
                 WHERE migration_id = ?`
              )
              .run(blockedState, MIGRATION_ID);
          },
        });
        const target = createFakeTarget();

        const stats = await runProjectDataArchiveSharding(
          makeEnv(sqlite, {
            PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
            PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
            PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
            PROJECT_DATA: createProjectDataNamespace({
              [SOURCE_OWNER]: source,
              [TARGET_OWNER]: target,
            }),
          }),
          new Date(NOW)
        );

        expect(stats.migrated).toBe(0);
        expect(source.archiveSourceFinalizeDelete).not.toHaveBeenCalled();
        expect(readMigrationRow(sqlite)).toMatchObject({ state: blockedState });
        expect(readLocationRow(sqlite)).toMatchObject({ location_state: 'migrating' });
      } finally {
        sqlite.close();
      }
    }
  );

  it('implements freeze, poison, frozen-intent inspection, and copy-back controls', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      const frozenMigrationId = seedMigration(sqlite, 'copying', {
        migrationId: 'migration-freeze',
        sessionId: 'session-freeze',
      });
      await freezeProjectDataArchiveMigration(makeEnv(sqlite), {
        migrationId: frozenMigrationId,
        projectId: PROJECT_ID,
        reason: 'operator hold',
        now: NOW,
      });
      expect(readMigrationRow(sqlite, frozenMigrationId)).toMatchObject({ state: 'frozen' });
      expect(
        sqlite
          .prepare(
            `SELECT state, reason FROM project_data_archive_circuit_breakers WHERE project_id = ?`
          )
          .get(PROJECT_ID)
      ).toEqual({ state: 'frozen', reason: 'operator hold' });

      const poisonedMigrationId = seedMigration(sqlite, 'failed', {
        migrationId: 'migration-poison',
        sessionId: 'session-poison',
        attemptCount: 3,
      });
      await poisonProjectDataArchiveMigration(makeEnv(sqlite), {
        migrationId: poisonedMigrationId,
        projectId: PROJECT_ID,
        reason: 'operator poison',
        now: NOW,
      });
      expect(readMigrationRow(sqlite, poisonedMigrationId)).toMatchObject({ state: 'poisoned' });

      const copyBackMigrationId = seedMigration(sqlite, 'published', {
        migrationId: 'migration-copy-back',
        sessionId: SESSION_ID,
      });
      const source = createFakeSource({ state: 'source_deleted', token: 'old-token' });
      const target = createFakeTarget();
      const controlEnv = makeEnv(sqlite, {
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA: createProjectDataNamespace({
          [SOURCE_OWNER]: source,
          [TARGET_OWNER]: target,
        }),
      });

      const inspectionResult = await inspectFrozenProjectDataArchiveIntents(controlEnv, {
        projectId: PROJECT_ID,
      });
      expect(inspectionResult.warnings).toEqual([]);
      const { inspections } = inspectionResult;
      expect(inspections.map((inspection) => inspection.migrationId)).toEqual([
        'migration-freeze',
        'migration-poison',
      ]);

      const copyBack = await copyBackProjectDataArchiveMigration(controlEnv, {
        migrationId: copyBackMigrationId,
        projectId: PROJECT_ID,
        reason: 'operator copy-back',
        now: NOW,
      });
      expect(copyBack).toMatchObject({
        migrationId: copyBackMigrationId,
        reason: 'operator copy-back',
        restoredToRoot: true,
      });
      expect(source.archiveSourceRestoreChunk).toHaveBeenCalled();
      expect(target.archiveTargetMarkRehomeExported).toHaveBeenCalled();
      expect(readLocationRow(sqlite)).toMatchObject({
        location_state: 'root',
        owner_kind: 'root',
        owner_name: SOURCE_OWNER,
        generation: 0,
      });
    } finally {
      sqlite.close();
    }
  });

  it('bounds frozen-intent detail inspection fan-out against ProjectData DOs', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      for (let index = 0; index < 12; index++) {
        seedMigration(sqlite, 'failed', {
          migrationId: `migration-frozen-${index}`,
          sessionId: `session-frozen-${index}`,
          updatedAt: 1000 + index,
        });
      }
      const source = createFakeSource({ state: 'source_deleted' });
      const target = createFakeTarget();

      const inspectionResult = await inspectFrozenProjectDataArchiveIntents(
        makeEnv(sqlite, {
          PROJECT_DATA_ARCHIVE_FROZEN_INTENT_INSPECTION_LIMIT_MAX: '500',
          PROJECT_DATA: createProjectDataNamespace({
            [SOURCE_OWNER]: source,
            [TARGET_OWNER]: target,
          }),
        }),
        {
          projectId: PROJECT_ID,
          limit: 500,
        }
      );

      expect(inspectionResult.warnings).toEqual([]);
      const { inspections } = inspectionResult;
      expect(inspections).toHaveLength(10);
      expect(source.archiveSourceInspectIntent).toHaveBeenCalledTimes(10);
      expect(target.archiveTargetInspectSession).toHaveBeenCalledTimes(10);
      expect(inspections.map((inspection) => inspection.migrationId)).toEqual(
        Array.from({ length: 10 }, (_unused, index) => `migration-frozen-${index}`)
      );
    } finally {
      sqlite.close();
    }
  });

  it('isolates malformed frozen-intent rows without aborting inspection', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'failed', {
        migrationId: 'migration-good',
        sessionId: 'session-good',
        updatedAt: 1000,
      });
      sqlite
        .prepare(
          `INSERT INTO project_data_archive_migrations
             (migration_id, project_id, session_id, state, source_owner_name,
              target_owner_name, target_generation, lease_epoch, attempt_count,
              error_code, error_message, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, 0, 1, 'test_error', 'test message', 900, 1100)`
        )
        .run('migration-bad', PROJECT_ID, 'session-bad', 'failed', '', TARGET_OWNER);
      const source = createFakeSource({ state: 'source_deleted' });
      const target = createFakeTarget();

      const result = await inspectFrozenProjectDataArchiveIntents(
        makeEnv(sqlite, {
          PROJECT_DATA: createProjectDataNamespace({
            [SOURCE_OWNER]: source,
            [TARGET_OWNER]: target,
          }),
        }),
        { projectId: PROJECT_ID, limit: 10 }
      );

      expect(result.inspections.map((inspection) => inspection.migrationId)).toEqual([
        'migration-good',
      ]);
      expect(result.warnings).toEqual([
        {
          surface: 'frozen_intents',
          skippedRows: 1,
          examples: [
            {
              rowIndex: 1,
              reason: 'Invalid ProjectData archive frozen-intent row: source_owner_name',
            },
          ],
        },
      ]);
      expect(source.archiveSourceInspectIntent).toHaveBeenCalledTimes(1);
      expect(target.archiveTargetInspectSession).toHaveBeenCalledTimes(1);
    } finally {
      sqlite.close();
    }
  });

  it('rejects copy-back when the migration belongs to a different project', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      const migrationId = seedMigration(sqlite, 'published', {
        migrationId: 'migration-copy-back-other-project',
        projectId: 'project-other',
      });

      await expect(
        copyBackProjectDataArchiveMigration(
          makeEnv(sqlite, { PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true' }),
          {
            migrationId,
            projectId: PROJECT_ID,
            reason: 'operator copy-back',
            now: NOW,
          }
        )
      ).rejects.toMatchObject({
        reason: 'migration_project_mismatch',
      });
    } finally {
      sqlite.close();
    }
  });
});

describe('archive-sharding candidate selection is size-ordered and budgeted', () => {
  function seedSized(sqlite: Database.Database): void {
    seedSessionSummary(sqlite, { sessionId: 'session-small', messageCount: 100, updatedAt: 1000 });
    seedSessionSummary(sqlite, { sessionId: 'session-medium', messageCount: 200, updatedAt: 2000 });
    seedSessionSummary(sqlite, { sessionId: 'session-large', messageCount: 300, updatedAt: 3000 });
  }

  async function dryRunSelection(
    sqlite: Database.Database,
    overrides: Partial<Env>
  ): Promise<string[]> {
    const result = await runScopedProjectDataArchiveCanary(makeEnv(sqlite, overrides), {
      projectId: PROJECT_ID,
      dryRun: true,
      limit: 5,
      nowDate: new Date(NOW),
    });
    expect(countMigrations(sqlite)).toBe(0);
    return result.selected.map((candidate) => candidate.sessionId);
  }

  it('picks the largest eligible session first even when a smaller one is older', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedSized(sqlite);
      expect(
        await dryRunSelection(sqlite, { PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET: '5000' })
      ).toEqual(['session-large', 'session-medium', 'session-small']);
    } finally {
      sqlite.close();
    }
  });

  it('breaks equal message counts deterministically by oldest update, then id', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedSessionSummary(sqlite, { sessionId: 'session-b', messageCount: 200, updatedAt: 2000 });
      seedSessionSummary(sqlite, { sessionId: 'session-a', messageCount: 200, updatedAt: 2000 });
      seedSessionSummary(sqlite, { sessionId: 'session-c', messageCount: 200, updatedAt: 1000 });
      seedSessionSummary(sqlite, { sessionId: 'session-d', messageCount: 300, updatedAt: 9000 });
      const first = await dryRunSelection(sqlite, {
        PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET: '5000',
      });
      expect(first).toEqual(['session-d', 'session-c', 'session-a', 'session-b']);
      // Identical repeated calls return an identical sequence (rule 65 determinism).
      expect(
        await dryRunSelection(sqlite, { PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET: '5000' })
      ).toEqual(first);
    } finally {
      sqlite.close();
    }
  });

  it('stops selecting once the cumulative message budget is spent', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedSized(sqlite);
      // 300 fits; 300 + 200 = 500 exceeds 450, so the medium and small sessions wait.
      expect(
        await dryRunSelection(sqlite, { PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET: '450' })
      ).toEqual(['session-large']);
      // 300 + 200 = 500 fits exactly; adding 100 would exceed it.
      expect(
        await dryRunSelection(sqlite, { PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET: '500' })
      ).toEqual(['session-large', 'session-medium']);
    } finally {
      sqlite.close();
    }
  });

  it('still selects a single session larger than the whole budget so it cannot starve', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedSized(sqlite);
      expect(
        await dryRunSelection(sqlite, { PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET: '1' })
      ).toEqual(['session-large']);
    } finally {
      sqlite.close();
    }
  });

  it('journals only the budgeted prefix on a non-dry run and leaves the rest unfenced', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedSized(sqlite);
      const stubs: Record<string, unknown> = {};
      const source = createFakeSource();
      stubs[SOURCE_OWNER] = source;
      // Every shard owner name resolves to one fake target; the fake ignores identity.
      const namespace = {
        idFromName: (name: string) => name,
        get: (id: string) => stubs[id] ?? createFakeTarget(),
      } as unknown as DurableObjectNamespace;
      const result = await runScopedProjectDataArchiveCanary(
        makeEnv(sqlite, {
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET: '450',
          PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
          PROJECT_DATA: namespace,
        }),
        {
          projectId: PROJECT_ID,
          dryRun: false,
          reason: 'budgeted canary',
          limit: 5,
          nowDate: new Date(NOW),
        }
      );
      expect(result.selected.map((candidate) => candidate.sessionId)).toEqual(['session-large']);
      expect(countMigrations(sqlite)).toBe(1);
      expect(readLocationRow(sqlite, 'session-medium')).toBeUndefined();
      expect(readLocationRow(sqlite, 'session-small')).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });
});

describe('archive-sharding fences a session only when it is about to process it', () => {
  it('leaves sessions it never reached unfenced when wall time runs out mid-tick', async () => {
    // Three eligible small sessions, a ten-session ceiling, and a wall-time budget the first
    // migration exhausts. Journaling all three up front would fence two sessions `migrating`
    // for the whole next cadence interval; only the processed one may be journaled.
    const sqlite = new Database(':memory:');
    const realNow = Date.now;
    let clock = realNow();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      createCoordinatorTables(sqlite);
      seedSessionSummary(sqlite, { sessionId: 'session-a', messageCount: 30, updatedAt: 1000 });
      seedSessionSummary(sqlite, { sessionId: 'session-b', messageCount: 20, updatedAt: 2000 });
      seedSessionSummary(sqlite, { sessionId: 'session-c', messageCount: 10, updatedAt: 3000 });
      const source = createFakeSource();
      const prepare = source.archiveSourcePrepareIntent.getMockImplementation()!;
      source.archiveSourcePrepareIntent.mockImplementation(async (input) => {
        clock += 10_000; // one migration costs more than the whole wall-time budget
        return prepare(input);
      });
      const stubs: Record<string, unknown> = { [SOURCE_OWNER]: source };
      const namespace = {
        idFromName: (name: string) => name,
        get: (id: string) => stubs[id] ?? createFakeTarget(),
      } as unknown as DurableObjectNamespace;
      const result = await runScopedProjectDataArchiveCanary(
        makeEnv(sqlite, {
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '10',
          PROJECT_DATA_ARCHIVE_WALL_TIME_MS: '5000',
          PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
          PROJECT_DATA: namespace,
        }),
        {
          projectId: PROJECT_ID,
          dryRun: false,
          reason: 'wall time canary',
          limit: 10,
          nowDate: new Date(NOW),
        }
      );
      expect(result.stats.selected).toBe(3);
      // Liveness: the first (largest) session really was journaled and worked on.
      expect(source.archiveSourcePrepareIntent).toHaveBeenCalledTimes(1);
      expect(countMigrations(sqlite)).toBe(1);
      expect(readLocationRow(sqlite, 'session-a')).toBeDefined();
      expect(result.selected.map((item) => [item.sessionId, item.migrationId !== null])).toEqual([
        ['session-a', true],
        ['session-b', false],
        ['session-c', false],
      ]);
      expect(readLocationRow(sqlite, 'session-b')).toBeUndefined();
      expect(readLocationRow(sqlite, 'session-c')).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
      sqlite.close();
    }
  });
});

describe('archive-sharding abandon control', () => {
  function readJournal(sqlite: Database.Database, migrationId: string) {
    return sqlite
      .prepare(
        `SELECT state, error_code, error_message, lease_owner, lease_expires_at, frozen_at
         FROM project_data_archive_migrations
         WHERE migration_id = ?`
      )
      .get(migrationId) as Record<string, unknown>;
  }

  function breakerRow(sqlite: Database.Database) {
    return sqlite
      .prepare('SELECT state FROM project_data_archive_circuit_breakers WHERE project_id = ?')
      .get(PROJECT_ID) as { state: string } | undefined;
  }

  function controlEnv(
    sqlite: Database.Database,
    source: ReturnType<typeof createFakeSource>,
    target: ReturnType<typeof createFakeTarget>
  ): Env {
    return makeEnv(sqlite, {
      PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
      PROJECT_DATA: createProjectDataNamespace({
        [SOURCE_OWNER]: source,
        [TARGET_OWNER]: target,
      }),
    });
  }

  it('returns a failed pre-copy migration to root, freezes the journal, and leaves the breaker closed', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'failed', { attemptCount: 1 });
      seedSessionSummary(sqlite, { endedAt: 1000 });
      const source = createFakeSource({ state: 'intent_prepared' });
      const target = createFakeTarget();
      await target.archiveTargetCommitChunk({ ...makeChunk('chat_messages', 0), rowCount: 3 });
      const env = controlEnv(sqlite, source, target);

      const result = await abandonProjectDataArchiveMigration(env, {
        migrationId: MIGRATION_ID,
        projectId: PROJECT_ID,
        reason: 'memory reset during prepare',
        now: NOW,
      });
      expect(result).toMatchObject({
        migrationId: MIGRATION_ID,
        sessionId: SESSION_ID,
        previousState: 'failed',
        journalFrozen: true,
        restoredToRoot: true,
        sourceIntentRemoved: true,
        targetRemoved: true,
        targetRowsDeleted: 4,
      });
      expect(target.archiveTargetAbandonSession).toHaveBeenCalledWith(
        expect.objectContaining({ sourceIntactVerified: true, migrationId: MIGRATION_ID })
      );
      expect(readJournal(sqlite, MIGRATION_ID)).toMatchObject({
        state: 'frozen',
        error_code: 'operator_abandoned',
        error_message: 'memory reset during prepare',
        lease_owner: null,
        lease_expires_at: null,
        frozen_at: NOW,
      });
      expect(readLocationRow(sqlite)).toMatchObject({
        location_state: 'root',
        owner_kind: 'root',
        owner_name: SOURCE_OWNER,
        generation: 0,
      });
      expect(breakerRow(sqlite)).toBeUndefined();

      // Idempotent rerun: nothing left to remove, D1 already converged.
      const rerun = await abandonProjectDataArchiveMigration(env, {
        migrationId: MIGRATION_ID,
        projectId: PROJECT_ID,
        reason: 'rerun',
        now: NOW + 1,
      });
      expect(rerun).toMatchObject({
        journalFrozen: false,
        restoredToRoot: false,
        sourceIntentRemoved: false,
        targetRemoved: false,
      });
      expect(readJournal(sqlite, MIGRATION_ID)).toMatchObject({
        error_message: 'memory reset during prepare',
      });

      // The session is a fresh candidate again and gets a new journal row.
      const dryRun = await runScopedProjectDataArchiveCanary(env, {
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        dryRun: true,
        nowDate: new Date(NOW),
      });
      expect(dryRun.selected).toEqual([
        expect.objectContaining({ sessionId: SESSION_ID, source: 'eligible_session' }),
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('abandons a poisoned migration whose shard holds a partial copy', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'poisoned', { attemptCount: 3, locationState: 'frozen' });
      const source = createFakeSource({ state: 'intent_prepared' });
      const target = createFakeTarget();
      await target.archiveTargetCommitChunk({ ...makeChunk('chat_messages', 0), rowCount: 2 });
      const env = controlEnv(sqlite, source, target);

      const result = await abandonProjectDataArchiveMigration(env, {
        migrationId: MIGRATION_ID,
        projectId: PROJECT_ID,
        reason: 'bind ceiling failure, fixed',
        now: NOW,
      });
      expect(result).toMatchObject({
        previousState: 'poisoned',
        journalFrozen: true,
        restoredToRoot: true,
        targetRemoved: true,
      });
      expect(readLocationRow(sqlite)).toMatchObject({ location_state: 'root', generation: 0 });
      expect(readJournal(sqlite, MIGRATION_ID)).toMatchObject({
        state: 'frozen',
        error_code: 'operator_abandoned',
      });
    } finally {
      sqlite.close();
    }
  });

  it('refuses once the source payload is deleted, per the journal or per the root object', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'source_deleted', { migrationId: 'migration-deleted' });
      seedMigration(sqlite, 'published', {
        migrationId: 'migration-published',
        sessionId: 'session-published',
        locationState: 'archive_shard',
      });
      // Journal lags the object: D1 still says copying, the root already deleted the source.
      seedMigration(sqlite, 'copying', {
        migrationId: 'migration-lagging',
        sessionId: 'session-lagging',
      });
      const source = createFakeSource({ state: 'source_deleted' });
      const target = createFakeTarget();
      const env = controlEnv(sqlite, source, target);

      for (const migrationId of ['migration-deleted', 'migration-published', 'migration-lagging']) {
        await expect(
          abandonProjectDataArchiveMigration(env, {
            migrationId,
            projectId: PROJECT_ID,
            reason: 'should refuse',
            now: NOW,
          })
        ).rejects.toMatchObject({ reason: 'abandon_requires_source_intact' });
      }
      expect(target.archiveTargetAbandonSession).not.toHaveBeenCalled();
      expect(source.archiveSourceAbandonIntent).not.toHaveBeenCalled();
      expect(readLocationRow(sqlite, 'session-lagging')).toMatchObject({
        location_state: 'migrating',
      });
      expect(readLocationRow(sqlite, 'session-published')).toMatchObject({
        location_state: 'archive_shard',
      });
      expect(readJournal(sqlite, 'migration-lagging')).toMatchObject({ state: 'copying' });
    } finally {
      sqlite.close();
    }
  });

  it('waits for a live lease on an in-flight migration, then abandons once it expires', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'copying', { leaseExpiresAt: NOW + 60_000 });
      const source = createFakeSource({ state: 'intent_prepared' });
      const target = createFakeTarget();
      const env = controlEnv(sqlite, source, target);

      await expect(
        abandonProjectDataArchiveMigration(env, {
          migrationId: MIGRATION_ID,
          projectId: PROJECT_ID,
          reason: 'too early',
          now: NOW,
        })
      ).rejects.toMatchObject({ reason: 'abandon_requires_expired_lease' });
      expect(source.archiveSourceAbandonIntent).not.toHaveBeenCalled();
      expect(readLocationRow(sqlite)).toMatchObject({ location_state: 'migrating' });

      // Owner control: the identical call after the lease lapses goes through.
      const result = await abandonProjectDataArchiveMigration(env, {
        migrationId: MIGRATION_ID,
        projectId: PROJECT_ID,
        reason: 'lease lapsed',
        now: NOW + 60_001,
      });
      expect(result).toMatchObject({ previousState: 'copying', restoredToRoot: true });
    } finally {
      sqlite.close();
    }
  });

  it('does not let a stale lease on an already-failed migration block abandon', async () => {
    // markFailed clears the lease today; this pins the `state !== 'failed'` disjunct so a
    // future writer that fails a migration without clearing its lease cannot wedge recovery.
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'failed', { leaseExpiresAt: NOW + 60_000 });
      const source = createFakeSource({ state: 'intent_prepared' });
      const target = createFakeTarget();
      const result = await abandonProjectDataArchiveMigration(controlEnv(sqlite, source, target), {
        migrationId: MIGRATION_ID,
        projectId: PROJECT_ID,
        reason: 'failed with a lease still recorded',
        now: NOW,
      });
      expect(result).toMatchObject({ previousState: 'failed', restoredToRoot: true });
      expect(readJournal(sqlite, MIGRATION_ID)).toMatchObject({
        state: 'frozen',
        error_code: 'operator_abandoned',
        lease_expires_at: null,
      });
    } finally {
      sqlite.close();
    }
  });

  it('requires a non-blank reason before reading the journal or touching any object', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'failed');
      const source = createFakeSource({ state: 'intent_prepared' });
      const target = createFakeTarget();
      for (const reason of ['', '   ', '\n\t']) {
        await expect(
          abandonProjectDataArchiveMigration(controlEnv(sqlite, source, target), {
            migrationId: MIGRATION_ID,
            projectId: PROJECT_ID,
            reason,
            now: NOW,
          })
        ).rejects.toMatchObject({ reason: 'abandon_reason_required' });
      }
      expect(source.archiveSourceInspectIntent).not.toHaveBeenCalled();
      expect(target.archiveTargetAbandonSession).not.toHaveBeenCalled();
      expect(readJournal(sqlite, MIGRATION_ID)).toMatchObject({ state: 'failed' });
      expect(readLocationRow(sqlite)).toMatchObject({ location_state: 'migrating' });
    } finally {
      sqlite.close();
    }
  });

  it('never drops the shard copy when the source is finalized between the inspect read and the abandon', async () => {
    // Race reproduction: the root object reports the intent intact when inspected, but a
    // concurrent finalize lands before the lock-protected source abandon runs. The source
    // RPC refuses (as the real DO does once the payload is gone) and the target copy, now
    // the only copy, must survive. A target-first ordering deletes it before finding out.
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'recovery_manifest_persisted', { leaseExpiresAt: NOW - 1 });
      const source = createFakeSource({ state: 'recovery_manifest_persisted' });
      const target = createFakeTarget();
      await target.archiveTargetCommitChunk({ ...makeChunk('chat_messages', 0), rowCount: 3 });
      await target.archiveTargetSeal();
      source.archiveSourceAbandonIntent.mockImplementationOnce(async () => {
        // Production: a plain Error crosses the DO RPC boundary.
        throw new Error('abandon_requires_source_intact');
      });

      await expect(
        abandonProjectDataArchiveMigration(controlEnv(sqlite, source, target), {
          migrationId: MIGRATION_ID,
          projectId: PROJECT_ID,
          reason: 'looked stuck',
          now: NOW,
        })
      ).rejects.toThrow('abandon_requires_source_intact');

      expect(source.archiveSourceInspectIntent).toHaveBeenCalledTimes(1);
      expect(source.archiveSourceAbandonIntent).toHaveBeenCalledTimes(1);
      expect(target.archiveTargetAbandonSession).not.toHaveBeenCalled();
      expect((await target.archiveTargetInspectSession()).state).toBe('sealed');
      // The reservation is released so a sweep can finish publishing; the journal and the
      // location are left exactly as they were.
      expect(readJournal(sqlite, MIGRATION_ID)).toMatchObject({
        state: 'recovery_manifest_persisted',
        error_code: null,
        lease_owner: null,
        lease_expires_at: null,
      });
      expect(readLocationRow(sqlite)).toMatchObject({ location_state: 'migrating' });
    } finally {
      sqlite.close();
    }
  });

  it('fences the journal before touching any object so a sweep cannot claim the row mid-abandon', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'target_sealed', { leaseExpiresAt: NOW - 1 });
      sqlite
        .prepare(
          `UPDATE project_data_archive_migrations
           SET lease_owner = 'worker-stale', lease_epoch = 3 WHERE migration_id = ?`
        )
        .run(MIGRATION_ID);
      const source = createFakeSource({ state: 'target_sealed' });
      const target = createFakeTarget();
      await target.archiveTargetCommitChunk({ ...makeChunk('chat_messages', 0), rowCount: 3 });
      await target.archiveTargetSeal();
      const sweepClaims: number[] = [];
      const staleFences: number[] = [];
      const original = source.archiveSourceAbandonIntent.getMockImplementation();
      source.archiveSourceAbandonIntent.mockImplementationOnce(async () => {
        // A sweep tick racing the operator: the same CAS `claimMigrationLease` issues.
        sweepClaims.push(
          sqlite
            .prepare(
              `UPDATE project_data_archive_migrations
               SET lease_owner = 'worker-new', lease_epoch = lease_epoch + 1, lease_expires_at = ?
               WHERE migration_id = ? AND state = 'target_sealed'
                 AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`
            )
            .run(NOW + 300_000, MIGRATION_ID, NOW).changes
        );
        // The stale worker from before the abandon: its `assertLeaseStillHeld` epoch check.
        staleFences.push(
          (
            sqlite
              .prepare(
                `SELECT COUNT(*) AS count FROM project_data_archive_migrations
                 WHERE migration_id = ? AND lease_owner = 'worker-stale' AND lease_epoch = 3`
              )
              .get(MIGRATION_ID) as { count: number }
          ).count
        );
        return original!();
      });

      const result = await abandonProjectDataArchiveMigration(controlEnv(sqlite, source, target), {
        migrationId: MIGRATION_ID,
        projectId: PROJECT_ID,
        reason: 'fenced',
        now: NOW,
      });
      expect(sweepClaims).toEqual([0]);
      expect(staleFences).toEqual([0]);
      expect(result).toMatchObject({ restoredToRoot: true, journalFrozen: true });
      expect(
        sqlite
          .prepare(
            `SELECT state, lease_owner, lease_epoch FROM project_data_archive_migrations
             WHERE migration_id = ?`
          )
          .get(MIGRATION_ID)
      ).toMatchObject({ state: 'frozen', lease_owner: null, lease_epoch: 4 });
    } finally {
      sqlite.close();
    }
  });

  it('lets an interrupted abandon rerun take over its own unexpired reservation, but not a worker lease', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'copying', { leaseExpiresAt: NOW + 60_000 });
      const setOwner = (owner: string) =>
        sqlite
          .prepare(
            'UPDATE project_data_archive_migrations SET lease_owner = ? WHERE migration_id = ?'
          )
          .run(owner, MIGRATION_ID);
      const run = () =>
        abandonProjectDataArchiveMigration(
          controlEnv(sqlite, createFakeSource({ state: 'intent_prepared' }), createFakeTarget()),
          { migrationId: MIGRATION_ID, projectId: PROJECT_ID, reason: 'rerun', now: NOW }
        );

      // Control: a live lease held by a sweep worker still refuses.
      setOwner('worker-live');
      await expect(run()).rejects.toMatchObject({ reason: 'abandon_requires_expired_lease' });
      expect(readLocationRow(sqlite)).toMatchObject({ location_state: 'migrating' });

      // A live reservation left by an earlier abandon attempt is ours to take over.
      setOwner('abandon:earlier-attempt');
      // The pre-fence guard reads the same row; an operator reservation is not a sweep lease.
      const result = await run();
      expect(result).toMatchObject({ previousState: 'copying', restoredToRoot: true });
    } finally {
      sqlite.close();
    }
  });

  it('rejects a migration that belongs to another project before touching any object', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'failed', {
        migrationId: 'migration-foreign',
        projectId: 'project-other',
      });
      const source = createFakeSource({ state: 'intent_prepared' });
      const target = createFakeTarget();
      await expect(
        abandonProjectDataArchiveMigration(controlEnv(sqlite, source, target), {
          migrationId: 'migration-foreign',
          projectId: PROJECT_ID,
          reason: 'cross-project',
          now: NOW,
        })
      ).rejects.toMatchObject({ reason: 'migration_project_mismatch' });
      expect(source.archiveSourceAbandonIntent).not.toHaveBeenCalled();
      expect(readLocationRow(sqlite, SESSION_ID, 'project-other')).toMatchObject({
        location_state: 'migrating',
      });
      // Owner control: the same row abandons cleanly when addressed by its own project.
      const owned = await abandonProjectDataArchiveMigration(
        makeEnv(sqlite, {
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          PROJECT_DATA: createProjectDataNamespace({
            'project-other': source,
            [TARGET_OWNER]: target,
          }),
        }),
        {
          migrationId: 'migration-foreign',
          projectId: 'project-other',
          reason: 'owner abandon',
          now: NOW,
        }
      );
      expect(owned).toMatchObject({ restoredToRoot: true, journalFrozen: true });
    } finally {
      sqlite.close();
    }
  });
});

describe('archive-sharding pre-copy refusal unwinds the fence in the same tick', () => {
  // Exactly what the root object returns for `ea87d375` in production: the D1 candidate query
  // cannot see a live `session_state` row, so the session is journaled, fenced `migrating`,
  // and only then refused before anything is written on either object.
  const REFUSAL = {
    refused: true as const,
    reason: 'active_session_state',
    message: 'ProjectData archive refuses sessions with active session_state rows',
    databaseSizeBytes: 1000,
  };

  function namespaceFor(source: ReturnType<typeof createFakeSource>): DurableObjectNamespace {
    return {
      idFromName: (name: string) => name,
      get: (id: string) => (id === SOURCE_OWNER ? source : createFakeTarget()),
    } as unknown as DurableObjectNamespace;
  }

  function readJournal(sqlite: Database.Database, sessionId: string) {
    return sqlite
      .prepare(
        `SELECT state, error_code, error_message, lease_owner, lease_expires_at, attempt_count
         FROM project_data_archive_migrations
         WHERE session_id = ?`
      )
      .get(sessionId) as Record<string, unknown> | undefined;
  }

  function readLocationMigration(sqlite: Database.Database, sessionId: string) {
    return sqlite
      .prepare(
        `SELECT location_state, migration_id FROM project_data_session_locations
         WHERE project_id = ? AND session_id = ?`
      )
      .get(PROJECT_ID, sessionId) as { location_state: string; migration_id: string | null };
  }

  function readBreaker(sqlite: Database.Database) {
    return sqlite
      .prepare('SELECT state FROM project_data_archive_circuit_breakers WHERE project_id = ?')
      .get(PROJECT_ID) as { state: string } | undefined;
  }

  async function runCanary(sqlite: Database.Database, source: ReturnType<typeof createFakeSource>) {
    return runScopedProjectDataArchiveCanary(
      makeEnv(sqlite, {
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
        PROJECT_DATA: namespaceFor(source),
      }),
      {
        projectId: PROJECT_ID,
        dryRun: false,
        reason: 'refusal canary',
        limit: 5,
        nowDate: new Date(NOW),
      }
    );
  }

  it('returns a refused candidate to root with a frozen precopy_refused journal and no breaker change', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedSessionSummary(sqlite, { sessionId: 'session-refused', messageCount: 500 });
      const source = createFakeSource();
      source.archiveSourcePrepareIntent.mockResolvedValue(REFUSAL);

      const result = await runCanary(sqlite, source);

      expect(result.stats).toMatchObject({
        selected: 1,
        refused: 1,
        migrated: 0,
        failed: 0,
        poisoned: 0,
      });
      // Liveness beside the absence assertions (rule 62): the object really was asked, and
      // nothing past prepare ran.
      expect(source.archiveSourcePrepareIntent).toHaveBeenCalledTimes(1);
      expect(source.archiveSourceExportChunk).not.toHaveBeenCalled();
      expect(source.archiveSourceFinalizeDelete).not.toHaveBeenCalled();
      // The session reads again: exact routing resolves `root`, not a fence.
      expect(readLocationRow(sqlite, 'session-refused')).toMatchObject({
        location_state: 'root',
        owner_kind: 'root',
        owner_name: SOURCE_OWNER,
        generation: 0,
      });
      expect(readLocationMigration(sqlite, 'session-refused').migration_id).toBeNull();
      // Terminal for reclaim, never poisoned, lease released, reason preserved for operators.
      expect(readJournal(sqlite, 'session-refused')).toEqual({
        state: 'frozen',
        error_code: 'precopy_refused',
        error_message:
          'active_session_state: ProjectData archive refuses sessions with active session_state rows',
        lease_owner: null,
        lease_expires_at: null,
        attempt_count: 1,
      });
      expect(readBreaker(sqlite)).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it('never restores the session to root when the lease fence is lost between claim and refusal', async () => {
    // A concurrent worker (or an abandon reservation) bumps the lease epoch while this worker
    // waits on the prepare RPC. The journal freeze must miss its CAS, and the location restore
    // in the same batch is conditioned on that freeze, so both rows stay exactly as the new
    // owner left them.
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedSessionSummary(sqlite, { sessionId: 'session-race', messageCount: 500 });
      const source = createFakeSource();
      source.archiveSourcePrepareIntent.mockImplementationOnce(async () => {
        sqlite
          .prepare(
            `UPDATE project_data_archive_migrations
             SET lease_owner = 'worker-concurrent', lease_epoch = lease_epoch + 1
             WHERE session_id = ?`
          )
          .run('session-race');
        return REFUSAL;
      });

      const result = await runCanary(sqlite, source);

      expect(result.stats).toMatchObject({ selected: 1, refused: 0, failed: 1 });
      expect(readLocationRow(sqlite, 'session-race')).toMatchObject({
        location_state: 'migrating',
      });
      // The successor's row is exactly as it left it: not frozen, not marked failed by the
      // loser, lease intact.
      expect(readJournal(sqlite, 'session-race')).toMatchObject({
        state: 'leased',
        lease_owner: 'worker-concurrent',
        error_code: null,
      });
    } finally {
      sqlite.close();
    }
  });

  it('unwinds only the leased migration even when another project fences the same session id', async () => {
    // Cross-tenant control (rule 28): project B holds an unrelated `migrating` fence for a
    // session with the same id. Refusing project A's candidate must leave B untouched.
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedSessionSummary(sqlite, { sessionId: 'session-shared', messageCount: 500 });
      seedMigration(sqlite, 'copying', {
        migrationId: 'migration-other-project',
        projectId: 'project-other',
        sessionId: 'session-shared',
        leaseExpiresAt: NOW + 60_000,
      });
      const source = createFakeSource();
      source.archiveSourcePrepareIntent.mockResolvedValue(REFUSAL);

      const result = await runCanary(sqlite, source);

      expect(result.stats).toMatchObject({ selected: 1, refused: 1, failed: 0 });
      expect(readLocationRow(sqlite, 'session-shared')).toMatchObject({ location_state: 'root' });
      expect(readLocationRow(sqlite, 'session-shared', 'project-other')).toMatchObject({
        location_state: 'migrating',
        owner_name: TARGET_OWNER,
      });
      expect(readMigrationRow(sqlite, 'migration-other-project')).toMatchObject({
        state: 'copying',
      });
    } finally {
      sqlite.close();
    }
  });

  it('keeps only the newest refusal marker per session, leaving other frozen journals alone', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedSessionSummary(sqlite, { sessionId: 'session-chronic', messageCount: 500 });
      const seedFrozen = (migrationId: string, errorCode: string, updatedAt: number) =>
        sqlite
          .prepare(
            `INSERT INTO project_data_archive_migrations
               (migration_id, project_id, session_id, state, source_owner_name, target_owner_name,
                target_generation, lease_epoch, attempt_count, error_code, created_at, updated_at)
             VALUES (?, ?, 'session-chronic', 'frozen', ?, ?, 1, 1, 1, ?, ?, ?)`
          )
          .run(migrationId, PROJECT_ID, PROJECT_ID, TARGET_OWNER, errorCode, updatedAt, updatedAt);
      // Two earlier refusals (both older than the window) and one operator abandon.
      seedFrozen('migration-refusal-1', 'precopy_refused', NOW - 20 * 24 * 60 * 60 * 1000);
      seedFrozen('migration-refusal-2', 'precopy_refused', NOW - 10 * 24 * 60 * 60 * 1000);
      seedFrozen('migration-abandoned', 'operator_abandoned', NOW - 5 * 24 * 60 * 60 * 1000);
      const source = createFakeSource();
      source.archiveSourcePrepareIntent.mockResolvedValue(REFUSAL);

      const result = await runCanary(sqlite, source);
      expect(result.stats).toMatchObject({ selected: 1, refused: 1 });

      const frozen = sqlite
        .prepare(
          `SELECT migration_id, error_code FROM project_data_archive_migrations
           WHERE session_id = 'session-chronic' AND state = 'frozen' ORDER BY updated_at ASC`
        )
        .all() as Array<{ migration_id: string; error_code: string }>;
      expect(frozen.filter((row) => row.error_code === 'precopy_refused')).toHaveLength(1);
      expect(frozen.map((row) => row.migration_id)).not.toContain('migration-refusal-1');
      expect(frozen.map((row) => row.migration_id)).not.toContain('migration-refusal-2');
      // Owner control: the abandon record is a real ledger entry and stays.
      expect(frozen.map((row) => row.migration_id)).toContain('migration-abandoned');
    } finally {
      sqlite.close();
    }
  });

  it('keeps a mid-copy failure fenced for retry (discriminating control)', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedSessionSummary(sqlite, { sessionId: 'session-midcopy', messageCount: 500 });
      const source = createFakeSource();
      source.archiveSourceExportChunk.mockRejectedValue(new Error('shard export failed'));

      const result = await runCanary(sqlite, source);

      expect(result.stats).toMatchObject({ selected: 1, refused: 0, migrated: 0, failed: 1 });
      expect(readLocationRow(sqlite, 'session-midcopy')).toMatchObject({
        location_state: 'migrating',
      });
      expect(readJournal(sqlite, 'session-midcopy')).toMatchObject({
        state: 'failed',
        error_code: 'Error',
        error_message: 'shard export failed',
      });
    } finally {
      sqlite.close();
    }
  });

  it('keeps a transient prepare error fenced for retry, so only a typed refusal unwinds', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedSessionSummary(sqlite, { sessionId: 'session-reset', messageCount: 500 });
      const source = createFakeSource();
      source.archiveSourcePrepareIntent.mockRejectedValue(
        new Error("Durable Object's isolate exceeded its memory limit and was reset.")
      );

      const result = await runCanary(sqlite, source);

      expect(result.stats).toMatchObject({ selected: 1, refused: 0, failed: 1 });
      expect(readLocationRow(sqlite, 'session-reset')).toMatchObject({
        location_state: 'migrating',
      });
      expect(readJournal(sqlite, 'session-reset')).toMatchObject({ state: 'failed' });
    } finally {
      sqlite.close();
    }
  });

  it('keeps the fail-closed fenced path when a refusal arrives after an intent already exists', async () => {
    // A journal past `leased` says an intent row exists; the object only refuses while none
    // does. The two disagree, so the coordinator must not unfence on the contradiction.
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedSessionSummary(sqlite, { sessionId: SESSION_ID, messageCount: 500 });
      seedMigration(sqlite, 'intent_prepared', { leaseExpiresAt: 1000, attemptCount: 1 });
      const source = createFakeSource({ state: 'intent_prepared' });
      source.archiveSourcePrepareIntent.mockResolvedValue(REFUSAL);

      const result = await runCanary(sqlite, source);

      expect(result.stats).toMatchObject({ selected: 1, refused: 0, failed: 1 });
      expect(readLocationRow(sqlite, SESSION_ID)).toMatchObject({ location_state: 'migrating' });
      expect(readJournal(sqlite, SESSION_ID)).toMatchObject({
        state: 'failed',
        error_code: 'ProjectDataArchiveCoordinatorStateError',
        error_message: expect.stringContaining(
          'was refused at prepare (active_session_state) while its journal is intent_prepared'
        ) as unknown,
      });
    } finally {
      sqlite.close();
    }
  });
});

describe('archive-sharding selection honours the pre-copy refusal retry window', () => {
  // Older than the 60 s floor of the retry window, so a configured minimum re-admits it.
  const REFUSED_AT = NOW - 61_000;

  function seedTerminalJournal(
    sqlite: Database.Database,
    sessionId: string,
    errorCode: string,
    updatedAt: number
  ): void {
    sqlite
      .prepare(
        `INSERT INTO project_data_archive_migrations
           (migration_id, project_id, session_id, state, source_owner_name, target_owner_name,
            target_generation, lease_epoch, attempt_count, error_code, created_at, updated_at)
         VALUES (?, ?, ?, 'frozen', ?, ?, 1, 1, 1, ?, ?, ?)`
      )
      .run(
        `migration-${sessionId}`,
        PROJECT_ID,
        sessionId,
        PROJECT_ID,
        TARGET_OWNER,
        errorCode,
        updatedAt,
        updatedAt
      );
    sqlite
      .prepare(
        `INSERT INTO project_data_session_locations
           (project_id, session_id, location_state, owner_kind, owner_name, generation,
            routing_schema_version, updated_at)
         VALUES (?, ?, 'root', 'root', ?, 0, 1, ?)`
      )
      .run(PROJECT_ID, sessionId, PROJECT_ID, updatedAt);
  }

  function seedAll(sqlite: Database.Database): void {
    createCoordinatorTables(sqlite);
    seedSessionSummary(sqlite, { sessionId: 'session-refused', messageCount: 300 });
    seedTerminalJournal(sqlite, 'session-refused', 'precopy_refused', REFUSED_AT);
    // Owner controls: a frozen journal with a DIFFERENT code, and a `failed` one, must not
    // hide their sessions — the marker is precisely `frozen` + `precopy_refused`.
    seedSessionSummary(sqlite, { sessionId: 'session-abandoned', messageCount: 200 });
    seedTerminalJournal(sqlite, 'session-abandoned', 'operator_abandoned', REFUSED_AT);
    seedSessionSummary(sqlite, { sessionId: 'session-plain', messageCount: 100 });
  }

  async function scopedSelection(
    sqlite: Database.Database,
    overrides: Partial<Env>,
    scope: { sessionId?: string; nowDate?: Date } = {}
  ): Promise<string[]> {
    const result = await runScopedProjectDataArchiveCanary(makeEnv(sqlite, overrides), {
      projectId: PROJECT_ID,
      sessionId: scope.sessionId,
      dryRun: true,
      limit: 5,
      nowDate: scope.nowDate ?? new Date(NOW),
    });
    return result.selected.map((candidate) => candidate.sessionId);
  }

  it('skips a refused session inside the window and selects it again once the window elapses', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedAll(sqlite);
      // Inside the 7-day default window: excluded, and the owner controls are still selected.
      expect(await scopedSelection(sqlite, {})).toEqual(['session-abandoned', 'session-plain']);
      // The window is measured from the refusal, not from the tick: a later `now` re-admits it.
      expect(
        await scopedSelection(
          sqlite,
          {},
          {
            nowDate: new Date(REFUSED_AT + 7 * 24 * 60 * 60 * 1000 + 1),
          }
        )
      ).toEqual(['session-refused', 'session-abandoned', 'session-plain']);
      // The window is env-configurable, with a one-minute floor: a value below it falls back
      // to the default window instead of disabling the anti-thrash marker.
      expect(
        await scopedSelection(sqlite, { PROJECT_DATA_ARCHIVE_PRECOPY_REFUSAL_RETRY_MS: '60000' })
      ).toEqual(['session-refused', 'session-abandoned', 'session-plain']);
      expect(
        await scopedSelection(sqlite, { PROJECT_DATA_ARCHIVE_PRECOPY_REFUSAL_RETRY_MS: '1' })
      ).toEqual(['session-abandoned', 'session-plain']);
      // Identical repeated calls return an identical sequence (rule 65 determinism).
      expect(await scopedSelection(sqlite, {})).toEqual(['session-abandoned', 'session-plain']);
    } finally {
      sqlite.close();
    }
  });

  it('still selects the refused session when the operator scope names it', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedAll(sqlite);
      expect(await scopedSelection(sqlite, {}, { sessionId: 'session-refused' })).toEqual([
        'session-refused',
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('applies the same window to the unscoped scheduled sweep', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedAll(sqlite);
      const source = createFakeSource();
      const namespace = {
        idFromName: (name: string) => name,
        get: (id: string) => (id === SOURCE_OWNER ? source : createFakeTarget()),
      } as unknown as DurableObjectNamespace;
      const stats = await runProjectDataArchiveSharding(
        makeEnv(sqlite, {
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '5',
          PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
          PROJECT_DATA: namespace,
        }),
        new Date(NOW)
      );
      expect(stats).toMatchObject({ skipped: false, selected: 2, migrated: 2, refused: 0 });
      // The refused session was never journaled again; the controls were.
      expect(readLocationRow(sqlite, 'session-refused')).toMatchObject({ location_state: 'root' });
      expect(readLocationRow(sqlite, 'session-abandoned')).toMatchObject({
        location_state: 'archive_shard',
      });
      expect(readLocationRow(sqlite, 'session-plain')).toMatchObject({
        location_state: 'archive_shard',
      });

      // Liveness: once the window elapses the same unscoped sweep re-admits the session.
      sqlite
        .prepare(
          `UPDATE project_data_archive_global_sweep_cadence SET next_eligible_at = 0, last_status = 'succeeded'`
        )
        .run();
      const later = await runProjectDataArchiveSharding(
        makeEnv(sqlite, {
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '5',
          PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
          PROJECT_DATA: namespace,
        }),
        new Date(REFUSED_AT + 7 * 24 * 60 * 60 * 1000 + 1)
      );
      expect(later).toMatchObject({ skipped: false, selected: 1, migrated: 1 });
      expect(readLocationRow(sqlite, 'session-refused')).toMatchObject({
        location_state: 'archive_shard',
      });
    } finally {
      sqlite.close();
    }
  });
});

describe('archive-sharding failed journals wait a retry delay before a sweep reclaims them', () => {
  function seedFailedAt(sqlite: Database.Database, updatedAt: number): void {
    seedSessionSummary(sqlite, { sessionId: SESSION_ID, messageCount: 500 });
    seedMigration(sqlite, 'failed', { leaseExpiresAt: null, attemptCount: 1, updatedAt });
  }

  async function reclaimed(sqlite: Database.Database, overrides: Partial<Env>, nowDate: Date) {
    const source = createFakeSource();
    const stubs: Record<string, unknown> = { [SOURCE_OWNER]: source };
    const namespace = {
      idFromName: (name: string) => name,
      get: (id: string) => stubs[id] ?? createFakeTarget(),
    } as unknown as DurableObjectNamespace;
    const stats = await runProjectDataArchiveSharding(
      makeEnv(sqlite, {
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
        PROJECT_DATA: namespace,
        ...overrides,
      }),
      nowDate
    );
    sqlite
      .prepare(`UPDATE project_data_archive_global_sweep_cadence SET next_eligible_at = 0`)
      .run();
    return { stats, prepareCalls: source.archiveSourcePrepareIntent.mock.calls.length };
  }

  it('skips a fresh failure inside the delay and reclaims it once the delay has elapsed', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedFailedAt(sqlite, NOW - 1_000);
      // Inside the default one-hour delay: not reclaimed, so no attempt is spent.
      const first = await reclaimed(sqlite, {}, new Date(NOW));
      expect(first.stats).toMatchObject({ selected: 0, migrated: 0 });
      expect(first.prepareCalls).toBe(0);
      expect(readMigrationRow(sqlite)).toMatchObject({ state: 'failed' });
      // After the delay the same row is reclaimed and completes (liveness).
      const second = await reclaimed(sqlite, {}, new Date(NOW + 60 * 60 * 1000 + 1));
      expect(second.stats).toMatchObject({ selected: 1, migrated: 1 });
      expect(readMigrationRow(sqlite)).toMatchObject({ state: 'published' });
    } finally {
      sqlite.close();
    }
  });

  it('honours a configured delay, including zero, and lets a named-session canary bypass it', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedFailedAt(sqlite, NOW - 1_000);
      // Zero disables the delay entirely.
      const immediate = await reclaimed(
        sqlite,
        { PROJECT_DATA_ARCHIVE_FAILED_RETRY_DELAY_MS: '0' },
        new Date(NOW)
      );
      expect(immediate.stats).toMatchObject({ selected: 1, migrated: 1 });
    } finally {
      sqlite.close();
    }
    const scoped = new Database(':memory:');
    try {
      createCoordinatorTables(scoped);
      seedFailedAt(scoped, NOW - 1_000);
      const source = createFakeSource();
      const stubs: Record<string, unknown> = { [SOURCE_OWNER]: source };
      const namespace = {
        idFromName: (name: string) => name,
        get: (id: string) => stubs[id] ?? createFakeTarget(),
      } as unknown as DurableObjectNamespace;
      // Project-scoped (no session named): the delay applies.
      const projectScoped = await runScopedProjectDataArchiveCanary(
        makeEnv(scoped, {
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
          PROJECT_DATA: namespace,
        }),
        { projectId: PROJECT_ID, dryRun: true, limit: 5, nowDate: new Date(NOW) }
      );
      expect(projectScoped.selected.map((item) => item.migrationId)).toEqual([]);
      // Naming the session is operator intent: the delay is bypassed.
      const sessionScoped = await runScopedProjectDataArchiveCanary(
        makeEnv(scoped, {
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
          PROJECT_DATA: namespace,
        }),
        {
          projectId: PROJECT_ID,
          sessionId: SESSION_ID,
          dryRun: true,
          limit: 5,
          nowDate: new Date(NOW),
        }
      );
      expect(sessionScoped.selected.map((item) => item.migrationId)).toEqual([MIGRATION_ID]);
    } finally {
      scoped.close();
    }
  });
});

describe('archive-sharding frozen-intent inspection skips self-healing pre-copy refusals', () => {
  it('inspects failed and operator-frozen rows but never a precopy_refused row', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      // Oldest first: a chronic refusal that would otherwise occupy the front of the page.
      sqlite
        .prepare(
          `INSERT INTO project_data_archive_migrations
             (migration_id, project_id, session_id, state, source_owner_name, target_owner_name,
              target_generation, lease_epoch, attempt_count, error_code, created_at, updated_at)
           VALUES ('migration-refused', ?, 'session-refused', 'frozen', ?, ?, 1, 1, 1,
                   'precopy_refused', 100, 100)`
        )
        .run(PROJECT_ID, PROJECT_ID, TARGET_OWNER);
      seedMigration(sqlite, 'failed', {
        migrationId: 'migration-failed',
        sessionId: 'session-failed',
        updatedAt: 2000,
      });
      const source = createFakeSource({ state: 'source_deleted' });
      const target = createFakeTarget();

      const inspectionResult = await inspectFrozenProjectDataArchiveIntents(
        makeEnv(sqlite, {
          PROJECT_DATA: createProjectDataNamespace({
            [SOURCE_OWNER]: source,
            [TARGET_OWNER]: target,
          }),
        }),
        { projectId: PROJECT_ID, limit: 1 }
      );

      expect(inspectionResult.inspections.map((row) => row.migrationId)).toEqual([
        'migration-failed',
      ]);
      // No DO fan-out was spent on the refused row.
      expect(source.archiveSourceInspectIntent).toHaveBeenCalledTimes(1);
      expect(target.archiveTargetInspectSession).toHaveBeenCalledTimes(1);
    } finally {
      sqlite.close();
    }
  });
});
