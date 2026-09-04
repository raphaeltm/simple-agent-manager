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
      config_json TEXT NOT NULL,
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
      target_batches_json TEXT NOT NULL DEFAULT '[]',
      target_manifest_key TEXT,
      target_manifest_bytes INTEGER,
      target_manifest_sha256 TEXT,
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
  firstRowId?: number;
  cursor: {
    rowId: number;
    sessionId: string;
    createdAt: number;
    sequence: number;
    messageId: string;
  } | null;
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
      targets: Array.from({ length: input.eligibleRows }, (_value, index) => ({
        rowId:
          (input.firstRowId ??
            (input.cursor?.rowId ?? input.eligibleRows) - input.eligibleRows + 1) + index,
        sessionId: input.sessionId,
        messageId: `target-${input.sessionId}-${index}`,
        messageCreatedAt: CUTOFF - 100 + index,
        messageSequence: index + 1,
        toolMetadataBytes: Math.ceil(input.eligibleBytes / input.eligibleRows) + 100,
        toolMetadataSha256: 'a'.repeat(64),
        projectedReclaimableBytes: Math.ceil(input.eligibleBytes / input.eligibleRows),
      })),
      byteLimitReached: false,
      deadlineReached: false,
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
  const objects = new Map<string, Uint8Array>();
  const r2 = {
    put: vi.fn(async (key: string, value: string | ArrayBuffer | ArrayBufferView) => {
      const bytes =
        typeof value === 'string'
          ? new TextEncoder().encode(value)
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      objects.set(key, bytes.slice());
      return {};
    }),
    get: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? ({ arrayBuffer: async () => bytes.slice().buffer } as R2ObjectBody) : null;
    }),
  } as unknown as R2Bucket;
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
    PROJECT_DATA_ARCHIVE_R2: r2,
    PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_ENABLED: 'true',
    PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_PLAN_ID: PLAN_ID,
    PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_PROJECT_ID: PROJECT_ID,
    PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_CUTOFF_CREATED_AT: String(CUTOFF),
    PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_BATCH_ROWS: '2',
    PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_INTERVAL_MS: '1000',
    PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_BATCHES: '10',
    PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_ROWS: '10',
    PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_BYTES: '10000',
    PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_LEASE_MS: '6000',
    PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_WALL_TIME_MS: '1000',
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
        rowId: 2,
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
            firstRowId: 3,
            cursor: null,
            hasMore: false,
          })
        );
      const env = makeEnv(sqlite, measure);

      const first = await runProjectDataStorageReliefPreflight(env, new Date(NOW));
      expect(first).toMatchObject({ status: 'running', eligibleRows: 2, eligibleBytes: 1200 });
      expect(measure).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          cursor: null,
          limit: 2,
          surface: 'tool_payloads',
          cutoffCreatedAt: CUTOFF,
          maxEligibleBytes: 10000,
          deadlineMs: expect.any(Number),
        })
      );

      const cadenceSkip = await runProjectDataStorageReliefPreflight(env, new Date(NOW + 500));
      expect(cadenceSkip).toMatchObject({ skipped: true, skipReason: 'cadence' });
      expect(measure).toHaveBeenCalledTimes(1);

      const second = await runProjectDataStorageReliefPreflight(env, new Date(NOW + 1000));
      expect(second).toMatchObject({
        status: 'complete',
        eligibleRows: 3,
        eligibleBytes: 1600,
        targetManifestKey: expect.stringMatching(/\/root\.[a-f0-9]{64}\.json$/),
        targetManifestBytes: expect.any(Number),
        targetManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(measure).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          cursor: { toolPayload: cursor },
          limit: 2,
          surface: 'tool_payloads',
          cutoffCreatedAt: CUTOFF,
          maxEligibleBytes: 8800,
          deadlineMs: expect.any(Number),
        })
      );
      expect(readRun(sqlite)).toMatchObject({
        status: 'complete',
        cutoff_created_at: CUTOFF,
        batches_started: 2,
        rows_examined: 3,
        eligible_rows: 3,
        eligible_bytes: 1600,
        session_count: 2,
        sessions_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        target_manifest_key: second.targetManifestKey,
        target_manifest_bytes: second.targetManifestBytes,
        target_manifest_sha256: second.targetManifestSha256,
        cursor_json: null,
        completed_at: NOW + 1000,
      });
      expect(JSON.parse(String(readRun(sqlite)?.sessions_json))).toEqual({
        'session-a': expect.objectContaining({ eligibleRows: 2, eligibleBytes: 1200 }),
        'session-b': expect.objectContaining({ eligibleRows: 1, eligibleBytes: 400 }),
      });
      const rootObject = await env.PROJECT_DATA_ARCHIVE_R2.get(second.targetManifestKey!);
      expect(rootObject).not.toBeNull();
      const root = JSON.parse(new TextDecoder().decode(await rootObject!.arrayBuffer())) as {
        planId: string;
        projectId: string;
        cutoffCreatedAt: number;
        eligibleRows: number;
        eligibleBytes: number;
        batches: Array<{
          key: string;
          sha256: string;
          firstRowId: number;
          lastRowId: number;
        }>;
      };
      expect(root).toMatchObject({
        planId: PLAN_ID,
        projectId: PROJECT_ID,
        cutoffCreatedAt: CUTOFF,
        eligibleRows: 3,
        eligibleBytes: 1600,
      });
      expect(root.batches).toHaveLength(2);
      expect(root.batches).toEqual([
        expect.objectContaining({ firstRowId: 1, lastRowId: 2 }),
        expect.objectContaining({ firstRowId: 3, lastRowId: 3 }),
      ]);
      for (const proof of root.batches) {
        expect(proof.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(await env.PROJECT_DATA_ARCHIVE_R2.get(proof.key)).not.toBeNull();
      }

      const terminalSkip = await runProjectDataStorageReliefPreflight(env, new Date(NOW + 5000));
      expect(terminalSkip).toMatchObject({ skipped: true, skipReason: 'terminal' });
      expect(measure).toHaveBeenCalledTimes(2);
    } finally {
      sqlite.close();
    }
  });

  it('runs an explicitly bounded set of separately leased slices in one invocation', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      const cursor = {
        rowId: 1,
        sessionId: 'session-a',
        createdAt: CUTOFF - 10,
        sequence: 1,
        messageId: 'message-1',
      };
      const measure = vi
        .fn()
        .mockResolvedValueOnce(
          toolResult({
            sessionId: 'session-a',
            eligibleRows: 1,
            eligibleBytes: 600,
            cursor,
            hasMore: true,
          })
        )
        .mockResolvedValueOnce(
          toolResult({
            sessionId: 'session-b',
            eligibleRows: 1,
            eligibleBytes: 400,
            firstRowId: 2,
            cursor: null,
            hasMore: false,
          })
        );
      const env = makeEnv(sqlite, measure, {
        PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_SLICES_PER_RUN: '2',
        PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_RUN_WALL_TIME_MS: '3000',
      });

      const wallClock = Date.now();
      const result = await runProjectDataStorageReliefPreflight(env, new Date(NOW), {
        nowMs: () => wallClock,
      });

      expect(result).toMatchObject({
        skipped: false,
        status: 'complete',
        batchesStarted: 2,
        rowsExamined: 2,
        eligibleRows: 2,
        eligibleBytes: 1000,
      });
      expect(measure).toHaveBeenCalledTimes(2);
      expect(measure).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ cursor: { toolPayload: cursor } })
      );
      expect(readRun(sqlite)).toMatchObject({
        status: 'complete',
        batches_started: 2,
        rows_examined: 2,
        eligible_rows: 2,
        eligible_bytes: 1000,
        completed_at: NOW,
        lease_owner: null,
        lease_expires_at: null,
      });
    } finally {
      sqlite.close();
    }
  });

  it('renews the later-slice lease from elapsed wall time so another invocation cannot steal it', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      let wallNow = Date.now();
      let resolveSecond!: (value: ReturnType<typeof toolResult>) => void;
      const delayedSecond = new Promise<ReturnType<typeof toolResult>>((resolve) => {
        resolveSecond = resolve;
      });
      const measure = vi
        .fn()
        .mockImplementationOnce(async () => {
          wallNow += 2_000;
          return toolResult({
            sessionId: 'session-a',
            eligibleRows: 1,
            eligibleBytes: 600,
            cursor: {
              rowId: 1,
              sessionId: 'session-a',
              createdAt: CUTOFF - 10,
              sequence: 1,
              messageId: 'message-1',
            },
            hasMore: true,
          });
        })
        .mockImplementationOnce(() => delayedSecond);
      const env = makeEnv(sqlite, measure, {
        PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_SLICES_PER_RUN: '2',
        PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_RUN_WALL_TIME_MS: '4000',
      });

      const runPromise = runProjectDataStorageReliefPreflight(env, new Date(NOW), {
        nowMs: () => wallNow,
      });
      await vi.waitFor(() => expect(measure).toHaveBeenCalledTimes(2));
      expect(readRun(sqlite)).toMatchObject({
        status: 'running',
        batches_started: 2,
        updated_at: NOW + 2_000,
        lease_expires_at: NOW + 8_000,
      });

      const overlapping = await runProjectDataStorageReliefPreflight(env, new Date(NOW + 6_500));
      expect(overlapping).toMatchObject({ skipped: true, skipReason: 'leased' });
      expect(measure).toHaveBeenCalledTimes(2);

      resolveSecond(
        toolResult({
          sessionId: 'session-b',
          eligibleRows: 1,
          eligibleBytes: 400,
          firstRowId: 2,
          cursor: null,
          hasMore: false,
        })
      );
      await expect(runPromise).resolves.toMatchObject({
        status: 'complete',
        batchesStarted: 2,
        completedAt: NOW + 2_000,
      });
    } finally {
      sqlite.close();
    }
  });

  it('fails closed when the aggregate run budget cannot contain one bounded slice', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      const measure = vi.fn();
      const result = await runProjectDataStorageReliefPreflight(
        makeEnv(sqlite, measure, {
          PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_SLICES_PER_RUN: '2',
          PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_RUN_WALL_TIME_MS: '1000',
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

  it.each(['0', '-1', '10garbage'])(
    'fails closed when a numeric cap is malformed: %s',
    async (raw) => {
      const sqlite = new Database(':memory:');
      try {
        createTables(sqlite);
        const measure = vi.fn();
        const result = await runProjectDataStorageReliefPreflight(
          makeEnv(sqlite, measure, { PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_ROWS: raw }),
          new Date(NOW)
        );
        expect(result).toMatchObject({ skipped: true, skipReason: 'invalid_config' });
        expect(measure).not.toHaveBeenCalled();
      } finally {
        sqlite.close();
      }
    }
  );

  it('rejects budget drift for an existing immutable plan id', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      const measure = vi.fn().mockResolvedValue(
        toolResult({
          sessionId: 'session-a',
          eligibleRows: 1,
          eligibleBytes: 100,
          cursor: {
            rowId: 1,
            sessionId: 'session-a',
            createdAt: CUTOFF - 1,
            sequence: 1,
            messageId: 'm',
          },
          hasMore: true,
        })
      );
      await runProjectDataStorageReliefPreflight(makeEnv(sqlite, measure), new Date(NOW));
      const drifted = await runProjectDataStorageReliefPreflight(
        makeEnv(sqlite, measure, { PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_BYTES: '9999' }),
        new Date(NOW + 1000)
      );
      expect(drifted).toMatchObject({ skipped: true, skipReason: 'invalid_config' });
      expect(measure).toHaveBeenCalledTimes(1);
    } finally {
      sqlite.close();
    }
  });

  it('leases a delayed slice so concurrent invocations cannot double count it', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      let resolveMeasure!: (value: ReturnType<typeof toolResult>) => void;
      const delayed = new Promise<ReturnType<typeof toolResult>>((resolve) => {
        resolveMeasure = resolve;
      });
      const measure = vi.fn(() => delayed);
      const env = makeEnv(sqlite, measure);
      const firstPromise = runProjectDataStorageReliefPreflight(env, new Date(NOW));
      await vi.waitFor(() => expect(measure).toHaveBeenCalledTimes(1));
      const concurrent = await runProjectDataStorageReliefPreflight(env, new Date(NOW));
      expect(concurrent).toMatchObject({ skipped: true, skipReason: 'leased' });
      resolveMeasure(
        toolResult({
          sessionId: 'session-a',
          eligibleRows: 1,
          eligibleBytes: 100,
          cursor: null,
          hasMore: false,
        })
      );
      await expect(firstPromise).resolves.toMatchObject({ status: 'complete', eligibleRows: 1 });
      expect(measure).toHaveBeenCalledTimes(1);
    } finally {
      sqlite.close();
    }
  });

  it('releases the lease and becomes terminal exactly at the failure batch ceiling', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      const measure = vi.fn().mockRejectedValue(new Error('bounded preflight failure'));
      const result = await runProjectDataStorageReliefPreflight(
        makeEnv(sqlite, measure, { PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_BATCHES: '1' }),
        new Date(NOW)
      );
      expect(result).toMatchObject({ status: 'failed', lastError: 'bounded preflight failure' });
      expect(readRun(sqlite)).toMatchObject({
        status: 'failed',
        lease_owner: null,
        lease_expires_at: null,
        batches_started: 1,
      });
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
            rowId: 2,
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

  it('never persists evidence beyond the configured eligible-byte ceiling', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      const firstSlice = toolResult({
        sessionId: 'session-a',
        eligibleRows: 1,
        eligibleBytes: 60,
        cursor: {
          rowId: 1,
          sessionId: 'session-a',
          createdAt: CUTOFF - 2,
          sequence: 1,
          messageId: 'message-1',
        },
        hasMore: true,
      });
      const byteBoundary = toolResult({
        sessionId: 'session-a',
        eligibleRows: 0,
        eligibleBytes: 0,
        cursor: null,
        hasMore: true,
      });
      byteBoundary.toolPayloads.rowsExamined = 1;
      byteBoundary.toolPayloads.sessions[0]!.rowsExamined = 1;
      byteBoundary.toolPayloads.byteLimitReached = true;
      const measure = vi.fn().mockResolvedValueOnce(firstSlice).mockResolvedValueOnce(byteBoundary);
      const env = makeEnv(sqlite, measure, {
        PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_BYTES: '100',
      });

      await runProjectDataStorageReliefPreflight(env, new Date(NOW));
      const result = await runProjectDataStorageReliefPreflight(env, new Date(NOW + 1000));

      expect(result).toMatchObject({ status: 'truncated', eligibleRows: 1, eligibleBytes: 60 });
      expect(Number(readRun(sqlite)?.eligible_bytes)).toBeLessThanOrEqual(100);
      expect(measure).toHaveBeenLastCalledWith(expect.objectContaining({ maxEligibleBytes: 40 }));
    } finally {
      sqlite.close();
    }
  });
});
