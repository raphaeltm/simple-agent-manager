/**
 * Durable preservation receipt for one retired workspace runtime generation.
 *
 * `session_snapshots` holds one row per conversation. When a conversation wakes on a
 * replacement workspace, the replacement's first capture rewrites that row's
 * `workspace_id`/`cleanup_identity_json` and its completion deletes the previous
 * generation's R2 objects. From then on the row can no longer say that the *source*
 * workspace's files were preserved, so the source could never be deleted automatically.
 *
 * The receipt is copied onto the source workspace row in the same D1 batch that grants
 * preservation (a verified full sleep, or a quiesced final eviction capture). Deletion
 * authority then reads the receipt: the identity must still match, and that exact generation
 * must have been restored into a replacement workspace whose wake committed. The restore is
 * stamped in the same D1 batch as that commit (`transitionToInProgress`), so a wake that fails
 * after restoring never releases its source. Until then the snapshot row, which still names
 * the source and carries its lifecycle state, decides. Receipts never grant preservation on
 * their own; only the two writers above create them.
 */
import * as v from 'valibot';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { getSessionSnapshotConfig } from './session-snapshot-artifacts';
import type { WorkspaceDeletionIdentity } from './workspace-deletion';

export type PreservationReceiptReason = 'sleep' | 'quiesced_eviction';

const ReceiptSchema = v.object({
  version: v.literal(1),
  reason: v.picklist(['sleep', 'quiesced_eviction']),
  preservedAt: v.string(),
  chatSessionId: v.string(),
  projectId: v.nullable(v.string()),
  snapshotGeneration: v.string(),
  workspaceId: v.string(),
  nodeId: v.string(),
  userId: v.string(),
  nodeRuntimeIncarnationId: v.string(),
  workspaceGeneration: v.string(),
  homeR2Key: v.string(),
  homeSha256: v.string(),
  homeBytes: v.number(),
  wipR2Key: v.nullable(v.string()),
  wipSha256: v.nullable(v.string()),
  wipBytes: v.nullable(v.number()),
  manifestR2Key: v.string(),
  expiresAt: v.string(),
  restoredAt: v.optional(v.nullable(v.string())),
  restoredWorkspaceId: v.optional(v.nullable(v.string())),
});

export type WorkspacePreservationReceipt = v.InferOutput<typeof ReceiptSchema>;

/**
 * The snapshot row's preserved, complete generation still names exactly this workspace
 * runtime. Shared by the receipt writer's SET and WHERE so they cannot disagree.
 */
const PRESERVED_SOURCE_SNAPSHOT_SQL = `s.chat_session_id = ?
  AND s.workspace_id = workspaces.id AND s.node_id = workspaces.node_id
  AND s.user_id = workspaces.user_id AND s.project_id IS workspaces.project_id
  AND s.status = 'available' AND s.degradation = 'none'
  AND s.capture_generation IS NULL AND s.snapshot_generation IS NOT NULL
  AND s.home_r2_key IS NOT NULL AND s.home_sha256 IS NOT NULL AND s.manifest_r2_key IS NOT NULL
  AND json_valid(s.cleanup_identity_json)
  AND json_extract(s.cleanup_identity_json, '$.preserved') = 1
  AND json_extract(s.cleanup_identity_json, '$.snapshotGeneration') = s.snapshot_generation
  AND json_extract(s.cleanup_identity_json, '$.workspaceId') = workspaces.id
  AND json_extract(s.cleanup_identity_json, '$.nodeId') = workspaces.node_id
  AND json_extract(s.cleanup_identity_json, '$.userId') = workspaces.user_id
  AND json_extract(s.cleanup_identity_json, '$.workspaceGeneration') = COALESCE(workspaces.eviction_generation, '')
  AND (workspaces.preservation_receipt_json IS NULL OR NOT json_valid(workspaces.preservation_receipt_json)
    OR json_extract(workspaces.preservation_receipt_json, '$.snapshotGeneration') IS NOT s.snapshot_generation)`;

/**
 * Copy the conversation's preserved generation onto the workspace its snapshot row names.
 * Add it to the same batch as (and after) the statement that grants `preserved = 1`; it is
 * a no-op when the grant did not apply, so it cannot invent preservation. It is also a
 * no-op when the workspace already holds a receipt for this generation, which keeps a
 * recorded restore (`restoredAt`) and makes every writer idempotent.
 */
export function preservationReceiptStatement(
  database: D1Database,
  input: {
    chatSessionId: string;
    reason: PreservationReceiptReason;
    nowIso: string;
  }
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE workspaces SET preservation_receipt_json = (
         SELECT json_object(
           'version', 1, 'reason', ?, 'preservedAt', ?,
           'chatSessionId', s.chat_session_id, 'projectId', s.project_id,
           'snapshotGeneration', s.snapshot_generation,
           'workspaceId', workspaces.id, 'nodeId', workspaces.node_id, 'userId', workspaces.user_id,
           'nodeRuntimeIncarnationId', json_extract(s.cleanup_identity_json, '$.nodeRuntimeIncarnationId'),
           'workspaceGeneration', COALESCE(workspaces.eviction_generation, ''),
           'homeR2Key', s.home_r2_key, 'homeSha256', s.home_sha256,
           'homeBytes', json_extract(s.manifest_json, '$.artifacts.home.sizeBytes'),
           'wipR2Key', s.wip_r2_key, 'wipSha256', s.wip_sha256,
           'wipBytes', json_extract(s.manifest_json, '$.artifacts.wip.sizeBytes'),
           'manifestR2Key', s.manifest_r2_key, 'expiresAt', s.expires_at)
         FROM session_snapshots s WHERE ${PRESERVED_SOURCE_SNAPSHOT_SQL})
       WHERE id = (SELECT workspace_id FROM session_snapshots WHERE chat_session_id = ?)
         AND EXISTS (SELECT 1 FROM session_snapshots s WHERE ${PRESERVED_SOURCE_SNAPSHOT_SQL})`
    )
    .bind(
      input.reason,
      input.nowIso,
      input.chatSessionId,
      input.chatSessionId,
      input.chatSessionId
    );
}

export function parsePreservationReceipt(
  json: string | null | undefined
): WorkspacePreservationReceipt | null {
  if (!json) return null;
  try {
    const parsed = v.safeParse(ReceiptSchema, JSON.parse(json));
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

/**
 * Deletion authority from the receipt, or null. Mirrors the immutable identity checks of
 * `automaticDeletionPreservationExpiresAt` (workspace, node, incarnation, user, project,
 * runtime generation). The chat binding is deliberately not compared: a wake releases it,
 * and the receipt names the conversation itself.
 */
export async function preservationReceiptExpiresAt(
  env: Env,
  expected: WorkspaceDeletionIdentity
): Promise<string | null> {
  const row = await env.DATABASE.prepare(
    'SELECT preservation_receipt_json AS receipt FROM workspaces WHERE id = ?'
  )
    .bind(expected.workspaceId)
    .first<{ receipt: string | null }>();
  const receipt = parsePreservationReceipt(row?.receipt);
  if (
    !receipt ||
    receipt.workspaceId !== expected.workspaceId ||
    receipt.nodeId !== expected.nodeId ||
    receipt.userId !== expected.userId ||
    receipt.projectId !== expected.projectId ||
    receipt.nodeRuntimeIncarnationId !== expected.nodeRuntimeIncarnationId ||
    receipt.workspaceGeneration !== (expected.workspaceGeneration ?? '')
  ) {
    return null;
  }
  // Only a committed restore of this exact generation releases the source: the conversation
  // now lives in a replacement workspace, whose later captures may already have replaced these
  // artifacts. Before that, the snapshot row still names this workspace and decides
  // (`automaticDeletionPreservationExpiresAt`), including whether a wake still needs it.
  if (!receipt.restoredAt) return null;
  const restoredHorizon = new Date(
    Date.now() + getSessionSnapshotConfig(env).ttlDays * 24 * 60 * 60 * 1000
  ).toISOString();
  return Date.parse(receipt.expiresAt) > Date.now() ? receipt.expiresAt : restoredHorizon;
}

export interface RestoredSourceReceiptStamp {
  chatSessionId: string;
  restoredWorkspaceId: string;
  /**
   * The generation the restore committed (`completeSessionSnapshotRecoveryGeneration`). A
   * successor capture replaces the row's live generation, so the live row is consulted only
   * for a runner that predates this value.
   */
  snapshotGeneration: string | null | undefined;
}

/**
 * Stamp the restore on the source receipt of exactly the restored generation. Idempotent per
 * restored workspace: a repeat keeps the first `restoredAt`. `commit` makes the stamp apply
 * only when the wake's own commit (`transitionToInProgress`, same D1 batch) took effect.
 */
export function restoredSourceReceiptStampStatement(
  database: D1Database,
  input: RestoredSourceReceiptStamp,
  nowIso: string,
  commit?: { taskId: string; startedAt: string }
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE workspaces
          SET preservation_receipt_json = json_set(preservation_receipt_json,
                '$.restoredAt', COALESCE(json_extract(preservation_receipt_json, '$.restoredAt'), ?),
                '$.restoredWorkspaceId', ?)
        WHERE id != ?
          AND json_valid(preservation_receipt_json)
          AND json_extract(preservation_receipt_json, '$.chatSessionId') = ?
          AND (json_extract(preservation_receipt_json, '$.restoredAt') IS NULL
            OR json_extract(preservation_receipt_json, '$.restoredWorkspaceId') = ?)
          AND json_extract(preservation_receipt_json, '$.snapshotGeneration') = COALESCE(?, (
            SELECT snapshot_generation FROM session_snapshots
             WHERE chat_session_id = ? AND recovery_status = 'restored' AND recovery_workspace_id = ?))
          AND (? IS NULL OR EXISTS (
            SELECT 1 FROM tasks WHERE id = ? AND status = 'in_progress' AND started_at = ?))
        RETURNING id, node_id AS nodeId, user_id AS userId, status`
    )
    .bind(
      nowIso,
      input.restoredWorkspaceId,
      input.restoredWorkspaceId,
      input.chatSessionId,
      input.restoredWorkspaceId,
      input.snapshotGeneration ?? null,
      input.chatSessionId,
      input.restoredWorkspaceId,
      commit?.taskId ?? null,
      commit?.taskId ?? null,
      commit?.startedAt ?? null
    );
}

/**
 * After the wake committed, queue every source restored into `restoredWorkspaceId` for
 * deletion: it is no longer needed for any retry of this wake, and nothing else would release
 * its node. The commit already stamped the receipt; stamping again here is idempotent and
 * covers a runner whose commit predates the stamp joining the commit batch. Best effort: the
 * stale-workspace sweep re-queues any source whose receipt records the restore.
 */
export async function releaseRestoredSourceWorkspaces(
  env: Env,
  input: RestoredSourceReceiptStamp
): Promise<number> {
  const stamped = await restoredSourceReceiptStampStatement(
    env.DATABASE,
    input,
    new Date().toISOString()
  ).all<{ id: string; nodeId: string | null; userId: string; status: string }>();
  let queued = 0;
  for (const source of stamped.results ?? []) {
    if (!source.nodeId) continue;
    try {
      const stub = env.NODE_LIFECYCLE.get(env.NODE_LIFECYCLE.idFromName(source.nodeId));
      const scheduled = await (
        stub as unknown as import('../durable-objects/node-lifecycle').NodeLifecycle
      ).scheduleWorkspaceDeletion(source.nodeId, source.id, source.userId, {
        retryAfterMs: 0,
        onlyIfAbsent: true,
        lastError: 'scheduled after the conversation was restored on a replacement workspace',
      });
      if (scheduled) queued++;
      log.info('workspace_preservation.restored_source_released', {
        workspaceId: source.id,
        nodeId: source.nodeId,
        status: source.status,
        restoredWorkspaceId: input.restoredWorkspaceId,
        scheduled,
      });
    } catch (error) {
      log.warn('workspace_preservation.restored_source_schedule_failed', {
        workspaceId: source.id,
        nodeId: source.nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return queued;
}
