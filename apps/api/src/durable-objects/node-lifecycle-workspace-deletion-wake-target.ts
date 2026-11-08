import { log } from '../lib/logger';
import {
  findWakeableSleepingInstant,
  restoreWakeableSleepingInstant,
} from '../services/instant-sleeping-deletion-guard';
import type {
  NodeLifecycleDeletionEnv,
  PendingWorkspaceDeletion,
} from './node-lifecycle-workspace-deletion-support';

/**
 * Refuse an automatic deletion of a wakeable sleeping Instant workspace
 * (`services/instant-sleeping-deletion-guard.ts`), and repair one that an automatic claim already
 * moved to `stopping`. Every automatic writer reaches the queue through `schedule()` or an entry
 * that comes due, so this is the one guard all of them pass. Explicit deletion is untouched.
 *
 * Returns true when the wake target was kept, in which case the caller must not schedule or
 * attempt the deletion.
 */
export async function keepWakeTarget(
  env: NodeLifecycleDeletionEnv,
  entry: PendingWorkspaceDeletion | undefined,
  workspaceId: string,
  removeEntry: () => Promise<void>
): Promise<boolean> {
  if (entry?.mode === 'explicit') return false;
  const status = await findWakeableSleepingInstant(env.DATABASE, workspaceId);
  if (!status) return false;
  // Remove the entry before repairing D1, so no attempt can claim the row we hand back.
  if (entry) await removeEntry();
  const restored =
    status === 'stopping' &&
    (await restoreWakeableSleepingInstant(env.DATABASE, workspaceId, new Date().toISOString()));
  log.warn('node_lifecycle.workspace_deletion_wake_target_kept', {
    workspaceId,
    nodeId: entry?.nodeId ?? null,
    status,
    restoredToSleeping: restored,
    attemptCount: entry?.attemptCount ?? 0,
    action: entry ? 'automatic_entry_removed' : 'not_scheduled',
  });
  return true;
}
