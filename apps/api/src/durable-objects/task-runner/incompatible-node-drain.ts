/** Admission requests preservation, never teardown. The sleep sweep owns idleness,
 * snapshot verification and its bounded failure episode; normal cleanup owns retirement. */
import { DEFAULT_WORKSPACE_CLEANUP_SWEEP_LIMIT } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import { log } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import { normalizeAgentVersion } from '../../services/node-agent-compatibility';
import { ensureSessionSnapshotForSleep } from '../../services/session-snapshots';
import { persistPlacementDiagnostics } from './placement-diagnostics';
import type { TaskRunnerContext, TaskRunnerState } from './types';

export async function requestIncompatiblePoolNodeDrain(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  const pool = state.config.capacityPoolSelection;
  const requiredVersion = normalizeAgentVersion(rc.env.VM_AGENT_REQUIRED_VERSION);
  if (!pool || !requiredVersion) return;
  const limit = parsePositiveInt(
    rc.env.WORKSPACE_CLEANUP_SWEEP_LIMIT,
    DEFAULT_WORKSPACE_CLEANUP_SWEEP_LIMIT
  );
  // Match incompatible-node cleanup's ownership/provenance. Do not accelerate an
  // existing retry or reopen a blocked episode just because another task wants room.
  const candidates = await rc.env.DATABASE.prepare(
    `SELECT w.id, w.node_id, w.project_id, w.chat_session_id,
            (SELECT a.id FROM agent_sessions a WHERE a.workspace_id = w.id
               AND a.status IN ('running', 'recovery', 'sleeping')
               ORDER BY a.created_at DESC LIMIT 1) AS agent_session_id
       FROM workspaces w JOIN nodes n ON n.id = w.node_id
       LEFT JOIN session_snapshots s ON s.chat_session_id = w.chat_session_id
      WHERE n.user_id = ? AND w.user_id = n.user_id AND n.capacity_pool_id = ?
        AND n.status = 'running' AND n.runtime = 'vm'
        AND n.node_role = 'workspace' AND n.node_class = 'managed'
        AND (n.agent_version IS NULL OR TRIM(n.agent_version) != ?)
        AND EXISTS (SELECT 1 FROM tasks t WHERE t.auto_provisioned_node_id = n.id)
        AND w.status IN ('running', 'recovery')
        AND w.project_id IS NOT NULL AND w.chat_session_id IS NOT NULL
        AND s.sleep_status IS NULL AND s.sleeping_at IS NULL
        AND (s.id IS NULL OR s.status IN ('pending', 'available', 'degraded', 'failed'))
        AND (s.id IS NULL OR (s.user_id = w.user_id
          AND s.project_id = w.project_id AND (s.workspace_id IS NULL OR s.workspace_id = w.id)))
        AND EXISTS (SELECT 1 FROM agent_sessions a WHERE a.workspace_id = w.id
          AND a.status IN ('running', 'recovery', 'sleeping'))
      ORDER BY n.created_at, w.id LIMIT ?`
  )
    .bind(state.userId, pool.poolId, requiredVersion, limit)
    .all<{
      id: string;
      node_id: string;
      project_id: string;
      chat_session_id: string;
      agent_session_id: string | null;
    }>();
  const queuedNodes = new Set<string>();
  const db = drizzle(rc.env.DATABASE, { schema });
  for (const workspace of candidates.results) {
    if (!workspace.agent_session_id) continue;
    try {
      if (
        !(await ensureSessionSnapshotForSleep(
          db,
          rc.env,
          {
            workspaceId: workspace.id,
            nodeId: workspace.node_id,
            projectId: workspace.project_id,
            userId: state.userId,
            chatSessionId: workspace.chat_session_id,
            agentSessionId: workspace.agent_session_id,
            runtime: 'vm',
          },
          { expectedNodeId: workspace.node_id }
        ))
      )
        continue;
      const now = new Date().toISOString();
      // CAS only a missing intent. In particular, do not pull a failed episode's
      // retry deadline forward, erase its claim, or reset its failure budget.
      const queued = await rc.env.DATABASE.prepare(
        `UPDATE session_snapshots SET sleep_status = 'scheduled', sleep_after = ?, updated_at = ?
          WHERE chat_session_id = ? AND workspace_id = ? AND node_id = ? AND user_id = ?
            AND sleep_status IS NULL AND sleeping_at IS NULL
            AND status IN ('pending', 'available', 'degraded', 'failed')
            AND EXISTS (
              SELECT 1 FROM workspaces w JOIN nodes n ON n.id = w.node_id
               WHERE w.id = session_snapshots.workspace_id
                 AND w.node_id = session_snapshots.node_id
                 AND w.chat_session_id = session_snapshots.chat_session_id
                 AND w.user_id = session_snapshots.user_id AND n.user_id = w.user_id
                 AND w.status IN ('running', 'recovery')
                 AND n.status = 'running' AND n.runtime = 'vm'
                 AND n.node_role = 'workspace' AND n.node_class = 'managed'
                 AND n.capacity_pool_id = ?
                 AND (n.agent_version IS NULL OR TRIM(n.agent_version) != ?)
            )`
      )
        .bind(
          now,
          now,
          workspace.chat_session_id,
          workspace.id,
          workspace.node_id,
          state.userId,
          pool.poolId,
          requiredVersion
        )
        .run();
      if ((queued.meta.changes ?? 0) > 0) queuedNodes.add(workspace.node_id);
    } catch (error) {
      log.warn('task_runner_do.incompatible_node_drain_intent_failed', {
        taskId: state.taskId,
        nodeId: workspace.node_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (queuedNodes.size > 0) {
    await persistPlacementDiagnostics(state, rc, {
      notes: [
        `Queued safe drain for incompatible host agent version on nodes: ${[...queuedNodes].join(', ')}. Existing sleep budgets, idleness gates and node retention apply.`,
      ],
    });
  }
}
