import type {
  CapacityCredentialSource,
  CapacityPool as CapacityPoolDto,
  CapacityPoolCandidate as CapacityPoolCandidateDto,
  CapacityPoolScope,
  CapacitySourceIdentity,
  CredentialProvider,
  DefaultCapacityPoolSummary,
  ProviderInstanceOffering,
} from '@simple-agent-manager/shared';
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import {
  toCapacityPool,
  toCapacityPoolCandidate,
  toCapacitySourceIdentity,
} from './capacity-pools';
import { ensureCandidatesForSource } from './default-capacity-pool-candidates';
import {
  defaultCapacitySourceId,
  defaultPoolId,
  type DefaultPoolScopeIdentity,
} from './default-capacity-pool-helpers';
import {
  buildProviderCatalogForCredential,
  getStaticProviderCatalogOfferings,
  listInstallationProviderCatalogSeeds,
  listProjectProviderCatalogSeeds,
  listUserProviderCatalogSeeds,
  type ProviderCatalogCredentialSeed,
} from './provider-catalogs';

type Db = ReturnType<typeof drizzle>;

const DEFAULT_POOL_NAMES: Record<CapacityPoolScope, string> = {
  installation: 'Installation default',
  user: 'User default',
  project: 'Project default',
};

const DEFAULT_POOL_STRATEGY = 'balanced';
const DEFAULT_EXHAUSTION_POLICY = 'queue';
const SOURCE_KIND_CLOUD_PROVIDER = 'cloud-provider-credential';
const CREDENTIAL_TYPE_CLOUD_PROVIDER = 'cloud-provider';
const ACTIVE_STATUS = 'active';
const DISABLED_STATUS = 'disabled';
type ScopeIdentity = DefaultPoolScopeIdentity;

interface ReadDefaultPoolSummaryOptions {
  /**
   * Default placement reads must remain active-only. UI/editor reads opt into
   * disabled default pools so users can add back offerings after removing the
   * last active candidate.
   */
  includeDisabled?: boolean;
}

export interface CredentialCapacitySeed extends ScopeIdentity {
  id: string;
  provider: CredentialProvider;
  active: boolean;
  credentialSource: CapacityCredentialSource;
  credentialReference: string;
  credentialVersion: number | null;
  /** Legacy credentials FK. Null for CC-backed and platform-backed sources. */
  credentialId: string | null;
  /** Browser-safe catalog credential id. May be a CC credential id. */
  catalogCredentialId: string | null;
  platformCredentialId: string | null;
  externalSourceRef: string | null;
  encryptedToken: string;
  iv: string;
  createdBy: string | null;
}

export type DefaultCapacityPoolOfferingResolver = (
  seed: CredentialCapacitySeed
) => Promise<ProviderInstanceOffering[]>;

export type CapacityPoolSummary = DefaultCapacityPoolSummary & {
  pool: CapacityPoolDto;
  sources: CapacitySourceIdentity[];
  candidates: CapacityPoolCandidateDto[];
  activeCandidateCount: number;
};

export interface DefaultCapacityPoolsEnsureResult {
  installation: CapacityPoolSummary | null;
  user: CapacityPoolSummary | null;
  project: CapacityPoolSummary | null;
}

export interface DefaultCapacityPoolsBackfillOptions {
  /**
   * Limit user-pool reconciliation to one user. Omit with care: unscoped calls scan
   * existing credential rows and are intended for manual/scheduled backfills only.
   */
  userId?: string | null;
  /**
   * Limit project-pool reconciliation to one project. Project pools are seeded only
   * from real project-scoped credential rows.
   */
  projectId?: string | null;
  includeInstallation?: boolean;
  env?: Env;
  offeringResolver?: DefaultCapacityPoolOfferingResolver;
}

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
}> {
  const installation =
    options.includeInstallation === false ? null : await ensureInstallationDefaultPool(db, options);

  const userIds = options.userId ? [options.userId] : await listCredentialUserIds(db);
  const projectIds = options.projectId ? [options.projectId] : await listCredentialProjectIds(db);

  let usersEnsured = 0;
  for (const userId of userIds) {
    await ensureUserDefaultPool(db, userId, options);
    usersEnsured += 1;
  }

  let projectsEnsured = 0;
  for (const projectId of projectIds) {
    await ensureProjectDefaultPool(db, projectId, options);
    projectsEnsured += 1;
  }

  return { installation, usersEnsured, projectsEnsured };
}

export async function resolveEffectiveDefaultCapacityPoolSummary(
  db: Db,
  input: {
    userId: string;
    projectId?: string | null;
    ensure?: boolean;
    includeInstallation?: boolean;
    env?: Env;
    offeringResolver?: DefaultCapacityPoolOfferingResolver;
  }
): Promise<CapacityPoolSummary | null> {
  if (input.ensure === true) {
    await ensureDefaultCapacityPoolsForExistingCredentials(db, {
      userId: input.userId,
      projectId: input.projectId ?? null,
      includeInstallation: input.includeInstallation,
      env: input.env,
      offeringResolver: input.offeringResolver,
    });
  }

  if (input.projectId) {
    const project = await readDefaultPoolSummary(db, {
      scope: 'project',
      ownerUserId: null,
      ownerProjectId: input.projectId,
    });
    if (project) return project;
  }

  const user = await readDefaultPoolSummary(db, {
    scope: 'user',
    ownerUserId: input.userId,
    ownerProjectId: null,
  });
  if (user) return user;

  if (input.includeInstallation === false) return null;

  return readDefaultPoolSummary(db, {
    scope: 'installation',
    ownerUserId: null,
    ownerProjectId: null,
  });
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

async function listCredentialUserIds(db: Db): Promise<string[]> {
  const legacyRows = await db
    .select({ userId: schema.credentials.userId })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.credentialType, CREDENTIAL_TYPE_CLOUD_PROVIDER),
        isNull(schema.credentials.projectId)
      )
    );
  const ccRows = await db
    .select({ userId: schema.ccAttachments.userId })
    .from(schema.ccAttachments)
    .where(
      and(
        eq(schema.ccAttachments.consumerKind, 'compute'),
        isNull(schema.ccAttachments.projectId)
      )
    );
  return [...new Set([...legacyRows.map((row) => row.userId), ...ccRows.map((row) => row.userId)])];
}

async function listCredentialProjectIds(db: Db): Promise<string[]> {
  const legacyRows = await db
    .select({ projectId: schema.credentials.projectId })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.credentialType, CREDENTIAL_TYPE_CLOUD_PROVIDER),
        isNotNull(schema.credentials.projectId)
      )
    );
  const ccRows = await db
    .select({ projectId: schema.ccAttachments.projectId })
    .from(schema.ccAttachments)
    .where(
      and(
        eq(schema.ccAttachments.consumerKind, 'compute'),
        isNotNull(schema.ccAttachments.projectId)
      )
    );
  return [
    ...new Set(
      [...legacyRows, ...ccRows].flatMap((row) => (row.projectId ? [row.projectId] : []))
    ),
  ];
}

async function ensureInstallationDefaultPool(
  db: Db,
  options: DefaultCapacityPoolsBackfillOptions
): Promise<CapacityPoolSummary | null> {
  return ensureDefaultPoolForCredentialSeeds(
    db,
    { scope: 'installation', ownerUserId: null, ownerProjectId: null },
    catalogSeedsToCapacitySeeds(
      { scope: 'installation', ownerUserId: null, ownerProjectId: null },
      await listInstallationProviderCatalogSeeds(db)
    ),
    options
  );
}

async function ensureUserDefaultPool(
  db: Db,
  userId: string,
  options: DefaultCapacityPoolsBackfillOptions
): Promise<CapacityPoolSummary | null> {
  return ensureDefaultPoolForCredentialSeeds(
    db,
    { scope: 'user', ownerUserId: userId, ownerProjectId: null },
    catalogSeedsToCapacitySeeds(
      { scope: 'user', ownerUserId: userId, ownerProjectId: null },
      await listUserProviderCatalogSeeds(db, { userId })
    ),
    options
  );
}

async function ensureProjectDefaultPool(
  db: Db,
  projectId: string,
  options: DefaultCapacityPoolsBackfillOptions
): Promise<CapacityPoolSummary | null> {
  return ensureDefaultPoolForCredentialSeeds(
    db,
    { scope: 'project', ownerUserId: null, ownerProjectId: projectId },
    catalogSeedsToCapacitySeeds(
      { scope: 'project', ownerUserId: null, ownerProjectId: projectId },
      await listProjectProviderCatalogSeeds(db, { projectId, userId: options.userId ?? undefined })
    ),
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
  }));
}

async function ensureDefaultPoolForCredentialSeeds(
  db: Db,
  scope: ScopeIdentity,
  seeds: CredentialCapacitySeed[],
  options: DefaultCapacityPoolsBackfillOptions
): Promise<CapacityPoolSummary | null> {
  const activeSeeds = seeds.filter((seed) => seed.active);
  const existingPool = await findDefaultPool(db, scope);

  if (activeSeeds.length === 0) {
    if (existingPool) await disableDefaultPoolAvailability(db, existingPool.id);
    return readDefaultPoolSummary(db, scope);
  }

  const pool =
    existingPool ??
    (await createDefaultPoolIfAbsent(db, {
      ...scope,
      createdBy: activeSeeds[0]?.createdBy ?? null,
    }));

  for (const seed of seeds) {
    const existingSource = await findCapacitySourceForCredential(db, seed);
    if (!seed.active) {
      if (existingSource) await disableCapacitySourceAvailability(db, pool.id, existingSource.id);
      continue;
    }

    const source = existingSource
      ? await updateCapacitySourceForSeed(db, existingSource.id, seed)
      : await insertCapacitySourceForSeed(db, seed);

    const offerings = await resolveOfferingsForSeed(seed, options);
    await ensureCandidatesForSource(db, pool.id, source.id, seed.provider, offerings);
  }

  await reconcileDefaultPoolStatus(db, pool.id);
  return readDefaultPoolSummary(db, scope);
}

async function resolveOfferingsForSeed(
  seed: CredentialCapacitySeed,
  options: DefaultCapacityPoolsBackfillOptions
): Promise<ProviderInstanceOffering[]> {
  if (options.offeringResolver) {
    return options.offeringResolver(seed);
  }

  if (options.env) {
    try {
      const catalog = await buildProviderCatalogForCredential({
        env: options.env,
        seed: {
          id: seed.id,
          provider: seed.provider,
          encryptedToken: seed.encryptedToken,
          iv: seed.iv,
          credentialSource: seed.credentialSource,
          credentialId: seed.catalogCredentialId,
          platformCredentialId: seed.platformCredentialId,
          capacitySourceCredentialId: seed.credentialId,
          credentialReference: seed.credentialReference,
          credentialVersion: seed.credentialVersion,
          externalSourceRef: seed.externalSourceRef,
          active: seed.active,
          createdBy: seed.createdBy,
        },
      });
      return catalog.offerings ?? [];
    } catch (error) {
      log.warn('default_capacity_pools.catalog_build_failed', {
        provider: seed.provider,
        scope: seed.scope,
        credentialSource: seed.credentialSource,
        ...serializeError(error),
      });
    }
  }

  return getStaticProviderCatalogOfferings(seed.provider);
}

export async function findDefaultPool(
  db: Db,
  scope: ScopeIdentity
): Promise<schema.CapacityPool | null> {
  const [pool] = await db
    .select()
    .from(schema.capacityPools)
    .where(and(...poolScopePredicates(scope), eq(schema.capacityPools.isDefault, true)))
    .limit(1);
  return pool ?? null;
}

async function createDefaultPoolIfAbsent(
  db: Db,
  input: ScopeIdentity & { createdBy: string | null }
): Promise<schema.CapacityPool> {
  const id = defaultPoolId(input);
  const now = new Date().toISOString();
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
      .set({ isDefault: true, status: ACTIVE_STATUS, updatedAt: now })
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

async function findCapacitySourceForCredential(
  db: Db,
  seed: CredentialCapacitySeed
): Promise<schema.CapacitySource | null> {
  let credentialPredicate;
  if (seed.credentialId) {
    credentialPredicate = eq(schema.capacitySources.credentialId, seed.credentialId);
  } else if (seed.platformCredentialId) {
    credentialPredicate = eq(
      schema.capacitySources.platformCredentialId,
      seed.platformCredentialId
    );
  } else if (seed.externalSourceRef) {
    credentialPredicate = eq(schema.capacitySources.externalSourceRef, seed.externalSourceRef);
  } else if (seed.credentialReference) {
    credentialPredicate = eq(schema.capacitySources.credentialReference, seed.credentialReference);
  } else {
    throw new Error(`Capacity source seed ${seed.id} has no credential reference`);
  }

  const [source] = await db
    .select()
    .from(schema.capacitySources)
    .where(and(...sourceScopePredicates(seed), credentialPredicate))
    .limit(1);
  return source ?? null;
}

async function insertCapacitySourceForSeed(
  db: Db,
  seed: CredentialCapacitySeed
): Promise<schema.CapacitySource> {
  const id = defaultCapacitySourceId(seed);
  const now = new Date().toISOString();
  await db
    .insert(schema.capacitySources)
    .values({
      id,
      scope: seed.scope,
      ownerUserId: seed.ownerUserId,
      ownerProjectId: seed.ownerProjectId,
      sourceKind: SOURCE_KIND_CLOUD_PROVIDER,
      provider: seed.provider,
      credentialSource: seed.credentialSource,
      credentialId: seed.credentialId,
      platformCredentialId: seed.platformCredentialId,
      credentialReference: seed.credentialReference,
      credentialVersion: seed.credentialVersion,
      externalSourceRef: seed.externalSourceRef,
      status: ACTIVE_STATUS,
      createdBy: seed.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.capacitySources.id,
      set: {
        provider: seed.provider,
        credentialSource: seed.credentialSource,
        credentialId: seed.credentialId,
        platformCredentialId: seed.platformCredentialId,
        credentialReference: seed.credentialReference,
        credentialVersion: seed.credentialVersion,
        externalSourceRef: seed.externalSourceRef,
        status: ACTIVE_STATUS,
        updatedAt: now,
      },
    });

  const [source] = await db
    .select()
    .from(schema.capacitySources)
    .where(eq(schema.capacitySources.id, id))
    .limit(1);
  if (!source) throw new Error(`Failed to create default capacity source ${id}`);
  return source;
}

async function updateCapacitySourceForSeed(
  db: Db,
  sourceId: string,
  seed: CredentialCapacitySeed
): Promise<schema.CapacitySource> {
  const now = new Date().toISOString();
  await db
    .update(schema.capacitySources)
    .set({
      provider: seed.provider,
      credentialSource: seed.credentialSource,
      credentialId: seed.credentialId,
      platformCredentialId: seed.platformCredentialId,
      credentialReference: seed.credentialReference,
      credentialVersion: seed.credentialVersion,
      externalSourceRef: seed.externalSourceRef,
      status: ACTIVE_STATUS,
      updatedAt: now,
    })
    .where(eq(schema.capacitySources.id, sourceId));

  const [source] = await db
    .select()
    .from(schema.capacitySources)
    .where(eq(schema.capacitySources.id, sourceId))
    .limit(1);
  if (!source) throw new Error(`Capacity source ${sourceId} disappeared during update`);
  return source;
}

async function disableCapacitySourceAvailability(
  db: Db,
  _poolId: string,
  sourceId: string
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(schema.capacitySources)
    .set({ status: DISABLED_STATUS, updatedAt: now })
    .where(eq(schema.capacitySources.id, sourceId));
}

async function disableDefaultPoolAvailability(db: Db, poolId: string): Promise<void> {
  const sourceRows = await db
    .select({ id: schema.capacitySources.id })
    .from(schema.capacitySources)
    .innerJoin(
      schema.capacityPoolCandidates,
      eq(schema.capacityPoolCandidates.capacitySourceId, schema.capacitySources.id)
    )
    .where(eq(schema.capacityPoolCandidates.poolId, poolId));

  for (const sourceId of new Set(sourceRows.map((row) => row.id))) {
    await disableCapacitySourceAvailability(db, poolId, sourceId);
  }

  await db
    .update(schema.capacityPools)
    .set({ status: DISABLED_STATUS, updatedAt: new Date().toISOString() })
    .where(eq(schema.capacityPools.id, poolId));
}

export async function reconcileDefaultPoolStatus(db: Db, poolId: string): Promise<void> {
  const [activeCandidate] = await db
    .select({ id: schema.capacityPoolCandidates.id })
    .from(schema.capacityPoolCandidates)
    .innerJoin(
      schema.capacitySources,
      eq(schema.capacityPoolCandidates.capacitySourceId, schema.capacitySources.id)
    )
    .where(
      and(
        eq(schema.capacityPoolCandidates.poolId, poolId),
        eq(schema.capacityPoolCandidates.status, ACTIVE_STATUS),
        eq(schema.capacitySources.status, ACTIVE_STATUS)
      )
    )
    .limit(1);

  await db
    .update(schema.capacityPools)
    .set({
      status: activeCandidate ? ACTIVE_STATUS : DISABLED_STATUS,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.capacityPools.id, poolId));
}

export async function readDefaultPoolSummary(
  db: Db,
  scope: ScopeIdentity,
  options: ReadDefaultPoolSummaryOptions = {}
): Promise<CapacityPoolSummary | null> {
  const poolStatusPredicate =
    options.includeDisabled === true
      ? inArray(schema.capacityPools.status, [ACTIVE_STATUS, DISABLED_STATUS])
      : eq(schema.capacityPools.status, ACTIVE_STATUS);

  const [pool] = await db
    .select()
    .from(schema.capacityPools)
    .where(
      and(
        ...poolScopePredicates(scope),
        eq(schema.capacityPools.isDefault, true),
        poolStatusPredicate
      )
    )
    .limit(1);
  if (!pool) return null;

  const rows = await db
    .select({
      source: schema.capacitySources,
      candidate: schema.capacityPoolCandidates,
    })
    .from(schema.capacityPoolCandidates)
    .innerJoin(
      schema.capacitySources,
      eq(schema.capacityPoolCandidates.capacitySourceId, schema.capacitySources.id)
    )
    .where(
      and(
        eq(schema.capacityPoolCandidates.poolId, pool.id),
        eq(schema.capacitySources.status, ACTIVE_STATUS)
      )
    )
    .orderBy(
      asc(schema.capacityPoolCandidates.priority),
      asc(schema.capacityPoolCandidates.candidateOrder),
      asc(schema.capacityPoolCandidates.id)
    );

  if (rows.length === 0) return null;

  const sourcesById = new Map<string, CapacitySourceIdentity>();
  const candidates: CapacityPoolCandidateDto[] = [];
  let activeCandidateCount = 0;
  for (const row of rows) {
    sourcesById.set(row.source.id, toCapacitySourceIdentity(row.source));
    const candidate = toCapacityPoolCandidate(row.candidate);
    if (candidate.status === ACTIVE_STATUS) activeCandidateCount += 1;
    candidates.push(candidate);
  }

  return {
    pool: toCapacityPool(pool),
    sources: [...sourcesById.values()],
    candidates,
    activeCandidateCount,
  };
}

function poolScopePredicates(scope: ScopeIdentity) {
  return [
    eq(schema.capacityPools.scope, scope.scope),
    scope.ownerUserId
      ? eq(schema.capacityPools.ownerUserId, scope.ownerUserId)
      : isNull(schema.capacityPools.ownerUserId),
    scope.ownerProjectId
      ? eq(schema.capacityPools.ownerProjectId, scope.ownerProjectId)
      : isNull(schema.capacityPools.ownerProjectId),
  ];
}

function sourceScopePredicates(scope: ScopeIdentity) {
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
