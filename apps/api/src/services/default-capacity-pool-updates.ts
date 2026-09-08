import type {
  CapacityExhaustionPolicy,
  CapacityPoolStatus,
  CapacityPoolStrategy,
  DefaultCapacityPoolCandidateCatalogAddition,
} from '@simple-agent-manager/shared';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import { nextCapacityPoolTimestamp } from './capacity-pool-clock';
import {
  CAPACITY_POOL_MATERIALIZED_WORKLOAD_ROLES,
  capacityCandidateBaseId,
  capacityCandidateIdForRole,
} from './capacity-pool-workload-roles';
import type { DefaultPoolScopeIdentity } from './default-capacity-pool-helpers';
import { defaultCandidateId } from './default-capacity-pool-helpers';
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
    exhaustionPolicy?: CapacityExhaustionPolicy;
  };
  candidates?: { id: string; status: CapacityPoolStatus }[];
  catalogAdditions?: DefaultCapacityPoolCandidateCatalogAddition[];
}

export interface DefaultCapacityPoolUpdateResult {
  poolFound: boolean;
  summary: CapacityPoolSummary | null;
  missingCandidateIds: string[];
  unavailableCandidateIds: string[];
  missingCatalogAdditions: string[];
  unavailableCatalogAdditions: string[];
  /**
   * True when a concurrent editor advanced the pool between this edit's read and its write.
   * Nothing was published: membership, policy and revision are all fenced on the same
   * pre-read revision inside one D1 batch, so a losing editor changes nothing at all.
   */
  conflict: boolean;
}

type CandidateStatusUpdate = { id: string; status: CapacityPoolStatus };
type PolicyUpdate = NonNullable<DefaultCapacityPoolUpdateInput['policy']>;
const READ_CANDIDATE_STATUS_CHUNK_SIZE = D1_MAX_BOUND_PARAMETERS - 1;
const READ_SOURCE_CHUNK_SIZE = D1_MAX_BOUND_PARAMETERS - 3;

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

interface CandidateIdentityRow {
  id: string;
  capacitySourceId: string;
  provider: string | null;
  location: string | null;
  workloadRole: string;
  providerInstanceType: string | null;
  providerInstanceSku: string | null;
  status: CapacityPoolStatus;
  currentlyAddable: boolean;
}

interface CandidateStatusUpdateResolution {
  missingCandidateIds: string[];
  unavailableCandidateIds: string[];
  changedUpdates: CandidateStatusUpdate[];
}

interface CatalogAdditionUpdateResult {
  candidateUpdates: CandidateStatusUpdate[];
  missingCatalogAdditions: string[];
  additionKeysByCandidateId: Map<string, string[]>;
}

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

  const policyResult = resolvePolicyUpdate(pool, input.policy);
  const candidatesChanged = candidateResult.changedUpdates.length > 0;
  if (!policyResult.changed && !candidatesChanged) {
    // Ordinary no-op reads must not mutate: an unchanged edit publishes nothing and
    // does not burn a revision.
    return emptyUpdateResult({
      summary: await readDefaultPoolSummary(db, input, { includeDisabled: true }),
    });
  }

  const published = await publishPoolEditAtomically(db, {
    poolId: pool.id,
    guardRevision: pool.revision,
    candidateUpdates: candidateResult.changedUpdates,
    policyValues: policyResult.values,
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
    candidateUpdates: CandidateStatusUpdate[];
    policyValues: Partial<PolicyUpdate>;
  }
): Promise<boolean> {
  const now = nextCapacityPoolTimestamp();
  const nextRevision = input.guardRevision + 1;
  const poolRevisionFence = sql`EXISTS (
    SELECT 1 FROM capacity_pools
    WHERE id = ${input.poolId} AND revision = ${input.guardRevision}
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
      .where(
        and(
          eq(schema.capacityPools.id, input.poolId),
          eq(schema.capacityPools.revision, input.guardRevision)
        )
      )
  );

  const results = await db.batch(statements as SqliteBatch);

  // D1 returns each statement's result from the same atomic batch. A later editor
  // cannot turn a winning edit into a conflict, and same-clock losers cannot claim success.
  const publication = results.at(-1) as D1Result<unknown>;
  return publication.meta.changes === 1;
}

async function resolveCatalogAdditionUpdates(
  db: Db,
  pool: schema.CapacityPool,
  input: DefaultCapacityPoolUpdateInput
): Promise<CatalogAdditionUpdateResult> {
  const additions = dedupeCatalogAdditions(input.catalogAdditions ?? []);
  if (additions.length === 0) {
    return {
      candidateUpdates: [],
      missingCatalogAdditions: [],
      additionKeysByCandidateId: new Map(),
    };
  }

  const sourceIds = [...new Set(additions.map((addition) => addition.sourceId))];
  const sourceById = await readActiveSourcesById(db, input, sourceIds);
  const candidateUpdates: CandidateStatusUpdate[] = [];
  const missingCatalogAdditions: string[] = [];
  const additionKeysByCandidateId = new Map<string, string[]>();

  for (const addition of additions) {
    const source = sourceById.get(addition.sourceId);
    const additionKey = catalogAdditionKey(addition);
    if (!source || source.provider !== addition.provider) {
      missingCatalogAdditions.push(additionKey);
      continue;
    }

    const candidateId = defaultCandidateId(
      pool.id,
      source.id,
      addition.provider,
      addition.location,
      addition.providerInstanceType,
      addition.providerInstanceSku ?? null
    );
    candidateUpdates.push({ id: candidateId, status: 'active' });
    additionKeysByCandidateId.set(candidateId, [
      ...(additionKeysByCandidateId.get(candidateId) ?? []),
      additionKey,
    ]);
  }

  return { candidateUpdates, missingCatalogAdditions, additionKeysByCandidateId };
}

async function readActiveSourcesById(
  db: Db,
  scope: DefaultPoolScopeIdentity,
  sourceIds: string[]
): Promise<Map<string, schema.CapacitySource>> {
  const rows: schema.CapacitySource[] = [];
  for (let offset = 0; offset < sourceIds.length; offset += READ_SOURCE_CHUNK_SIZE) {
    const chunk = sourceIds.slice(offset, offset + READ_SOURCE_CHUNK_SIZE);
    rows.push(
      ...(await db
        .select()
        .from(schema.capacitySources)
        .where(
          and(
            ...sourceScopePredicates(scope),
            eq(schema.capacitySources.status, 'active'),
            inArray(schema.capacitySources.id, chunk)
          )
        ))
    );
  }
  return new Map(rows.map((source) => [source.id, source]));
}

function dedupeCatalogAdditions(
  additions: DefaultCapacityPoolCandidateCatalogAddition[]
): DefaultCapacityPoolCandidateCatalogAddition[] {
  const byKey = new Map<string, DefaultCapacityPoolCandidateCatalogAddition>();
  for (const addition of additions) {
    const normalized = {
      ...addition,
      sourceId: addition.sourceId.trim(),
      location: addition.location.trim(),
      providerInstanceType: addition.providerInstanceType.trim(),
      providerInstanceSku: addition.providerInstanceSku?.trim() || null,
    };
    if (
      !normalized.sourceId ||
      !normalized.location ||
      !normalized.providerInstanceType ||
      !normalized.provider
    ) {
      continue;
    }
    byKey.set(catalogAdditionKey(normalized), normalized);
  }
  return [...byKey.values()];
}

function catalogAdditionKey(addition: DefaultCapacityPoolCandidateCatalogAddition): string {
  return [
    addition.sourceId,
    addition.provider,
    addition.location,
    addition.providerInstanceSku ?? addition.providerInstanceType,
  ].join(':');
}

/**
 * Validate the requested edits and expand them across coupled workload-role rows.
 *
 * Only the editor-visible (primary-role) row is addressable by a caller; the placement-only
 * mirrors must move with it so a deliberate removal or disable is not silently retained for
 * one workload role.
 */
async function resolveCandidateStatusUpdates(
  db: Db,
  poolId: string,
  candidates: CandidateStatusUpdate[]
): Promise<CandidateStatusUpdateResolution> {
  const updates = dedupeCandidateStatusUpdates(candidates);
  if (updates.length === 0) {
    return { missingCandidateIds: [], unavailableCandidateIds: [], changedUpdates: [] };
  }

  const requestedById = await readCandidateIdentities(
    db,
    poolId,
    updates.map(({ id }) => id)
  );
  const missingCandidateIds = updates
    .map(({ id }) => id)
    .filter((candidateId) => !requestedById.has(candidateId));
  if (missingCandidateIds.length > 0) {
    return { missingCandidateIds, unavailableCandidateIds: [], changedUpdates: [] };
  }

  const unavailableCandidateIds = updates
    .filter(({ id, status }) => {
      const existing = requestedById.get(id);
      return status === 'active' && !existing?.currentlyAddable;
    })
    .map(({ id }) => id);
  if (unavailableCandidateIds.length > 0) {
    return { missingCandidateIds: [], unavailableCandidateIds, changedUpdates: [] };
  }

  const coupledById = await readCandidateIdentities(db, poolId, coupledCandidateIds(updates));
  const resolvedStatuses = new Map<string, CapacityPoolStatus>();
  // Coupled mirrors are resolved FIRST so an explicit request for a specific row always wins
  // over a status inherited from its sibling, regardless of input ordering.
  for (const update of updates) {
    const requested = requestedById.get(update.id);
    if (!requested) continue;
    for (const coupledId of coupledCandidateIds([update])) {
      const coupled = coupledById.get(coupledId);
      if (!coupled) continue;
      if (!sharesExactProviderNativeIdentity(requested, coupled)) continue;
      resolvedStatuses.set(coupledId, update.status);
    }
  }
  for (const update of updates) {
    if (!requestedById.has(update.id)) continue;
    resolvedStatuses.set(update.id, update.status);
  }

  const changedUpdates = [...resolvedStatuses.entries()]
    .map(([id, status]) => ({ id, status }))
    .filter(({ id, status }) => (requestedById.get(id) ?? coupledById.get(id))?.status !== status);

  return { missingCandidateIds: [], unavailableCandidateIds: [], changedUpdates };
}

/** Sibling role ids for each requested edit, excluding the requested row itself. */
function coupledCandidateIds(updates: CandidateStatusUpdate[]): string[] {
  const ids = new Set<string>();
  for (const update of updates) {
    const baseId = capacityCandidateBaseId(update.id);
    for (const role of CAPACITY_POOL_MATERIALIZED_WORKLOAD_ROLES) {
      const coupledId = capacityCandidateIdForRole(baseId, role);
      if (coupledId !== update.id) ids.add(coupledId);
    }
  }
  return [...ids];
}

/**
 * Coupling is only allowed on EXACT provider-native identity. Legacy rows that predate
 * concrete offerings carry a NULL provider_instance_type; they are addressable by exact id
 * and are never coupled, so a null-typed row can never be matched to an unrelated offering.
 */
function sharesExactProviderNativeIdentity(
  requested: CandidateIdentityRow,
  coupled: CandidateIdentityRow
): boolean {
  if (requested.capacitySourceId !== coupled.capacitySourceId) return false;
  if (requested.provider === null || requested.provider !== coupled.provider) return false;
  if (requested.location === null || requested.location !== coupled.location) return false;
  if (requested.providerInstanceType === null || coupled.providerInstanceType === null) {
    return false;
  }
  if (requested.providerInstanceType !== coupled.providerInstanceType) return false;
  return (requested.providerInstanceSku ?? null) === (coupled.providerInstanceSku ?? null);
}

async function readCandidateIdentities(
  db: Db,
  poolId: string,
  candidateIds: string[]
): Promise<Map<string, CandidateIdentityRow>> {
  if (candidateIds.length === 0) return new Map();
  const rows: {
    id: string;
    capacitySourceId: string;
    provider: string | null;
    location: string | null;
    workloadRole: string;
    providerInstanceType: string | null;
    providerInstanceSku: string | null;
    status: string;
    providerInstanceCatalogSource: string | null;
    catalogAvailability: string;
  }[] = [];
  for (let offset = 0; offset < candidateIds.length; offset += READ_CANDIDATE_STATUS_CHUNK_SIZE) {
    const chunk = candidateIds.slice(offset, offset + READ_CANDIDATE_STATUS_CHUNK_SIZE);
    rows.push(
      ...(await db
        .select({
          id: schema.capacityPoolCandidates.id,
          capacitySourceId: schema.capacityPoolCandidates.capacitySourceId,
          provider: schema.capacityPoolCandidates.provider,
          location: schema.capacityPoolCandidates.location,
          workloadRole: schema.capacityPoolCandidates.workloadRole,
          providerInstanceType: schema.capacityPoolCandidates.providerInstanceType,
          providerInstanceSku: schema.capacityPoolCandidates.providerInstanceSku,
          status: schema.capacityPoolCandidates.status,
          providerInstanceCatalogSource:
            schema.capacityPoolCandidates.providerInstanceCatalogSource,
          catalogAvailability: schema.capacityPoolCandidates.catalogAvailability,
        })
        .from(schema.capacityPoolCandidates)
        .where(
          and(
            eq(schema.capacityPoolCandidates.poolId, poolId),
            inArray(schema.capacityPoolCandidates.id, chunk)
          )
        ))
    );
  }

  return new Map(
    rows.map((candidate) => [
      candidate.id,
      {
        id: candidate.id,
        capacitySourceId: candidate.capacitySourceId,
        provider: candidate.provider,
        location: candidate.location,
        workloadRole: candidate.workloadRole,
        providerInstanceType: candidate.providerInstanceType,
        providerInstanceSku: candidate.providerInstanceSku,
        status: candidate.status as CapacityPoolStatus,
        currentlyAddable:
          candidate.catalogAvailability === 'available' &&
          candidate.providerInstanceCatalogSource !== null,
      },
    ])
  );
}

function resolvePolicyUpdate(
  pool: schema.CapacityPool,
  policy: DefaultCapacityPoolUpdateInput['policy']
): PolicyUpdateResult {
  const values: Partial<PolicyUpdate> = {};
  if (policy?.strategy !== undefined && policy.strategy !== pool.strategy) {
    values.strategy = policy.strategy;
  }
  if (policy?.exhaustionPolicy !== undefined && policy.exhaustionPolicy !== pool.exhaustionPolicy) {
    values.exhaustionPolicy = policy.exhaustionPolicy;
  }

  return { changed: Object.keys(values).length > 0, values };
}

function dedupeCandidateStatusUpdates(
  candidates: CandidateStatusUpdate[]
): CandidateStatusUpdate[] {
  const statusesByCandidateId = new Map<string, CapacityPoolStatus>();
  for (const candidate of candidates) {
    const id = candidate.id.trim();
    if (id.length === 0) continue;
    statusesByCandidateId.set(id, candidate.status);
  }
  return [...statusesByCandidateId.entries()].map(([id, status]) => ({ id, status }));
}

function sourceScopePredicates(scope: DefaultPoolScopeIdentity) {
  return [
    eq(schema.capacitySources.scope, scope.scope),
    scope.ownerUserId
      ? eq(schema.capacitySources.ownerUserId, scope.ownerUserId)
      : isNull(schema.capacitySources.ownerUserId),
    scope.ownerProjectId
      ? eq(schema.capacitySources.ownerProjectId, scope.ownerProjectId)
      : isNull(schema.capacitySources.ownerProjectId),
  ];
}
