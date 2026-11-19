/** Repair wakeability only AFTER the exact VM runtime's physical termination is durable. */
import { DEFAULT_WORKSPACE_CLEANUP_SWEEP_LIMIT } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';

export async function repairRetiredVmSleepSnapshots(
  env: Env,
  nodeId: string,
  userId: string
): Promise<void> {
  const limit = parsePositiveInt(
    env.WORKSPACE_CLEANUP_SWEEP_LIMIT,
    DEFAULT_WORKSPACE_CLEANUP_SWEEP_LIMIT
  );
  const repaired = await env.DATABASE.prepare(
    `UPDATE session_snapshots
    SET sleeping_at = COALESCE(sleeping_at, (
          SELECT n.runtime_termination_confirmed_at FROM nodes n WHERE n.id = ?)),
        sleep_status = 'sleeping', sleep_after = NULL, sleep_claim_id = NULL, sleep_claimed_at = NULL,
        status = CASE WHEN sleep_status = 'stopping'
          AND CASE WHEN json_valid(sleep_fallback_json)
            THEN json_type(sleep_fallback_json, '$.recoveryPoint') = 'null' ELSE 0 END
          THEN 'degraded' ELSE status END,
        degradation = CASE WHEN sleep_status = 'stopping'
          AND CASE WHEN json_valid(sleep_fallback_json)
            THEN json_type(sleep_fallback_json, '$.recoveryPoint') = 'null' ELSE 0 END
          THEN 'transcript-only' ELSE degradation END
    WHERE id IN (
      SELECT saved.id FROM session_snapshots saved
      JOIN workspaces w ON w.id = saved.workspace_id
      JOIN nodes n ON n.id = w.node_id
      WHERE n.id = ? AND n.user_id = ? AND n.runtime = 'vm'
        AND n.node_class = 'managed' AND n.node_role = 'workspace'
        AND n.runtime_termination_confirmed_at IS NOT NULL
        AND w.user_id IS n.user_id AND saved.user_id IS n.user_id
        AND saved.node_id IS n.id AND saved.project_id IS w.project_id
        AND saved.chat_session_id IS w.chat_session_id
        AND w.status = 'deleted' AND w.runtime_deletion_proof = 'node_runtime_terminated'
        AND w.runtime_deletion_confirmed_at IS n.runtime_termination_confirmed_at
        AND saved.capture_generation IS NULL
        AND (CASE WHEN json_valid(saved.cleanup_identity_json) THEN (
          json_extract(saved.cleanup_identity_json, '$.workspaceId') IS w.id
          AND json_extract(saved.cleanup_identity_json, '$.nodeId') IS n.id
          AND json_extract(saved.cleanup_identity_json, '$.userId') IS n.user_id
          AND json_extract(saved.cleanup_identity_json, '$.nodeRuntimeIncarnationId') IS n.runtime_incarnation_id
          AND json_extract(saved.cleanup_identity_json, '$.workspaceGeneration') IS COALESCE(w.eviction_generation, '')
          AND json_extract(saved.cleanup_identity_json, '$.snapshotGeneration') IS saved.snapshot_generation
        ) ELSE 0 END)
        AND ((saved.sleep_status = 'sleeping' AND saved.sleeping_at IS NULL
          AND CASE WHEN json_valid(saved.cleanup_identity_json)
            THEN json_extract(saved.cleanup_identity_json, '$.preserved') = 1 ELSE 0 END)
          OR (saved.sleep_status = 'stopping'
            AND CASE WHEN json_valid(saved.sleep_fallback_json)
              THEN json_extract(saved.sleep_fallback_json, '$.outcome') = 'slept' ELSE 0 END))
      LIMIT ?
    )`
  )
    .bind(nodeId, nodeId, userId, limit)
    .run();
  // Keep a proof-bearing node in the retry path until every repair page drained.
  if ((repaired.meta.changes ?? 0) >= limit)
    throw new Error('Retired VM sleep repair reached its source budget; retry required');
}
