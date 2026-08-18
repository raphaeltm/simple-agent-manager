/**
 * Per-project session list served from the D1 `session_summaries` index instead
 * of a ProjectData Durable Object round-trip.
 *
 * The chat sidebar reloads this list on mount, on every WebSocket reconnect, on
 * two poll timers and on six event-driven refetches — so it was one of the
 * hottest DO callers in the product.
 *
 * What this actually saves is NOT round trips. The DO's count and page queries
 * are in-process SQLite, so the DO path is one network hop where this path is
 * two (coverage, then count+page in parallel). The win is that it avoids waking
 * a single-threaded Durable Object on every poll, avoids the N+1
 * attention-marker lookup the DO runs per row, and lets a hot project's sidebar
 * reads scale across D1 instead of queueing behind one object.
 *
 * The DO remains authoritative. This index may only answer a read it can PROVE
 * is equivalent, which is what `session_index_coverage` is for: it records
 * whether every session was indexed, and when. Anything missing, incomplete or
 * stale reports a miss and the caller falls back to the DO. Fail closed on
 * correctness — a wrong sidebar is worse than a slow one — but fail OPEN on
 * availability (see `listSessionsFromIndex`).
 */
import { DEFAULT_SESSION_INDEX_MAX_STALENESS_MS } from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';

const log = createModuleLogger('session_summary_index');

/** Why a read could not be served from D1 — surfaced for observability. */
export type SessionIndexMissReason =
  | 'no_coverage'
  | 'incomplete_coverage'
  | 'stale_coverage'
  | 'index_error';

export interface SessionIndexResult {
  sessions: Record<string, unknown>[];
  total: number;
  hasMore: boolean;
}

export interface SessionIndexQuery {
  projectId: string;
  status: string | null;
  limit: number;
  offset: number;
  /** Restricts to sessions this user created (the sidebar's `scope=my`). */
  createdByUserId: string | null;
}

export function resolveMaxStalenessMs(env: Env): number {
  const parsed = Number.parseInt(env.SESSION_INDEX_MAX_STALENESS_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_INDEX_MAX_STALENESS_MS;
}

/**
 * The attention summary the DO's `getAttentionSummary()` produces, as persisted
 * by the sync. Validated rather than cast: it is a JSON blob read back out of
 * storage, which is a runtime trust boundary (.claude/rules/51).
 */
const AttentionSummarySchema = v.object({
  markerId: v.string(),
  kind: v.string(),
  createdAt: v.number(),
  expiresAt: v.nullable(v.number()),
  reason: v.nullable(v.string()),
  options: v.array(v.string()),
});

/**
 * A `session_summaries` row, as the sidebar needs it.
 *
 * `created_by_user_id`, `created_at` and `attention_json` are nullable because
 * rows written before migration 0117 predate those columns. A row that has not
 * been re-synced yet is still usable — it just has no creator or attention
 * badge — and the coverage gate is what stops a genuinely incomplete index from
 * being served at all.
 */
const SessionSummaryRowSchema = v.object({
  id: v.string(),
  workspace_id: v.nullable(v.string()),
  task_id: v.nullable(v.string()),
  created_by_user_id: v.nullable(v.string()),
  topic: v.nullable(v.string()),
  status: v.string(),
  message_count: v.number(),
  started_at: v.number(),
  ended_at: v.nullable(v.number()),
  created_at: v.nullable(v.number()),
  updated_at: v.number(),
  agent_completed_at: v.nullable(v.number()),
  attention_json: v.nullable(v.string()),
});

/**
 * Map an index row into the exact shape the DO's `listSessions` returns.
 *
 * Two details here are load-bearing and must not be "simplified":
 *
 *  - `lastMessageAt` comes from `updated_at`, NOT from the `last_message_at`
 *    column. The DO's row mapper sets `lastMessageAt: r.updated_at`, and
 *    `session_summaries` happens to carry both, so reading the intuitively-named
 *    column would make the two paths disagree about ordering.
 *  - `cleanupAt` is always null. The DO's LIST query does not join
 *    `idle_cleanup_schedule` (only its single-session `getSession` does), so
 *    null is what the DO path returns here too.
 */
function mapIndexRow(raw: unknown, baseDomain: string | undefined): Record<string, unknown> {
  const row = v.parse(SessionSummaryRowSchema, raw);

  let attention: unknown = null;
  if (row.attention_json) {
    // A malformed blob must not cost us the row — the session still belongs in
    // the list, just without its attention badge.
    try {
      attention = v.parse(AttentionSummarySchema, JSON.parse(row.attention_json));
    } catch (err) {
      log.warn('session_index.attention_parse_skipped', {
        sessionId: row.id,
        error: String(err),
      });
    }
  }

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    createdByUserId: row.created_by_user_id,
    topic: row.topic,
    status: row.status,
    messageCount: row.message_count,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    agentCompletedAt: row.agent_completed_at,
    lastMessageAt: row.updated_at,
    isIdle: row.status === 'active' && row.agent_completed_at != null,
    isTerminated: row.status === 'stopped' || row.status === 'failed',
    workspaceUrl:
      row.workspace_id && baseDomain ? `https://ws-${row.workspace_id}.${baseDomain}` : null,
    cleanupAt: null,
    attention,
  };
}

/**
 * Read a project's sessions from the D1 index, or report a miss when the index
 * cannot prove it would give the same answer as the DO.
 *
 * Never throws. This is an OPTIONAL accelerator in front of an authoritative
 * source, so any failure — a D1 error, a missing table mid-migration, a
 * malformed coverage row — degrades to a miss and the caller falls back to the
 * DO. Letting an index problem 500 an endpoint the DO could have answered would
 * make the fast path a new availability dependency, which is exactly what it
 * must not be.
 */
export async function listSessionsFromIndex(
  env: Env,
  query: SessionIndexQuery
): Promise<{ result: SessionIndexResult } | { missReason: SessionIndexMissReason }> {
  try {
    return await readIndex(env, query);
  } catch (err) {
    log.warn('session_index.read_failed', {
      projectId: query.projectId,
      error: String(err),
    });
    return { missReason: 'index_error' };
  }
}

async function readIndex(
  env: Env,
  query: SessionIndexQuery
): Promise<{ result: SessionIndexResult } | { missReason: SessionIndexMissReason }> {
  const db = env.DATABASE;

  const coverage = await db
    .prepare(
      'SELECT synced_at, session_count, complete FROM session_index_coverage WHERE project_id = ?'
    )
    .bind(query.projectId)
    .first<{ synced_at: number; session_count: number; complete: number }>();

  if (!coverage) return { missReason: 'no_coverage' };

  // An incomplete index is missing sessions by construction, so neither the page
  // nor `total` can be trusted.
  if (coverage.complete !== 1) return { missReason: 'incomplete_coverage' };

  // Staleness backstop. Under normal operation the DO resyncs within seconds of
  // any mutation; this only trips when the sync itself has stopped working,
  // which is silent because its D1 writes are deliberately swallowed.
  if (Date.now() - coverage.synced_at > resolveMaxStalenessMs(env)) {
    return { missReason: 'stale_coverage' };
  }

  // Project scope is ALWAYS in the predicate — this is the tenant boundary, not
  // a filter. Everything else is optional.
  const conditions = ['project_id = ?'];
  const params: (string | number)[] = [query.projectId];

  if (query.status) {
    conditions.push('status = ?');
    params.push(query.status);
  }
  if (query.createdByUserId) {
    conditions.push('created_by_user_id = ?');
    params.push(query.createdByUserId);
  }

  const whereClause = conditions.join(' AND ');

  // Independent once coverage has been validated, so they go out together rather
  // than paying two sequential D1 hops.
  const [countRow, page] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) as cnt FROM session_summaries WHERE ${whereClause}`)
      .bind(...params)
      .first<{ cnt: number }>(),
    db
      .prepare(
        `SELECT id, workspace_id, task_id, created_by_user_id, topic, status, message_count,
                started_at, ended_at, created_at, updated_at, agent_completed_at, attention_json
         FROM session_summaries
         WHERE ${whereClause}
         ORDER BY updated_at DESC
         LIMIT ? OFFSET ?`
      )
      .bind(...params, query.limit, query.offset)
      .all<Record<string, unknown>>(),
  ]);

  const total = countRow?.cnt ?? 0;
  const rows = page.results ?? [];

  // Per-row isolation (.claude/rules/50): one row that fails the schema — a
  // legacy shape, a NULL where the schema wants a number — must degrade to "that
  // row is missing" and never throw the whole list into a 500.
  const sessions: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const raw of rows) {
    try {
      sessions.push(mapIndexRow(raw, env.BASE_DOMAIN));
    } catch (err) {
      skipped++;
      log.warn('session_index.row_skipped', {
        projectId: query.projectId,
        rowId: typeof raw.id === 'string' ? raw.id : null,
        error: String(err),
      });
    }
  }

  if (skipped > 0) {
    log.warn('session_index.list_degraded', {
      projectId: query.projectId,
      fetched: rows.length,
      returned: sessions.length,
      skipped,
    });
  }

  // Mirrors the DO: `rows.length` is the raw SQL-fetched count, so post-fetch
  // skips cannot make `hasMore` claim the window reached the end when it did not.
  const hasMore = query.offset + rows.length < total;

  return { result: { sessions, total, hasMore } };
}
