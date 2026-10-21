import type { Env } from '../../env';
import { getWorkflowRun,startWorkflowRun } from '../../services/workflow-runs';
import {
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

export async function handleStartWorkflowRun(
  requestId: string | number | null,
  params: Record<string, unknown>,
  token: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  try {
    const result = await startWorkflowRun(env, {
      projectId: token.projectId,
      userId: token.userId,
      parentTaskId: token.taskId,
      requestKey: typeof params.requestKey === 'string' ? params.requestKey : '',
      plan: params.plan,
    });
    return jsonRpcSuccess(requestId, { content: [{ type: 'text', text: JSON.stringify(result) }] });
  } catch (error) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      error instanceof Error ? error.message : String(error)
    );
  }
}
export async function handleGetWorkflowRun(
  requestId: string | number | null,
  params: Record<string, unknown>,
  token: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  try {
    if (typeof params.runId !== 'string' || !params.runId) throw new Error('runId is required');
    const result = await getWorkflowRun(env, token.projectId, token.userId, params.runId);
    return jsonRpcSuccess(requestId, { content: [{ type: 'text', text: JSON.stringify(result) }] });
  } catch (error) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      error instanceof Error ? error.message : String(error)
    );
  }
}
