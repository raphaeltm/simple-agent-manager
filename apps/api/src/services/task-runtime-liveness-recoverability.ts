/**
 * Recoverability predicates behind the task-runtime classifier: does a slept
 * session's snapshot still satisfy the resumer, and is a resumability or
 * supersession lookup worth its D1 read for this candidate?
 *
 * Split out of `task-runtime-liveness.ts` to keep that module under the 500-line
 * ceiling (`.claude/rules/18`). Re-exported from `task-runtime-liveness.ts` so
 * existing imports are unchanged.
 */
import { isRestorableSnapshot } from './session-snapshot-artifacts';
import { sessionRecoveryBudgetAvailable } from './session-snapshot-recovery-budget';
import type {
  RuntimeWorkspaceSnapshot,
  SessionResumabilitySnapshot,
  TaskRuntimeLivenessSignals,
} from './task-runtime-liveness-types';

export const INCONCLUSIVE_WORKSPACE_STATUSES = new Set(['creating', 'sleeping', 'recovery']);
/** `session_snapshots.sleep_status` value meaning "asleep right now". */
const RESUMABLE_SLEEP_STATUS = 'sleeping';

/**
 * True when the session is currently asleep with a restorable, unexpired
 * snapshot. `.claude/rules/02` requires sleep to be classified inconclusive:
 * `NodeLifecycle` rewrites a slept workspace's `sleeping` status to `deleted`
 * five minutes after sleep, so workspace status alone cannot distinguish
 * "slept and restorable" from "destroyed".
 *
 * A user-initiated delete destroys the snapshot row entirely
 * (`session-snapshot-persistence.ts:deleteSessionSnapshotState`), so snapshot
 * presence — not a deletion-cause column — is the discriminator.
 *
 * Every condition below mirrors one the resumer already enforces, so this
 * predicate can never be looser than the gate that authorizes a real wake
 * (`.claude/rules/58`). Being *equal* rather than merely safe matters: a
 * snapshot the resumer would refuse must terminalize, or the task waits out the
 * full snapshot TTL for a wake that can never happen.
 */
export function isSessionResumable(
  snapshot: SessionResumabilitySnapshot | null,
  projectId: string,
  workspaceId: string,
  budget: { maxRecoveryAttempts: number; recoveryAttemptDecayMs: number; nowMs: number }
): boolean {
  if (!snapshot) return false;
  // Defence in depth: the loader is already project+workspace scoped, so these
  // two re-checks are the in-memory half of the pair `.claude/rules/28` wants.
  if (snapshot.projectId !== projectId) return false;
  if (snapshot.workspaceId !== workspaceId) return false;
  if (snapshot.sleepingAt === null) return false;
  // A session that already woke clears both `sleeping_at` and `sleep_status`
  // (`markSessionSnapshotAwakeInPlace`, `completeSessionSnapshotRecovery`);
  // this is the belt-and-braces half of that pair.
  if (snapshot.sleepStatus !== RESUMABLE_SLEEP_STATUS) return false;
  // Mirrors `restorableSnapshotCondition()` in the claim's WHERE clause.
  if (!isRestorableSnapshot(snapshot.status, snapshot.degradation)) return false;
  // Mirrors the resumer's attempt budget exactly, decay included
  // (`session-snapshot-recovery-budget.ts`). A budget that is merely spent is NOT
  // conclusive: the resumer will release it once the last clean failure ages past
  // the decay window, so declaring the task dead here would destroy a session the
  // resumer can still wake (`.claude/rules/58`). Only a budget that is spent AND
  // undecayed refuses the claim, at which point preserving the task would strand
  // it until the snapshot TTL — the second bounded escape (`.claude/rules/47`).
  if (
    !sessionRecoveryBudgetAvailable({
      recoveryAttempts: snapshot.recoveryAttempts,
      recoveryFailedAtMs: snapshot.recoveryFailedAtMs,
      maxAttempts: budget.maxRecoveryAttempts,
      decayMs: budget.recoveryAttemptDecayMs,
      nowMs: budget.nowMs,
    })
  ) {
    return false;
  }
  // An absent or unparseable expiry is treated as NOT resumable so a snapshot
  // can never make a task immortal (`.claude/rules/47` bounded escape path).
  if (snapshot.expiresAtMs === null) return false;
  return snapshot.expiresAtMs > budget.nowMs;
}

/**
 * Whether a resumability lookup can still change the verdict. Adapters use this
 * to keep the extra D1 read off the hot path: it only fires for a workspace
 * that would otherwise be declared conclusively dead
 * (`.claude/rules/47` control-loop I/O budget).
 */
export function needsSessionResumabilityProbe(
  workspace: RuntimeWorkspaceSnapshot | null,
  workspaceProbeOutcome: TaskRuntimeLivenessSignals['workspaceProbeOutcome']
): workspace is RuntimeWorkspaceSnapshot & { chatSessionId: string } {
  return (
    workspaceProbeOutcome === 'ok' &&
    workspace !== null &&
    workspace.chatSessionId !== null &&
    workspace.status !== 'running' &&
    !INCONCLUSIVE_WORKSPACE_STATUSES.has(workspace.status)
  );
}

/**
 * Whether a supersession lookup can still change the verdict. Like
 * `needsSessionResumabilityProbe` this keeps the extra D1 read off the hot path
 * by firing only for a task that would otherwise be declared conclusively dead
 * (`.claude/rules/47` control-loop I/O budget).
 *
 * Deliberately NOT gated on `workspace.chatSessionId`. A wake handoff nulls that
 * exact column (`session-recovery.ts:createRecoveryTask` stmt 3), so gating on it
 * would blind this probe to precisely the population it exists to protect — the
 * mistake that made the resumability probe unreachable for superseded tasks
 * (`.claude/rules/63`). A null workspace is probed too: the task id, not the
 * workspace, is what identifies the recovery family.
 */
export function needsTaskSupersessionProbe(
  workspace: RuntimeWorkspaceSnapshot | null,
  workspaceProbeOutcome: TaskRuntimeLivenessSignals['workspaceProbeOutcome']
): boolean {
  if (workspaceProbeOutcome !== 'ok') return false;
  if (workspace === null) return true;
  return workspace.status !== 'running' && !INCONCLUSIVE_WORKSPACE_STATUSES.has(workspace.status);
}
