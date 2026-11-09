import type { Env } from '../env';
import { fetchNodeAgent } from './node-agent';
import { signNodeManagementToken } from './jwt';
import { vmAgentUrlForPath } from '../routes/mcp/workspace-tools';
import { resolveAdminSetting } from './admin-settings';
import type { DeploymentPublishJobRow } from '../db/schema';

/** Phase-2 primitive only. Executor selection and dispatch are phase 3. A 404
 * is capability absence, never success or permission to silently switch an
 * explicitly selected executor. The caller owns any permitted node fallback. */
export async function collectBuildContextOnSource(
  env: Env,
  job: DeploymentPublishJobRow,
  interpolation: {
    buildInterpolationEnv: Record<string, string>;
    secretInterpolationKeys: string[];
  }
) {
  const [maxBytes, collectTimeoutMs, deadlineMs] = await Promise.all([
    resolveAdminSetting(env, 'deployments.buildContextMaxBytes'),
    resolveAdminSetting(env, 'deployments.buildContextCollectTimeoutMs'),
    resolveAdminSetting(env, 'deployments.publishJobDeadlineMs'),
  ]);
  const { token } = await signNodeManagementToken(
    job.requestedBy,
    job.nodeId,
    job.workspaceId,
    env
  );
  const path = `/workspaces/${encodeURIComponent(job.workspaceId)}/mcp/build-and-publish-jobs/${encodeURIComponent(job.id)}/collect`;
  const response = await fetchNodeAgent(
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
      body: JSON.stringify({
        publishJobId: job.id,
        attempt: job.attempt,
        workingDir: job.workingDir,
        maxBytes: Number(maxBytes),
        collectTimeoutMs: Number(collectTimeoutMs),
        ...interpolation,
      }),
      signal: AbortSignal.timeout(Number(deadlineMs)),
    },
    Number(deadlineMs),
    { noWakeContainer: true, recoverContainerOnTimeout: false }
  );
  if (response.status === 404)
    return {
      supported: false as const,
      message:
        'This source agent does not support build-context collection. Restart the workspace to install the current agent; Instant publishing requires the Cloudflare executor rollout.',
    };
  if (!response.ok)
    throw new Error(
      `Build-context collection failed (${response.status}); inspect publish job events before retrying`
    );
  return { supported: true as const };
}
