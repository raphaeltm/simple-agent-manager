import type { GcpCredential } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { ulid } from '../lib/ulid';
import { encrypt } from './encryption';
import { serializeGcpCredential } from './provider-credentials';

interface AttachedCredentialRow {
  configurationId: string;
  credentialId: string | null;
}

export interface StoredGcpCredentialResult {
  id: string;
  createdAt: string;
}

async function findAttachedGcpCredentials(
  env: Env,
  userId: string,
): Promise<AttachedCredentialRow[]> {
  const rows = await env.DATABASE.prepare(
    `SELECT a.configuration_id AS configurationId, c.credential_id AS credentialId
     FROM cc_attachments a
     JOIN cc_configurations c ON c.id = a.configuration_id
     WHERE a.user_id = ?
       AND a.project_id IS NULL
       AND a.consumer_kind = 'compute'
       AND a.consumer_target = 'gcp'`,
  ).bind(userId).all<AttachedCredentialRow>();
  return rows.results ?? [];
}

function cleanupAttachedCredentialStatements(
  env: Env,
  userId: string,
  rows: AttachedCredentialRow[],
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    env.DATABASE.prepare(
      `DELETE FROM cc_attachments
       WHERE user_id = ?
         AND project_id IS NULL
         AND consumer_kind = 'compute'
         AND consumer_target = 'gcp'`,
    ).bind(userId),
  ];

  for (const row of rows) {
    statements.push(
      env.DATABASE.prepare(
        `DELETE FROM cc_configurations
         WHERE id = ?
           AND owner_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM cc_attachments WHERE configuration_id = ?
           )`,
      ).bind(row.configurationId, userId, row.configurationId),
    );
    if (row.credentialId) {
      statements.push(
        env.DATABASE.prepare(
          `DELETE FROM cc_credentials
           WHERE id = ?
             AND owner_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM cc_configurations WHERE credential_id = ?
             )`,
        ).bind(row.credentialId, userId, row.credentialId),
      );
    }
  }
  return statements;
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
  const oldRows = await findAttachedGcpCredentials(env, userId);
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
    ...cleanupAttachedCredentialStatements(env, userId, oldRows),
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
  const oldRows = await findAttachedGcpCredentials(env, userId);
  const statements: D1PreparedStatement[] = [
    env.DATABASE.prepare(
      `DELETE FROM credentials
       WHERE user_id = ?
         AND project_id IS NULL
         AND provider = 'gcp'
         AND credential_type = 'cloud-provider'`,
    ).bind(userId),
    ...cleanupAttachedCredentialStatements(env, userId, oldRows),
  ];
  await env.DATABASE.batch(statements);
}
