/** MCP adapter for agent email replies. The operation lives in services/agent-email/reply. */
import type { Env } from '../../env';
import { AgentEmailReplyError, replyToTriggerEmail } from '../../services/agent-email/reply';
import { activeAgentEmailSender } from '../../services/agent-email/setup-state';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

export async function handleReplyToEmail(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  if (!tokenData.taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'reply_to_email requires a task-scoped token');
  }
  if (typeof params.body !== 'string') {
    return jsonRpcError(requestId, INVALID_PARAMS, 'body is required and must be a string');
  }
  try {
    const result = await replyToTriggerEmail(
      env,
      { projectId: tokenData.projectId, taskId: tokenData.taskId, body: params.body },
      await activeAgentEmailSender(env)
    );
    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify({ sent: true, ...result }, null, 2) }],
    });
  } catch (error) {
    if (error instanceof AgentEmailReplyError) {
      const code = error.code === 'send_failed' ? INTERNAL_ERROR : INVALID_PARAMS;
      return jsonRpcError(requestId, code, error.message);
    }
    throw error;
  }
}
