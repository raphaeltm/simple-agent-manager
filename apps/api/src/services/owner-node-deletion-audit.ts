import { isUserOwnedNodeClass } from '@simple-agent-manager/shared';

import type { Node } from '../db/schema';
import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';
import type { DeleteNodeResourcesResult } from './node-resource-deletion';

/** Persist consumed proof while the node still makes retries possible.
 * Fence the insert itself: stale proof must not create a strict audit even when
 * the later removal CAS would reject it. Orphan recovery also requires absence
 * of the node, so this audit alone never authorizes cleanup.
 */
export async function recordOwnerNodeDeletionAudit(
  env: Env,
  node: Pick<Node, 'id' | 'nodeClass' | 'lastHeartbeatAt' | 'createdAt'>,
  userId: string,
  cleanup: DeleteNodeResourcesResult
): Promise<void> {
  const userOwned = isUserOwnedNodeClass(node.nodeClass);
  if (!userOwned && !cleanup.runtimeTerminationConfirmedAt) {
    throw errors.conflict('Managed node deletion proof is unavailable');
  }
  const result = await env.DATABASE.prepare(
    `INSERT INTO node_health_events
     (id, node_id, episode_started_at, event, reason, created_at)
     SELECT ?, n.id, ?, 'deleted_by_owner', 'owner_requested_node_deletion', ?
     FROM nodes n WHERE n.id=? AND n.user_id=? AND n.node_class IS ?
       AND (? OR (n.runtime_termination_confirmed_at IS ?
         AND n.runtime_incarnation_id IS ?))
     ON CONFLICT(node_id, episode_started_at, event, reason)
     DO UPDATE SET id=node_health_events.id`
  )
    .bind(
      ulid(),
      node.lastHeartbeatAt ?? node.createdAt,
      new Date().toISOString(),
      node.id,
      userId,
      node.nodeClass,
      userOwned ? 1 : 0,
      cleanup.runtimeTerminationConfirmedAt,
      cleanup.runtimeIncarnationId
    )
    .run();
  // Existing events retain their timestamp; the same statement must still
  // observe the exact proof before its conflict handler can report success.
  if ((result.meta.changes ?? 0) < 1) {
    throw errors.conflict('Node incarnation changed before deletion audit');
  }
}
