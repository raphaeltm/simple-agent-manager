import { log } from '../../lib/logger';

/** Additive link ledger. Existing idea links remain for historical audit only. */
export function migrateResourceLinks(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS resource_links (
    id TEXT PRIMARY KEY,
    source_kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('auto','explicit')),
    actor_kind TEXT,
    actor_id TEXT,
    context TEXT,
    first_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    hit_count INTEGER NOT NULL DEFAULT 1,
    UNIQUE(source_kind,source_id,target_kind,target_id,relation)
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_resource_links_source
    ON resource_links(source_kind,source_id,last_at DESC)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_resource_links_target
    ON resource_links(target_kind,target_id,last_at DESC)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_resource_links_weak_target
    ON resource_links(target_kind,target_id,origin,relation,last_at DESC,id DESC)`);

  // A damaged legacy row must not prevent every later RPC from opening the object.
  for (const row of sql
    .exec('SELECT session_id,task_id,context,created_at FROM chat_session_ideas')
    .toArray()) {
    try {
      const sessionId = String(row['session_id'] ?? '');
      const ideaId = String(row['task_id'] ?? '');
      const at = Number(row['created_at']);
      if (!sessionId || !ideaId || !Number.isFinite(at)) throw new Error('invalid legacy link');
      const relation = row['context'] === 'Executed from idea detail page' ? 'works_on' : 'linked';
      sql.exec(
        `INSERT OR IGNORE INTO resource_links
        (id,source_kind,source_id,target_kind,target_id,relation,origin,context,first_at,last_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        `legacy:${sessionId}:${ideaId}`,
        'session',
        sessionId,
        'idea',
        ideaId,
        relation,
        'explicit',
        row['context'] == null ? null : String(row['context']),
        at,
        at
      );
    } catch (error) {
      log.warn('resource_links.backfill_row_skipped', {
        sessionId: String(row['session_id'] ?? ''),
        ideaId: String(row['task_id'] ?? ''),
        error: String(error),
      });
    }
  }

  // A single-row counter keeps the weak-link project cap independent of table size.
  // Install triggers after backfill so rerunning this migration cannot double-count rows.
  sql.exec(`CREATE TABLE IF NOT EXISTS resource_link_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    link_count INTEGER NOT NULL
  )`);
  sql.exec(`INSERT OR IGNORE INTO resource_link_meta(id,link_count)
    SELECT 1,COUNT(*) FROM resource_links`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS resource_links_count_insert
    AFTER INSERT ON resource_links BEGIN
      UPDATE resource_link_meta SET link_count=link_count+1 WHERE id=1;
    END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS resource_links_count_delete
    AFTER DELETE ON resource_links BEGIN
      UPDATE resource_link_meta SET link_count=link_count-1 WHERE id=1;
    END`);
}
