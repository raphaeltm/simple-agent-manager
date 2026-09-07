import type {
  CapacityCredentialSource,
  CapacityPool as CapacityPoolDto,
  CapacityPoolCandidate as CapacityPoolCandidateDto,
  CapacityPoolConfigurationState,
  CapacityPoolScope,
  CapacitySourceIdentity,
  CredentialProvider,
  DefaultCapacityPoolEffectiveState,
  DefaultCapacityPoolSummary,
  ProviderInstanceOffering,
  SafeEffectiveDefaultCapacityPoolSummary,
} from '@simple-agent-manager/shared';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import {
  toCapacityPool,
  toCapacityPoolCandidate,
  toCapacitySourceIdentity,
} from './capacity-pools';
import { nextCapacityPoolTimestamp } from './capacity-pool-clock';
import { ensureCandidatesForSource } from './default-capacity-pool-candidates';
import {
  defaultCapacitySourceId,
  defaultPoolId,
  type DefaultPoolScopeIdentity,
} from './default-capacity-pool-helpers';
import {
  materializeCapacitySourceCredential,
  resolveOfferingsForSeed,
} from './default-capacity-source-credentials';
import {
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
const DEFAULT_BACKFILL_SCOPE_BATCH_SIZE = 25;
const MAX_BACKFILL_SCOPE_BATCH_SIZE = 200;
const BACKFILL_USER_CURSOR_KEY = 'capacityPools.backfill.userCursor.v1';
const BACKFILL_PROJECT_CURSOR_KEY = 'capacityPools.backfill.projectCursor.v1';
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

interface PoolPublicationGuard {
  revision: number;
  updatedAt: string;
  status: string;
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
  scopeBatchSize?: number;
}

export function toSafeEffectiveDefaultCapacityPoolSummary(
  summary: CapacityPoolSummary | null
): SafeEffectiveDefaultCapacityPoolSummary {
  if (!summary) {
    return {
      scope: null,
      effectiveState: 'unconfigured',
      safeState: 'unconfigured',
      safeReason: 'no-effective-pool',
      strategy: null,
      exhaustionPolicy: null,
      usableCount: 0,
    };
  }

  const effectiveState = summary.effectiveState ?? 'unconfigured';
  return {
    scope: summary.pool.scope,
    effectiveState,
    safeState: safeStateForEffectiveState(effectiveState),
    safeReason: safeReasonForEffectiveState(effectiveState),
    strategy: summary.pool.strategy,
    exhaustionPolicy: summary.pool.exhaustionPolicy,
    usableCount: effectiveState === 'configured-ready' ? safeUsableCandidateCount(summary) : 0,
  };
}

function safeStateForEffectiveState(
  effectiveState: DefaultCapacityPoolEffectiveState
): SafeEffectiveDefaultCapacityPoolSummary['safeState'] {
  if (effectiveState === 'configured-ready') return 'usable';
  if (effectiveState === 'unconfigured') return 'unconfigured';
  return 'blocked';
}

function safeReasonForEffectiveState(
  effectiveState: DefaultCapacityPoolEffectiveState
): SafeEffectiveDefaultCapacityPoolSummary['safeReason'] {
  return effectiveState === 'unconfigured' ? 'no-effective-pool' : effectiveState;
}

function safeUsableCandidateCount(summary: CapacityPoolSummary): number {
  const count = summary.availableCandidateCount ?? summary.activeCandidateCount;
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
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
    const projectScope = {
      scope: 'project',
      ownerUserId: null,
      ownerProjectId: input.projectId,
    } satisfies ScopeIdentity;
    if (await findDefaultPool(db, projectScope)) {
      return readDefaultPoolSummary(db, projectScope, { includeDisabled: true });
    }
  }

  const userScope = {
    scope: 'user',
    ownerUserId: input.userId,
    ownerProjectId: null,
  } satisfies ScopeIdentity;
  if (await findDefaultPool(db, userScope)) {
    return readDefaultPoolSummary(db, userScope, { includeDisabled: true });
  }

  if (input.includeInstallation === false) return null;

  const installationScope = {
    scope: 'installation',
    ownerUserId: null,
    ownerProjectId: null,
  } satisfies ScopeIdentity;
  if (await findDefaultPool(db, installationScope)) {
    return readDefaultPoolSummary(db, installationScope, { includeDisabled: true });
  }
  return null;
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

async function listCredentialUserIdsForBackfill(db: Db, limit: number): Promise<string[]> {
  const cursor = await readBackfillCursor(db, BACKFILL_USER_CURSOR_KEY);
  let ids = await listCredentialUserIdsPage(db, cursor, limit);
  if (ids.length === 0 && cursor) {
    await writeBackfillCursor(db, BACKFILL_USER_CURSOR_KEY, null);
    ids = await listCredentialUserIdsPage(db, null, limit);
  }
  return ids;
}

async function listCredentialUserIdsPage(
  db: Db,
  cursor: string | null,
  limit: number
): Promise<string[]> {
  const legacyRows = await db
    .select({ userId: schema.credentials.userId })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.credentialType, CREDENTIAL_TYPE_CLOUD_PROVIDER),
        isNull(schema.credentials.projectId),
        cursor ? gt(schema.credentials.userId, cursor) : undefined
      )
    )
    .orderBy(asc(schema.credentials.userId))
    .limit(limit);
  const ccRows = await db
    .select({ userId: schema.ccAttachments.userId })
    .from(schema.ccAttachments)
    .where(
      and(
        eq(schema.ccAttachments.consumerKind, 'compute'),
        isNull(schema.ccAttachments.projectId),
        cursor ? gt(schema.ccAttachments.userId, cursor) : undefined
      )
    )
    .orderBy(asc(schema.ccAttachments.userId))
    .limit(limit);

  return [
    ...new Set([...legacyRows.map((row) => row.userId), ...ccRows.map((row) => row.userId)].sort()),
  ].slice(0, limit);
}

async function listCredentialProjectIdsForBackfill(db: Db, limit: number): Promise<string[]> {
  const cursor = await readBackfillCursor(db, BACKFILL_PROJECT_CURSOR_KEY);
  let ids = await listCredentialProjectIdsPage(db, cursor, limit);
  if (ids.length === 0 && cursor) {
    await writeBackfillCursor(db, BACKFILL_PROJECT_CURSOR_KEY, null);
    ids = await listCredentialProjectIdsPage(db, null, limit);
  }
  return ids;
}

async function listCredentialProjectIdsPage(
  db: Db,
  cursor: string | null,
  limit: number
): Promise<string[]> {
  const legacyRows = await db
    .select({ projectId: schema.credentials.projectId })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.credentialType, CREDENTIAL_TYPE_CLOUD_PROVIDER),
        isNotNull(schema.credentials.projectId),
        cursor ? gt(schema.credentials.projectId, cursor) : undefined
      )
    )
    .orderBy(asc(schema.credentials.projectId))
    .limit(limit);
  const ccRows = await db
    .select({ projectId: schema.ccAttachments.projectId })
    .from(schema.ccAttachments)
    .where(
      and(
        eq(schema.ccAttachments.consumerKind, 'compute'),
        isNotNull(schema.ccAttachments.projectId),
        cursor ? gt(schema.ccAttachments.projectId, cursor) : undefined
      )
    )
    .orderBy(asc(schema.ccAttachments.projectId))
    .limit(limit);

  return [
    ...new Set(
      [...legacyRows, ...ccRows].flatMap((row) => (row.projectId ? [row.projectId] : [])).sort()
    ),
  ].slice(0, limit);
}

async function readBackfillCursor(db: Db, key: string): Promise<string | null> {
  const [row] = await db
    .select({ value: schema.platformSettings.value })
    .from(schema.platformSettings)
    .where(eq(schema.platformSettings.key, key))
    .limit(1);
  return row?.value || null;
}

async function writeBackfillCursor(db: Db, key: string, cursor: string | null): Promise<void> {
  const now = nextCapacityPoolTimestamp();
  if (cursor === null) {
    await db.delete(schema.platformSettings).where(eq(schema.platformSettings.key, key));
    return;
  }
  await db
    .insert(schema.platformSettings)
    .values({ key, value: cursor, updatedAt: now, updatedBy: null })
    .onConflictDoUpdate({
      target: schema.platformSettings.key,
      set: {
        value: cursor,
        updatedAt: now,
        updatedBy: sql`NULL`,
      },
    });
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
  };

  for (const seed of seeds) {
    const refreshStartedAt = nextCapacityPoolTimestamp();
    const materializedSeed = seed.active
      ? await materializeCapacitySourceCredential(db, seed)
      : seed;
    const existingSource = await findCapacitySourceForCredential(db, materializedSeed);
    if (!materializedSeed.active) {
      if (existingSource) await disableCapacitySourceAvailability(db, pool.id, existingSource.id);
      continue;
    }

    const source = existingSource
      ? await updateCapacitySourceForSeed(db, existingSource.id, materializedSeed, refreshStartedAt)
      : await insertCapacitySourceForSeed(db, materializedSeed);
    if (source.status !== ACTIVE_STATUS) continue;

    const resolvedOfferings = await resolveOfferingsForSeed(materializedSeed, options);
    const sourceStillCurrent = await isCapacitySourceRefreshCurrent(db, source);
    if (!sourceStillCurrent) continue;
    if (resolvedOfferings.refreshSucceeded) {
      await ensureCandidatesForSource(
        db,
        pool.id,
        source.id,
        materializedSeed.provider,
        resolvedOfferings.offerings,
        { refreshStartedAt }
      );
    }
  }

  await disableCapacitySourcesMissingFromSeeds(
    db,
    pool.id,
    scope,
    await Promise.all(activeSeeds.map((seed) => materializeCapacitySourceCredential(db, seed)))
  );
  await reconcileDefaultPoolStatus(db, pool.id, poolGuard);
  return readDefaultPoolSummary(db, scope, { includeDisabled: true });
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

async function findCapacitySourceForCredential(
  db: Db,
  seed: CredentialCapacitySeed
): Promise<schema.CapacitySource | null> {
  let credentialPredicate;
  if (seed.platformCredentialId) {
    credentialPredicate = eq(
      schema.capacitySources.platformCredentialId,
      seed.platformCredentialId
    );
  } else if (seed.externalSourceRef) {
    credentialPredicate = eq(schema.capacitySources.externalSourceRef, seed.externalSourceRef);
  } else if (seed.credentialId) {
    credentialPredicate = eq(schema.capacitySources.credentialId, seed.credentialId);
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
  const now = nextCapacityPoolTimestamp();
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
  seed: CredentialCapacitySeed,
  refreshStartedAt: string
): Promise<schema.CapacitySource> {
  const now = nextCapacityPoolTimestamp();
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
    .where(
      and(
        eq(schema.capacitySources.id, sourceId),
        lte(schema.capacitySources.updatedAt, refreshStartedAt)
      )
    );

  const [source] = await db
    .select()
    .from(schema.capacitySources)
    .where(eq(schema.capacitySources.id, sourceId))
    .limit(1);
  if (!source) throw new Error(`Capacity source ${sourceId} disappeared during update`);
  return source;
}

async function isCapacitySourceRefreshCurrent(
  db: Db,
  source: schema.CapacitySource
): Promise<boolean> {
  const [current] = await db
    .select({ status: schema.capacitySources.status, updatedAt: schema.capacitySources.updatedAt })
    .from(schema.capacitySources)
    .where(eq(schema.capacitySources.id, source.id))
    .limit(1);
  return current?.status === source.status && current.updatedAt === source.updatedAt;
}

async function disableCapacitySourceAvailability(
  db: Db,
  _poolId: string,
  sourceId: string
): Promise<void> {
  const now = nextCapacityPoolTimestamp();
  await db
    .update(schema.capacitySources)
    .set({ status: DISABLED_STATUS, updatedAt: now })
    .where(eq(schema.capacitySources.id, sourceId));
}

async function disableCapacitySourcesMissingFromSeeds(
  db: Db,
  poolId: string,
  scope: ScopeIdentity,
  activeSeeds: CredentialCapacitySeed[]
): Promise<void> {
  const activeSeedKeys = new Set(activeSeeds.map(sourceIdentityKeyForSeed));
  const rows = await db
    .select({ source: schema.capacitySources })
    .from(schema.capacitySources)
    .where(
      and(
        eq(schema.capacitySources.sourceKind, SOURCE_KIND_CLOUD_PROVIDER),
        eq(schema.capacitySources.status, ACTIVE_STATUS),
        ...sourceScopePredicates(scope)
      )
    );

  const sourceIdsToDisable = new Set<string>();
  for (const { source } of rows) {
    const key = sourceIdentityKeyForRow(source);
    if (!key || activeSeedKeys.has(key)) continue;
    sourceIdsToDisable.add(source.id);
  }

  for (const sourceId of sourceIdsToDisable) {
    await disableCapacitySourceAvailability(db, poolId, sourceId);
  }
}

function sourceIdentityKeyForSeed(seed: CredentialCapacitySeed): string {
  if (seed.platformCredentialId) return `platform:${seed.platformCredentialId}`;
  if (seed.externalSourceRef) return `external:${seed.externalSourceRef}`;
  if (seed.credentialId) return `credential:${seed.credentialId}`;
  return `reference:${seed.credentialReference}`;
}

function sourceIdentityKeyForRow(source: schema.CapacitySource): string | null {
  if (source.platformCredentialId) return `platform:${source.platformCredentialId}`;
  if (source.externalSourceRef) return `external:${source.externalSourceRef}`;
  if (source.credentialId) return `credential:${source.credentialId}`;
  if (source.credentialReference) return `reference:${source.credentialReference}`;
  return null;
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

  await reconcileDefaultPoolStatus(db, poolId);
}

export async function reconcileDefaultPoolStatus(
  db: Db,
  poolId: string,
  guard?: PoolPublicationGuard
): Promise<void> {
  const rows = await db
    .select({
      sourceStatus: schema.capacitySources.status,
      candidateStatus: schema.capacityPoolCandidates.status,
      catalogAvailability: schema.capacityPoolCandidates.catalogAvailability,
      providerInstanceCatalogSource: schema.capacityPoolCandidates.providerInstanceCatalogSource,
    })
    .from(schema.capacityPoolCandidates)
    .innerJoin(
      schema.capacitySources,
      eq(schema.capacityPoolCandidates.capacitySourceId, schema.capacitySources.id)
    )
    .where(eq(schema.capacityPoolCandidates.poolId, poolId));

  const activeSourceCount = rows.filter((row) => row.sourceStatus === ACTIVE_STATUS).length;
  const activeCandidateCount = rows.filter(
    (row) => row.sourceStatus === ACTIVE_STATUS && row.candidateStatus === ACTIVE_STATUS
  ).length;
  const availableCandidateCount = rows.filter(
    (row) =>
      row.sourceStatus === ACTIVE_STATUS &&
      row.candidateStatus === ACTIVE_STATUS &&
      row.catalogAvailability === 'available' &&
      row.providerInstanceCatalogSource !== null
  ).length;

  let configurationState: CapacityPoolConfigurationState;
  if (rows.length === 0) {
    configurationState = 'configured-empty';
  } else if (activeSourceCount === 0) {
    configurationState = 'source-disabled';
  } else if (activeCandidateCount === 0) {
    configurationState = 'configured-empty';
  } else if (availableCandidateCount === 0) {
    configurationState = 'catalog-unavailable';
  } else {
    configurationState = 'configured-ready';
  }

  const predicates = [eq(schema.capacityPools.id, poolId)];
  if (guard) {
    predicates.push(
      eq(schema.capacityPools.revision, guard.revision),
      eq(schema.capacityPools.updatedAt, guard.updatedAt),
      eq(schema.capacityPools.status, guard.status)
    );
  }

  await db
    .update(schema.capacityPools)
    .set({
      status: ACTIVE_STATUS,
      configurationState,
      migrationState: 'complete',
      lastReconciledAt: nextCapacityPoolTimestamp(),
      updatedAt: nextCapacityPoolTimestamp(),
    })
    .where(and(...predicates));
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
        options.includeDisabled === true
          ? undefined
          : eq(schema.capacitySources.status, ACTIVE_STATUS)
      )
    )
    .orderBy(
      asc(schema.capacityPoolCandidates.priority),
      asc(schema.capacityPoolCandidates.candidateOrder),
      asc(schema.capacityPoolCandidates.id)
    );

  const sourcesById = new Map<string, CapacitySourceIdentity>();
  const candidates: CapacityPoolCandidateDto[] = [];
  let activeCandidateCount = 0;
  let availableCandidateCount = 0;
  for (const row of rows) {
    sourcesById.set(row.source.id, toCapacitySourceIdentity(row.source));
    const candidate = toCapacityPoolCandidate(row.candidate);
    if (row.source.status === ACTIVE_STATUS && candidate.status === ACTIVE_STATUS) {
      activeCandidateCount += 1;
      if (
        candidate.catalogAvailability === 'available' &&
        candidate.providerInstanceCatalogSource !== null
      ) {
        availableCandidateCount += 1;
      }
    }
    candidates.push(candidate);
  }
  const effectiveState = defaultPoolEffectiveState(pool, {
    sourceCount: sourcesById.size,
    candidateCount: candidates.length,
    activeCandidateCount,
    availableCandidateCount,
  });

  return {
    pool: toCapacityPool(pool),
    sources: [...sourcesById.values()],
    candidates,
    activeCandidateCount,
    availableCandidateCount,
    effectiveState,
    diagnostics: defaultPoolDiagnostics(effectiveState),
  };
}

function defaultPoolEffectiveState(
  pool: schema.CapacityPool,
  counts: {
    sourceCount: number;
    candidateCount: number;
    activeCandidateCount: number;
    availableCandidateCount: number;
  }
): CapacityPoolConfigurationState {
  if (pool.migrationState !== 'complete') return 'migration-pending';
  if (pool.configurationState === 'source-disabled') return 'source-disabled';
  if (pool.configurationState === 'migration-pending') return 'migration-pending';
  if (pool.status !== ACTIVE_STATUS) return 'source-disabled';
  if (
    counts.sourceCount === 0 ||
    counts.candidateCount === 0 ||
    counts.activeCandidateCount === 0
  ) {
    return 'configured-empty';
  }
  if (counts.availableCandidateCount === 0) return 'catalog-unavailable';
  return 'configured-ready';
}

function defaultPoolDiagnostics(effectiveState: CapacityPoolConfigurationState): string[] {
  switch (effectiveState) {
    case 'configured-ready':
      return [];
    case 'configured-empty':
      return ['configured-default-pool-has-no-active-candidates'];
    case 'source-disabled':
      return ['configured-default-pool-sources-disabled'];
    case 'catalog-unavailable':
      return ['configured-default-pool-catalog-last-known-unavailable'];
    case 'migration-pending':
      return ['configured-default-pool-migration-pending'];
  }
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

function resolveBackfillScopeBatchSize(options: DefaultCapacityPoolsBackfillOptions): number {
  const configured =
    options.scopeBatchSize ??
    numberFromString(options.env?.CAPACITY_POOL_BACKFILL_SCOPE_BATCH_SIZE);
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.min(Math.max(1, Math.floor(configured)), MAX_BACKFILL_SCOPE_BATCH_SIZE);
  }
  return DEFAULT_BACKFILL_SCOPE_BATCH_SIZE;
}

function numberFromString(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
