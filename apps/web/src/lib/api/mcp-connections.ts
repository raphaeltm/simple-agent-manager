import type {
  CreateMcpConnectionRequest,
  McpConnection,
  McpConnectionListResponse,
  UpdateMcpConnectionRequest,
} from '@simple-agent-manager/shared';

import { request } from './client';

/**
 * Bring-your-own MCP servers.
 *
 * The same four operations exist at two scopes. `projectId === null` targets the caller's
 * personal scope; a project id targets that project's shared scope. Keeping one set of
 * functions with a scope argument (rather than eight functions) is what lets the UI render
 * both scopes from a single component.
 */
function basePath(projectId: string | null): string {
  return projectId === null
    ? '/api/mcp-connections'
    : `/api/projects/${projectId}/mcp-connections`;
}

export async function listMcpConnections(projectId: string | null): Promise<McpConnection[]> {
  const response = await request<McpConnectionListResponse>(basePath(projectId));
  return response.items;
}

export async function createMcpConnection(
  projectId: string | null,
  data: CreateMcpConnectionRequest
): Promise<McpConnection> {
  return request<McpConnection>(basePath(projectId), {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateMcpConnection(
  projectId: string | null,
  connectionId: string,
  data: UpdateMcpConnectionRequest
): Promise<McpConnection> {
  return request<McpConnection>(`${basePath(projectId)}/${connectionId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteMcpConnection(
  projectId: string | null,
  connectionId: string
): Promise<void> {
  await request<{ success: boolean }>(`${basePath(projectId)}/${connectionId}`, {
    method: 'DELETE',
  });
}
