/**
 * Shared agent-credential persistence.
 *
 * Encapsulates the exact save sequence that was previously duplicated inline in
 * `PUT /api/credentials/agent` and `PUT /api/projects/:id/credentials`:
 *   1. encrypt the plaintext credential (AES-256-GCM),
 *   2. upsert the legacy `credentials` row (scope-aware, atomic deactivate+upsert
 *      batch when auto-activating),
 *   3. dual-write the composable-credentials representation via
 *      `syncAgentCredentialToCC` (rule 44 — every writer must keep cc_* in sync).
 *
 * Both existing routes AND the guided setup-terminal capture path call this, so
 * there is a single writer of the two credential representations.
 *
 * Callers are responsible for their own format/provider validation and for
 * authorizing the (userId, projectId) scope before calling. The helper performs
 * a defensive format check but does not do provider-network validation.
 */
import type { AgentType, CredentialKind } from '@simple-agent-manager/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';
import { syncAgentCredentialToCC } from './composable-credentials/agent-sync';
import { encrypt } from './encryption';
import { CredentialValidator } from './validation';

export interface SaveAgentCredentialParams {
  env: Env;
  userId: string;
  /** null / undefined = user scope; a project id = project-scoped override. */
  projectId?: string | null;
  agentType: AgentType;
  credentialKind: CredentialKind;
  /** Plaintext credential (e.g. full auth.json contents for openai-codex). */
  credential: string;
  /** Agent catalog metadata. */
  provider: string;
  agentName: string;
  /** When true, deactivates same-scope siblings and activates this row. */
  autoActivate: boolean;
}

export interface SaveAgentCredentialResult {
  created: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Persist an agent credential for a user (optionally project-scoped), keeping the
 * legacy `credentials` table and the composable-credentials `cc_*` tables in sync.
 */
export async function saveAgentCredentialForUser(
  params: SaveAgentCredentialParams
): Promise<SaveAgentCredentialResult> {
  const { env, userId, agentType, credentialKind, credential, provider, agentName } = params;
  const projectId = params.projectId ?? null;
  const autoActivate = params.autoActivate;

  // Defensive format validation (callers should validate too, but this class of
  // code must never write an unparseable credential).
  const validation = CredentialValidator.validateCredential(credential, credentialKind, agentType);
  if (!validation.valid) {
    throw errors.badRequest(validation.error || 'Invalid credential format');
  }

  const db = drizzle(env.DATABASE, { schema });
  const { ciphertext, iv } = await encrypt(credential, getCredentialEncryptionKey(env));
  const now = new Date().toISOString();

  const existing = await db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        projectId === null
          ? isNull(schema.credentials.projectId)
          : eq(schema.credentials.projectId, projectId),
        eq(schema.credentials.credentialType, 'agent-api-key'),
        eq(schema.credentials.agentType, agentType),
        eq(schema.credentials.credentialKind, credentialKind)
      )
    )
    .limit(1);
  const existingCred = existing[0];

  const upsertStmt = existingCred
    ? env.DATABASE.prepare(
        `UPDATE credentials
         SET encrypted_token = ?, iv = ?, is_active = ?, updated_at = ?
         WHERE id = ?`
      ).bind(ciphertext, iv, autoActivate ? 1 : 0, now, existingCred.id)
    : env.DATABASE.prepare(
        `INSERT INTO credentials (
           id, user_id, project_id, provider, credential_type, agent_type,
           credential_kind, is_active, encrypted_token, iv, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'agent-api-key', ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        ulid(),
        userId,
        projectId,
        provider,
        agentType,
        credentialKind,
        autoActivate ? 1 : 0,
        ciphertext,
        iv,
        now,
        now
      );

  if (autoActivate) {
    // Atomic deactivate-siblings + upsert. Scope guard: user scope only touches
    // rows with project_id IS NULL; project scope only touches that project's rows.
    const deactivateStmt =
      projectId === null
        ? env.DATABASE.prepare(
            `UPDATE credentials SET is_active = 0
             WHERE user_id = ? AND project_id IS NULL
               AND credential_type = 'agent-api-key' AND agent_type = ?`
          ).bind(userId, agentType)
        : env.DATABASE.prepare(
            `UPDATE credentials SET is_active = 0
             WHERE user_id = ? AND project_id = ?
               AND credential_type = 'agent-api-key' AND agent_type = ?`
          ).bind(userId, projectId, agentType);
    await env.DATABASE.batch([deactivateStmt, upsertStmt]);
  } else {
    await upsertStmt.run();
  }

  // Dual-write the composable-credentials representation (rule 44). Note this
  // is skipped internally when isActive === false.
  await syncAgentCredentialToCC(env.DATABASE, {
    userId,
    projectId: projectId ?? undefined,
    agentType,
    credentialKind,
    encryptedToken: ciphertext,
    iv,
    agentName,
    isActive: autoActivate,
  });

  return {
    created: !existingCred,
    createdAt: existingCred?.createdAt ?? now,
    updatedAt: now,
  };
}
