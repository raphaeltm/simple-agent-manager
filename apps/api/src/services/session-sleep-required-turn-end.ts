/**
 * End the agent's turn before a REQUIRED sleep (`session-sleep-requirement.ts`).
 *
 * A turn that never returns kept every sleep path waiting forever: the gate refused "agent is
 * not idle", deferrals never reached the bounded fallback, and the workspace pinned its node
 * (production 2026-11-03). A required sleep therefore ends the turn itself:
 *
 * 1. `cancelAgentSessionOnNode`, the chat Stop button's path. The VM agent cancels the ACP
 *    prompt and stops the agent process, SIGTERM then SIGKILL (`CancelPromptFromControlPlane` →
 *    `StopProcessForPromptCancel`), and restarts it idle. The restart matters: if this sleep then
 *    fails before teardown, the chat is left with a working agent. `/stop` would end the turn the
 *    same way but leave the session permanently stopped, so a failed sleep would strand the chat.
 *    The restarting agent reports `recovering`; the required gate does not count that as a turn
 *    (`classifyRequiredSleepTurn`).
 * 2. `recordSessionTurnEnd`, the control-plane turn end, so ProjectData does not wait for a VM
 *    `idle` report that a wedged turn may never send.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { cancelAgentSessionOnNode } from './node-agent';
import * as projectDataService from './project-data';
import { isSleepingContainerRuntime } from './sleeping-container-runtime';

/** Activities that mean a turn is (or may be) in flight on the agent. */
const RUNNING_TURN_ACTIVITIES = new Set(['prompting', 'recovering']);

/**
 * Agent answers meaning nothing is in flight there, so ProjectData's turn is stale: 409, no
 * prompt to cancel; 404, no such session on the VM.
 */
const NO_TURN_STATUSES = new Set([404, 409]);

export function isRequiredSleepTurnRunning(activity: string | null | undefined): boolean {
  return RUNNING_TURN_ACTIVITIES.has(activity ?? '');
}

export class RequiredSleepTurnEndError extends Error {
  constructor(status: number) {
    super(`Required sleep could not stop the agent turn (agent responded ${status})`);
    this.name = 'RequiredSleepTurnEndError';
  }
}

export interface RequiredSleepTurnTarget {
  id: string;
  userId: string;
  projectId: string;
  nodeId: string;
  nodeRuntime: string | null;
  nodeStatus: string | null;
}

/**
 * Returns whether a running turn was found and ended. Throws `RequiredSleepTurnEndError` when
 * the agent did not confirm, so the attempt counts toward the bounded fallback. With
 * `confirmWithoutAgent` (the fallback, once that budget is spent) the turn end is recorded even
 * when the agent cannot be reached: the runtime is about to be torn down regardless.
 */
export async function endAgentTurnForRequiredSleep(
  env: Env,
  workspace: RequiredSleepTurnTarget,
  agentSessionId: string,
  options: {
    reason: string;
    confirmWithoutAgent?: boolean;
    /**
     * Control loops (the sweep, the fallback) pass the background node-agent timeout
     * (.claude/rules/47); a person's Sleep keeps the interactive default.
     */
    requestTimeoutMs?: number;
  }
): Promise<boolean> {
  const state = await projectDataService.getSessionState(env, workspace.projectId, agentSessionId);
  if (!isRequiredSleepTurnRunning(state?.activity)) return false;

  // Captured before the VM call, so a turn that starts during the call is never ended by
  // this call's result (.claude/rules/49).
  const observedAt = Date.now();
  // A sleeping Instant container has no turn in flight, and a cancel would wake it.
  // `cancelAgentSessionOnNode` never throws: a timeout or network failure is a status.
  const result = isSleepingContainerRuntime(workspace)
    ? { success: false, status: 409 }
    : await cancelAgentSessionOnNode(
        workspace.nodeId,
        workspace.id,
        agentSessionId,
        env,
        workspace.userId,
        { requestTimeoutMs: options.requestTimeoutMs }
      );
  const status = result.status;
  const confirmed = result.success || NO_TURN_STATUSES.has(status);
  if (!confirmed) {
    log.warn('session_sleep.required_turn_cancel_unconfirmed', {
      workspaceId: workspace.id,
      agentSessionId,
      agentStatus: status,
      confirmWithoutAgent: options.confirmWithoutAgent === true,
    });
    if (!options.confirmWithoutAgent) throw new RequiredSleepTurnEndError(status);
  }

  await projectDataService.recordSessionTurnEnd(env, workspace.projectId, agentSessionId, {
    reason: 'cancelled',
    observedAt,
  });
  log.info('session_sleep.required_turn_ended', {
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    agentSessionId,
    reason: options.reason,
    activity: state?.activity ?? null,
    agentStatus: status,
    confirmedByAgent: confirmed,
  });
  return true;
}
