import { and, eq, getTableColumns, type SQL,sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

import * as schema from '../db/schema';
import {
  capacityCandidateAuthorityGeneration,
  capacitySourceAuthorityGeneration,
} from './capacity-pool-authority';
import { nextCapacityPoolTimestamp } from './capacity-pool-clock';
import { DEFAULT_CAPACITY_POOL_CANDIDATE_PUBLISH_BATCH_SIZE } from './default-capacity-pool-candidates-common';
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
  seedSnapshotGeneration: number,
  publishBatchSize = DEFAULT_CAPACITY_POOL_CANDIDATE_PUBLISH_BATCH_SIZE
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

  // Only certify the canonical publication this caller finished, never a newer
  // publisher whose candidate batches may still be in flight.
  if (
    !guard.sourceGenerations?.some(
      (source) => source.id === canonicalId && source.generation === canonical.sourceGeneration
    )
  )
    return null;

  const sourceFence = sql`EXISTS (SELECT 1 FROM capacity_sources
      WHERE id = ${canonicalId} AND status = 'active' AND source_generation = ${canonical.sourceGeneration})
    AND EXISTS (SELECT 1 FROM capacity_sources
      WHERE id = ${mirrorId} AND status = 'active' AND source_generation = ${duplicate.sourceGeneration})
    AND EXISTS (SELECT 1 FROM (${managedGcpCredentialMirrorsQuery(scope.ownerUserId)}) AS pair
      WHERE pair.legacyId = ${mirror.legacyId} AND pair.credentialId = ${mirror.credentialId}
        AND pair.attachmentId = ${mirror.attachmentId})`;
  const allOfferingsMatch = sql`NOT EXISTS (SELECT 1 FROM capacity_pool_candidates AS old
      WHERE old.pool_id = ${poolId} AND old.capacity_source_id = ${mirrorId} AND old.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM capacity_pool_candidates AS current
          WHERE current.pool_id = old.pool_id AND current.capacity_source_id = ${canonicalId}
            AND ${sameOffering('old', 'current')}))`;
  // One linear, ordered snapshot comparison fences inserts and every candidate field.
  // It is evaluated only when acquiring the repair lease, never once per updated row.
  const snapshotQuery = sql`SELECT json_group_array(json(row_snapshot)) AS snapshot FROM (
    SELECT json_array(${sql.join(
      Object.values(getTableColumns(schema.capacityPoolCandidates)).map((column) =>
        sql.identifier(column.name)
      ),
      sql`, `
    )}) AS row_snapshot
    FROM capacity_pool_candidates WHERE pool_id = ${poolId}
      AND capacity_source_id IN (${canonicalId}, ${mirrorId}) ORDER BY id)`;
  const snapshot = await db.get<{ snapshot: string }>(snapshotQuery);
  const old = alias(schema.capacityPoolCandidates, 'old');
  const pairs = await db
    .select({ current: schema.capacityPoolCandidates, old })
    .from(schema.capacityPoolCandidates)
    .innerJoin(
      old,
      and(
        eq(old.poolId, poolId),
        eq(old.capacitySourceId, mirrorId),
        sameOffering('old', 'capacity_pool_candidates')
      )
    )
    .where(
      and(
        eq(schema.capacityPoolCandidates.poolId, poolId),
        eq(schema.capacityPoolCandidates.capacitySourceId, canonicalId)
      )
    );
  const retire = await db.get<{ matched: number }>(sql`SELECT ${allOfferingsMatch} AS matched`);
  const canonicalUpdates = new Map<string, { id: string; authorityGeneration: number }>();
  const mirrorUpdates = new Map<string, Record<string, string | number | null>>();
  for (const pair of pairs) {
    if (retire?.matched && pair.old.status === 'active') {
      const authorityGeneration = capacityCandidateAuthorityGeneration({
        ...pair.current,
        sourceAuthorityGeneration: canonical.authorityGeneration,
        status: 'active',
      });
      if (
        pair.current.status !== 'active' ||
        pair.current.authorityGeneration !== authorityGeneration
      )
        canonicalUpdates.set(pair.current.id, { id: pair.current.id, authorityGeneration });
    }
    const catalog = Object.fromEntries(CATALOG_FIELDS.map((field) => [field, pair.current[field]]));
    const refreshed = { ...pair.old, ...catalog } as schema.CapacityPoolCandidate;
    const authorityGeneration = capacityCandidateAuthorityGeneration({
      ...refreshed,
      sourceAuthorityGeneration: duplicate.authorityGeneration,
    });
    // Timestamp-only refreshes do not change selection authority or bump pool revisions.
    if (
      pair.old.authorityGeneration !== authorityGeneration ||
      CATALOG_SEMANTIC_FIELDS.some((field) => pair.old[field] !== pair.current[field])
    ) {
      mirrorUpdates.set(pair.old.id, { id: pair.old.id, ...catalog, authorityGeneration });
    }
  }
  if (!retire?.matched && canonicalUpdates.size === 0 && mirrorUpdates.size === 0) return null;
  const now = nextCapacityPoolTimestamp();
  const revision = guard.revision + 1;
  const generation = await nextCapacityPoolScopeGeneration(db, scope);
  const status = retire?.matched ? 'disabled' : 'active';
  const authorityGeneration =
    status === 'active'
      ? duplicate.authorityGeneration
      : capacitySourceAuthorityGeneration({
          ...duplicate,
          scope: 'user',
          sourceKind: 'cloud-provider-credential',
          credentialSource: 'user',
          status,
        });
  const leaseFence = sql`EXISTS (SELECT 1 FROM capacity_sources
    WHERE id = ${mirrorId} AND status = 'active' AND source_generation = ${generation})`;
  const chunkSize = Math.max(1, Math.floor(publishBatchSize));
  const candidateStatements = [
    ...candidateUpdateChunks(
      db,
      [...canonicalUpdates.values()],
      chunkSize,
      { status: 'active', updatedAt: now },
      ['authorityGeneration'],
      leaseFence
    ),
    ...candidateUpdateChunks(
      db,
      [...mirrorUpdates.values()],
      chunkSize,
      { updatedAt: now },
      [...CATALOG_FIELDS, 'authorityGeneration'],
      leaseFence
    ),
  ];
  const results = await db.batch([
    // A unique source generation is the transaction's lease. A failed snapshot/pool CAS
    // makes every subsequent statement a no-op, even on equal timestamps across isolates.
    db
      .update(schema.capacitySources)
      .set({ sourceGeneration: generation, updatedAt: now })
      .where(
        and(
          eq(schema.capacitySources.id, mirrorId),
          sourceFence,
          sql`(${snapshotQuery}) = ${snapshot?.snapshot ?? '[]'}`,
          sql`EXISTS (SELECT 1 FROM capacity_pools WHERE id = ${poolId}
        AND revision = ${guard.revision} AND updated_at = ${guard.updatedAt} AND status = ${guard.status})`
        )
      ),
    db
      .update(schema.capacityPools)
      .set({ revision, updatedAt: now })
      .where(and(eq(schema.capacityPools.id, poolId), leaseFence)),
    ...candidateStatements,
    db
      .update(schema.capacitySources)
      .set({ status, authorityGeneration })
      .where(and(eq(schema.capacitySources.id, mirrorId), leaseFence)),
  ]);
  if ((results[0] as D1Result).meta.changes !== 1) return null;
  return {
    ...guard,
    revision,
    updatedAt: now,
    sourceGenerations: [
      ...(guard.sourceGenerations ?? []).filter((source) => source.id !== mirrorId),
      { id: mirrorId, generation, status },
    ],
  };
}

// Catalog fields only: identity, overrides, membership, ordering and historical IDs stay intact.
const CATALOG_SEMANTIC_FIELDS = [
  'providerInstanceDisplayName',
  'providerInstanceVcpuCount',
  'providerInstanceMemoryMb',
  'providerInstanceDiskGb',
  'providerInstancePriceDisplay',
  'providerInstancePriceCurrency',
  'providerInstancePriceMonthlyCents',
  'providerInstancePriceHourlyMicros',
  'providerInstanceCatalogSource',
  'catalogAvailability',
] as const;
const CATALOG_FIELDS = [
  ...CATALOG_SEMANTIC_FIELDS,
  'providerInstanceCatalogLastSeenAt',
  'catalogUnavailableAt',
  'catalogReturnedAt',
] as const;

/** Build bounded authority/catalog payloads; all chunks execute under one atomic repair lease. */
function candidateUpdateChunks(
  db: Db,
  values: Array<Record<string, string | number | null>>,
  chunkSize: number,
  fixed: Partial<schema.NewCapacityPoolCandidate>,
  fields: ReadonlyArray<keyof schema.NewCapacityPoolCandidate>,
  fence: SQL
) {
  const statements = [];
  for (let offset = 0; offset < values.length; offset += chunkSize) {
    const payload = JSON.stringify(values.slice(offset, offset + chunkSize));
    const assignments: Record<string, SQL | string | number | null | undefined> = { ...fixed };
    for (const field of fields) {
      assignments[field] =
        sql`(SELECT json_extract(value, ${`$.${field}`}) FROM json_each(${payload})
        WHERE json_extract(value, '$.id') = capacity_pool_candidates.id)`;
    }
    statements.push(
      db
        .update(schema.capacityPoolCandidates)
        .set(assignments)
        .where(
          and(
            sql`${schema.capacityPoolCandidates.id} IN (SELECT json_extract(value, '$.id') FROM json_each(${payload}))`,
            fence
          )
        )
    );
  }
  return statements;
}
