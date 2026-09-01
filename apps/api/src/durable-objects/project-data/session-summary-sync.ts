/**
 * Sync session metadata from DO SQLite to the D1 `session_summaries` index.
 *
 * Feeds two read surfaces:
 *  - cross-project listings (`/api/chats`, `/api/chats/recent`, command palette)
 *  - the per-project chat sidebar, which otherwise costs a ProjectData DO
 *    round-trip on every project load and every poll
 *
 * The DO stays authoritative; D1 is an eventually-consistent index. Because the
 * sidebar read must return exactly what the DO's `listSessions` would, this sync
 * also mirrors the session creator, `created_at`, and the newest unresolved
 * attention marker — the three things the sidebar renders that the original
 * cross-project index did not carry.
 *
 * Every sync writes a `session_index_coverage` row recording how many sessions
 * the project has and whether all of them were indexed. The read path refuses to
 * answer from D1 without it: an index that might be missing rows cannot produce a
 * correct `total`, and a truncated index would silently drop sessions from the
 * sidebar.
 */
import { DEFAULT_SESSION_INDEX_MAX_ROWS } from '@simple-agent-manager/shared';

import { createModuleLogger } from '../../lib/logger';
import { getAttentionSummary } from './attention';
import type { Env } from './types';

const log = createModuleLogger('session_summary_sync');

/** Chunk size for D1 batches — the platform caps a batch at 100 statements. */
const D1_BATCH_SIZE = 100;

function resolveMaxRows(env: Env): number {
  const parsed = Number.parseInt(env.SESSION_INDEX_MAX_ROWS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_INDEX_MAX_ROWS;
}

/**
 * Mirror this project's sessions into D1 and record coverage.
 *
 * Indexes the whole project (up to the configured cap) rather than a trailing
 * time window: a partial mirror cannot answer "list this project's sessions"
 * without silently omitting rows, and cannot produce a correct `total`.
 */
export async function syncSessionSummariesToD1(
  sql: SqlStorage,
  env: Env,
  projectId: string
): Promise<boolean> {
  // Look up the project owner from D1
  const projectRow = await env.DATABASE.prepare('SELECT user_id FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ user_id: string }>();
  if (!projectRow) return true;
  const userId = projectRow.user_id;

  const maxRows = resolveMaxRows(env);

  // Watermark captured BEFORE the read. Rows written while this sync runs have
  // `updated_at >= syncedAt`, so recording this (not `Date.now()` afterwards) as
  // the next delta floor means a concurrent write is picked up by the next sync
  // rather than silently skipped. Every mutation schedules a sync, so there is
  // always a next one.
  const syncedAt = Date.now();

  const countRow = sql.exec('SELECT COUNT(*) as cnt FROM chat_sessions').toArray()[0];
  const sessionCount = typeof countRow?.cnt === 'number' ? countRow.cnt : 0;

  const coverage = await env.DATABASE.prepare(
    'SELECT synced_at, complete FROM session_index_coverage WHERE project_id = ?'
  )
    .bind(projectId)
    .first<{ synced_at: number; complete: number }>();

  type Cursor = {
    cursor_mode: 'full' | 'delta';
    cursor_updated_at: number | null;
    cursor_session_id: string | null;
    high_watermark: number | null;
    started_at: number;
  };
  let cursor = await env.DATABASE.prepare(
    `SELECT cursor_mode, cursor_updated_at, cursor_session_id, high_watermark, started_at
       FROM session_index_backfill_cursors WHERE project_id = ?`
  )
    .bind(projectId)
    .first<Cursor>();

  if (!cursor && coverage?.complete !== 1) {
    await env.DATABASE.prepare(
      `INSERT INTO session_index_backfill_cursors
       (project_id, cursor_mode, cursor_updated_at, cursor_session_id, high_watermark,
        snapshot_session_count, started_at, updated_at)
       VALUES (?, 'full', NULL, NULL, NULL, ?, ?, ?)
       ON CONFLICT(project_id) DO NOTHING`
    )
      .bind(projectId, sessionCount, syncedAt, syncedAt)
      .run();
    cursor = {
      cursor_mode: 'full',
      cursor_updated_at: null,
      cursor_session_id: null,
      high_watermark: null,
      started_at: syncedAt,
    };
  }

  if (!cursor) {
    if (!coverage) throw new Error('Session index coverage/cursor state is inconsistent');
    cursor = {
      cursor_mode: 'delta',
      cursor_updated_at: coverage.synced_at,
      cursor_session_id: '',
      high_watermark: syncedAt,
      started_at: syncedAt,
    };
    await env.DATABASE.prepare(
      `INSERT INTO session_index_backfill_cursors
       (project_id, cursor_mode, cursor_updated_at, cursor_session_id, high_watermark,
        snapshot_session_count, started_at, updated_at)
       VALUES (?, 'delta', ?, '', ?, ?, ?, ?)`
    )
      .bind(projectId, coverage.synced_at, syncedAt, sessionCount, syncedAt, syncedAt)
      .run();
  }

  const isDelta = cursor.cursor_mode === 'delta';
  const candidates = isDelta
    ? sql
        .exec(
          `SELECT id, workspace_id, task_id, created_by_user_id, topic, status, message_count,
                  started_at, ended_at, created_at, updated_at, agent_completed_at,
                  COALESCE(chat_sessions.last_message_at,
                    (SELECT MAX(created_at) FROM chat_messages WHERE session_id = chat_sessions.id)) as last_message_at
           FROM chat_sessions
           WHERE (updated_at > ? OR (updated_at = ? AND id > ?))
             AND updated_at <= ?
           ORDER BY updated_at ASC, id ASC
           LIMIT ?`,
          cursor.cursor_updated_at ?? -1,
          cursor.cursor_updated_at ?? -1,
          cursor.cursor_session_id ?? '',
          cursor.high_watermark ?? syncedAt,
          maxRows + 1
        )
        .toArray()
    : sql
        .exec(
          `SELECT id, workspace_id, task_id, created_by_user_id, topic, status, message_count,
                  started_at, ended_at, created_at, updated_at, agent_completed_at,
                  COALESCE(chat_sessions.last_message_at,
                    (SELECT MAX(created_at) FROM chat_messages WHERE session_id = chat_sessions.id)) as last_message_at
           FROM chat_sessions
           WHERE created_at > ? OR (created_at = ? AND id > ?)
           ORDER BY created_at ASC, id ASC
           LIMIT ?`,
          cursor.cursor_updated_at ?? -1,
          cursor.cursor_updated_at ?? -1,
          cursor.cursor_session_id ?? '',
          maxRows + 1
        )
        .toArray();
  const hasMore = candidates.length > maxRows;
  const rows = candidates.slice(0, maxRows);

  const statements = rows.map((row) => {
    // Resolved-marker semantics must match getAttentionSummary() exactly — it
    // returns the newest UNRESOLVED marker regardless of expiry, because expiry
    // is processed separately by the DO alarm. Re-deriving that here (e.g.
    // filtering on expires_at) would make the D1 path disagree with the DO path.
    let attentionJson: string | null = null;
    try {
      const attention = getAttentionSummary(sql, row.id as string);
      attentionJson = attention ? JSON.stringify(attention) : null;
    } catch (err) {
      // A malformed marker must not cost us the whole session row — the session
      // still belongs in the index, just without its attention badge.
      log.warn('session_summary_attention_skipped', {
        projectId,
        sessionId: row.id,
        error: String(err),
      });
    }

    return env.DATABASE.prepare(
      `INSERT INTO session_summaries
         (id, project_id, user_id, status, topic, task_id, workspace_id,
          message_count, started_at, last_message_at, agent_completed_at, ended_at, updated_at,
          created_by_user_id, created_at, attention_json, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         topic = excluded.topic,
         task_id = excluded.task_id,
         workspace_id = excluded.workspace_id,
         message_count = excluded.message_count,
         last_message_at = excluded.last_message_at,
         agent_completed_at = excluded.agent_completed_at,
         ended_at = excluded.ended_at,
         updated_at = excluded.updated_at,
         created_by_user_id = excluded.created_by_user_id,
         created_at = excluded.created_at,
         attention_json = excluded.attention_json,
         synced_at = excluded.synced_at`
    ).bind(
      row.id as string,
      projectId,
      userId,
      row.status as string,
      row.topic as string | null,
      row.task_id as string | null,
      row.workspace_id as string | null,
      row.message_count as number,
      row.started_at as number,
      (row.last_message_at as number | null) ?? null,
      row.agent_completed_at as number | null,
      row.ended_at as number | null,
      row.updated_at as number,
      (row.created_by_user_id as string | null) ?? null,
      (row.created_at as number | null) ?? null,
      attentionJson,
      syncedAt
    );
  });

  // Chunks touch disjoint row ids and each batch is independently idempotent
  // (ON CONFLICT DO UPDATE), so they can go out together. Finishing sooner also
  // narrows the window in which a concurrent sync could interleave.
  const chunks: Promise<unknown>[] = [];
  for (let i = 0; i < statements.length; i += D1_BATCH_SIZE) {
    chunks.push(env.DATABASE.batch(statements.slice(i, i + D1_BATCH_SIZE)));
  }
  await Promise.all(chunks);

  // Coverage/cursor is written LAST and only after every row landed, so a batch that
  // throws part-way leaves the previous (older but self-consistent) coverage in
  // place. The read path then keeps using the older row until it ages out, or
  // falls back to the DO — it never reads a half-written index as complete.
  const backfillComplete = !hasMore;
  if (!backfillComplete) {
    const last = rows.at(-1);
    const cursorValue = isDelta ? last?.updated_at : last?.created_at;
    if (typeof cursorValue !== 'number' || typeof last?.id !== 'string') {
      throw new Error('Session index backfill cursor row is malformed');
    }
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        `UPDATE session_index_backfill_cursors
            SET cursor_updated_at = ?, cursor_session_id = ?, updated_at = ?
          WHERE project_id = ?`
      ).bind(cursorValue, last.id, syncedAt, projectId),
      coverageStatement(
        env,
        projectId,
        isDelta ? (coverage?.synced_at ?? cursor.started_at) : cursor.started_at,
        sessionCount,
        false
      ),
    ]);
  } else {
    const completionWatermark = isDelta ? (cursor.high_watermark ?? syncedAt) : cursor.started_at;
    await env.DATABASE.batch([
      coverageStatement(env, projectId, completionWatermark, sessionCount, true),
      env.DATABASE.prepare('DELETE FROM session_index_backfill_cursors WHERE project_id = ?').bind(
        projectId
      ),
    ]);
  }

  log.info('session_summaries_synced', {
    projectId,
    count: rows.length,
    sessionCount,
    mode: isDelta ? 'delta' : 'full',
    complete: backfillComplete,
  });
  return backfillComplete;
}

function coverageStatement(
  env: Env,
  projectId: string,
  syncedAt: number,
  sessionCount: number,
  complete: boolean
): D1PreparedStatement {
  return env.DATABASE.prepare(
    `INSERT INTO session_index_coverage (project_id, synced_at, session_count, complete)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       synced_at = excluded.synced_at,
       session_count = excluded.session_count,
       complete = excluded.complete`
  ).bind(projectId, syncedAt, sessionCount, complete ? 1 : 0);
}
