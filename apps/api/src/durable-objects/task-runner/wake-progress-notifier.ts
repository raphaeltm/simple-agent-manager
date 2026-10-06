/**
 * Emits live wake-progress deltas from the replacement TaskRunner to the
 * ProjectData DO, so a user watching a sleeping conversation sees which phase the
 * wake is in without waiting for their next poll.
 *
 * ## Why it hangs off the execution-step write
 *
 * `updateD1ExecutionStep` is the single choke point through which every TaskRunner
 * step transition reaches D1, and it is already idempotency-guarded on
 * `state.lastD1Step`. Hooking here therefore fires exactly once per *real* phase
 * change — no dedupe logic of its own, and no risk of a poll loop re-emitting the
 * same phase.
 *
 * ## Why it can never break a wake
 *
 * This is cosmetic telemetry for a lifecycle operation that must succeed on its
 * own. Three guards, in order of importance:
 *
 *  1. **Only recovery tasks emit.** `config.resumeSnapshotChatSessionId` is null
 *     for every normal task run, so ordinary task execution does zero extra work
 *     and produces zero broadcasts.
 *  2. **Failures are swallowed.** A DO that is overloaded, evicted, or throwing
 *     must not fail the step transition that was already durably written to D1.
 *  3. **Bounded.** The call races an env-configurable timeout so a hung DO cannot
 *     wedge the runner's alarm (rule 47 — background calls get their own short
 *     budget, never the 30s interactive default).
 *
 * A dropped broadcast is self-healing: D1 remains the durable record and the
 * client's next hydrate rebuilds the same phase from
 * `routes/chat/wake-state.ts`.
 */

import type { TaskExecutionStep } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import type { ProjectData } from '../project-data';
import type { SessionWakeProgressInput } from '../project-data/session-wake-progress';
import { parseEnvInt } from './helpers';

/**
 * Bounded budget for the wake-progress broadcast RPC. The DO side only writes to
 * already-open sockets, so a healthy call returns in single-digit milliseconds;
 * seconds of silence means the DO is unavailable and the delta is not worth
 * waiting for.
 */
export const DEFAULT_WAKE_PROGRESS_BROADCAST_TIMEOUT_MS = 5_000;

export function getWakeProgressBroadcastTimeoutMs(env: Env): number {
  return parseEnvInt(
    env.WAKE_PROGRESS_BROADCAST_TIMEOUT_MS,
    DEFAULT_WAKE_PROGRESS_BROADCAST_TIMEOUT_MS
  );
}

/** Terminal steps: the replacement runner is up, so the wake is over. */
const RESTORED_STEPS: ReadonlySet<TaskExecutionStep> = new Set<TaskExecutionStep>([
  'running',
  'awaiting_followup',
]);

/**
 * Map an execution step to the recovery status the client should render.
 *
 * Reaching `running` means the agent session is live, so the banner must clear
 * even though `session_snapshots.recovery_status` is written separately by
 * `completeSessionSnapshotRecovery`. Without this the banner would linger until
 * the next poll observed the D1 transition.
 */
export function recoveryStatusForStep(step: TaskExecutionStep): 'waking' | 'restored' {
  return RESTORED_STEPS.has(step) ? 'restored' : 'waking';
}

export interface NotifyWakeProgressArgs {
  env: Env;
  projectId: string;
  /** Null for a normal task run — the discriminator that keeps this a no-op. */
  chatSessionId: string | null | undefined;
  step: TaskExecutionStep;
}

/**
 * Best-effort broadcast of a wake phase. Resolves to whether a broadcast was
 * actually issued, which is what the unit tests assert on (in particular: false
 * for a non-recovery task).
 */
export async function notifyWakeProgress(args: NotifyWakeProgressArgs): Promise<boolean> {
  const { env, projectId, chatSessionId, step } = args;
  return emitWakeProgress(env, projectId, chatSessionId, {
    recoveryStatus: recoveryStatusForStep(step),
    wakePhase: step,
  });
}

export interface NotifyWakeSettledArgs {
  env: Env;
  projectId: string;
  /** Null for a normal task run — the discriminator that keeps this a no-op. */
  chatSessionId: string | null | undefined;
  status: 'restored' | 'failed';
}

/**
 * Broadcast that a wake has finished, so the banner clears immediately.
 *
 * This exists as a separate entry point because the terminal transition does NOT
 * flow through `updateD1ExecutionStep`: `transitionToInProgress` writes
 * `execution_step = 'running'` with its own guarded raw `UPDATE` (it needs the
 * optimistic-lock predicate in the same statement), and the alarm dispatcher
 * treats `running`/`awaiting_followup` as terminal no-op steps. So the step
 * choke-point that carries every intermediate phase never sees the last one.
 *
 * Without this call the banner would linger until the client's next fallback
 * poll — the exact lag this feature exists to remove.
 */
export async function notifyWakeSettled(args: NotifyWakeSettledArgs): Promise<boolean> {
  const { env, projectId, chatSessionId, status } = args;
  return emitWakeProgress(env, projectId, chatSessionId, {
    recoveryStatus: status,
    // The wake is over; a phase here would render as stale progress.
    wakePhase: null,
  });
}

async function emitWakeProgress(
  env: Env,
  projectId: string,
  chatSessionId: string | null | undefined,
  payload: Pick<SessionWakeProgressInput, 'recoveryStatus' | 'wakePhase'>
): Promise<boolean> {
  if (!chatSessionId) return false;

  const input: SessionWakeProgressInput = { chatSessionId, ...payload };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const id = env.PROJECT_DATA.idFromName(projectId);
    const stub = env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectData>;

    // No ensureProjectId: broadcastEvent only touches already-open sockets, so it
    // needs no persisted projectId and must not pay that extra roundtrip.
    const timeoutMs = getWakeProgressBroadcastTimeoutMs(env);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`wake progress broadcast timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    });

    await Promise.race([stub.publishSessionWakeProgress(input), timeout]);
    return true;
  } catch (err) {
    // Never rethrow: the transition is already durable in D1 and the client
    // recovers this state on its next hydrate.
    log.warn('task_runner_do.wake_progress_broadcast_failed', {
      projectId,
      chatSessionId,
      recoveryStatus: payload.recoveryStatus,
      wakePhase: payload.wakePhase,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
