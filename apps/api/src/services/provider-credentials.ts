import type { Provider, ProviderConfig } from '@simple-agent-manager/providers';
import { createProvider, GcpProvider } from '@simple-agent-manager/providers';
import type { CredentialProvider, CredentialSource, GcpOidcCredential } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
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
    const parsed = JSON.parse(decryptedToken) as Record<string, unknown>;
    if (typeof parsed?.secretKey === 'string' && parsed.secretKey) {
      return parsed.secretKey;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build a ProviderConfig from a provider name and decrypted credential token.
 * Handles both raw token strings (Hetzner) and JSON blobs (Scaleway).
 */
export function buildProviderConfig(
  provider: CredentialProvider,
  decryptedToken: string,
): ProviderConfig {
  switch (provider) {
    case 'hetzner':
      return { provider: 'hetzner', apiToken: decryptedToken };
    case 'scaleway': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(decryptedToken);
      } catch {
        throw new Error('Invalid Scaleway credential format: malformed stored data');
      }
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid Scaleway credential format: expected JSON object');
      }
      const obj = parsed as Record<string, unknown>;
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

/**
 * Parse a decrypted GCP credential token into structured GcpOidcCredential fields.
 */
export function parseGcpCredential(decryptedToken: string): GcpOidcCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptedToken);
  } catch {
    throw new Error('Invalid GCP credential format: malformed stored data');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid GCP credential format: expected JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj?.gcpProjectId !== 'string' || !obj.gcpProjectId ||
    typeof obj?.gcpProjectNumber !== 'string' || !obj.gcpProjectNumber ||
    typeof obj?.serviceAccountEmail !== 'string' || !obj.serviceAccountEmail ||
    typeof obj?.wifPoolId !== 'string' || !obj.wifPoolId ||
    typeof obj?.wifProviderId !== 'string' || !obj.wifProviderId ||
    typeof obj?.defaultZone !== 'string' || !obj.defaultZone
  ) {
    throw new Error('Invalid GCP credential format: missing required fields');
  }
  return {
    provider: 'gcp',
    gcpProjectId: obj.gcpProjectId,
    gcpProjectNumber: obj.gcpProjectNumber,
    serviceAccountEmail: obj.serviceAccountEmail,
    wifPoolId: obj.wifPoolId,
    wifProviderId: obj.wifProviderId,
    defaultZone: obj.defaultZone,
  };
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
 */
export async function createProviderForUser(
  db: ReturnType<typeof drizzle>,
  userId: string,
  encryptionKey: string,
  env: { KV: KVNamespace; BASE_DOMAIN: string; JWT_PRIVATE_KEY: string; JWT_PUBLIC_KEY: string; GCP_IDENTITY_TOKEN_EXPIRY_SECONDS?: string; GCP_TOKEN_CACHE_TTL_SECONDS?: string; GCP_API_TIMEOUT_MS?: string; GCP_OPERATION_POLL_TIMEOUT_MS?: string },
  targetProvider?: CredentialProvider,
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
      const tokenProvider = () => getGcpAccessToken(userId, gcpCred.gcpProjectId, gcpCred, env as any);

      const provider = new GcpProvider(
        gcpCred.gcpProjectId,
        tokenProvider,
        gcpCred.defaultZone,
      );
      return { provider, providerName, credentialSource: 'user' };
    }

    const config = buildProviderConfig(providerName, decryptedToken);
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
    // Use a synthetic user ID for platform credentials in token cache
    const tokenProvider = () => getGcpAccessToken(`platform:${userId}`, gcpCred.gcpProjectId, gcpCred, env as any);

    const provider = new GcpProvider(
      gcpCred.gcpProjectId,
      tokenProvider,
      gcpCred.defaultZone,
    );
    return { provider, providerName: platformProvider, credentialSource: 'platform' };
  }

  const config = buildProviderConfig(platformProvider, decryptedToken);
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
): Promise<{ credentialSource: CredentialSource; providerName: CredentialProvider } | null> {
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
