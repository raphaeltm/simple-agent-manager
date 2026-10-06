/** Cron source adapter. Scheduling stays here; execution policy lives in trigger-admission. */
import { DEFAULT_CRON_MAX_FIRE_PER_SWEEP } from '@simple-agent-manager/shared';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { expectJsonRecord } from '../lib/runtime-validation';
import { cronToNextFire } from '../services/cron-utils';
import { admitAndSubmitTriggerExecution } from '../services/trigger-admission';
import { buildCronContext, renderTemplate } from '../services/trigger-template';

export interface CronSweepStats {
  checked: number;
  fired: number;
  skipped: number;
  failed: number;
}

type ProcessResult = 'fired' | 'skipped' | 'failed';

export async function runCronTriggerSweep(env: Env): Promise<CronSweepStats> {
  if (env.CRON_SWEEP_ENABLED === 'false') {
    return { checked: 0, fired: 0, skipped: 0, failed: 0 };
  }

  const db = drizzle(env.DATABASE, { schema });
  const now = new Date();
  const dueTriggers = await db
    .select()
    .from(schema.triggers)
    .where(
      and(
        eq(schema.triggers.sourceType, 'cron'),
        eq(schema.triggers.status, 'active'),
        isNotNull(schema.triggers.nextFireAt),
        lte(schema.triggers.nextFireAt, now.toISOString())
      )
    )
    .limit(parsePositiveInt(env.CRON_MAX_FIRE_PER_SWEEP, DEFAULT_CRON_MAX_FIRE_PER_SWEEP));

  const stats: CronSweepStats = {
    checked: dueTriggers.length,
    fired: 0,
    skipped: 0,
    failed: 0,
  };
  for (const trigger of dueTriggers) {
    try {
      stats[await processTrigger(db, env, trigger, now)] += 1;
    } catch (error) {
      stats.failed += 1;
      log.error('cron_sweep.trigger_error', {
        triggerId: trigger.id,
        projectId: trigger.projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      await advanceNextFireAt(db, trigger);
    }
  }
  return stats;
}

async function processTrigger(
  db: ReturnType<typeof drizzle<typeof schema>>,
  env: Env,
  trigger: schema.TriggerRow,
  now: Date
): Promise<ProcessResult> {
  const project = await db
    .select({ name: schema.projects.name })
    .from(schema.projects)
    .where(eq(schema.projects.id, trigger.projectId))
    .get();

  const result = await admitAndSubmitTriggerExecution(env, {
    trigger,
    eventType: 'cron',
    triggeredBy: 'cron',
    scheduledAt: trigger.nextFireAt ?? now.toISOString(),
    renderPrompt: (executionId, sequenceNumber) => {
      const context = buildCronContext(
        {
          id: trigger.id,
          name: trigger.name,
          description: trigger.description ?? '',
          triggerCount: trigger.triggerCount,
          cronTimezone: trigger.cronTimezone ?? 'UTC',
          projectId: trigger.projectId,
        },
        now,
        project?.name ?? 'Unknown',
        executionId,
        sequenceNumber
      );
      return renderTemplate(
        trigger.promptTemplate,
        expectJsonRecord(context, 'trigger.template_context')
      ).rendered;
    },
  });

  await advanceNextFireAt(db, trigger);
  if (result.outcome === 'submitted' || result.outcome === 'pending') {
    log.info('cron_sweep.fired', {
      triggerId: trigger.id,
      executionId: result.executionId,
      taskId: result.taskId,
      projectId: trigger.projectId,
      submissionPending: result.outcome === 'pending',
    });
    return 'fired';
  }
  return result.outcome === 'failed' ? 'failed' : 'skipped';
}

async function advanceNextFireAt(
  db: ReturnType<typeof drizzle<typeof schema>>,
  trigger: schema.TriggerRow
): Promise<void> {
  if (!trigger.cronExpression) return;
  await db
    .update(schema.triggers)
    .set({ nextFireAt: cronToNextFire(trigger.cronExpression, trigger.cronTimezone ?? 'UTC') })
    .where(eq(schema.triggers.id, trigger.id));
}
