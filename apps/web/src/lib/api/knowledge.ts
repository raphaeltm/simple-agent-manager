/**
 * Knowledge Graph API client functions.
 */
import type {
  AddObservationRequest,
  CreateKnowledgeEntityRequest,
  KnowledgeEntityDetail,
  KnowledgeEntityType,
  KnowledgeObservation,
  KnowledgeRelation,
  ListKnowledgeEntitiesResponse,
  SearchKnowledgeResponse,
  UpdateKnowledgeEntityRequest,
  UpdateObservationRequest,
} from '@simple-agent-manager/shared';

import { request } from './client';

export async function listKnowledgeEntities(
  projectId: string,
  params: { entityType?: string; limit?: number; offset?: number } = {},
): Promise<ListKnowledgeEntitiesResponse> {
  const searchParams = new URLSearchParams();
  if (params.entityType) searchParams.set('entityType', params.entityType);
  if (params.limit) searchParams.set('limit', String(params.limit));
  if (params.offset) searchParams.set('offset', String(params.offset));
  const query = searchParams.toString();
  const endpoint = query
    ? `/api/projects/${projectId}/knowledge?${query}`
    : `/api/projects/${projectId}/knowledge`;
  return request<ListKnowledgeEntitiesResponse>(endpoint);
}

export async function getKnowledgeEntity(
  projectId: string,
  entityId: string,
): Promise<{ entity: KnowledgeEntityDetail; observations: KnowledgeObservation[]; relations: KnowledgeRelation[] }> {
  return request(`/api/projects/${projectId}/knowledge/${entityId}`);
}

export async function createKnowledgeEntity(
  projectId: string,
  body: CreateKnowledgeEntityRequest,
): Promise<{ id: string; createdAt: number }> {
  return request(`/api/projects/${projectId}/knowledge`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateKnowledgeEntity(
  projectId: string,
  entityId: string,
  body: UpdateKnowledgeEntityRequest,
): Promise<{ updated: boolean }> {
  return request(`/api/projects/${projectId}/knowledge/${entityId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteKnowledgeEntity(
  projectId: string,
  entityId: string,
): Promise<{ deleted: boolean }> {
  return request(`/api/projects/${projectId}/knowledge/${entityId}`, {
    method: 'DELETE',
  });
}

export async function addObservation(
  projectId: string,
  entityId: string,
  body: AddObservationRequest,
): Promise<{ id: string; createdAt: number }> {
  return request(`/api/projects/${projectId}/knowledge/${entityId}/observations`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateObservation(
  projectId: string,
  observationId: string,
  body: UpdateObservationRequest,
): Promise<{ id?: string; updated?: boolean }> {
  return request(`/api/projects/${projectId}/knowledge/observations/${observationId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteObservation(
  projectId: string,
  observationId: string,
): Promise<{ removed: boolean }> {
  return request(`/api/projects/${projectId}/knowledge/observations/${observationId}`, {
    method: 'DELETE',
  });
}

export async function searchKnowledge(
  projectId: string,
  query: string,
  params: { entityType?: KnowledgeEntityType; limit?: number } = {},
): Promise<SearchKnowledgeResponse> {
  const searchParams = new URLSearchParams({ q: query });
  if (params.entityType) searchParams.set('entityType', params.entityType);
  if (params.limit) searchParams.set('limit', String(params.limit));
  return request<SearchKnowledgeResponse>(
    `/api/projects/${projectId}/knowledge/search?${searchParams.toString()}`,
  );
}
