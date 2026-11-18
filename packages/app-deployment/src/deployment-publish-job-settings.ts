import type { DeploymentSettingsPort } from './ports';

export async function getDeploymentPublishJobSettings(settings: DeploymentSettingsPort) {
  const [stallMs, deadlineMs, sweepLimit, cancelTimeoutMs] = await Promise.all([
    settings.resolveSetting('deployments.publishJobStallMs'),
    settings.resolveSetting('deployments.publishJobDeadlineMs'),
    settings.resolveSetting('deployments.publishJobSweepLimit'),
    settings.resolveSetting('deployments.publishJobCancelTimeoutMs'),
  ]);
  return {
    stallMs: Number(stallMs),
    deadlineMs: Number(deadlineMs),
    sweepLimit: Number(sweepLimit),
    cancelTimeoutMs: Number(cancelTimeoutMs),
  };
}
