import {
  isWeakLinkRelation,
  type LinkKind,
  type LinkOrigin,
  type LinkRelation,
  STRONG_LINK_RELATIONS,
  WEAK_LINK_RELATIONS,
} from '@simple-agent-manager/shared';

export interface ResourceLink {
  sourceKind: LinkKind;
  sourceId: string;
  targetKind: LinkKind;
  targetId: string;
  relation: LinkRelation;
  origin: LinkOrigin;
  context: string | null;
  firstAt: number;
  lastAt: number;
  hitCount: number;
}
export interface LinkWrite extends Pick<
  ResourceLink,
  'sourceKind' | 'sourceId' | 'targetKind' | 'targetId' | 'relation' | 'origin' | 'context'
> {
  actorKind?: string | null;
  actorId?: string | null;
}
export type LinkRemove = Pick<
  LinkWrite,
  'sourceKind' | 'sourceId' | 'targetKind' | 'targetId' | 'relation'
>;
export interface LinkLimits {
  touchIntervalMs: number;
  weakPerTarget: number;
  weakCleanupBatchSize: number;
  projectCap: number;
  storageHighWaterBytes: number;
}
export interface LinkSnapshot {
  exists: boolean;
  links: ResourceLink[];
  sessions: Array<{
    id: string;
    topic: string | null;
    status: string;
    updatedAt: number;
    taskId: string | null;
  }>;
  totals: { sessions: number; strongSessions: number; ideas: number; files: number; prs: number };
}

const LINK_SELECT_SQL = `SELECT source_kind AS sourceKind,source_id AS sourceId,
  target_kind AS targetKind,target_id AS targetId,relation,origin,context,
  first_at AS firstAt,last_at AS lastAt,hit_count AS hitCount FROM resource_links`;
const STRONG_SQL = `(${STRONG_LINK_RELATIONS.map((relation) => `'${relation}'`).join(',')})`;

function asLinks(rows: Record<string, SqlStorageValue>[]): ResourceLink[] {
  return rows as unknown as ResourceLink[];
}

export function recordLink(
  sql: SqlStorage,
  input: LinkWrite,
  limits: LinkLimits,
  databaseSize: number,
  now = Date.now()
): 'written' | 'skipped_cap' | 'skipped_storage' {
  if (input.sourceKind === 'session') {
    if (!sql.exec('SELECT id FROM chat_sessions WHERE id=?', input.sourceId).toArray()[0])
      throw new Error('Session not found');
  }
  if (input.targetKind === 'session') {
    if (!sql.exec('SELECT id FROM chat_sessions WHERE id=?', input.targetId).toArray()[0])
      throw new Error('Session not found');
  }
  const weak = input.origin === 'auto' && isWeakLinkRelation(input.relation);
  const LINK_INSERT_PREFIX_SQL = `INSERT INTO resource_links
    (id,source_kind,source_id,target_kind,target_id,relation,origin,actor_kind,actor_id,
     context,first_at,last_at,hit_count)`;
  const values = [
    crypto.randomUUID(),
    input.sourceKind,
    input.sourceId,
    input.targetKind,
    input.targetId,
    input.relation,
    input.origin,
    input.actorKind ?? null,
    input.actorId ?? null,
    input.context,
    now,
    now,
  ];
  const LINK_UPSERT_SQL = `ON CONFLICT(source_kind,source_id,target_kind,target_id,relation)
    DO UPDATE SET last_at=excluded.last_at,hit_count=resource_links.hit_count+1
      WHERE resource_links.last_at < excluded.last_at - ?
    RETURNING id,hit_count AS hitCount`;
  const result = weak
    ? sql
        .exec(
          `${LINK_INSERT_PREFIX_SQL}
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,1
    WHERE EXISTS (SELECT 1 FROM resource_links WHERE source_kind=? AND source_id=?
      AND target_kind=? AND target_id=? AND relation=?)
      OR (? < ? AND (SELECT link_count FROM resource_link_meta WHERE id=1) < ?)
    ${LINK_UPSERT_SQL}`,
          ...values,
          input.sourceKind,
          input.sourceId,
          input.targetKind,
          input.targetId,
          input.relation,
          databaseSize,
          limits.storageHighWaterBytes,
          limits.projectCap,
          limits.touchIntervalMs
        )
        .toArray()
    : sql
        .exec(
          `${LINK_INSERT_PREFIX_SQL} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)
    ${LINK_UPSERT_SQL}`,
          ...values,
          input.origin === 'auto' ? limits.touchIntervalMs : 0
        )
        .toArray();
  if (weak && !result.length) {
    const exists = sql
      .exec(
        `SELECT 1 FROM resource_links WHERE source_kind=? AND source_id=?
      AND target_kind=? AND target_id=? AND relation=?`,
        input.sourceKind,
        input.sourceId,
        input.targetKind,
        input.targetId,
        input.relation
      )
      .toArray()[0];
    if (!exists)
      return databaseSize >= limits.storageHighWaterBytes ? 'skipped_storage' : 'skipped_cap';
  }
  if (weak && Number(result[0]?.['hitCount']) === 1) {
    // This bounded delete keeps only the newest N weak references to a target.
    const placeholders = WEAK_LINK_RELATIONS.map(() => '?').join(',');
    sql.exec(
      `DELETE FROM resource_links WHERE id IN (
      SELECT id FROM resource_links WHERE target_kind=? AND target_id=?
      AND origin='auto' AND relation IN (${placeholders})
      ORDER BY last_at DESC,id DESC LIMIT ? OFFSET ?
    )`,
      input.targetKind,
      input.targetId,
      ...WEAK_LINK_RELATIONS,
      limits.weakCleanupBatchSize,
      limits.weakPerTarget
    );
  }
  return 'written';
}

export function removeLink(sql: SqlStorage, input: LinkRemove): void {
  sql.exec(
    `DELETE FROM resource_links WHERE source_kind=? AND source_id=?
    AND target_kind=? AND target_id=? AND relation=? AND origin='explicit'`,
    input.sourceKind,
    input.sourceId,
    input.targetKind,
    input.targetId,
    input.relation
  );
}

export function listLinks(sql: SqlStorage, kind: LinkKind, id: string, cap = 500): ResourceLink[] {
  return asLinks(
    sql
      .exec(
        `${LINK_SELECT_SQL} WHERE
    (source_kind=? AND source_id=?) OR (target_kind=? AND target_id=?)
    ORDER BY (relation IN ${STRONG_SQL}) DESC,last_at DESC LIMIT ?`,
        kind,
        id,
        kind,
        id,
        Math.max(1, Math.floor(cap))
      )
      .toArray()
  );
}

/** Bounded session links for list pages; the caller owns display and attention composition. */
export function listLinksForTargets(
  sql: SqlStorage,
  kind: LinkKind,
  ids: string[],
  perTargetCap: number,
  maxTargets: number
): ResourceLink[] {
  if (ids.length > maxTargets) throw new Error('Too many target ids');
  if (!ids.length) return [];
  const cap = Math.max(1, Math.floor(perTargetCap));
  return asLinks(
    sql
      .exec(
        `SELECT sourceKind,sourceId,targetKind,targetId,relation,origin,context,
    firstAt,lastAt,hitCount FROM (
      SELECT source_kind AS sourceKind,source_id AS sourceId,target_kind AS targetKind,
      target_id AS targetId,relation,origin,context,first_at AS firstAt,last_at AS lastAt,
      hit_count AS hitCount,ROW_NUMBER() OVER (
        PARTITION BY target_id ORDER BY (relation IN ${STRONG_SQL}) DESC,last_at DESC,id DESC) AS rowNumber
      FROM resource_links WHERE source_kind='session' AND target_kind=?
      AND target_id IN (SELECT value FROM json_each(?))
    ) WHERE rowNumber<=? ORDER BY targetId,rowNumber`,
        kind,
        JSON.stringify(ids),
        cap
      )
      .toArray()
  );
}

/** One RPC returns direct links, strong-session edges and session display data. */
export function getLinkSnapshot(
  sql: SqlStorage,
  kind: LinkKind,
  id: string,
  cap = 50
): LinkSnapshot {
  const exists =
    kind !== 'session' || !!sql.exec('SELECT id FROM chat_sessions WHERE id=?', id).toArray()[0];
  const boundedCap = Math.max(1, Math.floor(cap));
  const direct: ResourceLink[] = [];
  for (const peerKind of ['session', 'idea', 'file', 'pr'] as const) {
    direct.push(
      ...asLinks(
        sql
          .exec(
            `${LINK_SELECT_SQL} WHERE source_kind=? AND source_id=?
      AND target_kind=? ORDER BY (relation IN ${STRONG_SQL}) DESC,last_at DESC LIMIT ?`,
            kind,
            id,
            peerKind,
            boundedCap
          )
          .toArray()
      )
    );
    direct.push(
      ...asLinks(
        sql
          .exec(
            `${LINK_SELECT_SQL} WHERE target_kind=? AND target_id=?
      AND source_kind=? ORDER BY (relation IN ${STRONG_SQL}) DESC,last_at DESC LIMIT ?`,
            kind,
            id,
            peerKind,
            boundedCap
          )
          .toArray()
      )
    );
  }
  const strongSessionIds =
    kind === 'idea'
      ? direct
          .filter(
            (l) =>
              l.targetKind === 'idea' &&
              l.targetId === id &&
              l.sourceKind === 'session' &&
              !isWeakLinkRelation(l.relation)
          )
          .map((l) => l.sourceId)
      : kind === 'file'
        ? direct
            .filter(
              (l) =>
                l.targetKind === 'file' &&
                l.targetId === id &&
                l.sourceKind === 'session' &&
                !isWeakLinkRelation(l.relation)
            )
            .map((l) => l.sourceId)
        : [];
  const sessionIds = [...new Set(strongSessionIds)];
  const indirect: ResourceLink[] = [];
  for (const peerKind of (kind === 'idea'
    ? ['file', 'pr']
    : kind === 'file'
      ? ['idea']
      : []) as LinkKind[]) {
    if (!sessionIds.length) break;
    indirect.push(
      ...asLinks(
        sql
          .exec(
            `${LINK_SELECT_SQL} WHERE source_kind='session'
      AND source_id IN (SELECT value FROM json_each(?))
      AND target_kind=? ORDER BY (relation IN ${STRONG_SQL}) DESC,last_at DESC LIMIT ?`,
            JSON.stringify(sessionIds),
            peerKind,
            boundedCap
          )
          .toArray()
      )
    );
  }
  const links = [
    ...new Map(
      [...direct, ...indirect].map((link) => [
        `${link.sourceKind}:${link.sourceId}:${link.targetKind}:${link.targetId}:${link.relation}`,
        link,
      ])
    ).values(),
  ];
  const visibleSessionIds = [
    ...new Set(
      links.flatMap((l) => [
        ...(l.sourceKind === 'session' ? [l.sourceId] : []),
        ...(l.targetKind === 'session' ? [l.targetId] : []),
      ])
    ),
  ];
  let sessions: LinkSnapshot['sessions'] = [];
  if (visibleSessionIds.length) {
    sessions = sql
      .exec(
        `SELECT id,topic,status,
      updated_at AS updatedAt,task_id AS taskId FROM chat_sessions
      WHERE id IN (SELECT value FROM json_each(?))`,
        JSON.stringify(visibleSessionIds)
      )
      .toArray() as unknown as LinkSnapshot['sessions'];
  }
  const count = (query: string, ...params: string[]) =>
    Number(sql.exec(query, ...params).toArray()[0]?.['count'] ?? 0);
  const totals =
    kind === 'idea'
      ? {
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
        }
      : kind === 'file'
        ? {
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
          }
        : {
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
  return { exists, links, sessions, totals };
}
