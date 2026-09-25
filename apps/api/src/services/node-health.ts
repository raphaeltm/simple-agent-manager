import type { NodeHealthStatus } from '@simple-agent-manager/shared';

import type * as schema from '../db/schema';
import type { Env } from '../env';
import { ulid } from '../lib/ulid';

export function deriveNodeHealth(
  node: Pick<
    schema.Node,
    'status' | 'healthStatus' | 'lastHeartbeatAt' | 'createdAt' | 'heartbeatStaleAfterSeconds'
  >,
  now: number
): NodeHealthStatus {
  if (node.status !== 'running') return (node.healthStatus as NodeHealthStatus) || 'stale';
  const heartbeatAt = Date.parse(node.lastHeartbeatAt ?? node.createdAt);
  if (!Number.isFinite(heartbeatAt)) return 'unhealthy';
  const staleAfterMs = Math.max(1, node.heartbeatStaleAfterSeconds) * 1000;
  const age = Math.max(0, now - heartbeatAt);
  if (age <= staleAfterMs) return 'healthy';
  return age <= staleAfterMs * 2 ? 'stale' : 'unhealthy';
}

export type NodeHealthEvent = {
  nodeId: string;
  episodeStartedAt: string;
  event: string;
  reason: string;
  createdAt: string;
};

/** The episode key is the last acknowledged heartbeat, so repeated sweeps are idempotent. */
export async function recordNodeHealthEvent(env: Env, input: NodeHealthEvent): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO node_health_events
     (id, node_id, episode_started_at, event, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(ulid(), input.nodeId, input.episodeStartedAt, input.event, input.reason, input.createdAt)
    .run();
}

export async function listNodeHealthEvents(env: Env, nodeId: string): Promise<NodeHealthEvent[]> {
  const rows = await env.DATABASE.prepare(
    `SELECT node_id AS nodeId, episode_started_at AS episodeStartedAt,
            event, reason, created_at AS createdAt
     FROM node_health_events WHERE node_id = ? ORDER BY created_at ASC`
  )
    .bind(nodeId)
    .all<NodeHealthEvent>();
  return rows.results;
}

export async function hasNodeHealthEvent(
  env: Env,
  nodeId: string,
  episodeStartedAt: string,
  event: string,
  reason: string
): Promise<boolean> {
  const row = await env.DATABASE.prepare(
    `SELECT 1 AS found FROM node_health_events
     WHERE node_id = ? AND episode_started_at = ? AND event = ? AND reason = ? LIMIT 1`
  )
    .bind(nodeId, episodeStartedAt, event, reason)
    .first<{ found: number }>();
  return row !== null;
}
