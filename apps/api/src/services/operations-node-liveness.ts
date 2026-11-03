/**
 * "Why is this node still alive?" — the core of the `ops_why_is_node_alive` tool.
 *
 * Joins the node row, its workspaces, the NodeLifecycle DO state and the decision log into a
 * plain-language verdict. Rule 53: heartbeat columns answer "is the VM reachable?", never "is
 * it idle?". Idleness comes only from workspace reservations, the warm state and decisions.
 */
import type { NodeLifecycleState } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import * as nodeLifecycleService from './node-lifecycle';
import {
  DEFAULT_NODE_DECISION_LIST_LIMIT,
  listNodeLifecycleDecisions,
  type NodeLifecycleDecisionRow,
} from './node-lifecycle-decisions';
import {
  ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL,
  ACTIVE_WORKSPACE_RESERVATION_STATUSES,
} from './workspace-resource-capacity';

/** Workspaces listed per node; the counts cover every workspace regardless. */
export const NODE_LIVENESS_WORKSPACE_LIST_LIMIT = 20;

export interface NodeLivenessNode {
  id: string;
  userId: string;
  status: string;
  healthStatus: string;
  nodeClass: string;
  nodeRole: string;
  runtime: string;
  warmSince: string | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
  cleanupBackoffUntil: string | null;
  cleanupBlockedSince: string | null;
  cleanupBlockedReason: string | null;
}

export interface NodeLivenessWorkspace {
  id: string;
  status: string;
  projectId: string | null;
  updatedAt: string;
}

export interface NodeLivenessFacts {
  node: NodeLivenessNode;
  activeWorkspaceCount: number;
  workspaceCountsByStatus: Record<string, number>;
  workspaces: NodeLivenessWorkspace[];
  lifecycle: NodeLifecycleState | null;
  decisions: NodeLifecycleDecisionRow[];
}

export interface NodeLivenessExplanation extends NodeLivenessFacts {
  alive: boolean;
  verdict: string;
  reasons: string[];
}

interface NodeDbRow {
  id: string;
  user_id: string;
  status: string;
  health_status: string;
  node_class: string;
  node_role: string;
  runtime: string;
  warm_since: string | null;
  last_heartbeat_at: string | null;
  created_at: string;
  cleanup_backoff_until: string | null;
  cleanup_blocked_since: string | null;
  cleanup_blocked_reason: string | null;
}

function latest(
  decisions: NodeLifecycleDecisionRow[],
  match: (row: NodeLifecycleDecisionRow) => boolean
): NodeLifecycleDecisionRow | undefined {
  return decisions.find(match); // decisions are newest first
}

function describeDecision(row: NodeLifecycleDecisionRow): string {
  return `${row.decision}${row.reason ? ` (${row.reason})` : ''} at ${row.createdAt}`;
}

/** Pure verdict over gathered facts, so every branch is testable without I/O. */
export function nodeLivenessVerdict(
  facts: NodeLivenessFacts,
  now: number = Date.now()
): Pick<NodeLivenessExplanation, 'alive' | 'verdict' | 'reasons'> {
  const { node, lifecycle, decisions } = facts;
  const reasons: string[] = [];
  const lastSweep = latest(decisions, (row) => row.source === 'cleanup_sweep');
  const lastHandoff = latest(decisions, (row) => row.source === 'warm_handoff');
  const lastWarm = latest(decisions, (row) => row.decision === 'marked_warm');

  if (node.status === 'deleted') {
    return { alive: false, verdict: 'The node is deleted.', reasons };
  }
  if (node.healthStatus === 'unhealthy') {
    reasons.push(
      'Heartbeats stopped (health: unhealthy). The unhealthy-node sweep drains its workspaces and then releases it.'
    );
  }
  if (node.nodeClass === 'user-owned') {
    return {
      alive: true,
      verdict: 'User-owned machine: SAM never tears it down. Its owner removes it.',
      reasons,
    };
  }
  if (node.nodeRole !== 'workspace') {
    return {
      alive: true,
      verdict: `A ${node.nodeRole} node: deployment-node cleanup removes it once no environment uses it.`,
      reasons,
    };
  }
  if (node.status === 'stopped' || node.status === 'destroying') {
    reasons.push(
      lastSweep
        ? `Last cleanup sweep decision: ${describeDecision(lastSweep)}.`
        : 'No cleanup sweep decision recorded yet.'
    );
    if (node.cleanupBlockedReason) {
      reasons.push(
        `Cleanup has been blocked since ${node.cleanupBlockedSince ?? 'unknown'}: ${node.cleanupBlockedReason}.`
      );
    }
    if (node.cleanupBackoffUntil && Date.parse(node.cleanupBackoffUntil) > now) {
      reasons.push(`The sweep retries after ${node.cleanupBackoffUntil}.`);
    }
    return {
      alive: true,
      verdict: `Marked ${node.status} and waiting for the cleanup sweep to destroy the VM.`,
      reasons,
    };
  }
  if (facts.activeWorkspaceCount > 0) {
    return {
      alive: true,
      verdict: `Kept alive by ${facts.activeWorkspaceCount} active workspace(s).`,
      reasons,
    };
  }
  if (lifecycle?.status === 'active' && lifecycle.claimedByTask) {
    return {
      alive: true,
      verdict: `Claimed for reuse by task ${lifecycle.claimedByTask}; its workspace has not started yet.`,
      reasons,
    };
  }
  if (lifecycle?.status === 'warm') {
    const dueAt =
      typeof lastWarm?.detail?.teardownDueAt === 'string' ? lastWarm.detail.teardownDueAt : null;
    const overdue = dueAt !== null && Date.parse(dueAt) <= now;
    return {
      alive: true,
      verdict: dueAt
        ? overdue
          ? `Warm (idle) since ${lifecycle.warmSince}; teardown was due at ${dueAt} and is overdue.`
          : `Warm (idle) since ${lifecycle.warmSince}, kept for fast reuse until ${dueAt}.`
        : `Warm (idle) since ${lifecycle.warmSince}, kept for fast reuse until its warm timeout.`,
      reasons,
    };
  }
  reasons.push(
    lastHandoff
      ? `Last warm handoff decision: ${describeDecision(lastHandoff)}.`
      : 'No warm handoff was recorded for this node.'
  );
  if (lastSweep) reasons.push(`Last cleanup sweep decision: ${describeDecision(lastSweep)}.`);
  return {
    alive: true,
    verdict:
      'Running with no active workspaces but not in the warm pool. The cleanup sweep backstop hands it to warm or reaps it after the idle window.',
    reasons,
  };
}

async function loadNode(env: Env, nodeId: string): Promise<NodeLivenessNode | null> {
  const row = await env.DATABASE.prepare(
    `SELECT id, user_id, status, health_status, node_class, node_role, runtime, warm_since,
            last_heartbeat_at, created_at, cleanup_backoff_until, cleanup_blocked_since,
            cleanup_blocked_reason
       FROM nodes WHERE id = ?`
  )
    .bind(nodeId)
    .first<NodeDbRow>();
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    healthStatus: row.health_status,
    nodeClass: row.node_class,
    nodeRole: row.node_role,
    runtime: row.runtime,
    warmSince: row.warm_since,
    lastHeartbeatAt: row.last_heartbeat_at,
    createdAt: row.created_at,
    cleanupBackoffUntil: row.cleanup_backoff_until,
    cleanupBlockedSince: row.cleanup_blocked_since,
    cleanupBlockedReason: row.cleanup_blocked_reason,
  };
}

async function loadLifecycleState(env: Env, nodeId: string): Promise<NodeLifecycleState | null> {
  try {
    const state = await nodeLifecycleService.getStatus(env, nodeId);
    // A DO with no stored state reports an empty node id; that is "no lifecycle state".
    return state.nodeId ? state : null;
  } catch (error) {
    log.warn('operations.node_liveness.lifecycle_unavailable', {
      nodeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function explainNodeLiveness(
  env: Env,
  nodeId: string,
  options: { decisionLimit?: number; now?: number } = {}
): Promise<NodeLivenessExplanation | null> {
  const node = await loadNode(env, nodeId);
  if (!node) return null;
  const [counts, workspaces, lifecycle, decisions] = await Promise.all([
    env.DATABASE.prepare(
      'SELECT status, COUNT(*) AS count FROM workspaces WHERE node_id = ? GROUP BY status'
    )
      .bind(nodeId)
      .all<{ status: string; count: number }>(),
    env.DATABASE.prepare(
      `SELECT id, status, project_id, updated_at FROM workspaces
        WHERE node_id = ? AND status != 'deleted'
        ORDER BY CASE WHEN status IN (${ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL}) THEN 0 ELSE 1 END,
                 updated_at DESC, id
        LIMIT ?`
    )
      .bind(nodeId, NODE_LIVENESS_WORKSPACE_LIST_LIMIT)
      .all<{ id: string; status: string; project_id: string | null; updated_at: string }>(),
    loadLifecycleState(env, nodeId),
    listNodeLifecycleDecisions(
      env.DATABASE,
      nodeId,
      options.decisionLimit ?? DEFAULT_NODE_DECISION_LIST_LIMIT
    ),
  ]);
  const workspaceCountsByStatus = Object.fromEntries(
    counts.results.map((row) => [row.status, Number(row.count)])
  );
  const activeStatuses = new Set<string>(ACTIVE_WORKSPACE_RESERVATION_STATUSES);
  const facts: NodeLivenessFacts = {
    node,
    activeWorkspaceCount: Object.entries(workspaceCountsByStatus)
      .filter(([status]) => activeStatuses.has(status))
      .reduce((sum, [, count]) => sum + count, 0),
    workspaceCountsByStatus,
    workspaces: workspaces.results.map((row) => ({
      id: row.id,
      status: row.status,
      projectId: row.project_id,
      updatedAt: row.updated_at,
    })),
    lifecycle,
    decisions,
  };
  return { ...facts, ...nodeLivenessVerdict(facts, options.now) };
}
