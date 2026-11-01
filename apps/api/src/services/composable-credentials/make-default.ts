/**
 * Make one of the caller's existing agent accounts their default for that agent.
 *
 * "Default" is the user-scoped `cc_attachments` row the resolver falls back to for
 * every project without a pin (`resolveEnvironment`). Two stores must move
 * together, in one D1 batch:
 *
 * 1. cc_*: every user-scoped attachment for the agent is replaced by one pointing
 *    at the chosen configuration. Creating a second user-scoped attachment instead
 *    would leave two active defaults, and the resolver would take whichever it
 *    found first.
 * 2. Legacy `credentials`: Codex token refresh (`CodexRefreshLock`) and the
 *    workspace credential-sync callback still read the active user-scoped legacy
 *    row and mirror rotations into the active default's cc credential. If that row
 *    kept the old account, a workspace on the new default would be answered with
 *    the old account's tokens. So the chosen account's secret becomes the active
 *    legacy row, exactly as connecting it through the legacy save path would.
 *    When its secret is not a valid legacy credential (an OpenAI-compatible
 *    endpoint, a hand-made Advanced row), the agent's legacy rows are only
 *    deactivated: no legacy path may answer for the wrong account.
 *
 * Project pins are untouched, and the previous default stays connected (its cc
 * rows remain; it shows as pinned or unattached).
 */
import {
  type CredentialKind,
  getAgentDefinition,
  isValidAgentType,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { getCredentialEncryptionKey } from '../../lib/secrets';
import { ulid } from '../../lib/ulid';
import { errors } from '../../middleware/error';
import { getClaudeOauthTokenMaxLength } from '../credential-setup-config';
import { decrypt } from '../encryption';
import { CredentialValidator } from '../validation';

interface AccountRow {
  consumer_kind: string;
  consumer_target: string;
  config_active: number;
  credential_id: string | null;
  credential_kind: string | null;
  credential_active: number | null;
  encrypted_token: string | null;
  iv: string | null;
}

export interface MakeDefaultResult {
  attachmentId: string;
  agentType: string;
  /** The legacy credential kind now active for the agent, or null when none is. */
  legacyKind: CredentialKind | null;
}

/**
 * The legacy `credentials.credential_kind` a cc credential kind corresponds to.
 * Only Codex stores an auth.json in the legacy table (as `oauth-token`); revisit
 * this if another agent's legacy rows ever hold one.
 */
export function legacyKindFor(agentType: string, ccKind: string): CredentialKind | null {
  if (ccKind === 'api-key') return 'api-key';
  if (ccKind === 'oauth-token') return 'oauth-token';
  if (ccKind === 'auth-json' && agentType === 'openai-codex') return 'oauth-token';
  return null;
}

export async function makeAgentAccountDefault(
  env: Env,
  userId: string,
  configurationId: string
): Promise<MakeDefaultResult> {
  const database = env.DATABASE;
  // Both rows are bound to the caller in the predicate, so another user's
  // configuration or credential reads as not found.
  const row = await database
    .prepare(
      `SELECT cfg.consumer_kind, cfg.consumer_target, cfg.is_active AS config_active,
              cfg.credential_id, cred.kind AS credential_kind,
              cred.is_active AS credential_active, cred.encrypted_token, cred.iv
         FROM cc_configurations cfg
         LEFT JOIN cc_credentials cred
           ON cred.id = cfg.credential_id AND cred.owner_id = cfg.owner_id
        WHERE cfg.id = ? AND cfg.owner_id = ?`
    )
    .bind(configurationId, userId)
    .first<AccountRow>();
  if (!row) throw errors.badRequest('Configuration not found or not owned by user');
  if (row.consumer_kind !== 'agent') {
    throw errors.badRequest('Only agent accounts can be made the default here');
  }
  if (!row.credential_id || !row.credential_kind || !row.encrypted_token || !row.iv) {
    throw errors.badRequest('This configuration has no account of yours to make the default');
  }
  if (row.config_active !== 1 || row.credential_active !== 1) {
    throw errors.badRequest('This account is paused');
  }
  const agentType = row.consumer_target;
  if (!isValidAgentType(agentType)) throw errors.badRequest('Unknown agent');

  let legacyKind = legacyKindFor(agentType, row.credential_kind);
  if (legacyKind) {
    let plaintext: string;
    try {
      plaintext = await decrypt(row.encrypted_token, row.iv, getCredentialEncryptionKey(env));
    } catch (err) {
      // A stored secret that cannot be read is bad data, not a server fault (rule 41).
      log.error('cc_make_default.decrypt_failed', {
        userId,
        configurationId,
        message: err instanceof Error ? err.message : 'unknown',
      });
      throw errors.badRequest('This account can’t be read. Reconnect it, then try again.');
    }
    const validation = CredentialValidator.validateCredential(
      plaintext,
      legacyKind,
      agentType,
      getClaudeOauthTokenMaxLength(env)
    );
    if (!validation.valid) {
      log.warn('cc_make_default.legacy_mirror_skipped', {
        userId,
        configurationId,
        agentType,
        credentialKind: row.credential_kind,
        reason: validation.error ?? 'invalid legacy credential format',
      });
      legacyKind = null;
    }
  }

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `UPDATE credentials SET is_active = 0, updated_at = ?
          WHERE user_id = ? AND project_id IS NULL
            AND credential_type = 'agent-api-key' AND agent_type = ?`
      )
      .bind(now, userId, agentType),
  ];
  if (legacyKind) {
    // A double submit can race this read; the loser fails on the partial unique
    // index and changes nothing, so the user sees an error, not a wrong default.
    const existing = await database
      .prepare(
        `SELECT id FROM credentials
          WHERE user_id = ? AND project_id IS NULL AND credential_type = 'agent-api-key'
            AND agent_type = ? AND credential_kind = ?`
      )
      .bind(userId, agentType, legacyKind)
      .first<{ id: string }>();
    statements.push(
      existing
        ? database
            .prepare(
              `UPDATE credentials SET encrypted_token = ?, iv = ?, is_active = 1, updated_at = ?
                WHERE id = ? AND user_id = ?`
            )
            .bind(row.encrypted_token, row.iv, now, existing.id, userId)
        : database
            .prepare(
              `INSERT INTO credentials (
                 id, user_id, project_id, provider, credential_type, agent_type,
                 credential_kind, is_active, encrypted_token, iv, created_at, updated_at
               ) VALUES (?, ?, NULL, ?, 'agent-api-key', ?, ?, 1, ?, ?, ?, ?)`
            )
            .bind(
              ulid(),
              userId,
              getAgentDefinition(agentType)?.provider ?? agentType,
              agentType,
              legacyKind,
              row.encrypted_token,
              row.iv,
              now,
              now
            )
    );
  }

  const attachmentId = `cc-att-${ulid()}`;
  statements.push(
    database
      .prepare(
        `DELETE FROM cc_attachments
          WHERE user_id = ? AND consumer_kind = 'agent' AND consumer_target = ?
            AND project_id IS NULL`
      )
      .bind(userId, agentType),
    database
      .prepare(
        `INSERT INTO cc_attachments (
           id, configuration_id, consumer_kind, consumer_target, user_id, project_id,
           is_active, created_at, updated_at
         ) VALUES (?, ?, 'agent', ?, ?, NULL, 1, ?, ?)`
      )
      .bind(attachmentId, configurationId, agentType, userId, now, now)
  );
  // One batch is one transaction: there is never a moment with two defaults, or
  // with the cc default and the legacy row naming different accounts.
  await database.batch(statements);

  return { attachmentId, agentType, legacyKind };
}
