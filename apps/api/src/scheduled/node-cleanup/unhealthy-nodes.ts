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
  const health = deriveNodeHealth(
    {
      status: 'running',
      healthStatus: 'healthy',
      createdAt: node.created_at,
      lastHeartbeatAt: node.last_heartbeat_at,
      heartbeatStaleAfterSeconds: node.heartbeat_stale_after_seconds,
    },
    now
  );
  if (health !== 'unhealthy') return 'healthy';
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
  try {
    await recordNodeHealthEvent(env, {
      nodeId: node.id,
      episodeStartedAt: node.last_heartbeat_at ?? node.created_at,
      event,
      reason,
      createdAt: nowIso,
    });
  } catch (error) {
    log.error('node_cleanup.health_event_failed', {
      nodeId: node.id,
      event,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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

async function wasRecorded(
  env: Env,
  node: Candidate,
  event: string,
  workspaceId: string
): Promise<boolean> {
  try {
    return await hasNodeHealthEvent(
      env,
      node.id,
      node.last_heartbeat_at ?? node.created_at,
      event,
      workspaceId
    );
  } catch (error) {
    log.error('node_cleanup.health_event_lookup_failed', {
      nodeId: node.id,
      event,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function beforeDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  deadlineMs: number
): Promise<T> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw new Error('node preservation budget exhausted');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('node preservation request timed out'));
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function preserveWorkspace(
  env: Env,
  node: Candidate,
  workspace: Workspace,
  nowIso: string,
  boundaries: UnhealthyNodeBoundaries,
  preservationDeadlineMs: number
): Promise<void> {
  const sessionId = workspace.chat_session_id;
  if (!sessionId) return;
  const episode = node.last_heartbeat_at ?? node.created_at;
  const messageId = `node-health:${node.id}:${workspace.id}:${Date.parse(episode)}`;
  const content = `SAM lost contact with node ${node.id}. It is attempting to preserve this session before releasing the node. Work still in the agent's current turn may not have reached the chat transcript.`;
  if (!(await wasRecorded(env, node, 'session_notice', workspace.id))) {
    try {
      await beforeDeadline(
        (_signal) =>
          boundaries.notice(
            env,
            workspace.project_id,
            sessionId,
            'system',
            content,
            { source: 'node_health', kind: 'heartbeat_lost' },
            messageId
          ),
        preservationDeadlineMs
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
    (await wasRecorded(env, node, 'sleep_requested', workspace.id))
  )
    return;
  try {
    await beforeDeadline(
      (signal) =>
        boundaries.sleep(env, {
          workspaceId: workspace.id,
          userId: workspace.user_id,
          reason: 'node_heartbeat_lost',
          sleepAfterMs: 0,
          expectedNodeId: node.id,
          signal,
        }),
      preservationDeadlineMs
    );
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

async function releaseUnhealthyNode(
  db: CleanupDb,
  env: Env,
  node: Candidate,
  nowIso: string,
  config: CleanupConfig,
  result: NodeCleanupResult,
  boundaries: UnhealthyNodeBoundaries
): Promise<void> {
  const episode = node.last_heartbeat_at ?? node.created_at;
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
  if (destroyed !== 'destroyed') {
    result.unhealthyHeld++;
    if (destroyed === 'failed') result.errors++;
    await record(
      env,
      node,
      'held',
      destroyed === 'failed' ? 'provider_deletion_failed' : 'cleanup_claim_refused',
      nowIso
    );
    return;
  }
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
}

async function processUnhealthyCandidate(
  db: CleanupDb,
  env: Env,
  node: Candidate,
  now: Date,
  context: {
    config: CleanupConfig;
    result: NodeCleanupResult;
    boundaries: UnhealthyNodeBoundaries;
    fleetLoss: boolean;
  }
): Promise<void> {
  const { config, result, boundaries, fleetLoss } = context;
  const nowIso = now.toISOString();
  const episode = node.last_heartbeat_at ?? node.created_at;
  const decision = decideUnhealthyNode(node, now.getTime(), config);
  if (decision === 'healthy') return;
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
  if ((observed.meta.changes ?? 0) !== 1) return;
  await record(env, node, health, 'node_heartbeat_missing', nowIso);
  const fleetEscalationDue =
    now.getTime() - Date.parse(episode) >=
    config.unhealthyReleaseAfterMs + config.unhealthyDrainAfterMs;
  if (fleetLoss) {
    result.unhealthyHeld++;
    const reason = fleetEscalationDue
      ? 'fleet_heartbeat_intake_escalation_required'
      : 'fleet_heartbeat_intake_unverified';
    await record(env, node, fleetEscalationDue ? 'escalated' : 'held', reason, nowIso);
    if (fleetEscalationDue) {
      log.error('node_cleanup.fleet_heartbeat_intake_escalation_required', {
        nodeId: node.id,
        episodeStartedAt: episode,
      });
    }
    return;
  }
  if (decision === 'waiting') {
    result.unhealthyHeld++;
    await record(env, node, 'held', 'drain_window_not_elapsed', nowIso);
    return;
  }
  const workspaces = await loadWorkspaces(env, node.id);
  const preservationDeadlineMs = Date.now() + config.unhealthyPreservationTimeoutMs;
  for (const workspace of workspaces) {
    await preserveWorkspace(env, node, workspace, nowIso, boundaries, preservationDeadlineMs);
  }
  await record(env, node, 'draining', 'heartbeat_loss_exceeded_drain_window', nowIso);
  if (decision !== 'release' && workspaces.some((w) => w.status !== 'sleeping')) {
    result.unhealthyHeld++;
    return;
  }
  await releaseUnhealthyNode(db, env, node, nowIso, config, result, boundaries);
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
  if (candidates.results.length === 0) return;

  const fleet = await env.DATABASE.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN COALESCE(last_heartbeat_at, created_at) < ? THEN 1 ELSE 0 END) AS silent
     FROM nodes WHERE status = 'running' AND node_role = 'workspace'
       AND node_class != 'user-owned' AND runtime = 'vm'`
  )
    .bind(new Date(now.getTime() - config.unhealthyDrainAfterMs).toISOString())
    .first<{ total: number; silent: number }>();
  const fleetLoss =
    (fleet?.total ?? 0) >= config.unhealthyFleetMinNodes &&
    (fleet?.silent ?? 0) / (fleet?.total ?? 1) >= config.unhealthyFleetMaxFraction;

  for (const node of candidates.results) {
    try {
      await processUnhealthyCandidate(db, env, node, now, {
        config,
        result,
        boundaries,
        fleetLoss,
      });
    } catch (error) {
      result.errors++;
      log.error('node_cleanup.unhealthy_candidate_failed', {
        nodeId: node.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
