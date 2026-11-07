/** Resolving a pool edit's candidate status changes and catalog additions against D1. */
import type {
  CapacityPoolStatus,
  DefaultCapacityPoolCandidateCatalogAddition,
} from '@simple-agent-manager/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import {
  CAPACITY_POOL_MATERIALIZED_WORKLOAD_ROLES,
  capacityCandidateBaseId,
  capacityCandidateIdForRole,
} from './capacity-pool-workload-roles';
import type { DefaultPoolScopeIdentity } from './default-capacity-pool-helpers';
import { defaultCandidateId } from './default-capacity-pool-helpers';
import type { DefaultCapacityPoolUpdateInput } from './default-capacity-pool-updates';

type Db = ReturnType<typeof drizzle>;

export type CandidateStatusUpdate = { id: string; status: CapacityPoolStatus };
const READ_CANDIDATE_STATUS_CHUNK_SIZE = D1_MAX_BOUND_PARAMETERS - 1;
const READ_SOURCE_CHUNK_SIZE = D1_MAX_BOUND_PARAMETERS - 3;

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

export interface CandidateStatusUpdateResolution {
  missingCandidateIds: string[];
  unavailableCandidateIds: string[];
  changedUpdates: CandidateStatusUpdate[];
}

export interface CatalogAdditionUpdateResult {
  candidateUpdates: CandidateStatusUpdate[];
  missingCatalogAdditions: string[];
  additionKeysByCandidateId: Map<string, string[]>;
}

export async function resolveCatalogAdditionUpdates(
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
export async function resolveCandidateStatusUpdates(
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

export function sourceScopePredicates(scope: DefaultPoolScopeIdentity) {
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
