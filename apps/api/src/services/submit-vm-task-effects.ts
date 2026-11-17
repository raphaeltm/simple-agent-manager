/** VM submission effects kept in their required admission/session/link order. */
import { recordWorkStartIdeaLink } from '@simple-agent-manager/operations';
import { CHAT_CONTEXT_SUMMARY_SOURCE, type TaskMode } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { log } from '../lib/logger';
import { markTaskSubmitOperation } from '../lib/task-submit-diagnostics';
import { errors } from '../middleware/error';
import { operationDeps } from '../operation-ports';
import * as projectDataService from './project-data';
import type { SubmitVmTaskInput } from './submit-vm-task';
import { markTaskFailedIfNonTerminal } from './task-failure';

type Database = DrizzleD1Database<typeof schema>;

export async function enforcePlatformQuota(
  input: SubmitVmTaskInput,
  db: Database,
  quotaCredentialSource: string | null
): Promise<void> {
  const {
    env,
    setOperation,
    user: { id: userId },
  } = input;
  if (quotaCredentialSource === 'platform') {
    const quotaEnforcementEnabled = env.COMPUTE_QUOTA_ENFORCEMENT_ENABLED !== 'false';
    if (quotaEnforcementEnabled) {
      const { checkQuotaForUser } = await import('./compute-quotas');
      setOperation('compute_quota');
      const quotaCheck = await checkQuotaForUser(db, userId);
      if (!quotaCheck.allowed) {
        throw errors.forbidden(
          `Monthly compute quota exceeded. You've used ${quotaCheck.used} of ${quotaCheck.limit} vCPU-hours this month. ` +
            'Add your own cloud provider credentials in Settings or contact your admin to increase your quota.'
        );
      }
    }
  }
}

export async function persistVmTaskSession(
  input: SubmitVmTaskInput,
  db: Database,
  taskTitle: string
): Promise<string> {
  const {
    env,
    projectId,
    taskId,
    user: { id: userId },
    samReservation,
    body,
    message,
    setOperation,
    getOperation,
  } = input;
  // Persist the chat before starting its runner; failures must not orphan queued tasks.
  let sessionId: string;
  try {
    // Require a real session rather than manufacturing a fallback identity.
    setOperation('session_create');
    sessionId = await projectDataService.createSession(
      env,
      projectId,
      null, // workspaceId — linked later by TaskRunner DO when workspace is created
      taskTitle,
      taskId,
      userId,
      ...(samReservation ? ([samReservation.sessionId] as const) : ([] as const))
    );

    setOperation('task_session_link');
    // Make the returned session immediately discoverable before the runner alarm starts.
    await db
      .update(schema.tasks)
      .set({ chatSessionId: sessionId })
      .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.projectId, projectId)));

    // Context notes appear ahead of the prompt in chat, outside the task description.
    if (body.contextSummary) {
      setOperation('context_summary_persist');
      await projectDataService.persistMessage(
        env,
        projectId,
        sessionId,
        'system',
        body.contextSummary,
        { source: CHAT_CONTEXT_SUMMARY_SOURCE }
      );
    }

    setOperation('initial_message_persist');
    // Require initial-message persistence before returning.
    await projectDataService.persistMessage(
      env,
      projectId,
      sessionId,
      'user',
      message,
      null,
      ...(samReservation ? ([samReservation.initialMessageId] as const) : ([] as const))
    );
  } catch (err) {
    markTaskSubmitOperation(err, getOperation());
    if (samReservation) throw err;
    // Fail instead of leaving a queued task without its required transcript.
    const errorMsg = err instanceof Error ? err.message : String(err);
    setOperation('session_failure_task_update');
    await markTaskFailedIfNonTerminal(env.DATABASE, taskId, `Session creation failed: ${errorMsg}`);
    log.error('task_submit.session_failed', { taskId, projectId, error: errorMsg });
    throw err; // Re-throw to return 500 to the frontend
  }

  return sessionId;
}

export async function linkVmTaskSourceIdea(
  input: SubmitVmTaskInput,
  sessionId: string,
  taskMode: TaskMode
): Promise<void> {
  const { sourceIdea, env, projectId, taskId, samReservation, setOperation } = input;
  // Link the source idea before the runner can deliver the agent's first prompt.
  if (sourceIdea) {
    setOperation('source_idea_link');
    try {
      await recordWorkStartIdeaLink(operationDeps(env), projectId, {
        ideaId: sourceIdea.ideaId,
        sessionId,
        taskMode,
      });
    } catch (err) {
      if (samReservation) throw err;
      const errorMsg = err instanceof Error ? err.message : String(err);
      await markTaskFailedIfNonTerminal(env.DATABASE, taskId, `Idea link failed: ${errorMsg}`);
      await projectDataService.stopSession(env, projectId, sessionId).catch((e) => {
        log.error('task_submit.orphaned_session_stop_failed', {
          projectId,
          sessionId,
          error: String(e),
        });
      });
      throw err;
    }
  }
}
