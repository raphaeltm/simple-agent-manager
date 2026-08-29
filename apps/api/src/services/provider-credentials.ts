import type {
  Provider,
  ProviderConfig,
  ProviderRequestContext,
} from '@simple-agent-manager/providers';
import { createProvider, GcpProvider } from '@simple-agent-manager/providers';
import {
  computeAssembler,
  type CredentialProvider,
  type CredentialSource,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { lazyBackfillIfNeeded } from './composable-credentials/lazy-backfill';
import { resolveForConsumer } from './composable-credentials/resolve';
import { decrypt } from './encryption';
import { getPlatformCloudCredential } from './platform-credentials';
import {
  buildProviderConfig,
  type HetznerCapacityRetryEnv,
  parseGcpCredential,
} from './provider-credential-codecs';
import {
  createProviderForExactCredential,
  type ExactProviderCredentialBinding,
  type ProviderResolutionResult,
} from './provider-credential-exact';

export type {
  DigitalOceanRuntimeEnv,
  HetznerCapacityRetryEnv,
  InfomaniakRuntimeEnv,
  UpCloudRuntimeEnv,
  VultrRuntimeEnv,
} from './provider-credential-codecs';
export {
  buildProviderConfig,
  extractScalewaySecretKey,
  parseGcpCredential,
  serializeCredentialToken,
  serializeGcpCredential,
  toGcpCredentialMetadata,
} from './provider-credential-codecs';

export type { ExactProviderCredentialBinding, ProviderResolutionResult };

/**
 * Look up a user's cloud-provider credential, decrypt it, and return a ProviderConfig.
 * When `targetProvider` is specified, only returns credentials for that specific provider.
 * Returns null if no credential is found.
 *
 * Note: GCP credentials cannot produce a ProviderConfig directly (they need a runtime
 * token provider). Use `createProviderForUser()` instead for GCP-compatible provider creation.
 */
export async function getUserCloudProviderConfig(
  db: ReturnType<typeof drizzle>,
  userId: string,
  encryptionKey: string,
  targetProvider?: CredentialProvider
): Promise<{ config: ProviderConfig; provider: CredentialProvider } | null> {
  const conditions = [
    eq(schema.credentials.userId, userId),
    eq(schema.credentials.credentialType, 'cloud-provider'),
  ];
  if (targetProvider) {
    conditions.push(eq(schema.credentials.provider, targetProvider));
  }

  const creds = await db
    .select()
    .from(schema.credentials)
    .where(and(...conditions))
    .limit(1);

  const cred = creds[0];
  if (!cred) {
    return null;
  }

  const provider = cred.provider as CredentialProvider;
  const decryptedToken = await decrypt(cred.encryptedToken, cred.iv, encryptionKey);

  // GCP uses OIDC token exchange — cannot produce a static ProviderConfig
  if (provider === 'gcp') {
    throw new Error(
      'GCP credentials require createProviderForUser() — cannot use getUserCloudProviderConfig()'
    );
  }

  const config = buildProviderConfig(provider, decryptedToken);
  return { config, provider };
}

/**
 * Create a Provider instance for a user, handling all provider types including GCP.
 * Falls back to platform credentials when no user credential is found.
 * For GCP, injects the STS token exchange as the token provider.
 *
 * Resolution order (composable-credentials PRIMARY, old path FALLBACK):
 *   1. CC resolver: project-attachment → user-attachment → platform default
 *   2. If cc_* tables are empty, lazy-backfill from legacy tables, retry
 *   3. If CC still returns null, fall back to legacy single-table lookup
 */
export async function createProviderForUser(
  db: ReturnType<typeof drizzle>,
  userId: string,
  encryptionKey: string,
  env: Env & Partial<HetznerCapacityRetryEnv>,
  targetProvider?: CredentialProvider,
  projectId?: string | null,
  exactCredential?: ExactProviderCredentialBinding | null
): Promise<ProviderResolutionResult | null> {
  if (exactCredential) {
    return createProviderForExactCredential(
      db,
      userId,
      encryptionKey,
      env,
      targetProvider,
      projectId,
      exactCredential,
      createProviderFromDecryptedToken
    );
  }

  // --- Primary path: composable-credentials resolver -------------------------
  // CC resolver requires a specific provider name (compute consumers are always
  // provider-specific). When targetProvider is undefined, we skip CC and use the
  // legacy path which handles the "any provider" case. All current call sites
  // that create nodes specify a targetProvider, so this gap is not reachable in
  // practice. When legacy tables are fully retired, all call sites must pass
  // targetProvider explicitly.
  if (targetProvider) {
    const ccResult = await resolveProviderViaCC(
      db,
      userId,
      encryptionKey,
      env,
      targetProvider,
      projectId
    );
    if (ccResult !== undefined) return ccResult;
  }

  // --- Fallback: legacy single-table lookup ----------------------------------
  return createProviderForUserLegacy(db, userId, encryptionKey, env, targetProvider, projectId);
}

async function createProviderFromDecryptedToken(
  providerName: CredentialProvider,
  decryptedToken: string,
  credentialSource: CredentialSource,
  userId: string,
  projectId: string | null,
  env: Env & Partial<HetznerCapacityRetryEnv>
): Promise<ProviderResolutionResult> {
  if (providerName === 'gcp') {
    const gcpCred = parseGcpCredential(decryptedToken);
    const { getGcpAccessToken } = await import('./gcp-sts');
    const cacheUserId =
      credentialSource === 'platform'
        ? `platform:${userId}`
        : credentialSource === 'project' && projectId
          ? `project:${projectId}:${userId}`
          : userId;
    const cacheProjectId = projectId ?? gcpCred.gcpProjectId;
    const tokenProvider = (context?: ProviderRequestContext) =>
      getGcpAccessToken(cacheUserId, cacheProjectId, gcpCred, env, context);
    return {
      provider: new GcpProvider(gcpCred.gcpProjectId, tokenProvider, gcpCred.defaultZone),
      providerName,
      credentialSource,
    };
  }

  const config = buildProviderConfig(providerName, decryptedToken, env);
  return { provider: createProvider(config), providerName, credentialSource };
}

/**
 * Try composable-credentials resolution for compute providers with lazy backfill.
 * Returns `undefined` when CC has no data and fallback should be attempted.
 */
async function resolveProviderViaCC(
  db: ReturnType<typeof drizzle>,
  userId: string,
  encryptionKey: string,
  env: Env & Partial<HetznerCapacityRetryEnv>,
  targetProvider: CredentialProvider,
  projectId?: string | null
): Promise<
  | { provider: Provider; providerName: CredentialProvider; credentialSource: CredentialSource }
  | null
  | undefined
> {
  const consumer = { kind: 'compute' as const, provider: targetProvider };
  let resolved = await resolveForConsumer(db, userId, encryptionKey, consumer, projectId);

  // A platform-only first resolution (isPlatform) must be treated like a miss:
  // an enabled platform default resolves non-null at Tier 3 on the first pass,
  // which would otherwise short-circuit the lazy backfill of the user's own
  // legacy credentials. Run the backfill, then re-resolve so the user's own
  // credential takes precedence over the platform default. Mirrors the
  // agent-path platformOnly logic in resolveAgentKeyViaCC (credentials.ts).
  const platformOnly = resolved !== null && resolved.source === 'platform';
  if (!resolved || platformOnly) {
    const didBackfill = await lazyBackfillIfNeeded(db, userId);
    if (didBackfill) {
      resolved = await resolveForConsumer(db, userId, encryptionKey, consumer, projectId);
    } else if (!resolved) {
      return undefined;
    }
  }

  if (!resolved) return undefined;

  const providerName = targetProvider;
  const credentialSource: CredentialSource =
    resolved.source === 'project-attachment'
      ? 'project'
      : resolved.source === 'user-attachment'
        ? 'user'
        : 'platform';
  const ccConfig = computeAssembler.assemble(resolved);

  // GCP requires runtime STS token exchange — not a simple token
  if (providerName === 'gcp') {
    const gcpCred = parseGcpCredential(ccConfig.token);
    const { getGcpAccessToken } = await import('./gcp-sts');
    const cacheUserId = ccConfig.isPlatform ? `platform:${userId}` : userId;
    const cacheProjectId = projectId ?? gcpCred.gcpProjectId;
    const tokenProvider = (context?: ProviderRequestContext) =>
      getGcpAccessToken(cacheUserId, cacheProjectId, gcpCred, env, context);
    const provider = new GcpProvider(gcpCred.gcpProjectId, tokenProvider, gcpCred.defaultZone);
    return { provider, providerName, credentialSource };
  }

  const config = buildProviderConfig(providerName, ccConfig.token, env);
  return { provider: createProvider(config), providerName, credentialSource };
}

/**
 * Legacy single-table provider resolution (fallback when CC has no data).
 */
async function createProviderForUserLegacy(
  db: ReturnType<typeof drizzle>,
  userId: string,
  encryptionKey: string,
  env: Env & Partial<HetznerCapacityRetryEnv>,
  targetProvider?: CredentialProvider,
  projectId?: string | null
): Promise<{
  provider: Provider;
  providerName: CredentialProvider;
  credentialSource: CredentialSource;
} | null> {
  // 1. Try user's own credential first
  const conditions = [
    eq(schema.credentials.userId, userId),
    eq(schema.credentials.credentialType, 'cloud-provider'),
  ];
  if (targetProvider) {
    conditions.push(eq(schema.credentials.provider, targetProvider));
  }

  const creds = await db
    .select()
    .from(schema.credentials)
    .where(and(...conditions))
    .limit(1);

  const cred = creds[0];
  if (cred) {
    const providerName = cred.provider as CredentialProvider;
    const decryptedToken = await decrypt(cred.encryptedToken, cred.iv, encryptionKey);

    if (providerName === 'gcp') {
      const gcpCred = parseGcpCredential(decryptedToken);
      const { getGcpAccessToken } = await import('./gcp-sts');
      const cacheProjectId = projectId ?? gcpCred.gcpProjectId;
      const tokenProvider = (context?: ProviderRequestContext) =>
        getGcpAccessToken(userId, cacheProjectId, gcpCred, env, context);

      const provider = new GcpProvider(gcpCred.gcpProjectId, tokenProvider, gcpCred.defaultZone);
      return { provider, providerName, credentialSource: 'user' };
    }

    const config = buildProviderConfig(providerName, decryptedToken, env);
    return { provider: createProvider(config), providerName, credentialSource: 'user' };
  }

  // 2. Fall back to platform credential
  const platformCred = await getPlatformCloudCredential(db, encryptionKey, targetProvider);
  if (!platformCred) {
    return null;
  }

  const { decryptedToken, provider: platformProvider } = platformCred;

  if (platformProvider === 'gcp') {
    const gcpCred = parseGcpCredential(decryptedToken);
    const { getGcpAccessToken } = await import('./gcp-sts');
    const cacheProjectId = projectId ?? gcpCred.gcpProjectId;
    const tokenProvider = (context?: ProviderRequestContext) =>
      getGcpAccessToken(`platform:${userId}`, cacheProjectId, gcpCred, env, context);

    const provider = new GcpProvider(gcpCred.gcpProjectId, tokenProvider, gcpCred.defaultZone);
    return { provider, providerName: platformProvider, credentialSource: 'platform' };
  }

  const config = buildProviderConfig(platformProvider, decryptedToken, env);
  return {
    provider: createProvider(config),
    providerName: platformProvider,
    credentialSource: 'platform',
  };
}

/**
 * Lightweight credential source resolution — determines whether 'user' or 'platform'
 * credentials would be used for a given target provider WITHOUT decrypting tokens
 * or instantiating provider instances. Used for quota enforcement gating.
 *
 * Returns 'user' if the user has a cloud-provider credential for the target provider,
 * 'platform' if only a platform credential is available, or null if no credential exists.
 */
export async function resolveCredentialSource(
  db: ReturnType<typeof drizzle>,
  userId: string,
  targetProvider?: CredentialProvider,
  projectId?: string | null
): Promise<{ credentialSource: CredentialSource; providerName: CredentialProvider } | null> {
  const projectCredential = await resolveProjectComputeCredentialSource(
    db,
    userId,
    targetProvider,
    projectId
  );
  if (projectCredential !== undefined) {
    return projectCredential;
  }

  // 1. Check user's own credential for the target provider
  const userConditions = [
    eq(schema.credentials.userId, userId),
    eq(schema.credentials.credentialType, 'cloud-provider'),
  ];
  if (targetProvider) {
    userConditions.push(eq(schema.credentials.provider, targetProvider));
  }

  const [userCred] = await db
    .select({ id: schema.credentials.id, provider: schema.credentials.provider })
    .from(schema.credentials)
    .where(and(...userConditions))
    .limit(1);

  if (userCred) {
    return {
      credentialSource: 'user',
      providerName: userCred.provider as CredentialProvider,
    };
  }

  // 2. Check platform credential
  const platformConditions = [
    eq(schema.platformCredentials.credentialType, 'cloud-provider'),
    eq(schema.platformCredentials.isEnabled, true),
  ];
  if (targetProvider) {
    platformConditions.push(eq(schema.platformCredentials.provider, targetProvider));
  }

  const [platformCred] = await db
    .select({ id: schema.platformCredentials.id, provider: schema.platformCredentials.provider })
    .from(schema.platformCredentials)
    .where(and(...platformConditions))
    .limit(1);

  if (platformCred?.provider) {
    return {
      credentialSource: 'platform',
      providerName: platformCred.provider as CredentialProvider,
    };
  }

  return null;
}

async function resolveProjectComputeCredentialSource(
  db: ReturnType<typeof drizzle>,
  userId: string,
  targetProvider?: CredentialProvider,
  projectId?: string | null
): Promise<
  { credentialSource: CredentialSource; providerName: CredentialProvider } | null | undefined
> {
  if (!projectId) return undefined;

  const conditions = [
    eq(schema.ccAttachments.userId, userId),
    eq(schema.ccAttachments.projectId, projectId),
    eq(schema.ccAttachments.consumerKind, 'compute'),
  ];
  if (targetProvider) {
    conditions.push(eq(schema.ccAttachments.consumerTarget, targetProvider));
  }

  const rows = await db
    .select({
      attachmentActive: schema.ccAttachments.isActive,
      consumerTarget: schema.ccAttachments.consumerTarget,
      configurationActive: schema.ccConfigurations.isActive,
      credentialId: schema.ccConfigurations.credentialId,
      credentialActive: schema.ccCredentials.isActive,
    })
    .from(schema.ccAttachments)
    .innerJoin(
      schema.ccConfigurations,
      eq(schema.ccAttachments.configurationId, schema.ccConfigurations.id)
    )
    .leftJoin(
      schema.ccCredentials,
      eq(schema.ccConfigurations.credentialId, schema.ccCredentials.id)
    )
    .where(and(...conditions))
    .limit(targetProvider ? 1 : 2);

  if (rows.length === 0) return undefined;
  if (rows.length > 1) return null;

  const row = rows[0];
  if (!row) return null;
  if (!row.attachmentActive || !row.configurationActive) return null;
  if (row.credentialId && !row.credentialActive) return null;

  return {
    credentialSource: 'project',
    providerName: row.consumerTarget as CredentialProvider,
  };
}
