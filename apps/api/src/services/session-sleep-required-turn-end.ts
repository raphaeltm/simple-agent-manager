/**
 * End the agent's turn before a REQUIRED sleep (`session-sleep-requirement.ts`).
 *
 * A turn that never returns kept every sleep path waiting forever: the gate refused "agent is
 * not idle", deferrals never reached the bounded fallback, and the workspace pinned its node
 * (production 2026-11-03). A required sleep therefore ends the turn itself, through the same
 * path as the chat Stop button (`routes/chat-cancel.ts:interruptChat`):
 *
 * 1. `cancelAgentSessionOnNode`. The VM agent cancels the ACP prompt and stops the agent
 *    process, SIGTERM then SIGKILL (`CancelPromptFromControlPlane` →
 *    `StopProcessForPromptCancel`), and restarts it as an intentional stop.
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
  const result = isSleepingContainerRuntime(workspace)
    ? { success: false, status: 409 }
    : await cancelAgentSessionOnNode(
        workspace.nodeId,
        workspace.id,
        agentSessionId,
        env,
        workspace.userId,
        { requestTimeoutMs: options.requestTimeoutMs }
      ).catch((error: unknown) => {
        log.warn('session_sleep.required_turn_cancel_failed', {
          workspaceId: workspace.id,
          agentSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        return { success: false, status: 0 };
      });
  // 409: the agent reports no turn in flight, so ProjectData's `prompting` is stale.
  const confirmed = result.success || result.status === 409;
  if (!confirmed && !options.confirmWithoutAgent) {
    throw new RequiredSleepTurnEndError(result.status);
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
    agentStatus: result.status,
    confirmedByAgent: confirmed,
  });
  return true;
}
