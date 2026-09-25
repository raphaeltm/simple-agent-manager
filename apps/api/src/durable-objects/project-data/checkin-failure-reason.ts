import { createModuleLogger } from '../../lib/logger';
import type { Env } from './types';

const log = createModuleLogger('project_data.checkin_failure_reason');

export async function checkinFailureReason(env: Env, workspaceId: string | null): Promise<string> {
  if (!workspaceId) return 'No response to SAM check-in; workspace identity is unavailable';
  try {
    const row = await env.DATABASE.prepare(
      `SELECT w.node_id AS nodeId, n.last_heartbeat_at AS lastHeartbeatAt,
              n.heartbeat_stale_after_seconds AS staleAfterSeconds
       FROM workspaces w LEFT JOIN nodes n ON n.id = w.node_id
       WHERE w.id = ? LIMIT 1`
    )
      .bind(workspaceId)
      .first<{
        nodeId: string | null;
        lastHeartbeatAt: string | null;
        staleAfterSeconds: number | null;
      }>();
    if (!row?.nodeId)
      return 'SAM check-in expired after the workspace lost its node; agent progress is unknown';
    const beatAt = row.lastHeartbeatAt ? Date.parse(row.lastHeartbeatAt) : NaN;
    if (
      !Number.isFinite(beatAt) ||
      Date.now() - beatAt > Math.max(1, row.staleAfterSeconds ?? 1) * 1000
    ) {
      return `Control plane lost heartbeat from node ${row.nodeId} before SAM check-in expired; agent progress is unknown`;
    }
    return 'No agent response to SAM check-in by deadline; node heartbeat remained healthy';
  } catch (error) {
    log.warn('attention_marker.checkin_node_liveness_query_failed', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'SAM check-in expired while node heartbeat status could not be verified; agent progress is unknown';
  }
}
