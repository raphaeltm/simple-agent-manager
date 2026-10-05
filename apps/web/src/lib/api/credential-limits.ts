import type { CredentialLimitsResponse } from '@simple-agent-manager/shared';

import { request } from './client';

/**
 * Latest provider usage windows for the credentials visible to the caller in a
 * project. With `agentSessionId`, the server narrows to the credential that
 * agent session is attributed to.
 */
export async function getProjectCredentialLimits(
  projectId: string,
  options: { agentSessionId?: string | null } = {}
): Promise<CredentialLimitsResponse> {
  const query = options.agentSessionId
    ? `?agentSessionId=${encodeURIComponent(options.agentSessionId)}`
    : '';
  return request<CredentialLimitsResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/credential-limits${query}`
  );
}

/** The signed-in user's personal credentials with their latest usage windows. */
export async function getMyCredentialLimits(): Promise<CredentialLimitsResponse> {
  return request<CredentialLimitsResponse>('/api/credentials/limits');
}
