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

export async function updateDefaultCapacityPool(
  db: Db,
  input: DefaultCapacityPoolUpdateInput
): Promise<DefaultCapacityPoolUpdateResult> {
  const pool = await findDefaultPool(db, input);
  if (!pool) return { poolFound: false, summary: null, missingCandidateIds: [] };

  const candidateUpdates = dedupeCandidateStatusUpdates(input.candidates ?? []);
  let candidatesChanged = false;

  if (candidateUpdates.length > 0) {
    const candidateRows = await db
      .select({
        id: schema.capacityPoolCandidates.id,
        status: schema.capacityPoolCandidates.status,
      })
      .from(schema.capacityPoolCandidates)
      .where(
        and(
          eq(schema.capacityPoolCandidates.poolId, pool.id),
          inArray(
            schema.capacityPoolCandidates.id,
            candidateUpdates.map((candidate) => candidate.id)
          )
        )
      );

    const candidateById = new Map(candidateRows.map((candidate) => [candidate.id, candidate]));
    const missingCandidateIds = candidateUpdates
      .map((candidate) => candidate.id)
      .filter((candidateId) => !candidateById.has(candidateId));

    if (missingCandidateIds.length > 0) {
      return { poolFound: true, summary: null, missingCandidateIds };
    }

    const now = new Date().toISOString();
    for (const candidate of candidateUpdates) {
      const existing = candidateById.get(candidate.id);
      if (!existing || existing.status === candidate.status) continue;

      await db
        .update(schema.capacityPoolCandidates)
        .set({ status: candidate.status, updatedAt: now })
        .where(
          and(
            eq(schema.capacityPoolCandidates.poolId, pool.id),
            eq(schema.capacityPoolCandidates.id, candidate.id)
          )
        );
      candidatesChanged = true;
    }
  }

  const policy = input.policy ?? {};
  const strategyChanged = policy.strategy !== undefined && policy.strategy !== pool.strategy;
  const exhaustionPolicyChanged =
    policy.exhaustionPolicy !== undefined && policy.exhaustionPolicy !== pool.exhaustionPolicy;
  const policyChanged = strategyChanged || exhaustionPolicyChanged;

  if (policyChanged || candidatesChanged) {
    await db
      .update(schema.capacityPools)
      .set({
        ...(strategyChanged ? { strategy: policy.strategy } : {}),
        ...(exhaustionPolicyChanged ? { exhaustionPolicy: policy.exhaustionPolicy } : {}),
        revision: sql`${schema.capacityPools.revision} + 1`,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.capacityPools.id, pool.id));
  }

  if (candidatesChanged) {
    await reconcileDefaultPoolStatus(db, pool.id);
  }

  return {
    poolFound: true,
    summary: await readDefaultPoolSummary(db, input),
    missingCandidateIds: [],
  };
}

function dedupeCandidateStatusUpdates(
  candidates: { id: string; status: CapacityPoolStatus }[]
): { id: string; status: CapacityPoolStatus }[] {
  const statusesByCandidateId = new Map<string, CapacityPoolStatus>();
  for (const candidate of candidates) {
    const id = candidate.id.trim();
    if (id.length === 0) continue;
    statusesByCandidateId.set(id, candidate.status);
  }
  return [...statusesByCandidateId.entries()].map(([id, status]) => ({ id, status }));
}
