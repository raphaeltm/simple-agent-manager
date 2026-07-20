/**
 * Vertical slice tests for trigger execution cleanup.
 *
 * Tests the full cleanup sweep against real Miniflare D1 — no mocking.
 * The cleanup module uses raw D1 SQL (not Drizzle), making it a clean
 * vertical slice: seed D1 state → run cleanup → assert D1 state changed.
 *
 * Source: apps/api/src/scheduled/trigger-execution-cleanup.ts
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { runTriggerExecutionCleanup } from '../../src/scheduled/trigger-execution-cleanup';
import {
  seedInstallation,
  seedProject,
  seedTask,
  seedTrigger,
  seedTriggerExecution,
  seedUser,
} from './helpers/seed-d1';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const USER_ID = 'user-cleanup-001';
const PROJECT_ID = 'proj-cleanup-001';
const INSTALLATION_ID = 'inst-cleanup-001';
const TRIGGER_ID = 'trigger-cleanup-001';

// Timestamp helpers
const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
const TEN_MINUTES_AGO = new Date(Date.now() - 10 * 60 * 1000).toISOString();
const NINETY_ONE_DAYS_AGO = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
const FIVE_DAYS_AGO = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Env with real D1 from the Miniflare environment. */
function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE: env.DATABASE,
    ...overrides,
  } as unknown as Env;
}

/** Query a trigger execution row by ID. */
async function getExecution(id: string) {
  const result = await env.DATABASE.prepare(
    'SELECT id, status, error_message, completed_at FROM trigger_executions WHERE id = ?'
  )
    .bind(id)
    .first<{
      id: string;
      status: string;
      error_message: string | null;
      completed_at: string | null;
    }>();
  return result;
}

// ---------------------------------------------------------------------------
// Seed shared data once. Workers tests share a D1 instance across tests in
// the same file, so we seed the parent entities once and use unique execution
// IDs per test to avoid collisions.
// ---------------------------------------------------------------------------
async function seedBaseData() {
  await seedUser(USER_ID);
  await seedInstallation(INSTALLATION_ID, USER_ID);
  await seedProject(PROJECT_ID, USER_ID, INSTALLATION_ID, { name: 'Cleanup Test Project' });
  await seedTrigger(TRIGGER_ID, PROJECT_ID, USER_ID, { name: 'Cleanup Trigger' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('trigger execution cleanup (vertical slice, real D1)', () => {
  // -------------------------------------------------------------------------
  // Kill switch
  // -------------------------------------------------------------------------
  describe('kill switch', () => {
    it('returns zeros when TRIGGER_EXECUTION_CLEANUP_ENABLED is false', async () => {
      const testEnv = buildEnv({ TRIGGER_EXECUTION_CLEANUP_ENABLED: 'false' });
      const stats = await runTriggerExecutionCleanup(testEnv);

      expect(stats).toEqual({
        staleRecovered: 0,
        staleQueuedRecovered: 0,
        retentionPurged: 0,
        webhookDeliveriesPurged: 0,
        errors: 0,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Stale running recovery
  // -------------------------------------------------------------------------
  describe('stale running execution recovery', () => {
    it('recovers execution where linked task was deleted', async () => {
      await seedBaseData();

      // Execution links to a task_id that doesn't exist in the tasks table
      await seedTriggerExecution('exec-del-task-001', TRIGGER_ID, PROJECT_ID, {
        status: 'running',
        taskId: 'task-nonexistent-999',
        startedAt: TWO_HOURS_AGO,
        createdAt: TWO_HOURS_AGO,
      });

      const stats = await runTriggerExecutionCleanup(buildEnv());

      expect(stats.staleRecovered).toBeGreaterThanOrEqual(1);

      const exec = await getExecution('exec-del-task-001');
      expect(exec?.status).toBe('failed');
      expect(exec?.error_message).toContain('was deleted');
      expect(exec?.completed_at).toBeTruthy();
    });

    it('recovers execution where task is in terminal state (sync missed)', async () => {
      await seedBaseData();

      // Create a completed task
      await seedTask('task-term-001', PROJECT_ID, USER_ID, { status: 'completed' });

      // Execution still 'running' despite task being completed
      await seedTriggerExecution('exec-term-001', TRIGGER_ID, PROJECT_ID, {
        status: 'running',
        taskId: 'task-term-001',
        startedAt: TWO_HOURS_AGO,
        createdAt: TWO_HOURS_AGO,
      });

      const stats = await runTriggerExecutionCleanup(buildEnv());

      expect(stats.staleRecovered).toBeGreaterThanOrEqual(1);

      const exec = await getExecution('exec-term-001');
      expect(exec?.status).toBe('failed');
      expect(exec?.error_message).toContain('is completed (sync missed)');
    });

    it('recovers execution where task is stuck in non-terminal state', async () => {
      await seedBaseData();

      // Task still in 'queued' state — stuck
      await seedTask('task-stuck-001', PROJECT_ID, USER_ID, { status: 'queued' });

      await seedTriggerExecution('exec-stuck-001', TRIGGER_ID, PROJECT_ID, {
        status: 'running',
        taskId: 'task-stuck-001',
        startedAt: TWO_HOURS_AGO,
        createdAt: TWO_HOURS_AGO,
      });

      const stats = await runTriggerExecutionCleanup(buildEnv());

      expect(stats.staleRecovered).toBeGreaterThanOrEqual(1);

      const exec = await getExecution('exec-stuck-001');
      expect(exec?.status).toBe('failed');
      expect(exec?.error_message).toContain("stuck in 'queued'");
    });

    it('recovers execution with no linked task (submission failed)', async () => {
      await seedBaseData();

      await seedTriggerExecution('exec-no-task-001', TRIGGER_ID, PROJECT_ID, {
        status: 'running',
        taskId: null,
        startedAt: TWO_HOURS_AGO,
        createdAt: TWO_HOURS_AGO,
      });

      const stats = await runTriggerExecutionCleanup(buildEnv());

      expect(stats.staleRecovered).toBeGreaterThanOrEqual(1);

      const exec = await getExecution('exec-no-task-001');
      expect(exec?.status).toBe('failed');
      expect(exec?.error_message).toContain('Task was never created');
    });

    it('does NOT recover recent running executions (within timeout)', async () => {
      await seedBaseData();

      // Running execution started only 10 minutes ago — within default 1h timeout
      await seedTriggerExecution('exec-recent-001', TRIGGER_ID, PROJECT_ID, {
        status: 'running',
        taskId: 'task-recent-999',
        startedAt: TEN_MINUTES_AGO,
        createdAt: TEN_MINUTES_AGO,
      });

      await runTriggerExecutionCleanup(buildEnv());

      const exec = await getExecution('exec-recent-001');
      expect(exec?.status).toBe('running');
    });

    it('handles multiple stale executions with different recovery reasons', async () => {
      await seedBaseData();

      // Create the failed task first
      await seedTask('task-multi-fail-001', PROJECT_ID, USER_ID, { status: 'failed' });

      // Execution 1: no task
      await seedTriggerExecution('exec-multi-a', TRIGGER_ID, PROJECT_ID, {
        status: 'running',
        taskId: null,
        startedAt: TWO_HOURS_AGO,
        createdAt: TWO_HOURS_AGO,
      });

      // Execution 2: task in terminal state
      await seedTriggerExecution('exec-multi-b', TRIGGER_ID, PROJECT_ID, {
        status: 'running',
        taskId: 'task-multi-fail-001',
        startedAt: TWO_HOURS_AGO,
        createdAt: TWO_HOURS_AGO,
      });

      const stats = await runTriggerExecutionCleanup(buildEnv());

      expect(stats.staleRecovered).toBeGreaterThanOrEqual(2);

      const execA = await getExecution('exec-multi-a');
      expect(execA?.status).toBe('failed');

      const execB = await getExecution('exec-multi-b');
      expect(execB?.status).toBe('failed');
      expect(execB?.error_message).toContain('is failed (sync missed)');
    });
  });

  // -------------------------------------------------------------------------
  // Stale queued recovery
  // -------------------------------------------------------------------------
  describe('stale queued execution recovery', () => {
    it('preserves a stale execution while its webhook delivery lease is active', async () => {
      await seedBaseData();
      const executionId = 'exec-q-webhook-active-001';
      const taskId = 'task-q-webhook-active-001';
      const now = new Date().toISOString();

      await seedTask(taskId, PROJECT_ID, USER_ID, { status: 'queued' });
      await seedTriggerExecution(executionId, TRIGGER_ID, PROJECT_ID, {
        status: 'queued',
        taskId,
        startedAt: TWO_HOURS_AGO,
        createdAt: TWO_HOURS_AGO,
      });
      await env.DATABASE.prepare('UPDATE tasks SET trigger_execution_id = ? WHERE id = ?')
        .bind(executionId, taskId)
        .run();
      await env.DATABASE.prepare(
        `INSERT INTO webhook_deliveries
          (id, trigger_id, request_fingerprint, outcome, http_status, body_bytes,
           processing_token, processing_heartbeat_at, execution_id, received_at, expires_at)
         VALUES (?, ?, ?, 'processing', 0, 42, ?, ?, ?, ?, ?)`
      )
        .bind(
          'delivery-q-webhook-active-001',
          TRIGGER_ID,
          'active-fingerprint',
          'active-processing-token',
          now,
          executionId,
          now,
          new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        )
        .run();

      await runTriggerExecutionCleanup(
        buildEnv({
          TASK_RUNNER: {
            idFromName: () => taskId,
            get: () => ({
              getStatus: async () => ({ taskId, currentStep: 'node_selection' }),
            }),
          } as Env['TASK_RUNNER'],
        })
      );

      expect((await getExecution(executionId))?.status).toBe('queued');
      expect(
        await env.DATABASE.prepare('SELECT outcome FROM webhook_deliveries WHERE id = ?')
          .bind('delivery-q-webhook-active-001')
          .first()
      ).toEqual({ outcome: 'processing' });
    });

    it('recovers queued execution with no linked task', async () => {
      await seedBaseData();

      // Queued execution with no task, created 2 hours ago (well past 5-min default)
      await seedTriggerExecution('exec-q-no-task-001', TRIGGER_ID, PROJECT_ID, {
        status: 'queued',
        taskId: null,
        startedAt: TWO_HOURS_AGO,
        createdAt: TWO_HOURS_AGO,
      });

      const stats = await runTriggerExecutionCleanup(buildEnv());

      expect(stats.staleQueuedRecovered).toBeGreaterThanOrEqual(1);

      const exec = await getExecution('exec-q-no-task-001');
      expect(exec?.status).toBe('failed');
      expect(exec?.error_message).toContain('never started');
    });

    it('recovers queued execution with linked task', async () => {
      await seedBaseData();

      await seedTask('task-q-linked-001', PROJECT_ID, USER_ID, { status: 'queued' });

      await seedTriggerExecution('exec-q-linked-001', TRIGGER_ID, PROJECT_ID, {
        status: 'queued',
        taskId: 'task-q-linked-001',
        startedAt: TWO_HOURS_AGO,
        createdAt: TWO_HOURS_AGO,
      });

      const stats = await runTriggerExecutionCleanup(buildEnv());

      expect(stats.staleQueuedRecovered).toBeGreaterThanOrEqual(1);

      const exec = await getExecution('exec-q-linked-001');
      expect(exec?.status).toBe('failed');
      expect(exec?.error_message).toContain('Queued execution stale');
    });
  });

  // -------------------------------------------------------------------------
  // Retention purge
  // -------------------------------------------------------------------------
  describe('retention purge', () => {
    it('purges expired webhook delivery metadata without removing recent records', async () => {
      await seedBaseData();
      const now = new Date().toISOString();
      await env.DATABASE.prepare(
        `INSERT OR IGNORE INTO webhook_trigger_configs
          (trigger_id, token_hash, token_last_four, token_created_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(TRIGGER_ID, 'cleanup-token-hash', 'hash', now, now, now)
        .run();
      await env.DATABASE.batch([
        env.DATABASE.prepare(
          `INSERT INTO webhook_deliveries
            (id, trigger_id, request_fingerprint, outcome, http_status, body_bytes,
             received_at, processed_at, expires_at)
           VALUES (?, ?, ?, 'accepted', 202, 42, ?, ?, ?)`
        ).bind(
          'delivery-expired-001',
          TRIGGER_ID,
          'expired-fingerprint',
          NINETY_ONE_DAYS_AGO,
          NINETY_ONE_DAYS_AGO,
          NINETY_ONE_DAYS_AGO
        ),
        env.DATABASE.prepare(
          `INSERT INTO webhook_deliveries
            (id, trigger_id, request_fingerprint, outcome, http_status, body_bytes,
             received_at, processed_at, expires_at)
           VALUES (?, ?, ?, 'accepted', 202, 42, ?, ?, ?)`
        ).bind(
          'delivery-recent-001',
          TRIGGER_ID,
          'recent-fingerprint',
          now,
          now,
          new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
        ),
      ]);

      const stats = await runTriggerExecutionCleanup(buildEnv());

      expect(stats.webhookDeliveriesPurged).toBeGreaterThanOrEqual(1);
      expect(
        await env.DATABASE.prepare('SELECT id FROM webhook_deliveries WHERE id = ?')
          .bind('delivery-expired-001')
          .first()
      ).toBeNull();
      expect(
        await env.DATABASE.prepare('SELECT id FROM webhook_deliveries WHERE id = ?')
          .bind('delivery-recent-001')
          .first()
      ).not.toBeNull();
    });

    it('purges old completed/failed/skipped executions by created_at', async () => {
      await seedBaseData();

      // Old completed execution (91 days ago, past 90-day default)
      await seedTriggerExecution('exec-old-completed', TRIGGER_ID, PROJECT_ID, {
        status: 'completed',
        completedAt: NINETY_ONE_DAYS_AGO,
        createdAt: NINETY_ONE_DAYS_AGO,
      });

      // Old failed execution
      await seedTriggerExecution('exec-old-failed', TRIGGER_ID, PROJECT_ID, {
        status: 'failed',
        completedAt: NINETY_ONE_DAYS_AGO,
        createdAt: NINETY_ONE_DAYS_AGO,
        errorMessage: 'Old failure',
      });

      // Old skipped execution
      await seedTriggerExecution('exec-old-skipped', TRIGGER_ID, PROJECT_ID, {
        status: 'skipped',
        completedAt: NINETY_ONE_DAYS_AGO,
        createdAt: NINETY_ONE_DAYS_AGO,
        skipReason: 'still_running',
      });

      // Recent failed execution (5 days ago, within retention)
      await seedTriggerExecution('exec-recent-failed', TRIGGER_ID, PROJECT_ID, {
        status: 'failed',
        completedAt: FIVE_DAYS_AGO,
        createdAt: FIVE_DAYS_AGO,
        errorMessage: 'Recent failure',
      });

      const stats = await runTriggerExecutionCleanup(buildEnv());

      expect(stats.retentionPurged).toBeGreaterThanOrEqual(3);

      // Old executions should be gone
      const oldCompleted = await getExecution('exec-old-completed');
      expect(oldCompleted).toBeNull();

      const oldFailed = await getExecution('exec-old-failed');
      expect(oldFailed).toBeNull();

      const oldSkipped = await getExecution('exec-old-skipped');
      expect(oldSkipped).toBeNull();

      // Recent execution should still exist
      const recentFailed = await getExecution('exec-recent-failed');
      expect(recentFailed).not.toBeNull();
      expect(recentFailed?.status).toBe('failed');
    });

    it('does NOT purge running executions regardless of age', async () => {
      await seedBaseData();

      // Running execution from 5 days ago — within the 90-day retention window
      // but outside the 1h stale threshold. Stale recovery will transition it
      // to 'failed', but the retention purge should NOT delete it (created_at
      // is within the retention window). This proves the retention query's
      // `status IN ('completed', 'failed', 'skipped')` filter works correctly.
      await seedTriggerExecution('exec-old-running', TRIGGER_ID, PROJECT_ID, {
        status: 'running',
        startedAt: FIVE_DAYS_AGO,
        createdAt: FIVE_DAYS_AGO,
      });

      await runTriggerExecutionCleanup(buildEnv());

      // Row should still exist — stale recovery transitions it to 'failed'
      // but retention purge does not delete it (only 5 days old)
      const exec = await getExecution('exec-old-running');
      expect(exec).not.toBeNull();
      expect(exec?.status).toBe('failed'); // recovered by stale sweep
    });

    it('uses configurable retention period from env', async () => {
      await seedBaseData();

      // Execution from 10 days ago
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      await seedTriggerExecution('exec-custom-ret-001', TRIGGER_ID, PROJECT_ID, {
        status: 'completed',
        completedAt: tenDaysAgo,
        createdAt: tenDaysAgo,
      });

      // Set retention to 7 days — the 10-day-old execution should be purged
      const stats = await runTriggerExecutionCleanup(
        buildEnv({ TRIGGER_EXECUTION_LOG_RETENTION_DAYS: '7' })
      );

      expect(stats.retentionPurged).toBeGreaterThanOrEqual(1);

      const exec = await getExecution('exec-custom-ret-001');
      expect(exec).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Combined: stale recovery + retention in one sweep
  // -------------------------------------------------------------------------
  describe('combined sweep', () => {
    it('recovers stale executions AND purges old logs in a single sweep', async () => {
      await seedBaseData();

      // Stale running execution (no task)
      await seedTriggerExecution('exec-combined-stale', TRIGGER_ID, PROJECT_ID, {
        status: 'running',
        taskId: null,
        startedAt: TWO_HOURS_AGO,
        createdAt: TWO_HOURS_AGO,
      });

      // Old completed execution (past retention)
      await seedTriggerExecution('exec-combined-old', TRIGGER_ID, PROJECT_ID, {
        status: 'completed',
        completedAt: NINETY_ONE_DAYS_AGO,
        createdAt: NINETY_ONE_DAYS_AGO,
      });

      const stats = await runTriggerExecutionCleanup(buildEnv());

      expect(stats.staleRecovered).toBeGreaterThanOrEqual(1);
      expect(stats.retentionPurged).toBeGreaterThanOrEqual(1);
      expect(stats.errors).toBe(0);

      // Stale → failed (still exists)
      const stale = await getExecution('exec-combined-stale');
      expect(stale?.status).toBe('failed');

      // Old → purged (deleted)
      const old = await getExecution('exec-combined-old');
      expect(old).toBeNull();
    });
  });
});
