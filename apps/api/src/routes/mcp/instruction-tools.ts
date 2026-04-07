/**
 * MCP instruction tools — get_instructions and request_human_input.
 */
import type { HumanInputCategory } from '@simple-agent-manager/shared';
import { HUMAN_INPUT_CATEGORIES,MAX_HUMAN_INPUT_CONTEXT_LENGTH, MAX_HUMAN_INPUT_OPTION_LENGTH, MAX_HUMAN_INPUT_OPTIONS_COUNT } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { ProjectData } from '../../durable-objects/project-data';
import type { Env } from '../../index';
import { log } from '../../lib/logger';
import { resolveParentSessionContext } from '../../services/inbox-drain';
import * as notificationService from '../../services/notification';
import {
  ACTIVE_STATUSES,
  DEFAULT_ORCHESTRATOR_PARENT_ROUTING_ENABLED,
  getMcpLimits,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
  sanitizeUserInput,
} from './_helpers';

export async function handleGetInstructions(
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const db = drizzle(env.DATABASE, { schema });

  // Fetch task
  const taskRows = await db
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.id, tokenData.taskId),
        eq(schema.tasks.projectId, tokenData.projectId),
      ),
    )
    .limit(1);

  const task = taskRows[0];
  if (!task) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Task not found');
  }

  // Fetch project
  const projectRows = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, tokenData.projectId))
    .limit(1);

  const project = projectRows[0];
  if (!project) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Project not found');
  }

  const result = {
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      outputBranch: task.outputBranch,
    },
    project: {
      id: project.id,
      name: project.name,
      repository: project.repository,
      defaultBranch: project.defaultBranch,
    },
    instructions: task.taskMode === 'conversation'
      ? [
          'You are in a conversation with a human. Respond to their messages directly.',
          'Use `dispatch_task` to spawn follow-up work to other agents when needed.',
          'Use `update_task_status` to report significant findings or progress.',
          'Do NOT call `complete_task` — the human will end the conversation when they are ready.',
          'If you encounter blockers, report them via `update_task_status` with a clear description.',
        ]
      : [
          'Call `update_task_status` to report progress as you complete significant milestones.',
          'Call `complete_task` with a summary when all work is done.',
          'Push your changes to the output branch before calling `complete_task`.',
          'If you encounter blockers, report them via `update_task_status` with a clear description.',
        ],
  };

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  });
}

export async function handleRequestHumanInput(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const context = params.context;
  if (typeof context !== 'string' || !context.trim()) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'context is required and must be a non-empty string');
  }

  if (context.length > MAX_HUMAN_INPUT_CONTEXT_LENGTH) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `context exceeds maximum length of ${MAX_HUMAN_INPUT_CONTEXT_LENGTH} characters`,
    );
  }

  // Sanitize context: strip null bytes, Unicode bidi overrides, and C0/C1 control chars (except \n, \t)
  const sanitizedContext = sanitizeUserInput(context.trim());

  // Validate category if provided
  let category: HumanInputCategory | null = null;
  if (params.category !== undefined) {
    if (typeof params.category !== 'string' || !(HUMAN_INPUT_CATEGORIES as readonly string[]).includes(params.category)) {
      return jsonRpcError(requestId, INVALID_PARAMS, `category must be one of: ${HUMAN_INPUT_CATEGORIES.join(', ')}`);
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
    `SELECT user_id, title FROM tasks WHERE id = ? AND project_id = ?`,
  ).bind(tokenData.taskId, tokenData.projectId).first<{
    user_id: string;
    title: string;
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

  // Attempt parent routing if enabled (best-effort, before human notification)
  const parentRoutingEnabled = env.ORCHESTRATOR_PARENT_ROUTING_ENABLED !== undefined
    ? env.ORCHESTRATOR_PARENT_ROUTING_ENABLED !== 'false'
    : DEFAULT_ORCHESTRATOR_PARENT_ROUTING_ENABLED;

  let parentRouted = false;
  let parentTaskTitle: string | null = null;

  if (parentRoutingEnabled) {
    try {
      const parentRow = await env.DATABASE.prepare(
        'SELECT parent_task_id FROM tasks WHERE id = ? AND project_id = ?',
      ).bind(tokenData.taskId, tokenData.projectId).first<{ parent_task_id: string | null }>();

      if (parentRow?.parent_task_id) {
        // Check if parent task is still active and get its title
        const parentInfo = await env.DATABASE.prepare(
          'SELECT status, title FROM tasks WHERE id = ?',
        ).bind(parentRow.parent_task_id).first<{ status: string; title: string }>();

        if (parentInfo && (ACTIVE_STATUSES as readonly string[]).includes(parentInfo.status)) {
          const parentCtx = await resolveParentSessionContext(env.DATABASE, parentRow.parent_task_id);
          if (parentCtx && parentCtx.parentUserId === tokenData.userId) {
            const limits = getMcpLimits(env);
            const doId = env.PROJECT_DATA.idFromName(parentCtx.parentProjectId);
            const doStub = env.PROJECT_DATA.get(doId) as DurableObjectStub<ProjectData>;
            await doStub.enqueueInboxMessage(
              {
                targetSessionId: parentCtx.parentChatSessionId,
                sourceTaskId: tokenData.taskId,
                messageType: 'child_needs_input',
                content: sanitizeUserInput(`Sub-task '${taskRow.title}' needs your input: ${sanitizedContext}. Respond via send_message_to_subtask(taskId='${tokenData.taskId}', message='your answer')`),
                priority: 'urgent',
              },
              limits.inboxMaxSize,
              limits.inboxMessageMaxLength,
            );
            parentRouted = true;
            parentTaskTitle = parentInfo.title;
            log.info('mcp.request_human_input.parent_inbox_enqueued', {
              taskId: tokenData.taskId,
              parentTaskId: parentRow.parent_task_id,
              parentSessionId: parentCtx.parentChatSessionId,
            });
          }
        }
      }
    } catch (err) {
      log.warn('mcp.request_human_input.parent_inbox_failed', {
        taskId: tokenData.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Emit high-urgency notification to human (best-effort, always sent as fallback)
  if (env.NOTIFICATION) {
    try {
      const [projectName, sessionId] = await Promise.all([
        notificationService.getProjectName(env, tokenData.projectId),
        notificationService.getChatSessionId(env, tokenData.workspaceId),
      ]);

      // Add dual-routing note when parent was notified
      const notificationContext = parentRouted && parentTaskTitle
        ? `${sanitizedContext} (Also sent to parent agent task '${parentTaskTitle}')`
        : sanitizedContext;

      await notificationService.notifyNeedsInput(env as any, tokenData.userId, {
        projectId: tokenData.projectId,
        projectName,
        taskId: tokenData.taskId,
        taskTitle: taskRow.title,
        context: notificationContext,
        category,
        options,
        sessionId,
      });
    } catch (err) {
      log.warn('mcp.request_human_input.notification_failed', {
        taskId: tokenData.taskId,
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
    content: [{ type: 'text', text: 'Human input request sent. The user has been notified. You may continue working or end your turn.' }],
  });
}
