/**
 * MCP tool handler: build_and_publish
 *
 * Builds the project's Docker Compose stack on the agent-node HOST docker daemon
 * (from the workspace's cloned repo), re-pushes the built service images into the
 * project-scoped registry namespace using short-lived control-plane credentials,
 * and records a deployment release — all server-side. The coding agent runs ZERO
 * docker or registry commands and never receives a credential: this handler
 * proxies a single request to the vm-agent, which owns the entire build → push →
 * release flow.
 *
 * Gated behind the same phase-D project-level agent-deploy policy as the rest of
 * the publish path.
 */
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { parsePositiveInt } from '../../lib/route-helpers';
import { isProjectAgentDeployEnabled } from '../../services/deployment-control';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';
import { proxyToVmAgent, requireWorkspace } from './workspace-tools';

/**
 * Host build + registry push + release submission is slow (image build + push).
 * This bounds the worker→vm-agent proxy wait; the vm-agent applies its own
 * 20-minute internal cap. Override via BUILD_PUBLISH_TOOL_TIMEOUT_MS.
 */
const DEFAULT_BUILD_PUBLISH_TIMEOUT_MS = 21 * 60 * 1000;
function getBuildPublishTimeout(env: Env): number {
  return parsePositiveInt(env.BUILD_PUBLISH_TOOL_TIMEOUT_MS, DEFAULT_BUILD_PUBLISH_TIMEOUT_MS);
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
  env: Env,
): Promise<JsonRpcResponse> {
  const workspaceErr = requireWorkspace(requestId, tokenData);
  if (workspaceErr) return workspaceErr;

  const { projectId } = tokenData;
  const db = drizzle(env.DATABASE, { schema });

  const deployEnabled = await isProjectAgentDeployEnabled(db, projectId);
  if (!deployEnabled) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Agent deployment is disabled for this project. Ask the project owner to enable agent deployment on a deployment environment before publishing.',
    );
  }

  const reference =
    typeof toolArgs.reference === 'string' && toolArgs.reference.trim() !== ''
      ? toolArgs.reference.trim()
      : undefined;

  try {
    const result = await proxyToVmAgent(
      env,
      tokenData.workspaceId,
      tokenData.userId,
      projectId,
      'build-and-publish',
      'POST',
      reference ? { reference } : {},
      getBuildPublishTimeout(env),
    );

    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    });
  } catch (e) {
    return jsonRpcError(
      requestId,
      INTERNAL_ERROR,
      `Build and publish failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
