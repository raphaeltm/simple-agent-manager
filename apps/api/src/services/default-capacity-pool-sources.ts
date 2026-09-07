import type { CapacityCredentialSource, CapacityPoolScope } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';

import * as schema from '../db/schema';
import { capacitySourceAuthorityGeneration } from './capacity-pool-authority';
import { nextCapacityPoolTimestamp } from './capacity-pool-clock';
import { defaultCapacitySourceId, timestampVersion } from './default-capacity-pool-helpers';
import {
  ACTIVE_STATUS,
  CREDENTIAL_TYPE_CLOUD_PROVIDER,
  DISABLED_STATUS,
  nextCapacityPoolScopeGeneration,
  SOURCE_KIND_CLOUD_PROVIDER,
  sourceScopePredicates,
} from './default-capacity-pool-storage';
import { reconcileDefaultPoolStatus } from './default-capacity-pool-summaries';
import {
  type CapacitySourcePublication,
  type CredentialCapacitySeed,
  type Db,
  type ScopeIdentity,
} from './default-capacity-pool-types';
import { catalogSeedStateFingerprint } from './provider-catalogs';
import { fingerprintEncryptedProviderCredential } from './provider-credential-exact';

export async function findCapacitySourceForCredential(
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

export async function insertCapacitySourceForSeed(
  db: Db,
  seed: CredentialCapacitySeed,
  scope: ScopeIdentity
): Promise<CapacitySourcePublication> {
  const id = defaultCapacitySourceId(seed);
  const generation = await nextCapacityPoolScopeGeneration(db, scope);
  const authorityGeneration = await authorityGenerationForSeed(seed, ACTIVE_STATUS);
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
      authorityGeneration,
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

export async function updateCapacitySourceForSeed(
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
  const authorityGeneration = await authorityGenerationForSeed(seed, ACTIVE_STATUS);
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
      authorityGeneration,
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

export async function isCapacitySourceRefreshCurrent(
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

async function authorityGenerationForSeed(
  seed: CredentialCapacitySeed,
  status: typeof ACTIVE_STATUS | typeof DISABLED_STATUS
): Promise<number> {
  return capacitySourceAuthorityGeneration({
    id: defaultCapacitySourceId(seed),
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
    credentialContentFingerprint: await fingerprintEncryptedProviderCredential(
      seed.encryptedToken,
      seed.iv
    ),
    externalSourceRef: seed.externalSourceRef,
    status,
  });
}

function authorityGenerationForSourceRow(
  source: Pick<
    schema.CapacitySource,
    | 'id'
    | 'scope'
    | 'ownerUserId'
    | 'ownerProjectId'
    | 'sourceKind'
    | 'provider'
    | 'credentialSource'
    | 'credentialId'
    | 'platformCredentialId'
    | 'credentialReference'
    | 'credentialVersion'
    | 'externalSourceRef'
  >,
  status: typeof ACTIVE_STATUS | typeof DISABLED_STATUS
): number {
  return capacitySourceAuthorityGeneration({
    id: source.id,
    scope: source.scope as CapacityPoolScope,
    ownerUserId: source.ownerUserId,
    ownerProjectId: source.ownerProjectId,
    sourceKind: SOURCE_KIND_CLOUD_PROVIDER,
    provider: source.provider,
    credentialSource: source.credentialSource as CapacityCredentialSource | null,
    credentialId: source.credentialId,
    platformCredentialId: source.platformCredentialId,
    credentialReference: source.credentialReference,
    credentialVersion: source.credentialVersion,
    externalSourceRef: source.externalSourceRef,
    status,
  });
}

export async function isCapacitySeedStillCurrent(
  db: Db,
  seed: CredentialCapacitySeed,
  expectedActive = true
): Promise<boolean> {
  if (seed.platformCredentialId)
    return isPlatformCapacitySeedStillCurrent(db, seed, expectedActive);
  if (seed.externalSourceRef) return isComposableCapacitySeedStillCurrent(db, seed, expectedActive);
  if (seed.credentialId) return isLegacyCapacitySeedStillCurrent(db, seed, expectedActive);
  return false;
}

async function isLegacyCapacitySeedStillCurrent(
  db: Db,
  seed: CredentialCapacitySeed,
  expectedActive: boolean
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
    row.isActive === expectedActive &&
    row.provider === seed.provider &&
    row.encryptedToken === seed.encryptedToken &&
    row.iv === seed.iv &&
    scopeMatches &&
    credentialVersionMatches(seed, row.updatedAt ?? row.createdAt) &&
    seed.stateFingerprint ===
      catalogSeedStateFingerprint([
        'legacy',
        seed.credentialId,
        row.userId,
        row.projectId,
        row.provider,
        row.credentialType,
        row.isActive,
        row.encryptedToken,
        row.iv,
        row.createdAt,
        row.updatedAt,
      ])
  );
}

async function isPlatformCapacitySeedStillCurrent(
  db: Db,
  seed: CredentialCapacitySeed,
  expectedActive: boolean
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

  if (!row) return false;
  return (
    seed.scope === 'installation' &&
    row.credentialType === CREDENTIAL_TYPE_CLOUD_PROVIDER &&
    row.isEnabled === expectedActive &&
    row.provider === seed.provider &&
    row.encryptedToken === seed.encryptedToken &&
    row.iv === seed.iv &&
    credentialVersionMatches(seed, row.updatedAt ?? row.createdAt) &&
    seed.stateFingerprint ===
      catalogSeedStateFingerprint([
        'platform',
        seed.platformCredentialId,
        row.provider,
        row.credentialType,
        row.isEnabled,
        row.encryptedToken,
        row.iv,
        row.createdAt,
        row.updatedAt,
      ])
  );
}

async function isComposableCapacitySeedStillCurrent(
  db: Db,
  seed: CredentialCapacitySeed,
  expectedActive: boolean
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
      attachmentCreatedAt: schema.ccAttachments.createdAt,
      attachmentUpdatedAt: schema.ccAttachments.updatedAt,
      configurationId: schema.ccConfigurations.id,
      configurationActive: schema.ccConfigurations.isActive,
      configurationOwnerId: schema.ccConfigurations.ownerId,
      configurationConsumerKind: schema.ccConfigurations.consumerKind,
      configurationConsumerTarget: schema.ccConfigurations.consumerTarget,
      configurationCredentialId: schema.ccConfigurations.credentialId,
      configurationCreatedAt: schema.ccConfigurations.createdAt,
      configurationUpdatedAt: schema.ccConfigurations.updatedAt,
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
  const active =
    row.attachmentActive &&
    row.configurationActive &&
    row.credentialActive &&
    !!row.configurationCredentialId;
  const scopeMatches =
    seed.scope === 'project'
      ? row.projectId === seed.ownerProjectId
      : row.projectId === null && row.userId === seed.ownerUserId;

  return (
    scopeMatches &&
    active === expectedActive &&
    row.userId === row.configurationOwnerId &&
    row.credentialOwnerId === row.configurationOwnerId &&
    row.attachmentConsumerKind === 'compute' &&
    row.configurationConsumerKind === 'compute' &&
    row.attachmentConsumerTarget === seed.provider &&
    row.configurationConsumerTarget === seed.provider &&
    row.configurationCredentialId === seed.catalogCredentialId &&
    row.credentialKind === CREDENTIAL_TYPE_CLOUD_PROVIDER &&
    row.encryptedToken === seed.encryptedToken &&
    row.iv === seed.iv &&
    credentialVersionMatches(seed, row.updatedAt ?? row.createdAt) &&
    seed.stateFingerprint ===
      catalogSeedStateFingerprint([
        'composable',
        attachmentId,
        row.configurationId,
        row.userId,
        row.projectId,
        row.attachmentActive,
        row.attachmentConsumerTarget,
        row.attachmentCreatedAt,
        row.attachmentUpdatedAt,
        row.configurationActive,
        row.configurationOwnerId,
        row.configurationConsumerKind,
        row.configurationConsumerTarget,
        row.configurationCredentialId,
        row.configurationCreatedAt,
        row.configurationUpdatedAt,
        seed.catalogCredentialId,
        row.credentialOwnerId,
        row.credentialKind,
        row.credentialActive,
        row.encryptedToken,
        row.iv,
        row.createdAt,
        row.updatedAt,
      ])
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

export async function disableCapacitySourceAvailability(
  db: Db,
  scope: ScopeIdentity,
  source: Pick<
    schema.CapacitySource,
    | 'id'
    | 'scope'
    | 'ownerUserId'
    | 'ownerProjectId'
    | 'sourceKind'
    | 'provider'
    | 'credentialSource'
    | 'credentialId'
    | 'platformCredentialId'
    | 'credentialReference'
    | 'credentialVersion'
    | 'externalSourceRef'
    | 'sourceGeneration'
  >
): Promise<void> {
  const generation = await nextCapacityPoolScopeGeneration(db, scope);
  const authorityGeneration = authorityGenerationForSourceRow(source, DISABLED_STATUS);
  const now = nextCapacityPoolTimestamp();
  await db
    .update(schema.capacitySources)
    .set({
      status: DISABLED_STATUS,
      authorityGeneration,
      sourceGeneration: generation,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.capacitySources.id, source.id),
        eq(schema.capacitySources.sourceGeneration, source.sourceGeneration)
      )
    );
}

export async function disableCapacitySourcesMissingFromSeeds(
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

export function sourceIdentityKeyForSeed(seed: CredentialCapacitySeed): string {
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

export async function disableDefaultPoolAvailability(
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
    .select()
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
