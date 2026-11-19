/** Bounded, rotating inventory coverage for active user/project cloud accounts. */
import type { CredentialProvider } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { fingerprintEncryptedProviderCredential } from '../services/provider-credential-exact';
import { createProviderForUser } from '../services/provider-credentials';
import { resolveCleanupConfig } from './node-cleanup/config';

const CURSOR_KEY = 'cleanup:provider-orphan-reconciliation:credential-cursor';
export interface InventoryCredential {
  id: string;
  userId: string;
  projectId: string | null;
  provider: string;
  encryptedToken: string;
  iv: string;
  updatedAt: string;
}
export async function listInventoryCredentials(env: Env): Promise<InventoryCredential[]> {
  const cursor = (await env.KV.get(CURSOR_KEY)) ?? '';
  const rows = await env.DATABASE.prepare(
    `SELECT id, user_id AS userId, project_id AS projectId, provider,
            encrypted_token AS encryptedToken, iv, updated_at AS updatedAt
     FROM credentials WHERE credential_type = 'cloud-provider' AND is_active = 1 AND id > ?
     ORDER BY id LIMIT ?`
  )
    .bind(cursor, resolveCleanupConfig(env).nodeSweepLimit)
    .all<InventoryCredential>();
  if (!rows.success || !Array.isArray(rows.results))
    throw new Error('Credential inventory unavailable');
  // A cursor advances only over returned accounts. The caller commits it after
  // attempting each account, so a wall-time cutoff cannot starve the next page.
  if (!rows.results.length) await env.KV.put(CURSOR_KEY, '');
  return rows.results;
}
export async function markInventoryCredentialAttempted(
  env: Env,
  credential: InventoryCredential
): Promise<void> {
  await env.KV.put(CURSOR_KEY, credential.id);
}
export async function resolveInventoryProvider(env: Env, credential: InventoryCredential) {
  return createProviderForUser(
    drizzle(env.DATABASE),
    credential.userId,
    getCredentialEncryptionKey(env),
    env,
    credential.provider as CredentialProvider,
    credential.projectId,
    {
      credentialSource: credential.projectId ? 'project' : 'user',
      credentialReference: `credentials:${credential.id}`,
      credentialVersion: Date.parse(credential.updatedAt),
      credentialFingerprint: await fingerprintEncryptedProviderCredential(
        credential.encryptedToken,
        credential.iv
      ),
    }
  );
}
