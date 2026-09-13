import type { Provider } from '@simple-agent-manager/providers';
import type { CredentialProvider, CredentialSource } from '@simple-agent-manager/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { timestampVersion } from './default-capacity-pool-helpers';
import { decrypt } from './encryption';
import { extractCloudProviderToken } from './provider-credential-codecs';

export type ProviderResolutionResult = {
  provider: Provider;
  providerName: CredentialProvider;
  credentialSource: CredentialSource;
  /** Exact persisted account binding used to construct this provider. */
  exactCredentialBinding?: ExactProviderCredentialBinding;
};

export interface ExactProviderCredentialBinding {
  credentialSource: CredentialSource;
  credentialReference: string | null | undefined;
  /** Updated-at snapshot used to fence placement before a runtime exists. */
  credentialVersion?: number | null;
  /** Immutable content fingerprint: the preferred proof when deleting an existing runtime. */
  credentialFingerprint?: string | null;
}

export interface ProviderCredentialPlacementSnapshot {
  capacityPoolId?: string | null;
  placementCredentialSource?: string | null;
  placementCredentialReference?: string | null;
  placementCredentialVersion?: number | null;
  placementCredentialFingerprint?: string | null;
}

type ParsedProviderCredentialReference =
  | { kind: 'credential'; id: string }
  | { kind: 'ccCredential'; id: string }
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
  const ccCredentialPrefix = 'cc_credentials:';
  if (trimmed.startsWith(ccCredentialPrefix)) {
    const id = trimmed.slice(ccCredentialPrefix.length).trim();
    return id ? { kind: 'ccCredential', id } : null;
  }
  const platformPrefix = 'platform_credentials:';
  if (trimmed.startsWith(platformPrefix)) {
    const id = trimmed.slice(platformPrefix.length).trim();
    return id ? { kind: 'platformCredential', id } : null;
  }
  return null;
}

export function isExactCredentialSource(value: string | null | undefined): value is CredentialSource {
  return value === 'user' || value === 'project' || value === 'platform';
}

/**
 * Return a non-secret, immutable identity for one stored ciphertext generation. Re-encrypting
 * the same provider token intentionally changes this value because strict teardown must never
 * assume that a mutable credential-row ID still names the account used for provisioning.
 */
export async function fingerprintEncryptedProviderCredential(
  encryptedToken: string,
  iv: string
): Promise<string> {
  const encoded = new TextEncoder().encode(`provider-credential-v1\0${iv}\0${encryptedToken}`);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function exactCredentialGenerationMatches(
  exactCredential: ExactProviderCredentialBinding,
  row: { encryptedToken: string; iv: string; createdAt?: string | null; updatedAt?: string | null }
): Promise<{ matches: boolean; fingerprint: string }> {
  const fingerprint = await fingerprintEncryptedProviderCredential(row.encryptedToken, row.iv);
  if (exactCredential.credentialFingerprint) {
    return { matches: fingerprint === exactCredential.credentialFingerprint, fingerprint };
  }

  const currentVersion = timestampVersion(row.updatedAt ?? row.createdAt);
  return {
    matches:
      exactCredential.credentialVersion != null &&
      currentVersion != null &&
      currentVersion === exactCredential.credentialVersion,
    fingerprint,
  };
}

function withCredentialFingerprint(
  exactCredential: ExactProviderCredentialBinding,
  credentialFingerprint: string
): ExactProviderCredentialBinding {
  return { ...exactCredential, credentialFingerprint };
}

/**
 * Does this binding carry a generation proof strong enough to authorize destroying an
 * existing runtime?
 *
 * `credentialFingerprint` is the preferred proof: an immutable identity for one stored
 * ciphertext generation, introduced by migration 0142. `credentialVersion` is the WEAKER
 * legacy proof — the credential row's `updated_at` snapshot taken at placement time.
 *
 * Requiring a fingerprint outright strands every node provisioned before 0142: that column
 * is backfill-proof by construction, so those rows can never satisfy it and become
 * permanently undeletable, retrying teardown forever with no operator override. Accepting
 * version-only proof is exactly as strong as the binding that provisioned them.
 *
 * Why the version snapshot still detects rotation, enumerated per writer (rules 44, 71).
 * Scope matters: this is a claim about the rows this path can actually resolve, which
 * `createProviderForExactCredential` filters to `credentialType='cloud-provider'`.
 *
 * | Writer | Table / type | Bumps `updated_at`? |
 * | --- | --- | --- |
 * | `routes/credentials.ts` (user connect/rotate) | `credentials`, cloud-provider | yes, `new Date().toISOString()` |
 * | `routes/projects/credentials.ts` (project rotate) | `credentials`, cloud-provider | yes, `new Date().toISOString()` |
 * | `durable-objects/codex-refresh-lock.ts` | `credentials`, `agent-api-key` | yes, but SQL `datetime('now')` — SECOND precision. Out of scope: the cloud-provider filter excludes it. A future cloud-provider writer using this pattern would silently coarsen the fence to one second. |
 * | `services/default-capacity-source-credentials.ts` | `credentials`, capacity-source type | yes, and also out of scope for the same reason |
 * | `composable-credentials/compute-sync.ts` | `cc_credentials`, compute | never mutates ciphertext in place — rotation inserts a NEW row with a new id, so an old reference's generation is frozen. Stronger than the legacy table. |
 *
 * ACCEPTED RESIDUAL RISK: `timestampVersion` is millisecond-resolution, so two ciphertext
 * generations written to the same row within one millisecond would compare equal. That needs
 * two D1 writes to one row inside 1 ms; the blast radius is bounded to the same user's own
 * rotated credential (tenant scoping is a separate predicate this does not touch), and the
 * status quo it replaces was "this node can never be deleted". Accepted, not mitigated.
 *
 * This is NOT a relaxation for fingerprinted rows: `exactCredentialGenerationMatches` returns
 * on the fingerprint branch when one is present, so a matching version can never rescue a
 * binding whose fingerprint has moved. The truthiness check on `credentialFingerprint` below
 * deliberately mirrors that function's own `if (exactCredential.credentialFingerprint)`, so an
 * empty-string fingerprint is treated as absent by both rather than as proof by one of them.
 */
export function hasExactProviderCredentialGenerationProof(
  binding: ExactProviderCredentialBinding | null | undefined
): boolean {
  if (!binding?.credentialReference) return false;
  return Boolean(binding.credentialFingerprint) || binding.credentialVersion != null;
}

export function exactProviderCredentialBindingFromPlacementSnapshot(
  snapshot: ProviderCredentialPlacementSnapshot
): ExactProviderCredentialBinding | null {
  if (
    !isExactCredentialSource(snapshot.placementCredentialSource) ||
    !snapshot.placementCredentialReference
  ) {
    return null;
  }

  return {
    credentialSource: snapshot.placementCredentialSource,
    credentialReference: snapshot.placementCredentialReference,
    credentialVersion: snapshot.placementCredentialVersion ?? null,
    credentialFingerprint: snapshot.placementCredentialFingerprint ?? null,
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
    const generation = await exactCredentialGenerationMatches(exactCredential, platformCred);
    if (!generation.matches) return null;
    const decryptedToken = await decrypt(
      platformCred.encryptedToken,
      platformCred.iv,
      encryptionKey
    );
    const result = await createProviderFromDecryptedToken(
      platformCred.provider as CredentialProvider,
      decryptedToken,
      'platform',
      userId,
      projectId ?? null,
      env
    );
    return {
      ...result,
      exactCredentialBinding: withCredentialFingerprint(exactCredential, generation.fingerprint),
    };
  }

  if (exactCredential.credentialSource === 'user') {
    if (reference.kind === 'ccCredential') {
      const result = await createProviderForExactComposableCredential(
        db,
        userId,
        encryptionKey,
        env,
        targetProvider,
        projectId ?? null,
        reference.id,
        'user',
        exactCredential,
        createProviderFromDecryptedToken
      );
      return result;
    }
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
    const generation = await exactCredentialGenerationMatches(exactCredential, cred);
    if (!generation.matches) return null;
    const decryptedToken = await decrypt(cred.encryptedToken, cred.iv, encryptionKey);
    const result = await createProviderFromDecryptedToken(
      cred.provider as CredentialProvider,
      decryptedToken,
      'user',
      userId,
      projectId ?? null,
      env
    );
    return {
      ...result,
      exactCredentialBinding: withCredentialFingerprint(exactCredential, generation.fingerprint),
    };
  }

  if (exactCredential.credentialSource === 'project') {
    if (reference.kind === 'ccCredential') {
      if (!projectId) return null;
      const result = await createProviderForExactComposableCredential(
        db,
        userId,
        encryptionKey,
        env,
        targetProvider,
        projectId,
        reference.id,
        'project',
        exactCredential,
        createProviderFromDecryptedToken
      );
      return result;
    }
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
    const generation = await exactCredentialGenerationMatches(exactCredential, cred);
    if (!generation.matches) return null;
    const decryptedToken = await decrypt(cred.encryptedToken, cred.iv, encryptionKey);
    const result = await createProviderFromDecryptedToken(
      cred.provider as CredentialProvider,
      decryptedToken,
      'project',
      userId,
      projectId,
      env
    );
    return {
      ...result,
      exactCredentialBinding: withCredentialFingerprint(exactCredential, generation.fingerprint),
    };
  }

  return null;
}

async function createProviderForExactComposableCredential<TEnv extends Env>(
  db: ReturnType<typeof drizzle>,
  userId: string,
  encryptionKey: string,
  env: TEnv,
  targetProvider: CredentialProvider,
  projectId: string | null,
  credentialId: string,
  credentialSource: 'user' | 'project',
  exactCredential: ExactProviderCredentialBinding,
  createProviderFromDecryptedToken: ProviderFactory<TEnv>
): Promise<ProviderResolutionResult | null> {
  const attachmentPredicates = [
    eq(schema.ccAttachments.consumerKind, 'compute'),
    eq(schema.ccAttachments.consumerTarget, targetProvider),
    eq(schema.ccAttachments.isActive, true),
    ...(credentialSource === 'project'
      ? [eq(schema.ccAttachments.projectId, projectId ?? '')]
      : [eq(schema.ccAttachments.userId, userId), isNull(schema.ccAttachments.projectId)]),
  ];
  const credentialPredicates = [
    eq(schema.ccCredentials.id, credentialId),
    eq(schema.ccCredentials.kind, 'cloud-provider'),
    eq(schema.ccCredentials.isActive, true),
    ...(credentialSource === 'project' ? [] : [eq(schema.ccCredentials.ownerId, userId)]),
  ];

  const [row] = await db
    .select({
      encryptedToken: schema.ccCredentials.encryptedToken,
      iv: schema.ccCredentials.iv,
      createdAt: schema.ccCredentials.createdAt,
      updatedAt: schema.ccCredentials.updatedAt,
    })
    .from(schema.ccCredentials)
    .innerJoin(
      schema.ccConfigurations,
      eq(schema.ccConfigurations.credentialId, schema.ccCredentials.id)
    )
    .innerJoin(
      schema.ccAttachments,
      eq(schema.ccAttachments.configurationId, schema.ccConfigurations.id)
    )
    .where(
      and(
        ...credentialPredicates,
        eq(schema.ccConfigurations.consumerKind, 'compute'),
        eq(schema.ccConfigurations.consumerTarget, targetProvider),
        eq(schema.ccConfigurations.isActive, true),
        eq(schema.ccConfigurations.ownerId, schema.ccAttachments.userId),
        eq(schema.ccCredentials.ownerId, schema.ccConfigurations.ownerId),
        ...attachmentPredicates
      )
    )
    .limit(1);

  if (!row) return null;
  const generation = await exactCredentialGenerationMatches(exactCredential, row);
  if (!generation.matches) return null;
  const decryptedToken = await decrypt(row.encryptedToken, row.iv, encryptionKey);
  const providerToken = extractCloudProviderToken(targetProvider, decryptedToken);
  const result = await createProviderFromDecryptedToken(
    targetProvider,
    providerToken,
    credentialSource,
    userId,
    projectId,
    env
  );
  return {
    ...result,
    exactCredentialBinding: withCredentialFingerprint(exactCredential, generation.fingerprint),
  };
}
