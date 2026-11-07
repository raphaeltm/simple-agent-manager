import type { Env } from '../env';
import { resolveAdminSetting } from './admin-settings';

export async function getDeploymentPublishJobSettings(env: Env) {
  const [stallMs, deadlineMs, sweepLimit, cancelTimeoutMs] = await Promise.all([
    resolveAdminSetting(env, 'deployments.publishJobStallMs'),
    resolveAdminSetting(env, 'deployments.publishJobDeadlineMs'),
    resolveAdminSetting(env, 'deployments.publishJobSweepLimit'),
    resolveAdminSetting(env, 'deployments.publishJobCancelTimeoutMs'),
  ]);
  return {
    stallMs: Number(stallMs),
    deadlineMs: Number(deadlineMs),
    sweepLimit: Number(sweepLimit),
    cancelTimeoutMs: Number(cancelTimeoutMs),
  };
}
