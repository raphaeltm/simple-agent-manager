import type { CredentialProvider } from '@simple-agent-manager/shared';
import { PROVIDER_LABELS } from '@simple-agent-manager/shared';

import { ulid } from '../../lib/ulid';

interface ComputeCredentialScope {
  userId: string;
  projectId?: string | null;
  provider: CredentialProvider;
}

interface SyncComputeCredentialInput extends ComputeCredentialScope {
  encryptedToken: string;
  iv: string;
  isActive?: boolean;
}

function providerLabel(provider: CredentialProvider): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

function scopeLabel(projectId?: string | null): string {
  return projectId ? 'project override' : 'default';
}

function deleteAttachmentsSql(projectId?: string | null): string {
  const projectPredicate = projectId ? 'project_id = ?' : 'project_id IS NULL';
  return `
    DELETE FROM cc_attachments
    WHERE user_id = ?
      AND consumer_kind = 'compute'
      AND consumer_target = ?
      AND ${projectPredicate}
  `;
}

/**
 * Make a legacy cloud-provider credential the active composable-credentials
 * source for a compute consumer. The legacy route remains the validation and
 * encryption boundary; compute resolution reads cc_* first.
 */
export async function syncComputeCredentialToCC(
  database: D1Database,
  input: SyncComputeCredentialInput
): Promise<{ credentialId: string; configurationId: string; attachmentId: string } | null> {
  if (input.isActive === false) return null;

  const credentialId = `cc-cred-${ulid()}`;
  const configurationId = `cc-cfg-${ulid()}`;
  const attachmentId = `cc-att-${ulid()}`;
  const now = new Date().toISOString();
  const label = providerLabel(input.provider);

  const deleteStmt = input.projectId
    ? database
        .prepare(deleteAttachmentsSql(input.projectId))
        .bind(input.userId, input.provider, input.projectId)
    : database.prepare(deleteAttachmentsSql()).bind(input.userId, input.provider);

  const credentialStmt = database
    .prepare(
      `INSERT INTO cc_credentials (
       id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at
     ) VALUES (?, ?, ?, 'cloud-provider', ?, ?, 1, ?, ?)`
    )
    .bind(
      credentialId,
      input.userId,
      `${label} cloud credential`,
      input.encryptedToken,
      input.iv,
      now,
      now
    );

  const configurationStmt = database
    .prepare(
      `INSERT INTO cc_configurations (
       id, owner_id, name, consumer_kind, consumer_target, credential_id,
       settings_json, is_active, created_at, updated_at
     ) VALUES (?, ?, ?, 'compute', ?, ?, NULL, 1, ?, ?)`
    )
    .bind(
      configurationId,
      input.userId,
      `${label} ${scopeLabel(input.projectId)}`,
      input.provider,
      credentialId,
      now,
      now
    );

  const attachmentStmt = database
    .prepare(
      `INSERT INTO cc_attachments (
       id, configuration_id, consumer_kind, consumer_target, user_id, project_id,
       is_active, created_at, updated_at
     ) VALUES (?, ?, 'compute', ?, ?, ?, 1, ?, ?)`
    )
    .bind(
      attachmentId,
      configurationId,
      input.provider,
      input.userId,
      input.projectId ?? null,
      now,
      now
    );

  await database.batch([deleteStmt, credentialStmt, configurationStmt, attachmentStmt]);
  return { credentialId, configurationId, attachmentId };
}

/**
 * Remove resolver attachments for a compute consumer/scope. Project rows are
 * deleted, not deactivated, so removing an override falls back to user/platform.
 */
export async function disconnectComputeCredentialFromCC(
  database: D1Database,
  input: ComputeCredentialScope
): Promise<void> {
  const stmt = input.projectId
    ? database
        .prepare(deleteAttachmentsSql(input.projectId))
        .bind(input.userId, input.provider, input.projectId)
    : database.prepare(deleteAttachmentsSql()).bind(input.userId, input.provider);
  await stmt.run();
}
