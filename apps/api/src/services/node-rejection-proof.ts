/** Exact, durable absence proof for a provider create that rejected before allocation. */
import { and, eq, sql } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { createProviderForUser } from './provider-credentials';

type Node = typeof schema.nodes.$inferSelect;
type Db = ReturnType<typeof drizzle<typeof schema>>;
type ResolvedProvider = NonNullable<Awaited<ReturnType<typeof createProviderForUser>>>;

export function rejectedAllocationPlacementPredicate(node: Node, provider: ResolvedProvider) {
  const binding = provider.exactCredentialBinding;
  return and(
    sql`${schema.nodes.cloudProvider} IS ${provider.providerName}`,
    sql`${schema.nodes.nodeRole} IS ${node.nodeRole}`,
    sql`${schema.nodes.workloadRole} IS ${node.workloadRole}`,
    sql`${schema.nodes.vmSize} IS ${node.vmSize}`,
    sql`${schema.nodes.vmLocation} IS ${node.vmLocation}`,
    sql`${schema.nodes.providerInstanceType} IS ${node.providerInstanceType}`,
    sql`${schema.nodes.capacityPoolId} IS ${node.capacityPoolId}`,
    sql`${schema.nodes.capacityPoolScope} IS ${node.capacityPoolScope}`,
    sql`${schema.nodes.capacityPoolProjectId} IS ${node.capacityPoolProjectId}`,
    sql`${schema.nodes.capacityPoolRevision} IS ${node.capacityPoolRevision}`,
    sql`${schema.nodes.capacitySourceId} IS ${node.capacitySourceId}`,
    sql`${schema.nodes.capacitySourceGeneration} IS ${node.capacitySourceGeneration}`,
    sql`${schema.nodes.capacityPoolCandidateId} IS ${node.capacityPoolCandidateId}`,
    sql`${schema.nodes.placementCredentialSource} IS ${binding?.credentialSource ?? node.placementCredentialSource}`,
    sql`${schema.nodes.placementCredentialReference} IS ${binding?.credentialReference ?? node.placementCredentialReference}`,
    sql`${schema.nodes.placementCredentialVersion} IS ${binding?.credentialVersion ?? node.placementCredentialVersion}`,
    sql`${schema.nodes.placementCredentialFingerprint} IS ${binding?.credentialFingerprint ?? node.placementCredentialFingerprint}`
  );
}

export async function recordRejectedAllocationAbsence(
  db: Db,
  node: Node,
  provider: ResolvedProvider,
  runtimeIncarnationId: string | null
) {
  const proofAt = new Date().toISOString();
  const placementPredicate = rejectedAllocationPlacementPredicate(node, provider);
  // Missing provider ID alone is ambiguous. A definite rejection can prove
  // absence only while the original incarnation and placement still own the row.
  const write = await db
    .update(schema.nodes)
    .set({ runtimeTerminationConfirmedAt: proofAt })
    .where(
      and(
        eq(schema.nodes.id, node.id),
        eq(schema.nodes.userId, node.userId),
        eq(schema.nodes.runtime, 'vm'),
        eq(schema.nodes.nodeClass, 'managed'),
        sql`${schema.nodes.status} IN ('creating', 'destroying')`,
        sql`${schema.nodes.providerInstanceId} IS NULL`,
        sql`${schema.nodes.runtimeTerminationConfirmedAt} IS NULL`,
        sql`${schema.nodes.runtimeIncarnationId} IS ${runtimeIncarnationId}`,
        placementPredicate
      )
    )
    .run();
  return (write.meta.changes ?? 0) === 1 ? { proofAt, placementPredicate } : null;
}
