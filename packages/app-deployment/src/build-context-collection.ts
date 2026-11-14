import type { DeploymentPublishJobRow } from '@simple-agent-manager/worker-core/schema';

import type { BuildContextCollectionPorts } from './ports';

/** Phase-2 primitive only. Executor selection and dispatch are phase 3. A 404
 * is capability absence, never success or permission to silently switch an
 * explicitly selected executor. The caller owns any permitted node fallback. */
export async function collectBuildContextOnSource(
  ports: BuildContextCollectionPorts,
  job: DeploymentPublishJobRow,
  interpolation: {
    buildInterpolationEnv: Record<string, string>;
    secretInterpolationKeys: string[];
  }
) {
  const [maxBytes, collectTimeoutMs, startTimeoutMs] = await Promise.all([
    ports.settings.resolveSetting('deployments.buildContextMaxBytes'),
    ports.settings.resolveSetting('deployments.buildContextCollectTimeoutMs'),
    ports.settings.resolveSetting('deployments.buildContextStartTimeoutMs'),
  ]);
  const response = await ports.source.requestCollection(
    job,
    {
      publishJobId: job.id,
      attempt: job.attempt,
      shadow: job.contextShadow,
      workingDir: job.workingDir,
      maxBytes: Number(maxBytes),
      collectTimeoutMs: Number(collectTimeoutMs),
      ...interpolation,
    },
    Number(startTimeoutMs)
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
