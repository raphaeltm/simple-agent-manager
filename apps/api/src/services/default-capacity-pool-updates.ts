import type {
  CapacityExhaustionPolicy,
  CapacityPoolStatus,
  CapacityPoolStrategy,
  DefaultCapacityPoolCandidateCatalogAddition,
} from '@simple-agent-manager/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import type { DefaultPoolScopeIdentity } from './default-capacity-pool-helpers';
import { defaultCandidateId } from './default-capacity-pool-helpers';
import {
  type CapacityPoolSummary,
  findDefaultPool,
  readDefaultPoolSummary,
  reconcileDefaultPoolStatus,
} from './default-capacity-pools';

type Db = ReturnType<typeof drizzle>;

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
}

type CandidateStatusUpdate = { id: string; status: CapacityPoolStatus };
type PolicyUpdate = NonNullable<DefaultCapacityPoolUpdateInput['policy']>;
const READ_CANDIDATE_STATUS_CHUNK_SIZE = D1_MAX_BOUND_PARAMETERS - 1;
const READ_SOURCE_CHUNK_SIZE = D1_MAX_BOUND_PARAMETERS - 3;

interface CandidateStatusUpdateResult {
  changed: boolean;
  missingCandidateIds: string[];
  unavailableCandidateIds: string[];
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

export async function updateDefaultCapacityPool(
  db: Db,
  input: DefaultCapacityPoolUpdateInput
): Promise<DefaultCapacityPoolUpdateResult> {
  const pool = await findDefaultPool(db, input);
  if (!pool) {
    return {
      poolFound: false,
      summary: null,
      missingCandidateIds: [],
      unavailableCandidateIds: [],
      missingCatalogAdditions: [],
      unavailableCatalogAdditions: [],
    };
  }

  const catalogAdditionResult = await resolveCatalogAdditionUpdates(db, pool, input);
  if (catalogAdditionResult.missingCatalogAdditions.length > 0) {
    return {
      poolFound: true,
      summary: null,
      missingCandidateIds: [],
      unavailableCandidateIds: [],
      missingCatalogAdditions: catalogAdditionResult.missingCatalogAdditions,
      unavailableCatalogAdditions: [],
    };
  }

  const candidateResult = await updateCandidateStatuses(db, pool.id, [
    ...(input.candidates ?? []),
    ...catalogAdditionResult.candidateUpdates,
  ]);
  if (candidateResult.missingCandidateIds.length > 0) {
    const missingCatalogAdditions = candidateResult.missingCandidateIds.flatMap(
      (candidateId) => catalogAdditionResult.additionKeysByCandidateId.get(candidateId) ?? []
    );
    return {
      poolFound: true,
      summary: null,
      missingCandidateIds: candidateResult.missingCandidateIds.filter(
        (candidateId) => !catalogAdditionResult.additionKeysByCandidateId.has(candidateId)
      ),
      unavailableCandidateIds: [],
      missingCatalogAdditions,
      unavailableCatalogAdditions: [],
    };
  }
  if (candidateResult.unavailableCandidateIds.length > 0) {
    const unavailableCatalogAdditions = candidateResult.unavailableCandidateIds.flatMap(
      (candidateId) => catalogAdditionResult.additionKeysByCandidateId.get(candidateId) ?? []
    );
    return {
      poolFound: true,
      summary: null,
      missingCandidateIds: [],
      unavailableCandidateIds: candidateResult.unavailableCandidateIds.filter(
        (candidateId) => !catalogAdditionResult.additionKeysByCandidateId.has(candidateId)
      ),
      missingCatalogAdditions: [],
      unavailableCatalogAdditions,
    };
  }

  const policyResult = resolvePolicyUpdate(pool, input.policy);
  if (policyResult.changed || candidateResult.changed) {
    await updatePoolPolicyAndRevision(db, pool.id, policyResult.values);
  }

  if (candidateResult.changed) {
    await reconcileDefaultPoolStatus(db, pool.id);
  }

  return {
    poolFound: true,
    summary: await readDefaultPoolSummary(db, input, { includeDisabled: true }),
    missingCandidateIds: [],
    unavailableCandidateIds: [],
    missingCatalogAdditions: [],
    unavailableCatalogAdditions: [],
  };
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

async function updateCandidateStatuses(
  db: Db,
  poolId: string,
  candidates: CandidateStatusUpdate[]
): Promise<CandidateStatusUpdateResult> {
  const updates = dedupeCandidateStatusUpdates(candidates);
  if (updates.length === 0) {
    return { changed: false, missingCandidateIds: [], unavailableCandidateIds: [] };
  }

  const existingById = await readCandidateStatuses(
    db,
    poolId,
    updates.map(({ id }) => id)
  );
  const missingCandidateIds = updates
    .map(({ id }) => id)
    .filter((candidateId) => !existingById.has(candidateId));
  if (missingCandidateIds.length > 0) {
    return { changed: false, missingCandidateIds, unavailableCandidateIds: [] };
  }

  const unavailableCandidateIds = updates
    .filter(({ id, status }) => {
      const existing = existingById.get(id);
      return status === 'active' && !existing?.currentlyAddable;
    })
    .map(({ id }) => id);
  if (unavailableCandidateIds.length > 0) {
    return { changed: false, missingCandidateIds: [], unavailableCandidateIds };
  }

  const changedUpdates = updates.filter(
    ({ id, status }) => existingById.get(id)?.status !== status
  );
  if (changedUpdates.length === 0) {
    return { changed: false, missingCandidateIds: [], unavailableCandidateIds: [] };
  }

  const now = new Date().toISOString();
  for (const candidate of changedUpdates) {
    await db
      .update(schema.capacityPoolCandidates)
      .set({ status: candidate.status, selectionOrigin: 'user', updatedAt: now })
      .where(
        and(
          eq(schema.capacityPoolCandidates.poolId, poolId),
          eq(schema.capacityPoolCandidates.id, candidate.id)
        )
      );
  }

  return { changed: true, missingCandidateIds: [], unavailableCandidateIds: [] };
}

async function readCandidateStatuses(
  db: Db,
  poolId: string,
  candidateIds: string[]
): Promise<Map<string, { status: CapacityPoolStatus; currentlyAddable: boolean }>> {
  const rows: {
    id: string;
    status: string;
    providerInstanceCatalogSource: string | null;
  }[] = [];
  for (let offset = 0; offset < candidateIds.length; offset += READ_CANDIDATE_STATUS_CHUNK_SIZE) {
    const chunk = candidateIds.slice(offset, offset + READ_CANDIDATE_STATUS_CHUNK_SIZE);
    rows.push(
      ...(await db
        .select({
          id: schema.capacityPoolCandidates.id,
          status: schema.capacityPoolCandidates.status,
          providerInstanceCatalogSource:
            schema.capacityPoolCandidates.providerInstanceCatalogSource,
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
        status: candidate.status as CapacityPoolStatus,
        currentlyAddable: candidate.providerInstanceCatalogSource !== null,
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

async function updatePoolPolicyAndRevision(
  db: Db,
  poolId: string,
  values: Partial<PolicyUpdate>
): Promise<void> {
  await db
    .update(schema.capacityPools)
    .set({
      ...values,
      revision: sql`${schema.capacityPools.revision} + 1`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.capacityPools.id, poolId));
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
