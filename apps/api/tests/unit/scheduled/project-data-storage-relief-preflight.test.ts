import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { runProjectDataStorageReliefPreflight } from '../../../src/scheduled/project-data-storage-relief-preflight';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const PROJECT_ID = 'project-preflight';
const PLAN_ID = 'capacity-emergency-2026-09-03';
const NOW = Date.UTC(2026, 8, 3, 22, 0, 0);
const CUTOFF = NOW - 5 * 24 * 60 * 60 * 1000;

function createTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    INSERT INTO projects (id) VALUES ('${PROJECT_ID}');
    CREATE TABLE project_data_storage_relief_preflights (
      plan_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      cutoff_created_at INTEGER NOT NULL,
      cursor_json TEXT,
      batches_started INTEGER NOT NULL DEFAULT 0,
      rows_examined INTEGER NOT NULL DEFAULT 0,
      eligible_rows INTEGER NOT NULL DEFAULT 0,
      eligible_bytes INTEGER NOT NULL DEFAULT 0,
      legacy_oversized_rows INTEGER NOT NULL DEFAULT 0,
      legacy_oversized_bytes INTEGER NOT NULL DEFAULT 0,
      rearchivable_oversized_rows INTEGER NOT NULL DEFAULT 0,
      rearchivable_oversized_bytes INTEGER NOT NULL DEFAULT 0,
      oversized_rows INTEGER NOT NULL DEFAULT 0,
      oversized_bytes INTEGER NOT NULL DEFAULT 0,
      archived_rows INTEGER NOT NULL DEFAULT 0,
      skipped_rows INTEGER NOT NULL DEFAULT 0,
      session_count INTEGER NOT NULL DEFAULT 0,
      sessions_json TEXT NOT NULL DEFAULT '{}',
      sessions_sha256 TEXT,
      database_size_bytes INTEGER,
      next_eligible_at INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at INTEGER,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      last_error TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
}

function toolResult(input: {
  sessionId: string;
  eligibleRows: number;
  eligibleBytes: number;
  cursor: { sessionId: string; createdAt: number; sequence: number; messageId: string } | null;
  hasMore: boolean;
}) {
  return {
    measuredAt: NOW,
    databaseSizeBytes: 9_884_188_672,
    limit: 2,
    grouped: {
      rowsExamined: 0,
      rows: 0,
      contentBytes: 0,
      eligibleRows: 0,
      eligibleContentBytes: 0,
      ftsRowsPresent: 0,
      ftsRowsMissing: 0,
      nextCursor: null,
      hasMore: false,
    },
    toolPayloads: {
      rowsExamined: input.eligibleRows,
      eligibleRows: input.eligibleRows,
      eligibleBytes: input.eligibleBytes,
      legacyOversizedRows: 0,
      legacyOversizedBytes: 0,
      rearchivableOversizedRows: 0,
      rearchivableOversizedBytes: 0,
      oversizedRows: 0,
      oversizedBytes: 0,
      archivedRows: 0,
      skippedRows: 0,
      sessions: [
        {
          sessionId: input.sessionId,
          rowsExamined: input.eligibleRows,
          eligibleRows: input.eligibleRows,
          eligibleBytes: input.eligibleBytes,
          legacyOversizedRows: 0,
          legacyOversizedBytes: 0,
          rearchivableOversizedRows: 0,
          rearchivableOversizedBytes: 0,
          oversizedRows: 0,
          oversizedBytes: 0,
          archivedRows: 0,
          skippedRows: 0,
        },
      ],
      nextCursor: input.cursor,
      hasMore: input.hasMore,
    },
  };
}

function makeEnv(
  sqlite: Database.Database,
  measureStorageRelief: ReturnType<typeof vi.fn>,
  overrides: Partial<Env> = {}
): Env {
  const stub = {
    ensureProjectId: vi.fn(async () => undefined),
    measureStorageRelief,
  };
  return {
    DATABASE: createSqliteD1(sqlite),
    PROJECT_DATA: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => stub,
    } as unknown as DurableObjectNamespace,
    PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_ENABLED: 'true',
    PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_PLAN_ID: PLAN_ID,
    PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_PROJECT_ID: PROJECT_ID,
    PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_CUTOFF_CREATED_AT: String(CUTOFF),
    PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_BATCH_ROWS: '2',
    PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_INTERVAL_MS: '1000',
    PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_BATCHES: '10',
    PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_ROWS: '10',
    PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_BYTES: '10000',
    PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_LEASE_MS: '5000',
    ...overrides,
  } as Env;
}

function readRun(sqlite: Database.Database): Record<string, unknown> | undefined {
  return sqlite
    .prepare('SELECT * FROM project_data_storage_relief_preflights WHERE plan_id = ?')
    .get(PLAN_ID) as Record<string, unknown> | undefined;
}

describe('scheduled ProjectData storage relief preflight', () => {
  it('is disabled by default and never calls ProjectData', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      const measure = vi.fn();
      const result = await runProjectDataStorageReliefPreflight(
        makeEnv(sqlite, measure, { PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_ENABLED: 'false' }),
        new Date(NOW)
      );

      expect(result).toMatchObject({ enabled: false, skipped: true, skipReason: 'disabled' });
      expect(measure).not.toHaveBeenCalled();
      expect(readRun(sqlite)).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it('resumes a fixed-cutoff scan, persists exact totals, and completes without rescanning', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      const cursor = {
        sessionId: 'session-a',
        createdAt: CUTOFF - 10,
        sequence: 2,
        messageId: 'message-2',
      };
      const measure = vi
        .fn()
        .mockResolvedValueOnce(
          toolResult({
            sessionId: 'session-a',
            eligibleRows: 2,
            eligibleBytes: 1200,
            cursor,
            hasMore: true,
          })
        )
        .mockResolvedValueOnce(
          toolResult({
            sessionId: 'session-b',
            eligibleRows: 1,
            eligibleBytes: 400,
            cursor: null,
            hasMore: false,
          })
        );
      const env = makeEnv(sqlite, measure);

      const first = await runProjectDataStorageReliefPreflight(env, new Date(NOW));
      expect(first).toMatchObject({ status: 'running', eligibleRows: 2, eligibleBytes: 1200 });
      expect(measure).toHaveBeenNthCalledWith(1, {
        cursor: null,
        limit: 2,
        surface: 'tool_payloads',
        cutoffCreatedAt: CUTOFF,
      });

      const cadenceSkip = await runProjectDataStorageReliefPreflight(env, new Date(NOW + 500));
      expect(cadenceSkip).toMatchObject({ skipped: true, skipReason: 'cadence' });
      expect(measure).toHaveBeenCalledTimes(1);

      const second = await runProjectDataStorageReliefPreflight(env, new Date(NOW + 1000));
      expect(second).toMatchObject({ status: 'complete', eligibleRows: 3, eligibleBytes: 1600 });
      expect(measure).toHaveBeenNthCalledWith(2, {
        cursor: { toolPayload: cursor },
        limit: 2,
        surface: 'tool_payloads',
        cutoffCreatedAt: CUTOFF,
      });
      expect(readRun(sqlite)).toMatchObject({
        status: 'complete',
        cutoff_created_at: CUTOFF,
        batches_started: 2,
        rows_examined: 3,
        eligible_rows: 3,
        eligible_bytes: 1600,
        session_count: 2,
        sessions_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        cursor_json: null,
        completed_at: NOW + 1000,
      });
      expect(JSON.parse(String(readRun(sqlite)?.sessions_json))).toEqual({
        'session-a': expect.objectContaining({ eligibleRows: 2, eligibleBytes: 1200 }),
        'session-b': expect.objectContaining({ eligibleRows: 1, eligibleBytes: 400 }),
      });

      const terminalSkip = await runProjectDataStorageReliefPreflight(env, new Date(NOW + 5000));
      expect(terminalSkip).toMatchObject({ skipped: true, skipReason: 'terminal' });
      expect(measure).toHaveBeenCalledTimes(2);
    } finally {
      sqlite.close();
    }
  });

  it('fails closed before ProjectData when exact plan scope is missing', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      const measure = vi.fn();
      const result = await runProjectDataStorageReliefPreflight(
        makeEnv(sqlite, measure, { PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_PROJECT_ID: '' }),
        new Date(NOW)
      );

      expect(result).toMatchObject({
        enabled: true,
        skipped: true,
        skipReason: 'invalid_config',
      });
      expect(measure).not.toHaveBeenCalled();
      expect(readRun(sqlite)).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it('fails closed before ProjectData when the fixed cutoff is in the future', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      const measure = vi.fn();
      const result = await runProjectDataStorageReliefPreflight(
        makeEnv(sqlite, measure, {
          PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_CUTOFF_CREATED_AT: String(NOW + 1),
        }),
        new Date(NOW)
      );

      expect(result).toMatchObject({
        enabled: true,
        skipped: true,
        skipReason: 'invalid_config',
      });
      expect(measure).not.toHaveBeenCalled();
      expect(readRun(sqlite)).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it('fails closed before ProjectData when the fixed cutoff has trailing garbage', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      const measure = vi.fn();
      const result = await runProjectDataStorageReliefPreflight(
        makeEnv(sqlite, measure, {
          PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_CUTOFF_CREATED_AT: '123garbage',
        }),
        new Date(NOW)
      );

      expect(result).toMatchObject({ skipped: true, skipReason: 'invalid_config' });
      expect(measure).not.toHaveBeenCalled();
      expect(readRun(sqlite)).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it('stops at the configured total row ceiling even when the source has more', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      const measure = vi.fn().mockResolvedValue(
        toolResult({
          sessionId: 'session-a',
          eligibleRows: 2,
          eligibleBytes: 1200,
          cursor: {
            sessionId: 'session-a',
            createdAt: CUTOFF - 10,
            sequence: 2,
            messageId: 'message-2',
          },
          hasMore: true,
        })
      );
      const result = await runProjectDataStorageReliefPreflight(
        makeEnv(sqlite, measure, { PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_ROWS: '2' }),
        new Date(NOW)
      );

      expect(result).toMatchObject({ status: 'truncated', eligibleRows: 2, eligibleBytes: 1200 });
      expect(readRun(sqlite)).toMatchObject({ status: 'truncated', completed_at: NOW });
    } finally {
      sqlite.close();
    }
  });
});
