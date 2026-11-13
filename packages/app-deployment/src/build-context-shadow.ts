import { log, serializeError } from '@simple-agent-manager/worker-core';
import * as schema from '@simple-agent-manager/worker-core/schema';
import { drizzle } from 'drizzle-orm/d1';

import { collectBuildContextOnSource } from './build-context-collection';
import {
  appendDeploymentPublishJobEvent,
  createDeploymentPublishJob,
  type CreateDeploymentPublishJobInput,
} from './deployment-publish-jobs';
import type { AppDeploymentEnv as Env } from './env';
import type { BuildContextCollectionPorts } from './ports';

type BackgroundContext = { waitUntil(promise: Promise<unknown>): void };
/** Only acceptance occupies waitUntil. Collection/PUT runs in the source agent
 * under its existing publish deadline and reports through normal callbacks. */
export function scheduleBuildContextShadow(
  env: Pick<Env, 'DATABASE'>,
  ports: BuildContextCollectionPorts,
  input: CreateDeploymentPublishJobInput,
  interpolation: {
    buildInterpolationEnv: Record<string, string>;
    secretInterpolationKeys: string[];
  },
  execCtx?: BackgroundContext
) {
  if (!execCtx) return;
  execCtx.waitUntil(
    startShadow(env, ports, input, interpolation).catch((error) => {
      log.warn('build_context.shadow_start_failed', {
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        ...serializeError(error),
      });
    })
  );
}
async function startShadow(
  env: Pick<Env, 'DATABASE'>,
  ports: BuildContextCollectionPorts,
  input: CreateDeploymentPublishJobInput,
  interpolation: {
    buildInterpolationEnv: Record<string, string>;
    secretInterpolationKeys: string[];
  }
) {
  if ((await ports.settings.resolveSetting('deployments.buildContextCollectionMode')) !== 'shadow')
    return;
  const db = drizzle(env.DATABASE, { schema });
  const job = await createDeploymentPublishJob(db, {
    ...input,
    executor: 'cloudflare',
    contextShadow: true,
  });
  try {
    const result = await collectBuildContextOnSource(ports, job, interpolation);
    if (result.supported) return;
    throw new Error(result.message);
  } catch (error) {
    log.warn('build_context.shadow_collect_failed', {
      publishJobId: job.id,
      projectId: job.projectId,
      workspaceId: job.workspaceId,
      ...serializeError(error),
    });
    // A missing route or failed acceptance never affects the real publish. The
    // conditional terminal event also fences late callbacks from a lost response.
    await appendDeploymentPublishJobEvent(db, {
      publishJobId: job.id,
      projectId: job.projectId,
      environmentId: job.environmentId,
      nodeId: job.nodeId,
      workspaceId: job.workspaceId,
      status: 'failed',
      currentStep: 'context_failed',
      eventType: 'publish.context.shadow_failed',
      message: 'Shadow context collection was unavailable; normal publishing continues.',
      errorCode: 'context_shadow_unavailable',
      terminal: true,
    });
  }
}
