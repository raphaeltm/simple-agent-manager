/**
 * MCP Knowledge Graph tool handlers — CRUD, search, and retrieval for project knowledge.
 */
import {
  KNOWLEDGE_ENTITY_TYPES,
  KNOWLEDGE_RELATION_TYPES,
  KNOWLEDGE_SOURCE_TYPES,
  type KnowledgeEntityType,
  type KnowledgeRelationType,
  type KnowledgeSourceType,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import * as projectDataService from '../../services/project-data';
import {
  getMcpLimits,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
  sanitizeUserInput,
} from './_helpers';

// ─── Helper: resolve session ID from workspace ─────────────────────────────

async function resolveSessionId(env: Env, workspaceId: string): Promise<string | null> {
  const row = await env.DATABASE.prepare(
    'SELECT chat_session_id FROM workspaces WHERE id = ?',
  ).bind(workspaceId).first<{ chat_session_id: string | null }>();
  return row?.chat_session_id ?? null;
}

function isKnowledgeEntityType(value: string): value is KnowledgeEntityType {
  return (KNOWLEDGE_ENTITY_TYPES as readonly string[]).includes(value);
}

function isKnowledgeSourceType(value: string): value is KnowledgeSourceType {
  return (KNOWLEDGE_SOURCE_TYPES as readonly string[]).includes(value);
}

function isKnowledgeRelationType(value: string): value is KnowledgeRelationType {
  return (KNOWLEDGE_RELATION_TYPES as readonly string[]).includes(value);
}

function validateConfidence(
  requestId: string | number | null,
  value: unknown,
  fieldName: string,
): { ok: true; value: number | null } | { ok: false; response: JsonRpcResponse } {
  if (value === undefined) {
    return { ok: true, value: null };
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return { ok: false, response: jsonRpcError(requestId, INVALID_PARAMS, `${fieldName} must be a number between 0.0 and 1.0`) };
  }
  return { ok: true, value };
}

function validateLimit(
  requestId: string | number | null,
  value: unknown,
  defaultLimit: number,
  maxLimit: number,
): { ok: true; value: number } | { ok: false; response: JsonRpcResponse } {
  if (value === undefined) {
    return { ok: true, value: defaultLimit };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, response: jsonRpcError(requestId, INVALID_PARAMS, 'limit must be a number') };
  }
  return { ok: true, value: Math.min(Math.max(1, Math.round(value)), maxLimit) };
}

function sanitizeRequiredString(
  requestId: string | number | null,
  value: unknown,
  fieldName: string,
  maxLength: number,
): { ok: true; value: string } | { ok: false; response: JsonRpcResponse } {
  const sanitized = typeof value === 'string' ? sanitizeUserInput(value.trim()) : '';
  if (!sanitized) {
    return { ok: false, response: jsonRpcError(requestId, INVALID_PARAMS, `${fieldName} is required`) };
  }
  if (sanitized.length > maxLength) {
    return { ok: false, response: jsonRpcError(requestId, INVALID_PARAMS, `${fieldName} exceeds maximum length of ${maxLength} characters`) };
  }
  return { ok: true, value: sanitized };
}

// ─── add_knowledge ──────────────────────────────────────────────────────────

export async function handleAddKnowledge(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);

  const entityNameResult = sanitizeRequiredString(
    requestId, params.entityName, 'entityName', limits.knowledgeEntityNameMaxLength,
  );
  if (!entityNameResult.ok) return entityNameResult.response;
  const entityName = entityNameResult.value;

  const entityType = typeof params.entityType === 'string' ? params.entityType : 'custom';
  if (!isKnowledgeEntityType(entityType)) {
    return jsonRpcError(requestId, INVALID_PARAMS, `Invalid entityType. Valid: ${KNOWLEDGE_ENTITY_TYPES.join(', ')}`);
  }

  const observationResult = sanitizeRequiredString(
    requestId, params.observation, 'observation', limits.knowledgeObservationMaxLength,
  );
  if (!observationResult.ok) return observationResult.response;
  const observation = observationResult.value;

  const confidenceResult = validateConfidence(requestId, params.confidence, 'confidence');
  if (!confidenceResult.ok) return confidenceResult.response;
  const confidence = confidenceResult.value ?? 0.7;

  let sourceType: KnowledgeSourceType = 'inferred';
  if (params.sourceType !== undefined) {
    if (typeof params.sourceType !== 'string' || !isKnowledgeSourceType(params.sourceType)) {
      return jsonRpcError(requestId, INVALID_PARAMS, `Invalid sourceType. Valid: ${KNOWLEDGE_SOURCE_TYPES.join(', ')}`);
    }
    sourceType = params.sourceType;
  }

  const sessionId = await resolveSessionId(env, tokenData.workspaceId);

  try {
    // Get or create entity
    const existingEntity = await projectDataService.getKnowledgeEntityByName(env, tokenData.projectId, entityName);
    let entityId: string;
    if (!existingEntity) {
      const created = await projectDataService.createKnowledgeEntity(
        env, tokenData.projectId, entityName, entityType, null,
      );
      entityId = created.id;
    } else {
      entityId = existingEntity.id;
    }

    const obs = await projectDataService.addKnowledgeObservation(
      env, tokenData.projectId, entityId, observation, confidence, sourceType, sessionId,
    );

    // Trial bridge — if this project is backing an anonymous trial, fan the
    // observation out as a `trial.knowledge` SSE event. Non-trial projects
    // short-circuit after a single KV lookup inside the helper.
    try {
      const { bridgeKnowledgeAdded } = await import('../../services/trial/bridge');
      await bridgeKnowledgeAdded(env, tokenData.projectId, entityName, observation);
    } catch {
      // Bridge errors are already logged inside the helper; never block MCP.
    }

    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify({
        added: true,
        entityId,
        entityName,
        observationId: obs.id,
        confidence,
        sourceType,
      }, null, 2) }],
    });
  } catch (err) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to add knowledge: ${(err as Error).message}`);
  }
}

// ─── update_knowledge ───────────────────────────────────────────────────────

export async function handleUpdateKnowledge(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);
  const observationId = typeof params.observationId === 'string' ? params.observationId.trim() : '';
  if (!observationId) return jsonRpcError(requestId, INVALID_PARAMS, 'observationId is required');

  const newContentResult = sanitizeRequiredString(
    requestId, params.newContent, 'newContent', limits.knowledgeObservationMaxLength,
  );
  if (!newContentResult.ok) return newContentResult.response;
  const newContent = newContentResult.value;

  const confidenceResult = validateConfidence(requestId, params.confidence, 'confidence');
  if (!confidenceResult.ok) return confidenceResult.response;
  const confidence = confidenceResult.value;

  try {
    const result = await projectDataService.updateKnowledgeObservation(
      env, tokenData.projectId, observationId, newContent, confidence,
    );
    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify({
        updated: true,
        newObservationId: result.id,
        supersedes: observationId,
      }, null, 2) }],
    });
  } catch (err) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to update knowledge: ${(err as Error).message}`);
  }
}

// ─── remove_knowledge ───────────────────────────────────────────────────────

export async function handleRemoveKnowledge(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const observationId = typeof params.observationId === 'string' ? params.observationId.trim() : '';
  if (!observationId) return jsonRpcError(requestId, INVALID_PARAMS, 'observationId is required');

  try {
    await projectDataService.removeKnowledgeObservation(env, tokenData.projectId, observationId);
    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify({ removed: true, observationId }, null, 2) }],
    });
  } catch (err) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to remove knowledge: ${(err as Error).message}`);
  }
}

// ─── get_knowledge ──────────────────────────────────────────────────────────

export async function handleGetKnowledge(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const entityName = typeof params.entityName === 'string' ? params.entityName.trim() : '';
  const entityId = typeof params.entityId === 'string' ? params.entityId.trim() : '';

  if (!entityName && !entityId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Either entityName or entityId is required');
  }

  try {
    const entity = entityId
      ? await projectDataService.getKnowledgeEntity(env, tokenData.projectId, entityId)
      : await projectDataService.getKnowledgeEntityByName(env, tokenData.projectId, entityName);

    if (!entity) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'Entity not found');
    }

    const observations = await projectDataService.getKnowledgeObservationsForEntity(
      env, tokenData.projectId, entity.id, false,
    );
    const relations = await projectDataService.getKnowledgeRelated(env, tokenData.projectId, entity.id, null);

    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify({
        entity,
        observations,
        relations,
      }, null, 2) }],
    });
  } catch (err) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to get knowledge: ${(err as Error).message}`);
  }
}

// ─── search_knowledge ───────────────────────────────────────────────────────

export async function handleSearchKnowledge(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);
  const query = typeof params.query === 'string' ? params.query.trim() : '';
  if (!query) return jsonRpcError(requestId, INVALID_PARAMS, 'query is required');

  let entityType: KnowledgeEntityType | null = null;
  if (params.entityType !== undefined) {
    if (typeof params.entityType !== 'string' || !isKnowledgeEntityType(params.entityType)) {
      return jsonRpcError(requestId, INVALID_PARAMS, `Invalid entityType. Valid: ${KNOWLEDGE_ENTITY_TYPES.join(', ')}`);
    }
    entityType = params.entityType;
  }
  const minConfidenceResult = validateConfidence(requestId, params.minConfidence, 'minConfidence');
  if (!minConfidenceResult.ok) return minConfidenceResult.response;
  const minConfidence = minConfidenceResult.value;
  const limitResult = validateLimit(requestId, params.limit, limits.knowledgeSearchLimit, limits.knowledgeSearchLimit);
  if (!limitResult.ok) return limitResult.response;
  const limit = limitResult.value;

  try {
    const results = await projectDataService.searchKnowledgeObservations(
      env, tokenData.projectId, query, entityType, minConfidence, limit,
    );

    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify({ results, count: results.length }, null, 2) }],
    });
  } catch (err) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to search knowledge: ${(err as Error).message}`);
  }
}

// ─── get_project_knowledge ──────────────────────────────────────────────────

export async function handleGetProjectKnowledge(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);
  let entityType: KnowledgeEntityType | null = null;
  if (params.entityType !== undefined) {
    if (typeof params.entityType !== 'string' || !isKnowledgeEntityType(params.entityType)) {
      return jsonRpcError(requestId, INVALID_PARAMS, `Invalid entityType. Valid: ${KNOWLEDGE_ENTITY_TYPES.join(', ')}`);
    }
    entityType = params.entityType;
  }
  const limitResult = validateLimit(requestId, params.limit, limits.knowledgeSearchLimit, limits.knowledgeSearchLimit * 5);
  if (!limitResult.ok) return limitResult.response;
  const limit = limitResult.value;

  try {
    const result = await projectDataService.listKnowledgeEntities(
      env, tokenData.projectId, entityType, limit, 0,
    );

    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify({
        entities: result.entities,
        total: result.total,
      }, null, 2) }],
    });
  } catch (err) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to get project knowledge: ${(err as Error).message}`);
  }
}

// ─── get_relevant_knowledge ─────────────────────────────────────────────────

export async function handleGetRelevantKnowledge(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);
  const context = typeof params.context === 'string' ? params.context.trim() : '';
  if (!context) return jsonRpcError(requestId, INVALID_PARAMS, 'context is required');

  const limitResult = validateLimit(requestId, params.limit, limits.knowledgeAutoRetrieveLimit, limits.knowledgeAutoRetrieveLimit);
  if (!limitResult.ok) return limitResult.response;
  const limit = limitResult.value;

  try {
    const results = await projectDataService.getRelevantKnowledge(
      env, tokenData.projectId, context, limit,
    );

    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify({ observations: results, count: results.length }, null, 2) }],
    });
  } catch (err) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to get relevant knowledge: ${(err as Error).message}`);
  }
}

// ─── relate_knowledge ───────────────────────────────────────────────────────

export async function handleRelateKnowledge(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const sourceEntity = typeof params.sourceEntity === 'string' ? params.sourceEntity.trim() : '';
  const targetEntity = typeof params.targetEntity === 'string' ? params.targetEntity.trim() : '';
  if (!sourceEntity || !targetEntity) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'sourceEntity and targetEntity are required');
  }

  const relationType = typeof params.relationType === 'string' ? params.relationType : 'related_to';
  if (!isKnowledgeRelationType(relationType)) {
    return jsonRpcError(requestId, INVALID_PARAMS, `Invalid relationType. Valid: ${KNOWLEDGE_RELATION_TYPES.join(', ')}`);
  }

  const description = typeof params.description === 'string' ? sanitizeUserInput(params.description.trim()) : null;

  // Resolve entity IDs by name
  const source = await projectDataService.getKnowledgeEntityByName(env, tokenData.projectId, sourceEntity);
  if (!source) return jsonRpcError(requestId, INVALID_PARAMS, `Source entity not found: ${sourceEntity}`);
  const target = await projectDataService.getKnowledgeEntityByName(env, tokenData.projectId, targetEntity);
  if (!target) return jsonRpcError(requestId, INVALID_PARAMS, `Target entity not found: ${targetEntity}`);

  try {
    const result = await projectDataService.createKnowledgeRelation(
      env, tokenData.projectId, source.id, target.id, relationType, description,
    );
    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify({
        created: true,
        relationId: result.id,
        sourceEntityId: source.id,
        targetEntityId: target.id,
        relationType,
      }, null, 2) }],
    });
  } catch (err) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to relate knowledge: ${(err as Error).message}`);
  }
}

// ─── get_related ────────────────────────────────────────────────────────────

export async function handleGetRelated(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const entityName = typeof params.entityName === 'string' ? params.entityName.trim() : '';
  if (!entityName) return jsonRpcError(requestId, INVALID_PARAMS, 'entityName is required');

  let relationType: KnowledgeRelationType | null = null;
  if (params.relationType !== undefined) {
    if (typeof params.relationType !== 'string' || !isKnowledgeRelationType(params.relationType)) {
      return jsonRpcError(requestId, INVALID_PARAMS, `Invalid relationType. Valid: ${KNOWLEDGE_RELATION_TYPES.join(', ')}`);
    }
    relationType = params.relationType;
  }

  try {
    const entity = await projectDataService.getKnowledgeEntityByName(env, tokenData.projectId, entityName);
    if (!entity) return jsonRpcError(requestId, INVALID_PARAMS, `Entity not found: ${entityName}`);

    const relations = await projectDataService.getKnowledgeRelated(
      env, tokenData.projectId, entity.id, relationType,
    );

    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify({ entityId: entity.id, relations }, null, 2) }],
    });
  } catch (err) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to get related knowledge: ${(err as Error).message}`);
  }
}

// ─── confirm_knowledge ──────────────────────────────────────────────────────

export async function handleConfirmKnowledge(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const observationId = typeof params.observationId === 'string' ? params.observationId.trim() : '';
  if (!observationId) return jsonRpcError(requestId, INVALID_PARAMS, 'observationId is required');

  try {
    await projectDataService.confirmKnowledgeObservation(env, tokenData.projectId, observationId);
    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify({ confirmed: true, observationId }, null, 2) }],
    });
  } catch (err) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to confirm knowledge: ${(err as Error).message}`);
  }
}

// ─── flag_contradiction ─────────────────────────────────────────────────────

export async function handleFlagContradiction(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);
  const existingObservationId = typeof params.existingObservationId === 'string' ? params.existingObservationId.trim() : '';
  if (!existingObservationId) return jsonRpcError(requestId, INVALID_PARAMS, 'existingObservationId is required');

  const newObservationResult = sanitizeRequiredString(
    requestId, params.newObservation, 'newObservation', limits.knowledgeObservationMaxLength,
  );
  if (!newObservationResult.ok) return newObservationResult.response;
  const newObservation = newObservationResult.value;

  const sessionId = await resolveSessionId(env, tokenData.workspaceId);

  try {
    const result = await projectDataService.flagKnowledgeContradiction(
      env, tokenData.projectId, existingObservationId, newObservation, sessionId,
    );
    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify({
        flagged: true,
        newObservationId: result.newObservationId,
        contradictionRelationId: result.relationId,
      }, null, 2) }],
    });
  } catch (err) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to flag contradiction: ${(err as Error).message}`);
  }
}
