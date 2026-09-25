import type { Env } from '../../env';
import { log } from '../../lib/logger';
import {
  deriveNodeHealth,
  hasNodeHealthEvent,
  recordNodeHealthEvent,
} from '../../services/node-health';
import {
  listStrandedNodeTasks,
  terminalizeStrandedNodeTasks,
} from '../../services/node-stranded-tasks';
import { persistMessage } from '../../services/project-data';
import { queueWorkspaceSessionSleep } from '../../services/session-sleep';
import {
  type CleanupConfig,
  type CleanupDb,
  destroyNodeForCleanup,
  type NodeCleanupResult,
} from './shared';

type Candidate = {
  id: string;
  user_id: string;
  status: string;
  created_at: string;
  last_heartbeat_at: string | null;
  heartbeat_stale_after_seconds: number;
  health_status: string;
};

type Workspace = {
  id: string;
  project_id: string;
  chat_session_id: string | null;
  user_id: string;
  status: string;
};

type Decision = 'healthy' | 'waiting' | 'drain' | 'release';

export interface UnhealthyNodeBoundaries {
  notice: typeof persistMessage;
  sleep: typeof queueWorkspaceSessionSleep;
  release: typeof destroyNodeForCleanup;
}

const defaultBoundaries: UnhealthyNodeBoundaries = {
  notice: persistMessage,
  sleep: queueWorkspaceSessionSleep,
  release: destroyNodeForCleanup,
};

export function decideUnhealthyNode(
  node: Pick<Candidate, 'created_at' | 'last_heartbeat_at' | 'heartbeat_stale_after_seconds'>,
  now: number,
  config: Pick<CleanupConfig, 'unhealthyDrainAfterMs' | 'unhealthyReleaseAfterMs'>
): Decision {
  const lastContact = Date.parse(node.last_heartbeat_at ?? node.created_at);
  if (!Number.isFinite(lastContact)) return 'waiting';
  const lostForMs = Math.max(0, now - lastContact);
  const unhealthyAfterMs = Math.max(1, node.heartbeat_stale_after_seconds) * 2_000;
  if (lostForMs <= unhealthyAfterMs) return 'healthy';
  if (lostForMs < config.unhealthyDrainAfterMs) return 'waiting';
  return lostForMs >= config.unhealthyReleaseAfterMs ? 'release' : 'drain';
}

async function record(
  env: Env,
  node: Candidate,
  event: string,
  reason: string,
  nowIso: string
): Promise<void> {
  await recordNodeHealthEvent(env, {
    nodeId: node.id,
    episodeStartedAt: node.last_heartbeat_at ?? node.created_at,
    event,
    reason,
    createdAt: nowIso,
  });
}

async function loadWorkspaces(env: Env, nodeId: string): Promise<Workspace[]> {
  const rows = await env.DATABASE.prepare(
    `SELECT id, project_id, chat_session_id, user_id, status
     FROM workspaces WHERE node_id = ? AND status IN ('running', 'creating', 'recovery', 'sleeping')`
  )
    .bind(nodeId)
    .all<Workspace>();
  return rows.results;
}

async function preserveWorkspace(
  env: Env,
  node: Candidate,
  workspace: Workspace,
  nowIso: string,
  boundaries: UnhealthyNodeBoundaries
): Promise<void> {
  if (!workspace.chat_session_id) return;
  const episode = node.last_heartbeat_at ?? node.created_at;
  const messageId = `node-health:${node.id}:${workspace.id}:${Date.parse(episode)}`;
  const content = `SAM lost contact with node ${node.id}. It is attempting to preserve this session before releasing the node. Work still in the agent's current turn may not have reached the chat transcript.`;
  if (!(await hasNodeHealthEvent(env, node.id, episode, 'session_notice', workspace.id))) {
    try {
      await boundaries.notice(
        env,
        workspace.project_id,
        workspace.chat_session_id,
        'system',
        content,
        { source: 'node_health', kind: 'heartbeat_lost' },
        messageId
      );
      await record(env, node, 'session_notice', workspace.id, nowIso);
    } catch (error) {
      await record(env, node, 'notice_failed', workspace.id, nowIso);
      log.error('node_cleanup.unhealthy_notice_failed', {
        nodeId: node.id,
        workspaceId: workspace.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (
    workspace.status === 'sleeping' ||
    (await hasNodeHealthEvent(env, node.id, episode, 'sleep_requested', workspace.id))
  )
    return;
  try {
    await boundaries.sleep(env, {
      workspaceId: workspace.id,
      userId: workspace.user_id,
      reason: 'node_heartbeat_lost',
      sleepAfterMs: 0,
    });
    await record(env, node, 'sleep_requested', workspace.id, nowIso);
  } catch (error) {
    await record(env, node, 'sleep_unavailable', workspace.id, nowIso);
    log.warn('node_cleanup.unhealthy_sleep_unavailable', {
      nodeId: node.id,
      workspaceId: workspace.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** One isolated cleanup phase; each selected node is also isolated from its peers. */
export async function sweepUnhealthyNodes(
  db: CleanupDb,
  env: Env,
  now: Date,
  config: CleanupConfig,
  result: NodeCleanupResult,
  boundaries: UnhealthyNodeBoundaries = defaultBoundaries
): Promise<void> {
  const nowIso = now.toISOString();
  const candidates = await env.DATABASE.prepare(
    `SELECT id, user_id, status, created_at, last_heartbeat_at,
            heartbeat_stale_after_seconds, health_status
     FROM nodes
     WHERE status = 'running' AND node_role = 'workspace'
       AND node_class != 'user-owned' AND runtime = 'vm'
       AND COALESCE(last_heartbeat_at, created_at) < ?
       AND (cleanup_backoff_until IS NULL OR cleanup_backoff_until <= ?)
     ORDER BY COALESCE(last_heartbeat_at, created_at) ASC LIMIT ?`
  )
    .bind(nowIso, nowIso, config.nodeSweepLimit)
    .all<Candidate>();

  const fleet = await env.DATABASE.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN COALESCE(last_heartbeat_at, created_at) < ? THEN 1 ELSE 0 END) AS silent
     FROM nodes WHERE status = 'running' AND node_role = 'workspace'
       AND node_class != 'user-owned' AND runtime = 'vm'`
  )
    .bind(new Date(now.getTime() - config.unhealthyDrainAfterMs).toISOString())
    .first<{ total: number; silent: number }>();
  const fleetLoss =
    (fleet?.total ?? 0) >= 3 &&
    (fleet?.silent ?? 0) / (fleet?.total ?? 1) >= config.unhealthyFleetMaxFraction;

  for (const node of candidates.results) {
    try {
      const episode = node.last_heartbeat_at ?? node.created_at;
      const decision = decideUnhealthyNode(node, now.getTime(), config);
      if (decision === 'healthy') continue;
      const health = deriveNodeHealth(
        {
          status: node.status,
          createdAt: node.created_at,
          lastHeartbeatAt: node.last_heartbeat_at,
          heartbeatStaleAfterSeconds: node.heartbeat_stale_after_seconds,
          healthStatus: node.health_status,
        },
        now.getTime()
      );
      const observed = await env.DATABASE.prepare(
        `UPDATE nodes SET health_status = ?
         WHERE id = ? AND status = 'running' AND last_heartbeat_at IS ?`
      )
        .bind(health, node.id, node.last_heartbeat_at)
        .run();
      if ((observed.meta.changes ?? 0) !== 1) continue;
      await record(env, node, health, 'node_heartbeat_missing', nowIso);
      if (fleetLoss) {
        result.unhealthyHeld++;
        await record(env, node, 'held', 'fleet_heartbeat_intake_unverified', nowIso);
        continue;
      }
      if (decision === 'waiting') {
        result.unhealthyHeld++;
        await record(env, node, 'held', 'drain_window_not_elapsed', nowIso);
        continue;
      }
      const workspaces = await loadWorkspaces(env, node.id);
      for (const workspace of workspaces) {
        await preserveWorkspace(env, node, workspace, nowIso, boundaries);
      }
      await record(env, node, 'draining', 'heartbeat_loss_exceeded_drain_window', nowIso);
      if (decision !== 'release' && workspaces.some((w) => w.status !== 'sleeping')) {
        result.unhealthyHeld++;
        continue;
      }
      const strandedTasks = await listStrandedNodeTasks(env, node.id);
      const destroyed = await boundaries.release(db, env, nowIso, node, {
        logEvent: 'node_cleanup.unhealthy_releasing',
        failureLogEvent: 'node_cleanup.unhealthy_release_failed',
        successMessage: 'Released unhealthy managed node',
        failureMessagePrefix: 'Failed to release unhealthy managed node',
        recoveryType: 'unhealthy_node_release',
        failureRecoveryType: 'unhealthy_node_release_failed',
        failureBackoffMs: config.unhealthyRetryMs,
        allowActiveWorkspaces: true,
        allowManagedRunningProvenance: true,
        expectedLastHeartbeatAt: node.last_heartbeat_at,
        requireWorkspaceIdle: false,
        requestDeadlineMs: Date.now() + config.stoppedHandoffRequestTimeoutMs,
        context: { episodeStartedAt: episode, reason: 'heartbeat_loss_exceeded_release_window' },
      });
      if (destroyed === 'destroyed') {
        result.unhealthyReleased++;
        await record(env, node, 'released', 'heartbeat_loss_exceeded_release_window', nowIso);
        const failures = await terminalizeStrandedNodeTasks(
          env,
          node.id,
          strandedTasks,
          'heartbeat_lost'
        );
        if (failures > 0) {
          await record(
            env,
            node,
            'task_terminalization_failed',
            'post_release_transition_failed',
            nowIso
          );
        }
      } else {
        result.unhealthyHeld++;
        if (destroyed === 'failed') result.errors++;
        await record(
          env,
          node,
          'held',
          destroyed === 'failed' ? 'provider_deletion_failed' : 'cleanup_claim_refused',
          nowIso
        );
      }
    } catch (error) {
      result.errors++;
      log.error('node_cleanup.unhealthy_candidate_failed', {
        nodeId: node.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
