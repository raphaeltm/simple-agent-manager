/**
 * Whether the SAM AI proxy (`/ai/v1`, `/ai/anthropic/v1`, `/ai/proxy/:wstoken`) and the agent-key
 * paths that hand workspaces a proxy config are on. One resolver for every reader (rule 24): the
 * proxy routes, agent-key, the agents catalog and the platform OpenCode check.
 *
 * - `AI_PROXY_ENABLED="false"` is the operator kill switch and always wins.
 * - With an addressable AI Gateway (every Cloudflare deployment) the proxy is on, exactly as before,
 *   and no setting is read.
 * - Without one (a self-hosted box) proxied calls go straight to the provider and SAM's own
 *   metering is the only spend record, so the proxy is off until an admin turns on
 *   `aiProxy.directUpstreamEnabled`. That is an explicit admin decision, never a silent default.
 *   A settings read that fails resolves to the setting's default (off): `resolveAdminSetting`.
 */
import type { Env } from '../env';
import { resolveAdminSetting } from './admin-settings-resolution';
import { AI_PROXY_DIRECT_UPSTREAM_SETTING } from './ai-proxy-settings';
import { resolveAiGatewayId } from './platform-capabilities';

export type AiProxyAvailability =
  | { enabled: true }
  | { enabled: false; reason: 'kill-switch' | 'direct-upstream-not-enabled' };

export async function resolveAiProxyAvailability(env: Env): Promise<AiProxyAvailability> {
  if (env.AI_PROXY_ENABLED === 'false') return { enabled: false, reason: 'kill-switch' };
  if (resolveAiGatewayId(env) !== null) return { enabled: true };
  const enabled = (await resolveAdminSetting(env, AI_PROXY_DIRECT_UPSTREAM_SETTING)) === true;
  return enabled ? { enabled: true } : { enabled: false, reason: 'direct-upstream-not-enabled' };
}

export async function isAiProxyEnabled(env: Env): Promise<boolean> {
  return (await resolveAiProxyAvailability(env)).enabled;
}

/** The 503 message for a disabled proxy; names the admin setting when that is the reason. */
export function aiProxyDisabledMessage(availability: AiProxyAvailability): string {
  if (availability.enabled || availability.reason === 'kill-switch') return 'AI proxy is disabled';
  return `AI proxy is disabled: this installation has no AI Gateway, so an admin must turn on ${AI_PROXY_DIRECT_UPSTREAM_SETTING} in Admin settings (AI models).`;
}
