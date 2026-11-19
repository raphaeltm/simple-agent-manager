import { isUserOwnedNodeClass } from '@simple-agent-manager/shared';

import type { Node } from '../db/schema';
import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';
import type { DeleteNodeResourcesResult } from './node-resource-deletion';

/** The audited removal reasons, and the event each is recorded under. */
const NODE_REMOVAL_AUDIT_EVENTS: Record<string, string> = {
  owner_requested_node_deletion: 'deleted_by_owner',
  owner_attested_manual_deletion: 'deleted_by_owner',
  // A superadmin attested that a SAM-capacity node's server is gone (`node-operator-deletion.ts`).
  // A distinct event, so nothing that trusts an owner's removal reads it as one.
  operator_attested_manual_deletion: 'deleted_by_operator',
};
const ATTESTED_REMOVAL_REASONS = new Set([
  'owner_attested_manual_deletion',
  'operator_attested_manual_deletion',
]);

/** Persist consumed proof while the node still makes retries possible.
 * Fence the insert itself: stale proof must not create a strict audit even when
 * the later removal CAS would reject it. Orphan recovery also requires absence
 * of the node, so this audit alone never authorizes cleanup.
 */
export async function recordOwnerNodeDeletionAudit(
  env: Env,
  node: Pick<Node, 'id' | 'nodeClass' | 'lastHeartbeatAt' | 'createdAt'>,
  userId: string,
  cleanup: DeleteNodeResourcesResult,
  reason: string
): Promise<void> {
  const event = NODE_REMOVAL_AUDIT_EVENTS[reason];
  if (!event) {
    throw errors.conflict('Unknown owner node deletion audit reason');
  }
  const attested = ATTESTED_REMOVAL_REASONS.has(reason);
  const userOwned = isUserOwnedNodeClass(node.nodeClass);
  if (userOwned && attested) {
    throw errors.conflict('Registered machines cannot use manual deletion attestation');
  }
  if (!userOwned && !cleanup.runtimeTerminationConfirmedAt) {
    throw errors.conflict('Managed node deletion proof is unavailable');
  }
  const result = await env.DATABASE.prepare(
    `INSERT INTO node_health_events
     (id, node_id, episode_started_at, event, reason, created_at)
     SELECT ?, n.id, ?, ?, ?, ?
     FROM nodes n WHERE n.id=? AND n.user_id=? AND n.node_class IS ?
       AND (? OR (n.runtime_termination_confirmed_at IS ?
         AND n.runtime_incarnation_id IS ?))
       AND ((? = 0 AND
           (n.runtime_termination_attested_at IS NULL OR
            n.runtime_termination_attested_at IS NOT n.runtime_termination_confirmed_at))
         OR (? = 1 AND
             n.runtime_termination_confirmed_at IS NOT NULL AND
             n.runtime_termination_attested_at IS n.runtime_termination_confirmed_at))
     ON CONFLICT(node_id, episode_started_at, event, reason)
     DO UPDATE SET id=node_health_events.id`
  )
    .bind(
      ulid(),
      node.lastHeartbeatAt ?? node.createdAt,
      event,
      reason,
      new Date().toISOString(),
      node.id,
      userId,
      node.nodeClass,
      userOwned ? 1 : 0,
      cleanup.runtimeTerminationConfirmedAt,
      cleanup.runtimeIncarnationId,
      attested ? 1 : 0,
      attested ? 1 : 0
    )
    .run();
  // Existing events retain their timestamp; the same statement must still
  // observe the exact proof before its conflict handler can report success.
  if ((result.meta.changes ?? 0) < 1) {
    throw errors.conflict('Node incarnation changed before deletion audit');
  }
}
