import type { AgentCredentialInfo, AgentInfo } from '@simple-agent-manager/shared';

export type AgentConnectionStatus = 'connected' | 'disconnected';

export interface AgentConnectionSummary {
  status: AgentConnectionStatus;
  label: string;
}

/**
 * Compute the connection status label for an agent card header.
 *
 * Rules:
 * - SAM platform proxy fallback (Claude Code / Codex, providerMode='sam')
 *   → "SAM" (connected, no key needed)
 * - Any active credential → agent-provided label, fallback to kind-based label
 * - Otherwise → "Not Configured" (disconnected)
 */
export function getAgentConnectionSummary(
  agent: AgentInfo,
  credentials: AgentCredentialInfo[] | null | undefined,
): AgentConnectionSummary {
  const activeCredential = credentials?.find((c) => c.isActive);
  const hasAnyCredential = (credentials?.length ?? 0) > 0;
  const usesSamProvider = agent.fallbackCredentialSource === 'platform-sam';

  if (usesSamProvider) {
    return { status: 'connected', label: 'SAM' };
  }
  if (hasAnyCredential && activeCredential) {
    const fallback =
      activeCredential.credentialKind === 'oauth-token' ? 'Connected (OAuth)' : 'Connected';
    return { status: 'connected', label: activeCredential.label || fallback };
  }
  return { status: 'disconnected', label: 'Not Configured' };
}
