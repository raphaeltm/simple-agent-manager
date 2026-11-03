/**
 * End the agent's turn before a REQUIRED sleep (`session-sleep-requirement.ts`).
 *
 * A turn that never returns kept every sleep path waiting forever: the gate refused "agent is
 * not idle", deferrals never reached the bounded fallback, and the workspace pinned its node
 * (production 2026-11-03). A required sleep therefore ends the turn itself:
 *
 * 1. `stopAgentSessionOnNode`. The VM agent completes the in-flight prompt as cancelled, kills
 *    the agent process and does NOT restart it (`handleStopAgentSession` → `SessionHost.Stop`).
 *    The chat Stop button's `/cancel` restarts the agent, which then reports `recovering` and
 *    can start new turns while the final snapshot is captured; a runtime about to be torn down
 *    must not do either. The session record keeps its ACP session id, so the snapshot still
 *    records a resumable harness identity (`populateSnapshotHarnessIdentity`).
 * 2. `recordSessionTurnEnd`, the control-plane turn end, so ProjectData does not wait for a VM
 *    `idle` report that a wedged turn may never send.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { NodeAgentHttpError, stopAgentSessionOnNode } from './node-agent';
import * as projectDataService from './project-data';
import { isSleepingContainerRuntime } from './sleeping-container-runtime';

/** Activities that mean a turn is (or may be) in flight on the agent. */
const RUNNING_TURN_ACTIVITIES = new Set(['prompting', 'recovering']);

/** The agent has no session to stop: nothing is in flight there. */
const NO_TURN_ON_AGENT = 404;

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
  // A sleeping Instant container has no turn in flight, and a stop would wake it.
  const status = isSleepingContainerRuntime(workspace)
    ? NO_TURN_ON_AGENT
    : await stopAgentSessionOnNode(
        workspace.nodeId,
        workspace.id,
        agentSessionId,
        env,
        workspace.userId,
        { requestTimeoutMs: options.requestTimeoutMs }
      ).then(
        () => 200,
        (error: unknown) => {
          // 404: the agent has no such session running, so ProjectData's turn is stale.
          if (error instanceof NodeAgentHttpError && error.statusCode === 404) {
            return NO_TURN_ON_AGENT;
          }
          log.warn('session_sleep.required_turn_stop_failed', {
            workspaceId: workspace.id,
            agentSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          return error instanceof NodeAgentHttpError ? error.statusCode : 0;
        }
      );
  const confirmed = status === 200 || status === NO_TURN_ON_AGENT;
  if (!confirmed && !options.confirmWithoutAgent) {
    throw new RequiredSleepTurnEndError(status);
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
