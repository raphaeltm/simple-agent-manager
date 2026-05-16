/**
 * Vertical slice tests for cron trigger sweep operations.
 *
 * Since workers pool tests cannot use vi.mock(), we cannot call
 * runCronTriggerSweep() directly (it internally calls submitTriggeredTask
 * which requires DOs, GitHub, AI). Instead, we test the individual
 * operations that the sweep performs — all against real Miniflare D1:
 *
 * 1. Trigger discovery (Drizzle queries against real D1)
 * 2. skipIfRunning / maxConcurrent counting
 * 3. Template rendering (buildCronContext + renderTemplate)
 * 4. Execution state transitions (queued → running, queued → failed)
 * 5. Trigger metadata updates (lastTriggeredAt, triggerCount, nextFireAt)
 * 6. cronToNextFire with real cron expressions
 * 7. Auto-pause after consecutive failures
 * 8. Skipped execution records
 *
 * Source: apps/api/src/scheduled/cron-triggers.ts
 */
import { env } from 'cloudflare:test';
import { and, count, desc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import { cronToNextFire } from '../../src/services/cron-utils';
import { buildCronContext, renderTemplate } from '../../src/services/trigger-template';
import {
  seedInstallation,
  seedProject,
  seedTrigger,
  seedTriggerExecution,
  seedUser,
} from './helpers/seed-d1';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const USER_ID = 'user-cron-001';
const PROJECT_ID = 'proj-cron-001';
const INSTALLATION_ID = 'inst-cron-001';
const PROJECT_NAME = 'Cron Test Project';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDb() {
  return drizzle(env.DATABASE, { schema });
}

async function seedBaseData() {
  await seedUser(USER_ID);
  await seedInstallation(INSTALLATION_ID, USER_ID);
  await seedProject(PROJECT_ID, USER_ID, INSTALLATION_ID, { name: PROJECT_NAME });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cron trigger sweep operations (vertical slice, real D1)', () => {
  // -------------------------------------------------------------------------
  // Trigger discovery
  // -------------------------------------------------------------------------
  describe('trigger discovery', () => {
    it('finds active cron triggers with nextFireAt <= now', async () => {
      await seedBaseData();
      const db = getDb();

      const pastTime = new Date(Date.now() - 60_000).toISOString();
      const futureTime = new Date(Date.now() + 3600_000).toISOString();

      // Active trigger due to fire
      await seedTrigger('trigger-due-001', PROJECT_ID, USER_ID, {
        status: 'active',
        sourceType: 'cron',
        nextFireAt: pastTime,
      });

      // Active trigger not yet due
      await seedTrigger('trigger-future-001', PROJECT_ID, USER_ID, {
        status: 'active',
        sourceType: 'cron',
        nextFireAt: futureTime,
      });

      // Paused trigger (should not be found)
      await seedTrigger('trigger-paused-001', PROJECT_ID, USER_ID, {
        status: 'paused',
        sourceType: 'cron',
        nextFireAt: pastTime,
      });

      // Webhook trigger (different sourceType, should not be found)
      await seedTrigger('trigger-webhook-001', PROJECT_ID, USER_ID, {
        status: 'active',
        sourceType: 'webhook',
        nextFireAt: pastTime,
      });

      const nowIso = new Date().toISOString();
      const dueTriggers = await db
        .select()
        .from(schema.triggers)
        .where(
          and(
            eq(schema.triggers.sourceType, 'cron'),
            eq(schema.triggers.status, 'active'),
            isNotNull(schema.triggers.nextFireAt),
            lte(schema.triggers.nextFireAt, nowIso),
          ),
        );

      const dueIds = dueTriggers.map((t) => t.id);
      expect(dueIds).toContain('trigger-due-001');
      expect(dueIds).not.toContain('trigger-future-001');
      expect(dueIds).not.toContain('trigger-paused-001');
      expect(dueIds).not.toContain('trigger-webhook-001');
    });
  });

  // -------------------------------------------------------------------------
  // skipIfRunning / maxConcurrent
  // -------------------------------------------------------------------------
  describe('skipIfRunning and maxConcurrent', () => {
    it('counts active executions (queued + running) for skipIfRunning check', async () => {
      await seedBaseData();
      const db = getDb();

      await seedTrigger('trigger-skip-001', PROJECT_ID, USER_ID, {
        skipIfRunning: true,
      });

      // One running execution
      await seedTriggerExecution('exec-skip-running', 'trigger-skip-001', PROJECT_ID, {
        status: 'running',
      });

      // One completed execution (should not count)
      await seedTriggerExecution('exec-skip-done', 'trigger-skip-001', PROJECT_ID, {
        status: 'completed',
      });

      const [activeCount] = await db
        .select({ count: count() })
        .from(schema.triggerExecutions)
        .where(
          and(
            eq(schema.triggerExecutions.triggerId, 'trigger-skip-001'),
            inArray(schema.triggerExecutions.status, ['queued', 'running']),
          ),
        );

      expect(activeCount?.count).toBe(1);
    });

    it('enforces maxConcurrent by counting active executions', async () => {
      await seedBaseData();
      const db = getDb();

      await seedTrigger('trigger-conc-001', PROJECT_ID, USER_ID, {
        maxConcurrent: 2,
        skipIfRunning: false,
      });

      // Two running executions — at the limit
      await seedTriggerExecution('exec-conc-1', 'trigger-conc-001', PROJECT_ID, {
        status: 'running',
      });
      await seedTriggerExecution('exec-conc-2', 'trigger-conc-001', PROJECT_ID, {
        status: 'queued',
      });

      const [activeCount] = await db
        .select({ count: count() })
        .from(schema.triggerExecutions)
        .where(
          and(
            eq(schema.triggerExecutions.triggerId, 'trigger-conc-001'),
            inArray(schema.triggerExecutions.status, ['queued', 'running']),
          ),
        );

      // At maxConcurrent=2, the sweep would skip
      // (verifies D1 query behavior; control flow is in processTrigger which can't be called without vi.mock)
      expect(activeCount?.count).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Template rendering
  // -------------------------------------------------------------------------
  describe('template rendering with real project data', () => {
    it('renders template with trigger and project context', async () => {
      const template = 'Review PRs for {{trigger.name}} in {{project.name}} (fire #{{trigger.fireCount}})';
      const now = new Date('2026-05-15T09:00:00Z');

      const context = buildCronContext(
        {
          id: 'trigger-tpl-001',
          name: 'Daily PR Review',
          description: 'Automated PR review trigger',
          triggerCount: 4,
          cronTimezone: 'UTC',
          projectId: PROJECT_ID,
        },
        now,
        PROJECT_NAME,
        'exec-tpl-001',
        5,
      );

      const result = renderTemplate(template, context as unknown as Record<string, unknown>);

      expect(result.rendered).toBe(
        `Review PRs for Daily PR Review in ${PROJECT_NAME} (fire #5)`,
      );
      expect(result.warnings).toHaveLength(0);
    });

    it('includes schedule context with timezone-aware date', () => {
      const now = new Date('2026-05-15T14:30:00Z');

      const context = buildCronContext(
        {
          id: 'trigger-tz-001',
          name: 'TZ Test',
          description: '',
          triggerCount: 0,
          cronTimezone: 'America/New_York',
          projectId: PROJECT_ID,
        },
        now,
        PROJECT_NAME,
        'exec-tz-001',
        1,
      );

      expect(context.schedule.timezone).toBe('America/New_York');
      // 14:30 UTC = 10:30 EDT
      expect(context.schedule.hour).toBe('10');
      expect(context.schedule.minute).toBe('30');
    });

    it('warns on missing template variables', () => {
      const template = 'Hello {{nonexistent.var}}!';
      const context = buildCronContext(
        {
          id: 'trigger-miss-001',
          name: 'Test',
          description: '',
          triggerCount: 0,
          cronTimezone: 'UTC',
          projectId: PROJECT_ID,
        },
        new Date(),
        PROJECT_NAME,
        'exec-miss-001',
        1,
      );

      const result = renderTemplate(template, context as unknown as Record<string, unknown>);

      expect(result.rendered).toBe('Hello !');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('nonexistent.var');
    });
  });

  // -------------------------------------------------------------------------
  // Execution state transitions
  // -------------------------------------------------------------------------
  describe('execution state transitions via Drizzle', () => {
    it('transitions execution from queued to running with linked taskId', async () => {
      await seedBaseData();
      const db = getDb();

      await seedTrigger('trigger-trans-001', PROJECT_ID, USER_ID);
      await seedTriggerExecution('exec-trans-001', 'trigger-trans-001', PROJECT_ID, {
        status: 'queued',
        taskId: null,
      });

      // Simulate: after submitTriggeredTask returns a taskId
      await db
        .update(schema.triggerExecutions)
        .set({ taskId: 'task-result-001', status: 'running' })
        .where(eq(schema.triggerExecutions.id, 'exec-trans-001'));

      const [updated] = await db
        .select()
        .from(schema.triggerExecutions)
        .where(eq(schema.triggerExecutions.id, 'exec-trans-001'));

      expect(updated.status).toBe('running');
      expect(updated.taskId).toBe('task-result-001');
    });

    it('transitions execution from queued to failed on submit error', async () => {
      await seedBaseData();
      const db = getDb();

      await seedTrigger('trigger-fail-001', PROJECT_ID, USER_ID);
      await seedTriggerExecution('exec-fail-001', 'trigger-fail-001', PROJECT_ID, {
        status: 'queued',
        taskId: null,
      });

      // Simulate: submitTriggeredTask threw an error
      const errorMsg = 'TaskRunner DO returned 500: internal error';
      await db
        .update(schema.triggerExecutions)
        .set({
          status: 'failed',
          errorMessage: errorMsg,
          completedAt: new Date().toISOString(),
        })
        .where(eq(schema.triggerExecutions.id, 'exec-fail-001'));

      const [updated] = await db
        .select()
        .from(schema.triggerExecutions)
        .where(eq(schema.triggerExecutions.id, 'exec-fail-001'));

      expect(updated.status).toBe('failed');
      expect(updated.errorMessage).toBe(errorMsg);
      expect(updated.completedAt).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Trigger metadata updates
  // -------------------------------------------------------------------------
  describe('trigger metadata updates', () => {
    it('updates lastTriggeredAt and increments triggerCount', async () => {
      await seedBaseData();
      const db = getDb();

      await seedTrigger('trigger-meta-001', PROJECT_ID, USER_ID, {
        triggerCount: 5,
        lastTriggeredAt: null,
      });

      const now = new Date();
      const sequenceNumber = 6;

      await db
        .update(schema.triggers)
        .set({
          lastTriggeredAt: now.toISOString(),
          triggerCount: sequenceNumber,
          updatedAt: now.toISOString(),
        })
        .where(eq(schema.triggers.id, 'trigger-meta-001'));

      const [updated] = await db
        .select()
        .from(schema.triggers)
        .where(eq(schema.triggers.id, 'trigger-meta-001'));

      expect(updated.triggerCount).toBe(6);
      expect(updated.lastTriggeredAt).toBe(now.toISOString());
    });

    it('advances nextFireAt using cronToNextFire', async () => {
      await seedBaseData();
      const db = getDb();

      const cronExpression = '0 9 * * *'; // daily at 9am
      await seedTrigger('trigger-advance-001', PROJECT_ID, USER_ID, {
        cronExpression,
        cronTimezone: 'UTC',
      });

      const nextFire = cronToNextFire(cronExpression, 'UTC');

      await db
        .update(schema.triggers)
        .set({ nextFireAt: nextFire })
        .where(eq(schema.triggers.id, 'trigger-advance-001'));

      const [updated] = await db
        .select()
        .from(schema.triggers)
        .where(eq(schema.triggers.id, 'trigger-advance-001'));

      expect(updated.nextFireAt).toBe(nextFire);

      // The next fire time should be in the future
      const nextFireDate = new Date(nextFire!);
      expect(nextFireDate.getTime()).toBeGreaterThan(Date.now());
      expect(nextFireDate.getUTCHours()).toBe(9);
      expect(nextFireDate.getUTCMinutes()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // cronToNextFire with real cron expressions
  // -------------------------------------------------------------------------
  describe('cronToNextFire with real expressions', () => {
    it('computes next fire for daily schedule', () => {
      const next = cronToNextFire('0 9 * * *', 'UTC');
      const nextDate = new Date(next);

      expect(nextDate.getTime()).toBeGreaterThan(Date.now());
      expect(nextDate.getUTCHours()).toBe(9);
      expect(nextDate.getUTCMinutes()).toBe(0);
    });

    it('handles timezone-aware computation', () => {
      // 9am EST — should be 14:00 UTC (EST = UTC-5)
      const next = cronToNextFire('0 9 * * *', 'America/New_York');
      const nextDate = new Date(next);

      expect(nextDate.getTime()).toBeGreaterThan(Date.now());
      // The hour in New York should be 9
      const nyFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        hour12: false,
      });
      const parts = nyFormatter.formatToParts(nextDate);
      const nyHour = parts.find((p) => p.type === 'hour')?.value;
      expect(nyHour).toBe('09');
    });

    it('computes next fire for weekly schedule (Monday at 8am)', () => {
      const next = cronToNextFire('0 8 * * 1', 'UTC');
      const nextDate = new Date(next);

      expect(nextDate.getTime()).toBeGreaterThan(Date.now());
      expect(nextDate.getUTCHours()).toBe(8);
      expect(nextDate.getUTCDay()).toBe(1); // Monday
    });

    it('computes next fire for every-15-minutes schedule', () => {
      const next = cronToNextFire('*/15 * * * *', 'UTC');
      const nextDate = new Date(next);

      expect(nextDate.getTime()).toBeGreaterThan(Date.now());
      expect(nextDate.getUTCMinutes() % 15).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Auto-pause after consecutive failures
  // -------------------------------------------------------------------------
  describe('auto-pause detection', () => {
    it('detects consecutive failures via recent execution query', async () => {
      await seedBaseData();
      const db = getDb();

      await seedTrigger('trigger-pause-001', PROJECT_ID, USER_ID);

      // Seed 3 consecutive failed executions (most recent first)
      for (let i = 0; i < 3; i++) {
        await seedTriggerExecution(`exec-pause-fail-${i}`, 'trigger-pause-001', PROJECT_ID, {
          status: 'failed',
          errorMessage: `Failure ${i}`,
          createdAt: new Date(Date.now() - i * 60_000).toISOString(),
        });
      }

      // Query consecutive failures (same logic as getConsecutiveFailureCount)
      const autoPauseThreshold = 3;
      const recentExecs = await db
        .select({ status: schema.triggerExecutions.status })
        .from(schema.triggerExecutions)
        .where(eq(schema.triggerExecutions.triggerId, 'trigger-pause-001'))
        .orderBy(desc(schema.triggerExecutions.createdAt))
        .limit(autoPauseThreshold);

      let failures = 0;
      for (const exec of recentExecs) {
        if (exec.status === 'failed') failures++;
        else break;
      }

      expect(failures).toBe(3);
      expect(failures >= autoPauseThreshold).toBe(true);
    });

    it('writes trigger status to paused when threshold met', async () => {
      await seedBaseData();
      const db = getDb();

      await seedTrigger('trigger-pause-write-001', PROJECT_ID, USER_ID, {
        status: 'active',
      });

      // Simulate auto-pause write
      await db
        .update(schema.triggers)
        .set({
          status: 'paused',
          nextFireAt: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.triggers.id, 'trigger-pause-write-001'));

      const [updated] = await db
        .select()
        .from(schema.triggers)
        .where(eq(schema.triggers.id, 'trigger-pause-write-001'));

      expect(updated.status).toBe('paused');
      expect(updated.nextFireAt).toBeNull();
    });

    it('does NOT trigger pause when a success breaks the failure streak', async () => {
      await seedBaseData();
      const db = getDb();

      await seedTrigger('trigger-streak-001', PROJECT_ID, USER_ID);

      // 2 failures, then 1 success, then 1 failure (oldest)
      await seedTriggerExecution('exec-streak-f1', 'trigger-streak-001', PROJECT_ID, {
        status: 'failed',
        createdAt: new Date(Date.now() - 1000).toISOString(),
      });
      await seedTriggerExecution('exec-streak-f2', 'trigger-streak-001', PROJECT_ID, {
        status: 'failed',
        createdAt: new Date(Date.now() - 2000).toISOString(),
      });
      await seedTriggerExecution('exec-streak-s1', 'trigger-streak-001', PROJECT_ID, {
        status: 'completed',
        createdAt: new Date(Date.now() - 3000).toISOString(),
      });
      await seedTriggerExecution('exec-streak-f3', 'trigger-streak-001', PROJECT_ID, {
        status: 'failed',
        createdAt: new Date(Date.now() - 4000).toISOString(),
      });

      const autoPauseThreshold = 3;
      const recentExecs = await db
        .select({ status: schema.triggerExecutions.status })
        .from(schema.triggerExecutions)
        .where(eq(schema.triggerExecutions.triggerId, 'trigger-streak-001'))
        .orderBy(desc(schema.triggerExecutions.createdAt))
        .limit(autoPauseThreshold);

      let failures = 0;
      for (const exec of recentExecs) {
        if (exec.status === 'failed') failures++;
        else break;
      }

      // Only 2 consecutive failures before the success breaks the streak
      expect(failures).toBe(2);
      expect(failures < autoPauseThreshold).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Skipped execution records
  // -------------------------------------------------------------------------
  describe('skipped execution records', () => {
    it('creates a skipped execution with skip_reason', async () => {
      await seedBaseData();
      const db = getDb();

      await seedTrigger('trigger-skipped-001', PROJECT_ID, USER_ID);

      // Simulate createSkippedExecution
      const executionId = 'exec-skipped-001';
      await db.insert(schema.triggerExecutions).values({
        id: executionId,
        triggerId: 'trigger-skipped-001',
        projectId: PROJECT_ID,
        status: 'skipped',
        skipReason: 'still_running',
        eventType: 'cron',
        scheduledAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        sequenceNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const [inserted] = await db
        .select()
        .from(schema.triggerExecutions)
        .where(eq(schema.triggerExecutions.id, executionId));

      expect(inserted.status).toBe('skipped');
      expect(inserted.skipReason).toBe('still_running');
      expect(inserted.completedAt).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end data flow trace (complete fire cycle minus submitTriggeredTask)
  // -------------------------------------------------------------------------
  describe('end-to-end fire cycle (D1 operations)', () => {
    it('executes full fire sequence: discover → render → insert execution → update metadata → advance', async () => {
      await seedBaseData();
      const db = getDb();

      const cronExpression = '30 14 * * *';
      await seedTrigger('trigger-e2e-001', PROJECT_ID, USER_ID, {
        name: 'E2E Daily Sweep',
        cronExpression,
        cronTimezone: 'UTC',
        triggerCount: 10,
        promptTemplate: 'Run sweep for {{project.name}} — trigger: {{trigger.name}} (fire #{{trigger.fireCount}})',
        nextFireAt: new Date(Date.now() - 60_000).toISOString(),
      });

      // Step 1: Discover due triggers
      const nowIso = new Date().toISOString();
      const dueTriggers = await db
        .select()
        .from(schema.triggers)
        .where(
          and(
            eq(schema.triggers.sourceType, 'cron'),
            eq(schema.triggers.status, 'active'),
            isNotNull(schema.triggers.nextFireAt),
            lte(schema.triggers.nextFireAt, nowIso),
          ),
        );

      const trigger = dueTriggers.find((t) => t.id === 'trigger-e2e-001');
      expect(trigger).toBeDefined();

      // Step 2: Render template
      const now = new Date();
      const sequenceNumber = (trigger!.triggerCount ?? 0) + 1;
      const executionId = 'exec-e2e-001';

      const context = buildCronContext(
        {
          id: trigger!.id,
          name: trigger!.name,
          description: trigger!.description ?? '',
          triggerCount: trigger!.triggerCount ?? 0,
          cronTimezone: trigger!.cronTimezone ?? 'UTC',
          projectId: trigger!.projectId,
        },
        now,
        PROJECT_NAME,
        executionId,
        sequenceNumber,
      );

      const rendered = renderTemplate(
        trigger!.promptTemplate,
        context as unknown as Record<string, unknown>,
      );

      expect(rendered.rendered).toContain('E2E Daily Sweep');
      expect(rendered.rendered).toContain(PROJECT_NAME);
      expect(rendered.rendered).toContain('fire #11');
      expect(rendered.warnings).toHaveLength(0);

      // Step 3: Insert execution record (queued)
      await db.insert(schema.triggerExecutions).values({
        id: executionId,
        triggerId: trigger!.id,
        projectId: PROJECT_ID,
        status: 'queued',
        eventType: 'cron',
        renderedPrompt: rendered.rendered,
        scheduledAt: trigger!.nextFireAt ?? now.toISOString(),
        startedAt: now.toISOString(),
        sequenceNumber,
        createdAt: now.toISOString(),
      });

      // Step 4: Simulate successful submit — transition to running
      const fakeTaskId = 'task-e2e-result-001';
      await db
        .update(schema.triggerExecutions)
        .set({ taskId: fakeTaskId, status: 'running' })
        .where(eq(schema.triggerExecutions.id, executionId));

      // Step 5: Update trigger metadata
      await db
        .update(schema.triggers)
        .set({
          lastTriggeredAt: now.toISOString(),
          triggerCount: sequenceNumber,
          updatedAt: now.toISOString(),
        })
        .where(eq(schema.triggers.id, trigger!.id));

      // Step 6: Advance nextFireAt
      const nextFire = cronToNextFire(cronExpression, 'UTC');
      await db
        .update(schema.triggers)
        .set({ nextFireAt: nextFire })
        .where(eq(schema.triggers.id, trigger!.id));

      // Verify final state
      const [finalExec] = await db
        .select()
        .from(schema.triggerExecutions)
        .where(eq(schema.triggerExecutions.id, executionId));

      expect(finalExec.status).toBe('running');
      expect(finalExec.taskId).toBe(fakeTaskId);
      expect(finalExec.renderedPrompt).toContain('E2E Daily Sweep');

      const [finalTrigger] = await db
        .select()
        .from(schema.triggers)
        .where(eq(schema.triggers.id, trigger!.id));

      expect(finalTrigger.triggerCount).toBe(11);
      expect(finalTrigger.lastTriggeredAt).toBe(now.toISOString());
      expect(finalTrigger.nextFireAt).toBe(nextFire);

      // Next fire should be tomorrow at 14:30 UTC
      const nextFireDate = new Date(nextFire!);
      expect(nextFireDate.getTime()).toBeGreaterThan(Date.now());
      expect(nextFireDate.getUTCHours()).toBe(14);
      expect(nextFireDate.getUTCMinutes()).toBe(30);
    });
  });
});
