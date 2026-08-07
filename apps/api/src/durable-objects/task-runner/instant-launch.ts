/**
 * Instant (cf-container) launch job — runs inside the TaskRunner DO.
 *
 * The instant-session continuation (container launch → agent ready → clone →
 * agent bootstrap) previously ran under the HTTP request's `ctx.waitUntil`,
 * which Cloudflare cancels ~30s after the response completes (and on client
 * disconnect). Cancellation runs no catch block, so a slow clone stranded the
 * task in `queued`/`instant_persistence` with a running-but-empty container
 * and zero error anywhere (2026-08-07 production incident, task
 * 01KZECB26257JD03VFSNW0J5G6). The TaskRunner DO exists precisely to replace
 * unreliable `waitUntil` orchestration (see index.ts header), so the launch
 * now runs from a DO alarm: a job-owned context independent of the request
 * (rule 43).
 *
 * Execution contract (one real attempt):
 * - `attempted` is persisted durably BEFORE the launch phases start. The
 *   phases are not idempotent, so a re-entered alarm that finds
 *   `attempted=true` classifies the interrupted attempt by milestone instead
 *   of re-running it:
 *   - milestone < `bootstrap_complete` → the container may hold a partially
 *     created workspace or a just-starting agent; fail closed via
 *     `markInstantLaunchFailed` (task failed, session failed, container
 *     destroyed) — guaranteed failure-marking, never a stuck `queued` row.
 *   - milestone = `bootstrap_complete` → the agent is live; only the
 *     idempotent finalize writes remain, so complete them and keep the
 *     session.
 * - The stuck-task sweep (`INSTANT_START_STALE_TIMEOUT_MS`) remains the outer
 *   backstop if the DO alarm never runs at all.
 */
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import {
  type AcceptedInstantSession,
  continueInstantSessionLaunch,
  finalizeInstantLaunch,
  type InstantLaunchFailureRef,
  type LaunchInstantSessionInput,
  markInstantLaunchFailed,
} from '../../services/instant-session';

export const INSTANT_LAUNCH_STORAGE_KEY = 'instantLaunch';

export type InstantLaunchMilestone = 'pending' | 'bootstrap_started' | 'bootstrap_complete';

export interface InstantLaunchJob {
  version: 1;
  input: LaunchInstantSessionInput;
  accepted: AcceptedInstantSession;
  /** Durably true once a launch attempt has begun (set before the first phase). */
  attempted: boolean;
  milestone: InstantLaunchMilestone;
  agentSessionId: string | null;
  createdAt: number;
}

function failureRef(accepted: AcceptedInstantSession): InstantLaunchFailureRef {
  return {
    taskId: accepted.taskId,
    projectId: accepted.projectId,
    chatSessionId: accepted.chatSessionId,
    workspaceId: accepted.workspaceId,
    nodeId: accepted.nodeId,
    containerId: accepted.containerId,
  };
}

/**
 * Drive one alarm tick for a pending instant-launch job. Never throws for a
 * failed launch (the launch's own catch marks the task failed and tears the
 * container down); DOES rethrow when only the idempotent finalize writes
 * failed, so the DO alarm retry re-runs them instead of stranding a live
 * agent behind a `queued` task.
 */
export async function runInstantLaunchAlarm(
  env: Env,
  storage: DurableObjectStorage,
  job: InstantLaunchJob
): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  const ref = failureRef(job.accepted);

  if (job.attempted) {
    if (job.milestone === 'bootstrap_complete') {
      log.warn('instant_launch_do.resume_finalize_only', {
        taskId: ref.taskId,
        workspaceId: ref.workspaceId,
        agentSessionId: job.agentSessionId,
      });
      // Throws propagate: the alarm retry re-runs this idempotent tail.
      await finalizeInstantLaunch(db, ref.taskId, ref.workspaceId, ref.nodeId);
      await storage.delete(INSTANT_LAUNCH_STORAGE_KEY);
      return;
    }

    log.error('instant_launch_do.interrupted_attempt_failed', {
      taskId: ref.taskId,
      workspaceId: ref.workspaceId,
      nodeId: ref.nodeId,
      milestone: job.milestone,
    });
    await markInstantLaunchFailed(
      db,
      env,
      ref,
      `Instant launch was interrupted before the agent started (milestone: ${job.milestone}); the session was cleaned up.`
    );
    await storage.delete(INSTANT_LAUNCH_STORAGE_KEY);
    return;
  }

  job.attempted = true;
  await storage.put(INSTANT_LAUNCH_STORAGE_KEY, job);

  try {
    await continueInstantSessionLaunch(db, env, job.input, job.accepted, {
      beforeAgentBootstrap: async () => {
        job.milestone = 'bootstrap_started';
        await storage.put(INSTANT_LAUNCH_STORAGE_KEY, job);
      },
      afterAgentBootstrap: async (agentSessionId) => {
        job.milestone = 'bootstrap_complete';
        job.agentSessionId = agentSessionId;
        await storage.put(INSTANT_LAUNCH_STORAGE_KEY, job);
      },
    });
    log.info('instant_launch_do.completed', {
      taskId: ref.taskId,
      workspaceId: ref.workspaceId,
      nodeId: ref.nodeId,
    });
  } catch (err) {
    // continueInstantSessionLaunch's catch already marked the task failed,
    // failed the chat session, and destroyed the container. Terminal — no
    // retry, no rethrow (an alarm retry would double-run non-idempotent
    // phases against a destroyed container).
    log.error('instant_launch_do.launch_failed', {
      taskId: ref.taskId,
      workspaceId: ref.workspaceId,
      nodeId: ref.nodeId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await storage.delete(INSTANT_LAUNCH_STORAGE_KEY);
}
