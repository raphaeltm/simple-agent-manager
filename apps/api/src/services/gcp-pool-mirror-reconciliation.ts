import { and, eq, sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import {
  capacityCandidateAuthorityGeneration,
  capacitySourceAuthorityGeneration,
} from './capacity-pool-authority';
import { nextCapacityPoolTimestamp } from './capacity-pool-clock';
import {
  composableAttachmentReference,
  defaultCapacitySourceId,
} from './default-capacity-pool-helpers';
import { nextCapacityPoolScopeGeneration } from './default-capacity-pool-storage';
import type { Db, PoolPublicationGuard, ScopeIdentity } from './default-capacity-pool-types';
import {
  type ManagedGcpCredentialMirror,
  managedGcpCredentialMirrorsQuery,
} from './gcp-credential-mirrors';

/** Match actual placement identity, including operator overrides, not just the displayed SKU. */
function sameOffering(left: string, right: string) {
  const fields = [
    'provider',
    'location',
    'workload_role',
    'runtime',
    'machine_class',
    'machine_size',
    'provider_instance_type',
    'provider_instance_sku',
    'provider_instance_boot_disk_size_gb',
    'provider_instance_image',
    'provider_instance_architecture',
  ];
  return sql.join(
    fields.map(
      (field) =>
        sql`${sql.identifier(left)}.${sql.identifier(field)} IS ${sql.identifier(right)}.${sql.identifier(field)}`
    ),
    sql` AND `
  );
}

/**
 * Preserve the union of previously allowed offerings and retire the duplicate atomically.
 * Keep every historical source/candidate/anchor ID: running work can still reference them.
 * An unmatched selected offering or a concurrent edit defers repair instead of losing intent.
 */
export async function reconcileManagedGcpPoolMirror(
  db: Db,
  scope: ScopeIdentity,
  poolId: string,
  guard: PoolPublicationGuard,
  mirror: ManagedGcpCredentialMirror,
  seedSnapshotGeneration: number
): Promise<PoolPublicationGuard | null> {
  if (scope.scope !== 'user' || !scope.ownerUserId) return null;
  const canonicalId = defaultCapacitySourceId({
    scope: 'user',
    credentialId: mirror.legacyId,
    platformCredentialId: null,
  });
  const mirrorId = defaultCapacitySourceId({
    scope: 'user',
    credentialId: null,
    platformCredentialId: null,
    externalSourceRef: composableAttachmentReference(mirror.attachmentId),
  });
  const sources = await db
    .select()
    .from(schema.capacitySources)
    .where(sql`${schema.capacitySources.id} IN (${canonicalId}, ${mirrorId})`);
  const canonical = sources.find((source) => source.id === canonicalId);
  const duplicate = sources.find((source) => source.id === mirrorId);
  if (
    !canonical ||
    !duplicate ||
    canonical.status !== 'active' ||
    duplicate.status !== 'active' ||
    duplicate.sourceGeneration > seedSnapshotGeneration
  )
    return null;

  const sourceFence = sql`EXISTS (SELECT 1 FROM capacity_sources
      WHERE id = ${canonicalId} AND status = 'active' AND source_generation = ${canonical.sourceGeneration})
    AND EXISTS (SELECT 1 FROM capacity_sources
      WHERE id = ${mirrorId} AND status = 'active' AND source_generation = ${duplicate.sourceGeneration})
    AND EXISTS (SELECT 1 FROM (${managedGcpCredentialMirrorsQuery(scope.ownerUserId)}) AS pair
      WHERE pair.legacyId = ${mirror.legacyId} AND pair.credentialId = ${mirror.credentialId}
        AND pair.attachmentId = ${mirror.attachmentId})
    AND NOT EXISTS (SELECT 1 FROM capacity_pool_candidates AS old
      WHERE old.pool_id = ${poolId} AND old.capacity_source_id = ${mirrorId} AND old.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM capacity_pool_candidates AS current
          WHERE current.pool_id = old.pool_id AND current.capacity_source_id = ${canonicalId}
            AND ${sameOffering('old', 'current')}))`;
  const fence = sql`${sourceFence} AND EXISTS (SELECT 1 FROM capacity_pools
    WHERE id = ${poolId} AND revision = ${guard.revision} AND updated_at = ${guard.updatedAt})`;
  const now = nextCapacityPoolTimestamp();
  const revision = guard.revision + 1;
  const generation = await nextCapacityPoolScopeGeneration(db, scope);
  const authorityGeneration = capacitySourceAuthorityGeneration({
    ...duplicate,
    scope: 'user',
    sourceKind: 'cloud-provider-credential',
    credentialSource: 'user',
    status: 'disabled',
  });
  const canonicalCandidates = await db
    .select()
    .from(schema.capacityPoolCandidates)
    .where(
      and(
        eq(schema.capacityPoolCandidates.poolId, poolId),
        eq(schema.capacityPoolCandidates.capacitySourceId, canonicalId)
      )
    );
  const candidateAuthorities = JSON.stringify(
    canonicalCandidates.map((candidate) => ({
      id: candidate.id,
      generation: capacityCandidateAuthorityGeneration({
        ...candidate,
        sourceAuthorityGeneration: canonical.authorityGeneration,
        status: 'active',
      }),
    }))
  );
  const results = await db.batch([
    db
      .update(schema.capacityPoolCandidates)
      .set({
        status: 'active',
        updatedAt: now,
        authorityGeneration: sql`(SELECT json_extract(value, '$.generation') FROM json_each(${candidateAuthorities})
        WHERE json_extract(value, '$.id') = capacity_pool_candidates.id)`,
      })
      .where(
        and(
          eq(schema.capacityPoolCandidates.poolId, poolId),
          eq(schema.capacityPoolCandidates.capacitySourceId, canonicalId),
          sql`EXISTS (SELECT 1 FROM capacity_pool_candidates AS old
        WHERE old.pool_id = ${poolId} AND old.capacity_source_id = ${mirrorId} AND old.status = 'active'
          AND ${sameOffering('old', 'capacity_pool_candidates')})`,
          fence
        )
      ),
    db
      .update(schema.capacitySources)
      .set({
        status: 'disabled',
        sourceGeneration: generation,
        authorityGeneration,
        updatedAt: now,
      })
      .where(and(eq(schema.capacitySources.id, mirrorId), fence)),
    // The allocated generation is unique. Only our successful retirement can satisfy this
    // final fence, even if another editor used the same millisecond timestamp.
    db
      .update(schema.capacityPools)
      .set({ revision, updatedAt: now })
      .where(
        and(
          eq(schema.capacityPools.id, poolId),
          eq(schema.capacityPools.revision, guard.revision),
          eq(schema.capacityPools.updatedAt, guard.updatedAt),
          sql`EXISTS (SELECT 1 FROM capacity_sources WHERE id = ${mirrorId}
        AND status = 'disabled' AND source_generation = ${generation})`
        )
      ),
  ]);
  if ((results[1] as D1Result).meta.changes !== 1) return null;
  return {
    ...guard,
    revision,
    updatedAt: now,
    sourceGenerations: [
      ...(guard.sourceGenerations ?? []),
      { id: mirrorId, generation, status: 'disabled' },
    ],
  };
}
