import { DEFAULT_CAPACITY_POOL_DEPLOYMENT_STRATEGY } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';

import * as schema from '../db/schema';
import { nextCapacityPoolTimestamp } from './capacity-pool-clock';
import {
  DEFAULT_CAPACITY_POOL_CANDIDATE_PUBLISH_BATCH_SIZE,
  ensureCandidatesForSource,
} from './default-capacity-pool-candidates';
import { defaultPoolId } from './default-capacity-pool-helpers';
import {
  disableCapacitySourceAvailability,
  disableCapacitySourcesMissingFromSeeds,
  disableDefaultPoolAvailability,
  findCapacitySourceForCredential,
  insertCapacitySourceForSeed,
  isCapacitySeedStillCurrent,
  isCapacitySourceRefreshCurrent,
  sourceIdentityKeyForSeed,
  updateCapacitySourceForSeed,
} from './default-capacity-pool-sources';
import {
  ACTIVE_STATUS,
  numberFromString,
  platformSettingsCursorStore,
  readCapacityPoolScopeGeneration,
} from './default-capacity-pool-storage';
import {
  findDefaultPool,
  readDefaultPoolSummary,
  reconcileDefaultPoolStatus,
} from './default-capacity-pool-summaries';
import {
  type CapacityPoolSummary,
  type CredentialCapacitySeed,
  type Db,
  type DefaultCapacityPoolsBackfillOptions,
  type PoolPublicationGuard,
  type ScopeIdentity,
} from './default-capacity-pool-types';
import {
  DEFAULT_EXHAUSTION_POLICY,
  DEFAULT_POOL_NAMES,
  DEFAULT_POOL_STRATEGY,
} from './default-capacity-pools-common';
import {
  ensureCapacitySourceCredentialAnchor,
  resolveOfferingsForSeed,
} from './default-capacity-source-credentials';
import {
  listInstallationProviderCatalogSeeds,
  listProjectProviderCatalogSeeds,
  listUserProviderCatalogSeeds,
  type ProviderCatalogCredentialSeed,
} from './provider-catalogs';

export async function ensureInstallationDefaultPool(
  db: Db,
  options: DefaultCapacityPoolsBackfillOptions
): Promise<CapacityPoolSummary | null> {
  const scope = {
    scope: 'installation',
    ownerUserId: null,
    ownerProjectId: null,
  } satisfies ScopeIdentity;
  const seedSnapshotGeneration = await readCapacityPoolScopeGeneration(db, scope);
  await options.beforeCredentialSeedSelection?.({ scope, seedSnapshotGeneration });
  const seeds = await listInstallationProviderCatalogSeeds(db);
  await options.afterCredentialSeedSelection?.({
    scope,
    seedSnapshotGeneration,
    seedCount: seeds.length,
  });
  return ensureDefaultPoolForCredentialSeeds(
    db,
    scope,
    seedSnapshotGeneration,
    catalogSeedsToCapacitySeeds(scope, seeds),
    options
  );
}

export async function ensureUserDefaultPool(
  db: Db,
  userId: string,
  options: DefaultCapacityPoolsBackfillOptions
): Promise<CapacityPoolSummary | null> {
  const scope = {
    scope: 'user',
    ownerUserId: userId,
    ownerProjectId: null,
  } satisfies ScopeIdentity;
  const seedSnapshotGeneration = await readCapacityPoolScopeGeneration(db, scope);
  await options.beforeCredentialSeedSelection?.({ scope, seedSnapshotGeneration });
  const seeds = await listUserProviderCatalogSeeds(db, { userId });
  await options.afterCredentialSeedSelection?.({
    scope,
    seedSnapshotGeneration,
    seedCount: seeds.length,
  });
  return ensureDefaultPoolForCredentialSeeds(
    db,
    scope,
    seedSnapshotGeneration,
    catalogSeedsToCapacitySeeds(scope, seeds),
    options
  );
}

export async function ensureProjectDefaultPool(
  db: Db,
  projectId: string,
  options: DefaultCapacityPoolsBackfillOptions
): Promise<CapacityPoolSummary | null> {
  const scope = {
    scope: 'project',
    ownerUserId: null,
    ownerProjectId: projectId,
  } satisfies ScopeIdentity;
  const seedSnapshotGeneration = await readCapacityPoolScopeGeneration(db, scope);
  await options.beforeCredentialSeedSelection?.({ scope, seedSnapshotGeneration });
  const seeds = await listProjectProviderCatalogSeeds(db, {
    projectId,
    userId: options.userId ?? undefined,
  });
  await options.afterCredentialSeedSelection?.({
    scope,
    seedSnapshotGeneration,
    seedCount: seeds.length,
  });
  return ensureDefaultPoolForCredentialSeeds(
    db,
    scope,
    seedSnapshotGeneration,
    catalogSeedsToCapacitySeeds(scope, seeds),
    options
  );
}

export function catalogSeedsToCapacitySeeds(
  scope: ScopeIdentity,
  seeds: ProviderCatalogCredentialSeed[]
): CredentialCapacitySeed[] {
  return seeds.map((seed) => ({
    ...scope,
    id: seed.id,
    provider: seed.provider,
    active: seed.active,
    credentialSource: seed.credentialSource,
    credentialReference: seed.credentialReference,
    credentialVersion: seed.credentialVersion,
    credentialId: seed.capacitySourceCredentialId,
    catalogCredentialId: seed.credentialId,
    platformCredentialId: seed.platformCredentialId,
    externalSourceRef: seed.externalSourceRef,
    encryptedToken: seed.encryptedToken,
    iv: seed.iv,
    createdBy: seed.createdBy,
    stateFingerprint: seed.stateFingerprint,
  }));
}

export async function ensureDefaultPoolForCredentialSeeds(
  db: Db,
  scope: ScopeIdentity,
  seedSnapshotGeneration: number,
  seeds: CredentialCapacitySeed[],
  options: DefaultCapacityPoolsBackfillOptions
): Promise<CapacityPoolSummary | null> {
  const activeSeeds = seeds.filter((seed) => seed.active);
  const existingPool = await findDefaultPool(db, scope);

  if (activeSeeds.length === 0) {
    if (existingPool)
      await disableDefaultPoolAvailability(db, existingPool.id, seedSnapshotGeneration);
    return readDefaultPoolSummary(db, scope, { includeDisabled: true });
  }

  const pool =
    existingPool ??
    (await createDefaultPoolIfAbsent(db, {
      ...scope,
      createdBy: activeSeeds[0]?.createdBy ?? null,
    }));
  const poolGuard: PoolPublicationGuard = {
    revision: pool.revision,
    updatedAt: pool.updatedAt,
    status: pool.status,
    sourceGenerations: [],
  };
  const activeSeedKeys = new Set<string>();
  let publicationComplete = true;

  const publications = await Promise.all(
    seeds.map(async (seed) => {
      if (seed.active && !(await isCapacitySeedStillCurrent(db, seed))) return;
      // No credential copy: the anchor row carries no secret. The source binds to the EXACT
      // credential via credential_source + credential_reference + external_source_ref +
      // credential_version; the anchor only satisfies the shipped capacity_sources CHECK.
      const materializedSeed = seed.active
        ? await ensureCapacitySourceCredentialAnchor(db, seed)
        : seed;
      if (materializedSeed.active && !(await isCapacitySeedStillCurrent(db, seed))) return;
      const existingSource = await findCapacitySourceForCredential(db, materializedSeed);
      if (!materializedSeed.active) {
        if (
          existingSource &&
          existingSource.sourceGeneration <= seedSnapshotGeneration &&
          (await isCapacitySeedStillCurrent(db, seed, false))
        ) {
          await disableCapacitySourceAvailability(db, scope, existingSource);
        }
        return;
      }
      activeSeedKeys.add(sourceIdentityKeyForSeed(materializedSeed));
      await options.beforeSourcePublication?.({ seed: materializedSeed, existingSource });
      if (!(await isCapacitySeedStillCurrent(db, seed))) return;

      const publication = existingSource
        ? await updateCapacitySourceForSeed(db, existingSource, materializedSeed, scope)
        : await insertCapacitySourceForSeed(db, materializedSeed, scope);
      if (publication.source.status !== ACTIVE_STATUS) return;
      // A newer publisher owns this refresh; do not certify its unfinished candidates.
      if (!publication.published) {
        return false;
      }
      poolGuard.sourceGenerations?.push({
        id: publication.source.id,
        generation: publication.generation,
      });
      if (!(await isCapacitySeedStillCurrent(db, seed))) {
        await disableCapacitySourceAvailability(db, scope, publication.source);
        return;
      }

      const resolvedOfferings = await resolveOfferingsForSeed(materializedSeed, options);
      const sourceStillCurrent = await isCapacitySourceRefreshCurrent(db, publication);
      if (!sourceStillCurrent || !(await isCapacitySeedStillCurrent(db, seed))) return;
      const [existingCandidate] = await db
        .select({ id: schema.capacityPoolCandidates.id })
        .from(schema.capacityPoolCandidates)
        .where(
          and(
            eq(schema.capacityPoolCandidates.poolId, pool.id),
            eq(schema.capacityPoolCandidates.capacitySourceId, publication.source.id)
          )
        )
        .limit(1);
      // Failed catalogs can seed a newly created source only. Existing sources retain
      // known-empty API catalogs and explicit membership, including deleted candidates.
      if (resolvedOfferings.refreshSucceeded || (!existingSource && !existingCandidate)) {
        const result = await ensureCandidatesForSource(
          db,
          pool.id,
          publication.source.id,
          materializedSeed.provider,
          resolvedOfferings.offerings,
          {
            sourceGeneration: publication.generation,
            sourceAuthorityGeneration: publication.source.authorityGeneration,
            catalogComplete:
              resolvedOfferings.refreshSucceeded && resolvedOfferings.catalogComplete !== false,
            publishBatchSize: resolveCandidatePublishBatchSize(options),
            cursorStore: platformSettingsCursorStore(db, {
              sourceId: publication.source.id,
              generation: publication.generation,
            }),
          }
        );
        publicationComplete &&= result.publicationComplete;
      } else {
        // A failed refresh cannot certify completion of an earlier bounded publication.
        publicationComplete &&= pool.migrationState === 'complete';
      }
    })
  );
  if (publications.some((published) => published === false))
    return readDefaultPoolSummary(db, scope, { includeDisabled: true });

  await disableCapacitySourcesMissingFromSeeds(db, scope, activeSeedKeys, seedSnapshotGeneration);
  await reconcileDefaultPoolStatus(db, pool.id, poolGuard, { publicationComplete });
  return readDefaultPoolSummary(db, scope, { includeDisabled: true });
}

export async function createDefaultPoolIfAbsent(
  db: Db,
  input: ScopeIdentity & { createdBy: string | null }
): Promise<schema.CapacityPool> {
  const id = defaultPoolId(input);
  const now = nextCapacityPoolTimestamp();
  await db
    .insert(schema.capacityPools)
    .values({
      id,
      scope: input.scope,
      ownerUserId: input.ownerUserId,
      ownerProjectId: input.ownerProjectId,
      name: DEFAULT_POOL_NAMES[input.scope],
      isDefault: true,
      revision: 1,
      status: ACTIVE_STATUS,
      configurationState: 'migration-pending',
      strategy: DEFAULT_POOL_STRATEGY,
      deploymentStrategy: DEFAULT_CAPACITY_POOL_DEPLOYMENT_STRATEGY,
      exhaustionPolicy: DEFAULT_EXHAUSTION_POLICY,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  const pool = await findDefaultPool(db, input);
  if (pool) return pool;

  const [deterministicPool] = await db
    .select()
    .from(schema.capacityPools)
    .where(eq(schema.capacityPools.id, id))
    .limit(1);
  if (!deterministicPool) {
    throw new Error(`Failed to create or find default capacity pool for ${input.scope}`);
  }

  try {
    await db
      .update(schema.capacityPools)
      .set({
        isDefault: true,
        status: ACTIVE_STATUS,
        configurationState: 'migration-pending',
        updatedAt: now,
      })
      .where(eq(schema.capacityPools.id, deterministicPool.id));
  } catch (error) {
    const racedPool = await findDefaultPool(db, input);
    if (racedPool) return racedPool;
    throw error;
  }

  const promotedPool = await findDefaultPool(db, input);
  if (!promotedPool) {
    throw new Error(`Failed to promote default capacity pool for ${input.scope}`);
  }
  return promotedPool;
}

export function resolveCandidatePublishBatchSize(
  options: DefaultCapacityPoolsBackfillOptions
): number {
  const configured =
    options.candidatePublishBatchSize ??
    numberFromString(options.env?.CAPACITY_POOL_CANDIDATE_PUBLISH_BATCH_SIZE);
  if (configured === undefined || !Number.isSafeInteger(configured) || configured <= 0) {
    return DEFAULT_CAPACITY_POOL_CANDIDATE_PUBLISH_BATCH_SIZE;
  }
  return configured;
}
