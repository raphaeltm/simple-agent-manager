import { DEFAULT_CAPACITY_POOL_DEPLOYMENT_STRATEGY } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';

import * as schema from '../db/schema';
import { log, serializeError } from '../lib/logger';
import { resolveAdminSetting } from './admin-settings';
import { nextCapacityPoolTimestamp } from './capacity-pool-clock';
import { withCapacityPoolRefresh } from './capacity-pool-refresh-operation';
import {
  DEFAULT_CAPACITY_POOL_CANDIDATE_PUBLISH_BATCH_SIZE,
  ensureCandidatesForSource,
} from './default-capacity-pool-candidates';
import { DEFAULT_CAPACITY_POOL_CANDIDATE_PUBLISH_BUDGET_MS } from './default-capacity-pool-candidates-common';
import { composableAttachmentReference, defaultPoolId } from './default-capacity-pool-helpers';
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
import { type ManagedGcpCredentialMirror } from './gcp-credential-mirrors';
import { reconcileManagedGcpPoolMirror } from './gcp-pool-mirror-reconciliation';
import {
  listInstallationProviderCatalogSeeds,
  listProjectProviderCatalogSeeds,
  listUserProviderCatalogSeedSnapshot,
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
  const { seeds, managedGcpMirrors } = await listUserProviderCatalogSeedSnapshot(db, { userId });
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
    options,
    managedGcpMirrors
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
  options: DefaultCapacityPoolsBackfillOptions,
  managedGcpMirrors: ManagedGcpCredentialMirror[] = []
): Promise<CapacityPoolSummary | null> {
  return withCapacityPoolRefresh(
    db,
    scope,
    options,
    seeds.every((seed) => !seed.active),
    (boundedOptions) =>
      publishDefaultPoolForCredentialSeeds(
        db,
        scope,
        seedSnapshotGeneration,
        seeds,
        boundedOptions,
        managedGcpMirrors
      )
  );
}

async function publishDefaultPoolForCredentialSeeds(
  db: Db,
  scope: ScopeIdentity,
  seedSnapshotGeneration: number,
  seeds: CredentialCapacitySeed[],
  options: DefaultCapacityPoolsBackfillOptions,
  managedGcpMirrors: ManagedGcpCredentialMirror[]
): Promise<CapacityPoolSummary | null> {
  const activeSeeds = seeds.filter((seed) => seed.active);
  const existingPool = await findDefaultPool(db, scope);
  // Catalog discovery is never permission to reactivate a deliberately disabled/deleted pool.
  if (existingPool && existingPool.status !== ACTIVE_STATUS)
    return readDefaultPoolSummary(db, scope, { includeDisabled: true });

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
  let poolGuard: PoolPublicationGuard = {
    revision: pool.revision,
    updatedAt: pool.updatedAt,
    status: pool.status,
    sourceGenerations: [],
  };
  const activeSeedKeys = new Set<string>(activeSeeds.map(sourceIdentityKeyForSeed));
  // Mark progress before provider I/O; the old complete catalog retains its independent proof.
  await db
    .update(schema.capacityPools)
    .set({
      migrationState: 'pending',
      catalogPublishedAt:
        pool.catalogPublishedAt ??
        (pool.migrationState === 'complete' && pool.configurationState !== 'migration-pending'
          ? (pool.lastReconciledAt ?? pool.updatedAt)
          : null),
    })
    .where(
      and(
        eq(schema.capacityPools.id, pool.id),
        eq(schema.capacityPools.revision, poolGuard.revision),
        eq(schema.capacityPools.updatedAt, poolGuard.updatedAt)
      )
    );
  let publicationComplete = true;
  let selectionRevisionAlreadyBumped = false;
  const publishBudgetMs = await resolveCandidatePublishBudgetMs(options);

  const publications = [];
  for (const seed of seeds) {
    publications.push(
      await (async () => {
        if (seed.active && Date.now() >= (options.reconciliationDeadlineAt ?? Infinity)) {
          publicationComplete = false;
          return;
        }
        if (seed.active && !(await isCapacitySeedStillCurrent(db, seed))) return;
        // No credential copy: the anchor row carries no secret. The source binds to the EXACT
        // credential via credential_source + credential_reference + external_source_ref +
        // credential_version; the anchor only satisfies the shipped capacity_sources CHECK.
        const materializedSeed = seed.active
          ? await ensureCapacitySourceCredentialAnchor(db, seed)
          : seed;
        if (materializedSeed.active && !(await isCapacitySeedStillCurrent(db, seed))) return;
        const existingSource = await findCapacitySourceForCredential(db, materializedSeed);
        // Credential lifecycle hooks/manual Refresh can re-enable a reconnected account;
        // an old automatic continuation cannot revive disabled authority.
        if (
          options.refreshContinuation &&
          materializedSeed.active &&
          existingSource &&
          existingSource.status !== ACTIVE_STATUS
        )
          return;
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
        if (Date.now() >= (options.reconciliationDeadlineAt ?? Infinity)) {
          publicationComplete = false;
          return;
        }
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
              poolPublicationGuard: poolGuard,
              sourceGeneration: publication.generation,
              sourceAuthorityGeneration: publication.source.authorityGeneration,
              catalogValidated: resolvedOfferings.catalogValidated,
              catalogComplete:
                resolvedOfferings.refreshSucceeded && resolvedOfferings.catalogComplete !== false,
              publishBatchSize: resolveCandidatePublishBatchSize(options),
              // Measured from publication start, so a slow catalog fetch cannot spend it.
              publishDeadlineAt: Math.min(
                Date.now() + publishBudgetMs,
                options.reconciliationDeadlineAt ?? Infinity
              ),
              cursorStore: platformSettingsCursorStore(db, {
                sourceId: publication.source.id,
                generation: publication.generation,
              }),
            }
          );
          if (result.poolPublicationGuard) {
            selectionRevisionAlreadyBumped ||=
              result.poolPublicationGuard.revision !== poolGuard.revision;
            poolGuard = {
              ...result.poolPublicationGuard,
              sourceGenerations: poolGuard.sourceGenerations,
            };
          }
          publicationComplete &&=
            result.publicationComplete &&
            resolvedOfferings.refreshSucceeded &&
            resolvedOfferings.catalogValidated === true;
        } else {
          // A failed refresh cannot certify completion of an earlier bounded publication.
          publicationComplete = false;
        }
      })()
    );
  }
  if (publications.some((published) => published === false))
    return readDefaultPoolSummary(db, scope, { includeDisabled: true });

  for (const mirror of managedGcpMirrors) {
    // Never let generic retirement discard choices if the fenced repair deferred.
    activeSeedKeys.add(`external:${composableAttachmentReference(mirror.attachmentId)}`);
    const repairedGuard = await reconcileManagedGcpPoolMirror(
      db,
      scope,
      pool.id,
      poolGuard,
      mirror,
      seedSnapshotGeneration,
      resolveCandidatePublishBatchSize(options)
    );
    if (repairedGuard) {
      poolGuard = repairedGuard;
      selectionRevisionAlreadyBumped = true;
    }
  }
  await disableCapacitySourcesMissingFromSeeds(db, scope, activeSeedKeys, seedSnapshotGeneration);
  await reconcileDefaultPoolStatus(db, pool.id, poolGuard, {
    publicationComplete,
    selectionRevisionAlreadyBumped,
  });
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

/**
 * Per-source publication budget for one pass: explicit option, then the admin setting, then
 * the default. A settings outage must not stall publication, so it degrades to the default.
 */
export async function resolveCandidatePublishBudgetMs(
  options: DefaultCapacityPoolsBackfillOptions
): Promise<number> {
  const valid = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (options.candidatePublishBudgetMs !== undefined) {
    return valid(options.candidatePublishBudgetMs)
      ? options.candidatePublishBudgetMs
      : DEFAULT_CAPACITY_POOL_CANDIDATE_PUBLISH_BUDGET_MS;
  }
  if (!options.env) return DEFAULT_CAPACITY_POOL_CANDIDATE_PUBLISH_BUDGET_MS;
  try {
    const configured = await resolveAdminSetting(
      options.env,
      'operations.capacityPoolPublishBudgetMs'
    );
    return valid(configured) ? configured : DEFAULT_CAPACITY_POOL_CANDIDATE_PUBLISH_BUDGET_MS;
  } catch (error) {
    log.warn('default_capacity_pools.publish_budget_setting_unavailable', serializeError(error));
    return DEFAULT_CAPACITY_POOL_CANDIDATE_PUBLISH_BUDGET_MS;
  }
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
