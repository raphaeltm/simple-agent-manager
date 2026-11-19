/**
 * Termination-proof writers for managed nodes. Split out of `strict-node-deletion.ts` (rule 18).
 *
 * A proof (`nodes.runtime_termination_confirmed_at`) is either strict (SAM saw the provider
 * delete it, or confirmed it never existed) or attested (a person said the server is gone).
 * Attested proof sets `runtime_termination_attested_at` to the same value in the same CAS, so no
 * reader can see the proof without its provenance (`isOwnerAttestedTermination`). Two people can
 * attest: the node's owner for their own cloud account (`services/node-manual-deletion.ts`) and a
 * superadmin for SAM's own capacity (`services/node-operator-deletion.ts`). Who attested is
 * recorded in the removal audit (`node_health_events`), not on the node row.
 */
import { type SQL, and, eq, sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import {
  exactNodeIncarnationPredicate,
  type NodeDb,
  type NodeRow,
  requireSameNodeIncarnation,
} from './strict-node-deletion-shared';

export async function markWorkspaceRuntimeTerminationConfirmed(
  db: NodeDb,
  node: NodeRow,
  confirmedAt: string
): Promise<void> {
  await db
    .update(schema.workspaces)
    .set({
      status: 'deleted',
      errorMessage: null,
      runtimeDeletionConfirmedAt: confirmedAt,
      runtimeDeletionProof: 'node_runtime_terminated',
      updatedAt: confirmedAt,
    })
    .where(
      and(
        eq(schema.workspaces.nodeId, node.id),
        eq(schema.workspaces.userId, node.userId),
        sql`EXISTS (
          SELECT 1
            FROM nodes AS proof_node
           WHERE proof_node.id = ${node.id}
             AND proof_node.user_id IS ${node.userId}
             AND proof_node.status IS ${node.status}
             AND proof_node.runtime IS ${node.runtime}
             AND proof_node.provider_instance_id IS ${node.providerInstanceId}
             AND proof_node.runtime_incarnation_id IS ${node.runtimeIncarnationId}
             AND proof_node.runtime_termination_confirmed_at IS ${confirmedAt}
        )`
      )
    );
}

export async function markRuntimeTerminationConfirmed(
  db: NodeDb,
  node: NodeRow,
  provenance: 'strict' | 'attested' = 'strict',
  /** Extra conditions the final CAS must also hold (the operator path's admission guard). */
  admission?: SQL
): Promise<string> {
  await requireSameNodeIncarnation(db, node, 'termination proof write');
  const confirmedAt = new Date().toISOString();
  const result = await db
    .update(schema.nodes)
    .set({
      runtimeTerminationConfirmedAt: confirmedAt,
      // Written in the same CAS as the proof, so a reader can never see the proof
      // without its provenance. See `isOwnerAttestedTermination`.
      runtimeTerminationAttestedAt: provenance === 'attested' ? confirmedAt : null,
      // The deletion this record tracked is now proven; nothing is in flight any more.
      providerDeletionRequestedAt: null,
      providerDeletionJson: null,
    })
    .where(admission ? and(exactNodeIncarnationPredicate(node), admission) : exactNodeIncarnationPredicate(node))
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new Error(`Strict node deletion proof CAS failed: node=${node.id}`);
  }
  await requireSameNodeIncarnation(
    db,
    { ...node, runtimeTerminationConfirmedAt: confirmedAt },
    'termination proof verification'
  );
  await markWorkspaceRuntimeTerminationConfirmed(db, node, confirmedAt);
  return confirmedAt;
}

/**
 * The owner states they deleted the server at their provider after SAM's strict
 * teardown could not. Writes the same proof markers as a strict delete, fenced on
 * the exact incarnation the caller loaded, so every proof reader and the shared
 * removal tail treat the node uniformly. Callers must first refuse when the
 * provider positively reports the server still exists (`services/node-manual-deletion.ts`).
 */
export async function recordOwnerAttestedRuntimeTermination(
  db: NodeDb,
  node: NodeRow
): Promise<string> {
  return await markRuntimeTerminationConfirmed(db, node, 'attested');
}

/**
 * True when the node's current termination proof is the owner's attestation, not
 * SAM's strict deletion. Keyed on equality with the proof itself, so any later
 * writer that replaces or clears the proof (re-provisioning, a strict delete,
 * container recovery) ends the attestation without having to know about it.
 */
export function isOwnerAttestedTermination(
  node: Pick<NodeRow, 'runtimeTerminationConfirmedAt' | 'runtimeTerminationAttestedAt'>
): boolean {
  return (
    node.runtimeTerminationConfirmedAt !== null &&
    node.runtimeTerminationAttestedAt === node.runtimeTerminationConfirmedAt
  );
}
