/**
 * The capacity-pool continuation cron (`CAPACITY_POOL_CONTINUATION_CRON`), moved out of
 * `handler.ts` unchanged. It is not part of the operational sweep chain.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { isOperationalLoopEnabled } from '../services/operational-kill-switch';
import { runScheduledCapacityPoolContinuations } from './capacity-pool-continuation';
import { notifyFailedSweeps } from './failed-sweep-notifications';
import { createSweepIsolator } from './sweep-isolation';

export async function runCapacityPoolContinuationCron(
  controller: ScheduledController,
  env: Env
): Promise<void> {
  const type = 'capacity-pool-continuation';
  log.info('cron.started', { cron: controller.cron, type });
  const continuationSweeps = createSweepIsolator(env);
  const result = await continuationSweeps.isolate('capacity_pool_continuation', async () => {
    if (!(await isOperationalLoopEnabled(env, 'cron'))) {
      log.info('cron.skipped_disabled', { cron: controller.cron, type, switch: 'cron' });
      return { resumed: 0, failed: 0, skipped: true };
    }
    return { ...(await runScheduledCapacityPoolContinuations(env)), skipped: false };
  });
  const failedSweeps = continuationSweeps.failedSweeps();
  log.info('cron.completed', {
    cron: controller.cron,
    type,
    resumed: result?.resumed ?? null,
    failed: result?.failed ?? 1,
    skipped: result?.skipped ?? false,
    failedSweeps,
  });
  if (failedSweeps.length > 0) {
    await notifyFailedSweeps(env, failedSweeps).catch(() => {
      log.error('cron.failed_sweep_notification_failed', { type });
    });
  }
}
