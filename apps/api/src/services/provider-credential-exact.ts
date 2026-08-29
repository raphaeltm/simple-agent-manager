import type { Provider } from '@simple-agent-manager/providers';
import type { CredentialProvider, CredentialSource } from '@simple-agent-manager/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { decrypt } from './encryption';

export type ProviderResolutionResult = {
  provider: Provider;
  providerName: CredentialProvider;
  credentialSource: CredentialSource;
};

export interface ExactProviderCredentialBinding {
  credentialSource: CredentialSource;
  credentialReference: string | null | undefined;
  /** Audit-only until durable provider credential version history exists. */
  credentialVersion?: number | null;
}

export interface ProviderCredentialPlacementSnapshot {
  capacityPoolId?: string | null;
  placementCredentialSource?: string | null;
  placementCredentialReference?: string | null;
  placementCredentialVersion?: number | null;
}

type ParsedProviderCredentialReference =
  | { kind: 'credential'; id: string }
  | { kind: 'platformCredential'; id: string };

type ProviderFactory<TEnv extends Env> = (
  providerName: CredentialProvider,
  decryptedToken: string,
  credentialSource: CredentialSource,
  userId: string,
  projectId: string | null,
  env: TEnv
) => Promise<ProviderResolutionResult>;

function parseProviderCredentialReference(
  reference: string | null | undefined
): ParsedProviderCredentialReference | null {
  const trimmed = reference?.trim();
  if (!trimmed) return null;
  const credentialPrefix = 'credentials:';
  if (trimmed.startsWith(credentialPrefix)) {
    const id = trimmed.slice(credentialPrefix.length).trim();
    return id ? { kind: 'credential', id } : null;
  }
  const platformPrefix = 'platform_credentials:';
  if (trimmed.startsWith(platformPrefix)) {
    const id = trimmed.slice(platformPrefix.length).trim();
    return id ? { kind: 'platformCredential', id } : null;
  }
  return null;
}

function isExactCredentialSource(value: string | null | undefined): value is CredentialSource {
  return value === 'user' || value === 'project' || value === 'platform';
}

export function exactProviderCredentialBindingFromPlacementSnapshot(
  snapshot: ProviderCredentialPlacementSnapshot
): ExactProviderCredentialBinding | null {
  if (
    !snapshot.capacityPoolId ||
    !isExactCredentialSource(snapshot.placementCredentialSource) ||
    !snapshot.placementCredentialReference
  ) {
    return null;
  }

  return {
    credentialSource: snapshot.placementCredentialSource,
    credentialReference: snapshot.placementCredentialReference,
    credentialVersion: snapshot.placementCredentialVersion ?? null,
  };
}

export async function createProviderForExactCredential<TEnv extends Env>(
  db: ReturnType<typeof drizzle>,
  userId: string,
  encryptionKey: string,
  env: TEnv,
  targetProvider: CredentialProvider | undefined,
  projectId: string | null | undefined,
  exactCredential: ExactProviderCredentialBinding,
  createProviderFromDecryptedToken: ProviderFactory<TEnv>
): Promise<ProviderResolutionResult | null> {
  if (!targetProvider) return null;
  const reference = parseProviderCredentialReference(exactCredential.credentialReference);
  if (!reference) return null;

  if (exactCredential.credentialSource === 'platform') {
    if (reference.kind !== 'platformCredential') return null;
    const [platformCred] = await db
      .select()
      .from(schema.platformCredentials)
      .where(
        and(
          eq(schema.platformCredentials.id, reference.id),
          eq(schema.platformCredentials.credentialType, 'cloud-provider'),
          eq(schema.platformCredentials.isEnabled, true),
          eq(schema.platformCredentials.provider, targetProvider)
        )
      )
      .limit(1);

    if (!platformCred?.provider) return null;
    const decryptedToken = await decrypt(platformCred.encryptedToken, platformCred.iv, encryptionKey);
    return createProviderFromDecryptedToken(
      platformCred.provider as CredentialProvider,
      decryptedToken,
      'platform',
      userId,
      projectId ?? null,
      env
    );
  }

  if (exactCredential.credentialSource === 'user') {
    if (reference.kind !== 'credential') return null;
    const [cred] = await db
      .select()
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.id, reference.id),
          eq(schema.credentials.userId, userId),
          isNull(schema.credentials.projectId),
          eq(schema.credentials.credentialType, 'cloud-provider'),
          eq(schema.credentials.isActive, true),
          eq(schema.credentials.provider, targetProvider)
        )
      )
      .limit(1);

    if (!cred) return null;
    const decryptedToken = await decrypt(cred.encryptedToken, cred.iv, encryptionKey);
    return createProviderFromDecryptedToken(
      cred.provider as CredentialProvider,
      decryptedToken,
      'user',
      userId,
      projectId ?? null,
      env
    );
  }

  if (exactCredential.credentialSource === 'project') {
    if (reference.kind !== 'credential' || !projectId) return null;
    const [cred] = await db
      .select()
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.id, reference.id),
          eq(schema.credentials.projectId, projectId),
          eq(schema.credentials.credentialType, 'cloud-provider'),
          eq(schema.credentials.isActive, true),
          eq(schema.credentials.provider, targetProvider)
        )
      )
      .limit(1);

    if (!cred) return null;
    const decryptedToken = await decrypt(cred.encryptedToken, cred.iv, encryptionKey);
    return createProviderFromDecryptedToken(
      cred.provider as CredentialProvider,
      decryptedToken,
      'project',
      userId,
      projectId,
      env
    );
  }

  return null;
}
