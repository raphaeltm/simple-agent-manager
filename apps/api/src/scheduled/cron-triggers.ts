/**
 * Cron Trigger Sweep Engine
 *
 * Runs every 5 minutes as part of the operational sweep. Queries all active
 * cron triggers whose nextFireAt <= now, evaluates skip conditions, renders
 * templates, and submits tasks via submitTriggeredTask().
 *
 * Configurable via:
 * - CRON_SWEEP_ENABLED (default: true) — kill switch
 * - CRON_MAX_FIRE_PER_SWEEP (default: 5) — max triggers to fire per sweep
 * - TRIGGER_AUTO_PAUSE_AFTER_FAILURES (default: 3) — auto-pause threshold
 */
import {
  DEFAULT_CRON_MAX_FIRE_PER_SWEEP,
  DEFAULT_TRIGGER_AUTO_PAUSE_AFTER_FAILURES,
  DEFAULT_TRIGGER_DEFAULT_MAX_CONCURRENT,
} from '@simple-agent-manager/shared';
import { and, count, desc, eq, isNotNull, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../index';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { ulid } from '../lib/ulid';
import { cronToNextFire } from '../services/cron-utils';
import { submitTriggeredTask } from '../services/trigger-submit';
import { buildCronContext, renderTemplate } from '../services/trigger-template';

export interface CronSweepStats {
  checked: number;
  fired: number;
  skipped: number;
  failed: number;
}

/**
 * Run the cron trigger sweep. Called from the 5-minute scheduled handler.
 */
export async function runCronTriggerSweep(env: Env): Promise<CronSweepStats> {
  // Kill switch
  const enabled = env.CRON_SWEEP_ENABLED !== 'false';
  if (!enabled) {
    return { checked: 0, fired: 0, skipped: 0, failed: 0 };
  }

  const db = drizzle(env.DATABASE, { schema });
  const now = new Date();
  const nowIso = now.toISOString();

  const maxFirePerSweep = parsePositiveInt(env.CRON_MAX_FIRE_PER_SWEEP, DEFAULT_CRON_MAX_FIRE_PER_SWEEP);
  const autoPauseThreshold = parsePositiveInt(env.TRIGGER_AUTO_PAUSE_AFTER_FAILURES, DEFAULT_TRIGGER_AUTO_PAUSE_AFTER_FAILURES);

  // Query all active cron triggers where nextFireAt <= now
  // Guard: isNotNull prevents NULL nextFireAt rows from being silently excluded by lte()
  const dueTriggers = await db
    .select()
    .from(schema.triggers)
    .where(
      and(
        eq(schema.triggers.sourceType, 'cron'),
        eq(schema.triggers.status, 'active'),
        isNotNull(schema.triggers.nextFireAt),
        lte(schema.triggers.nextFireAt, nowIso)
      )
    )
    .limit(maxFirePerSweep);

  const stats: CronSweepStats = {
    checked: dueTriggers.length,
    fired: 0,
    skipped: 0,
    failed: 0,
  };

  for (const trigger of dueTriggers) {
    try {
      const result = await processTrigger(db, env, trigger, now, autoPauseThreshold);
      if (result === 'fired') stats.fired++;
      else if (result === 'skipped') stats.skipped++;
      else if (result === 'failed') stats.failed++;
    } catch (err) {
      stats.failed++;
      log.error('cron_sweep.trigger_error', {
        triggerId: trigger.id,
        projectId: trigger.projectId,
        error: err instanceof Error ? err.message : String(err),
      });

      // Always advance nextFireAt to prevent retry storm
      await advanceNextFireAt(db, trigger);
    }
  }

  return stats;
}

type ProcessResult = 'fired' | 'skipped' | 'failed';

async function processTrigger(
  db: ReturnType<typeof drizzle<typeof schema>>,
  env: Env,
  trigger: schema.TriggerRow,
  now: Date,
  autoPauseThreshold: number
): Promise<ProcessResult> {
  const triggerId = trigger.id;
  const projectId = trigger.projectId;

  // Check consecutive failures — auto-pause if threshold reached
  const consecutiveFailures = await getConsecutiveFailureCount(db, triggerId, autoPauseThreshold);
  if (consecutiveFailures >= autoPauseThreshold) {
    log.warn('cron_sweep.auto_pause', { triggerId, projectId, consecutiveFailures, threshold: autoPauseThreshold });
    await db
      .update(schema.triggers)
      .set({
        status: 'paused',
        nextFireAt: null,
        updatedAt: now.toISOString(),
      })
      .where(eq(schema.triggers.id, triggerId));
    return 'skipped';
  }

  // Check skipIfRunning
  if (trigger.skipIfRunning) {
    const [runningCount] = await db
      .select({ count: count() })
      .from(schema.triggerExecutions)
      .where(
        and(
          eq(schema.triggerExecutions.triggerId, triggerId),
          eq(schema.triggerExecutions.status, 'running')
        )
      );
    if ((runningCount?.count ?? 0) > 0) {
      log.info('cron_sweep.skip_running', { triggerId, projectId });
      await createSkippedExecution(db, trigger, now, 'still_running');
      await advanceNextFireAt(db, trigger);
      return 'skipped';
    }
  }

  // Check maxConcurrent
  const maxConcurrent = trigger.maxConcurrent ?? DEFAULT_TRIGGER_DEFAULT_MAX_CONCURRENT;
  const [activeCount] = await db
    .select({ count: count() })
    .from(schema.triggerExecutions)
    .where(
      and(
        eq(schema.triggerExecutions.triggerId, triggerId),
        eq(schema.triggerExecutions.status, 'running')
      )
    );
  if ((activeCount?.count ?? 0) >= maxConcurrent) {
    log.info('cron_sweep.skip_concurrent', { triggerId, projectId, maxConcurrent });
    await createSkippedExecution(db, trigger, now, 'concurrent_limit');
    await advanceNextFireAt(db, trigger);
    return 'skipped';
  }

  // Resolve project name for template context
  const [project] = await db
    .select({ name: schema.projects.name })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);

  const executionId = ulid();
  const sequenceNumber = (trigger.triggerCount ?? 0) + 1;

  // Render prompt template
  const context = buildCronContext(
    {
      id: trigger.id,
      name: trigger.name,
      description: trigger.description ?? '',
      triggerCount: trigger.triggerCount ?? 0,
      cronTimezone: trigger.cronTimezone ?? 'UTC',
      projectId: trigger.projectId,
    },
    now,
    project?.name ?? 'Unknown',
    executionId,
    sequenceNumber
  );

  const rendered = renderTemplate(trigger.promptTemplate, context as unknown as Record<string, unknown>);

  // Create execution record (status: queued)
  await db.insert(schema.triggerExecutions).values({
    id: executionId,
    triggerId,
    projectId,
    status: 'queued',
    eventType: 'cron',
    renderedPrompt: rendered.rendered,
    scheduledAt: trigger.nextFireAt ?? now.toISOString(),
    startedAt: now.toISOString(),
    sequenceNumber,
    createdAt: now.toISOString(),
  });

  // Submit task
  try {
    const result = await submitTriggeredTask(env, {
      triggerId,
      triggerExecutionId: executionId,
      projectId,
      userId: trigger.userId,
      renderedPrompt: rendered.rendered,
      triggeredBy: 'cron',
      agentProfileId: trigger.agentProfileId,
      taskMode: (trigger.taskMode ?? 'task') as 'task' | 'conversation',
      vmSizeOverride: trigger.vmSizeOverride,
      triggerName: trigger.name,
    });

    // Update execution: queued -> running
    await db
      .update(schema.triggerExecutions)
      .set({ taskId: result.taskId, status: 'running' })
      .where(eq(schema.triggerExecutions.id, executionId));

    // Update trigger metadata
    await db
      .update(schema.triggers)
      .set({
        lastTriggeredAt: now.toISOString(),
        triggerCount: sequenceNumber,
        updatedAt: now.toISOString(),
      })
      .where(eq(schema.triggers.id, triggerId));

    // Advance nextFireAt
    await advanceNextFireAt(db, trigger);

    log.info('cron_sweep.fired', {
      triggerId,
      executionId,
      taskId: result.taskId,
      projectId,
    });

    return 'fired';
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.triggerExecutions)
      .set({
        status: 'failed',
        errorMessage: errorMsg,
        completedAt: new Date().toISOString(),
      })
      .where(eq(schema.triggerExecutions.id, executionId));

    // Always advance to prevent retry storm
    await advanceNextFireAt(db, trigger);

    log.error('cron_sweep.fire_failed', {
      triggerId,
      executionId,
      projectId,
      error: errorMsg,
    });

    return 'failed';
  }
}

/**
 * Count consecutive failures from the most recent executions.
 */
async function getConsecutiveFailureCount(
  db: ReturnType<typeof drizzle<typeof schema>>,
  triggerId: string,
  autoPauseThreshold: number
): Promise<number> {
  const recentExecs = await db
    .select({ status: schema.triggerExecutions.status })
    .from(schema.triggerExecutions)
    .where(eq(schema.triggerExecutions.triggerId, triggerId))
    .orderBy(desc(schema.triggerExecutions.createdAt))
    .limit(autoPauseThreshold);

  let failures = 0;
  for (const exec of recentExecs) {
    if (exec.status === 'failed') {
      failures++;
    } else {
      break;
    }
  }
  return failures;
}

/**
 * Create a skipped execution record.
 */
async function createSkippedExecution(
  db: ReturnType<typeof drizzle<typeof schema>>,
  trigger: schema.TriggerRow,
  now: Date,
  skipReason: string
): Promise<void> {
  await db.insert(schema.triggerExecutions).values({
    id: ulid(),
    triggerId: trigger.id,
    projectId: trigger.projectId,
    status: 'skipped',
    skipReason,
    eventType: 'cron',
    scheduledAt: trigger.nextFireAt ?? now.toISOString(),
    completedAt: now.toISOString(),
    sequenceNumber: (trigger.triggerCount ?? 0) + 1,
    createdAt: now.toISOString(),
  });
}

/**
 * Advance a trigger's nextFireAt to the next scheduled time.
 * Always called even on skip/error to prevent retry storms.
 */
async function advanceNextFireAt(
  db: ReturnType<typeof drizzle<typeof schema>>,
  trigger: schema.TriggerRow
): Promise<void> {
  if (!trigger.cronExpression) return;

  const nextFire = cronToNextFire(
    trigger.cronExpression,
    trigger.cronTimezone ?? 'UTC'
  );

  await db
    .update(schema.triggers)
    .set({ nextFireAt: nextFire })
    .where(eq(schema.triggers.id, trigger.id));
}
