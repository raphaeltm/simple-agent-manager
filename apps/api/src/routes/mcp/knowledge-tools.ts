/**
 * MCP Knowledge Graph tool handlers — CRUD, search, and retrieval for project knowledge.
 */
import { KNOWLEDGE_ENTITY_TYPES, KNOWLEDGE_RELATION_TYPES, KNOWLEDGE_SOURCE_TYPES } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import * as projectDataService from '../../services/project-data';
import {
  getMcpLimits,
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

// ─── add_knowledge ──────────────────────────────────────────────────────────

export async function handleAddKnowledge(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);

  const entityName = typeof params.entityName === 'string'
    ? sanitizeUserInput(params.entityName.trim()).slice(0, limits.knowledgeEntityNameMaxLength)
    : '';
  if (!entityName) return jsonRpcError(requestId, INVALID_PARAMS, 'entityName is required');

  const entityType = typeof params.entityType === 'string' ? params.entityType : 'custom';
  if (!KNOWLEDGE_ENTITY_TYPES.includes(entityType as (typeof KNOWLEDGE_ENTITY_TYPES)[number])) {
    return jsonRpcError(requestId, INVALID_PARAMS, `Invalid entityType. Valid: ${KNOWLEDGE_ENTITY_TYPES.join(', ')}`);
  }

  const observation = typeof params.observation === 'string'
    ? sanitizeUserInput(params.observation.trim()).slice(0, limits.knowledgeObservationMaxLength)
    : '';
  if (!observation) return jsonRpcError(requestId, INVALID_PARAMS, 'observation is required');

  const confidence = typeof params.confidence === 'number'
    ? Math.min(Math.max(0, params.confidence), 1)
    : 0.7;

  const sourceType = typeof params.sourceType === 'string' && KNOWLEDGE_SOURCE_TYPES.includes(params.sourceType as (typeof KNOWLEDGE_SOURCE_TYPES)[number])
    ? params.sourceType
    : 'inferred';

  const sessionId = await resolveSessionId(env, tokenData.workspaceId);

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

  const newContent = typeof params.newContent === 'string'
    ? sanitizeUserInput(params.newContent.trim()).slice(0, limits.knowledgeObservationMaxLength)
    : '';
  if (!newContent) return jsonRpcError(requestId, INVALID_PARAMS, 'newContent is required');

  const confidence = typeof params.confidence === 'number'
    ? Math.min(Math.max(0, params.confidence), 1)
    : null;

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
    return jsonRpcError(requestId, INVALID_PARAMS, (err as Error).message);
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
    return jsonRpcError(requestId, INVALID_PARAMS, (err as Error).message);
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

  const entityType = typeof params.entityType === 'string' ? params.entityType : null;
  const minConfidence = typeof params.minConfidence === 'number' ? params.minConfidence : null;
  const limit = typeof params.limit === 'number'
    ? Math.min(Math.max(1, params.limit), limits.knowledgeSearchLimit)
    : limits.knowledgeSearchLimit;

  const results = await projectDataService.searchKnowledgeObservations(
    env, tokenData.projectId, query, entityType, minConfidence, limit,
  );

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ results, count: results.length }, null, 2) }],
  });
}

// ─── get_project_knowledge ──────────────────────────────────────────────────

export async function handleGetProjectKnowledge(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);
  const entityType = typeof params.entityType === 'string' ? params.entityType : null;
  const limit = typeof params.limit === 'number'
    ? Math.min(Math.max(1, params.limit), limits.knowledgeSearchLimit * 5)
    : limits.knowledgeSearchLimit;

  const result = await projectDataService.listKnowledgeEntities(
    env, tokenData.projectId, entityType, limit, 0,
  );

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({
      entities: result.entities,
      total: result.total,
    }, null, 2) }],
  });
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

  const limit = typeof params.limit === 'number'
    ? Math.min(Math.max(1, params.limit), limits.knowledgeAutoRetrieveLimit)
    : limits.knowledgeAutoRetrieveLimit;

  const results = await projectDataService.getRelevantKnowledge(
    env, tokenData.projectId, context, limit,
  );

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ observations: results, count: results.length }, null, 2) }],
  });
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
  if (!KNOWLEDGE_RELATION_TYPES.includes(relationType as (typeof KNOWLEDGE_RELATION_TYPES)[number])) {
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
    return jsonRpcError(requestId, INVALID_PARAMS, (err as Error).message);
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

  const relationType = typeof params.relationType === 'string' ? params.relationType : null;

  const entity = await projectDataService.getKnowledgeEntityByName(env, tokenData.projectId, entityName);
  if (!entity) return jsonRpcError(requestId, INVALID_PARAMS, `Entity not found: ${entityName}`);

  const relations = await projectDataService.getKnowledgeRelated(
    env, tokenData.projectId, entity.id, relationType,
  );

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ entityId: entity.id, relations }, null, 2) }],
  });
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

  await projectDataService.confirmKnowledgeObservation(env, tokenData.projectId, observationId);
  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ confirmed: true, observationId }, null, 2) }],
  });
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

  const newObservation = typeof params.newObservation === 'string'
    ? sanitizeUserInput(params.newObservation.trim()).slice(0, limits.knowledgeObservationMaxLength)
    : '';
  if (!newObservation) return jsonRpcError(requestId, INVALID_PARAMS, 'newObservation is required');

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
    return jsonRpcError(requestId, INVALID_PARAMS, (err as Error).message);
  }
}
