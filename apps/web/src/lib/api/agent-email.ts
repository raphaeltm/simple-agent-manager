/**
 * Agent email (prototype): whether this deployment can receive and send agent email, and the
 * admin status/loopback self-test. See `packages/shared/src/types/agent-email.ts` for the wire
 * types and `apps/api/src/routes/admin-agent-email.ts` for the admin endpoints.
 */
import type { AgentEmailConfigResponse } from '@simple-agent-manager/shared';

import { request } from './client';

/** One sent loopback test: a fixed message from `agent+loopback@<domain>` to a trigger address. */
export interface AgentEmailLoopbackSent {
  to: string;
  sentAt: string;
  providerMessageId: string;
}

/** The reply the loopback trigger's agent sent back, if any. */
export interface AgentEmailLoopbackReceived {
  from: string;
  subject: string;
  autoSubmitted: string | null;
  receivedAt: string;
}

export interface AdminAgentEmailStatus extends AgentEmailConfigResponse {
  loopback: {
    lastSent: AgentEmailLoopbackSent | null;
    lastReceived: AgentEmailLoopbackReceived | null;
  };
}

/**
 * Public, unauthenticated config used to decide whether to offer the "Email" automation start.
 * Mirrors `getArtifactsEnabled` in `./projects`: a failed fetch degrades to "not available"
 * rather than breaking the create flow.
 */
export async function getAgentEmailConfig(): Promise<AgentEmailConfigResponse> {
  try {
    return await request<AgentEmailConfigResponse>('/api/config/agent-email');
  } catch {
    return { enabled: false, domain: null };
  }
}

/** Superadmin only. */
export async function fetchAdminAgentEmail(): Promise<AdminAgentEmailStatus> {
  return request<AdminAgentEmailStatus>('/api/admin/agent-email');
}

/** Superadmin only. `to` must be an existing email trigger's address. */
export async function sendAgentEmailLoopback(to: string): Promise<AgentEmailLoopbackSent> {
  return request<AgentEmailLoopbackSent>('/api/admin/agent-email/loopback', {
    method: 'POST',
    body: JSON.stringify({ to }),
  });
}
