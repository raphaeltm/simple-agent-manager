import type { RuntimeSecretRequestRow } from '../db/schema';
import { ulid } from '../lib/ulid';

/**
 * Writes the value and claims the request in ONE D1 batch (a transaction), so there is no state
 * where the request reads `fulfilled` without its value, or a value is written for a request
 * someone else answered.
 *
 * Ownership is batch-local, never inferred from who or when: the value is written only while the
 * request is still pending, and the claim lands only if THIS batch's ciphertext is the stored
 * value (its random IV makes every attempt's ciphertext unique). Two overlapping submits by the
 * same person in the same millisecond therefore cannot overwrite each other: batches run one at a
 * time, the first claims, and the second finds the request no longer pending and writes nothing.
 * Exported for the real-D1 contract test (`tests/workers/runtime-secret-request-claim.test.ts`).
 */
export function claimAndStoreValueStatements(
  database: D1Database,
  row: Pick<RuntimeSecretRequestRow, 'id' | 'projectId' | 'envKey'>,
  input: { actorUserId: string; replaceExisting: boolean },
  stored: { ciphertext: string; iv: string | null },
  resolution: { resolvedAt: number; secretExpiresAt: number | null; replacedExisting: boolean },
  valueRowId: string = ulid()
): [D1PreparedStatement, D1PreparedStatement] {
  const { resolvedAt, secretExpiresAt, replacedExisting } = resolution;
  const nowIso = new Date(resolvedAt).toISOString();
  return [
    database
      .prepare(
        `INSERT INTO project_runtime_env_vars
           (id, project_id, user_id, env_key, stored_value, value_iv, is_secret, expires_at,
            secret_request_id, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM runtime_secret_requests
             WHERE id = ? AND project_id = ? AND status = 'pending' AND expires_at > ?)
            -- Without the person's confirmation, a value created since the card was read must
            -- not be replaced silently: nothing is written and the card asks again.
            AND (? = 1 OR NOT EXISTS (
              SELECT 1 FROM project_runtime_env_vars WHERE project_id = ? AND env_key = ?))
         ON CONFLICT (project_id, env_key) DO UPDATE SET
           stored_value = excluded.stored_value, value_iv = excluded.value_iv, is_secret = 1,
           expires_at = excluded.expires_at, secret_request_id = excluded.secret_request_id,
           updated_at = excluded.updated_at`
      )
      .bind(
        valueRowId,
        row.projectId,
        input.actorUserId,
        row.envKey,
        stored.ciphertext,
        stored.iv,
        secretExpiresAt,
        row.id,
        nowIso,
        nowIso,
        row.id,
        row.projectId,
        resolvedAt,
        input.replaceExisting ? 1 : 0,
        row.projectId,
        row.envKey
      ),
    database
      .prepare(
        `UPDATE runtime_secret_requests
            SET status = 'fulfilled', resolved_by = ?, resolved_at = ?, secret_expires_at = ?,
                replaced_existing = ?, updated_at = ?
          WHERE id = ? AND project_id = ? AND status = 'pending' AND expires_at > ?
            AND EXISTS (
              SELECT 1 FROM project_runtime_env_vars
               WHERE project_id = ? AND env_key = ? AND secret_request_id = ?
                 AND stored_value = ? AND value_iv IS ?)`
      )
      .bind(
        input.actorUserId,
        resolvedAt,
        secretExpiresAt,
        replacedExisting ? 1 : 0,
        resolvedAt,
        row.id,
        row.projectId,
        resolvedAt,
        row.projectId,
        row.envKey,
        row.id,
        stored.ciphertext,
        stored.iv
      ),
  ];
}
