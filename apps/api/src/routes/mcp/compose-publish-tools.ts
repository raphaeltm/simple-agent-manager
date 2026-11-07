import { eq } from 'drizzle-orm';
/**
 * MCP tool handler: build_and_publish
 *
 * Starts an async build/publish job on the workspace VM and returns a durable
 * publish job id. Agents poll get_publish_status for progress and terminal
 * release/error details.
 *
 * Gated behind the same phase-D environment-scoped agent-deploy policy as the
 * registry credential path.
 */
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { parsePositiveInt } from '../../lib/route-helpers';
import { assertAgentDeploymentAllowed } from '../../services/deployment-control';
import { loadDeploymentBuildInterpolationEnv } from '../../services/deployment-environment-config';
import { getDeploymentPublishJobSettings } from '../../services/deployment-publish-job-settings';
import {
  appendDeploymentPublishJobEvent,
  cancelDeploymentPublishJob,
  createDeploymentPublishJob,
  getDeploymentPublishJobForMcp,
  sanitizePublishEventText,
} from '../../services/deployment-publish-jobs';
import { recordDeploymentPublishJobLifecycleEventBestEffort } from '../../services/project-lifecycle-events';
import {
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
  sanitizeUserInput,
} from './_helpers';
import {
  cancelBuildPublishJobOnVm,
  lookupWorkspaceForVmAgent,
  requireWorkspace,
  startBuildPublishJobOnVm,
} from './workspace-tools';

/**
 * Only bounds the worker→vm-agent job acceptance request. The actual build runs
 * in a VM-owned background context and reports progress through callbacks.
 */
const DEFAULT_BUILD_PUBLISH_START_TIMEOUT_MS = 30_000;
function getBuildPublishStartTimeout(env: Env): number {
  return parsePositiveInt(
    env.BUILD_PUBLISH_START_TIMEOUT_MS,
    DEFAULT_BUILD_PUBLISH_START_TIMEOUT_MS
  );
}

/**
 * Handle the build_and_publish MCP tool call.
 *
 * No rate limiting here: the downstream credential mint + release ingestion the
 * vm-agent triggers are themselves rate-limited at their own endpoints.
 */
export async function handleBuildAndPublish(
  requestId: string | number | null,
  toolArgs: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const workspaceErr = requireWorkspace(requestId, tokenData);
  if (workspaceErr) return workspaceErr;

  const { projectId } = tokenData;
  const db = drizzle(env.DATABASE, { schema });

  const rawEnvironment =
    typeof toolArgs.environment === 'string' ? toolArgs.environment.trim() : undefined;
  const environment = rawEnvironment ? sanitizeUserInput(rawEnvironment).slice(0, 200) : undefined;
  if (!environment) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'A deployment environment name is required before build_and_publish can record a release.'
    );
  }

  const policyResult = await assertAgentDeploymentAllowed(db, projectId, environment, tokenData);
  if ('error' in policyResult) {
    return jsonRpcError(requestId, INVALID_PARAMS, policyResult.error);
  }
  const buildEnv = await loadDeploymentBuildInterpolationEnv(db, policyResult.environmentId);

  const reference =
    typeof toolArgs.reference === 'string' && toolArgs.reference.trim() !== ''
      ? sanitizeUserInput(toolArgs.reference.trim()).slice(0, 200)
      : 'latest';

  // Optional: the agent's current working directory (e.g. a git worktree under
  // /workspaces). When set, the vm-agent builds the source at this directory
  // instead of the workspace's primary repo. The vm-agent validates it is a path
  // under /workspaces and ignores anything that isn't.
  const workingDir =
    typeof toolArgs.workingDir === 'string' && toolArgs.workingDir.trim() !== ''
      ? toolArgs.workingDir.trim()
      : undefined;

  const workspace = await lookupWorkspaceForVmAgent(env, tokenData.workspaceId, projectId);
  const [node] = await db
    .select({ runtime: schema.nodes.runtime })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, workspace.nodeId))
    .limit(1);
  // Temporary until phase 3 of idea 01KZ6V37D1QGDR3WN12PSDB0QD adds the Cloudflare builder.
  if (node?.runtime === 'cf-container') {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      "Deploying from Instant sessions isn't available yet; use a VM session."
    );
  }
  const job = await createDeploymentPublishJob(db, {
    projectId,
    environmentId: policyResult.environmentId,
    workspaceId: tokenData.workspaceId,
    nodeId: workspace.nodeId,
    taskId: tokenData.taskId || null,
    agentProfileId: policyResult.taskAgentProfileId || null,
    requestedBy: tokenData.userId,
    environmentName: environment,
    reference,
    workingDir: workingDir ?? null,
  });
  await appendDeploymentPublishJobEvent(db, {
    publishJobId: job.id,
    projectId,
    environmentId: policyResult.environmentId,
    nodeId: workspace.nodeId,
    workspaceId: tokenData.workspaceId,
    status: 'queued',
    currentStep: 'queued',
    eventType: 'publish.job.created',
    message: 'publish job created',
  });
  await recordDeploymentPublishJobLifecycleEventBestEffort(env, {
    projectId,
    publishJobId: job.id,
    environmentId: policyResult.environmentId,
    status: 'queued',
    fromStatus: null,
    currentStep: 'queued',
    nodeId: workspace.nodeId,
    workspaceId: tokenData.workspaceId,
    taskId: tokenData.taskId || null,
    source: 'mcp.build_and_publish.create_job',
    occurredAt: job.createdAt,
  });

  const proxyBody: Record<string, unknown> = {
    publishJobId: job.id,
    attempt: job.attempt,
    environment,
    environmentId: policyResult.environmentId,
    submittedBy: {
      userId: tokenData.userId,
      workspaceId: tokenData.workspaceId,
      taskId: tokenData.taskId || undefined,
      agentProfileId: policyResult.taskAgentProfileId || undefined,
    },
    buildInterpolationEnv: buildEnv.values,
    secretInterpolationKeys: buildEnv.secretKeys,
  };
  if (reference) proxyBody.reference = reference;
  if (workingDir) proxyBody.workingDir = workingDir;

  try {
    await startBuildPublishJobOnVm(
      env,
      tokenData.workspaceId,
      tokenData.userId,
      projectId,
      workspace.nodeId,
      job.id,
      proxyBody,
      getBuildPublishStartTimeout(env)
    );
    const changed = await appendDeploymentPublishJobEvent(db, {
      publishJobId: job.id,
      projectId,
      environmentId: policyResult.environmentId,
      nodeId: workspace.nodeId,
      workspaceId: tokenData.workspaceId,
      status: 'starting',
      expectedStatus: 'queued',
      currentStep: 'accepted',
      eventType: 'publish.job.accepted',
      message: 'vm agent accepted the publish job',
    });
    if (changed)
      await recordDeploymentPublishJobLifecycleEventBestEffort(env, {
        projectId,
        publishJobId: job.id,
        environmentId: job.environmentId,
        status: 'starting',
        fromStatus: 'queued',
        currentStep: 'accepted',
        nodeId: job.nodeId,
        workspaceId: job.workspaceId,
        taskId: job.taskId,
        source: 'mcp.build_and_publish.accepted',
        occurredAt: Date.now(),
      });

    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              publishJobId: job.id,
              status: 'starting',
              environment,
              environmentId: policyResult.environmentId,
              reference,
              pollTool: 'get_publish_status',
              pollAfterSeconds: 10,
              instructions:
                'Call get_publish_status with publishJobId until status is succeeded, failed, canceled, or unknown. Do not retry blindly while this job is still active.',
            },
            null,
            2
          ),
        },
      ],
    });
  } catch (e) {
    const message = sanitizePublishEventText(e instanceof Error ? e.message : String(e));
    const changed = await appendDeploymentPublishJobEvent(db, {
      publishJobId: job.id,
      projectId,
      environmentId: policyResult.environmentId,
      nodeId: workspace.nodeId,
      workspaceId: tokenData.workspaceId,
      status: 'failed',
      currentStep: 'start',
      level: 'error',
      eventType: 'publish.job.start_failed',
      message,
      errorMessage: message,
      errorCode: 'failed_to_start',
      terminal: true,
      retryable: true,
    });
    if (changed)
      await recordDeploymentPublishJobLifecycleEventBestEffort(env, {
        projectId,
        publishJobId: job.id,
        environmentId: job.environmentId,
        status: 'failed',
        fromStatus: 'queued',
        currentStep: 'start',
        terminal: true,
        nodeId: job.nodeId,
        workspaceId: job.workspaceId,
        taskId: job.taskId,
        source: 'mcp.build_and_publish.failed_to_start',
        occurredAt: Date.now(),
      });
    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              publishJobId: job.id,
              status: 'failed',
              errorCode: 'failed_to_start',
              errorMessage: message,
              pollTool: 'get_publish_status',
              instructions:
                'The publish job failed before VM acceptance. Inspect get_publish_status before retrying.',
            },
            null,
            2
          ),
        },
      ],
    });
  }
}

export async function handleGetPublishStatus(
  requestId: string | number | null,
  toolArgs: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const { projectId } = tokenData;
  const publishJobId =
    typeof toolArgs.publishJobId === 'string' ? toolArgs.publishJobId.trim() : '';
  if (!publishJobId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'publishJobId is required.');
  }
  const sinceSeq =
    typeof toolArgs.sinceSeq === 'number' && Number.isFinite(toolArgs.sinceSeq)
      ? Math.max(0, Math.trunc(toolArgs.sinceSeq))
      : undefined;
  const limit =
    typeof toolArgs.limit === 'number' && Number.isFinite(toolArgs.limit)
      ? Math.max(1, Math.min(100, Math.trunc(toolArgs.limit)))
      : undefined;
  const db = drizzle(env.DATABASE, { schema });
  const status = await getDeploymentPublishJobForMcp(db, projectId, publishJobId, {
    workspaceId: tokenData.workspaceId,
    sinceSeq,
    limit,
  });
  if (!status) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Publish job not found for this workspace.');
  }
  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
  });
}

export async function handleCancelPublish(
  requestId: string | number | null,
  toolArgs: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const publishJobId =
    typeof toolArgs.publishJobId === 'string' ? toolArgs.publishJobId.trim() : '';
  if (!publishJobId) return jsonRpcError(requestId, INVALID_PARAMS, 'publishJobId is required.');
  const db = drizzle(env.DATABASE, { schema });
  const job = await cancelDeploymentPublishJob(
    db,
    tokenData.projectId,
    tokenData.workspaceId,
    publishJobId
  );
  if (job) {
    await recordDeploymentPublishJobLifecycleEventBestEffort(env, {
      projectId: job.projectId,
      publishJobId: job.id,
      environmentId: job.environmentId,
      status: 'canceled',
      terminal: true,
      currentStep: job.currentStep,
      nodeId: job.nodeId,
      workspaceId: job.workspaceId,
      taskId: job.taskId,
      source: 'mcp.cancel_publish',
      occurredAt: job.completedAt ?? job.updatedAt,
    });
    try {
      const settings = await getDeploymentPublishJobSettings(env);
      await cancelBuildPublishJobOnVm(
        env,
        job.workspaceId,
        tokenData.userId,
        job.nodeId,
        job.id,
        settings.cancelTimeoutMs
      );
    } catch {
      // Old agents return 404. Durable cancellation and release fencing remain authoritative.
    }
  }
  return handleGetPublishStatus(requestId, { publishJobId }, tokenData, env);
}
