import { log } from '../lib/logger';
import {
  findWakeableSleepingInstant,
  restoreWakeableSleepingInstant,
} from '../services/instant-sleeping-deletion-guard';
import { workspaceDeletionDueIndexKey } from './node-lifecycle-workspace-deletion-index';
import type {
  NodeLifecycleDeletionEnv,
  PendingWorkspaceDeletion,
} from './node-lifecycle-workspace-deletion-support';

/**
 * Refuse an automatic deletion of a wakeable sleeping Instant workspace
 * (`services/instant-sleeping-deletion-guard.ts`), and repair one that a failed automatic attempt
 * left `stopping`. Every automatic writer that schedules reaches the queue through `schedule()` or
 * an entry that comes due, so those two paths call this. Explicit entries are untouched.
 *
 * `releaseEntry` must remove exactly the entry this decision was made on (or confirm that none
 * exists) in one storage transaction, and return false when a claim replaced it in the meantime.
 * The D1 read below is an `await`, so another invocation can interleave (`.claude/rules/45`);
 * a replaced entry means a newer claim owns the row, and it must not be repaired underneath it.
 *
 * Returns true when the caller must not schedule or attempt the deletion.
 */
export async function keepWakeTarget(
  env: NodeLifecycleDeletionEnv,
  entry: PendingWorkspaceDeletion | undefined,
  workspaceId: string,
  releaseEntry: () => Promise<boolean>
): Promise<boolean> {
  if (entry?.mode === 'explicit') return false;
  const observed = await findWakeableSleepingInstant(env.DATABASE, workspaceId);
  if (!observed) return false;
  if (!(await releaseEntry())) {
    log.info('node_lifecycle.workspace_deletion_wake_target_superseded', {
      workspaceId,
      nodeId: entry?.nodeId ?? null,
      action: 'newer_claim_left_alone',
    });
    return true;
  }
  const restored = await restoreWakeableSleepingInstant(
    env.DATABASE,
    workspaceId,
    observed,
    new Date().toISOString()
  );
  log.warn('node_lifecycle.workspace_deletion_wake_target_kept', {
    workspaceId,
    nodeId: entry?.nodeId ?? null,
    status: observed.status,
    restoredToSleeping: restored,
    attemptCount: entry?.attemptCount ?? 0,
    action: entry ? 'automatic_entry_removed' : 'not_scheduled',
  });
  return true;
}

/**
 * Remove exactly `expected` from the queue, or confirm no entry exists when it is undefined, in
 * one storage transaction. False when the entry was replaced, claimed again or promoted to
 * explicit since it was read.
 */
export async function releaseExactAutomaticEntry(
  storage: DurableObjectStorage,
  key: string,
  expected: PendingWorkspaceDeletion | undefined
): Promise<boolean> {
  return await storage.transaction(async (transaction) => {
    const current = await transaction.get<PendingWorkspaceDeletion>(key);
    if (!expected || !current) return !current;
    if (
      current.mode === 'explicit' ||
      (current.claimId ?? null) !== (expected.claimId ?? null) ||
      (current.attemptCount ?? 0) !== (expected.attemptCount ?? 0)
    )
      return false;
    await transaction.delete(workspaceDeletionDueIndexKey(current));
    await transaction.delete(key);
    return true;
  });
}
