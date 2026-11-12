import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import { cancelDeploymentPublishJobOnVmBestEffort } from '../deployment-publish-job-cancel';
import { getDeploymentPublishJobSettings } from '../deployment-publish-job-settings';
import { failExpiredDeploymentPublishJobs } from '../deployment-publish-jobs';
import type { AppDeploymentEnv } from '../env';
import type { DeploymentPublishJobPorts } from '../ports';

export async function runDeploymentPublishJobSweep(
  env: Pick<AppDeploymentEnv, 'DATABASE'>,
  ports: DeploymentPublishJobPorts,
  waitUntil: (promise: Promise<unknown>) => void
) {
  const settings = await getDeploymentPublishJobSettings(ports.settings);
  const jobs = await failExpiredDeploymentPublishJobs(drizzle(env.DATABASE, { schema }), settings);
  for (const job of jobs) {
    // Durable state is written first. Each selected job adds one bounded cancellation
    // and one lifecycle delivery; neither network operation blocks the sweep.
    waitUntil(
      Promise.all([
        ports.lifecycle.recordPublishJobLifecycleEventBestEffort({
          projectId: job.projectId,
          publishJobId: job.id,
          environmentId: job.environmentId,
          status: 'failed',
          terminal: true,
          currentStep: job.currentStep,
          workspaceId: job.workspaceId,
          nodeId: job.nodeId,
          taskId: job.taskId,
          source: 'scheduled.deployment_publish_jobs',
          occurredAt: job.completedAt ?? job.updatedAt,
        }),
        cancelDeploymentPublishJobOnVmBestEffort(ports, job, settings.cancelTimeoutMs),
      ])
    );
  }
  return { failed: jobs.length };
}
