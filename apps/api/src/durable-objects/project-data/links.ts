import {
  isWeakLinkRelation,
  type LinkKind,
  type LinkOrigin,
  type LinkRelation,
  STRONG_LINK_RELATIONS,
  WEAK_LINK_RELATIONS,
} from '@simple-agent-manager/shared';

import { getLinkTotals, type LinkTotals } from './link-snapshot-totals';

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
  totals: LinkTotals;
}

const LINK_SELECT_SQL = `SELECT source_kind AS sourceKind,source_id AS sourceId,
  target_kind AS targetKind,target_id AS targetId,relation,origin,context,
  first_at AS firstAt,last_at AS lastAt,hit_count AS hitCount FROM resource_links`;
const STRONG_SQL = `(${STRONG_LINK_RELATIONS.map((relation) => "'" + relation + "'").join(',')})`;

function asLinks(rows: Record<string, SqlStorageValue>[]): ResourceLink[] {
  return rows as unknown as ResourceLink[];
}

function assertSessionEndpointsExist(sql: SqlStorage, input: LinkWrite): void {
  if (
    input.sourceKind === 'session' &&
    !sql.exec('SELECT id FROM chat_sessions WHERE id=?', input.sourceId).toArray()[0]
  )
    throw new Error('Session not found');
  if (
    input.targetKind === 'session' &&
    !sql.exec('SELECT id FROM chat_sessions WHERE id=?', input.targetId).toArray()[0]
  )
    throw new Error('Session not found');
}

function insertLinkRow(
  sql: SqlStorage,
  input: LinkWrite,
  limits: LinkLimits,
  databaseSize: number,
  now: number,
  weak: boolean
): Record<string, SqlStorageValue>[] {
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
  if (weak) {
    return sql
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
      .toArray();
  }
  const touchInterval = input.origin === 'auto' ? limits.touchIntervalMs : 0;
  return sql
    .exec(
      `${LINK_INSERT_PREFIX_SQL} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)
    ${LINK_UPSERT_SQL}`,
      ...values,
      touchInterval
    )
    .toArray();
}

function linkExists(sql: SqlStorage, input: LinkWrite): boolean {
  return !!sql
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
}

function trimWeakLinks(sql: SqlStorage, input: LinkWrite, limits: LinkLimits): void {
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

export function recordLink(
  sql: SqlStorage,
  input: LinkWrite,
  limits: LinkLimits,
  databaseSize: number,
  now = Date.now()
): 'written' | 'skipped_cap' | 'skipped_storage' {
  assertSessionEndpointsExist(sql, input);
  const weak = input.origin === 'auto' && isWeakLinkRelation(input.relation);
  const result = insertLinkRow(sql, input, limits, databaseSize, now, weak);
  if (weak && !result.length && !linkExists(sql, input))
    return databaseSize >= limits.storageHighWaterBytes ? 'skipped_storage' : 'skipped_cap';
  if (weak && Number(result[0]?.['hitCount']) === 1) trimWeakLinks(sql, input, limits);
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

/** A file or pull request an idea owns, found through a batched list-page read. */
export interface IdeaAssetLink {
  ideaId: string;
  /** `file` carries a project file id; `pr` carries the pull request URL. */
  targetKind: 'file' | 'pr';
  targetId: string;
  lastAt: number;
}

/**
 * The files and pull requests each of `ideaIds` owns, in one query.
 *
 * "Owns" is the program's strength rule: an idea's own explicit links, plus the links of the
 * sessions strongly linked to it. A session that merely read or discussed an idea never pulls
 * its files or pull requests in, which is why the session join filters on the strong
 * relations rather than on any link at all.
 *
 * Rows are distinct per idea and target, so a file two sessions both uploaded counts once,
 * and the per-idea cap applies to distinct targets rather than to raw link rows. A group that
 * reaches the cap is a lower bound, and the caller discloses that rather than rounding it off
 * (rule 65).
 */
export function listIdeaAssetLinksForTargets(
  sql: SqlStorage,
  ideaIds: string[],
  perTargetCap: number,
  maxTargets: number
): IdeaAssetLink[] {
  if (ideaIds.length > maxTargets) throw new Error('Too many target ids');
  if (!ideaIds.length) return [];
  const cap = Math.max(1, Math.floor(perTargetCap));
  return sql
    .exec(
      `WITH targets(id) AS (SELECT value FROM json_each(?)),
    strong AS (
      SELECT l.target_id AS idea_id, l.source_id AS session_id FROM resource_links l
      JOIN targets t ON t.id = l.target_id
      WHERE l.source_kind='session' AND l.target_kind='idea' AND l.relation IN ${STRONG_SQL}
    ),
    assets AS (
      SELECT t.id AS idea_id, l.target_kind, l.target_id, l.last_at FROM resource_links l
      JOIN targets t ON t.id = l.source_id
      WHERE l.source_kind='idea' AND l.target_kind IN ('file','pr')
      UNION ALL
      SELECT s.idea_id, l.target_kind, l.target_id, l.last_at FROM resource_links l
      JOIN strong s ON s.session_id = l.source_id
      WHERE l.source_kind='session' AND l.target_kind IN ('file','pr')
    ),
    distinctAssets AS (
      SELECT idea_id, target_kind, target_id, MAX(last_at) AS last_at FROM assets
      GROUP BY idea_id, target_kind, target_id
    )
    SELECT idea_id AS ideaId, target_kind AS targetKind, target_id AS targetId,
      last_at AS lastAt FROM (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY idea_id, target_kind ORDER BY last_at DESC, target_id DESC) AS rowNumber
      FROM distinctAssets
    ) WHERE rowNumber<=? ORDER BY ideaId, targetKind, rowNumber`,
      JSON.stringify(ideaIds),
      cap
    )
    .toArray() as unknown as IdeaAssetLink[];
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
      ),
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
    kind === 'idea' || kind === 'file'
      ? direct
          .filter(
            (link) =>
              link.targetKind === kind &&
              link.targetId === id &&
              link.sourceKind === 'session' &&
              !isWeakLinkRelation(link.relation)
          )
          .map((link) => link.sourceId)
      : [];
  const sessionIds = [...new Set(strongSessionIds)];
  const indirect: ResourceLink[] = [];
  const peerKinds: LinkKind[] = [];
  if (kind === 'idea') peerKinds.push('file', 'pr');
  if (kind === 'file') peerKinds.push('idea');
  for (const peerKind of peerKinds) {
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
  const totals = getLinkTotals(sql, kind, id);
  return { exists, links, sessions, totals };
}
