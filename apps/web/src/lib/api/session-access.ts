import type {
  CreateSessionAccessGrantResponse,
  RevokeSessionAccessGrantResponse,
  SessionAccessDurationMinutes,
  SessionAccessSummary,
} from '@simple-agent-manager/shared';

import { recordServerTime } from '../server-clock';
import { request } from './client';

// =============================================================================
// Shared session access + session-scoped lifecycle controls
//
// The session-scoped controls authorize the session owner or anyone they shared the session
// with, then act on the owner's workspace. The project chat uses them instead of the
// owner-only `/api/workspaces/:id/*` routes.
// =============================================================================

export async function getSessionAccess(
  projectId: string,
  sessionId: string
): Promise<SessionAccessSummary> {
  const access = await request<SessionAccessSummary>(
    `/api/projects/${projectId}/sessions/${sessionId}/access`
  );
  recordServerTime(access.serverTime);
  return access;
}

/**
 * Share (or, for the owner, renew) access for `durationMinutes`. Sent only after the person
 * sharing ticked the shared-accounts acknowledgement, which the server requires every time.
 */
export async function shareSessionAccess(
  projectId: string,
  sessionId: string,
  userId: string,
  durationMinutes: SessionAccessDurationMinutes
): Promise<CreateSessionAccessGrantResponse> {
  const response = await request<CreateSessionAccessGrantResponse>(
    `/api/projects/${projectId}/sessions/${sessionId}/access/grants`,
    {
      method: 'POST',
      body: JSON.stringify({ userId, durationMinutes, acknowledgeSharedCredentials: true }),
    }
  );
  recordServerTime(response.access.serverTime);
  return response;
}

export async function revokeSessionAccess(
  projectId: string,
  sessionId: string,
  granteeUserId: string
): Promise<RevokeSessionAccessGrantResponse> {
  const response = await request<RevokeSessionAccessGrantResponse>(
    `/api/projects/${projectId}/sessions/${sessionId}/access/grants/${encodeURIComponent(granteeUserId)}`,
    { method: 'DELETE' }
  );
  recordServerTime(response.access.serverTime);
  return response;
}

export function sleepChatSession(
  projectId: string,
  sessionId: string
): Promise<{
  status: 'sleeping';
  workspaceId: string;
  chatSessionId: string;
  snapshotExpiresAt: string;
}> {
  return request(`/api/projects/${projectId}/sessions/${sessionId}/sleep`, { method: 'POST' });
}

export function resumeChatSessionAgent(
  projectId: string,
  sessionId: string,
  agentSessionId: string
): Promise<unknown> {
  return request(
    `/api/projects/${projectId}/sessions/${sessionId}/agent-sessions/${encodeURIComponent(agentSessionId)}/resume`,
    { method: 'POST' }
  );
}
