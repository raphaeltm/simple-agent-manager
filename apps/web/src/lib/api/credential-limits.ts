import {
  type CredentialLimitCredentialSummary,
  type CredentialLimitsResponse,
  isJsonRecord,
} from '@simple-agent-manager/shared';

import { request } from './client';

/**
 * Boundary validation (rules 50/51): the chip and the Settings cards must
 * never crash the page on an unexpected body — a proxy error page, an older
 * API, or a test double answering `{}`. Credentials without a well-formed
 * `windows` array are dropped; everything else falls back to an empty list.
 */
export function normalizeCredentialLimitsResponse(raw: unknown): CredentialLimitsResponse {
  const body = isJsonRecord(raw) ? raw : {};
  const credentials = Array.isArray(body.credentials)
    ? (body.credentials.filter(
        (candidate): candidate is CredentialLimitCredentialSummary =>
          isJsonRecord(candidate) &&
          typeof candidate.credentialReference === 'string' &&
          Array.isArray(candidate.windows)
      ) as CredentialLimitCredentialSummary[])
    : [];
  const generatedAt = typeof body.generatedAt === 'number' ? body.generatedAt : Date.now();
  return { credentials, generatedAt };
}

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
  return normalizeCredentialLimitsResponse(
    await request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/credential-limits${query}`
    )
  );
}

/** The signed-in user's personal credentials with their latest usage windows. */
export async function getMyCredentialLimits(): Promise<CredentialLimitsResponse> {
  return normalizeCredentialLimitsResponse(await request<unknown>('/api/credentials/limits'));
}
