import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { ProviderConfig } from '@simple-agent-manager/providers';
import type { CredentialProvider } from '@simple-agent-manager/shared';
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
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

/**
 * Look up a user's cloud-provider credential, decrypt it, and return a ProviderConfig.
 * When `targetProvider` is specified, only returns credentials for that specific provider.
 * Returns null if no credential is found.
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
  const config = buildProviderConfig(provider, decryptedToken);

  return { config, provider };
}
