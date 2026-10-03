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
import { DEFAULT_PROJECT_DATA_STORAGE_HARD_CAP_BYTES } from '../../../src/scheduled/project-data-storage-alerts';
import { archiveShardProjectDataOwner } from '../../../src/services/project-data-archive-routing';
import {
  PROJECT_DATA_STORAGE_FULL,
  ProjectDataStorageFullError,
} from '../../../src/services/project-data-storage-errors';
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
    schema.projectDataArchiveCapacityHolds,
    schema.projectDataArchiveGlobalSweepCadence,
    schema.projectDataArchiveMigrations,
    schema.projectDataArchiveCopyCheckpoints,
    schema.projectDataSessionLocations,
  ]);
}

function createMemoryR2(): R2Bucket {
  const objects = new Map<string, { body: Uint8Array; customMetadata?: Record<string, string> }>();
  return {
    head: vi.fn(async (key: string) => {
      const object = objects.get(key);
      return object
        ? ({ size: object.body.byteLength, customMetadata: object.customMetadata } as R2Object)
        : null;
    }),
    get: vi.fn(async (key: string) => {
      const object = objects.get(key);
      return object
        ? ({
            size: object.body.byteLength,
            customMetadata: object.customMetadata,
            body: new Response(object.body).body,
          } as R2ObjectBody)
        : null;
    }),
    put: vi.fn(async (key: string, value: string | Uint8Array, options?: R2PutOptions) => {
      if (options?.onlyIf && objects.has(key)) return null;
      const body =
        typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
      objects.set(key, { body, customMetadata: options?.customMetadata });
      return { size: body.byteLength, customMetadata: options?.customMetadata } as R2Object;
    }),
  } as unknown as R2Bucket;
}

type SourceState =
  null | 'intent_prepared' | 'target_sealed' | 'recovery_manifest_persisted' | 'source_deleted';

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
    // Full by default, so a capacity hold stays until a test grants headroom.
    archiveCapacityProbe: vi.fn(async () => ({
      databaseSizeBytes: DEFAULT_PROJECT_DATA_STORAGE_HARD_CAP_BYTES,
    })),
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
    archiveCapacityProbe: vi.fn(async () => ({
      databaseSizeBytes: DEFAULT_PROJECT_DATA_STORAGE_HARD_CAP_BYTES,
    })),
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
        sourceCursor: chunk.cursor,
        sourceHasMore: chunk.hasMore,
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

  it('reconciles a committed target receipt after reset without re-exporting that source chunk', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'copying', { sourceIntentToken: 'old-token' });
      const source = createFakeSource({ state: 'intent_prepared', token: 'old-token' });
      const target = createFakeTarget();
      await target.archiveTargetCommitChunk(makeChunk('chat_messages', 0));

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

      expect(stats.migrated).toBe(1);
      expect(source.archiveSourceExportChunk.mock.calls.map(([input]) => input.tableName)).toEqual([
        'chat_messages_grouped',
        'tool_payload_archives',
      ]);
      expect(
        sqlite
          .prepare(
            `SELECT next_ordinal, complete, last_chunk_sha256, last_operation_id,
                    last_operation_completed_at
             FROM project_data_archive_copy_checkpoints
             WHERE migration_id = ? AND table_name = 'chat_messages'`
          )
          .get(MIGRATION_ID)
      ).toEqual({
        next_ordinal: 1,
        complete: 1,
        last_chunk_sha256: 'chat_messages:0:sha',
        last_operation_id: expect.any(String),
        last_operation_completed_at: expect.any(Number),
      });
    } finally {
      sqlite.close();
    }
  });

  it('reconciles a multi-chunk receipt prefix after a checkpoint reset without re-exporting it', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'copying', { sourceIntentToken: 'old-token' });
      const source = createFakeSource({ state: 'intent_prepared', token: 'old-token' });
      const target = createFakeTarget();
      await target.archiveTargetCommitChunk({
        ...makeChunk('chat_messages', 0),
        cursor: 'cursor-after-zero',
        hasMore: true,
        rowCount: 1,
        sha256: 'chat-messages-zero',
      });
      await target.archiveTargetCommitChunk(makeChunk('chat_messages', 1));

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

      expect(stats.migrated).toBe(1);
      expect(
        source.archiveSourceExportChunk.mock.calls.filter(
          ([input]) => input.tableName === 'chat_messages'
        )
      ).toHaveLength(0);
      expect(
        sqlite
          .prepare(
            `SELECT next_ordinal, source_cursor, complete
             FROM project_data_archive_copy_checkpoints
             WHERE migration_id = ? AND table_name = 'chat_messages'`
          )
          .get(MIGRATION_ID)
      ).toEqual({ next_ordinal: 2, source_cursor: null, complete: 1 });
    } finally {
      sqlite.close();
    }
  });

  it.each(['export', 'put', 'receipt'] as const)(
    'resumes a multi-chunk copy after a %s boundary failure without recopying the verified prefix',
    async (failureBoundary) => {
      const sqlite = new Database(':memory:');
      try {
        createCoordinatorTables(sqlite);
        seedMigration(sqlite, 'copying', { sourceIntentToken: 'old-token' });
        const source = createFakeSource({ state: 'intent_prepared', token: 'old-token' });
        let injected = false;
        source.archiveSourceExportChunk.mockImplementation(
          async (input: { tableName: ProjectDataArchiveTableName; ordinal: number }) => {
            if (
              failureBoundary === 'export' &&
              input.tableName === 'chat_messages' &&
              input.ordinal === 1 &&
              !injected
            ) {
              injected = true;
              throw new Error('injected export failure');
            }
            if (input.tableName === 'chat_messages' && input.ordinal === 0) {
              return {
                ...makeChunk(input.tableName, input.ordinal),
                cursor: 'cursor-after-zero',
                hasMore: true,
                rowCount: 1,
                sha256: 'chat-messages-zero',
              };
            }
            return makeChunk(input.tableName, input.ordinal);
          }
        );
        const target = createFakeTarget();
        if (failureBoundary === 'receipt') {
          const commit = target.archiveTargetCommitChunk.getMockImplementation();
          target.archiveTargetCommitChunk.mockImplementation(
            async (chunk: ProjectDataArchiveChunk) => {
              if (chunk.tableName === 'chat_messages' && chunk.ordinal === 1 && !injected) {
                injected = true;
                throw new Error('injected receipt failure');
              }
              if (!commit) throw new Error('Missing target commit implementation');
              return commit(chunk);
            }
          );
        }
        const r2 = createMemoryR2();
        if (failureBoundary === 'put') {
          const originalPut = r2.put.bind(r2);
          r2.put = vi.fn(async (key: string, value: string) => {
            if (key.includes('chat_messages/1.json') && !injected) {
              injected = true;
              await originalPut(key, value);
              throw new Error('injected put failure');
            }
            return originalPut(key, value);
          }) as typeof r2.put;
        }
        const env = makeEnv(sqlite, {
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_FAILED_RETRY_DELAY_MS: '0',
          PROJECT_DATA_ARCHIVE_R2: r2,
          PROJECT_DATA: createProjectDataNamespace({
            [SOURCE_OWNER]: source,
            [TARGET_OWNER]: target,
          }),
        });

        const first = await runProjectDataArchiveSharding(env, new Date(NOW));
        expect(first.failed).toBe(1);
        expect(
          sqlite
            .prepare(
              `SELECT last_operation, last_operation_completed_at, last_operation_duration_ms
               FROM project_data_archive_copy_checkpoints
               WHERE migration_id = ? AND table_name = 'chat_messages'`
            )
            .get(MIGRATION_ID)
        ).toEqual({
          last_operation: 'export_commit:failed',
          last_operation_completed_at: expect.any(Number),
          last_operation_duration_ms: expect.any(Number),
        });
        sqlite
          .prepare('UPDATE project_data_archive_global_sweep_cadence SET next_eligible_at = 0')
          .run();
        const second = await runProjectDataArchiveSharding(env, new Date(NOW + 1));
        expect(second.migrated).toBe(1);
        const prefixExports = source.archiveSourceExportChunk.mock.calls.filter(
          ([input]) => input.tableName === 'chat_messages' && input.ordinal === 0
        );
        expect(prefixExports).toHaveLength(1);
        const prefixPuts = vi
          .mocked(r2.put)
          .mock.calls.filter(([key]) => String(key).includes('chat_messages/0.json'));
        expect(prefixPuts).toHaveLength(1);
        if (failureBoundary === 'put') {
          expect(
            vi
              .mocked(r2.put)
              .mock.calls.filter(([key]) => String(key).includes('chat_messages/1.json'))
          ).toHaveLength(1);
        }
        const prefixReceipts = target.archiveTargetCommitChunk.mock.calls.filter(
          ([chunk]) => chunk.tableName === 'chat_messages' && chunk.ordinal === 0
        );
        expect(prefixReceipts).toHaveLength(1);
      } finally {
        sqlite.close();
      }
    }
  );

  it('records a serialized R2 deadline as a timed-out copy operation with bounded duration evidence', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'copying', { sourceIntentToken: 'old-token' });
      const source = createFakeSource({ state: 'intent_prepared', token: 'old-token' });
      const target = createFakeTarget();
      const r2 = {
        head: vi.fn(async () => {
          // Durable Object RPC preserves the error name, but not the local
          // CompactArchiveTimeoutError prototype identity.
          const error = new Error('Compact archive R2 deadline exceeded (get)');
          error.name = 'CompactArchiveTimeoutError';
          throw error;
        }),
        get: vi.fn(),
        put: vi.fn(),
      } as unknown as R2Bucket;
      const stats = await runProjectDataArchiveSharding(
        makeEnv(sqlite, {
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_R2: r2,
          PROJECT_DATA: createProjectDataNamespace({
            [SOURCE_OWNER]: source,
            [TARGET_OWNER]: target,
          }),
        }),
        new Date(NOW)
      );

      expect(stats.failed).toBe(1);
      expect(
        sqlite
          .prepare(
            `SELECT last_operation, last_operation_completed_at, last_operation_duration_ms
             FROM project_data_archive_copy_checkpoints
             WHERE migration_id = ? AND table_name = 'chat_messages'`
          )
          .get(MIGRATION_ID)
      ).toEqual({
        last_operation: 'export_commit:timed_out',
        last_operation_completed_at: expect.any(Number),
        last_operation_duration_ms: expect.any(Number),
      });
      expect(r2.put).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it('adopts a legacy receipt by its durable row and byte inventory after defaults change', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'copying', { sourceIntentToken: 'old-token' });
      const source = createFakeSource({ state: 'intent_prepared', token: 'old-token' });
      const legacyChunk = {
        ...makeChunk('chat_messages', 0),
        rowCount: 7,
        byteCount: 700,
        sha256: 'legacy-layout-sha',
        cursor: 'legacy-cursor',
        hasMore: false,
      };
      source.archiveSourceExportChunk.mockImplementation(
        async (input: {
          tableName: ProjectDataArchiveTableName;
          ordinal: number;
          maxRows?: number;
          maxBytes?: number;
        }) => {
          if (input.tableName === 'chat_messages') {
            expect(input.maxRows).toBe(7);
            expect(input.maxBytes).toBeGreaterThanOrEqual(700);
            return legacyChunk;
          }
          return makeChunk(input.tableName, input.ordinal);
        }
      );
      const target = createFakeTarget();
      await target.archiveTargetCommitChunk(legacyChunk);
      // Model a pre-upgrade receipt: hashes/counts exist, source continuation does not.
      target.archiveTargetInspectSession.mockResolvedValue({
        state: 'copying',
        terminalVersionSha256: TERMINAL_SHA,
        aggregateSha256: TARGET_SHA,
        messageCount: 2,
        groupedCount: 1,
        toolArchiveCount: 0,
        chunks: [
          {
            tableName: 'chat_messages',
            ordinal: 0,
            sha256: legacyChunk.sha256,
            rowCount: legacyChunk.rowCount,
            byteCount: legacyChunk.byteCount,
            sourceCursor: null,
            sourceHasMore: null,
          },
        ],
        sessionRow: { id: SESSION_ID, status: 'stopped' },
        databaseSizeBytes: 750,
        storageFormat: 'sqlite-v1',
      });

      const stats = await runProjectDataArchiveSharding(
        makeEnv(sqlite, {
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_CHUNK_ROWS: '99',
          PROJECT_DATA_ARCHIVE_CHUNK_BYTES: '9999',
          PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
          PROJECT_DATA: createProjectDataNamespace({
            [SOURCE_OWNER]: source,
            [TARGET_OWNER]: target,
          }),
        }),
        new Date(NOW)
      );

      expect(stats.migrated).toBe(1);
      expect(source.archiveSourceExportChunk).toHaveBeenCalledWith(
        expect.objectContaining({
          tableName: 'chat_messages',
          maxRows: 7,
          maxBytes: 9999,
        })
      );
    } finally {
      sqlite.close();
    }
  });

  it('fails closed when a legacy receipt replay no longer matches its durable inventory', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'copying', { sourceIntentToken: 'old-token' });
      const source = createFakeSource({ state: 'intent_prepared', token: 'old-token' });
      const receipt = {
        ...makeChunk('chat_messages', 0),
        rowCount: 7,
        byteCount: 700,
        sha256: 'durable-receipt-sha',
      };
      source.archiveSourceExportChunk.mockResolvedValue({
        ...receipt,
        sha256: 'different-source-sha',
      });
      const target = createFakeTarget();
      target.archiveTargetInspectSession.mockResolvedValue({
        state: 'copying',
        terminalVersionSha256: TERMINAL_SHA,
        aggregateSha256: TARGET_SHA,
        messageCount: 2,
        groupedCount: 1,
        toolArchiveCount: 0,
        chunks: [
          {
            tableName: 'chat_messages',
            ordinal: 0,
            sha256: receipt.sha256,
            rowCount: receipt.rowCount,
            byteCount: receipt.byteCount,
            sourceCursor: null,
            sourceHasMore: null,
          },
        ],
        sessionRow: { id: SESSION_ID, status: 'stopped' },
        databaseSizeBytes: 750,
        storageFormat: 'sqlite-v1',
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

      expect(stats.failed).toBe(1);
      expect(source.archiveSourceFinalizeDelete).not.toHaveBeenCalled();
      expect(readMigrationRow(sqlite)).toMatchObject({ state: 'failed' });
    } finally {
      sqlite.close();
    }
  });

  it('keeps the first persisted byte and row layout when retry configuration changes', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedMigration(sqlite, 'copying', { sourceIntentToken: 'old-token' });
      for (const tableName of ['chat_messages', 'chat_messages_grouped', 'tool_payload_archives']) {
        sqlite
          .prepare(
            `INSERT INTO project_data_archive_copy_checkpoints (
               migration_id, table_name, storage_format, chunk_rows, chunk_bytes,
               next_ordinal, complete, copied_rows, copied_bytes, lease_epoch, updated_at
             ) VALUES (?, ?, 'sqlite-v1', 7, 700, 0, 0, 0, 0, 0, ?)`
          )
          .run(MIGRATION_ID, tableName, NOW - 1000);
      }
      const source = createFakeSource({ state: 'intent_prepared', token: 'old-token' });
      const target = createFakeTarget();
      const stats = await runProjectDataArchiveSharding(
        makeEnv(sqlite, {
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_CHUNK_ROWS: '99',
          PROJECT_DATA_ARCHIVE_CHUNK_BYTES: '9999',
          PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
          PROJECT_DATA: createProjectDataNamespace({
            [SOURCE_OWNER]: source,
            [TARGET_OWNER]: target,
          }),
        }),
        new Date(NOW)
      );

      expect(stats.migrated).toBe(1);
      for (const [input] of source.archiveSourceExportChunk.mock.calls) {
        expect(input).toMatchObject({ maxRows: 7, maxBytes: 700 });
      }
    } finally {
      sqlite.close();
    }
  });

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

  it('excludes oversized compact sessions before the candidate limit while retaining smaller work', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedSized(sqlite);
      const result = await runScopedProjectDataArchiveCanary(
        makeEnv(sqlite, {
          PROJECT_DATA_ARCHIVE_COMPACT_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET: '100',
        }),
        { projectId: PROJECT_ID, dryRun: true, limit: 1, nowDate: new Date(NOW) }
      );
      expect(result.selected.map((candidate) => candidate.sessionId)).toEqual(['session-small']);
      expect(countMigrations(sqlite)).toBe(0);
      expect(
        await dryRunSelection(sqlite, {
          PROJECT_DATA_ARCHIVE_COMPACT_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET: '1',
        })
      ).toEqual([]);
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

describe('archive-sharding breaker opens only for systemic poisoning', () => {
  const HOUR = 60 * 60 * 1000;

  /** A failed journal one attempt short of the poison limit, past the retry delay. */
  function seedExhaustedFailure(sqlite: Database.Database, sessionId: string): string {
    seedSessionSummary(sqlite, { sessionId, messageCount: 500 });
    return seedMigration(sqlite, 'failed', {
      migrationId: `migration-${sessionId}`,
      sessionId,
      leaseExpiresAt: null,
      attemptCount: 2,
      updatedAt: NOW - 2 * HOUR,
    });
  }

  /** A historical poisoned journal with no live location row (an earlier generation). */
  function seedPoisonHistory(
    sqlite: Database.Database,
    input: { migrationId: string; sessionId: string; poisonedAt: number }
  ): void {
    sqlite
      .prepare(
        `INSERT INTO project_data_archive_migrations
           (migration_id, project_id, session_id, state, source_owner_name, target_owner_name,
            target_generation, lease_epoch, attempt_count, error_code, poisoned_at,
            created_at, updated_at)
         VALUES (?, ?, ?, 'poisoned', ?, ?, 1, 0, 3, 'attempts_exhausted:Error', ?, 1000, ?)`
      )
      .run(
        input.migrationId,
        PROJECT_ID,
        input.sessionId,
        PROJECT_ID,
        TARGET_OWNER,
        input.poisonedAt,
        input.poisonedAt
      );
  }

  function breaker(sqlite: Database.Database) {
    return sqlite
      .prepare(
        'SELECT state, reason, updated_at FROM project_data_archive_circuit_breakers WHERE project_id = ?'
      )
      .get(PROJECT_ID) as { state: string; reason: string; updated_at: number } | undefined;
  }

  function journal(sqlite: Database.Database, migrationId: string) {
    return sqlite
      .prepare(
        `SELECT state, error_code, attempt_count, poisoned_at
         FROM project_data_archive_migrations WHERE migration_id = ?`
      )
      .get(migrationId) as Record<string, unknown>;
  }

  /** One real sweep tick whose source object fails every call with `error`. */
  async function failingSweep(
    sqlite: Database.Database,
    error: Error,
    overrides: Partial<Env> = {}
  ) {
    const source = createFakeSource();
    source.ensureProjectId.mockRejectedValue(error);
    const stats = await runProjectDataArchiveSharding(
      makeEnv(sqlite, {
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
        PROJECT_DATA: createProjectDataNamespace({
          [SOURCE_OWNER]: source,
          [TARGET_OWNER]: createFakeTarget(),
        }),
        ...overrides,
      }),
      new Date(NOW)
    );
    sqlite
      .prepare(`UPDATE project_data_archive_global_sweep_cadence SET next_eligible_at = 0`)
      .run();
    return stats;
  }

  /** What the real candidate selector would offer this project next (dry run, no writes). */
  async function selectableSessions(sqlite: Database.Database): Promise<string[]> {
    const result = await runScopedProjectDataArchiveCanary(
      makeEnv(sqlite, {
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
        PROJECT_DATA: createProjectDataNamespace({}),
      }),
      { projectId: PROJECT_ID, dryRun: true, limit: 5, nowDate: new Date(NOW) }
    );
    return result.selected.map((item) => item.sessionId);
  }

  it('quarantines one poisoned session without stopping the rest of the project', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      const poisoned = seedExhaustedFailure(sqlite, 'session-bad');
      seedSessionSummary(sqlite, { sessionId: 'session-next', messageCount: 400 });

      const stats = await failingSweep(sqlite, new Error('shard export failed'), {
        PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '1',
      });

      expect(stats).toMatchObject({ poisoned: 1 });
      expect(journal(sqlite, poisoned)).toMatchObject({
        state: 'poisoned',
        error_code: 'attempts_exhausted:Error',
      });
      expect(readLocationRow(sqlite, 'session-bad')).toMatchObject({ location_state: 'frozen' });
      // The project breaker stays closed, so the real selector still offers the next session:
      // with a breaker that opened on this one poison, this list was empty for five days.
      expect(breaker(sqlite)).toBeUndefined();
      expect(await selectableSessions(sqlite)).toEqual(['session-next']);
    } finally {
      sqlite.close();
    }
  });

  it('opens the breaker at the default threshold of three distinct poisoned sessions', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedExhaustedFailure(sqlite, 'session-a');
      seedExhaustedFailure(sqlite, 'session-b');
      seedSessionSummary(sqlite, { sessionId: 'session-healthy', messageCount: 300 });

      // Two distinct poisons: below the default threshold, the drain keeps going.
      await failingSweep(sqlite, new Error('shard export failed'), {
        PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '2',
      });
      expect(journal(sqlite, 'migration-session-a')).toMatchObject({ state: 'poisoned' });
      expect(journal(sqlite, 'migration-session-b')).toMatchObject({ state: 'poisoned' });
      expect(breaker(sqlite)).toBeUndefined();
      expect(await selectableSessions(sqlite)).toEqual(['session-healthy']);

      // A third distinct session poisoned inside the window is the systemic signal.
      seedExhaustedFailure(sqlite, 'session-c');
      await failingSweep(sqlite, new Error('shard export failed'), {
        PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '1',
      });
      expect(journal(sqlite, 'migration-session-c')).toMatchObject({ state: 'poisoned' });
      expect(breaker(sqlite)).toMatchObject({
        state: 'open',
        reason: 'poison_threshold:3/3:attempts_exhausted:Error',
      });
      expect(await selectableSessions(sqlite)).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('counts only poisons inside the window and after the last breaker close', async () => {
    const env = { PROJECT_DATA_ARCHIVE_BREAKER_POISON_THRESHOLD: '2' };
    async function poisonAfter(
      history: { poisonedAt: number }[],
      closedAt: number | null
    ): Promise<string | undefined> {
      const sqlite = new Database(':memory:');
      try {
        createCoordinatorTables(sqlite);
        history.forEach((entry, index) =>
          seedPoisonHistory(sqlite, {
            migrationId: `old-${index}`,
            sessionId: `session-old-${index}`,
            poisonedAt: entry.poisonedAt,
          })
        );
        if (closedAt !== null) {
          sqlite
            .prepare(
              `INSERT INTO project_data_archive_circuit_breakers (project_id, state, reason, opened_at, updated_at)
               VALUES (?, 'closed', 'Closed from admin UI', NULL, ?)`
            )
            .run(PROJECT_ID, closedAt);
        }
        seedExhaustedFailure(sqlite, 'session-bad');
        await failingSweep(sqlite, new Error('shard export failed'), env);
        expect(journal(sqlite, 'migration-session-bad')).toMatchObject({ state: 'poisoned' });
        return breaker(sqlite)?.state;
      } finally {
        sqlite.close();
      }
    }

    // Control: a poison 2 h ago is inside the 24 h window, so this poison makes two.
    expect(await poisonAfter([{ poisonedAt: NOW - 2 * HOUR }], null)).toBe('open');
    // Outside the window: it does not count.
    expect(await poisonAfter([{ poisonedAt: NOW - 25 * HOUR }], null)).toBeUndefined();
    // Inside the window, but an operator closed the breaker after it: it does not count.
    expect(await poisonAfter([{ poisonedAt: NOW - 2 * HOUR }], NOW - HOUR)).toBe('closed');
  });

  it('counts a session poisoned twice as one distinct session', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      // An earlier generation of the same session was poisoned (then abandoned to root).
      seedPoisonHistory(sqlite, {
        migrationId: 'old-generation',
        sessionId: 'session-bad',
        poisonedAt: NOW - HOUR,
      });
      seedExhaustedFailure(sqlite, 'session-bad');

      await failingSweep(sqlite, new Error('shard export failed'), {
        PROJECT_DATA_ARCHIVE_BREAKER_POISON_THRESHOLD: '2',
      });

      expect(journal(sqlite, 'migration-session-bad')).toMatchObject({ state: 'poisoned' });
      expect(breaker(sqlite)).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it('never poisons on a full Durable Object, so the drain keeps retrying', async () => {
    for (const error of [
      new Error('Exceeded the maximum database size.'),
      new ProjectDataStorageFullError(PROJECT_ID, 'archive_source_prepare'),
      // The same refusal after an RPC boundary: the code survives, the subclass does not.
      Object.assign(new Error('ProjectData refused the archive write'), {
        error: PROJECT_DATA_STORAGE_FULL,
      }),
    ]) {
      const sqlite = new Database(':memory:');
      try {
        createCoordinatorTables(sqlite);
        const migrationId = seedExhaustedFailure(sqlite, 'session-wall');

        const stats = await failingSweep(sqlite, error, {
          PROJECT_DATA_ARCHIVE_BREAKER_POISON_THRESHOLD: '1',
        });

        expect(stats).toMatchObject({ poisoned: 0, failed: 1 });
        // The claim spent attempt 3; the capacity failure refunded it.
        expect(journal(sqlite, migrationId)).toMatchObject({
          state: 'failed',
          error_code: 'storage_full',
          attempt_count: 2,
          poisoned_at: null,
        });
        expect(breaker(sqlite)).toBeUndefined();
      } finally {
        sqlite.close();
      }
    }
  });

  it('does not let capacity failures spend the poison budget', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedSessionSummary(sqlite, { sessionId: 'session-wall', messageCount: 500 });
      const migrationId = seedMigration(sqlite, 'failed', {
        migrationId: 'migration-session-wall',
        sessionId: 'session-wall',
        leaseExpiresAt: null,
        attemptCount: 0,
        updatedAt: NOW - 2 * HOUR,
      });
      const ageFailure = () =>
        sqlite
          .prepare(
            'UPDATE project_data_archive_migrations SET updated_at = ? WHERE migration_id = ?'
          )
          .run(NOW - 2 * HOUR, migrationId);
      // Three capacity failures in a row: each claim spends an attempt, each failure refunds it.
      for (let tick = 0; tick < 3; tick++) {
        await failingSweep(sqlite, new Error('Exceeded the maximum database size.'));
        expect(journal(sqlite, migrationId)).toMatchObject({
          state: 'failed',
          error_code: 'storage_full',
          attempt_count: 0,
        });
        ageFailure();
      }
      // The first ordinary failure afterwards is attempt 1, nowhere near the poison limit.
      await failingSweep(sqlite, new Error('shard export failed'));
      expect(journal(sqlite, migrationId)).toMatchObject({
        state: 'failed',
        error_code: 'Error',
        attempt_count: 1,
      });
    } finally {
      sqlite.close();
    }
  });

  it('keeps an operator-frozen breaker frozen when a poison reaches the threshold', async () => {
    // A migration claimed before an operator froze the project can still fail afterwards.
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      const migrationId = seedMigration(sqlite, 'failed', {
        migrationId: 'migration-in-flight',
        sessionId: 'session-in-flight',
        attemptCount: 3,
      });
      sqlite
        .prepare(
          `INSERT INTO project_data_archive_circuit_breakers (project_id, state, reason, opened_at, updated_at)
           VALUES (?, 'frozen', 'operator hold', ?, ?)`
        )
        .run(PROJECT_ID, NOW - HOUR, NOW - HOUR);

      const poisoned = await poisonProjectDataArchiveMigration(
        makeEnv(sqlite, { PROJECT_DATA_ARCHIVE_BREAKER_POISON_THRESHOLD: '1' }),
        { migrationId, projectId: PROJECT_ID, reason: 'attempts_exhausted:Error', now: NOW }
      );

      expect(poisoned).toBe(true);
      expect(journal(sqlite, migrationId)).toMatchObject({ state: 'poisoned' });
      expect(breaker(sqlite)).toMatchObject({ state: 'frozen', reason: 'operator hold' });
    } finally {
      sqlite.close();
    }
  });

  it('stops admitting a project in the same tick its breaker opens', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedExhaustedFailure(sqlite, 'session-bad');
      seedSessionSummary(sqlite, { sessionId: 'session-next', messageCount: 400 });

      await failingSweep(sqlite, new Error('shard export failed'), {
        PROJECT_DATA_ARCHIVE_BREAKER_POISON_THRESHOLD: '1',
        PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '2',
      });

      expect(breaker(sqlite)).toMatchObject({ state: 'open' });
      // The breaker opened on the reclaimed row before the new candidate's turn, so the
      // candidate was never journaled and never fenced: no location row was ever written.
      expect(readLocationRow(sqlite, 'session-next')).toBeUndefined();
      expect(
        sqlite
          .prepare(
            'SELECT COUNT(*) AS count FROM project_data_archive_migrations WHERE session_id = ?'
          )
          .get('session-next')
      ).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  it('returns a just-fenced candidate to root when an operator freeze wins the claim race', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedSessionSummary(sqlite, { sessionId: 'session-next', messageCount: 400 });
      const database = createSqliteD1(sqlite);
      // Freeze the project right after the candidate's journal batch commits, before its claim.
      const racingDatabase = {
        ...database,
        prepare: database.prepare.bind(database),
        batch: async (statements: D1PreparedStatement[]) => {
          const results = await database.batch(statements);
          sqlite
            .prepare(
              `INSERT INTO project_data_archive_circuit_breakers (project_id, state, reason, opened_at, updated_at)
               VALUES (?, 'frozen', 'operator hold', ?, ?)
               ON CONFLICT(project_id) DO NOTHING`
            )
            .run(PROJECT_ID, NOW, NOW);
          return results;
        },
      } as unknown as D1Database;
      const source = createFakeSource();

      await runProjectDataArchiveSharding(
        {
          ...makeEnv(sqlite, {
            PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
            PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
            PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
            PROJECT_DATA: createProjectDataNamespace({
              [SOURCE_OWNER]: source,
              [TARGET_OWNER]: createFakeTarget(),
            }),
          }),
          DATABASE: racingDatabase,
        } as Env,
        new Date(NOW)
      );

      // The claim was refused, nothing reached the source object, and the fence was unwound.
      expect(source.archiveSourcePrepareIntent).not.toHaveBeenCalled();
      expect(breaker(sqlite)).toMatchObject({ state: 'frozen' });
      expect(readLocationRow(sqlite, 'session-next')).toMatchObject({ location_state: 'root' });
      expect(
        sqlite
          .prepare(
            'SELECT COUNT(*) AS count FROM project_data_archive_migrations WHERE session_id = ?'
          )
          .get('session-next')
      ).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  it('opens on the first poison when the threshold is configured to 1', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedExhaustedFailure(sqlite, 'session-bad');
      seedSessionSummary(sqlite, { sessionId: 'session-next', messageCount: 400 });

      await failingSweep(sqlite, new Error('shard export failed'), {
        PROJECT_DATA_ARCHIVE_BREAKER_POISON_THRESHOLD: '1',
        PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '1',
      });

      expect(breaker(sqlite)).toMatchObject({
        state: 'open',
        reason: 'poison_threshold:1/1:attempts_exhausted:Error',
      });
      expect(await selectableSessions(sqlite)).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('leaves a reclaimed failure untouched when a sibling opened the breaker earlier in the tick', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedExhaustedFailure(sqlite, 'session-a');
      seedExhaustedFailure(sqlite, 'session-b');
      // Reclaimed rows were claimed before, so unlike a fresh candidate they carry a lease epoch.
      sqlite.prepare('UPDATE project_data_archive_migrations SET lease_epoch = 1').run();

      const stats = await failingSweep(sqlite, new Error('shard export failed'), {
        PROJECT_DATA_ARCHIVE_BREAKER_POISON_THRESHOLD: '1',
        PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '2',
      });

      expect(stats).toMatchObject({ poisoned: 1 });
      expect(breaker(sqlite)).toMatchObject({ state: 'open' });
      const sessions = ['session-a', 'session-b'];
      const refusedSession = sessions.find(
        (sessionId) => journal(sqlite, `migration-${sessionId}`).state !== 'poisoned'
      );
      expect(refusedSession).toBeDefined();
      // The refused claim spent nothing, and the unwind for never-claimed candidates did not
      // delete the journal or hand the session back to root: it stays fenced by its own row.
      expect(journal(sqlite, `migration-${refusedSession}`)).toMatchObject({
        state: 'failed',
        attempt_count: 2,
      });
      expect(readLocationRow(sqlite, refusedSession)).toMatchObject({
        location_state: 'migrating',
      });
      expect(
        sqlite
          .prepare('SELECT migration_id FROM project_data_session_locations WHERE session_id = ?')
          .get(refusedSession)
      ).toEqual({ migration_id: `migration-${refusedSession}` });
    } finally {
      sqlite.close();
    }
  });

  it('heals an unfrozen poison on replay without re-opening a breaker an operator closed', async () => {
    async function replayAfter(closedAt: number | null) {
      const sqlite = new Database(':memory:');
      try {
        createCoordinatorTables(sqlite);
        seedPoisonHistory(sqlite, {
          migrationId: 'old-a',
          sessionId: 'session-a',
          poisonedAt: NOW - 2 * HOUR,
        });
        seedPoisonHistory(sqlite, {
          migrationId: 'old-b',
          sessionId: 'session-b',
          poisonedAt: NOW - 2 * HOUR,
        });
        // A third poison whose quarantine never landed: poisoned, but its location still fenced
        // `migrating` (what an interrupted, unbatched poison used to leave behind).
        const migrationId = seedMigration(sqlite, 'poisoned', {
          migrationId: 'migration-replayed',
          sessionId: 'session-c',
          updatedAt: NOW - 2 * HOUR,
        });
        sqlite
          .prepare(
            'UPDATE project_data_archive_migrations SET poisoned_at = ? WHERE migration_id = ?'
          )
          .run(NOW - 2 * HOUR, migrationId);
        if (closedAt !== null) {
          sqlite
            .prepare(
              `INSERT INTO project_data_archive_circuit_breakers (project_id, state, reason, opened_at, updated_at)
               VALUES (?, 'closed', 'Closed from admin UI', NULL, ?)`
            )
            .run(PROJECT_ID, closedAt);
        }

        const poisoned = await poisonProjectDataArchiveMigration(makeEnv(sqlite), {
          migrationId,
          projectId: PROJECT_ID,
          reason: 'attempts_exhausted:Error',
          now: NOW,
        });

        return {
          poisoned,
          location: readLocationRow(sqlite, 'session-c')?.location_state,
          breaker: breaker(sqlite)?.state,
        };
      } finally {
        sqlite.close();
      }
    }

    // Closed after the three poisons: the replay freezes the session and nothing else.
    expect(await replayAfter(NOW - HOUR)).toEqual({
      poisoned: false,
      location: 'frozen',
      breaker: 'closed',
    });
    // Control: never closed, three distinct poisons in the window is the open condition.
    expect(await replayAfter(null)).toEqual({
      poisoned: false,
      location: 'frozen',
      breaker: 'open',
    });
  });

  it('keeps an operator close that lands after the tick read its clock', async () => {
    async function poisonAround(input: { closedAt: number; laterPoisons: number[] }) {
      const sqlite = new Database(':memory:');
      try {
        createCoordinatorTables(sqlite);
        // Two sessions poisoned before the close; the third is poisoned by a tick whose clock
        // (NOW) was read before the operator's close at `closedAt`.
        for (const sessionId of ['session-a', 'session-b']) {
          seedPoisonHistory(sqlite, {
            migrationId: `old-${sessionId}`,
            sessionId,
            poisonedAt: NOW - HOUR,
          });
        }
        input.laterPoisons.forEach((poisonedAt, index) =>
          seedPoisonHistory(sqlite, {
            migrationId: `later-${index}`,
            sessionId: `session-later-${index}`,
            poisonedAt,
          })
        );
        sqlite
          .prepare(
            `INSERT INTO project_data_archive_circuit_breakers (project_id, state, reason, opened_at, updated_at)
             VALUES (?, 'closed', 'Closed from admin UI', NULL, ?)`
          )
          .run(PROJECT_ID, input.closedAt);
        const migrationId = seedMigration(sqlite, 'failed', {
          migrationId: 'migration-session-c',
          sessionId: 'session-c',
          attemptCount: 3,
        });

        await poisonProjectDataArchiveMigration(makeEnv(sqlite), {
          migrationId,
          projectId: PROJECT_ID,
          reason: 'attempts_exhausted:Error',
          now: NOW,
        });
        return breaker(sqlite);
      } finally {
        sqlite.close();
      }
    }

    // The close survives: none of the three poisons happened after it.
    expect(await poisonAround({ closedAt: NOW + 60_000, laterPoisons: [] })).toMatchObject({
      state: 'closed',
      updated_at: NOW + 60_000,
    });
    // Control: three distinct sessions poisoned after the close is a new systemic signal, and
    // opening on it does not move the row's clock behind the close.
    expect(
      await poisonAround({
        closedAt: NOW + 60_000,
        laterPoisons: [NOW + 120_000, NOW + 180_000, NOW + 240_000],
      })
    ).toMatchObject({ state: 'open', updated_at: NOW + 60_000 });
  });

  it('never freezes the location of a migration it did not poison', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      // Published between the failure read and the poison: the location flip is still pending.
      const migrationId = seedMigration(sqlite, 'published', {
        migrationId: 'migration-published',
        sessionId: 'session-published',
      });

      const poisoned = await poisonProjectDataArchiveMigration(
        makeEnv(sqlite, { PROJECT_DATA_ARCHIVE_BREAKER_POISON_THRESHOLD: '1' }),
        { migrationId, projectId: PROJECT_ID, reason: 'attempts_exhausted:Error', now: NOW }
      );

      expect(poisoned).toBe(false);
      expect(journal(sqlite, migrationId)).toMatchObject({ state: 'published', poisoned_at: null });
      expect(readLocationRow(sqlite, 'session-published')).toMatchObject({
        location_state: 'migrating',
      });
      expect(breaker(sqlite)).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });
});

describe('archive-sharding capacity backpressure keys on the full object', () => {
  const HOUR = 60 * 60 * 1000;
  const FULL_PROJECT = 'project-full';
  const STORAGE_FULL = 'Exceeded the maximum database size.';
  const ENABLED = {
    PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
    PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
  };

  /** A root object at the per-object cap: every archive call fails the way Cloudflare's does. */
  function createFullSource() {
    const full = vi.fn(async () => {
      throw new Error(STORAGE_FULL);
    });
    return {
      ensureProjectId: full,
      archiveSourceInspectIntent: full,
      archiveSourcePrepareIntent: full,
    };
  }

  /** A fenced journal that already failed against a full object, past the retry delay. */
  function seedCapacityFailure(
    sqlite: Database.Database,
    input: {
      projectId?: string;
      sessionId: string;
      updatedAt: number;
      errorCode?: 'storage_full' | 'storage_full_target';
      targetOwnerName?: string;
    }
  ): string {
    const migrationId = seedMigration(sqlite, 'failed', {
      migrationId: `migration-${input.sessionId}`,
      projectId: input.projectId ?? PROJECT_ID,
      sessionId: input.sessionId,
      leaseExpiresAt: null,
      attemptCount: 1,
      updatedAt: input.updatedAt,
    });
    sqlite
      .prepare(
        `UPDATE project_data_archive_migrations
         SET error_code = ?, lease_epoch = 1, target_owner_name = COALESCE(?, target_owner_name)
         WHERE migration_id = ?`
      )
      .run(input.errorCode ?? 'storage_full', input.targetOwnerName ?? null, migrationId);
    // markFailed records the failure and its object's hold in one batch, so they always coexist.
    seedHold(sqlite, {
      role: input.errorCode === 'storage_full_target' ? 'target' : 'root',
      ownerName:
        input.errorCode === 'storage_full_target'
          ? (input.targetOwnerName ?? TARGET_OWNER)
          : (input.projectId ?? PROJECT_ID),
      projectId: input.projectId ?? PROJECT_ID,
      lastFailureAt: input.updatedAt,
    });
    return migrationId;
  }

  function seedHold(
    sqlite: Database.Database,
    input: { role: 'root' | 'target'; ownerName: string; projectId?: string; lastFailureAt: number }
  ): void {
    sqlite
      .prepare(
        `INSERT INTO project_data_archive_capacity_holds
           (object_kind, owner_name, project_id, opened_at, last_failure_at, failure_count)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(object_kind, owner_name) DO UPDATE SET
           last_failure_at = MAX(last_failure_at, excluded.last_failure_at),
           failure_count = failure_count + 1`
      )
      .run(
        input.role,
        input.ownerName,
        input.projectId ?? PROJECT_ID,
        input.lastFailureAt,
        input.lastFailureAt
      );
  }

  function holds(sqlite: Database.Database) {
    return sqlite
      .prepare(
        'SELECT object_kind, owner_name FROM project_data_archive_capacity_holds ORDER BY object_kind, owner_name'
      )
      .all();
  }

  function journalRow(sqlite: Database.Database, migrationId: string) {
    return sqlite
      .prepare(
        `SELECT state, error_code, attempt_count, updated_at
         FROM project_data_archive_migrations WHERE migration_id = ?`
      )
      .get(migrationId) as Record<string, unknown>;
  }

  async function sweep(sqlite: Database.Database, stubs: (id: string) => unknown, overrides = {}) {
    const stats = await runProjectDataArchiveSharding(
      makeEnv(sqlite, {
        ...ENABLED,
        PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
        PROJECT_DATA: { idFromName: (name: string) => name, get: stubs } as never,
        ...overrides,
      }),
      new Date(NOW)
    );
    sqlite
      .prepare(`UPDATE project_data_archive_global_sweep_cadence SET next_eligible_at = 0`)
      .run();
    return stats;
  }

  /** What the scoped canary would select for a project right now (dry run, no writes). */
  async function selectable(sqlite: Database.Database, projectId: string): Promise<string[]> {
    const result = await runScopedProjectDataArchiveCanary(
      makeEnv(sqlite, {
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
        PROJECT_DATA: createProjectDataNamespace({}),
      }),
      { projectId, dryRun: true, limit: 5, nowDate: new Date(NOW) }
    );
    return result.selected.map((item) => item.sessionId);
  }

  it('keeps one full root from taking the sweep from healthy work elsewhere', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      const failures = [3, 2.5, 2].map((age, index) =>
        seedCapacityFailure(sqlite, {
          projectId: FULL_PROJECT,
          sessionId: `session-full-${index}`,
          updatedAt: NOW - age * HOUR,
        })
      );
      // The full project also has the largest eligible session, so it is offered first.
      seedSessionSummary(sqlite, {
        projectId: FULL_PROJECT,
        sessionId: 'session-full-fresh',
        messageCount: 900,
      });
      seedSessionSummary(sqlite, { sessionId: SESSION_ID, messageCount: 10 });
      const fullSource = createFullSource();
      const healthySource = createFakeSource();

      await sweep(
        sqlite,
        (id) =>
          id === FULL_PROJECT
            ? fullSource
            : id === SOURCE_OWNER
              ? healthySource
              : createFakeTarget(),
        { PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '3' }
      );

      // One probe against the full root (the oldest), refunded; the other two wait their turn.
      expect(failures.map((id) => journalRow(sqlite, id).updated_at === NOW)).toEqual([
        true,
        false,
        false,
      ]);
      expect(journalRow(sqlite, failures[0]!)).toMatchObject({
        state: 'failed',
        error_code: 'storage_full',
        attempt_count: 1,
      });
      // Nothing new is fenced into the full object (the same reader does see its probe's fence)...
      expect(readLocationRow(sqlite, 'session-full-0', FULL_PROJECT)).toMatchObject({
        location_state: 'migrating',
      });
      expect(readLocationRow(sqlite, 'session-full-fresh', FULL_PROJECT)).toBeUndefined();
      // ...and the healthy project's session archives in the same tick.
      expect(readLocationRow(sqlite, SESSION_ID)).toMatchObject({
        location_state: 'archive_shard',
      });
    } finally {
      sqlite.close();
    }
  });

  it('resumes admission and normal retries once a probe finds headroom on the held root', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      const older = seedCapacityFailure(sqlite, {
        sessionId: SESSION_ID,
        updatedAt: NOW - 3 * HOUR,
      });
      seedCapacityFailure(sqlite, { sessionId: 'session-newer', updatedAt: NOW - 2 * HOUR });
      seedSessionSummary(sqlite, { sessionId: 'session-fresh', messageCount: 50 });

      // While the root is refusing: one probe, and no admission.
      expect(await selectable(sqlite, PROJECT_ID)).toEqual([SESSION_ID]);

      // The root has room again: the sweep's probe measures it and releases the hold first...
      const source = createFakeSource();
      source.archiveCapacityProbe.mockResolvedValue({ databaseSizeBytes: 1_000_000 });
      await sweep(sqlite, (id) => (id === SOURCE_OWNER ? source : createFakeTarget()), {
        PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '1',
      });
      expect(holds(sqlite)).toEqual([]);
      expect(journalRow(sqlite, older)).toMatchObject({ state: 'published' });

      // ...which lifts both bounds: the other failure retries at the normal pace, admission resumes.
      expect(await selectable(sqlite, PROJECT_ID)).toEqual(['session-newer', 'session-fresh']);
    } finally {
      sqlite.close();
    }
  });

  it('keeps admission held while the probe is in flight', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      const probe = seedCapacityFailure(sqlite, {
        sessionId: SESSION_ID,
        updatedAt: NOW - 3 * HOUR,
      });
      seedSessionSummary(sqlite, { sessionId: 'session-fresh', messageCount: 50 });
      let release: () => void = () => undefined;
      const prepareGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const source = createFakeSource();
      source.archiveSourcePrepareIntent.mockImplementation(async () => {
        await prepareGate;
        throw new Error(STORAGE_FULL);
      });

      const tick = sweep(sqlite, (id) => (id === SOURCE_OWNER ? source : createFakeTarget()), {
        PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '2',
      });
      await vi.waitFor(() => expect(source.archiveSourcePrepareIntent).toHaveBeenCalled());
      // Mid-probe the journal is claimed, not failed, yet the object is still held.
      expect(journalRow(sqlite, probe)).toMatchObject({ state: 'leased' });
      expect(await selectable(sqlite, PROJECT_ID)).toEqual([]);

      release();
      await tick;
      expect(journalRow(sqlite, probe)).toMatchObject({
        state: 'failed',
        error_code: 'storage_full',
      });
      expect(holds(sqlite)).toEqual([{ object_kind: 'root', owner_name: PROJECT_ID }]);
      expect(readLocationRow(sqlite, 'session-fresh')).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it('never takes a re-aligned probe for recovery before a run completes', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      const probe = seedCapacityFailure(sqlite, {
        sessionId: SESSION_ID,
        updatedAt: NOW - 3 * HOUR,
      });
      seedSessionSummary(sqlite, { sessionId: 'session-fresh', messageCount: 50 });
      // The source still holds an old proof that is past the failed prepare; the worker then dies
      // during finalize, before any completion.
      const source = createFakeSource({ state: 'recovery_manifest_persisted', token: 'old-token' });
      source.archiveSourceFinalizeDelete.mockRejectedValue(new Error('isolate evicted'));

      await sweep(sqlite, (id) => (id === SOURCE_OWNER ? source : createFakeTarget()));

      expect(journalRow(sqlite, probe)).toMatchObject({ state: 'failed', error_code: 'Error' });
      expect(holds(sqlite)).toEqual([{ object_kind: 'root', owner_name: PROJECT_ID }]);
      // Nothing was fenced into the root during that tick, and nothing will be next.
      expect(readLocationRow(sqlite, 'session-fresh')).toBeUndefined();
      expect(await selectable(sqlite, PROJECT_ID)).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it.each([
    [
      'finalize',
      'recovery_manifest_persisted',
      'archiveSourceFinalizeDelete',
      'storage_full',
      'root',
    ],
    ['the source seal mark', 'copying', 'archiveSourceMarkTargetSealed', 'storage_full', 'root'],
    ['target initialization', 'leased', 'ensureTargetProjectId', 'storage_full_target', 'target'],
  ] as const)(
    'records a full object at %s against the object that refused',
    async (_step, journalState, failingCall, errorCode, role) => {
      const sqlite = new Database(':memory:');
      try {
        createCoordinatorTables(sqlite);
        seedMigration(sqlite, journalState, { sourceIntentToken: 'old-token' });
        const source = createFakeSource({
          state:
            journalState === 'leased'
              ? null
              : journalState === 'copying'
                ? 'intent_prepared'
                : journalState,
          token: 'old-token',
        });
        const target = createFakeTarget();
        if (failingCall === 'ensureTargetProjectId') {
          target.ensureProjectId.mockRejectedValue(new Error(STORAGE_FULL));
        } else {
          source[failingCall].mockRejectedValue(new Error(STORAGE_FULL));
        }

        await sweep(sqlite, (id) => (id === SOURCE_OWNER ? source : target));

        expect(journalRow(sqlite, MIGRATION_ID)).toMatchObject({
          state: 'failed',
          error_code: errorCode,
        });
        expect(holds(sqlite)).toEqual([
          { object_kind: role, owner_name: role === 'root' ? PROJECT_ID : TARGET_OWNER },
        ]);
      } finally {
        sqlite.close();
      }
    }
  );

  it('clears a hold only when a probe of its object measures headroom', async () => {
    async function probeOnce(
      databaseSizeBytes: number | Error,
      lastFailureAt = NOW - 3 * HOUR
    ): Promise<{ holds: unknown[]; lastFailureAt: number | undefined }> {
      const sqlite = new Database(':memory:');
      try {
        createCoordinatorTables(sqlite);
        seedHold(sqlite, { role: 'root', ownerName: PROJECT_ID, lastFailureAt });
        const source = createFakeSource();
        if (databaseSizeBytes instanceof Error) {
          source.archiveCapacityProbe.mockRejectedValue(databaseSizeBytes);
        } else {
          source.archiveCapacityProbe.mockResolvedValue({ databaseSizeBytes });
        }
        await sweep(sqlite, (id) => (id === SOURCE_OWNER ? source : createFakeTarget()));
        expect(source.archiveCapacityProbe).toHaveBeenCalledTimes(1);
        const row = sqlite
          .prepare('SELECT last_failure_at FROM project_data_archive_capacity_holds')
          .get() as { last_failure_at: number } | undefined;
        return { holds: holds(sqlite), lastFailureAt: row?.last_failure_at };
      } finally {
        sqlite.close();
      }
    }
    const CAP = DEFAULT_PROJECT_DATA_STORAGE_HARD_CAP_BYTES;
    const HEADROOM = 64 * 1024 * 1024;

    // Headroom: released.
    expect((await probeOnce(CAP - HEADROOM)).holds).toEqual([]);
    // Still full: kept, and refreshed so it cannot lapse while the object stays full.
    const stillFull = await probeOnce(CAP - HEADROOM + 1);
    expect(stillFull.holds).toEqual([{ object_kind: 'root', owner_name: PROJECT_ID }]);
    expect(stillFull.lastFailureAt).toBeGreaterThan(NOW - 3 * HOUR);
    // A failure recorded after the probe started survives the clear.
    expect((await probeOnce(1_000_000, Date.now() + 10 * 60_000)).holds).toEqual([
      { object_kind: 'root', owner_name: PROJECT_ID },
    ]);
    // A probe that throws changes nothing.
    const unreachable = await probeOnce(new Error('object unreachable'));
    expect(unreachable).toEqual({
      holds: [{ object_kind: 'root', owner_name: PROJECT_ID }],
      lastFailureAt: NOW - 3 * HOUR,
    });
  });

  it('probes every hold in turn when some held objects cannot be reached', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      // Zero-padded so the reachable object also sorts last by name.
      const owners = Array.from(
        { length: 11 },
        (_, index) => `${PROJECT_ID}:archive:g1:s${String(index).padStart(2, '0')}`
      );
      // Equal ages: ordered by failure age alone, the same ten unreachable objects took every
      // probe until their holds expired, and the reachable one was never measured.
      for (const ownerName of owners) {
        seedHold(sqlite, { role: 'target', ownerName, lastFailureAt: NOW - HOUR });
      }
      const probed: string[] = [];
      const stubs = (id: string) => {
        if (id === SOURCE_OWNER) return createFakeSource();
        const target = createFakeTarget();
        target.archiveCapacityProbe.mockImplementation(async () => {
          probed.push(id);
          if (id !== owners[10]) throw new Error('object unreachable');
          return { databaseSizeBytes: 1_000_000 };
        });
        return target;
      };

      await sweep(sqlite, stubs);
      expect(probed).toEqual(owners.slice(0, 10));
      expect(holds(sqlite)).toHaveLength(11);

      await sweep(sqlite, stubs);
      // The next sweep measures the object nobody has probed yet, and its headroom clears it.
      expect(probed[10]).toBe(owners[10]);
      expect(holds(sqlite)).toEqual(
        owners.slice(0, 10).map((owner_name) => ({ object_kind: 'target', owner_name }))
      );
      // A failed probe neither refreshed nor cleared the unreachable objects' holds.
      const ages = sqlite
        .prepare('SELECT DISTINCT last_failure_at FROM project_data_archive_capacity_holds')
        .all();
      expect(ages).toEqual([{ last_failure_at: NOW - HOUR }]);
    } finally {
      sqlite.close();
    }
  });

  it('never clears a hold because a migration published, however it got there', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      // A resumed journal publishes after root-only writes and a replayed (cached) target seal,
      // while the target shard is still full.
      seedMigration(sqlite, 'target_sealed', { sourceIntentToken: 'old-token' });
      seedHold(sqlite, { role: 'target', ownerName: TARGET_OWNER, lastFailureAt: NOW - 3 * HOUR });
      const source = createFakeSource({ state: 'target_sealed', token: 'old-token' });
      const target = createFakeTarget();

      await sweep(sqlite, (id) => (id === SOURCE_OWNER ? source : target));

      expect(journalRow(sqlite, MIGRATION_ID)).toMatchObject({ state: 'published' });
      expect(target.archiveCapacityProbe).toHaveBeenCalled();
      expect(holds(sqlite)).toEqual([{ object_kind: 'target', owner_name: TARGET_OWNER }]);
    } finally {
      sqlite.close();
    }
  });

  it('never opens a hold from a stale failure handler whose journal update changed nothing', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedSessionSummary(sqlite, { sessionId: SESSION_ID, messageCount: 10 });
      const source = createFakeSource();
      source.archiveSourcePrepareIntent.mockRejectedValue(new Error(STORAGE_FULL));
      // A successor publishes between the failure handler's read and its batch.
      const database = createSqliteD1(sqlite) as unknown as {
        prepare: (sql: string) => { bind: (...params: unknown[]) => object };
        batch: (statements: object[]) => Promise<unknown>;
      };
      const sqlOf = new WeakMap<object, string>();
      const racing = {
        ...database,
        prepare: (sql: string) => {
          const prepared = database.prepare(sql);
          return {
            ...prepared,
            bind: (...params: unknown[]) => {
              const bound = prepared.bind(...params);
              sqlOf.set(bound, sql);
              return bound;
            },
          };
        },
        batch: async (statements: object[]) => {
          if (
            statements.some((statement) =>
              (sqlOf.get(statement) ?? '').includes(
                'INSERT INTO project_data_archive_capacity_holds'
              )
            )
          ) {
            sqlite
              .prepare(
                `UPDATE project_data_archive_migrations SET state = 'published', lease_owner = NULL WHERE session_id = ?`
              )
              .run(SESSION_ID);
          }
          return database.batch(statements);
        },
      } as unknown as D1Database;

      await runProjectDataArchiveSharding(
        makeEnv(sqlite, {
          ...ENABLED,
          DATABASE: racing,
          PROJECT_DATA_ARCHIVE_R2: createMemoryR2(),
          PROJECT_DATA: {
            idFromName: (name: string) => name,
            get: (id: string) => (id === SOURCE_OWNER ? source : createFakeTarget()),
          } as never,
        }),
        new Date(NOW)
      );

      expect(
        sqlite
          .prepare('SELECT state FROM project_data_archive_migrations WHERE session_id = ?')
          .get(SESSION_ID)
      ).toEqual({ state: 'published' });
      expect(holds(sqlite)).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('stops gating admission once no probe has refreshed a hold for its maximum age', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedSessionSummary(sqlite, { sessionId: 'session-fresh', messageCount: 50 });
      seedHold(sqlite, { role: 'root', ownerName: PROJECT_ID, lastFailureAt: NOW - 5 * HOUR });
      expect(await selectable(sqlite, PROJECT_ID)).toEqual([]);
      sqlite
        .prepare('UPDATE project_data_archive_capacity_holds SET last_failure_at = ?')
        .run(NOW - 7 * HOUR);
      expect(await selectable(sqlite, PROJECT_ID)).toEqual(['session-fresh']);
    } finally {
      sqlite.close();
    }
  });

  it('pauses only the full target shard, not the rest of the project', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      const shardEnv = { PROJECT_DATA_ARCHIVE_SHARD_COUNT: '2' };
      const targetOf = (sessionId: string) =>
        archiveShardProjectDataOwner(makeEnv(sqlite, shardEnv), PROJECT_ID, sessionId, 1).ownerName;
      // Two eligible sessions that land on different shards (the hash is deterministic).
      const names = Array.from({ length: 20 }, (_, index) => `session-shard-${index}`);
      const onFullShard = names[0]!;
      const fullShard = targetOf(onFullShard);
      const onOtherShard = names.find((name) => targetOf(name) !== fullShard)!;
      seedSessionSummary(sqlite, { sessionId: onFullShard, messageCount: 900 });
      seedSessionSummary(sqlite, { sessionId: onOtherShard, messageCount: 10 });
      // A recent failure against that shard, still inside its retry delay.
      seedCapacityFailure(sqlite, {
        sessionId: 'session-stuck',
        updatedAt: NOW - 60_000,
        errorCode: 'storage_full_target',
        targetOwnerName: fullShard,
      });
      const source = createFakeSource();

      await sweep(sqlite, (id) => (id === SOURCE_OWNER ? source : createFakeTarget()), {
        ...shardEnv,
        PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '2',
      });

      expect(readLocationRow(sqlite, onFullShard)).toBeUndefined();
      expect(readLocationRow(sqlite, onOtherShard)).toMatchObject({
        location_state: 'archive_shard',
      });
    } finally {
      sqlite.close();
    }
  });

  it.each(['intent_prepared', 'target_prepared', 'copying'] as const)(
    'records a full root against the root when a resumed %s journal re-prepares the source',
    async (journalState) => {
      const sqlite = new Database(':memory:');
      try {
        createCoordinatorTables(sqlite);
        seedMigration(sqlite, journalState, { sourceIntentToken: 'old-token' });
        // The source has the intent, but re-preparing it is a root write and the root is full.
        const source = createFakeSource({ state: 'intent_prepared', token: 'old-token' });
        source.archiveSourcePrepareIntent.mockRejectedValue(new Error(STORAGE_FULL));
        const target = createFakeTarget();

        await sweep(sqlite, (id) => (id === SOURCE_OWNER ? source : target));

        expect(journalRow(sqlite, MIGRATION_ID)).toMatchObject({
          state: 'failed',
          error_code: 'storage_full',
        });
        // Liveness: the run reached the root re-prepare, and never wrote to the target.
        expect(source.archiveSourcePrepareIntent).toHaveBeenCalledTimes(1);
        expect(target.archiveTargetCommitChunk).not.toHaveBeenCalled();
      } finally {
        sqlite.close();
      }
    }
  );

  it('records a full target shard against the shard, not the root', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      seedSessionSummary(sqlite, { sessionId: SESSION_ID, messageCount: 10 });
      const source = createFakeSource();
      const fullTarget = createFakeTarget();
      fullTarget.archiveTargetPrepare.mockRejectedValue(new Error(STORAGE_FULL));

      const stats = await sweep(sqlite, (id) => (id === SOURCE_OWNER ? source : fullTarget));

      expect(stats).toMatchObject({ failed: 1, poisoned: 0 });
      const row = sqlite
        .prepare(
          `SELECT state, error_code, attempt_count, target_owner_name
           FROM project_data_archive_migrations WHERE session_id = ?`
        )
        .get(SESSION_ID);
      // The claim's attempt is refunded, and the session stays fenced for the retry.
      expect(row).toMatchObject({
        state: 'failed',
        error_code: 'storage_full_target',
        attempt_count: 0,
        target_owner_name: archiveShardProjectDataOwner(makeEnv(sqlite), PROJECT_ID, SESSION_ID, 1)
          .ownerName,
      });
      // The root still accepts writes, so the rest of the project keeps being offered.
      seedSessionSummary(sqlite, { sessionId: 'session-next', messageCount: 5 });
      expect(await selectable(sqlite, PROJECT_ID)).toContain('session-next');
    } finally {
      sqlite.close();
    }
  });
});
