/**
 * Knowledge Graph — entity, observation, and relation CRUD + FTS5 search.
 */
import type { KnowledgeEntityType, KnowledgeRelationType, KnowledgeSourceType } from '@simple-agent-manager/shared';
import { KNOWLEDGE_DEFAULTS } from '@simple-agent-manager/shared';

import { buildSafeFtsQuery } from '../../lib/fts5';
import { createModuleLogger } from '../../lib/logger';
import {
  parseCountCnt,
  parseKnowledgeEntityIndexRow,
  parseKnowledgeEntityRow,
  parseKnowledgeObservationRow,
  parseKnowledgeObservationSearchRow,
  parseKnowledgeRelationRow,
} from './row-schemas';
import type { Env } from './types';
import { generateId } from './types';

const log = createModuleLogger('project_data.knowledge');

/**
 * Recency scale of the relevance score. At this age the recency factor is 0.5; at 3x
 * it is 0.25.
 *
 * Shared by BOTH scoring paths — `getRelevantKnowledge` (JS, over FTS hits) and
 * `getAllHighConfidenceKnowledge` (SQL, inside a window function).
 *
 * The SQL copy is a deliberate performance trade-off, not a language constraint: this DO's
 * SqlStorage is in-process, so injection COULD fetch every matching row and rank in JS
 * using this function alone. It does not, because that would pull the full filtered set
 * (up to maxEntitiesPerProject x maxObservationsPerEntity) into JS on a path that runs at
 * every session start, purely to discard most of it. Ranking and capping in SQL keeps the
 * transfer proportional to what is actually injected.
 *
 * Because this constant is bound INTO the query as a parameter, the two paths cannot drift
 * on the scale value; only the shape of the arithmetic could diverge, which is what the
 * parity test in tests/workers/knowledge-injection-ranking.test.ts pins down.
 */
export const RELEVANCE_RECENCY_SCALE_MS = 86_400_000 * 30;

/**
 * Relevance of one observation: confidence scaled by hyperbolic decay on how recently
 * it was last confirmed.
 *
 *     score = confidence x 1 / (1 + ageMs / RELEVANCE_RECENCY_SCALE_MS)
 *
 * Canonical JS definition. The SQL in `getAllHighConfidenceKnowledge` mirrors this
 * expression; a parity test pins the two together.
 */
export function computeRelevanceScore(
  confidence: number,
  lastConfirmedAtMs: number,
  nowMs: number,
  scaleMs: number = RELEVANCE_RECENCY_SCALE_MS,
): number {
  const ageMs = Math.max(0, nowMs - lastConfirmedAtMs);
  return confidence * (1 / (1 + ageMs / scaleMs));
}

/**
 * Floor a caller-supplied row limit to a value that can actually return rows.
 *
 * Every limit in this module lands in a SQL predicate (`LIMIT ?`, `WHERE entity_rank <= ?`),
 * and SQLite answers a non-positive bound by quietly doing the wrong thing rather than by
 * erroring — in two opposite directions:
 *
 *   - `WHERE entity_rank <= 0` (or negative) is unsatisfiable for every row, because
 *     ROW_NUMBER() starts at 1. Result: ZERO knowledge injected, project-wide, silently.
 *   - `LIMIT -1` means "no upper bound" in SQLite, so a negative outer limit does not fail
 *     safe — it removes the budget entirely.
 *
 * A single mistyped env var could therefore reproduce the total, invisible knowledge
 * starvation this module was just rewritten to end, or blow the payload budget open. The
 * `parseInt(...) || DEFAULT` idiom at the call site rescues `0` and `NaN` (both falsy) but
 * NOT `-1`, which is truthy and sails straight through.
 *
 * `NaN` still needs its own check here: `Math.max(1, NaN)` is `NaN`, not `1`.
 *
 * Clamped at the DO boundary rather than at the caller so the guarantee holds for every
 * caller, present and future — the callers are the part that can be wrong (rule 51).
 */
function clampRowLimit(limit: number, fallback: number): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.floor(limit));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getMaxEntities(env: Env): number {
  return Number(env.KNOWLEDGE_MAX_ENTITIES_PER_PROJECT) || KNOWLEDGE_DEFAULTS.maxEntitiesPerProject;
}

function getMaxObservations(env: Env): number {
  return Number(env.KNOWLEDGE_MAX_OBSERVATIONS_PER_ENTITY) || KNOWLEDGE_DEFAULTS.maxObservationsPerEntity;
}

// ─── Entity CRUD ────────────────────────────────────────────────────────────

export function createEntity(
  sql: SqlStorage,
  env: Env,
  name: string,
  entityType: KnowledgeEntityType,
  description: string | null,
): { id: string; now: number } {
  const count = parseCountCnt(
    sql.exec('SELECT COUNT(*) as cnt FROM knowledge_entities').toArray()[0],
    'knowledge_entity_count',
  );
  if (count >= getMaxEntities(env)) {
    throw new Error(`Maximum entities per project (${getMaxEntities(env)}) reached`);
  }

  const id = generateId();
  const now = Date.now();
  sql.exec(
    `INSERT INTO knowledge_entities (id, name, entity_type, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id, name, entityType, description, now, now,
  );
  return { id, now };
}

export function getEntity(sql: SqlStorage, entityId: string) {
  const rows = sql.exec(
    `SELECT e.*, COALESCE(obs_count.cnt, 0) as observation_count
     FROM knowledge_entities e
     LEFT JOIN (
       SELECT entity_id, COUNT(*) as cnt FROM knowledge_observations WHERE is_active = 1 GROUP BY entity_id
     ) obs_count ON obs_count.entity_id = e.id
     WHERE e.id = ?`,
    entityId,
  ).toArray();
  if (rows.length === 0) return null;
  return parseKnowledgeEntityRow(rows[0]);
}

export function getEntityByName(sql: SqlStorage, name: string) {
  const rows = sql.exec(
    `SELECT e.*, COALESCE(obs_count.cnt, 0) as observation_count
     FROM knowledge_entities e
     LEFT JOIN (
       SELECT entity_id, COUNT(*) as cnt FROM knowledge_observations WHERE is_active = 1 GROUP BY entity_id
     ) obs_count ON obs_count.entity_id = e.id
     WHERE LOWER(e.name) = LOWER(?)`,
    name,
  ).toArray();
  if (rows.length === 0) return null;
  return parseKnowledgeEntityRow(rows[0]);
}

export function listEntities(
  sql: SqlStorage,
  entityType: string | null,
  limit: number,
  offset: number,
) {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (entityType) {
    conditions.push('e.entity_type = ?');
    params.push(entityType);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = sql.exec(
    `SELECT COUNT(*) as cnt FROM knowledge_entities e ${where}`,
    ...params,
  ).toArray()[0];
  const total = parseCountCnt(countRow, 'knowledge_entity_list_count');

  const entities = sql.exec(
    `SELECT e.*, COALESCE(obs_count.cnt, 0) as observation_count
     FROM knowledge_entities e
     LEFT JOIN (
       SELECT entity_id, COUNT(*) as cnt FROM knowledge_observations WHERE is_active = 1 GROUP BY entity_id
     ) obs_count ON obs_count.entity_id = e.id
     ${where}
     ORDER BY e.updated_at DESC
     LIMIT ? OFFSET ?`,
    ...params, limit, offset,
  ).toArray();

  return { entities: entities.map(parseKnowledgeEntityRow), total };
}

export function updateEntity(
  sql: SqlStorage,
  entityId: string,
  updates: { name?: string; entityType?: KnowledgeEntityType; description?: string | null },
) {
  const entity = getEntity(sql, entityId);
  if (!entity) throw new Error(`Entity not found: ${entityId}`);

  const now = Date.now();
  sql.exec(
    `UPDATE knowledge_entities SET name = ?, entity_type = ?, description = ?, updated_at = ? WHERE id = ?`,
    updates.name ?? entity.name,
    updates.entityType ?? entity.entityType,
    updates.description !== undefined ? updates.description : entity.description,
    now,
    entityId,
  );
  return { now };
}

export function deleteEntity(sql: SqlStorage, entityId: string) {
  // CASCADE handles observations and relations
  sql.exec('DELETE FROM knowledge_entities WHERE id = ?', entityId);
}

// ─── Observation CRUD ───────────────────────────────────────────────────────

export function addObservation(
  sql: SqlStorage,
  env: Env,
  entityId: string,
  content: string,
  confidence: number,
  sourceType: KnowledgeSourceType,
  sourceSessionId: string | null,
) {
  const entity = sql.exec('SELECT id FROM knowledge_entities WHERE id = ?', entityId).toArray()[0];
  if (!entity) throw new Error(`Entity not found: ${entityId}`);

  const obsCount = parseCountCnt(
    sql.exec('SELECT COUNT(*) as cnt FROM knowledge_observations WHERE entity_id = ? AND is_active = 1', entityId).toArray()[0],
    'knowledge_obs_count',
  );
  if (obsCount >= getMaxObservations(env)) {
    throw new Error(`Maximum observations per entity (${getMaxObservations(env)}) reached`);
  }

  const id = generateId();
  const now = Date.now();
  sql.exec(
    `INSERT INTO knowledge_observations (id, entity_id, content, confidence, source_type, source_session_id, created_at, last_confirmed_at, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    id, entityId, content, confidence, sourceType, sourceSessionId, now, now,
  );

  // Update FTS5 index
  syncObservationToFts(sql, id, content);

  // Touch entity updated_at
  sql.exec('UPDATE knowledge_entities SET updated_at = ? WHERE id = ?', now, entityId);

  return { id, now };
}

export function updateObservation(
  sql: SqlStorage,
  observationId: string,
  newContent: string,
  confidence: number | null,
) {
  // Join with entities to verify the observation belongs to a valid entity in this DO
  const rows = sql.exec(
    `SELECT o.* FROM knowledge_observations o
     JOIN knowledge_entities e ON e.id = o.entity_id
     WHERE o.id = ?`,
    observationId,
  ).toArray();
  if (rows.length === 0) throw new Error(`Observation not found: ${observationId}`);
  const old = parseKnowledgeObservationRow(rows[0]);

  // Create superseding observation
  const newId = generateId();
  const now = Date.now();
  sql.exec(
    `INSERT INTO knowledge_observations (id, entity_id, content, confidence, source_type, source_session_id, created_at, last_confirmed_at, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    newId, old.entityId, newContent, confidence ?? old.confidence, old.sourceType, old.sourceSessionId, now, now,
  );

  // Mark old as superseded
  sql.exec(
    'UPDATE knowledge_observations SET superseded_by = ?, is_active = 0 WHERE id = ?',
    newId, observationId,
  );

  // Update FTS5
  removeObservationFromFts(sql, observationId);
  syncObservationToFts(sql, newId, newContent);

  // Touch entity
  sql.exec('UPDATE knowledge_entities SET updated_at = ? WHERE id = ?', now, old.entityId);

  return { id: newId, now };
}

export function removeObservation(sql: SqlStorage, observationId: string) {
  // Join with entities to verify the observation belongs to a valid entity in this DO
  const rows = sql.exec(
    `SELECT o.entity_id FROM knowledge_observations o
     JOIN knowledge_entities e ON e.id = o.entity_id
     WHERE o.id = ?`,
    observationId,
  ).toArray();
  if (rows.length === 0) throw new Error(`Observation not found: ${observationId}`);

  sql.exec('UPDATE knowledge_observations SET is_active = 0 WHERE id = ?', observationId);
  removeObservationFromFts(sql, observationId);

  const now = Date.now();
  const entityId = (rows[0] as { entity_id: string }).entity_id;
  sql.exec('UPDATE knowledge_entities SET updated_at = ? WHERE id = ?', now, entityId);
}

export function confirmObservation(sql: SqlStorage, observationId: string) {
  const now = Date.now();
  sql.exec(
    'UPDATE knowledge_observations SET last_confirmed_at = ? WHERE id = ? AND is_active = 1',
    now, observationId,
  );
}

export function getObservationsForEntity(sql: SqlStorage, entityId: string, includeInactive = false) {
  const query = includeInactive
    ? 'SELECT * FROM knowledge_observations WHERE entity_id = ? ORDER BY last_confirmed_at DESC'
    : 'SELECT * FROM knowledge_observations WHERE entity_id = ? AND is_active = 1 ORDER BY last_confirmed_at DESC';
  const rows = sql.exec(query, entityId).toArray();
  return rows.map(parseKnowledgeObservationRow);
}

// ─── Search ─────────────────────────────────────────────────────────────────

export function searchObservations(
  sql: SqlStorage,
  query: string,
  entityType: string | null,
  minConfidence: number | null,
  limit: number,
) {
  // Try FTS5 first
  const ftsResults = searchObservationsFts(sql, query, entityType, minConfidence, limit);
  if (ftsResults.length > 0) return ftsResults;

  // Fallback to LIKE
  return searchObservationsLike(sql, query, entityType, minConfidence, limit);
}

function searchObservationsFts(
  sql: SqlStorage,
  query: string,
  entityType: string | null,
  minConfidence: number | null,
  limit: number,
) {
  try {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];

    const conditions: string[] = ['o.is_active = 1'];
    const params: (string | number)[] = [ftsQuery];

    if (entityType) {
      conditions.push('e.entity_type = ?');
      params.push(entityType);
    }
    if (minConfidence != null) {
      conditions.push('o.confidence >= ?');
      params.push(minConfidence);
    }

    const where = conditions.join(' AND ');
    const rows = sql.exec(
      `SELECT o.*, e.name as entity_name, e.entity_type
       FROM knowledge_observations_fts f
       JOIN knowledge_observations o ON o.rowid = f.rowid
       JOIN knowledge_entities e ON e.id = o.entity_id
       WHERE f.knowledge_observations_fts MATCH ? AND ${where}
       ORDER BY rank
       LIMIT ?`,
      ...params, limit,
    ).toArray();

    return rows.map(parseKnowledgeObservationSearchRow);
  } catch {
    return [];
  }
}

function searchObservationsLike(
  sql: SqlStorage,
  query: string,
  entityType: string | null,
  minConfidence: number | null,
  limit: number,
) {
  const conditions: string[] = ['o.is_active = 1', 'o.content LIKE ?'];
  const params: (string | number)[] = [`%${query}%`];

  if (entityType) {
    conditions.push('e.entity_type = ?');
    params.push(entityType);
  }
  if (minConfidence != null) {
    conditions.push('o.confidence >= ?');
    params.push(minConfidence);
  }

  const where = conditions.join(' AND ');
  const rows = sql.exec(
    `SELECT o.*, e.name as entity_name, e.entity_type
     FROM knowledge_observations o
     JOIN knowledge_entities e ON e.id = o.entity_id
     WHERE ${where}
     ORDER BY o.last_confirmed_at DESC
     LIMIT ?`,
    ...params, limit,
  ).toArray();

  return rows.map(parseKnowledgeObservationSearchRow);
}

export function getRelevantKnowledge(sql: SqlStorage, context: string, limit: number) {
  // FTS5 search with confidence × recency weighting
  const ftsResults = searchObservationsFts(sql, context, null, null, limit * 2);
  if (ftsResults.length > 0) {
    // Sort by confidence * recency
    const now = Date.now();
    return ftsResults
      .map((r) => ({
        ...r,
        score: computeRelevanceScore(r.confidence, r.lastConfirmedAt, now),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // Fallback: return most recent high-confidence observations
  const rows = sql.exec(
    `SELECT o.*, e.name as entity_name, e.entity_type
     FROM knowledge_observations o
     JOIN knowledge_entities e ON e.id = o.entity_id
     WHERE o.is_active = 1 AND o.confidence >= 0.5
     ORDER BY o.last_confirmed_at DESC
     LIMIT ?`,
    limit,
  ).toArray();

  return rows.map(parseKnowledgeObservationSearchRow);
}

/**
 * Get active observations with confidence >= threshold for session-start
 * knowledge injection, ranked by relevance and capped per entity.
 *
 * Ranking replaces the previous `ORDER BY e.name` (alphabetical), which silently
 * made injection a function of entity spelling: in production all 50 slots went to
 * AccountMap..AgentReliability, 46 of them to the `AgentBehavior` grab-bag, while
 * entities the agent is explicitly told to consult (ContentStyle, User, Architecture,
 * BusinessStrategy) never appeared at all.
 *
 * The scoring expression below mirrors `computeRelevanceScore`, the canonical JS
 * definition also used by `getRelevantKnowledge`, so injection and retrieval rank
 * knowledge the same way. It is mirrored in SQL so the ranking and the per-entity cap can
 * happen inside the query rather than by pulling every candidate row into JS (see the note
 * on RELEVANCE_RECENCY_SCALE_MS); a parity test asserts the two agree, so a change to one
 * that is not mirrored in the other fails CI.
 *
 *     score = confidence x 1 / (1 + ageDays / 30)
 *
 * Hyperbolic decay on the recency of the LAST CONFIRMATION (not creation), scaled
 * linearly by confidence. A freshly confirmed observation keeps its full confidence
 * as its score; at 30 days it is halved; at 90 days quartered. Confirming an
 * observation (`confirm_knowledge`) restores its rank, which is what makes the
 * confirm/prune loop meaningful.
 *
 * `now` is a bound parameter rather than SQLite's `strftime('now')` so a given
 * (data, now) pair always produces the same ordering — required by the determinism
 * test and by anything that diffs injected payloads.
 *
 * `perEntityLimit` caps each entity's contribution so one sprawling entity cannot
 * crowd out every other topic. Ties are broken twice (last_confirmed_at, then id) to
 * give a total order; without that, equal-scoring rows could permute between calls.
 */
export function getAllHighConfidenceKnowledge(
  sql: SqlStorage,
  minConfidence: number,
  limit: number,
  perEntityLimit: number = KNOWLEDGE_DEFAULTS.autoRetrievePerEntityLimit,
  now: number = Date.now(),
) {
  // Both bounds reach SQL predicates where a non-positive value silently empties or
  // unbounds the result rather than erroring. See clampRowLimit.
  const safePerEntityLimit = clampRowLimit(
    perEntityLimit,
    KNOWLEDGE_DEFAULTS.autoRetrievePerEntityLimit,
  );
  const safeLimit = clampRowLimit(limit, KNOWLEDGE_DEFAULTS.autoRetrieveHighConfidenceLimit);
  const rows = sql.exec(
    `WITH scored AS (
       SELECT o.*, e.name AS entity_name, e.entity_type,
              -- The "* 1.0" pins REAL division. In practice the numerator is already REAL
              -- because SqlStorage binds JS numbers as doubles, so "now" arrives as REAL --
              -- but that is a driver detail, and SQLite truncates "/" when both operands
              -- happen to be integers. Without this the decay could silently degrade into a
              -- 30-day step function where everything under a month scores as brand new.
              -- (No backticks here: the query is a JS template literal.)
              o.confidence * (1.0 / (1.0 + (MAX(0, ? - o.last_confirmed_at) * 1.0 / ?))) AS relevance_score
       FROM knowledge_observations o
       JOIN knowledge_entities e ON e.id = o.entity_id
       WHERE o.is_active = 1 AND o.confidence >= ?
     ),
     ranked AS (
       SELECT scored.*,
              ROW_NUMBER() OVER (
                PARTITION BY entity_id
                ORDER BY relevance_score DESC, last_confirmed_at DESC, id ASC
              ) AS entity_rank
       FROM scored
     )
     SELECT * FROM ranked
     WHERE entity_rank <= ?
     ORDER BY relevance_score DESC, last_confirmed_at DESC, id ASC
     LIMIT ?`,
    now, RELEVANCE_RECENCY_SCALE_MS, minConfidence, safePerEntityLimit, safeLimit,
  ).toArray();

  // Per-row isolation (rule 50). A bare rows.map() throws on the FIRST malformed row and
  // discards the entire ranked block for the session. That matters more here than
  // anywhere else in this file: ranking deliberately surfaces entities that alphabetical
  // truncation had starved for months, which are exactly the oldest, least-touched rows
  // and so the likeliest to predate a schema tightening. Losing all injected knowledge
  // because one legacy row is malformed is the failure this whole change exists to end.
  const observations: ReturnType<typeof parseKnowledgeObservationSearchRow>[] = [];
  for (const row of rows) {
    try {
      observations.push(parseKnowledgeObservationSearchRow(row));
    } catch (err) {
      log.warn('knowledge.high_confidence_row_skipped', {
        observationId: typeof row.id === 'string' ? row.id : null,
        entityName: typeof row.entity_name === 'string' ? row.entity_name : null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return observations;
}

export interface KnowledgeEntityIndexEntry {
  name: string;
  entityType: string;
  observationCount: number;
}

export interface KnowledgeEntityIndex {
  entries: KnowledgeEntityIndexEntry[];
  /**
   * Entities with at least one active observation, BEFORE `limit` is applied. When
   * this exceeds `entries.length` the index itself is truncated and callers must not
   * describe it as complete.
   */
  totalEntities: number;
}

/**
 * List entities that have at least one active observation, with their active
 * observation counts, plus the true total.
 *
 * This backs the injected entity index. Ranked+capped injection is necessarily
 * partial, and the previous alphabetical truncation was *silent* — an agent had no
 * way to learn that ContentStyle or Architecture existed at all. The index makes the
 * store discoverable at roughly a token per entity, so `search_knowledge` /
 * `get_relevant_knowledge` become usable instead of guesses.
 *
 * `totalEntities` is returned separately and deliberately. A project may hold up to
 * `maxEntitiesPerProject` (500) entities while the index caps at `entityIndexLimit`
 * (200), so the index can truncate — and an index that quietly truncates while being
 * labelled "full" would recreate this exact bug one layer up. The caller uses the
 * total to say "N of M" instead of claiming completeness it cannot back.
 *
 * Counts cover all active observations, not just high-confidence ones, because that
 * is the set a follow-up search can actually reach.
 *
 * Ordered by count DESC then name ASC: a stable order that puts the densest topics
 * first, so truncation drops the thinnest entities rather than the alphabetically
 * unlucky ones — the failure mode this change exists to remove.
 */
export function getKnowledgeEntityIndex(
  sql: SqlStorage,
  limit: number = KNOWLEDGE_DEFAULTS.entityIndexLimit,
): KnowledgeEntityIndex {
  // A negative, zero, fractional, or NaN override would otherwise reach LIMIT verbatim and
  // return nothing at all — the same silent-empty failure this change exists to remove.
  const safeLimit = clampRowLimit(limit, KNOWLEDGE_DEFAULTS.entityIndexLimit);
  // `COUNT(*) OVER ()` carries the true pre-LIMIT group count on every row. SQLite
  // evaluates window functions after GROUP BY but before LIMIT, so this is the total
  // number of entities with at least one active observation — what the caller needs to
  // say "N of M" instead of labelling a truncated list "full", which would recreate this
  // bug one layer up. Folding it in here avoids a second full JOIN + GROUP BY pass over
  // the same rows on a path that runs at every session start (rule 60).
  const rows = sql.exec(
    `SELECT e.name AS name, e.entity_type AS entity_type, COUNT(o.id) AS observation_count,
            COUNT(*) OVER () AS total_entities
     FROM knowledge_entities e
     JOIN knowledge_observations o ON o.entity_id = e.id AND o.is_active = 1
     GROUP BY e.id, e.name, e.entity_type
     ORDER BY observation_count DESC, e.name ASC
     LIMIT ?`,
    safeLimit,
  ).toArray();

  // Read the total from the raw row rather than from a parsed entry: a malformed FIRST
  // row would otherwise be skipped below and take the total with it, silently downgrading
  // a truncated index to one that claims completeness.
  const rawTotal = rows[0]?.total_entities;
  const totalEntities = typeof rawTotal === 'number' ? rawTotal : rows.length;

  // Per-row isolation (rule 50): one malformed entity row must not fail the whole
  // index, which would take the agent's only discovery path down with it.
  const entries: KnowledgeEntityIndexEntry[] = [];
  for (const row of rows) {
    try {
      entries.push(parseKnowledgeEntityIndexRow(row));
    } catch (err) {
      log.warn('knowledge.entity_index_row_skipped', {
        entityName: typeof row.name === 'string' ? row.name : null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { entries, totalEntities };
}

// ─── Relations ──────────────────────────────────────────────────────────────

export function createRelation(
  sql: SqlStorage,
  sourceEntityId: string,
  targetEntityId: string,
  relationType: KnowledgeRelationType,
  description: string | null,
) {
  // Verify both entities exist
  const source = sql.exec('SELECT id FROM knowledge_entities WHERE id = ?', sourceEntityId).toArray()[0];
  if (!source) throw new Error(`Source entity not found: ${sourceEntityId}`);
  const target = sql.exec('SELECT id FROM knowledge_entities WHERE id = ?', targetEntityId).toArray()[0];
  if (!target) throw new Error(`Target entity not found: ${targetEntityId}`);

  const id = generateId();
  const now = Date.now();
  sql.exec(
    `INSERT INTO knowledge_relations (id, source_entity_id, target_entity_id, relation_type, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id, sourceEntityId, targetEntityId, relationType, description, now,
  );
  return { id, now };
}

export function getRelated(sql: SqlStorage, entityId: string, relationType: string | null) {
  const conditions: string[] = ['(r.source_entity_id = ? OR r.target_entity_id = ?)'];
  const params: (string | number)[] = [entityId, entityId];

  if (relationType) {
    conditions.push('r.relation_type = ?');
    params.push(relationType);
  }

  const where = conditions.join(' AND ');
  const rows = sql.exec(
    `SELECT r.* FROM knowledge_relations r WHERE ${where} ORDER BY r.created_at DESC`,
    ...params,
  ).toArray();

  return rows.map(parseKnowledgeRelationRow);
}

export function flagContradiction(
  sql: SqlStorage,
  env: Env,
  existingObservationId: string,
  newObservation: string,
  sourceSessionId: string | null,
) {
  const existingRows = sql.exec(
    'SELECT * FROM knowledge_observations WHERE id = ?',
    existingObservationId,
  ).toArray();
  if (existingRows.length === 0) throw new Error(`Observation not found: ${existingObservationId}`);
  const existing = parseKnowledgeObservationRow(existingRows[0]);

  // Add the new contradicting observation
  const result = addObservation(
    sql, env, existing.entityId,
    newObservation, existing.confidence * 0.8, 'inferred', sourceSessionId,
  );

  // Create a contradicts relation between the entities (self-relation for observations in the same entity)
  // We'll record it as entity metadata via a special relation
  const relationId = generateId();
  const now = Date.now();
  sql.exec(
    `INSERT INTO knowledge_relations (id, source_entity_id, target_entity_id, relation_type, description, created_at)
     VALUES (?, ?, ?, 'contradicts', ?, ?)`,
    relationId, existing.entityId, existing.entityId,
    `Observation "${existingObservationId}" contradicted by "${result.id}"`,
    now,
  );

  return { newObservationId: result.id, relationId };
}

// ─── FTS5 Helpers ───────────────────────────────────────────────────────────

function syncObservationToFts(sql: SqlStorage, observationId: string, content: string) {
  try {
    // Get the rowid
    const rows = sql.exec('SELECT rowid FROM knowledge_observations WHERE id = ?', observationId).toArray();
    if (rows.length === 0) return;
    const rowid = (rows[0] as { rowid: number }).rowid;
    sql.exec(
      `INSERT INTO knowledge_observations_fts(rowid, content) VALUES (?, ?)`,
      rowid, content,
    );
  } catch {
    // FTS5 sync is best-effort
  }
}

function removeObservationFromFts(sql: SqlStorage, observationId: string) {
  try {
    const rows = sql.exec('SELECT rowid, content FROM knowledge_observations WHERE id = ?', observationId).toArray();
    if (rows.length === 0) return;
    const row = rows[0] as { rowid: number; content: string };
    sql.exec(
      `INSERT INTO knowledge_observations_fts(knowledge_observations_fts, rowid, content) VALUES ('delete', ?, ?)`,
      row.rowid, row.content,
    );
  } catch {
    // FTS5 removal is best-effort
  }
}

function buildFtsQuery(query: string): string | null {
  return buildSafeFtsQuery(query);
}
