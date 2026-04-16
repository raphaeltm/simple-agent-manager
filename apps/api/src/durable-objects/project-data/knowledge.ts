/**
 * Knowledge Graph — entity, observation, and relation CRUD + FTS5 search.
 */
import type { KnowledgeEntityType, KnowledgeRelationType, KnowledgeSourceType } from '@simple-agent-manager/shared';
import { KNOWLEDGE_DEFAULTS } from '@simple-agent-manager/shared';

import {
  parseCountCnt,
  parseKnowledgeEntityRow,
  parseKnowledgeObservationRow,
  parseKnowledgeObservationSearchRow,
  parseKnowledgeRelationRow,
} from './row-schemas';
import type { Env } from './types';
import { generateId } from './types';

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
        score: r.confidence * (1 / (1 + (now - r.lastConfirmedAt) / (86400000 * 30))),
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
 * Get ALL active observations with confidence >= threshold, ordered by entity
 * then recency. Used for session-start knowledge injection — returns everything
 * important rather than trying to guess relevance from keywords.
 */
export function getAllHighConfidenceKnowledge(
  sql: SqlStorage,
  minConfidence: number,
  limit: number,
) {
  const rows = sql.exec(
    `SELECT o.*, e.name as entity_name, e.entity_type
     FROM knowledge_observations o
     JOIN knowledge_entities e ON e.id = o.entity_id
     WHERE o.is_active = 1 AND o.confidence >= ?
     ORDER BY e.name, o.last_confirmed_at DESC
     LIMIT ?`,
    minConfidence, limit,
  ).toArray();

  return rows.map(parseKnowledgeObservationSearchRow);
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

// FTS5 reserved keywords that must be stripped to prevent query injection
const FTS5_RESERVED = new Set(['AND', 'OR', 'NOT', 'NEAR']);

function buildFtsQuery(query: string): string | null {
  const cleaned = query.replace(/[^\w\s]/g, ' ').trim();
  if (!cleaned) return null;
  // Split into words, strip FTS5 operators, and join for implicit AND matching
  const words = cleaned
    .split(/\s+/)
    .filter((w) => w && !FTS5_RESERVED.has(w.toUpperCase()));
  if (words.length === 0) return null;
  return words.join(' ');
}
