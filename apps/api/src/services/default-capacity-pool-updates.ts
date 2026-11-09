import type {
  CapacityExhaustionPolicy,
  CapacityPoolStatus,
  CapacityPoolStrategy,
  DefaultCapacityPoolCandidateCatalogAddition,
} from '@simple-agent-manager/shared';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import { nextCapacityPoolTimestamp } from './capacity-pool-clock';
import { capacityCandidateIdForRole } from './capacity-pool-workload-roles';
import type { DefaultPoolScopeIdentity } from './default-capacity-pool-helpers';
import {
  publishSourceSettingsOnly,
  resolveSourceSettingsUpdate,
  sourceSettingsGuardSql,
  type SourceSettingsUpdate,
} from './default-capacity-pool-source-settings';
import {
  type CandidateStatusUpdate,
  resolveCandidateStatusUpdates,
  resolveCatalogAdditionUpdates,
} from './default-capacity-pool-update-candidates';
import {
  type CapacityPoolSummary,
  findDefaultPool,
  readDefaultPoolSummary,
  reconcileDefaultPoolStatus,
} from './default-capacity-pools';

type Db = ReturnType<typeof drizzle>;
type SqliteBatch = [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]];

export interface DefaultCapacityPoolUpdateInput extends DefaultPoolScopeIdentity {
  policy?: {
    strategy?: CapacityPoolStrategy;
    deploymentStrategy?: CapacityPoolStrategy;
    exhaustionPolicy?: CapacityExhaustionPolicy;
    maxNodes?: number;
  };
  candidates?: { id: string; status: CapacityPoolStatus }[];
  catalogAdditions?: DefaultCapacityPoolCandidateCatalogAddition[];
  /** Provider order to store; `null` or `[]` clears it. Absent leaves it unchanged. */
  sourceOrder?: string[] | null;
  /** Switched-off accounts to store; `null` or `[]` switches all on. Absent leaves them. */
  excludedSourceIds?: string[] | null;
}

export interface DefaultCapacityPoolUpdateResult {
  poolFound: boolean;
  summary: CapacityPoolSummary | null;
  missingCandidateIds: string[];
  unavailableCandidateIds: string[];
  missingCatalogAdditions: string[];
  unavailableCatalogAdditions: string[];
  /**
   * Ids in a requested provider order or switched-off list that are not capacity sources
   * serving this pool.
   */
  missingSourceIds: string[];
  /**
   * True when a concurrent editor advanced the pool between this edit's read and its write.
   * Nothing was published: membership, policy and revision are all fenced on the same
   * pre-read revision inside one D1 batch, so a losing editor changes nothing at all. An edit
   * that rewrites the provider order is also fenced on the order it read, because a reorder
   * does not advance the revision.
   */
  conflict: boolean;
}

type PolicyUpdate = NonNullable<DefaultCapacityPoolUpdateInput['policy']>;

/**
 * Binds consumed by an atomic candidate UPDATE before its `id IN (...)` list:
 * `status`, `updated_at` (SET), `pool_id`, role suffix and the fence's `id` + `revision`.
 * Each candidate id is bound twice: its direct update and current coupled-mirror lookup.
 */
const ATOMIC_CANDIDATE_UPDATE_FIXED_BIND_COUNT = 6;
const ATOMIC_CANDIDATE_ID_CHUNK_SIZE = Math.max(
  1,
  Math.floor((D1_MAX_BOUND_PARAMETERS - ATOMIC_CANDIDATE_UPDATE_FIXED_BIND_COUNT) / 2)
);
/**
 * The batch must stay a bounded unit of work (.claude/rules/47). Candidate writes are grouped
 * by target status and chunked under the bind ceiling, so this caps a genuinely enormous edit
 * rather than silently splitting it into non-atomic pieces.
 */
const MAX_ATOMIC_BATCH_STATEMENTS = 64;

interface PolicyUpdateResult {
  changed: boolean;
  values: Partial<PolicyUpdate>;
}

function emptyUpdateResult(
  overrides: Partial<DefaultCapacityPoolUpdateResult>
): DefaultCapacityPoolUpdateResult {
  return {
    poolFound: true,
    summary: null,
    missingCandidateIds: [],
    unavailableCandidateIds: [],
    missingCatalogAdditions: [],
    unavailableCatalogAdditions: [],
    missingSourceIds: [],
    conflict: false,
    ...overrides,
  };
}

export async function updateDefaultCapacityPool(
  db: Db,
  input: DefaultCapacityPoolUpdateInput
): Promise<DefaultCapacityPoolUpdateResult> {
  const pool = await findDefaultPool(db, input);
  if (!pool) {
    return emptyUpdateResult({ poolFound: false });
  }

  const catalogAdditionResult = await resolveCatalogAdditionUpdates(db, pool, input);
  if (catalogAdditionResult.missingCatalogAdditions.length > 0) {
    return emptyUpdateResult({
      missingCatalogAdditions: catalogAdditionResult.missingCatalogAdditions,
    });
  }

  const candidateResult = await resolveCandidateStatusUpdates(db, pool.id, [
    ...(input.candidates ?? []),
    ...catalogAdditionResult.candidateUpdates,
  ]);
  if (candidateResult.missingCandidateIds.length > 0) {
    const missingCatalogAdditions = candidateResult.missingCandidateIds.flatMap(
      (candidateId) => catalogAdditionResult.additionKeysByCandidateId.get(candidateId) ?? []
    );
    return emptyUpdateResult({
      missingCandidateIds: candidateResult.missingCandidateIds.filter(
        (candidateId) => !catalogAdditionResult.additionKeysByCandidateId.has(candidateId)
      ),
      missingCatalogAdditions,
    });
  }
  if (candidateResult.unavailableCandidateIds.length > 0) {
    const unavailableCatalogAdditions = candidateResult.unavailableCandidateIds.flatMap(
      (candidateId) => catalogAdditionResult.additionKeysByCandidateId.get(candidateId) ?? []
    );
    return emptyUpdateResult({
      unavailableCandidateIds: candidateResult.unavailableCandidateIds.filter(
        (candidateId) => !catalogAdditionResult.additionKeysByCandidateId.has(candidateId)
      ),
      unavailableCatalogAdditions,
    });
  }

  const sourceSettings = await resolveSourceSettingsUpdate(
    db,
    pool,
    input,
    candidateResult.activatedSourceIds
  );
  if (sourceSettings.missingSourceIds.length > 0) {
    return emptyUpdateResult({ missingSourceIds: sourceSettings.missingSourceIds });
  }

  const policyResult = resolvePolicyUpdate(pool, input.policy);
  const candidatesChanged = candidateResult.changedUpdates.length > 0;
  if (!policyResult.changed && !candidatesChanged) {
    if (sourceSettings.changed) {
      // Order and on/off do not bump the revision (see default-capacity-pool-source-settings.ts);
      // the write is fenced on the values it read instead.
      const published = await publishSourceSettingsOnly(db, pool, sourceSettings);
      if (!published) return emptyUpdateResult({ conflict: true });
    }
    // Ordinary no-op reads must not mutate: an unchanged edit publishes nothing and
    // does not burn a revision.
    return emptyUpdateResult({
      summary: await readDefaultPoolSummary(db, input, { includeDisabled: true }),
    });
  }

  const published = await publishPoolEditAtomically(db, {
    poolId: pool.id,
    guardRevision: pool.revision,
    // Order and on/off edits do not bump the revision, so an edit that rewrites them must also
    // prove the values it read are still the stored ones.
    sourceSettings,
    candidateUpdates: candidateResult.changedUpdates,
    policyValues: { ...policyResult.values, ...sourceSettings.values },
  });
  if (!published) {
    return emptyUpdateResult({ conflict: true });
  }

  if (candidatesChanged) {
    // The atomic edit already published this change's revision bump; reconciliation records
    // the resulting configuration state and selection digest without a second bump.
    await reconcileDefaultPoolStatus(db, pool.id, undefined, {
      selectionRevisionAlreadyBumped: true,
    });
  }

  return emptyUpdateResult({
    summary: await readDefaultPoolSummary(db, input, { includeDisabled: true }),
  });
}

/**
 * Publish membership + policy + revision as ONE fenced unit.
 *
 * Every statement carries the same `revision = guardRevision` precondition and they are sent
 * as a single D1 batch (one implicit transaction), so a mid-edit failure rolls the whole edit
 * back and a concurrent editor that already advanced the revision cannot be partially
 * overwritten. Returns false when the fence rejected the edit.
 */
async function publishPoolEditAtomically(
  db: Db,
  input: {
    poolId: string;
    guardRevision: number;
    /** The order/on-off values the edit read; changed ones must still be stored. */
    sourceSettings: SourceSettingsUpdate;
    candidateUpdates: CandidateStatusUpdate[];
    policyValues: Partial<PolicyUpdate> & SourceSettingsUpdate['values'];
  }
): Promise<boolean> {
  const now = nextCapacityPoolTimestamp();
  const nextRevision = input.guardRevision + 1;
  // Every statement shares this fence, so a refused settings guard cannot leave candidate rows
  // updated under a pool row that was not.
  const poolRevisionFence = sql`EXISTS (
    SELECT 1 FROM capacity_pools
    WHERE id = ${input.poolId} AND revision = ${input.guardRevision}${sourceSettingsGuardSql(
      input.sourceSettings.guards
    )}
  )`;

  // One statement per (target status, bind-safe id chunk) rather than one per row: a
  // "select every offering" edit is a few statements, not hundreds.
  const idsByStatus = new Map<CapacityPoolStatus, string[]>();
  for (const candidate of input.candidateUpdates) {
    idsByStatus.set(candidate.status, [...(idsByStatus.get(candidate.status) ?? []), candidate.id]);
  }

  const statements: BatchItem<'sqlite'>[] = [];
  for (const [status, ids] of idsByStatus) {
    for (let offset = 0; offset < ids.length; offset += ATOMIC_CANDIDATE_ID_CHUNK_SIZE) {
      const chunk = ids.slice(offset, offset + ATOMIC_CANDIDATE_ID_CHUNK_SIZE);
      statements.push(
        db
          .update(schema.capacityPoolCandidates)
          .set({ status, updatedAt: now })
          .where(
            and(
              eq(schema.capacityPoolCandidates.poolId, input.poolId),
              or(
                inArray(schema.capacityPoolCandidates.id, chunk),
                // Include a mirror materialized AFTER the editor read its sibling list.
                // Match exact native identity; legacy null-typed rows never couple.
                sql`EXISTS (SELECT 1 FROM capacity_pool_candidates AS primary_member
                  WHERE primary_member.id IN (${sql.join(
                    chunk.map((id) => sql`${id}`),
                    sql`, `
                  )})
                    AND primary_member.id || ${capacityCandidateIdForRole('', 'deployment')} = capacity_pool_candidates.id
                    AND primary_member.pool_id = capacity_pool_candidates.pool_id
                    AND primary_member.capacity_source_id = capacity_pool_candidates.capacity_source_id
                    AND primary_member.provider = capacity_pool_candidates.provider
                    AND primary_member.location = capacity_pool_candidates.location
                    AND primary_member.provider_instance_type IS NOT NULL
                    AND primary_member.provider_instance_type = capacity_pool_candidates.provider_instance_type
                    AND primary_member.provider_instance_sku IS capacity_pool_candidates.provider_instance_sku)`
              ),
              poolRevisionFence
            )
          )
      );
    }
  }
  if (statements.length + 1 > MAX_ATOMIC_BATCH_STATEMENTS) {
    throw new Error(
      `Capacity pool edit exceeds the atomic batch budget (${statements.length + 1} > ${MAX_ATOMIC_BATCH_STATEMENTS} statements)`
    );
  }
  statements.push(
    db
      .update(schema.capacityPools)
      .set({
        ...input.policyValues,
        revision: nextRevision,
        updatedAt: now,
      })
      .where(and(eq(schema.capacityPools.id, input.poolId), poolRevisionFence))
  );

  const results = await db.batch(statements as SqliteBatch);

  // D1 returns each statement's result from the same atomic batch. A later editor
  // cannot turn a winning edit into a conflict, and same-clock losers cannot claim success.
  const publication = results.at(-1) as D1Result<unknown>;
  return publication.meta.changes === 1;
}

function resolvePolicyUpdate(
  pool: schema.CapacityPool,
  policy: DefaultCapacityPoolUpdateInput['policy']
): PolicyUpdateResult {
  const values: Partial<PolicyUpdate> = {};
  if (policy?.strategy !== undefined && policy.strategy !== pool.strategy) {
    values.strategy = policy.strategy;
  }
  if (
    policy?.deploymentStrategy !== undefined &&
    policy.deploymentStrategy !== pool.deploymentStrategy
  ) {
    values.deploymentStrategy = policy.deploymentStrategy;
  }
  if (policy?.exhaustionPolicy !== undefined && policy.exhaustionPolicy !== pool.exhaustionPolicy) {
    values.exhaustionPolicy = policy.exhaustionPolicy;
  }
  if (policy?.maxNodes !== undefined && policy.maxNodes !== pool.maxNodes) {
    values.maxNodes = policy.maxNodes;
  }

  return { changed: Object.keys(values).length > 0, values };
}
