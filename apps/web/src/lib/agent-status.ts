import type {
  AgentCredentialInfo,
  AgentInfo,
  OpenCodeProvider,
} from '@simple-agent-manager/shared';
import { resolveOpenCodeProvider } from '@simple-agent-manager/shared';

export type AgentConnectionStatus = 'connected' | 'disconnected';

export interface AgentConnectionSummary {
  status: AgentConnectionStatus;
  label: string;
}

/**
 * Compute the connection status label for an agent card header.
 *
 * Rules:
 * - OpenCode with platform provider or platform catalog fallback
 *   → "Platform AI" (connected, no key needed)
 * - Any active credential → agent-provided label, fallback to kind-based label
 * - Scaleway-cloud fallback (user scope only, OpenCode with explicit scaleway)
 *   → "Using Scaleway Cloud Key" (connected)
 * - Otherwise → "Not Configured" (disconnected)
 *
 * Project scope does not use provider-derived fallbacks because provider
 * selection is user-scoped only.
 */
export function getAgentConnectionSummary(
  agent: AgentInfo,
  credentials: AgentCredentialInfo[] | null | undefined,
  opencodeProvider: OpenCodeProvider | null | undefined,
  scope: 'user' | 'project' = 'user',
): AgentConnectionSummary {
  const activeCredential = credentials?.find((c) => c.isActive);
  const hasAnyCredential = (credentials?.length ?? 0) > 0;
  const effectiveOpenCodeProvider =
    agent.id === 'opencode' ? resolveOpenCodeProvider(opencodeProvider) : null;

  const isOpenCodePlatform =
    scope === 'user' &&
    agent.id === 'opencode' &&
    (effectiveOpenCodeProvider === 'platform' || agent.fallbackCredentialSource === 'platform-opencode');
  const usesScalewayFallback =
    scope === 'user' &&
    agent.fallbackCredentialSource === 'scaleway-cloud' &&
    effectiveOpenCodeProvider === 'scaleway';
  const usesSamProvider = agent.fallbackCredentialSource === 'platform-sam';

  if (isOpenCodePlatform) {
    return { status: 'connected', label: 'Platform AI' };
  }
  if (usesSamProvider) {
    return { status: 'connected', label: 'SAM' };
  }
  if (hasAnyCredential && activeCredential) {
    const fallback =
      activeCredential.credentialKind === 'oauth-token' ? 'Connected (OAuth)' : 'Connected';
    return { status: 'connected', label: activeCredential.label || fallback };
  }
  if (usesScalewayFallback) {
    return { status: 'connected', label: 'Using Scaleway Cloud Key' };
  }
  return { status: 'disconnected', label: 'Not Configured' };
}
