/**
 * Picks machines in a test's default pools, the way a person does in the pool editor.
 *
 * Until 2026-11-09 a new pool switched on, by itself, every machine that maps to the old
 * `small`/`medium`/`large` sizes, and many fixtures relied on that. Nothing joins a pool on its
 * own now (tasks/active/2026-11-09-compute-pool-editor-redesign.md), so a fixture that needs a
 * placeable pool picks those same machines explicitly, through the real update service, after
 * the pools exist.
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { updateDefaultCapacityPool } from '../../src/services/default-capacity-pool-updates';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../src/services/default-capacity-pools';

type Db = ReturnType<typeof drizzle>;

export interface StarterMachineOptions {
  /** Only these pool scopes. Default: every default pool. */
  scopes?: Array<'project' | 'user' | 'installation'>;
}

/** Picks, in every existing default pool, the machines a legacy size maps to. */
export async function pickStarterMachines(
  db: Db,
  options: StarterMachineOptions = {}
): Promise<void> {
  const pools = await db
    .select()
    .from(schema.capacityPools)
    .where(
      and(
        eq(schema.capacityPools.isDefault, true),
        options.scopes ? inArray(schema.capacityPools.scope, options.scopes) : undefined
      )
    );
  for (const pool of pools) {
    const rows = await db
      .select({ id: schema.capacityPoolCandidates.id })
      .from(schema.capacityPoolCandidates)
      .where(
        and(
          eq(schema.capacityPoolCandidates.poolId, pool.id),
          eq(schema.capacityPoolCandidates.workloadRole, 'workspace'),
          eq(schema.capacityPoolCandidates.status, 'disabled'),
          eq(schema.capacityPoolCandidates.catalogAvailability, 'available'),
          isNotNull(schema.capacityPoolCandidates.machineSize),
          isNotNull(schema.capacityPoolCandidates.providerInstanceCatalogSource)
        )
      );
    if (rows.length === 0) continue;
    const result = await updateDefaultCapacityPool(db, {
      scope: pool.scope as 'project' | 'user' | 'installation',
      ownerUserId: pool.ownerUserId,
      ownerProjectId: pool.ownerProjectId,
      candidates: rows.map(({ id }) => ({ id, status: 'active' as const })),
    });
    if (
      result.conflict ||
      result.missingCandidateIds.length ||
      result.unavailableCandidateIds.length
    ) {
      throw new Error(`pickStarterMachines could not pick machines in pool ${pool.id}`);
    }
  }
}

/** Creates the default pools for existing credentials, then picks their starter machines. */
export async function ensurePoolsWithStarterMachines(
  db: Db,
  input: {
    userId: string;
    projectId?: string | null;
    includeInstallation?: boolean;
    env?: Env;
  } & StarterMachineOptions
): Promise<void> {
  await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
    userId: input.userId,
    projectId: input.projectId ?? null,
    includeInstallation: input.includeInstallation,
    env: input.env,
  });
  await pickStarterMachines(db, { scopes: input.scopes });
}
