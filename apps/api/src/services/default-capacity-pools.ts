import type {
  CapacityPool as CapacityPoolDto,
  CapacityPoolCandidate as CapacityPoolCandidateDto,
  CapacityPoolScope,
  CapacitySourceIdentity,
  CredentialProvider,
  VMSize,
} from '@simple-agent-manager/shared';
import {
  getDefaultLocationForProvider,
  getLocationsForProvider,
  isValidProvider,
  VM_SIZE_LABELS,
} from '@simple-agent-manager/shared';
import { and, asc, eq, isNotNull, isNull, notInArray } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import {
  toCapacityPool,
  toCapacityPoolCandidate,
  toCapacitySourceIdentity,
} from './capacity-pools';

type Db = ReturnType<typeof drizzle>;

const DEFAULT_POOL_NAMES: Record<CapacityPoolScope, string> = {
  installation: 'Installation default',
  user: 'User default',
  project: 'Project default',
};

const DEFAULT_POOL_STRATEGY = 'balanced';
const DEFAULT_EXHAUSTION_POLICY = 'queue';
const DEFAULT_WORKLOAD_ROLE = 'workspace';
const DEFAULT_RUNTIME = 'vm';
const DEFAULT_MACHINE_CLASS = 'shared-vm';
const SOURCE_KIND_CLOUD_PROVIDER = 'cloud-provider-credential';
const CREDENTIAL_TYPE_CLOUD_PROVIDER = 'cloud-provider';
const ACTIVE_STATUS = 'active';
const DISABLED_STATUS = 'disabled';
const VM_SIZE_ORDER = Object.keys(VM_SIZE_LABELS) as VMSize[];

interface ScopeIdentity {
  scope: CapacityPoolScope;
  ownerUserId: string | null;
  ownerProjectId: string | null;
}

interface CredentialCapacitySeed extends ScopeIdentity {
  id: string;
  provider: CredentialProvider;
  active: boolean;
  credentialReference: string;
  credentialVersion: number | null;
  credentialId: string | null;
  platformCredentialId: string | null;
  createdBy: string | null;
}

export interface CapacityPoolSummary {
  pool: CapacityPoolDto;
  sources: CapacitySourceIdentity[];
  candidates: CapacityPoolCandidateDto[];
  activeCandidateCount: number;
}

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
}

export async function ensureDefaultCapacityPoolsForExistingCredentials(
  db: Db,
  options: DefaultCapacityPoolsBackfillOptions = {}
): Promise<DefaultCapacityPoolsEnsureResult> {
  const installation =
    options.includeInstallation === false ? null : await ensureInstallationDefaultPool(db);
  const user = options.userId ? await ensureUserDefaultPool(db, options.userId) : null;
  const project = options.projectId ? await ensureProjectDefaultPool(db, options.projectId) : null;
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
    options.includeInstallation === false ? null : await ensureInstallationDefaultPool(db);

  const userIds = options.userId ? [options.userId] : await listCredentialUserIds(db);
  const projectIds = options.projectId ? [options.projectId] : await listCredentialProjectIds(db);

  let usersEnsured = 0;
  for (const userId of userIds) {
    await ensureUserDefaultPool(db, userId);
    usersEnsured += 1;
  }

  let projectsEnsured = 0;
  for (const projectId of projectIds) {
    await ensureProjectDefaultPool(db, projectId);
    projectsEnsured += 1;
  }

  return { installation, usersEnsured, projectsEnsured };
}

export async function resolveEffectiveDefaultCapacityPoolSummary(
  db: Db,
  input: { userId: string; projectId?: string | null; ensure?: boolean }
): Promise<CapacityPoolSummary | null> {
  if (input.ensure !== false) {
    await ensureDefaultCapacityPoolsForExistingCredentials(db, {
      userId: input.userId,
      projectId: input.projectId ?? null,
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

  return readDefaultPoolSummary(db, {
    scope: 'installation',
    ownerUserId: null,
    ownerProjectId: null,
  });
}

async function listCredentialUserIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ userId: schema.credentials.userId })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.credentialType, CREDENTIAL_TYPE_CLOUD_PROVIDER),
        isNull(schema.credentials.projectId)
      )
    );
  return [...new Set(rows.map((row) => row.userId))];
}

async function listCredentialProjectIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ projectId: schema.credentials.projectId })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.credentialType, CREDENTIAL_TYPE_CLOUD_PROVIDER),
        isNotNull(schema.credentials.projectId)
      )
    );
  return [...new Set(rows.flatMap((row) => (row.projectId ? [row.projectId] : [])))];
}

async function ensureInstallationDefaultPool(db: Db): Promise<CapacityPoolSummary | null> {
  const rows = await db
    .select({
      id: schema.platformCredentials.id,
      provider: schema.platformCredentials.provider,
      isEnabled: schema.platformCredentials.isEnabled,
      createdBy: schema.platformCredentials.createdBy,
      createdAt: schema.platformCredentials.createdAt,
      updatedAt: schema.platformCredentials.updatedAt,
    })
    .from(schema.platformCredentials)
    .where(eq(schema.platformCredentials.credentialType, CREDENTIAL_TYPE_CLOUD_PROVIDER));

  return ensureDefaultPoolForCredentialSeeds(
    db,
    { scope: 'installation', ownerUserId: null, ownerProjectId: null },
    rows.flatMap((row): CredentialCapacitySeed[] => {
      if (!row.provider || !isValidProvider(row.provider)) return [];
      return [
        {
          scope: 'installation',
          ownerUserId: null,
          ownerProjectId: null,
          id: row.id,
          provider: row.provider,
          active: row.isEnabled,
          credentialReference: platformCredentialReference(row.id),
          credentialVersion: timestampVersion(row.updatedAt ?? row.createdAt),
          credentialId: null,
          platformCredentialId: row.id,
          createdBy: row.createdBy,
        },
      ];
    })
  );
}

async function ensureUserDefaultPool(db: Db, userId: string): Promise<CapacityPoolSummary | null> {
  const rows = await db
    .select({
      id: schema.credentials.id,
      userId: schema.credentials.userId,
      projectId: schema.credentials.projectId,
      provider: schema.credentials.provider,
      isActive: schema.credentials.isActive,
      createdAt: schema.credentials.createdAt,
      updatedAt: schema.credentials.updatedAt,
    })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.credentialType, CREDENTIAL_TYPE_CLOUD_PROVIDER),
        isNull(schema.credentials.projectId)
      )
    );

  return ensureDefaultPoolForCredentialSeeds(
    db,
    { scope: 'user', ownerUserId: userId, ownerProjectId: null },
    rows.flatMap((row): CredentialCapacitySeed[] => {
      if (!isValidProvider(row.provider)) return [];
      return [
        {
          scope: 'user',
          ownerUserId: row.userId,
          ownerProjectId: null,
          id: row.id,
          provider: row.provider,
          active: row.isActive,
          credentialReference: legacyCredentialReference(row.id),
          credentialVersion: timestampVersion(row.updatedAt ?? row.createdAt),
          credentialId: row.id,
          platformCredentialId: null,
          createdBy: row.userId,
        },
      ];
    })
  );
}

async function ensureProjectDefaultPool(
  db: Db,
  projectId: string
): Promise<CapacityPoolSummary | null> {
  const rows = await db
    .select({
      id: schema.credentials.id,
      userId: schema.credentials.userId,
      projectId: schema.credentials.projectId,
      provider: schema.credentials.provider,
      isActive: schema.credentials.isActive,
      createdAt: schema.credentials.createdAt,
      updatedAt: schema.credentials.updatedAt,
    })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.projectId, projectId),
        eq(schema.credentials.credentialType, CREDENTIAL_TYPE_CLOUD_PROVIDER)
      )
    );

  return ensureDefaultPoolForCredentialSeeds(
    db,
    { scope: 'project', ownerUserId: null, ownerProjectId: projectId },
    rows.flatMap((row): CredentialCapacitySeed[] => {
      if (!isValidProvider(row.provider)) return [];
      return [
        {
          scope: 'project',
          ownerUserId: null,
          ownerProjectId: projectId,
          id: row.id,
          provider: row.provider,
          active: row.isActive,
          credentialReference: legacyCredentialReference(row.id),
          credentialVersion: timestampVersion(row.updatedAt ?? row.createdAt),
          credentialId: row.id,
          platformCredentialId: null,
          createdBy: row.userId,
        },
      ];
    })
  );
}

async function ensureDefaultPoolForCredentialSeeds(
  db: Db,
  scope: ScopeIdentity,
  seeds: CredentialCapacitySeed[]
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

    await ensureCandidatesForSource(db, pool.id, source.id, seed.provider);
  }

  await reconcileDefaultPoolStatus(db, pool.id);
  return readDefaultPoolSummary(db, scope);
}

async function findDefaultPool(db: Db, scope: ScopeIdentity): Promise<schema.CapacityPool | null> {
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
      credentialSource: seed.scope === 'installation' ? 'platform' : seed.scope,
      credentialId: seed.credentialId,
      platformCredentialId: seed.platformCredentialId,
      credentialReference: seed.credentialReference,
      credentialVersion: seed.credentialVersion,
      externalSourceRef: null,
      status: ACTIVE_STATUS,
      createdBy: seed.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.capacitySources.id,
      set: {
        provider: seed.provider,
        credentialReference: seed.credentialReference,
        credentialVersion: seed.credentialVersion,
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
      credentialReference: seed.credentialReference,
      credentialVersion: seed.credentialVersion,
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

async function ensureCandidatesForSource(
  db: Db,
  poolId: string,
  sourceId: string,
  provider: CredentialProvider
): Promise<void> {
  const now = new Date().toISOString();
  const candidateIds: string[] = [];
  let candidateOrder = 0;

  for (const location of orderedLocationsForProvider(provider)) {
    for (const size of VM_SIZE_ORDER) {
      const id = defaultCandidateId(poolId, sourceId, provider, location.id, size);
      candidateIds.push(id);
      await db
        .insert(schema.capacityPoolCandidates)
        .values({
          id,
          poolId,
          capacitySourceId: sourceId,
          provider,
          location: location.id,
          workloadRole: DEFAULT_WORKLOAD_ROLE,
          runtime: DEFAULT_RUNTIME,
          machineClass: DEFAULT_MACHINE_CLASS,
          machineSize: size,
          priority: candidateOrder,
          candidateOrder,
          status: ACTIVE_STATUS,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.capacityPoolCandidates.id,
          set: {
            provider,
            location: location.id,
            workloadRole: DEFAULT_WORKLOAD_ROLE,
            runtime: DEFAULT_RUNTIME,
            machineClass: DEFAULT_MACHINE_CLASS,
            machineSize: size,
            priority: candidateOrder,
            candidateOrder,
            status: ACTIVE_STATUS,
            updatedAt: now,
          },
        });
      candidateOrder += 1;
    }
  }

  await disableMissingCandidatesForSource(db, poolId, sourceId, candidateIds);
}

async function disableMissingCandidatesForSource(
  db: Db,
  poolId: string,
  sourceId: string,
  activeCandidateIds: string[]
): Promise<void> {
  const now = new Date().toISOString();
  const predicates = [
    eq(schema.capacityPoolCandidates.poolId, poolId),
    eq(schema.capacityPoolCandidates.capacitySourceId, sourceId),
  ];
  await db
    .update(schema.capacityPoolCandidates)
    .set({ status: DISABLED_STATUS, updatedAt: now })
    .where(
      activeCandidateIds.length > 0
        ? and(...predicates, notInArray(schema.capacityPoolCandidates.id, activeCandidateIds))
        : and(...predicates)
    );
}

async function disableCapacitySourceAvailability(
  db: Db,
  poolId: string,
  sourceId: string
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(schema.capacitySources)
    .set({ status: DISABLED_STATUS, updatedAt: now })
    .where(eq(schema.capacitySources.id, sourceId));
  await db
    .update(schema.capacityPoolCandidates)
    .set({ status: DISABLED_STATUS, updatedAt: now })
    .where(
      and(
        eq(schema.capacityPoolCandidates.poolId, poolId),
        eq(schema.capacityPoolCandidates.capacitySourceId, sourceId)
      )
    );
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

async function reconcileDefaultPoolStatus(db: Db, poolId: string): Promise<void> {
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

async function readDefaultPoolSummary(
  db: Db,
  scope: ScopeIdentity
): Promise<CapacityPoolSummary | null> {
  const [pool] = await db
    .select()
    .from(schema.capacityPools)
    .where(
      and(
        ...poolScopePredicates(scope),
        eq(schema.capacityPools.isDefault, true),
        eq(schema.capacityPools.status, ACTIVE_STATUS)
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
        eq(schema.capacityPoolCandidates.status, ACTIVE_STATUS),
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
  for (const row of rows) {
    sourcesById.set(row.source.id, toCapacitySourceIdentity(row.source));
  }

  const candidates = rows.map((row) => toCapacityPoolCandidate(row.candidate));

  return {
    pool: toCapacityPool(pool),
    sources: [...sourcesById.values()],
    candidates,
    activeCandidateCount: candidates.length,
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

function orderedLocationsForProvider(provider: CredentialProvider) {
  const locations = getLocationsForProvider(provider);
  const defaultLocation = getDefaultLocationForProvider(provider);
  return [
    ...locations.filter((location) => location.id === defaultLocation),
    ...locations.filter((location) => location.id !== defaultLocation),
  ];
}

function defaultPoolId(scope: ScopeIdentity): string {
  switch (scope.scope) {
    case 'installation':
      return 'cap-pool-default:installation';
    case 'user':
      return `cap-pool-default:user:${scope.ownerUserId}`;
    case 'project':
      return `cap-pool-default:project:${scope.ownerProjectId}`;
  }
}

function defaultCapacitySourceId(seed: CredentialCapacitySeed): string {
  if (seed.platformCredentialId) {
    return `cap-source-default:platform:${seed.platformCredentialId}`;
  }
  return `cap-source-default:${seed.scope}:${seed.credentialId}`;
}

function defaultCandidateId(
  poolId: string,
  sourceId: string,
  provider: CredentialProvider,
  location: string,
  size: VMSize
): string {
  return `cap-candidate-default:${poolId}:${sourceId}:${provider}:${location}:${size}`;
}

function legacyCredentialReference(credentialId: string): string {
  return `credentials:${credentialId}`;
}

function platformCredentialReference(credentialId: string): string {
  return `platform_credentials:${credentialId}`;
}

function timestampVersion(timestamp: string | null | undefined): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}
