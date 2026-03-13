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
      return fields.token ?? fields.apiToken ?? '';
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
      const parsed = JSON.parse(decryptedToken) as { secretKey: string; projectId: string };
      return { provider: 'scaleway', secretKey: parsed.secretKey, projectId: parsed.projectId };
    }
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

/**
 * Look up a user's cloud-provider credential, decrypt it, and return a ProviderConfig.
 * Returns null if no credential is found.
 */
export async function getUserCloudProviderConfig(
  db: ReturnType<typeof drizzle>,
  userId: string,
  encryptionKey: string,
): Promise<{ config: ProviderConfig; provider: CredentialProvider } | null> {
  const creds = await db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.credentialType, 'cloud-provider'),
      ),
    )
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
