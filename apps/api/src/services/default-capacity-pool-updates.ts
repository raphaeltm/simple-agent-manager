import type {
  CapacityExhaustionPolicy,
  CapacityPoolStatus,
  CapacityPoolStrategy,
} from '@simple-agent-manager/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { DefaultPoolScopeIdentity } from './default-capacity-pool-helpers';
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
}

export interface DefaultCapacityPoolUpdateResult {
  poolFound: boolean;
  summary: CapacityPoolSummary | null;
  missingCandidateIds: string[];
}

type CandidateStatusUpdate = { id: string; status: CapacityPoolStatus };
type PolicyUpdate = NonNullable<DefaultCapacityPoolUpdateInput['policy']>;

interface CandidateStatusUpdateResult {
  changed: boolean;
  missingCandidateIds: string[];
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
  if (!pool) return { poolFound: false, summary: null, missingCandidateIds: [] };

  const candidateResult = await updateCandidateStatuses(db, pool.id, input.candidates ?? []);
  if (candidateResult.missingCandidateIds.length > 0) {
    return {
      poolFound: true,
      summary: null,
      missingCandidateIds: candidateResult.missingCandidateIds,
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
  };
}

async function updateCandidateStatuses(
  db: Db,
  poolId: string,
  candidates: CandidateStatusUpdate[]
): Promise<CandidateStatusUpdateResult> {
  const updates = dedupeCandidateStatusUpdates(candidates);
  if (updates.length === 0) return { changed: false, missingCandidateIds: [] };

  const existingById = await readCandidateStatuses(
    db,
    poolId,
    updates.map(({ id }) => id)
  );
  const missingCandidateIds = updates
    .map(({ id }) => id)
    .filter((candidateId) => !existingById.has(candidateId));
  if (missingCandidateIds.length > 0) return { changed: false, missingCandidateIds };

  const changedUpdates = updates.filter(({ id, status }) => existingById.get(id) !== status);
  if (changedUpdates.length === 0) return { changed: false, missingCandidateIds: [] };

  const now = new Date().toISOString();
  for (const candidate of changedUpdates) {
    await db
      .update(schema.capacityPoolCandidates)
      .set({ status: candidate.status, updatedAt: now })
      .where(
        and(
          eq(schema.capacityPoolCandidates.poolId, poolId),
          eq(schema.capacityPoolCandidates.id, candidate.id)
        )
      );
  }

  return { changed: true, missingCandidateIds: [] };
}

async function readCandidateStatuses(
  db: Db,
  poolId: string,
  candidateIds: string[]
): Promise<Map<string, CapacityPoolStatus>> {
  const rows = await db
    .select({
      id: schema.capacityPoolCandidates.id,
      status: schema.capacityPoolCandidates.status,
    })
    .from(schema.capacityPoolCandidates)
    .where(
      and(
        eq(schema.capacityPoolCandidates.poolId, poolId),
        inArray(schema.capacityPoolCandidates.id, candidateIds)
      )
    );

  return new Map(rows.map((candidate) => [candidate.id, candidate.status as CapacityPoolStatus]));
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
