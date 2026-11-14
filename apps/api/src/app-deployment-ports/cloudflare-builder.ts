import {
  type CloudflareBuildPorts,
  DEFAULT_DEPLOY_BUILDER_MAX_CONCURRENT,
  isCloudflareBuildCapacityError,
} from '@simple-agent-manager/app-deployment';

import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { resolveAdminSetting } from '../services/admin-settings';
import { recordDeploymentPublishJobLifecycleEventBestEffort } from '../services/project-lifecycle-events';

export function createCloudflareBuildPorts(env: Env): CloudflareBuildPorts {
  const stub = (jobId: string) => env.COMPOSE_BUILDER.get(env.COMPOSE_BUILDER.idFromName(jobId));
  return {
    classMax: parsePositiveInt(
      env.DEPLOY_BUILDER_CLASS_MAX_INSTANCES,
      DEFAULT_DEPLOY_BUILDER_MAX_CONCURRENT
    ),
    settings: { resolveSetting: (name) => resolveAdminSetting(env, name) },
    lifecycle: {
      recordPublishJobLifecycleEventBestEffort: (event) =>
        recordDeploymentPublishJobLifecycleEventBestEffort(env, event),
    },
    builder: {
      start: async (job) => {
        try {
          await stub(job.id).startJob(job.id, job.attempt);
          return 'started';
        } catch (error) {
          // Only platform capacity is retryable queue pressure. Never interpret
          // authentication, image/startup errors or a lost RPC as capacity.
          if (isCloudflareBuildCapacityError(error)) return 'capacity';
          throw error;
        }
      },
      stop: async (job) => {
        await stub(job.id).stopJob();
      },
    },
  };
}
