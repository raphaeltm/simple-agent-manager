import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getDeploymentPublishJobSettings } from '../services/deployment-publish-job-settings';
import { failExpiredDeploymentPublishJobs } from '../services/deployment-publish-jobs';
import { recordDeploymentPublishJobLifecycleEventBestEffort } from '../services/project-lifecycle-events';

export async function runDeploymentPublishJobSweep(
  env: Env,
  waitUntil: (promise: Promise<unknown>) => void
) {
  const settings = await getDeploymentPublishJobSettings(env);
  const jobs = await failExpiredDeploymentPublishJobs(drizzle(env.DATABASE, { schema }), settings);
  for (const job of jobs) {
    // Durable state is written first; project-event delivery never blocks this control loop.
    waitUntil(
      recordDeploymentPublishJobLifecycleEventBestEffort(env, {
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
      })
    );
  }
  return { failed: jobs.length };
}
