import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { runAnalyticsForwardJob } from '../scheduled/analytics-forward';
import { runComputeUsageCleanup } from '../scheduled/compute-usage-cleanup';
import { runCronTriggerSweep } from '../scheduled/cron-triggers';
import { runNodeCleanupSweep } from '../scheduled/node-cleanup';
import { runObservabilityPurge } from '../scheduled/observability-purge';
import { recoverStuckTasks } from '../scheduled/stuck-tasks';
import { runTrialExpireSweep } from '../scheduled/trial-expire';
import { runTrialRolloverAudit } from '../scheduled/trial-rollover';
import { runTrialWaitlistCleanup } from '../scheduled/trial-waitlist-cleanup';
import { runTriggerExecutionCleanup } from '../scheduled/trigger-execution-cleanup';
import { runMonthlyCostAggregation } from '../services/ai-monthly-cost-cron';
import { checkProvisioningTimeouts } from '../services/timeout';
import { migrateOrphanedWorkspaces } from '../services/workspace-migration';

export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const rolloverCron = env.TRIAL_CRON_ROLLOVER_CRON ?? '0 5 1 * *';
  const waitlistCleanupCron = env.TRIAL_CRON_WAITLIST_CLEANUP ?? '0 4 * * *';

  const isDailyForward = controller.cron === '0 3 * * *';
  const isMonthlyCostAggregation = controller.cron === '30 * * * *';
  const isTrialRollover = controller.cron === rolloverCron;
  const isTrialWaitlistCleanup = controller.cron === waitlistCleanupCron;

  const cronType = isDailyForward
    ? 'daily-forward'
    : isMonthlyCostAggregation
      ? 'monthly-cost-aggregation'
      : isTrialRollover
        ? 'trial-rollover'
        : isTrialWaitlistCleanup
          ? 'trial-waitlist-cleanup'
          : 'sweep';

  log.info('cron.started', {
    cron: controller.cron,
    type: cronType,
  });

  if (isMonthlyCostAggregation) {
    ctx.waitUntil((async () => {
      const result = await runMonthlyCostAggregation(env);
      log.info('cron.completed', {
        cron: controller.cron,
        type: 'monthly-cost-aggregation',
        monthlyCostEnabled: result.enabled,
        monthlyCostUsersUpdated: result.usersUpdated,
        monthlyCostTotalEntries: result.totalEntries,
        monthlyCostErrors: result.errors,
      });
    })());
    return;
  }

  if (isDailyForward) {
    ctx.waitUntil((async () => {
      const forward = await runAnalyticsForwardJob(env);
      log.info('cron.completed', {
        cron: controller.cron,
        type: 'daily-forward',
        forwardEnabled: forward.enabled,
        forwardEventsQueried: forward.eventsQueried,
        forwardSegmentSent: forward.segment.sent,
        forwardGA4Sent: forward.ga4.sent,
        forwardCursorUpdated: forward.cursorUpdated,
      });
    })());
    return;
  }

  if (isTrialRollover) {
    ctx.waitUntil((async () => {
      const rollover = await runTrialRolloverAudit(env);
      log.info('cron.completed', {
        cron: controller.cron,
        type: 'trial-rollover',
        trialRolloverMonthKey: rollover.monthKey,
        trialRolloverPruned: rollover.pruned,
      });
    })());
    return;
  }

  if (isTrialWaitlistCleanup) {
    ctx.waitUntil((async () => {
      const waitlist = await runTrialWaitlistCleanup(env);
      log.info('cron.completed', {
        cron: controller.cron,
        type: 'trial-waitlist-cleanup',
        trialWaitlistPurged: waitlist.purged,
      });
    })());
    return;
  }

  const timedOut = await checkProvisioningTimeouts(env.DATABASE, env, env.OBSERVABILITY_DATABASE);
  const db = drizzle(env.DATABASE, { schema });
  const migrated = await migrateOrphanedWorkspaces(db);
  const nodeCleanup = await runNodeCleanupSweep(env);
  const stuckTasks = await recoverStuckTasks(env);
  const observabilityPurge = await runObservabilityPurge(env);
  const cronTriggers = await runCronTriggerSweep(env);
  const triggerCleanup = await runTriggerExecutionCleanup(env);
  const computeUsageClosed = await runComputeUsageCleanup(env);
  const trialExpire = await runTrialExpireSweep(env);

  log.info('cron.completed', {
    cron: controller.cron,
    type: 'sweep',
    provisioningTimedOut: timedOut,
    workspacesMigrated: migrated,
    staleNodesDestroyed: nodeCleanup.staleDestroyed,
    lifetimeNodesDestroyed: nodeCleanup.lifetimeDestroyed,
    lifetimeNodesSkipped: nodeCleanup.lifetimeSkipped,
    nodeCleanupErrors: nodeCleanup.errors,
    orphanedWorkspacesFlagged: nodeCleanup.orphanedWorkspacesFlagged,
    orphanedNodesFlagged: nodeCleanup.orphanedNodesFlagged,
    stuckTasksFailedQueued: stuckTasks.failedQueued,
    stuckTasksFailedDelegated: stuckTasks.failedDelegated,
    stuckTasksFailedInProgress: stuckTasks.failedInProgress,
    stuckTasksHeartbeatSkipped: stuckTasks.heartbeatSkipped,
    stuckTaskErrors: stuckTasks.errors,
    stuckTaskDoHealthChecked: stuckTasks.doHealthChecked,
    observabilityPurgedByAge: observabilityPurge.deletedByAge,
    observabilityPurgedByCount: observabilityPurge.deletedByCount,
    cronTriggersChecked: cronTriggers.checked,
    cronTriggersFired: cronTriggers.fired,
    cronTriggersSkipped: cronTriggers.skipped,
    cronTriggersFailed: cronTriggers.failed,
    triggerExecStaleRecovered: triggerCleanup.staleRecovered,
    triggerExecStaleQueuedRecovered: triggerCleanup.staleQueuedRecovered,
    triggerExecRetentionPurged: triggerCleanup.retentionPurged,
    triggerExecCleanupErrors: triggerCleanup.errors,
    computeUsageOrphansClosed: computeUsageClosed,
    trialExpired: trialExpire.expired,
  });
}
