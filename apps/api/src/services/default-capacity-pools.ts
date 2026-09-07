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
  SafeEffectiveCapacityPoolReason,
  SafeEffectiveCapacityPoolSummary,
} from '@simple-agent-manager/shared';
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { nextCapacityPoolTimestamp } from './capacity-pool-clock';
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
  timestampVersion,
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
const SOURCE_GENERATION_SETTING_KEY_PREFIX = 'capacityPools.sourceGeneration.v1';
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

interface CapacitySourcePublication {
  source: schema.CapacitySource;
  generation: number;
  published: boolean;
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

export interface DefaultCapacityPoolOfferingResolution {
  offerings: ProviderInstanceOffering[];
  refreshSucceeded: boolean;
  catalogComplete?: boolean;
}

export type DefaultCapacityPoolOfferingResolver = (
  seed: CredentialCapacitySeed
) => Promise<ProviderInstanceOffering[] | DefaultCapacityPoolOfferingResolution>;

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
  beforeSourcePublication?: (input: {
    seed: CredentialCapacitySeed;
    existingSource: schema.CapacitySource | null;
  }) => Promise<void>;
  beforeCredentialSeedSelection?: (input: {
    scope: DefaultPoolScopeIdentity;
    seedSnapshotGeneration: number;
  }) => Promise<void>;
  afterCredentialSeedSelection?: (input: {
    scope: DefaultPoolScopeIdentity;
    seedSnapshotGeneration: number;
    seedCount: number;
  }) => Promise<void>;
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

export function toSafeEffectiveCapacityPoolSummary(
  summary: CapacityPoolSummary | null
): SafeEffectiveCapacityPoolSummary {
  if (!summary) {
    return {
      scope: null,
      state: 'unconfigured',
      strategy: null,
      exhaustionPolicy: null,
      availableCandidateCount: 0,
      reason: 'no-capacity-pool-configured',
    };
  }

  const state = summary.effectiveState ?? 'configured-ready';
  return {
    scope: summary.pool.scope,
    state,
    strategy: summary.pool.strategy,
    exhaustionPolicy: summary.pool.exhaustionPolicy,
    availableCandidateCount: summary.availableCandidateCount ?? 0,
    reason: safeEffectiveReasonForState(state),
  };
}

function safeEffectiveReasonForState(
  state: DefaultCapacityPoolEffectiveState
): SafeEffectiveCapacityPoolReason | undefined {
  switch (state) {
    case 'configured-ready':
      return undefined;
    case 'unconfigured':
      return 'no-capacity-pool-configured';
    case 'configured-empty':
      return 'configured-default-pool-has-no-active-candidates';
    case 'source-disabled':
      return 'configured-default-pool-sources-disabled';
    case 'catalog-unavailable':
      return 'configured-default-pool-catalog-last-known-unavailable';
    case 'migration-pending':
      return 'configured-default-pool-migration-pending';
  }
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

async function readCapacityPoolScopeGeneration(db: Db, scope: ScopeIdentity): Promise<number> {
  const [row] = await db
    .select({ value: schema.platformSettings.value })
    .from(schema.platformSettings)
    .where(eq(schema.platformSettings.key, sourceGenerationSettingKey(scope)))
    .limit(1);
  return parseGeneration(row?.value);
}

async function nextCapacityPoolScopeGeneration(db: Db, scope: ScopeIdentity): Promise<number> {
  const key = sourceGenerationSettingKey(scope);
  const now = nextCapacityPoolTimestamp();
  await db
    .insert(schema.platformSettings)
    .values({ key, value: '0', updatedAt: now, updatedBy: null })
    .onConflictDoNothing();
  const [row] = await db
    .update(schema.platformSettings)
    .set({
      value: sql`CAST(${schema.platformSettings.value} AS INTEGER) + 1`,
      updatedAt: now,
      updatedBy: sql`NULL`,
    })
    .where(eq(schema.platformSettings.key, key))
    .returning({ value: schema.platformSettings.value });
  return parseGeneration(row?.value);
}

function sourceGenerationSettingKey(scope: ScopeIdentity): string {
  switch (scope.scope) {
    case 'installation':
      return `${SOURCE_GENERATION_SETTING_KEY_PREFIX}:installation`;
    case 'user':
      return `${SOURCE_GENERATION_SETTING_KEY_PREFIX}:user:${scope.ownerUserId ?? ''}`;
    case 'project':
      return `${SOURCE_GENERATION_SETTING_KEY_PREFIX}:project:${scope.ownerProjectId ?? ''}`;
  }
}

function parseGeneration(value: string | number | null | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
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
  };
  const activeSeedKeys = new Set<string>();

  for (const seed of seeds) {
    if (seed.active && !(await isCapacitySeedStillCurrent(db, seed))) continue;
    const materializedSeed = seed.active
      ? await materializeCapacitySourceCredential(db, seed)
      : seed;
    if (materializedSeed.active && !(await isCapacitySeedStillCurrent(db, seed))) continue;
    const existingSource = await findCapacitySourceForCredential(db, materializedSeed);
    if (!materializedSeed.active) {
      if (existingSource) await disableCapacitySourceAvailability(db, scope, existingSource);
      continue;
    }
    activeSeedKeys.add(sourceIdentityKeyForSeed(materializedSeed));
    await options.beforeSourcePublication?.({ seed: materializedSeed, existingSource });
    if (!(await isCapacitySeedStillCurrent(db, seed))) continue;

    const publication = existingSource
      ? await updateCapacitySourceForSeed(db, existingSource, materializedSeed, scope)
      : await insertCapacitySourceForSeed(db, materializedSeed, scope);
    if (!publication.published || publication.source.status !== ACTIVE_STATUS) continue;
    if (!(await isCapacitySeedStillCurrent(db, seed))) {
      await disableCapacitySourceAvailability(db, scope, publication.source);
      continue;
    }

    const resolvedOfferings = await resolveOfferingsForSeed(materializedSeed, options);
    const sourceStillCurrent = await isCapacitySourceRefreshCurrent(db, publication);
    if (!sourceStillCurrent || !(await isCapacitySeedStillCurrent(db, seed))) continue;
    if (resolvedOfferings.refreshSucceeded) {
      await ensureCandidatesForSource(
        db,
        pool.id,
        publication.source.id,
        materializedSeed.provider,
        resolvedOfferings.offerings,
        {
          sourceGeneration: publication.generation,
          catalogComplete: resolvedOfferings.catalogComplete !== false,
        }
      );
    }
  }

  await disableCapacitySourcesMissingFromSeeds(db, scope, activeSeedKeys, seedSnapshotGeneration);
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
  seed: CredentialCapacitySeed,
  scope: ScopeIdentity
): Promise<CapacitySourcePublication> {
  const id = defaultCapacitySourceId(seed);
  const generation = await nextCapacityPoolScopeGeneration(db, scope);
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
      sourceGeneration: generation,
      status: ACTIVE_STATUS,
      createdBy: seed.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  const [source] = await db
    .select()
    .from(schema.capacitySources)
    .where(eq(schema.capacitySources.id, id))
    .limit(1);
  if (!source) throw new Error(`Failed to create default capacity source ${id}`);
  return {
    source,
    generation: source.sourceGeneration,
    published: source.sourceGeneration === generation && source.status === ACTIVE_STATUS,
  };
}

async function updateCapacitySourceForSeed(
  db: Db,
  existingSource: schema.CapacitySource,
  seed: CredentialCapacitySeed,
  scope: ScopeIdentity
): Promise<CapacitySourcePublication> {
  if (existingSource.status === 'deleted') {
    return {
      source: existingSource,
      generation: existingSource.sourceGeneration,
      published: false,
    };
  }

  const generation = await nextCapacityPoolScopeGeneration(db, scope);
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
      sourceGeneration: generation,
      status: ACTIVE_STATUS,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.capacitySources.id, existingSource.id),
        eq(schema.capacitySources.sourceGeneration, existingSource.sourceGeneration)
      )
    );

  const [source] = await db
    .select()
    .from(schema.capacitySources)
    .where(eq(schema.capacitySources.id, existingSource.id))
    .limit(1);
  if (!source) throw new Error(`Capacity source ${existingSource.id} disappeared during update`);
  return {
    source,
    generation: source.sourceGeneration,
    published: source.sourceGeneration === generation && source.status === ACTIVE_STATUS,
  };
}

async function isCapacitySourceRefreshCurrent(
  db: Db,
  publication: CapacitySourcePublication
): Promise<boolean> {
  const [current] = await db
    .select({
      status: schema.capacitySources.status,
      sourceGeneration: schema.capacitySources.sourceGeneration,
    })
    .from(schema.capacitySources)
    .where(eq(schema.capacitySources.id, publication.source.id))
    .limit(1);
  return (
    current?.status === publication.source.status &&
    current.sourceGeneration === publication.generation
  );
}

async function isCapacitySeedStillCurrent(db: Db, seed: CredentialCapacitySeed): Promise<boolean> {
  if (seed.platformCredentialId) return isPlatformCapacitySeedStillCurrent(db, seed);
  if (seed.externalSourceRef) return isComposableCapacitySeedStillCurrent(db, seed);
  if (seed.credentialId) return isLegacyCapacitySeedStillCurrent(db, seed);
  return false;
}

async function isLegacyCapacitySeedStillCurrent(
  db: Db,
  seed: CredentialCapacitySeed
): Promise<boolean> {
  if (!seed.credentialId) return false;
  const [row] = await db
    .select({
      userId: schema.credentials.userId,
      projectId: schema.credentials.projectId,
      provider: schema.credentials.provider,
      credentialType: schema.credentials.credentialType,
      isActive: schema.credentials.isActive,
      encryptedToken: schema.credentials.encryptedToken,
      iv: schema.credentials.iv,
      createdAt: schema.credentials.createdAt,
      updatedAt: schema.credentials.updatedAt,
    })
    .from(schema.credentials)
    .where(eq(schema.credentials.id, seed.credentialId))
    .limit(1);

  if (!row) return false;
  const scopeMatches =
    seed.scope === 'project'
      ? row.projectId === seed.ownerProjectId
      : row.projectId === null && row.userId === seed.ownerUserId;

  return (
    row.credentialType === CREDENTIAL_TYPE_CLOUD_PROVIDER &&
    row.isActive === true &&
    row.provider === seed.provider &&
    row.encryptedToken === seed.encryptedToken &&
    row.iv === seed.iv &&
    scopeMatches &&
    credentialVersionMatches(seed, row.updatedAt ?? row.createdAt)
  );
}

async function isPlatformCapacitySeedStillCurrent(
  db: Db,
  seed: CredentialCapacitySeed
): Promise<boolean> {
  if (!seed.platformCredentialId) return false;
  const [row] = await db
    .select({
      provider: schema.platformCredentials.provider,
      credentialType: schema.platformCredentials.credentialType,
      isEnabled: schema.platformCredentials.isEnabled,
      encryptedToken: schema.platformCredentials.encryptedToken,
      iv: schema.platformCredentials.iv,
      createdAt: schema.platformCredentials.createdAt,
      updatedAt: schema.platformCredentials.updatedAt,
    })
    .from(schema.platformCredentials)
    .where(eq(schema.platformCredentials.id, seed.platformCredentialId))
    .limit(1);

  return (
    seed.scope === 'installation' &&
    row?.credentialType === CREDENTIAL_TYPE_CLOUD_PROVIDER &&
    row.isEnabled === true &&
    row.provider === seed.provider &&
    row.encryptedToken === seed.encryptedToken &&
    row.iv === seed.iv &&
    credentialVersionMatches(seed, row.updatedAt ?? row.createdAt)
  );
}

async function isComposableCapacitySeedStillCurrent(
  db: Db,
  seed: CredentialCapacitySeed
): Promise<boolean> {
  const attachmentId = attachmentIdFromExternalSourceRef(seed.externalSourceRef);
  if (!attachmentId || !seed.catalogCredentialId) return false;

  const [row] = await db
    .select({
      userId: schema.ccAttachments.userId,
      projectId: schema.ccAttachments.projectId,
      attachmentActive: schema.ccAttachments.isActive,
      attachmentConsumerKind: schema.ccAttachments.consumerKind,
      attachmentConsumerTarget: schema.ccAttachments.consumerTarget,
      configurationActive: schema.ccConfigurations.isActive,
      configurationOwnerId: schema.ccConfigurations.ownerId,
      configurationConsumerKind: schema.ccConfigurations.consumerKind,
      configurationConsumerTarget: schema.ccConfigurations.consumerTarget,
      configurationCredentialId: schema.ccConfigurations.credentialId,
      credentialOwnerId: schema.ccCredentials.ownerId,
      credentialKind: schema.ccCredentials.kind,
      credentialActive: schema.ccCredentials.isActive,
      encryptedToken: schema.ccCredentials.encryptedToken,
      iv: schema.ccCredentials.iv,
      createdAt: schema.ccCredentials.createdAt,
      updatedAt: schema.ccCredentials.updatedAt,
    })
    .from(schema.ccAttachments)
    .innerJoin(
      schema.ccConfigurations,
      eq(schema.ccAttachments.configurationId, schema.ccConfigurations.id)
    )
    .innerJoin(
      schema.ccCredentials,
      eq(schema.ccConfigurations.credentialId, schema.ccCredentials.id)
    )
    .where(eq(schema.ccAttachments.id, attachmentId))
    .limit(1);

  if (!row) return false;
  const scopeMatches =
    seed.scope === 'project'
      ? row.projectId === seed.ownerProjectId
      : row.projectId === null && row.userId === seed.ownerUserId;

  return (
    scopeMatches &&
    row.userId === row.configurationOwnerId &&
    row.credentialOwnerId === row.configurationOwnerId &&
    row.attachmentActive === true &&
    row.configurationActive === true &&
    row.credentialActive === true &&
    row.attachmentConsumerKind === 'compute' &&
    row.configurationConsumerKind === 'compute' &&
    row.attachmentConsumerTarget === seed.provider &&
    row.configurationConsumerTarget === seed.provider &&
    row.configurationCredentialId === seed.catalogCredentialId &&
    row.credentialKind === CREDENTIAL_TYPE_CLOUD_PROVIDER &&
    row.encryptedToken === seed.encryptedToken &&
    row.iv === seed.iv &&
    credentialVersionMatches(seed, row.updatedAt ?? row.createdAt)
  );
}

function attachmentIdFromExternalSourceRef(value: string | null): string | null {
  const prefix = 'cc_attachments:';
  return value?.startsWith(prefix) ? value.slice(prefix.length) || null : null;
}

function credentialVersionMatches(seed: CredentialCapacitySeed, timestamp: string): boolean {
  const currentVersion = timestampVersion(timestamp);
  return seed.credentialVersion === null || currentVersion === seed.credentialVersion;
}

async function disableCapacitySourceAvailability(
  db: Db,
  scope: ScopeIdentity,
  source: Pick<schema.CapacitySource, 'id' | 'sourceGeneration'>
): Promise<void> {
  const generation = await nextCapacityPoolScopeGeneration(db, scope);
  const now = nextCapacityPoolTimestamp();
  await db
    .update(schema.capacitySources)
    .set({ status: DISABLED_STATUS, sourceGeneration: generation, updatedAt: now })
    .where(
      and(
        eq(schema.capacitySources.id, source.id),
        eq(schema.capacitySources.sourceGeneration, source.sourceGeneration)
      )
    );
}

async function disableCapacitySourcesMissingFromSeeds(
  db: Db,
  scope: ScopeIdentity,
  activeSeedKeys: ReadonlySet<string>,
  seedSnapshotGeneration: number
): Promise<void> {
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
    if (source.sourceGeneration > seedSnapshotGeneration) continue;
    sourceIdsToDisable.add(source.id);
  }

  for (const source of rows.flatMap((row) =>
    sourceIdsToDisable.has(row.source.id) ? [row.source] : []
  )) {
    await disableCapacitySourceAvailability(db, scope, source);
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

async function disableDefaultPoolAvailability(
  db: Db,
  poolId: string,
  seedSnapshotGeneration?: number
): Promise<void> {
  const [pool] = await db
    .select({
      scope: schema.capacityPools.scope,
      ownerUserId: schema.capacityPools.ownerUserId,
      ownerProjectId: schema.capacityPools.ownerProjectId,
    })
    .from(schema.capacityPools)
    .where(eq(schema.capacityPools.id, poolId))
    .limit(1);
  if (!pool) return;

  const scope = {
    scope: pool.scope as CapacityPoolScope,
    ownerUserId: pool.ownerUserId,
    ownerProjectId: pool.ownerProjectId,
  };
  const sourceRows = await db
    .select({
      id: schema.capacitySources.id,
      sourceGeneration: schema.capacitySources.sourceGeneration,
    })
    .from(schema.capacitySources)
    .where(
      and(
        eq(schema.capacitySources.sourceKind, SOURCE_KIND_CLOUD_PROVIDER),
        eq(schema.capacitySources.status, ACTIVE_STATUS),
        ...sourceScopePredicates(scope)
      )
    );

  const sourcesById = new Map(sourceRows.map((row) => [row.id, row]));
  for (const source of sourcesById.values()) {
    if (
      typeof seedSnapshotGeneration === 'number' &&
      source.sourceGeneration > seedSnapshotGeneration
    ) {
      continue;
    }
    await disableCapacitySourceAvailability(db, scope, source);
  }

  await reconcileDefaultPoolStatus(db, poolId);
}

export async function reconcileDefaultPoolStatus(
  db: Db,
  poolId: string,
  guard?: PoolPublicationGuard
): Promise<void> {
  const [pool] = await db
    .select({
      scope: schema.capacityPools.scope,
      ownerUserId: schema.capacityPools.ownerUserId,
      ownerProjectId: schema.capacityPools.ownerProjectId,
    })
    .from(schema.capacityPools)
    .where(eq(schema.capacityPools.id, poolId))
    .limit(1);
  const sourceRows = pool
    ? await db
        .select({ status: schema.capacitySources.status })
        .from(schema.capacitySources)
        .where(
          and(
            eq(schema.capacitySources.sourceKind, SOURCE_KIND_CLOUD_PROVIDER),
            ...sourceScopePredicates({
              scope: pool.scope as CapacityPoolScope,
              ownerUserId: pool.ownerUserId,
              ownerProjectId: pool.ownerProjectId,
            })
          )
        )
    : [];
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

  const activeSourceCount = sourceRows.filter((row) => row.status === ACTIVE_STATUS).length;
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
  if (sourceRows.length === 0 && rows.length === 0) {
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
    return Math.min(Math.floor(configured), MAX_BACKFILL_SCOPE_BATCH_SIZE);
  }
  return DEFAULT_BACKFILL_SCOPE_BATCH_SIZE;
}

function numberFromString(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
