import type { Env } from '../env';
import { runMonthlyCostAggregation } from '../services/ai-monthly-cost-cron';
import { runPlatformFeedbackTriage } from '../services/platform-feedback-triage';

interface HourlyMaintenanceDeps {
  monthlyCost?: typeof runMonthlyCostAggregation;
  feedbackTriage?: typeof runPlatformFeedbackTriage;
}

/** Runs independent hourly jobs without allowing one failure to suppress the other. */
export async function runHourlyPlatformMaintenance(
  env: Env,
  deps: HourlyMaintenanceDeps = {}
) {
  const [monthlyCost, feedbackTriage] = await Promise.allSettled([
    (deps.monthlyCost ?? runMonthlyCostAggregation)(env),
    (deps.feedbackTriage ?? runPlatformFeedbackTriage)(env, 'cron'),
  ]);
  return { monthlyCost, feedbackTriage };
}
