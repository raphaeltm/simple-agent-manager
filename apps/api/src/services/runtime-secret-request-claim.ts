import type { RuntimeSecretRequestRow } from '../db/schema';
import { ulid } from '../lib/ulid';

/** The exact existing row a confirmed replace may overwrite, as read before the write. */
export interface ReplaceTarget {
  updatedAt: string;
  valueIv: string | null;
  storedValue: string;
}

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
  input: { actorUserId: string; replaceTarget: ReplaceTarget | null },
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
            -- A value is replaced only with the person's confirmation, and only the exact row the
            -- server read (and the person confirmed): one created or changed since is left alone,
            -- nothing is written, and the card asks again.
            AND (NOT EXISTS (
                   SELECT 1 FROM project_runtime_env_vars WHERE project_id = ? AND env_key = ?)
                 OR EXISTS (
                   SELECT 1 FROM project_runtime_env_vars
                    WHERE ? = 1 AND project_id = ? AND env_key = ?
                      AND updated_at = ? AND value_iv IS ? AND stored_value = ?))
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
        row.projectId,
        row.envKey,
        input.replaceTarget ? 1 : 0,
        row.projectId,
        row.envKey,
        input.replaceTarget?.updatedAt ?? null,
        input.replaceTarget?.valueIv ?? null,
        input.replaceTarget?.storedValue ?? null
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

/** Runs `claimAndStoreValueStatements` as one batch; true when this attempt claimed. */
export async function claimAndStoreValue(
  database: D1Database,
  row: RuntimeSecretRequestRow,
  replaceTarget: ReplaceTarget | null,
  stored: { ciphertext: string; iv: string | null },
  resolution: { resolvedAt: number; secretExpiresAt: number | null; replacedExisting: boolean },
  actorUserId: string
): Promise<boolean> {
  const [, claim] = await database.batch(
    claimAndStoreValueStatements(database, row, { actorUserId, replaceTarget }, stored, resolution)
  );
  return (claim?.meta?.changes ?? 0) === 1;
}

/**
 * Inserts a new pending request only if, at the moment of the write, this chat has no open
 * request for the same name and fewer than `maxPending` open requests. Two overlapping
 * `request_secret` calls therefore cannot create two cards for one name or exceed the cap:
 * whichever lands second changes nothing, and the caller re-reads to return the open request
 * or refuse. Returns the number of rows written (0 or 1).
 */
export async function insertPendingRuntimeSecretRequest(
  database: D1Database,
  row: RuntimeSecretRequestRow,
  maxPending: number
): Promise<number> {
  const result = await database
    .prepare(
      `INSERT INTO runtime_secret_requests
         (id, project_id, env_key, reason, ttl_seconds, status, requester_user_id,
          requesting_task_id, requesting_authority_task_id, requesting_chat_session_id,
          requesting_agent_session_id, requesting_workspace_id, expires_at, replaced_existing,
          created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM runtime_secret_requests
           WHERE requesting_chat_session_id = ? AND project_id = ? AND env_key = ?
             AND status = 'pending' AND expires_at > ?)
          AND (SELECT COUNT(*) FROM runtime_secret_requests
                WHERE requesting_chat_session_id = ? AND status = 'pending' AND expires_at > ?) < ?`
    )
    .bind(
      row.id,
      row.projectId,
      row.envKey,
      row.reason,
      row.ttlSeconds,
      row.requesterUserId,
      row.requestingTaskId,
      row.requestingAuthorityTaskId,
      row.requestingChatSessionId,
      row.requestingAgentSessionId,
      row.requestingWorkspaceId,
      row.expiresAt,
      row.createdAt,
      row.updatedAt,
      row.requestingChatSessionId,
      row.projectId,
      row.envKey,
      row.createdAt,
      row.requestingChatSessionId,
      row.createdAt,
      maxPending
    )
    .run();
  return result.meta?.changes ?? 0;
}
