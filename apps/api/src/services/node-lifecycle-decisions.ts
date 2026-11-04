/**
 * Node lifecycle decision log: one compact D1 row per keep/kill decision, written by the
 * NodeLifecycle DO, the cleanup sweep and the warm handoff. It answers "why is this node
 * still alive?" after the transient DO state and Worker logs are gone.
 *
 * Writes are best-effort and MUST never fail the lifecycle path that records them:
 * `recordNodeLifecycleDecision` swallows and logs every error. The workspace count is
 * computed inside the same INSERT, so it is the count at decision time with no extra
 * round trip. Repeating decisions (a sweep skipping the same node every tick) pass a
 * dedupe window, enforced in SQL so concurrent writers cannot both insert.
 */
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL } from './workspace-resource-capacity';

export type NodeLifecycleDecisionSource =
  | 'node_lifecycle'
  | 'cleanup_sweep'
  | 'warm_handoff'
  | 'operations_action'
  | 'deployment_teardown';

export type NodeLifecycleDecision =
  // NodeLifecycle DO
  | 'kept_active'
  | 'marked_warm'
  | 'marked_active'
  | 'claimed'
  | 'claim_released'
  | 'warm_expired_destroying'
  | 'warm_handoff_preserved'
  | 'destroying_state_retired'
  | 'deletion_finalized'
  // Cleanup sweep
  | 'destroy_attempted'
  | 'destroyed'
  | 'destroy_failed'
  | 'skipped'
  | 'legacy_binding_refused'
  // Warm handoff
  | 'handed_to_warm'
  | 'preserved_active'
  | 'handoff_skipped'
  | 'handoff_failed'
  // Operations action (an approved or auto-safe `rerun_node_cleanup`)
  | 'cleanup_rerun_requested';

export type NodeLifecycleDecisionDetail = Record<
  string,
  string | number | boolean | null | undefined
>;

export interface NodeLifecycleDecisionInput {
  nodeId: string;
  source: NodeLifecycleDecisionSource;
  decision: NodeLifecycleDecision;
  reason?: string | null;
  detail?: NodeLifecycleDecisionDetail;
  /** Skip the write when the same (source, decision, reason) was recorded this recently. */
  dedupeWindowMs?: number;
  now?: Date;
}

export interface NodeLifecycleDecisionRow {
  id: string;
  nodeId: string;
  source: string;
  decision: string;
  reason: string | null;
  workspaceCount: number | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

/** Keeps one row compact; a decision log is not a place for payloads. */
export const NODE_DECISION_REASON_MAX_LENGTH = 300;
export const NODE_DECISION_DETAIL_MAX_LENGTH = 1000;
/** Cron sweeps re-skip the same node every tick; record a repeat at most this often. */
export const DEFAULT_NODE_DECISION_DEDUPE_WINDOW_MS = 30 * 60 * 1000;
export const DEFAULT_NODE_DECISION_LIST_LIMIT = 20;
export const MAX_NODE_DECISION_LIST_LIMIT = 100;
export const DEFAULT_NODE_DECISION_RETENTION_DAYS = 14;
export const DEFAULT_NODE_DECISION_PURGE_BATCH = 500;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function serializeDetail(detail: NodeLifecycleDecisionDetail | undefined): string | null {
  if (!detail) return null;
  const compact: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (value === undefined) continue;
    compact[key] =
      typeof value === 'string' ? truncate(value, NODE_DECISION_REASON_MAX_LENGTH) : value;
  }
  if (Object.keys(compact).length === 0) return null;
  const json = JSON.stringify(compact);
  return json.length <= NODE_DECISION_DETAIL_MAX_LENGTH
    ? json
    : JSON.stringify({ truncated: true, keys: Object.keys(compact).slice(0, 20) });
}

/** Best-effort. Returns whether a row was inserted; never throws. */
export async function recordNodeLifecycleDecision(
  db: D1Database,
  input: NodeLifecycleDecisionInput
): Promise<boolean> {
  try {
    const now = input.now ?? new Date();
    const reason =
      input.reason === undefined || input.reason === null
        ? null
        : truncate(input.reason, NODE_DECISION_REASON_MAX_LENGTH);
    const dedupe = input.dedupeWindowMs !== undefined && input.dedupeWindowMs > 0;
    const result = await db
      .prepare(
        `INSERT INTO node_lifecycle_decisions
           (id, node_id, source, decision, reason, workspace_count, detail_json, created_at)
         SELECT ?, ?, ?, ?, ?,
                (SELECT COUNT(*) FROM workspaces
                  WHERE node_id = ? AND status IN (${ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL})),
                ?, ?
          WHERE ? = 0 OR NOT EXISTS (
            SELECT 1 FROM node_lifecycle_decisions
             WHERE node_id = ? AND source = ? AND decision = ? AND reason IS ?
               AND created_at > ?
          )`
      )
      .bind(
        ulid(),
        input.nodeId,
        input.source,
        input.decision,
        reason,
        input.nodeId,
        serializeDetail(input.detail),
        now.toISOString(),
        dedupe ? 1 : 0,
        input.nodeId,
        input.source,
        input.decision,
        reason,
        new Date(now.getTime() - (input.dedupeWindowMs ?? 0)).toISOString()
      )
      .run();
    return (result.meta.changes ?? 0) > 0;
  } catch (error) {
    log.warn('node_lifecycle_decision.write_failed', {
      nodeId: input.nodeId,
      source: input.source,
      decision: input.decision,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function parseDetail(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

interface DecisionDbRow {
  id: string;
  node_id: string;
  source: string;
  decision: string;
  reason: string | null;
  workspace_count: number | null;
  detail_json: string | null;
  created_at: string;
}

/** Newest first. */
export async function listNodeLifecycleDecisions(
  db: D1Database,
  nodeId: string,
  limit: number = DEFAULT_NODE_DECISION_LIST_LIMIT
): Promise<NodeLifecycleDecisionRow[]> {
  const bounded = Math.max(1, Math.min(MAX_NODE_DECISION_LIST_LIMIT, Math.floor(limit)));
  const rows = await db
    .prepare(
      `SELECT id, node_id, source, decision, reason, workspace_count, detail_json, created_at
         FROM node_lifecycle_decisions
        WHERE node_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`
    )
    .bind(nodeId, bounded)
    .all<DecisionDbRow>();
  return rows.results.map((row) => ({
    id: row.id,
    nodeId: row.node_id,
    source: row.source,
    decision: row.decision,
    reason: row.reason,
    workspaceCount: row.workspace_count,
    detail: parseDetail(row.detail_json),
    createdAt: row.created_at,
  }));
}

/** Deletes one bounded batch of rows older than the retention window. */
export async function purgeNodeLifecycleDecisions(
  db: D1Database,
  retentionDays: number,
  now: Date = new Date(),
  batchLimit: number = DEFAULT_NODE_DECISION_PURGE_BATCH
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = await db
    .prepare(
      `DELETE FROM node_lifecycle_decisions
        WHERE id IN (
          SELECT id FROM node_lifecycle_decisions WHERE created_at < ? ORDER BY created_at LIMIT ?
        )`
    )
    .bind(cutoff, batchLimit)
    .run();
  return result.meta.changes ?? 0;
}
