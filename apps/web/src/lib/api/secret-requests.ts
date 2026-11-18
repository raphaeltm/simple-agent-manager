import type {
  FulfillRuntimeSecretRequestBody,
  RuntimeSecretRequestResolution,
  RuntimeSecretRequestResponse,
} from '@simple-agent-manager/shared';

import { request } from './client';

// =============================================================================
// Agent secret requests (the in-chat SecretRequestCard)
// =============================================================================

function path(projectId: string, requestId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/secret-requests/${encodeURIComponent(requestId)}`;
}

export async function getSecretRequest(
  projectId: string,
  requestId: string,
  signal?: AbortSignal
): Promise<RuntimeSecretRequestResponse> {
  return request<RuntimeSecretRequestResponse>(path(projectId, requestId), { signal });
}

/**
 * Sends the value straight to the API, which stores it encrypted. Callers must not keep the
 * value in any cache (no `useMutation`: its variables live in the mutation cache).
 */
export async function fulfillSecretRequest(
  projectId: string,
  requestId: string,
  body: FulfillRuntimeSecretRequestBody
): Promise<RuntimeSecretRequestResolution> {
  return request<RuntimeSecretRequestResolution>(`${path(projectId, requestId)}/fulfill`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function declineSecretRequest(
  projectId: string,
  requestId: string
): Promise<RuntimeSecretRequestResolution> {
  return request<RuntimeSecretRequestResolution>(`${path(projectId, requestId)}/decline`, {
    method: 'POST',
  });
}
