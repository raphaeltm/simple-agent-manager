import type { CredentialProvider } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { decrypt } from './encryption';

/**
 * Look up an enabled platform cloud-provider credential for the given provider.
 * Returns the decrypted token and provider name, or null if none found.
 */
export async function getPlatformCloudCredential(
  db: ReturnType<typeof drizzle>,
  encryptionKey: string,
  targetProvider?: CredentialProvider,
): Promise<{ decryptedToken: string; provider: CredentialProvider } | null> {
  const conditions = [
    eq(schema.platformCredentials.credentialType, 'cloud-provider'),
    eq(schema.platformCredentials.isEnabled, true),
  ];
  if (targetProvider) {
    conditions.push(eq(schema.platformCredentials.provider, targetProvider));
  }

  const rows = await db
    .select()
    .from(schema.platformCredentials)
    .where(and(...conditions))
    .limit(1);

  const row = rows[0];
  if (!row || !row.provider) {
    return null;
  }

  const decryptedToken = await decrypt(row.encryptedToken, row.iv, encryptionKey);
  return { decryptedToken, provider: row.provider as CredentialProvider };
}

/**
 * Look up an enabled platform agent-api-key credential for the given agent type.
 * Returns the decrypted credential and its kind, or null if none found.
 */
export async function getPlatformAgentCredential(
  db: ReturnType<typeof drizzle>,
  agentType: string,
  encryptionKey: string,
): Promise<{ credential: string; credentialKind: 'api-key' | 'oauth-token' } | null> {
  const rows = await db
    .select()
    .from(schema.platformCredentials)
    .where(
      and(
        eq(schema.platformCredentials.credentialType, 'agent-api-key'),
        eq(schema.platformCredentials.agentType, agentType),
        eq(schema.platformCredentials.isEnabled, true),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    return null;
  }

  const credential = await decrypt(row.encryptedToken, row.iv, encryptionKey);
  return {
    credential,
    credentialKind: row.credentialKind as 'api-key' | 'oauth-token',
  };
}
