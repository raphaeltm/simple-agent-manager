import type { Provider, ProviderConfig } from '@simple-agent-manager/providers';
import { createProvider, GcpProvider } from '@simple-agent-manager/providers';
import {
  computeAssembler,
  type CredentialProvider,
  type CredentialSource,
  GCP_CREDENTIAL_VERSION,
  type GcpCredential,
  type GcpCredentialMetadata,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { expectJsonRecord } from '../lib/runtime-validation';
import { lazyBackfillIfNeeded } from './composable-credentials/lazy-backfill';
import { resolveForConsumer } from './composable-credentials/resolve';
import { decrypt } from './encryption';
import { getPlatformCloudCredential } from './platform-credentials';

/**
 * Serialize provider-specific credential fields into a single string for encryption.
 * Hetzner stores the raw API token; multi-field providers store JSON.
 */
export function serializeCredentialToken(
  provider: CredentialProvider,
  fields: Record<string, string>,
): string {
  switch (provider) {
    case 'hetzner':
      return fields.token ?? '';
    case 'scaleway':
      return JSON.stringify({ secretKey: fields.secretKey, projectId: fields.projectId });
    case 'gcp':
      return JSON.stringify({
        version: GCP_CREDENTIAL_VERSION,
        provider: 'gcp',
        authType: 'workload-identity',
        gcpProjectId: fields.gcpProjectId,
        gcpProjectNumber: fields.gcpProjectNumber,
        serviceAccountEmail: fields.serviceAccountEmail,
        wifPoolId: fields.wifPoolId,
        wifProviderId: fields.wifProviderId,
        defaultZone: fields.defaultZone,
      });
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported provider: ${_exhaustive}`);
    }
  }
}

/**
 * Extract the Scaleway secret key from a decrypted Scaleway cloud credential token.
 * Returns null if the token is not valid JSON or does not contain a secretKey field.
 * Used by both the provider system and the OpenCode agent key fallback.
 */
export function extractScalewaySecretKey(decryptedToken: string): string | null {
  try {
    const parsed = expectJsonRecord(JSON.parse(decryptedToken), 'provider.scaleway_credential');
    if (typeof parsed?.secretKey === 'string' && parsed.secretKey) {
      return parsed.secretKey;
    }
    return null;
  } catch {
    return null;
  }
}

/** Parse an optional env var string to a positive integer, or return undefined. */
function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Env vars that tune Hetzner capacity retry behavior. */
export interface HetznerCapacityRetryEnv {
  HETZNER_CAPACITY_RETRY_INITIAL_DELAY_MS?: string;
  HETZNER_CAPACITY_RETRY_MAX_DELAY_MS?: string;
  HETZNER_CAPACITY_RETRY_MAX_ATTEMPTS?: string;
  HETZNER_CAPACITY_RETRY_BUDGET_MS?: string;
}

/**
 * Build a ProviderConfig from a provider name and decrypted credential token.
 * Handles both raw token strings (Hetzner) and JSON blobs (Scaleway).
 */
export function buildProviderConfig(
  provider: CredentialProvider,
  decryptedToken: string,
  hetznerEnv?: HetznerCapacityRetryEnv,
): ProviderConfig {
  switch (provider) {
    case 'hetzner':
      return {
        provider: 'hetzner',
        apiToken: decryptedToken,
        capacityRetryInitialDelayMs: parseOptionalInt(hetznerEnv?.HETZNER_CAPACITY_RETRY_INITIAL_DELAY_MS),
        capacityRetryMaxDelayMs: parseOptionalInt(hetznerEnv?.HETZNER_CAPACITY_RETRY_MAX_DELAY_MS),
        capacityRetryMaxAttempts: parseOptionalInt(hetznerEnv?.HETZNER_CAPACITY_RETRY_MAX_ATTEMPTS),
        capacityRetryBudgetMs: parseOptionalInt(hetznerEnv?.HETZNER_CAPACITY_RETRY_BUDGET_MS),
      };
    case 'scaleway': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(decryptedToken);
      } catch {
        throw new Error('Invalid Scaleway credential format: malformed stored data');
      }
      const obj = expectJsonRecord(parsed, 'provider.scaleway_credential');
      if (typeof obj?.secretKey !== 'string' || !obj.secretKey || typeof obj?.projectId !== 'string' || !obj.projectId) {
        throw new Error('Invalid Scaleway credential format: missing secretKey or projectId');
      }
      return { provider: 'scaleway', secretKey: obj.secretKey, projectId: obj.projectId };
    }
    case 'gcp':
      // GCP credentials are metadata (not secrets). The tokenProvider must be injected
      // at a higher layer via buildGcpProviderConfig() since it depends on the env/JWT context.
      throw new Error('GCP credentials require buildGcpProviderConfig() — cannot use buildProviderConfig() directly');
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

function requiredGcpString(
  obj: Record<string, unknown>,
  field: string,
): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid GCP credential format: missing ${field}`);
  }
  return value;
}

/** Return the browser-safe projection of a normalized GCP credential. */
export function toGcpCredentialMetadata(credential: GcpCredential): GcpCredentialMetadata {
  return {
    authType: credential.authType,
    gcpProjectId: credential.gcpProjectId,
    serviceAccountEmail: credential.serviceAccountEmail,
    defaultZone: credential.defaultZone,
    ...(credential.authType === 'service-account-key'
      ? { privateKeyId: credential.privateKeyId }
      : {}),
  };
}

/** Serialize a normalized, versioned GCP credential for encrypted storage. */
export function serializeGcpCredential(credential: GcpCredential): string {
  return JSON.stringify(credential);
}

/**
 * Parse a decrypted GCP credential token. Existing unversioned blobs are
 * normalized as workload-identity credentials for migration-free compatibility.
 */
export function parseGcpCredential(decryptedToken: string): GcpCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptedToken);
  } catch {
    throw new Error('Invalid GCP credential format: malformed stored data');
  }
  const obj = expectJsonRecord(parsed, 'provider.gcp_credential');
  if (typeof obj.provider === 'string' && obj.provider !== 'gcp') {
    throw new Error(`Invalid GCP credential format: provider is ${obj.provider}`);
  }

  const legacy = obj.authType === undefined && obj.version === undefined;
  if (!legacy && obj.version !== GCP_CREDENTIAL_VERSION) {
    throw new Error('Invalid GCP credential format: unsupported version');
  }
  const authType = legacy ? 'workload-identity' : obj.authType;

  if (authType === 'workload-identity') {
    return {
      version: GCP_CREDENTIAL_VERSION,
      provider: 'gcp',
      authType,
      gcpProjectId: requiredGcpString(obj, 'gcpProjectId'),
      gcpProjectNumber: requiredGcpString(obj, 'gcpProjectNumber'),
      serviceAccountEmail: requiredGcpString(obj, 'serviceAccountEmail'),
      wifPoolId: requiredGcpString(obj, 'wifPoolId'),
      wifProviderId: requiredGcpString(obj, 'wifProviderId'),
      defaultZone: requiredGcpString(obj, 'defaultZone'),
    };
  }

  if (authType === 'service-account-key') {
    return {
      version: GCP_CREDENTIAL_VERSION,
      provider: 'gcp',
      authType,
      gcpProjectId: requiredGcpString(obj, 'gcpProjectId'),
      serviceAccountEmail: requiredGcpString(obj, 'serviceAccountEmail'),
      privateKeyId: requiredGcpString(obj, 'privateKeyId'),
      privateKey: requiredGcpString(obj, 'privateKey'),
      defaultZone: requiredGcpString(obj, 'defaultZone'),
    };
  }

  throw new Error('Invalid GCP credential format: unsupported authType');
}

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
  targetProvider?: CredentialProvider,
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
    throw new Error('GCP credentials require createProviderForUser() — cannot use getUserCloudProviderConfig()');
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
): Promise<{ provider: Provider; providerName: CredentialProvider; credentialSource: CredentialSource } | null> {
  // --- Primary path: composable-credentials resolver -------------------------
  // CC resolver requires a specific provider name (compute consumers are always
  // provider-specific). When targetProvider is undefined, we skip CC and use the
  // legacy path which handles the "any provider" case. All current call sites
  // that create nodes specify a targetProvider, so this gap is not reachable in
  // practice. When legacy tables are fully retired, all call sites must pass
  // targetProvider explicitly.
  if (targetProvider) {
    const ccResult = await resolveProviderViaCC(db, userId, encryptionKey, env, targetProvider, projectId);
    if (ccResult !== undefined) return ccResult;
  }

  // --- Fallback: legacy single-table lookup ----------------------------------
  return createProviderForUserLegacy(db, userId, encryptionKey, env, targetProvider, projectId);
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
  projectId?: string | null,
): Promise<{ provider: Provider; providerName: CredentialProvider; credentialSource: CredentialSource } | null | undefined> {
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
    const tokenProvider = () => getGcpAccessToken(cacheUserId, cacheProjectId, gcpCred, env);
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
  projectId?: string | null,
): Promise<{ provider: Provider; providerName: CredentialProvider; credentialSource: CredentialSource } | null> {
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
      const tokenProvider = () => getGcpAccessToken(userId, cacheProjectId, gcpCred, env);

      const provider = new GcpProvider(
        gcpCred.gcpProjectId,
        tokenProvider,
        gcpCred.defaultZone,
      );
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
    const tokenProvider = () => getGcpAccessToken(`platform:${userId}`, cacheProjectId, gcpCred, env);

    const provider = new GcpProvider(
      gcpCred.gcpProjectId,
      tokenProvider,
      gcpCred.defaultZone,
    );
    return { provider, providerName: platformProvider, credentialSource: 'platform' };
  }

  const config = buildProviderConfig(platformProvider, decryptedToken, env);
  return { provider: createProvider(config), providerName: platformProvider, credentialSource: 'platform' };
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
  projectId?: string | null,
): Promise<{ credentialSource: CredentialSource; providerName: CredentialProvider } | null> {
  const projectCredential = await resolveProjectComputeCredentialSource(db, userId, targetProvider, projectId);
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
  projectId?: string | null,
): Promise<{ credentialSource: CredentialSource; providerName: CredentialProvider } | null | undefined> {
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
    .innerJoin(schema.ccConfigurations, eq(schema.ccAttachments.configurationId, schema.ccConfigurations.id))
    .leftJoin(schema.ccCredentials, eq(schema.ccConfigurations.credentialId, schema.ccCredentials.id))
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
