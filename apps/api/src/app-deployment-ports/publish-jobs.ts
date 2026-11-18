/** Worker implementation of the app-deployment `DeploymentPublishJobPorts`. */
import type { DeploymentPublishJobPorts } from '@simple-agent-manager/app-deployment';

import type { Env } from '../env';
import { cancelBuildPublishJobOnVm } from '../routes/mcp/workspace-tools';
import { resolveAdminSetting } from '../services/admin-settings';
import { recordDeploymentPublishJobLifecycleEventBestEffort } from '../services/project-lifecycle-events';
import { createCloudflareBuildPorts } from './cloudflare-builder';

export function createDeploymentPublishJobPorts(env: Env): DeploymentPublishJobPorts {
  return {
    settings: { resolveSetting: (name) => resolveAdminSetting(env, name) },
    vm: {
      cancelPublishJob: (workspaceId, userId, nodeId, publishJobId, timeoutMs) =>
        cancelBuildPublishJobOnVm(env, workspaceId, userId, nodeId, publishJobId, timeoutMs),
    },
    builder: createCloudflareBuildPorts(env).builder,
    lifecycle: {
      recordPublishJobLifecycleEventBestEffort: (event) =>
        recordDeploymentPublishJobLifecycleEventBestEffort(env, event),
    },
  };
}
