import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { resolveAdminSetting } from './admin-settings';
import { collectBuildContextOnSource } from './build-context-collection';
import {
  appendDeploymentPublishJobEvent,
  createDeploymentPublishJob,
  type CreateDeploymentPublishJobInput,
} from './deployment-publish-jobs';

type BackgroundContext = { waitUntil(promise: Promise<unknown>): void };
/** Only acceptance occupies waitUntil. Collection/PUT runs in the source agent
 * under its existing publish deadline and reports through normal callbacks. */
export function scheduleBuildContextShadow(
  env: Env,
  input: CreateDeploymentPublishJobInput,
  interpolation: {
    buildInterpolationEnv: Record<string, string>;
    secretInterpolationKeys: string[];
  },
  execCtx?: BackgroundContext
) {
  if (!execCtx) return;
  execCtx.waitUntil(
    startShadow(env, input, interpolation).catch(() => {
      log.warn('build_context.shadow_start_failed', {
        projectId: input.projectId,
        workspaceId: input.workspaceId,
      });
    })
  );
}
async function startShadow(
  env: Env,
  input: CreateDeploymentPublishJobInput,
  interpolation: {
    buildInterpolationEnv: Record<string, string>;
    secretInterpolationKeys: string[];
  }
) {
  if ((await resolveAdminSetting(env, 'deployments.buildContextCollectionMode')) !== 'shadow')
    return;
  const db = drizzle(env.DATABASE, { schema });
  const job = await createDeploymentPublishJob(db, {
    ...input,
    executor: 'cloudflare',
    contextShadow: true,
  });
  try {
    const result = await collectBuildContextOnSource(env, job, interpolation);
    if (result.supported) return;
    throw new Error(result.message);
  } catch {
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
