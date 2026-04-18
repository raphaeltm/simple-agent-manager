import type {
  AgentCredentialInfo,
  AgentInfo,
  OpenCodeProvider,
} from '@simple-agent-manager/shared';

export type AgentConnectionStatus = 'connected' | 'disconnected';

export interface AgentConnectionSummary {
  status: AgentConnectionStatus;
  label: string;
}

/**
 * Compute the connection status label for an agent card header.
 *
 * Rules:
 * - OpenCode with `platform` provider → "Platform AI" (connected, no key needed)
 * - Any active credential → agent-provided label, fallback to kind-based label
 * - Scaleway-cloud fallback (user scope only, OpenCode with scaleway/no-provider)
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

  const isOpenCodePlatform =
    scope === 'user' && agent.id === 'opencode' && opencodeProvider === 'platform';
  const usesScalewayFallback =
    scope === 'user' &&
    agent.fallbackCredentialSource === 'scaleway-cloud' &&
    (!opencodeProvider || opencodeProvider === 'scaleway');

  if (isOpenCodePlatform) {
    return { status: 'connected', label: 'Platform AI' };
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
