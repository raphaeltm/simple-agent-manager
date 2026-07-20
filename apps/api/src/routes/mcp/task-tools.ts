/**
 * MCP task tools — update_task_status, complete_task,
 * list_tasks, get_task_details, search_tasks.
 *
 * dispatch_task lives in dispatch-tool.ts due to its size.
 */
import {
  DEFAULT_NOTIFICATION_FULL_BODY_LENGTH,
  MAX_NOTIFICATION_BODY_LENGTH,
  parseCompletionEvidenceJson,
  validateCompletionEvidence,
} from '@simple-agent-manager/shared';
import type { SQL } from 'drizzle-orm';
import { and, desc, eq, like, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import * as notificationService from '../../services/notification';
import * as projectDataService from '../../services/project-data';
import * as orchestratorService from '../../services/project-orchestrator';
import { recomputeMissionSchedulerStates } from '../../services/scheduler-state-sync';
import { cleanupTerminalTaskResources } from '../../services/task-terminal-cleanup';
import { syncTriggerExecutionStatus } from '../../services/trigger-execution-sync';
import {
  ACTIVE_STATUSES,
  getMcpLimits,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

type TaskSearchRow = {
  id: string;
  title: string;
  status: string;
  priority: number;
  description: string | null;
  outputBranch: string | null;
  outputPrUrl: string | null;
  outputSummary: string | null;
  updatedAt: string;
};

function truncateSnippet(value: string | null, maxLength: number): string | null {
  if (!value) return null;
  return value.slice(0, maxLength) + (value.length > maxLength ? '...' : '');
}

function toTaskSearchResult(task: TaskSearchRow, snippetLength: number) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    descriptionSnippet: truncateSnippet(task.description, snippetLength),
    outputBranch: task.outputBranch,
    outputPrUrl: task.outputPrUrl,
    outputSummary: truncateSnippet(task.outputSummary, snippetLength),
    updatedAt: task.updatedAt,
  };
}

export async function handleUpdateTaskStatus(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const message = params.message;
  if (typeof message !== 'string' || !message.trim()) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'message is required and must be a non-empty string'
    );
  }

  const db = drizzle(env.DATABASE, { schema });
  const trimmedMessage = message.trim();

  if (!tokenData.taskId || tokenData.contextType === 'conversation' || tokenData.contextType === 'direct-workspace' || tokenData.contextType === 'trial') {
    try {
      await projectDataService.recordActivityEvent(
        env,
        tokenData.projectId,
        `${tokenData.contextType ?? 'session'}.progress`,
        'agent',
        tokenData.agentSessionId ?? tokenData.workspaceId,
        tokenData.workspaceId,
        tokenData.chatSessionId ?? null,
        null,
        {
          message: trimmedMessage.slice(0, getMcpLimits(env).activityMessageMaxLength),
          contextType: tokenData.contextType ?? 'conversation',
        }
      );
    } catch (err) {
      log.warn('mcp.update_task_status.taskless_activity_event_failed', {
        projectId: tokenData.projectId,
        workspaceId: tokenData.workspaceId,
        chatSessionId: tokenData.chatSessionId,
        contextType: tokenData.contextType,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    log.info('mcp.update_task_status.taskless', {
      projectId: tokenData.projectId,
      workspaceId: tokenData.workspaceId,
      chatSessionId: tokenData.chatSessionId,
      contextType: tokenData.contextType,
      message: trimmedMessage.slice(0, getMcpLimits(env).logMessageMaxLength),
    });

    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: 'Progress update recorded.' }],
    });
  }

  // Verify task exists, belongs to this project, and is in an active state
  const taskRows = await db
    .select({
      id: schema.tasks.id,
      status: schema.tasks.status,
      userId: schema.tasks.userId,
      title: schema.tasks.title,
    })
    .from(schema.tasks)
    .where(
      and(eq(schema.tasks.id, tokenData.taskId), eq(schema.tasks.projectId, tokenData.projectId))
    )
    .limit(1);

  const task = taskRows[0];
  if (!task) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Task not found');
  }

  // Reject updates on tasks in terminal states
  if (!ACTIVE_STATUSES.includes(task.status)) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Task status updates cannot be made after task reaches status '${task.status}'`
    );
  }

  // Record the progress update as an activity event via ProjectData DO
  try {
    const doId = env.PROJECT_DATA.idFromName(tokenData.projectId);
    const doStub = env.PROJECT_DATA.get(doId);
    await doStub.fetch(
      new Request('https://do/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'task.progress',
          actorType: 'agent',
          actorId: tokenData.workspaceId,
          metadata: {
            taskId: tokenData.taskId,
            message: trimmedMessage.slice(0, getMcpLimits(env).activityMessageMaxLength),
          },
        }),
      })
    );
  } catch (err) {
    log.warn('mcp.update_task_status.activity_event_failed', {
      taskId: tokenData.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Emit progress notification (best-effort) — use tokenData.userId as authoritative target
  if (env.NOTIFICATION && tokenData.userId) {
    try {
      const [projectName, sessionId] = await Promise.all([
        notificationService.getProjectName(env, tokenData.projectId),
        notificationService.getChatSessionId(env, tokenData.workspaceId),
      ]);
      const maxFullBodyLength =
        Number.parseInt(env.NOTIFICATION_FULL_BODY_LENGTH || '', 10) ||
        DEFAULT_NOTIFICATION_FULL_BODY_LENGTH;
      await notificationService.notifyProgress(env, tokenData.userId, {
        projectId: tokenData.projectId,
        projectName,
        taskId: tokenData.taskId,
        taskTitle: task.title,
        message: trimmedMessage.slice(0, MAX_NOTIFICATION_BODY_LENGTH),
        fullMessage:
          trimmedMessage.length > MAX_NOTIFICATION_BODY_LENGTH
            ? trimmedMessage.slice(0, maxFullBodyLength)
            : undefined,
        sessionId,
      });
    } catch (err) {
      log.warn('mcp.update_task_status.notification_failed', {
        taskId: tokenData.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('mcp.update_task_status', {
    taskId: tokenData.taskId,
    projectId: tokenData.projectId,
    message: trimmedMessage.slice(0, getMcpLimits(env).logMessageMaxLength),
  });

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: 'Progress update recorded.' }],
  });
}

export async function handleCompleteTask(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
  _executionCtx?: { waitUntil(p: Promise<unknown>): void }
): Promise<JsonRpcResponse> {
  const summary = typeof params.summary === 'string' ? params.summary.trim() : null;
  const evidenceValidation =
    params.evidence === undefined ? null : validateCompletionEvidence(params.evidence);
  if (evidenceValidation && !evidenceValidation.ok) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Invalid evidence: ${evidenceValidation.error}`,
      { httpStatus: 400 }
    );
  }
  const evidenceJson = evidenceValidation?.ok ? JSON.stringify(evidenceValidation.value) : null;

  const now = new Date().toISOString();

  // Check task mode — in conversation mode, complete_task silently remaps to awaiting_followup
  // instead of completing the task. This prevents agents that ignore conversation-mode instructions
  // from prematurely ending the conversation.
  const taskRow = await env.DATABASE.prepare(
    `SELECT task_mode, user_id, title, output_pr_url, output_branch, mission_id FROM tasks WHERE id = ? AND project_id = ?`
  )
    .bind(tokenData.taskId, tokenData.projectId)
    .first<{
      task_mode: string;
      user_id: string;
      title: string;
      output_pr_url: string | null;
      output_branch: string | null;
      mission_id: string | null;
    }>();

  const isConversation = taskRow?.task_mode === 'conversation';

  if (isConversation) {
    // In conversation mode, remap complete_task to awaiting_followup — keep the task active.
    const result = await env.DATABASE.prepare(
      `UPDATE tasks
       SET execution_step = 'awaiting_followup',
           output_summary = COALESCE(?, output_summary),
           completion_evidence = COALESCE(?, completion_evidence),
           updated_at = ?
       WHERE id = ? AND project_id = ? AND status IN ('in_progress', 'delegated', 'awaiting_followup')`
    )
      .bind(
        summary ? summary.slice(0, getMcpLimits(env).outputSummaryMaxLength) : null,
        evidenceJson,
        now,
        tokenData.taskId,
        tokenData.projectId
      )
      .run();

    if (!result.meta.changes || result.meta.changes === 0) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        'Task cannot be updated — it may not exist or is not in an active status'
      );
    }

    log.info('mcp.complete_task.conversation_remapped', {
      taskId: tokenData.taskId,
      projectId: tokenData.projectId,
      summary: summary?.slice(0, getMcpLimits(env).logMessageMaxLength) ?? null,
    });

    // Fire activity event so the remap is visible in activity feeds
    try {
      const doId = env.PROJECT_DATA.idFromName(tokenData.projectId);
      const doStub = env.PROJECT_DATA.get(doId);
      await doStub.fetch(
        new Request('https://do/activity', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'task.awaiting_followup',
            actorType: 'agent',
            actorId: tokenData.workspaceId,
            metadata: {
              taskId: tokenData.taskId,
              summary: summary?.slice(0, getMcpLimits(env).activityMessageMaxLength) ?? null,
            },
          }),
        })
      );
    } catch (err) {
      log.warn('mcp.complete_task.conversation_activity_event_failed', {
        taskId: tokenData.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Emit session_ended notification for conversation-mode remap (agent finished turn)
    // Use tokenData.userId as authoritative target
    if (env.NOTIFICATION && tokenData.userId) {
      try {
        const [projectName, sessionId] = await Promise.all([
          notificationService.getProjectName(env, tokenData.projectId),
          notificationService.getChatSessionId(env, tokenData.workspaceId),
        ]);
        await notificationService.notifySessionEnded(env, tokenData.userId, {
          projectId: tokenData.projectId,
          projectName,
          sessionId,
          taskId: tokenData.taskId,
          taskTitle: taskRow.title,
        });
      } catch (err) {
        log.warn('mcp.complete_task.conversation_notification_failed', {
          taskId: tokenData.taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: 'Acknowledged. Conversation remains open for follow-up.' }],
    });
  }

  // Task mode: standard completion
  // Atomic conditional UPDATE — only transitions from completable statuses.
  // This prevents the TOCTOU race of a separate SELECT + UPDATE.
  const result = await env.DATABASE.prepare(
    `UPDATE tasks
     SET status = 'completed',
         completed_at = ?,
         output_summary = COALESCE(?, output_summary),
         completion_evidence = COALESCE(?, completion_evidence),
         updated_at = ?
     WHERE id = ? AND project_id = ? AND status IN ('in_progress', 'delegated', 'awaiting_followup')`
  )
    .bind(
      now,
      summary ? summary.slice(0, getMcpLimits(env).outputSummaryMaxLength) : null,
      evidenceJson,
      now,
      tokenData.taskId,
      tokenData.projectId
    )
    .run();

  if (!result.meta.changes || result.meta.changes === 0) {
    // Either task doesn't exist, wrong project, or not in a completable state
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Task cannot be completed — it may not exist or is not in a completable status'
    );
  }

  // Sync trigger execution status (best-effort) — without this, cron triggers
  // with skipIfRunning=true permanently stop firing because the execution stays 'running'.
  await syncTriggerExecutionStatus(env.DATABASE, tokenData.taskId, 'completed');

  // Recompute scheduler states for sibling tasks in the same mission (best-effort).
  // When a mission task completes, other tasks that were blocked_dependency may become schedulable.
  if (taskRow?.mission_id) {
    try {
      await recomputeMissionSchedulerStates(env.DATABASE, taskRow.mission_id);
    } catch (err) {
      log.warn('mcp.complete_task.scheduler_state_recompute_failed', {
        taskId: tokenData.taskId,
        missionId: taskRow.mission_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Notify the orchestrator of the completion — triggers immediate scheduling cycle
    try {
      await orchestratorService.notifyTaskEvent(env, tokenData.projectId, {
        taskId: tokenData.taskId,
        missionId: taskRow.mission_id,
        event: 'completed',
        timestamp: Date.now(),
      });
    } catch (err) {
      log.warn('mcp.complete_task.orchestrator_notify_failed', {
        taskId: tokenData.taskId,
        missionId: taskRow.mission_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Record completion activity event
  try {
    const doId = env.PROJECT_DATA.idFromName(tokenData.projectId);
    const doStub = env.PROJECT_DATA.get(doId);
    await doStub.fetch(
      new Request('https://do/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'task.completed',
          actorType: 'agent',
          actorId: tokenData.workspaceId,
          metadata: {
            taskId: tokenData.taskId,
            summary: summary?.slice(0, getMcpLimits(env).activityMessageMaxLength) ?? null,
          },
        }),
      })
    );
  } catch (err) {
    log.warn('mcp.complete_task.activity_event_failed', {
      taskId: tokenData.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Note: Token is NOT revoked here. The MCP connection outlives individual
  // tasks (scoped to the ACP session / workspace lifetime). Revoking on
  // complete_task would break all subsequent MCP calls in the same session.
  // Token cleanup is handled by:
  //   1. KV TTL auto-expiration (default 4 hours, configurable via MCP_TOKEN_TTL_SECONDS)
  //   2. Task-runner DO cleanup on failure (task-runner.ts)

  // Emit task completion notification (best-effort)
  if (env.NOTIFICATION && taskRow?.user_id) {
    try {
      const [projectName, sessionId] = await Promise.all([
        notificationService.getProjectName(env, tokenData.projectId),
        notificationService.getChatSessionId(env, tokenData.workspaceId),
      ]);
      await notificationService.notifyTaskComplete(env, taskRow.user_id, {
        projectId: tokenData.projectId,
        projectName,
        taskId: tokenData.taskId,
        taskTitle: taskRow.title,
        outputPrUrl: taskRow.output_pr_url,
        outputBranch: taskRow.output_branch,
        sessionId,
      });
    } catch (err) {
      log.warn('mcp.complete_task.notification_failed', {
        taskId: tokenData.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Stop/fail ProjectData session state and tear down runtime resources before
  // reporting terminal success, so cf-container billing cannot depend on
  // best-effort waitUntil completion.
  try {
    await cleanupTerminalTaskResources(env, tokenData.taskId, {
      status: 'completed',
      logContext: { source: 'mcp.complete_task', workspaceId: tokenData.workspaceId },
    });
  } catch (err) {
    log.error('mcp.complete_task.cleanup_failed', {
      taskId: tokenData.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  log.info('mcp.complete_task', {
    taskId: tokenData.taskId,
    projectId: tokenData.projectId,
    summary: summary?.slice(0, getMcpLimits(env).logMessageMaxLength) ?? null,
  });

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: 'Task marked as completed.' }],
  });
}

export async function handleListTasks(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);
  const status = typeof params.status === 'string' ? params.status : undefined;
  const includeOwn = params.include_own === true;
  const requestedLimit = typeof params.limit === 'number' ? params.limit : limits.taskListLimit;
  const limit = Math.min(Math.max(1, Math.round(requestedLimit)), limits.taskListMax);

  const db = drizzle(env.DATABASE, { schema });

  const conditions: SQL[] = [eq(schema.tasks.projectId, tokenData.projectId)];

  if (!includeOwn) {
    // We can't easily do "not equal" with drizzle's eq helper, so we filter post-query
  }

  if (status) {
    conditions.push(eq(schema.tasks.status, status));
  }

  // Fetch one extra so we can filter out own task without reducing results
  const fetchLimit = includeOwn ? limit : limit + 1;

  const rows = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      description: schema.tasks.description,
      status: schema.tasks.status,
      priority: schema.tasks.priority,
      outputBranch: schema.tasks.outputBranch,
      outputPrUrl: schema.tasks.outputPrUrl,
      outputSummary: schema.tasks.outputSummary,
      createdAt: schema.tasks.createdAt,
      updatedAt: schema.tasks.updatedAt,
    })
    .from(schema.tasks)
    .where(and(...conditions))
    .orderBy(desc(schema.tasks.updatedAt))
    .limit(fetchLimit);

  let tasks = includeOwn ? rows : rows.filter((t) => t.id !== tokenData.taskId);

  // Trim to requested limit after filtering
  tasks = tasks.slice(0, limit);

  const snippetLen = limits.taskDescriptionSnippetLength;
  const result = tasks.map((task) => toTaskSearchResult(task, snippetLen));

  return jsonRpcSuccess(requestId, {
    content: [
      { type: 'text', text: JSON.stringify({ tasks: result, count: result.length }, null, 2) },
    ],
  });
}

export async function handleGetTaskDetails(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const taskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
  if (!taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'taskId is required');
  }

  const db = drizzle(env.DATABASE, { schema });

  const rows = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      description: schema.tasks.description,
      status: schema.tasks.status,
      priority: schema.tasks.priority,
      outputBranch: schema.tasks.outputBranch,
      outputPrUrl: schema.tasks.outputPrUrl,
      outputSummary: schema.tasks.outputSummary,
      completionEvidence: schema.tasks.completionEvidence,
      errorMessage: schema.tasks.errorMessage,
      chatSessionId: schema.tasks.chatSessionId,
      createdAt: schema.tasks.createdAt,
      updatedAt: schema.tasks.updatedAt,
      startedAt: schema.tasks.startedAt,
      completedAt: schema.tasks.completedAt,
    })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.projectId, tokenData.projectId)))
    .limit(1);

  const task = rows[0];
  if (!task) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Task not found in this project');
  }

  const taskResult = {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    outputBranch: task.outputBranch,
    outputPrUrl: task.outputPrUrl,
    outputSummary: task.outputSummary,
    completionEvidence: parseCompletionEvidenceJson(task.completionEvidence ?? null),
    errorMessage: task.errorMessage,
    // Instant (cf-container) dispatches create the chat session asynchronously;
    // dispatch_task points callers here to obtain the sessionId after launch.
    sessionId: task.chatSessionId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
  };

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(taskResult, null, 2) }],
  });
}

export async function handleSearchTasks(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const query = typeof params.query === 'string' ? params.query.trim() : '';
  if (!query) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'query is required and must be a non-empty string'
    );
  }
  if (query.length < 2) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'query must be at least 2 characters');
  }

  const limits = getMcpLimits(env);
  const status = typeof params.status === 'string' ? params.status : undefined;
  const requestedLimit = typeof params.limit === 'number' ? params.limit : 10;
  const searchLimit = Math.min(Math.max(1, Math.round(requestedLimit)), limits.taskSearchMax);

  const db = drizzle(env.DATABASE, { schema });
  const searchPattern = `%${query}%`;

  const conditions: SQL[] = [
    eq(schema.tasks.projectId, tokenData.projectId),
    or(like(schema.tasks.title, searchPattern), like(schema.tasks.description, searchPattern))!,
  ];

  if (status) {
    conditions.push(eq(schema.tasks.status, status));
  }

  const rows = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      description: schema.tasks.description,
      status: schema.tasks.status,
      priority: schema.tasks.priority,
      outputBranch: schema.tasks.outputBranch,
      outputPrUrl: schema.tasks.outputPrUrl,
      outputSummary: schema.tasks.outputSummary,
      updatedAt: schema.tasks.updatedAt,
    })
    .from(schema.tasks)
    .where(and(...conditions))
    .orderBy(desc(schema.tasks.updatedAt))
    .limit(searchLimit);

  const snippetLen = limits.taskDescriptionSnippetLength;
  const result = rows.map((task) => toTaskSearchResult(task, snippetLen));

  return jsonRpcSuccess(requestId, {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ tasks: result, count: result.length, query }, null, 2),
      },
    ],
  });
}
