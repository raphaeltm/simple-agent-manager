import * as v from 'valibot';

import { parseRow } from './core';

// =============================================================================
// Knowledge Graph row schemas
// =============================================================================

const KnowledgeEntityRowSchema = v.object({
  id: v.string(),
  name: v.string(),
  entity_type: v.string(),
  description: v.nullable(v.string()),
  created_at: v.number(),
  updated_at: v.number(),
});

const KnowledgeEntityWithCountSchema = v.object({
  id: v.string(),
  name: v.string(),
  entity_type: v.string(),
  description: v.nullable(v.string()),
  created_at: v.number(),
  updated_at: v.number(),
  observation_count: v.number(),
});

export function parseKnowledgeEntityRow(row: unknown): {
  id: string;
  name: string;
  entityType: string;
  description: string | null;
  observationCount: number;
  createdAt: number;
  updatedAt: number;
} {
  const r = parseRow(KnowledgeEntityWithCountSchema, row, 'knowledge_entity');
  return {
    id: r.id,
    name: r.name,
    entityType: r.entity_type,
    description: r.description,
    observationCount: r.observation_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function parseKnowledgeEntityBasicRow(row: unknown): {
  id: string;
  name: string;
  entityType: string;
  description: string | null;
  createdAt: number;
  updatedAt: number;
} {
  const r = parseRow(KnowledgeEntityRowSchema, row, 'knowledge_entity_basic');
  return {
    id: r.id,
    name: r.name,
    entityType: r.entity_type,
    description: r.description,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const KnowledgeObservationRowSchema = v.object({
  id: v.string(),
  entity_id: v.string(),
  content: v.string(),
  confidence: v.number(),
  source_type: v.string(),
  source_session_id: v.nullable(v.string()),
  created_at: v.number(),
  last_confirmed_at: v.number(),
  superseded_by: v.nullable(v.string()),
  is_active: v.number(),
});

export function parseKnowledgeObservationRow(row: unknown): {
  id: string;
  entityId: string;
  content: string;
  confidence: number;
  sourceType: string;
  sourceSessionId: string | null;
  createdAt: number;
  lastConfirmedAt: number;
  supersededBy: string | null;
  isActive: boolean;
} {
  const r = parseRow(KnowledgeObservationRowSchema, row, 'knowledge_observation');
  return {
    id: r.id,
    entityId: r.entity_id,
    content: r.content,
    confidence: r.confidence,
    sourceType: r.source_type,
    sourceSessionId: r.source_session_id,
    createdAt: r.created_at,
    lastConfirmedAt: r.last_confirmed_at,
    supersededBy: r.superseded_by,
    isActive: r.is_active === 1,
  };
}

const KnowledgeObservationSearchSchema = v.object({
  id: v.string(),
  entity_id: v.string(),
  content: v.string(),
  confidence: v.number(),
  source_type: v.string(),
  source_session_id: v.nullable(v.string()),
  created_at: v.number(),
  last_confirmed_at: v.number(),
  superseded_by: v.nullable(v.string()),
  is_active: v.number(),
  entity_name: v.string(),
  entity_type: v.string(),
});

export function parseKnowledgeObservationSearchRow(row: unknown): {
  id: string;
  entityId: string;
  content: string;
  confidence: number;
  sourceType: string;
  sourceSessionId: string | null;
  createdAt: number;
  lastConfirmedAt: number;
  supersededBy: string | null;
  isActive: boolean;
  entityName: string;
  entityType: string;
} {
  const r = parseRow(KnowledgeObservationSearchSchema, row, 'knowledge_observation_search');
  return {
    id: r.id,
    entityId: r.entity_id,
    content: r.content,
    confidence: r.confidence,
    sourceType: r.source_type,
    sourceSessionId: r.source_session_id,
    createdAt: r.created_at,
    lastConfirmedAt: r.last_confirmed_at,
    supersededBy: r.superseded_by,
    isActive: r.is_active === 1,
    entityName: r.entity_name,
    entityType: r.entity_type,
  };
}

const KnowledgeRelationRowSchema = v.object({
  id: v.string(),
  source_entity_id: v.string(),
  target_entity_id: v.string(),
  relation_type: v.string(),
  description: v.nullable(v.string()),
  created_at: v.number(),
});

export function parseKnowledgeRelationRow(row: unknown): {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;
  description: string | null;
  createdAt: number;
} {
  const r = parseRow(KnowledgeRelationRowSchema, row, 'knowledge_relation');
  return {
    id: r.id,
    sourceEntityId: r.source_entity_id,
    targetEntityId: r.target_entity_id,
    relationType: r.relation_type,
    description: r.description,
    createdAt: r.created_at,
  };
}
