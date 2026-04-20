/**
 * Knowledge Graph types — per-project persistent agent memory.
 *
 * Entities are nodes in the graph (user preferences, coding style, etc.).
 * Observations are facts attached to entities.
 * Relations are edges between entities.
 */

// ─── Entity Types ────────────────────────────────────────────────────────────

export const KNOWLEDGE_ENTITY_TYPES = [
  'preference',
  'style',
  'context',
  'expertise',
  'workflow',
  'personality',
  'custom',
] as const;

export type KnowledgeEntityType = (typeof KNOWLEDGE_ENTITY_TYPES)[number];

export interface KnowledgeEntity {
  id: string;
  name: string;
  entityType: KnowledgeEntityType;
  description: string | null;
  observationCount: number;
  createdAt: number;
  updatedAt: number;
}

// ─── Observation Types ───────────────────────────────────────────────────────

export const KNOWLEDGE_SOURCE_TYPES = ['explicit', 'inferred', 'behavioral'] as const;
export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];

export interface KnowledgeObservation {
  id: string;
  entityId: string;
  content: string;
  confidence: number;
  sourceType: KnowledgeSourceType;
  sourceSessionId: string | null;
  createdAt: number;
  lastConfirmedAt: number;
  supersededBy: string | null;
  isActive: boolean;
}

// ─── Relation Types ──────────────────────────────────────────────────────────

export const KNOWLEDGE_RELATION_TYPES = [
  'influences',
  'contradicts',
  'supports',
  'requires',
  'related_to',
] as const;
export type KnowledgeRelationType = (typeof KNOWLEDGE_RELATION_TYPES)[number];

export interface KnowledgeRelation {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: KnowledgeRelationType;
  description: string | null;
  createdAt: number;
}

// ─── Request / Response Types ────────────────────────────────────────────────

export interface CreateKnowledgeEntityRequest {
  name: string;
  entityType: KnowledgeEntityType;
  description?: string | null;
}

export interface UpdateKnowledgeEntityRequest {
  name?: string;
  entityType?: KnowledgeEntityType;
  description?: string | null;
}

export interface AddObservationRequest {
  content: string;
  confidence?: number;
  sourceType?: KnowledgeSourceType;
}

export interface UpdateObservationRequest {
  content?: string;
  confidence?: number;
}

export interface KnowledgeEntityDetail extends KnowledgeEntity {
  observations: KnowledgeObservation[];
  relations: KnowledgeRelation[];
}

export interface ListKnowledgeEntitiesResponse {
  entities: KnowledgeEntity[];
  total: number;
}

export interface SearchKnowledgeResponse {
  results: Array<{
    observation: KnowledgeObservation;
    entityName: string;
    entityType: KnowledgeEntityType;
  }>;
  total: number;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

export const KNOWLEDGE_DEFAULTS = {
  maxEntitiesPerProject: 500,
  maxObservationsPerEntity: 100,
  searchLimit: 20,
  searchMaxLimit: 100,
  listPageSize: 50,
  listMaxPageSize: 200,
  autoRetrieveLimit: 20,
  autoRetrieveMinConfidence: 0.8,
  autoRetrieveHighConfidenceLimit: 50,
  observationMaxLength: 1000,
  entityNameMaxLength: 200,
  descriptionMaxLength: 2000,
  defaultConfidence: 0.7,
} as const;
