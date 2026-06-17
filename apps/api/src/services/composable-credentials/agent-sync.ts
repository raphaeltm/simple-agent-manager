import {
  type CredentialKind,
  DEFAULT_OPENCODE_PROVIDER,
  DEFAULT_OPENCODE_ZEN_MODEL,
} from '@simple-agent-manager/shared';

import { ulid } from '../../lib/ulid';

interface AgentCredentialScope {
  userId: string;
  projectId?: string | null;
  agentType: string;
}

interface SyncAgentCredentialInput extends AgentCredentialScope {
  credentialKind: CredentialKind;
  encryptedToken: string;
  iv: string;
  agentName: string;
  isActive?: boolean;
}

function ccKindForAgentCredential(
  agentType: string,
  credentialKind: CredentialKind
): 'api-key' | 'oauth-token' | 'auth-json' {
  if (agentType === 'openai-codex' && credentialKind === 'oauth-token') {
    return 'auth-json';
  }
  return credentialKind;
}

function credentialLabel(
  agentName: string,
  agentType: string,
  credentialKind: CredentialKind
): string {
  if (agentType === 'openai-codex' && credentialKind === 'oauth-token') {
    return `${agentName} auth.json`;
  }
  return `${agentName} ${credentialKind === 'oauth-token' ? 'OAuth token' : 'API key'}`;
}

function scopeLabel(projectId?: string | null): string {
  return projectId ? 'project override' : 'default';
}

function configurationSettingsJson(agentType: string): string | null {
  if (agentType !== 'opencode') return null;
  return JSON.stringify({
    providerId: DEFAULT_OPENCODE_PROVIDER,
    model: DEFAULT_OPENCODE_ZEN_MODEL,
  });
}

function deleteAttachmentsSql(projectId?: string | null): string {
  const projectPredicate = projectId ? 'project_id = ?' : 'project_id IS NULL';
  return `
    DELETE FROM cc_attachments
    WHERE user_id = ?
      AND consumer_kind = 'agent'
      AND consumer_target = ?
      AND ${projectPredicate}
  `;
}

function deleteAttachmentsForKindSql(projectId?: string | null): string {
  const projectPredicate = projectId ? 'att.project_id = ?' : 'att.project_id IS NULL';
  return `
    DELETE FROM cc_attachments
    WHERE id IN (
      SELECT att.id
      FROM cc_attachments att
      JOIN cc_configurations cfg ON cfg.id = att.configuration_id
      LEFT JOIN cc_credentials cred ON cred.id = cfg.credential_id
      WHERE att.user_id = ?
        AND att.consumer_kind = 'agent'
        AND att.consumer_target = ?
        AND ${projectPredicate}
        AND cfg.owner_id = ?
        AND cfg.consumer_kind = 'agent'
        AND cfg.consumer_target = ?
        AND (
          cred.kind = ?
          OR (? = 'auth-json' AND cred.kind = 'oauth-token')
        )
    )
  `;
}

/**
 * Make a legacy agent credential the active composable-credentials source.
 *
 * The legacy Connections flow remains the validation/encryption boundary, but
 * resolution now reads cc_* first. This sync keeps both representations aligned
 * without mutating old migrated credential rows whose IDs may contain encrypted
 * legacy material.
 */
export async function syncAgentCredentialToCC(
  database: D1Database,
  input: SyncAgentCredentialInput
): Promise<{ credentialId: string; configurationId: string; attachmentId: string } | null> {
  if (input.isActive === false) return null;

  const credentialId = `cc-cred-${ulid()}`;
  const configurationId = `cc-cfg-${ulid()}`;
  const attachmentId = `cc-att-${ulid()}`;
  const kind = ccKindForAgentCredential(input.agentType, input.credentialKind);
  const now = new Date().toISOString();

  const deleteStmt = input.projectId
    ? database
        .prepare(deleteAttachmentsSql(input.projectId))
        .bind(input.userId, input.agentType, input.projectId)
    : database.prepare(deleteAttachmentsSql()).bind(input.userId, input.agentType);

  const credentialStmt = database
    .prepare(
      `INSERT INTO cc_credentials (
       id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .bind(
      credentialId,
      input.userId,
      credentialLabel(input.agentName, input.agentType, input.credentialKind),
      kind,
      input.encryptedToken,
      input.iv,
      now,
      now
    );

  const settingsJson = configurationSettingsJson(input.agentType);
  const configurationStmt = database
    .prepare(
      `INSERT INTO cc_configurations (
       id, owner_id, name, consumer_kind, consumer_target, credential_id,
       settings_json, is_active, created_at, updated_at
     ) VALUES (?, ?, ?, 'agent', ?, ?, ?, 1, ?, ?)`
    )
    .bind(
      configurationId,
      input.userId,
      `${input.agentName} ${scopeLabel(input.projectId)}`,
      input.agentType,
      credentialId,
      settingsJson,
      now,
      now
    );

  const attachmentStmt = database
    .prepare(
      `INSERT INTO cc_attachments (
       id, configuration_id, consumer_kind, consumer_target, user_id, project_id,
       is_active, created_at, updated_at
     ) VALUES (?, ?, 'agent', ?, ?, ?, 1, ?, ?)`
    )
    .bind(
      attachmentId,
      configurationId,
      input.agentType,
      input.userId,
      input.projectId ?? null,
      now,
      now
    );

  await database.batch([deleteStmt, credentialStmt, configurationStmt, attachmentStmt]);
  return { credentialId, configurationId, attachmentId };
}

/**
 * Remove resolver attachments for an agent/scope. When credentialKind is set,
 * only attachments backed by that kind are removed; otherwise all attachments
 * for the agent/scope are removed. Project rows are deleted, not deactivated,
 * so disconnecting an override falls back to the user/platform cascade.
 */
export async function disconnectAgentCredentialFromCC(
  database: D1Database,
  input: AgentCredentialScope & { credentialKind?: CredentialKind }
): Promise<void> {
  if (!input.credentialKind) {
    const stmt = input.projectId
      ? database
          .prepare(deleteAttachmentsSql(input.projectId))
          .bind(input.userId, input.agentType, input.projectId)
      : database.prepare(deleteAttachmentsSql()).bind(input.userId, input.agentType);
    await stmt.run();
    return;
  }

  const kind = ccKindForAgentCredential(input.agentType, input.credentialKind);
  const stmt = input.projectId
    ? database
        .prepare(deleteAttachmentsForKindSql(input.projectId))
        .bind(
          input.userId,
          input.agentType,
          input.projectId,
          input.userId,
          input.agentType,
          kind,
          kind
        )
    : database
        .prepare(deleteAttachmentsForKindSql())
        .bind(input.userId, input.agentType, input.userId, input.agentType, kind, kind);
  await stmt.run();
}

export async function syncActiveAgentCredentialSecret(
  database: D1Database,
  input: AgentCredentialScope & {
    credentialKind: CredentialKind;
    encryptedToken: string;
    iv: string;
  }
): Promise<number> {
  const kind = ccKindForAgentCredential(input.agentType, input.credentialKind);
  const projectPredicate = input.projectId ? 'att.project_id = ?' : 'att.project_id IS NULL';
  const now = new Date().toISOString();
  const sql = `
    UPDATE cc_credentials
    SET encrypted_token = ?, iv = ?, updated_at = ?
    WHERE id IN (
      SELECT cred.id
      FROM cc_credentials cred
      JOIN cc_configurations cfg ON cfg.credential_id = cred.id
      JOIN cc_attachments att ON att.configuration_id = cfg.id
      WHERE cred.owner_id = ?
        AND cred.is_active = 1
        AND cfg.owner_id = ?
        AND cfg.consumer_kind = 'agent'
        AND cfg.consumer_target = ?
        AND cfg.is_active = 1
        AND att.user_id = ?
        AND att.consumer_kind = 'agent'
        AND att.consumer_target = ?
        AND att.is_active = 1
        AND ${projectPredicate}
        AND (
          cred.kind = ?
          OR (? = 'auth-json' AND cred.kind = 'oauth-token')
        )
    )
  `;
  const stmt = input.projectId
    ? database
        .prepare(sql)
        .bind(
          input.encryptedToken,
          input.iv,
          now,
          input.userId,
          input.userId,
          input.agentType,
          input.userId,
          input.agentType,
          input.projectId,
          kind,
          kind
        )
    : database
        .prepare(sql)
        .bind(
          input.encryptedToken,
          input.iv,
          now,
          input.userId,
          input.userId,
          input.agentType,
          input.userId,
          input.agentType,
          kind,
          kind
        );
  const result = await stmt.run();
  return result.meta.changes ?? 0;
}

export { ccKindForAgentCredential };
