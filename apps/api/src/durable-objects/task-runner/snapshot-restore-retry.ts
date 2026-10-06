import type { Env } from '../../env';
import { getSessionSnapshotRequestTimeoutMs } from '../../services/node-agent-session-snapshots';
import type { TaskRunnerContext, TaskRunnerState } from './types';

/** Matches the VM agent's default and cloud-init's SESSION_SNAPSHOT_OPERATION_TIMEOUT. */
export const DEFAULT_SESSION_SNAPSHOT_OPERATION_TIMEOUT_MS = 15 * 60 * 1000;
// Go time.Duration is a signed int64 of nanoseconds; overflowing it falls back in the VM.
const GO_DURATION_MAX_NS = (1n << 63n) - 1n;
const DURATION_UNIT_NS = {
  ns: 1n,
  us: 1000n,
  ms: 1_000_000n,
  s: 1_000_000_000n,
  m: 60_000_000_000n,
  h: 3_600_000_000_000n,
} as const;

/** Parse the same positive Go-duration subset accepted by cloud-init (including 12m30s). */
export function getSessionSnapshotOperationTimeoutMs(env: Env): number {
  const value = env.SESSION_SNAPSHOT_OPERATION_TIMEOUT ?? '';
  if (!/^(?:[0-9]+(?:ns|us|ms|s|m|h))+$/.test(value)) {
    return DEFAULT_SESSION_SNAPSHOT_OPERATION_TIMEOUT_MS;
  }
  let duration = 0n;
  for (const match of value.matchAll(/([0-9]+)(ns|us|ms|s|m|h)/g)) {
    const unit = match[2] as keyof typeof DURATION_UNIT_NS;
    duration += BigInt(match[1] ?? '0') * DURATION_UNIT_NS[unit];
    if (duration > GO_DURATION_MAX_NS) return DEFAULT_SESSION_SNAPSHOT_OPERATION_TIMEOUT_MS;
  }
  return duration > 0n
    ? Number(duration) / 1_000_000
    : DEFAULT_SESSION_SNAPSHOT_OPERATION_TIMEOUT_MS;
}

/** Start once before the first RPC, and refuse late retries even if their alarm was delayed. */
export async function prepareSnapshotRestoreAttempt(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  if (state.stepResults.snapshotRestoreDeadlineAt == null) {
    const deadline =
      Date.now() +
      getSessionSnapshotOperationTimeoutMs(rc.env) +
      getSessionSnapshotRequestTimeoutMs(rc.env);
    // Publish ownership only after persistence, so a failed write cannot bypass it on retry.
    await rc.ctx.storage.put('state', {
      ...state,
      stepResults: { ...state.stepResults, snapshotRestoreDeadlineAt: deadline },
    });
    state.stepResults.snapshotRestoreDeadlineAt = deadline;
  }
  if (snapshotRestoreRetryBudget(state, Date.now()) !== true) {
    throw Object.assign(new Error('Session snapshot restore retry deadline exceeded'), {
      permanent: true,
    });
  }
}

/** Null means the ordinary retry-count policy applies; false means an accepted restore expired. */
function snapshotRestoreRetryBudget(state: TaskRunnerState, now: number): boolean | null {
  const deadline = state.stepResults.snapshotRestoreDeadlineAt;
  if (
    state.currentStep === 'agent_session' &&
    state.config.resumeSnapshotChatSessionId &&
    typeof deadline === 'number' &&
    Number.isFinite(deadline)
  ) {
    return now < deadline;
  }
  return null;
}

/** Accepted restores use elapsed time; every other step retains its ordinary retry-count cap. */
export function hasTaskStepRetryBudget(
  state: TaskRunnerState,
  maxRetries: number,
  now: number = Date.now()
): boolean {
  return snapshotRestoreRetryBudget(state, now) ?? state.retryCount < maxRetries;
}
