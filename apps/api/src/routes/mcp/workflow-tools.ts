import * as v from 'valibot';

import type { Env } from '../../env';
import { getWorkflowRun, startWorkflowRun, WorkflowInputError } from '../../services/workflow-runs';
import {
  INTERNAL_ERROR,
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
    const isInput = error instanceof v.ValiError || error instanceof WorkflowInputError;
    const message = error instanceof Error ? error.message : String(error);
    return jsonRpcError(
      requestId,
      isInput ? INVALID_PARAMS : INTERNAL_ERROR,
      isInput ? message : `${message}. Retry with the same requestKey.`
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
    if (typeof params.runId !== 'string' || !params.runId)
      throw new WorkflowInputError('runId is required');
    const result = await getWorkflowRun(env, token.projectId, token.userId, params.runId);
    return jsonRpcSuccess(requestId, { content: [{ type: 'text', text: JSON.stringify(result) }] });
  } catch (error) {
    const isInput = error instanceof WorkflowInputError;
    return jsonRpcError(
      requestId,
      isInput ? INVALID_PARAMS : INTERNAL_ERROR,
      error instanceof Error ? error.message : String(error)
    );
  }
}
