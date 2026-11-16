/** Bounded compatibility sealing for a project-wide legacy WebSocket observer. */
import {
  DEFAULT_MESSAGE_MERGE_CONFIG,
  type MessageMergeConfig,
  sealMessageStream,
} from './message-stream-ingest';

const KEY = 'chatCompatibilitySeal';
interface CompatibilitySeal {
  cursor: number;
  ceiling: number;
  expiresAt: number;
}
export function readCompatibilitySeal(sql: SqlStorage): CompatibilitySeal | null {
  const value = sql.exec('SELECT value FROM do_meta WHERE key = ?', KEY).toArray()[0]?.value;
  if (typeof value !== 'string') return null;
  let state: unknown;
  try {
    state = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof state !== 'object' || state === null) return null;
  const { cursor, ceiling, expiresAt } = state as Record<string, unknown>;
  return typeof cursor === 'number' &&
    Number.isSafeInteger(cursor) &&
    cursor >= 0 &&
    typeof ceiling === 'number' &&
    Number.isSafeInteger(ceiling) &&
    ceiling >= cursor &&
    typeof expiresAt === 'number' &&
    Number.isSafeInteger(expiresAt) &&
    expiresAt > 0
    ? { cursor, ceiling, expiresAt }
    : null;
}
export function finishCompatibilitySeal(sql: SqlStorage): void {
  sql.exec('DELETE FROM do_meta WHERE key = ?', KEY);
}

/** Raw rows, including closed sessions, consume the examination budget. Progress survives503
 * and eviction. While this fence is live, ingest disables merging using its constructor-restored
 * local cache, without an extra read/write per batch. Newly created rows cannot open streams.
 * The caller accepts the legacy socket and removes this fence in the same ingest mutex.
 */
export function sealMessageStreamsBounded(
  sql: SqlStorage,
  config: Pick<
    MessageMergeConfig,
    'bookkeepingFlushBatchSize' | 'bookkeepingSealLeaseMs' | 'bookkeepingSealMaxSessions'
  >,
  now = Date.now()
): { complete: boolean; expiresAt: number } {
  const saved = readCompatibilitySeal(sql);
  const state: CompatibilitySeal =
    saved && saved.expiresAt > now
      ? saved
      : {
          cursor: 0,
          ceiling: Number(
            sql.exec('SELECT COALESCE(MAX(rowid),0) AS last FROM chat_sessions').one().last
          ),
          expiresAt:
            now +
            (config.bookkeepingSealLeaseMs ?? DEFAULT_MESSAGE_MERGE_CONFIG.bookkeepingSealLeaseMs),
        };
  const maximum =
    config.bookkeepingSealMaxSessions ?? DEFAULT_MESSAGE_MERGE_CONFIG.bookkeepingSealMaxSessions;
  const pageSize =
    config.bookkeepingFlushBatchSize ?? DEFAULT_MESSAGE_MERGE_CONFIG.bookkeepingFlushBatchSize;
  let examined = 0;
  while (examined < maximum && state.cursor < state.ceiling) {
    const rows = sql
      .exec(
        `SELECT rowid AS seal_cursor, id, json_extract(stream_ingest_state, '$.open') AS open
       FROM chat_sessions WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?`,
        state.cursor,
        state.ceiling,
        Math.min(pageSize, maximum - examined)
      )
      .toArray();
    if (rows.length === 0) {
      state.cursor = state.ceiling;
      break;
    }
    for (const row of rows) {
      if (row.open !== null) sealMessageStream(sql, String(row.id));
      state.cursor = Number(row.seal_cursor);
      examined++;
    }
  }
  sql.exec(
    'INSERT INTO do_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    KEY,
    JSON.stringify(state)
  );
  return { complete: state.cursor >= state.ceiling, expiresAt: state.expiresAt };
}
