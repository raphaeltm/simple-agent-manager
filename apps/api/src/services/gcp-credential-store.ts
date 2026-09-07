import type { GcpCredential } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { ulid } from '../lib/ulid';
import { encrypt } from './encryption';
import { serializeGcpCredential } from './provider-credentials';

export interface StoredGcpCredentialResult {
  id: string;
  createdAt: string;
}

/**
 * Build the set-based cleanup for GCP credentials managed by this compatibility
 * store. Keeping the selection inside the batch is important: two replacements
 * may both begin before either batch runs, so a pre-batch snapshot can miss the
 * credential inserted by the competing request.
 */
function cleanupManagedCredentialStatements(
  env: Env,
  userId: string,
): D1PreparedStatement[] {
  return [
    env.DATABASE.prepare(
      `DELETE FROM cc_attachments
       WHERE user_id = ?
         AND project_id IS NULL
         AND consumer_kind = 'compute'
         AND consumer_target = 'gcp'
         AND configuration_id IN (
           SELECT id
           FROM cc_configurations
           WHERE owner_id = ?
             AND consumer_kind = 'compute'
             AND consumer_target = 'gcp'
             AND json_extract(settings_json, '$.managedBy') = 'legacy-gcp-credential'
         )`,
    ).bind(userId, userId),
    env.DATABASE.prepare(
      `DELETE FROM cc_credentials
       WHERE owner_id = ?
         AND id IN (
           SELECT configuration.credential_id
           FROM cc_configurations configuration
           WHERE configuration.owner_id = ?
             AND configuration.consumer_kind = 'compute'
             AND configuration.consumer_target = 'gcp'
             AND json_extract(configuration.settings_json, '$.managedBy') = 'legacy-gcp-credential'
             AND NOT EXISTS (
               SELECT 1 FROM cc_attachments attachment
               WHERE attachment.configuration_id = configuration.id
             )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM cc_configurations other_configuration
           WHERE other_configuration.credential_id = cc_credentials.id
             AND (
               other_configuration.owner_id != ?
               OR other_configuration.consumer_kind != 'compute'
               OR other_configuration.consumer_target != 'gcp'
               OR json_extract(other_configuration.settings_json, '$.managedBy') IS NOT 'legacy-gcp-credential'
               OR EXISTS (
                 SELECT 1 FROM cc_attachments other_attachment
                 WHERE other_attachment.configuration_id = other_configuration.id
               )
             )
         )`,
    ).bind(userId, userId, userId),
    env.DATABASE.prepare(
      `DELETE FROM cc_configurations
       WHERE owner_id = ?
         AND consumer_kind = 'compute'
         AND consumer_target = 'gcp'
         AND json_extract(settings_json, '$.managedBy') = 'legacy-gcp-credential'
         AND NOT EXISTS (
           SELECT 1 FROM cc_attachments
           WHERE configuration_id = cc_configurations.id
         )`,
    ).bind(userId),
  ];
}

/** Atomically replace the user-level GCP credential across legacy and CC stores. */
export async function replaceUserGcpCredential(
  env: Env,
  userId: string,
  credential: GcpCredential,
): Promise<StoredGcpCredentialResult> {
  if (typeof env.DATABASE.batch !== 'function') {
    throw new Error('Atomic credential replacement is unavailable');
  }
  const now = new Date().toISOString();
  const legacyId = ulid();
  const ccCredentialId = `cc-cred-${ulid()}`;
  const ccConfigurationId = `cc-cfg-${ulid()}`;
  const ccAttachmentId = `cc-att-${ulid()}`;
  const encrypted = await encrypt(
    serializeGcpCredential(credential),
    getCredentialEncryptionKey(env),
  );

  const statements: D1PreparedStatement[] = [
    env.DATABASE.prepare(
      `DELETE FROM credentials
       WHERE user_id = ?
         AND project_id IS NULL
         AND provider = 'gcp'
         AND credential_type = 'cloud-provider'`,
    ).bind(userId),
    ...cleanupManagedCredentialStatements(env, userId),
    env.DATABASE.prepare(
      `INSERT INTO credentials (
         id, user_id, project_id, provider, credential_type, agent_type,
         credential_kind, is_active, encrypted_token, iv, created_at, updated_at
       ) VALUES (?, ?, NULL, 'gcp', 'cloud-provider', NULL, 'api-key', 1, ?, ?, ?, ?)`,
    ).bind(legacyId, userId, encrypted.ciphertext, encrypted.iv, now, now),
    env.DATABASE.prepare(
      `INSERT INTO cc_credentials (
         id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at
       ) VALUES (?, ?, 'GCP cloud credential', 'cloud-provider', ?, ?, 1, ?, ?)`,
    ).bind(ccCredentialId, userId, encrypted.ciphertext, encrypted.iv, now, now),
    env.DATABASE.prepare(
      `INSERT INTO cc_configurations (
         id, owner_id, name, consumer_kind, consumer_target, credential_id,
         settings_json, is_active, created_at, updated_at
       ) VALUES (?, ?, 'GCP default', 'compute', 'gcp', ?, ?, 1, ?, ?)`,
    ).bind(
      ccConfigurationId,
      userId,
      ccCredentialId,
      JSON.stringify({ managedBy: 'legacy-gcp-credential' }),
      now,
      now,
    ),
    env.DATABASE.prepare(
      `INSERT INTO cc_attachments (
         id, configuration_id, consumer_kind, consumer_target, user_id, project_id,
         is_active, created_at, updated_at
       ) VALUES (?, ?, 'compute', 'gcp', ?, NULL, 1, ?, ?)`,
    ).bind(ccAttachmentId, ccConfigurationId, userId, now, now),
  ];

  await env.DATABASE.batch(statements);
  return { id: legacyId, createdAt: now };
}

/** Atomically remove user-level GCP credential copies from both stores. */
export async function deleteUserGcpCredential(env: Env, userId: string): Promise<void> {
  if (typeof env.DATABASE.batch !== 'function') {
    throw new Error('Atomic credential removal is unavailable');
  }
  const statements: D1PreparedStatement[] = [
    env.DATABASE.prepare(
      `DELETE FROM credentials
       WHERE user_id = ?
         AND project_id IS NULL
         AND provider = 'gcp'
         AND credential_type = 'cloud-provider'`,
    ).bind(userId),
    ...cleanupManagedCredentialStatements(env, userId),
  ];
  await env.DATABASE.batch(statements);
}
