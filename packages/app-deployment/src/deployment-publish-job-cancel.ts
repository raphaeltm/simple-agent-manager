import { log } from '@simple-agent-manager/worker-core';
import type { DeploymentPublishJobRow } from '@simple-agent-manager/worker-core/schema';

import { getDeploymentPublishJobSettings } from './deployment-publish-job-settings';
import type { DeploymentPublishJobPorts } from './ports';

/** Durable verdicts are authoritative even if an old or dead executor cannot cancel. */
export async function cancelDeploymentPublishJobOnVmBestEffort(
  ports: Pick<DeploymentPublishJobPorts, 'settings' | 'vm' | 'builder'>,
  job: Pick<DeploymentPublishJobRow, 'id' | 'workspaceId' | 'nodeId' | 'requestedBy'> &
    Partial<DeploymentPublishJobRow>,
  timeoutOverrideMs?: number
) {
  try {
    if (job.executor === 'cloudflare' && job.executorInstanceId) {
      if (ports.builder) await ports.builder.stop(job);
      return;
    }
    const timeoutMs =
      timeoutOverrideMs ?? (await getDeploymentPublishJobSettings(ports.settings)).cancelTimeoutMs;
    await ports.vm.cancelPublishJob(
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
