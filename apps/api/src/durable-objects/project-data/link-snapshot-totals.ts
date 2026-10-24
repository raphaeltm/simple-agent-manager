import { STRONG_LINK_RELATIONS, type LinkKind } from '@simple-agent-manager/shared';

const STRONG_SQL = `(${STRONG_LINK_RELATIONS.map((relation) => "'" + relation + "'").join(',')})`;

export interface LinkTotals {
  sessions: number;
  strongSessions: number;
  ideas: number;
  files: number;
  prs: number;
}

/** Exact counts are kept separate from the capped snapshot query. */
export function getLinkTotals(sql: SqlStorage, kind: LinkKind, id: string): LinkTotals {
  const count = (query: string, ...params: string[]) =>
    Number(sql.exec(query, ...params).toArray()[0]?.['count'] ?? 0);
  if (kind === 'idea') {
    return {
      sessions: count(
        `SELECT COUNT(DISTINCT source_id) AS count FROM resource_links
      WHERE source_kind='session' AND target_kind='idea' AND target_id=?`,
        id
      ),
      strongSessions: count(
        `SELECT COUNT(DISTINCT source_id) AS count FROM resource_links
      WHERE source_kind='session' AND target_kind='idea' AND target_id=?
      AND relation IN ${STRONG_SQL}`,
        id
      ),
      files: count(
        `SELECT COUNT(DISTINCT target_id) AS count FROM resource_links WHERE target_kind='file'
      AND (source_kind='idea' AND source_id=? OR source_kind='session' AND source_id IN
      (SELECT source_id FROM resource_links WHERE source_kind='session' AND target_kind='idea'
      AND target_id=? AND relation IN ${STRONG_SQL}))`,
        id,
        id
      ),
      prs: count(
        `SELECT COUNT(DISTINCT target_id) AS count FROM resource_links WHERE target_kind='pr'
      AND (source_kind='idea' AND source_id=? OR source_kind='session' AND source_id IN
      (SELECT source_id FROM resource_links WHERE source_kind='session' AND target_kind='idea'
      AND target_id=? AND relation IN ${STRONG_SQL}))`,
        id,
        id
      ),
      ideas: count(
        `SELECT COUNT(DISTINCT CASE WHEN source_id=? THEN target_id ELSE source_id END)
      AS count FROM resource_links WHERE source_kind='idea' AND target_kind='idea'
      AND relation='related' AND (source_id=? OR target_id=?)`,
        id,
        id,
        id
      ),
    };
  }
  if (kind === 'file') {
    return {
      sessions: count(
        `SELECT COUNT(DISTINCT source_id) AS count FROM resource_links
      WHERE source_kind='session' AND target_kind='file' AND target_id=?`,
        id
      ),
      ideas: count(
        `SELECT COUNT(DISTINCT idea_id) AS count FROM (
      SELECT source_id AS idea_id FROM resource_links WHERE source_kind='idea'
      AND target_kind='file' AND target_id=?
      UNION SELECT target_id AS idea_id FROM resource_links WHERE source_kind='session'
      AND target_kind='idea' AND source_id IN (SELECT source_id FROM resource_links
      WHERE source_kind='session' AND target_kind='file' AND target_id=?
      AND relation IN ${STRONG_SQL}))`,
        id,
        id
      ),
      files: 0,
      prs: 0,
      strongSessions: 0,
    };
  }
  return {
    ideas: count(
      `SELECT COUNT(DISTINCT target_id) AS count FROM resource_links
      WHERE source_kind='session' AND source_id=? AND target_kind='idea'`,
      id
    ),
    files: count(
      `SELECT COUNT(DISTINCT target_id) AS count FROM resource_links
      WHERE source_kind='session' AND source_id=? AND target_kind='file'`,
      id
    ),
    prs: count(
      `SELECT COUNT(DISTINCT target_id) AS count FROM resource_links
      WHERE source_kind='session' AND source_id=? AND target_kind='pr'`,
      id
    ),
    sessions: 0,
    strongSessions: 0,
  };
}
