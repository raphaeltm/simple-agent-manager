/**
 * sam-mcp `project_insights` (Insights slice I): validates with the catalog operation's own schema
 * (`sam_project_insights`, packages/operations/src/insights-agent.ts), spends one call of the
 * chat's budget, then runs the shared operation with the token's project.
 *
 * Identity: the project always comes from the MCP token. A `projectId` argument that differs is
 * refused before any read, and `authorizeProjectOperation` refuses it again (rule 51).
 *
 * Rate limit: per chat session (the token's chat, else its agent session, else its workspace),
 * `insights.agentToolCallsPerWindow` calls per `insights.agentToolWindowSeconds` (admin runtime
 * settings). The counter is the `McpRateCounter` Durable Object, which admits or refuses inside one
 * storage transaction, so parallel calls cannot overspend it. One RPC per call.
 */
import {
  getInsightsAgentRateLimit,
  OperationError,
  ProjectInsightsInputSchema,
  projectInsights,
} from '@simple-agent-manager/operations';
import * as v from 'valibot';

import type { McpRateCounter, McpRateResult } from '../../durable-objects/mcp-rate-counter';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';
import {
  operationErrorToWorkspaceJsonRpc,
  projectMismatch,
  workspaceOperationContext,
} from './workspace-operation-adapter';

/** JSON-RPC server error code the /mcp HTTP limiter also uses for "rate limited". */
const RATE_LIMITED = -32000;

/** The session a call is charged to. Never empty: every token has a workspace. */
export function projectInsightsRateKey(token: McpTokenData): string {
  if (token.chatSessionId) return `project_insights:chat:${token.chatSessionId}`;
  if (token.agentSessionId) return `project_insights:agent:${token.agentSessionId}`;
  return `project_insights:workspace:${token.workspaceId}`;
}

/** Spend one call of `key`'s budget for the window containing `nowMs`. */
export async function consumeProjectInsightsBudget(
  env: Env,
  key: string,
  limit: { callsPerWindow: number; windowSeconds: number },
  nowMs = Date.now()
): Promise<McpRateResult> {
  if (!env.MCP_RATE_COUNTER) throw new Error('MCP_RATE_COUNTER binding is required');
  const now = Math.floor(nowMs / 1000);
  const windowStart = Math.floor(now / limit.windowSeconds) * limit.windowSeconds;
  const stub = env.MCP_RATE_COUNTER.get(
    env.MCP_RATE_COUNTER.idFromName(key)
  ) as DurableObjectStub<McpRateCounter>;
  return stub.consume(windowStart, windowStart + limit.windowSeconds, limit.callsPerWindow);
}

export async function handleProjectInsights(
  requestId: string | number | null,
  params: Record<string, unknown>,
  token: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const mismatch = projectMismatch(requestId, params, token);
  if (mismatch) {
    log.warn('mcp.project_insights.project_mismatch', {
      tokenProjectId: token.projectId,
      requestedProjectId: typeof params.projectId === 'string' ? params.projectId : null,
      taskId: token.taskId,
      workspaceId: token.workspaceId,
      action: 'rejected',
    });
    return mismatch;
  }
  const parsed = v.safeParse(ProjectInsightsInputSchema, {
    ...params,
    projectId: token.projectId,
  });
  if (!parsed.success) {
    const issue = parsed.issues[0];
    const path = issue?.path?.map((item) => String(item.key)).join('.') ?? 'input';
    return jsonRpcError(requestId, INVALID_PARAMS, `Invalid ${path}`);
  }

  const ctx = workspaceOperationContext(requestId, token, env);
  let admission: McpRateResult;
  try {
    const limit = await getInsightsAgentRateLimit(ctx);
    admission = await consumeProjectInsightsBudget(env, projectInsightsRateKey(token), limit);
  } catch (error) {
    // Fail closed: an unreadable counter must not turn into unlimited reads.
    log.error('mcp.project_insights.rate_limit_unavailable', {
      projectId: token.projectId,
      workspaceId: token.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonRpcError(requestId, INTERNAL_ERROR, 'project_insights is temporarily unavailable');
  }
  if (!admission.allowed) {
    return jsonRpcError(
      requestId,
      RATE_LIMITED,
      `project_insights rate limit reached for this chat; retry after ${admission.retryAfter}s (${new Date(admission.resetAt * 1000).toISOString()}).`
    );
  }

  try {
    const result = await projectInsights(ctx, parsed.output);
    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    });
  } catch (error) {
    if (error instanceof OperationError) return operationErrorToWorkspaceJsonRpc(requestId, error);
    throw error;
  }
}
