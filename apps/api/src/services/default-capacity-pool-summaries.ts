import type {
  CapacityPoolCandidate as CapacityPoolCandidateDto,
  CapacityPoolConfigurationState,
  CapacityPoolScope,
  CapacitySourceIdentity,
  DefaultCapacityPoolEffectiveState,
  SafeEffectiveCapacityPoolReason,
  SafeEffectiveCapacityPoolSummary,
} from '@simple-agent-manager/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import { nextCapacityPoolTimestamp } from './capacity-pool-clock';
import {
  isEditorVisibleCapacityCandidateRole,
  PRIMARY_CAPACITY_WORKLOAD_ROLE,
} from './capacity-pool-workload-roles';
import {
  toCapacityPool,
  toCapacityPoolCandidate,
  toCapacitySourceIdentity,
} from './capacity-pools';
import {
  ACTIVE_STATUS,
  DISABLED_STATUS,
  poolScopePredicates,
  SOURCE_KIND_CLOUD_PROVIDER,
  sourceScopePredicates,
} from './default-capacity-pool-storage';
import {
  type CapacityPoolSummary,
  type Db,
  type PoolPublicationGuard,
  type ReadDefaultPoolSummaryOptions,
  type ScopeIdentity,
} from './default-capacity-pool-types';

export function toSafeEffectiveCapacityPoolSummary(
  summary: CapacityPoolSummary | null
): SafeEffectiveCapacityPoolSummary {
  if (!summary) {
    return {
      scope: null,
      state: 'unconfigured',
      strategy: null,
      exhaustionPolicy: null,
      availableCandidateCount: 0,
      reason: 'no-capacity-pool-configured',
    };
  }

  const state = summary.effectiveState ?? 'configured-ready';
  return {
    scope: summary.pool.scope,
    state,
    strategy: summary.pool.strategy,
    exhaustionPolicy: summary.pool.exhaustionPolicy,
    availableCandidateCount: summary.availableCandidateCount ?? 0,
    reason: safeEffectiveReasonForState(state),
  };
}

function safeEffectiveReasonForState(
  state: DefaultCapacityPoolEffectiveState
): SafeEffectiveCapacityPoolReason | undefined {
  switch (state) {
    case 'configured-ready':
      return undefined;
    case 'unconfigured':
      return 'no-capacity-pool-configured';
    case 'configured-empty':
      return 'configured-default-pool-has-no-active-candidates';
    case 'source-disabled':
      return 'configured-default-pool-sources-disabled';
    case 'catalog-unavailable':
      return 'configured-default-pool-catalog-last-known-unavailable';
    case 'migration-pending':
      return 'configured-default-pool-migration-pending';
  }
}

export async function findDefaultPool(
  db: Db,
  scope: ScopeIdentity
): Promise<schema.CapacityPool | null> {
  const [pool] = await db
    .select()
    .from(schema.capacityPools)
    .where(and(...poolScopePredicates(scope), eq(schema.capacityPools.isDefault, true)))
    .limit(1);
  return pool ?? null;
}

export interface ReconcileDefaultPoolStatusOptions {
  /**
   * Set by a caller that already published a revision bump for the same change (the atomic
   * pool edit). Reconciliation then RECORDS the new selection digest without bumping again,
   * so one operator edit costs exactly one revision.
   */
  selectionRevisionAlreadyBumped?: boolean;
  publicationComplete?: boolean;
}

export async function reconcileDefaultPoolStatus(
  db: Db,
  poolId: string,
  guard?: PoolPublicationGuard,
  options: ReconcileDefaultPoolStatusOptions = {}
): Promise<void> {
  const [pool] = await db
    .select({
      scope: schema.capacityPools.scope,
      ownerUserId: schema.capacityPools.ownerUserId,
      ownerProjectId: schema.capacityPools.ownerProjectId,
    })
    .from(schema.capacityPools)
    .where(eq(schema.capacityPools.id, poolId))
    .limit(1);
  const sourceRows = pool
    ? await db
        .select({ status: schema.capacitySources.status })
        .from(schema.capacitySources)
        .where(
          and(
            eq(schema.capacitySources.sourceKind, SOURCE_KIND_CLOUD_PROVIDER),
            ...sourceScopePredicates({
              scope: pool.scope as CapacityPoolScope,
              ownerUserId: pool.ownerUserId,
              ownerProjectId: pool.ownerProjectId,
            })
          )
        )
    : [];
  const rows = await db
    .select({
      candidateId: schema.capacityPoolCandidates.id,
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
    .where(eq(schema.capacityPoolCandidates.poolId, poolId))
    .orderBy(asc(schema.capacityPoolCandidates.id));

  const activeSourceCount = sourceRows.filter((row) => row.status === ACTIVE_STATUS).length;
  const activeCandidateCount = rows.filter(
    (row) => row.sourceStatus === ACTIVE_STATUS && row.candidateStatus === ACTIVE_STATUS
  ).length;
  const availableCandidateCount = rows.filter(
    (row) =>
      row.sourceStatus === ACTIVE_STATUS &&
      row.candidateStatus === ACTIVE_STATUS &&
      row.catalogAvailability === 'available' &&
      row.providerInstanceCatalogSource !== null
  ).length;

  let configurationState: CapacityPoolConfigurationState;
  if (sourceRows.length === 0 && rows.length === 0) {
    configurationState = 'configured-empty';
  } else if (activeSourceCount === 0) {
    configurationState = 'source-disabled';
  } else if (activeCandidateCount === 0) {
    configurationState = 'configured-empty';
  } else if (availableCandidateCount === 0) {
    configurationState = 'catalog-unavailable';
  } else {
    configurationState = 'configured-ready';
  }

  const [currentPool] = await db
    .select({
      revision: schema.capacityPools.revision,
      selectionDigest: schema.capacityPools.selectionDigest,
      configurationState: schema.capacityPools.configurationState,
    })
    .from(schema.capacityPools)
    .where(eq(schema.capacityPools.id, poolId))
    .limit(1);

  const selectionDigest = capacityPoolSelectionDigest(rows);
  // A NULL upgrade baseline cannot prove unchanged selection. Invalidate once rather
  // than retain plans across a first-refresh price or membership change.
  const selectionChanged =
    options.selectionRevisionAlreadyBumped !== true &&
    (currentPool?.selectionDigest != null ||
      currentPool?.configurationState !== 'migration-pending') &&
    currentPool?.selectionDigest !== selectionDigest;

  const predicates = [eq(schema.capacityPools.id, poolId)];
  if (guard) {
    predicates.push(
      eq(schema.capacityPools.revision, guard.revision),
      eq(schema.capacityPools.updatedAt, guard.updatedAt),
      eq(schema.capacityPools.status, guard.status)
    );
  }

  if (guard?.sourceGenerations?.length) {
    // The pool CAS must also fence the source writes that produced its readiness result.
    // A concurrent refresh can advance sources without having touched the pool row yet.
    predicates.push(sql`NOT EXISTS (
      SELECT 1 FROM json_each(${JSON.stringify(guard.sourceGenerations)}) expected
      WHERE NOT EXISTS (
        SELECT 1 FROM capacity_sources current_source
        WHERE current_source.id = json_extract(expected.value, '$.id')
          AND current_source.source_generation = json_extract(expected.value, '$.generation')
          AND current_source.status = 'active'
      )
    )`);
  }

  await db
    .update(schema.capacityPools)
    .set({
      status: ACTIVE_STATUS,
      configurationState,
      selectionDigest,
      // Revision is the pool-level input to placement authority. Bump it exactly when the
      // pool's selection-affecting state changed, so an identical refresh stays stable but a
      // ranking change (including a price-only one on a competing candidate) invalidates
      // plans authorized against the old ordering.
      ...(selectionChanged ? { revision: sql`${schema.capacityPools.revision} + 1` } : {}),
      migrationState: options.publicationComplete === false ? 'pending' : 'complete',
      lastReconciledAt: nextCapacityPoolTimestamp(),
      updatedAt: nextCapacityPoolTimestamp(),
    })
    .where(and(...predicates));
}

/**
 * Stable digest over every selection-affecting attribute of the pool's candidate set.
 *
 * Candidate authority already covers a single candidate's own attributes (including price);
 * this covers the SET — membership, availability, source status and relative composition — so
 * a change that only reorders ranking is still detected.
 */
function capacityPoolSelectionDigest(
  rows: readonly {
    candidateId: string;
    sourceStatus: string;
    sourceAuthorityGeneration: number;
    candidateStatus: string;
    candidateAuthorityGeneration: number;
    catalogAvailability: string;
    providerInstanceCatalogSource: string | null;
  }[]
): string {
  const value = JSON.stringify([
    'capacity-pool-selection:v1',
    rows.map((row) => [
      row.candidateId,
      row.sourceStatus,
      row.sourceAuthorityGeneration,
      row.candidateStatus,
      row.candidateAuthorityGeneration,
      row.catalogAvailability,
      row.providerInstanceCatalogSource,
    ]),
  ]);
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export async function readDefaultPoolSummary(
  db: Db,
  scope: ScopeIdentity,
  options: ReadDefaultPoolSummaryOptions = {}
): Promise<CapacityPoolSummary | null> {
  const poolStatusPredicate =
    options.includeDisabled === true
      ? inArray(schema.capacityPools.status, [ACTIVE_STATUS, DISABLED_STATUS])
      : eq(schema.capacityPools.status, ACTIVE_STATUS);

  const [pool] = await db
    .select()
    .from(schema.capacityPools)
    .where(
      and(
        ...poolScopePredicates(scope),
        eq(schema.capacityPools.isDefault, true),
        poolStatusPredicate
      )
    )
    .limit(1);
  if (!pool) return null;

  const rows = await db
    .select({
      source: schema.capacitySources,
      candidate: schema.capacityPoolCandidates,
    })
    .from(schema.capacityPoolCandidates)
    .innerJoin(
      schema.capacitySources,
      eq(schema.capacityPoolCandidates.capacitySourceId, schema.capacitySources.id)
    )
    .where(
      and(
        eq(schema.capacityPoolCandidates.poolId, pool.id),
        // Placement-only mirrors for non-primary workload roles are hidden from the editor
        // by default, so a user curates one row per offering rather than one per role.
        options.workloadRoles === 'all'
          ? undefined
          : eq(schema.capacityPoolCandidates.workloadRole, PRIMARY_CAPACITY_WORKLOAD_ROLE),
        options.includeDisabled === true
          ? undefined
          : eq(schema.capacitySources.status, ACTIVE_STATUS)
      )
    )
    .orderBy(
      asc(schema.capacityPoolCandidates.priority),
      asc(schema.capacityPoolCandidates.candidateOrder),
      asc(schema.capacityPoolCandidates.id)
    );

  const sourcesById = new Map<string, CapacitySourceIdentity>();
  const candidates: CapacityPoolCandidateDto[] = [];
  let activeCandidateCount = 0;
  let availableCandidateCount = 0;
  for (const row of rows) {
    sourcesById.set(row.source.id, toCapacitySourceIdentity(row.source));
    const candidate = toCapacityPoolCandidate(row.candidate);
    // Counts describe the user-visible offering set, never the role-expanded row set.
    if (
      isEditorVisibleCapacityCandidateRole(candidate.workloadRole) &&
      row.source.status === ACTIVE_STATUS &&
      candidate.status === ACTIVE_STATUS
    ) {
      activeCandidateCount += 1;
      if (
        candidate.catalogAvailability === 'available' &&
        candidate.providerInstanceCatalogSource !== null
      ) {
        availableCandidateCount += 1;
      }
    }
    candidates.push(candidate);
  }
  const effectiveState = defaultPoolEffectiveState(pool, {
    sourceCount: sourcesById.size,
    candidateCount: candidates.filter((candidate) =>
      isEditorVisibleCapacityCandidateRole(candidate.workloadRole)
    ).length,
    activeCandidateCount,
    availableCandidateCount,
  });

  return {
    pool: toCapacityPool(pool),
    sources: [...sourcesById.values()],
    candidates,
    activeCandidateCount,
    availableCandidateCount,
    effectiveState,
    diagnostics: defaultPoolDiagnostics(effectiveState),
  };
}

function defaultPoolEffectiveState(
  pool: schema.CapacityPool,
  counts: {
    sourceCount: number;
    candidateCount: number;
    activeCandidateCount: number;
    availableCandidateCount: number;
  }
): CapacityPoolConfigurationState {
  if (pool.migrationState !== 'complete') return 'migration-pending';
  if (pool.configurationState === 'source-disabled') return 'source-disabled';
  if (pool.configurationState === 'migration-pending') return 'migration-pending';
  if (pool.status !== ACTIVE_STATUS) return 'source-disabled';
  if (
    counts.sourceCount === 0 ||
    counts.candidateCount === 0 ||
    counts.activeCandidateCount === 0
  ) {
    return 'configured-empty';
  }
  if (counts.availableCandidateCount === 0) return 'catalog-unavailable';
  return 'configured-ready';
}

function defaultPoolDiagnostics(effectiveState: CapacityPoolConfigurationState): string[] {
  switch (effectiveState) {
    case 'configured-ready':
      return [];
    case 'configured-empty':
      return ['configured-default-pool-has-no-active-candidates'];
    case 'source-disabled':
      return ['configured-default-pool-sources-disabled'];
    case 'catalog-unavailable':
      return ['configured-default-pool-catalog-last-known-unavailable'];
    case 'migration-pending':
      return ['configured-default-pool-migration-pending'];
  }
}
