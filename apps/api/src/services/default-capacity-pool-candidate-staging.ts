import { and, eq, getTableColumns, sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import { nextCapacityPoolTimestamp } from './capacity-pool-clock';
import { capacityCandidateBaseId } from './capacity-pool-workload-roles';
import type {
  Db,
  EnsureCandidatesForSourceOptions,
} from './default-capacity-pool-candidates-common';
import {
  candidateNeedsUpdatePredicate,
  catalogSourceReplacementGuard,
} from './default-capacity-pool-candidates-statements';
import { capacityPoolSelectionDigest } from './default-capacity-pool-summaries';
import type { PoolPublicationGuard } from './default-capacity-pool-types';

/** Each batch is private until a complete, fenced replacement can commit in one transaction. */
export async function stageCandidateValues(
  db: Db,
  values: schema.NewCapacityPoolCandidate[],
  digest: string,
  offset: number,
  options: EnsureCandidatesForSourceOptions
): Promise<number> {
  if (values.length === 0) return 0;
  const results = await db.$client.batch(
    values.map((value, index) => {
      const query = db
        .run(
          sql`INSERT INTO capacity_pool_candidate_staging
      (id, pool_id, capacity_source_id, digest, ordinal, generation, payload)
      SELECT ${value.id}, ${value.poolId}, ${value.capacitySourceId}, ${digest}, ${offset + index},
        ${options.sourceGeneration ?? 0}, ${JSON.stringify({ ...value, primaryId: capacityCandidateBaseId(value.id) })}
      WHERE ${sourceFence(value.capacitySourceId, options)}
      ON CONFLICT(id) DO UPDATE SET digest = excluded.digest, ordinal = excluded.ordinal,
        generation = excluded.generation, payload = excluded.payload
      WHERE capacity_pool_candidate_staging.generation <= excluded.generation`
        )
        .getQuery();
      return db.$client.prepare(query.sql).bind(...query.params);
    })
  );
  const failed = results.findIndex((result) => result.meta.changes !== 1);
  return failed < 0 ? values.length : failed;
}

function sourceFence(sourceId: string, options: EnsureCandidatesForSourceOptions) {
  return options.sourceGeneration === undefined
    ? sql`1 = 1`
    : sql`EXISTS (
    SELECT 1 FROM capacity_sources WHERE id = ${sourceId}
      AND source_generation = ${options.sourceGeneration} AND status = 'active'
  )`;
}

/**
 * Two bulk INSERT SELECTs (primary before coupled membership), missing cleanup, and staging
 * deletion commit atomically. No per-row external calls or unbounded statement batch at promotion.
 * Live membership and operator configuration win even if edited while staging was in flight.
 */
export async function promoteStagedCandidates(
  db: Db,
  poolId: string,
  sourceId: string,
  digest: string,
  count: number,
  options: EnsureCandidatesForSourceOptions
): Promise<{ promoted: boolean; poolPublicationGuard?: PoolPublicationGuard }> {
  if (!(options.catalogValidated ?? options.catalogComplete !== false)) return { promoted: false };
  // Read the guard before the candidate projection. A concurrent editor/publisher must
  // invalidate the entire transaction, including the revision that fences paid allocations.
  const [pool] = await db
    .select()
    .from(schema.capacityPools)
    .where(eq(schema.capacityPools.id, poolId))
    .limit(1);
  if (!pool) return { promoted: false };
  const expected = options.poolPublicationGuard ?? pool;
  if (
    pool.revision !== expected.revision ||
    pool.updatedAt !== expected.updatedAt ||
    pool.status !== expected.status
  )
    return { promoted: false };

  const live = await db
    .select({
      candidateId: schema.capacityPoolCandidates.id,
      capacitySourceId: schema.capacityPoolCandidates.capacitySourceId,
      sourceStatus: schema.capacitySources.status,
      sourceAuthorityGeneration: schema.capacitySources.authorityGeneration,
      candidateStatus: schema.capacityPoolCandidates.status,
      candidateAuthorityGeneration: schema.capacityPoolCandidates.authorityGeneration,
      catalogAvailability: schema.capacityPoolCandidates.catalogAvailability,
      providerInstanceCatalogSource: schema.capacityPoolCandidates.providerInstanceCatalogSource,
    })
    .from(schema.capacityPoolCandidates)
    .innerJoin(
      schema.capacitySources,
      eq(schema.capacityPoolCandidates.capacitySourceId, schema.capacitySources.id)
    )
    .where(eq(schema.capacityPoolCandidates.poolId, poolId));
  const replacements = await db
    .select({
      id: schema.capacityPoolCandidateStaging.id,
      workloadRole: sql<string>`json_extract(${schema.capacityPoolCandidateStaging.payload}, '$.workloadRole')`,
      status: sql<string>`json_extract(${schema.capacityPoolCandidateStaging.payload}, '$.status')`,
      authorityGeneration: sql<number>`json_extract(${schema.capacityPoolCandidateStaging.payload}, '$.authorityGeneration')`,
      providerInstanceCatalogSource: sql<
        string | null
      >`json_extract(${schema.capacityPoolCandidateStaging.payload}, '$.providerInstanceCatalogSource')`,
    })
    .from(schema.capacityPoolCandidateStaging)
    .where(
      and(
        eq(schema.capacityPoolCandidateStaging.poolId, poolId),
        eq(schema.capacityPoolCandidateStaging.capacitySourceId, sourceId),
        eq(schema.capacityPoolCandidateStaging.digest, digest)
      )
    );
  const [source] = await db
    .select()
    .from(schema.capacitySources)
    .where(eq(schema.capacitySources.id, sourceId))
    .limit(1);
  if (!source || replacements.length !== count) return { promoted: false };
  const liveById = new Map(live.map((row) => [row.candidateId, row]));
  const replacementById = new Map(replacements.map((row) => [row.id, row]));
  const next = new Map(
    live.map((row) => [
      row.candidateId,
      {
        ...row,
        catalogAvailability:
          row.capacitySourceId === sourceId &&
          !replacementById.has(row.candidateId) &&
          options.catalogComplete !== false
            ? 'last-known-unavailable'
            : row.catalogAvailability,
      },
    ])
  );
  for (const row of replacements) {
    const persisted = liveById.get(row.id);
    // A trusted reference catalog can add known offerings without proving an exhaustive
    // inventory. It must still preserve stronger API metadata and API-confirmed absence.
    if (
      options.catalogComplete === false &&
      persisted &&
      catalogSourcePriority(persisted.providerInstanceCatalogSource) >
        catalogSourcePriority(row.providerInstanceCatalogSource)
    )
      continue;
    const primaryId = capacityCandidateBaseId(row.id);
    // Mirror exactly the membership read by the two INSERT SELECTs below, including
    // a primary row that is first inserted by this same atomic publication.
    const primaryStatus =
      liveById.get(primaryId)?.candidateStatus ??
      replacementById.get(primaryId)?.status ??
      'disabled';
    const candidateStatus =
      row.workloadRole === 'deployment'
        ? primaryStatus
        : (liveById.get(row.id)?.candidateStatus ?? row.status ?? 'disabled');
    next.set(row.id, {
      candidateId: row.id,
      capacitySourceId: sourceId,
      sourceStatus: source.status,
      sourceAuthorityGeneration: source.authorityGeneration,
      candidateStatus,
      candidateAuthorityGeneration: row.authorityGeneration ?? 0,
      catalogAvailability: 'available',
      providerInstanceCatalogSource: row.providerInstanceCatalogSource ?? null,
    });
  }
  const selectionDigest = capacityPoolSelectionDigest(
    [...next.values()].sort((left, right) =>
      left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0
    )
  );
  const selectionChanged =
    (pool.selectionDigest != null || pool.configurationState !== 'migration-pending') &&
    pool.selectionDigest !== selectionDigest;
  const revision = pool.revision + (selectionChanged ? 1 : 0);
  const now = nextCapacityPoolTimestamp();
  const fields = Object.entries(getTableColumns(schema.capacityPoolCandidates));
  const column = (name: string) => sql.raw(`"${name}"`);
  const payload = (key: string) => sql.raw(`json_extract(staged.payload, '$.${key}')`);
  const fence = sql`${sourceFence(sourceId, options)} AND (
    SELECT COUNT(*) FROM capacity_pool_candidate_staging
    WHERE pool_id = ${poolId} AND capacity_source_id = ${sourceId} AND digest = ${digest}
  ) = ${count}`;
  // A native-config edit invalidates the staged proof. Resume with the new digest instead of
  // certifying a candidate authority hash computed for the old config.
  const nativeFence = sql`NOT EXISTS (
    SELECT 1 FROM capacity_pool_candidate_staging staged
    JOIN capacity_pool_candidates live ON live.id = staged.id
    WHERE staged.pool_id = ${poolId} AND staged.capacity_source_id = ${sourceId}
      AND staged.digest = ${digest} AND (
        live.provider_instance_boot_disk_size_gb IS NOT json_extract(staged.payload, '$.providerInstanceBootDiskSizeGb')
        OR live.provider_instance_image IS NOT json_extract(staged.payload, '$.providerInstanceImage')
        OR live.provider_instance_architecture IS NOT json_extract(staged.payload, '$.providerInstanceArchitecture')
      )
  )`;
  const preserved = new Set([
    'id',
    'pool_id',
    'capacity_source_id',
    'created_at',
    'status',
    'provider_instance_boot_disk_size_gb',
    'provider_instance_image',
    'provider_instance_architecture',
    'priority',
    'candidate_order',
  ]);
  const assignments = fields
    .filter(([, field]) => !preserved.has(field.name))
    .map(([, field]) => sql`${column(field.name)} = excluded.${column(field.name)}`);
  const poolFence = sql`EXISTS (SELECT 1 FROM capacity_pools WHERE id = ${poolId}
    AND revision = ${revision} AND updated_at = ${now} AND status = ${expected.status}
    AND selection_digest = ${selectionDigest})`;
  const queries = [
    sql`UPDATE capacity_pools SET revision = ${revision},
    selection_digest = ${selectionDigest}, updated_at = ${now}
    WHERE id = ${poolId} AND revision = ${expected.revision}
      AND updated_at = ${expected.updatedAt} AND status = ${expected.status}
      AND ${fence} AND ${nativeFence}
    RETURNING revision, updated_at AS updatedAt, status`,
  ];
  queries.push(
    ...['workspace', 'deployment'].map((role) => {
      const values = fields.map(([key]) => {
        if (key === 'catalogGeneration') return sql`${options.sourceGeneration ?? 0}`;
        if (key === 'status')
          return role === 'workspace'
            ? sql`COALESCE((SELECT status FROM capacity_pool_candidates WHERE id = staged.id), ${payload(key)})`
            : sql`COALESCE((SELECT status FROM capacity_pool_candidates
            WHERE id = json_extract(staged.payload, '$.primaryId')), 'disabled')`;
        return payload(key);
      });
      return sql`INSERT INTO capacity_pool_candidates (${sql.join(
        fields.map(([, field]) => column(field.name)),
        sql`, `
      )})
      SELECT ${sql.join(values, sql`, `)} FROM capacity_pool_candidate_staging staged
      WHERE staged.pool_id = ${poolId} AND staged.capacity_source_id = ${sourceId}
        AND staged.digest = ${digest} AND json_extract(staged.payload, '$.workloadRole') = ${role}
        AND ${fence} AND ${nativeFence} AND ${poolFence}
      ON CONFLICT(id) DO UPDATE SET ${sql.join(assignments, sql`, `)},
        status = CASE WHEN excluded.workload_role = 'deployment' THEN excluded.status ELSE capacity_pool_candidates.status END
        WHERE ${catalogSourceReplacementGuard(options.catalogComplete)}
          AND ${candidateNeedsUpdatePredicate(sql`excluded.status`)}`;
    })
  );
  if (options.catalogComplete !== false)
    queries.push(sql`UPDATE capacity_pool_candidates
    SET catalog_availability = 'last-known-unavailable', catalog_unavailable_at = ${now}, updated_at = ${now}
    WHERE pool_id = ${poolId} AND capacity_source_id = ${sourceId} AND ${fence} AND ${nativeFence} AND ${poolFence}
      AND NOT EXISTS (SELECT 1 FROM capacity_pool_candidate_staging staged
        WHERE staged.id = capacity_pool_candidates.id AND staged.digest = ${digest}
          AND staged.pool_id = ${poolId} AND staged.capacity_source_id = ${sourceId})`);
  queries.push(sql`DELETE FROM capacity_pool_candidate_staging WHERE pool_id = ${poolId}
    AND capacity_source_id = ${sourceId} AND digest <> ${digest} AND ${fence} AND ${nativeFence} AND ${poolFence}`);
  const compiled = queries.map((query) => db.run(query).getQuery());
  const results = await db.$client.batch(
    compiled.map((query) => db.$client.prepare(query.sql).bind(...query.params))
  );
  // Only our CAS result is adoptable. A re-read could accidentally certify a newer publisher.
  const ownGuard = results[0]?.results?.[0] as PoolPublicationGuard | undefined;
  return ownGuard ? { promoted: true, poolPublicationGuard: ownGuard } : { promoted: false };
}

function catalogSourcePriority(source: string | null): number {
  return source === 'api' ? 2 : source === 'static' ? 1 : 0;
}
