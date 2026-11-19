/**
 * MCP request_human_input — an alias of a blocking `inbox_write` ask (inbox slice D, idea
 * 01M7G03ZCQ6TM6CMEYDRKQ8ST9): one D1 `asks` row of kind `question` filed through the same
 * operation (`fileAgentAsk`), which also notifies the person. The tool call is non-blocking.
 */
import { OperationError } from '@simple-agent-manager/operations';
import type { HumanInputCategory } from '@simple-agent-manager/shared';
import {
  HUMAN_INPUT_CATEGORIES,
  MAX_HUMAN_INPUT_CONTEXT_LENGTH,
  MAX_HUMAN_INPUT_OPTION_LENGTH,
  MAX_HUMAN_INPUT_OPTIONS_COUNT,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { fileQuestionAsk } from '../../services/inbox/question-asks';
import * as notificationService from '../../services/notification';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
  sanitizeUserInput,
} from './_helpers';

export async function handleRequestHumanInput(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const context = params.context;
  if (typeof context !== 'string' || !context.trim()) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'context is required and must be a non-empty string'
    );
  }

  if (context.length > MAX_HUMAN_INPUT_CONTEXT_LENGTH) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `context exceeds maximum length of ${MAX_HUMAN_INPUT_CONTEXT_LENGTH} characters`
    );
  }

  // Sanitize context: strip null bytes, Unicode bidi overrides, and C0/C1 control chars (except \n, \t)
  const sanitizedContext = sanitizeUserInput(context.trim()).trim();
  if (!sanitizedContext) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'context is required and must be a non-empty string'
    );
  }

  // Validate category if provided
  let category: HumanInputCategory | null = null;
  if (params.category !== undefined) {
    if (
      typeof params.category !== 'string' ||
      !(HUMAN_INPUT_CATEGORIES as readonly string[]).includes(params.category)
    ) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        `category must be one of: ${HUMAN_INPUT_CATEGORIES.join(', ')}`
      );
    }
    category = params.category as HumanInputCategory;
  }

  // Validate options if provided
  let options: string[] | null = null;
  if (params.options !== undefined) {
    if (!Array.isArray(params.options)) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'options must be an array of strings');
    }
    if (params.options.some((o: unknown) => typeof o !== 'string')) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'options must contain only strings');
    }
    options = (params.options as string[])
      .slice(0, MAX_HUMAN_INPUT_OPTIONS_COUNT)
      .map((o) => sanitizeUserInput(o).trim().slice(0, MAX_HUMAN_INPUT_OPTION_LENGTH))
      // An option that is empty once cleaned cannot be picked; leave it out.
      .filter((o) => o.length > 0);
    if (options.length === 0) options = null;
  }

  // The task (user_id verified against the token below) and its chat
  const taskRow = await env.DATABASE.prepare(
    `SELECT user_id, chat_session_id FROM tasks WHERE id = ? AND project_id = ?`
  )
    .bind(tokenData.taskId, tokenData.projectId)
    .first<{
      user_id: string;
      chat_session_id: string | null;
    }>();

  if (!taskRow) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Task not found');
  }

  // Verify task ownership matches token — use tokenData.userId as authoritative target
  if (taskRow.user_id !== tokenData.userId) {
    log.error('mcp.request_human_input.user_id_mismatch', {
      cacheUserId: tokenData.userId,
      taskUserId: taskRow.user_id,
      taskId: tokenData.taskId,
    });
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Task ownership mismatch');
  }

  const sessionId =
    tokenData.chatSessionId ??
    taskRow.chat_session_id ??
    (await notificationService.getChatSessionId(env, tokenData.workspaceId));
  if (!sessionId) {
    log.error('mcp.request_human_input.chat_session_missing', {
      taskId: tokenData.taskId,
      projectId: tokenData.projectId,
      workspaceId: tokenData.workspaceId,
    });
    return jsonRpcError(
      requestId,
      INTERNAL_ERROR,
      'Human input request could not be recorded because the chat session is missing'
    );
  }

  let question: Awaited<ReturnType<typeof fileQuestionAsk>>;
  try {
    question = await fileQuestionAsk(env, {
      projectId: tokenData.projectId,
      sessionId,
      taskId: tokenData.taskId,
      workspaceId: tokenData.workspaceId,
      userId: tokenData.userId,
      context: sanitizedContext,
      category,
      options,
    });
  } catch (err) {
    log.error('mcp.request_human_input.ask_failed', {
      taskId: tokenData.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    // The per-chat cap and length limits are the inbox's; say which one the agent hit.
    if (err instanceof OperationError && ['rate_limited', 'invalid_input'].includes(err.code)) {
      return jsonRpcError(requestId, INVALID_PARAMS, err.message);
    }
    // A shape the inbox refuses: the agent can fix its call (the details stay in the log).
    if (err instanceof Error && err.name === 'ValiError') {
      return jsonRpcError(requestId, INVALID_PARAMS, 'Human input request is not valid');
    }
    return jsonRpcError(
      requestId,
      INTERNAL_ERROR,
      'Human input request could not be recorded safely'
    );
  }

  const notificationScheduled = question.notificationScheduled;

  log.info('mcp.request_human_input', {
    taskId: tokenData.taskId,
    projectId: tokenData.projectId,
    category,
    hasOptions: options !== null,
  });

  // JSON so the chat can render this call as an answerable card: the card reads the question by
  // ID through the attention route (see HumanInputCard in apps/web), never from chat text. The ID
  // is the `asks` row's; the route reads it there (`routes/chat-attention.ts`).
  const payload = {
    message: notificationScheduled
      ? 'Human input request recorded. Notification delivery has been scheduled. You may continue working or end your turn.'
      : 'Human input request recorded, but notification delivery was not scheduled. SAM will keep the task alive while waiting for delivery. You may continue working.',
    humanInputRequest: { id: question.id, sessionId },
    notificationScheduled,
  };
  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  });
}
