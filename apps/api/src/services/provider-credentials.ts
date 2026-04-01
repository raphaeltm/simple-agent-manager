import type { Provider, ProviderConfig } from '@simple-agent-manager/providers';
import { createProvider, GcpProvider } from '@simple-agent-manager/providers';
import type { CredentialProvider, GcpOidcCredential } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { decrypt } from './encryption';

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
 * For GCP, injects the STS token exchange as the token provider.
 */
export async function createProviderForUser(
  db: ReturnType<typeof drizzle>,
  userId: string,
  encryptionKey: string,
  env: { KV: KVNamespace; BASE_DOMAIN: string; JWT_PRIVATE_KEY: string; JWT_PUBLIC_KEY: string; GCP_IDENTITY_TOKEN_EXPIRY_SECONDS?: string; GCP_TOKEN_CACHE_TTL_SECONDS?: string; GCP_API_TIMEOUT_MS?: string; GCP_OPERATION_POLL_TIMEOUT_MS?: string },
  targetProvider?: CredentialProvider,
): Promise<{ provider: Provider; providerName: CredentialProvider } | null> {
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

  const providerName = cred.provider as CredentialProvider;
  const decryptedToken = await decrypt(cred.encryptedToken, cred.iv, encryptionKey);

  if (providerName === 'gcp') {
    const gcpCred = parseGcpCredential(decryptedToken);
    // Lazy-import to avoid circular dependency
    const { getGcpAccessToken } = await import('./gcp-sts');
    const tokenProvider = () => getGcpAccessToken(userId, gcpCred.gcpProjectId, gcpCred, env as any);

    const provider = new GcpProvider(
      gcpCred.gcpProjectId,
      tokenProvider,
      gcpCred.defaultZone,
    );
    return { provider, providerName };
  }

  const config = buildProviderConfig(providerName, decryptedToken);
  return { provider: createProvider(config), providerName };
}
