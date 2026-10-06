import type { Env } from '../env';
import { log } from '../lib/logger';
import { runMonthlyCostAggregation } from '../services/ai-monthly-cost-cron';
import { runPlatformFeedbackTriage } from '../services/platform-feedback-triage';

export const PLATFORM_FEEDBACK_HOURLY_CRON = '30 * * * *';

export interface HourlyMaintenanceDeps {
  monthlyCost?: typeof runMonthlyCostAggregation;
  feedbackTriage?: typeof runPlatformFeedbackTriage;
}

/** Runs independent hourly jobs without allowing one failure to suppress the other. */
export async function runHourlyPlatformMaintenance(env: Env, deps: HourlyMaintenanceDeps = {}) {
  const [monthlyCost, feedbackTriage] = await Promise.allSettled([
    (deps.monthlyCost ?? runMonthlyCostAggregation)(env),
    (deps.feedbackTriage ?? runPlatformFeedbackTriage)(env, 'cron'),
  ]);
  return { monthlyCost, feedbackTriage };
}

export function isHourlyPlatformMaintenanceCron(cron: string): boolean {
  return cron === PLATFORM_FEEDBACK_HOURLY_CRON;
}

/** Owns the hourly cron boundary so matching and waitUntil behavior are testable. */
export function scheduleHourlyPlatformMaintenance(
  cron: string,
  env: Env,
  waitUntil: (promise: Promise<unknown>) => void,
  deps: HourlyMaintenanceDeps = {}
): boolean {
  if (!isHourlyPlatformMaintenanceCron(cron)) return false;
  waitUntil(
    runHourlyPlatformMaintenance(env, deps).then((hourly) => {
      const result = hourly.monthlyCost.status === 'fulfilled' ? hourly.monthlyCost.value : null;
      const feedbackTriage =
        hourly.feedbackTriage.status === 'fulfilled' ? hourly.feedbackTriage.value : null;
      log.info('cron.completed', {
        cron,
        type: 'monthly-cost-aggregation',
        monthlyCostEnabled: result?.enabled ?? false,
        monthlyCostFailed: hourly.monthlyCost.status === 'rejected',
        feedbackTriageEnabled: feedbackTriage?.enabled ?? false,
        feedbackTriageFailed: hourly.feedbackTriage.status === 'rejected',
        feedbackTriageGroupsFound: feedbackTriage?.groupsFound ?? 0,
        feedbackTriageIdeasCreated: feedbackTriage?.ideasCreated ?? 0,
        feedbackTriageIdeasUpdated: feedbackTriage?.ideasUpdated ?? 0,
        feedbackTriageGroupsSkipped: feedbackTriage?.groupsSkipped ?? 0,
        feedbackTriageGroupsFailed: feedbackTriage?.groupsFailed ?? 0,
        feedbackTriageGroupsBudgetDeferred: feedbackTriage?.groupsBudgetDeferred ?? 0,
        feedbackTriageFailureReasons: feedbackTriage?.failureReasons ?? [],
        monthlyCostUsersUpdated: result?.usersUpdated ?? 0,
        monthlyCostTotalEntries: result?.totalEntries ?? 0,
        monthlyCostErrors: result?.errors ?? 0,
      });
    })
  );
  return true;
}
