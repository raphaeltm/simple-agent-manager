/**
 * When an agent run with no credential of the person's own falls back to SAM's platform AI proxy.
 * One predicate for the agent-key callback (`routes/workspaces/runtime.ts`, `POST /:id/agent-key`)
 * and the Connector's account read (`profile-account-bindings.ts`), so the read cannot report a
 * proxy the callback would refuse.
 */
import { HARNESS_CAPABILITIES } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { isAiProxyEnabled } from './ai-proxy-availability';

/** Agent types eligible for AI proxy credential fallback (module-scope for isolate reuse). */
export const PROXY_ELIGIBLE_AGENTS: ReadonlySet<string> = new Set(
  HARNESS_CAPABILITIES.filter(
    (capability) => capability.proxyRouteSegment && capability.proxyProviderTag
  ).map((capability) => capability.agentType)
);

/**
 * Claude Code and Codex use the platform proxy only after the person explicitly chose SAM as the
 * provider (`agent_settings.provider_mode = 'sam'`); without it a run with no credential gets 404.
 */
export function requiresExplicitSamProvider(agentType: string): boolean {
  return agentType === 'claude-code' || agentType === 'openai-codex';
}

/**
 * True when a run of `agentType` with no credential of its own would start on the platform proxy.
 * OpenCode is proxy-eligible for passthrough but always needs its own key, so it never qualifies.
 */
export async function samProxyFallbackAvailable(
  env: Env,
  agentType: string,
  providerMode: string | null
): Promise<boolean> {
  return (
    PROXY_ELIGIBLE_AGENTS.has(agentType) &&
    requiresExplicitSamProvider(agentType) &&
    providerMode === 'sam' &&
    // The same resolver the agent-key route reads (`ai-proxy-availability.ts`): on Cloudflare it
    // is the AI_PROXY_ENABLED kill switch alone; without an AI Gateway it also needs the admin's
    // direct-upstream opt-in.
    (await isAiProxyEnabled(env))
  );
}
