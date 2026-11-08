import type { DeploymentPublishJobRow } from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { cancelBuildPublishJobOnVm } from '../routes/mcp/workspace-tools';
import { getDeploymentPublishJobSettings } from './deployment-publish-job-settings';

/** Durable verdicts are authoritative even if an old or dead executor cannot cancel. */
export async function cancelDeploymentPublishJobOnVmBestEffort(
  env: Env,
  job: Pick<DeploymentPublishJobRow, 'id' | 'workspaceId' | 'nodeId' | 'requestedBy'>,
  timeoutOverrideMs?: number
) {
  try {
    const timeoutMs =
      timeoutOverrideMs ?? (await getDeploymentPublishJobSettings(env)).cancelTimeoutMs;
    await cancelBuildPublishJobOnVm(
      env,
      job.workspaceId,
      job.requestedBy,
      job.nodeId,
      job.id,
      timeoutMs
    );
  } catch (error) {
    const statusCode =
      error instanceof Error
        ? Number(/^VM agent returned (\d{3}):/.exec(error.message)?.[1]) || null
        : null;
    // Do not log the agent's response body: it may contain command output or secrets.
    const fields = {
      publishJobId: job.id,
      nodeId: job.nodeId,
      statusCode,
      errorType: error instanceof Error ? error.name : 'unknown',
    };
    if (statusCode === 404) log.info('deployment_publish_job.cancel_unavailable', fields);
    else log.warn('deployment_publish_job.cancel_failed', fields);
  }
}
