/**
 * Trigger Task Submission Bridge
 *
 * Bridges from trigger execution to the retry-safe normal task submission
 * adapter. Called by both the cron sweep engine and the manual "Run Now"
 * endpoint.
 */
import type { TaskMode, TriggeredBy } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import {
  reservedIdentitiesForTriggerExecution,
  submitReservedTask,
  type ReservedTaskSubmissionResult,
} from './reserved-task-submission';
import { type SubmittedTriggerTask, TriggerTaskSubmissionPendingError } from './trigger-submission';

export { TriggerTaskSubmissionPendingError } from './trigger-submission';
export type SubmitTriggeredTaskResult = SubmittedTriggerTask;

export interface SubmitTriggeredTaskInput {
  /** The trigger that's firing. */
  triggerId: string;
  /** The execution record ID. */
  triggerExecutionId: string;
  /** Project this trigger belongs to. */
  projectId: string;
  /** User who owns the trigger. */
  userId: string;
  /** The rendered prompt to use as the task description. */
  renderedPrompt: string;
  /** How the task was triggered (e.g., 'cron'). */
  triggeredBy: Exclude<TriggeredBy, 'mcp'>;
  /** Agent profile ID to use (from trigger config). */
  agentProfileId: string | null;
  /** Skill ID to use (from trigger config). */
  skillId: string | null;
  /** Task execution mode from trigger config. */
  taskMode: TaskMode;
  /** VM size override from trigger config. */
  vmSizeOverride: string | null;
  /** Trigger name (for branch naming). */
  triggerName: string;
}

function reservedOutcomeToError(result: ReservedTaskSubmissionResult): Error {
  if (result.outcome === 'pending') {
    return new TriggerTaskSubmissionPendingError({
      taskId: result.taskId,
      sessionId: result.sessionId,
      branchName: result.branchName,
    });
  }
  if (result.outcome === 'terminal') {
    return new Error(
      `Reserved trigger task ${result.taskId} is already terminal: ${result.status}`
    );
  }
  return new Error(result.outcome === 'conflict' ? result.message : 'Unexpected trigger submission outcome');
}

/**
 * Submit a task from a trigger execution using identities derived from the
 * already-reserved trigger execution row.
 */
export async function submitTriggeredTask(
  env: Env,
  input: SubmitTriggeredTaskInput
): Promise<SubmittedTriggerTask> {
  const result = await submitReservedTask(env, {
    identities: reservedIdentitiesForTriggerExecution(input.triggerExecutionId),
    projectId: input.projectId,
    userId: input.userId,
    prompt: input.renderedPrompt,
    branchNameSeed: input.triggerName,
    agentProfileId: input.agentProfileId,
    skillId: input.skillId,
    taskMode: input.taskMode,
    vmSizeOverride: input.vmSizeOverride,
    source: {
      kind: 'trigger',
      sourceId: input.triggerId,
      sourceExecutionId: input.triggerExecutionId,
      triggeredBy: input.triggeredBy,
      displayName: input.triggerName,
      repositoryAccessFlow: `trigger-${input.triggeredBy}`,
      initialStatusReason: `Triggered by ${input.triggeredBy} (trigger: ${input.triggerId})`,
      initialStatusActorType: 'system',
      initialStatusActorId: null,
      triggerId: input.triggerId,
      triggerExecutionId: input.triggerExecutionId,
    },
  });

  if (result.outcome !== 'admitted') {
    log.warn('trigger_submit.reserved_not_admitted', {
      taskId: result.taskId,
      triggerId: input.triggerId,
      triggerExecutionId: input.triggerExecutionId,
      projectId: input.projectId,
      outcome: result.outcome,
      reason: 'reason' in result ? result.reason : result.status,
    });
    throw reservedOutcomeToError(result);
  }

  log.info('trigger_submit.created', {
    taskId: result.taskId,
    triggerId: input.triggerId,
    triggerExecutionId: input.triggerExecutionId,
    projectId: input.projectId,
    sessionId: result.sessionId,
    branchName: result.branchName,
    reused: result.reused,
    startState: result.startState,
    triggeredBy: input.triggeredBy,
  });

  return { taskId: result.taskId, sessionId: result.sessionId, branchName: result.branchName };
}
