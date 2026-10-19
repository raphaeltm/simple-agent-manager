import type {
  CreateSessionAccessGrantResponse,
  RevokeSessionAccessGrantResponse,
  SessionAccessSummary,
} from '@simple-agent-manager/shared';

import { request } from './client';

// =============================================================================
// Shared session access + session-scoped lifecycle controls
//
// The session-scoped controls authorize the session owner or anyone they shared the session
// with, then act on the owner's workspace. The project chat uses them instead of the
// owner-only `/api/workspaces/:id/*` routes.
// =============================================================================

export function getSessionAccess(
  projectId: string,
  sessionId: string
): Promise<SessionAccessSummary> {
  return request<SessionAccessSummary>(`/api/projects/${projectId}/sessions/${sessionId}/access`);
}

export function shareSessionAccess(
  projectId: string,
  sessionId: string,
  userId: string
): Promise<CreateSessionAccessGrantResponse> {
  return request<CreateSessionAccessGrantResponse>(
    `/api/projects/${projectId}/sessions/${sessionId}/access/grants`,
    {
      method: 'POST',
      body: JSON.stringify({ userId, acknowledgeSharedCredentials: true }),
    }
  );
}

export function revokeSessionAccess(
  projectId: string,
  sessionId: string,
  granteeUserId: string
): Promise<RevokeSessionAccessGrantResponse> {
  return request<RevokeSessionAccessGrantResponse>(
    `/api/projects/${projectId}/sessions/${sessionId}/access/grants/${encodeURIComponent(granteeUserId)}`,
    { method: 'DELETE' }
  );
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
