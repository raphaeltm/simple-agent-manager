/**
 * MCP tools `list_ai_models` and `run_ai_model` — thin adapters over the shared agent model
 * operations in `services/agent-models/` (policy 5cb362e8: one operation, thin surfaces).
 */
import type { Env } from '../../env';
import { AgentModelCallError } from '../../services/agent-models/errors';
import { listAgentModelsForAgent } from '../../services/agent-models/list';
import { type AgentModelCaller, runAgentModelForAgent } from '../../services/agent-models/run';
import {
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  mapServiceError,
  type McpTokenData,
} from './_helpers';

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
    return jsonRpcError(requestId, INVALID_PARAMS, err.message, { reason: err.code });
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
