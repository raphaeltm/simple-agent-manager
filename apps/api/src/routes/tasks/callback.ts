import { isTaskExecutionStep } from '@simple-agent-manager/shared';
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { extractBearerToken } from '../../lib/auth-helpers';
import { log } from '../../lib/logger';
import { toTaskResponse } from '../../lib/mappers';
import { requireRouteParam } from '../../lib/route-helpers';
import { errors } from '../../middleware/error';
import { jsonValidator, UpdateTaskStatusSchema } from '../../schemas';
import { verifyCallbackToken } from '../../services/jwt';
import * as notificationService from '../../services/notification';
import * as projectDataService from '../../services/project-data';
import {
  canTransitionTaskStatus,
  getAllowedTaskTransitions,
  isTaskStatus,
} from '../../services/task-status';
import { cleanupTerminalTaskResourcesOrThrow } from '../../services/task-terminal-cleanup';
import {
  callbackTokenIssuedAtMs,
  getInstantStaleCallbackMarginMs,
  isSupersededInstantCallback,
} from '../_stale-callback-guard';
import {
  computeBlockedForTask,
  setTaskStatus,
} from './_helpers';

/**
 * Task callback route — mounted BEFORE projectsRoutes in index.ts
 * to avoid the blanket requireAuth() middleware that validates browser session
 * cookies (not callback JWTs).
 *
 * Auth: Callback JWT via Bearer token, verified inline with verifyCallbackToken().
 *
 * This is the FOURTH instance of the Hono middleware scope leak fix pattern:
 * - 2026-03-12: workspace callback routes (post-mortem exists)
 * - 2026-03-25: deployment identity token route (post-mortem exists)
 * - 2026-03-25: node ACP heartbeat route (post-mortem exists)
 * - 2026-05-12: task callback route (this fix)
 *
 * See: .claude/rules/06-api-patterns.md (Hono middleware scoping)
 * See: docs/notes/2026-05-12-task-callback-middleware-leak-postmortem.md
 */
const taskCallbackRoute = new Hono<{ Bindings: Env }>();

taskCallbackRoute.post('/:projectId/tasks/:taskId/status/callback', jsonValidator(UpdateTaskStatusSchema), async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const taskId = requireRouteParam(c, 'taskId');
  const db = drizzle(c.env.DATABASE, { schema });
  const body = c.req.valid('json');

  const token = extractBearerToken(c.req.header('Authorization'));
  const payload = await verifyCallbackToken(token, c.env, { expectedScope: 'workspace' });

  const rows = await db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.projectId, projectId)))
    .limit(1);

  const task = rows[0];
  if (!task) {
    throw errors.notFound('Task');
  }

  if (!task.workspaceId || payload.workspace !== task.workspaceId) {
    throw errors.forbidden('Token workspace mismatch');
  }

  // --- Execution-step-only update (no status transition) ---
  // When executionStep is provided without toStatus, update the step and
  // optionally persist gitPushResult outputs without changing task status.
  // This is used by the VM agent to report progress (e.g. awaiting_followup
  // after the agent pushes code but the task stays running).
  if (body.executionStep && !body.toStatus) {
    if (!isTaskExecutionStep(body.executionStep)) {
      throw errors.badRequest('Invalid executionStep value');
    }

    const now = new Date().toISOString();
    const stepUpdate: Partial<schema.NewTask> = {
      executionStep: body.executionStep,
      errorMessage: body.errorMessage?.trim() || null,
      updatedAt: now,
    };

    // Persist git push result fields into existing task columns
    if (body.gitPushResult) {
      // Finalization guard: only save git push results once
      if (!task.finalizedAt && body.gitPushResult.pushed) {
        stepUpdate.finalizedAt = now;
      }
      if (body.gitPushResult.branchName) {
        stepUpdate.outputBranch = body.gitPushResult.branchName;
      }
      if (body.gitPushResult.prUrl) {
        stepUpdate.outputPrUrl = body.gitPushResult.prUrl;
      }
    }

    if (body.outputBranch !== undefined) {
      stepUpdate.outputBranch = body.outputBranch?.trim() || null;
    }
    if (body.outputPrUrl !== undefined) {
      stepUpdate.outputPrUrl = body.outputPrUrl?.trim() || null;
    }

    await db
      .update(schema.tasks)
      .set(stepUpdate)
      .where(eq(schema.tasks.id, task.id));

    // Record activity event for execution step update
    c.executionCtx.waitUntil(
      projectDataService.recordActivityEvent(
        c.env, projectId, 'task.execution_step', 'workspace_callback', payload.workspace,
        task.workspaceId, null, taskId, {
          title: task.title,
          executionStep: body.executionStep,
          pushed: body.gitPushResult?.pushed ?? false,
        }
      ).catch((e) => { log.warn('task.execution_step_activity_failed', { taskId, error: String(e) }); })
    );

    const recoverableErrorMessage = body.errorMessage?.trim();
    if (recoverableErrorMessage) {
      c.executionCtx.waitUntil(
        (async () => {
          const [ws] = task.workspaceId
            ? await db
              .select({ chatSessionId: schema.workspaces.chatSessionId })
              .from(schema.workspaces)
              .where(eq(schema.workspaces.id, task.workspaceId))
              .limit(1)
            : [];

          await projectDataService.recordActivityEvent(
            c.env, projectId, 'task.agent_error_recoverable', 'workspace_callback', payload.workspace,
            task.workspaceId, ws?.chatSessionId ?? null, taskId, {
              title: task.title,
              executionStep: body.executionStep,
              errorMessage: recoverableErrorMessage,
            }
          );
        })().catch((err) => {
          log.warn('task.agent_error_recoverable_activity_failed', { taskId, error: err instanceof Error ? err.message : String(err) });
        })
      );
    }

    // Record agent-completed activity for awaiting_followup (task-mode only).
    // Task-mode cleanup is NOT triggered here — it happens when the agent explicitly
    // calls complete_task via the MCP tool. The awaiting_followup callback only means
    // the agent's current turn ended, not that the task lifecycle is complete.
    // Conversation-mode is exempt from this block entirely — the 2-hour workspace
    // idle timeout is the only kill mechanism for conversation mode.
    if (body.executionStep === 'awaiting_followup' && task.workspaceId && task.taskMode !== 'conversation') {
      c.executionCtx.waitUntil(
        (async () => {
          const [ws] = await db
            .select({ chatSessionId: schema.workspaces.chatSessionId })
            .from(schema.workspaces)
            .where(eq(schema.workspaces.id, task.workspaceId!))
            .limit(1);

          await projectDataService.recordActivityEvent(
            c.env, projectId, 'task.agent_completed', 'workspace_callback', payload.workspace,
            task.workspaceId, ws?.chatSessionId ?? null, taskId, {
              title: task.title,
              pushed: body.gitPushResult?.pushed ?? false,
              branchName: body.gitPushResult?.branchName ?? null,
              prUrl: body.gitPushResult?.prUrl ?? null,
            }
          );
        })().catch((err) => {
          log.error('task.agent_completed_activity_failed', { taskId, error: err instanceof Error ? err.message : String(err) });
        })
      );
    }

    const [refreshed] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, task.id))
      .limit(1);

    const blocked = await computeBlockedForTask(db, task.id);
    return c.json(toTaskResponse(refreshed ?? task, blocked));
  }

  // --- Standard status transition ---
  if (!isTaskStatus(body.toStatus)) {
    throw errors.badRequest('Invalid toStatus value');
  }

  if (!isTaskStatus(task.status)) {
    throw errors.badRequest(`Invalid task status in database: ${task.status}`);
  }

  if (
    task.status === body.toStatus &&
    (body.toStatus === 'completed' || body.toStatus === 'failed' || body.toStatus === 'cancelled')
  ) {
    await cleanupTerminalTaskResourcesOrThrow(c.env, taskId, {
      status: body.toStatus,
      errorMessage: task.errorMessage,
      projectId,
      failureLogEvent: 'task.callback_terminal_cleanup_failed',
      logContext: { projectId, source: 'task.callback.idempotent' },
    });
    const blocked = await computeBlockedForTask(db, task.id);
    return c.json(toTaskResponse(task, blocked));
  }

  if (!canTransitionTaskStatus(task.status, body.toStatus)) {
    throw errors.conflict(
      `Invalid transition ${task.status} -> ${body.toStatus}. Allowed: ${getAllowedTaskTransitions(task.status).join(', ') || 'none'}`
    );
  }

  // Staleness guard (S2): reject a DESTRUCTIVE `failed` callback that provably
  // originates from a superseded Instant (cf-container) generation. A dead
  // container killed mid-rollout can POST `toStatus:'failed'` with a still-valid
  // callback token AFTER the DO has recovered a NEW generation to running; that
  // late callback would otherwise fail an already-recovered, healthy task. Use
  // the workspace's most-recently-reconciled agent session `updated_at` (written
  // by the DO recovery) as the completed-recovery marker.
  if (body.toStatus === 'failed') {
    const [guardRow] = await db
      .select({
        updatedAt: schema.agentSessions.updatedAt,
        runtime: schema.nodes.runtime,
      })
      .from(schema.agentSessions)
      .leftJoin(schema.workspaces, eq(schema.workspaces.id, schema.agentSessions.workspaceId))
      .leftJoin(schema.nodes, eq(schema.nodes.id, schema.workspaces.nodeId))
      .where(eq(schema.agentSessions.workspaceId, task.workspaceId))
      .orderBy(desc(schema.agentSessions.updatedAt))
      .limit(1);
    const tokenIssuedAtMs = callbackTokenIssuedAtMs(token);
    const marginMs = getInstantStaleCallbackMarginMs(c.env);
    if (
      isSupersededInstantCallback({
        runtime: guardRow?.runtime,
        rowUpdatedAt: guardRow?.updatedAt,
        tokenIssuedAtMs,
        marginMs,
      })
    ) {
      log.warn('task.rejected_stale_callback', {
        projectId,
        taskId,
        workspaceId: task.workspaceId,
        callerWorkspace: payload.workspace,
        runtime: guardRow?.runtime ?? null,
        rowUpdatedAt: guardRow?.updatedAt ?? null,
        tokenIssuedAtMs,
        marginMs,
        fromStatus: task.status,
        toStatus: body.toStatus,
        action: 'rejected_stale_callback',
      });
      // 2xx: postTaskCallback is fire-and-forget (no retry) and logs non-2xx as
      // an error, so return the unchanged task with 200 — no regression, no noise.
      const blocked = await computeBlockedForTask(db, task.id);
      return c.json(toTaskResponse(task, blocked));
    }
  }

  const updatedTask = await setTaskStatus(db, task, body.toStatus, 'workspace_callback', payload.workspace, {
    reason: body.reason,
    outputSummary: body.outputSummary,
    outputBranch: body.outputBranch,
    outputPrUrl: body.outputPrUrl,
    errorMessage: body.errorMessage,
  });

  // Record activity event for task status change (from workspace callback)
  c.executionCtx.waitUntil(
    projectDataService.recordActivityEvent(
      c.env, projectId, `task.${body.toStatus}`, 'workspace_callback', payload.workspace,
      task.workspaceId, null, taskId, { title: task.title, fromStatus: task.status, toStatus: body.toStatus }
    ).catch((e) => { log.warn('task.callback_activity_event_failed', { taskId, error: String(e) }); })
  );

  // On terminal states, stop/fail the chat session and handle workspace/container cleanup.
  if (body.toStatus === 'completed' || body.toStatus === 'failed' || body.toStatus === 'cancelled') {
    await cleanupTerminalTaskResourcesOrThrow(c.env, taskId, {
      status: body.toStatus,
      errorMessage: updatedTask.errorMessage,
      projectId,
      failureLogEvent: 'task.callback_terminal_cleanup_failed',
      logContext: { projectId, source: 'task.callback' },
    });

    // Emit notifications for terminal task states (best-effort)
    if (c.env.NOTIFICATION) {
      c.executionCtx.waitUntil(
        (async () => {
          const [ws] = await db
            .select({ chatSessionId: schema.workspaces.chatSessionId })
            .from(schema.workspaces)
            .where(eq(schema.workspaces.id, updatedTask.workspaceId!))
            .limit(1);
          const sessionId = ws?.chatSessionId ?? null;

          const projectName = await notificationService.getProjectName(c.env, projectId);
          if (body.toStatus === 'completed') {
            await notificationService.notifyTaskComplete(c.env, task.userId, {
              projectId,
              projectName,
              taskId,
              taskTitle: task.title,
              sessionId,
              outputPrUrl: updatedTask.outputPrUrl,
              outputBranch: updatedTask.outputBranch,
            });
          } else if (body.toStatus === 'failed') {
            await notificationService.notifyTaskFailed(c.env, task.userId, {
              projectId,
              projectName,
              taskId,
              taskTitle: task.title,
              errorMessage: body.errorMessage,
              sessionId,
            });
          }
        })().catch((e) => { log.warn('task.notification_failed', { taskId, error: String(e) }); })
      );
    }
  }

  const blocked = await computeBlockedForTask(db, updatedTask.id);
  return c.json(toTaskResponse(updatedTask, blocked));
});

export { taskCallbackRoute };
