import { isValidProvider } from '@simple-agent-manager/shared';
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';

import * as schema from '../db/schema';
import {
  composableAttachmentReference,
  composableCredentialReference,
  legacyCredentialReference,
  platformCredentialReference,
  timestampVersion,
} from './default-capacity-pool-helpers';
import { type Db, type ProviderCatalogCredentialSeed } from './provider-catalogs-common';

export async function listAuthenticatedProviderCatalogSeeds(
  db: Db,
  input: { userId: string; activeOnly?: boolean }
): Promise<ProviderCatalogCredentialSeed[]> {
  return listUserProviderCatalogSeeds(db, input);
}

export async function listUserProviderCatalogSeeds(
  db: Db,
  input: { userId: string; activeOnly?: boolean }
): Promise<ProviderCatalogCredentialSeed[]> {
  return dedupeCatalogSeeds([
    ...(await listComposableProviderCatalogSeeds(db, {
      userId: input.userId,
      scope: 'user',
      activeOnly: input.activeOnly,
    })),
    ...(await listLegacyProviderCatalogSeeds(db, {
      userId: input.userId,
      scope: 'user',
      activeOnly: input.activeOnly,
    })),
  ]);
}

export async function listProjectProviderCatalogSeeds(
  db: Db,
  input: { projectId: string; userId?: string; activeOnly?: boolean }
): Promise<ProviderCatalogCredentialSeed[]> {
  return dedupeCatalogSeeds([
    ...(await listComposableProviderCatalogSeeds(db, {
      userId: input.userId,
      projectId: input.projectId,
      scope: 'project',
      activeOnly: input.activeOnly,
    })),
    ...(await listLegacyProviderCatalogSeeds(db, {
      projectId: input.projectId,
      scope: 'project',
      activeOnly: input.activeOnly,
    })),
  ]);
}

export async function listInstallationProviderCatalogSeeds(
  db: Db,
  input: { activeOnly?: boolean } = {}
): Promise<ProviderCatalogCredentialSeed[]> {
  const rows = await db
    .select({
      id: schema.platformCredentials.id,
      provider: schema.platformCredentials.provider,
      credentialType: schema.platformCredentials.credentialType,
      encryptedToken: schema.platformCredentials.encryptedToken,
      iv: schema.platformCredentials.iv,
      isEnabled: schema.platformCredentials.isEnabled,
      createdBy: schema.platformCredentials.createdBy,
      createdAt: schema.platformCredentials.createdAt,
      updatedAt: schema.platformCredentials.updatedAt,
    })
    .from(schema.platformCredentials)
    .where(eq(schema.platformCredentials.credentialType, 'cloud-provider'));

  return rows.flatMap((row) => {
    if (!row.provider || !isValidProvider(row.provider)) return [];
    const active = row.isEnabled;
    if (input.activeOnly && !active) return [];
    return [
      {
        id: row.id,
        provider: row.provider,
        encryptedToken: row.encryptedToken,
        iv: row.iv,
        credentialSource: 'platform',
        credentialId: null,
        platformCredentialId: row.id,
        capacitySourceCredentialId: null,
        credentialReference: platformCredentialReference(row.id),
        credentialVersion: timestampVersion(row.updatedAt ?? row.createdAt),
        externalSourceRef: null,
        active,
        createdBy: row.createdBy,
        stateFingerprint: catalogSeedStateFingerprint([
          'platform',
          row.id,
          row.provider,
          row.credentialType,
          row.isEnabled,
          row.encryptedToken,
          row.iv,
          row.createdAt,
          row.updatedAt,
        ]),
      } satisfies ProviderCatalogCredentialSeed,
    ];
  });
}

export async function listLegacyProviderCatalogSeeds(
  db: Db,
  input:
    | { scope: 'authenticated'; userId: string; activeOnly?: boolean }
    | { scope: 'user'; userId: string; activeOnly?: boolean }
    | { scope: 'project'; projectId: string; activeOnly?: boolean }
): Promise<ProviderCatalogCredentialSeed[]> {
  const predicates =
    input.scope === 'project'
      ? [
          eq(schema.credentials.projectId, input.projectId),
          eq(schema.credentials.credentialType, 'cloud-provider'),
        ]
      : [
          eq(schema.credentials.userId, input.userId),
          eq(schema.credentials.credentialType, 'cloud-provider'),
          isNull(schema.credentials.projectId),
        ];
  if (input.activeOnly) predicates.push(eq(schema.credentials.isActive, true));

  const rows = await db
    .select({
      id: schema.credentials.id,
      userId: schema.credentials.userId,
      projectId: schema.credentials.projectId,
      provider: schema.credentials.provider,
      credentialType: schema.credentials.credentialType,
      encryptedToken: schema.credentials.encryptedToken,
      iv: schema.credentials.iv,
      isActive: schema.credentials.isActive,
      createdAt: schema.credentials.createdAt,
      updatedAt: schema.credentials.updatedAt,
    })
    .from(schema.credentials)
    .where(and(...predicates));

  return rows.flatMap((row) => {
    if (!isValidProvider(row.provider)) return [];
    const credentialSource = row.projectId ? 'project' : 'user';
    return [
      {
        id: row.id,
        provider: row.provider,
        encryptedToken: row.encryptedToken,
        iv: row.iv,
        credentialSource,
        credentialId: row.id,
        platformCredentialId: null,
        capacitySourceCredentialId: row.id,
        credentialReference: legacyCredentialReference(row.id),
        credentialVersion: timestampVersion(row.updatedAt ?? row.createdAt),
        externalSourceRef: null,
        active: row.isActive,
        createdBy: row.userId,
        stateFingerprint: catalogSeedStateFingerprint([
          'legacy',
          row.id,
          row.userId,
          row.projectId,
          row.provider,
          row.credentialType,
          row.isActive,
          row.encryptedToken,
          row.iv,
          row.createdAt,
          row.updatedAt,
        ]),
      } satisfies ProviderCatalogCredentialSeed,
    ];
  });
}

export async function listComposableProviderCatalogSeeds(
  db: Db,
  input: {
    userId?: string;
    projectId?: string;
    scope?: 'user' | 'project';
    activeOnly?: boolean;
  }
): Promise<ProviderCatalogCredentialSeed[]> {
  const predicates = [
    eq(schema.ccAttachments.consumerKind, 'compute'),
    eq(schema.ccCredentials.kind, 'cloud-provider'),
    eq(schema.ccConfigurations.ownerId, schema.ccAttachments.userId),
    eq(schema.ccCredentials.ownerId, schema.ccConfigurations.ownerId),
  ];
  if (input.userId && input.scope !== 'project') {
    predicates.push(eq(schema.ccAttachments.userId, input.userId));
  }
  if (input.scope === 'user') {
    predicates.push(isNull(schema.ccAttachments.projectId));
  } else if (input.scope === 'project') {
    predicates.push(eq(schema.ccAttachments.projectId, input.projectId ?? ''));
  } else if (input.userId && !input.projectId) {
    predicates.push(isNull(schema.ccAttachments.projectId));
  } else if (input.projectId) {
    const projectScopePredicate = or(
      isNull(schema.ccAttachments.projectId),
      eq(schema.ccAttachments.projectId, input.projectId)
    );
    if (projectScopePredicate) predicates.push(projectScopePredicate);
  }
  if (input.activeOnly) {
    predicates.push(
      eq(schema.ccAttachments.isActive, true),
      eq(schema.ccConfigurations.isActive, true),
      eq(schema.ccCredentials.isActive, true),
      isNotNull(schema.ccConfigurations.credentialId)
    );
  }

  const rows = await db
    .select({
      attachmentId: schema.ccAttachments.id,
      userId: schema.ccAttachments.userId,
      projectId: schema.ccAttachments.projectId,
      attachmentActive: schema.ccAttachments.isActive,
      consumerTarget: schema.ccAttachments.consumerTarget,
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
      credentialId: schema.ccCredentials.id,
      credentialOwnerId: schema.ccCredentials.ownerId,
      credentialKind: schema.ccCredentials.kind,
      credentialActive: schema.ccCredentials.isActive,
      encryptedToken: schema.ccCredentials.encryptedToken,
      iv: schema.ccCredentials.iv,
      credentialCreatedAt: schema.ccCredentials.createdAt,
      credentialUpdatedAt: schema.ccCredentials.updatedAt,
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
    .where(and(...predicates));

  return rows.flatMap((row) => {
    if (!isValidProvider(row.consumerTarget)) return [];
    const active =
      row.attachmentActive && row.configurationActive && row.credentialActive && !!row.credentialId;
    if (input.activeOnly && !active) return [];
    const credentialSource = row.projectId ? 'project' : 'user';
    const externalSourceRef = composableAttachmentReference(row.attachmentId);
    return [
      {
        id: row.attachmentId,
        provider: row.consumerTarget,
        encryptedToken: row.encryptedToken,
        iv: row.iv,
        credentialSource,
        credentialId: row.credentialId,
        platformCredentialId: null,
        capacitySourceCredentialId: null,
        credentialReference: composableCredentialReference(row.credentialId),
        credentialVersion: timestampVersion(row.credentialUpdatedAt ?? row.credentialCreatedAt),
        externalSourceRef,
        active,
        createdBy: row.userId,
        stateFingerprint: catalogSeedStateFingerprint([
          'composable',
          row.attachmentId,
          row.configurationId,
          row.userId,
          row.projectId,
          row.attachmentActive,
          row.consumerTarget,
          row.attachmentCreatedAt,
          row.attachmentUpdatedAt,
          row.configurationActive,
          row.configurationOwnerId,
          row.configurationConsumerKind,
          row.configurationConsumerTarget,
          row.configurationCredentialId,
          row.configurationCreatedAt,
          row.configurationUpdatedAt,
          row.credentialId,
          row.credentialOwnerId,
          row.credentialKind,
          row.credentialActive,
          row.encryptedToken,
          row.iv,
          row.credentialCreatedAt,
          row.credentialUpdatedAt,
        ]),
      } satisfies ProviderCatalogCredentialSeed,
    ];
  });
}

export function catalogSeedStateFingerprint(parts: readonly unknown[]): string {
  return JSON.stringify(parts);
}

export function dedupeCatalogSeeds(
  seeds: ProviderCatalogCredentialSeed[]
): ProviderCatalogCredentialSeed[] {
  const selected = new Map<string, ProviderCatalogCredentialSeed>();
  for (const seed of seeds) {
    const key = catalogSeedDedupeKey(seed);
    const existing = selected.get(key);
    if (!existing || (isLegacyCredentialSeed(seed) && isLegacyComposableMirrorSeed(existing))) {
      selected.set(key, seed);
    }
  }
  return [...selected.values()];
}

export function catalogSeedDedupeKey(seed: ProviderCatalogCredentialSeed): string {
  const legacyMirrorId = legacyCredentialIdForComposableMirror(seed);
  if (legacyMirrorId) return `${seed.credentialSource}:${seed.provider}:legacy:${legacyMirrorId}`;
  if (seed.capacitySourceCredentialId) {
    return `${seed.credentialSource}:${seed.provider}:legacy:${seed.capacitySourceCredentialId}`;
  }
  return `${seed.credentialSource}:${seed.provider}:${seed.credentialReference}:${seed.externalSourceRef ?? ''}`;
}

export function legacyCredentialIdForComposableMirror(
  seed: ProviderCatalogCredentialSeed
): string | null {
  const ccPrefix = 'cc_credentials:cc-legacy-cloud-cred-';
  const attachmentPrefix = 'cc_attachments:cc-legacy-cloud-att-';
  if (!seed.credentialReference.startsWith(ccPrefix)) return null;
  const credentialId = seed.credentialReference.slice(ccPrefix.length);
  if (!credentialId) return null;
  const expectedAttachment = `${attachmentPrefix}${credentialId}`;
  return seed.externalSourceRef === expectedAttachment ? credentialId : null;
}

export function isLegacyCredentialSeed(seed: ProviderCatalogCredentialSeed): boolean {
  return seed.capacitySourceCredentialId !== null && seed.externalSourceRef === null;
}

export function isLegacyComposableMirrorSeed(seed: ProviderCatalogCredentialSeed): boolean {
  return legacyCredentialIdForComposableMirror(seed) !== null;
}
