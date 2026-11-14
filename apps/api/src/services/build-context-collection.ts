/** Worker wiring for source-agent authentication and transport. */
import {
  type BuildContextCollectionPorts,
  type BuildContextInterpolation,
  collectBuildContextOnSource as collect,
} from '@simple-agent-manager/app-deployment';

import type { DeploymentPublishJobRow } from '../db/schema';
import type { Env } from '../env';
import { vmAgentUrlForPath } from '../routes/mcp/workspace-tools';
import { resolveAdminSetting } from './admin-settings';
import { signNodeManagementToken } from './jwt';
import { fetchNodeAgent } from './node-agent';

export function createBuildContextCollectionPorts(env: Env): BuildContextCollectionPorts {
  return {
    settings: { resolveSetting: (name) => resolveAdminSetting(env, name) },
    source: {
      requestCollection: async (job, body, timeoutMs) => {
        const { token } = await signNodeManagementToken(
          job.requestedBy,
          job.nodeId,
          job.workspaceId,
          env
        );
        const path = `/workspaces/${encodeURIComponent(job.workspaceId)}/mcp/build-and-publish-jobs/${encodeURIComponent(job.id)}/collect`;
        return fetchNodeAgent(
          job.nodeId,
          env,
          vmAgentUrlForPath(env, job.nodeId, path),
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'X-SAM-Node-Id': job.nodeId,
              'X-SAM-Workspace-Id': job.workspaceId,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          },
          timeoutMs,
          { noWakeContainer: true, recoverContainerOnTimeout: false }
        );
      },
    },
  };
}

export function collectBuildContextOnSource(
  env: Env,
  job: DeploymentPublishJobRow,
  interpolation: BuildContextInterpolation
) {
  return collect(createBuildContextCollectionPorts(env), job, interpolation);
}
