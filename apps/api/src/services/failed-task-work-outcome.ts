/**
 * What happens to a failed task's work when a ProjectData watchdog fails it (attention expiry):
 * preserve the conversation through the sleep lifecycle, or say the work is lost. Split from
 * `failed-task-preservation.ts` (`.claude/rules/18`); ProjectData reaches it through its tasks port.
 */
import type { Env } from '../env';
import {
  preserveFailedTaskWork,
  surfaceFailedTaskWorkLoss,
  withholdsFailedTaskTeardown,
} from './failed-task-preservation';

export interface FailedTaskWorkInput {
  taskId: string;
  projectId: string;
  workspaceId: string | null;
  chatSessionId: string | null;
  source: string;
  /** The check-in watchdog judged the agent stalled mid-turn: never preservable. */
  agentUnresponsive: boolean;
}

/**
 * `preserved: true`: the sleep lifecycle holds the runtime, so the caller withholds teardown.
 * `preserved: false`: the loss was surfaced in the conversation, and the caller fails the session
 * and tears the runtime down.
 */
export async function preserveFailedTaskWorkOrSurfaceLoss(
  env: Env,
  input: FailedTaskWorkInput
): Promise<{ preserved: true; outcome: string } | { preserved: false }> {
  const { agentUnresponsive, ...target } = input;
  // A turn the check-in watchdog saw stalled past its ceiling will not end; a sleep would wait on it.
  const preservation = agentUnresponsive
    ? ({ outcome: 'not_preservable', gap: 'agent_unresponsive' } as const)
    : await preserveFailedTaskWork(env, target);
  if (withholdsFailedTaskTeardown(preservation)) {
    return { preserved: true, outcome: preservation.outcome };
  }
  await surfaceFailedTaskWorkLoss(env, {
    taskId: input.taskId,
    projectId: input.projectId,
    chatSessionId: input.chatSessionId,
    reason: preservation.gap,
    source: input.source,
  });
  return { preserved: false };
}
