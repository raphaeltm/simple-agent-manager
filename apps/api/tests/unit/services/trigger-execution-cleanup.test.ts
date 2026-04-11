/**
 * Unit tests for the trigger execution cleanup cron sweep.
 *
 * Verifies stale execution recovery (task deleted, task terminal, task stuck,
 * no task linked) and retention purge of old execution logs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/logger', () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  DEFAULT_TRIGGER_EXECUTION_LOG_RETENTION_DAYS,
  DEFAULT_TRIGGER_STALE_EXECUTION_TIMEOUT_MS,
} from '@simple-agent-manager/shared';

import type { Env } from '../../../src/index';
import { runTriggerExecutionCleanup } from '../../../src/scheduled/trigger-execution-cleanup';

// ---------------------------------------------------------------------------
// D1 mock helpers
// ---------------------------------------------------------------------------

interface StaleRow {
  id: string;
  trigger_id: string;
  task_id: string | null;
  started_at: string | null;
  created_at: string;
}

interface TaskRow {
  id: string;
  status: string;
}

/**
 * Creates a mock D1 database that handles the cleanup module's batched queries.
 *
 * Query routing:
 * - SELECT ... FROM trigger_executions WHERE status = 'running' → stale query
 * - SELECT ... FROM tasks WHERE id IN (...) → batch task lookup
 * - UPDATE trigger_executions → prepared for db.batch()
 * - DELETE FROM trigger_executions → retention purge
 */
function createMockDb(options: {
  staleExecutions?: StaleRow[];
  taskLookups?: Record<string, TaskRow | null>;
  batchResults?: { meta: { changes: number } }[];
  purgeChanges?: number;
  staleQueryError?: Error;
  batchError?: Error;
  purgeError?: Error;
} = {}) {
  const {
    staleExecutions = [],
    taskLookups = {},
    purgeChanges = 0,
  } = options;

  const calls: { sql: string; bindings: unknown[] }[] = [];
  const preparedStatements: { sql: string; bindings: unknown[] }[] = [];

  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => {
        calls.push({ sql, bindings: args });

        const stmt = { sql, bindings: args } as unknown as D1PreparedStatement;

        // SELECT stale running executions
        if (sql.includes('FROM trigger_executions') && sql.includes("status = 'running'") && !sql.includes('UPDATE')) {
          if (options.staleQueryError) {
            return Object.assign(stmt, {
              all: vi.fn().mockRejectedValue(options.staleQueryError),
            });
          }
          return Object.assign(stmt, {
            all: vi.fn().mockResolvedValue({ results: staleExecutions }),
          });
        }

        // SELECT tasks WHERE id IN (...)
        if (sql.includes('FROM tasks WHERE id IN')) {
          const taskResults = args
            .map((id) => taskLookups[id as string])
            .filter((t): t is TaskRow => t !== null && t !== undefined);
          return Object.assign(stmt, {
            all: vi.fn().mockResolvedValue({ results: taskResults }),
          });
        }

        // UPDATE trigger_executions (prepared for batch)
        if (sql.includes('UPDATE trigger_executions')) {
          preparedStatements.push({ sql, bindings: args });
          return stmt;
        }

        // DELETE old execution logs (retention purge)
        if (sql.includes('DELETE FROM trigger_executions')) {
          if (options.purgeError) {
            return Object.assign(stmt, {
              run: vi.fn().mockRejectedValue(options.purgeError),
            });
          }
          return Object.assign(stmt, {
            run: vi.fn().mockResolvedValue({ meta: { changes: purgeChanges } }),
          });
        }

        // Default fallback
        return Object.assign(stmt, {
          all: vi.fn().mockResolvedValue({ results: [] }),
          first: vi.fn().mockResolvedValue(null),
          run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
        });
      }),
    })),

    batch: vi.fn(async () => {
      if (options.batchError) {
        throw options.batchError;
      }
      // Return results for each prepared UPDATE statement
      if (options.batchResults) {
        return options.batchResults;
      }
      // Default: each update changes 1 row
      return preparedStatements.map(() => ({ meta: { changes: 1 } }));
    }),

    _calls: calls,
    _preparedStatements: preparedStatements,
  } as unknown as D1Database & {
    _calls: typeof calls;
    _preparedStatements: typeof preparedStatements;
  };

  return db;
}

function createMockEnv(overrides: Partial<Env> = {}): Env {
  const db = createMockDb();
  return {
    DATABASE: db,
    ...overrides,
  } as unknown as Env;
}

// Helper: create a stale execution row
function makeStaleExec(overrides: Partial<StaleRow> = {}): StaleRow {
  return {
    id: 'exec-1',
    trigger_id: 'trigger-1',
    task_id: 'task-1',
    started_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
    created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe('runTriggerExecutionCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-11T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Kill switch
  // -------------------------------------------------------------------------
  describe('kill switch', () => {
    it('returns zeros when TRIGGER_EXECUTION_CLEANUP_ENABLED is false', async () => {
      const env = createMockEnv({
        TRIGGER_EXECUTION_CLEANUP_ENABLED: 'false',
      });

      const stats = await runTriggerExecutionCleanup(env);

      expect(stats).toEqual({
        staleRecovered: 0,
        retentionPurged: 0,
        errors: 0,
      });
      // Should not have queried the database at all
      expect((env.DATABASE as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare).not.toHaveBeenCalled();
    });

    it('runs normally when TRIGGER_EXECUTION_CLEANUP_ENABLED is not set', async () => {
      const db = createMockDb();
      const env = createMockEnv({ DATABASE: db });

      await runTriggerExecutionCleanup(env);

      // Should have at least queried for stale executions
      expect(db.prepare).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Stale execution recovery
  // -------------------------------------------------------------------------
  describe('stale execution recovery', () => {
    it('recovers execution where linked task was deleted', async () => {
      const exec = makeStaleExec({ id: 'exec-deleted', task_id: 'task-deleted' });
      const db = createMockDb({
        staleExecutions: [exec],
        taskLookups: { 'task-deleted': null }, // task doesn't exist — not in IN() results
      });
      const env = createMockEnv({ DATABASE: db });

      const stats = await runTriggerExecutionCleanup(env);

      expect(stats.staleRecovered).toBe(1);
      expect(stats.errors).toBe(0);

      // Verify the UPDATE was prepared with correct reason
      const updateCall = db._calls.find(c => c.sql.includes('UPDATE trigger_executions'));
      expect(updateCall).toBeDefined();
      expect(updateCall!.bindings[0]).toBe('Linked task task-deleted was deleted');
      expect(updateCall!.bindings[2]).toBe('exec-deleted');
    });

    it('recovers execution where task is completed but sync was missed', async () => {
      const exec = makeStaleExec({ id: 'exec-missed', task_id: 'task-completed' });
      const db = createMockDb({
        staleExecutions: [exec],
        taskLookups: { 'task-completed': { id: 'task-completed', status: 'completed' } },
      });
      const env = createMockEnv({ DATABASE: db });

      const stats = await runTriggerExecutionCleanup(env);

      expect(stats.staleRecovered).toBe(1);
      const updateCall = db._calls.find(c => c.sql.includes('UPDATE trigger_executions'));
      expect(updateCall!.bindings[0]).toBe('Linked task task-completed is completed (sync missed)');
    });

    it('recovers execution where task is failed but sync was missed', async () => {
      const exec = makeStaleExec({ id: 'exec-fail-missed', task_id: 'task-failed' });
      const db = createMockDb({
        staleExecutions: [exec],
        taskLookups: { 'task-failed': { id: 'task-failed', status: 'failed' } },
      });
      const env = createMockEnv({ DATABASE: db });

      const stats = await runTriggerExecutionCleanup(env);

      expect(stats.staleRecovered).toBe(1);
      const updateCall = db._calls.find(c => c.sql.includes('UPDATE trigger_executions'));
      expect(updateCall!.bindings[0]).toBe('Linked task task-failed is failed (sync missed)');
    });

    it('recovers execution where task is cancelled but sync was missed', async () => {
      const exec = makeStaleExec({ id: 'exec-cancel', task_id: 'task-cancelled' });
      const db = createMockDb({
        staleExecutions: [exec],
        taskLookups: { 'task-cancelled': { id: 'task-cancelled', status: 'cancelled' } },
      });
      const env = createMockEnv({ DATABASE: db });

      const stats = await runTriggerExecutionCleanup(env);

      expect(stats.staleRecovered).toBe(1);
      const updateCall = db._calls.find(c => c.sql.includes('UPDATE trigger_executions'));
      expect(updateCall!.bindings[0]).toBe('Linked task task-cancelled is cancelled (sync missed)');
    });

    it('recovers execution where task is stuck in queued state', async () => {
      const exec = makeStaleExec({ id: 'exec-stuck', task_id: 'task-queued' });
      const db = createMockDb({
        staleExecutions: [exec],
        taskLookups: { 'task-queued': { id: 'task-queued', status: 'queued' } },
      });
      const env = createMockEnv({ DATABASE: db });

      const stats = await runTriggerExecutionCleanup(env);

      expect(stats.staleRecovered).toBe(1);
      const updateCall = db._calls.find(c => c.sql.includes('UPDATE trigger_executions'));
      expect(updateCall!.bindings[0]).toBe("Linked task task-queued stuck in 'queued' past stale threshold");
    });

    it('recovers execution with no linked task (submission failed)', async () => {
      const exec = makeStaleExec({ id: 'exec-no-task', task_id: null });
      const db = createMockDb({
        staleExecutions: [exec],
      });
      const env = createMockEnv({ DATABASE: db });

      const stats = await runTriggerExecutionCleanup(env);

      expect(stats.staleRecovered).toBe(1);
      const updateCall = db._calls.find(c => c.sql.includes('UPDATE trigger_executions'));
      expect(updateCall!.bindings[0]).toBe('Task was never created (submission failed)');
    });

    it('handles multiple stale executions in one sweep', async () => {
      const execs = [
        makeStaleExec({ id: 'exec-a', task_id: null }),
        makeStaleExec({ id: 'exec-b', task_id: 'task-del' }),
        makeStaleExec({ id: 'exec-c', task_id: 'task-done' }),
      ];
      const db = createMockDb({
        staleExecutions: execs,
        taskLookups: {
          'task-del': null,
          'task-done': { id: 'task-done', status: 'completed' },
        },
      });
      const env = createMockEnv({ DATABASE: db });

      const stats = await runTriggerExecutionCleanup(env);

      expect(stats.staleRecovered).toBe(3);
      expect(stats.errors).toBe(0);

      // Verify batch was called with all 3 updates
      expect(db.batch).toHaveBeenCalledTimes(1);
    });

    it('returns zero recovered when no stale executions exist', async () => {
      const db = createMockDb({ staleExecutions: [] });
      const env = createMockEnv({ DATABASE: db });

      const stats = await runTriggerExecutionCleanup(env);

      expect(stats.staleRecovered).toBe(0);
      expect(stats.errors).toBe(0);

      // batch should not be called when there are no stale executions
      expect(db.batch).not.toHaveBeenCalled();
    });

    it('counts all stale executions as errors when batch update fails', async () => {
      const execs = [
        makeStaleExec({ id: 'exec-a', task_id: null }),
        makeStaleExec({ id: 'exec-b', task_id: null }),
      ];
      const db = createMockDb({
        staleExecutions: execs,
        batchError: new Error('D1 batch failed'),
      });
      const env = createMockEnv({ DATABASE: db });

      const stats = await runTriggerExecutionCleanup(env);

      expect(stats.staleRecovered).toBe(0);
      expect(stats.errors).toBe(2); // one error per stale execution
    });

    it('does not count recovered when UPDATE matched zero rows (already transitioned)', async () => {
      const exec = makeStaleExec({ id: 'exec-race', task_id: null });
      const db = createMockDb({
        staleExecutions: [exec],
        batchResults: [{ meta: { changes: 0 } }], // another sweep already transitioned
      });
      const env = createMockEnv({ DATABASE: db });

      const stats = await runTriggerExecutionCleanup(env);

      expect(stats.staleRecovered).toBe(0);
      expect(stats.errors).toBe(0);
    });

    it('returns error when stale query itself fails', async () => {
      const db = createMockDb({
        staleQueryError: new Error('D1 unavailable'),
      });
      const env = createMockEnv({ DATABASE: db });

      const stats = await runTriggerExecutionCleanup(env);

      expect(stats.staleRecovered).toBe(0);
      expect(stats.errors).toBe(1);
    });

    it('uses LIMIT in stale query', async () => {
      const db = createMockDb({ staleExecutions: [] });
      const env = createMockEnv({ DATABASE: db });

      await runTriggerExecutionCleanup(env);

      const staleQuery = db._calls.find(
        c => c.sql.includes('FROM trigger_executions') && c.sql.includes("status = 'running'"),
      );
      expect(staleQuery).toBeDefined();
      expect(staleQuery!.sql).toContain('LIMIT');
    });

    it('uses COALESCE(started_at, created_at) in stale query', async () => {
      const db = createMockDb({ staleExecutions: [] });
      const env = createMockEnv({ DATABASE: db });

      await runTriggerExecutionCleanup(env);

      const staleQuery = db._calls.find(
        c => c.sql.includes('FROM trigger_executions') && c.sql.includes("status = 'running'"),
      );
      expect(staleQuery).toBeDefined();
      expect(staleQuery!.sql).toContain('COALESCE(started_at, created_at)');
    });

    it('batches task lookups into a single IN(...) query', async () => {
      const execs = [
        makeStaleExec({ id: 'exec-a', task_id: 'task-1' }),
        makeStaleExec({ id: 'exec-b', task_id: 'task-2' }),
        makeStaleExec({ id: 'exec-c', task_id: 'task-1' }), // duplicate task_id
      ];
      const db = createMockDb({
        staleExecutions: execs,
        taskLookups: {
          'task-1': { id: 'task-1', status: 'completed' },
          'task-2': { id: 'task-2', status: 'failed' },
        },
      });
      const env = createMockEnv({ DATABASE: db });

      await runTriggerExecutionCleanup(env);

      // Should have exactly one IN(...) query for task lookups
      const taskQuery = db._calls.find(c => c.sql.includes('FROM tasks WHERE id IN'));
      expect(taskQuery).toBeDefined();
      // Should deduplicate task IDs
      expect(taskQuery!.bindings).toHaveLength(2); // task-1 and task-2 (deduplicated)
    });

    it('skips batch task lookup when all executions have null task_id', async () => {
      const execs = [
        makeStaleExec({ id: 'exec-a', task_id: null }),
        makeStaleExec({ id: 'exec-b', task_id: null }),
      ];
      const db = createMockDb({ staleExecutions: execs });
      const env = createMockEnv({ DATABASE: db });

      await runTriggerExecutionCleanup(env);

      // Should NOT have a task lookup query
      const taskQuery = db._calls.find(c => c.sql.includes('FROM tasks WHERE id IN'));
      expect(taskQuery).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Retention purge
  // -------------------------------------------------------------------------
  describe('retention purge', () => {
    it('purges old completed/failed/skipped executions', async () => {
      const db = createMockDb({ purgeChanges: 42 });
      const env = createMockEnv({ DATABASE: db });

      const stats = await runTriggerExecutionCleanup(env);

      expect(stats.retentionPurged).toBe(42);

      // Verify the DELETE query targets correct statuses
      const deleteCall = db._calls.find(c => c.sql.includes('DELETE FROM trigger_executions'));
      expect(deleteCall).toBeDefined();
      expect(deleteCall!.sql).toContain("'completed', 'failed', 'skipped'");
    });

    it('uses configurable retention period from env', async () => {
      const db = createMockDb({ purgeChanges: 5 });
      const env = createMockEnv({
        DATABASE: db,
        TRIGGER_EXECUTION_LOG_RETENTION_DAYS: '30',
      });

      await runTriggerExecutionCleanup(env);

      // The cutoff should be 30 days ago from our fake time
      const deleteCall = db._calls.find(c => c.sql.includes('DELETE FROM trigger_executions'));
      expect(deleteCall).toBeDefined();
      const cutoffDate = new Date(deleteCall!.bindings[0] as string);
      const expectedCutoff = new Date('2026-04-11T12:00:00Z');
      expectedCutoff.setDate(expectedCutoff.getDate() - 30);
      expect(Math.abs(cutoffDate.getTime() - expectedCutoff.getTime())).toBeLessThan(1000);
    });

    it('uses default retention when env var is not set', async () => {
      const db = createMockDb({ purgeChanges: 0 });
      const env = createMockEnv({ DATABASE: db });

      await runTriggerExecutionCleanup(env);

      const deleteCall = db._calls.find(c => c.sql.includes('DELETE FROM trigger_executions'));
      expect(deleteCall).toBeDefined();
      const cutoffDate = new Date(deleteCall!.bindings[0] as string);
      const expectedCutoff = new Date('2026-04-11T12:00:00Z');
      expectedCutoff.setDate(expectedCutoff.getDate() - DEFAULT_TRIGGER_EXECUTION_LOG_RETENTION_DAYS);
      expect(Math.abs(cutoffDate.getTime() - expectedCutoff.getTime())).toBeLessThan(1000);
    });

    it('counts errors when purge fails', async () => {
      const db = createMockDb({
        purgeError: new Error('D1 delete failed'),
      });
      const env = createMockEnv({ DATABASE: db });

      const stats = await runTriggerExecutionCleanup(env);

      expect(stats.retentionPurged).toBe(0);
      expect(stats.errors).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Configurable stale threshold
  // -------------------------------------------------------------------------
  describe('configurable stale threshold', () => {
    it('uses custom stale threshold from env', async () => {
      const db = createMockDb({ staleExecutions: [] });
      const env = createMockEnv({
        DATABASE: db,
        TRIGGER_STALE_EXECUTION_TIMEOUT_MS: '600000', // 10 minutes
      });

      await runTriggerExecutionCleanup(env);

      const staleQuery = db._calls.find(
        c => c.sql.includes('FROM trigger_executions') && c.sql.includes("status = 'running'") && !c.sql.includes('UPDATE'),
      );
      expect(staleQuery).toBeDefined();
      const cutoffDate = new Date(staleQuery!.bindings[0] as string);
      const expectedCutoff = new Date('2026-04-11T11:50:00Z'); // 10 min ago
      expect(Math.abs(cutoffDate.getTime() - expectedCutoff.getTime())).toBeLessThan(1000);
    });

    it('falls back to default for invalid env values', async () => {
      const db = createMockDb({ staleExecutions: [] });
      const env = createMockEnv({
        DATABASE: db,
        TRIGGER_STALE_EXECUTION_TIMEOUT_MS: 'not-a-number',
      });

      await runTriggerExecutionCleanup(env);

      const staleQuery = db._calls.find(
        c => c.sql.includes('FROM trigger_executions') && c.sql.includes("status = 'running'") && !c.sql.includes('UPDATE'),
      );
      expect(staleQuery).toBeDefined();
      const cutoffDate = new Date(staleQuery!.bindings[0] as string);
      const expectedCutoff = new Date(Date.now() - DEFAULT_TRIGGER_STALE_EXECUTION_TIMEOUT_MS);
      expect(Math.abs(cutoffDate.getTime() - expectedCutoff.getTime())).toBeLessThan(1000);
    });
  });
});
