/**
 * MCP request_human_input — records a user decision request as a durable
 * attention marker and notifies the user. The tool call itself is non-blocking.
 */
import type { HumanInputCategory } from '@simple-agent-manager/shared';
import {
  HUMAN_INPUT_CATEGORIES,
  MAX_HUMAN_INPUT_CONTEXT_LENGTH,
  MAX_HUMAN_INPUT_OPTION_LENGTH,
  MAX_HUMAN_INPUT_OPTIONS_COUNT,
} from '@simple-agent-manager/shared';

import { computeHumanInputSchedule } from '../../durable-objects/project-data/attention';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import * as notificationService from '../../services/notification';
import * as projectDataService from '../../services/project-data';
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
  const sanitizedContext = sanitizeUserInput(context.trim());

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
      .map((o) => sanitizeUserInput(o).slice(0, MAX_HUMAN_INPUT_OPTION_LENGTH));
    if (options.length === 0) options = null;
  }

  // Fetch task title (user_id verified against token below)
  const taskRow = await env.DATABASE.prepare(
    `SELECT user_id, title, chat_session_id FROM tasks WHERE id = ? AND project_id = ?`
  )
    .bind(tokenData.taskId, tokenData.projectId)
    .first<{
      user_id: string;
      title: string;
      chat_session_id: string | null;
    }>();

  if (!taskRow) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Task not found');
  }

  // Verify task ownership matches token — use tokenData.userId as authoritative target
  if (taskRow.user_id !== tokenData.userId) {
    log.error('mcp.request_human_input.user_id_mismatch', {
      tokenUserId: tokenData.userId,
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

  const schedule = computeHumanInputSchedule(env);
  let marker: Awaited<ReturnType<typeof projectDataService.createAttentionMarker>>;
  try {
    marker = await projectDataService.createAttentionMarker(env, tokenData.projectId, {
      sessionId,
      taskId: tokenData.taskId,
      workspaceId: tokenData.workspaceId,
      kind: 'needs_input',
      source: 'request_human_input',
      notificationUserId: tokenData.userId,
      reason: sanitizedContext,
      metadata: category || options ? JSON.stringify({ category, options }) : null,
      ...schedule,
    });
  } catch (err) {
    log.error('mcp.request_human_input.attention_marker_failed', {
      taskId: tokenData.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonRpcError(
      requestId,
      INTERNAL_ERROR,
      'Human input request could not be recorded safely'
    );
  }

  let notificationScheduled = false;
  if (env.NOTIFICATION) {
    try {
      const projectName = await notificationService.getProjectName(env, tokenData.projectId);
      const notification = await notificationService.notifyNeedsInput(env, tokenData.userId, {
        projectId: tokenData.projectId,
        projectName,
        taskId: tokenData.taskId,
        taskTitle: taskRow.title,
        context: sanitizedContext,
        category,
        options,
        sessionId,
        attentionMarkerId: marker.id,
      });
      notificationScheduled = notification.id !== 'suppressed';
      if (notificationScheduled) {
        await projectDataService.linkAttentionNotification(
          env,
          tokenData.projectId,
          marker.id,
          tokenData.userId,
          notification.id
        );
      }
    } catch (err) {
      log.warn('mcp.request_human_input.notification_failed', {
        taskId: tokenData.taskId,
        markerId: marker.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('mcp.request_human_input', {
    taskId: tokenData.taskId,
    projectId: tokenData.projectId,
    category,
    hasOptions: options !== null,
  });

  return jsonRpcSuccess(requestId, {
    content: [
      {
        type: 'text',
        text: notificationScheduled
          ? 'Human input request recorded. Notification delivery has been scheduled. You may continue working or end your turn.'
          : 'Human input request recorded, but notification delivery was not scheduled. SAM will keep the task alive while waiting for delivery. You may continue working.',
      },
    ],
  });
}
