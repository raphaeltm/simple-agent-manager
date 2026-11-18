/**
 * MCP tools `list_ai_models` and `run_ai_model` — thin adapters over the shared agent model
 * operations in `services/agent-models/` (policy 5cb362e8: one operation, thin surfaces).
 */
import type { Env } from '../../env';
import {
  AgentModelCallError,
  type AgentModelCallErrorCode,
} from '../../services/agent-models/errors';
import { listAgentModelsForAgent } from '../../services/agent-models/list';
import { type AgentModelCaller, runAgentModelForAgent } from '../../services/agent-models/run';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  mapServiceError,
  type McpTokenData,
} from './_helpers';

/**
 * Refusals the agent can clear by retrying later. They are internal errors, so a client does not
 * read them as "fix your input"; every other code asks for different input or a person's action.
 * `reason` carries the exact code either way.
 */
const RETRYABLE_CODES: ReadonlySet<AgentModelCallErrorCode> = new Set([
  'timeout',
  'upstream_error',
  'catalog_unavailable',
]);

function callerFromToken(tokenData: McpTokenData): AgentModelCaller {
  return {
    projectId: tokenData.projectId,
    userId: tokenData.userId,
    workspaceId: tokenData.workspaceId || null,
    agentSessionId: tokenData.agentSessionId || null,
    taskId: tokenData.taskId || null,
  };
}

function toolError(
  requestId: string | number | null,
  tool: string,
  tokenData: McpTokenData,
  err: unknown
): JsonRpcResponse {
  if (err instanceof AgentModelCallError) {
    const code = RETRYABLE_CODES.has(err.code) ? INTERNAL_ERROR : INVALID_PARAMS;
    return jsonRpcError(requestId, code, err.message, { reason: err.code });
  }
  return mapServiceError(requestId, err, {
    fallbackPrefix: `${tool} failed`,
    logTag: `mcp.${tool}_failed`,
    logCtx: { projectId: tokenData.projectId, workspaceId: tokenData.workspaceId },
    clientErrorCodes: [400, 403, 404, 409],
  });
}

function textResult(requestId: string | number | null, value: unknown): JsonRpcResponse {
  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  });
}

export async function handleListAiModels(
  requestId: string | number | null,
  args: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  try {
    return textResult(
      requestId,
      await listAgentModelsForAgent(env, callerFromToken(tokenData), args)
    );
  } catch (err) {
    return toolError(requestId, 'list_ai_models', tokenData, err);
  }
}

export async function handleRunAiModel(
  requestId: string | number | null,
  args: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  try {
    return textResult(
      requestId,
      await runAgentModelForAgent(env, callerFromToken(tokenData), args)
    );
  } catch (err) {
    return toolError(requestId, 'run_ai_model', tokenData, err);
  }
}
