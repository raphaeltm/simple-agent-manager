import type {
  CapacityPoolScope,
  SafeEffectiveCapacityPoolSummary,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { nextCapacityPoolTimestamp } from './capacity-pool-clock';
import { effectiveDefaultCapacityPoolScopeChain } from './capacity-pool-precedence';
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
  BACKFILL_PROJECT_CURSOR_KEY,
  BACKFILL_USER_CURSOR_KEY,
  listCredentialProjectIdsForBackfill,
  listCredentialUserIdsForBackfill,
  numberFromString,
  platformSettingsCursorStore,
  readCapacityPoolScopeGeneration,
  resolveBackfillScopeBatchSize,
  writeBackfillCursor,
} from './default-capacity-pool-storage';
import {
  findDefaultPool,
  readDefaultPoolSummary,
  reconcileDefaultPoolStatus,
  toSafeEffectiveCapacityPoolSummary,
} from './default-capacity-pool-summaries';
import {
  type CapacityPoolSummary,
  type CapacityPoolSummaryWorkloadRoles,
  type CredentialCapacitySeed,
  type Db,
  type DefaultCapacityPoolOfferingResolver,
  type DefaultCapacityPoolsBackfillOptions,
  type DefaultCapacityPoolsEnsureResult,
  type PoolPublicationGuard,
  type ScopeIdentity,
} from './default-capacity-pool-types';
import {
  ensureCapacitySourceCredentialAnchor,
  resolveOfferingsForSeed,
  scrubCapacitySourceCredentialSecrets,
} from './default-capacity-source-credentials';
import {
  listInstallationProviderCatalogSeeds,
  listProjectProviderCatalogSeeds,
  listUserProviderCatalogSeeds,
  type ProviderCatalogCredentialSeed,
} from './provider-catalogs';

export {
  findDefaultPool,
  readDefaultPoolSummary,
  reconcileDefaultPoolStatus,
  type ReconcileDefaultPoolStatusOptions,
  toSafeEffectiveCapacityPoolSummary,
} from './default-capacity-pool-summaries';
export {
  type CapacityPoolSummary,
  type CapacityPoolSummaryWorkloadRoles,
  type CredentialCapacitySeed,
  type DefaultCapacityPoolOfferingResolution,
  type DefaultCapacityPoolOfferingResolver,
  type DefaultCapacityPoolsBackfillOptions,
  type DefaultCapacityPoolsEnsureResult,
} from './default-capacity-pool-types';

const DEFAULT_POOL_NAMES: Record<CapacityPoolScope, string> = {
  installation: 'Installation default',
  user: 'User default',
  project: 'Project default',
};

const DEFAULT_POOL_STRATEGY = 'balanced';

const DEFAULT_EXHAUSTION_POLICY = 'queue';

export async function ensureDefaultCapacityPoolsForExistingCredentials(
  db: Db,
  options: DefaultCapacityPoolsBackfillOptions = {}
): Promise<DefaultCapacityPoolsEnsureResult> {
  const installation =
    options.includeInstallation === false ? null : await ensureInstallationDefaultPool(db, options);
  const user = options.userId ? await ensureUserDefaultPool(db, options.userId, options) : null;
  const project = options.projectId
    ? await ensureProjectDefaultPool(db, options.projectId, options)
    : null;
  return { installation, user, project };
}

export async function backfillDefaultCapacityPoolsForExistingCredentials(
  db: Db,
  options: DefaultCapacityPoolsBackfillOptions = {}
): Promise<{
  installation: CapacityPoolSummary | null;
  usersEnsured: number;
  projectsEnsured: number;
  credentialAnchorsScrubbed: number;
  credentialAnchorsPending: boolean;
}> {
  const installation =
    options.includeInstallation === false ? null : await ensureInstallationDefaultPool(db, options);

  const scopeBatchSize = resolveBackfillScopeBatchSize(options);
  const userIds = options.userId
    ? [options.userId]
    : await listCredentialUserIdsForBackfill(db, scopeBatchSize);
  const projectIds = options.projectId
    ? [options.projectId]
    : await listCredentialProjectIdsForBackfill(db, scopeBatchSize);

  let usersEnsured = 0;
  for (const userId of userIds) {
    await ensureUserDefaultPool(db, userId, options);
    usersEnsured += 1;
    if (!options.userId) await writeBackfillCursor(db, BACKFILL_USER_CURSOR_KEY, userId);
  }

  let projectsEnsured = 0;
  for (const projectId of projectIds) {
    await ensureProjectDefaultPool(db, projectId, options);
    projectsEnsured += 1;
    if (!options.projectId) await writeBackfillCursor(db, BACKFILL_PROJECT_CURSOR_KEY, projectId);
  }

  const anchors = await scrubCapacitySourceCredentialSecrets(db, {
    batchSize: options.credentialAnchorScrubBatchSize,
  }).catch((error: unknown) => {
    // Best-effort cleanup of SAM-generated anchors; it must never block pool reconciliation.
    // The next pass retries because the rows are still present.
    log.warn('default_capacity_pools.credential_anchor_scrub_failed', serializeError(error));
    return { scrubbedAnchors: 0, deletedUnreferencedAnchors: 0, hasMore: true };
  });

  return {
    installation,
    usersEnsured,
    projectsEnsured,
    credentialAnchorsScrubbed: anchors.scrubbedAnchors,
    credentialAnchorsPending: anchors.hasMore,
  };
}

export async function requestDefaultCapacityPoolBackfillRetry(
  db: Db,
  input: { users?: boolean; projects?: boolean } = {}
): Promise<void> {
  if (input.users !== false) {
    await writeBackfillCursor(db, BACKFILL_USER_CURSOR_KEY, null);
  }
  if (input.projects !== false) {
    await writeBackfillCursor(db, BACKFILL_PROJECT_CURSOR_KEY, null);
  }
}

export async function resolveEffectiveDefaultCapacityPoolSummary(
  db: Db,
  input: {
    userId: string;
    projectId?: string | null;
    ensure?: boolean;
    /** Placement reads existing authority without synchronously refreshing catalogs. */
    initializeOnly?: boolean;
    includeInstallation?: boolean;
    env?: Env;
    offeringResolver?: DefaultCapacityPoolOfferingResolver;
    /** Placement callers pass 'all' to see the coupled non-primary workload-role rows. */
    workloadRoles?: CapacityPoolSummaryWorkloadRoles;
  }
): Promise<CapacityPoolSummary | null> {
  if (input.ensure === true && !input.initializeOnly) {
    await ensureDefaultCapacityPoolsForExistingCredentials(db, {
      userId: input.userId,
      projectId: input.projectId ?? null,
      includeInstallation: input.includeInstallation,
      env: input.env,
      offeringResolver: input.offeringResolver,
    });
  }

  // One ordering, shared with the final-admission SQL predicate. The first scope
  // that HAS a default pool row wins outright: an existing but unusable pool
  // (configured-empty, source-disabled, disabled) is still authoritative and must
  // never fall through to a lower scope.
  const scopes = effectiveDefaultCapacityPoolScopeChain({
    userId: input.userId,
    projectId: input.projectId ?? null,
    includeInstallation: input.includeInstallation,
  });
  for (const scope of scopes) {
    if (await findDefaultPool(db, scope)) {
      return readDefaultPoolSummary(db, scope, {
        includeDisabled: true,
        workloadRoles: input.workloadRoles,
      });
    }
  }

  // Existing pools are authoritative snapshots. Catalog reconciliation belongs
  // to credential lifecycle hooks and the scheduled reconciler, not every submit.
  // Preserve lazy initialization for installations with no materialized pool yet.
  if (input.ensure === true && input.initializeOnly) {
    await ensureDefaultCapacityPoolsForExistingCredentials(db, {
      userId: input.userId,
      projectId: input.projectId ?? null,
      includeInstallation: input.includeInstallation,
      env: input.env,
      offeringResolver: input.offeringResolver,
    });
    return resolveEffectiveDefaultCapacityPoolSummary(db, { ...input, ensure: false });
  }

  return null;
}

export async function resolveSafeEffectiveDefaultCapacityPoolSummary(
  db: Db,
  input: {
    userId: string;
    projectId?: string | null;
    ensure?: boolean;
    includeInstallation?: boolean;
    env?: Env;
    offeringResolver?: DefaultCapacityPoolOfferingResolver;
  }
): Promise<SafeEffectiveCapacityPoolSummary> {
  return toSafeEffectiveCapacityPoolSummary(
    await resolveEffectiveDefaultCapacityPoolSummary(db, input)
  );
}

export async function readDefaultCapacityPoolSummaries(
  db: Db,
  options: DefaultCapacityPoolsBackfillOptions & {
    ensure?: boolean;
    includeDisabled?: boolean;
  } = {}
): Promise<DefaultCapacityPoolsEnsureResult> {
  if (options.ensure) {
    await ensureDefaultCapacityPoolsForExistingCredentials(db, options);
  }

  const installation =
    options.includeInstallation === false
      ? null
      : await readDefaultPoolSummary(
          db,
          {
            scope: 'installation',
            ownerUserId: null,
            ownerProjectId: null,
          },
          options
        );
  const user = options.userId
    ? await readDefaultPoolSummary(
        db,
        {
          scope: 'user',
          ownerUserId: options.userId,
          ownerProjectId: null,
        },
        options
      )
    : null;
  const project = options.projectId
    ? await readDefaultPoolSummary(
        db,
        {
          scope: 'project',
          ownerUserId: null,
          ownerProjectId: options.projectId,
        },
        options
      )
    : null;

  return { installation, user, project };
}

async function ensureInstallationDefaultPool(
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

async function ensureUserDefaultPool(
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

async function ensureProjectDefaultPool(
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

function catalogSeedsToCapacitySeeds(
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

async function ensureDefaultPoolForCredentialSeeds(
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

  for (const seed of seeds) {
    if (seed.active && !(await isCapacitySeedStillCurrent(db, seed))) continue;
    // No credential copy: the anchor row carries no secret. The source binds to the EXACT
    // credential via credential_source + credential_reference + external_source_ref +
    // credential_version; the anchor only satisfies the shipped capacity_sources CHECK.
    const materializedSeed = seed.active
      ? await ensureCapacitySourceCredentialAnchor(db, seed)
      : seed;
    if (materializedSeed.active && !(await isCapacitySeedStillCurrent(db, seed))) continue;
    const existingSource = await findCapacitySourceForCredential(db, materializedSeed);
    if (!materializedSeed.active) {
      if (
        existingSource &&
        existingSource.sourceGeneration <= seedSnapshotGeneration &&
        (await isCapacitySeedStillCurrent(db, seed, false))
      ) {
        await disableCapacitySourceAvailability(db, scope, existingSource);
      }
      continue;
    }
    activeSeedKeys.add(sourceIdentityKeyForSeed(materializedSeed));
    await options.beforeSourcePublication?.({ seed: materializedSeed, existingSource });
    if (!(await isCapacitySeedStillCurrent(db, seed))) continue;

    const publication = existingSource
      ? await updateCapacitySourceForSeed(db, existingSource, materializedSeed, scope)
      : await insertCapacitySourceForSeed(db, materializedSeed, scope);
    if (publication.source.status !== ACTIVE_STATUS) continue;
    // A newer publisher owns this refresh; do not certify its unfinished candidates.
    if (!publication.published) {
      return readDefaultPoolSummary(db, scope, { includeDisabled: true });
    }
    poolGuard.sourceGenerations?.push({
      id: publication.source.id,
      generation: publication.generation,
    });
    if (!(await isCapacitySeedStillCurrent(db, seed))) {
      await disableCapacitySourceAvailability(db, scope, publication.source);
      continue;
    }

    const resolvedOfferings = await resolveOfferingsForSeed(materializedSeed, options);
    const sourceStillCurrent = await isCapacitySourceRefreshCurrent(db, publication);
    if (!sourceStillCurrent || !(await isCapacitySeedStillCurrent(db, seed))) continue;
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
  }

  await disableCapacitySourcesMissingFromSeeds(db, scope, activeSeedKeys, seedSnapshotGeneration);
  await reconcileDefaultPoolStatus(db, pool.id, poolGuard, { publicationComplete });
  return readDefaultPoolSummary(db, scope, { includeDisabled: true });
}

async function createDefaultPoolIfAbsent(
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

function resolveCandidatePublishBatchSize(options: DefaultCapacityPoolsBackfillOptions): number {
  const configured =
    options.candidatePublishBatchSize ??
    numberFromString(options.env?.CAPACITY_POOL_CANDIDATE_PUBLISH_BATCH_SIZE);
  if (configured === undefined || !Number.isSafeInteger(configured) || configured <= 0) {
    return DEFAULT_CAPACITY_POOL_CANDIDATE_PUBLISH_BATCH_SIZE;
  }
  return configured;
}
