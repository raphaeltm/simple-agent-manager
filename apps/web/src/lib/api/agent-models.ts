import type {
  AgentModelCatalogResponse,
  ProjectAgentModelSettingsResponse,
  UpdateProjectAgentModelSettingsRequest,
} from '@simple-agent-manager/shared';

import { request } from './client';

/**
 * Cloudflare-hosted models agents can call with the `run_ai_model` MCP tool.
 * See `packages/shared/src/agent-models.ts` for the resolution contract
 * (project -> profile -> skill, most specific wins).
 */

export async function getAgentModelCatalog(): Promise<AgentModelCatalogResponse> {
  return request<AgentModelCatalogResponse>('/api/agent-models/catalog');
}

export async function getProjectAgentModelSettings(
  projectId: string
): Promise<ProjectAgentModelSettingsResponse> {
  return request<ProjectAgentModelSettingsResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/agent-models`
  );
}

export async function updateProjectAgentModelSettings(
  projectId: string,
  data: UpdateProjectAgentModelSettingsRequest
): Promise<ProjectAgentModelSettingsResponse> {
  return request<ProjectAgentModelSettingsResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/agent-models`,
    {
      method: 'PUT',
      body: JSON.stringify(data),
    }
  );
}
